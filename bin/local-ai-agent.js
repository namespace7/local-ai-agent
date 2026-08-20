#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const distCli = path.resolve(currentDir, "../dist/cli.js");

if (fs.existsSync(distCli)) {
  await import(distCli);
} else {
  const srcCli = path.resolve(currentDir, "../src/cli.js");
  if (fs.existsSync(srcCli)) {
    await import(srcCli);
  } else {
    console.error(
      "Error: local-ai-agent build artifact not found. Please run 'npm run build' first.",
    );
    process.exit(1);
  }
}
