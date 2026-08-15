import type { ModelProvider } from "../models/ModelProvider.js";
import type { Message } from "../models/types.js";
import type { ToolRegistry } from "../tools/ToolRegistry.js";

export class Agent {
  constructor(
    private readonly model: ModelProvider,
    private readonly tools: ToolRegistry,
  ) {}

  async run(prompt: string): Promise<string> {
    const messages: Message[] = [
      {
        role: "user",
        content: prompt,
      },
    ];

    const maxIterations = 10;

    for (let iteration = 0; iteration < maxIterations; iteration += 1) {
      const response = await this.model.generate(
        messages,
        this.tools.getDefinitions(),
      );

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

        const tool = this.tools.get(toolCall.name);

        try {
          const result = await tool.execute(toolCall.arguments);

          messages.push({
            role: "tool",
            toolCallId: toolCall.id,
            content: JSON.stringify(result),
          });
        } catch (error: unknown) {
          const message =
            error instanceof Error ? error.message : String(error);

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
