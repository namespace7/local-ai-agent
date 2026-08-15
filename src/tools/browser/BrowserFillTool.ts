import type { Tool } from "../Tool.js";
import type { BrowserManager } from "./BrowserManager.js";

interface BrowserFillInput {
  selector: string;
  value: string;
}

export class BrowserFillTool implements Tool {
  readonly name = "browser_fill";

  readonly description =
    "Fill a text input or textarea on the current browser page.";

  readonly parameters: Record<string, unknown> = {
    type: "object",
    properties: {
      selector: {
        type: "string",
        description: "CSS selector for the input element.",
      },
      value: {
        type: "string",
        description: "Text to enter into the input.",
      },
    },
    required: ["selector", "value"],
  };

  constructor(private readonly browser: BrowserManager) {}

  async execute(input: unknown): Promise<unknown> {
    const { selector, value } = this.parseInput(input);

    const page = await this.browser.getPage();

    await page.locator(selector).fill(value);

    return {
      success: true,
      selector,
      value,
    };
  }

  private parseInput(input: unknown): BrowserFillInput {
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
      throw new Error("browser_fill input must be an object");
    }

    const value = input as Record<string, unknown>;

    if (typeof value.selector !== "string" || value.selector.length === 0) {
      throw new Error("browser_fill 'selector' must be a non-empty string");
    }

    if (typeof value.value !== "string") {
      throw new Error("browser_fill 'value' must be a string");
    }

    return {
      selector: value.selector,
      value: value.value,
    };
  }
}
