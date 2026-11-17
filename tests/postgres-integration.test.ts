/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * GoGo Central Backend — PostgreSQL Integration Tests (PGT-01..PGT-23)
 *
 * REAL database tests, no mocks and no SQLite substitutes. Runs against a
 * disposable PostgreSQL instance configured via SQL_* environment variables
 * (the CI workflow provides a postgres service container; locally use
 * `docker compose up -d postgres`).
 *
 * Safety:
 * - NEVER point SQL_* at production: tests write synthetic rows with
 *   `pgt_<run>` prefixed identifiers.
 * - All assertions are honest: a FAIL exits non-zero and fails CI.
 */

import { Pool } from 'pg';
import { runMigrations, listAppliedMigrations } from '../src/db/migrate.ts';
import {
  query,
  checkDatabaseHealth,
  closePool,
  mapPgError,
} from '../src/db/pool.ts';
import { upsertUserFromFirebase, getUser, hasUser, recordUserAppAccess, setUserTimezone, ensureGitHubActionsServiceUser } from '../src/repositories/users.repository.ts';
import { createDevice, getDevice } from '../src/repositories/devices.repository.ts';
import { upsertPreference, getPreference, listPreferences } from '../src/repositories/preferences.repository.ts';
import {
  insertCampaignIfAbsent,
  getCampaignByIdempotencyKey,
  claimCampaign,
  claimDueCampaigns,
  reclaimStaleProcessing,
  finalizeCampaign,
  getCampaign,
} from '../src/repositories/campaigns.repository.ts';
import { insertDeliveryReceipt } from '../src/repositories/deliveries.repository.ts';
import { updateSystemConfig, getNumberConfig } from '../src/repositories/config.repository.ts';
import { createApp } from '../src/repositories/apps.repository.ts';
import { PostgresDataStore } from '../src/server/postgres-store.ts';
import { PostgresRateLimitStore } from '../src/server/rate-limit-pg.ts';
import { NotificationWorker } from '../src/server/notification-worker.ts';
import { isInQuietHours, isValidIANATimezone } from '../src/server/campaign-rules.ts';
import { mapFirebaseSignInProvider } from '../src/server/auth-provider.ts';
import { setTestFirebaseOverrides } from '../src/lib/firebase-admin.ts';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const RUN = `pgt_${Date.now().toString(36)}`;
const TEST_APP = 'sarkari-sarthi'; // seeded by migration 001
const DEEPLINK = 'https://gogocompany.in/sarkari-sarthi/';

interface TestResult {
  id: string;
  name: string;
  status: 'PASS' | 'FAIL';
  error?: string;
}

const results: TestResult[] = [];

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(`ASSERTION_FAILED: ${message}`);
}

function assertEqual(actual: unknown, expected: unknown, message: string): void {
  if (actual !== expected) {
    throw new Error(`ASSERTION_FAILED: ${message} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  }
}

async function test(id: string, name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    results.push({ id, name, status: 'PASS' });
    console.log(`[PASS] ${id}: ${name}`);
  } catch (error) {
    const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    results.push({ id, name, status: 'FAIL', error: detail });
    console.error(`[FAIL] ${id}: ${name}\n        ${detail}`);
  }
}

function hourIn(timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    hour12: false,
  }).format(new Date());
  return Number(parts);
}

function hh(hour: number): string {
  return String(((hour % 24) + 24) % 24).padStart(2, '0');
}

/**
 * Isolation helper: each delivery-path test registers its own throwaway app
 * so broadcasts reach only that test's device (no cross-test device leakage
 * from PGT-05/PGT-12 fixtures).
 */
async function isolateApp(slot: string): Promise<string> {
  const appId = `${RUN}_app_${slot}`;
  const app = await createApp({
    appId,
    name: `PGT ${slot}`,
    domain: 'https://gogocompany.in/',
    category: 'news',
    fcmEnabled: true,
    webPushEnabled: true,
    androidEnabled: true,
    rateLimitPerMin: 60,
  });
  if (app === null) throw new Error(`APP_CREATE_FAILED: ${appId}`);
  return appId;
}

async function main(): Promise<void> {
  const store = new PostgresDataStore();
  const worker = new NotificationWorker('pgt_worker');

  // Fresh CI databases start empty; on a reused disposable DB migrations are
  // skipped, which PGT-02 also proves. Both paths are valid PASS states.

  await test('PGT-01', 'Fresh migration applies 001 + 002 with checksum tracking (advisory-lock serialized)', async () => {
    // Two concurrent runners must serialize on the advisory lock: each
    // migration is applied at most once, the second runner skips what the
    // first applied, and neither corrupts schema_migrations.
    const [reportA, reportB] = await Promise.all([runMigrations(), runMigrations()]);
    const applied = await listAppliedMigrations();
    assertEqual(applied.length, 2, 'both migrations tracked in schema_migrations');
    assert(applied.some((m) => m.version === '001'), '001 recorded');
    assert(applied.some((m) => m.version === '002'), '002 recorded');
    assert(
      applied.every((m) => /^[a-f0-9]{64}$/.test(m.checksum)),
      'checksums are sha256 hex'
    );
    for (const version of ['001', '002']) {
      const appliedCount = [reportA, reportB].filter((r) => r.applied.includes(version)).length;
      const skippedCount = [reportA, reportB].filter((r) => r.skipped.includes(version)).length;
      assertEqual(
        appliedCount + skippedCount,
        2,
        `advisory lock serialized the concurrent runners for ${version}`
      );
      assert(appliedCount <= 1, `${version} applied at most once across concurrent runners`);
    }
  });

  await test('PGT-02', 'Repeated migration is a safe no-op (idempotent runner)', async () => {
    const report = await runMigrations();
    assertEqual(report.applied.length, 0, 'nothing re-applied');
    assert(report.skipped.length === 2, 'both known migrations skipped');
    const applied = await listAppliedMigrations();
    assertEqual(applied.length, 2, 'still exactly two tracked migrations');
  });

  await test('PGT-03', 'Connection failure is detected, sanitized, and mapped', async () => {
    const bad = new Pool({
      host: '127.0.0.1',
      port: 1, // nothing listens here
      database: 'gogo_central',
      user: 'gogo_app_user',
      password: 'ci_must_not_leak_password',
      max: 1,
      connectionTimeoutMillis: 1500,
    });
    let rawError: unknown = null;
    try {
      await bad.query('SELECT 1');
    } catch (error) {
      rawError = error;
    }
    await bad.end().catch(() => undefined);
    assert(rawError !== null, 'unreachable database rejected the connection');
    const mapped = mapPgError(rawError);
    assertEqual(mapped.name, 'DatabaseUnavailableError', 'mapped to DatabaseUnavailableError');
    const rawText = rawError instanceof Error ? rawError.message : String(rawError);
    assert(
      !rawText.includes('ci_must_not_leak_password'),
      'error text must not contain credentials'
    );
  });

  // Author user required before any campaign insert (FK author_id → users).
  const authorUid = `${RUN}_author`;
  await test('PGT-04', 'User persistence with Firebase profile fields + app access', async () => {
    await upsertUserFromFirebase({
      uid: authorUid,
      displayName: 'PG Author',
      emailMasked: 'pg****@test.dev',
      emailVerified: true,
      authProvider: 'google.com',
      role: 'admin',
    });
    await recordUserAppAccess(authorUid, TEST_APP);
    const user = await getUser(authorUid);
    assert(user !== null, 'user readable');
    assertEqual(user!.displayName, 'PG Author', 'displayName persisted');
    assertEqual(user!.emailMasked, 'pg****@test.dev', 'emailMasked persisted');
    assertEqual(user!.emailVerified, true, 'emailVerified persisted');
    assertEqual(user!.authProvider, 'google.com', 'authProvider persisted');
    assertEqual(user!.role, 'admin', 'role persisted');
    assert(user!.connectedApps.includes(TEST_APP), 'user_app_roles derived connectedApps');
    assertEqual(await hasUser(authorUid), true, 'hasUser true');

    // Upsert must not overwrite the server-assigned role with a client hint.
    await upsertUserFromFirebase({
      uid: authorUid,
      displayName: 'PG Author v2',
      emailMasked: 'pg****@test.dev',
      emailVerified: true,
      authProvider: 'google.com',
      role: 'user', // privilege downgrade attempt — must be ignored
    });
    const after = await getUser(authorUid);
    assertEqual(after!.role, 'admin', 'existing role preserved on upsert (no self-escalation via sync)');
  });

  const deviceId = `${RUN}_dev_01`;
  await test('PGT-05', 'Device token persistence + FK violation on ghost user', async () => {
    const device = await createDevice({
      deviceId,
      userId: authorUid,
      appId: TEST_APP,
      fcmToken: 'fcm_ci_demo_token_01',
      platform: 'android',
      userAgent: 'pgt-agent',
    });
    assertEqual(device.status, 'active', 'device active');
    const read = await getDevice(deviceId);
    assert(read !== null, 'device readable');
    assertEqual(read!.fcmToken, 'fcm_ci_demo_token_01', 'fcm token persisted');

    let fkError: unknown = null;
    try {
      await createDevice({
        deviceId: `${RUN}_dev_ghost`,
        userId: `${RUN}_ghost_user`, // does not exist
        appId: TEST_APP,
        fcmToken: 'fcm_ci_demo_token_02',
        platform: 'web',
        userAgent: 'pgt-agent',
      });
    } catch (error) {
      fkError = error;
    }
    assert(fkError !== null, 'device insert with ghost user rejected');
    assertEqual(
      (fkError as { code?: string }).code,
      '23503',
      'PostgreSQL foreign key violation (23503)'
    );
  });

  await test('PGT-06', 'Preference persistence is unique per (user, app) and patchable', async () => {
    const patch = {
      enabled: true,
      webPush: true,
      androidPush: true,
      marketingAlerts: false,
      transactionalAlerts: true,
      quietHoursStart: '22:00',
      quietHoursEnd: '06:00',
    };
    await upsertPreference(authorUid, TEST_APP, patch);
    const second = { ...patch, marketingAlerts: true };
    await upsertPreference(authorUid, TEST_APP, second);
    const prefs = await listPreferences(authorUid);
    assertEqual(prefs.length, 1, 'exactly one preference row per (user, app)');
    const pref = await getPreference(authorUid, TEST_APP);
    assert(pref !== null, 'preference readable');
    assertEqual(pref!.marketingAlerts, true, 'second upsert patched the row');
    assertEqual(pref!.quietHoursStart, '22:00', 'quiet hours persisted');
  });

  const idemKey = `${RUN}_idem_01`;
  await test('PGT-07', 'Idempotency: duplicate key replays the original campaign', async () => {
    const payloadHash = 'a'.repeat(64);
    const first = await insertCampaignIfAbsent({
      notificationId: `${RUN}_notif_01`,
      idempotencyKey: idemKey,
      appId: TEST_APP,
      targetType: 'individual',
      targetValue: authorUid,
      platform: 'all',
      title: 'PGT-07 title',
      body: 'PGT-07 body',
      deepLink: DEEPLINK,
      scheduledFor: null,
      authorId: authorUid,
      payloadHash,
    });
    assert(first !== null, 'first insert created the campaign');
    const dup = await insertCampaignIfAbsent({
      notificationId: `${RUN}_notif_01_dup`,
      idempotencyKey: idemKey,
      appId: TEST_APP,
      targetType: 'individual',
      targetValue: authorUid,
      platform: 'all',
      title: 'PGT-07 title',
      body: 'PGT-07 body',
      deepLink: DEEPLINK,
      scheduledFor: null,
      authorId: authorUid,
      payloadHash,
    });
    assertEqual(dup, null, 'duplicate key insert returned null (no second campaign)');
    const replay = await getCampaignByIdempotencyKey(idemKey);
    assert(replay !== null, 'key resolves to original campaign');
    assertEqual(replay!.campaign.notificationId, `${RUN}_notif_01`, 'original notification id');
    assertEqual(replay!.payloadHash, payloadHash, 'payload hash stored');
  });

  await test('PGT-08', 'Idempotency: same key with different payload → 409 conflict error', async () => {
    let mismatch: string | null = null;
    try {
      await store.dispatchNotification({
        idempotencyKey: idemKey, // already used in PGT-07
        appId: TEST_APP,
        targetType: 'individual',
        targetValue: authorUid,
        platform: 'all',
        title: 'DIFFERENT TITLE',
        body: 'different payload',
        deepLink: DEEPLINK,
        scheduledFor: null,
        authorId: authorUid,
      });
    } catch (error) {
      mismatch = error instanceof Error ? error.message : String(error);
    }
    assert(mismatch !== null, 'payload mismatch rejected');
    assert(
      mismatch!.includes('IDEMPOTENCY_PAYLOAD_MISMATCH'),
      'error code is IDEMPOTENCY_PAYLOAD_MISMATCH (maps to HTTP 409)'
    );
  });

  await test('PGT-09', 'Concurrent duplicate inserts: exactly one campaign wins', async () => {
    const key = `${RUN}_idem_race`;
    const attempts = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        insertCampaignIfAbsent({
          notificationId: `${RUN}_notif_race_${i}`,
          idempotencyKey: key,
          appId: TEST_APP,
          targetType: 'individual',
          targetValue: authorUid,
          platform: 'all',
          title: 'PGT-09',
          body: 'race',
          deepLink: DEEPLINK,
          scheduledFor: null,
          authorId: authorUid,
          payloadHash: 'b'.repeat(64),
        })
      )
    );
    const winners = attempts.filter((c) => c !== null);
    assertEqual(winners.length, 1, 'exactly one concurrent insert won (atomic reservation)');
    const total = await query<{ count: string }>(
      'SELECT COUNT(*) AS count FROM notification_campaigns WHERE idempotency_key = $1',
      [key]
    );
    assertEqual(Number(total[0].count), 1, 'database holds exactly one campaign for the key');
  });

  await test('PGT-10', 'FOR UPDATE SKIP LOCKED: concurrent workers claim disjoint campaigns', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      const c = await insertCampaignIfAbsent({
        notificationId: `${RUN}_notif_skip_${i}`,
        idempotencyKey: `${RUN}_skip_${i}`,
        appId: TEST_APP,
        targetType: 'individual',
        targetValue: authorUid,
        platform: 'all',
        title: 'PGT-10',
        body: 'skip locked',
        deepLink: DEEPLINK,
        scheduledFor: null,
        authorId: authorUid,
        payloadHash: 'c'.repeat(64),
      });
      if (c) ids.push(c.notificationId);
    }
    assertEqual(ids.length, 6, 'six queued campaigns inserted');
    const [claimA, claimB] = await Promise.all([
      claimDueCampaigns(3, 'worker_a'),
      claimDueCampaigns(3, 'worker_b'),
    ]);
    const all = [...claimA, ...claimB];
    const unique = new Set(all.map((c) => c.notificationId));
    assertEqual(claimA.length, 3, 'worker A claimed 3');
    assertEqual(claimB.length, 3, 'worker B claimed 3');
    assertEqual(unique.size, 6, 'claims are disjoint — no campaign claimed twice');
    // Leave the queue clean for later tests.
    for (const c of all) {
      await finalizeCampaign(c.notificationId, { status: 'delivered', sentCount: 0, failedCount: 0 });
    }
  });

  await test('PGT-11', 'Interrupted processing recovery: stale processing claims are reclaimed', async () => {
    const c = await insertCampaignIfAbsent({
      notificationId: `${RUN}_notif_crash`,
      idempotencyKey: `${RUN}_crash_key`,
      appId: TEST_APP,
      targetType: 'individual',
      targetValue: authorUid,
      platform: 'all',
      title: 'PGT-11',
      body: 'crash',
      deepLink: DEEPLINK,
      scheduledFor: null,
      authorId: authorUid,
      payloadHash: 'd'.repeat(64),
    });
    assert(c !== null, 'campaign inserted');
    const claimed = await claimCampaign(c!.notificationId, 'crashed_worker');
    assert(claimed !== null, 'campaign claimed (status processing)');
    // Simulate the worker dying mid-processing: lock is now stale.
    await query(
      `UPDATE notification_campaigns SET processing_locked_at = NOW() - interval '10 minutes' WHERE notification_id = $1`,
      [c!.notificationId]
    );
    const reclaimed = await reclaimStaleProcessing(5);
    assert(reclaimed.includes(c!.notificationId), 'stale claim reclaimed to queued');
    const after = await getCampaign(c!.notificationId);
    assertEqual(after!.status, 'queued', 'campaign is queued again and processable');
    await worker.processCampaign(c!.notificationId);
  });

  await test('PGT-12', 'Retry limits: transient → permanent → MAX_RETRIES_EXCEEDED', async () => {
    // Bounded to 1 retry for determinism; restored afterwards.
    await updateSystemConfig('fcm_max_retries', '1', 'pgt-runner');
    const uid = `${RUN}_retryuser`;
    await upsertUserFromFirebase({
      uid,
      displayName: 'PG Retry',
      emailMasked: 'pr****@test.dev',
      emailVerified: true,
      authProvider: 'password',
      role: 'user',
    });
    await createDevice({
      deviceId: `${RUN}_dev_retry`,
      userId: uid,
      appId: TEST_APP,
      // Real-format token: without live FCM credentials the SDK send fails,
      // which the worker records honestly as a transient failure.
      fcmToken: 'ci-real-token-without-credentials',
      platform: 'android',
      userAgent: 'pgt-agent',
    });
    const c = await insertCampaignIfAbsent({
      notificationId: `${RUN}_notif_retry`,
      idempotencyKey: `${RUN}_retry_key`,
      appId: TEST_APP,
      targetType: 'individual',
      targetValue: uid,
      platform: 'all',
      title: 'PGT-12',
      body: 'retry',
      deepLink: DEEPLINK,
      scheduledFor: null,
      authorId: authorUid,
      payloadHash: 'e'.repeat(64),
    });
    assert(c !== null, 'campaign inserted');
    await insertDeliveryReceipt({
      deliveryId: `${RUN}_del_retry`,
      notificationId: c!.notificationId,
      deviceId: `${RUN}_dev_retry`,
      userId: uid,
      appId: TEST_APP,
      platform: 'android',
      status: 'failed_transient',
      attemptCount: 1,
      fcmMessageId: null,
      errorCode: 'messaging/transport-unavailable',
      skipReason: null,
    });

    const firstRetry = await worker.retryFailedCampaign(c!.notificationId, authorUid);
    assert(!firstRetry.error?.includes('MAX_RETRIES'), 'first retry within bounds');
    const firstDeliveries = await query<{ status: string }>(
      'SELECT status FROM notification_deliveries WHERE notification_id = $1',
      [c!.notificationId]
    );
    assertEqual(
      firstDeliveries[0]?.status,
      'failed_permanent',
      'delivery escalated to failed_permanent at the retry cap'
    );

    const secondRetry = await worker.retryFailedCampaign(c!.notificationId, authorUid);
    assert(
      secondRetry.error?.includes('MAX_RETRIES_EXCEEDED'),
      'second retry refused with MAX_RETRIES_EXCEEDED'
    );
    // Restore the production default.
    await updateSystemConfig('fcm_max_retries', '3', 'pgt-runner');
    assertEqual(await getNumberConfig('fcm_max_retries', 3), 3, 'fcm_max_retries restored to 3');
  });

  await test('PGT-13', 'Marketing opt-out: broadcast never bypasses preferences', async () => {
    const appId = await isolateApp('optout');
    const uid = `${RUN}_optout`;
    await store.syncUser(uid, {
      displayName: 'PG OptOut',
      emailMasked: 'po****@test.dev',
      emailVerified: true,
      authProvider: 'password',
      role: 'user',
    });
    await store.createDevice({
      deviceId: `${RUN}_dev_optout`,
      userId: uid,
      appId,
      fcmToken: 'fcm_ci_demo_optout',
      platform: 'android',
      userAgent: 'pgt-agent',
    });
    await store.upsertPreference(uid, appId, {
      enabled: true,
      webPush: true,
      androidPush: true,
      marketingAlerts: false, // opted out
      transactionalAlerts: true,
      quietHoursStart: '22:00',
      quietHoursEnd: '06:00',
    });
    const result = await store.dispatchNotification({
      idempotencyKey: `${RUN}_optout_key`,
      appId,
      targetType: 'broadcast', // marketing
      targetValue: 'all-users',
      platform: 'all',
      title: 'PGT-13 marketing',
      body: 'must be skipped',
      deepLink: DEEPLINK,
      scheduledFor: null,
      authorId: authorUid,
    });
    assertEqual(result.campaign.status, 'delivered', 'campaign completed');
    assertEqual(result.campaign.sentCount, 0, 'nothing sent (honest count)');
    assertEqual(result.deliveriesCreated.length, 1, 'one receipt written');
    assertEqual(
      result.deliveriesCreated[0]?.status,
      'skipped_preference',
      'receipt recorded as skipped_preference'
    );
    assertEqual(
      result.deliveriesCreated[0]?.errorCode,
      'user-marketing-opt-out',
      'skip reason stored in errorCode (API contract parity)'
    );
  });

  await test('PGT-14', 'Quiet hours enforced in the user timezone (Asia/Kolkata)', async () => {
    const appId = await isolateApp('quiet');
    const uid = `${RUN}_quiet`;
    await store.syncUser(uid, {
      displayName: 'PG Quiet',
      emailMasked: 'pq****@test.dev',
      emailVerified: true,
      authProvider: 'password',
      role: 'user',
    });
    await store.createDevice({
      deviceId: `${RUN}_dev_quiet`,
      userId: uid,
      appId,
      fcmToken: 'fcm_ci_demo_quiet',
      platform: 'android',
      userAgent: 'pgt-agent',
    });
    await setUserTimezone(uid, 'Asia/Kolkata');
    await store.upsertPreference(uid, appId, {
      enabled: true,
      webPush: true,
      androidPush: true,
      marketingAlerts: true,
      transactionalAlerts: true,
      // Deterministic window covering the current Kolkata hour (+2h buffer).
      quietHoursStart: `${hh(hourIn('Asia/Kolkata'))}:00`,
      quietHoursEnd: `${hh(hourIn('Asia/Kolkata') + 2)}:00`,
    });
    const result = await store.dispatchNotification({
      idempotencyKey: `${RUN}_quiet_key`,
      appId,
      targetType: 'broadcast',
      targetValue: 'all-users',
      platform: 'all',
      title: 'PGT-14 marketing',
      body: 'quiet hours',
      deepLink: DEEPLINK,
      scheduledFor: null,
      authorId: authorUid,
    });
    assertEqual(result.campaign.sentCount, 0, 'nothing sent during quiet hours');
    assertEqual(
      result.deliveriesCreated[0]?.status,
      'skipped_quiet_hours',
      'receipt recorded as skipped_quiet_hours'
    );
  });

  await test('PGT-15', 'Timezone handling: same quiet window, different IANA zones, different outcome', async () => {
    const savedDryRun = process.env.FCM_DRY_RUN;
    process.env.FCM_DRY_RUN = 'false';
    assertEqual(isValidIANATimezone('Asia/Kolkata'), true, 'valid IANA zone accepted');
    assertEqual(isValidIANATimezone('Mars/Olympus_Mons'), false, 'invalid IANA zone rejected');

    const appId = await isolateApp('tz');
    const uid = `${RUN}_tz`;
    await store.syncUser(uid, {
      displayName: 'PG TZ',
      emailMasked: 'pt****@test.dev',
      emailVerified: true,
      authProvider: 'password',
      role: 'user',
    });
    await store.createDevice({
      deviceId: `${RUN}_dev_tz`,
      userId: uid,
      appId,
      fcmToken: `${RUN}_real_fcm_registration_token_${'x'.repeat(120)}`,
      platform: 'android',
      userAgent: 'pgt-agent',
    });
    // MOCKED FCM: the timezone assertion must test quiet-hours logic, not a
    // demo-token shortcut. A successful receipt here is explicitly test-only.
    try {
      setTestFirebaseOverrides({
        sendEachForMulticast: async () => ({
          responses: [{ success: true, messageId: 'projects/test/messages/PGT15_KOLKATA' }],
        }),
      });
      const kiriHour = hourIn('Pacific/Kiritimati'); // UTC+14
    const kolkataHour = hourIn('Asia/Kolkata'); // UTC+5:30 — never equal to kiriHour
    assert(kiriHour !== kolkataHour, 'sanity: zone hours differ');

    await setUserTimezone(uid, 'Pacific/Kiritimati');
    await store.upsertPreference(uid, appId, {
      enabled: true,
      webPush: true,
      androidPush: true,
      marketingAlerts: true,
      transactionalAlerts: true,
      quietHoursStart: `${hh(kiriHour)}:00`,
      quietHoursEnd: `${hh(kiriHour + 1)}:00`,
    });
    const inKiritimati = await store.dispatchNotification({
      idempotencyKey: `${RUN}_tz_kiri`,
      appId,
      targetType: 'broadcast',
      targetValue: 'all-users',
      platform: 'all',
      title: 'PGT-15 kiri',
      body: 'tz test',
      deepLink: DEEPLINK,
      scheduledFor: null,
      authorId: authorUid,
    });
    assertEqual(
      inKiritimati.deliveriesCreated[0]?.status,
      'skipped_quiet_hours',
      'user in Kiritimati is inside their quiet window'
    );

    // Same wall-clock window, but the user is actually in Kolkata.
    await setUserTimezone(uid, 'Asia/Kolkata');
    const inKolkata = await store.dispatchNotification({
      idempotencyKey: `${RUN}_tz_ist`,
      appId,
      targetType: 'broadcast',
      targetValue: 'all-users',
      platform: 'all',
      title: 'PGT-15 ist',
      body: 'tz test',
      deepLink: DEEPLINK,
      scheduledFor: null,
      authorId: authorUid,
    });
    assertEqual(
      inKolkata.deliveriesCreated[0]?.status,
      'delivered',
      'same window is not quiet hours in Kolkata — UTC is never silently assumed'
    );
      assertEqual(isInQuietHours(new Date(), '23:00', '01:00', null), false, 'null timezone → no enforcement (documented)');
    } finally {
      setTestFirebaseOverrides({});
      if (savedDryRun === undefined) delete process.env.FCM_DRY_RUN;
      else process.env.FCM_DRY_RUN = savedDryRun;
    }
  });

  await test('PGT-16', 'SQL injection payloads are stored as data, never executed', async () => {
    const evilUid = `${RUN}_inj'); DROP TABLE users;--`;
    await upsertUserFromFirebase({
      uid: evilUid,
      displayName: "Robert'); --",
      emailMasked: 'x****@test.dev',
      emailVerified: false,
      authProvider: 'anonymous_guest',
      role: 'user',
    });
    const stored = await getUser(evilUid);
    assert(stored !== null, 'injection uid stored verbatim as a parameter');
    assertEqual(stored!.displayName, "Robert'); --", 'injection in name stored as data');
    const tables = await query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'users'"
    );
    assertEqual(tables.length, 1, 'users table still exists (no DROP executed)');
    const usersCount = await query<{ count: string }>('SELECT COUNT(*) AS count FROM users WHERE uid LIKE $1', [`${RUN}%`]);
    assert(Number(usersCount[0].count) >= 4, 'parameterized LIKE is safe');
  });

  await test('PGT-17', 'Delivery receipts: FK integrity + idempotent (notification × device) uniqueness', async () => {
    let fkError: unknown = null;
    try {
      await insertDeliveryReceipt({
        deliveryId: `${RUN}_del_ghost`,
        notificationId: `${RUN}_ghost_campaign`, // does not exist
        deviceId,
        userId: authorUid,
        appId: TEST_APP,
        platform: 'android',
        status: 'delivered',
        attemptCount: 1,
        fcmMessageId: null,
        errorCode: null,
        skipReason: null,
      });
    } catch (error) {
      fkError = error;
    }
    assert(fkError !== null, 'receipt for ghost campaign rejected');
    assertEqual((fkError as { code?: string }).code, '23503', 'FK violation 23503');

    const first = await insertDeliveryReceipt({
      deliveryId: `${RUN}_del_a`,
      notificationId: `${RUN}_notif_01`,
      deviceId,
      userId: authorUid,
      appId: TEST_APP,
      platform: 'android',
      status: 'delivered',
      attemptCount: 1,
      fcmMessageId: 'simulated:x',
      errorCode: null,
      skipReason: null,
    });
    assert(first !== null, 'first receipt inserted');
    const dup = await insertDeliveryReceipt({
      deliveryId: `${RUN}_del_b`,
      notificationId: `${RUN}_notif_01`,
      deviceId, // same notification × device
      userId: authorUid,
      appId: TEST_APP,
      platform: 'android',
      status: 'delivered',
      attemptCount: 1,
      fcmMessageId: 'simulated:y',
      errorCode: null,
      skipReason: null,
    });
    assertEqual(dup, null, 'duplicate receipt suppressed by UNIQUE (notification_id, device_id)');
  });

  await test('PGT-18', 'Distributed rate limiting: atomic buckets shared across instances', async () => {
    const limiter = new PostgresRateLimitStore(60_000);
    const key = `${RUN}_rl`;
    const one = await limiter.increment(key);
    assertEqual(one.totalHits, 1, 'first hit → 1');
    const two = await limiter.increment(key);
    assertEqual(two.totalHits, 2, 'second hit → 2');
    await limiter.decrement(key);
    const afterDec = await limiter.increment(key);
    assertEqual(afterDec.totalHits, 2, 'decrement applied');
    await limiter.resetKey(key);
    const fresh = await limiter.increment(key);
    assertEqual(fresh.totalHits, 1, 'resetKey starts a new window');
    await limiter.resetKey(key);
  });

  await test('PGT-19', 'Health check verifies real PostgreSQL connectivity', async () => {
    assertEqual(await checkDatabaseHealth(), true, 'checkDatabaseHealth true');
    assertEqual(await store.checkHealth(), true, 'store.checkHealth true');
  });

  await test('PGT-20', 'Checksum mismatch on an applied migration blocks startup', async () => {
    // Tamper with the RECORDED checksum (the migration file itself is never
    // edited once applied). Startup must abort loudly, then succeed again
    // once the recorded checksum is restored.
    await query("UPDATE schema_migrations SET checksum = $1 WHERE version = '002'", [
      '0'.repeat(64),
    ]);
    let blocked = false;
    try {
      await runMigrations();
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      assert(msg.includes('MIGRATION_CHECKSUM_MISMATCH'), 'failure is the checksum-mismatch guard');
      blocked = true;
    }
    assert(blocked, 'checksum mismatch aborted the migration run');
    const migrationFile = fileURLToPath(
      new URL('../migrations/002_postgres_runtime.sql', import.meta.url)
    );
    const realChecksum = createHash('sha256')
      .update(readFileSync(migrationFile, 'utf-8'), 'utf-8')
      .digest('hex');
    await query('UPDATE schema_migrations SET checksum = $1 WHERE version = $2', [
      realChecksum,
      '002',
    ]);
    const report = await runMigrations();
    assert(report.skipped.includes('002'), 'restored checksum lets startup proceed');
  });

  await test('PGT-21', 'Failed migration is atomic: nothing applied, nothing recorded, retry succeeds', async () => {
    // Disposable probe migration that fails mid-file. The runner must roll
    // back BOTH the partial DDL and the schema_migrations record.
    const probePath = fileURLToPath(
      new URL('../migrations/999_pgt_atomic_probe.sql', import.meta.url)
    );
    writeFileSync(
      probePath,
      [
        '-- PGT-21 disposable probe: intentionally fails mid-migration.',
        'BEGIN;',
        '',
        'CREATE TABLE IF NOT EXISTS pgt_999_atomic_probe (id INTEGER);',
        '',
        'INSERT INTO pgt_999_atomic_probe (missing_column) VALUES (1);',
        '',
        'COMMIT;',
        '',
      ].join('\n'),
      'utf-8'
    );
    try {
      let failed = false;
      try {
        await runMigrations();
      } catch {
        failed = true;
      }
      assert(failed, 'failing migration aborts the run');
      const recorded = await query<{ version: string }>(
        'SELECT version FROM schema_migrations WHERE version = $1',
        ['999']
      );
      assertEqual(recorded.length, 0, 'failed migration NOT recorded as applied');
      const probe = await query<{ probe_exists: string | null }>(
        "SELECT to_regclass('pgt_999_atomic_probe') AS probe_exists"
      );
      assert(probe[0]?.probe_exists === null, 'partial DDL rolled back (no half-applied state)');
    } finally {
      // Interruption-retry: with the probe removed the next run must succeed.
      if (existsSync(probePath)) unlinkSync(probePath);
    }
    const retry = await runMigrations();
    assertEqual(retry.applied.length, 0, 'retry applies nothing');
    assertEqual(retry.skipped.length, 2, 'known migrations still intact after the failed run');
  });

  await test('PGT-22', 'Firebase sign-in provider is mapped from the verified token, never hardcoded', async () => {
    const token = (provider: unknown) => ({ firebase: { sign_in_provider: provider } });
    assertEqual(mapFirebaseSignInProvider(token('google.com')), 'google.com', 'google.com mapped');
    assertEqual(mapFirebaseSignInProvider(token('password')), 'password', 'password mapped');
    assertEqual(
      mapFirebaseSignInProvider(token('anonymous')),
      'anonymous_guest',
      'anonymous mapped to anonymous_guest'
    );
    assertEqual(mapFirebaseSignInProvider(token('phone')), null, 'phone rejected (unsupported)');
    assertEqual(mapFirebaseSignInProvider(token('custom')), null, 'custom rejected');
    assertEqual(mapFirebaseSignInProvider(token('saml.my-provider')), null, 'saml rejected');
    assertEqual(
      mapFirebaseSignInProvider({ firebase: {} }),
      null,
      'missing claim rejected (fail closed)'
    );
    assertEqual(mapFirebaseSignInProvider({}), null, 'missing firebase claim rejected');
    assertEqual(mapFirebaseSignInProvider(null), null, 'null token rejected');
    // The mapped provider value persists through the users repository verbatim.
    const uid = `${RUN}_anonprov`;
    await upsertUserFromFirebase({
      uid,
      displayName: 'PG Anon',
      emailMasked: 'pa****@test.dev',
      emailVerified: false,
      authProvider: 'anonymous_guest',
      role: 'user',
    });
    const user = await getUser(uid);
    assertEqual(
      user!.authProvider,
      'anonymous_guest',
      'provider stored verbatim (not re-labelled google.com)'
    );
  });

  await test('PGT-23', 'MOCKED FCM responses: dry-run marking and honest error classification', async () => {
    // MOCKED Firebase: the GOGO_TEST_IMPORT-guarded seam replaces only
    // sendEachForMulticast with deterministic fakes. This exercises the
    // worker's response handling (dry-run marking, error classification,
    // receipt honesty); it is NOT live FCM verification.
    const appId = await isolateApp('fcm');
    const users = [
      { uid: `${RUN}_fcmok`, token: 'realtoken_ci_ok_01' },
      { uid: `${RUN}_fcmreg`, token: 'realtoken_ci_reg_01' },
      { uid: `${RUN}_fcmunavail`, token: 'realtoken_ci_unavail_01' },
    ];
    for (const u of users) {
      await store.syncUser(u.uid, {
        displayName: `PG ${u.uid}`,
        emailMasked: 'pf****@test.dev',
        emailVerified: true,
        authProvider: 'password',
        role: 'user',
      });
      await createDevice({
        deviceId: `dev_${u.uid}`,
        userId: u.uid,
        appId,
        fcmToken: u.token,
        platform: 'android',
        userAgent: 'pgt-agent',
      });
    }

    const savedDryRun = process.env.FCM_DRY_RUN;
    process.env.FCM_DRY_RUN = 'true';
    setTestFirebaseOverrides({
      sendEachForMulticast: async (message) => {
        const tokens = (message as unknown as { tokens: string[] }).tokens;
        return {
          responses: tokens.map((t) => {
            if (t.endsWith('_ok_01')) {
              return { success: true, messageId: 'projects/gogo-ci/messages/MOCK_OK_1' };
            }
            if (t.endsWith('_reg_01')) {
              return {
                success: false,
                error: { code: 'messaging/registration-token-not-registered', message: 'MOCK: not registered' },
              };
            }
            return {
              success: false,
              error: { code: 'messaging/server-unavailable', message: 'MOCK: unavailable' },
            };
          }),
        };
      },
    });
    try {
      const c = await insertCampaignIfAbsent({
        notificationId: `${RUN}_notif_fcm`,
        idempotencyKey: `${RUN}_fcm_key`,
        appId,
        targetType: 'broadcast',
        targetValue: 'all-users',
        platform: 'all',
        title: 'PGT-23',
        body: 'mocked fcm',
        deepLink: DEEPLINK,
        scheduledFor: null,
        authorId: authorUid,
        payloadHash: 'f'.repeat(64),
      });
      assert(c !== null, 'campaign inserted');
      const finalCampaign = await worker.processCampaign(c!.notificationId);
      assert(finalCampaign !== null, 'campaign processed');

      const receipts = await query<{
        status: string;
        fcm_message_id: string | null;
        error_code: string | null;
        device_id: string;
      }>(
        'SELECT status, fcm_message_id, error_code, device_id FROM notification_deliveries WHERE notification_id = $1',
        [c!.notificationId]
      );
      assertEqual(receipts.length, 3, 'one receipt per device');
      const byDevice = new Map(receipts.map((r) => [r.device_id, r]));

      const ok = byDevice.get(`dev_${RUN}_fcmok`);
      assertEqual(ok?.status, 'skipped_preference', 'successful mocked dry-run is skipped, never delivered');
      assert(
        (ok?.fcm_message_id ?? '').startsWith('dryrun:'),
        `dry-run receipt must carry the dryrun: prefix (got ${ok?.fcm_message_id})`
      );

      const reg = byDevice.get(`dev_${RUN}_fcmreg`);
      assertEqual(reg?.status, 'failed_expired_token', 'unregistered token -> failed_expired_token');
      assert(
        (reg?.error_code ?? '').includes('registration-token-not-registered'),
        'canonical SDK error code preserved on the receipt'
      );
      const regDevice = await getDevice(`dev_${RUN}_fcmreg`);
      assertEqual(regDevice?.status, 'expired', 'device marked expired (no retry burn)');

      const unavail = byDevice.get(`dev_${RUN}_fcmunavail`);
      assertEqual(
        unavail?.status,
        'failed_transient',
        'server-unavailability -> failed_transient (bounded retry)'
      );

      assertEqual(finalCampaign!.status, 'partial_failure', 'campaign honestly partial_failure');
      assertEqual(finalCampaign!.sentCount, 0, 'dry-run must not increment sentCount');
      assertEqual(finalCampaign!.failedCount, 2, 'failedCount 2');
    } finally {
      setTestFirebaseOverrides({});
      if (savedDryRun === undefined) delete process.env.FCM_DRY_RUN;
      else process.env.FCM_DRY_RUN = savedDryRun;
    }
  });

  await test('PGT-24', 'GitHub Actions automation principal can author product-update campaigns without admin privileges', async () => {
    await ensureGitHubActionsServiceUser();
    const automationUser = await getUser('system:github-actions');
    assert(automationUser !== null, 'automation principal persisted');
    assertEqual(automationUser!.role, 'user', 'automation principal is never an admin');
    const result = await store.dispatchNotification({
      idempotencyKey: `${RUN}_gha_author`,
      appId: 'gogocompany-in',
      targetType: 'product',
      targetValue: 'all',
      platform: 'all',
      title: 'GoGo Company update',
      body: 'Automated publication event test',
      deepLink: 'https://gogocompany.in/',
      scheduledFor: null,
      authorId: 'system:github-actions',
    });
    assert(result.campaign !== null, 'automation campaign is created');
    assertEqual(result.campaign.authorId, 'system:github-actions', 'campaign stores the service principal as author');
  });

  await store.close();

  const failed = results.filter((r) => r.status === 'FAIL');
  console.log('\n===== PostgreSQL Integration Test Summary =====');
  console.log(`PASS: ${results.length - failed.length}/${results.length}`);
  for (const r of results) {
    console.log(`  ${r.status}  ${r.id}: ${r.name}${r.error ? `\n        ${r.error}` : ''}`);
  }
  if (failed.length > 0) {
    console.error(`\n${failed.length} integration test(s) FAILED.`);
    process.exit(1);
  } else {
    console.log('\nAll PostgreSQL integration tests PASSED.');
    process.exit(0);
  }
}

main().catch(async (error) => {
  console.error(
    `[BLOCKED] PostgreSQL integration tests could not run: ${error instanceof Error ? error.message : String(error)}`
  );
  console.error('         Ensure SQL_HOST/SQL_PORT/SQL_DB_NAME/SQL_USER/SQL_PASSWORD point at a disposable PostgreSQL instance (never production).');
  await closePool().catch(() => undefined);
  process.exit(1);
});
