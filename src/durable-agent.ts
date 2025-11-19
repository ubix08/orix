// src/durable-agent.ts - Refactored with new architecture
import type { DurableObjectState } from '@cloudflare/workers-types';
import type { Env, Message } from './types';
import { Agent } from './agent-core';
import { DurableStorage } from './durable-storage';
import { GeminiClient } from './gemini';
import { D1Manager } from './storage/d1-manager';
import { MemoryManager } from './memory/memory-manager';
import { MessageService } from './services/message-service';
import { SessionManager } from './session/session-manager';
import type { AgentConfig } from './agent-core';

/**
 * Refactored Durable Agent with improved architecture:
 * - Eliminated message saving duplication (6 instances → 1)
 * - Centralized session management
 * - Separated concerns
 * - Added proper error handling
 * - Improved testability
 */
export class AutonomousAgent {
  private storage: DurableStorage;
  private agent: Agent;
  private gemini: GeminiClient;
  private env: Env;
  private activeSockets = new Set<WebSocket>();
  
  // Centralized services
  private d1?: D1Manager;
  private memory?: MemoryManager;
  private messageService?: MessageService;
  private sessionManager?: SessionManager;
  
  private sessionId?: string;
  private initialized = false;

  constructor(state: DurableObjectState, env: Env) {
    this.env = env;
    this.storage = new DurableStorage(state);
    this.gemini = new GeminiClient({ apiKey: env.GEMINI_API_KEY });

    // Initialize D1 and Session Manager
    if (env.DB) {
      this.d1 = new D1Manager(env.DB);
      this.sessionManager = new SessionManager(env.DB, {
        autoCreate: true,
        ttlDays: 30,
      });
      console.log('[DurableAgent] D1 persistence enabled');
    }

    // Agent configuration
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
    };

    this.agent = new Agent(this.gemini, config);

    // Extract sessionId from Durable Object name
    const name = state.id.name;
    if (name && name.startsWith('session:')) {
      this.sessionId = name.slice(8);
    }
  }

  /**
   * Initialize agent with all services
   * - Sets up memory system
   * - Initializes message service
   * - Hydrates session from D1 if needed
   */
  private async init(): Promise<void> {
    if (this.initialized) return;
    
    if (!this.sessionId) {
      throw new Error('Session ID not found in Durable Object name');
    }

    // 1. Initialize or load session
    if (this.sessionManager) {
      try {
        await this.sessionManager.getOrCreateSession(this.sessionId, 'New Session');
      } catch (error) {
        console.error('[DurableAgent] Failed to initialize session:', error);
        // Continue anyway - session may be created by other means
      }
    }

    // 2. Initialize memory system
    if (this.env.VECTORIZE) {
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

    // 3. Initialize unified message service
    this.messageService = new MessageService(
      this.storage,
      this.sessionId,
      this.memory
    );

    // Set D1 flush handler
    if (this.d1) {
      this.messageService.setD1FlushHandler(async (messages) => {
        await this.d1!.saveMessages(this.sessionId!, messages);
        if (this.sessionManager) {
          await this.sessionManager.touchSession(this.sessionId!);
        }
      });
    }

    // 4. Hydrate from D1 if Durable Object storage is empty
    if (this.d1 && this.storage.getMessages().length === 0) {
      await this.loadFromD1(this.sessionId);
    }

    this.initialized = true;
  }

  // =============================================================
  // HTTP Handler (WebSocket only)
  // =============================================================

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
  // RPC Methods for HTTP endpoints
  // =============================================================

  /**
   * Handle chat via RPC (no WebSocket)
   */
  public async handleChat(message: string): Promise<{ response: string }> {
    await this.init();
    const finalResponse = await this.processMessage(message, null);
    return { response: finalResponse };
  }

  /**
   * Get conversation history
   */
  public async getHistory(): Promise<{ messages: Message[] }> {
    await this.init();
    return { messages: this.messageService!.getMessages() };
  }

  /**
   * Clear conversation history
   */
  public async clearHistory(): Promise<{ ok: boolean }> {
    await this.init();
    await this.messageService!.clear();
    return { ok: true };
  }

  /**
   * Get agent status
   */
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
        note: 'Extended CPU limits configured for longer processing',
      },
      circuitBreaker: circuit,
      cpuLimit: 'Up to 5 minutes per invocation with configuration',
      d1Status: {
        enabled: !!this.d1,
        sessionId: this.sessionId || null,
        pendingFlush: this.messageService?.getPendingCount() || 0,
      },
      memoryStatus: {
        enabled: !!this.memory,
        vectorizeAvailable: !!this.env.VECTORIZE,
      },
    };
  }

  /**
   * Force sync to D1
   */
  public async syncToD1(): Promise<object> {
    await this.init();
    if (!this.messageService) {
      throw new Error('Message service not initialized');
    }

    await this.messageService.flush();
    return { ok: true, sessionId: this.sessionId };
  }

  /**
   * Search memory
   */
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

  /**
   * Get memory statistics
   */
  public async getMemoryStats(): Promise<object> {
    await this.init();
    if (!this.memory) {
      throw new Error('Memory system not available');
    }

    const stats = await this.memory.getMemoryStats();
    return stats;
  }

  /**
   * Summarize session
   */
  public async summarizeSession(): Promise<{ summary: string; topics: string[] }> {
    await this.init();
    if (!this.memory) {
      throw new Error('Memory system not available');
    }

    const history = this.messageService!.getMessages();
    const messages = history.map(m => ({
      role: m.role,
      content: m.parts?.map(p => (typeof p === 'string' ? p : p.text)).join(' ') || '',
    }));

    const summary = await this.memory.summarizeConversation(messages);
    const topics = await this.memory.extractImportantTopics(summary);

    return { summary, topics };
  }

  // =============================================================
  // WebSocket Handling
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
        this.processMessage(userMsg, ws).catch((err) => {
          console.error('[DurableAgent] processMessage failed:', err);
          this.send(ws, { type: 'error', error: 'Processing failed' });
        })
      );
    } catch {
      void this.processMessage(userMsg, ws);
    }
  }

  // =============================================================
  // Core Message Processing (Unified)
  // =============================================================

  /**
   * Process message - unified handler for both WebSocket and RPC
   * 
   * KEY IMPROVEMENT: Single message processing path
   * - Eliminates 6 instances of duplicate message saving
   * - Uses MessageService for all persistence
   * - Consistent memory integration
   * - Proper error handling
   */
  private async processMessage(userMsg: string, ws: WebSocket | null): Promise<string> {
    return this.storage.withTransaction(async (state) => {
      state.lastActivityAt = Date.now();

      // 1. Save user message (unified via MessageService)
      await this.messageService!.saveMessage('user', userMsg, {
        importance: 0.8,
        tags: ['user_input'],
      });

      // 2. Get conversation history
      const history = this.messageService!.getMessages();

      // 3. Check for high-similarity LTM (memory optimization)
      const cachedResponse = await this.checkForCachedResponse(userMsg, ws);
      if (cachedResponse) {
        // Save cached response
        await this.messageService!.saveMessage('model', cachedResponse.response, {
          importance: 0.7,
          tags: ['cached_response'],
        });

        ws && this.send(ws, { type: 'complete', response: cachedResponse.response });
        return cachedResponse.response;
      }

      // 4. Execute agent reasoning loop
      let finalResponse = '';
      let completed = false;
      
      while (!completed) {
        try {
          const result = await this.agent.run(
            userMsg,
            history,
            state,
            {
              onChunk: (chunk) => ws && this.send(ws, { type: 'chunk', content: chunk }),
              onStatus: (status) => ws && this.send(ws, { type: 'status', message: status }),
              onToolUse: (tools) => ws && this.send(ws, { type: 'tool_use', tools }),
              onError: (error) => ws && this.send(ws, { type: 'error', error }),
              onDone: (turns, len) => {
                ws && this.send(ws, { type: 'done', turns, length: len });
              },
            }
          );
          
          finalResponse += result.response;
          completed = result.completed;

          if (completed) {
            // 5. Save model response (unified via MessageService)
            await this.messageService!.saveMessage('model', finalResponse, {
              importance: 0.7,
              tags: ['agent_response'],
            });

            ws && this.send(ws, { type: 'complete', response: finalResponse });

            // 6. Force flush to D1
            await this.messageService!.flush();

            // 7. Create long-term memory summary if needed
            if (this.memory && history.length > 0 && history.length % 15 === 0) {
              ws && this.send(ws, {
                type: 'status',
                message: 'Creating long-term memory summary...',
              });
              await this.createLTMSummary(history, userMsg, finalResponse);
            }
          } else {
            ws && this.send(ws, {
              type: 'continuing',
              message: `Chaining next reasoning step...`,
            });
          }
        } catch (err) {
          console.error('[DurableAgent] processMessage error:', err);
          ws && this.send(ws, { type: 'error', error: String(err) });
          throw err;
        }
      }

      return finalResponse;
    });
  }

  // =============================================================
  // Memory Helper Methods (Refactored)
  // =============================================================

  /**
   * Check for cached response from high-similarity LTM
   * Returns cached response if found, null otherwise
   */
  private async checkForCachedResponse(
    query: string,
    ws: WebSocket | null
  ): Promise<{ response: string } | null> {
    if (!this.memory) return null;

    ws && this.send(ws, { 
      type: 'status', 
      message: 'Searching memory for relevant context...' 
    });

    try {
      const memoryResult = await this.memory.buildEnhancedContext(query, undefined, {
        includeSTM: true,
        includeLTM: true,
        maxSTMResults: 5,
        maxLTMResults: 3,
      });

      // If we found a very similar query (>90%), use cached response
      if (memoryResult.hasHighSimilarity && memoryResult.similarQuery) {
        const ltmResults = await this.memory.searchLongTermMemory(query, 1);
        
        if (ltmResults.length > 0 && ltmResults[0].score >= 0.9) {
          const storedAnswer = ltmResults[0].metadata?.answer;
          
          if (storedAnswer) {
            ws && this.send(ws, {
              type: 'status',
              message: `Found highly similar past query (${(ltmResults[0].score * 100).toFixed(1)}% match) - using optimized response...`,
            });

            // Update LTM access stats
            if (ltmResults[0].metadata?.id) {
              await this.memory.updateLongTermMemory({
                ...ltmResults[0].metadata,
                lastAccessed: Date.now(),
                interactions: (ltmResults[0].metadata.interactions || 0) + 1,
              });
            }

            const response = `[Based on similar past query]\n\n${storedAnswer}`;
            
            // Stream the cached response
            if (ws) {
              const words = response.split(' ');
              for (const word of words) {
                this.send(ws, { type: 'chunk', content: word + ' ' });
                await new Promise(r => setTimeout(r, 10));
              }
            }

            return { response };
          }
        }
      }
    } catch (error) {
      console.error('[DurableAgent] Memory context building failed:', error);
    }

    return null;
  }

  /**
   * Create long-term memory summary
   * Similar to Python's save_ltm after every 15 messages
   */
  private async createLTMSummary(
    history: Message[],
    lastQuery: string,
    lastResponse: string
  ): Promise<void> {
    if (!this.memory || !this.sessionId) return;

    try {
      // Get the last N messages for summarization
      const messagesToSummarize = history.slice(-15).map(m => ({
        role: m.role,
        content: m.parts?.map(p => (typeof p === 'string' ? p : p.text)).join(' ') || '',
      }));

      // Generate summary using Gemini
      const summary = await this.memory.summarizeConversation(messagesToSummarize);
      
      // Extract key topics
      const topics = await this.memory.extractImportantTopics(summary);

      // Extract all user queries from the batch
      const userQueries = messagesToSummarize
        .filter(m => m.role === 'user')
        .map(m => m.content)
        .join(' | ');

      // Create LTM entry
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

  /**
   * Calculate importance score for LTM
   */
  private calculateImportance(summary: string, topics: string[]): number {
    let score = 0.5; // Base score
    
    // Adjust for summary length
    if (summary.length > 500) score += 0.2;
    else if (summary.length > 200) score += 0.1;
    
    // Adjust for topic count
    score += Math.min(topics.length * 0.05, 0.2);
    
    // Check for important keywords
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
    
    // Ensure score is between 0.5 and 1.0
    return Math.min(Math.max(score, 0.5), 1.0);
  }

  // =============================================================
  // Hydration & Utility Methods
  // =============================================================

  /**
   * Load messages from D1 to Durable Object storage
   */
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

      if (this.sessionManager) {
        await this.sessionManager.touchSession(sessionId);
      }
    } catch (err) {
      console.error('[DurableAgent] D1 load failed:', err);
    }
  }

  /**
   * Send message to WebSocket
   */
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
