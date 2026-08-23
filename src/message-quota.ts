export type MessageQuotaView = {
  plan: string;
  unlimited: boolean;
  limit: number | null;
  used: number;
  remaining: number | null;
  periodKey: string;
  source: 'remote';
};

const ADMIN_EMAIL = 'kingfrianfrian16@gmail.com';

function isAdmin(email: string | null | undefined): boolean {
  return String(email ?? '').trim().toLowerCase() === ADMIN_EMAIL;
}

export function isUnlimitedMessageQuota(quota: MessageQuotaView | null, email?: string | null): boolean {
  if (isAdmin(email)) return true;
  if (!quota) return false;
  return quota.unlimited || quota.plan === 'admin';
}

export function parseMessageQuotaResponse(data: unknown): MessageQuotaView | null {
  if (!data || typeof data !== 'object') return null;
  const record = data as Record<string, unknown>;
  const nested = record.quota && typeof record.quota === 'object'
    ? record.quota as Record<string, unknown>
    : record;
  const plan = typeof nested.plan === 'string' ? nested.plan : typeof nested.plan_type === 'string' ? nested.plan_type : '';
  const unlimited = nested.unlimited === true || plan.toLowerCase() === 'admin';
  const used = Number(nested.used);
  const periodKey = typeof nested.period_key === 'string'
    ? nested.period_key
    : typeof nested.periodKey === 'string' ? nested.periodKey : '';
  if (unlimited) {
    return {
      plan: plan || 'admin',
      unlimited: true,
      limit: null,
      used: 0,
      remaining: null,
      periodKey: periodKey || 'admin-unlimited',
      source: 'remote',
    };
  }
  const limit = Number(nested.limit);
  const remaining = Number(nested.remaining);
  if (!Number.isFinite(limit) || !Number.isFinite(used) || !Number.isFinite(remaining)) return null;
  return { plan, unlimited: false, limit, used, remaining, periodKey, source: 'remote' };
}

