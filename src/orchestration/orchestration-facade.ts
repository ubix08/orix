// src/orchestration/orchestration-facade.ts
/**
 * OPTIMIZATION: Facade pattern to simplify orchestrator integration
 * Isolates orchestration complexity from durable-agent.ts
 */

import type { GeminiClient } from '../gemini';
import type { Message } from '../types';
import {
  Orchestrator,
  type BoardStorage,
  type SessionContext,
  type ComplexityAssessment,
  type OrchestratorEvent,
} from './index';

export interface ExecutionResult {
  type: 'simple' | 'orchestrated';
  response: string;
  checkpointReached?: boolean;
  checkpointMessage?: string;
  requiresUserInput?: boolean;
}

export interface OrchestratorFacadeConfig {
  complexityThreshold: number; // 0-1, threshold for using orchestrator
  autoResume: boolean;
  maxTasksWithoutCheckpoint: number;
}

/**
 * Facade that decides between simple ReAct loop and full orchestration
 */
export class OrchestrationFacade {
  private orchestrator: Orchestrator;
  private config: OrchestratorFacadeConfig;
  private eventListeners: Array<(event: OrchestratorEvent) => void> = [];

  constructor(
    gemini: GeminiClient,
    storage: BoardStorage,
    sessionId: string,
    config: Partial<OrchestratorFacadeConfig> = {}
  ) {
    this.config = {
      complexityThreshold: config.complexityThreshold ?? 0.7,
      autoResume: config.autoResume ?? false,
      maxTasksWithoutCheckpoint: config.maxTasksWithoutCheckpoint ?? 4,
    };

    this.orchestrator = new Orchestrator(
      gemini,
      storage,
      sessionId,
      {
        maxRetries: 2,
        workerMaxTurns: 5,
        autoReplanOnFailure: true,
        requireCheckpointApproval: true,
      }
    );

    // Forward orchestrator events
    this.orchestrator.onEvent((event) => {
      this.eventListeners.forEach(listener => listener(event));
    });
  }

  // ===== Event Subscription =====

  onEvent(callback: (event: OrchestratorEvent) => void): void {
    this.eventListeners.push(callback);
  }

  // ===== Main Execution Decision Logic =====

  async execute(
    userMessage: string,
    conversationHistory: Message[],
    memoryContext: string
  ): Promise<ExecutionResult> {
    // 1. Check for active board first
    const sessionContext = await this.orchestrator.getSessionContext();
    
    if (sessionContext.hasActiveBoard) {
      return this.handleActiveBoard(sessionContext, userMessage);
    }

    // 2. Assess complexity
    const complexity = await this.orchestrator.evaluateComplexity(userMessage);

    // 3. Route to appropriate execution path
    if (this.shouldUseOrchestration(complexity)) {
      return this.executeOrchestrated(userMessage, memoryContext, complexity);
    } else {
      return {
        type: 'simple',
        response: '', // Caller handles simple execution
        requiresUserInput: false,
      };
    }
  }

  // ===== Orchestrated Execution =====

  private async executeOrchestrated(
    userMessage: string,
    memoryContext: string,
    complexity: ComplexityAssessment
  ): Promise<ExecutionResult> {
    // Create plan
    const board = await this.orchestrator.createPlan(
      userMessage,
      userMessage,
      memoryContext
    );

    // Execute until checkpoint or completion
    const result = await this.orchestrator.executeUntilCheckpoint();

    if (result.status === 'completed') {
      return {
        type: 'orchestrated',
        response: result.finalOutput || result.message,
        requiresUserInput: false,
      };
    } else if (result.status === 'checkpoint') {
      return {
        type: 'orchestrated',
        response: result.message,
        checkpointReached: true,
        checkpointMessage: result.checkpointTask?.checkpointMessage,
        requiresUserInput: true,
      };
    } else {
      return {
        type: 'orchestrated',
        response: `Task execution failed: ${result.message}`,
        requiresUserInput: false,
      };
    }
  }

  // ===== Active Board Handling =====

  private async handleActiveBoard(
    context: SessionContext,
    userMessage: string
  ): Promise<ExecutionResult> {
    const lowerMsg = userMessage.toLowerCase();

    // Check for resume/continue intent
    if (this.isResumeIntent(lowerMsg)) {
      return this.resumeFromCheckpoint(userMessage, true);
    }

    // Check for cancel/abandon intent
    if (this.isCancelIntent(lowerMsg)) {
      await this.orchestrator.abandonBoard();
      return {
        type: 'simple',
        response: 'Task cancelled. How can I help you with something else?',
        requiresUserInput: false,
      };
    }

    // Ambiguous - provide guidance
    if (context.suggestedAction === 'resume') {
      const progress = this.calculateProgress(context.board!);
      return {
        type: 'orchestrated',
        response: `You have an active task in progress (${progress}% complete). Would you like to:
- Continue the current task (say "continue")
- Cancel and start fresh (say "cancel")
- Or ask your new question`,
        requiresUserInput: true,
      };
    }

    // Completed board - treat as new request
    return {
      type: 'simple',
      response: '',
      requiresUserInput: false,
    };
  }

  // ===== Resume Logic =====

  async resumeFromCheckpoint(
    feedback: string,
    approved: boolean
  ): Promise<ExecutionResult> {
    const result = await this.orchestrator.resumeFromCheckpoint(feedback, approved);

    if (result.status === 'completed') {
      return {
        type: 'orchestrated',
        response: result.finalOutput || result.message,
        requiresUserInput: false,
      };
    } else if (result.status === 'checkpoint') {
      return {
        type: 'orchestrated',
        response: result.message,
        checkpointReached: true,
        checkpointMessage: result.checkpointTask?.checkpointMessage,
        requiresUserInput: true,
      };
    } else {
      return {
        type: 'orchestrated',
        response: `Task execution failed: ${result.message}`,
        requiresUserInput: false,
      };
    }
  }

  // ===== Decision Helpers =====

  private shouldUseOrchestration(complexity: ComplexityAssessment): boolean {
    if (!complexity.isComplex) return false;
    
    // Use estimated tasks as a factor
    const taskThreshold = 3;
    const estimatedTasks = complexity.estimatedTasks || 0;
    
    return (
      complexity.suggestedApproach === 'planned' &&
      estimatedTasks >= taskThreshold
    );
  }

  private isResumeIntent(message: string): boolean {
    const resumeKeywords = [
      'continue',
      'yes',
      'proceed',
      'go ahead',
      'keep going',
      'resume',
    ];
    return resumeKeywords.some(kw => message.includes(kw));
  }

  private isCancelIntent(message: string): boolean {
    const cancelKeywords = ['cancel', 'stop', 'abort', 'abandon', 'no thanks'];
    return cancelKeywords.some(kw => message.includes(kw));
  }

  private calculateProgress(board: any): number {
    if (!board) return 0;
    const completed = board.tasks.filter((t: any) => t.status === 'complete').length;
    return Math.round((completed / board.tasks.length) * 100);
  }

  // ===== Status Methods =====

  async getStatus(): Promise<{
    hasActiveBoard: boolean;
    boardStatus?: string;
    currentTask?: string;
    progress?: number;
  }> {
    const context = await this.orchestrator.getSessionContext();
    
    if (!context.hasActiveBoard) {
      return { hasActiveBoard: false };
    }

    const board = context.board!;
    const currentTask = board.tasks[board.currentIdx];
    
    return {
      hasActiveBoard: true,
      boardStatus: board.status,
      currentTask: currentTask?.name,
      progress: this.calculateProgress(board),
    };
  }

  async abandon(): Promise<void> {
    await this.orchestrator.abandonBoard();
  }
}

// USAGE in durable-agent.ts:
/*
// In constructor:
this.orchestrationFacade = new OrchestrationFacade(
  this.gemini,
  this.createBoardStorage(),
  this.sessionId,
  {
    complexityThreshold: 0.7,
    autoResume: false,
  }
);

// Setup event forwarding to WebSocket
this.orchestrationFacade.onEvent((event) => {
  this.broadcastToSockets(event);
});

// In message handler:
const result = await this.orchestrationFacade.execute(
  userMessage,
  conversationHistory,
  memoryContext
);

if (result.type === 'simple') {
  // Use existing ReAct loop
  const response = await this.executeReactLoop(...);
  return response;
} else {
  // Orchestrator handled it
  if (result.requiresUserInput) {
    // Send checkpoint message, wait for user
  }
  return result.response;
}
*/
