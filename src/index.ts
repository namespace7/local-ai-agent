import { OllamaProvider } from "./models/OllamaProvider.js";

async function main(): Promise<void> {
  const prompt = process.argv.slice(2).join(" ");

  if (!prompt) {
    console.error('Usage: npm run dev -- "your prompt"');
    process.exitCode = 1;
    return;
  }

  const model = new OllamaProvider();

  console.log("Thinking...\n");

  const answer = await model.generate(prompt);

  console.log(answer);
}

main().catch((error: unknown) => {
  console.error("Agent failed:", error);
  process.exitCode = 1;
});
