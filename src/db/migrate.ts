/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Versioned migration runner for GoGo Central Backend (PostgreSQL 18).
 *
 * - Tracks applied migrations in a `schema_migrations` table with a sha256
 *   checksum per file.
 * - Applies pending ./migrations/*.sql files in lexicographic order.
 * - Each migration file is responsible for its own BEGIN/COMMIT transaction
 *   (executed via the simple query protocol on a dedicated client).
 * - Re-runs are no-ops (already-applied versions are skipped).
 * - Fails loudly when an applied migration's checksum no longer matches the
 *   file on disk (tampering / partial edits).
 * - A PostgreSQL advisory lock prevents two instances from migrating
 *   concurrently (Cloud Run multi-instance safe).
 */

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { getPool, mapPgError, query } from './pool.ts';

export interface MigrationRecord {
  version: string;
  name: string;
  checksum: string;
  appliedAt: string;
}

export interface MigrationRunReport {
  applied: string[];
  skipped: string[];
  totalKnown: number;
  durationMs: number;
}

function migrationsDir(): string {
  return fileURLToPath(new URL('../../migrations', import.meta.url));
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf-8').digest('hex');
}

function listMigrationFiles(): { version: string; name: string; file: string }[] {
  const dir = migrationsDir();
  if (!existsSync(dir)) {
    throw new Error(`MIGRATION_DIR_MISSING: expected migrations directory at ${dir}`);
  }
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((file) => {
      const version = file.split('_')[0];
      return { version, name: file, file: path.join(dir, file) };
    });
}

const MIGRATION_LOCK_KEY = 'gogo_central_schema_migrations';

/** Applies all pending migrations. Safe to call concurrently and repeatedly. */
export async function runMigrations(): Promise<MigrationRunReport> {
  const startedAt = Date.now();
  const pool = getPool();
  const lockClient = await pool.connect();
  let applied: string[] = [];
  const skipped: string[] = [];

  try {
    // Serialize migrations across instances (advisory lock, session-scoped).
    await lockClient.query('SELECT pg_advisory_lock(hashtext($1))', [MIGRATION_LOCK_KEY]);

    await lockClient.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version VARCHAR(32) PRIMARY KEY,
        name TEXT NOT NULL,
        checksum VARCHAR(64) NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    const existingRows = await lockClient.query<{
      version: string;
      name: string;
      checksum: string;
    }>('SELECT version, name, checksum FROM schema_migrations');
    const appliedMap = new Map<string, { name: string; checksum: string }>();
    for (const row of existingRows.rows) {
      appliedMap.set(row.version, { name: row.name, checksum: row.checksum });
    }

    const files = listMigrationFiles();
    for (const migration of files) {
      const text = readFileSync(migration.file, 'utf-8');
      const checksum = sha256(text);
      const existing = appliedMap.get(migration.version);

      if (existing) {
        if (existing.checksum !== checksum) {
          throw new Error(
            `MIGRATION_CHECKSUM_MISMATCH: migrations/${migration.name} was already applied with a different checksum. ` +
              'Restore the original file or resolve the change manually. Never edit an applied migration.'
          );
        }
        skipped.push(migration.version);
        continue;
      }

      // Dedicated client per migration; the file itself wraps in BEGIN/COMMIT.
      const client = await pool.connect();
      try {
        await client.query(text);
        await client.query(
          'INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)',
          [migration.version, migration.name, checksum]
        );
        applied.push(migration.version);
        console.log(
          JSON.stringify({
            level: 'INFO',
            service: 'gogo-central-backend',
            component: 'migrations',
            message: `Applied migration ${migration.version} (${migration.name})`,
          })
        );
      } catch (error) {
        try {
          await client.query('ROLLBACK');
        } catch {
          // Transaction already aborted / connection lost.
        }
        throw mapPgError(error);
      } finally {
        client.release();
      }
    }

    return {
      applied,
      skipped,
      totalKnown: files.length,
      durationMs: Date.now() - startedAt,
    };
  } finally {
    try {
      await lockClient.query('SELECT pg_advisory_unlock(hashtext($1))', [MIGRATION_LOCK_KEY]);
    } catch {
      // Connection dropped; server-side session lock releases automatically.
    }
    lockClient.release();
  }
}

/** Lists the applied migration records (for diagnostics endpoints). */
export async function listAppliedMigrations(): Promise<MigrationRecord[]> {
  const rows = await query<{ version: string; name: string; checksum: string; applied_at: Date }>(
    'SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version'
  );
  return rows.map((r) => ({
    version: r.version,
    name: r.name,
    checksum: r.checksum,
    appliedAt: new Date(r.applied_at).toISOString(),
  }));
}
