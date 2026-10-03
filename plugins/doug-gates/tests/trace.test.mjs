import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendTrace, attribution, detailOf, readTrace, replay, tracePath, traceLine, usageFromTranscript } from "../lib/trace.mjs";

// The run trace (decision 0002, card run-trace): one line per event, tokens only where Claude Code reported them.

function transcript(lines) {
  const f = join(mkdtempSync(join(tmpdir(), "doug-trace-")), "agent.jsonl");
  writeFileSync(f, lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n") + "\n");
  return f;
}

describe("traceLine", () => {
  const now = new Date("2026-09-06T19:00:00.000Z");
  it("records the event, session, agent, tool, a one-line detail, and null tokens for a tool call", () => {
    const l = traceLine({ hook_event_name: "PreToolUse", session_id: "s1", tool_name: "Bash", tool_use_id: "tu1", tool_input: { command: "pnpm   test\n", description: "Run tests" } }, { now });
    expect(l).toEqual({ t: "2026-09-06T19:00:00.000Z", event: "PreToolUse", session: "s1", agent: null, agentType: null, tool: "Bash", toolUseId: "tu1", detail: "pnpm test", ok: null, tokens: null, context: null, reason: null });
  });
  it("records a Skill tool call's skill name as detail (card learn-signals)", () => {
    const l = traceLine({ hook_event_name: "PreToolUse", session_id: "s1", tool_name: "Skill", tool_use_id: "tu1", tool_input: { skill: "doug-board" } }, { now });
    expect(l.detail).toBe("doug-board");
    expect(detailOf({ skill: "doug-learn" })).toBe("doug-learn");
  });
  it("records InstructionsLoaded path-only, never the file_content, plus its load_reason", () => {
    const l = traceLine(
      { hook_event_name: "InstructionsLoaded", session_id: "s1", file_path: "/p/CLAUDE.md", load_reason: "session_start", file_content: "# secret prose that must never be traced" },
      { now }
    );
    expect(l).toMatchObject({ event: "InstructionsLoaded", detail: "/p/CLAUDE.md", reason: "session_start", ok: null, tool: null });
    expect(JSON.stringify(l)).not.toContain("secret prose");
    expect(traceLine({ hook_event_name: "InstructionsLoaded", session_id: "s1" }, { now })).toMatchObject({ detail: null, reason: null });
  });
  it("records PermissionDenied as ok:false with the denied tool's detail and a clipped reason", () => {
    const l = traceLine(
      { hook_event_name: "PermissionDenied", session_id: "s1", tool_name: "Bash", tool_use_id: "tu9", tool_input: { command: "pnpm test" }, denial_reason: "x".repeat(200) },
      { now }
    );
    expect(l).toMatchObject({ event: "PermissionDenied", tool: "Bash", toolUseId: "tu9", detail: "pnpm test", ok: false });
    expect(l.reason.length).toBe(120);
    expect(traceLine({ hook_event_name: "PermissionDenied", session_id: "s1", tool_name: "Bash" }, { now }).reason).toBeNull();
  });
  it("marks a PostToolUse ok or failed from the response and keeps the agent id inside a subagent", () => {
    const base = { hook_event_name: "PostToolUse", session_id: "s1", agent_id: "a1", agent_type: "Explore", tool_name: "Read", tool_use_id: "tu2", tool_input: { file_path: "/p/src/x.ts" } };
    expect(traceLine({ ...base, tool_response: { filePath: "/p/src/x.ts" } }, { now })).toMatchObject({ agent: "a1", agentType: "Explore", tool: "Read", detail: "/p/src/x.ts", ok: true });
    expect(traceLine({ ...base, tool_output: { is_error: true } }, { now }).ok).toBe(false);
    expect(traceLine({ ...base, tool_response: "plain text" }, { now }).ok).toBe(true);
    expect(traceLine({ ...base }, { now }).ok).toBeNull();
  });
  it("clips a long detail and prefers the command, file, pattern, then description", () => {
    expect(detailOf({ command: "x".repeat(300) }).length).toBe(120);
    expect(detailOf({ pattern: "foo.*", path: "src" })).toBe("foo.*");
    expect(detailOf({ description: "Find things", prompt: "long prompt" })).toBe("Find things");
    expect(detailOf({ other: 1 })).toBeNull();
    expect(detailOf(null)).toBeNull();
  });
  it("sums a subagent's tokens from its transcript at SubagentStop, once per message id, and records null without one", () => {
    const f = transcript([
      { type: "assistant", message: { id: "m1", model: "claude-sonnet-5", usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 } } },
      { type: "assistant", message: { id: "m1", model: "claude-sonnet-5", usage: { input_tokens: 10, output_tokens: 40, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 } } },
      { type: "assistant", message: { id: "m2", model: "claude-sonnet-5", usage: { input_tokens: 3, output_tokens: 7 } } },
      { type: "user", message: { role: "user", content: "x" } },
      "not json",
    ]);
    const stop = traceLine({ hook_event_name: "SubagentStop", session_id: "s1", agent_id: "a1", agent_type: "Explore", agent_transcript_path: f, tool_use_id: "tu9" }, { now });
    expect(stop.tokens).toEqual({ input: 13, output: 47, cacheRead: 100, cacheWrite: 20, messages: 2, model: "claude-sonnet-5" });
    expect(stop.toolUseId).toBe("tu9");
    expect(traceLine({ hook_event_name: "SubagentStop", session_id: "s1", agent_id: "a2", agent_transcript_path: "/nope/none.jsonl" }, { now }).tokens).toBeNull();
    expect(usageFromTranscript(transcript([{ type: "user", message: {} }]))).toBeNull();
    expect(usageFromTranscript(null)).toBeNull();
  });
});

describe("appendTrace, readTrace, replay, attribution", () => {
  const dir = mkdtempSync(join(tmpdir(), "doug-trace-proj-"));
  const t = (s) => `2026-09-06T19:00:${s}.000Z`;
  const lines = [
    { t: t("00"), event: "PreToolUse", session: "s/1", agent: null, agentType: null, tool: "Read", toolUseId: "1", detail: "a.ts", ok: null, tokens: null },
    { t: t("01"), event: "PostToolUse", session: "s/1", agent: null, agentType: null, tool: "Read", toolUseId: "1", detail: "a.ts", ok: true, tokens: null },
    { t: t("02"), event: "SubagentStart", session: "s/1", agent: "agent-abcdef01", agentType: "Explore", tool: null, toolUseId: null, detail: null, ok: null, tokens: null },
    { t: t("03"), event: "PreToolUse", session: "s/1", agent: "agent-abcdef01", agentType: "Explore", tool: "Grep", toolUseId: "2", detail: "foo", ok: null, tokens: null },
    { t: t("04"), event: "PostToolUse", session: "s/1", agent: "agent-abcdef01", agentType: "Explore", tool: "Grep", toolUseId: "2", detail: "foo", ok: false, tokens: null },
    { t: t("09"), event: "SubagentStop", session: "s/1", agent: "agent-abcdef01", agentType: "Explore", tool: null, toolUseId: "3", detail: null, ok: null, tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, messages: 1, model: "m" } },
    { t: t("10"), event: "PreToolUse", session: "s/1", agent: null, agentType: null, tool: "Bash", toolUseId: "4", detail: "pnpm test", ok: null, tokens: null },
  ];
  it("appends one line per event to .doug/.state/trace/<safe session>.jsonl and reads them back, skipping torn lines", () => {
    for (const l of lines) appendTrace(dir, l);
    const file = tracePath(dir, "s/1");
    expect(file.endsWith("/.doug/.state/trace/s_1.jsonl")).toBe(true);
    expect(existsSync(file)).toBe(true);
    writeFileSync(file, readFileSync(file, "utf8") + '{"t":"2026-09-06T19:00:11.000Z","event":"PreTool');
    expect(readTrace(file)).toEqual(lines);
  });
  it("replays time, agent, event, tool, detail, failures, and the tokens line", () => {
    const r = replay(lines);
    expect(r[0]).toBe("19:00:00  main                    PreToolUse     Read  a.ts");
    expect(r[4]).toContain("Explore:agent-ab");
    expect(r[4]).toContain("FAILED");
    expect(r[5]).toContain("tokens in 1 out 2");
    expect(replay([{ ...lines[5], tokens: null }])[0]).toContain("tokens null");
  });
  it("replays the reason for InstructionsLoaded and PermissionDenied, and prints nothing extra for old lines without the field (card learn-signals)", () => {
    const denied = { t: t("11"), event: "PermissionDenied", session: "s/1", agent: null, agentType: null, tool: "Bash", toolUseId: "5", detail: "pnpm test", ok: false, tokens: null, reason: "auto mode denied" };
    const loaded = { t: t("12"), event: "InstructionsLoaded", session: "s/1", agent: null, agentType: null, tool: null, toolUseId: null, detail: "CLAUDE.md", ok: null, tokens: null, reason: "session_start" };
    const [deniedLine, loadedLine] = replay([denied, loaded]);
    expect(deniedLine).toContain("auto mode denied");
    expect(loadedLine).toContain("session_start");
    expect(replay([lines[0]])[0]).toBe("19:00:00  main                    PreToolUse     Read  a.ts");
  });
  it("attributes events, tool calls, failed calls, wall time, and tokens per agent, main first", () => {
    const a = attribution(lines);
    expect(a.map((x) => x.agent)).toEqual(["main", "agent-abcdef01"]);
    expect(a[0]).toMatchObject({ agentType: "main", events: 3, toolCalls: { Read: 1, Bash: 1 }, failedCalls: 0, wallMs: 10000, tokens: null });
    expect(a[1]).toMatchObject({ agentType: "Explore", events: 4, toolCalls: { Grep: 1 }, failedCalls: 1, wallMs: 7000, tokens: { input: 1, output: 2 } });
  });
});

// card trace-redact-secrets: a traced detail never carries a credential. Every fixture is built by
// concatenation so this file never holds a whole token (the secret-scan hook would deny the write).
describe("detailOf redaction (card trace-redact-secrets)", () => {
  const GH = "ghp_" + "aB3dE5gH7jK9mN1pQ3sT5vX7zA9cE1gI3kM5";
  const AWS = "AKIA" + "IOSFODNN7EXAMPLE";
  const PW_VALUE = "hunter2" + "hunter2";
  const PW = "password = " + PW_VALUE;
  const now = new Date("2026-09-06T19:00:00.000Z");

  function windows(s, n = 6) {
    const out = [];
    for (let i = 0; i + n <= s.length; i++) out.push(s.slice(i, i + n));
    return out;
  }
  function expectNoSubstring(detail, secret) {
    for (const w of windows(secret)) expect(detail, `detail leaks "${w}"`).not.toContain(w);
  }

  it("T1 a GitHub token in a Bash command traces as [redacted: githubToken], with no part of the token", () => {
    const d = detailOf({ command: "curl -H 'Authorization: token " + GH + "' https://api.github.com/user" });
    expect(d).toBe("[redacted: githubToken]");
    expectNoSubstring(d, GH);
  });
  it("T2 an AWS key id traces as [redacted: awsKeyId], with no part of the key", () => {
    const d = detailOf({ command: "aws configure set aws_access_key_id " + AWS });
    expect(d).toBe("[redacted: awsKeyId]");
    expectNoSubstring(d, AWS);
  });
  it("T3 an inline password assignment traces as [redacted: inlineAssignment], with no part of the value", () => {
    const d = detailOf({ command: "echo " + PW + " >> .env" });
    expect(d).toBe("[redacted: inlineAssignment]");
    expectNoSubstring(d, PW_VALUE);
  });
  it("T4 a secret that starts after character 150 is still redacted (the full string is scanned, not the clip)", () => {
    const cmd = "echo " + "x".repeat(150) + " " + GH;
    const d = detailOf({ command: cmd });
    expect(d).toBe("[redacted: githubToken]");
    expectNoSubstring(d, GH);
  });
  it("T5 a clean command traces as today's clipped text, exactly", () => {
    const long = "pnpm exec vitest run " + "plugins/doug-gates/tests/trace.test.mjs ".repeat(8);
    const d = detailOf({ command: long });
    const t = long.replace(/\s+/g, " ").trim();
    expect(t.length).toBeGreaterThan(120);
    expect(d).toBe(t.slice(0, 119) + "…");
    expect(detailOf({ command: "pnpm   test\n" })).toBe("pnpm test");
    expect(detailOf({ file_path: "/p/src/a.ts" })).toBe("/p/src/a.ts");
  });
  it("T6 secrets.rules.githubToken:false leaves the token command unredacted; secrets.enabled:false disables redaction", () => {
    const cmd = "git push https://x:" + GH + "@github.com/o/r.git";
    const off = detailOf({ command: cmd }, { rules: { githubToken: false } });
    expect(off).not.toContain("[redacted");
    expect(off).toContain("git push");
    const disabled = detailOf({ command: cmd }, { enabled: false });
    expect(disabled).not.toContain("[redacted");
    expect(disabled).toContain("git push");
    // another rule stays on while githubToken is off
    expect(detailOf({ command: "echo " + AWS }, { rules: { githubToken: false } })).toBe("[redacted: awsKeyId]");
  });
  it("T7 a scanner that throws redacts as [redacted: scan-error]; detailOf and traceLine never throw", () => {
    const secrets = {
      get rules() {
        throw new Error("boom");
      },
    };
    const cmd = "echo hello " + GH;
    expect(() => detailOf({ command: cmd }, secrets)).not.toThrow();
    expect(detailOf({ command: cmd }, secrets)).toBe("[redacted: scan-error]");
    let l;
    expect(() => {
      l = traceLine({ hook_event_name: "PreToolUse", session_id: "s1", tool_name: "Bash", tool_use_id: "tu1", tool_input: { command: cmd } }, { now, secrets });
    }).not.toThrow();
    expect(l.detail).toBe("[redacted: scan-error]");
  });
  it("T8 traceLine carries the redacted detail on PreToolUse and PermissionDenied, and no line holds the token", () => {
    const base = { session_id: "s1", tool_name: "Bash", tool_use_id: "tu1", tool_input: { command: "echo " + GH } };
    for (const event of ["PreToolUse", "PermissionDenied"]) {
      const l = traceLine({ ...base, hook_event_name: event }, { now, secrets: {} });
      expect(l.detail, event).toBe("[redacted: githubToken]");
      expect(JSON.stringify(l), event).not.toContain(GH.slice(0, 12));
    }
    // traceLine without a secrets option still applies the default rules
    expect(traceLine({ ...base, hook_event_name: "PreToolUse" }, { now }).detail).toBe("[redacted: githubToken]");
  });

  // card trace-redact-reason: PermissionDenied's reason is scanned the same way detail is.
  const denied = (reason, secrets) =>
    traceLine(
      { hook_event_name: "PermissionDenied", session_id: "s1", tool_name: "Bash", tool_use_id: "tu1", tool_input: { command: "ls" }, denial_reason: reason },
      secrets === undefined ? { now } : { now, secrets },
    );

  it("R1 a denial_reason carrying a GitHub token traces as [redacted: githubToken], with no part of the token", () => {
    const l = denied("Denied: command quotes token " + GH + " in its arguments", {});
    expect(l.reason).toBe("[redacted: githubToken]");
    expectNoSubstring(l.reason, GH);
    expect(JSON.stringify(l)).not.toContain(GH.slice(0, 12));
  });
  it("R2 a token that starts after character 150 of the denial_reason is still redacted", () => {
    const reason = "Denied: " + "x".repeat(150) + " " + GH;
    expect(reason.indexOf(GH)).toBeGreaterThan(150);
    const l = denied(reason, {});
    expect(l.reason).toBe("[redacted: githubToken]");
    expectNoSubstring(l.reason, GH);
  });
  it("R3 a clean denial_reason traces as today's clipped text, exactly", () => {
    const long = "Denied by rule: " + "path is outside the project root ".repeat(8);
    const t = long.replace(/\s+/g, " ").trim();
    expect(t.length).toBeGreaterThan(120);
    const l = denied(long, {});
    expect(l.reason).toBe(t.slice(0, 119) + "…");
    expect(denied("Denied: not allowed", {}).reason).toBe("Denied: not allowed");
  });
  it("R4 a scanner that throws redacts the reason as [redacted: scan-error]; traceLine does not throw", () => {
    const secrets = {
      get rules() {
        throw new Error("boom");
      },
    };
    let l;
    expect(() => {
      l = denied("Denied: quotes " + GH, secrets);
    }).not.toThrow();
    expect(l.reason).toBe("[redacted: scan-error]");
  });
  it("R5 secrets.rules.githubToken:false leaves the reason clipped text; secrets.enabled:false disables redaction", () => {
    const reason = "Denied: quotes " + GH;
    expect(denied(reason, { rules: { githubToken: false } }).reason).toBe(reason);
    expect(denied(reason, { enabled: false }).reason).toBe(reason);
    // another rule stays on while githubToken is off
    expect(denied("Denied: quotes " + AWS, { rules: { githubToken: false } }).reason).toBe("[redacted: awsKeyId]");
  });
});
