// Conformance to docs/worker-contract.md: every outcome the Codex adapter can produce satisfies
// checkReviewResult, the binary's JSON does too, broken results are reported by rule id, and the
// document names every field and error kind (so it cannot drift from the code).
import { describe, it, expect, beforeAll } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runCodexReview } from "../src/run.js";
import { checkReviewResult, citedCommands, quotesOutput, CONTRACT_RULES, ERROR_KINDS, enforceBlockerEvidence, OUTPUT_CITATION_MIN_CHARS } from "../src/contract.js";
import { exitCodeFor, type ReviewResult } from "../src/schema.js";
import { makeRepo, makeFakeCodex, type FakeMode } from "./helpers.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");

let repo: ReturnType<typeof makeRepo>;
let fake: ReturnType<typeof makeFakeCodex>;
beforeAll(() => {
  repo = makeRepo();
  fake = makeFakeCodex();
});

function review(mode: FakeMode, extra: Partial<Parameters<typeof runCodexReview>[0]> = {}) {
  process.env.FAKE_CODEX_MODE = mode;
  // The mutate mode dirties the repo it runs in, so it gets a fresh one; every other mode shares repo.
  const target = mode === "mutate" ? makeRepo() : repo;
  return runCodexReview({ spec: "add(a, b) must return a + b and be covered by a test.", base: target.base, head: target.head, dir: target.dir, codexBin: fake.bin, verifyCommands: ["node --test"], ...extra });
}

describe("every adapter outcome conforms to the worker contract", () => {
  const cases: [string, () => Promise<ReviewResult>, number][] = [
    ["pass", () => review("ok"), 0],
    ["fail with a blocker", () => review("fail-verdict"), 1],
    ["non-zero exit", () => review("nonzero"), 2],
    ["prose instead of JSON", () => review("prose"), 2],
    ["no final message", () => review("nofinal"), 2],
    ["wrong shape", () => review("bad-shape"), 2],
    ["working tree mutated", () => review("mutate"), 2],
    ["binary not found", () => review("ok", { codexBin: join(fake.bin, "..", "does-not-exist") }), 2],
    ["timeout", () => review("hang", { timeoutMs: 300 }), 2],
  ];
  for (const [name, run, exit] of cases) {
    it(`${name}: no violations, exit ${exit}`, async () => {
      const r = await run();
      expect(checkReviewResult(r)).toEqual([]);
      expect(exitCodeFor(r)).toBe(exit);
      // The result must survive a JSON round trip unchanged in meaning: that is what the workflow reads.
      expect(checkReviewResult(JSON.parse(JSON.stringify(r)))).toEqual([]);
    });
  }
  it("the mutate outcome is void by R10 and lists what changed", async () => {
    const r = await review("mutate");
    expect(r.error?.kind).toBe("worktree-modified");
    expect(r.verdict).toBe("inconclusive");
    expect((r.error as { changes: string[] }).changes.length).toBeGreaterThan(0);
  });
});

describe("the codex-review binary prints a conforming object", () => {
  it("on a pass and on a blocker", () => {
    const binTs = join(here, "..", "src", "bin.ts");
    for (const [mode, exit] of [["ok", 0], ["fail-verdict", 1], ["nonzero", 2]] as const) {
      const r = spawnSync(process.execPath, ["--import", "tsx", binTs, "--base", repo.base, "--head", repo.head, "--dir", repo.dir, "--spec", "-", "--codex", fake.bin], {
        encoding: "utf8",
        input: "add(a, b) must return a + b.",
        env: { ...process.env, FAKE_CODEX_MODE: mode },
        cwd: join(here, ".."),
      });
      expect(r.status).toBe(exit);
      expect(checkReviewResult(JSON.parse(r.stdout))).toEqual([]);
    }
  });
});

describe("broken results are reported by rule id", () => {
  async function good(): Promise<ReviewResult> {
    return review("ok");
  }
  const broken = (patch: (r: any) => void) => good().then((r) => {
    const copy = JSON.parse(JSON.stringify(r));
    patch(copy);
    return checkReviewResult(copy);
  });
  it("R1: a set error must be inconclusive; verdict must be from the enum", async () => {
    expect(await broken((r) => (r.error = { kind: "timeout", message: "x" }))).toContainEqual(expect.stringMatching(/^R1: error is set/));
    expect(await broken((r) => (r.verdict = "maybe"))).toContainEqual(expect.stringMatching(/^R1: verdict/));
  });
  it("R2: issues are typed", async () => {
    expect(await broken((r) => r.issues.push({ severity: "nit", file: "a", description: "d" }))).toContainEqual(expect.stringMatching(/^R2: issues\[0\]\.severity/));
    expect(await broken((r) => r.issues.push({ severity: "minor", file: "a", description: "" }))).toContainEqual(expect.stringMatching(/^R2: issues\[0\]\.description/));
  });
  it("R3: ok must agree with the exit code and exit codes are integers or null", async () => {
    expect(await broken((r) => (r.commandsRun[0].ok = false))).toContainEqual(expect.stringMatching(/^R3: commandsRun\[0\]\.ok is false/));
    expect(await broken((r) => (r.commandsRun[1].exitCode = "3"))).toContainEqual(expect.stringMatching(/^R3: commandsRun\[1\]\.exitCode/));
  });
  it("R4: changedFiles are relative, unique, sorted", async () => {
    expect(await broken((r) => r.changedFiles.push("/abs"))).toContainEqual(expect.stringMatching(/^R4: .*not a relative path/));
    expect(await broken((r) => r.changedFiles.push(r.changedFiles[0]))).toContainEqual(expect.stringMatching(/^R4: changedFiles has duplicates|^R4: changedFiles is not sorted/));
    expect(await broken((r) => r.changedFiles.reverse())).toContainEqual("R4: changedFiles is not sorted");
  });
  it("R5 to R8: identity, error shape, measurements", async () => {
    expect(await broken((r) => (r.dir = "relative/dir"))).toContainEqual("R5: dir must be absolute");
    expect(await broken((r) => (r.sandbox = "danger-full-access"))).toContainEqual(expect.stringMatching(/^R6: sandbox/));
    expect(await broken((r) => { r.verdict = "inconclusive"; r.error = { kind: "meteor", message: "x" }; })).toContainEqual(expect.stringMatching(/^R7: error\.kind/));
    expect(await broken((r) => { r.verdict = "inconclusive"; r.error = { kind: "worktree-modified", message: "x", changes: [] }; })).toContainEqual(expect.stringMatching(/^R7: error\.changes/));
    expect(await broken((r) => (r.durationMs = -1))).toContainEqual("R8: durationMs must be a non-negative integer");
    expect(await broken((r) => (r.usage = { inputTokens: 1.5, outputTokens: 0 }))).toContainEqual(expect.stringMatching(/^R8: usage/));
  });
  it("R9 and R10 are checked through exitCodeFor and the error kind", async () => {
    // R9 is a property of exitCodeFor itself; the checker recomputes the expected code from the fields.
    const r = await good();
    expect(exitCodeFor({ ...r, issues: [{ severity: "blocker", file: "a", description: "d" }] })).toBe(1);
    expect(exitCodeFor({ ...r, verdict: "inconclusive" })).toBe(2);
    expect(await broken((r) => (r.error = { kind: "worktree-modified", message: "x", changes: ["M a"] }))).toContainEqual("R10: a worktree-modified review must be inconclusive");
  });
  it("R12: a blocker cites a command in commandsRun that shows the failure", async () => {
    const blocker = (evidence: string | undefined) => ({ severity: "blocker", file: "src/add.js", line: 2, description: "add(2,2) returns 0", ...(evidence === undefined ? {} : { evidence }) });
    // The fake runs node --test (exit 0, output "ok 1 - add") and node -e "process.exit(3)" (exit 3).
    expect(await broken((r) => r.issues.push(blocker(undefined)))).toContainEqual("R12: issues[0] is a blocker with no evidence; a blocker cites a command in commandsRun that shows the failure");
    expect(await broken((r) => r.issues.push(blocker("the loop bound at line 2 is off by one")))).toContainEqual("R12: issues[0] is a blocker whose evidence names no command in commandsRun and quotes no line of any command's output; static inspection alone is major at most");
    expect(await broken((r) => r.issues.push(blocker("node --test looks wrong to me")))).toContainEqual('R12: issues[0] cites "node --test", which exited 0, and quotes none of its output');
    expect((await broken((r) => r.issues.push(blocker('node -e "process.exit(3)" exited 3')))).filter((v) => v.startsWith("R12"))).toEqual([]);
    expect((await broken((r) => r.issues.push(blocker("node --test printed: ok 1 - add, yet the spec wants a failure")))).filter((v) => v.startsWith("R12"))).toEqual([]);
    expect((await broken((r) => r.issues.push(blocker("/bin/zsh -lc 'node -e \"process.exit(3)\"' exit 3")))).filter((v) => v.startsWith("R12"))).toEqual([]);
    // Majors and minors need no command: static inspection is their place.
    expect((await broken((r) => r.issues.push({ severity: "major", file: "src/add.js", description: "no test covers the empty input", evidence: "static inspection" }))).filter((v) => v.startsWith("R12"))).toEqual([]);
    const cmds = [{ command: "/bin/zsh -lc 'pnpm test'", exitCode: 1, ok: false }, { command: "git status", exitCode: 0, ok: true, outputTail: "M src/a.ts\n" }];
    expect(citedCommands("pnpm test exited 1", cmds).map((c) => c.command)).toEqual(["/bin/zsh -lc 'pnpm test'"]);
    expect(citedCommands("git status shows M src/a.ts", cmds).map((c) => c.command)).toEqual(["git status"]);
    expect(citedCommands("nothing here", cmds)).toEqual([]);
    expect(quotesOutput("git status shows M src/a.ts", "M src/a.ts\n")).toBe(true);
    expect(quotesOutput("git status shows nothing", "M src/a.ts\n")).toBe(false);
  });
  it("R12 (C9): downgraded must be well-formed: integer index pointing at a major issue, non-empty reason", async () => {
    expect(await broken((r) => {
      r.issues.push({ severity: "major", file: "src/add.js", description: "d" });
      r.downgraded = [{ index: "0", reason: "R12: evidence-free" }];
    })).toContainEqual(expect.stringMatching(/^R12/));
    expect(await broken((r) => {
      r.issues.push({ severity: "minor", file: "src/add.js", description: "d" });
      r.downgraded = [{ index: r.issues.length - 1, reason: "R12: evidence-free" }];
    })).toContainEqual(expect.stringMatching(/^R12/));
    expect(await broken((r) => {
      r.issues.push({ severity: "major", file: "src/add.js", description: "d" });
      r.downgraded = [{ index: r.issues.length - 1, reason: "" }];
    })).toContainEqual(expect.stringMatching(/^R12/));
  });
  it("R11: marker is present and typed", async () => {
    expect(await broken((r) => (r.marker.passed = "yes"))).toContainEqual(expect.stringMatching(/^R11: marker\.passed/));
    expect(await broken((r) => delete r.marker)).toContainEqual(expect.stringMatching(/^R11: marker must be an object/));
  });
  it("R13: a well-formed partial passes", async () => {
    const r = await good();
    const withPartial = {
      ...r,
      verdict: "inconclusive",
      partial: true,
      handoff: { completed: ["src/add.ts"], remaining: ["finish src/sub.ts"], next: "write the sub test", verify: "pnpm exec vitest run sub.test.ts" },
    };
    expect(checkReviewResult(withPartial)).toEqual([]);
  });
  it("R13: partial true with no handoff, empty remaining, empty next/verify, or verdict pass each name R13", async () => {
    const r = await good();
    const base = { ...r, verdict: "inconclusive", partial: true };
    expect(checkReviewResult({ ...base })).toContainEqual(expect.stringMatching(/^R13/));
    expect(checkReviewResult({ ...base, handoff: { completed: [], remaining: [], next: "x", verify: "y" } })).toContainEqual(expect.stringMatching(/^R13/));
    expect(checkReviewResult({ ...base, handoff: { completed: [], remaining: ["r"], next: "", verify: "y" } })).toContainEqual(expect.stringMatching(/^R13/));
    expect(checkReviewResult({ ...base, handoff: { completed: [], remaining: ["r"], next: "x", verify: "" } })).toContainEqual(expect.stringMatching(/^R13/));
    expect(
      checkReviewResult({ ...r, verdict: "pass", partial: true, handoff: { completed: [], remaining: ["r"], next: "x", verify: "y" } })
    ).toContainEqual(expect.stringMatching(/^R13/));
  });
  it("R13: partial false or absent with no handoff passes", async () => {
    const r = await good();
    expect(checkReviewResult({ ...r, partial: false })).toEqual([]);
    expect(checkReviewResult(r)).toEqual([]);
  });
  it("rejects non-objects", () => {
    expect(checkReviewResult(null)).toEqual(["R1: result is not an object"]);
    expect(checkReviewResult([])).toEqual(["R1: result is not an object"]);
  });
});

describe("enforceBlockerEvidence: downgrades an R12-invalid blocker to major (C1-C7)", () => {
  function baseResult(overrides: Partial<ReviewResult> = {}): ReviewResult {
    return {
      verdict: "fail",
      summary: "s",
      issues: [],
      commandsRun: [],
      changedFiles: [],
      base: "main",
      head: "fix",
      dir: "/repo",
      reviewer: "codex",
      model: null,
      sandbox: "workspace-write",
      error: null,
      codexExitCode: 0,
      durationMs: 1,
      usage: null,
      marker: { name: "DOUG_CODEX_REVIEW", passed: true, inherited: false },
      ...overrides,
    };
  }

  it("C1: a blocker with no evidence is downgraded to major, description prefixed, and listed in downgraded", () => {
    const r = baseResult({
      issues: [{ severity: "blocker", file: "src/add.js", line: 2, description: "add(2,2) returns 0" }],
      commandsRun: [{ command: "node --test", exitCode: 0, ok: true, outputTail: "ok 1 - add\n" }],
    });
    const out = enforceBlockerEvidence(r);
    expect(out.issues[0].severity).toBe("major");
    expect(out.issues[0].description).toMatch(/^\[codex-review: downgraded from blocker, R12: .+\] add\(2,2\) returns 0$/);
    expect(out.downgraded).toEqual([{ index: 0, reason: expect.any(String) }]);
    expect((out.downgraded as any)[0].reason.length).toBeGreaterThan(0);
  });

  it("C2: a blocker whose evidence names no recorded command is downgraded to major", () => {
    const r = baseResult({
      issues: [{ severity: "blocker", file: "src/add.js", description: "d", evidence: "the loop bound at line 2 is off by one" }],
      commandsRun: [{ command: "node --test", exitCode: 0, ok: true, outputTail: "ok 1 - add\n" }],
    });
    const out = enforceBlockerEvidence(r);
    expect(out.issues[0].severity).toBe("major");
    expect(out.downgraded).toHaveLength(1);
  });

  it("C3: a blocker citing a command that exited 0 without quoting its output is downgraded to major", () => {
    const r = baseResult({
      issues: [{ severity: "blocker", file: "src/add.js", description: "d", evidence: "node --test looks wrong to me" }],
      commandsRun: [{ command: "node --test", exitCode: 0, ok: true, outputTail: "ok 1 - add\n" }],
    });
    const out = enforceBlockerEvidence(r);
    expect(out.issues[0].severity).toBe("major");
    expect(out.downgraded).toHaveLength(1);
  });

  it("C4: a blocker citing a command that exited non-zero stays a blocker; downgraded is absent", () => {
    const r = baseResult({
      issues: [{ severity: "blocker", file: "src/add.js", description: "d", evidence: 'node -e "process.exit(3)" exited 3' }],
      commandsRun: [{ command: '/bin/zsh -lc \'node -e "process.exit(3)"\'', exitCode: 3, ok: false }],
    });
    const out = enforceBlockerEvidence(r);
    expect(out.issues[0].severity).toBe("blocker");
    expect(out.issues[0].description).toBe("d");
    expect(out.downgraded).toBeUndefined();
  });

  it("C5: a blocker citing an exit-0 command and quoting a line of its output stays a blocker", () => {
    const r = baseResult({
      issues: [{ severity: "blocker", file: "src/add.js", description: "d", evidence: "node --test printed: ok 1 - add, yet the spec wants a failure" }],
      commandsRun: [{ command: "node --test", exitCode: 0, ok: true, outputTail: "ok 1 - add\n" }],
    });
    const out = enforceBlockerEvidence(r);
    expect(out.issues[0].severity).toBe("blocker");
    expect(out.downgraded).toBeUndefined();
  });

  it("C6: a downgraded issue is kept (issue count unchanged, file/line/evidence unchanged)", () => {
    const r = baseResult({
      issues: [
        { severity: "blocker", file: "src/add.js", line: 2, description: "d", evidence: "static inspection" },
        { severity: "minor", file: "b.js", description: "other" },
      ],
      commandsRun: [{ command: "node --test", exitCode: 0, ok: true, outputTail: "ok 1 - add\n" }],
    });
    const out = enforceBlockerEvidence(r);
    expect(out.issues).toHaveLength(2);
    expect(out.issues[0].file).toBe("src/add.js");
    expect(out.issues[0].line).toBe(2);
    expect(out.issues[0].evidence).toBe("static inspection");
    expect(out.issues[1]).toEqual(r.issues[1]);
  });

  it("C7: fail with all blockers downgraded becomes pass; fail with a valid blocker left stays fail; inconclusive is never changed", () => {
    const allDowngraded = baseResult({
      verdict: "fail",
      issues: [{ severity: "blocker", file: "a", description: "d" }],
    });
    expect(enforceBlockerEvidence(allDowngraded).verdict).toBe("pass");

    const oneValid = baseResult({
      verdict: "fail",
      issues: [
        { severity: "blocker", file: "a", description: "d1" },
        { severity: "blocker", file: "b", description: "d2", evidence: "cmd exited 3" },
      ],
      commandsRun: [{ command: "cmd", exitCode: 3, ok: false }],
    });
    expect(enforceBlockerEvidence(oneValid).verdict).toBe("fail");

    const inconclusive = baseResult({
      verdict: "inconclusive",
      issues: [{ severity: "blocker", file: "a", description: "d" }],
    });
    expect(enforceBlockerEvidence(inconclusive).verdict).toBe("inconclusive");
  });

  it("T1: a blocker citing a command with exitCode null is still downgraded, named 'did not complete', not 'exited 0'", () => {
    const r = baseResult({
      issues: [{ severity: "blocker", file: "src/add.js", description: "d", evidence: "pnpm test:unit never came back" }],
      commandsRun: [{ command: "pnpm test:unit", exitCode: null, ok: false }],
    });
    const out = enforceBlockerEvidence(r);
    expect(out.issues[0].severity).toBe("major");
    expect(out.downgraded).toHaveLength(1);
    const reason = (out.downgraded as any)[0].reason as string;
    expect(reason).toContain("which did not complete");
    expect(reason).not.toContain("exited 0");
    expect(out.issues[0].description).toContain("which did not complete");
    expect(out.issues[0].description).not.toContain("exited 0");
  });

  it("T2: mixed evidence citing an exit-0 command and a never-completed command names each truthfully", () => {
    const r = baseResult({
      issues: [{ severity: "blocker", file: "src/add.js", description: "d", evidence: "node --test and pnpm test:unit both look suspicious" }],
      commandsRun: [
        { command: "node --test", exitCode: 0, ok: true, outputTail: "ok 1 - add\n" },
        { command: "pnpm test:unit", exitCode: null, ok: false },
      ],
    });
    const out = enforceBlockerEvidence(r);
    const reason = (out.downgraded as any)[0].reason as string;
    expect(reason).toBe('cites "node --test", which exited 0, "pnpm test:unit", which did not complete, and quotes none of its output');
  });

  it("does not mutate the input", () => {
    const r = baseResult({ issues: [{ severity: "blocker", file: "a", description: "d" }] });
    const before = JSON.parse(JSON.stringify(r));
    enforceBlockerEvidence(r);
    expect(r).toEqual(before);
  });

  it("C10: fail with only a major issue and nothing downgraded stays fail; same for fail with issues: []", () => {
    const withMajor = baseResult({
      verdict: "fail",
      issues: [{ severity: "major", file: "a", description: "d" }],
    });
    const outMajor = enforceBlockerEvidence(withMajor);
    expect(outMajor.verdict).toBe("fail");
    expect(outMajor.downgraded).toBeUndefined();
    expect(exitCodeFor(outMajor)).toBe(1);

    const withNoIssues = baseResult({ verdict: "fail", issues: [] });
    const outNoIssues = enforceBlockerEvidence(withNoIssues);
    expect(outNoIssues.verdict).toBe("fail");
    expect(outNoIssues.downgraded).toBeUndefined();
    expect(exitCodeFor(outNoIssues)).toBe(1);
  });

  it("C11: a minor issue at index 0 and an evidence-free blocker at index 1 downgrades only index 1", () => {
    const r = baseResult({
      issues: [
        { severity: "minor", file: "a", description: "minor note" },
        { severity: "blocker", file: "b", description: "d" },
      ],
    });
    const out = enforceBlockerEvidence(r);
    expect(out.downgraded).toEqual([{ index: 1, reason: expect.any(String) }]);
    expect(out.issues[1].severity).toBe("major");
    expect(out.issues[0]).toEqual(r.issues[0]);
  });
});

describe("card codex-review-r12-prose-evidence", () => {
  function baseResult(overrides: Partial<ReviewResult> = {}): ReviewResult {
    return {
      verdict: "fail",
      summary: "s",
      issues: [],
      commandsRun: [],
      changedFiles: [],
      base: "main",
      head: "fix",
      dir: "/repo",
      reviewer: "codex",
      model: null,
      sandbox: "workspace-write",
      error: null,
      codexExitCode: 0,
      durationMs: 1,
      usage: null,
      marker: { name: "DOUG_CODEX_REVIEW", passed: true, inherited: false },
      ...overrides,
    };
  }

  // The real 2026-09-17 recipe-skills evidence and recorded command (Facts in the brief), shortened but
  // keeping the double-quoted-wrapper shape that made innerCommand() a no-op (contract.ts:33-36).
  const proseEvidence =
    'A Node probe created package.json with `scripts:{dev:"",release:""}`, ran detect and generateSkills, and exited 1 after printing `{"detectedScripts":{"dev":"","release":""},"paths":[".claude/skills/doug-skills/SKILL.md"]}`.';
  const outputLine = '{"detectedScripts":{"dev":"","release":""},"paths":[".claude/skills/doug-skills/SKILL.md"]}';
  const wrapperCommand = '/bin/zsh -lc "node --input-type=module -e \'import { mkdtempSync, writeFileSync } from "node:fs"; ... console.log(JSON.stringify({detectedScripts:d.node.scripts,paths}));\'"';

  it("P1: the real recipe-skills shape stays a blocker once output citation counts (red today: downgraded by reason B)", () => {
    const r = baseResult({
      issues: [{ severity: "blocker", file: "src/x.ts", description: "d", evidence: proseEvidence }],
      commandsRun: [{ command: wrapperCommand, exitCode: 1, ok: false, outputTail: outputLine + "\n" }],
    });
    const out = enforceBlockerEvidence(r);
    expect(out.issues[0].severity, "P1 (R12 output-citation): a blocker whose prose evidence quotes a >=16-char output line must stay a blocker").toBe("blocker");
    expect(out.verdict, "P1 (R12 output-citation): verdict fail must stay fail when the blocker is not downgraded").toBe("fail");
    expect(out.downgraded, "P1 (R12 output-citation): no downgraded entry once output citation counts as evidence").toBeUndefined();
    expect(checkReviewResult(r), "P1 (R12 output-citation): checkReviewResult must report no R12 violation for this shape").not.toContainEqual(expect.stringMatching(/^R12/));
  });

  it("P2: evidence naming no command and quoting no output is downgraded with the new reason B text", () => {
    const r = baseResult({
      issues: [{ severity: "blocker", file: "src/x.ts", description: "d", evidence: "A Node probe ran detect and exited 1." }],
      commandsRun: [{ command: wrapperCommand, exitCode: 1, ok: false, outputTail: outputLine + "\n" }],
    });
    const out = enforceBlockerEvidence(r);
    expect(out.issues[0].severity, "P2 (R12 reason B): evidence with no command and no quoted output is downgraded to major").toBe("major");
    expect((out.downgraded as any)[0].reason, "P2 (R12 reason B): the downgraded reason must use the new wording naming both command and output").toBe(
      "is a blocker whose evidence names no command in commandsRun and quotes no line of any command's output; static inspection alone is major at most",
    );
  });

  it("P3: a quoted output line under the 16-char floor cites nothing; at or above it, it cites a non-zero-exit command", () => {
    const under = baseResult({
      issues: [{ severity: "blocker", file: "src/x.ts", description: "d", evidence: "the probe printed ok 1 and all good, yet the spec wants a failure" }],
      commandsRun: [{ command: "some-command", exitCode: 1, ok: false, outputTail: "ok 1\nall good\n" }],
    });
    const underOut = enforceBlockerEvidence(under);
    expect(underOut.issues[0].severity, "P3 (OUTPUT_CITATION_MIN_CHARS floor): a quoted output line under 16 squashed characters cites no command").toBe("major");

    const atFloor = baseResult({
      issues: [{ severity: "blocker", file: "src/x.ts", description: "d", evidence: "the probe printed all good, twelve chars, then exited" }],
      commandsRun: [{ command: "some-command", exitCode: 1, ok: false, outputTail: "all good, twelve chars\n" }],
    });
    const atFloorOut = enforceBlockerEvidence(atFloor);
    expect(atFloorOut.issues[0].severity, "P3 (OUTPUT_CITATION_MIN_CHARS floor): a quoted output line at/above 16 chars cites the command that exited non-zero, staying a blocker").toBe("blocker");
  });

  it("P4: a >=16-char quoted output line proves the failure even when the cited command exited 0", () => {
    const r = baseResult({
      issues: [{ severity: "blocker", file: "src/x.ts", description: "d", evidence: "printed all good, twelve chars, yet the spec wants a failure" }],
      commandsRun: [{ command: "some-command", exitCode: 0, ok: true, outputTail: "all good, twelve chars\n" }],
    });
    const out = enforceBlockerEvidence(r);
    expect(out.issues[0].severity, "P4 (R12 output-citation): a >=16-char quoted output line is proof on its own, independent of the cited command's own exit code").toBe("blocker");
    expect(out.downgraded, "P4 (R12 output-citation): no downgrade when the quoted output line proves the failure").toBeUndefined();
  });

  it("P5: citedCommands and quotesOutput honor OUTPUT_CITATION_MIN_CHARS", () => {
    const cmds = [{ command: "some-command", exitCode: 1, outputTail: "all good, twelve chars\n" }];
    expect(citedCommands("printed all good, twelve chars here", cmds).map((c) => c.command), "P5 (citedCommands): a >=16-char quoted output line cites the command even though the evidence names it nowhere").toEqual(["some-command"]);
    const shortCmds = [{ command: "some-command", exitCode: 1, outputTail: "ok 1\n" }];
    expect(citedCommands("it printed ok 1 and failed", shortCmds), "P5 (citedCommands): a quoted output line under 16 chars does not cite the command by itself").toEqual([]);
    expect(quotesOutput("printed all good, twelve chars here", "all good, twelve chars\n", 16), "P5 (quotesOutput minChars=16): true for a >=16-char quoted line").toBe(true);
    expect(quotesOutput("it printed ok 1 and failed", "ok 1\n", 16), "P5 (quotesOutput minChars=16): false for an under-16-char quoted line").toBe(false);
    expect(quotesOutput("it printed ok 1 and failed", "ok 1\n"), "P5 (quotesOutput default floor): still true at the existing 4-char floor when minChars is omitted").toBe(true);
  });

  it("P5b: OUTPUT_CITATION_MIN_CHARS is pinned at 16, with a boundary pair through citedCommands", () => {
    expect(OUTPUT_CITATION_MIN_CHARS, "P5b (OUTPUT_CITATION_MIN_CHARS): the output-citation floor constant must be exactly 16").toBe(16);
    const under = [{ command: "some-command", exitCode: 1, outputTail: "exactly15chars!\n" }];
    expect(
      citedCommands("it printed exactly15chars! and failed", under),
      "P5b (boundary, 15 squashed chars): one character under the floor cites nothing",
    ).toEqual([]);
    const atFloor = [{ command: "some-command", exitCode: 1, outputTail: "exactly16chars!!\n" }];
    expect(
      citedCommands("it printed exactly16chars!! and failed", atFloor).map((c) => c.command),
      "P5b (boundary, 16 squashed chars): exactly at the floor cites the command",
    ).toEqual(["some-command"]);
  });

  it("P6: CONTRACT_RULES.R12 and docs/worker-contract.md state the output-citation rule", () => {
    expect(CONTRACT_RULES.R12, "P6 (R12 rule text): must state that evidence can cite via a quoted output line").toContain("or quotes a line of that command's output");
    const doc = readFileSync(join(root, "docs/worker-contract.md"), "utf8");
    expect(doc, "P6 (worker-contract.md item 8): must state the 16-character output-quoting floor").toContain("quote a line of at least 16 characters");
  });
});

describe("checkReviewResult: downgraded shape (C12)", () => {
  async function good(): Promise<ReviewResult> {
    return review("ok");
  }
  it("C12: rejects downgraded that is not an array", async () => {
    const r = await good();
    for (const bad of [{ index: 0, reason: "x" }, "nope"]) {
      const copy = JSON.parse(JSON.stringify(r));
      copy.downgraded = bad;
      expect(checkReviewResult(copy)).toContainEqual(expect.stringMatching(/^R12/));
    }
  });
  it("C12: rejects a downgraded entry that is not an object", async () => {
    const r = await good();
    for (const bad of [1, null]) {
      const copy = JSON.parse(JSON.stringify(r));
      copy.downgraded = [bad];
      expect(checkReviewResult(copy)).toContainEqual(expect.stringMatching(/^R12/));
    }
  });
});

describe("docs/worker-contract.md names every field, error kind, and rule", () => {
  const doc = readFileSync(join(root, "docs/worker-contract.md"), "utf8");
  it("fields", async () => {
    const r = await review("ok");
    for (const field of Object.keys(r)) expect(doc, `field ${field}`).toContain(`\`${field}\``);
  });
  it("error kinds and rule ids", () => {
    for (const kind of ERROR_KINDS) expect(doc, `kind ${kind}`).toContain(`\`${kind}\``);
    for (const id of Object.keys(CONTRACT_RULES)) expect(doc, `rule ${id}`).toMatch(new RegExp(`\\b${id}\\b`));
  });
});
