/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * GoGo Central Backend — Ecosystem Notification Matrix Tests (MX-01..MX-11)
 *
 * End-to-end matrix for the five-product notification system:
 *   Tier A (HTTP, MX-01..MX-03): the real Express app on the in-memory test
 *     adapter, exercising requireAuth / requireAdmin middleware exactly as
 *     deployed. Firebase verification is the REAL verifier for negative cases
 *     (forged tokens fail closed); where a decoded user is needed, the
 *     GOGO_TEST_IMPORT-guarded seam injects MOCKED verifyIdToken fakes.
 *   Tier B (PostgreSQL, MX-04..MX-11): real database via PostgresDataStore +
 *     NotificationWorker, MOCKED FCM sendEachForMulticast via the same guarded
 *     seam (dry-run receipt marking, error classification).
 *
 * MOCKED tests are labelled MOCKED. NOTHING in this file proves live Firebase
 * delivery; live delivery verification is a manual post-deployment step that
 * requires real credentials (docs/DEPLOYMENT.md).
 *
 * Safety: NEVER point SQL_* at production; synthetic rows use `mx_<run>` ids.
 */

process.env.GOGO_TEST_IMPORT = 'true';
process.env.GOGO_ENABLE_SANDBOX_AUTH = 'true';

import type { Server } from 'node:http';
import assert from 'node:assert/strict';
import { runMigrations } from '../src/db/migrate.ts';
import { query, closePool } from '../src/db/pool.ts';
import { createDevice, getDevice } from '../src/repositories/devices.repository.ts';
import { upsertUserFromFirebase } from '../src/repositories/users.repository.ts';
import { PostgresDataStore } from '../src/server/postgres-store.ts';
import { setTestFirebaseOverrides } from '../src/lib/firebase-admin.ts';

const RUN = `mx_${Date.now().toString(36)}`;
const DEEPLINK = 'https://gogocompany.in/';
const ECOSYSTEM_APPS = [
  'gogocompany-in',
  'sarkari-sarthi',
  'pika-news',
  'arrow-out',
  'crystal-quest',
];

interface TestResult {
  id: string;
  name: string;
  status: 'PASS' | 'FAIL';
  error?: string;
}

const results: TestResult[] = [];

function assertEqual(actual: unknown, expected: unknown, message: string): void {
  if (actual !== expected) {
    throw new Error(
      `ASSERTION_FAILED: ${message} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`
    );
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

function registerBody(appId: string, fcmToken: string) {
  return JSON.stringify({ appId, fcmToken, platform: 'web', userAgent: 'mx-matrix-agent' });
}

async function tierAHttpTests(): Promise<void> {
  const { createGoGoApp } = await import('../server.ts');
  const app = await createGoGoApp();
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const addr = server.address();
  const baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  try {
    await test('MX-01', 'HTTP: device registration accepts each of the five GoGo products and rejects unknown apps / malformed tokens', async () => {
      for (const appId of ECOSYSTEM_APPS) {
        const res = await fetch(`${baseUrl}/api/v1/devices/register`, {
          method: 'POST',
          headers: { 'X-GoGo-Sandbox-Role': 'admin', 'Content-Type': 'application/json' },
          body: registerBody(appId, `mx_http_token_${appId}`),
        });
        assertEqual(res.status, 201, `sandbox admin can register a web device for ${appId}`);
      }
      const res404 = await fetch(`${baseUrl}/api/v1/devices/register`, {
        method: 'POST',
        headers: { 'X-GoGo-Sandbox-Role': 'admin', 'Content-Type': 'application/json' },
        body: registerBody('not-a-gogo-product', 'mx_http_token_unknown_product'),
      });
      assertEqual(res404.status, 404, 'unknown appId rejected with 404');

      const res400 = await fetch(`${baseUrl}/api/v1/devices/register`, {
        method: 'POST',
        headers: { 'X-GoGo-Sandbox-Role': 'admin', 'Content-Type': 'application/json' },
        body: registerBody('sarkari-sarthi', 'short!'),
      });
      assertEqual(res400.status, 400, 'malformed FCM token rejected with 400');
    });

    await test('MX-02', 'HTTP: Firebase authentication failure contract on device registration (missing 401, forged 401, MOCKED revoked 401)', async () => {
      const resNone = await fetch(`${baseUrl}/api/v1/devices/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: registerBody('sarkari-sarthi', 'mx_http_token_noauth'),
      });
      const noneBody = (await resNone.json()) as { code?: string };
      assertEqual(resNone.status, 401, 'missing Bearer token rejected');
      assertEqual(noneBody.code, 'AUTH_MISSING_TOKEN', 'missing token contract');

      // REAL verifier, no mocks: a forged token must fail closed.
      const resForged = await fetch(`${baseUrl}/api/v1/devices/register`, {
        method: 'POST',
        headers: { Authorization: 'Bearer forged.jwt.token.value', 'Content-Type': 'application/json' },
        body: registerBody('sarkari-sarthi', 'mx_http_token_forged'),
      });
      assertEqual(resForged.status, 401, 'forged Bearer token rejected by the real verifier');

      // MOCKED: revoked-session contract.
      setTestFirebaseOverrides({
        verifyIdToken: async () => {
          const err = new Error('MOCK: revoked') as Error & { code: string };
          err.code = 'auth/id-token-revoked';
          throw err;
        },
      });
      try {
        const resRevoked = await fetch(`${baseUrl}/api/v1/devices/register`, {
          method: 'POST',
          headers: { Authorization: 'Bearer mock-revoked-token', 'Content-Type': 'application/json' },
          body: registerBody('sarkari-sarthi', 'mx_http_token_revoked'),
        });
        const revokedBody = (await resRevoked.json()) as { code?: string };
        assertEqual(resRevoked.status, 401, 'MOCKED revoked token rejected');
        assertEqual(revokedBody.code, 'AUTH_TOKEN_REVOKED', 'revoked token contract');
      } finally {
        setTestFirebaseOverrides({});
      }
    });

    await test('MX-03', 'HTTP: admin-only broadcast protection (sandbox user 403, MOCKED non-admin Firebase user 403, admin 201)', async () => {
      const campaignPayload = (key: string) =>
        JSON.stringify({
          idempotencyKey: key,
          appId: 'all-gogo',
          targetType: 'ecosystem',
          targetValue: 'all',
          platform: 'all',
          title: 'MX-03 ecosystem probe',
          body: 'RBAC matrix probe',
          deepLink: DEEPLINK,
          scheduledFor: null,
        });

      const resUser = await fetch(`${baseUrl}/api/v1/notifications/send`, {
        method: 'POST',
        headers: { 'X-GoGo-Sandbox-Role': 'user', 'Content-Type': 'application/json' },
        body: campaignPayload(`mx_http_user_${Date.now()}`),
      });
      assertEqual(resUser.status, 403, 'standard user cannot broadcast (server-side RBAC)');

      // MOCKED: a verified google.com token for a NON-admin user is still 403.
      setTestFirebaseOverrides({
        verifyIdToken: async () => ({
          uid: 'uid_mx_regular_user',
          email: 'mx.regular.user@example.com',
          email_verified: true,
          name: 'MX Regular',
          firebase: { sign_in_provider: 'google.com' },
        }),
      });
      try {
        const resFirebaseUser = await fetch(`${baseUrl}/api/v1/notifications/send`, {
          method: 'POST',
          headers: { Authorization: 'Bearer mock-regular-user', 'Content-Type': 'application/json' },
          body: campaignPayload(`mx_http_fbuser_${Date.now()}`),
        });
        assertEqual(
          resFirebaseUser.status,
          403,
          'MOCKED verified non-admin Firebase user cannot broadcast'
        );
      } finally {
        setTestFirebaseOverrides({});
      }

      const resAdmin = await fetch(`${baseUrl}/api/v1/notifications/send`, {
        method: 'POST',
        headers: { 'X-GoGo-Sandbox-Role': 'admin', 'Content-Type': 'application/json' },
        body: campaignPayload(`mx_http_admin_${Date.now()}`),
      });
      assertEqual(resAdmin.status, 201, 'admin can dispatch an ecosystem campaign');
    });
  } finally {
    server.close();
  }
}

async function tierBPostgresTests(): Promise<void> {
  await runMigrations();
  const store = new PostgresDataStore();

  const authorUid = `${RUN}_author`;
  await upsertUserFromFirebase({
    uid: authorUid,
    displayName: 'MX Author',
    emailMasked: 'mx****@test.dev',
    emailVerified: true,
    authProvider: 'google.com',
    role: 'admin',
  });

  await test('MX-04', 'PostgreSQL: register devices and enabled preferences for each of the five products', async () => {
    for (let i = 0; i < ECOSYSTEM_APPS.length; i += 1) {
      const appId = ECOSYSTEM_APPS[i];
      const uid = `${RUN}_u_${i}`;
      await store.syncUser(uid, {
        displayName: `MX User ${i}`,
        emailMasked: 'mx****@test.dev',
        emailVerified: true,
        authProvider: 'password',
        role: 'user',
      });
      const device = await createDevice({
        deviceId: `${RUN}_dev_${i}`,
        userId: uid,
        appId,
        fcmToken: `${RUN}_tok_${i}`,
        platform: i % 2 === 1 ? 'android' : 'web',
        userAgent: 'mx-agent',
      });
      assertEqual(device.status, 'active', `device active on ${appId}`);
      await store.upsertPreference(uid, appId, {
        enabled: true,
        webPush: true,
        androidPush: true,
        marketingAlerts: true,
        transactionalAlerts: true,
        quietHoursStart: '22:00',
        quietHoursEnd: '06:00',
      });
    }
  });

  await test('MX-05', 'PostgreSQL: duplicate token registration is a token-unique refresh (stable device_id, reactivation, no second row)', async () => {
    // The same FCM token re-registered with a fresh generated deviceId must
    // refresh the existing row instead of violating UNIQUE (fcm_token).
    const refreshed = await createDevice({
      deviceId: `${RUN}_dev_refresh_attempt`,
      userId: `${RUN}_u_0`,
      appId: ECOSYSTEM_APPS[0],
      fcmToken: `${RUN}_tok_0`,
      platform: 'web',
      userAgent: 'mx-agent-v2',
    });
    assertEqual(
      refreshed.deviceId,
      `${RUN}_dev_0`,
      'token refresh keeps the original stable device identity'
    );
    assertEqual(refreshed.status, 'active', 'refresh leaves the device active');
    assertEqual(refreshed.userAgent, 'mx-agent-v2', 'user agent updated by the refresh');

    const rows = await query<{ c: number }>(
      'SELECT COUNT(*)::int AS c FROM device_tokens WHERE fcm_token = $1',
      [`${RUN}_tok_0`]
    );
    assertEqual(rows[0].c, 1, 'exactly one row per FCM token (no duplicate delivery possible)');

    // A revoked device re-registering the same token is reactivated in place.
    await store.markDeviceStatus(`${RUN}_dev_0`, 'revoked');
    const reOptIn = await createDevice({
      deviceId: `${RUN}_dev_reoptin_attempt`,
      userId: `${RUN}_u_0`,
      appId: ECOSYSTEM_APPS[0],
      fcmToken: `${RUN}_tok_0`,
      platform: 'web',
      userAgent: 'mx-agent-v3',
    });
    assertEqual(reOptIn.deviceId, `${RUN}_dev_0`, 're-opt-in reuses the original row');
    assertEqual(reOptIn.status, 'active', 're-opt-in reactivates the revoked device');
  });

  await test('MX-06', 'PostgreSQL: ecosystem (all-gogo) target selection reaches devices across all five products (MOCKED dry-run FCM)', async () => {
    const savedDryRun = process.env.FCM_DRY_RUN;
    process.env.FCM_DRY_RUN = 'true';
    // MOCKED FCM: deterministic success so receipt accounting is observable.
    setTestFirebaseOverrides({
      sendEachForMulticast: async (message) => {
        const tokens = (message as unknown as { tokens: string[] }).tokens;
        return {
          responses: tokens.map(() => ({
            success: true,
            messageId: 'projects/gogo-ci/messages/MX_MOCK_OK',
          })),
        };
      },
    });
    try {
      const result = await store.dispatchNotification({
        idempotencyKey: `${RUN}_eco`,
        appId: 'all-gogo',
        targetType: 'ecosystem',
        targetValue: 'all',
        platform: 'all',
        title: 'MX-06 ecosystem broadcast',
        body: 'all five products',
        deepLink: DEEPLINK,
        scheduledFor: null,
        authorId: authorUid,
      });
      assertEqual(
        result.campaign.sentCount,
        ECOSYSTEM_APPS.length,
        'one delivered receipt per registered device across all five products'
      );
      const deliveredApps = new Set(result.deliveriesCreated.map((d) => d.appId));
      for (const appId of ECOSYSTEM_APPS) {
        assert(deliveredApps.has(appId), `ecosystem dispatch reached ${appId}`);
      }
    } finally {
      setTestFirebaseOverrides({});
      if (savedDryRun === undefined) delete process.env.FCM_DRY_RUN;
      else process.env.FCM_DRY_RUN = savedDryRun;
    }
  });

  await test('MX-07', 'PostgreSQL: user opt-out enforcement (enabled=false -> skipped_preference, honest sentCount 0)', async () => {
    const appId = ECOSYSTEM_APPS[1];
    await store.upsertPreference(`${RUN}_u_1`, appId, {
      enabled: false,
      webPush: true,
      androidPush: true,
      marketingAlerts: false,
      transactionalAlerts: false,
      quietHoursStart: '22:00',
      quietHoursEnd: '06:00',
    });
    const result = await store.dispatchNotification({
      idempotencyKey: `${RUN}_optout`,
      appId,
      targetType: 'product',
      targetValue: 'all',
      platform: 'all',
      title: 'MX-07 after opt-out',
      body: 'must be skipped',
      deepLink: DEEPLINK,
      scheduledFor: null,
      authorId: authorUid,
    });
    assertEqual(result.campaign.sentCount, 0, 'opted-out user receives nothing (honest count)');
    assertEqual(
      result.deliveriesCreated[0]?.status,
      'skipped_preference',
      'receipt recorded as skipped_preference'
    );
  });

  await test('MX-08', 'PostgreSQL: platform preference gate (web device with webPush=false is skipped)', async () => {
    const appId = ECOSYSTEM_APPS[2];
    const u2 = `${RUN}_u_2`;
    await store.upsertPreference(u2, appId, {
      enabled: true,
      webPush: false,
      androidPush: true,
      marketingAlerts: true,
      transactionalAlerts: true,
      quietHoursStart: '22:00',
      quietHoursEnd: '06:00',
    });
    const result = await store.dispatchNotification({
      idempotencyKey: `${RUN}_platgate`,
      appId,
      targetType: 'product',
      targetValue: 'all',
      platform: 'web',
      title: 'MX-08 platform gate',
      body: 'web push disabled for this user',
      deepLink: DEEPLINK,
      scheduledFor: null,
      authorId: authorUid,
    });
    assertEqual(result.campaign.sentCount, 0, 'webPush=false blocks the web dispatch');
    assertEqual(
      result.deliveriesCreated[0]?.status,
      'skipped_preference',
      'platform gate recorded as skipped_preference'
    );
  });

  await test('MX-09', 'PostgreSQL: idempotency replay, payload-mismatch 409, and bounded retry of transient failures (MOCKED FCM fail-then-succeed)', async () => {
    // Replay: the same idempotency key + identical payload never re-sends.
    const replay = await store.dispatchNotification({
      idempotencyKey: `${RUN}_eco`,
      appId: 'all-gogo',
      targetType: 'ecosystem',
      targetValue: 'all',
      platform: 'all',
      title: 'MX-06 ecosystem broadcast',
      body: 'all five products',
      deepLink: DEEPLINK,
      scheduledFor: null,
      authorId: authorUid,
    });
    assertEqual(replay.duplicatePrevented, true, 'duplicate idempotency key intercepted');

    // Same key + DIFFERENT payload -> 409 contract.
    let mismatch: string | null = null;
    try {
      await store.dispatchNotification({
        idempotencyKey: `${RUN}_eco`,
        appId: 'all-gogo',
        targetType: 'ecosystem',
        targetValue: 'all',
        platform: 'all',
        title: 'DIFFERENT TITLE SAME KEY',
        body: 'payload mismatch',
        deepLink: DEEPLINK,
        scheduledFor: null,
        authorId: authorUid,
      });
    } catch (error) {
      mismatch = error instanceof Error ? error.message : String(error);
    }
    assert(
      mismatch !== null && mismatch.includes('IDEMPOTENCY_PAYLOAD_MISMATCH'),
      'same key with different payload is rejected with IDEMPOTENCY_PAYLOAD_MISMATCH (HTTP 409)'
    );

    // Retry: MOCKED transient failure, then MOCKED recovery on the retry.
    const appId = ECOSYSTEM_APPS[3];
    const savedDryRun = process.env.FCM_DRY_RUN;
    process.env.FCM_DRY_RUN = 'true';
    setTestFirebaseOverrides({
      sendEachForMulticast: async (message) => {
        const tokens = (message as unknown as { tokens: string[] }).tokens;
        return {
          responses: tokens.map(() => ({
            success: false,
            error: { code: 'messaging/server-unavailable', message: 'MOCK: transient' },
          })),
        };
      },
    });
    try {
      const c = await store.dispatchNotification({
        idempotencyKey: `${RUN}_retry`,
        appId,
        targetType: 'product',
        targetValue: 'all',
        platform: 'all',
        title: 'MX-09 retry probe',
        body: 'transient failure then retry',
        deepLink: DEEPLINK,
        scheduledFor: null,
        authorId: authorUid,
      });
      assertEqual(c.campaign.sentCount, 0, 'transient failure honestly recorded');
      assertEqual(c.campaign.failedCount, 1, 'one failed_transient receipt');

      // FCM "recovers": retry re-sends the failed_transient receipt.
      setTestFirebaseOverrides({
        sendEachForMulticast: async (message) => {
          const tokens = (message as unknown as { tokens: string[] }).tokens;
          return {
            responses: tokens.map(() => ({
              success: true,
              messageId: 'projects/gogo-ci/messages/MX_RETRY_OK',
            })),
          };
        },
      });
      const retry = await store.retryFailedCampaign(c.campaign.notificationId, authorUid);
      assert(!retry.error, `retry completed without error: ${retry.error ?? 'none'}`);
      assert(retry.campaign !== null, 'retry returns the updated campaign');
      assertEqual(retry.campaign.sentCount, 1, 'retry delivered the previously failed device');
    } finally {
      setTestFirebaseOverrides({});
      if (savedDryRun === undefined) delete process.env.FCM_DRY_RUN;
      else process.env.FCM_DRY_RUN = savedDryRun;
    }
  });

  await test('MX-10', 'PostgreSQL: invalid token cleanup (MOCKED not-registered -> failed_expired_token + device marked expired)', async () => {
    const appId = ECOSYSTEM_APPS[4];
    const savedDryRun = process.env.FCM_DRY_RUN;
    process.env.FCM_DRY_RUN = 'true';
    // MOCKED FCM: the SDK says the registration token is no longer registered.
    setTestFirebaseOverrides({
      sendEachForMulticast: async (message) => {
        const tokens = (message as unknown as { tokens: string[] }).tokens;
        return {
          responses: tokens.map(() => ({
            success: false,
            error: {
              code: 'messaging/registration-token-not-registered',
              message: 'MOCK: token gone',
            },
          })),
        };
      },
    });
    try {
      const result = await store.dispatchNotification({
        idempotencyKey: `${RUN}_expired`,
        appId,
        targetType: 'product',
        targetValue: 'all',
        platform: 'all',
        title: 'MX-10 expired token probe',
        body: 'token is gone',
        deepLink: DEEPLINK,
        scheduledFor: null,
        authorId: authorUid,
      });
      assertEqual(result.campaign.sentCount, 0, 'nothing delivered to the dead token');
      assertEqual(result.campaign.failedCount, 1, 'one failed receipt');
      assertEqual(
        result.deliveriesCreated[0]?.status,
        'failed_expired_token',
        'receipt recorded as failed_expired_token (no retry burn)'
      );
      const device = await getDevice(`${RUN}_dev_4`);
      assertEqual(device?.status, 'expired', 'device marked expired and excluded from future sends');
    } finally {
      setTestFirebaseOverrides({});
      if (savedDryRun === undefined) delete process.env.FCM_DRY_RUN;
      else process.env.FCM_DRY_RUN = savedDryRun;
    }
  });

  await test('MX-11', 'PostgreSQL: deep-link allowlist blocks non-GoGo phishing URLs (HTTP 400 contract)', async () => {
    let blocked: string | null = null;
    try {
      await store.dispatchNotification({
        idempotencyKey: `${RUN}_phish`,
        appId: ECOSYSTEM_APPS[0],
        targetType: 'product',
        targetValue: 'all',
        platform: 'all',
        title: 'MX-11 phishing probe',
        body: 'must never dispatch',
        deepLink: 'https://malicious-phishing-site.example.org/steal-credentials',
        scheduledFor: null,
        authorId: authorUid,
      });
    } catch (error) {
      blocked = error instanceof Error ? error.message : String(error);
    }
    assert(
      blocked !== null && blocked.includes('UNTRUSTED_DEEPLINK_DOMAIN'),
      'non-GoGo deepLink rejected with UNTRUSTED_DEEPLINK_DOMAIN (HTTP 400)'
    );
  });

  await store.close();
}

async function main(): Promise<void> {
  console.log('=== Tier A: HTTP middleware matrix (in-memory adapter) ===');
  await tierAHttpTests();
  console.log('=== Tier B: PostgreSQL store + worker matrix (MOCKED FCM seam) ===');
  await tierBPostgresTests();

  const failed = results.filter((r) => r.status === 'FAIL');
  console.log('\n===== Notification Matrix Test Summary =====');
  console.log(`PASS: ${results.length - failed.length}/${results.length}`);
  for (const r of results) {
    console.log(`  ${r.status}  ${r.id}: ${r.name}${r.error ? `\n        ${r.error}` : ''}`);
  }
  if (failed.length > 0) {
    console.error(`\n${failed.length} matrix test(s) FAILED.`);
    process.exit(1);
  }
  console.log('\nAll notification matrix tests PASSED. (FCM multicast responses are MOCKED; live delivery requires real credentials.)');
  process.exit(0);
}

main().catch(async (error) => {
  console.error(
    `[BLOCKED] Notification matrix tests could not run: ${error instanceof Error ? error.message : String(error)}`
  );
  console.error('         Ensure SQL_HOST/SQL_PORT/SQL_DB_NAME/SQL_USER/SQL_PASSWORD point at a disposable PostgreSQL instance (never production).');
  await closePool().catch(() => undefined);
  process.exit(1);
});
