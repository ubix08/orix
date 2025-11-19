// frontend/src/core/state-manager.js
/**
 * Centralized state management
 */
class StateManager {
  constructor() {
    this.state = {
      currentSessionId: null,
      sessions: [],
      isProcessing: false,
      isConnected: false,
      conversationStarted: false,
    };
    
    this.listeners = new Map();
  }

  get(key) {
    return this.state[key];
  }

  set(key, value) {
    const oldValue = this.state[key];
    this.state[key] = value;
    
    // Notify listeners
    if (this.listeners.has(key)) {
      this.listeners.get(key).forEach(callback => {
        callback(value, oldValue);
      });
    }
  }

  subscribe(key, callback) {
    if (!this.listeners.has(key)) {
      this.listeners.set(key, new Set());
    }
    this.listeners.get(key).add(callback);
    
    // Return unsubscribe function
    return () => this.listeners.get(key).delete(callback);
  }

  // Persist to localStorage
  persist() {
    localStorage.setItem('appState', JSON.stringify({
      currentSessionId: this.state.currentSessionId,
    }));
  }

  // Restore from localStorage
  restore() {
    const saved = localStorage.getItem('appState');
    if (saved) {
      try {
        const data = JSON.parse(saved);
        Object.assign(this.state, data);
      } catch (e) {
        console.error('Failed to restore state:', e);
      }
    }
  }
}

// frontend/src/core/api-client.js
/**
 * API client with request queuing and retry
 */
class ApiClient {
  constructor(baseUrl = '') {
    this.baseUrl = baseUrl;
    this.requestQueue = [];
    this.processing = false;
  }

  async request(endpoint, options = {}) {
    return new Promise((resolve, reject) => {
      this.requestQueue.push({
        endpoint,
        options,
        resolve,
        reject,
        retries: 0,
        maxRetries: 3,
      });
      
      this.processQueue();
    });
  }

  async processQueue() {
    if (this.processing || this.requestQueue.length === 0) return;
    
    this.processing = true;
    const request = this.requestQueue.shift();
    
    try {
      const response = await fetch(
        `${this.baseUrl}${request.endpoint}`,
        {
          ...request.options,
          headers: {
            'Content-Type': 'application/json',
            ...request.options.headers,
          },
        }
      );

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = await response.json();
      request.resolve(data);
    } catch (error) {
      // Retry on network errors
      if (request.retries < request.maxRetries && this.isRetryableError(error)) {
        request.retries++;
        this.requestQueue.unshift(request);
        
        // Exponential backoff
        await this.sleep(1000 * Math.pow(2, request.retries));
      } else {
        request.reject(error);
      }
    } finally {
      this.processing = false;
      
      // Process next request
      if (this.requestQueue.length > 0) {
        setTimeout(() => this.processQueue(), 0);
      }
    }
  }

  isRetryableError(error) {
    return error.message.includes('Failed to fetch') ||
           error.message.includes('NetworkError');
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // Convenience methods
  async get(endpoint) {
    return this.request(endpoint, { method: 'GET' });
  }

  async post(endpoint, body) {
    return this.request(endpoint, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  async delete(endpoint) {
    return this.request(endpoint, { method: 'DELETE' });
  }
}

// frontend/src/features/chat-manager.js
/**
 * Chat-specific business logic
 */
class ChatManager {
  constructor(state, api, ws) {
    this.state = state;
    this.api = api;
    this.ws = ws;
    this.currentMessageElement = null;
  }

  async sendMessage(content, files = []) {
    if (this.state.get('isProcessing')) {
      throw new Error('Already processing a message');
    }

    const sessionId = this.state.get('currentSessionId');
    if (!sessionId) {
      throw new Error('No active session');
    }

    this.state.set('isProcessing', true);

    try {
      // Add user message to UI
      this.addUserMessage(content);

      // Send via WebSocket
      this.ws.send({
        type: 'user_message',
        content,
        files,
      });
    } catch (error) {
      this.state.set('isProcessing', false);
      throw error;
    }
  }

  handleServerMessage(message) {
    switch (message.type) {
      case 'chunk':
        this.handleChunk(message.content);
        break;
      
      case 'complete':
        this.handleComplete();
        break;
      
      case 'error':
        this.handleError(message.error);
        break;
      
      case 'status':
        this.handleStatus(message.message);
        break;
    }
  }

  handleChunk(content) {
    if (!this.currentMessageElement) {
      this.currentMessageElement = this.createMessageElement('assistant');
    }
    this.appendToMessage(this.currentMessageElement, content);
  }

  handleComplete() {
    if (this.currentMessageElement) {
      this.finalizeMessage(this.currentMessageElement);
      this.currentMessageElement = null;
    }
    this.state.set('isProcessing', false);
  }

  handleError(error) {
    console.error('Chat error:', error);
    this.currentMessageElement = null;
    this.state.set('isProcessing', false);
    this.showToast(`Error: ${error}`, 'error');
  }

  handleStatus(message) {
    // Update typing indicator
    this.updateTypingIndicator(message);
  }

  // UI helpers (delegate to UI module)
  addUserMessage(content) {
    // Implementation
  }

  createMessageElement(role) {
    // Implementation
  }

  appendToMessage(element, content) {
    // Implementation
  }

  finalizeMessage(element) {
    // Implementation
  }

  updateTypingIndicator(message) {
    // Implementation
  }

  showToast(message, type) {
    // Implementation
  }
}

// frontend/src/main.js
/**
 * Application initialization and coordination
 */
class Application {
  constructor() {
    this.state = new StateManager();
    this.api = new ApiClient();
    this.ws = null;
    this.chatManager = null;
  }

  async init() {
    // Restore state
    this.state.restore();

    // Initialize session
    await this.initializeSession();

    // Setup WebSocket
    this.ws = new ConnectionManager(this.getWebSocketUrl());
    await this.ws.connect();

    // Initialize chat manager
    this.chatManager = new ChatManager(this.state, this.api, this.ws);

    // Setup message handling
    this.ws.on('message', (msg) => {
      this.chatManager.handleServerMessage(msg);
    });

    // Setup UI event handlers
    this.setupEventHandlers();

    // Load chat history
    await this.loadChatHistory();
  }

  async initializeSession() {
    let sessionId = this.state.get('currentSessionId');

    if (sessionId) {
      // Verify session exists
      try {
        await this.api.get(`/api/sessions/${sessionId}`);
      } catch (e) {
        sessionId = null;
      }
    }

    if (!sessionId) {
      // Create new session
      const session = await this.api.post('/api/sessions', {
        title: 'New Session',
      });
      sessionId = session.sessionId;
    }

    this.state.set('currentSessionId', sessionId);
    this.state.persist();
  }

  getWebSocketUrl() {
    const sessionId = this.state.get('currentSessionId');
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const port = location.port ? ':' + location.port : '';
    return `${protocol}//${location.hostname}${port}/api/ws?session_id=${sessionId}`;
  }

  setupEventHandlers() {
    // Handle form submission
    document.getElementById('chat-form').addEventListener('submit', (e) => {
      e.preventDefault();
      this.handleSendMessage();
    });

    // Handle state changes
    this.state.subscribe('isProcessing', (value) => {
      this.updateUIProcessingState(value);
    });

    this.state.subscribe('isConnected', (value) => {
      this.updateConnectionStatus(value);
    });
  }

  async handleSendMessage() {
    const input = document.getElementById('chat-input');
    const message = input.value.trim();
    
    if (!message) return;

    try {
      await this.chatManager.sendMessage(message);
      input.value = '';
    } catch (error) {
      console.error('Send error:', error);
      this.chatManager.showToast(error.message, 'error');
    }
  }

  async loadChatHistory() {
    const sessionId = this.state.get('currentSessionId');
    const data = await this.api.get(`/api/history?session_id=${sessionId}`);
    
    // Render messages
    if (data.messages) {
      data.messages.forEach(msg => {
        // Render message
      });
    }
  }

  updateUIProcessingState(processing) {
    const input = document.getElementById('chat-input');
    const button = document.getElementById('send-button');
    
    input.disabled = processing;
    button.disabled = processing;
  }

  updateConnectionStatus(connected) {
    const indicator = document.getElementById('status-indicator');
    indicator.className = connected ? 'connected' : 'disconnected';
  }
}

// Initialize app
const app = new Application();
document.addEventListener('DOMContentLoaded', () => app.init());
