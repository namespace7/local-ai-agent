import { Agent } from "../agent/Agent.js";
import { ProjectMemory } from "../memory/ProjectMemory.js";
import { ExecutionTrace } from "../observability/ExecutionTrace.js";
import { ToolRegistry } from "../tools/ToolRegistry.js";
import { ReadFileTool } from "../tools/ReadFileTool.js";
import { SearchFilesTool } from "../tools/SearchFilesTool.js";
import { ListDirectoryTool } from "../tools/ListDirectoryTool.js";
import { Workspace } from "../workspace/Workspace.js";
import { FakeModelProvider } from "./fakes/FakeModelProvider.js";

import { WriteFileTool } from "../tools/WriteFileTool.js";
import type { Message } from "../models/types.js";

const workspace = new Workspace(".");
const tools = new ToolRegistry();

tools.register(new SearchFilesTool(workspace));
tools.register(new ListDirectoryTool(workspace));
tools.register(new ReadFileTool(workspace));
tools.register(new WriteFileTool(workspace));

const trace = new ExecutionTrace();
const memory = new ProjectMemory("./data/project-memory.json");

const capturedSystemPrompts: string[] = [];

// A custom fake model provider that records system prompts
class PromptRecordingFakeModel extends FakeModelProvider {
  override async generate(
    messages: Message[],
    toolsDef: any,
  ) {
    const systemMessage = messages.find((m) => m.role === "system");
    if (systemMessage) {
      capturedSystemPrompts.push(systemMessage.content);
    }
    return super.generate(messages, toolsDef);
  }
}

const model = new PromptRecordingFakeModel([
  // Iteration 0: search_files (finds package.json match)
  {
    content: "",
    toolCalls: [
      {
        id: "search-1",
        name: "search_files",
        arguments: {
          query: "local-ai-agent",
        },
      },
    ],
  },
  // Iteration 1: list_directory (inspect structure)
  {
    content: "",
    toolCalls: [
      {
        id: "list-1",
        name: "list_directory",
        arguments: {
          path: ".",
        },
      },
    ],
  },
  // Iteration 2: read_file package.json (inspect configuration)
  {
    content: "",
    toolCalls: [
      {
        id: "read-1",
        name: "read_file",
        arguments: {
          path: "package.json",
        },
      },
    ],
  },
  // Iteration 3: read_file src/index.ts (inspect implementation)
  {
    content: "",
    toolCalls: [
      {
        id: "read-2",
        name: "read_file",
        arguments: {
          path: "src/index.ts",
        },
      },
    ],
  },
  // Iteration 4: read_file src/tests/test-agent-investigation.ts (inspect tests)
  {
    content: "",
    toolCalls: [
      {
        id: "read-3",
        name: "read_file",
        arguments: {
          path: "src/tests/test-agent-investigation.ts",
        },
      },
    ],
  },
  // Iteration 5: Transition to implementation phase -> write_file
  {
    content: "",
    toolCalls: [
      {
        id: "write-1",
        name: "write_file",
        arguments: {
          path: "src/new-feature.ts",
          content: "// new feature",
        },
      },
    ],
  },
  // Iteration 6: read_file src/new-feature.ts to verify
  {
    content: "",
    toolCalls: [
      {
        id: "read-4",
        name: "read_file",
        arguments: {
          path: "src/new-feature.ts",
        },
      },
    ],
  },
  // Iteration 7: Finish
  {
    content: "Feature implemented and verified.",
    toolCalls: [],
  },
]);

const agent = new Agent(model, tools, trace, memory);

await agent.run("Build a new feature in local-ai-agent");

// Check captured system prompts across iterations:
// After search_files (Iteration 1 system prompt): Configuration MUST STILL BE missing
const systemPromptAfterSearch = capturedSystemPrompts[1];
if (!systemPromptAfterSearch?.includes("- Configuration: missing")) {
  throw new Error(
    "FAIL: Configuration evidence was marked complete after search_files, but it must remain missing until read_file(package.json) is executed!",
  );
}

// After list_directory (Iteration 2 system prompt): Configuration MUST STILL BE missing
const systemPromptAfterList = capturedSystemPrompts[2];
if (!systemPromptAfterList?.includes("- Configuration: missing")) {
  throw new Error(
    "FAIL: Configuration evidence was marked complete before read_file(package.json)!",
  );
}

// After read_file package.json (Iteration 3 system prompt): Configuration MUST BE complete
const systemPromptAfterRead = capturedSystemPrompts[3];
if (!systemPromptAfterRead?.includes("- Configuration: complete")) {
  throw new Error(
    "FAIL: Configuration evidence was not marked complete after read_file(package.json)!",
  );
}

console.log(
  "PASS: Agent evidence rules integration test (search_files does NOT satisfy configurationInspected; read_file(package.json) DOES)",
);
