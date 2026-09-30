import { describe, it, expect } from "vitest";
import { buildPrompt, MAX_EMBEDDED_DIFF_BYTES } from "../src/prompt.js";

const base = { spec: "truncate(input, max) returns input unchanged when short.", base: "main", head: "doug/task-x", changedFiles: ["src/strings.ts", "tests/strings.test.ts"] };

describe("buildPrompt", () => {
  it("is refutation-oriented and carries the spec, refs, changed files and diff", () => {
    const p = buildPrompt({ ...base, diff: "--- a/src/strings.ts\n+++ b/src/strings.ts\n+export function truncate() {}\n" });
    expect(p).toMatch(/REFUTE/);
    expect(p).toMatch(/Assume it is wrong/);
    expect(p).toContain(base.spec);
    expect(p).toContain("Base ref: main");
    expect(p).toContain("Head ref: doug/task-x");
    expect(p).toContain("  - src/strings.ts");
    expect(p).toContain("  - tests/strings.test.ts");
    expect(p).toContain("```diff");
    expect(p).toContain("+export function truncate() {}");
    expect(p).toMatch(/never edit, create, or delete files/);
    expect(p).toMatch(/any change voids your review/);
    expect(p).toMatch(/final message must be only the JSON object/);
  });
  it("tells the reviewer to fetch a large diff itself instead of embedding it", () => {
    const p = buildPrompt({ ...base, diff: null, diffBytes: MAX_EMBEDDED_DIFF_BYTES + 1 });
    expect(p).not.toContain("```diff");
    expect(p).toContain(`git diff main...doug/task-x`);
    expect(p).toContain(String(MAX_EMBEDDED_DIFF_BYTES + 1));
  });
  it("lists verify commands as blockers when given, and omits the rule otherwise", () => {
    const withCmds = buildPrompt({ ...base, diff: "", verifyCommands: ["pnpm test", "pnpm typecheck"] });
    expect(withCmds).toContain("`pnpm test`");
    expect(withCmds).toContain("`pnpm typecheck`");
    expect(withCmds).toMatch(/non-zero exit as a blocker/);
    const without = buildPrompt({ ...base, diff: "" });
    expect(without).not.toMatch(/non-zero exit as a blocker/);
  });
  it("neutralizes code fences inside the diff so the prompt structure survives", () => {
    const p = buildPrompt({ ...base, diff: "+```js\n+x\n+```\n" });
    const fences = p.match(/```/g) || [];
    expect(fences.length).toBe(2);
  });
  it("says so when the diff is empty", () => {
    const p = buildPrompt({ ...base, changedFiles: [], diff: "" });
    expect(p).toContain("(none: the diff is empty)");
  });
  it("includes the blocker gate with required phrases before Verdict rules", () => {
    const p = buildPrompt({ ...base, diff: "" });
    expect(p).toContain("What counts as a blocker");
    expect(p).toContain("repository invariant");
    expect(p).toContain("which you quote");
    expect(p).toContain("reproduction");
    expect(p).toContain("at most minor");
    expect(p).toContain("not a downgrade of destructive behavior");
    // A blocker is a demonstrated failure; static inspection and coverage gaps are major at most.
    expect(p).toContain("an entry in commandsRun");
    expect(p).toContain("static inspection alone, with no command that demonstrates it, is major at most");
    expect(p).toContain("is major and never a blocker: the reviewer owns spec compliance");
    expect(p).toContain("citing the commandsRun entry that shows it");
    const blockerIndex = p.indexOf("What counts as a blocker");
    const verdictIndex = p.indexOf("## Verdict rules");
    expect(blockerIndex).toBeGreaterThan(0);
    expect(verdictIndex).toBeGreaterThan(blockerIndex);
  });
  it("fails only on a blocker issue, and passes with notes when findings are only major or minor (card fix-loop-minor-verdict)", () => {
    const p = buildPrompt({ ...base, diff: "" });
    expect(p).toContain("`fail` only when at least one issue is a `blocker`");
    expect(p).toContain("is reported with a `pass` verdict, and a review whose findings are all advisory passes with notes");
    // The same rule is also stated in the blocker gate paragraph, ahead of the Verdict rules bullet.
    expect(p.indexOf("A `fail` verdict requires at least one `blocker` issue")).toBeLessThan(p.indexOf("## Verdict rules"));
  });
  it("P7: the issue-format rule tells the reviewer to quote the command or its output verbatim (card codex-review-r12-prose-evidence)", () => {
    const p = buildPrompt({ ...base, diff: "" });
    expect(
      p,
      "P7 (codex-review-r12-prose-evidence): prompt must carry the exact R12 quoting sentence",
    ).toContain(
      "In `evidence`, quote the command string exactly as it appears in commandsRun, or quote a line of its output verbatim (16 characters or more); a prose description of what a probe did cites nothing, and the adapter downgrades such a blocker to major.",
    );
  });
  it("V1: pass/probe/inconclusive verdict rules use the new wording, with and without verifyCommands (card codex-review-pass-despite-own-probes)", () => {
    const passSentence =
      "- `pass` only if you tried to break it and could not: every command listed under \"Run these commands\" exited 0, and no command you cite as evidence shows a failure this change caused.";
    const probeSentence =
      "- A probe of your own that could not run for a reason unrelated to the change (a missing tool, a wrong path, a sandbox limit) is not a failure of the change: name it in the summary with its exit code and leave the verdict alone.";
    const inconclusiveSentence =
      "- `inconclusive` only when a command listed under \"Run these commands\" itself could not run (missing dependencies, sandbox limits), or when there were none and you could not run the code at all. Say what you could not run.";
    const withCmds = buildPrompt({ ...base, diff: "", verifyCommands: ["pnpm test"] });
    const without = buildPrompt({ ...base, diff: "" });
    expect(withCmds, "the verdict rules cross-reference step 5's lead-in, so it must keep that exact text").toContain("5. Run these commands and treat a non-zero exit as a blocker:");
    for (const p of [withCmds, without]) {
      expect(p, "pass rule: verdict rules must carry the new `pass` sentence scoping it to Run-these-commands and cited evidence").toContain(passSentence);
      expect(p, "probe rule: a reviewer's own probe failing for an unrelated reason must not lower the verdict").toContain(probeSentence);
      expect(p, "inconclusive rule: `inconclusive` must be scoped to the Run-these-commands list, not any command the reviewer ran").toContain(inconclusiveSentence);
      expect(p, "old pass sentence must be gone: it let an unrelated probe failure sink a pass").not.toContain("and every command you ran exited 0.");
    }
  });
});
