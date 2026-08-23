export const ADMIN_SPEECH_EMAIL = 'kingfrianfrian16@gmail.com';

export const SPEECH_PLAN_LIMITS = {
  starter: 5_000,
  pro: 15_000,
  advanced: 50_000,
} as const;

export type SpeechQuotaView = {
  plan: string;
  unlimited: boolean;
  limit: number | null;
  used: number;
  remaining: number | null;
  periodKey: string;
  source: 'remote' | 'local';
};

const LOCAL_KEY = 'comesade.speech-usage';

export function countSpeechTokens(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

export function isAdminSpeechEmail(email: string | null | undefined): boolean {
  return String(email ?? '').trim().toLowerCase() === ADMIN_SPEECH_EMAIL;
}

export function isUnlimitedSpeechQuota(quota: SpeechQuotaView | null, email?: string | null): boolean {
  if (isAdminSpeechEmail(email)) return true;
  if (!quota) return false;
  return quota.unlimited || quota.plan === 'admin';
}

export function normalizeSpeechPlan(value: string | null | undefined): keyof typeof SPEECH_PLAN_LIMITS | 'admin' | 'none' {
  const raw = (value ?? '').trim().toLowerCase();
  if (!raw) return 'none';
  if (raw.includes('admin')) return 'admin';
  if (raw.includes('advanced')) return 'advanced';
  if (raw.includes('starter') || raw.includes('start') || raw.includes('basic')) return 'starter';
  if (raw.includes('pro')) return 'pro';
  return 'none';
}

export function speechLimitForPlan(plan: ReturnType<typeof normalizeSpeechPlan>): number | null {
  if (plan === 'admin') return null;
  if (plan === 'none') return 0;
  return SPEECH_PLAN_LIMITS[plan];
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

function asQuota(data: unknown): SpeechQuotaView | null {
  if (!data || typeof data !== 'object') return null;
  const record = data as Record<string, unknown>;
  const nested = record.quota && typeof record.quota === 'object' ? record.quota as Record<string, unknown> : record;
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

export function localSpeechQuota(
  email: string,
  planLabel: string | null,
  subscriptionActive: boolean,
  periodKey: string,
): SpeechQuotaView {
  if (isAdminSpeechEmail(email)) {
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
  const plan = subscriptionActive ? normalizeSpeechPlan(planLabel) : 'none';
  const limit = speechLimitForPlan(plan);
  if (plan === 'admin' || limit === null) {
    return {
      plan: 'admin',
      unlimited: true,
      limit: null,
      used: 0,
      remaining: null,
      periodKey: periodKey || 'admin-unlimited',
      source: 'local',
    };
  }
  const used = readLocal(email, periodKey || 'unpaid');
  return {
    plan,
    unlimited: false,
    limit,
    used,
    remaining: Math.max(0, limit - used),
    periodKey: periodKey || 'unpaid',
    source: 'local',
  };
}

export function consumeLocalSpeech(
  quota: SpeechQuotaView,
  email: string,
  tokens: number,
): SpeechQuotaView | null {
  if (isUnlimitedSpeechQuota(quota, email)) return quota;
  if (quota.limit === null || quota.remaining === null) return quota;
  if (tokens < 1 || quota.remaining < tokens) return null;
  const used = quota.used + tokens;
  writeLocal(email, quota.periodKey, used);
  return { ...quota, used, remaining: Math.max(0, quota.limit - used), source: 'local' };
}

export { asQuota as parseSpeechQuotaResponse };
