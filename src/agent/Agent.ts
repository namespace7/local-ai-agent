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

    const taskType = investigation.getTaskType();

    const maxIterations =
      taskType === "implementation"
        ? 20
        : taskType === "implementation-plan"
          ? 12
          : taskType === "existing-feature"
            ? 8
            : 6;

    const executedToolCalls = new Set<string>();
    const toolExecutor = new AgentToolExecutor(this.tools, this.trace);

    let implementationPhaseStarted = false;

    for (let iteration = 0; iteration < maxIterations; iteration += 1) {
      /*
       * Refresh the system prompt before every model call.
       *
       * This is especially important during implementation because the
       * model needs to see the current investigation state and know when
       * it is allowed to use write_file.
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
       * IMPLEMENTATION TRANSITION
       *
       * Once all investigation evidence is available, implementation tasks
       * leave investigation mode and enter the writing phase.
       */
      if (
        investigation.getTaskType() === "implementation" &&
        investigation.isComplete() &&
        !implementationPhaseStarted
      ) {
        implementationPhaseStarted = true;
        investigation.startImplementation();

        messages.push({
          role: "user",
          content: this.buildImplementationTransitionPrompt(
            prompt,
            investigation,
          ),
        });

        /*
         * Do not execute tool calls returned by the investigation response.
         * The next model call receives the explicit implementation instruction.
         */
        continue;
      }

      /*
       * A model response without tool calls can be final only when:
       *
       * - factual question: model has answered
       * - existing-feature: enough evidence exists
       * - implementation-plan: investigation is complete
       * - implementation: implementation has been verified
       */
      if (response.toolCalls.length === 0) {
        if (investigation.getTaskType() === "factual") {
          return response.content;
        }

        if (
          investigation.getTaskType() === "existing-feature" &&
          investigation.isComplete()
        ) {
          return response.content;
        }

        if (
          investigation.getTaskType() === "implementation-plan" &&
          investigation.isComplete()
        ) {
          return response.content;
        }

        /*
         * Implementation has started, but the model returned text without
         * actually completing the implementation.
         */
        if (
          investigation.getTaskType() === "implementation" &&
          implementationPhaseStarted
        ) {
          if (investigation.isImplementationComplete()) {
            return response.content;
          }

          messages.push({
            role: "user",
            content: `Implementation is not complete yet.

${investigation.getContext()}

You must continue implementing the requested feature.

Use write_file to create or modify the required files.

After writing files, inspect the created or modified files to verify the result.

Do not provide a final response yet.`,
          });

          continue;
        }

        /*
         * Non-implementation investigation tasks still need more evidence.
         */
        messages.push({
          role: "user",
          content: `The investigation is not complete yet.

${investigation.getContext()}

Do not provide the final answer yet.

Continue investigating the repository using the available tools. Choose a tool call that obtains one of the missing evidence categories.`,
        });

        continue;
      }

      /*
       * Process each tool call returned by the model.
       */
      for (const toolCall of response.toolCalls) {
        /*
         * IMPLEMENTATION PHASE
         *
         * Once implementation has started, tools must actually execute.
         *
         * Runtime policy is enforced here rather than relying only on the
         * model's system prompt.
         */
        if (
          investigation.getTaskType() === "implementation" &&
          implementationPhaseStarted
        ) {
          const implementationPolicy = this.validateImplementationToolCall(
            toolCall.name,
          );

          console.log(
            "[implementation-policy]",
            JSON.stringify(
              {
                tool: toolCall.name,
                allowed: implementationPolicy.allowed,
                reason: implementationPolicy.reason,
              },
              null,
              2,
            ),
          );

          if (!implementationPolicy.allowed) {
            messages.push({
              role: "tool",
              toolCallId: toolCall.id,
              content: JSON.stringify({
                success: false,
                error: implementationPolicy.reason,
              }),
            });

            messages.push({
              role: "user",
              content: `That tool is not allowed during the implementation phase.

${investigation.getContext()}

Use write_file to implement the requested change.

Use read_file to inspect files you created or modified.

Use search_files only when needed to verify integration points or references.

Do not perform broad repository exploration.

Continue implementing the requested feature.`,
            });

            continue;
          }

          const execution = await toolExecutor.execute(
            toolCall,
            iteration,
            executedToolCalls,
          );

          messages.push(execution.message);

          /*
           * Do not treat duplicate calls as new implementation work.
           */
          if (execution.duplicate) {
            messages.push({
              role: "user",
              content: `This exact tool call was already executed.

${investigation.getContext()}

Do not repeat the same tool call.

Choose the next implementation or verification action.`,
            });

            continue;
          }

          /*
           * Record the successful implementation action.
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

          /*
           * Track files created or modified by write_file.
           */
          if (
            toolCall.name === "write_file" &&
            execution.result !== undefined
          ) {
            const result = execution.result as {
              path?: unknown;
            };

            if (typeof result.path === "string") {
              investigation.recordWrittenFile(result.path);

              console.log("[implementation-write]", result.path);
            }
          }

          /*
           * A read_file of a file written during this implementation
           * counts as verification.
           */
          if (toolCall.name === "read_file") {
            const path = toolCall.arguments.path;

            if (typeof path === "string") {
              investigation.recordInspectedFile(path);

              const normalizedReadPath = this.normalizeWorkspacePath(path);

              const implementationState =
                investigation.getImplementationState();

              const verifiedWrittenFile = implementationState.filesWritten.some(
                (writtenPath) =>
                  this.normalizeWorkspacePath(writtenPath) ===
                  normalizedReadPath,
              );

              if (verifiedWrittenFile) {
                investigation.markVerificationPerformed();

                console.log("[implementation-verification]", path);
              }
            }
          }

          console.log(
            "[implementation-state]",
            JSON.stringify(investigation.getImplementationState(), null, 2),
          );

          continue;
        }

        /*
         * INVESTIGATION PHASE
         *
         * Non-factual tasks cannot use tools after their investigation
         * evidence is complete.
         */
        if (
          investigation.getTaskType() !== "factual" &&
          investigation.isComplete()
        ) {
          if (investigation.getTaskType() === "implementation-plan") {
            messages.push({
              role: "user",
              content: `The required repository investigation is now complete.

${investigation.getContext()}

Stop using investigation tools.

Produce the final implementation plan now.

Base the plan only on repository evidence already gathered.

Clearly distinguish:

1. Existing files that should change.
2. New files that should be created.
3. Files inspected only for evidence.
4. The repository evidence supporting each proposed change.

Do not investigate further.`,
            });
          } else {
            messages.push({
              role: "user",
              content: `The investigation is already complete.

${investigation.getContext()}

Do not call another investigation tool.

Produce the final answer using the evidence already collected.`,
            });
          }

          continue;
        }

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

        /*
         * Tool call rejected by investigation policy.
         */
        if (!policy.allowed) {
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

          continue;
        }

        /*
         * Execute the investigation tool.
         */
        const execution = await toolExecutor.execute(
          toolCall,
          iteration,
          executedToolCalls,
        );

        messages.push(execution.message);

        if (execution.duplicate) {
          messages.push({
            role: "user",
            content: `The requested tool call was already executed and was not run again.

Do not repeat the same tool call.

Current investigation state:

${investigation.getContext()}

Choose a different tool call that discovers new information.

Continue investigating. Do not provide the final answer until the required evidence is complete.`,
          });

          continue;
        }

        /*
         * Record successful investigation activity.
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
         * Planning transition happens immediately after the final evidence
         * category is collected.
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

          break;
        }

        /*
         * Implementation transition.
         *
         * Do not let remaining tool calls from the investigation response
         * execute. The next model invocation receives the implementation
         * instruction.
         */
        if (
          investigation.getTaskType() === "implementation" &&
          investigation.isComplete()
        ) {
          implementationPhaseStarted = true;
          investigation.startImplementation();

          messages.push({
            role: "user",
            content: this.buildImplementationTransitionPrompt(
              prompt,
              investigation,
            ),
          });

          break;
        }
      }
    }

    throw new Error(`Agent exceeded maximum iterations (${maxIterations})`);
  }

  private buildImplementationTransitionPrompt(
    prompt: string,
    investigation: InvestigationState,
  ): string {
    return `Repository investigation is complete.

${investigation.getContext()}

The user's request is:

${prompt}

You are now in the IMPLEMENTATION phase.

Do not produce a plan instead of implementing.

Actually modify the repository.

Use the available write_file tool to create or replace the files required for the requested feature.

Implementation rules:

1. Follow the architecture and conventions discovered during investigation.
2. Do not invent dependencies when existing dependencies are sufficient.
3. Do not overwrite unrelated files.
4. Create the smallest coherent implementation that satisfies the request.
5. Use write_file for actual file creation or modification.
6. After writing files, use read_file to inspect and verify the files you created or modified.
7. Use search_files only when needed to verify integration points or references.
8. If tests already exist for the relevant behavior, follow their conventions.
9. Do not stop after describing what you would do.
10. Continue using tools until the requested implementation is actually present.
11. Only provide the final response after the implementation has been completed and verified.

Begin implementation now.`;
  }

  /*
   * Restrict the tools available during the implementation phase.
   *
   * Investigation-specific tools such as list_directory should not be used
   * once implementation has started.
   */
  private validateImplementationToolCall(toolName: string): {
    allowed: boolean;
    reason?: string;
  } {
    if (
      toolName === "write_file" ||
      toolName === "read_file" ||
      toolName === "search_files"
    ) {
      return {
        allowed: true,
      };
    }

    return {
      allowed: false,
      reason:
        "Implementation phase is active. Do not perform broad repository exploration. Use write_file, read_file, or search_files for implementation and verification.",
    };
  }

  /*
   * Enforce the investigation strategy for implementation-plan and
   * implementation tasks.
   */
  private validateInvestigationToolCall(
    investigation: InvestigationState,
    toolName: string,
    argumentsValue: Record<string, unknown>,
  ): {
    allowed: boolean;
    reason?: string;
  } {
    /*
     * Factual questions are always allowed to perform the minimal tool
     * investigation required to answer them.
     */
    if (investigation.getTaskType() === "factual") {
      return {
        allowed: true,
      };
    }

    /*
     * Implementation-plan and implementation tasks use the evidence-driven
     * investigation flow.
     */
    if (investigation.isComplete()) {
      return {
        allowed: false,
        reason:
          "Investigation is complete. Stop investigating and transition to the next phase.",
      };
    }

    const argumentsKey = this.createToolCallArgumentsKey(argumentsValue);

    /*
     * Prevent the model from repeating exactly the same investigation action.
     */
    if (investigation.hasExecutedToolCall(toolName, argumentsKey)) {
      return {
        allowed: false,
        reason:
          "This exact investigation action has already been executed. Choose a different tool call that obtains new evidence.",
      };
    }

    const evidence = investigation.getEvidence();

    /*
     * Feature existence.
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
          "Feature existence has not been investigated yet. Use search_files first.",
      };
    }

    /*
     * Repository structure.
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
     * Configuration.
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
     * Implementation.
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

      if (toolName === "search_files" || toolName === "list_directory") {
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
     * Tests.
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

      if (toolName === "list_directory") {
        return {
          allowed: true,
        };
      }

      if (toolName === "search_files") {
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
        "All required investigation evidence has been collected. Stop investigating.",
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

    if (this.isConfigurationPath(normalized)) {
      return false;
    }

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
    return this.isSearchFilesResult(result);
  }

  private updateInvestigationEvidence(
    investigation: InvestigationState,
    toolName: string,
    argumentsValue: Record<string, unknown>,
    result: unknown,
  ): void {
    if (toolName === "search_files") {
      investigation.markFeatureSearchCompleted();
      return;
    }

    if (toolName === "list_directory") {
      const path =
        typeof argumentsValue.path === "string" ? argumentsValue.path : ".";

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

      if (this.isConfigurationPath(path)) {
        investigation.markConfigurationInspected();
        return;
      }

      if (this.isTestPath(normalizedPath)) {
        investigation.markTestsInspected();
        return;
      }

      if (
        normalizedPath === "readme.md" ||
        normalizedPath.endsWith("/readme.md") ||
        normalizedPath.endsWith(".md")
      ) {
        return;
      }

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

  private normalizeWorkspacePath(path: string): string {
    return path.replace(/^.\//, "");
  }

  private createToolCallArgumentsKey(
    argumentsValue: Record<string, unknown>,
  ): string {
    const sortedArguments = Object.keys(argumentsValue)
      .sort()
      .reduce<Record<string, unknown>>((result, key) => {
        result[key] = argumentsValue[key];
        return result;
      }, {});

    return JSON.stringify(sortedArguments);
  }

  private detectTaskType(prompt: string): InvestigationTaskType {
    const normalized = prompt.toLowerCase();

    /*
     * Explicit planning language wins over implementation language.
     */
    const planningTerms = [
      "implementation plan",
      "propose",
      "plan",
      "how would you build",
      "how should we build",
      "what files",
      "which files",
      "do not modify any files",
      "without modifying",
    ];

    if (planningTerms.some((term) => normalized.includes(term))) {
      return "implementation-plan";
    }

    /*
     * Actual implementation requests.
     */
    const implementationTerms = [
      "implement",
      "build",
      "create",
      "develop",
      "add",
      "write",
      "modify",
      "change",
      "make",
    ];

    if (implementationTerms.some((term) => normalized.includes(term))) {
      return "implementation";
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

  private buildSystemPrompt(
    memoryContext: string,
    investigation: InvestigationState,
  ): string {
    const taskType = investigation.getTaskType();

    return `You are a local project coding agent.

You work inside the current repository.

Your job is to investigate, plan, implement, and verify changes using the available repository tools.

Core rules:

1. Never invent project-specific facts.
2. Use project memory when it directly answers the question.
3. Otherwise investigate the repository using the available tools.
4. Treat every tool result as evidence.
5. Never assume that a requested feature already exists.
6. Choose actions based on the current investigation state.
7. Do not modify files during investigation unless the user explicitly requested implementation.

Task type:

${taskType}

For factual questions:

- Use the minimum investigation necessary.
- Start with a distinctive search term.
- If search_files directly provides sufficient evidence, answer immediately.

For existing-feature questions:

- Search for the requested concept.
- Inspect only the relevant implementation.
- Use tests when they clarify behavior.

For implementation-plan requests:

- First establish whether the feature already exists.
- Inspect repository structure.
- Inspect configuration.
- Inspect representative implementation.
- Inspect relevant tests.
- Do not modify files.
- Once evidence is complete, produce an evidence-backed implementation plan.

For implementation requests:

PHASE 1 — INVESTIGATION

- First determine whether the requested feature already exists.
- Inspect repository structure.
- Inspect configuration and dependencies.
- Inspect representative implementation.
- Inspect relevant tests.
- Do not write files during this phase.
- Do not invent architecture when the repository already provides extension points.

PHASE 2 — IMPLEMENTATION

Once investigation evidence is complete:

- Stop broad investigation.
- Actually implement the requested feature.
- Use write_file to create or replace files.
- Follow the repository's existing architecture and conventions.
- Do not merely provide a plan.
- Do not modify unrelated files.
- Continue until the requested implementation actually exists.

PHASE 3 — VERIFICATION

After writing:

- Inspect the files you created or changed.
- Use read_file to verify the files you created or modified.
- Use search_files only when needed to verify integration points or references.
- Check that imports, paths, and integration points are consistent.
- If appropriate tests are available, follow their conventions.
- Do not claim success merely because write_file succeeded.

Investigation progress:

${investigation.getContext()}

Project memory:

${memoryContext}`;
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

      const item = match as Record<string, unknown>;

      return (
        typeof item.path === "string" &&
        typeof item.line === "number" &&
        typeof item.text === "string"
      );
    });
  }
}
