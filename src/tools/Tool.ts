export interface Tool {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;

  execute(input: unknown): Promise<unknown>;
}
