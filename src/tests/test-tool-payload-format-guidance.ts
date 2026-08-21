import * as assert from "node:assert/strict";
import * as path from "node:path";
import { Agent } from "../agent/Agent.js";
import { MockSequenceProvider } from "./test-agent-runner-api.js";
import { InvestigationState } from "../agent/InvestigationState.js";
import { ToolRegistry } from "../tools/ToolRegistry.js";
import { ExecutionTrace } from "../observability/ExecutionTrace.js";
import { ProjectMemory } from "../memory/ProjectMemory.js";

async function testImplementationTransitionPromptGuidance() {
  const mockProvider = new MockSequenceProvider([]);
  const tools = new ToolRegistry();
  const trace = new ExecutionTrace();
  const memory = new ProjectMemory('memory.json');
  const agent = new Agent(mockProvider, tools, trace, memory, {});

  const investigation = new InvestigationState();
  investigation.markGreenfieldDetected(true);

  const prompt = (agent as any).buildImplementationTransitionPrompt("Dummy request", investigation);

  assert.ok(prompt.includes("IMPLEMENTATION TOOL FORMAT RULES"), "Prompt should contain guidance header");
  assert.ok(prompt.includes("JSON.stringify"), "Prompt should warn against JSON.stringify");
  assert.ok(prompt.includes("`"), "Prompt should mention backticks");
  assert.ok(prompt.includes("\\n"), "Prompt should mention escaped newline");
  assert.ok(prompt.includes("write_file"), "Prompt should reference write_file tool");
  console.log("PASS: test-tool-payload-format-guidance");
}

testImplementationTransitionPromptGuidance().catch(err => {
  console.error(err);
  process.exit(1);
});
