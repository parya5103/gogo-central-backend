/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Notification preferences repository. pref_id is the canonical
 * `${userId}_${appId}` composite used by the in-memory engine, so API
 * responses keep the same identifiers in both persistence modes.
 */

import { query } from '../db/pool.ts';
import type { NotificationPreferenceRecord } from '../types/gogo.ts';

interface PrefRow {
  pref_id: string;
  user_id: string;
  app_id: string;
  enabled: boolean;
  web_push: boolean;
  android_push: boolean;
  marketing_alerts: boolean;
  transactional_alerts: boolean;
  quiet_hours_start: string;
  quiet_hours_end: string;
  created_at: Date;
  updated_at: Date;
}

function toRecord(row: PrefRow): NotificationPreferenceRecord {
  return {
    prefId: row.pref_id,
    userId: row.user_id,
    appId: row.app_id,
    enabled: row.enabled,
    webPush: row.web_push,
    androidPush: row.android_push,
    marketingAlerts: row.marketing_alerts,
    transactionalAlerts: row.transactional_alerts,
    quietHoursStart: row.quiet_hours_start,
    quietHoursEnd: row.quiet_hours_end,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

const SELECT_PREFS = `SELECT pref_id, user_id, app_id, enabled, web_push, android_push,
  marketing_alerts, transactional_alerts, quiet_hours_start, quiet_hours_end,
  created_at, updated_at FROM notification_preferences`;

/** Canonical composite key: `${userId}_${appId}` (same id as the engine mode). */
function prefId(userId: string, appId: string): string {
  return `${userId}_${appId}`;
}

export async function getPreference(
  userId: string,
  appId: string
): Promise<NotificationPreferenceRecord | null> {
  const rows = await query<PrefRow>(
    `${SELECT_PREFS} WHERE user_id = $1 AND app_id = $2`,
    [userId, appId]
  );
  return rows[0] ? toRecord(rows[0]) : null;
}

export async function listPreferences(userId: string): Promise<NotificationPreferenceRecord[]> {
  const rows = await query<PrefRow>(`${SELECT_PREFS} WHERE user_id = $1 ORDER BY app_id`, [userId]);
  return rows.map(toRecord);
}

export async function listAllPreferences(limit = 500): Promise<NotificationPreferenceRecord[]> {
  const rows = await query<PrefRow>(
    `${SELECT_PREFS} ORDER BY user_id, app_id LIMIT ${Math.min(Math.max(limit, 1), 1000)}`
  );
  return rows.map(toRecord);
}

export interface PreferencePatch {
  enabled: boolean;
  webPush: boolean;
  androidPush: boolean;
  marketingAlerts: boolean;
  transactionalAlerts: boolean;
  quietHoursStart: string;
  quietHoursEnd: string;
}

export async function upsertPreference(
  userId: string,
  appId: string,
  patch: PreferencePatch
): Promise<NotificationPreferenceRecord> {
  const rows = await query<{ pref_id: string }>(
    `INSERT INTO notification_preferences
       (pref_id, user_id, app_id, enabled, web_push, android_push, marketing_alerts,
        transactional_alerts, quiet_hours_start, quiet_hours_end)
     VALUES ($10, $1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (user_id, app_id) DO UPDATE SET
       enabled = EXCLUDED.enabled,
       web_push = EXCLUDED.web_push,
       android_push = EXCLUDED.android_push,
       marketing_alerts = EXCLUDED.marketing_alerts,
       transactional_alerts = EXCLUDED.transactional_alerts,
       quiet_hours_start = EXCLUDED.quiet_hours_start,
       quiet_hours_end = EXCLUDED.quiet_hours_end,
       updated_at = NOW()
     RETURNING pref_id`,
    [
      userId,
      appId,
      patch.enabled,
      patch.webPush,
      patch.androidPush,
      patch.marketingAlerts,
      patch.transactionalAlerts,
      patch.quietHoursStart,
      patch.quietHoursEnd,
      prefId(userId, appId),
    ]
  );
  const pref = await getPreference(userId, appId);
  if (!pref) throw new Error('PREFERENCE_UPSERT_FAILED');
  return pref;
}
