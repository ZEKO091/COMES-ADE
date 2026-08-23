const API_BASE_URL = 'https://comesade-api.kingfrianfrian16.workers.dev';

export type BetterAuthSignInResult = {
  email: string;
  token: string;
};

function readEmail(data: unknown, fallback: string): string {
  if (!data || typeof data !== 'object') return fallback;
  const record = data as Record<string, unknown>;
  if (typeof record.email === 'string' && record.email.includes('@')) return record.email;
  const user = record.user;
  if (user && typeof user === 'object') {
    const email = (user as { email?: unknown }).email;
    if (typeof email === 'string' && email.includes('@')) return email;
  }
  return fallback;
}

export async function signInWithBetterAuth(email: string, password: string): Promise<BetterAuthSignInResult | null> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetch(`${API_BASE_URL}/api/auth/sign-in/email`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      credentials: 'omit',
      body: JSON.stringify({ email, password }),
      signal: controller.signal,
    });
    const data: unknown = await response.json().catch(() => null);
    if (!response.ok) return null;
    const token = response.headers.get('set-auth-token')?.trim()
      || (data && typeof data === 'object' && typeof (data as { token?: unknown }).token === 'string'
        ? (data as { token: string }).token.trim()
        : '');
    if (!token) return null;
    return { email: readEmail(data, email), token };
  } catch {
    return null;
  } finally {
    window.clearTimeout(timeout);
  }
}

export async function signOutBetterAuth(token: string): Promise<void> {
  try {
    await fetch(`${API_BASE_URL}/api/auth/sign-out`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
      },
      credentials: 'omit',
    });
  } catch {
    // Ignore network errors on sign-out.
  }
}
