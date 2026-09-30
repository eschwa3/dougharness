// Proposal builders for docs/decisions/ ADRs and .claude/rules/ conventions (card memory-decisions): the
// paths are writable only through this proposal path (protect-paths.mjs/stop-gate.mjs in plugins/doug-gates
// enforce the other half - see hooks.test.mjs). decisions.mjs is pure given its inputs and only ever calls
// writeProposals (lib/learn.mjs) - never docs/decisions/ or .claude/rules/ directly; applyProposal (also
// learn.mjs) is the one function that ever touches those files, and only for a diff file the caller names.
import { describe, it, expect } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { nextDecisionNumber, slugify, renderDecision, proposeDecision, proposeAmendment, proposeRule, proposeClaudeMd } from "../lib/decisions.mjs";
import { applyProposal, readAppliedLedger } from "../lib/learn.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, ".."); // plugins/doug-flow
const repoRoot = join(root, "..", ".."); // the dougharness checkout root
// The public snapshot leaves out docs the dev repo keeps (ADRs, run log, rehearsals, releasing); scripts/export-public.mjs
// is itself excluded from the snapshot, so its absence marks it. In dev a missing doc must fail, not skip.
const IS_SNAPSHOT = !existsSync(join(repoRoot, "scripts/export-public.mjs"));
const script = join(root, "scripts/memory.mjs");

function tempProject({ decisions = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "doug-decisions-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
  writeFileSync(join(dir, ".gitignore"), ".doug/.state/\n");
  mkdirSync(join(dir, "docs/decisions"), { recursive: true });
  for (const [name, content] of Object.entries(decisions)) {
    writeFileSync(join(dir, "docs/decisions", name), content);
  }
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
  return dir;
}

// --- nextDecisionNumber --------------------------------------------------------------------------------------

describe("nextDecisionNumber", () => {
  it("returns 0001 when docs/decisions is empty or missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "doug-decisions-empty-"));
    expect(nextDecisionNumber(dir)).toBe("0001");
  });
  it("returns one past the highest existing NNNN-*.md, ignoring a stray non-matching file", () => {
    const dir = tempProject({
      decisions: {
        "0001-a.md": "x",
        "0002-b.md": "x",
        "0003-c.md": "x",
        "0004-d.md": "x",
        "0005-e.md": "x",
        "0006-f.md": "x",
        "README.md": "not a decision, ignored",
        "notes.txt": "also ignored",
      },
    });
    expect(nextDecisionNumber(dir)).toBe("0007");
  });
});

// --- slugify ---------------------------------------------------------------------------------------------------

describe("slugify", () => {
  it("lowercases, collapses non-alphanumerics to -, trims, and caps at ~60 chars with no trailing -", () => {
    expect(slugify("Git-tracked decisions and rules")).toBe("git-tracked-decisions-and-rules");
    expect(slugify("  Leading/trailing !! chars  ")).toBe("leading-trailing-chars");
    const long = slugify(`${"word ".repeat(30)}tail`);
    expect(long.length).toBeLessThanOrEqual(60);
    expect(long.endsWith("-")).toBe(false);
  });
});

// --- renderDecision ----------------------------------------------------------------------------------------

describe("renderDecision", () => {
  it("matches the repo's ADR shape (docs/decisions/0006-out-of-workflow-access.md's own first three lines)", () => {
    // The public snapshot has no docs/decisions/; there the rendered shape is still checked, the real ADR is not.
    if (!IS_SNAPSHOT) {
      const [realLine1, realLine2, realLine3] = readFileSync(join(repoRoot, "docs/decisions/0006-out-of-workflow-access.md"), "utf8").split("\n");
      expect(realLine1).toMatch(/^# 0006\. .+$/);
      expect(realLine2).toBe("");
      expect(realLine3).toMatch(/^Date: \d{4}-\d{2}-\d{2}\. Status: accepted\.$/);
    }

    const rendered = renderDecision({ number: "0007", title: "A new decision", body: "## Context\n\nSome context.", date: "2026-09-12" });
    const lines = rendered.split("\n");
    expect(lines[0]).toBe("# 0007. A new decision");
    expect(lines[1]).toBe("");
    expect(lines[2]).toBe("Date: 2026-09-12. Status: accepted.");
    expect(lines[3]).toBe("");
    expect(lines[4]).toBe("## Context");
    expect(rendered.endsWith("Some context.\n")).toBe(true);
    expect(rendered.endsWith("\n\n")).toBe(false); // exactly one trailing newline, regardless of body's own
  });
});

// --- proposeDecision -----------------------------------------------------------------------------------------

describe("proposeDecision", () => {
  it("refuses an empty title and an empty body, without writing anything", () => {
    const dir = tempProject({ decisions: { "0001-existing.md": "# 0001. existing\n\nDate: 2026-01-01. Status: accepted.\n\nbody\n" } });
    const before = execFileSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8" });

    expect(proposeDecision({ dir, title: "", body: "x", date: "2026-09-12" })).toMatchObject({ ok: false, reason: expect.stringContaining("title") });
    expect(proposeDecision({ dir, title: "x", body: "  ", date: "2026-09-12" })).toMatchObject({ ok: false, reason: expect.stringContaining("body") });

    expect(execFileSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8" })).toBe(before);
  });

  // reviewer defect: a punctuation-only title slugs to "" and would target docs/decisions/0001-.md.
  it("refuses a title that slugs to nothing (punctuation-only)", () => {
    const dir = tempProject();
    expect(proposeDecision({ dir, title: "!!!", body: "x", date: "2026-09-12" })).toEqual({ ok: false, reason: expect.stringContaining("empty slug") });
    expect(proposeDecision({ dir, title: "---", body: "x", date: "2026-09-12" })).toEqual({ ok: false, reason: expect.stringContaining("empty slug") });
  });

  // reviewer defect: date was interpolated unchecked (a missing one wrote a literal "Date: undefined.").
  it("defaults date to today's local date when omitted, and refuses a date not shaped YYYY-MM-DD", () => {
    const dir = tempProject();
    const today = new Date();
    const expectedDate = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    const noDate = proposeDecision({ dir, title: "No date given", body: "x" });
    expect(noDate.ok).toBe(true);
    expect(readFileSync(noDate.diffPath, "utf8")).toContain(`+Date: ${expectedDate}. Status: accepted.`);

    // An empty string defaults the same as omitting it entirely - not a refusal case.
    const emptyDate = proposeDecision({ dir, title: "Empty string date", body: "x", date: "" });
    expect(emptyDate.ok).toBe(true);
    expect(readFileSync(emptyDate.diffPath, "utf8")).toContain(`+Date: ${expectedDate}. Status: accepted.`);

    for (const bad of ["09/12/2026", "2026-9-12", "not-a-date"]) {
      const result = proposeDecision({ dir, title: `Bad date ${bad}`, body: "x", date: bad });
      expect(result, bad).toEqual({ ok: false, reason: expect.stringContaining("YYYY-MM-DD") });
    }
  });

  // NOTE (design deviation, reported): nextDecisionNumber always returns one past the highest number already
  // on disk, recomputed fresh on every call, so an ordinary sequence of proposeDecision calls can never land on
  // an already-real target by itself - a file at that exact path would, by construction, already have been
  // counted toward "max" before "next" was computed past it, and Node's built-in fs module cannot be monkey-
  // patched to force the case (`existsSync` is a non-configurable property; this codebase's tests never mock
  // the filesystem). The `existsSync(join(dir, relPath))` guard in proposeDecision (decisions.mjs) stays as
  // defense in depth per the brief, but is not independently exercised here - only the reachable refusals
  // (empty title, empty body) are tested above.

  it("writes a creation diff under .doug/.state/learn/, never a tracked file, with a git-apply-able diff", () => {
    const dir = tempProject();
    const before = execFileSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8" });
    const result = proposeDecision({ dir, title: "Git-tracked decisions and rules via proposal", body: "## Context\n\nWhy.\n", date: "2026-09-12", now: new Date("2026-09-12T00:00:00.000Z") });
    expect(result.ok).toBe(true);
    expect(result.proposal).toMatchObject({ kind: "decision", target: "docs/decisions/0001-git-tracked-decisions-and-rules-via-proposal.md" });
    expect(result.diffPath.startsWith(join(dir, ".doug/.state/learn"))).toBe(true);
    expect(existsSync(result.diffPath)).toBe(true);
    const diff = readFileSync(result.diffPath, "utf8");
    expect(diff).toContain("+++ b/docs/decisions/0001-git-tracked-decisions-and-rules-via-proposal.md");
    const check = spawnSync("git", ["apply", "--check", result.diffPath], { cwd: dir, encoding: "utf8" });
    expect(check.status).toBe(0);
    expect(execFileSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8" })).toBe(before);
  });
});

// --- proposeAmendment ----------------------------------------------------------------------------------------

describe("proposeAmendment", () => {
  function projectWithOneAdr() {
    return tempProject({ decisions: { "0001-first.md": "# 0001. first\n\nDate: 2026-01-01. Status: accepted.\n\nOriginal body.\n" } });
  }

  it("refuses an unknown id and an ambiguous id, and an empty text", () => {
    const dir = projectWithOneAdr();
    expect(proposeAmendment({ dir, id: "0002", text: "x", date: "2026-09-12" })).toEqual({ ok: false, reason: expect.stringContaining("no ADR found") });
    expect(proposeAmendment({ dir, id: "0001", text: "  ", date: "2026-09-12" })).toEqual({ ok: false, reason: expect.stringContaining("text is required") });

    writeFileSync(join(dir, "docs/decisions/0001-second.md"), "# 0001. second\n\nDate: 2026-01-02. Status: accepted.\n\nOther.\n");
    const ambiguous = proposeAmendment({ dir, id: "0001", text: "x", date: "2026-09-12" });
    expect(ambiguous).toEqual({ ok: false, reason: expect.stringContaining("ambiguous") });
  });

  it("accepts a bare number or a NNNN-slug.md basename, and appends a dated Amendment section", () => {
    const dir = projectWithOneAdr();
    const result = proposeAmendment({ dir, id: "0001-first.md", text: "The new rule.", date: "2026-09-12", now: new Date("2026-09-12T00:00:00.000Z") });
    expect(result.ok).toBe(true);
    expect(result.proposal).toMatchObject({ kind: "amend", target: "docs/decisions/0001-first.md" });
    const diff = readFileSync(result.diffPath, "utf8");
    expect(diff).toContain("+## Amendment 2026-09-12");
    expect(diff).toContain("+The new rule.");

    const check = spawnSync("git", ["apply", "--check", result.diffPath], { cwd: dir, encoding: "utf8" });
    expect(check.status).toBe(0);

    const applied = applyProposal(result.diffPath, { dir });
    expect(applied).toEqual({ ok: true, target: "docs/decisions/0001-first.md" });
    const updated = readFileSync(join(dir, "docs/decisions/0001-first.md"), "utf8");
    expect(updated).toContain("Original body.");
    expect(updated).toContain("## Amendment 2026-09-12");
    expect(updated).toContain("The new rule.");
  });

  // reviewer defect: date was interpolated into the Amendment heading unchecked.
  it("defaults date to today's local date when omitted, and refuses a date not shaped YYYY-MM-DD", () => {
    const dir = projectWithOneAdr();
    const today = new Date();
    const expectedDate = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    const noDate = proposeAmendment({ dir, id: "0001", text: "No date given." });
    expect(noDate.ok).toBe(true);
    expect(readFileSync(noDate.diffPath, "utf8")).toContain(`+## Amendment ${expectedDate}`);

    const bad = proposeAmendment({ dir, id: "0001", text: "x", date: "12/31/2026" });
    expect(bad).toEqual({ ok: false, reason: expect.stringContaining("YYYY-MM-DD") });
  });
});

// --- proposeRule ---------------------------------------------------------------------------------------------

describe("proposeRule", () => {
  it("refuses an invalid name (path escape, spaces) without writing anything", () => {
    const dir = tempProject();
    const before = execFileSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8" });
    expect(proposeRule({ dir, name: "../x", body: "body" })).toEqual({ ok: false, reason: expect.stringContaining("not a valid rule name") });
    expect(proposeRule({ dir, name: "A B", body: "body" })).toEqual({ ok: false, reason: expect.stringContaining("not a valid rule name") });
    expect(execFileSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8" })).toBe(before);
  });

  it("refuses an empty body", () => {
    const dir = tempProject();
    expect(proposeRule({ dir, name: "tests", body: "  " })).toEqual({ ok: false, reason: expect.stringContaining("body is required") });
  });

  it("with paths, renders a paths: frontmatter list; without paths, the body alone; a name with one /subdir level is valid", () => {
    const dir = tempProject();
    const withPaths = proposeRule({ dir, name: "tests", paths: ["src/**", "*.test.mjs"], body: "Write tests first.", now: new Date("2026-09-12T00:00:00.000Z") });
    expect(withPaths.ok).toBe(true);
    expect(withPaths.proposal.target).toBe(".claude/rules/tests.md");
    const diffWithPaths = readFileSync(withPaths.diffPath, "utf8");
    expect(diffWithPaths).toContain("+---");
    expect(diffWithPaths).toContain('+  - "src/**"');
    expect(diffWithPaths).toContain('+  - "*.test.mjs"');
    expect(diffWithPaths).toContain("+Write tests first.");

    const withoutPaths = proposeRule({ dir, name: "general", body: "Always do X.", now: new Date("2026-09-12T00:00:01.000Z") });
    expect(withoutPaths.ok).toBe(true);
    const diffWithoutPaths = readFileSync(withoutPaths.diffPath, "utf8");
    expect(diffWithoutPaths).not.toContain("paths:");
    expect(diffWithoutPaths).not.toContain("+---");
    expect(diffWithoutPaths).toContain("+Always do X.");

    const subdir = proposeRule({ dir, name: "web/api", body: "API conventions.", now: new Date("2026-09-12T00:00:02.000Z") });
    expect(subdir.ok).toBe(true);
    expect(subdir.proposal.target).toBe(".claude/rules/web/api.md");

    // Applying each for real: git apply creates the (possibly nested) file and any missing directory.
    for (const r of [withPaths, withoutPaths, subdir]) {
      const check = spawnSync("git", ["apply", "--check", r.diffPath], { cwd: dir, encoding: "utf8" });
      expect(check.status, r.diffPath).toBe(0);
    }
    expect(applyProposal(withPaths.diffPath, { dir })).toEqual({ ok: true, target: ".claude/rules/tests.md" });
    expect(readFileSync(join(dir, ".claude/rules/tests.md"), "utf8")).toContain('paths:\n  - "src/**"');
    expect(applyProposal(subdir.diffPath, { dir })).toEqual({ ok: true, target: ".claude/rules/web/api.md" });
    expect(readFileSync(join(dir, ".claude/rules/web/api.md"), "utf8")).toBe("API conventions.\n");
  });

  it("replaces an existing rule file with an ordinary (non-creation) diff", () => {
    const dir = tempProject();
    mkdirSync(join(dir, ".claude/rules"), { recursive: true });
    writeFileSync(join(dir, ".claude/rules/tests.md"), "Old body.\n");
    const result = proposeRule({ dir, name: "tests", body: "New body." });
    expect(result.ok).toBe(true);
    const diff = readFileSync(result.diffPath, "utf8");
    expect(diff).toContain("-Old body.");
    expect(diff).toContain("+New body.");
    expect(applyProposal(result.diffPath, { dir })).toEqual({ ok: true, target: ".claude/rules/tests.md" });
    expect(readFileSync(join(dir, ".claude/rules/tests.md"), "utf8")).toBe("New body.\n");
  });

  // reviewer defect: unifiedDiff returns null when the rendered content already matches the file, and
  // writeProposals then writes no diff file at all - a caller reading result.diffPath got undefined. Refuse
  // before writing anything instead.
  it("refuses when the rendered content already matches the existing file exactly, without writing anything", () => {
    const dir = tempProject();
    mkdirSync(join(dir, ".claude/rules"), { recursive: true });
    writeFileSync(join(dir, ".claude/rules/tests.md"), "Same body.\n");
    const before = execFileSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8" });
    const learnBefore = existsSync(join(dir, ".doug/.state/learn"));

    const result = proposeRule({ dir, name: "tests", body: "Same body." });
    expect(result).toEqual({ ok: false, reason: ".claude/rules/tests.md already has exactly this content; nothing to propose" });

    expect(execFileSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8" })).toBe(before);
    expect(existsSync(join(dir, ".doug/.state/learn"))).toBe(learnBefore);
  });
});

// --- applyProposal: real git apply + ledger, for decisions.mjs's own diffs ------------------------------------

describe("applyProposal on a decisions.mjs diff (real git apply + ledger)", () => {
  it("creates the ADR file for real and appends a ledger line with the correct sha256", () => {
    const dir = tempProject();
    const result = proposeDecision({ dir, title: "Real apply test", body: "Body text.\n" });
    const applied = applyProposal(result.diffPath, { dir });
    expect(applied).toEqual({ ok: true, target: "docs/decisions/0001-real-apply-test.md" });
    expect(existsSync(join(dir, "docs/decisions/0001-real-apply-test.md"))).toBe(true);

    // No `date` was given (the reviewer's repro: a lib caller without one used to write "Date: undefined.") -
    // proposeDecision must have defaulted it to today's local date.
    const today = new Date();
    const expectedDate = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    expect(readFileSync(join(dir, "docs/decisions/0001-real-apply-test.md"), "utf8")).toContain(`Date: ${expectedDate}. Status: accepted.`);

    const ledger = readAppliedLedger(dir);
    expect(ledger.length).toBe(1);
    const bytes = readFileSync(join(dir, "docs/decisions/0001-real-apply-test.md"));
    const expectedSha = createHash("sha256").update(bytes).digest("hex");
    const expectedDiffSha = createHash("sha256").update(readFileSync(result.diffPath)).digest("hex");
    // card proposal-ledger-forgeable: `proposal` is now the diff file's path relative to `dir`, not the
    // absolute path the caller passed.
    const expectedProposalRel = relative(dir, result.diffPath).split(sep).join("/");
    expect(ledger[0]).toMatchObject({
      target: "docs/decisions/0001-real-apply-test.md",
      sha256: expectedSha,
      diffSha256: expectedDiffSha,
      proposal: expectedProposalRel,
    });
    expect(typeof ledger[0].at).toBe("string");
  });
});

// --- proposeClaudeMd -----------------------------------------------------------------------------------------

const FIXTURE_CLAUDE_MD =
  "# Project instructions\n" +
  "\n" +
  "## Commands\n" +
  "\n" +
  "```sh\n" +
  "pnpm test\n" +
  "pnpm build\n" +
  "```\n" +
  "\n" +
  "## Working agreement\n" +
  "\n" +
  "- Do what was asked.\n" +
  "- Be terse.\n" +
  "\n" +
  "## Gotchas\n" +
  "\n" +
  "- Duplicate bullet.\n" +
  "- Duplicate bullet.\n" +
  "\n" +
  "## Models\n" +
  "\n" +
  "| Work      | Model   | Effort  |\n" +
  "|-----------|---------|---------|\n" +
  "| plan      | opus    | high    |\n" +
  "| worker    | sonnet  | medium  |\n";

// A temp git repo (via tempProject) plus a CLAUDE.md written from FIXTURE_CLAUDE_MD (or an override) and a
// .doug/hooks/scripts/bash-guard.mjs fixture (the vendored-hook location every doug init install has - no
// plugins/doug-gates/scripts dir at all here), both committed - so `git status --porcelain` is clean and
// `git apply --check` has a real base to check against.
function tempProjectWithClaudeMd(claudeMd = FIXTURE_CLAUDE_MD) {
  const dir = tempProject();
  writeFileSync(join(dir, "CLAUDE.md"), claudeMd);
  mkdirSync(join(dir, ".doug/hooks/scripts"), { recursive: true });
  writeFileSync(join(dir, ".doug/hooks/scripts/bash-guard.mjs"), "// fixture hook\n");
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", "add CLAUDE.md fixture"], { cwd: dir });
  return dir;
}

describe("proposeClaudeMd", () => {
  // Also the "only .doug/hooks/scripts present" case: tempProjectWithClaudeMd's fixture hook lives solely at
  // .doug/hooks/scripts/bash-guard.mjs, so the enforcedBy: "bash-guard.mjs" remove below resolving to ok: true
  // pins that hook resolution finds it there.
  it("happy path: one add and one remove, a git-apply-able diff, an unchanged working tree, and a rationale citing every source", () => {
    const dir = tempProjectWithClaudeMd();
    const before = execFileSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8" });

    const edits = {
      note: "from lessons store",
      add: [{ heading: "## Working agreement", line: "- New rule from a lesson.", source: "lesson abc123" }],
      remove: [{ line: "- Be terse.", enforcedBy: "bash-guard.mjs", source: "docs/live-runs.md" }],
    };
    const result = proposeClaudeMd({ dir, edits, now: new Date("2026-09-13T00:00:00.000Z") });
    expect(result.ok).toBe(true);
    expect(result.proposal).toMatchObject({ id: "01", kind: "claude-md", target: "CLAUDE.md" });
    expect(result.dir.startsWith(join(dir, ".doug/.state/learn"))).toBe(true);

    const proposalsPath = join(result.dir, "proposals.json");
    const diffPath = join(result.dir, "01-claude-md.diff");
    expect(existsSync(proposalsPath)).toBe(true);
    expect(existsSync(diffPath)).toBe(true);
    expect(result.diffPath).toBe(diffPath);

    const check = spawnSync("git", ["apply", "--check", diffPath], { cwd: dir, encoding: "utf8" });
    expect(check.status, check.stderr).toBe(0);
    expect(execFileSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8" })).toBe(before);
    expect(readFileSync(join(dir, "CLAUDE.md"), "utf8")).toBe(FIXTURE_CLAUDE_MD);

    const proposals = JSON.parse(readFileSync(proposalsPath, "utf8"));
    expect(proposals).toHaveLength(1);
    const [proposal] = proposals;
    expect(proposal.rationale.note).toBe("from lessons store");
    expect(proposal.rationale.added).toEqual([{ heading: "## Working agreement", line: "- New rule from a lesson.", source: "lesson abc123" }]);
    expect(proposal.rationale.removed).toEqual([{ line: "- Be terse.", enforcedBy: "bash-guard.mjs", source: "docs/live-runs.md" }]);
    expect(proposal.rationale.lines.before).toBe(countFixtureLines());
    expect(proposal.rationale.lines.after).toBe(proposal.rationale.lines.before); // one line added, one removed
    expect(proposal.reason).toContain("+1 -1");
  });

  function countFixtureLines() {
    return FIXTURE_CLAUDE_MD.endsWith("\n") ? FIXTURE_CLAUDE_MD.split("\n").length - 1 : FIXTURE_CLAUDE_MD.split("\n").length;
  }

  function expectRefusedNothingWritten(dir, edits, matcher) {
    const before = execFileSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8" });
    const learnDir = join(dir, ".doug/.state/learn");
    const existedBefore = existsSync(learnDir);
    const entriesBefore = existedBefore ? readdirSync(learnDir) : [];
    const result = proposeClaudeMd({ dir, edits });
    expect(result.ok, JSON.stringify(edits)).toBe(false);
    if (matcher) expect(result.reason).toEqual(matcher);
    expect(execFileSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8" })).toBe(before);
    const entriesAfter = existsSync(learnDir) ? readdirSync(learnDir) : [];
    expect(entriesAfter).toEqual(entriesBefore);
    return result;
  }

  it("refuses a remove whose line is absent", () => {
    const dir = tempProjectWithClaudeMd();
    expectRefusedNothingWritten(dir, { remove: [{ line: "- Not in the file.", enforcedBy: "bash-guard.mjs", source: "s" }] }, expect.stringContaining("not found"));
  });

  it("refuses a remove whose line occurs twice", () => {
    const dir = tempProjectWithClaudeMd();
    expectRefusedNothingWritten(dir, { remove: [{ line: "- Duplicate bullet.", enforcedBy: "bash-guard.mjs", source: "s" }] }, expect.stringContaining("occurs 2 times"));
  });

  it("refuses a remove naming a hook that does not exist under .doug/hooks/scripts", () => {
    const dir = tempProjectWithClaudeMd();
    expectRefusedNothingWritten(
      dir,
      { remove: [{ line: "- Be terse.", enforcedBy: "nope.mjs", source: "s" }] },
      expect.stringContaining(".doug/hooks/scripts/nope.mjs"),
    );
  });

  it("refuses a remove whose hook exists only under plugins/doug-gates/scripts, not .doug/hooks/scripts", () => {
    const dir = tempProjectWithClaudeMd();
    mkdirSync(join(dir, "plugins/doug-gates/scripts"), { recursive: true });
    writeFileSync(join(dir, "plugins/doug-gates/scripts/plugin-only.mjs"), "// fixture hook\n");
    execFileSync("git", ["add", "-A"], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", "add plugin-path-only hook fixture"], { cwd: dir });
    expectRefusedNothingWritten(
      dir,
      { remove: [{ line: "- Be terse.", enforcedBy: "plugin-only.mjs", source: "s" }] },
      expect.stringContaining(".doug/hooks/scripts/plugin-only.mjs"),
    );
  });

  it("refuses an add under a missing heading", () => {
    const dir = tempProjectWithClaudeMd();
    expectRefusedNothingWritten(dir, { add: [{ heading: "## Missing", line: "- x", source: "s" }] }, expect.stringContaining("## Missing"));
  });

  it("refuses an add whose line does not start with '- '", () => {
    const dir = tempProjectWithClaudeMd();
    expectRefusedNothingWritten(dir, { add: [{ heading: "## Gotchas", line: "not a bullet", source: "s" }] }, expect.stringContaining("start with"));
  });

  it("refuses a result over 60 lines, naming the count", () => {
    const dir = tempProjectWithClaudeMd();
    const add = [];
    for (let i = 0; i < 40; i++) add.push({ heading: "## Gotchas", line: `- Extra line ${i}.`, source: "s" });
    const result = expectRefusedNothingWritten(dir, { add }, expect.stringMatching(/\b\d+\b/));
    expect(result.reason).toContain("60");
  });

  it("refuses a change that would touch the Models section", () => {
    const dir = tempProjectWithClaudeMd();
    expectRefusedNothingWritten(dir, { add: [{ heading: "## Models", line: "- x", source: "s" }] }, expect.stringContaining("Models"));
  });

  it("refuses a remove of a line inside the Commands ```sh block", () => {
    const dir = tempProjectWithClaudeMd();
    // "pnpm test" does not start with "- ", but it does occur exactly once - the remove entry itself is
    // otherwise well-formed, so this exercises the Commands-block guard specifically, not the "- " check.
    const before = execFileSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8" });
    const result = proposeClaudeMd({ dir, edits: { remove: [{ line: "pnpm test", enforcedBy: "bash-guard.mjs", source: "s" }] } });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("Commands");
    expect(execFileSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8" })).toBe(before);
  });

  it("refuses a change to the real Commands block even when an unrelated ```sh fence appears earlier in the file (F1)", () => {
    const claudeMd =
      "# Project instructions\n" +
      "\n" +
      "## Example\n" +
      "\n" +
      "An unrelated shell example, not the Commands section:\n" +
      "\n" +
      "```sh\n" +
      "echo hello\n" +
      "```\n" +
      "\n" +
      "## Commands\n" +
      "\n" +
      "```sh\n" +
      "pnpm test\n" +
      "pnpm build\n" +
      "```\n" +
      "\n" +
      "## Working agreement\n" +
      "\n" +
      "- Do what was asked.\n" +
      "- Be terse.\n" +
      "\n" +
      "## Models\n" +
      "\n" +
      "| Work      | Model   | Effort  |\n" +
      "|-----------|---------|---------|\n" +
      "| plan      | opus    | high    |\n";
    const dir = tempProjectWithClaudeMd(claudeMd);
    const before = execFileSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8" });
    const learnDir = join(dir, ".doug/.state/learn");
    const existedBefore = existsSync(learnDir);
    const entriesBefore = existedBefore ? readdirSync(learnDir) : [];

    const result = proposeClaudeMd({ dir, edits: { remove: [{ line: "pnpm test", enforcedBy: "bash-guard.mjs", source: "s" }] } });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("Commands");
    expect(execFileSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8" })).toBe(before);
    const entriesAfter = existsSync(learnDir) ? readdirSync(learnDir) : [];
    expect(entriesAfter).toEqual(entriesBefore);
  });

  it("refuses an empty edits object", () => {
    const dir = tempProjectWithClaudeMd();
    expectRefusedNothingWritten(dir, {}, expect.stringContaining("empty"));
  });

  it("refuses non-object edits and malformed entries without throwing", () => {
    const dir = tempProjectWithClaudeMd();
    for (const bad of [null, [], "x", 3, { add: [7] }, { remove: [{ line: {} }] }]) {
      expect(() => proposeClaudeMd({ dir, edits: bad })).not.toThrow();
      expectRefusedNothingWritten(dir, bad);
    }
  });

  it("refuses when CLAUDE.md does not exist under dir", () => {
    const dir = tempProject();
    const result = proposeClaudeMd({ dir, edits: { add: [{ heading: "## Gotchas", line: "- x", source: "s" }] } });
    expect(result).toEqual({ ok: false, reason: expect.stringContaining("CLAUDE.md") });
  });
});

// --- CLI ---------------------------------------------------------------------------------------------------

describe("memory.mjs decision/rule CLI", () => {
  const run = (args, cwd) => spawnSync(process.execPath, [script, ...args], { cwd, encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: "" } });

  it("exits 2 on usage errors: missing subcommand, missing --title/--file, missing amend id", () => {
    const dir = tempProject();
    expect(run(["decision"], dir).status).toBe(2);
    expect(run(["decision", "propose"], dir).status).toBe(2);
    expect(run(["decision", "propose", "--title", "x"], dir).status).toBe(2); // no --file
    expect(run(["decision", "amend"], dir).status).toBe(2);
    expect(run(["rule"], dir).status).toBe(2);
    expect(run(["rule", "propose"], dir).status).toBe(2); // no name
    expect(run(["rule", "propose", "tests"], dir).status).toBe(2); // no --file
  });

  it("decision propose writes a diff, prints the proposal/diff/apply lines, and --file - reads the body from stdin", () => {
    const dir = tempProject();
    const bodyFile = join(dir, "body.md");
    writeFileSync(bodyFile, "## Context\n\nWhy this matters.\n");
    const r = run(["decision", "propose", "--title", "A CLI decision", "--file", bodyFile, "--date", "2026-09-12", dir], dir);
    expect(r.status).toBe(0);
    const lines = r.stdout.trim().split("\n");
    expect(lines[0]).toMatch(/^01 decision docs\/decisions\/0001-a-cli-decision\.md: /);
    expect(lines[1]).toMatch(/^diff: /);
    expect(lines[2]).toMatch(/^apply with: learn\.mjs apply /);

    const stdinResult = spawnSync(process.execPath, [script, "decision", "propose", "--title", "From stdin", "--file", "-", "--date", "2026-09-12", dir], {
      cwd: dir,
      input: "Body from stdin.\n",
      encoding: "utf8",
      env: { ...process.env, CLAUDE_PROJECT_DIR: "" },
    });
    expect(stdinResult.status).toBe(0);
    // Neither propose call was applied, so docs/decisions is still empty on disk and both compute number 0001.
    expect(stdinResult.stdout).toContain("docs/decisions/0001-from-stdin.md");
  });

  it("decision propose --json refuses an empty title/body with exit 1 and prints the reason", () => {
    const dir = tempProject();
    const bodyFile = join(dir, "body.md");
    writeFileSync(bodyFile, "");
    const r = run(["decision", "propose", "--title", "x", "--file", bodyFile, "--json", dir], dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("body is required");
    expect(JSON.parse(r.stdout)).toMatchObject({ ok: false });
  });

  it("decision amend runs end to end from the CLI and applies with learn.mjs apply", () => {
    const dir = tempProject({ decisions: { "0001-first.md": "# 0001. first\n\nDate: 2026-01-01. Status: accepted.\n\nOriginal.\n" } });
    const propose = run(["decision", "amend", "0001", "--text", "Amended via CLI.", "--date", "2026-09-12", dir], dir);
    expect(propose.status).toBe(0);
    const diffLine = propose.stdout.trim().split("\n").find((l) => l.startsWith("diff: "));
    const diffPath = diffLine.replace("diff: ", "");
    const learnScript = join(root, "scripts/learn.mjs");
    const apply = spawnSync(process.execPath, [learnScript, "apply", diffPath, dir], { cwd: dir, encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: "" } });
    expect(apply.status).toBe(0);
    expect(readFileSync(join(dir, "docs/decisions/0001-first.md"), "utf8")).toContain("Amended via CLI.");
  });

  it("rule propose renders --paths as a comma-separated list and writes under .doug/.state/learn/", () => {
    const dir = tempProject();
    const bodyFile = join(dir, "body.md");
    writeFileSync(bodyFile, "Rule body.\n");
    const r = run(["rule", "propose", "tests", "--file", bodyFile, "--paths", "src/**,*.test.mjs", dir], dir);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("rule .claude/rules/tests.md:");
    const diffLine = r.stdout.trim().split("\n").find((l) => l.startsWith("diff: "));
    const diffPath = diffLine.replace("diff: ", "");
    expect(diffPath.startsWith(join(dir, ".doug/.state/learn"))).toBe(true);
    const diff = readFileSync(diffPath, "utf8");
    expect(diff).toContain('+  - "src/**"');
    expect(diff).toContain('+  - "*.test.mjs"');
  });

  // reviewer defect, reproduced exactly as reported: `memory.mjs rule propose tests --file <same body>` used to
  // print "diff: undefined" / "apply with: learn.mjs apply undefined" and exit 0.
  it("rule propose exits 1 and names the reason, with no 'undefined', when the file already has that exact content", () => {
    const dir = tempProject();
    mkdirSync(join(dir, ".claude/rules"), { recursive: true });
    writeFileSync(join(dir, ".claude/rules/tests.md"), "Same body.\n");
    const bodyFile = join(dir, "body.md");
    writeFileSync(bodyFile, "Same body.\n");
    const r = run(["rule", "propose", "tests", "--file", bodyFile, dir], dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("already has exactly this content");
    expect(r.stdout).not.toContain("undefined");
    expect(r.stderr).not.toContain("undefined");
  });

  // reviewer defect: a punctuation-only --title used to target docs/decisions/0001-.md.
  it("decision propose exits 1 when --title slugs to nothing", () => {
    const dir = tempProject();
    const bodyFile = join(dir, "body.md");
    writeFileSync(bodyFile, "body\n");
    const r = run(["decision", "propose", "--title", "!!!", "--file", bodyFile, dir], dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("empty slug");
  });

  // reviewer defect: --date was forwarded to renderDecision unchecked.
  it("decision propose exits 1 on a malformed --date", () => {
    const dir = tempProject();
    const bodyFile = join(dir, "body.md");
    writeFileSync(bodyFile, "body\n");
    const r = run(["decision", "propose", "--title", "x", "--file", bodyFile, "--date", "12/31/2026", dir], dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("YYYY-MM-DD");
  });
});

describe("memory.mjs claude-md CLI", () => {
  const run = (args, cwd, input) =>
    spawnSync(process.execPath, [script, ...args], { cwd, encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: "" }, input });

  it("exits 2 on usage errors: missing subcommand, missing --file", () => {
    const dir = tempProjectWithClaudeMd();
    expect(run(["claude-md"], dir).status).toBe(2);
    expect(run(["claude-md", "propose"], dir).status).toBe(2);
  });

  it("exits 1 with the file and parse error on non-JSON --file", () => {
    const dir = tempProjectWithClaudeMd();
    const editsFile = join(dir, "edits.json");
    writeFileSync(editsFile, "not json");
    const r = run(["claude-md", "propose", "--file", editsFile, dir], dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(editsFile);
    expect(r.stderr).toContain("is not valid JSON");
  });

  it("exits 1 with the reason on a refused edits object", () => {
    const dir = tempProjectWithClaudeMd();
    const editsFile = join(dir, "edits.json");
    writeFileSync(editsFile, JSON.stringify({}));
    const r = run(["claude-md", "propose", "--file", editsFile, dir], dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("empty");
  });

  it("exits 0 and prints the proposal/diff/apply lines on a good edits file, and --file - reads stdin", () => {
    const dir = tempProjectWithClaudeMd();
    const edits = { add: [{ heading: "## Working agreement", line: "- CLI-added rule.", source: "lesson x" }] };
    const editsFile = join(dir, "edits.json");
    writeFileSync(editsFile, JSON.stringify(edits));
    const r = run(["claude-md", "propose", "--file", editsFile, dir], dir);
    expect(r.status).toBe(0);
    const lines = r.stdout.trim().split("\n");
    expect(lines[0]).toMatch(/^01 claude-md CLAUDE\.md: /);
    expect(lines[1]).toMatch(/^diff: /);
    expect(lines[2]).toMatch(/^apply with: learn\.mjs apply /);

    const stdinResult = run(["claude-md", "propose", "--file", "-", dir], dir, JSON.stringify(edits));
    expect(stdinResult.status).toBe(0);
    expect(stdinResult.stdout).toMatch(/^01 claude-md CLAUDE\.md: /);
  });
});
