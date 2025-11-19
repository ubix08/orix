// src/memory/optimized-memory-manager.ts
import type { MemoryItem, LongTermMemory, MemorySearchResult } from './memory-manager';

/**
 * Optimized memory manager with caching and batching
 */
export class OptimizedMemoryManager {
  private vectorize: VectorizeIndex;
  private geminiApiKey: string;
  private sessionId: string;
  
  // Embedding cache to avoid redundant API calls
  private embeddingCache = new LRUCache<string, number[]>(100);
  
  // Batch queue for efficient embedding generation
  private embeddingQueue: Array<{
    text: string;
    resolve: (embedding: number[]) => void;
    reject: (error: Error) => void;
  }> = [];
  private batchTimer: NodeJS.Timeout | null = null;

  constructor(
    vectorize: VectorizeIndex,
    geminiApiKey: string,
    sessionId: string
  ) {
    this.vectorize = vectorize;
    this.geminiApiKey = geminiApiKey;
    this.sessionId = sessionId;
  }

  /**
   * Get embedding with caching and batching
   */
  private async getEmbedding(text: string): Promise<number[]> {
    // Check cache first
    const cacheKey = this.hashText(text);
    const cached = this.embeddingCache.get(cacheKey);
    if (cached) return cached;

    // Add to batch queue
    return new Promise((resolve, reject) => {
      this.embeddingQueue.push({ text, resolve, reject });
      
      // Process batch after 100ms or when queue reaches 5 items
      if (this.embeddingQueue.length >= 5) {
        this.processBatch();
      } else if (!this.batchTimer) {
        this.batchTimer = setTimeout(() => this.processBatch(), 100);
      }
    });
  }

  /**
   * Process embedding batch
   */
  private async processBatch(): Promise<void> {
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }

    const batch = this.embeddingQueue.splice(0, 16); // Max 16 at a time
    if (batch.length === 0) return;

    try {
      const texts = batch.map(item => item.text);
      const embeddings = await this.generateEmbeddingBatch(texts);

      batch.forEach((item, i) => {
        const embedding = embeddings[i];
        const cacheKey = this.hashText(item.text);
        this.embeddingCache.set(cacheKey, embedding);
        item.resolve(embedding);
      });
    } catch (error) {
      batch.forEach(item => item.reject(error as Error));
    }
  }

  /**
   * Generate embeddings in batch (more efficient)
   */
  private async generateEmbeddingBatch(texts: string[]): Promise<number[][]> {
    const response = await fetch(
      'https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:batchEmbedContents',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': this.geminiApiKey,
        },
        body: JSON.stringify({
          requests: texts.map(text => ({
            model: 'models/text-embedding-004',
            content: { parts: [{ text }] },
          })),
        }),
      }
    );

    if (!response.ok) {
      throw new Error(`Gemini API error: ${response.statusText}`);
    }

    const data = await response.json();
    return data.embeddings.map((e: any) => e.values);
  }

  /**
   * Save memory with deduplication
   */
  async saveMemory(item: MemoryItem): Promise<void> {
    // Check if similar memory already exists (deduplication)
    const existing = await this.searchMemory(item.content, {
      topK: 1,
      filter: {
        sessionId: this.sessionId,
        type: 'short_term',
      },
    });

    // If very similar memory exists (>95% similarity), skip
    if (existing.length > 0 && existing[0].score > 0.95) {
      console.log('[OptimizedMemory] Skipping duplicate memory');
      return;
    }

    const embedding = await this.getEmbedding(item.content);

    await this.vectorize.upsert([
      {
        id: item.id,
        values: embedding,
        metadata: {
          ...item.metadata,
          type: 'short_term',
          content: item.content, // Store content in metadata
        },
      },
    ]);
  }

  /**
   * Search with result caching
   */
  private searchCache = new LRUCache<string, {
    results: MemorySearchResult[];
    timestamp: number;
  }>(50);

  async searchMemory(
    query: string,
    options: {
      topK?: number;
      filter?: any;
      cacheTTL?: number;
    } = {}
  ): Promise<MemorySearchResult[]> {
    const cacheKey = `${query}_${JSON.stringify(options)}`;
    const cached = this.searchCache.get(cacheKey);
    
    // Use cache if less than 5 minutes old
    const ttl = options.cacheTTL ?? 300000;
    if (cached && Date.now() - cached.timestamp < ttl) {
      return cached.results;
    }

    const embedding = await this.getEmbedding(query);

    const results = await this.vectorize.query(embedding, {
      topK: options.topK ?? 10,
      filter: options.filter,
      returnMetadata: true,
    });

    const mappedResults = results.matches.map(match => ({
      content: match.metadata?.content || '',
      metadata: match.metadata,
      score: match.score,
      distance: 1 - match.score,
    }));

    // Cache results
    this.searchCache.set(cacheKey, {
      results: mappedResults,
      timestamp: Date.now(),
    });

    return mappedResults;
  }

  /**
   * Simple text hash for cache keys
   */
  private hashText(text: string): string {
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
      const char = text.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return hash.toString(36);
  }

  /**
   * Clear caches (for testing)
   */
  clearCaches(): void {
    this.embeddingCache.clear();
    this.searchCache.clear();
  }
}

/**
 * Simple LRU Cache implementation
 */
class LRUCache<K, V> {
  private cache = new Map<K, V>();
  private maxSize: number;

  constructor(maxSize: number) {
    this.maxSize = maxSize;
  }

  get(key: K): V | undefined {
    if (!this.cache.has(key)) return undefined;
    
    // Move to end (most recently used)
    const value = this.cache.get(key)!;
    this.cache.delete(key);
    this.cache.set(key, value);
    
    return value;
  }

  set(key: K, value: V): void {
    // Remove if exists (will re-add at end)
    this.cache.delete(key);
    
    // Add to end
    this.cache.set(key, value);
    
    // Evict oldest if over capacity
    if (this.cache.size > this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }
  }

  clear(): void {
    this.cache.clear();
  }
}
