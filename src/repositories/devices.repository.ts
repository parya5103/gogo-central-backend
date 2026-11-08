/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Device token repository. Ownership is always enforced by user_id binding
 * (never client-supplied), and revocation is a status transition, not a
 * delete — preserving audit history.
 */

import { query } from '../db/pool.ts';
import type { DeviceTokenRecord, ClientPlatform } from '../types/gogo.ts';

interface DeviceRow {
  device_id: string;
  user_id: string;
  app_id: string;
  fcm_token: string;
  platform: string;
  user_agent: string;
  status: string;
  last_refreshed_at: Date;
  created_at: Date;
  updated_at: Date;
}

function toRecord(row: DeviceRow): DeviceTokenRecord {
  return {
    deviceId: row.device_id,
    userId: row.user_id,
    appId: row.app_id,
    fcmToken: row.fcm_token,
    platform: row.platform === 'android' ? 'android' : 'web',
    userAgent: row.user_agent,
    status: row.status === 'revoked' ? 'revoked' : row.status === 'expired' ? 'expired' : 'active',
    lastRefreshedAt: new Date(row.last_refreshed_at).toISOString(),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

const SELECT_DEVICES = `SELECT device_id, user_id, app_id, fcm_token, platform, user_agent,
  status, last_refreshed_at, created_at, updated_at FROM device_tokens`;

export async function getDevice(deviceId: string): Promise<DeviceTokenRecord | null> {
  const rows = await query<DeviceRow>(`${SELECT_DEVICES} WHERE device_id = $1`, [deviceId]);
  return rows[0] ? toRecord(rows[0]) : null;
}

export async function listDevices(filter: {
  userId?: string;
  appId?: string;
}): Promise<DeviceTokenRecord[]> {
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (filter.userId) {
    params.push(filter.userId);
    conditions.push(`user_id = $${params.length}`);
  }
  if (filter.appId) {
    params.push(filter.appId);
    conditions.push(`app_id = $${params.length}`);
  }
  const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';
  const rows = await query<DeviceRow>(
    `${SELECT_DEVICES}${where} ORDER BY created_at DESC LIMIT 500`,
    params
  );
  return rows.map(toRecord);
}

export async function createDevice(params: {
  deviceId: string;
  userId: string;
  appId: string;
  fcmToken: string;
  platform: ClientPlatform;
  userAgent: string;
}): Promise<DeviceTokenRecord> {
  const rows = await query<{ device_id: string }>(
    `INSERT INTO device_tokens (device_id, user_id, app_id, fcm_token, platform, user_agent)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (device_id) DO UPDATE SET
       fcm_token = EXCLUDED.fcm_token,
       platform = EXCLUDED.platform,
       user_agent = EXCLUDED.user_agent,
       status = 'active',
       last_refreshed_at = NOW(),
       updated_at = NOW()
     RETURNING device_id`,
    [params.deviceId, params.userId, params.appId, params.fcmToken, params.platform, params.userAgent]
  );
  const device = await getDevice(rows[0].device_id);
  if (!device) throw new Error('DEVICE_INSERT_FAILED');
  return device;
}

export async function markDeviceStatus(
  deviceId: string,
  status: 'active' | 'revoked' | 'expired'
): Promise<DeviceTokenRecord | null> {
  const rows = await query<{ device_id: string }>(
    'UPDATE device_tokens SET status = $2, updated_at = NOW() WHERE device_id = $1 RETURNING device_id',
    [deviceId, status]
  );
  if (rows.length === 0) return null;
  return getDevice(deviceId);
}

export async function countActiveDevices(): Promise<number> {
  const rows = await query<{ count: string }>(
    "SELECT COUNT(*) AS count FROM device_tokens WHERE status = 'active'"
  );
  return Number(rows[0]?.count || 0);
}

export async function countAllDevices(): Promise<number> {
  const rows = await query<{ count: string }>('SELECT COUNT(*) AS count FROM device_tokens');
  return Number(rows[0]?.count || 0);
}
