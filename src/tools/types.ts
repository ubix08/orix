// src/tools/types.ts - Tool Type Definitions

export interface ToolCall {
  name: string;
  args: Record<string, any>;
}

export interface ToolResult {
  name: string;
  success: boolean;
  result: string;
  error?: string;
  metadata?: Record<string, any>;
}

export interface ToolContext {
  sessionId: string;
  userId?: string;
  conversationHistory?: any[];
  [key: string]: any;
}

export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, any>;
  execute: (args: Record<string, any>, context: ToolContext) => Promise<ToolResult>;
}

/**
 * Example tool implementation
 */
export class ExampleTool implements Tool {
  name = 'example_tool';
  description = 'An example tool that demonstrates the tool interface';
  parameters = {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'The query to process',
      },
    },
    required: ['query'],
  };

  async execute(
    args: Record<string, any>,
    context: ToolContext
  ): Promise<ToolResult> {
    try {
      const { query } = args;
      
      // Your tool logic here
      const result = `Processed query: ${query}`;
      
      return {
        name: this.name,
        success: true,
        result,
      };
    } catch (error) {
      return {
        name: this.name,
        success: false,
        result: `Error: ${error}`,
        error: String(error),
      };
    }
  }
}
