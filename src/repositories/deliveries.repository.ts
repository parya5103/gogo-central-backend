/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Delivery receipts repository. Receipts are idempotent per
 * (notification_id, device_id): a worker retry updates the existing row
 * instead of duplicating it, and counts are always derived from real rows.
 */

import { query } from '../db/pool.ts';
import type { DeliveryReceiptRecord, ClientPlatform } from '../types/gogo.ts';

type ReceiptStatus = DeliveryReceiptRecord['status'];

interface DeliveryRow {
  delivery_id: string;
  notification_id: string;
  device_id: string;
  user_id: string;
  app_id: string;
  platform: string;
  status: string;
  attempt_count: number;
  fcm_message_id: string | null;
  error_code: string | null;
  skip_reason: string | null;
  retry_count: number;
  next_attempt_at: Date | null;
  delivered_at: Date;
}

function toRecord(row: DeliveryRow): DeliveryReceiptRecord {
  return {
    deliveryId: row.delivery_id,
    notificationId: row.notification_id,
    deviceId: row.device_id,
    userId: row.user_id,
    appId: row.app_id,
    platform: row.platform === 'android' ? 'android' : 'web',
    status: row.status as ReceiptStatus,
    attemptCount: row.attempt_count,
    fcmMessageId: row.fcm_message_id,
    errorCode: row.error_code,
    deliveredAt: new Date(row.delivered_at).toISOString(),
  };
}

const SELECT_DELIVERIES = `SELECT delivery_id, notification_id, device_id, user_id, app_id,
  platform, status, attempt_count, fcm_message_id, error_code, skip_reason, retry_count,
  next_attempt_at, delivered_at FROM notification_deliveries`;

/**
 * Idempotent receipt insert: ON CONFLICT (notification_id, device_id) keeps
 * exactly one receipt per device per campaign.
 */
export async function insertDeliveryReceipt(
  receipt: Omit<DeliveryReceiptRecord, 'deliveredAt'> & { skipReason?: string | null }
): Promise<DeliveryReceiptRecord | null> {
  const rows = await query<{ delivery_id: string }>(
    `INSERT INTO notification_deliveries
       (delivery_id, notification_id, device_id, user_id, app_id, platform, status,
        attempt_count, fcm_message_id, error_code, skip_reason)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (notification_id, device_id) DO NOTHING
     RETURNING delivery_id`,
    [
      receipt.deliveryId,
      receipt.notificationId,
      receipt.deviceId,
      receipt.userId,
      receipt.appId,
      receipt.platform,
      receipt.status,
      receipt.attemptCount,
      receipt.fcmMessageId,
      receipt.errorCode,
      receipt.skipReason ?? null,
    ]
  );
  if (rows.length === 0) return null;
  return getDelivery(receipt.deliveryId);
}

export async function getDelivery(deliveryId: string): Promise<DeliveryReceiptRecord | null> {
  const rows = await query<DeliveryRow>(`${SELECT_DELIVERIES} WHERE delivery_id = $1`, [
    deliveryId,
  ]);
  return rows[0] ? toRecord(rows[0]) : null;
}

export async function listDeliveries(filter: {
  userId?: string;
  campaignId?: string;
  limit?: number;
}): Promise<DeliveryReceiptRecord[]> {
  const limit = Math.min(Math.max(filter.limit ?? 100, 1), 500);
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (filter.userId) {
    params.push(filter.userId);
    conditions.push(`user_id = $${params.length}`);
  }
  if (filter.campaignId) {
    params.push(filter.campaignId);
    conditions.push(`notification_id = $${params.length}`);
  }
  const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';
  const rows = await query<DeliveryRow>(
    `${SELECT_DELIVERIES}${where} ORDER BY delivered_at DESC LIMIT ${limit}`,
    params
  );
  return rows.map(toRecord);
}

/** Honest receipt-derived counts for a campaign. */
export async function countCampaignOutcomes(
  notificationId: string
): Promise<{ sentCount: number; failedCount: number; skippedCount: number }> {
  const rows = await query<{ status: string; count: string }>(
    `SELECT status, COUNT(*) AS count FROM notification_deliveries
     WHERE notification_id = $1 GROUP BY status`,
    [notificationId]
  );
  let sentCount = 0;
  let failedCount = 0;
  let skippedCount = 0;
  for (const row of rows) {
    if (row.status === 'delivered') sentCount += Number(row.count);
    else if (row.status.startsWith('skipped')) skippedCount += Number(row.count);
    else failedCount += Number(row.count);
  }
  return { sentCount, failedCount, skippedCount };
}

/** Retryable transient receipts for one campaign (bounded by maxRetries). */
export async function getRetryableDeliveries(
  notificationId: string,
  maxRetries: number
): Promise<(DeliveryReceiptRecord & { retryCount: number; deviceId: string })[]> {
  const rows = await query<DeliveryRow>(
    `${SELECT_DELIVERIES}
     WHERE notification_id = $1 AND status = 'failed_transient' AND retry_count < $2`,
    [notificationId, maxRetries]
  );
  return rows.map((r) => ({
    ...toRecord(r),
    retryCount: r.retry_count,
    deviceId: r.device_id,
  }));
}

export async function updateDeliveryOutcome(
  deliveryId: string,
  outcome: {
    status: ReceiptStatus;
    errorCode: string | null;
    fcmMessageId: string | null;
    retryCount: number;
    nextAttemptAt: Date | null;
  }
): Promise<void> {
  await query(
    `UPDATE notification_deliveries SET
       status = $2, error_code = $3, fcm_message_id = $4, retry_count = $5,
       next_attempt_at = $6, attempt_count = attempt_count + 1, delivered_at = NOW()
     WHERE delivery_id = $1`,
    [deliveryId, outcome.status, outcome.errorCode, outcome.fcmMessageId, outcome.retryCount, outcome.nextAttemptAt]
  );
}

/**
 * Permanent-failure receipts, newest first, paginated (admin diagnostics).
 * Returns only what receipts already carry: no FCM tokens, no contact PII.
 */
export async function listFailedPermanentDeliveries(
  limit: number,
  offset: number
): Promise<{ items: DeliveryReceiptRecord[]; total: number }> {
  const rows = await query<DeliveryRow>(
    `${SELECT_DELIVERIES} WHERE status = 'failed_permanent' ORDER BY delivered_at DESC LIMIT $1 OFFSET $2`,
    [limit, offset]
  );
  const countRows = await query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM notification_deliveries WHERE status = 'failed_permanent'`
  );
  return { items: rows.map(toRecord), total: Number(countRows[0]?.count || 0) };
}

export async function countDeliveriesForDevice(deviceId: string): Promise<number> {
  const rows = await query<{ count: string }>(
    'SELECT COUNT(*) AS count FROM notification_deliveries WHERE device_id = $1',
    [deviceId]
  );
  return Number(rows[0]?.count || 0);
}

export type { ClientPlatform };
