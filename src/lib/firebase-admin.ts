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
 * can never be swapped out by configuration or request input.
 */

import { cert, initializeApp, getApps } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import type { DecodedIdToken } from 'firebase-admin/auth';
import { getMessaging } from 'firebase-admin/messaging';
import type { MulticastMessage, BatchResponse } from 'firebase-admin/messaging';
import fs from 'node:fs';
import firebaseConfig from '../../firebase-applet-config.json';
import { parseFirebaseServiceAccount } from './firebase-credentials.ts';

const firebaseServiceAccountJson =
  process.env.FIREBASE_SERVICE_ACCOUNT_JSON ||
  process.env.FIREBASE_SERVICE_ACCOUNT ||
  (process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim().startsWith('{')
    ? process.env.GOOGLE_APPLICATION_CREDENTIALS
    : '');

if (!getApps().length) {
  if (firebaseServiceAccountJson) {
    const serviceAccount = parseFirebaseServiceAccount(firebaseServiceAccountJson);
    if (serviceAccount.project_id !== firebaseConfig.projectId) {
      throw new Error('FIREBASE_SERVICE_ACCOUNT_PROJECT_MISMATCH');
    }
    initializeApp({
      credential: cert(serviceAccount as Parameters<typeof cert>[0]),
      projectId: firebaseConfig.projectId,
    });
  } else {
    // Supports Render Secret Files and Google Application Default Credentials.
    // When GOOGLE_APPLICATION_CREDENTIALS is a file path, the Admin SDK reads it.
    initializeApp({ projectId: firebaseConfig.projectId });
  }
}

export const adminAuth = getAuth();
export const adminMessaging = getMessaging();
export const FIREBASE_PROJECT_ID = firebaseConfig.projectId;
export const ROOT_ADMIN_EMAIL = 'aaryapratik@gmail.com';

/**
 * TEST-ONLY overrides (guarded by GOGO_TEST_IMPORT). Never settable in
 * production processes; the setter throws, so production authentication and
 * FCM delivery can never be swapped out by configuration or request input.
 */
export interface TestFirebaseOverrides {
  verifyIdToken?: (idToken: string, checkRevoked: boolean) => Promise<unknown>;
  sendEachForMulticast?: (message: MulticastMessage, dryRun: boolean) => Promise<unknown>;
}

let testOverrides: TestFirebaseOverrides = {};

export function setTestFirebaseOverrides(overrides: TestFirebaseOverrides): void {
  if (process.env.GOGO_TEST_IMPORT !== 'true') {
    throw new Error(
      'TEST_OVERRIDES_DISABLED: Firebase test overrides require GOGO_TEST_IMPORT=true (test runners only).'
    );
  }
  testOverrides = overrides;
}

export async function verifyFirebaseIdToken(
  idToken: string,
  checkRevoked: boolean
): Promise<DecodedIdToken> {
  if (testOverrides.verifyIdToken) {
    return (await testOverrides.verifyIdToken(idToken, checkRevoked)) as DecodedIdToken;
  }
  return adminAuth.verifyIdToken(idToken, checkRevoked);
}

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
 * Exposes configuration state and public project IDs only, never credential
 * contents, private keys, client secrets, or full filesystem paths.
 */
export async function adminRuntimeDiagnostics(): Promise<Record<string, unknown>> {
  const googleCredentialsValue = process.env.GOOGLE_APPLICATION_CREDENTIALS || '';
  const serviceAccountJson =
    process.env.FIREBASE_SERVICE_ACCOUNT_JSON ||
    process.env.FIREBASE_SERVICE_ACCOUNT ||
    (googleCredentialsValue.trim().startsWith('{') ? googleCredentialsValue : '');
  const credentialsPath = serviceAccountJson ? '' : googleCredentialsValue;

  let credentialSource = serviceAccountJson
    ? 'service-account-json-env'
    : credentialsPath
      ? 'google-application-credentials-file'
      : 'application-default-credentials';
  let credentialFileState = 'env-not-set';
  let credentialProjectId: string | null = null;

  if (serviceAccountJson) {
    try {
      const account = parseFirebaseServiceAccount(serviceAccountJson);
      credentialProjectId = account.project_id;
      credentialFileState = 'parsed-env-json';
    } catch {
      credentialFileState = 'invalid-env-json';
    }
  } else if (credentialsPath) {
    try {
      const credJson = JSON.parse(fs.readFileSync(credentialsPath, 'utf-8')) as Record<
        string,
        unknown
      >;
      credentialProjectId =
        typeof credJson.project_id === 'string' ? credJson.project_id : null;
      credentialFileState = credentialProjectId ? 'parsed' : 'parsed-no-project-id';
    } catch {
      credentialFileState = fs.existsSync(credentialsPath) ? 'exists-not-json' : 'missing';
    }
  }

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
    credentialsEnvSet: Boolean(serviceAccountJson || credentialsPath),
    credentialSource,
    credentialFileState,
    credentialProjectId,
    expectedProjectId: firebaseConfig.projectId,
    projectIdMatches: credentialProjectId === firebaseConfig.projectId,
    liveProbeErrorCode,
    liveProbeErrorDetail,
    fcmDryRun: process.env.FCM_DRY_RUN === 'true',
  };
}
