// Ambient types for the run-trace library in the doug-gates plugin (plain ESM, no shipped types).
// Keep in step with plugins/doug-gates/lib/trace.mjs.

declare module "@dougharness/gates/lib/trace.mjs" {
  export const TRACE_DIR_RELPATH: string;

  export interface TraceTokens {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    messages: number;
    model: string | null;
  }

  export interface TraceLine {
    t: string;
    event: string;
    session: string | null;
    agent: string | null;
    agentType: string | null;
    tool: string | null;
    toolUseId: string | null;
    detail: string | null;
    ok: boolean | null;
    tokens: TraceTokens | null;
    context: number | null;
    reason: string | null;
  }

  export interface AgentAttribution {
    agent: string;
    agentType: string | null;
    events: number;
    toolCalls: Record<string, number>;
    failedCalls: number;
    startedAt: string | null;
    endedAt: string | null;
    wallMs: number | null;
    tokens: TraceTokens | null;
  }

  export function tracePath(dir: string, sessionId: string): string;
  export function readTrace(file: string): TraceLine[];
  export function replay(lines: TraceLine[]): string[];
  export function attribution(lines: TraceLine[]): AgentAttribution[];
}
