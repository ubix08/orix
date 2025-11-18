// src/tools/plan-next-step.ts - The "Thinking" Tool
import type { Tool, ToolResult } from './types';
import type { AgentState } from '../types';

/**
 * This is the agent's "thinking" tool.
 * It is used to plan, reflect, and update its strategy for complex tasks.
 * It doesn't perform an external action; it's a "no-op" (no-operation)
 * that forces the agent to state its plan, which is then fed back into
 * the agent loop.
 */
export const planNextStepTool: Tool = {
  name: 'planNextStep',
  description:
    'Used by the agent to think, plan, and update its internal state for complex tasks. This is the primary tool for autonomous operation.',
  parameters: {
    type: 'object',
    properties: {
      thoughts: {
        type: 'string',
        description:
          'Your internal monologue, reflections on the last step, and reasoning.',
      },
      plan: {
        type: 'array',
        items: { type: 'string' },
        description:
          'The full, step-by-step plan. Revise and update this list as you go.',
      },
      currentStep: {
        type: 'string',
        description:
          'The specific step from the plan you are about to execute next.',
      },
      status: {
        type: 'string',
        enum: ['IN_PROGRESS'],
        description: 'Always set to IN_PROGRESS while the plan is active.',
      },
    },
    required: ['thoughts', 'plan', 'currentStep', 'status'],
  },

  /**
   * This tool's execution is a "no-op". It just acknowledges the plan.
   * This allows the agent loop to continue and feed this "plan" back
   * to the model as a "tool result".
   */
  async execute(
    args: Record<string, any>,
    _state: AgentState,
  ): Promise<ToolResult> {
    const { thoughts, plan, currentStep } = args;

    // Log the agent's thoughts for observability/debugging
    console.log(`[Agent Plan] Thoughts: ${thoughts}`);
    console.log(`[Agent Plan] Step: ${currentStep}`);
    console.log(`[Agent Plan] Full Plan: ${(plan || []).join(' | ')}`);

    return {
      name: 'planNextStep',
      success: true,
      result: `Plan acknowledged. Current step to execute: "${currentStep}". Proceeding.`,
    };
  },
};
