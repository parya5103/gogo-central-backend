/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Security events repository (OWASP API telemetry). Client IPs are stored
 * only as truncated sha256 hashes (or 'unknown'), never raw.
 */

import { createHash } from 'node:crypto';
import { query } from '../db/pool.ts';
import type { SecurityEventRecord } from '../types/gogo.ts';

interface SecurityRow {
  event_id: string;
  event_type: SecurityEventRecord['eventType'];
  app_id: string;
  actor_ip_hash: string;
  endpoint: string;
  severity: string;
  mitigation_applied: string;
  created_at: Date;
}

function toRecord(row: SecurityRow): SecurityEventRecord {
  const severity: SecurityEventRecord['severity'] =
    row.severity === 'low' || row.severity === 'medium' || row.severity === 'critical'
      ? row.severity
      : 'high';
  return {
    eventId: row.event_id,
    eventType: row.event_type,
    appId: row.app_id,
    actorIpHash: row.actor_ip_hash,
    endpoint: row.endpoint,
    severity,
    mitigationApplied: row.mitigation_applied,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

/** Truncated sha256 of the client IP (privacy-preserving), or 'unknown'.
 *  Same format as the in-memory engine: `sha256:<16 hex>`. */
export function hashClientIp(clientIp?: string | null): string {
  if (!clientIp) return 'unknown';
  return `sha256:${createHash('sha256').update(clientIp, 'utf-8').digest('hex').slice(0, 16)}`;
}

export async function insertSecurityEvent(event: {
  eventId: string;
  eventType: SecurityEventRecord['eventType'];
  appId: string;
  endpoint: string;
  severity: SecurityEventRecord['severity'];
  mitigationApplied: string;
  clientIpHash: string;
}): Promise<void> {
  await query(
    `INSERT INTO security_events
       (event_id, event_type, app_id, actor_ip_hash, endpoint, severity, mitigation_applied)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (event_id) DO NOTHING`,
    [
      event.eventId,
      event.eventType,
      event.appId,
      event.clientIpHash,
      event.endpoint,
      event.severity,
      event.mitigationApplied,
    ]
  );
}

export async function listSecurityEvents(limit: number): Promise<SecurityEventRecord[]> {
  const bounded = Math.min(Math.max(limit, 1), 200);
  const rows = await query<SecurityRow>(
    `SELECT event_id, event_type, app_id, actor_ip_hash, endpoint, severity,
            mitigation_applied, created_at
     FROM security_events ORDER BY created_at DESC LIMIT ${bounded}`
  );
  return rows.map(toRecord);
}

export async function countSecurityEvents(): Promise<number> {
  const rows = await query<{ count: string }>('SELECT COUNT(*) AS count FROM security_events');
  return Number(rows[0]?.count || 0);
}
