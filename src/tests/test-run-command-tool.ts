import { RunCommandTool } from "../tools/RunCommandTool.js";
import { Workspace } from "../workspace/Workspace.js";

async function testRunCommandTool() {
  const workspace = new Workspace(".");

  // 1. Allowed verification command (npx tsc --noEmit or node --test)
  const tool = new RunCommandTool(workspace, 5000);
  const result = await tool.execute({ command: "node --test --version" });

  if (typeof result.exitCode !== "number") {
    throw new Error("FAIL: result must contain numeric exitCode");
  }

  if (typeof result.stdout !== "string" || typeof result.stderr !== "string") {
    throw new Error("FAIL: result must contain string stdout and stderr");
  }

  if (typeof result.success !== "boolean") {
    throw new Error("FAIL: result must contain boolean success");
  }

  if (typeof result.timedOut !== "boolean") {
    throw new Error("FAIL: result must contain boolean timedOut");
  }

  console.log("PASS: RunCommandTool execution output shape");

  // 2. Reject shell chaining operators (&&, ;, |, >, <)
  const chainingCommands = [
    "npx tsc --noEmit && echo dangerous",
    "npx tsc --noEmit ; rm -rf .",
    "npx tsc --noEmit | grep error",
    "node --test > log.txt",
    "node --test < input.txt",
    "npx tsc $(whoami)",
    "npm test `id`",
  ];

  for (const cmd of chainingCommands) {
    try {
      await tool.execute({ command: cmd });
      throw new Error(`FAIL: Command '${cmd}' should have been rejected!`);
    } catch (err: any) {
      if (!err.message.includes("rejected")) {
        throw new Error(`FAIL: Unexpected error for '${cmd}': ${err.message}`);
      }
    }
  }

  console.log("PASS: RunCommandTool rejected shell chaining and redirection operators");

  // 3. Reject forbidden binaries (sudo, rm, curl, wget, sh, etc.)
  const forbiddenCommands = [
    "sudo npx tsc",
    "rm -rf src",
    "curl http://example.com",
    "wget http://example.com",
    "sh -c 'echo hi'",
  ];

  for (const cmd of forbiddenCommands) {
    try {
      await tool.execute({ command: cmd });
      throw new Error(`FAIL: Forbidden command '${cmd}' should have been rejected!`);
    } catch (err: any) {
      if (!err.message.includes("rejected")) {
        throw new Error(`FAIL: Unexpected error for '${cmd}': ${err.message}`);
      }
    }
  }

  console.log("PASS: RunCommandTool rejected forbidden executables");

  // 4. Reject un-whitelisted commands and boundary extension tricks
  const boundaryCommands = [
    "python3 --version",
    "npm run typecheck-malicious",
    "npm testSomething",
    "npx tsc-malicious",
    "node --test-malicious",
  ];

  for (const cmd of boundaryCommands) {
    try {
      await tool.execute({ command: cmd });
      throw new Error(`FAIL: Command '${cmd}' should have been rejected by allowlist!`);
    } catch (err: any) {
      if (!err.message.includes("not in the allowed verification command list")) {
        throw new Error(`FAIL: Unexpected error for '${cmd}': ${err.message}`);
      }
    }
  }

  console.log("PASS: RunCommandTool rejected un-whitelisted commands and boundary prefix extensions");

  // 5. Test timeout handling
  const shortTimeoutTool = new RunCommandTool(workspace, 1);
  const timeoutResult = await shortTimeoutTool.execute({
    command: "npx tsc --noEmit",
  });

  if (!timeoutResult.timedOut || timeoutResult.success) {
    throw new Error("FAIL: Expected process to time out");
  }

  console.log("PASS: RunCommandTool timeout handling");
}

await testRunCommandTool();
