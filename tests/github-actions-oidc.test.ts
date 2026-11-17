import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { verifyGitHubActionsOidcToken } from '../src/server/github-actions-oidc.ts';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = publicKey.export({ format: 'jwk' });
const now = 1_800_000_000;
const claims = {
  iss: 'https://token.actions.githubusercontent.com',
  aud: 'gogo-central-notifications',
  exp: now + 300,
  nbf: now - 5,
  iat: now - 5,
  repository: 'parya5103/Sarkari-Sarthi',
  ref: 'refs/heads/main',
  workflow_ref: 'parya5103/Sarkari-Sarthi/.github/workflows/daily-job-fetch-deploy.yml@refs/heads/main',
  run_id: '123456',
  run_attempt: '1',
};
function makeToken(payload: Record<string, unknown> = claims, key = privateKey): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'test-key' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const input = header + '.' + body;
  return input + '.' + sign('RSA-SHA256', Buffer.from(input), key).toString('base64url');
}
const fakeFetch = (async () => new Response(JSON.stringify({ keys: [{ ...jwk, kid: 'test-key', alg: 'RS256', use: 'sig' }] }), {
  status: 200, headers: { 'content-type': 'application/json' },
})) as typeof fetch;

async function main() {
  const verified = await verifyGitHubActionsOidcToken(makeToken(), 'gogo-central-notifications', fakeFetch, now);
  assert.equal(verified.repository, claims.repository);
  await assert.rejects(
    verifyGitHubActionsOidcToken(makeToken(), 'wrong-audience', fakeFetch, now),
    /GITHUB_OIDC_AUDIENCE_REJECTED/,
  );
  await assert.rejects(
    verifyGitHubActionsOidcToken(makeToken({ ...claims, iss: 'https://attacker.example' }), 'gogo-central-notifications', fakeFetch, now),
    /GITHUB_OIDC_ISSUER_REJECTED/,
  );
  await assert.rejects(
    verifyGitHubActionsOidcToken(makeToken({ ...claims, exp: now }), 'gogo-central-notifications', fakeFetch, now),
    /GITHUB_OIDC_TOKEN_EXPIRED/,
  );
  const tampered = makeToken().replace(/.$/, 'A');
  await assert.rejects(
    verifyGitHubActionsOidcToken(tampered, 'gogo-central-notifications', fakeFetch, now),
    /GITHUB_OIDC_SIGNATURE_INVALID/,
  );
  console.log('GitHub Actions OIDC verification tests passed (5 assertions).');
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
