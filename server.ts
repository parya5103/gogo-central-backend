/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * GoGo Central Backend — Production Express + TypeScript Server (Security Audited)
 * Serves versioned /api/v1 REST endpoints and Vite SPA frontend on Port 3000.
 */

import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import { createServer as createViteServer } from 'vite';
import { adminAuth, ROOT_ADMIN_EMAIL, FIREBASE_PROJECT_ID } from './src/lib/firebase-admin.ts';
import { backendStore } from './src/server/store.ts';
import {
  resolvePostgresConfig,
  verifyPostgresMigrationFile,
  generateTransactionalSqlBackup,
  PostgresProviderType,
} from './src/db/postgres-config.ts';

const PORT = Number(process.env.PORT) || 3000;
const startTime = Date.now();

export interface AuthenticatedRequest extends Request {
  user?: {
    uid: string;
    email: string;
    emailVerified: boolean;
    role: 'user' | 'admin';
    authMode: 'firebase-id-token' | 'verified-sandbox-session';
  };
}

// Strict GoGo Ecosystem CORS Allowlist.
// Base allowlist covers the apex + www GoGo domain and local development.
// CORS_ALLOWED_ORIGINS (comma-separated HTTPS origins) extends the allowlist at
// runtime so new origins are added via environment configuration, not code.
const ALLOWED_GOGO_ORIGINS = new Set<string>([
  'https://gogocompany.in',
  'https://www.gogocompany.in',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
]);
for (const extraOrigin of (process.env.CORS_ALLOWED_ORIGINS || '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean)) {
  ALLOWED_GOGO_ORIGINS.add(extraOrigin);
}

/**
 * Extracts the true client IP behind Google Cloud Run / Reverse Proxy without trusting
 * client-spoofed left-most X-Forwarded-For entries.
 *
 * Cloud Run's Google Front End (GFE) appends the connecting client IP to the right side of
 * `X-Forwarded-For` and `Forwarded`. With `app.set('trust proxy', 1)`, Express sets `req.ip`
 * from the last proxy hop (ignoring client-prepended values). We also inspect the last
 * `for=` parameter in the standardized `Forwarded` header when `req.ip` is unavailable,
 * and normalize IPv6 ranges via `ipKeyGenerator`.
 */
export function extractTrustedClientIp(req: Request): string {
  // 1. Prefer Express's trusted hop computation (`trust proxy = 1` reads right-most hop)
  if (req.ip) {
    return ipKeyGenerator(req.ip);
  }

  // 2. Fallback to right-most RFC 7239 Forwarded `for=` entry
  const forwardedHeader = req.headers['forwarded'];
  if (typeof forwardedHeader === 'string' && forwardedHeader.length > 0) {
    const entries = forwardedHeader.split(',');
    const lastEntry = entries[entries.length - 1] || '';
    const match = lastEntry.match(/for="?\[?([a-fA-F0-9:.]+)\]?"?/i);
    if (match && match[1]) {
      return ipKeyGenerator(match[1]);
    }
  }

  // 3. Fallback to direct socket address
  return ipKeyGenerator(req.socket?.remoteAddress || '127.0.0.1');
}

function isProductionMode(req: Request): boolean {
  return (
    process.env.NODE_ENV === 'production' ||
    req.headers['x-gogo-enforce-prod'] === 'true'
  );
}

/**
 * Server-Side Authentication Middleware
 * Verifies Firebase ID Token via Firebase Admin SDK (`adminAuth.verifyIdToken(token, true)`).
 * Enforces `checkRevoked = true` and blocks sandbox headers in production mode.
 */
async function requireAuth(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;

  if (authHeader && authHeader.startsWith('Bearer ')) {
    const idToken = authHeader.slice('Bearer '.length).trim();
    if (!idToken || idToken.length > 4096) {
      return res.status(401).json({
        error: 'Unauthorized: Malformed Bearer token.',
        code: 'AUTH_MALFORMED_TOKEN',
      });
    }

    try {
      // checkRevoked = true ensures revoked refresh sessions are immediately rejected
      const decoded = await adminAuth.verifyIdToken(idToken, true);
      const email = decoded.email || '';
      const isAdmin =
        (email === ROOT_ADMIN_EMAIL && decoded.email_verified === true) ||
        backendStore.admins.has(decoded.uid);

      req.user = {
        uid: decoded.uid,
        email,
        emailVerified: Boolean(decoded.email_verified),
        role: isAdmin ? 'admin' : 'user',
        authMode: 'firebase-id-token',
      };

      if (!backendStore.users.has(decoded.uid)) {
        const now = new Date().toISOString();
        backendStore.users.set(decoded.uid, {
          uid: decoded.uid,
          displayName: decoded.name || email.split('@')[0] || 'GoGo User',
          emailMasked: email
            ? `${email.slice(0, 2)}***@${email.split('@')[1] || 'gogo.in'}`
            : 'verified@gogo.in',
          role: isAdmin ? 'admin' : 'user',
          emailVerified: Boolean(decoded.email_verified),
          connectedApps: ['gogocompany-in'],
          authProvider: 'google.com',
          firestoreGameSavePreserved: true,
          createdAt: now,
          updatedAt: now,
        });
      }

      return next();
    } catch (error: unknown) {
      const errCode =
        error && typeof error === 'object' && 'code' in error
          ? String((error as { code?: string }).code)
          : 'auth/invalid-id-token';

      backendStore.recordSecurityEvent(
        'UNVERIFIED_TOKEN_BLOCKED',
        String(req.headers['x-gogo-app-id'] || 'central-control'),
        `${req.method} ${req.originalUrl}`,
        'high',
        `Rejected Firebase Bearer token (${errCode}) via adminAuth.verifyIdToken(token, true).`,
        extractTrustedClientIp(req)
      );
      return res.status(401).json({
        error:
          errCode === 'auth/id-token-revoked'
            ? 'Unauthorized: Firebase session has been revoked.'
            : 'Unauthorized: Invalid or expired Firebase ID token.',
        code: errCode === 'auth/id-token-revoked' ? 'AUTH_TOKEN_REVOKED' : 'AUTH_INVALID_ID_TOKEN',
      });
    }
  }

  // Sandbox Role Header: forbidden in production and by default everywhere.
  // Opt-in only for local testing via GOGO_ENABLE_SANDBOX_AUTH=true.
  const sandboxRole = req.headers['x-gogo-sandbox-role'];
  if (sandboxRole) {
    if (isProductionMode(req)) {
      backendStore.recordSecurityEvent(
        'RBAC_VIOLATION',
        String(req.headers['x-gogo-app-id'] || 'central-control'),
        `${req.method} ${req.originalUrl}`,
        'critical',
        'Blocked attempt to use X-GoGo-Sandbox-Role header in production mode.',
        extractTrustedClientIp(req)
      );
      return res.status(401).json({
        error: 'Unauthorized: Sandbox authentication headers are disabled in production.',
        code: 'AUTH_SANDBOX_DISABLED_IN_PROD',
      });
    }

    if (process.env.GOGO_ENABLE_SANDBOX_AUTH !== 'true') {
      backendStore.recordSecurityEvent(
        'UNVERIFIED_TOKEN_BLOCKED',
        String(req.headers['x-gogo-app-id'] || 'central-control'),
        `${req.method} ${req.originalUrl}`,
        'high',
        'Blocked X-GoGo-Sandbox-Role header: GOGO_ENABLE_SANDBOX_AUTH is not enabled.',
        extractTrustedClientIp(req)
      );
      return res.status(401).json({
        error: 'Unauthorized: Sandbox authentication headers are disabled.',
        code: 'AUTH_SANDBOX_DISABLED',
      });
    }

    if (sandboxRole === 'admin' || sandboxRole === 'user') {
      const isSandboxAdmin = sandboxRole === 'admin';
      req.user = {
        uid: isSandboxAdmin ? 'uid_admin_root' : 'uid_sarkari_aspirant_01',
        email: isSandboxAdmin ? ROOT_ADMIN_EMAIL : 'rohan@example.com',
        emailVerified: true,
        role: isSandboxAdmin ? 'admin' : 'user',
        authMode: 'verified-sandbox-session',
      };
      return next();
    }
  }

  backendStore.recordSecurityEvent(
    'UNVERIFIED_TOKEN_BLOCKED',
    String(req.headers['x-gogo-app-id'] || 'central-control'),
    `${req.method} ${req.originalUrl}`,
    'medium',
    'Blocked request missing Authorization Bearer header.',
    extractTrustedClientIp(req)
  );
  return res.status(401).json({
    error: 'Unauthorized: Missing Authorization Bearer Firebase ID Token.',
    code: 'AUTH_MISSING_TOKEN',
  });
}

/**
 * Server-Side Admin Role Authorization Middleware
 */
function requireAdmin(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  if (!req.user || req.user.role !== 'admin') {
    backendStore.recordSecurityEvent(
      'RBAC_VIOLATION',
      String(req.headers['x-gogo-app-id'] || 'central-control'),
      `${req.method} ${req.originalUrl}`,
      'high',
      `Blocked non-admin UID (${req.user?.uid || 'anonymous'}) from invoking admin endpoint.`,
      extractTrustedClientIp(req)
    );
    return res.status(403).json({
      error: 'Forbidden: Server-side admin role verification failed.',
      code: 'RBAC_ADMIN_REQUIRED',
    });
  }
  return next();
}

// Zod Input Validation Schemas
const RegisterAppSchema = z
  .object({
    appId: z.string().min(2).max(64).regex(/^[a-z0-9-]+$/),
    name: z.string().min(2).max(80),
    domain: z.string().url().max(160),
    category: z.enum(['portal', 'civic', 'news', 'game']),
    fcmEnabled: z.boolean().default(true),
    webPushEnabled: z.boolean().default(true),
    androidEnabled: z.boolean().default(true),
    rateLimitPerMin: z.number().int().min(10).max(10000).default(150),
  })
  .strict();

const UpdateAppSchema = z
  .object({
    fcmEnabled: z.boolean().optional(),
    webPushEnabled: z.boolean().optional(),
    androidEnabled: z.boolean().optional(),
    rateLimitPerMin: z.number().int().min(10).max(10000).optional(),
  })
  .strict();

const RegisterDeviceSchema = z
  .object({
    appId: z.string().min(2).max(64).regex(/^[a-z0-9-]+$/),
    fcmToken: z.string().min(16).max(512).regex(/^[a-zA-Z0-9_:.-]+$/),
    platform: z.enum(['web', 'android']),
    userAgent: z.string().min(2).max(256),
  })
  .strict();

const UpdatePreferenceSchema = z
  .object({
    enabled: z.boolean(),
    webPush: z.boolean(),
    androidPush: z.boolean(),
    marketingAlerts: z.boolean(),
    transactionalAlerts: z.boolean(),
    quietHoursStart: z.string().regex(/^\d{2}:\d{2}$/),
    quietHoursEnd: z.string().regex(/^\d{2}:\d{2}$/),
  })
  .strict();

const SendNotificationSchema = z
  .object({
    idempotencyKey: z.string().min(6).max(128).regex(/^[a-zA-Z0-9_-]+$/),
    appId: z.string().min(2).max(64).regex(/^[a-z0-9-]+$/),
    targetType: z.enum([
      'individual',
      'group',
      'product',
      'ecosystem',
      'broadcast',
      'targeted',
      'topic',
    ]),
    targetValue: z.string().min(1).max(128),
    platform: z.enum(['all', 'web', 'android']).default('all'),
    title: z.string().min(2).max(120),
    body: z.string().min(2).max(500),
    deepLink: z.string().url().max(256),
    scheduledFor: z.string().nullable().optional(),
  })
  .strict();

export async function createGoGoApp() {
  const app = express();

  // Trust exactly 1 reverse proxy hop (Google Cloud Run GFE load balancer).
  // This ensures req.ip is computed from the right-most proxy hop and prevents
  // clients from spoofing left-most X-Forwarded-For entries.
  app.set('trust proxy', 1);

  // 1. Security Headers via Helmet
  app.use(
    helmet({
      contentSecurityPolicy: false,
      crossOriginEmbedderPolicy: false,
      referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    })
  );

  // 2. Strict CORS Policy for GoGo Domains + Cloud Run Preview
  app.use(
    cors({
      origin: (origin, req, callback) => {
        if (!origin) {
          return callback(null, true);
        }
        try {
          const parsedOrigin = new URL(origin);
          const isAllowedPreview =
            process.env.NODE_ENV !== 'production' && parsedOrigin.hostname.endsWith('.run.app');
          const isAllowedGoGoSubdomain =
            parsedOrigin.protocol === 'https:' &&
            parsedOrigin.hostname.endsWith('.gogocompany.in');

          if (
            ALLOWED_GOGO_ORIGINS.has(origin) ||
            isAllowedGoGoSubdomain ||
            isAllowedPreview
          ) {
            return callback(null, true);
          }
        } catch {
          // Invalid origin URL falls through to rejection
        }

        backendStore.recordSecurityEvent(
          'CORS_ORIGIN_REJECTED',
          'central-control',
          'CORS Preflight',
          'medium',
          `Blocked unauthorized cross-origin request from ${origin}`,
          extractTrustedClientIp(req)
        );
        return callback(new Error('Not allowed by GoGo Central Backend CORS policy'));
      },
      credentials: true,
    })
  );

  app.use(express.json({ limit: '50kb' }));

  // 3. Hardened Rate Limiters with Custom Anti-Spoofing KeyGenerator & Active Validations
  const standardApiLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 180,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req: Request) => extractTrustedClientIp(req),
    validate: {
      default: true,
    },
    handler: (req: Request, res: Response) => {
      backendStore.recordSecurityEvent(
        'RATE_LIMIT_EXCEEDED',
        String(req.headers['x-gogo-app-id'] || 'central-control'),
        `${req.method} ${req.originalUrl}`,
        'medium',
        'Rate limit exceeded on standard API route (180 req/min).',
        extractTrustedClientIp(req)
      );
      res.status(429).json({
        error: 'Too many requests. Please try again in 60 seconds.',
        code: 'RATE_LIMIT_EXCEEDED',
      });
    },
  });

  const sensitiveMutationLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req: Request) => extractTrustedClientIp(req),
    validate: {
      default: true,
    },
    handler: (req: Request, res: Response) => {
      backendStore.recordSecurityEvent(
        'RATE_LIMIT_EXCEEDED',
        String(req.headers['x-gogo-app-id'] || 'central-control'),
        `${req.method} ${req.originalUrl}`,
        'high',
        'Rate limit exceeded on sensitive mutation route (30 req/min).',
        extractTrustedClientIp(req)
      );
      res.status(429).json({
        error: 'Rate limit exceeded for sensitive operation. Please wait 60 seconds.',
        code: 'SENSITIVE_RATE_LIMIT_EXCEEDED',
      });
    },
  });

  app.use('/api/', standardApiLimiter);

  // ============================================================================
  // Versioned REST API Routes (/api/v1)
  // ============================================================================

  // Public Liveness Health Check (Zero internal project IDs, versions, or metrics exposed)
  app.get('/api/v1/health', (_req: Request, res: Response) => {
    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
    });
  });

  // Protected Admin-Only Detailed Diagnostics Health Check
  app.get(
    '/api/v1/health/detailed',
    requireAuth,
    requireAdmin,
    (_req: AuthenticatedRequest, res: Response) => {
      res.json({
        status: 'healthy',
        service: 'gogo-central-backend',
        uptimeSeconds: Math.floor((Date.now() - startTime) / 1000),
        firebaseProjectId: FIREBASE_PROJECT_ID,
        metrics: {
          registeredApps: backendStore.products.size,
          totalUsers: backendStore.users.size,
          activeDeviceTokens: Array.from(backendStore.devices.values()).filter(
            (d) => d.status === 'active'
          ).length,
          totalCampaigns: backendStore.campaigns.size,
        },
      });
    }
  );

  // Complete Overview Snapshot (Scoped by RBAC role)
  app.get('/api/v1/overview', requireAuth, (req: AuthenticatedRequest, res: Response) => {
    const isAdmin = req.user?.role === 'admin';
    const uid = req.user?.uid || '';

    const products = Array.from(backendStore.products.values());
    const devices = Array.from(backendStore.devices.values()).filter(
      (d) => isAdmin || d.userId === uid
    );
    const preferences = Array.from(backendStore.preferences.values()).filter(
      (p) => isAdmin || p.userId === uid
    );
    const campaigns = isAdmin
      ? Array.from(backendStore.campaigns.values())
      : Array.from(backendStore.campaigns.values()).filter(
          (c) =>
            c.targetType === 'product' ||
            c.targetType === 'ecosystem' ||
            c.targetValue === uid
        );
    const deliveries = isAdmin
      ? Array.from(backendStore.deliveries.values()).slice(0, 50)
      : Array.from(backendStore.deliveries.values())
          .filter((d) => d.userId === uid)
          .slice(0, 25);

    res.json({
      currentUser: req.user,
      products,
      users: isAdmin ? Array.from(backendStore.users.values()) : [],
      devices,
      preferences,
      campaigns,
      deliveries,
      auditLogs: isAdmin ? backendStore.auditLogs.slice(0, 50) : [],
      securityEvents: isAdmin ? backendStore.securityEvents.slice(0, 50) : [],
      systemConfigs: isAdmin ? Array.from(backendStore.systemConfigs.values()) : [],
    });
  });

  // Verify Firebase ID Token & Sync User Profile
  app.post(
    '/api/v1/auth/verify',
    sensitiveMutationLimiter,
    requireAuth,
    (req: AuthenticatedRequest, res: Response) => {
      res.json({
        verified: true,
        user: req.user,
        timestamp: new Date().toISOString(),
      });
    }
  );

  // List Registered GoGo Applications
  app.get('/api/v1/apps', requireAuth, (_req: AuthenticatedRequest, res: Response) => {
    res.json({
      apps: Array.from(backendStore.products.values()),
    });
  });

  // Dynamically Register a New GoGo Product (Admin Only)
  app.post(
    '/api/v1/apps',
    sensitiveMutationLimiter,
    requireAuth,
    requireAdmin,
    (req: AuthenticatedRequest, res: Response) => {
      const parsed = RegisterAppSchema.safeParse(req.body);
      if (!parsed.success) {
        return res
          .status(400)
          .json({ error: 'Invalid application payload', details: parsed.error.issues });
      }
      const data = parsed.data;
      if (backendStore.products.has(data.appId)) {
        return res
          .status(409)
          .json({ error: `Application '${data.appId}' is already registered.` });
      }

      const now = new Date().toISOString();
      const newApp = {
        appId: data.appId,
        name: backendStore.sanitizeText(data.name),
        domain: data.domain,
        category: data.category,
        fcmEnabled: data.fcmEnabled,
        webPushEnabled: data.webPushEnabled,
        androidEnabled: data.androidEnabled,
        rateLimitPerMin: data.rateLimitPerMin,
        activeUsersCount: 1,
        registeredDevicesCount: 0,
        createdAt: now,
        updatedAt: now,
      };

      backendStore.products.set(newApp.appId, newApp);
      backendStore.recordAuditLog(
        req.user!.uid,
        newApp.appId,
        'APP_REGISTERED',
        newApp.appId,
        'info',
        `Dynamically onboarded new GoGo product "${newApp.name}" (${newApp.domain}).`
      );

      return res.status(201).json({ app: newApp });
    }
  );

  // Update Application Configuration (Admin Only)
  app.patch(
    '/api/v1/apps/:appId',
    sensitiveMutationLimiter,
    requireAuth,
    requireAdmin,
    (req: AuthenticatedRequest, res: Response) => {
      const appId = String(req.params.appId);
      const existing = backendStore.products.get(appId);
      if (!existing) {
        return res.status(404).json({ error: `GoGo application '${appId}' not found.` });
      }

      const parsed = UpdateAppSchema.safeParse(req.body);
      if (!parsed.success) {
        return res
          .status(400)
          .json({ error: 'Invalid configuration update', details: parsed.error.issues });
      }

      const updates = parsed.data;
      if (typeof updates.fcmEnabled === 'boolean') existing.fcmEnabled = updates.fcmEnabled;
      if (typeof updates.webPushEnabled === 'boolean')
        existing.webPushEnabled = updates.webPushEnabled;
      if (typeof updates.androidEnabled === 'boolean')
        existing.androidEnabled = updates.androidEnabled;
      if (typeof updates.rateLimitPerMin === 'number')
        existing.rateLimitPerMin = updates.rateLimitPerMin;
      existing.updatedAt = new Date().toISOString();

      backendStore.recordAuditLog(
        req.user!.uid,
        appId,
        'APP_CONFIG_UPDATE',
        appId,
        'warn',
        `Updated ${appId} settings: FCM=${existing.fcmEnabled}, WebPush=${existing.webPushEnabled}, Android=${existing.androidEnabled}, RateLimit=${existing.rateLimitPerMin}/min.`
      );

      return res.json({ app: existing });
    }
  );

  // List User's Own Devices (or All Devices for Admin)
  app.get('/api/v1/devices', requireAuth, (req: AuthenticatedRequest, res: Response) => {
    const isAdmin = req.user!.role === 'admin';
    const uid = req.user!.uid;
    const devices = Array.from(backendStore.devices.values()).filter(
      (d) => isAdmin || d.userId === uid
    );
    return res.json({ devices });
  });

  // Register or Refresh Device FCM Token
  app.post(
    '/api/v1/devices/register',
    sensitiveMutationLimiter,
    requireAuth,
    (req: AuthenticatedRequest, res: Response) => {
      const parsed = RegisterDeviceSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({
          error: 'Invalid device token registration payload',
          details: parsed.error.issues,
        });
      }

      const { appId, fcmToken, platform, userAgent } = parsed.data;
      if (!backendStore.products.has(appId)) {
        return res.status(404).json({ error: `Target GoGo product '${appId}' does not exist.` });
      }

      const now = new Date().toISOString();
      const deviceId = `dev_${appId}_${platform}_${Date.now().toString(36)}`;
      const record = {
        deviceId,
        userId: req.user!.uid, // Strictly bound to verified token UID
        appId,
        fcmToken: backendStore.sanitizeText(fcmToken),
        platform,
        userAgent: backendStore.sanitizeText(userAgent),
        status: 'active' as const,
        lastRefreshedAt: now,
        createdAt: now,
        updatedAt: now,
      };

      backendStore.devices.set(deviceId, record);
      const product = backendStore.products.get(appId);
      if (product) {
        product.registeredDevicesCount += 1;
      }

      backendStore.recordAuditLog(
        req.user!.uid,
        appId,
        'DEVICE_TOKEN_REGISTER',
        deviceId,
        'info',
        `Registered ${platform.toUpperCase()} FCM token for ${appId}.`
      );

      return res.status(201).json({ device: record });
    }
  );

  // Revoke or Remove Device FCM Token (Strict Owner or Admin Isolation)
  app.delete(
    '/api/v1/devices/:deviceId',
    sensitiveMutationLimiter,
    requireAuth,
    (req: AuthenticatedRequest, res: Response) => {
      const deviceId = String(req.params.deviceId);
      const device = backendStore.devices.get(deviceId);
      if (!device) {
        return res.status(404).json({ error: 'Device token registration not found.' });
      }

      if (device.userId !== req.user!.uid && req.user!.role !== 'admin') {
        backendStore.recordSecurityEvent(
          'RBAC_VIOLATION',
          device.appId,
          `DELETE /api/v1/devices/${deviceId}`,
          'high',
          `Blocked user ${req.user!.uid} from revoking device token belonging to ${device.userId}.`,
          extractTrustedClientIp(req)
        );
        return res
          .status(403)
          .json({ error: 'Forbidden: Cannot revoke another user device token.' });
      }

      device.status = 'revoked';
      device.updatedAt = new Date().toISOString();

      backendStore.recordAuditLog(
        req.user!.uid,
        device.appId,
        'DEVICE_TOKEN_REVOKE',
        deviceId,
        'warn',
        `Revoked ${device.platform} FCM token ${deviceId} on ${device.appId}.`
      );

      return res.json({ device });
    }
  );

  // Get Authenticated User's Notification Preferences
  app.get('/api/v1/preferences', requireAuth, (req: AuthenticatedRequest, res: Response) => {
    const uid = req.user!.uid;
    const prefs = Array.from(backendStore.preferences.values()).filter((p) => p.userId === uid);
    return res.json({ preferences: prefs });
  });

  // Update Per-User, Per-Product Notification Preferences
  app.put(
    '/api/v1/preferences/:appId',
    sensitiveMutationLimiter,
    requireAuth,
    (req: AuthenticatedRequest, res: Response) => {
      const appId = String(req.params.appId);
      if (!backendStore.products.has(appId)) {
        return res.status(404).json({ error: `Unknown GoGo product '${appId}'.` });
      }

      const parsed = UpdatePreferenceSchema.safeParse(req.body);
      if (!parsed.success) {
        return res
          .status(400)
          .json({ error: 'Invalid preference payload', details: parsed.error.issues });
      }

      const uid = req.user!.uid;
      const prefId = `${uid}_${appId}`;
      const now = new Date().toISOString();
      const existing = backendStore.preferences.get(prefId);

      const record = {
        prefId,
        userId: uid,
        appId,
        ...parsed.data,
        createdAt: existing?.createdAt || now,
        updatedAt: now,
      };

      backendStore.preferences.set(prefId, record);
      backendStore.recordAuditLog(
        uid,
        appId,
        'PREFERENCE_UPDATE',
        prefId,
        'info',
        `Updated notification preferences for ${appId} (enabled=${record.enabled}, web=${record.webPush}, android=${record.androidPush}).`
      );

      return res.json({ preference: record });
    }
  );

  // Dispatch or Schedule Central FCM Notification (Admin Only)
  app.post(
    '/api/v1/notifications/send',
    sensitiveMutationLimiter,
    requireAuth,
    requireAdmin,
    async (req: AuthenticatedRequest, res: Response) => {
      const parsed = SendNotificationSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({
          error: 'Invalid notification campaign payload',
          details: parsed.error.issues,
        });
      }

      const data = parsed.data;
      if (data.appId !== 'all-gogo' && !backendStore.products.has(data.appId)) {
        return res
          .status(404)
          .json({ error: `Target GoGo application '${data.appId}' is not registered.` });
      }

      try {
        const result = await backendStore.dispatchNotification({
          ...data,
          scheduledFor: data.scheduledFor ?? null,
          authorId: req.user!.uid,
        });
        return res.status(result.duplicatePrevented ? 200 : 201).json(result);
      } catch (error) {
        const msg = error instanceof Error ? error.message : 'Notification dispatch failed';
        const status = msg.startsWith('UNTRUSTED_DEEPLINK_DOMAIN')
          ? 400
          : msg.startsWith('CONCURRENT_IDEMPOTENCY_LOCK')
          ? 409
          : 422;
        return res.status(status).json({ error: msg });
      }
    }
  );

  // Retry Failed Notification Deliveries (Admin Only, Bounded by fcm_max_retries)
  app.post(
    '/api/v1/notifications/:notificationId/retry',
    sensitiveMutationLimiter,
    requireAuth,
    requireAdmin,
    async (req: AuthenticatedRequest, res: Response) => {
      const notificationId = String(req.params.notificationId);
      const outcome = await backendStore.retryFailedCampaign(notificationId, req.user!.uid);
      if (!outcome.campaign) {
        return res.status(404).json({ error: 'Notification campaign not found.' });
      }
      if (outcome.error) {
        return res.status(409).json({ error: outcome.error, campaign: outcome.campaign });
      }
      return res.json({ campaign: outcome.campaign });
    }
  );

  // Read Audit Logs (Admin Only, Bounded)
  app.get(
    '/api/v1/audit-logs',
    standardApiLimiter,
    requireAuth,
    requireAdmin,
    (req: AuthenticatedRequest, res: Response) => {
      const limit = Math.min(Math.max(parseInt(String(req.query.limit || '50'), 10) || 50, 1), 200);
      const logs = backendStore.auditLogs.slice(0, limit);
      return res.json({ auditLogs: logs, count: logs.length, total: backendStore.auditLogs.length });
    }
  );

  // Read Security Events (Admin Only, Bounded)
  app.get(
    '/api/v1/security-events',
    standardApiLimiter,
    requireAuth,
    requireAdmin,
    (req: AuthenticatedRequest, res: Response) => {
      const limit = Math.min(Math.max(parseInt(String(req.query.limit || '50'), 10) || 50, 1), 200);
      const events = backendStore.securityEvents.slice(0, limit);
      return res.json({ securityEvents: events, count: events.length, total: backendStore.securityEvents.length });
    }
  );

  // Read System Configuration (Admin Only)
  app.get(
    '/api/v1/system-config',
    standardApiLimiter,
    requireAuth,
    requireAdmin,
    (req: AuthenticatedRequest, res: Response) => {
      const configs = Array.from(backendStore.systemConfigs.values());
      return res.json({ systemConfigs: configs, count: configs.length });
    }
  );

  // Update System Configuration (Admin Only)
  app.put(
    '/api/v1/system-config/:configKey',
    sensitiveMutationLimiter,
    requireAuth,
    requireAdmin,
    (req: AuthenticatedRequest, res: Response) => {
      const configKey = String(req.params.configKey);
      const existing = backendStore.systemConfigs.get(configKey);
      if (!existing) {
        return res.status(404).json({ error: `System config '${configKey}' not found.` });
      }

      const configValue = String(req.body.configValue ?? '').trim();
      if (!configValue || configValue.length > 256) {
        return res.status(400).json({ error: 'Invalid configValue.' });
      }

      existing.configValue = backendStore.sanitizeText(configValue);
      existing.updatedBy = req.user!.uid;
      existing.updatedAt = new Date().toISOString();

      backendStore.recordAuditLog(
        req.user!.uid,
        'central-control',
        'SYSTEM_CONFIG_UPDATE',
        configKey,
        'warn',
        `Updated system config ${configKey}=${existing.configValue}`
      );

      return res.json({ config: existing });
    }
  );

  // Execute Automated Security & Regression Suite (Disabled in Production Mode; Admin Only in Dev)
  app.post(
    '/api/v1/tests/run',
    sensitiveMutationLimiter,
    requireAuth,
    requireAdmin,
    async (req: AuthenticatedRequest, res: Response) => {
      if (isProductionMode(req) && process.env.ALLOW_PROD_SELF_TEST !== 'true') {
        backendStore.recordSecurityEvent(
          'RBAC_VIOLATION',
          'central-control',
          'POST /api/v1/tests/run',
          'high',
          'Blocked invocation of diagnostic self-test runner in production mode.',
          extractTrustedClientIp(req)
        );
        return res.status(403).json({
          error: 'Diagnostic test runner is disabled in production.',
          code: 'TEST_ENDPOINT_DISABLED_IN_PRODUCTION',
        });
      }

      try {
        const report = await backendStore.runAutomatedTestSuite();
        return res.json(report);
      } catch (error) {
        return res.status(500).json({
          error: error instanceof Error ? error.message : 'Test suite execution failed',
        });
      }
    }
  );

  // Provider-Independent PostgreSQL Configuration & Schema Verification (Admin Only)
  app.get(
    '/api/v1/db/config',
    requireAuth,
    requireAdmin,
    (req: AuthenticatedRequest, res: Response) => {
      const requestedProvider = req.query.provider as PostgresProviderType | undefined;
      const pgConfig = resolvePostgresConfig(requestedProvider);
      const schemaVerification = verifyPostgresMigrationFile();
      return res.json({
        pgConfig,
        schemaVerification,
      });
    }
  );

  // Generate & Export Transactional PostgreSQL 18 SQL Backup Dump (Admin Only)
  app.post(
    '/api/v1/db/backup',
    sensitiveMutationLimiter,
    requireAuth,
    requireAdmin,
    (req: AuthenticatedRequest, res: Response) => {
      const backupDir = path.resolve(process.cwd(), 'backups');
      fs.mkdirSync(backupDir, { recursive: true });
      const sqlDump = generateTransactionalSqlBackup(backendStore);
      const outPath = path.join(backupDir, 'gogo_central_latest.sql');
      fs.writeFileSync(outPath, sqlDump, 'utf-8');

      backendStore.recordAuditLog(
        req.user!.uid,
        'central-control',
        'DATABASE_SQL_BACKUP',
        'backups/gogo_central_latest.sql',
        'info',
        `Generated transactional PostgreSQL 18 SQL dump (${Buffer.byteLength(sqlDump, 'utf-8')} bytes).`
      );

      return res.json({
        status: 'SUCCESS',
        file: 'backups/gogo_central_latest.sql',
        bytes: Buffer.byteLength(sqlDump, 'utf-8'),
        sqlDump,
      });
    }
  );

  // Read Project Documentation & Architecture Blueprints (Admin Only)
  app.get(
    '/api/v1/docs/:docId',
    requireAuth,
    requireAdmin,
    (req: AuthenticatedRequest, res: Response) => {
      const allowedFiles: Record<string, string> = {
        'KNOWLEDGE.md': 'KNOWLEDGE.md',
        'ARCHITECTURE.md': 'ARCHITECTURE.md',
        'SECURITY.md': 'SECURITY.md',
        'COSTS.md': 'COSTS.md',
        'API.md': 'API.md',
        'CHANGELOG.md': 'CHANGELOG.md',
        'README.md': 'README.md',
        Dockerfile: 'Dockerfile',
        'docker-compose.yml': 'docker-compose.yml',
        '001_initial_schema.sql': 'migrations/001_initial_schema.sql',
        'postgres-config.ts': 'src/db/postgres-config.ts',
        'backup-restore.sh': 'scripts/backup-restore.sh',
        'gogo_central_latest.sql': 'backups/gogo_central_latest.sql',
        'firestore.rules': 'firestore.rules',
        'security_spec.md': 'security_spec.md',
      };

      const docId = String(req.params.docId);
      const relativePath = allowedFiles[docId];
      if (!relativePath) {
        return res.status(404).json({ error: 'Requested documentation file is not in allowlist.' });
      }

      try {
        const fullPath = path.resolve(process.cwd(), relativePath);
        const content = fs.readFileSync(fullPath, 'utf-8');
        return res.json({ docId, path: relativePath, content });
      } catch {
        return res.status(404).json({ error: `File ${relativePath} could not be read.` });
      }
    }
  );

  return app;
}

async function startServer() {
  const app = await createGoGoApp();

  // Serve Frontend via Vite Middleware in Development or Static Dist in Production
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(
      JSON.stringify({
        level: 'INFO',
        service: 'gogo-central-backend',
        message: `GoGo Central Backend listening on http://0.0.0.0:${PORT}`,
        timestamp: new Date().toISOString(),
      })
    );
  });

  // Graceful Shutdown Handler for Cloud Run / Docker SIGTERM & SIGINT
  const shutdown = (signal: string) => {
    console.log(
      JSON.stringify({
        level: 'INFO',
        service: 'gogo-central-backend',
        message: `Received ${signal}. Draining HTTP connections gracefully...`,
        timestamp: new Date().toISOString(),
      })
    );
    backendStore.stopScheduler();
    server.close(() => {
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 5000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

// Start server unless imported strictly for unit/integration testing
if (process.env.GOGO_TEST_IMPORT !== 'true') {
  startServer();
}
