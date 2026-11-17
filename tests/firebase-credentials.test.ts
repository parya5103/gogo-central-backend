import assert from 'node:assert/strict';
import { parseFirebaseServiceAccount } from '../src/lib/firebase-credentials.ts';

const valid = {
  type: 'service_account',
  project_id: 'gen-lang-client-0566323659',
  private_key_id: 'test-key-id',
  private_key: '-----BEGIN PRIVATE KEY-----\\nTEST\\n-----END PRIVATE KEY-----\\n',
  client_email: 'firebase-adminsdk@example.iam.gserviceaccount.com',
  client_id: '1234567890',
  token_uri: 'https://oauth2.googleapis.com/token',
};

const parsed = parseFirebaseServiceAccount(JSON.stringify(valid));
assert.equal(parsed.project_id, valid.project_id);
assert.equal(parsed.private_key, '-----BEGIN PRIVATE KEY-----\nTEST\n-----END PRIVATE KEY-----\n');

assert.throws(
  () => parseFirebaseServiceAccount('{not-json'),
  /FIREBASE_SERVICE_ACCOUNT_JSON_INVALID/
);
assert.throws(
  () => parseFirebaseServiceAccount(JSON.stringify({ project_id: valid.project_id })),
  /FIREBASE_SERVICE_ACCOUNT_JSON_INVALID/
);
console.log('Firebase service-account credential tests: PASS (3 assertions)');
