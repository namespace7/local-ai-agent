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
    let unFenced = content.trim();

    // 1. Check if the entire trimmed content is a fenced code block: ```json ... ``` or ``` ... ```
    const fenceMatch = unFenced.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i);
    if (fenceMatch && fenceMatch[1] !== undefined) {
      unFenced = fenceMatch[1].trim();
    }

    if (!unFenced) {
      return [];
    }

    // 2. Check if content is a JSON Array: [...]
    if (unFenced.startsWith("[") && unFenced.endsWith("]")) {
      try {
        const parsedArray: unknown = JSON.parse(unFenced);
        if (Array.isArray(parsedArray)) {
          const toolCalls: ToolCall[] = [];
          for (const item of parsedArray) {
            const converted = this.validateAndConvertParsedToolCall(
              item,
              tools,
              toolCalls.length,
            );
            if (converted) {
              toolCalls.push(converted);
            }
          }
          return toolCalls;
        }
      } catch {
        // Fall through to object extraction
      }
    }

    // 3. Extract one or more JSON objects (JSONL or single JSON)
    const jsonObjects = this.extractJsonObjects(unFenced);
    if (!jsonObjects || jsonObjects.length === 0) {
      return [];
    }

    const toolCalls: ToolCall[] = [];
    for (const jsonStr of jsonObjects) {
      try {
        const parsed: unknown = JSON.parse(jsonStr);
        const converted = this.validateAndConvertParsedToolCall(
          parsed,
          tools,
          toolCalls.length,
        );
        if (converted) {
          toolCalls.push(converted);
        }
      } catch {
        // Skip malformed individual object
      }
    }

    return toolCalls;
  }

  /**
   * Extracts top-level JSON objects from text when formatted as single JSON or JSONL.
   * If any non-whitespace characters exist outside JSON object boundaries, returns null
   * to ensure ordinary conversational prose containing JSON is never parsed as tool calls.
   */
  private extractJsonObjects(text: string): string[] | null {
    const trimmed = text.trim();
    if (!trimmed) {
      return null;
    }

    const objects: string[] = [];
    let depth = 0;
    let inString = false;
    let escape = false;
    let startIndex = -1;

    for (let i = 0; i < trimmed.length; i++) {
      const char = trimmed[i];

      if (inString) {
        if (escape) {
          escape = false;
        } else if (char === "\\") {
          escape = true;
        } else if (char === '"') {
          inString = false;
        }
        continue;
      }

      if (char === '"') {
        inString = true;
        continue;
      }

      if (char === "{") {
        if (depth === 0) {
          startIndex = i;
        }
        depth++;
      } else if (char === "}") {
        if (depth === 0) {
          return null;
        }
        depth--;
        if (depth === 0 && startIndex !== -1) {
          objects.push(trimmed.substring(startIndex, i + 1));
          startIndex = -1;
        }
      } else {
        if (
          depth === 0 &&
          char !== " " &&
          char !== "\t" &&
          char !== "\n" &&
          char !== "\r"
        ) {
          return null;
        }
      }
    }

    if (depth !== 0 || inString || objects.length === 0) {
      return null;
    }

    return objects;
  }

  private validateAndConvertParsedToolCall(
    parsed: unknown,
    tools: ToolDefinition[],
    index: number,
  ): ToolCall | null {
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return null;
    }

    const record = parsed as Record<string, unknown>;

    // Validate name
    if (typeof record.name !== "string" || record.name.trim().length === 0) {
      return null;
    }
    const toolName = record.name.trim();

    // Validate that the requested tool name exists in the supplied tool definitions
    const toolExists = tools.some((t) => t.function.name === toolName);
    if (!toolExists) {
      return null;
    }

    // Validate arguments: must be non-null, non-array object
    if (
      typeof record.arguments !== "object" ||
      record.arguments === null ||
      Array.isArray(record.arguments)
    ) {
      return null;
    }

    return {
      id: `tool-call-fallback-${index}`,
      name: toolName,
      arguments: record.arguments as Record<string, unknown>,
    };
  }
}
