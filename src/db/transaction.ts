/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Re-exported transaction helper (dedicated module per repository layout plan).
 * The implementation lives in pool.ts so a transaction always uses a single
 * dedicated pool client with automatic rollback.
 */

export { withTransaction } from './pool.ts';
import type { PoolClient } from 'pg';
export type { PoolClient };
