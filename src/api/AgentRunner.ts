import * as path from "node:path";
import { Agent } from "../agent/Agent.js";
import { Workspace } from "../workspace/Workspace.js";
import { ToolRegistry } from "../tools/ToolRegistry.js";
import { ReadFileTool } from "../tools/ReadFileTool.js";
import { WriteFileTool } from "../tools/WriteFileTool.js";
import { ReplaceContentTool } from "../tools/ReplaceContentTool.js";
import { RunCommandTool } from "../tools/RunCommandTool.js";
import { SearchFilesTool } from "../tools/SearchFilesTool.js";
import { ListDirectoryTool } from "../tools/ListDirectoryTool.js";
import { ExecutionTrace } from "../observability/ExecutionTrace.js";
import { ProjectMemory } from "../memory/ProjectMemory.js";
import { OllamaProvider } from "../models/OllamaProvider.js";
import type { AgentRunOptions, AgentRunResult, VerificationSummary } from "./types.js";

/**
 * High-level programmatic API orchestrating Agent execution on a target workspace.
 */
export async function runAgent(options: AgentRunOptions): Promise<AgentRunResult> {
  const workspaceRoot = path.resolve(options.workspaceRoot ?? ".");
  const workspace = new Workspace(workspaceRoot);

  const tools = new ToolRegistry();
  tools.register(new ListDirectoryTool(workspace));
  tools.register(new ReadFileTool(workspace));
  tools.register(new SearchFilesTool(workspace));
  tools.register(new WriteFileTool(workspace));
  tools.register(new ReplaceContentTool(workspace));
  tools.register(new RunCommandTool(workspace));

  const model =
    options.modelProvider ??
    new OllamaProvider(
      "http://localhost:11434/api/chat",
      options.model ?? "qwen2.5-coder:14b",
    );

  const trace = new ExecutionTrace();
  const memory = new ProjectMemory(path.join(workspaceRoot, ".agent-memory.json"));

  const agent = new Agent(model, tools, trace, memory, {
    workspaceRoot,
    ...(options.maxIterations !== undefined
      ? { maxIterations: options.maxIterations }
      : {}),
  });

  const startTime = Date.now();
  let finalMessage = "";
  let error: Error | null = null;

  try {
    finalMessage = await agent.run(options.prompt);
  } catch (err: any) {
    error = err;
    finalMessage = err?.message || String(err);
  }

  const wallClockDurationMs = Date.now() - startTime;
  const investigation = agent.getLastInvestigation();
  const implState = investigation?.getImplementationState();
  const taskType = investigation?.getTaskType() ?? "implementation";
  const filesWritten = implState?.filesWritten ?? [];
  const verified = investigation ? investigation.isImplementationComplete() : false;
  const completedCats = implState?.completedCategories ?? [];

  const verificationSummary: VerificationSummary = {
    typecheckPassed: completedCats.includes("typecheck"),
    testPassed: completedCats.includes("test"),
  };

  const modelEvents = trace.getEvents().filter((e) => e.type === "model");
  const iterations = modelEvents.length > 0 ? modelEvents.length : 0;

  const success =
    !error &&
    (taskType === "implementation"
      ? verified
      : Boolean(finalMessage && finalMessage.length > 0));

  return {
    success,
    taskType,
    iterations,
    wallClockDurationMs,
    finalMessage,
    filesWritten,
    verified,
    verificationSummary,
    trace,
  };
}
