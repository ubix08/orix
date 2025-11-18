import { AutonomousAgent } from './durable-agent';
import type { Env } from './types';
import { D1Manager } from './storage/d1-manager';

export { AutonomousAgent };

function getSessionId(request: Request): string | null {
  const url = new URL(request.url);
  const fromQuery = url.searchParams.get('session_id');
  const fromHeader = request.headers.get('X-Session-ID');
  return fromQuery || fromHeader || null;
}

// Safe base64 helpers for Workers
function decodeBase64(str: string) {
  return JSON.parse(
    new TextDecoder().decode(Uint8Array.from(atob(str), c => c.charCodeAt(0)))
  );
}

async function verifyAuth(request: Request, env: Env): Promise<boolean> {
  if (!env.JWT_SECRET) return true;

  const authHeader = request.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) return false;

  const token = authHeader.substring(7);

  try {
    const parts = token.split('.');
    if (parts.length !== 3) return false;

    const payload = decodeBase64(parts[1]);
    return payload.exp > Date.now() / 1000;
  } catch {
    return false;
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);
    const path = url.pathname;

    // Authentication gate (skip certain paths)
    if (
      env.JWT_SECRET &&
      !path.startsWith('/auth/') &&
      !path.startsWith('/health') &&
      path !== '/'
    ) {
      const authed = await verifyAuth(request, env);
      if (!authed) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }

    // -------- AUTH ROUTES --------
    if (path === '/auth/login' && request.method === 'POST') {
      return handleLogin(request, env);
    }

    // -------- D1 ROUTES --------
    if (path === '/api/d1/init' && request.method === 'POST') {
      return initializeD1(env);
    }

    if (path === '/api/d1/status' && request.method === 'GET') {
      return getD1Status(env);
    }

    // -------- SESSION ROUTES --------
    if (path === '/api/sessions' && request.method === 'GET') {
      return listSessions(env);
    }

    if (path === '/api/sessions' && request.method === 'POST') {
      return createSession(request, env);
    }

    if (path.startsWith('/api/sessions/') && request.method === 'GET') {
      const sessionId = path.split('/').pop()!;
      return getSession(sessionId, env);
    }

    if (path.startsWith('/api/sessions/') && request.method === 'PATCH') {
      const sessionId = path.split('/').pop()!;
      return updateSession(sessionId, request, env);
    }

    if (path.startsWith('/api/sessions/') && request.method === 'DELETE') {
      const sessionId = path.split('/').pop()!;
      return deleteSession(sessionId, env);
    }

    // -------- DURABLE OBJECT (AGENT) ROUTES --------
    if (path.startsWith('/api/')) {
      // Require session ID for agent interactions
      const sessionId = getSessionId(request);
      
      if (!sessionId) {
        return new Response(
          JSON.stringify({ 
            error: 'Session ID required. Use X-Session-ID header or session_id query param' 
          }),
          {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
          }
        );
      }

      try {
        // Create Durable Object ID from session ID
        const id = env.AGENT.idFromName(`session:${sessionId}`);
        const stub = env.AGENT.get(id);

        // Ensure session exists in D1
        if (env.DB) {
          const d1 = new D1Manager(env.DB);
          ctx.waitUntil(
            d1.getSession(sessionId).then(session => {
              if (!session) {
                return d1.createSession(sessionId, 'New Session');
              }
            })
          );
        }

        // Handle WebSocket via fetch (as WebSockets can't be passed over RPC)
        if (path === '/api/ws' && request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
          // Add session ID to request headers if needed, but since ID is in name, optional
          const modifiedRequest = new Request(request);
          modifiedRequest.headers.set('X-Session-ID', sessionId);
          return await stub.fetch(modifiedRequest);
        }

        // Handle RPC for other paths
        if (path === '/api/chat' && request.method === 'POST') {
          const body = await request.json() as { message: string };
          const message = body.message?.trim();
          if (!message) throw new Error('Missing message');
          const res = await stub.handleChat(message);
          return new Response(JSON.stringify(res), { headers: { 'Content-Type': 'application/json' } });
        }

        if (path === '/api/history' && request.method === 'GET') {
          const res = await stub.getHistory();
          return new Response(JSON.stringify(res), { headers: { 'Content-Type': 'application/json' } });
        }

        if (path === '/api/clear' && request.method === 'POST') {
          const res = await stub.clearHistory();
          return new Response(JSON.stringify(res), { headers: { 'Content-Type': 'application/json' } });
        }

        if (path === '/api/status' && request.method === 'GET') {
          const res = await stub.getStatus();
          return new Response(JSON.stringify(res), { headers: { 'Content-Type': 'application/json' } });
        }

        if (path === '/api/sync' && request.method === 'POST') {
          const res = await stub.syncToD1();
          return new Response(JSON.stringify(res), { headers: { 'Content-Type': 'application/json' } });
        }

        if (path === '/api/memory/search' && request.method === 'POST') {
          const body = await request.json() as { query: string; topK?: number };
          const res = await stub.searchMemory(body);
          return new Response(JSON.stringify(res), { headers: { 'Content-Type': 'application/json' } });
        }

        if (path === '/api/memory/stats' && request.method === 'GET') {
          const res = await stub.getMemoryStats();
          return new Response(JSON.stringify(res), { headers: { 'Content-Type': 'application/json' } });
        }

        if (path === '/api/memory/summarize' && request.method === 'POST') {
          const res = await stub.summarizeSession();
          return new Response(JSON.stringify(res), { headers: { 'Content-Type': 'application/json' } });
        }

        return new Response('Not Found', { status: 404 });
      } catch (err: any) {
        console.error('[Worker] DO error:', err);
        return new Response(
          JSON.stringify({
            error: err.message || 'Durable Object Error',
          }),
          {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
          }
        );
      }
    }

    // -------- ROOT / HEALTH --------
    if (path === '/' || path === '/health') {
      let d1Status = { enabled: false, healthy: false, initialized: false };

      if (env.DB) {
        const d1 = new D1Manager(env.DB);
        d1Status = {
          enabled: true,
          healthy: await d1.healthCheck(),
          initialized: d1.isInitialized(),
        };
      }

      return new Response(
        JSON.stringify({
          status: 'ok',
          message: 'Orion Personal Assistant running',
          version: '3.0.0-session-management',
          d1: d1Status,
          authEnabled: !!env.JWT_SECRET,
        }),
        { headers: { 'Content-Type': 'application/json' } }
      );
    }

    return new Response('Not found', { status: 404 });
  },
};

// -----------------------------------------------------------------------------
// D1 ADMIN FUNCTIONS
// -----------------------------------------------------------------------------

async function initializeD1(env: Env): Promise<Response> {
  if (!env.DB) {
    return new Response(
      JSON.stringify({ error: 'D1 not configured in wrangler.toml' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }

  try {
    const d1 = new D1Manager(env.DB);
    await d1.reinitialize();
    const stats = await d1.getStats();

    return new Response(
      JSON.stringify({
        ok: true,
        message: 'D1 schema initialized successfully',
        stats,
      }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    return new Response(
      JSON.stringify({
        error: 'Initialization failed',
        details: String(error),
      }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
}

async function getD1Status(env: Env): Promise<Response> {
  if (!env.DB) {
    return new Response(
      JSON.stringify({ enabled: false, message: 'D1 not configured' }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  }

  try {
    const d1 = new D1Manager(env.DB);
    const [healthy, stats] = await Promise.all([
      d1.healthCheck(),
      d1.getStats(),
    ]);

    return new Response(
      JSON.stringify({
        enabled: true,
        healthy,
        initialized: d1.isInitialized(),
        stats,
        freeTierLimits: {
          storage: '5 GB',
          readsPerDay: '5 million',
          writesPerDay: '100,000',
        },
      }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    return new Response(
      JSON.stringify({
        error: 'Status check failed',
        details: String(error),
      }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
}

// -----------------------------------------------------------------------------
// AUTH
// -----------------------------------------------------------------------------

async function handleLogin(request: Request, env: Env): Promise<Response> {
  try {
    const body = (await request.json()) as {
      email: string;
      password: string;
    };

    const { email, password } = body;

    if (!email || !password) {
      return new Response(JSON.stringify({ error: 'Email & password required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (email !== env.ADMIN_GMAIL) {
      return new Response(JSON.stringify({ error: 'Invalid credentials' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Hash the password
    const encoder = new TextEncoder();
    const data = encoder.encode(password);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');

    if (env.ADMIN_PASSWORD_HASH && hashHex !== env.ADMIN_PASSWORD_HASH) {
      return new Response(JSON.stringify({ error: 'Invalid credentials' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // NOT a proper JWT, but preserved for compatibility
    const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
    const payload = btoa(
      JSON.stringify({
        email,
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 7 * 24 * 3600,
      })
    );

    const secret = env.JWT_SECRET || 'default-secret';
    const signatureData = encoder.encode(`${header}.${payload}.${secret}`);
    const signatureBuffer = await crypto.subtle.digest('SHA-256', signatureData);
    const signatureArray = Array.from(new Uint8Array(signatureBuffer));
    const signature = btoa(String.fromCharCode(...signatureArray));

    const token = `${header}.${payload}.${signature}`;

    return new Response(JSON.stringify({ token, email }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    return new Response(
      JSON.stringify({
        error: 'Invalid request',
        details: String(error),
      }),
      {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }
}

// -----------------------------------------------------------------------------
// SESSION MANAGEMENT
// -----------------------------------------------------------------------------

async function listSessions(env: Env): Promise<Response> {
  if (!env.DB) {
    return new Response(JSON.stringify({ error: 'D1 not configured' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const d1 = new D1Manager(env.DB);
    const sessions = await d1.listSessions(50);

    return new Response(JSON.stringify({ sessions }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

async function createSession(request: Request, env: Env): Promise<Response> {
  if (!env.DB) {
    return new Response(JSON.stringify({ error: 'D1 not configured' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const body = (await request.json()) as { title?: string };
    const title = body.title || 'New Session';
    const sessionId = crypto.randomUUID();

    const d1 = new D1Manager(env.DB);
    const session = await d1.createSession(sessionId, title);

    return new Response(JSON.stringify(session), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

async function getSession(sessionId: string, env: Env): Promise<Response> {
  if (!env.DB) {
    return new Response(JSON.stringify({ error: 'D1 not configured' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const d1 = new D1Manager(env.DB);
    const session = await d1.getSession(sessionId);

    if (!session) {
      return new Response(JSON.stringify({ error: 'Session not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify(session), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

async function updateSession(
  sessionId: string,
  request: Request,
  env: Env
): Promise<Response> {
  if (!env.DB) {
    return new Response(JSON.stringify({ error: 'D1 not configured' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const body = (await request.json()) as { title?: string };
    
    if (!body.title) {
      return new Response(JSON.stringify({ error: 'Title required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const d1 = new D1Manager(env.DB);
    await d1.updateSessionTitle(sessionId, body.title);

    const session = await d1.getSession(sessionId);
    return new Response(JSON.stringify(session), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

async function deleteSession(
  sessionId: string,
  env: Env
): Promise<Response> {
  if (!env.DB) {
    return new Response(JSON.stringify({ error: 'D1 not configured' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const d1 = new D1Manager(env.DB);
    await d1.deleteSession(sessionId);

    return new Response(JSON.stringify({ ok: true }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
