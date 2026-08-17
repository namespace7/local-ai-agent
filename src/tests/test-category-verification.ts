import { InvestigationState } from "../agent/InvestigationState.js";

function testCategoryVerification() {
  const investigation = new InvestigationState();
  investigation.setTaskType("implementation");

  // 1. Initial state: verification requirements NOT determined -> cannot complete
  investigation.markFeatureSearchCompleted();
  investigation.markRepositoryStructureInspected();
  investigation.markConfigurationInspected();
  investigation.markImplementationInspected();
  investigation.markTestsInspected();
  investigation.startImplementation();
  investigation.recordWrittenFile("src/new-feature.ts", "export class NewFeature {}");
  investigation.recordWrittenFile("src/tests/new-feature.test.ts", "import { NewFeature } from '../new-feature';");

  if (investigation.isImplementationComplete()) {
    throw new Error(
      "FAIL: Implementation must NOT be complete when verification requirements are not yet determined!",
    );
  }
  console.log(
    "PASS: 1. Empty/undetermined verification requirements prevent implementation completion",
  );

  // 2. Add required categories: typecheck and test for TypeScript project
  investigation.addRequiredCategory("typecheck");
  investigation.addRequiredCategory("test");

  const state = investigation.getImplementationState();
  if (
    !state.verificationRequirementsDetermined ||
    state.requiredCategories.length !== 2 ||
    !state.requiredCategories.includes("typecheck") ||
    !state.requiredCategories.includes("test")
  ) {
    throw new Error(
      "FAIL: requiredCategories was not properly populated with typecheck and test",
    );
  }
  console.log("PASS: 2. TypeScript project requiredCategories populated");

  // 3. Command classification test
  if (investigation.classifyCommand("npm run typecheck") !== "typecheck") {
    throw new Error("FAIL: npm run typecheck should classify as typecheck");
  }
  if (investigation.classifyCommand("npx tsc --noEmit") !== "typecheck") {
    throw new Error("FAIL: npx tsc --noEmit should classify as typecheck");
  }
  if (investigation.classifyCommand("npm run test") !== "test") {
    throw new Error("FAIL: npm run test should classify as test");
  }
  if (investigation.classifyCommand("node --test") !== "test") {
    throw new Error("FAIL: node --test should classify as test");
  }
  console.log("PASS: 3. Verification command classification");

  // 4. Failed typecheck does NOT satisfy category
  investigation.recordVerificationResult("npm run typecheck", false);
  if (investigation.getImplementationState().completedCategories.includes("typecheck")) {
    throw new Error("FAIL: Failed command must NOT satisfy verification category!");
  }
  if (investigation.isImplementationComplete()) {
    throw new Error("FAIL: Failed command must NOT complete implementation!");
  }
  console.log("PASS: 4. Failed command does not satisfy category");

  // 5. Running npm test alone does NOT complete implementation when typecheck is required
  investigation.recordVerificationResult("npm run test", true);

  const stateAfterTest = investigation.getImplementationState();
  if (
    stateAfterTest.completedCategories.length !== 1 ||
    !stateAfterTest.completedCategories.includes("test")
  ) {
    throw new Error("FAIL: npm run test should add 'test' to completedCategories");
  }

  if (investigation.isImplementationComplete()) {
    throw new Error(
      "FAIL: npm test alone MUST NOT complete implementation when typecheck is still required!",
    );
  }
  console.log(
    "PASS: 5. npm test alone does NOT complete implementation when typecheck is required",
  );

  // 6. Running npm run typecheck as well satisfies all required categories -> complete!
  investigation.recordVerificationResult("npm run typecheck", true);

  const stateAfterBoth = investigation.getImplementationState();
  if (
    stateAfterBoth.completedCategories.length !== 2 ||
    !stateAfterBoth.completedCategories.includes("typecheck")
  ) {
    throw new Error("FAIL: npm run typecheck should add 'typecheck' to completedCategories");
  }

  if (!investigation.isImplementationComplete()) {
    throw new Error(
      "FAIL: Implementation SHOULD be complete after both typecheck and test succeed!",
    );
  }
  console.log(
    "PASS: 6. npm run typecheck + npm test completes implementation",
  );

  // 7. Write after verification invalidates completed categories
  investigation.recordWrittenFile("src/another-file.ts", "export class Another {}");
  investigation.recordWrittenFile("src/tests/another.test.ts", "import { Another } from '../another-file';");

  const stateAfterWrite = investigation.getImplementationState();
  if (stateAfterWrite.completedCategories.length !== 0) {
    throw new Error(
      "FAIL: write_file MUST invalidate all completedCategories back to []!",
    );
  }

  if (investigation.isImplementationComplete()) {
    throw new Error(
      "FAIL: Implementation must NOT be complete after subsequent write_file!",
    );
  }
  console.log("PASS: 7. Write after verification invalidates completed categories");

  // 8. Re-verifying both categories after latest write completes implementation again
  investigation.recordVerificationResult("npm run typecheck", true);
  investigation.recordVerificationResult("npm test", true);

  if (!investigation.isImplementationComplete()) {
    throw new Error(
      "FAIL: Verification after latest write MUST complete implementation!",
    );
  }
  console.log(
    "PASS: 8. Verification after latest write completes implementation",
  );
}

testCategoryVerification();
