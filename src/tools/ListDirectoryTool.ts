import { readdir } from "node:fs/promises";
import type { Tool } from "./Tool.js";

import type { Workspace } from "../workspace/Workspace.js";
interface ListDirectoryInput {
  path?: string;
}

export class ListDirectoryTool implements Tool {
  readonly name = "list_directory";

  readonly description =
    "List files and directories inside a project directory.";

  readonly parameters: Record<string, unknown> = {
    type: "object",
    properties: {
      path: {
        type: "string",
        description:
          'Directory path relative to the project root. Use "." for the project root.',
      },
    },
    required: [],
  };

  constructor(private readonly workspace: Workspace) {}

  async execute(input: unknown): Promise<unknown> {
    const { path = "." } = this.parseInput(input);

    const directoryPath = this.workspace.resolvePath(path);
    const entries = await readdir(directoryPath, {
      withFileTypes: true,
    });

    return entries.map((entry) => ({
      name: entry.name,
      type: entry.isDirectory() ? "directory" : "file",
    }));
  }

  private parseInput(input: unknown): ListDirectoryInput {
    if (input === undefined || input === null) {
      return {};
    }

    if (typeof input !== "object") {
      throw new Error("list_directory input must be an object");
    }

    const value = input as Record<string, unknown>;

    if (value.path !== undefined && typeof value.path !== "string") {
      throw new Error("list_directory 'path' must be a string");
    }

    if (value.path === undefined) {
      return {};
    }

    return {
      path: value.path,
    };
  }
}
