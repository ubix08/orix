// src/session/session-manager.ts
import { D1Manager } from '../storage/d1-manager';
import type { Session } from '../types';

export interface SessionConfig {
  autoCreate?: boolean;
  ttlDays?: number;
}

/**
 * Centralized session management to eliminate redundancy
 */
export class SessionManager {
  private d1: D1Manager;
  private config: Required<SessionConfig>;
  private sessionCache: Map<string, Session> = new Map();

  constructor(db: D1Database, config: SessionConfig = {}) {
    this.d1 = new D1Manager(db);
    this.config = {
      autoCreate: config.autoCreate ?? true,
      ttlDays: config.ttlDays ?? 30,
    };
  }

  /**
   * Get or create session - single source of truth
   */
  async getOrCreateSession(sessionId: string, title?: string): Promise<Session> {
    // Check cache first
    if (this.sessionCache.has(sessionId)) {
      return this.sessionCache.get(sessionId)!;
    }

    // Try to fetch from D1
    let session = await this.d1.getSession(sessionId);

    // Create if doesn't exist and autoCreate is enabled
    if (!session && this.config.autoCreate) {
      session = await this.d1.createSession(sessionId, title || 'New Session');
    }

    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    // Cache it
    this.sessionCache.set(sessionId, session);

    // Schedule cleanup of old sessions
    this.scheduleCleanup(sessionId);

    return session;
  }

  /**
   * Update session activity with debouncing
   */
  private activityUpdateTimers: Map<string, NodeJS.Timeout> = new Map();

  async touchSession(sessionId: string): Promise<void> {
    // Debounce activity updates (max 1 per 10 seconds)
    if (this.activityUpdateTimers.has(sessionId)) {
      return;
    }

    const timer = setTimeout(() => {
      this.activityUpdateTimers.delete(sessionId);
    }, 10000);

    this.activityUpdateTimers.set(sessionId, timer);

    await this.d1.updateSessionActivity(sessionId);

    // Update cache
    const cached = this.sessionCache.get(sessionId);
    if (cached) {
      cached.lastActivityAt = Date.now();
    }
  }

  /**
   * List sessions with caching
   */
  async listSessions(limit = 50): Promise<Session[]> {
    return await this.d1.listSessions(limit);
  }

  /**
   * Delete session and cleanup
   */
  async deleteSession(sessionId: string): Promise<void> {
    await this.d1.deleteSession(sessionId);
    this.sessionCache.delete(sessionId);
    
    const timer = this.activityUpdateTimers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      this.activityUpdateTimers.delete(sessionId);
    }
  }

  /**
   * Cleanup old sessions automatically
   */
  private scheduleCleanup(sessionId: string): void {
    // This would be implemented with Durable Object alarms
    // or a cron trigger in production
  }

  /**
   * Validate session ID format
   */
  static validateSessionId(sessionId: string): boolean {
    // UUID v4 format
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    return uuidRegex.test(sessionId);
  }

  /**
   * Generate new session ID
   */
  static generateSessionId(): string {
    return crypto.randomUUID();
  }

  /**
   * Clear cache (for testing)
   */
  clearCache(): void {
    this.sessionCache.clear();
  }
}
