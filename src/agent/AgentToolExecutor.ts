import type { ToolRegistry } from "../tools/ToolRegistry.js";
import type { ToolCall, Message } from "../models/types.js";
import { ExecutionTrace } from "../observability/ExecutionTrace.js";

export class AgentToolExecutor {
  constructor(
    private readonly tools: ToolRegistry,
    private readonly trace: ExecutionTrace,
  ) {}

  async execute(
    toolCall: ToolCall,
    iteration: number,
    executedToolCalls: Set<string>,
  ): Promise<Message> {
    console.log(
      `\n[tool] ${toolCall.name}`,
      JSON.stringify(toolCall.arguments),
    );

    const toolCallKey = JSON.stringify({
      name: toolCall.name,
      arguments: toolCall.arguments,
    });

    if (executedToolCalls.has(toolCallKey)) {
      const duplicateMessage =
        "This exact tool call has already been executed successfully. Do not call it again. Continue with the task or provide the final answer.";

      this.trace.add({
        type: "tool",
        iteration,
        toolName: toolCall.name,
        durationMs: 0,
        success: false,
        error: "Duplicate tool call prevented",
      });

      return {
        role: "tool",
        toolCallId: toolCall.id,
        content: JSON.stringify({
          success: false,
          error: duplicateMessage,
        }),
      }
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
        role: "tool",
        toolCallId: toolCall.id,
        content: JSON.stringify(result),
      }
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
        role: "tool",
        toolCallId: toolCall.id,
        content: JSON.stringify({
          error: message,
        }),
      }
    }
  }
}
