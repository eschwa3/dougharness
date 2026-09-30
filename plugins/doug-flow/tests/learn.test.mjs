import { describe, it, expect } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { openMemory, addLesson, recordOutcomes } from "../lib/memory.mjs";
import { createHash } from "node:crypto";
import { collectSignals, proposeChanges, writeProposals, applyProposal, unifiedDiff, readAppliedLedger, PROPOSAL_LEDGER_RELPATH, LEARN_STATE_RELPATH, readGate } from "../lib/learn.mjs";

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

  it("counts lessons: total/live/helpful/harmful/stale, and groups repeated lessons by near-duplicate text or by helpful>=3", () => {
    const dir = tempProject();
    const m = openMemory(dir);
    const a = addLesson(m, { text: "Always run pnpm typecheck before committing.", kind: "feedback", source: { agent: "lead" } });
    const b = addLesson(m, { text: "You must always run pnpm typecheck before committing changes.", kind: "feedback", source: { agent: "lead" } });
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
    const byIds = signals.lessons.repeated.map((r) => r.ids.sort());
    expect(byIds).toContainEqual([a.id, b.id].sort());
    expect(signals.lessons.repeated.find((r) => r.ids.includes(solo.id))).toMatchObject({ ids: [solo.id], count: 3, kind: "pattern" });
    expect(signals.lessons.repeated.find((r) => r.ids.includes("nope"))).toBeUndefined();
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
    expect(signals.lessons.repeated).toEqual([]);
    expect(signals.trace.files).toEqual([]);
    expect(signals.trace.denials).toEqual([]);
    expect(signals.trace.unmatched).toEqual([]);
  });
});

// --- proposeChanges ------------------------------------------------------------------------------------------

describe("proposeChanges", () => {
  it("promote: a repeated feedback lesson not already in CLAUDE.md becomes a diff under Working agreement; a pitfall lesson goes under Gotchas; a lesson already present proposes nothing", () => {
    const signals = {
      outcomes: { rows: [] },
      lessons: {
        repeated: [
          { text: "Never mix package managers in one install.", ids: ["l1", "l2"], kind: "feedback", count: 2 },
          { text: "Never edit dist/ by hand.", ids: ["l3", "l4"], kind: "pitfall", count: 2 },
          { text: "Task worktrees live under .claude/worktrees/ (gitignored).", ids: ["l5", "l6"], kind: "feedback", count: 2 }, // already in Gotchas verbatim
        ],
      },
      trace: { denials: [], files: [], skills: [] },
    };
    const proposals = proposeChanges(signals, { dir: "/nope", claudeMd: CLAUDE_MD, config: {}, skills: [] });
    const promotes = proposals.filter((p) => p.kind === "promote");
    expect(promotes.length).toBe(2);
    const feedback = promotes.find((p) => p.evidence.ids.includes("l1"));
    expect(feedback.diff).toContain("+- Never mix package managers in one install.");
    expect(feedback.diff).toContain("+++ b/CLAUDE.md");
    const idx = feedback.diff.indexOf("## Gotchas");
    // inserted under Working agreement, so it lands before the Gotchas heading appears in the diff context
    expect(feedback.diff.indexOf("Never mix package managers")).toBeLessThan(idx === -1 ? Infinity : idx);
    const pitfall = promotes.find((p) => p.evidence.ids.includes("l3"));
    expect(pitfall.diff).toContain("+- Never edit dist/ by hand.");
  });

  it("promote: emits diff:null with a reason when the result would be at CLAUDE.md's 60-line limit", () => {
    // Exactly 59 lines (wc -l semantics) so that inserting one bullet brings it to 60.
    const header = ["# Project", "", "## Gotchas", ""];
    const bullets = Array.from({ length: 59 - header.length }, (_, i) => `- filler ${i}`);
    const at59 = `${[...header, ...bullets].join("\n")}\n`;
    expect(at59.split("\n").length - 1).toBe(59);
    const signals = { outcomes: { rows: [] }, lessons: { repeated: [{ text: "A brand new repeated pitfall.", ids: ["l1", "l2"], kind: "pitfall", count: 2 }] }, trace: { denials: [], files: [], skills: [] } };
    const [p] = proposeChanges(signals, { dir: "/nope", claudeMd: at59, config: {}, skills: [] });
    expect(p.kind).toBe("promote");
    expect(p.diff).toBeNull();
    expect(p.reason).toContain("60-line limit");
  });

  it("demote: a Bash denial repeated >=2x matching a known CLAUDE.md rule proposes enabling its config key, refuses when already enabled, and skips a denial matching no rule", () => {
    const signals = {
      outcomes: { rows: [] },
      lessons: { repeated: [] },
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
    const unreferenced = { outcomes: { rows: manyRows }, lessons: { repeated: [] }, trace: { files: manyFiles, skills: [], denials: [] } };
    const proposals = proposeChanges(unreferenced, { dir: "/nope", claudeMd: CLAUDE_MD, config: {}, skills: [] });
    const deletes = proposals.filter((p) => p.kind === "delete");
    expect(deletes.length).toBe(3); // all three CLAUDE_MD bullets are unreferenced by this fixture's signals
    expect(deletes.some((p) => p.diff && p.diff.includes("-- Task worktrees live under .claude/worktrees/ (gitignored)."))).toBe(true);

    const belowFloor = proposeChanges({ ...unreferenced, outcomes: { rows: manyRows.slice(0, 3) } }, { dir: "/nope", claudeMd: CLAUDE_MD, config: {}, skills: [] });
    expect(belowFloor.filter((p) => p.kind === "delete")).toEqual([]);

    const referenced = {
      outcomes: { rows: manyRows },
      lessons: { repeated: [] },
      trace: { files: manyFiles, skills: [], denials: [{ tool: "Bash", detail: "git branch -D x", reason: null, count: 1 }] },
    };
    const withReference = proposeChanges(referenced, { dir: "/nope", claudeMd: CLAUDE_MD, config: {}, skills: [] });
    expect(withReference.filter((p) => p.kind === "delete" && p.target === "CLAUDE.md" && /branch -D/.test(p.reason))).toEqual([]);
  });

  it("tighten: a never-invoked skill with a long description proposes surfacing it (diff:null) only while another skill was busy; a short description or any invocation proposes nothing", () => {
    const busySignals = { outcomes: { rows: [] }, lessons: { repeated: [] }, trace: { files: [], denials: [], skills: [{ skill: "doug-next", count: 9 }] } };
    const longDescription = "x".repeat(401);
    const proposals = proposeChanges(busySignals, { dir: "/nope", claudeMd: CLAUDE_MD, config: {}, skills: [{ name: "quiet-skill", description: longDescription }] });
    expect(proposals).toEqual([{ id: "01", kind: "tighten", target: "plugins/doug-flow/skills/quiet-skill/SKILL.md", reason: expect.stringContaining("invoked 0 times"), evidence: expect.objectContaining({ descriptionLength: 401 }), diff: null }]);

    const shortDescription = proposeChanges(busySignals, { dir: "/nope", claudeMd: CLAUDE_MD, config: {}, skills: [{ name: "quiet-skill", description: "short" }] });
    expect(shortDescription).toEqual([]);

    const invokedSignals = { ...busySignals, trace: { ...busySignals.trace, skills: [{ skill: "doug-next", count: 9 }, { skill: "quiet-skill", count: 1 }] } };
    const invoked = proposeChanges(invokedSignals, { dir: "/nope", claudeMd: CLAUDE_MD, config: {}, skills: [{ name: "quiet-skill", description: longDescription }] });
    expect(invoked).toEqual([]);

    const noBusySkill = { outcomes: { rows: [] }, lessons: { repeated: [] }, trace: { files: [], denials: [], skills: [] } };
    const nobusy = proposeChanges(noBusySkill, { dir: "/nope", claudeMd: CLAUDE_MD, config: {}, skills: [{ name: "quiet-skill", description: longDescription }] });
    expect(nobusy).toEqual([]);
  });

  // review round 2, MINOR 7: target used to be hardcoded plugins/doug-flow/skills/<name>/SKILL.md regardless of
  // where readOwnSkills actually read the skill from.
  it("MINOR 7: tighten's target is the real path the skill was read from (skill.file), relative to dir when inside it, absolute otherwise, and the historical hardcoded guess only when no file is given at all", () => {
    const busySignals = { outcomes: { rows: [] }, lessons: { repeated: [] }, trace: { files: [], denials: [], unmatched: [], skills: [{ skill: "doug-next", count: 9 }] } };
    const longDescription = "x".repeat(401);
    const dir = "/project/root";

    const inside = proposeChanges(busySignals, { dir, claudeMd: CLAUDE_MD, config: {}, skills: [{ name: "quiet-skill", description: longDescription, file: "/project/root/plugins/custom/skills/quiet-skill/SKILL.md" }] });
    expect(inside[0].target).toBe("plugins/custom/skills/quiet-skill/SKILL.md");

    const outside = proposeChanges(busySignals, { dir, claudeMd: CLAUDE_MD, config: {}, skills: [{ name: "quiet-skill", description: longDescription, file: "/elsewhere/skills/quiet-skill/SKILL.md" }] });
    expect(outside[0].target).toBe("/elsewhere/skills/quiet-skill/SKILL.md");

    const noFile = proposeChanges(busySignals, { dir, claudeMd: CLAUDE_MD, config: {}, skills: [{ name: "quiet-skill", description: longDescription }] });
    expect(noFile[0].target).toBe("plugins/doug-flow/skills/quiet-skill/SKILL.md");
  });

  it("returns [] with no signals at all", () => {
    const empty = { outcomes: { rows: [] }, lessons: { repeated: [] }, trace: { files: [], denials: [], skills: [] } };
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
    addLesson(m, { text: "Never edit dist/ by hand.", kind: "pitfall", source: { agent: "lead" } });
    addLesson(m, { text: "Never edit dist/ by hand, at all.", kind: "pitfall", source: { agent: "lead" } });
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
    addLesson(m, { text: "Never edit dist/ by hand.", kind: "pitfall", source: { agent: "lead" } });
    addLesson(m, { text: "Never edit dist/ by hand, at all.", kind: "pitfall", source: { agent: "lead" } });
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
