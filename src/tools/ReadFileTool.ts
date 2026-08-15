import { readFile } from "node:fs/promises";
import type { Tool } from "./Tool.js";
import type { Workspace } from "../workspace/Workspace.js";

interface ReadFileInput {
  path: string;
}

export class ReadFileTool implements Tool {
  readonly name = "read_file";

  readonly description =
    "Read the text contents of a file inside the project workspace.";

  readonly parameters: Record<string, unknown> = {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "File path relative to the project root.",
      },
    },
    required: ["path"],
  };

  constructor(private readonly workspace: Workspace) {}

  async execute(input: unknown): Promise<unknown> {
    const { path } = this.parseInput(input);

    const filePath = this.workspace.resolvePath(path);

    return readFile(filePath, "utf8");
  }

  private parseInput(input: unknown): ReadFileInput {
    if (input === null || typeof input !== "object") {
      throw new Error("read_file input must be an object");
    }

    const value = input as Record<string, unknown>;

    if (typeof value.path !== "string" || value.path.length === 0) {
      throw new Error("read_file 'path' must be a non-empty string");
    }

    return {
      path: value.path,
    };
  }
}
