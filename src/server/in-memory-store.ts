/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * InMemoryDataStore — explicit TEST/DEMO-ONLY adapter over the legacy
 * GoGoCentralBackendEngine. Selected only when GOGO_TEST_IMPORT=true or
 * GOGO_IN_MEMORY_DEMO=true. Production never uses (or silently falls back to)
 * this adapter.
 *
 * Behaviour mirrors the previous direct-engine access exactly so the
 * REG-01..14 regression suite keeps passing unchanged.
 */

import type {
  GoGoDataStore,
  DispatchNotificationParams,
  DispatchNotificationResult,
  DetailedMetrics,
} from './data-store.ts';
import type { GoGoCentralBackendEngine } from './store.ts';
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

export class InMemoryDataStore implements GoGoDataStore {
  public readonly mode = 'in-memory' as const;

  constructor(private readonly engine: GoGoCentralBackendEngine) {}

  // Users & RBAC ----------------------------------------------------------
  async isAdminUid(uid: string): Promise<boolean> {
    return this.engine.admins.has(uid);
  }

  async hasUser(uid: string): Promise<boolean> {
    return this.engine.users.has(uid);
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
    if (this.engine.users.has(uid)) return;
    const now = new Date().toISOString();
    this.engine.users.set(uid, {
      uid,
      displayName: profile.displayName,
      emailMasked: profile.emailMasked,
      role: profile.role,
      emailVerified: profile.emailVerified,
      connectedApps: ['gogocompany-in'],
      authProvider: profile.authProvider,
      firestoreGameSavePreserved: true,
      createdAt: now,
      updatedAt: now,
    });
  }

  async listUsers(): Promise<CentralUserRecord[]> {
    return Array.from(this.engine.users.values());
  }

  // Registered applications ----------------------------------------------
  async listApps(): Promise<GoGoProduct[]> {
    return Array.from(this.engine.products.values());
  }

  async hasApp(appId: string): Promise<boolean> {
    return this.engine.products.has(appId);
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
    if (this.engine.products.has(data.appId)) return null;
    const now = new Date().toISOString();
    const newApp: GoGoProduct = {
      appId: data.appId,
      name: this.engine.sanitizeText(data.name),
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
    this.engine.products.set(newApp.appId, newApp);
    return newApp;
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
    const existing = this.engine.products.get(appId);
    if (!existing) return null;
    if (typeof updates.fcmEnabled === 'boolean') existing.fcmEnabled = updates.fcmEnabled;
    if (typeof updates.webPushEnabled === 'boolean')
      existing.webPushEnabled = updates.webPushEnabled;
    if (typeof updates.androidEnabled === 'boolean')
      existing.androidEnabled = updates.androidEnabled;
    if (typeof updates.rateLimitPerMin === 'number')
      existing.rateLimitPerMin = updates.rateLimitPerMin;
    existing.updatedAt = new Date().toISOString();
    return existing;
  }

  // Device tokens ----------------------------------------------------------
  async listDevices(filter: { userId?: string }): Promise<DeviceTokenRecord[]> {
    return Array.from(this.engine.devices.values()).filter(
      (d) => !filter.userId || d.userId === filter.userId
    );
  }

  async getDevice(deviceId: string): Promise<DeviceTokenRecord | null> {
    return this.engine.devices.get(deviceId) ?? null;
  }

  async createDevice(data: {
    deviceId: string;
    userId: string;
    appId: string;
    fcmToken: string;
    platform: ClientPlatform;
    userAgent: string;
  }): Promise<DeviceTokenRecord> {
    const now = new Date().toISOString();
    const record: DeviceTokenRecord = {
      deviceId: data.deviceId,
      userId: data.userId,
      appId: data.appId,
      fcmToken: this.engine.sanitizeText(data.fcmToken),
      platform: data.platform,
      userAgent: this.engine.sanitizeText(data.userAgent),
      status: 'active',
      lastRefreshedAt: now,
      createdAt: now,
      updatedAt: now,
    };
    this.engine.devices.set(data.deviceId, record);
    const product = this.engine.products.get(data.appId);
    if (product) {
      product.registeredDevicesCount += 1;
    }
    return record;
  }

  async markDeviceStatus(
    deviceId: string,
    status: 'active' | 'revoked' | 'expired'
  ): Promise<DeviceTokenRecord | null> {
    const device = this.engine.devices.get(deviceId);
    if (!device) return null;
    device.status = status;
    device.updatedAt = new Date().toISOString();
    return device;
  }

  // Preferences ------------------------------------------------------------
  async listPreferences(userId: string): Promise<NotificationPreferenceRecord[]> {
    return Array.from(this.engine.preferences.values()).filter((p) => p.userId === userId);
  }

  async listAllPreferences(): Promise<NotificationPreferenceRecord[]> {
    return Array.from(this.engine.preferences.values());
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
    const prefId = `${userId}_${appId}`;
    const now = new Date().toISOString();
    const existing = this.engine.preferences.get(prefId);
    const record: NotificationPreferenceRecord = {
      prefId,
      userId,
      appId,
      ...patch,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    };
    this.engine.preferences.set(prefId, record);
    return record;
  }

  // Campaigns & deliveries --------------------------------------------------
  async listCampaigns(filter: { visibleToUid?: string }): Promise<NotificationCampaignRecord[]> {
    if (filter.visibleToUid) {
      return Array.from(this.engine.campaigns.values()).filter(
        (c) =>
          c.targetType === 'product' ||
          c.targetType === 'ecosystem' ||
          c.targetValue === filter.visibleToUid
      );
    }
    return Array.from(this.engine.campaigns.values());
  }

  async getCampaign(notificationId: string): Promise<NotificationCampaignRecord | null> {
    return this.engine.campaigns.get(notificationId) ?? null;
  }

  async listDeliveries(filter: {
    userId?: string;
    limit?: number;
  }): Promise<DeliveryReceiptRecord[]> {
    const all = Array.from(this.engine.deliveries.values());
    const scoped = filter.userId ? all.filter((d) => d.userId === filter.userId) : all;
    return scoped.slice(0, filter.limit ?? 100);
  }

  async dispatchNotification(
    params: DispatchNotificationParams
  ): Promise<DispatchNotificationResult> {
    return this.engine.dispatchNotification(params);
  }

  async retryFailedCampaign(
    notificationId: string,
    actorId: string
  ): Promise<{ campaign: NotificationCampaignRecord | null; error?: string }> {
    return this.engine.retryFailedCampaign(notificationId, actorId);
  }

  async listFailedPermanentDeliveries(options: {
    limit: number;
    offset: number;
  }): Promise<{ items: DeliveryReceiptRecord[]; total: number }> {
    const all = Array.from(this.engine.deliveries.values())
      .filter((d) => d.status === 'failed_permanent')
      .sort((a, b) => (a.deliveredAt < b.deliveredAt ? 1 : -1));
    const items = all.slice(options.offset, options.offset + options.limit);
    return { items, total: all.length };
  }

  // Audit & security ---------------------------------------------------------
  async recordAuditLog(
    actorId: string,
    appId: string,
    action: string,
    resourceId: string,
    severity: 'info' | 'warn' | 'critical',
    details: string
  ): Promise<void> {
    this.engine.recordAuditLog(actorId, appId, action, resourceId, severity, details);
  }

  async recordSecurityEvent(
    eventType: SecurityEventRecord['eventType'],
    appId: string,
    endpoint: string,
    severity: SecurityEventRecord['severity'],
    mitigationApplied: string,
    clientIp?: string
  ): Promise<void> {
    this.engine.recordSecurityEvent(eventType, appId, endpoint, severity, mitigationApplied, clientIp);
  }

  async listAuditLogs(limit: number): Promise<AuditLogRecord[]> {
    return this.engine.auditLogs.slice(0, limit);
  }

  async countAuditLogs(): Promise<number> {
    return this.engine.auditLogs.length;
  }

  async listSecurityEvents(limit: number): Promise<SecurityEventRecord[]> {
    return this.engine.securityEvents.slice(0, limit);
  }

  async countSecurityEvents(): Promise<number> {
    return this.engine.securityEvents.length;
  }

  // System config --------------------------------------------------------------
  async listSystemConfigs(): Promise<SystemConfigRecord[]> {
    return Array.from(this.engine.systemConfigs.values());
  }

  async getSystemConfig(configKey: string): Promise<SystemConfigRecord | null> {
    return this.engine.systemConfigs.get(configKey) ?? null;
  }

  async updateSystemConfig(
    configKey: string,
    configValue: string,
    updatedBy: string
  ): Promise<SystemConfigRecord | null> {
    const existing = this.engine.systemConfigs.get(configKey);
    if (!existing) return null;
    existing.configValue = this.engine.sanitizeText(configValue);
    existing.updatedBy = updatedBy;
    existing.updatedAt = new Date().toISOString();
    return existing;
  }

  // Diagnostics -----------------------------------------------------------------
  sanitizeText(input: string): string {
    return this.engine.sanitizeText(input);
  }

  async detailedMetrics(): Promise<DetailedMetrics> {
    return {
      registeredApps: this.engine.products.size,
      totalUsers: this.engine.users.size,
      activeDeviceTokens: Array.from(this.engine.devices.values()).filter(
        (d) => d.status === 'active'
      ).length,
      totalCampaigns: this.engine.campaigns.size,
    };
  }

  async checkHealth(): Promise<boolean> {
    return true; // In-memory store is always healthy by definition (test/demo mode).
  }

  async close(): Promise<void> {
    this.engine.stopScheduler();
  }
}
