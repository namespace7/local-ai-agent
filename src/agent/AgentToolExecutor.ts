import type { ToolRegistry } from "../tools/ToolRegistry.js";
import type { ToolCall, Message } from "../models/types.js";
import { ExecutionTrace } from "../observability/ExecutionTrace.js";

export interface ToolExecutionResult {
  message: Message;
  duplicate: boolean;
  result?: unknown;
}

export class AgentToolExecutor {
  constructor(
    private readonly tools: ToolRegistry,
    private readonly trace: ExecutionTrace,
  ) {}

  async execute(
    toolCall: ToolCall,
    iteration: number,
    executedToolCalls: Set<string>,
  ): Promise<ToolExecutionResult> {
    console.log(
      `\n[tool] ${toolCall.name}`,
      JSON.stringify(toolCall.arguments),
    );

    const toolCallKey = this.createToolCallKey(toolCall);

    if (executedToolCalls.has(toolCallKey)) {
      const duplicateMessage =
        "This exact tool call has already been executed successfully. Use the previous tool result and provide the final answer. Do not call this tool again.";

      this.trace.add({
        type: "tool",
        iteration,
        toolName: toolCall.name,
        durationMs: 0,
        success: false,
        error: "Duplicate tool call prevented",
      });

      return {
        duplicate: true,
        message: {
          role: "tool",
          toolCallId: toolCall.id,
          content: JSON.stringify({
            success: false,
            error: duplicateMessage,
          }),
        },
      };
    }

    executedToolCalls.add(toolCallKey);

    const tool = this.tools.get(toolCall.name);
    const toolStartedAt = Date.now();

    try {
      const result = await tool.execute(toolCall.arguments);

      console.log("[tool-result]", JSON.stringify(result, null, 2));

      this.trace.add({
        type: "tool",
        iteration,
        toolName: toolCall.name,
        durationMs: Date.now() - toolStartedAt,
        success: true,
      });

      return {
        duplicate: false,
        result,
        message: {
          role: "tool",
          toolCallId: toolCall.id,
          content: JSON.stringify(result),
        },
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);

      this.trace.add({
        type: "tool",
        iteration,
        toolName: toolCall.name,
        durationMs: Date.now() - toolStartedAt,
        success: false,
        error: message,
      });

      return {
        duplicate: false,
        message: {
          role: "tool",
          toolCallId: toolCall.id,
          content: JSON.stringify({
            error: message,
          }),
        },
      };
    }
  }

  private createToolCallKey(toolCall: ToolCall): string {
    const sortedArguments = Object.keys(toolCall.arguments)
      .sort()
      .reduce<Record<string, unknown>>((result, key) => {
        result[key] = toolCall.arguments[key];
        return result;
      }, {});

    return JSON.stringify({
      name: toolCall.name,
      arguments: sortedArguments,
    });
  }
}
