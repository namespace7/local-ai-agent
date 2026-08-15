import { readFile, readdir } from "node:fs/promises";
import type { Dirent } from "node:fs";
import type { Tool } from "./Tool.js";
import type { Workspace } from "../workspace/Workspace.js";

interface SearchFilesInput {
  query: string;
  path?: string;
  maxResults?: number;
}

interface SearchMatch {
  path: string;
  line: number;
  text: string;
}

export class SearchFilesTool implements Tool {
  readonly name = "search_files";

  readonly description =
    "Search project file paths and file contents for an exact text pattern. " +
    "Prefer one distinctive search term at a time, such as a filename, " +
    "function name, URL, identifier, or exact value. " +
    'For example, search "browser-fixture" to find the browser fixture directory, ' +
    'or "server.listen" to find where a test server starts.';

  readonly parameters: Record<string, unknown> = {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Text to search for inside project files.",
      },
      path: {
        type: "string",
        description:
          'Optional directory path relative to the project root. Defaults to ".".',
      },
      maxResults: {
        type: "number",
        description:
          "Maximum number of matching lines to return. Defaults to 20.",
      },
    },
    required: ["query"],
  };

  constructor(private readonly workspace: Workspace) {}

  async execute(input: unknown): Promise<unknown> {
    const { query, path = ".", maxResults = 20 } = this.parseInput(input);

    const rootPath = this.workspace.resolvePath(path);

    const matches: SearchMatch[] = [];

    await this.searchDirectory(
      rootPath,
      query.toLowerCase(),
      matches,
      maxResults,
    );

    return {
      query,
      path,
      matches,
      truncated: matches.length >= maxResults,
    };
  }

  private async searchDirectory(
    directoryPath: string,
    query: string,
    matches: SearchMatch[],
    maxResults: number,
  ): Promise<void> {
    if (matches.length >= maxResults) {
      return;
    }

    const entries = await readdir(directoryPath, {
      withFileTypes: true,
    });

    for (const entry of entries) {
      if (matches.length >= maxResults) {
        return;
      }

      if (this.shouldIgnore(entry)) {
        continue;
      }

      const entryPath = `${directoryPath}/${entry.name}`;

      if (entry.isDirectory()) {
        await this.searchDirectory(entryPath, query, matches, maxResults);

        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      const relativePath = this.workspace.relativePath(entryPath);

      const queryPattern = new RegExp(`\\b${this.escapeRegExp(query)}\\b`, "i");

      if (queryPattern.test(relativePath)) {
        matches.push({
          path: relativePath,
          line: 0,
          text: `[filename match] ${relativePath}`,
        });

        if (matches.length >= maxResults) {
          return;
        }
      }

      await this.searchFile(entryPath, query, matches, maxResults);
    }
  }

  private async searchFile(
    filePath: string,
    query: string,
    matches: SearchMatch[],
    maxResults: number,
  ): Promise<void> {
    if (matches.length >= maxResults) {
      return;
    }

    const content = await readFile(filePath, "utf8");

    const lines = content.split(/\r?\n/);

    const queryTokens = query.toLowerCase().split(/\s+/).filter(Boolean);

    for (let index = 0; index < lines.length; index += 1) {
      if (matches.length >= maxResults) {
        return;
      }

      const line = lines[index];

      if (line === undefined) {
        continue;
      }

      const lineText = line.toLowerCase();

      const matchesQuery = queryTokens.every((token) =>
        lineText.includes(token),
      );

      if (matchesQuery) {
        matches.push({
          path: this.workspace.relativePath(filePath),
          line: index + 1,
          text: line.trim(),
        });
      }
    }
  }

  private shouldIgnore(entry: Dirent): boolean {
    return (
      entry.name === "node_modules" ||
      entry.name === ".git" ||
      entry.name === "dist"
    );
  }

  private escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  private parseInput(input: unknown): SearchFilesInput {
    if (input === null || typeof input !== "object") {
      throw new Error("search_files input must be an object");
    }

    const value = input as Record<string, unknown>;

    if (typeof value.query !== "string" || value.query.trim().length === 0) {
      throw new Error("search_files 'query' must be a non-empty string");
    }

    if (value.path !== undefined && typeof value.path !== "string") {
      throw new Error("search_files 'path' must be a string");
    }

    if (
      value.maxResults !== undefined &&
      (typeof value.maxResults !== "number" ||
        !Number.isInteger(value.maxResults) ||
        value.maxResults <= 0)
    ) {
      throw new Error("search_files 'maxResults' must be a positive integer");
    }

    const result: SearchFilesInput = {
      query: value.query.trim(),
    };

    if (value.path !== undefined) {
      result.path = value.path;
    }

    if (value.maxResults !== undefined) {
      result.maxResults = value.maxResults;
    }

    return result;
  }
}
