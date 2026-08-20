/**
 * src/cli.ts
 *
 * Developer-facing Command Line Interface for local-ai-agent.
 * Wraps the programmatic runAgent() API with concise progress reporting,
 * polished terminal presentation, and optional --verbose debugging.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { runAgent } from "./api/AgentRunner.js";
import type { AgentRunOptions, AgentRunResult } from "./api/types.js";

export interface ParsedCliArgs {
  options: AgentRunOptions;
  showHelp: boolean;
  showVersion: boolean;
  verbose: boolean;
  error?: string;
}

export function getPackageVersion(): string {
  try {
    const currentDir = path.dirname(fileURLToPath(import.meta.url));
    const packageJsonPath = path.resolve(currentDir, "../package.json");
    if (fs.existsSync(packageJsonPath)) {
      const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
      return pkg.version || "1.0.0";
    }
  } catch {}
  return "1.0.0";
}

export function getHelpText(): string {
  return `Local AI Agent - Autonomous Local Coding Assistant

Usage:
  local-ai-agent [options] "<prompt>"

Options:
  -w, --workspace <path>       Target workspace directory (default: current directory)
  -m, --model <model>          Ollama model to use (default: qwen2.5-coder:14b)
  -i, --max-iterations <num>   Maximum allowed agent iterations (positive integer)
  -V, --verbose                Display detailed execution and tool logging
  -v, --version                Display package version
  -h, --help                   Display this help message

Examples:
  local-ai-agent "Fix the failing tests in src/tests/todo.test.ts"
  local-ai-agent --workspace ./my-project "Fix TypeScript errors"
  local-ai-agent --model qwen2.5-coder:14b "Refactor task service"
  local-ai-agent --verbose "Inspect and repair defect"
`;
}

export function parseCliArgs(args: string[]): ParsedCliArgs {
  let showHelp = false;
  let showVersion = false;
  let verbose = false;
  let workspaceRoot: string | undefined;
  let model: string | undefined;
  let maxIterations: number | undefined;
  const promptTokens: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg) continue;

    if (arg === "-h" || arg === "--help") {
      showHelp = true;
      continue;
    }

    if (arg === "-v" || arg === "--version") {
      showVersion = true;
      continue;
    }

    if (arg === "-V" || arg === "--verbose") {
      verbose = true;
      continue;
    }

    if (arg === "-w" || arg === "--workspace") {
      const val = args[i + 1];
      if (!val || val.startsWith("-")) {
        return {
          options: { prompt: "" },
          showHelp: false,
          showVersion: false,
          verbose: false,
          error: "--workspace requires a valid directory path",
        };
      }
      workspaceRoot = val;
      i++;
      continue;
    }

    if (arg.startsWith("--workspace=")) {
      const val = arg.slice("--workspace=".length);
      if (!val) {
        return {
          options: { prompt: "" },
          showHelp: false,
          showVersion: false,
          verbose: false,
          error: "--workspace requires a valid directory path",
        };
      }
      workspaceRoot = val;
      continue;
    }

    if (arg === "-m" || arg === "--model") {
      const val = args[i + 1];
      if (!val || val.startsWith("-")) {
        return {
          options: { prompt: "" },
          showHelp: false,
          showVersion: false,
          verbose: false,
          error: "--model requires a model name",
        };
      }
      model = val;
      i++;
      continue;
    }

    if (arg.startsWith("--model=")) {
      const val = arg.slice("--model=".length);
      if (!val) {
        return {
          options: { prompt: "" },
          showHelp: false,
          showVersion: false,
          verbose: false,
          error: "--model requires a model name",
        };
      }
      model = val;
      continue;
    }

    if (arg === "-i" || arg === "--max-iterations") {
      const val = args[i + 1];
      if (!val || val.startsWith("-")) {
        return {
          options: { prompt: "" },
          showHelp: false,
          showVersion: false,
          verbose: false,
          error: "--max-iterations requires a positive integer",
        };
      }
      const parsed = parseInt(val, 10);
      if (Number.isNaN(parsed) || parsed <= 0 || String(parsed) !== val) {
        return {
          options: { prompt: "" },
          showHelp: false,
          showVersion: false,
          verbose: false,
          error: "--max-iterations requires a positive integer",
        };
      }
      maxIterations = parsed;
      i++;
      continue;
    }

    if (arg.startsWith("--max-iterations=")) {
      const val = arg.slice("--max-iterations=".length);
      const parsed = parseInt(val, 10);
      if (Number.isNaN(parsed) || parsed <= 0 || String(parsed) !== val) {
        return {
          options: { prompt: "" },
          showHelp: false,
          showVersion: false,
          verbose: false,
          error: "--max-iterations requires a positive integer",
        };
      }
      maxIterations = parsed;
      continue;
    }

    if (arg.startsWith("-")) {
      return {
        options: { prompt: "" },
        showHelp: false,
        showVersion: false,
        verbose: false,
        error: `Unknown option: ${arg}`,
      };
    }

    promptTokens.push(arg);
  }

  const prompt = promptTokens.join(" ").trim();

  if (!showHelp && !showVersion && prompt.length === 0) {
    return {
      options: { prompt: "" },
      showHelp: false,
      showVersion: false,
      verbose,
      error: 'Missing required prompt. Usage: local-ai-agent [options] "<prompt>"',
    };
  }

  const options: AgentRunOptions = {
    prompt,
    ...(workspaceRoot ? { workspaceRoot } : {}),
    ...(model ? { model } : {}),
    ...(maxIterations ? { maxIterations } : {}),
  };

  return {
    options,
    showHelp,
    showVersion,
    verbose,
  };
}

export function formatResultOutput(result: AgentRunResult): string {
  const lines: string[] = [];
  const durationSec = (result.wallClockDurationMs / 1000).toFixed(1);

  if (result.success) {
    lines.push("\n  ✓ Task completed\n");

    const hasVerification =
      result.verificationSummary.typecheckPassed !== undefined ||
      result.verificationSummary.testPassed !== undefined;

    if (hasVerification) {
      lines.push("  Verification");
      if (result.verificationSummary.typecheckPassed !== undefined) {
        const mark = result.verificationSummary.typecheckPassed ? "✓" : "✗";
        lines.push(`    ${mark} Typecheck`);
      }
      if (result.verificationSummary.testPassed !== undefined) {
        const mark = result.verificationSummary.testPassed ? "✓" : "✗";
        lines.push(`    ${mark} Tests`);
      }
      lines.push("");
    }

    lines.push(`  Files changed: ${result.filesWritten.length}`);
    lines.push(`  Iterations:    ${result.iterations}`);
    lines.push(`  Duration:      ${durationSec}s`);

    if (result.filesWritten.length > 0) {
      lines.push("\n  Modified files:");
      for (const file of result.filesWritten) {
        lines.push(`    - ${file}`);
      }
    }
  } else {
    lines.push("\n  ✗ Task could not be verified\n");

    const hasVerification =
      result.verificationSummary.typecheckPassed !== undefined ||
      result.verificationSummary.testPassed !== undefined;

    if (hasVerification) {
      lines.push("  Verification");
      if (result.verificationSummary.typecheckPassed !== undefined) {
        const mark = result.verificationSummary.typecheckPassed ? "✓" : "✗";
        lines.push(`    ${mark} Typecheck`);
      }
      if (result.verificationSummary.testPassed !== undefined) {
        const mark = result.verificationSummary.testPassed ? "✓" : "✗";
        lines.push(`    ${mark} Tests`);
      }
      lines.push("");
    }

    lines.push(`  Files changed: ${result.filesWritten.length}`);
    lines.push(`  Iterations:    ${result.iterations}`);
    lines.push(`  Duration:      ${durationSec}s`);

    if (result.finalMessage) {
      lines.push("\n  Reason:");
      lines.push(`    ${result.finalMessage}`);
    }

    if (result.filesWritten.length > 0) {
      lines.push("\n  Modified files:");
      for (const file of result.filesWritten) {
        lines.push(`    - ${file}`);
      }
    }
  }

  return lines.join("\n");
}

export class ConciseProgressReporter {
  private currentIteration = 0;
  private readonly maxIterations: number;
  private readonly originalLog: typeof console.log;

  constructor(maxIterations = 20) {
    this.maxIterations = maxIterations;
    this.originalLog = console.log;
  }

  start(): void {
    console.log = (...args: unknown[]) => {
      const line = args
        .map((a) => (typeof a === "string" ? a : JSON.stringify(a)))
        .join(" ");

      this.processLogLine(line);
    };
  }

  stop(): void {
    console.log = this.originalLog;
  }

  private printStep(message: string): void {
    const iterDisplay = Math.max(1, this.currentIteration);
    const prefix = `  [${iterDisplay}/${this.maxIterations}]`;
    this.originalLog(`${prefix} ${message}`);
  }

  processLogLine(line: string): void {
    if (line.startsWith("[model-metrics]")) {
      this.currentIteration += 1;
      return;
    }

    if (line.startsWith("[tool] list_directory")) {
      try {
        const argsStr = line.slice("[tool] list_directory".length).trim();
        const parsed = JSON.parse(argsStr);
        const targetPath = parsed?.path === "." ? "workspace" : parsed?.path || "directory";
        this.printStep(`Inspecting ${targetPath}`);
      } catch {
        this.printStep("Inspecting directory structure");
      }
      return;
    }

    if (line.startsWith("[tool] search_files")) {
      try {
        const argsStr = line.slice("[tool] search_files".length).trim();
        const parsed = JSON.parse(argsStr);
        this.printStep(`Searching workspace for '${parsed?.query || ""}'`);
      } catch {
        this.printStep("Searching workspace files");
      }
      return;
    }

    if (line.startsWith("[tool] read_file")) {
      try {
        const argsStr = line.slice("[tool] read_file".length).trim();
        const parsed = JSON.parse(argsStr);
        this.printStep(`Reading ${parsed?.path || "file"}`);
      } catch {
        this.printStep("Reading workspace file");
      }
      return;
    }

    if (line.startsWith("[tool] replace_content")) {
      try {
        const argsStr = line.slice("[tool] replace_content".length).trim();
        const parsed = JSON.parse(argsStr);
        this.printStep(`Applying targeted repair to ${parsed?.path || "file"}`);
      } catch {
        this.printStep("Applying targeted repair");
      }
      return;
    }

    if (line.startsWith("[tool] write_file")) {
      try {
        const argsStr = line.slice("[tool] write_file".length).trim();
        const parsed = JSON.parse(argsStr);
        this.printStep(`Writing ${parsed?.path || "file"}`);
      } catch {
        this.printStep("Writing file");
      }
      return;
    }

    if (line.startsWith("[tool] run_command")) {
      try {
        const argsStr = line.slice("[tool] run_command".length).trim();
        const parsed = JSON.parse(argsStr);
        this.printStep(`Running ${parsed?.command || "command"}`);
      } catch {
        this.printStep("Running verification command");
      }
      return;
    }

    if (line.startsWith("[implementation-verification]")) {
      const rest = line.slice("[implementation-verification]".length).trim();
      this.printStep(`Verification: ${rest}`);
      return;
    }

    if (line.startsWith("[repair-evidence]")) {
      const rest = line.slice("[repair-evidence]".length).trim();
      this.printStep(`Repair evidence required: ${rest}`);
      return;
    }

    if (line.includes("[REPAIR EVIDENCE SATISFIED]")) {
      this.printStep("Repair evidence satisfied");
    }
  }
}

export async function runCli(
  args: string[] = process.argv.slice(2),
  runner: typeof runAgent = runAgent,
): Promise<number> {
  const parsed = parseCliArgs(args);

  if (parsed.showHelp) {
    console.log(getHelpText());
    return 0;
  }

  if (parsed.showVersion) {
    console.log(`local-ai-agent v${getPackageVersion()}`);
    return 0;
  }

  if (parsed.error) {
    console.error(`Error: ${parsed.error}\n`);
    console.error("Run 'local-ai-agent --help' for usage information.");
    return 1;
  }

  const { options, verbose } = parsed;
  const workspaceDisplay = path.resolve(options.workspaceRoot ?? ".");
  const modelDisplay = options.model ?? "qwen2.5-coder:14b";
  const maxIterations = options.maxIterations ?? 20;

  console.log("\n  Local AI Agent");
  console.log("  ─────────────────────────────");
  console.log(`  Model:     ${modelDisplay}`);
  console.log(`  Workspace: ${workspaceDisplay}`);
  console.log(`  Task:      ${options.prompt}\n`);

  const reporter = new ConciseProgressReporter(maxIterations);
  if (!verbose) {
    reporter.start();
  }

  try {
    const result = await runner(options);
    if (!verbose) {
      reporter.stop();
    }
    console.log(formatResultOutput(result));
    return result.success ? 0 : 1;
  } catch (err: any) {
    if (!verbose) {
      reporter.stop();
    }
    console.error(`\n  ✗ Unexpected error: ${err?.message || err}`);
    return 1;
  }
}

// Auto-run if executed directly as entrypoint
const entryScript = process.argv[1] ? path.basename(process.argv[1]) : "";
const isDirectEntry =
  entryScript === "cli.ts" ||
  entryScript === "cli.js" ||
  entryScript === "local-ai-agent.js" ||
  entryScript === "local-ai-agent";

if (isDirectEntry) {
  runCli().then((code) => {
    process.exitCode = code;
  });
}
