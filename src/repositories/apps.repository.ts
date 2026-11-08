/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Registered applications repository. activeUsersCount / registeredDevicesCount
 * are computed from real rows (never seeded inflated metrics).
 */

import { query } from '../db/pool.ts';
import type { GoGoProduct, ProductCategory } from '../types/gogo.ts';

interface AppRow {
  app_id: string;
  name: string;
  domain: string;
  category: string;
  fcm_enabled: boolean;
  web_push_enabled: boolean;
  android_enabled: boolean;
  rate_limit_per_min: number;
  created_at: Date;
  updated_at: Date;
  active_users_count: string;
  registered_devices_count: string;
}

function toRecord(row: AppRow): GoGoProduct {
  const category: ProductCategory =
    row.category === 'portal' || row.category === 'civic' || row.category === 'news'
      ? row.category
      : 'game';
  return {
    appId: row.app_id,
    name: row.name,
    domain: row.domain,
    category,
    fcmEnabled: row.fcm_enabled,
    webPushEnabled: row.web_push_enabled,
    androidEnabled: row.android_enabled,
    rateLimitPerMin: row.rate_limit_per_min,
    activeUsersCount: Number(row.active_users_count || 0),
    registeredDevicesCount: Number(row.registered_devices_count || 0),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

const SELECT_APPS = `
  SELECT a.app_id, a.name, a.domain, a.category, a.fcm_enabled, a.web_push_enabled,
         a.android_enabled, a.rate_limit_per_min, a.created_at, a.updated_at,
         (SELECT COUNT(DISTINCT r.user_id) FROM user_app_roles r WHERE r.app_id = a.app_id) AS active_users_count,
         (SELECT COUNT(*) FROM device_tokens d WHERE d.app_id = a.app_id) AS registered_devices_count
  FROM registered_applications a
`;

export async function listApps(): Promise<GoGoProduct[]> {
  const rows = await query<AppRow>(`${SELECT_APPS} ORDER BY a.created_at ASC`);
  return rows.map(toRecord);
}

export async function getApp(appId: string): Promise<GoGoProduct | null> {
  const rows = await query<AppRow>(`${SELECT_APPS} WHERE a.app_id = $1`, [appId]);
  return rows[0] ? toRecord(rows[0]) : null;
}

export async function hasApp(appId: string): Promise<boolean> {
  const rows = await query<{ exists: boolean }>(
    'SELECT EXISTS (SELECT 1 FROM registered_applications WHERE app_id = $1) AS exists',
    [appId]
  );
  return Boolean(rows[0]?.exists);
}

export async function createApp(params: {
  appId: string;
  name: string;
  domain: string;
  category: ProductCategory;
  fcmEnabled: boolean;
  webPushEnabled: boolean;
  androidEnabled: boolean;
  rateLimitPerMin: number;
}): Promise<GoGoProduct | null> {
  const rows = await query<{ app_id: string }>(
    `INSERT INTO registered_applications
       (app_id, name, domain, category, fcm_enabled, web_push_enabled, android_enabled, rate_limit_per_min)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (app_id) DO NOTHING
     RETURNING app_id`,
    [
      params.appId,
      params.name,
      params.domain,
      params.category,
      params.fcmEnabled,
      params.webPushEnabled,
      params.androidEnabled,
      params.rateLimitPerMin,
    ]
  );
  if (rows.length === 0) return null;
  return getApp(params.appId);
}

export async function updateAppSettings(
  appId: string,
  updates: {
    fcmEnabled?: boolean;
    webPushEnabled?: boolean;
    androidEnabled?: boolean;
    rateLimitPerMin?: number;
  }
): Promise<GoGoProduct | null> {
  const rows = await query<{ app_id: string }>(
    `UPDATE registered_applications SET
       fcm_enabled = COALESCE($2, fcm_enabled),
       web_push_enabled = COALESCE($3, web_push_enabled),
       android_enabled = COALESCE($4, android_enabled),
       rate_limit_per_min = COALESCE($5, rate_limit_per_min),
       updated_at = NOW()
     WHERE app_id = $1
     RETURNING app_id`,
    [appId, updates.fcmEnabled ?? null, updates.webPushEnabled ?? null, updates.androidEnabled ?? null, updates.rateLimitPerMin ?? null]
  );
  if (rows.length === 0) return null;
  return getApp(appId);
}

/** Domains of registered products (deep-link allowlist input). */
export async function listAppDomains(): Promise<string[]> {
  const rows = await query<{ domain: string }>('SELECT domain FROM registered_applications');
  return rows.map((r) => r.domain);
}
