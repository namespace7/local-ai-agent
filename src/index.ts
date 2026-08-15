import { Agent } from "./agent/Agent.js";
import { OllamaProvider } from "./models/OllamaProvider.js";
import { ReadFileTool } from "./tools/ReadFileTool.js";
import { ListDirectoryTool } from "./tools/ListDirectoryTool.js";
import { ToolRegistry } from "./tools/ToolRegistry.js";
import { Workspace } from "./workspace/Workspace.js";
import { BrowserManager } from "./tools/browser/BrowserManager.js";
import { BrowserNavigateTool } from "./tools/browser/BrowserNavigateTool.js";
import { BrowserSnapshotTool } from "./tools/browser/BrowserSnapshotTool.js";
import { BrowserClickTool } from "./tools/browser/BrowserClickTool.js";
import { BrowserFillTool } from "./tools/browser/BrowserFillTool.js";
import { ExecutionTrace } from "./observability/ExecutionTrace.js";
import { ProjectMemory } from "./memory/ProjectMemory.js";
import { RememberTool } from "./memory/RememberTool.js";
import { SearchFilesTool } from "./tools/SearchFilesTool.js";

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
  const memory = new ProjectMemory("./data/project-memory.json");

  tools.register(new ListDirectoryTool(workspace));
  tools.register(new ReadFileTool(workspace));
  tools.register(new SearchFilesTool(workspace));
  tools.register(new BrowserNavigateTool(browser));
  tools.register(new BrowserSnapshotTool(browser));
  tools.register(new BrowserFillTool(browser));
  tools.register(new BrowserClickTool(browser));
  tools.register(new RememberTool(memory));

  const model = new OllamaProvider();

  const trace = new ExecutionTrace();

  await memory.load();


  const agent = new Agent(model, tools, trace, memory);

  console.log("Thinking...\n");

  const answer = await agent.run(prompt);

  console.log("\n--- Execution Trace ---");

  for (const event of trace.getEvents()) {
    if (event.type === "model") {
      console.log(
        `[model] iteration=${event.iteration} ` +
          `duration=${event.durationMs}ms ` +
          `toolCalls=${event.toolCallCount}`,
      );
    } else {
      console.log(
        `[tool] iteration=${event.iteration} ` +
          `name=${event.toolName} ` +
          `duration=${event.durationMs}ms ` +
          `success=${event.success}`,
      );

      if (event.error) {
        console.log(`       error=${event.error}`);
      }
    }
  }

  console.log(`[trace] total=${trace.totalDurationMs()}ms`);

  console.log("\n" + answer);

  await browser.close();
}

main().catch((error: unknown) => {
  console.error("Agent failed:", error);
  process.exitCode = 1;
});
