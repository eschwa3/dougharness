// Command journey (card ci-e2e, docs/specs/ci-e2e/architecture.md 5.3, spec outcome 6): Doug's commands walked in
// one temp git repo, numbered J1..J9, no claude. The steps share the repo, so they run in order inside one
// sequential describe; a failed step records a journey-step finding (tests/replay/findings.mjs) and rethrows.
// Cases that init-hooks.test.ts, git-hooks.test.mjs and land.test.mjs already pin are not repeated here.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanEnv } from "../scripts/rehearse-lib.mjs";
import { integrationBranchFor } from "../plugins/doug-flow/lib/plan.mjs";
import { run } from "./rehearse-fixtures.mjs";
import { finding, recordFindings } from "./replay/findings.mjs";

vi.setConfig({ testTimeout: 600_000, hookTimeout: 600_000 });

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = "tests/e2e-journey.test.mjs";
const FIXTURE = join(ROOT, "packages/doug-cli/tests/fixtures/ts-pnpm");
const CLI = join(ROOT, "packages/doug-cli/dist/bin.js");
const PLAN_MJS = join(ROOT, "plugins/doug-flow/scripts/plan.mjs");
const BOARD_MJS = join(ROOT, "plugins/doug-flow/scripts/board.mjs");
const HOOKS_DIR = join(ROOT, ".githooks");
const built = existsSync(CLI);

const tempDirs = [];
let repo = "";
let scratch = "";
let integrationBranch = "";
const findings = [];

const CHECK_MJS = `import { appendFileSync, readdirSync, readFileSync } from "node:fs";
appendFileSync("check.log", process.env.npm_lifecycle_event + "\\n");
const red = readdirSync("src").filter((f) => readFileSync("src/" + f, "utf8").includes("RED"));
if (red.length) {
  console.error("RED in " + red.join(", "));
  process.exit(1);
}
`;

const node = (script, args, cwd = repo) => run(process.execPath, [script, ...args], { cwd, env: cleanEnv() });
const sh = (cmd, args, cwd = repo, extra = {}) => run(cmd, args, { cwd, env: cleanEnv(extra) });
const git = (args, cwd = repo) => sh("git", args, cwd);
const out = (r) => `exit ${r.status}${r.error ? ` (${r.error.message})` : ""}\n${r.stdout}\n${r.stderr}`.trim();
function ok(r) {
  expect(r.status, out(r)).toBe(0);
  return r;
}
const logLines = (dir = repo) => {
  try {
    return readFileSync(join(dir, "check.log"), "utf8").split("\n").filter(Boolean).length;
  } catch {
    return 0;
  }
};

// One numbered step: an `it` titled `J<n> <name>`; a failure adds a journey-step finding and rethrows.
function step(n, name, fn, { cli = false } = {}) {
  const body = async () => {
    try {
      await fn();
    } catch (e) {
      findings.push(
        finding({
          scenario: "journey",
          stage: `${n}-${name.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "")}`,
          message: `J${n} ${name}: ${e && e.message ? e.message : e}`.slice(0, 2000),
          kind: "journey-step",
          reproduce: `pnpm exec vitest run tests/e2e-journey.test.mjs -t J${n}`,
          source: SOURCE,
        }),
      );
      throw e;
    }
  };
  (cli ? it.skipIf(!built) : it)(`J${n} ${name}`, body);
}

const planDraft = () => ({
  version: 1,
  title: "Journey plan",
  goal: "The journey walks every command once",
  status: "draft",
  baseBranch: "main",
  install: "true",
  card: "j1",
  acceptance: [{ text: "typecheck passes", command: "pnpm typecheck" }],
  verify: ["pnpm typecheck"],
  tasks: [
    {
      id: "journey-edit",
      title: "Edit the first source file",
      spec: "Size S. Append a comment to src/index.ts.",
      files: ["src/index.ts"],
      verify: "pnpm typecheck",
      dependsOn: [],
      size: "S",
      gate: "auto",
    },
  ],
});

describe.sequential("e2e command journey", () => {
  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "doug-e2e-journey-"));
    scratch = mkdtempSync(join(tmpdir(), "doug-e2e-journey-scratch-"));
    tempDirs.push(repo, scratch);
  });

  afterAll(() => {
    recordFindings(SOURCE, findings);
    for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
  });

  step(1, "fixture repo with the pre-commit hook", async () => {
    cpSync(FIXTURE, repo, { recursive: true });
    const pkgPath = join(repo, "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    delete pkg.packageManager;
    pkg.scripts = { test: "node check.mjs", typecheck: "node check.mjs", "test:unit": "node check.mjs" };
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
    writeFileSync(join(repo, "check.mjs"), CHECK_MJS);
    appendFileSync(join(repo, ".gitignore"), "\ncheck.log\n");
    ok(await git(["init", "-q", "-b", "main"]));
    ok(await git(["config", "user.name", "Journey"]));
    ok(await git(["config", "user.email", "journey@example.com"]));
    ok(await git(["config", "core.hooksPath", HOOKS_DIR]));
    ok(await git(["add", "-A"]));
    ok(await git(["commit", "-q", "-m", "baseline"]));
    expect(logLines()).toBeGreaterThan(0);
  });

  step(2, "doug init", async () => {
    ok(await node(CLI, ["init", "--yes", "--quiet", repo]));
    expect(existsSync(join(repo, ".doug/config.json"))).toBe(true);
    ok(await git(["add", "-A"]));
    ok(await git(["commit", "-q", "-m", "doug init"]));
  }, { cli: true });

  step(3, "board add and move", async () => {
    ok(await node(CLI, ["board", "add", "j1", "--title", "Journey card", "--goal", "Walk the commands", "--size", "S", "--track", "flow", "--class", "code", repo]));
    ok(await node(CLI, ["board", "move", "j1", "ready", repo]));
    ok(await node(CLI, ["board", "move", "j1", "flow", repo]));
    const board = JSON.parse(readFileSync(join(repo, ".doug/board.json"), "utf8"));
    expect(board.cards.find((c) => c.id === "j1").column).toBe("flow");
  }, { cli: true });

  step(4, "plan approve and anchor", async () => {
    const plan = planDraft();
    integrationBranch = integrationBranchFor(plan);
    writeFileSync(join(repo, ".doug/plan.json"), JSON.stringify(plan, null, 2));
    ok(await node(PLAN_MJS, ["approve", repo]));
    ok(await node(PLAN_MJS, ["anchor", repo]));
    expect(JSON.parse(readFileSync(join(repo, ".doug/plan.json"), "utf8")).status).toBe("approved");
  });

  step(5, "green edit on the integration branch through the pre-commit hook", async () => {
    const wt = join(repo, ".claude/worktrees/integration");
    ok(await git(["worktree", "add", "-q", "-b", integrationBranch, ".claude/worktrees/integration", "main"]));
    appendFileSync(join(wt, "src/index.ts"), "\n// journey edit\n");
    ok(await git(["add", "src/index.ts"], wt));
    const before = logLines(wt);
    ok(await git(["commit", "-q", "-m", "journey-edit: append a comment"], wt));
    expect(logLines(wt)).toBeGreaterThan(before);
  });

  step(6, "plan done and land", async () => {
    const plan = JSON.parse(readFileSync(join(repo, ".doug/plan.json"), "utf8"));
    const report = { plan: plan.title, ok: true, levels: [{ tasks: [{ id: "journey-edit", implemented: true, verified: true, reviewed: true }], integration: { ok: true } }] };
    mkdirSync(join(repo, ".doug/.state"), { recursive: true });
    writeFileSync(join(repo, ".doug/.state/last-report.json"), JSON.stringify(report, null, 2));
    ok(await node(PLAN_MJS, ["done", repo]));
    ok(await node(PLAN_MJS, ["land", repo]));
    const parents = ok(await git(["rev-list", "--parents", "-n", "1", "HEAD"])).stdout.trim().split(/\s+/);
    expect(parents.length, `rev-list --parents: ${parents.join(" ")}`).toBe(3);
  });

  step(7, "board record and summary", async () => {
    const report = join(repo, ".doug/.state/last-report.json");
    ok(await node(BOARD_MJS, ["record", "j1", report, repo, "--summary", "The journey card landed through every command"]));
    const r = ok(await node(BOARD_MJS, ["summary", report, "--summary", "The journey summary prints three lines", "--card", "j1"], repo));
    expect(r.stdout).toMatch(/^Changed: /m);
    expect(r.stdout).toMatch(/^Outcome: /m);
    ok(await git(["add", "-A"]));
    ok(await git(["commit", "-q", "-m", "journey: record the landing"]));
  }, { cli: true });

  step(8, "Stop command allows a green tree", async () => {
    const settings = JSON.parse(readFileSync(join(repo, ".claude/settings.json"), "utf8"));
    const command = settings.hooks.Stop[0].hooks[0].command;
    const payloadFile = join(scratch, "stop.json");
    writeFileSync(payloadFile, JSON.stringify({ session_id: "journey-session", cwd: repo, hook_event_name: "Stop", stop_hook_active: false }));
    // A green edit left uncommitted: a clean, already-verified tree is credited from the pre-commit record and runs nothing.
    appendFileSync(join(repo, "src/index.ts"), "\n// uncommitted green edit\n");
    const before = logLines();
    const r = ok(await sh("sh", ["-c", `${command} < "${payloadFile}"`], repo, { CLAUDE_PROJECT_DIR: repo }));
    expect(r.stdout, out(r)).not.toMatch(/"decision"\s*:\s*"block"/);
    expect(logLines(), "the Stop gate ran no check command").toBeGreaterThan(before);
  }, { cli: true });

  step(9, "red cases: pre-commit refuses, Stop blocks", async () => {
    writeFileSync(join(repo, "src/red.ts"), "// RED\nexport const red = 1;\n");
    ok(await git(["add", "src/red.ts"]));
    const c = await git(["commit", "-q", "-m", "red change"]);
    expect(c.status, out(c)).not.toBe(0);
    expect(c.stderr + c.stdout).toContain("pre-commit: pnpm typecheck failed");
    ok(await git(["reset", "-q", "src/red.ts"]));
    const settings = JSON.parse(readFileSync(join(repo, ".claude/settings.json"), "utf8"));
    const command = settings.hooks.Stop[0].hooks[0].command;
    const payloadFile = join(scratch, "stop.json");
    const r = await sh("sh", ["-c", `${command} < "${payloadFile}"`], repo, { CLAUDE_PROJECT_DIR: repo });
    expect(r.stdout, out(r)).toMatch(/"decision"\s*:\s*"block"/);
    expect(r.stdout, out(r)).toMatch(/typecheck/);
  }, { cli: true });
});
