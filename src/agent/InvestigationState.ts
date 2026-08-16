export type InvestigationTaskType =
  | "factual"
  | "existing-feature"
  | "implementation-plan";

export interface InvestigationObservation {
  toolName: string;
  summary: string;
}

export interface InvestigationEvidence {
  featureSearchCompleted: boolean;
  repositoryStructureInspected: boolean;
  configurationInspected: boolean;
  implementationInspected: boolean;
  testsInspected: boolean;
}

export class InvestigationState {
  private readonly executedCalls = new Set<string>();
  private readonly inspectedPaths = new Set<string>();
  private readonly observations: InvestigationObservation[] = [];

  private taskType: InvestigationTaskType = "factual";

  private readonly evidence: InvestigationEvidence = {
    featureSearchCompleted: false,
    repositoryStructureInspected: false,
    configurationInspected: false,
    implementationInspected: false,
    testsInspected: false,
  };

  setTaskType(taskType: InvestigationTaskType): void {
    this.taskType = taskType;
  }

  getTaskType(): InvestigationTaskType {
    return this.taskType;
  }

  recordToolCall(toolName: string, argumentsKey: string): void {
    this.executedCalls.add(`${toolName}:${argumentsKey}`);
  }

  hasExecutedToolCall(toolName: string, argumentsKey: string): boolean {
    return this.executedCalls.has(`${toolName}:${argumentsKey}`);
  }

  getExecutedToolCalls(): string[] {
    return [...this.executedCalls];
  }

  recordPath(path: string): void {
    this.inspectedPaths.add(path);
  }

  hasInspectedPath(path: string): boolean {
    return this.inspectedPaths.has(path);
  }

  addObservation(toolName: string, summary: string): void {
    this.observations.push({
      toolName,
      summary,
    });
  }

  markFeatureSearchCompleted(): void {
    this.evidence.featureSearchCompleted = true;
  }

  markRepositoryStructureInspected(): void {
    this.evidence.repositoryStructureInspected = true;
  }

  markConfigurationInspected(): void {
    this.evidence.configurationInspected = true;
  }

  markImplementationInspected(): void {
    this.evidence.implementationInspected = true;
  }

  markTestsInspected(): void {
    this.evidence.testsInspected = true;
  }

  getEvidence(): InvestigationEvidence {
    return {
      ...this.evidence,
    };
  }

  isComplete(): boolean {
    if (this.taskType === "factual") {
      return true;
    }

    if (this.taskType === "existing-feature") {
      return (
        this.evidence.featureSearchCompleted &&
        this.evidence.implementationInspected
      );
    }

    if (this.taskType === "implementation-plan") {
      return (
        this.evidence.featureSearchCompleted &&
        this.evidence.repositoryStructureInspected &&
        this.evidence.configurationInspected &&
        this.evidence.implementationInspected &&
        this.evidence.testsInspected
      );
    }

    return false;
  }

  getMissingEvidence(): string[] {
    const missing: string[] = [];

    if (!this.evidence.featureSearchCompleted) {
      missing.push("feature existence/search evidence");
    }

    if (!this.evidence.repositoryStructureInspected) {
      missing.push("repository structure");
    }

    if (!this.evidence.configurationInspected) {
      missing.push("project configuration");
    }

    if (!this.evidence.implementationInspected) {
      missing.push("representative implementation");
    }

    if (!this.evidence.testsInspected) {
      missing.push("relevant tests");
    }

    return missing;
  }

  getInspectedPaths(): string[] {
    return [...this.inspectedPaths];
  }

  getObservations(): InvestigationObservation[] {
    return [...this.observations];
  }

  getContext(): string {
    const observations =
      this.observations.length > 0
        ? this.observations
            .map(
              (observation) =>
                `- [${observation.toolName}] ${observation.summary}`,
            )
            .join("\n")
        : "No repository observations have been recorded yet.";

    const paths =
      this.inspectedPaths.size > 0
        ? [...this.inspectedPaths].map((path) => `- ${path}`).join("\n")
        : "No repository paths have been inspected yet.";

    const evidence = this.getEvidence();

    const evidenceStatus = [
      `- Feature search: ${
        evidence.featureSearchCompleted ? "complete" : "missing"
      }`,
      `- Repository structure: ${
        evidence.repositoryStructureInspected ? "complete" : "missing"
      }`,
      `- Configuration: ${
        evidence.configurationInspected ? "complete" : "missing"
      }`,
      `- Implementation: ${
        evidence.implementationInspected ? "complete" : "missing"
      }`,
      `- Tests: ${evidence.testsInspected ? "complete" : "missing"}`,
    ].join("\n");

    const missingEvidence = this.getMissingEvidence();

    const completion = this.isComplete()
      ? "Investigation evidence is sufficient for this task."
      : `Investigation is incomplete. Missing: ${missingEvidence.join(", ")}.`;

    const executedCalls =
      this.executedCalls.size > 0
        ? [...this.executedCalls].map((call) => `- ${call}`).join("\n")
        : "No tool calls have been executed yet.";

    const nextActionGuidance = this.getNextActionGuidance();

    return `Investigation task type: ${this.taskType}

    Evidence status:
    ${evidenceStatus}

    ${completion}

    ${nextActionGuidance}

    Inspected paths:
    ${paths}

    Repository observations:
    ${observations}`;
  }

  getNextActionGuidance(): string {
    if (this.taskType === "factual") {
      return "Use the minimum repository investigation necessary to answer the question.";
    }

    if (!this.evidence.featureSearchCompleted) {
      return [
        "Next investigation priority:",
        "- Search once for the requested feature or concept.",
        "- If the search returns no matches, treat that as evidence and change strategy.",
      ].join("\n");
    }

    if (!this.evidence.repositoryStructureInspected) {
      return [
        "Next investigation priority:",
        '- Inspect the repository root with list_directory({ path: "." }).',
        "- Then inspect only directories relevant to the requested feature.",
      ].join("\n");
    }

    if (!this.evidence.configurationInspected) {
      return [
        "Next investigation priority: project configuration.",
        "- Do NOT continue listing source directories.",
        "- Read package.json.",
        "- Read tsconfig.json if needed.",
        "- Use read_file rather than list_directory when the configuration filename is already known.",
      ].join("\n");
    }

    if (!this.evidence.implementationInspected) {
      return [
        "Next investigation priority: representative implementation.",
        "- Do NOT continue broad directory exploration.",
        "- Read a known source entry point or representative implementation file.",
        "- Prefer src/index.ts or a discovered implementation file.",
        "- Use read_file when the filename is already known.",
      ].join("\n");
    }

    if (!this.evidence.testsInspected) {
      return [
        "Next investigation priority: tests.",
        "- Inspect src/tests if its contents are not known.",
        "- Read at least one representative test that demonstrates repository conventions.",
        "- Do not revisit already inspected implementation directories.",
      ].join("\n");
    }

    return [
      "Required evidence is complete.",
      "- Stop investigating.",
      "- Produce the final evidence-backed answer.",
    ].join("\n");
  }
}
