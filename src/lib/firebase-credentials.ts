/**
 * Parse a Firebase service-account JSON value supplied through a secret
 * environment variable. The private key is normalized for Render/dashboard
 * secret fields that store escaped newlines.
 */
export interface FirebaseServiceAccount {
  type: 'service_account';
  project_id: string;
  private_key_id: string;
  private_key: string;
  client_email: string;
  client_id?: string;
  token_uri?: string;
  [key: string]: unknown;
}

export function parseFirebaseServiceAccount(value: string): FirebaseServiceAccount {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('invalid-object');
    }

    const account = parsed as Record<string, unknown>;
    if (
      account.type !== 'service_account' ||
      typeof account.project_id !== 'string' ||
      typeof account.private_key_id !== 'string' ||
      typeof account.private_key !== 'string' ||
      typeof account.client_email !== 'string' ||
      !account.private_key.includes('PRIVATE KEY')
    ) {
      throw new Error('missing-required-fields');
    }

    return {
      ...account,
      type: 'service_account',
      project_id: account.project_id,
      private_key_id: account.private_key_id,
      private_key: account.private_key.replace(/\\n/g, '\n'),
      client_email: account.client_email,
    } as FirebaseServiceAccount;
  } catch {
    // Never include the supplied value or private-key material in an error.
    throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON_INVALID');
  }
}
