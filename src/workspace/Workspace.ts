import { resolve, relative, isAbsolute } from "node:path";

export class Workspace {
  readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  resolvePath(inputPath: string): string {
    if (isAbsolute(inputPath)) {
      throw new Error("Absolute paths are not allowed");
    }

    const resolvedPath = resolve(this.root, inputPath);
    const relativePath = relative(this.root, resolvedPath);

    if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
      throw new Error("Path is outside the workspace");
    }

    return resolvedPath;
  }
}
