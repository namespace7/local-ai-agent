import { SearchFilesTool } from "../tools/SearchFilesTool.js";
import { Workspace } from "../workspace/Workspace.js";

const workspace = new Workspace(".");
const tool = new SearchFilesTool(workspace);

interface SearchMatch {
  path: string;
  line: number;
  text: string;
}

interface SearchResult {
  query: string;
  path: string;
  matches: SearchMatch[];
  truncated: boolean;
}

const exactResult = (await tool.execute({
  query: "3001",
})) as SearchResult;

if (
  !exactResult.matches.some(
    (match) =>
      match.path === "src/tests/browser-fixture/server.ts" && match.line === 58,
  )
) {
  throw new Error("Expected exact search to find port 3001");
}

const tokenResult = (await tool.execute({
  query: "server listen",
})) as SearchResult;

if (
  !tokenResult.matches.some(
    (match) =>
      match.path === "src/tests/browser-fixture/server.ts" && match.line === 58,
  )
) {
  throw new Error(
    'Expected token search for "server listen" to find server.listen',
  );
}

console.log("PASS: search_files exact and token search");
