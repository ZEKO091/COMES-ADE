import { getRequestUser } from './auth';
import { isEntitlementActive } from './subscription-period';

export const ADMIN_SPEECH_EMAIL = 'kingfrianfrian16@gmail.com';

export const SPEECH_PLAN_LIMITS = {
  starter: 5_000,
  pro: 15_000,
  advanced: 50_000,
  admin: null,
} as const;

export type SpeechPlanId = keyof typeof SPEECH_PLAN_LIMITS;

export type SpeechQuota = {
  plan: SpeechPlanId | 'none';
  plan_type: SpeechPlanId | 'none';
  unlimited: boolean;
  limit: number | null;
  used: number;
  remaining: number | null;
  periodKey: string;
  period_key: string;
};

type JsonFn = (data: unknown, status: number, request: Request, env: Env) => Response;

export type SpeechRow = {
  customer_id: string;
  plan_type: string;
  status: string;
  last_payment_at: string | null;
  start_time: string | null;
  next_billing_at: string | null;
  subscription_id: string;
};

const MAX_SPEECH_JSON_LENGTH = 16 * 1024;
const MAX_TRANSCRIBE_BYTES = 2 * 1024 * 1024;
export const SPEECH_STT_MODEL = '@cf/openai/whisper-large-v3-turbo';
const WHISPER_MODEL = SPEECH_STT_MODEL;

export const SPEECH_STT_MODELS = [
  {
    id: SPEECH_STT_MODEL,
    task: 'transcribe',
    max_bytes: MAX_TRANSCRIBE_BYTES,
    max_seconds: 30,
    languages: 'auto',
  },
] as const;

type SpeechAi = {
  run: (
    model: string,
    input: Record<string, unknown>,
  ) => Promise<{ text?: string; transcription?: string; word_count?: number }>;
};

type SpeechEnv = Env & { AI?: SpeechAi };

function bytesToBase64(bytes: Uint8Array): string {
  const chunkSize = 0x8000;
  const chunks: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const slice = bytes.subarray(offset, offset + chunkSize);
    chunks.push(String.fromCharCode(...slice));
  }
  return btoa(chunks.join(''));
}

async function runSpeechModel(
  ai: SpeechAi,
  bytes: Uint8Array,
  language?: string,
): Promise<{ result: unknown; model: string }> {
  const base64 = bytesToBase64(bytes);
  try {
    const result = await ai.run(WHISPER_MODEL, {
      audio: base64,
      task: 'transcribe',
      ...(language ? { language } : {}),
    });
    return { result, model: WHISPER_MODEL };
  } catch (turboError) {
    try {
      const result = await ai.run('@cf/openai/whisper', {
        audio: Array.from(bytes),
      });
      return { result, model: '@cf/openai/whisper' };
    } catch {
      throw turboError;
    }
  }
}

function isoLanguage(value: unknown): string | undefined {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!raw || raw === 'auto') return undefined;
  const code = raw.slice(0, 2);
  return /^[a-z]{2}$/.test(code) ? code : undefined;
}

function transcriptFromAi(result: unknown): string {
  if (!result || typeof result !== 'object') return '';
  const record = result as Record<string, unknown>;
  if (typeof record.text === 'string') return record.text.trim();
  if (typeof record.transcription === 'string') return record.transcription.trim();
  return '';
}

async function readTranscribeAudio(request: Request): Promise<{
  ok: true;
  bytes: Uint8Array;
  language?: string;
} | { ok: false; status: number; error: string; message: string }> {
  const contentType = request.headers.get('Content-Type') ?? '';
  if (contentType.includes('multipart/form-data')) {
    const form = await request.formData();
    const file = form.get('audio');
    if (!file || typeof file === 'string' || typeof (file as Blob).arrayBuffer !== 'function') {
      return {
        ok: false,
        status: 400,
        error: 'missing_audio',
        message: 'Falta el archivo de audio (campo audio).',
      };
    }
    const bytes = new Uint8Array(await (file as Blob).arrayBuffer());
    return { ok: true, bytes, language: isoLanguage(form.get('language')) };
  }
  const bytes = new Uint8Array(await request.arrayBuffer());
  const url = new URL(request.url);
  return { ok: true, bytes, language: isoLanguage(url.searchParams.get('language')) };
}

async function transcribeSpeech(
  request: Request,
  env: SpeechEnv,
  json: JsonFn,
): Promise<Response> {
  const user = await getRequestUser(env.DB, request);
  if (!user) return json({ error: 'Unauthorized' }, 401, request, env);
  if (!env.AI) {
    return json({ error: 'speech_unavailable', message: 'Workers AI no está configurado.' }, 503, request, env);
  }

  const quota = await speechQuotaForEmail(env.DB, user.email);
  if (!quota.ok) {
    return json({ error: quota.error, message: quota.message }, quota.status, request, env);
  }
  if (!quota.quota.unlimited && (quota.quota.remaining ?? 0) < 1) {
    return json({
      error: 'speech_quota_exceeded',
      message: 'Se agotaron los tokens de voz de este periodo.',
      quota: quota.quota,
    }, 402, request, env);
  }

  const audio = await readTranscribeAudio(request);
  if (!audio.ok) {
    return json({ error: audio.error, message: audio.message }, audio.status, request, env);
  }
  if (audio.bytes.byteLength < 400) {
    return json({ error: 'audio_too_short', message: 'No se captó audio suficiente.' }, 400, request, env);
  }
  if (audio.bytes.byteLength > MAX_TRANSCRIBE_BYTES) {
    return json({ error: 'audio_too_large', message: 'El audio no puede superar 2 MB. Dicta en tomas de unos 30 segundos.' }, 413, request, env);
  }

  let aiResult: unknown;
  let modelUsed = WHISPER_MODEL;
  try {
    const ran = await runSpeechModel(env.AI, audio.bytes, audio.language);
    aiResult = ran.result;
    modelUsed = ran.model;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Workers AI rechazó la transcripción.';
    return json({ error: 'speech_transcribe_failed', message }, 502, request, env);
  }

  const text = transcriptFromAi(aiResult);
  if (!text) {
    return json({ error: 'speech_empty', message: 'No se reconoció habla en esa grabación.' }, 422, request, env);
  }

  const tokens = countSpeechTokens(text);
  const consumed = await consumeSpeechTokens(env.DB, user.email, Math.max(1, tokens));
  if (!consumed.ok) {
    return json({
      error: consumed.error,
      message: consumed.message,
      text,
      ...(consumed.quota ? { quota: consumed.quota } : {}),
    }, consumed.status, request, env);
  }

  return json({
    text,
    tokens,
    model: modelUsed,
    ...consumed.quota,
  }, 200, request, env);
}

export function countSpeechTokens(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean);
  return words.length;
}

export function isAdminSpeechEmail(email: string): boolean {
  return email.trim().toLowerCase() === ADMIN_SPEECH_EMAIL;
}

export async function ensureSpeechSchema(db: D1Database): Promise<void> {
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS speech_usage (
      customer_id TEXT PRIMARY KEY NOT NULL,
      period_key TEXT NOT NULL,
      used_tokens INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    )
  `).run();
}

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

function parseEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const email = normalizeEmail(value);
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  return email;
}

export function normalizeSpeechPlan(value: string | null | undefined): SpeechPlanId | 'none' {
  const raw = (value ?? '').trim().toLowerCase();
  if (!raw) return 'none';
  if (raw.includes('admin')) return 'admin';
  if (raw.includes('advanced')) return 'advanced';
  if (raw.includes('starter') || raw.includes('start') || raw.includes('basic')) return 'starter';
  if (raw.includes('pro')) return 'pro';
  return 'none';
}

export function speechLimitForPlan(plan: SpeechPlanId | 'none'): number | null {
  if (plan === 'none') return 0;
  return SPEECH_PLAN_LIMITS[plan];
}

export function periodKeyFromSubscription(row: {
  last_payment_at?: string | null;
  start_time?: string | null;
  subscription_id: string;
}): string {
  return (row.last_payment_at || row.start_time || row.subscription_id).trim();
}

export async function findSpeechSubscription(db: D1Database, email: string): Promise<SpeechRow | null> {
  const normalized = normalizeEmail(email);
  return db.prepare(`
    SELECT d.customer_id, d.plan_type, d.status, d.last_payment_at, d.start_time,
           d.next_billing_at, d.subscription_id
    FROM paypal_subscription_details d
    LEFT JOIN customers c ON c.customer_id = d.customer_id
    WHERE lower(coalesce(d.subscriber_email, '')) = ?1
       OR lower(coalesce(c.email, '')) = ?1
    ORDER BY
      CASE WHEN lower(d.status) IN ('active', 'trialing', 'trial') THEN 0 ELSE 1 END,
      d.updated_at DESC
    LIMIT 1
  `).bind(normalized).first<SpeechRow>();
}

function quotaPayload(plan: SpeechPlanId | 'none', used: number, periodKey: string): SpeechQuota {
  const limit = speechLimitForPlan(plan);
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
  };
}

function adminQuota(): SpeechQuota {
  return quotaPayload('admin', 0, 'admin-unlimited');
}

async function readUsage(db: D1Database, customerId: string, periodKey: string): Promise<number> {
  const row = await db.prepare(
    'SELECT period_key, used_tokens FROM speech_usage WHERE customer_id = ?1',
  ).bind(customerId).first<{ period_key: string; used_tokens: number }>();
  if (!row || row.period_key !== periodKey) return 0;
  return Number(row.used_tokens) || 0;
}

export async function speechQuotaForEmail(db: D1Database, email: string): Promise<{
  ok: true;
  quota: SpeechQuota;
} | { ok: false; status: number; error: string; message: string }> {
  await ensureSpeechSchema(db);
  if (isAdminSpeechEmail(email)) {
    return { ok: true, quota: adminQuota() };
  }

  const row = await findSpeechSubscription(db, email);
  if (!row) {
    return {
      ok: false,
      status: 404,
      error: 'speech_no_subscription',
      message: 'No hay una suscripción ComesADE ligada a esa cuenta.',
    };
  }
  const active = isEntitlementActive(row.status, row.subscription_id, row.next_billing_at);
  const plan = active ? normalizeSpeechPlan(row.plan_type) : 'none';
  if (!active || plan === 'none') {
    return {
      ok: false,
      status: 402,
      error: 'speech_requires_plan',
      message: 'Necesitas un plan Starter, Pro o Advanced para usar voz.',
    };
  }
  if (plan === 'admin') {
    return { ok: true, quota: adminQuota() };
  }
  const periodKey = periodKeyFromSubscription(row);
  const used = await readUsage(db, row.customer_id, periodKey);
  return { ok: true, quota: quotaPayload(plan, used, periodKey) };
}

export async function consumeSpeechTokens(db: D1Database, email: string, tokens: number): Promise<{
  ok: true;
  quota: SpeechQuota;
} | { ok: false; status: number; error: string; message: string; quota?: SpeechQuota }> {
  if (!Number.isInteger(tokens) || tokens < 1 || tokens > 50_000) {
    return {
      ok: false,
      status: 400,
      error: 'invalid_tokens',
      message: 'El texto de voz debe tener entre 1 y 50000 palabras.',
    };
  }
  if (isAdminSpeechEmail(email)) {
    return { ok: true, quota: adminQuota() };
  }

  const found = await speechQuotaForEmail(db, email);
  if (!found.ok) return found;
  if (found.quota.unlimited || found.quota.plan === 'admin') {
    return { ok: true, quota: adminQuota() };
  }

  const row = await findSpeechSubscription(db, email);
  if (!row) return found;
  const periodKey = periodKeyFromSubscription(row);
  if ((found.quota.remaining ?? 0) < tokens) {
    return {
      ok: false,
      status: 402,
      error: 'speech_quota_exceeded',
      message: `El plan ${found.quota.plan} permite ${found.quota.limit} tokens de voz por pago. Quedan ${found.quota.remaining}.`,
      quota: found.quota,
    };
  }
  const now = new Date().toISOString();
  const write = await db.prepare(`
    INSERT INTO speech_usage (customer_id, period_key, used_tokens, updated_at)
    VALUES (?1, ?2, ?3, ?4)
    ON CONFLICT(customer_id) DO UPDATE SET
      period_key = excluded.period_key,
      used_tokens = CASE
        WHEN speech_usage.period_key = excluded.period_key THEN speech_usage.used_tokens + excluded.used_tokens
        ELSE excluded.used_tokens
      END,
      updated_at = excluded.updated_at
    WHERE speech_usage.period_key <> excluded.period_key
       OR speech_usage.used_tokens + excluded.used_tokens <= ?5
  `).bind(row.customer_id, periodKey, tokens, now, found.quota.limit ?? 0).run();

  const latest = await speechQuotaForEmail(db, email);
  if (Number(write.meta?.changes ?? 0) !== 1) {
    if (!latest.ok) return latest;
    return {
      ok: false,
      status: 402,
      error: 'speech_quota_exceeded',
      message: `El plan ${latest.quota.plan} permite ${latest.quota.limit} tokens de voz por pago. Quedan ${latest.quota.remaining}.`,
      quota: latest.quota,
    };
  }
  if (!latest.ok) return latest;
  return { ok: true, quota: latest.quota };
}

async function readSpeechJson(request: Request): Promise<
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; code: string; message: string }
> {
  const rawBody = await request.text();
  if (rawBody.length > MAX_SPEECH_JSON_LENGTH) {
    return { ok: false, code: 'payload_too_large', message: 'The JSON body is too large.' };
  }
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

export async function handleSpeechRoutes(
  request: Request,
  env: Env,
  json: JsonFn,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (
    url.pathname !== '/v1/speech/quota'
    && url.pathname !== '/v1/speech/consume'
    && url.pathname !== '/v1/speech/transcribe'
    && url.pathname !== '/v1/speech/models'
  ) {
    return null;
  }

  if (request.method === 'GET' && url.pathname === '/v1/speech/models') {
    return json({
      default: SPEECH_STT_MODEL,
      transcribe: '/v1/speech/transcribe',
      models: SPEECH_STT_MODELS,
    }, 200, request, env);
  }

  if (request.method === 'POST' && url.pathname === '/v1/speech/transcribe') {
    return transcribeSpeech(request, env, json);
  }

  if (request.method === 'GET' && url.pathname === '/v1/speech/quota') {
    const user = await getRequestUser(env.DB, request);
    if (!user) {
      return json({ error: 'Unauthorized' }, 401, request, env);
    }
    const result = await speechQuotaForEmail(env.DB, user.email);
    if (!result.ok) {
      return json({ error: result.error, message: result.message }, result.status, request, env);
    }
    return json(result.quota, 200, request, env);
  }

  if (request.method === 'POST' && url.pathname === '/v1/speech/consume') {
    const user = await getRequestUser(env.DB, request);
    if (!user) {
      return json({ error: 'Unauthorized' }, 401, request, env);
    }
    const parsed = await readSpeechJson(request);
    if (!parsed.ok) {
      return json({ error: parsed.code, message: parsed.message }, 400, request, env);
    }
    const text = typeof parsed.body.text === 'string' ? parsed.body.text : '';
    const tokens = countSpeechTokens(text);
    const result = await consumeSpeechTokens(env.DB, user.email, tokens);
    if (!result.ok) {
      return json({
        error: result.error,
        message: result.message,
        ...(result.quota ? { quota: result.quota } : {}),
      }, result.status, request, env);
    }
    return json({ ...result.quota, tokens }, 200, request, env);
  }

  return json({ error: 'method_not_allowed', message: 'Method not allowed.' }, 405, request, env);
}
