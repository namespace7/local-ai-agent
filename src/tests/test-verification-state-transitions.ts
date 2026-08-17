import { InvestigationState } from "../agent/InvestigationState.js";

function testVerificationStateTransitions() {
  const investigation = new InvestigationState();
  investigation.setTaskType("implementation");

  // Setup investigation state as complete so implementation starts
  investigation.markFeatureSearchCompleted();
  investigation.markRepositoryStructureInspected();
  investigation.markConfigurationInspected();
  investigation.markImplementationInspected();
  investigation.markTestsInspected();

  if (!investigation.isComplete()) {
    throw new Error("FAIL: Investigation should be complete");
  }

  investigation.startImplementation();
  investigation.addRequiredCategory("test");

  let state = investigation.getImplementationState();

  if (!state.started || state.verificationPerformed) {
    throw new Error("FAIL: Implementation started, verification should be false");
  }

  // Write an implementation file and linked test file
  investigation.recordWrittenFile("src/feature.ts", "export class Feature {}");
  investigation.recordWrittenFile("src/tests/feature.test.ts", "import { Feature } from '../feature';");
  state = investigation.getImplementationState();

  if (state.filesWritten.length !== 2) {
    throw new Error("FAIL: File written state not recorded properly");
  }

  if (state.verificationPerformed) {
    throw new Error("FAIL: Writing file must leave verificationPerformed = false");
  }

  // 1. Test: read_file does NOT verify implementation
  investigation.recordPath("src/feature.ts");
  state = investigation.getImplementationState();

  if (state.verificationPerformed) {
    throw new Error("FAIL: read_file must NOT set verificationPerformed = true!");
  }

  if (investigation.isImplementationComplete()) {
    throw new Error("FAIL: Implementation must NOT be complete after read_file!");
  }

  console.log("PASS: read_file does NOT verify implementation");

  // 2. Test: Failed run_command does NOT verify implementation
  investigation.recordVerificationResult("npm test", false);
  state = investigation.getImplementationState();

  if (state.verificationPerformed) {
    throw new Error("FAIL: Failed verification command must leave verificationPerformed = false");
  }

  if (investigation.isImplementationComplete()) {
    throw new Error("FAIL: Implementation must NOT be complete after failed verification!");
  }

  console.log("PASS: Failed run_command does NOT verify implementation");

  // 3. Test: Successful run_command verifies implementation
  investigation.recordVerificationResult("npm test", true);
  state = investigation.getImplementationState();

  if (!state.verificationPerformed) {
    throw new Error("FAIL: Successful verification command MUST set verificationPerformed = true");
  }

  if (!investigation.isImplementationComplete()) {
    throw new Error("FAIL: Implementation SHOULD be complete after successful verification!");
  }

  console.log("PASS: Successful run_command verifies implementation");

  // 4. Test: A subsequent successful write_file invalidates verification
  investigation.recordWrittenFile("src/feature-repair.ts", "export class FeatureRepair {}");
  investigation.recordWrittenFile("src/tests/feature-repair.test.ts", "import { FeatureRepair } from '../feature-repair';");
  state = investigation.getImplementationState();

  if (state.verificationPerformed) {
    throw new Error(
      "FAIL: Subsequent write_file MUST invalidate previous verification result (verificationPerformed turned false)!",
    );
  }

  if (investigation.isImplementationComplete()) {
    throw new Error(
      "FAIL: Implementation must NOT be complete after modifying files after previous verification!",
    );
  }

  console.log("PASS: Subsequent write_file invalidates previous verification");

  // 5. Test: Successful verification after latest write completes verification
  investigation.recordVerificationResult("npm test", true);
  state = investigation.getImplementationState();

  if (!state.verificationPerformed) {
    throw new Error("FAIL: Re-verifying after write MUST set verificationPerformed = true");
  }

  if (!investigation.isImplementationComplete()) {
    throw new Error("FAIL: Implementation MUST be complete after latest write is verified!");
  }

  console.log(
    "PASS: Successful verification after latest write completes verification",
  );
}

testVerificationStateTransitions();
