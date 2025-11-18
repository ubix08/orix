// src/tools/registry.ts - Missing implementation
import type { Tool, ToolResult, ToolContext } from '../types';

export class ToolRegistry {
  private tools: Map<string, Tool> = new Map();

  register(tool: Tool): void {
    this.tools.set(tool.name, tool);
  }

  unregister(name: string): void {
    this.tools.delete(name);
  }

  getAll(): Tool[] {
    return Array.from(this.tools.values());
  }

  async execute(
    name: string,
    args: Record<string, any>,
    context: ToolContext
  ): Promise<ToolResult> {
    const tool = this.tools.get(name);
    
    if (!tool) {
      return {
        name,
        success: false,
        result: `Tool '${name}' not found`,
        error: 'TOOL_NOT_FOUND',
      };
    }

    try {
      return await tool.execute(args, context);
    } catch (error) {
      return {
        name,
        success: false,
        result: `Tool execution failed: ${error}`,
        error: String(error),
      };
    }
  }
}
