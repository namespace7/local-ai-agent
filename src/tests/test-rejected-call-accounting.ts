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

async function testRejectedCallAccounting() {
  const workspace = new Workspace(".");
  const tools = new ToolRegistry();
  tools.register(new SearchFilesTool(workspace));
  tools.register(new ListDirectoryTool(workspace));
  tools.register(new ReadFileTool(workspace));
  tools.register(new WriteFileTool(workspace));
  tools.register(new RunCommandTool(workspace));

  // Test 1: Rejected calls do NOT consume progress iterations, and 5 consecutive rejections trigger safety limit
  {
    const trace = new ExecutionTrace();
    const memory = new ProjectMemory("./data/project-memory.json");

    // Model issues 5 consecutive rejected list_directory calls before search_files
    const model = new FakeModelProvider([
      { content: "", toolCalls: [{ id: "c1", name: "list_directory", arguments: { path: "." } }] },
      { content: "", toolCalls: [{ id: "c2", name: "list_directory", arguments: { path: "." } }] },
      { content: "", toolCalls: [{ id: "c3", name: "list_directory", arguments: { path: "." } }] },
      { content: "", toolCalls: [{ id: "c4", name: "list_directory", arguments: { path: "." } }] },
      { content: "", toolCalls: [{ id: "c5", name: "list_directory", arguments: { path: "." } }] },
    ]);

    const agent = new Agent(model, tools, trace, memory);
    let hitRejectedLimit = false;

    try {
      await agent.run("Build a new feature");
    } catch (err: any) {
      if (err.message.includes("Agent exceeded maximum consecutive rejected tool calls")) {
        hitRejectedLimit = true;
      }
    }

    if (!hitRejectedLimit) {
      throw new Error(
        "FAIL: 5 consecutive rejected tool calls MUST throw consecutive rejected limit error!",
      );
    }
    console.log("PASS: 1 & 2. Bounded rejected-call safety limit enforced");
  }

  // Test 2: A single successful tool call resets consecutiveRejectedCalls counter
  {
    const trace = new ExecutionTrace();
    const memory = new ProjectMemory("./data/project-memory.json");

    // Model issues 3 rejected calls, then a valid search_files, then 3 rejected calls, then a valid list_directory...
    const model = new FakeModelProvider([
      // 3 rejected calls
      { content: "", toolCalls: [{ id: "r1", name: "list_directory", arguments: { path: "." } }] },
      { content: "", toolCalls: [{ id: "r2", name: "list_directory", arguments: { path: "." } }] },
      { content: "", toolCalls: [{ id: "r3", name: "list_directory", arguments: { path: "." } }] },
      // 1 accepted call (search_files) -> resets consecutive counter
      { content: "", toolCalls: [{ id: "ok1", name: "search_files", arguments: { query: "local-ai-agent" } }] },
      // 3 rejected calls again (should NOT hit consecutive limit of 5 because reset occurred!)
      { content: "", toolCalls: [{ id: "r4", name: "read_file", arguments: { path: "src/index.ts" } }] },
      { content: "", toolCalls: [{ id: "r5", name: "read_file", arguments: { path: "src/index.ts" } }] },
      { content: "", toolCalls: [{ id: "r6", name: "read_file", arguments: { path: "src/index.ts" } }] },
      // 1 accepted call (list_directory)
      { content: "", toolCalls: [{ id: "ok2", name: "list_directory", arguments: { path: "." } }] },
      // read package.json
      { content: "", toolCalls: [{ id: "ok3", name: "read_file", arguments: { path: "package.json" } }] },
      // read src/index.ts
      { content: "", toolCalls: [{ id: "ok4", name: "read_file", arguments: { path: "src/index.ts" } }] },
      // read test
      { content: "", toolCalls: [{ id: "ok5", name: "read_file", arguments: { path: "src/tests/test-read-file.ts" } }] },
      // write
      { content: "", toolCalls: [{ id: "ok6", name: "write_file", arguments: { path: "src/new-feature.ts", content: "// code" } }] },
      // typecheck
      { content: "", toolCalls: [{ id: "ok7", name: "run_command", arguments: { command: "npm run typecheck" } }] },
      // test
      { content: "", toolCalls: [{ id: "ok8", name: "run_command", arguments: { command: "node --test --version" } }] },
      // finish
      { content: "Done successfully", toolCalls: [] },
    ]);

    const agent = new Agent(model, tools, trace, memory);
    const answer = await agent.run("Build a new feature in local-ai-agent");

    if (!answer.includes("Done successfully")) {
      throw new Error("FAIL: Agent should complete when successful calls reset the rejection counter!");
    }

    console.log("PASS: 3. Successful tool call resets rejected-call counter and advances progress");
  }

  // Test 3: maxIterations still prevents an actual runaway successful-tool loop
  {
    const trace = new ExecutionTrace();
    const memory = new ProjectMemory("./data/project-memory.json");

    // Complete investigation evidence first
    const responses: any[] = [
      { content: "", toolCalls: [{ id: "i1", name: "search_files", arguments: { query: "local-ai-agent" } }] },
      { content: "", toolCalls: [{ id: "i2", name: "list_directory", arguments: { path: "." } }] },
      { content: "", toolCalls: [{ id: "i3", name: "read_file", arguments: { path: "package.json" } }] },
      { content: "", toolCalls: [{ id: "i4", name: "read_file", arguments: { path: "src/index.ts" } }] },
      { content: "", toolCalls: [{ id: "i5", name: "read_file", arguments: { path: "src/tests/test-read-file.ts" } }] },
      { content: "", toolCalls: [{ id: "w1", name: "write_file", arguments: { path: "src/runaway.ts", content: "// runaway" } }] },
    ];

    // Followed by 21 accepted read_file calls during implementation phase
    for (let i = 0; i < 21; i++) {
      responses.push({
        content: "",
        toolCalls: [
          {
            id: `read-loop-${i}`,
            name: "read_file",
            arguments: {
              path: "package.json",
              startLine: 1,
              endLine: i + 1,
            },
          },
        ],
      });
    }

    const model = new FakeModelProvider(responses);
    const agent = new Agent(model, tools, trace, memory);
    let hitMaxIterations = false;

    try {
      await agent.run("Build a runaway feature requiring loop");
    } catch (err: any) {
      if (err.message.includes("Agent exceeded maximum iterations (20)")) {
        hitMaxIterations = true;
      }
    }

    if (!hitMaxIterations) {
      throw new Error("FAIL: 20 successful tool iterations MUST throw maxIterations limit error!");
    }
    console.log("PASS: 7. maxIterations still prevents runaway successful tool loop");
  }

  // Test 4: Rejection message contains tool name, reason, MUST call search_files instruction, and prohibition
  {
    const trace = new ExecutionTrace();
    const memory = new ProjectMemory("./data/project-memory.json");

    let capturedUserMessage = "";

    class MessageCapturingModel extends FakeModelProvider {
      override async generate(messages: any[], toolsDef: any) {
        const userMsg = messages.find(
          (m) =>
            m.role === "user" &&
            typeof m.content === "string" &&
            m.content.includes("REJECTED TOOL CALL"),
        );
        if (userMsg) {
          capturedUserMessage = userMsg.content;
        }
        return super.generate(messages, toolsDef);
      }
    }

    const model = new MessageCapturingModel([
      {
        content: "",
        toolCalls: [
          { id: "c1", name: "list_directory", arguments: { path: "." } },
        ],
      },
      {
        content: "",
        toolCalls: [
          { id: "ok1", name: "search_files", arguments: { query: "Todo" } },
        ],
      },
      {
        content: "",
        toolCalls: [
          { id: "ok2", name: "list_directory", arguments: { path: "." } },
        ],
      },
      {
        content: "",
        toolCalls: [
          { id: "ok3", name: "read_file", arguments: { path: "package.json" } },
        ],
      },
      {
        content: "",
        toolCalls: [
          { id: "ok4", name: "read_file", arguments: { path: "src/index.ts" } },
        ],
      },
      {
        content: "",
        toolCalls: [
          {
            id: "ok5",
            name: "read_file",
            arguments: { path: "src/tests/test-read-file.ts" },
          },
        ],
      },
      {
        content: "",
        toolCalls: [
          {
            id: "ok6",
            name: "write_file",
            arguments: { path: "src/new-feature.ts", content: "// code" },
          },
        ],
      },
      {
        content: "",
        toolCalls: [
          {
            id: "ok7",
            name: "run_command",
            arguments: { command: "npm run typecheck" },
          },
        ],
      },
      {
        content: "",
        toolCalls: [
          {
            id: "ok8",
            name: "run_command",
            arguments: { command: "node --test --version" },
          },
        ],
      },
      { content: "done", toolCalls: [] },
    ]);

    const agent = new Agent(model, tools, trace, memory);
    await agent.run("Build a Todo application");

    if (!capturedUserMessage.includes("REJECTED TOOL CALL: list_directory")) {
      throw new Error(
        "FAIL: Rejection message must contain rejected tool name!",
      );
    }
    if (
      !capturedUserMessage.includes(
        "Feature existence has not been investigated yet",
      )
    ) {
      throw new Error("FAIL: Rejection message must contain reason!");
    }
    if (!capturedUserMessage.includes("You MUST call search_files now")) {
      throw new Error(
        "FAIL: Rejection message must contain MUST call search_files instruction!",
      );
    }
    if (
      !capturedUserMessage.includes(
        "Do NOT call list_directory or read_file until search_files has executed",
      )
    ) {
      throw new Error(
        "FAIL: Rejection message must contain prohibition against repeating list_directory!",
      );
    }

    console.log(
      "PASS: 4. Rejection prompt contains tool name, reason, positive action guidance, and prohibition",
    );
  }
}

testRejectedCallAccounting();
