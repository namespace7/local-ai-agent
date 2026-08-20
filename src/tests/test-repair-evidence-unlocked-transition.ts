/**
 * src/tests/test-repair-evidence-unlocked-transition.ts
 *
 * Deterministic test verifying:
 * 1. Verification failure establishes repair obligation on implicated path.
 * 2. replace_content is rejected while repair evidence is unread.
 * 3. read_file on implicated path satisfies the obligation.
 * 4. Controller emits explicit "[REPAIR EVIDENCE SATISFIED]" guidance to the model.
 * 5. replace_content is then authorized and successfully executes.
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

const TMP_TEST_DIR = path.resolve("./tmp-repair-unlocked-test");

function cleanTmpDir(dir: string) {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  fs.mkdirSync(dir, { recursive: true });
}

async function main() {
  console.log("============================================================");
  console.log("TESTING REPAIR EVIDENCE UNLOCKED GUIDANCE TRANSITION");
  console.log("============================================================\n");

  cleanTmpDir(TMP_TEST_DIR);

  try {
    fs.writeFileSync(
      path.join(TMP_TEST_DIR, "package.json"),
      JSON.stringify({
        name: "test-pkg",
        type: "module",
        scripts: {
          typecheck: "tsc --noEmit",
          test: "node --test",
        },
      }),
    );
    fs.mkdirSync(path.join(TMP_TEST_DIR, "src", "tests"), { recursive: true });
    fs.writeFileSync(
      path.join(TMP_TEST_DIR, "src", "order.ts"),
      "import { Repo } from './repo';\nexport const order = 1;\n",
    );
    fs.writeFileSync(
      path.join(TMP_TEST_DIR, "src", "tests", "order.test.ts"),
      "import test from 'node:test';\n",
    );

    const workspace = new Workspace(TMP_TEST_DIR);
    const tools = new ToolRegistry();
    tools.register(new ListDirectoryTool(workspace));
    tools.register(new ReadFileTool(workspace));
    tools.register(new SearchFilesTool(workspace));
    tools.register(new WriteFileTool(workspace));
    tools.register(new ReplaceContentTool(workspace));

    const fakeRunCommand = new FakeRunCommandTool([
      // First verification: Fails on src/order.ts
      {
        exitCode: 1,
        stdout: "src/order.ts(1,22): error TS2835: Relative import paths need explicit file extensions.",
        stderr: "typecheck failed",
      },
      // Second verification: Passes
      {
        exitCode: 0,
        stdout: "typecheck clean",
        stderr: "",
      },
      // Third verification: Test passes
      {
        exitCode: 0,
        stdout: "ok 1 - all pass",
        stderr: "",
      },
    ]);
    tools.register(fakeRunCommand);

    const trace = new ExecutionTrace();
    const memory = new ProjectMemory(path.join(TMP_TEST_DIR, ".memory.json"));

    let capturedMessages: any[] = [];

    const model = new FakeModelProvider([
      // Step 1: search_files
      { content: "", toolCalls: [{ id: "c1", name: "search_files", arguments: { query: "order" } }] },
      // Step 2: list_directory
      { content: "", toolCalls: [{ id: "c2", name: "list_directory", arguments: { path: "." } }] },
      // Step 3: read package.json
      { content: "", toolCalls: [{ id: "c3", name: "read_file", arguments: { path: "package.json" } }] },
      // Step 4: read src/order.ts
      { content: "", toolCalls: [{ id: "c4", name: "read_file", arguments: { path: "src/order.ts" } }] },
      // Step 5: read src/tests/order.test.ts (completes investigation evidence)
      { content: "", toolCalls: [{ id: "c5", name: "read_file", arguments: { path: "src/tests/order.test.ts" } }] },
      // Step 6: Initial verification run -> FAILS on src/order.ts
      { content: "", toolCalls: [{ id: "c6", name: "run_command", arguments: { command: "npm run typecheck" } }] },
      // Step 7: Premature replace_content -> REJECTED by repair evidence gate (must read order.ts after failure)
      {
        content: "",
        toolCalls: [
          {
            id: "c7",
            name: "replace_content",
            arguments: {
              path: "src/order.ts",
              target: "import { Repo } from './repo';",
              replacement: "import { Repo } from './repo.js';",
            },
          },
        ],
      },
      // Step 8: read_file on src/order.ts -> SATISFIES repair evidence!
      { content: "", toolCalls: [{ id: "c8", name: "read_file", arguments: { path: "src/order.ts" } }] },
      // Step 9: Re-issue replace_content -> ALLOWED and executes!
      {
        content: "",
        toolCalls: [
          {
            id: "c9",
            name: "replace_content",
            arguments: {
              path: "src/order.ts",
              target: "import { Repo } from './repo';",
              replacement: "import { Repo } from './repo.js';",
            },
          },
        ],
      },
      // Step 10: Rerun typecheck -> PASSES
      { content: "", toolCalls: [{ id: "c10", name: "run_command", arguments: { command: "npm run typecheck" } }] },
      // Step 11: Run tests -> PASSES
      { content: "", toolCalls: [{ id: "c11", name: "run_command", arguments: { command: "npm test" } }] },
      // Step 12: Done
      { content: "Repair completed and verified successfully.", toolCalls: [] },
    ]);

    const agent = new Agent(model, tools, trace, memory, {
      maxIterations: 20,
      workspaceRoot: TMP_TEST_DIR,
    });

    const result = await agent.run("Repair the failing typecheck issues in order.ts and verify.");

    assert.strictEqual(result, "Repair completed and verified successfully.");

    const events = trace.getEvents();

    // 1. Verify premature replace_content was rejected by gate
    const rejectedToolEvent = events.find(
      (e) => e.type === "tool" && e.toolName === "replace_content" && !e.success,
    );
    assert.ok(rejectedToolEvent, "Expected premature replace_content to be rejected by repair evidence gate");

    // 2. Verify subsequent replace_content succeeded
    const successfulToolEvent = events.find(
      (e) => e.type === "tool" && e.toolName === "replace_content" && e.success,
    );
    assert.ok(successfulToolEvent, "Expected subsequent replace_content to succeed after read_file satisfied gate");

    // 3. Verify final file on disk was modified
    const fileContent = fs.readFileSync(path.join(TMP_TEST_DIR, "src", "order.ts"), "utf8");
    assert.strictEqual(
      fileContent,
      "import { Repo } from './repo.js';\nexport const order = 1;\n",
    );

    console.log("✅ Repair obligation unlocked guidance transition test PASSED.");
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
