import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { Tool } from "./Tool.js";
import type { Workspace } from "../workspace/Workspace.js";

const execAsync = promisify(exec);

export interface RunCommandResult {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  success: boolean;
  timedOut: boolean;
}

export class RunCommandTool implements Tool {
  readonly name = "run_command";

  readonly description =
    "Execute a project verification or test command inside the workspace root (e.g. 'npx tsc --noEmit', 'npm run typecheck', 'npm test', 'node --test'). Returns exit code, stdout, stderr, and success status.";

  readonly parameters: Record<string, unknown> = {
    type: "object",
    properties: {
      command: {
        type: "string",
        description:
          "The verification command to run (e.g. 'npx tsc --noEmit', 'npm run typecheck', 'npm test', 'node --test').",
      },
    },
    required: ["command"],
  };

  private readonly timeoutMs: number;

  constructor(
    private readonly workspace: Workspace,
    timeoutMs = 30000,
  ) {
    this.timeoutMs = timeoutMs;
  }

  async execute(input: unknown): Promise<RunCommandResult> {
    const parsed = this.parseInput(input);
    this.validateCommand(parsed.command);

    try {
      const { stdout, stderr } = await execAsync(parsed.command, {
        cwd: this.workspace.root,
        timeout: this.timeoutMs,
      });

      return {
        command: parsed.command,
        exitCode: 0,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        success: true,
        timedOut: false,
      };
    } catch (error: any) {
      const timedOut = error.killed && error.signal === "SIGTERM";
      const exitCode = typeof error.code === "number" ? error.code : 1;
      const stdout = typeof error.stdout === "string" ? error.stdout.trim() : "";
      const stderr =
        typeof error.stderr === "string" && error.stderr.trim().length > 0
          ? error.stderr.trim()
          : error.message || "Command failed";

      return {
        command: parsed.command,
        exitCode,
        stdout,
        stderr,
        success: false,
        timedOut,
      };
    }
  }

  private parseInput(input: unknown): { command: string } {
    if (input === null || typeof input !== "object") {
      throw new Error("run_command input must be an object");
    }

    const value = input as Record<string, unknown>;

    if (typeof value.command !== "string" || value.command.trim().length === 0) {
      throw new Error("run_command 'command' must be a non-empty string");
    }

    return { command: value.command.trim() };
  }

  private validateCommand(command: string): void {
    // Prevent shell chaining, redirection, or expansion operators
    const forbiddenPatterns = [
      ";",
      "&&",
      "||",
      "|",
      ">",
      "<",
      "$",
      "`",
      "&",
      "\n",
      "\r",
    ];

    for (const pattern of forbiddenPatterns) {
      if (command.includes(pattern)) {
        throw new Error(
          `Command rejected: shell chaining/redirection character '${pattern}' is forbidden`,
        );
      }
    }

    // Dangerous binaries / words check
    const forbiddenWords = [
      "sudo",
      "rm",
      "curl",
      "wget",
      "sh",
      "bash",
      "zsh",
      "eval",
      "exec",
      "chmod",
      "chown",
      "kill",
      "pkill",
    ];

    const tokens = command.split(/\s+/);
    for (const token of tokens) {
      const normalized = token.toLowerCase();
      if (forbiddenWords.includes(normalized)) {
        throw new Error(
          `Command rejected: forbidden executable or command '${token}'`,
        );
      }
    }

    // Explicit allowlist prefix matching
    const allowedPrefixes = [
      "npx tsc",
      "npm run typecheck",
      "npm run test",
      "npm test",
      "node --test",
      "npx vitest",
      "npx jest",
    ];

    const isAllowed = allowedPrefixes.some(
      (prefix) => command === prefix || command.startsWith(prefix + " "),
    );

    if (!isAllowed) {
      throw new Error(
        `Command rejected: '${command}' is not in the allowed verification command list. Allowed prefixes: ${allowedPrefixes.join(", ")}`,
      );
    }
  }
}
