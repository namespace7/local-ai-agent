import type { Tool } from "../Tool.js";
import type { BrowserManager } from "./BrowserManager.js";

interface BrowserNavigateInput {
  url: string;
}

export class BrowserNavigateTool implements Tool {
  readonly name = "browser_navigate";

  readonly description =
    "Navigate the browser to a local web page and return basic information about the loaded page.";

  readonly parameters: Record<string, unknown> = {
    type: "object",
    properties: {
      url: {
        type: "string",
        description:
          "The URL to navigate to. Only localhost and 127.0.0.1 URLs are allowed.",
      },
    },
    required: ["url"],
  };

  constructor(private readonly browser: BrowserManager) {}

  async execute(input: unknown): Promise<unknown> {
    const { url } = this.parseInput(input);

    this.validateUrl(url);

    const page = await this.browser.getPage();

    const response = await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 15_000,
    });

    return {
      url: page.url(),
      title: await page.title(),
      status: response?.status() ?? null,
    };
  }

  private parseInput(input: unknown): BrowserNavigateInput {
    if (input === null || typeof input !== "object") {
      throw new Error("browser_navigate input must be an object");
    }

    const value = input as Record<string, unknown>;

    if (typeof value.url !== "string" || value.url.length === 0) {
      throw new Error("browser_navigate 'url' must be a non-empty string");
    }

    return {
      url: value.url,
    };
  }

  private validateUrl(url: string): void {
    let parsed: URL;

    try {
      parsed = new URL(url);
    } catch {
      throw new Error("Invalid URL");
    }

    const allowedHosts = new Set(["localhost", "127.0.0.1"]);

    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("Only HTTP and HTTPS URLs are allowed");
    }

    if (!allowedHosts.has(parsed.hostname)) {
      throw new Error(
        "Browser navigation is currently restricted to localhost and 127.0.0.1",
      );
    }
  }
}
