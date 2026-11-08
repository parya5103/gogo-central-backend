/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Loads local environment files BEFORE any other module reads process.env.
 *
 * Precedence (highest first):
 *   1. Real environment variables (CI, Docker, Cloud Run, Termux exports)
 *   2. .env.local  (written by the Neon CLI: `neon deploy` pulls DATABASE_URL
 *      and other provisioned service variables here)
 *   3. .env        (shared local defaults)
 *
 * dotenv never overrides variables that are already set, so loading
 * .env.local first gives it precedence over .env, while real environment
 * variables always win. Both files match the .env* .gitignore rule: they
 * contain credentials and must never be committed.
 *
 * Import this FIRST in every process entry point (server.ts,
 * scripts/db-manager.ts): ESM evaluates imports in statement order and
 * other modules read process.env at load time.
 */

import dotenv from 'dotenv';

if (process.env.GOGO_ENV_FILES_LOADED !== 'true') {
  process.env.GOGO_ENV_FILES_LOADED = 'true';
  dotenv.config({ path: '.env.local', quiet: true });
  dotenv.config({ path: '.env', quiet: true });
}

export {};
