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
import type { ModelResponse } from "../models/types.js";

const tmpWorkspace = path.resolve("./tmp-test-agent-replace-content");

function cleanup() {
  if (fs.existsSync(tmpWorkspace)) {
    fs.rmSync(tmpWorkspace, { recursive: true, force: true });
  }
}

async function setup() {
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
    JSON.stringify({ compilerOptions: { module: "NodeNext" } }, null, 2),
  );
}

try {
  await setup();

  const workspace = new Workspace(tmpWorkspace);
  const tools = new ToolRegistry();
  tools.register(new ListDirectoryTool(workspace));
  tools.register(new ReadFileTool(workspace));
  tools.register(new WriteFileTool(workspace));
  tools.register(new ReplaceContentTool(workspace));
  tools.register(new SearchFilesTool(workspace));

  // Initial file creation
  fs.writeFileSync(
    path.join(tmpWorkspace, "src", "todos.ts"),
    `import { Todo } from './types';\nexport function getTodo(): string { return 'todo'; }\n`,
  );
  fs.writeFileSync(
    path.join(tmpWorkspace, "src", "types.ts"),
    `export interface Todo { id: number; }\n`,
  );

  // Command Responses:
  // Call 0: npm run typecheck (fails, implicating src/todos.ts)
  // Call 1: npm run typecheck (passes after replace_content)
  // Call 2: npm test (passes)
  const commandResponses: FakeCommandResponse[] = [
    {
      exitCode: 1,
      stdout: `src/todos.ts(1,22): error TS2835: Relative import paths need explicit file extensions. Did you mean './types.js'?`,
      stderr: "Command failed: npm run typecheck\n",
    },
    {
      exitCode: 0,
      stdout: "typecheck clean",
      stderr: "",
    },
    {
      exitCode: 0,
      stdout: "ok 1 - all tests pass",
      stderr: "",
    },
  ];

  const fakeRunCmd = new FakeRunCommandTool(commandResponses);
  tools.register(fakeRunCmd);

  // Scripted Model Responses:
  const modelResponses: ModelResponse[] = [
    // Turn 0: Model investigates search_files
    {
      content: "",
      toolCalls: [
        {
          id: "call_search",
          name: "search_files",
          arguments: { query: "todo" },
        },
      ],
    },
    // Turn 1: Model inspects repository structure
    {
      content: "",
      toolCalls: [
        {
          id: "call_list",
          name: "list_directory",
          arguments: { path: "." },
        },
      ],
    },
    // Turn 2: Model reads package.json
    {
      content: "",
      toolCalls: [
        {
          id: "call_pkg",
          name: "read_file",
          arguments: { path: "package.json" },
        },
      ],
    },
    // Turn 3: Model reads src/todos.ts (investigation evidence)
    {
      content: "",
      toolCalls: [
        {
          id: "call_inspect",
          name: "read_file",
          arguments: { path: "src/todos.ts" },
        },
      ],
    },
    // Turn 4: Model reads src/tests/todos.test.ts (investigation evidence)
    {
      content: "",
      toolCalls: [
        {
          id: "call_test_inspect",
          name: "read_file",
          arguments: { path: "src/tests/todos.test.ts" },
        },
      ],
    },
    // Turn 5: Model runs typecheck -> FAILS, implicating src/todos.ts
    {
      content: "",
      toolCalls: [
        {
          id: "call_check1",
          name: "run_command",
          arguments: { command: "npm run typecheck" },
        },
      ],
    },
    // Turn 4: Model attempts replace_content on src/todos.ts BEFORE reading it after failure
    // => REPAIR EVIDENCE GATE must REJECT this replace_content call
    // Turn 4 also queues read_file on src/todos.ts
    {
      content: "",
      toolCalls: [
        {
          id: "call_rep_blocked",
          name: "replace_content",
          arguments: {
            path: "src/todos.ts",
            target: "import { Todo } from './types';",
            replacement: "import { Todo } from './types.js';",
          },
        },
        {
          id: "call_read_unlock",
          name: "read_file",
          arguments: { path: "src/todos.ts" },
        },
      ],
    },
    // Turn 5: Now that src/todos.ts was read, model calls replace_content
    // => REPAIR EVIDENCE GATE must ALLOW this replace_content call
    {
      content: "",
      toolCalls: [
        {
          id: "call_rep_allowed",
          name: "replace_content",
          arguments: {
            path: "src/todos.ts",
            target: "import { Todo } from './types';",
            replacement: "import { Todo } from './types.js';",
          },
        },
      ],
    },
    // Turn 6: Re-run typecheck (now passes)
    {
      content: "",
      toolCalls: [
        {
          id: "call_check2",
          name: "run_command",
          arguments: { command: "npm run typecheck" },
        },
      ],
    },
    // Turn 7: Run test -> passes
    {
      content: "",
      toolCalls: [
        {
          id: "call_test",
          name: "run_command",
          arguments: { command: "npm test" },
        },
      ],
    },
    // Turn 8: Done
    {
      content: "Task completed successfully with targeted replacement.",
      toolCalls: [],
    },
  ];

  const model = new FakeModelProvider(modelResponses);
  const trace = new ExecutionTrace();
  const memory = new ProjectMemory(path.join(tmpWorkspace, "project-memory.json"));

  const agent = new Agent(model, tools, trace, memory, {
    maxIterations: 15,
    workspaceRoot: tmpWorkspace,
  });

  const finalResult = await agent.run("Fix todo imports and verify.");

  assert.strictEqual(
    finalResult,
    "Task completed successfully with targeted replacement.",
  );

  // Verify file on disk actually got updated
  const finalFileContent = fs.readFileSync(path.join(tmpWorkspace, "src", "todos.ts"), "utf8");
  assert.strictEqual(
    finalFileContent,
    `import { Todo } from './types.js';\nexport function getTodo(): string { return 'todo'; }\n`,
  );

  // Inspect trace events to verify:
  // 1. call_rep_blocked was rejected by gate
  // 2. call_rep_allowed succeeded
  const events = trace.getEvents();
  const blockedEvent = events.find(
    (e) => e.type === "tool" && e.toolName === "replace_content" && !e.success,
  );
  assert.strictEqual(
    blockedEvent === undefined,
    false,
    "Expected an initial blocked replace_content event",
  );

  const allowedEvent = events.find(
    (e) => e.type === "tool" && e.toolName === "replace_content" && e.success,
  );
  assert.strictEqual(
    allowedEvent !== undefined,
    true,
    "Expected a subsequent successful replace_content event",
  );

  console.log("PASS: Agent-level ReplaceContentTool integration tests passed.");
} finally {
  cleanup();
}
