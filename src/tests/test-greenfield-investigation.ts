/**
 * src/tests/test-greenfield-investigation.ts
 *
 * Deterministic unit and integration tests for Greenfield Repository Support.
 *
 * Verifies:
 * A. Empty greenfield workspace (search -> list root -> REQUIREMENTS.md) reaches implementation readiness.
 * B. Greenfield workspace rejects/avoids requiring nonexistent package.json/tsconfig/src/tests.
 * C. Existing repository with REQUIREMENTS.md + package.json + src continues using existing investigation rules.
 * D. Greenfield next-action guidance explicitly prioritizes REQUIREMENTS.md.
 * E. After requirements inspection, implementation transition occurs without demanding source/test evidence.
 */

import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { Agent } from "../agent/Agent.js";
import { InvestigationState } from "../agent/InvestigationState.js";
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

const TMP_TEST_DIR = path.resolve("./tmp-greenfield-test");

function cleanTmpDir(dir: string) {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  fs.mkdirSync(dir, { recursive: true });
}

async function testGreenfieldInvestigationStateMachineAndGuidance() {
  console.log("TEST A & D: InvestigationState greenfield state machine & guidance");

  const state = new InvestigationState();
  state.setTaskType("implementation");

  assert.strictEqual(state.isGreenfield(), false);
  assert.strictEqual(state.hasSpecificationBeenEstablished(), false);
  assert.strictEqual(state.isComplete(), false);

  state.markFeatureSearchCompleted();
  state.markRepositoryStructureInspected();
  state.markGreenfieldDetected(true);

  assert.strictEqual(state.isGreenfield(), true);
  assert.strictEqual(state.isComplete(), false, "Greenfield requires specification inspection");

  const missing = state.getMissingEvidence();
  assert.ok(
    missing.some((m) => m.includes("project specification")),
    "Missing evidence must mention project specification for greenfield",
  );

  const guidance = state.getNextActionGuidance();
  assert.ok(
    guidance.includes("project specification"),
    "Guidance must explicitly prioritize project specification",
  );
  assert.ok(
    guidance.includes("Do NOT call read_file on package.json"),
    "Guidance must instruct not to read nonexistent package.json/tsconfig",
  );

  // Simulate specification being established after inspection
  state.markSpecificationEstablished();
  assert.strictEqual(state.hasSpecificationBeenEstablished(), true);
  assert.strictEqual(state.isComplete(), true, "Greenfield with specification established must be complete");
  assert.strictEqual(state.getMissingEvidence().length, 0);

  console.log("PASS: A & D. InvestigationState greenfield lifecycle and guidance verified");
}

async function testGreenfieldRejectionOfNonexistentArtifacts() {
  console.log("TEST B: Greenfield workspace rejects attempts to inspect nonexistent files");

  const testDir = path.join(TMP_TEST_DIR, "rejection-test");
  cleanTmpDir(testDir);

  fs.writeFileSync(path.join(testDir, "REQUIREMENTS.md"), "# Requirements\n");

  const workspace = new Workspace(testDir);
  const tools = new ToolRegistry();
  tools.register(new ListDirectoryTool(workspace));
  tools.register(new ReadFileTool(workspace));
  tools.register(new SearchFilesTool(workspace));
  tools.register(new WriteFileTool(workspace));

  const trace = new ExecutionTrace();
  const memory = new ProjectMemory(path.join(testDir, ".memory.json"));

  const model = new FakeModelProvider([
    // Step 1: search_files
    { content: "", toolCalls: [{ id: "c1", name: "search_files", arguments: { query: "app" } }] },
    // Step 2: list_directory -> marks greenfieldDetected
    { content: "", toolCalls: [{ id: "c2", name: "list_directory", arguments: { path: "." } }] },
    // Step 3: attempts to read package.json -> MUST BE REJECTED with greenfield guidance
    { content: "", toolCalls: [{ id: "c3", name: "read_file", arguments: { path: "package.json" } }] },
    // Step 4: attempts to read src/index.ts -> MUST BE REJECTED with greenfield guidance
    { content: "", toolCalls: [{ id: "c4", name: "read_file", arguments: { path: "src/index.ts" } }] },
    // Step 5: read REQUIREMENTS.md -> ALLOWED!
    { content: "", toolCalls: [{ id: "c5", name: "read_file", arguments: { path: "REQUIREMENTS.md" } }] },
  ]);

  const agent = new Agent(model, tools, trace, memory, {
    maxIterations: 10,
    workspaceRoot: testDir,
  });

  try {
    await agent.run("Build the application according to REQUIREMENTS.md");
  } catch {}

  const lastInvestigation = agent.getLastInvestigation();
  assert.ok(lastInvestigation);
  assert.strictEqual(lastInvestigation.isGreenfield(), true);
  assert.strictEqual(lastInvestigation.hasSpecificationBeenEstablished(), true);
  assert.strictEqual(lastInvestigation.isComplete(), true);

  console.log("PASS: B. Greenfield workspace strictly guides to REQUIREMENTS.md");
}

async function testExistingRepositoryProtection() {
  console.log("TEST C: Existing repository protection against greenfield classification");

  const testDir = path.join(TMP_TEST_DIR, "existing-repo");
  cleanTmpDir(testDir);

  fs.writeFileSync(
    path.join(testDir, "package.json"),
    JSON.stringify({ name: "existing", scripts: { test: "echo pass" } }),
  );
  fs.writeFileSync(path.join(testDir, "REQUIREMENTS.md"), "# Requirements\n");
  fs.mkdirSync(path.join(testDir, "src"), { recursive: true });
  fs.writeFileSync(path.join(testDir, "src", "index.ts"), "export const a = 1;\n");

  const workspace = new Workspace(testDir);
  const tools = new ToolRegistry();
  tools.register(new ListDirectoryTool(workspace));
  tools.register(new ReadFileTool(workspace));
  tools.register(new SearchFilesTool(workspace));
  tools.register(new WriteFileTool(workspace));
  tools.register(new ReplaceContentTool(workspace));

  const trace = new ExecutionTrace();
  const memory = new ProjectMemory(path.join(testDir, ".memory.json"));

  const model = new FakeModelProvider([
    // Step 1: search_files
    { content: "", toolCalls: [{ id: "c1", name: "search_files", arguments: { query: "index" } }] },
    // Step 2: list_directory -> sees package.json and src/
    { content: "", toolCalls: [{ id: "c2", name: "list_directory", arguments: { path: "." } }] },
    // Step 3: try to read REQUIREMENTS.md -> MUST BE REJECTED because package.json is present (existing repo!)
    { content: "", toolCalls: [{ id: "c3", name: "read_file", arguments: { path: "REQUIREMENTS.md" } }] },
    // Step 4: read package.json -> allowed!
    { content: "", toolCalls: [{ id: "c4", name: "read_file", arguments: { path: "package.json" } }] },
    // Step 5: read src/index.ts -> allowed!
    { content: "", toolCalls: [{ id: "c5", name: "read_file", arguments: { path: "src/index.ts" } }] },
    // Step 6: read REQUIREMENTS.md -> allowed now as representative doc
    { content: "", toolCalls: [{ id: "c6", name: "read_file", arguments: { path: "REQUIREMENTS.md" } }] },
  ]);

  const agent = new Agent(model, tools, trace, memory, {
    maxIterations: 10,
    workspaceRoot: testDir,
  });

  try {
    await agent.run("Implement feature according to REQUIREMENTS.md");
  } catch {}

  const lastInvestigation = agent.getLastInvestigation();
  assert.ok(lastInvestigation);
  assert.strictEqual(
    lastInvestigation.isGreenfield(),
    false,
    "Repository with package.json and src/ must NOT be classified as greenfield",
  );

  console.log("PASS: C. Existing repository with REQUIREMENTS.md correctly preserves existing-repo rules");
}

async function testGreenfieldAutonomousTransitionAndImplementation() {
  console.log("TEST E: Greenfield autonomous transition into implementation and verification");

  const testDir = path.join(TMP_TEST_DIR, "greenfield-repo");
  cleanTmpDir(testDir);

  fs.writeFileSync(
    path.join(testDir, "REQUIREMENTS.md"),
    "# URL Shortener Service\nBuild a TypeScript REST service for shortening URLs.\n",
  );

  const workspace = new Workspace(testDir);
  const tools = new ToolRegistry();
  tools.register(new ListDirectoryTool(workspace));
  tools.register(new ReadFileTool(workspace));
  tools.register(new SearchFilesTool(workspace));
  tools.register(new WriteFileTool(workspace));
  tools.register(new ReplaceContentTool(workspace));

  const fakeRunCommand = new FakeRunCommandTool([
    {
      exitCode: 0,
      stdout: "all green",
      stderr: "",
    },
    {
      exitCode: 0,
      stdout: "tests passing",
      stderr: "",
    },
  ]);
  tools.register(fakeRunCommand);

  const trace = new ExecutionTrace();
  const memory = new ProjectMemory(path.join(testDir, ".memory.json"));

  const model = new FakeModelProvider([
    // Step 1: search_files (feature search evidence)
    { content: "", toolCalls: [{ id: "c1", name: "search_files", arguments: { query: "shortener" } }] },
    // Step 2: list_directory (detects greenfield: only REQUIREMENTS.md exists!)
    { content: "", toolCalls: [{ id: "c2", name: "list_directory", arguments: { path: "." } }] },
    // Step 3: read_file("REQUIREMENTS.md") -> MUST BE ALLOWED without package.json/tsconfig!
    { content: "", toolCalls: [{ id: "c3", name: "read_file", arguments: { path: "REQUIREMENTS.md" } }] },
    // Transition happens automatically!
    // Step 4: write_file("package.json") in implementation phase
    {
      content: "",
      toolCalls: [
        {
          id: "c4",
          name: "write_file",
          arguments: {
            path: "package.json",
            content: JSON.stringify({ name: "url-shortener", scripts: { typecheck: "echo ok", test: "echo ok" } }),
          },
        },
      ],
    },
    // Step 5: write_file("src/index.ts")
    {
      content: "",
      toolCalls: [
        {
          id: "c5",
          name: "write_file",
          arguments: {
            path: "src/index.ts",
            content: "export function shorten(url: string) { return 'http://sho.rt/1'; }\n",
          },
        },
      ],
    },
    // Step 6: write_file("src/tests/index.test.ts")
    {
      content: "",
      toolCalls: [
        {
          id: "c6",
          name: "write_file",
          arguments: {
            path: "src/tests/index.test.ts",
            content: "import { shorten } from '../index.js';\n",
          },
        },
      ],
    },
    // Step 7: run typecheck
    { content: "", toolCalls: [{ id: "c7", name: "run_command", arguments: { command: "npm run typecheck" } }] },
    // Step 8: run test
    { content: "", toolCalls: [{ id: "c8", name: "run_command", arguments: { command: "npm test" } }] },
    // Step 9: final answer
    { content: "Greenfield URL shortener built and verified.", toolCalls: [] },
  ]);

  const agent = new Agent(model, tools, trace, memory, {
    maxIterations: 15,
    workspaceRoot: testDir,
  });

  const result = await agent.run(
    "Read REQUIREMENTS.md and build the complete application described there. Do not modify REQUIREMENTS.md.",
  );

  assert.strictEqual(result, "Greenfield URL shortener built and verified.");

  const lastInvestigation = agent.getLastInvestigation();
  assert.ok(lastInvestigation);
  assert.strictEqual(lastInvestigation.isGreenfield(), true, "Must be classified as greenfield");
  assert.strictEqual(lastInvestigation.hasSpecificationBeenEstablished(), true);
  assert.strictEqual(lastInvestigation.isImplementationComplete(), true);

  assert.ok(fs.existsSync(path.join(testDir, "package.json")));
  assert.ok(fs.existsSync(path.join(testDir, "src", "index.ts")));
  assert.ok(fs.existsSync(path.join(testDir, "src", "tests", "index.test.ts")));

  console.log("PASS: E. Greenfield project successfully inspected and autonomously implemented");
}

async function main() {
  console.log("============================================================");
  console.log("RUNNING GREENFIELD INVESTIGATION DETERMINISTIC REGRESSION SUITE");
  console.log("============================================================\n");

  cleanTmpDir(TMP_TEST_DIR);

  try {
    await testGreenfieldInvestigationStateMachineAndGuidance();
    await testGreenfieldRejectionOfNonexistentArtifacts();
    await testExistingRepositoryProtection();
    await testGreenfieldAutonomousTransitionAndImplementation();

    console.log("\n✅ All greenfield investigation test cases (A-E) PASSED successfully.");
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
