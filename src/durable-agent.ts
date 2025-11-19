// src/durable-agent.ts - Refactored with ReAct Loop + MessageService
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

export class AutonomousAgent {
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
  private maxTurns = 3;

  constructor(state: DurableObjectState, env: Env) {
    this.env = env;
    this.storage = new DurableStorage(state);
    this.gemini = new GeminiClient({ apiKey: env.GEMINI_API_KEY });

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

    // Extract sessionId from Durable Object name
    const name = state.id.name;
    if (name && name.startsWith('session:')) {
      this.sessionId = name.slice(8);
    }
  }

  private async init(): Promise<void> {
    if (this.initialized) return;

    // Initialize memory if we have session ID and vectorize
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

    // Initialize MessageService
    if (this.sessionId && this.d1) {
      this.messageService = new MessageService(
        this.storage,
        this.sessionId,
        this.memory
      );

      // Set D1 flush handler
      this.messageService.setD1FlushHandler(async (messages: Message[]) => {
        if (this.d1 && this.sessionId) {
          await this.d1.saveMessages(this.sessionId, messages);
          await this.d1.updateSessionActivity(this.sessionId);
        }
      });

      console.log('[DurableAgent] MessageService initialized');
    }

    // Ensure session exists in D1 and hydrate if needed
    if (this.sessionId && this.sessionManager) {
      await this.sessionManager.getOrCreateSession(this.sessionId);

      // Hydrate from D1 if DO storage is empty
      if (this.d1 && this.storage.getMessages().length === 0) {
        await this.loadFromD1(this.sessionId);
      }
    }

    this.initialized = true;
  }

  // =============================================================
  // WebSocket Handler (Fetch)
  // =============================================================

  async fetch(request: Request): Promise<Response> {
    await this.init();
    const url = new URL(request.url);

    // WebSocket upgrade
    if (
      url.pathname === '/api/ws' &&
      request.headers.get('Upgrade')?.toLowerCase() === 'websocket'
    ) {
      return this.handleWebSocketUpgrade(request);
    }

    return new Response('Not Found', { status: 404 });
  }

  // =============================================================
  // RPC Methods for HTTP Endpoints
  // =============================================================

  public async handleChat(message: string): Promise<{ response: string }> {
    await this.init();

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

  // =============================================================
  // ReAct Loop (Moved from Agent)
  // =============================================================

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
    // Build system prompt with memory
    const systemPrompt = this.agent.buildSystemPrompt(state, memoryContext);
    let formattedHistory = this.agent.formatHistory(history, systemPrompt, userMessage);

    let fullResponse = '';
    let turn = 0;

    while (turn < this.maxTurns) {
      turn++;
      callbacks?.onStatus?.(`Turn ${turn}/${this.maxTurns} | Reasoning...`);

      // Execute single step
      const step = await this.agent.executeStep(formattedHistory, state, {
        onChunk: callbacks?.onChunk,
        onStatus: callbacks?.onStatus,
        onError: (error) => console.error('[ReAct] Step error:', error),
      });

      fullResponse += step.text;

      // If completed (no tool calls), we're done
      if (step.completed) {
        console.log(`[ReAct] Completed in ${turn} turns`);
        break;
      }

      // Execute tools
      callbacks?.onToolUse?.(step.toolCalls.map((t) => t.name));
      const toolResults = await this.agent.executeTools(step.toolCalls, state);
      const observationText = this.agent.formatToolResults(toolResults);

      // Append step + observations to history for next turn
      formattedHistory.push({
        role: 'assistant',
        content: step.text,
        toolCalls: step.toolCalls,
      });
      formattedHistory.push({
        role: 'user',
        content: observationText,
      });

      // Continue loop for next reasoning step
      callbacks?.onStatus?.(`Turn ${turn} completed, continuing...`);
    }

    if (turn >= this.maxTurns) {
      console.warn('[ReAct] Max turns reached without completion');
    }

    return fullResponse;
  }

  // =============================================================
  // WebSocket Message Handler
  // =============================================================

  private handleWebSocketUpgrade(request: Request): Response {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];

    try {
      (server as any).accept?.();
    } catch (e) {
      console.error('WebSocket accept error', e);
    }

    server.onmessage = (evt) => {
      void this.webSocketMessage(server, evt.data).catch((err) =>
        console.error('[DurableAgent] WS message error:', err)
      );
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

  private async webSocketMessage(ws: WebSocket, msg: string | ArrayBuffer): Promise<void> {
    if (typeof msg !== 'string' || ws.readyState !== WebSocket.OPEN) return;

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
      this.storage.getDurableObjectState().waitUntil?.(
        this.processWebSocketMessage(userMsg, ws).catch((err) => {
          console.error('[DurableAgent] processWebSocketMessage failed:', err);
          this.send(ws, { type: 'error', error: 'Processing failed' });
        })
      );
    } catch {
      void this.processWebSocketMessage(userMsg, ws);
    }
  }

  private async processWebSocketMessage(userMsg: string, ws: WebSocket | null): Promise<void> {
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
          await new Promise((r) => setTimeout(r, 10));
        }

        await this.messageService!.saveMessage('model', cachedResult.response);
        this.send(ws, { type: 'complete', response: cachedResult.response });
        return;
      }

      // Build memory context
      ws && this.send(ws, { type: 'status', message: 'Searching memory...' });
      const memoryContext = await this.buildMemoryContext(userMsg);

      // Execute ReAct loop with streaming
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

  // =============================================================
  // Memory Helper Methods
  // =============================================================

  private async checkCachedResponse(
    query: string
  ): Promise<{ useCached: boolean; response?: string }> {
    if (!this.memory) return { useCached: false };

    try {
      const ltmResults = await this.memory.searchLongTermMemory(query, 1);

      if (ltmResults.length > 0 && ltmResults[0].score >= 0.9) {
        const storedAnswer = ltmResults[0].metadata?.answer;
        if (storedAnswer) {
          // Update access stats
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

      console.log('[DurableAgent] Created LTM summary with topics:', topics);
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
