// src/orchestration/orchestrator.ts
// Task Orchestrator - Manages task board lifecycle and execution flow

import type { GeminiClient } from '../gemini';
import type {
  Task, TaskBoard, TaskStatus, BoardStatus, SessionContext,
  OrchestratorEvent, EventCallback, WorkerResult, ComplexityAssessment
} from './types';
import { Planner } from './planner';
import { Worker } from './worker';
import { DEFAULT_MAX_RETRIES } from './types';

// =============================================================
// Orchestrator Configuration
// =============================================================

export interface OrchestratorConfig {
  maxRetries: number;
  workerMaxTurns: number;
  autoReplanOnFailure: boolean;
  requireCheckpointApproval: boolean;
}

const DEFAULT_CONFIG: OrchestratorConfig = {
  maxRetries: DEFAULT_MAX_RETRIES,
  workerMaxTurns: 5,
  autoReplanOnFailure: true,
  requireCheckpointApproval: true,
};

// =============================================================
// Storage Interface (for dependency injection)
// =============================================================

export interface BoardStorage {
  loadBoard(sessionId: string): Promise<TaskBoard | null>;
  saveBoard(board: TaskBoard): Promise<void>;
  deleteBoard(boardId: string): Promise<void>;
}

// =============================================================
// Orchestrator Class
// =============================================================

export class Orchestrator {
  private gemini: GeminiClient;
  private planner: Planner;
  private worker: Worker;
  private storage: BoardStorage;
  private config: OrchestratorConfig;
  private eventCallback?: EventCallback;

  // Active state
  private currentBoard: TaskBoard | null = null;
  private sessionId: string;

  constructor(
    gemini: GeminiClient,
    storage: BoardStorage,
    sessionId: string,
    config: Partial<OrchestratorConfig> = {}
  ) {
    this.gemini = gemini;
    this.storage = storage;
    this.sessionId = sessionId;
    this.config = { ...DEFAULT_CONFIG, ...config };

    this.planner = new Planner(gemini);
    this.worker = new Worker(gemini, this.config.workerMaxTurns);
  }

  // -----------------------------------------------------------
  // Event Handling
  // -----------------------------------------------------------

  onEvent(callback: EventCallback): void {
    this.eventCallback = callback;
  }

  private emit(event: OrchestratorEvent): void {
    try {
      this.eventCallback?.(event);
    } catch (e) {
      console.error('[Orchestrator] Event callback error:', e);
    }
  }

  // -----------------------------------------------------------
  // Session Context (for greeting/resume)
  // -----------------------------------------------------------

  async getSessionContext(): Promise<SessionContext> {
    const board = await this.storage.loadBoard(this.sessionId);
    this.currentBoard = board;

    if (!board) {
      return {
        hasActiveBoard: false,
        suggestedAction: 'new',
        greetingMessage: 'Hello! How can I help you today?',
      };
    }

    // Find current state
    const pendingCheckpoint = board.tasks.find(
      t => t.type === 'checkpoint' && t.status === 'checkpoint'
    );
    const lastCompleted = [...board.tasks]
      .reverse()
      .find(t => t.status === 'complete');

    if (board.status === 'completed') {
      return {
        hasActiveBoard: false,
        board,
        lastCompletedTask: lastCompleted,
        suggestedAction: 'review_completed',
        greetingMessage: `Welcome back! I completed "${board.objective}" earlier. Would you like to review the results or start something new?`,
      };
    }

    if (board.status === 'paused' && pendingCheckpoint) {
      const progress = this.calculateProgress(board);
      return {
        hasActiveBoard: true,
        board,
        pendingCheckpoint,
        suggestedAction: 'resume',
        greetingMessage: `Welcome back! We were working on "${board.objective}" (${progress}% complete). ${pendingCheckpoint.checkpointMessage || 'Ready to continue?'}`,
      };
    }

    if (board.status === 'executing') {
      const progress = this.calculateProgress(board);
      const currentTask = board.tasks[board.currentIdx];
      return {
        hasActiveBoard: true,
        board,
        suggestedAction: 'resume',
        greetingMessage: `Welcome back! We were working on "${board.objective}" (${progress}% complete). Currently on: ${currentTask?.name || 'next task'}. Shall I continue?`,
      };
    }

    // Default fallback
    return {
      hasActiveBoard: true,
      board,
      suggestedAction: 'resume',
      greetingMessage: `Welcome back! You have an active project: "${board.objective}". Would you like to continue?`,
    };
  }

  // -----------------------------------------------------------
  // Complexity Evaluation
  // -----------------------------------------------------------

  async evaluateComplexity(userQuery: string): Promise<ComplexityAssessment> {
    return this.planner.assessComplexity(userQuery);
  }

  // -----------------------------------------------------------
  // Plan Creation
  // -----------------------------------------------------------

  async createPlan(
    objective: string,
    userQuery: string,
    context: string = ''
  ): Promise<TaskBoard> {
    const planOutput = await this.planner.createPlan({
      objective,
      userQuery,
      context,
    });

    const board = this.planner.createBoard(
      this.sessionId,
      objective,
      context,
      planOutput
    );

    this.currentBoard = board;
    await this.storage.saveBoard(board);

    this.emit({ type: 'plan_created', board });
    return board;
  }

  // -----------------------------------------------------------
  // Execution Loop (main entry point)
  // -----------------------------------------------------------

  /**
   * Execute tasks until a checkpoint or completion.
   * Returns when:
   * - A checkpoint is reached (awaiting user feedback)
   * - All tasks complete
   * - A fatal error occurs
   */
  async executeUntilCheckpoint(): Promise<{
    status: 'checkpoint' | 'completed' | 'failed';
    message: string;
    checkpointTask?: Task;
    finalOutput?: string;
  }> {
    if (!this.currentBoard) {
      const loaded = await this.storage.loadBoard(this.sessionId);
      if (!loaded) {
        return { status: 'failed', message: 'No active task board' };
      }
      this.currentBoard = loaded;
    }

    const board = this.currentBoard;
    board.status = 'executing';
    board.updatedAt = Date.now();

    while (board.currentIdx < board.tasks.length) {
      const task = board.tasks[board.currentIdx];

      // Handle checkpoint tasks
      if (task.type === 'checkpoint') {
        task.status = 'checkpoint';
        board.status = 'paused';
        await this.storage.saveBoard(board);

        this.emit({
          type: 'checkpoint_reached',
          task,
          message: task.checkpointMessage || 'Checkpoint reached. Please review and provide feedback.',
        });

        return {
          status: 'checkpoint',
          message: task.checkpointMessage || 'Awaiting your feedback to continue.',
          checkpointTask: task,
        };
      }

      // Execute work task
      this.emit({
        type: 'task_started',
        task,
        index: board.currentIdx,
        total: board.tasks.length,
      });

      task.status = 'running';
      await this.storage.saveBoard(board);

      const result = await this.executeTask(task, board);

      if (result.success) {
        task.status = 'complete';
        task.result = result.output;
        task.completedAt = Date.now();
        board.globals[task.id] = result.output;

        this.emit({ type: 'task_completed', task, result: result.output });

        board.currentIdx++;
        await this.storage.saveBoard(board);
      } else if (result.needsRetry && task.retryCount < task.maxRetries) {
        // Retry logic
        task.retryCount++;
        task.status = 'retry';
        
        this.emit({
          type: 'task_failed',
          task,
          error: result.error || result.retryReason || 'Unknown error',
          willRetry: true,
        });

        // Retry with feedback
        const retryResult = await this.worker.retryWithFeedback(
          task,
          result,
          result.retryReason || 'Please try again with a different approach',
          board.globals,
          this.buildPreviousOutputs(board),
          (msg) => this.emit({ type: 'task_progress', taskId: task.id, message: msg })
        );

        if (retryResult.success) {
          task.status = 'complete';
          task.result = retryResult.output;
          task.completedAt = Date.now();
          board.globals[task.id] = retryResult.output;

          this.emit({ type: 'task_completed', task, result: retryResult.output });
          board.currentIdx++;
        } else {
          task.status = 'failed';
          this.emit({
            type: 'task_failed',
            task,
            error: retryResult.error || 'Retry failed',
            willRetry: false,
          });

          // Trigger replan if configured
          if (this.config.autoReplanOnFailure) {
            return await this.handleReplan(board, task, retryResult.error || 'Task failed after retries');
          }

          return {
            status: 'failed',
            message: `Task "${task.name}" failed: ${retryResult.error}`,
          };
        }

        await this.storage.saveBoard(board);
      } else {
        // Failed without retry
        task.status = 'failed';
        this.emit({
          type: 'task_failed',
          task,
          error: result.error || 'Task failed',
          willRetry: false,
        });

        if (this.config.autoReplanOnFailure) {
          return await this.handleReplan(board, task, result.error || 'Task failed');
        }

        return {
          status: 'failed',
          message: `Task "${task.name}" failed: ${result.error}`,
        };
      }
    }

    // All tasks completed
    board.status = 'completed';
    board.completedAt = Date.now();
    await this.storage.saveBoard(board);

    const finalOutput = this.synthesizeFinalOutput(board);
    this.emit({ type: 'board_completed', board, finalOutput });

    return {
      status: 'completed',
      message: 'All tasks completed successfully!',
      finalOutput,
    };
  }

  // -----------------------------------------------------------
  // Checkpoint Resume
  // -----------------------------------------------------------

  async resumeFromCheckpoint(
    feedback: string,
    approved: boolean = true
  ): Promise<{
    status: 'checkpoint' | 'completed' | 'failed' | 'replanning';
    message: string;
    checkpointTask?: Task;
    finalOutput?: string;
  }> {
    if (!this.currentBoard) {
      const loaded = await this.storage.loadBoard(this.sessionId);
      if (!loaded) {
        return { status: 'failed', message: 'No active task board' };
      }
      this.currentBoard = loaded;
    }

    const board = this.currentBoard;
    const checkpointTask = board.tasks[board.currentIdx];

    if (!checkpointTask || checkpointTask.type !== 'checkpoint') {
      return { status: 'failed', message: 'No checkpoint to resume from' };
    }

    this.emit({
      type: 'checkpoint_resumed',
      taskId: checkpointTask.id,
      feedback,
    });

    // Store feedback
    checkpointTask.userFeedback = feedback;
    checkpointTask.status = 'complete';
    checkpointTask.completedAt = Date.now();
    board.completedCheckpoints++;

    if (!approved) {
      // User rejected - trigger replan
      this.emit({ type: 'replan_triggered', reason: `User feedback: ${feedback}` });
      return await this.handleReplan(board, checkpointTask, feedback);
    }

    // Move to next task
    board.currentIdx++;
    board.status = 'executing';
    await this.storage.saveBoard(board);

    // Continue execution
    return this.executeUntilCheckpoint();
  }

  // -----------------------------------------------------------
  // Task Execution
  // -----------------------------------------------------------

  private async executeTask(task: Task, board: TaskBoard): Promise<WorkerResult> {
    const previousOutputs = this.buildPreviousOutputs(board);

    return this.worker.execute(
      task,
      board.globals,
      previousOutputs,
      (msg) => this.emit({ type: 'task_progress', taskId: task.id, message: msg })
    );
  }

  // -----------------------------------------------------------
  // Replan Handling
  // -----------------------------------------------------------

  private async handleReplan(
    board: TaskBoard,
    failedTask: Task,
    reason: string
  ): Promise<{
    status: 'checkpoint' | 'completed' | 'failed' | 'replanning';
    message: string;
  }> {
    this.emit({ type: 'replan_triggered', reason });

    board.status = 'replanning';
    await this.storage.saveBoard(board);

    try {
      const newPlan = await this.planner.replan({
        objective: board.objective,
        userQuery: board.objective,
        context: board.context,
        previousAttempt: board,
        failureReason: reason,
      });

      // Update board with new tasks (preserving completed ones)
      const completedTasks = board.tasks.filter(t => t.status === 'complete');
      board.tasks = [...completedTasks, ...newPlan.tasks];
      board.currentIdx = completedTasks.length;
      board.status = 'executing';
      board.totalCheckpoints = newPlan.checkpointCount + board.completedCheckpoints;
      board.updatedAt = Date.now();

      await this.storage.saveBoard(board);

      // Continue execution with new plan
      return this.executeUntilCheckpoint() as any;
    } catch (error) {
      board.status = 'paused';
      await this.storage.saveBoard(board);

      return {
        status: 'failed',
        message: `Replanning failed: ${error}. Please provide guidance.`,
      };
    }
  }

  // -----------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------

  private buildPreviousOutputs(board: TaskBoard): Record<string, string> {
    const outputs: Record<string, string> = {};
    for (const task of board.tasks) {
      if (task.status === 'complete' && task.result) {
        outputs[task.id] = task.result;
      }
    }
    return outputs;
  }

  private calculateProgress(board: TaskBoard): number {
    const completed = board.tasks.filter(t => t.status === 'complete').length;
    return Math.round((completed / board.tasks.length) * 100);
  }

  private synthesizeFinalOutput(board: TaskBoard): string {
    // Find the last synthesis task or combine all outputs
    const synthesisTask = [...board.tasks]
      .reverse()
      .find(t => t.type === 'synthesis' && t.status === 'complete');

    if (synthesisTask?.result) {
      return synthesisTask.result;
    }

    // Fallback: combine outputs from work tasks
    const outputs = board.tasks
      .filter(t => t.type === 'work' && t.status === 'complete' && t.result)
      .map(t => `## ${t.name}\n\n${t.result}`)
      .join('\n\n---\n\n');

    return outputs || 'Task completed but no output was generated.';
  }

  // -----------------------------------------------------------
  // Board Management
  // -----------------------------------------------------------

  getCurrentBoard(): TaskBoard | null {
    return this.currentBoard;
  }

  async abandonBoard(): Promise<void> {
    if (this.currentBoard) {
      this.currentBoard.status = 'abandoned';
      this.currentBoard.updatedAt = Date.now();
      await this.storage.saveBoard(this.currentBoard);
      this.currentBoard = null;
    }
  }

  async clearBoard(): Promise<void> {
    if (this.currentBoard) {
      await this.storage.deleteBoard(this.currentBoard.id);
      this.currentBoard = null;
    }
  }
}

export default Orchestrator;
