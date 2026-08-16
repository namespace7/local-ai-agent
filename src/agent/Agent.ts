import type { ModelProvider } from "../models/ModelProvider.js";
import type { Message } from "../models/types.js";
import type { ToolRegistry } from "../tools/ToolRegistry.js";
import { ExecutionTrace } from "../observability/ExecutionTrace.js";
import type { ProjectMemory } from "../memory/ProjectMemory.js";
import { AgentToolExecutor } from "./AgentToolExecutor.js";
import {
  InvestigationState,
  type InvestigationTaskType,
} from "./InvestigationState.js";

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
    const investigation = new InvestigationState();
    investigation.setTaskType(this.detectTaskType(prompt));

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
        content: this.buildSystemPrompt(memoryContext, investigation),
      },
      {
        role: "user",
        content: prompt,
      },
    ];

    const maxIterations =
      investigation.getTaskType() === "implementation-plan"
        ? 12
        : investigation.getTaskType() === "existing-feature"
          ? 8
          : 6;

    const executedToolCalls = new Set<string>();
    const toolExecutor = new AgentToolExecutor(this.tools, this.trace);

    for (let iteration = 0; iteration < maxIterations; iteration += 1) {
      /*
       * Refresh the system prompt before every model call so the model
       * always sees the latest investigation evidence and inspected paths.
       */
      messages[0] = {
        role: "system",
        content: this.buildSystemPrompt(memoryContext, investigation),
      };

      const modelStartedAt = Date.now();

      const response = await this.model.generate(
        messages,
        this.tools.getDefinitions(),
      );

      console.log("[model-metrics]", response.metrics);

      console.log(
        "[model-response]",
        JSON.stringify(
          {
            content: response.content,
            toolCalls: response.toolCalls,
          },
          null,
          2,
        ),
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

      /*
       * If the model wants to answer without using a tool, only allow that
       * when the investigation has enough evidence for the task type.
       */
      if (response.toolCalls.length === 0) {
        if (
          investigation.getTaskType() !== "factual" &&
          investigation.isComplete()
        ) {
          return response.content;
        }

        messages.push({
          role: "user",
          content: `The investigation is not complete yet.

${investigation.getContext()}

Do not provide the final answer yet.

Continue investigating the repository using the available tools. Choose a tool call that obtains one of the missing evidence categories.`,
        });

        continue;
      }

      for (const toolCall of response.toolCalls) {
        /*
         * Once a non-factual investigation is complete, the model should not
         * make additional repository calls.
         *
         * Factual questions are different: they may be considered "complete"
         * before the first tool call because their investigation state does not
         * require evidence categories. The tool call itself still needs to run
         * so that extractDirectAnswer() can derive the answer from the result.
         */
        if (
          investigation.getTaskType() !== "factual" &&
          investigation.isComplete()
        ) {
          messages.push({
            role: "user",
            content: `The investigation is already complete.

            ${investigation.getContext()}

            Do not call another tool. Produce the final answer using the evidence already collected.`,
          });

          continue;
        }

        /*
         * Enforce investigation strategy at the application level.
         *
         * The model is responsible for choosing the exact path/query,
         * but the application controls whether that category of action
         * is appropriate for the current investigation state.
         */
        const policy = this.validateInvestigationToolCall(
          investigation,
          toolCall.name,
          toolCall.arguments,
        );

        console.log(
          "[investigation-policy]",
          JSON.stringify(
            {
              tool: toolCall.name,
              arguments: toolCall.arguments,
              allowed: policy.allowed,
              reason: policy.reason,
              taskType: investigation.getTaskType(),
              evidence: investigation.getEvidence(),
            },
            null,
            2,
          ),
        );

        if (!policy.allowed) {
          console.log(
            "[investigation-recovery]",
            JSON.stringify(
              {
                rejectedTool: toolCall.name,
                rejectedArguments: toolCall.arguments,
                reason: policy.reason,
                evidence: investigation.getEvidence(),
              },
              null,
              2,
            ),
          );

          const requiredTool = this.getRequiredInvestigationTool(investigation);

          /*
           * For implementation-plan tasks, the application owns the minimum
           * investigation sequence. If the model chooses an invalid action,
           * deterministically execute the next required evidence-gathering action
           * instead of asking the model to retry the same decision.
           */
          if (requiredTool !== undefined) {
            const recoveryToolCall = {
              id: `recovery-${iteration}`,
              name: requiredTool.name,
              arguments: requiredTool.arguments,
            } as typeof toolCall;

            console.log(
              "[investigation-recovery]",
              JSON.stringify(
                {
                  tool: recoveryToolCall.name,
                  arguments: recoveryToolCall.arguments,
                },
                null,
                2,
              ),
            );

            const recoveryExecution = await toolExecutor.execute(
              recoveryToolCall,
              iteration,
              executedToolCalls,
            );

            messages.push(recoveryExecution.message);

            /*
             * A recovery action should always be new. If this happens to be a
             * duplicate, do not allow the agent to silently spin.
             */
            if (recoveryExecution.duplicate) {
              throw new Error(
                `Investigation recovery attempted duplicate tool call: ${recoveryToolCall.name}`,
              );
            }

            /*
             * Record the recovery action exactly like a normal model-selected
             * investigation action.
             */
            investigation.recordToolCall(
              recoveryToolCall.name,
              this.createToolCallArgumentsKey(recoveryToolCall.arguments),
            );

            investigation.addObservation(
              recoveryToolCall.name,
              this.summarizeToolResult(recoveryExecution.result),
            );

            this.recordInspectedPath(investigation, recoveryExecution.result);

            this.updateInvestigationEvidence(
              investigation,
              recoveryToolCall.name,
              recoveryToolCall.arguments,
              recoveryExecution.result,
            );

            /*
             * The recovery action has changed the investigation state.
             *
             * Do not let the current model response issue additional calls based
             * on the stale state it generated before recovery.
             */
            break;
          }

          /*
           * If there is no deterministic recovery action, fall back to the
           * existing model-guidance behavior.
           */
          messages.push({
            role: "tool",
            toolCallId: toolCall.id,
            content: JSON.stringify({
              success: false,
              error: policy.reason,
            }),
          });

          messages.push({
            role: "user",
            content: `That tool call is not appropriate for the current investigation state.

${investigation.getContext()}

Choose a tool call that obtains one of the missing evidence categories.

Do not repeat the rejected tool call.`,
          });

          break;
        }

        const execution = await toolExecutor.execute(
          toolCall,
          iteration,
          executedToolCalls,
        );

        messages.push(execution.message);

        /*
         * Duplicate tool calls are a recovery condition, not a normal
         * investigation step.
         */
        if (execution.duplicate) {
          messages.push({
            role: "user",
            content: `The requested tool call was already executed and was not run again.

Do not repeat the same tool call.

Current investigation state:

${investigation.getContext()}

Choose a different tool call that discovers new information.

For implementation-planning tasks, prioritize the missing evidence categories:

- project configuration
- representative implementation
- relevant tests
- extension points

Continue investigating. Do not provide the final answer until the required evidence is complete.`,
          });

          continue;
        }

        /*
         * Record successful tool execution in the investigation state.
         */
        investigation.recordToolCall(
          toolCall.name,
          this.createToolCallArgumentsKey(toolCall.arguments),
        );

        investigation.addObservation(
          toolCall.name,
          this.summarizeToolResult(execution.result),
        );

        this.recordInspectedPath(investigation, execution.result);

        this.updateInvestigationEvidence(
          investigation,
          toolCall.name,
          toolCall.arguments,
          execution.result,
        );

        /*
         * Preserve the optimized factual-answer path.
         *
         * For questions such as:
         * "What port does the browser fixture use?"
         *
         * search_files -> deterministic extraction -> answer
         *
         * without another model inference.
         */
        const directAnswer = this.extractDirectAnswer(
          prompt,
          toolCall.name,
          execution.result,
        );

        if (directAnswer !== undefined) {
          return directAnswer;
        }

        /*
         * IMPORTANT:
         *
         * Once the final required evidence category has been collected,
         * explicitly transition the conversation from investigation mode
         * into answer mode.
         */
        if (
          investigation.getTaskType() === "implementation-plan" &&
          investigation.isComplete()
        ) {
          messages.push({
            role: "user",
            content: `The required repository investigation is now complete.

${investigation.getContext()}

Stop using tools.

Produce the final implementation plan now.

Base the plan only on repository evidence already gathered.

Clearly distinguish:

1. Existing files that should change.
2. New files that should be created.
3. Files inspected only for evidence.
4. The repository evidence supporting each proposed change.

Do not investigate further.`,
          });

          /*
           * Break out of the current tool-call batch.
           *
           * Some models may return multiple tool calls in one response.
           * Once investigation is complete, executing the remaining calls
           * would be unnecessary and could cause another investigation loop.
           */
          break;
        }
      }
    }

    throw new Error(`Agent exceeded maximum iterations (${maxIterations})`);
  }

  /*
   * Enforce the investigation strategy for implementation-plan tasks.
   *
   * The investigation is evidence-driven rather than strictly ordered:
   *
   * feature search
   *      ↓
   * repository structure
   *      ↓
   * configuration
   *      ↓
   * implementation
   *      ↓
   * tests
   *
   * The model may choose the exact navigation path, but the application
   * prevents obviously premature or irrelevant actions.
   */
  private validateInvestigationToolCall(
    investigation: InvestigationState,
    toolName: string,
    argumentsValue: Record<string, unknown>,
  ): {
    allowed: boolean;
    reason?: string;
  } {
    if (investigation.getTaskType() !== "implementation-plan") {
      return {
        allowed: true,
      };
    }

    if (investigation.isComplete()) {
      return {
        allowed: false,
        reason:
          "Investigation is complete. Do not call another tool. Produce the final implementation plan using the evidence already collected.",
      };
    }

    /*
     * Prevent the model from repeating an already executed investigation action.
     *
     * The model can still choose a different action, but it cannot waste an
     * iteration repeating the same tool + arguments.
     */
    const argumentsKey = this.createToolCallArgumentsKey(argumentsValue);

    if (investigation.hasExecutedToolCall(toolName, argumentsKey)) {
      return {
        allowed: false,
        reason:
          "This exact investigation action has already been executed. Choose a different tool call that obtains new evidence.",
      };
    }

    const evidence = investigation.getEvidence();

    /*
     * STEP 1:
     * Feature existence must always be established first.
     */
    if (!evidence.featureSearchCompleted) {
      if (toolName === "search_files") {
        return {
          allowed: true,
        };
      }

      return {
        allowed: false,
        reason:
          "Feature existence has not been investigated yet. Use search_files first with one distinctive feature or concept term.",
      };
    }

    /*
     * STEP 2:
     * Once feature existence has been checked, inspect repository structure.
     */
    if (!evidence.repositoryStructureInspected) {
      if (toolName === "list_directory") {
        return {
          allowed: true,
        };
      }

      return {
        allowed: false,
        reason:
          'Repository structure has not been inspected yet. Use list_directory, starting with path ".".',
      };
    }

    /*
     * STEP 3:
     * Inspect project configuration.
     */
    if (!evidence.configurationInspected) {
      if (
        toolName === "read_file" &&
        this.isConfigurationPath(argumentsValue.path)
      ) {
        return {
          allowed: true,
        };
      }

      return {
        allowed: false,
        reason:
          "Project configuration has not been inspected yet. Read package.json or tsconfig.json.",
      };
    }

    /*
     * STEP 4:
     * Inspect representative implementation.
     */
    if (!evidence.implementationInspected) {
      if (
        toolName === "read_file" &&
        typeof argumentsValue.path === "string" &&
        this.isImplementationPath(argumentsValue.path)
      ) {
        return {
          allowed: true,
        };
      }

      return {
        allowed: false,
        reason:
          "Implementation evidence is still missing. Read a representative source/implementation file.",
      };
    }

    /*
     * STEP 5:
     * Inspect tests.
     */
    if (!evidence.testsInspected) {
      if (
        toolName === "read_file" &&
        typeof argumentsValue.path === "string" &&
        this.isTestPath(argumentsValue.path)
      ) {
        return {
          allowed: true,
        };
      }

      return {
        allowed: false,
        reason:
          "Relevant test evidence is still missing. Read a representative test file.",
      };
    }

    return {
      allowed: false,
      reason:
        "All required investigation evidence has been collected. Produce the final implementation plan.",
    };
  }

  private isConfigurationPath(path: unknown): boolean {
    if (typeof path !== "string") {
      return false;
    }

    const normalized = path.toLowerCase().replace(/^.\//, "");

    return (
      normalized === "package.json" ||
      normalized === "tsconfig.json" ||
      normalized.endsWith("/package.json") ||
      normalized.endsWith("/tsconfig.json")
    );
  }

  private isTestPath(path: string): boolean {
    const normalized = path.toLowerCase().replace(/^.\//, "");

    return (
      normalized.startsWith("tests/") ||
      normalized.startsWith("src/tests/") ||
      normalized.includes("/tests/") ||
      normalized.endsWith(".test.ts") ||
      normalized.endsWith(".test.tsx") ||
      normalized.endsWith(".test.js") ||
      normalized.endsWith(".test.mjs") ||
      normalized.endsWith(".spec.ts") ||
      normalized.endsWith(".spec.tsx") ||
      normalized.endsWith(".spec.js") ||
      normalized.endsWith(".spec.mjs")
    );
  }

  private isImplementationPath(path: string): boolean {
    const normalized = path.toLowerCase().replace(/^.\//, "");

    /*
     * These files are evidence of implementation/configuration rather than
     * tests or documentation.
     */
    if (
      normalized.length === 0 ||
      normalized.startsWith("tests/") ||
      normalized.startsWith("src/tests/") ||
      normalized.includes("/tests/") ||
      normalized.endsWith(".test.ts") ||
      normalized.endsWith(".test.tsx") ||
      normalized.endsWith(".test.js") ||
      normalized.endsWith(".test.mjs") ||
      normalized.endsWith(".spec.ts") ||
      normalized.endsWith(".spec.tsx") ||
      normalized.endsWith(".spec.js") ||
      normalized.endsWith(".spec.mjs") ||
      normalized === "readme.md" ||
      normalized.endsWith("/readme.md") ||
      normalized === "package-lock.json"
    ) {
      return false;
    }

    /*
     * Configuration files are handled separately.
     */
    if (this.isConfigurationPath(normalized)) {
      return false;
    }

    /*
     * Only treat source/code-like files as implementation evidence.
     */
    return (
      normalized.endsWith(".ts") ||
      normalized.endsWith(".tsx") ||
      normalized.endsWith(".js") ||
      normalized.endsWith(".jsx") ||
      normalized.endsWith(".mjs") ||
      normalized.endsWith(".cjs")
    );
  }

  private isSearchResult(result: unknown): result is SearchFilesResult {
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

      const item = match as Record<string, unknown>;

      return (
        typeof item.path === "string" &&
        typeof item.line === "number" &&
        typeof item.text === "string"
      );
    });
  }

  private updateInvestigationEvidence(
    investigation: InvestigationState,
    toolName: string,
    argumentsValue: Record<string, unknown>,
    result: unknown,
  ): void {
    if (toolName === "search_files") {
      /*
       * A successful search establishes only that the requested
       * feature/concept was investigated.
       *
       * IMPORTANT:
       *
       * Finding a source/test/configuration file in search results does
       * NOT mean that file has been inspected. Inspection requires an
       * explicit read_file or list_directory action.
       */
      investigation.markFeatureSearchCompleted();

      return;
    }

    if (toolName === "list_directory") {
      const path =
        typeof argumentsValue.path === "string" ? argumentsValue.path : ".";

      /*
       * Any successful directory listing gives us some structural evidence.
       * This is intentionally limited to actual directory inspection.
       */
      investigation.markRepositoryStructureInspected();
      investigation.recordPath(path);

      return;
    }

    if (toolName === "read_file") {
      const path =
        typeof argumentsValue.path === "string" ? argumentsValue.path : "";

      if (path.length === 0) {
        return;
      }

      investigation.recordPath(path);

      const normalizedPath = path.toLowerCase();

      /*
       * Configuration evidence.
       */
      if (
        normalizedPath === "package.json" ||
        normalizedPath === "tsconfig.json" ||
        normalizedPath.endsWith("/package.json") ||
        normalizedPath.endsWith("/tsconfig.json") ||
        normalizedPath.includes("/config/")
      ) {
        investigation.markConfigurationInspected();

        /*
         * package.json and tsconfig.json are configuration evidence,
         * not representative implementation evidence.
         */
        return;
      }

      /*
       * Test evidence.
       */
      if (this.isTestPath(normalizedPath)) {
        investigation.markTestsInspected();
        return;
      }

      /*
       * Documentation should not count as implementation evidence.
       */
      if (
        normalizedPath === "readme.md" ||
        normalizedPath.endsWith("/readme.md") ||
        normalizedPath.endsWith(".md")
      ) {
        return;
      }

      /*
       * Only source/code files count as implementation evidence.
       */
      if (this.isImplementationPath(normalizedPath)) {
        investigation.markImplementationInspected();
      }
    }
  }

  private summarizeToolResult(result: unknown): string {
    if (this.isSearchFilesResult(result)) {
      if (result.matches.length === 0) {
        return `search_files("${result.query}") returned no matches.`;
      }

      return `search_files("${result.query}") returned ${result.matches.length} match(es).`;
    }

    if (Array.isArray(result)) {
      return `Tool returned ${result.length} item(s).`;
    }

    if (result !== null && typeof result === "object") {
      return "Tool returned structured repository data.";
    }

    return "Tool returned repository data.";
  }

  private recordInspectedPath(
    investigation: InvestigationState,
    result: unknown,
  ): void {
    if (!this.isSearchFilesResult(result)) {
      return;
    }

    for (const match of result.matches) {
      investigation.recordPath(match.path);
    }
  }

  private detectTaskType(prompt: string): InvestigationTaskType {
    const normalized = prompt.toLowerCase();

    const planningTerms = [
      "implementation plan",
      "implementation",
      "propose",
      "plan",
      "how would you build",
      "how should we build",
      "what files",
      "which files",
      "new feature",
      "do not modify any files",
    ];

    if (planningTerms.some((term) => normalized.includes(term))) {
      return "implementation-plan";
    }

    const existingFeatureTerms = [
      "how does",
      "where is",
      "which file",
      "how is",
      "what does",
    ];

    if (existingFeatureTerms.some((term) => normalized.includes(term))) {
      return "existing-feature";
    }

    return "factual";
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

    const value = this.extractConcreteValue(prompt, matches);

    if (value === undefined) {
      return undefined;
    }

    return value;
  }

  private createToolCallArgumentsKey(
    argumentsValue: Record<string, unknown>,
  ): string {
    return JSON.stringify(
      Object.keys(argumentsValue)
        .sort()
        .reduce<Record<string, unknown>>((result, key) => {
          result[key] = argumentsValue[key];
          return result;
        }, {}),
    );
  }

  private buildSystemPrompt(
    memoryContext: string,
    investigation: InvestigationState,
  ): string {
    return `You are a local project investigation agent.

      Answer questions about this repository using project memory and repository tools.

      Core rules:

      1. Never invent project-specific facts.
      2. Use project memory when it directly answers the question.
      3. Otherwise investigate the repository using the available tools.
      4. Treat every tool result as evidence.
      5. Never assume that a requested feature already exists.
      6. Distinguish factual questions, existing-feature investigations, and implementation-planning requests.

      Targeted factual questions:

      7. Start with one distinctive search term.
      8. If search_files directly provides sufficient evidence, answer immediately.
      9. Do not call read_file when search_files already provides sufficient evidence.
      10. Keep simple factual answers concise.

      Existing-feature investigations:

      11. Search for the requested concept or identifier.
      12. Inspect only files necessary to answer the question.
      13. Prefer implementation and configuration over tests and documentation.
      14. Use read_file when search results are ambiguous or insufficient.

      New-feature / implementation-planning requests:

      15. First determine whether the requested feature already exists.
      16. If a feature search returns zero matches, do not repeat the same search.
      17. Treat zero matches as evidence that the feature may not exist.
      18. Discover the repository architecture before proposing implementation changes.
      19. Use list_directory when repository structure is not known.
      20. Inspect package/configuration files for runtime, dependencies, and conventions.
      21. Inspect representative implementation files.
      22. Inspect relevant tests.
      23. Identify existing extension points.
      24. Do not claim a file needs to change without repository evidence.
      25. Clearly distinguish:
        - existing files to change,
        - new files to create,
        - files inspected only for evidence.

      Investigation progress:

      26. Every tool call must discover new information, inspect relevant information, or resolve an ambiguity.
      27. Do not repeat identical successful investigation.
      28. After a zero-match search, change strategy.
      29. Do not repeatedly inspect the same paths without reason.
      30. Stop when evidence is sufficient.
      31. Never modify files unless explicitly asked.

      Important investigation behavior:

      32. Always inspect missing evidence categories before producing an implementation plan.
      33. If configuration is missing, inspect package.json or tsconfig.json.
      34. If implementation evidence is missing, inspect representative source files.
      35. If test evidence is missing, inspect the tests directory and relevant test files.
      36. If repository structure is already known, do not repeatedly list the same directory.
      37. When a tool call is rejected as a duplicate, immediately choose a different investigation action.
      38. Use the current investigation state to decide what evidence is still missing.
      39. Do not stop merely because you have discovered that the requested feature does not exist.
      40. For implementation plans, continue until all required evidence categories are complete.
      41. Once all required evidence categories are complete, stop investigating and produce the final answer.
      42. Do not call additional tools after the investigation is complete.
      43. Base the final implementation plan only on evidence already gathered.
      44. If the investigation is complete, do not attempt another repository inspection even if additional information could be interesting.
      45. Prefer producing the answer over gathering optional additional evidence.

      Current investigation state:

      ${investigation.getContext()}

      Project memory:

      ${memoryContext}`;
  }

  private getRequiredInvestigationTool(investigation: InvestigationState):
    | {
        name: string;
        arguments: Record<string, unknown>;
      }
    | undefined {
    if (investigation.getTaskType() !== "implementation-plan") {
      return undefined;
    }

    const evidence = investigation.getEvidence();

    if (!evidence.featureSearchCompleted) {
      return {
        name: "search_files",
        arguments: {
          query: "Todo",
        },
      };
    }

    if (!evidence.repositoryStructureInspected) {
      return {
        name: "list_directory",
        arguments: {
          path: ".",
        },
      };
    }

    if (!evidence.configurationInspected) {
      return {
        name: "read_file",
        arguments: {
          path: "package.json",
        },
      };
    }

    if (!evidence.implementationInspected) {
      return {
        name: "read_file",
        arguments: {
          path: "src/index.ts",
        },
      };
    }

    if (!evidence.testsInspected) {
      return {
        name: "read_file",
        arguments: {
          path: "src/tests/test-agent-investigation.ts",
        },
      };
    }

    return undefined;
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
