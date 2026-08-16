import { ReadFileTool } from "../tools/ReadFileTool.js";
import { Workspace } from "../workspace/Workspace.js";

interface ReadFileResult {
  path: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  content: string;
}

const workspace = new Workspace(".");
const tool = new ReadFileTool(workspace);

const fullResult = (await tool.execute({
  path: "package.json",
})) as ReadFileResult;

if (
  fullResult.path !== "package.json" ||
  fullResult.startLine !== 1 ||
  fullResult.endLine !== fullResult.totalLines ||
  !fullResult.content.includes('"name": "local-ai-agent"')
) {
  throw new Error("Expected full file read to return package.json");
}

const rangeResult = (await tool.execute({
  path: "package.json",
  startLine: 6,
  endLine: 10,
})) as ReadFileResult;

if (
  rangeResult.startLine !== 6 ||
  rangeResult.endLine !== 10 ||
  !rangeResult.content.includes('"scripts": {') ||
  !rangeResult.content.includes('"dev": "tsx src/index.ts"')
) {
  throw new Error("Expected read_file to return the requested line range");
}

const startOnlyResult = (await tool.execute({
  path: "package.json",
  startLine: 6,
})) as ReadFileResult;

if (
  startOnlyResult.startLine !== 6 ||
  startOnlyResult.endLine !== startOnlyResult.totalLines
) {
  throw new Error("Expected startLine-only read to continue to EOF");
}

const endOnlyResult = (await tool.execute({
  path: "package.json",
  endLine: 5,
})) as ReadFileResult;

if (endOnlyResult.startLine !== 1 || endOnlyResult.endLine !== 5) {
  throw new Error("Expected endLine-only read to start from line 1");
}

let startAfterEndRejected = false;

try {
  await tool.execute({
    path: "package.json",
    startLine: 10,
    endLine: 5,
  });
} catch {
  startAfterEndRejected = true;
}

if (!startAfterEndRejected) {
  throw new Error("Expected startLine > endLine to be rejected");
}

let startBeyondFileRejected = false;

try {
  await tool.execute({
    path: "package.json",
    startLine: 999,
  });
} catch {
  startBeyondFileRejected = true;
}

if (!startBeyondFileRejected) {
  throw new Error("Expected startLine beyond EOF to be rejected");
}

let endBeyondFileRejected = false;

try {
  await tool.execute({
    path: "package.json",
    endLine: 999,
  });
} catch {
  endBeyondFileRejected = true;
}

if (!endBeyondFileRejected) {
  throw new Error("Expected endLine beyond EOF to be rejected");
}

let outsideWorkspaceRejected = false;

try {
  await tool.execute({
    path: "../package.json",
  });
} catch {
  outsideWorkspaceRejected = true;
}

if (!outsideWorkspaceRejected) {
  throw new Error("Expected path outside workspace to be rejected");
}

console.log("PASS: read_file full, range, validation, and workspace security");
