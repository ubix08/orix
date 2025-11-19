// src/durable-agent.ts - Corrected Durable Object implementation (RPC + WebSocket) import { DurableObject } from "cloudflare:workers"; import type { DurableObjectState } from '@cloudflare/workers-types'; import type { Env, Message } from './types'; import { Agent, type StepResult } from './agent-core'; import { DurableStorage } from './durable-storage'; import { GeminiClient } from './gemini'; import { D1Manager } from './storage/d1-manager'; import { MemoryManager } from './memory/memory-manager'; import { MessageService } from './services/message-service'; import { SessionManager } from './session/session-manager'; import type { AgentConfig } from './agent-core';

export class AutonomousAgent extends DurableObject { private storage: DurableStorage; private agent: Agent; private gemini: GeminiClient; private env: Env; private activeSockets = new Set<WebSocket>(); private d1?: D1Manager; private memory?: MemoryManager; private sessionId?: string; private messageService?: MessageService; private sessionManager?: SessionManager; private memoryEnabled = true; private initialized = false; private maxTurns = 3;

constructor(state: DurableObjectState, env: Env) { super(state, env); this.env = env; this.storage = new DurableStorage(state); this.gemini = new GeminiClient({ apiKey: env.GEMINI_API_KEY });

// If we were created with a named id, it will be available
const name = state.id?.name;
if (name && name.startsWith('session:')) {
  this.sessionId = name.slice(8);
}

if (env.DB) {
  this.d1 = new D1Manager(env.DB);
  this.sessionManager = new SessionManager(env.DB);
  console.log('[DurableAgent] D1 persistence enabled');
}

const config: AgentConfig = {
  model: 'gemini-2.5-flash',
  thinkingBudget: 1024,
  temperature: 0.7,
  useSearch: true,
  useCodeExecution: true,
  useMapsGrounding: false,
  useVision: false,
};

this.agent = new Agent(this.gemini, config);

}

// Initialize the DO (idempotent) private async init(): Promise<void> { if (this.initialized) return;

if (!this.sessionId) {
  console.warn('[DurableAgent] init called without sessionId');
}

// 1. Initialize memory (if available and sessionId present)
if (this.sessionId && this.env.VECTORIZE && !this.memory) {
  this.memory = new MemoryManager(
    this.env.VECTORIZE,
    this.env.GEMINI_API_KEY,
    this.sessionId,
    {
      longTermEnabled: true,
      ltmThreshold: 0.65,
    }
  );
  console.log('[DurableAgent] Memory system initialized');
}

// 2. Initialize MessageService (create even if D1 absent) — requires sessionId
if (this.sessionId) {
  this.messageService = new MessageService(this.storage, this.sessionId, this.memory);

  if (this.d1) {
    this.messageService.setD1FlushHandler(async (messages: Message[]) => {
      if (this.d1 && this.sessionId) {
        await this.d1.saveMessages(this.sessionId, messages);
        await this.d1.updateSessionActivity(this.sessionId);
      }
    });
    console.log('[DurableAgent] MessageService connected to D1');
  } else {
    console.log('[DurableAgent] MessageService running in RAM/DO-Storage only (No D1)');
  }
} else {
  console.warn('[DurableAgent] init: sessionId missing, MessageService not created yet');
}

// 3. Hydrate from D1 if available
if (this.sessionId && this.sessionManager && this.d1) {
  try {
    await this.sessionManager.getOrCreateSession(this.sessionId);
    if (this.storage.getMessages().length === 0) {
      await this.loadFromD1(this.sessionId);
    }
  } catch (e) {
    console.warn('[DurableAgent] D1 hydration skipped:', e);
  }
}

this.initialized = true;

}

// ============================================================= // Durable Object fetch entry — this will be called when the Worker forwards requests // ============================================================= async fetch(request: Request): Promise<Response> { // Try to extract session id from either constructor (id.name) OR incoming headers/query const url = new URL(request.url);

// If the DO wasn't created with a name, the Worker should forward X-Session-ID header
if (!this.sessionId) {
  const fromHeader = request.headers.get('X-Session-ID');
  const fromQuery = url.searchParams.get('session_id');
  if (fromHeader) {
    this.sessionId = fromHeader;
    this.initialized = false; // force re-init
    console.log('[DurableAgent] sessionId set from X-Session-ID header');
  } else if (fromQuery) {
    this.sessionId = fromQuery;
    this.initialized = false;
    console.log('[DurableAgent] sessionId set from query param');
  }
}

// If the request is an Upgrade to WebSocket, handle it specially
if (request.headers.get('Upgrade')?.toLowerCase() === 'websocket' && new URL(request.url).pathname === '/api/ws') {
  // Ensure we init before accepting connections so MessageService is available
  await this.init();
  return this.handleWebSocketUpgrade(request);
}

// Otherwise handle RPC-style calls over fetch
await this.init();

const pathname = new URL(request.url).pathname;

try {
  switch (pathname) {
    case '/api/chat':
      if (request.method === 'POST') {
        const body = (await request.json()) as { message: string };
        const message = body.message?.trim();
        if (!message) return new Response('Missing message', { status: 400 });
        const res = await this.handleChat(message);
        return new Response(JSON.stringify(res), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      break;

    case '/api/history':
      if (request.method === 'GET') {
        const res = await this.getHistory();
        return new Response(JSON.stringify(res), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      break;

    case '/api/clear':
      if (request.method === 'POST') {
        const res = await this.clearHistory();
        return new Response(JSON.stringify(res), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      break;

    case '/api/status':
      if (request.method === 'GET') {
        const res = await this.getStatus();
        return new Response(JSON.stringify(res), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      break;

    case '/api/sync':
      if (request.method === 'POST') {
        const res = await this.syncToD1();
        return new Response(JSON.stringify(res), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      break;

    case '/api/memory/search':
      if (request.method === 'POST') {
        const body = (await request.json()) as { query: string; topK?: number };
        const res = await this.searchMemory(body);
        return new Response(JSON.stringify(res), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      break;

    case '/api/memory/stats':
      if (request.method === 'GET') {
        const res = await this.getMemoryStats();
        return new Response(JSON.stringify(res), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      break;

    case '/api/memory/summarize':
      if (request.method === 'POST') {
        const res = await this.summarizeSession();
        return new Response(JSON.stringify(res), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      break;
  }

  return new Response('Not Found', { status: 404 });
} catch (err: any) {
  console.error('[DurableAgent] fetch error:', err);
  return new Response(JSON.stringify({ error: err?.message || String(err) }), { status: 500, headers: { 'Content-Type': 'application/json' } });
}

}

// ============================================================= // WebSocket handling (inside DO) // ============================================================= private handleWebSocketUpgrade(request: Request): Response { // Create a WebSocket pair and accept the server side const pair = new WebSocketPair(); const [client, server] = Array.from(pair) as [WebSocket, WebSocket];

try {
  // Accept server socket
  (server as any).accept?.();
} catch (e) {
  console.error('[DurableAgent] WebSocket accept error', e);
  // Return client side anyway so the handshake fails on client
  return new Response(null, { status: 101, webSocket: client });
}

// Attach handlers
server.onmessage = (evt) => {
  void this.webSocketMessage(server, evt.data).catch((err) => {
    console.error('[DurableAgent] WS message error:', err);
  });
};

server.onclose = () => {
  this.activeSockets.delete(server);
  console.log('[DurableAgent] WebSocket closed');
};

server.onerror = (evt) => {
  console.error('[DurableAgent] WebSocket error:', evt);
  this.activeSockets.delete(server);
};

this.activeSockets.add(server);
return new Response(null, { status: 101, webSocket: client });

}

private async webSocketMessage(ws: WebSocket, msg: string | ArrayBuffer): Promise<void> { if (typeof msg !== 'string' || ws.readyState !== WebSocket.OPEN) return;

let payload: any;
try {
  payload = JSON.parse(msg);
} catch {
  return this.send(ws, { type: 'error', error: 'Invalid JSON' });
}

if (payload.type !== 'user_message' || typeof payload.content !== 'string') {
  this.send(ws, { type: 'error', error: 'Invalid message payload' });
  return;
}

const userMsg = payload.content;

try {
  // Use transaction to guard state changes and ensure consistency
  await this.storage.getDurableObjectState().waitUntil?.(
    this.processWebSocketMessage(userMsg, ws).catch((err) => {
      console.error('[DurableAgent] processWebSocketMessage failed:', err);
      this.send(ws, { type: 'error', error: 'Processing failed' });
    })
  );
} catch {
  // If waitUntil is not available, run directly
  void this.processWebSocketMessage(userMsg, ws).catch((err) => {
    console.error('[DurableAgent] processWebSocketMessage failed:', err);
    this.send(ws, { type: 'error', error: 'Processing failed' });
  });
}

}

private async processWebSocketMessage(userMsg: string, ws: WebSocket | null): Promise<void> { if (!this.messageService) { // Defensive: try to initialize one last time (in case sessionId was set later) console.warn('[DurableAgent] MessageService not initialized, attempting final init'); await this.init(); }

if (!this.messageService) {
  throw new Error('MessageService not initialized');
}

await this.storage.withTransaction(async (state) => {
  state.lastActivityAt = Date.now();

  // Save user message
  await this.messageService!.saveMessage('user', userMsg);

  // Check for cached response
  const cachedResult = await this.checkCachedResponse(userMsg);
  if (cachedResult.useCached && cachedResult.response) {
    // Stream cached response
    const words = cachedResult.response.split(' ');
    for (const word of words) {
      this.send(ws, { type: 'chunk', content: word + ' ' });
      // slight backpressure-friendly delay
      await new Promise((r) => setTimeout(r, 10));
    }

    await this.messageService!.saveMessage('model', cachedResult.response);
    this.send(ws, { type: 'complete', response: cachedResult.response });
    return;
  }

  // Build memory context
  ws && this.send(ws, { type: 'status', message: 'Searching memory...' });
  const memoryContext = await this.buildMemoryContext(userMsg);

  // Execute ReAct loop with streaming callbacks
  const response = await this.executeReactLoop(
    userMsg,
    this.storage.getMessages(),
    state,
    memoryContext,
    {
      onChunk: (chunk) => ws && this.send(ws, { type: 'chunk', content: chunk }),
      onStatus: (status) => ws && this.send(ws, { type: 'status', message: status }),
      onToolUse: (tools) => ws && this.send(ws, { type: 'tool_use', tools }),
    }
  );

  // Save model response
  await this.messageService!.saveMessage('model', response);

  ws && this.send(ws, { type: 'complete', response });

  // Create LTM summary if needed
  await this.maybeCreateLTM(this.storage.getMessages(), userMsg, response);
});

}

// ============================================================= // RPC Methods for HTTP Endpoints (kept for Worker RPC usage) // =============================================================

public async handleChat(message: string): Promise<{ response: string }> { await this.init();

if (!this.messageService) {
  throw new Error('MessageService not initialized');
}

let finalResponse = '';

await this.storage.withTransaction(async (state) => {
  state.lastActivityAt = Date.now();

  // Save user message
  await this.messageService!.saveMessage('user', message);

  // Check for cached response in LTM
  const cachedResult = await this.checkCachedResponse(message);
  if (cachedResult.useCached && cachedResult.response) {
    finalResponse = cachedResult.response;
    await this.messageService!.saveMessage('model', finalResponse);
    return;
  }

  // Build memory context
  const memoryContext = await this.buildMemoryContext(message);

  // Execute ReAct loop
  finalResponse = await this.executeReactLoop(
    message,
    this.storage.getMessages(),
    state,
    memoryContext
  );

  // Save model response
  await this.messageService!.saveMessage('model', finalResponse);

  // Create LTM summary if needed
  await this.maybeCreateLTM(this.storage.getMessages(), message, finalResponse);
});

return { response: finalResponse };

}

public async getHistory(): Promise<{ messages: Message[] }> { await this.init(); return { messages: this.storage.getMessages() }; }

public async clearHistory(): Promise<{ ok: boolean }> { await this.init();

if (this.messageService) {
  await this.messageService.clear();
} else {
  await this.storage.clearAll();
  if (this.memory) {
    await this.memory.clearSessionMemory();
  }
}

return { ok: true };

}

public async getStatus(): Promise<object> { await this.init(); const storageStatus = this.storage.getStatus(); const config = this.agent.getConfig(); const circuit = this.gemini.getCircuitBreakerStatus?.() || { healthy: true };

return {
  ...storageStatus,
  agentConfig: {
    model: config.model,
    maxTurns: this.maxTurns,
    useSearch: config.useSearch,
    useCodeExecution: config.useCodeExecution,
  },
  circuitBreaker: circuit,
  d1Status: {
    enabled: !!this.d1,
    sessionId: this.sessionId || null,
    pendingFlush: this.messageService?.getPendingCount() ?? 0,
  },
  memoryStatus: {
    enabled: !!this.memory,
    vectorizeAvailable: !!this.env.VECTORIZE,
  },
};

}

public async syncToD1(): Promise<object> { await this.init();

if (!this.messageService) {
  throw new Error('MessageService not initialized');
}

await this.messageService.flush();
return { ok: true, sessionId: this.sessionId };

}

public async searchMemory(body: { query: string; topK?: number }): Promise<{ results: any[] }> { await this.init();

if (!this.memory) {
  throw new Error('Memory system not available');
}

const results = await this.memory.searchMemory(body.query, {
  topK: body.topK || 10,
});

return { results };

}

public async getMemoryStats(): Promise<object> { await this.init();

if (!this.memory) {
  throw new Error('Memory system not available');
}

return await this.memory.getMemoryStats();

}

public async summarizeSession(): Promise<{ summary: string; topics: string[] }> { await this.init();

if (!this.memory) {
  throw new Error('Memory system not available');
}

const history = this.storage.getMessages();
const messages = history.map((m) => ({
  role: m.role,
  content: m.parts?.map((p) => (typeof p === 'string' ? p : p.text)).join(' ') || '',
}));

const summary = await this.memory.summarizeConversation(messages);
const topics = await this.memory.extractImportantTopics(summary);

return { summary, topics };

}

// ============================================================= // ReAct Loop (from Agent) // =============================================================

private async executeReactLoop( userMessage: string, history: Message[], state: any, memoryContext?: string, callbacks?: { onChunk?: (chunk: string) => void; onStatus?: (status: string) => void; onToolUse?: (tools: string[]) => void; } ): Promise<string> { const systemPrompt = this.agent.buildSystemPrompt(state, memoryContext); let formattedHistory = this.agent.formatHistory(history, systemPrompt, userMessage);

let fullResponse = '';
let turn = 0;

while (turn < this.maxTurns) {
  turn++;
  callbacks?.onStatus?.(`Turn ${turn}/${this.maxTurns} | Reasoning...`);

  const step = await this.agent.executeStep(formattedHistory, state, {
    onChunk: callbacks?.onChunk,
    onStatus: callbacks?.onStatus,
    onError: (error) => console.error('[ReAct] Step error:', error),
  });

  fullResponse += step.text;

  if (step.completed) {
    console.log(`[ReAct] Completed in ${turn} turns`);
    break;
  }

  callbacks?.onToolUse?.(step.toolCalls.map((t) => t.name));
  const toolResults = await this.agent.executeTools(step.toolCalls, state);
  const observationText = this.agent.formatToolResults(toolResults);

  formattedHistory.push({
    role: 'assistant',
    content: step.text,
    toolCalls: step.toolCalls,
  });
  formattedHistory.push({
    role: 'user',
    content: observationText,
  });

  callbacks?.onStatus?.(`Turn ${turn} completed, continuing...`);
}

if (turn >= this.maxTurns) {
  console.warn('[ReAct] Max turns reached without completion');
}

return fullResponse;

}

// ============================================================= // Memory helpers and LTM // =============================================================

private async checkCachedResponse( query: string ): Promise<{ useCached: boolean; response?: string }> { if (!this.memory) return { useCached: false };

try {
  const ltmResults = await this.memory.searchLongTermMemory(query, 1);

  if (ltmResults.length > 0 && ltmResults[0].score >= 0.9) {
    const storedAnswer = ltmResults[0].metadata?.answer;
    if (storedAnswer) {
      await this.memory.updateLongTermMemory({
        ...ltmResults[0].metadata,
        lastAccessed: Date.now(),
        interactions: (ltmResults[0].metadata.interactions || 0) + 1,
      });

      return {
        useCached: true,
        response: `[Based on similar past query]

${storedAnswer}`, }; } } } catch (error) { console.error('[DurableAgent] Cache check failed:', error); }

return { useCached: false };

}

private async buildMemoryContext(query: string): Promise<string> { if (!this.memory) return '';

try {
  const memoryResult = await this.memory.buildEnhancedContext(query, undefined, {
    includeSTM: true,
    includeLTM: true,
    maxSTMResults: 5,
    maxLTMResults: 3,
  });

  return memoryResult.context;
} catch (error) {
  console.error('[DurableAgent] Memory context building failed:', error);
  return '';
}

}

private async maybeCreateLTM( history: Message[], lastQuery: string, lastResponse: string ): Promise<void> { if (!this.memory || !this.sessionId) return; if (history.length === 0 || history.length % 15 !== 0) return;

try {
  const messagesToSummarize = history.slice(-15).map((m) => ({
    role: m.role,
    content: m.parts?.map((p) => (typeof p === 'string' ? p : p.text)).join(' ') || '',
  }));

  const summary = await this.memory.summarizeConversation(messagesToSummarize);
  const topics = await this.memory.extractImportantTopics(summary);

  const userQueries = messagesToSummarize
    .filter((m) => m.role === 'user')
    .map((m) => m.content)
    .join(' | ');

  await this.memory.addLongTermMemory({
    id: `ltm_${this.sessionId}_${Date.now()}`,
    sessionId: this.sessionId,
    query: userQueries || lastQuery,
    summary,
    importance: this.calculateImportance(summary, topics),
    timestamp: Date.now(),
    interactions: 1,
    lastAccessed: Date.now(),
    answer: lastResponse,
    topics: topics.join(', '),
  } as any);

  console.log('[DurableAgent] Created LTM summary with topics:', topics);
} catch (error) {
  console.error('[DurableAgent] Failed to create LTM:', error);
}

}

private calculateImportance(summary: string, topics: string[]): number { let score = 0.5;

if (summary.length > 500) score += 0.2;
else if (summary.length > 200) score += 0.1;

score += Math.min(topics.length * 0.05, 0.2);

const importantKeywords = [
  'error',
  'bug',
  'fix',
  'solution',
  'problem',
  'deploy',
  'production',
  'critical',
  'important',
  'api',
  'database',
  'configuration',
  'setup',
];

const lowerSummary = summary.toLowerCase();
const keywordMatches = importantKeywords.filter((kw) => lowerSummary.includes(kw)).length;

score += Math.min(keywordMatches * 0.05, 0.15);

return Math.min(Math.max(score, 0.5), 1.0);

}

// ============================================================= // D1 Helpers // =============================================================

private async loadFromD1(sessionId: string): Promise<void> { if (!this.d1) return;

try {
  const messages = await this.d1.loadMessages(sessionId, 200);
  console.log(`[DurableAgent] Loaded ${messages.length} messages from D1`);

  for (const msg of messages) {
    await this.storage.saveMessage(msg.role as any, msg.parts, msg.timestamp);
  }

  await this.d1.updateSessionActivity(sessionId);
} catch (err) {
  console.error('[DurableAgent] D1 load failed:', err);
}

}

private send(ws: WebSocket | null, data: unknown): void { if (!ws || ws.readyState !== WebSocket.OPEN) return; try { ws.send(JSON.stringify(data)); } catch (e) { console.error('[DurableAgent] WS send error:', e); } } }

export default AutonomousAgent;
