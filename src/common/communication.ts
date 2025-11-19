// src/common/communication.ts
/**
 * Unified communication protocol for HTTP and WebSocket
 */

export enum MessageType {
  // Client -> Server
  USER_MESSAGE = 'user_message',
  PING = 'ping',
  
  // Server -> Client
  STATUS = 'status',
  CHUNK = 'chunk',
  TOOL_USE = 'tool_use',
  COMPLETE = 'complete',
  ERROR = 'error',
  PONG = 'pong',
}

export interface BaseMessage {
  type: MessageType;
  id?: string; // Correlation ID
  timestamp?: number;
}

export interface UserMessage extends BaseMessage {
  type: MessageType.USER_MESSAGE;
  content: string;
  files?: Array<{
    data: string;
    mimeType: string;
    name: string;
  }>;
}

export interface StatusMessage extends BaseMessage {
  type: MessageType.STATUS;
  message: string;
  progress?: number; // 0-100
}

export interface ChunkMessage extends BaseMessage {
  type: MessageType.CHUNK;
  content: string;
}

export interface ErrorMessage extends BaseMessage {
  type: MessageType.ERROR;
  error: string;
  code?: string;
  retryable?: boolean;
}

export type ServerMessage = StatusMessage | ChunkMessage | ErrorMessage;
export type ClientMessage = UserMessage;

/**
 * Protocol validator
 */
export class MessageValidator {
  static validate(msg: any): msg is BaseMessage {
    return (
      typeof msg === 'object' &&
      msg !== null &&
      typeof msg.type === 'string' &&
      Object.values(MessageType).includes(msg.type)
    );
  }

  static validateUserMessage(msg: any): msg is UserMessage {
    return (
      this.validate(msg) &&
      msg.type === MessageType.USER_MESSAGE &&
      typeof msg.content === 'string'
    );
  }
}

/**
 * Backend WebSocket handler with proper protocol
 */
export class WebSocketHandler {
  private ws: WebSocket;
  private messageId = 0;
  private pendingResponses = new Map<string, {
    resolve: (value: any) => void;
    reject: (error: any) => void;
    timeout: NodeJS.Timeout;
  }>();

  constructor(ws: WebSocket) {
    this.ws = ws;
    this.setupListeners();
  }

  private setupListeners(): void {
    this.ws.addEventListener('message', (event) => {
      try {
        const msg = JSON.parse(event.data);
        
        if (!MessageValidator.validate(msg)) {
          console.error('Invalid message format:', msg);
          return;
        }

        // Handle response correlation
        if (msg.id && this.pendingResponses.has(msg.id)) {
          const pending = this.pendingResponses.get(msg.id)!;
          clearTimeout(pending.timeout);
          this.pendingResponses.delete(msg.id);

          if (msg.type === MessageType.ERROR) {
            pending.reject(new Error(msg.error));
          } else {
            pending.resolve(msg);
          }
        }
      } catch (error) {
        console.error('Message parse error:', error);
      }
    });
  }

  /**
   * Send with correlation ID and timeout
   */
  async sendWithResponse(
    msg: ClientMessage,
    timeoutMs = 30000
  ): Promise<ServerMessage> {
    return new Promise((resolve, reject) => {
      const id = `msg_${++this.messageId}_${Date.now()}`;
      const msgWithId = { ...msg, id, timestamp: Date.now() };

      const timeout = setTimeout(() => {
        this.pendingResponses.delete(id);
        reject(new Error('Response timeout'));
      }, timeoutMs);

      this.pendingResponses.set(id, { resolve, reject, timeout });

      if (this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify(msgWithId));
      } else {
        clearTimeout(timeout);
        this.pendingResponses.delete(id);
        reject(new Error('WebSocket not connected'));
      }
    });
  }

  /**
   * Send without waiting for response
   */
  send(msg: ClientMessage): void {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        ...msg,
        timestamp: Date.now(),
      }));
    }
  }

  /**
   * Cleanup
   */
  destroy(): void {
    for (const [id, pending] of this.pendingResponses) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('WebSocket handler destroyed'));
    }
    this.pendingResponses.clear();
  }
}

/**
 * Frontend connection manager with smart reconnection
 */
export class ConnectionManager {
  private ws: WebSocket | null = null;
  private url: string;
  private reconnectAttempts = 0;
  private maxReconnectDelay = 30000;
  private reconnectTimer: number | null = null;
  private listeners = new Map<string, Set<(msg: ServerMessage) => void>>();
  
  constructor(url: string) {
    this.url = url;
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        resolve();
        return;
      }

      this.ws = new WebSocket(this.url);

      this.ws.onopen = () => {
        this.reconnectAttempts = 0;
        resolve();
      };

      this.ws.onerror = (error) => {
        reject(error);
      };

      this.ws.onclose = () => {
        this.scheduleReconnect();
      };

      this.ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (MessageValidator.validate(msg)) {
            this.notifyListeners(msg.type, msg);
          }
        } catch (error) {
          console.error('Message parse error:', error);
        }
      };
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null) return;

    const delay = Math.min(
      1000 * Math.pow(2, this.reconnectAttempts++),
      this.maxReconnectDelay
    );

    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect().catch(() => {
        // Will retry via onclose
      });
    }, delay);
  }

  on(type: string, callback: (msg: ServerMessage) => void): void {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, new Set());
    }
    this.listeners.get(type)!.add(callback);
  }

  off(type: string, callback: (msg: ServerMessage) => void): void {
    this.listeners.get(type)?.delete(callback);
  }

  private notifyListeners(type: string, msg: ServerMessage): void {
    this.listeners.get(type)?.forEach(cb => cb(msg));
  }

  send(msg: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    } else {
      throw new Error('WebSocket not connected');
    }
  }

  disconnect(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }
}
