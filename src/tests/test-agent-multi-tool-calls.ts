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
import { existsSync, unlinkSync } from "fs";

async function testMultiToolCalls() {
  const workspace = new Workspace(".");
  const tools = new ToolRegistry();
  tools.register(new SearchFilesTool(workspace));
  tools.register(new ListDirectoryTool(workspace));
  tools.register(new ReadFileTool(workspace));
  tools.register(new WriteFileTool(workspace));
  tools.register(new RunCommandTool(workspace));

  // Clean up any test artifacts
  const cleanFiles = () => {
    if (existsSync("src/test-multi-a.ts")) unlinkSync("src/test-multi-a.ts");
    if (existsSync("src/test-multi-b.ts")) unlinkSync("src/test-multi-b.ts");
    if (existsSync("src/test-multi-c.ts")) unlinkSync("src/test-multi-c.ts");
  };

  cleanFiles();

  try {
    // Test 1: Multiple write_file calls in one assistant response during implementation phase
    {
      cleanFiles();
      const trace = new ExecutionTrace();
      const memory = new ProjectMemory("./data/project-memory.json");

      const model = new FakeModelProvider([
        // Investigation phase
        { content: "", toolCalls: [{ id: "i1", name: "search_files", arguments: { query: "local-ai-agent" } }] },
        { content: "", toolCalls: [{ id: "i2", name: "list_directory", arguments: { path: "." } }] },
        { content: "", toolCalls: [{ id: "i3", name: "read_file", arguments: { path: "package.json" } }] },
        { content: "", toolCalls: [{ id: "i4", name: "read_file", arguments: { path: "src/index.ts" } }] },
        { content: "", toolCalls: [{ id: "i5", name: "read_file", arguments: { path: "src/tests/test-read-file.ts" } }] },
        // Implementation phase: returns TWO write_file calls in a single turn!
        {
          content: "",
          toolCalls: [
            { id: "w1", name: "write_file", arguments: { path: "src/test-multi-a.ts", content: "// a" } },
            { id: "w2", name: "write_file", arguments: { path: "src/test-multi-b.ts", content: "// b" } },
          ],
        },
        // Verification phase
        { content: "", toolCalls: [{ id: "v1", name: "run_command", arguments: { command: "npm run typecheck" } }] },
        { content: "", toolCalls: [{ id: "v2", name: "run_command", arguments: { command: "node --test --version" } }] },
        { content: "done", toolCalls: [] },
      ]);

      const agent = new Agent(model, tools, trace, memory);
      await agent.run("Build feature requiring multi-file write");

      if (!existsSync("src/test-multi-a.ts") || !existsSync("src/test-multi-b.ts")) {
        throw new Error(
          `FAIL: BOTH src/test-multi-a.ts and src/test-multi-b.ts must exist after multi-tool turn! (a: ${existsSync("src/test-multi-a.ts")}, b: ${existsSync("src/test-multi-b.ts")})`,
        );
      }

      console.log("PASS: 1. Multiple write_file calls in single response executed both writes");
    }

    // Test 2: Mixed write_file and read_file calls in one assistant response
    {
      cleanFiles();
      const trace = new ExecutionTrace();
      const memory = new ProjectMemory("./data/project-memory.json");

      const model = new FakeModelProvider([
        { content: "", toolCalls: [{ id: "i1", name: "search_files", arguments: { query: "local-ai-agent" } }] },
        { content: "", toolCalls: [{ id: "i2", name: "list_directory", arguments: { path: "." } }] },
        { content: "", toolCalls: [{ id: "i3", name: "read_file", arguments: { path: "package.json" } }] },
        { content: "", toolCalls: [{ id: "i4", name: "read_file", arguments: { path: "src/index.ts" } }] },
        { content: "", toolCalls: [{ id: "i5", name: "read_file", arguments: { path: "src/tests/test-read-file.ts" } }] },
        // Mixed: write a, write b, read a in single turn
        {
          content: "",
          toolCalls: [
            { id: "m1", name: "write_file", arguments: { path: "src/test-multi-a.ts", content: "// a" } },
            { id: "m2", name: "write_file", arguments: { path: "src/test-multi-b.ts", content: "// b" } },
            { id: "m3", name: "read_file", arguments: { path: "src/test-multi-a.ts" } },
          ],
        },
        { content: "", toolCalls: [{ id: "v1", name: "run_command", arguments: { command: "npm run typecheck" } }] },
        { content: "", toolCalls: [{ id: "v2", name: "run_command", arguments: { command: "node --test --version" } }] },
        { content: "done", toolCalls: [] },
      ]);

      const agent = new Agent(model, tools, trace, memory);
      await agent.run("Build mixed multi-tool feature");

      if (!existsSync("src/test-multi-a.ts") || !existsSync("src/test-multi-b.ts")) {
        throw new Error("FAIL: Both files must exist after mixed multi-tool turn!");
      }

      console.log("PASS: 2. Mixed write and read calls in single response executed correctly");
    }

    // Test 3: Mixed accepted/rejected case in implementation phase
    {
      cleanFiles();
      const trace = new ExecutionTrace();
      const memory = new ProjectMemory("./data/project-memory.json");

      // Returns write a (allowed), list_directory (rejected in implementation phase), write c (allowed)
      const model = new FakeModelProvider([
        { content: "", toolCalls: [{ id: "i1", name: "search_files", arguments: { query: "local-ai-agent" } }] },
        { content: "", toolCalls: [{ id: "i2", name: "list_directory", arguments: { path: "." } }] },
        { content: "", toolCalls: [{ id: "i3", name: "read_file", arguments: { path: "package.json" } }] },
        { content: "", toolCalls: [{ id: "i4", name: "read_file", arguments: { path: "src/index.ts" } }] },
        { content: "", toolCalls: [{ id: "i5", name: "read_file", arguments: { path: "src/tests/test-read-file.ts" } }] },
        {
          content: "",
          toolCalls: [
            { id: "x1", name: "write_file", arguments: { path: "src/test-multi-a.ts", content: "// a" } },
            { id: "x2", name: "list_directory", arguments: { path: "." } }, // rejected in implementation phase
            { id: "x3", name: "write_file", arguments: { path: "src/test-multi-c.ts", content: "// c" } },
          ],
        },
        { content: "", toolCalls: [{ id: "v1", name: "run_command", arguments: { command: "npm run typecheck" } }] },
        { content: "", toolCalls: [{ id: "v2", name: "run_command", arguments: { command: "node --test --version" } }] },
        { content: "done", toolCalls: [] },
      ]);

      const agent = new Agent(model, tools, trace, memory);
      await agent.run("Build mixed policy feature");

      if (!existsSync("src/test-multi-a.ts") || !existsSync("src/test-multi-c.ts")) {
        throw new Error(
          `FAIL: Rejection of list_directory MUST NOT discard write_file for c! (a: ${existsSync("src/test-multi-a.ts")}, c: ${existsSync("src/test-multi-c.ts")})`,
        );
      }

      console.log("PASS: 3. Policy rejections apply per call without discarding valid calls");
    }
  } finally {
    cleanFiles();
  }
}

testMultiToolCalls();
