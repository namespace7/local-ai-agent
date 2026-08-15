import type { Tool } from "../Tool.js";
import type { BrowserManager } from "./BrowserManager.js";

interface BrowserClickInput {
  selector: string;
}

export class BrowserClickTool implements Tool {
  readonly name = "browser_click";

  readonly description = "Click an element on the current browser page.";

  readonly parameters: Record<string, unknown> = {
    type: "object",
    properties: {
      selector: {
        type: "string",
        description: "CSS selector for the element to click.",
      },
    },
    required: ["selector"],
  };

  constructor(private readonly browser: BrowserManager) {}

  async execute(input: unknown): Promise<unknown> {
    const { selector } = this.parseInput(input);

    const page = await this.browser.getPage();

    await page.locator(selector).click();

    return {
      success: true,
      selector,
    };
  }

  private parseInput(input: unknown): BrowserClickInput {
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
      throw new Error("browser_click input must be an object");
    }

    const value = input as Record<string, unknown>;

    if (typeof value.selector !== "string" || value.selector.length === 0) {
      throw new Error("browser_click 'selector' must be a non-empty string");
    }

    return {
      selector: value.selector,
    };
  }
}
