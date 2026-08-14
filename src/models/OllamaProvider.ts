import type { ModelProvider } from "./ModelProvider.js";

interface OllamaGenerateResponse {
  response: string;
}

export class OllamaProvider implements ModelProvider {
  private readonly url: string;
  private readonly model: string;

  constructor(url = "http://localhost:11434/api/generate", model = "qwen3:8b") {
    this.url = url;
    this.model = model;
  }

  async generate(prompt: string): Promise<string> {
    const response = await fetch(this.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: this.model,
        prompt,
        stream: false,
      }),
    });

    if (!response.ok) {
      throw new Error(
        `Ollama request failed: ${response.status} ${response.statusText}`,
      );
    }

    const data = (await response.json()) as OllamaGenerateResponse;

    return data.response;
  }
}
