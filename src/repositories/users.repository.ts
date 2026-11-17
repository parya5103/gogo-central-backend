/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Users repository — PostgreSQL data access for Firebase-UID-keyed user
 * records. The Firebase UID is the canonical database user identifier.
 * Roles are read from trusted server-side rows; clients can never write them.
 */

import { query } from '../db/pool.ts';
import type { CentralUserRecord } from '../types/gogo.ts';

interface UserRow {
  uid: string;
  display_name: string;
  role: string;
  email_masked: string;
  email_verified: boolean;
  auth_provider: string;
  timezone: string | null;
  created_at: Date;
  updated_at: Date;
  connected_apps: string[] | null;
}

function toRecord(row: UserRow): CentralUserRecord {
  return {
    uid: row.uid,
    displayName: row.display_name,
    emailMasked: row.email_masked,
    role: row.role === 'admin' ? 'admin' : 'user',
    emailVerified: Boolean(row.email_verified),
    connectedApps: (row.connected_apps ?? []).filter((a): a is string => typeof a === 'string'),
    authProvider:
      row.auth_provider === 'password' || row.auth_provider === 'anonymous_guest'
        ? row.auth_provider
        : 'google.com',
    firestoreGameSavePreserved: true,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

const SELECT_WITH_APPS = `
  SELECT u.uid, u.display_name, u.role, u.email_masked, u.email_verified, u.auth_provider,
         u.timezone, u.created_at, u.updated_at,
         COALESCE(
           (SELECT array_agg(r.app_id ORDER BY r.app_id)
            FROM user_app_roles r WHERE r.user_id = u.uid),
           '{}'
         ) AS connected_apps
  FROM users u
`;

export async function getUser(uid: string): Promise<CentralUserRecord | null> {
  const rows = await query<UserRow>(`${SELECT_WITH_APPS} WHERE u.uid = $1`, [uid]);
  return rows[0] ? toRecord(rows[0]) : null;
}

export async function hasUser(uid: string): Promise<boolean> {
  const rows = await query<{ exists: boolean }>(
    'SELECT EXISTS (SELECT 1 FROM users WHERE uid = $1) AS exists',
    [uid]
  );
  return Boolean(rows[0]?.exists);
}

/**
 * Insert-or-refresh a user from a verified Firebase ID token. For new rows the
 * role comes from the server-computed bootstrap decision (root-admin verified
 * email) — never from client input. Existing rows always keep their
 * server-side role.
 */
export async function upsertUserFromFirebase(params: {
  uid: string;
  displayName: string;
  emailMasked: string;
  emailVerified: boolean;
  authProvider: 'google.com' | 'password' | 'anonymous_guest';
  role: 'user' | 'admin';
}): Promise<void> {
  await query(
    `INSERT INTO users (uid, display_name, role, email_masked, email_verified, auth_provider)
     VALUES ($1, $2, $6, $3, $4, $5)
     ON CONFLICT (uid) DO UPDATE SET
       display_name = EXCLUDED.display_name,
       email_masked = EXCLUDED.email_masked,
       email_verified = EXCLUDED.email_verified,
       auth_provider = EXCLUDED.auth_provider,
       updated_at = NOW()`,
    [params.uid, params.displayName, params.emailMasked, params.emailVerified, params.authProvider, params.role]
  );
}

/**
 * Ensure a least-privilege database principal exists for trusted GitHub Actions
 * automation. notification_campaigns.author_id has a FK to users(uid), so
 * workflow campaigns must use a real row rather than an unregistered identity.
 * This principal is deliberately non-admin and cannot authenticate as a user.
 */
export async function ensureGitHubActionsServiceUser(): Promise<void> {
  await query(
    `INSERT INTO users
       (uid, display_name, role, email_masked, email_verified, auth_provider, is_active)
     VALUES
       ('system:github-actions', 'GitHub Actions automation', 'user',
        'automation@system.invalid', FALSE, 'anonymous_guest', TRUE)
     ON CONFLICT (uid) DO UPDATE SET
       display_name = EXCLUDED.display_name,
       role = 'user',
       email_masked = EXCLUDED.email_masked,
       email_verified = FALSE,
       auth_provider = 'anonymous_guest',
       is_active = TRUE,
       updated_at = NOW()`
  );
}

/** Records the app a user connected to (used for connectedApps + counts). */
export async function recordUserAppAccess(uid: string, appId: string): Promise<void> {
  await query(
    `INSERT INTO user_app_roles (user_id, app_id, app_role)
     VALUES ($1, $2, 'member')
     ON CONFLICT DO NOTHING`,
    [uid, appId]
  );
  await query(
    'UPDATE user_app_roles SET last_seen_at = NOW() WHERE user_id = $1 AND app_id = $2',
    [uid, appId]
  );
}

export async function isAdminUid(uid: string): Promise<boolean> {
  const rows = await query<{ exists: boolean }>(
    "SELECT EXISTS (SELECT 1 FROM users WHERE uid = $1 AND role = 'admin' AND is_active) AS exists",
    [uid]
  );
  return Boolean(rows[0]?.exists);
}

export async function listUsers(limit = 500): Promise<CentralUserRecord[]> {
  const rows = await query<UserRow>(`${SELECT_WITH_APPS} ORDER BY u.created_at DESC LIMIT ${Math.min(Math.max(limit, 1), 1000)}`);
  return rows.map(toRecord);
}

export async function countUsers(): Promise<number> {
  const rows = await query<{ count: string }>('SELECT COUNT(*) AS count FROM users');
  return Number(rows[0]?.count || 0);
}

/** Sets a validated IANA timezone for a user (quiet-hours computation). */
export async function setUserTimezone(uid: string, timeZone: string): Promise<void> {
  await query('UPDATE users SET timezone = $2, updated_at = NOW() WHERE uid = $1', [
    uid,
    timeZone,
  ]);
}

export async function getUserTimezone(uid: string): Promise<string | null> {
  const rows = await query<{ timezone: string | null }>(
    'SELECT timezone FROM users WHERE uid = $1',
    [uid]
  );
  return rows[0]?.timezone ?? null;
}
