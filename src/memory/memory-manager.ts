// ============================================================
// FIXED: memory-manager.ts - Add content to metadata
// ============================================================

async saveMemory(item: MemoryItem): Promise<void> {
  if (!this.vectorize) {
    console.warn('[MemoryManager] Vectorize not available, skipping save');
    return;
  }

  try {
    const embedding = await this.generateEmbedding(item.content);

    // FIX: Store content in metadata so it can be retrieved
    await this.vectorize.upsert([
      {
        id: item.id,
        values: embedding,
        metadata: {
          ...item.metadata,
          type: 'short_term',
          content: item.content, // ← ADD THIS
        },
      },
    ]);

    console.log(`[MemoryManager] Saved memory: ${item.id}`);
  } catch (error) {
    console.error('[MemoryManager] Failed to save memory:', error);
  }
}

// ============================================================
// FIXED: durable-agent.ts - Save every message to memory
// ============================================================

private async processWebSocketMessage(userMsg: string, ws: WebSocket | null): Promise<void> {
  if (!this.messageService) {
    console.warn('[DurableAgent] MessageService not initialized, attempting final init');
    await this.init();
  }

  if (!this.messageService) {
    throw new Error('MessageService not initialized');
  }

  await this.storage.withTransaction(async (state) => {
    state.lastActivityAt = Date.now();

    // Save user message (this will save to memory via MessageService)
    await this.messageService!.saveMessage('user', userMsg);
    
    // FIX: Also explicitly save to memory if MessageService doesn't have memory
    if (this.memory && !this.messageService!['memory']) {
      await this.saveMessageToMemory('user', userMsg);
    }

    // Check for cached response
    const cachedResult = await this.checkCachedResponse(userMsg);
    if (cachedResult.useCached && cachedResult.response) {
      const words = cachedResult.response.split(' ');
      for (const word of words) {
        this.send(ws, { type: 'chunk', content: word + ' ' });
        await new Promise((r) => setTimeout(r, 10));
      }

      await this.messageService!.saveMessage('model', cachedResult.response);
      
      // FIX: Save to memory
      if (this.memory && !this.messageService!['memory']) {
        await this.saveMessageToMemory('model', cachedResult.response);
      }
      
      this.send(ws, { type: 'complete', response: cachedResult.response });
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

    // Save model response
    await this.messageService!.saveMessage('model', response);
    
    // FIX: Save to memory
    if (this.memory && !this.messageService!['memory']) {
      await this.saveMessageToMemory('model', response);
    }

    ws && this.send(ws, { type: 'complete', response });

    // Create LTM summary if needed
    await this.maybeCreateLTM(this.storage.getMessages(), userMsg, response);
  });
}

// NEW: Helper method to save messages to memory
private async saveMessageToMemory(role: 'user' | 'model', content: string): Promise<void> {
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

// ============================================================
// FIXED: Load D1 history into memory on hydration
// ============================================================

private async loadFromD1(sessionId: string): Promise<void> {
  if (!this.d1) return;

  try {
    const messages = await this.d1.loadMessages(sessionId, 200);
    console.log(`[DurableAgent] Loaded ${messages.length} messages from D1`);

    // Load into storage
    for (const msg of messages) {
      await this.storage.saveMessage(msg.role as any, msg.parts, msg.timestamp);
      
      // FIX: Also load into vector memory
      if (this.memory) {
        const content = msg.parts
          ?.map((p: any) => (typeof p === 'string' ? p : p.text))
          .join(' ') || '';
        
        if (content.trim()) {
          await this.saveMessageToMemory(msg.role as 'user' | 'model', content);
        }
      }
    }

    await this.d1.updateSessionActivity(sessionId);
  } catch (err) {
    console.error('[DurableAgent] D1 load failed:', err);
  }
}

// ============================================================
// FIXED: MessageService should always use memory if available
// ============================================================

// message-service.ts changes:
export class MessageService {
  private storage: DurableStorage;
  private memory?: MemoryManager;
  private sessionId: string;
  private pendingFlush: Message[] = [];
  private flushScheduled = false;
  private d1FlushHandler?: (messages: Message[]) => Promise<void>;

  constructor(
    storage: DurableStorage,
    sessionId: string,
    memory?: MemoryManager
  ) {
    this.storage = storage;
    this.sessionId = sessionId;
    this.memory = memory;
  }

  async saveMessage(
    role: 'user' | 'model',
    content: string,
    metadata?: {
      toolCalls?: any[];
      importance?: number;
      tags?: string[];
    }
  ): Promise<void> {
    const timestamp = Date.now();
    const parts = [{ text: content }];

    // 1. Save to Durable Object storage (instant)
    await this.storage.saveMessage(role, parts, timestamp);

    // 2. Add to pending D1 flush queue
    const message: Message = {
      role,
      parts,
      timestamp,
      ...(metadata?.toolCalls && { toolCalls: metadata.toolCalls }),
    };
    this.pendingFlush.push(message);

    // 3. FIX: Always save to vector memory if available
    if (this.memory && content.trim()) {
      try {
        await this.memory.saveMemory({
          id: `${this.sessionId}_${timestamp}_${role}`,
          content,
          metadata: {
            sessionId: this.sessionId,
            timestamp,
            role,
            importance: metadata?.importance ?? (role === 'user' ? 0.8 : 0.7),
            tags: metadata?.tags,
          },
        });
        console.log(`[MessageService] Saved ${role} message to vector memory`);
      } catch (error) {
        console.error('[MessageService] Memory save failed:', error);
        // Non-critical, continue
      }
    }

    // 4. Schedule batch flush to D1
    this.scheduleFlush();
  }
}

// ============================================================
// FIXED: Reduce LTM threshold for more frequent summaries
// ============================================================

private async maybeCreateLTM(
  history: Message[],
  lastQuery: string,
  lastResponse: string
): Promise<void> {
  if (!this.memory || !this.sessionId) return;
  
  // FIX: Create summaries every 5-10 messages instead of 15
  if (history.length === 0 || history.length % 10 !== 0) return;

  try {
    const messagesToSummarize = history.slice(-10).map((m) => ({
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

// ============================================================
// TESTING: Verify memory is working
// ============================================================

// Add this diagnostic method to durable-agent.ts:
public async debugMemory(): Promise<{
  stmCount: number;
  ltmCount: number;
  recentMemories: any[];
  searchTest: any[];
}> {
  if (!this.memory) {
    return { stmCount: 0, ltmCount: 0, recentMemories: [], searchTest: [] };
  }

  const stats = await this.memory.getMemoryStats();
  const recent = await this.memory.getRecentMemories(5);
  const searchTest = await this.memory.searchMemory('test query', { topK: 3 });

  return {
    stmCount: stats.sessionMemories,
    ltmCount: stats.longTermMemories,
    recentMemories: recent,
    searchTest,
  };
}

// Add route in index.ts:
case '/api/debug/memory':
  if (request.method === 'GET') {
    const res = await stub.debugMemory();
    return jsonResponse(res);
  }
  break;
