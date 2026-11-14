/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * GoGo Central Backend — Production Express + TypeScript Server (Security Audited)
 * Serves versioned /api/v1 REST endpoints and Vite SPA frontend on Port 3000.
 */

// Load .env.local / .env BEFORE any other module reads process.env. This
// must stay the FIRST import: ESM evaluates imports in statement order and
// the modules below read environment variables at load time. Real
// environment variables (CI, Docker, Cloud Run) always win over both files.
import './src/lib/load-env.ts';
import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import { createServer as createViteServer } from 'vite';
import { verifyFirebaseIdToken, ROOT_ADMIN_EMAIL, FIREBASE_PROJECT_ID, adminRuntimeDiagnostics } from './src/lib/firebase-admin.ts';
import { backendStore } from './src/server/store.ts';
import {
  resolveDataStore,
  type GoGoDataStore,
} from './src/server/data-store.ts';
import { PostgresRateLimitStore } from './src/server/rate-limit-pg.ts';
import { mapFirebaseSignInProvider } from './src/server/auth-provider.ts';
import {
  resolvePostgresConfig,
  verifyPostgresMigrationFile,
  generateTransactionalSqlBackup,
  PostgresProviderType,
} from './src/db/postgres-config.ts';

const PORT = Number(process.env.PORT) || 3000;
const startTime = Date.now();

/**
 * Active persistence store (in-memory test adapter or PostgreSQL runtime).
 * Set by createGoGoApp(); module-level middleware reads it. Exactly one store
 * is active per process, mirroring the previous engine-singleton design.
 */
let activeStore: GoGoDataStore | null = null;

function store(): GoGoDataStore {
  if (!activeStore) {
    throw new Error('STORE_NOT_INITIALIZED: createGoGoApp() must run first.');
  }
  return activeStore;
}

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
      // checkRevoked = true ensures revoked refresh sessions are immediately rejected.
      // Delegates to the real adminAuth.verifyIdToken in production; the
      // GOGO_TEST_IMPORT-guarded seam only substitutes fakes in test runners.
      const decoded = await verifyFirebaseIdToken(idToken, true);
      const email = decoded.email || '';
      // Admin role comes from trusted server-side records only: the verified
      // root-admin email bootstrap or a server-side admin role row. Clients
      // can never assert a role.
      const isAdmin =
        (email === ROOT_ADMIN_EMAIL && decoded.email_verified === true) ||
        (await store().isAdminUid(decoded.uid));

      // Provider is read from the VERIFIED token's own claim
      // (decoded.firebase.sign_in_provider) — never hardcoded, never
      // client-supplied. Unsupported providers are rejected (fail closed).
      const authProvider = mapFirebaseSignInProvider(decoded);
      if (!authProvider) {
        const rawProvider =
          (decoded as { firebase?: { sign_in_provider?: string } }).firebase
            ?.sign_in_provider ?? 'missing';
        await store().recordSecurityEvent(
          'UNVERIFIED_TOKEN_BLOCKED',
          String(req.headers['x-gogo-app-id'] || 'central-control'),
          `${req.method} ${req.originalUrl}`,
          'high',
          `Rejected verified token with unsupported sign-in provider (${rawProvider.slice(0, 32)}).`,
          extractTrustedClientIp(req)
        );
        return res.status(401).json({
          error: 'Unauthorized: Firebase sign-in provider is not supported by GoGo Central.',
          code: 'AUTH_PROVIDER_NOT_SUPPORTED',
        });
      }

      req.user = {
        uid: decoded.uid,
        email,
        emailVerified: Boolean(decoded.email_verified),
        role: isAdmin ? 'admin' : 'user',
        authMode: 'firebase-id-token',
      };

      // Sync the verified Firebase user into the persistent store (uid is the
      // canonical identifier; role is never taken from the client).
      await store().syncUser(decoded.uid, {
        displayName: decoded.name || email.split('@')[0] || 'GoGo User',
        emailMasked: email
          ? `${email.slice(0, 2)}***@${email.split('@')[1] || 'gogo.in'}`
          : 'verified@gogo.in',
        emailVerified: Boolean(decoded.email_verified),
        authProvider,
        role: isAdmin ? 'admin' : 'user',
      });

      return next();
    } catch (error: unknown) {
      const errCode =
        error && typeof error === 'object' && 'code' in error
          ? String((error as { code?: string }).code)
          : 'auth/invalid-id-token';

      await store().recordSecurityEvent(
        'UNVERIFIED_TOKEN_BLOCKED',
        String(req.headers['x-gogo-app-id'] || 'central-control'),
        `${req.method} ${req.originalUrl}`,
        'high',
        `Rejected Firebase Bearer token (${errCode}) via adminAuth.verifyIdToken(token, true).`,
        extractTrustedClientIp(req)
      );
      return res.status(401).json({
        // The raw Firebase error code (e.g. auth/argument-error,
        // app/invalid-credential, auth/id-token-expired) is embedded so a
        // production error screenshot self-diagnoses the exact server-side
        // verification failure without dashboard access to security_events.
        error:
          errCode === 'auth/id-token-revoked'
            ? `Unauthorized: Firebase session has been revoked. [${errCode}]`
            : `Unauthorized: Invalid or expired Firebase ID token. [${errCode}]`,
        code: errCode === 'auth/id-token-revoked' ? 'AUTH_TOKEN_REVOKED' : 'AUTH_INVALID_ID_TOKEN',
      });
    }
  }

  // Sandbox Role Header: forbidden in production and by default everywhere.
  // Opt-in only for local testing via GOGO_ENABLE_SANDBOX_AUTH=true.
  const sandboxRole = req.headers['x-gogo-sandbox-role'];
  if (sandboxRole) {
    if (isProductionMode(req)) {
      await store().recordSecurityEvent(
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
      await store().recordSecurityEvent(
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
      const sandboxUid = isSandboxAdmin ? 'uid_admin_root' : 'uid_sarkari_aspirant_01';
      req.user = {
        uid: sandboxUid,
        email: isSandboxAdmin ? ROOT_ADMIN_EMAIL : 'rohan@example.com',
        emailVerified: true,
        role: isSandboxAdmin ? 'admin' : 'user',
        authMode: 'verified-sandbox-session',
      };
      // Keep the persistent store consistent in sandbox mode (test/demo only,
      // never production). Role stays the server-side sandbox decision.
      try {
        await store().syncUser(sandboxUid, {
          displayName: isSandboxAdmin ? 'GoGo Root Admin' : 'Sarkari Aspirant',
          emailMasked: isSandboxAdmin ? 'aa***@gm***.com' : 'ro***@ex***.com',
          emailVerified: true,
          authProvider: 'google.com',
          role: isSandboxAdmin ? 'admin' : 'user',
        });
      } catch {
        // Sandbox auth must not hard-fail when the optional store write fails.
      }
      return next();
    }
  }

  await store().recordSecurityEvent(
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
async function requireAdmin(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  if (!req.user || req.user.role !== 'admin') {
    await store().recordSecurityEvent(
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

// Upstream origin for the transparent Firebase auth handler proxy (mounted in
// createGoGoApp as step 2b). Override with FIREBASE_AUTH_PROXY_ORIGIN when the
// Firebase project changes.
const FIREBASE_AUTH_PROXY_ORIGIN =
  process.env.FIREBASE_AUTH_PROXY_ORIGIN ||
  'https://gen-lang-client-0566323659.firebaseapp.com';

// Transparently forwards /__/auth/* and /__/firebase/init.json to the
// firebaseapp.com origin so the whole redirect sign-in flow stays same-origin
// (Option 3 in the Firebase redirect-best-practices guide). The forwarding
// must never be a 302 redirect.
async function firebaseAuthProxyHandler(req: Request, res: Response) {
  const upstreamUrl = `${FIREBASE_AUTH_PROXY_ORIGIN}${req.originalUrl}`;
  const method = req.method.toUpperCase();
  const hasBody = method !== 'GET' && method !== 'HEAD';
  try {
    const upstream = await fetch(upstreamUrl, {
      method,
      headers:
        hasBody && typeof req.headers['content-type'] === 'string'
          ? { 'content-type': req.headers['content-type'] }
          : undefined,
      body:
        hasBody && Buffer.isBuffer(req.body) && req.body.length > 0
          ? new Uint8Array(req.body)
          : undefined,
      redirect: 'manual',
    });
    res.status(upstream.status);
    const contentType = upstream.headers.get('content-type');
    if (contentType) res.setHeader('Content-Type', contentType);
    const cacheControl = upstream.headers.get('cache-control');
    if (cacheControl) res.setHeader('Cache-Control', cacheControl);
    const location = upstream.headers.get('location');
    if (location) res.setHeader('Location', location);
    res.end(Buffer.from(await upstream.arrayBuffer()));
  } catch {
    // Fail closed: sign-in helper responses must never be faked.
    res.status(502).json({
      error: 'Firebase auth handler proxy upstream unavailable.',
      code: 'AUTH_PROXY_UPSTREAM_UNAVAILABLE',
    });
  }
}

export async function createGoGoApp() {
  // Resolve persistence BEFORE wiring middleware: the store is process-global
  // for the request handlers. Startup fails loudly here if PostgreSQL is
  // required and unreachable (no silent in-memory fallback).
  activeStore = await resolveDataStore();
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
  // Uses the cors options-delegate form (req is available) so rejected origins
  // are logged as security events with the trusted client IP.
  app.use(
    cors((req, callback) => {
      const origin = req.headers.origin;
      if (!origin) {
        // Same-origin / non-browser tools: no CORS headers needed.
        return callback(null, { origin: false, credentials: true });
      }

      let allowed = false;
      try {
        const parsedOrigin = new URL(origin);
        const isAllowedPreview =
          process.env.NODE_ENV !== 'production' && parsedOrigin.hostname.endsWith('.run.app');
        const isAllowedGoGoSubdomain =
          parsedOrigin.protocol === 'https:' &&
          parsedOrigin.hostname.endsWith('.gogocompany.in');

        allowed =
          ALLOWED_GOGO_ORIGINS.has(origin) || isAllowedGoGoSubdomain || isAllowedPreview;
      } catch {
        // Invalid origin URL falls through to rejection
        allowed = false;
      }

      if (!allowed) {
        store()
          .recordSecurityEvent(
            'CORS_ORIGIN_REJECTED',
            'central-control',
            'CORS Preflight',
            'medium',
            `Blocked unauthorized cross-origin request from ${origin}`,
            extractTrustedClientIp(req as unknown as Request)
          )
          .catch(() => {
            // Telemetry failures must not break CORS rejection.
          });
      }
      return callback(null, { origin: allowed, credentials: true });
    })
  );

  // 2b. Firebase Auth Same-Origin Handler Proxy (storage-partitioning fix).
  // Chrome M115+ / Safari 16.1+ / Firefox 109+ partition third-party storage,
  // so the cross-origin iframe relay to <project>.firebaseapp.com loses the
  // signInWithRedirect state ("missing initial state"). The dashboard client
  // overrides authDomain to this app's own hostname (src/lib/firebase.ts);
  // this proxy transparently serves the auth helper files from this origin.
  app.all('/__/auth/*', express.raw({ type: '*/*', limit: '64kb' }), firebaseAuthProxyHandler);
  app.get('/__/firebase/init.json', firebaseAuthProxyHandler);

  app.use(express.json({ limit: '50kb' }));

  // 3. Hardened Rate Limiters with Custom Anti-Spoofing KeyGenerator & Active Validations
  // PostgreSQL mode uses shared, atomic bucket stores so limits hold across
  // all Cloud Run instances (no per-instance MemoryStore multiplication).
  // Each limiter gets its OWN store instance with a unique key prefix:
  // express-rate-limit forbids sharing one store across limiters
  // (ERR_ERL_STORE_REUSE), and distinct prefixes keep the 180/min and 30/min
  // counters independent.
  const standardLimitStore =
    activeStore.mode === 'postgres' ? new PostgresRateLimitStore(60 * 1000, 'std') : undefined;
  const sensitiveLimitStore =
    activeStore.mode === 'postgres' ? new PostgresRateLimitStore(60 * 1000, 'sens') : undefined;
  const standardApiLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 180,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req: Request) => extractTrustedClientIp(req),
    validate: {
      default: true,
    },
        ...(standardLimitStore ? { store: standardLimitStore as never } : {}),
    handler: (req: Request, res: Response) => {
      store()
        .recordSecurityEvent(
          'RATE_LIMIT_EXCEEDED',
          String(req.headers['x-gogo-app-id'] || 'central-control'),
          `${req.method} ${req.originalUrl}`,
          'medium',
          'Rate limit exceeded on standard API route (180 req/min).',
          extractTrustedClientIp(req)
        )
        .catch(() => {
          // Telemetry failures must not break the 429 response.
        });
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
        ...(sensitiveLimitStore ? { store: sensitiveLimitStore as never } : {}),
    handler: (req: Request, res: Response) => {
      store()
        .recordSecurityEvent(
          'RATE_LIMIT_EXCEEDED',
          String(req.headers['x-gogo-app-id'] || 'central-control'),
          `${req.method} ${req.originalUrl}`,
          'high',
          'Rate limit exceeded on sensitive mutation route (30 req/min).',
          extractTrustedClientIp(req)
        )
        .catch(() => {
          // Telemetry failures must not break the 429 response.
        });
      res.status(429).json({
        error: 'Rate limit exceeded for sensitive operation. Please wait 60 seconds.',
        code: 'SENSITIVE_RATE_LIMIT_EXCEEDED',
      });
    },
  });

  // Infrastructure liveness/readiness probes are exempt from rate limiting.
  // The limiter's store is PostgreSQL-backed in production; if the probes were
  // rate-limited, a database outage would fail the limiter's increment and
  // 500 even the process-only /health/live probe (found by the deterministic
  // compose outage test; restart-storm risk on Kubernetes/Cloud Run). Probe
  // routes answer directly; ALL other /api/* routes stay rate-limited
  // (REG-18 verifies the 429 limiter still fires on non-probe routes).
  app.use('/api/', (req: Request, res: Response, next: NextFunction) => {
    if (
      req.path === '/v1/health' ||
      req.path === '/v1/health/live' ||
      req.path === '/v1/health/ready'
    ) {
      return next();
    }
    return standardApiLimiter(req, res, next);
  });

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

  // Kubernetes/Cloud Run Liveness Probe: process-only. A temporary database
  // outage must NOT kill the instance (that would cause restart storms).
  app.get('/api/v1/health/live', (_req: Request, res: Response) => {
    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
    });
  });

  // Readiness Probe: verifies real PostgreSQL connectivity in postgres mode.
  // Returns 503 while the database is unreachable so load balancers stop
  // routing requests to this instance. Liveness stays green (see above).
  app.get('/api/v1/health/ready', async (_req: Request, res: Response) => {
    const ready = await store().checkHealth();
    if (!ready) {
      return res.status(503).json({
        status: 'unavailable',
        database: 'unreachable',
        timestamp: new Date().toISOString(),
      });
    }
    return res.json({
      status: 'ok',
      database: store().mode === 'postgres' ? 'connected' : 'in-memory-test-mode',
      timestamp: new Date().toISOString(),
    });
  });

  // Public Firebase Admin runtime diagnostics. Unauthenticated by design:
  // while server-side token verification is broken, the admin dashboard
  // cannot authenticate, so gating this on requireAuth would make the
  // diagnostic unreachable in exactly the situation it exists for. It
  // returns ONLY booleans, public project identifiers, and raw error
  // codes from a deliberately failing live probe — never secrets. The
  // standard /api rate limiter applies.
  app.get('/api/v1/health/firebase', async (_req: Request, res: Response) => {
    try {
      const diagnostics = await adminRuntimeDiagnostics();
      return res.json({ status: 'ok', firebaseAdmin: diagnostics });
    } catch (error) {
      return res.status(500).json({
        status: 'error',
        error: 'Firebase diagnostics probe failed.',
        detail: error instanceof Error ? error.message.slice(0, 160) : 'unknown error',
      });
    }
  });

  // Protected Admin-Only Detailed Diagnostics Health Check
  app.get(
    '/api/v1/health/detailed',
    requireAuth,
    requireAdmin,
    async (_req: AuthenticatedRequest, res: Response) => {
      const metrics = await store().detailedMetrics();
      res.json({
        status: 'healthy',
        service: 'gogo-central-backend',
        persistenceMode: store().mode,
        uptimeSeconds: Math.floor((Date.now() - startTime) / 1000),
        firebaseProjectId: FIREBASE_PROJECT_ID,
        metrics: {
          registeredApps: metrics.registeredApps,
          totalUsers: metrics.totalUsers,
          activeDeviceTokens: metrics.activeDeviceTokens,
          totalCampaigns: metrics.totalCampaigns,
        },
      });
    }
  );

  // Complete Overview Snapshot (Scoped by RBAC role)
  app.get('/api/v1/overview', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    const isAdmin = req.user?.role === 'admin';
    const uid = req.user?.uid || '';

    const products = await store().listApps();
    const devices = isAdmin
      ? await store().listDevices({})
      : await store().listDevices({ userId: uid });
    const preferences = isAdmin ? await store().listAllPreferences() : await store().listPreferences(uid);
    const campaigns = isAdmin
      ? await store().listCampaigns({})
      : await store().listCampaigns({ visibleToUid: uid });
    const deliveries = isAdmin
      ? (await store().listDeliveries({ limit: 50 })).slice(0, 50)
      : (await store().listDeliveries({ userId: uid, limit: 25 })).slice(0, 25);

    res.json({
      currentUser: req.user,
      // Honest delivery-mode flag: true means FCM_DRY_RUN=true (receipts are
      // simulated and dryrun:-prefixed). The admin panel renders this so a
      // dry-run campaign can never be mistaken for a real broadcast.
      fcmDryRun: process.env.FCM_DRY_RUN === 'true',
      products,
      users: isAdmin ? await store().listUsers() : [],
      devices,
      preferences,
      campaigns,
      deliveries,
      auditLogs: isAdmin ? await store().listAuditLogs(50) : [],
      securityEvents: isAdmin ? await store().listSecurityEvents(50) : [],
      systemConfigs: isAdmin ? await store().listSystemConfigs() : [],
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
  app.get('/api/v1/apps', requireAuth, async (_req: AuthenticatedRequest, res: Response) => {
    res.json({
      apps: await store().listApps(),
    });
  });

  // Dynamically Register a New GoGo Product (Admin Only)
  app.post(
    '/api/v1/apps',
    sensitiveMutationLimiter,
    requireAuth,
    requireAdmin,
    async (req: AuthenticatedRequest, res: Response) => {
      const parsed = RegisterAppSchema.safeParse(req.body);
      if (!parsed.success) {
        return res
          .status(400)
          .json({ error: 'Invalid application payload', details: parsed.error.issues });
      }
      const data = parsed.data;
      if (await store().hasApp(data.appId)) {
        return res
          .status(409)
          .json({ error: `Application '${data.appId}' is already registered.` });
      }

      const newApp = await store().createApp({
        appId: data.appId,
        name: data.name,
        domain: data.domain,
        category: data.category,
        fcmEnabled: data.fcmEnabled,
        webPushEnabled: data.webPushEnabled,
        androidEnabled: data.androidEnabled,
        rateLimitPerMin: data.rateLimitPerMin,
      });

      if (!newApp) {
        return res
          .status(409)
          .json({ error: `Application '${data.appId}' is already registered.` });
      }

      await store().recordAuditLog(
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
    async (req: AuthenticatedRequest, res: Response) => {
      const appId = String(req.params.appId);
      if (!(await store().hasApp(appId))) {
        return res.status(404).json({ error: `GoGo application '${appId}' not found.` });
      }

      const parsed = UpdateAppSchema.safeParse(req.body);
      if (!parsed.success) {
        return res
          .status(400)
          .json({ error: 'Invalid configuration update', details: parsed.error.issues });
      }

      const existing = await store().updateAppSettings(appId, parsed.data);
      if (!existing) {
        return res.status(404).json({ error: `GoGo application '${appId}' not found.` });
      }

      await store().recordAuditLog(
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
  app.get('/api/v1/devices', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    const isAdmin = req.user!.role === 'admin';
    const uid = req.user!.uid;
    const devices = isAdmin
      ? await store().listDevices({})
      : await store().listDevices({ userId: uid });
    return res.json({ devices });
  });

  // Register or Refresh Device FCM Token
  app.post(
    '/api/v1/devices/register',
    sensitiveMutationLimiter,
    requireAuth,
    async (req: AuthenticatedRequest, res: Response) => {
      const parsed = RegisterDeviceSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({
          error: 'Invalid device token registration payload',
          details: parsed.error.issues,
        });
      }

      const { appId, fcmToken, platform, userAgent } = parsed.data;
      if (!(await store().hasApp(appId))) {
        return res.status(404).json({ error: `Target GoGo product '${appId}' does not exist.` });
      }

      const deviceId = `dev_${appId}_${platform}_${Date.now().toString(36)}`;
      const record = await store().createDevice({
        deviceId,
        userId: req.user!.uid, // Strictly bound to verified token UID
        appId,
        fcmToken,
        platform,
        userAgent,
      });

      await store().recordAuditLog(
        req.user!.uid,
        appId,
        'DEVICE_TOKEN_REGISTER',
        record.deviceId,
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
    async (req: AuthenticatedRequest, res: Response) => {
      const deviceId = String(req.params.deviceId);
      const device = await store().getDevice(deviceId);
      if (!device) {
        return res.status(404).json({ error: 'Device token registration not found.' });
      }

      if (device.userId !== req.user!.uid && req.user!.role !== 'admin') {
        await store().recordSecurityEvent(
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

      const revoked = await store().markDeviceStatus(deviceId, 'revoked');
      if (!revoked) {
        return res.status(404).json({ error: 'Device token registration not found.' });
      }

      await store().recordAuditLog(
        req.user!.uid,
        device.appId,
        'DEVICE_TOKEN_REVOKE',
        deviceId,
        'warn',
        `Revoked ${device.platform} FCM token ${deviceId} on ${device.appId}.`
      );

      return res.json({ device: revoked });
    }
  );

  // Get Authenticated User's Notification Preferences
  app.get('/api/v1/preferences', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    const uid = req.user!.uid;
    const prefs = await store().listPreferences(uid);
    return res.json({ preferences: prefs });
  });

  // Update Per-User, Per-Product Notification Preferences
  app.put(
    '/api/v1/preferences/:appId',
    sensitiveMutationLimiter,
    requireAuth,
    async (req: AuthenticatedRequest, res: Response) => {
      const appId = String(req.params.appId);
      if (!(await store().hasApp(appId))) {
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
      const record = await store().upsertPreference(uid, appId, parsed.data);

      await store().recordAuditLog(
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
      // Topic targeting has no delivery implementation (no topic
      // subscriptions exist). Reject explicitly instead of silently
      // broadcasting to every device.
      if (data.targetType === 'topic') {
        return res.status(400).json({
          error:
            'Topic targeting is not implemented. Use individual, group, product, ecosystem, broadcast or targeted.',
          code: 'TARGETING_TOPIC_NOT_IMPLEMENTED',
        });
      }
      if (data.appId !== 'all-gogo' && !(await store().hasApp(data.appId))) {
        return res
          .status(404)
          .json({ error: `Target GoGo application '${data.appId}' is not registered.` });
      }

      try {
        const result = await store().dispatchNotification({
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
          : msg.startsWith('IDEMPOTENCY_PAYLOAD_MISMATCH')
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
      const outcome = await store().retryFailedCampaign(notificationId, req.user!.uid);
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
    async (req: AuthenticatedRequest, res: Response) => {
      const limit = Math.min(Math.max(parseInt(String(req.query.limit || '50'), 10) || 50, 1), 200);
      const logs = await store().listAuditLogs(limit);
      return res.json({ auditLogs: logs, count: logs.length, total: await store().countAuditLogs() });
    }
  );

  // Read Security Events (Admin Only, Bounded)
  app.get(
    '/api/v1/security-events',
    standardApiLimiter,
    requireAuth,
    requireAdmin,
    async (req: AuthenticatedRequest, res: Response) => {
      const limit = Math.min(Math.max(parseInt(String(req.query.limit || '50'), 10) || 50, 1), 200);
      const events = await store().listSecurityEvents(limit);
      return res.json({ securityEvents: events, count: events.length, total: await store().countSecurityEvents() });
    }
  );

  // Read System Configuration (Admin Only)
  app.get(
    '/api/v1/system-config',
    standardApiLimiter,
    requireAuth,
    requireAdmin,
    async (_req: AuthenticatedRequest, res: Response) => {
      const configs = await store().listSystemConfigs();
      return res.json({ systemConfigs: configs, count: configs.length });
    }
  );

  // Update System Configuration (Admin Only)
  app.put(
    '/api/v1/system-config/:configKey',
    sensitiveMutationLimiter,
    requireAuth,
    requireAdmin,
    async (req: AuthenticatedRequest, res: Response) => {
      const configKey = String(req.params.configKey);
      const existing = await store().getSystemConfig(configKey);
      if (!existing) {
        return res.status(404).json({ error: `System config '${configKey}' not found.` });
      }

      const configValue = String(req.body.configValue ?? '').trim();
      if (!configValue || configValue.length > 256) {
        return res.status(400).json({ error: 'Invalid configValue.' });
      }

      const updated = await store().updateSystemConfig(configKey, configValue, req.user!.uid);
      if (!updated) {
        return res.status(404).json({ error: `System config '${configKey}' not found.` });
      }

      await store().recordAuditLog(
        req.user!.uid,
        'central-control',
        'SYSTEM_CONFIG_UPDATE',
        configKey,
        'warn',
        `Updated system config ${configKey}=${updated.configValue}`
      );

      return res.json({ config: updated });
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
        await store().recordSecurityEvent(
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

      // The 13-test suite exercises the in-memory engine (seed integrity,
      // mutexes, demo tokens). In PostgreSQL mode it does not describe the
      // runtime, so we skip honestly instead of reporting unrelated results.
      if (store().mode === 'postgres') {
        return res.json({
          status: 'SKIPPED',
          reason:
            'SELF_TEST_COVERS_IN_MEMORY_ENGINE_ONLY: PostgreSQL integration is verified by the dedicated integration suite (npm run test:pg).',
          persistenceMode: 'postgres',
          timestamp: new Date().toISOString(),
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
    async (req: AuthenticatedRequest, res: Response) => {
      // In PostgreSQL mode the authoritative backup is pg_dump (the SQL export
      // would only contain demo seeds — dishonest and NOT a real backup).
      if (store().mode === 'postgres') {
        await store().recordAuditLog(
          req.user!.uid,
          'central-control',
          'DATABASE_BACKUP_REQUEST',
          'pg-dump-guidance',
          'warn',
          'SQL export refused in PostgreSQL mode; use pg_dump via scripts/backup-restore.sh.'
        );
        return res.status(409).json({
          error:
            'In PostgreSQL mode, backups must use pg_dump. Run scripts/backup-restore.sh backup (custom format). The in-memory SQL export is only available in explicit demo mode (GOGO_IN_MEMORY_DEMO=true).',
          code: 'BACKUP_USES_PG_DUMP',
          procedure: 'scripts/backup-restore.sh backup',
        });
      }

      const backupDir = path.resolve(process.cwd(), 'backups');
      fs.mkdirSync(backupDir, { recursive: true });
      const sqlDump = generateTransactionalSqlBackup(backendStore);
      const outPath = path.join(backupDir, 'gogo_central_latest.sql');
      fs.writeFileSync(outPath, sqlDump, 'utf-8');

      await store().recordAuditLog(
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
  let app;
  try {
    app = await createGoGoApp();
  } catch (error) {
    // Startup fails loudly when the required persistence backend is
    // unavailable. Sanitized message only — never credentials or DSNs.
    const message =
      error instanceof Error ? error.message : 'Unknown startup failure';
    console.log(
      JSON.stringify({
        level: 'ERROR',
        service: 'gogo-central-backend',
        message: 'Startup aborted: persistence backend unavailable.',
        reason: message,
        hint: 'Set SQL_HOST/SQL_PORT/SQL_DB_NAME/SQL_USER/SQL_PASSWORD, or explicitly opt into demo mode with GOGO_IN_MEMORY_DEMO=true (never in production).',
        timestamp: new Date().toISOString(),
      })
    );
    process.exit(1);
  }

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
    // Close the active store (worker loop + PG pool drain). Queued campaigns
    // stay durable in PostgreSQL; nothing is lost.
    if (activeStore) {
      activeStore
        .close()
        .catch(() => {
          // Best-effort drain during shutdown.
        })
        .finally(() => {
          server.close(() => {
            process.exit(0);
          });
        });
    } else {
      server.close(() => {
        process.exit(0);
      });
    }
    setTimeout(() => process.exit(0), 8000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

// Start server unless imported strictly for unit/integration testing
if (process.env.GOGO_TEST_IMPORT !== 'true') {
  startServer();
}
