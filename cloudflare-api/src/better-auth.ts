import { betterAuth } from 'better-auth/minimal';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { bearer } from 'better-auth/plugins/bearer';
import { drizzle } from 'drizzle-orm/d1';
import { handleAuthRoutes } from './auth';
import { betterAuthSchema } from './better-auth-schema';

// Keep signup within the Worker CPU budget. Existing hashes remain compatible
// because verification reads the iteration count stored in each hash.
const PBKDF2_ITERATIONS = 100_000;
const encoder = new TextEncoder();

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function padBase64(value: string): string {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  return normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(padBase64(value));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function timingSafeEqualBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let mismatch = 0;
  for (let index = 0; index < left.byteLength; index += 1) {
    mismatch |= left[index] ^ right[index];
  }
  return mismatch === 0;
}

async function hashPasswordNative(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', iterations: PBKDF2_ITERATIONS, salt },
    key,
    256,
  );
  return `pbkdf2$sha256$${PBKDF2_ITERATIONS}$${bytesToBase64(salt)}$${bytesToBase64(new Uint8Array(bits))}`;
}

async function verifyPasswordNative(data: { password: string; hash: string }): Promise<boolean> {
  const parts = data.hash.trim().split('$');
  if (parts.length !== 5 || parts[0] !== 'pbkdf2' || parts[1] !== 'sha256') return false;
  const iterations = Number(parts[2]);
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > 2_000_000) return false;
  let salt: Uint8Array;
  let expected: Uint8Array;
  try {
    salt = base64ToBytes(parts[3]);
    expected = base64ToBytes(parts[4]);
  } catch {
    return false;
  }
  const key = await crypto.subtle.importKey('raw', encoder.encode(data.password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', iterations, salt },
    key,
    expected.byteLength * 8,
  );
  return timingSafeEqualBytes(new Uint8Array(bits), expected);
}

export type BetterAuthEnv = Env & {
  BETTER_AUTH_SECRET?: string;
  BETTER_AUTH_URL?: string;
  BETTER_AUTH_API_KEY?: string;
  PAYPAL_ALLOWED_ORIGINS?: string;
};

const DEFAULT_TRUSTED_ORIGINS = [
  'http://localhost:1420',
  'http://127.0.0.1:1420',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:8787',
  'http://127.0.0.1:8787',
  'https://tauri.localhost',
  'http://tauri.localhost',
  'https://asset.localhost',
  'http://asset.localhost',
  'https://usecomesade.pages.dev',
  'https://*.usecomesade.pages.dev',
  'https://usecomes.com',
  'https://www.usecomes.com',
  'https://*.usecomes.com',
];

export async function ensureBetterAuthSchema(db: D1Database): Promise<void> {
  await db.batch([
    db.prepare(`
      CREATE TABLE IF NOT EXISTS "user" (
        "id" text PRIMARY KEY NOT NULL,
        "name" text NOT NULL,
        "email" text NOT NULL UNIQUE,
        "email_verified" integer NOT NULL,
        "image" text,
        "created_at" integer NOT NULL,
        "updated_at" integer NOT NULL
      )
    `),
    db.prepare(`
      CREATE TABLE IF NOT EXISTS "session" (
        "id" text PRIMARY KEY NOT NULL,
        "expires_at" integer NOT NULL,
        "token" text NOT NULL UNIQUE,
        "created_at" integer NOT NULL,
        "updated_at" integer NOT NULL,
        "ip_address" text,
        "user_agent" text,
        "user_id" text NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE
      )
    `),
    db.prepare(`
      CREATE TABLE IF NOT EXISTS "account" (
        "id" text PRIMARY KEY NOT NULL,
        "account_id" text NOT NULL,
        "provider_id" text NOT NULL,
        "user_id" text NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
        "access_token" text,
        "refresh_token" text,
        "id_token" text,
        "access_token_expires_at" integer,
        "refresh_token_expires_at" integer,
        "scope" text,
        "password" text,
        "created_at" integer NOT NULL,
        "updated_at" integer NOT NULL
      )
    `),
    db.prepare(`
      CREATE TABLE IF NOT EXISTS "verification" (
        "id" text PRIMARY KEY NOT NULL,
        "identifier" text NOT NULL,
        "value" text NOT NULL,
        "expires_at" integer NOT NULL,
        "created_at" integer,
        "updated_at" integer
      )
    `),
    db.prepare('CREATE INDEX IF NOT EXISTS session_userId_idx ON session (user_id)'),
    db.prepare('CREATE INDEX IF NOT EXISTS account_userId_idx ON account (user_id)'),
    db.prepare('CREATE INDEX IF NOT EXISTS verification_identifier_idx ON verification (identifier)'),
  ]);
}

function trustedOrigins(env: BetterAuthEnv): string[] {
  const extra = env.PAYPAL_ALLOWED_ORIGINS
    ?.split(',')
    .map((item) => item.trim())
    .filter(Boolean) ?? [];
  const fromBase = env.BETTER_AUTH_URL ? [env.BETTER_AUTH_URL.replace(/\/$/, '')] : [];
  return [...new Set([...DEFAULT_TRUSTED_ORIGINS, ...extra, ...fromBase])];
}

export function createAuth(env: BetterAuthEnv) {
  const db = drizzle(env.DB, { schema: betterAuthSchema });
  const secret = env.BETTER_AUTH_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error('BETTER_AUTH_SECRET must be set and at least 32 characters.');
  }
  const baseURL = env.BETTER_AUTH_URL?.replace(/\/$/, '') || 'http://127.0.0.1:8787';

  return betterAuth({
    secret,
    baseURL,
    database: drizzleAdapter(db, {
      provider: 'sqlite',
      schema: betterAuthSchema,
      transaction: false,
    }),
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 8,
      maxPasswordLength: 128,
      // Default scrypt is JS and exceeds Cloudflare Workers CPU limits on sign-up.
      password: {
        hash: hashPasswordNative,
        verify: verifyPasswordNative,
      },
    },
    plugins: [bearer()],
    trustedOrigins: trustedOrigins(env),
    advanced: {
      ipAddress: {
        ipAddressHeaders: ['cf-connecting-ip', 'x-forwarded-for'],
      },
    },
  });
}

export async function handleBetterAuthRoutes(
  request: Request,
  env: BetterAuthEnv,
  corsHeaders: Headers,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/api/auth')) return null;

  const emailAuthPath = url.pathname === '/api/auth/sign-in/email' || url.pathname === '/api/auth/sign-up/email';
  if (request.method === 'POST' && emailAuthPath) {
    const legacyPath = url.pathname.includes('sign-up') ? '/v1/auth/signup' : '/v1/auth/signin';
    const forwarded = new Request(new URL(legacyPath, request.url), request);
    const legacyResponse = await handleAuthRoutes(forwarded, env, (data, status) => {
      const headers = new Headers(corsHeaders);
      headers.set('Content-Type', 'application/json; charset=utf-8');
      if (
        data
        && typeof data === 'object'
        && 'access_token' in data
        && typeof (data as { access_token?: unknown }).access_token === 'string'
      ) {
        const token = (data as { access_token: string; user?: unknown }).access_token;
        headers.set('set-auth-token', token);
        return new Response(JSON.stringify({
          token,
          user: (data as { user?: unknown }).user ?? null,
        }), { status, headers });
      }
      return new Response(JSON.stringify(data), { status, headers });
    });
    return legacyResponse ?? new Response(JSON.stringify({
      error: 'auth_unavailable',
      message: 'Account service is unavailable.',
    }), {
      status: 503,
      headers: corsHeaders,
    });
  }

  await ensureBetterAuthSchema(env.DB);

  if (!env.BETTER_AUTH_SECRET || env.BETTER_AUTH_SECRET.length < 32) {
    corsHeaders.set('Content-Type', 'application/json; charset=utf-8');
    return new Response(JSON.stringify({
      error: 'auth_not_configured',
      message: 'BETTER_AUTH_SECRET is not set on this Worker.',
    }), {
      status: 503,
      headers: corsHeaders,
    });
  }

  try {
    const auth = createAuth(env);
    const response = await auth.handler(request);
    const headers = new Headers(response.headers);
    corsHeaders.forEach((value, key) => {
      if (key.toLowerCase() === 'content-type' && headers.has('content-type')) return;
      headers.set(key, value);
    });
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Account service failed.';
    corsHeaders.set('Content-Type', 'application/json; charset=utf-8');
    return new Response(JSON.stringify({
      error: 'auth_handler_failed',
      message,
    }), {
      status: 500,
      headers: corsHeaders,
    });
  }
}
