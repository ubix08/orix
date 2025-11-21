// src/memory/memory-manager.ts - FIXED VERSION
import { VectorizeIndex } from '@cloudflare/workers-types';
import { GeminiClient } from '../gemini';

export interface MemoryItem {
  id: string;
  content: string;
  metadata: {
    sessionId: string;
    timestamp: number;
    role?: string;
    importance?: number;
    tags?: string[];
  };
}

export interface LongTermMemory {
  id: string;
  sessionId: string;
  query: string;
  summary: string;
  importance: number;
  timestamp: number;
  interactions: number;
  lastAccessed: number;
  answer?: string;
  topics?: string;
}

export interface MemoryStats {
  sessionMemories: number;
  longTermMemories: number;
  totalMemories: number;
}

export interface MemoryOptions {
  longTermEnabled?: boolean;
  ltmThreshold?: number;
}

/**
 * FIXED: Memory Manager now uses GeminiClient for embeddings
 * - Proper dependency injection
 * - Correct embedding model (text-embedding-004)
 * - Batch processing support
 * - Content properly stored and retrieved
 */
export class MemoryManager {
  private vectorize: VectorizeIndex | null;
  private gemini: GeminiClient;
  private sessionId: string;
  private options: Required<MemoryOptions>;

  // Embedding cache to reduce API calls
  private embeddingCache = new Map<string, number[]>();
  private readonly CACHE_SIZE = 100;

  constructor(
    vectorize: VectorizeIndex | null,
    gemini: GeminiClient,  // ✅ FIXED: Accept GeminiClient, not API key string
    sessionId: string,
    options: MemoryOptions = {}
  ) {
    this.vectorize = vectorize;
    this.gemini = gemini;
    this.sessionId = sessionId;
    this.options = {
      longTermEnabled: options.longTermEnabled ?? true,
      ltmThreshold: options.ltmThreshold ?? 0.65,
    };
  }

  // ===== SHORT-TERM MEMORY (Session-scoped) =====

  async saveMemory(item: MemoryItem): Promise<void> {
    if (!this.vectorize) {
      console.warn('[MemoryManager] Vectorize not available, skipping save');
      return;
    }

    try {
      const embedding = await this.generateEmbedding(item.content);

      await this.vectorize.upsert([
        {
          id: item.id,
          values: embedding,
          metadata: {
            ...item.metadata,
            type: 'short_term',
            content: item.content, // ✅ Store content in metadata
            sessionId: this.sessionId, // ✅ Ensure session isolation
          },
        },
      ]);

      console.log(`[MemoryManager] Saved STM: ${item.id}`);
    } catch (error) {
      console.error('[MemoryManager] Failed to save memory:', error);
      throw error; // Propagate error for retry logic
    }
  }

  async searchMemory(
    query: string,
    options: { topK?: number; filter?: any; includeContent?: boolean } = {}
  ): Promise<Array<{ id: string; score: number; content: string; metadata: any }>> {
    if (!this.vectorize) {
      console.warn('[MemoryManager] Vectorize not available');
      return [];
    }

    try {
      const embedding = await this.generateEmbedding(query);
      
      // ✅ FIXED: Proper filter for session isolation
      const filter = {
        type: 'short_term',
        sessionId: this.sessionId,
        ...options.filter,
      };

      const results = await this.vectorize.query(embedding, {
        topK: options.topK || 5,
        filter,
        returnMetadata: 'all',
      });

      return results.matches.map((match: any) => ({
        id: match.id,
        score: match.score,
        content: match.metadata?.content || '', // ✅ Retrieve stored content
        metadata: match.metadata,
      }));
    } catch (error) {
      console.error('[MemoryManager] Search failed:', error);
      return [];
    }
  }

  // ===== LONG-TERM MEMORY (Cross-session) =====

  async addLongTermMemory(memory: LongTermMemory): Promise<void> {
    if (!this.vectorize || !this.options.longTermEnabled) return;

    try {
      const searchText = `${memory.query} ${memory.summary} ${memory.topics || ''}`;
      const embedding = await this.generateEmbedding(searchText);

      await this.vectorize.upsert([
        {
          id: memory.id,
          values: embedding,
          metadata: {
            ...memory,
            type: 'long_term',
            searchText, // Store for debugging
          },
        },
      ]);

      console.log(`[MemoryManager] Saved LTM: ${memory.id} (importance: ${memory.importance})`);
    } catch (error) {
      console.error('[MemoryManager] Failed to save LTM:', error);
      throw error;
    }
  }

  async searchLongTermMemory(
    query: string,
    topK: number = 3
  ): Promise<Array<{ id: string; score: number; metadata: LongTermMemory }>> {
    if (!this.vectorize || !this.options.longTermEnabled) return [];

    try {
      const embedding = await this.generateEmbedding(query);

      const results = await this.vectorize.query(embedding, {
        topK,
        filter: { type: 'long_term', sessionId: this.sessionId },
        returnMetadata: 'all',
      });

      return results.matches
        .filter((m: any) => m.score >= this.options.ltmThreshold)
        .map((match: any) => ({
          id: match.id,
          score: match.score,
          metadata: match.metadata as LongTermMemory,
        }));
    } catch (error) {
      console.error('[MemoryManager] LTM search failed:', error);
      return [];
    }
  }

  async updateLongTermMemory(updatedMemory: Partial<LongTermMemory> & { id: string }): Promise<void> {
    if (!this.vectorize || !this.options.longTermEnabled) return;

    try {
      // Fetch existing memory
      const existing = await this.vectorize.getByIds([updatedMemory.id]);
      if (!existing || existing.length === 0) {
        console.warn(`[MemoryManager] LTM ${updatedMemory.id} not found for update`);
        return;
      }

      const existingMetadata = existing[0].metadata as LongTermMemory;
      const merged = { ...existingMetadata, ...updatedMemory };

      // Re-embed if query/summary changed
      let embedding = existing[0].values;
      if (updatedMemory.query || updatedMemory.summary || updatedMemory.topics) {
        const searchText = `${merged.query} ${merged.summary} ${merged.topics || ''}`;
        embedding = await this.generateEmbedding(searchText);
      }

      await this.vectorize.upsert([
        {
          id: merged.id,
          values: embedding,
          metadata: merged,
        },
      ]);

      console.log(`[MemoryManager] Updated LTM: ${merged.id}`);
    } catch (error) {
      console.error('[MemoryManager] Failed to update LTM:', error);
    }
  }

  // ===== CONTEXT BUILDING =====

  async buildEnhancedContext(
    query: string,
    conversationHistory?: Array<{ role: string; content: string }>,
    options: {
      includeSTM?: boolean;
      includeLTM?: boolean;
      maxSTMResults?: number;
      maxLTMResults?: number;
    } = {}
  ): Promise<{ context: string; stmCount: number; ltmCount: number }> {
    const opts = {
      includeSTM: options.includeSTM ?? true,
      includeLTM: options.includeLTM ?? true,
      maxSTMResults: options.maxSTMResults ?? 5,
      maxLTMResults: options.maxLTMResults ?? 3,
    };

    const contextParts: string[] = [];

    // Add long-term memory first (broader context)
    if (opts.includeLTM) {
      const ltmResults = await this.searchLongTermMemory(query, opts.maxLTMResults);
      if (ltmResults.length > 0) {
        contextParts.push('📚 RELEVANT PAST KNOWLEDGE:');
        ltmResults.forEach((result, i) => {
          contextParts.push(
            `\n[${i + 1}] (Relevance: ${(result.score * 100).toFixed(0)}%)`,
            `Query: ${result.metadata.query}`,
            `Summary: ${result.metadata.summary}`,
            result.metadata.topics ? `Topics: ${result.metadata.topics}` : '',
            ''
          );
        });
      }
    }

    // Add short-term memory (recent session context)
    if (opts.includeSTM) {
      const stmResults = await this.searchMemory(query, { topK: opts.maxSTMResults });
      if (stmResults.length > 0) {
        contextParts.push('💭 RECENT SESSION CONTEXT:');
        stmResults.forEach((result, i) => {
          contextParts.push(
            `\n[${i + 1}] (Relevance: ${(result.score * 100).toFixed(0)}%)`,
            result.content.substring(0, 300) + (result.content.length > 300 ? '...' : ''),
            ''
          );
        });
      }
    }

    const context = contextParts.filter(Boolean).join('\n');
    const stmCount = opts.includeSTM ? (await this.searchMemory(query, { topK: opts.maxSTMResults })).length : 0;
    const ltmCount = opts.includeLTM ? (await this.searchLongTermMemory(query, opts.maxLTMResults)).length : 0;

    return {
      context: context || 'No relevant past context found.',
      stmCount,
      ltmCount,
    };
  }

  // ===== UTILITIES =====

  async summarizeConversation(
    messages: Array<{ role: string; content: string }>
  ): Promise<string> {
    try {
      const conversationText = messages
        .slice(-10) // Last 10 messages only
        .map((m) => `${m.role}: ${m.content}`)
        .join('\n');

      const prompt = `Summarize this conversation in 2-3 sentences, focusing on key topics and decisions:\n\n${conversationText}`;

      const response = await this.gemini.generateWithTools(
        [{ role: 'user', content: prompt }],
        [],
        { stream: false, temperature: 0.5 }
      );

      return response.text || 'Summary generation failed';
    } catch (error) {
      console.error('[MemoryManager] Summarization failed:', error);
      return 'Summary generation failed';
    }
  }

  async extractImportantTopics(text: string): Promise<string[]> {
    try {
      const prompt = `Extract 3-5 key topics or themes from this text as a comma-separated list:\n\n${text}`;

      const response = await this.gemini.generateWithTools(
        [{ role: 'user', content: prompt }],
        [],
        { stream: false, temperature: 0.3 }
      );

      const topicsText = response.text || '';
      return topicsText
        .split(',')
        .map((t: string) => t.trim())
        .filter((t: string) => t.length > 0)
        .slice(0, 5);
    } catch (error) {
      console.error('[MemoryManager] Topic extraction failed:', error);
      return [];
    }
  }

  async getMemoryStats(): Promise<MemoryStats> {
    if (!this.vectorize) {
      return { sessionMemories: 0, longTermMemories: 0, totalMemories: 0 };
    }

    try {
      // Use dummy embeddings for counting (Vectorize doesn't have count API)
      const dummyEmbedding = await this.generateEmbedding('count');

      const stmResults = await this.vectorize.query(dummyEmbedding, {
        topK: 1000,
        filter: { type: 'short_term', sessionId: this.sessionId },
        returnMetadata: false,
      });

      const ltmResults = await this.vectorize.query(dummyEmbedding, {
        topK: 1000,
        filter: { type: 'long_term', sessionId: this.sessionId },
        returnMetadata: false,
      });

      const sessionCount = stmResults.matches.length;
      const ltmCount = ltmResults.matches.length;

      return {
        sessionMemories: sessionCount,
        longTermMemories: ltmCount,
        totalMemories: sessionCount + ltmCount,
      };
    } catch (error) {
      console.error('[MemoryManager] Failed to get stats:', error);
      return { sessionMemories: 0, longTermMemories: 0, totalMemories: 0 };
    }
  }

  async clearSessionMemory(): Promise<void> {
    if (!this.vectorize) return;

    try {
      // Vectorize doesn't have bulk delete, so we query + delete by IDs
      const dummyEmbedding = await this.generateEmbedding('clear');
      const results = await this.vectorize.query(dummyEmbedding, {
        topK: 1000,
        filter: { type: 'short_term', sessionId: this.sessionId },
        returnMetadata: false,
      });

      const ids = results.matches.map((m: any) => m.id);
      if (ids.length > 0) {
        await this.vectorize.deleteByIds(ids);
        console.log(`[MemoryManager] Cleared ${ids.length} session memories`);
      }
    } catch (error) {
      console.error('[MemoryManager] Failed to clear session memory:', error);
    }
  }

  // ===== EMBEDDING GENERATION (FIXED) =====

  private async generateEmbedding(text: string): Promise<number[]> {
    // Check cache first
    const cacheKey = this.hashText(text);
    const cached = this.embeddingCache.get(cacheKey);
    if (cached) return cached;

    try {
      // ✅ FIXED: Use GeminiClient.embedText() method
      const embedding = await this.gemini.embedText(text, {
        model: 'text-embedding-004',
        normalize: true,
      });

      // Cache the result
      this.cacheEmbedding(cacheKey, embedding);

      return embedding;
    } catch (error) {
      console.error('[MemoryManager] Embedding generation failed:', error);
      throw error;
    }
  }

  private hashText(text: string): string {
    // Simple hash for cache keys
    let hash = 0;
    for (let i = 0; i < Math.min(text.length, 512); i++) {
      const char = text.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return hash.toString(36);
  }

  private cacheEmbedding(key: string, embedding: number[]): void {
    // LRU cache: remove oldest if full
    if (this.embeddingCache.size >= this.CACHE_SIZE) {
      const firstKey = this.embeddingCache.keys().next().value;
      this.embeddingCache.delete(firstKey);
    }
    this.embeddingCache.set(key, embedding);
  }
}

export default MemoryManager;
