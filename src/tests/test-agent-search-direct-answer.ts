import { Agent } from "../agent/Agent.js";
import { ProjectMemory } from "../memory/ProjectMemory.js";
import { ExecutionTrace } from "../observability/ExecutionTrace.js";
import { ToolRegistry } from "../tools/ToolRegistry.js";
import { ReadFileTool } from "../tools/ReadFileTool.js";
import { SearchFilesTool } from "../tools/SearchFilesTool.js";
import { Workspace } from "../workspace/Workspace.js";
import { FakeModelProvider } from "./fakes/FakeModelProvider.js";

const workspace = new Workspace(".");
const tools = new ToolRegistry();

tools.register(new SearchFilesTool(workspace));
tools.register(new ReadFileTool(workspace));

const trace = new ExecutionTrace();
const memory = new ProjectMemory("./data/project-memory.json");

const expectedAnswer =
  "The browser integration test fixture uses port **3001**.";

const model = new FakeModelProvider([
  {
    content: "",
    toolCalls: [
      {
        id: "search-1",
        name: "search_files",
        arguments: {
          query: "server.listen",
        },
      },
    ],
  },
]);

const agent = new Agent(model, tools, trace, memory);

const answer = await agent.run(
  "What port does the browser integration test fixture use?",
);

if (answer !== expectedAnswer) {
  throw new Error(`Unexpected answer: ${answer}`);
}

const events = trace.getEvents();

const modelEvents = events.filter((event) => event.type === "model");

if (modelEvents.length !== 1) {
  throw new Error(
    `Expected exactly 1 model execution, received ${modelEvents.length}`,
  );
}

const toolEvents = events.filter((event) => event.type === "tool");

if (toolEvents.length !== 1) {
  throw new Error(
    `Expected exactly 1 tool execution, received ${toolEvents.length}`,
  );
}

if (
  toolEvents[0]?.type !== "tool" ||
  toolEvents[0].toolName !== "search_files"
) {
  throw new Error("Expected search_files to be the only tool execution");
}

console.log("PASS: agent search -> direct answer without second model call");
