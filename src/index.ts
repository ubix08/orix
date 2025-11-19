// src/index.ts - Refactored with SessionManager and Clean Routing (updated to forward X-Session-ID)
import { AutonomousAgent } from './durable-agent';
import type { Env } from './types';
import { SessionManager } from './session/session-manager';

export { AutonomousAgent };

// =============================================================
// Helper Functions
// =============================================================

function getSessionId(request: Request): string | null {
  const url = new URL(request.url);
  const fromQuery = url.searchParams.get('session_id');
  const fromHeader = request.headers.get('X-Session-ID');
  return fromQuery || fromHeader || null;
}

function decodeBase64(str: string) {
  return JSON.parse(
    new TextDecoder().decode(Uint8Array.from(atob(str), (c) => c.charCodeAt(0)))
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

function jsonResponse(data: any, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function errorResponse(error: string, status = 500): Response {
  return jsonResponse({ error }, status);
}

// =============================================================
// Route Handlers
// =============================================================

async function handleLogin(request: Request, env: Env): Promise<Response> {
  try {
    const body = (await request.json()) as {
      email: string;
      password: string;
    };

    const { email, password } = body;

    if (!email || !password) {
      return errorResponse('Email & password required', 400);
    }

    if (email !== env.ADMIN_GMAIL) {
      return errorResponse('Invalid credentials', 401);
    }

    // Hash the password
    const encoder = new TextEncoder();
    const data = encoder.encode(password);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hashHex = hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');

    if (env.ADMIN_PASSWORD_HASH && hashHex !== env.ADMIN_PASSWORD_HASH) {
      return errorResponse('Invalid credentials', 401);
    }

    // Create JWT-like token (not cryptographically secure)
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

    return jsonResponse({ token, email });
  } catch (error) {
    return errorResponse('Invalid request', 400);
  }
}

async function handleD1Init(env: Env): Promise<Response> {
  if (!env.DB) {
    return errorResponse('D1 not configured in wrangler.toml', 400);
  }

  try {
    const sessionManager = new SessionManager(env.DB);
    // Force reinitialization
    await (sessionManager as any).d1.reinitialize();
    const stats = await (sessionManager as any).d1.getStats();

    return jsonResponse({
      ok: true,
      message: 'D1 schema initialized successfully',
      stats,
    });
  } catch (error) {
    return errorResponse(`Initialization failed: ${error}`, 500);
  }
}

async function handleD1Status(env: Env): Promise<Response> {
  if (!env.DB) {
    return jsonResponse({ enabled: false, message: 'D1 not configured' });
  }

  try {
    const sessionManager = new SessionManager(env.DB);
    const d1 = (sessionManager as any).d1;

    const [healthy, stats] = await Promise.all([d1.healthCheck(), d1.getStats()]);

    return jsonResponse({
      enabled: true,
      healthy,
      initialized: d1.isInitialized(),
      stats,
      freeTierLimits: {
        storage: '5 GB',
        readsPerDay: '5 million',
        writesPerDay: '100,000',
      },
    });
  } catch (error) {
    return errorResponse(`Status check failed: ${error}`, 500);
  }
}

async function handleSessionList(env: Env): Promise<Response> {
  if (!env.DB) {
    return errorResponse('D1 not configured', 400);
  }

  try {
    const sessionManager = new SessionManager(env.DB);
    const sessions = await sessionManager.listSessions(50);
    return jsonResponse({ sessions });
  } catch (err) {
    return errorResponse(String(err), 500);
  }
}

async function handleSessionCreate(request: Request, env: Env): Promise<Response> {
  if (!env.DB) {
    return errorResponse('D1 not configured', 400);
  }

  try {
    const body = (await request.json()) as { title?: string };
    const title = body.title || 'New Session';
    const sessionId = SessionManager.generateSessionId();

    const sessionManager = new SessionManager(env.DB);
    const session = await sessionManager.getOrCreateSession(sessionId, title);

    return jsonResponse(session);
  } catch (err) {
    return errorResponse(String(err), 500);
  }
}

async function handleSessionGet(sessionId: string, env: Env): Promise<Response> {
  if (!env.DB) {
    return errorResponse('D1 not configured', 400);
  }

  try {
    const sessionManager = new SessionManager(env.DB);
    const session = await sessionManager.getOrCreateSession(sessionId);
    return jsonResponse(session);
  } catch (err) {
    return errorResponse('Session not found', 404);
  }
}

async function handleSessionUpdate(
  sessionId: string,
  request: Request,
  env: Env
): Promise<Response> {
  if (!env.DB) {
    return errorResponse('D1 not configured', 400);
  }

  try {
    const body = (await request.json()) as { title?: string };

    if (!body.title) {
      return errorResponse('Title required', 400);
    }

    const d1 = (new SessionManager(env.DB) as any).d1;
    await d1.updateSessionTitle(sessionId, body.title);

    const session = await d1.getSession(sessionId);
    return jsonResponse(session);
  } catch (err) {
    return errorResponse(String(err), 500);
  }
}

async function handleSessionDelete(sessionId: string, env: Env): Promise<Response> {
  if (!env.DB) {
    return errorResponse('D1 not configured', 400);
  }

  try {
    const sessionManager = new SessionManager(env.DB);
    await sessionManager.deleteSession(sessionId);
    return jsonResponse({ ok: true });
  } catch (err) {
    return errorResponse(String(err), 500);
  }
}

// =============================================================
// Durable Object Routing
// =============================================================

async function handleDurableObjectRequest(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  // Require session ID (query param or header)
  const sessionId = getSessionId(request);
  if (!sessionId) {
    return errorResponse(
      'Session ID required. Use X-Session-ID header or session_id query param',
      400
    );
  }

  // Validate session ID format
  if (!SessionManager.validateSessionId(sessionId)) {
    return errorResponse('Invalid session ID format', 400);
  }

  try {
    // Create Durable Object ID from session ID
    const id = env.AGENT.idFromName(`session:${sessionId}`);
    const stub = env.AGENT.get(id);

    // Ensure session exists in D1 asynchronously
    if (env.DB) {
      const sessionManager = new SessionManager(env.DB);
      ctx.waitUntil(
        sessionManager.getOrCreateSession(sessionId).catch((err) => {
          console.error('[Worker] Failed to ensure session:', err);
        })
      );
    }

    // When forwarding to the DO stub, always create a new Request and inject X-Session-ID
    const makeForwardedRequest = (orig: Request): Request => {
      // Copy the original request into a new Request object; this allows header mutation.
      const forwarded = new Request(orig);
      forwarded.headers.set('X-Session-ID', sessionId);
      return forwarded;
    };

    // Handle WebSocket via fetch (forwarded request will contain X-Session-ID header)
    if (path === '/api/ws' && request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
      const forwarded = makeForwardedRequest(request);
      return await stub.fetch(forwarded);
    }

    // For other RPC routes, forward the request as well (so DO can read session id and headers)
    // We use direct stub RPC for some endpoints below (via stub.handleChat etc.) — keep as-is for RPC.
    // But if you prefer HTTP-only to DO, you can forward fetch like above.

    switch (path) {
      case '/api/chat':
        if (request.method === 'POST') {
          const body = (await request.json()) as { message: string };
          const message = body.message?.trim();
          if (!message) throw new Error('Missing message');
          // Use RPC call (preferred)
          const res = await stub.handleChat(message);
          return jsonResponse(res);
        }
        break;

      case '/api/history':
        if (request.method === 'GET') {
          const res = await stub.getHistory();
          return jsonResponse(res);
        }
        break;

      case '/api/clear':
        if (request.method === 'POST') {
          const res = await stub.clearHistory();
          return jsonResponse(res);
        }
        break;

      case '/api/status':
        if (request.method === 'GET') {
          const res = await stub.getStatus();
          return jsonResponse(res);
        }
        break;

      case '/api/sync':
        if (request.method === 'POST') {
          const res = await stub.syncToD1();
          return jsonResponse(res);
        }
        break;

      case '/api/memory/search':
        if (request.method === 'POST') {
          const body = (await request.json()) as { query: string; topK?: number };
          const res = await stub.searchMemory(body);
          return jsonResponse(res);
        }
        break;

      case '/api/memory/stats':
        if (request.method === 'GET') {
          const res = await stub.getMemoryStats();
          return jsonResponse(res);
        }
        break;

      case '/api/memory/summarize':
        if (request.method === 'POST') {
          const res = await stub.summarizeSession();
          return jsonResponse(res);
        }
        break;
    }

    return new Response('Not Found', { status: 404 });
  } catch (err: any) {
    console.error('[Worker] DO error:', err);
    return errorResponse(err.message || 'Durable Object Error', 500);
  }
}

// =============================================================
// Main Worker
// =============================================================

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // Authentication gate (skip certain paths)
    const publicPaths = ['/auth/', '/health', '/'];
    const isPublic = publicPaths.some((p) => path.startsWith(p));

    if (env.JWT_SECRET && !isPublic) {
      const authed = await verifyAuth(request, env);
      if (!authed) {
        return errorResponse('Unauthorized', 401);
      }
    }

    // -------- ROUTE MATCHING --------

    // Health check
    if (path === '/' || path === '/health') {
      let d1Status = { enabled: false, healthy: false, initialized: false };

      if (env.DB) {
        const sessionManager = new SessionManager(env.DB);
        const d1 = (sessionManager as any).d1;
        d1Status = {
          enabled: true,
          healthy: await d1.healthCheck(),
          initialized: d1.isInitialized(),
        };
      }

      return jsonResponse({
        status: 'ok',
        message: 'Orion Personal Assistant running',
        version: '4.0.0-refactored-architecture',
        d1: d1Status,
        authEnabled: !!env.JWT_SECRET,
      });
    }

    // Auth routes
    if (path === '/auth/login' && request.method === 'POST') {
      return handleLogin(request, env);
    }

    // D1 admin routes
    if (path === '/api/d1/init' && request.method === 'POST') {
      return handleD1Init(env);
    }

    if (path === '/api/d1/status' && request.method === 'GET') {
      return handleD1Status(env);
    }

    // Session management routes
    if (path === '/api/sessions') {
      if (request.method === 'GET') return handleSessionList(env);
      if (request.method === 'POST') return handleSessionCreate(request, env);
    }

    if (path.startsWith('/api/sessions/')) {
      const sessionId = path.split('/').pop()!;

      if (request.method === 'GET') return handleSessionGet(sessionId, env);
      if (request.method === 'PATCH') return handleSessionUpdate(sessionId, request, env);
      if (request.method === 'DELETE') return handleSessionDelete(sessionId, env);
    }

    // Durable Object routes (everything under /api/)
    if (path.startsWith('/api/')) {
      return handleDurableObjectRequest(request, env, ctx);
    }

    return new Response('Not found', { status: 404 });
  },
};
