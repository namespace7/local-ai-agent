export interface ModelTrace {
  type: "model";
  iteration: number;
  durationMs: number;
  toolCallCount: number;
}

export interface ToolTrace {
  type: "tool";
  iteration: number;
  toolName: string;
  durationMs: number;
  success: boolean;
  error?: string;
}

export type TraceEvent = ModelTrace | ToolTrace;

export class ExecutionTrace {
  private readonly events: TraceEvent[] = [];

  add(event: TraceEvent): void {
    this.events.push(event);
  }

  getEvents(): TraceEvent[] {
    return [...this.events];
  }

  totalDurationMs(): number {
    return this.events.reduce((total, event) => total + event.durationMs, 0);
  }
}
