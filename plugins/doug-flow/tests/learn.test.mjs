import { describe, it, expect } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { openMemory, addLesson, recordOutcomes, supersedeLesson, writeRunHistory, recordPitfallOccurrence } from "../lib/memory.mjs";
import { proposeRule } from "../lib/decisions.mjs";
import { createHash } from "node:crypto";
import { traceLine } from "../../doug-gates/lib/trace.mjs";
import { collectSignals, proposeChanges, writeProposals, applyProposal, unifiedDiff, readAppliedLedger, PROPOSAL_LEDGER_RELPATH, LEARN_STATE_RELPATH, readGate, RULE_MIN_CARDS, RULE_MIN_SESSIONS, renderRule, cardFilesTouched } from "../lib/learn.mjs";

// Deterministic proposals from the outcomes/lessons store and the run trace (card learn-signals): log-then-
// propose, never auto-apply. collectSignals/proposeChanges/writeProposals are pure given their inputs; only
// applyProposal ever touches a tracked file, and only the one the caller names.

const script = join(new URL(".", import.meta.url).pathname, "..", "scripts", "learn.mjs");

const CLAUDE_MD = [
  "# Project instructions",
  "",
  "## Working agreement",
  "",
  "- Do what was asked. Do not refactor, rename, or add files beyond the request.",
  "",
  "## Gotchas",
  "",
  "- the bash guard blocks git branch -D and remote branch deletes (merge first and use -d, or ask).",
  "- Task worktrees live under .claude/worktrees/ (gitignored).",
  "",
].join("\n");

function tempProject({ claudeMd = CLAUDE_MD, config = { protectedPaths: [".doug/config.json"] } } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "doug-learn-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
  writeFileSync(join(dir, ".gitignore"), ".doug/.state/\n");
  writeFileSync(join(dir, "CLAUDE.md"), claudeMd);
  mkdirSync(join(dir, ".doug"), { recursive: true });
  writeFileSync(join(dir, ".doug/config.json"), `${JSON.stringify(config, null, 2)}\n`);
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
  return dir;
}

// card proposal-ledger-forgeable: applyProposal refuses a diff file that does not resolve under
// dir/LEARN_STATE_RELPATH, so every fixture diff for applyProposal is written there rather than at the project
// root.
function learnDiffPath(dir, name) {
  const folder = join(dir, LEARN_STATE_RELPATH, "fixtures");
  mkdirSync(folder, { recursive: true });
  return join(folder, name);
}

function writeTrace(dir, name, lines) {
  const traceDir = join(dir, ".doug/.state/trace");
  mkdirSync(traceDir, { recursive: true });
  writeFileSync(join(traceDir, name), `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
}

function readConfig(dir) {
  return JSON.parse(readFileSync(join(dir, ".doug/config.json"), "utf8"));
}

// --- readGate (card op-learn-gate-shape) ---------------------------------------------------------------------
// isGateFailure for a hand-track row used to require gate.startsWith("typecheck 0"), so any other project's
// gate line (pytest, npm, ...) misclassified a green run as a failure. readGate reads exit-status clauses
// and fail-words instead, independent of Doug's own gate shape.

describe("readGate", () => {
  it.each([
    ["typecheck 0; unit 639 passed", "pass"], // Doug's own historic shape
    ["typecheck 0, test:unit 0", "pass"], // existing fixture card-b
    ["typecheck 1 failure", "fail"], // existing fixture card-c
    ["pytest 0", "pass"],
    ["ruff 0; pytest 0", "pass"],
    ["pytest 0 (41 passed)", "pass"],
    ["pytest 1", "fail"],
    ["ruff 0; pytest 2", "fail"],
    ["pytest 12 passed, 1 failed", "fail"],
    ["typecheck 0; test:unit 0 (639 passed)", "pass"], // the new run-report shape
    ["unit 639 passed", "fail"], // no exit clause
    ["", "fail"],
    [null, "fail"],
    ["all good", "fail"],
    // isolate rule b (fail words) from rule c/d: each of these also matches an exit-clause-shaped pattern, so
    // dropping rule b alone (leaving c/d intact) would wrongly read these as passing.
    ["pytest 0 (3 failed)", "fail"], // rule c would read "pytest 0 (3 failed)" as a passing exit clause (exit 0) without rule b
    ["typecheck 0; pytest 0 errors", "fail"], // "pytest 0 errors" matches no exit-clause pattern (doesn't end in a digit); without rule b it is neutral, leaving only the passing "typecheck 0" clause
    // reviewer round: M1 design change - a ","/";" inside parentheses must not split a clause, since the
    // parenthesised note is itself allowed to carry commas (e.g. a pass/skip breakdown).
    ["pytest 0 (41 passed, 2 skipped)", "pass"], // red now: splitting on the internal comma breaks the clause into two, neither of which is a passing exit clause
    ["typecheck 0; test:unit 1 (2598 passed, 1 failed)", "fail"], // the "1 failed)" fragment still trips the fail-word rule either way, so this one already reads fail
    // reviewer round: M3 - pins the existing mechanisms (comma split, bare fail word, case-insensitivity, whole-word matching).
    ["pytest 0, ruff 1", "fail"], // the comma split: "ruff 1" is a non-zero exit clause
    ["typecheck 0; pytest 0 error", "fail"], // a bare "error" word
    ["pytest 0 (3 FAILED)", "fail"], // case-insensitive fail word
    ["typecheck 0; failover 0", "pass"], // whole-word matching: "failover" is not the fail word "fail"
  ])("readGate(%j) -> %s", (gate, expected) => {
    expect(readGate(gate)).toBe(expected);
  });
});

// --- card memory-failure-lessons helpers -----------------------------------------------------------------------

const pit = (o = {}) => ({ id: "pit1", text: "Never edit dist/ by hand.", cards: ["a", "b", "c"], sessions: ["s1", "s2"], citations: ["history:a/r1:2", "history:b/r1:2", "history:c/r1:2"], files: ["src/a.mjs"], ...o });
const pitfallSignals = (pitfalls) => ({ outcomes: { rows: [] }, lessons: { pitfalls }, trace: { denials: [], files: [], skills: [] } });

function writeHistoryReport(dir, card, report, run = "wf_1") {
  writeRunHistory(dir, { card, run, entries: [{ kind: "report", source: "card-report.json", value: JSON.stringify(report) }], scan: () => null });
}

// --- collectSignals -----------------------------------------------------------------------------------------

describe("collectSignals", () => {
  it("counts outcomes: gate failures per track, blocksByClass, fixPasses, usd, and a per-card breakdown", () => {
    const dir = tempProject();
    const m = openMemory(dir);
    recordOutcomes(m, [
      { run: "r1", task: "t1", card: "card-a", track: "flow", verified: 1, fix_passes: 2, usd: 3.5, blocks: [{ id: "b1", class: "real", description: "x" }], recorded: "2026-09-01T00:00:00.000Z" },
      { run: "r1", task: "t2", card: "card-a", track: "flow", verified: 0, fix_passes: 0, usd: 1.0, blocks: [{ id: "b2", class: "marginal", description: "y" }], recorded: "2026-09-01T00:00:01.000Z" },
      { run: "hand:sha1", task: "card-b", card: "card-b", track: "hand", gate: "typecheck 0, test:unit 0", recorded: "2026-09-01T00:00:02.000Z" },
      { run: "hand:sha2", task: "card-c", card: "card-c", track: "hand", gate: "typecheck 1 failure", recorded: "2026-09-01T00:00:03.000Z" },
    ]);
    const signals = collectSignals(m, { dir });
    m.close();
    expect(signals.outcomes.rows.length).toBe(4);
    // gate failures: t2 (verified 0, flow) and card-c (hand gate "typecheck 1 failure" -> readGate fail) = 2
    expect(signals.outcomes.gateFailures).toBe(2);
    expect(signals.outcomes.blocksByClass).toEqual({ real: 1, marginal: 1, false: 0 });
    expect(signals.outcomes.fixPasses).toEqual({ sum: 2, max: 2 });
    expect(signals.outcomes.usd).toEqual({ sum: 4.5, n: 2 });
    expect(signals.outcomes.byCard["card-a"]).toMatchObject({ rows: 2, gateFailures: 1 });
    expect(signals.outcomes.byCard["card-b"]).toMatchObject({ rows: 1, gateFailures: 0 });
    expect(signals.outcomes.byCard["card-c"]).toMatchObject({ rows: 1, gateFailures: 1 });
  });

  // card op-learn-gate-shape: a hand row's gate is read by readGate's clauses, not by Doug's own
  // "typecheck 0" shape, so a pytest-shaped green gate is not a failure and a red one is.
  it("reads a hand row's gate independent of Doug's own gate shape: a pytest-shaped green gate is not a failure, a red one is, and Doug's own shape is unchanged", () => {
    const dir = tempProject();
    const m = openMemory(dir);
    recordOutcomes(m, [
      { run: "hand:pysha1", task: "card-py-green", card: "card-py-green", track: "hand", gate: "pytest 0", recorded: "2026-09-01T00:00:04.000Z" },
      { run: "hand:pysha2", task: "card-py-red", card: "card-py-red", track: "hand", gate: "pytest 1", recorded: "2026-09-01T00:00:05.000Z" },
      { run: "hand:doug1", task: "card-doug", card: "card-doug", track: "hand", gate: "typecheck 0; unit 639 passed", recorded: "2026-09-01T00:00:06.000Z" },
    ]);
    const signals = collectSignals(m, { dir });
    m.close();
    expect(signals.outcomes.byCard["card-py-green"]).toMatchObject({ rows: 1, gateFailures: 0 });
    expect(signals.outcomes.byCard["card-py-red"]).toMatchObject({ rows: 1, gateFailures: 1 });
    expect(signals.outcomes.byCard["card-doug"]).toMatchObject({ rows: 1, gateFailures: 0 });
  });

  it("counts lessons: total/live/helpful/harmful/stale, and no longer reports a repeated signal (card memory-failure-lessons)", () => {
    const dir = tempProject();
    const m = openMemory(dir);
    addLesson(m, { text: "Always run pnpm typecheck before committing.", kind: "feedback", source: { agent: "lead" } });
    addLesson(m, { text: "You must always run pnpm typecheck before committing changes.", kind: "feedback", source: { agent: "lead" } });
    const solo = addLesson(m, { text: "A stray unrelated lesson about something else entirely.", kind: "pattern", source: { agent: "lead" } });
    const superseded = addLesson(m, { text: "An old superseded lesson.", kind: "project", source: { agent: "lead" } });
    const replacement = addLesson(m, { text: "The replacement lesson.", kind: "project", source: { agent: "lead" }, id: undefined });
    m.prepare("UPDATE lessons SET superseded_by = ? WHERE id = ?").run(replacement.id, superseded.id);
    m.prepare("UPDATE lessons SET helpful = 3 WHERE id = ?").run(solo.id);
    m.prepare("UPDATE lessons SET harmful = 1 WHERE id = ?").run(replacement.id);
    m.prepare("UPDATE lessons SET stale = ? WHERE id = ?").run("2026-09-10T00:00:00.000Z", replacement.id);

    const signals = collectSignals(m, { dir });
    m.close();
    expect(signals.lessons.total).toBe(5);
    expect(signals.lessons.live).toBe(4); // superseded excluded
    expect(signals.lessons.helpful).toBe(1);
    expect(signals.lessons.harmful).toBe(1);
    expect(signals.lessons.stale).toBe(1);
    expect(signals.lessons.repeated).toBeUndefined();
    expect(signals.lessons.pitfalls).toEqual([]);
  });

  it("T10 (card trace-redact-secrets) denials of two different GitHub tokens group into one redacted row with count 2", () => {
    const dir = tempProject();
    const tokA = "ghp_" + "aB3dE5gH7jK9mN1pQ3sT5vX7zA9cE1gI3kM5";
    const tokB = "ghp_" + "zY8xW6vU4tS2rQ0pO8nM6lK4jI2hG0fE8dC6";
    const denied = (id, tok) => traceLine({ hook_event_name: "PermissionDenied", session_id: "s1", tool_name: "Bash", tool_use_id: id, tool_input: { command: "git push https://x:" + tok + "@github.com/o/r.git" } });
    writeTrace(dir, "s1.jsonl", [
      denied("d1", tokA),
      denied("d2", tokB),
      { event: "PreToolUse", session: "s1", tool: "Bash", toolUseId: "inflight", detail: "pnpm test" }, // last line: in flight
    ]);
    const m = openMemory(dir);
    const signals = collectSignals(m, { dir });
    m.close();
    expect(signals.trace.denials).toHaveLength(1);
    expect(signals.trace.denials[0]).toMatchObject({ tool: "Bash", detail: "[redacted: githubToken]", count: 2 });
    expect(JSON.stringify(signals)).not.toContain(tokA.slice(0, 12));
  });

  it("splits denials (PermissionDenied only) from unmatched (Pre/Post gaps), excluding Agent/AskUserQuestion/Skill and the file's last line, skills invoked, and InstructionsLoaded grouped with its reasons", () => {
    const dir = tempProject();
    writeTrace(dir, "s1.jsonl", [
      // a denied Bash call: PreToolUse and PermissionDenied share toolUseId t1 - counted once, in denials.
      { event: "PreToolUse", session: "s1", tool: "Bash", toolUseId: "t1", detail: "git branch -D foo" },
      { event: "PermissionDenied", session: "s1", tool: "Bash", toolUseId: "t1", detail: "git branch -D foo", reason: "auto mode denied" },
      // a second PermissionDenied of the same (tool, detail), a different toolUseId - bumps denials to 2.
      { event: "PermissionDenied", session: "s1", tool: "Bash", toolUseId: "t1b", detail: "git branch -D foo", reason: null },
      // an ordinary unmatched PreToolUse with no PermissionDenied anywhere for it - unmatched, never denials.
      { event: "PreToolUse", session: "s1", tool: "Bash", toolUseId: "gap1", detail: "rm secrets.yaml" },
      { event: "PreToolUse", session: "s1", tool: "Agent", toolUseId: "agentcall", detail: "coder" }, // excluded tool
      { event: "PreToolUse", session: "s1", tool: "Skill", toolUseId: "sk1", detail: "doug-board" },
      { event: "PostToolUse", session: "s1", tool: "Skill", toolUseId: "sk1", detail: "doug-board" },
      { event: "PreToolUse", session: "s1", tool: "Skill", toolUseId: "sk2", detail: "doug-board" },
      { event: "InstructionsLoaded", session: "s1", detail: "CLAUDE.md", reason: "session_start" },
      { event: "InstructionsLoaded", session: "s1", detail: "CLAUDE.md", reason: "path_glob_match" },
      { event: "PreToolUse", session: "s1", tool: "Bash", toolUseId: "inflight", detail: "pnpm test" }, // last line: in flight
    ]);
    const m = openMemory(dir);
    const signals = collectSignals(m, { dir });
    m.close();
    expect(signals.trace.files).toEqual(["s1.jsonl"]);
    const branchDeny = signals.trace.denials.find((d) => d.detail === "git branch -D foo");
    expect(branchDeny).toMatchObject({ tool: "Bash", count: 2, reason: "auto mode denied" });
    // the denied call's own PreToolUse gap is dedupe'd away - never double-counted as unmatched too (MAJOR 1).
    expect(signals.trace.unmatched.find((d) => d.detail === "git branch -D foo")).toBeUndefined();
    const gapUnmatched = signals.trace.unmatched.find((d) => d.detail === "rm secrets.yaml");
    expect(gapUnmatched).toEqual({ tool: "Bash", detail: "rm secrets.yaml", count: 1 }); // no `reason` field
    expect(signals.trace.denials.find((d) => d.detail === "rm secrets.yaml")).toBeUndefined(); // never in denials
    expect(signals.trace.denials.find((d) => d.detail === "pnpm test")).toBeUndefined(); // last line, in flight
    expect(signals.trace.unmatched.find((d) => d.detail === "pnpm test")).toBeUndefined();
    expect(signals.trace.unmatched.find((d) => d.tool === "Agent")).toBeUndefined();
    expect(signals.trace.unmatched.find((d) => d.tool === "Skill")).toBeUndefined();
    expect(signals.trace.skills).toEqual([{ skill: "doug-board", count: 2 }]);
    expect(signals.trace.instructionsLoaded).toEqual([{ file: "CLAUDE.md", count: 2, reasons: ["path_glob_match", "session_start"] }]);
  });

  // review round 2, MAJOR 1: a denied call emitted both a PreToolUse line with no PostToolUse and a
  // PermissionDenied line, same toolUseId; both branches used to bump the same (tool, detail) key, so one
  // denial read as 2 and tripped `demote`'s count>=2 threshold on a single denial.
  it("MAJOR 1: a denied call's matching PreToolUse gap is not double-counted - one denial reads as count 1, and demote never fires on it alone", () => {
    const dir = tempProject();
    writeTrace(dir, "s2.jsonl", [
      { event: "PreToolUse", session: "s2", tool: "Bash", toolUseId: "d1", detail: "git branch -D only-once" },
      { event: "PermissionDenied", session: "s2", tool: "Bash", toolUseId: "d1", detail: "git branch -D only-once", reason: "auto mode denied" },
      { event: "PreToolUse", session: "s2", tool: "Read", toolUseId: "d2", detail: "x.ts" },
      { event: "PostToolUse", session: "s2", tool: "Read", toolUseId: "d2", detail: "x.ts", ok: true },
    ]);
    const m = openMemory(dir);
    const signals = collectSignals(m, { dir });
    m.close();
    const deny = signals.trace.denials.find((d) => d.detail === "git branch -D only-once");
    expect(deny).toMatchObject({ count: 1 });
    expect(signals.trace.unmatched.find((d) => d.detail === "git branch -D only-once")).toBeUndefined();
    const proposals = proposeChanges(signals, { dir, claudeMd: CLAUDE_MD, config: {}, skills: [] });
    expect(proposals.filter((p) => p.kind === "demote")).toEqual([]); // count 1 < demote's threshold of 2
  });

  it("returns zeroed signals with no outcomes, lessons, or trace files - never an error", () => {
    const dir = tempProject();
    const m = openMemory(dir);
    const signals = collectSignals(m, { dir });
    m.close();
    expect(signals.outcomes.rows).toEqual([]);
    expect(signals.outcomes.gateFailures).toBe(0);
    expect(signals.lessons.total).toBe(0);
    expect(signals.lessons.pitfalls).toEqual([]);
    expect(signals.trace.files).toEqual([]);
    expect(signals.trace.denials).toEqual([]);
    expect(signals.trace.unmatched).toEqual([]);
  });
});

// --- proposeChanges ------------------------------------------------------------------------------------------

describe("proposeChanges", () => {
  it("promote: at threshold with no files proposes a CLAUDE.md Gotchas promote (diff null at 60 lines), never an unscoped rule", () => {
    const header = ["# Project", "", "## Gotchas", ""];
    const at59 = `${[...header, ...Array.from({ length: 59 - header.length }, (_, i) => `- filler ${i}`)].join("\n")}\n`;
    const signals = pitfallSignals([pit({ files: [] })]);
    const [p, ...rest] = proposeChanges(signals, { dir: "/nope", claudeMd: at59, config: {}, skills: [] });
    expect(rest).toEqual([]);
    expect(p).toMatchObject({ kind: "promote", target: "CLAUDE.md", diff: null });
    expect(p.reason).toContain("60-line limit");

    const roomy = proposeChanges(signals, { dir: "/nope", claudeMd: CLAUDE_MD, config: {}, skills: [] });
    expect(roomy).toHaveLength(1);
    expect(roomy[0]).toMatchObject({ kind: "promote", target: "CLAUDE.md" });
    expect(roomy[0].diff).toContain("+- Never edit dist/ by hand.");
    expect(roomy.filter((x) => x.kind === "rule")).toEqual([]);

    const already = proposeChanges(pitfallSignals([pit({ files: [], text: "Task worktrees live under .claude/worktrees/ (gitignored)." })]), { dir: "/nope", claudeMd: CLAUDE_MD, config: {}, skills: [] });
    expect(already).toEqual([]);
  });

  it("exports the thresholds: 3 cards over 2 sessions", () => {
    expect(RULE_MIN_CARDS).toBe(3);
    expect(RULE_MIN_SESSIONS).toBe(2);
  });

  it("two cards over two sessions propose nothing; three cards over two sessions propose a rule", () => {
    const opts = { dir: "/nope", claudeMd: CLAUDE_MD, config: {}, skills: [] };
    expect(proposeChanges(pitfallSignals([pit({ cards: ["a", "b"], sessions: ["s1", "s2"] })]), opts)).toEqual([]);
    const three = proposeChanges(pitfallSignals([pit({ cards: ["a", "b", "c"], sessions: ["s1", "s2"] })]), opts);
    expect(three).toHaveLength(1);
    expect(three[0]).toMatchObject({ kind: "rule", target: ".claude/rules/pitfall-pit1.md" });
  });

  it("three cards in one session propose nothing, and a null session never counts as a second one", () => {
    const opts = { dir: "/nope", claudeMd: CLAUDE_MD, config: {}, skills: [] };
    expect(proposeChanges(pitfallSignals([pit({ cards: ["a", "b", "c"], sessions: ["s1"] })]), opts)).toEqual([]);
    const dir = tempProject();
    const m = openMemory(dir);
    const L = addLesson(m, { text: "Never edit dist/ by hand.", kind: "pitfall", source: { agent: "reflect" }, citation: "history:a/r1:2" });
    for (const [card, session] of [["a", "s1"], ["b", null], ["c", null]]) {
      recordPitfallOccurrence(dir, { lesson: L.id, citation: `history:${card}/r1:2`, card, run: "r1", session, at: "2026-10-20T00:00:00.000Z" });
      writeHistoryReport(dir, card, { outcome: "stopped", worktree: `/wt/${card}`, filesChanged: [`/wt/${card}/src/x.mjs`] });
    }
    const signals = collectSignals(m, { dir });
    m.close();
    expect(signals.lessons.pitfalls.find((x) => x.id === L.id).sessions).toEqual(["s1"]);
    expect(proposeChanges(signals, { dir, claudeMd: CLAUDE_MD, config: {}, skills: [] })).toEqual([]);
  });

  it("three occurrences on one card over two sessions propose nothing", () => {
    const dir = tempProject();
    const m = openMemory(dir);
    const L = addLesson(m, { text: "Never edit dist/ by hand.", kind: "pitfall", source: { agent: "reflect" }, citation: "history:a/r1:2" });
    for (const [n, session] of [[1, "s1"], [2, "s2"], [3, "s1"]]) {
      recordPitfallOccurrence(dir, { lesson: L.id, citation: `history:a/r${n}:2`, card: "a", run: `r${n}`, session, at: "2026-10-20T00:00:00.000Z" });
    }
    writeHistoryReport(dir, "a", { outcome: "stopped", worktree: "/wt/a", filesChanged: ["/wt/a/src/x.mjs"] });
    const signals = collectSignals(m, { dir });
    m.close();
    expect(signals.lessons.pitfalls.find((x) => x.id === L.id)).toMatchObject({ cards: ["a"], sessions: ["s1", "s2"] });
    expect(proposeChanges(signals, { dir, claudeMd: CLAUDE_MD, config: {}, skills: [] })).toEqual([]);
  });

  it("the rule targets .claude/rules/pitfall-<id>.md with paths: the cards' repo-relative files, an outside absolute path dropped", () => {
    const dir = tempProject();
    const m = openMemory(dir);
    const L = addLesson(m, { text: "Never edit dist/ by hand.", kind: "pitfall", source: { agent: "reflect" }, citation: "history:a/r1:2" });
    const cits = [];
    for (const [card, session] of [["a", "s1"], ["b", "s1"], ["c", "s2"]]) {
      const citation = `history:${card}/r1:2`;
      cits.push(citation);
      recordPitfallOccurrence(dir, { lesson: L.id, citation, card, run: "r1", session, at: "2026-10-20T00:00:00.000Z" });
    }
    writeHistoryReport(dir, "a", { outcome: "stopped", worktree: "/wt/a", filesChanged: ["/wt/a/plugins/doug-flow/lib/x.mjs", "/outside/z.mjs", "/wt/a/../etc/passwd"] });
    writeHistoryReport(dir, "b", { outcome: "stopped", worktree: "/wt/b", filesChanged: ["/wt/b/plugins/doug-flow/lib/x.mjs", "docs/r.md"] });
    writeHistoryReport(dir, "c", { outcome: "done", worktree: "/wt/c", filesChanged: ["/wt/c/packages/doug-cli/y.mjs"] });
    const signals = collectSignals(m, { dir });
    m.close();
    const sig = signals.lessons.pitfalls.find((x) => x.id === L.id);
    expect(sig.cards).toEqual(["a", "b", "c"]);
    expect(sig.sessions).toEqual(["s1", "s2"]);
    expect(sig.files).toEqual(["docs/r.md", "packages/doug-cli/y.mjs", "plugins/doug-flow/lib/x.mjs"]);
    const proposals = proposeChanges(signals, { dir, claudeMd: CLAUDE_MD, config: {}, skills: [] });
    expect(proposals).toHaveLength(1);
    const [p] = proposals;
    expect(p).toMatchObject({ kind: "rule", target: `.claude/rules/pitfall-${L.id}.md` });
    expect(p.evidence).toMatchObject({ id: L.id, cards: ["a", "b", "c"], sessions: ["s1", "s2"], files: sig.files });
    expect(p.diff).toContain("paths:");
    expect(p.diff).toContain('+  - "plugins/doug-flow/lib/x.mjs"');
    expect(p.diff).toContain('+  - "packages/doug-cli/y.mjs"');
    expect(p.diff).not.toContain("/wt/");
    expect(p.diff).not.toContain("/outside");
    expect(p.diff).not.toContain("passwd");
    expect(p.diff).toContain("+Never edit dist/ by hand.");
    expect(p.diff).toContain("Evidence:");
    for (const c of cits) expect(p.diff).toContain(`+- ${c}`);
  });

  it("a rule already on disk is diffed from its current content", () => {
    const dir = tempProject();
    mkdirSync(join(dir, ".claude/rules"), { recursive: true });
    writeFileSync(join(dir, ".claude/rules/pitfall-pit1.md"), "old rule body\n");
    const [p] = proposeChanges(pitfallSignals([pit({ files: ["src/a.mjs"] })]), { dir, claudeMd: CLAUDE_MD, config: {}, skills: [] });
    expect(p.kind).toBe("rule");
    expect(p.diff).toContain("-old rule body");
  });

  it("demote: a Bash denial repeated >=2x matching a known CLAUDE.md rule proposes enabling its config key, refuses when already enabled, and skips a denial matching no rule", () => {
    const signals = {
      outcomes: { rows: [] },
      lessons: { pitfalls: [] },
      trace: { files: [], skills: [], denials: [{ tool: "Bash", detail: "git branch -D some-branch", reason: null, count: 3 }] },
    };
    const [p] = proposeChanges(signals, { dir: "/nope", claudeMd: CLAUDE_MD, config: {}, skills: [] });
    expect(p).toMatchObject({ kind: "demote", target: ".doug/config.json" });
    expect(p.diff).toContain('"denyDestructive": true');
    expect(p.reason).toContain("protected path");

    const already = proposeChanges(signals, { dir: "/nope", claudeMd: CLAUDE_MD, config: { bash: { denyDestructive: true } }, skills: [] });
    expect(already.filter((x) => x.kind === "demote")).toEqual([]);

    const onceOnly = proposeChanges(
      { ...signals, trace: { ...signals.trace, denials: [{ tool: "Bash", detail: "git branch -D x", reason: null, count: 1 }] } },
      { dir: "/nope", claudeMd: CLAUDE_MD, config: {}, skills: [] }
    );
    expect(onceOnly.filter((x) => x.kind === "demote")).toEqual([]);

    const noRuleMatch = proposeChanges(
      { ...signals, trace: { ...signals.trace, denials: [{ tool: "Bash", detail: "ls -la /tmp", reason: null, count: 5 }] } },
      { dir: "/nope", claudeMd: CLAUDE_MD, config: {}, skills: [] }
    );
    expect(noRuleMatch.filter((x) => x.kind === "demote")).toEqual([]);
  });

  it("delete: a CLAUDE.md rule line referenced by no denial, lesson, or block, with enough signal density, proposes removing it; stays silent below the density floor or when referenced", () => {
    const manyRows = Array.from({ length: 10 }, (_, i) => ({ card: `c${i}`, blocks: [] }));
    const manyFiles = Array.from({ length: 5 }, (_, i) => `s${i}.jsonl`);
    const unreferenced = { outcomes: { rows: manyRows }, lessons: { pitfalls: [] }, trace: { files: manyFiles, skills: [], denials: [] } };
    const proposals = proposeChanges(unreferenced, { dir: "/nope", claudeMd: CLAUDE_MD, config: {}, skills: [] });
    const deletes = proposals.filter((p) => p.kind === "delete");
    expect(deletes.length).toBe(3); // all three CLAUDE_MD bullets are unreferenced by this fixture's signals
    expect(deletes.some((p) => p.diff && p.diff.includes("-- Task worktrees live under .claude/worktrees/ (gitignored)."))).toBe(true);

    const belowFloor = proposeChanges({ ...unreferenced, outcomes: { rows: manyRows.slice(0, 3) } }, { dir: "/nope", claudeMd: CLAUDE_MD, config: {}, skills: [] });
    expect(belowFloor.filter((p) => p.kind === "delete")).toEqual([]);

    const referenced = {
      outcomes: { rows: manyRows },
      lessons: { pitfalls: [] },
      trace: { files: manyFiles, skills: [], denials: [{ tool: "Bash", detail: "git branch -D x", reason: null, count: 1 }] },
    };
    const withReference = proposeChanges(referenced, { dir: "/nope", claudeMd: CLAUDE_MD, config: {}, skills: [] });
    expect(withReference.filter((p) => p.kind === "delete" && p.target === "CLAUDE.md" && /branch -D/.test(p.reason))).toEqual([]);
  });

  it("tighten: a never-invoked skill with a long description proposes surfacing it (diff:null) only while another skill was busy; a short description or any invocation proposes nothing", () => {
    const busySignals = { outcomes: { rows: [] }, lessons: { pitfalls: [] }, trace: { files: [], denials: [], skills: [{ skill: "doug-next", count: 9 }] } };
    const longDescription = "x".repeat(401);
    const proposals = proposeChanges(busySignals, { dir: "/nope", claudeMd: CLAUDE_MD, config: {}, skills: [{ name: "quiet-skill", description: longDescription }] });
    expect(proposals).toEqual([{ id: "01", kind: "tighten", target: "skills/quiet-skill/SKILL.md", reason: expect.stringContaining("invoked 0 times"), evidence: expect.objectContaining({ descriptionLength: 401 }), diff: null }]);

    const shortDescription = proposeChanges(busySignals, { dir: "/nope", claudeMd: CLAUDE_MD, config: {}, skills: [{ name: "quiet-skill", description: "short" }] });
    expect(shortDescription).toEqual([]);

    const invokedSignals = { ...busySignals, trace: { ...busySignals.trace, skills: [{ skill: "doug-next", count: 9 }, { skill: "quiet-skill", count: 1 }] } };
    const invoked = proposeChanges(invokedSignals, { dir: "/nope", claudeMd: CLAUDE_MD, config: {}, skills: [{ name: "quiet-skill", description: longDescription }] });
    expect(invoked).toEqual([]);

    const noBusySkill = { outcomes: { rows: [] }, lessons: { pitfalls: [] }, trace: { files: [], denials: [], skills: [] } };
    const nobusy = proposeChanges(noBusySkill, { dir: "/nope", claudeMd: CLAUDE_MD, config: {}, skills: [{ name: "quiet-skill", description: longDescription }] });
    expect(nobusy).toEqual([]);
  });

  // review round 2, MINOR 7: target used to be hardcoded plugins/doug-flow/skills/<name>/SKILL.md regardless of
  // where readOwnSkills actually read the skill from.
  it("MINOR 7: tighten's target is the real path the skill was read from (skill.file), relative to dir when inside it, absolute otherwise, and the historical hardcoded guess only when no file is given at all", () => {
    const busySignals = { outcomes: { rows: [] }, lessons: { pitfalls: [] }, trace: { files: [], denials: [], unmatched: [], skills: [{ skill: "doug-next", count: 9 }] } };
    const longDescription = "x".repeat(401);
    const dir = "/project/root";

    const inside = proposeChanges(busySignals, { dir, claudeMd: CLAUDE_MD, config: {}, skills: [{ name: "quiet-skill", description: longDescription, file: "/project/root/plugins/custom/skills/quiet-skill/SKILL.md" }] });
    expect(inside[0].target).toBe("plugins/custom/skills/quiet-skill/SKILL.md");

    const outside = proposeChanges(busySignals, { dir, claudeMd: CLAUDE_MD, config: {}, skills: [{ name: "quiet-skill", description: longDescription, file: "/elsewhere/skills/quiet-skill/SKILL.md" }] });
    expect(outside[0].target).toBe("/elsewhere/skills/quiet-skill/SKILL.md");

    const noFile = proposeChanges(busySignals, { dir, claudeMd: CLAUDE_MD, config: {}, skills: [{ name: "quiet-skill", description: longDescription }] });
    expect(noFile[0].target).toBe("skills/quiet-skill/SKILL.md");
  });

  it("returns [] with no signals at all", () => {
    const empty = { outcomes: { rows: [] }, lessons: { pitfalls: [] }, trace: { files: [], denials: [], skills: [] } };
    expect(proposeChanges(empty, { dir: "/nope", claudeMd: CLAUDE_MD, config: {}, skills: [] })).toEqual([]);
  });
});

// --- writeProposals / applyProposal --------------------------------------------------------------------------

describe("writeProposals", () => {
  it("writes proposals.json and one NN-<kind>.diff per proposal that carries a diff, only under .doug/.state/learn, and never touches a tracked file (git status --porcelain unchanged)", () => {
    const dir = tempProject();
    const before = execFileSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8" });
    const proposals = [
      { id: "01", kind: "promote", target: "CLAUDE.md", reason: "r1", evidence: {}, diff: unifiedDiff("CLAUDE.md", "a\n", "a\nb\n") },
      { id: "02", kind: "tighten", target: "plugins/doug-flow/skills/x/SKILL.md", reason: "r2", evidence: {}, diff: null },
    ];
    const now = new Date("2026-09-11T19:05:07.123Z");
    const written = writeProposals(proposals, { dir, now });
    // review round 2, MINOR 5: millisecond resolution (was second resolution).
    expect(written.dir).toBe(join(dir, ".doug/.state/learn/2026-09-11T190507123"));
    expect(existsSync(written.proposalsPath)).toBe(true);
    expect(JSON.parse(readFileSync(written.proposalsPath, "utf8"))).toEqual(proposals);
    expect(written.diffPaths.length).toBe(1);
    expect(readdirSync(written.dir).sort()).toEqual(["01-promote.diff", "proposals.json"]);
    const after = execFileSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8" });
    expect(after).toBe(before); // .doug/.state is gitignored/untracked either way, but nothing tracked moved
  });

  // review round 2, MINOR 5: two runs landing in the same millisecond used to collide (and, before that fix,
  // the same second) and overwrite each other's proposals.
  it("MINOR 5: appends -2, -3 when the timestamped folder already exists, instead of colliding", () => {
    const dir = tempProject();
    const now = new Date("2026-09-11T19:05:07.123Z");
    const proposals = [{ id: "01", kind: "promote", target: "CLAUDE.md", reason: "r", evidence: {}, diff: unifiedDiff("CLAUDE.md", "a\n", "a\nb\n") }];
    const first = writeProposals(proposals, { dir, now });
    const second = writeProposals(proposals, { dir, now });
    const third = writeProposals(proposals, { dir, now });
    expect(first.dir).toBe(join(dir, ".doug/.state/learn/2026-09-11T190507123"));
    expect(second.dir).toBe(join(dir, ".doug/.state/learn/2026-09-11T190507123-2"));
    expect(third.dir).toBe(join(dir, ".doug/.state/learn/2026-09-11T190507123-3"));
    expect(existsSync(first.proposalsPath)).toBe(true);
    expect(existsSync(second.proposalsPath)).toBe(true);
    expect(existsSync(third.proposalsPath)).toBe(true);
  });
});

describe("applyProposal", () => {
  it("refuses a target under .doug/config.json's protectedPaths without touching the tree", () => {
    const dir = tempProject({ config: { protectedPaths: [".doug/config.json"] } });
    const diff = unifiedDiff(".doug/config.json", `${JSON.stringify(readConfig(dir), null, 2)}\n`, `${JSON.stringify({ ...readConfig(dir), bash: { denyDestructive: true } }, null, 2)}\n`);
    const file = learnDiffPath(dir, "proposal.diff");
    writeFileSync(file, diff);
    const before = readFileSync(join(dir, ".doug/config.json"), "utf8");
    const result = applyProposal(file, { dir });
    expect(result).toEqual({ ok: false, reason: expect.stringContaining("protected path") });
    expect(readFileSync(join(dir, ".doug/config.json"), "utf8")).toBe(before);
  });

  it("applies a CLAUDE.md promote diff for real, and refuses a diff that no longer applies cleanly", () => {
    const dir = tempProject();
    const updated = CLAUDE_MD.replace("- Task worktrees live under .claude/worktrees/ (gitignored).\n", "- Task worktrees live under .claude/worktrees/ (gitignored).\n- Never edit dist/ by hand.\n");
    const diff = unifiedDiff("CLAUDE.md", CLAUDE_MD, updated);
    const file = learnDiffPath(dir, "proposal.diff");
    writeFileSync(file, diff);
    const result = applyProposal(file, { dir });
    expect(result).toEqual({ ok: true, target: "CLAUDE.md" });
    expect(readFileSync(join(dir, "CLAUDE.md"), "utf8")).toBe(updated);
    expect(execFileSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8" })).toContain("CLAUDE.md");

    // applying the same diff again fails: the file no longer matches the diff's "before" context
    const second = applyProposal(file, { dir });
    expect(second.ok).toBe(false);
    expect(second.reason).toContain("git apply");
  });

  // card proposal-ledger-forgeable: applyProposal refuses a diff file that does not resolve under
  // dir/.doug/.state/learn, before it even looks at the diff's own target(s), and writes no ledger line.
  it("refuses a diff file that does not live under .doug/.state/learn, and writes no ledger line", () => {
    const dir = tempProject();
    const diff = unifiedDiff("CLAUDE.md", CLAUDE_MD, `${CLAUDE_MD}- extra\n`);
    const file = join(dir, "proposal.diff"); // at the project root, not under .doug/.state/learn
    writeFileSync(file, diff);
    const result = applyProposal(file, { dir });
    expect(result).toEqual({ ok: false, reason: expect.stringContaining(LEARN_STATE_RELPATH) });
    expect(readFileSync(join(dir, "CLAUDE.md"), "utf8")).toBe(CLAUDE_MD);
    expect(existsSync(join(dir, PROPOSAL_LEDGER_RELPATH))).toBe(false);
  });

  // card proposal-ledger-forgeable: the ledger line now also carries diffSha256 (the diff file's own sha256)
  // and a `proposal` path relative to `dir`, so plugins/doug-gates/lib/proposals.mjs can re-derive the target's
  // content from the diff rather than trust a bare sha256.
  it("appends one ledger line (target, sha256, diffSha256, at, proposal) per successful apply, and none for a refused one", () => {
    const dir = tempProject();
    expect(existsSync(join(dir, PROPOSAL_LEDGER_RELPATH))).toBe(false);

    // A refused apply (protected path) writes no ledger line at all.
    const protectedDiff = unifiedDiff(".doug/config.json", `${JSON.stringify(readConfig(dir), null, 2)}\n`, `${JSON.stringify({ ...readConfig(dir), bash: { denyDestructive: true } }, null, 2)}\n`);
    const protectedFile = learnDiffPath(dir, "protected.diff");
    writeFileSync(protectedFile, protectedDiff);
    expect(applyProposal(protectedFile, { dir }).ok).toBe(false);
    expect(existsSync(join(dir, PROPOSAL_LEDGER_RELPATH))).toBe(false);

    const updated = `${CLAUDE_MD}- Never edit dist/ by hand.\n`;
    const diff = unifiedDiff("CLAUDE.md", CLAUDE_MD, updated);
    const file = learnDiffPath(dir, "proposal.diff");
    writeFileSync(file, diff);
    const result = applyProposal(file, { dir });
    expect(result).toEqual({ ok: true, target: "CLAUDE.md" });

    const ledger = readAppliedLedger(dir);
    expect(ledger.length).toBe(1);
    const expectedSha = createHash("sha256").update(readFileSync(join(dir, "CLAUDE.md"))).digest("hex");
    const expectedDiffSha = createHash("sha256").update(readFileSync(file)).digest("hex");
    const expectedProposalRel = "" + [".doug", ".state", "learn", "fixtures", "proposal.diff"].join("/");
    expect(ledger[0]).toMatchObject({ target: "CLAUDE.md", sha256: expectedSha, diffSha256: expectedDiffSha, proposal: expectedProposalRel });
    expect(typeof ledger[0].at).toBe("string");

    // A second, real proposal (a rule file) appends a second line rather than replacing the first.
    const ruleDiff = unifiedDiff(".claude/rules/tests.md", "", "Write tests first.\n");
    const ruleFile = learnDiffPath(dir, "rule.diff");
    writeFileSync(ruleFile, ruleDiff);
    expect(applyProposal(ruleFile, { dir })).toEqual({ ok: true, target: ".claude/rules/tests.md" });
    expect(readAppliedLedger(dir).length).toBe(2);
  });

  // readAppliedLedger is tolerant of a missing file and a torn/bad line - never fatal.
  it("readAppliedLedger returns [] for a missing ledger and skips a torn line", () => {
    const dir = mkdtempSync(join(tmpdir(), "doug-ledger-"));
    expect(readAppliedLedger(dir)).toEqual([]);
    mkdirSync(join(dir, ".doug/.state/proposals"), { recursive: true });
    writeFileSync(join(dir, PROPOSAL_LEDGER_RELPATH), `${JSON.stringify({ target: "a", sha256: "x", diffSha256: "y", at: "now", proposal: "p" })}\nnot json\n\n`);
    expect(readAppliedLedger(dir)).toEqual([{ target: "a", sha256: "x", diffSha256: "y", at: "now", proposal: "p" }]);
  });

  it("uses an injectable `run` instead of spawning git, for a caller that wants to fake the git call", () => {
    const dir = tempProject();
    const diff = unifiedDiff("CLAUDE.md", CLAUDE_MD, `${CLAUDE_MD}- extra\n`);
    const file = learnDiffPath(dir, "proposal.diff");
    writeFileSync(file, diff);
    const calls = [];
    const fakeRun = (args) => {
      calls.push(args);
      return { status: 0, stdout: "", stderr: "" };
    };
    const result = applyProposal(file, { dir, run: fakeRun });
    expect(result).toEqual({ ok: true, target: "CLAUDE.md" });
    expect(calls).toEqual([["apply", "--check", file], ["apply", file]]);
    // the fake never actually wrote anything
    expect(readFileSync(join(dir, "CLAUDE.md"), "utf8")).toBe(CLAUDE_MD);
  });

  // review MINOR 5: `file` is resolved against `dir`, not against the calling process's cwd (which here is
  // wherever vitest runs from - not `dir` - so this exercises exactly that gap). A relative path used to be
  // handed straight to readFileSync, which resolves against process.cwd() and threw ENOENT for a path that is
  // only valid relative to `dir`.
  it("MINOR 5: resolves a dir-relative `file` against `dir`, not against the calling process's cwd", () => {
    const dir = tempProject();
    const relFile = join(LEARN_STATE_RELPATH, "fixtures", "proposal.diff");
    mkdirSync(dirname(join(dir, relFile)), { recursive: true });
    const diff = unifiedDiff("CLAUDE.md", CLAUDE_MD, `${CLAUDE_MD}- extra\n`);
    writeFileSync(join(dir, relFile), diff);
    expect(dir).not.toBe(process.cwd()); // the fixture dir is never the test runner's cwd
    const result = applyProposal(relFile, { dir });
    expect(result).toEqual({ ok: true, target: "CLAUDE.md" });
    expect(readFileSync(join(dir, "CLAUDE.md"), "utf8")).toBe(`${CLAUDE_MD}- extra\n`);
    const ledger = readAppliedLedger(dir);
    expect(ledger.length).toBe(1);
    expect(ledger[0].proposal).toBe(relFile.split(sep).join("/"));
  });

  // review round 2, MINOR 2: applyProposal inspected only the first "+++ b/" header, so a hand-built two-file
  // diff wrote its second section straight into the protected .doug/config.json.
  it("MINOR 2: refuses a diff that touches more than one file outright, before checking either target, and neither file is touched", () => {
    const dir = tempProject();
    const claudeDiff = unifiedDiff("CLAUDE.md", CLAUDE_MD, `${CLAUDE_MD}- extra\n`);
    const configBefore = readFileSync(join(dir, ".doug/config.json"), "utf8");
    const configAfter = `${JSON.stringify({ ...readConfig(dir), bash: { denyDestructive: true } }, null, 2)}\n`;
    const configDiff = unifiedDiff(".doug/config.json", configBefore, configAfter);
    const twoFileDiff = claudeDiff + configDiff;
    const file = learnDiffPath(dir, "two-file.diff");
    writeFileSync(file, twoFileDiff);

    const result = applyProposal(file, { dir });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("more than one file");
    expect(result.reason).toContain("CLAUDE.md");
    expect(result.reason).toContain(".doug/config.json");
    expect(readFileSync(join(dir, ".doug/config.json"), "utf8")).toBe(configBefore);
    expect(readFileSync(join(dir, "CLAUDE.md"), "utf8")).toBe(CLAUDE_MD);
  });

  it("MINOR 2: refuses a target that resolves outside the repository", () => {
    const dir = tempProject();
    const outsideDiff = "--- a/../outside.txt\n+++ b/../outside.txt\n@@ -1 +1 @@\n-old\n+new\n";
    const file = learnDiffPath(dir, "outside.diff");
    writeFileSync(file, outsideDiff);
    const result = applyProposal(file, { dir });
    expect(result).toEqual({ ok: false, reason: expect.stringContaining("outside the repository") });
  });
});

// --- CLI ---------------------------------------------------------------------------------------------------

// A pitfall cited by three cards over two sessions, with no history files: the occurrence-ledger form of "repeated"
// (card memory-failure-lessons dropped the helpful and Jaccard triggers).
function seedRepeatedPitfall(dir, m) {
  const L = addLesson(m, { text: "Never edit dist/ by hand.", kind: "pitfall", source: { agent: "lead" } });
  for (const [card, session] of [["a", "s1"], ["b", "s1"], ["c", "s2"]]) {
    recordPitfallOccurrence(dir, { lesson: L.id, citation: `history:${card}/r1:2`, card, run: "r1", session, at: "2026-10-20T00:00:00.000Z" });
  }
}

describe("learn.mjs CLI", () => {
  const run = (args, cwd) => spawnSync(process.execPath, [script, ...args], { cwd, encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: "" } });

  it("exits 2 on a missing subcommand, an unknown flag, and apply with no file", () => {
    expect(run([]).status).toBe(2);
    expect(run(["--bogus"]).status).toBe(2);
    expect(run(["apply"]).status).toBe(2);
    expect(run(["nope"]).status).toBe(2);
  });

  it("signals prints counts-only text by default and full JSON with --json, and exits 0 with no store yet", () => {
    const dir = tempProject();
    const text = run(["signals", dir], dir);
    expect(text.status).toBe(0);
    expect(text.stdout).toContain("outcomes:");
    expect(text.stdout).toContain("lessons:");
    expect(text.stdout).toContain("trace:");
    expect(text.stdout).toContain("denials");
    expect(text.stdout).toContain("unmatched"); // review round 2, MINOR 1: reported separately, printed by signals
    const json = run(["signals", dir, "--json"], dir);
    expect(json.status).toBe(0);
    expect(JSON.parse(json.stdout).outcomes.rows).toEqual([]);
  });

  it("propose prints \"no proposals\" and exits 0 when there is nothing to propose, and writes nothing under .doug/.state/learn", () => {
    const dir = tempProject();
    const before = existsSync(join(dir, ".doug/.state/learn"));
    const r = run(["propose", dir], dir);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("no proposals");
    expect(existsSync(join(dir, ".doug/.state/learn"))).toBe(before);
  });

  it("propose never touches a tracked file - git status --porcelain is unchanged after a real run that produces proposals (the never-auto-apply guarantee)", () => {
    const dir = tempProject();
    const m = openMemory(dir);
    seedRepeatedPitfall(dir, m);
    m.close();
    const before = execFileSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8" });
    const r = run(["propose", dir], dir);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("promote CLAUDE.md:");
    const after = execFileSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8" });
    expect(after).toBe(before);
  });

  it("propose writes proposals and prints one line per proposal; apply then applies one by path and exits 1 with the reason when refused", () => {
    const dir = tempProject();
    const m = openMemory(dir);
    seedRepeatedPitfall(dir, m);
    m.close();

    const propose = run(["propose", dir], dir);
    expect(propose.status).toBe(0);
    const [firstLine] = propose.stdout.trim().split("\n");
    expect(firstLine).toMatch(/^01 promote CLAUDE\.md: /);
    const writtenDirLine = propose.stdout.trim().split("\n").pop();
    const writtenDir = writtenDirLine.replace("written to ", "");
    const diffFile = readdirSync(writtenDir).find((f) => f.endsWith(".diff"));

    const apply = run(["apply", join(writtenDir, diffFile), dir], dir);
    expect(apply.status).toBe(0);
    expect(apply.stdout).toContain("applied CLAUDE.md");
    // the cluster's representative text is whichever lesson sorts first by created/id (both near-duplicates of
    // each other), so only the shared substring is asserted here.
    expect(readFileSync(join(dir, "CLAUDE.md"), "utf8")).toContain("Never edit dist/ by hand");

    // apply again: no longer applies cleanly (already applied) -> refused, exit 1
    const again = run(["apply", join(writtenDir, diffFile), dir], dir);
    expect(again.status).toBe(1);
    expect(again.stderr.length).toBeGreaterThan(0);
  });
});

// --- card memory-failure-lessons: pitfall signals count distinct cards and sessions -------------------------------

describe("collectSignals: pitfalls (card memory-failure-lessons)", () => {
  const AT = "2026-10-20T00:00:00.000Z";
  const occ = (dir, lesson, card, session, n = 1) => recordPitfallOccurrence(dir, { lesson, citation: `history:${card}/r${n}:2`, card, run: `r${n}`, session, at: AT });
  const pitfallLesson = (m, text, extra = {}) => addLesson(m, { text, kind: "pitfall", source: { agent: "reflect" }, citation: `history:z/r0:${text.length}`, ...extra });

  it("counts a pitfall's distinct cards (sorted), distinct non-null sessions (sorted) and citations; a repeated occurrence on one card is one card", () => {
    const dir = tempProject();
    const m = openMemory(dir);
    const L = pitfallLesson(m, "Never edit dist/ by hand.");
    occ(dir, L.id, "b", "s2");
    occ(dir, L.id, "a", "s1");
    occ(dir, L.id, "a", "s1", 2);
    occ(dir, L.id, "c", null);
    const signals = collectSignals(m, { dir });
    m.close();
    const sig = signals.lessons.pitfalls.find((x) => x.id === L.id);
    expect(sig).toMatchObject({ id: L.id, text: "Never edit dist/ by hand.", cards: ["a", "b", "c"], sessions: ["s1", "s2"] });
    expect(sig.citations).toHaveLength(4);
    expect(sig.files).toEqual([]);
  });

  it("a lesson with helpful 5 and no occurrences is not a pitfall signal and yields no proposal", () => {
    const dir = tempProject();
    const m = openMemory(dir);
    const L = pitfallLesson(m, "Never edit dist/ by hand.");
    m.prepare("UPDATE lessons SET helpful = 5 WHERE id = ?").run(L.id);
    const signals = collectSignals(m, { dir });
    m.close();
    expect(signals.lessons.pitfalls).toEqual([]);
    expect(proposeChanges(signals, { dir, claudeMd: CLAUDE_MD, config: {}, skills: [] })).toEqual([]);
  });

  it("two near-identical pitfall lessons with no occurrences give no pitfall signal and no proposal", () => {
    const dir = tempProject();
    const m = openMemory(dir);
    pitfallLesson(m, "Always run pnpm typecheck before committing the change to the main branch.");
    pitfallLesson(m, "You must always run pnpm typecheck before committing the change to the main branch.");
    const signals = collectSignals(m, { dir });
    m.close();
    expect(signals.lessons.pitfalls).toEqual([]);
    expect(proposeChanges(signals, { dir, claudeMd: CLAUDE_MD, config: {}, skills: [] })).toEqual([]);
  });

  it("a superseded pitfall with three cards over two sessions gives no signal, and a feedback lesson or an unknown id with occurrences gives none either", () => {
    const dir = tempProject();
    const m = openMemory(dir);
    const old = pitfallLesson(m, "An old pitfall that was superseded long ago.");
    const fresh = pitfallLesson(m, "The replacement pitfall for the old one.");
    supersedeLesson(m, old.id, fresh.id);
    const fb = addLesson(m, { text: "A feedback lesson from the user.", kind: "feedback", source: { agent: "lead" } });
    for (const id of [old.id, fb.id, "lxunknown"]) {
      occ(dir, id, "a", "s1");
      occ(dir, id, "b", "s1");
      occ(dir, id, "c", "s2");
    }
    const signals = collectSignals(m, { dir });
    m.close();
    expect(signals.lessons.pitfalls).toEqual([]);
  });
});

describe("cardFilesTouched (card memory-failure-lessons)", () => {
  it("is the union over the card's history report entries, relative to each report's worktree, dropping outside absolute paths and .. paths, sorted and de-duplicated", () => {
    const dir = tempProject();
    expect(cardFilesTouched(dir, "nope")).toEqual([]);
    writeHistoryReport(dir, "c1", { outcome: "stopped", worktree: "/wt/c1", filesChanged: ["/wt/c1/src/b.mjs", "/wt/c1/src/a.mjs", "/other/x.mjs", "/wt/c1/../y.mjs", "docs/r.md"] }, "wf_1");
    writeHistoryReport(dir, "c1", { outcome: "done", worktree: "/wt/c1b", filesChanged: ["/wt/c1b/src/a.mjs", "../escape.mjs"] }, "wf_2");
    expect(cardFilesTouched(dir, "c1")).toEqual(["docs/r.md", "src/a.mjs", "src/b.mjs"]);
  });

  it("a report with no filesChanged contributes nothing and an unreadable report is skipped", () => {
    const dir = tempProject();
    writeHistoryReport(dir, "c1", { ok: false, plan: "p" }, "wf_1");
    writeRunHistory(dir, { card: "c1", run: "wf_2", entries: [{ kind: "report", source: "x", value: "{ not json" }], scan: () => null });
    expect(cardFilesTouched(dir, "c1")).toEqual([]);
  });
});

describe("renderRule (card memory-failure-lessons)", () => {
  it("renders paths as a quoted frontmatter list and the body, or the body alone with no paths", () => {
    expect(renderRule(["src/**", "*.test.mjs"], "Write tests first.")).toBe('---\npaths:\n  - "src/**"\n  - "*.test.mjs"\n---\n\nWrite tests first.\n');
    expect(renderRule([], "Always do X.")).toBe("Always do X.\n");
  });

  it("proposeRule's created file equals renderRule(paths, body) for the same paths and body", () => {
    const dir = tempProject();
    const withPaths = proposeRule({ dir, name: "tests", paths: ["src/**", "*.test.mjs"], body: "Write tests first.", now: new Date("2026-09-12T00:00:00.000Z") });
    const bare = proposeRule({ dir, name: "general", body: "Always do X.", now: new Date("2026-09-12T00:00:01.000Z") });
    expect(applyProposal(withPaths.diffPath, { dir }).ok).toBe(true);
    expect(applyProposal(bare.diffPath, { dir }).ok).toBe(true);
    expect(readFileSync(join(dir, ".claude/rules/tests.md"), "utf8")).toBe(renderRule(["src/**", "*.test.mjs"], "Write tests first."));
    expect(readFileSync(join(dir, ".claude/rules/general.md"), "utf8")).toBe(renderRule([], "Always do X."));
  });
});

describe("proposeChanges: delete reads pitfalls, not repeated (card memory-failure-lessons)", () => {
  it("a CLAUDE.md line whose key phrase a pitfall's text mentions is not proposed for deletion", () => {
    const manyRows = Array.from({ length: 10 }, (_, i) => ({ card: `c${i}`, blocks: [] }));
    const manyFiles = Array.from({ length: 5 }, (_, i) => `s${i}.jsonl`);
    const base = { outcomes: { rows: manyRows }, lessons: { pitfalls: [] }, trace: { files: manyFiles, skills: [], denials: [] } };
    const opts = { dir: "/nope", claudeMd: CLAUDE_MD, config: {}, skills: [] };
    expect(proposeChanges(base, opts).filter((p) => p.kind === "delete" && /branch -D/.test(p.reason))).not.toEqual([]);
    const withPitfall = { ...base, lessons: { pitfalls: [pit({ cards: ["a"], sessions: ["s1"], text: "never run git branch -D x on a card branch" })] } };
    expect(proposeChanges(withPitfall, opts).filter((p) => p.kind === "delete" && /branch -D/.test(p.reason))).toEqual([]);
  });
});

describe("learn.mjs signals CLI (card memory-failure-lessons)", () => {
  it("prints the lessons line without the dropped repeated signal and exits 0", () => {
    const dir = tempProject();
    const res = spawnSync(process.execPath, [script, "signals", dir], { cwd: dir, encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: "" } });
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toContain("lessons:");
    expect(res.stdout).not.toContain("undefined");
  });
});
