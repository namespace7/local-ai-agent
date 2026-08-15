import type { ModelProvider } from "../../models/ModelProvider.js";
import type {
  Message,
  ModelResponse,
  ToolDefinition,
} from "../../models/types.js";

export class FakeModelProvider implements ModelProvider {
  private index = 0;

  constructor(private readonly responses: ModelResponse[]) {}

  async generate(
    _messages: Message[],
    _tools: ToolDefinition[],
  ): Promise<ModelResponse> {
    const response = this.responses[this.index];

    if (!response) {
      throw new Error(
        `FakeModelProvider has no response for iteration ${this.index}`,
      );
    }

    this.index += 1;

    return response;
  }
}
