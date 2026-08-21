/**
 * src/tests/test-agent-runner-api.ts
 *
 * Deterministic regression tests for Milestone 1A: Public AgentRunner API.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as assert from "node:assert/strict";
import { runAgent } from "../api/AgentRunner.js";
import type { ModelProvider } from "../models/ModelProvider.js";
import type { Message, ModelResponse, ToolDefinition } from "../models/types.js";

const TMP_TEST_DIR = path.resolve("./tmp-test-agent-runner");

export class MockSequenceProvider implements ModelProvider {
  private callIndex = 0;
  public capturedModels: string[] = [];

  constructor(private readonly responses: ModelResponse[]) {}

  getInvocationCount(): number {
    return this.callIndex;
  }

  async generate(
    messages: Message[],
    tools: ToolDefinition[],
  ): Promise<ModelResponse> {
    if (this.callIndex < this.responses.length) {
      const resp = this.responses[this.callIndex];
      this.callIndex++;
      if (resp) {
        return resp;
      }
    }
    return {
      content: "All mock responses consumed.",
      toolCalls: [],
    };
  }
}

function cleanTmpDir(dir: string) {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  fs.mkdirSync(dir, { recursive: true });
}

async function testAgentRunnerBasicFactual() {
  const testDir = path.join(TMP_TEST_DIR, "factual");
  cleanTmpDir(testDir);

  const mockProvider = new MockSequenceProvider([
    {
      content: "42 is the answer to life, the universe, and everything.",
      toolCalls: [],
    },
  ]);

  const result = await runAgent({
    prompt: "What is 6 times 7?",
    workspaceRoot: testDir,
    modelProvider: mockProvider,
    maxIterations: 5,
  });

  assert.strictEqual(typeof result.success, "boolean", "result.success must be a boolean");
  assert.strictEqual(result.success, true, "Factual query must succeed");
  assert.strictEqual(result.taskType, "factual", "Task type should be factual");
  assert.strictEqual(result.iterations >= 1, true, "Iterations should be >= 1");
  assert.strictEqual(typeof result.wallClockDurationMs, "number", "wallClockDurationMs must be a number");
  assert.strictEqual(result.finalMessage.includes("42"), true, "Final message should contain 42");
  assert.deepStrictEqual(result.filesWritten, [], "No files should be written");
  assert.strictEqual(typeof result.verified, "boolean", "verified must be boolean");
  assert.ok(result.verificationSummary, "verificationSummary must exist");

  console.log("PASS: 1. AgentRunner accepts prompt and returns documented shape for factual task");
}

async function testAgentRunnerWorkspaceRootRespected() {
  const testDir = path.join(TMP_TEST_DIR, "workspace-root");
  cleanTmpDir(testDir);

  fs.writeFileSync(path.join(testDir, "sample.txt"), "hello from target workspace\n");

  const mockProvider = new MockSequenceProvider([
    {
      content: "",
      toolCalls: [
        {
          id: "call_1",
          name: "read_file",
          arguments: { path: "sample.txt" },
        },
      ],
    },
    {
      content: "The content of sample.txt is hello from target workspace.",
      toolCalls: [],
    },
  ]);

  const result = await runAgent({
    prompt: "What is the content of sample.txt?",
    workspaceRoot: testDir,
    modelProvider: mockProvider,
  });

  assert.strictEqual(result.success, true);
  assert.strictEqual(result.taskType, "factual");
  assert.strictEqual(result.finalMessage.includes("hello from target workspace"), true);
  console.log("PASS: 2. workspaceRoot is respected and target workspace files are accessed");
}

async function testAgentRunnerSuccessfulImplementation() {
  const testDir = path.join(TMP_TEST_DIR, "impl-success");
  cleanTmpDir(testDir);

  // Setup package.json and source files
  fs.writeFileSync(
    path.join(testDir, "package.json"),
    JSON.stringify({
      name: "test-pkg",
      scripts: {
        typecheck: "echo typecheck passed",
        test: "echo test passed",
      },
    }),
  );
  fs.mkdirSync(path.join(testDir, "src", "tests"), { recursive: true });
  fs.writeFileSync(path.join(testDir, "src", "index.ts"), "export const a = 1;\n");
  fs.writeFileSync(path.join(testDir, "src", "tests", "index.test.ts"), "test\n");

  const mockProvider = new MockSequenceProvider([
    // Step 1: Search files
    {
      content: "",
      toolCalls: [
        {
          id: "c1",
          name: "search_files",
          arguments: { query: "index" },
        },
      ],
    },
    // Step 2: List directory
    {
      content: "",
      toolCalls: [
        {
          id: "c2",
          name: "list_directory",
          arguments: { path: "." },
        },
      ],
    },
    // Step 3: Read package.json
    {
      content: "",
      toolCalls: [
        {
          id: "c3",
          name: "read_file",
          arguments: { path: "package.json" },
        },
      ],
    },
    // Step 4: Read src/index.ts
    {
      content: "",
      toolCalls: [
        {
          id: "c4",
          name: "read_file",
          arguments: { path: "src/index.ts" },
        },
      ],
    },
    // Step 5: Read src/tests/index.test.ts
    {
      content: "",
      toolCalls: [
        {
          id: "c5",
          name: "read_file",
          arguments: { path: "src/tests/index.test.ts" },
        },
      ],
    },
    // Transition prompt occurs here (investigation -> implementation)
    // Step 6: Replace content
    {
      content: "",
      toolCalls: [
        {
          id: "c6",
          name: "replace_content",
          arguments: {
            path: "src/index.ts",
            target: "export const a = 1;",
            replacement: "export const a = 2;",
          },
        },
      ],
    },
    // Step 7: Verify typecheck
    {
      content: "",
      toolCalls: [
        {
          id: "c7",
          name: "run_command",
          arguments: { command: "npm run typecheck" },
        },
      ],
    },
    // Step 8: Verify test
    {
      content: "",
      toolCalls: [
        {
          id: "c8",
          name: "run_command",
          arguments: { command: "npm test" },
        },
      ],
    },
    // Step 9: Final message
    {
      content: "Feature implementation completed and verified successfully.",
      toolCalls: [],
    },
  ]);

  const result = await runAgent({
    prompt: "Implement the feature to update a in src/index.ts",
    workspaceRoot: testDir,
    modelProvider: mockProvider,
    maxIterations: 20,
  });

  assert.strictEqual(result.success, true, "Implementation should succeed when fully verified");
  assert.strictEqual(result.taskType, "implementation");
  assert.strictEqual(result.verified, true, "verified flag must be true");
  assert.strictEqual(result.verificationSummary.typecheckPassed, true, "typecheckPassed must be true");
  assert.strictEqual(result.verificationSummary.testPassed, true, "testPassed must be true");
  assert.deepStrictEqual(result.filesWritten, ["src/index.ts"], "filesWritten must list modified files");
  assert.strictEqual(
    fs.readFileSync(path.join(testDir, "src", "index.ts"), "utf8"),
    "export const a = 2;\n",
    "File modification must be present on disk",
  );

  console.log("PASS: 3. Successful verified implementation produces success=true with complete summary");
}

async function testAgentRunnerUnverifiedImplementation() {
  const testDir = path.join(TMP_TEST_DIR, "impl-unverified");
  cleanTmpDir(testDir);

  fs.writeFileSync(
    path.join(testDir, "package.json"),
    JSON.stringify({
      name: "test-pkg",
      scripts: {
        typecheck: "echo typecheck passed",
        test: "echo test passed",
      },
    }),
  );
  fs.mkdirSync(path.join(testDir, "src", "tests"), { recursive: true });
  fs.writeFileSync(path.join(testDir, "src", "index.ts"), "export const a = 1;\n");
  fs.writeFileSync(path.join(testDir, "src", "tests", "index.test.ts"), "test\n");

  const mockProvider = new MockSequenceProvider([
    {
      content: "",
      toolCalls: [{ id: "c1", name: "search_files", arguments: { query: "index" } }],
    },
    {
      content: "",
      toolCalls: [{ id: "c2", name: "list_directory", arguments: { path: "." } }],
    },
    {
      content: "",
      toolCalls: [{ id: "c3", name: "read_file", arguments: { path: "package.json" } }],
    },
    {
      content: "",
      toolCalls: [{ id: "c4", name: "read_file", arguments: { path: "src/index.ts" } }],
    },
    {
      content: "",
      toolCalls: [{ id: "c5", name: "read_file", arguments: { path: "src/tests/index.test.ts" } }],
    },
    // Transition -> writes file but NEVER verifies
    {
      content: "",
      toolCalls: [
        {
          id: "c6",
          name: "replace_content",
          arguments: {
            path: "src/index.ts",
            target: "export const a = 1;",
            replacement: "export const a = 2;",
          },
        },
      ],
    },
    // Tries to claim it's done without running verification
    {
      content: "I am done without running tests.",
      toolCalls: [],
    },
  ]);

  const result = await runAgent({
    prompt: "Implement feature in src/index.ts",
    workspaceRoot: testDir,
    modelProvider: mockProvider,
    maxIterations: 8,
  });

  assert.strictEqual(result.success, false, "Unverified implementation must result in success=false");
  assert.strictEqual(result.verified, false, "verified must be false");
  console.log("PASS: 4. Unverified implementation correctly produces success=false");
}

async function testAgentRunnerMaxIterationsOverride() {
  const testDir = path.join(TMP_TEST_DIR, "max-iterations");
  cleanTmpDir(testDir);

  const mockProvider = new MockSequenceProvider([
    {
      content: "Step 1",
      toolCalls: [{ id: "c1", name: "search_files", arguments: { query: "query1" } }],
    },
    {
      content: "Step 2",
      toolCalls: [{ id: "c2", name: "list_directory", arguments: { path: "." } }],
    },
    {
      content: "Step 3",
      toolCalls: [{ id: "c3", name: "read_file", arguments: { path: "package.json" } }],
    },
  ]);

  const result = await runAgent({
    prompt: "Implement complex task",
    workspaceRoot: testDir,
    modelProvider: mockProvider,
    maxIterations: 2,
  });

  assert.strictEqual(result.success, false);
  assert.strictEqual(result.iterations <= 2, true, "Iterations must not exceed maxIterations override");
  console.log("PASS: 5. maxIterations override is respected");
}

async function testWorkspaceContainmentEnforced() {
  const testDir = path.join(TMP_TEST_DIR, "containment");
  cleanTmpDir(testDir);

  const mockProvider = new MockSequenceProvider([
    {
      content: "",
      toolCalls: [
        {
          id: "c1",
          name: "read_file",
          arguments: { path: "/etc/passwd" },
        },
      ],
    },
    {
      content: "Done",
      toolCalls: [],
    },
  ]);

  const result = await runAgent({
    prompt: "Read system file",
    workspaceRoot: testDir,
    modelProvider: mockProvider,
  });

  const toolEvent = result.trace?.getEvents().find((e) => e.type === "tool");
  assert.ok(toolEvent, "Tool event must exist");
  assert.strictEqual(
    toolEvent.type === "tool" && toolEvent.success,
    false,
    "Escaping workspace must fail",
  );
  console.log("PASS: 6. Workspace containment remains strictly enforced");
}

async function testAgentRunnerSingleIterationLimit() {
  const testDir = path.join(TMP_TEST_DIR, "single-iteration");
  cleanTmpDir(testDir);

  const mockProvider = new MockSequenceProvider([
    {
      content: "Step 1",
      toolCalls: [{ id: "c1", name: "search_files", arguments: { query: "query1" } }],
    },
    {
      content: "Step 2 should never be reached",
      toolCalls: [],
    },
  ]);

  const result = await runAgent({
    prompt: "Implement complex feature in repo",
    workspaceRoot: testDir,
    modelProvider: mockProvider,
    maxIterations: 1,
  });

  assert.strictEqual(
    mockProvider.getInvocationCount(),
    1,
    "Mock provider must be invoked exactly once when maxIterations is 1",
  );
  assert.strictEqual(
    result.iterations,
    1,
    "result.iterations must be exactly 1",
  );
  assert.strictEqual(
    result.success,
    false,
    "result.success must be false when task budget expires after 1 iteration",
  );

  console.log("PASS: 7. maxIterations: 1 halts after exactly 1 model invocation with iterations=1 and success=false");
}

async function main() {
  console.log("============================================================");
  console.log("RUNNING AGENT RUNNER API DETERMINISTIC REGRESSION SUITE");
  console.log("============================================================\n");

  try {
    await testAgentRunnerBasicFactual();
    await testAgentRunnerWorkspaceRootRespected();
    await testAgentRunnerSuccessfulImplementation();
    await testAgentRunnerUnverifiedImplementation();
    await testAgentRunnerMaxIterationsOverride();
    await testWorkspaceContainmentEnforced();
    await testAgentRunnerSingleIterationLimit();

    console.log("\n✅ All 7 AgentRunner API test cases PASSED successfully.");
  } finally {
    if (fs.existsSync(TMP_TEST_DIR)) {
      fs.rmSync(TMP_TEST_DIR, { recursive: true, force: true });
    }
  }
}

main().catch((err) => {
  console.error("Test Suite Failed:", err);
  process.exit(1);
});
