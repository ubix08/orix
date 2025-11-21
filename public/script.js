/*  Orion-Chat — Enhanced with orchestration support for multi-step tasks  */

/* ---------- 0. Tiny helpers ---------- */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const escapeHtml = (text) => {
  const d = document.createElement('div');
  d.textContent = String(text);
  return d.innerHTML;
};

/* ---------- 1. Wait for libs ---------- */
let libsReady = false;
function waitLibs() {
  return new Promise((res) => {
    const t = setInterval(() => {
      if (typeof marked !== 'undefined' && typeof hljs !== 'undefined') {
        clearInterval(t);
        libsReady = true;
        res();
      }
    }, 60);
  });
}

/* ---------- 2. DOM cache ---------- */
const $ = (id) => document.getElementById(id);
const chatContainer = $('messages-area');
const chatMessages = $('messages-wrapper');
const welcomeScreen = $('welcome-message');
const userInput = $('chat-input');
const sendButton = $('send-button');
const typingIndicator = $('typing-indicator');
const typingText = $('typing-text');
const fileInput = $('file-input');
const filePreview = $('file-preview');
const sidebar = $('sidebar');
const menuBtn = $('menu-btn');
const overlay = $('overlay');
const userInfo = $('user-info');

/* ---------- 3. State with session and task management ---------- */
let ws = null,
  isConnecting = false,
  reconnectAttempts = 0;
let isProcessing = false,
  currentMessageEl = null;
let pendingFiles = [],
  conversationStarted = false;
let isNewSession = false;
const MAX_RECONNECT_DELAY = 30000;

// Session management state
let currentSessionId = null;
let sessions = [];

// Task orchestration state
let currentTaskBoard = null;
let taskProgressEl = null;

/* ---------- 4. Init ---------- */
window.addEventListener('DOMContentLoaded', async () => {
  await waitLibs();
  configureMarked();

  // Initialize session management
  await initializeSession();

  setupFileUpload();
  setupInputHandlers();
  setupSidebarToggle();
  checkMobileView();

  // Load sessions list
  await loadSessionsList();
});

window.addEventListener('resize', checkMobileView);
window.addEventListener('beforeunload', () => {
  if (ws) try { ws.close(); } catch {}
});

/* ---------- 5. Session Management ---------- */
async function initializeSession() {
  // Try to get session ID from localStorage
  const storedSessionId = localStorage.getItem('currentSessionId');

  if (storedSessionId) {
    // Verify session still exists
    try {
      const response = await fetch(`/api/sessions/${storedSessionId}`);
      if (response.ok) {
        currentSessionId = storedSessionId;
        console.log('Restored session:', currentSessionId);
        await loadChatHistory();
        connectWebSocket();
        updateUserInfo();
        return;
      }
    } catch (e) {
      console.log('Failed to restore session, creating new one', e);
    }
  }

  // Create new session
  await createNewSession();
}

async function createNewSession(title = 'New Session') {
  try {
    const response = await fetch('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title }),
    });

    if (!response.ok) {
      throw new Error('Failed to create session');
    }

    const session = await response.json();
    currentSessionId = session.sessionId || session.id || session.session_id;

    if (!currentSessionId) throw new Error('Missing session id in response');

    localStorage.setItem('currentSessionId', currentSessionId);
    console.log('Created new session:', currentSessionId);

    isNewSession = true;
    updateUserInfo();
    connectWebSocket();
    await loadSessionsList();

    return session;
  } catch (e) {
    console.error('Failed to create session:', e);
    addToast('Failed to create session', 'error');
    throw e;
  }
}

async function loadSessionsList() {
  try {
    const response = await fetch('/api/sessions');
    if (!response.ok) return;

    const data = await response.json();
    sessions = data.sessions || [];

    renderSessionsList();
  } catch (e) {
    console.error('Failed to load sessions:', e);
  }
}

function renderSessionsList() {
  const container = document.querySelector('nav ul');
  if (!container) return;

  container.innerHTML = '';

  sessions.forEach((session) => {
    const id = session.sessionId || session.id;
    const title = session.title || session.name || id;
    const li = document.createElement('li');
    li.className = `p-2 text-sm rounded-lg hover:bg-gray-800 transition-colors cursor-pointer truncate ${
      id === currentSessionId ? 'bg-gray-800 text-white' : 'text-gray-400'
    }`;
    li.innerHTML = `
      <div class="flex items-center gap-2">
        <span class="truncate flex-1">${title}</span>
        <button onclick="deleteSession('${id}')" class="text-red-400 hover:text-red-300">
          <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
          </svg>
        </button>
      </div>
    `;
    li.addEventListener('click', () => switchToSession(id));
    container.appendChild(li);
  });
}

async function switchToSession(sessionId) {
  if (sessionId === currentSessionId) return;

  if (ws) {
    try { ws.close(); } catch {}
    ws = null;
  }

  if (chatMessages) chatMessages.innerHTML = '';
  conversationStarted = false;
  welcomeScreen?.classList.remove('hidden');
  currentTaskBoard = null;
  taskProgressEl = null;

  currentSessionId = sessionId;
  localStorage.setItem('currentSessionId', sessionId);

  updateUserInfo();
  await loadChatHistory();
  connectWebSocket();

  if (window.innerWidth <= 768 && sidebar && overlay) {
    sidebar.classList.add('-translate-x-full');
    overlay.classList.add('hidden');
  }
}

window.deleteSession = async function (id) {
  event.stopPropagation();
  if (!confirm('Delete this session? This action cannot be undone.')) return;

  try {
    const response = await fetch(`/api/sessions/${id}`, { method: 'DELETE' });
    if (!response.ok) throw new Error('Failed to delete session');

    if (id === currentSessionId) {
      await createNewSession();
    }

    await loadSessionsList();
    addToast('Session deleted', 'success');
  } catch (e) {
    console.error('Failed to delete session:', e);
    addToast('Failed to delete session', 'error');
  }
};

async function generateSessionTitle() {
  try {
    const response = await fetch(`/api/memory/summarize?session_id=${encodeURIComponent(currentSessionId)}`, {
      method: 'POST',
    });
    if (!response.ok) throw new Error('Failed to summarize session');

    const data = await response.json();
    const title = data.summary.slice(0, 50) + (data.summary.length > 50 ? '...' : '');

    await updateSessionTitle(title);
  } catch (e) {
    console.error('Failed to generate title:', e);
  }
}

async function updateSessionTitle(title) {
  try {
    const response = await fetch(`/api/sessions/${encodeURIComponent(currentSessionId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title }),
    });
    if (!response.ok) throw new Error('Failed to update title');

    await loadSessionsList();
  } catch (e) {
    console.error('Failed to update title:', e);
  }
}

function updateUserInfo() {
  if (userInfo && currentSessionId) {
    userInfo.textContent = `Session: ${currentSessionId.slice(0, 8)}...`;
  }
}

/* ---------- 6. Marked ---------- */
function configureMarked() {
  marked.setOptions({
    breaks: true,
    gfm: true,
    headerIds: false,
    mangle: false,
    highlight(code, lang) {
      if (lang && hljs.getLanguage(lang)) {
        try {
          return hljs.highlight(code, { language: lang }).value;
        } catch {}
      }
      return hljs.highlightAuto(code).value;
    },
  });
}

/* ---------- 7. WebSocket with session support ---------- */
async function connectWebSocket() {
  if (!currentSessionId) {
    console.error('Cannot connect WebSocket without session ID');
    return;
  }

  if ((ws && ws.readyState === WebSocket.OPEN) || isConnecting) return;

  isConnecting = true;
  updateConnectionStatus('Connecting…', 'bg-gray-500');

  const origin = location.origin.replace(/^http/, 'ws');
  const url = `${origin}/api/ws?session_id=${encodeURIComponent(currentSessionId)}`;

  try {
    ws = new WebSocket(url);
  } catch (e) {
    console.error('WS create error', e);
    isConnecting = false;
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    isConnecting = false;
    reconnectAttempts = 0;
    updateConnectionStatus('Connected', 'bg-teal-500');
  };

  ws.onclose = () => {
    isConnecting = false;
    updateConnectionStatus('Disconnected', 'bg-red-500');
    scheduleReconnect();
  };

  ws.onerror = (e) => {
    console.error('WS error', e);
    updateConnectionStatus('Error', 'bg-red-500');
  };

  ws.onmessage = (e) => {
    try {
      handleServerMessage(JSON.parse(e.data));
    } catch (err) {
      console.error('Bad json', err, e.data);
    }
  };
}

function scheduleReconnect() {
  const delay = Math.min(1000 * Math.pow(2, reconnectAttempts++), MAX_RECONNECT_DELAY);
  setTimeout(() => {
    if (currentSessionId) connectWebSocket();
  }, delay);
}

/* ---------- 8. Mobile ---------- */
function checkMobileView() {
  const mobile = window.innerWidth <= 768;
  if (mobile && sidebar && overlay) {
    sidebar.classList.add('-translate-x-full');
    overlay.classList.add('hidden');
  }
}

function setupSidebarToggle() {
  menuBtn?.addEventListener('click', () => {
    sidebar?.classList.toggle('-translate-x-full');
    overlay?.classList.toggle('hidden');
  });

  overlay?.addEventListener('click', () => {
    sidebar?.classList.add('-translate-x-full');
    overlay?.classList.add('hidden');
  });
}

/* ---------- 9. File upload ---------- */
function setupFileUpload() {
  const attachBtn = $('attach-file-button');
  if (attachBtn) {
    attachBtn.addEventListener('click', () => {
      fileInput?.click();
      $('tools-popup')?.classList.add('pointer-events-none');
    });
  }

  fileInput?.addEventListener('change', async (e) => {
    const files = Array.from(e.target.files || []);
    for (const file of files) {
      if (file.size > 20 * 1024 * 1024) {
        addToast(`${file.name} too large`, 'error');
        continue;
      }
      try {
        const base64 = await fileToBase64(file);
        pendingFiles.push({
          data: base64.split(',')[1],
          mimeType: file.type,
          name: file.name,
          size: file.size,
        });
        addFileChip(file);
        addToast(`Added ${file.name}`, 'success');
      } catch {
        addToast(`Failed ${file.name}`, 'error');
      }
    }
    fileInput.value = '';
  });
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function addFileChip(file) {
  if (!filePreview) return;
  const chip = document.createElement('div');
  chip.className = 'flex items-center gap-2 px-3 py-1 rounded-full bg-white/10 text-xs text-white';
  chip.dataset.fileName = file.name;
  chip.innerHTML = `
    <span>${getFileIcon(file.type, file.name)}</span>
    <span class="truncate max-w-[150px]">${escapeHtml(file.name)}</span>
    <span class="text-gray-400">(${formatFileSize(file.size)})</span>
    <button type="button" class="text-gray-400 hover:text-white transition-colors ml-1" aria-label="Remove file">
      <svg class="w-4 h-4" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor">
        <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z"/>
      </svg>
    </button>`;
  filePreview.appendChild(chip);

  const btn = chip.querySelector('button');
  btn?.addEventListener('click', () => removeFileChip(file.name));
}

window.removeFileChip = function (name) {
  pendingFiles = pendingFiles.filter((f) => f.name !== name);
  document.querySelectorAll(`[data-file-name="${CSS.escape(name)}"]`).forEach((el) => el.remove());
};

function formatFileSize(b) {
  return b < 1024
    ? b + ' B'
    : b < 1048576
    ? (b / 1024).toFixed(1) + ' KB'
    : (b / 1048576).toFixed(1) + ' MB';
}

function getFileIcon(mime, name) {
  if (!mime) return '📎';
  if (mime.startsWith('image/')) return '🖼️';
  if (mime.includes('pdf')) return '📄';
  if (mime.includes('word') || name.endsWith('.doc') || name.endsWith('.docx')) return '📝';
  if (mime.includes('sheet') || name.endsWith('.csv') || name.endsWith('.xlsx')) return '📊';
  if (mime.includes('json')) return '📋';
  if (mime.includes('text')) return '📃';
  return '📎';
}

/* ---------- 10. Input ---------- */
function setupInputHandlers() {
  const form = $('chat-form');

  if (userInput) {
    userInput.addEventListener('input', () => {
      userInput.style.height = 'auto';
      userInput.style.height = Math.min(userInput.scrollHeight, 200) + 'px';
    });
  }

  if (form) {
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      sendMessage();
    });
  }

  const toolsBtn = $('tools-btn');
  const toolsPopup = $('tools-popup');
  if (toolsBtn && toolsPopup) {
    toolsBtn.addEventListener('click', () => {
      toolsPopup.classList.toggle('pointer-events-none');
      toolsPopup.classList.toggle('opacity-0');
      toolsPopup.classList.toggle('translate-y-2');
    });

    document.addEventListener('click', (e) => {
      if (!toolsPopup.contains(e.target) && !toolsBtn.contains(e.target)) {
        toolsPopup.classList.add('pointer-events-none', 'opacity-0', 'translate-y-2');
      }
    });
  }
}

/* ---------- 11. Send with session ID ---------- */
async function sendMessage() {
  const msg = (userInput?.value || '').trim();
  if ((msg === '' && pendingFiles.length === 0) || isProcessing) return;

  if (!currentSessionId) {
    addToast('No active session', 'error');
    return;
  }

  if (!ws || ws.readyState !== WebSocket.OPEN) {
    addToast('Connecting…', 'info');
    connectWebSocket();
    await sleep(1200);
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      addToast('Still connecting – please retry', 'error');
      return;
    }
  }

  isProcessing = true;
  disableInput();
  hideWelcome();
  addUserMessage(msg || 'Sent files for analysis.');
  if (userInput) userInput.value = '';
  if (userInput) userInput.style.height = 'auto';
  showTypingIndicator('Processing…');

  try {
    const payload = {
      type: 'user_message',
      content: msg,
      files: pendingFiles.length ? pendingFiles : undefined,
    };
    ws.send(JSON.stringify(payload));
  } catch (e) {
    console.error('send error', e);
    addToast('Send failed – please retry', 'error');
    isProcessing = false;
    enableInput(true);
    hideTypingIndicator();
  }
}

/* ---------- 12. Server messages with orchestration support ---------- */
function handleServerMessage(d) {
  console.log('Server message:', d.type, d);

  switch (d.type) {
    case 'status':
      updateTypingIndicator(d.message);
      break;

    case 'chunk':
      if (!currentMessageEl) {
        hideWelcome();
        currentMessageEl = createMessageElement('assistant');
      }
      appendToMessage(currentMessageEl, d.content);
      scrollToBottom(true);
      break;

    case 'tool_use':
      if (d.tools?.length) showToolUse(d.tools);
      break;

    // ===== NEW: Orchestration messages =====
    case 'plan_created':
      handlePlanCreated(d);
      break;

    case 'task_progress':
      handleTaskProgress(d);
      break;

    case 'task_completed':
      handleTaskCompleted(d);
      break;

    case 'task_failed':
      handleTaskFailed(d);
      break;

    case 'checkpoint':
      handleCheckpoint(d);
      break;

    case 'task_abandoned':
      handleTaskAbandoned();
      break;

    case 'session_context':
      handleSessionContext(d.context);
      break;
    // ===== END NEW =====

    case 'done':
    case 'complete':
      hideTypingIndicator();
      if (currentMessageEl) finalizeMessage(currentMessageEl);
      currentMessageEl = null;
      taskProgressEl = null;
      currentTaskBoard = null;
      isProcessing = false;
      enableInput(false);
      scrollToBottom(true);
      pendingFiles = [];
      if (filePreview) filePreview.innerHTML = '';
      if (isNewSession) {
        isNewSession = false;
        generateSessionTitle();
      }
      break;

    case 'continuing':
      updateTypingIndicator(d.message || 'Continuing...');
      break;

    case 'error':
      hideTypingIndicator();
      addToast(`Error: ${d.error}`, 'error');
      currentMessageEl = null;
      taskProgressEl = null;
      isProcessing = false;
      enableInput(true);
      break;

    default:
      console.warn('Unknown server message type:', d.type, d);
      break;
  }
}

/* ---------- 13. Task orchestration handlers ---------- */
function handlePlanCreated(data) {
  hideWelcome();
  
  currentTaskBoard = {
    taskCount: data.taskCount || 0,
    checkpoints: data.checkpoints || 0,
    completedTasks: 0,
  };

  // Create a plan summary message
  const planEl = createMessageElement('assistant');
  const content = planEl.querySelector('.message-content');
  
  content.innerHTML = `
    <div class="p-4 bg-blue-900/30 border border-blue-700/50 rounded-lg">
      <div class="flex items-center gap-2 mb-2">
        <svg class="w-5 h-5 text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01" />
        </svg>
        <h4 class="font-semibold text-blue-400">Plan Created</h4>
      </div>
      <p class="text-sm text-gray-300">${data.summary || `Breaking down your request into ${data.taskCount} tasks with ${data.checkpoints} checkpoints.`}</p>
      <div class="mt-3 flex gap-4 text-xs text-gray-400">
        <span>📋 ${data.taskCount} tasks</span>
        <span>🎯 ${data.checkpoints} checkpoints</span>
      </div>
    </div>
  `;

  // Create task progress container
  taskProgressEl = document.createElement('div');
  taskProgressEl.className = 'mt-4 space-y-2';
  content.appendChild(taskProgressEl);

  scrollToBottom(true);
}

function handleTaskProgress(data) {
  if (!taskProgressEl) {
    // Create progress container if it doesn't exist
    if (!currentMessageEl) {
      hideWelcome();
      currentMessageEl = createMessageElement('assistant');
    }
    const content = currentMessageEl.querySelector('.message-content');
    taskProgressEl = document.createElement('div');
    taskProgressEl.className = 'mt-4 space-y-2';
    content.appendChild(taskProgressEl);
  }

  // Update or create task progress item
  let taskItem = taskProgressEl.querySelector(`[data-task-id="${data.taskId}"]`);
  
  if (!taskItem) {
    taskItem = document.createElement('div');
    taskItem.className = 'p-3 bg-white/5 rounded border border-white/10';
    taskItem.dataset.taskId = data.taskId;
    taskProgressEl.appendChild(taskItem);
  }

  taskItem.innerHTML = `
    <div class="flex items-center gap-2">
      <div class="w-2 h-2 bg-yellow-500 rounded-full animate-pulse"></div>
      <span class="text-sm text-gray-300">${escapeHtml(data.message)}</span>
    </div>
  `;

  scrollToBottom(true);
}

function handleTaskCompleted(data) {
  if (!taskProgressEl) return;

  currentTaskBoard.completedTasks++;

  const taskItem = taskProgressEl.querySelector(`[data-task-id="${data.taskId}"]`);
  
  if (taskItem) {
    taskItem.innerHTML = `
      <div class="flex items-center gap-2">
        <div class="w-2 h-2 bg-teal-500 rounded-full"></div>
        <span class="text-sm text-gray-300">✓ ${escapeHtml(data.taskName || 'Task completed')}</span>
      </div>
      ${data.preview ? `<p class="text-xs text-gray-400 mt-1 ml-4">${escapeHtml(data.preview)}</p>` : ''}
    `;
  }

  updateTypingIndicator(`Progress: ${currentTaskBoard.completedTasks}/${currentTaskBoard.taskCount} tasks completed`);
  scrollToBottom(true);
}

function handleTaskFailed(data) {
  if (!taskProgressEl) return;

  const taskItem = taskProgressEl.querySelector(`[data-task-id="${data.taskId}"]`);
  
  if (taskItem) {
    taskItem.innerHTML = `
      <div class="flex items-center gap-2">
        <div class="w-2 h-2 bg-red-500 rounded-full"></div>
        <span class="text-sm text-red-400">✗ Task failed${data.willRetry ? ' (retrying...)' : ''}</span>
      </div>
      ${data.error ? `<p class="text-xs text-gray-400 mt-1 ml-4">${escapeHtml(data.error)}</p>` : ''}
    `;
  }

  scrollToBottom(true);
}

function handleCheckpoint(data) {
  hideTypingIndicator();
  
  if (currentMessageEl) {
    finalizeMessage(currentMessageEl);
  }

  // Create checkpoint message
  const checkpointEl = createMessageElement('assistant');
  const content = checkpointEl.querySelector('.message-content');
  
  content.innerHTML = `
    <div class="p-4 bg-purple-900/30 border border-purple-700/50 rounded-lg">
      <div class="flex items-center gap-2 mb-3">
        <svg class="w-5 h-5 text-purple-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
        <h4 class="font-semibold text-purple-400">Checkpoint Reached</h4>
      </div>
      <p class="text-sm text-gray-300 mb-4">${escapeHtml(data.message)}</p>
      ${data.task ? `
        <div class="mb-4 p-2 bg-white/5 rounded text-xs text-gray-400">
          <strong>Current task:</strong> ${escapeHtml(data.task.name || 'Unknown')}
        </div>
      ` : ''}
      <div class="flex gap-2">
        <button onclick="respondToCheckpoint(true)" class="px-4 py-2 bg-teal-600 hover:bg-teal-700 rounded-lg text-sm transition-colors">
          ✓ Continue
        </button>
        <button onclick="respondToCheckpoint(false)" class="px-4 py-2 bg-red-600 hover:bg-red-700 rounded-lg text-sm transition-colors">
          ✗ Stop
        </button>
      </div>
    </div>
  `;

  currentMessageEl = null;
  taskProgressEl = null;
  isProcessing = false;
  enableInput(true);
  scrollToBottom(true);
}

window.respondToCheckpoint = function(approved) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    addToast('Connection lost', 'error');
    return;
  }

  const feedback = approved ? 'Continue with the plan' : 'Stop execution';
  
  isProcessing = true;
  disableInput();
  showTypingIndicator(approved ? 'Continuing...' : 'Stopping...');

  ws.send(JSON.stringify({
    type: 'checkpoint_response',
    feedback,
    approved,
  }));
};

function handleTaskAbandoned() {
  hideTypingIndicator();
  currentTaskBoard = null;
  taskProgressEl = null;
  isProcessing = false;
  enableInput(true);
  addToast('Task abandoned', 'info');
}

function handleSessionContext(context) {
  console.log('Session context:', context);
  
  if (context.hasActiveBoard && context.suggestedAction === 'resume') {
    // Show notification about pending tasks
    addToast('You have an unfinished task. Type "continue" to resume or "stop" to abandon.', 'info');
  }
}

function showToolUse(tools) {
  if (!currentMessageEl) {
    hideWelcome();
    currentMessageEl = createMessageElement('assistant');
  }
  const div = document.createElement('div');
  div.className = 'text-xs text-gray-400 mt-2 p-2 bg-white/5 rounded border border-white/10';
  div.innerHTML = `🔧 Using: **${tools.join(', ')}**`;
  currentMessageEl.querySelector('.message-content')?.appendChild(div);
  scrollToBottom(true);
}

/* ---------- 14. Message DOM ---------- */
function createMessageElement(role) {
  const isUser = role === 'user';
  const wrap = document.createElement('div');
  wrap.className = 'py-4 px-4 md:px-6 ' + (isUser ? '' : 'bg-[#1e1e1e]');

  const el = document.createElement('div');
  el.className = 'flex items-start gap-4 max-w-4xl mx-auto';
  el.innerHTML = `
    <div class="w-8 h-8 flex-shrink-0 rounded-full flex items-center justify-center text-white ${
      isUser ? 'bg-gray-500' : 'bg-teal-600'
    }">
      ${isUser ? '👤' : `<svg class="w-5 h-5" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M9.663 17h4.673M12 3v1m0 0v8m0 0h4m-4 0H8"/></svg>`}
    </div>
    <div class="flex-1 min-w-0">
      <h3 class="font-semibold mb-2 ${isUser ? 'text-gray-300' : 'text-teal-400'}">${isUser ? 'You' : 'Orion'}</h3>
      <div class="message-content text-gray-200"></div>
    </div>`;

  wrap.appendChild(el);
  chatMessages?.appendChild(wrap);
  return el;
}

function appendToMessage(el, txt) {
  const content = el.querySelector('.message-content');
  if (!content) return;
  if (!content.dataset.streaming) {
    content.dataset.streaming = 'true';
    content.dataset.rawContent = '';
  }
  content.dataset.rawContent += txt;
  content.textContent = content.dataset.rawContent;
}

function finalizeMessage(el) {
  const content = el.querySelector('.message-content');
  if (!content) return;
  const raw = content.dataset.rawContent || content.textContent;
  content.innerHTML = marked.parse(raw);
  content.querySelectorAll('pre code').forEach((b) => hljs.highlightElement(b));
  delete content.dataset.streaming;
  delete content.dataset.rawContent;
}

function addUserMessage(txt, scroll = true) {
  const el = createMessageElement('user');
  el.querySelector('.message-content').textContent = txt;
  if (scroll) scrollToBottom(true);
}

function addAssistantMessage(txt, scroll = true) {
  const el = createMessageElement('assistant');
  el.querySelector('.message-content').innerHTML = marked.parse(txt);
  el.querySelectorAll('pre code').forEach((b) => hljs.highlightElement(b));
  if (scroll) scrollToBottom(false);
}

/* ---------- 15. Typing ---------- */
function showTypingIndicator(msg = 'Thinking…') {
  if (!typingText || !typingIndicator) return;
  typingText.innerHTML = `<div class="flex items-center gap-2"><span>${msg}</span></div>`;
  typingIndicator.classList.remove('hidden');
  scrollToBottom(true);
}

function updateTypingIndicator(msg) {
  if (!typingText) return;
  typingText.innerHTML = `<div class="flex items-center gap-2"><span>${msg}</span></div>`;
}

function hideTypingIndicator() {
  typingIndicator?.classList.add('hidden');
}

/* ---------- 16. Input lock ---------- */
function disableInput() {
  if (userInput) userInput.disabled = true;
  if (sendButton) sendButton.disabled = true;
}

function enableInput(focus = true) {
  if (userInput) userInput.disabled = false;
  if (sendButton) sendButton.disabled = false;
  if (focus && userInput) userInput.focus();
}

/* ---------- 17. Scroll ---------- */
function scrollToBottom(smooth = false) {
  const container = $('messages-area');
  if (container) {
    container.scrollTo({
      top: container.scrollHeight,
      behavior: smooth ? 'smooth' : 'auto',
    });
  }
}

/* ---------- 18. Connection status ---------- */
function updateConnectionStatus(txt, cls) {
  const indicator = $('status-indicator');
  const statusText = $('status-text');
  const dot = indicator?.querySelector('.w-2.h-2');

  if (dot) {
    dot.className = `w-2 h-2 rounded-full ml-2 ${cls}`;
  }

  if (statusText) {
    statusText.textContent = txt;
    statusText.className =
      cls === 'bg-teal-500' ? 'text-teal-400' : cls === 'bg-red-500' ? 'text-red-400' : 'text-gray-400';
  }
}

/* ---------- 19. Toast ---------- */
function addToast(msg, type = 'info') {
  const colors = {
    error: 'bg-red-600',
    success: 'bg-teal-600',
    info: 'bg-blue-600',
  };

  const t = document.createElement('div');
  t.className = `fixed bottom-5 right-5 p-3 rounded-lg shadow-xl z-50 text-white text-sm transition transform translate-x-full opacity-0 ${colors[type] || colors.info}`;
  t.textContent = msg;
  document.body.appendChild(t);

  setTimeout(() => t.classList.remove('translate-x-full', 'opacity-0'), 10);
  setTimeout(() => {
    t.classList.add('translate-x-full', 'opacity-0');
    setTimeout(() => t.remove(), 300);
  }, 3000);
}

/* ---------- 20. History with session ID ---------- */
async function loadChatHistory() {
  if (!currentSessionId) return;

  try {
    const response = await fetch(`/api/history?session_id=${encodeURIComponent(currentSessionId)}`);
    if (!response.ok) return;

    const data = await response.json();
    if (data.messages?.length) {
      hideWelcome();
      data.messages.forEach((m) => {
        const role = m.role === 'model' ? 'assistant' : 'user';
        const text = (m.parts || []).filter((p) => p.text).map((p) => p.text).join('\n');
        if (text) {
          role === 'user' ? addUserMessage(text, false) : addAssistantMessage(text, false);
        }
      });
      scrollToBottom(false);
    }
  } catch (e) {
    console.error('history', e);
  }
}

/* ---------- 21. Clear with session ID ---------- */
window.clearChat = async function () {
  if (!confirm('Start a new chat? This will create a fresh session.')) return;

  try {
    await createNewSession('New Chat');

    if (chatMessages) chatMessages.innerHTML = '';
    pendingFiles = [];
    if (filePreview) filePreview.innerHTML = '';
    conversationStarted = false;
    currentTaskBoard = null;
    taskProgressEl = null;

    welcomeScreen?.classList.remove('hidden');

    addToast('New chat started', 'success');
  } catch (e) {
    console.error('clear', e);
    addToast('Failed to start new chat', 'error');
  }
};

/* ---------- 22. Suggestions ---------- */
window.useSuggestion = function (el) {
  if (!el) return;
  const txt = el.textContent
    .trim()
    .replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, '')
    .replace(/[^\w\s\?]/g, '')
    .trim();
  if (userInput) userInput.value = txt;
  if (userInput) {
    userInput.style.height = 'auto';
    userInput.style.height = Math.min(userInput.scrollHeight, 200) + 'px';
    userInput.focus();
  }
};

/* ---------- 23. Welcome ---------- */
function hideWelcome() {
  if (!conversationStarted) {
    welcomeScreen?.classList.add('hidden');
    conversationStarted = true;
  }
}

/* ---------- 24. Geo stub ---------- */
window.getCurrentPosition = async () => ({
  lat: 0,
  lon: 0,
  addr: 'Earth',
});
