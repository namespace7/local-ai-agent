export type InvestigationTaskType =
  | "factual"
  | "existing-feature"
  | "implementation-plan"
  | "implementation";

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

export type VerificationCategory = "typecheck" | "test";

export interface ImplementationState {
  started: boolean;
  filesWritten: string[];
  inspectedFiles: string[];
  verificationRequirementsDetermined: boolean;
  requiredCategories: VerificationCategory[];
  completedCategories: VerificationCategory[];
  verificationPerformed: boolean;
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

  private readonly implementation: ImplementationState = {
    started: false,
    filesWritten: [],
    inspectedFiles: [],
    verificationRequirementsDetermined: false,
    requiredCategories: [],
    completedCategories: [],
    verificationPerformed: false,
  };

  /*
   * Repair evidence: workspace-relative paths extracted from the most recent
   * verification failure that have not yet been read by the model.
   *
   * This is separate from investigation evidence.
   * Investigation asks "what exists?"; repair evidence asks "what failed?".
   * Cleared when any verification command succeeds.
   */
  private readonly unreadRepairPaths = new Set<string>();

  recordInspectedFile(path: string): void {
    if (!this.implementation.inspectedFiles.includes(path)) {
      this.implementation.inspectedFiles.push(path);
    }
  }

  setTaskType(taskType: InvestigationTaskType): void {
    this.taskType = taskType;
  }

  getTaskType(): InvestigationTaskType {
    return this.taskType;
  }

  /*
   * --------------------------------------------------------------------------
   * Implementation lifecycle
   * --------------------------------------------------------------------------
   */

  startImplementation(): void {
    this.implementation.started = true;
  }

  private readonly writtenFileContents = new Map<string, string>();

  recordWrittenFile(path: string, content?: string): void {
    if (!this.implementation.filesWritten.includes(path)) {
      this.implementation.filesWritten.push(path);
    }
    if (content !== undefined) {
      this.writtenFileContents.set(path, content);
    }
    // Writing or modifying files invalidates any previous verification result
    this.implementation.completedCategories = [];
    this.implementation.verificationPerformed = false;
  }

  setVerificationRequirementsDetermined(determined: boolean): void {
    this.implementation.verificationRequirementsDetermined = determined;
  }

  addRequiredCategory(category: VerificationCategory): void {
    this.implementation.verificationRequirementsDetermined = true;
    if (!this.implementation.requiredCategories.includes(category)) {
      this.implementation.requiredCategories.push(category);
    }
  }

  classifyCommand(command: string): VerificationCategory | undefined {
    const trimmed = command.trim();
    if (trimmed.startsWith("npx tsc") || trimmed.startsWith("npm run typecheck")) {
      return "typecheck";
    }
    if (
      trimmed.startsWith("npm test") ||
      trimmed.startsWith("npm run test") ||
      trimmed.startsWith("node --test") ||
      trimmed.startsWith("npx vitest") ||
      trimmed.startsWith("npx jest")
    ) {
      return "test";
    }
    return undefined;
  }

  private isTestPath(path: string): boolean {
    const normalized = path.toLowerCase().replace(/^.\//, "");
    return (
      normalized.startsWith("tests/") ||
      normalized.startsWith("src/tests/") ||
      normalized.includes("/tests/") ||
      normalized.endsWith(".test.ts") ||
      normalized.endsWith(".test.tsx") ||
      normalized.endsWith(".test.js") ||
      normalized.endsWith(".test.mjs") ||
      normalized.endsWith(".spec.ts") ||
      normalized.endsWith(".spec.tsx") ||
      normalized.endsWith(".spec.js") ||
      normalized.endsWith(".spec.mjs")
    );
  }

  private isImplementationPath(path: string): boolean {
    const normalized = path.toLowerCase().replace(/^.\//, "");
    if (
      normalized.length === 0 ||
      this.isTestPath(normalized) ||
      normalized === "readme.md" ||
      normalized.endsWith("/readme.md") ||
      normalized === "package.json" ||
      normalized === "tsconfig.json" ||
      normalized.endsWith("/package.json") ||
      normalized.endsWith("/tsconfig.json") ||
      normalized === "package-lock.json"
    ) {
      return false;
    }
    return (
      normalized.endsWith(".ts") ||
      normalized.endsWith(".tsx") ||
      normalized.endsWith(".js") ||
      normalized.endsWith(".jsx") ||
      normalized.endsWith(".mjs") ||
      normalized.endsWith(".cjs")
    );
  }

  hasValidTestEvidence(): boolean {
    const writtenImplFiles = this.implementation.filesWritten.filter((p) =>
      this.isImplementationPath(p),
    );

    if (writtenImplFiles.length === 0) {
      return true;
    }

    const writtenTestFiles = this.implementation.filesWritten.filter((p) =>
      this.isTestPath(p),
    );

    if (writtenTestFiles.length > 0) {
      const implBasenames = writtenImplFiles.map((p) => {
        const parts = p.split("/");
        const filename = parts[parts.length - 1] ?? "";
        const dotIdx = filename.lastIndexOf(".");
        return (dotIdx > 0 ? filename.substring(0, dotIdx) : filename).toLowerCase();
      });

      const implSymbols: string[] = [];
      for (const implPath of writtenImplFiles) {
        const implContent = this.writtenFileContents.get(implPath) || "";
        const matches = implContent.match(/\b(?:class|function|const|let|var|interface|type|enum)\s+([A-Za-z0-9_]+)/g);
        if (matches) {
          for (const m of matches) {
            const parts = m.split(/\s+/);
            const sym = parts[1];
            if (sym && sym.length > 1 && !implSymbols.includes(sym)) {
              implSymbols.push(sym);
            }
          }
        }
      }

      for (const testPath of writtenTestFiles) {
        const rawContent = this.writtenFileContents.get(testPath) || "";
        const codeOnly = rawContent
          .replace(/\/\*[\s\S]*?\*\//g, "")
          .replace(/\/\/.*/g, "");

        const codeOnlyLower = codeOnly.toLowerCase();

        for (const base of implBasenames) {
          if (base.length > 1 && codeOnlyLower.includes(base)) {
            return true;
          }
        }

        for (const sym of implSymbols) {
          if (codeOnly.includes(sym)) {
            return true;
          }
        }
      }

      return false;
    }

    const preExistingTestsInspected = [...this.inspectedPaths].some((p) =>
      this.isTestPath(p),
    );

    return preExistingTestsInspected;
  }

  recordVerificationResult(command: string | boolean, success?: boolean): void {
    let cmdSuccess = false;
    let cmdName = "";

    if (typeof command === "boolean") {
      cmdSuccess = command;
    } else {
      cmdName = command;
      cmdSuccess = Boolean(success);
    }

    if (cmdSuccess && cmdName.length > 0) {
      const category = this.classifyCommand(cmdName);
      if (
        category &&
        !this.implementation.completedCategories.includes(category)
      ) {
        if (category === "test") {
          if (this.hasValidTestEvidence()) {
            this.implementation.completedCategories.push(category);
          }
        } else {
          this.implementation.completedCategories.push(category);
        }
      }
    }

    this.implementation.verificationPerformed = this.isImplementationComplete();
  }

  /*
   * --------------------------------------------------------------------------
   * Repair evidence
   * --------------------------------------------------------------------------
   *
   * After a verification failure, the controller extracts workspace-relative
   * file paths from the command output that are implicated in the failure
   * (i.e., they are also in filesWritten).  write_file is blocked until every
   * such path has been read at least once since the failure.
   */

  /**
   * Register paths implicated by the most recent verification failure.
   * Replaces any previous repair evidence with the fresh failure's paths.
   */
  recordVerificationFailurePaths(paths: string[]): void {
    this.unreadRepairPaths.clear();
    for (const p of paths) {
      const norm = p.startsWith("./") ? p.slice(2) : p;
      this.unreadRepairPaths.add(norm);
    }
  }

  /**
   * Mark a path as having been read since the last failure.
   * Accepts both `./foo` and `foo` forms.
   */
  satisfyRepairPath(path: string): void {
    const norm = path.startsWith("./") ? path.slice(2) : path;
    this.unreadRepairPaths.delete(norm);
  }

  /**
   * Clear all repair evidence.  Called when a verification command succeeds.
   */
  clearRepairEvidence(): void {
    this.unreadRepairPaths.clear();
  }

  /**
   * True while at least one implicated path has not been read since the failure.
   */
  hasUnreadRepairEvidence(): boolean {
    return this.unreadRepairPaths.size > 0;
  }

  /**
   * The set of paths that must be read before write_file is permitted.
   */
  getUnreadRepairPaths(): string[] {
    return [...this.unreadRepairPaths];
  }

  getImplementationState(): ImplementationState {
    return {
      started: this.implementation.started,
      filesWritten: [...this.implementation.filesWritten],
      inspectedFiles: [...this.implementation.inspectedFiles],
      verificationRequirementsDetermined:
        this.implementation.verificationRequirementsDetermined,
      requiredCategories: [...this.implementation.requiredCategories],
      completedCategories: [...this.implementation.completedCategories],
      verificationPerformed: this.isImplementationComplete(),
    };
  }

  isImplementationComplete(): boolean {
    if (
      !this.implementation.started ||
      this.implementation.filesWritten.length === 0
    ) {
      return false;
    }

    if (!this.implementation.verificationRequirementsDetermined) {
      return false;
    }

    if (this.implementation.requiredCategories.length === 0) {
      return false;
    }

    return this.implementation.requiredCategories.every((cat) =>
      this.implementation.completedCategories.includes(cat),
    );
  }

  /*
   * --------------------------------------------------------------------------
   * Tool execution tracking
   * --------------------------------------------------------------------------
   */

  recordToolCall(toolName: string, argumentsKey: string): void {
    this.executedCalls.add(`${toolName}:${argumentsKey}`);
  }

  hasExecutedToolCall(toolName: string, argumentsKey: string): boolean {
    return this.executedCalls.has(`${toolName}:${argumentsKey}`);
  }

  getExecutedToolCalls(): string[] {
    return [...this.executedCalls];
  }

  /*
   * --------------------------------------------------------------------------
   * Repository observations
   * --------------------------------------------------------------------------
   */

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

  /*
   * --------------------------------------------------------------------------
   * Investigation evidence
   * --------------------------------------------------------------------------
   */

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

  /*
   * --------------------------------------------------------------------------
   * Investigation completion
   * --------------------------------------------------------------------------
   */

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

    if (
      this.taskType === "implementation-plan" ||
      this.taskType === "implementation"
    ) {
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

  /*
   * --------------------------------------------------------------------------
   * Context for the model
   * --------------------------------------------------------------------------
   */

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

    const implementation = this.getImplementationState();

    const implementationStatus = [
      `- Started: ${implementation.started ? "yes" : "no"}`,
      `- Files written: ${
        implementation.filesWritten.length > 0
          ? implementation.filesWritten.join(", ")
          : "none"
      }`,
      `- Verification: ${
        implementation.verificationPerformed ? "complete" : "pending"
      }`,
    ].join("\n");

    const missingEvidence = this.getMissingEvidence();

    const completion = this.isComplete()
      ? "Investigation evidence is sufficient for this task."
      : `Investigation is incomplete. Missing: ${missingEvidence.join(", ")}.`;

    const nextActionGuidance = this.getNextActionGuidance();

    return `Investigation task type: ${this.taskType}

        Evidence status:
        ${evidenceStatus}

        ${completion}

        Implementation state:
        ${implementationStatus}

        ${nextActionGuidance}

        Inspected paths:
        ${paths}

        Repository observations:
        ${observations}`;
  }

  /*
   * --------------------------------------------------------------------------
   * Next action guidance
   * --------------------------------------------------------------------------
   */

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
        "- Do NOT continue broad directory exploration.",
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

    if (this.taskType === "implementation") {
      if (!this.implementation.started) {
        return [
          "Investigation is complete.",
          "",
          "Next phase: implementation.",
          "- Stop broad repository investigation.",
          "- Use write_file to create or modify the required files.",
          "- Do not merely describe the implementation.",
          "- Actually implement the user's requested feature.",
        ].join("\n");
      }

      if (this.implementation.filesWritten.length === 0) {
        return [
          "Implementation has started but no files have been written.",
          "- Use write_file to implement the requested feature.",
          "- Do not provide the final response yet.",
        ].join("\n");
      }

      if (!this.isImplementationComplete()) {
        const pending = this.implementation.requiredCategories.filter(
          (cat) => !this.implementation.completedCategories.includes(cat),
        );
        const pendingDesc =
          pending.length > 0
            ? pending.join(", ")
            : "required verification categories";

        return [
          "Implementation files have been written.",
          "",
          "Next phase: verification.",
          `Verification pending: ${pendingDesc} verification is still required on the latest code.`,
          "- Execute a verification command using run_command (e.g. 'npx tsc --noEmit', 'npm run typecheck', or 'npm test').",
          "- If verification fails, inspect stdout/stderr and use write_file to fix the implementation.",
          "- Do not provide the final response until all required verification categories pass.",
        ].join("\n");
      }

      return [
        "Implementation and verification are complete.",
        "- Stop using implementation tools.",
        "- Produce the final response.",
      ].join("\n");
    }

    return [
      "Required evidence is complete.",
      "- Stop investigating.",
      "- Produce the final evidence-backed answer.",
    ].join("\n");
  }
}
