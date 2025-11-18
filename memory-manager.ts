// src/memory/memory-manager.ts
// =============================================================
// 🧠 Memory Manager — Vector-based memory system using Cloudflare Vectorize
// =============================================================

import type { AgentState } from '../types';

export interface MemoryItem {
  id: string;
  content: string;
  metadata: {
    sessionId: string;
    timestamp: number;
    role: 'user' | 'model';
    importance?: number;
    tags?: string[];
    summary?: string;
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
}

export interface MemorySearchResult {
  content: string;
  metadata: any;
  score: number;
  distance: number;
}

export class MemoryManager {
  private vectorize: VectorizeIndex | null = null;
  private geminiApiKey: string;
  private sessionId: string;
  private longTermEnabled: boolean;
  private ltmThreshold: number;

  constructor(
    vectorize: VectorizeIndex | null,
    geminiApiKey: string,
    sessionId: string,
    options: {
      longTermEnabled?: boolean;
      ltmThreshold?: number;
    } = {}
  ) {
    this.vectorize = vectorize;
    this.geminiApiKey = geminiApiKey;
    this.sessionId = sessionId;
    this.longTermEnabled = options.longTermEnabled ?? true;
    this.ltmThreshold = options.ltmThreshold ?? 0.6;

    if (this.ltmThreshold < 0.6 || this.ltmThreshold > 1) {
      throw new Error('LTM threshold must be between 0.6 and 1.0');
    }
  }

  // =============================================================
  // Embedding Generation using Gemini
  // =============================================================

  private async generateEmbedding(text: string): Promise<number[]> {
    try {
      const response = await fetch(
        'https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': this.geminiApiKey,
          },
          body: JSON.stringify({
            model: 'models/text-embedding-004',
            content: {
              parts: [{ text }],
            },
          }),
        }
      );

      if (!response.ok) {
        throw new Error(`Gemini API error: ${response.statusText}`);
      }

      const data = await response.json();
      return data.embedding.values;
    } catch (error) {
      console.error('[MemoryManager] Failed to generate embedding:', error);
      throw error;
    }
  }

  // =============================================================
  // Short-term Memory (Session-based)
  // =============================================================

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
    options: {
      topK?: number;
      filter?: any;
      includeMetadata?: boolean;
    } = {}
  ): Promise<MemorySearchResult[]> {
    if (!this.vectorize) {
      console.warn('[MemoryManager] Vectorize not available');
      return [];
    }

    try {
      const embedding = await this.generateEmbedding(query);

      const results = await this.vectorize.query(embedding, {
        topK: options.topK ?? 10,
        filter: options.filter ?? { sessionId: this.sessionId, type: 'short_term' },
        returnMetadata: options.includeMetadata !== false,
      });

      return results.matches.map((match) => ({
        content: match.metadata?.content || '',
        metadata: match.metadata,
        score: match.score,
        distance: 1 - match.score,
      }));
    } catch (error) {
      console.error('[MemoryManager] Failed to search memory:', error);
      return [];
    }
  }

  async getRecentMemories(limit: number = 10): Promise<MemorySearchResult[]> {
    if (!this.vectorize) return [];

    try {
      // Use a generic query to retrieve recent items
      const embedding = await this.generateEmbedding('recent conversation context');

      const results = await this.vectorize.query(embedding, {
        topK: limit,
        filter: { sessionId: this.sessionId, type: 'short_term' },
        returnMetadata: true,
      });

      // Sort by timestamp
      return results.matches
        .map((match) => ({
          content: match.metadata?.content || '',
          metadata: match.metadata,
          score: match.score,
          distance: 1 - match.score,
        }))
        .sort((a, b) => (b.metadata?.timestamp || 0) - (a.metadata?.timestamp || 0));
    } catch (error) {
      console.error('[MemoryManager] Failed to get recent memories:', error);
      return [];
    }
  }

  // =============================================================
  // Long-term Memory (Cross-session)
  // =============================================================

  async addLongTermMemory(ltm: LongTermMemory): Promise<void> {
    if (!this.vectorize || !this.longTermEnabled) {
      console.warn('[MemoryManager] LTM not enabled');
      return;
    }

    try {
      const embedding = await this.generateEmbedding(ltm.query + ' ' + ltm.summary);

      await this.vectorize.upsert([
        {
          id: `ltm_${ltm.id}`,
          values: embedding,
          metadata: {
            ...ltm,
            type: 'long_term',
          },
        },
      ]);

      console.log(`[MemoryManager] Added LTM: ${ltm.id}`);
    } catch (error) {
      console.error('[MemoryManager] Failed to add LTM:', error);
    }
  }

  async updateLongTermMemory(ltm: LongTermMemory): Promise<void> {
    if (!this.vectorize || !this.longTermEnabled) return;

    try {
      // Update is same as upsert in Vectorize
      await this.addLongTermMemory(ltm);
      console.log(`[MemoryManager] Updated LTM: ${ltm.id}`);
    } catch (error) {
      console.error('[MemoryManager] Failed to update LTM:', error);
    }
  }

  async searchLongTermMemory(
    query: string,
    topK: number = 3
  ): Promise<MemorySearchResult[]> {
    if (!this.vectorize || !this.longTermEnabled) {
      return [];
    }

    try {
      const embedding = await this.generateEmbedding(query);

      const results = await this.vectorize.query(embedding, {
        topK,
        filter: { type: 'long_term' },
        returnMetadata: true,
      });

      const filtered = results.matches
        .filter((match) => match.score >= this.ltmThreshold)
        .map((match) => ({
          content: match.metadata?.query || '',
          metadata: match.metadata,
          score: match.score,
          distance: 1 - match.score,
        }));

      if (filtered.length > 0) {
        console.log(
          `[MemoryManager] Retrieved ${filtered.length} LTM results for query: ${query}`
        );
        
        // Update lastAccessed timestamp
        for (const result of filtered) {
          if (result.metadata?.id) {
            await this.updateLastAccessed(result.metadata.id);
          }
        }
      }

      return filtered;
    } catch (error) {
      console.error('[MemoryManager] Failed to search LTM:', error);
      return [];
    }
  }

  private async updateLastAccessed(ltmId: string): Promise<void> {
    if (!this.vectorize) return;

    try {
      // Fetch the existing LTM
      const results = await this.vectorize.query(
        await this.generateEmbedding('update'),
        {
          topK: 1,
          filter: { id: ltmId, type: 'long_term' },
          returnMetadata: true,
        }
      );

      if (results.matches.length > 0) {
        const ltm = results.matches[0].metadata as LongTermMemory;
        ltm.lastAccessed = Date.now();
        ltm.interactions = (ltm.interactions || 0) + 1;
        await this.updateLongTermMemory(ltm);
      }
    } catch (error) {
      console.error('[MemoryManager] Failed to update lastAccessed:', error);
    }
  }

  // =============================================================
  // Memory Summarization using Gemini
  // =============================================================

  async summarizeConversation(messages: Array<{ role: string; content: string }>): Promise<string> {
    try {
      const conversationText = messages
        .map((m) => `${m.role}: ${m.content}`)
        .join('\n');

      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-exp:generateContent?key=${this.geminiApiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [
              {
                parts: [
                  {
                    text: `Summarize the following conversation concisely, capturing key topics, decisions, and important context:\n\n${conversationText}`,
                  },
                ],
              },
            ],
            generationConfig: {
              temperature: 0.3,
              maxOutputTokens: 200,
            },
          }),
        }
      );

      if (!response.ok) {
        throw new Error(`Gemini API error: ${response.statusText}`);
      }

      const data = await response.json();
      return data.candidates[0]?.content?.parts[0]?.text || 'No summary generated';
    } catch (error) {
      console.error('[MemoryManager] Failed to summarize conversation:', error);
      return 'Summary unavailable';
    }
  }

  async extractImportantTopics(text: string): Promise<string[]> {
    try {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-exp:generateContent?key=${this.geminiApiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [
              {
                parts: [
                  {
                    text: `Extract 3-5 key topics or themes from this text. Return only the topics as a comma-separated list:\n\n${text}`,
                  },
                ],
              },
            ],
            generationConfig: {
              temperature: 0.2,
              maxOutputTokens: 100,
            },
          }),
        }
      );

      if (!response.ok) {
        throw new Error(`Gemini API error: ${response.statusText}`);
      }

      const data = await response.json();
      const topicsText = data.candidates[0]?.content?.parts[0]?.text || '';
      return topicsText
        .split(',')
        .map((t) => t.trim())
        .filter((t) => t.length > 0);
    } catch (error) {
      console.error('[MemoryManager] Failed to extract topics:', error);
      return [];
    }
  }

  // =============================================================
  // Cleanup & Maintenance
  // =============================================================

  async clearSessionMemory(): Promise<void> {
    if (!this.vectorize) return;

    try {
      // Vectorize doesn't support bulk delete by filter yet
      // We'll need to query and delete individually
      const results = await this.vectorize.query(
        await this.generateEmbedding('clear'),
        {
          topK: 1000,
          filter: { sessionId: this.sessionId, type: 'short_term' },
          returnMetadata: true,
        }
      );

      const ids = results.matches.map((m) => m.id);
      if (ids.length > 0) {
        await this.vectorize.deleteByIds(ids);
        console.log(`[MemoryManager] Cleared ${ids.length} session memories`);
      }
    } catch (error) {
      console.error('[MemoryManager] Failed to clear session memory:', error);
    }
  }

  async pruneOldMemories(daysOld: number = 30): Promise<void> {
    if (!this.vectorize) return;

    try {
      const cutoffTime = Date.now() - daysOld * 24 * 60 * 60 * 1000;

      // Query all memories
      const results = await this.vectorize.query(
        await this.generateEmbedding('prune'),
        {
          topK: 10000,
          returnMetadata: true,
        }
      );

      const oldIds = results.matches
        .filter((m) => (m.metadata?.timestamp || 0) < cutoffTime)
        .map((m) => m.id);

      if (oldIds.length > 0) {
        await this.vectorize.deleteByIds(oldIds);
        console.log(`[MemoryManager] Pruned ${oldIds.length} old memories`);
      }
    } catch (error) {
      console.error('[MemoryManager] Failed to prune old memories:', error);
    }
  }

  // =============================================================
  // Context Building for Agent (Similar to Python's get_ltm + get_previous_task_contexts)
  // =============================================================

  async buildEnhancedContext(
    currentQuery: string,
    previousTasks?: Array<{ name: string; description: string; result: string }>,
    options: { 
      includeSTM?: boolean; 
      includeLTM?: boolean;
      maxSTMResults?: number;
      maxLTMResults?: number;
    } = {}
  ): Promise<{
    context: string;
    hasHighSimilarity: boolean;
    similarQuery?: string;
  }> {
    const includeSTM = options.includeSTM !== false;
    const includeLTM = options.includeLTM !== false;
    const maxSTMResults = options.maxSTMResults ?? 5;
    const maxLTMResults = options.maxLTMResults ?? 3;

    let context = '';
    let hasHighSimilarity = false;
    let similarQuery: string | undefined;

    // 1. Check for high-similarity LTM first (like Python's threshold check)
    if (includeLTM && this.longTermEnabled) {
      const ltmResults = await this.searchLongTermMemory(currentQuery, maxLTMResults);
      
      // Check if we have a very similar past query (>0.85 similarity)
      if (ltmResults.length > 0 && ltmResults[0].score >= 0.85) {
        hasHighSimilarity = true;
        similarQuery = ltmResults[0].metadata?.query;
        context += `## 🎯 Highly Similar Past Query Found (${(ltmResults[0].score * 100).toFixed(1)}% match)\n\n`;
        context += `**Past Query:** ${ltmResults[0].metadata?.query}\n`;
        context += `**Past Summary:** ${ltmResults[0].metadata?.summary}\n`;
        context += `**Importance:** ${ltmResults[0].metadata?.importance}\n\n`;
        context += `Note: You can leverage this past context but adapt your response to the current query nuances.\n\n`;
      }
      // Add other relevant LTM context
      else if (ltmResults.length > 0) {
        context += '## 📚 Relevant Past Context from Long-term Memory:\n\n';
        ltmResults.forEach((r, i) => {
          context += `${i + 1}. **${r.metadata?.query?.substring(0, 100)}...** (${(r.score * 100).toFixed(1)}% relevant)\n`;
          context += `   Summary: ${r.metadata?.summary}\n`;
          context += `   Last accessed: ${new Date(r.metadata?.lastAccessed || 0).toLocaleDateString()}\n\n`;
        });
      }
    }

    // 2. Add previous task contexts (like Python's get_previous_task_contexts)
    if (previousTasks && previousTasks.length > 0) {
      context += '## 📋 Previously Completed Tasks in This Session:\n\n';
      previousTasks.forEach((task, i) => {
        context += `${i + 1}. **${task.name}** - ${task.description}\n`;
        context += `   Result: ${task.result.substring(0, 200)}${task.result.length > 200 ? '...' : ''}\n\n`;
      });
    }

    // 3. Add short-term conversation context
    if (includeSTM) {
      const stmResults = await this.searchMemory(currentQuery, { topK: maxSTMResults });
      if (stmResults.length > 0) {
        context += '## 💬 Recent Relevant Conversation Context:\n\n';
        stmResults.forEach((r, i) => {
          const role = r.metadata?.role === 'user' ? '👤 User' : '🤖 Assistant';
          const timestamp = new Date(r.metadata?.timestamp || 0).toLocaleTimeString();
          context += `${i + 1}. [${timestamp}] ${role}: ${r.content.substring(0, 150)}${r.content.length > 150 ? '...' : ''}\n`;
        });
        context += '\n';
      }
    }

    return {
      context: context || 'No relevant past context found.\n',
      hasHighSimilarity,
      similarQuery,
    };
  }

  // Legacy method for backward compatibility
  async buildContext(currentQuery: string, options: { includeSTM?: boolean; includeLTM?: boolean } = {}): Promise<string> {
    const result = await this.buildEnhancedContext(currentQuery, undefined, options);
    return result.context;
  }

  // =============================================================
  // Stats & Diagnostics
  // =============================================================

  async getMemoryStats(): Promise<{
    sessionMemories: number;
    longTermMemories: number;
    totalSize: number;
  }> {
    if (!this.vectorize) {
      return { sessionMemories: 0, longTermMemories: 0, totalSize: 0 };
    }

    try {
      // Query to get counts (Vectorize has limited stats API)
      const stmResults = await this.vectorize.query(
        await this.generateEmbedding('stats'),
        {
          topK: 10000,
          filter: { sessionId: this.sessionId, type: 'short_term' },
          returnMetadata: false,
        }
      );

      const ltmResults = await this.vectorize.query(
        await this.generateEmbedding('stats'),
        {
          topK: 10000,
          filter: { type: 'long_term' },
          returnMetadata: false,
        }
      );

      return {
        sessionMemories: stmResults.matches.length,
        longTermMemories: ltmResults.matches.length,
        totalSize: stmResults.matches.length + ltmResults.matches.length,
      };
    } catch (error) {
      console.error('[MemoryManager] Failed to get stats:', error);
      return { sessionMemories: 0, longTermMemories: 0, totalSize: 0 };
    }
  }
}

export default MemoryManager;
