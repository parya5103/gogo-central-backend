/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * PostgreSQL connection pool for GoGo Central Backend.
 *
 * Design notes:
 * - Single lazy pool per process, configured from SQL_* environment variables
 *   via the existing provider-aware resolvePostgresConfig() resolver.
 * - Bounded connection lifetime: connection timeout, query timeout,
 *   idle timeout. Cloud Run compatible (pool max kept modest).
 * - Parameterized SQL only; this module never interpolates user data.
 * - Structured JSON logging. Never logs passwords, tokens or query params.
 */

import { Pool, PoolClient, QueryResultRow } from 'pg';
import { resolvePostgresConfig } from './postgres-config.ts';

export class DatabaseUnavailableError extends Error {
  public readonly sanitizedCode: string;

  constructor(sanitizedCode: string, message: string) {
    super(message);
    this.name = 'DatabaseUnavailableError';
    this.sanitizedCode = sanitizedCode;
  }
}

let pool: Pool | null = null;

interface PoolRuntimeOptions {
  statementTimeoutMs: number;
  queryTimeoutMs: number;
}

function runtimeOptions(): PoolRuntimeOptions {
  return {
    statementTimeoutMs: Number(process.env.PG_STATEMENT_TIMEOUT_MS) || 15000,
    queryTimeoutMs: Number(process.env.PG_QUERY_TIMEOUT_MS) || 15000,
  };
}

/** Lazily creates (or returns) the shared connection pool. */
export function getPool(): Pool {
  if (pool) return pool;

  const provider = resolvePostgresConfig();
  const { statementTimeoutMs, queryTimeoutMs } = runtimeOptions();
  const password = process.env.SQL_PASSWORD || '';

  pool = new Pool({
    host: provider.host,
    port: provider.port,
    database: provider.database,
    user: provider.user,
    password,
    ssl: provider.ssl,
    max: provider.pool.max,
    min: provider.pool.min,
    idleTimeoutMillis: provider.pool.idleTimeoutMillis,
    connectionTimeoutMillis: provider.pool.connectionTimeoutMillis,
    // Per-connection guards (node-postgres client config):
    statement_timeout: statementTimeoutMs,
    query_timeout: queryTimeoutMs,
  });

  pool.on('error', (err: Error) => {
    // Idle client errors must not crash the process; they are logged sanitized.
    console.log(
      JSON.stringify({
        level: 'ERROR',
        service: 'gogo-central-backend',
        component: 'pg-pool',
        message: 'Idle pool client error',
        errorName: err.name,
      })
    );
  });

  return pool;
}

/** Maps low-level connection errors to sanitized, actionable errors. */
export function mapPgError(error: unknown): Error {
  const err = error as { code?: string; message?: string; name?: string };
  const code = String(err?.code || err?.name || 'unknown');
  if (code === 'ECONNREFUSED' || code === 'ETIMEDOUT' || code === 'ENOTFOUND' || code === 'EHOSTUNREACH') {
    return new DatabaseUnavailableError(
      'DB_UNREACHABLE',
      'Database unavailable: PostgreSQL is not reachable at the configured SQL_HOST:SQL_PORT. Service will not start with in-memory fallback in production.'
    );
  }
  if (code === '28P01') {
    return new DatabaseUnavailableError(
      'DB_AUTH_FAILED',
      'Database authentication failed (28P01): check the SQL_USER/SQL_PASSWORD credentials. No credentials are logged.'
    );
  }
  if (code === '3D000') {
    return new DatabaseUnavailableError(
      'DB_DATABASE_MISSING',
      'Database does not exist (3D000): create it or point SQL_DB_NAME at an existing database.'
    );
  }
  return error instanceof Error ? error : new Error(String(error));
}

/** Parameterized query helper returning typed rows. */
export async function query<T extends QueryResultRow>(
  text: string,
  params: readonly unknown[] = []
): Promise<T[]> {
  try {
    const result = await getPool().query<T>(text, params as unknown[]);
    return result.rows;
  } catch (error) {
    throw mapPgError(error);
  }
}

/**
 * Runs `fn` inside a single transaction on a dedicated client.
 * Commits on success; rolls back on any error and rethrows the original error.
 */
export async function withTransaction<T>(
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // Connection already broken; rollback failure is not masking the original error.
    }
    throw error;
  } finally {
    client.release();
  }
}

/** True connectivity probe with a short timeout. Never throws. */
export async function checkDatabaseHealth(): Promise<boolean> {
  try {
    await getPool().query({ text: 'SELECT 1 AS ok', values: [] });
    return true;
  } catch {
    return false;
  }
}

/** Gracefully drains the pool (SIGTERM / test teardown). */
export async function closePool(): Promise<void> {
  if (!pool) return;
  const closing = pool;
  pool = null;
  try {
    await closing.end();
  } catch {
    // Best-effort drain during shutdown.
  }
}
