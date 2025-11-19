// ============================================================
// FILE 1: src/memory/memory-manager.ts
// CRITICAL FIX: Store content in metadata
// ============================================================

// Replace the saveMemory method (around line 55) with this:

async saveMemory(item: MemoryItem): Promise<void> {
  if (!this.vectorize) {
    console.warn('[MemoryManager] Vectorize not available, skipping save');
    return;
  }

  try {
    const embedding = await this.generateEmbedding(item.content);

    // FIXED: Store content in metadata so it can be retrieved
    await this.vectorize.upsert([
      {
        id: item.id,
        values: embedding,
        metadata: {
          ...item.metadata,
          type: 'short_term',
          content: item.content, // ← CRITICAL: Add this line
        },
      },
    ]);

    console.log(`[MemoryManager] Saved memory: ${item.id}`);
  } catch (error) {
    console.error('[MemoryManager] Failed to save memory:', error);
  }
}

// ============================================================
// FILE 2: src/services/message-service.ts
// CRITICAL FIX: Always save to memory
// ============================================================

// Replace the saveMessage method (around line 31) with this:

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

  // 3. FIXED: Always save to vector memory if available
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

// ============================================================
// FILE 3: src/durable-agent.ts
// CRITICAL FIXES: Multiple improvements
// ============================================================

// ADD this new method after the constructor (around line 100):

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

// REPLACE the loadFromD1 method (around line 500) with this:

private async loadFromD1(sessionId: string): Promise<void> {
  if (!this.d1) return;

  try {
    const messages = await this.d1.loadMessages(sessionId, 200);
    console.log(`[DurableAgent] Loaded ${messages.length} messages from D1`);

    // Load into storage AND memory
    for (const msg of messages) {
      await this.storage.saveMessage(msg.role as any, msg.parts, msg.timestamp);
      
      // FIXED: Also load into vector memory
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
    console.log(`[DurableAgent] Loaded ${messages.length} messages into memory`);
  } catch (err) {
    console.error('[DurableAgent] D1 load failed:', err);
  }
}

// REPLACE the maybeCreateLTM method (around line 570) with this:

private async maybeCreateLTM(
  history: Message[],
  lastQuery: string,
  lastResponse: string
): Promise<void> {
  if (!this.memory || !this.sessionId) return;
  
  // FIXED: Create summaries every 10 messages instead of 15
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

// ADD this diagnostic method at the end of the class (before the closing brace):

public async debugMemory(): Promise<{
  stmCount: number;
  ltmCount: number;
  recentMemories: any[];
  searchTest: any[];
}> {
  await this.init();
  
  if (!this.memory) {
    return { 
      stmCount: 0, 
      ltmCount: 0, 
      recentMemories: [], 
      searchTest: [] 
    };
  }

  try {
    const stats = await this.memory.getMemoryStats();
    const recent = await this.memory.getRecentMemories(5);
    const searchTest = await this.memory.searchMemory('test', { topK: 3 });

    return {
      stmCount: stats.sessionMemories,
      ltmCount: stats.longTermMemories,
      recentMemories: recent,
      searchTest,
    };
  } catch (error) {
    console.error('[DurableAgent] debugMemory failed:', error);
    return { 
      stmCount: 0, 
      ltmCount: 0, 
      recentMemories: [], 
      searchTest: [] 
    };
  }
}

// ============================================================
// FILE 4: src/index.ts
// ADD new debug route
// ============================================================

// Add this case in the handleDurableObjectRequest switch statement:

case '/api/debug/memory':
  if (request.method === 'GET') {
    const res = await stub.debugMemory();
    return jsonResponse(res);
  }
  break;

// ============================================================
// STEP-BY-STEP APPLICATION GUIDE
// ============================================================

/*
1. Open src/memory/memory-manager.ts
   - Find the saveMemory method (line ~55)
   - Add this line inside the metadata object:
     content: item.content,

2. Open src/services/message-service.ts
   - Find the saveMessage method (line ~31)
   - Update the vector memory save section to always save
   - Add console.log for verification

3. Open src/durable-agent.ts
   - Add the new saveMessageToMemory helper method
   - Update loadFromD1 to save messages to memory
   - Update maybeCreateLTM to run every 10 messages (not 15)
   - Add debugMemory method at the end

4. Open src/index.ts
   - Add the /api/debug/memory route in the switch statement

5. Deploy and test:
   - wrangler deploy
   - Test with curl or your frontend
*/

// ============================================================
// TESTING COMMANDS
// ============================================================

/*
# Test 1: Check memory initialization
curl "https://your-worker.dev/api/debug/memory?session_id=test-123"

# Test 2: Send a message
curl -X POST "https://your-worker.dev/api/chat?session_id=test-123" \
  -H "Content-Type: application/json" \
  -d '{"message": "My name is Alice and I love pizza"}'

# Test 3: Check memory was saved
curl "https://your-worker.dev/api/debug/memory?session_id=test-123"

# Test 4: Ask follow-up question
curl -X POST "https://your-worker.dev/api/chat?session_id=test-123" \
  -H "Content-Type: application/json" \
  -d '{"message": "What do I love to eat?"}'

# Test 5: Search memory directly
curl -X POST "https://your-worker.dev/api/memory/search?session_id=test-123" \
  -H "Content-Type: application/json" \
  -d '{"query": "food preferences", "topK": 5}'
*/
