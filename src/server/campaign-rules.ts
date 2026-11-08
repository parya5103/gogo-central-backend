/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Pure, side-effect-free campaign delivery rules shared by the in-memory
 * engine and the PostgreSQL runtime store. Keeping these pure makes them
 * unit-testable without a database and guarantees identical behaviour in both
 * persistence modes.
 */

import { createHash } from 'node:crypto';
import type {
  NotificationPreferenceRecord,
  TargetScope,
  ClientPlatform,
} from '../types/gogo.ts';

/** Marketing classification — mirrors GoGoCentralBackendEngine.isMarketingTarget. */
export function isMarketingTarget(targetType: TargetScope): boolean {
  return (
    targetType === 'product' ||
    targetType === 'broadcast' ||
    targetType === 'ecosystem' ||
    targetType === 'group' ||
    targetType === 'topic'
  );
}

/**
 * Canonical sha256 identity of a dispatch request. The same idempotency key
 * with a different payload is a conflict (HTTP 409), not a duplicate replay.
 */
export function computeCampaignPayloadHash(params: {
  appId: string;
  targetType: TargetScope;
  targetValue: string;
  platform: string;
  title: string;
  body: string;
  deepLink: string;
  scheduledFor: string | null;
}): string {
  const canonical = JSON.stringify({
    appId: params.appId,
    targetType: params.targetType,
    targetValue: params.targetValue,
    platform: params.platform,
    title: params.title,
    body: params.body,
    deepLink: params.deepLink,
    scheduledFor: params.scheduledFor || '',
  });
  return createHash('sha256').update(canonical, 'utf-8').digest('hex');
}

/**
 * Server-side preference gate (pure form). Returns null when delivery is
 * allowed, otherwise a machine-readable skip reason recorded on the receipt.
 * Mirrors GoGoCentralBackendEngine.prefAllowsDelivery.
 */
export function prefSkipReason(
  pref: NotificationPreferenceRecord | null,
  platform: ClientPlatform,
  isMarketing: boolean
): string | null {
  if (!pref) return null;
  if (!pref.enabled) return 'user-preference-disabled';
  if (platform === 'web' && !pref.webPush) return 'user-preference-web-disabled';
  if (platform === 'android' && !pref.androidPush) return 'user-preference-android-disabled';
  if (isMarketing && !pref.marketingAlerts) return 'user-marketing-opt-out';
  if (!isMarketing && !pref.transactionalAlerts) return 'user-transactional-opt-out';
  return null;
}

/**
 * Quiet-hours evaluation in the user's own IANA timezone.
 *
 * - `timeZone` must be a valid IANA identifier (validated by the repository);
 *   NULL/unknown timezone means quiet hours cannot be evaluated honestly, so
 *   delivery proceeds (never silently assume UTC).
 * - Handles overnight windows (22:00 → 07:00) and is DST-safe because the
 *   wall-clock time is computed from the absolute instant via Intl.
 * - start === end means the window covers the entire day.
 */
export function isInQuietHours(
  now: Date,
  quietHoursStart: string,
  quietHoursEnd: string,
  timeZone: string | null
): boolean {
  if (!timeZone) return false;
  const hhmm = /^([01]\d|2[0-3]):([0-5]\d)$/;
  if (!hhmm.test(quietHoursStart) || !hhmm.test(quietHoursEnd)) return false;

  let localMinutes: number;
  try {
    const fmt = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    const parts = fmt.formatToParts(now);
    const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '25');
    const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
    if (!Number.isFinite(hour) || hour > 23) return false;
    localMinutes = hour * 60 + minute;
  } catch {
    // Invalid timezone identifier: cannot evaluate honestly → do not block.
    return false;
  }

  const toMinutes = (hhmmValue: string): number =>
    Number(hhmmValue.slice(0, 2)) * 60 + Number(hhmmValue.slice(3, 5));
  const start = toMinutes(quietHoursStart);
  const end = toMinutes(quietHoursEnd);

  if (start === end) return true; // degenerate window = always quiet
  if (start < end) return localMinutes >= start && localMinutes < end;
  // Overnight window (e.g. 22:00 → 07:00)
  return localMinutes >= start || localMinutes < end;
}

/** Validates an IANA timezone identifier without throwing. */
export function isValidIANATimezone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone });
    return true;
  } catch {
    return false;
  }
}

export type FcmErrorClass = 'expired' | 'permanent' | 'transient';

/**
 * Classifies FCM errors into the honest receipt lifecycle:
 * - expired: token no longer registered → device status=expired, no retry
 * - permanent: bad payload/arguments → no retry
 * - transient: transport/quota/unknown → bounded retry with backoff
 */
export function classifyFcmError(errorCode: string | null): FcmErrorClass {
  const code = String(errorCode || '');
  if (
    code.includes('registration-token-not-registered') ||
    code.includes('invalid-registration-token') ||
    code.includes('messaging/registration-token-not-registered')
  ) {
    return 'expired';
  }
  if (
    code.includes('invalid-argument') ||
    code.includes('invalid-payload') ||
    code.includes('messaging/invalid') ||
    code.includes('sender-id-mismatch')
  ) {
    return 'permanent';
  }
  return 'transient';
}

/** Deep-link allowlist for https GoGo domains — mirrors the engine's rule. */
export function isAllowedGoGoDeepLink(
  deepLinkUrl: string,
  registeredDomains: readonly string[]
): boolean {
  try {
    const parsed = new URL(deepLinkUrl);
    if (parsed.protocol !== 'https:') return false;
    const host = parsed.hostname.toLowerCase();
    if (host === 'gogocompany.in' || host.endsWith('.gogocompany.in')) return true;
    for (const domain of registeredDomains) {
      try {
        const prodHost = new URL(domain).hostname.toLowerCase();
        if (host === prodHost) return true;
      } catch {
        // ignore malformed domain
      }
    }
    return false;
  } catch {
    return false;
  }
}
