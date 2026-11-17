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

import { applicationDefault, cert, initializeApp, getApps } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import type { DecodedIdToken } from 'firebase-admin/auth';
import { getMessaging } from 'firebase-admin/messaging';
import type { MulticastMessage, BatchResponse } from 'firebase-admin/messaging';
import fs from 'node:fs';
import firebaseConfig from '../../firebase-applet-config.json';

type ServiceAccountJson = {
  project_id?: unknown;
  client_email?: unknown;
  private_key?: unknown;
};

type ResolvedServiceAccount = {
  projectId: string;
  clientEmail: string;
  privateKey: string;
  source: 'json-env' | 'explicit-file' | 'render-secret-file';
};

function parseServiceAccount(raw: string): Omit<ResolvedServiceAccount, 'source'> | null {
  try {
    const value = JSON.parse(raw) as ServiceAccountJson;
    if (
      value.project_id !== firebaseConfig.projectId ||
      typeof value.client_email !== 'string' ||
      !value.client_email.includes('@') ||
      typeof value.private_key !== 'string' ||
      !value.private_key.includes('PRIVATE KEY')
    ) return null;
    return { projectId: value.project_id, clientEmail: value.client_email, privateKey: value.private_key };
  } catch {
    return null;
  }
}

/** Resolve a matching Firebase service-account JSON from Render Secret Files. */
function resolveServiceAccount(): {
  account: ResolvedServiceAccount | null;
  state: string;
  projectId: string | null;
} {
  const jsonEnv = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (jsonEnv) {
    const parsed = parseServiceAccount(jsonEnv);
    if (parsed) return { account: { ...parsed, source: 'json-env' }, state: 'parsed', projectId: parsed.projectId };
  }

  const explicitPath = process.env.GOOGLE_APPLICATION_CREDENTIALS || process.env.FIREBASE_SERVICE_ACCOUNT_FILE || '';
  if (explicitPath) {
    try {
      const parsed = parseServiceAccount(fs.readFileSync(explicitPath, 'utf-8'));
      if (parsed) return { account: { ...parsed, source: 'explicit-file' }, state: 'parsed', projectId: parsed.projectId };
    } catch {
      // Continue to Render's standard secret-file mount directory.
    }
  }

  const secretDirectory = '/etc/secrets';
  try {
    if (fs.existsSync(secretDirectory)) {
      const entries = fs.readdirSync(secretDirectory, { withFileTypes: true });
      for (const entry of entries.slice(0, 50)) {
        if (!entry.isFile()) continue;
        try {
          const parsed = parseServiceAccount(fs.readFileSync(secretDirectory + '/' + entry.name, 'utf-8'));
          if (parsed) {
            return { account: { ...parsed, source: 'render-secret-file' }, state: 'parsed', projectId: parsed.projectId };
          }
        } catch {
          // Ignore unrelated secret files without exposing their contents.
        }
      }
    }
  } catch {
    return { account: null, state: 'secret-directory-unreadable', projectId: null };
  }

  return {
    account: null,
    state: explicitPath ? 'explicit-file-unavailable-or-invalid' : 'no-matching-secret-file',
    projectId: null,
  };
}

const serviceAccountResolution = resolveServiceAccount();

if (!getApps().length) {
  initializeApp({
    projectId: firebaseConfig.projectId,
    credential: serviceAccountResolution.account
      ? cert({
          projectId: serviceAccountResolution.account.projectId,
          clientEmail: serviceAccountResolution.account.clientEmail,
          privateKey: serviceAccountResolution.account.privateKey,
        })
      : applicationDefault(),
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
  let liveProbeErrorCode: string | null = null;
  try {
    await adminAuth.getUser('diagnostic-nonexistent-uid');
    liveProbeErrorCode = 'unexpected-success';
  } catch (error) {
    const err = error as { code?: string };
    liveProbeErrorCode = typeof err.code === 'string' ? err.code : 'unknown-error-code';
  }

  return {
    adminAppInitialized: getApps().length > 0,
    credentialsEnvSet: Boolean(
      process.env.GOOGLE_APPLICATION_CREDENTIALS ||
      process.env.FIREBASE_SERVICE_ACCOUNT_FILE ||
      process.env.FIREBASE_SERVICE_ACCOUNT_JSON
    ),
    credentialFileState: serviceAccountResolution.state,
    credentialProjectId: serviceAccountResolution.projectId,
    credentialSource: serviceAccountResolution.account?.source || 'application-default',
    expectedProjectId: firebaseConfig.projectId,
    projectIdMatches: serviceAccountResolution.projectId === firebaseConfig.projectId,
    liveProbeErrorCode,
    fcmDryRun: process.env.FCM_DRY_RUN === 'true',
  };
}
