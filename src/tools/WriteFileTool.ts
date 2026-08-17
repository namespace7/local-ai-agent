import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Tool } from "./Tool.js";
import type { Workspace } from "../workspace/Workspace.js";

interface WriteFileInput {
  path: string;
  content: string;
}

interface WriteFileResult {
  path: string;
  bytesWritten: number;
  createdDirectories: boolean;
}

export class WriteFileTool implements Tool {
  readonly name = "write_file";

  readonly description =
    "Create or completely replace a text file inside the project workspace. " +
    "Use a workspace-relative path. Parent directories are created automatically.";

  readonly parameters: Record<string, unknown> = {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "File path relative to the project root.",
      },
      content: {
        type: "string",
        description: "Complete UTF-8 text content to write to the file.",
      },
    },
    required: ["path", "content"],
  };

  constructor(private readonly workspace: Workspace) {}

  async execute(input: unknown): Promise<unknown> {
    const parsed = this.parseInput(input);

    const filePath = this.workspace.resolvePath(parsed.path);

    await mkdir(dirname(filePath), {
      recursive: true,
    });

    await writeFile(filePath, parsed.content, "utf8");

    return {
      path: parsed.path,
      bytesWritten: Buffer.byteLength(parsed.content, "utf8"),
      createdDirectories: true,
    } satisfies WriteFileResult;
  }

  private parseInput(input: unknown): WriteFileInput {
    if (input === null || typeof input !== "object") {
      throw new Error("write_file input must be an object");
    }

    const value = input as Record<string, unknown>;

    if (typeof value.path !== "string" || value.path.trim().length === 0) {
      throw new Error("write_file 'path' must be a non-empty string");
    }

    if (typeof value.content !== "string") {
      throw new Error("write_file 'content' must be a string");
    }

    return {
      path: value.path.trim(),
      content: value.content,
    };
  }
}
