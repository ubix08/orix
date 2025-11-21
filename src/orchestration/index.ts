// src/orchestration/index.ts
// Task Orchestration System - Public Exports

// Types
export type {
  // Core types
  Task,
  TaskBoard,
  TaskStatus,
  TaskType,
  BoardStatus,
  
  // Worker types
  WorkerContext,
  WorkerTurn,
  WorkerResult,
  ToolCallRecord,
  
  // Planner types
  PlannerInput,
  PlannerOutput,
  ComplexityAssessment,
  
  // Events
  OrchestratorEvent,
  EventCallback,
  
  // Session
  SessionContext,
  
  // Tool args
  PlannerToolArgs,
  WorkerToolArgs,
} from './types';

// Constants
export {
  WORKER_ROLES,
  DEFAULT_MAX_RETRIES,
  DEFAULT_WORKER_MAX_TURNS,
  MAX_TASKS_PER_PLAN,
  MAX_CONSECUTIVE_WORK_TASKS,
} from './types';

// Classes
export { Planner } from './planner';
export { Worker } from './worker';
export { Orchestrator, type OrchestratorConfig, type BoardStorage } from './orchestrator';

// Default export
export { Orchestrator as default } from './orchestrator';
