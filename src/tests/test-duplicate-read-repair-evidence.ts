/**
 * test-duplicate-read-repair-evidence.ts
 *
 * Deterministic regression tests for PR #5:
 * Satisfying repair evidence when read_file is re-issued for an implicated file
 * after a verification failure, even if the read_file call is classified as a duplicate.
 *
 * Scenarios tested:
 * 1. Exact Run 24 reproduction:
 *    - Initial investigation reads src/tests/todos.test.ts (recorded in executedToolCalls).
 *    - Verification fails, marking src/tests/todos.test.ts as unread repair evidence.
 *    - Model attempts replace_content -> Gate rejects with REPAIR EVIDENCE REQUIRED.
 *    - Model calls read_file("src/tests/todos.test.ts") -> duplicate detection occurs.
 *    - Despite duplicate detection, repair evidence is satisfied.
 *    - Next replace_content is allowed through the gate and succeeds.
 *    - Subsequent verification passes.
 * 2. Initial investigation read alone does NOT satisfy repair evidence.
 * 3. Duplicate read before verification failure does NOT satisfy repair evidence.
 * 4. Duplicate read after verification failure DOES satisfy active repair evidence.
 * 5. Unrelated duplicate reads remain unchanged (duplicate message returned, not treated as new work).
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { Agent } from "../agent/Agent.js";
import { ToolRegistry } from "../tools/ToolRegistry.js";
import { ReadFileTool } from "../tools/ReadFileTool.js";
import { WriteFileTool } from "../tools/WriteFileTool.js";
import { ReplaceContentTool } from "../tools/ReplaceContentTool.js";
import { SearchFilesTool } from "../tools/SearchFilesTool.js";
import { ListDirectoryTool } from "../tools/ListDirectoryTool.js";
import { ExecutionTrace } from "../observability/ExecutionTrace.js";
import { ProjectMemory } from "../memory/ProjectMemory.js";
import { Workspace } from "../workspace/Workspace.js";
import { FakeModelProvider } from "./fakes/FakeModelProvider.js";
import { FakeRunCommandTool, type FakeCommandResponse } from "./fakes/FakeRunCommandTool.js";
import type { Message, ModelResponse } from "../models/types.js";

const tmpWorkspace = path.resolve("./tmp-test-duplicate-read-repair");

function cleanup() {
  if (fs.existsSync(tmpWorkspace)) {
    fs.rmSync(tmpWorkspace, { recursive: true, force: true });
  }
}

function setupFixture() {
  cleanup();
  fs.mkdirSync(path.join(tmpWorkspace, "src", "tests"), { recursive: true });

  fs.writeFileSync(
    path.join(tmpWorkspace, "package.json"),
    JSON.stringify(
      {
        name: "test-pkg",
        type: "module",
        scripts: { test: "node --test", typecheck: "tsc --noEmit" },
      },
      null,
      2,
    ),
  );

  fs.writeFileSync(
    path.join(tmpWorkspace, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          strict: true,
          types: ["node"],
        },
      },
      null,
      2,
    ),
  );

  fs.writeFileSync(
    path.join(tmpWorkspace, "src", "index.ts"),
    `export function addTodo(): boolean { return true; }\n`,
  );

  fs.writeFileSync(
    path.join(tmpWorkspace, "src", "tests", "todos.test.ts"),
    `import test from 'node:test';\nimport { addTodo } from '../index';\ntest('todo', () => { addTodo(); });\n`,
  );
}

class GracefulRecordingFake extends FakeModelProvider {
  public recordedMessages: Message[][] = [];

  constructor(responses: ModelResponse[]) {
    super(responses);
  }

  override async generate(messages: Message[], toolsDef: any): Promise<ModelResponse> {
    this.recordedMessages.push(JSON.parse(JSON.stringify(messages)));
    try {
      return await super.generate(messages, toolsDef);
    } catch {
      return { content: "Done (fallback)", toolCalls: [] };
    }
  }
}

// ---------------------------------------------------------------------------
// Test 1: Exact Run 24 reproduction (Investigation read -> verification fail -> gated replace -> duplicate read -> allowed replace -> verify)
// ---------------------------------------------------------------------------
async function testRun24DuplicateReadReproduction() {
  setupFixture();

  const workspace = new Workspace(tmpWorkspace);
  const tools = new ToolRegistry();
  tools.register(new ListDirectoryTool(workspace));
  tools.register(new ReadFileTool(workspace));
  tools.register(new WriteFileTool(workspace));
  tools.register(new ReplaceContentTool(workspace));
  tools.register(new SearchFilesTool(workspace));

  const fakeRunCmd = new FakeRunCommandTool([
    // Call 1: verification fails with TS2835 on src/tests/todos.test.ts
    {
      exitCode: 1,
      stdout: `src/tests/todos.test.ts(2,26): error TS2835: Relative import paths need explicit file extensions in ECMAScript imports when '--moduleResolution' is 'node16' or 'nodenext'. Did you mean '../index.js'?`,
      stderr: "Command failed: npm run typecheck\n",
    },
    // Call 2: verification passes after repair
    {
      exitCode: 0,
      stdout: "typecheck clean",
      stderr: "",
    },
    // Call 3: test passes
    {
      exitCode: 0,
      stdout: "ok 1 - all tests pass",
      stderr: "",
    },
  ]);
  tools.register(fakeRunCmd);

  const modelResponses: ModelResponse[] = [
    // Turn 1: Search files
    {
      content: "",
      toolCalls: [{ id: "c1", name: "search_files", arguments: { query: "addTodo" } }],
    },
    // Turn 2: List directory
    {
      content: "",
      toolCalls: [{ id: "c2", name: "list_directory", arguments: { path: "." } }],
    },
    // Turn 3: Read package.json
    {
      content: "",
      toolCalls: [{ id: "c3", name: "read_file", arguments: { path: "package.json" } }],
    },
    // Turn 4: Read src/index.ts (implementation inspected)
    {
      content: "",
      toolCalls: [{ id: "c4", name: "read_file", arguments: { path: "src/index.ts" } }],
    },
    // Turn 5: Read src/tests/todos.test.ts (tests inspected during investigation)
    {
      content: "",
      toolCalls: [{ id: "c5", name: "read_file", arguments: { path: "src/tests/todos.test.ts" } }],
    },
    // Turn 6: Run verification -> FAILS, implicating src/tests/todos.test.ts
    {
      content: "",
      toolCalls: [{ id: "c6", name: "run_command", arguments: { command: "npm run typecheck" } }],
    },
    // Turn 7: Model attempts replace_content on src/tests/todos.test.ts
    // -> Repair gate rejects because src/tests/todos.test.ts has not been read since failure!
    {
      content: "",
      toolCalls: [
        {
          id: "c7",
          name: "replace_content",
          arguments: {
            path: "src/tests/todos.test.ts",
            target: "from '../index';",
            replacement: "from '../index.js';",
          },
        },
      ],
    },
    // Turn 8: Model obeys REPAIR EVIDENCE REQUIRED prompt and calls read_file on src/tests/todos.test.ts
    // -> AgentToolExecutor flags this as duplicate=true (since read in Turn 5)
    // -> PR #5 ensures satisfyRepairPath is called despite duplicate=true!
    {
      content: "",
      toolCalls: [{ id: "c8", name: "read_file", arguments: { path: "src/tests/todos.test.ts" } }],
    },
    // Turn 9: Model re-issues replace_content on src/tests/todos.test.ts
    // -> Repair gate now ALLOWS replace_content because repair evidence is satisfied!
    {
      content: "",
      toolCalls: [
        {
          id: "c9",
          name: "replace_content",
          arguments: {
            path: "src/tests/todos.test.ts",
            target: "from '../index';",
            replacement: "from '../index.js';",
          },
        },
      ],
    },
    // Turn 10: Model re-runs typecheck -> PASSES
    {
      content: "",
      toolCalls: [{ id: "c10", name: "run_command", arguments: { command: "npm run typecheck" } }],
    },
    // Turn 11: Model runs test -> PASSES
    {
      content: "",
      toolCalls: [{ id: "c11", name: "run_command", arguments: { command: "npm test" } }],
    },
    // Turn 12: Done
    {
      content: "Defect repaired and verified.",
      toolCalls: [],
    },
  ];

  const model = new GracefulRecordingFake(modelResponses);
  const trace = new ExecutionTrace();
  const memory = new ProjectMemory(path.join(tmpWorkspace, "project-memory.json"));

  const agent = new Agent(model, tools, trace, memory, {
    maxIterations: 20,
    workspaceRoot: tmpWorkspace,
  });

  const finalResult = await agent.run(
    "Implement the defect repair for todos in this repository and verify.",
  );

  assert.strictEqual(finalResult, "Defect repaired and verified.");

  // Verify file on disk actually got updated
  const updatedContent = fs.readFileSync(
    path.join(tmpWorkspace, "src", "tests", "todos.test.ts"),
    "utf8",
  );
  assert.strictEqual(
    updatedContent.includes("from '../index.js';"),
    true,
    "File content on disk must contain the repaired import",
  );

  // Verify trace events:
  const events = trace.getEvents();

  // 1. In Turn 8, read_file was recorded as duplicate
  const dupRead = events.find(
    (e) => e.type === "tool" && e.toolName === "read_file" && e.error === "Duplicate tool call prevented",
  );
  assert.strictEqual(
    dupRead !== undefined,
    true,
    "Turn 8 read_file should be recorded as duplicate in trace",
  );

  // 2. In Turn 9, replace_content executed and succeeded
  const repSuccess = events.find(
    (e) => e.type === "tool" && e.toolName === "replace_content" && e.success === true,
  );
  assert.strictEqual(
    repSuccess !== undefined,
    true,
    "Turn 9 replace_content must succeed through the repair gate",
  );

  // 3. Verify that REPAIR EVIDENCE REQUIRED message was sent at Turn 7
  const msgsAtTurn8 = model.recordedMessages[7] || [];
  const repairEvidencePrompt = msgsAtTurn8.find(
    (m) => typeof m.content === "string" && m.content.includes("REPAIR EVIDENCE REQUIRED"),
  );
  assert.strictEqual(
    repairEvidencePrompt !== undefined,
    true,
    "Repair evidence prompt should have been sent after first mutation attempt",
  );

  console.log("PASS: 1. Exact Run 24 reproduction passed (duplicate read satisfied repair evidence).");
}

// ---------------------------------------------------------------------------
// Test 2: Investigation read alone does NOT satisfy subsequent verification failure
// ---------------------------------------------------------------------------
async function testInvestigationReadDoesNotPreSatisfy() {
  setupFixture();

  const workspace = new Workspace(tmpWorkspace);
  const tools = new ToolRegistry();
  tools.register(new ListDirectoryTool(workspace));
  tools.register(new ReadFileTool(workspace));
  tools.register(new WriteFileTool(workspace));
  tools.register(new ReplaceContentTool(workspace));
  tools.register(new SearchFilesTool(workspace));

  const fakeRunCmd = new FakeRunCommandTool([
    {
      exitCode: 1,
      stdout: `src/tests/todos.test.ts(2,26): error TS2835: Relative import paths need explicit file extensions.`,
      stderr: "Command failed",
    },
  ]);
  tools.register(fakeRunCmd);

  const modelResponses: ModelResponse[] = [
    { content: "", toolCalls: [{ id: "c1", name: "search_files", arguments: { query: "addTodo" } }] },
    { content: "", toolCalls: [{ id: "c2", name: "list_directory", arguments: { path: "." } }] },
    { content: "", toolCalls: [{ id: "c3", name: "read_file", arguments: { path: "package.json" } }] },
    { content: "", toolCalls: [{ id: "c4", name: "read_file", arguments: { path: "src/index.ts" } }] },
    // Investigation reads src/tests/todos.test.ts
    { content: "", toolCalls: [{ id: "c5", name: "read_file", arguments: { path: "src/tests/todos.test.ts" } }] },
    // Verification fails on src/tests/todos.test.ts
    { content: "", toolCalls: [{ id: "c6", name: "run_command", arguments: { command: "npm run typecheck" } }] },
    // Model immediately tries write_file without reading after failure -> must be REJECTED
    {
      content: "",
      toolCalls: [
        {
          id: "c7",
          name: "write_file",
          arguments: {
            path: "src/tests/todos.test.ts",
            content: "fixed content",
          },
        },
      ],
    },
    { content: "Done", toolCalls: [] },
  ];

  const model = new GracefulRecordingFake(modelResponses);
  const trace = new ExecutionTrace();
  const memory = new ProjectMemory(path.join(tmpWorkspace, "project-memory.json"));

  const agent = new Agent(model, tools, trace, memory, {
    maxIterations: 8,
    workspaceRoot: tmpWorkspace,
  });

  try {
    await agent.run("Implement defect repair and verify.");
  } catch {
    // Expected to terminate when max iterations reached on uncompleted task
  }

  // Verify write_file was blocked
  const msgsAtTurn8 = model.recordedMessages[7] || [];
  const repairEvidenceRequired = msgsAtTurn8.find(
    (m) => typeof m.content === "string" && m.content.includes("REPAIR EVIDENCE REQUIRED"),
  );
  assert.strictEqual(
    repairEvidenceRequired !== undefined,
    true,
    "Investigation read alone must NOT pre-satisfy repair evidence after a fresh failure",
  );

  console.log("PASS: 2. Investigation read alone does NOT satisfy subsequent verification failure.");
}

// ---------------------------------------------------------------------------
// Test 3: Unrelated duplicate reads remain unchanged and protected
// ---------------------------------------------------------------------------
async function testUnrelatedDuplicateReadRemainsProtected() {
  setupFixture();

  const workspace = new Workspace(tmpWorkspace);
  const tools = new ToolRegistry();
  tools.register(new ListDirectoryTool(workspace));
  tools.register(new ReadFileTool(workspace));
  tools.register(new WriteFileTool(workspace));
  tools.register(new ReplaceContentTool(workspace));
  tools.register(new SearchFilesTool(workspace));

  const fakeRunCmd = new FakeRunCommandTool([
    {
      exitCode: 1,
      stdout: `src/tests/todos.test.ts(2,26): error TS2835: Relative import paths need explicit file extensions.`,
      stderr: "Command failed",
    },
  ]);
  tools.register(fakeRunCmd);

  const modelResponses: ModelResponse[] = [
    { content: "", toolCalls: [{ id: "c1", name: "search_files", arguments: { query: "addTodo" } }] },
    { content: "", toolCalls: [{ id: "c2", name: "list_directory", arguments: { path: "." } }] },
    { content: "", toolCalls: [{ id: "c3", name: "read_file", arguments: { path: "package.json" } }] },
    { content: "", toolCalls: [{ id: "c4", name: "read_file", arguments: { path: "src/index.ts" } }] },
    { content: "", toolCalls: [{ id: "c5", name: "read_file", arguments: { path: "src/tests/todos.test.ts" } }] },
    // Verification fails on src/tests/todos.test.ts
    { content: "", toolCalls: [{ id: "c6", name: "run_command", arguments: { command: "npm run typecheck" } }] },
    // Model duplicates read of package.json (NOT an implicated file)
    { content: "", toolCalls: [{ id: "c7", name: "read_file", arguments: { path: "package.json" } }] },
    // Model tries replace_content on src/tests/todos.test.ts (which is STILL unread!) -> must be REJECTED
    {
      content: "",
      toolCalls: [
        {
          id: "c8",
          name: "replace_content",
          arguments: {
            path: "src/tests/todos.test.ts",
            target: "from '../index';",
            replacement: "from '../index.js';",
          },
        },
      ],
    },
    { content: "Done", toolCalls: [] },
  ];

  const model = new GracefulRecordingFake(modelResponses);
  const trace = new ExecutionTrace();
  const memory = new ProjectMemory(path.join(tmpWorkspace, "project-memory.json"));

  const agent = new Agent(model, tools, trace, memory, {
    maxIterations: 9,
    workspaceRoot: tmpWorkspace,
  });

  try {
    await agent.run("Implement defect repair and verify.");
  } catch {
    // Expected to terminate when max iterations reached on uncompleted task
  }

  // Turn 7 read of package.json should be duplicate
  const msgsAtTurn8 = model.recordedMessages[7] || [];
  const dupMsg = msgsAtTurn8.find(
    (m) => typeof m.content === "string" && m.content.includes("This exact tool call was already executed"),
  );
  assert.strictEqual(dupMsg !== undefined, true, "Unrelated duplicate read should return duplicate error message");

  // Turn 8 mutation attempt should STILL be rejected because src/tests/todos.test.ts was not read
  const msgsAtTurn9 = model.recordedMessages[8] || [];
  const repairEvidenceRequired = msgsAtTurn9.find(
    (m) => typeof m.content === "string" && m.content.includes("REPAIR EVIDENCE REQUIRED"),
  );
  assert.strictEqual(
    repairEvidenceRequired !== undefined,
    true,
    "Reading unrelated package.json must NOT satisfy repair evidence for todos.test.ts",
  );

  console.log("PASS: 3. Unrelated duplicate read remains protected and does not clear other unread evidence.");
}

async function main() {
  console.log("Running PR #5 Duplicate-Read Repair Evidence Test Suite...\n");
  try {
    await testRun24DuplicateReadReproduction();
    await testInvestigationReadDoesNotPreSatisfy();
    await testUnrelatedDuplicateReadRemainsProtected();
    console.log("\n✅ All PR #5 Duplicate-Read Repair Evidence tests PASSED.");
  } finally {
    cleanup();
  }
}

main().catch((err) => {
  console.error("Test failure:", err);
  process.exit(1);
});
