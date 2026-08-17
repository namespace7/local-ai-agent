import type { Tool } from "../../tools/Tool.js";
import type { RunCommandResult } from "../../tools/RunCommandTool.js";

export interface FakeCommandResponse {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Deterministic replacement for RunCommandTool.
 *
 * Returns pre-configured results without executing real shell commands.
 * Each execute() call advances through the responses queue in order.
 * Useful for testing repair-evidence flow where the verification failure
 * output must contain specific file paths.
 */
export class FakeRunCommandTool implements Tool {
  readonly name = "run_command";
  readonly description = "Fake run_command for testing.";
  readonly parameters: Record<string, unknown> = {
    type: "object",
    properties: {
      command: { type: "string" },
    },
    required: ["command"],
  };

  private index = 0;

  constructor(private readonly responses: FakeCommandResponse[]) {}

  async execute(input: unknown): Promise<RunCommandResult> {
    const parsed = input as { command?: string };
    const command = parsed?.command ?? "unknown";

    const response = this.responses[this.index];
    if (!response) {
      throw new Error(
        `FakeRunCommandTool: no response configured for call ${this.index} (command: "${command}")`,
      );
    }

    this.index += 1;

    return {
      command,
      exitCode: response.exitCode,
      stdout: response.stdout,
      stderr: response.stderr,
      success: response.exitCode === 0,
      timedOut: false,
    };
  }
}
