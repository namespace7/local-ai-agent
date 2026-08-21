/**
 * src/tests/run-all-tests.ts
 *
 * Canonical test runner executing all 28 deterministic unit and regression test suites.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(currentDir, "../..");

const DETERMINISTIC_TEST_FILES = [
  "test-cli.ts",
  "test-agent-runner-api.ts",
  "test-agent-task-type-detection.ts",
  "test-greenfield-investigation.ts",
  "test-repair-evidence-unlocked-transition.ts",
  "test-repair-navigation.ts",
  "test-agent-verification-controller.ts",
  "test-agent-evidence-rules.ts",
  "test-agent-max-iterations.ts",
  "test-agent-multi-tool-calls.ts",
  "test-agent-run-command-messages.ts",
  "test-rejected-call-accounting.ts",
  "test-run-command-reexecution.ts",
  "test-test-evidence-linkage.ts",
  "test-verification-state-transitions.ts",
  "test-write-file.ts",
  "test-run-command-tool.ts",
  "test-replace-content-tool.ts",
  "test-agent-replace-content.ts",
  "test-repair-echo.ts",
  "test-ollama-provider-tool-parsing.ts",
  "test-duplicate-read-repair-evidence.ts",
  "test-agent-investigation.ts",
  "test-agent-search-direct-answer.ts",
  "test-category-verification.ts",
  "test-configuration-evidence-invariant.ts",
  "test-list-directory.ts",
  "test-project-memory.ts",
  "test-remember-tool.ts",
  "test-search-files.ts",
  "test-tool-registry.ts",
    "test-greenfield-investigation-prompt.ts",
  "test-tool-payload-format-guidance.ts",
];

function cleanupTempArtifacts() {
  const tempFiles = [
    "src/feat.ts",
    "src/new-feature.ts",
    "src/runaway.ts",
    "src/test-feature.ts",
    "src/temp-syntax-error.ts",
    ".agent-memory.json",
  ];
  for (const file of tempFiles) {
    const fullPath = path.join(repoRoot, file);
    if (fs.existsSync(fullPath)) {
      try {
        fs.unlinkSync(fullPath);
      } catch {}
    }
  }
}

async function run() {
  console.log("============================================================");
  console.log(`RUNNING ALL ${DETERMINISTIC_TEST_FILES.length} DETERMINISTIC TEST SUITES`);
  console.log("============================================================\n");

  const startTime = Date.now();
  let passedCount = 0;
  let failedCount = 0;
  const failures: string[] = [];

  for (const testFile of DETERMINISTIC_TEST_FILES) {
    const fullPath = path.join(currentDir, testFile);
    process.stdout.write(`• Running ${testFile.padEnd(46, " ")} `);

    const res = spawnSync("npx", ["tsx", fullPath], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: "pipe",
    });

    if (res.status === 0) {
      passedCount++;
      console.log("PASS");
    } else {
      failedCount++;
      failures.push(testFile);
      console.log("FAIL");
      if (res.stdout) console.log(res.stdout);
      if (res.stderr) console.error(res.stderr);
    }
  }

  cleanupTempArtifacts();

  const durationSec = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log("\n============================================================");
  console.log(`TEST SUMMARY: ${passedCount} passed, ${failedCount} failed (${durationSec}s)`);
  console.log("============================================================");

  if (failedCount > 0) {
    console.error(`\n❌ Failed test suites (${failedCount}):`);
    for (const f of failures) {
      console.error(`  - ${f}`);
    }
    process.exit(1);
  } else {
    console.log(`\n✅ All ${passedCount} deterministic test suites PASSED successfully.`);
    process.exit(0);
  }
}

run().catch((err) => {
  console.error("Test runner error:", err);
  process.exit(1);
});
