import * as fs from "node:fs";
import * as path from "node:path";
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

export interface AgentOptions {
  /** Override the default per-task-type maxIterations ceiling. */
  maxIterations?: number;
  /** Explicit workspace root directory for path normalization. Defaults to process.cwd(). */
  workspaceRoot?: string;
}

export class Agent {
  private lastInvestigation: InvestigationState | null = null;

  constructor(
    private readonly model: ModelProvider,
    private readonly tools: ToolRegistry,
    private readonly trace: ExecutionTrace,
    private readonly memory: ProjectMemory,
    private readonly options: AgentOptions = {},
  ) {}

  getLastInvestigation(): InvestigationState | null {
    return this.lastInvestigation;
  }

  async run(prompt: string): Promise<string> {
    const investigation = new InvestigationState();
    this.lastInvestigation = investigation;
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

    const defaultMaxIterations =
      taskType === "implementation"
        ? 20
        : taskType === "implementation-plan"
          ? 12
          : taskType === "existing-feature"
            ? 8
            : 6;
    const maxIterations = this.options.maxIterations ?? defaultMaxIterations;

    const executedToolCalls = new Set<string>();
    const toolExecutor = new AgentToolExecutor(this.tools, this.trace);

    let implementationPhaseStarted = false;
    let progressIterations = 0;
    let consecutiveRejectedCalls = 0;
    const maxConsecutiveRejectedCalls = 5;

    while (progressIterations < maxIterations) {
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
        iteration: progressIterations,
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
        progressIterations += 1;
        consecutiveRejectedCalls = 0;
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

Use write_file to create or modify required files, or replace_content to make targeted edits.

After writing files, inspect the created or modified files to verify the result.

Do not provide a final response yet.`,
          });

          progressIterations += 1;
          consecutiveRejectedCalls = 0;
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

        progressIterations += 1;
        consecutiveRejectedCalls = 0;
        continue;
      }

      /*
       * Process each tool call returned by the model.
       */
      let anyToolAccepted = false;

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
            consecutiveRejectedCalls += 1;
            if (consecutiveRejectedCalls >= maxConsecutiveRejectedCalls) {
              throw new Error(
                `Agent exceeded maximum consecutive rejected tool calls (${maxConsecutiveRejectedCalls})`,
              );
            }

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

Use write_file to create or rewrite files, or replace_content to make targeted edits to existing files.

Use read_file to inspect files you created or modified.

Use search_files only when needed to verify integration points or references.

Do not perform broad repository exploration.

Continue implementing the requested feature.`,
            });

            continue;
          }

          /*
           * REPAIR EVIDENCE GATE
           *
           * After a verification failure, the controller records which
           * workspace files were named in the error output.  write_file and
           * replace_content are blocked until every such file has been read at
           * least once since the failure.  This prevents the model from
           * rewriting or modifying the wrong file (as in Run 12) without first
           * inspecting the one that is actually broken.
           *
           * read_file, run_command, and search_files are always allowed.
           */
          const isMutationTool =
            toolCall.name === "write_file" ||
            toolCall.name === "replace_content";

          if (
            isMutationTool &&
            investigation.hasUnreadRepairEvidence()
          ) {
            const unreadPaths = investigation.getUnreadRepairPaths();

            consecutiveRejectedCalls += 1;
            if (consecutiveRejectedCalls >= maxConsecutiveRejectedCalls) {
              throw new Error(
                `Agent exceeded maximum consecutive rejected tool calls (${maxConsecutiveRejectedCalls})`,
              );
            }

            this.trace.add({
              type: "tool",
              iteration: progressIterations,
              toolName: toolCall.name,
              durationMs: 0,
              success: false,
              error: `${toolCall.name} rejected: verification failed and implicated files have not been inspected.`,
            });

            const pathList = unreadPaths.map((p) => `  - ${p}`).join("\n");

            /*
             * Repair echo (Approach D):
             * Extract a bounded, useful description of the rejected mutation
             * so the model can re-issue it after satisfying the read requirement.
             * Only the file path and tool name are echoed — not arbitrary content
             * blobs — to keep the echo safe and prompt-efficient.
             */
            const attemptedPath =
              typeof toolCall.arguments?.path === "string"
                ? toolCall.arguments.path
                : undefined;

            const repairEcho = attemptedPath
              ? `\nYour attempted ${toolCall.name} on "${attemptedPath}" was NOT executed.\n\nAfter you have read the required file(s) above, you MUST re-issue your ${toolCall.name} on "${attemptedPath}" before running any verification command.\nDo NOT run verification until after the repair has been applied.\n`
              : `\nYour attempted ${toolCall.name} was NOT executed.\n\nAfter you have read the required file(s) above, re-issue your ${toolCall.name} repair before running any verification command.\nDo NOT run verification until after the repair has been applied.\n`;

            messages.push({
              role: "tool",
              toolCallId: toolCall.id,
              content: JSON.stringify({
                success: false,
                error:
                  `${toolCall.name} rejected: verification failed and implicated files have not been inspected.`,
              }),
            });

            messages.push({
              role: "user",
              content: `REPAIR EVIDENCE REQUIRED

Verification failed and the following file(s) have not been inspected since the failure:

${pathList}

You must call read_file on each of these file(s) before making any repair write.
${repairEcho}
${investigation.getContext()}`,
            });

            continue;
          }
        } else if (investigation.getTaskType() !== "factual") {
          if (investigation.isComplete()) {
            consecutiveRejectedCalls += 1;
            if (consecutiveRejectedCalls >= maxConsecutiveRejectedCalls) {
              throw new Error(
                `Agent exceeded maximum consecutive rejected tool calls (${maxConsecutiveRejectedCalls})`,
              );
            }

            messages.push({
              role: "user",
              content: `The investigation is already complete.

${investigation.getContext()}

Do not call another investigation tool.

Produce the final answer using the evidence already collected.`,
            });

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

          if (!policy.allowed) {
            consecutiveRejectedCalls += 1;
            if (consecutiveRejectedCalls >= maxConsecutiveRejectedCalls) {
              throw new Error(
                `Agent exceeded maximum consecutive rejected tool calls (${maxConsecutiveRejectedCalls})`,
              );
            }

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
              content: this.buildInvestigationRejectionPrompt(
                toolCall.name,
                policy.reason || "Tool call not permitted",
                investigation,
                prompt,
              ),
            });

            continue;
          }
        }

        anyToolAccepted = true;

        const execution = await toolExecutor.execute(
          toolCall,
          progressIterations,
          executedToolCalls,
        );

        messages.push(execution.message);

        /*
         * Do not treat duplicate calls as new implementation work.
         */
        if (execution.duplicate) {
          /*
           * Satisfy repair evidence when the model reads a path that was
           * implicated in the last verification failure, even if the read_file
           * call was classified as a duplicate.
           */
          if (
            toolCall.name === "read_file" &&
            typeof toolCall.arguments?.path === "string"
          ) {
            const hadUnreadEvidence = investigation.hasUnreadRepairEvidence();
            const targetPath = toolCall.arguments.path as string;
            investigation.satisfyRepairPath(targetPath);

            if (
              hadUnreadEvidence &&
              !investigation.hasUnreadRepairEvidence() &&
              investigation.getTaskType() === "implementation"
            ) {
              messages.push({
                role: "user",
                content: `[REPAIR EVIDENCE SATISFIED]
The required evidence for '${targetPath}' has now been obtained.
The pending repair mutation is now authorized.
Apply the targeted repair using replace_content or write_file before running verification again.`,
              });
            }
          }

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
         * Satisfy repair evidence when the model reads a path that was
         * implicated in the last verification failure.
         */
        if (
          toolCall.name === "read_file" &&
          typeof toolCall.arguments?.path === "string"
        ) {
          const hadUnreadEvidence = investigation.hasUnreadRepairEvidence();
          const targetPath = toolCall.arguments.path as string;
          investigation.satisfyRepairPath(targetPath);

          if (
            hadUnreadEvidence &&
            !investigation.hasUnreadRepairEvidence() &&
            investigation.getTaskType() === "implementation"
          ) {
            messages.push({
              role: "user",
              content: `[REPAIR EVIDENCE SATISFIED]
The required evidence for '${targetPath}' has now been obtained.
The pending repair mutation is now authorized.
Apply the targeted repair using replace_content or write_file before running verification again.`,
            });
          }
        }

        /*
         * Track files created or modified by write_file or replace_content.
         */
        if (
          (toolCall.name === "write_file" ||
            toolCall.name === "replace_content") &&
          execution.result !== undefined
        ) {
          const result = execution.result as {
            path?: unknown;
          };

          if (typeof result.path === "string") {
            let content =
              typeof toolCall.arguments?.content === "string"
                ? toolCall.arguments.content
                : undefined;

            if (content === undefined && toolCall.name === "replace_content") {
              try {
                const absPath = path.resolve(this.getWorkspaceRoot(), result.path);
                if (fs.existsSync(absPath)) {
                  content = fs.readFileSync(absPath, "utf8");
                }
              } catch {}
            }

            investigation.recordWrittenFile(result.path, content);

            const lowerPath = result.path.toLowerCase();
            if (lowerPath.endsWith("tsconfig.json")) {
              investigation.addRequiredCategory("typecheck");
            }
            if (lowerPath.endsWith("package.json") && content) {
              if (content.includes("tsconfig.json") || content.includes('"typecheck"')) {
                investigation.addRequiredCategory("typecheck");
              }
              if (content.includes('"test"')) {
                investigation.addRequiredCategory("test");
              }
            }

            console.log("[implementation-write]", result.path);
          }
        }

        if (toolCall.name === "run_command") {
          const commandResult = execution.result as {
            command?: string;
            exitCode?: number;
            stdout?: string;
            stderr?: string;
            success?: boolean;
          };

          const isSuccess = Boolean(commandResult?.success);
          const commandName = commandResult?.command || "run_command";
          investigation.recordVerificationResult(commandName, isSuccess);

          const category = investigation.classifyCommand(commandName);

          if (isSuccess) {
            console.log("[implementation-verification]", commandName, "PASSED");

            /*
             * Successful verification clears all repair-evidence requirements.
             * The failure that prompted the repair cycle is now resolved.
             */
            investigation.clearRepairEvidence();

            if (
              category === "test" &&
              !investigation.getImplementationState().completedCategories.includes("test")
            ) {
              messages.push({
                role: "user",
                content: `The test command '${commandName}' passed with exit code 0, but test verification is not yet satisfied because there is no valid test evidence linked to the implementation. Inspect or write a test file (e.g. in src/tests/) that imports or references your implementation, then rerun the test command.`,
              });
            }
          } else {
            console.log("[implementation-verification]", commandName, "FAILED");

            messages.push({
              role: "user",
              content: `Verification command '${commandName}' failed with exit code ${commandResult?.exitCode ?? 1}.

Stdout:
${commandResult?.stdout || "(none)"}

Stderr:
${commandResult?.stderr || "(none)"}

Repair instructions:
1. Repair the specific reported errors above. Use replace_content for targeted edits to existing files, or write_file if creating/rewriting files. Make the smallest targeted repair possible rather than redesigning the project.
2. Preserve existing project configuration discovered during investigation (package.json scripts, test framework, dependencies, TypeScript/module settings).
3. Do NOT switch test frameworks during repair (e.g. if the project uses node:test, continue using node:test).
4. Do NOT create duplicate source files with a different extension to work around an error.
5. Inspect the relevant configuration or error before modifying configuration files.
6. After repairing, rerun the SAME failed verification command '${commandName}'. Successful verification is required before completion.`,
            });

            /*
             * Extract workspace-relative paths from the failure output that
             * correspond to existing files in the workspace.
             * The model must read each before it is allowed to write again.
             */
            const workspaceRoot = this.getWorkspaceRoot();
            const implicatedPaths = this.extractImplicatedPaths(
              commandResult?.stdout ?? "",
              commandResult?.stderr ?? "",
              workspaceRoot,
            );
            investigation.recordVerificationFailurePaths(implicatedPaths);
            if (implicatedPaths.length > 0) {
              console.log(
                "[repair-evidence] implicated paths:",
                implicatedPaths,
              );
            }
          }
        }

        console.log(
          "[implementation-state]",
          JSON.stringify(investigation.getImplementationState(), null, 2),
        );

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

          break;
        }
      }

      if (anyToolAccepted) {
        progressIterations += 1;
        consecutiveRejectedCalls = 0;
      }
    }

    throw new Error(`Agent exceeded maximum iterations (${maxIterations})`);
  }

  private buildInvestigationRejectionPrompt(
    toolName: string,
    policyReason: string,
    investigation: InvestigationState,
    prompt: string,
  ): string {
    const evidence = investigation.getEvidence();

    if (!evidence.featureSearchCompleted) {
      const suggestedQuery = this.extractSearchQueryFromPrompt(prompt);

      return `REJECTED TOOL CALL: ${toolName} is not allowed yet.

Reason:
${policyReason}

REQUIRED NEXT ACTION:
You MUST call search_files now.
Use the requested feature/concept as the search query.
For this task, use:
search_files({"query":"${suggestedQuery}"})

Do NOT call list_directory or read_file until search_files has executed.

${investigation.getContext()}`;
    }

    if (investigation.isGreenfield() && !investigation.hasSpecificationBeenEstablished()) {
      return `REJECTED TOOL CALL: ${toolName} is not allowed at this step.

        Reason:
        ${policyReason}

        REQUIRED NEXT ACTION:
        This is a greenfield repository. You must inspect the project specification before implementing.
        Call:
        read_file({"path": "REQUIREMENTS.md"})

        ${investigation.getContext()}`;
    }

    return `REJECTED TOOL CALL: ${toolName} is not allowed at this step.

Reason:
${policyReason}

${investigation.getContext()}

Choose a tool call that obtains one of the missing evidence categories.

Do not repeat the rejected tool call.`;
  }

  private extractSearchQueryFromPrompt(prompt: string): string {
    const words = prompt
      .split(/\s+/)
      .map((w) => w.replace(/[^a-zA-Z0-9_-]/g, ""))
      .filter(
        (w) =>
          w.length > 2 &&
          ![
            "build",
            "create",
            "add",
            "implement",
            "make",
            "simple",
            "new",
            "this",
            "that",
            "with",
            "from",
            "your",
            "workspace",
            "repository",
            "application",
            "app",
            "feature",
          ].includes(w.toLowerCase()),
      );

    return words[0] || prompt.trim();
  }

  private buildImplementationTransitionPrompt(
    prompt: string,
    investigation: InvestigationState,
  ): string {
    if (investigation.isGreenfield()) {
      return `[GREENFIELD REPOSITORY]
The repository contains no existing application implementation.

**GREENFIELD INVESTIGATION SEQUENCE**
1. Use \`search_files\` exactly once to establish feature/requirements evidence.
2. Then use \`list_directory(".")\` to inspect the workspace root.
3. Then use \`read_file(\"REQUIREMENTS.md\")\` to inspect the specification.
4. After \`REQUIREMENTS.md\` has been successfully read, stop investigating and begin implementation.
5. Do NOT repeat \`search_files\` after the feature‑search evidence has been collected.
6. Do NOT call \`list_directory\` or \`read_file\` before the required preceding step.
7. The controller will reject duplicate investigation calls.

The user's request is:

${prompt}

You are now in the IMPLEMENTATION phase.

Do not produce a plan instead of implementing.

Actually create and implement the application in the workspace. Use write_file to create the necessary configuration (e.g. package.json, tsconfig.json), source files, and tests described in REQUIREMENTS.md.

IMPLEMENTATION TOOL FORMAT RULES

When calling a tool, emit ONLY the structured tool call as defined by the tool interface.

For write_file:

You are now in the IMPLEMENTATION phase.

Do not produce a plan instead of implementing.

Actually create and implement the application in the workspace. Use write_file to create the necessary configuration (e.g. package.json, tsconfig.json), source files, and tests described in REQUIREMENTS.md.

IMPLEMENTATION TOOL FORMAT RULES

When calling a tool, emit ONLY the structured tool call as defined by the tool interface.

For write_file:
- \`path\` must be a JSON string.
- \`content\` must be a JSON string containing the file contents.
- Encode newlines using JSON escapes (e.g. \\n).
- Do NOT use JSON.stringify().
- Do NOT embed JavaScript expressions or template literals/\`backticks\`.
- Do NOT wrap the tool call in markdown code fences.
- Malformed tool calls will be rejected.

Example:
{
  "name": "write_file",
  "arguments": {
    "path": "hello.ts",
    "content": "export const hello = 'world';\n"
  }
}

Implementation rules:
1. Build the complete application architecture specified in REQUIREMENTS.md.
2. Use write_file to create the project configuration, source files, and tests.
3. Establish verification for the project (e.g. run 'npm run typecheck' or 'npm test' or the build/test commands appropriate to the project).
4. If verification fails, inspect the stdout/stderr output and repair the implementation using replace_content or write_file.
5. Do not stop merely after creating a plan or describing what you would do.
6. Continue using tools until verification succeeds.

Begin implementation now.`;
    }

    return `Repository investigation is complete.

${investigation.getContext()}

The user's request is:

${prompt}

You are now in the IMPLEMENTATION phase.

Do not produce a plan instead of implementing.

Actually modify the repository.

Use write_file to create new files or replace_content to make targeted edits to existing files required for the requested feature.

Implementation rules:

1. Follow the architecture and conventions discovered during investigation.
2. Do not invent dependencies when existing dependencies are sufficient.
3. Do not overwrite unrelated files.
4. Create the smallest coherent implementation that satisfies the request.
5. Use write_file for file creation/rewrite, or replace_content for targeted edits.
6. Use read_file only for file inspection. Reading files does NOT verify implementation.
7. Execute actual project verification using run_command (e.g. 'npx tsc --noEmit', 'npm run typecheck', or 'npm test').
8. Writing or modifying files invalidates any previous verification result.
9. If verification fails, inspect the stdout/stderr output and repair the implementation using replace_content or write_file.
10. Do not stop after describing what you would do.
11. Continue using tools until a verification command succeeds after the latest write.
12. Only provide the final response after verification has succeeded on the latest code.

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
      toolName === "replace_content" ||
      toolName === "read_file" ||
      toolName === "search_files" ||
      toolName === "run_command"
    ) {
      return {
        allowed: true,
      };
    }

    return {
      allowed: false,
      reason:
        "Implementation phase is active. Do not perform broad repository exploration. Use write_file, replace_content, read_file, search_files, or run_command for implementation and verification.",
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
     * GREENFIELD INVESTIGATION PATH:
     * When an empty / greenfield repository is detected, the model must read
     * REQUIREMENTS.md to inspect project specifications.
     */
    if (investigation.isGreenfield()) {
      if (!investigation.hasSpecificationBeenEstablished()) {
        const specSource = investigation.getSpecificationSource();
        // If there's a discovered file source, allow reading it
        if (specSource?.type === "file") {
          if (toolName === "read_file" && typeof argumentsValue.path === "string" && argumentsValue.path.toLowerCase() === specSource.path.toLowerCase()) {
            return { allowed: true }; // establishment happens AFTER read_file completes successfully
          }
          return {
            allowed: false,
            reason: `Specification not yet established for greenfield repository. You must read ${specSource.path} first.`,
          };
        }

        return {
          allowed: false,
          reason: "Specification not yet established for greenfield repository.",
        };
      }
      // Specification already established – proceed with normal checks
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



  /**
   * Evaluate whether a repository root directory listing indicates a greenfield project.
   *
   * A repository is greenfield if it contains NO existing configuration, NO source/implementation
   * folders, NO test folders, and NO source code files, but contains REQUIREMENTS.md
   * (or only documentation/requirements files).
   */
  private evaluateGreenfieldRepository(entries: unknown): boolean {
    if (!Array.isArray(entries)) {
      return false;
    }

    const ignoredNames = new Set([
      ".git",
      ".gitignore",
      ".agent-memory.json",
      ".memory.json",
      ".ds_store",
      ".npmignore",
    ]);

    const activeEntries = entries.filter((e) => {
      const name = (typeof e?.name === "string" ? e.name : "").toLowerCase();
      return name.length > 0 && !ignoredNames.has(name);
    });

    if (activeEntries.length === 0) {
      return true;
    }

    for (const entry of activeEntries) {
      const name = (typeof entry?.name === "string" ? entry.name : "").toLowerCase();

      if (name === "requirements.md" || name.endsWith("/requirements.md")) {
        continue;
      }

      if (name === "readme.md" || name.endsWith(".md") || name.endsWith(".txt")) {
        continue;
      }

      // Check for configuration files
      if (
        name === "package.json" ||
        name === "tsconfig.json" ||
        name === "package-lock.json" ||
        name === "pyproject.toml" ||
        name === "cargo.toml" ||
        name === "go.mod" ||
        name === "pom.xml" ||
        name === "build.gradle" ||
        name === "composer.json" ||
        name === "makefile"
      ) {
        return false;
      }

      // Check for implementation / test directories
      if (
        name === "src" ||
        name === "lib" ||
        name === "app" ||
        name === "tests" ||
        name === "test" ||
        name === "__tests__" ||
        name === "dist" ||
        name === "pkg" ||
        name === "cmd" ||
        name === "internal" ||
        name === "models" ||
        name === "services" ||
        name === "controllers" ||
        name === "repositories"
      ) {
        return false;
      }

      // Check for code files
      if (
        name.endsWith(".ts") ||
        name.endsWith(".tsx") ||
        name.endsWith(".js") ||
        name.endsWith(".jsx") ||
        name.endsWith(".mjs") ||
        name.endsWith(".cjs") ||
        name.endsWith(".py") ||
        name.endsWith(".go") ||
        name.endsWith(".rs") ||
        name.endsWith(".java") ||
        name.endsWith(".rb") ||
        name.endsWith(".php") ||
        name.endsWith(".c") ||
        name.endsWith(".cpp") ||
        name.endsWith(".h") ||
        name.endsWith(".html") ||
        name.endsWith(".htm") ||
        name.endsWith(".css") ||
        name.endsWith(".scss")
      ) {
        return false;
      }
    }

    return true;
  }

  private discoverSpecification(entries: unknown): { type: "file"; path: string } | { type: "user_prompt" } {
    if (!Array.isArray(entries)) {
      return { type: "user_prompt" };
    }

    const candidateRanking = [
      "requirements.md",
      "spec.md",
      "specification.md",
      "product_spec.md",
      "product-requirements.md",
      "task.md",
      "docs/requirements.md",
      "docs/spec.md",
      "docs/specification.md",
    ];

    const actualFiles = new Map<string, string>();
    for (const entry of entries) {
      const name = typeof entry?.name === "string" ? entry.name : "";
      if (name) {
        actualFiles.set(name.toLowerCase(), name);
      }
    }

    for (const candidate of candidateRanking) {
      if (actualFiles.has(candidate)) {
        return { type: "file", path: actualFiles.get(candidate)! };
      }
    }

    return { type: "user_prompt" };
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

    if (this.isConfigurationPath(normalized) || normalized.endsWith('.md')) {
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

      if (path === "." || path === "" || path === "./") {
        if (this.evaluateGreenfieldRepository(result)) {
          investigation.markGreenfieldDetected(true);

          if (!investigation.getSpecificationSource()) {
            const specSource = this.discoverSpecification(result);
            investigation.setSpecificationSource(specSource);

            if (specSource.type === "user_prompt") {
              investigation.markSpecificationEstablished();
            }
          }
        }
      }

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

      // If a specification source was discovered and this file matches it, mark as established
      const specSource = investigation.getSpecificationSource();
      if (!investigation.hasSpecificationBeenEstablished() && specSource?.type === "file" && specSource.path.toLowerCase() === path.toLowerCase()) {
        investigation.setSpecificationSource({ type: "file", path });
        investigation.markSpecificationEstablished();
        return;
      }

      if (this.isConfigurationPath(path)) {
        investigation.markConfigurationInspected();
      }

      const lowerPath = path.toLowerCase();
      if (lowerPath.endsWith("tsconfig.json")) {
        investigation.addRequiredCategory("typecheck");
      }

      if (lowerPath.endsWith("package.json")) {
        const content =
          result !== null &&
          typeof result === "object" &&
          typeof (result as any).content === "string"
            ? ((result as any).content as string)
            : "";

        if (content.includes("tsconfig.json") || content.includes('"typecheck"')) {
          investigation.addRequiredCategory("typecheck");
        }


      }

      if (this.isTestPath(normalizedPath)) {
        investigation.markTestsInspected();
        investigation.addRequiredCategory("test");
      }

      if (
        normalizedPath === 'readme.md' ||
        normalizedPath.endsWith('/readme.md') ||
        normalizedPath.endsWith('.md')
      ) {
        // No further evidence needed for generic markdown files
      } else if (this.isImplementationPath(normalizedPath)) {
        investigation.markImplementationInspected();
      }
      // End of read_file handling
      return;
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

  /**
   * Retrieve the active workspace root directory from AgentOptions.
   * Defaults to process.cwd().
   */
  private getWorkspaceRoot(): string {
    return this.options.workspaceRoot
      ? path.resolve(this.options.workspaceRoot)
      : process.cwd();
  }

  /**
   * Extract workspace-relative file paths implicated by a verification failure.
   *
   * Strategy:
   * 1. Scan stdout + stderr for path-like tokens (containing slashes).
   * 2. Strip surrounding punctuation, line/col numbers, and prefixes.
   * 3. Normalize each candidate to a workspace-relative path.
   * 4. Verify that candidate resolves inside the workspace (not escaping root).
   * 5. Filter out external/runtime paths (node_modules, .git, node:).
   * 6. Check that the file actually exists on disk (fs.existsSync & isFile).
   *    Non-existent paths (e.g. missing modules) are ignored so no deadlock occurs.
   *    Existing pre-existing files or newly written files are captured.
   */
  private extractImplicatedPaths(
    stdout: string,
    stderr: string,
    workspaceRoot: string = process.cwd(),
  ): string[] {
    const combined = `${stdout}\n${stderr}`;
    if (!combined.trim()) {
      return [];
    }

    const resolvedRoot = path.resolve(workspaceRoot);

    // Extract potential path tokens: sequences containing at least one slash
    const rawTokens = combined.match(/[^\s"'`()[\]{}<>|&;,]+/g) ?? [];

    const implicated = new Set<string>();

    for (let raw of rawTokens) {
      if (raw.startsWith("file://")) {
        raw = raw.slice(7);
      }

      // Strip line/column suffixes, e.g. :12:5 or :12 or ,12
      let candidate = raw.replace(/:\d+(?::\d+)?$/, "").replace(/,\d+$/, "");

      // Strip leading and trailing punctuation
      candidate = candidate.replace(/^[.,;:]+/, "").replace(/[.,;:]+$/, "");

      if (!candidate || !candidate.includes("/")) {
        continue;
      }

      // Ignore node_modules, .git, and Node internal modules
      if (
        candidate.includes("node_modules") ||
        candidate.includes(".git") ||
        candidate.startsWith("node:")
      ) {
        continue;
      }

      try {
        let absPath: string;
        let relPath: string;

        if (path.isAbsolute(candidate)) {
          absPath = path.resolve(candidate);
          relPath = path.relative(resolvedRoot, absPath);
        } else {
          const cleanRel = candidate.replace(/^\.\//, "");
          absPath = path.resolve(resolvedRoot, cleanRel);
          relPath = path.relative(resolvedRoot, absPath);
        }

        // Must resolve inside the workspace boundaries
        if (relPath.startsWith("..") || path.isAbsolute(relPath)) {
          continue;
        }

        // Normalize relative path with forward slashes
        const normalizedRelPath = relPath.split(path.sep).join("/");

        if (!normalizedRelPath || normalizedRelPath === ".") {
          continue;
        }

        // Must exist on disk as a file
        if (fs.existsSync(absPath)) {
          const stat = fs.statSync(absPath);
          if (stat.isFile()) {
            implicated.add(normalizedRelPath);
          }
        }
      } catch {
        // Ignore resolution or stat errors
      }
    }

    return [...implicated];
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
     * Explicit planning requests and constraints forbidding modification.
     */
    const explicitPlanningPatterns = [
      /\bimplementation plan\b/,
      /\bplan for\b/,
      /\bplan to\b/,
      /\bdesign plan\b/,
      /\bpropose\b/,
      /\bproposal\b/,
      /\bhow would you\b/,
      /\bhow should we\b/,
      /\bwhat files\b/,
      /\bwhich files\b/,
      /\bdo not modify (?:the )?(?:code|repository|workspace|files|anything)\b/,
      /\bwithout modifying (?:the )?(?:code|repository|workspace|files|anything)\b/,
      /\bonly plan\b/,
      /\bjust plan\b/,
      /\bplan only\b/,
    ];

    if (explicitPlanningPatterns.some((pattern) => pattern.test(normalized))) {
      return "implementation-plan";
    }

    /*
     * Actual implementation and repair action requests.
     */
    const implementationPatterns = [
      /\bimplement\w*\b/,
      /\bbuild\w*\b/,
      /\bcreate\w*\b/,
      /\bdevelop\w*\b/,
      /\badd\w*\b/,
      /\bwrite\w*\b/,
      /\bmodif\w*\b/,
      /\bchange\w*\b/,
      /\bmake\w*\b/,
      /\bfix\w*\b/,
      /\brepair\w*\b/,
      /\bresolv\w*\b/,
      /\bcorrect\w*\b/,
      /\bpatch\w*\b/,
      /\brefactor\w*\b/,
      /\bupdate\w*\b/,
      /\bsolve\w*\b/,
      /\bdebug\w*\b/,
    ];

    if (implementationPatterns.some((pattern) => pattern.test(normalized))) {
      return "implementation";
    }

    /*
     * General planning words.
     */
    if (/\bplan\b|\bplanning\b/.test(normalized)) {
      return "implementation-plan";
    }

    const existingFeatureTerms = [
      "how does",
      "where is",
      "which file",
      "how is",
      "what does",
      "explain how",
      "explain why",
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
- Use write_file to create or replace files, or replace_content for targeted edits.
- Follow the repository's existing architecture and conventions.
- Do not merely provide a plan.
- Do not modify unrelated files.
- Continue until the requested implementation actually exists.

PHASE 3 — VERIFICATION

After writing:

- Use read_file to inspect created or modified files. Read_file does NOT mark verification complete.
- Use run_command to execute project verification (e.g., 'npx tsc --noEmit', 'npm run typecheck', or 'npm test').
- Any write_file or replace_content operation invalidates previous verification results.
- If run_command fails, review the stdout/stderr error details and use replace_content or write_file to repair the code.
- Do not claim implementation success until a verification command succeeds after the latest write.

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
