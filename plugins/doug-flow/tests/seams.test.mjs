// Closes the four testing gaps a measurement of the harness gate found (card seam-contracts,
// .doug/.state/research/seam-contracts.md): nothing today ties doug-implement.js's report key `reviewIssues` to
// lib/memory.mjs's read of `task.reviewIssues` (a); a skill's documented board/plan/memory.mjs subcommand can stop
// existing while the suite stays green (b); and `claude plugin validate` catches a broken plugin manifest but
// nothing exercises it (d). Seam (c) - doug init's PreToolUse wiring actually firing - lives in
// packages/doug-cli/tests/init-hooks.test.ts, since it belongs to the CLI package.
import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, existsSync, cpSync, rmSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { withSpecHashes, savePlan, REPORT_RELPATH } from "../lib/plan.mjs";
import { newBoard, addCard, saveBoard } from "../lib/board.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, ".."); // plugins/doug-flow
const repoRoot = join(root, "..", ".."); // the dougharness checkout root
const source = readFileSync(join(root, "workflows/doug-implement.js"), "utf8");

// Every child process below clears CLAUDE_PROJECT_DIR and GIT_* (plugins/doug-gates/tests/git-hooks.test.mjs's
// precedent): plan.mjs/board.mjs/memory.mjs's dirFrom() prefers CLAUDE_PROJECT_DIR over an explicit dir argument
// (scripts/plan.mjs:107 and the board.mjs/memory.mjs equivalents), so a leaked value from this process's own env
// would silently redirect these spawns at the real checkout instead of the temp fixture.
function cleanEnv(extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith("GIT_") && k !== "CLAUDE_PROJECT_DIR") env[k] = v;
  }
  return { ...env, ...extra };
}

function git(dir, args) {
  const r = spawnSync("git", args, { cwd: dir, encoding: "utf8", env: cleanEnv() });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} in ${dir} failed: ${r.stderr}`);
  return r.stdout.trim();
}

const boardCli = join(root, "scripts/board.mjs");
const planCli = join(root, "scripts/plan.mjs");
const memoryCli = join(root, "scripts/memory.mjs");

// CLAUDE_PROJECT_DIR is cleared, never set, so dirFrom() falls through to the dir argument passed explicitly here.
function runCli(cli, args, dir) {
  return spawnSync(process.execPath, [cli, ...args, dir], { cwd: dir, encoding: "utf8", env: cleanEnv() });
}

// Runs the workflow template's body the way the Workflow runtime does (plugins/doug-flow/tests/template.test.mjs
// lines ~1826-1841): wraps the source after its top-level guards in an async function and calls it directly, so
// the real report-building code runs, not a reimplementation of it.
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
async function runWorkflowBody(plan, agent) {
  const bodyStart = source.indexOf("\n}\n") + 3;
  const body = new AsyncFunction("args", "agent", "pipeline", "parallel", "phase", "log", "budget", source.slice(bodyStart));
  const pipeline = async (items, fn) => {
    const out = [];
    for (const item of items) out.push(await fn(item));
    return out;
  };
  const parallel = async (fns) => Promise.all(fns.map((f) => f()));
  return body(plan, agent, pipeline, parallel, (x) => x, () => {}, null);
}

describe("seam a: doug-implement.js's report key round-trips into memory, board, and replan (card seam-contracts)", () => {
  it("records review_issue_count from the report's issue count and lets replan see the recorded branch, without touching the real checkout's board.json or docs/live-runs.md", async () => {
    // Read the real checkout's own board record and live-runs doc before anything runs, so a leak into the real
    // checkout (a CLAUDE_PROJECT_DIR that was not actually cleared, or a dir argument dropped somewhere) fails
    // this assertion loudly instead of silently corrupting the project's own board or run history.
    const realBoardPath = join(repoRoot, ".doug/board.json");
    const realLiveRunsPath = join(repoRoot, "docs/live-runs.md");
    // .doug/board.json is absent from the public export; compare null on both sides then, like live-runs below.
    const realBoardBefore = existsSync(realBoardPath) ? readFileSync(realBoardPath) : null;
    // docs/live-runs.md may not exist in every checkout state; tolerate that by comparing null on both sides
    // rather than requiring the file to be present just to run this leak check.
    const realLiveRunsBefore = existsSync(realLiveRunsPath) ? readFileSync(realLiveRunsPath) : null;

    const dir = mkdtempSync(join(tmpdir(), "doug-seam-a-"));
    try {
      git(dir, ["init", "-q", "-b", "main"]);
      git(dir, ["config", "user.email", "t@example.com"]);
      git(dir, ["config", "user.name", "t"]);
      writeFileSync(join(dir, "README.md"), "readme\n");
      git(dir, ["add", "-A"]);
      git(dir, ["commit", "-q", "-m", "base"]);
      git(dir, ["checkout", "-q", "-b", "doug/task-x"]);
      writeFileSync(join(dir, "x.txt"), "x\n");
      git(dir, ["add", "-A"]);
      git(dir, ["commit", "-q", "-m", "doug/task-x"]);
      const shaX = git(dir, ["rev-parse", "doug/task-x"]);
      git(dir, ["checkout", "-q", "main"]);

      const planTask = { id: "x", title: "X", spec: "Do the thing for x, with a test.", files: ["src/x.ts"], verify: "true", card: "seam-a" };
      const basePlan = {
        version: 1,
        status: "approved",
        title: "Seam A round trip",
        goal: "Prove reviewIssues round-trips into review_issue_count and that replan sees the recorded branch.",
        install: null,
        verify: ["true"],
        acceptance: [],
        adversary: false,
        fixAttempts: 0,
        baseBranch: "main",
        integrationBranch: "doug/int-seam-a",
        tasks: [planTask],
      };
      // withSpecHashes attaches each task's current specHash before the workflow runs, the way plan.mjs json does
      // for the real workflow; plan.mjs replan recomputes the same hash from the plan.json saved below, over the
      // same spec/files/verify fields, so the two agree without the two ever having to share a value directly.
      const runPlan = withSpecHashes(basePlan);

      // Two issues, approve: true - a review can approve a task while still recording findings; the whole point of
      // this seam is that non-empty findings must survive into review_issue_count even when reviewed is true.
      const issues = [
        { severity: "minor", file: "src/x.ts", description: "nit one" },
        { severity: "minor", file: "src/x.ts", description: "nit two" },
      ];
      const agent = async (prompt, opts) => {
        const label = String(opts.label);
        const id = label.split(":")[1];
        if (label.startsWith("implement:")) {
          return { taskId: id, branch: "doug/task-x", worktreePath: `/wt/${id}`, filesTouched: [], commandsRun: [], summary: "done", blocked: false, commit: shaX };
        }
        if (label.startsWith("verify:")) return { taskId: id, passed: true, commandsRun: [], findings: [], acceptance: [] };
        if (label.startsWith("review:")) return { taskId: id, specCompliant: true, inScope: true, approve: true, issues };
        if (label.startsWith("integrate:")) return { branch: "doug/int-seam-a", merged: ["doug/task-x"], conflicts: [], verify: [], ok: true };
        return null;
      };

      const report = await runWorkflowBody(runPlan, agent);
      expect(report.ok).toBe(true);
      const entry = report.levels[0].tasks[0];
      // This is the seam itself: doug-implement.js's report carries the issues under whatever key it names them
      // (today "reviewIssues"); everything below only ever reads that key back off the report object, so a rename
      // at doug-implement.js:1799 breaks this assertion immediately instead of leaving it green.
      expect(entry.reviewIssues).toEqual(issues);
      expect(entry.branch).toBe("doug/task-x");
      expect(entry.commit).toBe(shaX);

      const reportPath = join(dir, "report.json");
      writeFileSync(reportPath, JSON.stringify(report, null, 2));
      mkdirSync(join(dir, ".doug/.state"), { recursive: true });
      writeFileSync(join(dir, REPORT_RELPATH), JSON.stringify(report, null, 2));
      savePlan(dir, basePlan);

      let board = newBoard({ date: "2026-09-09" });
      board = addCard(board, { id: "seam-a", title: "Seam A", goal: "prove the round trip", column: "flow" }, { date: "2026-09-09" });
      saveBoard(dir, board);

      const memRec = runCli(memoryCli, ["record", reportPath], dir);
      expect(memRec.status, memRec.stderr).toBe(0);

      const outcomes = runCli(memoryCli, ["outcomes", "--json"], dir);
      expect(outcomes.status, outcomes.stderr).toBe(0);
      const rows = JSON.parse(outcomes.stdout);
      expect(rows).toHaveLength(1);
      // The actual round trip: memory.mjs's recorded row must equal the report's issue count, via
      // lib/memory.mjs:360-361 reading task.reviewIssues - the exact seam the card names.
      expect(rows[0].review_issue_count).toBe(entry.reviewIssues.length);
      expect(rows[0].review_issues).toEqual(entry.reviewIssues);

      const boardRec = runCli(boardCli, ["record", "seam-a", reportPath], dir);
      expect(boardRec.status, boardRec.stderr).toBe(0);
      expect(existsSync(join(dir, "docs/live-runs.md"))).toBe(true);

      const summary = runCli(boardCli, ["summary", reportPath], dir);
      expect(summary.status, summary.stderr).toBe(0);
      expect(summary.stdout).toContain("Seam A round trip");

      const replan = runCli(planCli, ["replan"], dir);
      expect(replan.status, replan.stderr).toBe(0);
      expect(replan.stdout).toContain("x: reuse doug/task-x");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }

    expect(existsSync(realBoardPath) ? readFileSync(realBoardPath) : null).toEqual(realBoardBefore);
    expect(existsSync(realLiveRunsPath) ? readFileSync(realLiveRunsPath) : null).toEqual(realLiveRunsBefore);
  });
});

describe("seam e: doug-implement.js's report key stopClass round-trips into board summary and record (card flow-stop-class)", () => {
  it("a task the fix loop stops with fixAttempts 0 carries stopClass fix-attempts-exhausted, and the board prints it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "doug-seam-e-"));
    try {
      const plan = {
        version: 1,
        status: "approved",
        title: "Seam E stop class",
        goal: "Prove a stopped task's class reaches the report and the board printers.",
        install: null,
        verify: ["true"],
        acceptance: [],
        adversary: false,
        fixAttempts: 0,
        baseBranch: "main",
        integrationBranch: "doug/int-seam-e",
        tasks: [{ id: "x", title: "X", spec: "Do the thing for x, with a test.", files: ["src/x.ts"], verify: "true", card: "seam-e" }],
      };
      const agent = async (prompt, opts) => {
        const label = String(opts.label);
        const id = label.split(":")[1];
        if (label.startsWith("implement:")) return { taskId: id, branch: "doug/task-x", worktreePath: `/wt/${id}`, filesTouched: [], commandsRun: [], summary: "done", blocked: false, commit: "c1" };
        if (label.startsWith("verify:")) return { taskId: id, passed: false, commandsRun: [], findings: ["src/x.ts returns 1, expected 2"], acceptance: [] };
        if (label.startsWith("review:")) return { taskId: id, specCompliant: true, inScope: true, approve: true, issues: [] };
        return null;
      };
      const report = await runWorkflowBody(withSpecHashes(plan), agent);
      expect(report.ok).toBe(false);
      const entry = report.levels[0].tasks[0];
      expect(entry.stopReason).toMatch(/fix attempts exhausted/);
      expect(entry.stopClass).toBe("fix-attempts-exhausted");

      const reportPath = join(dir, "report.json");
      writeFileSync(reportPath, JSON.stringify(report, null, 2));
      let board = newBoard({ date: "2026-10-01" });
      board = addCard(board, { id: "seam-e", title: "Seam E", goal: "prove the stop class round trip", column: "flow" }, { date: "2026-10-01" });
      saveBoard(dir, board);

      const summary = runCli(boardCli, ["summary", reportPath], dir);
      expect(summary.status, summary.stderr).toBe(0);
      expect(summary.stdout).toContain('x [fix-attempts-exhausted]: "');

      const rec = runCli(boardCli, ["record", "seam-e", reportPath], dir);
      expect(rec.status, rec.stderr).toBe(0);
      expect(readFileSync(join(dir, "docs/live-runs.md"), "utf8")).toContain('Stopped: x [fix-attempts-exhausted]: "');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("seam b: every board.mjs/plan.mjs/memory.mjs/learn.mjs subcommand a skill or doc names is a real dispatch case (card seam-contracts, extended by card learn-signals)", () => {
  function dispatchSet(scriptPath) {
    const src = readFileSync(scriptPath, "utf8");
    const set = new Set();
    for (const m of src.matchAll(/case "([a-z][a-z-]*)":/g)) set.add(m[1]);
    return set;
  }

  function skillMdFiles() {
    const out = [];
    (function walk(d) {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name === "SKILL.md") out.push(p);
      }
    })(join(root, "skills"));
    return out;
  }

  // review minor 5 (memory-recall pass B): the walk above covers skills but not agent prompts, so planner.md's
  // `memory.mjs recall` went unguarded. Every plugins/doug-flow/agents/*.md file gets the same scan.
  function agentMdFiles() {
    return readdirSync(join(root, "agents"))
      .filter((f) => f.endsWith(".md"))
      .map((f) => join(root, "agents", f));
  }

  it("names only real dispatch cases in every skill's SKILL.md, every agents/*.md, CLAUDE.md, and docs/worker-contract.md (a floor per script guards against a silent regex miss)", () => {
    const scripts = {
      board: dispatchSet(join(root, "scripts/board.mjs")),
      plan: dispatchSet(join(root, "scripts/plan.mjs")),
      memory: dispatchSet(join(root, "scripts/memory.mjs")),
      learn: dispatchSet(join(root, "scripts/learn.mjs")),
    };
    // Measured today: plan 87, board 35, memory 3, learn 3 references (see the card). Pinned a little below
    // that so this fails loudly, not silently, if the regex below ever stops matching most of them.
    const floors = { board: 30, plan: 60, memory: 2, learn: 3 };

    const files = [...skillMdFiles(), ...agentMdFiles(), join(repoRoot, "CLAUDE.md"), join(repoRoot, "docs/worker-contract.md"), join(repoRoot, "docs/learn.md")];
    let text = "";
    for (const f of files) text += readFileSync(f, "utf8") + "\n";

    // This regex also captures ordinary prose like "board.mjs and ..." as a bogus "and" subcommand reference, so a
    // bare script mention in a skill or doc must be backtick-quoted or immediately followed by a real subcommand
    // to avoid being misread here.
    const refs = { board: [], plan: [], memory: [], learn: [] };
    for (const m of text.matchAll(/(board|plan|memory|learn)\.mjs"? ([a-z][a-z-]*)/g)) refs[m[1]].push(m[2]);

    for (const script of ["board", "plan", "memory", "learn"]) {
      expect(
        refs[script].length,
        `found only ${refs[script].length} "${script}.mjs <subcommand>" references (floor ${floors[script]}); the extraction regex may have broken`
      ).toBeGreaterThanOrEqual(floors[script]);
      const bad = [...new Set(refs[script])].filter((r) => !scripts[script].has(r));
      expect(bad, `these ${script}.mjs subcommands are referenced in a skill or doc but are not real dispatch cases: ${JSON.stringify(bad)}`).toEqual([]);
    }
  });
});

describe("seam d: claude plugin validate catches a broken plugin manifest (card seam-contracts)", () => {
  const claudeCheck = spawnSync("claude", ["--version"], { encoding: "utf8", env: cleanEnv(), timeout: 10000 });
  const claudeUnavailable = !!claudeCheck.error || !!claudeCheck.signal || claudeCheck.status !== 0;
  const claudeReason = claudeCheck.error
    ? claudeCheck.error.message
    : claudeCheck.signal
      ? `timed out (killed by ${claudeCheck.signal})`
      : `exit ${claudeCheck.status}: ${(claudeCheck.stderr || "").trim()}`;

  it.skipIf(claudeUnavailable)(
    `exits 0 on the real doug-flow and doug-gates manifests, and nonzero on a copy with a mutated "agents" field${claudeUnavailable ? ` (skipped: claude CLI unavailable - ${claudeReason})` : ""}`,
    () => {
      for (const p of ["plugins/doug-flow", "plugins/doug-gates"]) {
        const r = spawnSync("claude", ["plugin", "validate", join(repoRoot, p)], { encoding: "utf8", env: cleanEnv() });
        expect(r.status, `${p}: ${r.stdout}\n${r.stderr}`).toBe(0);
      }

      const dir = mkdtempSync(join(tmpdir(), "doug-plugin-validate-"));
      try {
        cpSync(join(repoRoot, "plugins/doug-flow"), dir, { recursive: true });
        const manifestPath = join(dir, ".claude-plugin/plugin.json");
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
        // The exact mutation the card names: a directory string instead of the array of agent files, which
        // template.test.mjs's "plugin layout" describe block separately calls out as the thing that fails
        // `claude plugin validate` (see its comment there).
        manifest.agents = "./agents/";
        writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

        const bad = spawnSync("claude", ["plugin", "validate", dir], { encoding: "utf8", env: cleanEnv() });
        expect(bad.status, `expected a nonzero exit on a mutated manifest; got:\n${bad.stdout}\n${bad.stderr}`).not.toBe(0);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  );
});
