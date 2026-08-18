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

    const toolCalls = this.normalizeToolCalls(data.message, tools);

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

  /**
   * Normalizes tool calls across different Ollama models.
   *
   * 1. If message.tool_calls contains one or more calls (e.g. qwen3:8b native tool calling):
   *    - Uses those directly.
   *    - Does NOT inspect message.content for fallback calls.
   * 2. If message.tool_calls is empty or missing:
   *    - Inspects message.content for structured tool-call JSON matching { "name": string, "arguments": object }.
   *    - Validates that the parsed tool name exists in the supplied ToolDefinitions.
   *    - Converts valid JSON into an internal ToolCall with a deterministic fallback ID.
   */
  private normalizeToolCalls(
    message: OllamaChatResponse["message"],
    tools: ToolDefinition[],
  ): ToolCall[] {
    if (message.tool_calls && message.tool_calls.length > 0) {
      return message.tool_calls.map((call, index) => ({
        id: call.id ?? `tool-call-${index}`,
        name: call.function.name,
        arguments: call.function.arguments ?? {},
      }));
    }

    const content = message.content?.trim();
    if (!content) {
      return [];
    }

    return this.parseToolCallsFromContent(content, tools);
  }

  private parseToolCallsFromContent(
    content: string,
    tools: ToolDefinition[],
  ): ToolCall[] {
    let jsonString: string | undefined;

    // 1. Check if the entire trimmed content is a fenced code block: ```json ... ``` or ``` ... ```
    const fenceMatch = content.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i);
    if (fenceMatch) {
      jsonString = fenceMatch[1]?.trim();
    } else if (content.startsWith("{") && content.endsWith("}")) {
      // 2. Entire trimmed content is plain JSON
      jsonString = content;
    }

    if (!jsonString) {
      return [];
    }

    try {
      const parsed: unknown = JSON.parse(jsonString);
      return this.validateAndConvertParsedToolCall(parsed, tools);
    } catch {
      return [];
    }
  }

  private validateAndConvertParsedToolCall(
    parsed: unknown,
    tools: ToolDefinition[],
  ): ToolCall[] {
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return [];
    }

    const record = parsed as Record<string, unknown>;

    // Validate name
    if (typeof record.name !== "string" || record.name.trim().length === 0) {
      return [];
    }
    const toolName = record.name.trim();

    // Validate that the requested tool name exists in the supplied tool definitions
    const toolExists = tools.some((t) => t.function.name === toolName);
    if (!toolExists) {
      return [];
    }

    // Validate arguments: must be non-null, non-array object
    if (
      typeof record.arguments !== "object" ||
      record.arguments === null ||
      Array.isArray(record.arguments)
    ) {
      return [];
    }

    return [
      {
        id: `tool-call-fallback-0`,
        name: toolName,
        arguments: record.arguments as Record<string, unknown>,
      },
    ];
  }
}
