/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Notification campaigns repository. This is the heart of the distributed
 * idempotency design:
 * - Atomic reservation via INSERT ... ON CONFLICT (idempotency_key) DO NOTHING.
 * - payload_hash (sha256) distinguishes replay (same payload) from conflict
 *   (different payload with the same key → HTTP 409 upstream).
 * - Worker claims use atomic status transitions; FOR UPDATE SKIP LOCKED is
 *   used by claimDueCampaigns so multiple instances never double-process.
 */

import { query } from '../db/pool.ts';
import type { NotificationCampaignRecord, TargetScope, CampaignStatus } from '../types/gogo.ts';

interface CampaignRow {
  notification_id: string;
  idempotency_key: string;
  app_id: string;
  target_type: string;
  target_value: string;
  platform: string;
  title: string;
  body: string;
  deep_link: string;
  scheduled_for: Date | null;
  status: string;
  sent_count: number;
  failed_count: number;
  retry_count: number;
  author_id: string;
  payload_hash: string;
  processing_locked_at: Date | null;
  locked_by: string | null;
  next_retry_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

function toRecord(row: CampaignRow): NotificationCampaignRecord {
  return {
    notificationId: row.notification_id,
    idempotencyKey: row.idempotency_key,
    appId: row.app_id,
    targetType: row.target_type as TargetScope,
    targetValue: row.target_value,
    platform: row.platform === 'web' ? 'web' : row.platform === 'android' ? 'android' : 'all',
    title: row.title,
    body: row.body,
    deepLink: row.deep_link,
    scheduledFor: row.scheduled_for ? new Date(row.scheduled_for).toISOString() : null,
    status: row.status as CampaignStatus,
    sentCount: row.sent_count,
    failedCount: row.failed_count,
    retryCount: row.retry_count,
    authorId: row.author_id,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

const SELECT_CAMPAIGNS = `SELECT notification_id, idempotency_key, app_id, target_type, target_value,
  platform, title, body, deep_link, scheduled_for, status, sent_count, failed_count,
  retry_count, author_id, payload_hash, processing_locked_at, locked_by, next_retry_at,
  created_at, updated_at FROM notification_campaigns`;

/**
 * Atomic idempotency reservation. Returns the inserted row, or null when the
 * idempotency_key already exists (the caller then compares payload hashes).
 */
export async function insertCampaignIfAbsent(params: {
  notificationId: string;
  idempotencyKey: string;
  appId: string;
  targetType: TargetScope;
  targetValue: string;
  platform: 'all' | 'web' | 'android';
  title: string;
  body: string;
  deepLink: string;
  scheduledFor: string | null;
  authorId: string;
  payloadHash: string;
}): Promise<NotificationCampaignRecord | null> {
  const rows = await query<{ notification_id: string }>(
    `INSERT INTO notification_campaigns
       (notification_id, idempotency_key, app_id, target_type, target_value, platform,
        title, body, deep_link, scheduled_for, status, author_id, payload_hash)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
             CASE WHEN $10::timestamptz IS NULL OR $10::timestamptz <= NOW() THEN 'queued' ELSE 'scheduled' END,
             $11, $12)
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING notification_id`,
    [
      params.notificationId,
      params.idempotencyKey,
      params.appId,
      params.targetType,
      params.targetValue,
      params.platform,
      params.title,
      params.body,
      params.deepLink,
      params.scheduledFor,
      params.authorId,
      params.payloadHash,
    ]
  );
  if (rows.length === 0) return null;
  const campaign = await getCampaign(params.notificationId);
  if (!campaign) throw new Error('CAMPAIGN_INSERT_FAILED');
  return campaign;
}

export async function getCampaignByIdempotencyKey(
  idempotencyKey: string
): Promise<{ campaign: NotificationCampaignRecord; payloadHash: string } | null> {
  const rows = await query<CampaignRow>(`${SELECT_CAMPAIGNS} WHERE idempotency_key = $1`, [
    idempotencyKey,
  ]);
  return rows[0] ? { campaign: toRecord(rows[0]), payloadHash: rows[0].payload_hash } : null;
}

export async function getCampaign(
  notificationId: string
): Promise<NotificationCampaignRecord | null> {
  const rows = await query<CampaignRow>(`${SELECT_CAMPAIGNS} WHERE notification_id = $1`, [
    notificationId,
  ]);
  return rows[0] ? toRecord(rows[0]) : null;
}

export async function listCampaigns(filter: {
  visibleToUid?: string;
  limit?: number;
}): Promise<NotificationCampaignRecord[]> {
  const limit = Math.min(Math.max(filter.limit ?? 500, 1), 1000);
  if (filter.visibleToUid) {
    // Non-admin visibility mirrors the engine: product/ecosystem campaigns or
    // campaigns whose target is the caller.
    const rows = await query<CampaignRow>(
      `${SELECT_CAMPAIGNS}
       WHERE target_type IN ('product', 'ecosystem') OR target_value = $1
       ORDER BY created_at DESC LIMIT ${limit}`,
      [filter.visibleToUid]
    );
    return rows.map(toRecord);
  }
  const rows = await query<CampaignRow>(
    `${SELECT_CAMPAIGNS} ORDER BY created_at DESC LIMIT ${limit}`
  );
  return rows.map(toRecord);
}

export async function countCampaigns(): Promise<number> {
  const rows = await query<{ count: string }>('SELECT COUNT(*) AS count FROM notification_campaigns');
  return Number(rows[0]?.count || 0);
}

/** Atomic single-campaign claim for the worker (inline or loop path). */
export async function claimCampaign(
  notificationId: string,
  workerId: string
): Promise<NotificationCampaignRecord | null> {
  const rows = await query<{ notification_id: string }>(
    `UPDATE notification_campaigns SET
       status = 'processing', processing_locked_at = NOW(), locked_by = $2, updated_at = NOW()
     WHERE notification_id = $1
       AND status IN ('queued', 'scheduled')
       AND (scheduled_for IS NULL OR scheduled_for <= NOW())
     RETURNING notification_id`,
    [notificationId, workerId]
  );
  if (rows.length === 0) return null;
  const campaign = await getCampaign(notificationId);
  return campaign;
}

/**
 * Bulk due-campaign reservation with FOR UPDATE SKIP LOCKED. Concurrent workers
 * on different instances always receive disjoint campaign sets.
 */
export async function claimDueCampaigns(
  limit: number,
  workerId: string
): Promise<NotificationCampaignRecord[]> {
  const rows = await query<{ notification_id: string }>(
    `UPDATE notification_campaigns SET
       status = 'processing', processing_locked_at = NOW(), locked_by = $2, updated_at = NOW()
     WHERE notification_id IN (
       SELECT notification_id FROM notification_campaigns
       WHERE status IN ('scheduled', 'queued')
         AND (scheduled_for IS NULL OR scheduled_for <= NOW())
       ORDER BY created_at
       LIMIT $1
       FOR UPDATE SKIP LOCKED
     )
     RETURNING notification_id`,
    [limit, workerId]
  );
  const campaigns: NotificationCampaignRecord[] = [];
  for (const row of rows) {
    const campaign = await getCampaign(row.notification_id);
    if (campaign) campaigns.push(campaign);
  }
  return campaigns;
}

/** Reclaims campaigns stuck in 'processing' past the timeout (crash recovery). */
export async function reclaimStaleProcessing(
  staleMinutes: number
): Promise<string[]> {
  const rows = await query<{ notification_id: string }>(
    `UPDATE notification_campaigns SET
       status = 'queued', processing_locked_at = NULL, locked_by = NULL, updated_at = NOW()
     WHERE status = 'processing'
       AND processing_locked_at < NOW() - ($1 || ' minutes')::interval
     RETURNING notification_id`,
    [String(staleMinutes)]
  );
  return rows.map((r) => r.notification_id);
}

/** Final honest status after processing, derived from delivery receipts. */
export async function finalizeCampaign(
  notificationId: string,
  outcome: { status: CampaignStatus; sentCount: number; failedCount: number }
): Promise<NotificationCampaignRecord | null> {
  await query(
    `UPDATE notification_campaigns SET
       status = $2, sent_count = $3, failed_count = $4,
       processing_locked_at = NULL, locked_by = NULL, updated_at = NOW()
     WHERE notification_id = $1`,
    [notificationId, outcome.status, outcome.sentCount, outcome.failedCount]
  );
  return getCampaign(notificationId);
}

/** Marks a processing attempt as crashed; queues a bounded retry. */
export async function markCampaignProcessingError(
  notificationId: string,
  backoffSeconds: number,
  maxRetries: number
): Promise<void> {
  await query(
    `UPDATE notification_campaigns SET
       status = CASE WHEN retry_count >= $3 THEN 'failed' ELSE 'queued' END,
       processing_locked_at = NULL, locked_by = NULL,
       retry_count = retry_count + 1,
       next_retry_at = NOW() + ($2 || ' seconds')::interval,
       updated_at = NOW()
     WHERE notification_id = $1`,
    [notificationId, String(backoffSeconds), Math.min(Math.max(maxRetries, 0), 10)]
  );
}

export async function incrementCampaignRetryCount(notificationId: string): Promise<void> {
  await query(
    'UPDATE notification_campaigns SET retry_count = retry_count + 1, updated_at = NOW() WHERE notification_id = $1',
    [notificationId]
  );
}

/** Retention cleanup: only terminal-status campaigns, never in-flight keys. */
export async function pruneTerminalCampaignsOlderThan(
  retentionDays: number
): Promise<string[]> {
  if (retentionDays <= 0) return [];
  const rows = await query<{ notification_id: string }>(
    `DELETE FROM notification_campaigns
     WHERE status IN ('delivered', 'failed', 'partial_failure')
       AND created_at < NOW() - ($1 || ' days')::interval
     RETURNING notification_id`,
    [String(retentionDays)]
  );
  return rows.map((r) => r.notification_id);
}

/** Campaigns that still have retryable transient deliveries. */
export async function listCampaignsWithRetryableDeliveries(
  maxDeliveryRetries: number,
  limit: number
): Promise<string[]> {
  const rows = await query<{ notification_id: string }>(
    `SELECT DISTINCT d.notification_id FROM notification_deliveries d
     JOIN notification_campaigns c ON c.notification_id = d.notification_id
     WHERE d.status = 'failed_transient'
       AND d.retry_count < $1
       AND (d.next_attempt_at IS NULL OR d.next_attempt_at <= NOW())
       AND c.status IN ('failed', 'partial_failure', 'delivered')
     LIMIT $2`,
    [maxDeliveryRetries, limit]
  );
  return rows.map((r) => r.notification_id);
}
