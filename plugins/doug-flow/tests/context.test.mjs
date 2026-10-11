import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CONTEXT_THRESHOLD_DEFAULT, atThreshold, contextReading, contextThreshold, windowFor } from "../lib/context.mjs";
import { projectSlug, sessionTranscriptPath } from "../lib/cost.mjs";
import { contextReading as gatesReading, windowFor as gatesWindowFor } from "../../doug-gates/lib/agent-context.mjs";

// Card autopilot-unlimited: the lead measures its own context between cards. lib/context.mjs carries a copy of the
// gates' windowFor/contextReading (the plugins install separately); scripts/context.mjs prints one line.
const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, "..", "scripts", "context.mjs");
const MODEL = "claude-haiku-4-5"; // a 200000-token window, so token counts read as round percentages

const tmp = (prefix) => realpathSync(mkdtempSync(join(tmpdir(), prefix)));
const usageLine = (tokens, model = MODEL) =>
  JSON.stringify({ type: "assistant", message: { model, usage: { input_tokens: 1000, cache_creation_input_tokens: 2000, cache_read_input_tokens: tokens - 3000 } } });
// Three usage lines (5%, 95%, then the last one) between non-usage and unparseable lines: only the LAST is the reading.
const transcriptText = (lastTokens) =>
  [
    JSON.stringify({ type: "user", message: { content: "hi" } }),
    usageLine(10000),
    "{ not json",
    usageLine(190000),
    JSON.stringify({ type: "assistant", message: { content: [] } }),
    usageLine(lastTokens),
    "",
  ].join("\n");

function project({ config, transcripts = { "sess-a": transcriptText(120000) } } = {}) {
  const dir = tmp("doug-context-project-");
  const claudeDir = tmp("doug-context-claude-");
  if (config !== undefined) {
    mkdirSync(join(dir, ".doug"), { recursive: true });
    writeFileSync(join(dir, ".doug/config.json"), typeof config === "string" ? config : JSON.stringify(config));
  }
  const slugDir = join(claudeDir, "projects", projectSlug(dir));
  mkdirSync(slugDir, { recursive: true });
  const files = {};
  for (const [id, text] of Object.entries(transcripts)) {
    files[id] = join(slugDir, `${id}.jsonl`);
    writeFileSync(files[id], text);
  }
  return { dir, claudeDir, slugDir, files };
}
// CLAUDE_CODE_SESSION_ID defaults to empty: inside Claude Code the real one is set, and would make every test read it.
const runCli = (args, env = {}) =>
  spawnSync(process.execPath, [script, ...args], { encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: "", CLAUDE_CODE_SESSION_ID: "", ...env } });

describe("lib/context.mjs: windowFor and contextReading are the gates' pair", () => {
  it("windowFor agrees with the gates' copy", () => {
    for (const m of ["claude-opus-5", "claude-sonnet-5", "claude-fable-5-1", "claude-haiku-4-5", "claude-opus-4", "", undefined, null, 7]) {
      expect(windowFor(m), String(m)).toBe(gatesWindowFor(m));
    }
    expect(windowFor("claude-haiku-4-5")).toBe(200000);
    expect(windowFor("claude-opus-5")).toBe(1000000);
  });
  it("contextReading takes the LAST usage line and agrees with the gates' contextReading on the same fixture", () => {
    const p = project();
    const mine = contextReading(p.files["sess-a"]);
    expect(mine).toEqual({ tokens: 120000, model: MODEL, window: 200000, pct: 60 });
    expect(mine).toEqual(gatesReading(p.files["sess-a"]));
  });
  it("contextReading is null for a missing file and for a transcript with no usage line", () => {
    const p = project({ transcripts: { empty: JSON.stringify({ type: "user", message: { content: "x" } }) + "\n" } });
    expect(contextReading(p.files.empty)).toBeNull();
    expect(contextReading(join(p.slugDir, "absent.jsonl"))).toBeNull();
    expect(contextReading(null)).toBeNull();
  });
});

describe("lib/context.mjs: the threshold", () => {
  it("defaults to 60 when the config, autopilot, or the key is absent or null, with no warning", () => {
    expect(CONTEXT_THRESHOLD_DEFAULT).toBe(60);
    const warnings = [];
    const warn = (m) => warnings.push(m);
    for (const cfg of [undefined, null, {}, { autopilot: null }, { autopilot: {} }, { autopilot: { contextThreshold: null } }, { autopilot: { contextThreshold: undefined } }]) {
      expect(contextThreshold(cfg, warn), JSON.stringify(cfg)).toBe(60);
    }
    expect(warnings).toEqual([]);
  });
  it("uses the configured value", () => {
    const warnings = [];
    const warn = (m) => warnings.push(m);
    expect(contextThreshold({ autopilot: { contextThreshold: 30 } }, warn)).toBe(30);
    expect(contextThreshold({ autopilot: { contextThreshold: 1 } }, warn)).toBe(1);
    expect(contextThreshold({ autopilot: { contextThreshold: 100 } }, warn)).toBe(100);
    expect(contextThreshold({ autopilot: { contextThreshold: 72.5 } }, warn)).toBe(72.5);
    expect(warnings).toEqual([]);
  });
  it("falls back to 60 with exactly one warning naming autopilot.contextThreshold for a non-number or out-of-range value", () => {
    for (const bad of ["70", 0, 150, 101, 0.5, -5, NaN, Infinity, {}, [], true]) {
      const warnings = [];
      expect(contextThreshold({ autopilot: { contextThreshold: bad } }, (m) => warnings.push(m)), String(bad)).toBe(60);
      expect(warnings, String(bad)).toHaveLength(1);
      expect(warnings[0]).toContain("autopilot.contextThreshold");
    }
  });
  it("atThreshold is pct >= threshold: equal stops, one below continues", () => {
    expect(atThreshold(60, 60)).toBe(true);
    expect(atThreshold(61, 60)).toBe(true);
    expect(atThreshold(59, 60)).toBe(false);
    expect(atThreshold(30, 30)).toBe(true);
    expect(atThreshold(29, 30)).toBe(false);
  });
});

describe("lib/cost.mjs sessionTranscriptPath", () => {
  it("returns the top-level transcript for an id, and the most recently modified one for latest", () => {
    const p = project({ transcripts: { "sess-old": transcriptText(1), "sess-new": transcriptText(2) } });
    utimesSync(p.files["sess-old"], new Date("2026-01-01T00:00:00Z"), new Date("2026-01-01T00:00:00Z"));
    utimesSync(p.files["sess-new"], new Date("2026-02-01T00:00:00Z"), new Date("2026-02-01T00:00:00Z"));
    expect(sessionTranscriptPath({ session: "sess-old", claudeDir: p.claudeDir, projectDir: p.dir })).toBe(p.files["sess-old"]);
    expect(sessionTranscriptPath({ session: "latest", claudeDir: p.claudeDir, projectDir: p.dir })).toBe(p.files["sess-new"]);
  });
  it("throws for an unknown id, for latest with no transcript, and for no session", () => {
    const p = project({ transcripts: {} });
    expect(() => sessionTranscriptPath({ session: "nope", claudeDir: p.claudeDir, projectDir: p.dir })).toThrow(/nope/);
    expect(() => sessionTranscriptPath({ session: "latest", claudeDir: p.claudeDir, projectDir: p.dir })).toThrow(/no session transcript/);
    expect(() => sessionTranscriptPath({ claudeDir: p.claudeDir, projectDir: p.dir })).toThrow();
  });
});

describe("scripts/context.mjs", () => {
  it("prints the exact line for the last usage line, default threshold 60: at the boundary it says stop", () => {
    const p = project({ transcripts: { "sess-a": transcriptText(120000) } });
    const r = runCli([p.dir, "--claude-dir", p.claudeDir]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toBe("context: 60% (120000 of 200000 tokens, claude-haiku-4-5); threshold 60% (autopilot.contextThreshold) -> stop\n");
  });
  it("says continue one point below the threshold", () => {
    const p = project({ transcripts: { "sess-a": transcriptText(118000) } });
    const r = runCli([p.dir, "--claude-dir", p.claudeDir]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toBe("context: 59% (118000 of 200000 tokens, claude-haiku-4-5); threshold 60% (autopilot.contextThreshold) -> continue\n");
  });
  it("uses the configured threshold from <dir>/.doug/config.json", () => {
    const p = project({ config: { autopilot: { contextThreshold: 30 } }, transcripts: { "sess-a": transcriptText(80000) } });
    const r = runCli([p.dir, "--claude-dir", p.claudeDir]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toBe("context: 40% (80000 of 200000 tokens, claude-haiku-4-5); threshold 30% (autopilot.contextThreshold) -> stop\n");
    const q = project({ config: { autopilot: { contextThreshold: 90 } }, transcripts: { "sess-a": transcriptText(120000) } });
    const r2 = runCli([q.dir, "--claude-dir", q.claudeDir]);
    expect(r2.stdout).toBe("context: 60% (120000 of 200000 tokens, claude-haiku-4-5); threshold 90% (autopilot.contextThreshold) -> continue\n");
  });
  it("an invalid configured threshold warns on stderr and still prints the line with 60", () => {
    const p = project({ config: { autopilot: { contextThreshold: "70" } }, transcripts: { "sess-a": transcriptText(80000) } });
    const r = runCli([p.dir, "--claude-dir", p.claudeDir]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toContain("autopilot.contextThreshold");
    expect(r.stdout).toBe("context: 40% (80000 of 200000 tokens, claude-haiku-4-5); threshold 60% (autopilot.contextThreshold) -> continue\n");
  });
  it("reads the latest session by default and a named one with --session", () => {
    const p = project({ transcripts: { "sess-old": transcriptText(40000), "sess-new": transcriptText(120000) } });
    utimesSync(p.files["sess-old"], new Date("2026-01-01T00:00:00Z"), new Date("2026-01-01T00:00:00Z"));
    utimesSync(p.files["sess-new"], new Date("2026-02-01T00:00:00Z"), new Date("2026-02-01T00:00:00Z"));
    expect(runCli([p.dir, "--claude-dir", p.claudeDir]).stdout).toContain("context: 60% (120000 of");
    expect(runCli([p.dir, "--session", "sess-old", "--claude-dir", p.claudeDir]).stdout).toContain("context: 20% (40000 of");
    expect(runCli([p.dir, "--session", "latest", "--claude-dir", p.claudeDir]).stdout).toContain("context: 60% (120000 of");
  });
  it("exits 1 with a stderr message and no stdout when there is no transcript", () => {
    const p = project({ transcripts: {} });
    const r = runCli([p.dir, "--claude-dir", p.claudeDir]);
    expect(r.status).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr.trim()).not.toBe("");
  });
  it("exits 1 with a stderr message and no stdout when the transcript has no usage line", () => {
    const p = project({ transcripts: { "sess-a": JSON.stringify({ type: "user", message: { content: "x" } }) + "\n" } });
    const r = runCli([p.dir, "--claude-dir", p.claudeDir]);
    expect(r.status).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr.trim()).not.toBe("");
  });

  // Card context-reads-reflect-transcript: a bare run after memory.mjs reflect read the reflect session's (newer) transcript.
  describe("the default session is the lead's own (CLAUDE_CODE_SESSION_ID)", () => {
    const leadAndReflect = () => {
      const p = project({
        transcripts: {
          "sess-lead": usageLine(140000, "claude-opus-5") + "\n", // 14% of 1000000
          "sess-reflect": usageLine(138000) + "\n", // 69% of 200000, haiku
        },
      });
      utimesSync(p.files["sess-lead"], new Date("2026-01-01T00:00:00Z"), new Date("2026-01-01T00:00:00Z"));
      utimesSync(p.files["sess-reflect"], new Date("2026-02-01T00:00:00Z"), new Date("2026-02-01T00:00:00Z"));
      return p;
    };
    it("with the variable set and no --session, reads the lead's transcript, not the newer non-lead one", () => {
      const p = leadAndReflect();
      const r = runCli([p.dir, "--claude-dir", p.claudeDir], { CLAUDE_CODE_SESSION_ID: "sess-lead" });
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toBe("context: 14% (140000 of 1000000 tokens, claude-opus-5); threshold 60% (autopilot.contextThreshold) -> continue\n");
    });
    it("an explicit --session wins over the variable, for an id and for latest", () => {
      const p = leadAndReflect();
      const env = { CLAUDE_CODE_SESSION_ID: "sess-lead" };
      expect(runCli([p.dir, "--session", "sess-reflect", "--claude-dir", p.claudeDir], env).stdout).toContain("context: 69% (138000 of 200000");
      expect(runCli([p.dir, "--session", "latest", "--claude-dir", p.claudeDir], env).stdout).toContain("context: 69% (138000 of 200000");
    });
    it("with the variable empty and no --session, reads the newest transcript", () => {
      const p = leadAndReflect();
      expect(runCli([p.dir, "--claude-dir", p.claudeDir], { CLAUDE_CODE_SESSION_ID: "" }).stdout).toContain("context: 69% (138000 of 200000");
    });
    it("a variable naming a session with no transcript exits 1 naming it, never falling back to the newest", () => {
      const p = leadAndReflect();
      const r = runCli([p.dir, "--claude-dir", p.claudeDir], { CLAUDE_CODE_SESSION_ID: "sess-missing" });
      expect(r.status).toBe(1);
      expect(r.stdout).toBe("");
      expect(r.stderr).toContain("sess-missing");
    });
  });
});
