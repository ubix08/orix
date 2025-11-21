// src/durable-agent.ts - FIXED MEMORY INTEGRATION
import { DurableObject } from "cloudflare:workers";
import type { DurableObjectState } from '@cloudflare/workers-types';
import type { Env, Message } from './types';
import { Agent, type StepResult } from './agent-core';
import { DurableStorage } from './durable-storage';
import { GeminiClient } from './gemini';
import { D1Manager } from './storage/d1-manager';
import { MemoryManager } from './memory/memory-manager';
import { MessageService } from './services/message-service';
import { SessionManager } from './session/session-manager';
import type { AgentConfig } from './agent-core';
import {
  Orchestrator,
  type BoardStorage,
  type TaskBoard,
  type OrchestratorEvent,
  type SessionContext,
} from './orchestration';

export class AutonomousAgent extends DurableObject {
  private storage: DurableStorage;
  private agent: Agent;
  private gemini: GeminiClient;
  private env: Env;
  private activeSockets = new Set<WebSocket>();
  private d1?: D1Manager;
  private memory?: MemoryManager;
  private sessionId?: string;
  private messageService?: MessageService;
  private sessionManager?: SessionManager;
  private memoryEnabled = true;
  private initialized = false;
  private maxTurns = 10;
  private orchestrator?: Orchestrator;

  // ✅ NEW: Memory auto-save interval (every 5 messages instead of 15)
  private readonly MEMORY_SAVE_INTERVAL = 5;
  private messagesSinceLastSave = 0;

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    this.env = env;
    this.storage = new DurableStorage(state);
    this.gemini = new GeminiClient({ apiKey: env.GEMINI_API_KEY });

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

  // ===== Board Storage (unchanged) =====
  private createBoardStorage(): BoardStorage {
    const doState = this.storage.getDurableObjectState();
    return {
      loadBoard: async (sessionId: string): Promise<TaskBoard | null> => {
        try {
          const board = await doState.storage.get<TaskBoard>(`taskBoard:${sessionId}`);
          return board || null;
        } catch {
          return null;
        }
      },
      saveBoard: async (board: TaskBoard): Promise<void> => {
        await doState.storage.put(`taskBoard:${board.sessionId}`, board);
      },
      deleteBoard: async (boardId: string): Promise<void> => {
        if (this.sessionId) {
          await doState.storage.delete(`taskBoard:${this.sessionId}`);
        }
      },
    };
  }

  // ===== FIXED INITIALIZATION =====
  private async init(): Promise<void> {
    if (this.initialized) return;

    if (!this.sessionId) {
      console.warn('[DurableAgent] init called without sessionId');
    }

    // ✅ FIXED: Initialize MemoryManager with GeminiClient, not API key
    if (this.sessionId && this.env.VECTORIZE && !this.memory) {
      this.memory = new MemoryManager(
        this.env.VECTORIZE,
        this.gemini,  // ✅ Pass GeminiClient instance
        this.sessionId,
        { longTermEnabled: true, ltmThreshold: 0.65 }
      );
      console.log('[DurableAgent] Memory system initialized');
    }

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
      }

      this.orchestrator = new Orchestrator(
        this.gemini,
        this.createBoardStorage(),
        this.sessionId,
        {
          maxRetries: 2,
          workerMaxTurns: 5,
          autoReplanOnFailure: true,
          requireCheckpointApproval: true,
        }
      );
      console.log('[DurableAgent] Orchestrator initialized');
    }

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

  // ===== FETCH (unchanged) =====
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (!this.sessionId) {
      const fromHeader = request.headers.get('X-Session-ID');
      const fromQuery = url.searchParams.get('session_id');
      if (fromHeader) {
        this.sessionId = fromHeader;
        this.initialized = false;
      } else if (fromQuery) {
        this.sessionId = fromQuery;
        this.initialized = false;
      }
    }

    if (request.headers.get('Upgrade')?.toLowerCase() === 'websocket' && url.pathname === '/api/ws') {
      await this.init();
      return this.handleWebSocketUpgrade(request);
    }

    await this.init();
    const pathname = url.pathname;

    try {
      switch (pathname) {
        case '/api/chat':
          if (request.method === 'POST') {
            const body = (await request.json()) as { message: string };
            const message = body.message?.trim();
            if (!message) return new Response('Missing message', { status: 400 });
            const res = await this.handleChat(message);
            return new Response(JSON.stringify(res), { status: 200, headers: { 'Content-Type': 'application/json' } });
          }
          break;

        case '/api/tasks/status':
          if (request.method === 'GET') {
            const res = await this.getTaskStatus();
            return new Response(JSON.stringify(res), { status: 200, headers: { 'Content-Type': 'application/json' } });
          }
          break;

        case '/api/tasks/resume':
          if (request.method === 'POST') {
            const body = (await request.json()) as { feedback: string; approved?: boolean };
            const res = await this.resumeTasks(body.feedback, body.approved ?? true);
            return new Response(JSON.stringify(res), { status: 200, headers: { 'Content-Type': 'application/json' } });
          }
          break;

        case '/api/tasks/abandon':
          if (request.method === 'POST') {
            await this.orchestrator?.abandonBoard();
            return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
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

  // ===== WebSocket (unchanged) =====
  private handleWebSocketUpgrade(request: Request): Response {
    const pair = new WebSocketPair();
    const [client, server] = Array.from(pair) as [WebSocket, WebSocket];

    try {
      (server as any).accept?.();
    } catch (e) {
      console.error('[DurableAgent] WebSocket accept error', e);
      return new Response(null, { status: 101, webSocket: client });
    }

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
    this.sendSessionGreeting(server);

    return new Response(null, { status: 101, webSocket: client });
  }

  private async sendSessionGreeting(ws: WebSocket): Promise<void> {
    if (!this.orchestrator) return;

    try {
      const context = await this.orchestrator.getSessionContext();
      this.send(ws, { type: 'session_context', context });
    } catch (e) {
      console.error('[DurableAgent] Failed to send session greeting:', e);
    }
  }

  private async webSocketMessage(ws: WebSocket, msg: string | ArrayBuffer): Promise<void> {
    if (typeof msg !== 'string' || ws.readyState !== WebSocket.OPEN) return;

    let payload: any;
    try {
      payload = JSON.parse(msg);
    } catch {
      return this.send(ws, { type: 'error', error: 'Invalid JSON' });
    }

    switch (payload.type) {
      case 'user_message':
        if (typeof payload.content !== 'string') {
          this.send(ws, { type: 'error', error: 'Invalid message payload' });
          return;
        }
        await this.processWebSocketMessage(payload.content, ws);
        break;

      case 'checkpoint_response':
        await this.handleCheckpointResponse(ws, payload.feedback, payload.approved ?? true);
        break;

      case 'abandon_task':
        await this.orchestrator?.abandonBoard();
        this.send(ws, { type: 'task_abandoned' });
        break;

      default:
        if (payload.content) {
          await this.processWebSocketMessage(payload.content, ws);
        } else {
          this.send(ws, { type: 'error', error: 'Unknown message type' });
        }
    }
  }

  // ===== FIXED MESSAGE PROCESSING =====
  private async processWebSocketMessage(userMsg: string, ws: WebSocket | null): Promise<void> {
    if (!this.messageService) {
      await this.init();
    }

    if (!this.messageService || !this.orchestrator) {
      throw new Error('Services not initialized');
    }

    await this.storage.withTransaction(async (state) => {
      state.lastActivityAt = Date.now();

      // ✅ Save user message + increment memory counter
      await this.messageService!.saveMessage('user', userMsg);
      this.messagesSinceLastSave++;

      // ✅ FIXED: Save to short-term memory immediately
      if (this.memory) {
        try {
          await this.memory.saveMemory({
            id: `stm_${this.sessionId}_${Date.now()}`,
            content: `User: ${userMsg}`,
            metadata: {
              sessionId: this.sessionId!,
              timestamp: Date.now(),
              role: 'user',
            },
          });
        } catch (error) {
          console.error('[DurableAgent] Failed to save user message to memory:', error);
        }
      }

      const sessionContext = await this.orchestrator!.getSessionContext();
      
      if (sessionContext.hasActiveBoard && sessionContext.suggestedAction === 'resume') {
        const lowerMsg = userMsg.toLowerCase();
        if (lowerMsg.includes('continue') || lowerMsg.includes('yes') || lowerMsg.includes('proceed')) {
          await this.handleCheckpointResponse(ws, userMsg, true);
          return;
        }
        if (lowerMsg.includes('no') || lowerMsg.includes('stop') || lowerMsg.includes('cancel')) {
          await this.orchestrator!.abandonBoard();
          this.send(ws, { type: 'status', message: 'Task abandoned. How can I help you?' });
          return;
        }
      }

      ws && this.send(ws, { type: 'status', message: 'Analyzing request...' });
      const complexity = await this.orchestrator!.evaluateComplexity(userMsg);

      if (!complexity.isComplex) {
        await this.handleSimpleQuery(userMsg, ws, state);
        return;
      }

      ws && this.send(ws, { type: 'status', message: `Planning ${complexity.estimatedTasks || 'multiple'} tasks...` });

      this.orchestrator!.onEvent((event) => this.streamOrchestratorEvent(ws, event));

      const memoryContext = await this.buildMemoryContext(userMsg);

      const board = await this.orchestrator!.createPlan(userMsg, userMsg, memoryContext);
      
      ws && this.send(ws, {
        type: 'plan_created',
        taskCount: board.tasks.length,
        checkpoints: board.totalCheckpoints,
        summary: `Created plan with ${board.tasks.length} tasks and ${board.totalCheckpoints} checkpoints.`,
      });

      const result = await this.orchestrator!.executeUntilCheckpoint();

      if (result.status === 'completed') {
        await this.messageService!.saveMessage('model', result.finalOutput || result.message);
        this.messagesSinceLastSave++;
        ws && this.send(ws, { type: 'complete', response: result.finalOutput || result.message });
        
        // ✅ Save assistant response to memory
        await this.saveAssistantMemory(result.finalOutput || '');
        
        // ✅ Trigger LTM save if needed
        await this.autoSaveLTM();
      } else if (result.status === 'checkpoint') {
        ws && this.send(ws, {
          type: 'checkpoint',
          message: result.message,
          task: result.checkpointTask,
        });
      } else {
        await this.messageService!.saveMessage('model', `Task failed: ${result.message}`);
        ws && this.send(ws, { type: 'error', error: result.message });
      }
    });
  }

  // ===== SIMPLE QUERY HANDLER (FIXED) =====
  private async handleSimpleQuery(userMsg: string, ws: WebSocket | null, state: any): Promise<void> {
    const cachedResult = await this.checkCachedResponse(userMsg);
    if (cachedResult.useCached && cachedResult.response) {
      const words = cachedResult.response.split(' ');
      for (const word of words) {
        this.send(ws, { type: 'chunk', content: word + ' ' });
        await new Promise((r) => setTimeout(r, 10));
      }
      await this.messageService!.saveMessage('model', cachedResult.response);
      this.messagesSinceLastSave++;
      this.send(ws, { type: 'complete', response: cachedResult.response });
      
      // ✅ Save to memory
      await this.saveAssistantMemory(cachedResult.response);
      await this.autoSaveLTM();
      return;
    }

    ws && this.send(ws, { type: 'status', message: 'Searching memory...' });
    const memoryContext = await this.buildMemoryContext(userMsg);

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

    await this.messageService!.saveMessage('model', response);
    this.messagesSinceLastSave++;
    ws && this.send(ws, { type: 'complete', response });
    
    // ✅ Save to memory
    await this.saveAssistantMemory(response);
    
    // ✅ Auto-save LTM
    await this.autoSaveLTM();
  }

  // ===== NEW: MEMORY HELPERS =====

  /**
   * ✅ NEW: Save assistant response to short-term memory immediately
   */
  private async saveAssistantMemory(response: string): Promise<void> {
    if (!this.memory || !response) return;

    try {
      await this.memory.saveMemory({
        id: `stm_${this.sessionId}_${Date.now()}`,
        content: `Assistant: ${response}`,
        metadata: {
          sessionId: this.sessionId!,
          timestamp: Date.now(),
          role: 'assistant',
        },
      });
    } catch (error) {
      console.error('[DurableAgent] Failed to save assistant memory:', error);
    }
  }

  /**
   * ✅ FIXED: Auto-save to long-term memory every N messages (configurable)
   */
  private async autoSaveLTM(): Promise<void> {
    if (!this.memory || !this.sessionId) return;
    
    // ✅ Save every 5 messages instead of 15
    if (this.messagesSinceLastSave < this.MEMORY_SAVE_INTERVAL) return;

    try {
      this.messagesSinceLastSave = 0;

      const history = this.storage.getMessages();
      const recentMessages = history.slice(-this.MEMORY_SAVE_INTERVAL).map((m) => ({
        role: m.role,
        content: m.parts?.map((p) => (typeof p === 'string' ? p : p.text)).join(' ') || '',
      }));

      if (recentMessages.length === 0) return;

      const summary = await this.memory.summarizeConversation(recentMessages);
      const topics = await this.memory.extractImportantTopics(summary);

      const userQueries = recentMessages
        .filter((m) => m.role === 'user')
        .map((m) => m.content)
        .join(' | ');

      const lastResponse = recentMessages
        .filter((m) => m.role === 'model')
        .map((m) => m.content)
        .pop() || '';

      await this.memory.addLongTermMemory({
        id: `ltm_${this.sessionId}_${Date.now()}`,
        sessionId: this.sessionId,
        query: userQueries,
        summary,
        importance: this.calculateImportance(summary, topics),
        timestamp: Date.now(),
        interactions: 1,
        lastAccessed: Date.now(),
        answer: lastResponse,
        topics: topics.join(', '),
      });

      console.log('[DurableAgent] Auto-saved LTM with topics:', topics);
    } catch (error) {
      console.error('[DurableAgent] Auto-save LTM failed:', error);
    }
  }

  // ===== CHECKPOINT HANDLING (unchanged) =====
  private async handleCheckpointResponse(ws: WebSocket | null, feedback: string, approved: boolean): Promise<void> {
    if (!this.orchestrator) {
      this.send(ws, { type: 'error', error: 'Orchestrator not initialized' });
      return;
    }

    this.orchestrator.onEvent((event) => this.streamOrchestratorEvent(ws, event));

    const result = await this.orchestrator.resumeFromCheckpoint(feedback, approved);

    if (result.status === 'completed') {
      await this.messageService?.saveMessage('model', result.finalOutput || result.message);
      ws && this.send(ws, { type: 'complete', response: result.finalOutput || result.message });
    } else if (result.status === 'checkpoint') {
      ws && this.send(ws, {
        type: 'checkpoint',
        message: result.message,
        task: result.checkpointTask,
      });
    } else {
      ws && this.send(ws, { type: 'error', error: result.message });
    }
  }

  private streamOrchestratorEvent(ws: WebSocket | null, event: OrchestratorEvent): void {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    switch (event.type) {
      case 'task_started':
        this.send(ws, {
          type: 'task_progress',
          message: `[${event.index + 1}/${event.total}] Starting: ${event.task.name}`,
          taskId: event.task.id,
        });
        break;

      case 'task_progress':
        this.send(ws, {
          type: 'task_progress',
          message: event.message,
          taskId: event.taskId,
        });
        break;

      case 'task_completed':
        this.send(ws, {
          type: 'task_completed',
          taskId: event.task.id,
          taskName: event.task.name,
          preview: event.result.substring(0, 200) + (event.result.length > 200 ? '...' : ''),
        });
        break;

      case 'task_failed':
        this.send(ws, {
          type: 'task_failed',
          taskId: event.task.id,
          error: event.error,
          willRetry: event.willRetry,
        });
        break;

      case 'replan_triggered':
        this.send(ws, {
          type: 'status',
          message: `Replanning: ${event.reason}`,
        });
        break;

      default:
        this.send(ws, event);
    }
  }

  // ===== PUBLIC RPC METHODS (unchanged) =====

  public async getTaskStatus(): Promise<object> {
    await this.init();
    if (!this.orchestrator) {
      return { hasActiveBoard: false };
    }
    return this.orchestrator.getSessionContext();
  }

  public async resumeTasks(feedback: string, approved: boolean): Promise<object> {
    await this.init();
    if (!this.orchestrator) {
      throw new Error('Orchestrator not initialized');
    }
    return this.orchestrator.resumeFromCheckpoint(feedback, approved);
  }

  public async handleChat(message: string): Promise<{ response: string }> {
    await this.init();

    if (!this.messageService) {
      throw new Error('MessageService not initialized');
    }

    let finalResponse = '';

    await this.storage.withTransaction(async (state) => {
      state.lastActivityAt = Date.now();

      await this.messageService!.saveMessage('user', message);
      this.messagesSinceLastSave++;

      const cachedResult = await this.checkCachedResponse(message);
      if (cachedResult.useCached && cachedResult.response) {
        finalResponse = cachedResult.response;
        await this.messageService!.saveMessage('model', finalResponse);
        this.messagesSinceLastSave++;
        return;
      }

      const memoryContext = await this.buildMemoryContext(message);

      finalResponse = await this.executeReactLoop(
        message,
        this.storage.getMessages(),
        state,
        memoryContext
      );

      await this.messageService!.saveMessage('model', finalResponse);
      this.messagesSinceLastSave++;

      await this.saveAssistantMemory(finalResponse);
      await this.autoSaveLTM();
    });

    return { response: finalResponse };
  }

  public async getHistory(): Promise<{ messages: Message[] }> {
    await this.init();
    return { messages: this.storage.getMessages() };
  }

  public async clearHistory(): Promise<{ ok: boolean }> {
    await this.init();

    if (this.messageService) {
      await this.messageService.clear();
    } else {
      await this.storage.clearAll();
      if (this.memory) {
        await this.memory.clearSessionMemory();
      }
    }

    this.messagesSinceLastSave = 0;

    return { ok: true };
  }

  public async getStatus(): Promise<object> {
    await this.init();
    const storageStatus = this.storage.getStatus();
    const config = this.agent.getConfig();
    const circuit = this.gemini.getCircuitBreakerStatus?.() || { healthy: true };

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
        messagesSinceLastSave: this.messagesSinceLastSave,
      },
    };
  }

  public async syncToD1(): Promise<object> {
    await this.init();

    if (!this.messageService) {
      throw new Error('MessageService not initialized');
    }

    await this.messageService.flush();
    return { ok: true, sessionId: this.sessionId };
  }

  public async searchMemory(body: { query: string; topK?: number }): Promise<{ results: any[] }> {
    await this.init();

    if (!this.memory) {
      throw new Error('Memory system not available');
    }

    const results = await this.memory.searchMemory(body.query, {
      topK: body.topK || 10,
    });

    return { results };
  }

  public async getMemoryStats(): Promise<object> {
    await this.init();

    if (!this.memory) {
      throw new Error('Memory system not available');
    }

    return await this.memory.getMemoryStats();
  }

  public async summarizeSession(): Promise<{ summary: string; topics: string[] }> {
    await this.init();

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

  // ===== REACT LOOP (unchanged) =====
  private async executeReactLoop(
    userMessage: string,
    history: Message[],
    state: any,
    memoryContext?: string,
    callbacks?: {
      onChunk?: (chunk: string) => void;
      onStatus?: (status: string) => void;
      onToolUse?: (tools: string[]) => void;
    }
  ): Promise<string> {
    const systemPrompt = this.agent.buildSystemPrompt(state, memoryContext);
    let formattedHistory = this.agent.formatHistory(history, systemPrompt, userMessage);

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

  // ===== MEMORY HELPERS =====

  private async checkCachedResponse(
    query: string
  ): Promise<{ useCached: boolean; response?: string }> {
    if (!this.memory) return { useCached: false };

    try {
      const ltmResults = await this.memory.searchLongTermMemory(query, 1);

      if (ltmResults.length > 0 && ltmResults[0].score >= 0.9) {
        const storedAnswer = ltmResults[0].metadata?.answer;
        if (storedAnswer) {
          await this.memory.updateLongTermMemory({
            id: ltmResults[0].id,
            lastAccessed: Date.now(),
            interactions: (ltmResults[0].metadata.interactions || 0) + 1,
          });

          return {
            useCached: true,
            response: `[Based on similar past query]\n\n${storedAnswer}`,
          };
        }
      }
    } catch (error) {
      console.error('[DurableAgent] Cache check failed:', error);
    }

    return { useCached: false };
  }

  private async buildMemoryContext(query: string): Promise<string> {
    if (!this.memory) return '';

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

  private calculateImportance(summary: string, topics: string[]): number {
    let score = 0.5;

    if (summary.length > 500) score += 0.2;
    else if (summary.length > 200) score += 0.1;

    score += Math.min(topics.length * 0.05, 0.2);

    const importantKeywords = [
      'error', 'bug', 'fix', 'solution', 'problem', 'deploy', 'production',
      'critical', 'important', 'api', 'database', 'configuration', 'setup',
    ];

    const lowerSummary = summary.toLowerCase();
    const keywordMatches = importantKeywords.filter((kw) => lowerSummary.includes(kw)).length;

    score += Math.min(keywordMatches * 0.05, 0.15);

    return Math.min(Math.max(score, 0.5), 1.0);
  }

  // ===== D1 HELPERS =====

  private async loadFromD1(sessionId: string): Promise<void> {
    if (!this.d1) return;

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

  private send(ws: WebSocket | null, data: unknown): void {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify(data));
    } catch (e) {
      console.error('[DurableAgent] WS send error:', e);
    }
  }
}

export default AutonomousAgent;
