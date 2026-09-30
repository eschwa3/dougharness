// specHash, reusePlan, staleReuseErrors, and the plan.mjs replan CLI: reusing tasks that already passed
// verify, review, and adversary in a prior workflow report instead of re-implementing them.
import { describe, it, expect } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPlan, savePlan, validatePlan, renderPlan, specHash, reusePlan, staleReuseErrors, unwrapReport } from "../lib/plan.mjs";

const git = (dir, ...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, "..", "scripts", "plan.mjs");
const run = (args, dir) => spawnSync(process.execPath, [cli, ...args, dir], { encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: "" } });

function task(id, overrides = {}) {
  return { id, title: id.toUpperCase(), spec: `Do the thing for ${id} with a test.`, files: [`src/${id}.ts`], ...overrides };
}

function plan(overrides = {}) {
  return {
    version: 1,
    title: "Replan sample",
    goal: "A goal that explains the change in enough words.",
    status: "draft",
    acceptance: ["ok"],
    verify: ["true"],
    tasks: [task("a"), task("b"), task("c", { dependsOn: ["b"] })],
    ...overrides,
  };
}

function project() {
  const dir = mkdtempSync(join(tmpdir(), "doug-replan-"));
  mkdirSync(join(dir, ".doug"), { recursive: true });
  savePlan(dir, plan());
  return dir;
}

function gitProject() {
  const dir = mkdtempSync(join(tmpdir(), "doug-replan-git-"));
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@example.com");
  git(dir, "config", "user.name", "t");
  writeFileSync(join(dir, "README.md"), "readme\n");
  writeFileSync(join(dir, ".gitignore"), ".doug/.state/\n.claude/worktrees/\n");
  mkdirSync(join(dir, ".doug"), { recursive: true });
  savePlan(dir, plan());
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "base");

  for (const b of ["doug/task-a", "doug/task-b", "doug/task-c"]) {
    git(dir, "checkout", "-q", "-b", b);
    writeFileSync(join(dir, `${b.replace(/\//g, "-")}.txt`), "x\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", b);
    git(dir, "checkout", "-q", "main");
  }
  git(dir, "checkout", "-q", "-b", "feature/x");
  writeFileSync(join(dir, "feature-x.txt"), "x\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "feature/x");
  git(dir, "checkout", "-q", "main");
  git(dir, "branch", "doug/a-b-c", "main");

  mkdirSync(join(dir, ".claude/worktrees"), { recursive: true });
  git(dir, "worktree", "add", "-q", join(dir, ".claude/worktrees/wf_a"), "doug/task-a");
  git(dir, "worktree", "add", "-q", join(dir, ".claude/worktrees/wf_b"), "doug/task-b");
  git(dir, "worktree", "add", "-q", join(dir, ".claude/worktrees/wf_c"), "doug/task-c");
  writeFileSync(join(dir, ".claude/worktrees/wf_c/untracked.txt"), "keep me\n");
  git(dir, "worktree", "add", "-q", join(dir, ".claude/worktrees/other"), "feature/x");
  git(dir, "worktree", "add", "-q", join(dir, ".claude/worktrees/doug-integration"), "doug/a-b-c");

  return dir;
}

function report(dir, tasksById) {
  mkdirSync(join(dir, ".doug/.state"), { recursive: true });
  writeFileSync(
    join(dir, ".doug/.state/last-report.json"),
    JSON.stringify({ levels: [{ tasks: Object.entries(tasksById).map(([id, t]) => ({ id, ...t })) }] })
  );
}

function passedEntry(t, branch = `doug/task-${t.id}`) {
  return { branch, implemented: true, verified: true, reviewed: true, adversary: { ran: true, blocked: false }, specHash: specHash(t) };
}

// A task whose stage threw (card integration-worktree-stale): the implementer may have committed real work on
// its branch, but nothing verified, reviewed, or recorded a commit for it, so the report carries the branch it
// would have used with implemented: false and the throw reason as blockedReason (the shape the workflow's
// threwFallback actually emits).
function threwEntry(t, branch = `doug/task-${t.id}`) {
  return { branch, implemented: false, blockedReason: "task stage threw (agent error, unknown agent type, or user skip)" };
}

describe("specHash", () => {
  it("is stable for an equal task and changes when spec, files, or verify change", () => {
    const t = task("a", { verify: "pnpm test" });
    expect(specHash(t)).toBe(specHash({ ...t }));
    expect(specHash(t)).not.toBe(specHash({ ...t, spec: t.spec + " more" }));
    expect(specHash(t)).not.toBe(specHash({ ...t, files: [...t.files, "extra.ts"] }));
    expect(specHash(t)).not.toBe(specHash({ ...t, verify: "pnpm test2" }));
  });
});

// Card report-save-wrapper: the Workflow tool's own output is { summary, agentCount, logs, result, ... }; the
// report every reader expects is `result`. unwrapReport(obj) returns obj.result only when obj itself carries no
// array `levels` and obj.result is a non-null object that does carry an array `levels`; otherwise obj unchanged.
describe("unwrapReport", () => {
  it("MU: unwraps a Workflow-tool wrapper (no own levels, result has a levels array) to its result", () => {
    const result = { ok: true, levels: [{ tasks: [] }] };
    const wrapper = { summary: "x", agentCount: 1, logs: [], result };
    // toBe, not toEqual: a mutant that returns `obj` always (MU) would fail this reference check even though
    // result and wrapper happen to differ in shape.
    expect(unwrapReport(wrapper)).toBe(result);
  });

  it("a bare report (its own array levels) is returned unchanged", () => {
    const bare = { ok: true, levels: [] };
    expect(unwrapReport(bare)).toBe(bare);
  });

  it("MU2a: a bare report that happens to carry a stray `result` key stays unchanged (it has its own levels array)", () => {
    const bare = { ok: true, levels: [], result: { foo: "bar" } };
    // A mutant that unwraps whenever `result` exists, dropping the "no own levels" check, would return
    // bare.result ({ foo: "bar" }) instead of bare itself.
    expect(unwrapReport(bare)).toBe(bare);
  });

  it("MU2b: a wrapper whose result has no array levels stays unchanged", () => {
    const wrapper = { summary: "x", agentCount: 1, logs: [], result: { ok: true } };
    // A mutant that unwraps whenever `result` exists, dropping the "result has levels" check, would return
    // wrapper.result ({ ok: true }) instead of wrapper itself.
    expect(unwrapReport(wrapper)).toBe(wrapper);
  });

  it("MU2c: null is returned unchanged", () => {
    expect(unwrapReport(null)).toBeNull();
  });

  it("MU2d: a non-object is returned unchanged", () => {
    expect(unwrapReport("not an object")).toBe("not an object");
    expect(unwrapReport(42)).toBe(42);
  });

  it("M6: a wrapper whose result is null is returned unchanged, not thrown on (card report-unwrap-cli-and-evals)", () => {
    // Pins existing behaviour: the `result &&` guard short-circuits before `typeof result.levels` would throw on
    // null. Passes already at HEAD; M6 (dropping that guard) makes it throw instead.
    const wrapper = { summary: "x", result: null };
    expect(unwrapReport(wrapper)).toBe(wrapper);
  });
});

describe("reusePlan", () => {
  it("marks a as reusable, clears b (adversary blocked, and a pre-existing reuse mark), and gives c the dependency reason", () => {
    const p = plan({ tasks: [task("a"), task("b", { reuse: "doug/stale" }), task("c", { dependsOn: ["b"] })] });
    const r = {
      levels: [
        {
          tasks: [
            { id: "a", ...passedEntry(task("a")) },
            { id: "b", ...passedEntry(task("b")), adversary: { ran: true, blocked: true, summary: "found a bug" } },
            { id: "c", ...passedEntry(task("c", { dependsOn: ["b"] })) },
          ],
        },
      ],
    };
    const { plan: next, decisions } = reusePlan(p, r);
    const byId = Object.fromEntries(decisions.map((d) => [d.id, d]));
    expect(byId.a.reuse).toBe("doug/task-a");
    expect(byId.b.reuse).toBeNull();
    expect(byId.b.reason).toContain("adversary blocked: found a bug");
    expect(byId.c.reuse).toBeNull();
    expect(byId.c.reason).toBe("depends on b, which is not reused");
    expect(next.tasks.find((t) => t.id === "a").reuse).toBe("doug/task-a");
    expect(next.tasks.find((t) => t.id === "b").reuse).toBeUndefined();
    expect(next.tasks.find((t) => t.id === "c").reuse).toBeUndefined();
    expect(next.status).toBe("draft");
  });

  it("reuses a task that passed after retries, and treats an exhausted-attempts task as fresh with its final reason", () => {
    const p = plan({ tasks: [task("a"), task("b")] });
    const r = {
      levels: [
        {
          tasks: [
            { id: "a", ...passedEntry(task("a")), attempts: [{}, {}], stopReason: null },
            { id: "b", ...passedEntry(task("b")), verified: false, stopReason: "verification failed; fix attempts exhausted (2 of 2)" },
          ],
        },
      ],
    };
    const { decisions } = reusePlan(p, r);
    const byId = Object.fromEntries(decisions.map((d) => [d.id, d]));
    expect(byId.a.reuse).toBe("doug/task-a");
    expect(byId.b.reuse).toBeNull();
    expect(byId.b.reason).toBe("verification failed");
  });

  it("reuses a branch whose head passed every stage on an earlier pass when the final pass did not (run wf_7092b963-6a5)", () => {
    const p = plan({ tasks: [task("a"), task("b"), task("c"), task("d")] });
    const green = (pass, commit) => ({ pass, commit, verified: true, reviewed: true, adversary: { ran: true, verdict: "pass", blocked: false } });
    const blockedPass = (pass, commit) => ({ pass, commit, verified: true, reviewed: true, adversary: { ran: true, verdict: "fail", blocked: true } });
    const none = (pass, commit) => ({ pass, commit, verified: false, reviewed: false, adversary: null });
    const r = {
      levels: [
        {
          tasks: [
            // a: pass 2 passed on c2; pass 3 was a fix that made no commit and ran no stage. The head is still c2.
            { id: "a", ...passedEntry(task("a")), verified: false, reviewed: false, adversary: null, commit: "c2", attempts: [blockedPass(1, "c1"), green(2, "c2"), none(3, "c2")], stopReason: "a fixed finding reappeared: F1; stopped: fix pass 3 made no new commit on doug/task-a" },
            // b: pass 2 passed on c2, but pass 3 committed c3 and failed verify; the head no longer matches.
            { id: "b", ...passedEntry(task("b")), verified: false, commit: "c3", attempts: [green(2, "c2"), { ...none(3, "c3"), reviewed: true }], stopReason: "verification failed; fix attempts exhausted (3 of 3)" },
            // c: the head's own pass was blocked by the adversary; nothing earlier passed on it.
            { id: "c", ...passedEntry(task("c")), adversary: { ran: true, blocked: true, summary: "x" }, commit: "c2", attempts: [blockedPass(2, "c2")] },
            // d: no commit recorded, so no pass can be tied to the head.
            { id: "d", ...passedEntry(task("d")), verified: false, attempts: [green(1, "c1")] },
          ],
        },
      ],
    };
    const { plan: next, decisions } = reusePlan(p, r);
    const byId = Object.fromEntries(decisions.map((d) => [d.id, d]));
    expect(byId.a.reuse).toBe("doug/task-a");
    expect(byId.a.reason).toBe("passed verify, review, and adversary on pass 2 of the last run; the branch head c2 is unchanged since");
    expect(next.tasks.find((t) => t.id === "a").reuse).toBe("doug/task-a");
    expect(byId.b.reuse).toBeNull();
    expect(byId.b.reason).toBe("verification failed");
    expect(byId.c.reuse).toBeNull();
    expect(byId.c.reason).toBe("adversary blocked: x");
    expect(byId.d.reuse).toBeNull();
    expect(byId.d.reason).toBe("verification failed");
  });

  it("reuses a task whose last good state came through a fix pass: the fix pass's focused check stands in for verify and review", () => {
    const p = plan({ tasks: [task("a")] });
    const r = {
      levels: [
        {
          tasks: [
            {
              id: "a",
              ...passedEntry(task("a")),
              commit: "c2",
              verified: false,
              reviewed: false,
              adversary: null,
              attempts: [
                { pass: 1, stages: ["implement", "verify", "review", "adversary"], commit: "c1", verified: true, reviewed: true, adversary: { ran: true, blocked: true, summary: "found a bug" } },
                { pass: 2, stages: ["fix", "check", "adversary"], commit: "c2", verified: true, reviewed: true, adversary: { ran: true, blocked: false } },
                { pass: 3, stages: ["fix"], commit: "c2", verified: false, reviewed: false, adversary: null },
              ],
            },
          ],
        },
      ],
    };
    const { decisions } = reusePlan(p, r);
    const byId = Object.fromEntries(decisions.map((d) => [d.id, d]));
    expect(byId.a.reuse).toBe("doug/task-a");
    expect(byId.a.reason).toContain("pass 2");
  });

  it("does not reuse a task whose focused check failed on the head pass", () => {
    const p = plan({ tasks: [task("a")] });
    const r = {
      levels: [
        {
          tasks: [
            {
              id: "a",
              ...passedEntry(task("a")),
              commit: "c2",
              verified: false,
              reviewed: false,
              adversary: null,
              attempts: [
                { pass: 1, stages: ["implement", "verify", "review", "adversary"], commit: "c1", verified: true, reviewed: true, adversary: { ran: true, blocked: true, summary: "found a bug" } },
                // adversary ran and did not block here: the check itself (verified/reviewed false) must be the only
                // thing disqualifying this pass, or the test would lock nothing (a mutated passedAttempt that drops
                // the verified/reviewed check would still be rejected by the adversary condition, and pass 1 is
                // already excluded by its commit not being the head).
                { pass: 2, stages: ["fix", "check", "adversary"], commit: "c2", verified: false, reviewed: false, adversary: { ran: true, blocked: false } },
              ],
            },
          ],
        },
      ],
    };
    const { decisions } = reusePlan(p, r);
    expect(decisions[0].reuse).toBeNull();
    expect(decisions[0].reason).toBe("verification failed");
  });

  it("does not reuse a task whose adversary blocked on the head pass", () => {
    const p = plan({ tasks: [task("a")] });
    const r = {
      levels: [
        {
          tasks: [
            {
              id: "a",
              ...passedEntry(task("a")),
              commit: "c2",
              verified: true,
              reviewed: true,
              adversary: { ran: true, blocked: true, summary: "regression" },
              attempts: [
                { pass: 1, stages: ["implement", "verify", "review", "adversary"], commit: "c1", verified: true, reviewed: true, adversary: { ran: true, blocked: true, summary: "found a bug" } },
                { pass: 2, stages: ["fix", "check", "adversary"], commit: "c2", verified: true, reviewed: true, adversary: { ran: true, blocked: true, summary: "regression" } },
              ],
            },
          ],
        },
      ],
    };
    const { decisions } = reusePlan(p, r);
    expect(decisions[0].reuse).toBeNull();
    expect(decisions[0].reason).toBe("adversary blocked: regression");
  });

  it("with plan.adversary === false, a task with adversary: null is reused", () => {
    const p = plan({ adversary: false, tasks: [task("a")] });
    const r = { levels: [{ tasks: [{ id: "a", branch: "doug/task-a", implemented: true, verified: true, reviewed: true, adversary: null, specHash: specHash(task("a")) }] }] };
    const { decisions } = reusePlan(p, r);
    expect(decisions[0].reuse).toBe("doug/task-a");
  });

  it("gives a spec-changed reason when the recorded specHash differs from the current task", () => {
    const p = plan({ tasks: [task("a")] });
    const r = { levels: [{ tasks: [{ id: "a", ...passedEntry(task("a")), specHash: "deadbeef" }] }] };
    const { decisions } = reusePlan(p, r);
    expect(decisions[0].reuse).toBeNull();
    expect(decisions[0].reason).toBe("spec changed since the recorded pass");
  });

  it("gives every task 'not in the last report' when the report is null", () => {
    const p = plan({ tasks: [task("a"), task("b")] });
    const { decisions } = reusePlan(p, null);
    expect(decisions.every((d) => d.reuse === null && d.reason === "not in the last report")).toBe(true);
  });
});

// A size-S task runs implement and one focused check; the adversary reviews a level's S tasks together, once, on
// the integration branch after the merge (decision 0005). So an S task's own report entry carries `adversary:
// null` even when the check passed and the level adversary passed: `entry.shape` (recorded at report time) marks
// such a task, and its level's shared `levelAdversary` record (on `report.levels[i]`, not on the task entry) is
// what stageFailure/passedAttempt consult in place of the task's own adversary. Full-shape tasks (unsized, "M",
// "L", or an older report with no recorded shape) must be provably unaffected by any of this.
describe("reusePlan with size-S tasks and the level adversary", () => {
  it("reuses a size-S task whose level adversary ran and did not block, naming the level adversary (not a task adversary) in the reason", () => {
    const p = plan({ tasks: [task("a", { size: "S" })] });
    const r = {
      levels: [
        {
          tasks: [{ id: "a", branch: "doug/task-a", implemented: true, verified: true, reviewed: true, adversary: null, specHash: specHash(task("a")), shape: "S" }],
          levelAdversary: { ran: true, blocked: false, verdict: "pass", tasks: ["a"], issues: [], commandsRun: ["pnpm test:unit"], error: null },
        },
      ],
    };
    const { decisions } = reusePlan(p, r);
    expect(decisions[0].reuse).toBe("doug/task-a");
    expect(decisions[0].reason).toBe("passed verify, review, and the level adversary on doug/task-a");
  });

  it("does not reuse a size-S task whose level adversary ran and is blocked, not cleared; the reason names the level adversary blocking", () => {
    const p = plan({ tasks: [task("a", { size: "S" })] });
    const r = {
      levels: [
        {
          tasks: [{ id: "a", branch: "doug/task-a", implemented: true, verified: true, reviewed: true, adversary: null, specHash: specHash(task("a")), shape: "S" }],
          levelAdversary: {
            ran: true,
            blocked: true,
            summary: "found a cross-task issue",
            verdict: "fail",
            tasks: ["a"],
            issues: [{ severity: "blocker", file: "src/a.ts", description: "found a cross-task issue", evidence: null }],
            commandsRun: ["pnpm test:unit"],
            error: null,
          },
        },
      ],
    };
    const { decisions } = reusePlan(p, r);
    expect(decisions[0].reuse).toBeNull();
    expect(decisions[0].reason).toContain("level adversary blocked");
    expect(decisions[0].reason).toContain("found a cross-task issue");
  });

  it("names the unowned-files case distinctly when the level adversary blocked on files no task of the level owned", () => {
    const p = plan({ tasks: [task("a", { size: "S" })] });
    const r = {
      levels: [
        {
          tasks: [{ id: "a", branch: "doug/task-a", implemented: true, verified: true, reviewed: true, adversary: null, specHash: specHash(task("a")), shape: "S" }],
          levelAdversary: {
            ran: true,
            blocked: true,
            summary: "found an issue outside any task's files",
            unowned: ["docs/readme.md"],
            tasks: ["a"],
            issues: [{ severity: "blocker", file: "docs/readme.md", description: "found an issue outside any task's files", evidence: null }],
            commandsRun: ["pnpm test:unit"],
            error: null,
          },
        },
      ],
    };
    const { decisions } = reusePlan(p, r);
    expect(decisions[0].reuse).toBeNull();
    expect(decisions[0].reason).toContain("no task of the level owned");
  });

  it("reuses a size-S task whose level adversary blocked but was cleared by a routed fix pass (confirm.blocked: false)", () => {
    const p = plan({ tasks: [task("a", { size: "S" })] });
    const r = {
      levels: [
        {
          tasks: [{ id: "a", branch: "doug/task-a", implemented: true, verified: true, reviewed: true, adversary: null, specHash: specHash(task("a")), shape: "S" }],
          levelAdversary: {
            ran: true,
            blocked: true,
            summary: "found a bug",
            confirm: { blocked: false },
            tasks: ["a"],
            issues: [{ severity: "blocker", file: "src/a.ts", description: "found a bug", evidence: null }],
            commandsRun: ["pnpm test:unit"],
            error: null,
            fixed: [{ task: "a", ready: true, stopReason: null }],
          },
        },
      ],
    };
    const { decisions } = reusePlan(p, r);
    expect(decisions[0].reuse).toBe("doug/task-a");
    expect(decisions[0].reason).toContain("the level adversary");
  });

  it("does not reuse a size-S task whose level recorded no adversary review at all; the reason says the level adversary did not run, never the old 'adversary did not run' string", () => {
    const p = plan({ tasks: [task("a", { size: "S" })] });
    const r = {
      levels: [
        {
          tasks: [{ id: "a", branch: "doug/task-a", implemented: true, verified: true, reviewed: true, adversary: null, specHash: specHash(task("a")), shape: "S" }],
          levelAdversary: null,
        },
      ],
    };
    const { decisions } = reusePlan(p, r);
    expect(decisions[0].reuse).toBeNull();
    expect(decisions[0].reason).not.toBe("adversary did not run");
    expect(decisions[0].reason).toContain("level adversary");
    expect(decisions[0].reason).toContain("did not run");
  });

  it("threads the level adversary through the viaPass (earlier-attempt) success path too, wording it the same way", () => {
    const p = plan({ tasks: [task("a", { size: "S" })] });
    const r = {
      levels: [
        {
          tasks: [
            {
              id: "a",
              branch: "doug/task-a",
              implemented: true,
              specHash: specHash(task("a")),
              shape: "S",
              commit: "c2",
              verified: false,
              reviewed: false,
              adversary: null,
              attempts: [
                { pass: 1, commit: "c2", verified: true, reviewed: true, adversary: null },
                { pass: 2, commit: "c2", verified: false, reviewed: false, adversary: null },
              ],
            },
          ],
          levelAdversary: { ran: true, blocked: false, tasks: ["a"], issues: [], commandsRun: ["pnpm test:unit"], error: null },
        },
      ],
    };
    const { decisions } = reusePlan(p, r);
    expect(decisions[0].reuse).toBe("doug/task-a");
    expect(decisions[0].reason).toContain("pass 1");
    expect(decisions[0].reason).toContain("the level adversary");
  });

  // doug-implement.js's runChecks (pass > 1) skips the adversary stage entirely for a size-S task
  // (adversaryRequired(task) is false for shape 'S' regardless of what routed it there), so a real routed
  // level-blocker fix pass leaves the task's own final entry.adversary null again, not { ran: true, blocked:
  // false } (the level-adversary confirm.blocked === false path above is what actually covers that real case).
  // No real path was found that leaves a size-S task's final report entry with its own adversary.ran: true, so
  // this is the defensive/what-if case: if a task's own adversary field ever does carry ran: true, it must be
  // used directly and never fall through to the level adversary.
  it("uses a size-S task's own adversary record when it happens to have run, even though its level adversary also blocked", () => {
    const p = plan({ tasks: [task("a", { size: "S" })] });
    const r = {
      levels: [
        {
          tasks: [{ id: "a", branch: "doug/task-a", implemented: true, verified: true, reviewed: true, adversary: { ran: true, blocked: true, summary: "regression" }, specHash: specHash(task("a")), shape: "S" }],
          levelAdversary: { ran: true, blocked: true, summary: "blocked overall", tasks: ["a"], issues: [], commandsRun: ["pnpm test:unit"], error: null, fixed: [{ task: "a", ready: false, stopReason: "adversary blocked: regression" }] },
        },
      ],
    };
    const { decisions } = reusePlan(p, r);
    expect(decisions[0].reuse).toBeNull();
    expect(decisions[0].reason).toBe("adversary blocked: regression");
  });

  it("still rejects a full-shape task (unsized) with no adversary record with the exact old reason, proving full shape is unaffected", () => {
    const p = plan({ tasks: [task("a")] });
    const r = { levels: [{ tasks: [{ id: "a", branch: "doug/task-a", implemented: true, verified: true, reviewed: true, adversary: null, specHash: specHash(task("a")) }] }] };
    const { decisions } = reusePlan(p, r);
    expect(decisions[0].reuse).toBeNull();
    expect(decisions[0].reason).toBe("adversary did not run");
  });

  it("still rejects a task explicitly recorded shape: 'full' with no adversary record with the exact old reason", () => {
    const p = plan({ tasks: [task("a")] });
    const r = { levels: [{ tasks: [{ id: "a", branch: "doug/task-a", implemented: true, verified: true, reviewed: true, adversary: null, specHash: specHash(task("a")), shape: "full" }] }] };
    const { decisions } = reusePlan(p, r);
    expect(decisions[0].reuse).toBeNull();
    expect(decisions[0].reason).toBe("adversary did not run");
  });

  it("reuses a task normally when a report field predates the shape field (no entry.shape at all), even though the task is now sized S", () => {
    const p = plan({ tasks: [task("a", { size: "S" })] });
    const r = { levels: [{ tasks: [{ id: "a", branch: "doug/task-a", implemented: true, verified: true, reviewed: true, adversary: { ran: true, blocked: false }, specHash: specHash(task("a")) }] }] };
    const { decisions } = reusePlan(p, r);
    // No shape recorded: entryShape falls back to "full", so this task's own adversary record (which did run) is
    // what satisfies the requirement, same as any full-shape task.
    expect(decisions[0].reuse).toBe("doug/task-a");
    expect(decisions[0].reason).toBe("passed verify, review, and adversary on doug/task-a");
  });

  it("does not reuse a size-S task the level adversary never covered: not ready, so never merged into the branch the review ran against, even though its own entry looks passed", () => {
    // The review only ever covers a level's ready S tasks (doug-implement.js's sReady): a not-ready S task (here,
    // y, kept out by a reopened finding) can still carry verified/reviewed true with adversary: null, but its code
    // was never in front of the level adversary. levelAdversary.tasks names who was actually covered; a task not
    // on that list must not be reused on the strength of a review that never saw it.
    const p = plan({ tasks: [task("x", { size: "S" }), task("y", { size: "S" })] });
    const r = {
      levels: [
        {
          tasks: [
            { id: "x", branch: "doug/task-x", implemented: true, verified: true, reviewed: true, adversary: null, specHash: specHash(task("x", { size: "S" })), shape: "S" },
            {
              id: "y",
              branch: "doug/task-y",
              implemented: true,
              verified: true,
              reviewed: true,
              adversary: null,
              specHash: specHash(task("y", { size: "S" })),
              shape: "S",
              stopReason: "a fixed finding reappeared: F1",
            },
          ],
          levelAdversary: { ran: true, blocked: false, tasks: ["x"], issues: [], commandsRun: ["pnpm test:unit"], error: null },
        },
      ],
    };
    const { decisions } = reusePlan(p, r);
    const byId = Object.fromEntries(decisions.map((d) => [d.id, d]));
    expect(byId.x.reuse).toBe("doug/task-x");
    expect(byId.y.reuse).toBeNull();
    expect(byId.y.reason).toBe("level adversary did not review this task");
  });

  it("does not reuse a size-S task when the level adversary record predates the tasks field (no coverage list at all): treated conservatively as not covered", () => {
    const p = plan({ tasks: [task("a", { size: "S" })] });
    const r = {
      levels: [
        {
          tasks: [{ id: "a", branch: "doug/task-a", implemented: true, verified: true, reviewed: true, adversary: null, specHash: specHash(task("a", { size: "S" })), shape: "S" }],
          levelAdversary: { ran: true, blocked: false },
        },
      ],
    };
    const { decisions } = reusePlan(p, r);
    expect(decisions[0].reuse).toBeNull();
    expect(decisions[0].reason).toBe("level adversary did not review this task");
  });

  it("with plan.adversary === false, reuses a size-S task and words the reason plain 'adversary', never 'the level adversary' (the whole requirement is off)", () => {
    const p = plan({ adversary: false, tasks: [task("a", { size: "S" })] });
    const r = {
      levels: [
        {
          tasks: [{ id: "a", branch: "doug/task-a", implemented: true, verified: true, reviewed: true, adversary: null, specHash: specHash(task("a", { size: "S" })), shape: "S" }],
          levelAdversary: null,
        },
      ],
    };
    const { decisions } = reusePlan(p, r);
    expect(decisions[0].reuse).toBe("doug/task-a");
    expect(decisions[0].reason).toBe("passed verify, review, and adversary on doug/task-a");
  });

  it("does not reuse a full-shape task whose level adversary blocked, uncleared, on a file the task owns, even though the task's own adversary passed (card level-adversary-routes-owner, rule 2)", () => {
    const f = task("f", { files: ["a.js"] });
    const s = task("s", { size: "S", files: ["b.js"] });
    const p = plan({ tasks: [f, s] });
    const r = {
      levels: [
        {
          tasks: [
            {
              id: "f",
              branch: "doug/task-f",
              implemented: true,
              verified: true,
              reviewed: true,
              adversary: { ran: true, blocked: false },
              specHash: specHash(f),
              // A real report also carries commit + attempts (review round 2, B1): reusePlan falls back to
              // passedAttempt when the entry itself is judged failed, and a naive rule-2 fix that only touches
              // stageFailure leaves passedAttempt's full-shape branch (it never consults levelAdversary at all)
              // free to find this very attempt - verified, reviewed, own adversary passed, at the recorded head -
              // and hand the level-adversary block right back a reuse. Real report entries always look like this
              // (mirroring the S-task viaPass fixture above), so a fixture without commit/attempts never exercises
              // that fallback and the probe (wf_efadb339-abc still reuses serve-live-updates) stays undetected.
              commit: "c1",
              attempts: [{ pass: 1, commit: "c1", verified: true, reviewed: true, adversary: { ran: true, blocked: false } }],
            },
            { id: "s", branch: "doug/task-s", implemented: true, verified: true, reviewed: true, adversary: null, specHash: specHash(s), shape: "S" },
          ],
          levelAdversary: {
            ran: true,
            blocked: true,
            summary: "found a cross-task issue",
            verdict: "fail",
            tasks: ["s"],
            // Recorded as unowned (the real defect, card wf_efadb339-abc): the old level-adversary routing only
            // ever looked among the level's size-S tasks for an owner, so a.js (f's own file) came back unowned
            // even though f owns it. A routed fix pass that still did not clear leaves the same shape (unowned
            // absent, but no `confirm.blocked === false` either); either way f must not be reused.
            unowned: ["a.js"],
            issues: [{ severity: "blocker", file: "a.js", description: "found a cross-task issue", evidence: null }],
            commandsRun: ["pnpm test:unit"],
            error: null,
          },
        },
      ],
    };
    const { decisions } = reusePlan(p, r);
    const byId = Object.fromEntries(decisions.map((d) => [d.id, d]));
    expect(byId.f.reuse).toBeNull();
    expect(byId.f.reason).toContain("level adversary");
    expect(byId.f.reason).toContain("a.js");
    // The S task's own handling is unaffected by rule 2: it stays fresh today for the same unowned-files reason.
    expect(byId.s.reuse).toBeNull();
    expect(byId.s.reason).toContain("no task of the level owned");
  });

  it("control: a full-shape task keeps reusing when the level adversary's uncleared blocker names a file this task does not own (card level-adversary-routes-owner, rule 2)", () => {
    const f = task("f", { files: ["a.js"] });
    const s = task("s", { size: "S", files: ["b.js"] });
    const p = plan({ tasks: [f, s] });
    const r = {
      levels: [
        {
          tasks: [
            { id: "f", branch: "doug/task-f", implemented: true, verified: true, reviewed: true, adversary: { ran: true, blocked: false }, specHash: specHash(f) },
            { id: "s", branch: "doug/task-s", implemented: true, verified: true, reviewed: true, adversary: null, specHash: specHash(s), shape: "S" },
          ],
          levelAdversary: {
            ran: true,
            blocked: true,
            summary: "found a cross-task issue",
            verdict: "fail",
            tasks: ["s"],
            unowned: ["c.js"],
            issues: [{ severity: "blocker", file: "c.js", description: "found a cross-task issue", evidence: null }],
            commandsRun: ["pnpm test:unit"],
            error: null,
          },
        },
      ],
    };
    const { decisions } = reusePlan(p, r);
    const byId = Object.fromEntries(decisions.map((d) => [d.id, d]));
    expect(byId.f.reuse).toBe("doug/task-f");
  });

  it("control: a full-shape task is reused once the level adversary's blocker on its own file was cleared by a routed fix pass (card level-adversary-routes-owner, rule 2, M-b)", () => {
    const f = task("f", { files: ["a.js"] });
    const s = task("s", { size: "S", files: ["b.js"] });
    const p = plan({ tasks: [f, s] });
    const r = {
      levels: [
        {
          tasks: [
            {
              id: "f",
              branch: "doug/task-f",
              implemented: true,
              verified: true,
              reviewed: true,
              adversary: { ran: true, blocked: false },
              specHash: specHash(f),
              commit: "c1",
              attempts: [{ pass: 1, commit: "c1", verified: true, reviewed: true, adversary: { ran: true, blocked: false } }],
            },
            { id: "s", branch: "doug/task-s", implemented: true, verified: true, reviewed: true, adversary: null, specHash: specHash(s), shape: "S" },
          ],
          levelAdversary: {
            ran: true,
            blocked: true,
            summary: "found a cross-task issue",
            verdict: "fail",
            tasks: ["s"],
            unowned: ["a.js"],
            issues: [{ severity: "blocker", file: "a.js", description: "found a cross-task issue", evidence: null }],
            commandsRun: ["pnpm test:unit"],
            error: null,
            // The rule-2 "cleared" guard (levelAdversaryOwnedBlocker checks confirm.blocked === false the same way
            // levelAdversaryFailure does for a size-S task): a routed fix pass that did clear must not keep f
            // fresh forever on the strength of the original, now-resolved blocker.
            confirm: { blocked: false },
          },
        },
      ],
    };
    const { decisions } = reusePlan(p, r);
    const byId = Object.fromEntries(decisions.map((d) => [d.id, d]));
    expect(byId.f.reuse).toBe("doug/task-f");
  });

  it("does not reuse a full-shape task whose level adversary blocked, uncleared, on a './'-prefixed form of a file it owns (card plan-owner-path-match)", () => {
    const f = task("f", { files: ["plugins/x/src/a.js"] });
    const p = plan({ tasks: [f] });
    const r = {
      levels: [
        {
          tasks: [
            {
              id: "f",
              branch: "doug/task-f",
              implemented: true,
              verified: true,
              reviewed: true,
              adversary: { ran: true, blocked: false },
              specHash: specHash(f),
              commit: "c1",
              attempts: [{ pass: 1, commit: "c1", verified: true, reviewed: true, adversary: { ran: true, blocked: false } }],
            },
          ],
          levelAdversary: {
            ran: true,
            blocked: true,
            summary: "found a cross-task issue",
            verdict: "fail",
            tasks: [],
            unowned: ["./src/a.js"],
            issues: [{ severity: "blocker", file: "./src/a.js", description: "found a cross-task issue", evidence: null }],
            commandsRun: ["pnpm test:unit"],
            error: null,
          },
        },
      ],
    };
    const { decisions } = reusePlan(p, r);
    const byId = Object.fromEntries(decisions.map((d) => [d.id, d]));
    expect(byId.f.reuse).toBeNull();
    expect(byId.f.reason).toContain("level adversary");
  });

  it("does not reuse a full-shape task whose level adversary blocked, uncleared, on a suffix form (shortened from the left) of a file it owns (card plan-owner-path-match)", () => {
    const f = task("f", { files: ["plugins/x/src/a.js"] });
    const p = plan({ tasks: [f] });
    const r = {
      levels: [
        {
          tasks: [
            {
              id: "f",
              branch: "doug/task-f",
              implemented: true,
              verified: true,
              reviewed: true,
              adversary: { ran: true, blocked: false },
              specHash: specHash(f),
              commit: "c1",
              attempts: [{ pass: 1, commit: "c1", verified: true, reviewed: true, adversary: { ran: true, blocked: false } }],
            },
          ],
          levelAdversary: {
            ran: true,
            blocked: true,
            summary: "found a cross-task issue",
            verdict: "fail",
            tasks: [],
            unowned: ["src/a.js"],
            issues: [{ severity: "blocker", file: "src/a.js", description: "found a cross-task issue", evidence: null }],
            commandsRun: ["pnpm test:unit"],
            error: null,
          },
        },
      ],
    };
    const { decisions } = reusePlan(p, r);
    const byId = Object.fromEntries(decisions.map((d) => [d.id, d]));
    expect(byId.f.reuse).toBeNull();
    expect(byId.f.reason).toContain("level adversary");
  });

  it("control: a full-shape task keeps reusing when the level adversary's uncleared blocker file is not a path-segment suffix of a file it owns (card plan-owner-path-match)", () => {
    const f = task("f", { files: ["src/ba.js"] });
    const p = plan({ tasks: [f] });
    const r = {
      levels: [
        {
          tasks: [
            { id: "f", branch: "doug/task-f", implemented: true, verified: true, reviewed: true, adversary: { ran: true, blocked: false }, specHash: specHash(f) },
          ],
          levelAdversary: {
            ran: true,
            blocked: true,
            summary: "found a cross-task issue",
            verdict: "fail",
            tasks: [],
            unowned: ["a.js"],
            issues: [{ severity: "blocker", file: "a.js", description: "found a cross-task issue", evidence: null }],
            commandsRun: ["pnpm test:unit"],
            error: null,
          },
        },
      ],
    };
    const { decisions } = reusePlan(p, r);
    const byId = Object.fromEntries(decisions.map((d) => [d.id, d]));
    expect(byId.f.reuse).toBe("doug/task-f");
  });
});

describe("validatePlan reuse", () => {
  it("rejects an empty or non-string reuse and accepts a string", () => {
    expect(validatePlan(plan({ tasks: [task("a", { reuse: "" })] }))).toContain("tasks[0].reuse must be a non-empty branch name when present");
    expect(validatePlan(plan({ tasks: [task("a", { reuse: 3 })] }))).toContain("tasks[0].reuse must be a non-empty branch name when present");
    expect(validatePlan(plan({ tasks: [task("a", { reuse: "doug/task-a" })] }))).toEqual([]);
  });
});

describe("renderPlan reuse line", () => {
  it("prints the reuse line for a task marked reuse", () => {
    const text = renderPlan(plan({ tasks: [task("a", { reuse: "doug/task-a" })] }));
    expect(text).toContain("reuse: doug/task-a (implementer skipped; verify, review, adversary run again)");
  });
});

describe("plan.mjs replan CLI", () => {
  it("sets the plan back to draft, marks reusable tasks, and prints the decisions", () => {
    const dir = project();
    report(dir, {
      a: passedEntry(task("a")),
      b: { ...passedEntry(task("b")), adversary: { ran: true, blocked: true, verdict: "blocked" } },
      c: passedEntry(task("c", { dependsOn: ["b"] })),
    });
    const r = run(["replan"], dir);
    expect(r.status).toBe(0);
    const p = loadPlan(dir);
    expect(p.status).toBe("draft");
    expect(p.approvedAt).toBeUndefined();
    expect(p.tasks.find((t) => t.id === "a").reuse).toBe("doug/task-a");
    expect(p.tasks.find((t) => t.id === "b").reuse).toBeUndefined();
    expect(p.tasks.find((t) => t.id === "c").reuse).toBeUndefined();
    expect(r.stdout).toContain("a: reuse doug/task-a");
    expect(r.stdout).toContain("b: fresh (adversary blocked");
    expect(r.stdout).toContain("c: fresh (depends on b");
    // No git repo here, so no integration worktree can be registered: not an error, nothing printed about it.
    expect(r.stdout).not.toContain("removed integration worktree");

    const shown = run(["show"], dir);
    expect(shown.stdout).toContain("reuse: doug/task-a");

    const json = JSON.parse(run(["json"], dir).stdout);
    for (const t of json.tasks) expect(t.specHash).toMatch(/^[0-9a-f]{64}$/);
    expect(json.tasks.find((t) => t.id === "a").reuse).toBe("doug/task-a");

    expect(run(["approve"], dir).status).toBe(0);

    // Change a's spec and reset to draft: approve should refuse the now-stale reuse mark.
    const stale = loadPlan(dir);
    stale.status = "draft";
    delete stale.approvedAt;
    stale.tasks = stale.tasks.map((t) => (t.id === "a" ? { ...t, spec: t.spec + " changed" } : t));
    savePlan(dir, stale);
    const approveFail = run(["approve"], dir);
    expect(approveFail.status).toBe(1);
    expect(approveFail.stderr).toContain("a");
    expect(approveFail.stderr).toContain("spec changed since the recorded pass");
    expect(approveFail.stderr).toContain("plan.mjs replan");

    // A second replan removes a's now-stale mark.
    const r2 = run(["replan"], dir);
    expect(r2.status).toBe(0);
    expect(loadPlan(dir).tasks.find((t) => t.id === "a").reuse).toBeUndefined();
  });

  it("exits 1 with no report, and refuses to replan a landed plan", () => {
    const dir = project();
    const noReport = run(["replan"], dir);
    expect(noReport.status).toBe(1);
    expect(noReport.stderr).toContain("No report at .doug/.state/last-report.json");

    report(dir, { a: passedEntry(task("a")), b: passedEntry(task("b")), c: passedEntry(task("c", { dependsOn: ["b"] })) });
    savePlan(dir, { ...loadPlan(dir), landed: { at: "x" } });
    const landed = run(["replan"], dir);
    expect(landed.status).toBe(1);
    expect(landed.stderr).toContain("Refusing to replan a landed plan");
  });

  it("replan: a fresh task's worktree is removed (its diff saved first) and its branch renamed -stale-<n>; a reused task keeps both", () => {
    // 2026-09-07, board-reorder: replan kept a dirty worktree, and the next run's git checkout -b collided with the
    // stale doug/task-<id> branch, so a fresh task checked out the old branch or the run stopped.
    // git prints worktree paths realpath'd (/private/var on macOS), so the fixture is realpath'd too.
    const dir = realpathSync(gitProject());
    const wfA = join(dir, ".claude/worktrees/wf_a");
    const wfB = join(dir, ".claude/worktrees/wf_b");
    const wfC = join(dir, ".claude/worktrees/wf_c");
    const other = join(dir, ".claude/worktrees/other");
    const integration = join(dir, ".claude/worktrees/doug-integration");
    // wf_c also has a tracked modification; doug/task-b-stale-1 is already taken from an earlier replan.
    writeFileSync(join(wfC, "README.md"), "readme changed\n");
    git(dir, "branch", "doug/task-b-stale-1", "doug/task-b");

    report(dir, {
      a: passedEntry(task("a")),
      b: { ...passedEntry(task("b")), adversary: { ran: true, blocked: true, verdict: "blocked" } },
      c: passedEntry(task("c", { dependsOn: ["b"] })),
    });

    const r = run(["replan"], dir);
    expect(r.status).toBe(0);

    // a is reused: worktree and branch untouched. b and c are fresh: worktrees gone, dirty or not.
    expect(existsSync(wfA)).toBe(true);
    expect(git(dir, "branch", "--list", "doug/task-a")).toContain("doug/task-a");
    expect(existsSync(wfB)).toBe(false);
    expect(existsSync(wfC)).toBe(false);
    expect(existsSync(other)).toBe(true);
    // The integration worktree is retired too (card integration-worktree-stale): a leftover from the plan's
    // last run must not be reused as is by the next one. Its branch is untouched, never renamed or deleted.
    expect(existsSync(integration)).toBe(false);
    expect(git(dir, "branch", "--list", "doug/a-b-c")).toContain("doug/a-b-c");
    expect(r.stdout).toContain(`removed integration worktree ${integration}`);

    // The branch names are free again; the old branches survive under -stale-<n>, never deleted.
    expect(git(dir, "branch", "--list", "doug/task-b")).toBe("");
    expect(git(dir, "branch", "--list", "doug/task-c")).toBe("");
    expect(git(dir, "branch", "--list", "doug/task-b-stale-2")).toContain("doug/task-b-stale-2");
    expect(git(dir, "branch", "--list", "doug/task-c-stale-1")).toContain("doug/task-c-stale-1");
    expect(git(dir, "rev-parse", "doug/task-b-stale-2")).toBe(git(dir, "rev-parse", "doug/task-b-stale-1"));
    expect(r.stdout).toContain("renamed branch doug/task-b to doug/task-b-stale-2");
    expect(r.stdout).toContain("renamed branch doug/task-c to doug/task-c-stale-1");

    // wf_c's uncommitted work is saved as one diff (tracked changes and untracked files) before the removal.
    const replanDir = join(dir, ".doug/.state/replan");
    const runs = readdirSync(replanDir);
    expect(runs.length).toBe(1);
    const diffC = join(replanDir, runs[0], "c.diff");
    expect(existsSync(diffC)).toBe(true);
    const diff = readFileSync(diffC, "utf8");
    expect(diff).toContain("+readme changed");
    expect(diff).toContain("+keep me");
    expect(r.stdout).toContain(`saved diff ${diffC}`);
    expect(r.stdout).toContain(`removed worktree ${wfC}`);
    expect(r.stdout).toContain(`removed worktree ${wfB}`);
    // b had nothing uncommitted: no diff file for it.
    expect(existsSync(join(replanDir, runs[0], "b.diff"))).toBe(false);
    expect(r.stdout).not.toContain("kept worktree");

    const p = loadPlan(dir);
    expect(p.tasks.find((t) => t.id === "a").reuse).toBe("doug/task-a");
    expect(p.tasks.find((t) => t.id === "b").reuse).toBeUndefined();

    // A second replan on the same report finds nothing left to do and does not fail.
    const again = run(["replan"], dir);
    expect(again.status).toBe(0);
    expect(again.stdout).not.toContain("renamed branch");
    expect(existsSync(wfA)).toBe(true);
    // The integration worktree was already retired by the first replan; the second finds none registered and
    // prints nothing about it, without erroring.
    expect(again.stdout).not.toContain("removed integration worktree");
  });

  it("a report entry with implemented: false and a recorded branch (a thrown stage) is decided fresh, and its worktree and branch are retired same as any other fresh task (card integration-worktree-stale)", () => {
    const dir = realpathSync(gitProject());
    const wfB = join(dir, ".claude/worktrees/wf_b");

    report(dir, {
      a: passedEntry(task("a")),
      b: threwEntry(task("b")),
      c: passedEntry(task("c", { dependsOn: ["b"] })),
    });

    const r = run(["replan"], dir);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("b: fresh (implementer blocked: task stage threw (agent error, unknown agent type, or user skip))");

    expect(existsSync(wfB)).toBe(false);
    expect(git(dir, "branch", "--list", "doug/task-b")).toBe("");
    expect(git(dir, "branch", "--list", "doug/task-b-stale-1")).toContain("doug/task-b-stale-1");
    expect(r.stdout).toContain(`removed worktree ${wfB}`);
    expect(r.stdout).toContain("renamed branch doug/task-b to doug/task-b-stale-1");

    const p = loadPlan(dir);
    expect(p.tasks.find((t) => t.id === "b").reuse).toBeUndefined();
  });

  it("a thrown entry whose recorded branch is a task's reuse branch (a -stale-<n> rename) retires that real branch and its worktree (card thrown-reuse-task-branch)", () => {
    // A prior replan already renamed doug/task-b to doug/task-b-stale-1 and set task b's reuse to it; git updates
    // the worktree checked out on doug/task-b to follow the rename, same as a real replan would leave it. The
    // plan on disk is overwritten to match that story too, so the fixture's plan, its git state, and the recorded
    // report all agree that b is a reuse task, not just the git state and this comment.
    const dir = realpathSync(gitProject());
    const wfB = join(dir, ".claude/worktrees/wf_b");
    git(dir, "branch", "-m", "doug/task-b", "doug/task-b-stale-1");
    savePlan(dir, plan({ tasks: [task("a"), task("b", { reuse: "doug/task-b-stale-1" }), task("c", { dependsOn: ["b"] })] }));

    report(dir, {
      a: passedEntry(task("a")),
      b: threwEntry(task("b"), "doug/task-b-stale-1"),
      c: passedEntry(task("c", { dependsOn: ["b"] })),
    });

    const r = run(["replan"], dir);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("b: fresh (implementer blocked: task stage threw (agent error, unknown agent type, or user skip))");

    expect(existsSync(wfB)).toBe(false);
    expect(git(dir, "branch", "--list", "doug/task-b-stale-1")).toBe("");
    expect(git(dir, "branch", "--list", "doug/task-b-stale-1-stale-1")).toContain("doug/task-b-stale-1-stale-1");
    expect(r.stdout).toContain(`removed worktree ${wfB}`);
    expect(r.stdout).toContain("renamed branch doug/task-b-stale-1 to doug/task-b-stale-1-stale-1");
  });

  it("resolves a reuse mark whose recorded branch was renamed to the highest-numbered stale rename with a matching head, and approve accepts the resolved mark", () => {
    // 2026-09-08, fix-loop-reuse-after-fix-pass: an earlier replan renamed doug/task-a to a -stale-<n> branch
    // because task a went fresh that pass; a later replan whose report still names doug/task-a (unchanged since)
    // must resolve to the rename instead of handing the implementer a branch that no longer exists.
    const dir = realpathSync(gitProject());
    const wfA = join(dir, ".claude/worktrees/wf_a");
    const shaA = git(dir, "rev-parse", "doug/task-a");
    git(dir, "worktree", "remove", "--force", wfA);
    // Two stale renames share task a's commit; the highest (-stale-2, the actual rename of doug/task-a) must win
    // over an unrelated, coincidentally-matching -stale-1 left by other bookkeeping.
    git(dir, "branch", "doug/task-a-stale-1", shaA);
    git(dir, "branch", "-m", "doug/task-a", "doug/task-a-stale-2");

    report(dir, {
      a: { ...passedEntry(task("a")), commit: shaA },
      b: passedEntry(task("b")),
      c: passedEntry(task("c", { dependsOn: ["b"] })),
    });

    const r = run(["replan"], dir);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("a: reuse doug/task-a-stale-2");
    expect(r.stdout).toContain("was renamed to doug/task-a-stale-2 since the last report");
    const p = loadPlan(dir);
    expect(p.tasks.find((t) => t.id === "a").reuse).toBe("doug/task-a-stale-2");

    const approved = run(["approve"], dir);
    expect(approved.status).toBe(0);
    expect(approved.stdout).toContain("Approved");
  });

  it("prefers the highest-numbered stale rename that matches the recorded commit, not simply the highest-numbered one", () => {
    // -stale-2 has a higher n than -stale-1 but is a different, unrelated commit (e.g. left by other bookkeeping);
    // resolution must skip it and use -stale-1, the actual rename of doug/task-a.
    const dir = realpathSync(gitProject());
    const wfA = join(dir, ".claude/worktrees/wf_a");
    const shaA = git(dir, "rev-parse", "doug/task-a");
    const shaMain = git(dir, "rev-parse", "main");
    git(dir, "worktree", "remove", "--force", wfA);
    git(dir, "branch", "-m", "doug/task-a", "doug/task-a-stale-1");
    git(dir, "branch", "doug/task-a-stale-2", shaMain);

    report(dir, {
      a: { ...passedEntry(task("a")), commit: shaA },
      b: passedEntry(task("b")),
      c: passedEntry(task("c", { dependsOn: ["b"] })),
    });

    const r = run(["replan"], dir);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("a: reuse doug/task-a-stale-1");
    const p = loadPlan(dir);
    expect(p.tasks.find((t) => t.id === "a").reuse).toBe("doug/task-a-stale-1");
  });

  it("resolves through a gap in the stale numbering (only -stale-2 exists)", () => {
    // staleName picks the smallest free n, but a rename can later be deleted, leaving a gap; resolution must not
    // stop scanning at the first miss (here, a missing -stale-1).
    const dir = realpathSync(gitProject());
    const wfA = join(dir, ".claude/worktrees/wf_a");
    const shaA = git(dir, "rev-parse", "doug/task-a");
    git(dir, "worktree", "remove", "--force", wfA);
    git(dir, "branch", "-m", "doug/task-a", "doug/task-a-stale-2");

    report(dir, {
      a: { ...passedEntry(task("a")), commit: shaA },
      b: passedEntry(task("b")),
      c: passedEntry(task("c", { dependsOn: ["b"] })),
    });

    const r = run(["replan"], dir);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("a: reuse doug/task-a-stale-2");
    const p = loadPlan(dir);
    expect(p.tasks.find((t) => t.id === "a").reuse).toBe("doug/task-a-stale-2");
  });

  it("goes fresh, by name, when the recorded branch is gone and no stale rename matches its recorded commit", () => {
    const dir = realpathSync(gitProject());
    const wfA = join(dir, ".claude/worktrees/wf_a");
    git(dir, "worktree", "remove", "--force", wfA);
    git(dir, "branch", "-m", "doug/task-a", "doug/task-a-stale-1");

    report(dir, {
      // The recorded commit does not match doug/task-a-stale-1's head (or any other rename): nothing resolves.
      a: { ...passedEntry(task("a")), commit: "0000000000000000000000000000000000000000" },
      b: passedEntry(task("b")),
      c: passedEntry(task("c", { dependsOn: ["b"] })),
    });

    const r = run(["replan"], dir);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("a: fresh (recorded branch doug/task-a no longer exists; re-implementing)");
    const p = loadPlan(dir);
    expect(p.tasks.find((t) => t.id === "a").reuse).toBeUndefined();
  });

  it("goes fresh, naming the mismatch, when a branch with the recorded name exists but its head is not the recorded commit (reuse-branch-head-unchecked)", () => {
    // Reproduces the defect: resolveReuseBranch used to accept a branch on its name alone, so a stray
    // doug/task-<id> left behind by an implementer's `git checkout -b` (e.g. a run that died before reporting)
    // would be handed to the checkout agent as if it were the reviewed, passed work.
    const dir = realpathSync(gitProject());
    const shaA = git(dir, "rev-parse", "doug/task-a");
    const shaMain = git(dir, "rev-parse", "main");

    report(dir, {
      // The report recorded shaMain as task a's passed commit, but doug/task-a's actual head is shaA: a collision,
      // not a rename. No -stale-<n> branch exists to resolve it either.
      a: { ...passedEntry(task("a")), commit: shaMain },
      b: passedEntry(task("b")),
      c: passedEntry(task("c", { dependsOn: ["b"] })),
    });

    const r = run(["replan"], dir);
    expect(r.status).toBe(0);
    // Only the branch's actual head is abbreviated; the recorded commit is printed exactly as the report gave it, so
    // the two sides of the message never read as identical when one happens to already be abbreviated.
    expect(r.stdout).toContain(`a: fresh (recorded branch doug/task-a head ${shaA.slice(0, 7)} is not the recorded commit ${shaMain}; re-implementing)`);
    expect(r.stdout).not.toContain("doug/task-a no longer exists");
    const p = loadPlan(dir);
    expect(p.tasks.find((t) => t.id === "a").reuse).toBeUndefined();
  });

  it("still resolves to a -stale-<n> rename when the recorded name collides with an unrelated branch (a name collision does not hide the recorded work)", () => {
    // The exact reproduction from the card: an earlier replan renamed doug/task-a to a -stale-<n> branch because
    // the task went fresh that pass, and a new, unrelated doug/task-a was later created (the implementer's
    // `git checkout -b` before a run that died before reporting). The report still names doug/task-a and its
    // recorded commit is the one now under the stale rename, not the one on the colliding branch: the stale
    // rename must win, since the recorded, reviewed work really is there, just filed under another name — a
    // stray branch must not be allowed to hide it.
    const dir = realpathSync(gitProject());
    const wfA = join(dir, ".claude/worktrees/wf_a");
    const shaA = git(dir, "rev-parse", "doug/task-a");
    git(dir, "worktree", "remove", "--force", wfA);
    git(dir, "branch", "-m", "doug/task-a", "doug/task-a-stale-1");
    git(dir, "branch", "doug/task-a", "main"); // the collision: unrelated, wrong head

    report(dir, {
      a: { ...passedEntry(task("a")), commit: shaA },
      b: passedEntry(task("b")),
      c: passedEntry(task("c", { dependsOn: ["b"] })),
    });

    const r = run(["replan"], dir);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("a: reuse doug/task-a-stale-1");
    expect(r.stdout).toContain("was renamed to doug/task-a-stale-1 since the last report");
    const p = loadPlan(dir);
    expect(p.tasks.find((t) => t.id === "a").reuse).toBe("doug/task-a-stale-1");

    // approve must agree with what replan just wrote: the collision does not make the mark look stale.
    const approved = run(["approve"], dir);
    expect(approved.status).toBe(0);
    expect(approved.stdout).toContain("Approved");
  });

  it("still reuses a branch by name when the report recorded no commit for the task, even with a git resolver present", () => {
    // entry.commit is absent here (passedEntry never sets it): a task the report never recorded a commit for must
    // not have reuse refused just because there is nothing to check a head against.
    const dir = realpathSync(gitProject());
    report(dir, {
      a: passedEntry(task("a")),
      b: passedEntry(task("b")),
      c: passedEntry(task("c", { dependsOn: ["b"] })),
    });

    const r = run(["replan"], dir);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("a: reuse doug/task-a");
    const p = loadPlan(dir);
    expect(p.tasks.find((t) => t.id === "a").reuse).toBe("doug/task-a");
  });

  it("treats an empty-string recorded commit the same as no commit recorded: still reused by name", () => {
    // Pins the same "no commit recorded" guard as the test above, but for commit: "" rather than the field being
    // absent — a narrower guard (e.g. only `typeof commit === "string"`, without also checking it is non-empty)
    // would treat "" as a real commit to match against, and since doug/task-a's actual head is never "", the task
    // would wrongly go fresh with a mismatch reason instead of being reused by name.
    const dir = realpathSync(gitProject());
    report(dir, {
      a: { ...passedEntry(task("a")), commit: "" },
      b: passedEntry(task("b")),
      c: passedEntry(task("c", { dependsOn: ["b"] })),
    });

    const r = run(["replan"], dir);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("a: reuse doug/task-a");
    const p = loadPlan(dir);
    expect(p.tasks.find((t) => t.id === "a").reuse).toBe("doug/task-a");
  });
});

describe("plan.mjs approve retires the branch of a dropped reuse mark", () => {
  // 2026-09-10, approve-retires-dropped-reuse-branch: a replan marked a task reusable and kept its
  // doug/task-<id> branch; the spec then changed and the reuse mark was removed by hand, leaving the stale
  // branch behind for the next launch's `git checkout -b` to collide with. approve must retire (rename
  // -stale-<n>, same as replan's retireTaskWorktrees) the branch of every task with no reuse mark.

  it("renames the branch of every fresh (no reuse mark) task, saving an uncommitted worktree's diff first", () => {
    const dir = realpathSync(gitProject());
    const wfA = join(dir, ".claude/worktrees/wf_a");
    const wfB = join(dir, ".claude/worktrees/wf_b");
    const wfC = join(dir, ".claude/worktrees/wf_c");
    writeFileSync(join(wfB, "README.md"), "readme changed\n");
    const shaA = git(dir, "rev-parse", "doug/task-a");
    const shaB = git(dir, "rev-parse", "doug/task-b");
    const shaC = git(dir, "rev-parse", "doug/task-c");

    // gitProject() already saved a plan whose tasks a, b, c carry no reuse mark; no report is needed since
    // approve only consults the report for tasks marked reuse.
    const r = run(["approve"], dir);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Approved");
    expect(loadPlan(dir).status).toBe("approved");

    for (const [id, wf, sha] of [["a", wfA, shaA], ["b", wfB, shaB], ["c", wfC, shaC]]) {
      expect(existsSync(wf)).toBe(false);
      expect(git(dir, "branch", "--list", `doug/task-${id}`)).toBe("");
      expect(git(dir, "branch", "--list", `doug/task-${id}-stale-1`)).toContain(`doug/task-${id}-stale-1`);
      expect(git(dir, "rev-parse", `doug/task-${id}-stale-1`)).toBe(sha);
      expect(r.stdout).toContain(`renamed branch doug/task-${id} to doug/task-${id}-stale-1`);
      expect(r.stdout).toContain(`removed worktree ${wf}`);
    }

    // b was made dirty above; wf_c's fixture already carries an untracked file (gitProject()'s "keep me"). Both
    // get a saved diff, under this approve's own replan-state stamp directory; a (clean) gets none.
    const replanDir = join(dir, ".doug/.state/replan");
    const runs = readdirSync(replanDir);
    expect(runs.length).toBe(1);
    const diffB = join(replanDir, runs[0], "b.diff");
    expect(existsSync(diffB)).toBe(true);
    expect(readFileSync(diffB, "utf8")).toContain("+readme changed");
    expect(r.stdout).toContain(`saved diff ${diffB}`);
    const diffC = join(replanDir, runs[0], "c.diff");
    expect(existsSync(diffC)).toBe(true);
    expect(readFileSync(diffC, "utf8")).toContain("+keep me");
    expect(r.stdout).toContain(`saved diff ${diffC}`);
    expect(existsSync(join(replanDir, runs[0], "a.diff"))).toBe(false);
  });

  it("leaves a reused task's branch and worktree untouched", () => {
    const dir = realpathSync(gitProject());
    const wfA = join(dir, ".claude/worktrees/wf_a");
    const wfB = join(dir, ".claude/worktrees/wf_b");
    report(dir, { a: passedEntry(task("a")) });
    savePlan(dir, plan({ tasks: [task("a", { reuse: "doug/task-a" }), task("b"), task("c", { dependsOn: ["b"] })] }));

    const r = run(["approve"], dir);
    expect(r.status).toBe(0);

    // a carries a reuse mark: untouched.
    expect(existsSync(wfA)).toBe(true);
    expect(git(dir, "branch", "--list", "doug/task-a")).toContain("doug/task-a");
    expect(r.stdout).not.toContain("renamed branch doug/task-a");

    // b has no reuse mark: retired same as any fresh task.
    expect(existsSync(wfB)).toBe(false);
    expect(git(dir, "branch", "--list", "doug/task-b")).toBe("");
    expect(r.stdout).toContain("renamed branch doug/task-b to doug/task-b-stale-1");
  });

  it("a second approve on the now-approved plan prints already approved, renames nothing further, and exits 0, even when a run in flight has recreated doug/task-b with a live worktree", () => {
    const dir = realpathSync(gitProject());
    const wfB = join(dir, ".claude/worktrees/wf_b");
    report(dir, { a: passedEntry(task("a")) });
    savePlan(dir, plan({ tasks: [task("a", { reuse: "doug/task-a" }), task("b"), task("c", { dependsOn: ["b"] })] }));

    const first = run(["approve"], dir);
    expect(first.status).toBe(0);
    expect(git(dir, "branch", "--list", "doug/task-b-stale-1")).toContain("doug/task-b-stale-1");

    // Simulate a run in flight (relaunch after the first approve, before anyone reran replan): it checked out
    // doug/task-b again and is working in a worktree on it. A re-approve typed at this point (a second terminal,
    // or someone re-approving before the gate opens) must not touch either.
    git(dir, "branch", "doug/task-b", "main");
    git(dir, "worktree", "add", "-q", wfB, "doug/task-b");

    const second = run(["approve"], dir);
    expect(second.status).toBe(0);
    expect(second.stdout).toContain("Plan is already approved.");
    expect(second.stdout).not.toContain("renamed branch");
    expect(second.stdout).not.toContain("saved diff");
    expect(second.stdout).not.toContain("removed worktree");
    expect(existsSync(wfB)).toBe(true);
    expect(git(dir, "branch", "--list", "doug/task-b")).toContain("doug/task-b");
    expect(git(dir, "branch", "--list", "doug/task-b-stale-2")).toBe("");
  });
});

describe("staleReuseErrors", () => {
  it("is empty when no task carries reuse", () => {
    expect(staleReuseErrors(plan(), null)).toEqual([]);
  });
});

// Card report-save-wrapper, M1: loadReport applies unwrapReport, so plan.mjs replan and plan.mjs done must read a
// report saved wrapped in the Workflow tool's own output shape ({ summary, agentCount, logs, result, ... }) the
// same as one saved bare. Each test drives the same report both ways and checks the outcome matches.
function writeWrappedReport(dir, inner) {
  mkdirSync(join(dir, ".doug/.state"), { recursive: true });
  writeFileSync(join(dir, ".doug/.state/last-report.json"), JSON.stringify({ summary: "x", agentCount: 1, logs: [], result: inner }));
}

describe("plan.mjs replan/done accept a report saved wrapped in the Workflow tool's output shape (M1)", () => {
  it("M1: replan prints the same decisions for a wrapped report as for the same report saved bare", () => {
    const entries = {
      a: passedEntry(task("a")),
      b: { ...passedEntry(task("b")), adversary: { ran: true, blocked: true, verdict: "blocked" } },
      c: passedEntry(task("c", { dependsOn: ["b"] })),
    };

    const bareDir = project();
    report(bareDir, entries);
    const bareRun = run(["replan"], bareDir);
    expect(bareRun.status, bareRun.stderr).toBe(0);
    expect(bareRun.stdout).toContain("a: reuse doug/task-a");
    expect(bareRun.stdout).toContain("b: fresh (adversary blocked");
    expect(bareRun.stdout).toContain("c: fresh (depends on b");

    const wrappedDir = project();
    writeWrappedReport(wrappedDir, { levels: [{ tasks: Object.entries(entries).map(([id, t]) => ({ id, ...t })) }] });
    const wrappedRun = run(["replan"], wrappedDir);
    expect(wrappedRun.status, wrappedRun.stderr).toBe(0);
    // Without unwrapping, the wrapper's own `levels` is undefined, reusePlan sees no entries at all, and every
    // task comes back "not in the last report" instead of these real decisions - the wrapped run's stdout would
    // then differ from the bare run's.
    expect(wrappedRun.stdout).toBe(bareRun.stdout);
    expect(loadPlan(wrappedDir).tasks.find((t) => t.id === "a").reuse).toBe("doug/task-a");
  });

  function doneProject(status = "approved") {
    const dir = project();
    savePlan(dir, { ...loadPlan(dir), status });
    return dir;
  }

  // A wrapped ok report is accepted by done with or without the unwrap (its top-level "plan" mismatch, absent
  // the unwrap, only ever short-circuits the *refusing* gates below, never blocks the accepting path) - so that
  // half of A3 is not separately pinned here; the not-ok case below is the one the unwrap actually changes.
  it("M1: done refuses a not-ok wrapped report the same way as bare (the plan-title match needs the unwrap too)", () => {
    const notOk = { plan: "Replan sample", ok: false, stoppedAtLevel: 0, levels: [{ tasks: [{ id: "a", stopReason: "verify failed: missing test" }] }] };

    const bareDir = doneProject();
    mkdirSync(join(bareDir, ".doug/.state"), { recursive: true });
    writeFileSync(join(bareDir, ".doug/.state/last-report.json"), JSON.stringify(notOk));
    const bareRun = run(["done"], bareDir);
    expect(bareRun.status).toBe(1);
    expect(bareRun.stderr).toContain("the last run is not ok");
    expect(bareRun.stderr).toContain("a: verify failed: missing test");
    expect(loadPlan(bareDir).status).toBe("approved");

    const wrappedDir = doneProject();
    writeWrappedReport(wrappedDir, notOk);
    const wrappedRun = run(["done"], wrappedDir);
    // Without unwrapping, the wrapper's top level has no `plan` key, so it never matches this plan's title and
    // `done` would proceed as if the not-ok report belonged to some other plan - exit 0, marked done, instead of
    // refused.
    expect(wrappedRun.status).toBe(1);
    expect(wrappedRun.stderr).toBe(bareRun.stderr);
    expect(loadPlan(wrappedDir).status).toBe("approved");
  });
});
