import { BrowserManager } from "../tools/browser/BrowserManager.js";
import { BrowserNavigateTool } from "../tools/browser/BrowserNavigateTool.js";
import { BrowserSnapshotTool } from "../tools/browser/BrowserSnapshotTool.js";
import { BrowserFillTool } from "../tools/browser/BrowserFillTool.js";
import { BrowserClickTool } from "../tools/browser/BrowserClickTool.js";

const browser = new BrowserManager();

const navigate = new BrowserNavigateTool(browser);
const snapshot = new BrowserSnapshotTool(browser);
const fill = new BrowserFillTool(browser);
const click = new BrowserClickTool(browser);

try {
  console.log(
    await navigate.execute({
      url: "http://127.0.0.1:3001",
    }),
  );

  console.log("BEFORE:");
  console.log(await snapshot.execute({}));

  await fill.execute({
    selector: "#name",
    value: "Yashwant",
  });

  await click.execute({
    selector: "#submit",
  });

  console.log("AFTER:");
  console.log(await snapshot.execute({}));
} finally {
  await browser.close();
}
