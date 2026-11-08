/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Audit log repository. Audit records are append-only and bounded reads are
 * newest-first, matching the in-memory engine's unshift+slice semantics.
 */

import { query } from '../db/pool.ts';
import type { AuditLogRecord } from '../types/gogo.ts';

interface AuditRow {
  log_id: string;
  actor_id: string;
  app_id: string;
  action: string;
  resource_id: string;
  severity: string;
  details: string;
  created_at: Date;
}

function toRecord(row: AuditRow): AuditLogRecord {
  return {
    logId: row.log_id,
    actorId: row.actor_id,
    appId: row.app_id,
    action: row.action,
    resourceId: row.resource_id,
    severity: row.severity === 'warn' ? 'warn' : row.severity === 'critical' ? 'critical' : 'info',
    details: row.details,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

export async function insertAuditLog(entry: {
  logId: string;
  actorId: string;
  appId: string;
  action: string;
  resourceId: string;
  severity: 'info' | 'warn' | 'critical';
  details: string;
}): Promise<void> {
  await query(
    `INSERT INTO audit_logs (log_id, actor_id, app_id, action, resource_id, severity, details)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (log_id) DO NOTHING`,
    [entry.logId, entry.actorId, entry.appId, entry.action, entry.resourceId, entry.severity, entry.details]
  );
}

export async function listAuditLogs(limit: number): Promise<AuditLogRecord[]> {
  const bounded = Math.min(Math.max(limit, 1), 200);
  const rows = await query<AuditRow>(
    `SELECT log_id, actor_id, app_id, action, resource_id, severity, details, created_at
     FROM audit_logs ORDER BY created_at DESC LIMIT ${bounded}`
  );
  return rows.map(toRecord);
}

export async function countAuditLogs(): Promise<number> {
  const rows = await query<{ count: string }>('SELECT COUNT(*) AS count FROM audit_logs');
  return Number(rows[0]?.count || 0);
}
