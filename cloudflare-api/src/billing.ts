import { getRequestUser } from './auth';
import { messageQuotaForEmail } from './message-quota';
import { isAdminSpeechEmail, speechQuotaForEmail } from './speech-quota';
import { isManualSubscriptionId, isPeriodExpired } from './subscription-period';

type JsonFn = (data: unknown, status: number, request: Request, env: Env) => Response;

type BillingEnv = Env & {
  PAYPAL_CLIENT_ID?: string;
  PAYPAL_CLIENT_SECRET?: string;
  PAYPAL_CURRENCY?: string;
  PAYPAL_ENVIRONMENT?: string;
  PAYPAL_PLAN_STARTER?: string;
  PAYPAL_PLAN_PRO?: string;
  PAYPAL_PLAN_ADVANCED?: string;
  PAYPAL_PRICE_STARTER?: string;
  PAYPAL_PRICE_PRO?: string;
  PAYPAL_PRICE_ADVANCED?: string;
  PAYPAL_WEBHOOK_ID?: string;
};

type BillingRow = {
  subscription_id: string;
  customer_id: string;
  status: string;
  price_id: string;
  product_id: string;
  updated_at: string;
  email: string;
  plan_id: string | null;
  plan_type: string | null;
  detail_status: string | null;
  amount_value: string | null;
  currency_code: string | null;
  billing_interval_unit: string | null;
  billing_interval_count: number | null;
  start_time: string | null;
  next_billing_at: string | null;
  last_payment_at: string | null;
  last_payment_amount_value: string | null;
  last_payment_currency_code: string | null;
  failed_payments_count: number | null;
  status_update_time: string | null;
  paypal_payer_id: string | null;
};

type PaypalSnapshot = {
  subscriptionId: string;
  planId: string;
  planType: string;
  status: string;
  amountValue: string | null;
  currencyCode: string;
  billingIntervalUnit: string;
  billingIntervalCount: number;
  startTime: string | null;
  nextBillingAt: string | null;
  lastPaymentAt: string | null;
  lastPaymentAmountValue: string | null;
  lastPaymentCurrencyCode: string | null;
  failedPaymentsCount: number;
  statusUpdateTime: string | null;
  paypalPayerId: string | null;
  subscriberEmail: string | null;
};

const ACCESS_STATUSES = new Set([
  'active', 'trialing', 'past_due', 'approved', 'trial', 'cancelled_to_end',
]);
const PAYPAL_SUBSCRIPTION_ID_PATTERN = /^[A-Za-z0-9_-]{3,64}$/;
const PAYPAL_WEBHOOK_EVENTS = new Set([
  'BILLING.SUBSCRIPTION.ACTIVATED',
  'BILLING.SUBSCRIPTION.UPDATED',
  'BILLING.SUBSCRIPTION.CANCELLED',
  'BILLING.SUBSCRIPTION.SUSPENDED',
  'BILLING.SUBSCRIPTION.EXPIRED',
  'BILLING.SUBSCRIPTION.PAYMENT.FAILED',
  'PAYMENT.SALE.COMPLETED',
  'PAYMENT.SALE.REFUNDED',
  'PAYMENT.SALE.REVERSED',
]);

let paypalTokenCache: { key: string; token: string; expiresAt: number } | null = null;

function text(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized || null;
}

function catalog(env: BillingEnv) {
  return {
    starter: text(env.PAYPAL_PLAN_STARTER) ?? '',
    pro: text(env.PAYPAL_PLAN_PRO) ?? '',
    advanced: text(env.PAYPAL_PLAN_ADVANCED) ?? '',
  };
}

function productFromPlanId(env: BillingEnv, planId: string | null): string | null {
  const plans = catalog(env);
  const normalized = text(planId);
  if (!normalized) return null;
  if (normalized === plans.starter || normalized === 'starter') return 'starter';
  if (normalized === plans.pro || normalized === 'pro') return 'pro';
  if (normalized === plans.advanced || normalized === 'advanced') return 'advanced';
  if (normalized === 'admin') return 'admin';
  return null;
}

function hasAccess(
  status: string,
  subscriptionId?: string | null,
  nextBillingAt?: string | null,
): boolean {
  const normalized = status.trim().toLowerCase();
  if (!ACCESS_STATUSES.has(normalized)) return false;
  if (isManualSubscriptionId(subscriptionId) && isPeriodExpired(nextBillingAt)) return false;
  if (normalized === 'cancelled_to_end' && isPeriodExpired(nextBillingAt)) return false;
  return true;
}

function adminPayload(email: string, userId: string) {
  const now = new Date().toISOString();
  return {
    has_access: true,
    unlimited: true,
    provider: 'internal',
    customer: { id: userId, email, paypal_payer_id: null },
    subscription: {
      id: `admin:${email}`,
      status: 'active',
      plan_id: 'admin',
      price_id: 'admin',
      product_id: 'admin',
      plan_type: 'admin',
      plan: 'admin',
      amount: null,
      billing_interval: null,
      started_at: now,
      next_billing_at: null,
      next_payment_at: null,
      last_payment_at: null,
      last_payment: null,
      failed_payments_count: 0,
      status_update_time: now,
      updated_at: now,
    },
  };
}

function billingPayload(row: BillingRow | null) {
  if (!row) {
    return {
      has_access: false,
      provider: 'paypal',
      customer: null,
      subscription: null,
    };
  }
  const status = text(row.detail_status ?? row.status) ?? 'unknown';
  const planType = text(row.plan_type ?? row.product_id);
  const amount = row.amount_value && row.currency_code
    ? { value: row.amount_value, currency_code: row.currency_code }
    : null;
  const access = hasAccess(status, row.subscription_id, row.next_billing_at);
  return {
    has_access: access,
    provider: 'paypal',
    customer: {
      id: row.customer_id,
      email: row.email,
      paypal_payer_id: row.paypal_payer_id,
    },
    subscription: {
      id: row.subscription_id,
      status,
      plan_id: row.plan_id ?? row.price_id,
      price_id: row.price_id,
      product_id: row.product_id,
      plan_type: planType,
      plan: planType,
      amount,
      billing_interval: row.billing_interval_unit
        ? { unit: row.billing_interval_unit, count: Number(row.billing_interval_count ?? 1) }
        : null,
      started_at: row.start_time,
      next_billing_at: row.next_billing_at,
      next_payment_at: row.next_billing_at,
      last_payment_at: row.last_payment_at,
      last_payment: row.last_payment_at
        ? {
          amount: row.last_payment_amount_value && row.last_payment_currency_code
            ? { value: row.last_payment_amount_value, currency_code: row.last_payment_currency_code }
            : null,
          time: row.last_payment_at,
        }
        : null,
      failed_payments_count: Number(row.failed_payments_count ?? 0),
      status_update_time: row.status_update_time,
      updated_at: row.updated_at,
    },
  };
}

export async function ensureBillingSchema(db: D1Database): Promise<void> {
  await db.batch([
    db.prepare(`
      CREATE TABLE IF NOT EXISTS customers (
        customer_id TEXT PRIMARY KEY NOT NULL,
        email TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_event_at TEXT NOT NULL DEFAULT ''
      )
    `),
    db.prepare(`
      CREATE TABLE IF NOT EXISTS subscriptions (
        subscription_id TEXT PRIMARY KEY NOT NULL,
        customer_id TEXT NOT NULL,
        status TEXT NOT NULL,
        price_id TEXT NOT NULL,
        product_id TEXT NOT NULL,
        scheduled_change_action TEXT,
        scheduled_change_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_event_at TEXT NOT NULL
      )
    `),
    db.prepare(`
      CREATE TABLE IF NOT EXISTS paypal_subscription_details (
        subscription_id TEXT PRIMARY KEY NOT NULL,
        customer_id TEXT NOT NULL,
        plan_id TEXT NOT NULL,
        plan_type TEXT NOT NULL,
        status TEXT NOT NULL,
        amount_value TEXT,
        currency_code TEXT,
        billing_interval_unit TEXT,
        billing_interval_count INTEGER,
        start_time TEXT,
        next_billing_at TEXT,
        last_payment_at TEXT,
        last_payment_amount_value TEXT,
        last_payment_currency_code TEXT,
        failed_payments_count INTEGER NOT NULL DEFAULT 0,
        status_update_time TEXT,
        paypal_payer_id TEXT,
        subscriber_email TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_event_at TEXT NOT NULL,
        last_event_id TEXT
      )
    `),
    db.prepare(`
      CREATE TABLE IF NOT EXISTS paypal_webhook_events (
        event_id TEXT PRIMARY KEY NOT NULL,
        event_type TEXT NOT NULL,
        subscription_id TEXT,
        received_at TEXT NOT NULL,
        processed_at TEXT,
        status TEXT NOT NULL,
        error TEXT
      )
    `),
    db.prepare(`
      CREATE TABLE IF NOT EXISTS speech_usage (
        customer_id TEXT PRIMARY KEY NOT NULL,
        period_key TEXT NOT NULL,
        used_tokens INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      )
    `),
    db.prepare(`
      CREATE TABLE IF NOT EXISTS message_usage (
        customer_id TEXT PRIMARY KEY NOT NULL,
        period_key TEXT NOT NULL,
        used INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      )
    `),
  ]);
}

async function readBillingRow(db: D1Database, email: string): Promise<BillingRow | null> {
  return db.prepare(`
    SELECT
      s.subscription_id, s.customer_id, s.status, s.price_id, s.product_id, s.updated_at,
      c.email, d.plan_id, d.plan_type, d.status AS detail_status,
      d.amount_value, d.currency_code, d.billing_interval_unit, d.billing_interval_count,
      d.start_time, d.next_billing_at, d.last_payment_at,
      d.last_payment_amount_value, d.last_payment_currency_code, d.failed_payments_count,
      d.status_update_time, d.paypal_payer_id
    FROM subscriptions s
    JOIN customers c ON c.customer_id = s.customer_id
    LEFT JOIN paypal_subscription_details d ON d.subscription_id = s.subscription_id
    WHERE lower(c.email) = ?1
    ORDER BY s.updated_at DESC
    LIMIT 1
  `).bind(email.trim().toLowerCase()).first<BillingRow>();
}

function paypalBaseUrl(env: BillingEnv): string {
  return (text(env.PAYPAL_ENVIRONMENT) ?? 'live').toLowerCase() === 'sandbox'
    ? 'https://api-m.sandbox.paypal.com'
    : 'https://api-m.paypal.com';
}

async function paypalAccessToken(env: BillingEnv): Promise<string> {
  const clientId = text(env.PAYPAL_CLIENT_ID);
  const clientSecret = text(env.PAYPAL_CLIENT_SECRET);
  if (!clientId || !clientSecret) {
    throw new Error('paypal_not_configured');
  }
  const key = `${paypalBaseUrl(env)}:${clientId}`;
  if (paypalTokenCache?.key === key && paypalTokenCache.expiresAt > Date.now() + 30_000) {
    return paypalTokenCache.token;
  }
  const response = await fetch(`${paypalBaseUrl(env)}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  const payload = await response.json() as { access_token?: string; expires_in?: number };
  if (!response.ok || !payload.access_token) {
    throw new Error('paypal_unavailable');
  }
  paypalTokenCache = {
    key,
    token: payload.access_token,
    expiresAt: Date.now() + Math.max(30, Number(payload.expires_in ?? 300) - 60) * 1000,
  };
  return payload.access_token;
}

async function paypalGet(env: BillingEnv, path: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
  const token = await paypalAccessToken(env);
  const response = await fetch(`${paypalBaseUrl(env)}${path}`, {
    ...init,
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
  });
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) {
    const error = new Error(String(payload.message ?? payload.error_description ?? 'PayPal rejected the request.'));
    (error as Error & { status?: number }).status = response.status >= 500 ? 502 : response.status;
    throw error;
  }
  return payload;
}

function buildSnapshot(env: BillingEnv, details: Record<string, unknown>, expectedPlanId: string | null): PaypalSnapshot {
  const subscriptionId = text(details.id);
  if (!subscriptionId || !PAYPAL_SUBSCRIPTION_ID_PATTERN.test(subscriptionId)) {
    throw new Error('PayPal devolvió una suscripción sin ID válido.');
  }
  const planId = text(details.plan_id) ?? expectedPlanId;
  const planType = productFromPlanId(env, planId);
  if (!planId || !planType) {
    throw new Error('La suscripción usa un plan de PayPal no autorizado.');
  }
  if (expectedPlanId && productFromPlanId(env, expectedPlanId) !== planType) {
    throw new Error('El plan aprobado no coincide con el plan solicitado.');
  }
  const status = text(details.status)?.toLowerCase();
  if (!status) throw new Error('PayPal devolvió la suscripción sin estado.');
  const billingInfo = (details.billing_info ?? {}) as Record<string, unknown>;
  const lastPayment = (billingInfo.last_payment ?? {}) as Record<string, unknown>;
  const lastPaymentAmount = (lastPayment.amount ?? {}) as Record<string, unknown>;
  const subscriber = (details.subscriber ?? {}) as Record<string, unknown>;
  return {
    subscriptionId,
    planId,
    planType,
    status,
    amountValue: text((lastPaymentAmount.value as string | undefined)) ?? null,
    currencyCode: (text(lastPaymentAmount.currency_code) ?? text(env.PAYPAL_CURRENCY) ?? 'USD').toUpperCase(),
    billingIntervalUnit: 'month',
    billingIntervalCount: 1,
    startTime: text(details.start_time),
    nextBillingAt: text((billingInfo.next_billing_time as string | undefined)),
    lastPaymentAt: text(lastPayment.time),
    lastPaymentAmountValue: text(lastPaymentAmount.value),
    lastPaymentCurrencyCode: text(lastPaymentAmount.currency_code),
    failedPaymentsCount: Number(billingInfo.failed_payments_count ?? 0) || 0,
    statusUpdateTime: text(details.status_update_time),
    paypalPayerId: text(subscriber.payer_id),
    subscriberEmail: text(subscriber.email_address),
  };
}

async function upsertSnapshot(
  db: D1Database,
  snapshot: PaypalSnapshot,
  customerId: string,
  customerEmail: string,
  eventAt: string,
  eventId: string | null,
): Promise<void> {
  const now = new Date().toISOString();
  await db.prepare(`
    INSERT INTO customers (customer_id, email, created_at, updated_at, last_event_at)
    VALUES (?1, ?2, ?3, ?4, ?5)
    ON CONFLICT(customer_id) DO UPDATE SET
      email = excluded.email,
      updated_at = excluded.updated_at,
      last_event_at = excluded.last_event_at
  `).bind(customerId, customerEmail, now, now, eventAt).run();

  await db.prepare(`
    INSERT INTO subscriptions (
      subscription_id, customer_id, status, price_id, product_id,
      scheduled_change_action, scheduled_change_at, created_at, updated_at, last_event_at
    )
    VALUES (?1, ?2, ?3, ?4, ?5, NULL, NULL, ?6, ?7, ?8)
    ON CONFLICT(subscription_id) DO UPDATE SET
      customer_id = excluded.customer_id,
      status = excluded.status,
      price_id = excluded.price_id,
      product_id = excluded.product_id,
      updated_at = excluded.updated_at,
      last_event_at = excluded.last_event_at
  `).bind(
    snapshot.subscriptionId,
    customerId,
    snapshot.status,
    snapshot.planId,
    snapshot.planType,
    now,
    now,
    eventAt,
  ).run();

  await db.prepare(`
    INSERT INTO paypal_subscription_details (
      subscription_id, customer_id, plan_id, plan_type, status,
      amount_value, currency_code, billing_interval_unit, billing_interval_count,
      start_time, next_billing_at, last_payment_at,
      last_payment_amount_value, last_payment_currency_code, failed_payments_count,
      status_update_time, paypal_payer_id, subscriber_email,
      created_at, updated_at, last_event_at, last_event_id
    )
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22)
    ON CONFLICT(subscription_id) DO UPDATE SET
      customer_id = excluded.customer_id,
      plan_id = excluded.plan_id,
      plan_type = excluded.plan_type,
      status = excluded.status,
      amount_value = excluded.amount_value,
      currency_code = excluded.currency_code,
      billing_interval_unit = excluded.billing_interval_unit,
      billing_interval_count = excluded.billing_interval_count,
      start_time = excluded.start_time,
      next_billing_at = excluded.next_billing_at,
      last_payment_at = excluded.last_payment_at,
      last_payment_amount_value = excluded.last_payment_amount_value,
      last_payment_currency_code = excluded.last_payment_currency_code,
      failed_payments_count = excluded.failed_payments_count,
      status_update_time = excluded.status_update_time,
      paypal_payer_id = excluded.paypal_payer_id,
      subscriber_email = excluded.subscriber_email,
      updated_at = excluded.updated_at,
      last_event_at = excluded.last_event_at,
      last_event_id = excluded.last_event_id
  `).bind(
    snapshot.subscriptionId,
    customerId,
    snapshot.planId,
    snapshot.planType,
    snapshot.status,
    snapshot.amountValue,
    snapshot.currencyCode,
    snapshot.billingIntervalUnit,
    snapshot.billingIntervalCount,
    snapshot.startTime,
    snapshot.nextBillingAt,
    snapshot.lastPaymentAt,
    snapshot.lastPaymentAmountValue,
    snapshot.lastPaymentCurrencyCode,
    snapshot.failedPaymentsCount,
    snapshot.statusUpdateTime,
    snapshot.paypalPayerId,
    snapshot.subscriberEmail,
    now,
    now,
    eventAt,
    eventId,
  ).run();
}

async function resolveCustomerId(db: D1Database, userId: string, email: string): Promise<string> {
  const byEmail = await db.prepare(
    'SELECT customer_id FROM customers WHERE lower(email) = ?1 LIMIT 1',
  ).bind(email.trim().toLowerCase()).first<{ customer_id: string }>();
  return byEmail?.customer_id ?? `user:${userId}`;
}

export async function handleBillingRoutes(
  request: Request,
  env: Env,
  json: JsonFn,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/v1/billing/')) return null;
  const billingEnv = env as BillingEnv;
  await ensureBillingSchema(env.DB);

  if (request.method === 'GET' && url.pathname === '/v1/billing/status') {
    const user = await getRequestUser(env.DB, request);
    if (!user) return json({ error: 'Unauthorized' }, 401, request, env);
    if (isAdminSpeechEmail(user.email)) {
      const payload = adminPayload(user.email, user.id) as Record<string, unknown>;
      const speech = await speechQuotaForEmail(env.DB, user.email);
      const messages = await messageQuotaForEmail(env.DB, user.email);
      payload.speech = speech.ok ? speech.quota : { plan: 'admin', unlimited: true, limit: null, used: 0, remaining: null };
      payload.messages = messages.ok ? messages.quota : { plan: 'admin', unlimited: true, limit: null, used: 0, remaining: null };
      return json(payload, 200, request, env);
    }
    const row = await readBillingRow(env.DB, user.email);
    const payload = billingPayload(row) as Record<string, unknown>;
    const speech = await speechQuotaForEmail(env.DB, user.email);
    const messages = await messageQuotaForEmail(env.DB, user.email);
    payload.speech = speech.ok ? speech.quota : null;
    payload.messages = messages.ok ? messages.quota : null;
    return json(payload, 200, request, env);
  }

  if (request.method === 'POST' && url.pathname === '/v1/billing/paypal/activate') {
    const user = await getRequestUser(env.DB, request);
    if (!user) return json({ error: 'Unauthorized' }, 401, request, env);
    let body: Record<string, unknown>;
    try {
      body = await request.json() as Record<string, unknown>;
    } catch {
      return json({ error: 'invalid_json_body' }, 400, request, env);
    }
    const subscriptionId = text(body.subscription_id ?? body.subscriptionID);
    const planId = text(body.plan_id);
    if (!subscriptionId || !PAYPAL_SUBSCRIPTION_ID_PATTERN.test(subscriptionId)) {
      return json({ error: 'Falta el ID de suscripción de PayPal.' }, 400, request, env);
    }
    if (!planId || !productFromPlanId(billingEnv, planId)) {
      return json({ error: 'El plan de PayPal no está configurado.' }, 400, request, env);
    }
    try {
      const details = await paypalGet(billingEnv, `/v1/billing/subscriptions/${encodeURIComponent(subscriptionId)}`);
      const snapshot = buildSnapshot(billingEnv, details, planId);
      if (!hasAccess(snapshot.status)) {
        return json({
          error: `La suscripción de PayPal todavía no está activa (${snapshot.status}).`,
        }, 409, request, env);
      }
      const customerId = await resolveCustomerId(env.DB, user.id, user.email);
      const eventAt = new Date().toISOString();
      await upsertSnapshot(env.DB, snapshot, customerId, user.email, eventAt, null);
      const row = await readBillingRow(env.DB, user.email);
      return json(billingPayload(row), 200, request, env);
    } catch (error) {
      const status = (error as { status?: number }).status ?? 502;
      const message = error instanceof Error ? error.message : 'No se pudo verificar la suscripción con PayPal.';
      if (message === 'paypal_not_configured') {
        return json({ error: 'PayPal no está configurado en la API.' }, 503, request, env);
      }
      return json({ error: message }, status >= 400 && status < 600 ? status : 502, request, env);
    }
  }

  if (request.method === 'POST' && url.pathname === '/v1/billing/paypal/webhook') {
    const rawBody = await request.text();
    let payload: Record<string, unknown>;
    try {
      payload = rawBody ? JSON.parse(rawBody) as Record<string, unknown> : {};
    } catch {
      return json({ error: 'El webhook no contiene JSON válido.' }, 400, request, env);
    }
    const eventId = text(payload.id);
    const eventType = text(payload.event_type);
    if (!eventId || !eventType) {
      return json({ error: 'El webhook no tiene id o event_type.' }, 400, request, env);
    }
    const webhookId = text(billingEnv.PAYPAL_WEBHOOK_ID);
    if (!webhookId) {
      return json({ error: 'Falta configurar PAYPAL_WEBHOOK_ID.' }, 503, request, env);
    }
    try {
      const resource = (payload.resource ?? {}) as Record<string, unknown>;
      const billingAgreement = resource.billing_agreement_id ?? resource.id;
      const subscriptionId = text(billingAgreement);
      if (!PAYPAL_WEBHOOK_EVENTS.has(eventType) || !subscriptionId) {
        return json({ ok: true, ignored: true }, 200, request, env);
      }
      const verification = await paypalGet(billingEnv, '/v1/notifications/verify-webhook-signature', {
        method: 'POST',
        body: JSON.stringify({
          auth_algo: request.headers.get('PAYPAL-AUTH-ALGO'),
          cert_url: request.headers.get('PAYPAL-CERT-URL'),
          transmission_id: request.headers.get('PAYPAL-TRANSMISSION-ID'),
          transmission_sig: request.headers.get('PAYPAL-TRANSMISSION-SIG'),
          transmission_time: request.headers.get('PAYPAL-TRANSMISSION-TIME'),
          webhook_id: webhookId,
          webhook_event: payload,
        }),
      });
      if (String(verification.verification_status ?? '').toUpperCase() !== 'SUCCESS') {
        return json({ error: 'La firma del webhook de PayPal no es válida.' }, 400, request, env);
      }
      const details = await paypalGet(
        billingEnv,
        `/v1/billing/subscriptions/${encodeURIComponent(subscriptionId)}`,
      );
      const snapshot = buildSnapshot(billingEnv, details, null);
      const existing = await env.DB.prepare(
        'SELECT customer_id FROM subscriptions WHERE subscription_id = ?1',
      ).bind(snapshot.subscriptionId).first<{ customer_id: string }>();
      const email = snapshot.subscriberEmail
        ?? (existing
          ? (await env.DB.prepare('SELECT email FROM customers WHERE customer_id = ?1')
            .bind(existing.customer_id).first<{ email: string }>())?.email
          : null)
        ?? `paypal-${snapshot.subscriptionId}@placeholder.invalid`;
      const customerId = existing?.customer_id
        ?? await resolveCustomerId(env.DB, snapshot.subscriptionId, email);
      await upsertSnapshot(
        env.DB,
        snapshot,
        customerId,
        email,
        new Date().toISOString(),
        eventId,
      );
      return json({
        ok: true,
        subscription_id: snapshot.subscriptionId,
        status: snapshot.status,
        plan_type: snapshot.planType,
        next_billing_at: snapshot.nextBillingAt,
      }, 200, request, env);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'No se pudo procesar el webhook de PayPal.';
      return json({ error: message }, 502, request, env);
    }
  }

  return json({ error: 'Not found' }, 404, request, env);
}
