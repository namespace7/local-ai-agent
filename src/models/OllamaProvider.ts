import type { ModelProvider } from "./ModelProvider.js";
import type {
  Message,
  ModelResponse,
  ToolCall,
  ToolDefinition,
} from "./types.js";

interface OllamaToolCall {
  id?: string;
  function: {
    index?: number;
    name: string;
    arguments: Record<string, unknown>;
  };
}

interface OllamaChatResponse {
  message: {
    role: "assistant";
    content?: string;
    thinking?: string;
    tool_calls?: OllamaToolCall[];
  };
}

export class OllamaProvider implements ModelProvider {
  private readonly url: string;
  private readonly model: string;

  constructor(url = "http://localhost:11434/api/chat", model = "qwen3:8b") {
    this.url = url;
    this.model = model;
  }

  async generate(
    messages: Message[],
    tools: ToolDefinition[],
  ): Promise<ModelResponse> {
    const response = await fetch(this.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: this.model,
        messages,
        tools,
        stream: false,
      }),
    });

    if (!response.ok) {
      throw new Error(
        `Ollama request failed: ${response.status} ${response.statusText}`,
      );
    }

    const data = (await response.json()) as OllamaChatResponse;

    const toolCalls: ToolCall[] = (data.message.tool_calls ?? []).map(
      (call, index) => ({
        id: call.id ?? `tool-call-${index}`,
        name: call.function.name,
        arguments: call.function.arguments,
      }),
    );

    const modelResponse: ModelResponse = {
      content: data.message.content ?? "",
      toolCalls,
    };

    if (data.message.thinking !== undefined) {
      modelResponse.thinking = data.message.thinking;
    }

    return modelResponse;
  }
}
