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

        Your job is to answer questions about the project accurately.

        Use the following project memory when it is relevant:

        ${memoryContext}

        Rules:

        1. Do not invent or guess project-specific facts.
        2. If project memory contains the answer, use it.
        3. If memory does not contain the answer, investigate the repository using the available tools.
        4. When information is missing, investigate the repository instead of answering from general knowledge.
        5. Start repository investigation by discovering the actual project structure when the relevant path is unknown.
        6. Never assume that a directory named "test" or "tests" exists.
        7. Use search_files with one distinctive term at a time, such as a feature name, filename, class name, function name, URL, or exact value.
        8. Avoid broad generic searches such as "port" when a more specific project term is available.
        9. Treat search results as leads, not automatically as authoritative evidence.
        10. After finding a potentially relevant file, use read_file to inspect it before answering.
        11. When multiple files match, prefer actual implementation or configuration over tests, documentation, fixtures, or memory-test data.
        12. For concrete values such as ports, URLs, configuration values, or identifiers, locate the code that defines or uses that value.
        13. If a search produces no useful results, change the search term and try again.
        14. Do not conclude that information is unavailable after one unsuccessful search.
        15. Only provide a final answer when there is evidence from project memory or project files.
        16. When the available tools genuinely cannot establish the answer, clearly say that the information could not be determined.

        You are an agent. Investigate before answering when information is missing.`,
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
          console.log("[tool-result]", JSON.stringify(result, null, 2));

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
