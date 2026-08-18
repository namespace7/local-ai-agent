import { mkdtemp, readFile, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

import { ReplaceContentTool } from "../tools/ReplaceContentTool.js";
import { Workspace } from "../workspace/Workspace.js";

const root = await mkdtemp(join(tmpdir(), "local-ai-agent-replace-test-"));

try {
  const workspace = new Workspace(root);
  const tool = new ReplaceContentTool(workspace);

  // Setup sample file
  await mkdir(join(root, "src"), { recursive: true });
  const sampleFilePath = join(root, "src", "todos.ts");
  const initialContent = `import { Todo } from './types';

export class TodoService {
  private todos: Todo[] = [];

  addTodo(text: string): void {
    this.todos.push({ text });
  }
}
`;
  await writeFile(sampleFilePath, initialContent, "utf8");

  // 1. Successful exact single replacement
  const result1 = (await tool.execute({
    path: "src/todos.ts",
    target: "import { Todo } from './types';",
    replacement: "import { Todo } from './types.js';",
  })) as { path: string; replaced: boolean; occurrences: number; bytesWritten: number };

  assert.strictEqual(result1.path, "src/todos.ts");
  assert.strictEqual(result1.replaced, true);
  assert.strictEqual(result1.occurrences, 1);
  assert.strictEqual(result1.bytesWritten > 0, true);

  const updatedContent1 = await readFile(sampleFilePath, "utf8");
  assert.strictEqual(
    updatedContent1,
    `import { Todo } from './types.js';

export class TodoService {
  private todos: Todo[] = [];

  addTodo(text: string): void {
    this.todos.push({ text });
  }
}
`,
  );

  // 2. Multiline replacement preserving rest of file
  await tool.execute({
    path: "src/todos.ts",
    target: `  addTodo(text: string): void {
    this.todos.push({ text });
  }`,
    replacement: `  addTodo(text: string): Todo {
    const todo = { id: 1, text };
    this.todos.push(todo);
    return todo;
  }`,
  });

  const updatedContent2 = await readFile(sampleFilePath, "utf8");
  assert.strictEqual(
    updatedContent2,
    `import { Todo } from './types.js';

export class TodoService {
  private todos: Todo[] = [];

  addTodo(text: string): Todo {
    const todo = { id: 1, text };
    this.todos.push(todo);
    return todo;
  }
}
`,
  );

  // 3. Target not found (0 matches) => rejected with descriptive error
  await assert.rejects(
    async () => {
      await tool.execute({
        path: "src/todos.ts",
        target: "nonExistentString()",
        replacement: "replacement()",
      });
    },
    (err: Error) => {
      assert.match(err.message, /Target content not found in file: 'src\/todos.ts'/);
      return true;
    },
  );

  // 4. Multiple matches (>1 matches) => rejected with descriptive error
  // Setup file with duplicates
  await writeFile(
    join(root, "src", "dup.ts"),
    `const a = 1;\nconst b = 1;\nconst c = 1;\n`,
    "utf8",
  );
  await assert.rejects(
    async () => {
      await tool.execute({
        path: "src/dup.ts",
        target: "1",
        replacement: "2",
      });
    },
    (err: Error) => {
      assert.match(err.message, /Target content matches 3 locations in 'src\/dup.ts'/);
      return true;
    },
  );

  // 5. Empty target => rejected
  await assert.rejects(
    async () => {
      await tool.execute({
        path: "src/todos.ts",
        target: "",
        replacement: "something",
      });
    },
    (err: Error) => {
      assert.match(err.message, /replace_content 'target' must be a non-empty string/);
      return true;
    },
  );

  // 6. Empty replacement => valid deletion
  await tool.execute({
    path: "src/dup.ts",
    target: "const c = 1;\n",
    replacement: "",
  });
  const dupContentAfterDeletion = await readFile(join(root, "src", "dup.ts"), "utf8");
  assert.strictEqual(dupContentAfterDeletion, `const a = 1;\nconst b = 1;\n`);

  // 7. Special characters in target
  await writeFile(
    join(root, "src", "special.ts"),
    `const regex = /^[a-z]+$/;\nconst arr = [1, 2, (3 + 4)];\n`,
    "utf8",
  );
  await tool.execute({
    path: "src/special.ts",
    target: `const regex = /^[a-z]+$/;`,
    replacement: `const regex = /^[A-Z]+$/;`,
  });
  const specialContent = await readFile(join(root, "src", "special.ts"), "utf8");
  assert.strictEqual(
    specialContent,
    `const regex = /^[A-Z]+$/;\nconst arr = [1, 2, (3 + 4)];\n`,
  );

  // 8. Path traversal rejection
  await assert.rejects(
    async () => {
      await tool.execute({
        path: "../outside.txt",
        target: "foo",
        replacement: "bar",
      });
    },
    (err: Error) => {
      assert.match(err.message, /Path is outside the workspace/);
      return true;
    },
  );

  // 9. Absolute path rejection
  await assert.rejects(
    async () => {
      await tool.execute({
        path: "/tmp/outside.txt",
        target: "foo",
        replacement: "bar",
      });
    },
    (err: Error) => {
      assert.match(err.message, /Absolute paths are not allowed/);
      return true;
    },
  );

  // 10. Non-existent file rejection
  await assert.rejects(
    async () => {
      await tool.execute({
        path: "src/does-not-exist.ts",
        target: "foo",
        replacement: "bar",
      });
    },
    (err: Error) => {
      assert.match(err.message, /File does not exist: 'src\/does-not-exist.ts'/);
      return true;
    },
  );

  // 11. Directory path target rejection
  await assert.rejects(
    async () => {
      await tool.execute({
        path: "src",
        target: "foo",
        replacement: "bar",
      });
    },
    (err: Error) => {
      assert.match(err.message, /Path is a directory, not a file: 'src'/);
      return true;
    },
  );

  console.log("PASS: ReplaceContentTool unit tests and safety invariants passed.");
} finally {
  await rm(root, { recursive: true, force: true });
}
