/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * GoGo Central Backend — Cross-Platform Database Migration, Backup & Restore CLI
 * Works natively on Linux, Docker, macOS, Windows, and Android Termux.
 *
 * Usage:
 *   npm run db:verify
 *   npm run db:backup
 *   npm run db:restore [path/to/backup.sql]
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  resolvePostgresConfig,
  verifyPostgresMigrationFile,
  generateTransactionalSqlBackup,
} from '../src/db/postgres-config.ts';
import { backendStore } from '../src/server/store.ts';

const action = process.argv[2] || 'verify';
const argFile = process.argv[3];

function runCli() {
  const pgConfig = resolvePostgresConfig();
  const backupDir = path.resolve(process.cwd(), 'backups');

  if (action === 'verify') {
    const schemaReport = verifyPostgresMigrationFile();
    if (!schemaReport.valid) {
      console.error('[FAIL] PostgreSQL migration verification failed:', schemaReport);
      process.exit(1);
    }
    console.log(
      JSON.stringify(
        {
          action,
          status: 'VERIFIED',
          providerConfig: {
            provider: pgConfig.provider,
            engineVersion: pgConfig.engineVersion,
            host: pgConfig.host,
            port: pgConfig.port,
            database: pgConfig.database,
            poolMax: pgConfig.pool.max,
            zeroCostCompatible: pgConfig.zeroCostCompatible,
          },
          schemaReport,
        },
        null,
        2
      )
    );
    return;
  }

  if (action === 'backup') {
    fs.mkdirSync(backupDir, { recursive: true });
    const sqlDump = generateTransactionalSqlBackup(backendStore);
    const latestFile = path.join(backupDir, 'gogo_central_latest.sql');
    fs.writeFileSync(latestFile, sqlDump, 'utf-8');
    console.log(
      JSON.stringify(
        {
          action: 'backup',
          status: 'SUCCESS',
          file: 'backups/gogo_central_latest.sql',
          bytes: Buffer.byteLength(sqlDump, 'utf-8'),
          tablesExported: [
            'users',
            'registered_applications',
            'user_app_roles',
            'device_tokens',
            'notification_preferences',
            'notification_campaigns',
            'notification_deliveries',
            'audit_logs',
            'security_events',
            'system_configs',
          ],
          scope: 'in-memory demo state only',
          note: 'IMPORTANT: In PostgreSQL runtime mode this SQL export contains ONLY the in-memory demo seeds — it is NOT a backup of your production data. For PostgreSQL backups use scripts/backup-restore.sh (pg_dump custom format).',
        },
        null,
        2
      )
    );
    return;
  }

  if (action === 'restore') {
    const targetFile = argFile
      ? path.resolve(process.cwd(), argFile)
      : path.join(backupDir, 'gogo_central_latest.sql');

    if (!fs.existsSync(targetFile)) {
      console.error(`[FAIL] Backup file not found: ${targetFile}`);
      process.exit(1);
    }

    const content = fs.readFileSync(targetFile, 'utf-8');
    const hasBegin = content.includes('BEGIN;');
    const hasCommit = content.includes('COMMIT;');
    const statementCount = (content.match(/INSERT INTO /g) || []).length;

    if (!hasBegin || !hasCommit || statementCount === 0) {
      console.error('[FAIL] Backup file failed transactional BEGIN/COMMIT integrity check.');
      process.exit(1);
    }

    console.log(
      JSON.stringify(
        {
          action: 'restore',
          // HONEST STATUS: this command validates the backup file only.
          // It does NOT execute the SQL against a live database because the
          // backend does not bundle a PostgreSQL client yet. Actual restore:
          // docker compose exec -T postgres psql -U gogo_app_user -d gogo_central < backups/gogo_central_latest.sql
          status: 'RESTORE_FILE_VALIDATED',
          file: path.relative(process.cwd(), targetFile),
          transactionalSafety: 'BEGIN ... COMMIT verified',
          upsertStatementsVerified: statementCount,
          note: 'File integrity verified only. SQL was NOT executed against a database. Run manually via psql.',
        },
        null,
        2
      )
    );
    return;
  }

  console.error(`Unknown command '${action}'. Use: verify | migrate | backup | restore`);
  process.exit(1);
}

/**
 * Real migration runner: applies pending migrations/NNN_*.sql files to the
 * configured PostgreSQL database, tracked via the schema_migrations table
 * (checksummed, advisory-locked, safely repeatable).
 */
async function runMigrationsCli() {
  const { runMigrations, listAppliedMigrations } = await import(
    '../src/db/migrate.ts'
  );
  const started = Date.now();
  const applied = await runMigrations();
  const all = await listAppliedMigrations();
  const { closePool } = await import('../src/db/pool.ts');
  await closePool();
  console.log(
    JSON.stringify(
      {
        action: 'migrate',
        status: 'SUCCESS',
        appliedNow: applied,
        appliedTotal: all.length,
        migrations: all,
        durationMs: Date.now() - started,
        note: 'Migrations are tracked in schema_migrations with sha256 checksums. Re-running is safe: already-applied files are skipped; checksum mismatches fail loudly.',
      },
      null,
      2
    )
  );
}

if (action === 'migrate') {
  runMigrationsCli().catch((error) => {
    console.error(
      '[FAIL] Migration run failed:',
      error instanceof Error ? error.message : String(error)
    );
    process.exit(1);
  });
} else {
  runCli();
}
