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

  total_duration?: number;
  load_duration?: number;
  prompt_eval_count?: number;
  prompt_eval_duration?: number;
  eval_count?: number;
  eval_duration?: number;
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
        think: false,
        keep_alive: "10m",
        options: {
          num_predict: 2048,
          num_ctx: 8192,
        },
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
      metrics: {
        totalDurationMs: Math.round((data.total_duration ?? 0) / 1_000_000),
        loadDurationMs: Math.round((data.load_duration ?? 0) / 1_000_000),
        promptEvalCount: data.prompt_eval_count ?? 0,
        promptEvalDurationMs: Math.round(
          (data.prompt_eval_duration ?? 0) / 1_000_000,
        ),
        evalCount: data.eval_count ?? 0,
        evalDurationMs: Math.round((data.eval_duration ?? 0) / 1_000_000),
      },
    };

    if (data.message.thinking !== undefined) {
      modelResponse.thinking = data.message.thinking;
    }

    return modelResponse;
  }
}
