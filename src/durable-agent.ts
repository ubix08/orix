// src/durable-agent.ts - Enhanced with V2 Orchestration
import type { DurableObjectState } from '@cloudflare/workers-types';
import type { Env, Message } from './types';
import { Agent } from './agent-core';
import { DurableStorage } from './durable-storage';
import { GeminiClient } from './gemini';
import { D1Manager } from './storage/d1-manager';
import { MemoryManager } from './memory/memory-manager';
import type { AgentConfig } from './agent-core';
import type { ToolCall, ToolResult } from './tools/types';

export class AutonomousAgent {
  private storage: DurableStorage;
  private agent: Agent;
  private gemini: GeminiClient;
  private env: Env;
  private activeSockets = new Set<WebSocket>();
  private d1?: D1Manager;
  private memory?: MemoryManager;
  private sessionId?: string;
  private pendingFlush: Message[] = [];
  private flushScheduled = false;
  private memoryEnabled = true;
  private initialized = false;
  
  // NEW: Feature flag for V2 orchestration
  private useV2Orchestration: boolean;

  constructor(state: DurableObjectState, env: Env) {
    this.env = env;
    this.storage = new DurableStorage(state);
    this.gemini = new GeminiClient({ apiKey: env.GEMINI_API_KEY });

    // NEW: Read feature flag from environment
    this.useV2Orchestration = env.ENABLE_V2_ORCHESTRATION === 'true';

    if (env.DB) {
      this.d1 = new D1Manager(env.DB);
      console.log('[DurableAgent] D1 persistence enabled');
    }

    const config: AgentConfig = {
      maxHistoryMessages: 200,
      maxMessageSize: 100_000,
      maxTurns: 2,
      model: 'gemini-2.5-flash',
      thinkingBudget: 1024,
      temperature: 0.7,
      useSearch: true,
      useCodeExecution: true,
      useMapsGrounding: false,
      useVision: false,
      useV2Orchestration: this.useV2Orchestration,
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
      
      // Set memory in agent
      this.agent.setMemory(this.memory);
      console.log('[DurableAgent] Memory system initialized');
    }

    // If session ID provided and DO memory empty, hydrate from D1
    if (this.sessionId && this.d1 && this.storage.getMessages().length === 0) {
      await this.loadFromD1(this.sessionId);
    }

    this.initialized = true;
  }

  // Fetch handler now only for WebSocket upgrade
  async fetch(request: Request): Promise<Response> {
    await this.init();
    const url = new URL(request.url);

    // WebSocket upgrade
    if (url.pathname === '/api/ws' && request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
      return this.handleWebSocketUpgrade(request);
    }

    return new Response('Not Found', { status: 404 });
  }

  // =============================================================
  // 🔥 NEW V2: RPC Method with Orchestration
  // =============================================================

  public async handleChat(message: string): Promise<{ response: string }> {
    await this.init();
    
    if (this.useV2Orchestration) {
      console.log('[DurableAgent] Using V2 orchestration');
      const finalResponse = await this.processMessageV2(message, null);
      return { response: finalResponse };
    } else {
      console.log('[DurableAgent] Using V1 orchestration (legacy)');
      const finalResponse = await this.processMessageV1(message);
      return { response: finalResponse };
    }
  }

  // =============================================================
  // ✨ NEW V2: DO-Based Multi-Turn Orchestration
  // =============================================================

  private async processMessageV2(
    userMsg: string,
    ws: WebSocket | null
  ): Promise<string> {
    return this.storage.withTransaction(async (state) => {
      state.lastActivityAt = Date.now();

      // 1. Save user message
      await this.storage.saveMessage('user', [{ text: userMsg }]);
      const userRecord: Message = {
        role: 'user',
        parts: [{ text: userMsg }],
        timestamp: Date.now(),
      };
      this.pendingFlush.push(userRecord);

      // 2. Save to vector memory
      if (this.memory) {
        await this.saveToMemory('user', userMsg);
      }

      // 3. Build memory context once at start
      let memoryContext = '';
      let cachedResponse: string | null = null;
      
      if (this.memory) {
        ws && this.send(ws, { 
          type: 'status', 
          message: 'Searching memory for relevant context...' 
        });
        
        try {
          const memoryResult = await this.memory.buildEnhancedContext(userMsg, undefined, {
            includeSTM: true,
            includeLTM: true,
            maxSTMResults: 5,
            maxLTMResults: 3,
          });
          
          memoryContext = memoryResult.context;
          
          // Check for high-similarity cached response (>90%)
          if (memoryResult.hasHighSimilarity) {
            const ltmResults = await this.memory.searchLongTermMemory(userMsg, 1);
            if (ltmResults.length > 0 && ltmResults[0].score >= 0.9) {
              cachedResponse = ltmResults[0].metadata?.answer;
              if (cachedResponse) {
                ws && this.send(ws, {
                  type: 'status',
                  message: `Found highly similar past query (${(ltmResults[0].score * 100).toFixed(1)}% match)`,
                });
              }
            }
          }
        } catch (error) {
          console.error('[DurableAgent] Memory context building failed:', error);
        }
      }

      // 4. Early exit for cached responses
      if (cachedResponse) {
        const response = `[Based on similar past query]\n\n${cachedResponse}`;
        
        // Stream cached response
        if (ws) {
          const words = response.split(' ');
          for (const word of words) {
            this.send(ws, { type: 'chunk', content: word + ' ' });
            await new Promise(r => setTimeout(r, 10));
          }
        }

        // Save and flush
        await this.storage.saveMessage('model', [{ text: response }]);
        this.pendingFlush.push({
          role: 'model',
          parts: [{ text: response }],
          timestamp: Date.now(),
        });
        await this.flushPendingToD1();
        
        // Update LTM stats
        if (this.memory) {
          const ltmResults = await this.memory.searchLongTermMemory(userMsg, 1);
          if (ltmResults[0]?.metadata?.id) {
            await this.memory.updateLongTermMemory({
              ...ltmResults[0].metadata,
              lastAccessed: Date.now(),
              interactions: (ltmResults[0].metadata.interactions || 0) + 1,
            });
          }
        }

        ws && this.send(ws, { type: 'complete', response });
        return response;
      }

      // 5. Multi-turn orchestration loop
      let fullResponse = '';
      let completed = false;
      let turnCount = 0;
      const MAX_TURNS = this.agent.getConfig().maxTurns;

      while (!completed && turnCount < MAX_TURNS) {
        turnCount++;
        ws && this.send(ws, {
          type: 'status',
          message: `Turn ${turnCount}/${MAX_TURNS} | Reasoning...`,
        });

        // 5a. Get fresh conversation history
        const history = this.storage.getMessages();

        // 5b. Execute single reasoning step via Agent
        try {
          const step = await this.agent.run_step_v2(history, {
            memoryContext,
            model: this.agent.getConfig().model,
            temperature: this.agent.getConfig().temperature,
            files: state.context?.files ?? [],
            onChunk: (chunk) => {
              fullResponse += chunk;
              ws && this.send(ws, { type: 'chunk', content: chunk });
            },
            onStatus: (status) => {
              ws && this.send(ws, { type: 'status', message: status });
            },
          });

          // 5c. Save assistant message immediately (per-turn checkpointing)
          await this.storage.saveMessage('model', [{ text: step.text }]);
          const modelRecord: Message = {
            role: 'model',
            parts: [{ text: step.text }],
            timestamp: Date.now(),
          };
          this.pendingFlush.push(modelRecord);

          // 5d. Save to memory
          if (this.memory) {
            await this.saveToMemory('model', step.text);
          }

          // 5e. Handle tool calls
          if (step.toolCalls && step.toolCalls.length > 0) {
            ws && this.send(ws, {
              type: 'tool_use',
              tools: step.toolCalls.map(t => t.name),
            });

            // Execute tools with proper state
            const results = await this.executeToolsV2(step.toolCalls, state);

            // Format and save observations
            const observations = this.formatToolResults(results);
            await this.storage.saveMessage('user', [{ text: observations }]);
            
            const observationRecord: Message = {
              role: 'user',
              parts: [{ text: observations }],
              timestamp: Date.now(),
            };
            this.pendingFlush.push(observationRecord);

            // Save observations to memory
            if (this.memory) {
              await this.saveToMemory('model', observations);
            }

            // Continue to next turn
            completed = false;
          } else {
            // No tool calls = agent is done
            completed = true;
          }

          // 5f. Flush to D1 after each turn (crash recovery)
          await this.flushPendingToD1();

        } catch (error) {
          console.error('[DurableAgent] Turn error:', error);
          ws && this.send(ws, { type: 'error', error: String(error) });
          throw error;
        }
      }

      // 6. Post-conversation tasks
      if (!completed) {
        ws && this.send(ws, {
          type: 'status',
          message: 'Max turns reached - providing partial response',
        });
      }

      // 7. Create LTM summary if significant session
      const history = this.storage.getMessages();
      if (this.memory && history.length > 0 && history.length % 15 === 0) {
        ws && this.send(ws, {
          type: 'status',
          message: 'Creating long-term memory summary...',
        });
        await this.maybeCreateLTM(history, userMsg, fullResponse);
      }

      ws && this.send(ws, { type: 'complete', response: fullResponse });
      return fullResponse;
    });
  }

  // =============================================================
  // 📜 LEGACY V1: Original Orchestration (Backward Compatible)
  // =============================================================

  private async processMessageV1(userMsg: string): Promise<string> {
    let finalResponse = '';
    await this.storage.withTransaction(async (state) => {
      state.lastActivityAt = Date.now();

      // Save user message to DO memory
      await this.storage.saveMessage('user', [{ text: userMsg }]);
      const messageRecord: Message = {
        role: 'user',
        parts: [{ text: userMsg }],
        timestamp: Date.now(),
      };
      this.pendingFlush.push(messageRecord);

      // Save to vector memory
      if (this.memory) {
        await this.saveToMemory('user', userMsg);
      }

      const history = this.storage.getMessages();

      // Use legacy Agent.run() method
      try {
        const result = await this.agent.run(
          userMsg,
          history,
          state,
          {
            onStatus: (status) => console.log('[ProcessV1] ', status),
            onToolUse: (tools) => console.log('[ProcessV1] Tool use:', tools),
          }
        );
        
        finalResponse = result.response;

        if (result.completed) {
          await this.storage.saveMessage('model', [{ text: finalResponse }]);
          const modelRecord: Message = {
            role: 'model',
            parts: [{ text: finalResponse }],
            timestamp: Date.now(),
          };
          this.pendingFlush.push(modelRecord);

          // Save assistant response to memory
          if (this.memory) {
            await this.saveToMemory('model', finalResponse);
          }

          await this.flushPendingToD1();

          // Create long-term memory summary if session is significant
          if (this.memory && history.length > 0 && history.length % 15 === 0) {
            await this.maybeCreateLTM(history, userMsg, finalResponse);
          }
        }
      } catch (err) {
        console.error('[DurableAgent] processMessageV1 error:', err);
        throw err;
      }
    });

    return finalResponse;
  }

  // =============================================================
  // 🔧 V2 Helper Methods
  // =============================================================

  /**
   * V2: Tool execution with proper state access
   */
  private async executeToolsV2(
    toolCalls: ToolCall[],
    state: any
  ): Promise<ToolResult[]> {
    const settled = await Promise.allSettled(
      toolCalls.map(async (call) => {
        try {
          // Get tool registry from agent
          const tools = this.agent.getRegisteredTools();
          const tool = tools.find(t => t.name === call.name);
          
          if (!tool) {
            return {
              name: call.name,
              success: false,
              result: `Tool '${call.name}' not found`,
            } as ToolResult;
          }

          // Execute with full state context
          return await tool.execute(call.args, {
            ...state,
            sessionId: this.sessionId,
            memory: this.memory,
          });
        } catch (e) {
          return {
            name: call.name,
            success: false,
            result: `Execution failed: ${String(e)}`,
          } as ToolResult;
        }
      })
    );

    return settled
      .filter((r): r is PromiseFulfilledResult<ToolResult> => r.status === 'fulfilled')
      .map(r => r.value);
  }

  /**
   * Format tool results for conversation history
   */
  private formatToolResults(results: ToolResult[]): string {
    return results
      .map(r => `[Observation: ${r.name}] ${r.success ? '✅ Success' : '❌ Failed'}\n${r.result}`)
      .join('\n\n');
  }

  // =============================================================
  // 🔌 RPC Methods (Same for Both V1 and V2)
  // =============================================================

  public async getHistory(): Promise<{ messages: Message[] }> {
    await this.init();
    return { messages: this.storage.getMessages() };
  }

  public async clearHistory(): Promise<{ ok: boolean }> {
    await this.init();
    await this.storage.clearAll();
    
    // Clear memory as well
    if (this.memory) {
      await this.memory.clearSessionMemory();
    }
    
    this.pendingFlush = [];
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
        maxTurns: config.maxTurns,
        useSearch: config.useSearch,
        useCodeExecution: config.useCodeExecution,
        orchestrationVersion: this.useV2Orchestration ? 'V2' : 'V1 (Legacy)',
      },
      circuitBreaker: circuit,
      d1Status: {
        enabled: !!this.d1,
        sessionId: this.sessionId || null,
        pendingFlush: this.pendingFlush.length,
      },
      memoryStatus: {
        enabled: !!this.memory,
        vectorizeAvailable: !!this.env.VECTORIZE,
      },
    };
  }

  public async syncToD1(): Promise<object> {
    await this.init();
    if (!this.d1 || !this.sessionId) {
      throw new Error('D1 not configured or no session ID');
    }

    const localMessages = this.storage.getMessages();
    const latestRemoteTs = await this.d1.getLatestMessageTimestamp(this.sessionId);
    const toSync = localMessages.filter(m => (m.timestamp ?? 0) > (latestRemoteTs ?? 0));
    await this.d1.saveMessages(this.sessionId, toSync);

    return { ok: true, synced: toSync.length, sessionId: this.sessionId };
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

    const stats = await this.memory.getMemoryStats();
    return stats;
  }

  public async summarizeSession(): Promise<{ summary: string; topics: string[] }> {
    await this.init();
    if (!this.memory) {
      throw new Error('Memory system not available');
    }

    const history = this.storage.getMessages();
    const messages = history.map(m => ({
      role: m.role,
      content: m.parts?.map(p => (typeof p === 'string' ? p : p.text)).join(' ') || '',
    }));

    const summary = await this.memory.summarizeConversation(messages);
    const topics = await this.memory.extractImportantTopics(summary);

    return { summary, topics };
  }

  // =============================================================
  // 🌐 WebSocket Handler (Works with Both V1 and V2)
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

  private async processWebSocketMessage(userMsg: string, ws: WebSocket): Promise<void> {
    if (this.useV2Orchestration) {
      await this.processMessageV2(userMsg, ws);
    } else {
      // For V1, we still need to implement WS streaming
      // For now, fallback to basic implementation
      const response = await this.processMessageV1(userMsg);
      this.send(ws, { type: 'complete', response });
    }
  }

  // =============================================================
  // 🧠 Memory Helper Methods (Shared)
  // =============================================================

  private async saveToMemory(role: 'user' | 'model', content: string): Promise<void> {
    if (!this.memory || !this.sessionId) return;

    try {
      await this.memory.saveMemory({
        id: `${this.sessionId}_${Date.now()}_${role}`,
        content,
        metadata: {
          sessionId: this.sessionId,
          timestamp: Date.now(),
          role,
          importance: role === 'user' ? 0.8 : 0.7,
        },
      });
    } catch (error) {
      console.error('[DurableAgent] Failed to save to memory:', error);
    }
  }

  private async maybeCreateLTM(
    history: Message[],
    lastQuery: string,
    lastResponse: string
  ): Promise<void> {
    if (!this.memory || !this.sessionId) return;

    try {
      const messagesToSummarize = history.slice(-15).map(m => ({
        role: m.role,
        content: m.parts?.map(p => (typeof p === 'string' ? p : p.text)).join(' ') || '',
      }));

      const summary = await this.memory.summarizeConversation(messagesToSummarize);
      const topics = await this.memory.extractImportantTopics(summary);

      const userQueries = messagesToSummarize
        .filter(m => m.role === 'user')
        .map(m => m.content)
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
      'error', 'bug', 'fix', 'solution', 'problem',
      'deploy', 'production', 'critical', 'important',
      'api', 'database', 'configuration', 'setup'
    ];
    
    const lowerSummary = summary.toLowerCase();
    const keywordMatches = importantKeywords.filter(kw => 
      lowerSummary.includes(kw)
    ).length;
    
    score += Math.min(keywordMatches * 0.05, 0.15);
    
    return Math.min(Math.max(score, 0.5), 1.0);
  }

  // =============================================================
  // 💾 D1 Persistence (Shared)
  // =============================================================

  private async flushPendingToD1(): Promise<void> {
    if (!this.d1 || !this.sessionId || this.pendingFlush.length === 0) {
      this.pendingFlush = [];
      return;
    }

    if (this.flushScheduled) return;
    this.flushScheduled = true;

    try {
      await this.d1.saveMessages(this.sessionId, this.pendingFlush);
      console.log(`[DurableAgent] Flushed ${this.pendingFlush.length} messages to D1`);
      this.pendingFlush = [];
      await this.d1.updateSessionActivity(this.sessionId);
    } catch (err) {
      console.error('[DurableAgent] D1 flush failed:', err);
    } finally {
      this.flushScheduled = false;
    }
  }

  private async loadFromD1(sessionId: string): Promise<void> {
    if (!this.d1) return;

    try {
      const session = await this.d1.getSession(sessionId);
      if (!session) {
        await this.d1.createSession(sessionId, 'New Session');
      }

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
  // 📡 Utility Methods
  // =============================================================

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
