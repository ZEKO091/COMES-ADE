export const MESSAGE_PLAN_LIMITS = {
  starter: 1_000,
  pro: 30_000,
  advanced: 100_000,
} as const;

export type MessageQuotaView = {
  plan: string;
  unlimited: boolean;
  limit: number | null;
  used: number;
  remaining: number | null;
  periodKey: string;
  source: 'remote' | 'local';
};

const LOCAL_KEY = 'comesade.message-usage';
const ADMIN_EMAIL = 'kingfrianfrian16@gmail.com';

export function isoWeekKey(now = new Date()): string {
  const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((date.getTime() - yearStart.getTime()) / 86_400_000) + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function isAdmin(email: string | null | undefined): boolean {
  return String(email ?? '').trim().toLowerCase() === ADMIN_EMAIL;
}

function normalizePlan(value: string | null | undefined): keyof typeof MESSAGE_PLAN_LIMITS | 'admin' | 'none' {
  const raw = (value ?? '').trim().toLowerCase();
  if (!raw) return 'none';
  if (raw.includes('admin')) return 'admin';
  if (raw.includes('advanced')) return 'advanced';
  if (raw.includes('starter') || raw.includes('start') || raw.includes('basic')) return 'starter';
  if (raw.includes('pro')) return 'pro';
  return 'none';
}

function limitForPlan(plan: ReturnType<typeof normalizePlan>): number | null {
  if (plan === 'admin') return null;
  if (plan === 'none') return 0;
  return MESSAGE_PLAN_LIMITS[plan];
}

type LocalUsage = { email: string; periodKey: string; used: number };

function readLocal(email: string, periodKey: string): number {
  try {
    const raw = window.localStorage.getItem(LOCAL_KEY);
    if (!raw) return 0;
    const parsed = JSON.parse(raw) as LocalUsage;
    if (parsed.email !== email || parsed.periodKey !== periodKey) return 0;
    return Math.max(0, Number(parsed.used) || 0);
  } catch {
    return 0;
  }
}

function writeLocal(email: string, periodKey: string, used: number): void {
  window.localStorage.setItem(LOCAL_KEY, JSON.stringify({ email, periodKey, used }));
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

export function localMessageQuota(
  email: string,
  planLabel: string | null,
  subscriptionActive: boolean,
): MessageQuotaView {
  const periodKey = isoWeekKey();
  if (isAdmin(email)) {
    return {
      plan: 'admin',
      unlimited: true,
      limit: null,
      used: 0,
      remaining: null,
      periodKey: 'admin-unlimited',
      source: 'local',
    };
  }
  const plan = subscriptionActive ? normalizePlan(planLabel) : 'none';
  const limit = limitForPlan(plan);
  if (plan === 'admin' || limit === null) {
    return {
      plan: 'admin',
      unlimited: true,
      limit: null,
      used: 0,
      remaining: null,
      periodKey: 'admin-unlimited',
      source: 'local',
    };
  }
  const used = readLocal(email, periodKey);
  return {
    plan,
    unlimited: false,
    limit,
    used,
    remaining: Math.max(0, limit - used),
    periodKey,
    source: 'local',
  };
}

export function consumeLocalMessage(
  quota: MessageQuotaView,
  email: string,
  count = 1,
): MessageQuotaView | null {
  if (isUnlimitedMessageQuota(quota, email)) return quota;
  if (quota.limit === null || quota.remaining === null) return quota;
  if (count < 1 || quota.remaining < count) return null;
  const used = quota.used + count;
  writeLocal(email, quota.periodKey, used);
  return { ...quota, used, remaining: Math.max(0, quota.limit - used), source: 'local' };
}
