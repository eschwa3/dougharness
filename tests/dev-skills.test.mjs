// The harness-fix skill is Doug-only: it lives in .claude/skills/harness-fix, not in the shipped plugin (card op-harness-fix-local).
// These pins moved here from plugins/doug-flow/tests/template.test.mjs with the skill.
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const root = join(repo, "plugins/doug-flow");
const FIX_PATH = join(repo, ".claude/skills/harness-fix/SKILL.md");
// The public snapshot leaves scripts/export-public.mjs out; its absence marks a snapshot (same check as template.test.mjs).
const IS_SNAPSHOT = !existsSync(join(repo, "scripts/export-public.mjs"));

function parseFrontmatter(text) {
  const m = /^---\n([\s\S]*?)\n---/.exec(text);
  if (!m) return null;
  const out = {};
  for (const line of m[1].split("\n")) {
    const kv = /^([A-Za-z_-]+):\s*(.*)$/.exec(line);
    if (kv) out[kv[1]] = kv[2].trim();
  }
  return out;
}

describe("the local harness-fix skill (.claude/skills/harness-fix)", () => {
  it("(a) is named harness-fix and the model may invoke it", () => {
    const fm = parseFrontmatter(readFileSync(FIX_PATH, "utf8"));
    expect(fm.name).toBe("harness-fix");
    expect(fm["disable-model-invocation"]).toBeUndefined();
  });
  it("(b) carries no ${CLAUDE_PLUGIN_ROOT}: a project skill uses repo-relative paths", () => {
    expect(readFileSync(FIX_PATH, "utf8")).not.toContain("${CLAUDE_PLUGIN_ROOT}");
  });
  it("(c) has a '## Files the workflow cannot rewrite' section naming all four self-modification paths", () => {
    const fix = readFileSync(FIX_PATH, "utf8");
    const h = fix.indexOf("## Files the workflow cannot rewrite");
    expect(h, "no '## Files the workflow cannot rewrite' heading").toBeGreaterThanOrEqual(0);
    const next = fix.indexOf("\n## ", h + 1);
    const section = fix.slice(h, next === -1 ? undefined : next);
    for (const p of ["plugins/doug-flow/workflows/doug-implement.js", "plugins/doug-gates/scripts/", ".doug/hooks/scripts/", "plugins/doug-flow/agents/"]) {
      expect(section, p).toContain(p);
    }
  });
  it("(d) CLAUDE.md points to the skill", () => {
    expect(readFileSync(join(repo, "CLAUDE.md"), "utf8")).toContain(".claude/skills/harness-fix/SKILL.md");
  });
  it.skipIf(IS_SNAPSHOT)("(e) scripts/export-public.mjs TRANSFORMS has no entry for the old plugin path, and every TRANSFORMS file exists", async () => {
    const { TRANSFORMS } = await import(join(repo, "scripts/export-public.mjs"));
    const files = TRANSFORMS.map((t) => t.file);
    expect(files).not.toContain("plugins/doug-flow/skills/harness-fix/SKILL.md");
    for (const f of files) expect(existsSync(join(repo, f)), f).toBe(true);
  });

  it("names a test file for every module, the rules it lists, and every test file it names exists", () => {
    const fix = readFileSync(FIX_PATH, "utf8");
    // harness-fix is the procedure itself: the model may invoke it, and it names a test file for every module.
    expect(parseFrontmatter(fix)["disable-model-invocation"]).toBeUndefined();
    for (const t of ["template.test.mjs", "board.test.mjs", "plan.test.mjs", "replan.test.mjs", "land.test.mjs", "hooks.test.mjs", "proposal.test.ts", "contract.test.ts"]) expect(fix).toContain(t);
    for (const rule of [".doug/hooks/scripts", "scriptPath", "pnpm test:unit", "Never `pnpm test`", "flow-board.d.ts", "trailers"]) expect(fix).toContain(rule);
    // Every test file the skill names exists.
    for (const m of fix.matchAll(/`((?:plugins|packages|tests)\/[^`]+\.test\.(?:mjs|ts))`/g)) expect(existsSync(join(repo, m[1])), m[1]).toBe(true);
    // card mutation-check-contract: a reviewer once deleted the entire mechanism a card existed to add, and all
    // 631 tests still passed. The skill now demands mutate-run-revert for a mechanism-exists card (rule 7),
    // proportionate to a line that a prose/message/docs-only change does not need it, and assigns the duty to
    // the reviewer role (section 0), which also records that the flow track's reviewer (read-only by tool
    // policy) does not carry this instruction because its verifier and adversary stages run the code afterward
    // instead.
    for (const s of [
      "expected to mutate the mechanism and rerun the test rather than only read the diff",
      "mutate or remove the mechanism",
      "run the new test file",
      "confirm it fails",
      "revert the mutation",
      "report which assertion failed",
      "a card whose acceptance is that a mechanism exists needs it",
      "prose, a message, or a docs line does not",
      "plugins/doug-flow/agents/reviewer.md` does not carry this instruction",
      "read-only by tool policy",
      "verifier and adversary stages run the code afterward instead",
    ]) expect(fix, s).toContain(s);
  });
  it("harness-fix's module table names a test file for every lib/*.mjs and scripts/*.mjs under plugins/doug-flow, not just an incidental mention elsewhere in section 1 (card harness-fix-memory-row)", () => {
    const fix = readFileSync(FIX_PATH, "utf8");
    const h1 = fix.indexOf("## 1.");
    const h2 = fix.indexOf("## 2.");
    expect(h1, "harness-fix's SKILL.md has no '## 1.' heading — section boundary moved or renamed").toBeGreaterThanOrEqual(0);
    expect(h2, "harness-fix's SKILL.md has no '## 2.' heading — section boundary moved or renamed").toBeGreaterThanOrEqual(0);
    const section = fix.slice(h1, h2);

    // Parse each `| module cell | test cell |` row (skipping the header and the `|---|---|` separator), splitting
    // on the last unescaped "|" so a cell's own text is never mistaken for a column boundary.
    function parseRow(line) {
      const body = line.trim().slice(1, -1); // drop the row's leading and trailing "|"
      let cut = -1;
      for (let i = body.length - 1; i >= 0; i--) {
        if (body[i] === "|" && body[i - 1] !== "\\") {
          cut = i;
          break;
        }
      }
      if (cut === -1) return null;
      return { module: body.slice(0, cut).trim(), test: body.slice(cut + 1).trim() };
    }
    const rows = section
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith("|") && !/^\|\s*Module\s*\|/.test(l) && !/^\|\s*-+\s*\|/.test(l))
      .map(parseRow)
      .filter(Boolean);

    // A row counts as coverage for a module only when its test cell actually names a test file, and only the
    // headline of its module cell — the text before the first parenthetical aside — counts as a declared module.
    // Without that second cut, a module named only in passing inside another row's aside (the seams row's `the
    // reviewIssues report key ... round-tripping into lib/memory.mjs's review_issue_count`, or the decisions
    // row's `scripts/memory.mjs`'s decision/rule cases, both mentioned after their row's own headline) would
    // count as that module's row, so deleting the module's real row would leave the pin green.
    const testFileRe = /\.test\.(mjs|ts)\b/;
    const headline = (cell) => {
      const i = cell.indexOf("(");
      return i === -1 ? cell : cell.slice(0, i);
    };
    const covered = rows.filter((r) => testFileRe.test(r.test));

    const modules = [
      ...readdirSync(join(root, "lib")).filter((f) => f.endsWith(".mjs")).map((f) => `lib/${f}`),
      ...readdirSync(join(root, "scripts")).filter((f) => f.endsWith(".mjs")).map((f) => `scripts/${f}`),
    ];
    for (const m of modules) {
      const found = covered.some((r) => headline(r.module).includes(m));
      expect(found, `${m} has no row in harness-fix's module table (section 1) — add one`).toBe(true);
    }
  });
  // card rehearsal-docs: the docs/rehearsals.md mention in harness-fix rule 8. The public export drops it.
  it.skipIf(IS_SNAPSHOT)("harness-fix rule 8 mentions docs/rehearsals.md (card rehearsal-docs)", () => {
    const fix = readFileSync(FIX_PATH, "utf8");
    expect(fix).toContain("docs/rehearsals.md");
  });
  it("harness-fix names the implement and review rows, the lead, and both tracks (card core-next-swarm-opt-in)", () => {
    const fix = readFileSync(FIX_PATH, "utf8");
    for (const s of ["`implement` row", "`review` row", "lead", "Agent tool", "both tracks"]) expect(fix, s).toContain(s);
  });
  it("harness-fix rule 7 lists one mutation per case (card hand-track-tester-and-mutations)", () => {
    const harnessFix = readFileSync(FIX_PATH, "utf8");
    // Sentence 1: the mutation-list rule (harness-fix rule 7).
    const mutationListSentence =
      "the brief lists one mutation per case the card's goal names, each with the test that must fail; the coder runs every listed mutation and reports each result; the reviewer reruns the list and adds its own";
    expect(harnessFix, mutationListSentence).toContain(mutationListSentence);
  });
  // 2026-09-14 (card harness-fix-tester-seat-wording): found by the reviewer of hand-track-tester-and-mutations —
  // core-next step 3 already spawns the project's tester agent to write the failing tests from the card's goal,
  // but harness-fix's own section 0 still said the coder "implements, tests first" and section 1's intro read
  // as if the coder wrote the test, contradicting the seat core-next just gave the tester.
  it("harness-fix names the tester agent on the implement row as the one who writes the test first, and no longer says the coder tests first (card harness-fix-tester-seat-wording)", () => {
    const fix = readFileSync(FIX_PATH, "utf8");
    const h0 = fix.indexOf("## 0.");
    const h1 = fix.indexOf("## 1.");
    const h2 = fix.indexOf("## 2.");
    expect(h0, "harness-fix's SKILL.md has no '## 0.' heading — section boundary moved or renamed").toBeGreaterThanOrEqual(0);
    expect(h1, "harness-fix's SKILL.md has no '## 1.' heading — section boundary moved or renamed").toBeGreaterThanOrEqual(0);
    expect(h2, "harness-fix's SKILL.md has no '## 2.' heading — section boundary moved or renamed").toBeGreaterThanOrEqual(0);
    const section0 = fix.slice(h0, h1);
    // Section 1's body, with its own heading line dropped, so "does it open with the old sentence" (assertion 4)
    // tests the paragraph itself and not the "## 1. Find the test that covers the module" title before it.
    const section1 = fix.slice(fix.indexOf("\n", h1) + 1, h2).trim();

    // Assertion 1: section 0 names the tester, on the implement row, writing the test file first from the goal,
    // and the coder implementing against it. The implement-row phrase and the "writes or extends the test file
    // first, from the goal" phrase are checked as one contiguous substring — not as two separate toContain
    // calls — so the check is scoped to the tester's own sentence: section 0 also carries the reviewer's "on
    // the `review` row", so a mutation that swaps only the tester's row to "review" must be caught by this
    // scoped clause rather than by a bare, unscoped "on the `implement` row" check.
    expect(section0, 'section 0 should name "the `tester` agent"').toContain("the `tester` agent");
    const testerSentenceClause =
      "spawned with the Agent tool on the `implement` row of the CLAUDE.md Models table, writes or extends the test file first, from the goal";
    expect(section0, testerSentenceClause).toContain(testerSentenceClause);
    expect(section0, 'section 0 should say "the coder implements against it"').toContain("the coder implements against it");
    // The coder may not edit a test without a stated reason, and the reviewer checks that rule (review hole 1:
    // deleting just the first of these left the suite green, since nothing else pinned it).
    expect(section0, 'section 0 should say "may not edit a test except with a stated reason in its report"').toContain(
      "may not edit a test except with a stated reason in its report"
    );
    expect(section0, 'section 0 should say "checks that rule"').toContain("checks that rule");

    // Assertion 2: the whole skill no longer says the coder tests first.
    expect(fix, '"implements, tests first" should be gone').not.toContain("implements, tests first");

    // Assertion 3: section 1's intro says the tester writes the test under a card, and that a one-line fix
    // outside a card has no tester — its author writes the test instead.
    expect(section1, 'section 1 should say "the tester writes or extends the test"').toContain("the tester writes or extends the test");
    expect(section1, 'section 1 should say "a one-line fix outside a card"').toContain("a one-line fix outside a card");
    expect(section1, 'section 1 should say "its author writes the test"').toContain("its author writes the test");

    // Assertion 4: the whole skill no longer carries the old section-1 opening sentence anywhere (review hole 2:
    // a bare `startsWith` on section1 only checked position, so moving the old sentence later in the same
    // paragraph left the suite green).
    expect(fix, '"Write or extend the test before the change" should be gone').not.toContain(
      "Write or extend the test before the change"
    );
  });
  // 2026-09-24 (card tester-claim-missed-in-handback, pass 2): the SubagentStop gate now reads the hand-back
  // as a fallback when last_assistant_message holds no claim, so the plain text and the hand-back are both live.
  it("harness-fix section 0 tells the tester the claim may sit in plain text or the hand-back, gate reads both (card tester-claim-missed-in-handback)", () => {
    const fix = readFileSync(FIX_PATH, "utf8");
    expect(fix).toContain(
      "A tester that leaves tests red by design ends with its tests_red_by_design claim, in its final plain-text message or its hand-back call; the SubagentStop gate reads both."
    );
  });
  it("ADR 0011 item 1: harness-fix's rule 7 carries the scratch-copy-mutation sentence", () => {
    // Reason for this edit: the constant was moved out of template.test.mjs's scope and left undefined here.
    const MUTATION_SCRATCH_COPY =
      "each mutation in a scratch copy or git worktree under `.doug/.state`, run the one test file there, and remove the copy";
    const text = readFileSync(FIX_PATH, "utf8");
    expect(text, "harness-fix SKILL.md rule 7 must carry the ADR 0011 item 1 sentence").toContain(MUTATION_SCRATCH_COPY);
  });
  it("harness-fix rule 7 tells the reader to confirm vitest's RUN line shows the scratch copy's path, on rule 7's line (card mutation-scratch-command)", () => {
    const SENTENCE =
      "Before trusting a mutation's result, confirm vitest's RUN line prints the scratch copy's path: a run whose RUN line shows the live checkout tested nothing that was mutated.";
    const text = readFileSync(FIX_PATH, "utf8");
    expect(text, "harness-fix SKILL.md must carry the RUN-line sentence").toContain(SENTENCE);
    const rule7 = text.split("\n").find((l) => l.startsWith("7. When the card's acceptance is that a mechanism exists"));
    expect(rule7, "rule 7's line not found").toBeDefined();
    expect(rule7, "the RUN-line sentence must sit on rule 7's line").toContain(SENTENCE);
    expect(rule7.endsWith(" " + SENTENCE), "the sentence must end rule 7's line, one space after the existing text").toBe(true);
  });
  it("S2: harness-fix section 0 tells the tester to run a tests-only card's mutation list itself, as the section's last sentence", () => {
    const fix = readFileSync(FIX_PATH, "utf8");
    const SENTENCE =
      "On a tests-only card (the goal says tests only, no production change) there is no coder: the tester runs the brief's mutation list itself in a scratch copy or git worktree under `.doug/.state`, never editing a production file in the live checkout, and reports each result.";
    expect(fix, SENTENCE).toContain(SENTENCE);

    const h0 = fix.indexOf("## 0. Who does the work");
    const h1 = fix.indexOf("## 1. Find the test that covers the module");
    expect(h0, "harness-fix: '## 0. Who does the work' not found").toBeGreaterThan(-1);
    expect(h1, "harness-fix: '## 1. Find the test that covers the module' not found").toBeGreaterThan(-1);
    const section0 = fix.slice(h0, h1);
    expect(section0, "S2 must sit inside section 0").toContain(SENTENCE);
    expect(section0.trim().endsWith(SENTENCE), "S2 must be the last sentence of section 0's paragraph").toBe(true);
  });
});
