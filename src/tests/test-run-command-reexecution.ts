import { AgentToolExecutor } from "../agent/AgentToolExecutor.js";
import { ToolRegistry } from "../tools/ToolRegistry.js";
import { ExecutionTrace } from "../observability/ExecutionTrace.js";
import { Workspace } from "../workspace/Workspace.js";
import { RunCommandTool } from "../tools/RunCommandTool.js";
import { WriteFileTool } from "../tools/WriteFileTool.js";
import { ReadFileTool } from "../tools/ReadFileTool.js";
import { ListDirectoryTool } from "../tools/ListDirectoryTool.js";
import { SearchFilesTool } from "../tools/SearchFilesTool.js";
import { unlinkSync } from "node:fs";

async function testRunCommandReexecution() {
  const workspace = new Workspace(".");
  const tools = new ToolRegistry();
  const trace = new ExecutionTrace();

  tools.register(new RunCommandTool(workspace));
  tools.register(new WriteFileTool(workspace));
  tools.register(new SearchFilesTool(workspace));
  tools.register(new ListDirectoryTool(workspace));
  tools.register(new ReadFileTool(workspace));

  const executor = new AgentToolExecutor(tools, trace);
  const executedCalls = new Set<string>();

  // Create temporary invalid TS file causing tsc failure
  const invalidWrite = {
    id: "write-invalid",
    name: "write_file",
    arguments: { path: "src/temp-syntax-error.ts", content: "const x: = 1;" },
  };
  await executor.execute(invalidWrite, 1, executedCalls);

  try {
    // 1. First run_command execution (FAILS)
    const cmdCall1 = {
      id: "call-1",
      name: "run_command",
      arguments: { command: "npx tsc --noEmit" },
    };

    const res1 = await executor.execute(cmdCall1, 2, executedCalls);

    if (res1.duplicate) {
      throw new Error("FAIL: First run_command execution should not be marked duplicate");
    }

    const res1Result = res1.result as any;
    if (res1Result?.success !== false) {
      throw new Error("FAIL: First run_command should return success: false due to syntax error");
    }

    // Verify trace recorded failure
    const events1 = trace.getEvents();
    const cmdTrace1 = events1.find((e) => e.type === "tool" && e.iteration === 2);
    if (!cmdTrace1 || cmdTrace1.type !== "tool" || cmdTrace1.success !== false) {
      throw new Error("FAIL: ExecutionTrace should record success: false for failed run_command");
    }

    console.log("PASS: 1. First run_command execution occurred and returned failure (success: false recorded in trace)");

    // 2. Write / repair code
    const repairWrite = {
      id: "write-repair",
      name: "write_file",
      arguments: { path: "src/temp-syntax-error.ts", content: "export const x = 1;\n" },
    };

    const resWrite = await executor.execute(repairWrite, 3, executedCalls);
    if (resWrite.duplicate) {
      throw new Error("FAIL: write_file should not be duplicate");
    }

    console.log("PASS: 2. write_file / repair code occurred");

    // 3. Re-execute the EXACT SAME run_command("npx tsc --noEmit") (SUCCEEDS)
    const cmdCall2 = {
      id: "call-3",
      name: "run_command",
      arguments: { command: "npx tsc --noEmit" },
    };

    const res2 = await executor.execute(cmdCall2, 4, executedCalls);

    if (res2.duplicate) {
      throw new Error(
        "FAIL: Exact same run_command was rejected as duplicate! It must be allowed to re-execute.",
      );
    }

    const res2Result = res2.result as any;
    if (res2Result?.success !== true) {
      throw new Error(
        `FAIL: Second run_command should return success: true after repair! Output: ${res2Result?.stderr}`,
      );
    }

    // Verify trace recorded success for second execution
    const events2 = trace.getEvents();
    const cmdTrace2 = events2.find((e) => e.type === "tool" && e.iteration === 4);
    if (!cmdTrace2 || cmdTrace2.type !== "tool" || cmdTrace2.success !== true) {
      throw new Error("FAIL: ExecutionTrace should record success: true for second run_command");
    }

    console.log(
      "PASS: 3 & 4. Exact same run_command executed a second time, was invoked, and succeeded (success: true)",
    );

    // 4. Verify that read_file IS still protected against duplicates
    const readCall1 = {
      id: "read-1",
      name: "read_file",
      arguments: { path: "package.json" },
    };
    await executor.execute(readCall1, 5, executedCalls);

    const readCall2 = {
      id: "read-2",
      name: "read_file",
      arguments: { path: "package.json" },
    };
    const resRead2 = await executor.execute(readCall2, 6, executedCalls);

    if (!resRead2.duplicate) {
      throw new Error("FAIL: read_file duplicate protection should remain active!");
    }

    console.log(
      "PASS: Investigation and read_file duplicate protection remains active",
    );
  } finally {
    try {
      unlinkSync("src/temp-syntax-error.ts");
    } catch {}
  }
}

await testRunCommandReexecution();
