import type { Tool } from "../tools/Tool.js";
import type { ProjectMemory } from "./ProjectMemory.js";

interface RememberInput {
  category: string;
  content: string;
}

export class RememberTool implements Tool {
  readonly name = "remember";

  readonly description =
    "Store a useful project fact in persistent project memory. Only remember stable, useful facts that may help with future tasks.";

  readonly parameters = {
    type: "object",
    properties: {
      category: {
        type: "string",
        description:
          "Short category such as project, architecture, model, browser, or configuration.",
      },
      content: {
        type: "string",
        description: "The concise project fact that should be remembered.",
      },
    },
    required: ["category", "content"],
  };

  constructor(private readonly memory: ProjectMemory) {}

  async execute(input: unknown): Promise<unknown> {
    const parsed = this.parseInput(input);

    const result = await this.memory.add(parsed.category, parsed.content);

    return {
      success: true,
      stored: result.created,
      alreadyExists: !result.created,
      id: result.entry.id,
      category: result.entry.category,
      content: result.entry.content,
      message: result.created
        ? "Memory saved successfully. Do not call remember again for the same fact."
        : "This fact is already stored in project memory. Do not call remember again.",
    };
  }

  private parseInput(input: unknown): RememberInput {
    if (input === null || typeof input !== "object") {
      throw new Error("remember input must be an object");
    }

    const value = input as Record<string, unknown>;

    if (typeof value.category !== "string" || value.category.trim() === "") {
      throw new Error("remember 'category' must be a non-empty string");
    }

    if (typeof value.content !== "string" || value.content.trim() === "") {
      throw new Error("remember 'content' must be a non-empty string");
    }

    return {
      category: value.category.trim(),
      content: value.content.trim(),
    };
  }
}
