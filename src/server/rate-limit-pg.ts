/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * PostgreSQL-backed express-rate-limit store.
 *
 * The default MemoryStore is per-instance, so limits would multiply across
 * Cloud Run replicas. This store keeps counters in `rate_limit_buckets` with a
 * single atomic UPSERT per hit, shared by every instance.
 *
 * Bucket keys are already privacy-preserving (hashed client identity from
 * ipKeyGenerator + route prefix). No raw IPs are stored.
 */

import { query } from '../db/pool.ts';

interface BucketRow {
  hit_count: string;
  window_start: Date;
  reset_time_ms: string;
}

export interface RateLimitBucket {
  totalHits: number;
  resetTime: Date;
}

export class PostgresRateLimitStore {
  /**
   * @param windowMs Fixed window length in milliseconds.
   * @param keyPrefix Optional namespace for the bucket key. express-rate-limit
   *   forbids sharing one store instance across limiters, and distinct
   *   prefixes keep each limiter window counter independent in the shared
   *   `rate_limit_buckets` table (e.g. 'std' vs 'sens').
   */
  constructor(
    private readonly windowMs: number,
    private readonly keyPrefix = ''
  ) {}

  /**
   * express-rate-limit uses this namespace when checking whether two
   * limiter instances count the same request key. Exposing it prevents
   * ERR_ERL_DOUBLE_COUNT false positives for our separate std/sens buckets.
   */
  get prefix(): string {
    return this.keyPrefix ? `${this.keyPrefix}:` : '';
  }

  private bucketKey(key: string): string {
    // Keys are short hashes already; cap defensively.
    return `${this.prefix}${key}`.slice(0, 200);
  }

  /** Atomic window increment: one UPSERT, race-free across instances. */
  async increment(key: string): Promise<RateLimitBucket> {
    const bucketKey = this.bucketKey(key);
    const rows = await query<BucketRow>(
      `INSERT INTO rate_limit_buckets (bucket_key, window_start, hit_count)
       VALUES ($1, NOW(), 1)
       ON CONFLICT (bucket_key) DO UPDATE SET
         hit_count = CASE
           WHEN rate_limit_buckets.window_start < NOW() - ($2 || ' milliseconds')::interval THEN 1
           ELSE rate_limit_buckets.hit_count + 1
         END,
         window_start = CASE
           WHEN rate_limit_buckets.window_start < NOW() - ($2 || ' milliseconds')::interval THEN NOW()
           ELSE rate_limit_buckets.window_start
         END
       RETURNING hit_count,
                 window_start,
                 (EXTRACT(EPOCH FROM (window_start + ($2 || ' milliseconds')::interval)) * 1000) AS reset_time_ms`,
      [bucketKey, String(this.windowMs)]
    );
    const row = rows[0];
    return {
      totalHits: Number(row?.hit_count || 0),
      resetTime: new Date(Number(row?.reset_time_ms || Date.now() + this.windowMs)),
    };
  }

  async decrement(key: string): Promise<void> {
    await query(
      'UPDATE rate_limit_buckets SET hit_count = GREATEST(hit_count - 1, 0) WHERE bucket_key = $1',
      [this.bucketKey(key)]
    );
  }

  async resetKey(key: string): Promise<void> {
    await query('DELETE FROM rate_limit_buckets WHERE bucket_key = $1', [this.bucketKey(key)]);
  }

  /** Maintenance: drop expired buckets (never called on the hot path). */
  async pruneExpired(): Promise<number> {
    const rows = await query<{ bucket_key: string }>(
      'DELETE FROM rate_limit_buckets WHERE window_start < NOW() - ($1 || \' milliseconds\')::interval RETURNING bucket_key',
      [String(this.windowMs)]
    );
    return rows.length;
  }
}
