import { describe, it, expect } from "vitest";
import { writeFileSync, appendFileSync, mkdirSync, readFileSync, existsSync, mkdtempSync, symlinkSync, rmSync, readdirSync, statSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { join, dirname, basename } from "node:path";
import { tmpdir } from "node:os";
import { makeProject, runHookScript, decision, context, scriptsDir } from "./helpers.mjs";
// card stop-gate-process-storm: runCommand is exercised directly (case 1), the same way the proposal-ledger
// test below crosses the plugin boundary for a documented reason — see that comment just below.
// card gates-runner-no-color: commandEnv is exercised directly (T1) the same way runCommand is above; it does
// not exist yet, so this whole file fails to import until the coder adds it.
import { runCommand, commandEnv } from "../lib/run.mjs";
// card proposal-ledger-forgeable: a genuine ledger line is built the way applyProposal itself builds one - a
// test may cross the plugin boundary even though lib code may not (see plugins/doug-gates/lib/proposals.mjs's
// own header comment for that precedent).
import { applyProposal, unifiedDiff } from "../../doug-flow/lib/learn.mjs";
import { splitSnapshot, SNAPSHOT_START, SNAPSHOT_END } from "../lib/anchor.mjs";
// card stop-gate-block-ledger, round 3: classifyFinalBlock exercised directly (same precedent as runCommand
// and applyProposal above) to pin the budget-dropped-without-timeout precondition and the
// budgetDeadline-gated race check without spinning up a whole gate run through stop-gate.mjs. changedFiles is
// the same helper classifyFinalBlock itself calls, used here only to build a realistic "changed right now"
// set to diff the test's own changedAtStart fixture against.
import { classifyFinalBlock } from "../lib/block-ledger.mjs";
import { changedFiles } from "../lib/baseline.mjs";
// card stop-gate-skips-orphan-subagent-stops: the state file the test seeds directly is written/read through
// loadState/saveState (the module's own default shape), never a guessed JSON literal.
import { loadState, saveState } from "../lib/state.mjs";

// Swaps the case of every letter in a path. On a case-insensitive, case-preserving volume (APFS's default) the
// result names the same file on disk as the original — a case-variant alias.
const swapCase = (p) => p.split("").map((c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase())).join("");

// Probed at run time, not assumed from process.platform: a case-variant alias only exists on a case-insensitive
// volume, so on a case-sensitive one (Linux CI, or a case-sensitive APFS volume) the swapped-case path names
// nothing and the test below would be asserting on a different code path entirely.
const CASE_INSENSITIVE_FS = (() => {
  const probe = mkdtempSync(join(tmpdir(), "doug-casEprobe-"));
  try {
    return existsSync(swapCase(probe));
  } catch {
    return false;
  }
})();

const baseConfig = {
  packageManager: "pnpm",
  protectedPaths: [".env", ".env.*", "pnpm-lock.yaml", "prisma/migrations/**", "dist/**"],
  commands: { test: "node -e \"process.exit(0)\"" },
  // requireEvidence is on by default; these fixtures turn it off so each gate is tested on its own, and the
  // verification-evidence block has its own cases below.
  stopGate: { commands: ["test"], onlyIfEdited: true, maxBlocks: 3, timeoutMs: 10000, requireEvidence: false },
  editLoop: { threshold: 3, windowMinutes: 30 },
  anchor: ["Use pnpm, never npm."],
};

describe("protect-paths", () => {
  it("denies edits to protected files and allows others", () => {
    const dir = makeProject({ config: baseConfig });
    const deny = runHookScript("protect-paths", { hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: { file_path: join(dir, ".env") } }, { dir });
    expect(deny.status).toBe(0);
    expect(decision(deny)).toBe("deny");
    expect(deny.json.hookSpecificOutput.permissionDecisionReason).toContain(".env");

    const mig = runHookScript("protect-paths", { tool_name: "Write", tool_input: { file_path: "prisma/migrations/0002/migration.sql" } }, { dir });
    expect(decision(mig)).toBe("deny");

    const ok = runHookScript("protect-paths", { tool_name: "Edit", tool_input: { file_path: join(dir, "src/a.ts") } }, { dir });
    expect(ok.status).toBe(0);
    expect(ok.json).toBeNull();
  });
  it("denies paths outside the project, naming allowedOutsidePaths in the message", () => {
    const dir = makeProject({ config: baseConfig });
    const r = runHookScript("protect-paths", { tool_name: "Edit", tool_input: { file_path: "/etc/hosts" } }, { dir });
    expect(decision(r)).toBe("deny");
    expect(r.json.hookSpecificOutput.permissionDecisionReason).toContain("allowedOutsidePaths");
  });
  it("defaults allowedOutsidePaths to [] and refuses everything outside exactly as today", () => {
    const dir = makeProject({ config: baseConfig });
    const outsideDir = mkdtempSync(join(tmpdir(), "doug-outside-"));
    const r = runHookScript("protect-paths", { tool_name: "Write", tool_input: { file_path: join(outsideDir, "notes.md") } }, { dir });
    expect(decision(r)).toBe("deny");
  });
  it("allows a write inside an allowedOutsidePaths directory", () => {
    const outsideDir = mkdtempSync(join(tmpdir(), "doug-outside-"));
    const dir = makeProject({ config: { ...baseConfig, allowedOutsidePaths: [outsideDir] } });
    const r = runHookScript("protect-paths", { tool_name: "Write", tool_input: { file_path: join(outsideDir, "notes.md") } }, { dir });
    expect(r.json).toBeNull();
  });
  it("allows a write at an allowedOutsidePaths file exactly", () => {
    const outsideDir = mkdtempSync(join(tmpdir(), "doug-outside-"));
    const target = join(outsideDir, "notes.md");
    const dir = makeProject({ config: { ...baseConfig, allowedOutsidePaths: [target] } });
    const r = runHookScript("protect-paths", { tool_name: "Write", tool_input: { file_path: target } }, { dir });
    expect(r.json).toBeNull();
  });
  it("refuses a sibling-prefix path, proving the segment boundary", () => {
    const outsideDir = mkdtempSync(join(tmpdir(), "doug-outside-"));
    const dir = makeProject({ config: { ...baseConfig, allowedOutsidePaths: [outsideDir] } });
    const r = runHookScript("protect-paths", { tool_name: "Write", tool_input: { file_path: `${outsideDir}-other/notes.md` } }, { dir });
    expect(decision(r)).toBe("deny");
  });
  it("expands a ~-prefixed allowedOutsidePaths entry against HOME", () => {
    const fakeHome = mkdtempSync(join(tmpdir(), "doug-home-"));
    const dir = makeProject({ config: { ...baseConfig, allowedOutsidePaths: ["~/memory"] } });
    const r = runHookScript(
      "protect-paths",
      { tool_name: "Write", tool_input: { file_path: join(fakeHome, "memory", "notes.md") } },
      { dir, env: { HOME: fakeHome } },
    );
    expect(r.json).toBeNull();
  });
  it("refuses a .. path that resolves outside an allowed directory", () => {
    const outsideDir = mkdtempSync(join(tmpdir(), "doug-outside-"));
    const dir = makeProject({ config: { ...baseConfig, allowedOutsidePaths: [outsideDir] } });
    const r = runHookScript("protect-paths", { tool_name: "Write", tool_input: { file_path: join(outsideDir, "..", "escape.md") } }, { dir });
    expect(decision(r)).toBe("deny");
  });
  it("checks every file in a MultiEdit", () => {
    const dir = makeProject({ config: baseConfig });
    const r = runHookScript("protect-paths", { tool_name: "MultiEdit", tool_input: { edits: [{ file_path: "src/a.ts" }, { file_path: "pnpm-lock.yaml" }] } }, { dir });
    expect(decision(r)).toBe("deny");
  });
  it("uses defaults when no config exists", () => {
    const dir = makeProject();
    const r = runHookScript("protect-paths", { tool_name: "Edit", tool_input: { file_path: ".env" } }, { dir });
    expect(decision(r)).toBe("deny");
  });
  it("denies edits to .doug/config.json itself, by default (defaults include it, item 4)", () => {
    const dir = makeProject();
    const r = runHookScript("protect-paths", { tool_name: "Edit", tool_input: { file_path: join(dir, ".doug/config.json") } }, { dir });
    expect(decision(r)).toBe("deny");
    expect(r.json.hookSpecificOutput.permissionDecisionReason).toContain(".doug/config.json");
  });

  // card memory-decisions: docs/decisions/ and .claude/rules/ are proposal-only paths - written only through
  // an approved proposal diff (/doug-decide, or memory.mjs decision|rule propose then learn.mjs apply).
  describe("proposalPaths (card memory-decisions)", () => {
    it("denies Edit and Write under docs/decisions/ and .claude/rules/, naming /doug-decide and learn.mjs apply", () => {
      const dir = makeProject({ config: baseConfig });
      const decisionEdit = runHookScript("protect-paths", { tool_name: "Edit", tool_input: { file_path: "docs/decisions/0007-x.md" } }, { dir });
      expect(decision(decisionEdit)).toBe("deny");
      expect(decisionEdit.json.hookSpecificOutput.permissionDecisionReason).toContain("/doug-decide");
      expect(decisionEdit.json.hookSpecificOutput.permissionDecisionReason).toContain("learn.mjs apply");

      const ruleWrite = runHookScript("protect-paths", { tool_name: "Write", tool_input: { file_path: ".claude/rules/tests.md" } }, { dir });
      expect(decision(ruleWrite)).toBe("deny");
      expect(ruleWrite.json.hookSpecificOutput.permissionDecisionReason).toContain("/doug-decide");
      expect(ruleWrite.json.hookSpecificOutput.permissionDecisionReason).toContain("learn.mjs apply");
    });
    it("allows both paths when proposalPaths is set to []", () => {
      const dir = makeProject({ config: { ...baseConfig, proposalPaths: [] } });
      expect(runHookScript("protect-paths", { tool_name: "Edit", tool_input: { file_path: "docs/decisions/0007-x.md" } }, { dir }).json).toBeNull();
      expect(runHookScript("protect-paths", { tool_name: "Write", tool_input: { file_path: ".claude/rules/tests.md" } }, { dir }).json).toBeNull();
    });
  });

  describe("aliases cannot bypass protectedPaths or allowedOutsidePaths (items 2 and 3)", () => {
    it.skipIf(!CASE_INSENSITIVE_FS)("denies a case-variant alias of an in-project protected file, even though allowedOutsidePaths covers the alias's parent", () => {
      const dir = makeProject({ config: baseConfig });
      const swappedDir = swapCase(dir);
      // Reproduces the exact bypass the review found: an allowedOutsidePaths entry covers the case-variant
      // alias, which the OLD lexical classification treated as "outside the project" and let straight through.
      writeFileSync(join(dir, ".doug/config.json"), JSON.stringify({ ...baseConfig, allowedOutsidePaths: [swappedDir] }));
      const r = runHookScript("protect-paths", { tool_name: "Write", tool_input: { file_path: join(swappedDir, ".env") } }, { dir });
      expect(decision(r)).toBe("deny");
      expect(r.json.hookSpecificOutput.permissionDecisionReason).toContain('matches protected path pattern ".env"');
      expect(r.json.hookSpecificOutput.permissionDecisionReason).not.toContain("allowedOutsidePaths");
    });
    it("denies a symlink alias of an in-project protected file, even though allowedOutsidePaths covers the symlink's parent", () => {
      const dir = makeProject({ config: baseConfig });
      const linkParent = mkdtempSync(join(tmpdir(), "doug-alias-"));
      const linkPath = join(linkParent, "project-alias");
      symlinkSync(dir, linkPath, "dir");
      writeFileSync(join(dir, ".doug/config.json"), JSON.stringify({ ...baseConfig, allowedOutsidePaths: [linkParent] }));
      const r = runHookScript("protect-paths", { tool_name: "Write", tool_input: { file_path: join(linkPath, ".env") } }, { dir });
      expect(decision(r)).toBe("deny");
      expect(r.json.hookSpecificOutput.permissionDecisionReason).toContain('matches protected path pattern ".env"');
      expect(r.json.hookSpecificOutput.permissionDecisionReason).not.toContain("allowedOutsidePaths");
    });
    it("denies a symlink inside an allowedOutsidePaths directory that really points outside it (item 3)", () => {
      const outsideDir = mkdtempSync(join(tmpdir(), "doug-outside-"));
      const secretFile = join(outsideDir, "secret.md");
      writeFileSync(secretFile, "outside");
      const allowedDir = mkdtempSync(join(tmpdir(), "doug-allowed-"));
      const linkInsideAllowed = join(allowedDir, "escape-link.md");
      symlinkSync(secretFile, linkInsideAllowed, "file");
      const dir = makeProject({ config: { ...baseConfig, allowedOutsidePaths: [allowedDir] } });
      const r = runHookScript("protect-paths", { tool_name: "Write", tool_input: { file_path: linkInsideAllowed } }, { dir });
      expect(decision(r)).toBe("deny");
    });
  });
});

// Card gates-config-shape-check: today, a wrong-shape protectedPaths (a string, iterated per character by
// matchAny's `for (const raw of patterns)`) makes every path read as protected, and a non-iterable value (a
// number) makes matchAny throw, which the stop gate only survives by failing open. Once loadConfig normalises
// a wrong-shape key to its default (with one stderr warning), neither happens: a string protectedPaths no
// longer blocks an unrelated edit, and a numeric one no longer crashes the gate into "failing open".
describe("card gates-config-shape-check (end to end)", () => {
  it("a string protectedPaths no longer makes protect-paths refuse an edit to an unrelated file, and still refuses .env (default)", () => {
    const dir = makeProject({ config: { ...baseConfig, protectedPaths: "secrets/**" } });
    const ok = runHookScript("protect-paths", { tool_name: "Edit", tool_input: { file_path: join(dir, "src/a.ts") } }, { dir });
    expect(ok.status).toBe(0);
    expect(ok.json, `expected src/a.ts to be allowed; got ${JSON.stringify(ok.json)}`).toBeNull();

    const deny = runHookScript("protect-paths", { tool_name: "Edit", tool_input: { file_path: join(dir, ".env") } }, { dir });
    expect(decision(deny)).toBe("deny");
  });

  it("a numeric protectedPaths no longer makes the stop gate fail open with \"hook error, failing open\"", () => {
    const dir = makeProject({ config: { ...baseConfig, protectedPaths: 42 }, git: true });
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src/a.ts"), "base");
    execFileSync("git", ["add", "-A"], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", "base"], { cwd: dir });
    writeFileSync(join(dir, "src/a.ts"), "edited this session");
    runHookScript("edit-loop", { tool_name: "Edit", tool_input: { file_path: "src/a.ts" } }, { dir });
    const r = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
    expect(r.status).toBe(0);
    const out = JSON.stringify(r.json || {});
    expect(out, `expected no "hook error, failing open" crash; got ${out}, stderr=${r.stderr}`).not.toMatch(/hook error, failing open/);
  });
});

// Card research-fetch-cap: a PreToolUse gate counting WebSearch plus WebFetch calls per subagent, denying past
// research.maxFetches (default 6). The script does not exist yet, so every case here fails until it's written.
describe("research-cap (card research-fetch-cap)", () => {
  const counterFile = (dir, session = "test-session", agent = "ag1") => join(dir, ".doug/.state/research-cap", session, `${agent}.log`);
  const call = (dir, overrides = {}) =>
    runHookScript(
      "research-cap",
      { hook_event_name: "PreToolUse", tool_name: "WebFetch", tool_input: { url: "https://example.com" }, agent_id: "ag1", agent_type: "researcher", ...overrides },
      { dir },
    );

  it("RC1 allows the first 6 WebFetch/WebSearch calls for a subagent and denies the 7th, naming research.maxFetches and telling it to write findings now", () => {
    const dir = makeProject({ config: baseConfig });
    for (let i = 0; i < 6; i++) {
      const r = call(dir);
      expect(decision(r), `call ${i + 1}`).not.toBe("deny");
    }
    const seventh = call(dir);
    expect(decision(seventh)).toBe("deny");
    const reason = seventh.json.hookSpecificOutput.permissionDecisionReason;
    expect(reason).toContain("research.maxFetches");
    expect(reason.toLowerCase()).toContain("write");
  });

  it("RC2 a denied call is not counted: the counter file still has 6 lines after the 7th is denied", () => {
    const dir = makeProject({ config: baseConfig });
    for (let i = 0; i < 6; i++) call(dir);
    const seventh = call(dir);
    expect(decision(seventh)).toBe("deny");
    const lines = readFileSync(counterFile(dir), "utf8").split("\n").filter(Boolean);
    expect(lines.length).toBe(6);
  });

  it("RC3 another agent's calls are not counted toward the first agent's budget", () => {
    const dir = makeProject({ config: baseConfig });
    for (let i = 0; i < 6; i++) call(dir, { agent_id: "ag1" });
    const denied = call(dir, { agent_id: "ag1" });
    expect(decision(denied)).toBe("deny");
    const otherAgentFirstCall = call(dir, { agent_id: "ag2" });
    expect(decision(otherAgentFirstCall)).not.toBe("deny");
  });

  it("RC4 the main session (no agent_id) is never capped and writes no counter file", () => {
    const dir = makeProject({ config: baseConfig });
    for (let i = 0; i < 10; i++) {
      const r = call(dir, { agent_id: undefined });
      expect(decision(r), `call ${i + 1}`).not.toBe("deny");
    }
    expect(existsSync(join(dir, ".doug/.state/research-cap"))).toBe(false);
  });

  it("RC5 config override: research.maxFetches 2 denies the 3rd call; research.maxFetches null allows unlimited calls", () => {
    const capped = makeProject({ config: { ...baseConfig, research: { maxFetches: 2 } } });
    expect(decision(call(capped))).not.toBe("deny");
    expect(decision(call(capped))).not.toBe("deny");
    expect(decision(call(capped))).toBe("deny");

    const uncapped = makeProject({ config: { ...baseConfig, research: { maxFetches: null } } });
    for (let i = 0; i < 10; i++) {
      const r = call(uncapped);
      expect(decision(r), `call ${i + 1}`).not.toBe("deny");
    }
  });

  it("RC6 fails open with a visible systemMessage naming research-cap when the counter path is unreadable, e.g. a directory sits where the log file should be", () => {
    const dir = makeProject({ config: baseConfig });
    mkdirSync(counterFile(dir), { recursive: true });
    const r = call(dir);
    expect(r.status).toBe(0);
    expect(decision(r)).not.toBe("deny");
    // P3 (pass 2): the script's own local try/catch is gone, so the I/O error reaches runHook, which fails
    // open but visibly (plugins/doug-gates/lib/io.mjs runHook emits `{ systemMessage: msg }` naming the hook).
    expect(r.json?.systemMessage).toBeTruthy();
    expect(r.json?.systemMessage).toContain("research-cap");
  });

  it("RC7 sessions are separate: 6 calls in one session do not cap the same agent id in another session", () => {
    const dir = makeProject({ config: baseConfig });
    for (let i = 0; i < 6; i++) call(dir, { session_id: "session-a" });
    const deniedInA = call(dir, { session_id: "session-a" });
    expect(decision(deniedInA)).toBe("deny");
    const firstInB = call(dir, { session_id: "session-b" });
    expect(decision(firstInB)).not.toBe("deny");
  });

  // Walks a directory recursively, returning every file's absolute path (skips .git for speed; nothing under
  // it is ever relevant here since makeProject only calls `git init` in other describes).
  const walkFiles = (d) => {
    const out = [];
    for (const name of readdirSync(d)) {
      if (name === ".git") continue;
      const p = join(d, name);
      const st = statSync(p);
      if (st.isDirectory()) out.push(...walkFiles(p));
      else out.push(p);
    }
    return out;
  };

  it("RC8 research.maxFetches 0 turns the cap off: 10 subagent calls all allowed and no counter file is written", () => {
    const dir = makeProject({ config: { ...baseConfig, research: { maxFetches: 0 } } });
    for (let i = 0; i < 10; i++) {
      const r = call(dir);
      expect(decision(r), `call ${i + 1}`).not.toBe("deny");
    }
    expect(existsSync(join(dir, ".doug/.state/research-cap"))).toBe(false);
  });

  it("RC9 a path-traversal agent id and session id never create a file outside .doug/.state/research-cap/", () => {
    const dir = makeProject({ config: baseConfig });
    const before = new Set(walkFiles(dir));
    const r = call(dir, { agent_id: "../../../evil/..", session_id: "../x" });
    expect(decision(r)).not.toBe("deny");
    const capRoot = join(dir, ".doug/.state/research-cap");
    const created = walkFiles(dir).filter((p) => !before.has(p));
    expect(created.length).toBeGreaterThan(0); // the hook did write a counter file somewhere
    for (const p of created) expect(p.startsWith(capRoot + "/"), p).toBe(true);
  });

  it("RC10 a 200-character agent id gives a counter-file basename truncated to exactly 120 characters", () => {
    const dir = makeProject({ config: baseConfig });
    const longAgent = "a".repeat(200);
    const r = call(dir, { agent_id: longAgent });
    expect(decision(r)).not.toBe("deny");
    const sessionDir = join(dir, ".doug/.state/research-cap", "test-session");
    const files = readdirSync(sessionDir);
    expect(files.length).toBe(1);
    const base = files[0].replace(/\.log$/, "");
    expect(base.length).toBe(120);
  });

  it("RC11 a missing or empty session id falls back to no-session, like the trace hook's safeId (P5)", () => {
    const dir = makeProject({ config: baseConfig });
    // runHookScript always sends session_id: "test-session" unless overridden here. An explicit "" keeps the
    // empty string; an explicit undefined makes JSON.stringify drop the key entirely (no session_id at all).
    const r1 = call(dir, { session_id: "" });
    expect(decision(r1)).not.toBe("deny");
    const r2 = call(dir, { session_id: "" });
    expect(decision(r2)).not.toBe("deny");
    const r3 = call(dir, { session_id: undefined });
    expect(decision(r3)).not.toBe("deny");
    const file = join(dir, ".doug/.state/research-cap", "no-session", "ag1.log");
    expect(existsSync(file)).toBe(true);
    const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
    expect(lines.length).toBe(3);
  });
});

// Card research-cap-bash-fetch: the same cap also sees a subagent's Bash command whose resolved verb (via
// bash-rules commandForms/splitCommands) is curl or wget, since a researcher can fetch through Bash just as
// easily as through WebFetch/WebSearch. These fail until the script grows a Bash branch and the wiring's
// matcher becomes WebFetch|WebSearch|Bash.
describe("research-cap Bash fetches (card research-cap-bash-fetch)", () => {
  const counterFile = (dir, session = "test-session", agent = "ag1") => join(dir, ".doug/.state/research-cap", session, `${agent}.log`);
  const bashCall = (dir, command, overrides = {}) =>
    runHookScript(
      "research-cap",
      { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, agent_id: "ag1", agent_type: "researcher", ...overrides },
      { dir },
    );
  const webCall = (dir, overrides = {}) =>
    runHookScript(
      "research-cap",
      { hook_event_name: "PreToolUse", tool_name: "WebFetch", tool_input: { url: "https://example.com" }, agent_id: "ag1", agent_type: "researcher", ...overrides },
      { dir },
    );
  const seedLines = (dir, n, session = "test-session", agent = "ag1") => {
    const file = counterFile(dir, session, agent);
    mkdirSync(dirname(file), { recursive: true });
    for (let i = 0; i < n; i++) appendFileSync(file, JSON.stringify({ t: new Date().toISOString(), tool: "WebFetch" }) + "\n");
  };

  it("B1 a subagent curl call under the cap is allowed and the counter file gains one line with tool Bash, verb curl", () => {
    const dir = makeProject({ config: baseConfig });
    const r = bashCall(dir, "curl https://example.com");
    expect(decision(r)).not.toBe("deny");
    const lines = readFileSync(counterFile(dir), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    expect(lines.length).toBe(1);
    expect(lines[0].tool).toBe("Bash");
    expect(lines[0].verb).toBe("curl");
  });

  it("B2 a subagent wget call under the cap is allowed and the counter file gains one line with verb wget", () => {
    const dir = makeProject({ config: baseConfig });
    const r = bashCall(dir, "wget https://example.com");
    expect(decision(r)).not.toBe("deny");
    const lines = readFileSync(counterFile(dir), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    expect(lines.length).toBe(1);
    expect(lines[0].verb).toBe("wget");
  });

  it("B3 at the cap, a curl Bash call is denied and the reason contains curl", () => {
    const dir = makeProject({ config: baseConfig });
    seedLines(dir, 6);
    const r = bashCall(dir, "curl https://example.com");
    expect(decision(r)).toBe("deny");
    expect(r.json.hookSpecificOutput.permissionDecisionReason).toContain("curl");
  });

  it("B4 at the cap, a non-fetch Bash command (ls -la) is allowed and the counter file is unchanged", () => {
    const dir = makeProject({ config: baseConfig });
    seedLines(dir, 6);
    const before = readFileSync(counterFile(dir), "utf8");
    const r = bashCall(dir, "ls -la");
    expect(decision(r)).not.toBe("deny");
    expect(readFileSync(counterFile(dir), "utf8")).toBe(before);
  });

  it("B5 under the cap, a non-fetch Bash command (git status) appends nothing", () => {
    const dir = makeProject({ config: baseConfig });
    const r = bashCall(dir, "git status");
    expect(decision(r)).not.toBe("deny");
    expect(existsSync(counterFile(dir))).toBe(false);
  });

  it.each([
    ["sudo curl https://x"],
    ["env FOO=1 curl https://x"],
    ["bash -c 'curl https://x'"],
    ["/usr/bin/curl https://x"],
    ["CURL https://x"],
  ])("B6 resolved verb %s counts one fetch", (command) => {
    const dir = makeProject({ config: baseConfig });
    const r = bashCall(dir, command);
    expect(decision(r), command).not.toBe("deny");
    const lines = readFileSync(counterFile(dir), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    expect(lines.length, command).toBe(1);
    expect(lines[0].verb, command).toBe("curl");
  });

  it.each([["echo curl"], ["grep curl notes.txt"], ["man wget"]])("B7 %s is not a fetch and counts zero", (command) => {
    const dir = makeProject({ config: baseConfig });
    const r = bashCall(dir, command);
    expect(decision(r), command).not.toBe("deny");
    expect(existsSync(counterFile(dir)), command).toBe(false);
  });

  it("B8 two fetches joined with && append two lines; a fetch piped into a non-fetch appends one", () => {
    const dir = makeProject({ config: baseConfig });
    const r1 = bashCall(dir, "curl https://a && wget https://b");
    expect(decision(r1)).not.toBe("deny");
    expect(readFileSync(counterFile(dir), "utf8").split("\n").filter(Boolean).length).toBe(2);

    const dir2 = makeProject({ config: baseConfig });
    const r2 = bashCall(dir2, "curl https://a | jq .");
    expect(decision(r2)).not.toBe("deny");
    expect(readFileSync(counterFile(dir2), "utf8").split("\n").filter(Boolean).length).toBe(1);
  });

  it("B9 3 seeded WebFetch lines plus 3 curl Bash calls reach a cap of 6: the next WebSearch is denied", () => {
    const dir = makeProject({ config: baseConfig });
    seedLines(dir, 3);
    for (let i = 0; i < 3; i++) {
      const r = bashCall(dir, "curl https://example.com");
      expect(decision(r), `curl ${i + 1}`).not.toBe("deny");
    }
    const lines = readFileSync(counterFile(dir), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    expect(lines.length).toBe(6);
    expect(lines.slice(3).every((l) => l.tool === "Bash" && l.verb === "curl")).toBe(true);
    const denied = webCall(dir, { tool_name: "WebSearch" });
    expect(decision(denied)).toBe("deny");
  });

  it("B10 the main session (no agent_id) making a curl Bash call is allowed and writes no counter file", () => {
    const dir = makeProject({ config: baseConfig });
    const r = bashCall(dir, "curl https://example.com", { agent_id: undefined });
    expect(decision(r)).not.toBe("deny");
    expect(existsSync(join(dir, ".doug/.state/research-cap"))).toBe(false);
  });

  it.each([[{}], [{ command: 123 }]])("B11 a Bash input with no usable tool_input.command is allowed, appends nothing, and emits no systemMessage", (tool_input) => {
    const dir = makeProject({ config: baseConfig });
    const r = runHookScript(
      "research-cap",
      { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input, agent_id: "ag1", agent_type: "researcher" },
      { dir },
    );
    expect(decision(r)).not.toBe("deny");
    expect(r.json?.systemMessage).toBeFalsy();
    expect(existsSync(join(dir, ".doug/.state/research-cap"))).toBe(false);
  });

  it("B11 a Bash input with no tool_input key at all is allowed, appends nothing, and emits no systemMessage (round 2, minor 6)", () => {
    const dir = makeProject({ config: baseConfig });
    const r = runHookScript(
      "research-cap",
      { hook_event_name: "PreToolUse", tool_name: "Bash", agent_id: "ag1", agent_type: "researcher" },
      { dir },
    );
    expect(decision(r)).not.toBe("deny");
    expect(r.json?.systemMessage).toBeFalsy();
    expect(existsSync(join(dir, ".doug/.state/research-cap"))).toBe(false);
  });

  // Round 2 (addendum, major 1): splitCommands is quote-blind and splits on newline, so a Bash researcher's own
  // fixture-writing heredoc, or ordinary quoted text that happens to mention curl/wget, was miscounted as a
  // fetch. Q1-Q8 pin the fix (splitTopLevel) against real PreToolUse Bash JSON; they are written against the
  // live script and are expected to move as the coder's change lands underneath them (round-1 script still
  // wired in as of this write).
  it.each([
    ["echo 'wrote notes; curl was used' >> notes.md"],
    ["rg 'foo|curl -s' docs/"],
    ['git commit -m "fix; curl https://x && wget y"'],
    ['grep -E "a|wget -q" f.txt'],
    ['echo "she said \\"hi\\"; curl x"'],
  ])("Q1 quoted text under the cap appends nothing: %s", (command) => {
    const dir = makeProject({ config: baseConfig });
    const r = bashCall(dir, command);
    expect(decision(r), command).not.toBe("deny");
    expect(existsSync(counterFile(dir)), command).toBe(false);
  });

  it.each([
    ["echo 'wrote notes; curl was used' >> notes.md"],
    ["rg 'foo|curl -s' docs/"],
    ['git commit -m "fix; curl https://x && wget y"'],
    ['grep -E "a|wget -q" f.txt'],
    ['echo "she said \\"hi\\"; curl x"'],
  ])("Q2 the same quoted text at the cap is allowed and the counter file is unchanged: %s", (command) => {
    const dir = makeProject({ config: baseConfig });
    seedLines(dir, 6);
    const before = readFileSync(counterFile(dir), "utf8");
    const r = bashCall(dir, command);
    expect(decision(r), command).not.toBe("deny");
    expect(readFileSync(counterFile(dir), "utf8"), command).toBe(before);
  });

  it.each([
    ["<<EOF", "cat > notes.md <<EOF\ncurl https://x\nwget https://y\nEOF"],
    ["<<'EOF'", "cat > notes.md <<'EOF'\ncurl https://x\nwget https://y\nEOF"],
    ["<<-EOF with a tab-indented terminator", "cat > notes.md <<-EOF\ncurl https://x\nwget https://y\n\tEOF"],
  ])("Q3 a heredoc body appends nothing, %s", (_label, command) => {
    const dir = makeProject({ config: baseConfig });
    const r = bashCall(dir, command);
    expect(decision(r), command).not.toBe("deny");
    expect(existsSync(counterFile(dir)), command).toBe(false);
  });

  it("Q4 a real fetch after a heredoc still counts one", () => {
    const dir = makeProject({ config: baseConfig });
    const command = "cat > notes.md <<EOF\ncurl https://x\nwget https://y\nEOF\ncurl https://real";
    const r = bashCall(dir, command);
    expect(decision(r)).not.toBe("deny");
    const lines = readFileSync(counterFile(dir), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    expect(lines.length).toBe(1);
    expect(lines[0].verb).toBe("curl");
  });

  it("Q5 a real fetch beside quoted text counts exactly one", () => {
    const dir = makeProject({ config: baseConfig });
    const r = bashCall(dir, "echo 'a; curl fake' && curl https://real");
    expect(decision(r)).not.toBe("deny");
    const lines = readFileSync(counterFile(dir), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    expect(lines.length).toBe(1);
    expect(lines[0].verb).toBe("curl");
  });

  it.each([
    ["bash -c 'curl https://x'", 1],
    ["curl https://a && wget https://b", 2],
    ["curl https://a | jq .", 1],
    ["curl 'https://x?a=1&b=2'", 1],
  ])("Q6 round-1 behaviour kept: %s counts %i", (command, expected) => {
    const dir = makeProject({ config: baseConfig });
    const r = bashCall(dir, command);
    expect(decision(r), command).not.toBe("deny");
    const lines = existsSync(counterFile(dir))
      ? readFileSync(counterFile(dir), "utf8").split("\n").filter(Boolean)
      : [];
    expect(lines.length, command).toBe(expected);
  });

  it.each([
    ["an unterminated single quote", "echo 'oops; curl x"],
    ["an unterminated heredoc with a curl line in its body", "cat > f <<EOF\ncurl https://x"],
  ])("Q7 never more splits on broken input (%s): appends nothing, no systemMessage", (_label, command) => {
    const dir = makeProject({ config: baseConfig });
    const r = bashCall(dir, command);
    expect(decision(r), command).not.toBe("deny");
    expect(r.json?.systemMessage, command).toBeFalsy();
    expect(existsSync(counterFile(dir)), command).toBe(false);
  });

  it("Q8 a here-string is not a heredoc: a real fetch after it still counts one", () => {
    const dir = makeProject({ config: baseConfig });
    const r = bashCall(dir, 'cat <<< "x" ; curl https://real');
    expect(decision(r)).not.toBe("deny");
    const lines = readFileSync(counterFile(dir), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    expect(lines.length).toBe(1);
    expect(lines[0].verb).toBe("curl");
  });

  // Round 2b pinning fixtures: the coder's mutation run left N4, N6, N7, and N10 without a fixture that fails
  // under them (Q1's escaped-quote case has an even count of escaped quotes, so an early-close mutation cancels
  // out; Q3/Q4 never combine a tab-indented <<- body with a following real fetch; Q8's here-string case is
  // single-line, so a broken <<< that only starts a body on the next newline never gets one; Q6's URL case
  // stays right by luck under an in-quote & split). P1-P4 pin those four mechanisms directly.
  it("P1 an escaped double quote (odd count) does not close the string: appends nothing", () => {
    const dir = makeProject({ config: baseConfig });
    const r = bashCall(dir, 'echo "say \\"hi; curl x"');
    expect(decision(r)).not.toBe("deny");
    expect(existsSync(counterFile(dir))).toBe(false);
  });

  it("P2 a tab-indented <<- heredoc body and terminator are dropped, and the real fetch after it counts one", () => {
    const dir = makeProject({ config: baseConfig });
    const command = "cat > n.md <<-EOF\n\tcurl https://fake\n\tEOF\ncurl https://real";
    const r = bashCall(dir, command);
    expect(decision(r)).not.toBe("deny");
    const lines = readFileSync(counterFile(dir), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    expect(lines.length).toBe(1);
    expect(lines[0].verb).toBe("curl");
  });

  it("P3 a here-string on its own line still is not a heredoc: the fetch on the next line counts one", () => {
    const dir = makeProject({ config: baseConfig });
    const command = 'cat <<< "x"\ncurl https://real';
    const r = bashCall(dir, command);
    expect(decision(r)).not.toBe("deny");
    const lines = readFileSync(counterFile(dir), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    expect(lines.length).toBe(1);
    expect(lines[0].verb).toBe("curl");
  });

  it("P4 an ampersand inside single quotes does not split: appends nothing", () => {
    const dir = makeProject({ config: baseConfig });
    const r = bashCall(dir, "echo 'x & curl y'");
    expect(decision(r)).not.toBe("deny");
    expect(existsSync(counterFile(dir))).toBe(false);
  });

  it("W1 hooks.json's research-cap PreToolUse group has matcher exactly WebFetch|WebSearch|Bash, and no group keeps the old matcher", () => {
    const hooksJson = JSON.parse(readFileSync(join(scriptsDir, "..", "hooks", "hooks.json"), "utf8"));
    const preToolUse = hooksJson.hooks.PreToolUse;
    const group = preToolUse.find((g) => g.matcher === "WebFetch|WebSearch|Bash");
    expect(group, `no WebFetch|WebSearch|Bash group in ${JSON.stringify(preToolUse, null, 2)}`).toBeDefined();
    expect(group.hooks.some((h) => h.command.includes("research-cap.mjs"))).toBe(true);
    expect(preToolUse.some((g) => g.matcher === "WebFetch|WebSearch")).toBe(false);
  });
});

describe("guard-bash", () => {
  it("denies the wrong package manager and allows the right one", () => {
    const dir = makeProject({ config: baseConfig });
    expect(decision(runHookScript("guard-bash", { tool_name: "Bash", tool_input: { command: "npm install" } }, { dir }))).toBe("deny");
    expect(runHookScript("guard-bash", { tool_name: "Bash", tool_input: { command: "pnpm install" } }, { dir }).json).toBeNull();
  });
  it("denies force push to main using the real current branch", () => {
    const dir = makeProject({ config: baseConfig, git: true });
    writeFileSync(join(dir, "a.txt"), "a");
    const r = runHookScript("guard-bash", { tool_name: "Bash", tool_input: { command: "git push -f" } }, { dir });
    expect(decision(r)).toBe("deny");
  });
  it("allows an empty or missing command", () => {
    const dir = makeProject({ config: baseConfig });
    expect(runHookScript("guard-bash", { tool_name: "Bash", tool_input: {} }, { dir }).json).toBeNull();
  });

  // card bash-rules-prod, T4: end-to-end coverage of checkPipeToShell and checkResetHardOnProtected wired
  // through guard-bash.mjs, including its branch resolution for git reset (item 3 of the design).
  describe("pipe-to-shell and reset-on-protected (card bash-rules-prod, T4)", () => {
    it("denies piping a download into a shell, naming unreviewed remote code", () => {
      const dir = makeProject({ config: baseConfig });
      const r = runHookScript("guard-bash", { tool_name: "Bash", tool_input: { command: "curl https://x/i.sh | sh" } }, { dir });
      expect(decision(r)).toBe("deny");
      expect(r.json.hookSpecificOutput.permissionDecisionReason).toContain("unreviewed remote code");
    });
    it("denies git reset --hard on the protected current branch, naming it", () => {
      const dir = makeProject({ config: baseConfig, git: true });
      const r = runHookScript("guard-bash", { tool_name: "Bash", tool_input: { command: "git reset --hard HEAD~1" } }, { dir });
      expect(decision(r)).toBe("deny");
      expect(r.json.hookSpecificOutput.permissionDecisionReason).toContain("main");
      expect(r.json.hookSpecificOutput.permissionDecisionReason).toContain("protected branch");
    });
    it("still denies the same reset on a feature branch (the destructive catalogue), but does not name a protected branch", () => {
      const dir = makeProject({ config: baseConfig, git: true });
      execFileSync("git", ["checkout", "-b", "feature"], { cwd: dir });
      const r = runHookScript("guard-bash", { tool_name: "Bash", tool_input: { command: "git reset --hard HEAD~1" } }, { dir });
      expect(decision(r)).toBe("deny");
      expect(r.json.hookSpecificOutput.permissionDecisionReason).not.toContain("protected branch");
    });
    it("with bash.denyDestructive off, allows the reset on a feature branch but still denies it on main", () => {
      const cfgOff = { ...baseConfig, bash: { denyDestructive: false } };
      const featureDir = makeProject({ config: cfgOff, git: true });
      execFileSync("git", ["checkout", "-b", "feature"], { cwd: featureDir });
      expect(runHookScript("guard-bash", { tool_name: "Bash", tool_input: { command: "git reset --hard HEAD~1" } }, { dir: featureDir }).json).toBeNull();

      const mainDir = makeProject({ config: cfgOff, git: true });
      const r = runHookScript("guard-bash", { tool_name: "Bash", tool_input: { command: "git reset --hard HEAD~1" } }, { dir: mainDir });
      expect(decision(r)).toBe("deny");
    });
  });
});

describe("format-on-edit", () => {
  it("runs the formatter and stays silent on success", () => {
    const dir = makeProject({ config: { ...baseConfig, formatter: { command: [process.execPath, "-e", "require('fs').writeFileSync(process.argv[1], 'formatted\\n')"], extensions: [".ts"] } } });
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src/a.ts"), "raw");
    const r = runHookScript("format-on-edit", { tool_name: "Edit", tool_input: { file_path: "src/a.ts" } }, { dir });
    expect(r.status).toBe(0);
    expect(r.json).toBeNull();
    expect(readFileSync(join(dir, "src/a.ts"), "utf8")).toBe("formatted\n");
  });
  it("reports formatter failure as context", () => {
    const dir = makeProject({ config: { ...baseConfig, formatter: { command: [process.execPath, "-e", "console.error('SyntaxError: boom'); process.exit(2)"], extensions: [".ts"] } } });
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src/a.ts"), "raw");
    const r = runHookScript("format-on-edit", { tool_name: "Edit", tool_input: { file_path: "src/a.ts" } }, { dir });
    expect(context(r)).toContain("SyntaxError: boom");
  });
  it("skips files with other extensions and does nothing without a formatter", () => {
    const dir = makeProject({ config: { ...baseConfig, formatter: { command: ["false"], extensions: [".ts"] } } });
    writeFileSync(join(dir, "a.md"), "x");
    expect(runHookScript("format-on-edit", { tool_name: "Write", tool_input: { file_path: "a.md" } }, { dir }).json).toBeNull();
    const dir2 = makeProject({ config: baseConfig });
    expect(runHookScript("format-on-edit", { tool_name: "Write", tool_input: { file_path: "a.ts" } }, { dir: dir2 }).json).toBeNull();
  });
});

describe("edit-loop", () => {
  it("records edits and nudges at the threshold", () => {
    const dir = makeProject({ config: baseConfig });
    const input = { tool_name: "Edit", tool_input: { file_path: "src/a.ts" } };
    expect(runHookScript("edit-loop", input, { dir }).json).toBeNull();
    expect(runHookScript("edit-loop", input, { dir }).json).toBeNull();
    const third = runHookScript("edit-loop", input, { dir });
    expect(context(third)).toContain("edited 3 times");
    const state = JSON.parse(readFileSync(join(dir, ".doug/.state/test-session.json"), "utf8"));
    expect(state.editedFiles).toEqual(["src/a.ts"]);
    expect(state.edits["src/a.ts"]).toHaveLength(3);
  });
});

describe("stop-gate", () => {
  it("allows when nothing was edited", () => {
    const dir = makeProject({ config: baseConfig, git: true });
    const r = runHookScript("stop-gate", { hook_event_name: "Stop", stop_hook_active: false }, { dir });
    expect(r.json).toBeNull();
  });
  describe("baseline of already-dirty paths (card stop-gate-waiting-on-subagents)", () => {
    const withEvidence = { ...baseConfig, stopGate: { ...baseConfig.stopGate, requireEvidence: true } };
    it("does not count a file already dirty when the session started as this session's work, until it changes further", () => {
      const dir = makeProject({ config: withEvidence, git: true });
      writeFileSync(join(dir, ".gitignore"), ".doug/.state/\n"); // as `doug init` recommends; the hook's own state file must not read as a change either way
      mkdirSync(join(dir, "src"));
      writeFileSync(join(dir, "src/a.ts"), "base");
      execFileSync("git", ["add", "-A"], { cwd: dir });
      execFileSync("git", ["commit", "-q", "-m", "base"], { cwd: dir });
      writeFileSync(join(dir, "src/a.ts"), "dirty before the session began"); // e.g. .doug/anchor.md in the real bug

      const first = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
      expect(first.json).toBeNull(); // no missing-evidence problem: this session touched nothing
      const state1 = JSON.parse(readFileSync(join(dir, ".doug/.state/test-session.json"), "utf8"));
      expect(state1.baseline).toHaveProperty("src/a.ts");

      // Gated once that same pre-existing file is modified further this session.
      writeFileSync(join(dir, "src/a.ts"), "changed further, by this session");
      const second = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
      expect(second.json.decision).toBe("block");
      expect(second.json.reason).toContain("No test or verify command ran in this session");
    });
    it("still blocks a session that edits a file and never runs verification", () => {
      const dir = makeProject({ config: withEvidence, git: true });
      writeFileSync(join(dir, ".gitignore"), ".doug/.state/\n");
      writeFileSync(join(dir, "a.txt"), "edited this session");
      runHookScript("edit-loop", { tool_name: "Edit", tool_input: { file_path: "a.txt" } }, { dir });
      const r = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
      expect(r.json.decision).toBe("block");
      expect(r.json.reason).toContain("No test or verify command ran in this session");
    });
    it("treats an untracked file present at baseline the same as a modified one", () => {
      const dir = makeProject({ config: withEvidence, git: true });
      writeFileSync(join(dir, ".gitignore"), ".doug/.state/\n");
      writeFileSync(join(dir, "scratch.txt"), "untracked before the session began");

      const first = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
      expect(first.json).toBeNull();
      const state1 = JSON.parse(readFileSync(join(dir, ".doug/.state/test-session.json"), "utf8"));
      expect(state1.baseline).toHaveProperty("scratch.txt");

      writeFileSync(join(dir, "scratch.txt"), "modified by this session");
      const second = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
      expect(second.json.decision).toBe("block");
      expect(second.json.reason).toContain("No test or verify command ran in this session");
    });
  });
  describe("session-start-baseline (card stop-gate-session-start)", () => {
    it("captures the baseline on SessionStart, tagged session-start", () => {
      const dir = makeProject({ config: baseConfig, git: true });
      writeFileSync(join(dir, ".gitignore"), ".doug/.state/\n");
      mkdirSync(join(dir, "src"), { recursive: true });
      writeFileSync(join(dir, "src/a.ts"), "dirty before the session began");
      const r = runHookScript("session-start-baseline", { hook_event_name: "SessionStart", source: "startup" }, { dir });
      expect(r.status).toBe(0);
      expect(r.json).toBeNull(); // silent success, no stdout
      const state = JSON.parse(readFileSync(join(dir, ".doug/.state/test-session.json"), "utf8"));
      expect(state.baseline).toHaveProperty("src/a.ts");
      expect(state.baselineSource).toBe("session-start");
    });
    it("does not overwrite a baseline a second SessionStart fires against (a late fire, or one per subagent)", () => {
      const dir = makeProject({ config: baseConfig, git: true });
      mkdirSync(join(dir, "src"), { recursive: true });
      writeFileSync(join(dir, "src/a.ts"), "dirty before the session began");
      runHookScript("session-start-baseline", { hook_event_name: "SessionStart", source: "startup" }, { dir });
      const captured = JSON.parse(readFileSync(join(dir, ".doug/.state/test-session.json"), "utf8")).baseline["src/a.ts"];
      // The tree changes (as it would mid-session) before a second SessionStart fires.
      writeFileSync(join(dir, "src/a.ts"), "changed since the first capture");
      const r = runHookScript("session-start-baseline", { hook_event_name: "SessionStart", source: "fork" }, { dir });
      expect(r.status).toBe(0);
      const state = JSON.parse(readFileSync(join(dir, ".doug/.state/test-session.json"), "utf8"));
      expect(state.baseline["src/a.ts"]).toBe(captured); // untouched by the second fire
      expect(state.baselineSource).toBe("session-start");
    });
    it("with a session-start baseline, an already-dirty tree the session never touches runs no verify commands", () => {
      const cfg = { ...baseConfig, commands: { test: `${process.execPath} -e "require('fs').writeFileSync('ran.marker','1')"` } };
      const dir = makeProject({ config: cfg, git: true });
      mkdirSync(join(dir, "src"), { recursive: true });
      writeFileSync(join(dir, "src/a.ts"), "dirty before the session began");
      runHookScript("session-start-baseline", { hook_event_name: "SessionStart", source: "startup" }, { dir });
      const r = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
      expect(r.json).toBeNull(); // allowed
      expect(existsSync(join(dir, "ran.marker"))).toBe(false); // and no verify command ever ran
      const state = JSON.parse(readFileSync(join(dir, ".doug/.state/test-session.json"), "utf8"));
      expect(state.baselineSource).toBe("session-start");
    });
    it("with a session-start baseline, a session that changes a file through Bash is still gated, protected paths and plan scope included", () => {
      const dir = makeProject({ config: baseConfig, git: true });
      writeFileSync(join(dir, "plan-owned.txt"), "dirty before the session began");
      writeFileSync(join(dir, ".doug/plan.json"), JSON.stringify({ version: 1, title: "T", status: "approved", card: "t", tasks: [{ id: "t", files: ["plan-owned.txt"] }] }));
      runHookScript("session-start-baseline", { hook_event_name: "SessionStart", source: "startup" }, { dir });
      // The session changes a file through Bash: a protected path, and one outside the plan's scope.
      writeFileSync(join(dir, ".env"), "SECRET=1");
      const r = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
      expect(r.json.decision).toBe("block");
      expect(r.json.reason).toContain("Protected files were modified: .env"); // step 1, protected paths
      const state = JSON.parse(readFileSync(join(dir, ".doug/.state/test-session.json"), "utf8"));
      expect(state.lastGate.scope.outOfScope).toContain(".env"); // step 2, plan scope, also fired
      expect(state.baselineSource).toBe("session-start");
    });
    it("fallback (no SessionStart): the stop gate's own first-run capture behaves exactly as today, tagged stop", () => {
      const cfg = { ...baseConfig, commands: { test: `${process.execPath} -e "require('fs').writeFileSync('ran.marker','1')"` } };
      const dir = makeProject({ config: cfg, git: true });
      mkdirSync(join(dir, "src"), { recursive: true });
      writeFileSync(join(dir, "src/a.ts"), "dirty before the session began");
      // No session-start-baseline fire: the stop gate captures its own fallback baseline on this first run.
      const r = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
      expect(r.json).toBeNull(); // still allowed: no evidence problem for a session that touched nothing
      expect(existsSync(join(dir, "ran.marker"))).toBe(true); // but, as today, the full changed set still ran verification
      const state = JSON.parse(readFileSync(join(dir, ".doug/.state/test-session.json"), "utf8"));
      expect(state.baselineSource).toBe("stop");
    });
    it("a late first capture — after the session already acted — is labelled \"stop\", not \"session-start\", and the gate still blocks", () => {
      const dir = makeProject({ config: baseConfig, git: true });
      mkdirSync(join(dir, "src"), { recursive: true });
      writeFileSync(join(dir, "src/a.ts"), "dirty before the session began");
      // Turn 1: the session already ran a Bash command and wrote a protected file before SessionStart's
      // late fire (ordering between SessionStart and the first PreToolUse is unverified — research note).
      runHookScript("guard-bash", { tool_name: "Bash", tool_input: { command: "pnpm test" } }, { dir });
      writeFileSync(join(dir, ".env"), "SECRET=1");
      const late = runHookScript("session-start-baseline", { hook_event_name: "SessionStart", source: "startup" }, { dir });
      expect(late.status).toBe(0);
      const afterLate = JSON.parse(readFileSync(join(dir, ".doug/.state/test-session.json"), "utf8"));
      expect(afterLate.baselineSource).toBe("stop"); // not "session-start": the session had already acted
      const r = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
      expect(r.json.decision).toBe("block"); // 468acbb's behavior: not silently allowed
      expect(r.json.reason).toContain("Protected files were modified: .env");
    });
    it("labels the capture \"stop\", not \"session-start\", for clear and fork, which hand a new session_id a state file", () => {
      const dir = makeProject({ config: baseConfig, git: true });
      mkdirSync(join(dir, "src"), { recursive: true });
      writeFileSync(join(dir, "src/a.ts"), "dirty before the session began");
      const r = runHookScript("session-start-baseline", { hook_event_name: "SessionStart", source: "clear" }, { dir });
      expect(r.status).toBe(0);
      const state = JSON.parse(readFileSync(join(dir, ".doug/.state/test-session.json"), "utf8"));
      expect(state.baselineSource).toBe("stop");
    });
  });
  describe("commits made since the baseline (card stop-scan-committed-changes)", () => {
    // Small local helper: commits everything currently in the working tree, returning the new HEAD sha. Every
    // test below is a variant of "the session committed a change instead of leaving it dirty".
    const commitAll = (dir, message) => {
      execFileSync("git", ["add", "-A"], { cwd: dir });
      execFileSync("git", ["commit", "-q", "-m", message], { cwd: dir });
      return execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
    };

    it("a committed .env blocks with the (committed this session) suffix", () => {
      const dir = makeProject({ config: baseConfig, git: true });
      commitAll(dir, "base"); // HEAD A
      runHookScript("session-start-baseline", { hook_event_name: "SessionStart", source: "startup" }, { dir });
      writeFileSync(join(dir, ".env"), "SECRET=1");
      commitAll(dir, "committed .env"); // HEAD B, tree clean
      const r = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
      expect(r.json.decision).toBe("block");
      expect(r.json.reason).toContain("Protected files were modified: .env (committed this session)");
    });
    // Minor 6 (reviewer): a path that is both a dirty hit and a committed hit must be named once, not twice.
    it("a path that is both a dirty and a committed protected hit produces one problem line, not two (Minor 6)", () => {
      const dir = makeProject({ config: baseConfig, git: true });
      commitAll(dir, "base");
      runHookScript("session-start-baseline", { hook_event_name: "SessionStart", source: "startup" }, { dir });
      writeFileSync(join(dir, ".env"), "SECRET=1");
      commitAll(dir, "committed .env");
      writeFileSync(join(dir, ".env"), "SECRET=2"); // modified again, uncommitted: now both a dirty and a committed hit
      const r = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
      expect(r.json.decision).toBe("block");
      const occurrences = (r.json.reason.match(/Protected files were modified/g) || []).length;
      expect(occurrences).toBe(1); // named once, via the dirty-tree phrasing, not once more via the committed one
      expect(r.json.reason).not.toContain("(committed this session)");
    });
    it("a committed hand-written ADR blocks, naming the proposal-path message", () => {
      const dir = makeProject({ config: baseConfig, git: true });
      commitAll(dir, "base");
      runHookScript("session-start-baseline", { hook_event_name: "SessionStart", source: "startup" }, { dir });
      mkdirSync(join(dir, "docs/decisions"), { recursive: true });
      writeFileSync(join(dir, "docs/decisions/0007-hand.md"), "# 0007. hand written\n");
      commitAll(dir, "committed hand-written ADR");
      const r = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
      expect(r.json.decision).toBe("block");
      expect(r.json.reason).toContain("Decisions/rules were written outside the proposal path");
      expect(r.json.reason).toContain("docs/decisions/0007-hand.md");
    });
    // With the default proposalPaths ("docs/decisions/**", ".claude/rules/**"), the filesystem walk (card
    // stop-scan-committed-changes, item 4) already discovers any file under those directories regardless of
    // its git or commit status, so the committed-hits union in step 1b is redundant for that config in every
    // other test here. A proposalPaths pattern with no fixed directory prefix (fixedPrefix in lib/baseline.mjs
    // returns "" for it, so nothing is walked for it) isolates the committed-hits union on its own.
    it("a committed change under a proposalPaths pattern with no directory prefix blocks (isolates the committed-hits union from the walk)", () => {
      const cfg = { ...baseConfig, proposalPaths: ["RULES.md"] };
      const dir = makeProject({ config: cfg, git: true });
      commitAll(dir, "base");
      runHookScript("session-start-baseline", { hook_event_name: "SessionStart", source: "startup" }, { dir });
      writeFileSync(join(dir, "RULES.md"), "# hand written\n");
      commitAll(dir, "committed RULES.md");
      const r = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
      expect(r.json.decision).toBe("block");
      expect(r.json.reason).toContain("Decisions/rules were written outside the proposal path");
      expect(r.json.reason).toContain("RULES.md");
    });
    it("a committed genuine applyProposal ADR passes", () => {
      const dir = makeProject({ config: baseConfig, git: true });
      commitAll(dir, "base"); // HEAD A, before the target ever existed
      runHookScript("session-start-baseline", { hook_event_name: "SessionStart", source: "startup" }, { dir });

      const relPath = "docs/decisions/0007-applied.md";
      const content = "# 0007. applied\n";
      const diffDir = join(dir, ".doug/.state/learn/manual");
      mkdirSync(diffDir, { recursive: true });
      const diffPath = join(diffDir, "01-decision.diff");
      writeFileSync(diffPath, unifiedDiff(relPath, "", content));
      expect(applyProposal(diffPath, { dir })).toEqual({ ok: true, target: relPath });
      commitAll(dir, "apply"); // HEAD B; HEAD:relPath now equals the current bytes

      const r = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
      expect(r.json).toBeNull();
    });
    it("a committed genuine ADR that is then hand-edited further blocks", () => {
      const dir = makeProject({ config: baseConfig, git: true });
      commitAll(dir, "base");
      runHookScript("session-start-baseline", { hook_event_name: "SessionStart", source: "startup" }, { dir });

      const relPath = "docs/decisions/0007-applied.md";
      const content = "# 0007. applied\n";
      const diffDir = join(dir, ".doug/.state/learn/manual");
      mkdirSync(diffDir, { recursive: true });
      const diffPath = join(diffDir, "01-decision.diff");
      writeFileSync(diffPath, unifiedDiff(relPath, "", content));
      expect(applyProposal(diffPath, { dir })).toEqual({ ok: true, target: relPath });
      commitAll(dir, "apply");

      writeFileSync(join(dir, relPath), content + "\nHand edited after the commit.\n");
      const r = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
      expect(r.json.decision).toBe("block");
      expect(r.json.reason).toContain(relPath);
    });
    // M1 (reviewer): the reader tried only the pre-session baseline HEAD, so a second approved apply on the
    // same ADR, committed in-session after the first, has the first version as its preimage - it cannot
    // re-derive onto the pre-session base at all, only onto HEAD (which now holds the first version). Fix:
    // try base first, then HEAD.
    it("a second approved applyProposal on the same ADR, committed in-session after the first, passes (M1)", () => {
      const dir = makeProject({ config: baseConfig, git: true });
      commitAll(dir, "base"); // HEAD A, before the target ever existed
      runHookScript("session-start-baseline", { hook_event_name: "SessionStart", source: "startup" }, { dir });

      const relPath = "docs/decisions/0007-applied.md";
      const v1 = "# 0007. applied\n";
      const diffDir = join(dir, ".doug/.state/learn/manual");
      mkdirSync(diffDir, { recursive: true });
      const diffPath1 = join(diffDir, "01-decision.diff");
      writeFileSync(diffPath1, unifiedDiff(relPath, "", v1));
      expect(applyProposal(diffPath1, { dir })).toEqual({ ok: true, target: relPath });
      commitAll(dir, "apply v1"); // HEAD B; HEAD:relPath now holds v1, not "absent" as at HEAD A

      const v2 = `${v1}\n## Amendment\n\nMore text.\n`;
      const diffPath2 = join(diffDir, "02-amend.diff");
      writeFileSync(diffPath2, unifiedDiff(relPath, v1, v2)); // preimage is v1 (the committed version), not ""
      expect(applyProposal(diffPath2, { dir })).toEqual({ ok: true, target: relPath });

      const r = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
      expect(r.json).toBeNull();
    });
    it("a gitignored .claude/rules file written by hand blocks; one already there, untouched, does not", () => {
      const dir = makeProject({ config: baseConfig, git: true });
      writeFileSync(join(dir, ".gitignore"), ".claude/\n");
      mkdirSync(join(dir, ".claude/rules"), { recursive: true });
      writeFileSync(join(dir, ".claude/rules/pre-existing.md"), "# pre-existing rule\n"); // ignored, so never committed
      commitAll(dir, "base"); // .gitignore itself, not the ignored rule file
      runHookScript("session-start-baseline", { hook_event_name: "SessionStart", source: "startup" }, { dir });

      const first = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
      expect(first.json).toBeNull(); // untouched since the baseline: not this session's work

      writeFileSync(join(dir, ".claude/rules/hand-written.md"), "# hand written rule\n"); // plain fs write, as Bash would do
      const second = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
      expect(second.json.decision).toBe("block");
      expect(second.json.reason).toContain("Decisions/rules were written outside the proposal path");
      expect(second.json.reason).toContain(".claude/rules/hand-written.md");
      expect(second.json.reason).not.toContain("pre-existing.md");
    });
    // Regression, found live: a baseline captured before this walk existed (an old state file, or - as
    // actually happened - a session whose baseline was captured under a pre-card stop-gate.mjs before this
    // card's vendored copies were redeployed mid-session) has no entries at all for most proposalPaths files.
    // Without repair, every pre-existing, untouched one (e.g. a long-standing, already-committed ADR, or here
    // a gitignored rule) reads as absent from the baseline the moment the walk-based check runs, and gets
    // wrongly flagged as new. Minor 4: the one-time repair backfills such a baseline on its first Stop
    // (skipping the walk-based check for that one Stop only, since it just backfilled from "now") and the
    // walk is live again from the Stop after that.
    it("a baseline captured without the proposalPaths walk repairs itself on the first Stop (no false block), and the walk is live from the next Stop (Minor 4)", () => {
      const dir = makeProject({ config: baseConfig, git: true });
      writeFileSync(join(dir, ".gitignore"), ".claude/\n");
      mkdirSync(join(dir, ".claude/rules"), { recursive: true });
      writeFileSync(join(dir, ".claude/rules/pre-existing.md"), "# pre-existing rule\n"); // ignored, so never committed
      commitAll(dir, "base"); // .gitignore itself, not the ignored rule file
      // Simulate a state file written by pre-card code: baseline present, but with no entry for the rule file
      // and no baselineWalked key at all (an old state file loads that key as false via the emptyState spread).
      mkdirSync(join(dir, ".doug/.state"), { recursive: true });
      writeFileSync(join(dir, ".doug/.state/test-session.json"), JSON.stringify({ baseline: {}, baselineSource: "stop", baselineHead: null }));

      const first = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
      expect(first.json).toBeNull(); // repaired silently; no false block on the pre-existing, gitignored rule
      const state1 = JSON.parse(readFileSync(join(dir, ".doug/.state/test-session.json"), "utf8"));
      expect(state1.baselineWalked).toBe(true); // repaired: live from here on
      expect(state1.baseline).toHaveProperty(".claude/rules/pre-existing.md"); // folded in by the repair
      const headAtRepair = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
      expect(state1.baselineHead).toBe(headAtRepair); // the committed scan comes alive from the same repair

      writeFileSync(join(dir, ".claude/rules/hand-written.md"), "# hand written after the repair\n"); // plain fs write, gitignored
      writeFileSync(join(dir, ".env"), "SECRET=1");
      commitAll(dir, "committed after the repair"); // a protected-path change committed after the first Stop
      const second = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
      expect(second.json.decision).toBe("block");
      expect(second.json.reason).toContain(".claude/rules/hand-written.md"); // the walk, live from this Stop
      expect(second.json.reason).toContain("Protected files were modified: .env (committed this session)"); // the committed scan, live too
      expect(second.json.reason).not.toContain("pre-existing.md");
    });
    it("a session started at HEAD with no later commits is unaffected", () => {
      const dir = makeProject({ config: baseConfig, git: true });
      commitAll(dir, "base");
      runHookScript("session-start-baseline", { hook_event_name: "SessionStart", source: "startup" }, { dir });
      const r = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
      expect(r.json).toBeNull();
    });
    it("fallback capture: a commit made before the first Stop is not scanned; one made after it, before a second Stop, is", () => {
      const dir = makeProject({ config: baseConfig, git: true });
      commitAll(dir, "base"); // HEAD A
      // No SessionStart fire. A protected-path change is committed before the stop gate ever runs once.
      writeFileSync(join(dir, ".env"), "SECRET=1");
      commitAll(dir, "before first stop"); // HEAD B
      const first = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
      expect(first.json).toBeNull(); // the fallback captures baselineHead=B on this very run; nothing since B yet

      writeFileSync(join(dir, ".env.local"), "SECRET=2");
      commitAll(dir, "after first stop"); // HEAD C
      const second = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
      expect(second.json.decision).toBe("block");
      // Only .env.local (committed between B and C) is named - not the pre-existing-baseline .env from A..B.
      expect(second.json.reason).toContain("Protected files were modified: .env.local (committed this session)");
    });
    it("an unknown baselineHead sha does not crash, and degrades to today's behavior (committed changes unseen)", () => {
      const dir = makeProject({ config: baseConfig, git: true });
      commitAll(dir, "base");
      runHookScript("session-start-baseline", { hook_event_name: "SessionStart", source: "startup" }, { dir });
      const stateFile = join(dir, ".doug/.state/test-session.json");
      const state = JSON.parse(readFileSync(stateFile, "utf8"));
      state.baselineHead = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"; // a sha git has never seen
      writeFileSync(stateFile, JSON.stringify(state));

      writeFileSync(join(dir, ".env"), "SECRET=1");
      commitAll(dir, "committed with an unknown base");
      const r = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
      expect(r.status).toBe(0); // no crash
      expect(r.json).toBeNull(); // a clean tree with an unscannable base sees nothing new, exactly as before this card
    });
    // M3 (reviewer): one test per new hit set proving stopGate.ignoreChangedPaths is actually respected there.
    describe("stopGate.ignoreChangedPaths exempts each new hit set (M3)", () => {
      it("a committed protected path", () => {
        const cfg = { ...baseConfig, stopGate: { ...baseConfig.stopGate, ignoreChangedPaths: [".env"] } };
        const dir = makeProject({ config: cfg, git: true });
        commitAll(dir, "base");
        runHookScript("session-start-baseline", { hook_event_name: "SessionStart", source: "startup" }, { dir });
        writeFileSync(join(dir, ".env"), "SECRET=1");
        commitAll(dir, "committed ignored .env");
        const r = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
        expect(r.json).toBeNull();
      });
      it("a committed proposal path", () => {
        const cfg = { ...baseConfig, stopGate: { ...baseConfig.stopGate, ignoreChangedPaths: ["docs/decisions/0007-hand.md"] } };
        const dir = makeProject({ config: cfg, git: true });
        commitAll(dir, "base");
        runHookScript("session-start-baseline", { hook_event_name: "SessionStart", source: "startup" }, { dir });
        mkdirSync(join(dir, "docs/decisions"), { recursive: true });
        writeFileSync(join(dir, "docs/decisions/0007-hand.md"), "# 0007. hand written\n");
        commitAll(dir, "committed ignored ADR");
        const r = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
        expect(r.json).toBeNull();
      });
      it("a walked (gitignored) proposal path", () => {
        const cfg = { ...baseConfig, stopGate: { ...baseConfig.stopGate, ignoreChangedPaths: [".claude/rules/hand-written.md"] } };
        const dir = makeProject({ config: cfg, git: true });
        writeFileSync(join(dir, ".gitignore"), ".claude/\n");
        commitAll(dir, "base");
        runHookScript("session-start-baseline", { hook_event_name: "SessionStart", source: "startup" }, { dir });
        mkdirSync(join(dir, ".claude/rules"), { recursive: true });
        writeFileSync(join(dir, ".claude/rules/hand-written.md"), "# hand written rule\n");
        // Force anyChange true by an unrelated edit, so this exercises the ignore filter itself rather than
        // short-circuiting on onlyIfEdited before step 1b ever runs.
        writeFileSync(join(dir, "a.txt"), "edited");
        runHookScript("edit-loop", { tool_name: "Edit", tool_input: { file_path: "a.txt" } }, { dir });
        const r = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
        expect(r.json).toBeNull();
      });
    });
    // Minor 1 (reviewer): state.baselineHead is agent-writable (the whole state file lives under
    // .doug/.state/), so committedSince must reject anything that does not look like a plausible git sha
    // before ever handing it to git - a string like "--output=..." passed where git expects a revision could
    // otherwise be read as an option, letting a forged state file steer the git invocation itself.
    it("a baselineHead that looks like a git option is rejected before ever reaching git; no file is created (Minor 1)", () => {
      const dir = makeProject({ config: baseConfig, git: true });
      commitAll(dir, "base");
      runHookScript("session-start-baseline", { hook_event_name: "SessionStart", source: "startup" }, { dir });
      const stateFile = join(dir, ".doug/.state/test-session.json");
      const state = JSON.parse(readFileSync(stateFile, "utf8"));
      const injectedPath = join(dir, "injected.txt");
      state.baselineHead = `--output=${injectedPath}`;
      writeFileSync(stateFile, JSON.stringify(state));

      writeFileSync(join(dir, ".env"), "SECRET=1");
      commitAll(dir, "committed with a malicious baselineHead");
      const r = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
      expect(r.status).toBe(0); // no crash
      expect(r.json).toBeNull(); // rejected outright: the committed .env is not scanned (degrades like an unknown sha)
      expect(existsSync(injectedPath)).toBe(false); // git was never invoked with the malicious string at all
    });
    it("session-start-baseline records baselineHead, idempotent across a later commit", () => {
      const dir = makeProject({ config: baseConfig, git: true });
      const headA = commitAll(dir, "base");
      runHookScript("session-start-baseline", { hook_event_name: "SessionStart", source: "startup" }, { dir });
      const state1 = JSON.parse(readFileSync(join(dir, ".doug/.state/test-session.json"), "utf8"));
      expect(state1.baselineHead).toBe(headA);

      writeFileSync(join(dir, "a.txt"), "a");
      commitAll(dir, "second"); // HEAD moves on mid-session
      runHookScript("session-start-baseline", { hook_event_name: "SessionStart", source: "fork" }, { dir });
      const state2 = JSON.parse(readFileSync(join(dir, ".doug/.state/test-session.json"), "utf8"));
      expect(state2.baselineHead).toBe(headA); // untouched by the second fire
    });
  });
  it("allows immediately when stop_hook_active is set", () => {
    const dir = makeProject({ config: { ...baseConfig, commands: { test: "false" } }, git: true });
    runHookScript("edit-loop", { tool_name: "Edit", tool_input: { file_path: "a.ts" } }, { dir });
    const r = runHookScript("stop-gate", { hook_event_name: "Stop", stop_hook_active: true }, { dir });
    expect(r.json).toBeNull();
  });
  it("blocks while verification fails, then stands down at the cap", () => {
    const dir = makeProject({ config: { ...baseConfig, commands: { test: "echo FAIL-OUTPUT; exit 1" }, stopGate: { ...baseConfig.stopGate, maxBlocks: 2 } }, git: true });
    runHookScript("edit-loop", { tool_name: "Edit", tool_input: { file_path: "a.ts" } }, { dir });
    const r1 = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
    expect(r1.json.decision).toBe("block");
    expect(r1.json.reason).toContain("FAIL-OUTPUT");
    expect(r1.json.reason).toContain("(1/2)");
    const r2 = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
    expect(r2.json.decision).toBe("block");
    const r3 = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
    expect(r3.json.decision).toBeUndefined();
    expect(r3.json.systemMessage).toContain("standing down");
  });
  it("allows when verification passes and resets the block counter", () => {
    const dir = makeProject({ config: baseConfig, git: true });
    runHookScript("edit-loop", { tool_name: "Edit", tool_input: { file_path: "a.ts" } }, { dir });
    const r = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
    expect(r.json).toBeNull();
    const state = JSON.parse(readFileSync(join(dir, ".doug/.state/test-session.json"), "utf8"));
    expect(state.lastGate.ok).toBe(true);
    expect(state.lastGate.results[0].name).toBe("test");
  });
  it("blocks when a protected file was changed through Bash", () => {
    const dir = makeProject({ config: baseConfig, git: true });
    writeFileSync(join(dir, ".env"), "SECRET=1");
    const r = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
    expect(r.json.decision).toBe("block");
    expect(r.json.reason).toContain("Protected files were modified: .env");
  });
  // card memory-decisions: a hand (Bash) write to a proposal-only path blocks unless its content is recorded
  // in the applied-proposal ledger (an approved `learn.mjs apply`).
  describe("proposalPaths: decisions/rules changed outside the proposal path (card memory-decisions)", () => {
    it("blocks when a file under docs/decisions/ is written by hand, and names the proposal message", () => {
      const dir = makeProject({ config: baseConfig, git: true });
      mkdirSync(join(dir, "docs/decisions"), { recursive: true });
      writeFileSync(join(dir, "docs/decisions/0007-hand-written.md"), "# 0007. hand written\n");
      const r = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
      expect(r.json.decision).toBe("block");
      expect(r.json.reason).toContain("Decisions/rules were written outside the proposal path");
      expect(r.json.reason).toContain("docs/decisions/0007-hand-written.md");
      expect(r.json.reason).toContain("/doug-decide");
      expect(r.json.reason).toContain("learn.mjs apply");
      expect(r.json.reason).toContain("not proof the user approved");
    });
    // card proposal-ledger-forgeable: a hand-written ledger line is not enough on its own any more - a hit is
    // fine only when the line's named diff, applied onto the target's committed base, re-derives the target's
    // current bytes. These three cases are the ways a forged line (sha256 alone, correct for the forged
    // content) fails that re-derivation.
    // review BLOCKER 1: a ledger row is untrusted, agent-writable data - `proposal` (or `diffSha256`) can be
    // any JSON value, not only a string. `resolve(dir, row.proposal)` throws on a non-string, and an uncaught
    // exception escaping isAppliedContent fails the whole Stop hook open (runHook in lib/io.mjs), silently
    // skipping every check, not only this one. A forged row with a non-string `proposal` must still block, not
    // crash the hook into a pass.
    it("BLOCKER 1: blocks (never crashes the hook) on a forged ledger line whose proposal is not a string", () => {
      const dir = makeProject({ config: baseConfig, git: true });
      mkdirSync(join(dir, "docs/decisions"), { recursive: true });
      const relPath = "docs/decisions/0001-forged.md";
      const content = "# 0001. forged\n";
      writeFileSync(join(dir, relPath), content);
      const sha256 = createHash("sha256").update(content).digest("hex");
      mkdirSync(join(dir, ".doug/.state/proposals"), { recursive: true });
      writeFileSync(
        join(dir, ".doug/.state/proposals/applied.jsonl"),
        `${JSON.stringify({ target: relPath, sha256, diffSha256: "deadbeef", at: new Date().toISOString(), proposal: true })}\n`,
      );
      const r = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
      expect(r.status).toBe(0); // the hook process itself must not crash
      expect(r.json).not.toBeNull(); // never fails open into "nothing to report"
      expect(r.json.systemMessage).toBeUndefined(); // never the "hook error, failing open" shape from lib/io.mjs
      expect(r.json.decision).toBe("block");
      expect(r.json.reason).toContain("Decisions/rules were written outside the proposal path");
      expect(r.json.reason).toContain(relPath);
    });
    it("blocks a forged ledger line whose proposal diff file does not exist", () => {
      const dir = makeProject({ config: baseConfig, git: true });
      mkdirSync(join(dir, "docs/decisions"), { recursive: true });
      const relPath = "docs/decisions/0001-forged.md";
      const content = "# 0001. forged\n";
      writeFileSync(join(dir, relPath), content);
      const sha256 = createHash("sha256").update(content).digest("hex");
      mkdirSync(join(dir, ".doug/.state/proposals"), { recursive: true });
      writeFileSync(
        join(dir, ".doug/.state/proposals/applied.jsonl"),
        `${JSON.stringify({ target: relPath, sha256, diffSha256: "deadbeef", at: new Date().toISOString(), proposal: ".doug/.state/learn/does-not-exist.diff" })}\n`,
      );
      const r = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
      expect(r.json.decision).toBe("block");
      expect(r.json.reason).toContain("Decisions/rules were written outside the proposal path");
      expect(r.json.reason).toContain(relPath);
      expect(r.json.reason).toContain("/doug-decide");
      expect(r.json.reason).toContain("learn.mjs apply");
    });
    it("blocks a forged ledger line whose diffSha256 does not match the named diff file's real bytes", () => {
      const dir = makeProject({ config: baseConfig, git: true });
      mkdirSync(join(dir, "docs/decisions"), { recursive: true });
      const relPath = "docs/decisions/0001-forged.md";
      const content = "# 0001. forged\n";
      writeFileSync(join(dir, relPath), content);
      const sha256 = createHash("sha256").update(content).digest("hex");
      const diffRel = ".doug/.state/learn/01-decision.diff";
      mkdirSync(dirname(join(dir, diffRel)), { recursive: true });
      writeFileSync(join(dir, diffRel), unifiedDiff(relPath, "", content)); // a real diff, but...
      mkdirSync(join(dir, ".doug/.state/proposals"), { recursive: true });
      writeFileSync(
        join(dir, ".doug/.state/proposals/applied.jsonl"),
        `${JSON.stringify({ target: relPath, sha256, diffSha256: "not-the-real-sha-of-that-diff-file", at: new Date().toISOString(), proposal: diffRel })}\n`,
      );
      const r = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
      expect(r.json.decision).toBe("block");
      expect(r.json.reason).toContain(relPath);
    });
    it("blocks a forged ledger line whose diff, though its diffSha256 checks out, does not reproduce the file's current bytes", () => {
      const dir = makeProject({ config: baseConfig, git: true });
      mkdirSync(join(dir, "docs/decisions"), { recursive: true });
      const relPath = "docs/decisions/0001-forged.md";
      const content = "# 0001. forged\n"; // what is actually on disk
      writeFileSync(join(dir, relPath), content);
      const sha256 = createHash("sha256").update(content).digest("hex");
      const diffRel = ".doug/.state/learn/01-decision.diff";
      mkdirSync(dirname(join(dir, diffRel)), { recursive: true });
      const diffText = unifiedDiff(relPath, "", "# 0001. something else entirely\n"); // does not match content
      writeFileSync(join(dir, diffRel), diffText);
      const diffSha256 = createHash("sha256").update(diffText).digest("hex"); // real sha of the diff file itself
      mkdirSync(join(dir, ".doug/.state/proposals"), { recursive: true });
      writeFileSync(
        join(dir, ".doug/.state/proposals/applied.jsonl"),
        `${JSON.stringify({ target: relPath, sha256, diffSha256, at: new Date().toISOString(), proposal: diffRel })}\n`,
      );
      const r = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
      expect(r.json.decision).toBe("block");
      expect(r.json.reason).toContain(relPath);
    });
    // review MAJOR 2: a mutation deleting the containment check (row.proposal resolves under
    // dir/.doug/.state/learn/) left the suite green - nothing exercised a diff that is otherwise entirely
    // genuine (real bytes, correct diffSha256, and it really would re-derive the target's current content) but
    // simply lives somewhere else. Three ways "somewhere else" can happen: the project root, an absolute path
    // outside the project, and a relative "../" escape out of `dir` itself.
    it("MAJOR 2: blocks a ledger line whose diff is real, byte-correct, and re-deriving, but lives outside .doug/.state/learn/", () => {
      const dir = makeProject({ config: baseConfig, git: true });
      mkdirSync(join(dir, "docs/decisions"), { recursive: true });
      const relPath = "docs/decisions/0002-outside-learn.md";
      const content = "# 0002. outside learn\n";
      writeFileSync(join(dir, relPath), content);
      const sha256 = createHash("sha256").update(content).digest("hex");
      const diffText = unifiedDiff(relPath, "", content);
      const diffSha256 = createHash("sha256").update(diffText).digest("hex");

      const rootDiffPath = join(dir, "root.diff");
      writeFileSync(rootDiffPath, diffText);

      const tmpOutside = mkdtempSync(join(tmpdir(), "doug-outside-learn-"));
      const absoluteDiffPath = join(tmpOutside, "absolute.diff");
      writeFileSync(absoluteDiffPath, diffText);

      // A unique name (tied to this fixture's own random dir) so this never collides with another test's file
      // one level up in the shared OS tmp root.
      const escapeDiffPath = join(dir, "..", `${basename(dir)}-escape.diff`);
      writeFileSync(escapeDiffPath, diffText);

      try {
        const cases = [
          ["project root", "root.diff"],
          ["absolute path outside the project", absoluteDiffPath],
          ["../ escape out of dir", `../${basename(dir)}-escape.diff`],
        ];
        for (const [label, proposal] of cases) {
          mkdirSync(join(dir, ".doug/.state/proposals"), { recursive: true });
          writeFileSync(
            join(dir, ".doug/.state/proposals/applied.jsonl"),
            `${JSON.stringify({ target: relPath, sha256, diffSha256, at: new Date().toISOString(), proposal })}\n`,
          );
          const r = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
          expect(r.json && r.json.decision, label).toBe("block");
          expect(r.json.reason, label).toContain(relPath);
        }
      } finally {
        rmSync(tmpOutside, { recursive: true, force: true });
        rmSync(escapeDiffPath, { force: true });
      }
    });
    // review MAJOR 3: a mutation replacing `row.target !== relPath` with a sha256-only check left the suite
    // green - nothing exercised two different targets sharing byte-identical content. A genuine
    // `applyProposal` line for 0008-other.md must not authorize a hand-written 0007-x.md carrying the exact
    // same bytes (and so the exact same sha256) at a different path.
    it("MAJOR 3: a genuine ledger line for a DIFFERENT target does not authorize a same-content file at another path", () => {
      const dir = makeProject({ config: baseConfig, git: true });
      const otherRelPath = "docs/decisions/0008-other.md";
      const content = "# shared content\n";
      const diffDir = join(dir, ".doug/.state/learn/manual");
      mkdirSync(diffDir, { recursive: true });
      const diffPath = join(diffDir, "01-other.diff");
      writeFileSync(diffPath, unifiedDiff(otherRelPath, "", content));
      expect(applyProposal(diffPath, { dir })).toEqual({ ok: true, target: otherRelPath });

      mkdirSync(join(dir, "docs/decisions"), { recursive: true });
      writeFileSync(join(dir, "docs/decisions/0007-x.md"), content); // byte-identical to 0008-other.md
      const r = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
      expect(r.json.decision).toBe("block");
      expect(r.json.reason).toContain("docs/decisions/0007-x.md");
      expect(r.json.reason).not.toContain("0008-other.md"); // that one really is authorized
    });
    // review MINOR 6: the old test pointed `proposal` at a nonexistent "x.diff", so it failed containment
    // first and never exercised the missing-diffSha256 guard itself. Here `proposal` genuinely names a real,
    // containment-passing, byte-correct, re-deriving diff - only the missing `diffSha256` field is wrong.
    it("blocks an old-shape ledger line (no diffSha256) even though it names a real, byte-correct, re-deriving diff", () => {
      const dir = makeProject({ config: baseConfig, git: true });
      const relPath = "docs/decisions/0007-applied.md";
      const content = "# 0007. applied\n";
      const diffDir = join(dir, ".doug/.state/learn/manual");
      mkdirSync(diffDir, { recursive: true });
      const diffPath = join(diffDir, "01-decision.diff");
      writeFileSync(diffPath, unifiedDiff(relPath, "", content));
      mkdirSync(join(dir, "docs/decisions"), { recursive: true });
      writeFileSync(join(dir, relPath), content);
      const sha256 = createHash("sha256").update(content).digest("hex");
      mkdirSync(join(dir, ".doug/.state/proposals"), { recursive: true });
      writeFileSync(
        join(dir, ".doug/.state/proposals/applied.jsonl"),
        `${JSON.stringify({ target: relPath, sha256, at: new Date().toISOString(), proposal: ".doug/.state/learn/manual/01-decision.diff" })}\n`,
      );
      const r = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
      expect(r.json.decision).toBe("block");
      expect(r.json.reason).toContain(relPath);
    });
    // review MINOR 8: the writer (applyProposal) refuses a diff naming any target other than the one it
    // returns; a ledger row must not trust a diff whose real header names a different file than row.target
    // claims, even when diffSha256 (of the diff file's own bytes) checks out correctly.
    it("MINOR 8: blocks a ledger row whose diffSha256 checks out but whose diff names a different single file than row.target", () => {
      const dir = makeProject({ config: baseConfig, git: true });
      mkdirSync(join(dir, "docs/decisions"), { recursive: true });
      const claimedRelPath = "docs/decisions/0007-y.md";
      const actualDiffTarget = "docs/decisions/0007-z.md";
      const content = "# shared\n";
      writeFileSync(join(dir, claimedRelPath), content);
      const sha256 = createHash("sha256").update(content).digest("hex");
      const diffText = unifiedDiff(actualDiffTarget, "", content); // names a DIFFERENT file than row.target
      const diffRel = ".doug/.state/learn/01-mismatch.diff";
      mkdirSync(dirname(join(dir, diffRel)), { recursive: true });
      writeFileSync(join(dir, diffRel), diffText);
      const diffSha256 = createHash("sha256").update(diffText).digest("hex");
      mkdirSync(join(dir, ".doug/.state/proposals"), { recursive: true });
      writeFileSync(
        join(dir, ".doug/.state/proposals/applied.jsonl"),
        `${JSON.stringify({ target: claimedRelPath, sha256, diffSha256, at: new Date().toISOString(), proposal: diffRel })}\n`,
      );
      const r = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
      expect(r.json.decision).toBe("block");
      expect(r.json.reason).toContain(claimedRelPath);
    });
    // review MINOR 9: diffNamesOnly is unpinned by the MINOR 8 test above - re-derivation alone already
    // catches a diff naming a single, different file (the target's own committed base never lands at the
    // right path in the scratch dir). What only diffNamesOnly catches is a diff that ALSO creates the claimed
    // target correctly (so re-derivation succeeds) while touching a second file too - exactly what the writer,
    // applyProposal, refuses outright as multi-file. Both halves here are new-file creations (no pre-existing
    // base needed in the scratch dir), so re-derivation alone would pass this one.
    it("MINOR 9: blocks a ledger row whose diffSha256 checks out and re-derives the target correctly, but whose diff also touches a second file", () => {
      const dir = makeProject({ config: baseConfig, git: true });
      mkdirSync(join(dir, "docs/decisions"), { recursive: true });
      const relPath = "docs/decisions/0007-multi.md";
      const content = "# 0007. multi\n";
      writeFileSync(join(dir, relPath), content);
      const sha256 = createHash("sha256").update(content).digest("hex");
      const targetDiff = unifiedDiff(relPath, "", content); // creates relPath correctly...
      const secondFileDiff = unifiedDiff("CLAUDE.md", "", "a decoy second file\n"); // ...but also creates this
      const diffText = targetDiff + secondFileDiff;
      const diffRel = ".doug/.state/learn/01-multi.diff";
      mkdirSync(dirname(join(dir, diffRel)), { recursive: true });
      writeFileSync(join(dir, diffRel), diffText);
      const diffSha256 = createHash("sha256").update(diffText).digest("hex");
      mkdirSync(join(dir, ".doug/.state/proposals"), { recursive: true });
      writeFileSync(
        join(dir, ".doug/.state/proposals/applied.jsonl"),
        `${JSON.stringify({ target: relPath, sha256, diffSha256, at: new Date().toISOString(), proposal: diffRel })}\n`,
      );
      const r = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
      expect(r.json.decision).toBe("block");
      expect(r.json.reason).toContain(relPath);
    });
    // review MINOR 10: the last-N cap (MAX_VERIFIED_ROWS in lib/proposals.mjs) is deduped by `proposal` before
    // slicing, so many rows all naming the very same diff cost one cap slot, not one each - a genuine row must
    // still be found behind a pile of rows that are really just repeats of one bogus proposal path.
    it("MINOR 10: a genuine applied line still passes behind 25 appended copies of one bogus row for the same target/sha256", () => {
      const dir = makeProject({ config: baseConfig, git: true });
      const relPath = "docs/decisions/0007-applied.md";
      const content = "# 0007. applied\n";
      const diffDir = join(dir, ".doug/.state/learn/manual");
      mkdirSync(diffDir, { recursive: true });
      const diffPath = join(diffDir, "01-decision.diff");
      writeFileSync(diffPath, unifiedDiff(relPath, "", content));
      expect(applyProposal(diffPath, { dir })).toEqual({ ok: true, target: relPath });
      const sha256 = createHash("sha256").update(content).digest("hex");

      const ledgerPath = join(dir, ".doug/.state/proposals/applied.jsonl");
      const bogusLine = `${JSON.stringify({
        target: relPath,
        sha256,
        diffSha256: "not-a-real-sha-of-anything",
        at: new Date().toISOString(),
        proposal: ".doug/.state/learn/does-not-exist.diff",
      })}\n`;
      appendFileSync(ledgerPath, bogusLine.repeat(25));

      const r = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
      expect(r.json).toBeNull();
    });
    // The genuine-line form: built by running applyProposal end to end, the same way `/doug-decide` does, so
    // the ledger line's diffSha256 and re-derivation both check out for real.
    it("does not block a newly created (untracked) file whose genuine applyProposal line re-derives its content from the diff", () => {
      const dir = makeProject({ config: baseConfig, git: true });
      const relPath = "docs/decisions/0007-applied.md";
      const content = "# 0007. applied\n";
      const diffDir = join(dir, ".doug/.state/learn/manual");
      mkdirSync(diffDir, { recursive: true });
      const diffPath = join(diffDir, "01-decision.diff");
      writeFileSync(diffPath, unifiedDiff(relPath, "", content));
      expect(applyProposal(diffPath, { dir })).toEqual({ ok: true, target: relPath });
      const r = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
      expect(r.json).toBeNull();
    });
    it("does not block a modified (tracked, in HEAD) target whose genuine applyProposal diff applies onto the committed base", () => {
      const dir = makeProject({ config: baseConfig, git: true });
      mkdirSync(join(dir, "docs/decisions"), { recursive: true });
      const relPath = "docs/decisions/0007-x.md";
      const before = "# 0007. x\n\nOriginal text.\n";
      writeFileSync(join(dir, relPath), before);
      execFileSync("git", ["add", "-A"], { cwd: dir });
      execFileSync("git", ["commit", "-q", "-m", "base"], { cwd: dir });

      const after = `${before}\n## Amendment 2026-09-12\n\nMore text.\n`;
      const diffDir = join(dir, ".doug/.state/learn/manual");
      mkdirSync(diffDir, { recursive: true });
      const diffPath = join(diffDir, "01-amend.diff");
      writeFileSync(diffPath, unifiedDiff(relPath, before, after));
      expect(applyProposal(diffPath, { dir })).toEqual({ ok: true, target: relPath });
      const r = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
      expect(r.json).toBeNull();
    });
    it("allows when proposalPaths is set to []", () => {
      const dir = makeProject({ config: { ...baseConfig, proposalPaths: [] }, git: true });
      mkdirSync(join(dir, "docs/decisions"), { recursive: true });
      writeFileSync(join(dir, "docs/decisions/0007-hand-written.md"), "# 0007. hand written\n");
      const r = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
      expect(r.json).toBeNull();
    });
  });
  it("does not flag protected paths listed in ignoreChangedPaths", () => {
    const dir = makeProject({ config: { ...baseConfig, stopGate: { ...baseConfig.stopGate, ignoreChangedPaths: ["pnpm-lock.yaml"] } }, git: true });
    writeFileSync(join(dir, "pnpm-lock.yaml"), "lockfileVersion: 9");
    const r = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
    expect(r.json).toBeNull();
  });
  it("does not report a protected-file problem when only .doug/config.json is dirty (the installer's own first-run output)", () => {
    // protectedPaths is extended to cover .doug/config.json (as DEFAULTS.protectedPaths does), but
    // stopGate.ignoreChangedPaths is left unset here so this exercises DEFAULTS.stopGate.ignoreChangedPaths
    // (plugins/doug-gates/lib/config.mjs) rather than an override in the test's own fixture.
    const cfg = { ...baseConfig, protectedPaths: [...baseConfig.protectedPaths, ".doug/config.json"] };
    // makeProject writes .doug/config.json itself and nothing is committed, so it is the only dirty path here —
    // exactly the state a fresh `doug init` leaves a project in.
    const dir = makeProject({ config: cfg, git: true });
    const r = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
    expect(r.json).toBeNull();
  });
  it("still reports a protected-file problem when another protected path is dirty, even with .doug/config.json ignored by default", () => {
    const cfg = { ...baseConfig, protectedPaths: [...baseConfig.protectedPaths, ".doug/config.json"] };
    const dir = makeProject({ config: cfg, git: true });
    writeFileSync(join(dir, ".env"), "SECRET=1");
    const r = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
    expect(r.json.decision).toBe("block");
    // Only .env is named as changed; .doug/config.json is dirty too (makeProject writes it, nothing is
    // committed) but is excluded by the default ignoreChangedPaths, so it never appears in the modified-files
    // list itself.
    expect(r.json.reason).toContain("Protected files were modified: .env.");
  });
  it("ignores Claude Code's subagent worktrees under .claude/worktrees, even when they contain protected paths", () => {
    const dir = makeProject({ config: baseConfig, git: true });
    mkdirSync(join(dir, ".claude/worktrees/wf_1/node_modules"), { recursive: true });
    writeFileSync(join(dir, ".claude/worktrees/wf_1/node_modules/x.js"), "");
    writeFileSync(join(dir, ".claude/worktrees/wf_1/.env"), "SECRET=1");
    const r = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
    expect(r.json).toBeNull();
  });
  describe("plan scope", () => {
    const plan = (status, extra = {}) => ({
      version: 1,
      title: "Truncate helper",
      goal: "Add truncate to the strings module",
      status,
      acceptance: ["truncate exists"],
      verify: [],
      tasks: [
        { id: "add-truncate", title: "Add truncate", spec: "Add truncate(input, max) to src/strings.ts with tests.", files: ["src/strings.ts", "tests/strings.test.ts"] },
        { id: "docs", title: "Document it", spec: "Mention truncate in the README usage section.", files: ["docs/"] },
      ],
      ...extra,
    });
    // Config and plan are committed, as in a real project; an uncommitted .doug/config.json is a
    // changed file like any other and the gate names it.
    function project(status, config = baseConfig) {
      const dir = makeProject({ config, git: true });
      if (status) writeFileSync(join(dir, ".doug/plan.json"), JSON.stringify(plan(status)));
      mkdirSync(join(dir, "src"));
      mkdirSync(join(dir, "docs"));
      execFileSync("git", ["add", "-A"], { cwd: dir });
      execFileSync("git", ["commit", "-q", "-m", "base"], { cwd: dir });
      return dir;
    }
    it("allows changes inside the approved plan's files, directories, and the plan's own files", () => {
      const dir = project("approved");
      writeFileSync(join(dir, "src/strings.ts"), "export const truncate = () => ''");
      writeFileSync(join(dir, "docs/usage.md"), "# usage");
      writeFileSync(join(dir, ".doug/anchor.md"), "Task: add-truncate");
      const r = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
      expect(r.json).toBeNull();
      const state = JSON.parse(readFileSync(join(dir, ".doug/.state/test-session.json"), "utf8"));
      expect(state.lastGate.scope).toEqual({ plan: "Truncate helper", status: "approved", outOfScope: [] });
    });
    it("blocks a change outside the plan and names the file and the nearest owning task", () => {
      const dir = project("approved");
      writeFileSync(join(dir, "src/duration.ts"), "export const x = 1");
      const r = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
      expect(r.json.decision).toBe("block");
      expect(r.json.reason).toContain('outside the approved plan "Truncate helper"');
      expect(r.json.reason).toContain("src/duration.ts  nearest task: add-truncate (owns src/strings.ts)");
      expect(r.json.reason).toContain("re-approve");
      const state = JSON.parse(readFileSync(join(dir, ".doug/.state/test-session.json"), "utf8"));
      expect(state.lastGate.scope.outOfScope).toEqual(["src/duration.ts"]);
    });
    it("still enforces a done plan, and a task owning README.md does not cover docs/README.md", () => {
      const dir = project("done");
      writeFileSync(join(dir, "README.md"), "# top");
      const r = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
      expect(r.json.decision).toBe("block");
      expect(r.json.reason).toContain("outside the done plan");
      expect(r.json.reason).toContain("README.md  no task owns anything near it");
    });
    it("does not flag files listed in ignoreChangedPaths", () => {
      const dir = project("approved", { ...baseConfig, stopGate: { ...baseConfig.stopGate, ignoreChangedPaths: ["pnpm-lock.yaml", "generated/**"] } });
      writeFileSync(join(dir, "pnpm-lock.yaml"), "lockfileVersion: 9");
      mkdirSync(join(dir, "generated"));
      writeFileSync(join(dir, "generated/api.ts"), "");
      writeFileSync(join(dir, "src/strings.ts"), "");
      expect(runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir }).json).toBeNull();
    });
    it("ignores draft and rejected plans, a missing plan, and planScope: false", () => {
      for (const status of ["draft", "rejected", null]) {
        const dir = project(status);
        writeFileSync(join(dir, "src/duration.ts"), "");
        expect(runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir }).json).toBeNull();
      }
      const off = project("approved", { ...baseConfig, stopGate: { ...baseConfig.stopGate, planScope: false } });
      writeFileSync(join(off, "src/duration.ts"), "");
      expect(runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir: off }).json).toBeNull();
    });
    it("fails open on an unreadable plan and says so on stderr", () => {
      const dir = project(null);
      writeFileSync(join(dir, ".doug/plan.json"), "{not json");
      writeFileSync(join(dir, "src/duration.ts"), "");
      const r = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
      expect(r.json).toBeNull();
      expect(r.stderr).toContain("plan.json is unreadable");
    });
  });
  it("stops blocking past the turn budget", () => {
    const dir = makeProject({ config: { ...baseConfig, budget: { maxTurns: 1 } }, git: true });
    runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
    const r = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
    expect(r.json.systemMessage).toContain("Turn budget");
  });

  describe("context-window handoff notice (card context-window-handoff)", () => {
    const contextConfig = { ...baseConfig, contextWindow: { enabled: true, threshold: 80, repeatAfter: 5 } };
    // Records a pct into the session's state the way the status line does, through the real script.
    function setContext(dir, pct) {
      runHookScript("statusline", { context_window: { used_percentage: pct } }, { dir });
    }
    function commit(dir) {
      execFileSync("git", ["add", "-A"], { cwd: dir });
      execFileSync("git", ["commit", "-q", "-m", "base"], { cwd: dir });
    }

    it("(i) does nothing under the threshold", () => {
      const dir = makeProject({ config: contextConfig, git: true });
      setContext(dir, 50);
      const r = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
      expect(r.json).toBeNull();
      expect(existsSync(join(dir, ".doug/anchor.md"))).toBe(false);
    });

    it("(ii) notices at a green Stop over the threshold with no subagent in flight, and writes the handoff block", () => {
      const dir = makeProject({ config: contextConfig, git: true });
      commit(dir);
      setContext(dir, 85);
      runHookScript("edit-loop", { tool_name: "Edit", tool_input: { file_path: "a.ts" } }, { dir }); // verification passes: state.lastGate gets set
      const r = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
      expect(r.json.decision).toBeUndefined();
      expect(r.json.systemMessage).toContain("[doug] Context at 85% (threshold 80)");
      expect(r.json.systemMessage).toContain("verification passed this turn");
      expect(r.json.systemMessage).toContain("Run /compact");
      const anchor = readFileSync(join(dir, ".doug/anchor.md"), "utf8");
      expect(anchor).toContain("### Handoff boundary");
      expect(anchor).toContain("Boundary: verification passed");
      expect(anchor).toMatch(/Gate: green \(at \d{4}-\d{2}-\d{2}T/);
      expect(anchor).toMatch(/HEAD: [0-9a-f]{7,}/);
      expect(anchor).toContain("Context: 85%");
    });

    it("(minor 3 pin) the skip boundary (nothing changed) names itself in the message and anchor, with no Gate line", () => {
      const dir = makeProject({ config: contextConfig, git: true });
      commit(dir);
      setContext(dir, 85); // no edit-loop: this Stop takes the "nothing changed" skip path
      const r = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
      expect(r.json.decision).toBeUndefined();
      expect(r.json.systemMessage).toContain("nothing changed this turn");
      const anchor = readFileSync(join(dir, ".doug/anchor.md"), "utf8");
      expect(anchor).toContain("Boundary: nothing changed");
      expect(anchor).not.toContain("Gate:");
    });

    it("(iii) the Stop defers (card stop-gate-defers-while-subagent-in-flight) while a subagent is in flight per the run trace, with no context notice or handoff", () => {
      const dir = makeProject({ config: contextConfig, git: true });
      setContext(dir, 85);
      runHookScript("trace", { hook_event_name: "SubagentStart", agent_id: "ag1", agent_type: "Explore" }, { dir });
      const r = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
      expect(r.json.decision).toBeUndefined();
      expect(r.json.systemMessage).toContain("Verification deferred");
      expect(r.json.systemMessage).toContain("Explore:ag1");
      expect(r.json.systemMessage).not.toContain("Context at");
      expect(r.json.systemMessage).not.toContain("/compact");
      expect(existsSync(join(dir, ".doug/anchor.md")), "no handoff block while an agent is in flight").toBe(false);
    });

    it("(iii-b) an in-flight agent suppresses the notice on the nothing-changed skip too, before the deferral is ever reached", () => {
      const dir = makeProject({ config: contextConfig, git: true });
      commit(dir); // nothing left uncommitted: this Stop takes the onlyIfEdited (nothing changed) skip, never
      // reaching this card's own in-flight deferral — contextNotice's own suppression (subagentsInFlight
      // length > 0) is what is under test here.
      setContext(dir, 85);
      runHookScript("trace", { hook_event_name: "SubagentStart", agent_id: "ag1", agent_type: "Explore" }, { dir });
      const r = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
      expect(r.json, "no notice and no deferral message: nothing changed, so there is nothing to defer either").toBeNull();
      expect(existsSync(join(dir, ".doug/anchor.md")), "no handoff block while an agent is in flight").toBe(false);
    });

    it("(iv) does nothing on a SubagentStop event, even over the threshold", () => {
      const dir = makeProject({ config: contextConfig, git: true });
      setContext(dir, 85);
      const r = runHookScript("stop-gate", { hook_event_name: "SubagentStop", agent_id: "ag1", agent_type: "Explore" }, { dir });
      expect(r.json).toBeNull();
      expect(existsSync(join(dir, ".doug/anchor.md"))).toBe(false);
    });

    it("(v) leaves the block reason byte-identical on a red gate, with no notice mixed in", () => {
      const failing = { ...contextConfig, commands: { test: "echo FAIL-OUTPUT; exit 1" } };
      const dir = makeProject({ config: failing, git: true });
      setContext(dir, 85);
      runHookScript("edit-loop", { tool_name: "Edit", tool_input: { file_path: "a.ts" } }, { dir });
      const withContext = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
      expect(withContext.json.decision).toBe("block");
      expect(withContext.json.reason).not.toContain("Context at");
      expect(withContext.json.reason).not.toContain("/compact");
      expect(existsSync(join(dir, ".doug/anchor.md"))).toBe(false);

      // Byte-identical to the same scenario with contextWindow disabled.
      const plainDir = makeProject({ config: { ...baseConfig, commands: { test: "echo FAIL-OUTPUT; exit 1" } }, git: true });
      runHookScript("edit-loop", { tool_name: "Edit", tool_input: { file_path: "a.ts" } }, { dir: plainDir });
      const plain = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir: plainDir });
      expect(withContext.json.reason).toBe(plain.json.reason);
    });

    it("(vi) does nothing when state.context is absent or explicitly null", () => {
      const dir = makeProject({ config: contextConfig, git: true });
      const r1 = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir }); // never recorded
      expect(r1.json).toBeNull();

      mkdirSync(join(dir, ".doug/.state"), { recursive: true });
      writeFileSync(join(dir, ".doug/.state/test-session.json"), JSON.stringify({ context: null }));
      const r2 = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
      expect(r2.json).toBeNull();
      expect(existsSync(join(dir, ".doug/anchor.md"))).toBe(false);
    });

    it("(vii) is off by default, so a pct over the threshold produces nothing", () => {
      const dir = makeProject({ config: baseConfig, git: true }); // contextWindow not set: defaults to disabled
      mkdirSync(join(dir, ".doug/.state"), { recursive: true });
      writeFileSync(join(dir, ".doug/.state/test-session.json"), JSON.stringify({ context: { pct: 95, at: new Date().toISOString() } }));
      const r = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
      expect(r.json).toBeNull();
      expect(existsSync(join(dir, ".doug/anchor.md"))).toBe(false);
    });

    it("(viii) does not repeat until pct grows by repeatAfter, then notices again", () => {
      const dir = makeProject({ config: contextConfig, git: true });
      commit(dir);
      setContext(dir, 85);
      const first = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
      expect(first.json.systemMessage).toContain("Context at 85%");

      setContext(dir, 85); // no growth: statusline itself is a no-op since pct is unchanged
      const second = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
      expect(second.json).toBeNull();

      setContext(dir, 90); // pct + repeatAfter
      const third = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
      expect(third.json.systemMessage).toContain("Context at 90%");
    });

    it("(blocker) its own anchor.md write is never mistaken for this session's change on the next Stop", () => {
      // requireEvidence: true (the real default) reproduces the bug: a session that changed nothing but whose
      // notice wrote .doug/anchor.md would otherwise be told to run a test or verify command it never needed to.
      const withEvidence = { ...contextConfig, stopGate: { ...contextConfig.stopGate, requireEvidence: true } };
      const dir = makeProject({ config: withEvidence, git: true });
      commit(dir);
      setContext(dir, 85);
      const first = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
      expect(first.json.systemMessage).toContain("Context at 85%");
      const state1 = JSON.parse(readFileSync(join(dir, ".doug/.state/test-session.json"), "utf8"));
      expect(state1.stopBlocks).toBe(0);
      expect(readFileSync(join(dir, ".doug/anchor.md"), "utf8")).toContain("Handoff boundary");

      // Second Stop: nothing else changed, no test/verify command ran. Must stay silent, not block.
      const second = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
      expect(second.json).toBeNull();
      const state2 = JSON.parse(readFileSync(join(dir, ".doug/.state/test-session.json"), "utf8"));
      expect(state2.stopBlocks).toBe(0);
    });

    it("(major) does nothing when trace is disabled, even over the threshold with a green Stop (the in-flight check needs it)", () => {
      const dir = makeProject({ config: { ...contextConfig, trace: { enabled: false } }, git: true });
      setContext(dir, 85);
      const r = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
      expect(r.json).toBeNull();
      expect(existsSync(join(dir, ".doug/anchor.md"))).toBe(false);
    });

    it("(minor 5) notifiedAt survives a later status-line pct update, so repeat logic still applies", () => {
      const dir = makeProject({ config: contextConfig, git: true });
      commit(dir);
      setContext(dir, 85);
      const first = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
      expect(first.json.systemMessage).toContain("Context at 85%");
      let state = JSON.parse(readFileSync(join(dir, ".doug/.state/test-session.json"), "utf8"));
      expect(state.context.notifiedAt).toBe(85);

      setContext(dir, 87); // the status line records a new pct; notifiedAt (written by the Stop gate) must survive
      state = JSON.parse(readFileSync(join(dir, ".doug/.state/test-session.json"), "utf8"));
      expect(state.context.pct).toBe(87);
      expect(state.context.notifiedAt).toBe(85);

      const second = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
      expect(second.json).toBeNull(); // 87 < 85 + repeatAfter(5): still silent
    });

    it("(minor 6) concatenates the checkpoint message and the context notice, in order", () => {
      const dir = makeProject({ config: { ...contextConfig, checkpoint: { enabled: true, mode: "commit", message: "doug: checkpoint" } }, git: true });
      commit(dir);
      setContext(dir, 85);
      writeFileSync(join(dir, "src.txt"), "x");
      runHookScript("edit-loop", { tool_name: "Edit", tool_input: { file_path: "src.txt" } }, { dir });
      const r = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
      expect(r.json.decision).toBeUndefined();
      const msg = r.json.systemMessage;
      const checkpointIdx = msg.indexOf("Checkpoint committed");
      const noticeIdx = msg.indexOf("[doug] Context at 85%");
      expect(checkpointIdx).toBeGreaterThanOrEqual(0);
      expect(noticeIdx).toBeGreaterThan(checkpointIdx);
    });
  });
});

// card stop-gate-process-storm, case 1: runCommand's own group-kill-on-timeout, tested directly against
// lib/run.mjs rather than through the stop-gate script (the script only ever calls it with a real command).
describe("runCommand (card stop-gate-process-storm)", () => {
  // A synchronous sleep: spawnSync-based runCommand blocks the whole time anyway, so a real (non-busy) wait
  // here costs nothing and keeps the polling loops below simple.
  const sleepSync = (ms) => {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  };

  it("kills the whole process group on timeout, including a grandchild the command spawned (case 1)", () => {
    const dir = makeProject({});
    const pidfile = join(dir, "grandchild.pid");
    const script = join(dir, "spawner.mjs");
    // Spawns a grandchild node that just sleeps, records its pid, then the parent itself also sleeps — the
    // 2026-09-16 process-storm shape: a command whose own child outlives it.
    writeFileSync(
      script,
      [
        'import { spawn } from "node:child_process";',
        'import { writeFileSync } from "node:fs";',
        'const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"]);',
        "writeFileSync(process.argv[2], String(child.pid));",
        "setTimeout(() => {}, 30000);",
      ].join("\n"),
    );
    let grandchildPid = null;
    try {
      const r = runCommand(`${process.execPath} ${script} ${pidfile}`, { cwd: dir, timeoutMs: 1000 });
      expect(r.timedOut).toBe(true);
      // The grandchild writes its pidfile within a few ms of starting, well inside the 1000ms budget.
      let seen = existsSync(pidfile);
      const pidDeadline = Date.now() + 500;
      while (!seen && Date.now() < pidDeadline) {
        sleepSync(20);
        seen = existsSync(pidfile);
      }
      expect(seen, "the grandchild process never even started").toBe(true);
      grandchildPid = Number(readFileSync(pidfile, "utf8").trim());
      // Case 1: "within 1 s of runCommand returning, that grandchild is dead" — process.kill(pid, 0) throws
      // (ESRCH) once it is gone; poll for up to 1s rather than assume it is instant.
      let dead = false;
      const deadline = Date.now() + 1000;
      while (Date.now() < deadline) {
        try {
          process.kill(grandchildPid, 0);
        } catch {
          dead = true;
          break;
        }
        sleepSync(20);
      }
      expect(dead, "runCommand must kill the whole process group on timeout, including a grandchild the timed-out command spawned").toBe(true);
    } finally {
      if (grandchildPid) {
        try {
          process.kill(grandchildPid, "SIGKILL");
        } catch {
          // already gone (the expected outcome) or never started
        }
      }
    }
  });

  it("a command that finishes in time is unaffected", () => {
    const dir = makeProject({});
    const r = runCommand(`${process.execPath} -e "process.exit(0)"`, { cwd: dir, timeoutMs: 5000 });
    expect(r.ok).toBe(true);
    expect(r.timedOut).toBe(false);
  });
});

// card gates-runner-no-color: gate runners must spawn commands with NO_COLOR=1 and never FORCE_COLOR, the same
// shape as commandEnv() in plugins/doug-flow/lib/land.mjs (0c38855) — vitest's colour library treats ANY
// FORCE_COLOR key, even "0", as colour on, which breaks the stop gate's captured-output and block-ledger
// parsing.
describe("gate runner env (card gates-runner-no-color)", () => {
  // Writes a script whose command dumps NO_COLOR/FORCE_COLOR from its own environment to an absolute tmp
  // file as JSON, so the test can assert on the exact env the runner spawned it with.
  const envDumpCommand = (envFile) =>
    `${process.execPath} -e "require('fs').writeFileSync('${envFile}', JSON.stringify({NO_COLOR: process.env.NO_COLOR, FORCE_COLOR: process.env.FORCE_COLOR})); process.exit(0)"`;
  const readEnv = (envFile) => JSON.parse(readFileSync(envFile, "utf8"));
  const withInheritedForceColor = (fn) => {
    const prev = process.env.FORCE_COLOR;
    process.env.FORCE_COLOR = "0";
    try {
      fn();
    } finally {
      if (prev === undefined) delete process.env.FORCE_COLOR;
      else process.env.FORCE_COLOR = prev;
    }
  };

  it("commandEnv sets NO_COLOR=1, keeps CI when set else defaults it, and drops FORCE_COLOR (T1)", () => {
    const env = commandEnv({ CI: "true", FORCE_COLOR: "0", PATH: "x" });
    expect(env).toEqual({ CI: "true", NO_COLOR: "1", PATH: "x" });
    expect(env).not.toHaveProperty("FORCE_COLOR");
    expect(commandEnv({}).CI).toBe("1");
  });

  describe("stop gate (T2)", () => {
    const stopGateProject = (envFile) => {
      const cfg = {
        ...baseConfig,
        commands: { test: envDumpCommand(envFile) },
        stopGate: { ...baseConfig.stopGate, commands: ["test"] },
      };
      const dir = makeProject({ config: cfg, git: true });
      mkdirSync(join(dir, "src"), { recursive: true });
      // Dirty before any baseline capture, and never committed: the stop gate's own first-run capture (no
      // SessionStart) counts it all as changed, so the configured stopGate.commands run — see the existing
      // "fallback (no SessionStart)" case above for this same shape.
      writeFileSync(join(dir, "src/a.ts"), "dirty before the session began");
      return dir;
    };

    it("runs stopGate.commands with NO_COLOR=1 and no FORCE_COLOR", () => {
      const envDir = mkdtempSync(join(tmpdir(), "doug-gates-env-"));
      const envFile = join(envDir, "env.json");
      const dir = stopGateProject(envFile);
      runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
      const env = readEnv(envFile);
      expect(env.NO_COLOR).toBe("1");
      expect(env.FORCE_COLOR).toBeUndefined();
    });

    it("deletes an inherited FORCE_COLOR rather than passing it through", () => {
      const envDir = mkdtempSync(join(tmpdir(), "doug-gates-env-"));
      const envFile = join(envDir, "env.json");
      const dir = stopGateProject(envFile);
      withInheritedForceColor(() => {
        runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
      });
      const env = readEnv(envFile);
      expect(env.NO_COLOR).toBe("1");
      expect(env.FORCE_COLOR).toBeUndefined();
    });
  });

  describe("format-on-edit (T3)", () => {
    const formatOnEditProject = (envFile) =>
      makeProject({
        config: {
          ...baseConfig,
          formatter: {
            command: [
              process.execPath,
              "-e",
              `require('fs').writeFileSync('${envFile}', JSON.stringify({NO_COLOR: process.env.NO_COLOR, FORCE_COLOR: process.env.FORCE_COLOR})); process.exit(0)`,
            ],
            extensions: [".ts"],
          },
        },
      });

    it("runs the formatter with NO_COLOR=1 and no FORCE_COLOR", () => {
      const envDir = mkdtempSync(join(tmpdir(), "doug-gates-env-"));
      const envFile = join(envDir, "env.json");
      const dir = formatOnEditProject(envFile);
      mkdirSync(join(dir, "src"));
      writeFileSync(join(dir, "src/a.ts"), "raw");
      runHookScript("format-on-edit", { tool_name: "Edit", tool_input: { file_path: "src/a.ts" } }, { dir });
      const env = readEnv(envFile);
      expect(env.NO_COLOR).toBe("1");
      expect(env.FORCE_COLOR).toBeUndefined();
    });

    it("deletes an inherited FORCE_COLOR rather than passing it through", () => {
      const envDir = mkdtempSync(join(tmpdir(), "doug-gates-env-"));
      const envFile = join(envDir, "env.json");
      const dir = formatOnEditProject(envFile);
      mkdirSync(join(dir, "src"));
      writeFileSync(join(dir, "src/a.ts"), "raw");
      withInheritedForceColor(() => {
        runHookScript("format-on-edit", { tool_name: "Edit", tool_input: { file_path: "src/a.ts" } }, { dir });
      });
      const env = readEnv(envFile);
      expect(env.NO_COLOR).toBe("1");
      expect(env.FORCE_COLOR).toBeUndefined();
    });
  });
});

// card stop-gate-process-storm, cases 2 and 3: a verified-tree fingerprint that lets a later Stop/SubagentStop
// with an unchanged tree skip re-running the verification commands, and a single-runner lock so concurrent
// SubagentStops share one suite instead of each starting its own (the 2026-09-16 process storm). Every
// gate command below appends to, or reads, a file under .doug/.state/ — changedFiles (lib/baseline.mjs)
// unconditionally filters that whole prefix out of "what changed", so a command's own side effects never
// pollute the very tree fingerprint being tested.
describe("stop-gate process storm (card stop-gate-process-storm)", () => {
  const runsLogRelpath = ".doug/.state/runs.log";
  const lockSeenRelpath = ".doug/.state/lock-seen.json";
  const lockRelpath = ".doug/.state/gate.lock";

  // Counts verification runs: each run appends one "x" byte.
  const makeRunsConfig = (timeoutMs) => ({
    ...baseConfig,
    commands: { "test:unit": `${process.execPath} -e "require('fs').appendFileSync('${runsLogRelpath}','x')"` },
    stopGate: { commands: ["test:unit"], onlyIfEdited: true, maxBlocks: 3, timeoutMs, requireEvidence: false },
    trace: { enabled: true },
  });
  // Copies whatever gate.lock looks like while the command runs, so the test can inspect it afterward
  // (gate.lock itself is normally gone again by the time the hook process exits and stdout is read back).
  const makeLockSeenConfig = (timeoutMs) => ({
    ...baseConfig,
    commands: { "test:unit": `${process.execPath} -e "require('fs').copyFileSync('${lockRelpath}','${lockSeenRelpath}')"` },
    stopGate: { commands: ["test:unit"], onlyIfEdited: true, maxBlocks: 3, timeoutMs, requireEvidence: false },
    trace: { enabled: true },
  });

  const runsLogPath = (dir) => join(dir, runsLogRelpath);
  const runsCount = (dir) => (existsSync(runsLogPath(dir)) ? readFileSync(runsLogPath(dir), "utf8").length : 0);
  const lockPath = (dir) => join(dir, lockRelpath);

  // Base project for cases 2/2b/2c: a git repo, a base commit, then one file edited and dirtied — the shape
  // every "still dirty, still edited" sub-case below builds on.
  function makeEditedProject(config) {
    const dir = makeProject({ config, git: true });
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src/a.ts"), "base");
    execFileSync("git", ["add", "-A"], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", "base"], { cwd: dir });
    writeFileSync(join(dir, "src/a.ts"), "edited this session");
    runHookScript("edit-loop", { tool_name: "Edit", tool_input: { file_path: "src/a.ts" } }, { dir });
    return dir;
  }

  describe("case 2: verified tree recorded on green, and a later Stop/SubagentStop with a matching tree skips", () => {
    it("records state.verified on a green gate, and skips a Stop or SubagentStop whose tree still matches, tracing the skip", () => {
      const dir = makeEditedProject(makeRunsConfig(10000));

      // Stop #1: green, must actually run the command once, and record state.verified.
      const r1 = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
      expect(r1.json).toBeNull();
      expect(runsCount(dir)).toBe(1);
      const headSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
      const state1 = JSON.parse(readFileSync(join(dir, ".doug/.state/test-session.json"), "utf8"));
      expect(state1.verified, "state.verified must be recorded by a green gate (goal 2)").toBeTruthy();
      expect(state1.verified.head).toBe(headSha);
      expect(state1.verified.tree).toHaveProperty("src/a.ts");
      expect(state1.verified.tree["src/a.ts"]).toMatch(/^\d+:[0-9a-f]{40}$/);

      // Stop #2: nothing has changed since Stop #1 — must be skipped, not rerun, with a trace line.
      const r2 = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
      expect(r2.json).toBeNull();
      expect(runsCount(dir), "a Stop whose tree matches the recorded verified tree must not rerun the verification commands").toBe(1);
      const traceFile = join(dir, ".doug/.state/trace/test-session.jsonl");
      const traceLines = existsSync(traceFile) ? readFileSync(traceFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
      expect(traceLines.some((l) => l.reason === "verified-unchanged"), 'a verified-unchanged skip must append a trace line with that reason').toBe(true);

      // SubagentStop with nothing changed either: also skipped, sharing the same recorded verified tree.
      const r3 = runHookScript("stop-gate", { hook_event_name: "SubagentStop", agent_id: "ag1", agent_type: "coder" }, { dir });
      expect(r3.json).toBeNull();
      expect(runsCount(dir), "a SubagentStop whose tree matches the recorded verified tree must not rerun the verification commands").toBe(1);
    });

    it("any difference in the tree since state.verified runs the commands again", () => {
      const dir = makeEditedProject(makeRunsConfig(10000));
      runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir }); // run #1, records verified
      expect(runsCount(dir)).toBe(1);

      // The dirty path itself changes further: identity moves.
      writeFileSync(join(dir, "src/a.ts"), "edited again");
      runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
      expect(runsCount(dir), "a further edit to the already-dirty path must run verification again").toBe(2);

      // The session commits everything: HEAD moves, tree goes clean, but this session's own edit earlier
      // keeps `edited` true, so the gate still runs — and the recorded head no longer matches.
      execFileSync("git", ["add", "-A"], { cwd: dir });
      execFileSync("git", ["commit", "-q", "-m", "commit the edit"], { cwd: dir });
      runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
      expect(runsCount(dir), "a HEAD that moved since state.verified.head must run verification again").toBe(3);

      // A proposal-path file appears (added, not just modified): whichever the gate ultimately does with it
      // (block, or allow), the verification commands must still have run.
      const before = runsCount(dir);
      mkdirSync(join(dir, "docs/decisions"), { recursive: true });
      writeFileSync(join(dir, "docs/decisions/0001-x.md"), "# decision\n");
      runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
      expect(runsCount(dir), "a new proposal-path file on disk must run verification again").toBeGreaterThan(before);

      // A dirty path disappears.
      const before2 = runsCount(dir);
      rmSync(join(dir, "src/a.ts"));
      runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
      expect(runsCount(dir), "a dirty path that was deleted must run verification again").toBeGreaterThan(before2);
    });

    it("a red gate records no verified tree, and an old-format state file with no state.verified key runs verification exactly as before", () => {
      const failConfig = { ...makeRunsConfig(10000), commands: { "test:unit": "exit 1" } };
      const dir = makeEditedProject(failConfig);
      const r = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
      expect(r.json.decision).toBe("block");
      const state = JSON.parse(readFileSync(join(dir, ".doug/.state/test-session.json"), "utf8"));
      expect(state.verified == null, "a red gate must not record a verified tree").toBe(true);

      // A separate, ordinary (old-format) state file: nothing has ever set state.verified. Verification
      // still runs, unaffected — exactly today's behavior.
      const dir2 = makeEditedProject(makeRunsConfig(10000));
      const r2 = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir: dir2 });
      expect(r2.json).toBeNull();
      expect(runsCount(dir2)).toBe(1);
    });

    // Second tester pass (reviewer-found gaps): each guard below isolates one signal sameTree must actually
    // compare, rather than letting some other coincidental change carry the assertion.
    it("a HEAD that moved since state.verified defeats the skip, even when the dirty set and its identities are completely untouched", () => {
      const dir = makeEditedProject(makeRunsConfig(10000));
      runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir }); // run #1, records verified
      expect(runsCount(dir)).toBe(1);

      // HEAD moves; src/a.ts (the dirty path recorded in state.verified.tree) is not touched at all.
      execFileSync("git", ["commit", "--allow-empty", "-q", "-m", "x"], { cwd: dir });

      runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
      expect(
        runsCount(dir),
        "a HEAD that moved since state.verified.head must defeat the skip even when the dirty set itself is byte-for-byte unchanged",
      ).toBe(2);
    });

    it("a gitignored proposal-path file that appears since state.verified defeats the skip, even though git status cannot see it", () => {
      const cfg = { ...makeRunsConfig(10000), proposalPaths: ["docs/decisions/**"] };
      const dir = makeProject({ config: cfg, git: true });
      writeFileSync(join(dir, ".gitignore"), "docs/decisions/\n.doug/.state/\n");
      mkdirSync(join(dir, "src"));
      writeFileSync(join(dir, "src/a.ts"), "base");
      execFileSync("git", ["add", "-A"], { cwd: dir });
      execFileSync("git", ["commit", "-q", "-m", "base"], { cwd: dir });
      writeFileSync(join(dir, "src/a.ts"), "edited this session");
      runHookScript("edit-loop", { tool_name: "Edit", tool_input: { file_path: "src/a.ts" } }, { dir });

      runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir }); // run #1, records verified
      expect(runsCount(dir)).toBe(1);

      mkdirSync(join(dir, "docs/decisions"), { recursive: true });
      writeFileSync(join(dir, "docs/decisions/0001-x.md"), "# decision\n"); // gitignored: invisible to `git status`

      const r = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
      const traceFile = join(dir, ".doug/.state/trace/test-session.jsonl");
      const traceLines = existsSync(traceFile) ? readFileSync(traceFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
      const skipped = traceLines.some((l) => l.reason === "verified-unchanged");
      expect(skipped, "a gitignored proposal-path file that appeared since state.verified must not read as an unchanged tree").toBe(false);
      const ranOrBlocked = runsCount(dir) > 1 || (r.json && r.json.decision === "block");
      expect(ranOrBlocked, "the gate must not silently skip when a gitignored proposal-path file has newly appeared").toBe(true);
    });

    it("without git there is no head to fingerprint, so a green gate's tree is never trusted to skip a later Stop", () => {
      const dir = makeProject({ config: makeRunsConfig(10000), git: false });
      writeFileSync(join(dir, "a.ts"), "x");
      runHookScript("edit-loop", { tool_name: "Edit", tool_input: { file_path: "a.ts" } }, { dir });

      const r1 = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
      expect(r1.json).toBeNull();
      expect(runsCount(dir)).toBe(1);

      const r2 = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
      expect(r2.json).toBeNull();
      expect(runsCount(dir), "without git there is no fingerprint to trust, so a later Stop must run the commands again rather than skip").toBe(2);
    });

    it("the verified-unchanged skip still fires the context-window notice, exactly like the onlyIfEdited (nothing-changed) skip does", () => {
      const cfg = { ...makeRunsConfig(10000), contextWindow: { enabled: true, threshold: 80, repeatAfter: 5 } };
      const dir = makeEditedProject(cfg);
      const r1 = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir }); // green, records verified
      expect(r1.json).toBeNull();
      expect(runsCount(dir)).toBe(1);

      const statePath = join(dir, ".doug/.state/test-session.json");
      const state = JSON.parse(readFileSync(statePath, "utf8"));
      state.context = { pct: 85, at: Date.now() };
      writeFileSync(statePath, JSON.stringify(state));

      const r2 = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
      expect(r2.json, "the verified-unchanged skip must still return the context-window notice, not a bare allow").not.toBeNull();
      expect(r2.json.systemMessage).toContain("Context at 85%");
      expect(existsSync(join(dir, ".doug/anchor.md")), "the notice must still write .doug/anchor.md").toBe(true);
      expect(runsCount(dir), "the skip itself must still have happened: the commands must not have rerun").toBe(1);
    });

    it("the verified-unchanged skip resets stopBlocks/agentBlocks exactly like an ordinary green gate does", () => {
      const dir = makeEditedProject(makeRunsConfig(10000));
      const r1 = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir }); // green, records verified
      expect(r1.json).toBeNull();

      const statePath = join(dir, ".doug/.state/test-session.json");
      const state = JSON.parse(readFileSync(statePath, "utf8"));
      state.stopBlocks = 2;
      state.agentBlocks = { ag1: 2 };
      writeFileSync(statePath, JSON.stringify(state));

      const r2 = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir }); // nothing changed: skip
      expect(r2.json).toBeNull();
      const afterStop = JSON.parse(readFileSync(statePath, "utf8"));
      expect(afterStop.stopBlocks, "a verified-unchanged skip must reset stopBlocks to 0, exactly like an ordinary green Stop").toBe(0);

      const r3 = runHookScript("stop-gate", { hook_event_name: "SubagentStop", agent_id: "ag1", agent_type: "coder" }, { dir }); // nothing changed: skip
      expect(r3.json).toBeNull();
      const afterSub = JSON.parse(readFileSync(statePath, "utf8"));
      expect(afterSub.agentBlocks.ag1, "a verified-unchanged skip must reset that agent's agentBlocks entry to 0, exactly like an ordinary green SubagentStop").toBe(0);
    });
  });

  describe("case 3: only one gate runs the commands at a time per project, via .doug/.state/gate.lock", () => {
    it("3a: holds gate.lock ({pid, session, at}) while its commands run, and removes it when they finish", () => {
      const dir = makeEditedProject(makeLockSeenConfig(10000));
      runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
      const seenPath = join(dir, lockSeenRelpath);
      expect(existsSync(seenPath), "the gate's own command never saw .doug/.state/gate.lock while it ran").toBe(true);
      const seen = JSON.parse(readFileSync(seenPath, "utf8"));
      expect(typeof seen.pid).toBe("number");
      expect(seen.session).toBe("test-session");
      expect(typeof seen.at).toBe("number");
      expect(existsSync(lockPath(dir)), "the lock must be removed once the gate's commands finish").toBe(false);
    });

    it("3b: a lock whose pid is dead is stale, and is taken over rather than waited on", () => {
      const dir = makeEditedProject(makeLockSeenConfig(15000));
      mkdirSync(join(dir, ".doug/.state"), { recursive: true });
      // A pid that is certainly free right now.
      const deadPid = 2 ** 22 - 1;
      let free = false;
      try {
        process.kill(deadPid, 0);
      } catch {
        free = true;
      }
      expect(free, "the chosen pid must actually be free for this test to mean anything").toBe(true);
      writeFileSync(lockPath(dir), JSON.stringify({ pid: deadPid, session: "someone-else", at: Date.now() }));
      const started = Date.now();
      runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
      const elapsed = Date.now() - started;
      expect(elapsed, "a stale lock (dead pid) must be taken over at once, not waited out for the timeout").toBeLessThan(8000);
      const seenPath = join(dir, lockSeenRelpath);
      expect(existsSync(seenPath)).toBe(true);
      const seen = JSON.parse(readFileSync(seenPath, "utf8"));
      expect(seen.session, "the gate must take the lock over with its own pid/session, not just run past someone else's stale one").toBe("test-session");
    });

    it("3c: a live lock is waited for, then state is reloaded and the reloaded verified tree is applied", () => {
      const dir = makeEditedProject(makeRunsConfig(5000));

      // Obtain a real state.verified via one green Stop.
      runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
      const statePath = join(dir, ".doug/.state/test-session.json");
      const savedState = readFileSync(statePath, "utf8");
      const parsed = JSON.parse(savedState);
      expect(parsed.verified, "case 2's mechanism must record a verified tree first, for this case to test anything").toBeTruthy();
      const before = runsCount(dir);

      // Strip verified from the state on disk, so this gate — absent the wait-then-reload — would see none
      // and rerun; a holder process will restore it partway through, as a concurrent gate's own green Stop
      // would have.
      writeFileSync(statePath, JSON.stringify({ ...parsed, verified: undefined }));

      // Holder: sleeps ~1.2s, then restores the saved (verified) state and releases the lock, as if it were
      // another gate that had just finished a green run of the same session.
      mkdirSync(join(dir, ".doug/.state"), { recursive: true });
      const holderScript = join(dir, ".doug/.state/holder.mjs");
      writeFileSync(
        holderScript,
        [
          'import { writeFileSync, unlinkSync } from "node:fs";',
          "setTimeout(() => {",
          `  writeFileSync(${JSON.stringify(statePath)}, ${JSON.stringify(savedState)});`,
          `  try { unlinkSync(${JSON.stringify(lockPath(dir))}); } catch {}`,
          "}, 1200);",
        ].join("\n"),
      );
      const holder = spawn(process.execPath, [holderScript], { cwd: dir, stdio: "ignore" });
      writeFileSync(lockPath(dir), JSON.stringify({ pid: holder.pid, session: "holder-session", at: Date.now() }));

      try {
        const started = Date.now();
        const r = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
        const elapsed = Date.now() - started;
        expect(r.json, "once the wait ends the reloaded verified tree matches, so the gate must allow").toBeNull();
        expect(elapsed, "a live lock must actually be waited for, not run past immediately").toBeGreaterThanOrEqual(900);
        expect(runsCount(dir), "after waiting, the reloaded state.verified matches the tree, so the commands must not run again").toBe(before);
      } finally {
        try {
          process.kill(holder.pid, "SIGKILL");
        } catch {
          // already exited
        }
      }
    });

    it("3d: the wait on a live lock is bounded by stopGate.timeoutMs and never hangs", () => {
      const dir = makeEditedProject(makeRunsConfig(1000));
      mkdirSync(join(dir, ".doug/.state"), { recursive: true });
      const holderScript = join(dir, ".doug/.state/holder-long.mjs");
      writeFileSync(holderScript, "setTimeout(() => {}, 15000);"); // outlives the gate's own 1000ms timeout by far
      const holder = spawn(process.execPath, [holderScript], { cwd: dir, stdio: "ignore" });
      writeFileSync(lockPath(dir), JSON.stringify({ pid: holder.pid, session: "holder-session", at: Date.now() }));
      try {
        const started = Date.now();
        runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
        const elapsed = Date.now() - started;
        expect(elapsed, "a live lock must never be waited past stopGate.timeoutMs").toBeLessThan(8000);
        expect(elapsed, "the gate must actually have waited roughly timeoutMs, not returned immediately").toBeGreaterThanOrEqual(900);
        expect(runsCount(dir), "once the bound is hit the gate must proceed and run its own commands rather than give up silently").toBe(1);
        expect(existsSync(lockPath(dir)), "having taken the lock over past the bound, the gate must release it again once its own commands finish").toBe(false);
      } finally {
        try {
          process.kill(holder.pid, "SIGKILL");
        } catch {
          // already exited
        }
      }
    });

    // Second tester pass (reviewer-found gap): a lock file whose pid is not a real, checkable pid at all
    // (0, -1, a non-numeric value, or not even JSON) is garbage, not a live holder, and must be taken over
    // immediately rather than believed. process.kill(0, 0) and process.kill(-1, 0) do not throw (0 means "this
    // process's own group"; -1 broadcasts to every process the caller may signal), so a liveness check that
    // hands either straight to process.kill(pid, 0) reads them as live.
    for (const [label, lockContent] of [
      ["pid 0", JSON.stringify({ pid: 0, session: "x", at: Date.now() })],
      ["pid -1", JSON.stringify({ pid: -1, session: "x", at: Date.now() })],
      ['a non-numeric pid ("abc")', JSON.stringify({ pid: "abc", session: "x", at: Date.now() })],
      ["non-JSON text", "not json at all"],
    ]) {
      it(`a garbage lock (${label}) is stale and taken over immediately, not waited out for the timeout`, () => {
        const dir = makeEditedProject(makeRunsConfig(15000));
        mkdirSync(join(dir, ".doug/.state"), { recursive: true });
        writeFileSync(lockPath(dir), lockContent);
        const started = Date.now();
        runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
        const elapsed = Date.now() - started;
        expect(elapsed, `a garbage lock (${label}) must be taken over at once, not waited out for the timeout`).toBeLessThan(8000);
        expect(existsSync(lockPath(dir)), `after taking over a garbage lock (${label}), the gate must release its own lock once its commands finish`).toBe(false);
        expect(runsCount(dir), `taking over a garbage lock (${label}) must still let the gate's own commands run`).toBe(1);
      });
    }

    it("the wait bound on a live lock scales with the number of configured commands (timeoutMs x count), not a single flat timeoutMs", () => {
      const twoCommandConfig = {
        ...baseConfig,
        commands: {
          "test:unit": `${process.execPath} -e "require('fs').appendFileSync('${runsLogRelpath}','x')"`,
          "test:extra": `${process.execPath} -e "require('fs').appendFileSync('${runsLogRelpath}','y')"`,
        },
        stopGate: { commands: ["test:unit", "test:extra"], onlyIfEdited: true, maxBlocks: 3, timeoutMs: 600, requireEvidence: false },
        trace: { enabled: true },
      };
      const dir = makeEditedProject(twoCommandConfig);
      mkdirSync(join(dir, ".doug/.state"), { recursive: true });
      const holderScript = join(dir, ".doug/.state/holder-scale.mjs");
      writeFileSync(holderScript, "setTimeout(() => {}, 3000);"); // outlives even the scaled (600 x 2) bound
      const holder = spawn(process.execPath, [holderScript], { cwd: dir, stdio: "ignore" });
      writeFileSync(lockPath(dir), JSON.stringify({ pid: holder.pid, session: "holder-session", at: Date.now() }));
      try {
        const started = Date.now();
        const r = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
        const elapsed = Date.now() - started;
        expect(
          elapsed,
          "with two configured commands, the wait bound must scale to roughly timeoutMs x 2 (≈1.1s here), not a single flat timeoutMs (≈0.6s)",
        ).toBeGreaterThanOrEqual(1100);
        expect(r.status, "the gate must still return once the (scaled) bound is hit, never hang").toBe(0);
      } finally {
        try {
          process.kill(holder.pid, "SIGKILL");
        } catch {
          // already exited
        }
      }
    });
  });
});

// card stop-gate-lock-release-on-throw: an exception inside runVerification, after gate.lock is taken, still
// reaches runHook (lib/io.mjs), which fails open — but until this card, nothing released the lock on that
// path, leaving it behind for a reused pid or a slow platform to make a later gate wait on a lock nobody
// holds. The forced throw here is input-only: cfg.protectedPaths set to [42] (a valid array holding a
// non-string entry) makes matchAny's `raw.startsWith("!")` (lib/glob.mjs) throw "raw.startsWith is not a
// function" the first time scanTreeProblems' step-1 protected-paths check calls it
// (`changed.filter((f) => matchAny(cfg.protectedPaths, f) ...)`, stop-gate.mjs:965) — inside runVerification
// (called from stop-gate.mjs:1247), after gate.lock is already taken, and before any verification command
// runs. Card gates-config-shape-check, then gates-config-shape-all-arrays, normalise every array-typed
// DEFAULTS key (protectedPaths, proposalPaths, allowedOutsidePaths, bash.denyForcePushTo,
// secrets.placeholders, secrets.ignorePaths, stopGate.commands, stopGate.ignoreChangedPaths,
// stopGate.evidencePatterns, anchor) to its default when the value is not an array at all — but a
// wrong-typed entry INSIDE a valid array stays out of scope for that check (gates-config-shape-all-arrays.md's
// Rules), so an array like [42] still passes shape normalisation unchanged and still reaches this same throw.
// Confirmed through the real hook (a scratch copy of plugins/doug-gates, run via spawnSync exactly as
// runHookScript does, never the live plugin files): protectedPaths: [42] throws with the stack
// `matchAny (lib/glob.mjs:78) -> stop-gate.mjs:965 (scanTreeProblems step 1) -> runVerification
// (stop-gate.mjs:1247) -> stop-gate.mjs:1421 -> io.mjs runHook`, after the lock-acquire block above it (L1);
// with the exit handler's `releaseLock()` call removed (the same mutation the reviewer names), gate.lock is
// left behind (probe: "lock exists after: true"), so L1 actually goes red on that mutation. proposalPaths is
// the wrong key for this: cfg.proposalPaths is walked once already, on the FIRST Stop, at stop-gate.mjs:876
// (`walkProposalPathFiles(dir, cfg.proposalPaths)`, the baseline capture) — well before gate.lock is ever
// taken — so `proposalPaths: [42]` (this describe's original forced throw, and an earlier revision of this
// comment) throws inside `fixedPrefix` (lib/baseline.mjs:105) via that walk, and the same probe with that
// mutation applied still shows "lock exists after: false": the lock was never taken, so removing
// `releaseLock()` changes nothing and L1 would not have pinned the release-on-throw behaviour at all. L3 below
// reaches the same protectedPaths throw on the SubagentStop reviewer-skip path (lockOwned never set true, the
// same probe there also confirms the live holder's lock file is left byte-for-byte unchanged).
describe("card stop-gate-lock-release-on-throw", () => {
  const lockPath = (dir) => join(dir, ".doug/.state/gate.lock");

  // Same dirty-project shape as makeEditedProject above (this describe sits outside that one's scope), plus
  // whatever config the case needs.
  function makeDirtyProject(config) {
    const dir = makeProject({ config, git: true });
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src/a.ts"), "base");
    execFileSync("git", ["add", "-A"], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", "base"], { cwd: dir });
    writeFileSync(join(dir, "src/a.ts"), "edited this session");
    runHookScript("edit-loop", { tool_name: "Edit", tool_input: { file_path: "src/a.ts" } }, { dir });
    return dir;
  }

  const throwConfig = {
    ...baseConfig,
    protectedPaths: [42],
    commands: { test: `${process.execPath} -e "process.exit(0)"` },
    stopGate: { commands: ["test"], onlyIfEdited: true, maxBlocks: 3, timeoutMs: 10000, requireEvidence: false },
  };

  it("L1 (red at HEAD): a forced throw after gate.lock is taken still fails open, and now releases the lock", () => {
    const dir = makeDirtyProject(throwConfig);
    const r = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
    // The fail-open decision itself is unchanged by this card (a hook reader must never throw).
    expect(r.status).toBe(0);
    expect(
      r.json && r.json.systemMessage,
      `expected a "hook error, failing open" systemMessage; got ${JSON.stringify(r.json)}, stderr=${r.stderr}`,
    ).toMatch(/hook error, failing open/);
    // The bug this card fixes: at HEAD, gate.lock is left behind here.
    expect(existsSync(lockPath(dir)), "gate.lock must not be left behind once the hook has failed open").toBe(false);
  });

  it("L2 (guard, green at HEAD): an ordinary run with no throw still removes the lock", () => {
    const dir = makeDirtyProject(baseConfig);
    const r = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
    expect(r.status).toBe(0);
    expect(existsSync(lockPath(dir)), "an ordinary green gate must still release the lock through the existing wrappers").toBe(false);
  });

  it("L3 (guard): a forced throw in a gate that never owned the lock leaves another live holder's lock untouched", () => {
    // agent_type "reviewer" is in READ_ONLY_AGENT_TYPES (agentMadeNoChanges), so this SubagentStop's own
    // agent counts as having made no changes: skipVerification is true, the whole gate.lock acquire section
    // (guarded by `if (!skipVerification)`) never runs, and lockOwned stays false all the way into
    // runVerification, which still throws at the same protected-paths check (scanTreeProblems is called
    // unconditionally from runVerification, regardless of skipVerification). This is the one shape that
    // reaches the throw point without this gate ever touching the lock at all.
    const dir = makeDirtyProject(throwConfig);
    mkdirSync(join(dir, ".doug/.state"), { recursive: true });
    const holderScript = join(dir, ".doug/.state/holder-throw.mjs");
    writeFileSync(holderScript, "setTimeout(() => {}, 15000);");
    const holder = spawn(process.execPath, [holderScript], { cwd: dir, stdio: "ignore" });
    const lockContent = JSON.stringify({ pid: holder.pid, session: "holder-session", at: Date.now() });
    writeFileSync(lockPath(dir), lockContent);
    try {
      const r = runHookScript("stop-gate", { hook_event_name: "SubagentStop", agent_id: "ag1", agent_type: "reviewer" }, { dir });
      expect(r.status).toBe(0);
      expect(r.json && r.json.systemMessage, `expected a "hook error, failing open" systemMessage; got ${JSON.stringify(r.json)}`).toMatch(/hook error, failing open/);
      expect(
        readFileSync(lockPath(dir), "utf8"),
        "a gate that never owned the lock must never remove or alter another live holder's lock file",
      ).toBe(lockContent);
    } finally {
      try {
        process.kill(holder.pid, "SIGKILL");
      } catch {
        // already exited
      }
    }
  });
});

// card stop-gate-lock-release-pins: found by the reviewer's two coverage minors (M2b and M5) on card
// stop-gate-lock-release-on-throw (4ef4903) — nothing pinned that releaseLock's pid comparison actually
// matters (dropping it left the whole file green), and nothing pinned that the *Releasing wrappers release
// the lock themselves rather than relying solely on the process.on("exit", ...) handler (stripping
// releaseLock() out of allowReleasing/blockStopReleasing/systemMessageReleasing also left the whole file
// green). Tests only, no production change.
describe("card stop-gate-lock-release-pins", () => {
  const lockRelpath = ".doug/.state/gate.lock";
  const lockWrittenRelpath = ".doug/.state/lock-written.json";
  const lockPath = (dir) => join(dir, lockRelpath);

  // Same dirty-project shape used by the neighboring "card stop-gate-lock-release-on-throw" describe (that
  // describe's own makeDirtyProject is out of scope here).
  function makeDirtyProject(config) {
    const dir = makeProject({ config, git: true });
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src/a.ts"), "base");
    execFileSync("git", ["add", "-A"], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", "base"], { cwd: dir });
    writeFileSync(join(dir, "src/a.ts"), "edited this session");
    runHookScript("edit-loop", { tool_name: "Edit", tool_input: { file_path: "src/a.ts" } }, { dir });
    return dir;
  }

  // P1 (reviewer's R1 shape): a verification command overwrites gate.lock with {pid: <another live pid>,
  // session, at} while it runs, then exits 1. releaseLock's pid comparison (`lock.pid === process.pid`) must
  // see a foreign pid and leave the file alone; without that comparison (M1: keep only `if (!lockOwned)
  // return`), releaseLock would unlink it regardless of who owns it now, and this test would fail because
  // gate.lock would be gone instead of byte-identical to what the command wrote.
  it("P1: a verification command that overwrites gate.lock with another live pid still leaves it untouched, byte-identical, and the gate still blocks", () => {
    let holder;
    try {
      // A real, live pid this test does not own but can prove is alive and can clean up.
      holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
      const foreignPid = holder.pid;
      const command =
        `${process.execPath} -e "const fs=require('fs'); ` +
        `const c=JSON.stringify({pid:${foreignPid},session:'foreign-session',at:Date.now()}); ` +
        `fs.writeFileSync('${lockRelpath}', c); ` +
        `fs.copyFileSync('${lockRelpath}','${lockWrittenRelpath}'); ` +
        `process.exit(1)"`;
      const dir = makeDirtyProject({
        ...baseConfig,
        commands: { test: command },
        stopGate: { commands: ["test"], onlyIfEdited: true, maxBlocks: 3, timeoutMs: 10000, requireEvidence: false },
      });
      const r = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
      expect(r.json && r.json.decision, "a failing verification command must still block the stop").toBe("block");
      expect(existsSync(lockPath(dir)), "gate.lock must still exist: it was overwritten by a live foreign pid, not this gate's own").toBe(true);
      const writtenPath = join(dir, lockWrittenRelpath);
      expect(existsSync(writtenPath), "the command's own copy of what it wrote must exist for this test to mean anything").toBe(true);
      expect(
        readFileSync(lockPath(dir), "utf8"),
        "gate.lock must be byte-identical to what the command wrote: releaseLock must never touch a lock file whose pid is not this process's own",
      ).toBe(readFileSync(writtenPath, "utf8"));
    } finally {
      if (holder) {
        try {
          process.kill(holder.pid, "SIGKILL");
        } catch {
          // already exited
        }
      }
    }
  });

  // P2 (the wrappers' own release, not just the exit handler): on a normal path that actually emits stdout
  // JSON (allow() emits nothing at all, so this needs a path through blockStop — a failing verification
  // command), gate.lock must already be gone by the moment the hook's stdout JSON arrives at an outside
  // reader, not merely by the time the process has exited. The wrappers call releaseLock() before emit()
  // (lib/io.mjs's blockStop writes stdout then calls process.exit(0)); with that call stripped from
  // blockStopReleasing (M2), the process.on("exit", ...) handler would still release the lock, but only
  // after emit() has already written to stdout — reversing the order this test observes. Verified
  // empirically against both HEAD and a scratch copy with M2 applied (never against the real production
  // file, and never committed): on this platform, HEAD showed the lock already gone at the first stdout
  // chunk 70/70 runs, and the M2 mutant showed it still present 70/70 runs — fully deterministic and
  // discriminating in both directions here, because unlinkSync (a blocking syscall) either strictly precedes
  // or strictly follows the stdout write in the child's own program order, and that order is what this test
  // observes.
  it("P2: gate.lock is already gone the moment the hook's stdout JSON arrives, not only after the process has exited", async () => {
    const command = `${process.execPath} -e "process.exit(1)"`;
    const dir = makeDirtyProject({
      ...baseConfig,
      commands: { test: command },
      stopGate: { commands: ["test"], onlyIfEdited: true, maxBlocks: 3, timeoutMs: 10000, requireEvidence: false },
    });
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [join(scriptsDir, "stop-gate.mjs")], {
        cwd: dir,
        env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let lockGoneAtFirstData = null;
      let out = "";
      child.stdout.on("data", (chunk) => {
        out += chunk.toString();
        if (lockGoneAtFirstData === null) {
          // Checked synchronously, in the same tick the first byte of stdout arrives — before anything else
          // this test does can run.
          lockGoneAtFirstData = !existsSync(lockPath(dir));
        }
      });
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, out, lockGoneAtFirstData }));
      child.stdin.write(JSON.stringify({ session_id: "test-session", cwd: dir, hook_event_name: "Stop" }));
      child.stdin.end();
    });
    const line = result.out.trim().split("\n").filter(Boolean).pop();
    const json = line ? JSON.parse(line) : null;
    expect(json && json.decision, "the hook must actually have reached the blockStopReleasing path for this test to mean anything").toBe("block");
    expect(
      result.lockGoneAtFirstData,
      "gate.lock must already be gone by the time the hook's stdout JSON reaches an outside reader",
    ).toBe(true);
  });

  // P3 (same observation as P2, a different path to systemMessageReleasing): the counter-cap stand-down at
  // the top of runVerification (`blocksSoFar >= maxBlocks`) is reached only after the gate has already
  // acquired gate.lock — writeGateLock runs unconditionally for the main Stop (skipVerification is only ever
  // true for a SubagentStop) just above runVerification's own definition, and a fresh project with no
  // existing lock file always succeeds at it. Seeded exactly like the neighboring "stood-down: a stand-down
  // at the counter cap ..." test (case 3 describe, baseConfig.stopGate.maxBlocks 3): a session already
  // blocked 3 times stands down on this Stop before any command runs, past the lock acquisition earlier in
  // the file. With releaseLock() stripped from systemMessageReleasing (M2), the exit handler would still
  // release the lock, but only after emit() has already written stdout — reversing the order this test
  // observes, exactly like P2's reasoning for blockStopReleasing. (allow() emits no stdout at all — see
  // io.mjs — so the green allow path gives an outside reader nothing to observe here, and stays unpinned by
  // design.)
  it("P3: gate.lock is already gone the moment the counter-cap stand-down's systemMessage JSON arrives, not only after the process has exited", async () => {
    const dir = makeDirtyProject({
      ...baseConfig,
      commands: { test: "exit 1" },
      stopGate: { commands: ["test"], onlyIfEdited: true, maxBlocks: 3, timeoutMs: 10000, requireEvidence: false },
    });
    mkdirSync(join(dir, ".doug/.state"), { recursive: true });
    // Already at the cap before this Stop even runs, so runVerification's first check stands down at once.
    writeFileSync(join(dir, ".doug/.state/test-session.json"), JSON.stringify({ stopBlocks: 3 }));
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [join(scriptsDir, "stop-gate.mjs")], {
        cwd: dir,
        env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let lockGoneAtFirstData = null;
      let out = "";
      child.stdout.on("data", (chunk) => {
        out += chunk.toString();
        if (lockGoneAtFirstData === null) {
          // Checked synchronously, in the same tick the first byte of stdout arrives — before anything else
          // this test does can run.
          lockGoneAtFirstData = !existsSync(lockPath(dir));
        }
      });
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, out, lockGoneAtFirstData }));
      child.stdin.write(JSON.stringify({ session_id: "test-session", cwd: dir, hook_event_name: "Stop" }));
      child.stdin.end();
    });
    const line = result.out.trim().split("\n").filter(Boolean).pop();
    const json = line ? JSON.parse(line) : null;
    expect(
      json && json.systemMessage,
      "the hook must actually have reached the counter-cap stand-down inside runVerification for this test to mean anything",
    ).toContain("standing down");
    expect(
      result.lockGoneAtFirstData,
      "gate.lock must already be gone by the time the stand-down's systemMessage JSON reaches an outside reader",
    ).toBe(true);
  });
});

// card stop-gate-budget-under-hook-timeout: the platform kills the Stop/SubagentStop hook itself at its own
// `timeout` (hooks.json/settings.json: 600s), and a timed-out hook is cancelled, fails open, and its output is
// discarded (research note: docs/en/hooks — "Claude Code cancels it and treats it as a failed hook", "A timed-out
// hook doesn't block the action", "Output is discarded"). Case 3's scaled wait bound (stopGate.timeoutMs x
// command count, above) can itself exceed that platform timeout, so a waiter riding it out — or a holder whose
// commands both run to their own timeoutMs — can be killed by the platform mid-command: an ungated stop, and
// any block message it printed is lost. stopGate.hookTimeoutSec (new config key, must equal the stop-gate
// hook's declared `timeout`) bounds the whole gate — wait plus commands, with a margin — under that platform
// timeout: a waiter that would outrun the budget refuses the stop instead of taking over past it, a lock older
// than the budget is stale regardless of a live pid, and a holder drops (never starts) a command that cannot
// fit in what is left, naming it in the block message, rather than let the platform cut it off mid-run.
// Fixture `hookTimeoutSec` values are small (2) so these stay fast to run once the mechanism exists.
describe("card stop-gate-budget-under-hook-timeout", () => {
  const runsLogRelpath = ".doug/.state/runs.log";
  const lockRelpath = ".doug/.state/gate.lock";
  const runsLogPath = (dir) => join(dir, runsLogRelpath);
  const runsCount = (dir) => (existsSync(runsLogPath(dir)) ? readFileSync(runsLogPath(dir), "utf8").length : 0);
  const lockPath = (dir) => join(dir, lockRelpath);
  const appendCommand = (relpath) => `${process.execPath} -e "require('fs').appendFileSync('${relpath}','x')"`;
  const sleepCommand = (ms) => `${process.execPath} -e "setTimeout(() => {}, ${ms})"`;

  // Same shape as case 2/3's own makeEditedProject just above: a git repo, a base commit, then one file this
  // session edited, so onlyIfEdited's anyChange is true and the gate reaches the lock/verification steps
  // instead of exiting early on nothing-changed.
  function makeEditedProject(config) {
    const dir = makeProject({ config, git: true });
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src/a.ts"), "base");
    execFileSync("git", ["add", "-A"], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", "base"], { cwd: dir });
    writeFileSync(join(dir, "src/a.ts"), "edited this session");
    runHookScript("edit-loop", { tool_name: "Edit", tool_input: { file_path: "src/a.ts" } }, { dir });
    return dir;
  }

  // A node process that stays alive for `ms` before exiting on its own — a "live" lock pid the gate must
  // treat as a real holder, not a dead or garbage one.
  function spawnHolder(dir, ms) {
    mkdirSync(join(dir, ".doug/.state"), { recursive: true });
    const script = join(dir, `.doug/.state/holder-${Math.random().toString(36).slice(2)}.mjs`);
    writeFileSync(script, `setTimeout(() => {}, ${ms});`);
    return spawn(process.execPath, [script], { cwd: dir, stdio: "ignore" });
  }

  it("B1: a live lock still held when the hook-timeout budget runs out refuses the stop instead of taking over", () => {
    const dir = makeEditedProject({
      ...baseConfig,
      commands: { "test:unit": appendCommand(runsLogRelpath) },
      // R3 (fix pass, flake): hookTimeoutSec: 2 gave a margin of only 200ms between the refusal deadline
      // and the lock's own stale-by-age threshold (hookTimeoutMs), so a slow spawn under load could cross
      // staleness first and take the lock over instead of refusing. hookTimeoutSec: 3 (margin 300ms) keeps
      // the same assertions with more room; nothing this test checks changed.
      stopGate: { commands: ["test:unit"], onlyIfEdited: true, maxBlocks: 3, timeoutMs: 10000, hookTimeoutSec: 3, requireEvidence: false },
      trace: { enabled: true },
    });
    const holder = spawnHolder(dir, 12000); // outlives both the hook-timeout budget and stopGate.timeoutMs's old scaled bound
    writeFileSync(lockPath(dir), JSON.stringify({ pid: holder.pid, session: "holder-session", at: Date.now() }));
    try {
      const started = Date.now();
      const r = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
      const elapsed = Date.now() - started;
      expect(
        elapsed,
        "hookTimeoutSec: 3 must cut the wait off under the hook's own timeout, not ride stopGate.timeoutMs's scaled bound (10s here) out",
      ).toBeLessThan(4000);
      expect(r.json && r.json.decision, "a waiter that would outrun the hook's own timeout must refuse (block) the stop, never allow it").toBe("block");
      expect(r.json.reason, "the refusal must name the session still holding the lock").toContain("holder-session");
      expect(runsCount(dir), "a refused waiter must never run its own commands").toBe(0);
      expect(existsSync(lockPath(dir)), "a refused waiter must leave the holder's lock in place, not take it over").toBe(true);
      const lock = JSON.parse(readFileSync(lockPath(dir), "utf8"));
      expect(lock.session, "the lock on disk must still belong to the original holder").toBe("holder-session");
    } finally {
      try {
        process.kill(holder.pid, "SIGKILL");
      } catch {
        // already exited
      }
    }
  });

  it("B2: a live lock older than the hook-timeout budget is stale by age and is taken over at once, not waited on", () => {
    const dir = makeEditedProject({
      ...baseConfig,
      commands: { "test:unit": appendCommand(runsLogRelpath) },
      stopGate: { commands: ["test:unit"], onlyIfEdited: true, maxBlocks: 3, timeoutMs: 15000, hookTimeoutSec: 20, requireEvidence: false },
      trace: { enabled: true },
    });
    const holder = spawnHolder(dir, 25000); // pid stays live throughout; only its lock's age must make it stale
    writeFileSync(lockPath(dir), JSON.stringify({ pid: holder.pid, session: "holder-session", at: Date.now() - 60_000 }));
    try {
      const started = Date.now();
      runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
      const elapsed = Date.now() - started;
      expect(
        elapsed,
        "a lock whose age (60s) already exceeds the hook-timeout budget (20s) is stale even with a live pid — no legitimate holder could still be running — and must be taken over at once",
      ).toBeLessThan(8000);
      expect(runsCount(dir), "having taken the stale-by-age lock over, the gate must run its own command").toBe(1);
      expect(existsSync(lockPath(dir)), "the gate must release the lock again once its own command finishes").toBe(false);
    } finally {
      try {
        process.kill(holder.pid, "SIGKILL");
      } catch {
        // already exited
      }
    }
  });

  it("B3: a command is clamped to what's left of the hook-timeout budget, timing out and blocking rather than running to its own timeoutMs", () => {
    const dir = makeEditedProject({
      ...baseConfig,
      commands: { slow: sleepCommand(10000) },
      stopGate: { commands: ["slow"], onlyIfEdited: true, maxBlocks: 3, timeoutMs: 60000, hookTimeoutSec: 2, requireEvidence: false },
      trace: { enabled: true },
    });
    const started = Date.now();
    const r = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
    const elapsed = Date.now() - started;
    expect(
      elapsed,
      "the command's own timeoutMs (60s) must be clamped to what's left of the hook-timeout budget (2s) so it cannot run anywhere near its configured timeout",
    ).toBeLessThan(3000);
    expect(r.json && r.json.decision, "a command cut off by the budget must block, not pass").toBe("block");
    expect(r.json.reason.toLowerCase()).toContain("timed out");
  });

  it("B4: a second command that cannot fit before the hook-timeout budget runs out is dropped, named 'not run', and never started", () => {
    const secondCommand = appendCommand(runsLogRelpath);
    const dir = makeEditedProject({
      ...baseConfig,
      commands: { slow: sleepCommand(10000), second: secondCommand },
      stopGate: { commands: ["slow", "second"], onlyIfEdited: true, maxBlocks: 3, timeoutMs: 60000, hookTimeoutSec: 2, requireEvidence: false },
      trace: { enabled: true },
    });
    const r = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
    expect(runsCount(dir), "the second command must never run once the first has used up the hook-timeout budget").toBe(0);
    expect(r.json && r.json.decision, "a dropped command must still block the stop").toBe("block");
    const idx = r.json.reason.indexOf(secondCommand);
    expect(idx, `the block reason must name the dropped command:\n${r.json.reason}`).toBeGreaterThanOrEqual(0);
    expect(r.json.reason.slice(idx), "'not run' must follow the named dropped command").toContain("not run");
    expect(r.json.reason.toLowerCase(), "the reason must say why: the hook's own budget ran out before the command could start").toContain("budget");
  });

  // Pass 2 (reviewer findings R1/R2, 2026-09-16): T1-T5 below pin the fixes and the mechanisms the reviewer's
  // surviving mutations found untested. T1 mirrors the tests-red-by-design section's own setup (a SubagentStop
  // from agent_type tester with a tests_red_by_design claim), so it lives here rather than nested there.
  const claim = (files) => JSON.stringify({ tests_red_by_design: files });

  it("T1 (R1): a claim covering only command 1's failure does not also excuse command 2 being dropped for budget: the gate still blocks, naming command 2 as not run", () => {
    const secondCommand = appendCommand(runsLogRelpath);
    // "first" prints its FAIL line immediately, then sleeps far longer than any possible budget, so it is
    // always killed right at whatever budget remained when it started - leaving ~0 (or less) for "second"
    // regardless of how much the surrounding harness overhead varies. This makes the drop deterministic
    // without pinning a fragile pair of sleep/budget numbers against each other.
    const firstCommand = `echo ' FAIL  tests/a.test.mjs > it'; ${sleepCommand(30000)}`;
    const dir = makeEditedProject({
      ...baseConfig,
      commands: { first: firstCommand, second: secondCommand },
      stopGate: { commands: ["first", "second"], onlyIfEdited: true, maxBlocks: 3, timeoutMs: 60000, hookTimeoutSec: 3, requireEvidence: false },
    });
    mkdirSync(join(dir, "tests"));
    writeFileSync(join(dir, "tests/a.test.mjs"), "it fails on purpose");
    const input = {
      hook_event_name: "SubagentStop",
      agent_id: "ag1",
      agent_type: "tester",
      last_assistant_message: `Ran the tests; command 1 is red as designed.\n${claim(["tests/a.test.mjs"])}`,
    };
    const r = runHookScript("stop-gate", input, { dir });
    expect(runsCount(dir), "the second command must never run once command 1 used up the hook-timeout budget").toBe(0);
    expect(
      r.json && r.json.decision,
      "a claim that covers command 1's failure must not also cover a command dropped for budget: that part of verification never ran, so the gate must still block",
    ).toBe("block");
    expect(r.json.reason, "the pass-1 red-by-design systemMessage must not appear here").not.toContain("red by design");
    const idx = r.json.reason.indexOf(secondCommand);
    expect(idx, `the block reason must name the dropped command:\n${r.json.reason}`).toBeGreaterThanOrEqual(0);
    expect(r.json.reason.slice(idx)).toContain("not run");
  });

  it('T2 (A5): a garbage hookTimeoutSec ("abc", -1, 0) behaves as the platform default 600, never a fail-open', () => {
    for (const hookTimeoutSec of ["abc", -1, 0]) {
      const dir = makeEditedProject({
        ...baseConfig,
        commands: { test: "echo ' FAIL  tests/a.test.mjs > it'; exit 1" },
        stopGate: { commands: ["test"], onlyIfEdited: true, maxBlocks: 3, timeoutMs: 10000, hookTimeoutSec, requireEvidence: false },
      });
      const r = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
      expect(r.json && r.json.decision, `hookTimeoutSec ${JSON.stringify(hookTimeoutSec)} must read as 600 and still run the command, never fail open`).toBe("block");
      expect(r.json.reason).toContain("FAIL");
    }
  });

  it("T3 (A6): a live-pid lock with no `at`, or a non-numeric `at`, is not stale by age: it is waited for and refused like any other live lock", () => {
    for (const lockExtra of [{}, { at: "not-a-number" }]) {
      const dir = makeEditedProject({
        ...baseConfig,
        commands: { "test:unit": appendCommand(runsLogRelpath) },
        stopGate: { commands: ["test:unit"], onlyIfEdited: true, maxBlocks: 3, timeoutMs: 10000, hookTimeoutSec: 3, requireEvidence: false },
      });
      const holder = spawnHolder(dir, 12000);
      writeFileSync(lockPath(dir), JSON.stringify({ pid: holder.pid, session: "holder-session", ...lockExtra }));
      try {
        const started = Date.now();
        const r = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
        const elapsed = Date.now() - started;
        expect(
          elapsed,
          `a live-pid lock with ${JSON.stringify(lockExtra)} for \`at\` must be waited on for the hook-timeout budget, not treated as stale by age`,
        ).toBeGreaterThan(1500);
        expect(elapsed).toBeLessThan(4500);
        expect(r.json && r.json.decision, "it must be refused (blocked), never taken over").toBe("block");
        expect(r.json.reason).toContain("holder-session");
        expect(existsSync(lockPath(dir)), "a refused waiter must leave the holder's lock in place").toBe(true);
      } finally {
        try {
          process.kill(holder.pid, "SIGKILL");
        } catch {
          // already exited
        }
      }
    }
  });

  it("T4 (A3/A4): a refusal counts against maxBlocks like any other block, and maxBlocks caps it with the standing-down systemMessage", () => {
    const commonStopGate = { commands: ["test:unit"], onlyIfEdited: true, timeoutMs: 10000, hookTimeoutSec: 3, requireEvidence: false };

    // Two refusals in the same session count up: (1/3), then (2/3). The lock's `at` is refreshed to "now"
    // right before each call: a real holder's own `at` never moves, so one refusal already spends most of
    // lockStaleByAge's budget (hookTimeoutMs) off the original write, and a second full wait-then-refuse
    // cycle against that same stale timestamp would legitimately (and correctly) find the lock stale by
    // age instead of live - taking it over rather than refusing again. Refreshing `at` simulates a holder
    // that is still genuinely within its own hook-timeout window at the moment of each check, which is what
    // "another gate is still running the verification commands" means here, without weakening B2/T3's own
    // coverage of the stale-by-age path itself.
    {
      const dir = makeEditedProject({ ...baseConfig, commands: { "test:unit": appendCommand(runsLogRelpath) }, stopGate: { ...commonStopGate, maxBlocks: 3 } });
      const holder = spawnHolder(dir, 20000);
      try {
        writeFileSync(lockPath(dir), JSON.stringify({ pid: holder.pid, session: "holder-session", at: Date.now() }));
        const r1 = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
        expect(r1.json && r1.json.decision).toBe("block");
        expect(r1.json.reason).toContain("(1/3)");
        writeFileSync(lockPath(dir), JSON.stringify({ pid: holder.pid, session: "holder-session", at: Date.now() }));
        const r2 = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
        expect(r2.json && r2.json.decision).toBe("block");
        expect(r2.json.reason).toContain("(2/3)");
      } finally {
        try {
          process.kill(holder.pid, "SIGKILL");
        } catch {
          // already exited
        }
      }
    }

    // With maxBlocks: 1, the second refusal stands down instead of blocking again.
    {
      const dir = makeEditedProject({ ...baseConfig, commands: { "test:unit": appendCommand(runsLogRelpath) }, stopGate: { ...commonStopGate, maxBlocks: 1 } });
      const holder = spawnHolder(dir, 20000);
      try {
        writeFileSync(lockPath(dir), JSON.stringify({ pid: holder.pid, session: "holder-session", at: Date.now() }));
        const r1 = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
        expect(r1.json && r1.json.decision).toBe("block");
        writeFileSync(lockPath(dir), JSON.stringify({ pid: holder.pid, session: "holder-session", at: Date.now() }));
        const r2 = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
        expect(r2.json && r2.json.decision, "the second refusal must stand down, not block again").toBeUndefined();
        expect(r2.json.systemMessage).toContain("standing down");
      } finally {
        try {
          process.kill(holder.pid, "SIGKILL");
        } catch {
          // already exited
        }
      }
    }
  });

  it("T5 (R2): timeoutMs: 0 does not bypass the hook-timeout budget: the command is still clamped and the gate blocks in time", () => {
    const dir = makeEditedProject({
      ...baseConfig,
      commands: { slow: sleepCommand(10000) },
      stopGate: { commands: ["slow"], onlyIfEdited: true, maxBlocks: 3, timeoutMs: 0, hookTimeoutSec: 2, requireEvidence: false },
    });
    const started = Date.now();
    const r = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
    const elapsed = Date.now() - started;
    expect(
      elapsed,
      "timeoutMs: 0 must not let the command run unclamped to its natural length (10s); it must still be cut to what's left of the hook-timeout budget",
    ).toBeLessThan(3000);
    expect(r.json && r.json.decision, "a command cut off by the budget must block, not pass").toBe("block");
    expect(r.json.reason.toLowerCase()).toContain("timed out");
  });
});

// card stop-gate-timeout-normalise: reviewer findings on stop-gate-budget-under-hook-timeout (0efee81), pass 2
// minors. (1) A fractional stopGate.timeoutMs between 0 and 1 (e.g. 0.5) passes the finite-positive check, floors
// to 0, and spawnSync reads a timeout of 0 as none — the command then runs past the hook-timeout budget instead
// of being clamped. (2) Nothing pinned the Math.floor itself: a fractional timeoutMs such as 2.5 must still floor
// and clamp, not reach spawnSync un-floored. (3) Nothing pinned a lock that is fresh when the wait begins but
// goes stale by age partway through it: it must be taken over once it ages out, not refused.
describe("card stop-gate-timeout-normalise", () => {
  const runsLogRelpath = ".doug/.state/runs.log";
  const lockRelpath = ".doug/.state/gate.lock";
  const runsLogPath = (dir) => join(dir, runsLogRelpath);
  const runsCount = (dir) => (existsSync(runsLogPath(dir)) ? readFileSync(runsLogPath(dir), "utf8").length : 0);
  const lockPath = (dir) => join(dir, lockRelpath);
  const appendCommand = (relpath) => `${process.execPath} -e "require('fs').appendFileSync('${relpath}','x')"`;
  const sleepCommand = (ms) => `${process.execPath} -e "setTimeout(() => {}, ${ms})"`;

  function makeEditedProject(config) {
    const dir = makeProject({ config, git: true });
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src/a.ts"), "base");
    execFileSync("git", ["add", "-A"], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", "base"], { cwd: dir });
    writeFileSync(join(dir, "src/a.ts"), "edited this session");
    runHookScript("edit-loop", { tool_name: "Edit", tool_input: { file_path: "src/a.ts" } }, { dir });
    return dir;
  }

  function spawnHolder(dir, ms) {
    mkdirSync(join(dir, ".doug/.state"), { recursive: true });
    const script = join(dir, `.doug/.state/holder-${Math.random().toString(36).slice(2)}.mjs`);
    writeFileSync(script, `setTimeout(() => {}, ${ms});`);
    return spawn(process.execPath, [script], { cwd: dir, stdio: "ignore" });
  }

  it("T1: a fractional timeoutMs below 1 (0.5) is clamped to at least 1ms, not floored to 0 (which spawnSync reads as no timeout)", () => {
    const dir = makeEditedProject({
      ...baseConfig,
      commands: { slow: sleepCommand(5000) },
      stopGate: { commands: ["slow"], onlyIfEdited: true, maxBlocks: 3, timeoutMs: 0.5, hookTimeoutSec: 2, requireEvidence: false },
    });
    const started = Date.now();
    const r = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
    const elapsed = Date.now() - started;
    expect(
      elapsed,
      "timeoutMs: 0.5 must not floor to 0 (spawnSync treats 0 as no timeout, letting the 5s command run to completion past the budget); it must clamp to at least 1ms and the gate must still block in time",
    ).toBeLessThan(3000);
    expect(r.json && r.json.decision, "a command that ran unclamped past the budget must not be allowed to pass").toBe("block");
  });

  it("T2: a fractional timeoutMs above 1 (2.5) still floors and clamps, never reaching spawnSync un-floored", () => {
    const dir = makeEditedProject({
      ...baseConfig,
      commands: { slow: sleepCommand(5000) },
      stopGate: { commands: ["slow"], onlyIfEdited: true, maxBlocks: 3, timeoutMs: 2.5, hookTimeoutSec: 2, requireEvidence: false },
    });
    const started = Date.now();
    const r = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
    const elapsed = Date.now() - started;
    expect(elapsed, "timeoutMs: 2.5 must floor and clamp the command's timeout, cutting it off well under its 5s natural length").toBeLessThan(3000);
    expect(r.json && r.json.decision, "a fractional timeoutMs must never make the gate fail open (no decision) or pass unverified").toBe("block");
  });

  it("T3: a lock fresh when the wait begins but stale by age before the refusal deadline is taken over mid-wait, not refused", () => {
    const dir = makeEditedProject({
      ...baseConfig,
      commands: { "test:unit": appendCommand(runsLogRelpath) },
      stopGate: { commands: ["test:unit"], onlyIfEdited: true, maxBlocks: 3, timeoutMs: 10000, hookTimeoutSec: 3, requireEvidence: false },
    });
    // hookTimeoutSec: 3 => hookTimeoutMs 3000 (the stale-by-age threshold) and a refusal deadline ~2700ms after
    // gate start (marginMs 300). at: now - 2000 is fresh at the start (2000 < 3000) but ages past 3000 about 1s
    // into the wait — well before the 2700ms refusal deadline — so a correct gate takes it over mid-wait.
    const holder = spawnHolder(dir, 12000);
    writeFileSync(lockPath(dir), JSON.stringify({ pid: holder.pid, session: "holder-session", at: Date.now() - 2000 }));
    try {
      const r = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
      const refused = !!(r.json && r.json.reason && r.json.reason.includes("ran out while waiting"));
      expect(
        refused,
        `a lock that ages out mid-wait must be taken over, not refused as though it were still live for the whole budget (got: ${JSON.stringify(r.json)})`,
      ).toBe(false);
      expect(runsCount(dir), "having taken the lock over once it aged out, the gate must run its own command").toBe(1);
      expect(existsSync(lockPath(dir)), "the gate must release the lock again once its own command finishes").toBe(false);
    } finally {
      try {
        process.kill(holder.pid, "SIGKILL");
      } catch {
        // already exited
      }
    }
  });
});

// card stop-gate-read-only-subagent-skip: the other half of the 2026-09-16 process storm — a researcher (or
// other read-only-by-policy agent) that edited nothing still ran the full verification suite at its own
// SubagentStop, then obeyed the resulting block by rerunning the suite itself. A SubagentStop whose agent made
// no change (per the run trace, or per its agent_type when the trace cannot vouch for it) skips step 3's
// commands and step 3b's evidence check; steps 1, 1 (committed), 1b, and 2 still run, since they are about the
// tree, not the agent, and a skip never takes or waits on gate.lock either.
describe("card stop-gate-read-only-subagent-skip", () => {
  const runsLogRelpath = ".doug/.state/runs.log";
  const runsLogPath = (dir) => join(dir, runsLogRelpath);
  const runsCount = (dir) => (existsSync(runsLogPath(dir)) ? readFileSync(runsLogPath(dir), "utf8").length : 0);

  function makeRunsConfig(extra = {}) {
    return {
      ...baseConfig,
      commands: { "test:unit": `${process.execPath} -e "require('fs').appendFileSync('${runsLogRelpath}','x')"` },
      stopGate: { commands: ["test:unit"], onlyIfEdited: true, maxBlocks: 3, timeoutMs: 10000, requireEvidence: false },
      trace: { enabled: true },
      ...extra,
    };
  }

  // A committed-base project with one file this session itself edited (edit-loop records it) — the same
  // "case 2" shape stop-gate-process-storm's own tests build on, so onlyIfEdited's anyChange is true and the
  // gate reaches the read-only-agent check this card adds, rather than exiting before it on nothing-changed.
  function makeEditedProject(config) {
    const dir = makeProject({ config, git: true });
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src/a.ts"), "base");
    execFileSync("git", ["add", "-A"], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", "base"], { cwd: dir });
    writeFileSync(join(dir, "src/a.ts"), "edited this session");
    runHookScript("edit-loop", { tool_name: "Edit", tool_input: { file_path: "src/a.ts" } }, { dir });
    return dir;
  }

  const traceFilePath = (dir, sessionId = "test-session") => join(dir, ".doug/.state/trace", `${sessionId}.jsonl`);

  // Writes trace lines directly (not through the trace hook), each filled out to the full traceLine shape
  // (lib/trace.mjs) so the reader under test never sees a line shaped differently from a real one.
  function writeTrace(dir, lines, sessionId = "test-session") {
    const file = traceFilePath(dir, sessionId);
    mkdirSync(dirname(file), { recursive: true });
    const full = lines.map((l) => ({
      t: new Date().toISOString(),
      event: null,
      session: sessionId,
      agent: null,
      agentType: null,
      tool: null,
      toolUseId: null,
      detail: null,
      ok: null,
      tokens: null,
      context: null,
      reason: null,
      ...l,
    }));
    writeFileSync(file, full.map((l) => JSON.stringify(l)).join("\n") + "\n");
  }

  function tracedLines(dir, sessionId = "test-session") {
    const file = traceFilePath(dir, sessionId);
    if (!existsSync(file)) return [];
    return readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  }

  const start = (agent, agentType) => ({ event: "SubagentStart", agent, agentType });
  const pre = (agent, agentType, tool) => ({ event: "PreToolUse", agent, agentType, tool });
  const post = (agent, agentType, tool, ok = true) => ({ event: "PostToolUse", agent, agentType, tool, ok });

  it("T1 a researcher with only Read/WebFetch lines skips: allow, no commands run, a no-agent-changes trace line, state.verified untouched", () => {
    const dir = makeEditedProject(makeRunsConfig());
    writeTrace(dir, [
      start("ag1", "researcher"),
      pre("ag1", "researcher", "Read"),
      post("ag1", "researcher", "Read", true),
      pre("ag1", "researcher", "WebFetch"),
      post("ag1", "researcher", "WebFetch", true),
    ]);
    const r = runHookScript("stop-gate", { hook_event_name: "SubagentStop", agent_id: "ag1", agent_type: "researcher" }, { dir });
    expect(r.json).toBeNull();
    expect(runsCount(dir), "a no-change agent must not run the verification commands").toBe(0);
    const lines = tracedLines(dir);
    expect(lines.some((l) => l.event === "SubagentStop" && l.reason === "no-agent-changes"), "the skip must append a trace line with reason no-agent-changes").toBe(true);
    const state = JSON.parse(readFileSync(join(dir, ".doug/.state/test-session.json"), "utf8"));
    expect(state.verified == null, "a skipped run verifies nothing, so it must not record state.verified").toBe(true);
  });

  it("T2 the same researcher with one PreToolUse Bash line added runs the commands: Bash can change files", () => {
    const dir = makeEditedProject(makeRunsConfig());
    writeTrace(dir, [
      start("ag1", "researcher"),
      pre("ag1", "researcher", "Read"),
      post("ag1", "researcher", "Read", true),
      pre("ag1", "researcher", "Bash"),
    ]);
    runHookScript("stop-gate", { hook_event_name: "SubagentStop", agent_id: "ag1", agent_type: "researcher" }, { dir });
    expect(runsCount(dir)).toBe(1);
  });

  it("M-T1 the same researcher with one PreToolUse Monitor line added runs the commands: Monitor runs a shell command too", () => {
    const dir = makeEditedProject(makeRunsConfig());
    writeTrace(dir, [
      start("ag1", "researcher"),
      pre("ag1", "researcher", "Read"),
      post("ag1", "researcher", "Read", true),
      pre("ag1", "researcher", "Monitor"),
    ]);
    runHookScript("stop-gate", { hook_event_name: "SubagentStop", agent_id: "ag1", agent_type: "researcher" }, { dir });
    expect(runsCount(dir)).toBe(1);
  });

  it("M-T2 a researcher with only a PostToolUse Monitor line with ok: false runs the commands: Monitor counts whatever ok", () => {
    const dir = makeEditedProject(makeRunsConfig());
    writeTrace(dir, [start("ag1", "researcher"), post("ag1", "researcher", "Monitor", false)]);
    runHookScript("stop-gate", { hook_event_name: "SubagentStop", agent_id: "ag1", agent_type: "researcher" }, { dir });
    expect(runsCount(dir)).toBe(1);
  });

  it("T3 a coder with a successful PostToolUse Edit runs the commands", () => {
    const dir = makeEditedProject(makeRunsConfig());
    writeTrace(dir, [start("ag1", "coder"), pre("ag1", "coder", "Edit"), post("ag1", "coder", "Edit", true)]);
    runHookScript("stop-gate", { hook_event_name: "SubagentStop", agent_id: "ag1", agent_type: "coder" }, { dir });
    expect(runsCount(dir)).toBe(1);
  });

  it("T4 a type-only match (reviewer) with a successful PostToolUse Edit still runs the commands: the trace wins over the type", () => {
    const dir = makeEditedProject(makeRunsConfig());
    writeTrace(dir, [start("ag1", "reviewer"), pre("ag1", "reviewer", "Edit"), post("ag1", "reviewer", "Edit", true)]);
    runHookScript("stop-gate", { hook_event_name: "SubagentStop", agent_id: "ag1", agent_type: "reviewer" }, { dir });
    expect(runsCount(dir)).toBe(1);
  });

  it("T5 a coder with only Read lines skips: the trace rule decides, independent of type", () => {
    const dir = makeEditedProject(makeRunsConfig());
    writeTrace(dir, [start("ag1", "coder"), pre("ag1", "coder", "Read"), post("ag1", "coder", "Read", true)]);
    const r = runHookScript("stop-gate", { hook_event_name: "SubagentStop", agent_id: "ag1", agent_type: "coder" }, { dir });
    expect(r.json).toBeNull();
    expect(runsCount(dir)).toBe(0);
  });

  it("T6 with no trace file at all, a read-only type (Explore) skips and a non-read-only type (coder) runs", () => {
    const explore = makeEditedProject(makeRunsConfig({ trace: { enabled: false } }));
    const r1 = runHookScript("stop-gate", { hook_event_name: "SubagentStop", agent_id: "ag1", agent_type: "Explore" }, { dir: explore });
    expect(r1.json).toBeNull();
    expect(runsCount(explore)).toBe(0);

    const coder = makeEditedProject(makeRunsConfig({ trace: { enabled: false } }));
    runHookScript("stop-gate", { hook_event_name: "SubagentStop", agent_id: "ag1", agent_type: "coder" }, { dir: coder });
    expect(runsCount(coder)).toBe(1);
  });

  it("T7 a trace file with no SubagentStart for this agent id cannot vouch for it: a non-read-only type still runs, even with only Read lines", () => {
    const dir = makeEditedProject(makeRunsConfig());
    // Only another agent's SubagentStart is on file; as far as the trace can show, ag1 itself never started.
    writeTrace(dir, [start("other", "coder"), pre("ag1", "coder", "Read"), post("ag1", "coder", "Read", true)]);
    runHookScript("stop-gate", { hook_event_name: "SubagentStop", agent_id: "ag1", agent_type: "coder" }, { dir });
    expect(runsCount(dir)).toBe(1);
  });

  it("T8 a failed Write (ok: false) is not a change and skips; the same Write with ok: null counts as a change and runs", () => {
    const skipDir = makeEditedProject(makeRunsConfig());
    writeTrace(skipDir, [start("ag1", "coder"), pre("ag1", "coder", "Write"), post("ag1", "coder", "Write", false)]);
    const r1 = runHookScript("stop-gate", { hook_event_name: "SubagentStop", agent_id: "ag1", agent_type: "coder" }, { dir: skipDir });
    expect(r1.json).toBeNull();
    expect(runsCount(skipDir)).toBe(0);

    const runDir = makeEditedProject(makeRunsConfig());
    writeTrace(runDir, [start("ag1", "coder"), pre("ag1", "coder", "Write"), post("ag1", "coder", "Write", null)]);
    runHookScript("stop-gate", { hook_event_name: "SubagentStop", agent_id: "ag1", agent_type: "coder" }, { dir: runDir });
    expect(runsCount(runDir)).toBe(1);
  });

  it("T9 the protected-path scan still runs on a skip: a researcher with only Read lines still gets blocked, with no commands run", () => {
    const dir = makeProject({ config: makeRunsConfig(), git: true });
    writeFileSync(join(dir, ".env"), "SECRET=1"); // dirty, protected, and never touched by the Edit tool
    writeTrace(dir, [start("ag1", "researcher"), pre("ag1", "researcher", "Read"), post("ag1", "researcher", "Read", true)]);
    const r = runHookScript("stop-gate", { hook_event_name: "SubagentStop", agent_id: "ag1", agent_type: "researcher" }, { dir });
    expect(r.json.decision).toBe("block");
    expect(r.json.reason).toContain("Protected files were modified: .env");
    expect(runsCount(dir), "the scans still run on a skip, but the verification commands themselves must not").toBe(0);
  });

  it("T10 another agent's Edit line does not count against this agent: ag1 (Read only) skips even though ag2 edited", () => {
    const dir = makeEditedProject(makeRunsConfig());
    writeTrace(dir, [
      start("ag1", "researcher"),
      pre("ag1", "researcher", "Read"),
      post("ag1", "researcher", "Read", true),
      start("ag2", "coder"),
      pre("ag2", "coder", "Edit"),
      post("ag2", "coder", "Edit", true),
    ]);
    const r = runHookScript("stop-gate", { hook_event_name: "SubagentStop", agent_id: "ag1", agent_type: "researcher" }, { dir });
    expect(r.json).toBeNull();
    expect(runsCount(dir)).toBe(0);
  });

  it("T11 a skip never takes or waits on gate.lock: a live lock (this test process's own pid) is left byte-identical, and the gate allows well under the wait it would cost a regression", () => {
    // timeoutMs is set high (15000) so a regression that waits on the lock blows well past the
    // bound below (8000ms); spawnSync blocks the event loop, so vitest's own testTimeout cannot
    // interrupt the hook run — the elapsed bound is what would actually catch the regression,
    // instead of racing a tight bound against load-induced hook startup jitter (observed 1229ms
    // startup alone under load).
    const dir = makeEditedProject(makeRunsConfig({ stopGate: { commands: ["test:unit"], onlyIfEdited: true, maxBlocks: 3, timeoutMs: 15000, requireEvidence: false } }));
    mkdirSync(join(dir, ".doug/.state"), { recursive: true });
    const lockPath = join(dir, ".doug/.state/gate.lock");
    const lockContent = JSON.stringify({ pid: process.pid, session: "someone-else", at: Date.now() });
    writeFileSync(lockPath, lockContent);
    writeTrace(dir, [start("ag1", "researcher"), pre("ag1", "researcher", "Read"), post("ag1", "researcher", "Read", true)]);
    const started = Date.now();
    const r = runHookScript("stop-gate", { hook_event_name: "SubagentStop", agent_id: "ag1", agent_type: "researcher" }, { dir });
    const elapsed = Date.now() - started;
    expect(r.json).toBeNull();
    expect(elapsed, "a skip must never wait on gate.lock, live or not").toBeLessThan(8000);
    expect(runsCount(dir)).toBe(0);
    expect(existsSync(lockPath), "a skip must never touch a lock it does not own").toBe(true);
    expect(readFileSync(lockPath, "utf8"), "a skip must never rewrite or take over a lock it does not own").toBe(lockContent);
  });

  it("T12 the skip is SubagentStop-only: a main Stop with the same no-change trace still runs the commands", () => {
    const dir = makeEditedProject(makeRunsConfig());
    // ag1 has stopped (a hook stop line plus the gate's own allowed line, card
    // stop-gate-defers-while-subagent-in-flight) so this main Stop is not deferred on that account; the point
    // under test is that the no-change skip itself never applies outside a SubagentStop.
    writeTrace(dir, [
      start("ag1", "researcher"),
      pre("ag1", "researcher", "Read"),
      post("ag1", "researcher", "Read", true),
      { event: "SubagentStop", agent: "ag1", agentType: "researcher" },
      { event: "SubagentStop", agent: "ag1", agentType: "researcher", decision: "allow", reason: "no-agent-changes" },
    ]);
    runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
    expect(runsCount(dir)).toBe(1);
  });

  it("T13 the evidence check (3b) is skipped too: requireEvidence on, with no recorded test command, still allows on a skip", () => {
    const dir = makeEditedProject(
      makeRunsConfig({ stopGate: { commands: ["test:unit"], onlyIfEdited: true, maxBlocks: 3, timeoutMs: 10000, requireEvidence: true } }),
    );
    writeTrace(dir, [start("ag1", "researcher"), pre("ag1", "researcher", "Read"), post("ag1", "researcher", "Read", true)]);
    const r = runHookScript("stop-gate", { hook_event_name: "SubagentStop", agent_id: "ag1", agent_type: "researcher" }, { dir });
    expect(r.json).toBeNull();
    expect(runsCount(dir)).toBe(0);
  });

  // R2: agentMadeNoChanges' catch returns false (run the gate), not true (skip it). readTrace (lib/trace.mjs:140)
  // calls readFileSync(file, "utf8") outside any try/catch of its own, and readFileSync throws EISDIR when
  // `file` names a directory; that propagates up through stop-gate.mjs:347 into the try at 342, caught by the
  // catch at 360. Proven directly: `node -e "require('fs').readFileSync('.', 'utf8')"` throws
  // "EISDIR: illegal operation on a directory, read". So a directory in place of the trace file is a real,
  // reachable way to make the reader's try body throw, and T14 is not vacuous against R2.
  it("T14 a trace path that exists as a directory: a coder's SubagentStop still runs the commands", () => {
    const dir = makeEditedProject(makeRunsConfig());
    mkdirSync(traceFilePath(dir), { recursive: true });
    runHookScript("stop-gate", { hook_event_name: "SubagentStop", agent_id: "ag1", agent_type: "coder" }, { dir });
    expect(
      runsCount(dir),
      "a directory at the trace path must make readTrace throw, be caught, and fall through to running the gate (false), never skip it (true)",
    ).toBe(1);
  });

  it("T15 a researcher skip with a dirty protected path still blocks and increments state.agentBlocks[ag1]", () => {
    const seededDir = makeProject({ config: makeRunsConfig(), git: true });
    writeFileSync(join(seededDir, ".env"), "SECRET=1");
    writeTrace(seededDir, [start("ag1", "researcher"), pre("ag1", "researcher", "Read"), post("ag1", "researcher", "Read", true)]);
    saveState(seededDir, "test-session", { ...loadState(seededDir, "test-session"), agentBlocks: { ag1: 1 } });
    const r1 = runHookScript("stop-gate", { hook_event_name: "SubagentStop", agent_id: "ag1", agent_type: "researcher" }, { dir: seededDir });
    expect(r1.json.decision).toBe("block");
    expect(runsCount(seededDir), "the skip must still keep the verification commands from running").toBe(0);
    const seededState = loadState(seededDir, "test-session");
    expect(seededState.agentBlocks.ag1, "a seeded prior count (1) must go up by one, to 2, not stay unset").toBe(2);

    const freshDir = makeProject({ config: makeRunsConfig(), git: true });
    writeFileSync(join(freshDir, ".env"), "SECRET=1");
    writeTrace(freshDir, [start("ag1", "researcher"), pre("ag1", "researcher", "Read"), post("ag1", "researcher", "Read", true)]);
    const r2 = runHookScript("stop-gate", { hook_event_name: "SubagentStop", agent_id: "ag1", agent_type: "researcher" }, { dir: freshDir });
    expect(r2.json.decision).toBe("block");
    const freshState = loadState(freshDir, "test-session");
    expect(freshState.agentBlocks.ag1, "with no prior count, a block on a skip must still record 1").toBe(1);
  });

  it("T16 a green researcher skip resets a previously seeded state.agentBlocks count to 0", () => {
    const dir = makeEditedProject(makeRunsConfig());
    writeTrace(dir, [start("ag1", "researcher"), pre("ag1", "researcher", "Read"), post("ag1", "researcher", "Read", true)]);
    saveState(dir, "test-session", { ...loadState(dir, "test-session"), agentBlocks: { ag1: 2 } });
    const r = runHookScript("stop-gate", { hook_event_name: "SubagentStop", agent_id: "ag1", agent_type: "researcher" }, { dir });
    expect(r.json).toBeNull();
    const state = loadState(dir, "test-session");
    expect(state.agentBlocks.ag1, "a green skip must reset a previously seeded agentBlocks count to 0").toBe(0);
  });

  it("T17 a green researcher skip records state.lastGate.skipped as no-agent-changes", () => {
    const dir = makeEditedProject(makeRunsConfig());
    writeTrace(dir, [start("ag1", "researcher"), pre("ag1", "researcher", "Read"), post("ag1", "researcher", "Read", true)]);
    const r = runHookScript("stop-gate", { hook_event_name: "SubagentStop", agent_id: "ag1", agent_type: "researcher" }, { dir });
    expect(r.json).toBeNull();
    const state = loadState(dir, "test-session");
    expect(state.lastGate && state.lastGate.skipped, "a green skip must record lastGate.skipped as no-agent-changes").toBe("no-agent-changes");
  });

  it("T18 trace.enabled false with a no-change trace file on disk: a coder still runs the commands", () => {
    const dir = makeEditedProject(makeRunsConfig({ trace: { enabled: false } }));
    writeTrace(dir, [start("ag1", "coder"), pre("ag1", "coder", "Read"), post("ag1", "coder", "Read", true)]);
    runHookScript("stop-gate", { hook_event_name: "SubagentStop", agent_id: "ag1", agent_type: "coder" }, { dir });
    expect(
      runsCount(dir),
      "trace.enabled false must be honoured over a trace file's presence on disk; falling to the type fallback (coder is not read-only) must run the commands",
    ).toBe(1);
  });
});

// card stop-gate-skips-orphan-subagent-stops: Claude Code fires SubagentStop for agents that never had a
// SubagentStart in this session's trace, carry no agent_type, and have no readable agent_transcript_path
// (research note docs/research/gate-output-names-failures.md Q1). Today such an orphan gets subagent.type
// "subagent" (stop-gate.mjs:599) and agentMadeNoChanges falls back to READ_ONLY_AGENT_TYPES, which does not
// include "subagent", so the orphan runs the full verification suite. No implementation exists yet; O1, O4's
// absent-transcript half, and O5/O6's negative stderr checks are expected to be red until the coder adds the
// orphan check (isOrphanSubagentStop) ahead of the partial-claim block, the tree scans, the deferral logic,
// gate.lock, skipVerification, and runVerification.
describe("card stop-gate-skips-orphan-subagent-stops", () => {
  const runsLogRelpath = ".doug/.state/runs.log";
  const runsLogPath = (dir) => join(dir, runsLogRelpath);
  const runsCount = (dir) => (existsSync(runsLogPath(dir)) ? readFileSync(runsLogPath(dir), "utf8").length : 0);

  function makeRunsConfig(extra = {}) {
    return {
      ...baseConfig,
      commands: { "test:unit": `${process.execPath} -e "require('fs').appendFileSync('${runsLogRelpath}','x')"` },
      stopGate: { commands: ["test:unit"], onlyIfEdited: true, maxBlocks: 3, timeoutMs: 10000, requireEvidence: false },
      trace: { enabled: true },
      ...extra,
    };
  }

  // Same "case 2" shape as the read-only-subagent-skip block above: a committed base plus one file this
  // session itself edited, so onlyIfEdited's anyChange is true and the gate reaches the orphan check instead
  // of exiting before it on nothing-changed.
  function makeEditedProject(config) {
    const dir = makeProject({ config, git: true });
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src/a.ts"), "base");
    execFileSync("git", ["add", "-A"], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", "base"], { cwd: dir });
    writeFileSync(join(dir, "src/a.ts"), "edited this session");
    runHookScript("edit-loop", { tool_name: "Edit", tool_input: { file_path: "src/a.ts" } }, { dir });
    return dir;
  }

  const traceFilePath = (dir, sessionId = "test-session") => join(dir, ".doug/.state/trace", `${sessionId}.jsonl`);

  function writeTrace(dir, lines, sessionId = "test-session") {
    const file = traceFilePath(dir, sessionId);
    mkdirSync(dirname(file), { recursive: true });
    const full = lines.map((l) => ({
      t: new Date().toISOString(),
      event: null,
      session: sessionId,
      agent: null,
      agentType: null,
      tool: null,
      toolUseId: null,
      detail: null,
      ok: null,
      tokens: null,
      context: null,
      reason: null,
      ...l,
    }));
    writeFileSync(file, full.map((l) => JSON.stringify(l)).join("\n") + "\n");
  }

  function tracedLines(dir, sessionId = "test-session") {
    const file = traceFilePath(dir, sessionId);
    if (!existsSync(file)) return [];
    return readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  }

  const start = (agent, agentType) => ({ event: "SubagentStart", agent, agentType });
  const pre = (agent, agentType, tool) => ({ event: "PreToolUse", agent, agentType, tool });
  const post = (agent, agentType, tool, ok = true) => ({ event: "PostToolUse", agent, agentType, tool, ok });

  // The real agent in flight every test's fixture shares (brief: "start('ag1','coder') plus an Edit pre/post
  // for ag1, so the real agent is in flight and ag1 is not 'no changes'").
  const realAgentTrace = () => [start("ag1", "coder"), pre("ag1", "coder", "Edit"), post("ag1", "coder", "Edit", true)];

  // Seeds the session state file through loadState/saveState (never a guessed JSON literal), with
  // deferrals: 3 so O1 can pin that an orphan skip never persists R6's in-memory deferrals reset.
  function seedState(dir, sessionId = "test-session") {
    saveState(dir, sessionId, { ...loadState(dir, sessionId), deferrals: 3 });
  }

  const ORPHAN_SENTENCE = /orphan/i;

  it("O1 the orphan shape skips: allow, no commands, stderr names the id, state and blocks.jsonl untouched, one decision-tagged trace line", () => {
    const dir = makeEditedProject(makeRunsConfig());
    writeTrace(dir, realAgentTrace());
    seedState(dir);
    const r = runHookScript("stop-gate", { hook_event_name: "SubagentStop", agent_id: "orphan-1" }, { dir });
    expect(r.json, "orphan skip: a plain allow, no systemMessage or block").toBeNull();
    expect(runsCount(dir), "orphan skip: the verification commands must not run").toBe(0);
    expect(r.stderr, "orphan skip: one stderr line must name the orphan id").toContain("orphan-1");
    expect(existsSync(join(dir, ".doug/.state/gate.lock")), "orphan skip: must never take gate.lock").toBe(false);
    const state = loadState(dir, "test-session");
    expect(state.verified == null, "orphan skip: must not touch state.verified").toBe(true);
    expect(state.deferrals, "orphan skip: must not saveState (R6's in-memory deferrals reset stays unpersisted)").toBe(3);
    expect(state.agentBlocks && state.agentBlocks["orphan-1"], "orphan skip: must not record an agentBlocks entry").toBeUndefined();
    const blocksPath = join(dir, ".doug/.state/blocks.jsonl");
    expect(
      !existsSync(blocksPath) || !readFileSync(blocksPath, "utf8").includes("orphan-1"),
      "orphan skip: must write no blocks.jsonl line (never calls logBlock)",
    ).toBe(true);
    const lines = tracedLines(dir);
    const line = lines.find((l) => l.event === "SubagentStop" && l.agent === "orphan-1");
    expect(line, "orphan skip: must still append a decision-tagged SubagentStop trace line (D1)").toBeTruthy();
    expect(line.decision, "orphan skip: the trace line's decision must be allow").toBe("allow");
    expect(line.reason, "orphan skip: the trace line's reason must be orphan-subagent-stop").toBe("orphan-subagent-stop");
  });

  it("O2 an agent with a start line does not skip: the trace vouches for it even with no agent_type", () => {
    const dir = makeEditedProject(makeRunsConfig());
    writeTrace(dir, realAgentTrace());
    const r = runHookScript("stop-gate", { hook_event_name: "SubagentStop", agent_id: "ag1" }, { dir });
    expect(runsCount(dir), "condition 1 (no SubagentStart line): an agent with a start line must run as today").toBe(1);
    expect(ORPHAN_SENTENCE.test(r.stderr), "condition 1: an agent with a start line must not get the orphan stderr line").toBe(false);
  });

  it("O3 an orphan with an agent_type does not skip", () => {
    const dir = makeEditedProject(makeRunsConfig());
    writeTrace(dir, realAgentTrace());
    const r = runHookScript("stop-gate", { hook_event_name: "SubagentStop", agent_id: "orphan-1", agent_type: "coder" }, { dir });
    expect(runsCount(dir), "condition 2 (no agent_type): an orphan-shaped id with an agent_type must run as today").toBe(1);
  });

  it("O3b an empty-string agent_type and a null agent_type both count as absent, so the orphan still skips", () => {
    const emptyDir = makeEditedProject(makeRunsConfig());
    writeTrace(emptyDir, realAgentTrace());
    const r1 = runHookScript(
      "stop-gate",
      { hook_event_name: "SubagentStop", agent_id: "orphan-1", agent_type: "" },
      { dir: emptyDir },
    );
    expect(
      runsCount(emptyDir),
      "condition 2 (agent_type absent): an empty-string agent_type counts as absent, so the orphan skips (verification commands must not run)",
    ).toBe(0);
    expect(r1.stderr, "condition 2 (agent_type ''): the skip still names the orphan id").toContain("orphan-1");

    const nullDir = makeEditedProject(makeRunsConfig());
    writeTrace(nullDir, realAgentTrace());
    const r2 = runHookScript(
      "stop-gate",
      { hook_event_name: "SubagentStop", agent_id: "orphan-1", agent_type: null },
      { dir: nullDir },
    );
    expect(
      runsCount(nullDir),
      "condition 2 (agent_type absent): a null agent_type counts as absent, so the orphan skips (verification commands must not run)",
    ).toBe(0);
    expect(r2.stderr, "condition 2 (agent_type null): the skip still names the orphan id").toContain("orphan-1");
  });

  it("O4 an orphan with a readable agent_transcript_path does not skip; the same id with an unreadable path still skips", () => {
    const readableDir = makeEditedProject(makeRunsConfig());
    writeTrace(readableDir, realAgentTrace());
    const transcriptPath = join(readableDir, "transcript.jsonl");
    writeFileSync(transcriptPath, JSON.stringify({ type: "assistant", message: { usage: {} } }) + "\n");
    const r1 = runHookScript(
      "stop-gate",
      { hook_event_name: "SubagentStop", agent_id: "orphan-1", agent_transcript_path: transcriptPath },
      { dir: readableDir },
    );
    expect(runsCount(readableDir), "condition 3 (readable transcript): a readable agent_transcript_path must run as today").toBe(1);

    const unreadableDir = makeEditedProject(makeRunsConfig());
    writeTrace(unreadableDir, realAgentTrace());
    const r2 = runHookScript(
      "stop-gate",
      { hook_event_name: "SubagentStop", agent_id: "orphan-1", agent_transcript_path: join(unreadableDir, "nope.jsonl") },
      { dir: unreadableDir },
    );
    expect(runsCount(unreadableDir), "condition 3 (converse): an absent agent_transcript_path still skips").toBe(0);
    expect(r2.stderr, "condition 3 (converse): the skip still names the id").toContain("orphan-1");
  });

  it("O5 trace disabled, and trace enabled with no trace file at all, both run as today", () => {
    const disabledDir = makeEditedProject(makeRunsConfig({ trace: { enabled: false } }));
    const r1 = runHookScript("stop-gate", { hook_event_name: "SubagentStop", agent_id: "orphan-1" }, { dir: disabledDir });
    expect(runsCount(disabledDir), "trace-enabled precondition: trace.enabled false must fail closed onto today's behaviour").toBe(1);
    expect(ORPHAN_SENTENCE.test(r1.stderr), "trace.enabled false: must not get the orphan stderr line").toBe(false);

    const noFileDir = makeEditedProject(makeRunsConfig());
    const r2 = runHookScript("stop-gate", { hook_event_name: "SubagentStop", agent_id: "orphan-1" }, { dir: noFileDir });
    expect(runsCount(noFileDir), "trace-enabled precondition: a missing trace file must fail closed onto today's behaviour").toBe(1);
    expect(ORPHAN_SENTENCE.test(r2.stderr), "missing trace file: must not get the orphan stderr line").toBe(false);
  });

  it("O6 the lead's main Stop is unchanged: the orphan check is SubagentStop-only", () => {
    const dir = makeEditedProject(makeRunsConfig());
    writeTrace(dir, [...realAgentTrace(), { event: "SubagentStop", agent: "ag1", agentType: "coder", decision: "allow" }]);
    const r = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
    expect(runsCount(dir), "subagent-only guard: a main Stop must run the verification commands as today").toBe(1);
    expect(ORPHAN_SENTENCE.test(r.stderr), "subagent-only guard: a main Stop must never get the orphan stderr line").toBe(false);
  });

  it("O7 a throw inside the orphan check fails closed onto today's behaviour, never open", () => {
    const dir = makeEditedProject(makeRunsConfig());
    // No writeTrace call: instead the session trace path itself is a directory, so reading it (readFileSync)
    // throws (EISDIR) inside isOrphanSubagentStop's try, which must be caught and read as "not an orphan".
    mkdirSync(traceFilePath(dir), { recursive: true });
    const r = runHookScript("stop-gate", { hook_event_name: "SubagentStop", agent_id: "orphan-1" }, { dir });
    expect(
      r.status,
      "a throw inside the orphan check fails closed onto today's behaviour, never open: the hook still exits 0",
    ).toBe(0);
    expect(
      runsCount(dir),
      "a throw inside the orphan check fails closed onto today's behaviour, never open: the gate still runs as today (the verification commands still run)",
    ).toBe(1);
    expect(
      r.stderr,
      "a throw inside the orphan check fails closed onto today's behaviour, never open: no orphan stderr line is written",
    ).not.toContain("orphan agent");
  });
});

// card stop-gate-defers-while-subagent-in-flight: the Stop hook fires whenever the lead's turn ends, including
// when it ends only to wait for a background tester, coder, or reviewer. Today the main Stop treats that as a
// claim of done and runs the full verification suite against a tree a subagent may be mid-edit. This card makes
// a main Stop (never a SubagentStop) with a subagent of this session in flight skip the commands and the
// evidence check, allow with one systemMessage naming the agents in flight, write no blocks.jsonl line, and
// never touch state.stopBlocks/state.verified — deferring to the first Stop after the last SubagentStop. No
// implementation exists yet (subagentInFlight, stop-gate.mjs:216-232, is read only by contextNotice); every
// test below is expected to be red until the coder adds the deferral and the decision-tagged SubagentStop trace
// lines (D1) it depends on for rule B.
describe("card stop-gate-defers-while-subagent-in-flight", () => {
  const runsLogRelpath = ".doug/.state/runs.log";
  const runsLogPath = (dir) => join(dir, runsLogRelpath);
  const runsCount = (dir) => (existsSync(runsLogPath(dir)) ? readFileSync(runsLogPath(dir), "utf8").length : 0);

  function makeRunsConfig(extra = {}) {
    return {
      ...baseConfig,
      commands: { "test:unit": `${process.execPath} -e "require('fs').appendFileSync('${runsLogRelpath}','x')"` },
      stopGate: { commands: ["test:unit"], onlyIfEdited: true, maxBlocks: 3, timeoutMs: 10000, requireEvidence: false },
      trace: { enabled: true },
      ...extra,
    };
  }

  // Same "case 2" shape stop-gate-read-only-subagent-skip's own makeEditedProject builds on: a committed base
  // plus one file this session itself edited, so onlyIfEdited's anyChange is true and a main Stop reaches the
  // deferral check this card adds, rather than exiting before it on nothing-changed.
  function makeEditedProject(config) {
    const dir = makeProject({ config, git: true });
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src/a.ts"), "base");
    execFileSync("git", ["add", "-A"], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", "base"], { cwd: dir });
    writeFileSync(join(dir, "src/a.ts"), "edited this session");
    runHookScript("edit-loop", { tool_name: "Edit", tool_input: { file_path: "src/a.ts" } }, { dir });
    return dir;
  }

  const traceFilePath = (dir, sessionId = "test-session") => join(dir, ".doug/.state/trace", `${sessionId}.jsonl`);

  function writeTrace(dir, lines, sessionId = "test-session") {
    const file = traceFilePath(dir, sessionId);
    mkdirSync(dirname(file), { recursive: true });
    const full = lines.map((l) => ({
      t: new Date().toISOString(),
      event: null,
      session: sessionId,
      agent: null,
      agentType: null,
      tool: null,
      toolUseId: null,
      detail: null,
      ok: null,
      tokens: null,
      context: null,
      reason: null,
      ...l,
    }));
    writeFileSync(file, full.map((l) => JSON.stringify(l)).join("\n") + "\n");
  }

  function tracedLines(dir, sessionId = "test-session") {
    const file = traceFilePath(dir, sessionId);
    if (!existsSync(file)) return [];
    return readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  }

  const start = (agent, agentType) => ({ event: "SubagentStart", agent, agentType });
  // The trace hook's own SubagentStop line (trace.mjs), which carries no `decision` field (F2 in the brief) —
  // only the gate itself, once this card lands, tags one with "allow" or "block" (D1).
  const hookStop = (agent, agentType) => ({ event: "SubagentStop", agent, agentType });

  const LEDGER_RELPATH = ".doug/.state/blocks.jsonl";
  const readLedger = (dir) => {
    const file = join(dir, LEDGER_RELPATH);
    if (!existsSync(file)) return [];
    return readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  };
  const sessionStateOf = (dir) => JSON.parse(readFileSync(join(dir, ".doug/.state/test-session.json"), "utf8"));

  it("G1 a Stop with one in-flight agent (SubagentStart only) allows without running commands, naming the agent and deferring, with no block recorded", () => {
    const dir = makeEditedProject(makeRunsConfig());
    writeTrace(dir, [start("ag1", "coder")]);
    const r = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
    expect(r.json.decision).toBeUndefined();
    expect(r.json.systemMessage).toContain("coder:ag1");
    expect(r.json.systemMessage.toLowerCase()).toContain("deferred");
    expect(r.json.systemMessage).toContain("Do not treat this work as done");
    expect(runsCount(dir), "the verification commands must not run while the agent is in flight").toBe(0);
    expect(readLedger(dir), "a deferral must write no blocks.jsonl line").toEqual([]);
    const state = sessionStateOf(dir);
    expect(state.stopBlocks, "a deferral must never count toward maxBlocks").toBe(0);
    expect(state.verified == null, "a deferral verifies nothing, so it must not record state.verified").toBe(true);
  });

  it("G2 a Stop after that agent's allowed SubagentStop runs the commands", () => {
    const dir = makeEditedProject(makeRunsConfig());
    writeTrace(dir, [start("ag1", "coder"), hookStop("ag1", "coder"), { event: "SubagentStop", agent: "ag1", agentType: "coder", decision: "allow" }]);
    runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
    expect(runsCount(dir), "the agent has an allowed SubagentStop, so it is gone and the full gate runs").toBe(1);
  });

  it("G2b rule A in isolation: only gate-written lines (no decision-less hook line at all — a project whose trace hook is not wired to SubagentStop), a decision: allow among them still ends the flight", () => {
    const dir = makeEditedProject(makeRunsConfig());
    // No decision-less line here at all, so rule B alone (0 decision-less > 1 block => false) would read this
    // agent as still in flight; only rule A (the decision: "allow" line) can end it.
    writeTrace(dir, [
      start("ag1", "coder"),
      { event: "SubagentStop", agent: "ag1", agentType: "coder", decision: "block" },
      { event: "SubagentStop", agent: "ag1", agentType: "coder", decision: "allow" },
    ]);
    runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
    expect(runsCount(dir), "rule A alone must read this agent as gone").toBe(1);
  });

  it("G3 a Stop after only a BLOCKED SubagentStop still defers: a blocked agent is still working", () => {
    const dir = makeEditedProject(makeRunsConfig());
    writeTrace(dir, [start("ag1", "coder"), hookStop("ag1", "coder"), { event: "SubagentStop", agent: "ag1", agentType: "coder", decision: "block" }]);
    const r = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
    expect(r.json.decision).toBeUndefined();
    expect(r.json.systemMessage).toContain("coder:ag1");
    expect(runsCount(dir)).toBe(0);
    expect(readLedger(dir)).toEqual([]);
    const state = sessionStateOf(dir);
    expect(state.stopBlocks).toBe(0);
    expect(state.verified == null).toBe(true);
  });

  it("G4 rule B: more stop events than blocks means a stop the gate did not block — the agent is gone even with no matching allow line", () => {
    const dir = makeEditedProject(makeRunsConfig());
    // Two stop events for ag1 (the trace hook's own line, undecorated, per stop) but only one decision:"block"
    // line among them: 2 no-decision lines > 1 block line, so rule B reads the agent as stopped (a fail-open or
    // an unwired gate on the second attempt), not still in flight.
    writeTrace(dir, [
      start("ag1", "coder"),
      hookStop("ag1", "coder"),
      { event: "SubagentStop", agent: "ag1", agentType: "coder", decision: "block" },
      hookStop("ag1", "coder"),
    ]);
    runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
    expect(runsCount(dir), "rule B must read the agent as gone here").toBe(1);
  });

  it("G5 fail closed: a disabled trace, a directory at the trace path, and a garbage trace file all run the gate as today", () => {
    const disabled = makeEditedProject(makeRunsConfig({ trace: { enabled: false } }));
    writeTrace(disabled, [start("ag1", "coder")]);
    runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir: disabled });
    expect(runsCount(disabled), "trace.enabled: false must never defer").toBe(1);

    const dirBlocked = makeEditedProject(makeRunsConfig());
    mkdirSync(traceFilePath(dirBlocked), { recursive: true }); // a directory where the trace file should be
    runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir: dirBlocked });
    expect(runsCount(dirBlocked), "an unreadable trace file must fail closed onto the full gate").toBe(1);

    const garbage = makeEditedProject(makeRunsConfig());
    mkdirSync(dirname(traceFilePath(garbage)), { recursive: true });
    writeFileSync(traceFilePath(garbage), "not json at all\n{{{\n");
    runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir: garbage });
    expect(runsCount(garbage), "a garbage trace file must fail closed onto the full gate").toBe(1);
  });

  it("G6 not counted: three deferred Stops in a row never touch state.stopBlocks or blocks.jsonl, so the first real block after the agent stops still reads (1/3)", () => {
    const dir = makeEditedProject(makeRunsConfig({ commands: { "test:unit": "exit 1" } }));
    writeTrace(dir, [start("ag1", "coder")]);
    for (let i = 0; i < 3; i++) {
      const r = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
      expect(r.json.decision, `deferred Stop #${i + 1} must not itself be a block`).toBeUndefined();
    }
    expect(readLedger(dir), "none of the three deferrals may write a ledger line").toEqual([]);
    expect(sessionStateOf(dir).stopBlocks, "none of the three deferrals may count toward maxBlocks").toBe(0);

    writeTrace(dir, [start("ag1", "coder"), hookStop("ag1", "coder"), { event: "SubagentStop", agent: "ag1", agentType: "coder", decision: "allow" }]);
    const r = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
    expect(r.json.decision).toBe("block");
    expect(r.json.reason).toContain("(1/3)");
    expect(readLedger(dir)).toHaveLength(1);
  });

  it("G7 end to end through the real hooks: the gate's own SubagentStop trace lines carry decision block then allow, and a main Stop defers in between", () => {
    const dir = makeEditedProject(
      makeRunsConfig({
        commands: { "test:unit": `${process.execPath} -e "require('fs').appendFileSync('${runsLogRelpath}','x'); process.exit(1)"` },
      }),
    );
    runHookScript("trace", { hook_event_name: "SubagentStart", agent_id: "ag1", agent_type: "tester" }, { dir });
    // A change line for ag1 so the read-only-subagent-skip card (stop-gate-read-only-subagent-skip) does not
    // itself skip verification here — this card's deferral is what is under test, not that one.
    runHookScript("trace", { hook_event_name: "PostToolUse", agent_id: "ag1", agent_type: "tester", tool_name: "Edit", tool_response: {} }, { dir });

    const blocked = runHookScript("stop-gate", { hook_event_name: "SubagentStop", agent_id: "ag1", agent_type: "tester" }, { dir });
    expect(blocked.json.decision).toBe("block");
    expect(runsCount(dir)).toBe(1);
    runHookScript("trace", { hook_event_name: "SubagentStop", agent_id: "ag1", agent_type: "tester" }, { dir }); // the hook's own undecorated line

    const deferred = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
    expect(deferred.json.decision, "one blocked stop event balanced by one undecorated stop event is still in flight (rule B)").toBeUndefined();
    expect(runsCount(dir), "a deferred main Stop must not run the commands").toBe(1);

    writeFileSync(
      join(dir, ".doug/config.json"),
      JSON.stringify(makeRunsConfig()), // the command now passes
    );
    const allowed = runHookScript("stop-gate", { hook_event_name: "SubagentStop", agent_id: "ag1", agent_type: "tester" }, { dir });
    expect(allowed.json).toBeNull();
    expect(runsCount(dir)).toBe(2);

    // The allowed SubagentStop's own green run just recorded state.verified for this exact tree (card
    // stop-gate-process-storm, case 2); appending to the file the session already edited defeats that
    // pre-existing verified-unchanged skip, so the final Stop below exercises this card's own point — the
    // first Stop after the agent stops runs the full gate — rather than a different skip landing first.
    appendFileSync(join(dir, "src/a.ts"), "\nmore edits this session");
    const runsBeforeFinal = runsCount(dir);
    const finalStop = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
    expect(
      finalStop.json === null || !(finalStop.json.systemMessage || "").includes("Verification deferred"),
      "the agent's SubagentStop was allowed, so it is gone and this Stop must not defer",
    ).toBe(true);
    expect(runsCount(dir), "the main Stop now runs the commands").toBe(runsBeforeFinal + 1);

    const gateLines = tracedLines(dir).filter((l) => l.event === "SubagentStop" && l.agent === "ag1" && "decision" in l);
    expect(gateLines.map((l) => l.decision)).toEqual(["block", "allow"]);
  });

  it("G8 the three existing reason-carrying SubagentStop trace lines (verified-unchanged, no-agent-changes, tests_red_by_design) still carry their reasons, now alongside decision: allow", () => {
    // no-agent-changes (card stop-gate-read-only-subagent-skip, T1): a researcher with only Read lines.
    const dir = makeEditedProject(makeRunsConfig());
    writeTrace(dir, [start("ag1", "researcher"), { event: "PreToolUse", agent: "ag1", agentType: "researcher", tool: "Read" }, { event: "PostToolUse", agent: "ag1", agentType: "researcher", tool: "Read", ok: true }]);
    runHookScript("stop-gate", { hook_event_name: "SubagentStop", agent_id: "ag1", agent_type: "researcher" }, { dir });
    const noAgentChanges = tracedLines(dir).find((l) => l.event === "SubagentStop" && l.reason === "no-agent-changes");
    expect(noAgentChanges, "the no-agent-changes trace line must still be written").toBeTruthy();
    expect(noAgentChanges.decision, "it is an allow path, so it must now also carry decision: allow").toBe("allow");

    // verified-unchanged (card stop-gate-process-storm, case 2): a second SubagentStop against an
    // already-verified tree.
    const dir2 = makeEditedProject(makeRunsConfig());
    runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir: dir2 }); // records state.verified on the main Stop
    const r2 = runHookScript("stop-gate", { hook_event_name: "SubagentStop", agent_id: "ag2", agent_type: "coder" }, { dir: dir2 });
    expect(r2.json).toBeNull();
    const verifiedUnchanged = tracedLines(dir2).find((l) => l.event === "SubagentStop" && l.reason === "verified-unchanged");
    expect(verifiedUnchanged, "the verified-unchanged trace line must still be written").toBeTruthy();
    expect(verifiedUnchanged.decision).toBe("allow");

    // tests_red_by_design (card subagent-stop-gate-tester-red): a tester's claim covering the one failing file.
    const dir3 = makeEditedProject(makeRunsConfig({ commands: { "test:unit": "echo ' FAIL  src/a.test.mjs > it'; exit 1" } }));
    writeFileSync(join(dir3, "src/a.test.mjs"), "it fails on purpose");
    runHookScript("edit-loop", { tool_name: "Write", tool_input: { file_path: "src/a.test.mjs" } }, { dir: dir3 });
    const claimInput = {
      hook_event_name: "SubagentStop",
      agent_id: "ag3",
      agent_type: "tester",
      last_assistant_message: `Ran the new test; it fails as designed.\n${JSON.stringify({ tests_red_by_design: ["src/a.test.mjs"] })}`,
    };
    const r3 = runHookScript("stop-gate", claimInput, { dir: dir3 });
    expect(r3.json.decision).toBeUndefined();
    const redByDesign = tracedLines(dir3).find((l) => l.event === "SubagentStop" && l.reason === "tests_red_by_design");
    expect(redByDesign, "the tests_red_by_design trace line must still be written").toBeTruthy();
    expect(redByDesign.decision).toBe("allow");
  });

  it("G9 (review major 2) a tree problem found while an agent is in flight still blocks: the deferral never swallows a real protected-path hit", () => {
    const dir = makeEditedProject(makeRunsConfig());
    writeFileSync(join(dir, ".env"), "SECRET=1"); // dirty, protected (baseConfig.protectedPaths), never touched by the Edit tool
    writeTrace(dir, [start("ag1", "coder")]);
    const r = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
    expect(r.json.decision).toBe("block");
    expect(r.json.reason).toContain("Protected files were modified");
    expect(readLedger(dir), "a real block, not a deferral, so it is logged exactly once").toHaveLength(1);
  });

  it("G10 (review minor 3) a later SubagentStart for the same id restarts the clock: an earlier allowed SubagentStop before it does not count", () => {
    const dir = makeEditedProject(makeRunsConfig());
    writeTrace(dir, [
      start("ag1", "coder"),
      hookStop("ag1", "coder"),
      { event: "SubagentStop", agent: "ag1", agentType: "coder", decision: "allow" },
      start("ag1", "coder"), // ag1 started again; the allow above predates this start and must not count for it
    ]);
    const r = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
    expect(r.json.decision).toBeUndefined();
    expect(r.json.systemMessage).toContain("Verification deferred");
    expect(runsCount(dir)).toBe(0);
  });

  // card test-count-ratchet, review B1: the count check's "did not run" note must not be a decision-less
  // SubagentStop line, or subagentsInFlight (rule B: more undecided stop lines than blocked ones) reads a
  // blocked agent as gone and the lead's Stop stops deferring. The single-command deferral tests above never
  // had a green command beside the failing one, so none reached the note.
  describe("count-check note does not end an agent's flight (card test-count-ratchet, review B1)", () => {
    const twoCommands = (greenCommand) =>
      makeRunsConfig({
        commands: { typecheck: greenCommand, "test:unit": "exit 1" },
        stopGate: { commands: ["typecheck", "test:unit"], onlyIfEdited: true, maxBlocks: 3, timeoutMs: 10000, requireEvidence: false },
      });

    function blockedThenLeadStop(greenCommand) {
      const dir = makeEditedProject(twoCommands(greenCommand));
      runHookScript("trace", { hook_event_name: "SubagentStart", agent_id: "ag1", agent_type: "coder" }, { dir });
      runHookScript("trace", { hook_event_name: "PostToolUse", agent_id: "ag1", agent_type: "coder", tool_name: "Edit", tool_response: {} }, { dir });
      const sub = runHookScript("stop-gate", { hook_event_name: "SubagentStop", agent_id: "ag1", agent_type: "coder" }, { dir });
      expect(sub.json && sub.json.decision, "fixture check: the failing test:unit blocks the subagent").toBe("block");
      const undecidedAfterGate = tracedLines(dir).filter((l) => l.event === "SubagentStop" && l.agent === "ag1" && l.decision == null);
      runHookScript("trace", { hook_event_name: "SubagentStop", agent_id: "ag1", agent_type: "coder" }, { dir }); // the trace hook's own undecorated line
      const lead = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
      return { dir, undecidedAfterGate, lead };
    }

    it("B1 a green command with no summary beside a red one: the lead's Stop still defers", () => {
      const { lead } = blockedThenLeadStop("exit 0");
      expect(lead.json.decision, "the blocked coder is still working, so the lead's Stop must defer, not block").toBeUndefined();
      expect(lead.json.systemMessage).toContain("Verification deferred");
      expect(lead.json.systemMessage).toContain("coder:ag1");
    });

    it("B1 mechanism: the blocked SubagentStop leaves no SubagentStop line lacking a decision for that agent", () => {
      const { undecidedAfterGate } = blockedThenLeadStop("exit 0");
      expect(undecidedAfterGate, "only the trace hook writes decision-less SubagentStop lines").toEqual([]);
    });

    it("B1 sibling (no baseline): a green command that prints a summary but has no baseline still leaves the flight standing", () => {
      const { lead, undecidedAfterGate } = blockedThenLeadStop("printf ' Tests  5 passed (5)\\n'");
      expect(undecidedAfterGate).toEqual([]);
      expect(lead.json.decision).toBeUndefined();
      expect(lead.json.systemMessage).toContain("Verification deferred");
      expect(lead.json.systemMessage).toContain("coder:ag1");
    });
  });

  describe("card stop-gate-deferral-cap", () => {
    // Same shape as makeRunsConfig(extra) above, but replacing the whole stopGate object (extra spreads over
    // top-level config keys, not merging inside stopGate) so a test can add maxDeferrals while keeping the
    // other stopGate settings makeRunsConfig's default already carries.
    function withMaxDeferrals(maxDeferrals, extra = {}, stopGateExtra = {}) {
      return makeRunsConfig({
        stopGate: { commands: ["test:unit"], onlyIfEdited: true, maxBlocks: 3, timeoutMs: 10000, requireEvidence: false, maxDeferrals, ...stopGateExtra },
        ...extra,
      });
    }

    it("H1 default cap (no stopGate.maxDeferrals set): the 10th consecutive deferred Stop runs the full gate", () => {
      const dir = makeEditedProject(makeRunsConfig());
      writeTrace(dir, [start("ag1", "coder")]);
      for (let i = 1; i <= 9; i++) {
        const r = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
        expect(r.json.decision, `Stop #${i} (below the default cap of 10) must not itself be a block`).toBeUndefined();
        expect(r.json.systemMessage.toLowerCase(), `Stop #${i} (below the default cap of 10) must still defer`).toContain("deferred");
        expect(runsCount(dir), `Stop #${i} must not run the commands yet`).toBe(0);
      }
      const r10 = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
      expect(runsCount(dir), "the 10th consecutive deferred Stop must hit the default cap (10) and run the commands").toBe(1);
      expect(r10.json.systemMessage, "the cap message must say the cap was reached").toContain("Deferral cap reached");
      expect(r10.json.systemMessage, "the cap message must name the default cap (10)").toContain("10");
      expect(r10.json.systemMessage, "the cap message must name the agent still in flight (agentLabel form)").toContain("coder:ag1");
      expect(sessionStateOf(dir).deferrals, "the counter must reset to 0 once the cap makes the gate run").toBe(0);
    });

    it("H2 a configured stopGate.maxDeferrals (3) runs the commands on the 3rd consecutive deferred Stop, not the default 10th", () => {
      const dir = makeEditedProject(withMaxDeferrals(3));
      writeTrace(dir, [start("ag1", "coder")]);
      for (let i = 1; i <= 2; i++) {
        const r = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
        expect(r.json.systemMessage.toLowerCase(), `Stop #${i} (below maxDeferrals 3) must still defer`).toContain("deferred");
        expect(runsCount(dir), `Stop #${i} must not run the commands yet`).toBe(0);
      }
      const r3 = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
      expect(runsCount(dir), "the 3rd consecutive deferred Stop must hit maxDeferrals 3 and run the commands").toBe(1);
      expect(r3.json.systemMessage, "the cap message must say the cap was reached").toContain("Deferral cap reached");
    });

    it("H3 a SubagentStop of this session resets the counter, so the cap counts again from 1 afterwards", () => {
      const dir = makeEditedProject(withMaxDeferrals(3));
      writeTrace(dir, [start("ag1", "coder")]);
      runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
      runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
      expect(sessionStateOf(dir).deferrals, "two deferred Stops in a row must have counted to 2").toBe(2);

      // ag1 stays in flight (the trace is untouched); only a SubagentStop event of this session runs, for a
      // different agent (ag2), and it alone must reset the counter (rule R6).
      runHookScript("stop-gate", { hook_event_name: "SubagentStop", agent_id: "ag2", agent_type: "researcher" }, { dir });
      expect(sessionStateOf(dir).deferrals, "a SubagentStop of this session must reset the counter to 0 right away").toBe(0);

      const runsBefore = runsCount(dir);
      for (let i = 1; i <= 2; i++) {
        const r = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
        expect(r.json.systemMessage.toLowerCase(), `Stop #${i} after the reset must still defer: ag1 never stopped, and the count restarted from 0`).toContain("deferred");
      }
      expect(runsCount(dir), "the two main Stops after the reset must not run the commands (count restarted, not carried over as 2+2)").toBe(runsBefore);
      const r3 = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
      expect(runsCount(dir), "the 3rd main Stop after the reset must hit maxDeferrals 3 (counting from the reset) and run").toBe(runsBefore + 1);
    });

    it("H4 a Stop that runs the gate itself (no agent in flight) also resets the counter", () => {
      const dir = makeEditedProject(withMaxDeferrals(3));
      writeTrace(dir, [start("ag1", "coder")]);
      runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
      runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
      expect(sessionStateOf(dir).deferrals, "two deferred Stops in a row must have counted to 2").toBe(2);

      // ag1 gets an allowed SubagentStop, so the next Stop finds nobody in flight and runs the ordinary gate.
      writeTrace(dir, [start("ag1", "coder"), hookStop("ag1", "coder"), { event: "SubagentStop", agent: "ag1", agentType: "coder", decision: "allow" }]);
      const r = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
      expect(runsCount(dir), "ag1 is gone, so this Stop must run the full gate rather than defer").toBe(1);
      expect(sessionStateOf(dir).deferrals, "a Stop that runs the gate itself must reset the counter to 0").toBe(0);

      // Defeat the pre-existing verified-unchanged skip (card stop-gate-process-storm) the same way test G7
      // does, so the Stops below actually reach the deferral check point instead of shortcutting on a tree
      // that still matches the fingerprint the Stop above just recorded.
      appendFileSync(join(dir, "src/a.ts"), "\nmore edits this session");
      writeTrace(dir, [start("ag1", "coder"), hookStop("ag1", "coder"), { event: "SubagentStop", agent: "ag1", agentType: "coder", decision: "allow" }, start("ag3", "coder")]);
      for (let i = 1; i <= 2; i++) {
        const rr = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
        expect(rr.json.systemMessage.toLowerCase(), `Stop #${i} after ag3 starts must defer from a fresh count of 0, not carry the old counter over`).toContain("deferred");
      }
      expect(runsCount(dir), "still only 1 run: the two Stops after ag3 starts must not run the commands").toBe(1);
      runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
      expect(runsCount(dir), "the 3rd Stop after ag3 starts hits maxDeferrals 3 (counted fresh) and runs (runsCount 2)").toBe(2);
    });

    it.each([0, "ten", -1])("H5 a garbage stopGate.maxDeferrals (%j) behaves as the default cap (10)", (garbage) => {
      const dir = makeEditedProject(withMaxDeferrals(garbage));
      writeTrace(dir, [start("ag1", "coder")]);
      for (let i = 1; i <= 9; i++) {
        const r = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
        expect(r.json.systemMessage.toLowerCase(), `garbage maxDeferrals ${JSON.stringify(garbage)}: Stop #${i} must still defer as though the cap were the default 10`).toContain("deferred");
      }
      expect(runsCount(dir), `garbage maxDeferrals ${JSON.stringify(garbage)}: none of the first 9 Stops may run the commands`).toBe(0);
      const r10 = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
      expect(runsCount(dir), `garbage maxDeferrals ${JSON.stringify(garbage)}: Stop 10 must fall back to the default cap and run the commands`).toBe(1);
      expect(r10.json.systemMessage, `garbage maxDeferrals ${JSON.stringify(garbage)}: the cap message must name the default cap (10)`).toContain("10");
    });

    it("H6 the cap running the gate can still fail: a real block at the cap counts toward maxBlocks like any other block", () => {
      const dir = makeEditedProject(withMaxDeferrals(2, { commands: { "test:unit": "exit 1" } }));
      writeTrace(dir, [start("ag1", "coder")]);
      const r1 = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
      expect(r1.json.decision, "Stop 1 (below maxDeferrals 2) must defer, not block").toBeUndefined();
      const r2 = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
      expect(r2.json.decision, "Stop 2 hits the cap, runs the failing command, and must block for real").toBe("block");
      expect(r2.json.reason, "the block reason must carry the cap sentence").toContain("Deferral cap reached");
      expect(r2.json.reason, "the block reason must still carry the ordinary (n/max) block count, unaffected by the cap").toContain("(1/3)");
      expect(readLedger(dir), "a real block at the cap must be logged exactly once, like any other block").toHaveLength(1);
    });

    it("H7 an old state file with no deferrals key reads it as 0, never throws, and counts up again from there", () => {
      const dir = makeEditedProject(withMaxDeferrals(3));
      writeTrace(dir, [start("ag1", "coder")]);
      runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir }); // Stop 1: state.deferrals is now 1

      const statePath = join(dir, ".doug/.state/test-session.json");
      const state = sessionStateOf(dir);
      expect(state.deferrals, "sanity: Stop 1 must have counted to 1 before the old file is simulated").toBe(1);
      delete state.deferrals;
      writeFileSync(statePath, JSON.stringify(state)); // simulate a state file saved before this card existed

      for (let i = 2; i <= 3; i++) {
        const r = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
        expect(r.status, `Stop #${i} must exit 0 even though state.deferrals was missing on disk`).toBe(0);
        expect(r.json, `Stop #${i}'s stdout must still parse as JSON`).not.toBeNull();
        expect(r.json.systemMessage.toLowerCase(), `Stop #${i}: a missing deferrals key must read as 0, restarting the count rather than throwing or mis-counting`).toContain("deferred");
      }
      const r4 = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
      expect(r4.status, "Stop 4 must exit 0").toBe(0);
      expect(runsCount(dir), "counting from the repaired 0, the 4th Stop (3 consecutive deferrals since the missing key) hits maxDeferrals 3 and runs").toBe(1);
    });

    it("H8 a real tree problem found while at (or under) the cap still resets the counter (R5), and never carries the cap sentence", () => {
      const dir = makeEditedProject(withMaxDeferrals(3));
      writeTrace(dir, [start("ag1", "coder")]);
      runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
      runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
      expect(sessionStateOf(dir).deferrals, "two deferred Stops in a row must have counted to 2").toBe(2);

      // A real protected-path hit while ag1 is still in flight (same fixture as test G9 above).
      writeFileSync(join(dir, ".env"), "SECRET=1"); // dirty, protected (baseConfig.protectedPaths), never touched by the Edit tool
      const r = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
      expect(r.json.decision, "a real protected-path problem must block for real, not defer").toBe("block");
      expect(r.json.reason, "the block reason must name the real problem").toContain("Protected files were modified");
      expect(r.json.reason, "a real tree-problem block is not the cap running the gate, so it must never carry the cap sentence").not.toContain("Deferral cap reached");
      expect(sessionStateOf(dir).deferrals, "a real tree problem found while an agent is in flight must still reset the counter (R5), same as any other Stop that does not defer").toBe(0);
    });

    it("H9 a lock-contention reload keeps the counter reset on a main Stop (R6 must not be conditioned on `subagent`)", () => {
      const dir = makeEditedProject(withMaxDeferrals(3, {}, { timeoutMs: 1200 }));
      writeTrace(dir, [start("ag1", "coder")]);
      runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
      runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
      expect(sessionStateOf(dir).deferrals, "two deferred Stops in a row must have counted to 2").toBe(2);

      // A live lock held by another session (a real pid — this test's own — so pidIsLive is true, and a fresh
      // `at` so it is not stale by age): the 3rd Stop hits the cap, cannot take gate.lock, and waits out
      // stopGate.timeoutMs (1200ms here) before reloading state from disk and taking the lock over itself.
      mkdirSync(join(dir, ".doug/.state"), { recursive: true });
      writeFileSync(join(dir, ".doug/.state/gate.lock"), JSON.stringify({ pid: process.pid, session: "other-session", at: Date.now() }));

      const r3 = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
      expect(runsCount(dir), "the 3rd consecutive deferred Stop hits the cap, waits out the contended lock, and still runs the commands").toBe(1);
      expect(r3.json.systemMessage, "the cap message must say the cap was reached").toContain("Deferral cap reached");
      expect(
        sessionStateOf(dir).deferrals,
        "the reset applied when the cap was hit (R5) must survive the lock-wait reload of state from disk, on a main Stop exactly as on a SubagentStop (R6)",
      ).toBe(0);

      // Defeat the pre-existing verified-unchanged skip (card stop-gate-process-storm), same technique as
      // test H4 above, so this next Stop actually reaches the deferral check instead of shortcutting.
      appendFileSync(join(dir, "src/a.ts"), "\nmore edits this session");
      const r4 = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
      expect(runsCount(dir), "ag1 is still in flight, so this 4th Stop must defer rather than run again").toBe(1);
      expect(r4.json.systemMessage.toLowerCase(), "with the counter correctly reset by the cap Stop, this next Stop must defer from a fresh count of 1, not immediately hit the cap again").toContain("deferred");
    });
  });
});

describe("checkpoint-on-green", () => {
  const git = (dir, ...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
  function repo(checkpoint, config = baseConfig) {
    const dir = makeProject({ config: { ...config, checkpoint }, git: true });
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src/a.ts"), "export const a = 1");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "base");
    writeFileSync(join(dir, "src/a.ts"), "export const a = 2");
    writeFileSync(join(dir, "src/b.ts"), "export const b = 1");
    return dir;
  }
  it("is off by default: a green gate leaves the repo alone", () => {
    const dir = repo(undefined);
    expect(runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir }).json).toBeNull();
    expect(git(dir, "rev-list", "--count", "HEAD")).toBe("1");
  });
  it("commit mode records a checkpoint commit on the current branch when the gate passes", () => {
    const dir = repo({ enabled: true, mode: "commit" });
    mkdirSync(join(dir, ".claude/worktrees/wf_1"), { recursive: true });
    writeFileSync(join(dir, ".claude/worktrees/wf_1/junk.ts"), "");
    const r = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
    expect(r.json.decision).toBeUndefined();
    expect(r.json.systemMessage).toMatch(/Checkpoint committed as [0-9a-f]{7,} on main\./);
    expect(git(dir, "rev-list", "--count", "HEAD")).toBe("2");
    expect(git(dir, "log", "-1", "--format=%B")).toContain("doug: checkpoint\n\ngate: test ok");
    expect(git(dir, "ls-tree", "-r", "--name-only", "HEAD").split("\n").sort()).toEqual([".doug/config.json", "src/a.ts", "src/b.ts"]);
    expect(git(dir, "status", "--porcelain", "--untracked-files=all").split("\n").map((l) => l.trim()).sort()).toEqual(["?? .claude/worktrees/wf_1/junk.ts", "?? .doug/.state/test-session.json", "?? .doug/.state/trace/test-session.jsonl"]);
    const state = JSON.parse(readFileSync(join(dir, ".doug/.state/test-session.json"), "utf8"));
    expect(state.lastCheckpoint.mode).toBe("commit");
    expect(state.lastCheckpoint.ref).toBe("main");
    // A second green stop with the state file present (no .gitignore here) must not commit the state dir.
    writeFileSync(join(dir, "src/b.ts"), "export const b = 2");
    runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
    expect(git(dir, "rev-list", "--count", "HEAD")).toBe("3");
    expect(git(dir, "ls-tree", "-r", "--name-only", "HEAD")).not.toContain(".doug/.state");
  });
  it("tag mode tags a commit built from a temporary index and touches nothing else", () => {
    const dir = repo({ enabled: true, mode: "tag" });
    const head = git(dir, "rev-parse", "HEAD");
    const r = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
    expect(r.json.systemMessage).toMatch(/Checkpoint tagged doug\/checkpoint\/\d{8}T\d{6}Z \([0-9a-f]{7}\)/);
    expect(r.json.systemMessage).toContain("git checkout doug/checkpoint/");
    const tags = git(dir, "tag", "-l", "doug/checkpoint/*").split("\n").filter(Boolean);
    expect(tags).toHaveLength(1);
    expect(git(dir, "rev-parse", "HEAD")).toBe(head);
    expect(git(dir, "rev-parse", `${tags[0]}^`)).toBe(head);
    expect(git(dir, "ls-tree", "-r", "--name-only", tags[0])).toContain("src/b.ts");
    expect(git(dir, "show", `${tags[0]}:src/a.ts`)).toBe("export const a = 2");
    expect(git(dir, "diff", "--cached", "--name-only")).toBe(""); // real index untouched
    expect(git(dir, "status", "--porcelain").split("\n").map((l) => l.trim()).sort()).toEqual(["?? .doug/.state/", "?? src/b.ts", "M src/a.ts"]);
  });
  it("never runs while a protected path is dirty, even one the Stop scan ignores", () => {
    const dir = repo({ enabled: true, mode: "commit" }, { ...baseConfig, stopGate: { ...baseConfig.stopGate, ignoreChangedPaths: ["pnpm-lock.yaml"] } });
    writeFileSync(join(dir, "pnpm-lock.yaml"), "lockfileVersion: 9");
    const r = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
    expect(r.json.decision).toBeUndefined();
    expect(r.json.systemMessage).toContain("Checkpoint skipped: protected path dirty: pnpm-lock.yaml");
    expect(git(dir, "rev-list", "--count", "HEAD")).toBe("1");
  });
  it("does not checkpoint a failing gate and reports a bad mode instead of guessing", () => {
    const failing = repo({ enabled: true, mode: "commit" }, { ...baseConfig, commands: { test: "exit 1" } });
    expect(runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir: failing }).json.decision).toBe("block");
    expect(git(failing, "rev-list", "--count", "HEAD")).toBe("1");
    const bad = repo({ enabled: true, mode: "stash" });
    const r = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir: bad });
    expect(r.json.systemMessage).toContain("Checkpoint failed: checkpoint.mode must be one of commit, tag");
    expect(git(bad, "rev-list", "--count", "HEAD")).toBe("1");
  });
});

describe("reanchor", () => {
  it("emits anchor lines, commands, and the anchor file", () => {
    const dir = makeProject({ config: baseConfig });
    writeFileSync(join(dir, ".doug/anchor.md"), "Task: implement X. Owned files: src/x.ts");
    const r = runHookScript("reanchor", { hook_event_name: "SessionStart", source: "compact" }, { dir });
    const ctx = context(r);
    expect(ctx).toContain("Use pnpm, never npm.");
    expect(ctx).toContain("test: node -e");
    expect(ctx).toContain("Owned files: src/x.ts");
    expect(r.json.hookSpecificOutput.hookEventName).toBe("SessionStart");
  });
  it("puts the compaction snapshot first, ahead of the 4000-char cap, when the anchor's hand-written head is long", () => {
    const dir = makeProject({ config: baseConfig });
    const head = "# Old task\n\n" + "x".repeat(4200) + "\n";
    const section = "## Compaction snapshot (doug, 2026-09-09T19:21:42.000Z)\n\nPlan: none in .doug/plan.json";
    const block = `${SNAPSHOT_START}\n${section}\n${SNAPSHOT_END}\n`;
    writeFileSync(join(dir, ".doug/anchor.md"), head + "\n" + block);
    const r = runHookScript("reanchor", { hook_event_name: "SessionStart", source: "compact" }, { dir });
    const ctx = context(r);
    expect(ctx).toContain("Compaction snapshot (doug");
    expect(ctx.indexOf("Compaction snapshot (doug")).toBeLessThan(4000);
  });
  it("PostCompact emits no output at all, even with an anchor and config present", () => {
    const dir = makeProject({ config: baseConfig });
    writeFileSync(join(dir, ".doug/anchor.md"), "Task: implement X. Owned files: src/x.ts");
    const r = runHookScript("reanchor", { hook_event_name: "PostCompact" }, { dir });
    expect(r.status).toBe(0);
    expect(r.json).toBeNull();
    const empty = makeProject({ config: { anchor: [], commands: {} } });
    expect(runHookScript("reanchor", { hook_event_name: "PostCompact" }, { dir: empty }).json).toBeNull();
  });
  it("(ix) clears state.context on PostCompact (card context-window-handoff)", () => {
    const dir = makeProject({ config: { ...baseConfig, contextWindow: { enabled: true, threshold: 80, repeatAfter: 5 } } });
    mkdirSync(join(dir, ".doug/.state"), { recursive: true });
    writeFileSync(join(dir, ".doug/.state/test-session.json"), JSON.stringify({ context: { pct: 90, at: new Date().toISOString(), notifiedAt: 90 } }));
    const r = runHookScript("reanchor", { hook_event_name: "PostCompact" }, { dir });
    expect(r.json).toBeNull();
    const state = JSON.parse(readFileSync(join(dir, ".doug/.state/test-session.json"), "utf8"));
    expect(state.context).toBeUndefined();
  });
});

describe("splitSnapshot (lib/anchor.mjs)", () => {
  it("extracts the snapshot block and the rest, in original order", () => {
    const rest = "# Head\n\nHand notes.\n";
    const section = "## Compaction snapshot (doug, now)\n\nPlan: none";
    const text = rest + "\n" + SNAPSHOT_START + "\n" + section + "\n" + SNAPSHOT_END + "\n";
    const { snapshot, rest: r } = splitSnapshot(text);
    expect(snapshot).toContain(section);
    expect(snapshot.startsWith(SNAPSHOT_START)).toBe(true);
    expect(snapshot.endsWith(SNAPSHOT_END)).toBe(true);
    expect(r.trim()).toBe(rest.trim());
  });
  it("returns a null snapshot and the whole text as rest when there is no snapshot section", () => {
    const text = "just hand-written notes";
    const { snapshot, rest } = splitSnapshot(text);
    expect(snapshot).toBeNull();
    expect(rest).toBe(text);
  });
});

describe("reanchor on PreCompact (card precompact-anchor)", () => {
  it("snapshots the plan, ownership, decisions, edited files, and recent commands into the anchor, keeps the rest, and tells the user", () => {
    const dir = makeProject({ config: baseConfig });
    writeFileSync(join(dir, ".doug/plan.json"), JSON.stringify({ version: 1, title: "Fix hours", status: "approved", card: "fix-hours", tasks: [{ id: "fix", files: ["src/duration.ts", "tests/duration.test.ts"] }] }));
    mkdirSync(join(dir, "docs/decisions"), { recursive: true });
    writeFileSync(join(dir, "docs/decisions/0001-x.md"), "# x");
    writeFileSync(join(dir, "docs/decisions/notes.txt"), "not a decision");
    writeFileSync(join(dir, ".doug/anchor.md"), "# Fix hours\n\nMy own notes stay.\n");
    runHookScript("edit-loop", { tool_name: "Edit", tool_input: { file_path: "src/duration.ts" } }, { dir });
    runHookScript("guard-bash", { tool_name: "Bash", tool_input: { command: "pnpm test" } }, { dir });
    const r = runHookScript("reanchor", { hook_event_name: "PreCompact", compaction_trigger: "auto", estimated_tokens_before: 150000, estimated_tokens_after: 20000 }, { dir });
    expect(r.status).toBe(0);
    expect(r.json.hookSpecificOutput).toBeUndefined();
    expect(r.json.systemMessage).toContain("Compacting");
    expect(r.json.systemMessage).toContain(".doug/anchor.md");
    expect(r.json.systemMessage).toContain("re-injects it after compaction");
    expect(r.json.systemMessage).not.toMatch(/150000|20000|estimat/);
    const anchor = readFileSync(join(dir, ".doug/anchor.md"), "utf8");
    expect(anchor.startsWith("# Fix hours\n\nMy own notes stay.\n\n<!-- doug:compaction-snapshot start -->\n## Compaction snapshot (doug, ")).toBe(true);
    expect(anchor).toContain("Plan: Fix hours [approved] (card fix-hours)");
    expect(anchor).toContain("- fix owns src/duration.ts, tests/duration.test.ts");
    expect(anchor).toContain("Decisions (docs/decisions): 0001-x.md");
    expect(anchor).toContain("Edited this session: src/duration.ts");
    expect(anchor).toContain("Recent commands:\n- pnpm test");
    expect(anchor.endsWith("<!-- doug:compaction-snapshot end -->\n")).toBe(true);
    expect(anchor).not.toMatch(/150000|estimat/);
    // A second compaction replaces the section instead of stacking another one.
    runHookScript("guard-bash", { tool_name: "Bash", tool_input: { command: "pnpm typecheck" } }, { dir });
    runHookScript("reanchor", { hook_event_name: "PreCompact" }, { dir });
    const again = readFileSync(join(dir, ".doug/anchor.md"), "utf8");
    expect(again.split("compaction-snapshot start").length).toBe(2);
    expect(again).toContain("- pnpm typecheck");
    expect(again.startsWith("# Fix hours\n\nMy own notes stay.\n\n")).toBe(true);
    // PostCompact emits nothing; SessionStart(compact) carries the snapshot, reordered ahead of the hand-written text.
    const post = runHookScript("reanchor", { hook_event_name: "PostCompact" }, { dir });
    expect(post.json).toBeNull();
    const sessionStart = context(runHookScript("reanchor", { hook_event_name: "SessionStart", source: "compact" }, { dir }));
    expect(sessionStart).toContain("Compaction snapshot (doug");
    expect(sessionStart.indexOf("Compaction snapshot (doug")).toBeLessThan(sessionStart.indexOf("My own notes stay"));
  });
  it("creates the anchor when there is none and says so when there is no plan or decisions", () => {
    const dir = makeProject({ config: baseConfig });
    runHookScript("reanchor", { hook_event_name: "PreCompact" }, { dir });
    const anchor = readFileSync(join(dir, ".doug/anchor.md"), "utf8");
    expect(anchor.startsWith("<!-- doug:compaction-snapshot start -->")).toBe(true);
    expect(anchor).toContain("Plan: none in .doug/plan.json");
    expect(anchor).toContain("Decisions: none under docs/decisions");
    expect(anchor).toContain("Edited this session: nothing yet");
    expect(anchor).toContain("Recent commands: none");
  });

  it("(a) trigger manual, with a recorded gate and context pct, carries them into the Handoff boundary block (card precompact-keeps-handoff)", () => {
    const dir = makeProject({ config: baseConfig, git: true });
    writeFileSync(join(dir, "a.txt"), "x");
    execFileSync("git", ["add", "-A"], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", "base"], { cwd: dir });
    mkdirSync(join(dir, ".doug/.state"), { recursive: true });
    const at = Date.now();
    writeFileSync(join(dir, ".doug/.state/test-session.json"), JSON.stringify({ lastGate: { ok: true, at }, context: { pct: 85 } }));
    const r = runHookScript("reanchor", { hook_event_name: "PreCompact", trigger: "manual" }, { dir });
    expect(r.status).toBe(0);
    expect(r.json.hookSpecificOutput).toBeUndefined();
    const anchor = readFileSync(join(dir, ".doug/anchor.md"), "utf8");
    expect(anchor).toContain("### Handoff boundary");
    expect(anchor).toContain("Boundary: compaction (manual)");
    expect(anchor).toMatch(/Gate: green \(at \d{4}-\d{2}-\d{2}T/);
    expect(anchor).toMatch(/HEAD: [0-9a-f]{7,} \(main\)/);
    expect(anchor).toContain("Context: 85%");
  });

  it("(b) trigger auto, no lastGate, no context, outside a git repo: no Gate line, HEAD unknown, no Context line", () => {
    const dir = makeProject({ config: baseConfig });
    const r = runHookScript("reanchor", { hook_event_name: "PreCompact", trigger: "auto" }, { dir });
    expect(r.status).toBe(0);
    const anchor = readFileSync(join(dir, ".doug/anchor.md"), "utf8");
    expect(anchor).toContain("### Handoff boundary");
    expect(anchor).toContain("Boundary: compaction (auto)");
    expect(anchor).not.toContain("Gate:");
    expect(anchor).toContain("HEAD: unknown");
    expect(anchor).not.toContain("Context:");
  });

  it("(c) an absent trigger counts as auto", () => {
    const dir = makeProject({ config: baseConfig });
    const r = runHookScript("reanchor", { hook_event_name: "PreCompact" }, { dir });
    expect(r.status).toBe(0);
    const anchor = readFileSync(join(dir, ".doug/anchor.md"), "utf8");
    expect(anchor).toContain("Boundary: compaction (auto)");
  });

  it("(d) a green Stop's handoff survives a following PreCompact, now under the compaction boundary", () => {
    const contextConfig = { ...baseConfig, contextWindow: { enabled: true, threshold: 80, repeatAfter: 5 } };
    const dir = makeProject({ config: contextConfig, git: true });
    execFileSync("git", ["add", "-A"], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", "base"], { cwd: dir });
    runHookScript("statusline", { context_window: { used_percentage: 85 } }, { dir });
    runHookScript("edit-loop", { tool_name: "Edit", tool_input: { file_path: "a.ts" } }, { dir }); // verification passes: state.lastGate gets set
    const stop = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
    expect(stop.json.systemMessage).toContain("Context at 85%");
    const afterStop = readFileSync(join(dir, ".doug/anchor.md"), "utf8");
    expect(afterStop).toContain("Boundary: verification passed");
    expect(afterStop).toContain("Gate: green");

    const pre = runHookScript("reanchor", { hook_event_name: "PreCompact", trigger: "auto" }, { dir });
    expect(pre.status).toBe(0);
    const anchor = readFileSync(join(dir, ".doug/anchor.md"), "utf8");
    expect(anchor).toContain("Boundary: compaction (auto)");
    expect(anchor).toContain("Gate: green");
    expect(anchor).toMatch(/HEAD: [0-9a-f]{7,}/);
  });

  it("(e) the handoff block sits near the top, so it survives the SessionStart 4000-char cap on a long session (review MAJOR)", () => {
    const dir = makeProject({ config: baseConfig, git: true });
    execFileSync("git", ["add", "-A"], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", "base"], { cwd: dir });
    mkdirSync(join(dir, ".doug/.state"), { recursive: true });
    const editedFiles = Array.from({ length: 150 }, (_, i) => `plugins/doug-gates/tests/fixtures/some-very-long-nested-directory-name/file-${i}.ts`);
    writeFileSync(join(dir, ".doug/.state/test-session.json"), JSON.stringify({ editedFiles, lastGate: { ok: true, at: Date.now() } }));
    const pre = runHookScript("reanchor", { hook_event_name: "PreCompact", trigger: "auto" }, { dir });
    expect(pre.status).toBe(0);
    const anchor = readFileSync(join(dir, ".doug/anchor.md"), "utf8");
    const { snapshot } = splitSnapshot(anchor);
    expect(snapshot.length).toBeGreaterThan(4000); // the scenario actually exercises the cap below
    const r = runHookScript("reanchor", { hook_event_name: "SessionStart", source: "compact" }, { dir });
    const ctx = context(r);
    expect(ctx).toContain("Gate: green");
    expect(ctx).toMatch(/HEAD: [0-9a-f]{7,}/);
  });

  it("(f) a non-numeric gate.at still writes the snapshot, with Gate: green and no '(at' (review MINOR 1)", () => {
    const dir = makeProject({ config: baseConfig });
    mkdirSync(join(dir, ".doug/.state"), { recursive: true });
    writeFileSync(join(dir, ".doug/.state/test-session.json"), JSON.stringify({ lastGate: { ok: true, at: "not-a-date" } }));
    const r = runHookScript("reanchor", { hook_event_name: "PreCompact", trigger: "auto" }, { dir });
    expect(r.status).toBe(0);
    const anchor = readFileSync(join(dir, ".doug/anchor.md"), "utf8");
    expect(anchor).toContain("Gate: green");
    expect(anchor).not.toContain("(at");
  });
});

describe("robustness", () => {
  it("fails open with a visible message on garbage input", () => {
    const dir = makeProject({ config: baseConfig });
    const res = runHookScript("protect-paths", { tool_input: { file_path: 42 } }, { dir });
    expect(res.status).toBe(0);
  });
  it("state dir is created under .doug/.state", () => {
    const dir = makeProject({ config: baseConfig });
    runHookScript("edit-loop", { tool_name: "Edit", tool_input: { file_path: "a.ts" } }, { dir });
    expect(existsSync(join(dir, ".doug/.state"))).toBe(true);
  });
});

describe("trace", () => {
  it("appends one line per event, prints no decision, and reads a subagent's tokens from its transcript at SubagentStop", () => {
    const dir = makeProject({ config: baseConfig });
    const transcript = join(dir, "agent.jsonl");
    writeFileSync(transcript, JSON.stringify({ type: "assistant", message: { id: "m1", model: "claude-haiku-4-5", usage: { input_tokens: 5, output_tokens: 9 } } }) + "\n");
    const events = [
      { hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "t1", tool_input: { command: "pnpm test" } },
      { hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: "t1", tool_input: { command: "pnpm test" }, tool_response: { stdout: "ok" } },
      { hook_event_name: "SubagentStart", agent_id: "ag1", agent_type: "Explore" },
      { hook_event_name: "PreToolUse", agent_id: "ag1", agent_type: "Explore", tool_name: "Grep", tool_use_id: "t2", tool_input: { pattern: "x" } },
      { hook_event_name: "SubagentStop", agent_id: "ag1", agent_type: "Explore", agent_transcript_path: transcript, tool_use_id: "t3" },
    ];
    for (const e of events) {
      const r = runHookScript("trace", e, { dir });
      expect(r.status).toBe(0);
      expect(r.json).toBeNull();
      expect(r.stdout.trim()).toBe("");
    }
    const file = join(dir, ".doug/.state/trace/test-session.jsonl");
    expect(existsSync(file)).toBe(true);
    const lines = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.map((l) => l.event)).toEqual(["PreToolUse", "PostToolUse", "SubagentStart", "PreToolUse", "SubagentStop"]);
    expect(lines[0]).toMatchObject({ session: "test-session", agent: null, tool: "Bash", toolUseId: "t1", detail: "pnpm test", ok: null, tokens: null });
    expect(lines[1].ok).toBe(true);
    expect(lines[3]).toMatchObject({ agent: "ag1", agentType: "Explore", tool: "Grep", detail: "x" });
    expect(lines[4].tokens).toEqual({ input: 5, output: 9, cacheRead: 0, cacheWrite: 0, messages: 1, model: "claude-haiku-4-5" });
    for (const l of lines) expect(typeof l.t).toBe("string");
  });
  it("writes nothing when trace.enabled is false, and records null tokens when the transcript is missing", () => {
    const off = makeProject({ config: { ...baseConfig, trace: { enabled: false } } });
    runHookScript("trace", { hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: "a" } }, { dir: off });
    expect(existsSync(join(off, ".doug/.state/trace"))).toBe(false);
    const on = makeProject({ config: baseConfig });
    runHookScript("trace", { hook_event_name: "SubagentStop", agent_id: "ag2", agent_type: "coder", agent_transcript_path: join(on, "missing.jsonl") }, { dir: on });
    const [line] = readFileSync(join(on, ".doug/.state/trace/test-session.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(line).toMatchObject({ event: "SubagentStop", agent: "ag2", agentType: "coder", tokens: null });
  });

  it("traces InstructionsLoaded path-only (never file_content) and PermissionDenied with its reason, allowing both (card learn-signals)", () => {
    const dir = makeProject({ config: baseConfig });
    const loaded = runHookScript(
      "trace",
      { hook_event_name: "InstructionsLoaded", file_path: "/p/CLAUDE.md", load_reason: "session_start", file_content: "# secret prose that must never be traced" },
      { dir }
    );
    expect(loaded.status).toBe(0);
    expect(loaded.json).toBeNull();
    const denied = runHookScript(
      "trace",
      { hook_event_name: "PermissionDenied", tool_name: "Bash", tool_input: { command: "pnpm test" }, denial_reason: "auto mode denied" },
      { dir }
    );
    expect(denied.status).toBe(0);
    expect(denied.json).toBeNull();
    const raw = readFileSync(join(dir, ".doug/.state/trace/test-session.jsonl"), "utf8");
    expect(raw).not.toContain("secret prose");
    const [loadedLine, deniedLine] = raw.trim().split("\n").map((l) => JSON.parse(l));
    expect(loadedLine).toMatchObject({ event: "InstructionsLoaded", detail: "/p/CLAUDE.md", reason: "session_start" });
    expect(deniedLine).toMatchObject({ event: "PermissionDenied", tool: "Bash", detail: "pnpm test", ok: false, reason: "auto mode denied" });
  });

  describe("worker context handoff (card worker-context-handoff, brief A)", () => {
    const contextConfig = { ...baseConfig, contextWindow: { enabled: true, threshold: 80, repeatAfter: 5 } };
    // The documented layout (research note): <dirname of transcript_path>/<session_id>/subagents/agent-<id>.jsonl.
    // session_id defaults to "test-session" (helpers.mjs runHookScript).
    function subagentPaths(dir) {
      return { transcriptPath: join(dir, "proj", "main.jsonl"), derived: join(dir, "proj", "test-session", "subagents", "agent-ag1.jsonl") };
    }
    // Appends a new assistant line, the way a real transcript grows (contextReading reads the LAST one): a
    // second call always leaves the file strictly larger than the first, never coincidentally the same size.
    function seedTokens(file, tokens, model = "claude-sonnet-5") {
      mkdirSync(dirname(file), { recursive: true });
      appendFileSync(file, JSON.stringify({ type: "assistant", message: { model, usage: { input_tokens: tokens } } }) + "\n");
    }
    function post(dir, transcriptPath) {
      return runHookScript("trace", { hook_event_name: "PostToolUse", agent_id: "ag1", agent_type: "coder", transcript_path: transcriptPath, tool_name: "Edit", tool_input: { file_path: "a.ts" } }, { dir });
    }

    it("(a) records a reading below threshold, prints no notice, and carries the pct on the trace line (minor 6)", () => {
      const dir = makeProject({ config: contextConfig });
      const { transcriptPath, derived } = subagentPaths(dir);
      seedTokens(derived, 500000); // 50% of the 1M sonnet-5 window
      const r = post(dir, transcriptPath);
      expect(r.json).toBeNull();
      const state = JSON.parse(readFileSync(join(dir, ".doug/.state/test-session.json"), "utf8"));
      expect(state.agents.ag1.context).toMatchObject({ pct: 50, tokens: 500000, window: 1000000, model: "claude-sonnet-5" });
      const [line] = readFileSync(join(dir, ".doug/.state/trace/test-session.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
      expect(line.context).toBe(50);
    });

    it("(b) notices at or above threshold via additionalContext once, then again only after repeatAfter growth", () => {
      const dir = makeProject({ config: contextConfig });
      const { transcriptPath, derived } = subagentPaths(dir);
      seedTokens(derived, 800000); // 80%
      const first = post(dir, transcriptPath);
      expect(context(first)).toBe("[doug] Worker context at 80% of 1000000 tokens (threshold 80). Finish the file you are on and its named test, commit, then return partial=true with a handoff (completed, remaining, next, verify). Do not start another file.");

      seedTokens(derived, 840000); // 84%: below notifiedAt(80) + repeatAfter(5)
      const second = post(dir, transcriptPath);
      expect(context(second)).toBeNull();

      seedTokens(derived, 850000); // 85%: at notifiedAt + repeatAfter
      const third = post(dir, transcriptPath);
      expect(context(third)).toContain("Worker context at 85%");
    });

    it("(c) without agent_id, nothing is recorded — even with a transcript_path that would resolve to a real file (minor 7: the agent_id guard, not a missing path, is what stops it)", () => {
      const dir = makeProject({ config: contextConfig });
      const { transcriptPath } = subagentPaths(dir);
      // What "agent-undefined.jsonl" would derive to, were the `!input.agent_id` guard not there: a real,
      // readable transcript with real usage — so a regression that dropped the guard would show up here.
      seedTokens(join(dir, "proj", "test-session", "subagents", "agent-undefined.jsonl"), 900000);
      const r = runHookScript("trace", { hook_event_name: "PostToolUse", transcript_path: transcriptPath, tool_name: "Edit", tool_input: { file_path: "a.ts" } }, { dir });
      expect(r.json).toBeNull();
      expect(existsSync(join(dir, ".doug/.state/test-session.json"))).toBe(false);
    });

    it("(d) does nothing when contextWindow is disabled, even with agent_id and a real transcript", () => {
      const dir = makeProject({ config: baseConfig }); // contextWindow defaults disabled
      const { transcriptPath, derived } = subagentPaths(dir);
      seedTokens(derived, 900000);
      const r = post(dir, transcriptPath);
      expect(r.json).toBeNull();
      expect(existsSync(join(dir, ".doug/.state/test-session.json"))).toBe(false);
    });

    it("(e) a missing transcript records nothing but still appends the trace line, with context null", () => {
      const dir = makeProject({ config: contextConfig });
      const { transcriptPath } = subagentPaths(dir);
      const r = post(dir, transcriptPath);
      expect(r.json).toBeNull();
      expect(existsSync(join(dir, ".doug/.state/test-session.json"))).toBe(false);
      const [line] = readFileSync(join(dir, ".doug/.state/trace/test-session.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
      expect(line).toMatchObject({ event: "PostToolUse", agent: "ag1", context: null });
    });

    it("(minor 4) skips re-reading an unchanged transcript, by its cached byte size, recording nothing new", () => {
      const dir = makeProject({ config: contextConfig });
      const { transcriptPath, derived } = subagentPaths(dir);
      seedTokens(derived, 500000);
      const first = post(dir, transcriptPath);
      expect(first.json).toBeNull();
      const after1 = JSON.parse(readFileSync(join(dir, ".doug/.state/test-session.json"), "utf8"));
      expect(after1.agents.ag1.context).toMatchObject({ pct: 50, size: expect.any(Number) });

      // Same file, byte-for-byte: a second PostToolUse must not re-read it or touch the recorded entry at all.
      const second = post(dir, transcriptPath);
      expect(second.json).toBeNull();
      const after2 = JSON.parse(readFileSync(join(dir, ".doug/.state/test-session.json"), "utf8"));
      expect(after2.agents.ag1.context).toEqual(after1.agents.ag1.context);

      // The file did grow: the next PostToolUse reads it again and the entry changes.
      seedTokens(derived, 600000);
      const third = post(dir, transcriptPath);
      expect(third.json).toBeNull();
      const after3 = JSON.parse(readFileSync(join(dir, ".doug/.state/test-session.json"), "utf8"));
      expect(after3.agents.ag1.context.pct).toBe(60);
    });

    it("(major 2) reloads state immediately before saving and merges only this agent's entry, so a sibling agentBlocks bump and an edit-loop counter survive", () => {
      const dir = makeProject({ config: contextConfig });
      const { transcriptPath, derived } = subagentPaths(dir);
      seedTokens(derived, 500000);
      runHookScript("edit-loop", { tool_name: "Edit", tool_input: { file_path: "a.ts" } }, { dir });
      // Something else touched the same state file before this PostToolUse's own write: a SubagentStop block
      // count trace.mjs never looks at.
      const before = JSON.parse(readFileSync(join(dir, ".doug/.state/test-session.json"), "utf8"));
      before.agentBlocks = { x: 2 };
      writeFileSync(join(dir, ".doug/.state/test-session.json"), JSON.stringify(before));

      const r = post(dir, transcriptPath);
      expect(r.json).toBeNull();
      const state = JSON.parse(readFileSync(join(dir, ".doug/.state/test-session.json"), "utf8"));
      expect(state.agentBlocks).toEqual({ x: 2 });
      expect(state.editedFiles).toEqual(["a.ts"]);
      expect(state.agents.ag1.context).toMatchObject({ pct: 50 });
    });
  });
});

describe("verification evidence", () => {
  const withEvidence = { ...baseConfig, stopGate: { ...baseConfig.stopGate, requireEvidence: true } };
  it("guard-bash records the commands it lets through, not the ones it denies", () => {
    const dir = makeProject({ config: withEvidence });
    runHookScript("guard-bash", { tool_name: "Bash", tool_input: { command: "ls   -la\n" } }, { dir });
    runHookScript("guard-bash", { tool_name: "Bash", tool_input: { command: "npm install left-pad" } }, { dir });
    runHookScript("guard-bash", { tool_name: "Bash", tool_input: { command: "x".repeat(300) } }, { dir });
    const state = JSON.parse(readFileSync(join(dir, ".doug/.state/test-session.json"), "utf8"));
    expect(state.commands).toHaveLength(2);
    expect(state.commands[0]).toBe("ls -la");
    expect(state.commands[1]).toHaveLength(200);
  });
  it("blocks a green gate when the session never ran a test or verify command, and allows once it has", () => {
    const dir = makeProject({ config: withEvidence, git: true });
    runHookScript("edit-loop", { tool_name: "Edit", tool_input: { file_path: "a.ts" } }, { dir });
    runHookScript("guard-bash", { tool_name: "Bash", tool_input: { command: "ls -la" } }, { dir });
    const never = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
    expect(never.json.decision).toBe("block");
    expect(never.json.reason).toContain("No test or verify command ran in this session");
    expect(never.json.reason).toContain('`node -e "process.exit(0)"`');
    expect(never.json.reason).toContain("(1/3)");
    runHookScript("guard-bash", { tool_name: "Bash", tool_input: { command: "pnpm exec vitest run tests/a.test.ts" } }, { dir });
    const ran = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
    expect(ran.json).toBeNull();
    const state = JSON.parse(readFileSync(join(dir, ".doug/.state/test-session.json"), "utf8"));
    expect(state.lastGate.ok).toBe(true);
    expect(state.lastGate.evidence.ran).toEqual(["pnpm exec vitest run tests/a.test.ts"]);
    expect(state.stopBlocks).toBe(0);
  });
  it("tells ran-and-failed apart from never-ran", () => {
    const failing = { ...withEvidence, commands: { test: "echo FAIL-OUTPUT; exit 1" } };
    const dir = makeProject({ config: failing, git: true });
    runHookScript("edit-loop", { tool_name: "Edit", tool_input: { file_path: "a.ts" } }, { dir });
    const never = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
    expect(never.json.reason).toContain("FAIL-OUTPUT");
    expect(never.json.reason).toContain("never ran a test or verify command itself");
    runHookScript("guard-bash", { tool_name: "Bash", tool_input: { command: "echo FAIL-OUTPUT; exit 1" } }, { dir });
    const ran = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
    expect(ran.json.decision).toBe("block");
    expect(ran.json.reason).toContain("FAIL-OUTPUT");
    expect(ran.json.reason).not.toContain("never ran");
  });
  it("counts a gate command by name, any other configured command, or an evidencePatterns match, and is off with requireEvidence false", () => {
    const cfg = { ...withEvidence, commands: { test: 'node -e "process.exit(0)"', typecheck: "my-typecheck --strict", install: "pnpm install" }, stopGate: { ...withEvidence.stopGate, evidencePatterns: ["^just\\s+verify"] } };
    for (const [command, ok] of [["my-typecheck --strict", true], ["just verify all", true], ["pnpm install", false], ["cat README.md", false]]) {
      const dir = makeProject({ config: cfg, git: true });
      runHookScript("edit-loop", { tool_name: "Edit", tool_input: { file_path: "a.ts" } }, { dir });
      runHookScript("guard-bash", { tool_name: "Bash", tool_input: { command } }, { dir });
      const r = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
      expect(r.json === null, command).toBe(ok);
    }
    const off = makeProject({ config: baseConfig, git: true });
    runHookScript("edit-loop", { tool_name: "Edit", tool_input: { file_path: "a.ts" } }, { dir: off });
    expect(runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir: off }).json).toBeNull();
  });
});

describe("SubagentStop gate (card task-completed-gate)", () => {
  const git = (dir, ...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
  it("blocks a subagent from reporting done while verification fails, with its own counter and cap", () => {
    const dir = makeProject({ config: { ...baseConfig, commands: { test: "echo FAIL-OUTPUT; exit 1" }, stopGate: { ...baseConfig.stopGate, maxBlocks: 2 } }, git: true });
    runHookScript("edit-loop", { tool_name: "Edit", tool_input: { file_path: "a.ts" }, agent_id: "ag1", agent_type: "coder" }, { dir });
    const sub = { hook_event_name: "SubagentStop", agent_id: "ag1", agent_type: "coder", agent_transcript_path: "/nope" };
    const r1 = runHookScript("stop-gate", sub, { dir });
    expect(r1.json.decision).toBe("block");
    expect(r1.json.reason).toContain("Subagent coder (ag1) cannot report done: verification failed (1/2)");
    expect(r1.json.reason).toContain("FAIL-OUTPUT");
    expect(runHookScript("stop-gate", sub, { dir }).json.reason).toContain("(2/2)");
    const r3 = runHookScript("stop-gate", sub, { dir });
    expect(r3.json.decision).toBeUndefined();
    expect(r3.json.systemMessage).toContain("Subagent coder (ag1) was blocked 2 times and the gate is standing down for it");
    // Another subagent and the session's own Stop start from zero.
    expect(runHookScript("stop-gate", { ...sub, agent_id: "ag2" }, { dir }).json.reason).toContain("(1/2)");
    const main = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
    expect(main.json.reason).toContain("[doug] Verification failed (1/2)");
    const state = JSON.parse(readFileSync(join(dir, ".doug/.state/test-session.json"), "utf8"));
    expect(state.agentBlocks).toEqual({ ag1: 2, ag2: 1 });
    expect(state.stopBlocks).toBe(1);
    expect(state.turns).toBe(1);
    expect(state.lastGate.subagent).toBeUndefined();
  });
  it("lets a subagent finish on a green gate without a checkpoint or a turn, and passes when its Stop hook is already active", () => {
    const dir = makeProject({ config: { ...baseConfig, checkpoint: { enabled: true, mode: "commit" } }, git: true });
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src/a.ts"), "export const a = 1");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "base");
    writeFileSync(join(dir, "src/a.ts"), "export const a = 2");
    const r = runHookScript("stop-gate", { hook_event_name: "SubagentStop", agent_id: "ag1", agent_type: "coder" }, { dir });
    expect(r.json).toBeNull();
    expect(git(dir, "rev-list", "--count", "HEAD")).toBe("1");
    const state = JSON.parse(readFileSync(join(dir, ".doug/.state/test-session.json"), "utf8"));
    expect(state.turns).toBe(0);
    expect(state.agentBlocks).toEqual({ ag1: 0 });
    expect(state.lastGate.ok).toBe(true);
    expect(state.lastGate.subagent).toEqual({ id: "ag1", type: "coder" });
    const failing = makeProject({ config: { ...baseConfig, commands: { test: "exit 1" } }, git: true });
    runHookScript("edit-loop", { tool_name: "Edit", tool_input: { file_path: "a.ts" } }, { dir: failing });
    expect(runHookScript("stop-gate", { hook_event_name: "SubagentStop", agent_id: "ag1", stop_hook_active: true }, { dir: failing }).json).toBeNull();
  });

  describe("partial claim refusal (card worker-context-handoff, brief A)", () => {
    const contextConfig = { ...baseConfig, contextWindow: { enabled: true, threshold: 80, repeatAfter: 5 } };
    const claim = (extra = {}) => JSON.stringify({ partial: true, completed: "did a", remaining: "do b", next: "start b", verify: "pnpm test", ...extra });
    function subagentPaths(dir) {
      return { transcriptPath: join(dir, "proj", "main.jsonl"), derived: join(dir, "proj", "test-session", "subagents", "agent-ag1.jsonl") };
    }
    // Appends a new assistant line, the way a real transcript grows (contextReading reads the LAST one): a
    // second call always leaves the file strictly larger than the first, never coincidentally the same size.
    function seedTokens(file, tokens, model = "claude-sonnet-5") {
      mkdirSync(dirname(file), { recursive: true });
      appendFileSync(file, JSON.stringify({ type: "assistant", message: { model, usage: { input_tokens: tokens } } }) + "\n");
    }

    it("(f) a partial claim with no recorded context reading is refused, counted through agentBlocks", () => {
      const dir = makeProject({ config: contextConfig, git: true });
      const input = { hook_event_name: "SubagentStop", agent_id: "ag1", agent_type: "coder", last_assistant_message: `Some prose before.\n${claim()}\nSome prose after.` };
      const r = runHookScript("stop-gate", input, { dir });
      expect(r.json.decision).toBe("block");
      expect(r.json.reason).toBe('[doug] Partial result refused: no context reading at or above 80% was recorded for this agent (none). A partial is only for a worker the harness told to stop. Finish the brief, or return blocked=true with the reason.');
      const state = JSON.parse(readFileSync(join(dir, ".doug/.state/test-session.json"), "utf8"));
      expect(state.agentBlocks).toEqual({ ag1: 1 });
    });

    it("(g) accepts a partial claim once the recorded maxPct reaches the threshold, and the normal gate then runs", () => {
      const dir = makeProject({ config: contextConfig, git: true });
      const { transcriptPath, derived } = subagentPaths(dir);
      seedTokens(derived, 800000); // 80%: at threshold
      runHookScript("trace", { hook_event_name: "PostToolUse", agent_id: "ag1", agent_type: "coder", transcript_path: transcriptPath, tool_name: "Edit", tool_input: { file_path: "a.ts" } }, { dir });
      writeFileSync(join(dir, "a.ts"), "x"); // something changed, so the normal gate has work to verify
      const input = { hook_event_name: "SubagentStop", agent_id: "ag1", agent_type: "coder", last_assistant_message: claim() };
      const r = runHookScript("stop-gate", input, { dir });
      expect(r.json).toBeNull(); // verification passes: normal green-gate allow
    });

    it("(h) a non-partial last_assistant_message is unaffected by the refusal check", () => {
      const dir = makeProject({ config: contextConfig, git: true });
      writeFileSync(join(dir, "a.ts"), "x");
      const plain = runHookScript("stop-gate", { hook_event_name: "SubagentStop", agent_id: "ag1", agent_type: "coder", last_assistant_message: "All done, nothing structured here." }, { dir });
      expect(plain.json).toBeNull();
      const falsePartial = runHookScript("stop-gate", { hook_event_name: "SubagentStop", agent_id: "ag1", agent_type: "coder", last_assistant_message: claim({ partial: false }) }, { dir });
      expect(falsePartial.json).toBeNull();
    });

    it("(i) refuses a partial claim when contextWindow is disabled entirely", () => {
      const dir = makeProject({ config: baseConfig, git: true }); // contextWindow defaults disabled
      const input = { hook_event_name: "SubagentStop", agent_id: "ag1", agent_type: "coder", last_assistant_message: claim() };
      const r = runHookScript("stop-gate", input, { dir });
      expect(r.json.decision).toBe("block");
      expect(r.json.reason).toBe('[doug] Partial result refused: no context reading at or above 80% was recorded for this agent (none). A partial is only for a worker the harness told to stop. Finish the brief, or return blocked=true with the reason.');
    });

    it("(minor 5) maxPct is a running maximum: a reading that dips (85 then 70) still accepts a partial claim", () => {
      const dir = makeProject({ config: contextConfig, git: true });
      const { transcriptPath, derived } = subagentPaths(dir);
      seedTokens(derived, 850000); // 85%
      runHookScript("trace", { hook_event_name: "PostToolUse", agent_id: "ag1", agent_type: "coder", transcript_path: transcriptPath, tool_name: "Edit", tool_input: { file_path: "a.ts" } }, { dir });
      seedTokens(derived, 700000); // 70%: dips back down, but maxPct stays 85
      runHookScript("trace", { hook_event_name: "PostToolUse", agent_id: "ag1", agent_type: "coder", transcript_path: transcriptPath, tool_name: "Edit", tool_input: { file_path: "a.ts" } }, { dir });
      writeFileSync(join(dir, "a.ts"), "x");
      const input = { hook_event_name: "SubagentStop", agent_id: "ag1", agent_type: "coder", last_assistant_message: claim() };
      const r = runHookScript("stop-gate", input, { dir });
      expect(r.json).toBeNull(); // accepted: verification passes, normal green-gate allow
    });

    it("(minor 9) after repeated partial refusals hit the cap, the gate stands down naming the refusal count, not verification", () => {
      const dir = makeProject({ config: { ...contextConfig, stopGate: { ...contextConfig.stopGate, maxBlocks: 1 } }, git: true });
      const input = { hook_event_name: "SubagentStop", agent_id: "ag1", agent_type: "coder", last_assistant_message: claim() };
      const first = runHookScript("stop-gate", input, { dir });
      expect(first.json.decision).toBe("block");
      const second = runHookScript("stop-gate", input, { dir });
      expect(second.json.decision).toBeUndefined();
      expect(second.json.systemMessage).toBe("[doug] Subagent coder (ag1)'s partial claim was refused 1 times and the gate is standing down for it. Do not treat its work as done.");
      expect(second.json.systemMessage).not.toContain("Verification is still failing");
    });

    it("(minor 10) when trace is disabled, refuses naming trace being off, not a measurement that could not be taken", () => {
      const dir = makeProject({ config: { ...contextConfig, trace: { enabled: false } }, git: true });
      const input = { hook_event_name: "SubagentStop", agent_id: "ag1", agent_type: "coder", last_assistant_message: claim() };
      const r = runHookScript("stop-gate", input, { dir });
      expect(r.json.decision).toBe("block");
      expect(r.json.reason).toBe(
        "[doug] Partial result refused: context readings need trace.enabled (it is off), so no reading could ever be recorded for this agent. A partial is only for a worker the harness told to stop. Finish the brief, or return blocked=true with the reason.",
      );
      const state = JSON.parse(readFileSync(join(dir, ".doug/.state/test-session.json"), "utf8"));
      expect(state.agentBlocks).toEqual({ ag1: 1 });
    });

    it("(minor 11) takes one fresh reading from the SubagentStop's own agent_transcript_path when nothing recorded so far clears the threshold", () => {
      const dir = makeProject({ config: contextConfig, git: true });
      const { derived } = subagentPaths(dir);
      seedTokens(derived, 900000); // 90%: never recorded via any PostToolUse
      writeFileSync(join(dir, "a.ts"), "x");
      const input = { hook_event_name: "SubagentStop", agent_id: "ag1", agent_type: "coder", agent_transcript_path: derived, last_assistant_message: claim() };
      const r = runHookScript("stop-gate", input, { dir });
      expect(r.json).toBeNull(); // accepted on the fresh reading alone
      const state = JSON.parse(readFileSync(join(dir, ".doug/.state/test-session.json"), "utf8"));
      expect(state.agents.ag1.context).toMatchObject({ pct: 90, maxPct: 90 });
    });

    describe("parsing edge cases (review MAJOR 1)", () => {
      // No context reading recorded in any of these: a message correctly recognized as a claim is refused
      // with the generic reason; one correctly recognized as NOT a claim falls through to the normal gate,
      // which allows here (nothing changed, so onlyIfEdited's early return applies).
      const refused = (message) => {
        const dir = makeProject({ config: contextConfig, git: true });
        const r = runHookScript("stop-gate", { hook_event_name: "SubagentStop", agent_id: "ag1", agent_type: "coder", last_assistant_message: message }, { dir });
        expect(r.json.decision, message).toBe("block");
        expect(r.json.reason, message).toContain("[doug] Partial result refused: no context reading");
      };
      const notAClaim = (message) => {
        const dir = makeProject({ config: contextConfig, git: true });
        const r = runHookScript("stop-gate", { hook_event_name: "SubagentStop", agent_id: "ag1", agent_type: "coder", last_assistant_message: message }, { dir });
        expect(r.json, message).toBeNull();
      };

      it("refuses despite an odd number of quotes in the prose before the claim (previously fell open)", () => {
        refused(`She said "let's ship it now.\n${claim()}`);
      });
      it("refuses despite a stray unmatched { in the prose before the claim (previously fell open)", () => {
        refused(`Something like { for an object, anyway:\n${claim()}`);
      });
      it("refuses when the claim is followed by another JSON object that lacks a partial key (previously fell open)", () => {
        refused(`${claim()}\nAlso note: {"unrelated": "stuff"}`);
      });
      it("still refuses the existing correct cases: nested braces, braces in a string, a fenced json block, two objects with the claim last", () => {
        refused(JSON.stringify({ partial: true, completed: "x", remaining: "y", next: "z", verify: "t", handoff: { note: "nested", ok: true } }));
        refused(JSON.stringify({ partial: true, completed: "x", note: "use {handlebars} and {{mustache}} syntax" }));
        refused("Here is my result:\n```json\n" + claim() + "\n```\n");
        refused(`{"unrelated": "stuff"}\n${claim()}`);
      });
      it("is not a claim: non-JSON prose, a truncated object, and partial as the string \"true\"", () => {
        notAClaim("All done here, nothing structured at all.");
        notAClaim('{"partial": true, "completed": "x", "remaining": "y"'); // no closing brace
        notAClaim(JSON.stringify({ partial: "true", completed: "x", remaining: "y", next: "z", verify: "t" }));
      });

      it("nested-key shadow: a nested object's own partial key never overrides its parent's (re-review)", () => {
        // The real claim (partial: true) sits at the top level; a nested "handoff.partial: false" must not
        // be picked instead just because its "{" starts later in the text.
        refused(JSON.stringify({ partial: true, completed: "a", handoff: { partial: false } }));
        // Fail-closed: no top-level candidate carries a "partial" key at all here, only a nested one — still
        // treated as a claim (and so refused, for lack of a reading) rather than silently waved through.
        refused(JSON.stringify({ result: { partial: true } }));
        // A real top-level claim followed by an unrelated object that itself nests a "partial" key: the real
        // claim, not the decoy's nested key, is still what gets picked.
        refused(`${claim()}\nnote ${JSON.stringify({ x: { partial: true } })}`);
      });

      it("(scan cost) a 200KB message whose claim sits in the last 2KB is still found and refused", () => {
        const filler = "x".repeat(198 * 1024); // no braces, far larger than the 32KB tail window
        refused(filler + "\n" + claim()); // ~198KB of filler, then the claim in the final ~2KB
      });

      it("(scan cost) returns quickly on 400KB of brace-heavy prose with no claim at all", () => {
        const dir = makeProject({ config: contextConfig, git: true });
        // Dense with unmatched "{" (about one every 20 characters, never closed) but still prose, not the
        // pathological case of nothing but "{" — what made the unbounded scan quadratic in message length.
        // 400KB (not 200KB): on the uncapped regression the scan cost is quadratic in payload length, and
        // 200KB alone (~4.3s) came in under an 8000ms bound; doubling the payload roughly quadruples that
        // regression cost while the capped path's cost stays flat.
        const chunk = "prose prose prose { ";
        const braceHeavy = chunk.repeat(Math.ceil((400 * 1024) / chunk.length));
        const startedAt = Date.now();
        const r = runHookScript("stop-gate", { hook_event_name: "SubagentStop", agent_id: "ag1", agent_type: "coder", last_assistant_message: braceHeavy }, { dir });
        const elapsedMs = Date.now() - startedAt;
        expect(r.json).toBeNull(); // no candidate ever balances: not a claim, normal gate allows
        expect(elapsedMs).toBeLessThan(8000);
      });
    });
  });

  describe("tests red by design (card subagent-stop-gate-tester-red)", () => {
    const claim = (files) => JSON.stringify({ tests_red_by_design: files });
    // card tester-claim-missed-in-handback, pass 2: a JSONL transcript line shaped like a real
    // SubagentHandback tool_use, per the brief's observed transcript shape (F: an assistant line with
    // message.content, an array; a hand-back is { type: "tool_use", name: "SubagentHandback", input: { message } }).
    function handbackLine(message) {
      return JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "SubagentHandback", input: { message } }] } });
    }
    function tracedLines(dir, sessionId = "test-session") {
      const file = join(dir, ".doug/.state/trace", `${sessionId}.jsonl`);
      if (!existsSync(file)) return [];
      return readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    }

    it("T1 a covered claim lets the tester stop, resets its counter, records lastGate.redByDesign, and traces the claim", () => {
      const dir = makeProject({
        config: { ...baseConfig, commands: { test: "echo ' FAIL  tests/a.test.mjs > it'; echo ' ❯ tests/a.test.mjs (3 tests | 1 failed)'; exit 1" } },
        git: true,
      });
      mkdirSync(join(dir, "tests"));
      writeFileSync(join(dir, "tests/a.test.mjs"), "it fails on purpose");
      runHookScript("edit-loop", { tool_name: "Write", tool_input: { file_path: "tests/a.test.mjs" }, agent_id: "ag1", agent_type: "tester" }, { dir });
      const input = {
        hook_event_name: "SubagentStop",
        agent_id: "ag1",
        agent_type: "tester",
        last_assistant_message: `Ran the new test; it fails as designed.\n${claim(["tests/a.test.mjs"])}`,
      };
      const r = runHookScript("stop-gate", input, { dir });
      expect(r.json.decision).toBeUndefined();
      expect(r.json.systemMessage).toContain("Subagent tester (ag1) stopped with tests red by design: tests/a.test.mjs");
      const state = JSON.parse(readFileSync(join(dir, ".doug/.state/test-session.json"), "utf8"));
      expect(state.agentBlocks).toEqual({ ag1: 0 });
      expect(state.lastGate.redByDesign).toEqual(["tests/a.test.mjs"]);
      const line = tracedLines(dir).find((l) => l.event === "SubagentStop" && l.reason === "tests_red_by_design");
      expect(line).toBeTruthy();
      expect(line.detail).toContain("tests/a.test.mjs");
    });

    it("T2 a failing file left out of the claim list is not covered: block, naming the uncovered file at the end", () => {
      const dir = makeProject({
        config: {
          ...baseConfig,
          commands: {
            test: "echo ' FAIL  tests/a.test.mjs > it'; echo ' FAIL  tests/b.test.mjs > it'; echo 'summary: tests/a.test.mjs failed again'; exit 1",
          },
        },
        git: true,
      });
      mkdirSync(join(dir, "tests"));
      writeFileSync(join(dir, "tests/a.test.mjs"), "a");
      writeFileSync(join(dir, "tests/b.test.mjs"), "b");
      runHookScript("edit-loop", { tool_name: "Write", tool_input: { file_path: "tests/a.test.mjs" }, agent_id: "ag1", agent_type: "tester" }, { dir });
      const input = { hook_event_name: "SubagentStop", agent_id: "ag1", agent_type: "tester", last_assistant_message: claim(["tests/a.test.mjs"]) };
      const r = runHookScript("stop-gate", input, { dir });
      expect(r.json.decision).toBe("block");
      expect(r.json.reason).toContain("(1/");
      const lines = r.json.reason.trim().split("\n");
      expect(lines[lines.length - 1]).toContain("tests/b.test.mjs");
      const state = JSON.parse(readFileSync(join(dir, ".doug/.state/test-session.json"), "utf8"));
      expect(state.agentBlocks).toEqual({ ag1: 1 });
    });

    it("T3 a listed file the tree does not show as changed is not covered: block, naming it at the end", () => {
      const dir = makeProject({
        config: { ...baseConfig, commands: { test: "echo ' FAIL  tests/a.test.mjs > it'; echo 'exit code 1'; exit 1" } },
        git: true,
      });
      mkdirSync(join(dir, "tests"));
      writeFileSync(join(dir, "tests/a.test.mjs"), "a");
      git(dir, "add", "-A");
      git(dir, "commit", "-q", "-m", "base");
      writeFileSync(join(dir, "other.ts"), "x");
      runHookScript("edit-loop", { tool_name: "Write", tool_input: { file_path: "other.ts" }, agent_id: "ag1", agent_type: "tester" }, { dir });
      const input = { hook_event_name: "SubagentStop", agent_id: "ag1", agent_type: "tester", last_assistant_message: claim(["tests/a.test.mjs"]) };
      const r = runHookScript("stop-gate", input, { dir });
      expect(r.json.decision).toBe("block");
      expect(r.json.reason).toContain("(1/");
      const lines = r.json.reason.trim().split("\n");
      expect(lines[lines.length - 1]).toContain("tests/a.test.mjs");
      const state = JSON.parse(readFileSync(join(dir, ".doug/.state/test-session.json"), "utf8"));
      expect(state.agentBlocks).toEqual({ ag1: 1 });
    });

    it("T4 a red whose output names no test file is not covered: block, saying the command named no test file", () => {
      const dir = makeProject({
        config: { ...baseConfig, commands: { test: "echo type error; exit 1" } },
        git: true,
      });
      runHookScript("edit-loop", { tool_name: "Edit", tool_input: { file_path: "a.ts" }, agent_id: "ag1", agent_type: "tester" }, { dir });
      const input = { hook_event_name: "SubagentStop", agent_id: "ag1", agent_type: "tester", last_assistant_message: claim(["tests/a.test.mjs"]) };
      const r = runHookScript("stop-gate", input, { dir });
      expect(r.json.decision).toBe("block");
      expect(r.json.reason).toContain("(1/");
      expect(r.json.reason).toMatch(/named no test file/i);
    });

    it("T5 the main Stop ignores the claim: still blocks with the ordinary reason", () => {
      const dir = makeProject({
        config: { ...baseConfig, commands: { test: "echo ' FAIL  tests/a.test.mjs > it'; exit 1" } },
        git: true,
      });
      mkdirSync(join(dir, "tests"));
      writeFileSync(join(dir, "tests/a.test.mjs"), "a");
      runHookScript("edit-loop", { tool_name: "Write", tool_input: { file_path: "tests/a.test.mjs" } }, { dir });
      const input = { hook_event_name: "Stop", last_assistant_message: claim(["tests/a.test.mjs"]) };
      const r = runHookScript("stop-gate", input, { dir });
      expect(r.json.decision).toBe("block");
      expect(r.json.reason).toContain("[doug] Verification failed (1/");
    });

    it("T6 no claim, same red, agent_type tester: the ordinary block runs, unchanged", () => {
      const dir = makeProject({
        config: { ...baseConfig, commands: { test: "echo ' FAIL  tests/a.test.mjs > it'; exit 1" } },
        git: true,
      });
      mkdirSync(join(dir, "tests"));
      writeFileSync(join(dir, "tests/a.test.mjs"), "a");
      runHookScript("edit-loop", { tool_name: "Write", tool_input: { file_path: "tests/a.test.mjs" }, agent_id: "ag1", agent_type: "tester" }, { dir });
      const input = {
        hook_event_name: "SubagentStop",
        agent_id: "ag1",
        agent_type: "tester",
        last_assistant_message: "Ran the tests; they fail as expected, no structured claim here.",
      };
      const r = runHookScript("stop-gate", input, { dir });
      expect(r.json.decision).toBe("block");
      expect(r.json.reason).toContain("Subagent tester (ag1) cannot report done: verification failed (1/");
    });

    it("T7 malformed claims (empty array, a string, an array of an empty string) are no claim: the ordinary block runs", () => {
      const malformed = [claim([]), JSON.stringify({ tests_red_by_design: "tests/a.test.mjs" }), claim([""])];
      for (const message of malformed) {
        const dir = makeProject({
          config: { ...baseConfig, commands: { test: "echo ' FAIL  tests/a.test.mjs > it'; exit 1" } },
          git: true,
        });
        mkdirSync(join(dir, "tests"));
        writeFileSync(join(dir, "tests/a.test.mjs"), "a");
        runHookScript("edit-loop", { tool_name: "Write", tool_input: { file_path: "tests/a.test.mjs" }, agent_id: "ag1", agent_type: "tester" }, { dir });
        const r = runHookScript("stop-gate", { hook_event_name: "SubagentStop", agent_id: "ag1", agent_type: "tester", last_assistant_message: message }, { dir });
        expect(r.json.decision, message).toBe("block");
        expect(r.json.reason, message).toContain("Subagent tester (ag1) cannot report done: verification failed (1/");
      }
    });

    it("T8 trace disabled: still allowed with the systemMessage, and no trace file is written", () => {
      const dir = makeProject({
        config: { ...baseConfig, trace: { enabled: false }, commands: { test: "echo ' FAIL  tests/a.test.mjs > it'; exit 1" } },
        git: true,
      });
      mkdirSync(join(dir, "tests"));
      writeFileSync(join(dir, "tests/a.test.mjs"), "a");
      runHookScript("edit-loop", { tool_name: "Write", tool_input: { file_path: "tests/a.test.mjs" }, agent_id: "ag1", agent_type: "tester" }, { dir });
      const input = { hook_event_name: "SubagentStop", agent_id: "ag1", agent_type: "tester", last_assistant_message: claim(["tests/a.test.mjs"]) };
      const r = runHookScript("stop-gate", input, { dir });
      expect(r.json.decision).toBeUndefined();
      expect(r.json.systemMessage).toContain("Subagent tester (ag1) stopped with tests red by design: tests/a.test.mjs");
      expect(existsSync(join(dir, ".doug/.state/trace/test-session.jsonl"))).toBe(false);
    });

    // 2026-09-14, reviewer findings on this card: two majors and three minors the T1-T8 tests above do not
    // constrain.
    it("T11 MAJOR: the claim is honoured only for agent_type \"tester\" exactly: the same covered claim from a coder still blocks, naming the type it saw", () => {
      const dir = makeProject({
        config: { ...baseConfig, commands: { test: "echo ' FAIL  tests/a.test.mjs > it'; exit 1" } },
        git: true,
      });
      mkdirSync(join(dir, "tests"));
      writeFileSync(join(dir, "tests/a.test.mjs"), "a");
      runHookScript("edit-loop", { tool_name: "Write", tool_input: { file_path: "tests/a.test.mjs" }, agent_id: "ag1", agent_type: "coder" }, { dir });
      const input = { hook_event_name: "SubagentStop", agent_id: "ag1", agent_type: "coder", last_assistant_message: claim(["tests/a.test.mjs"]) };
      const r = runHookScript("stop-gate", input, { dir });
      expect(r.json.decision).toBe("block");
      expect(r.json.reason).toContain("(1/");
      const lines = r.json.reason.trim().split("\n");
      expect(lines[lines.length - 1]).toMatch(/tester/i);
      expect(lines[lines.length - 1]).toContain("coder");
    });

    it("T12 MAJOR, preconditions: a dirty protected path plus the red plus a covered claim still blocks, and the reason never says red by design", () => {
      const dir = makeProject({
        config: { ...baseConfig, commands: { test: "echo ' FAIL  tests/a.test.mjs > it'; exit 1" } },
        git: true,
      });
      mkdirSync(join(dir, "tests"));
      writeFileSync(join(dir, "tests/a.test.mjs"), "a");
      writeFileSync(join(dir, ".env"), "SECRET=1"); // baseConfig.protectedPaths includes ".env"
      runHookScript("edit-loop", { tool_name: "Write", tool_input: { file_path: "tests/a.test.mjs" }, agent_id: "ag1", agent_type: "tester" }, { dir });
      const input = { hook_event_name: "SubagentStop", agent_id: "ag1", agent_type: "tester", last_assistant_message: claim(["tests/a.test.mjs"]) };
      const r = runHookScript("stop-gate", input, { dir });
      expect(r.json.decision).toBe("block");
      expect(r.json.reason).toContain(".env");
      expect(r.json.reason).not.toContain("red by design");
    });

    it("T13 MAJOR, preconditions: an approved plan whose tasks do not own tests/a.test.mjs, plus the red plus a covered claim, still blocks", () => {
      const plan = {
        version: 1,
        title: "Truncate helper",
        goal: "Add truncate to the strings module",
        status: "approved",
        acceptance: ["truncate exists"],
        verify: [],
        tasks: [{ id: "add-truncate", title: "Add truncate", spec: "Add truncate(input, max) to src/strings.ts with tests.", files: ["src/strings.ts"] }],
      };
      const dir = makeProject({
        config: { ...baseConfig, commands: { test: "echo ' FAIL  tests/a.test.mjs > it'; exit 1" } },
        git: true,
      });
      mkdirSync(join(dir, "src"));
      writeFileSync(join(dir, ".doug/plan.json"), JSON.stringify(plan));
      git(dir, "add", "-A");
      git(dir, "commit", "-q", "-m", "base");
      mkdirSync(join(dir, "tests"));
      writeFileSync(join(dir, "tests/a.test.mjs"), "a");
      runHookScript("edit-loop", { tool_name: "Write", tool_input: { file_path: "tests/a.test.mjs" }, agent_id: "ag1", agent_type: "tester" }, { dir });
      const input = { hook_event_name: "SubagentStop", agent_id: "ag1", agent_type: "tester", last_assistant_message: claim(["tests/a.test.mjs"]) };
      const r = runHookScript("stop-gate", input, { dir });
      expect(r.json.decision).toBe("block");
      expect(r.json.reason).toContain("outside the approved plan");
      expect(r.json.reason).not.toContain("red by design");
    });

    it("T14 MAJOR, preconditions: requireEvidence on with no verify command recorded, plus the red plus a covered claim, still blocks", () => {
      const dir = makeProject({
        config: { ...baseConfig, stopGate: { ...baseConfig.stopGate, requireEvidence: true }, commands: { test: "echo ' FAIL  tests/a.test.mjs > it'; exit 1" } },
        git: true,
      });
      mkdirSync(join(dir, "tests"));
      writeFileSync(join(dir, "tests/a.test.mjs"), "a");
      runHookScript("edit-loop", { tool_name: "Write", tool_input: { file_path: "tests/a.test.mjs" }, agent_id: "ag1", agent_type: "tester" }, { dir });
      const input = { hook_event_name: "SubagentStop", agent_id: "ag1", agent_type: "tester", last_assistant_message: claim(["tests/a.test.mjs"]) };
      const r = runHookScript("stop-gate", input, { dir });
      expect(r.json.decision).toBe("block");
      expect(r.json.reason).toContain("This session never ran a test or verify command itself");
      expect(r.json.reason).not.toContain("red by design");
    });

    it("T15 MINOR, parse: a FAIL line whose file token is wrapped in punctuation is still covered (leading punctuation is not part of the file)", () => {
      const dir = makeProject({
        config: { ...baseConfig, commands: { test: "echo '1 test failed at (tests/a.test.mjs:3:1)'; exit 1" } },
        git: true,
      });
      mkdirSync(join(dir, "tests"));
      writeFileSync(join(dir, "tests/a.test.mjs"), "a");
      runHookScript("edit-loop", { tool_name: "Write", tool_input: { file_path: "tests/a.test.mjs" }, agent_id: "ag1", agent_type: "tester" }, { dir });
      const input = { hook_event_name: "SubagentStop", agent_id: "ag1", agent_type: "tester", last_assistant_message: claim(["tests/a.test.mjs"]) };
      const r = runHookScript("stop-gate", input, { dir });
      expect(r.json.decision).toBeUndefined();
      expect(r.json.systemMessage).toContain("Subagent tester (ag1) stopped with tests red by design: tests/a.test.mjs");
    });

    it("T16 MINOR, parse (pin): the failing file printed as an absolute path under dir still matches a repo-relative claim", () => {
      const dir = makeProject({ git: true });
      mkdirSync(join(dir, "tests"));
      writeFileSync(join(dir, "tests/a.test.mjs"), "a");
      const abs = join(dir, "tests/a.test.mjs");
      mkdirSync(join(dir, ".doug"), { recursive: true });
      writeFileSync(join(dir, ".doug/config.json"), JSON.stringify({ ...baseConfig, commands: { test: `echo 'FAIL  ${abs} > it'; exit 1` } }));
      runHookScript("edit-loop", { tool_name: "Write", tool_input: { file_path: "tests/a.test.mjs" }, agent_id: "ag1", agent_type: "tester" }, { dir });
      const input = { hook_event_name: "SubagentStop", agent_id: "ag1", agent_type: "tester", last_assistant_message: claim(["tests/a.test.mjs"]) };
      const r = runHookScript("stop-gate", input, { dir });
      expect(r.json.decision).toBeUndefined();
      expect(r.json.systemMessage).toContain("Subagent tester (ag1) stopped with tests red by design: tests/a.test.mjs");
    });

    it("T17 MINOR, parse (pin): a passing-test line (✓) naming a file must not count as failing", () => {
      const dir = makeProject({
        config: { ...baseConfig, commands: { test: "echo ' ✓ tests/a.test.mjs (2 tests)'; echo ' FAIL  tests/b.test.mjs > it'; exit 1" } },
        git: true,
      });
      mkdirSync(join(dir, "tests"));
      writeFileSync(join(dir, "tests/a.test.mjs"), "a");
      writeFileSync(join(dir, "tests/b.test.mjs"), "b");
      runHookScript("edit-loop", { tool_name: "Write", tool_input: { file_path: "tests/a.test.mjs" }, agent_id: "ag1", agent_type: "tester" }, { dir });
      const input = { hook_event_name: "SubagentStop", agent_id: "ag1", agent_type: "tester", last_assistant_message: claim(["tests/a.test.mjs"]) };
      const r = runHookScript("stop-gate", input, { dir });
      expect(r.json.decision).toBe("block");
      const lines = r.json.reason.trim().split("\n");
      expect(lines[lines.length - 1]).toContain("tests/b.test.mjs");
    });

    it("T18 MINOR: a claim written with a leading './' is normalised", () => {
      const dir = makeProject({
        config: { ...baseConfig, commands: { test: "echo ' FAIL  tests/a.test.mjs > it'; exit 1" } },
        git: true,
      });
      mkdirSync(join(dir, "tests"));
      writeFileSync(join(dir, "tests/a.test.mjs"), "a");
      runHookScript("edit-loop", { tool_name: "Write", tool_input: { file_path: "tests/a.test.mjs" }, agent_id: "ag1", agent_type: "tester" }, { dir });
      const input = { hook_event_name: "SubagentStop", agent_id: "ag1", agent_type: "tester", last_assistant_message: claim(["./tests/a.test.mjs"]) };
      const r = runHookScript("stop-gate", input, { dir });
      expect(r.json.decision).toBeUndefined();
      expect(r.json.systemMessage).toContain("Subagent tester (ag1) stopped with tests red by design");
    });

    it("T19 MINOR, parse (pin): a ✓-line file is never counted as failing, even when it is the only file the claim omits", () => {
      const dir = makeProject({
        config: { ...baseConfig, commands: { test: "echo ' ✓ tests/ok.test.mjs (2 tests)'; echo ' FAIL  tests/b.test.mjs > it'; exit 1" } },
        git: true,
      });
      mkdirSync(join(dir, "tests"));
      writeFileSync(join(dir, "tests/ok.test.mjs"), "ok"); // untracked, like tests/b.test.mjs below
      writeFileSync(join(dir, "tests/b.test.mjs"), "b");
      runHookScript("edit-loop", { tool_name: "Write", tool_input: { file_path: "tests/b.test.mjs" }, agent_id: "ag1", agent_type: "tester" }, { dir });
      const input = { hook_event_name: "SubagentStop", agent_id: "ag1", agent_type: "tester", last_assistant_message: claim(["tests/b.test.mjs"]) };
      const r = runHookScript("stop-gate", input, { dir });
      expect(r.json.decision).toBeUndefined();
      expect(r.json.systemMessage).toContain("Subagent tester (ag1) stopped with tests red by design: tests/b.test.mjs");
    });

    // card tester-claim-missed-in-handback, pass 2: no fallback exists yet — the gate reads only
    // last_assistant_message, so H1/H2/H5 below are red until lastHandbackMessage() and its fallback land.
    it("H1 a claim only inside a SubagentHandback call, with the trailing plain text carrying no claim, is honoured via the hand-back fallback", () => {
      const dir = makeProject({
        config: { ...baseConfig, commands: { test: "echo ' FAIL  tests/a.test.mjs > it'; exit 1" } },
        git: true,
      });
      mkdirSync(join(dir, "tests"));
      writeFileSync(join(dir, "tests/a.test.mjs"), "a");
      runHookScript("edit-loop", { tool_name: "Write", tool_input: { file_path: "tests/a.test.mjs" }, agent_id: "ag1", agent_type: "tester" }, { dir });
      const transcriptPath = join(dir, "transcript.jsonl");
      writeFileSync(transcriptPath, handbackLine(claim(["tests/a.test.mjs"])) + "\n");
      const input = {
        hook_event_name: "SubagentStop",
        agent_id: "ag1",
        agent_type: "tester",
        agent_transcript_path: transcriptPath,
        last_assistant_message: "Report delivered via SubagentHandback.",
      };
      const r = runHookScript("stop-gate", input, { dir });
      // Asserted as a boolean (not a direct .toBeUndefined()/.toContain() on r.json) so a failure here never
      // prints the raw command output embedded in r.json.reason: that output itself contains a "FAIL
      // tests/a.test.mjs" line (the fixture's own echo), and an outer coverage-checking gate that scans this
      // test file's own stdout must not mistake that printed fixture text for a real uncovered failing file.
      expect(r.json.decision === undefined, "expected the hand-back fallback to honour the claim (stop-gate should return no decision, not block)").toBe(true);
      expect(r.json.systemMessage.includes("Subagent tester (ag1) stopped with tests red by design: tests/a.test.mjs"), "expected the red-by-design systemMessage").toBe(true);
      const state = JSON.parse(readFileSync(join(dir, ".doug/.state/test-session.json"), "utf8"));
      expect(state.redByDesignClaim).toBeTruthy();
      expect(state.redByDesignClaim.files).toEqual(["tests/a.test.mjs"]);
    });

    it("H2 among several hand-backs the LAST one's claim is used, both directions", () => {
      // first wrong file, last correct: honoured
      const dir = makeProject({
        config: { ...baseConfig, commands: { test: "echo ' FAIL  tests/a.test.mjs > it'; exit 1" } },
        git: true,
      });
      mkdirSync(join(dir, "tests"));
      writeFileSync(join(dir, "tests/a.test.mjs"), "a");
      runHookScript("edit-loop", { tool_name: "Write", tool_input: { file_path: "tests/a.test.mjs" }, agent_id: "ag1", agent_type: "tester" }, { dir });
      const transcriptPath = join(dir, "transcript.jsonl");
      writeFileSync(
        transcriptPath,
        [handbackLine(claim(["tests/other.test.mjs"])), handbackLine(claim(["tests/a.test.mjs"]))].join("\n") + "\n",
      );
      const input = {
        hook_event_name: "SubagentStop",
        agent_id: "ag1",
        agent_type: "tester",
        agent_transcript_path: transcriptPath,
        last_assistant_message: "Report delivered via SubagentHandback.",
      };
      const r = runHookScript("stop-gate", input, { dir });
      // Boolean-wrapped for the same reason as H1: a failure here must not print r.json.reason's embedded
      // "FAIL tests/a.test.mjs" fixture line to an outer gate scanning this test file's own stdout.
      expect(r.json.decision === undefined, "expected the LAST hand-back's claim to win (stop-gate should return no decision, not block)").toBe(true);
      expect(r.json.systemMessage.includes("Subagent tester (ag1) stopped with tests red by design: tests/a.test.mjs"), "expected the red-by-design systemMessage").toBe(true);

      // first correct, last wrong: blocks (the last one still wins, and it does not cover the failure)
      const dir2 = makeProject({
        config: { ...baseConfig, commands: { test: "echo ' FAIL  tests/a.test.mjs > it'; exit 1" } },
        git: true,
      });
      mkdirSync(join(dir2, "tests"));
      writeFileSync(join(dir2, "tests/a.test.mjs"), "a");
      runHookScript("edit-loop", { tool_name: "Write", tool_input: { file_path: "tests/a.test.mjs" }, agent_id: "ag1", agent_type: "tester" }, { dir: dir2 });
      const transcriptPath2 = join(dir2, "transcript.jsonl");
      writeFileSync(
        transcriptPath2,
        [handbackLine(claim(["tests/a.test.mjs"])), handbackLine(claim(["tests/other.test.mjs"]))].join("\n") + "\n",
      );
      const input2 = {
        hook_event_name: "SubagentStop",
        agent_id: "ag1",
        agent_type: "tester",
        agent_transcript_path: transcriptPath2,
        last_assistant_message: "Report delivered via SubagentHandback.",
      };
      const r2 = runHookScript("stop-gate", input2, { dir: dir2 });
      expect(r2.json.decision === "block", "expected the reversed order's LAST hand-back (the wrong file) to block").toBe(true);
    });

    it("H3 a non-tester agent_type with a hand-back claim still blocks with the agent_type message: the fallback does not bypass the tester-only check", () => {
      const dir = makeProject({
        config: { ...baseConfig, commands: { test: "echo ' FAIL  tests/a.test.mjs > it'; exit 1" } },
        git: true,
      });
      mkdirSync(join(dir, "tests"));
      writeFileSync(join(dir, "tests/a.test.mjs"), "a");
      runHookScript("edit-loop", { tool_name: "Write", tool_input: { file_path: "tests/a.test.mjs" }, agent_id: "ag1", agent_type: "coder" }, { dir });
      const transcriptPath = join(dir, "transcript.jsonl");
      writeFileSync(transcriptPath, handbackLine(claim(["tests/a.test.mjs"])) + "\n");
      const input = {
        hook_event_name: "SubagentStop",
        agent_id: "ag1",
        agent_type: "coder",
        agent_transcript_path: transcriptPath,
        last_assistant_message: "Report delivered via SubagentHandback.",
      };
      const r = runHookScript("stop-gate", input, { dir });
      expect(r.json.decision).toBe("block");
      const lines = r.json.reason.trim().split("\n");
      const lastLine = lines[lines.length - 1];
      // Boolean-wrapped (not two separate .toMatch/.toContain calls on the raw line) so a failure here never
      // prints lastLine itself: today, with no claim recognized at all, lastLine IS the fixture's raw "FAIL
      // tests/a.test.mjs > it" output, which an outer gate scanning this test file's own stdout must not
      // mistake for a real uncovered failing file.
      expect(/tester/i.test(lastLine) && lastLine.includes("coder"), "expected the block's last line to name the agent_type mismatch (tester vs coder)").toBe(true);
    });

    it("H4 a missing or malformed agent_transcript_path never throws; the ordinary block runs both times", () => {
      // nonexistent file
      const dir = makeProject({
        config: { ...baseConfig, commands: { test: "echo ' FAIL  tests/a.test.mjs > it'; exit 1" } },
        git: true,
      });
      mkdirSync(join(dir, "tests"));
      writeFileSync(join(dir, "tests/a.test.mjs"), "a");
      runHookScript("edit-loop", { tool_name: "Write", tool_input: { file_path: "tests/a.test.mjs" }, agent_id: "ag1", agent_type: "tester" }, { dir });
      const input = {
        hook_event_name: "SubagentStop",
        agent_id: "ag1",
        agent_type: "tester",
        agent_transcript_path: join(dir, "nope.jsonl"),
        last_assistant_message: "No structured claim here at all.",
      };
      const r = runHookScript("stop-gate", input, { dir });
      expect(r.json.decision, `expected a missing transcript path to fail open into the ordinary block, not throw; got ${JSON.stringify(r.json)}`).toBe("block");
      expect(r.json.reason).toContain("Subagent tester (ag1) cannot report done: verification failed (1/");

      // a file holding a garbage line
      const dir2 = makeProject({
        config: { ...baseConfig, commands: { test: "echo ' FAIL  tests/a.test.mjs > it'; exit 1" } },
        git: true,
      });
      mkdirSync(join(dir2, "tests"));
      writeFileSync(join(dir2, "tests/a.test.mjs"), "a");
      runHookScript("edit-loop", { tool_name: "Write", tool_input: { file_path: "tests/a.test.mjs" }, agent_id: "ag1", agent_type: "tester" }, { dir: dir2 });
      const transcriptPath2 = join(dir2, "transcript.jsonl");
      writeFileSync(transcriptPath2, "not valid json at all\n");
      const input2 = {
        hook_event_name: "SubagentStop",
        agent_id: "ag1",
        agent_type: "tester",
        agent_transcript_path: transcriptPath2,
        last_assistant_message: "No structured claim here at all.",
      };
      const r2 = runHookScript("stop-gate", input2, { dir: dir2 });
      expect(r2.json.decision, `expected a malformed transcript line to fail open into the ordinary block, not throw; got ${JSON.stringify(r2.json)}`).toBe("block");
      expect(r2.json.reason).toContain("Subagent tester (ag1) cannot report done: verification failed (1/");
    });

    it("H5 a valid claim in last_assistant_message wins over a different claim in the hand-back: plain text is read first", () => {
      const dir = makeProject({
        config: { ...baseConfig, commands: { test: "echo ' FAIL  tests/a.test.mjs > it'; exit 1" } },
        git: true,
      });
      mkdirSync(join(dir, "tests"));
      writeFileSync(join(dir, "tests/a.test.mjs"), "a");
      runHookScript("edit-loop", { tool_name: "Write", tool_input: { file_path: "tests/a.test.mjs" }, agent_id: "ag1", agent_type: "tester" }, { dir });
      const transcriptPath = join(dir, "transcript.jsonl");
      writeFileSync(transcriptPath, handbackLine(claim(["tests/other.test.mjs"])) + "\n");
      const input = {
        hook_event_name: "SubagentStop",
        agent_id: "ag1",
        agent_type: "tester",
        agent_transcript_path: transcriptPath,
        last_assistant_message: `Ran the new test; it fails as designed.\n${claim(["tests/a.test.mjs"])}`,
      };
      const r = runHookScript("stop-gate", input, { dir });
      expect(r.json.decision, `expected the plain-text claim to win over the hand-back's different claim; got ${JSON.stringify(r.json)}`).toBeUndefined();
      expect(r.json.systemMessage).toContain("Subagent tester (ag1) stopped with tests red by design: tests/a.test.mjs");
    });

    // card tester-claim-missed-in-handback, review round 1: three mechanisms of lastHandbackMessage
    // (stop-gate.mjs) unpinned by H1-H5 above. H6-H8 pin them; all three pass today.
    it("H6 (R3) a claim hand-back followed by a later assistant line with a SendMessage tool_use carrying a non-claim message: the claim is still honoured", () => {
      const dir = makeProject({
        config: { ...baseConfig, commands: { test: "echo ' FAIL  tests/a.test.mjs > it'; exit 1" } },
        git: true,
      });
      mkdirSync(join(dir, "tests"));
      writeFileSync(join(dir, "tests/a.test.mjs"), "a");
      runHookScript("edit-loop", { tool_name: "Write", tool_input: { file_path: "tests/a.test.mjs" }, agent_id: "ag1", agent_type: "tester" }, { dir });
      const transcriptPath = join(dir, "transcript.jsonl");
      // Same assistant-line shape as handbackLine, but tool_use.name is "SendMessage", not "SubagentHandback".
      // Its input.message is a plain string carrying no claim; only the `name` filter keeps it from winning.
      const sendMessageLine = JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "tool_use", name: "SendMessage", input: { message: "just checking in, no claim here" } }] },
      });
      writeFileSync(transcriptPath, [handbackLine(claim(["tests/a.test.mjs"])), sendMessageLine].join("\n") + "\n");
      const input = {
        hook_event_name: "SubagentStop",
        agent_id: "ag1",
        agent_type: "tester",
        agent_transcript_path: transcriptPath,
        last_assistant_message: "Report delivered via SubagentHandback.",
      };
      const r = runHookScript("stop-gate", input, { dir });
      expect(r.json.decision === undefined, "expected the SubagentHandback claim to still be honoured despite a later non-claim SendMessage call").toBe(true);
      expect(r.json.systemMessage.includes("Subagent tester (ag1) stopped with tests red by design: tests/a.test.mjs"), "expected the red-by-design systemMessage").toBe(true);
    });

    it("H7 (R2) a claim hand-back followed by more than 2 MiB of padding, with no later hand-back: it blocks because the claim lies outside the read window", () => {
      const dir = makeProject({
        config: { ...baseConfig, commands: { test: "echo ' FAIL  tests/a.test.mjs > it'; exit 1" } },
        git: true,
      });
      mkdirSync(join(dir, "tests"));
      writeFileSync(join(dir, "tests/a.test.mjs"), "a");
      runHookScript("edit-loop", { tool_name: "Write", tool_input: { file_path: "tests/a.test.mjs" }, agent_id: "ag1", agent_type: "tester" }, { dir });
      const transcriptPath = join(dir, "transcript.jsonl");
      // 10 x 300KB non-JSON lines = ~3MB, well past lastHandbackMessage's 2 MiB (HANDBACK_TAIL_BYTES) read
      // window, and none of them is a hand-back, so the only claim in the file falls entirely outside it.
      const paddingLines = Array.from({ length: 10 }, (_, i) => `padding line ${i} ` + "p".repeat(300 * 1024));
      writeFileSync(transcriptPath, [handbackLine(claim(["tests/a.test.mjs"])), ...paddingLines].join("\n") + "\n");
      const input = {
        hook_event_name: "SubagentStop",
        agent_id: "ag1",
        agent_type: "tester",
        agent_transcript_path: transcriptPath,
        last_assistant_message: "Report delivered via SubagentHandback.",
      };
      const r = runHookScript("stop-gate", input, { dir });
      expect(r.json.decision === "block", `expected the claim beyond the 2 MiB read window to be invisible to the fallback, blocking as usual; got decision=${r.json.decision}`).toBe(true);
    });

    it("H8 (R1) the window's first line is cut, and the claim sits in that cut line's tail: the tail would parse as a valid claim on its own, but is skipped, so it blocks", () => {
      const dir = makeProject({
        config: { ...baseConfig, commands: { test: "echo ' FAIL  tests/a.test.mjs > it'; exit 1" } },
        git: true,
      });
      mkdirSync(join(dir, "tests"));
      writeFileSync(join(dir, "tests/a.test.mjs"), "a");
      runHookScript("edit-loop", { tool_name: "Write", tool_input: { file_path: "tests/a.test.mjs" }, agent_id: "ag1", agent_type: "tester" }, { dir });
      const transcriptPath = join(dir, "transcript.jsonl");

      // lastHandbackMessage (stop-gate.mjs) only ever reads the file's last HANDBACK_TAIL_BYTES, and skips
      // whatever (possibly partial) first line that read produces. Lay the file out as
      // [leadingPadding][claimLine]\n[trailing], sized so the window starts exactly at claimLine's first
      // byte: the read window's first "line" IS claimLine, byte for byte — a complete, standalone-parseable
      // SubagentHandback claim — yet it is the skipped line, not a genuinely truncated fragment.
      const HANDBACK_TAIL_BYTES = 2 * 1024 * 1024;
      const claimLine = handbackLine(claim(["tests/a.test.mjs"])); // pure ASCII: byte length === char length
      const leadingPadding = "z".repeat(1000); // never read (lies before the window start); any length > 0 works
      const trailing = "y".repeat(HANDBACK_TAIL_BYTES - claimLine.length - 1); // makes size - start land exactly at leadingPadding.length
      writeFileSync(transcriptPath, leadingPadding + claimLine + "\n" + trailing);

      const size = statSync(transcriptPath).size;
      expect(size - HANDBACK_TAIL_BYTES).toBe(leadingPadding.length); // sanity: cut lands exactly at claimLine's own start

      const input = {
        hook_event_name: "SubagentStop",
        agent_id: "ag1",
        agent_type: "tester",
        agent_transcript_path: transcriptPath,
        last_assistant_message: "Report delivered via SubagentHandback.",
      };
      const r = runHookScript("stop-gate", input, { dir });
      expect(r.json.decision === "block", `expected the cut leading line to be skipped rather than read as a claim; got decision=${r.json.decision}`).toBe(true);
    });
  });
});

// card stop-gate-block-ledger: no implementation exists yet (writer + classifier in a new
// plugins/doug-gates/lib/block-ledger.mjs, called from scripts/stop-gate.mjs). Every test below reads
// `.doug/.state/blocks.jsonl` under the project dir, one JSON object per line: { hook: "stop-gate" |
// "subagent-stop", at: <ISO>, agent: <agent_type string, or null on the main Stop>, reason: <first line of
// the block message>, class: "expected-red" | "load-timeout" | "race" | "real" | "stood-down", session:
// <session_id> }. Distinct from the honoured-claim's own new state key, state.redByDesignClaim = { files,
// at: <ISO>, agent: <subagent.id, NOT agent_type> } — the ledger's "agent" and the state key's "agent" name
// different things (agent_type vs agent_id) by design (brief facts F1/F2/Rules).
describe("card stop-gate-block-ledger", () => {
  const LEDGER_RELPATH = ".doug/.state/blocks.jsonl";
  function readLedger(dir) {
    const file = join(dir, LEDGER_RELPATH);
    if (!existsSync(file)) return [];
    return readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  }
  function sessionStateOf(dir) {
    return JSON.parse(readFileSync(join(dir, ".doug/.state/test-session.json"), "utf8"));
  }

  it("expected-red: a block whose failing file(s) are all covered by the standing tests_red_by_design claim is classified expected-red; once an uncovered file fails instead, the block is classified real", () => {
    const dir = makeProject({
      config: { ...baseConfig, commands: { test: "echo ' FAIL  tests/a.test.mjs > it'; exit 1" } },
      git: true,
    });
    mkdirSync(join(dir, "tests"));
    writeFileSync(join(dir, "tests/a.test.mjs"), "it fails on purpose");
    runHookScript("edit-loop", { tool_name: "Write", tool_input: { file_path: "tests/a.test.mjs" }, agent_id: "ag1", agent_type: "tester" }, { dir });

    // The tester's covered claim records the standing state.redByDesignClaim (tests/a.test.mjs only) and is
    // itself honoured (systemMessage, not a block) — it must write no ledger line at all.
    const testerInput = {
      hook_event_name: "SubagentStop",
      agent_id: "ag1",
      agent_type: "tester",
      last_assistant_message: `Ran the new test; it fails as designed.\n${JSON.stringify({ tests_red_by_design: ["tests/a.test.mjs"] })}`,
    };
    const honoured = runHookScript("stop-gate", testerInput, { dir });
    expect(honoured.json.decision).toBeUndefined();
    expect(readLedger(dir)).toEqual([]);

    // Main Stop, same still-red file: it blocks (the main Stop never honours the claim itself, T5), but the
    // standing claim covers the one failing file, so the ledger classifies it expected-red.
    const r1 = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
    expect(r1.json.decision).toBe("block");
    const line1 = readLedger(dir).find((l) => l.class === "expected-red");
    expect(line1, `expected an expected-red line; got ${JSON.stringify(readLedger(dir))}`).toBeTruthy();
    expect(line1.hook).toBe("stop-gate");
    expect(line1.agent).toBeNull();

    // The project's verification command now fails on tests/b.test.mjs instead — a file the standing claim
    // never named — so this next block must not read as expected-red.
    writeFileSync(
      join(dir, ".doug/config.json"),
      JSON.stringify({ ...baseConfig, commands: { test: "echo ' FAIL  tests/b.test.mjs > it'; exit 1" } }),
    );
    writeFileSync(join(dir, "tests/b.test.mjs"), "b");
    runHookScript("edit-loop", { tool_name: "Write", tool_input: { file_path: "tests/b.test.mjs" } }, { dir });
    const before = readLedger(dir).length;
    const r2 = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
    expect(r2.json.decision).toBe("block");
    const after = readLedger(dir);
    expect(after.length, JSON.stringify(after)).toBe(before + 1);
    expect(after[after.length - 1].class).toBe("real");
  });

  it("load-timeout: a block where a command timed out and no captured output names a failing test file is classified load-timeout", () => {
    const dir = makeProject({
      config: {
        ...baseConfig,
        commands: { slow: `${process.execPath} -e "setTimeout(() => {}, 10000)"` },
        stopGate: { commands: ["slow"], onlyIfEdited: true, maxBlocks: 3, timeoutMs: 1500, requireEvidence: false },
      },
      git: true,
    });
    writeFileSync(join(dir, "a.ts"), "x");
    runHookScript("edit-loop", { tool_name: "Edit", tool_input: { file_path: "a.ts" } }, { dir });
    const r = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
    expect(r.json && r.json.decision).toBe("block");
    expect(r.json.reason.toLowerCase()).toContain("timed out");
    const line = readLedger(dir).find((l) => l.class === "load-timeout");
    expect(line, `expected a load-timeout line; got ${JSON.stringify(readLedger(dir))}`).toBeTruthy();
    expect(line.hook).toBe("stop-gate");
  });

  it("race: a block where the verification command itself dirties the tree (an untracked file appears) before failing is classified race", () => {
    const dir = makeProject({
      config: {
        ...baseConfig,
        commands: { test: `${process.execPath} -e "require('fs').writeFileSync('surprise.txt','x'); process.exit(1)"` },
      },
      git: true,
    });
    writeFileSync(join(dir, "src.ts"), "base");
    execFileSync("git", ["add", "-A"], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", "base"], { cwd: dir });
    writeFileSync(join(dir, "src.ts"), "edited this session");
    runHookScript("edit-loop", { tool_name: "Edit", tool_input: { file_path: "src.ts" } }, { dir });
    const r = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
    expect(r.json && r.json.decision).toBe("block");
    const line = readLedger(dir).find((l) => l.class === "race");
    expect(line, `expected a race line; got ${JSON.stringify(readLedger(dir))}`).toBeTruthy();
    expect(line.hook).toBe("stop-gate");
  });

  it("real: a plain failing command, no standing claim, no timeout, and no tree change is classified real", () => {
    const dir = makeProject({
      config: { ...baseConfig, commands: { test: "exit 1" } },
      git: true,
    });
    writeFileSync(join(dir, "a.ts"), "x");
    runHookScript("edit-loop", { tool_name: "Edit", tool_input: { file_path: "a.ts" } }, { dir });
    const r = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
    expect(r.json && r.json.decision).toBe("block");
    const line = readLedger(dir).find((l) => l.class === "real");
    expect(line, `expected a real line; got ${JSON.stringify(readLedger(dir))}`).toBeTruthy();
  });

  it("stood-down: a stand-down at the counter cap writes one line with class stood-down and the stand-down message's first line as reason", () => {
    const dir = makeProject({
      config: { ...baseConfig, commands: { test: "exit 1" } },
      git: true,
    });
    writeFileSync(join(dir, "a.ts"), "x");
    runHookScript("edit-loop", { tool_name: "Edit", tool_input: { file_path: "a.ts" } }, { dir });
    mkdirSync(join(dir, ".doug/.state"), { recursive: true });
    // baseConfig.stopGate.maxBlocks is 3; a session already blocked 3 times stands down instead of blocking again.
    writeFileSync(join(dir, ".doug/.state/test-session.json"), JSON.stringify({ stopBlocks: 3 }));
    const r = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
    expect(r.json && r.json.decision).toBeUndefined();
    expect(r.json.systemMessage).toContain("standing down");
    const line = readLedger(dir).find((l) => l.class === "stood-down");
    expect(line, `expected a stood-down line; got ${JSON.stringify(readLedger(dir))}`).toBeTruthy();
    expect(line.hook).toBe("stop-gate");
    expect(line.reason).toContain("standing down");
    expect(r.json.systemMessage.startsWith(line.reason) || r.json.systemMessage === line.reason).toBe(true);
  });

  it("the lock-refusal line: a live lock still held when the hook-timeout budget runs out is classified load-timeout, naming the holder session", () => {
    const dir = makeProject({
      config: {
        ...baseConfig,
        commands: { "test:unit": `${process.execPath} -e "require('fs').appendFileSync('.doug/.state/runs.log','x')"` },
        stopGate: { commands: ["test:unit"], onlyIfEdited: true, maxBlocks: 3, timeoutMs: 10000, hookTimeoutSec: 3, requireEvidence: false },
      },
      git: true,
    });
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src/a.ts"), "base");
    execFileSync("git", ["add", "-A"], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", "base"], { cwd: dir });
    writeFileSync(join(dir, "src/a.ts"), "edited this session");
    runHookScript("edit-loop", { tool_name: "Edit", tool_input: { file_path: "src/a.ts" } }, { dir });

    mkdirSync(join(dir, ".doug/.state"), { recursive: true });
    const holderScript = join(dir, ".doug/.state/holder-ledger.mjs");
    writeFileSync(holderScript, "setTimeout(() => {}, 12000);"); // well past both hookTimeoutSec (3s) and stopGate.timeoutMs (10s)
    const holder = spawn(process.execPath, [holderScript], { cwd: dir, stdio: "ignore" });
    writeFileSync(join(dir, ".doug/.state/gate.lock"), JSON.stringify({ pid: holder.pid, session: "holder-session", at: Date.now() }));
    try {
      const r = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
      expect(r.json && r.json.decision).toBe("block");
      expect(r.json.reason).toContain("holder-session");
      const line = readLedger(dir).find((l) => l.class === "load-timeout" && l.reason.includes("holder-session"));
      expect(line, `expected a load-timeout lock-refusal line; got ${JSON.stringify(readLedger(dir))}`).toBeTruthy();
      expect(line.hook).toBe("stop-gate");
    } finally {
      try {
        process.kill(holder.pid, "SIGKILL");
      } catch {
        // already exited
      }
    }
  });

  it("the honoured claim records state.redByDesignClaim = { files, at, agent } (agent is the subagent's id, not its type)", () => {
    const dir = makeProject({
      config: { ...baseConfig, commands: { test: "echo ' FAIL  tests/a.test.mjs > it'; exit 1" } },
      git: true,
    });
    mkdirSync(join(dir, "tests"));
    writeFileSync(join(dir, "tests/a.test.mjs"), "it fails on purpose");
    runHookScript("edit-loop", { tool_name: "Write", tool_input: { file_path: "tests/a.test.mjs" }, agent_id: "ag1", agent_type: "tester" }, { dir });
    const input = {
      hook_event_name: "SubagentStop",
      agent_id: "ag1",
      agent_type: "tester",
      last_assistant_message: `Ran the new test; it fails as designed.\n${JSON.stringify({ tests_red_by_design: ["tests/a.test.mjs"] })}`,
    };
    const r = runHookScript("stop-gate", input, { dir });
    expect(r.json.decision).toBeUndefined();
    const state = sessionStateOf(dir);
    expect(state.redByDesignClaim).toBeTruthy();
    expect(state.redByDesignClaim.files).toEqual(["tests/a.test.mjs"]);
    expect(typeof state.redByDesignClaim.at).toBe("string");
    expect(Number.isNaN(new Date(state.redByDesignClaim.at).getTime())).toBe(false);
    expect(state.redByDesignClaim.agent).toBe("ag1"); // subagent.id, not "tester" (agent_type)
  });

  it("line shape (main Stop): hook 'stop-gate', at an ISO string, agent null, reason a single line with no session/class leakage, class, and session", () => {
    const dir = makeProject({
      config: { ...baseConfig, commands: { test: "exit 1" } },
      git: true,
    });
    writeFileSync(join(dir, "a.ts"), "x");
    runHookScript("edit-loop", { tool_name: "Edit", tool_input: { file_path: "a.ts" } }, { dir });
    const r = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
    expect(r.json.decision).toBe("block");
    const lines = readLedger(dir);
    expect(lines.length).toBe(1);
    const line = lines[0];
    expect(line.hook).toBe("stop-gate");
    expect(typeof line.at).toBe("string");
    expect(Number.isNaN(new Date(line.at).getTime())).toBe(false);
    expect(line.agent).toBeNull();
    expect(typeof line.reason).toBe("string");
    expect(line.reason).not.toContain("\n");
    expect(line.reason).toBe(r.json.reason.split("\n")[0]);
    expect(["expected-red", "load-timeout", "race", "real", "stood-down"]).toContain(line.class);
    expect(line.session).toBe("test-session");
  });

  it("line shape (SubagentStop): hook 'subagent-stop' and agent is the agent_type string, not the agent_id", () => {
    const dir = makeProject({
      config: { ...baseConfig, commands: { test: "exit 1" } },
      git: true,
    });
    writeFileSync(join(dir, "a.ts"), "x");
    runHookScript("edit-loop", { tool_name: "Edit", tool_input: { file_path: "a.ts" }, agent_id: "ag1", agent_type: "coder" }, { dir });
    const r = runHookScript("stop-gate", { hook_event_name: "SubagentStop", agent_id: "ag1", agent_type: "coder" }, { dir });
    expect(r.json.decision).toBe("block");
    const line = readLedger(dir).find((l) => l.hook === "subagent-stop");
    expect(line, `expected a subagent-stop line; got ${JSON.stringify(readLedger(dir))}`).toBeTruthy();
    expect(line.agent).toBe("coder");
    expect(line.session).toBe("test-session");
  });

  it("writes no line at all on a green gate", () => {
    const dir = makeProject({ config: baseConfig, git: true }); // baseConfig's test command exits 0
    writeFileSync(join(dir, "a.ts"), "x");
    runHookScript("edit-loop", { tool_name: "Edit", tool_input: { file_path: "a.ts" } }, { dir });
    const r = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
    expect(r.json).toBeNull();
    expect(existsSync(join(dir, LEDGER_RELPATH))).toBe(false);
  });

  it("never throws: a blocks.jsonl path that is itself a directory does not stop the gate from blocking normally (the writer skips silently)", () => {
    const dir = makeProject({
      config: { ...baseConfig, commands: { test: "exit 1" } },
      git: true,
    });
    writeFileSync(join(dir, "a.ts"), "x");
    runHookScript("edit-loop", { tool_name: "Edit", tool_input: { file_path: "a.ts" } }, { dir });
    // A directory sits where the ledger file would be written: the writer's appendFileSync must fail with
    // EISDIR, and that failure must never propagate out of the gate (a hook reader must never throw).
    mkdirSync(join(dir, LEDGER_RELPATH), { recursive: true });
    const r = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
    expect(r.status).toBe(0);
    expect(r.json && r.json.decision, "the gate must still block, never fail open, when the ledger write fails").toBe("block");
    expect(r.json.reason).toContain("Verification failed");
  });

  // Reviewer pass 2 (coordinator brief): gaps the first tester pass left unpinned, against the now-landed
  // implementation (plugins/doug-gates/lib/block-ledger.mjs, imported by stop-gate.mjs).
  describe("reviewer pass 2: per-command coverage, other preconditions, and stand-down sites", () => {
    // Establishes a standing state.redByDesignClaim covering exactly `files` (default: tests/a.test.mjs
    // alone), the same way the existing tests red by design section's T1 does: a tester SubagentStop whose
    // command output fails only on `files` and whose claim covers exactly that.
    function establishStandingClaim(dir, files = ["tests/a.test.mjs"]) {
      const testerInput = {
        hook_event_name: "SubagentStop",
        agent_id: "ag1",
        agent_type: "tester",
        last_assistant_message: `Ran the new tests; they fail as designed.\n${JSON.stringify({ tests_red_by_design: files })}`,
      };
      const r = runHookScript("stop-gate", testerInput, { dir });
      expect(r.json.decision, `setup: the tester claim must be honoured to establish the standing claim; got ${JSON.stringify(r.json)}`).toBeUndefined();
    }

    it("item 1 (MAJOR): a standing claim covering tests/a.test.mjs does not excuse a second, unrelated failing command that names no test file at all -> real, not expected-red", () => {
      const dir = makeProject({
        config: { ...baseConfig, commands: { test: "echo ' FAIL  tests/a.test.mjs > it'; exit 1" } },
        git: true,
      });
      mkdirSync(join(dir, "tests"));
      writeFileSync(join(dir, "tests/a.test.mjs"), "it fails on purpose");
      runHookScript("edit-loop", { tool_name: "Write", tool_input: { file_path: "tests/a.test.mjs" }, agent_id: "ag1", agent_type: "tester" }, { dir });
      establishStandingClaim(dir, ["tests/a.test.mjs"]);

      // Reconfigure: two commands now fail — a typecheck-shaped one that names no test file at all, and the
      // original one still naming the covered file. Neither "FAIL" nor "failed" appears in the typecheck
      // line, so failingTestFilesFrom finds nothing for it — the claim cannot honestly account for it.
      writeFileSync(
        join(dir, ".doug/config.json"),
        JSON.stringify({
          ...baseConfig,
          commands: {
            typecheck: "echo 'src/x.ts(1,1): error TS2322: Type mismatch'; exit 1",
            test: "echo ' FAIL  tests/a.test.mjs > it'; exit 1",
          },
          stopGate: { commands: ["typecheck", "test"], onlyIfEdited: true, maxBlocks: 3, timeoutMs: 10000, requireEvidence: false },
        }),
      );
      const before = readLedger(dir).length;
      const r = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
      expect(r.json.decision).toBe("block");
      const after = readLedger(dir);
      expect(after.length, JSON.stringify(after)).toBe(before + 1);
      expect(
        after[after.length - 1].class,
        `the typecheck failure names no test file at all, so the claim cannot cover it; got ${JSON.stringify(after[after.length - 1])}`,
      ).toBe("real");
    });

    it("item 2: a standing claim covering the failing file, plus a dirty protected path, is not expected-red (a pre-verification problem disqualifies it)", () => {
      const dir = makeProject({
        config: { ...baseConfig, commands: { test: "echo ' FAIL  tests/a.test.mjs > it'; exit 1" } },
        git: true,
      });
      mkdirSync(join(dir, "tests"));
      writeFileSync(join(dir, "tests/a.test.mjs"), "it fails on purpose");
      runHookScript("edit-loop", { tool_name: "Write", tool_input: { file_path: "tests/a.test.mjs" }, agent_id: "ag1", agent_type: "tester" }, { dir });
      establishStandingClaim(dir, ["tests/a.test.mjs"]);

      writeFileSync(join(dir, ".env"), "SECRET=1"); // baseConfig.protectedPaths includes ".env"
      const before = readLedger(dir).length;
      const r = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
      expect(r.json.decision).toBe("block");
      expect(r.json.reason).toContain(".env");
      const after = readLedger(dir);
      expect(after.length, JSON.stringify(after)).toBe(before + 1);
      expect(after[after.length - 1].class, JSON.stringify(after[after.length - 1])).toBe("real");
    });

    it("item 3: a partial-claim refusal writes one ledger line with class real", () => {
      const dir = makeProject({ config: baseConfig, git: true }); // contextWindow defaults disabled
      const claim = JSON.stringify({ partial: true, completed: "did a", remaining: "do b", next: "start b", verify: "pnpm test" });
      const input = { hook_event_name: "SubagentStop", agent_id: "ag1", agent_type: "coder", last_assistant_message: claim };
      const r = runHookScript("stop-gate", input, { dir });
      expect(r.json.decision).toBe("block");
      expect(r.json.reason).toContain("Partial result refused");
      const lines = readLedger(dir);
      expect(lines.length, JSON.stringify(lines)).toBe(1);
      expect(lines[0].class).toBe("real");
      expect(lines[0].hook).toBe("subagent-stop");
      expect(lines[0].reason).toBe(r.json.reason.split("\n")[0]);
    });

    it("item 4: the partial-claim stand-down at the cap writes one stood-down line", () => {
      const dir = makeProject({ config: { ...baseConfig, stopGate: { ...baseConfig.stopGate, maxBlocks: 1 } }, git: true });
      const claim = JSON.stringify({ partial: true, completed: "did a", remaining: "do b", next: "start b", verify: "pnpm test" });
      const input = { hook_event_name: "SubagentStop", agent_id: "ag1", agent_type: "coder", last_assistant_message: claim };
      const first = runHookScript("stop-gate", input, { dir });
      expect(first.json.decision).toBe("block");
      const before = readLedger(dir).length;
      const second = runHookScript("stop-gate", input, { dir });
      expect(second.json.decision).toBeUndefined();
      expect(second.json.systemMessage).toContain("standing down");
      const after = readLedger(dir);
      expect(after.length, JSON.stringify(after)).toBe(before + 1);
      expect(after[after.length - 1].class).toBe("stood-down");
      expect(after[after.length - 1].reason).toBe(second.json.systemMessage.split("\n")[0]);
    });

    it("item 5: the lock-refusal stand-down at the cap (blocks already at maxBlocks) writes one stood-down line, not load-timeout", () => {
      const dir = makeProject({
        config: {
          ...baseConfig,
          commands: { "test:unit": `${process.execPath} -e "require('fs').appendFileSync('.doug/.state/runs.log','x')"` },
          stopGate: { commands: ["test:unit"], onlyIfEdited: true, maxBlocks: 1, timeoutMs: 10000, hookTimeoutSec: 3, requireEvidence: false },
        },
        git: true,
      });
      mkdirSync(join(dir, "src"));
      writeFileSync(join(dir, "src/a.ts"), "base");
      execFileSync("git", ["add", "-A"], { cwd: dir });
      execFileSync("git", ["commit", "-q", "-m", "base"], { cwd: dir });
      writeFileSync(join(dir, "src/a.ts"), "edited this session");
      runHookScript("edit-loop", { tool_name: "Edit", tool_input: { file_path: "src/a.ts" } }, { dir });

      mkdirSync(join(dir, ".doug/.state"), { recursive: true });
      // Already at the cap (maxBlocks: 1) before this Stop even runs, so the refusal below must stand down
      // instead of blocking again.
      writeFileSync(join(dir, ".doug/.state/test-session.json"), JSON.stringify({ stopBlocks: 1 }));
      const holderScript = join(dir, ".doug/.state/holder-item5.mjs");
      writeFileSync(holderScript, "setTimeout(() => {}, 12000);"); // outlives hookTimeoutSec (3s) and timeoutMs (10s)
      const holder = spawn(process.execPath, [holderScript], { cwd: dir, stdio: "ignore" });
      writeFileSync(join(dir, ".doug/.state/gate.lock"), JSON.stringify({ pid: holder.pid, session: "holder-session", at: Date.now() }));
      try {
        const r = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
        expect(r.json && r.json.decision).toBeUndefined();
        expect(r.json.systemMessage).toContain("standing down");
        const line = readLedger(dir).find((l) => l.class === "stood-down");
        expect(line, `expected a stood-down line; got ${JSON.stringify(readLedger(dir))}`).toBeTruthy();
        expect(readLedger(dir).some((l) => l.class === "load-timeout"), "the cap must win over load-timeout here: one stood-down line, not a load-timeout one").toBe(false);
      } finally {
        try {
          process.kill(holder.pid, "SIGKILL");
        } catch {
          // already exited
        }
      }
    });

    it("item 6: a command dropped for budget ('not run'), with no failing test named anywhere, is classified load-timeout", () => {
      const runsLogRelpath = ".doug/.state/runs.log";
      const secondCommand = `${process.execPath} -e "require('fs').appendFileSync('${runsLogRelpath}','x')"`;
      const dir = makeProject({
        config: {
          ...baseConfig,
          commands: { slow: `${process.execPath} -e "setTimeout(() => {}, 10000)"`, second: secondCommand },
          stopGate: { commands: ["slow", "second"], onlyIfEdited: true, maxBlocks: 3, timeoutMs: 60000, hookTimeoutSec: 2, requireEvidence: false },
        },
        git: true,
      });
      writeFileSync(join(dir, "a.ts"), "x");
      runHookScript("edit-loop", { tool_name: "Edit", tool_input: { file_path: "a.ts" } }, { dir });
      const r = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
      expect(r.json && r.json.decision).toBe("block");
      expect(r.json.reason).toContain("not run");
      expect(existsSync(join(dir, runsLogRelpath)), "the dropped command must never have run").toBe(false);
      const line = readLedger(dir).find((l) => l.class === "load-timeout");
      expect(line, `expected a load-timeout line; got ${JSON.stringify(readLedger(dir))}`).toBeTruthy();
    });

    it("item 7: the turn-budget stand-down ('Gates are no longer blocking') writes one stood-down line", () => {
      const dir = makeProject({ config: { ...baseConfig, budget: { maxTurns: 1 } }, git: true });
      mkdirSync(join(dir, ".doug/.state"), { recursive: true });
      writeFileSync(join(dir, ".doug/.state/test-session.json"), JSON.stringify({ turns: 5 })); // already well past maxTurns
      const r = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
      expect(r.json && r.json.decision).toBeUndefined();
      expect(r.json.systemMessage).toContain("Gates are no longer blocking");
      const lines = readLedger(dir);
      expect(lines.length, `expected one stood-down line; got ${JSON.stringify(lines)}`).toBe(1);
      expect(lines[0].class).toBe("stood-down");
      expect(lines[0].hook).toBe("stop-gate");
      expect(lines[0].agent).toBeNull();
      expect(lines[0].reason).toBe(r.json.systemMessage.split("\n")[0]);
    });
  });

  // Round 3 (coordinator brief): classifyFinalBlock exercised directly (imported at the top of this file),
  // pinning two preconditions the gate-level fixtures above cannot isolate as cleanly as calling the pure
  // function itself: (a) a budget-dropped command with no timed-out entry still reads load-timeout, and (b)
  // the budgetDeadline-gated race check (review pass 2, item 4 in block-ledger.mjs's own header comment).
  describe("round 3: classifyFinalBlock exercised directly", () => {
    it("(a) a results entry with only skipped: 'budget' (no timedOut entry at all) and no command failure naming a test file classifies as load-timeout", () => {
      const dir = makeProject({});
      const cls = classifyFinalBlock({
        preVerificationProblems: 0,
        evidenceProblemAdded: false,
        commandFailures: [],
        postCommandProblems: 1,
        results: [{ name: "second", command: "echo hi", ok: false, skipped: "budget" }],
        redByDesignClaimFiles: null,
        changedAtStart: null,
        dir,
        budgetDeadline: undefined,
      });
      expect(cls).toBe("load-timeout");
    });

    it("(b) a differing tree classifies as real once budgetDeadline has already passed, and as race while budgetDeadline is still ahead", () => {
      const dir = makeProject({ git: true });
      // changedAtStart is deliberately built to differ from what changedFiles(dir) will read right now: an
      // untracked file exists on disk that changedAtStart never named.
      writeFileSync(join(dir, "untracked.txt"), "x");
      const changedNow = changedFiles(dir);
      expect(changedNow, "setup: the untracked file must actually show up as changed for this test to mean anything").toContain("untracked.txt");
      const changedAtStart = []; // differs from changedNow as a set

      const base = {
        preVerificationProblems: 0,
        evidenceProblemAdded: false,
        commandFailures: [],
        postCommandProblems: 0,
        results: [],
        redByDesignClaimFiles: null,
        changedAtStart,
        dir,
      };

      const past = classifyFinalBlock({ ...base, budgetDeadline: Date.now() - 1 });
      expect(past, "a deadline already blown must skip the race check entirely and fall through to real").toBe("real");

      const future = classifyFinalBlock({ ...base, budgetDeadline: Date.now() + 60000 });
      expect(future, "with budget still ahead, the differing tree must be classified race").toBe("race");
    });
  });
});

// card block-ledger-stood-down-repeats: today every Stop/SubagentStop past the cap (or past the turn budget)
// appends another identical "stood-down" ledger line (evidence: two identical lines two seconds apart for one
// session, 2026-09-17T00:47, session a0f5e4fd). Wanted: at most one stood-down line per session per cause —
// turn-budget (lead only), and the block cap keyed per agent (the partial-claim cap and the verification/
// lock-refusal cap of one agent are the same cause). The record of "already written" lives in the session
// state file, set before the saveState that already precedes each logBlock, and a wrong-shaped marker (a
// string, an array, null) must never throw and must not permanently suppress the line by accident.
describe("card block-ledger-stood-down-repeats", () => {
  const LEDGER_RELPATH = ".doug/.state/blocks.jsonl";
  function readLedger(dir) {
    const file = join(dir, LEDGER_RELPATH);
    if (!existsSync(file)) return [];
    return readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  }
  function sessionStateOf(dir, sessionId = "test-session") {
    return JSON.parse(readFileSync(join(dir, `.doug/.state/${sessionId}.json`), "utf8"));
  }
  const stoodDownLines = (dir) => readLedger(dir).filter((l) => l.class === "stood-down");

  it("T1 lead cap: state seeded at the cap, Stop run three times: exactly one line, and the stand-down message is still printed on the second and third run", () => {
    const dir = makeProject({ config: { ...baseConfig, commands: { test: "exit 1" } }, git: true });
    writeFileSync(join(dir, "a.ts"), "x");
    runHookScript("edit-loop", { tool_name: "Edit", tool_input: { file_path: "a.ts" } }, { dir });
    mkdirSync(join(dir, ".doug/.state"), { recursive: true });
    // baseConfig.stopGate.maxBlocks is 3; a session already blocked 3 times stands down instead of blocking again.
    writeFileSync(join(dir, ".doug/.state/test-session.json"), JSON.stringify({ stopBlocks: 3 }));
    const r1 = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
    const r2 = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
    const r3 = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
    for (const r of [r1, r2, r3]) {
      expect(r.json.decision).toBeUndefined();
      expect(r.json.systemMessage).toContain("standing down");
    }
    expect(stoodDownLines(dir), JSON.stringify(stoodDownLines(dir))).toHaveLength(1);
  });

  it("T2 turn budget: budget exceeded, Stop run three times: exactly one line", () => {
    const dir = makeProject({ config: { ...baseConfig, budget: { maxTurns: 1 } }, git: true });
    mkdirSync(join(dir, ".doug/.state"), { recursive: true });
    writeFileSync(join(dir, ".doug/.state/test-session.json"), JSON.stringify({ turns: 5 })); // already well past maxTurns
    const r1 = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
    const r2 = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
    const r3 = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
    for (const r of [r1, r2, r3]) expect(r.json.systemMessage).toContain("Gates are no longer blocking");
    expect(stoodDownLines(dir), JSON.stringify(stoodDownLines(dir))).toHaveLength(1);
  });

  it("T3 two causes, one session: the turn-budget stand-down and the lead's cap stand-down each write their own line", () => {
    const dir = makeProject({
      config: { ...baseConfig, commands: { test: "exit 1" }, budget: { maxTurns: 1 } },
      git: true,
    });
    writeFileSync(join(dir, "a.ts"), "x");
    runHookScript("edit-loop", { tool_name: "Edit", tool_input: { file_path: "a.ts" } }, { dir });
    mkdirSync(join(dir, ".doug/.state"), { recursive: true });
    writeFileSync(join(dir, ".doug/.state/test-session.json"), JSON.stringify({ turns: 5 })); // already well past maxTurns
    const r1 = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
    expect(r1.json.systemMessage).toContain("Gates are no longer blocking");
    expect(stoodDownLines(dir)).toHaveLength(1);

    // Drop the turn budget so the next Stop reaches the lead's block-cap stand-down (a different cause)
    // instead of tripping the turn-budget check again; seed stopBlocks at the cap for that cause.
    writeFileSync(join(dir, ".doug/config.json"), JSON.stringify({ ...baseConfig, commands: { test: "exit 1" } }));
    const midState = sessionStateOf(dir);
    writeFileSync(join(dir, ".doug/.state/test-session.json"), JSON.stringify({ ...midState, stopBlocks: 3 }));
    const r2 = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
    expect(r2.json.systemMessage).toContain("standing down");
    const lines = stoodDownLines(dir);
    expect(lines, JSON.stringify(lines)).toHaveLength(2);
  });

  it("T4 per agent: two subagents of one session each at their cap, each SubagentStop run twice: exactly two lines, one per agent", () => {
    const dir = makeProject({ config: { ...baseConfig, commands: { test: "exit 1" } }, git: true });
    writeFileSync(join(dir, "a.ts"), "x");
    runHookScript("edit-loop", { tool_name: "Edit", tool_input: { file_path: "a.ts" } }, { dir });
    mkdirSync(join(dir, ".doug/.state"), { recursive: true });
    writeFileSync(join(dir, ".doug/.state/test-session.json"), JSON.stringify({ agentBlocks: { ag1: 3, ag2: 3 } }));
    const sub1 = { hook_event_name: "SubagentStop", agent_id: "ag1", agent_type: "coder" };
    const sub2 = { hook_event_name: "SubagentStop", agent_id: "ag2", agent_type: "coder" };
    const results = [
      runHookScript("stop-gate", sub1, { dir }),
      runHookScript("stop-gate", sub1, { dir }),
      runHookScript("stop-gate", sub2, { dir }),
      runHookScript("stop-gate", sub2, { dir }),
    ];
    for (const r of results) {
      expect(r.json.decision).toBeUndefined();
      expect(r.json.systemMessage).toContain("standing down");
    }
    const lines = stoodDownLines(dir);
    expect(lines, JSON.stringify(lines)).toHaveLength(2);
  });

  it("T5 same agent, two stand-down sites (partial-claim cap, then the verification cap): one line, since they are the same cause for that agent", () => {
    const dir = makeProject({ config: { ...baseConfig, commands: { test: "exit 1" } }, git: true });
    writeFileSync(join(dir, "a.ts"), "x");
    runHookScript("edit-loop", { tool_name: "Edit", tool_input: { file_path: "a.ts" } }, { dir });
    mkdirSync(join(dir, ".doug/.state"), { recursive: true });
    writeFileSync(join(dir, ".doug/.state/test-session.json"), JSON.stringify({ agentBlocks: { ag1: 3 } }));
    const claim = JSON.stringify({ partial: true, completed: "did a", remaining: "do b", next: "start b", verify: "pnpm test" });
    const r1 = runHookScript("stop-gate", { hook_event_name: "SubagentStop", agent_id: "ag1", agent_type: "coder", last_assistant_message: claim }, { dir });
    expect(r1.json.systemMessage).toContain("standing down");
    const r2 = runHookScript("stop-gate", { hook_event_name: "SubagentStop", agent_id: "ag1", agent_type: "coder" }, { dir });
    expect(r2.json.systemMessage).toContain("standing down");
    const lines = stoodDownLines(dir);
    expect(lines, JSON.stringify(lines)).toHaveLength(1);
  });

  it("T6 two sessions: the same cause stood down twice in each session gives one line per session", () => {
    const dir = makeProject({ config: { ...baseConfig, commands: { test: "exit 1" } }, git: true });
    writeFileSync(join(dir, "a.ts"), "x");
    runHookScript("edit-loop", { tool_name: "Edit", tool_input: { file_path: "a.ts" } }, { dir });
    mkdirSync(join(dir, ".doug/.state"), { recursive: true });
    writeFileSync(join(dir, ".doug/.state/session-a.json"), JSON.stringify({ stopBlocks: 3 }));
    writeFileSync(join(dir, ".doug/.state/session-b.json"), JSON.stringify({ stopBlocks: 3 }));
    for (const session_id of ["session-a", "session-b"]) {
      const first = runHookScript("stop-gate", { hook_event_name: "Stop", session_id }, { dir });
      expect(first.json.systemMessage).toContain("standing down");
      const second = runHookScript("stop-gate", { hook_event_name: "Stop", session_id }, { dir });
      expect(second.json.systemMessage).toContain("standing down");
    }
    const lines = stoodDownLines(dir);
    expect(lines, JSON.stringify(lines)).toHaveLength(2);
    expect(lines.map((l) => l.session).sort()).toEqual(["session-a", "session-b"]);
  });

  it.each([
    ["a plain string", "wrong-shape-a-plain-string"],
    ["an array", ["wrong-shape-an-array"]],
    ["null", null],
  ])("T7 wrong-shaped marker: overwriting stoodDownLogged with %s never throws and does not permanently suppress the line", (_label, wrongShape) => {
    const dir = makeProject({ config: { ...baseConfig, commands: { test: "exit 1" } }, git: true });
    writeFileSync(join(dir, "a.ts"), "x");
    runHookScript("edit-loop", { tool_name: "Edit", tool_input: { file_path: "a.ts" } }, { dir });
    mkdirSync(join(dir, ".doug/.state"), { recursive: true });
    const beforeJson = JSON.stringify({ stopBlocks: 3 });
    writeFileSync(join(dir, ".doug/.state/test-session.json"), beforeJson);
    const r1 = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
    expect(r1.json.systemMessage).toContain("standing down");
    const afterFirst = sessionStateOf(dir);
    expect(afterFirst.stoodDownLogged).toEqual({ "block-cap:lead": true });
    afterFirst.stoodDownLogged = wrongShape;
    writeFileSync(join(dir, ".doug/.state/test-session.json"), JSON.stringify(afterFirst));
    const r2 = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
    expect(r2.status, "a hook reader must never throw").toBe(0);
    expect(r2.json && r2.json.systemMessage).toContain("standing down");
    const lines = stoodDownLines(dir);
    expect(lines.length, JSON.stringify(lines)).toBeLessThanOrEqual(2);
  });
});

// card gate-output-names-failures: the Stop-gate's captured command output today is a plain last-40-line tail
// (lib/run.mjs `tail`), so a real vitest failure buried under dozens of passing lines shows only the totals,
// with no failing test name (brief F1/F2). R1 (design) adds `failureSummary`, which leads with the vitest
// FAIL/×/→ lines and the totals ahead of the tail, within the same 40-line cap; R2 wires stop-gate.mjs's
// command-failure block to it, leaving `commandFailures` (the untruncated output the tests_red_by_design
// coverage check reads) unchanged. H1-H7 pin the design points; H7 imports `failureSummary` directly and is
// expected red until it exists.
describe("card gate-output-names-failures", () => {
  function makeEditedProject(config) {
    const dir = makeProject({ config, git: true });
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src/a.ts"), "base");
    execFileSync("git", ["add", "-A"], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", "base"], { cwd: dir });
    writeFileSync(join(dir, "src/a.ts"), "edited this session");
    runHookScript("edit-loop", { tool_name: "Edit", tool_input: { file_path: "src/a.ts" } }, { dir });
    return dir;
  }

  // A single command reading a fixture file the test writes into the project dir, so the vitest-shaped
  // output (arrows, ×, ⎯⎯⎯ separators, ANSI codes) never has to survive shell quoting.
  const vitestConfig = () => ({
    ...baseConfig,
    commands: { test: "cat vt-output.txt; exit 1" },
    stopGate: { commands: ["test"], onlyIfEdited: true, maxBlocks: 3, timeoutMs: 10000, requireEvidence: false },
  });

  const checkLines = (n) => Array.from({ length: n }, (_, i) => ` ✓ passing > case ${i + 1} 1ms`).join("\n");
  const stackFrames = (n) => Array.from({ length: n }, (_, i) => `    at Object.<anonymous> (tests/a.test.mjs:${i + 10}:1)`).join("\n");

  // vitest v2.1.9 failure shape (research Q2 / .doug/.state/scratch/vt/out.txt): two named failing tests in
  // tests/a.test.mjs, with ~60 passing checkmark lines ahead of the failure block and a realistic stack trace
  // under each error, so the first FAIL line sits well beyond the last 40 raw lines of the whole output - a
  // plain tail(output, 40) drops it (verified: the raw output here is 113 lines, and tail(*, 40) does not
  // contain the first FAIL line).
  function vitestFailureOutput({ passing = 60 } = {}) {
    return [
      checkLines(passing),
      " ❯ tests/a.test.mjs (3 tests | 2 failed) 4ms",
      "   × sample > fails one 3ms",
      "     → one is not two: expected 1 to be 2 // Object.is equality",
      "   × sample > nested > fails two 0ms",
      "     → boom",
      "",
      "⎯⎯⎯⎯⎯⎯⎯ Failed Tests 2 ⎯⎯⎯⎯⎯⎯⎯",
      "",
      " FAIL  tests/a.test.mjs > sample > fails one",
      "AssertionError: one is not two: expected 1 to be 2 // Object.is equality",
      stackFrames(15),
      "",
      "⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/2]⎯",
      "",
      " FAIL  tests/a.test.mjs > sample > nested > fails two",
      "Error: boom",
      stackFrames(15),
      "",
      "⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[2/2]⎯",
      "",
      " Test Files  1 failed (1)",
      "      Tests  2 failed | 1 passed (3)",
      "   Start at  08:34:30",
      "   Duration  242ms",
    ].join("\n");
  }

  // A single failing command's block reason is `\`<command>\` failed (exit 1):\n<captured output>`
  // (stop-gate.mjs); with only one command configured this is the only problem in the reason, so everything
  // from the marker to the end of the string is that command's captured-output section.
  const MARKER = "failed (exit 1):\n";
  function commandSection(reason) {
    const idx = reason.indexOf(MARKER);
    if (idx === -1) return null;
    return reason.slice(idx + MARKER.length);
  }

  function runFixture(content) {
    const dir = makeEditedProject(vitestConfig());
    writeFileSync(join(dir, "vt-output.txt"), content);
    return runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
  }

  it("H1 the block reason names the failing tests, ahead of any passing line", () => {
    const r = runFixture(vitestFailureOutput());
    const reason = r.json && r.json.reason;
    expect(reason, `expected stop-gate to block on the failing command; got ${JSON.stringify(r.json)}`).toBeTruthy();
    expect(reason).toContain(" FAIL  tests/a.test.mjs > sample > fails one");
    expect(reason).toContain("× sample > nested > fails two");
    expect(reason).toContain("→ boom");
    expect(reason).toContain("2 failed | 1 passed");
    const failIdx = reason.indexOf(" FAIL  tests/a.test.mjs > sample > fails one");
    const checkIdx = reason.indexOf("✓");
    if (checkIdx !== -1) {
      expect(failIdx, "the FAIL line must appear before any ✓ line in the reason").toBeLessThan(checkIdx);
    }
  });

  it("H2 the cap holds: at most 40 lines in the failing command's captured-output section", () => {
    const r = runFixture(vitestFailureOutput());
    const section = commandSection(r.json.reason);
    expect(section, `expected a "${MARKER.trim()}" marker in the reason:\n${r.json.reason}`).toBeTruthy();
    expect(section.split("\n").length).toBeLessThanOrEqual(40);
  });

  it("H3 no vitest lines: a command printing 50 plain lines then failing still gives exactly the last 40 lines (today's behaviour)", () => {
    const dir = makeEditedProject({
      ...baseConfig,
      commands: { test: `${process.execPath} -e "for(let i=1;i<=50;i++) console.log('line'+i); process.exit(1)"` },
      stopGate: { commands: ["test"], onlyIfEdited: true, maxBlocks: 3, timeoutMs: 10000, requireEvidence: false },
    });
    const r = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
    const section = commandSection(r.json.reason);
    expect(section, `expected a "${MARKER.trim()}" marker in the reason:\n${r.json.reason}`).toBeTruthy();
    const lines = section.split("\n");
    expect(lines.length).toBe(40);
    expect(lines[0]).toBe("line11");
    expect(lines[lines.length - 1]).toBe("line50");
  });

  it("H4 many failures: the reason keeps the totals and names how many more, still within the 40-line cap", () => {
    const n = 60;
    const failLines = [];
    for (let i = 1; i <= n; i++) {
      failLines.push(`   × sample > case ${i} 1ms`);
      failLines.push(`     → boom ${i}`);
    }
    const failBlocks = [];
    for (let i = 1; i <= n; i++) {
      failBlocks.push(` FAIL  tests/many.test.mjs > sample > case ${i}`, `Error: boom ${i}`, "");
    }
    const content = [
      checkLines(20),
      ` ❯ tests/many.test.mjs (${n} tests | ${n} failed) 4ms`,
      ...failLines,
      "",
      `⎯⎯⎯⎯⎯⎯⎯ Failed Tests ${n} ⎯⎯⎯⎯⎯⎯⎯`,
      "",
      ...failBlocks,
      " Test Files  1 failed (1)",
      `      Tests  ${n} failed (${n})`,
      "   Start at  08:34:30",
      "   Duration  242ms",
    ].join("\n");
    const r = runFixture(content);
    const section = commandSection(r.json.reason);
    expect(section, `expected a "${MARKER.trim()}" marker in the reason:\n${r.json.reason}`).toBeTruthy();
    const lines = section.split("\n");
    expect(lines.length, `must still fit the 40-line cap:\n${section}`).toBeLessThanOrEqual(40);
    expect(section).toContain("more failing tests not shown");
    expect(section).toContain("60 failed");
    // The very first failure-naming line in output order must survive truncation; the last must not - proof
    // that some, not all, of the 60 failures are shown.
    expect(section).toContain("× sample > case 1 ");
    expect(section).not.toContain("case 60");
  });

  it("H5 ANSI escape codes wrapping a kept FAIL line are stripped", () => {
    const content = [
      checkLines(60),
      " ❯ tests/a.test.mjs (1 tests | 1 failed) 1ms",
      "   × sample > fails one 1ms",
      "     → boom",
      "",
      "⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯",
      "",
      "\x1b[31m FAIL  tests/a.test.mjs > sample > fails one\x1b[39m",
      "Error: boom",
      stackFrames(15),
      "",
      " Test Files  1 failed (1)",
      "      Tests  1 failed (1)",
    ].join("\n");
    const r = runFixture(content);
    const reason = r.json.reason;
    expect(reason).toContain(" FAIL  tests/a.test.mjs > sample > fails one");
    expect(reason).not.toContain("\x1b");
  });

  it("H6 the tests_red_by_design coverage check still sees the whole output, beyond line 40 of the raw output", () => {
    const claim = (files) => JSON.stringify({ tests_red_by_design: files });
    const dir = makeProject({
      config: {
        ...baseConfig,
        commands: {
          test: `${process.execPath} -e "for(let i=1;i<=50;i++) console.log('noise'+i); console.log(' FAIL  tests/a.test.mjs > it'); process.exit(1)"`,
        },
      },
      git: true,
    });
    mkdirSync(join(dir, "tests"));
    writeFileSync(join(dir, "tests/a.test.mjs"), "it fails on purpose");
    runHookScript("edit-loop", { tool_name: "Write", tool_input: { file_path: "tests/a.test.mjs" }, agent_id: "ag1", agent_type: "tester" }, { dir });
    const input = {
      hook_event_name: "SubagentStop",
      agent_id: "ag1",
      agent_type: "tester",
      last_assistant_message: `Ran the new test; it fails as designed.\n${claim(["tests/a.test.mjs"])}`,
    };
    const r = runHookScript("stop-gate", input, { dir });
    expect(
      r.json && r.json.decision,
      `expected the tests_red_by_design claim to be honoured even though the FAIL line sits beyond line 40 of the raw command output; got ${JSON.stringify(r.json)}`,
    ).toBeUndefined();
  });

  // (coordinator, round 2) H6 alone does not pin R2's own precondition: with only one failing file, that
  // file's one FAIL line always fits in failureSummary's 40-line cap regardless of what `commandFailures`
  // is given, so a mutation that wires `commandFailures` to the *summary* instead of the raw output (M7)
  // survives H6 undetected. H6b forces the overflow path failureSummary itself uses (same shape as H4):
  // 45 failing tests each write a `×`/`→` pair in the leading per-file summary section, well before the
  // later "Failed Tests" section's ` FAIL  <file> > ...` lines - real vitest's own ordering (F2). 45 × 2 =
  // 90 head-candidate lines alone already exceeds failureSummary's overflow budget (maxLines - 3 = 37 at
  // the default cap), so ALL 37 kept head lines come from the × section and not one of the 45 real FAIL
  // lines survives into the 40-line summary - and neither a `×` nor a `→` line contains the substring
  // "FAIL" or "failed" that failingTestFilesFrom (lib/block-ledger.mjs) requires, so a coverage check
  // reading the summary instead of the raw text finds zero test files named at all ("noFile"), not just a
  // missing one, and blocks with "named no test file in its output" - even though every one of the 45
  // claimed files really is red and really is modified in the working tree. Reading the untruncated raw
  // output (R2, the fix) finds all 45 and honours the claim.
  it("H6b (M7) the coverage check must read the raw output, not the 40-line display summary: an overflow of many failing files still honours the claim", () => {
    const claim = (files) => JSON.stringify({ tests_red_by_design: files });
    const n = 45;
    const files = Array.from({ length: n }, (_, i) => `tests/f${String(i + 1).padStart(2, "0")}.test.mjs`);
    const xLines = [];
    for (let i = 1; i <= n; i++) xLines.push(`   × sample > case ${i} 1ms`, `     → boom ${i}`);
    const failLines = [];
    for (let i = 1; i <= n; i++) failLines.push(` FAIL  ${files[i - 1]} > sample > case ${i}`, `Error: boom ${i}`, "");
    const content = [
      ` ❯ tests (${n} tests | ${n} failed) 4ms`,
      ...xLines,
      "",
      `⎯⎯⎯⎯⎯⎯⎯ Failed Tests ${n} ⎯⎯⎯⎯⎯⎯⎯`,
      "",
      ...failLines,
      " Test Files  1 failed (1)",
      `      Tests  ${n} failed (${n})`,
      "   Start at  08:34:30",
      "   Duration  242ms",
    ].join("\n");

    const dir = makeProject({ config: vitestConfig(), git: true });
    mkdirSync(join(dir, "tests"));
    for (const f of files) writeFileSync(join(dir, f), "it fails on purpose");
    writeFileSync(join(dir, "vt-output.txt"), content);
    const input = {
      hook_event_name: "SubagentStop",
      agent_id: "ag1",
      agent_type: "tester",
      last_assistant_message: `Ran the new tests; they all fail as designed.\n${claim(files)}`,
    };
    const r = runHookScript("stop-gate", input, { dir });
    expect(
      r.json && r.json.decision,
      `expected the tests_red_by_design claim (45 files) to be honoured; the coverage check must read the raw command output, not the 40-line display summary, or the whole per-file failure evidence is lost to overflow. got ${JSON.stringify(r.json)}`,
    ).toBeUndefined();
  });

  it("H7 failureSummary: garbage input never throws and always returns a string", async () => {
    // Imported dynamically (not at module scope) so this file's other, unrelated tests keep running even
    // while lib/run.mjs has no `failureSummary` export yet - this test alone fails, at the missing-function
    // call below, which is the expected red.
    const mod = await import("../lib/run.mjs");
    for (const input of [null, undefined, 42, {}, [], "plain string"]) {
      let result;
      expect(() => {
        result = mod.failureSummary(input);
      }, `failureSummary must never throw on ${JSON.stringify(input)}`).not.toThrow();
      expect(typeof result).toBe("string");
    }
  });

  // Review round 1 (coordinator): a blocker (G4, git-hooks.test.mjs) and a major (H10) plus three unpinned
  // mechanisms (H8, H9, H11) in failureSummary's own tail-filler and totals handling, against
  // plugins/doug-gates/lib/run.mjs's real implementation as landed.

  it("H8 tail filler: a short single-failure output still fills the remaining budget from the tail (error message, code frame)", () => {
    // H1's own two-failure, 60-line-padded fixture never reaches the filler branch at all (padding pushes
    // the head+totals size up, and remaining stays small); this fixture is deliberately short - one
    // failure, no padding - so headLines + totalsLines is well under maxLines and `remaining` is large.
    const content = [
      " ❯ tests/a.test.mjs (2 tests | 1 failed) 4ms",
      "   × sample > fails one 3ms",
      "     → one is not two: expected 1 to be 2 // Object.is equality",
      "",
      "⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯",
      "",
      " FAIL  tests/a.test.mjs > sample > fails one",
      "AssertionError: one is not two: expected 1 to be 2 // Object.is equality",
      "",
      " ❯ tests/a.test.mjs:4:55",
      "      2| describe(\"sample\", () => {",
      "      3|   it(\"passes\", () => { expect(1).toBe(1); });",
      "      4|   it(\"fails one\", () => { expect(1, \"one is not two\").toBe(2); });",
      "       |                                                       ^",
      "      5| });",
      "",
      " Test Files  1 failed (1)",
      "      Tests  1 failed | 1 passed (2)",
      "   Start at  08:34:30",
      "   Duration  242ms",
    ].join("\n");
    const r = runFixture(content);
    const reason = r.json.reason;
    expect(reason, `expected the tail filler (error message) in:\n${reason}`).toContain("AssertionError: one is not two");
    expect(reason, `expected the tail filler (code-frame line) in:\n${reason}`).toContain('it("fails one"');
  });

  it("H9 totals appear exactly once: the tail filler never re-adds an already-kept totals line", () => {
    const r = runFixture(vitestFailureOutput());
    const reason = r.json.reason;
    const occurrences = reason.split("Tests  2 failed | 1 passed").length - 1;
    expect(occurrences, `expected the totals line to appear exactly once in:\n${reason}`).toBe(1);
  });

  it("H10 (reviewer MAJOR) totals flood: a pnpm -r --stream shape with many per-package totals-looking lines does not crowd out the real failure, and the totals are capped to the last pair", () => {
    const repeatedTotals = [];
    for (let i = 0; i < 20; i++) repeatedTotals.push(" Test Files  1 failed (1)", "      Tests  1 failed (1)");
    const content = [
      ...repeatedTotals,
      "   × sample > fails one 1ms",
      "     → boom",
      "",
      "⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯",
      "",
      " FAIL  packages/p7/tests/x.test.ts > t",
      "Error: boom",
      "",
      " Test Files  1 failed (1)",
      "      Tests  1 failed (1)",
      "   Start at  08:34:30",
      "   Duration  242ms",
    ].join("\n");
    const r = runFixture(content);
    const section = commandSection(r.json.reason);
    expect(section, `expected a "${MARKER.trim()}" marker in the reason:\n${r.json.reason}`).toBeTruthy();
    expect(section).toContain(" FAIL  packages/p7/tests/x.test.ts > t");
    expect(section).toContain("× sample > fails one");
    const lines = section.split("\n");
    expect(lines.length, `must still fit the 40-line cap:\n${section}`).toBeLessThanOrEqual(40);
    const totalsOccurrences = lines.filter((l) => /^\s*(Test Files|Tests)\s/.test(l)).length;
    expect(
      totalsOccurrences,
      `the totals must be capped to the last pair, not flooded by every package's own summary:\n${section}`,
    ).toBeLessThanOrEqual(2);
  });

  it("H11 overflow count: the dropped-test count is (total - kept), not inflated by also counting each dropped ×'s own → message line", () => {
    // A pure-×/→ fixture (no separate "Failed Tests"/FAIL section): the only way to build a case where the
    // dropped portion actually contains → lines (so a regex that wrongly also matches "→" would over-count)
    // is to overflow entirely within the × section itself, exactly like the real implementation's overflow
    // does whenever the × section alone already exceeds the head budget (same fact H4/H6b rely on).
    const n = 60;
    const lines = [];
    for (let i = 1; i <= n; i++) lines.push(`   × sample > case ${i} 1ms`, `     → boom ${i}`);
    lines.push(" Test Files  1 failed (1)", `      Tests  ${n} failed (${n})`, "   Start at  08:34:30", "   Duration  242ms");
    const r = runFixture(lines.join("\n"));
    const section = commandSection(r.json.reason);
    expect(section, `expected a "${MARKER.trim()}" marker in the reason:\n${r.json.reason}`).toBeTruthy();
    const keptX = (section.match(/^\s*×\s/gm) || []).length;
    const overflowMatch = section.match(/…\s*(\d+)\s*more failing tests not shown/);
    expect(overflowMatch, `expected an overflow line in:\n${section}`).toBeTruthy();
    const overflowCount = Number(overflowMatch[1]);
    expect(
      overflowCount,
      `overflow count must be ${n} - ${keptX} kept = ${n - keptX}, not inflated by counting → lines too:\n${section}`,
    ).toBe(n - keptX);
  });
});

// card stop-gate-credits-pre-commit: the pre-commit hook (.githooks/pre-commit, tested in
// git-hooks.test.mjs) writes a machine-readable record of its own run to
// .doug/.state/pre-commit/last-run.json (lead's design: { version: 1, tree, ok, at, commands: [{ name,
// command, exit, durationMs }] }). The Stop gate credits a passing record instead of re-running the same
// commands when the working tree has no changes beyond HEAD, the record parses, is version 1, ok, matches
// HEAD's tree, every command exited 0, and its command list equals resolveCommands(cfg) in order — crediting
// pushes `{ name, command, ok: true, credited: "pre-commit" }` into results and runs no command, but every
// other check (evidence, red-by-design, state.verified, the block ledger) still runs exactly as today. S7
// (the vendored copy staying byte-identical) is already covered generically by
// plugins/doug-gates/tests/vendored-copies.test.mjs; not duplicated here.
describe("stop-gate credits a passing pre-commit record (card stop-gate-credits-pre-commit)", () => {
  // A cheap, observable command: it writes ran.marker so a test can tell whether it actually ran, the same
  // convention the session-start-baseline tests above use.
  const preCommitConfig = () => ({
    ...baseConfig,
    commands: { test: `${process.execPath} -e "require('fs').writeFileSync('ran.marker','1')"` },
  });
  const commitAll = (dir, message) => {
    execFileSync("git", ["add", "-A"], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", message], { cwd: dir });
  };
  const headTree = (dir) => execFileSync("git", ["rev-parse", "HEAD^{tree}"], { cwd: dir, encoding: "utf8" }).trim();
  const writeRecord = (dir, record) => {
    mkdirSync(join(dir, ".doug/.state/pre-commit"), { recursive: true });
    writeFileSync(join(dir, ".doug/.state/pre-commit/last-run.json"), JSON.stringify(record));
  };
  // A record matching HEAD exactly, for the given cfg's resolved commands (here always the single "test"
  // command preCommitConfig defines).
  const passingRecord = (dir, cfg) => ({
    version: 1,
    tree: headTree(dir),
    ok: true,
    at: new Date().toISOString(),
    commands: [{ name: "test", command: cfg.commands.test, exit: 0, durationMs: 5 }],
  });
  const markerRan = (dir) => existsSync(join(dir, "ran.marker"));
  // Marks this session as having made an edit (state.editedFiles), so `onlyIfEdited`'s "nothing changed"
  // early exit never fires before the credit check is reached — the tree can still be clean (as it is right
  // after a commit) while the session did make changes this turn.
  const markEdited = (dir) => runHookScript("edit-loop", { tool_name: "Edit", tool_input: { file_path: "a.ts" } }, { dir });

  it("S1: a clean tree whose HEAD tree matches a passing pre-commit record skips the commands, allows, and sets state.verified", () => {
    const cfg = preCommitConfig();
    const dir = makeProject({ config: cfg, git: true });
    commitAll(dir, "init");
    markEdited(dir);
    writeRecord(dir, passingRecord(dir, cfg));

    const r = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
    expect(r.json, JSON.stringify(r.json)).toBeNull(); // allowed
    expect(markerRan(dir), "the credited command must not run").toBe(false);
    const state = JSON.parse(readFileSync(join(dir, ".doug/.state/test-session.json"), "utf8"));
    expect(state.lastGate.ok).toBe(true);
    expect(state.lastGate.results[0]).toMatchObject({ name: "test", ok: true, credited: "pre-commit" });
    expect(state.verified, "state.verified must be set on a credited green gate").toBeTruthy();
  });

  it("S1 (evidence still applies): a credited run still blocks a session with changes and no test command of its own on record", () => {
    const cfg = preCommitConfig();
    const cfgEvidence = { ...cfg, stopGate: { ...cfg.stopGate, requireEvidence: true } };
    const dir = makeProject({ config: cfgEvidence, git: true });
    commitAll(dir, "init");
    markEdited(dir);
    writeRecord(dir, passingRecord(dir, cfgEvidence));

    const r = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
    expect(r.json.decision).toBe("block");
    expect(r.json.reason).toContain("No test or verify command ran in this session");
    expect(markerRan(dir), "credited commands still must not run just because evidence is missing").toBe(false);
  });

  it("S2: a dirty tree after the commit still runs the commands", () => {
    const cfg = preCommitConfig();
    const dir = makeProject({ config: cfg, git: true });
    commitAll(dir, "init");
    writeRecord(dir, passingRecord(dir, cfg));
    writeFileSync(join(dir, "dirty.txt"), "uncommitted");

    runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
    expect(markerRan(dir), "a dirty tree must not be credited").toBe(true);
  });

  it("S3: a record with ok: false (a non-zero exit) still runs the commands", () => {
    const cfg = preCommitConfig();
    const dir = makeProject({ config: cfg, git: true });
    commitAll(dir, "init");
    const record = passingRecord(dir, cfg);
    record.ok = false;
    record.commands[0].exit = 1;
    writeRecord(dir, record);
    markEdited(dir);

    runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
    expect(markerRan(dir), "a failing pre-commit record must not be credited").toBe(true);
  });

  // Round 2 reviewer finding: S3 above flips `ok` and a command's `exit` together, so the credit check
  // could read the exit codes alone (dropping `if (record.ok !== true) return null;`) and still pass S3
  // (every command's exit is 0 elsewhere, but the flipped one's exit is 1, so the exit check alone already
  // catches it). This is the shape the hook now actually writes for a dirty working tree (a working-tree/
  // index mismatch, or an untracked file): ok:false with every command still exited 0 (the commands
  // themselves passed; the tree just isn't what was recorded). The `ok` field must be checked in its own
  // right, not inferred from the commands' exit codes.
  it("S3b: a record with ok:false but every command exited 0 (the dirty-tree shape) still runs the commands", () => {
    const cfg = preCommitConfig();
    const dir = makeProject({ config: cfg, git: true });
    commitAll(dir, "init");
    const record = passingRecord(dir, cfg); // every command exit: 0
    record.ok = false; // e.g. "working tree differs from the committed index"
    writeRecord(dir, record);
    markEdited(dir);

    runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
    expect(markerRan(dir), "an ok:false record must not be credited even when every command exited 0").toBe(true);
  });

  it("S4: a record whose command list differs from the configured commands still runs the commands", () => {
    const cfg = preCommitConfig();
    const dir = makeProject({ config: cfg, git: true });
    commitAll(dir, "init");
    const record = passingRecord(dir, cfg);
    record.commands = [{ name: "other", command: "echo hi", exit: 0, durationMs: 5 }];
    writeRecord(dir, record);
    markEdited(dir);

    runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
    expect(markerRan(dir), "a mismatched command list must not be credited").toBe(true);
  });

  it("S5a: a record that is not JSON still runs the commands, without crashing the hook", () => {
    const cfg = preCommitConfig();
    const dir = makeProject({ config: cfg, git: true });
    commitAll(dir, "init");
    mkdirSync(join(dir, ".doug/.state/pre-commit"), { recursive: true });
    writeFileSync(join(dir, ".doug/.state/pre-commit/last-run.json"), "not json{{{");
    markEdited(dir);

    const r = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
    expect(r.status).toBe(0); // the reader never throws (a hook reader must never throw)
    expect(markerRan(dir), "a corrupt (non-JSON) record must not be credited").toBe(true);
  });

  it("S5b: a record of the wrong shape (commands not an array, tree a number) still runs the commands, without crashing the hook", () => {
    const cfg = preCommitConfig();
    const dir = makeProject({ config: cfg, git: true });
    commitAll(dir, "init");
    writeRecord(dir, { version: 1, tree: 12345, ok: true, at: new Date().toISOString(), commands: "nope" });
    markEdited(dir);

    const r = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
    expect(r.status).toBe(0);
    expect(markerRan(dir), "a malformed-shape record must not be credited").toBe(true);
  });

  it("S6: a record for a different (stale) tree still runs the commands", () => {
    const cfg = preCommitConfig();
    const dir = makeProject({ config: cfg, git: true });
    commitAll(dir, "init");
    const record = passingRecord(dir, cfg);
    record.tree = "0".repeat(40);
    writeRecord(dir, record);
    markEdited(dir);

    runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
    expect(markerRan(dir), "a stale-tree record must not be credited").toBe(true);
  });
});

// card ratchet-pre-commit-credit: a credited pre-commit record runs no command, so the count check must run
// on the totals the hook recorded per command (record entry `totals`: the parseTotals result object) against
// state.testTotals, through the same code path, block text, waiver rule and conflict rule as a real run.
// A baselined command whose entry has no readable totals is not credited (fail closed to running).
describe("stop-gate count check on a credited pre-commit record (card ratchet-pre-commit-credit)", () => {
  const LAST_GREEN = ".doug/.state/test-totals.json";
  const WAIVERS = ".doug/.state/test-count-waivers";
  const T = { total: 137, skipped: 0, todo: 0 };
  const CMD = `${process.execPath} -e "require('fs').writeFileSync('ran.marker','1')"`;
  const okTotals = (t) => ({ status: "ok", totals: t });

  // Clean committed tree, edited session, state.testTotals seeded for CMD (unless baseline === null), and a
  // record matching HEAD whose single entry carries `entry` fields (e.g. totals).
  // `waiverCommitMsg`: state.baselineHead is pinned to the init commit and a further empty commit with that
  // message lands after it, so the message is a commit "since the session's baseline".
  function makeCredit({ baseline = T, entry = {}, waiverFile, lastGreen, waiverCommitMsg } = {}) {
    const cfg = { ...baseConfig, commands: { test: CMD } };
    const dir = makeProject({ config: cfg, git: true });
    execFileSync("git", ["add", "-A"], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
    const baseHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
    if (waiverCommitMsg) execFileSync("git", ["commit", "-q", "--allow-empty", "-m", waiverCommitMsg], { cwd: dir });
    runHookScript("edit-loop", { tool_name: "Edit", tool_input: { file_path: "a.ts" } }, { dir });
    {
      const state = loadState(dir, "test-session");
      if (baseline !== null) state.testTotals = { [CMD]: baseline };
      if (waiverCommitMsg) state.baselineHead = baseHead;
      saveState(dir, "test-session", state);
    }
    mkdirSync(join(dir, ".doug/.state/pre-commit"), { recursive: true });
    const tree = execFileSync("git", ["rev-parse", "HEAD^{tree}"], { cwd: dir, encoding: "utf8" }).trim();
    writeFileSync(
      join(dir, ".doug/.state/pre-commit/last-run.json"),
      JSON.stringify({ version: 1, tree, ok: true, at: new Date().toISOString(), commands: [{ name: "test", command: CMD, exit: 0, durationMs: 5, ...entry }] }),
    );
    if (waiverFile !== undefined) writeFileSync(join(dir, WAIVERS), waiverFile);
    if (lastGreen !== undefined) writeFileSync(join(dir, LAST_GREEN), JSON.stringify(lastGreen));
    return dir;
  }
  const stopGate = (dir) => runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
  const ranMarker = (dir) => existsSync(join(dir, "ran.marker"));
  const state = (dir) => JSON.parse(readFileSync(join(dir, ".doug/.state/test-session.json"), "utf8"));

  it("C1: a credited run whose recorded total dropped blocks with the regression text; no verified tree, last-green unchanged; command not run", () => {
    const record = { [CMD]: T };
    const dir = makeCredit({ entry: { totals: okTotals({ total: 131, skipped: 0, todo: 0 }) }, lastGreen: record });
    const r = stopGate(dir);
    expect(r.json && r.json.decision, JSON.stringify(r.json)).toBe("block");
    expect(r.json.reason).toContain("test count regressed");
    expect(r.json.reason).toContain("total dropped from");
    expect(ranMarker(dir), "the credited command must not run").toBe(false);
    expect(state(dir).verified ?? null).toBeNull();
    expect(JSON.parse(readFileSync(join(dir, LAST_GREEN), "utf8"))).toEqual(record);
  });

  it("C2: a credited run whose recorded skipped rose blocks with \"skipped rose from\"; command not run", () => {
    const dir = makeCredit({ baseline: { total: 137, skipped: 2, todo: 0 }, entry: { totals: okTotals({ total: 137, skipped: 5, todo: 0 }) } });
    const r = stopGate(dir);
    expect(r.json && r.json.decision, JSON.stringify(r.json)).toBe("block");
    expect(r.json.reason).toContain("skipped rose from");
    expect(ranMarker(dir)).toBe(false);
  });

  it("C3: a covering waiver passes a count-red credit; still credited, command not run", () => {
    const dir = makeCredit({
      entry: { totals: okTotals({ total: 131, skipped: 0, todo: 0 }) },
      waiverFile: "test-count-waiver: total=-6 skipped=0 todo=0; removed the obsolete suite\n",
    });
    const r = stopGate(dir);
    expect(r.json, JSON.stringify(r.json)).toBeNull();
    expect(ranMarker(dir), "the credited command must not run").toBe(false);
    expect(state(dir).lastGate.results[0]).toMatchObject({ ok: true, credited: "pre-commit" });
  });

  it("R2: a count-red credit covered by a waiver line in a commit message since the session's baseline passes; credited, command not run", () => {
    const dir = makeCredit({
      entry: { totals: okTotals({ total: 131, skipped: 0, todo: 0 }) },
      waiverCommitMsg: "prune tests\n\ntest-count-waiver: total=-6 skipped=0 todo=0; removed the obsolete suite\n",
    });
    const r = stopGate(dir);
    expect(r.json, JSON.stringify(r.json)).toBeNull();
    expect(ranMarker(dir), "the credited command must not run").toBe(false);
    expect(state(dir).lastGate.results[0]).toMatchObject({ ok: true, credited: "pre-commit" });
  });

  it("R2b (fixture check): the same drop with a non-covering commit-message waiver blocks", () => {
    const dir = makeCredit({
      entry: { totals: okTotals({ total: 131, skipped: 0, todo: 0 }) },
      waiverCommitMsg: "test-count-waiver: total=-5 skipped=0 todo=0; wrong number",
    });
    const r = stopGate(dir);
    expect(r.json && r.json.decision, JSON.stringify(r.json)).toBe("block");
    expect(r.json.reason).toContain("total dropped from");
  });

  it("C4: a record entry with no totals, for a command with a baseline, is not credited: the command runs", () => {
    const dir = makeCredit({ entry: {} });
    stopGate(dir);
    expect(ranMarker(dir), "a baselined command without recorded totals must run, not be credited").toBe(true);
  });

  it("C4b: a recorded {status:\"none\"} for a baselined command is not credited either", () => {
    const dir = makeCredit({ entry: { totals: { status: "none" } } });
    stopGate(dir);
    expect(ranMarker(dir)).toBe(true);
  });

  for (const [label, totals] of [
    ["a string", "junk"],
    ["ok with non-numeric totals", { status: "ok", totals: { total: "many" } }],
  ]) {
    it(`C5: garbage recorded totals (${label}) for a baselined command: not credited, command runs, no throw, no fail-open message`, () => {
      const dir = makeCredit({ entry: { totals } });
      const r = stopGate(dir);
      expect(r.status).toBe(0);
      expect(ranMarker(dir), "garbage totals must not be credited").toBe(true);
      expect(JSON.stringify(r.json) ?? "").not.toMatch(/fail.?open|hook error/i);
    });
  }

  it("C6: a recorded conflict blocks with \"printed conflicting test summaries\"; command not run", () => {
    const dir = makeCredit({
      entry: { totals: { status: "conflict", summaries: [{ total: 1, skipped: 0, todo: 0 }, { total: 137, skipped: 0, todo: 0 }] } },
    });
    const r = stopGate(dir);
    expect(r.json && r.json.decision, JSON.stringify(r.json)).toBe("block");
    expect(r.json.reason).toContain("printed conflicting test summaries");
    expect(ranMarker(dir)).toBe(false);
    expect(state(dir).verified ?? null).toBeNull();
  });

  it("C7: a green credit with ok totals equal to the baseline passes, runs nothing, and writes the recorded totals to last-green", () => {
    const dir = makeCredit({ entry: { totals: okTotals(T) } });
    expect(existsSync(join(dir, LAST_GREEN))).toBe(false);
    const r = stopGate(dir);
    expect(r.json, JSON.stringify(r.json)).toBeNull();
    expect(ranMarker(dir)).toBe(false);
    expect(state(dir).lastGate.results[0]).toMatchObject({ ok: true, credited: "pre-commit" });
    expect(JSON.parse(readFileSync(join(dir, LAST_GREEN), "utf8"))[CMD]).toMatchObject(T);
  });

  it("C8: a command with no baseline and no recorded totals still credits as today", () => {
    const dir = makeCredit({ baseline: null, entry: {} });
    const r = stopGate(dir);
    expect(r.json, JSON.stringify(r.json)).toBeNull();
    expect(ranMarker(dir), "no baseline: credited, not run").toBe(false);
    expect(state(dir).lastGate.results[0]).toMatchObject({ ok: true, credited: "pre-commit" });
  });
});

describe("card test-count-ratchet (end to end)", () => {
  const CMD = "cat summary.txt";
  const LAST_GREEN = ".doug/.state/test-totals.json";
  const WAIVERS = ".doug/.state/test-count-waivers";
  const T = { total: 137, skipped: 0, todo: 0 }; // the session's baseline unless a case says otherwise

  // The vitest summary block, colour off, for the given counts (total includes skipped and todo).
  const summary = ({ total, skipped = 0, todo = 0 }) => {
    const segs = [];
    if (total - skipped - todo > 0) segs.push(`${total - skipped - todo} passed`);
    if (skipped) segs.push(`${skipped} skipped`);
    if (todo) segs.push(`${todo} todo`);
    return ` Test Files  1 passed (1)\n      Tests  ${segs.join(" | ")} (${total})\n   Start at  08:34:30\n   Duration  242ms\n`;
  };
  const waiver = (t, s, d, reason = "removed the obsolete suite") => `test-count-waiver: total=${t} skipped=${s} todo=${d}; ${reason}`;

  // A real session, through the real hook scripts: last-green record (optional) -> SessionStart -> edits ->
  // optional commit carrying a waiver line -> the command's output on disk. Returns the project dir.
  function makeCountProject({ lastGreen, output, commitMsg, preBaselineCommitMsg, waiverFile, waiverFileAsDir, command = CMD } = {}) {
    const cfg = { ...baseConfig, commands: { test: command } };
    const dir = makeProject({ config: cfg, git: true });
    writeFileSync(join(dir, ".gitignore"), ".doug/.state/\n");
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src/a.ts"), "base");
    writeFileSync(join(dir, "src/b.ts"), "base");
    execFileSync("git", ["add", "-A"], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", "base"], { cwd: dir });
    if (preBaselineCommitMsg) execFileSync("git", ["commit", "-q", "--allow-empty", "-m", preBaselineCommitMsg], { cwd: dir });
    mkdirSync(join(dir, ".doug/.state"), { recursive: true });
    if (lastGreen !== undefined) writeFileSync(join(dir, LAST_GREEN), typeof lastGreen === "string" ? lastGreen : JSON.stringify(lastGreen));
    runHookScript("session-start-baseline", { hook_event_name: "SessionStart", source: "startup" }, { dir });
    if (waiverFileAsDir) mkdirSync(join(dir, WAIVERS));
    else if (waiverFile !== undefined) writeFileSync(join(dir, WAIVERS), waiverFile);
    writeFileSync(join(dir, "src/a.ts"), "edited this session");
    runHookScript("edit-loop", { tool_name: "Edit", tool_input: { file_path: "src/a.ts" } }, { dir });
    if (commitMsg) {
      execFileSync("git", ["add", "src/a.ts"], { cwd: dir });
      execFileSync("git", ["commit", "-q", "-m", commitMsg], { cwd: dir });
      writeFileSync(join(dir, "src/b.ts"), "edited after the commit"); // keep a dirty change so the gate still has work
      runHookScript("edit-loop", { tool_name: "Edit", tool_input: { file_path: "src/b.ts" } }, { dir });
    }
    if (output !== undefined) writeFileSync(join(dir, "summary.txt"), output);
    return dir;
  }
  const stop = (dir) => runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
  const readJson = (dir, rel) => JSON.parse(readFileSync(join(dir, rel), "utf8"));
  const sessionState = (dir) => readJson(dir, ".doug/.state/test-session.json");
  const traceReasons = (dir) => {
    const file = join(dir, ".doug/.state/trace/test-session.jsonl");
    if (!existsSync(file)) return [];
    return readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).map((l) => l.reason).filter((x) => typeof x === "string");
  };
  const green = (r) => {
    expect(r.json, "expected an allow with no message").toBeNull();
  };
  const blocked = (r) => {
    expect(r.json && r.json.decision).toBe("block");
    return r.json.reason;
  };

  describe("SessionStart copies the last-green record (D1)", () => {
    it("copies the last-green record into state.testTotals in the same write as the baseline", () => {
      const record = { [CMD]: { total: 137, skipped: 4, todo: 2 } };
      const dir = makeCountProject({ lastGreen: record });
      const state = sessionState(dir);
      expect(state.testTotals).toEqual(record);
      expect(state.baselineSource).toBe("session-start");
    });
    it("leaves state.testTotals null when there is no record, and does not fail", () => {
      const dir = makeCountProject({});
      const state = sessionState(dir);
      expect(state).toHaveProperty("testTotals", null);
      expect(state.baseline).not.toBeNull();
    });
    it("never overwrites a non-null state.testTotals", () => {
      const dir = makeProject({ config: baseConfig, git: true });
      mkdirSync(join(dir, ".doug/.state"), { recursive: true });
      runHookScript("edit-loop", { tool_name: "Edit", tool_input: { file_path: "src/a.ts" } }, { dir }); // creates the state file, baseline still null
      const state = loadState(dir, "test-session");
      state.testTotals = { [CMD]: { total: 50, skipped: 1, todo: 1 } };
      saveState(dir, "test-session", state);
      writeFileSync(join(dir, LAST_GREEN), JSON.stringify({ [CMD]: { total: 999, skipped: 0, todo: 0 } }));
      const r = runHookScript("session-start-baseline", { hook_event_name: "SessionStart", source: "startup" }, { dir });
      expect(r.status).toBe(0);
      const after = sessionState(dir);
      expect(after.baseline).not.toBeNull(); // this fire did capture the baseline...
      expect(after.testTotals).toEqual({ [CMD]: { total: 50, skipped: 1, todo: 1 } }); // ...and left the existing totals alone
    });
    it("a garbage last-green file leaves state.testTotals null, exits 0, prints no fail-open message", () => {
      const dir = makeProject({ config: baseConfig, git: true });
      mkdirSync(join(dir, ".doug/.state"), { recursive: true });
      writeFileSync(join(dir, LAST_GREEN), "{{{ not json \u0000\u0001");
      const r = runHookScript("session-start-baseline", { hook_event_name: "SessionStart", source: "startup" }, { dir });
      expect(r.status).toBe(0);
      expect(r.json).toBeNull();
      expect(sessionState(dir).testTotals).toBeNull();
    });
    it("a last-green path that is a directory leaves state.testTotals null and does not fail", () => {
      const dir = makeProject({ config: baseConfig, git: true });
      mkdirSync(join(dir, LAST_GREEN), { recursive: true });
      const r = runHookScript("session-start-baseline", { hook_event_name: "SessionStart", source: "startup" }, { dir });
      expect(r.status).toBe(0);
      expect(r.json).toBeNull();
      expect(sessionState(dir).testTotals).toBeNull();
    });
  });

  describe("the block (D6)", () => {
    it("a dropped test blocks and the reason names both numbers", () => {
      const dir = makeCountProject({ lastGreen: { [CMD]: T }, output: summary({ total: 131 }) }); // skipped and todo unchanged at 0
      const reason = blocked(stop(dir));
      expect(reason).toContain("137");
      expect(reason).toContain("131");
      expect(reason).not.toContain("failed (exit"); // a count problem is not a failed command (D9)
    });
    it("an added it.skip blocks (skipped rose, total unchanged) and the reason names both numbers", () => {
      const dir = makeCountProject({ lastGreen: { [CMD]: { total: 137, skipped: 11, todo: 0 } }, output: summary({ total: 137, skipped: 19 }) });
      const reason = blocked(stop(dir));
      expect(reason).toContain("11");
      expect(reason).toContain("19");
    });
    it("a todo that rose blocks (total and skipped unchanged) and the reason names both numbers", () => {
      const dir = makeCountProject({ lastGreen: { [CMD]: { total: 137, skipped: 0, todo: 21 } }, output: summary({ total: 137, todo: 29 }) });
      const reason = blocked(stop(dir));
      expect(reason).toContain("21");
      expect(reason).toContain("29");
    });
    it("a rise in total with skipped and todo falling passes", () => {
      const dir = makeCountProject({ lastGreen: { [CMD]: { total: 137, skipped: 19, todo: 21 } }, output: summary({ total: 140, skipped: 11, todo: 12 }) });
      green(stop(dir));
    });
    it("unchanged totals pass", () => {
      const dir = makeCountProject({ lastGreen: { [CMD]: { total: 137, skipped: 4, todo: 2 } }, output: summary({ total: 137, skipped: 4, todo: 2 }) });
      green(stop(dir));
    });
    it("a blocked count records no verified tree and leaves the last-green record as it was (D9)", () => {
      const record = { [CMD]: T };
      const dir = makeCountProject({ lastGreen: record, output: summary({ total: 131 }) });
      blocked(stop(dir));
      expect(sessionState(dir).verified ?? null).toBeNull();
      expect(readJson(dir, LAST_GREEN)).toEqual(record);
    });
    it("compares only the same command's baseline: a command with no entry gets no check, logged (D2)", () => {
      const dir = makeCountProject({ lastGreen: { "some other command": T }, output: summary({ total: 5 }) });
      green(stop(dir));
      expect(traceReasons(dir).some((x) => /count check/i.test(x) && /baseline/i.test(x))).toBe(true);
    });
    it("a session cannot lower its own bar: the gate compares against state, not the last-green file", () => {
      const dir = makeCountProject({ lastGreen: { [CMD]: T }, output: summary({ total: 131 }) });
      // Another session goes green at 131 after this one started and rewrites the shared record.
      writeFileSync(join(dir, LAST_GREEN), JSON.stringify({ [CMD]: { total: 131, skipped: 0, todo: 0 } }));
      const reason = blocked(stop(dir));
      expect(reason).toContain("137");
      expect(sessionState(dir).testTotals).toEqual({ [CMD]: T });
    });
  });

  describe("the last-green record (D1)", () => {
    it("a green run writes its totals for the command", () => {
      const dir = makeCountProject({ lastGreen: { [CMD]: T }, output: summary({ total: 140 }) });
      green(stop(dir));
      expect(readJson(dir, LAST_GREEN)[CMD]).toMatchObject({ total: 140, skipped: 0, todo: 0 });
    });
    it("a first green run with no baseline creates the record", () => {
      const dir = makeCountProject({ output: summary({ total: 12, skipped: 1 }) });
      expect(existsSync(join(dir, LAST_GREEN))).toBe(false);
      green(stop(dir));
      expect(readJson(dir, LAST_GREEN)[CMD]).toMatchObject({ total: 12, skipped: 1, todo: 0 });
    });
    it("a red run (command exits non-zero) writes no record", () => {
      const dir = makeCountProject({ output: summary({ total: 12 }), command: "cat summary.txt; exit 1" });
      const reason = blocked(stop(dir));
      expect(reason).toContain("failed (exit 1)");
      expect(existsSync(join(dir, LAST_GREEN))).toBe(false);
    });
    it("a green run whose output has no summary writes no entry", () => {
      const dir = makeCountProject({ output: "all fine\n" });
      green(stop(dir));
      const has = existsSync(join(dir, LAST_GREEN)) && readJson(dir, LAST_GREEN)[CMD] !== undefined;
      expect(has).toBe(false);
    });
  });

  describe("waivers (D7)", () => {
    const dropped = () => ({ lastGreen: { [CMD]: T }, output: summary({ total: 131 }) }); // delta: total=-6 skipped=0 todo=0
    it("a covering waiver in a commit message since the baseline passes", () => {
      green(stop(makeCountProject({ ...dropped(), commitMsg: `prune tests\n\n${waiver("-6", "0", "0")}\n` })));
    });
    it("fixture check: with a commit since the baseline the gate still runs the command (a red command blocks)", () => {
      const dir = makeCountProject({ output: summary({ total: 5 }), commitMsg: "some commit", command: "cat summary.txt; exit 1" });
      expect(blocked(stop(dir))).toContain("failed (exit 1)");
    });
    it("a covering waiver in the waiver file passes", () => {
      green(stop(makeCountProject({ ...dropped(), waiverFile: `# waivers\n${waiver("-6", "+0", "-0")}\n` })));
    });
    it("a waiver that differs from the actual delta in total only does not pass", () => {
      const reason = blocked(stop(makeCountProject({ ...dropped(), commitMsg: waiver("-5", "0", "0") })));
      expect(reason).toContain("131");
    });
    it("a waiver-file line that differs in total only does not pass", () => {
      blocked(stop(makeCountProject({ ...dropped(), waiverFile: waiver("-7", "0", "0") + "\n" })));
    });
    it("a waiver that differs in skipped only does not pass", () => {
      blocked(stop(makeCountProject({ ...dropped(), commitMsg: waiver("-6", "+1", "0") })));
    });
    it("a waiver that differs in todo only does not pass", () => {
      blocked(stop(makeCountProject({ ...dropped(), commitMsg: waiver("-6", "0", "-1") })));
    });
    it("a waiver with an empty reason does not pass", () => {
      blocked(stop(makeCountProject({ ...dropped(), commitMsg: "test-count-waiver: total=-6 skipped=0 todo=0; " })));
      blocked(stop(makeCountProject({ ...dropped(), waiverFile: "test-count-waiver: total=-6 skipped=0 todo=0;\n" })));
    });
    it("a waiver in a commit made before the session's baseline does not pass", () => {
      blocked(stop(makeCountProject({ ...dropped(), preBaselineCommitMsg: waiver("-6", "0", "0") })));
    });
    it("a covering waiver passes a skipped rise; one number off does not (the delta is now minus baseline)", () => {
      const rose = { lastGreen: { [CMD]: { total: 137, skipped: 11, todo: 0 } }, output: summary({ total: 137, skipped: 19 }) };
      green(stop(makeCountProject({ ...rose, commitMsg: waiver("0", "+8", "0") })));
      blocked(stop(makeCountProject({ ...rose, commitMsg: waiver("0", "+7", "0") })));
    });
    it("an unreadable or garbage waiver file never throws: the gate still blocks on the count", () => {
      const garbage = makeCountProject({ ...dropped(), waiverFile: "\u0000\u0001\u0002 not a waiver �\n" });
      expect(blocked(stop(garbage))).toContain("131");
      const asDir = makeCountProject({ ...dropped(), waiverFileAsDir: true });
      expect(blocked(stop(asDir))).toContain("131");
    });
  });

  describe("conflicting summaries fail closed (D5)", () => {
    const forgedFirst = `      Tests  1 passed (1)\n${summary(T)}`; // the real, baseline-equal summary comes last: taking the last would pass
    it("blocks when the output carries two summaries that disagree, saying so", () => {
      const dir = makeCountProject({ lastGreen: { [CMD]: T }, output: forgedFirst });
      expect(blocked(stop(dir))).toMatch(/conflict/i);
    });
    it("blocks when the disagreement is in skipped only", () => {
      const dir = makeCountProject({ lastGreen: { [CMD]: T }, output: `      Tests  137 passed (137)\n      Tests  136 passed | 1 skipped (137)\n` });
      expect(blocked(stop(dir))).toMatch(/conflict/i);
    });
    it("blocks with no baseline at all", () => {
      const dir = makeCountProject({ output: forgedFirst });
      expect(blocked(stop(dir))).toMatch(/conflict/i);
    });
    it("a covering waiver does not cover it", () => {
      const both = `${waiver("-136", "0", "0")}\n${waiver("0", "0", "0")}\n${waiver("-6", "0", "0")}`;
      const dir = makeCountProject({ lastGreen: { [CMD]: T }, output: `      Tests  1 passed (1)\n${summary({ total: 131 })}`, commitMsg: both, waiverFile: both });
      expect(blocked(stop(dir))).toMatch(/conflict/i);
    });
    it("records no verified tree and no last-green entry", () => {
      const dir = makeCountProject({ output: forgedFirst });
      blocked(stop(dir));
      expect(sessionState(dir).verified ?? null).toBeNull();
      expect(existsSync(join(dir, LAST_GREEN))).toBe(false);
    });
    it("two equal summaries are not a conflict", () => {
      green(stop(makeCountProject({ lastGreen: { [CMD]: T }, output: summary(T) + summary(T) })));
    });
  });

  describe("no check when there is nothing to compare (D8)", () => {
    it("no summary line passes and leaves a trace line saying the count check did not run", () => {
      const dir = makeCountProject({ lastGreen: { [CMD]: T }, output: "everything passed, honest\n" });
      green(stop(dir));
      expect(traceReasons(dir).some((x) => /count check/i.test(x) && /summary/i.test(x))).toBe(true);
    });
    it("an unparseable summary passes with the same trace line", () => {
      const dir = makeCountProject({ lastGreen: { [CMD]: T }, output: "      Tests  lots passed (many)\n" });
      green(stop(dir));
      expect(traceReasons(dir).some((x) => /count check/i.test(x) && /summary/i.test(x))).toBe(true);
    });
    it("a `no tests` summary passes with the trace line", () => {
      const dir = makeCountProject({ lastGreen: { [CMD]: T }, output: "      Tests  no tests\n" });
      green(stop(dir));
      expect(traceReasons(dir).some((x) => /count check/i.test(x) && /summary/i.test(x))).toBe(true);
    });
    it("no baseline passes and leaves a trace line saying the count check did not run", () => {
      const dir = makeCountProject({ output: summary({ total: 5 }) });
      green(stop(dir));
      expect(traceReasons(dir).some((x) => /count check/i.test(x) && /baseline/i.test(x))).toBe(true);
    });
    it("a garbage last-green file means no baseline: the gate decides on its own checks, no fail-open message", () => {
      const dir = makeCountProject({ lastGreen: "{{{ nope", output: summary({ total: 5 }) });
      green(stop(dir));
      expect(traceReasons(dir).some((x) => /count check/i.test(x))).toBe(true);
    });
    it("a garbage state.testTotals does not throw the gate", () => {
      const dir = makeCountProject({ output: summary({ total: 5 }) });
      const state = loadState(dir, "test-session");
      state.testTotals = "junk";
      saveState(dir, "test-session", state);
      green(stop(dir));
    });
    it("a baseline entry that is not numbers does not throw the gate", () => {
      const dir = makeCountProject({ output: summary({ total: 5 }) });
      const state = loadState(dir, "test-session");
      state.testTotals = { [CMD]: { total: "many", skipped: null } };
      saveState(dir, "test-session", state);
      green(stop(dir));
    });
  });

  describe("review m4: a baseline entry with a negative or fractional count is no baseline", () => {
    // Each case would block if the entry were compared: a fractional total above the run's, a negative skipped
    // below the run's 0 (a "rise"), a negative todo likewise.
    const cases = [
      ["fractional total", { total: 137.5, skipped: 0, todo: 0 }, summary({ total: 137 })],
      ["negative skipped", { total: 137, skipped: -3, todo: 0 }, summary({ total: 137 })],
      ["negative todo", { total: 137, skipped: 0, todo: -2 }, summary({ total: 137 })],
      ["fractional skipped", { total: 137, skipped: 0.5, todo: 0 }, summary({ total: 137, skipped: 1 })],
    ];
    for (const [name, entry, output] of cases) {
      it(`${name}: not compared, the gate passes and the trace says there is no baseline`, () => {
        const dir = makeCountProject({ lastGreen: { [CMD]: entry }, output });
        expect(sessionState(dir).testTotals[CMD]).toEqual(entry); // fixture check: the entry reached state as written
        green(stop(dir));
        expect(traceReasons(dir).some((x) => /count check/i.test(x) && /baseline/i.test(x))).toBe(true);
      });
    }
  });

  describe("review m2: count-check notes honour trace.enabled false", () => {
    it("a no-summary run passes and writes no trace file", () => {
      const dir = makeCountProject({ lastGreen: { [CMD]: T }, output: "everything passed, honest\n" });
      writeFileSync(join(dir, ".doug/config.json"), JSON.stringify({ ...baseConfig, commands: { test: CMD }, trace: { enabled: false } }));
      green(stop(dir));
      expect(existsSync(join(dir, ".doug/.state/trace/test-session.jsonl"))).toBe(false);
      expect(traceReasons(dir)).toEqual([]);
    });
    it("control: with trace enabled the same run does leave the count-check line", () => {
      const dir = makeCountProject({ lastGreen: { [CMD]: T }, output: "everything passed, honest\n" });
      writeFileSync(join(dir, ".doug/config.json"), JSON.stringify({ ...baseConfig, commands: { test: CMD }, trace: { enabled: true } }));
      green(stop(dir));
      expect(traceReasons(dir).some((x) => /count check/i.test(x))).toBe(true);
    });
  });

  describe("review m1: a count problem is not a failed command for the tests_red_by_design claim (D9)", () => {
    const GREEN_CMD = "cat green.txt";
    const RED_CMD = "echo ' FAIL  tests/a.test.mjs > it'; exit 1";
    function testerProject(greenOutput) {
      const dir = makeProject({ config: { ...baseConfig, commands: { red: RED_CMD, counted: GREEN_CMD }, stopGate: { ...baseConfig.stopGate, commands: ["red", "counted"] } }, git: true });
      mkdirSync(join(dir, "tests"));
      writeFileSync(join(dir, "tests/a.test.mjs"), "it fails on purpose");
      writeFileSync(join(dir, "green.txt"), greenOutput);
      runHookScript("edit-loop", { tool_name: "Write", tool_input: { file_path: "tests/a.test.mjs" }, agent_id: "ag1", agent_type: "tester" }, { dir });
      const state = loadState(dir, "test-session");
      state.testTotals = { [GREEN_CMD]: T };
      saveState(dir, "test-session", state);
      return dir;
    }
    const claimInput = { hook_event_name: "SubagentStop", agent_id: "ag1", agent_type: "tester", last_assistant_message: `Red as designed.\n${JSON.stringify({ tests_red_by_design: ["tests/a.test.mjs"] })}` };
    it("control: the red command alone, the green one at its baseline, is allowed by the claim", () => {
      const r = runHookScript("stop-gate", claimInput, { dir: testerProject(summary(T)) });
      expect(r.json.decision).toBeUndefined();
      expect(r.json.systemMessage).toContain("stopped with tests red by design: tests/a.test.mjs");
    });
    it("the same scenario with the green command's total dropped blocks, naming the count problem", () => {
      const r = runHookScript("stop-gate", claimInput, { dir: testerProject(summary({ total: 131 })) });
      expect(r.json.decision).toBe("block");
      expect(r.json.reason).toContain("test count regressed");
      expect(r.json.reason).toContain("137");
      expect(r.json.reason).toContain("131");
    });
  });
});

describe("stop-gate reuses its last red on an unchanged tree (card stop-gate-no-change-restop)", () => {
  const runsRel = ".doug/.state/runs.log";
  const SUMMARY = "RED-SUMMARY-XYZ";
  // Each run appends one "x" to the marker file (inside .doug/.state, which the tree fingerprint ignores),
  // prints a recognisable failure line, and exits 1.
  const redCommand = (extra = "") =>
    `${process.execPath} -e "require('fs').appendFileSync('${runsRel}','x');console.log('${SUMMARY}');process.exit(1)"${extra}`;
  const makeConfig = (over = {}) => ({
    ...baseConfig,
    commands: { test: redCommand() },
    stopGate: { commands: ["test"], onlyIfEdited: true, maxBlocks: 3, timeoutMs: 10000, requireEvidence: false },
    ...over,
  });
  const runs = (dir) => (existsSync(join(dir, runsRel)) ? readFileSync(join(dir, runsRel), "utf8").length : 0);
  const stateOf = (dir) => JSON.parse(readFileSync(join(dir, ".doug/.state/test-session.json"), "utf8"));
  const stop = (dir, extra = {}) => runHookScript("stop-gate", { hook_event_name: "Stop", ...extra }, { dir });
  const subStop = (dir, id, extra = {}) =>
    runHookScript("stop-gate", { hook_event_name: "SubagentStop", agent_id: id, agent_type: "coder", ...extra }, { dir });

  function makeEditedProject(config, agent = {}) {
    const dir = makeProject({ config, git: true });
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src/a.ts"), "base");
    execFileSync("git", ["add", "-A"], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", "base"], { cwd: dir });
    writeFileSync(join(dir, "src/a.ts"), "edited this session");
    runHookScript("edit-loop", { tool_name: "Edit", tool_input: { file_path: "src/a.ts" }, ...agent }, { dir });
    return dir;
  }

  it("N1 an unchanged tree after a test failure: the second stop does not run the command, blocks, says nothing changed, repeats the summary, and counts", () => {
    const dir = makeEditedProject(makeConfig());
    const r1 = stop(dir);
    expect(r1.json.decision).toBe("block");
    expect(r1.json.reason).toContain(SUMMARY);
    expect(r1.json.reason).toContain("(1/3)");
    expect(runs(dir)).toBe(1);

    const r2 = stop(dir);
    expect(runs(dir), "an unchanged tree after a red must not re-run the commands").toBe(1);
    expect(r2.json.decision).toBe("block");
    expect(r2.json.reason).toMatch(/nothing changed/i);
    expect(r2.json.reason).toContain(SUMMARY);
    expect(r2.json.reason).toContain("(2/3)");
    expect(stateOf(dir).stopBlocks).toBe(2);
  });

  it("N2 an edited tree since the red runs the command again", () => {
    const dir = makeEditedProject(makeConfig());
    stop(dir);
    expect(runs(dir)).toBe(1);
    writeFileSync(join(dir, "src/a.ts"), "edited again");
    const r2 = stop(dir);
    expect(runs(dir)).toBe(2);
    expect(r2.json.decision).toBe("block");
    expect(r2.json.reason).toContain(SUMMARY);
    expect(r2.json.reason).not.toMatch(/nothing changed/i);
  });

  it("N3 a different agent_id on the same tree runs the command", () => {
    const dir = makeEditedProject(makeConfig(), { agent_id: "agA", agent_type: "coder" });
    runHookScript("edit-loop", { tool_name: "Edit", tool_input: { file_path: "src/a.ts" }, agent_id: "agB", agent_type: "coder" }, { dir });
    const rA = subStop(dir, "agA");
    expect(rA.json.decision).toBe("block");
    expect(runs(dir)).toBe(1);
    const rB = subStop(dir, "agB");
    expect(runs(dir), "another agent's stop must run the commands itself").toBe(2);
    expect(rB.json.decision).toBe("block");
    expect(rB.json.reason).not.toMatch(/nothing changed/i);
    // and the same agent, unchanged, is what reuse is for
    subStop(dir, "agB");
    expect(runs(dir)).toBe(2);
  });

  it("N4 a recorded timeout is never reused: the next stop on the unchanged tree runs", () => {
    const sleeper = `${process.execPath} -e "require('fs').appendFileSync('${runsRel}','x');setTimeout(()=>{},8000)"`;
    const dir = makeEditedProject(
      makeConfig({
        commands: { test: sleeper },
        stopGate: { commands: ["test"], onlyIfEdited: true, maxBlocks: 3, timeoutMs: 1000, requireEvidence: false },
      }),
    );
    const r1 = stop(dir);
    expect(r1.json.decision).toBe("block");
    expect(runs(dir)).toBe(1);
    const r2 = stop(dir);
    expect(runs(dir), "a timeout is a load-caused red and must get its rerun").toBe(2);
    expect(r2.json.decision).toBe("block");
  });

  it("N5 a corrupt lastRed record runs the command, with no throw and no fail-open", () => {
    // maxBlocks high enough that four garbage stops never reach the stand-down.
    const dir = makeEditedProject(makeConfig({ stopGate: { commands: ["test"], onlyIfEdited: true, maxBlocks: 10, timeoutMs: 10000, requireEvidence: false } }));
    stop(dir);
    expect(runs(dir)).toBe(1);
    let expected = 1;
    for (const garbage of ["garbage", { fingerprint: 5 }, { fingerprint: null, scope: 7, commands: "x", summary: 1 }, []]) {
      const state = stateOf(dir);
      state.lastRed = garbage;
      writeFileSync(join(dir, ".doug/.state/test-session.json"), JSON.stringify(state));
      const r = stop(dir);
      expected += 1;
      expect(runs(dir), `garbage ${JSON.stringify(garbage)} must not suppress the run`).toBe(expected);
      expect(r.status).toBe(0);
      expect(r.json.decision, `expected a block, got ${JSON.stringify(r.json)}`).toBe("block");
      expect(r.json.reason).toContain(SUMMARY);
      expect(r.stderr || "").not.toMatch(/fail(ed)?[- ]open|TypeError|Error:/i);
    }
  });

  it("N6 maxBlocks still stands down: the reuse counts, and the third stop on an unchanged tree stands down", () => {
    const dir = makeEditedProject(
      makeConfig({ stopGate: { commands: ["test"], onlyIfEdited: true, maxBlocks: 2, timeoutMs: 10000, requireEvidence: false } }),
    );
    const r1 = stop(dir);
    expect(r1.json.decision).toBe("block");
    expect(r1.json.reason).toContain("(1/2)");
    const r2 = stop(dir);
    expect(r2.json.decision).toBe("block");
    expect(r2.json.reason).toContain("(2/2)");
    expect(runs(dir), "the second stop is a reuse, not a run").toBe(1);
    const r3 = stop(dir);
    expect(r3.json.decision).toBeUndefined();
    expect(r3.json.systemMessage).toContain("standing down");
    expect(runs(dir)).toBe(1);
  });

  it("N6b maxBlocks 1: the second stop on an unchanged tree stands down before any reuse, running nothing", () => {
    const dir = makeEditedProject(
      makeConfig({ stopGate: { commands: ["test"], onlyIfEdited: true, maxBlocks: 1, timeoutMs: 10000, requireEvidence: false } }),
    );
    const r1 = stop(dir);
    expect(r1.json.decision).toBe("block");
    expect(runs(dir)).toBe(1);
    const r2 = stop(dir);
    expect(r2.json.decision, "at the cap the gate stands down, it does not block").toBeUndefined();
    expect(r2.json.systemMessage).toContain("standing down");
    expect(r2.json.systemMessage).not.toMatch(/nothing changed/i);
    expect(runs(dir)).toBe(1);
  });

  it("N7 a changed configured command list runs the command", () => {
    const dir = makeEditedProject(makeConfig());
    stop(dir);
    expect(runs(dir)).toBe(1);
    // Same tree, same command name, different command text.
    writeFileSync(join(dir, ".doug/config.json"), JSON.stringify(makeConfig({ commands: { test: redCommand(" # v2") } })));
    const r2 = stop(dir);
    expect(runs(dir), "a different command set must run").toBe(2);
    expect(r2.json.decision).toBe("block");
    expect(r2.json.reason).not.toMatch(/nothing changed/i);
    // And a different list of names.
    writeFileSync(
      join(dir, ".doug/config.json"),
      JSON.stringify(
        makeConfig({
          commands: { test: redCommand(" # v2"), lint: "echo lint-ran; exit 1" },
          stopGate: { commands: ["test", "lint"], onlyIfEdited: true, maxBlocks: 5, timeoutMs: 10000, requireEvidence: false },
        }),
      ),
    );
    stop(dir);
    expect(runs(dir)).toBe(3);
  });

  // Seed variants of a real record: the fingerprint and scope stay exactly as recorded, so only the one
  // field under test can make the gate run.
  const OPEN = { stopGate: { commands: ["test"], onlyIfEdited: true, maxBlocks: 10, timeoutMs: 10000, requireEvidence: false } };
  function seedVariant(dir, mutate) {
    const state = stateOf(dir);
    expect(state.lastRed, "a real red must have recorded state.lastRed").toBeTruthy();
    state.lastRed = mutate(state.lastRed);
    writeFileSync(join(dir, ".doug/.state/test-session.json"), JSON.stringify(state));
  }

  it("N7b a recorded command list that differs from the configured one, with the fingerprint and scope intact, runs the command", () => {
    const dir = makeEditedProject(makeConfig(OPEN));
    stop(dir);
    expect(runs(dir)).toBe(1);
    // Capture the record straight after the real red, before any reuse clears it.
    const recorded = stateOf(dir).lastRed;
    expect(recorded, "a real red must have recorded state.lastRed").toBeTruthy();
    let expected = 1;
    const variants = [
      (r) => ({ ...r, commands: [...r.commands, "an extra command"] }),
      (r) => ({ ...r, commands: r.commands.map((c) => c + " # other") }),
      (r) => ({ ...r, commands: [] }),
    ];
    for (const mutate of variants) {
      seedVariant(dir, () => mutate(recorded));
      const r = stop(dir);
      expected += 1;
      expect(runs(dir), "a different command set must run").toBe(expected);
      expect(r.json.decision).toBe("block");
      expect(r.json.reason).not.toMatch(/nothing changed/i);
    }
    // control, last: the last variant's run recorded a fresh, untouched record, which is reused.
    const rc = stop(dir);
    expect(runs(dir)).toBe(expected);
    expect(rc.json.reason).toMatch(/nothing changed/i);
  });

  it("N5b a wrong-shape record with a matching fingerprint, scope and commands runs the command, no throw, no fail-open", () => {
    const dir = makeEditedProject(makeConfig(OPEN));
    stop(dir);
    expect(runs(dir)).toBe(1);
    let expected = 1;
    const variants = [
      (r) => ({ ...r, summary: 5 }),
      (r) => ({ ...r, summary: null }),
      (r) => ({ ...r, summary: { text: r.summary } }),
      (r) => ({ ...r, commands: [5] }),
      (r) => ({ ...r, commands: [...r.commands, 5] }),
      (r) => ({ ...r, commands: "not an array" }),
      (r) => ({ ...r, scope: 7 }),
    ];
    for (const mutate of variants) {
      seedVariant(dir, mutate);
      const r = stop(dir);
      expected += 1;
      expect(runs(dir), `variant ${expected - 1} must not be reused`).toBe(expected);
      expect(r.status).toBe(0);
      expect(r.json.decision, `expected a block, got ${JSON.stringify(r.json)}`).toBe("block");
      expect(r.json.reason).toContain(SUMMARY);
      expect(r.json.reason).not.toMatch(/nothing changed/i);
      expect(r.stderr || "").not.toMatch(/fail(ed)?[- ]open|TypeError|Error:/i);
    }
  });

  it("N9 one reuse per record: after a reuse the next stop on the unchanged tree really runs, and the red it records can be reused again", () => {
    const dir = makeEditedProject(makeConfig(OPEN));
    const r1 = stop(dir);
    expect(r1.json.decision).toBe("block");
    expect(runs(dir)).toBe(1);
    const r2 = stop(dir);
    expect(r2.json.reason).toMatch(/nothing changed/i);
    expect(runs(dir), "the second stop is the one reuse").toBe(1);
    const r3 = stop(dir);
    expect(runs(dir), "the third stop, after a reuse, must run the commands again").toBe(2);
    expect(r3.json.decision).toBe("block");
    expect(r3.json.reason).toContain(SUMMARY);
    expect(r3.json.reason).not.toMatch(/nothing changed/i);
    expect(r3.json.reason).toContain("(3/10)");
    const r4 = stop(dir);
    expect(runs(dir), "the new red recorded afresh is reusable once more").toBe(2);
    expect(r4.json.decision).toBe("block");
    expect(r4.json.reason).toMatch(/nothing changed/i);
    expect(r4.json.reason).toContain("(4/10)");
  });

  it("N4b a command killed by a signal is not recorded: the next stop on the unchanged tree runs", () => {
    const killed = `${process.execPath} -e "require('fs').appendFileSync('${runsRel}','x');process.kill(process.pid,'SIGKILL')"`;
    const dir = makeEditedProject(makeConfig({ commands: { test: killed }, ...OPEN }));
    const r1 = stop(dir);
    expect(r1.json.decision).toBe("block");
    expect(runs(dir)).toBe(1);
    const r2 = stop(dir);
    expect(runs(dir), "a signal-killed command is load-suspect and must get its rerun").toBe(2);
    expect(r2.json.decision).toBe("block");
    expect(r2.json.reason).not.toMatch(/nothing changed/i);
  });

  it("N10 the reuse's blocks.jsonl line carries the class of the recorded block (expected-red under a standing claim)", () => {
    const failing = `${process.execPath} -e "require('fs').appendFileSync('${runsRel}','x');console.log(' FAIL  tests/a.test.mjs > it');process.exit(1)"`;
    const dir = makeProject({ config: makeConfig({ commands: { test: failing }, ...OPEN }), git: true });
    mkdirSync(join(dir, "tests"));
    writeFileSync(join(dir, "tests/a.test.mjs"), "it fails on purpose");
    runHookScript("edit-loop", { tool_name: "Write", tool_input: { file_path: "tests/a.test.mjs" }, agent_id: "ag1", agent_type: "tester" }, { dir });
    const claim = `Red as designed.\n${JSON.stringify({ tests_red_by_design: ["tests/a.test.mjs"] })}`;
    const honoured = runHookScript("stop-gate", { hook_event_name: "SubagentStop", agent_id: "ag1", agent_type: "tester", last_assistant_message: claim }, { dir });
    expect(honoured.json.decision).toBeUndefined();
    const ledger = () => {
      const f = join(dir, ".doug/.state/blocks.jsonl");
      return existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
    };
    const r1 = stop(dir);
    expect(r1.json.decision).toBe("block");
    const after1 = ledger();
    expect(after1[after1.length - 1].class, JSON.stringify(after1)).toBe("expected-red");
    const before = runs(dir);
    const r2 = stop(dir);
    expect(r2.json.reason, "the second stop must be the reuse").toMatch(/nothing changed/i);
    expect(runs(dir)).toBe(before);
    const after2 = ledger();
    expect(after2.length).toBe(after1.length + 1);
    expect(after2[after2.length - 1].class, "a reuse keeps the class of the block it repeats").toBe("expected-red");
  });

  it("N11 a reuse block on the Stop that hit the deferral cap carries the cap note too", () => {
    const dir = makeEditedProject(
      makeConfig({ stopGate: { ...OPEN.stopGate, maxDeferrals: 2 }, trace: { enabled: true } }),
    );
    const traceFile = join(dir, ".doug/.state/trace/test-session.jsonl");
    mkdirSync(dirname(traceFile), { recursive: true });
    writeFileSync(
      traceFile,
      JSON.stringify({ t: new Date().toISOString(), event: "SubagentStart", session: "test-session", agent: "ag1", agentType: "coder", tool: null, toolUseId: null, detail: null, ok: null, tokens: null, context: null, reason: null }) + "\n",
    );
    const d1 = stop(dir);
    expect(d1.json.systemMessage.toLowerCase()).toContain("deferred");
    expect(runs(dir)).toBe(0);
    const r2 = stop(dir); // hits the cap: runs the gate, blocks with the note
    expect(runs(dir)).toBe(1);
    expect(r2.json.decision).toBe("block");
    expect(r2.json.reason).toContain("Deferral cap reached");
    const d3 = stop(dir);
    expect(d3.json.systemMessage.toLowerCase()).toContain("deferred");
    const r4 = stop(dir); // hits the cap again: unchanged tree, so the reuse block
    expect(runs(dir), "the fourth stop must be a reuse").toBe(1);
    expect(r4.json.decision).toBe("block");
    expect(r4.json.reason).toMatch(/nothing changed/i);
    expect(r4.json.reason, "a reuse block must carry the cap note like any block on this Stop").toContain("Deferral cap reached");
  });

  it("N8 a tester SubagentStop carrying a tests_red_by_design claim runs, even on an unchanged tree", () => {
    const failing = `${process.execPath} -e "require('fs').appendFileSync('${runsRel}','x');console.log(' FAIL  tests/a.test.mjs > it');console.log(' ❯ tests/a.test.mjs (3 tests | 1 failed)');process.exit(1)"`;
    const dir = makeProject({ config: makeConfig({ commands: { test: failing } }), git: true });
    mkdirSync(join(dir, "tests"));
    writeFileSync(join(dir, "tests/a.test.mjs"), "it fails on purpose");
    runHookScript("edit-loop", { tool_name: "Write", tool_input: { file_path: "tests/a.test.mjs" }, agent_id: "ag1", agent_type: "tester" }, { dir });
    const plain = { hook_event_name: "SubagentStop", agent_id: "ag1", agent_type: "tester" };
    const r1 = runHookScript("stop-gate", { ...plain, last_assistant_message: "done" }, { dir });
    expect(r1.json.decision).toBe("block");
    expect(runs(dir)).toBe(1);
    const claim = `Red as designed.\n${JSON.stringify({ tests_red_by_design: ["tests/a.test.mjs"] })}`;
    const r2 = runHookScript("stop-gate", { ...plain, last_assistant_message: claim }, { dir });
    expect(runs(dir), "the claim's coverage check needs real command output").toBe(2);
    expect(r2.json.decision).toBeUndefined();
    expect(r2.json.systemMessage).toContain("tests red by design: tests/a.test.mjs");
  });
});

// card trace-redact-secrets (T9): the trace script passes the project's secrets config to the line builder.
// The token is built by concatenation so this file never holds a whole token.
describe("trace script redaction (card trace-redact-secrets)", () => {
  const GH = "ghp_" + "aB3dE5gH7jK9mN1pQ3sT5vX7zA9cE1gI3kM5";
  const input = { hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "tu1", tool_input: { command: "echo " + GH } };
  const lines = (dir) =>
    readFileSync(join(dir, ".doug/.state/trace/test-session.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));

  it("T9 default config writes the token redacted; a config disabling githubToken writes it unredacted", () => {
    const def = makeProject({ config: { trace: { enabled: true } }, git: true });
    runHookScript("trace", input, { dir: def });
    const [l1] = lines(def);
    expect(l1.detail).toBe("[redacted: githubToken]");
    expect(readFileSync(join(def, ".doug/.state/trace/test-session.jsonl"), "utf8")).not.toContain(GH.slice(0, 12));

    const off = makeProject({ config: { trace: { enabled: true }, secrets: { rules: { githubToken: false } } }, git: true });
    runHookScript("trace", input, { dir: off });
    const [l2] = lines(off);
    expect(l2.detail).toContain(GH);
  });
});
