/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Persistence-mode-agnostic data store contract for the GoGo Central API.
 *
 * Two implementations exist:
 *  - InMemoryDataStore: wraps the legacy GoGoCentralBackendEngine. Explicitly
 *    test/demo-only (GOGO_TEST_IMPORT=true or GOGO_IN_MEMORY_DEMO=true).
 *  - PostgresDataStore: repository-backed real PostgreSQL persistence
 *    (default in production; startup fails loudly if PG is unreachable).
 *
 * Production NEVER silently falls back to in-memory storage.
 */

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
  TargetScope,
  ClientPlatform,
} from '../types/gogo.ts';

export type StoreMode = 'in-memory' | 'postgres';

export interface DispatchNotificationParams {
  idempotencyKey: string;
  appId: string;
  targetType: TargetScope;
  targetValue: string;
  platform: 'all' | 'web' | 'android';
  title: string;
  body: string;
  deepLink: string;
  scheduledFor: string | null;
  authorId: string;
}

export interface DispatchNotificationResult {
  campaign: NotificationCampaignRecord;
  duplicatePrevented: boolean;
  deliveriesCreated: DeliveryReceiptRecord[];
}

export interface DetailedMetrics {
  registeredApps: number;
  totalUsers: number;
  activeDeviceTokens: number;
  totalCampaigns: number;
}

export interface GoGoDataStore {
  readonly mode: StoreMode;

  // Users & RBAC
  isAdminUid(uid: string): Promise<boolean>;
  hasUser(uid: string): Promise<boolean>;
  syncUser(uid: string, profile: {
    displayName: string;
    emailMasked: string;
    emailVerified: boolean;
    authProvider: 'google.com' | 'password' | 'anonymous_guest';
    role: 'user' | 'admin';
  }): Promise<void>;
  listUsers(): Promise<CentralUserRecord[]>;

  // Registered applications
  listApps(): Promise<GoGoProduct[]>;
  hasApp(appId: string): Promise<boolean>;
  createApp(data: {
    appId: string;
    name: string;
    domain: string;
    category: ProductCategory;
    fcmEnabled: boolean;
    webPushEnabled: boolean;
    androidEnabled: boolean;
    rateLimitPerMin: number;
  }): Promise<GoGoProduct | null>;
  updateAppSettings(
    appId: string,
    updates: {
      fcmEnabled?: boolean;
      webPushEnabled?: boolean;
      androidEnabled?: boolean;
      rateLimitPerMin?: number;
    }
  ): Promise<GoGoProduct | null>;

  // Device tokens
  listDevices(filter: { userId?: string }): Promise<DeviceTokenRecord[]>;
  getDevice(deviceId: string): Promise<DeviceTokenRecord | null>;
  createDevice(data: {
    deviceId: string;
    userId: string;
    appId: string;
    fcmToken: string;
    platform: ClientPlatform;
    userAgent: string;
  }): Promise<DeviceTokenRecord>;
  markDeviceStatus(
    deviceId: string,
    status: 'active' | 'revoked' | 'expired'
  ): Promise<DeviceTokenRecord | null>;

  // Notification preferences
  listPreferences(userId: string): Promise<NotificationPreferenceRecord[]>;
  listAllPreferences(): Promise<NotificationPreferenceRecord[]>;
  upsertPreference(
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
  ): Promise<NotificationPreferenceRecord>;

  // Campaigns & deliveries
  listCampaigns(filter: { visibleToUid?: string }): Promise<NotificationCampaignRecord[]>;
  getCampaign(notificationId: string): Promise<NotificationCampaignRecord | null>;
  listDeliveries(filter: {
    userId?: string;
    limit?: number;
  }): Promise<DeliveryReceiptRecord[]>;
  dispatchNotification(
    params: DispatchNotificationParams
  ): Promise<DispatchNotificationResult>;
  retryFailedCampaign(
    notificationId: string,
    actorId: string
  ): Promise<{ campaign: NotificationCampaignRecord | null; error?: string }>;
  cancelCampaign(notificationId: string): Promise<NotificationCampaignRecord | null>;

  // Audit & security telemetry
  recordAuditLog(
    actorId: string,
    appId: string,
    action: string,
    resourceId: string,
    severity: 'info' | 'warn' | 'critical',
    details: string
  ): Promise<void>;
  recordSecurityEvent(
    eventType: SecurityEventRecord['eventType'],
    appId: string,
    endpoint: string,
    severity: SecurityEventRecord['severity'],
    mitigationApplied: string,
    clientIp?: string
  ): Promise<void>;
  listAuditLogs(limit: number): Promise<AuditLogRecord[]>;
  countAuditLogs(): Promise<number>;
  listSecurityEvents(limit: number): Promise<SecurityEventRecord[]>;
  countSecurityEvents(): Promise<number>;

  // System configuration
  listSystemConfigs(): Promise<SystemConfigRecord[]>;
  getSystemConfig(configKey: string): Promise<SystemConfigRecord | null>;
  updateSystemConfig(
    configKey: string,
    configValue: string,
    updatedBy: string
  ): Promise<SystemConfigRecord | null>;

  // Diagnostics & lifecycle
  sanitizeText(input: string): string;
  detailedMetrics(): Promise<DetailedMetrics>;
  checkHealth(): Promise<boolean>;
  close(): Promise<void>;
}

/**
 * Resolves the active data store.
 *
 * - GOGO_TEST_IMPORT=true (test scripts) or GOGO_IN_MEMORY_DEMO=true
 *   (explicit local demo) → in-memory adapter over the legacy engine.
 * - Otherwise → PostgreSQL store: migrations run, then the worker loop
 *   starts. If PostgreSQL is unreachable the error propagates and startup
 *   fails with a sanitized message. Production NEVER silently falls back to
 *   in-memory storage.
 */
export async function resolveDataStore(): Promise<GoGoDataStore> {
  const inMemoryRequested =
    process.env.GOGO_TEST_IMPORT === 'true' || process.env.GOGO_IN_MEMORY_DEMO === 'true';

  if (inMemoryRequested) {
    const { backendStore } = await import('./store.ts');
    const { InMemoryDataStore } = await import('./in-memory-store.ts');
    return new InMemoryDataStore(backendStore);
  }

  const { PostgresDataStore } = await import('./postgres-store.ts');
  const store = new PostgresDataStore();
  const { runMigrations } = await import('../db/migrate.ts');
  const report = await runMigrations();
  console.log(
    JSON.stringify({
      level: 'INFO',
      service: 'gogo-central-backend',
      component: 'data-store',
      message: `PostgreSQL store ready (migrations applied=${report.applied.length}, known=${report.totalKnown})`,
      storeMode: 'postgres',
    })
  );
  store.startWorker();
  return store;
}
