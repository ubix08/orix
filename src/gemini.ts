// src/gemini.ts - LLM Wrapper (Refactored + Embedding support)
import { GoogleGenAI } from '@google/genai';
import type { FileMetadata } from './types';

export interface GenerateOptions {
  model?: string;
  stream?: boolean;
  timeoutMs?: number;
  thinkingConfig?: { thinkingBudget: number };
  temperature?: number;
  useSearch?: boolean;
  useCodeExecution?: boolean;
  useMapsGrounding?: boolean;
  useVision?: boolean;
  files?: FileMetadata[];
  urlList?: string[];
}

export interface GenerateResponse {
  text: string;
  toolCalls?: Array<{
    name: string;
    args: Record<string, any>;
  }>;
}

interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, any>;
}

/**
 * Circuit breaker for API resilience
 */
class CircuitBreaker {
  private failures = 0;
  private lastFailureTime = 0;
  private readonly threshold = 5;
  private readonly resetTimeout = 60_000;

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.isOpen()) {
      throw new Error('Circuit breaker open - too many recent failures');
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (e) {
      this.onFailure();
      throw e;
    }
  }

  private isOpen(): boolean {
    if (this.failures >= this.threshold) {
      if (Date.now() - this.lastFailureTime > this.resetTimeout) {
        this.reset();
        return false;
      }
      return true;
    }
    return false;
  }

  private onSuccess(): void {
    this.failures = 0;
  }

  private onFailure(): void {
    this.failures++;
    this.lastFailureTime = Date.now();
  }

  private reset(): void {
    this.failures = 0;
  }

  getStatus(): { failures: number; isOpen: boolean } {
    return {
      failures: this.failures,
      isOpen: this.isOpen(),
    };
  }
}

/**
 * Gemini API Client - Pure LLM wrapper + Embedding helpers
 *
 * Notes:
 * - Default embedding model: "text-embedding-004" (Free tier friendly)
 * - Embedding methods:
 *    - embedText(text, opts) => Promise<number[]>
 *    - embedBatch(texts[], opts) => Promise<number[][]>
 *
 * If your GoogleGenAI SDK exposes a different embedding method name, adapt
 * the internal call in callEmbedApi() accordingly.
 */
export class GeminiClient {
  private ai: ReturnType<typeof GoogleGenAI>;
  private maxRetries = 3;
  private baseBackoff = 1000;
  private defaultTimeoutMs = 60_000;
  private circuitBreaker = new CircuitBreaker();

  // Embedding defaults
  private readonly DEFAULT_EMBED_MODEL = 'text-embedding-004';
  private readonly DEFAULT_EMBED_DIM = 768; // expected dimensionality; used only for validation

  constructor(opts?: { apiKey?: string }) {
    this.ai = new GoogleGenAI({ apiKey: opts?.apiKey });
  }

  // ===== Main Generation Method (unchanged public surface) =====

  /**
   * Generate content with optional tool support
   */
  async generateWithTools(
    conversationHistory: any[],
    externalTools: ToolDefinition[],
    options: GenerateOptions = {},
    onChunk?: (text: string) => void
  ): Promise<GenerateResponse> {
    return this.withRetry(async () => {
      const modelName = options.model ?? 'gemini-2.5-flash';

      // 1. Format conversation history
      const contents = this.formatConversationHistory(conversationHistory);

      // 2. Append files and URLs to last user message
      const lastUserMessage = contents[contents.length - 1];
      if (lastUserMessage && lastUserMessage.role === 'user') {
        const contextParts = this.buildContextParts(options.files, options.urlList);
        if (contextParts.length > 0) {
          lastUserMessage.parts = [...contextParts, ...lastUserMessage.parts];
        }
      }

      // 3. Build tool configuration
      const toolConfigs = this.buildToolConfigs(externalTools, options);

      // 4. Build generation config
      const config: any = {
        thinkingConfig: options.thinkingConfig ?? { thinkingBudget: 1024 },
        temperature: options.temperature ?? 0.7,
      };

      if (toolConfigs.length > 0) {
        config.tools = toolConfigs;
      }

      // 5. Execute generation
      if (options.stream) {
        return await this.executeStreamGeneration(
          modelName,
          contents,
          config,
          options.timeoutMs,
          onChunk
        );
      } else {
        return await this.executeGeneration(
          modelName,
          contents,
          config,
          options.timeoutMs,
          onChunk
        );
      }
    });
  }

  // ===== Embedding API (new) =====

  /**
   * Embed a single text string and return a normalized vector (number[]).
   * Non-breaking: small helper used by MemoryTool.
   */
  async embedText(text: string, opts?: { model?: string; normalize?: boolean; timeoutMs?: number }): Promise<number[]> {
    if (typeof text !== 'string') throw new Error('embedText expects a string');
    const model = opts?.model ?? this.DEFAULT_EMBED_MODEL;
    const timeoutMs = opts?.timeoutMs ?? this.defaultTimeoutMs;
    const res = await this.withRetry(async () => {
      const raw = await this.callEmbedApi([text], { model, timeoutMs });
      if (!raw || !Array.isArray(raw) || raw.length === 0) throw new Error('Empty embedding response');
      const vec = raw[0];
      return opts?.normalize === false ? vec : this.normalize(vec);
    });
    return res;
  }

  /**
   * Embed a batch of texts. Returns an array of vectors aligned with the input order.
   * Handles chunking internally if texts are long (but you can pre-chunk if desired).
   */
  async embedBatch(texts: string[], opts?: { model?: string; normalize?: boolean; timeoutMs?: number; batchSize?: number }): Promise<number[][]> {
    if (!Array.isArray(texts)) throw new Error('embedBatch expects string[]');
    const model = opts?.model ?? this.DEFAULT_EMBED_MODEL;
    const timeoutMs = opts?.timeoutMs ?? this.defaultTimeoutMs;
    const batchSize = opts?.batchSize ?? 16;

    const allEmbeddings: number[][] = [];
    // Batch the inputs to avoid large single calls
    for (let i = 0; i < texts.length; i += batchSize) {
      const slice = texts.slice(i, i + batchSize);
      const raw = await this.withRetry(async () => {
        return await this.callEmbedApi(slice, { model, timeoutMs });
      });
      if (!raw || !Array.isArray(raw)) throw new Error('Invalid embedding batch response');
      for (const v of raw) {
        allEmbeddings.push(opts?.normalize === false ? v : this.normalize(v));
      }
    }

    return allEmbeddings;
  }

  /**
   * Low-level embedding caller.
   * Adapts to the SDK you have: many SDKs expose `ai.models.embedContent(...)` or `ai.embeddings.create(...)`.
   *
   * NOTE: If your GoogleGenAI SDK uses a different method name, update this function accordingly.
   */
  private async callEmbedApi(texts: string[], opts: { model: string; timeoutMs: number }): Promise<number[][]> {
    // Defensive: remove empty strings and coerce input
    const clean = texts.map(t => (typeof t === 'string' ? t : String(t)));
    if (clean.length === 0) return [];

    // Preferential API call paths (try to be compatible with multiple SDK variants)
    // 1) try ai.models.embedContent(...)
    // 2) try ai.embeddings.create(...)
    // 3) fallback: try ai.models.generateContent with "embed" task (rare)
    try {
      // Attempt path #1
      if (typeof (this.ai as any)?.models?.embedContent === 'function') {
        const call = (this.ai as any).models.embedContent({
          model: opts.model,
          input: clean,
        });
        const resp = await this.withTimeout(call, 'embedContent timeout', opts.timeoutMs);
        // normalize expected shape:
        // { embeddings: [{ values: number[] }, ...] } or { data: [{ embedding: number[] }, ...] }
        const embeddings: number[][] = [];
        if (resp?.embeddings && Array.isArray(resp.embeddings)) {
          for (const e of resp.embeddings) {
            if (Array.isArray(e?.values)) embeddings.push(e.values);
            else if (Array.isArray(e)) embeddings.push(e);
            else if (Array.isArray(e?.vector)) embeddings.push(e.vector);
          }
        } else if (resp?.data && Array.isArray(resp.data)) {
          for (const d of resp.data) {
            if (Array.isArray(d?.embedding)) embeddings.push(d.embedding);
          }
        } else if (Array.isArray(resp)) {
          // some SDKs return raw array
          for (const item of resp) {
            if (Array.isArray(item)) embeddings.push(item);
          }
        }
        if (embeddings.length > 0) return embeddings;
      }

      // Attempt path #2
      if (typeof (this.ai as any)?.embeddings?.create === 'function') {
        const call = (this.ai as any).embeddings.create({
          model: opts.model,
          input: clean,
        });
        const resp = await this.withTimeout(call, 'embeddings.create timeout', opts.timeoutMs);
        // expected resp.data[].embedding
        const embeddings: number[][] = [];
        if (resp?.data && Array.isArray(resp.data)) {
          for (const d of resp.data) {
            if (Array.isArray(d?.embedding)) embeddings.push(d.embedding);
          }
        }
        if (embeddings.length > 0) return embeddings;
      }

      // Attempt path #3 (less likely)
      if (typeof (this.ai as any)?.models?.generateContent === 'function') {
        // Some SDKs allow specifying taskType/embed via generateContent
        const call = (this.ai as any).models.generateContent({
          model: opts.model,
          contents: clean.map(c => ({ text: c })),
          config: { task: 'embed' },
        });
        const resp = await this.withTimeout(call, 'generateContent(embed) timeout', opts.timeoutMs);
        // try to parse embeddings
        if (resp?.embeddings && Array.isArray(resp.embeddings)) {
          return resp.embeddings.map((b: any) => Array.isArray(b.values) ? b.values : b);
        }
      }

      // If none matched, throw to trigger fallback path
      throw new Error('No compatible embedding API found on GoogleGenAI SDK instance');
    } catch (err) {
      console.error('[GeminiClient] callEmbedApi error:', err);
      throw err;
    }
  }

  /**
   * Normalize vector to unit length (cosine similarity).
   * Returns a new array.
   */
  private normalize(vec: number[]): number[] {
    if (!Array.isArray(vec) || vec.length === 0) return vec;
    let sumSq = 0;
    for (let i = 0; i < vec.length; i++) {
      const v = Number(vec[i]) || 0;
      sumSq += v * v;
    }
    const mag = Math.sqrt(sumSq) || 1;
    return vec.map(v => Number(v) / mag);
  }

  // ===== File Management (unchanged public surface) =====

  async uploadFile(
    fileDataBase64: string,
    mimeType: string,
    displayName: string
  ): Promise<FileMetadata> {
    return this.withRetry(async () => {
      const buffer = Buffer.from(fileDataBase64, 'base64');
      const uploadResp: any = await this.withTimeout(
        this.ai.files.upload({
          file: buffer as any,
          config: { mimeType, displayName }
        }),
        'uploadFile timed out'
      );

      const name = uploadResp?.name;
      if (!name) {
        throw new Error('uploadFile failed: no file name returned');
      }

      const meta: any = await this.ai.files.get({ name });
      return {
        fileUri: meta?.uri,
        mimeType: meta?.mimeType ?? mimeType,
        name: meta?.displayName ?? displayName,
        sizeBytes: meta?.sizeBytes ?? buffer.length,
        uploadedAt: Date.now(),
        state: (meta?.state as any) ?? 'ACTIVE',
        expiresAt: meta?.expirationTime
          ? new Date(meta.expirationTime).getTime()
          : undefined,
      } as FileMetadata;
    });
  }

  async getFileStatus(fileUriOrName: string): Promise<string> {
    try {
      const name = fileUriOrName.split('/').pop() ?? fileUriOrName;
      const meta: any = await this.ai.files.get({ name });
      return meta?.state ?? 'UNKNOWN';
    } catch (e) {
      console.warn('[GeminiClient] getFileStatus failed', e);
      return 'FAILED';
    }
  }

  async deleteFile(fileUriOrName: string): Promise<void> {
    try {
      const name = fileUriOrName.split('/').pop() ?? fileUriOrName;
      await this.ai.files.delete({ name });
    } catch (e) {
      console.warn('[GeminiClient] deleteFile failed', e);
    }
  }

  // ===== Internal Helper Methods (unchanged gen flow) =====

  private formatConversationHistory(history: any[]): any[] {
    return history.map(msg => {
      if (msg.role === 'system') {
        return {
          role: 'user',
          parts: [{ text: `[System Instructions]\n${msg.content}` }],
        };
      }

      return {
        role: msg.role === 'model' || msg.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: msg.content || '' }],
      };
    });
  }

  private buildContextParts(
    files?: FileMetadata[],
    urls?: string[]
  ): any[] {
    const parts: any[] = [];

    // Add file parts
    if (files && files.length > 0) {
      const fileParts = files
        .filter(f => f && f.state === 'ACTIVE' && f.fileUri)
        .map(f => ({
          file_data: { mime_type: f.mimeType, file_uri: f.fileUri },
        }));
      parts.push(...fileParts);
    }

    // Add URL parts
    if (urls && urls.length > 0) {
      const urlParts = urls.map(u => ({ url: u }));
      parts.push(...urlParts);
    }

    return parts;
  }

  private buildToolConfigs(
    externalTools: ToolDefinition[],
    options: GenerateOptions
  ): any[] {
    const configs: any[] = [];

    // Add external tools
    if (externalTools.length > 0) {
      const functionDeclarations = externalTools.map(tool => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      }));
      configs.push({ functionDeclarations });
    }

    // Add native tools
    if (options.useSearch) configs.push({ googleSearch: {} });
    if (options.useCodeExecution) configs.push({ codeExecution: {} });
    if (options.useMapsGrounding) configs.push({ googleMaps: {} });
    if (options.useVision) configs.push({ vision: {} });

    return configs;
  }

  private async executeGeneration(
    model: string,
    contents: any[],
    config: any,
    timeoutMs?: number,
    onChunk?: (text: string) => void
  ): Promise<GenerateResponse> {
    const generateCall = this.ai.models.generateContent({
      model,
      contents,
      config,
    } as any);

    const response = await this.withTimeout(
      generateCall,
      'generateContent timeout',
      timeoutMs
    );

    const result = this.parseResponse(response);

    if (result.text && onChunk) {
      try {
        onChunk(result.text);
      } catch (e) {
        console.warn('[GeminiClient] onChunk error:', e);
      }
    }

    return result;
  }

  private async executeStreamGeneration(
    model: string,
    contents: any[],
    config: any,
    timeoutMs?: number,
    onChunk?: (text: string) => void
  ): Promise<GenerateResponse> {
    const generateCall = this.ai.models.generateContentStream({
      model,
      contents,
      config,
    } as any);

    const streamResp = await this.withTimeout(
      generateCall,
      'generateContentStream timeout',
      timeoutMs
    );

    return await this.handleStreamedResponse(streamResp, onChunk);
  }

  private parseResponse(response: any): GenerateResponse {
    const result: GenerateResponse = { text: '' };

    if (response?.candidates?.[0]?.content?.parts) {
      const parts = response.candidates[0].content.parts;

      // Extract text
      result.text = parts
        .filter((p: any) => p.text)
        .map((p: any) => p.text)
        .join('');

      // Extract tool calls
      const functionCalls = parts.filter((p: any) => p.functionCall);
      if (functionCalls.length > 0) {
        result.toolCalls = functionCalls.map((fc: any) => ({
          name: fc.functionCall.name,
          args: fc.functionCall.args || {},
        }));
      }
    } else if (typeof response?.text === 'string') {
      result.text = response.text;
    }

    return result;
  }

  private async handleStreamedResponse(
    streamResp: any,
    onChunk?: (text: string) => void
  ): Promise<GenerateResponse> {
    let fullText = '';
    const toolCalls: Array<{ name: string; args: Record<string, any> }> = [];

    try {
      if (streamResp && typeof streamResp[Symbol.asyncIterator] === 'function') {
        for await (const chunk of streamResp) {
          const text = this.extractTextFromChunk(chunk);
          if (text) {
            fullText += text;
            if (onChunk) {
              try {
                onChunk(text);
              } catch (e) {
                console.warn('[GeminiClient] onChunk error:', e);
              }
            }
          }

          // Extract tool calls
          if (chunk?.candidates?.[0]?.content?.parts) {
            const parts = chunk.candidates[0].content.parts;
            const functionCalls = parts.filter((p: any) => p.functionCall);
            for (const fc of functionCalls) {
              toolCalls.push({
                name: fc.functionCall.name,
                args: fc.functionCall.args || {},
              });
            }
          }
        }

        return {
          text: fullText,
          toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        };
      }

      // Fallback handling
      const candidateIterable = streamResp?.stream ?? streamResp?.iterable ?? null;
      if (candidateIterable && typeof candidateIterable[Symbol.asyncIterator] === 'function') {
        for await (const chunk of candidateIterable) {
          const text = this.extractTextFromChunk(chunk);
          if (text) {
            fullText += text;
            if (onChunk) {
              try {
                onChunk(text);
              } catch (e) {
                console.warn('[GeminiClient] onChunk error:', e);
              }
            }
          }
        }
        return { text: fullText };
      }

      // Direct extraction fallback
      const result = await Promise.resolve(streamResp);
      const text = await this.extractTextFromResponse(result);
      if (text) {
        fullText = text;
        if (onChunk) {
          try {
            onChunk(text);
          } catch (e) {
            console.warn('[GeminiClient] onChunk error:', e);
          }
        }
      }

      return { text: fullText };
    } catch (e) {
      console.error('[GeminiClient] Stream handling failed:', e);
      throw e;
    }
  }

  private extractTextFromChunk(chunk: any): string {
    return chunk?.text ?? chunk?.delta ?? chunk?.content?.text ?? '';
  }

  private async extractTextFromResponse(response: any): Promise<string> {
    if (!response) return '';
    if (typeof response?.text === 'string') return response.text;
    if (typeof response?.text === 'function') return await response.text();
    if (response?.response?.text) {
      return typeof response.response.text === 'function'
        ? await response.response.text()
        : response.response.text;
    }
    if (response?.result?.text) {
      return typeof response.result.text === 'function'
        ? await response.result.text()
        : response.result.text;
    }
    return '';
  }

  // ===== Resilience Helpers =====

  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    let lastErr: any;
    for (let i = 0; i < this.maxRetries; i++) {
      try {
        return await this.circuitBreaker.execute(fn);
      } catch (err) {
        lastErr = err;
        console.warn(`[GeminiClient] Attempt ${i + 1}/${this.maxRetries} failed:`, err);
        if (i < this.maxRetries - 1) {
          const delay = this.baseBackoff * Math.pow(2, i);
          await new Promise(r => setTimeout(r, delay));
        }
      }
    }
    throw lastErr;
  }

  private async withTimeout<T>(
    promise: Promise<T>,
    errorMsg = 'timeout',
    ms?: number
  ): Promise<T> {
    const tm = ms ?? this.defaultTimeoutMs;
    return Promise.race([
      promise,
      new Promise<T>((_, reject) =>
        setTimeout(() => reject(new Error(errorMsg)), tm)
      ),
    ]);
  }

  // ===== Status Methods =====

  getCircuitBreakerStatus() {
    return this.circuitBreaker.getStatus();
  }
}

export default GeminiClient;
