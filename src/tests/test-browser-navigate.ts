import { BrowserManager } from "../tools/browser/BrowserManager.js";
import { BrowserNavigateTool } from "../tools/browser/BrowserNavigateTool.js";

const browser = new BrowserManager();
const tool = new BrowserNavigateTool(browser);

try {
  await tool.execute({
    url: "https://example.com",
  });
} catch (error) {
  console.log(
    "Blocked external URL:",
    error instanceof Error ? error.message : error,
  );
}

try {
  await tool.execute({
    url: "file:///etc/passwd",
  });
} catch (error) {
  console.log(
    "Blocked file URL:",
    error instanceof Error ? error.message : error,
  );
}

await browser.close();
