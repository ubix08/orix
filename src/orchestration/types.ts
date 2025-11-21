// src/orchestration/types.ts
// Task Orchestration System - Type Definitions

// =============================================================
// Task Status & Types
// =============================================================

export type TaskStatus = 
  | 'pending'    // Not yet started
  | 'running'    // Currently executing
  | 'checkpoint' // Awaiting user feedback
  | 'retry'      // Failed, will retry
  | 'failed'     // Exceeded retries, needs replan
  | 'complete';  // Successfully finished

export type TaskType = 
  | 'work'       // Actual work task (calls worker)
  | 'checkpoint' // User interaction point
  | 'synthesis'; // Final aggregation task

// =============================================================
// Core Task Definition
// =============================================================

export interface Task {
  id: string;
  name: string;
  description: string;
  type: TaskType;
  workerRole: string;           // e.g., 'researcher', 'writer', 'coder'
  instruction: string;          // Detailed instruction for worker
  supportedActions: string[];   // Tools worker can use
  dependencies: string[];       // Task IDs this depends on
  status: TaskStatus;
  result?: string;              // Output from worker
  retryCount: number;
  maxRetries: number;
  userFeedback?: string;        // Feedback from checkpoint
  checkpointMessage?: string;   // Message to show user at checkpoint
  estimatedComplexity: 'low' | 'medium' | 'high';
  createdAt: number;
  completedAt?: number;
}

// =============================================================
// Task Board (Plan Container)
// =============================================================

export interface TaskBoard {
  id: string;
  sessionId: string;
  objective: string;           // Original user request
  context: string;             // Additional context from memory/history
  tasks: Task[];
  currentIdx: number;          // Current execution position
  globals: Record<string, string>; // Shared data between tasks
  status: BoardStatus;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  totalCheckpoints: number;
  completedCheckpoints: number;
}

export type BoardStatus = 
  | 'planning'     // Being created
  | 'executing'    // Tasks running
  | 'paused'       // At checkpoint, waiting for user
  | 'replanning'   // Failed task triggered replan
  | 'completed'    // All tasks done
  | 'abandoned';   // User cancelled

// =============================================================
// Worker Context
// =============================================================

export interface WorkerContext {
  role: string;
  systemPrompt: string;
  supportedActions: string[];
  maxTurns: number;
  history: WorkerTurn[];
}

export interface WorkerTurn {
  prompt: string;
  response: string;
  toolCalls?: ToolCallRecord[];
  timestamp: number;
}

export interface ToolCallRecord {
  name: string;
  args: Record<string, unknown>;
  result: string;
  success: boolean;
}

// =============================================================
// Worker Results
// =============================================================

export interface WorkerResult {
  success: boolean;
  output: string;
  error?: string;
  turnsUsed: number;
  toolsUsed: string[];
  needsRetry: boolean;
  retryReason?: string;
}

// =============================================================
// Planner Types
// =============================================================

export interface PlannerInput {
  objective: string;
  userQuery: string;
  context: string;
  previousAttempt?: TaskBoard;  // For replanning
  failureReason?: string;
}

export interface PlannerOutput {
  tasks: Task[];
  estimatedTotalTime: string;
  checkpointCount: number;
  summary: string;
}

// =============================================================
// Orchestrator Events (for streaming/callbacks)
// =============================================================

export type OrchestratorEvent = 
  | { type: 'plan_created'; board: TaskBoard }
  | { type: 'task_started'; task: Task; index: number; total: number }
  | { type: 'task_progress'; taskId: string; message: string }
  | { type: 'task_completed'; task: Task; result: string }
  | { type: 'task_failed'; task: Task; error: string; willRetry: boolean }
  | { type: 'checkpoint_reached'; task: Task; message: string }
  | { type: 'checkpoint_resumed'; taskId: string; feedback: string }
  | { type: 'replan_triggered'; reason: string }
  | { type: 'board_completed'; board: TaskBoard; finalOutput: string }
  | { type: 'board_failed'; board: TaskBoard; reason: string };

export type EventCallback = (event: OrchestratorEvent) => void;

// =============================================================
// Session Greeting Context
// =============================================================

export interface SessionContext {
  hasActiveBoard: boolean;
  board?: TaskBoard;
  lastCompletedTask?: Task;
  pendingCheckpoint?: Task;
  suggestedAction: 'resume' | 'new' | 'review_completed';
  greetingMessage: string;
}

// =============================================================
// Tool Definitions (for Gemini function calling)
// =============================================================

export interface PlannerToolArgs {
  action: 'create' | 'update' | 'replan';
  objective?: string;
  userQuery?: string;
  context?: string;
  taskId?: string;
  newStatus?: TaskStatus;
  result?: string;
  reason?: string;
}

export interface WorkerToolArgs {
  taskId: string;
  name: string;
  role: string;
  instruction: string;
  description: string;
  supportedActions: string[];
  globals?: string;
  maxTurns?: number;
}

// =============================================================
// Complexity Evaluation
// =============================================================

export interface ComplexityAssessment {
  isComplex: boolean;
  reason: string;
  suggestedApproach: 'direct' | 'planned';
  estimatedTasks?: number;
}

// =============================================================
// Constants
// =============================================================

export const WORKER_ROLES = {
  RESEARCHER: 'researcher',
  WRITER: 'writer',
  CODER: 'coder',
  ANALYST: 'analyst',
  EDITOR: 'editor',
  SEO_SPECIALIST: 'seo_specialist',
  DATA_PROCESSOR: 'data_processor',
  SYNTHESIZER: 'synthesizer',
} as const;

export const DEFAULT_MAX_RETRIES = 2;
export const DEFAULT_WORKER_MAX_TURNS = 5;
export const MAX_TASKS_PER_PLAN = 15;
export const MAX_CONSECUTIVE_WORK_TASKS = 4; // Before checkpoint recommended
