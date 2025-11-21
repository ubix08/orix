// src/orchestration/worker.ts
// Task Worker - Executes atomic tasks with ReAct-style reasoning

import type { GeminiClient } from '../gemini';
import type { Task, WorkerResult, WorkerContext, ToolCallRecord } from './types';
import { WORKER_ROLES, DEFAULT_WORKER_MAX_TURNS } from './types';

// =============================================================
// Worker Role Prompts
// =============================================================

const ROLE_PROMPTS: Record<string, string> = {
  [WORKER_ROLES.RESEARCHER]: `You are an expert researcher. Your job is to gather accurate, relevant information from multiple sources.

APPROACH:
- Search for authoritative sources first
- Cross-reference facts across sources
- Note conflicting information
- Cite sources when possible
- Focus on recent, up-to-date information

OUTPUT: Structured findings with key points, sources, and confidence levels.`,

  [WORKER_ROLES.WRITER]: `You are an expert content writer. Your job is to create clear, engaging, well-structured content.

APPROACH:
- Start with a clear structure/outline
- Write in an engaging, accessible style
- Use concrete examples and evidence
- Maintain consistent tone throughout
- Include relevant headers and formatting

OUTPUT: Polished written content ready for review.`,

  [WORKER_ROLES.CODER]: `You are an expert software developer. Your job is to write clean, functional, well-documented code.

APPROACH:
- Understand requirements fully before coding
- Write modular, reusable code
- Include error handling
- Add comments for complex logic
- Follow best practices for the language

OUTPUT: Working code with explanations and usage examples.`,

  [WORKER_ROLES.ANALYST]: `You are an expert data analyst. Your job is to analyze information and extract meaningful insights.

APPROACH:
- Identify key metrics and patterns
- Compare and contrast data points
- Look for trends and anomalies
- Quantify findings where possible
- Draw actionable conclusions

OUTPUT: Clear analysis with findings, insights, and recommendations.`,

  [WORKER_ROLES.EDITOR]: `You are an expert editor. Your job is to refine and improve content quality.

APPROACH:
- Check for clarity and coherence
- Fix grammar and style issues
- Improve flow and readability
- Ensure consistency
- Strengthen weak arguments

OUTPUT: Edited content with tracked changes or explanations.`,

  [WORKER_ROLES.SEO_SPECIALIST]: `You are an SEO expert. Your job is to optimize content for search engines while maintaining quality.

APPROACH:
- Research relevant keywords
- Optimize titles and meta descriptions
- Improve heading structure
- Enhance internal/external linking strategy
- Balance SEO with readability

OUTPUT: SEO recommendations or optimized content.`,

  [WORKER_ROLES.DATA_PROCESSOR]: `You are a data processing expert. Your job is to transform, clean, and format data.

APPROACH:
- Validate input data quality
- Apply appropriate transformations
- Handle edge cases and errors
- Maintain data integrity
- Document processing steps

OUTPUT: Processed data with validation summary.`,

  [WORKER_ROLES.SYNTHESIZER]: `You are an expert at synthesizing information. Your job is to combine multiple inputs into a coherent whole.

APPROACH:
- Identify common themes
- Resolve contradictions
- Create logical flow
- Highlight key takeaways
- Present unified narrative

OUTPUT: Synthesized content that integrates all inputs coherently.`,
};

// =============================================================
// Worker Execution Prompt
// =============================================================

const WORKER_EXECUTION_PROMPT = `{rolePrompt}

CURRENT TASK
============
Name: {taskName}
Description: {taskDescription}
Instruction: {taskInstruction}

AVAILABLE CONTEXT
=================
{globals}

PREVIOUS WORK (if any)
======================
{previousWork}

YOUR TASK
=========
Complete the task described above. Think step by step.

If you need to use tools, describe what you need and I will execute them.
When you have completed the task, provide your final output clearly marked.

RESPONSE FORMAT:
- If still working: Explain your reasoning and what you need next
- If complete: Start with "TASK COMPLETE:" followed by your final output
- If stuck: Start with "TASK BLOCKED:" followed by the issue`;

// =============================================================
// Self-Assessment Prompt
// =============================================================

const SELF_ASSESSMENT_PROMPT = `You are evaluating the quality of a task output.

TASK: {taskName}
DESCRIPTION: {taskDescription}
OUTPUT:
{output}

Evaluate this output on:
1. Completeness - Does it fully address the task?
2. Quality - Is the work well-done?
3. Usability - Can the next task use this output?

Respond ONLY with JSON (no markdown):
{"satisfactory": boolean, "issues": ["issue1", "issue2"] or [], "suggestions": "how to improve" or null}`;

// =============================================================
// Worker Class
// =============================================================

export class Worker {
  private gemini: GeminiClient;
  private maxTurns: number;

  constructor(gemini: GeminiClient, maxTurns: number = DEFAULT_WORKER_MAX_TURNS) {
    this.gemini = gemini;
    this.maxTurns = maxTurns;
  }

  // -----------------------------------------------------------
  // Main Execution
  // -----------------------------------------------------------

  async execute(
    task: Task,
    globals: Record<string, string>,
    previousOutputs: Record<string, string>,
    onProgress?: (message: string) => void
  ): Promise<WorkerResult> {
    const rolePrompt = ROLE_PROMPTS[task.workerRole] || ROLE_PROMPTS[WORKER_ROLES.SYNTHESIZER];
    const context: WorkerContext = {
      role: task.workerRole,
      systemPrompt: rolePrompt,
      supportedActions: task.supportedActions,
      maxTurns: task.maxRetries > 0 ? this.maxTurns : this.maxTurns + 2,
      history: [],
    };

    // Build globals string
    const globalsStr = Object.entries(globals).length > 0
      ? Object.entries(globals).map(([k, v]) => `${k}: ${v}`).join('\n')
      : 'None';

    // Build previous work string (from dependencies)
    const previousWork = task.dependencies
      .map(depId => previousOutputs[depId])
      .filter(Boolean)
      .map((output, i) => `[Output ${i + 1}]\n${output}`)
      .join('\n\n') || 'None';

    // Build initial prompt
    const prompt = WORKER_EXECUTION_PROMPT
      .replace('{rolePrompt}', rolePrompt)
      .replace('{taskName}', task.name)
      .replace('{taskDescription}', task.description)
      .replace('{taskInstruction}', task.instruction)
      .replace('{globals}', globalsStr)
      .replace('{previousWork}', previousWork);

    let turn = 0;
    let lastResponse = '';
    const toolsUsed: string[] = [];

    onProgress?.(`Starting: ${task.name}`);

    // ReAct loop
    while (turn < context.maxTurns) {
      turn++;
      onProgress?.(`Turn ${turn}/${context.maxTurns}`);

      try {
        const messages = this.buildMessages(context, prompt, lastResponse);
        const response = await this.gemini.generateWithTools(
          messages,
          [],
          {
            stream: false,
            temperature: 0.6,
            useSearch: task.supportedActions.includes('web_search'),
            useCodeExecution: task.supportedActions.includes('code_execution'),
          }
        );

        lastResponse = response.text || '';

        // Record turn
        context.history.push({
          prompt: turn === 1 ? prompt : 'Continue',
          response: lastResponse,
          toolCalls: response.toolCalls?.map(tc => ({
            name: tc.name,
            args: tc.args,
            result: '',
            success: true,
          })),
          timestamp: Date.now(),
        });

        // Track tools used
        if (response.toolCalls) {
          for (const tc of response.toolCalls) {
            if (!toolsUsed.includes(tc.name)) {
              toolsUsed.push(tc.name);
            }
          }
        }

        // Check for completion
        if (this.isTaskComplete(lastResponse)) {
          const output = this.extractFinalOutput(lastResponse);
          
          // Self-assessment
          const assessment = await this.assessOutput(task, output);
          
          if (assessment.satisfactory) {
            onProgress?.(`Completed: ${task.name}`);
            return {
              success: true,
              output,
              turnsUsed: turn,
              toolsUsed,
              needsRetry: false,
            };
          } else {
            // Not satisfactory but turns remain - try to improve
            if (turn < context.maxTurns - 1) {
              lastResponse = `Your output needs improvement. Issues: ${assessment.issues.join(', ')}. ${assessment.suggestions || 'Please revise.'}`;
              continue;
            }
            
            // Out of turns - return with retry flag
            return {
              success: false,
              output,
              turnsUsed: turn,
              toolsUsed,
              needsRetry: true,
              retryReason: assessment.issues.join('; '),
            };
          }
        }

        // Check for blocked state
        if (this.isTaskBlocked(lastResponse)) {
          const blockReason = this.extractBlockReason(lastResponse);
          return {
            success: false,
            output: '',
            error: blockReason,
            turnsUsed: turn,
            toolsUsed,
            needsRetry: true,
            retryReason: blockReason,
          };
        }

        // Continue loop - model is still working

      } catch (error) {
        console.error(`[Worker] Turn ${turn} error:`, error);
        return {
          success: false,
          output: '',
          error: String(error),
          turnsUsed: turn,
          toolsUsed,
          needsRetry: turn < 2, // Only retry if early failure
          retryReason: String(error),
        };
      }
    }

    // Max turns reached without completion
    onProgress?.(`Max turns reached for: ${task.name}`);
    return {
      success: false,
      output: lastResponse,
      error: 'Max turns reached without task completion',
      turnsUsed: turn,
      toolsUsed,
      needsRetry: true,
      retryReason: 'Exceeded maximum turns',
    };
  }

  // -----------------------------------------------------------
  // Retry with Feedback
  // -----------------------------------------------------------

  async retryWithFeedback(
    task: Task,
    previousResult: WorkerResult,
    feedback: string,
    globals: Record<string, string>,
    previousOutputs: Record<string, string>,
    onProgress?: (message: string) => void
  ): Promise<WorkerResult> {
    // Augment task instruction with feedback
    const augmentedTask: Task = {
      ...task,
      instruction: `${task.instruction}

PREVIOUS ATTEMPT FEEDBACK:
${feedback}

PREVIOUS OUTPUT (if any):
${previousResult.output || 'None'}

Please address the feedback and improve your output.`,
    };

    onProgress?.(`Retrying with feedback: ${task.name}`);
    return this.execute(augmentedTask, globals, previousOutputs, onProgress);
  }

  // -----------------------------------------------------------
  // Self-Assessment
  // -----------------------------------------------------------

  private async assessOutput(
    task: Task,
    output: string
  ): Promise<{ satisfactory: boolean; issues: string[]; suggestions: string | null }> {
    // Skip assessment for trivial outputs
    if (output.length < 50) {
      return { satisfactory: true, issues: [], suggestions: null };
    }

    const prompt = SELF_ASSESSMENT_PROMPT
      .replace('{taskName}', task.name)
      .replace('{taskDescription}', task.description)
      .replace('{output}', output.substring(0, 2000)); // Limit for assessment

    try {
      const response = await this.gemini.generateWithTools(
        [{ role: 'user', content: prompt }],
        [],
        { stream: false, temperature: 0.3 }
      );

      const parsed = this.parseJson<{
        satisfactory: boolean;
        issues: string[];
        suggestions: string | null;
      }>(response.text);

      return parsed;
    } catch {
      // Default to satisfactory if assessment fails
      return { satisfactory: true, issues: [], suggestions: null };
    }
  }

  // -----------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------

  private buildMessages(
    context: WorkerContext,
    initialPrompt: string,
    lastResponse: string
  ): Array<{ role: string; content: string }> {
    const messages: Array<{ role: string; content: string }> = [
      { role: 'system', content: context.systemPrompt },
    ];

    if (context.history.length === 0) {
      messages.push({ role: 'user', content: initialPrompt });
    } else {
      // Add conversation history
      messages.push({ role: 'user', content: initialPrompt });
      
      for (const turn of context.history) {
        messages.push({ role: 'assistant', content: turn.response });
      }

      // Add continuation prompt if needed
      if (lastResponse && !this.isTaskComplete(lastResponse)) {
        messages.push({ role: 'user', content: 'Continue with your task.' });
      }
    }

    return messages;
  }

  private isTaskComplete(response: string): boolean {
    const lowerResponse = response.toLowerCase();
    return (
      lowerResponse.includes('task complete:') ||
      lowerResponse.includes('task completed:') ||
      lowerResponse.includes('final output:') ||
      lowerResponse.includes('here is the final')
    );
  }

  private isTaskBlocked(response: string): boolean {
    const lowerResponse = response.toLowerCase();
    return (
      lowerResponse.includes('task blocked:') ||
      lowerResponse.includes('cannot proceed:') ||
      lowerResponse.includes('unable to complete:')
    );
  }

  private extractFinalOutput(response: string): string {
    // Try to extract content after completion marker
    const markers = ['task complete:', 'task completed:', 'final output:'];
    const lowerResponse = response.toLowerCase();

    for (const marker of markers) {
      const idx = lowerResponse.indexOf(marker);
      if (idx !== -1) {
        return response.substring(idx + marker.length).trim();
      }
    }

    // Fallback - return full response
    return response;
  }

  private extractBlockReason(response: string): string {
    const markers = ['task blocked:', 'cannot proceed:', 'unable to complete:'];
    const lowerResponse = response.toLowerCase();

    for (const marker of markers) {
      const idx = lowerResponse.indexOf(marker);
      if (idx !== -1) {
        return response.substring(idx + marker.length).trim().split('\n')[0];
      }
    }

    return 'Unknown blocking issue';
  }

  private parseJson<T>(text: string): T {
    try {
      return JSON.parse(text);
    } catch {
      const match = text.match(/\{[\s\S]*\}/);
      if (match) {
        return JSON.parse(match[0]);
      }
      throw new Error('No valid JSON found');
    }
  }
}

export default Worker;
