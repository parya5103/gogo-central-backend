/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * PostgresDataStore — real PostgreSQL persistence for the GoGo Central API.
 * Implements the same GoGoDataStore contract as the in-memory adapter, so
 * every API route and response shape is identical across persistence modes.
 *
 * Distributed idempotency:
 * - Atomic INSERT ... ON CONFLICT (idempotency_key) DO NOTHING reservation.
 * - Same key + same payload (sha256) → replay: returns the original campaign
 *   with duplicatePrevented=true (HTTP 200).
 * - Same key + different payload → IDEMPOTENCY_PAYLOAD_MISMATCH (HTTP 409).
 * - Keys are durable across restarts and instances (stronger than the
 *   in-memory TTL index; documented divergence, never a correctness loss).
 *
 * Delivery semantics are at-least-once with durable deduplication; external
 * FCM delivery cannot guarantee exactly-once. See SECURITY.md.
 */

import type {
  GoGoDataStore,
  DispatchNotificationParams,
  DispatchNotificationResult,
  DetailedMetrics,
} from './data-store.ts';
import { NotificationWorker } from './notification-worker.ts';
import {
  computeCampaignPayloadHash,
  isAllowedGoGoDeepLink,
} from './campaign-rules.ts';
import {
  getCampaign,
  getCampaignByIdempotencyKey,
  insertCampaignIfAbsent,
  listCampaigns as repoListCampaigns,
} from '../repositories/campaigns.repository.ts';
import { listDeliveries as repoListDeliveries } from '../repositories/deliveries.repository.ts';
import {
  isAdminUid,
  hasUser,
  upsertUserFromFirebase,
  listUsers,
  countUsers,
} from '../repositories/users.repository.ts';
import {
  listApps,
  hasApp,
  getApp,
  createApp as repoCreateApp,
  updateAppSettings as repoUpdateAppSettings,
  listAppDomains,
} from '../repositories/apps.repository.ts';
import {
  listDevices as repoListDevices,
  getDevice,
  createDevice as repoCreateDevice,
  markDeviceStatus as repoMarkDeviceStatus,
  countActiveDevices,
} from '../repositories/devices.repository.ts';
import {
  listPreferences as repoListPreferences,
  listAllPreferences as repoListAllPreferences,
  upsertPreference as repoUpsertPreference,
} from '../repositories/preferences.repository.ts';
import {
  insertAuditLog as repoInsertAuditLog,
  listAuditLogs as repoListAuditLogs,
  countAuditLogs,
} from '../repositories/audit.repository.ts';
import {
  insertSecurityEvent as repoInsertSecurityEvent,
  hashClientIp,
  listSecurityEvents as repoListSecurityEvents,
  countSecurityEvents,
} from '../repositories/security.repository.ts';
import {
  listSystemConfigs as repoListSystemConfigs,
  getSystemConfig as repoGetSystemConfig,
  updateSystemConfig as repoUpdateSystemConfig,
} from '../repositories/config.repository.ts';
import { checkDatabaseHealth, closePool } from '../db/pool.ts';
import { countCampaigns } from '../repositories/campaigns.repository.ts';
import type {
  CentralUserRecord,
  GoGoProduct,
  DeviceTokenRecord,
  NotificationPreferenceRecord,
  NotificationCampaignRecord,
  DeliveryReceiptRecord,
  AuditLogRecord,
  SecurityEventRecord,
  SystemConfigRecord,
  ProductCategory,
  ClientPlatform,
} from '../types/gogo.ts';

function newId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
}

export class PostgresDataStore implements GoGoDataStore {
  public readonly mode = 'postgres' as const;
  private readonly worker = new NotificationWorker(`store_${process.pid}`);

  // Users & RBAC ------------------------------------------------------------
  async isAdminUid(uid: string): Promise<boolean> {
    return isAdminUid(uid);
  }

  async hasUser(uid: string): Promise<boolean> {
    return hasUser(uid);
  }

  async syncUser(
    uid: string,
    profile: {
      displayName: string;
      emailMasked: string;
      emailVerified: boolean;
      authProvider: 'google.com' | 'password' | 'anonymous_guest';
      role: 'user' | 'admin';
    }
  ): Promise<void> {
    await upsertUserFromFirebase(uid, profile);
  }

  async listUsers(): Promise<CentralUserRecord[]> {
    return listUsers();
  }

  // Registered applications ---------------------------------------------------
  async listApps(): Promise<GoGoProduct[]> {
    return listApps();
  }

  async hasApp(appId: string): Promise<boolean> {
    return hasApp(appId);
  }

  async createApp(data: {
    appId: string;
    name: string;
    domain: string;
    category: ProductCategory;
    fcmEnabled: boolean;
    webPushEnabled: boolean;
    androidEnabled: boolean;
    rateLimitPerMin: number;
  }): Promise<GoGoProduct | null> {
    return repoCreateApp(data);
  }

  async updateAppSettings(
    appId: string,
    updates: {
      fcmEnabled?: boolean;
      webPushEnabled?: boolean;
      androidEnabled?: boolean;
      rateLimitPerMin?: number;
    }
  ): Promise<GoGoProduct | null> {
    return repoUpdateAppSettings(appId, updates);
  }

  // Device tokens ---------------------------------------------------------------
  async listDevices(filter: { userId?: string }): Promise<DeviceTokenRecord[]> {
    return repoListDevices(filter);
  }

  async getDevice(deviceId: string): Promise<DeviceTokenRecord | null> {
    return getDevice(deviceId);
  }

  async createDevice(data: {
    deviceId: string;
    userId: string;
    appId: string;
    fcmToken: string;
    platform: ClientPlatform;
    userAgent: string;
  }): Promise<DeviceTokenRecord> {
    return repoCreateDevice(data);
  }

  async markDeviceStatus(
    deviceId: string,
    status: 'active' | 'revoked' | 'expired'
  ): Promise<DeviceTokenRecord | null> {
    return repoMarkDeviceStatus(deviceId, status);
  }

  // Preferences --------------------------------------------------------------------
  async listPreferences(userId: string): Promise<NotificationPreferenceRecord[]> {
    return repoListPreferences(userId);
  }

  async listAllPreferences(): Promise<NotificationPreferenceRecord[]> {
    return repoListAllPreferences();
  }

  async upsertPreference(
    userId: string,
    appId: string,
    patch: {
      enabled: boolean;
      webPush: boolean;
      androidPush: boolean;
      marketingAlerts: boolean;
      transactionalAlerts: boolean;
      quietHoursStart: string;
      quietHoursEnd: string;
    }
  ): Promise<NotificationPreferenceRecord> {
    return repoUpsertPreference(userId, appId, patch);
  }

  // Campaigns & deliveries -----------------------------------------------------------
  async listCampaigns(filter: { visibleToUid?: string }): Promise<NotificationCampaignRecord[]> {
    return repoListCampaigns(filter);
  }

  async getCampaign(notificationId: string): Promise<NotificationCampaignRecord | null> {
    return getCampaign(notificationId);
  }

  async listDeliveries(filter: {
    userId?: string;
    limit?: number;
  }): Promise<DeliveryReceiptRecord[]> {
    return repoListDeliveries(filter);
  }

  async dispatchNotification(
    params: DispatchNotificationParams
  ): Promise<DispatchNotificationResult> {
    // 1. Deep-link allowlist (phishing / open-redirect prevention).
    const domains = await listAppDomains();
    if (!isAllowedGoGoDeepLink(params.deepLink, domains)) {
      await this.recordSecurityEvent(
        'INVALID_PAYLOAD_SANITIZED',
        params.appId,
        'POST /api/v1/notifications/send',
        'high',
        `Blocked untrusted deepLink domain (${params.deepLink}); deepLink must target an HTTPS GoGo domain.`
      );
      throw new Error(
        'UNTRUSTED_DEEPLINK_DOMAIN: Deep link must use HTTPS and belong to a registered GoGo domain.'
      );
    }

    // 2. Product-level FCM master switch.
    if (params.appId !== 'all-gogo') {
      const app = await getApp(params.appId);
      if (app && !app.fcmEnabled) {
        throw new Error(`FCM_DISABLED_FOR_APP: Notifications are currently disabled for ${params.appId}.`);
      }
    }

    // 3. Durable, atomic idempotency reservation.
    const payloadHash = computeCampaignPayloadHash({
      appId: params.appId,
      targetType: params.targetType,
      targetValue: params.targetValue,
      platform: params.platform,
      title: params.title,
      body: params.body,
      deepLink: params.deepLink,
      scheduledFor: params.scheduledFor,
    });
    const isScheduled =
      Boolean(params.scheduledFor) &&
      new Date(String(params.scheduledFor)).getTime() > Date.now();

    const inserted = await insertCampaignIfAbsent({
      notificationId: newId('notif'),
      idempotencyKey: params.idempotencyKey,
      appId: params.appId,
      targetType: params.targetType,
      targetValue: params.targetValue,
      platform: params.platform,
      title: params.title,
      body: params.body,
      deepLink: params.deepLink,
      scheduledFor: isScheduled ? params.scheduledFor : null,
      authorId: params.authorId,
      payloadHash,
    });

    if (!inserted) {
      // Key already exists: replay or conflict.
      const existing = await getCampaignByIdempotencyKey(params.idempotencyKey);
      if (!existing) {
        throw new Error('IDEMPOTENCY_STATE_INVALID: Reservation conflict could not be resolved.');
      }
      await this.recordSecurityEvent(
        'IDEMPOTENCY_DUPLICATE_BLOCKED',
        params.appId,
        'POST /api/v1/notifications/send',
        'medium',
        `Intercepted duplicate send request for idempotencyKey=${params.idempotencyKey}`
      );
      if (existing.payloadHash && existing.payloadHash !== payloadHash) {
        throw new Error(
          'IDEMPOTENCY_PAYLOAD_MISMATCH: This idempotency key was already used with a different payload.'
        );
      }
      return { campaign: existing.campaign, duplicatePrevented: true, deliveriesCreated: [] };
    }

    // 4a. Future-dated → stays 'scheduled'; the worker loop dispatches when due.
    if (inserted.status === 'scheduled') {
      return { campaign: inserted, duplicatePrevented: false, deliveriesCreated: [] };
    }

    // 4b. Immediate → process inline (preserves the 201 + sentCount contract);
    //     the worker loop is the safety net for interrupted processing.
    const final = await this.worker.processCampaign(inserted.notificationId);
    const deliveriesCreated = await repoListDeliveries({
      campaignId: inserted.notificationId,
      limit: 500,
    });
    return {
      campaign: final ?? inserted,
      duplicatePrevented: false,
      deliveriesCreated,
    };
  }

  async retryFailedCampaign(
    notificationId: string,
    actorId: string
  ): Promise<{ campaign: NotificationCampaignRecord | null; error?: string }> {
    return this.worker.retryFailedCampaign(notificationId, actorId);
  }

  // Audit & security --------------------------------------------------------------------
  async recordAuditLog(
    actorId: string,
    appId: string,
    action: string,
    resourceId: string,
    severity: 'info' | 'warn' | 'critical',
    details: string
  ): Promise<void> {
    await repoInsertAuditLog({
      logId: newId('audit'),
      actorId,
      appId,
      action,
      resourceId,
      severity,
      details: this.sanitizeText(details).slice(0, 500),
    });
  }

  async recordSecurityEvent(
    eventType: SecurityEventRecord['eventType'],
    appId: string,
    endpoint: string,
    severity: SecurityEventRecord['severity'],
    mitigationApplied: string,
    clientIp?: string
  ): Promise<void> {
    await repoInsertSecurityEvent({
      eventId: newId('sec'),
      eventType,
      appId,
      endpoint,
      severity,
      mitigationApplied,
      clientIpHash: hashClientIp(clientIp),
    });
  }

  async listAuditLogs(limit: number): Promise<AuditLogRecord[]> {
    return repoListAuditLogs(limit);
  }

  async countAuditLogs(): Promise<number> {
    return countAuditLogs();
  }

  async listSecurityEvents(limit: number): Promise<SecurityEventRecord[]> {
    return repoListSecurityEvents(limit);
  }

  async countSecurityEvents(): Promise<number> {
    return countSecurityEvents();
  }

  // System configuration -------------------------------------------------------------------
  async listSystemConfigs(): Promise<SystemConfigRecord[]> {
    return repoListSystemConfigs();
  }

  async getSystemConfig(configKey: string): Promise<SystemConfigRecord | null> {
    return repoGetSystemConfig(configKey);
  }

  async updateSystemConfig(
    configKey: string,
    configValue: string,
    updatedBy: string
  ): Promise<SystemConfigRecord | null> {
    return repoUpdateSystemConfig(configKey, this.sanitizeText(configValue), updatedBy);
  }

  // Diagnostics ------------------------------------------------------------------------------
  sanitizeText(input: string): string {
    return input
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
      .replace(/javascript:/gi, '')
      .replace(/on\w+\s*=/gi, '')
      .replace(/[<>]/g, '')
      .trim();
  }

  async detailedMetrics(): Promise<DetailedMetrics> {
    const [apps, users, devices, campaigns] = await Promise.all([
      listApps(),
      countUsers(),
      countActiveDevices(),
      countCampaigns(),
    ]);
    return {
      registeredApps: apps.length,
      totalUsers: users,
      activeDeviceTokens: devices,
      totalCampaigns: campaigns,
    };
  }

  async checkHealth(): Promise<boolean> {
    return checkDatabaseHealth();
  }

  async close(): Promise<void> {
    this.worker.stop();
    await closePool();
  }

  /** Exposed for the startup path (worker loop ownership lives with the store). */
  startWorker(intervalMs = 30000): void {
    this.worker.start(intervalMs);
  }

  stopWorker(): void {
    this.worker.stop();
  }
}
