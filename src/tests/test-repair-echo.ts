/**
 * test-repair-echo.ts
 *
 * Deterministic tests verifying the Approach D "repair echo" embedded in the
 * REPAIR EVIDENCE REQUIRED rejection message (Agent.ts).
 *
 * The repair-evidence gate blocks write_file / replace_content when the
 * verification failure has implicated files that have not yet been read.
 * These tests confirm the gate rejection message:
 *
 *  1. write_file rejected by repair gate includes the implicated path.
 *  2. replace_content rejected by repair gate includes the implicated path.
 *  3. Rejection explicitly states the attempted mutation was NOT executed.
 *  4. Rejection instructs the model to read the required file first and
 *     re-issue the repair before running any verification command.
 *  5. Non-mutation tool rejections (duplicate investigation calls) are
 *     NOT given a repair echo.
 *  6. Content blobs from write_file are NOT echoed — echo is bounded to path.
 *  7. Graceful degradation when no path field exists in the rejected call.
 */

import { Agent } from "../agent/Agent.js";
import { ProjectMemory } from "../memory/ProjectMemory.js";
import { ExecutionTrace } from "../observability/ExecutionTrace.js";
import { ToolRegistry } from "../tools/ToolRegistry.js";
import { ReadFileTool } from "../tools/ReadFileTool.js";
import { SearchFilesTool } from "../tools/SearchFilesTool.js";
import { ListDirectoryTool } from "../tools/ListDirectoryTool.js";
import { WriteFileTool } from "../tools/WriteFileTool.js";
import { ReplaceContentTool } from "../tools/ReplaceContentTool.js";
import { Workspace } from "../workspace/Workspace.js";
import { FakeModelProvider } from "./fakes/FakeModelProvider.js";
import { FakeRunCommandTool } from "./fakes/FakeRunCommandTool.js";
import type { Message, ToolDefinition } from "../models/types.js";
import * as fs from "node:fs";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Workspace helpers
// ---------------------------------------------------------------------------

const WORKSPACE_DIR = path.resolve("./tmp-test-repair-echo");

function setupWorkspace() {
  if (fs.existsSync(WORKSPACE_DIR)) {
    fs.rmSync(WORKSPACE_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(path.join(WORKSPACE_DIR, "src", "tests"), { recursive: true });
  fs.writeFileSync(
    path.join(WORKSPACE_DIR, "package.json"),
    JSON.stringify(
      {
        name: "repair-echo-test-ws",
        type: "module",
        scripts: { test: "node --test", typecheck: "tsc --noEmit" },
      },
      null,
      2,
    ),
  );
  // Pre-create both files so that implicated-path existence checks pass
  fs.writeFileSync(
    path.join(WORKSPACE_DIR, "src", "todos.ts"),
    `export function add(): void {}\n`,
  );
  fs.writeFileSync(
    path.join(WORKSPACE_DIR, "src", "tests", "todos.test.ts"),
    `import { add } from '../todos';\nadd();\n`,
  );
}

function cleanupWorkspace() {
  if (fs.existsSync(WORKSPACE_DIR)) {
    fs.rmSync(WORKSPACE_DIR, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Fake that records every user-role message content
// ---------------------------------------------------------------------------

class MessageCapturingFake extends FakeModelProvider {
  public capturedUserMessages: string[] = [];

  override async generate(messages: Message[], toolsDef: ToolDefinition[]) {
    for (const m of messages) {
      if (m.role === "user" && typeof m.content === "string") {
        this.capturedUserMessages.push(m.content);
      }
    }
    return super.generate(messages, toolsDef);
  }
}

// ---------------------------------------------------------------------------
// Standard investigation sequence (all 5 evidence categories)
// ---------------------------------------------------------------------------

function investigationSequence() {
  return [
    {
      content: "",
      toolCalls: [
        { id: "s1", name: "search_files", arguments: { query: "todos" } },
      ],
    },
    {
      content: "",
      toolCalls: [
        { id: "l1", name: "list_directory", arguments: { path: "." } },
      ],
    },
    {
      content: "",
      toolCalls: [
        { id: "r1", name: "read_file", arguments: { path: "package.json" } },
      ],
    },
    {
      content: "",
      toolCalls: [
        { id: "r2", name: "read_file", arguments: { path: "src/todos.ts" } },
      ],
    },
    {
      content: "",
      toolCalls: [
        {
          id: "r3",
          name: "read_file",
          arguments: { path: "src/tests/todos.test.ts" },
        },
      ],
    },
  ];
}

function makeTools(
  fakeRunCmd: FakeRunCommandTool,
  includeReplaceContent = false,
): ToolRegistry {
  const workspace = new Workspace(WORKSPACE_DIR);
  const tools = new ToolRegistry();
  tools.register(new ListDirectoryTool(workspace));
  tools.register(new ReadFileTool(workspace));
  tools.register(new SearchFilesTool(workspace));
  tools.register(new WriteFileTool(workspace));
  if (includeReplaceContent) {
    tools.register(new ReplaceContentTool(workspace));
  }
  tools.register(fakeRunCmd);
  return tools;
}

function makeAgent(model: FakeModelProvider, tools: ToolRegistry): Agent {
  const trace = new ExecutionTrace();
  const memory = new ProjectMemory(
    path.join(WORKSPACE_DIR, "project-memory.json"),
  );
  return new Agent(model, tools, trace, memory, {
    maxIterations: 30,
    workspaceRoot: WORKSPACE_DIR,
  });
}

// ---------------------------------------------------------------------------
// Test 1: write_file rejected — rejection message includes the implicated path
//
// The gate implicates TEST_FILE.  The model immediately attempts write_file on
// TEST_FILE without reading it first.  The gate must reject that write and
// include TEST_FILE in the rejection message.
// ---------------------------------------------------------------------------

async function testWriteFileRejectionIncludesPath() {
  setupWorkspace();
  const IMPL = "src/todos.ts";
  const TEST_FILE = "src/tests/todos.test.ts";

  const fakeRunCmd = new FakeRunCommandTool([
    // First npm test run: fails, implicating TEST_FILE by absolute path
    {
      exitCode: 1,
      stdout: `Error: Cannot find module imported from ${path.join(WORKSPACE_DIR, TEST_FILE)}`,
      stderr: "Command failed",
    },
    // Second npm test (after repair)
    { exitCode: 0, stdout: "ok - all pass", stderr: "" },
    // Typecheck
    { exitCode: 0, stdout: "typecheck clean", stderr: "" },
  ]);

  const model = new MessageCapturingFake([
    ...investigationSequence(),

    // Write impl file (allowed — no pending evidence)
    {
      content: "",
      toolCalls: [
        {
          id: "w1",
          name: "write_file",
          arguments: { path: IMPL, content: "export function add(): void {}\n" },
        },
      ],
    },

    // Run npm test → FAILS; gate records TEST_FILE as unread repair path
    {
      content: "",
      toolCalls: [
        { id: "c1", name: "run_command", arguments: { command: "npm test" } },
      ],
    },

    // Immediately attempt write_file on TEST_FILE without reading it → REJECTED
    {
      content: "",
      toolCalls: [
        {
          id: "w2",
          name: "write_file",
          arguments: {
            path: TEST_FILE,
            content: "import { add } from '../todos.js';\nadd();\n",
          },
        },
      ],
    },

    // Model should now read TEST_FILE to satisfy the gate
    {
      content: "",
      toolCalls: [
        { id: "r4", name: "read_file", arguments: { path: TEST_FILE } },
      ],
    },

    // Re-issue write after gate clears
    {
      content: "",
      toolCalls: [
        {
          id: "w3",
          name: "write_file",
          arguments: {
            path: TEST_FILE,
            content: "import { add } from '../todos.js';\nadd();\n",
          },
        },
      ],
    },

    {
      content: "",
      toolCalls: [
        { id: "c2", name: "run_command", arguments: { command: "npm test" } },
      ],
    },
    {
      content: "",
      toolCalls: [
        { id: "c3", name: "run_command", arguments: { command: "npm run typecheck" } },
      ],
    },
    { content: "Done.", toolCalls: [] },
  ]);

  const tools = makeTools(fakeRunCmd);
  const agent = makeAgent(model, tools);

  try {
    await agent.run("Build and fix todo imports");
  } finally {
    cleanupWorkspace();
  }

  // Find the REPAIR EVIDENCE REQUIRED rejection that mentions the repair gate
  const rejectionMsg = model.capturedUserMessages.find(
    (m) =>
      m.includes("REPAIR EVIDENCE REQUIRED") &&
      m.includes("write_file"),
  );
  if (!rejectionMsg) {
    throw new Error(
      "FAIL Test 1: No REPAIR EVIDENCE REQUIRED message mentioning write_file found",
    );
  }

  // The rejected path (TEST_FILE) must appear in the echo
  if (!rejectionMsg.includes(TEST_FILE)) {
    throw new Error(
      `FAIL Test 1: Rejection message does not include the attempted write_file path (${TEST_FILE}).\nMessage was:\n${rejectionMsg}`,
    );
  }

  // Also the implicated path list must appear
  if (!rejectionMsg.includes(TEST_FILE)) {
    throw new Error(
      `FAIL Test 1: Rejection message does not list the implicated path (${TEST_FILE})`,
    );
  }

  console.log(
    "PASS Test 1: write_file rejection includes the implicated path and the attempted path",
  );
}

// ---------------------------------------------------------------------------
// Test 2: replace_content rejected — rejection message includes the implicated path
// ---------------------------------------------------------------------------

async function testReplaceContentRejectionIncludesPath() {
  setupWorkspace();
  const IMPL = "src/todos.ts";
  const TEST_FILE = "src/tests/todos.test.ts";

  const fakeRunCmd = new FakeRunCommandTool([
    {
      exitCode: 1,
      stdout: `${path.join(WORKSPACE_DIR, TEST_FILE)}(1,22): error TS2835`,
      stderr: "Command failed",
    },
    { exitCode: 0, stdout: "ok - all pass", stderr: "" },
    { exitCode: 0, stdout: "typecheck clean", stderr: "" },
  ]);

  // The test file contains the exact target string to enable replace_content
  fs.writeFileSync(
    path.join(WORKSPACE_DIR, TEST_FILE),
    `import { add } from '../todos';\nadd();\n`,
  );

  const model = new MessageCapturingFake([
    ...investigationSequence(),

    {
      content: "",
      toolCalls: [
        {
          id: "w1",
          name: "write_file",
          arguments: { path: IMPL, content: "export function add(): void {}\n" },
        },
      ],
    },

    // Run typecheck → FAILS; implicates TEST_FILE
    {
      content: "",
      toolCalls: [
        { id: "c1", name: "run_command", arguments: { command: "npm run typecheck" } },
      ],
    },

    // Immediately attempt replace_content on TEST_FILE without reading it → REJECTED
    {
      content: "",
      toolCalls: [
        {
          id: "rc1",
          name: "replace_content",
          arguments: {
            path: TEST_FILE,
            target: "import { add } from '../todos';",
            replacement: "import { add } from '../todos.js';",
          },
        },
      ],
    },

    // Read TEST_FILE to satisfy gate
    {
      content: "",
      toolCalls: [
        { id: "r4", name: "read_file", arguments: { path: TEST_FILE } },
      ],
    },

    // Re-issue replace_content after gate clears
    {
      content: "",
      toolCalls: [
        {
          id: "rc2",
          name: "replace_content",
          arguments: {
            path: TEST_FILE,
            target: "import { add } from '../todos';",
            replacement: "import { add } from '../todos.js';",
          },
        },
      ],
    },

    {
      content: "",
      toolCalls: [
        { id: "c2", name: "run_command", arguments: { command: "npm run typecheck" } },
      ],
    },
    {
      content: "",
      toolCalls: [
        { id: "c3", name: "run_command", arguments: { command: "npm test" } },
      ],
    },
    { content: "Done.", toolCalls: [] },
  ]);

  const tools = makeTools(fakeRunCmd, /* includeReplaceContent */ true);
  const agent = makeAgent(model, tools);

  try {
    await agent.run("Build and fix todo imports");
  } finally {
    cleanupWorkspace();
  }

  const rejectionMsg = model.capturedUserMessages.find(
    (m) =>
      m.includes("REPAIR EVIDENCE REQUIRED") &&
      m.includes("replace_content"),
  );
  if (!rejectionMsg) {
    throw new Error(
      `FAIL Test 2: No REPAIR EVIDENCE REQUIRED message containing tool name 'replace_content' found`,
    );
  }

  if (!rejectionMsg.includes(TEST_FILE)) {
    throw new Error(
      `FAIL Test 2: Rejection message does not echo the attempted replace_content path (${TEST_FILE}).\nMessage:\n${rejectionMsg}`,
    );
  }

  console.log("PASS Test 2: replace_content rejection includes the implicated path");
}

// ---------------------------------------------------------------------------
// Test 3: Rejection explicitly states the attempted mutation was NOT executed
// ---------------------------------------------------------------------------

async function testRejectionStatesNotExecuted() {
  setupWorkspace();
  const IMPL = "src/todos.ts";
  const TEST_FILE = "src/tests/todos.test.ts";

  const fakeRunCmd = new FakeRunCommandTool([
    {
      exitCode: 1,
      stdout: `Error imported from ${path.join(WORKSPACE_DIR, TEST_FILE)}`,
      stderr: "Command failed",
    },
    { exitCode: 0, stdout: "ok - all pass", stderr: "" },
    { exitCode: 0, stdout: "typecheck clean", stderr: "" },
  ]);

  const model = new MessageCapturingFake([
    ...investigationSequence(),
    {
      content: "",
      toolCalls: [
        {
          id: "w1",
          name: "write_file",
          arguments: { path: IMPL, content: "export function add(): void {}\n" },
        },
      ],
    },
    {
      content: "",
      toolCalls: [
        { id: "c1", name: "run_command", arguments: { command: "npm test" } },
      ],
    },
    // Blind write on TEST_FILE → REJECTED
    {
      content: "",
      toolCalls: [
        {
          id: "w2",
          name: "write_file",
          arguments: {
            path: TEST_FILE,
            content: "import { add } from '../todos.js';\nadd();\n",
          },
        },
      ],
    },
    {
      content: "",
      toolCalls: [
        { id: "r4", name: "read_file", arguments: { path: TEST_FILE } },
      ],
    },
    {
      content: "",
      toolCalls: [
        {
          id: "w3",
          name: "write_file",
          arguments: {
            path: TEST_FILE,
            content: "import { add } from '../todos.js';\nadd();\n",
          },
        },
      ],
    },
    {
      content: "",
      toolCalls: [
        { id: "c2", name: "run_command", arguments: { command: "npm test" } },
      ],
    },
    {
      content: "",
      toolCalls: [
        { id: "c3", name: "run_command", arguments: { command: "npm run typecheck" } },
      ],
    },
    { content: "Done.", toolCalls: [] },
  ]);

  const tools = makeTools(fakeRunCmd);
  const agent = makeAgent(model, tools);

  try {
    await agent.run("Build and fix todos");
  } finally {
    cleanupWorkspace();
  }

  const rejectionMsg = model.capturedUserMessages.find(
    (m) =>
      m.includes("REPAIR EVIDENCE REQUIRED") &&
      m.includes("was NOT executed"),
  );
  if (!rejectionMsg) {
    throw new Error(
      "FAIL Test 3: Rejection message does not explicitly state 'was NOT executed'",
    );
  }

  console.log(
    "PASS Test 3: Rejection explicitly states the attempted mutation was NOT executed",
  );
}

// ---------------------------------------------------------------------------
// Test 4: Rejection instructs: read required file first, then re-issue repair,
//         do NOT run verification until repair is applied
// ---------------------------------------------------------------------------

async function testRejectionInstructsReadThenReissue() {
  setupWorkspace();
  const IMPL = "src/todos.ts";
  const TEST_FILE = "src/tests/todos.test.ts";

  const fakeRunCmd = new FakeRunCommandTool([
    {
      exitCode: 1,
      stdout: `Error imported from ${path.join(WORKSPACE_DIR, TEST_FILE)}`,
      stderr: "Command failed",
    },
    { exitCode: 0, stdout: "ok - all pass", stderr: "" },
    { exitCode: 0, stdout: "typecheck clean", stderr: "" },
  ]);

  const model = new MessageCapturingFake([
    ...investigationSequence(),
    {
      content: "",
      toolCalls: [
        {
          id: "w1",
          name: "write_file",
          arguments: { path: IMPL, content: "export function add(): void {}\n" },
        },
      ],
    },
    {
      content: "",
      toolCalls: [
        { id: "c1", name: "run_command", arguments: { command: "npm test" } },
      ],
    },
    // Blind write on TEST_FILE → REJECTED
    {
      content: "",
      toolCalls: [
        {
          id: "w2",
          name: "write_file",
          arguments: {
            path: TEST_FILE,
            content: "import { add } from '../todos.js';\nadd();\n",
          },
        },
      ],
    },
    {
      content: "",
      toolCalls: [
        { id: "r4", name: "read_file", arguments: { path: TEST_FILE } },
      ],
    },
    {
      content: "",
      toolCalls: [
        {
          id: "w3",
          name: "write_file",
          arguments: {
            path: TEST_FILE,
            content: "import { add } from '../todos.js';\nadd();\n",
          },
        },
      ],
    },
    {
      content: "",
      toolCalls: [
        { id: "c2", name: "run_command", arguments: { command: "npm test" } },
      ],
    },
    {
      content: "",
      toolCalls: [
        { id: "c3", name: "run_command", arguments: { command: "npm run typecheck" } },
      ],
    },
    { content: "Done.", toolCalls: [] },
  ]);

  const tools = makeTools(fakeRunCmd);
  const agent = makeAgent(model, tools);

  try {
    await agent.run("Build and fix todos");
  } finally {
    cleanupWorkspace();
  }

  const rejectionMsg = model.capturedUserMessages.find(
    (m) => m.includes("REPAIR EVIDENCE REQUIRED"),
  );
  if (!rejectionMsg) {
    throw new Error("FAIL Test 4: No REPAIR EVIDENCE REQUIRED message found");
  }

  // Must contain re-issue instruction
  const hasReissueInstruction =
    rejectionMsg.includes("re-issue") ||
    rejectionMsg.includes("re-execute") ||
    rejectionMsg.includes("MUST") ||
    rejectionMsg.includes("must");
  if (!hasReissueInstruction) {
    throw new Error(
      `FAIL Test 4: Rejection message lacks a re-issue instruction.\nMessage:\n${rejectionMsg}`,
    );
  }

  // Must contain no-verification-before-repair directive
  const hasNoVerifyDirective =
    rejectionMsg.includes("Do NOT run verification") ||
    rejectionMsg.includes("before running any verification") ||
    rejectionMsg.includes("until after the repair");
  if (!hasNoVerifyDirective) {
    throw new Error(
      `FAIL Test 4: Rejection message lacks the no-verify-before-repair directive.\nMessage:\n${rejectionMsg}`,
    );
  }

  console.log("PASS Test 4: Rejection instructs read → re-issue repair → then verify");
}

// ---------------------------------------------------------------------------
// Test 5: Non-mutation tool rejections do NOT carry a repair echo
// ---------------------------------------------------------------------------

async function testNonMutationRejectionUnchanged() {
  setupWorkspace();

  // No verification failures — gate is never triggered.
  // The model repeats a list_directory call (duplicate investigation) which is
  // rejected by the investigation policy, NOT the repair gate.
  const fakeRunCmd = new FakeRunCommandTool([
    { exitCode: 0, stdout: "ok - all pass", stderr: "" },
    { exitCode: 0, stdout: "typecheck clean", stderr: "" },
  ]);

  const IMPL = "src/todos.ts";
  const TEST_FILE = "src/tests/todos.test.ts";

  const model = new MessageCapturingFake([
    ...investigationSequence(),

    // Repeat list_directory (identical call) → investigation-duplicate rejection
    {
      content: "",
      toolCalls: [
        { id: "l2", name: "list_directory", arguments: { path: "." } },
      ],
    },

    // Write and verify successfully
    {
      content: "",
      toolCalls: [
        {
          id: "w1",
          name: "write_file",
          arguments: { path: IMPL, content: "export function add(): void {}\n" },
        },
        {
          id: "w2",
          name: "write_file",
          arguments: {
            path: TEST_FILE,
            content: "import { add } from '../todos.js';\nadd();\n",
          },
        },
      ],
    },
    {
      content: "",
      toolCalls: [
        { id: "c1", name: "run_command", arguments: { command: "npm test" } },
      ],
    },
    {
      content: "",
      toolCalls: [
        { id: "c2", name: "run_command", arguments: { command: "npm run typecheck" } },
      ],
    },
    { content: "Done.", toolCalls: [] },
  ]);

  const tools = makeTools(fakeRunCmd);
  const agent = makeAgent(model, tools);

  try {
    await agent.run("Build todos");
  } finally {
    cleanupWorkspace();
  }

  // The repair echo phrase must NOT appear in any message when the gate was never triggered
  const hasSpuriousEcho = model.capturedUserMessages.some(
    (m) => m.includes("was NOT executed"),
  );
  if (hasSpuriousEcho) {
    throw new Error(
      "FAIL Test 5: Repair echo 'was NOT executed' appeared in a non-gate-rejection message",
    );
  }

  console.log(
    "PASS Test 5: Non-mutation rejections do not carry a spurious repair echo",
  );
}

// ---------------------------------------------------------------------------
// Test 6: Content blobs from write_file are NOT echoed — echo is bounded to path
// ---------------------------------------------------------------------------

async function testEchoIsBoundedToPathOnly() {
  setupWorkspace();
  const IMPL = "src/todos.ts";
  const TEST_FILE = "src/tests/todos.test.ts";

  const LARGE_CONTENT = "x".repeat(3000); // 3 KB blob — must not appear in echo

  const fakeRunCmd = new FakeRunCommandTool([
    {
      exitCode: 1,
      stdout: `Error imported from ${path.join(WORKSPACE_DIR, TEST_FILE)}`,
      stderr: "Command failed",
    },
    { exitCode: 0, stdout: "ok - all pass", stderr: "" },
    { exitCode: 0, stdout: "typecheck clean", stderr: "" },
  ]);

  const model = new MessageCapturingFake([
    ...investigationSequence(),
    {
      content: "",
      toolCalls: [
        {
          id: "w1",
          name: "write_file",
          arguments: { path: IMPL, content: "export function add(): void {}\n" },
        },
      ],
    },
    {
      content: "",
      toolCalls: [
        { id: "c1", name: "run_command", arguments: { command: "npm test" } },
      ],
    },
    // Blind write on TEST_FILE with a large content blob → REJECTED
    {
      content: "",
      toolCalls: [
        {
          id: "w2",
          name: "write_file",
          arguments: { path: TEST_FILE, content: LARGE_CONTENT },
        },
      ],
    },
    {
      content: "",
      toolCalls: [
        { id: "r4", name: "read_file", arguments: { path: TEST_FILE } },
      ],
    },
    {
      content: "",
      toolCalls: [
        {
          id: "w3",
          name: "write_file",
          arguments: {
            path: TEST_FILE,
            content: "import { add } from '../todos.js';\nadd();\n",
          },
        },
      ],
    },
    {
      content: "",
      toolCalls: [
        { id: "c2", name: "run_command", arguments: { command: "npm test" } },
      ],
    },
    {
      content: "",
      toolCalls: [
        { id: "c3", name: "run_command", arguments: { command: "npm run typecheck" } },
      ],
    },
    { content: "Done.", toolCalls: [] },
  ]);

  const tools = makeTools(fakeRunCmd);
  const agent = makeAgent(model, tools);

  try {
    await agent.run("Build and fix todos");
  } finally {
    cleanupWorkspace();
  }

  const rejectionMsg = model.capturedUserMessages.find(
    (m) => m.includes("REPAIR EVIDENCE REQUIRED"),
  );
  if (!rejectionMsg) {
    throw new Error("FAIL Test 6: No rejection message found");
  }

  // The 3 KB blob must NOT appear verbatim
  if (rejectionMsg.includes(LARGE_CONTENT)) {
    throw new Error(
      "FAIL Test 6: Content blob from write_file was echoed verbatim in the rejection message",
    );
  }

  // The path must appear
  if (!rejectionMsg.includes(TEST_FILE)) {
    throw new Error(
      `FAIL Test 6: The attempted write_file path (${TEST_FILE}) is missing from the echo`,
    );
  }

  console.log("PASS Test 6: Echo is bounded to path only — content blobs not echoed");
}

// ---------------------------------------------------------------------------
// Test 7: Graceful degradation — echo still appears even when toolCall.arguments
//         has no 'path' field (malformed call)
// ---------------------------------------------------------------------------

async function testEchoGracefulDegradationNoPath() {
  setupWorkspace();
  const IMPL = "src/todos.ts";
  const TEST_FILE = "src/tests/todos.test.ts";

  const fakeRunCmd = new FakeRunCommandTool([
    {
      exitCode: 1,
      stdout: `Error imported from ${path.join(WORKSPACE_DIR, TEST_FILE)}`,
      stderr: "Command failed",
    },
    { exitCode: 0, stdout: "ok - all pass", stderr: "" },
    { exitCode: 0, stdout: "typecheck clean", stderr: "" },
  ]);

  const model = new MessageCapturingFake([
    ...investigationSequence(),
    {
      content: "",
      toolCalls: [
        {
          id: "w1",
          name: "write_file",
          arguments: { path: IMPL, content: "export function add(): void {}\n" },
        },
      ],
    },
    {
      content: "",
      toolCalls: [
        { id: "c1", name: "run_command", arguments: { command: "npm test" } },
      ],
    },
    // write_file with NO path key (malformed) — gate still rejects
    {
      content: "",
      toolCalls: [
        {
          id: "w2",
          name: "write_file",
          // Intentionally omit 'path' to exercise the graceful-degradation branch
          arguments: { content: "export function add(): void {}\n" },
        },
      ],
    },
    {
      content: "",
      toolCalls: [
        { id: "r4", name: "read_file", arguments: { path: TEST_FILE } },
      ],
    },
    {
      content: "",
      toolCalls: [
        {
          id: "w3",
          name: "write_file",
          arguments: {
            path: TEST_FILE,
            content: "import { add } from '../todos.js';\nadd();\n",
          },
        },
      ],
    },
    {
      content: "",
      toolCalls: [
        { id: "c2", name: "run_command", arguments: { command: "npm test" } },
      ],
    },
    {
      content: "",
      toolCalls: [
        { id: "c3", name: "run_command", arguments: { command: "npm run typecheck" } },
      ],
    },
    { content: "Done.", toolCalls: [] },
  ]);

  const tools = makeTools(fakeRunCmd);
  const agent = makeAgent(model, tools);

  try {
    await agent.run("Build and fix todos");
  } finally {
    cleanupWorkspace();
  }

  // Even with no path field, the echo phrase "was NOT executed" must appear
  const rejectionMsg = model.capturedUserMessages.find(
    (m) =>
      m.includes("REPAIR EVIDENCE REQUIRED") &&
      m.includes("was NOT executed"),
  );
  if (!rejectionMsg) {
    throw new Error(
      "FAIL Test 7: Expected 'was NOT executed' in the repair echo even without a path field",
    );
  }

  // The re-issue instruction must still be present
  const hasReissue =
    rejectionMsg.includes("re-issue") ||
    rejectionMsg.includes("re-execute") ||
    rejectionMsg.includes("MUST") ||
    rejectionMsg.includes("repair before running");
  if (!hasReissue) {
    throw new Error(
      "FAIL Test 7: Re-issue instruction missing in graceful-degradation path-less echo",
    );
  }

  console.log(
    "PASS Test 7: Graceful degradation — echo appears even without a path field",
  );
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

await testWriteFileRejectionIncludesPath();
await testReplaceContentRejectionIncludesPath();
await testRejectionStatesNotExecuted();
await testRejectionInstructsReadThenReissue();
await testNonMutationRejectionUnchanged();
await testEchoIsBoundedToPathOnly();
await testEchoGracefulDegradationNoPath();

console.log("\nAll 7 repair-echo tests PASSED.");
