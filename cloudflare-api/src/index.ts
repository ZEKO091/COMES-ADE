import { handleAuthRoutes } from './auth';
import { handleBetterAuthRoutes } from './better-auth';
import { handleBillingRoutes } from './billing';
import { handleMessageRoutes } from './message-quota';
import { handleSpeechRoutes } from './speech-quota';

type HealthRow = {
  ok: number;
};

type JsonObject = Record<string, unknown>;

type PayPalEnvironment = 'sandbox' | 'live';

type PayPalEnv = Env & {
  PAYPAL_ALLOWED_ORIGINS?: string;
  PAYPAL_CLIENT_ID?: string;
  PAYPAL_CLIENT_SECRET?: string;
  PAYPAL_CURRENCY?: string;
  PAYPAL_ENVIRONMENT?: string;
  PAYPAL_PARTNER_ATTRIBUTION_ID?: string;
  PAYPAL_PRODUCT_AMOUNT?: string;
  PAYPAL_PRODUCT_ID?: string;
  PAYPAL_PRODUCT_NAME?: string;
};

type PayPalSettings = {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  currency: string;
  environment: PayPalEnvironment;
  fractionDigits: number;
  partnerAttributionId?: string;
  productAmountMinor: number;
  productId: string;
  productName: string;
};

type PayPalResponse = {
  data: unknown;
  status: number;
};

type JsonBodyResult =
  | { body: JsonObject; ok: true }
  | { code: string; message: string; ok: false };

const MAX_JSON_BODY_LENGTH = 16 * 1024;
const MAX_QUANTITY = 10;
const MAX_TOTAL_MINOR_UNITS = 100_000_000;

const ZERO_DECIMAL_CURRENCIES = new Set([
  'BIF',
  'CLP',
  'DJF',
  'GNF',
  'JPY',
  'KMF',
  'KRW',
  'MGA',
  'PYG',
  'RWF',
  'UGX',
  'VND',
  'VUV',
  'XAF',
  'XOF',
  'XPF',
]);

const THREE_DECIMAL_CURRENCIES = new Set([
  'BHD',
  'IQD',
  'JOD',
  'KWD',
  'LYD',
  'OMR',
  'TND',
]);

let accessTokenCache: {
  baseUrl: string;
  clientId: string;
  expiresAt: number;
  token: string;
} | null = null;

let accessTokenInflight: Promise<string> | null = null;

let clientTokenCache: {
  clientId: string;
  expiresAt: number;
  expiresIn?: number;
  token: string;
} | null = null;

let paypalConfigCache: {
  body: unknown;
  expiresAt: number;
  key: string;
} | null = null;

const PAYPAL_CONFIG_TTL_MS = 60_000;

class InvalidRequestError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

class PayPalConfigurationError extends Error {}

class PayPalUnavailableError extends Error {
  constructor(
    message: string,
    public readonly upstreamStatus?: number,
  ) {
    super(message);
  }
}

function asPayPalEnv(env: Env): PayPalEnv {
  return env as PayPalEnv;
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function originAllowed(env: PayPalEnv, origin: string): boolean {
  const extra = env.PAYPAL_ALLOWED_ORIGINS
    ?.split(',')
    .map((item) => item.trim())
    .filter(Boolean) ?? [];
  if (extra.includes(origin)) return true;
  try {
    const url = new URL(origin);
    const host = url.hostname.toLowerCase();
    if (host === 'tauri.localhost' || host === 'asset.localhost') return true;
    if (host === 'localhost' || host === '127.0.0.1' || host === '[::1]') return true;
    if (host === 'usecomesade.pages.dev' || host.endsWith('.usecomesade.pages.dev')) return true;
    if (host === 'usecomes.com' || host === 'www.usecomes.com' || host.endsWith('.usecomes.com')) return true;
  } catch {
    return false;
  }
  return false;
}

function getCorsHeaders(env: PayPalEnv, request: Request): Headers {
  const requestOrigin = request.headers.get('Origin');
  const headers = new Headers({
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, Cookie, PayPal-Request-Id',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Max-Age': '600',
    'Cache-Control': 'no-store',
  });

  if (requestOrigin && originAllowed(env, requestOrigin)) {
    headers.set('Access-Control-Allow-Origin', requestOrigin);
    headers.set('Access-Control-Allow-Credentials', 'true');
    headers.set('Access-Control-Expose-Headers', 'set-auth-token');
    headers.set('Vary', 'Origin');
  } else if (!requestOrigin) {
    headers.set('Access-Control-Allow-Origin', '*');
  } else {
    headers.set('Access-Control-Allow-Origin', 'null');
    headers.set('Vary', 'Origin');
  }

  return headers;
}

function json(
  data: unknown,
  status: number,
  request: Request,
  env: Env,
  extraHeaders: HeadersInit = {},
): Response {
  const headers = getCorsHeaders(asPayPalEnv(env), request);
  headers.set('Content-Type', 'application/json; charset=utf-8');
  for (const [key, value] of new Headers(extraHeaders).entries()) {
    headers.set(key, value);
  }

  return new Response(JSON.stringify(data), { headers, status });
}

function getCurrencyFractionDigits(currency: string): number {
  if (ZERO_DECIMAL_CURRENCIES.has(currency)) return 0;
  if (THREE_DECIMAL_CURRENCIES.has(currency)) return 3;
  return 2;
}

function parseMoney(rawValue: string, label: string, fractionDigits: number): number {
  const value = rawValue.trim();
  const pattern = fractionDigits === 0
    ? /^\d+$/
    : new RegExp(`^\\d+(?:\\.\\d{1,${fractionDigits}})?$`);

  if (!pattern.test(value)) {
    throw new PayPalConfigurationError(`${label} must be a valid monetary amount.`);
  }

  const [wholePart, fractionPart = ''] = value.split('.');
  const scale = 10 ** fractionDigits;
  const wholeUnits = Number(wholePart) * scale;
  const fractionalUnits = fractionDigits === 0
    ? 0
    : Number((fractionPart + '0'.repeat(fractionDigits)).slice(0, fractionDigits));
  const minorUnits = wholeUnits + fractionalUnits;

  if (
    !Number.isSafeInteger(minorUnits)
    || minorUnits <= 0
    || minorUnits > MAX_TOTAL_MINOR_UNITS
  ) {
    throw new PayPalConfigurationError(`${label} is outside the supported range.`);
  }

  return minorUnits;
}

function formatMoney(minorUnits: number, fractionDigits: number): string {
  const scale = 10 ** fractionDigits;
  const wholeUnits = Math.floor(minorUnits / scale);

  if (fractionDigits === 0) return String(wholeUnits);

  const fractionalUnits = String(minorUnits % scale).padStart(fractionDigits, '0');
  return `${wholeUnits}.${fractionalUnits}`;
}

function getPayPalSettings(env: Env): PayPalSettings {
  const paypalEnv = asPayPalEnv(env);
  const rawEnvironment = (paypalEnv.PAYPAL_ENVIRONMENT ?? 'sandbox').trim().toLowerCase();
  const clientId = paypalEnv.PAYPAL_CLIENT_ID?.trim();
  const clientSecret = paypalEnv.PAYPAL_CLIENT_SECRET?.trim();
  const currency = (paypalEnv.PAYPAL_CURRENCY ?? 'USD').trim().toUpperCase();
  const productId = paypalEnv.PAYPAL_PRODUCT_ID?.trim();
  const productName = paypalEnv.PAYPAL_PRODUCT_NAME?.trim();
  const productAmount = paypalEnv.PAYPAL_PRODUCT_AMOUNT?.trim();

  const missing = [
    ['PAYPAL_CLIENT_ID', clientId],
    ['PAYPAL_CLIENT_SECRET', clientSecret],
    ['PAYPAL_PRODUCT_ID', productId],
    ['PAYPAL_PRODUCT_NAME', productName],
    ['PAYPAL_PRODUCT_AMOUNT', productAmount],
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name);

  if (missing.length) {
    throw new PayPalConfigurationError('PayPal credentials or product configuration are missing.');
  }

  if (rawEnvironment !== 'sandbox' && rawEnvironment !== 'live') {
    throw new PayPalConfigurationError('PAYPAL_ENVIRONMENT must be sandbox or live.');
  }

  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new PayPalConfigurationError('PAYPAL_CURRENCY must be a 3-letter ISO currency code.');
  }

  if (!/^[A-Za-z0-9._-]{1,127}$/.test(productId!)) {
    throw new PayPalConfigurationError('PAYPAL_PRODUCT_ID contains unsupported characters.');
  }

  if (productName!.length > 127) {
    throw new PayPalConfigurationError('PAYPAL_PRODUCT_NAME is too long.');
  }

  const fractionDigits = getCurrencyFractionDigits(currency);
  const productAmountMinor = parseMoney(productAmount!, 'PAYPAL_PRODUCT_AMOUNT', fractionDigits);
  const partnerAttributionId = paypalEnv.PAYPAL_PARTNER_ATTRIBUTION_ID?.trim() || undefined;
  const environment = rawEnvironment as PayPalEnvironment;

  return {
    baseUrl: environment === 'live'
      ? 'https://api-m.paypal.com'
      : 'https://api-m.sandbox.paypal.com',
    clientId: clientId!,
    clientSecret: clientSecret!,
    currency,
    environment,
    fractionDigits,
    partnerAttributionId,
    productAmountMinor,
    productId: productId!,
    productName: productName!,
  };
}

async function readPayPalBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return undefined;

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { error: 'PayPal returned a non-JSON response.' };
  }
}

async function requestAccessToken(settings: PayPalSettings): Promise<string> {
  const basicCredentials = btoa(`${settings.clientId}:${settings.clientSecret}`);
  let response: Response;

  try {
    response = await fetch(`${settings.baseUrl}/v1/oauth2/token`, {
      body: 'grant_type=client_credentials',
      headers: {
        Accept: 'application/json',
        'Accept-Language': 'en_US',
        Authorization: `Basic ${basicCredentials}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        ...(settings.partnerAttributionId
          ? { 'PayPal-Partner-Attribution-Id': settings.partnerAttributionId }
          : {}),
      },
      method: 'POST',
    });
  } catch {
    throw new PayPalUnavailableError('PayPal OAuth request failed.');
  }

  const data = await readPayPalBody(response);
  if (!response.ok) {
    throw new PayPalUnavailableError('PayPal OAuth request was rejected.', response.status);
  }

  if (!isRecord(data) || typeof data.access_token !== 'string' || !data.access_token) {
    throw new PayPalUnavailableError('PayPal OAuth response did not include an access token.');
  }

  const expiresIn = typeof data.expires_in === 'number' && Number.isFinite(data.expires_in)
    ? data.expires_in
    : 300;

  accessTokenCache = {
    baseUrl: settings.baseUrl,
    clientId: settings.clientId,
    expiresAt: Date.now() + Math.max(30, expiresIn - 60) * 1000,
    token: data.access_token,
  };

  return data.access_token;
}

async function getAccessToken(
  settings: PayPalSettings,
  forceRefresh = false,
): Promise<string> {
  if (
    !forceRefresh
    && accessTokenCache
    && accessTokenCache.baseUrl === settings.baseUrl
    && accessTokenCache.clientId === settings.clientId
    && accessTokenCache.expiresAt > Date.now() + 30_000
  ) {
    return accessTokenCache.token;
  }

  if (!forceRefresh && accessTokenInflight) {
    return accessTokenInflight;
  }

  const request = requestAccessToken(settings);
  accessTokenInflight = request;
  try {
    return await request;
  } finally {
    if (accessTokenInflight === request) {
      accessTokenInflight = null;
    }
  }
}

async function warmPayPal(env: Env): Promise<void> {
  try {
    const settings = getPayPalSettings(env);
    await getAccessToken(settings);
  } catch (error) {
    if (error instanceof PayPalConfigurationError) return;
    console.error('[paypal] keep-alive failed', {
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}

async function paypalRequest(
  settings: PayPalSettings,
  path: string,
  init: RequestInit,
  retryAfterUnauthorized = true,
): Promise<PayPalResponse> {
  const accessToken = await getAccessToken(settings);
  const headers = new Headers(init.headers);
  headers.set('Accept', 'application/json');
  headers.set('Authorization', `Bearer ${accessToken}`);
  if (settings.partnerAttributionId) {
    headers.set('PayPal-Partner-Attribution-Id', settings.partnerAttributionId);
  }

  let response: Response;
  try {
    response = await fetch(`${settings.baseUrl}${path}`, {
      ...init,
      headers,
    });
  } catch {
    throw new PayPalUnavailableError('PayPal API request failed.');
  }

  if (response.status === 401 && retryAfterUnauthorized) {
    accessTokenCache = null;
    return paypalRequest(settings, path, init, false);
  }

  return {
    data: await readPayPalBody(response),
    status: response.status,
  };
}

async function readJsonObject(request: Request): Promise<JsonBodyResult> {
  const contentLength = request.headers.get('Content-Length');
  if (contentLength) {
    const parsedLength = Number(contentLength);
    if (Number.isFinite(parsedLength) && parsedLength > MAX_JSON_BODY_LENGTH) {
      return {
        code: 'payload_too_large',
        message: 'The JSON body is too large.',
        ok: false,
      };
    }
  }

  const contentType = request.headers.get('Content-Type')?.split(';', 1)[0].trim().toLowerCase();
  if (contentType !== 'application/json') {
    return {
      code: 'invalid_content_type',
      message: 'Content-Type must be application/json.',
      ok: false,
    };
  }

  const rawBody = await request.text();
  if (rawBody.length > MAX_JSON_BODY_LENGTH) {
    return {
      code: 'payload_too_large',
      message: 'The JSON body is too large.',
      ok: false,
    };
  }

  try {
    const body: unknown = JSON.parse(rawBody);
    if (!isRecord(body)) {
      return {
        code: 'invalid_json_body',
        message: 'The JSON body must be an object.',
        ok: false,
      };
    }
    return { body, ok: true };
  } catch {
    return {
      code: 'invalid_json_body',
      message: 'The request body is not valid JSON.',
      ok: false,
    };
  }
}

function getRequestId(request: Request): string {
  const providedRequestId = request.headers.get('PayPal-Request-Id')?.trim();
  if (providedRequestId && providedRequestId.length > 108) {
    throw new InvalidRequestError(
      'invalid_request_id',
      'PayPal-Request-Id must be at most 108 characters.',
    );
  }

  return providedRequestId || crypto.randomUUID();
}

function getOrderLine(settings: PayPalSettings, body: JsonObject): {
  quantity: number;
  totalMinorUnits: number;
} {
  const requestedProductId = body.product_id;
  if (requestedProductId !== undefined && requestedProductId !== settings.productId) {
    throw new InvalidRequestError('invalid_product', 'The requested product is not available.');
  }

  const quantity = body.quantity === undefined ? 1 : body.quantity;
  if (typeof quantity !== 'number' || !Number.isInteger(quantity)) {
    throw new InvalidRequestError('invalid_quantity', 'quantity must be an integer.');
  }
  if (quantity < 1 || quantity > MAX_QUANTITY) {
    throw new InvalidRequestError('invalid_quantity', `quantity must be between 1 and ${MAX_QUANTITY}.`);
  }

  const totalMinorUnits = settings.productAmountMinor * quantity;
  if (!Number.isSafeInteger(totalMinorUnits) || totalMinorUnits > MAX_TOTAL_MINOR_UNITS) {
    throw new InvalidRequestError('invalid_quantity', 'The requested quantity is outside the supported range.');
  }

  return { quantity, totalMinorUnits };
}

function proxyPayPalResponse(
  response: PayPalResponse,
  request: Request,
  env: Env,
): Response {
  if (response.status === 204) {
    return new Response(null, {
      headers: getCorsHeaders(asPayPalEnv(env), request),
      status: 204,
    });
  }

  return json(response.data ?? {}, response.status, request, env);
}

function handlePayPalFailure(
  error: unknown,
  operation: string,
  request: Request,
  env: Env,
): Response {
  if (error instanceof InvalidRequestError) {
    return json({ error: error.code, message: error.message }, 400, request, env);
  }

  if (error instanceof PayPalConfigurationError) {
    return json({
      error: 'paypal_not_configured',
      message: 'PayPal is not configured on this Worker.',
    }, 503, request, env);
  }

  if (error instanceof PayPalUnavailableError) {
    console.error(`[paypal] ${operation} unavailable`, {
      upstreamStatus: error.upstreamStatus,
    });
    return json({
      error: 'paypal_unavailable',
      message: 'PayPal is temporarily unavailable.',
    }, 502, request, env);
  }

  console.error(`[paypal] ${operation} failed`, {
    message: error instanceof Error ? error.message : 'Unknown error',
  });
  return json({ error: 'internal_error' }, 500, request, env);
}

async function handlePayPalConfig(request: Request, env: Env): Promise<Response> {
  try {
    const settings = getPayPalSettings(env);
    const cacheKey = [
      settings.clientId,
      settings.currency,
      settings.environment,
      settings.productId,
      settings.productName,
      settings.productAmountMinor,
    ].join('|');

    if (paypalConfigCache?.key === cacheKey && paypalConfigCache.expiresAt > Date.now()) {
      return json(paypalConfigCache.body, 200, request, env, {
        'Cache-Control': 'public, max-age=60, stale-while-revalidate=300',
      });
    }

    const body = {
      card_fields: true,
      currency: settings.currency,
      environment: settings.environment,
      product: {
        id: settings.productId,
        name: settings.productName,
        unit_amount: formatMoney(settings.productAmountMinor, settings.fractionDigits),
      },
      public_client_id: settings.clientId,
    };
    paypalConfigCache = {
      body,
      expiresAt: Date.now() + PAYPAL_CONFIG_TTL_MS,
      key: cacheKey,
    };

    return json(body, 200, request, env, {
      'Cache-Control': 'public, max-age=60, stale-while-revalidate=300',
    });
  } catch (error) {
    return handlePayPalFailure(error, 'config', request, env);
  }
}

async function handlePayPalClientToken(request: Request, env: Env): Promise<Response> {
  try {
    const settings = getPayPalSettings(env);
    if (
      clientTokenCache
      && clientTokenCache.clientId === settings.clientId
      && clientTokenCache.expiresAt > Date.now() + 30_000
    ) {
      return json({
        client_token: clientTokenCache.token,
        ...(typeof clientTokenCache.expiresIn === 'number'
          ? { expires_in: clientTokenCache.expiresIn }
          : {}),
      }, 200, request, env);
    }

    const response = await paypalRequest(settings, '/v1/identity/generate-token', {
      headers: {
        'Accept-Language': 'en_US',
        'Content-Type': 'application/json',
      },
      method: 'POST',
    });

    if (response.status < 200 || response.status >= 300) {
      return proxyPayPalResponse(response, request, env);
    }

    if (!isRecord(response.data) || typeof response.data.client_token !== 'string') {
      return json({ error: 'invalid_paypal_client_token_response' }, 502, request, env);
    }

    const expiresIn = typeof response.data.expires_in === 'number' && Number.isFinite(response.data.expires_in)
      ? response.data.expires_in
      : 3600;
    clientTokenCache = {
      clientId: settings.clientId,
      expiresAt: Date.now() + Math.max(30, expiresIn - 60) * 1000,
      expiresIn,
      token: response.data.client_token,
    };

    return json({
      client_token: response.data.client_token,
      expires_in: expiresIn,
    }, 200, request, env);
  } catch (error) {
    return handlePayPalFailure(error, 'client-token', request, env);
  }
}

async function handleCreatePayPalOrder(request: Request, env: Env): Promise<Response> {
  try {
    const settings = getPayPalSettings(env);
    const bodyResult = await readJsonObject(request);
    if (!bodyResult.ok) {
      return json({ error: bodyResult.code, message: bodyResult.message }, 400, request, env);
    }

    const { quantity, totalMinorUnits } = getOrderLine(settings, bodyResult.body);
    const requestId = getRequestId(request);
    const totalValue = formatMoney(totalMinorUnits, settings.fractionDigits);
    const unitValue = formatMoney(settings.productAmountMinor, settings.fractionDigits);
    const response = await paypalRequest(settings, '/v2/checkout/orders', {
      body: JSON.stringify({
        application_context: {
          shipping_preference: 'NO_SHIPPING',
          user_action: 'PAY_NOW',
        },
        intent: 'CAPTURE',
        purchase_units: [{
          amount: {
            breakdown: {
              item_total: {
                currency_code: settings.currency,
                value: totalValue,
              },
            },
            currency_code: settings.currency,
            value: totalValue,
          },
          custom_id: settings.productId,
          description: settings.productName,
          items: [{
            category: 'DIGITAL_GOODS',
            name: settings.productName,
            quantity: String(quantity),
            unit_amount: {
              currency_code: settings.currency,
              value: unitValue,
            },
          }],
          reference_id: settings.productId,
        }],
      }),
      headers: {
        'Content-Type': 'application/json',
        'PayPal-Request-Id': requestId,
      },
      method: 'POST',
    });

    return proxyPayPalResponse(response, request, env);
  } catch (error) {
    return handlePayPalFailure(error, 'create-order', request, env);
  }
}

async function handleCapturePayPalOrder(
  request: Request,
  env: Env,
  orderId: string,
): Promise<Response> {
  try {
    const settings = getPayPalSettings(env);
    const requestId = getRequestId(request);
    const response = await paypalRequest(settings, `/v2/checkout/orders/${orderId}/capture`, {
      headers: {
        'Content-Type': 'application/json',
        'PayPal-Request-Id': requestId,
      },
      method: 'POST',
    });

    return proxyPayPalResponse(response, request, env);
  } catch (error) {
    return handlePayPalFailure(error, 'capture-order', request, env);
  }
}

function isValidPayPalOrderId(orderId: string): boolean {
  return /^[A-Za-z0-9_-]{1,64}$/.test(orderId);
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const paypalEnv = asPayPalEnv(env);
    const url = new URL(request.url);

    if (
      url.pathname === '/health'
      || url.pathname === '/v1'
      || url.pathname.startsWith('/v1/paypal/')
    ) {
      ctx.waitUntil(warmPayPal(env));
    }

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: getCorsHeaders(paypalEnv, request),
        status: 204,
      });
    }

    if (request.method === 'GET' && url.pathname === '/health') {
      try {
        const row = await env.DB.prepare('SELECT 1 AS ok').first<HealthRow>();
        return json({
          database: row?.ok === 1 ? 'connected' : 'unknown',
          service: 'comesade-api',
          status: 'ok',
          timestamp: new Date().toISOString(),
        }, 200, request, env);
      } catch {
        return json({
          database: 'unavailable',
          service: 'comesade-api',
          status: 'error',
        }, 503, request, env);
      }
    }

    if (request.method === 'GET' && url.pathname === '/v1') {
      let paypalStatus: 'configured' | 'not_configured' = 'not_configured';
      try {
        getPayPalSettings(env);
        paypalStatus = 'configured';
      } catch {
        // The base status endpoint must remain available while PayPal is being configured.
      }

      return json({
        auth: 'ready',
        billing: {
          activate: '/v1/billing/paypal/activate',
          status: '/v1/billing/status',
          webhook: '/v1/billing/paypal/webhook',
        },
        notes: 'local_only',
        paypal: paypalStatus,
        ready: true,
        service: 'comesade-api',
        speech: {
          consume: '/v1/speech/consume',
          quota: '/v1/speech/quota',
          transcribe: '/v1/speech/transcribe',
          models: '/v1/speech/models',
          model: '@cf/openai/whisper-large-v3-turbo',
          tokens: '1 word = 1 token; STT is cloud Whisper large-v3-turbo, one short clip per request',
        },
        messages: {
          consume: '/v1/messages/consume',
          quota: '/v1/messages/quota',
          limits: {
            starter: 1000,
            pro: 30000,
            advanced: 100000,
          },
          unit: 'messages_sent_per_week',
        },
        status: 'ok',
        timestamp: new Date().toISOString(),
        version: 'v1',
        better_auth: '/api/auth/*',
        workspaces: 'local_only',
      }, 200, request, env);
    }

    if (request.method === 'GET' && url.pathname === '/v1/paypal/config') {
      return handlePayPalConfig(request, env);
    }

    if (request.method === 'GET' && url.pathname === '/v1/paypal/client-token') {
      return handlePayPalClientToken(request, env);
    }

    if (request.method === 'POST' && url.pathname === '/v1/paypal/orders') {
      return handleCreatePayPalOrder(request, env);
    }

    const captureMatch = url.pathname.match(/^\/v1\/paypal\/orders\/([^/]+)\/capture$/);
    if (request.method === 'POST' && captureMatch) {
      const orderId = captureMatch[1];
      if (!isValidPayPalOrderId(orderId)) {
        return json({
          error: 'invalid_order_id',
          message: 'The PayPal order ID is invalid.',
        }, 400, request, env);
      }
      return handleCapturePayPalOrder(request, env, orderId);
    }

    try {
      const betterAuthResponse = await handleBetterAuthRoutes(
        request,
        env,
        getCorsHeaders(paypalEnv, request),
      );
      if (betterAuthResponse) return betterAuthResponse;

      const authResponse = await handleAuthRoutes(request, env, json);
      if (authResponse) return authResponse;

      const billingResponse = await handleBillingRoutes(request, env, json);
      if (billingResponse) return billingResponse;

      const speechResponse = await handleSpeechRoutes(request, env, json);
      if (speechResponse) return speechResponse;

      const messageResponse = await handleMessageRoutes(request, env, json);
      if (messageResponse) return messageResponse;
    } catch (error) {
      console.error('[api] request failed', {
        message: error instanceof Error ? error.message : 'Unknown error',
        method: request.method,
        pathname: url.pathname,
      });
      return json({
        error: 'service_unavailable',
        message: 'El servicio de cuentas no está disponible temporalmente.',
      }, 503, request, env);
    }

    return json({ error: 'Not found' }, 404, request, env);
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(warmPayPal(env));
  },
};
