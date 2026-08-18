/**
 * test-ollama-provider-tool-parsing.ts
 *
 * Deterministic unit tests for OllamaProvider's tool-call normalization.
 * Covers all required parser specifications without invoking the Ollama daemon.
 */

import { OllamaProvider } from "../models/OllamaProvider.js";
import type { ToolDefinition } from "../models/types.js";
import assert from "node:assert/strict";

// Subclass to access private normalizeToolCalls method deterministically
class TestableOllamaProvider extends OllamaProvider {
  public testNormalize(message: any, tools: ToolDefinition[]) {
    return (this as any).normalizeToolCalls(message, tools);
  }
}

const provider = new TestableOllamaProvider();

const dummyTools: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "search_files",
      description: "Search files in workspace",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
          path: { type: "string" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_directory",
      description: "List directory contents",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "complex_tool",
      description: "Tool with nested parameters",
      parameters: {
        type: "object",
        properties: {
          config: { type: "object" },
          tags: { type: "array" },
        },
      },
    },
  },
];

console.log("Running OllamaProvider tool parsing unit tests...\n");

// 1. Native tool_calls are normalized
{
  const msg = {
    role: "assistant",
    content: "",
    tool_calls: [
      {
        id: "call_native_1",
        function: {
          name: "search_files",
          arguments: { query: "Todo", path: "." },
        },
      },
    ],
  };
  const calls = provider.testNormalize(msg, dummyTools);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].id, "call_native_1");
  assert.strictEqual(calls[0].name, "search_files");
  assert.deepStrictEqual(calls[0].arguments, { query: "Todo", path: "." });
  console.log("PASS: 1. Native tool_calls are normalized");
}

// 2. Plain JSON fallback is normalized
{
  const msg = {
    role: "assistant",
    content: '{"name":"search_files","arguments":{"path":".","query":"Todo"}}',
  };
  const calls = provider.testNormalize(msg, dummyTools);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].id, "tool-call-fallback-0");
  assert.strictEqual(calls[0].name, "search_files");
  assert.deepStrictEqual(calls[0].arguments, { path: ".", query: "Todo" });
  console.log("PASS: 2. Plain JSON fallback is normalized");
}

// 3. Fenced JSON fallback is normalized (```json ... ``` and ``` ... ```)
{
  const msg1 = {
    role: "assistant",
    content: "```json\n{\n  \"name\": \"list_directory\",\n  \"arguments\": {\n    \"path\": \"src\"\n  }\n}\n```",
  };
  const calls1 = provider.testNormalize(msg1, dummyTools);
  assert.strictEqual(calls1.length, 1);
  assert.strictEqual(calls1[0].name, "list_directory");
  assert.deepStrictEqual(calls1[0].arguments, { path: "src" });

  const msg2 = {
    role: "assistant",
    content: "```\n{\n  \"name\": \"list_directory\",\n  \"arguments\": {\n    \"path\": \"src\"\n  }\n}\n```",
  };
  const calls2 = provider.testNormalize(msg2, dummyTools);
  assert.strictEqual(calls2.length, 1);
  assert.strictEqual(calls2[0].name, "list_directory");
  assert.deepStrictEqual(calls2[0].arguments, { path: "src" });
  console.log("PASS: 3. Fenced JSON fallback is normalized");
}

// 4. Leading/trailing whitespace is accepted
{
  const msg = {
    role: "assistant",
    content: "   \n\n  ```json\n{\"name\":\"search_files\",\"arguments\":{\"query\":\"Todo\"}}\n``` \n\n  ",
  };
  const calls = provider.testNormalize(msg, dummyTools);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].name, "search_files");
  assert.deepStrictEqual(calls[0].arguments, { query: "Todo" });
  console.log("PASS: 4. Leading/trailing whitespace is accepted");
}

// 5. Invalid JSON remains ordinary text (returns empty array)
{
  const msg = {
    role: "assistant",
    content: "```json\n{ not valid json }\n```",
  };
  const calls = provider.testNormalize(msg, dummyTools);
  assert.strictEqual(calls.length, 0);
  console.log("PASS: 5. Invalid JSON remains ordinary text");
}

// 6. JSON missing name is rejected
{
  const msg = {
    role: "assistant",
    content: '{"arguments": {"query": "Todo"}}',
  };
  const calls = provider.testNormalize(msg, dummyTools);
  assert.strictEqual(calls.length, 0);
  console.log("PASS: 6. JSON missing name is rejected");
}

// 7. JSON with non-object arguments is rejected
{
  const msg1 = {
    role: "assistant",
    content: '{"name": "search_files", "arguments": "invalid-string"}',
  };
  assert.strictEqual(provider.testNormalize(msg1, dummyTools).length, 0);

  const msg2 = {
    role: "assistant",
    content: '{"name": "search_files", "arguments": [1, 2, 3]}',
  };
  assert.strictEqual(provider.testNormalize(msg2, dummyTools).length, 0);

  const msg3 = {
    role: "assistant",
    content: '{"name": "search_files", "arguments": null}',
  };
  assert.strictEqual(provider.testNormalize(msg3, dummyTools).length, 0);
  console.log("PASS: 7. JSON with non-object arguments is rejected");
}

// 8. Unknown tool name is rejected (not in tool definitions)
{
  const msg = {
    role: "assistant",
    content: '{"name": "unknown_forbidden_tool", "arguments": {}}',
  };
  const calls = provider.testNormalize(msg, dummyTools);
  assert.strictEqual(calls.length, 0);
  console.log("PASS: 8. Unknown tool name is rejected/ignored");
}

// 9. Native tool_calls take precedence over content fallback
{
  const msg = {
    role: "assistant",
    content: '{"name": "list_directory", "arguments": {"path": "src"}}',
    tool_calls: [
      {
        id: "call_native_priority",
        function: {
          name: "search_files",
          arguments: { query: "NativeWins" },
        },
      },
    ],
  };
  const calls = provider.testNormalize(msg, dummyTools);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].id, "call_native_priority");
  assert.strictEqual(calls[0].name, "search_files");
  assert.deepStrictEqual(calls[0].arguments, { query: "NativeWins" });
  console.log("PASS: 9. Native tool_calls take precedence over content fallback");
}

// 10. Ordinary conversational text remains ordinary text
{
  const msg1 = {
    role: "assistant",
    content: "The repository contains a package.json file and src/ directory.",
  };
  assert.strictEqual(provider.testNormalize(msg1, dummyTools).length, 0);

  // Mixed conversational text with embedded JSON inside explanation should NOT be parsed
  const msg2 = {
    role: "assistant",
    content: "Here is the tool I would call:\n{\"name\": \"search_files\", \"arguments\": {\"query\": \"Todo\"}}\nPlease run it.",
  };
  assert.strictEqual(provider.testNormalize(msg2, dummyTools).length, 0);
  console.log("PASS: 10. Ordinary conversational text remains ordinary text");
}

// 11. Multiple native tool calls remain intact
{
  const msg = {
    role: "assistant",
    content: "",
    tool_calls: [
      {
        id: "call_1",
        function: { name: "search_files", arguments: { query: "A" } },
      },
      {
        id: "call_2",
        function: { name: "list_directory", arguments: { path: "B" } },
      },
    ],
  };
  const calls = provider.testNormalize(msg, dummyTools);
  assert.strictEqual(calls.length, 2);
  assert.strictEqual(calls[0].name, "search_files");
  assert.strictEqual(calls[1].name, "list_directory");
  console.log("PASS: 11. Multiple native tool calls remain intact");
}

// 12. Fallback arguments preserve nested objects/arrays
{
  const nestedArgs = {
    config: { debug: true, count: 42 },
    tags: ["unit", "fast"],
  };
  const msg = {
    role: "assistant",
    content: JSON.stringify({
      name: "complex_tool",
      arguments: nestedArgs,
    }),
  };
  const calls = provider.testNormalize(msg, dummyTools);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].name, "complex_tool");
  assert.deepStrictEqual(calls[0].arguments, nestedArgs);
  console.log("PASS: 12. Fallback arguments preserve nested objects/arrays");
}

console.log("\nAll 12 OllamaProvider tool parsing tests PASSED.");
