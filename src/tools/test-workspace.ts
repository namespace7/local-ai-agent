import { Workspace } from "../workspace/Workspace.js";

const workspace = new Workspace(".");

console.log(workspace.resolvePath("package.json"));
console.log(workspace.resolvePath("src/index.ts"));

try {
  workspace.resolvePath("../package.json");
} catch (error) {
  console.log("Blocked:", error instanceof Error ? error.message : error);
}

try {
  workspace.resolvePath("/etc/passwd");
} catch (error) {
  console.log("Blocked:", error instanceof Error ? error.message : error);
}
