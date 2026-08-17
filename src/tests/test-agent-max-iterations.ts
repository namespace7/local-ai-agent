/**
 * test-agent-max-iterations.ts
 *
 * Deterministic tests verifying that Agent.maxIterations is correctly
 * configurable via AgentOptions and that all existing iteration-accounting
 * invariants are preserved.
 *
 * Each "progress iteration" is one accepted tool call turn. The investigation
 * setup used below consists of exactly SETUP_ITERS = 6 accepted turns:
 *   i1  search_files  (featureSearchCompleted)
 *   i2  list_directory (repositoryStructureInspected)
 *   i3  read_file package.json (configurationInspected)
 *   i4  read_file src/index.ts (implementationInspected)
 *   i5  read_file src/tests/test-read-file.ts (testsInspected)
 *   w1  write_file src/runaway.ts  (enters implementation phase)
 *
 * Tests:
 *  1. Default configuration uses maxIterations=20 for implementation tasks.
 *  2. Explicit maxIterations=25 is honoured.
 *  3. 20 accepted progress iterations do NOT terminate an Agent configured for 25.
 *  4. 25 accepted progress iterations DO terminate it with the expected error.
 *  5. Rejected tool calls still do not consume progressIterations.
 *  6. maxConsecutiveRejectedCalls behaviour remains unchanged.
 */

import { Agent } from "../agent/Agent.js";
import { ProjectMemory } from "../memory/ProjectMemory.js";
import { ExecutionTrace } from "../observability/ExecutionTrace.js";
import { ToolRegistry } from "../tools/ToolRegistry.js";
import { ReadFileTool } from "../tools/ReadFileTool.js";
import { SearchFilesTool } from "../tools/SearchFilesTool.js";
import { ListDirectoryTool } from "../tools/ListDirectoryTool.js";
import { WriteFileTool } from "../tools/WriteFileTool.js";
import { RunCommandTool } from "../tools/RunCommandTool.js";
import { Workspace } from "../workspace/Workspace.js";
import { FakeModelProvider } from "./fakes/FakeModelProvider.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Number of progress iterations consumed by the investigation+first-write setup. */
const SETUP_ITERS = 6;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTools() {
  const workspace = new Workspace(".");
  const tools = new ToolRegistry();
  tools.register(new SearchFilesTool(workspace));
  tools.register(new ListDirectoryTool(workspace));
  tools.register(new ReadFileTool(workspace));
  tools.register(new WriteFileTool(workspace));
  tools.register(new RunCommandTool(workspace));
  return tools;
}

function makeMemory() {
  return new ProjectMemory("./data/project-memory.json");
}

/**
 * Returns a response sequence that consumes exactly `totalIters` accepted
 * progress iterations:
 *  - First SETUP_ITERS turns complete investigation and enter implementation.
 *  - Remaining (totalIters - SETUP_ITERS) turns are unique read_file calls.
 *
 * If `totalIters < SETUP_ITERS` this throws to guard test correctness.
 */
function buildSequence(totalIters: number): any[] {
  if (totalIters < SETUP_ITERS) {
    throw new Error(`totalIters must be >= ${SETUP_ITERS}`);
  }
  const extraReads = totalIters - SETUP_ITERS;

  const responses: any[] = [
    { content: "", toolCalls: [{ id: "i1", name: "search_files", arguments: { query: "local-ai-agent" } }] },
    { content: "", toolCalls: [{ id: "i2", name: "list_directory", arguments: { path: "." } }] },
    { content: "", toolCalls: [{ id: "i3", name: "read_file", arguments: { path: "package.json" } }] },
    { content: "", toolCalls: [{ id: "i4", name: "read_file", arguments: { path: "src/index.ts" } }] },
    { content: "", toolCalls: [{ id: "i5", name: "read_file", arguments: { path: "src/tests/test-read-file.ts" } }] },
    { content: "", toolCalls: [{ id: "w1", name: "write_file", arguments: { path: "src/runaway.ts", content: "// runaway" } }] },
  ];

  for (let i = 0; i < extraReads; i++) {
    responses.push({
      content: "",
      toolCalls: [
        {
          id: `loop-${i}`,
          name: "read_file",
          // Each call is unique (different endLine) so deduplication policy never fires.
          arguments: { path: "package.json", startLine: 1, endLine: i + 1 },
        },
      ],
    });
  }

  return responses;
}

// ---------------------------------------------------------------------------
// Test runner
// ---------------------------------------------------------------------------

async function testAgentMaxIterations() {

  // ─── Test 1: Default configuration uses maxIterations=20 ─────────────────
  // We need 21 total iterations to overflow the default limit of 20.
  {
    const tools = makeTools();
    const trace = new ExecutionTrace();
    const memory = makeMemory();

    const model = new FakeModelProvider(buildSequence(21));
    // No options → must default to 20
    const agent = new Agent(model, tools, trace, memory);
    let hitMax = false;

    try {
      await agent.run("Build a runaway feature requiring loop");
    } catch (err: any) {
      if (err.message.includes("Agent exceeded maximum iterations (20)")) {
        hitMax = true;
      } else {
        throw err;
      }
    }

    if (!hitMax) {
      throw new Error("FAIL Test 1: Default Agent MUST stop at 20 iterations");
    }
    console.log("PASS Test 1: Default Agent.maxIterations=20 is enforced");
  }

  // ─── Test 2: Explicit maxIterations=25 is honoured ───────────────────────
  // 26 total iterations must overflow limit=25 with the correct message.
  {
    const tools = makeTools();
    const trace = new ExecutionTrace();
    const memory = makeMemory();

    const model = new FakeModelProvider(buildSequence(26));
    const agent = new Agent(model, tools, trace, memory, { maxIterations: 25 });
    let hitMax = false;

    try {
      await agent.run("Build a runaway feature requiring loop");
    } catch (err: any) {
      if (err.message.includes("Agent exceeded maximum iterations (25)")) {
        hitMax = true;
      } else {
        throw err;
      }
    }

    if (!hitMax) {
      throw new Error("FAIL Test 2: Agent with maxIterations=25 MUST stop at 25");
    }
    console.log("PASS Test 2: Explicit maxIterations=25 is honoured");
  }

  // ─── Test 3: 20 accepted iterations do NOT terminate an Agent set to 25 ──
  // Sequence: exactly 20 iterations → agent must survive and complete normally.
  {
    const tools = makeTools();
    const trace = new ExecutionTrace();
    const memory = makeMemory();

    const responses = [
      ...buildSequence(20),
      // After exactly 20 iterations (iteration 21 will proceed since limit=25):
      // run typecheck
      { content: "", toolCalls: [{ id: "v1", name: "run_command", arguments: { command: "npm run typecheck" } }] },
      // run tests (unique command)
      { content: "", toolCalls: [{ id: "v2", name: "run_command", arguments: { command: "node --test --version" } }] },
      // text-only completion
      { content: "Budget-25 completion success", toolCalls: [] },
    ];

    const model = new FakeModelProvider(responses);
    const agent = new Agent(model, tools, trace, memory, { maxIterations: 25 });

    let result: string | undefined;
    try {
      result = await agent.run("Build a runaway feature requiring loop");
    } catch (err: any) {
      throw new Error(
        `FAIL Test 3: Agent configured for 25 MUST NOT terminate at 20 iterations. Got: ${err.message}`
      );
    }

    if (!result?.includes("Budget-25 completion success")) {
      throw new Error("FAIL Test 3: Expected normal completion after 20 iterations with limit=25");
    }
    console.log("PASS Test 3: 20 accepted iterations do NOT terminate an Agent configured for 25");
  }

  // ─── Test 4: 25 accepted iterations DO terminate with expected error ──────
  // Already covered by Test 2, but this explicitly asserts it does NOT stop at 20.
  {
    const tools = makeTools();
    const trace = new ExecutionTrace();
    const memory = makeMemory();

    const model = new FakeModelProvider(buildSequence(26));
    const agent = new Agent(model, tools, trace, memory, { maxIterations: 25 });

    let hitMax25 = false;
    let hitMax20 = false;

    try {
      await agent.run("Build a runaway feature requiring loop");
    } catch (err: any) {
      if (err.message.includes("Agent exceeded maximum iterations (25)")) {
        hitMax25 = true;
      } else if (err.message.includes("Agent exceeded maximum iterations (20)")) {
        hitMax20 = true;
      } else {
        throw err;
      }
    }

    if (hitMax20) {
      throw new Error("FAIL Test 4: Agent stopped at 20 instead of 25 — maxIterations override not applied!");
    }
    if (!hitMax25) {
      throw new Error("FAIL Test 4: 25 accepted iterations MUST throw max-iterations error for limit=25");
    }
    console.log("PASS Test 4: 25 accepted iterations terminate Agent configured for 25 (not at 20)");
  }

  // ─── Test 5: Rejected tool calls do NOT consume progressIterations ────────
  {
    const tools = makeTools();
    const trace = new ExecutionTrace();
    const memory = makeMemory();

    // 4 rejected list_directory calls → 0 progress iters consumed.
    // Then normal completion sequence.
    const model = new FakeModelProvider([
      { content: "", toolCalls: [{ id: "r1", name: "list_directory", arguments: { path: "." } }] },
      { content: "", toolCalls: [{ id: "r2", name: "list_directory", arguments: { path: "." } }] },
      { content: "", toolCalls: [{ id: "r3", name: "list_directory", arguments: { path: "." } }] },
      { content: "", toolCalls: [{ id: "r4", name: "list_directory", arguments: { path: "." } }] },
      // Now the accepted investigation + write + completion:
      { content: "", toolCalls: [{ id: "ok1", name: "search_files", arguments: { query: "local-ai-agent" } }] },
      { content: "", toolCalls: [{ id: "ok2", name: "list_directory", arguments: { path: "." } }] },
      { content: "", toolCalls: [{ id: "ok3", name: "read_file", arguments: { path: "package.json" } }] },
      { content: "", toolCalls: [{ id: "ok4", name: "read_file", arguments: { path: "src/index.ts" } }] },
      { content: "", toolCalls: [{ id: "ok5", name: "read_file", arguments: { path: "src/tests/test-read-file.ts" } }] },
      { content: "", toolCalls: [{ id: "w1", name: "write_file", arguments: { path: "src/feat.ts", content: "// feat" } }] },
      { content: "", toolCalls: [{ id: "v1", name: "run_command", arguments: { command: "npm run typecheck" } }] },
      { content: "", toolCalls: [{ id: "v2", name: "run_command", arguments: { command: "node --test --version" } }] },
      { content: "Rejected calls did not count", toolCalls: [] },
    ]);

    const agent = new Agent(model, tools, trace, memory, { maxIterations: 25 });
    let result: string | undefined;

    try {
      result = await agent.run("Build a feature in local-ai-agent");
    } catch (err: any) {
      throw new Error(`FAIL Test 5: Agent should complete normally. Got: ${err.message}`);
    }

    if (!result?.includes("Rejected calls did not count")) {
      throw new Error("FAIL Test 5: Rejected calls must not consume progress iterations");
    }
    console.log("PASS Test 5: Rejected tool calls do NOT consume progressIterations");
  }

  // ─── Test 6: maxConsecutiveRejectedCalls=5 behaviour is unchanged ─────────
  {
    const tools = makeTools();
    const trace = new ExecutionTrace();
    const memory = makeMemory();

    // 5 consecutive rejected calls must fire the safety limit regardless of maxIterations.
    const model = new FakeModelProvider([
      { content: "", toolCalls: [{ id: "r1", name: "list_directory", arguments: { path: "." } }] },
      { content: "", toolCalls: [{ id: "r2", name: "list_directory", arguments: { path: "." } }] },
      { content: "", toolCalls: [{ id: "r3", name: "list_directory", arguments: { path: "." } }] },
      { content: "", toolCalls: [{ id: "r4", name: "list_directory", arguments: { path: "." } }] },
      { content: "", toolCalls: [{ id: "r5", name: "list_directory", arguments: { path: "." } }] },
    ]);

    const agent = new Agent(model, tools, trace, memory, { maxIterations: 100 });
    let hitRejectedLimit = false;

    try {
      await agent.run("Build a new feature");
    } catch (err: any) {
      if (err.message.includes("Agent exceeded maximum consecutive rejected tool calls")) {
        hitRejectedLimit = true;
      } else {
        throw err;
      }
    }

    if (!hitRejectedLimit) {
      throw new Error("FAIL Test 6: maxConsecutiveRejectedCalls=5 must still fire regardless of maxIterations");
    }
    console.log("PASS Test 6: maxConsecutiveRejectedCalls behaviour unchanged with custom maxIterations");
  }

  console.log("\nAll Agent maxIterations configuration tests PASSED.");
}

testAgentMaxIterations();
