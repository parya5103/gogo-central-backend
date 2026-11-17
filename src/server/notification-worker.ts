/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * PostgreSQL-backed notification worker for GoGo Central Backend.
 *
 * Restart-safe, multi-instance-safe campaign processing:
 * - Campaign reservation uses atomic status transitions; bulk scans use
 *   FOR UPDATE SKIP LOCKED so concurrent workers never overlap.
 * - Processing timeout recovery: campaigns stuck in 'processing' past a
 *   stale threshold are reclaimed to 'queued'.
 * - Bounded retries with exponential backoff + jitter, transient-only.
 * - Expired/unregistered FCM tokens mark the device expired (no retry).
 * - Honest sent/failed/skipped counts derived strictly from receipts.
 * - Graceful shutdown stops the loop without losing queued work: everything
 *   pending stays durable in PostgreSQL.
 *
 * FCM honesty contract (same as the engine):
 * - demo `fcm_*` tokens → simulated receipts with `simulated:` message IDs
 * - real tokens → sendFcmMulticast (Admin SDK) in 500-token chunks
 * - SDK error codes are read from the error's `code` property (canonical
 *   `messaging/*` string) before falling back to String(error)
 * - FCM_DRY_RUN=true keeps live sends in dry-run mode
 * - Delivery is at-least-once (durable dedup), never claimed exactly-once.
 */

import { sendFcmMulticast, FIREBASE_ADMIN_CONFIGURED } from '../lib/firebase-admin.ts';
import type {
  NotificationCampaignRecord,
  DeviceTokenRecord,
  DeliveryReceiptRecord,
  ClientPlatform,
} from '../types/gogo.ts';
import {
  claimCampaign,
  claimDueCampaigns,
  finalizeCampaign,
  getCampaign,
  incrementCampaignRetryCount,
  markCampaignProcessingError,
  reclaimStaleProcessing,
  listCampaignsWithRetryableDeliveries,
  pruneTerminalCampaignsOlderThan,
} from '../repositories/campaigns.repository.ts';
import {
  countCampaignOutcomes,
  getRetryableDeliveries,
  insertDeliveryReceipt,
  updateDeliveryOutcome,
} from '../repositories/deliveries.repository.ts';
import { getDevice, listDevices, markDeviceStatus, pruneNonFcmDeviceTokens } from '../repositories/devices.repository.ts';
import { getPreference } from '../repositories/preferences.repository.ts';
import { getUserTimezone } from '../repositories/users.repository.ts';
import { getNumberConfig, getSystemConfig } from '../repositories/config.repository.ts';
import { insertSecurityEvent, hashClientIp } from '../repositories/security.repository.ts';
import { insertAuditLog } from '../repositories/audit.repository.ts';
import {
  classifyFcmError,
  isMarketingTarget,
  isInQuietHours,
  prefSkipReason,
} from './campaign-rules.ts';

/**
 * Marks FCM message IDs produced under FCM_DRY_RUN=true so a validation-only
 * receipt can never be mistaken for a real delivered push (mirrors the
 * dry-run convention used for validation-only requests). Capped to VARCHAR(128)
 * fcm_message_id column.
 */
function markDryRunMessageId(messageId: string | null): string | null {
  if (process.env.FCM_DRY_RUN !== 'true' || !messageId) return messageId;
  return `dryrun:${messageId}`.slice(0, 128);
}

/**
 * Extracts the machine-readable FCM error code. Firebase SDK errors carry the
 * canonical `code` property (e.g. messaging/registration-token-not-registered);
 * String(error) alone renders only the human message, which would defeat
 * classifyFcmError's substring matching (misclassifying expired tokens as
 * transient). Falls back to String(error) for non-SDK error shapes.
 */
function extractFcmErrorCode(error: unknown): string {
  if (error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string') {
    return (error as { code: string }).code;
  }
  return error ? String(error) : 'messaging/unknown-error';
}

const FCM_MULTICAST_CHUNK = 500;

/** Exponential backoff with jitter: base 2^attempt * (1000ms) ± 25%. */
export function backoffWithJitter(attempt: number): number {
  const baseSeconds = Math.min(Math.pow(2, Math.min(attempt, 6)), 64);
  const jitter = 0.75 + Math.random() * 0.5;
  return Math.max(1, Math.round(baseSeconds * jitter));
}

function newId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
}

export interface DeliveryOutcome {
  receipts: DeliveryReceiptRecord[];
  sentCount: number;
  failedCount: number;
  skippedCount: number;
}

export class NotificationWorker {
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;

  constructor(private readonly workerId = `worker_${process.pid}`) {}

  /**
   * Claims and processes a single campaign. Returns the final campaign, or
   * null when the campaign does not exist. When another worker already owns
   * the claim, returns the campaign in its current state without delivering.
   */
  async processCampaign(notificationId: string): Promise<NotificationCampaignRecord | null> {
    const claimed = await claimCampaign(notificationId, this.workerId);
    if (!claimed) {
      return getCampaign(notificationId);
    }
    return this.deliverClaimedCampaign(claimed);
  }

  private async deliverClaimedCampaign(
    campaign: NotificationCampaignRecord
  ): Promise<NotificationCampaignRecord> {
    try {
      const outcome = await this.deliverCampaign(campaign);
      // Engine-compatible status: any failed receipt → partial_failure, else delivered.
      const status = outcome.failedCount > 0 ? 'partial_failure' : 'delivered';
      const final = await finalizeCampaign(campaign.notificationId, {
        status,
        sentCount: outcome.sentCount,
        failedCount: outcome.failedCount,
      });
      await insertAuditLog({
        logId: newId('audit'),
        actorId: campaign.authorId,
        appId: campaign.appId,
        action: 'NOTIFICATION_DISPATCH',
        resourceId: campaign.notificationId,
        severity: 'info',
        details: `Dispatched ${campaign.targetType} FCM campaign (${outcome.sentCount} delivered, ${outcome.failedCount} failed, ${outcome.skippedCount} skipped).`,
      });
      return final ?? campaign;
    } catch (error) {
      if (error instanceof Error && error.message === 'FIREBASE_ADMIN_NOT_CONFIGURED') {
        const failed = await finalizeCampaign(campaign.notificationId, {
          status: 'failed',
          sentCount: 0,
          failedCount: 0,
        });
        console.error('[FCM] Campaign failed: FIREBASE_ADMIN_NOT_CONFIGURED', {
          notificationId: campaign.notificationId,
          projectId: process.env.FIREBASE_PROJECT_ID || 'gen-lang-client-0566323659',
        });
        return failed ?? campaign;
      }
      const maxRetries = await getNumberConfig('fcm_max_retries', 3);
      const backoffSeconds = backoffWithJitter(campaign.retryCount + 1);
      await markCampaignProcessingError(campaign.notificationId, backoffSeconds, maxRetries);
      console.log(
        JSON.stringify({
          level: 'ERROR',
          service: 'gogo-central-backend',
          component: 'notification-worker',
          message: 'Campaign processing failed; requeued with backoff',
          notificationId: campaign.notificationId,
          retryInSeconds: backoffSeconds,
          errorName: error instanceof Error ? error.name : 'unknown',
        })
      );
      const updated = await getCampaign(campaign.notificationId);
      return updated ?? campaign;
    }
  }

  /** Resolves candidate devices with the engine's exact targeting rules. */
  private async resolveCandidates(
    campaign: Pick<NotificationCampaignRecord, 'appId' | 'platform' | 'targetType' | 'targetValue'>
  ): Promise<DeviceTokenRecord[]> {
    // Fail-closed: topic targeting has no device-subscription model yet.
    // Never degrade a topic campaign into a broadcast.
    if (campaign.targetType === 'topic') {
      throw new Error('TOPIC_TARGETING_NOT_IMPLEMENTED: FCM topic delivery is not implemented.');
    }
    const devices = await listDevices(
      campaign.appId !== 'all-gogo' ? { appId: campaign.appId } : {}
    );
    return devices.filter((dev) => {
      if (dev.status !== 'active') return false;
      if (campaign.platform !== 'all' && dev.platform !== campaign.platform) return false;
      if (campaign.targetType === 'individual' || campaign.targetType === 'targeted') {
        return dev.userId === campaign.targetValue || dev.deviceId === campaign.targetValue;
      }
      return true;
    });
  }

  /**
   * Honest delivery pass over candidate devices. Writes idempotent receipts
   * (one per notification × device). Mirrors engine deliverToDevices.
   */
  async deliverCampaign(campaign: NotificationCampaignRecord): Promise<DeliveryOutcome> {
    if (process.env.NODE_ENV === 'production' && !FIREBASE_ADMIN_CONFIGURED) {
      throw new Error('FIREBASE_ADMIN_NOT_CONFIGURED');
    }
    if (process.env.NODE_ENV === 'production' && process.env.FCM_DRY_RUN !== 'true') {
      const pruned = await pruneNonFcmDeviceTokens();
      if (pruned > 0) console.warn('[FCM] Pruned non-FCM device tokens before dispatch:', pruned);
    }
    const candidates = await this.resolveCandidates(campaign);
    const isMarketing = isMarketingTarget(campaign.targetType);
    const quietHoursEnforced =
      (await getSystemConfig('global_quiet_hours_enforced'))?.configValue !== 'false';

    const receipts: DeliveryReceiptRecord[] = [];
    const realDevices: DeviceTokenRecord[] = [];

    const recordReceipt = async (
      dev: DeviceTokenRecord,
      status: DeliveryReceiptRecord['status'],
      errorCode: string | null,
      fcmMessageId: string | null,
      skipReason: string | null
    ): Promise<void> => {
      const receipt = await insertDeliveryReceipt({
        deliveryId: newId('del'),
        notificationId: campaign.notificationId,
        deviceId: dev.deviceId,
        userId: dev.userId,
        appId: dev.appId,
        platform: dev.platform,
        status,
        attemptCount: 1,
        fcmMessageId,
        errorCode,
        skipReason,
      });
      if (receipt) receipts.push(receipt);
    };

    for (const dev of candidates) {
      // Prune simulated-unregistered tokens before any send.
      if (dev.fcmToken.includes('expired') || dev.fcmToken.includes('unregistered')) {
        await markDeviceStatus(dev.deviceId, 'expired');
        await insertSecurityEvent({
          eventId: newId('sec'),
          eventType: 'EXPIRED_FCM_TOKEN_PRUNED',
          appId: dev.appId,
          endpoint: 'deliverCampaign',
          severity: 'low',
          mitigationApplied: `Marked ${dev.deviceId} status=expired before dispatch (unregistered token).`,
          clientIpHash: hashClientIp(null),
        });
        await recordReceipt(dev, 'failed_expired_token', 'messaging/registration-token-not-registered', null, null);
        continue;
      }

      // Server-side preference enforcement.
      const pref = await getPreference(dev.userId, dev.appId);
      const skipReason = prefSkipReason(pref, dev.platform, isMarketing);
      if (skipReason) {
        await recordReceipt(dev, 'skipped_preference', skipReason, null, skipReason);
        continue;
      }

      // Quiet hours: marketing only, in the user's own IANA timezone.
      if (isMarketing && quietHoursEnforced && pref) {
        const timeZone = await getUserTimezone(dev.userId);
        if (isInQuietHours(new Date(), pref.quietHoursStart, pref.quietHoursEnd, timeZone)) {
          await recordReceipt(dev, 'skipped_quiet_hours', 'user-quiet-hours', null, 'user-quiet-hours');
          continue;
        }
      }

      if (dev.fcmToken.startsWith('fcm_') || dev.fcmToken.trim().startsWith('{') || dev.fcmToken.trim().startsWith('[')) {
        await recordReceipt(dev, 'failed_permanent', 'messaging/invalid-registration-token', null, null);
      } else {
        realDevices.push(dev);
      }
    }

    // Real FCM delivery in 500-token multicast chunks.
    for (let i = 0; i < realDevices.length; i += FCM_MULTICAST_CHUNK) {
      const chunk = realDevices.slice(i, i + FCM_MULTICAST_CHUNK);
      try {
        const response = await sendFcmMulticast(
          {
            tokens: chunk.map((d) => d.fcmToken),
            notification: { title: campaign.title, body: campaign.body },
            data: {
              url: campaign.deepLink || 'https://gogocompany.in/',
              campaignId: campaign.idempotencyKey,
              scope: campaign.targetType,
              title: campaign.title,
              body: campaign.body,
            },
            webpush: {
              headers: { Urgency: 'high', TTL: '86400' },
              notification: {
                title: campaign.title,
                body: campaign.body,
                icon: 'https://gogocompany.in/favicon.ico',
                badge: 'https://gogocompany.in/favicon.ico',
                tag: campaign.idempotencyKey,
                renotify: true,
                requireInteraction: true,
                data: { url: campaign.deepLink || 'https://gogocompany.in/' },
              },
              fcmOptions: { link: campaign.deepLink || 'https://gogocompany.in/' },
            },
          },
          process.env.FCM_DRY_RUN === 'true'
        );
        for (let idx = 0; idx < response.responses.length; idx += 1) {
          const dev = chunk[idx];
          const resp = response.responses[idx];
          if (resp.success) {
            const rawMessageId = resp.messageId ?? null;
            console.info('[FCM] Message accepted by Firebase:', {
              notificationId: campaign.notificationId,
              deviceId: dev.deviceId,
              messageId: rawMessageId,
            });
            await recordReceipt(dev, 'delivered', null, markDryRunMessageId(rawMessageId), null);
          } else {
            const errorCode = extractFcmErrorCode(resp.error);
            const errorClass = classifyFcmError(errorCode);
            if (errorClass === 'expired') {
              await markDeviceStatus(dev.deviceId, 'expired');
              await recordReceipt(dev, 'failed_expired_token', errorCode, null, null);
            } else if (errorClass === 'permanent') {
              await recordReceipt(dev, 'failed_permanent', errorCode, null, null);
            } else {
              await recordReceipt(dev, 'failed_transient', errorCode, null, null);
            }
          }
        }
      } catch {
        // Whole-chunk transport failure: honest failed_transient, no fabrication.
        for (const dev of chunk) {
          await recordReceipt(dev, 'failed_transient', 'messaging/transport-unavailable', null, null);
        }
      }
    }

    const counts = await countCampaignOutcomes(campaign.notificationId);
    return {
      receipts,
      sentCount: counts.sentCount,
      failedCount: counts.failedCount,
      skippedCount: counts.skippedCount,
    };
  }

  /**
   * Admin-triggered retry of transient failures (bounded by fcm_max_retries).
   * Mirrors engine.retryFailedCampaign semantics.
   */
  async retryFailedCampaign(
    notificationId: string,
    actorId: string
  ): Promise<{ campaign: NotificationCampaignRecord | null; error?: string }> {
    const campaign = await getCampaign(notificationId);
    if (!campaign) return { campaign: null, error: 'NOT_FOUND' };
    if (process.env.NODE_ENV === 'production' && !FIREBASE_ADMIN_CONFIGURED) {
      const failed = await finalizeCampaign(notificationId, {
        status: 'failed',
        sentCount: 0,
        failedCount: 0,
      });
      return { campaign: failed ?? campaign, error: 'FIREBASE_ADMIN_NOT_CONFIGURED' };
    }
    if (process.env.NODE_ENV === 'production' && process.env.FCM_DRY_RUN !== 'true') {
      await pruneNonFcmDeviceTokens();
    }

    const maxRetries = await getNumberConfig('fcm_max_retries', 3);
    if (campaign.retryCount >= maxRetries) {
      return {
        campaign,
        error: `MAX_RETRIES_EXCEEDED: Campaign has already reached maximum retry limit (${maxRetries}).`,
      };
    }

    const retryable = await getRetryableDeliveries(notificationId, maxRetries);
    if (retryable.length === 0) {
      return {
        campaign,
        error: 'NO_TRANSIENT_FAILURES_TO_RETRY: No failed_transient deliveries exist for this campaign.',
      };
    }

    for (const delivery of retryable) {
      const device = await getDevice(delivery.deviceId);
      if (!device || device.status !== 'active') {
        await updateDeliveryOutcome(delivery.deliveryId, {
          status: 'failed_expired_token',
          errorCode: 'messaging/registration-token-not-registered',
          fcmMessageId: null,
          retryCount: delivery.retryCount,
          nextAttemptAt: null,
        });
        continue;
      }
      if (device.fcmToken.startsWith('fcm_') || device.fcmToken.trim().startsWith('{') || device.fcmToken.trim().startsWith('[')) {
        await updateDeliveryOutcome(delivery.deliveryId, {
          status: 'failed_permanent',
          errorCode: 'messaging/invalid-registration-token',
          fcmMessageId: null,
          retryCount: delivery.retryCount,
          nextAttemptAt: null,
        });
        continue;
      }
      try {
        const response = await sendFcmMulticast(
          {
            tokens: [device.fcmToken],
            notification: { title: campaign.title, body: campaign.body },
            data: {
              url: campaign.deepLink || 'https://gogocompany.in/',
              campaignId: campaign.idempotencyKey,
              scope: campaign.targetType,
              title: campaign.title,
              body: campaign.body,
            },
            webpush: {
              headers: { Urgency: 'high', TTL: '86400' },
              notification: {
                title: campaign.title,
                body: campaign.body,
                icon: 'https://gogocompany.in/favicon.ico',
                badge: 'https://gogocompany.in/favicon.ico',
                tag: campaign.idempotencyKey,
                renotify: true,
                requireInteraction: true,
                data: { url: campaign.deepLink || 'https://gogocompany.in/' },
              },
              fcmOptions: { link: campaign.deepLink || 'https://gogocompany.in/' },
            },
          },
          process.env.FCM_DRY_RUN === 'true'
        );
        const resp = response.responses[0];
        if (resp?.success) {
          console.info('[FCM] Retry message accepted by Firebase:', {
            notificationId,
            deviceId: device.deviceId,
            messageId: resp.messageId ?? null,
          });
          await updateDeliveryOutcome(delivery.deliveryId, {
            status: 'delivered',
            errorCode: null,
            fcmMessageId: markDryRunMessageId(resp.messageId ?? null),
            retryCount: delivery.retryCount,
            nextAttemptAt: null,
          });
        } else {
          const errorCode = extractFcmErrorCode(resp?.error);
          const errorClass = classifyFcmError(errorCode);
          const newRetryCount = delivery.retryCount + 1;
          const finalStatus =
            errorClass === 'expired'
              ? 'failed_expired_token'
              : newRetryCount >= maxRetries
              ? 'failed_permanent'
              : 'failed_transient';
          if (errorClass === 'expired') {
            await markDeviceStatus(device.deviceId, 'expired');
          }
          await updateDeliveryOutcome(delivery.deliveryId, {
            status: finalStatus,
            errorCode,
            fcmMessageId: null,
            retryCount: newRetryCount,
            nextAttemptAt:
              finalStatus === 'failed_transient'
                ? new Date(Date.now() + backoffWithJitter(newRetryCount) * 1000)
                : null,
          });
        }
      } catch {
        const newRetryCount = delivery.retryCount + 1;
        const finalStatus = newRetryCount >= maxRetries ? 'failed_permanent' : 'failed_transient';
        await updateDeliveryOutcome(delivery.deliveryId, {
          status: finalStatus,
          errorCode: 'messaging/transport-unavailable',
          fcmMessageId: null,
          retryCount: newRetryCount,
          nextAttemptAt:
            finalStatus === 'failed_transient'
              ? new Date(Date.now() + backoffWithJitter(newRetryCount) * 1000)
              : null,
        });
      }
    }

    await incrementCampaignRetryCount(notificationId);
    const counts = await countCampaignOutcomes(notificationId);
    const stillFailed = counts.failedCount > 0;
    const final = await finalizeCampaign(notificationId, {
      status: stillFailed ? 'partial_failure' : 'delivered',
      sentCount: counts.sentCount,
      failedCount: counts.failedCount,
    });
    await insertAuditLog({
      logId: newId('audit'),
      actorId,
      appId: campaign.appId,
      action: 'NOTIFICATION_RETRY',
      resourceId: notificationId,
      severity: 'warn',
      details: `Retried transient FCM failures (${counts.sentCount} delivered, ${counts.failedCount} still failing).`,
    });
    return { campaign: final ?? campaign };
  }

  /**
   * One worker tick: reclaim stuck campaigns, claim due campaigns, retry due
   * transient deliveries, and run retention cleanup (terminal-only).
   */
  async tick(): Promise<{ dispatched: number; reclaimed: number; retriedCampaigns: number; pruned: number }> {
    const reclaimedIds = await reclaimStaleProcessing(5);
    const due = await claimDueCampaigns(10, this.workerId);
    let dispatched = 0;
    for (const campaign of due) {
      await this.deliverClaimedCampaign(campaign);
      dispatched += 1;
    }

    const maxRetries = await getNumberConfig('fcm_max_retries', 3);
    const retryCampaignIds = await listCampaignsWithRetryableDeliveries(maxRetries, 10);
    let retriedCampaigns = 0;
    for (const notificationId of retryCampaignIds) {
      const outcome = await this.retryFailedCampaign(notificationId, 'system-worker');
      if (!outcome.error) retriedCampaigns += 1;
    }

    const retentionDays = await getNumberConfig('campaign_retention_days', 0);
    const pruned = retentionDays > 0 ? await pruneTerminalCampaignsOlderThan(retentionDays) : [];

    return {
      dispatched,
      reclaimed: reclaimedIds.length,
      retriedCampaigns,
      pruned: pruned.length,
    };
  }

  /** Starts the periodic worker loop (no-op if already running). */
  start(intervalMs = 30000): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.ticking) return;
      this.ticking = true;
      this.tick()
        .catch(() => {
          // Tick errors are non-fatal; durable state stays consistent in PG.
        })
        .finally(() => {
          this.ticking = false;
        });
    }, intervalMs);
    if (typeof this.timer.unref === 'function') {
      this.timer.unref();
    }
  }

  /** Graceful shutdown: stops scheduling; in-flight work stays durable in PG. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

export type { ClientPlatform };
