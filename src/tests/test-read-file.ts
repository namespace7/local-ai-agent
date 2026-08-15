import { ReadFileTool } from "../tools/ReadFileTool.js";
import { Workspace } from "../workspace/Workspace.js";

const workspace = new Workspace(".");
const tool = new ReadFileTool(workspace);

const packageJson = await tool.execute({
  path: "package.json",
});

console.log("package.json:");
console.log(packageJson);

try {
  await tool.execute({
    path: "../package.json",
  });
} catch (error) {
  console.log("Blocked:", error instanceof Error ? error.message : error);
}
