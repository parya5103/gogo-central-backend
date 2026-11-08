/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Pure Firebase sign-in provider mapping for requireAuth().
 *
 * The provider is read from the VERIFIED ID token's own claim
 * (decoded.firebase.sign_in_provider) — never hardcoded, never taken from the
 * client request. Unsupported providers return null and the caller must reject
 * the request (fail closed: an unknown provider is never silently re-labelled
 * as a supported one).
 */

/** Canonical provider values stored in the users.auth_provider column. */
export type GoGoAuthProvider = 'google.com' | 'password' | 'anonymous_guest';

/**
 * Supported Firebase sign-in providers, mapped to canonical GoGo values.
 * Everything else (phone, custom, SAML, unknown…) is unsupported.
 */
const SUPPORTED_PROVIDERS: Record<string, GoGoAuthProvider> = {
  'google.com': 'google.com',
  password: 'password',
  anonymous: 'anonymous_guest',
};

/**
 * Maps the verified token's `firebase.sign_in_provider` claim to a canonical
 * provider value. Returns null when the claim is missing, malformed, or
 * belongs to an unsupported provider.
 */
export function mapFirebaseSignInProvider(decoded: unknown): GoGoAuthProvider | null {
  const firebaseClaim =
    decoded && typeof decoded === 'object' && 'firebase' in decoded
      ? (decoded as { firebase?: unknown }).firebase
      : undefined;
  const rawProvider =
    firebaseClaim && typeof firebaseClaim === 'object' && 'sign_in_provider' in firebaseClaim
      ? (firebaseClaim as { sign_in_provider?: unknown }).sign_in_provider
      : undefined;
  if (typeof rawProvider !== 'string' || rawProvider.length === 0 || rawProvider.length > 64) {
    return null;
  }
  return SUPPORTED_PROVIDERS[rawProvider] ?? null;
}
