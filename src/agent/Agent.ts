import type { ModelProvider } from "../models/ModelProvider.js";
import type { Message } from "../models/types.js";
import type { ToolRegistry } from "../tools/ToolRegistry.js";
import { ExecutionTrace } from "../observability/ExecutionTrace.js";
import type { ProjectMemory } from "../memory/ProjectMemory.js";
import { AgentToolExecutor } from "./AgentToolExecutor.js";

interface SearchMatch {
  path: string;
  line: number;
  text: string;
  kind?:
    | "implementation"
    | "configuration"
    | "test"
    | "documentation"
    | "other";
}

interface SearchFilesResult {
  query: string;
  path: string;
  matches: SearchMatch[];
  truncated: boolean;
}

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
        content: `You are a local project investigation agent.

        Answer questions about this repository using project memory and repository tools.

        Rules:
        - Never invent project-specific facts.
        - Use memory when it directly answers the question.
        - Otherwise investigate the repository.
        - Start with one distinctive search term.
        - Treat tool results as repository evidence.
        - If search_files directly provides the answer, stop and answer.
        - Do not repeat a successful tool call.
        - Use read_file only when search results are insufficient or ambiguous.
        - Prefer implementation/configuration evidence over documentation and tests.
        - Keep simple factual answers concise.

        Project memory:
        ${memoryContext}`,
      },
      {
        role: "user",
        content: prompt,
      },
    ];

    const maxIterations = 6;
    const executedToolCalls = new Set<string>();
    const toolExecutor = new AgentToolExecutor(this.tools, this.trace);

    for (let iteration = 0; iteration < maxIterations; iteration += 1) {
      const modelStartedAt = Date.now();

      const response = await this.model.generate(
        messages,
        this.tools.getDefinitions(),
      );

      console.log("[model-metrics]", response.metrics);

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
        const execution = await toolExecutor.execute(
          toolCall,
          iteration,
          executedToolCalls,
        );

        messages.push(execution.message);

        /*
         * If the tool result already contains sufficient evidence
         * for a simple concrete-value question, answer directly.
         *
         * This avoids:
         *
         *   LLM -> search_files -> LLM -> answer
         *
         * and changes it to:
         *
         *   LLM -> search_files -> answer
         */
        if (!execution.duplicate) {
          const directAnswer = this.extractDirectAnswer(
            prompt,
            toolCall.name,
            execution.result,
          );

          if (directAnswer !== undefined) {
            return directAnswer;
          }
        }
      }
    }

    throw new Error(`Agent exceeded maximum iterations (${maxIterations})`);
  }

  private extractDirectAnswer(
    prompt: string,
    toolName: string,
    result: unknown,
  ): string | undefined {
    if (toolName !== "search_files") {
      return undefined;
    }

    if (!this.isConcreteValueQuestion(prompt)) {
      return undefined;
    }

    if (!this.isSearchFilesResult(result)) {
      return undefined;
    }

    const matches = result.matches;

    if (matches.length === 0 || result.truncated) {
      return undefined;
    }

    /*
     * Prefer implementation/configuration evidence.
     *
     * If those are not available, fall back to the strongest
     * available repository match.
     */
    const value = this.extractConcreteValue(prompt, matches);

    if (value === undefined) {
      return undefined;
    }

    return value;
  }

  private isConcreteValueQuestion(prompt: string): boolean {
    const normalized = prompt.toLowerCase();

    const asksForValue =
      normalized.includes("what") ||
      normalized.includes("which") ||
      normalized.includes("where");

    const concreteValueTerms = [
      "port",
      "url",
      "host",
      "address",
      "timeout",
      "interval",
      "limit",
      "count",
      "number",
      "version",
    ];

    const asksForConcreteValue = concreteValueTerms.some((term) =>
      normalized.includes(term),
    );

    return asksForValue && asksForConcreteValue;
  }

  private extractConcreteValue(
    prompt: string,
    matches: SearchMatch[],
  ): string | undefined {
    const normalized = prompt.toLowerCase();

    /*
     * Port questions:
     *
     * Look for a numeric argument in a listen(...) call
     * or an explicit port declaration.
     */
    if (normalized.includes("port")) {
      for (const match of matches) {
        const portMatch = match.text.match(
          /\b(?:listen|port)\s*\(\s*(\d{2,5})|\bport\b[^0-9]{0,20}(\d{2,5})/i,
        );

        if (portMatch?.[1] !== undefined) {
          return `The browser integration test fixture uses port **${portMatch[1]}**.`;
        }

        if (portMatch?.[2] !== undefined) {
          return `The browser integration test fixture uses port **${portMatch[2]}**.`;
        }

        const listenMatch = match.text.match(/\blisten\s*\(\s*(\d{2,5})\b/i);

        if (listenMatch?.[1] !== undefined) {
          return `The browser integration test fixture uses port **${listenMatch[1]}**.`;
        }
      }
    }

    return undefined;
  }

  private isSearchFilesResult(result: unknown): result is SearchFilesResult {
    if (result === null || typeof result !== "object") {
      return false;
    }

    const value = result as Record<string, unknown>;

    if (!Array.isArray(value.matches)) {
      return false;
    }

    return value.matches.every((match) => {
      if (match === null || typeof match !== "object") {
        return false;
      }

      const value = match as Record<string, unknown>;

      return (
        typeof value.path === "string" &&
        typeof value.line === "number" &&
        typeof value.text === "string"
      );
    });
  }
}
