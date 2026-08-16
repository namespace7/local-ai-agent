export interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCallId?: string;
  toolCalls?: ToolCall[];
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ModelResponse {
  content: string;
  thinking?: string;
  toolCalls: ToolCall[];
  metrics?: {
    totalDurationMs: number;
    loadDurationMs: number;
    promptEvalCount: number;
    promptEvalDurationMs: number;
    evalCount: number;
    evalDurationMs: number;
  };
}

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}
