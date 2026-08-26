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

function isAdminPlan(plan: string): boolean {
  return plan.trim().toLowerCase() === 'admin';
}

function readQuotaInteger(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isInteger(value) && value >= 0 ? value : null;
  }
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

export function isUnlimitedMessageQuota(quota: MessageQuotaView | null, email?: string | null): boolean {
  if (isAdmin(email)) return true;
  if (!quota) return false;
  return quota.unlimited || isAdminPlan(quota.plan);
}

export function parseMessageQuotaResponse(data: unknown): MessageQuotaView | null {
  if (!data || typeof data !== 'object') return null;
  const record = data as Record<string, unknown>;
  const nested = record.quota && typeof record.quota === 'object'
    ? record.quota as Record<string, unknown>
    : record;
  const rawPlan = typeof nested.plan === 'string' ? nested.plan : typeof nested.plan_type === 'string' ? nested.plan_type : '';
  const plan = rawPlan.trim();
  const unlimited = nested.unlimited === true || isAdminPlan(plan);
  const used = readQuotaInteger(nested.used);
  const periodKey = (typeof nested.period_key === 'string'
    ? nested.period_key
    : typeof nested.periodKey === 'string' ? nested.periodKey : '').trim();
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
  const limit = readQuotaInteger(nested.limit);
  const remaining = readQuotaInteger(nested.remaining);
  if (!plan || !periodKey || used === null || limit === null || remaining === null) return null;
  if (used > limit || remaining > limit) return null;
  return { plan, unlimited: false, limit, used, remaining, periodKey, source: 'remote' };
}

