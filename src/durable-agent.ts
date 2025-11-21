// src/durable-agent.ts - Updated with Task Orchestration Integration
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

// ===== NEW: Import Orchestration System =====
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

  // ===== NEW: Orchestrator instance =====
  private orchestrator?: Orchestrator;

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

  // ===== NEW: Board Storage Implementation =====
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
        // Find and delete by session
        if (this.sessionId) {
          await doState.storage.delete(`taskBoard:${this.sessionId}`);
        }
      },
    };
  }

  // Initialize the DO (idempotent)
  private async init(): Promise<void> {
    if (this.initialized) return;

    if (!this.sessionId) {
      console.warn('[DurableAgent] init called without sessionId');
    }

    if (this.sessionId && this.env.VECTORIZE && !this.memory) {
      this.memory = new MemoryManager(
        this.env.VECTORIZE,
        this.env.GEMINI_API_KEY,
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

      // ===== NEW: Initialize Orchestrator =====
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

  // =============================================================
  // fetch entry — unchanged signature, enhanced routing
  // =============================================================
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

        // ===== NEW: Task management endpoints =====
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

        // Existing endpoints...
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

  // =============================================================
  // WebSocket handling — enhanced with orchestration events
  // =============================================================
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

    // ===== NEW: Send session context on connect =====
    this.sendSessionGreeting(server);

    return new Response(null, { status: 101, webSocket: client });
  }

  // ===== NEW: Session greeting on WebSocket connect =====
  private async sendSessionGreeting(ws: WebSocket): Promise<void> {
    if (!this.orchestrator) return;

    try {
      const context = await this.orchestrator.getSessionContext();
      this.send(ws, {
        type: 'session_context',
        context,
      });
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

    // ===== NEW: Handle different message types =====
    switch (payload.type) {
      case 'user_message':
        if (typeof payload.content !== 'string') {
          this.send(ws, { type: 'error', error: 'Invalid message payload' });
          return;
        }
        await this.processWebSocketMessage(payload.content, ws);
        break;

      case 'checkpoint_response':
        // User responding to a checkpoint
        await this.handleCheckpointResponse(ws, payload.feedback, payload.approved ?? true);
        break;

      case 'abandon_task':
        await this.orchestrator?.abandonBoard();
        this.send(ws, { type: 'task_abandoned' });
        break;

      default:
        // Backward compatibility: treat as user message
        if (payload.content) {
          await this.processWebSocketMessage(payload.content, ws);
        } else {
          this.send(ws, { type: 'error', error: 'Unknown message type' });
        }
    }
  }

  // ===== UPDATED: Process message with orchestration =====
  private async processWebSocketMessage(userMsg: string, ws: WebSocket | null): Promise<void> {
    if (!this.messageService) {
      await this.init();
    }

    if (!this.messageService || !this.orchestrator) {
      throw new Error('Services not initialized');
    }

    await this.storage.withTransaction(async (state) => {
      state.lastActivityAt = Date.now();

      // Save user message
      await this.messageService!.saveMessage('user', userMsg);

      // ===== NEW: Check for active task board =====
      const sessionContext = await this.orchestrator!.getSessionContext();
      
      if (sessionContext.hasActiveBoard && sessionContext.suggestedAction === 'resume') {
        // User might be providing feedback to resume
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
        // Otherwise, treat as new request (will ask about existing task)
      }

      // ===== NEW: Evaluate complexity =====
      ws && this.send(ws, { type: 'status', message: 'Analyzing request...' });
      const complexity = await this.orchestrator!.evaluateComplexity(userMsg);

      if (!complexity.isComplex) {
        // Simple query — use existing direct response path
        await this.handleSimpleQuery(userMsg, ws, state);
        return;
      }

      // ===== NEW: Complex query — create and execute plan =====
      ws && this.send(ws, { type: 'status', message: `Planning ${complexity.estimatedTasks || 'multiple'} tasks...` });

      // Setup event streaming
      this.orchestrator!.onEvent((event) => this.streamOrchestratorEvent(ws, event));

      // Build memory context
      const memoryContext = await this.buildMemoryContext(userMsg);

      // Create plan
      const board = await this.orchestrator!.createPlan(userMsg, userMsg, memoryContext);
      
      ws && this.send(ws, {
        type: 'plan_created',
        taskCount: board.tasks.length,
        checkpoints: board.totalCheckpoints,
        summary: `Created plan with ${board.tasks.length} tasks and ${board.totalCheckpoints} checkpoints.`,
      });

      // Execute until first checkpoint
      const result = await this.orchestrator!.executeUntilCheckpoint();

      // Handle result
      if (result.status === 'completed') {
        await this.messageService!.saveMessage('model', result.finalOutput || result.message);
        ws && this.send(ws, { type: 'complete', response: result.finalOutput || result.message });
        await this.maybeCreateLTM(this.storage.getMessages(), userMsg, result.finalOutput || '');
      } else if (result.status === 'checkpoint') {
        // Don't save partial response — wait for user
        ws && this.send(ws, {
          type: 'checkpoint',
          message: result.message,
          task: result.checkpointTask,
        });
      } else {
        // Failed
        await this.messageService!.saveMessage('model', `Task failed: ${result.message}`);
        ws && this.send(ws, { type: 'error', error: result.message });
      }
    });
  }

  // ===== NEW: Handle simple queries (existing logic extracted) =====
  private async handleSimpleQuery(userMsg: string, ws: WebSocket | null, state: any): Promise<void> {
    // Check for cached response
    const cachedResult = await this.checkCachedResponse(userMsg);
    if (cachedResult.useCached && cachedResult.response) {
      const words = cachedResult.response.split(' ');
      for (const word of words) {
        this.send(ws, { type: 'chunk', content: word + ' ' });
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

    await this.messageService!.saveMessage('model', response);
    ws && this.send(ws, { type: 'complete', response });
    await this.maybeCreateLTM(this.storage.getMessages(), userMsg, response);
  }

  // ===== NEW: Handle checkpoint response =====
  private async handleCheckpointResponse(ws: WebSocket | null, feedback: string, approved: boolean): Promise<void> {
    if (!this.orchestrator) {
      this.send(ws, { type: 'error', error: 'Orchestrator not initialized' });
      return;
    }

    // Setup event streaming
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

  // ===== NEW: Stream orchestrator events to WebSocket =====
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
        // Pass through other events
        this.send(ws, event);
    }
  }

  // ===== NEW: Task status endpoint =====
  public async getTaskStatus(): Promise<object> {
    await this.init();
    if (!this.orchestrator) {
      return { hasActiveBoard: false };
    }
    return this.orchestrator.getSessionContext();
  }

  // ===== NEW: Resume tasks endpoint =====
  public async resumeTasks(feedback: string, approved: boolean): Promise<object> {
    await this.init();
    if (!this.orchestrator) {
      throw new Error('Orchestrator not initialized');
    }
    return this.orchestrator.resumeFromCheckpoint(feedback, approved);
  }

  // =============================================================
  // Existing methods (unchanged)
  // =============================================================

  public async handleChat(message: string): Promise<{ response: string }> {
    await this.init();
    if (!this.messageService) throw new Error('MessageService not initialized');

    let finalResponse = '';

    await this.storage.withTransaction(async (state) => {
      state.lastActivityAt = Date.now();
      await this.messageService!.saveMessage('user', message);

      // Use orchestrator for complexity check
      if (this.orchestrator) {
        const complexity = await this.orchestrator.evaluateComplexity(message);
        
        if (complexity.isComplex) {
          // For HTTP endpoint, we run synchronously until completion or checkpoint
          const memoryContext = await this.buildMemoryContext(message);
          await this.orchestrator.createPlan(message, message, memoryContext);
          const result = await this.orchestrator.executeUntilCheckpoint();
          
          if (result.status === 'completed') {
            finalResponse = result.finalOutput || result.message;
          } else if (result.status === 'checkpoint') {
            finalResponse = `${result.message}\n\n[Checkpoint reached - use /api/tasks/resume to continue]`;
          } else {
            finalResponse = `Task failed: ${result.message}`;
          }
          
          await this.messageService!.saveMessage('model', finalResponse);
          return;
        }
      }

      // Simple query path
      const cachedResult = await this.checkCachedResponse(message);
      if (cachedResult.useCached && cachedResult.response) {
        finalResponse = cachedResult.response;
        await this.messageService!.saveMessage('model', finalResponse);
        return;
      }

      const memoryContext = await this.buildMemoryContext(message);
      finalResponse = await this.executeReactLoop(message, this.storage.getMessages(), state, memoryContext);
      await this.messageService!.saveMessage('model', finalResponse);
      await this.maybeCreateLTM(this.storage.getMessages(), message, finalResponse);
    });

    return { response: finalResponse };
  }

  // ... rest of existing methods remain unchanged ...
  // (getHistory, clearHistory, getStatus, syncToD1, searchMemory, getMemoryStats, 
  //  summarizeSession, executeReactLoop, checkCachedResponse, buildMemoryContext,
  //  maybeCreateLTM, calculateImportance, loadFromD1, send)

  // Keeping method signatures for reference:
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
      if (this.memory) await this.memory.clearSessionMemory();
    }
    // Also clear task board
    await this.orchestrator?.clearBoard();
    return { ok: true };
  }

  public async getStatus(): Promise<object> {
    await this.init();
    const storageStatus = this.storage.getStatus();
    const config = this.agent.getConfig();
    const circuit = this.gemini.getCircuitBreakerStatus?.() || { healthy: true };
    const taskContext = this.orchestrator ? await this.orchestrator.getSessionContext() : null;

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
      // ===== NEW: Task status =====
      taskStatus: taskContext,
    };
  }

  // ... remaining existing methods (syncToD1, searchMemory, etc.) stay unchanged

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
