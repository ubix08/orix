// src/tools/examples.ts - Example External Tool Implementations
import type { Tool, ToolResult } from './types';
import type { AgentState } from '../types';

/**
 * Example: Simple calculator tool
 */
export const calculatorTool: Tool = {
  name: 'calculator',
  description: 'Performs basic arithmetic operations (add, subtract, multiply, divide)',
  parameters: {
    type: 'object',
    properties: {
      operation: {
        type: 'string',
        enum: ['add', 'subtract', 'multiply', 'divide'],
        description: 'The arithmetic operation to perform',
      },
      a: {
        type: 'number',
        description: 'First operand',
      },
      b: {
        type: 'number',
        description: 'Second operand',
      },
    },
    required: ['operation', 'a', 'b'],
  },
  async execute(args: Record<string, any>, _state: AgentState): Promise<ToolResult> {
    const { operation, a, b } = args;

    if (typeof a !== 'number' || typeof b !== 'number') {
      return {
        name: 'calculator',
        success: false,
        result: 'Invalid operands: a and b must be numbers',
      };
    }

    let result: number;
    try {
      switch (operation) {
        case 'add':
          result = a + b;
          break;
        case 'subtract':
          result = a - b;
          break;
        case 'multiply':
          result = a * b;
          break;
        case 'divide':
          if (b === 0) {
            return {
              name: 'calculator',
              success: false,
              result: 'Cannot divide by zero',
            };
          }
          result = a / b;
          break;
        default:
          return {
            name: 'calculator',
            success: false,
            result: `Unknown operation: ${operation}`,
          };
      }

      return {
        name: 'calculator',
        success: true,
        result: `${a} ${operation} ${b} = ${result}`,
      };
    } catch (e) {
      return {
        name: 'calculator',
        success: false,
        result: `Calculation error: ${String(e)}`,
      };
    }
  },
};

/**
 * Example: Time/date tool
 */
export const timeTool: Tool = {
  name: 'get_current_time',
  description: 'Gets the current date and time in various formats',
  parameters: {
    type: 'object',
    properties: {
      format: {
        type: 'string',
        enum: ['iso', 'unix', 'readable'],
        description: 'The format for the time output',
      },
      timezone: {
        type: 'string',
        description: 'Optional timezone (e.g., "America/New_York")',
      },
    },
    required: ['format'],
  },
  async execute(args: Record<string, any>, _state: AgentState): Promise<ToolResult> {
    const { format, timezone } = args;
    const now = new Date();

    try {
      let result: string;

      switch (format) {
        case 'iso':
          result = now.toISOString();
          break;
        case 'unix':
          result = Math.floor(now.getTime() / 1000).toString();
          break;
        case 'readable':
          if (timezone) {
            result = now.toLocaleString('en-US', { timeZone: timezone });
          } else {
            result = now.toLocaleString();
          }
          break;
        default:
          return {
            name: 'get_current_time',
            success: false,
            result: `Unknown format: ${format}`,
          };
      }

      return {
        name: 'get_current_time',
        success: true,
        result: `Current time (${format}): ${result}`,
      };
    } catch (e) {
      return {
        name: 'get_current_time',
        success: false,
        result: `Error getting time: ${String(e)}`,
      };
    }
  },
};

/**
 * Example: State inspection tool
 */
export const stateInspectorTool: Tool = {
  name: 'inspect_state',
  description: 'Inspects the current conversation state and context',
  parameters: {
    type: 'object',
    properties: {
      include: {
        type: 'array',
        items: {
          type: 'string',
          enum: ['sessionId', 'files', 'searchResults', 'historyCount'],
        },
        description: 'What information to include in the inspection',
      },
    },
    required: ['include'],
  },
  async execute(args: Record<string, any>, state: AgentState): Promise<ToolResult> {
    const { include } = args;

    if (!Array.isArray(include)) {
      return {
        name: 'inspect_state',
        success: false,
        result: 'include must be an array',
      };
    }

    const info: Record<string, any> = {};

    for (const item of include) {
      switch (item) {
        case 'sessionId':
          info.sessionId = state.sessionId;
          break;
        case 'files':
          info.files = state.context?.files?.map(f => ({
            name: f.name,
            mimeType: f.mimeType,
            size: f.sizeBytes,
          })) ?? [];
          break;
        case 'searchResults':
          info.searchResultsCount = state.context?.searchResults?.length ?? 0;
          break;
        case 'historyCount':
          info.historyCount = state.conversationHistory?.length ?? 0;
          break;
      }
    }

    return {
      name: 'inspect_state',
      success: true,
      result: JSON.stringify(info, null, 2),
    };
  },
};

/**
 * Helper function to get all example tools
 */
export function getExampleTools(): Tool[] {
  return [calculatorTool, timeTool, stateInspectorTool];
}
