import { getRequestUser } from './auth';
import {
  findSpeechSubscription,
  isAdminSpeechEmail,
  normalizeSpeechPlan,
  type SpeechPlanId,
} from './speech-quota';

export const MESSAGE_PLAN_LIMITS = {
  starter: 1_000,
  pro: 30_000,
  advanced: 100_000,
  admin: null,
} as const;

export type MessageQuota = {
  plan: SpeechPlanId | 'none';
  plan_type: SpeechPlanId | 'none';
  unlimited: boolean;
  limit: number | null;
  used: number;
  remaining: number | null;
  periodKey: string;
  period_key: string;
  window: 'week';
  resets_at: string;
};

type JsonFn = (data: unknown, status: number, request: Request, env: Env) => Response;

const MAX_JSON_LENGTH = 4 * 1024;

export function isoWeekKey(now = new Date()): string {
  const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((date.getTime() - yearStart.getTime()) / 86_400_000) + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

export function isoWeekResetsAt(now = new Date()): string {
  const utc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const day = utc.getUTCDay() || 7;
  utc.setUTCDate(utc.getUTCDate() + (8 - day));
  utc.setUTCHours(0, 0, 0, 0);
  return utc.toISOString();
}

export async function ensureMessageSchema(db: D1Database): Promise<void> {
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS message_usage (
      customer_id TEXT PRIMARY KEY NOT NULL,
      period_key TEXT NOT NULL,
      used INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    )
  `).run();
}

function messageLimitForPlan(plan: SpeechPlanId | 'none'): number | null {
  if (plan === 'none') return 0;
  return MESSAGE_PLAN_LIMITS[plan];
}

function quotaPayload(plan: SpeechPlanId | 'none', used: number, periodKey: string): MessageQuota {
  const limit = messageLimitForPlan(plan);
  const unlimited = plan === 'admin';
  const safeUsed = unlimited ? 0 : Math.max(0, used);
  return {
    plan,
    plan_type: plan,
    unlimited,
    limit,
    used: safeUsed,
    remaining: unlimited || limit === null ? null : Math.max(0, limit - safeUsed),
    periodKey,
    period_key: periodKey,
    window: 'week',
    resets_at: isoWeekResetsAt(),
  };
}

function adminQuota(): MessageQuota {
  return quotaPayload('admin', 0, 'admin-unlimited');
}

async function readUsage(db: D1Database, customerId: string, periodKey: string): Promise<number> {
  const row = await db.prepare(
    'SELECT period_key, used FROM message_usage WHERE customer_id = ?1',
  ).bind(customerId).first<{ period_key: string; used: number }>();
  if (!row || row.period_key !== periodKey) return 0;
  return Number(row.used) || 0;
}

export async function messageQuotaForEmail(db: D1Database, email: string): Promise<{
  ok: true;
  quota: MessageQuota;
} | { ok: false; status: number; error: string; message: string }> {
  await ensureMessageSchema(db);
  if (isAdminSpeechEmail(email)) {
    return { ok: true, quota: adminQuota() };
  }

  const row = await findSpeechSubscription(db, email);
  if (!row) {
    return {
      ok: false,
      status: 404,
      error: 'message_no_subscription',
      message: 'No hay una suscripción ComesADE ligada a esa cuenta.',
    };
  }
  const active = ['active', 'trialing', 'trial', 'approved'].includes(row.status.toLowerCase());
  const plan = active ? normalizeSpeechPlan(row.plan_type) : 'none';
  if (!active || plan === 'none') {
    return {
      ok: false,
      status: 402,
      error: 'message_requires_plan',
      message: 'Necesitas un plan Starter, Pro o Advanced para enviar mensajes al agente.',
    };
  }
  if (plan === 'admin') {
    return { ok: true, quota: adminQuota() };
  }
  const periodKey = isoWeekKey();
  const used = await readUsage(db, row.customer_id, periodKey);
  return { ok: true, quota: quotaPayload(plan, used, periodKey) };
}

export async function consumeMessageRequests(db: D1Database, email: string, count: number): Promise<{
  ok: true;
  quota: MessageQuota;
} | { ok: false; status: number; error: string; message: string; quota?: MessageQuota }> {
  if (!Number.isInteger(count) || count < 1 || count > 20) {
    return {
      ok: false,
      status: 400,
      error: 'invalid_count',
      message: 'Cada mensaje enviado cuenta 1 (máximo 20 por llamada).',
    };
  }
  if (isAdminSpeechEmail(email)) {
    return { ok: true, quota: adminQuota() };
  }

  const found = await messageQuotaForEmail(db, email);
  if (!found.ok) return found;
  if (found.quota.unlimited || found.quota.plan === 'admin') {
    return { ok: true, quota: adminQuota() };
  }

  const row = await findSpeechSubscription(db, email);
  if (!row) return found;
  const periodKey = isoWeekKey();
  if ((found.quota.remaining ?? 0) < count) {
    return {
      ok: false,
      status: 402,
      error: 'message_quota_exceeded',
      message: `El plan ${found.quota.plan} permite ${found.quota.limit} mensajes enviados por semana. Quedan ${found.quota.remaining}. Se reinicia el lunes.`,
      quota: found.quota,
    };
  }
  const nextUsed = found.quota.used + count;
  const now = new Date().toISOString();
  await db.prepare(`
    INSERT INTO message_usage (customer_id, period_key, used, updated_at)
    VALUES (?1, ?2, ?3, ?4)
    ON CONFLICT(customer_id) DO UPDATE SET
      period_key = excluded.period_key,
      used = CASE
        WHEN message_usage.period_key = excluded.period_key THEN excluded.used
        ELSE excluded.used
      END,
      updated_at = excluded.updated_at
  `).bind(row.customer_id, periodKey, nextUsed, now).run();
  return { ok: true, quota: quotaPayload(found.quota.plan, nextUsed, periodKey) };
}

async function readJson(request: Request): Promise<
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; code: string; message: string }
> {
  const rawBody = await request.text();
  if (rawBody.length > MAX_JSON_LENGTH) {
    return { ok: false, code: 'payload_too_large', message: 'The JSON body is too large.' };
  }
  if (!rawBody.trim()) return { ok: true, body: {} };
  try {
    const parsed: unknown = JSON.parse(rawBody);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, code: 'invalid_json_body', message: 'The JSON body must be an object.' };
    }
    return { ok: true, body: parsed as Record<string, unknown> };
  } catch {
    return { ok: false, code: 'invalid_json_body', message: 'The request body is not valid JSON.' };
  }
}

export async function handleMessageRoutes(
  request: Request,
  env: Env,
  json: JsonFn,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== '/v1/messages/quota' && url.pathname !== '/v1/messages/consume') {
    return null;
  }

  if (request.method === 'GET' && url.pathname === '/v1/messages/quota') {
    const user = await getRequestUser(env.DB, request);
    if (!user) return json({ error: 'Unauthorized' }, 401, request, env);
    const result = await messageQuotaForEmail(env.DB, user.email);
    if (!result.ok) {
      return json({ error: result.error, message: result.message }, result.status, request, env);
    }
    return json(result.quota, 200, request, env);
  }

  if (request.method === 'POST' && url.pathname === '/v1/messages/consume') {
    const user = await getRequestUser(env.DB, request);
    if (!user) return json({ error: 'Unauthorized' }, 401, request, env);
    const parsed = await readJson(request);
    if (!parsed.ok) {
      return json({ error: parsed.code, message: parsed.message }, 400, request, env);
    }
    const count = parsed.body.count === undefined ? 1 : Number(parsed.body.count);
    const result = await consumeMessageRequests(env.DB, user.email, count);
    if (!result.ok) {
      return json({
        error: result.error,
        message: result.message,
        ...(result.quota ? { quota: result.quota } : {}),
      }, result.status, request, env);
    }
    return json({ ...result.quota, count }, 200, request, env);
  }

  return json({ error: 'method_not_allowed', message: 'Method not allowed.' }, 405, request, env);
}
