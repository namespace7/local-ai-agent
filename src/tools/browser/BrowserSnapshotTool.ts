import type { Tool } from "../Tool.js";
import type { BrowserManager } from "./BrowserManager.js";

export class BrowserSnapshotTool implements Tool {
  readonly name = "browser_snapshot";

  readonly description =
    "Return the visible text and basic structure of the current browser page.";

  readonly parameters: Record<string, unknown> = {
    type: "object",
    properties: {},
    required: [],
  };

  constructor(private readonly browser: BrowserManager) {}

  async execute(input: unknown): Promise<unknown> {
    if (
      input !== undefined &&
      input !== null &&
      (typeof input !== "object" || Array.isArray(input))
    ) {
      throw new Error("browser_snapshot input must be an object");
    }

    const page = await this.browser.getPage();

    return {
      url: page.url(),
      title: await page.title(),
      text: await page.locator("body").innerText(),
    };
  }
}
