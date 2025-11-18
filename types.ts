// src/types.ts - Complete Type Definitions

// =============================================================
// Core Message Types
// =============================================================
export interface Message {
  role: 'user' | 'model';
  parts: Array<{ text: string } | any>;
  timestamp: number;
  tokens?: number;
}

// =============================================================
// Agent Response Types
// =============================================================
export interface AgentResponse {
  response: string;
  toolsUsed: string[];
  conversationHistory: Message[];
  metadata?: {
    tokensUsed?: number;
    processingTime?: number;
    memoryContextUsed?: boolean;
  };
}

// =============================================================
// Tool Types
// =============================================================
export interface ToolCall {
  name: string;
  args: Record<string, any>;
}

export interface ToolResult {
  name: string;
  success: boolean;
  result: string;
  error?: string;
}

export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, any>;
  execute: (args: Record<string, any>, context: ToolContext) => Promise<ToolResult>;
}

export interface ToolContext {
  sessionId: string;
  userId?: string;
  conversationHistory?: Message[];
  [key: string]: any;
}

// =============================================================
// Session & Storage Types
// =============================================================
export interface Session {
  sessionId: string;
  title: string;
  createdAt: number;
  lastActivityAt: number;
  messageCount: number;
  metadata?: Record<string, any>;
}

// =============================================================
// Environment (Cloudflare Workers)
// =============================================================
export interface Env {
  // Durable Object namespace
  AGENT: DurableObjectNamespace;
  
  // API Keys & Secrets
  GEMINI_API_KEY: string;
  JWT_SECRET?: string;
  ADMIN_GMAIL?: string;
  ADMIN_PASSWORD_HASH?: string;
  
  // Storage bindings
  DB?: D1Database;
  VECTORIZE?: VectorizeIndex;
  AI_GATEWAY?: any;
  
  // Environment
  ENVIRONMENT?: string;
}

// =============================================================
// WebSocket Message Types
// =============================================================
export interface WSMessage {
  type: 'message' | 'chunk' | 'status' | 'complete' | 'error';
  content?: string;
  sessionId?: string;
  timestamp?: number;
  error?: string;
  metadata?: Record<string, any>;
}

// =============================================================
// API Request/Response Types
// =============================================================
export interface ChatRequest {
  message: string;
  sessionId?: string;
  options?: {
    temperature?: number;
    maxTokens?: number;
    streaming?: boolean;
  };
}

export interface ChatResponse {
  status: 'processing' | 'complete' | 'error';
  sessionId: string;
  response?: string;
  websocketUrl?: string;
  error?: string;
}

export interface HistoryResponse {
  sessionId: string;
  messages: Message[];
  totalMessages: number;
}

export interface StatusResponse {
  sessionId: string;
  status: 'active' | 'idle';
  messageCount: number;
  lastActivity: number;
  configuration: {
    model: string;
    memoryEnabled: boolean;
    d1Enabled: boolean;
    vectorizeEnabled: boolean;
  };
}

// =============================================================
// Memory Types
// =============================================================
export interface MemoryItem {
  id: string;
  content: string;
  metadata: {
    sessionId: string;
    timestamp: number;
    role: 'user' | 'model';
    importance?: number;
    tags?: string[];
  };
}

export interface MemorySearchResult {
  content: string;
  metadata: any;
  score: number;
  distance: number;
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

// =============================================================
// File Types
// =============================================================
export interface FileMetadata {
  fileUri: string;
  mimeType: string;
  name: string;
  sizeBytes: number;
  uploadedAt: number;
  state: string;
  expiresAt?: number;
}

// =============================================================
// Agent Configuration
// =============================================================
export interface AgentConfig {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  useSearch?: boolean;
  useCodeExecution?: boolean;
  useMapsGrounding?: boolean;
  enableMemory?: boolean;
  maxHistoryMessages?: number;
}

// =============================================================
// Durable Object RPC Interface
// =============================================================
export interface IAutonomousAgent {
  processMessage(userMessage: string, options?: ProcessOptions): Promise<string>;
  processMessageStreaming(userMessage: string, onChunk: (chunk: string) => void): Promise<void>;
  getHistory(limit?: number): Promise<Message[]>;
  clearHistory(): Promise<void>;
  getStatus(): Promise<StatusResponse>;
  updateConfig(config: Partial<AgentConfig>): Promise<void>;
}

export interface ProcessOptions {
  temperature?: number;
  maxTokens?: number;
  includeMemory?: boolean;
}

// =============================================================
// Error Types
// =============================================================
export class AgentError extends Error {
  constructor(
    message: string,
    public code: string,
    public statusCode: number = 500,
    public details?: any
  ) {
    super(message);
    this.name = 'AgentError';
  }
}

export class RateLimitError extends AgentError {
  constructor(message: string = 'Rate limit exceeded') {
    super(message, 'RATE_LIMIT_EXCEEDED', 429);
  }
}

export class AuthenticationError extends AgentError {
  constructor(message: string = 'Authentication failed') {
    super(message, 'AUTH_FAILED', 401);
  }
}
