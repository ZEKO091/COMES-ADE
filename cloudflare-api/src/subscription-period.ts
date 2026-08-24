/** Manual complimentary grants use subscription_id prefix `manual:` and expire at next_billing_at. */

export function isManualSubscriptionId(subscriptionId: string | null | undefined): boolean {
  return String(subscriptionId ?? '').startsWith('manual:');
}

export function parseUtcMillis(value: string | null | undefined): number | null {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  const normalized = raw.includes('T') ? raw : raw.replace(' ', 'T');
  const withZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(normalized) ? normalized : `${normalized}Z`;
  const ms = Date.parse(withZone);
  return Number.isFinite(ms) ? ms : null;
}

export function isPeriodExpired(nextBillingAt: string | null | undefined, nowMs = Date.now()): boolean {
  const ms = parseUtcMillis(nextBillingAt);
  if (ms === null) return false;
  return ms <= nowMs;
}

export function isEntitlementActive(
  status: string | null | undefined,
  subscriptionId: string | null | undefined,
  nextBillingAt: string | null | undefined,
  nowMs = Date.now(),
): boolean {
  const normalized = String(status ?? '').trim().toLowerCase();
  if (!['active', 'trialing', 'trial', 'approved'].includes(normalized)) return false;
  if (!isManualSubscriptionId(subscriptionId)) return true;
  return !isPeriodExpired(nextBillingAt, nowMs);
}

/** @deprecated Prefer isEntitlementActive */
export const isManualEntitlementActive = isEntitlementActive;

export async function expireDueManualSubscriptions(db: D1Database, nowIso = new Date().toISOString()): Promise<number> {
  const due = await db.prepare(`
    SELECT subscription_id
    FROM paypal_subscription_details
    WHERE subscription_id LIKE 'manual:%'
      AND lower(status) IN ('active', 'trialing', 'trial', 'approved')
      AND next_billing_at IS NOT NULL
      AND trim(next_billing_at) != ''
      AND datetime(replace(next_billing_at, 'T', ' ')) <= datetime('now')
  `).all<{ subscription_id: string }>();

  const ids = (due.results ?? []).map((row) => row.subscription_id).filter(Boolean);
  if (!ids.length) return 0;

  let expired = 0;
  for (const subscriptionId of ids) {
    await db.batch([
      db.prepare(`
        UPDATE paypal_subscription_details
        SET status = 'expired',
            status_update_time = ?2,
            updated_at = ?2,
            last_event_at = ?2,
            last_event_id = 'manual-auto-expire'
        WHERE subscription_id = ?1
      `).bind(subscriptionId, nowIso),
      db.prepare(`
        UPDATE subscriptions
        SET status = 'expired',
            updated_at = ?2,
            last_event_at = ?2
        WHERE subscription_id = ?1
      `).bind(subscriptionId, nowIso),
    ]);
    expired += 1;
  }
  return expired;
}
