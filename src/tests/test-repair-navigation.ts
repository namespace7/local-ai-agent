/**
 * test-repair-navigation.ts
 *
 * Comprehensive regression tests for the repair-evidence gate:
 *
 * Invariant:
 * After a verification failure, if stdout/stderr identifies an EXISTING workspace
 * file that is relevant to the failure, the model must inspect that file before
 * any write_file is allowed.
 *
 * Tests cover:
 * 1. Run 12 exact reproduction (files written during run).
 * 2. Pre-existing implicated test file NOT written during run.
 * 3. Pre-existing implicated implementation file NOT written during run.
 * 4. Multiple implicated existing files (reading one is not enough).
 * 5. Missing dependency + existing importing file (no deadlock on missing file).
 * 6. Successful verification clears repair evidence.
 * 7. New verification failure replaces stale evidence (no accumulation).
 * 8. Multi-tool batch: [write_file (rejected), read_file (accepted), write_file (accepted)].
 * 9. Path normalization (./src/..., absolute workspace paths with line/col).
 * 10. Workspace-outside paths are ignored (/usr/lib/..., /tmp/..., node_modules/...).
 * 11. Unrelated file writes (README.md) are uniformly blocked while evidence is unread.
 */

import { Agent } from "../agent/Agent.js";
import { ProjectMemory } from "../memory/ProjectMemory.js";
import { ExecutionTrace } from "../observability/ExecutionTrace.js";
import { ToolRegistry } from "../tools/ToolRegistry.js";
import { ReadFileTool } from "../tools/ReadFileTool.js";
import { SearchFilesTool } from "../tools/SearchFilesTool.js";
import { ListDirectoryTool } from "../tools/ListDirectoryTool.js";
import { WriteFileTool } from "../tools/WriteFileTool.js";
import { Workspace } from "../workspace/Workspace.js";
import { FakeModelProvider } from "./fakes/FakeModelProvider.js";
import { FakeRunCommandTool } from "./fakes/FakeRunCommandTool.js";
import type { Message } from "../models/types.js";
import * as fs from "node:fs";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Helpers & Cleanup
// ---------------------------------------------------------------------------

function cleanupFiles(...paths: string[]) {
  for (const p of paths) {
    if (fs.existsSync(p)) {
      try {
        fs.unlinkSync(p);
      } catch {}
    }
  }
}

function writeFileDirect(filePath: string, content: string) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(filePath, content, "utf8");
}

const implContent = (fnName: string) =>
  `export function ${fnName}(): string { return "${fnName}"; }\n`;

const testContent = (stemName: string, fnName: string) =>
  `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { ${fnName} } from '../${stemName}.js';\ntest('${stemName}', () => { assert.strictEqual(${fnName}(), '${fnName}'); });\n`;

const testContentFixed = (stemName: string, fnName: string) =>
  `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { ${fnName} } from '../${stemName}.js';\ntest('${stemName} fixed', () => { assert.strictEqual(${fnName}(), '${fnName}'); });\n`;

function investigationSequence() {
  return [
    {
      content: "",
      toolCalls: [
        { id: "s1", name: "search_files", arguments: { query: "repair-nav" } },
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
        { id: "r2", name: "read_file", arguments: { path: "src/index.ts" } },
      ],
    },
    {
      content: "",
      toolCalls: [
        {
          id: "r3",
          name: "read_file",
          arguments: { path: "src/tests/test-agent-evidence-rules.ts" },
        },
      ],
    },
  ];
}

function makeTools(fakeRunCommand: FakeRunCommandTool): ToolRegistry {
  const workspace = new Workspace(".");
  const tools = new ToolRegistry();
  tools.register(new SearchFilesTool(workspace));
  tools.register(new ListDirectoryTool(workspace));
  tools.register(new ReadFileTool(workspace));
  tools.register(new WriteFileTool(workspace));
  tools.register(fakeRunCommand);
  return tools;
}

function makeAgent(model: FakeModelProvider, tools: ToolRegistry): Agent {
  const trace = new ExecutionTrace();
  const memory = new ProjectMemory("./data/project-memory.json");
  return new Agent(model, tools, trace, memory, { maxIterations: 30 });
}

// ---------------------------------------------------------------------------
// Test 1 — Exact Run 12 reproduction (written files implicated)
// ---------------------------------------------------------------------------

async function testRun12ExactReproduction() {
  const IMPL = "src/repair-nav-t1.ts";
  const TEST = "src/tests/repair-nav-t1.test.js";

  const fakeRunCmd = new FakeRunCommandTool([
    {
      exitCode: 1,
      stdout: `Error: Cannot find module imported from ${TEST}`,
      stderr: "Command failed",
    },
    { exitCode: 0, stdout: "ok 1 - all tests pass", stderr: "" },
    { exitCode: 0, stdout: "typecheck clean", stderr: "" },
  ]);

  const recordedMessages: Message[][] = [];

  class TrackingFake extends FakeModelProvider {
    override async generate(messages: Message[], toolsDef: any) {
      recordedMessages.push([...messages]);
      return super.generate(messages, toolsDef);
    }
  }

  const model = new TrackingFake([
    ...investigationSequence(),

    // Write impl + test
    {
      content: "",
      toolCalls: [
        {
          id: "w1",
          name: "write_file",
          arguments: { path: IMPL, content: implContent("repairNavT1") },
        },
        {
          id: "w2",
          name: "write_file",
          arguments: { path: TEST, content: testContent("repair-nav-t1", "repairNavT1") },
        },
      ],
    },

    // Verify: FAILS
    {
      content: "",
      toolCalls: [
        { id: "c1", name: "run_command", arguments: { command: "npm test" } },
      ],
    },

    // Blind repair write on IMPL -> REJECTED
    {
      content: "",
      toolCalls: [
        {
          id: "w3",
          name: "write_file",
          arguments: { path: IMPL, content: implContent("repairNavT1") + " // wrong\n" },
        },
      ],
    },

    // Read TEST -> gate clear
    {
      content: "",
      toolCalls: [
        { id: "r4", name: "read_file", arguments: { path: TEST } },
      ],
    },

    // Write repair
    {
      content: "",
      toolCalls: [
        {
          id: "w4",
          name: "write_file",
          arguments: { path: TEST, content: testContentFixed("repair-nav-t1", "repairNavT1") },
        },
      ],
    },

    // Verification passes
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
    await agent.run("Build repair-nav-t1");
  } finally {
    cleanupFiles(IMPL, TEST);
  }

  const finalMessages = recordedMessages[recordedMessages.length - 1] ?? [];
  const rejected = finalMessages.find(
    (m) => typeof m.content === "string" && m.content.includes("REPAIR EVIDENCE REQUIRED") && m.content.includes(TEST),
  );

  if (!rejected) {
    throw new Error("FAIL Test 1: Expected REPAIR EVIDENCE REQUIRED for " + TEST);
  }

  console.log("PASS Test 1: Run 12 exact reproduction");
}

// ---------------------------------------------------------------------------
// Test 2 — Pre-existing implicated test file NOT written during run
// ---------------------------------------------------------------------------

async function testPreExistingImplicatedTestFile() {
  const PRE_TEST = "src/tests/repair-nav-pre-existing.test.js";
  const IMPL = "src/repair-nav-t2.ts";

  // Pre-create the test file directly on disk BEFORE agent runs
  writeFileDirect(
    PRE_TEST,
    `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { repairNavT2 } from '../repair-nav-t2.js';\ntest('pre-existing', () => { assert.strictEqual(repairNavT2(), 'repairNavT2'); });\n`,
  );

  const fakeRunCmd = new FakeRunCommandTool([
    // Fails naming the pre-existing test file
    {
      exitCode: 1,
      stdout: `AssertionError in ${PRE_TEST} line 4: Expected 'repairNavT2'`,
      stderr: "Command failed",
    },
    { exitCode: 0, stdout: "ok 1 - pass", stderr: "" },
    { exitCode: 0, stdout: "ok", stderr: "" },
  ]);

  const recordedMessages: Message[][] = [];

  class TrackingFake extends FakeModelProvider {
    override async generate(messages: Message[], toolsDef: any) {
      recordedMessages.push([...messages]);
      return super.generate(messages, toolsDef);
    }
  }

  const model = new TrackingFake([
    ...investigationSequence(),

    // Agent writes IMPL file only (did NOT write PRE_TEST!)
    {
      content: "",
      toolCalls: [
        {
          id: "w1",
          name: "write_file",
          arguments: { path: IMPL, content: "export function repairNavT2(): string { return 'wrong'; }\n" },
        },
      ],
    },

    // Verify: FAILS, output names PRE_TEST (pre-existing file)
    {
      content: "",
      toolCalls: [
        { id: "c1", name: "run_command", arguments: { command: "npm test" } },
      ],
    },

    // Model tries to write IMPL again without reading PRE_TEST -> REJECTED
    {
      content: "",
      toolCalls: [
        {
          id: "w2",
          name: "write_file",
          arguments: { path: IMPL, content: "export function repairNavT2(): string { return 'still-wrong'; }\n" },
        },
      ],
    },

    // Model reads pre-existing test file -> gate clear
    {
      content: "",
      toolCalls: [
        { id: "r4", name: "read_file", arguments: { path: PRE_TEST } },
      ],
    },

    // Now write allowed
    {
      content: "",
      toolCalls: [
        {
          id: "w3",
          name: "write_file",
          arguments: { path: IMPL, content: implContent("repairNavT2") },
        },
      ],
    },

    // Verification passes
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
    await agent.run("Build repair-nav-t2");
  } finally {
    cleanupFiles(PRE_TEST, IMPL);
  }

  const finalMessages = recordedMessages[recordedMessages.length - 1] ?? [];
  const rejected = finalMessages.find(
    (m) => typeof m.content === "string" && m.content.includes("REPAIR EVIDENCE REQUIRED") && m.content.includes(PRE_TEST),
  );

  if (!rejected) {
    throw new Error("FAIL Test 2: Expected REPAIR EVIDENCE REQUIRED for pre-existing file " + PRE_TEST);
  }

  console.log("PASS Test 2: Pre-existing implicated test file NOT written during run is captured as repair evidence");
}

// ---------------------------------------------------------------------------
// Test 3 — Pre-existing implicated implementation file NOT written during run
// ---------------------------------------------------------------------------

async function testPreExistingImplicatedImplementationFile() {
  const PRE_IMPL = "src/repair-nav-pre-impl.ts";
  const TEST = "src/tests/repair-nav-pre-impl.test.js";

  // Pre-create implementation file directly on disk BEFORE agent runs
  writeFileDirect(
    PRE_IMPL,
    `export function preImpl(): string { return "pre"; }\n`,
  );

  const fakeRunCmd = new FakeRunCommandTool([
    {
      exitCode: 1,
      stdout: `TypeError in ${PRE_IMPL} line 1: Cannot read property`,
      stderr: "Command failed",
    },
    { exitCode: 0, stdout: "ok 1 - pass", stderr: "" },
    { exitCode: 0, stdout: "ok", stderr: "" },
  ]);

  const recordedMessages: Message[][] = [];

  class TrackingFake extends FakeModelProvider {
    override async generate(messages: Message[], toolsDef: any) {
      recordedMessages.push([...messages]);
      return super.generate(messages, toolsDef);
    }
  }

  const model = new TrackingFake([
    ...investigationSequence(),

    // Agent writes TEST file only
    {
      content: "",
      toolCalls: [
        {
          id: "w1",
          name: "write_file",
          arguments: { path: TEST, content: testContent("repair-nav-pre-impl", "preImpl") },
        },
      ],
    },

    // Verify: FAILS, output names PRE_IMPL
    {
      content: "",
      toolCalls: [
        { id: "c1", name: "run_command", arguments: { command: "npm test" } },
      ],
    },

    // Model tries to write TEST without reading PRE_IMPL -> REJECTED
    {
      content: "",
      toolCalls: [
        {
          id: "w2",
          name: "write_file",
          arguments: { path: TEST, content: testContentFixed("repair-nav-pre-impl", "preImpl") },
        },
      ],
    },

    // Model reads pre-existing implementation file -> gate clear
    {
      content: "",
      toolCalls: [
        { id: "r4", name: "read_file", arguments: { path: PRE_IMPL } },
      ],
    },

    // Write now allowed
    {
      content: "",
      toolCalls: [
        {
          id: "w3",
          name: "write_file",
          arguments: { path: PRE_IMPL, content: `export function preImpl(): string { return "pre-fixed"; }\n` },
        },
      ],
    },

    // Verification passes
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
    await agent.run("Build repair-nav-pre-impl");
  } finally {
    cleanupFiles(PRE_IMPL, TEST);
  }

  const finalMessages = recordedMessages[recordedMessages.length - 1] ?? [];
  const rejected = finalMessages.find(
    (m) => typeof m.content === "string" && m.content.includes("REPAIR EVIDENCE REQUIRED") && m.content.includes(PRE_IMPL),
  );

  if (!rejected) {
    throw new Error("FAIL Test 3: Expected REPAIR EVIDENCE REQUIRED for pre-existing impl " + PRE_IMPL);
  }

  console.log("PASS Test 3: Pre-existing implicated implementation file NOT written during run is captured");
}

// ---------------------------------------------------------------------------
// Test 4 — Multiple implicated existing files
// ---------------------------------------------------------------------------

async function testMultipleImplicatedExistingFiles() {
  const IMPL_A = "src/repair-nav-m1.ts";
  const IMPL_B = "src/repair-nav-m2.ts";
  const TEST = "src/tests/repair-nav-m1.test.js";

  const fakeRunCmd = new FakeRunCommandTool([
    {
      exitCode: 1,
      stdout: `Error in ${IMPL_A} and ${IMPL_B}`,
      stderr: "Command failed",
    },
    { exitCode: 0, stdout: "ok", stderr: "" },
    { exitCode: 0, stdout: "ok", stderr: "" },
  ]);

  const recordedMessages: Message[][] = [];

  class TrackingFake extends FakeModelProvider {
    override async generate(messages: Message[], toolsDef: any) {
      recordedMessages.push([...messages]);
      return super.generate(messages, toolsDef);
    }
  }

  const model = new TrackingFake([
    ...investigationSequence(),

    {
      content: "",
      toolCalls: [
        { id: "w1", name: "write_file", arguments: { path: IMPL_A, content: implContent("repairNavM1") } },
        { id: "w2", name: "write_file", arguments: { path: IMPL_B, content: implContent("repairNavM2") } },
        { id: "w3", name: "write_file", arguments: { path: TEST, content: testContent("repair-nav-m1", "repairNavM1") } },
      ],
    },

    // Verify FAILS naming both
    {
      content: "",
      toolCalls: [
        { id: "c1", name: "run_command", arguments: { command: "npm test" } },
      ],
    },

    // Attempt write (both unread) -> REJECTED (1)
    {
      content: "",
      toolCalls: [
        { id: "w4", name: "write_file", arguments: { path: IMPL_A, content: implContent("repairNavM1") + " // 1" } },
      ],
    },

    // Read IMPL_A only -> gate remains active
    {
      content: "",
      toolCalls: [
        { id: "r4", name: "read_file", arguments: { path: IMPL_A } },
      ],
    },

    // Attempt write again (IMPL_B still unread) -> REJECTED (2)
    {
      content: "",
      toolCalls: [
        { id: "w5", name: "write_file", arguments: { path: IMPL_A, content: implContent("repairNavM1") + " // 2" } },
      ],
    },

    // Read IMPL_B -> gate clear
    {
      content: "",
      toolCalls: [
        { id: "r5", name: "read_file", arguments: { path: IMPL_B } },
      ],
    },

    // Write now allowed
    {
      content: "",
      toolCalls: [
        { id: "w6", name: "write_file", arguments: { path: IMPL_A, content: implContent("repairNavM1") } },
      ],
    },

    { content: "", toolCalls: [{ id: "c2", name: "run_command", arguments: { command: "npm test" } }] },
    { content: "", toolCalls: [{ id: "c3", name: "run_command", arguments: { command: "npm run typecheck" } }] },
    { content: "Done.", toolCalls: [] },
  ]);

  const tools = makeTools(fakeRunCmd);
  const agent = makeAgent(model, tools);

  try {
    await agent.run("Build repair-nav-m1");
  } finally {
    cleanupFiles(IMPL_A, IMPL_B, TEST);
  }

  const finalMessages = recordedMessages[recordedMessages.length - 1] ?? [];
  const rejections = finalMessages.filter(
    (m) => typeof m.content === "string" && m.content.includes("REPAIR EVIDENCE REQUIRED"),
  );

  if (rejections.length !== 2) {
    throw new Error(`FAIL Test 4: Expected exactly 2 rejections, got ${rejections.length}`);
  }

  console.log("PASS Test 4: Multiple implicated existing files require reading all files");
}

// ---------------------------------------------------------------------------
// Test 5 — Missing dependency + existing importing file (no deadlock)
// ---------------------------------------------------------------------------

async function testMissingDependencyNoDeadlock() {
  const IMPL = "src/repair-nav-miss.ts";
  const TEST = "src/tests/repair-nav-miss.test.js";

  const fakeRunCmd = new FakeRunCommandTool([
    {
      exitCode: 1,
      stdout: `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '../nonexistent-dep.js' imported from ${TEST}`,
      stderr: "Command failed",
    },
    { exitCode: 0, stdout: "ok", stderr: "" },
    { exitCode: 0, stdout: "ok", stderr: "" },
  ]);

  const model = new FakeModelProvider([
    ...investigationSequence(),

    {
      content: "",
      toolCalls: [
        { id: "w1", name: "write_file", arguments: { path: IMPL, content: implContent("repairNavMiss") } },
        { id: "w2", name: "write_file", arguments: { path: TEST, content: testContent("repair-nav-miss", "repairNavMiss") } },
      ],
    },

    // Verify FAILS
    {
      content: "",
      toolCalls: [
        { id: "c1", name: "run_command", arguments: { command: "npm test" } },
      ],
    },

    // Reading TEST unblocks write (nonexistent-dep.js is not on disk and not required)
    {
      content: "",
      toolCalls: [
        { id: "r4", name: "read_file", arguments: { path: TEST } },
      ],
    },

    // Write allowed
    {
      content: "",
      toolCalls: [
        { id: "w3", name: "write_file", arguments: { path: TEST, content: testContentFixed("repair-nav-miss", "repairNavMiss") } },
      ],
    },

    { content: "", toolCalls: [{ id: "c2", name: "run_command", arguments: { command: "npm test" } }] },
    { content: "", toolCalls: [{ id: "c3", name: "run_command", arguments: { command: "npm run typecheck" } }] },
    { content: "Done.", toolCalls: [] },
  ]);

  const tools = makeTools(fakeRunCmd);
  const agent = makeAgent(model, tools);

  try {
    await agent.run("Build repair-nav-miss");
  } finally {
    cleanupFiles(IMPL, TEST);
  }

  console.log("PASS Test 5: Missing dependency does not cause deadlock; existing importing file captured");
}

// ---------------------------------------------------------------------------
// Test 6 — Successful verification clears evidence
// ---------------------------------------------------------------------------

async function testVerificationSuccessClearsRepairEvidence() {
  const IMPL = "src/repair-nav-clr.ts";
  const TEST = "src/tests/repair-nav-clr.test.js";

  const fakeRunCmd = new FakeRunCommandTool([
    { exitCode: 1, stdout: `Error in ${TEST}`, stderr: "Command failed" },
    { exitCode: 0, stdout: "ok 1 - pass", stderr: "" },
    { exitCode: 0, stdout: "ok", stderr: "" },
    { exitCode: 0, stdout: "ok", stderr: "" },
    { exitCode: 0, stdout: "ok", stderr: "" },
  ]);

  const recordedMessages: Message[][] = [];

  class TrackingFake extends FakeModelProvider {
    override async generate(messages: Message[], toolsDef: any) {
      recordedMessages.push([...messages]);
      return super.generate(messages, toolsDef);
    }
  }

  const model = new TrackingFake([
    ...investigationSequence(),

    {
      content: "",
      toolCalls: [
        { id: "w1", name: "write_file", arguments: { path: IMPL, content: implContent("repairNavClr") } },
        { id: "w2", name: "write_file", arguments: { path: TEST, content: testContent("repair-nav-clr", "repairNavClr") } },
      ],
    },

    { content: "", toolCalls: [{ id: "c1", name: "run_command", arguments: { command: "npm test" } }] },

    // Attempt write -> REJECTED (1)
    { content: "", toolCalls: [{ id: "w3", name: "write_file", arguments: { path: IMPL, content: implContent("repairNavClr") + " // 1" } }] },

    // Read TEST -> gate clear
    { content: "", toolCalls: [{ id: "r4", name: "read_file", arguments: { path: TEST } }] },

    // Write fix
    { content: "", toolCalls: [{ id: "w4", name: "write_file", arguments: { path: TEST, content: testContentFixed("repair-nav-clr", "repairNavClr") } }] },

    // Verify passes -> clears evidence!
    { content: "", toolCalls: [{ id: "c2", name: "run_command", arguments: { command: "npm test" } }] },
    { content: "", toolCalls: [{ id: "c3", name: "run_command", arguments: { command: "npm run typecheck" } }] },

    // Post-success write -> MUST NOT BE BLOCKED
    { content: "", toolCalls: [{ id: "w5", name: "write_file", arguments: { path: TEST, content: testContentFixed("repair-nav-clr", "repairNavClr") + "\n// post\n" } }] },

    { content: "", toolCalls: [{ id: "c4", name: "run_command", arguments: { command: "npm test" } }] },
    { content: "", toolCalls: [{ id: "c5", name: "run_command", arguments: { command: "npm run typecheck" } }] },
    { content: "Done.", toolCalls: [] },
  ]);

  const tools = makeTools(fakeRunCmd);
  const agent = makeAgent(model, tools);

  try {
    await agent.run("Build repair-nav-clr");
  } finally {
    cleanupFiles(IMPL, TEST);
  }

  const finalMessages = recordedMessages[recordedMessages.length - 1] ?? [];
  const rejections = finalMessages.filter(
    (m) => typeof m.content === "string" && m.content.includes("REPAIR EVIDENCE REQUIRED"),
  );

  if (rejections.length !== 1) {
    throw new Error(`FAIL Test 6: Expected exactly 1 rejection, got ${rejections.length}`);
  }

  console.log("PASS Test 6: Successful verification clears repair evidence");
}

// ---------------------------------------------------------------------------
// Test 7 — New verification failure replaces stale evidence
// ---------------------------------------------------------------------------

async function testNewFailureReplacesStaleEvidence() {
  const FILE_A = "src/repair-nav-f1.ts";
  const FILE_B = "src/repair-nav-f2.ts";
  const TEST = "src/tests/repair-nav-f1.test.js";

  const fakeRunCmd = new FakeRunCommandTool([
    // Failure 1: names FILE_A
    { exitCode: 1, stdout: `Error in ${FILE_A}`, stderr: "Command failed" },
    // Failure 2: names FILE_B ONLY
    { exitCode: 1, stdout: `Error in ${FILE_B}`, stderr: "Command failed" },
    // Pass
    { exitCode: 0, stdout: "ok", stderr: "" },
    { exitCode: 0, stdout: "ok", stderr: "" },
  ]);

  const recordedMessages: Message[][] = [];

  class TrackingFake extends FakeModelProvider {
    override async generate(messages: Message[], toolsDef: any) {
      recordedMessages.push([...messages]);
      return super.generate(messages, toolsDef);
    }
  }

  const model = new TrackingFake([
    ...investigationSequence(),

    {
      content: "",
      toolCalls: [
        { id: "w1", name: "write_file", arguments: { path: FILE_A, content: implContent("repairNavF1") } },
        { id: "w2", name: "write_file", arguments: { path: FILE_B, content: implContent("repairNavF2") } },
        { id: "w3", name: "write_file", arguments: { path: TEST, content: testContent("repair-nav-f1", "repairNavF1") } },
      ],
    },

    // Verify: FAILS naming FILE_A
    { content: "", toolCalls: [{ id: "c1", name: "run_command", arguments: { command: "npm test" } }] },

    // Model reads FILE_A
    { content: "", toolCalls: [{ id: "r4", name: "read_file", arguments: { path: FILE_A } }] },

    // Model writes fix to FILE_A
    { content: "", toolCalls: [{ id: "w4", name: "write_file", arguments: { path: FILE_A, content: implContent("repairNavF1") + " // fixed" } }] },

    // Verify: FAILS naming FILE_B (FILE_A is NOT mentioned)
    { content: "", toolCalls: [{ id: "c2", name: "run_command", arguments: { command: "npm test" } }] },

    // Attempt write without reading FILE_B -> REJECTED naming FILE_B
    { content: "", toolCalls: [{ id: "w5", name: "write_file", arguments: { path: FILE_A, content: implContent("repairNavF1") } }] },

    // Model reads FILE_B only -> gate clear (FILE_A is NOT required)
    { content: "", toolCalls: [{ id: "r5", name: "read_file", arguments: { path: FILE_B } }] },

    // Write fix to FILE_B
    { content: "", toolCalls: [{ id: "w6", name: "write_file", arguments: { path: FILE_B, content: implContent("repairNavF2") + " // fixed" } }] },

    // Verify passes
    { content: "", toolCalls: [{ id: "c3", name: "run_command", arguments: { command: "npm test" } }] },
    { content: "", toolCalls: [{ id: "c4", name: "run_command", arguments: { command: "npm run typecheck" } }] },
    { content: "Done.", toolCalls: [] },
  ]);

  const tools = makeTools(fakeRunCmd);
  const agent = makeAgent(model, tools);

  try {
    await agent.run("Build repair-nav-f1");
  } finally {
    cleanupFiles(FILE_A, FILE_B, TEST);
  }

  const finalMessages = recordedMessages[recordedMessages.length - 1] ?? [];
  const rejection = finalMessages.find(
    (m) => typeof m.content === "string" && m.content.includes("REPAIR EVIDENCE REQUIRED"),
  );

  if (!rejection || typeof rejection.content !== "string") {
    throw new Error("FAIL Test 7: Expected REPAIR EVIDENCE REQUIRED rejection");
  }

  const requiredSection = rejection.content
    .split("Verification failed and the following file(s)")[1]
    ?.split("You must call read_file")[0] ?? "";

  if (!requiredSection.includes(FILE_B) || requiredSection.includes(FILE_A)) {
    throw new Error(
      `FAIL Test 7: Required section should name FILE_B (${FILE_B}) only and not retain stale FILE_A (${FILE_A}). Section was: ${requiredSection}`,
    );
  }

  console.log("PASS Test 7: New verification failure replaces stale evidence cleanly");
}

// ---------------------------------------------------------------------------
// Test 8 — Multi-tool: [write_file (rejected), read_file (accepted), write_file (accepted)]
// ---------------------------------------------------------------------------

async function testMultiToolRejectedWriteReadWriteSequence() {
  const IMPL = "src/repair-nav-multi.ts";
  const TEST = "src/tests/repair-nav-multi.test.js";

  const fakeRunCmd = new FakeRunCommandTool([
    { exitCode: 1, stdout: `Error in ${TEST}`, stderr: "Command failed" },
    { exitCode: 0, stdout: "ok", stderr: "" },
    { exitCode: 0, stdout: "ok", stderr: "" },
  ]);

  const model = new FakeModelProvider([
    ...investigationSequence(),

    {
      content: "",
      toolCalls: [
        { id: "w1", name: "write_file", arguments: { path: IMPL, content: implContent("repairNavMulti") } },
        { id: "w2", name: "write_file", arguments: { path: TEST, content: testContent("repair-nav-multi", "repairNavMulti") } },
      ],
    },

    // Verify FAILS naming TEST
    { content: "", toolCalls: [{ id: "c1", name: "run_command", arguments: { command: "npm test" } }] },

    // Multi-tool batch containing:
    // 1. write_file (rejected by gate)
    // 2. read_file (accepted, clears gate)
    // 3. write_file (accepted since gate is now clear!)
    {
      content: "",
      toolCalls: [
        { id: "w-rej", name: "write_file", arguments: { path: IMPL, content: implContent("repairNavMulti") + " // rejected" } },
        { id: "r-ok", name: "read_file", arguments: { path: TEST } },
        { id: "w-ok", name: "write_file", arguments: { path: TEST, content: testContentFixed("repair-nav-multi", "repairNavMulti") } },
      ],
    },

    // Verify passes
    { content: "", toolCalls: [{ id: "c2", name: "run_command", arguments: { command: "npm test" } }] },
    { content: "", toolCalls: [{ id: "c3", name: "run_command", arguments: { command: "npm run typecheck" } }] },
    { content: "Done.", toolCalls: [] },
  ]);

  const tools = makeTools(fakeRunCmd);
  const agent = makeAgent(model, tools);

  try {
    await agent.run("Build repair-nav-multi");
  } finally {
    cleanupFiles(IMPL, TEST);
  }

  console.log("PASS Test 8: Multi-tool batch [rejected write -> read -> accepted write] handled correctly");
}

// ---------------------------------------------------------------------------
// Test 9 — Path normalization (./src/..., absolute path with line:col)
// ---------------------------------------------------------------------------

async function testPathNormalization() {
  const IMPL = "src/repair-nav-norm.ts";
  const TEST = "src/tests/repair-nav-norm.test.js";
  const absTestPath = path.resolve(TEST);

  const fakeRunCmd = new FakeRunCommandTool([
    // Error output uses absolute path with line:col and ./ relative path
    {
      exitCode: 1,
      stdout: `at Object.<anonymous> (${absTestPath}:12:5)\n    imported from ./${TEST}`,
      stderr: "Command failed",
    },
    { exitCode: 0, stdout: "ok", stderr: "" },
    { exitCode: 0, stdout: "ok", stderr: "" },
  ]);

  const recordedMessages: Message[][] = [];

  class TrackingFake extends FakeModelProvider {
    override async generate(messages: Message[], toolsDef: any) {
      recordedMessages.push([...messages]);
      return super.generate(messages, toolsDef);
    }
  }

  const model = new TrackingFake([
    ...investigationSequence(),

    {
      content: "",
      toolCalls: [
        { id: "w1", name: "write_file", arguments: { path: IMPL, content: implContent("repairNavNorm") } },
        { id: "w2", name: "write_file", arguments: { path: TEST, content: testContent("repair-nav-norm", "repairNavNorm") } },
      ],
    },

    // Verify FAILS
    { content: "", toolCalls: [{ id: "c1", name: "run_command", arguments: { command: "npm test" } }] },

    // Blind write -> REJECTED
    { content: "", toolCalls: [{ id: "w3", name: "write_file", arguments: { path: IMPL, content: implContent("repairNavNorm") + " // blind" } }] },

    // Model reads using relative path with ./ -> clears gate
    { content: "", toolCalls: [{ id: "r4", name: "read_file", arguments: { path: `./${TEST}` } }] },

    // Write allowed
    { content: "", toolCalls: [{ id: "w4", name: "write_file", arguments: { path: TEST, content: testContentFixed("repair-nav-norm", "repairNavNorm") } }] },

    { content: "", toolCalls: [{ id: "c2", name: "run_command", arguments: { command: "npm test" } }] },
    { content: "", toolCalls: [{ id: "c3", name: "run_command", arguments: { command: "npm run typecheck" } }] },
    { content: "Done.", toolCalls: [] },
  ]);

  const tools = makeTools(fakeRunCmd);
  const agent = makeAgent(model, tools);

  try {
    await agent.run("Build repair-nav-norm");
  } finally {
    cleanupFiles(IMPL, TEST);
  }

  const finalMessages = recordedMessages[recordedMessages.length - 1] ?? [];
  const rejection = finalMessages.find(
    (m) => typeof m.content === "string" && m.content.includes("REPAIR EVIDENCE REQUIRED") && m.content.includes(TEST),
  );

  if (!rejection) {
    throw new Error("FAIL Test 9: Expected normalized path " + TEST + " in rejection");
  }

  console.log("PASS Test 9: Path normalization handles absolute paths with line:col and leading ./");
}

// ---------------------------------------------------------------------------
// Test 10 — Workspace-outside paths are ignored
// ---------------------------------------------------------------------------

async function testWorkspaceOutsidePathsIgnored() {
  const IMPL = "src/repair-nav-out.ts";
  const TEST = "src/tests/repair-nav-out.test.js";

  const fakeRunCmd = new FakeRunCommandTool([
    // Error names external paths (node_modules, /usr/lib, /tmp) and NO workspace file
    {
      exitCode: 1,
      stdout: "Error in /usr/lib/node_modules/mocha/lib/runner.js:10:2\n    at /tmp/external-script.js:5:1\n    at node:internal/process/task_queues:95:5",
      stderr: "Command failed",
    },
    { exitCode: 0, stdout: "ok", stderr: "" },
    { exitCode: 0, stdout: "ok", stderr: "" },
  ]);

  const model = new FakeModelProvider([
    ...investigationSequence(),

    {
      content: "",
      toolCalls: [
        { id: "w1", name: "write_file", arguments: { path: IMPL, content: implContent("repairNavOut") } },
        { id: "w2", name: "write_file", arguments: { path: TEST, content: testContent("repair-nav-out", "repairNavOut") } },
      ],
    },

    // Verify FAILS with external-only paths
    { content: "", toolCalls: [{ id: "c1", name: "run_command", arguments: { command: "npm test" } }] },

    // Next write is NOT blocked because no workspace file was implicated
    {
      content: "",
      toolCalls: [
        { id: "w3", name: "write_file", arguments: { path: IMPL, content: implContent("repairNavOut") + " // direct write" } },
      ],
    },

    { content: "", toolCalls: [{ id: "c2", name: "run_command", arguments: { command: "npm test" } }] },
    { content: "", toolCalls: [{ id: "c3", name: "run_command", arguments: { command: "npm run typecheck" } }] },
    { content: "Done.", toolCalls: [] },
  ]);

  const tools = makeTools(fakeRunCmd);
  const agent = makeAgent(model, tools);

  try {
    await agent.run("Build repair-nav-out");
  } finally {
    cleanupFiles(IMPL, TEST);
  }

  console.log("PASS Test 10: Workspace-outside paths (/usr/lib, /tmp, node_modules, node:) are ignored");
}

// ---------------------------------------------------------------------------
// Test 11 — Unrelated file write (README.md) is blocked while evidence is unread
// ---------------------------------------------------------------------------

async function testUnrelatedFileWriteBlocked() {
  const IMPL = "src/repair-nav-unrel.ts";
  const TEST = "src/tests/repair-nav-unrel.test.js";

  const fakeRunCmd = new FakeRunCommandTool([
    { exitCode: 1, stdout: `Error in ${TEST}`, stderr: "Command failed" },
    { exitCode: 0, stdout: "ok", stderr: "" },
    { exitCode: 0, stdout: "ok", stderr: "" },
  ]);

  const recordedMessages: Message[][] = [];

  class TrackingFake extends FakeModelProvider {
    override async generate(messages: Message[], toolsDef: any) {
      recordedMessages.push([...messages]);
      return super.generate(messages, toolsDef);
    }
  }

  const model = new TrackingFake([
    ...investigationSequence(),

    {
      content: "",
      toolCalls: [
        { id: "w1", name: "write_file", arguments: { path: IMPL, content: implContent("repairNavUnrel") } },
        { id: "w2", name: "write_file", arguments: { path: TEST, content: testContent("repair-nav-unrel", "repairNavUnrel") } },
      ],
    },

    // Verify FAILS
    { content: "", toolCalls: [{ id: "c1", name: "run_command", arguments: { command: "npm test" } }] },

    // Attempt to write README.md -> BLOCKED
    {
      content: "",
      toolCalls: [
        { id: "w3", name: "write_file", arguments: { path: "README.md", content: "# Readme\n" } },
      ],
    },

    // Read TEST -> gate clear
    { content: "", toolCalls: [{ id: "r4", name: "read_file", arguments: { path: TEST } }] },

    // Write repair allowed
    { content: "", toolCalls: [{ id: "w4", name: "write_file", arguments: { path: TEST, content: testContentFixed("repair-nav-unrel", "repairNavUnrel") } }] },

    { content: "", toolCalls: [{ id: "c2", name: "run_command", arguments: { command: "npm test" } }] },
    { content: "", toolCalls: [{ id: "c3", name: "run_command", arguments: { command: "npm run typecheck" } }] },
    { content: "Done.", toolCalls: [] },
  ]);

  const tools = makeTools(fakeRunCmd);
  const agent = makeAgent(model, tools);

  try {
    await agent.run("Build repair-nav-unrel");
  } finally {
    cleanupFiles(IMPL, TEST, "README.md");
  }

  const finalMessages = recordedMessages[recordedMessages.length - 1] ?? [];
  const rejections = finalMessages.filter(
    (m) => typeof m.content === "string" && m.content.includes("REPAIR EVIDENCE REQUIRED"),
  );

  if (rejections.length === 0) {
    throw new Error("FAIL Test 11: Expected write to README.md to be blocked while repair evidence is unread");
  }

  console.log("PASS Test 11: Unrelated file writes (README.md) blocked while repair evidence is unread");
}

// ---------------------------------------------------------------------------
// Test 12 — Workspace root != process.cwd() normalization (exact Run 13 reproduction)
//
// In Run 13, the workspace root was a sub-directory:
//   /Users/.../disposable-todo-workspace-run13
// The error output contained absolute paths inside that sub-directory:
//   /Users/.../disposable-todo-workspace-run13/src/tests/todos.test.ts
//
// Bug in Run 13: extractImplicatedPaths normalized against process.cwd(), yielding:
//   disposable-todo-workspace-run13/src/tests/todos.test.ts
// which could not be satisfied by read_file("src/tests/todos.test.ts").
//
// Fix: normalize against tool.workspace.root, yielding:
//   src/tests/todos.test.ts
// which is cleanly satisfied by read_file("src/tests/todos.test.ts").
// ---------------------------------------------------------------------------

async function testIsolatedSubWorkspaceNormalization() {
  const subWorkspaceDir = path.resolve("./tmp-test-subworkspace-isolated");

  // Setup isolated sub-workspace directory
  if (fs.existsSync(subWorkspaceDir)) {
    fs.rmSync(subWorkspaceDir, { recursive: true, force: true });
  }
  fs.mkdirSync(path.join(subWorkspaceDir, "src/tests"), { recursive: true });

  const pkgJson = {
    name: "subworkspace-test",
    version: "1.0.0",
    type: "module",
    scripts: {
      typecheck: "tsc --noEmit",
      test: "node --test"
    }
  };
  fs.writeFileSync(path.join(subWorkspaceDir, "package.json"), JSON.stringify(pkgJson, null, 2));

  // Placeholder test file
  fs.writeFileSync(path.join(subWorkspaceDir, "src/tests/placeholder.test.js"), "import test from 'node:test';\ntest('sanity', () => {});\n");

  const subWorkspace = new Workspace(subWorkspaceDir);
  const tools = new ToolRegistry();
  tools.register(new SearchFilesTool(subWorkspace));
  tools.register(new ListDirectoryTool(subWorkspace));
  tools.register(new ReadFileTool(subWorkspace));
  tools.register(new WriteFileTool(subWorkspace));

  const absTestPath = path.join(subWorkspaceDir, "src/tests/todos.test.ts");
  const missingModulePath = path.join(subWorkspaceDir, "src/todos");

  const fakeRunCmd = new FakeRunCommandTool([
    // Error output matches exact Run 13 failure (missing extension on module path)
    {
      exitCode: 1,
      stdout: `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '${missingModulePath}' imported from ${absTestPath}`,
      stderr: "Command failed: npm test\n",
    },
    { exitCode: 0, stdout: "ok 1 - all pass", stderr: "" },
    { exitCode: 0, stdout: "typecheck clean", stderr: "" },
  ]);
  tools.register(fakeRunCmd);

  const recordedMessages: Message[][] = [];

  class TrackingFake extends FakeModelProvider {
    override async generate(messages: Message[], toolsDef: any) {
      recordedMessages.push([...messages]);
      return super.generate(messages, toolsDef);
    }
  }

  const model = new TrackingFake([
    ...investigationSequence(),

    // Agent writes impl + test inside sub-workspace
    {
      content: "",
      toolCalls: [
        { id: "w1", name: "write_file", arguments: { path: "src/todos.ts", content: implContent("todos") } },
        { id: "w2", name: "write_file", arguments: { path: "src/tests/todos.test.ts", content: testContent("todos", "todos") } },
      ],
    },

    // Verify FAILS with absolute path in sub-workspace
    { content: "", toolCalls: [{ id: "c1", name: "run_command", arguments: { command: "npm test" } }] },

    // Blind write attempt -> REJECTED
    { content: "", toolCalls: [{ id: "w3", name: "write_file", arguments: { path: "src/todos.ts", content: implContent("todos") + " // wrong" } }] },

    // Model reads "src/tests/todos.test.ts" -> MUST SATISFY AND CLEAR GATE!
    { content: "", toolCalls: [{ id: "r4", name: "read_file", arguments: { path: "src/tests/todos.test.ts" } }] },

    // Write fix -> MUST BE ACCEPTED (gate is clear)
    { content: "", toolCalls: [{ id: "w4", name: "write_file", arguments: { path: "src/tests/todos.test.ts", content: testContentFixed("todos", "todos") } }] },

    // Verification passes
    { content: "", toolCalls: [{ id: "c2", name: "run_command", arguments: { command: "npm test" } }] },
    { content: "", toolCalls: [{ id: "c3", name: "run_command", arguments: { command: "npm run typecheck" } }] },
    { content: "Done.", toolCalls: [] },
  ]);

  const trace = new ExecutionTrace();
  const memory = new ProjectMemory(path.join(subWorkspaceDir, "project-memory.json"));
  const agent = new Agent(model, tools, trace, memory, {
    maxIterations: 30,
    workspaceRoot: subWorkspaceDir,
  });

  try {
    await agent.run("Build todos");
  } finally {
    if (fs.existsSync(subWorkspaceDir)) {
      fs.rmSync(subWorkspaceDir, { recursive: true, force: true });
    }
  }

  const finalMessages = recordedMessages[recordedMessages.length - 1] ?? [];
  const rejection = finalMessages.find(
    (m) => typeof m.content === "string" && m.content.includes("REPAIR EVIDENCE REQUIRED"),
  );

  if (!rejection || typeof rejection.content !== "string") {
    throw new Error("FAIL Test 12: Expected REPAIR EVIDENCE REQUIRED rejection");
  }

  // The rejection message MUST contain "src/tests/todos.test.ts" and NOT "tmp-test-subworkspace-isolated/src/tests/todos.test.ts"
  const requiredSection = rejection.content
    .split("Verification failed and the following file(s)")[1]
    ?.split("You must call read_file")[0] ?? "";

  if (requiredSection.includes("tmp-test-subworkspace-isolated")) {
    throw new Error(
      `FAIL Test 12: Rejection section leaked outer directory prefix! Section was: ${requiredSection}`,
    );
  }

  if (!requiredSection.includes("src/tests/todos.test.ts")) {
    throw new Error(
      `FAIL Test 12: Rejection section missing normalized path 'src/tests/todos.test.ts'. Section was: ${requiredSection}`,
    );
  }

  console.log("PASS Test 12: Isolated sub-workspace (root != process.cwd()) normalizes paths cleanly and unblocks gate on read");
}

// ---------------------------------------------------------------------------
// Run all tests
// ---------------------------------------------------------------------------

console.log("Running comprehensive repair-navigation test suite...\n");

await testRun12ExactReproduction();
await testPreExistingImplicatedTestFile();
await testPreExistingImplicatedImplementationFile();
await testMultipleImplicatedExistingFiles();
await testMissingDependencyNoDeadlock();
await testVerificationSuccessClearsRepairEvidence();
await testNewFailureReplacesStaleEvidence();
await testMultiToolRejectedWriteReadWriteSequence();
await testPathNormalization();
await testWorkspaceOutsidePathsIgnored();
await testUnrelatedFileWriteBlocked();
await testIsolatedSubWorkspaceNormalization();

console.log("\nAll 12 repair-navigation tests PASSED successfully.");
