/**
 * src/tests/test-agent-task-type-detection.ts
 *
 * Deterministic test verifying task type classification and end-to-end
 * investigation -> implementation transition behavior across real-world prompts.
 */

import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { Agent } from "../agent/Agent.js";
import { ToolRegistry } from "../tools/ToolRegistry.js";
import { ExecutionTrace } from "../observability/ExecutionTrace.js";
import { ProjectMemory } from "../memory/ProjectMemory.js";
import { FakeModelProvider } from "./fakes/FakeModelProvider.js";
import { FakeRunCommandTool } from "./fakes/FakeRunCommandTool.js";
import { Workspace } from "../workspace/Workspace.js";
import { SearchFilesTool } from "../tools/SearchFilesTool.js";
import { ListDirectoryTool } from "../tools/ListDirectoryTool.js";
import { ReadFileTool } from "../tools/ReadFileTool.js";
import { ReplaceContentTool } from "../tools/ReplaceContentTool.js";
import { WriteFileTool } from "../tools/WriteFileTool.js";

const TMP_TEST_DIR = path.resolve("./tmp-task-type-test");

function cleanTmpDir(dir: string) {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  fs.mkdirSync(dir, { recursive: true });
}

async function testPromptClassification(prompt: string, expectedType: string) {
  const workspace = new Workspace(".");
  const tools = new ToolRegistry();
  tools.register(new SearchFilesTool(workspace));
  const trace = new ExecutionTrace();
  const memory = new ProjectMemory("./data/project-memory.json");
  const model = new FakeModelProvider([
    {
      content: "Test response",
      toolCalls: [],
    },
  ]);

  const agent = new Agent(model, tools, trace, memory);
  await agent.run(prompt).catch(() => {});
  const actualType = agent.getLastInvestigation()?.getTaskType();
  assert.strictEqual(
    actualType,
    expectedType,
    `Prompt: "${prompt}" expected taskType "${expectedType}" but got "${actualType}"`,
  );
}

async function testInvestigationToImplementationTransition() {
  const testDir = path.join(TMP_TEST_DIR, "transition-test");
  cleanTmpDir(testDir);

  fs.writeFileSync(
    path.join(testDir, "package.json"),
    JSON.stringify({
      name: "test-pkg",
      type: "module",
      scripts: {
        typecheck: "echo typecheck passed",
        test: "echo test passed",
      },
    }),
  );
  fs.mkdirSync(path.join(testDir, "src", "tests"), { recursive: true });
  fs.writeFileSync(path.join(testDir, "src", "index.ts"), "export const a = 1;\n");
  fs.writeFileSync(path.join(testDir, "src", "tests", "index.test.ts"), "test\n");

  const workspace = new Workspace(testDir);
  const tools = new ToolRegistry();
  tools.register(new ListDirectoryTool(workspace));
  tools.register(new ReadFileTool(workspace));
  tools.register(new SearchFilesTool(workspace));
  tools.register(new WriteFileTool(workspace));
  tools.register(new ReplaceContentTool(workspace));

  const fakeRunCommand = new FakeRunCommandTool([
    { exitCode: 0, stdout: "typecheck clean", stderr: "" },
    { exitCode: 0, stdout: "ok 1 - all pass", stderr: "" },
  ]);
  tools.register(fakeRunCommand);

  const trace = new ExecutionTrace();
  const memory = new ProjectMemory(path.join(testDir, ".memory.json"));

  const model = new FakeModelProvider([
    // Step 1: search_files -> featureSearchCompleted
    {
      content: "",
      toolCalls: [
        { id: "c1", name: "search_files", arguments: { query: "index" } },
      ],
    },
    // Step 2: list_directory -> repositoryStructureInspected
    {
      content: "",
      toolCalls: [
        { id: "c2", name: "list_directory", arguments: { path: "." } },
      ],
    },
    // Step 3: read_file package.json -> configurationInspected
    {
      content: "",
      toolCalls: [
        { id: "c3", name: "read_file", arguments: { path: "package.json" } },
      ],
    },
    // Step 4: read_file src/index.ts -> implementationInspected
    {
      content: "",
      toolCalls: [
        { id: "c4", name: "read_file", arguments: { path: "src/index.ts" } },
      ],
    },
    // Step 5: read_file src/tests/index.test.ts -> testsInspected
    {
      content: "",
      toolCalls: [
        { id: "c5", name: "read_file", arguments: { path: "src/tests/index.test.ts" } },
      ],
    },
    // Transition occurs here: prompt instructs model to begin implementation!
    // Step 6: replace_content on src/index.ts
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
    // Step 7: run_command npm run typecheck
    {
      content: "",
      toolCalls: [
        { id: "c7", name: "run_command", arguments: { command: "npm run typecheck" } },
      ],
    },
    // Step 8: run_command npm test
    {
      content: "",
      toolCalls: [
        { id: "c8", name: "run_command", arguments: { command: "npm test" } },
      ],
    },
    // Step 9: Final message
    {
      content: "All defects repaired and verified.",
      toolCalls: [],
    },
  ]);

  const agent = new Agent(model, tools, trace, memory, { workspaceRoot: testDir });

  // Use the exact real-world repair prompt
  const finalMessage = await agent.run(
    "Inspect this repository, identify the failing issues, repair the underlying defects, and verify the solution. Do not stop merely after identifying the problems.",
  );

  const investigation = agent.getLastInvestigation();
  assert.ok(investigation);
  assert.strictEqual(investigation.getTaskType(), "implementation");
  assert.strictEqual(investigation.isImplementationComplete(), true);
  assert.deepStrictEqual(investigation.getImplementationState().filesWritten, ["src/index.ts"]);
  assert.strictEqual(
    fs.readFileSync(path.join(testDir, "src", "index.ts"), "utf8"),
    "export const a = 2;\n",
  );
  assert.strictEqual(finalMessage, "All defects repaired and verified.");
  console.log("PASS: End-to-end investigation -> implementation transition executed and verified.");
}

async function main() {
  console.log("============================================================");
  console.log("TESTING AGENT TASK TYPE CLASSIFICATION & TRANSITIONS");
  console.log("============================================================\n");

  try {
    // Real-world repair / bug-fix prompts that MUST enter implementation
    await testPromptClassification(
      "Inspect this repository, identify the failing issues, repair the underlying defects, and verify the solution. Do not stop merely after identifying the problems.",
      "implementation",
    );
    await testPromptClassification(
      "Fix the failing tests in src/tests/todo.test.ts",
      "implementation",
    );
    await testPromptClassification(
      "Repair the bug in orderService",
      "implementation",
    );
    await testPromptClassification(
      "Resolve the TypeScript compiler errors",
      "implementation",
    );
    await testPromptClassification(
      "Debug and patch the inventory shortage issue",
      "implementation",
    );
    await testPromptClassification(
      "Refactor task-service to use map instead of filter",
      "implementation",
    );

    // Substring safety: "explanation" should NOT trigger implementation-plan
    await testPromptClassification(
      "Explain how the server starts and give an explanation",
      "existing-feature",
    );

    // True planning prompts
    await testPromptClassification(
      "Create an implementation plan for adding user authentication",
      "implementation-plan",
    );
    await testPromptClassification(
      "Propose a design plan without modifying any files",
      "implementation-plan",
    );

    console.log("PASS: All prompt classifications correct.\n");

    await testInvestigationToImplementationTransition();

    console.log("\n✅ All task type detection & transition tests PASSED.");
  } finally {
    if (fs.existsSync(TMP_TEST_DIR)) {
      fs.rmSync(TMP_TEST_DIR, { recursive: true, force: true });
    }
  }
}

main().catch((err) => {
  console.error("Test Failed:", err);
  process.exit(1);
});
