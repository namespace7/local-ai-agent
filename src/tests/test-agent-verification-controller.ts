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
import type { ModelResponse } from "../models/types.js";

class ScriptedModelProvider {
  private readonly responses: ModelResponse[];

  constructor(responses: ModelResponse[]) {
    this.responses = [...responses];
  }

  async generate(): Promise<ModelResponse> {
    const next = this.responses.shift();
    if (!next) {
      throw new Error("ScriptedModelProvider ran out of planned responses");
    }
    return next;
  }
}

async function testAgentVerificationController() {
  const workspace = new Workspace(process.cwd());
  const tools = new ToolRegistry();
  tools.register(new ReadFileTool(workspace));
  tools.register(new SearchFilesTool(workspace));
  tools.register(new ListDirectoryTool(workspace));
  tools.register(new WriteFileTool(workspace));
  tools.register(new RunCommandTool(workspace));

  const trace = new ExecutionTrace();
  const memory = new ProjectMemory("./data/project-memory.json");

  const model = new ScriptedModelProvider([
    // Step 0: search_files
    {
      content: "",
      toolCalls: [
        {
          id: "search-1",
          name: "search_files",
          arguments: { query: "local-ai-agent" },
        },
      ],
    },
    // Step 1: list_directory
    {
      content: "",
      toolCalls: [
        {
          id: "list-1",
          name: "list_directory",
          arguments: { path: "." },
        },
      ],
    },
    // Step 2: read_file package.json (contains "typecheck" and "test" scripts!)
    {
      content: "",
      toolCalls: [
        {
          id: "read-pkg",
          name: "read_file",
          arguments: { path: "package.json" },
        },
      ],
    },
    // Step 3: read_file src/index.ts
    {
      content: "",
      toolCalls: [
        {
          id: "read-src",
          name: "read_file",
          arguments: { path: "src/index.ts" },
        },
      ],
    },
    // Step 4: read_file src/tests/test-read-file.ts (test evidence)
    {
      content: "",
      toolCalls: [
        {
          id: "read-test",
          name: "read_file",
          arguments: { path: "src/tests/test-read-file.ts" },
        },
      ],
    },
    // Step 5: Implementation starts -> write_file
    {
      content: "",
      toolCalls: [
        {
          id: "write-1",
          name: "write_file",
          arguments: {
            path: "src/temp-agent-verification-test.ts",
            content: "console.log('temp verification file');",
          },
        },
      ],
    },
    // Step 6: Model prematurely attempts to finish WITHOUT running verification tools
    {
      content: "I have written the file and I am done.",
      toolCalls: [],
    },
    // Step 7: Model runs npm run test ONLY
    {
      content: "",
      toolCalls: [
        {
          id: "cmd-test",
          name: "run_command",
          arguments: { command: "node --test --version" },
        },
      ],
    },
    // Step 8: Model again attempts to finish WITHOUT running typecheck
    {
      content: "Tests passed so I am done now.",
      toolCalls: [],
    },
    // Step 9: Model runs npm run typecheck
    {
      content: "",
      toolCalls: [
        {
          id: "cmd-tc",
          name: "run_command",
          arguments: { command: "npm run typecheck" },
        },
      ],
    },
    // Step 10: Now both categories passed, model finishes cleanly!
    {
      content: "Feature implemented and fully verified with typecheck and test.",
      toolCalls: [],
    },
  ]);

  const agent = new Agent(model as any, tools, trace, memory);

  const answer = await agent.run("Build a new feature in local-ai-agent");

  if (!answer.includes("fully verified")) {
    throw new Error(
      "FAIL: Agent did not return expected final answer after both verification categories completed!",
    );
  }

  console.log(
    "PASS: Agent verification controller regression test (Agent enforced multi-category verification end-to-end and rejected premature completion attempts!)",
  );

  // Cleanup temporary file created during test
  const fs = await import("fs");
  if (fs.existsSync("src/temp-agent-verification-test.ts")) {
    fs.unlinkSync("src/temp-agent-verification-test.ts");
  }
}

testAgentVerificationController();
