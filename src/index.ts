import { Agent } from "./agent/Agent.js";
import { OllamaProvider } from "./models/OllamaProvider.js";
import { ReadFileTool } from "./tools/ReadFileTool.js";
import { ListDirectoryTool } from "./tools/ListDirectoryTool.js";
import { ToolRegistry } from "./tools/ToolRegistry.js";
import { Workspace } from "./workspace/Workspace.js";
import { BrowserManager } from "./tools/browser/BrowserManager.js";
import { BrowserNavigateTool } from "./tools/browser/BrowserNavigateTool.js";
import { BrowserSnapshotTool } from "./tools/browser/BrowserSnapshotTool.js";

async function main(): Promise<void> {
  const prompt = process.argv.slice(2).join(" ");

  if (!prompt) {
    console.error('Usage: npm run dev -- "your prompt"');
    process.exitCode = 1;
    return;
  }

  const workspace = new Workspace(".");

  const browser = new BrowserManager();

  const tools = new ToolRegistry();

  tools.register(new ListDirectoryTool(workspace));
  tools.register(new ReadFileTool(workspace));
  tools.register(new BrowserNavigateTool(browser));
  tools.register(new BrowserSnapshotTool(browser));

  const model = new OllamaProvider();

  const agent = new Agent(model, tools);

  console.log("Thinking...\n");

  const answer = await agent.run(prompt);

  console.log("\n" + answer);

  await browser.close();
}

main().catch((error: unknown) => {
  console.error("Agent failed:", error);
  process.exitCode = 1;
});
