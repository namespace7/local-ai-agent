import { chromium, type Browser, type Page } from "playwright";

export class BrowserManager {
  private browser: Browser | null = null;
  private page: Page | null = null;

  async getPage(): Promise<Page> {
    if (this.page) {
      return this.page;
    }

    this.browser = await chromium.launch({
      headless: true,
    });

    const context = await this.browser.newContext();

    this.page = await context.newPage();

    return this.page;
  }

  async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      this.page = null;
    }
  }
}
