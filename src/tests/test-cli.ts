/**
 * src/tests/test-cli.ts
 *
 * Deterministic unit and integration tests for Milestone 1B: CLI MVP.
 */

import * as assert from "node:assert/strict";
import { parseCliArgs, runCli, getHelpText, getPackageVersion } from "../cli.js";
import type { AgentRunOptions, AgentRunResult } from "../api/types.js";

function makeFakeResult(overrides: Partial<AgentRunResult> = {}): AgentRunResult {
  return {
    success: true,
    taskType: "implementation",
    iterations: 3,
    wallClockDurationMs: 4200,
    finalMessage: "Task completed successfully",
    filesWritten: ["src/index.ts"],
    verified: true,
    verificationSummary: {
      typecheckPassed: true,
      testPassed: true,
    },
    ...overrides,
  };
}

async function testParseCliArgsBasicPrompt() {
  const parsed = parseCliArgs(["Fix", "the", "failing", "tests"]);
  assert.strictEqual(parsed.showHelp, false);
  assert.strictEqual(parsed.showVersion, false);
  assert.strictEqual(parsed.error, undefined);
  assert.strictEqual(parsed.options.prompt, "Fix the failing tests");
  console.log("PASS: 1. Positional prompt parsed correctly");
}

async function testParseCliArgsWorkspaceOption() {
  const parsed1 = parseCliArgs(["-w", "./subproject", "Fix tests"]);
  assert.strictEqual(parsed1.options.workspaceRoot, "./subproject");
  assert.strictEqual(parsed1.options.prompt, "Fix tests");

  const parsed2 = parseCliArgs(["--workspace=./subproject", "Fix tests"]);
  assert.strictEqual(parsed2.options.workspaceRoot, "./subproject");
  assert.strictEqual(parsed2.options.prompt, "Fix tests");

  console.log("PASS: 2. --workspace / -w option parsed and forwarded");
}

async function testParseCliArgsModelOption() {
  const parsed1 = parseCliArgs(["-m", "qwen3:8b", "Refactor function"]);
  assert.strictEqual(parsed1.options.model, "qwen3:8b");
  assert.strictEqual(parsed1.options.prompt, "Refactor function");

  const parsed2 = parseCliArgs(["--model=qwen3:8b", "Refactor function"]);
  assert.strictEqual(parsed2.options.model, "qwen3:8b");
  assert.strictEqual(parsed2.options.prompt, "Refactor function");

  console.log("PASS: 3. --model / -m option parsed and forwarded");
}

async function testParseCliArgsMaxIterationsOption() {
  const parsed1 = parseCliArgs(["-i", "15", "Implement feature"]);
  assert.strictEqual(parsed1.options.maxIterations, 15);
  assert.strictEqual(parsed1.options.prompt, "Implement feature");

  const parsed2 = parseCliArgs(["--max-iterations=25", "Implement feature"]);
  assert.strictEqual(parsed2.options.maxIterations, 25);
  assert.strictEqual(parsed2.options.prompt, "Implement feature");

  console.log("PASS: 4. --max-iterations / -i option parsed and forwarded");
}

async function testHelpAndVersionFlags() {
  const helpParsed = parseCliArgs(["--help"]);
  assert.strictEqual(helpParsed.showHelp, true);
  assert.ok(getHelpText().includes("Usage:"));

  const versionParsed = parseCliArgs(["--version"]);
  assert.strictEqual(versionParsed.showVersion, true);
  assert.ok(getPackageVersion().length > 0);

  let capturedOutput = "";
  const originalLog = console.log;
  console.log = (msg: string) => {
    capturedOutput += msg + "\n";
  };

  try {
    const helpCode = await runCli(["--help"], async () => makeFakeResult());
    assert.strictEqual(helpCode, 0);
    assert.ok(capturedOutput.includes("Usage:"));

    capturedOutput = "";
    const versionCode = await runCli(["--version"], async () => makeFakeResult());
    assert.strictEqual(versionCode, 0);
    assert.ok(capturedOutput.includes("local-ai-agent v"));
  } finally {
    console.log = originalLog;
  }

  console.log("PASS: 5. --help and --version work with exit code 0");
}

async function testValidationMissingPromptAndInvalidOptions() {
  const noArgs = parseCliArgs([]);
  assert.ok(noArgs.error);
  assert.ok(noArgs.error.includes("Missing required prompt"));

  const unknownOption = parseCliArgs(["--unknown-flag", "hello"]);
  assert.ok(unknownOption.error);
  assert.ok(unknownOption.error.includes("Unknown option"));

  const invalidIterations1 = parseCliArgs(["-i", "abc", "prompt"]);
  assert.ok(invalidIterations1.error);
  assert.ok(invalidIterations1.error.includes("positive integer"));

  const invalidIterations2 = parseCliArgs(["-i", "-5", "prompt"]);
  assert.ok(invalidIterations2.error);
  assert.ok(invalidIterations2.error.includes("positive integer"));

  const invalidIterations3 = parseCliArgs(["-i", "0", "prompt"]);
  assert.ok(invalidIterations3.error);
  assert.ok(invalidIterations3.error.includes("positive integer"));

  const missingWorkspaceVal = parseCliArgs(["--workspace"]);
  assert.ok(missingWorkspaceVal.error);

  const missingModelVal = parseCliArgs(["--model"]);
  assert.ok(missingModelVal.error);

  console.log("PASS: 6. Missing prompt and invalid arguments properly rejected");
}

async function testRunCliSuccessExitCodeAndDelegation() {
  let capturedOptions: AgentRunOptions | null = null;
  const mockRunner = async (opts: AgentRunOptions): Promise<AgentRunResult> => {
    capturedOptions = opts;
    return makeFakeResult({
      success: true,
      filesWritten: ["src/app.ts", "src/utils.ts"],
      iterations: 5,
      wallClockDurationMs: 3200,
      verificationSummary: {
        typecheckPassed: true,
        testPassed: true,
      },
    });
  };

  const exitCode = await runCli(
    ["-w", "./my-app", "-m", "qwen2.5-coder:14b", "-i", "10", "Fix issue"],
    mockRunner,
  );

  assert.strictEqual(exitCode, 0, "Successful run must return exit code 0");
  assert.ok(capturedOptions);
  assert.strictEqual((capturedOptions as AgentRunOptions).prompt, "Fix issue");
  assert.strictEqual((capturedOptions as AgentRunOptions).workspaceRoot, "./my-app");
  assert.strictEqual((capturedOptions as AgentRunOptions).model, "qwen2.5-coder:14b");
  assert.strictEqual((capturedOptions as AgentRunOptions).maxIterations, 10);

  console.log("PASS: 7. Successful AgentRunResult produces exit code 0 and delegates options cleanly");
}

async function testRunCliFailureExitCode() {
  const mockFailureRunner = async (): Promise<AgentRunResult> => {
    return makeFakeResult({
      success: false,
      finalMessage: "Typecheck failed on src/index.ts",
      verified: false,
      verificationSummary: {
        typecheckPassed: false,
        testPassed: false,
      },
    });
  };

  const exitCode = await runCli(["Fix issue"], mockFailureRunner);
  assert.strictEqual(exitCode, 1, "Failed run must return exit code 1");

  console.log("PASS: 8. Failed AgentRunResult produces non-zero exit code (1)");
}

async function testRunCliExceptionHandling() {
  const mockThrowingRunner = async (): Promise<AgentRunResult> => {
    throw new Error("Ollama service unreachable");
  };

  const exitCode = await runCli(["Fix issue"], mockThrowingRunner);
  assert.strictEqual(exitCode, 1, "Thrown error must return exit code 1");

  console.log("PASS: 9. AgentRunner exceptions handled cleanly with non-zero exit code");
}

async function main() {
  console.log("============================================================");
  console.log("RUNNING CLI MVP DETERMINISTIC REGRESSION SUITE");
  console.log("============================================================\n");

  await testParseCliArgsBasicPrompt();
  await testParseCliArgsWorkspaceOption();
  await testParseCliArgsModelOption();
  await testParseCliArgsMaxIterationsOption();
  await testHelpAndVersionFlags();
  await testValidationMissingPromptAndInvalidOptions();
  await testRunCliSuccessExitCodeAndDelegation();
  await testRunCliFailureExitCode();
  await testRunCliExceptionHandling();

  console.log("\n✅ All 9 CLI test cases PASSED successfully.");
}

main().catch((err) => {
  console.error("Test Suite Failed:", err);
  process.exit(1);
});
