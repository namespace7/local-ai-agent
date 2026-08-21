import * as assert from 'node:assert/strict';
import { Agent } from '../agent/Agent.js';
import { InvestigationState } from '../agent/InvestigationState.js';
import { ToolRegistry } from '../tools/ToolRegistry.js';
import { ExecutionTrace } from '../observability/ExecutionTrace.js';
import { ProjectMemory } from '../memory/ProjectMemory.js';
import { FakeModelProvider } from './fakes/FakeModelProvider.js';
import { Workspace } from '../workspace/Workspace.js';

/**
 * Verify that the implementation‑transition prompt for a greenfield repository
 * contains the explicit investigation‑sequence guidance.
 */
async function testGreenfieldInvestigationPrompt() {
  const workspace = new Workspace('/tmp'); // dummy workspace, not used
  const tools = new ToolRegistry();
  const trace = new ExecutionTrace();
  const memory = new ProjectMemory('/tmp/.memory.json');
  const model = new FakeModelProvider([]);

  const agent = new Agent(model, tools, trace, memory, {
    maxIterations: 5,
    workspaceRoot: '/tmp',
  });

  const investigation = new InvestigationState();
  investigation.setTaskType('implementation');
  // Mark repository as greenfield – the controller will use this branch
  investigation.markGreenfieldDetected(true);

  // Build the prompt (private method accessed via casting)
  const prompt = (agent as any).buildImplementationTransitionPrompt(
    'Build the URL shortener',
    investigation,
  );

  // The prompt must contain the newly added investigation sequence block
  assert.ok(
    prompt.includes('**GREENFIELD INVESTIGATION SEQUENCE**'),
    'Prompt missing investigation sequence header',
  );
  assert.ok(
    prompt.includes('1. Use `search_files` exactly once'),
    'Prompt missing step 1',
  );
  assert.ok(
    prompt.includes('2. Then use `list_directory(".")`'),
    'Prompt missing step 2',
  );
  assert.ok(
    prompt.includes('3. Then use `read_file("REQUIREMENTS.md")`'),
    'Prompt missing step 3',
  );
  assert.ok(
    prompt.includes('Do NOT repeat `search_files`'),
    'Prompt missing duplicate‑search prohibition',
  );

  console.log('PASS: Greenfield investigation‑prompt guidance verified');
}

testGreenfieldInvestigationPrompt().catch((err) => {
  console.error('FAIL:', err);
  process.exit(1);
});
