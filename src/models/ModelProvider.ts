import type { Message, ModelResponse, ToolDefinition } from "./types.js";

export interface ModelProvider {
  generate(
    messages: Message[],
    tools: ToolDefinition[],
  ): Promise<ModelResponse>;
}
