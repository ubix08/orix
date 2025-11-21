// src/orchestration/planner.ts
// Task Planner - Decomposes complex objectives into executable tasks

import type { GeminiClient } from '../gemini';
import type {
  Task, TaskBoard, PlannerInput, PlannerOutput, TaskStatus,
  ComplexityAssessment
} from './types';
import {
  WORKER_ROLES, DEFAULT_MAX_RETRIES, DEFAULT_WORKER_MAX_TURNS,
  MAX_TASKS_PER_PLAN, MAX_CONSECUTIVE_WORK_TASKS
} from './types';

// =============================================================
// Prompt Templates
// =============================================================

const COMPLEXITY_ASSESSMENT_PROMPT = `You are an AI assistant evaluating whether a user request requires multi-step task planning or can be answered directly.

CRITERIA FOR DIRECT RESPONSE (simple):
- Factual questions with clear answers
- Simple explanations or definitions
- Quick calculations or conversions
- Casual conversation or greetings
- Questions about your capabilities
- Short creative writing (haiku, joke, etc.)

CRITERIA FOR TASK PLANNING (complex):
- Research requiring multiple sources
- Content creation (articles, reports, documentation)
- Multi-step analysis or comparisons
- Code projects with multiple files/components
- Tasks requiring different expertise (research + writing + editing)
- Data processing with multiple transformations
- SEO optimization requiring research + content + technical work

USER REQUEST: {userQuery}

Respond ONLY with this JSON (no markdown, no explanation):
{"isComplex": boolean, "reason": "brief explanation", "suggestedApproach": "direct" | "planned", "estimatedTasks": number or null}`;

const PLANNER_SYSTEM_PROMPT = `You are an expert task planner for an AI assistant. Your job is to break down complex user requests into clear, executable tasks.

PLANNING PRINCIPLES:

1. TASK GRANULARITY
   - Each task should be atomic and achievable in one worker call
   - Tasks should produce concrete, verifiable output
   - Avoid vague tasks like "improve" or "optimize" without specifics

2. WORKER ROLES
   Available roles: ${Object.values(WORKER_ROLES).join(', ')}
   - researcher: Web search, information gathering, fact-finding
   - writer: Content creation, drafting, copywriting
   - coder: Code generation, debugging, implementation
   - analyst: Data analysis, comparisons, evaluations
   - editor: Review, refinement, proofreading
   - seo_specialist: Keyword research, SEO optimization
   - data_processor: Data transformation, formatting, extraction
   - synthesizer: Combining outputs, final assembly

3. CHECKPOINT PLACEMENT (CRITICAL)
   Insert checkpoints at NATURAL DECISION POINTS:
   - After research/discovery phase → user can redirect
   - After first draft → user can provide feedback
   - Before significant effort → confirm direction
   - After each major phase transition
   
   DO NOT checkpoint:
   - Between trivially connected tasks
   - Mid-thought or mid-document
   - After every single task (over-fragmentation)
   
   GUIDELINE: No more than ${MAX_CONSECUTIVE_WORK_TASKS} consecutive work tasks without a checkpoint.

4. DEPENDENCIES
   - Tasks can depend on previous task outputs
   - Use task IDs in dependencies array
   - Ensure no circular dependencies

5. SUPPORTED ACTIONS PER ROLE
   - researcher: ["web_search", "web_fetch", "memory_search"]
   - writer: ["memory_search"]
   - coder: ["code_execution", "web_search"]
   - analyst: ["code_execution", "web_search", "memory_search"]
   - editor: ["memory_search"]
   - seo_specialist: ["web_search"]
   - data_processor: ["code_execution"]
   - synthesizer: ["memory_search"]

OUTPUT FORMAT:
Return ONLY valid JSON (no markdown fences, no explanation):
{
  "tasks": [
    {
      "id": "task_1",
      "name": "Short task name",
      "description": "Detailed description of what to do",
      "type": "work" | "checkpoint",
      "workerRole": "role_name",
      "instruction": "Specific instruction for the worker",
      "supportedActions": ["action1", "action2"],
      "dependencies": [],
      "checkpointMessage": "Message to show user (only for checkpoint type)",
      "estimatedComplexity": "low" | "medium" | "high"
    }
  ],
  "estimatedTotalTime": "X-Y minutes",
  "summary": "Brief plan summary"
}`;

const REPLAN_PROMPT = `You are replanning a failed task sequence.

ORIGINAL OBJECTIVE: {objective}
PREVIOUS PLAN SUMMARY: {previousSummary}
FAILURE REASON: {failureReason}
COMPLETED TASKS: {completedTasks}
USER FEEDBACK: {userFeedback}

Create a NEW plan that:
1. Builds on successfully completed work (don't repeat)
2. Addresses the failure reason
3. Incorporates any user feedback
4. May take a different approach if the original failed

Return the same JSON format as a fresh plan.`;

// =============================================================
// Planner Class
// =============================================================

export class Planner {
  private gemini: GeminiClient;

  constructor(gemini: GeminiClient) {
    this.gemini = gemini;
  }

  // -----------------------------------------------------------
  // Complexity Assessment
  // -----------------------------------------------------------

  async assessComplexity(userQuery: string): Promise<ComplexityAssessment> {
    const prompt = COMPLEXITY_ASSESSMENT_PROMPT.replace('{userQuery}', userQuery);

    try {
      const response = await this.gemini.generateWithTools(
        [{ role: 'user', content: prompt }],
        [],
        { stream: false, temperature: 0.3 }
      );

      const parsed = this.parseJson<ComplexityAssessment>(response.text);
      return parsed;
    } catch (error) {
      console.error('[Planner] Complexity assessment failed:', error);
      // Default to direct for safety
      return {
        isComplex: false,
        reason: 'Assessment failed, defaulting to direct',
        suggestedApproach: 'direct',
      };
    }
  }

  // -----------------------------------------------------------
  // Plan Creation
  // -----------------------------------------------------------

  async createPlan(input: PlannerInput): Promise<PlannerOutput> {
    const userPrompt = `
OBJECTIVE: ${input.objective}
USER QUERY: ${input.userQuery}
CONTEXT: ${input.context || 'No additional context'}

Create a detailed task plan following the system instructions.`;

    try {
      const response = await this.gemini.generateWithTools(
        [
          { role: 'system', content: PLANNER_SYSTEM_PROMPT },
          { role: 'user', content: userPrompt },
        ],
        [],
        { stream: false, temperature: 0.4 }
      );

      const parsed = this.parseJson<{
        tasks: Partial<Task>[];
        estimatedTotalTime: string;
        summary: string;
      }>(response.text);

      // Validate and normalize tasks
      const tasks = this.normalizeTasks(parsed.tasks);
      const checkpointCount = tasks.filter(t => t.type === 'checkpoint').length;

      // Validate checkpoint distribution
      this.validateCheckpointDistribution(tasks);

      return {
        tasks,
        estimatedTotalTime: parsed.estimatedTotalTime || 'Unknown',
        checkpointCount,
        summary: parsed.summary || 'Plan created',
      };
    } catch (error) {
      console.error('[Planner] Plan creation failed:', error);
      throw new Error(`Failed to create plan: ${error}`);
    }
  }

  // -----------------------------------------------------------
  // Replanning
  // -----------------------------------------------------------

  async replan(input: PlannerInput): Promise<PlannerOutput> {
    if (!input.previousAttempt) {
      throw new Error('Previous attempt required for replanning');
    }

    const completedTasks = input.previousAttempt.tasks
      .filter(t => t.status === 'complete')
      .map(t => `- ${t.name}: ${t.result?.substring(0, 100)}...`)
      .join('\n');

    const prompt = REPLAN_PROMPT
      .replace('{objective}', input.objective)
      .replace('{previousSummary}', this.summarizeBoard(input.previousAttempt))
      .replace('{failureReason}', input.failureReason || 'Unknown')
      .replace('{completedTasks}', completedTasks || 'None')
      .replace('{userFeedback}', input.previousAttempt.tasks
        .map(t => t.userFeedback)
        .filter(Boolean)
        .join('; ') || 'None');

    try {
      const response = await this.gemini.generateWithTools(
        [
          { role: 'system', content: PLANNER_SYSTEM_PROMPT },
          { role: 'user', content: prompt },
        ],
        [],
        { stream: false, temperature: 0.5 }
      );

      const parsed = this.parseJson<{
        tasks: Partial<Task>[];
        estimatedTotalTime: string;
        summary: string;
      }>(response.text);

      const tasks = this.normalizeTasks(parsed.tasks);
      const checkpointCount = tasks.filter(t => t.type === 'checkpoint').length;

      return {
        tasks,
        estimatedTotalTime: parsed.estimatedTotalTime || 'Unknown',
        checkpointCount,
        summary: parsed.summary || 'Replanned',
      };
    } catch (error) {
      console.error('[Planner] Replan failed:', error);
      throw new Error(`Failed to replan: ${error}`);
    }
  }

  // -----------------------------------------------------------
  // Task Board Factory
  // -----------------------------------------------------------

  createBoard(
    sessionId: string,
    objective: string,
    context: string,
    planOutput: PlannerOutput
  ): TaskBoard {
    const now = Date.now();

    return {
      id: `board_${now}_${Math.random().toString(36).substr(2, 9)}`,
      sessionId,
      objective,
      context,
      tasks: planOutput.tasks,
      currentIdx: 0,
      globals: {},
      status: 'executing',
      createdAt: now,
      updatedAt: now,
      totalCheckpoints: planOutput.checkpointCount,
      completedCheckpoints: 0,
    };
  }

  // -----------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------

  private normalizeTasks(rawTasks: Partial<Task>[]): Task[] {
    const now = Date.now();

    return rawTasks.slice(0, MAX_TASKS_PER_PLAN).map((raw, idx) => ({
      id: raw.id || `task_${idx + 1}`,
      name: raw.name || `Task ${idx + 1}`,
      description: raw.description || '',
      type: raw.type || 'work',
      workerRole: raw.workerRole || WORKER_ROLES.SYNTHESIZER,
      instruction: raw.instruction || raw.description || '',
      supportedActions: raw.supportedActions || [],
      dependencies: raw.dependencies || [],
      status: 'pending' as TaskStatus,
      retryCount: 0,
      maxRetries: raw.maxRetries ?? DEFAULT_MAX_RETRIES,
      checkpointMessage: raw.checkpointMessage,
      estimatedComplexity: raw.estimatedComplexity || 'medium',
      createdAt: now,
    }));
  }

  private validateCheckpointDistribution(tasks: Task[]): void {
    let consecutiveWork = 0;

    for (const task of tasks) {
      if (task.type === 'work') {
        consecutiveWork++;
        if (consecutiveWork > MAX_CONSECUTIVE_WORK_TASKS + 1) {
          console.warn(
            `[Planner] Warning: ${consecutiveWork} consecutive work tasks without checkpoint`
          );
        }
      } else if (task.type === 'checkpoint') {
        consecutiveWork = 0;
      }
    }
  }

  private summarizeBoard(board: TaskBoard): string {
    const completed = board.tasks.filter(t => t.status === 'complete').length;
    const failed = board.tasks.filter(t => t.status === 'failed').length;
    return `${completed}/${board.tasks.length} completed, ${failed} failed. Current: task ${board.currentIdx + 1}`;
  }

  private parseJson<T>(text: string): T {
    // Try direct parse first
    try {
      return JSON.parse(text);
    } catch {
      // Try extracting from markdown code block
      const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[1].trim());
      }

      // Try finding JSON object/array in text
      const objectMatch = text.match(/\{[\s\S]*\}/);
      if (objectMatch) {
        return JSON.parse(objectMatch[0]);
      }

      const arrayMatch = text.match(/\[[\s\S]*\]/);
      if (arrayMatch) {
        return JSON.parse(arrayMatch[0]);
      }

      throw new Error('No valid JSON found in response');
    }
  }
}

export default Planner;
