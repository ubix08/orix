// src/storage/d1-manager.ts
// Complete implementation from scratch - no migration needed
import type { Message, Session } from '../types';

export class D1Manager {
  private db: D1Database;
  private initialized = false;
  private initPromise: Promise<void> | null = null;

  constructor(db: D1Database) {
    this.db = db;
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;
    if (this.initPromise) {
      await this.initPromise;
      return;
    }
    this.initPromise = this.initialize();
    await this.initPromise;
    this.initialized = true;
  }

  /**
   * Initialize schema from scratch
   * This will create all tables if they don't exist
   * Safe to run multiple times - uses IF NOT EXISTS
   */
  private async initialize(): Promise<void> {
    console.log('[D1Manager] Initializing schema from scratch...');
    
    try {
      // Step 1: Create sessions table
      await this.db
        .prepare(`
          CREATE TABLE IF NOT EXISTS sessions (
            session_id TEXT PRIMARY KEY,
            title TEXT NOT NULL DEFAULT 'New Session',
            created_at INTEGER NOT NULL,
            last_activity_at INTEGER NOT NULL,
            message_count INTEGER DEFAULT 0,
            metadata TEXT DEFAULT '{}'
          )
        `)
        .run();

      console.log('[D1Manager] ✓ Sessions table created');

      // Step 2: Create messages table
      await this.db
        .prepare(`
          CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL,
            role TEXT NOT NULL CHECK(role IN ('user', 'model')),
            content TEXT NOT NULL,
            timestamp INTEGER NOT NULL,
            tokens INTEGER,
            FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
          )
        `)
        .run();

      console.log('[D1Manager] ✓ Messages table created');

      // Step 3: Create unique constraint on messages to prevent duplicates
      // Note: In D1, we need to check if index exists before creating
      try {
        await this.db
          .prepare(`
            CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_message 
            ON messages(session_id, content, timestamp)
          `)
          .run();
        console.log('[D1Manager] ✓ Unique message index created');
      } catch (e) {
        console.log('[D1Manager] Unique message index already exists');
      }

      // Step 4: Create session_snapshots table
      await this.db
        .prepare(`
          CREATE TABLE IF NOT EXISTS session_snapshots (
            session_id TEXT PRIMARY KEY,
            agent_state TEXT NOT NULL,
            updated_at INTEGER NOT NULL,
            FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
          )
        `)
        .run();

      console.log('[D1Manager] ✓ Session snapshots table created');

      // Step 5: Create user_settings table
      await this.db
        .prepare(`
          CREATE TABLE IF NOT EXISTS user_settings (
            id INTEGER PRIMARY KEY CHECK(id = 1),
            auth_hash TEXT,
            gmail TEXT UNIQUE,
            preferences TEXT DEFAULT '{}',
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
          )
        `)
        .run();

      console.log('[D1Manager] ✓ User settings table created');

      // Step 6: Create performance indexes
      try {
        await this.db
          .prepare(`CREATE INDEX IF NOT EXISTS idx_last_activity ON sessions(last_activity_at DESC)`)
          .run();
        console.log('[D1Manager] ✓ Last activity index created');
      } catch (e) {
        console.log('[D1Manager] Last activity index already exists');
      }

      try {
        await this.db
          .prepare(`CREATE INDEX IF NOT EXISTS idx_session_time ON messages(session_id, timestamp)`)
          .run();
        console.log('[D1Manager] ✓ Session time index created');
      } catch (e) {
        console.log('[D1Manager] Session time index already exists');
      }

      console.log('[D1Manager] ✅ Schema initialization complete');
    } catch (error) {
      console.error('[D1Manager] ❌ Initialization failed:', error);
      this.initialized = false;
      this.initPromise = null;
      throw error;
    }
  }

  // =============================================================
  // Session Management
  // =============================================================

  /**
   * Create a new session
   * Returns the created session object
   */
  async createSession(sessionId: string, title?: string): Promise<Session> {
    await this.ensureInitialized();
    const now = Date.now();
    const sessionTitle = title || 'New Session';
    
    try {
      await this.db
        .prepare(`
          INSERT INTO sessions (session_id, title, created_at, last_activity_at, message_count, metadata)
          VALUES (?, ?, ?, ?, 0, '{}')
          ON CONFLICT(session_id) DO NOTHING
        `)
        .bind(sessionId, sessionTitle, now, now)
        .run();

      console.log(`[D1Manager] Created session: ${sessionId}`);

      return {
        sessionId,
        title: sessionTitle,
        createdAt: now,
        lastActivityAt: now,
        messageCount: 0,
        metadata: {},
      };
    } catch (error) {
      console.error('[D1Manager] Failed to create session:', error);
      throw error;
    }
  }

  /**
   * Get a specific session by ID
   */
  async getSession(sessionId: string): Promise<Session | null> {
    await this.ensureInitialized();
    
    try {
      const row = await this.db
        .prepare('SELECT * FROM sessions WHERE session_id = ?')
        .bind(sessionId)
        .first<{
          session_id: string;
          title: string;
          created_at: number;
          last_activity_at: number;
          message_count: number;
          metadata: string;
        }>();
      
      if (!row) return null;
      
      let metadata = {};
      if (row.metadata) {
        try {
          metadata = JSON.parse(row.metadata);
        } catch {
          metadata = {};
        }
      }
      
      return {
        sessionId: row.session_id,
        title: row.title,
        createdAt: row.created_at,
        lastActivityAt: row.last_activity_at,
        messageCount: row.message_count,
        metadata,
      };
    } catch (error) {
      console.error('[D1Manager] Failed to get session:', error);
      return null;
    }
  }

  /**
   * List all sessions, sorted by last activity (newest first)
   */
  async listSessions(limit = 50): Promise<Session[]> {
    await this.ensureInitialized();
    
    try {
      const result = await this.db
        .prepare('SELECT * FROM sessions ORDER BY last_activity_at DESC LIMIT ?')
        .bind(limit)
        .all<{
          session_id: string;
          title: string;
          created_at: number;
          last_activity_at: number;
          message_count: number;
          metadata: string;
        }>();

      const rows = result.results || [];
      
      return rows.map((row) => {
        let metadata = {};
        if (row.metadata) {
          try {
            metadata = JSON.parse(row.metadata);
          } catch {
            metadata = {};
          }
        }
        
        return {
          sessionId: row.session_id,
          title: row.title,
          createdAt: row.created_at,
          lastActivityAt: row.last_activity_at,
          messageCount: row.message_count,
          metadata,
        };
      });
    } catch (error) {
      console.error('[D1Manager] Failed to list sessions:', error);
      return [];
    }
  }

  /**
   * Update session's last activity timestamp
   */
  async updateSessionActivity(sessionId: string): Promise<void> {
    await this.ensureInitialized();
    
    try {
      await this.db
        .prepare('UPDATE sessions SET last_activity_at = ? WHERE session_id = ?')
        .bind(Date.now(), sessionId)
        .run();
    } catch (error) {
      console.error('[D1Manager] Failed to update session activity:', error);
    }
  }

  /**
   * Update session title
   */
  async updateSessionTitle(sessionId: string, title: string): Promise<void> {
    await this.ensureInitialized();
    
    try {
      await this.db
        .prepare('UPDATE sessions SET title = ? WHERE session_id = ?')
        .bind(title, sessionId)
        .run();
      
      console.log(`[D1Manager] Updated session title: ${sessionId}`);
    } catch (error) {
      console.error('[D1Manager] Failed to update session title:', error);
      throw error;
    }
  }

  /**
   * Delete a session and all its messages (cascade)
   */
  async deleteSession(sessionId: string): Promise<void> {
    await this.ensureInitialized();
    
    try {
      await this.db
        .prepare('DELETE FROM sessions WHERE session_id = ?')
        .bind(sessionId)
        .run();
      
      console.log(`[D1Manager] Deleted session: ${sessionId}`);
    } catch (error) {
      console.error('[D1Manager] Failed to delete session:', error);
      throw error;
    }
  }

  // =============================================================
  // Message Management
  // =============================================================

  /**
   * Save messages to a session
   * Uses INSERT OR IGNORE to prevent duplicates
   * Updates message count after insert
   */
  async saveMessages(sessionId: string, messages: Message[]): Promise<void> {
    if (!messages || messages.length === 0) return;
    await this.ensureInitialized();

    try {
      // Ensure session exists
      const session = await this.getSession(sessionId);
      if (!session) {
        await this.createSession(sessionId);
      }

      // Insert all messages
      for (const msg of messages) {
        const content = JSON.stringify(msg.parts ?? [{ text: msg.content }]);
        const ts = msg.timestamp ?? Date.now();
        const tokens = (msg as any).tokens ?? null;
        
        try {
          await this.db
            .prepare(`
              INSERT INTO messages (session_id, role, content, timestamp, tokens)
              VALUES (?, ?, ?, ?, ?)
              ON CONFLICT(session_id, content, timestamp) DO NOTHING
            `)
            .bind(sessionId, msg.role, content, ts, tokens)
            .run();
        } catch (e) {
          console.error('[D1Manager] Failed to insert message:', e);
          // Continue with other messages
        }
      }

      // Update message count
      const countRow = await this.db
        .prepare('SELECT COUNT(*) as count FROM messages WHERE session_id = ?')
        .bind(sessionId)
        .first<{ count: number }>();
      
      const newCount = countRow?.count ?? 0;

      await this.db
        .prepare('UPDATE sessions SET message_count = ?, last_activity_at = ? WHERE session_id = ?')
        .bind(newCount, Date.now(), sessionId)
        .run();

      console.log(`[D1Manager] Saved ${messages.length} messages to session ${sessionId}`);
    } catch (error) {
      console.error('[D1Manager] Failed to save messages:', error);
      throw error;
    }
  }

  /**
   * Load messages for a session
   * Returns messages in chronological order (oldest first)
   */
  async loadMessages(sessionId: string, limit = 200): Promise<Message[]> {
    await this.ensureInitialized();
    
    try {
      const result = await this.db
        .prepare(`
          SELECT role, content, timestamp, tokens
          FROM messages
          WHERE session_id = ?
          ORDER BY timestamp DESC
          LIMIT ?
        `)
        .bind(sessionId, limit)
        .all<{
          role: string;
          content: string;
          timestamp: number;
          tokens?: number;
        }>();

      if (!result.results) return [];

      // Reverse to get chronological order (oldest first)
      return result.results.reverse().map((row) => {
        let parts;
        try {
          parts = JSON.parse(row.content);
        } catch {
          parts = [{ text: row.content }];
        }

        return {
          role: row.role as 'user' | 'model',
          parts,
          timestamp: row.timestamp,
          tokens: row.tokens,
        };
      });
    } catch (error) {
      console.error('[D1Manager] Failed to load messages:', error);
      return [];
    }
  }

  /**
   * Get message count for a session
   */
  async getMessageCount(sessionId: string): Promise<number> {
    await this.ensureInitialized();
    
    try {
      const row = await this.db
        .prepare('SELECT COUNT(*) as count FROM messages WHERE session_id = ?')
        .bind(sessionId)
        .first<{ count: number }>();
      
      return row?.count || 0;
    } catch (error) {
      console.error('[D1Manager] Failed to get message count:', error);
      return 0;
    }
  }

  /**
   * Get timestamp of the latest message in a session
   */
  async getLatestMessageTimestamp(sessionId: string): Promise<number> {
    await this.ensureInitialized();
    
    try {
      const row = await this.db
        .prepare('SELECT MAX(timestamp) as latest FROM messages WHERE session_id = ?')
        .bind(sessionId)
        .first<{ latest: number }>();
      
      return row?.latest ?? 0;
    } catch (error) {
      console.error('[D1Manager] Failed to get latest timestamp:', error);
      return 0;
    }
  }

  // =============================================================
  // Snapshot Management (for agent state persistence)
  // =============================================================

  async saveSnapshot(sessionId: string, state: any): Promise<void> {
    await this.ensureInitialized();
    
    try {
      await this.db
        .prepare(`
          INSERT INTO session_snapshots (session_id, agent_state, updated_at)
          VALUES (?, ?, ?)
          ON CONFLICT(session_id) DO UPDATE SET
            agent_state = excluded.agent_state,
            updated_at = excluded.updated_at
        `)
        .bind(sessionId, JSON.stringify(state), Date.now())
        .run();
    } catch (error) {
      console.error('[D1Manager] Failed to save snapshot:', error);
    }
  }

  async loadSnapshot(sessionId: string): Promise<any | null> {
    await this.ensureInitialized();
    
    try {
      const row = await this.db
        .prepare('SELECT agent_state FROM session_snapshots WHERE session_id = ?')
        .bind(sessionId)
        .first<{ agent_state: string }>();
      
      if (!row) return null;
      
      try {
        return JSON.parse(row.agent_state);
      } catch {
        return null;
      }
    } catch (error) {
      console.error('[D1Manager] Failed to load snapshot:', error);
      return null;
    }
  }

  // =============================================================
  // User Settings
  // =============================================================

  async getUserSettings(): Promise<any | null> {
    await this.ensureInitialized();
    
    try {
      const row = await this.db
        .prepare('SELECT * FROM user_settings WHERE id = 1')
        .first<any>();
      
      if (!row) return null;
      
      if (row.preferences) {
        try {
          row.preferences = JSON.parse(row.preferences);
        } catch {
          row.preferences = {};
        }
      } else {
        row.preferences = {};
      }
      
      return row;
    } catch (error) {
      console.error('[D1Manager] Failed to get user settings:', error);
      return null;
    }
  }

  async saveUserSettings(settings: {
    auth_hash?: string;
    gmail?: string;
    preferences?: Record<string, any>;
  }): Promise<void> {
    await this.ensureInitialized();
    const now = Date.now();
    const prefsJson = settings.preferences ? JSON.stringify(settings.preferences) : '{}';

    try {
      await this.db
        .prepare(`
          INSERT INTO user_settings (id, auth_hash, gmail, preferences, created_at, updated_at)
          VALUES (1, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            auth_hash = COALESCE(excluded.auth_hash, auth_hash),
            gmail = COALESCE(excluded.gmail, gmail),
            preferences = COALESCE(excluded.preferences, preferences),
            updated_at = excluded.updated_at
        `)
        .bind(settings.auth_hash ?? null, settings.gmail ?? null, prefsJson, now, now)
        .run();
    } catch (error) {
      console.error('[D1Manager] Failed to save user settings:', error);
      throw error;
    }
  }

  // =============================================================
  // Health & Stats
  // =============================================================

  async healthCheck(): Promise<boolean> {
    try {
      await this.ensureInitialized();
      await this.db.prepare('SELECT 1').first();
      return true;
    } catch (error) {
      console.error('[D1Manager] Health check failed:', error);
      return false;
    }
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  async reinitialize(): Promise<void> {
    this.initialized = false;
    this.initPromise = null;
    await this.ensureInitialized();
  }

  async getStats(): Promise<{
    totalSessions: number;
    totalMessages: number;
    oldestSession: number | null;
    newestSession: number | null;
  }> {
    await this.ensureInitialized();
    
    try {
      const [sessionCountRow, msgCountRow, oldestRow, newestRow] = await Promise.all([
        this.db.prepare('SELECT COUNT(*) as count FROM sessions').first<{ count: number }>(),
        this.db.prepare('SELECT COUNT(*) as count FROM messages').first<{ count: number }>(),
        this.db.prepare('SELECT MIN(created_at) as oldest FROM sessions').first<{ oldest: number }>(),
        this.db.prepare('SELECT MAX(created_at) as newest FROM sessions').first<{ newest: number }>(),
      ]);

      return {
        totalSessions: sessionCountRow?.count || 0,
        totalMessages: msgCountRow?.count || 0,
        oldestSession: oldestRow?.oldest || null,
        newestSession: newestRow?.newest || null,
      };
    } catch (error) {
      console.error('[D1Manager] Failed to get stats:', error);
      return {
        totalSessions: 0,
        totalMessages: 0,
        oldestSession: null,
        newestSession: null,
      };
    }
  }

  /**
   * Clear all data from database (use with caution!)
   * Useful for testing or complete reset
   */
  async clearAllData(): Promise<void> {
    await this.ensureInitialized();
    
    try {
      await this.db.prepare('DELETE FROM messages').run();
      await this.db.prepare('DELETE FROM sessions').run();
      await this.db.prepare('DELETE FROM session_snapshots').run();
      console.log('[D1Manager] All data cleared');
    } catch (error) {
      console.error('[D1Manager] Failed to clear data:', error);
      throw error;
    }
  }
}

export default D1Manager;
