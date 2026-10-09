import { describe, it, expect } from "vitest";
import { writeFileSync, appendFileSync, mkdirSync, readFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join, dirname, basename } from "node:path";
import { tmpdir } from "node:os";
import { makeProject, runHookScript } from "./helpers.mjs";
// card proposal-ledger-forgeable: a genuine ledger line is built the way applyProposal itself builds one - a
// test may cross the plugin boundary even though lib code may not (see plugins/doug-gates/lib/proposals.mjs's
// own header comment for that precedent).
import { applyProposal, unifiedDiff } from "../../doug-flow/lib/learn.mjs";
import { baseConfig } from "./hooks-fixtures.mjs";

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
      runHookScript("trace", { hook_event_name: "SubagentStart", agent_id: "ag1", agent_type: "coder" }, { dir });
      const r = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
      expect(r.json.decision).toBeUndefined();
      expect(r.json.systemMessage).toContain("Verification deferred");
      expect(r.json.systemMessage).toContain("coder:ag1");
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
