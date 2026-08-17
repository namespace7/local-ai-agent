import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { WriteFileTool } from "../tools/WriteFileTool.js";
import { Workspace } from "../workspace/Workspace.js";

const root = await mkdtemp(join(tmpdir(), "local-ai-agent-write-test-"));

try {
  const workspace = new Workspace(root);
  const tool = new WriteFileTool(workspace);

  const result = await tool.execute({
    path: "src/todo/Todo.ts",
    content: "export interface Todo { id: string; }\n",
  });

  const createdPath = join(root, "src/todo/Todo.ts");

  const content = await readFile(createdPath, "utf8");

  if (content !== "export interface Todo { id: string; }\n") {
    throw new Error("write_file did not write the expected content");
  }

  const typedResult = result as {
    path: string;
    bytesWritten: number;
    createdDirectories: boolean;
  };

  if (typedResult.path !== "src/todo/Todo.ts") {
    throw new Error("Unexpected result path");
  }

  if (typedResult.bytesWritten <= 0) {
    throw new Error("Expected bytesWritten to be positive");
  }

  let traversalRejected = false;

  try {
    await tool.execute({
      path: "../outside.txt",
      content: "should fail",
    });
  } catch {
    traversalRejected = true;
  }

  if (!traversalRejected) {
    throw new Error("Expected path traversal to be rejected");
  }

  let absolutePathRejected = false;

  try {
    await tool.execute({
      path: "/tmp/outside.txt",
      content: "should fail",
    });
  } catch {
    absolutePathRejected = true;
  }

  if (!absolutePathRejected) {
    throw new Error("Expected absolute path to be rejected");
  }

  console.log(
    "PASS: write_file creation, nested directories, and workspace security",
  );
} finally {
  await rm(root, {
    recursive: true,
    force: true,
  });
}
