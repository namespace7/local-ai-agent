const response = await fetch("http://localhost:11434/api/chat", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    model: "qwen3:8b",
    messages: [
      {
        role: "user",
        content: "What files are in the current project?",
      },
    ],
    tools: [
      {
        type: "function",
        function: {
          name: "list_directory",
          description:
            "List files and directories inside the current project directory.",
          parameters: {
            type: "object",
            properties: {
              path: {
                type: "string",
                description: "Directory path relative to the project root.",
              },
            },
            required: [],
          },
        },
      },
    ],
    stream: false,
  }),
});

if (!response.ok) {
  throw new Error(
    `Ollama request failed: ${response.status} ${response.statusText}`,
  );
}

const data = await response.json();

console.log(JSON.stringify(data, null, 2));
