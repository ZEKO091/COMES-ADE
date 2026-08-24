type JsonFn = (data: unknown, status: number, request: Request, env: Env) => Response;

type UserRow = {
  id: string;
  name: string;
  email: string;
  password_hash: string;
};

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
// Keep signup within the Worker CPU budget. Existing hashes remain compatible
// because verification reads the iteration count stored in each hash.
const PBKDF2_ITERATIONS = 100_000;
const encoder = new TextEncoder();

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

function parseEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const email = normalizeEmail(value);
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  return email;
}

function bytesToHex(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return [...view].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

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

function hexToBytes(value: string): Uint8Array | null {
  if (!/^[a-f0-9]+$/i.test(value) || value.length % 2 !== 0) return null;
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function secretCandidates(value: string): Uint8Array[] {
  const candidates: Uint8Array[] = [];
  const hex = hexToBytes(value);
  if (hex?.byteLength) candidates.push(hex);
  try {
    const bytes = base64ToBytes(value);
    if (bytes.byteLength) candidates.push(bytes);
  } catch {
    // Not valid base64.
  }
  return candidates;
}

async function verifyPbkdf2(password: string, iterations: number, saltRaw: string, hashRaw: string): Promise<boolean> {
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > 2_000_000) return false;
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  for (const salt of secretCandidates(saltRaw)) {
    for (const expected of secretCandidates(hashRaw)) {
      const bits = await crypto.subtle.deriveBits(
        { name: 'PBKDF2', hash: 'SHA-256', iterations, salt },
        key,
        expected.byteLength * 8,
      );
      if (timingSafeEqualBytes(new Uint8Array(bits), expected)) return true;
    }
  }
  return false;
}

function timingSafeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) {
    mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return mismatch === 0;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return bytesToHex(digest);
}

async function pbkdf2Hash(password: string, salt: Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', iterations: PBKDF2_ITERATIONS, salt },
    key,
    256,
  );
  return new Uint8Array(bits);
}

async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const derived = await pbkdf2Hash(password, salt);
  return `pbkdf2$sha256$${PBKDF2_ITERATIONS}$${bytesToBase64(salt)}$${bytesToBase64(derived)}`;
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
  try {
    const value = stored.trim();
    const parts = value.split('$');
    const filled = parts.filter((part) => part.length > 0);

    if (filled.length === 5 && /^\d+$/.test(filled[2] ?? '')) {
      if (await verifyPbkdf2(password, Number(filled[2]), filled[3] ?? '', filled[4] ?? '')) return true;
    }
    if (filled.length === 4 && /^\d+$/.test(filled[1] ?? '')) {
      if (await verifyPbkdf2(password, Number(filled[1]), filled[2] ?? '', filled[3] ?? '')) return true;
    }
    if (/^[a-f0-9]{64}$/i.test(value)) {
      return timingSafeEqual((await sha256Hex(password)).toLowerCase(), value.toLowerCase());
    }
    return false;
  } catch {
    return false;
  }
}

function timingSafeEqualBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let mismatch = 0;
  for (let index = 0; index < left.byteLength; index += 1) {
    mismatch |= left[index] ^ right[index];
  }
  return mismatch === 0;
}

async function ensureAuthSchema(db: D1Database): Promise<void> {
  await db.batch([
    db.prepare(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY NOT NULL,
        name TEXT NOT NULL,
        email TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `),
    db.prepare(`
      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY NOT NULL,
        user_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        last_used_at TEXT NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `),
  ]);
}

function bearerToken(request: Request): string | null {
  const header = request.headers.get('Authorization') ?? '';
  const match = header.match(/^Bearer\s+(\S+)/i);
  return match?.[1] ?? null;
}

function userPayload(user: UserRow) {
  return { id: user.id, email: user.email, name: user.name };
}

async function createSession(db: D1Database, user: UserRow) {
  const tokenBytes = crypto.getRandomValues(new Uint8Array(32));
  const accessToken = bytesToHex(tokenBytes);
  const tokenHash = await sha256Hex(accessToken);
  const now = new Date();
  const expires = new Date(now.getTime() + SESSION_TTL_MS);
  await db.prepare(`
    INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_used_at)
    VALUES (?1, ?2, ?3, ?4, ?5)
  `).bind(tokenHash, user.id, now.toISOString(), expires.toISOString(), now.toISOString()).run();
  return {
    access_token: accessToken,
    token_type: 'Bearer',
    expires_at: expires.toISOString(),
    user: userPayload(user),
  };
}

async function userFromRequest(db: D1Database, request: Request): Promise<UserRow | null> {
  const token = bearerToken(request);
  if (!token) return null;
  const tokenHash = await sha256Hex(token);
  const now = new Date().toISOString();
  const row = await db.prepare(`
    SELECT u.id, u.name, u.email, u.password_hash, s.expires_at
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ?1
    LIMIT 1
  `).bind(tokenHash).first<UserRow & { expires_at: string }>();
  if (!row) return null;
  if (row.expires_at <= now) {
    await db.prepare('DELETE FROM sessions WHERE token_hash = ?1').bind(tokenHash).run();
    return null;
  }
  await db.prepare('UPDATE sessions SET last_used_at = ?2 WHERE token_hash = ?1').bind(tokenHash, now).run();
  return { id: row.id, name: row.name, email: row.email, password_hash: row.password_hash };
}

async function userFromBetterAuth(db: D1Database, request: Request): Promise<UserRow | null> {
  const token = bearerToken(request);
  if (!token) return null;
  try {
    const row = await db.prepare(`
      SELECT u.id, u.name, u.email, s.expires_at
      FROM session s
      JOIN user u ON u.id = s.user_id
      WHERE s.token = ?1
      LIMIT 1
    `).bind(token).first<{ id: string; name: string; email: string; expires_at: number }>();
    if (!row) return null;
    if (Number(row.expires_at) <= Date.now()) return null;
    return { id: row.id, name: row.name, email: row.email, password_hash: '' };
  } catch {
    return null;
  }
}

export async function getRequestUser(db: D1Database, request: Request): Promise<UserRow | null> {
  await ensureAuthSchema(db);
  return (await userFromBetterAuth(db, request)) ?? userFromRequest(db, request);
}

export async function handleAuthRoutes(
  request: Request,
  env: Env,
  json: JsonFn,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/v1/auth/')) return null;

  await ensureAuthSchema(env.DB);

  if (request.method === 'POST' && url.pathname === '/v1/auth/signup') {
    let body: Record<string, unknown>;
    try {
      body = await request.json() as Record<string, unknown>;
    } catch {
      return json({ error: 'invalid_json_body', message: 'The request body is not valid JSON.' }, 400, request, env);
    }
    const email = parseEmail(body.email);
    const password = typeof body.password === 'string' ? body.password : '';
    const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : (email?.split('@')[0] ?? 'ComesADE');
    if (!email || password.length < 8 || password.length > 128) {
      return json({ error: 'invalid_credentials', message: 'Email válido y contraseña de 8 a 128 caracteres.' }, 400, request, env);
    }
    const safeName = name.slice(0, 80);
    const existing = await env.DB.prepare('SELECT id FROM users WHERE lower(email) = ?1').bind(email).first();
    if (existing) {
      return json({ error: 'email_taken', message: 'Ese correo ya tiene una cuenta.' }, 409, request, env);
    }
    const now = new Date().toISOString();
    const user: UserRow = {
      id: crypto.randomUUID(),
      name: safeName,
      email,
      password_hash: await hashPassword(password),
    };
    await env.DB.prepare(`
      INSERT INTO users (id, name, email, password_hash, created_at, updated_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6)
    `).bind(user.id, user.name, user.email, user.password_hash, now, now).run();
    return json(await createSession(env.DB, user), 201, request, env);
  }

  if (request.method === 'POST' && url.pathname === '/v1/auth/signin') {
    let body: Record<string, unknown>;
    try {
      body = await request.json() as Record<string, unknown>;
    } catch {
      return json({ error: 'invalid_json_body', message: 'The request body is not valid JSON.' }, 400, request, env);
    }
    const email = parseEmail(body.email);
    const password = typeof body.password === 'string' ? body.password : '';
    if (!email || !password || password.length > 128) {
      return json({ error: 'account_not_found', message: 'Cuenta no encontrada o credenciales incorrectas.' }, 401, request, env);
    }
    const user = await env.DB.prepare(
      'SELECT id, name, email, password_hash FROM users WHERE lower(email) = ?1',
    ).bind(email).first<UserRow>();
    const passwordOk = user
      ? (await verifyPassword(password, user.password_hash))
        || (password.trim() !== password && await verifyPassword(password.trim(), user.password_hash))
      : false;
    if (!user || !passwordOk) {
      return json({ error: 'account_not_found', message: 'Cuenta no encontrada o credenciales incorrectas.' }, 401, request, env);
    }
    try {
      const nextHash = await hashPassword(password.trim() || password);
      if (nextHash !== user.password_hash) {
        await env.DB.prepare(
          'UPDATE users SET password_hash = ?2, updated_at = ?3 WHERE id = ?1',
        ).bind(user.id, nextHash, new Date().toISOString()).run();
      }
    } catch (error) {
      console.error('Could not upgrade password hash after sign-in', error);
    }
    return json(await createSession(env.DB, user), 200, request, env);
  }

  if (request.method === 'GET' && url.pathname === '/v1/auth/me') {
    const user = await getRequestUser(env.DB, request);
    if (!user) return json({ error: 'Unauthorized' }, 401, request, env);
    return json({ user: userPayload(user) }, 200, request, env);
  }

  if (request.method === 'POST' && url.pathname === '/v1/auth/signout') {
    const token = bearerToken(request);
    if (token) {
      await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?1').bind(await sha256Hex(token)).run();
    }
    return json({ ok: true }, 200, request, env);
  }

  return json({ error: 'method_not_allowed', message: 'Method not allowed.' }, 405, request, env);
}
