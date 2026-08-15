import type { ModelProvider } from "../models/ModelProvider.js";
import type { Message } from "../models/types.js";
import type { ToolRegistry } from "../tools/ToolRegistry.js";
import { ExecutionTrace } from "../observability/ExecutionTrace.js";
import type { ProjectMemory } from "../memory/ProjectMemory.js";

export class Agent {
  constructor(
    private readonly model: ModelProvider,
    private readonly tools: ToolRegistry,
    private readonly trace: ExecutionTrace,
    private readonly memory: ProjectMemory,
  ) {}

  async run(prompt: string): Promise<string> {
    const memoryEntries = this.memory.search(prompt);

    const memoryContext =
      memoryEntries.length > 0
        ? memoryEntries
            .map((entry) => `[${entry.category}] ${entry.content}`)
            .join("\n")
        : "No relevant project memory was found.";

    const messages: Message[] = [
      {
        role: "system",
        content: `You are a local project agent.

Use the following project memory when it is relevant:

${memoryContext}

Do not invent project-specific facts that are not supported by the available memory or tools.`,
      },
      {
        role: "user",
        content: prompt,
      },
    ];

    const maxIterations = 10;

    const executedToolCalls = new Set<string>();

    for (let iteration = 0; iteration < maxIterations; iteration += 1) {
      const modelStartedAt = Date.now();

      const response = await this.model.generate(
        messages,
        this.tools.getDefinitions(),
      );

      this.trace.add({
        type: "model",
        iteration,
        durationMs: Date.now() - modelStartedAt,
        toolCallCount: response.toolCalls.length,
      });

      messages.push({
        role: "assistant",
        content: response.content,
        toolCalls: response.toolCalls,
      });

      if (response.toolCalls.length === 0) {
        return response.content;
      }

      for (const toolCall of response.toolCalls) {
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

          messages.push({
            role: "tool",
            toolCallId: toolCall.id,
            content: JSON.stringify({
              success: false,
              error: duplicateMessage,
            }),
          });

          continue;
        }

        executedToolCalls.add(toolCallKey);

        const tool = this.tools.get(toolCall.name);

        const toolStartedAt = Date.now();

        try {
          const result = await tool.execute(toolCall.arguments);

          this.trace.add({
            type: "tool",
            iteration,
            toolName: toolCall.name,
            durationMs: Date.now() - toolStartedAt,
            success: true,
          });

          messages.push({
            role: "tool",
            toolCallId: toolCall.id,
            content: JSON.stringify(result),
          });
        } catch (error: unknown) {
          const message =
            error instanceof Error ? error.message : String(error);

          this.trace.add({
            type: "tool",
            iteration,
            toolName: toolCall.name,
            durationMs: Date.now() - toolStartedAt,
            success: false,
            error: message,
          });

          messages.push({
            role: "tool",
            toolCallId: toolCall.id,
            content: JSON.stringify({
              error: message,
            }),
          });
        }
      }
    }

    throw new Error(`Agent exceeded maximum iterations (${maxIterations})`);
  }
}
