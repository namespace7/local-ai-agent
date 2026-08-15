import { ListDirectoryTool } from "../tools/ListDirectoryTool.js";
import { ToolRegistry } from "../tools/ToolRegistry.js";
import { Workspace } from "../workspace/Workspace.js";

const workspace = new Workspace(".");
const registry = new ToolRegistry();

registry.register(new ListDirectoryTool(workspace));

console.log(
  registry.list().map((tool) => ({
    name: tool.name,
    description: tool.description,
  })),
);

const tool = registry.get("list_directory");

const result = await tool.execute({
  path: "src",
});

console.log(JSON.stringify(result, null, 2));

console.log(
  JSON.stringify(registry.getDefinitions(), null, 2),
);
