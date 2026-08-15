import { Agent } from "../agent/Agent.js";
import { ProjectMemory } from "../memory/ProjectMemory.js";
import { ExecutionTrace } from "../observability/ExecutionTrace.js";
import { ListDirectoryTool } from "../tools/ListDirectoryTool.js";
import { ReadFileTool } from "../tools/ReadFileTool.js";
import { SearchFilesTool } from "../tools/SearchFilesTool.js";
import { ToolRegistry } from "../tools/ToolRegistry.js";
import { Workspace } from "../workspace/Workspace.js";
import { FakeModelProvider } from "./fakes/FakeModelProvider.js";
import { rm } from "node:fs/promises";

const workspace = new Workspace(".");
const tools = new ToolRegistry();

tools.register(new ListDirectoryTool(workspace));
tools.register(new ReadFileTool(workspace));
tools.register(new SearchFilesTool(workspace));

const memoryPath = "./data/test-agent-memory.json";

await rm(memoryPath, {
  force: true,
});

const memory = new ProjectMemory(memoryPath);

await memory.load();

const model = new FakeModelProvider([
  {
    content: "",
    toolCalls: [
      {
        id: "call-1",
        name: "search_files",
        arguments: {
          query: "server.listen",
        },
      },
    ],
  },
  {
    content: "",
    toolCalls: [
      {
        id: "call-2",
        name: "read_file",
        arguments: {
          path: "src/tests/browser-fixture/server.ts",
        },
      },
    ],
  },
  {
    content: "The browser integration test fixture uses port 3001.",
    toolCalls: [],
  },
]);

const trace = new ExecutionTrace();

const agent = new Agent(model, tools, trace, memory);

const answer = await agent.run(
  "What port does the browser integration test fixture use?",
);

const events = trace.getEvents();

if (answer !== "The browser integration test fixture uses port 3001.") {
  throw new Error(`Unexpected agent answer: ${answer}`);
}

const toolEvents = events.filter((event) => event.type === "tool");

if (toolEvents.length !== 2) {
  throw new Error(`Expected 2 tool executions, received ${toolEvents.length}`);
}

if (
  toolEvents[0]?.type !== "tool" ||
  toolEvents[0].toolName !== "search_files" ||
  !toolEvents[0].success
) {
  throw new Error("Expected successful search_files execution");
}

if (
  toolEvents[1]?.type !== "tool" ||
  toolEvents[1].toolName !== "read_file" ||
  !toolEvents[1].success
) {
  throw new Error("Expected successful read_file execution");
}

const modelEvents = events.filter((event) => event.type === "model");

if (modelEvents.length !== 3) {
  throw new Error(
    `Expected 3 model iterations, received ${modelEvents.length}`,
  );
}

console.log("PASS: agent investigation completed successfully.");
console.log(`Answer: ${answer}`);
console.log("Tools: search_files -> read_file");

await rm(memoryPath, {
  force: true,
});
