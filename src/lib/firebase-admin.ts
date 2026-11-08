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
 * Structural types derived from the installed Admin SDK instance. The exact
 * type names exported by firebase-admin/messaging differ across SDK
 * versions; deriving them from the real instance keeps this file compiling
 * against any installed version while remaining fully type-safe.
 */
type MessagingMulticastMessage = Parameters<typeof adminMessaging.sendEachForMulticast>[0];
type BatchResponse = Awaited<ReturnType<typeof adminMessaging.sendEachForMulticast>>;

/**
 * TEST-ONLY overrides (guarded by GOGO_TEST_IMPORT). Never settable in
 * production processes; the setter throws outside test runners.
 */
export interface TestFirebaseOverrides {
  verifyIdToken?: (idToken: string, checkRevoked: boolean) => Promise<unknown>;
  sendEachForMulticast?: (message: MessagingMulticastMessage, dryRun: boolean) => Promise<unknown>;
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
  message: MessagingMulticastMessage,
  dryRun: boolean
): Promise<BatchResponse> {
  if (testOverrides.sendEachForMulticast) {
    return (await testOverrides.sendEachForMulticast(message, dryRun)) as BatchResponse;
  }
  return adminMessaging.sendEachForMulticast(message, dryRun);
}
