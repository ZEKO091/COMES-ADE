type HealthRow = {
  ok: number;
};

const corsHeaders = {
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Origin': '*',
};

function json(data: unknown, status = 200): Response {
  return Response.json(data, {
    status,
    headers: corsHeaders,
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/health') {
      try {
        const row = await env.DB.prepare('SELECT 1 AS ok').first<HealthRow>();
        return json({
          database: row?.ok === 1 ? 'connected' : 'unknown',
          service: 'comesade-api',
          status: 'ok',
          timestamp: new Date().toISOString(),
        });
      } catch {
        return json({
          database: 'unavailable',
          service: 'comesade-api',
          status: 'error',
        }, 503);
      }
    }

    if (request.method === 'GET' && url.pathname === '/v1') {
      return json({
        auth: 'not_configured',
        notes: 'local_only',
        ready: true,
        service: 'comesade-api',
        status: 'ok',
        timestamp: new Date().toISOString(),
        version: 'v1',
        workspaces: 'local_only',
      });
    }

    return json({ error: 'Not found' }, 404);
  },
};
