import { InvestigationState } from "../agent/InvestigationState.js";

function testConfigurationEvidenceInvariant() {
  const investigation = new InvestigationState();
  investigation.setTaskType("implementation");

  // Initial evidence state: all missing
  let evidence = investigation.getEvidence();
  if (evidence.configurationInspected) {
    throw new Error("FAIL: configurationInspected should initially be false");
  }

  // Simulate search_files returning package.json match
  // Call updateInvestigationEvidence equivalent via tool call simulation logic:
  // search_files should only mark featureSearchCompleted = true
  investigation.markFeatureSearchCompleted();

  evidence = investigation.getEvidence();
  if (!evidence.featureSearchCompleted) {
    throw new Error("FAIL: featureSearchCompleted should be true after search_files");
  }

  if (evidence.configurationInspected) {
    throw new Error(
      "FAIL: search_files returning package.json must NOT mark configurationInspected as true",
    );
  }

  if (evidence.implementationInspected) {
    throw new Error(
      "FAIL: search_files returning source files must NOT mark implementationInspected as true",
    );
  }

  if (evidence.testsInspected) {
    throw new Error(
      "FAIL: search_files returning test files must NOT mark testsInspected as true",
    );
  }

  // Simulate read_file("package.json")
  investigation.markConfigurationInspected();

  evidence = investigation.getEvidence();
  if (!evidence.configurationInspected) {
    throw new Error(
      "FAIL: read_file('package.json') MUST mark configurationInspected as true",
    );
  }

  console.log(
    "PASS: configuration evidence invariant (search_files does not inspect content; read_file does)",
  );
}

testConfigurationEvidenceInvariant();
