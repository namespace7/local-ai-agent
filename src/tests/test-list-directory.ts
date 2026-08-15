import { ListDirectoryTool } from "../tools/ListDirectoryTool.js";
import { Workspace } from "../workspace/Workspace.js";

const workspace = new Workspace(".");

const tool = new ListDirectoryTool(workspace);

const result = await tool.execute({
  path: ".",
});

console.log(JSON.stringify(result, null, 2));
