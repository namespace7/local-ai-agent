import { readFile } from "node:fs/promises";
import type { Tool } from "./Tool.js";
import type { Workspace } from "../workspace/Workspace.js";

interface ReadFileInput {
  path: string;
  startLine?: number;
  endLine?: number;
}

interface ReadFileResult {
  path: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  content: string;
}

export class ReadFileTool implements Tool {
  readonly name = "read_file";

  readonly description =
    "Read the text contents of a file inside the project workspace. Supports optional line ranges for focused inspection.";

  readonly parameters: Record<string, unknown> = {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "File path relative to the project root.",
      },
      startLine: {
        type: "number",
        description:
          "Optional 1-based starting line. Defaults to the first line.",
      },
      endLine: {
        type: "number",
        description:
          "Optional 1-based ending line, inclusive. Defaults to the last line.",
      },
    },
    required: ["path"],
  };

  constructor(private readonly workspace: Workspace) {}

  async execute(input: unknown): Promise<unknown> {
    const parsed = this.parseInput(input);

    const filePath = this.workspace.resolvePath(parsed.path);
    const content = await readFile(filePath, "utf8");

    const lines = content.split(/\r?\n/);
    const totalLines = lines.length;

    const startLine = parsed.startLine ?? 1;
    const endLine = parsed.endLine ?? totalLines;

    if (startLine > totalLines) {
      throw new Error(
        `read_file 'startLine' ${startLine} exceeds file length ${totalLines}`,
      );
    }

    if (endLine > totalLines) {
      throw new Error(
        `read_file 'endLine' ${endLine} exceeds file length ${totalLines}`,
      );
    }

    const selectedLines = lines.slice(startLine - 1, endLine);

    const result: ReadFileResult = {
      path: parsed.path,
      startLine,
      endLine,
      totalLines,
      content: selectedLines.join("\n"),
    };

    return result;
  }

  private parseInput(input: unknown): ReadFileInput {
    if (input === null || typeof input !== "object") {
      throw new Error("read_file input must be an object");
    }

    const value = input as Record<string, unknown>;

    if (typeof value.path !== "string" || value.path.trim().length === 0) {
      throw new Error("read_file 'path' must be a non-empty string");
    }

    if (
      value.startLine !== undefined &&
      (typeof value.startLine !== "number" ||
        !Number.isInteger(value.startLine) ||
        value.startLine <= 0)
    ) {
      throw new Error("read_file 'startLine' must be a positive integer");
    }

    if (
      value.endLine !== undefined &&
      (typeof value.endLine !== "number" ||
        !Number.isInteger(value.endLine) ||
        value.endLine <= 0)
    ) {
      throw new Error("read_file 'endLine' must be a positive integer");
    }

    if (
      value.startLine !== undefined &&
      value.endLine !== undefined &&
      value.startLine > value.endLine
    ) {
      throw new Error("read_file 'startLine' cannot exceed 'endLine'");
    }

    const result: ReadFileInput = {
      path: value.path.trim(),
    };

    if (value.startLine !== undefined) {
      result.startLine = value.startLine;
    }

    if (value.endLine !== undefined) {
      result.endLine = value.endLine;
    }

    return result;
  }
}
