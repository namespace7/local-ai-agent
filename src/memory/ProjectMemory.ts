import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface MemoryEntry {
  id: string;
  category: string;
  content: string;
  createdAt: string;
}

export class ProjectMemory {
  private entries: MemoryEntry[] = [];

  constructor(private readonly filePath: string) {}

  async load(): Promise<void> {
    try {
      const content = await readFile(this.filePath, "utf8");

      const parsed = JSON.parse(content) as unknown;

      if (!Array.isArray(parsed)) {
        throw new Error("Project memory file must contain an array");
      }

      this.entries = parsed as MemoryEntry[];
    } catch (error: unknown) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        this.entries = [];
        return;
      }

      throw error;
    }
  }

  async add(
    category: string,
    content: string,
  ): Promise<{ entry: MemoryEntry; created: boolean }> {
    const normalizedCategory = category.trim().toLowerCase();
    const normalizedContent = content.trim();

    const existingEntry = this.entries.find(
      (entry) =>
        entry.category.trim().toLowerCase() === normalizedCategory &&
        entry.content.trim().toLowerCase() === normalizedContent,
    );

    if (existingEntry) {
      return {
        entry: existingEntry,
        created: false,
      };
    }
    const entry: MemoryEntry = {
      id: crypto.randomUUID(),
      category: normalizedCategory,
      content: normalizedContent,
      createdAt: new Date().toISOString(),
    };

    this.entries.push(entry);

    await this.persist();

    return {
      entry,
      created: true,
    };
  }

  search(query: string, limit = 5): MemoryEntry[] {
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new Error("Memory search limit must be a positive integer");
    }

    const queryTokens = this.tokenize(query);

    if (queryTokens.length === 0) {
      return [];
    }

    return this.entries
      .map((entry) => {
        const searchableText =
          `${entry.category} ${entry.content}`.toLowerCase();

        const entryTokens = new Set(this.tokenize(searchableText));

        const matchedTokens = queryTokens.filter((token) =>
          entryTokens.has(token),
        );

        const score = matchedTokens.length / queryTokens.length;

        return {
          entry,
          score,
        };
      })
      .filter((result) => result.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((result) => result.entry);
  }

  private tokenize(text: string): string[] {
    const stopWords = new Set([
      "the",
      "is",
      "a",
      "an",
      "and",
      "or",
      "of",
      "to",
      "in",
      "on",
      "for",
      "this",
      "that",
      "what",
      "does",
      "do",
      "used",
      "use",
      "project",
    ]);

    return text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .split(/\s+/)
      .filter((token) => token.length > 2 && !stopWords.has(token));
  }

  all(): MemoryEntry[] {
    return [...this.entries];
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.filePath), {
      recursive: true,
    });

    await writeFile(
      this.filePath,
      JSON.stringify(this.entries, null, 2),
      "utf8",
    );
  }
}
