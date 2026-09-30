import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Proves pickTraceFile sorts the .jsonl listing before matching a --session prefix, rather than taking whatever
// order readdirSync hands back (this filesystem returns sorted order already, so a fixture-only test would pass
// either way). Rigs a deliberately unsorted, ambiguous-prefix listing for one sentinel directory.
const SENTINEL = "__unsorted_trace__";
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: (...args: unknown[]) => {
      if (String(args[0]).endsWith(SENTINEL)) return true;
      return (actual.existsSync as (...a: unknown[]) => boolean)(...args);
    },
    readdirSync: (...args: unknown[]) => {
      if (String(args[0]).endsWith(SENTINEL)) return ["abc2.jsonl", "abc1.jsonl"];
      return (actual.readdirSync as (...a: unknown[]) => unknown)(...args);
    },
  };
});

import { pickTraceFile, renderTrace, runTrace } from "../src/trace.js";

// `doug trace` reads what the trace hook wrote (plugins/doug-gates/lib/trace.mjs) and never estimates: an agent
// whose tokens Claude Code did not report prints null.

async function run(argv: string[]) {
  let stdout = "";
  let stderr = "";
  const code = await runTrace(argv, { stdout: (s) => void (stdout += s), stderr: (s) => void (stderr += s) });
  return { code, stdout, stderr };
}

const t = (s: string) => `2026-09-06T19:00:${s}.000Z`;
const line = (o: Record<string, unknown>) => JSON.stringify({ session: "s1", agent: null, agentType: null, tool: null, toolUseId: null, detail: null, ok: null, tokens: null, ...o });
const events = [
  line({ t: t("00"), event: "PreToolUse", tool: "Read", toolUseId: "1", detail: "src/a.ts" }),
  line({ t: t("01"), event: "PostToolUse", tool: "Read", toolUseId: "1", detail: "src/a.ts", ok: true }),
  line({ t: t("02"), event: "SubagentStart", agent: "agent-0001", agentType: "Explore" }),
  line({ t: t("03"), event: "PreToolUse", agent: "agent-0001", agentType: "Explore", tool: "Grep", toolUseId: "2", detail: "foo" }),
  line({ t: t("04"), event: "PostToolUse", agent: "agent-0001", agentType: "Explore", tool: "Grep", toolUseId: "2", detail: "foo", ok: false }),
  line({ t: t("32"), event: "SubagentStop", agent: "agent-0001", agentType: "Explore", toolUseId: "3", tokens: { input: 12, output: 34, cacheRead: 56, cacheWrite: 0, messages: 2, model: "claude-sonnet-5" } }),
  line({ t: t("40"), event: "PreToolUse", tool: "Bash", toolUseId: "4", detail: "pnpm test" }),
];

function project(): string {
  const dir = mkdtempSync(join(tmpdir(), "doug-trace-cli-"));
  const traceDir = join(dir, ".doug/.state/trace");
  mkdirSync(traceDir, { recursive: true });
  writeFileSync(join(traceDir, "older.jsonl"), line({ t: t("00"), event: "PreToolUse", session: "older", tool: "Read" }) + "\n");
  utimesSync(join(traceDir, "older.jsonl"), new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
  writeFileSync(join(traceDir, "s1.jsonl"), events.join("\n") + "\n");
  return dir;
}

describe("doug trace", () => {
  it("replays the newest session and attributes tool calls, wall time, and tokens per agent, null where unreported", async () => {
    const dir = project();
    const r = await run([dir]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Trace s1: 7 events");
    expect(r.stdout).toContain("19:00:00  main                    PreToolUse     Read  src/a.ts");
    expect(r.stdout).toContain("FAILED");
    expect(r.stdout).toContain("| main | main | 3 | Read 1, Bash 1 | 0 | 40 s | null |");
    expect(r.stdout).toContain("| agent-00 | Explore | 4 | Grep 1 | 1 | 30 s | 12 in / 34 out / 56 cache read |");
  });
  it("selects a session with --session, prints JSON with --json, and exits 1 when there is nothing to read", async () => {
    const dir = project();
    const older = await run([dir, "--session", "older"]);
    expect(older.stdout).toContain("Trace older: 1 events");
    const json = await run([dir, "--json", "--session", "s1"]);
    const parsed = JSON.parse(json.stdout);
    expect(parsed.session).toBe("s1");
    expect(parsed.events).toHaveLength(7);
    expect(parsed.agents.map((a: { agent: string }) => a.agent)).toEqual(["main", "agent-0001"]);
    expect(parsed.agents[0].tokens).toBeNull();
    const missing = await run([dir, "--session", "nope"]);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain("no trace for session nope");
    const empty = await run([mkdtempSync(join(tmpdir(), "doug-trace-empty-"))]);
    expect(empty.code).toBe(1);
    expect(empty.stderr).toContain("trace.enabled");
    expect(pickTraceFile(join(dir, "nowhere"), null)).toBeNull();
  });
  it("renders a session with no events without crashing", () => {
    expect(renderTrace("x", "/f", [])).toContain("Trace x: 0 events");
  });
  it("picks the name-sorted-first match for an ambiguous --session prefix, not readdirSync's raw order", () => {
    const dir = `/anything/${SENTINEL}`;
    expect(pickTraceFile(dir, "abc")).toBe(join(dir, "abc1.jsonl"));
  });
});
