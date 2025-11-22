// src/core/initialization-manager.ts
/**
 * Centralized initialization manager to eliminate redundant init patterns
 * Uses lazy initialization with proper error handling and retries
 */

type InitFunction = () => Promise<void>;

interface InitConfig {
  maxRetries?: number;
  retryDelay?: number;
  timeout?: number;
}

class InitializationManager {
  private states = new Map<string, {
    status: 'idle' | 'initializing' | 'ready' | 'failed';
    promise: Promise<void> | null;
    error: Error | null;
  }>();

  async initialize(
    key: string,
    initFn: InitFunction,
    config: InitConfig = {}
  ): Promise<void> {
    const state = this.states.get(key) || {
      status: 'idle',
      promise: null,
      error: null,
    };

    // If already ready, return immediately
    if (state.status === 'ready') return;

    // If currently initializing, wait for existing promise
    if (state.status === 'initializing' && state.promise) {
      return state.promise;
    }

    // If previously failed and no retries, throw cached error
    if (state.status === 'failed' && state.error) {
      throw state.error;
    }

    // Start new initialization
    state.status = 'initializing';
    state.promise = this.executeInit(key, initFn, config);
    this.states.set(key, state);

    return state.promise;
  }

  private async executeInit(
    key: string,
    initFn: InitFunction,
    config: InitConfig
  ): Promise<void> {
    const maxRetries = config.maxRetries ?? 3;
    const retryDelay = config.retryDelay ?? 1000;
    const timeout = config.timeout ?? 30000;

    let lastError: Error | null = null;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        // Execute with timeout
        await Promise.race([
          initFn(),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Initialization timeout')), timeout)
          ),
        ]);

        // Success - update state
        const state = this.states.get(key)!;
        state.status = 'ready';
        state.error = null;
        this.states.set(key, state);
        return;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        console.warn(`[InitManager] ${key} failed (attempt ${attempt + 1}/${maxRetries}):`, error);

        if (attempt < maxRetries - 1) {
          await new Promise(r => setTimeout(r, retryDelay * Math.pow(2, attempt)));
        }
      }
    }

    // Failed after all retries
    const state = this.states.get(key)!;
    state.status = 'failed';
    state.error = lastError;
    this.states.set(key, state);

    throw lastError;
  }

  isReady(key: string): boolean {
    return this.states.get(key)?.status === 'ready';
  }

  reset(key: string): void {
    this.states.delete(key);
  }

  resetAll(): void {
    this.states.clear();
  }
}

// Singleton instance
export const initManager = new InitializationManager();

// Usage Example in durable-agent.ts:
/*
private async init(): Promise<void> {
  await initManager.initialize('durable-agent', async () => {
    // All initialization logic here
    if (this.sessionId && this.env.VECTORIZE && !this.memory) {
      this.memory = new MemoryManager(...);
    }
    // ... rest of init
  });
}
*/
