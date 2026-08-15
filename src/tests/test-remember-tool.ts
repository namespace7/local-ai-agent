import { ProjectMemory } from "../memory/ProjectMemory.js";
import { RememberTool } from "../memory/RememberTool.js";

const memory = new ProjectMemory("./data/test-remember-memory.json");

await memory.load();

const tool = new RememberTool(memory);

const result = await tool.execute({
  category: "browser",
  content: "This project uses Playwright for browser automation.",
});

console.log(result);

console.log("MEMORY:");
console.log(memory.all());
