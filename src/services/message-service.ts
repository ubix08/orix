// src/services/message-service.ts
import type { Message } from '../types';
import type { DurableStorage } from '../durable-storage';
import type { MemoryManager } from '../memory/memory-manager';

/**
 * Single responsibility: manage message persistence across all layers
 */
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

  /**
   * Set D1 flush handler
   */
  setD1FlushHandler(handler: (messages: Message[]) => Promise<void>): void {
    this.d1FlushHandler = handler;
  }

  /**
   * Save message to all persistence layers
   * Single point of entry - no duplication
   */
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

    // 3. Save to vector memory (if available)
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
      } catch (error) {
        console.error('[MessageService] Memory save failed:', error);
        // Non-critical, continue
      }
    }

    // 4. Schedule batch flush to D1
    this.scheduleFlush();
  }

  /**
   * Batch flush to D1 (debounced)
   */
  private scheduleFlush(): void {
    if (this.flushScheduled || this.pendingFlush.length === 0) return;
    if (!this.d1FlushHandler) return;

    this.flushScheduled = true;

    // Flush after 2 seconds of inactivity or when 10 messages accumulated
    const delay = this.pendingFlush.length >= 10 ? 0 : 2000;

    setTimeout(async () => {
      if (this.pendingFlush.length === 0) {
        this.flushScheduled = false;
        return;
      }

      const toFlush = [...this.pendingFlush];
      this.pendingFlush = [];

      try {
        await this.d1FlushHandler!(toFlush);
        console.log(`[MessageService] Flushed ${toFlush.length} messages to D1`);
      } catch (error) {
        console.error('[MessageService] D1 flush failed:', error);
        // Re-queue on failure
        this.pendingFlush.unshift(...toFlush);
      } finally {
        this.flushScheduled = false;
      }
    }, delay);
  }

  /**
   * Force flush (for critical saves)
   */
  async flush(): Promise<void> {
    if (this.pendingFlush.length === 0 || !this.d1FlushHandler) return;

    const toFlush = [...this.pendingFlush];
    this.pendingFlush = [];
    this.flushScheduled = false;

    await this.d1FlushHandler(toFlush);
  }

  /**
   * Get messages from storage
   */
  async getMessages(limit?: number): Promise<Message[]> {
    return this.storage.getMessages(limit);
  }

  /**
   * Clear all messages
   */
  async clear(): Promise<void> {
    await this.storage.clearMessages();
    this.pendingFlush = [];
    
    if (this.memory) {
      await this.memory.clearSessionMemory();
    }
  }

  /**
   * Get pending flush count (for diagnostics)
   */
  getPendingCount(): number {
    return this.pendingFlush.length;
  }
}

/**
 * Example usage in durable-agent.ts:
 * 
 * // Initialize once in constructor
 * this.messageService = new MessageService(
 *   this.storage,
 *   this.sessionId,
 *   this.memory
 * );
 * 
 * this.messageService.setD1FlushHandler(async (messages) => {
 *   if (this.d1 && this.sessionId) {
 *     await this.d1.saveMessages(this.sessionId, messages);
 *     await this.d1.updateSessionActivity(this.sessionId);
 *   }
 * });
 * 
 * // Then everywhere, just:
 * await this.messageService.saveMessage('user', userMsg);
 * await this.messageService.saveMessage('model', response);
 */
