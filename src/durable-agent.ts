// src/durable-agent.ts - OPTIMIZED VERSION
// Complete rewrite with all optimizations applied
import { DurableObject } from "cloudflare:workers";
import type { DurableObjectState } from '@cloudflare/workers-types';
import type { Env, Message } from './types';
import { Agent, type StepResult, type StepCallbacks } from './agent-core';
import { DurableStorage } from './durable-storage';
import { GeminiClient } from './gemini';
import { D1Manager } from './storage/d1-manager';
import { MemoryManager } from './memory/memory-manager';
import { SessionManager } from './session/session-manager';
import type { AgentConfig } from './agent-core';

// NEW: Import optimization components
import { initManager } from './core/initialization-manager';
import { StorageCoordinator } from './storage/storage-coordinator';
import {
  OrchestrationFacade,
  type ExecutionResult,
} from './orchestration/orchestration-facade';
import type { BoardStorage, TaskBoard, OrchestratorEvent } from './orchestration';

// =============================================================
// WebSocket Message Types (Strong Typing)
// =============================================================

interface WebSocketMessage {
  type: 'user_message' | 'checkpoint_response' | 'abandon_task' | 'get_status';
  content?: string;
  feedback?: string;
  approved?: boolean;
}

interface WebSocketResponse {
  type: 'chunk' | 'status' | 'complete' | 'checkpoint' | 'error' | 
        'task_progress' | 'task_completed' | 'plan_created' | 'session_context';
  content?: string;
  message?: string;
  response?: string;
  error?: string;
  task?: any;
  context?: any;
  [key: string]: any;
}

// =============================================================
// Autonomous Agent Durable Object (Optimized)
// =============================================================

export class AutonomousAgent extends DurableObject {
  // Core dependencies
  private storage: DurableStorage;
  private agent: Agent;
  private gemini: GeminiClient;
  private env: Env;
  
  // Optional dependencies
  private d1?: D1Manager;
  private memory?: MemoryManager;
  private sessionManager?: SessionManager;
  
  // NEW: Optimization components
  private storageCoordinator?: StorageCoordinator;
  private orchestrationFacade?: OrchestrationFacade;
  
  // Session state
  private sessionId?: string;
  private activeSockets = new Set<WebSocket>();
  
  // Configuration
  private maxTurns = 10;
  
  // Performance metrics
  private metrics = {
    totalRequests: 0,
    totalSimpleQueries: 0,
    totalOrchestrated: 0,
    avgResponseTime: 0,
  };

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    this.env = env;
    this.storage = new DurableStorage(state);
    this.gemini = new GeminiClient({ apiKey: env.GEMINI_API_KEY });

    // Extract session ID from Durable Object name
    const name = state.id?.name;
    if (name && name.startsWith('session:')) {
      this.sessionId = name.slice(8);
    }

    // Initialize agent with configuration
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

  // =============================================================
  // Initialization (Centralized & Idempotent)
  // =============================================================

  private async init(): Promise<void> {
    await initManager.initialize('durable-agent', async () => {
      console.log('[DurableAgent] Starting initialization...');

      // 1. Initialize D1 if available
      if (this.env.DB) {
        this.d1 = new D1Manager(this.env.DB);
        this.sessionManager = new SessionManager(this.env.DB);
        console.log('[DurableAgent] D1 initialized');
      }

      // 2. Initialize Memory if available
      if (this.sessionId && this.env.VECTORIZE && !this.memory) {
        this.memory = new MemoryManager(
          this.env.VECTORIZE,
          this.gemini, // Pass GeminiClient instance
          this.sessionId,
          { longTermEnabled: true, ltmThreshold: 0.65 }
        );
        console.log('[DurableAgent] Memory system initialized');
      }

      // 3. Initialize Storage Coordinator
      this.storageCoordinator = new StorageCoordinator({
        batchSize: 10,
        flushInterval: 2000,
        enablePriorityWrite: false,
      });

      // Register storage layers
      this.storageCoordinator.registerDurableStorage(this.storage);
      
      if (this.d1 && this.sessionId) {
        this.storageCoordinator.registerD1(this.d1, this.sessionId);
      }
      
      if (this.memory && this.sessionId) {
        this.storageCoordinator.registerMemory(this.memory, this.sessionId);
      }

      console.log('[DurableAgent] Storage coordinator initialized');

      // 4. Initialize Orchestration Facade
      if (this.sessionId) {
        this.orchestrationFacade = new OrchestrationFacade(
          this.gemini,
          this.createBoardStorage(),
          this.sessionId,
          {
            complexityThreshold: 0.7,
            autoResume: false,
            maxTasksWithoutCheckpoint: 4,
          }
        );

        // Setup event forwarding
        this.orchestrationFacade.onEvent((event) => {
          this.broadcastOrchestratorEvent(event);
        });

        console.log('[DurableAgent] Orchestration facade initialized');
      }

      // 5. Ensure session exists in D1
      if (this.sessionId && this.sessionManager && this.d1) {
        try {
          await this.sessionManager.getOrCreateSession(this.sessionId);
          
          // Hydrate from D1 if durable storage is empty
          if (this.storage.getMessages().length === 0) {
            await this.loadFromD1(this.sessionId);
          }
        } catch (e) {
          console.warn('[DurableAgent] D1 hydration skipped:', e);
        }
      }

      console.log('[DurableAgent] ✅ Initialization complete');
    });
  }

  // =============================================================
  // Board Storage Implementation (for Orchestrator)
  // =============================================================

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

  // =============================================================
  // HTTP Fetch Handler (Entry Point)
  // =============================================================

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Extract session ID from query or header
    if (!this.sessionId) {
      const fromHeader = request.headers.get('X-Session-ID');
      const fromQuery = url.searchParams.get('session_id');
      if (fromHeader || fromQuery) {
        this.sessionId = fromHeader || fromQuery || undefined;
      }
    }

    // Handle WebSocket upgrade
    if (
      request.headers.get('Upgrade')?.toLowerCase() === 'websocket' && 
      url.pathname === '/api/ws'
    ) {
      await this.init();
      return this.handleWebSocketUpgrade(request);
    }

    // Initialize for HTTP requests
    await this.init();
    const pathname = url.pathname;

    try {
      // Route to appropriate handler
      switch (pathname) {
        case '/api/chat':
          if (request.method === 'POST') {
            return await this.handleChatRequest(request);
          }
          break;

        case '/api/tasks/status':
          if (request.method === 'GET') {
            return await this.handleTaskStatusRequest();
          }
          break;

        case '/api/tasks/resume':
          if (request.method === 'POST') {
            return await this.handleTaskResumeRequest(request);
          }
          break;

        case '/api/tasks/abandon':
          if (request.method === 'POST') {
            return await this.handleTaskAbandonRequest();
          }
          break;

        case '/api/history':
          if (request.method === 'GET') {
            return await this.handleHistoryRequest();
          }
          break;

        case '/api/clear':
          if (request.method === 'POST') {
            return await this.handleClearRequest();
          }
          break;

        case '/api/status':
          if (request.method === 'GET') {
            return await this.handleStatusRequest();
          }
          break;

        case '/api/sync':
          if (request.method === 'POST') {
            return await this.handleSyncRequest();
          }
          break;

        case '/api/memory/search':
          if (request.method === 'POST') {
            return await this.handleMemorySearchRequest(request);
          }
          break;

        case '/api/memory/stats':
          if (request.method === 'GET') {
            return await this.handleMemoryStatsRequest();
          }
          break;

        case '/api/memory/summarize':
          if (request.method === 'POST') {
            return await this.handleMemorySummarizeRequest();
          }
          break;
      }

      return new Response('Not Found', { status: 404 });
    } catch (err: any) {
      console.error('[DurableAgent] fetch error:', err);
      return this.jsonResponse(
        { error: err?.message || String(err) }, 
        500
      );
    }
  }

  // =============================================================
  // HTTP Request Handlers
  // =============================================================

  private async handleChatRequest(request: Request): Promise<Response> {
    const body = await request.json() as { message: string };
    const message = body.message?.trim();
    
    if (!message) {
      return this.jsonResponse({ error: 'Missing message' }, 400);
    }

    const result = await this.processMessage(message);
    return this.jsonResponse({ response: result });
  }

  private async handleTaskStatusRequest(): Promise<Response> {
    if (!this.orchestrationFacade) {
      return this.jsonResponse({ hasActiveBoard: false });
    }
    
    const status = await this.orchestrationFacade.getStatus();
    return this.jsonResponse(status);
  }

  private async handleTaskResumeRequest(request: Request): Promise<Response> {
    const body = await request.json() as { feedback: string; approved?: boolean };
    
    if (!this.orchestrationFacade) {
      return this.jsonResponse({ error: 'Orchestrator not initialized' }, 400);
    }

    const result = await this.orchestrationFacade.resumeFromCheckpoint(
      body.feedback,
      body.approved ?? true
    );

    return this.jsonResponse({
      status: result.type,
      response: result.response,
      requiresInput: result.requiresUserInput,
    });
  }

  private async handleTaskAbandonRequest(): Promise<Response> {
    if (this.orchestrationFacade) {
      await this.orchestrationFacade.abandon();
    }
    return this.jsonResponse({ ok: true });
  }

  private async handleHistoryRequest(): Promise<Response> {
    const messages = this.storage.getMessages();
    return this.jsonResponse({ messages });
  }

  private async handleClearRequest(): Promise<Response> {
    await this.storage.clearAll();
    
    if (this.memory) {
      await this.memory.clearSessionMemory();
    }
    
    return this.jsonResponse({ ok: true });
  }

  private async handleStatusRequest(): Promise<Response> {
    const storageStatus = this.storage.getStatus();
    const config = this.agent.getConfig();

    const status = {
      ...storageStatus,
      agentConfig: {
        model: config.model,
        maxTurns: this.maxTurns,
        useSearch: config.useSearch,
        useCodeExecution: config.useCodeExecution,
      },
      d1Status: {
        enabled: !!this.d1,
        sessionId: this.sessionId || null,
      },
      memoryStatus: {
        enabled: !!this.memory,
        vectorizeAvailable: !!this.env.VECTORIZE,
      },
      orchestrationStatus: this.orchestrationFacade 
        ? await this.orchestrationFacade.getStatus()
        : { enabled: false },
      metrics: this.metrics,
      storageCoordinatorMetrics: this.storageCoordinator?.getMetrics(),
    };

    return this.jsonResponse(status);
  }

  private async handleSyncRequest(): Promise<Response> {
    if (this.storageCoordinator) {
      await this.storageCoordinator.flush();
    }
    return this.jsonResponse({ ok: true, sessionId: this.sessionId });
  }

  private async handleMemorySearchRequest(request: Request): Promise<Response> {
    if (!this.memory) {
      return this.jsonResponse({ error: 'Memory not available' }, 400);
    }

    const body = await request.json() as { query: string; topK?: number };
    const results = await this.memory.searchMemory(body.query, {
      topK: body.topK || 10,
    });

    return this.jsonResponse({ results });
  }

  private async handleMemoryStatsRequest(): Promise<Response> {
    if (!this.memory) {
      return this.jsonResponse({ error: 'Memory not available' }, 400);
    }

    const stats = await this.memory.getMemoryStats();
    return this.jsonResponse(stats);
  }

  private async handleMemorySummarizeRequest(): Promise<Response> {
    if (!this.memory) {
      return this.jsonResponse({ error: 'Memory not available' }, 400);
    }

    const history = this.storage.getMessages();
    const messages = history.map((m) => ({
      role: m.role,
      content: m.parts?.map((p) => (typeof p === 'string' ? p : p.text)).join(' ') || '',
    }));

    const summary = await this.memory.summarizeConversation(messages);
    const topics = await this.memory.extractImportantTopics(summary);

    return this.jsonResponse({ summary, topics });
  }

  // =============================================================
  // WebSocket Handling
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
      void this.handleWebSocketMessage(server, evt.data).catch((err) => {
        console.error('[DurableAgent] WS message error:', err);
        this.sendToSocket(server, { type: 'error', error: String(err) });
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

    // Send session context on connect
    this.sendSessionGreeting(server);

    return new Response(null, { status: 101, webSocket: client });
  }

  private async sendSessionGreeting(ws: WebSocket): Promise<void> {
    if (!this.orchestrationFacade) return;

    try {
      const context = await this.orchestrationFacade.getStatus();
      this.sendToSocket(ws, {
        type: 'session_context',
        context,
      });
    } catch (e) {
      console.error('[DurableAgent] Failed to send session greeting:', e);
    }
  }

  private async handleWebSocketMessage(ws: WebSocket, data: string | ArrayBuffer): Promise<void> {
    if (typeof data !== 'string' || ws.readyState !== WebSocket.OPEN) return;

    let message: WebSocketMessage;
    try {
      message = JSON.parse(data);
    } catch {
      this.sendToSocket(ws, { type: 'error', error: 'Invalid JSON' });
      return;
    }

    // Route based on message type
    switch (message.type) {
      case 'user_message':
        if (!message.content) {
          this.sendToSocket(ws, { type: 'error', error: 'Missing content' });
          return;
        }
        await this.processWebSocketMessage(message.content, ws);
        break;

      case 'checkpoint_response':
        if (!message.feedback) {
          this.sendToSocket(ws, { type: 'error', error: 'Missing feedback' });
          return;
        }
        await this.handleCheckpointResponse(ws, message.feedback, message.approved ?? true);
        break;

      case 'abandon_task':
        if (this.orchestrationFacade) {
          await this.orchestrationFacade.abandon();
          this.sendToSocket(ws, { type: 'status', message: 'Task abandoned' });
        }
        break;

      case 'get_status':
        if (this.orchestrationFacade) {
          const status = await this.orchestrationFacade.getStatus();
          this.sendToSocket(ws, { type: 'status', ...status });
        }
        break;

      default:
        this.sendToSocket(ws, { type: 'error', error: 'Unknown message type' });
    }
  }

  private async processWebSocketMessage(
    userMessage: string,
    ws: WebSocket
  ): Promise<void> {
    const startTime = Date.now();
    this.metrics.totalRequests++;

    try {
      // Save user message
      await this.saveUserMessage(userMessage);

      // Get conversation history and memory context
      const history = this.storage.getMessages();
      const memoryContext = await this.buildMemoryContext(userMessage);

      // Use orchestration facade to decide execution path
      if (this.orchestrationFacade) {
        const result = await this.orchestrationFacade.execute(
          userMessage,
          history,
          memoryContext
        );

        if (result.type === 'simple') {
          // Execute simple ReAct loop
          this.metrics.totalSimpleQueries++;
          const response = await this.executeSimpleQuery(
            userMessage,
            history,
            memoryContext,
            ws
          );
          await this.saveModelMessage(response);
          this.sendToSocket(ws, { type: 'complete', response });
        } else {
          // Orchestration handled it
          this.metrics.totalOrchestrated++;
          
          if (result.requiresUserInput) {
            this.sendToSocket(ws, {
              type: 'checkpoint',
              message: result.response,
              checkpointMessage: result.checkpointMessage,
            });
          } else {
            await this.saveModelMessage(result.response);
            this.sendToSocket(ws, { type: 'complete', response: result.response });
          }
        }
      } else {
        // Fallback to simple execution if no orchestration
        const response = await this.executeSimpleQuery(
          userMessage,
          history,
          memoryContext,
          ws
        );
        await this.saveModelMessage(response);
        this.sendToSocket(ws, { type: 'complete', response });
      }

      // Update metrics
      const responseTime = Date.now() - startTime;
      this.metrics.avgResponseTime =
        (this.metrics.avgResponseTime * (this.metrics.totalRequests - 1) + responseTime) /
        this.metrics.totalRequests;
    } catch (error) {
      console.error('[DurableAgent] Message processing error:', error);
      this.sendToSocket(ws, {
        type: 'error',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async handleCheckpointResponse(
    ws: WebSocket,
    feedback: string,
    approved: boolean
  ): Promise<void> {
    if (!this.orchestrationFacade) {
      this.sendToSocket(ws, { type: 'error', error: 'Orchestrator not available' });
      return;
    }

    const result = await this.orchestrationFacade.resumeFromCheckpoint(feedback, approved);

    if (result.requiresUserInput) {
      this.sendToSocket(ws, {
        type: 'checkpoint',
        message: result.response,
        checkpointMessage: result.checkpointMessage,
      });
    } else {
      await this.saveModelMessage(result.response);
      this.sendToSocket(ws, { type: 'complete', response: result.response });
    }
  }

  // =============================================================
  // Message Processing Logic
  // =============================================================

  private async processMessage(userMessage: string): Promise<string> {
    await this.saveUserMessage(userMessage);

    const history = this.storage.getMessages();
    const memoryContext = await this.buildMemoryContext(userMessage);

    // Check for cached response
    const cached = await this.checkCachedResponse(userMessage);
    if (cached.useCached && cached.response) {
      await this.saveModelMessage(cached.response);
      return cached.response;
    }

    // Execute with orchestration decision
    if (this.orchestrationFacade) {
      const result = await this.orchestrationFacade.execute(
        userMessage,
        history,
        memoryContext
      );

      if (result.type === 'simple') {
        return await this.executeSimpleQuery(userMessage, history, memoryContext, null);
      } else {
        return result.response;
      }
    }

    // Fallback to simple execution
    return await this.executeSimpleQuery(userMessage, history, memoryContext, null);
  }

  private async executeSimpleQuery(
    userMessage: string,
    history: Message[],
    memoryContext: string,
    ws: WebSocket | null
  ): Promise<string> {
    return await this.storage.withTransaction(async (state) => {
      state.lastActivityAt = Date.now();

      // Build system prompt and format history
      const systemPrompt = this.agent.buildSystemPrompt(state, memoryContext);
      const formattedHistory = this.agent.formatHistory(
        history,
        systemPrompt,
        userMessage
      );

      // Execute ReAct loop
      const response = await this.executeReactLoop(
        formattedHistory,
        state,
        {
          onChunk: (chunk) => ws && this.sendToSocket(ws, { type: 'chunk', content: chunk }),
          onStatus: (status) => ws && this.sendToSocket(ws, { type: 'status', message: status }),
          onToolUse: (tools) => ws && this.sendToSocket(ws, { type: 'tool_use', tools }),
        }
      );

      // Create LTM if needed
      await this.maybeCreateLTM(history, userMessage, response);

      return response;
    });
  }

  private async executeReactLoop(
    formattedHistory: any[],
    state: any,
    callbacks: StepCallbacks
  ): Promise<string> {
    let fullResponse = '';
    let turn = 0;

    while (turn < this.maxTurns) {
      turn++;
      callbacks.onStatus?.(`Turn ${turn}/${this.maxTurns}`);

      // Execute single step
      const step = await this.agent.executeStep(formattedHistory, state, callbacks);
      fullResponse += step.text;

      // Check if completed
      if (step.completed) {
        console.log(`[ReAct] Completed in ${turn} turns`);
        break;
      }

      // Execute tools
      callbacks.onToolUse?.(step.toolCalls.map((t) => t.name));
      const toolResults = await this.agent.executeTools(step.toolCalls, state);
      const observationText = this.agent.formatToolResults(toolResults);

      // Add to history
      formattedHistory.push({
        role: 'assistant',
        content: step.text,
        toolCalls: step.toolCalls,
      });
      formattedHistory.push({
        role: 'user',
        content: observationText,
      });
    }

    if (turn >= this.maxTurns) {
      console.warn('[ReAct] Max turns reached');
    }

    return fullResponse;
  }

  // =============================================================
  // Message Persistence (Using Storage Coordinator)
  // =============================================================

  private async saveUserMessage(content: string): Promise<void> {
    const message: Message = {
      role: 'user',
      parts: [{ text: content }],
      timestamp: Date.now(),
    };

    if (this.storageCoordinator) {
      await this.storageCoordinator.saveMessage(message);
    } else {
      // Fallback
      await this.storage.saveMessage('user', message.parts, message.timestamp);
    }
  }

  private async saveModelMessage(content: string): Promise<void> {
    const message: Message = {
      role: 'model',
      parts: [{ text: content }],
      timestamp: Date.now(),
    };

    if (this.storageCoordinator) {
      await this.storageCoordinator.saveMessage(message);
    } else {
      // Fallback
      await this.storage.saveMessage('model', message.parts, message.timestamp);
    }
  }

  // =============================================================
  // Memory Helpers
  // =============================================================

  private async buildMemoryContext(query: string): Promise<string> {
    if (!this.memory) return '';

    try {
      const result = await this.memory.buildEnhancedContext(query, undefined, {
        includeSTM: true,
        includeLTM: true,
        maxSTMResults: 5,
        maxLTMResults: 3,
      });
      return result.context;
    } catch (error) {
      console.error('[DurableAgent] Memory context building failed:', error);
      return '';
    }
  }

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
            ...ltmResults[0].metadata,
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

  private async maybeCreateLTM(
    history: Message[],
    lastQuery: string,
    lastResponse: string
  ): Promise<void> {
    if (!this.memory || !this.sessionId) return;
    if (history.length === 0 || history.length % 15 !== 0) return;

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

      console.log('[DurableAgent] Created LTM summary');
    } catch (error) {
      console.error('[DurableAgent] Failed to create LTM:', error);
    }
  }

  private calculateImportance(summary: string, topics: string[]): number {
    let score = 0.5;

    if (summary.length > 500) score += 0.2;
    else if (summary.length > 200) score += 0.1;

    score += Math.min(topics.length * 0.05, 0.2);

    const importantKeywords = [
      'error', 'bug', 'fix', 'solution', 'problem', 'deploy',
      'production', 'critical', 'important', 'api', 'database',
    ];

    const lowerSummary = summary.toLowerCase();
    const keywordMatches = importantKeywords.filter((kw) => lowerSummary.includes(kw)).length;
    score += Math.min(keywordMatches * 0.05, 0.15);

    return Math.min(Math.max(score, 0.5), 1.0);
  }

  // =============================================================
  // D1 Helpers
  // =============================================================

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

  // =============================================================
  // WebSocket Broadcasting
  // =============================================================

  private broadcastOrchestratorEvent(event: OrchestratorEvent): void {
    const message = this.mapOrchestratorEventToWSMessage(event);
    if (message) {
      this.broadcast(message);
    }
  }

  private mapOrchestratorEventToWSMessage(
    event: OrchestratorEvent
  ): WebSocketResponse | null {
    switch (event.type) {
      case 'plan_created':
        return {
          type: 'plan_created',
          taskCount: event.board.tasks.length,
          checkpoints: event.board.totalCheckpoints,
          summary: `Created plan with ${event.board.tasks.length} tasks`,
        };

      case 'task_started':
        return {
          type: 'task_progress',
          message: `[${event.index + 1}/${event.total}] Starting: ${event.task.name}`,
          taskId: event.task.id,
        };

      case 'task_progress':
        return {
          type: 'task_progress',
          message: event.message,
          taskId: event.taskId,
        };

      case 'task_completed':
        return {
          type: 'task_completed',
          taskId: event.task.id,
          taskName: event.task.name,
          preview: event.result.substring(0, 200) + (event.result.length > 200 ? '...' : ''),
        };

      case 'task_failed':
        return {
          type: 'status',
          message: `Task failed: ${event.error}${event.willRetry ? ' (will retry)' : ''}`,
        };

      case 'checkpoint_reached':
        return {
          type: 'checkpoint',
          message: event.message,
          task: event.task,
        };

      case 'replan_triggered':
        return {
          type: 'status',
          message: `Replanning: ${event.reason}`,
        };

      case 'board_completed':
        return {
          type: 'status',
          message: 'All tasks completed successfully!',
        };

      case 'board_failed':
        return {
          type: 'error',
          error: `Board failed: ${event.reason}`,
        };

      default:
        return null;
    }
  }

  private broadcast(message: WebSocketResponse): void {
    const data = JSON.stringify(message);
    for (const socket of this.activeSockets) {
      if (socket.readyState === WebSocket.OPEN) {
        try {
          socket.send(data);
        } catch (e) {
          console.error('[DurableAgent] Broadcast error:', e);
        }
      }
    }
  }

  private sendToSocket(ws: WebSocket, message: WebSocketResponse): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify(message));
    } catch (e) {
      console.error('[DurableAgent] Send error:', e);
    }
  }

  // =============================================================
  // Utility Methods
  // =============================================================

  private jsonResponse(data: any, status: number = 200): Response {
    return new Response(JSON.stringify(data), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // =============================================================
  // RPC Methods (for Worker to DO calls)
  // =============================================================

  public async handleChat(message: string): Promise<{ response: string }> {
    await this.init();
    const response = await this.processMessage(message);
    return { response };
  }

  public async getHistory(): Promise<{ messages: Message[] }> {
    await this.init();
    return { messages: this.storage.getMessages() };
  }

  public async clearHistory(): Promise<{ ok: boolean }> {
    await this.init();
    await this.storage.clearAll();
    
    if (this.memory) {
      await this.memory.clearSessionMemory();
    }
    
    return { ok: true };
  }

  public async getStatus(): Promise<object> {
    await this.init();
    
    const storageStatus = this.storage.getStatus();
    const config = this.agent.getConfig();

    return {
      ...storageStatus,
      agentConfig: {
        model: config.model,
        maxTurns: this.maxTurns,
        useSearch: config.useSearch,
        useCodeExecution: config.useCodeExecution,
      },
      d1Status: {
        enabled: !!this.d1,
        sessionId: this.sessionId || null,
      },
      memoryStatus: {
        enabled: !!this.memory,
        vectorizeAvailable: !!this.env.VECTORIZE,
      },
      orchestrationStatus: this.orchestrationFacade
        ? await this.orchestrationFacade.getStatus()
        : { enabled: false },
      metrics: this.metrics,
      storageCoordinatorMetrics: this.storageCoordinator?.getMetrics(),
    };
  }

  public async syncToD1(): Promise<object> {
    await this.init();
    
    if (this.storageCoordinator) {
      await this.storageCoordinator.flush();
    }
    
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

  // =============================================================
  // Lifecycle Methods
  // =============================================================

  async alarm(): Promise<void> {
    // Periodic maintenance tasks
    console.log('[DurableAgent] Alarm triggered - running maintenance');

    // Flush pending storage writes
    if (this.storageCoordinator) {
      await this.storageCoordinator.flush();
    }

    // Clean up old sessions (if needed)
    // Schedule next alarm
    const nextAlarm = Date.now() + 3600000; // 1 hour
    await this.storage.setAlarm(nextAlarm);
  }
}

export default AutonomousAgent;
