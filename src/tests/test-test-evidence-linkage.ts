import { InvestigationState } from "../agent/InvestigationState.js";

function testEvidenceLinkage() {
  // Case 1 — Run 8 regression (Unrelated placeholder test exists, new implementation written)
  {
    const state = new InvestigationState();
    state.setTaskType("implementation");
    state.startImplementation();
    state.addRequiredCategory("typecheck");
    state.addRequiredCategory("test");

    // Agent writes src/todos.ts
    state.recordWrittenFile("src/todos.ts", "export class Todo {}");

    // npm test passes (exit code 0)
    state.recordVerificationResult("npm test", true);

    const implState = state.getImplementationState();
    if (implState.completedCategories.includes("test")) {
      throw new Error(
        "FAIL Case 1: 'test' category must NOT complete when only unrelated implementation was written without test evidence!",
      );
    }
    if (state.isImplementationComplete()) {
      throw new Error("FAIL Case 1: Implementation must NOT be complete!");
    }
    console.log("PASS: Case 1 — Run 8 regression (unrelated placeholder test rejected)");
  }

  // Case 2 — Linked newly-written test
  {
    const state = new InvestigationState();
    state.setTaskType("implementation");
    state.startImplementation();
    state.addRequiredCategory("typecheck");
    state.addRequiredCategory("test");

    state.recordWrittenFile("src/todos.ts", "export class Todo {}");
    state.recordWrittenFile(
      "src/tests/todo.test.ts",
      'import { Todo } from "../todos.js";\n// test todo',
    );

    state.recordVerificationResult("npm test", true);

    const implState = state.getImplementationState();
    if (!implState.completedCategories.includes("test")) {
      throw new Error(
        "FAIL Case 2: 'test' category MUST complete when linked test file is written!",
      );
    }
    console.log("PASS: Case 2 — Linked newly-written test completes test category");
  }

  // Case 3 — Existing test evidence
  {
    const state = new InvestigationState();
    state.setTaskType("implementation");
    state.markFeatureSearchCompleted();
    state.markRepositoryStructureInspected();
    state.markConfigurationInspected();
    state.markImplementationInspected();

    // Existing test inspected during investigation phase
    state.recordPath("src/tests/existing.test.ts");
    state.markTestsInspected();

    state.startImplementation();
    state.addRequiredCategory("typecheck");
    state.addRequiredCategory("test");

    // Agent modifies existing implementation file
    state.recordWrittenFile("src/todos.ts", "export class Todo { update() {} }");

    // npm test passes
    state.recordVerificationResult("npm test", true);

    const implState = state.getImplementationState();
    if (!implState.completedCategories.includes("test")) {
      throw new Error(
        "FAIL Case 3: Pre-existing inspected test MUST satisfy test evidence requirement!",
      );
    }
    console.log("PASS: Case 3 — Pre-existing inspected test satisfies test category");
  }

  // Case 4 — Placeholder written by agent
  {
    const state = new InvestigationState();
    state.setTaskType("implementation");
    state.startImplementation();
    state.addRequiredCategory("typecheck");
    state.addRequiredCategory("test");

    state.recordWrittenFile("src/todos.ts", "export class Todo {}");
    // Agent writes a dummy placeholder test without referencing Todo or todos
    state.recordWrittenFile(
      "src/tests/todo.test.ts",
      'test("placeholder", () => { assert.equal(1, 1); });',
    );

    state.recordVerificationResult("npm test", true);

    const implState = state.getImplementationState();
    if (implState.completedCategories.includes("test")) {
      throw new Error(
        "FAIL Case 4: Dummy placeholder test written by agent must NOT satisfy test category!",
      );
    }
    console.log("PASS: Case 4 — Agent-written dummy placeholder test rejected");
  }

  // Case 5 — Failed command
  {
    const state = new InvestigationState();
    state.setTaskType("implementation");
    state.startImplementation();
    state.addRequiredCategory("typecheck");
    state.addRequiredCategory("test");

    state.recordWrittenFile("src/todos.ts", "export class Todo {}");
    state.recordWrittenFile(
      "src/tests/todo.test.ts",
      'import { Todo } from "../todos.js";',
    );

    // npm test fails (exit code 1)
    state.recordVerificationResult("npm test", false);

    const implState = state.getImplementationState();
    if (implState.completedCategories.includes("test")) {
      throw new Error(
        "FAIL Case 5: Failed test command must NOT complete test category!",
      );
    }
    console.log("PASS: Case 5 — Failed test command rejected");
  }

  // Case 6 — Write after successful verification invalidates previous verification
  {
    const state = new InvestigationState();
    state.setTaskType("implementation");
    state.startImplementation();
    state.addRequiredCategory("typecheck");
    state.addRequiredCategory("test");

    state.recordWrittenFile("src/todos.ts", "export class Todo {}");
    state.recordWrittenFile(
      "src/tests/todo.test.ts",
      'import { Todo } from "../todos.js";',
    );

    state.recordVerificationResult("npm run typecheck", true);
    state.recordVerificationResult("npm test", true);

    if (!state.isImplementationComplete()) {
      throw new Error("FAIL Case 6: Should be complete before subsequent write");
    }

    // Subsequent write invalidates verification
    state.recordWrittenFile("src/todos.ts", "export class Todo { newMethod() {} }");

    const implState = state.getImplementationState();
    if (
      implState.completedCategories.length > 0 ||
      implState.verificationPerformed
    ) {
      throw new Error(
        "FAIL Case 6: Subsequent write MUST invalidate previous verification results!",
      );
    }
    console.log("PASS: Case 6 — Write after successful verification invalidates completed categories");
  }
}

testEvidenceLinkage();
