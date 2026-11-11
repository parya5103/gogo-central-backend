/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Firebase Admin bootstrap + TEST-ONLY override seam.
 *
 * Production always uses the real Admin SDK instances. The test suites (REG /
 * PGT) can inject deterministic fakes for verifyIdToken / sendEachForMulticast
 * to exercise the full code paths without Firebase credentials. The seam is
 * fail-closed: setting overrides in any process without GOGO_TEST_IMPORT=true
 * (test runners only) throws, so production authentication and FCM delivery
 * can never be swapped out by configuration or request input. Mocked test
 * results are always labelled MOCKED and never reported as live Firebase
 * verification (that requires GOOGLE_APPLICATION_CREDENTIALS; see README).
 */

import { initializeApp, getApps } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import type { DecodedIdToken } from 'firebase-admin/auth';
import { getMessaging } from 'firebase-admin/messaging';
import type { MulticastMessage, BatchResponse } from 'firebase-admin/messaging';
import fs from 'node:fs';
import firebaseConfig from '../../firebase-applet-config.json';

if (!getApps().length) {
  initializeApp({
    projectId: firebaseConfig.projectId,
  });
}

export const adminAuth = getAuth();
export const adminMessaging = getMessaging();
export const FIREBASE_PROJECT_ID = firebaseConfig.projectId;
export const ROOT_ADMIN_EMAIL = 'aaryapratik@gmail.com';

/**
 * TEST-ONLY overrides (guarded by GOGO_TEST_IMPORT). Never settable in
 * production processes; the setter throws outside test runners.
 */
export interface TestFirebaseOverrides {
  verifyIdToken?: (idToken: string, checkRevoked: boolean) => Promise<unknown>;
  sendEachForMulticast?: (message: MulticastMessage, dryRun: boolean) => Promise<unknown>;
}

let testOverrides: TestFirebaseOverrides = {};

/**
 * Replaces the Firebase fakes used by the test suites. Fail-closed: throws
 * unless GOGO_TEST_IMPORT=true (set only by npm test / npm run test:pg).
 * Passing {} clears all overrides and restores real Admin SDK behaviour.
 */
export function setTestFirebaseOverrides(overrides: TestFirebaseOverrides): void {
  if (process.env.GOGO_TEST_IMPORT !== 'true') {
    throw new Error(
      'TEST_OVERRIDES_DISABLED: Firebase test overrides require GOGO_TEST_IMPORT=true (test runners only).'
    );
  }
  testOverrides = overrides;
}

/**
 * Verifies a Firebase ID token. Production path: the real Admin SDK with
 * checkRevoked enforcement. Test path (only under GOGO_TEST_IMPORT): the
 * injected fake with the same call contract.
 */
export async function verifyFirebaseIdToken(
  idToken: string,
  checkRevoked: boolean
): Promise<DecodedIdToken> {
  if (testOverrides.verifyIdToken) {
    return (await testOverrides.verifyIdToken(idToken, checkRevoked)) as DecodedIdToken;
  }
  return adminAuth.verifyIdToken(idToken, checkRevoked);
}

/**
 * Sends an FCM multicast (optionally dry-run). Production path: the real
 * Admin SDK. Test path (only under GOGO_TEST_IMPORT): the injected fake.
 */
export async function sendFcmMulticast(
  message: MulticastMessage,
  dryRun: boolean
): Promise<BatchResponse> {
  if (testOverrides.sendEachForMulticast) {
    return (await testOverrides.sendEachForMulticast(message, dryRun)) as BatchResponse;
  }
  return adminMessaging.sendEachForMulticast(message, dryRun);
}

/**
 * Public, unauthenticated Firebase Admin runtime diagnostics.
 *
 * Purpose: while server-side token verification is misconfigured (missing
 * service-account credentials, wrong project audience), the admin dashboard
 * cannot authenticate, so the failure is invisible to its own health panel.
 * This self-check answers "is the server able to verify ID tokens, and if
 * not, exactly why" WITHOUT exposing any secret: only booleans, the public
 * project identifiers (already present in the shipped client config), and
 * the raw error CODE of a deliberately failing live probe.
 */
export async function adminRuntimeDiagnostics(): Promise<Record<string, unknown>> {
  const credentialsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS || '';

  let credentialFileState = 'env-not-set';
  let credentialProjectId: string | null = null;
  if (credentialsPath) {
    try {
      const credJson = JSON.parse(fs.readFileSync(credentialsPath, 'utf-8')) as Record<
        string,
        unknown
      >;
      credentialProjectId =
        typeof credJson.project_id === 'string' ? credJson.project_id : null;
      credentialFileState = credentialProjectId ? 'parsed' : 'parsed-no-project-id';
    } catch {
      try {
        credentialFileState = fs.existsSync(credentialsPath) ? 'exists-not-json' : 'missing';
      } catch {
        credentialFileState = 'unreadable';
      }
    }
  }

  // Live probe exercising the FULL credential chain end-to-end. Healthy
  // credentials always yield auth/user-not-found for a nonexistent UID;
  // any other code pinpoints the exact server-side config failure.
  let liveProbeErrorCode: string | null = null;
  let liveProbeErrorDetail: string | null = null;
  try {
    await adminAuth.getUser('diagnostic-nonexistent-uid');
    liveProbeErrorCode = 'unexpected-success';
  } catch (error) {
    const err = error as { code?: string; message?: string };
    liveProbeErrorCode = typeof err.code === 'string' ? err.code : 'unknown-error-code';
    liveProbeErrorDetail = String(err.message || '').slice(0, 160);
  }

  return {
    adminAppInitialized: getApps().length > 0,
    credentialsEnvSet: Boolean(credentialsPath),
    credentialFileState,
    credentialProjectId,
    expectedProjectId: firebaseConfig.projectId,
    projectIdMatches: credentialProjectId === firebaseConfig.projectId,
    liveProbeErrorCode,
    liveProbeErrorDetail,
    fcmDryRun: process.env.FCM_DRY_RUN === 'true',
  };
}
