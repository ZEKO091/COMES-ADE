export const ADMIN_SPEECH_EMAIL = 'kingfrianfrian16@gmail.com';

export type SpeechQuotaView = {
  plan: string;
  unlimited: boolean;
  limit: number | null;
  used: number;
  remaining: number | null;
  periodKey: string;
  source: 'remote';
};

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

export { asQuota as parseSpeechQuotaResponse };
