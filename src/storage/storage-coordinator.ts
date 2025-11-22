// src/storage/storage-coordinator.ts
/**
 * OPTIMIZATION: Unified storage coordinator to eliminate redundant saves
 * Coordinates writes across DurableStorage, D1, and Vectorize
 */

import type { Message } from '../types';
import type { DurableStorage } from '../durable-storage';
import type { D1Manager } from './d1-manager';
import type { MemoryManager } from '../memory/memory-manager';

interface StorageLayer {
  name: string;
  priority: number; // Lower = more critical
  write: (messages: Message[]) => Promise<void>;
  enabled: boolean;
}

interface CoordinatorConfig {
  batchSize: number;
  flushInterval: number; // ms
  maxRetries: number;
  enablePriorityWrite: boolean;
}

export class StorageCoordinator {
  private layers = new Map<string, StorageLayer>();
  private pendingMessages: Message[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private flushing = false;
  private config: CoordinatorConfig;
  
  private metrics = {
    totalWrites: 0,
    totalMessages: 0,
    failedWrites: 0,
    retries: 0,
  };

  constructor(config: Partial<CoordinatorConfig> = {}) {
    this.config = {
      batchSize: config.batchSize ?? 10,
      flushInterval: config.flushInterval ?? 2000,
      maxRetries: config.maxRetries ?? 3,
      enablePriorityWrite: config.enablePriorityWrite ?? true,
    };
  }

  // ===== Layer Registration =====
  
  registerDurableStorage(storage: DurableStorage): void {
    this.layers.set('durable', {
      name: 'DurableStorage',
      priority: 1, // Highest priority - must succeed
      enabled: true,
      write: async (messages) => {
        for (const msg of messages) {
          await storage.saveMessage(
            msg.role,
            msg.parts || [{ text: msg.content || '' }],
            msg.timestamp
          );
        }
      },
    });
  }

  registerD1(d1: D1Manager, sessionId: string): void {
    this.layers.set('d1', {
      name: 'D1',
      priority: 2,
      enabled: true,
      write: async (messages) => {
        await d1.saveMessages(sessionId, messages);
        await d1.updateSessionActivity(sessionId);
      },
    });
  }

  registerMemory(memory: MemoryManager, sessionId: string): void {
    this.layers.set('memory', {
      name: 'Vectorize',
      priority: 3, // Lowest priority - can fail
      enabled: true,
      write: async (messages) => {
        // Only save non-empty messages with sufficient content
        const items = messages
          .filter(m => {
            const content = this.extractContent(m);
            return content.length > 20; // Skip trivial messages
          })
          .map(m => ({
            id: `${sessionId}_${m.timestamp}_${m.role}`,
            content: this.extractContent(m),
            metadata: {
              sessionId,
              timestamp: m.timestamp || Date.now(),
              role: m.role,
              importance: m.role === 'user' ? 0.8 : 0.7,
            },
          }));

        if (items.length > 0) {
          // Use batch save if available
          if (typeof (memory as any).saveMemoryBatch === 'function') {
            await (memory as any).saveMemoryBatch(items);
          } else {
            // Fallback to individual saves
            for (const item of items) {
              await memory.saveMemory(item as any);
            }
          }
        }
      },
    });
  }

  // ===== Message Queuing =====

  async saveMessage(message: Message): Promise<void> {
    this.pendingMessages.push(message);

    // Immediate flush for critical batches or priority mode
    if (
      this.pendingMessages.length >= this.config.batchSize ||
      this.config.enablePriorityWrite
    ) {
      await this.flush();
    } else {
      this.scheduleFlush();
    }
  }

  // ===== Flush Logic =====

  private scheduleFlush(): void {
    if (this.flushTimer) return;

    this.flushTimer = setTimeout(() => {
      this.flush().catch(console.error);
    }, this.config.flushInterval);
  }

  async flush(): Promise<void> {
    if (this.flushing || this.pendingMessages.length === 0) return;

    // Clear scheduled flush
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    this.flushing = true;
    const messagesToFlush = [...this.pendingMessages];
    this.pendingMessages = [];

    try {
      // Execute writes in priority order with proper error handling
      const sortedLayers = Array.from(this.layers.values())
        .filter(l => l.enabled)
        .sort((a, b) => a.priority - b.priority);

      for (const layer of sortedLayers) {
        await this.writeToLayerWithRetry(layer, messagesToFlush);
      }

      this.metrics.totalWrites++;
      this.metrics.totalMessages += messagesToFlush.length;
      
      console.log(
        `[StorageCoordinator] Flushed ${messagesToFlush.length} messages to ${sortedLayers.length} layers`
      );
    } catch (error) {
      console.error('[StorageCoordinator] Flush failed:', error);
      // Re-queue messages if critical layer failed
      this.pendingMessages.unshift(...messagesToFlush);
      this.metrics.failedWrites++;
    } finally {
      this.flushing = false;
    }
  }

  private async writeToLayerWithRetry(
    layer: StorageLayer,
    messages: Message[]
  ): Promise<void> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < this.config.maxRetries; attempt++) {
      try {
        await layer.write(messages);
        return; // Success
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        console.warn(
          `[StorageCoordinator] ${layer.name} write failed (attempt ${attempt + 1}):`,
          error
        );

        // For critical layers (priority 1), retry with backoff
        if (layer.priority === 1 && attempt < this.config.maxRetries - 1) {
          await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt)));
          this.metrics.retries++;
        } else {
          break;
        }
      }
    }

    // Non-critical layers can fail gracefully
    if (layer.priority > 1) {
      console.warn(`[StorageCoordinator] ${layer.name} write failed, continuing...`);
    } else {
      throw lastError; // Critical layer failure propagates
    }
  }

  // ===== Helpers =====

  private extractContent(message: Message): string {
    if (message.content) return message.content;
    if (message.parts) {
      return message.parts
        .map(p => (typeof p === 'string' ? p : p.text || ''))
        .join(' ');
    }
    return '';
  }

  // ===== Management =====

  enableLayer(name: string): void {
    const layer = this.layers.get(name);
    if (layer) layer.enabled = true;
  }

  disableLayer(name: string): void {
    const layer = this.layers.get(name);
    if (layer) layer.enabled = false;
  }

  getMetrics() {
    return {
      ...this.metrics,
      pendingCount: this.pendingMessages.length,
      activeLayers: Array.from(this.layers.values())
        .filter(l => l.enabled)
        .map(l => l.name),
    };
  }

  async destroy(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
    }
    await this.flush();
    this.layers.clear();
  }
}

// USAGE EXAMPLE in durable-agent.ts:
/*
// In constructor:
this.storageCoordinator = new StorageCoordinator({
  batchSize: 10,
  flushInterval: 2000,
  enablePriorityWrite: false,
});

// During init:
this.storageCoordinator.registerDurableStorage(this.storage);
if (this.d1 && this.sessionId) {
  this.storageCoordinator.registerD1(this.d1, this.sessionId);
}
if (this.memory) {
  this.storageCoordinator.registerMemory(this.memory, this.sessionId!);
}

// When saving messages:
await this.storageCoordinator.saveMessage({
  role: 'user',
  content: userMsg,
  timestamp: Date.now(),
});

// On cleanup:
await this.storageCoordinator.destroy();
*/
