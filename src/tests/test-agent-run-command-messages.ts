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
import type { Message } from "../models/types.js";

async function testAgentRunCommandMessages() {
  const workspace = new Workspace(".");
  const tools = new ToolRegistry();

  tools.register(new SearchFilesTool(workspace));
  tools.register(new ListDirectoryTool(workspace));
  tools.register(new ReadFileTool(workspace));
  tools.register(new WriteFileTool(workspace));
  tools.register(new RunCommandTool(workspace));

  const trace = new ExecutionTrace();
  const memory = new ProjectMemory("./data/project-memory.json");

  const recordedMessages: Message[][] = [];

  class MessageRecordingFakeModel extends FakeModelProvider {
    override async generate(messages: Message[], toolsDef: any) {
      recordedMessages.push([...messages]);
      return super.generate(messages, toolsDef);
    }
  }

  const model = new MessageRecordingFakeModel([
    // Iteration 0: search_files
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
    // Iteration 1: list_directory
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
    // Iteration 2: read_file package.json
    {
      content: "",
      toolCalls: [
        {
          id: "read-1",
          name: "read_file",
          arguments: { path: "package.json" },
        },
      ],
    },
    // Iteration 3: read_file src/index.ts
    {
      content: "",
      toolCalls: [
        {
          id: "read-2",
          name: "read_file",
          arguments: { path: "src/index.ts" },
        },
      ],
    },
    // Iteration 4: read_file src/tests/test-agent-investigation.ts
    {
      content: "",
      toolCalls: [
        {
          id: "read-3",
          name: "read_file",
          arguments: { path: "src/tests/test-agent-investigation.ts" },
        },
      ],
    },
    // Iteration 5: write_file
    {
      content: "",
      toolCalls: [
        {
          id: "write-1",
          name: "write_file",
          arguments: { path: "src/test-feature.ts", content: "export const a = 1;" },
        },
      ],
    },
    // Iteration 6: run_command npm run typecheck (SUCCEEDS!)
    {
      content: "",
      toolCalls: [
        {
          id: "cmd-1",
          name: "run_command",
          arguments: { command: "npm run typecheck" },
        },
      ],
    },
    // Iteration 7: run_command node --test --version (SUCCEEDS!)
    {
      content: "",
      toolCalls: [
        {
          id: "cmd-2",
          name: "run_command",
          arguments: { command: "node --test --version" },
        },
      ],
    },
    // Iteration 8: Finish
    {
      content: "Implementation complete and verified.",
      toolCalls: [],
    },
  ]);

  const agent = new Agent(model, tools, trace, memory);
  await agent.run("Build a new feature in local-ai-agent");

  // Inspect model input messages at iteration 7 (last generate call)
  const lastCallMessages = recordedMessages[recordedMessages.length - 1];

  if (!lastCallMessages) {
    throw new Error("FAIL: Expected model calls recorded");
  }

  const failureRepairMessage = lastCallMessages.find(
    (msg) =>
      typeof msg.content === "string" &&
      msg.content.includes("Verification command") &&
      msg.content.includes("failed with exit code"),
  );

  if (failureRepairMessage) {
    throw new Error(
      "FAIL: Successful run_command should NOT add a failure/repair message to history!",
    );
  }

  console.log(
    "PASS: Agent run_command message history test (successful run_command does NOT append failure/repair message)",
  );
}

async function testAgentFailedRunCommandRepairPrompt() {
  const workspace = new Workspace(".");
  const tools = new ToolRegistry();

  tools.register(new SearchFilesTool(workspace));
  tools.register(new ListDirectoryTool(workspace));
  tools.register(new ReadFileTool(workspace));
  tools.register(new WriteFileTool(workspace));
  tools.register(new RunCommandTool(workspace));

  const trace = new ExecutionTrace();
  const memory = new ProjectMemory("./data/project-memory.json");

  const recordedMessages: Message[][] = [];

  class MessageRecordingFakeModel extends FakeModelProvider {
    override async generate(messages: Message[], toolsDef: any) {
      recordedMessages.push([...messages]);
      return super.generate(messages, toolsDef);
    }
  }

  const model = new MessageRecordingFakeModel([
    // Iteration 0: search_files
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
    // Iteration 1: list_directory
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
    // Iteration 2: read_file package.json
    {
      content: "",
      toolCalls: [
        {
          id: "read-1",
          name: "read_file",
          arguments: { path: "package.json" },
        },
      ],
    },
    // Iteration 3: read_file src/index.ts
    {
      content: "",
      toolCalls: [
        {
          id: "read-2",
          name: "read_file",
          arguments: { path: "src/index.ts" },
        },
      ],
    },
    // Iteration 4: read_file src/tests/test-agent-investigation.ts
    {
      content: "",
      toolCalls: [
        {
          id: "read-3",
          name: "read_file",
          arguments: { path: "src/tests/test-agent-investigation.ts" },
        },
      ],
    },
    // Iteration 5: write_file
    {
      content: "",
      toolCalls: [
        {
          id: "write-1",
          name: "write_file",
          arguments: { path: "src/test-feature.ts", content: "export const a = 1;" },
        },
      ],
    },
    // Iteration 6: run_command node --test src/tests/non-existent-test-file.js (FAILS!)
    {
      content: "",
      toolCalls: [
        {
          id: "cmd-fail",
          name: "run_command",
          arguments: { command: "node --test src/tests/non-existent-test-file.js" },
        },
      ],
    },
    // Iteration 7: finish
    {
      content: "Stopping after failure.",
      toolCalls: [],
    },
  ]);

  const agent = new Agent(model, tools, trace, memory);
  try {
    await agent.run("Build a new feature in local-ai-agent");
  } catch {}

  const lastCallMessages = recordedMessages[recordedMessages.length - 1];
  if (!lastCallMessages) {
    throw new Error("FAIL: Expected model calls recorded");
  }

  const failureRepairMessage = lastCallMessages.find(
    (msg) =>
      typeof msg.content === "string" &&
      msg.content.includes("Verification command 'node --test src/tests/non-existent-test-file.js' failed with exit code"),
  );

  if (!failureRepairMessage || typeof failureRepairMessage.content !== "string") {
    throw new Error("FAIL: Expected repair message for failed verification command");
  }

  const content = failureRepairMessage.content;

  const requiredPhrases = [
    "Repair the specific reported errors",
    "Preserve existing project configuration",
    "Do NOT switch test frameworks",
    "Do NOT create duplicate source files",
    "Inspect the relevant configuration or error",
    "rerun the SAME failed verification command",
    "Successful verification is required before completion",
  ];

  for (const phrase of requiredPhrases) {
    if (!content.includes(phrase)) {
      throw new Error(`FAIL: Repair prompt missing required phrase: "${phrase}"`);
    }
  }

  console.log("PASS: Agent failed run_command repair prompt test");
}

await testAgentRunCommandMessages();
await testAgentFailedRunCommandRepairPrompt();
