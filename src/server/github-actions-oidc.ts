/**
 * Verify GitHub Actions OIDC tokens without shared repository secrets.
 * The caller must still enforce an exact repository/workflow/ref allowlist.
 */
import { createPublicKey, verify as verifySignature } from 'node:crypto';

export interface GitHubActionsClaims {
  iss: string;
  aud: string | string[];
  exp: number;
  nbf?: number;
  iat: number;
  repository: string;
  ref: string;
  workflow_ref: string;
  job_workflow_ref?: string;
  run_id: string;
  run_attempt: string;
}

type Jwk = { kid: string; kty: string; alg?: string; use?: string; [key: string]: unknown };
type JwksResponse = { keys?: Jwk[] };

let cachedKeys: { expiresAt: number; keys: Jwk[] } | null = null;

async function loadGitHubSigningKeys(fetcher: typeof fetch): Promise<Jwk[]> {
  if (cachedKeys && cachedKeys.expiresAt > Date.now()) return cachedKeys.keys;
  const response = await fetcher('https://token.actions.githubusercontent.com/.well-known/jwks', {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error('GITHUB_OIDC_JWKS_UNAVAILABLE');
  const payload = (await response.json()) as JwksResponse;
  if (!Array.isArray(payload.keys) || payload.keys.length === 0) {
    throw new Error('GITHUB_OIDC_JWKS_INVALID');
  }
  cachedKeys = { keys: payload.keys, expiresAt: Date.now() + 60 * 60 * 1000 };
  return payload.keys;
}

export async function verifyGitHubActionsOidcToken(
  token: string,
  expectedAudience: string,
  fetcher: typeof fetch = fetch,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<GitHubActionsClaims> {
  if (!token || token.length > 16_384) throw new Error('GITHUB_OIDC_TOKEN_INVALID');
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('GITHUB_OIDC_TOKEN_INVALID');

  let header: { alg?: string; kid?: string };
  let claims: GitHubActionsClaims;
  try {
    header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    throw new Error('GITHUB_OIDC_TOKEN_INVALID');
  }
  if (header.alg !== 'RS256' || !header.kid) throw new Error('GITHUB_OIDC_ALGORITHM_REJECTED');

  const keys = await loadGitHubSigningKeys(fetcher);
  const jwk = keys.find((key) => key.kid === header.kid && key.kty === 'RSA' && (!key.alg || key.alg === 'RS256'));
  if (!jwk) throw new Error('GITHUB_OIDC_SIGNING_KEY_NOT_FOUND');

  let validSignature = false;
  try {
    const publicKey = createPublicKey({ key: jwk as unknown as import('node:crypto').JsonWebKey, format: 'jwk' });
    validSignature = verifySignature(
      'RSA-SHA256',
      Buffer.from(parts[0] + '.' + parts[1], 'utf8'),
      publicKey,
      Buffer.from(parts[2], 'base64url'),
    );
  } catch {
    throw new Error('GITHUB_OIDC_SIGNATURE_INVALID');
  }
  if (!validSignature) throw new Error('GITHUB_OIDC_SIGNATURE_INVALID');

  if (claims.iss !== 'https://token.actions.githubusercontent.com') throw new Error('GITHUB_OIDC_ISSUER_REJECTED');
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes(expectedAudience)) throw new Error('GITHUB_OIDC_AUDIENCE_REJECTED');
  if (!Number.isFinite(claims.exp) || claims.exp <= nowSeconds) throw new Error('GITHUB_OIDC_TOKEN_EXPIRED');
  if (claims.nbf !== undefined && claims.nbf > nowSeconds + 30) throw new Error('GITHUB_OIDC_TOKEN_NOT_YET_VALID');
  if (!Number.isFinite(claims.iat) || claims.iat > nowSeconds + 30 || nowSeconds - claims.iat > 600) {
    throw new Error('GITHUB_OIDC_TOKEN_ISSUED_AT_REJECTED');
  }
  if (
    typeof claims.repository !== 'string' ||
    typeof claims.ref !== 'string' ||
    typeof claims.workflow_ref !== 'string' ||
    typeof claims.run_id !== 'string' ||
    typeof claims.run_attempt !== 'string'
  ) throw new Error('GITHUB_OIDC_CLAIMS_INVALID');

  return claims;
}
