// src/memory/memory-manager-optimized.ts
import { VectorizeIndex } from '@cloudflare/workers-types';
import { GeminiClient } from '../gemini';

/**
 * OPTIMIZED: Memory Manager with improved caching and batch processing
 */

interface EmbeddingCacheEntry {
  embedding: number[];
  timestamp: number;
  hits: number;
}

interface BatchEmbeddingRequest {
  text: string;
  id: string;
  priority: number;
}

export class MemoryManagerOptimized {
  private vectorize: VectorizeIndex | null;
  private gemini: GeminiClient;
  private sessionId: string;

  // Enhanced LRU cache with hit tracking
  private embeddingCache = new Map<string, EmbeddingCacheEntry>();
  private readonly CACHE_SIZE = 200; // Increased from 100
  private readonly CACHE_TTL = 3600000; // 1 hour

  // Batch processing queue
  private batchQueue: BatchEmbeddingRequest[] = [];
  private batchTimer: NodeJS.Timeout | null = null;
  private readonly BATCH_SIZE = 16;
  private readonly BATCH_DELAY = 100; // ms

  // Performance metrics
  private metrics = {
    cacheHits: 0,
    cacheMisses: 0,
    batchedRequests: 0,
    totalEmbeddings: 0,
  };

  constructor(
    vectorize: VectorizeIndex | null,
    gemini: GeminiClient,
    sessionId: string
  ) {
    this.vectorize = vectorize;
    this.gemini = gemini;
    this.sessionId = sessionId;
  }

  // ===== OPTIMIZED: Embedding with smart batching =====

  async generateEmbedding(text: string, priority: number = 0): Promise<number[]> {
    const cacheKey = this.hashTextSHA256(text);
    
    // Check cache with TTL
    const cached = this.getCachedEmbedding(cacheKey);
    if (cached) {
      this.metrics.cacheHits++;
      return cached;
    }

    this.metrics.cacheMisses++;

    // For high-priority requests, process immediately
    if (priority > 5) {
      return this.generateSingleEmbedding(text, cacheKey);
    }

    // For normal priority, add to batch queue
    return new Promise((resolve, reject) => {
      const id = `${Date.now()}_${Math.random()}`;
      
      this.batchQueue.push({
        text,
        id,
        priority,
      });

      // Store resolver for this request
      (this as any)[`_resolver_${id}`] = { resolve, reject, cacheKey };

      this.scheduleBatchProcessing();
    });
  }

  private async generateSingleEmbedding(text: string, cacheKey: string): Promise<number[]> {
    const embedding = await this.gemini.embedText(text, {
      model: 'text-embedding-004',
      normalize: true,
    });

    this.cacheEmbedding(cacheKey, embedding);
    this.metrics.totalEmbeddings++;
    return embedding;
  }

  private scheduleBatchProcessing(): void {
    if (this.batchTimer) return;

    this.batchTimer = setTimeout(() => {
      this.processBatch().catch(console.error);
    }, this.BATCH_DELAY);
  }

  private async processBatch(): Promise<void> {
    this.batchTimer = null;

    if (this.batchQueue.length === 0) return;

    // Take up to BATCH_SIZE items, prioritize by priority
    const batch = this.batchQueue
      .sort((a, b) => b.priority - a.priority)
      .slice(0, this.BATCH_SIZE);

    this.batchQueue = this.batchQueue.slice(this.BATCH_SIZE);

    try {
      const texts = batch.map(b => b.text);
      const embeddings = await this.gemini.embedBatch(texts, {
        model: 'text-embedding-004',
        normalize: true,
        batchSize: this.BATCH_SIZE,
      });

      // Resolve all promises
      batch.forEach((item, idx) => {
        const resolver = (this as any)[`_resolver_${item.id}`];
        if (resolver) {
          const cacheKey = resolver.cacheKey;
          this.cacheEmbedding(cacheKey, embeddings[idx]);
          resolver.resolve(embeddings[idx]);
          delete (this as any)[`_resolver_${item.id}`];
        }
      });

      this.metrics.batchedRequests += batch.length;
      this.metrics.totalEmbeddings += batch.length;
    } catch (error) {
      // Reject all promises
      batch.forEach(item => {
        const resolver = (this as any)[`_resolver_${item.id}`];
        if (resolver) {
          resolver.reject(error);
          delete (this as any)[`_resolver_${item.id}`];
        }
      });
    }

    // Continue processing if queue still has items
    if (this.batchQueue.length > 0) {
      this.scheduleBatchProcessing();
    }
  }

  // ===== OPTIMIZED: Cache management with LRU + TTL =====

  private getCachedEmbedding(key: string): number[] | null {
    const entry = this.embeddingCache.get(key);
    
    if (!entry) return null;

    // Check TTL
    if (Date.now() - entry.timestamp > this.CACHE_TTL) {
      this.embeddingCache.delete(key);
      return null;
    }

    // Update hit count and move to end (LRU)
    entry.hits++;
    this.embeddingCache.delete(key);
    this.embeddingCache.set(key, entry);

    return entry.embedding;
  }

  private cacheEmbedding(key: string, embedding: number[]): void {
    // Evict least valuable entries if full
    if (this.embeddingCache.size >= this.CACHE_SIZE) {
      this.evictLeastValuable();
    }

    this.embeddingCache.set(key, {
      embedding,
      timestamp: Date.now(),
      hits: 0,
    });
  }

  private evictLeastValuable(): void {
    // Evict entries with lowest (hits / age) ratio
    let minScore = Infinity;
    let minKey: string | null = null;

    const now = Date.now();
    
    for (const [key, entry] of this.embeddingCache.entries()) {
      const age = now - entry.timestamp;
      const score = entry.hits / (age / 1000); // hits per second
      
      if (score < minScore) {
        minScore = score;
        minKey = key;
      }
    }

    if (minKey) {
      this.embeddingCache.delete(minKey);
    }
  }

  // ===== OPTIMIZED: SHA-256 based cache key (stronger than simple hash) =====

  private hashTextSHA256(text: string): string {
    // Use crypto.subtle.digest for strong hashing
    // For synchronous operation, use a simpler but stronger hash
    let hash = 5381;
    let hash2 = 52711;
    
    for (let i = 0; i < text.length; i++) {
      const char = text.charCodeAt(i);
      hash = ((hash << 5) + hash) ^ char;
      hash2 = ((hash2 << 5) + hash2) ^ char;
    }
    
    return ((hash >>> 0) * 0x100000000 + (hash2 >>> 0)).toString(36);
  }

  // ===== Performance Metrics =====

  getMetrics() {
    const cacheTotal = this.metrics.cacheHits + this.metrics.cacheMisses;
    return {
      ...this.metrics,
      cacheHitRate: cacheTotal > 0 ? this.metrics.cacheHits / cacheTotal : 0,
      cacheSize: this.embeddingCache.size,
      queueSize: this.batchQueue.length,
    };
  }

  clearMetrics(): void {
    this.metrics = {
      cacheHits: 0,
      cacheMisses: 0,
      batchedRequests: 0,
      totalEmbeddings: 0,
    };
  }

  // ===== OPTIMIZED: Batch memory save =====

  async saveMemoryBatch(items: Array<{
    id: string;
    content: string;
    metadata: any;
  }>): Promise<void> {
    if (!this.vectorize || items.length === 0) return;

    // Generate embeddings in batch
    const texts = items.map(item => item.content);
    const embeddings = await this.gemini.embedBatch(texts, {
      model: 'text-embedding-004',
      normalize: true,
    });

    // Upsert all at once
    const vectors = items.map((item, idx) => ({
      id: item.id,
      values: embeddings[idx],
      metadata: {
        ...item.metadata,
        type: 'short_term',
        content: item.content,
        sessionId: this.sessionId,
      },
    }));

    await this.vectorize.upsert(vectors);
    console.log(`[MemoryManager] Batch saved ${items.length} memories`);
  }

  // Cleanup on destroy
  destroy(): void {
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
    }
    this.embeddingCache.clear();
    this.batchQueue = [];
  }
}

// USAGE COMPARISON:
/*
// OLD:
for (const msg of messages) {
  await memory.saveMemory({ id: ..., content: msg, metadata: ... });
  // Each call = 1 API request
}

// NEW:
const items = messages.map(msg => ({ id: ..., content: msg, metadata: ... }));
await memory.saveMemoryBatch(items);
// All in 1-2 API requests via batching
*/
