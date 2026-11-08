/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export type ProductCategory = 'portal' | 'civic' | 'news' | 'game';
export type ClientPlatform = 'web' | 'android';
export type TargetScope = 'individual' | 'group' | 'product' | 'ecosystem' | 'broadcast' | 'targeted' | 'topic';
export type CampaignStatus = 'queued' | 'scheduled' | 'processing' | 'delivered' | 'partial_failure' | 'failed';

export interface GoGoProduct {
  appId: string;
  name: string;
  domain: string;
  category: ProductCategory;
  fcmEnabled: boolean;
  webPushEnabled: boolean;
  androidEnabled: boolean;
  rateLimitPerMin: number;
  activeUsersCount: number;
  registeredDevicesCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface CentralUserRecord {
  uid: string;
  displayName: string;
  emailMasked: string;
  role: 'user' | 'admin';
  emailVerified: boolean;
  connectedApps: string[];
  authProvider: 'google.com' | 'password' | 'anonymous_guest';
  firestoreGameSavePreserved: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface DeviceTokenRecord {
  deviceId: string;
  userId: string;
  appId: string;
  fcmToken: string;
  platform: ClientPlatform;
  userAgent: string;
  status: 'active' | 'revoked' | 'expired';
  lastRefreshedAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface NotificationPreferenceRecord {
  prefId: string;
  userId: string;
  appId: string;
  enabled: boolean;
  webPush: boolean;
  androidPush: boolean;
  marketingAlerts: boolean;
  transactionalAlerts: boolean;
  quietHoursStart: string;
  quietHoursEnd: string;
  createdAt: string;
  updatedAt: string;
}

export interface NotificationCampaignRecord {
  notificationId: string;
  idempotencyKey: string;
  appId: string;
  targetType: TargetScope;
  targetValue: string;
  platform: 'all' | 'web' | 'android';
  title: string;
  body: string;
  deepLink: string;
  scheduledFor: string | null;
  status: CampaignStatus;
  sentCount: number;
  failedCount: number;
  retryCount: number;
  authorId: string;
  createdAt: string;
  updatedAt: string;
}

export interface DeliveryReceiptRecord {
  deliveryId: string;
  notificationId: string;
  deviceId: string;
  userId: string;
  appId: string;
  platform: ClientPlatform;
  status: 'delivered' | 'failed_transient' | 'failed_expired_token' | 'skipped_preference';
  attemptCount: number;
  fcmMessageId: string | null;
  errorCode: string | null;
  deliveredAt: string;
}

export interface AuditLogRecord {
  logId: string;
  actorId: string;
  appId: string;
  action: string;
  resourceId: string;
  severity: 'info' | 'warn' | 'critical';
  details: string;
  createdAt: string;
}

export interface SecurityEventRecord {
  eventId: string;
  eventType:
    | 'UNVERIFIED_TOKEN_BLOCKED'
    | 'RBAC_VIOLATION'
    | 'RATE_LIMIT_EXCEEDED'
    | 'IDEMPOTENCY_DUPLICATE_BLOCKED'
    | 'INVALID_PAYLOAD_SANITIZED'
    | 'CORS_ORIGIN_REJECTED'
    | 'EXPIRED_FCM_TOKEN_PRUNED';
  appId: string;
  actorIpHash: string;
  endpoint: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  mitigationApplied: string;
  createdAt: string;
}

export interface SystemConfigRecord {
  configKey: string;
  configValue: string;
  description: string;
  updatedBy: string;
  updatedAt: string;
}

export interface TestCaseResult {
  id: string;
  phase: string;
  name: string;
  category: 'auth' | 'fcm' | 'rbac' | 'security' | 'database' | 'idempotency';
  passed: boolean;
  durationMs: number;
  assertionDetail: string;
}
