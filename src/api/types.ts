import type { ModelProvider } from "../models/ModelProvider.js";
import type { ExecutionTrace } from "../observability/ExecutionTrace.js";

export interface AgentRunOptions {
  prompt: string;
  workspaceRoot?: string;
  model?: string;
  maxIterations?: number;
  /** Optional custom model provider for testing / dependency injection */
  modelProvider?: ModelProvider;
}

export interface VerificationSummary {
  typecheckPassed?: boolean;
  buildPassed?: boolean;
  testPassed?: boolean;
}

export interface AgentRunResult {
  success: boolean;
  taskType: string;
  iterations: number;
  wallClockDurationMs: number;
  finalMessage: string;
  filesWritten: string[];
  verified: boolean;
  verificationSummary: VerificationSummary;
  trace?: ExecutionTrace;
}
