import { VectorizeIndex } from '@cloudflare/workers-types';
import { AI } from '@cloudflare/workers-types';

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

export class MemoryManager {
  private vectorize: VectorizeIndex | null;
  private ai: AI | null;
  private sessionId: string;

  constructor(vectorize: VectorizeIndex | null, ai: AI | null, sessionId: string) {
    this.vectorize = vectorize;
    this.ai = ai;
    this.sessionId = sessionId;
  }

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

  async searchMemory(
    query: string,
    options: { topK?: number; filter?: any } = {}
  ): Promise<any[]> {
    if (!this.vectorize) {
      console.warn('[MemoryManager] Vectorize not available');
      return [];
    }

    try {
      const embedding = await this.generateEmbedding(query);
      const results = await this.vectorize.query(embedding, {
        topK: options.topK || 5,
        filter: options.filter,
        returnMetadata: 'all',
      });

      return results.matches.map((match: any) => ({
        id: match.id,
        score: match.score,
        content: match.metadata?.content || '',
        metadata: match.metadata,
      }));
    } catch (error) {
      console.error('[MemoryManager] Search failed:', error);
      return [];
    }
  }

  async addLongTermMemory(memory: LongTermMemory): Promise<void> {
    if (!this.vectorize) return;

    try {
      const embedding = await this.generateEmbedding(
        `${memory.query} ${memory.summary} ${memory.topics || ''}`
      );

      await this.vectorize.upsert([
        {
          id: memory.id,
          values: embedding,
          metadata: {
            ...memory,
            type: 'long_term',
          },
        },
      ]);

      console.log(`[MemoryManager] Saved LTM: ${memory.id}`);
    } catch (error) {
      console.error('[MemoryManager] Failed to save LTM:', error);
    }
  }

  async getRecentMemories(limit: number = 10): Promise<any[]> {
    if (!this.vectorize) return [];

    try {
      // Search with a generic query to get recent memories
      const embedding = await this.generateEmbedding('recent conversation');
      const results = await this.vectorize.query(embedding, {
        topK: limit,
        returnMetadata: 'all',
      });

      return results.matches.map((match: any) => ({
        id: match.id,
        content: match.metadata?.content || '',
        metadata: match.metadata,
        score: match.score,
      }));
    } catch (error) {
      console.error('[MemoryManager] Failed to get recent memories:', error);
      return [];
    }
  }

  async getMemoryStats(): Promise<MemoryStats> {
    if (!this.vectorize) {
      return {
        sessionMemories: 0,
        longTermMemories: 0,
        totalMemories: 0,
      };
    }

    try {
      // Query for session memories
      const stmEmbedding = await this.generateEmbedding('session memory');
      const stmResults = await this.vectorize.query(stmEmbedding, {
        topK: 100,
        filter: { type: 'short_term', sessionId: this.sessionId },
        returnMetadata: 'all',
      });

      // Query for long-term memories
      const ltmEmbedding = await this.generateEmbedding('long term memory');
      const ltmResults = await this.vectorize.query(ltmEmbedding, {
        topK: 100,
        filter: { type: 'long_term', sessionId: this.sessionId },
        returnMetadata: 'all',
      });

      const sessionCount = stmResults.matches.length;
      const ltmCount = ltmResults.matches.length;

      return {
        sessionMemories: sessionCount,
        longTermMemories: ltmCount,
        totalMemories: sessionCount + ltmCount,
      };
    } catch (error) {
      console.error('[MemoryManager] Failed to get memory stats:', error);
      return {
        sessionMemories: 0,
        longTermMemories: 0,
        totalMemories: 0,
      };
    }
  }

  async summarizeConversation(
    messages: Array<{ role: string; content: string }>
  ): Promise<string> {
    if (!this.ai) {
      return 'Summary not available';
    }

    try {
      const conversationText = messages
        .map((m) => `${m.role}: ${m.content}`)
        .join('\n');

      const response = await this.ai.run('@cf/meta/llama-3.1-8b-instruct', {
        prompt: `Summarize the following conversation in 2-3 sentences, focusing on key topics and important information:\n\n${conversationText}`,
        max_tokens: 150,
      });

      return (response as any).response || 'Summary generation failed';
    } catch (error) {
      console.error('[MemoryManager] Summarization failed:', error);
      return 'Summary generation failed';
    }
  }

  async extractImportantTopics(text: string): Promise<string[]> {
    if (!this.ai) {
      return [];
    }

    try {
      const response = await this.ai.run('@cf/meta/llama-3.1-8b-instruct', {
        prompt: `Extract 3-5 key topics or themes from this text as a comma-separated list:\n\n${text}`,
        max_tokens: 50,
      });

      const topicsText = (response as any).response || '';
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

  private async generateEmbedding(text: string): Promise<number[]> {
    if (!this.ai) {
      throw new Error('AI binding not available');
    }

    try {
      const response = await this.ai.run('@cf/baai/bge-base-en-v1.5', {
        text: text.substring(0, 512), // Limit text length
      });

      return (response as any).data[0];
    } catch (error) {
      console.error('[MemoryManager] Embedding generation failed:', error);
      throw error;
    }
  }
}
