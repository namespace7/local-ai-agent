import { BrowserManager } from "../tools/browser/BrowserManager.js";
import { BrowserNavigateTool } from "../tools/browser/BrowserNavigateTool.js";
import { BrowserSnapshotTool } from "../tools/browser/BrowserSnapshotTool.js";

const browser = new BrowserManager();

const navigate = new BrowserNavigateTool(browser);
const snapshot = new BrowserSnapshotTool(browser);

try {
  console.log(
    await navigate.execute({
      url: "http://127.0.0.1:3001",
    }),
  );

  console.log(await snapshot.execute({}));
} finally {
  await browser.close();
}
