import { readFile, writeFile, rename, unlink, stat } from "node:fs/promises";
import { dirname } from "node:path";
import type { Tool } from "./Tool.js";
import type { Workspace } from "../workspace/Workspace.js";

interface ReplaceContentInput {
  path: string;
  target: string;
  replacement: string;
}

interface ReplaceContentResult {
  path: string;
  replaced: boolean;
  bytesWritten: number;
  occurrences: number;
}

export class ReplaceContentTool implements Tool {
  readonly name = "replace_content";

  readonly description =
    "Replace an exact, unique target string in an existing workspace file with a replacement string. " +
    "Use this tool for small, targeted corrections to existing files without rewriting the entire file.";

  readonly parameters: Record<string, unknown> = {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "File path relative to the project root.",
      },
      target: {
        type: "string",
        description: "The exact unique substring in the file to replace.",
      },
      replacement: {
        type: "string",
        description: "The replacement string to insert in place of the target.",
      },
    },
    required: ["path", "target", "replacement"],
  };

  constructor(private readonly workspace: Workspace) {}

  async execute(input: unknown): Promise<unknown> {
    const parsed = this.parseInput(input);

    const filePath = this.workspace.resolvePath(parsed.path);

    const fileStat = await stat(filePath).catch((err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") {
        throw new Error(`File does not exist: '${parsed.path}'`);
      }
      throw err;
    });

    if (fileStat.isDirectory()) {
      throw new Error(`Path is a directory, not a file: '${parsed.path}'`);
    }

    const originalContent = await readFile(filePath, "utf8");

    const firstIndex = originalContent.indexOf(parsed.target);
    if (firstIndex === -1) {
      throw new Error(
        `Target content not found in file: '${parsed.path}'. Verify exact whitespace, casing, and line breaks.`,
      );
    }

    const secondIndex = originalContent.indexOf(
      parsed.target,
      firstIndex + parsed.target.length,
    );
    if (secondIndex !== -1) {
      let count = 2;
      let nextIndex = originalContent.indexOf(
        parsed.target,
        secondIndex + parsed.target.length,
      );
      while (nextIndex !== -1) {
        count += 1;
        nextIndex = originalContent.indexOf(
          parsed.target,
          nextIndex + parsed.target.length,
        );
      }
      throw new Error(
        `Target content matches ${count} locations in '${parsed.path}'. Include surrounding lines/context to make the target unique.`,
      );
    }

    const newContent =
      originalContent.slice(0, firstIndex) +
      parsed.replacement +
      originalContent.slice(firstIndex + parsed.target.length);

    const tempFilePath = `${filePath}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;

    try {
      await writeFile(tempFilePath, newContent, "utf8");
      await rename(tempFilePath, filePath);
    } catch (err) {
      await unlink(tempFilePath).catch(() => {});
      throw err;
    }

    return {
      path: parsed.path,
      replaced: true,
      bytesWritten: Buffer.byteLength(newContent, "utf8"),
      occurrences: 1,
    } satisfies ReplaceContentResult;
  }

  private parseInput(input: unknown): ReplaceContentInput {
    if (input === null || typeof input !== "object") {
      throw new Error("replace_content input must be an object");
    }

    const value = input as Record<string, unknown>;

    if (typeof value.path !== "string" || value.path.trim().length === 0) {
      throw new Error("replace_content 'path' must be a non-empty string");
    }

    if (typeof value.target !== "string" || value.target.length === 0) {
      throw new Error("replace_content 'target' must be a non-empty string");
    }

    if (typeof value.replacement !== "string") {
      throw new Error("replace_content 'replacement' must be a string");
    }

    return {
      path: value.path.trim(),
      target: value.target,
      replacement: value.replacement,
    };
  }
}
