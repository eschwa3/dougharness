import { describe, it, expect } from "vitest";
import { parseEvents, extractJsonObject } from "../src/parse.js";
import { validateModelReview, exitCodeFor } from "../src/schema.js";
import type { ReviewResult } from "../src/schema.js";

const line = (o: unknown) => JSON.stringify(o);

describe("parseEvents", () => {
  it("takes commands and exit codes from completed command_execution items, in order", () => {
    const jsonl = [
      line({ type: "thread.started", thread_id: "t1" }),
      line({ type: "item.started", item: { id: "item_1", type: "command_execution", command: "echo a", aggregated_output: "", exit_code: null, status: "in_progress" } }),
      line({ type: "item.completed", item: { id: "item_1", type: "command_execution", command: "echo a", aggregated_output: "a\n", exit_code: 0, status: "completed" } }),
      line({ type: "item.completed", item: { id: "item_2", type: "command_execution", command: "false", aggregated_output: "", exit_code: 1, status: "failed" } }),
      line({ type: "item.completed", item: { id: "item_3", type: "agent_message", text: '{"verdict":"pass","summary":"s","issues":[]}' } }),
      line({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 2 } }),
    ].join("\n");
    const p = parseEvents(jsonl);
    expect(p.threadId).toBe("t1");
    expect(p.commandsRun).toEqual([
      { command: "echo a", exitCode: 0, ok: true, outputTail: "a\n" },
      { command: "false", exitCode: 1, ok: false, outputTail: undefined },
    ]);
    expect(p.finalMessage).toBe('{"verdict":"pass","summary":"s","issues":[]}');
    expect(p.usage).toEqual({ inputTokens: 10, outputTokens: 2 });
    expect(p.unparsedLines).toBe(0);
  });
  it("keeps a started-but-never-completed command with a null exit code and ok=false", () => {
    const p = parseEvents(line({ type: "item.started", item: { id: "item_9", type: "command_execution", command: "sleep 999", exit_code: null, status: "in_progress" } }));
    expect(p.commandsRun).toEqual([{ command: "sleep 999", exitCode: null, ok: false, outputTail: undefined }]);
  });
  it("uses the last agent_message as the final message and counts non-JSON lines", () => {
    const p = parseEvents(["garbage", line({ type: "item.completed", item: { id: "a", type: "agent_message", text: "first" } }), line({ type: "item.completed", item: { id: "b", type: "agent_message", text: "last" } }), ""].join("\n"));
    expect(p.finalMessage).toBe("last");
    expect(p.unparsedLines).toBe(1);
  });
  it("collects error and turn.failed messages without duplicating them", () => {
    const msg = '{"error":{"code":"invalid_json_schema"}}';
    const p = parseEvents([line({ type: "error", message: msg }), line({ type: "turn.failed", error: { message: msg } }), line({ type: "turn.failed", error: { message: "other" } })].join("\n"));
    expect(p.errors).toEqual([msg, "other"]);
    expect(p.finalMessage).toBeNull();
  });
  it("truncates long command output to a tail", () => {
    const out = "x".repeat(2000);
    const p = parseEvents(line({ type: "item.completed", item: { id: "i", type: "command_execution", command: "c", aggregated_output: out, exit_code: 0 } }));
    expect(p.commandsRun[0].outputTail!.length).toBe(600);
  });
});

describe("extractJsonObject", () => {
  it("parses bare JSON, fenced JSON, and JSON surrounded by prose", () => {
    expect(extractJsonObject('{"a":1}')).toEqual({ a: 1 });
    expect(extractJsonObject('Here:\n```json\n{"a":2}\n```\nthanks')).toEqual({ a: 2 });
    expect(extractJsonObject('Verdict below {"a":{"b":"}"},"c":[1,2]} end')).toEqual({ a: { b: "}" }, c: [1, 2] });
  });
  it("returns null for prose and for arrays", () => {
    expect(extractJsonObject("no json here")).toBeNull();
    expect(extractJsonObject("[1,2]")).toBeNull();
  });
});

describe("validateModelReview", () => {
  it("accepts a well-formed review and drops unknown or malformed optional fields", () => {
    const r = validateModelReview({ verdict: "fail", summary: "s", issues: [{ severity: "blocker", file: "a.ts", line: 3.5, description: "d", evidence: "" }] });
    expect("review" in r && r.review.issues[0]).toEqual({ severity: "blocker", file: "a.ts", description: "d" });
  });
  it("rejects bad verdicts, severities, and empty descriptions", () => {
    expect(validateModelReview({ verdict: "ok", summary: "", issues: [] })).toHaveProperty("error");
    expect(validateModelReview({ verdict: "pass", summary: "", issues: [{ severity: "critical", file: "a", description: "d" }] })).toHaveProperty("error");
    expect(validateModelReview({ verdict: "pass", summary: "", issues: [{ severity: "minor", file: "a", description: " " }] })).toHaveProperty("error");
    expect(validateModelReview([])).toHaveProperty("error");
  });
});

describe("exitCodeFor", () => {
  const stub = (over: Partial<ReviewResult>): ReviewResult => ({
    verdict: "pass", summary: "", issues: [], commandsRun: [], changedFiles: [], base: "b", head: "h", dir: "/", reviewer: "codex", model: null, error: null, codexExitCode: 0, durationMs: 1, usage: null, ...over,
  });
  it("is 0 for pass, 1 for fail or any blocker, 2 for inconclusive or error", () => {
    expect(exitCodeFor(stub({}))).toBe(0);
    expect(exitCodeFor(stub({ verdict: "fail" }))).toBe(1);
    expect(exitCodeFor(stub({ issues: [{ severity: "blocker", file: "f", description: "d" }] }))).toBe(1);
    expect(exitCodeFor(stub({ verdict: "inconclusive" }))).toBe(2);
    expect(exitCodeFor(stub({ error: { kind: "timeout", message: "t" } }))).toBe(2);
  });
});
