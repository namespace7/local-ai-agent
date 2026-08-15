import { SearchFilesTool } from "../tools/SearchFilesTool.js";
import { Workspace } from "../workspace/Workspace.js";

const workspace = new Workspace(".");
const tool = new SearchFilesTool(workspace);

console.log(
  await tool.execute({
    query: "3001",
  }),
);
