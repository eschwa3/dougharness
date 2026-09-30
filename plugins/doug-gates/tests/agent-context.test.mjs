import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentTranscriptPath, contextReading, windowFor, recordAgentContext, shouldNotify } from "../lib/agent-context.mjs";

function transcript(dir, name, lines) {
  const f = join(dir, name);
  writeFileSync(f, lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n") + "\n");
  return f;
}

describe("agentTranscriptPath", () => {
  it("uses agent_transcript_path when present", () => {
    expect(agentTranscriptPath({ agent_id: "a1", agent_transcript_path: "/x/agent-a1.jsonl", transcript_path: "/other" })).toBe("/x/agent-a1.jsonl");
  });
  it("uses transcript_path directly when it already names the subagent's file", () => {
    expect(agentTranscriptPath({ agent_id: "a1", transcript_path: "/proj/session/subagents/agent-a1.jsonl" })).toBe("/proj/session/subagents/agent-a1.jsonl");
  });
  it("derives the documented layout from transcript_path's dirname, session_id, and agent_id", () => {
    expect(agentTranscriptPath({ agent_id: "a1", session_id: "s1", transcript_path: "/proj/main.jsonl" })).toBe(join("/proj", "s1", "subagents", "agent-a1.jsonl"));
  });
  it("returns null without agent_id", () => {
    expect(agentTranscriptPath({ transcript_path: "/proj/main.jsonl", session_id: "s1" })).toBeNull();
  });
  it("returns null with agent_id but no path to derive from", () => {
    expect(agentTranscriptPath({ agent_id: "a1" })).toBeNull();
  });
});

describe("windowFor", () => {
  it("gives 1M for a Fable, Opus, or Sonnet 5 model id", () => {
    expect(windowFor("claude-fable-5-1")).toBe(1000000);
    expect(windowFor("claude-opus-5")).toBe(1000000);
    expect(windowFor("claude-sonnet-5")).toBe(1000000);
  });
  it("gives 200k for an unknown, null, or non-5 model, erring early", () => {
    expect(windowFor("claude-haiku-4-5")).toBe(200000);
    expect(windowFor(null)).toBe(200000);
    expect(windowFor(undefined)).toBe(200000);
    expect(windowFor("something-else")).toBe(200000);
  });
});

describe("contextReading", () => {
  it("reads the LAST assistant line with usage, against its model's window", () => {
    const dir = mkdtempSync(join(tmpdir(), "doug-actx-"));
    const f = transcript(dir, "a.jsonl", [
      { type: "assistant", message: { model: "claude-sonnet-5", usage: { input_tokens: 1000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } },
      { type: "assistant", message: { model: "claude-sonnet-5", usage: { input_tokens: 100000, cache_creation_input_tokens: 50000, cache_read_input_tokens: 50000 } } },
    ]);
    expect(contextReading(f)).toEqual({ tokens: 200000, model: "claude-sonnet-5", window: 1000000, pct: 20 });
  });
  it("skips malformed lines", () => {
    const dir = mkdtempSync(join(tmpdir(), "doug-actx-"));
    const f = transcript(dir, "a.jsonl", [
      "not json",
      { type: "assistant", message: { model: "claude-haiku-4-5", usage: { input_tokens: 100000 } } },
      "{also not json",
    ]);
    expect(contextReading(f)).toEqual({ tokens: 100000, model: "claude-haiku-4-5", window: 200000, pct: 50 });
  });
  it("returns null when no assistant line carries usage", () => {
    const dir = mkdtempSync(join(tmpdir(), "doug-actx-"));
    const f = transcript(dir, "a.jsonl", [{ type: "user", message: { role: "user", content: "hi" } }]);
    expect(contextReading(f)).toBeNull();
  });
  it("returns null when the file is missing", () => {
    expect(contextReading("/nope/none.jsonl")).toBeNull();
  });
});

describe("recordAgentContext", () => {
  it("writes state.agents[agentId].context and returns it", () => {
    const state = {};
    const now = new Date("2026-09-10T12:00:00.000Z");
    const entry = recordAgentContext(state, "ag1", { tokens: 500000, model: "claude-sonnet-5", window: 1000000, pct: 50 }, now);
    expect(entry).toEqual({ pct: 50, tokens: 500000, window: 1000000, model: "claude-sonnet-5", at: "2026-09-10T12:00:00.000Z", maxPct: 50, notifiedAt: undefined });
    expect(state.agents.ag1.context).toBe(entry);
  });
  it("tracks a running maximum across readings that dip back down", () => {
    const state = {};
    const now = new Date();
    recordAgentContext(state, "ag1", { tokens: 800000, model: "m", window: 1000000, pct: 80 }, now);
    const second = recordAgentContext(state, "ag1", { tokens: 300000, model: "m", window: 1000000, pct: 30 }, now);
    expect(second.pct).toBe(30);
    expect(second.maxPct).toBe(80);
  });
  it("preserves notifiedAt across updates until the caller changes it", () => {
    const state = { agents: { ag1: { context: { pct: 80, maxPct: 80, notifiedAt: 80 } } } };
    const entry = recordAgentContext(state, "ag1", { tokens: 900000, model: "m", window: 1000000, pct: 90 }, new Date());
    expect(entry.notifiedAt).toBe(80);
    expect(entry.maxPct).toBe(90);
  });
});

describe("shouldNotify", () => {
  const cfg = { contextWindow: { enabled: true, threshold: 80, repeatAfter: 5 } };
  it("is false below threshold", () => {
    expect(shouldNotify({ pct: 79, notifiedAt: undefined }, cfg)).toBe(false);
  });
  it("is true at the threshold with no prior notice", () => {
    expect(shouldNotify({ pct: 80, notifiedAt: undefined }, cfg)).toBe(true);
  });
  it("is false again until pct grows by repeatAfter past the last notice", () => {
    expect(shouldNotify({ pct: 84, notifiedAt: 80 }, cfg)).toBe(false);
  });
  it("is true again once pct reaches notifiedAt + repeatAfter", () => {
    expect(shouldNotify({ pct: 85, notifiedAt: 80 }, cfg)).toBe(true);
  });
  it("defaults threshold 80 and repeatAfter 5 when contextWindow is absent", () => {
    expect(shouldNotify({ pct: 80, notifiedAt: undefined }, {})).toBe(true);
    expect(shouldNotify({ pct: 84, notifiedAt: 80 }, {})).toBe(false);
  });
});
