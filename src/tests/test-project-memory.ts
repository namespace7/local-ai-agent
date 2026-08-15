import { rm } from "node:fs/promises";
import { ProjectMemory } from "../memory/ProjectMemory.js";

const memoryPath = "./data/test-memory.json";

await rm(memoryPath, {
  force: true,
});

const memory = new ProjectMemory(memoryPath);

await memory.load();

await memory.add("project", "This is a TypeScript Node.js project.");

await memory.add(
  "model",
  "The local model is qwen3:8b running through Ollama.",
);

await memory.add("browser", "Playwright is used for browser automation.");

console.log("ALL:");
console.log(memory.all());

console.log("\nSEARCH: model");
console.log(memory.search("model"));

console.log("\nSEARCH: Playwright");
console.log(memory.search("Playwright"));

console.log(
  "SEARCH: natural language",
  memory.search("What browser automation technology does this project use?"),
);

console.log(
  "SEARCH: local model question",
  memory.search("What is the local model used by this project?"),
);

const first = await memory.add(
  "browser",
  "This project uses Playwright for browser automation.",
);

const second = await memory.add(
  "BROWSER",
  "This project uses Playwright for browser automation.",
);

console.log("SAME ID:", first.entry.id === second.entry.id);
console.log("CREATED FIRST:", first.created);
console.log("CREATED SECOND:", second.created);
console.log("TOTAL:", memory.all().length);

console.log("LIMIT 1:", memory.search("project model browser", 1));

await memory.add(
  "browser",
  "The browser integration test fixture runs on port 3001.",
);

const reloadedMemory = new ProjectMemory(memoryPath);

await reloadedMemory.load();

console.log(
  "RELOADED:",
  reloadedMemory.search("browser integration test fixture port"),
);
