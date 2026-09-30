// Validates the workflow template and plugin layout without running any agent.
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, readdirSync, writeFileSync, mkdtempSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { levelize as libLevelize } from "../lib/plan.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// The public snapshot leaves out docs the dev repo keeps (ADRs, run log, rehearsals, releasing); scripts/export-public.mjs
// is itself excluded from the snapshot, so its absence marks it. In dev a missing doc must fail, not skip.
const IS_SNAPSHOT = !existsSync(join(root, "..", "..", "scripts/export-public.mjs"));
const source = readFileSync(join(root, "workflows/doug-implement.js"), "utf8");
// The prompt slices below are evaluated on their own, so the one constant they share comes along.
// NO_TRAILERS, PARTIAL_RULE, and PARTIAL_NEVER_MERGED (card worker-context-handoff), declared together in the source.
const CONSTS = source.slice(source.indexOf("const NO_TRAILERS = "), source.indexOf("\n", source.indexOf("const PARTIAL_NEVER_MERGED = ")) + 1);
// adversaryOk calls adversaryBlocking, defined immediately above it: an isolated eval of adversaryOk alone needs
// both together.
const adversaryOkSource = () => source.slice(source.indexOf("function adversaryBlocking("), source.indexOf("\n}\n", source.indexOf("function adversaryOk(")) + 3);

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

describe("workflow template", () => {
  it("begins with a pure-literal meta export naming every phase used", () => {
    expect(source.startsWith("export const meta = {")).toBe(true);
    const literal = source.slice("export const meta = ".length, source.indexOf("\n}\n") + 2);
    const meta = new Function("return " + literal)();
    expect(meta.name).toBe("doug-implement");
    expect(typeof meta.description).toBe("string");
    const titles = meta.phases.map((p) => p.title);
    expect(titles).toEqual(["Implement", "Verify", "Review", "Adversary", "Integrate"]);
    const used = [...source.matchAll(/phase:\s*'([^']+)'/g)].map((m) => m[1]);
    for (const u of new Set(used)) expect(titles).toContain(u);
  });
  it("uses no nondeterministic or unavailable APIs and no TypeScript syntax", () => {
    expect(source).not.toMatch(/Date\.now\(|Math\.random\(|new Date\(\)/);
    expect(source).not.toMatch(/^\s*import\s|\brequire\(|\bprocess\.\w|\bfs\.\w/m);
    expect(source).not.toMatch(/:\s*(string|number|boolean)\b\s*[=,)]/);
  });
  it("is syntactically valid JavaScript once wrapped the way the Workflow runtime wraps it", () => {
    // The runtime exports meta and runs the body inside an async function (top-level return is allowed).
    const bodyStart = source.indexOf("\n}\n") + 3;
    const wrapped = source.slice(0, bodyStart) + "\nexport default async function run(args, agent, pipeline, parallel, phase, log, budget) {\n" + source.slice(bodyStart) + "\n}\n";
    const dir = mkdtempSync(join(tmpdir(), "doug-wf-"));
    const file = join(dir, "wf.mjs");
    writeFileSync(file, wrapped);
    const r = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
  });
  it("refuses unapproved plans and runs implement, verify, review, integrate", () => {
    expect(source).toMatch(/plan\.status !== 'approved'/);
    expect(source).toMatch(/isolation: 'worktree'/);
    expect(source).toMatch(/agentType: 'doug-flow:implementer'/);
    expect(source).toMatch(/agentType: 'doug-flow:verifier'/);
    expect(source).toMatch(/agentType: 'doug-flow:reviewer'/);
    expect(source).toMatch(/agentType: 'doug-flow:adversary'/);
    expect(source).toMatch(/await pipeline\(/);
  });
  it("spawns plugin agents only by their namespaced id, so a project agent of the same bare name (.claude/agents/reviewer.md) is never picked", () => {
    // Every agentType in the workflow, and every subagent_type in a skill, is doug-flow:<an agent file> or a Claude Code
    // built-in. A bare name would resolve against the project's own agents in a user's repository.
    const agentFiles = readdirSync(join(root, "agents")).map((f) => f.replace(/\.md$/, ""));
    const workflowTypes = [...source.matchAll(/agentType: '([^']+)'/g)].map((m) => m[1]);
    expect(workflowTypes.length).toBeGreaterThanOrEqual(6);
    for (const t of workflowTypes) {
      expect(t.startsWith("doug-flow:"), t).toBe(true);
      expect(agentFiles, t).toContain(t.slice("doug-flow:".length));
    }
    const builtins = ["claude-code-guide"];
    for (const skill of readdirSync(join(root, "skills"))) {
      const text = readFileSync(join(root, "skills", skill, "SKILL.md"), "utf8");
      for (const m of text.matchAll(/subagent_type: "([^"]+)"/g)) {
        const t = m[1];
        if (builtins.includes(t)) continue;
        expect(t.startsWith("doug-flow:"), `${skill}: ${t}`).toBe(true);
        expect(agentFiles, `${skill}: ${t}`).toContain(t.slice("doug-flow:".length));
      }
    }
    // The generator's project agents share bare names with plugin agents (reviewer); the workflow must not reference any bare name.
    for (const bare of ["reviewer", "coder", "architect", "tester"]) expect(source).not.toMatch(new RegExp(`agentType: '${bare}'`));
  });
  it("never spawns general-purpose, claude, or fork as a subagent type (card no-nested-agents-gate)", () => {
    // A nested general-purpose/claude/fork subagent has no role tool policy - the harness spawns only role
    // agents, so it can only be the session lead orchestrating. Matches subagent_type: "<x>" / '<x>' and
    // agentType: "<x>" / '<x>', including a subagent_type inside an Agent({...}) call, wherever they appear
    // in workflows/*.js, agents/*.md, or skills/*/SKILL.md. Prose mentions of the words elsewhere are fine.
    const forbidden = ["general-purpose", "claude", "fork"];
    // A skill directory without a SKILL.md, or a stray file directly under skills/, is skipped rather than
    // thrown on: existsSync swallows the ENOTDIR/ENOENT a naive join would hit.
    const skillsDir = join(root, "skills");
    const spawnFiles = [
      ...readdirSync(join(root, "workflows")).map((f) => join(root, "workflows", f)),
      ...readdirSync(join(root, "agents")).map((f) => join(root, "agents", f)),
      ...readdirSync(skillsDir).map((s) => join(skillsDir, s, "SKILL.md")).filter((f) => existsSync(f)),
    ];
    const spawnRe = /(?:subagent_type|agentType)\s*:\s*['"]([^'"]+)['"]/g;
    const offenders = [];
    for (const file of spawnFiles) {
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(spawnRe)) {
        const type = m[1];
        if (forbidden.includes(type)) {
          offenders.push(`${file}: spawns subagent_type/agentType "${type}"; the harness spawns only role agents, never general-purpose, claude, or fork (card no-nested-agents-gate)`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
  it("runs codex-review after the reviewer, blocks on fail, blocker, or a configured review that did not run, and can be disabled per plan", () => {
    expect(source).toMatch(/plan\.adversary === false/);
    expect(source).toMatch(/codex-review/);
    expect(source).toMatch(/--sandbox|--spec -/);
    const adversaryOk = new Function(adversaryOkSource() + "\nreturn adversaryOk;")();
    // Not configured (plan.adversary: false): nothing to wait for.
    expect(adversaryOk(null, false)).toBe(true);
    expect(adversaryOk({ ran: false, verdict: "inconclusive", issues: [] }, false)).toBe(true);
    // Configured: a review that did not run (spawn failure, no result) blocks; absent is not passed.
    expect(adversaryOk(null, true)).toBe(false);
    expect(adversaryOk({ ran: false, verdict: "inconclusive", issues: [] }, true)).toBe(false);
    expect(adversaryOk({ ran: true, verdict: "inconclusive", issues: [] }, true)).toBe(true);
    expect(adversaryOk({ ran: true, verdict: "pass", issues: [{ severity: "major" }] }, true)).toBe(true);
    expect(adversaryOk({ ran: true, verdict: "pass", issues: [{ severity: "blocker" }] }, true)).toBe(false);
    expect(adversaryOk({ ran: true, verdict: "fail", issues: [] }, true)).toBe(false);
    // card fix-loop-minor-verdict: a fail verdict with only major/minor issues is pass-with-notes, not a block.
    expect(adversaryOk({ ran: true, verdict: "fail", issues: [{ severity: "minor" }] }, true)).toBe(true);
    expect(adversaryOk({ ran: true, verdict: "fail", issues: [{ severity: "major" }, { severity: "minor" }] }, true)).toBe(true);
    // A blocker among otherwise non-blocking issues still blocks, whatever the verdict text says.
    expect(adversaryOk({ ran: true, verdict: "fail", issues: [{ severity: "minor" }, { severity: "blocker" }] }, true)).toBe(false);
  });
  it("passes resolved model tiers to every stage and never hardcodes a model", () => {
    for (const role of ["lead", "worker", "implement", "verify", "review", "adversary", "integrate", "supervise"]) expect(source).toMatch(new RegExp(`agentOpts\\('${role}'`));
    expect(source).not.toMatch(/model:\s*'(opus|sonnet|haiku|fable)'/);
    // tierFor: task fields for implementers, plan.models.roles for the rest, "inherit" -> undefined/default.
    const start = source.indexOf("const DEFAULT_EFFORT");
    const end = source.indexOf("\n}\n", source.indexOf("function describeTier")) + 3;
    const fns = new Function("plan", source.slice(start, end) + "\nreturn { tierFor, agentOpts, describeTier };");
    const { tierFor, agentOpts } = fns({ models: { roles: { verify: { model: "opus", effort: "inherit" }, review: { model: "inherit", effort: "max" } } } });
    expect(tierFor("implement", { model: "haiku", effort: "low" })).toEqual({ model: "haiku", effort: "low" });
    expect(tierFor("implement", { model: "inherit", effort: "inherit" })).toEqual({ model: undefined, effort: undefined });
    expect(tierFor("verify")).toEqual({ model: "opus", effort: "high" });
    expect(tierFor("review")).toEqual({ model: undefined, effort: "max" });
    expect(tierFor("adversary")).toEqual({ model: undefined, effort: "low" });
    expect(agentOpts("verify", null, { label: "x" })).toEqual({ label: "x", model: "opus", effort: "high" });
    expect(agentOpts("implement", { model: "inherit", effort: "inherit" }, { label: "y" })).toEqual({ label: "y" });
    // The supervisor runs on the cheap tier of the Models table (card fix-loop-supervisor); without one, on the relay
    // model at low effort, and never on the implementer's model.
    expect(tierFor("supervise")).toEqual({ model: "haiku", effort: "low" });
    const withCheap = fns({ models: { roles: {}, tiers: { cheap: { model: "sonnet", effort: "medium" } } } });
    expect(withCheap.tierFor("supervise")).toEqual({ model: "sonnet", effort: "medium" });
    expect(withCheap.describeTier("supervise")).toEqual({ model: "sonnet", effort: "medium" });
    expect(fns({ models: { roles: {}, tiers: { cheap: { model: "inherit", effort: "inherit" } } } }).tierFor("supervise")).toEqual({ model: undefined, effort: "low" });
  });
  it("quotes shell arguments for the adversary command safely", () => {
    const start = source.indexOf("function shellQuote(");
    const shellQuote = new Function(source.slice(start, source.indexOf("\n}\n", start) + 3) + "\nreturn shellQuote;")();
    expect(shellQuote("pnpm test")).toBe("'pnpm test'");
    expect(shellQuote("it's")).toBe("'it'\\''s'");
  });
  it("tells the adversary that a skip naming DOUG_CODEX_REVIEW is expected", () => {
    const start = source.indexOf("function adversaryPrompt(");
    const slice = source.slice(start, source.indexOf("\n}\n", start) + 3);
    expect(slice).toMatch(/DOUG_CODEX_REVIEW=1/);
    expect(slice).toMatch(/skip/i);
    expect(slice).toMatch(/expected/);
    const noteText = "Note to the reviewer: codex-review sets DOUG_CODEX_REVIEW=1";
    const noteIndex = slice.indexOf(noteText);
    const lastDOUG_SPEC_EOF = slice.lastIndexOf("DOUG_SPEC_EOF");
    expect(noteIndex).toBeGreaterThan(-1);
    expect(noteIndex).toBeLessThan(lastDOUG_SPEC_EOF);
  });
  it("tells the adversary that an environment denial such as EPERM on a local listener is inconclusive", () => {
    const start = source.indexOf("function adversaryPrompt(");
    const slice = source.slice(start, source.indexOf("\n}\n", start) + 3);
    expect(slice).toMatch(/EPERM/);
    expect(slice).toMatch(/127\.0\.0\.1/);
    expect(slice).toMatch(/inconclusive, not a blocker/);
    expect(slice.indexOf("environment denial")).toBeGreaterThan(-1);
    expect(slice.indexOf("environment denial")).toBeLessThan(slice.lastIndexOf("DOUG_SPEC_EOF"));
  });
  it("inlines the same levelize algorithm as lib/plan.mjs", () => {
    const start = source.indexOf("function levelize(");
    const end = source.indexOf("\n}\n", start) + 3;
    const inlined = new Function(source.slice(start, end) + "\nreturn levelize;")();
    const t = (id, dependsOn) => ({ id, dependsOn });
    const tasks = [t("a"), t("b", ["a"]), t("c"), t("d", ["b", "c"])];
    expect(inlined(tasks).map((l) => l.map((x) => x.id))).toEqual(libLevelize(tasks).map((l) => l.map((x) => x.id)));
    expect(() => inlined([t("a", ["b"]), t("b", ["a"])])).toThrow(/cycle/);
  });
  it("starts a reused task from its branch without an implementer", async () => {
    const start = source.indexOf("async function startTask(");
    const slice = source.slice(start, source.indexOf("\n}\n", start) + 3);
    const calls = [];
    // swarmApplies is false here: the swarm's own test covers it, and a reused task never swarms.
    const startTask = new Function("agent", "agentOpts", "implementPrompt", "reusePrompt", "IMPLEMENT_SCHEMA", "CHECKOUT_MODEL", "swarmApplies", slice + "\nreturn startTask;")(
      (prompt, opts) => {
        calls.push({ prompt, opts });
        return opts;
      },
      (role, task, extra) => ({ role, ...extra }),
      () => "implement",
      (task) => `reuse ${task.reuse}`,
      { schema: true },
      "small",
      () => false,
    );
    const reused = await startTask({ id: "a", reuse: "doug/task-a" }, "main");
    expect(calls[0].prompt).toBe("reuse doug/task-a");
    expect(reused.isolation).toBe("worktree");
    expect(reused.model).toBe("small");
    expect(reused.label).toBe("reuse:a");
    expect(reused.schema).toEqual({ schema: true });
    expect(reused.agentType).toBeUndefined();
    const fresh = await startTask({ id: "b" }, "main");
    expect(calls[1].prompt).toBe("implement");
    expect(fresh.role).toBe("implement");
    expect(fresh.agentType).toBe("doug-flow:implementer");
    expect(fresh.isolation).toBe("worktree");
  });
  it("tells the implementer and the lead to refuse an existing task branch instead of checking it out (card replan-clean-worktrees)", () => {
    // 2026-09-07, board-reorder: a stale doug/task-<id> from an earlier run was checked out by the next run's
    // implementer, which then built on the old branch. The agent creates the branch, so the refusal is its rule.
    for (const fn of ["implementPrompt", "leadPrompt"]) {
      const start = source.indexOf(`function ${fn}(`);
      const slice = source.slice(start, source.indexOf("\n}\n", start) + 3);
      const prompt = new Function("plan", CONSTS + slice + `\nreturn ${fn};`)({ title: "P", install: null });
      const text = prompt({ id: "a", title: "A", spec: "do a", files: ["x.ts"] }, "main");
      expect(text, fn).toContain("git rev-parse --verify --quiet refs/heads/doug/task-a");
      expect(text, fn).toContain("stale branch doug/task-a already exists");
      expect(text, fn).toContain("plan.mjs replan");
      expect(text, fn).toMatch(/do not check it out[^\n]*blocked=true/);
    }
  });

  it("gives the implementer and the lead a resume prompt for their own run's branch instead of the stale-branch refusal (card implementer-retry-own-branch)", () => {
    // The relaunch of a task within one run (retryOnce's :retry pass) hits its own predecessor's branch, not an
    // earlier run's leftover: implementPrompt/leadPrompt(task, base, { resume: true }) swaps only the stale-branch
    // sentence for wording that says the branch is this run's own and how to pick it up.
    const { NO_TRAILERS } = new Function(CONSTS + "return { NO_TRAILERS };")();
    for (const fn of ["implementPrompt", "leadPrompt"]) {
      const start = source.indexOf(`function ${fn}(`);
      const slice = source.slice(start, source.indexOf("\n}\n", start) + 3);
      const prompt = new Function("plan", CONSTS + slice + `\nreturn ${fn};`)({ title: "P", install: null });
      const task = { id: "a", title: "A", spec: "do a", files: ["x.ts"] };
      const first = prompt(task, "main");
      expect(first, fn).toContain('stale branch doug/task-a already exists');
      const resumed = prompt(task, "main", { resume: true });
      expect(resumed, fn).not.toContain('return blocked=true with blockedReason "stale branch');
      expect(resumed, fn).toContain("git worktree list --porcelain");
      expect(resumed, fn).toContain("git checkout doug/task-a");
      expect(resumed, fn).toContain("same run");
      // A commit made to pick up the predecessor's uncommitted work still carries no attribution trailers
      // (read the real constant's value, not a paraphrase, so a mutation dropping it from the resume wording
      // is caught even if the coder adds or reorders sentences around it).
      expect(resumed, fn).toContain(NO_TRAILERS);
      // First launch (resume false/absent) is unchanged: the stale-branch refusal stays verbatim.
      expect(prompt(task, "main", { resume: false })).toBe(first);
    }
  });
  it("tells the checkout agent to reuse the branch, handle a leftover worktree, and not implement", () => {
    const start = source.indexOf("function reusePrompt(");
    const slice = source.slice(start, source.indexOf("\n}\n", start) + 3);
    const reusePrompt = new Function("plan", CONSTS + slice + "\nreturn reusePrompt;")({ title: "P", install: "pnpm install --frozen-lockfile" });
    const text = reusePrompt({ id: "a", title: "A", reuse: "doug/task-a", files: ["x.ts"] }, "main");
    expect(text).toContain("git checkout doug/task-a");
    expect(text).toContain("git worktree remove --force");
    expect(text).toContain("Do not implement");
    expect(text).toContain("pnpm install --frozen-lockfile");
    expect(text).toContain("git diff --name-only main...HEAD");
    expect(text).toContain('branch="doug/task-a"');
  });
  it("E1: tells the checkout agent to install unconditionally when plan.install is set, keeping today's conditional wording when it isn't (card reused-s-task-worktree-install)", () => {
    const start = source.indexOf("function reusePrompt(");
    const slice = source.slice(start, source.indexOf("\n}\n", start) + 3);
    const withInstall = new Function("plan", CONSTS + slice + "\nreturn reusePrompt;")({ title: "P", install: "pnpm install --frozen-lockfile" });
    const textWith = withInstall({ id: "a", title: "A", reuse: "doug/task-a", files: ["x.ts"] }, "main");
    expect(textWith).toContain("pnpm install --frozen-lockfile");
    expect(textWith).toContain("2. Run the project's install command (pnpm install --frozen-lockfile) before the checks run.");
    expect(textWith).not.toContain("If the task's verification command needs dependencies");

    const withoutInstall = new Function("plan", CONSTS + slice + "\nreturn reusePrompt;")({ title: "P", install: null });
    const textWithout = withoutInstall({ id: "a", title: "A", reuse: "doug/task-a", files: ["x.ts"] }, "main");
    expect(textWithout).not.toContain("pnpm install");
  });
  it("E3: pins the ENVIRONMENT_MARKER constant next to CONTRADICTION_MARKER (card reused-s-task-worktree-install)", () => {
    expect(source).toMatch(/const ENVIRONMENT_MARKER = 'ENVIRONMENT ONLY'/);
  });
  it("records reused, specHash, attempts, and stopReason per task and the checkout model only for reused tasks", () => {
    expect(source).toMatch(/reused:\s*r\.task\.reuse \|\| null/);
    // A batch plan (plan.mjs merge) tags every task with its card; the report keeps it so the run entry per card can filter.
    expect(source).toMatch(/card:\s*r\.task\.card \|\| null/);
    expect(source).toMatch(/specHash:\s*r\.task\.specHash \|\| null/);
    // The lessons plan.mjs json recalled for this task (card memory-recall #2), [] when none matched.
    expect(source).toMatch(/memoryUsed:\s*r\.task\.reuse \|\| !r\.impl \? \[\] : Array\.isArray\(r\.task\.lessonIds\) \? r\.task\.lessonIds : \[\]/);
    // The code chunks plan.mjs json's semantic index search recalled for this task (card semantic-index, brief B), [] when none matched.
    expect(source).toMatch(/indexUsed:\s*r\.task\.reuse \|\| !r\.impl \? \[\] : Array\.isArray\(r\.task\.codeContextIds\) \? r\.task\.codeContextIds : \[\]/);
    expect(source).toMatch(/attempts:\s*r\.attempts/);
    expect(source).toMatch(/stopReason:\s*r\.stopReason/);
    expect(source).toMatch(/const CHECKOUT_MODEL = ADVERSARY_RELAY_MODEL/);
    expect(source).toMatch(/checkout:\s*\{\s*model:\s*CHECKOUT_MODEL/);
    expect(source).toMatch(/task => runTask\(task, baseBranch\)/);
    expect(source).toMatch(/const CONTRADICTION_MARKER = 'SPEC CONTRADICTS ACCEPTANCE'/);
    expect(source).not.toMatch(/task => agent\(implementPrompt/);
    const vStart = source.indexOf("function verifyPrompt(");
    const verify = source.slice(vStart, source.indexOf("\n}\n", vStart) + 3);
    const rStart = source.indexOf("function reviewPrompt(");
    const review = source.slice(rStart, source.indexOf("\n}\n", rStart) + 3);
    for (const slice of [verify, review]) {
      expect(slice).toContain("CONTRADICTION_MARKER");
      expect(slice).toContain("plan.acceptance");
    }
  });
  it("inlines acceptanceEntries handling both acceptance forms", () => {
    const start = source.indexOf("function acceptanceEntries(");
    const slice = source.slice(start, source.indexOf("\n}\n", start) + 3);
    const acceptanceEntries = new Function(slice + "\nreturn acceptanceEntries;")();
    expect(acceptanceEntries(["p", { text: "t", command: "c" }, { text: "u", command: "" }])).toEqual([
      { text: "p", command: null },
      { text: "t", command: "c" },
      { text: "u", command: null },
    ]);
    expect(acceptanceEntries(undefined)).toEqual([]);
  });
  it("lists acceptance commands in the verifier and reviewer prompts and asks for exit codes", () => {
    const aeStart = source.indexOf("function acceptanceEntries(");
    const aeSlice = source.slice(aeStart, source.indexOf("\n}\n", aeStart) + 3);
    const acceptanceEntries = new Function(aeSlice + "\nreturn acceptanceEntries;")();
    const plan = { title: "P", acceptance: ["prose", { text: "x exists", command: "test -f x" }], verify: ["true"] };
    const task = { id: "a", title: "A", spec: "s", files: ["x"] };
    const impl = { worktreePath: "/w", branch: "b", commandsRun: [] };

    const vStart = source.indexOf("function verifyPrompt(");
    const vSlice = source.slice(vStart, source.indexOf("\n}\n", vStart) + 3);
    const verifyPrompt = new Function("plan", "CONTRADICTION_MARKER", "ENVIRONMENT_MARKER", "acceptanceEntries", CONSTS + vSlice + "\nreturn verifyPrompt;")(plan, "SPEC CONTRADICTS ACCEPTANCE", "ENVIRONMENT ONLY", acceptanceEntries);
    const vText = verifyPrompt(task, impl, "main");
    expect(vText).toContain("- prose");
    expect(vText).toContain("- x exists");
    expect(vText).toContain("  $ test -f x");
    expect(vText).toContain("exit code");
    expect(vText).toContain("`acceptance`");

    const rStart = source.indexOf("function reviewPrompt(");
    const rSlice = source.slice(rStart, source.indexOf("\n}\n", rStart) + 3);
    const reviewPrompt = new Function("plan", "CONTRADICTION_MARKER", "acceptanceEntries", rSlice + "\nreturn reviewPrompt;")(plan, "SPEC CONTRADICTS ACCEPTANCE", acceptanceEntries);
    // The reviewer runs beside the verifier and never sees its result.
    expect(reviewPrompt.length).toBe(3);
    const rText = reviewPrompt(task, impl, "main");
    expect(rText).toContain("$ test -f x");
    expect(rText).not.toContain("Verifier result");
    expect(rText).not.toContain("Verifier acceptance results");
  });
  it("E2: verifier, check, and size-check prompts add an install step and the environment-only wording when plan.install is set (card reused-s-task-worktree-install)", () => {
    const plan = { title: "P", install: "pnpm install --frozen-lockfile", acceptance: [], verify: ["true"] };
    const task = { id: "a", title: "A", spec: "s", files: ["x.ts"] };
    const impl = { worktreePath: "/w", branch: "b", commandsRun: [] };

    const aeStart = source.indexOf("function acceptanceEntries(");
    const aeSlice = source.slice(aeStart, source.indexOf("\n}\n", aeStart) + 3);
    const acceptanceEntries = new Function(aeSlice + "\nreturn acceptanceEntries;")();

    const vStart = source.indexOf("function verifyPrompt(");
    const vSlice = source.slice(vStart, source.indexOf("\n}\n", vStart) + 3);
    const verifyPrompt = new Function("plan", "CONTRADICTION_MARKER", "ENVIRONMENT_MARKER", "acceptanceEntries", CONSTS + vSlice + "\nreturn verifyPrompt;")(plan, "SPEC CONTRADICTS ACCEPTANCE", "ENVIRONMENT ONLY", acceptanceEntries);
    const vText = verifyPrompt(task, impl, "main");

    const cStart = source.indexOf("function checkPrompt(");
    const cSlice = source.slice(cStart, source.indexOf("\n}\n", cStart) + 3);
    const checkPrompt = new Function("plan", "CONTRADICTION_MARKER", "ENVIRONMENT_MARKER", "acceptanceEntries", "ledgerText", cSlice + "\nreturn checkPrompt;")(plan, "SPEC CONTRADICTS ACCEPTANCE", "ENVIRONMENT ONLY", acceptanceEntries, () => "");
    const cText = checkPrompt(task, impl, null, "main", []);

    const sStart = source.indexOf("function sizeCheckPrompt(");
    const sSlice = source.slice(sStart, source.indexOf("\n}\n", sStart) + 3);
    const sizeCheckPrompt = new Function("plan", "CONTRADICTION_MARKER", "ENVIRONMENT_MARKER", "acceptanceEntries", CONSTS + sSlice + "\nreturn sizeCheckPrompt;")(plan, "SPEC CONTRADICTS ACCEPTANCE", "ENVIRONMENT ONLY", acceptanceEntries);
    const sText = sizeCheckPrompt(task, impl, "main");

    for (const text of [vText, cText, sText]) {
      expect(text).toContain("pnpm install --frozen-lockfile");
      expect(text).toContain("ENVIRONMENT ONLY: ");
      expect(text).not.toContain("report that as a finding instead");
    }
  });
  it("states one blocker gate, word for word, in the workflow, both adversary agents, and codex-review's prompt", () => {
    const start = source.indexOf("const BLOCKER_GATE");
    // The agents and codex-review carry the sentences as one paragraph, without the workflow's lead-in.
    const gate = new Function(source.slice(start, source.indexOf("\n]\n", start) + 3) + "\nreturn BLOCKER_GATE;")().join(" ").replace(/^What counts as a blocker: a blocker/, "A blocker");
    expect(gate).toContain("a command you ran (an entry in commandsRun) whose exit code or quoted output shows the failure");
    expect(gate).toContain("static inspection alone, with no command that demonstrates it, is major at most");
    expect(gate).toContain("A test-coverage gap against the spec (a requirement without a test, an assertion missing) is major and never a blocker: the reviewer owns spec compliance");
    for (const f of ["agents/adversary.md", "agents/adversary-claude.md", "../../packages/doug-codex/src/prompt.ts"]) expect(readFileSync(join(root, f), "utf8"), f).toContain(gate);
  });
  it("tells every committing prompt and the verifier that commit messages carry no attribution trailers", () => {
    const rule = "Commit messages carry no attribution trailers: no Co-Authored-By line and no Claude-Session line";
    expect(source).toContain(`const NO_TRAILERS = '${rule}`);
    for (const fn of ["implementPrompt", "fixPrompt", "reusePrompt", "integratePrompt", "verifyPrompt"]) {
      const start = source.indexOf(`function ${fn}(`);
      const body = source.slice(start, source.indexOf("\n}\n", start));
      expect(body, fn).toContain("${NO_TRAILERS}");
    }
    const verify = source.slice(source.indexOf("function verifyPrompt("), source.indexOf("function checkPrompt("));
    expect(verify).toContain("3b. Check git log ${baseBranch}..${impl.branch} --format=%h%x20%B");
    expect(verify).toContain("Report such a commit as a finding that names it, and passed=false.");
    expect(readFileSync(join(root, "agents/implementer.md"), "utf8")).toContain(rule);
  });
  it("requires per-criterion acceptance results from the verifier and copies them into the report", () => {
    const start = source.indexOf("const VERIFY_SCHEMA");
    const slice = source.slice(start, source.indexOf("\n}\n", start) + 3);
    const VERIFY_SCHEMA = new Function(slice + "\nreturn VERIFY_SCHEMA;")();
    expect(VERIFY_SCHEMA.required).toContain("acceptance");
    expect(VERIFY_SCHEMA.properties.acceptance.items.required).toEqual(["text", "command", "ok", "exitCode"]);
    expect(source).toMatch(/acceptance:\s*r\.ver && Array\.isArray\(r\.ver\.acceptance\) \? r\.ver\.acceptance : \[\]/);
  });
});

describe("fix loop", () => {
  const task = { id: "a", title: "A", spec: "Make x return 2.", files: ["src/x.ts", "tests/x.test.ts"], verify: "pnpm exec vitest run tests/x.test.ts" };
  const implResult = { taskId: "a", branch: "doug/task-a", worktreePath: "/wt/a", filesTouched: ["src/x.ts"], commandsRun: [], summary: "done", blocked: false, commit: "c1" };
  const passingReview = { taskId: "a", specCompliant: true, inScope: true, approve: true, issues: [] };
  const passingCheck = { taskId: "a", passed: true, commandsRun: [], acceptance: [], findings: [], issues: [], inScope: true };
  // A sibling task of the same plan: the paths it owns are this plan's business, not this task's lane.
  const sibling = { id: "b", title: "B", spec: "Do the other half.", files: ["lib/other.mjs"], verify: "true" };
  const defaultPlan = { title: "P", install: null, verify: ["true"], acceptance: [{ text: "x exists", command: "test -f x" }], tasks: [task, sibling] };

  // An agent stub that dispatches on the label prefix before the second colon and hands each handler the
  // index of that prefix's call, so a stage can answer differently on the first pass and later ones.
  function scripted(handlers, onCall) {
    const calls = [];
    const counts = {};
    const agent = async (prompt, opts) => {
      calls.push({ prompt, opts });
      if (onCall) onCall();
      const prefix = String(opts.label).split(":").slice(0, 2).join(":");
      const index = counts[prefix] === undefined ? 0 : counts[prefix];
      counts[prefix] = index + 1;
      return handlers[prefix] ? handlers[prefix](index) : null;
    };
    return { agent, calls };
  }
  const labelled = (calls, prefix) => calls.filter((c) => String(c.opts.label).startsWith(prefix));
  const fnSlice = (head) => {
    const start = source.indexOf(head);
    return source.slice(start, source.indexOf("\n}\n", start) + 3);
  };
  // The ledger section is self-contained, so one eval gives every finding helper the loop and the prompts use.
  const ledgerModule = () =>
    new Function(
      source.slice(source.indexOf("const LEDGER_CHAR_BUDGET"), source.indexOf("// ---- Prompts")) +
        "\nreturn { LEDGER_CHAR_BUDGET, fingerprint, findingFile, stageFindings, matchFinding, idReport, confirmsFinding, updateLedger, ledgerText };",
    )();
  const budgetsOf = (plan) => {
    const start = source.indexOf("const DEFAULT_BUDGET");
    const end = source.indexOf("\n", source.indexOf("const taskBudget"));
    return new Function("plan", source.slice(start, end) + "\nreturn { DEFAULT_BUDGET, taskBudget };")(plan);
  };
  const blockerGate = () => {
    const start = source.indexOf("const BLOCKER_GATE");
    return new Function(source.slice(start, source.indexOf("\n]\n", start) + 3) + "\nreturn BLOCKER_GATE;")();
  };
  const acceptanceEntriesFn = () => new Function(fnSlice("function acceptanceEntries(") + "\nreturn acceptanceEntries;")();

  // The runtime's parallel(): every thunk runs, a throwing one resolves to null, and the call never rejects.
  const plainParallel = (thunks) => Promise.all(thunks.map((t) => Promise.resolve().then(t).catch(() => null)));

  const taskShape = new Function(fnSlice("function taskShape(") + "\nreturn taskShape;")();

  function loadLoop({ agent, fixAttempts, adversary = null, plan = defaultPlan, budget = null, parallel = plainParallel, log = () => {}, implementPrompt = () => "implement", leadPrompt = () => "lead" }) {
    const ledger = ledgerModule();
    const adversaryRequired = (t) => !!adversary && taskShape(t) !== "S";
    const { taskBudget } = budgetsOf(plan);
    const fixPrompt = new Function("plan", "fixAttempts", "ledgerText", CONSTS + fnSlice("function fixPrompt(") + "\nreturn fixPrompt;")(plan, fixAttempts, ledger.ledgerText);
    const checkPrompt = new Function(
      "plan", "CONTRADICTION_MARKER", "ENVIRONMENT_MARKER", "acceptanceEntries", "ledgerText",
      fnSlice("function checkPrompt(") + "\nreturn checkPrompt;",
    )(plan, "SPEC CONTRADICTS ACCEPTANCE", "ENVIRONMENT ONLY", acceptanceEntriesFn(), ledger.ledgerText);
    const adversaryOk = new Function(adversaryOkSource() + "\nreturn adversaryOk;")();
    const adversaryUnavailable = new Function(fnSlice("function adversaryUnavailable(") + "\nreturn adversaryUnavailable;")();
    const block = source.slice(source.indexOf("async function startTask("), source.indexOf("\n}\n", source.indexOf("async function runTask(")) + 3);
    return new Function(
      "plan", "agent", "parallel", "agentOpts", "log", "budget", "taskBudget", "updateLedger", "taskShape", "adversaryRequired", "sizeCheckPrompt",
      "implementPrompt", "reusePrompt", "fixPrompt", "verifyPrompt", "reviewPrompt", "checkPrompt", "adversaryPrompt", "adversaryOk",
      "adversaryUnavailable", "fallbackAdversaryPrompt", "leadPrompt", "workerPrompt", "leadMergePrompt", "leadRebriefPrompt", "resumePrompt", "LEAD_SCHEMA",
      "IMPLEMENT_SCHEMA", "VERIFY_SCHEMA", "REVIEW_SCHEMA", "CHECK_SCHEMA", "ADVERSARY_SCHEMA", "CHECKOUT_MODEL", "CONTRADICTION_MARKER", "ENVIRONMENT_MARKER", "adversary", "fixAttempts", "supervisePrompt", "SUPERVISE_SCHEMA",
      block + "\nreturn { startTask, runtimeSpend, findingPaths, retriable, runTask, stallSignals };",
    )(
      plan,
      agent,
      parallel,
      (role, t, extra) => ({ role, ...extra }),
      log,
      budget,
      taskBudget,
      ledger.updateLedger,
      taskShape,
      adversaryRequired,
      () => "size-check",
      implementPrompt,
      (t) => `reuse ${t.reuse}`,
      fixPrompt,
      () => "verify",
      () => "review",
      checkPrompt,
      () => "adversary",
      adversaryOk,
      adversaryUnavailable,
      (task, impl, base, why) => `adversary-fallback: ${why}`,
      leadPrompt,
      (t, brief, n, lead) => `worker ${n} ${brief.id} from ${lead.branch}`,
      (t, lead, workers) => `merge ${workers.map((w) => w.branch).join(", ")}`,
      (t, lead, workers, blockedWorkers) => `rebrief ${blockedWorkers.map((w) => `${w.id}: ${w.blockedReason}`).join(", ")} | finished ${workers.filter((w) => !w.blocked).map((w) => `${w.id}:${w.commit}`).join(", ")}`,
      (t, prev, handoff, base, brief) => `resume ${brief ? `${brief.id} of ${t.id}` : t.id}`,
      { schema: "lead" },
      { schema: "implement" },
      { schema: "verify" },
      { schema: "review" },
      { schema: "check" },
      { schema: "adversary" },
      "small",
      "SPEC CONTRADICTS ACCEPTANCE",
      "ENVIRONMENT ONLY",
      adversary,
      fixAttempts,
      (task, r, attempts, ledger, signals) => `supervise ${signals.map((x) => x.kind).join(",")}`,
      { schema: "supervise" }
    );
  }

  it("launches the verifier and the reviewer together on a first pass, and each alone on a fix pass", async () => {
    const { agent, calls } = scripted({
      "implement:a": () => implResult,
      "verify:a": (i) => (i === 0 ? { taskId: "a", passed: false, findings: ["src/x.ts returns 1"] } : { taskId: "a", passed: true, findings: [] }),
      "review:a": () => passingReview,
      "check:a": () => passingCheck,
      "fix:a": () => ({ ...implResult, commit: "c2" }),
    });
    const batches = [];
    const parallel = async (thunks) => {
      const before = calls.length;
      const out = await plainParallel(thunks);
      batches.push(calls.slice(before).map((c) => c.opts.label));
      return out;
    };
    const r = await loadLoop({ agent, fixAttempts: 2, parallel }).runTask(task, "main");
    expect(batches).toEqual([["verify:a", "review:a"]]);
    expect(calls.map((c) => c.opts.label)).toEqual(["implement:a", "verify:a", "review:a", "fix:a:2", "verify:a:2", "check:a:2"]);
    expect(r.attempts[0].stages).toEqual(["implement", "verify", "review"]);
    // The reviewer's prompt is built without the verifier's result.
    expect(source).toMatch(/const pair = await parallel\(\[\n\s*\(\) => launch\(verifyPrompt\(task, impl, baseBranch\)/);
    expect(source).toMatch(/\(\) => launch\(reviewPrompt\(task, impl, baseBranch\)/);
    expect(source).not.toMatch(/reviewPrompt\(task, impl, ver, baseBranch\)/);
    // Three batches only: the first-pass verifier plus review crew, the review crew on a fix pass, and the adversary crew.
    expect(source.match(/await parallel\(/g).length).toBe(4);
  });


  it("runs a full-shape task as a swarm when the plan opts in: a lead splits it, workers run in parallel, the lead merges, and the checks read the merge", async () => {
    // card swarm-lead: the swarm replaces the implementer stage only; scope never widens past the task's files.
    const swarmPlan = { ...defaultPlan, swarm: true };
    // card swarm-topology: the shape gate needs two or more source (non-test) files to split at all; the shared
    // `task` fixture owns only one (src/x.ts, plus its test), so this test gets its own splittable variant.
    const swarmTask = { ...task, files: ["src/x.ts", "src/y.ts", "tests/x.test.ts"] };
    const leadResult = { taskId: "a", branch: "doug/task-a", worktreePath: "/wt/lead", briefs: [{ id: "core", title: "Core", spec: "Make x return 2 in src/x.ts.", files: ["src/x.ts"], verify: null }, { id: "tests", title: "Tests", spec: "Test x in tests/x.test.ts.", files: ["tests/x.test.ts"], verify: "pnpm exec vitest run tests/x.test.ts" }], blocked: false, splitReason: "two independent deliverables: x's behavior and its test, each verified on its own" };
    const worker = (n) => ({ taskId: "a", branch: `doug/task-a-w${n}`, worktreePath: `/wt/w${n}`, filesTouched: [n === 1 ? "src/x.ts" : "tests/x.test.ts"], commandsRun: [{ command: "true", ok: true }], summary: "done", blocked: false, commit: `w${n}c1` });
    const merged = { ...implResult, worktreePath: "/wt/lead", commit: "m1", summary: "merged core, tests" };
    const { agent, calls } = scripted({
      "lead:a": () => leadResult,
      "worker:a": (i) => worker(i + 1),
      "lead-merge:a": () => merged,
      "verify:a": () => ({ taskId: "a", passed: true, findings: [] }),
      "review:a": () => passingReview,
    });
    const batches = [];
    const parallel = async (thunks) => {
      const before = calls.length;
      const out = await plainParallel(thunks);
      batches.push(calls.slice(before).map((c) => c.opts.label));
      return out;
    };
    const r = await loadLoop({ agent, fixAttempts: 2, plan: swarmPlan, parallel }).runTask(swarmTask, "main");
    expect(calls.map((c) => c.opts.label)).toEqual(["lead:a", "worker:a:1", "worker:a:2", "lead-merge:a", "verify:a", "review:a"]);
    expect(batches[0]).toEqual(["worker:a:1", "worker:a:2"]);
    // The lead runs on the lead row in its own worktree; workers are implementers on the worker row, one worktree each.
    expect(calls[0].opts).toEqual({ role: "lead", label: "lead:a", phase: "Implement", isolation: "worktree", agentType: "doug-flow:lead", schema: { schema: "lead" } });
    expect(calls[1].opts).toEqual({ role: "worker", label: "worker:a:1", phase: "Implement", isolation: "worktree", agentType: "doug-flow:implementer", schema: { schema: "implement" } });
    expect(calls[3].opts).toEqual({ role: "lead", label: "lead-merge:a", phase: "Implement", agentType: "doug-flow:lead", schema: { schema: "implement" } });
    expect(calls[1].prompt).toBe("worker 1 core from doug/task-a");
    expect(calls[3].prompt).toBe("merge doug/task-a-w1, doug/task-a-w2");
    // The checks read the lead's merged branch, and the pass records every agent.
    expect(r.impl.branch).toBe("doug/task-a");
    expect(r.impl.worktreePath).toBe("/wt/lead");
    expect(r.impl.commit).toBe("m1");
    expect(r.attempts[0].stages).toEqual(["lead", "worker-1", "worker-2", "lead-merge", "verify", "review"]);
    expect(r.attempts[0].spent.agents).toBe(6);
    expect(r.stopReason).toBeNull();
    expect(r.impl.workers.map((w) => [w.n, w.id, w.files, w.branch, w.commit, w.blocked])).toEqual([[1, "core", ["src/x.ts"], "doug/task-a-w1", "w1c1", false], [2, "tests", ["tests/x.test.ts"], "doug/task-a-w2", "w2c1", false]]);

    // A brief that names a file the task does not own blocks the task before any worker runs; so does an overlap.
    const widening = scripted({ "lead:a": () => ({ ...leadResult, briefs: [{ id: "core", title: "Core", spec: "x", files: ["src/x.ts", "lib/other.mjs"] }] }) });
    const w = await loadLoop({ agent: widening.agent, fixAttempts: 2, plan: swarmPlan }).runTask(swarmTask, "main");
    expect(widening.calls.map((c) => c.opts.label)).toEqual(["lead:a"]);
    expect(w.impl.blocked).toBe(true);
    expect(w.stopReason).toBe("blocked: lead brief core names a file the task does not own: lib/other.mjs; not retried: implementer blocked: lead brief core names a file the task does not own: lib/other.mjs");
    expect(w.attempts[0].stages).toEqual(["lead"]);
    const overlap = scripted({ "lead:a": () => ({ ...leadResult, briefs: [{ id: "one", title: "1", spec: "x", files: ["src/x.ts"] }, { id: "two", title: "2", spec: "y", files: ["src/x.ts"] }] }) });
    const o = await loadLoop({ agent: overlap.agent, fixAttempts: 2, plan: swarmPlan }).runTask(swarmTask, "main");
    expect(o.stopReason).toContain("lead briefs overlap on src/x.ts");

    // A blocked worker blocks the task with the worker named; the lead merge never runs.
    // card swarm-topology (candidate 2): a genuinely blocked (not still-partial) worker gets the lead one re-brief
    // attempt before the task blocks; a lead that does not answer it (here, no handler) still ends the task blocked.
    const stuck = scripted({ "lead:a": () => leadResult, "worker:a": (i) => (i === 0 ? worker(1) : { ...worker(2), blocked: true, blockedReason: "needs src/y.ts" }) });
    const s = await loadLoop({ agent: stuck.agent, fixAttempts: 2, plan: swarmPlan }).runTask(swarmTask, "main");
    expect(stuck.calls.map((c) => c.opts.label)).toEqual(["lead:a", "worker:a:1", "worker:a:2", "lead-rebrief:a"]);
    expect(s.stopReason).toContain("worker blocked: 2 (tests): needs src/y.ts");
    expect(s.stopReason).toContain("lead rebrief returned nothing");
    // review minor 4: the lead never produced a usable re-brief (no handler answered it), so the blocked round-one
    // worker is not marked rebriefed - that only happens once a revised brief has passed every check.
    expect(s.impl.workers[1]).toMatchObject({ n: 2, blocked: true, blockedReason: "needs src/y.ts" });
    expect(s.impl.workers[1].rebriefed).toBeFalsy();
    expect(s.impl.worktreePath).toBe("/wt/lead");

    // A size-S task, a reused task, and a plan without swarm keep the single implementer.
    const plain = scripted({ "implement:a": () => implResult, "check:a": () => passingCheck });
    await loadLoop({ agent: plain.agent, fixAttempts: 2, plan: swarmPlan }).runTask({ ...task, size: "S" }, "main");
    expect(plain.calls.map((c) => c.opts.label)).toEqual(["implement:a", "check:a"]);
    const off = scripted({ "implement:a": () => implResult, "verify:a": () => ({ taskId: "a", passed: true, findings: [] }), "review:a": () => passingReview });
    await loadLoop({ agent: off.agent, fixAttempts: 2 }).runTask(task, "main");
    expect(off.calls[0].opts.label).toBe("implement:a");
    // The report records the workers, the swarm gate's own record, and the lead and worker tiers; the prompts carry
    // the split and merge rules.
    expect(source).toMatch(/workers:\s*r\.impl && Array\.isArray\(r\.impl\.workers\) \? r\.impl\.workers : null/);
    expect(source).toMatch(/swarm: swarmReport\(r\.task, r\.impl\)/);
    expect(source).toMatch(/plan\.swarm === true \? \{ lead: describeTier\('lead'\), worker: describeTier\('worker'\) \}/);
    const leadPrompt = new Function("plan", fnSlice("function leadPrompt(") + "\nreturn leadPrompt;")(defaultPlan);
    const text = leadPrompt(task, "main");
    for (const s of ["git checkout -b doug/task-a main", "no file is in two briefs", "never widen", "blocked=true"]) expect(text).toContain(s);
    const workerPrompt = new Function("plan", CONSTS + fnSlice("function workerPrompt(") + "\nreturn workerPrompt;")(defaultPlan);
    const wp = workerPrompt(task, leadResult.briefs[1], 2, leadResult);
    for (const s of ["worker 2 of a swarm", "git checkout -b doug/task-a-w2 doug/task-a", "tests/x.test.ts", "pnpm exec vitest run tests/x.test.ts", "carry no attribution trailers", "a: w2 "]) expect(wp).toContain(s);
    // card swarm-topology: the sibling list may name core's file (src/x.ts), but the "Files you own" line - the
    // one rule a worker must not misread - names only this brief's own file.
    const ownLine = wp.split("\n").find((l) => l.startsWith("Files you own"));
    expect(ownLine).toBe("Files you own (you may create or edit ONLY these): tests/x.test.ts");
    const mergePrompt = new Function("plan", CONSTS + fnSlice("function leadMergePrompt(") + "\nreturn leadMergePrompt;")(defaultPlan);
    const mp = mergePrompt(task, leadResult, r.impl.workers, "main");
    for (const s of ["git merge --no-ff", "doug/task-a-w1", "doug/task-a-w2", "git worktree remove --force", "git diff --name-only main...HEAD", "Do not implement missing pieces yourself"]) expect(mp).toContain(s);
  });

  it("card swarm-topology: a deterministic shape gate, a required splitReason, and interface context in every brief", async () => {
    const swarmPlan = { ...defaultPlan, swarm: true };
    // splittable, swarmApplies, and swarmReport together (swarmReport calls swarmApplies, which calls splittable).
    const swarmHelpers = (planObj, logFn = () => {}) =>
      new Function(
        "plan", "taskShape", "log",
        source.slice(source.indexOf("function isTestFile("), source.indexOf("\n}\n", source.indexOf("function swarmReport(")) + 3) +
          "\nreturn { splittable, swarmApplies, swarmReport };",
      )(planObj, taskShape, logFn);
    const helpers = swarmHelpers(swarmPlan);

    // Shape gate: `task` owns one source file and its tests, so it never reaches the lead even with swarm on.
    const unsplit = scripted({
      "implement:a": () => implResult,
      "verify:a": () => ({ taskId: "a", passed: true, findings: [] }),
      "review:a": () => passingReview,
    });
    const ur = await loadLoop({ agent: unsplit.agent, fixAttempts: 2, plan: swarmPlan }).runTask(task, "main");
    expect(unsplit.calls.map((c) => c.opts.label)).toEqual(["implement:a", "verify:a", "review:a"]);
    expect(helpers.swarmApplies(task)).toBe(false);
    expect(helpers.swarmReport(task, ur.impl)).toEqual({ applies: false, reason: "one source file and its tests", splitReason: null, briefs: null, rebrief: null, workerCheck: false, checkFailed: [] });

    // A size-S task records reason "size S", whatever its file count.
    expect(helpers.swarmReport({ ...task, size: "S" }, null)).toEqual({ applies: false, reason: "size S", splitReason: null, briefs: null, rebrief: null, workerCheck: false, checkFailed: [] });

    // A splittable task (two source files, one test) applies; the report carries the lead's own splitReason and brief count.
    const swarmTask = { ...task, files: ["src/x.ts", "src/y.ts", "tests/x.test.ts"] };
    const leadResult = { taskId: "a", branch: "doug/task-a", worktreePath: "/wt/lead", briefs: [{ id: "core", title: "Core", spec: "s", files: ["src/x.ts"] }, { id: "tests", title: "Tests", spec: "t", files: ["tests/x.test.ts"] }], blocked: false, splitReason: "two independent deliverables, each verified on its own" };
    const worker = (n) => ({ taskId: "a", branch: `doug/task-a-w${n}`, worktreePath: `/wt/w${n}`, filesTouched: [n === 1 ? "src/x.ts" : "tests/x.test.ts"], commandsRun: [], summary: "done", blocked: false, commit: `w${n}c1` });
    const split = scripted({
      "lead:a": () => leadResult,
      "worker:a": (i) => worker(i + 1),
      "lead-merge:a": () => ({ ...implResult, worktreePath: "/wt/lead", commit: "m1" }),
      "verify:a": () => ({ taskId: "a", passed: true, findings: [] }),
      "review:a": () => passingReview,
    });
    const sr = await loadLoop({ agent: split.agent, fixAttempts: 2, plan: swarmPlan }).runTask(swarmTask, "main");
    expect(helpers.swarmApplies(swarmTask)).toBe(true);
    expect(helpers.swarmReport(swarmTask, sr.impl)).toEqual({ applies: true, reason: "two or more source files", splitReason: leadResult.splitReason, briefs: 2, rebrief: null, workerCheck: false, checkFailed: [] });

    // MAJOR (review): a swarmed task that takes a fix pass still reports its splitReason and workers - the fix
    // pass itself is one implementer (not another lead), so the fix result carries none of them on its own; the
    // loop must carry them forward from the swarm's own first-pass result.
    const fixedSplit = scripted({
      "lead:a": () => leadResult,
      "worker:a": (i) => worker(i + 1),
      "lead-merge:a": () => ({ ...implResult, worktreePath: "/wt/lead", commit: "m1" }),
      "verify:a": (i) => (i === 0 ? { taskId: "a", passed: false, findings: ["src/x.ts returns 1"] } : { taskId: "a", passed: true, findings: [] }),
      "review:a": () => passingReview,
      "check:a": () => passingCheck,
      "fix:a": () => ({ ...implResult, commit: "m2" }),
    });
    const fr = await loadLoop({ agent: fixedSplit.agent, fixAttempts: 2, plan: swarmPlan }).runTask(swarmTask, "main");
    expect(fixedSplit.calls.map((c) => c.opts.label)).toEqual(["lead:a", "worker:a:1", "worker:a:2", "lead-merge:a", "verify:a", "review:a", "fix:a:2", "verify:a:2", "check:a:2"]);
    expect(fr.impl.workers).toHaveLength(2);
    expect(helpers.swarmReport(swarmTask, fr.impl)).toEqual({ applies: true, reason: "two or more source files", splitReason: leadResult.splitReason, briefs: 2, rebrief: null, workerCheck: false, checkFailed: [] });

    // MINOR 2c (review): the fix-loop carry-forward also carries checkFailed the way it carries workers/rebrief -
    // with workerCheck on and a clean worker set, the fixed impl's checkFailed is an array ([]), not undefined.
    const swarmPlanChecked = { ...swarmPlan, workerCheck: true };
    const fixedSplitChecked = scripted({
      "lead:a": () => leadResult,
      "worker:a": (i) => worker(i + 1),
      "lead-merge:a": () => ({ ...implResult, worktreePath: "/wt/lead", commit: "m1" }),
      "verify:a": (i) => (i === 0 ? { taskId: "a", passed: false, findings: ["src/x.ts returns 1"] } : { taskId: "a", passed: true, findings: [] }),
      "review:a": () => passingReview,
      "check:a": () => passingCheck,
      "fix:a": () => ({ ...implResult, commit: "m2" }),
    });
    const frChecked = await loadLoop({ agent: fixedSplitChecked.agent, fixAttempts: 2, plan: swarmPlanChecked }).runTask(swarmTask, "main");
    expect(Array.isArray(frChecked.impl.checkFailed)).toBe(true);
    expect(frChecked.impl.checkFailed).toEqual([]);

    // MINOR (review): swarmReport must not call swarmApplies again - swarmApplies already logs the shape-gate
    // line once (from startTask, above, on the unsplit task); a second call from swarmReport would double it.
    const logs = [];
    const loggedHelpers = swarmHelpers(swarmPlan, (msg) => logs.push(msg));
    loggedHelpers.swarmApplies(task);
    loggedHelpers.swarmReport(task, null);
    expect(logs.filter((m) => m.includes("shape gate"))).toHaveLength(1);

    // A lead result with no splitReason blocks before any worker launches.
    const noReason = scripted({ "lead:a": () => ({ ...leadResult, splitReason: undefined }) });
    const nr = await loadLoop({ agent: noReason.agent, fixAttempts: 2, plan: swarmPlan }).runTask(swarmTask, "main");
    expect(noReason.calls.map((c) => c.opts.label)).toEqual(["lead:a"]);
    expect(nr.impl.blocked).toBe(true);
    expect(nr.impl.blockedReason).toBe("lead gave no splitReason");

    // LEAD_SCHEMA requires splitReason and offers an optional interfaces string.
    const leadSchemaStart = source.indexOf("const LEAD_SCHEMA");
    const LEAD_SCHEMA = new Function(source.slice(leadSchemaStart, source.indexOf("\n}\n", leadSchemaStart) + 3) + "\nreturn LEAD_SCHEMA;")();
    expect(LEAD_SCHEMA.required).toContain("splitReason");
    expect(LEAD_SCHEMA.properties.interfaces).toBeDefined();

    // leadPrompt carries the positive trigger, the one-brief reason rule, the checklist, and splitReason.
    const leadPrompt = new Function("plan", fnSlice("function leadPrompt(") + "\nreturn leadPrompt;")(defaultPlan);
    const lp = leadPrompt(swarmTask, "main");
    for (const s of [
      "two or more deliverables",
      "share no new symbol",
      "File count alone is not a reason to split: independence of deliverables is.",
      "splitReason",
      "an objective",
      "the test to write and how to run it",
      "the interfaces it exposes or consumes",
      "scope boundaries",
      "the expected result shape",
    ]) expect(lp).toContain(s);

    // workerPrompt carries the plan goal, the task's full spec, the interfaces block, and the sibling brief.
    const goalPlan = { ...defaultPlan, goal: "Ship the feature." };
    const workerPrompt = new Function("plan", CONSTS + fnSlice("function workerPrompt(") + "\nreturn workerPrompt;")(goalPlan);
    const leadWithInterfaces = { ...leadResult, interfaces: "core exports add(a, b) from src/x.ts" };
    const wp2 = workerPrompt(swarmTask, leadWithInterfaces.briefs[1], 2, leadWithInterfaces);
    expect(wp2).toContain("Ship the feature.");
    expect(wp2).toContain(swarmTask.spec);
    expect(wp2).toContain("core exports add(a, b) from src/x.ts");
    expect(wp2).toContain("- core: Core (src/x.ts)");
    const ownLine2 = wp2.split("\n").find((l) => l.startsWith("Files you own"));
    expect(ownLine2).toBe("Files you own (you may create or edit ONLY these): tests/x.test.ts");
    // MINOR (review): a lead result without interfaces carries no heading for it.
    const wpNoInterfaces = workerPrompt(swarmTask, leadResult.briefs[1], 2, leadResult);
    expect(wpNoInterfaces).not.toContain("Interfaces the briefs export");
    // MINOR (review): a lead's interfaces are capped the same way the lessons block is.
    const longInterfaces = "i".repeat(2500);
    const wpCapped = workerPrompt(swarmTask, leadResult.briefs[1], 2, { ...leadResult, interfaces: longInterfaces });
    expect(wpCapped).toContain(longInterfaces.slice(0, 2000));
    expect(wpCapped).not.toContain(longInterfaces.slice(0, 2001));
  });

  it("card swarm-topology: one worker blocked gets the lead one re-brief before the task blocks", async () => {
    const swarmPlan = { ...defaultPlan, swarm: true };
    const swarmHelpers = (planObj, logFn = () => {}) =>
      new Function(
        "plan", "taskShape", "log",
        source.slice(source.indexOf("function isTestFile("), source.indexOf("\n}\n", source.indexOf("function swarmReport(")) + 3) +
          "\nreturn { splittable, swarmApplies, swarmReport };",
      )(planObj, taskShape, logFn);
    const helpers = swarmHelpers(swarmPlan);

    const swarmTask = { ...task, files: ["src/x.ts", "src/y.ts", "tests/x.test.ts"] };
    const leadResult = {
      taskId: "a", branch: "doug/task-a", worktreePath: "/wt/lead",
      briefs: [
        { id: "core", title: "Core", spec: "Add the Task type and x() in src/x.ts.", files: ["src/x.ts"] },
        { id: "tests", title: "Tests", spec: "Test x() in tests/x.test.ts.", files: ["tests/x.test.ts"] },
      ],
      blocked: false, splitReason: "two independent deliverables, each verified on its own",
    };
    const worker1 = { taskId: "a", branch: "doug/task-a-w1", worktreePath: "/wt/w1", filesTouched: ["src/x.ts"], commandsRun: [], summary: "done", blocked: false, commit: "w1c1" };
    const worker2Blocked = { taskId: "a", branch: "doug/task-a-w2", worktreePath: "/wt/w2", filesTouched: [], commandsRun: [], summary: "blocked", blocked: true, blockedReason: "needs the Task type from src/y.ts", commit: null };
    const rebriefResult = {
      taskId: "a", branch: "doug/task-a", worktreePath: "/wt/lead",
      briefs: [{ id: "tests-2", title: "Tests (revised)", spec: "The Task type is { id: string, done: boolean }; write the test using that shape.", files: ["tests/x.test.ts"] }],
      blocked: false, splitReason: "gave the worker the Task type inline instead of file access",
    };
    const worker3 = { taskId: "a", branch: "doug/task-a-w3", worktreePath: "/wt/w3", filesTouched: ["tests/x.test.ts"], commandsRun: [], summary: "done", blocked: false, commit: "w3c1" };
    const merged = { ...implResult, worktreePath: "/wt/lead", commit: "m1", summary: "merged core, tests-2" };

    const { agent, calls } = scripted({
      "lead:a": () => leadResult,
      "worker:a": (i) => (i === 0 ? worker1 : i === 1 ? worker2Blocked : worker3),
      "lead-rebrief:a": () => rebriefResult,
      "lead-merge:a": () => merged,
      "verify:a": () => ({ taskId: "a", passed: true, findings: [] }),
      "review:a": () => passingReview,
    });
    const r = await loadLoop({ agent, fixAttempts: 2, plan: swarmPlan }).runTask(swarmTask, "main");
    expect(calls.map((c) => c.opts.label)).toEqual(["lead:a", "worker:a:1", "worker:a:2", "lead-rebrief:a", "worker:a:3", "lead-merge:a", "verify:a", "review:a"]);
    // The re-brief runs on the lead row, in the lead's existing worktree - no isolation key.
    expect(calls[3].opts).toEqual({ role: "lead", label: "lead-rebrief:a", phase: "Implement", agentType: "doug-flow:lead", schema: { schema: "lead" } });
    expect(calls[3].prompt).toContain("tests");
    expect(calls[3].prompt).toContain("needs the Task type from src/y.ts");
    expect(calls[3].prompt).toContain("w1c1");
    // The merge prompt lists the finished round-one worker and the round-two worker, not the blocked round-one one.
    expect(calls[5].prompt).toBe("merge doug/task-a-w1, doug/task-a-w3");
    expect(r.impl.branch).toBe("doug/task-a");
    expect(r.impl.commit).toBe("m1");
    expect(r.attempts[0].stages).toEqual(["lead", "worker-1", "worker-2", "lead-rebrief", "worker-3", "lead-merge", "verify", "review"]);
    expect(r.stopReason).toBeNull();
    expect(r.impl.workers).toHaveLength(3);
    expect(r.impl.workers.map((w) => [w.n, w.round, !!w.rebriefed])).toEqual([[1, 1, false], [2, 1, true], [3, 2, false]]);
    // review minor 6: swarmReport.briefs is the first split's own count (2: core, tests), not every worker ever
    // launched across both rounds; rebrief.briefs is the revised split's own count, kept separate.
    expect(helpers.swarmReport(swarmTask, r.impl)).toEqual({ applies: true, reason: "two or more source files", splitReason: leadResult.splitReason, briefs: 2, rebrief: { reason: rebriefResult.splitReason, briefs: 1 }, workerCheck: false, checkFailed: [] });

    const workerPromptReal = new Function("plan", CONSTS + fnSlice("function workerPrompt(") + "\nreturn workerPrompt;")(swarmPlan);
    // Worker 3's branch line still bases off the lead's own branch, not the revised brief's.
    const wp3 = workerPromptReal(swarmTask, rebriefResult.briefs[0], 3, leadResult);
    expect(wp3).toContain("git checkout -b doug/task-a-w3 doug/task-a");
    // review MAJOR 1: round two's own "lead view" for workerPrompt is the finished round-one briefs plus the
    // revised ones - core survives as a sibling, the replaced "tests" brief is gone, worker 3 still owns only its
    // own file, and a revised interfaces string overrides the first split's.
    const finishedBriefs = [leadResult.briefs[0]];
    const round2LeadView = { ...leadResult, briefs: [...finishedBriefs, ...rebriefResult.briefs] };
    const wp3b = workerPromptReal(swarmTask, rebriefResult.briefs[0], 3, round2LeadView);
    expect(wp3b).toContain("- core: Core (src/x.ts)");
    expect(wp3b).not.toContain("tests:");
    const ownLine3 = wp3b.split("\n").find((l) => l.startsWith("Files you own"));
    expect(ownLine3).toBe("Files you own (you may create or edit ONLY these): tests/x.test.ts");
    const round2LeadWithInterfaces = { ...round2LeadView, interfaces: "tests-2 uses Task = { id: string, done: boolean } from src/y.ts" };
    const wp3c = workerPromptReal(swarmTask, rebriefResult.briefs[0], 3, round2LeadWithInterfaces);
    expect(wp3c).toContain("tests-2 uses Task = { id: string, done: boolean } from src/y.ts");

    // review MAJOR 2: leadRebriefPrompt's own text (not the loadLoop stub) names the blocked brief and its reason,
    // the finished worker's id and commit, and the required rules.
    const leadRebriefPromptReal = new Function("plan", CONSTS + fnSlice("function leadRebriefPrompt(") + "\nreturn leadRebriefPrompt;")(swarmPlan);
    const round1Records = [
      { n: 1, id: "core", title: "Core", files: ["src/x.ts"], blocked: false, commit: "w1c1" },
      { n: 2, id: "tests", title: "Tests", files: ["tests/x.test.ts"], blocked: true, blockedReason: "needs the Task type from src/y.ts", commit: null },
    ];
    const rbp = leadRebriefPromptReal(swarmTask, leadResult, round1Records, round1Records.filter((w) => w.blocked));
    for (const s of ["tests", "needs the Task type from src/y.ts", "core", "w1c1", "revised briefs for the unfinished pieces only", "splitReason", "blocked=true"]) expect(rbp).toContain(s);

    // review minor 5: leadMergePrompt merges only the finished workers but removes every worker's worktree, blocked
    // ones included, so a re-briefed-away worker's worktree is not left an orphan.
    const leadMergePromptReal = new Function("plan", CONSTS + fnSlice("function leadMergePrompt(") + "\nreturn leadMergePrompt;")(swarmPlan);
    const mergeWorkerRecords = [
      { n: 1, id: "core", files: ["src/x.ts"], branch: "doug/task-a-w1", worktreePath: "/wt/w1" },
      { n: 3, id: "tests-2", files: ["tests/x.test.ts"], branch: "doug/task-a-w3", worktreePath: "/wt/w3" },
    ];
    const allWorkerRecords = [mergeWorkerRecords[0], { n: 2, id: "tests", files: ["tests/x.test.ts"], branch: "doug/task-a-w2", worktreePath: "/wt/w2" }, mergeWorkerRecords[1]];
    const mpRebrief = leadMergePromptReal(swarmTask, leadResult, mergeWorkerRecords, "main", allWorkerRecords);
    expect(mpRebrief).toContain("/wt/w2");
    expect(mpRebrief).not.toContain("doug/task-a-w2");

    // A round-two worker that blocks ends the task as today: no merge, the message names the worker, and the
    // report still shows the re-brief that was actually made (review minor 3), since it did happen.
    const worker3Blocked = { ...worker3, blocked: true, blockedReason: "still needs the Task type", commit: null, filesTouched: [] };
    const stuck2 = scripted({
      "lead:a": () => leadResult,
      "worker:a": (i) => (i === 0 ? worker1 : i === 1 ? worker2Blocked : worker3Blocked),
      "lead-rebrief:a": () => rebriefResult,
    });
    const s2 = await loadLoop({ agent: stuck2.agent, fixAttempts: 2, plan: swarmPlan }).runTask(swarmTask, "main");
    expect(stuck2.calls.map((c) => c.opts.label)).not.toContain("lead-merge:a");
    expect(s2.stopReason).toContain("worker blocked: 3 (");
    expect(helpers.swarmReport(swarmTask, s2.impl).rebrief).toEqual({ reason: rebriefResult.splitReason, briefs: 1 });

    // A revised brief that names a finished worker's file blocks the task naming the file; no worker 3 launches.
    const widening = scripted({
      "lead:a": () => leadResult,
      "worker:a": (i) => (i === 0 ? worker1 : worker2Blocked),
      "lead-rebrief:a": () => ({ ...rebriefResult, briefs: [{ id: "tests-2", title: "Tests (revised)", spec: "x", files: ["src/x.ts"] }] }),
    });
    const w = await loadLoop({ agent: widening.agent, fixAttempts: 2, plan: swarmPlan }).runTask(swarmTask, "main");
    expect(widening.calls.map((c) => c.opts.label)).toEqual(["lead:a", "worker:a:1", "worker:a:2", "lead-rebrief:a"]);
    expect(w.stopReason).toContain("src/x.ts");

    // A lead-rebrief that blocks ends the task with the original worker's reason; no worker 3 launches.
    const leadBlocks = scripted({
      "lead:a": () => leadResult,
      "worker:a": (i) => (i === 0 ? worker1 : worker2Blocked),
      "lead-rebrief:a": () => ({ ...rebriefResult, blocked: true, blockedReason: "needs a file outside the task" }),
    });
    const lb = await loadLoop({ agent: leadBlocks.agent, fixAttempts: 2, plan: swarmPlan }).runTask(swarmTask, "main");
    expect(leadBlocks.calls.map((c) => c.opts.label)).toEqual(["lead:a", "worker:a:1", "worker:a:2", "lead-rebrief:a"]);
    expect(lb.stopReason).toContain("needs the Task type from src/y.ts");

    // The implementer agent and the worker prompt both say the blocked reason names what the worker needs, since
    // that reason is the lead's only material for the one re-brief.
    expect(readFileSync(join(root, "agents/implementer.md"), "utf8")).toContain("the file, the symbol or interface, or the decision");
    expect(fnSlice("function workerPrompt(")).toContain("the file, the symbol or interface, or the decision");
  });

  it("card swarm-topology: a deterministic per-worker check before the merge, behind plan.workerCheck, and worker check", async () => {
    const swarmPlan = { ...defaultPlan, swarm: true, workerCheck: true };
    const swarmHelpers = (planObj, logFn = () => {}) =>
      new Function(
        "plan", "taskShape", "log",
        source.slice(source.indexOf("function isTestFile("), source.indexOf("\n}\n", source.indexOf("function swarmReport(")) + 3) +
          "\nreturn { splittable, swarmApplies, swarmReport };",
      )(planObj, taskShape, logFn);
    const helpers = swarmHelpers(swarmPlan);

    const swarmTask = { ...task, files: ["src/x.ts", "src/y.ts", "tests/x.test.ts"] };
    const leadResult = {
      taskId: "a", branch: "doug/task-a", worktreePath: "/wt/lead",
      briefs: [
        { id: "core", title: "Core", spec: "Make x return 2 in src/x.ts.", files: ["src/x.ts"] },
        { id: "tests", title: "Tests", spec: "Test x in tests/x.test.ts.", files: ["tests/x.test.ts"] },
      ],
      blocked: false, splitReason: "two independent deliverables, each verified on its own",
    };
    const worker1 = { taskId: "a", branch: "doug/task-a-w1", worktreePath: "/wt/w1", filesTouched: ["src/x.ts"], commandsRun: [], summary: "done", blocked: false, commit: "w1c1" };
    // Worker 2 reports itself unblocked, but it also touched core's file - the deterministic check catches what the
    // worker itself did not report.
    const worker2Outside = { taskId: "a", branch: "doug/task-a-w2", worktreePath: "/wt/w2", filesTouched: ["tests/x.test.ts", "src/x.ts"], commandsRun: [], summary: "done", blocked: false, commit: "w2c1" };
    const rebriefResult = {
      taskId: "a", branch: "doug/task-a", worktreePath: "/wt/lead",
      briefs: [{ id: "tests-2", title: "Tests (revised)", spec: "Test x in tests/x.test.ts only.", files: ["tests/x.test.ts"] }],
      blocked: false, splitReason: "kept the worker to its own file this time",
    };
    const worker3 = { taskId: "a", branch: "doug/task-a-w3", worktreePath: "/wt/w3", filesTouched: ["tests/x.test.ts"], commandsRun: [], summary: "done", blocked: false, commit: "w3c1" };
    const merged = { ...implResult, worktreePath: "/wt/lead", commit: "m1", summary: "merged core, tests-2" };

    const { agent, calls } = scripted({
      "lead:a": () => leadResult,
      "worker:a": (i) => (i === 0 ? worker1 : i === 1 ? worker2Outside : worker3),
      "lead-rebrief:a": () => rebriefResult,
      "lead-merge:a": () => merged,
      "verify:a": () => ({ taskId: "a", passed: true, findings: [] }),
      "review:a": () => passingReview,
    });
    const r = await loadLoop({ agent, fixAttempts: 2, plan: swarmPlan }).runTask(swarmTask, "main");
    expect(calls.map((c) => c.opts.label)).toEqual(["lead:a", "worker:a:1", "worker:a:2", "lead-rebrief:a", "worker:a:3", "lead-merge:a", "verify:a", "review:a"]);
    expect(r.attempts[0].stages).toContain("worker-check");
    expect(r.stopReason).toBeNull();
    expect(r.impl.workers[1]).toMatchObject({ n: 2, id: "tests", blocked: true, blockedReason: "worker check: touched a file outside its brief: src/x.ts", checkFailed: true });
    expect(helpers.swarmReport(swarmTask, r.impl)).toMatchObject({ workerCheck: true, checkFailed: ["tests"] });

    // Off (the default): the same worker is never checked, so the task proceeds straight to the merge as today.
    const offPlan = { ...defaultPlan, swarm: true };
    const off = scripted({
      "lead:a": () => leadResult,
      "worker:a": (i) => (i === 0 ? worker1 : worker2Outside),
      "lead-merge:a": () => merged,
      "verify:a": () => ({ taskId: "a", passed: true, findings: [] }),
      "review:a": () => passingReview,
    });
    const ro = await loadLoop({ agent: off.agent, fixAttempts: 2, plan: offPlan }).runTask(swarmTask, "main");
    expect(off.calls.map((c) => c.opts.label)).toEqual(["lead:a", "worker:a:1", "worker:a:2", "lead-merge:a", "verify:a", "review:a"]);
    expect(ro.attempts[0].stages).not.toContain("worker-check");
    expect(ro.impl.workers[1].checkFailed).toBeFalsy();
    expect(swarmHelpers(offPlan).swarmReport(swarmTask, ro.impl)).toMatchObject({ workerCheck: false, checkFailed: [] });

    // A worker that stays inside its own files but never committed fails the check on the commit rule instead.
    const worker2NoCommit = { ...worker1, branch: "doug/task-a-w2", worktreePath: "/wt/w2", filesTouched: ["tests/x.test.ts"], commit: null };
    const noCommit = scripted({
      "lead:a": () => leadResult,
      "worker:a": (i) => (i === 0 ? worker1 : worker2NoCommit),
      "lead-rebrief:a": () => null,
    });
    const nc = await loadLoop({ agent: noCommit.agent, fixAttempts: 2, plan: swarmPlan }).runTask(swarmTask, "main");
    expect(nc.impl.workers[1]).toMatchObject({ n: 2, blocked: true, blockedReason: "worker check: no commit", checkFailed: true });

    // MINOR 1 (review): an empty-string entry in filesTouched must not read as falsy (Array.prototype.find returns
    // it, not undefined) and skip both reasons - it is still not one of the brief's files, so the check catches it.
    const worker2EmptyString = { ...worker1, branch: "doug/task-a-w2", worktreePath: "/wt/w2", filesTouched: ["", "src/x.ts"] };
    const emptyStr = scripted({
      "lead:a": () => leadResult,
      "worker:a": (i) => (i === 0 ? worker1 : worker2EmptyString),
      "lead-rebrief:a": () => null,
    });
    const es = await loadLoop({ agent: emptyStr.agent, fixAttempts: 2, plan: swarmPlan }).runTask(swarmTask, "main");
    expect(es.impl.workers[1]).toMatchObject({ n: 2, blocked: true, blockedReason: "worker check: touched a file outside its brief: ", checkFailed: true });

    // MINOR 2a/2b (review): the check also runs on round two, before the merge - a re-briefed worker that strays
    // still gets caught, no lead-merge:a launches, swarmStages carries worker-check once per round, and the blocked
    // task's own checkFailed still lists the failing worker's (revised) id.
    const worker2GenuineBlock = { taskId: "a", branch: "doug/task-a-w2", worktreePath: "/wt/w2", filesTouched: [], commandsRun: [], summary: "blocked", blocked: true, blockedReason: "needs the Task type from src/y.ts", commit: null };
    const worker3Outside = { ...worker3, filesTouched: ["tests/x.test.ts", "src/x.ts"] };
    const roundTwo = scripted({
      "lead:a": () => leadResult,
      "worker:a": (i) => (i === 0 ? worker1 : i === 1 ? worker2GenuineBlock : worker3Outside),
      "lead-rebrief:a": () => rebriefResult,
    });
    const rt = await loadLoop({ agent: roundTwo.agent, fixAttempts: 2, plan: swarmPlan }).runTask(swarmTask, "main");
    expect(roundTwo.calls.map((c) => c.opts.label)).toEqual(["lead:a", "worker:a:1", "worker:a:2", "lead-rebrief:a", "worker:a:3"]);
    expect(roundTwo.calls.map((c) => c.opts.label)).not.toContain("lead-merge:a");
    expect(rt.impl.blocked).toBe(true);
    expect(rt.impl.blockedReason).toContain("worker check: touched a file outside its brief: src/x.ts");
    expect(rt.impl.swarmStages.filter((s) => s === "worker-check")).toHaveLength(2);
    expect(rt.impl.checkFailed).toEqual(["tests-2"]);

    // The report gains the plan's setting, top level and per task (source assertion, the way neighbouring tests
    // assert on `workers:`).
    expect(source).toMatch(/swarm:\s*\{ on: plan\.swarm === true, workerCheck: plan\.workerCheck === true \}/);
  });

  it("resumes an implementer's usable partial exactly once, then runs checks (card worker-context-handoff)", async () => {
    const handoff1 = { completed: ["scaffolded src/x.ts"], remaining: ["make it return 2"], next: "finish the fix in src/x.ts", verify: task.verify };
    const { agent, calls } = scripted({
      "implement:a": () => ({ ...implResult, partial: true, handoff: handoff1, commit: "c1" }),
      "resume:a": () => ({ ...implResult, commit: "c2" }),
      "verify:a": () => ({ taskId: "a", passed: true, commandsRun: [], findings: [], acceptance: [] }),
      "review:a": () => passingReview,
    });
    const r = await loadLoop({ agent, fixAttempts: 2 }).runTask(task, "main");
    expect(calls.map((c) => c.opts.label)).toEqual(["implement:a", "resume:a", "verify:a", "review:a"]);
    expect(calls.filter((c) => c.opts.label === "resume:a")).toHaveLength(1);
    expect(calls[1].opts).toEqual({ role: "implement", label: "resume:a", phase: "Implement", agentType: "doug-flow:implementer", schema: { schema: "implement" } });
    expect(r.impl.resumed).toBe(1);
    expect(r.impl.partialHandoff).toEqual(handoff1);
    expect(r.impl.partial).toBeFalsy();
    expect(r.stopReason).toBeNull();
  });

  it("blocks a partial with no usable handoff instead of resuming it (rule 3)", async () => {
    const { agent, calls } = scripted({
      "implement:a": () => ({ ...implResult, partial: true }),
    });
    const r = await loadLoop({ agent, fixAttempts: 2 }).runTask(task, "main");
    expect(calls.map((c) => c.opts.label)).toEqual(["implement:a"]);
    expect(r.impl.blocked).toBe(true);
    expect(r.impl.blockedReason).toBe("partial without a handoff");
    expect(r.stopReason).toBe("blocked: partial without a handoff; not retried: implementer blocked: partial without a handoff");
  });

  it("blocks a partial whose handoff has empty remaining, next, or verify, the same way as a missing handoff (rule 3, minor 2)", async () => {
    const base = { completed: [], remaining: ["x"], next: "y", verify: "z" };
    const variants = [{ remaining: [] }, { next: "" }, { verify: "" }];
    for (const patch of variants) {
      const handoff = { ...base, ...patch };
      const { agent, calls } = scripted({ "implement:a": () => ({ ...implResult, partial: true, handoff }) });
      const r = await loadLoop({ agent, fixAttempts: 2 }).runTask(task, "main");
      expect(calls.map((c) => c.opts.label), JSON.stringify(patch)).toEqual(["implement:a"]);
      expect(r.impl.blocked, JSON.stringify(patch)).toBe(true);
      expect(r.impl.blockedReason, JSON.stringify(patch)).toBe("partial without a handoff");
    }
  });

  it("resumePrompt names the existing worktree/branch, forbids a new one, carries the handoff verbatim and the partial rule (minor 3)", () => {
    const resumePrompt = new Function("plan", CONSTS + fnSlice("function resumePrompt(") + "\nreturn resumePrompt;")(defaultPlan);
    const handoff = { completed: ["a.ts done"], remaining: ["finish b.ts"], next: "write the b test", verify: "pnpm exec vitest run b.test.ts" };
    const text = resumePrompt(task, { worktreePath: "/wt/a", branch: "doug/task-a" }, handoff, "main");
    expect(text).toContain("existing worktree /wt/a on branch doug/task-a");
    expect(text).toContain("create no worktree and no branch");
    expect(text).toContain("completed: a.ts done; remaining: finish b.ts; next: write the b test; verify: pnpm exec vitest run b.test.ts");
    expect(text).toContain("Do not redo completed items");
    expect(text).toContain("[doug] Worker context at <pct>% of <window> tokens");
    expect(text).toContain("git diff --name-only main...HEAD");

    // A resumed swarm worker's basis is the worker's own (the lead's branch), same as workerPrompt uses, not the
    // task's baseBranch.
    const brief = { id: "core", title: "Core", spec: "Make x return 2.", files: ["src/x.ts"], verify: null };
    const workerText = resumePrompt(task, { worktreePath: "/wt/w1", branch: "doug/task-a-w1" }, handoff, "doug/task-a", brief);
    expect(workerText).toContain("existing worktree /wt/w1 on branch doug/task-a-w1");
    expect(workerText).toContain("worker core of task a's swarm");
    expect(workerText).toContain("git diff --name-only doug/task-a...HEAD");
  });

  it("resumes a still-partial swarm worker once, then blocks the task without launching the lead merge (rule 4)", async () => {
    const swarmPlan = { ...defaultPlan, swarm: true };
    // card swarm-topology: needs two or more source files to clear the shape gate (the shared `task` fixture owns one).
    const swarmTask = { ...task, files: ["src/x.ts", "src/y.ts", "tests/x.test.ts"] };
    const leadResult = { taskId: "a", branch: "doug/task-a", worktreePath: "/wt/lead", briefs: [{ id: "core", title: "Core", spec: "Make x return 2.", files: ["src/x.ts"] }, { id: "tests", title: "Tests", spec: "Test x.", files: ["tests/x.test.ts"] }], blocked: false, splitReason: "two independent deliverables, each verified on its own" };
    const handoffA = { completed: ["half the fix"], remaining: ["still not returning 2"], next: "keep fixing src/x.ts", verify: "true" };
    const worker1Partial = { taskId: "a", branch: "doug/task-a-w1", worktreePath: "/wt/w1", filesTouched: ["src/x.ts"], commandsRun: [], summary: "partial", blocked: false, commit: "w1c1", partial: true, handoff: handoffA };
    const worker1StillPartial = { ...worker1Partial, commit: "w1c2", summary: "still stuck" };
    const worker2 = { taskId: "a", branch: "doug/task-a-w2", worktreePath: "/wt/w2", filesTouched: ["tests/x.test.ts"], commandsRun: [], summary: "done", blocked: false, commit: "w2c1" };
    const { agent, calls } = scripted({
      "lead:a": () => leadResult,
      "worker:a": (i) => (i === 0 ? worker1Partial : worker2),
      "resume:a": () => worker1StillPartial,
      "lead-merge:a": () => ({ ...implResult, worktreePath: "/wt/lead", commit: "m1" }),
    });
    const r = await loadLoop({ agent, fixAttempts: 2, plan: swarmPlan }).runTask(swarmTask, "main");
    const labels = calls.map((c) => c.opts.label);
    expect(labels).toEqual(["lead:a", "worker:a:1", "worker:a:2", "resume:a:1"]);
    expect(labels).not.toContain("lead-merge:a");
    // card swarm-topology (candidate 2): a still-partial worker blocks exactly as before, no re-brief attempt.
    expect(labels).not.toContain("lead-rebrief:a");
    // minor 3: a swarm worker's resume launches on the worker row, not the implement row (agentOpts's first arg).
    expect(calls[3].opts.role).toBe("worker");
    expect(r.impl.blocked).toBe(true);
    expect(r.impl.workers[0]).toMatchObject({ n: 1, id: "core", blocked: true, partial: true, handoff: handoffA, resumed: 1 });
    expect(r.impl.workers[1]).toMatchObject({ n: 2, id: "tests", blocked: false, partial: false, resumed: 0 });
    expect(r.stopReason).toContain("worker blocked: 1 (core): partial after resume: still not returning 2");
  });

  it("carries the partial rule in the implementer, worker, and fix prompts, and the never-merged sentence in the merge and integrate prompts (card worker-context-handoff)", () => {
    expect(source).toContain("const PARTIAL_RULE = 'Return partial=true only after a hook told you \"[doug] Worker context at");
    expect(source).toContain("const PARTIAL_NEVER_MERGED = ");
    for (const fn of ["implementPrompt", "workerPrompt", "fixPrompt"]) {
      const start = source.indexOf(`function ${fn}(`);
      const body = source.slice(start, source.indexOf("\n}\n", start));
      expect(body, fn).toContain("${PARTIAL_RULE}");
    }
    for (const fn of ["leadMergePrompt", "integratePrompt"]) {
      const start = source.indexOf(`function ${fn}(`);
      const body = source.slice(start, source.indexOf("\n}\n", start));
      expect(body, fn).toContain("PARTIAL_NEVER_MERGED");
    }
    expect(readFileSync(join(root, "agents/implementer.md"), "utf8")).toContain("[doug] Worker context at");
    expect(readFileSync(join(root, "agents/lead.md"), "utf8")).toContain("still partial after its resume is a block");
  });

  it("adds partial and handoff to the implement schema without requiring them (card worker-context-handoff)", () => {
    const start = source.indexOf("const IMPLEMENT_SCHEMA");
    const slice = source.slice(start, source.indexOf("\n}\n", start) + 3);
    const IMPLEMENT_SCHEMA = new Function(slice + "\nreturn IMPLEMENT_SCHEMA;")();
    expect(IMPLEMENT_SCHEMA.properties.partial.type).toBe("boolean");
    expect(IMPLEMENT_SCHEMA.properties.handoff.properties).toEqual({
      completed: { type: "array", items: { type: "string" } },
      remaining: { type: "array", items: { type: "string" } },
      next: { type: "string" },
      verify: { type: "string" },
    });
    expect(IMPLEMENT_SCHEMA.required).not.toContain("partial");
    expect(IMPLEMENT_SCHEMA.required).not.toContain("handoff");
  });

  it("fans a crew of reviewers and adversaries out in parallel with distinct briefs, merges their findings, and records every seat", async () => {
    // card crew-sizing: a task (or the plan) names a crew per role; the second reviewer runs alongside the first with a
    // brief that says what a first reviewer misses; the second adversary is the Claude adversary next to Codex.
    const crewTask = { ...task, crew: { reviewers: 2, adversaries: 2 } };
    const codex = { command: "codex-review", timeoutMs: 1000, fallback: { model: "opus", effort: "high" }, crewModel: { model: "opus", effort: "high" } };
    const dup = { severity: "major", file: "src/x.ts", description: "returns 1 for empty input" };
    const adversaryPass = (summary) => ({ taskId: "a", ran: true, verdict: "pass", summary, issues: [], commandsRun: [{ command: "true", ok: true }], error: null });
    const batchesOf = (calls) => {
      const batches = [];
      const parallel = async (thunks) => {
        const before = calls.length;
        const out = await plainParallel(thunks);
        batches.push(calls.slice(before).map((c) => c.opts.label));
        return out;
      };
      return { batches, parallel };
    };
    // Run 1: the second reviewer rejects on pass 1; both reviewers file the same major issue.
    const reviews = scripted({
      "implement:a": () => implResult,
      "verify:a": () => ({ taskId: "a", passed: true, findings: [] }),
      "review:a": (i) => (i === 0 ? { ...passingReview, issues: [dup] } : passingReview),
      "review-2:a": (i) => (i === 0 ? { taskId: "a", specCompliant: true, inScope: true, approve: false, issues: [{ severity: "blocker", file: "src/x.ts", description: "throws on null" }, { ...dup }] } : passingReview),
      "check:a": () => passingCheck,
      "adversary:a": () => adversaryPass("could not refute"),
      "adversary-2:a": () => adversaryPass("nothing found"),
      "fix:a": () => ({ ...implResult, commit: "c2" }),
    });
    const r1 = batchesOf(reviews.calls);
    const r = await loadLoop({ agent: reviews.agent, fixAttempts: 3, adversary: codex, parallel: r1.parallel }).runTask(crewTask, "main");
    // Pass 1: the verifier and both reviewers in one batch; one rejection makes the merged review reject.
    expect(r1.batches[0]).toEqual(["verify:a", "review:a", "review-2:a"]);
    expect(r.attempts[0].stages).toEqual(["implement", "verify", "review", "review-2"]);
    expect(r.attempts[0].reviewed).toBe(false);
    expect(r.attempts[0].blockingStage).toBe("review");
    // The issue both reviewers filed collapsed to one ledger id; the blocker got its own.
    expect(r.ledger.map((e) => [e.id, e.stage, e.description])).toEqual([["F1", "review", "returns 1 for empty input"], ["F2", "review", "throws on null"]]);
    // Pass 2: the review crew reruns together, then the check, then both adversaries in one batch; every seat is recorded.
    expect(r1.batches[1]).toEqual(["review:a:2", "review-2:a:2"]);
    expect(r1.batches[2]).toEqual(["adversary:a:2", "adversary-2:a:2"]);
    expect(r.attempts[1].stages).toEqual(["fix", "review", "review-2", "check", "adversary", "adversary-2"]);
    expect(r.attempts[1].adversary).toEqual({ ran: true, verdict: "pass", blocked: false, summary: "seat 1: could not refute | seat 2: nothing found" });
    expect(r.stopReason).toBeNull();
    expect(reviews.calls.length).toBe(4 + 6);
    expect(r.attempts[1].spent.agents).toBe(10);
    const seat2 = labelled(reviews.calls, "adversary-2:a")[0];
    expect(seat2.opts).toEqual({ label: "adversary-2:a:2", phase: "Adversary", agentType: "doug-flow:adversary-claude", schema: { schema: "adversary" }, model: "opus", effort: "high" });
    expect(seat2.prompt).toContain("crew seat 2 of 2");
    // Run 2: the reviewers approve and the second adversary refutes; a blocker from either seat blocks, and the crew confirms on the fix pass.
    const adversaries = scripted({
      "implement:a": () => implResult,
      "verify:a": () => ({ taskId: "a", passed: true, findings: [] }),
      "review:a": () => passingReview,
      "review-2:a": () => passingReview,
      "check:a": () => passingCheck,
      "adversary:a": () => adversaryPass("could not refute"),
      // card crew-seat-blocker-evidence: once further seats go through R12, an evidence-free blocker downgrades, so
      // this fixture needs a failing commandsRun entry its evidence names to keep blocking (a real, cited failure).
      "adversary-2:a": (i) => (i === 0 ? { taskId: "a", ran: true, verdict: "fail", summary: "off by one", issues: [{ severity: "blocker", file: "src/x.ts", description: "loses the last item", evidence: "node -e ..." }], commandsRun: [{ command: "node -e ...", ok: false, exitCode: 1 }], error: null } : adversaryPass("F1 fixed: keeps the last item")),
      "fix:a": () => ({ ...implResult, commit: "c2" }),
    });
    const r2 = batchesOf(adversaries.calls);
    const a = await loadLoop({ agent: adversaries.agent, fixAttempts: 3, adversary: codex, parallel: r2.parallel }).runTask(crewTask, "main");
    expect(r2.batches[1]).toEqual(["adversary:a", "adversary-2:a"]);
    expect(a.attempts[0].adversary).toEqual({ ran: true, verdict: "fail", blocked: true, summary: "seat 1: could not refute | seat 2: off by one" });
    expect(a.attempts[0].blockingStage).toBe("adversary");
    expect(a.ledger.map((e) => [e.id, e.stage, e.status])).toEqual([["F1", "adversary", "fixed"]]);
    expect(a.attempts[1].stages).toEqual(["fix", "adversary", "adversary-2", "check"]);
    expect(a.stopReason).toBeNull();
    // The second reviewer's brief names what the first is likely to miss; the report records the crew per task.
    const reviewPrompt = new Function("plan", "acceptanceEntries", "CONTRADICTION_MARKER", fnSlice("function reviewPrompt(") + "\nreturn reviewPrompt;")(defaultPlan, acceptanceEntriesFn(), "SPEC CONTRADICTS ACCEPTANCE");
    expect(reviewPrompt(task, implResult, "main", 2)).toContain("what a first reviewer is likely to miss");
    expect(reviewPrompt(task, implResult, "main")).not.toContain("reviewer 2");
    expect(source).toMatch(/crew:\s*crewOf\(r\.task\)/);
    // The default crew changes nothing: one reviewer, one adversary, the same labels as before.
    const plain = scripted({ "implement:a": () => implResult, "verify:a": () => ({ taskId: "a", passed: true, findings: [] }), "review:a": () => passingReview, "adversary:a": () => adversaryPass("") });
    const p = await loadLoop({ agent: plain.agent, fixAttempts: 3, adversary: codex }).runTask(task, "main");
    expect(plain.calls.map((c) => c.opts.label)).toEqual(["implement:a", "verify:a", "review:a", "adversary:a"]);
    expect(p.attempts[0].stages).toEqual(["implement", "verify", "review", "adversary"]);
  });

  it("merges a crew adversary per seat: a seat that would block alone still blocks after merging with a seat's non-blocking issue (card fix-loop-minor-verdict)", async () => {
    const crewTask = { ...task, crew: { adversaries: 2 } };
    const codex = { command: "codex-review", timeoutMs: 1000, fallback: { model: "opus", effort: "high" }, crewModel: { model: "opus", effort: "high" } };
    // Seat 1 fails with no issue at all (blocks alone, the empty-issues rule); seat 2 passes but files one minor
    // issue. Flattening the issues together must not hide seat 1's block behind seat 2's non-blocking one.
    const { agent, calls } = scripted({
      "implement:a": () => implResult,
      "verify:a": () => ({ taskId: "a", passed: true, findings: [] }),
      "review:a": () => passingReview,
      "adversary:a": () => ({ taskId: "a", ran: true, verdict: "fail", summary: "could not refute the change but failed it anyway", issues: [], commandsRun: [], error: null }),
      "adversary-2:a": () => ({ taskId: "a", ran: true, verdict: "pass", summary: "nothing found but one nit", issues: [{ severity: "minor", file: "src/x.ts", description: "prefer const" }], commandsRun: [], error: null }),
    });
    const r = await loadLoop({ agent, fixAttempts: 0, adversary: codex }).runTask(crewTask, "main");
    expect(labelled(calls, "fix:").length).toBe(0);
    expect(r.attempts[0].adversary.blocked).toBe(true);
    expect(r.attempts[0].blockingStage).toBe("adversary");
    expect(r.attempts[0].ready).toBe(false);
  });

  it("does not block a crew adversary when every seat's fail carries only non-blocker issues", async () => {
    const crewTask = { ...task, crew: { adversaries: 2 } };
    const codex = { command: "codex-review", timeoutMs: 1000, fallback: { model: "opus", effort: "high" }, crewModel: { model: "opus", effort: "high" } };
    const { agent, calls } = scripted({
      "implement:a": () => implResult,
      "verify:a": () => ({ taskId: "a", passed: true, findings: [] }),
      "review:a": () => passingReview,
      "adversary:a": () => ({ taskId: "a", ran: true, verdict: "fail", summary: "a nit", issues: [{ severity: "minor", file: "src/x.ts", description: "prefer const" }], commandsRun: [], error: null }),
      "adversary-2:a": () => ({ taskId: "a", ran: true, verdict: "fail", summary: "another nit", issues: [{ severity: "major", file: "src/x.ts", description: "could be clearer" }], commandsRun: [], error: null }),
    });
    const r = await loadLoop({ agent, fixAttempts: 0, adversary: codex }).runTask(crewTask, "main");
    expect(labelled(calls, "fix:").length).toBe(0);
    expect(r.attempts[0].adversary.blocked).toBe(false);
    expect(r.attempts[0].ready).toBe(true);
    expect(r.stopReason).toBeNull();
  });

  it("reports a null from the verifier or the reviewer as that stage returning nothing", async () => {
    const noVerifier = scripted({ "implement:a": () => implResult, "review:a": () => passingReview });
    const v = await loadLoop({ agent: noVerifier.agent, fixAttempts: 2 }).runTask(task, "main");
    expect(labelled(noVerifier.calls, "fix:").length).toBe(0);
    expect(v.attempts[0].retriable).toEqual({ ok: false, reason: "verifier returned nothing" });
    expect(v.stopReason).toBe("verification failed; not retried: verifier returned nothing");
    const noReviewer = scripted({ "implement:a": () => implResult, "verify:a": () => ({ taskId: "a", passed: true, findings: [] }) });
    const w = await loadLoop({ agent: noReviewer.agent, fixAttempts: 2 }).runTask(task, "main");
    expect(labelled(noReviewer.calls, "fix:").length).toBe(0);
    expect(w.attempts[0].retriable).toEqual({ ok: false, reason: "reviewer returned nothing" });
    expect(w.stopReason).toBe("review rejected; not retried: reviewer returned nothing");
    // A thunk that throws is a null too, not a rejected pass.
    const throwing = scripted({ "implement:a": () => implResult, "verify:a": () => { throw new Error("dead"); }, "review:a": () => passingReview });
    const t = await loadLoop({ agent: throwing.agent, fixAttempts: 2 }).runTask(task, "main");
    expect(t.stopReason).toBe("verification failed; not retried: verifier returned nothing");
  });

  it("runs a size-S task as implement plus one focused check, with no verifier, reviewer, or adversary of its own", async () => {
    const codex = { command: "codex-review", timeoutMs: 1000, fallback: false };
    const small = { ...task, size: "S" };
    const { agent, calls } = scripted({
      "implement:a": () => implResult,
      "check:a": (i) => (i === 0 ? { ...passingCheck, passed: false, findings: ["src/x.ts returns 1"] } : passingCheck),
      "fix:a": () => ({ ...implResult, commit: "c2" }),
    });
    const r = await loadLoop({ agent, fixAttempts: 2, adversary: codex }).runTask(small, "main");
    expect(calls.map((c) => c.opts.label)).toEqual(["implement:a", "check:a", "fix:a:2", "check:a:2"]);
    expect(calls[1].prompt).toBe("size-check");
    expect(calls[1].opts).toMatchObject({ role: "verify", agentType: "doug-flow:verifier", schema: { schema: "check" } });
    expect(r.attempts.map((a) => a.stages)).toEqual([["implement", "check"], ["fix", "check"]]);
    expect(r.attempts[0].blockingStage).toBe("check");
    expect(r.attempts[1].ready).toBe(true);
    expect(r.adv).toBeNull();
    expect(r.stopReason).toBeNull();
    expect(r.ledger.map((e) => [e.id, e.status])).toEqual([["F1", "fixed"]]);
    // The same plan's full-shape task, with the adversary configured, still runs verify, review, and the adversary.
    const full = scripted({
      "implement:a": () => implResult,
      "verify:a": () => ({ taskId: "a", passed: true, findings: [] }),
      "review:a": () => passingReview,
      "adversary:a": () => ({ taskId: "a", ran: true, verdict: "pass", summary: "", issues: [], commandsRun: [], error: null }),
    });
    const f = await loadLoop({ agent: full.agent, fixAttempts: 2, adversary: codex }).runTask(task, "main");
    expect(full.calls.map((c) => c.opts.label)).toEqual(["implement:a", "verify:a", "review:a", "adversary:a"]);
    expect(f.stopReason).toBeNull();
    expect(taskShape(small)).toBe("S");
    for (const t of [task, { ...task, size: "M" }, { ...task, size: "L" }]) expect(taskShape(t)).toBe("full");
  });

  it("relaunches the implementer once in the same worktree when the verifier blocks on an owned file, then the task is ready", async () => {
    const finding = "pnpm exec vitest run tests/x.test.ts failed: src/x.ts returns 1, expected 2";
    const { agent, calls } = scripted({
      "implement:a": () => implResult,
      "verify:a": (i) => (i === 0 ? { taskId: "a", passed: false, findings: [finding] } : { taskId: "a", passed: true, findings: [] }),
      "review:a": () => passingReview,
      "check:a": () => passingCheck,
      "fix:a": () => ({ ...implResult, summary: "fixed", commit: "c2" }),
    });
    const { runTask } = loadLoop({ agent, fixAttempts: 2 });
    const r = await runTask(task, "main");
    const fixes = labelled(calls, "fix:");
    expect(fixes.length).toBe(1);
    expect(fixes[0].opts.label).toBe("fix:a:2");
    expect(fixes[0].opts.agentType).toBe("doug-flow:implementer");
    expect(fixes[0].opts.role).toBe("implement");
    expect(fixes[0].opts.phase).toBe("Implement");
    expect(fixes[0].opts.isolation).toBeUndefined();
    expect(fixes[0].opts.schema).toEqual({ schema: "implement" });
    expect(fixes[0].prompt).toContain("Open findings (fix every one");
    expect(fixes[0].prompt).toContain("F1 [verify/verification]");
    expect(fixes[0].prompt).toContain(finding);
    expect(fixes[0].prompt).toContain("/wt/a");
    expect(fixes[0].prompt).toContain("doug/task-a");
    expect(fixes[0].prompt).toContain("Make x return 2.");
    expect(fixes[0].prompt).toContain("Do not delete, skip, or weaken");
    expect(fixes[0].prompt).toContain("fix attempt 1 of 2");
    expect(labelled(calls, "verify:").map((c) => c.opts.label)).toEqual(["verify:a", "verify:a:2"]);
    // The reviewer runs once: on a fix pass the focused check stands in for it.
    expect(labelled(calls, "review:").length).toBe(1);
    expect(labelled(calls, "check:").map((c) => c.opts.label)).toEqual(["check:a:2"]);
    // Attempt objects grow a `notes` key (card ledger-ignores-not-a-defect-notes): a return-shape change, not a
    // bent expectation - neither pass here drops a finding, so notes is [] on both.
    expect(r.attempts).toEqual([
      { pass: 1, stages: ["implement", "verify", "review"], commit: "c1", blockingStage: "verify", verified: false, reviewed: true, adversary: null, newFindings: ["F1"], fixedFindings: [], notes: [], ready: false, retriable: { ok: true, reason: "every finding is within the owned files" }, spent: { agents: 3, tokens: null, elapsedMs: null }, commands: [] },
      { pass: 2, stages: ["fix", "verify", "check"], commit: "c2", blockingStage: null, verified: true, reviewed: true, adversary: null, newFindings: [], fixedFindings: ["F1"], notes: [], ready: true, retriable: null, spent: { agents: 6, tokens: null, elapsedMs: null }, commands: [] },
    ]);
    expect(r.stopReason).toBeNull();
    expect(r.impl.summary).toBe("fixed");
    expect(r.impl.worktreePath).toBe("/wt/a");
    expect(r.ledger.map((e) => [e.id, e.status, e.confirmedBy, e.fixedCommit])).toEqual([["F1", "fixed", "verify", "c2"]]);
    expect(r.budget).toEqual({ limits: { agents: 12, tokens: 400000, wallMinutes: 40 }, spent: { agents: 6, tokens: null, elapsedMs: null }, enforced: ["agents"] });
  });

  // ---- The fix-loop supervisor (card fix-loop-supervisor, NVIDIA AVO §3.3) ----
  const A = "src/x.ts returns 1, expected 2";
  const supervisorResult = { taskId: "a", brief: "Tried: rewrite the return path twice; both passes left F1 open.", directions: ["Rewrite x from the spec instead of patching the return", "Write the failing test for the empty input first"] };
  it("stallSignals: a finding still open after a fix pass targeted it, a reappeared one, and a fix pass that re-attacked a cleared file", () => {
    const { stallSignals } = loadLoop({ agent: async () => null, fixAttempts: 5 });
    const open = { id: "F2", file: "tests/x.test.ts", status: "open", openedPass: 2, reappeared: false };
    const cleared = { id: "F1", file: "src/x.ts", status: "fixed", openedPass: 1, fixedPass: 2, reappeared: false };
    // Opened on pass 2 and still open after pass 3: blocked twice.
    expect(stallSignals([open], { pass: 3, impl: { filesTouched: ["tests/x.test.ts"] } })).toEqual([{ kind: "repeat", finding: "F2", passes: [2, 3] }]);
    // Opened on the pass that just ended: blocked once, no signal.
    expect(stallSignals([{ ...open, openedPass: 3 }], { pass: 3, impl: { filesTouched: ["tests/x.test.ts"] } })).toEqual([]);
    // A reappeared finding counts even when it was just reopened.
    expect(stallSignals([{ ...open, openedPass: 3, reappeared: true }], { pass: 3, impl: { filesTouched: [] } })).toEqual([{ kind: "repeat", finding: "F2", passes: [3], reappeared: true }]);
    // Pass 3 touched src/x.ts, cleared on pass 2 with nothing open on it: a re-attack.
    expect(stallSignals([cleared, { ...open, openedPass: 3 }], { pass: 3, impl: { filesTouched: ["src/x.ts"] } })).toEqual([{ kind: "re-attack", file: "src/x.ts", clearedPass: 2, pass: 3 }]);
    // Cleared on the same pass, or with a finding open on the file going into the pass: no re-attack.
    expect(stallSignals([{ ...cleared, fixedPass: 3 }], { pass: 3, impl: { filesTouched: ["src/x.ts"] } })).toEqual([]);
    expect(stallSignals([cleared, { ...open, file: "src/x.ts", openedPass: 2, id: "F3" }], { pass: 3, impl: { filesTouched: ["src/x.ts"] } })).toEqual([{ kind: "repeat", finding: "F3", passes: [2, 3] }]);
    expect(stallSignals([], { pass: 1, impl: { filesTouched: ["src/x.ts"] } })).toEqual([]);
  });
  it("runs the supervisor on the cheap tier before a fix pass after the first when the same finding blocked twice, and injects its brief", async () => {
    const { agent, calls } = scripted({
      "implement:a": () => implResult,
      "verify:a": (i) => (i < 2 ? { taskId: "a", passed: false, findings: [A] } : { taskId: "a", passed: true, findings: [] }),
      "review:a": () => passingReview,
      "check:a": () => passingCheck,
      "fix:a": (i) => ({ ...implResult, commit: `c${i + 2}` }),
      "supervise:a": () => supervisorResult,
    });
    const r = await loadLoop({ agent, fixAttempts: 5 }).runTask(task, "main");
    expect(r.stopReason).toBeNull();
    expect(r.attempts.length).toBe(3);
    // The first fix pass never sees a supervisor; the second does, once, on the supervise role.
    const sup = labelled(calls, "supervise:");
    expect(sup.map((c) => c.opts.label)).toEqual(["supervise:a:3"]);
    expect(sup[0].opts.role).toBe("supervise");
    expect(sup[0].opts.schema).toEqual({ schema: "supervise" });
    expect(sup[0].opts.isolation).toBeUndefined();
    expect(sup[0].prompt).toBe("supervise repeat");
    const fixes = labelled(calls, "fix:");
    expect(fixes.map((c) => c.opts.label)).toEqual(["fix:a:2", "fix:a:3"]);
    expect(fixes[0].prompt).not.toContain("Supervisor brief");
    expect(fixes[1].prompt).toContain("Supervisor brief");
    expect(fixes[1].prompt).toContain(supervisorResult.brief);
    expect(fixes[1].prompt).toContain("1. Rewrite x from the spec instead of patching the return");
    expect(fixes[1].prompt).toContain("2. Write the failing test for the empty input first");
    // The report: the pass the supervisor followed carries it, and the task carries the last one.
    expect(r.attempts[0].supervisor).toBeUndefined();
    expect(r.attempts[1].supervisor).toMatchObject({ ran: true, stalled: true, signals: [{ kind: "repeat", finding: "F1", passes: [1, 2] }] });
    expect(r.attempts[1].supervisor.brief).toContain(supervisorResult.brief);
    expect(r.attempts[2].supervisor).toBeUndefined();
    expect(r.supervisor).toMatchObject({ ran: true, stalled: true, stop: null });
    // The supervisor changes no verdict: F1 stayed open until the verifier confirmed it on pass 3.
    expect(r.ledger.map((e) => [e.id, e.status, e.fixedPass])).toEqual([["F1", "fixed", 3]]);
    // The supervisor spent one agent, counted against the task budget: 3 + 2 (fix, verify) + 1 + 3.
    expect(r.attempts[2].spent.agents).toBe(9);
  });
  it("runs the supervisor when a fix pass re-attacked a file an earlier pass had cleared", async () => {
    const B = "tests/x.test.ts never exercises the empty input";
    const { agent, calls } = scripted({
      "implement:a": () => implResult,
      "verify:a": (i) => (i === 0 ? { taskId: "a", passed: false, findings: [A] } : { taskId: "a", passed: true, findings: [] }),
      "review:a": () => passingReview,
      // Pass 2 clears F1 but the check fails without a finding; pass 3 re-touches src/x.ts and the check raises F2
      // on the test file; pass 4 passes.
      "check:a": (i) => (i === 0 ? { ...passingCheck, passed: false, findings: [] } : i === 1 ? { ...passingCheck, passed: false, findings: [B] } : passingCheck),
      "fix:a": (i) => ({ ...implResult, filesTouched: ["src/x.ts"], commit: `c${i + 2}` }),
      "supervise:a": () => supervisorResult,
    });
    const r = await loadLoop({ agent, fixAttempts: 5 }).runTask(task, "main");
    expect(r.stopReason).toBeNull();
    const sup = labelled(calls, "supervise:");
    expect(sup.map((c) => c.opts.label)).toEqual(["supervise:a:4"]);
    expect(sup[0].prompt).toBe("supervise re-attack");
    expect(r.attempts[1].supervisor).toBeUndefined();
    expect(r.attempts[2].supervisor.signals).toEqual([{ kind: "re-attack", file: "src/x.ts", clearedPass: 2, pass: 3 }]);
    expect(labelled(calls, "fix:")[2].prompt).toContain("Supervisor brief");
  });
  it("stops a task stalled twice with a stalled stop instead of spending the remaining fix budget", async () => {
    const { agent, calls } = scripted({
      "implement:a": () => implResult,
      "verify:a": () => ({ taskId: "a", passed: false, findings: [A] }),
      "review:a": () => passingReview,
      "check:a": () => passingCheck,
      "fix:a": (i) => ({ ...implResult, commit: `c${i + 2}` }),
      "supervise:a": () => supervisorResult,
    });
    const r = await loadLoop({ agent, fixAttempts: 5 }).runTask(task, "main");
    // Supervised once before pass 3; stalled again after it: stop before another supervisor or fix.
    expect(labelled(calls, "supervise:").map((c) => c.opts.label)).toEqual(["supervise:a:3"]);
    expect(labelled(calls, "fix:").map((c) => c.opts.label)).toEqual(["fix:a:2", "fix:a:3"]);
    expect(r.attempts.length).toBe(3);
    expect(r.stopReason).toBe("verification failed; stopped: stalled twice (F1 still open after 3 passes)");
    expect(r.supervisor).toEqual({ ran: false, stalled: true, brief: null, signals: [{ kind: "repeat", finding: "F1", passes: [1, 2, 3] }], stop: { kind: "stalled", attempts: 3, findings: ["F1"] } });
    expect(r.attempts[2].supervisor).toBe(r.supervisor);
    // The stop is the loop's, so no verdict was softened: F1 is still open in the ledger.
    expect(r.ledger[0].status).toBe("open");
  });
  it("falls back to a brief built from the evidence when the supervisor returns nothing, and never runs on a first fix pass", async () => {
    const { agent, calls } = scripted({
      "implement:a": () => implResult,
      "verify:a": (i) => (i < 2 ? { taskId: "a", passed: false, findings: [A] } : { taskId: "a", passed: true, findings: [] }),
      "review:a": () => passingReview,
      "check:a": () => passingCheck,
      "fix:a": (i) => ({ ...implResult, commit: `c${i + 2}` }),
      "supervise:a": () => null,
    });
    const r = await loadLoop({ agent, fixAttempts: 5 }).runTask(task, "main");
    expect(r.stopReason).toBeNull();
    expect(r.attempts[1].supervisor).toMatchObject({ ran: false, stalled: true });
    expect(r.attempts[1].supervisor.brief).toContain("F1");
    expect(r.attempts[1].supervisor.brief).toContain("open after passes 1, 2");
    expect(labelled(calls, "fix:")[1].prompt).toContain("Supervisor brief");
    // One fix pass only: the supervisor is never consulted, and the task carries supervisor: null.
    const once = scripted({
      "implement:a": () => implResult,
      "verify:a": (i) => (i === 0 ? { taskId: "a", passed: false, findings: [A] } : { taskId: "a", passed: true, findings: [] }),
      "review:a": () => passingReview,
      "check:a": () => passingCheck,
      "fix:a": () => ({ ...implResult, commit: "c2" }),
      "supervise:a": () => supervisorResult,
    });
    const ok = await loadLoop({ agent: once.agent, fixAttempts: 5 }).runTask(task, "main");
    expect(labelled(once.calls, "supervise:").length).toBe(0);
    expect(ok.supervisor).toBeNull();
  });
  it("the supervisor prompt carries every pass with its findings, commands, and verdicts, forbids edits and verdicts, and the report records it", () => {
    const ledger = ledgerModule();
    const supervisePrompt = new Function("plan", "fixAttempts", "ledgerText", CONSTS + fnSlice("function supervisePrompt(") + "\nreturn supervisePrompt;")(defaultPlan, 5, ledger.ledgerText);
    const entries = [{ id: "F1", stage: "verify", invariant: "verification", severity: "blocker", file: "src/x.ts", line: null, description: A, evidence: "exit 1", status: "open", openedPass: 1, fixedPass: null, fixedCommit: null, confirmedBy: null, reappeared: false }];
    const attempts = [
      { pass: 1, stages: ["implement", "verify", "review"], commit: "c1", blockingStage: "verify", verified: false, reviewed: true, adversary: null, newFindings: ["F1"], fixedFindings: [], commands: [{ command: "pnpm exec vitest run tests/x.test.ts", exitCode: 1 }] },
      { pass: 2, stages: ["fix", "verify", "check"], commit: "c2", blockingStage: "verify", verified: false, reviewed: true, adversary: { ran: true, verdict: "pass", blocked: false }, newFindings: [], fixedFindings: [], commands: [{ command: "pnpm exec vitest run tests/x.test.ts", exitCode: 1 }] },
    ];
    const text = supervisePrompt(task, { pass: 2, impl: { branch: "doug/task-a", worktreePath: "/wt/a" } }, attempts, entries, [{ kind: "repeat", finding: "F1", passes: [1, 2] }]);
    for (const s of ["Pass 1", "Pass 2", "F1 [verify/verification]", "pnpm exec vitest run tests/x.test.ts (exit 1)", "verify no", "adversary pass", "F1 blocked twice", "two or three alternative directions", "Make x return 2."]) expect(text).toContain(s);
    expect(text).toMatch(/never edit|edit nothing|do not edit/i);
    expect(text).toMatch(/not a verdict|never a verdict|do not (soften|change) (a|the) verdict/i);
    const schema = new Function(fnSlice("const SUPERVISE_SCHEMA") + "\nreturn SUPERVISE_SCHEMA;")();
    expect(schema.required).toEqual(["taskId", "brief", "directions"]);
    expect(schema.properties.verdict).toBeUndefined();
    expect(schema.properties.directions.minItems).toBe(2);
    expect(schema.properties.directions.maxItems).toBe(3);
    expect(source).toMatch(/supervisor:\s*r\.supervisor/);
    expect(source).toMatch(/supervise:\s*describeTier\('supervise'\)/);
  });

  it("stops without a relaunch when a finding names a file outside the owned set and says why", async () => {
    const { agent, calls } = scripted({
      "implement:a": () => implResult,
      // The verifier lists the file it means; in prose alone an unknown path would be ignored (see below).
      "verify:a": () => ({ taskId: "a", passed: false, findings: ["src/other.ts is missing the export the test imports"], findingFiles: [{ finding: "src/other.ts is missing the export the test imports", files: ["src/other.ts"] }] }),
      "review:a": () => passingReview,
    });
    const { runTask } = loadLoop({ agent, fixAttempts: 3 });
    const r = await runTask(task, "main");
    expect(labelled(calls, "fix:").length).toBe(0);
    expect(labelled(calls, "verify:").length).toBe(1);
    expect(r.attempts.length).toBe(1);
    expect(r.attempts[0].retriable).toEqual({ ok: false, reason: "findings name files outside the owned set: src/other.ts" });
    expect(r.stopReason).toBe("verification failed; not retried: findings name files outside the owned set: src/other.ts");
  });

  it("never relaunches when fixAttempts is 0", async () => {
    const { agent, calls } = scripted({
      "implement:a": () => implResult,
      "verify:a": () => ({ taskId: "a", passed: false, findings: ["src/x.ts returns 1, expected 2"] }),
      "review:a": () => passingReview,
    });
    const { runTask } = loadLoop({ agent, fixAttempts: 0 });
    const r = await runTask(task, "main");
    expect(labelled(calls, "fix:").length).toBe(0);
    expect(r.stopReason).toBe("verification failed; fix attempts exhausted (0 of 0)");
  });

  it("stops with the reason when attempts are exhausted", async () => {
    const { agent, calls } = scripted({
      "implement:a": () => implResult,
      "verify:a": () => ({ taskId: "a", passed: false, findings: ["src/x.ts returns 1, expected 2"] }),
      "review:a": () => passingReview,
      "fix:a": (i) => ({ ...implResult, summary: "tried", commit: `c${i + 2}` }),
    });
    const { runTask } = loadLoop({ agent, fixAttempts: 2 });
    const r = await runTask(task, "main");
    const fixes = labelled(calls, "fix:");
    expect(fixes.map((c) => c.opts.label)).toEqual(["fix:a:2", "fix:a:3"]);
    expect(labelled(calls, "verify:").length).toBe(3);
    expect(r.attempts.length).toBe(3);
    for (let i = 0; i < r.attempts.length; i++) expect(r.attempts[i].pass).toBe(i + 1);
    // The same finding every pass is not a new one, so the two-consecutive rule never fires.
    expect(r.attempts.map((a) => a.newFindings)).toEqual([["F1"], [], []]);
    expect(r.stopReason).toBe("verification failed; fix attempts exhausted (2 of 2)");
    expect(fixes[1].prompt).toContain("fix attempt 2 of 2");
  });

  it("does not retry a contradiction marker, an implementer block, a blocker on a file outside the owned set, or an adversary that did not run", async () => {
    const contradiction = scripted({
      "implement:a": () => implResult,
      "verify:a": () => ({ taskId: "a", passed: false, findings: ["SPEC CONTRADICTS ACCEPTANCE: the spec wants 1 and acceptance wants 2"] }),
      "review:a": () => passingReview,
    });
    const one = await loadLoop({ agent: contradiction.agent, fixAttempts: 3 }).runTask(task, "main");
    expect(labelled(contradiction.calls, "fix:").length).toBe(0);
    expect(one.stopReason).toContain("not retried: spec contradicts acceptance:");

    const blocked = scripted({ "implement:a": () => ({ ...implResult, blocked: true, blockedReason: "needs lib/y.ts" }) });
    const two = await loadLoop({ agent: blocked.agent, fixAttempts: 3 }).runTask(task, "main");
    expect(labelled(blocked.calls, "verify:").length).toBe(0);
    expect(labelled(blocked.calls, "fix:").length).toBe(0);
    expect(two.stopReason).toBe("blocked: needs lib/y.ts; not retried: implementer blocked: needs lib/y.ts");

    const rejected = scripted({
      "implement:a": () => implResult,
      "verify:a": () => ({ taskId: "a", passed: true, findings: [] }),
      "review:a": () => ({ taskId: "a", specCompliant: false, inScope: true, approve: false, issues: [{ severity: "blocker", file: "lib/y.ts", description: "wrong" }] }),
    });
    const three = await loadLoop({ agent: rejected.agent, fixAttempts: 3 }).runTask(task, "main");
    expect(labelled(rejected.calls, "fix:").length).toBe(0);
    expect(three.stopReason).toBe("review rejected; not retried: findings name files outside the owned set: lib/y.ts");

    const absent = scripted({
      "implement:a": () => implResult,
      "verify:a": () => ({ taskId: "a", passed: true, findings: [] }),
      "review:a": () => passingReview,
      "adversary:a": () => ({ taskId: "a", ran: false, verdict: "inconclusive", summary: "", issues: [], commandsRun: [], error: "codex-review not found" }),
    });
    const four = await loadLoop({ agent: absent.agent, fixAttempts: 3, adversary: { command: "x", timeoutMs: 1 } }).runTask(task, "main");
    expect(labelled(absent.calls, "fix:").length).toBe(0);
    expect(four.stopReason).toContain("not retried: adversary did not run: codex-review not found");
    // An adversarial review that never ran keeps the task out, but it is not the stage that blocked: only a review
    // that ran and returned a blocking verdict is recorded as `adversary`.
    expect(four.attempts[0].blockingStage).toBeNull();
    expect(four.attempts[0].adversary).toEqual({ ran: false, verdict: "inconclusive", blocked: true, summary: "" });

    // Same on a fix pass: the stages that ran all passed, so nothing blocked even though the absent review stops the task.
    const absentLater = scripted({
      "implement:a": () => implResult,
      "verify:a": (i) => (i === 0 ? { taskId: "a", passed: false, findings: ["src/x.ts: off by one"] } : { taskId: "a", passed: true, findings: [] }),
      "review:a": () => passingReview,
      "check:a": () => passingCheck,
      "fix:a": () => ({ ...implResult, commit: "c2" }),
      "adversary:a": () => ({ taskId: "a", ran: false, verdict: "inconclusive", summary: "", issues: [], commandsRun: [], error: "codex-review not found" }),
    });
    const five = await loadLoop({ agent: absentLater.agent, fixAttempts: 3, adversary: { command: "x", timeoutMs: 1 } }).runTask(task, "main");
    expect(labelled(absentLater.calls, "fix:").length).toBe(1);
    expect(five.attempts[1].blockingStage).toBeNull();
    expect(five.stopReason).toContain("not retried: adversary did not run: codex-review not found");
  });

  it("E4: does not retry an environment-only finding from a focused check or the verifier (card reused-s-task-worktree-install)", async () => {
    const sTask = { ...task, size: "S" };
    const envCheck = scripted({
      "implement:a": () => implResult,
      "check:a": () => ({ ...passingCheck, passed: false, findings: ['ENVIRONMENT ONLY: pnpm exec vitest exited 254 (Command "vitest" not found)'] }),
    });
    const s = await loadLoop({ agent: envCheck.agent, fixAttempts: 3 }).runTask(sTask, "main");
    expect(labelled(envCheck.calls, "fix:").length).toBe(0);
    expect(s.stopReason).toContain("not retried: environment, not the code:");
    expect(s.stopReason).toContain('ENVIRONMENT ONLY: pnpm exec vitest exited 254 (Command "vitest" not found)');

    // Same when an M task's verifier reports the environment problem instead of a check.
    const envVerify = scripted({
      "implement:a": () => implResult,
      "verify:a": () => ({ taskId: "a", passed: false, findings: ['ENVIRONMENT ONLY: pnpm exec vitest exited 254 (Command "vitest" not found)'] }),
      "review:a": () => passingReview,
    });
    const v = await loadLoop({ agent: envVerify.agent, fixAttempts: 3 }).runTask(task, "main");
    expect(labelled(envVerify.calls, "fix:").length).toBe(0);
    expect(v.stopReason).toContain("not retried: environment, not the code:");
  });

  it("falls back to a Claude adversary when codex-review could not run and the plan allows it", async () => {
    const codexDown = { taskId: "a", ran: false, verdict: "inconclusive", summary: "", issues: [], commandsRun: [], error: "codex-failed: codex exec exited 1: usage limit" };
    const fallback = { model: "opus", effort: "high" };
    const passing = {
      "implement:a": () => implResult,
      "verify:a": () => ({ taskId: "a", passed: true, findings: [] }),
      "review:a": () => passingReview,
      "check:a": () => passingCheck,
      "adversary:a": () => codexDown,
    };
    const stood = scripted({ ...passing, "adversary-fallback:a": () => ({ taskId: "a", ran: true, verdict: "pass", summary: "could not refute", issues: [], commandsRun: [{ command: "true", ok: true, exitCode: 0 }], error: null }) });
    const r = await loadLoop({ agent: stood.agent, fixAttempts: 3, adversary: { command: "x", timeoutMs: 1, fallback } }).runTask(task, "main");
    const fb = labelled(stood.calls, "adversary-fallback:");
    expect(fb.length).toBe(1);
    expect(fb[0].opts).toEqual({ label: "adversary-fallback:a", phase: "Adversary", agentType: "doug-flow:adversary-claude", schema: { schema: "adversary" }, model: "opus", effort: "high" });
    expect(fb[0].prompt).toBe("adversary-fallback: codex-failed: codex exec exited 1: usage limit");
    expect(r.stopReason).toBeNull();
    const used = { model: "opus", effort: "high", reason: "codex-failed: codex exec exited 1: usage limit" };
    expect(r.adv.fallback).toEqual(used);
    expect(r.attempts[0].adversary).toEqual({ ran: true, verdict: "pass", blocked: false, summary: "could not refute", fallback: used });
    expect(r.attempts[0].stages).toEqual(["implement", "verify", "review", "adversary", "adversary-fallback"]);

    // The fallback's verdict counts like Codex's: a blocker from it keeps the task out and is retried on an owned file.
    // Card fallback-adversary-blocker-evidence: an evidence-free blocker from the fallback is now downgraded to
    // major and stops blocking, so this fixture gives it real evidence (a failing command named in commandsRun)
    // to keep testing "a real blocker from the fallback blocks and retries", not the separate no-evidence rule.
    const refuted = scripted({ ...passing, "adversary-fallback:a": (i) => (i === 0 ? { taskId: "a", ran: true, verdict: "fail", summary: "off by one", issues: [{ severity: "blocker", file: "src/x.ts", description: "wrong", evidence: "pnpm exec vitest run tests/x.test.ts: FAIL off by one" }], commandsRun: [{ command: "pnpm exec vitest run tests/x.test.ts", ok: false, exitCode: 1 }], error: null } : { taskId: "a", ran: true, verdict: "pass", summary: "", issues: [], commandsRun: [], error: null }), "fix:a": () => ({ ...implResult, commit: "c2" }) });
    const f = await loadLoop({ agent: refuted.agent, fixAttempts: 2, adversary: { command: "x", timeoutMs: 1, fallback } }).runTask(task, "main");
    expect(labelled(refuted.calls, "fix:").length).toBe(1);
    expect(labelled(refuted.calls, "adversary-fallback:").length).toBe(2);
    expect(f.stopReason).toBeNull();
    expect(f.attempts[0].adversary).toEqual({ ran: true, verdict: "fail", blocked: true, summary: "off by one", fallback: used });
    expect(f.attempts[1].stages).toEqual(["fix", "adversary", "adversary-fallback", "check"]);

    // A fallback that itself returns nothing is still an absent review: blocked, not retried, and the reason names both.
    const silent = scripted({ ...passing, "adversary-fallback:a": () => null });
    const s = await loadLoop({ agent: silent.agent, fixAttempts: 3, adversary: { command: "x", timeoutMs: 1, fallback } }).runTask(task, "main");
    expect(labelled(silent.calls, "fix:").length).toBe(0);
    expect(s.stopReason).toContain("not retried: adversary did not run: codex-failed: codex exec exited 1: usage limit; the fallback adversary returned nothing");
    expect(s.adv.fallback).toEqual(used);

    // fallback: false keeps the strict rule.
    const strict = scripted({ ...passing, "adversary-fallback:a": () => { throw new Error("must not run"); } });
    const t = await loadLoop({ agent: strict.agent, fixAttempts: 3, adversary: { command: "x", timeoutMs: 1, fallback: false } }).runTask(task, "main");
    expect(labelled(strict.calls, "adversary-fallback:").length).toBe(0);
    expect(t.stopReason).toContain("not retried: adversary did not run: codex-failed");

    // A review that ran, even inconclusive, never triggers the fallback.
    const ran = scripted({ ...passing, "adversary:a": () => ({ taskId: "a", ran: true, verdict: "inconclusive", summary: "EPERM on 127.0.0.1", issues: [], commandsRun: [], error: null }), "adversary-fallback:a": () => { throw new Error("must not run"); } });
    const u = await loadLoop({ agent: ran.agent, fixAttempts: 3, adversary: { command: "x", timeoutMs: 1, fallback } }).runTask(task, "main");
    expect(labelled(ran.calls, "adversary-fallback:").length).toBe(0);
    expect(u.stopReason).toBeNull();
    expect(u.adv.fallback).toBeUndefined();
  });

  it("resolves adversary.fallback with opus / high as the default, knows which adversary results mean unavailable, and briefs the fallback adversary", () => {
    expect(source).toMatch(/const ADVERSARY_FALLBACK_MODEL = 'opus'/);
    expect(source).toMatch(/const ADVERSARY_FALLBACK_EFFORT = 'high'/);
    const rfStart = source.indexOf("function resolveFallback(");
    const resolveFallback = new Function("ADVERSARY_FALLBACK_MODEL", "ADVERSARY_FALLBACK_EFFORT", source.slice(rfStart, source.indexOf("\n}\n", rfStart) + 3) + "\nreturn resolveFallback;")("opus", "high");
    expect(resolveFallback(undefined)).toEqual({ model: "opus", effort: "high" });
    expect(resolveFallback(false)).toBe(false);
    expect(resolveFallback({ model: "sonnet" })).toEqual({ model: "sonnet", effort: "high" });
    expect(resolveFallback({ model: "inherit", effort: "inherit" })).toEqual({ model: undefined, effort: undefined });

    const auStart = source.indexOf("function adversaryUnavailable(");
    const adversaryUnavailable = new Function(source.slice(auStart, source.indexOf("\n}\n", auStart) + 3) + "\nreturn adversaryUnavailable;")();
    expect(adversaryUnavailable(null)).toBe(true);
    expect(adversaryUnavailable({ ran: false, verdict: "inconclusive", error: "codex-review not found: command not found" })).toBe(true);
    expect(adversaryUnavailable({ ran: true, verdict: "inconclusive", error: "timeout: codex exec exceeded 1 ms and was killed" })).toBe(true);
    expect(adversaryUnavailable({ ran: true, verdict: "inconclusive", error: "codex-failed: codex exec exited 1: usage limit" })).toBe(true);
    expect(adversaryUnavailable({ ran: true, verdict: "inconclusive", error: null })).toBe(false);
    expect(adversaryUnavailable({ ran: true, verdict: "inconclusive", error: "worktree-modified: the reviewer changed the working tree" })).toBe(false);
    expect(adversaryUnavailable({ ran: true, verdict: "fail", error: null })).toBe(false);
    expect(adversaryUnavailable({ ran: true, verdict: "pass", error: null })).toBe(false);

    const fallbackAdversaryPrompt = new Function(
      "plan", "BLOCKER_GATE", "confirmationLines", "acceptanceEntries",
      fnSlice("function fallbackAdversaryPrompt(") + "\nreturn fallbackAdversaryPrompt;",
    )({ verify: ["pnpm test:unit"], acceptance: ["it works"] }, blockerGate(), () => [], acceptanceEntriesFn());
    const p = fallbackAdversaryPrompt({ id: "a", title: "A", spec: "Do S.", files: ["src/a.ts"], verify: "vitest run src/a.test.ts" }, { branch: "doug/a", worktreePath: "/wt" }, "main", "codex-failed: usage limit", 1, []);
    expect(p).toContain("standing in for codex-review, which could not run (codex-failed: usage limit)");
    expect(p).toContain("main...doug/a");
    expect(p).toContain("/wt");
    expect(p).toContain("  $ vitest run src/a.test.ts");
    expect(p).toContain("  $ pnpm test:unit");
    expect(p).toContain("- it works");
    expect(p).toContain("ran=true, error=null");
    expect(p).toContain("Do not edit any file");
    expect(p).toMatch(/environment denial/);
  });

  // card fallback-adversary-acceptance: fallbackAdversaryPrompt rendered plan.acceptance with
  // (plan.acceptance || []).map(a => `- ${a}`), so an { text, command } entry printed "- [object Object]"
  // instead of going through acceptanceEntries like every other prompt (verifyPrompt, reviewPrompt, ...).
  it("renders a { text, command } acceptance entry through acceptanceEntries, not as [object Object] (card fallback-adversary-acceptance)", () => {
    const fallbackAdversaryPrompt = new Function(
      "plan", "BLOCKER_GATE", "confirmationLines", "acceptanceEntries",
      fnSlice("function fallbackAdversaryPrompt(") + "\nreturn fallbackAdversaryPrompt;",
    )(
      { verify: [], acceptance: ["prose criterion", { text: "x exists", command: "test -f x" }] },
      blockerGate(),
      () => [],
      acceptanceEntriesFn(),
    );
    const p = fallbackAdversaryPrompt({ id: "a", title: "A", spec: "Do S.", files: ["src/a.ts"] }, { branch: "doug/a", worktreePath: "/wt" }, "main", "codex-failed: usage limit", 1, []);
    expect(p).toContain("- prose criterion");
    expect(p).toContain("- x exists");
    expect(p).toContain("  $ test -f x");
    expect(p).not.toContain("[object Object]");
  });

  it("retries an adversary blocker on an owned file and passes on the next verdict", async () => {
    const { agent, calls } = scripted({
      "implement:a": () => implResult,
      "verify:a": () => ({ taskId: "a", passed: true, findings: [] }),
      "review:a": () => passingReview,
      "check:a": () => passingCheck,
      "fix:a": () => ({ ...implResult, summary: "fixed", commit: "c2" }),
      "adversary:a": (i) =>
        i === 0
          ? { taskId: "a", ran: true, verdict: "fail", summary: "off by one", issues: [{ severity: "blocker", file: "src/x.ts", line: 3, description: "returns 1", evidence: null }], commandsRun: [], error: null }
          : { taskId: "a", ran: true, verdict: "pass", summary: "ok", issues: [], commandsRun: [], error: null },
    });
    const { runTask } = loadLoop({ agent, fixAttempts: 2, adversary: { command: "x", timeoutMs: 1 } });
    const r = await runTask(task, "main");
    const fixes = labelled(calls, "fix:");
    expect(fixes.length).toBe(1);
    expect(fixes[0].prompt).toContain("F1 [adversary/spec] blocker src/x.ts:3");
    expect(fixes[0].prompt).toContain("returns 1");
    expect(labelled(calls, "adversary:").length).toBe(2);
    expect(r.attempts[0].adversary).toEqual({ ran: true, verdict: "fail", blocked: true, summary: "off by one" });
    expect(r.attempts[0].blockingStage).toBe("adversary");
    expect(r.attempts[1].ready).toBe(true);
    expect(r.attempts[1].fixedFindings).toEqual(["F1"]);
  });

  it("integrates on the first pass when the adversary's fail verdict carries only non-blocker issues (card fix-loop-minor-verdict)", async () => {
    const { agent, calls } = scripted({
      "implement:a": () => implResult,
      "verify:a": () => ({ taskId: "a", passed: true, findings: [] }),
      "review:a": () => passingReview,
      "adversary:a": () => ({ taskId: "a", ran: true, verdict: "fail", summary: "a text-format nit", issues: [{ severity: "minor", file: "src/x.ts", description: "prefer const" }], commandsRun: [], error: null }),
    });
    const { runTask } = loadLoop({ agent, fixAttempts: 2, adversary: { command: "x", timeoutMs: 1 } });
    const r = await runTask(task, "main");
    expect(labelled(calls, "fix:").length).toBe(0);
    expect(labelled(calls, "adversary:").length).toBe(1);
    expect(r.attempts[0].adversary).toEqual({ ran: true, verdict: "fail", blocked: false, summary: "a text-format nit" });
    expect(r.attempts[0].blockingStage).toBeNull();
    expect(r.attempts[0].ready).toBe(true);
    expect(r.stopReason).toBeNull();
  });

  it("still blocks and retries when the adversary's fail verdict carries no issue at all", async () => {
    const { agent, calls } = scripted({
      "implement:a": () => implResult,
      "verify:a": () => ({ taskId: "a", passed: true, findings: [] }),
      "review:a": () => passingReview,
      "check:a": () => passingCheck,
      "fix:a": () => ({ ...implResult, summary: "fixed", commit: "c2" }),
      "adversary:a": (i) =>
        i === 0
          ? { taskId: "a", ran: true, verdict: "fail", summary: "could not refute the change but failed it anyway", issues: [], commandsRun: [], error: null }
          : { taskId: "a", ran: true, verdict: "pass", summary: "ok", issues: [], commandsRun: [], error: null },
    });
    const { runTask } = loadLoop({ agent, fixAttempts: 2, adversary: { command: "x", timeoutMs: 1 } });
    const r = await runTask(task, "main");
    expect(r.attempts[0].adversary).toEqual({ ran: true, verdict: "fail", blocked: true, summary: "could not refute the change but failed it anyway" });
    expect(r.attempts[0].blockingStage).toBe("adversary");
    const fixes = labelled(calls, "fix:");
    expect(fixes.length).toBe(1);
    expect(fixes[0].prompt).toContain("could not refute the change but failed it anyway");
    expect(r.attempts[1].ready).toBe(true);
  });

  it("retries a reused task on its own branch the same way", async () => {
    const { agent, calls } = scripted({
      "reuse:a": () => ({ ...implResult, worktreePath: "/wt/r", summary: "reused doug/task-a at abc" }),
      "verify:a": (i) => (i === 0 ? { taskId: "a", passed: false, findings: ["src/x.ts returns 1"] } : { taskId: "a", passed: true, findings: [] }),
      "review:a": () => passingReview,
      "check:a": () => passingCheck,
      "fix:a": () => ({ ...implResult, worktreePath: "/wt/r", summary: "fixed", commit: "c2" }),
    });
    const { runTask } = loadLoop({ agent, fixAttempts: 2 });
    const r = await runTask({ ...task, reuse: "doug/task-a" }, "main");
    expect(labelled(calls, "implement:").length).toBe(0);
    expect(labelled(calls, "reuse:").length).toBe(1);
    const fixes = labelled(calls, "fix:");
    expect(fixes.length).toBe(1);
    expect(fixes[0].prompt).toContain("/wt/r");
    expect(fixes[0].prompt).toContain("doug/task-a");
    expect(r.attempts.length).toBe(2);
    expect(r.attempts[0].stages).toEqual(["reuse", "verify", "review"]);
    expect(r.stopReason).toBeNull();
  });

  it("extracts paths from blocking findings: structured issue files, then prose naming files the run knows", async () => {
    const { findingPaths, retriable } = loadLoop({ agent: async () => null, fixAttempts: 1 });
    // Prose: an absolute worktree path is skipped, ./ is stripped, and a path no plan task owns and the implementer
    // never touched (.doug/plan.json, lib/y.ts) is ignored because the workflow cannot see the disk.
    expect(
      findingPaths({
        impl: implResult,
        ver: { passed: false, findings: ["ran in /Users/e/.claude/worktrees/wf-1/src/x.ts: ./tests/x.test.ts fails; see .doug/plan.json and lib/y.ts"] },
        rev: { issues: [{ file: " src/x.ts " }, { file: "" }] },
        adv: null,
      }),
    ).toEqual(["src/x.ts", "tests/x.test.ts"]);
    // A file the implementer touched is known even when no task owns it.
    expect(findingPaths({ impl: { ...implResult, filesTouched: ["src/x.ts", "src/stray.ts"] }, ver: { passed: false, findings: ["src/stray.ts should not exist"] }, rev: passingReview, adv: null })).toEqual(["src/stray.ts"]);
    // A passing verifier's prose never counts.
    expect(findingPaths({ impl: implResult, ver: { passed: true, findings: ["probed src/x.ts and tests/x.test.ts"] }, rev: passingReview, adv: null })).toEqual([]);
    expect(retriable(task, { impl: implResult, ver: { passed: false, findings: ["see .doug/plan.json and .claude/worktrees/x/a.ts"] }, rev: passingReview, adv: null })).toEqual({
      ok: true,
      reason: "every finding is within the owned files",
    });
  });

  it("matches prose paths by suffix, expands braces, and ignores fixture paths; a findingFiles entry wins over prose", async () => {
    // The secrets-in-edits shape of 2026-09-05: owned files named in shortened and brace form, plus the fixture
    // paths the verifier probed with inside a temp project.
    const gates = { id: "g", title: "G", spec: "s", files: ["plugins/doug-gates/lib/secret-rules.mjs", "plugins/doug-gates/scripts/secret-scan.mjs", "plugins/doug-gates/tests/secret-scan.test.mjs"], verify: "true" };
    const gatesPlan = { ...defaultPlan, tasks: [gates, sibling] };
    const { findingPaths, retriable } = loadLoop({ agent: async () => null, fixAttempts: 1, plan: gatesPlan });
    const impl = { ...implResult, taskId: "g", filesTouched: ["plugins/doug-gates/lib/secret-rules.mjs"] };
    const prose = [
      "lib/secret-rules.mjs misses the AWS key form; plugins/doug-gates/{lib/secret-rules.mjs, scripts/secret-scan.mjs} both read it",
      "probed with src/a.ts and fixtures/keys.txt in a temp project: the hook let src/a.ts through",
    ];
    expect(findingPaths({ impl, ver: { passed: false, findings: prose }, rev: passingReview, adv: null })).toEqual([
      "lib/secret-rules.mjs",
      "plugins/doug-gates/lib/secret-rules.mjs",
      "plugins/doug-gates/scripts/secret-scan.mjs",
    ]);
    expect(retriable(gates, { impl, ver: { passed: false, findings: prose }, rev: passingReview, adv: null })).toEqual({ ok: true, reason: "every finding is within the owned files" });
    // The structured list is read instead of that finding's text: here it names a file outside the owned set.
    const listed = { passed: false, findings: prose, findingFiles: [{ finding: prose[1], files: ["plugins/doug-gates/lib/bash-rules.mjs"] }] };
    expect(findingPaths({ impl, ver: listed, rev: passingReview, adv: null })).toEqual([
      "plugins/doug-gates/lib/bash-rules.mjs",
      "lib/secret-rules.mjs",
      "plugins/doug-gates/lib/secret-rules.mjs",
      "plugins/doug-gates/scripts/secret-scan.mjs",
    ]);
    expect(retriable(gates, { impl, ver: listed, rev: passingReview, adv: null })).toEqual({ ok: false, reason: "findings name files outside the owned set: plugins/doug-gates/lib/bash-rules.mjs" });
    // Suffix both ways: a shortened owned path, and an owned path shortened in the plan.
    const short = { id: "s", title: "S", spec: "s", files: ["secret-rules.mjs"], verify: "true" };
    expect(retriable(short, { impl: { ...impl, taskId: "s" }, ver: { passed: false, findings: ["plugins/doug-gates/lib/secret-rules.mjs is wrong"], findingFiles: [{ finding: "plugins/doug-gates/lib/secret-rules.mjs is wrong", files: ["plugins/doug-gates/lib/secret-rules.mjs"] }] }, rev: passingReview, adv: null })).toEqual({ ok: true, reason: "every finding is within the owned files" });
    // The verifier and the check both carry the list.
    for (const name of ["VERIFY_SCHEMA", "CHECK_SCHEMA"]) {
      const start = source.indexOf(`const ${name}`);
      const schema = new Function(source.slice(start, source.indexOf("\n}\n", start) + 3) + `\nreturn ${name};`)();
      expect(schema.properties.findingFiles.items.required).toEqual(["finding", "files"]);
      expect(schema.required).not.toContain("findingFiles");
    }
    expect(source).toMatch(/findingFiles: Array\.isArray\(check\.findingFiles\) \? check\.findingFiles : \[\]/);
    const verifyPromptText = source.slice(source.indexOf("function verifyPrompt("), source.indexOf("function checkPrompt("));
    const checkPromptText = source.slice(source.indexOf("function checkPrompt("), source.indexOf("function reviewPrompt("));
    for (const text of [verifyPromptText, checkPromptText]) {
      expect(text).toContain("add { finding, files } to findingFiles");
      expect(text).toContain("Never list a fixture, scratch, or temp path");
    }
  });

  it("keeps a block retriable when a finding names a sibling task's file, and not when it names one no task owns", async () => {
    // A verifier that fails this task and, as information, names the acceptance criterion waiting on task b. That
    // sibling path is the plan's business, not this task leaving its lane, so the fix loop still runs.
    const mixed = "pnpm exec vitest run tests/x.test.ts failed: src/x.ts returns 1; the second criterion waits on task b (lib/other.mjs)";
    const { agent, calls } = scripted({
      "implement:a": () => implResult,
      "verify:a": (i) => (i === 0 ? { taskId: "a", passed: false, findings: [mixed] } : { taskId: "a", passed: true, findings: [] }),
      "review:a": () => passingReview,
      "check:a": () => passingCheck,
      "fix:a": () => ({ ...implResult, commit: "c2" }),
    });
    const r = await loadLoop({ agent, fixAttempts: 2 }).runTask(task, "main");
    expect(labelled(calls, "fix:").map((c) => c.opts.label)).toEqual(["fix:a:2"]);
    expect(r.attempts[0].retriable).toEqual({ ok: true, reason: "every finding is within the owned files" });
    expect(r.stopReason).toBeNull();

    // A path no task in the plan owns still ends the loop when the verifier lists it in findingFiles.
    const strangerText = "packages/other/y.ts is missing the export the test imports";
    const stranger = scripted({
      "implement:a": () => implResult,
      "verify:a": () => ({ taskId: "a", passed: false, findings: [strangerText], findingFiles: [{ finding: strangerText, files: ["packages/other/y.ts"] }] }),
      "review:a": () => passingReview,
    });
    const s = await loadLoop({ agent: stranger.agent, fixAttempts: 2 }).runTask(task, "main");
    expect(labelled(stranger.calls, "fix:").length).toBe(0);
    expect(s.stopReason).toBe("verification failed; not retried: findings name files outside the owned set: packages/other/y.ts");
    // In prose alone the same path is one the workflow cannot see, so it is ignored and the fix loop runs.
    const proseOnly = scripted({
      "implement:a": () => implResult,
      "verify:a": (i) => (i === 0 ? { taskId: "a", passed: false, findings: [strangerText] } : { taskId: "a", passed: true, findings: [] }),
      "review:a": () => passingReview,
      "check:a": () => passingCheck,
      "fix:a": () => ({ ...implResult, commit: "c2" }),
    });
    const p = await loadLoop({ agent: proseOnly.agent, fixAttempts: 2 }).runTask(task, "main");
    expect(labelled(proseOnly.calls, "fix:").length).toBe(1);
    expect(p.attempts[0].retriable).toEqual({ ok: true, reason: "every finding is within the owned files" });
  });

  it("stops after two consecutive passes that each raise a blocker nobody had seen", async () => {
    const A = "src/x.ts returns 1, expected 2";
    const B = "tests/x.test.ts never exercises the empty input";
    const { agent, calls } = scripted({
      "implement:a": () => implResult,
      "verify:a": (i) => (i === 0 ? { taskId: "a", passed: false, findings: [A] } : { taskId: "a", passed: false, findings: [B] }),
      "review:a": () => passingReview,
      "check:a": () => passingCheck,
      "fix:a": () => ({ ...implResult, commit: "c2" }),
    });
    const r = await loadLoop({ agent, fixAttempts: 5 }).runTask(task, "main");
    expect(labelled(calls, "fix:").map((c) => c.opts.label)).toEqual(["fix:a:2"]);
    expect(r.attempts.map((a) => a.newFindings)).toEqual([["F1"], ["F2"]]);
    expect(r.attempts[1].fixedFindings).toEqual(["F1"]);
    expect(r.stopReason).toContain("two consecutive passes raised new blockers");
    expect(r.stopReason).toContain("F1");
    expect(r.stopReason).toContain("F2");

    // Control: the same finding again is not a new one, so the loop keeps going and converges.
    const repeat = scripted({
      "implement:a": () => implResult,
      "verify:a": (i) => (i < 2 ? { taskId: "a", passed: false, findings: [A] } : { taskId: "a", passed: true, findings: [] }),
      "review:a": () => passingReview,
      "check:a": () => passingCheck,
      "fix:a": (i) => ({ ...implResult, commit: `c${i + 2}` }),
    });
    const ok = await loadLoop({ agent: repeat.agent, fixAttempts: 5 }).runTask(task, "main");
    expect(ok.stopReason).toBeNull();
    expect(ok.attempts.length).toBe(3);
    expect(ok.attempts.map((a) => a.newFindings)).toEqual([["F1"], [], []]);
  });

  it("stops a fix pass that made no new commit before running any check", async () => {
    const { agent, calls } = scripted({
      "implement:a": () => implResult,
      "verify:a": () => ({ taskId: "a", passed: false, findings: ["src/x.ts returns 1, expected 2"] }),
      "review:a": () => passingReview,
      "check:a": () => passingCheck,
      "fix:a": () => ({ ...implResult, summary: "nothing to do", commit: "c1" }),
    });
    const r = await loadLoop({ agent, fixAttempts: 3 }).runTask(task, "main");
    expect(labelled(calls, "fix:").length).toBe(1);
    expect(labelled(calls, "verify:").length).toBe(1);
    expect(labelled(calls, "check:").length).toBe(0);
    expect(labelled(calls, "adversary:").length).toBe(0);
    expect(r.stopReason).toBe("verification failed; stopped: fix pass 2 made no new commit on doug/task-a");
    expect(r.attempts[1]).toMatchObject({ pass: 2, stages: ["fix"], commit: "c1", ready: false });

    // A fix that reports blocked is decided the same way, right after it returns: no stage runs on that pass, even
    // though it committed, and the reason stays the implementer-blocked one.
    const stuck = scripted({
      "implement:a": () => implResult,
      "verify:a": () => ({ taskId: "a", passed: false, findings: ["src/x.ts returns 1, expected 2"] }),
      "review:a": () => passingReview,
      "check:a": () => passingCheck,
      "fix:a": () => ({ ...implResult, blocked: true, blockedReason: "needs lib/y.ts", commit: "c2" }),
    });
    const b = await loadLoop({ agent: stuck.agent, fixAttempts: 3 }).runTask(task, "main");
    expect(labelled(stuck.calls, "fix:").length).toBe(1);
    expect(labelled(stuck.calls, "verify:").length).toBe(1);
    expect(labelled(stuck.calls, "check:").length).toBe(0);
    expect(labelled(stuck.calls, "adversary:").length).toBe(0);
    expect(b.stopReason).toBe("blocked: needs lib/y.ts; not retried: implementer blocked: needs lib/y.ts");
    expect(b.attempts.length).toBe(2);
    expect(b.attempts[1]).toMatchObject({ pass: 2, stages: ["fix"], commit: "c2", ready: false, retriable: { ok: false, reason: "implementer blocked: needs lib/y.ts" } });
  });

  it("reruns the stage that blocked first and lets the later stages wait for it", async () => {
    const { agent, calls } = scripted({
      "implement:a": () => implResult,
      "verify:a": (i) => (i < 2 ? { taskId: "a", passed: false, findings: ["src/x.ts returns 1, expected 2"] } : { taskId: "a", passed: true, findings: [] }),
      "review:a": () => passingReview,
      "check:a": () => passingCheck,
      "fix:a": (i) => ({ ...implResult, commit: `c${i + 2}` }),
    });
    const r = await loadLoop({ agent, fixAttempts: 3 }).runTask(task, "main");
    // F1 is still open after fix pass 2: the supervisor briefs fix pass 3 (card fix-loop-supervisor).
    expect(calls.map((c) => c.opts.label)).toEqual(["implement:a", "verify:a", "review:a", "fix:a:2", "verify:a:2", "supervise:a:3", "fix:a:3", "verify:a:3", "check:a:3"]);
    expect(r.attempts[1].stages).toEqual(["fix", "verify"]);
    expect(r.attempts[1].blockingStage).toBe("verify");
    expect(r.attempts[2].stages).toEqual(["fix", "verify", "check"]);
    expect(r.stopReason).toBeNull();
  });

  it("treats a fix pass that returns no structured result as a retriable block that keeps the branch and worktree", async () => {
    const NO_RESULT = "implementer returned no structured result";
    // Nothing at all, every time: the loop retries in the same worktree until the fix attempts run out, and the task
    // keeps the branch and worktree it already knows instead of losing them to 'task stage threw'.
    const silent = scripted({
      "implement:a": () => implResult,
      "verify:a": () => ({ taskId: "a", passed: false, findings: ["src/x.ts returns 1, expected 2"] }),
      "review:a": () => passingReview,
      "fix:a": () => null,
    });
    const s = await loadLoop({ agent: silent.agent, fixAttempts: 3 }).runTask(task, "main");
    expect(labelled(silent.calls, "fix:").map((c) => c.opts.label)).toEqual(["fix:a:2", "fix:a:3", "fix:a:4"]);
    expect(labelled(silent.calls, "verify:").length).toBe(1);
    expect(labelled(silent.calls, "check:").length).toBe(0);
    expect(s.impl).toMatchObject({ branch: "doug/task-a", worktreePath: "/wt/a", blocked: false, commit: "c1" });
    expect(s.attempts.length).toBe(4);
    expect(s.attempts[1]).toMatchObject({ pass: 2, stages: ["fix"], commit: "c1", blockingStage: "verify", ready: false, retriable: { ok: true, reason: NO_RESULT } });
    expect(s.stopReason).toBe(`${NO_RESULT}; fix attempts exhausted (3 of 3)`);
    // The finding stays open, so every retry is told to fix it, in the worktree it already has.
    const last = labelled(silent.calls, "fix:")[2];
    expect(last.prompt).toContain("F1 [verify/verification]");
    expect(last.prompt).toContain("existing worktree /wt/a on branch doug/task-a");
    expect(last.opts.isolation).toBeUndefined();

    // An implementer that ends without calling StructuredOutput makes agent() reject: the launch funnel (card
    // stage-agent-retry-on-no-output) retries once with the same prompt before this no-structured-result handling
    // ever sees it, so a lone throw no longer reaches here at all (covered below); two throws in a row - the fresh
    // call and its retry - still fall through to it, and the pass after fixes the task for real.
    const logs = [];
    const thrown = scripted({
      "implement:a": () => implResult,
      "verify:a": (i) => (i === 0 ? { taskId: "a", passed: false, findings: ["src/x.ts returns 1, expected 2"] } : { taskId: "a", passed: true, findings: [] }),
      "review:a": () => passingReview,
      "check:a": () => passingCheck,
      "fix:a": (i) => {
        if (i < 2) throw new Error("agent ended without calling StructuredOutput");
        return { ...implResult, summary: "fixed", commit: "c2" };
      },
    });
    const t = await loadLoop({ agent: thrown.agent, fixAttempts: 3, log: (l) => logs.push(l) }).runTask(task, "main");
    expect(labelled(thrown.calls, "fix:").map((c) => c.opts.label)).toEqual(["fix:a:2", "fix:a:2:retry", "fix:a:3"]);
    expect(logs.some((l) => l.includes("a fix:a:2: stage agent threw") && l.includes("StructuredOutput") && l.includes("retrying once"))).toBe(true);
    expect(t.attempts.length).toBe(3);
    expect(t.attempts[1]).toMatchObject({ pass: 2, stages: ["fix"], commit: "c1", retriable: { ok: true, reason: NO_RESULT } });
    expect(t.attempts[2].stages[0]).toBe("fix");
    expect(t.attempts[2].ready).toBe(true);
    expect(t.stopReason).toBeNull();
    expect(t.impl.commit).toBe("c2");
  });

  it("retries a stage agent once on a lone rejection, with a :retry label; the implementer's retry gets the resume prompt for its own branch, not the original prompt (card implementer-retry-own-branch)", async () => {
    const logs = [];
    const { agent, calls } = scripted({
      "implement:a": (i) => {
        if (i === 0) throw new Error("agent completed without calling StructuredOutput");
        return implResult;
      },
      "verify:a": () => ({ taskId: "a", passed: true, findings: [] }),
      "review:a": () => passingReview,
      "check:a": () => passingCheck,
    });
    // The real implementPrompt (not the loop's usual "implement" stub), so the resume wording it carries at
    // retry can actually be checked against the refusal the first call carries.
    const realImplementPrompt = new Function("plan", CONSTS + fnSlice("function implementPrompt(") + "\nreturn implementPrompt;")(defaultPlan);
    const r = await loadLoop({ agent, fixAttempts: 2, implementPrompt: realImplementPrompt, log: (l) => logs.push(l) }).runTask(task, "main");
    const implCalls = labelled(calls, "implement:a");
    expect(implCalls.map((c) => c.opts.label)).toEqual(["implement:a", "implement:a:retry"]);
    // card implementer-retry-own-branch: no longer the same prompt. The relaunch within this run is told the
    // branch is its own predecessor's, not an earlier run's leftover, and how to pick up its worktree.
    expect(implCalls[0].prompt).toContain('stale branch doug/task-a already exists');
    expect(implCalls[1].prompt).not.toContain('return blocked=true with blockedReason "stale branch');
    expect(implCalls[1].prompt).toContain("git worktree list --porcelain");
    expect(implCalls[1].prompt).not.toBe(implCalls[0].prompt);
    // Opts are still spread from the same call with only the label changed.
    expect(implCalls[1].opts).toEqual({ ...implCalls[0].opts, label: "implement:a:retry" });
    expect(logs.some((l) => l.includes("a implement:a: stage agent threw") && l.includes("StructuredOutput") && l.includes("retrying once"))).toBe(true);
    expect(r.stopReason).toBeNull();
    expect(r.impl.commit).toBe("c1");
  });

  it("gives a lead's retry the same resume prompt for its own branch (card implementer-retry-own-branch)", async () => {
    const swarmPlan = { ...defaultPlan, swarm: true };
    const swarmTask = { ...task, files: ["src/x.ts", "src/y.ts", "tests/x.test.ts"] };
    const leadResult = { taskId: "a", branch: "doug/task-a", worktreePath: "/wt/lead", briefs: [{ id: "core", title: "Core", spec: "Make x return 2 in src/x.ts.", files: ["src/x.ts"], verify: null }, { id: "tests", title: "Tests", spec: "Test x in tests/x.test.ts.", files: ["tests/x.test.ts"], verify: "pnpm exec vitest run tests/x.test.ts" }], blocked: false, splitReason: "two independent deliverables: x's behavior and its test, each verified on its own" };
    const worker = (n) => ({ taskId: "a", branch: `doug/task-a-w${n}`, worktreePath: `/wt/w${n}`, filesTouched: [n === 1 ? "src/x.ts" : "tests/x.test.ts"], commandsRun: [{ command: "true", ok: true }], summary: "done", blocked: false, commit: `w${n}c1` });
    const merged = { ...implResult, worktreePath: "/wt/lead", commit: "m1", summary: "merged core, tests" };
    const { agent, calls } = scripted({
      "lead:a": (i) => {
        if (i === 0) throw new Error("agent completed without calling StructuredOutput");
        return leadResult;
      },
      "worker:a": (i) => worker(i + 1),
      "lead-merge:a": () => merged,
      "verify:a": () => ({ taskId: "a", passed: true, findings: [] }),
      "review:a": () => passingReview,
    });
    const realLeadPrompt = new Function("plan", CONSTS + fnSlice("function leadPrompt(") + "\nreturn leadPrompt;")(swarmPlan);
    const r = await loadLoop({ agent, fixAttempts: 2, plan: swarmPlan, leadPrompt: realLeadPrompt }).runTask(swarmTask, "main");
    const leadCalls = labelled(calls, "lead:a");
    expect(leadCalls.map((c) => c.opts.label)).toEqual(["lead:a", "lead:a:retry"]);
    expect(leadCalls[0].prompt).toContain('stale branch doug/task-a already exists');
    expect(leadCalls[1].prompt).not.toContain('return blocked=true with blockedReason "stale branch');
    expect(leadCalls[1].prompt).toContain("git worktree list --porcelain");
    expect(leadCalls[1].prompt).not.toBe(leadCalls[0].prompt);
    expect(leadCalls[1].opts).toEqual({ ...leadCalls[0].opts, label: "lead:a:retry" });
    expect(r.stopReason).toBeNull();
  });

  it("does not give a retry prompt to a stage that never creates its own branch: retryOnce's retry prompt is opt-in (card implementer-retry-own-branch)", async () => {
    const { agent, calls } = scripted({
      "implement:a": () => implResult,
      "verify:a": (i) => {
        if (i === 0) throw new Error("agent completed without calling StructuredOutput");
        return { taskId: "a", passed: true, findings: [] };
      },
      "review:a": () => passingReview,
      "check:a": () => passingCheck,
    });
    const r = await loadLoop({ agent, fixAttempts: 2 }).runTask(task, "main");
    const verifyCalls = labelled(calls, "verify:a");
    expect(verifyCalls.map((c) => c.opts.label)).toEqual(["verify:a", "verify:a:retry"]);
    expect(verifyCalls[1].prompt).toBe(verifyCalls[0].prompt);
    expect(verifyCalls[1].opts).toEqual({ ...verifyCalls[0].opts, label: "verify:a:retry" });
    expect(r.stopReason).toBeNull();
  });

  it("does not retry a stage agent that resolves null", async () => {
    const { agent, calls } = scripted({
      "implement:a": () => implResult,
      "verify:a": () => null,
      "review:a": () => passingReview,
    });
    await loadLoop({ agent, fixAttempts: 2 }).runTask(task, "main");
    expect(labelled(calls, "verify:a").map((c) => c.opts.label)).toEqual(["verify:a"]);
  });

  it("keeps the stage-agent retry inside one retryOnce helper, used by the task loop's launch and by the level loop's integrate and level-adversary calls", () => {
    // The helper itself: one retry, same prompt, opts spread with a :retry label, logged.
    const retryOnceStart = source.indexOf("async function retryOnce(");
    expect(retryOnceStart).toBeGreaterThan(-1);
    const retryOnceEnd = source.indexOf("\n}\n", retryOnceStart) + 3;
    const retryOnceBody = source.slice(retryOnceStart, retryOnceEnd);
    expect(retryOnceBody).toContain(":retry");
    expect(retryOnceBody).toMatch(/catch\s*\(/);

    // runTask's own launch goes through it (this is the slice the fix-loop test loader evaluates).
    const launchStart = source.indexOf("const counted = { agents: 0 }");
    const launchEnd = source.indexOf("const measure = ", launchStart);
    expect(source.slice(launchStart, launchEnd)).toContain("retryOnce(");

    // So does the level loop, where a level-scope agent() call has no try/catch of its own and previously could
    // drop the whole workflow on a single no-structured-output throw (review follow-up: the two integrate calls
    // and the level adversary sit outside any task's launch closure).
    // Card integration-acceptance-recorded wraps both results in enforceIntegrationAcceptance(...) before anything
    // reads .ok; retryOnce still wraps the same integratePrompt(...) call underneath.
    expect(source).toContain(
      "integration = enforceIntegrationAcceptance(await retryOnce(integratePrompt(li, ready, baseBranch, li === levels.length - 1, sReady.length > 0, !integratedOnce), agentOpts('integrate', null, { label: `integrate:level-${li}`, phase: 'Integrate', schema: INTEGRATE_SCHEMA }), `level-${li}`), li === levels.length - 1, acceptanceEntries(plan.acceptance || []))",
    );
    expect(source).toContain(
      "const again = enforceIntegrationAcceptance(await retryOnce(integratePrompt(li, fixedReady, levelBase, li === levels.length - 1, true, false), agentOpts('integrate', null, { label: `integrate:level-${li}:2`, phase: 'Integrate', schema: INTEGRATE_SCHEMA }), `level-${li}`), li === levels.length - 1, acceptanceEntries(plan.acceptance || []))",
    );
    expect(source).toContain("const adv = await runAdversary(null, null, 1, levelBase, [], (p, o) => retryOnce(p, o, `level-${li}`), [], subject)");
  });

  it("replaces the verifier and the reviewer with one focused check on a fix pass", async () => {
    const { agent, calls } = scripted({
      "implement:a": () => implResult,
      "verify:a": () => ({ taskId: "a", passed: true, findings: [], acceptance: [] }),
      "review:a": () => passingReview,
      "check:a": () => passingCheck,
      "fix:a": () => ({ ...implResult, commit: "c2" }),
      "adversary:a": (i) =>
        i === 0
          ? { taskId: "a", ran: true, verdict: "fail", summary: "off by one", issues: [{ severity: "blocker", file: "src/x.ts", line: 3, description: "returns 1", evidence: null }], commandsRun: [], error: null }
          : { taskId: "a", ran: true, verdict: "pass", summary: "ok", issues: [], commandsRun: [], error: null },
    });
    const r = await loadLoop({ agent, fixAttempts: 2, adversary: { command: "x", timeoutMs: 1 } }).runTask(task, "main");
    expect(calls.map((c) => c.opts.label).slice(4)).toEqual(["fix:a:2", "adversary:a:2", "check:a:2"]);
    expect(labelled(calls, "verify:a:2").length).toBe(0);
    expect(labelled(calls, "review:a:2").length).toBe(0);
    const check = labelled(calls, "check:")[0];
    expect(check.opts.role).toBe("verify");
    expect(check.opts.agentType).toBe("doug-flow:verifier");
    expect(check.opts.phase).toBe("Verify");
    expect(check.opts.schema).toEqual({ schema: "check" });
    expect(check.prompt).toContain("pnpm exec vitest run tests/x.test.ts");
    expect(check.prompt).toContain("  $ test -f x");
    expect(check.prompt).toContain("git diff c1..doug/task-a");
    expect(check.prompt).toContain("F1 [adversary/spec]");
    // The check's result stands in for both stages in the pass result and the report.
    expect(r.ver).toEqual({ taskId: "a", passed: true, commandsRun: [], findings: [], findingFiles: [], acceptance: [] });
    expect(r.rev).toEqual({ taskId: "a", specCompliant: true, inScope: true, approve: true, issues: [] });
    expect(r.attempts[1]).toMatchObject({ verified: true, reviewed: true, ready: true });
  });

  it("gives the adversary a free hand on the first pass and the ledger to confirm afterwards", () => {
    const open = { id: "F1", fingerprint: "f1", stage: "verify", invariant: "verification", severity: "blocker", file: "src/x.ts", line: 3, description: "returns 1, expected 2", evidence: "vitest said expected 2 got 1", status: "open", openedPass: 1, fixedPass: null, fixedCommit: null, confirmedBy: null, reappeared: false };
    const fixed = { id: "F2", fingerprint: "f2", stage: "adversary", invariant: "data-integrity", severity: "blocker", file: "src/y.ts", line: null, description: "deletes the cache", evidence: null, status: "fixed", openedPass: 1, fixedPass: 2, fixedCommit: "abcdef1234567", confirmedBy: "check", reappeared: false };
    const ledger = [open, fixed];
    const impl = { branch: "doug/a", worktreePath: "/wt", commit: "c2", prevCommit: "c1" };
    const t = { id: "a", title: "A", spec: "Do S.", files: ["src/x.ts"], verify: "vitest run src/x.test.ts" };
    const mod = ledgerModule();
    const confirmationLines = new Function("ledgerText", fnSlice("function confirmationLines(") + "\nreturn confirmationLines;")(mod.ledgerText);
    const adversaryPrompt = new Function(
      "plan", "adversary", "shellQuote", "BLOCKER_GATE", "confirmationLines",
      fnSlice("function adversaryPrompt(") + "\nreturn adversaryPrompt;",
    )({ verify: ["pnpm test:unit"] }, { command: "codex-review", timeoutMs: 1 }, new Function(fnSlice("function shellQuote(") + "\nreturn shellQuote;")(), blockerGate(), confirmationLines);

    const first = adversaryPrompt(t, impl, "main", 1, []);
    expect(first).not.toContain("Confirmation pass");
    expect(first).not.toContain("F1");
    expect(first).toContain("explore freely");
    expect(first).toContain("repository invariant");
    expect(first).toContain("at most minor");

    const later = adversaryPrompt(t, impl, "main", 2, ledger);
    expect(later).toContain("Confirmation pass 2");
    expect(later).toContain("returns 1, expected 2");
    expect(later).toContain("vitest said expected 2 got 1");
    expect(later).toContain("F2 [adversary/data-integrity] fixed in abcdef1, confirmed by check (pass 2)");
    expect(later).toContain("git diff c1..doug/a");
    expect(later).toContain("repository invariant");
    // The gate stays inside the spec heredoc.
    expect(later.indexOf("repository invariant")).toBeLessThan(later.lastIndexOf("DOUG_SPEC_EOF"));

    const fallbackAdversaryPrompt = new Function(
      "plan", "BLOCKER_GATE", "confirmationLines", "acceptanceEntries",
      fnSlice("function fallbackAdversaryPrompt(") + "\nreturn fallbackAdversaryPrompt;",
    )({ verify: ["pnpm test:unit"], acceptance: ["it works"] }, blockerGate(), confirmationLines, acceptanceEntriesFn());
    const fbFirst = fallbackAdversaryPrompt(t, impl, "main", "codex down", 1, []);
    expect(fbFirst).not.toContain("Confirmation pass");
    expect(fbFirst).toContain("repository invariant");
    const fbLater = fallbackAdversaryPrompt(t, impl, "main", "codex down", 2, ledger);
    expect(fbLater).toContain("Confirmation pass 2");
    expect(fbLater).toContain("returns 1, expected 2");
    expect(fbLater).toContain("vitest said expected 2 got 1");
    expect(fbLater).toContain("F2 [adversary/data-integrity] fixed in abcdef1, confirmed by check (pass 2)");
    expect(fbLater).toContain("repository invariant");
  });

  it("E4: adversaryPrompt appends --effort <level> right after --timeout-ms <n> when adversary.effort is set, and nothing when unset (card codex-review-effort)", () => {
    const mod = ledgerModule();
    const confirmationLines = new Function("ledgerText", fnSlice("function confirmationLines(") + "\nreturn confirmationLines;")(mod.ledgerText);
    const shellQuoteFn = new Function(fnSlice("function shellQuote(") + "\nreturn shellQuote;")();
    const t = { id: "a", title: "A", spec: "Do S.", files: ["src/x.ts"] };
    const impl = { branch: "doug/a", worktreePath: "/wt", commit: "c2", prevCommit: "c1" };

    const adversaryPromptWithEffort = new Function(
      "plan", "adversary", "shellQuote", "BLOCKER_GATE", "confirmationLines",
      fnSlice("function adversaryPrompt(") + "\nreturn adversaryPrompt;",
    )({ verify: [] }, { command: "codex-review", timeoutMs: 1, effort: "low" }, shellQuoteFn, blockerGate(), confirmationLines);
    const withEffort = adversaryPromptWithEffort(t, impl, "main", 1, []);
    expect(withEffort, "rule: adversary.effort set adds --effort <level> right after --timeout-ms <n>").toContain("--timeout-ms 1 --effort low");

    const adversaryPromptNoEffort = new Function(
      "plan", "adversary", "shellQuote", "BLOCKER_GATE", "confirmationLines",
      fnSlice("function adversaryPrompt(") + "\nreturn adversaryPrompt;",
    )({ verify: [] }, { command: "codex-review", timeoutMs: 1 }, shellQuoteFn, blockerGate(), confirmationLines);
    const withoutEffort = adversaryPromptNoEffort(t, impl, "main", 1, []);
    expect(withoutEffort, "rule: adversary.effort unset adds no --effort").not.toContain("--effort");
  });

  it("E5: levelAdversaryPrompt appends --effort <level> right after --timeout-ms <n> the same way, and the workflow sets adversary.effort from tierFor('adversary').effort so a literal cannot replace the row (card codex-review-effort)", () => {
    const shellQuoteFn = new Function(fnSlice("function shellQuote(") + "\nreturn shellQuote;")();
    const stubLevelSpecLines = () => ["Task a: A", "Owned files: src/x.ts", "Do S.", ""];
    const t = { id: "a", title: "A", spec: "Do S.", files: ["src/x.ts"] };
    const sReady = [{ task: t }];

    const levelAdversaryPromptWithEffort = new Function(
      "plan", "adversary", "shellQuote", "integrationBranch", "INTEGRATION_WORKTREE", "levelSpecLines", "BLOCKER_GATE",
      fnSlice("function levelAdversaryPrompt(") + "\nreturn levelAdversaryPrompt;",
    )(
      { verify: [], title: "P" },
      { command: "codex-review", timeoutMs: 1, effort: "low" },
      shellQuoteFn,
      "doug/integration",
      ".claude/worktrees/doug-integration",
      stubLevelSpecLines,
      blockerGate(),
    );
    const levelWithEffort = levelAdversaryPromptWithEffort(1, sReady, "main", false);
    expect(levelWithEffort, "rule: levelAdversaryPrompt also appends --effort <level> right after --timeout-ms <n>").toContain("--timeout-ms 1 --effort low");

    const levelAdversaryPromptNoEffort = new Function(
      "plan", "adversary", "shellQuote", "integrationBranch", "INTEGRATION_WORKTREE", "levelSpecLines", "BLOCKER_GATE",
      fnSlice("function levelAdversaryPrompt(") + "\nreturn levelAdversaryPrompt;",
    )(
      { verify: [], title: "P" },
      { command: "codex-review", timeoutMs: 1 },
      shellQuoteFn,
      "doug/integration",
      ".claude/worktrees/doug-integration",
      stubLevelSpecLines,
      blockerGate(),
    );
    const levelWithoutEffort = levelAdversaryPromptNoEffort(1, sReady, "main", false);
    expect(levelWithoutEffort, "rule: levelAdversaryPrompt with adversary.effort unset adds no --effort").not.toContain("--effort");

    // Round 2 source pin: evaluate the CODEX_REASONING_EFFORT map and the `if (adversary)` wiring statement
    // instead of matching a substring, so the map itself (not just its call shape) is pinned.
    const wireStart = source.indexOf("const CODEX_REASONING_EFFORT");
    const wireEnd = source.indexOf("\n", source.indexOf("if (adversary)", wireStart));
    const wireSlice = source.slice(wireStart, wireEnd);
    const applyEffort = new Function("adversary", "tierFor", wireSlice + "\nreturn adversary;");

    expect(applyEffort({}, () => ({ effort: "low" })), "rule: row 'low' maps to 'low'").toEqual({ effort: "low" });
    expect(applyEffort({}, () => ({ effort: "max" })), "rule: row 'max' maps to Codex's 'xhigh'").toEqual({ effort: "xhigh" });
    expect(applyEffort({ effort: "high" }, () => ({ effort: "low" })), "rule: a plan's own adversary.effort wins over the row").toEqual({ effort: "high" });
    expect(applyEffort({ effort: "max" }, () => ({ effort: "low" })), "rule: a plan's own 'max' also maps to 'xhigh'").toEqual({ effort: "xhigh" });
    const bogusResult = applyEffort({}, () => ({ effort: "bogus" }));
    expect(bogusResult.effort, "rule: a value outside the map (row 'bogus') leaves effort undefined, so no --effort is passed").toBeUndefined();
    expect(() => applyEffort(null, () => ({ effort: "low" })), "rule: adversary null must not throw").not.toThrow();

    const adversaryPromptBogus = new Function(
      "plan", "adversary", "shellQuote", "BLOCKER_GATE", "confirmationLines",
      fnSlice("function adversaryPrompt(") + "\nreturn adversaryPrompt;",
    )({ verify: [] }, { command: "codex-review", timeoutMs: 1, ...bogusResult }, shellQuoteFn, blockerGate(), new Function("ledgerText", fnSlice("function confirmationLines(") + "\nreturn confirmationLines;")(ledgerModule().ledgerText));
    const bogusCommand = adversaryPromptBogus(t, { branch: "doug/a", worktreePath: "/wt", commit: "c2", prevCommit: "c1" }, "main", 1, []);
    expect(bogusCommand, "rule: an effort the map does not resolve carries no --effort on the command line").not.toContain("--effort");
  });

  it("blocks the pass when a finding the ledger recorded as fixed comes back", async () => {
    const finding = "src/x.ts returns 1, expected 2";
    const { agent, calls } = scripted({
      "implement:a": () => implResult,
      "verify:a": (i) => (i === 0 ? { taskId: "a", passed: false, findings: [finding] } : { taskId: "a", passed: true, findings: [] }),
      "review:a": () => passingReview,
      "check:a": () => passingCheck,
      "fix:a": (i) => ({ ...implResult, commit: `c${i + 2}` }),
      "adversary:a": (i) =>
        i === 0
          ? { taskId: "a", ran: true, verdict: "pass", summary: "ok", issues: [{ severity: "minor", file: "src/x.ts", line: 3, description: "F1: still returns 1 on the empty input", evidence: null }], commandsRun: [], error: null }
          : { taskId: "a", ran: true, verdict: "pass", summary: "ok", issues: [], commandsRun: [], error: null },
    });
    const r = await loadLoop({ agent, fixAttempts: 3, adversary: { command: "x", timeoutMs: 1 } }).runTask(task, "main");
    // Pass 2: the verifier confirmed F1 fixed, the check passed, and the confirmation adversary reported it again.
    expect(r.attempts[1].stages).toEqual(["fix", "verify", "check", "adversary"]);
    expect(r.attempts[1].ready).toBe(false);
    expect(r.attempts[1].fixedFindings).toEqual([]);
    const entry = r.ledger.find((e) => e.id === "F1");
    expect(entry.reappeared).toBe(true);
    const fixes = labelled(calls, "fix:");
    expect(fixes.length).toBe(2);
    expect(fixes[1].opts.label).toBe("fix:a:3");
    expect(fixes[1].prompt).toContain("F1 [verify/verification]");
    expect(fixes[1].prompt).toContain("(reappeared after being fixed)");
    expect(r.stopReason).toBeNull();
  });

  it("stops before launching a fix the task budget cannot pay for", async () => {
    const blockingVerifier = {
      "implement:a": () => implResult,
      "verify:a": () => ({ taskId: "a", passed: false, findings: ["src/x.ts returns 1, expected 2"] }),
      "review:a": () => passingReview,
      "fix:a": (i) => ({ ...implResult, commit: `c${i + 2}` }),
    };
    const agents = scripted(blockingVerifier);
    const a = await loadLoop({ agent: agents.agent, fixAttempts: 5, plan: { ...defaultPlan, budget: { agents: 4 } } }).runTask(task, "main");
    expect(labelled(agents.calls, "fix:").length).toBe(0);
    expect(a.stopReason).toContain("would exceed the task budget");
    expect(a.stopReason).toContain("agents 6 > 4");
    expect(a.budget.limits.agents).toBe(4);
    expect(a.budget.spent.agents).toBe(3);

    // A runtime that reports tokens: three agents at 100 tokens each, and one more pass would double it.
    const stub = { spent: 0 };
    const tokens = scripted(blockingVerifier, () => { stub.spent += 100; });
    const t = await loadLoop({ agent: tokens.agent, fixAttempts: 5, budget: stub, plan: { ...defaultPlan, budget: { tokens: 250 } } }).runTask(task, "main");
    expect(labelled(tokens.calls, "fix:").length).toBe(0);
    expect(t.stopReason).toContain("tokens 600 > 250");
    expect(t.attempts[0].spent).toEqual({ agents: 3, tokens: 300, elapsedMs: null });
    expect(t.budget.enforced).toEqual(["agents", "tokens"]);

    // A runtime that reports nothing leaves both measures null and enforces only the agent count.
    const blind = scripted(blockingVerifier);
    const blind2 = await loadLoop({ agent: blind.agent, fixAttempts: 1, budget: { note: "no numbers here" } }).runTask(task, "main");
    expect(blind2.attempts[0].spent).toEqual({ agents: 3, tokens: null, elapsedMs: null });
    expect(blind2.budget.enforced).toEqual(["agents"]);

    // The adversary stage spends two agents when a fallback stands in for codex-review, and the projection counts both:
    // five spent, plus the fix, the adversary, its fallback and the check, is nine and does not fit an eight-agent task.
    const fell = scripted({
      "implement:a": () => implResult,
      "verify:a": () => ({ taskId: "a", passed: true, findings: [] }),
      "review:a": () => passingReview,
      "check:a": () => passingCheck,
      "adversary:a": () => ({ taskId: "a", ran: false, verdict: "inconclusive", summary: "", issues: [], commandsRun: [], error: "codex-failed: usage limit" }),
      // card fallback-adversary-blocker-evidence: an evidence-free blocker is now downgraded, so this fixture (like
      // the "refuted" one above) carries real evidence, keeping this test's point (the budget projection, not R12).
      "adversary-fallback:a": () => ({ taskId: "a", ran: true, verdict: "fail", summary: "off by one", issues: [{ severity: "blocker", file: "src/x.ts", description: "returns 1", evidence: "pnpm exec vitest run tests/x.test.ts: FAIL returns 1" }], commandsRun: [{ command: "pnpm exec vitest run tests/x.test.ts", ok: false, exitCode: 1 }], error: null }),
      "fix:a": () => ({ ...implResult, commit: "c2" }),
    });
    const c = await loadLoop({
      agent: fell.agent,
      fixAttempts: 5,
      adversary: { command: "x", timeoutMs: 1, fallback: { model: "opus", effort: "high" } },
      plan: { ...defaultPlan, budget: { agents: 8 } },
    }).runTask(task, "main");
    expect(labelled(fell.calls, "fix:").length).toBe(0);
    expect(c.budget.spent.agents).toBe(5);
    expect(c.stopReason).toContain("agents 9 > 8");

    // A fallback that never stood in costs nothing: the primary adversary ran, so the stage the projection counts
    // is one agent, and a seven-agent task can still pay for the fix pass (fix, adversary, check) it needs.
    const primary = {
      "implement:a": () => implResult,
      "verify:a": () => ({ taskId: "a", passed: true, findings: [] }),
      "review:a": () => passingReview,
      "check:a": () => passingCheck,
      "adversary:a": (i) => (i === 0
        ? { taskId: "a", ran: true, verdict: "fail", summary: "off by one", issues: [{ severity: "blocker", file: "src/x.ts", description: "returns 1" }], commandsRun: [], error: null }
        : { taskId: "a", ran: true, verdict: "pass", summary: "ok", issues: [], commandsRun: [], error: null }),
      "adversary-fallback:a": () => { throw new Error("must not run"); },
      "fix:a": () => ({ ...implResult, commit: "c2" }),
    };
    const configured = { command: "x", timeoutMs: 1, fallback: { model: "opus", effort: "high" } };
    const roomy = scripted(primary);
    const rm = await loadLoop({ agent: roomy.agent, fixAttempts: 5, adversary: configured, plan: { ...defaultPlan, budget: { agents: 7 } } }).runTask(task, "main");
    expect(labelled(roomy.calls, "fix:").length).toBe(1);
    expect(rm.stopReason).toBeNull();
    expect(rm.budget.spent.agents).toBe(7);

    const tight = scripted(primary);
    const tg = await loadLoop({ agent: tight.agent, fixAttempts: 5, adversary: configured, plan: { ...defaultPlan, budget: { agents: 6 } } }).runTask(task, "main");
    expect(labelled(tight.calls, "fix:").length).toBe(0);
    expect(tg.stopReason).toContain("agents 7 > 6");

    // The mean per completed pass is added whole, not rounded. F1 blocks passes 1 and 2, so the supervisor (card
    // fix-loop-supervisor) spends one agent before pass 3; pass 3 raises a different finding, so no second stall:
    // 800 tokens over three passes projects 1066.67, which does not fit a 1066-token budget even though the rounded
    // mean would have fitted.
    const frac = { spent: 0 };
    const fine = scripted({ ...blockingVerifier, "verify:a": (i) => ({ taskId: "a", passed: false, findings: [i < 2 ? "src/x.ts returns 1, expected 2" : "tests/x.test.ts never exercises the empty input"] }) }, () => { frac.spent += 100; });
    const f = await loadLoop({ agent: fine.agent, fixAttempts: 3, budget: frac, plan: { ...defaultPlan, budget: { tokens: 1066 } } }).runTask(task, "main");
    expect(labelled(fine.calls, "fix:").length).toBe(2);
    expect(f.budget.spent.tokens).toBe(800);
    expect(labelled(fine.calls, "supervise:").map((c) => c.opts.label)).toEqual(["supervise:a:3"]);
    expect(f.stopReason).toContain("tokens 1066.67 > 1066");
  });

  it("keeps a task out of integration while the ledger still holds an open finding", async () => {
    // Pass 2 blocks on the adversary first: it re-reports F1 as minor, which blocks no stage, and the check that
    // follows never mentions it. The entry stays open, so the pass is not ready however well the stages went.
    const { agent, calls } = scripted({
      "implement:a": () => implResult,
      "verify:a": () => ({ taskId: "a", passed: true, findings: [] }),
      "review:a": () => passingReview,
      "check:a": () => passingCheck,
      "fix:a": () => ({ ...implResult, commit: "c2" }),
      "adversary:a": (i) =>
        i === 0
          ? { taskId: "a", ran: true, verdict: "fail", summary: "off by one", issues: [{ severity: "blocker", file: "src/x.ts", line: 3, description: "returns 1 on the empty input", evidence: "got 1" }], commandsRun: [], error: null }
          : { taskId: "a", ran: true, verdict: "pass", summary: "ok", issues: [{ severity: "minor", file: "src/x.ts", line: 3, description: "F1: the empty input still reads oddly", evidence: null }], commandsRun: [], error: null },
    });
    const r = await loadLoop({ agent, fixAttempts: 1, adversary: { command: "x", timeoutMs: 1 } }).runTask(task, "main");
    expect(r.attempts[1].stages).toEqual(["fix", "adversary", "check"]);
    expect(labelled(calls, "check:").map((c) => c.opts.label)).toEqual(["check:a:2"]);
    const entry = r.ledger.find((e) => e.id === "F1");
    expect(entry.status).toBe("open");
    expect(entry.reappeared).toBe(false);
    expect(r.attempts[1].fixedFindings).toEqual([]);
    expect(r.attempts[1].ready).toBe(false);
    expect(r.stopReason).toContain("open finding: F1");
    // A stopped task never integrates, whatever the stage booleans of its last pass say.
    expect(r.attempts[1]).toMatchObject({ verified: true, reviewed: true });
  });

  it("keeps the default budget in step with lib/plan.mjs and fingerprints findings stably", () => {
    expect(budgetsOf({}).DEFAULT_BUDGET).toEqual({ agents: 12, tokens: 400000, wallMinutes: 40 });
    expect(budgetsOf({ budget: { agents: 3 } }).taskBudget).toEqual({ agents: 3, tokens: 400000, wallMinutes: 40 });
    expect(source).toMatch(/const DEFAULT_BUDGET = \{ agents: 12, tokens: 400000, wallMinutes: 40 \}/);

    const { fingerprint, matchFinding, ledgerText, LEDGER_CHAR_BUDGET } = ledgerModule();
    // However many open findings a long task collects, the rendered ledger stays inside its character budget.
    const long = "x".repeat(4000);
    const many = [];
    for (let i = 1; i <= 30; i++) {
      many.push({ id: `F${i}`, stage: "verify", invariant: "verification", severity: "blocker", file: "src/x.ts", line: i, description: long, evidence: long, status: i > 25 ? "fixed" : "open", openedPass: 1, fixedPass: 2, fixedCommit: "abcdef1234567", confirmedBy: "check", reappeared: false });
    }
    expect(ledgerText(many).length).toBeLessThanOrEqual(LEDGER_CHAR_BUDGET);
    expect(ledgerText(many)).toContain("F1 [verify/verification]");
    // The budget covers the whole ledger, not each section: a prompt that prints the open and the fixed part
    // under separate headings still spends no more than the cap on the two together.
    expect(ledgerText(many, "open").length + ledgerText(many, "fixed").length).toBeLessThanOrEqual(LEDGER_CHAR_BUDGET);

    expect(fingerprint("verify", "./src/x.ts", "Returns   1, expected 2   at src/x.ts:31")).toBe(fingerprint("verify", "src/x.ts", "returns 1, expected 2 at src/x.ts:47"));
    expect(fingerprint("verify", "src/x.ts", "returns 1")).not.toBe(fingerprint("check", "src/x.ts", "returns 1"));
    const ledger = [
      { id: "F1", fingerprint: fingerprint("verify", "src/x.ts", "returns 1"), status: "open" },
      { id: "F2", fingerprint: fingerprint("adversary", "src/y.ts", "deletes the cache"), status: "open" },
    ];
    // An explicit id prefix wins, even from another stage and another file.
    expect(matchFinding(ledger, { stage: "adversary", file: "src/y.ts", description: "F1: still returns 1" }).id).toBe("F1");
    expect(matchFinding(ledger, { stage: "verify", file: "./src/x.ts", description: "Returns 1" }).id).toBe("F1");
    expect(matchFinding(ledger, { stage: "check", file: "src/x.ts", description: "returns 1" })).toBeNull();
  });

  it("reads the budget primitive without ever throwing and calls only an unstopped task a success", () => {
    const spendWith = (b) => new Function("budget", fnSlice("function runtimeSpend(") + "\nreturn runtimeSpend();")(b);
    expect(spendWith(undefined)).toEqual({ tokens: null, elapsedMs: null });
    expect(spendWith({ spent: 120, elapsedMs: 5000 })).toEqual({ tokens: 120, elapsedMs: 5000 });
    expect(spendWith({ total: 900, remaining: 400 })).toEqual({ tokens: 500, elapsedMs: null });
    expect(spendWith({ spent: "lots", elapsedMs: Infinity })).toEqual({ tokens: null, elapsedMs: null });
    // A primitive whose reads throw - a getter, a proxy - reports nothing rather than tearing down the run.
    const thrower = () => { throw new Error("no reading that"); };
    expect(spendWith(new Proxy({}, { get: thrower }))).toEqual({ tokens: null, elapsedMs: null });
    expect(spendWith({ get spent() { thrower(); }, get total() { thrower(); }, get remaining() { thrower(); }, get elapsedMs() { thrower(); } })).toEqual({ tokens: null, elapsedMs: null });

    // Success is what the loop let through: a stopped task never reached integration, however its stage booleans read.
    const taskSucceeded = new Function(fnSlice("function taskSucceeded(") + "\nreturn taskSucceeded;")();
    const through = { stopReason: null, implemented: true, verified: true, reviewed: true, adversary: { ran: true, blocked: false } };
    expect(taskSucceeded(through)).toBe(true);
    expect(taskSucceeded({ ...through, stopReason: "a fixed finding reappeared: F1" })).toBe(false);
    expect(taskSucceeded({ ...through, stopReason: "verification failed; fix attempts exhausted (5 of 5)" })).toBe(false);
    expect(taskSucceeded({ ...through, adversary: { ran: true, blocked: true } })).toBe(false);
    // A run paused at a human gate has levels still to run, so it is not ok either.
    expect(source).toMatch(/report\.ok = report\.stoppedAtLevel === undefined && !report\.paused && report\.levels\.every\(l => l\.tasks\.every\(taskSucceeded\)\)/);
  });

  it("ledgers a blocker the check raises on an otherwise passing run", () => {
    const { stageFindings, updateLedger } = ledgerModule();
    // The projected reviewer refuses to approve a check that carries a blocker issue or leaves the owned list,
    // so both have to reach the ledger; reading only `passed` would hide them from the next fix pass.
    const withIssue = { passed: true, commandsRun: [], acceptance: [], findings: [], inScope: true, issues: [{ severity: "blocker", file: "src/x.ts", line: 9, description: "the retry loop still drops the last error", evidence: "src/x.ts:9" }] };
    // A check issue grows a `paths` key (card ledger-ignores-not-a-defect-notes, round 2 rule 2): the ledger's file
    // rule reads it instead of `file` alone. Collateral shape change, not a bent expectation.
    expect(stageFindings({ stageResults: { check: withIssue } }, "check")).toEqual([
      { stage: "check", blocking: true, severity: "blocker", invariant: "verification", file: "src/x.ts", line: 9, description: "the retry loop still drops the last error", evidence: "src/x.ts:9", paths: ["src/x.ts"] },
    ]);

    const ledger = [];
    const r = { stages: ["fix", "check"], commit: "c2", stageResults: { check: withIssue } };
    expect(updateLedger(ledger, r, 2, true).opened).toEqual(["F1"]);
    expect(ledger[0]).toMatchObject({ id: "F1", stage: "check", status: "open", openedPass: 2, severity: "blocker" });

    // Out-of-scope files block the same way, and carry the check's findings into the ledger with them.
    const outOfScope = { passed: true, commandsRun: [], acceptance: [], findings: ["touched packages/other/y.ts"], inScope: false, issues: [] };
    expect(stageFindings({ stageResults: { check: outOfScope } }, "check")[0].blocking).toBe(true);

    // A genuinely clean check still opens nothing and confirms what was open.
    const clean = { passed: true, commandsRun: [], acceptance: [], findings: [], inScope: true, issues: [{ severity: "minor", description: "a nit" }] };
    expect(stageFindings({ stageResults: { check: clean } }, "check").every((f) => !f.blocking)).toBe(true);
    const res = updateLedger(ledger, { stages: ["fix", "check"], commit: "c3", stageResults: { check: clean } }, 3, true);
    expect(res.opened).toEqual([]);
    expect(res.fixed).toEqual(["F1"]);
  });

  it("a fail verdict blocks only with a blocker issue, or with no issue at all (card fix-loop-minor-verdict)", () => {
    const { stageFindings } = ledgerModule();
    // A blocker issue blocks exactly as before, and only that issue is marked blocking.
    const withBlocker = { ran: true, verdict: "fail", summary: "off by one", issues: [{ severity: "blocker", file: "src/x.ts", line: 3, description: "returns 1", evidence: "node -e ... exit 1" }] };
    expect(stageFindings({ stageResults: { adversary: withBlocker } }, "adversary")).toEqual([
      { stage: "adversary", blocking: true, severity: "blocker", invariant: "spec", file: "src/x.ts", line: 3, description: "returns 1", evidence: "node -e ... exit 1" },
    ]);
    // A fail verdict with only major or minor issues (a text-format nit, a boolean coercion) is pass-with-notes:
    // the issues are kept, unblocking, and no summary finding is synthesized on top of them.
    const minorOnly = { ran: true, verdict: "fail", summary: "a text-format nit", issues: [{ severity: "minor", file: "src/x.ts", description: "prefer const" }] };
    expect(stageFindings({ stageResults: { adversary: minorOnly } }, "adversary")).toEqual([
      { stage: "adversary", blocking: false, severity: "minor", invariant: "spec", file: "src/x.ts", line: null, description: "prefer const", evidence: null },
    ]);
    // An empty issues array still blocks, exactly as before: the only case that leaves the fix loop nothing to
    // act on, so a blocker finding is synthesized from the summary.
    const emptyIssues = { ran: true, verdict: "fail", summary: "could not refute the change but failed it anyway", issues: [] };
    expect(stageFindings({ stageResults: { adversary: emptyIssues } }, "adversary")).toEqual([
      { stage: "adversary", blocking: true, severity: "blocker", invariant: "spec", file: "", line: null, description: "could not refute the change but failed it anyway", evidence: null },
    ]);
  });

  it("reads what a finding that starts with an id says about it", () => {
    const { idReport, confirmsFinding } = ledgerModule();
    expect(idReport("F1 is FIXED. src/generate/agents.ts:53 now quotes the description")).toEqual({ id: "F1", verdict: "fixed" });
    expect(idReport("F1 [adversary/spec] blocker at agents.ts:53 is FIXED. The fix delta changes one line")).toEqual({ id: "F1", verdict: "fixed" });
    expect(idReport("F3 fixed: the npm-bare paths are asserted")).toEqual({ id: "F3", verdict: "fixed" });
    expect(idReport("F2: no longer returns 1 on the empty input")).toEqual({ id: "F2", verdict: "fixed" });
    expect(idReport("F3: still returns 1")).toEqual({ id: "F3", verdict: "open" });
    expect(idReport("F3 is not fixed; the empty input still returns 1")).toEqual({ id: "F3", verdict: "open" });
    expect(idReport("F3 partially fixed: the colon case only")).toEqual({ id: "F3", verdict: "open" });
    expect(idReport("F3: the description wording")).toEqual({ id: "F3", verdict: null });
    expect(idReport("Fixed the description")).toBeNull();
    expect(idReport("returns 1, expected 2")).toBeNull();
    // A stage that says fixed confirms whatever its own verdict was; a passing stage's free-text finding that names
    // an id confirms unless it says the finding is open; a re-report at any severity never confirms.
    expect(confirmsFinding({ description: "F1 is FIXED. quoted now", blocking: true })).toBe(true);
    expect(confirmsFinding({ description: "F1: the empty input still reads oddly", confirms: true })).toBe(false);
    expect(confirmsFinding({ description: "F1: the description wording", confirms: true })).toBe(true);
    expect(confirmsFinding({ description: "F1: the description wording", blocking: false })).toBe(false);
    expect(confirmsFinding({ description: "F1: still returns 1", blocking: false })).toBe(false);
  });

  it("does not reopen a fixed finding when a passing check names it as fixed (run wf_7092b963-6a5)", async () => {
    // Pass 1: the adversary blocks. Pass 2: the fix lands, the confirmation adversary passes, and the check that
    // follows passes while listing "F1 is FIXED" among its findings. The entry stays fixed and the task is ready.
    const { agent, calls } = scripted({
      "implement:a": () => implResult,
      "verify:a": () => ({ taskId: "a", passed: true, findings: [] }),
      "review:a": () => passingReview,
      "check:a": () => ({ ...passingCheck, findings: ["F1 is FIXED. The fix delta (c1..c2) adds the npm-bare case asserting the exact four paths.", "Verify command passed: exit 0, 11/11 tests."] }),
      "fix:a": () => ({ ...implResult, commit: "c2" }),
      "adversary:a": (i) =>
        i === 0
          ? { taskId: "a", ran: true, verdict: "fail", summary: "coverage incomplete", issues: [{ severity: "blocker", file: "src/x.ts", line: 49, description: "npm-bare never has its paths asserted", evidence: "static inspection" }], commandsRun: [], error: null }
          : { taskId: "a", ran: true, verdict: "pass", summary: "F1 is fixed: npm-bare path/order is asserted.", issues: [], commandsRun: [], error: null },
    });
    const r = await loadLoop({ agent, fixAttempts: 3, adversary: { command: "x", timeoutMs: 1 } }).runTask(task, "main");
    expect(r.attempts[1].stages).toEqual(["fix", "adversary", "check"]);
    expect(r.attempts[1].fixedFindings).toEqual(["F1"]);
    expect(r.attempts[1].ready).toBe(true);
    expect(r.ledger.map((e) => [e.id, e.status, e.confirmedBy, e.reappeared])).toEqual([["F1", "fixed", "adversary", false]]);
    expect(r.stopReason).toBeNull();
    expect(labelled(calls, "fix:").length).toBe(1);
  });

  it("lets later stages confirm a finding a passing verifier named as fixed (run wf_f70da515-2af)", () => {
    const { updateLedger } = ledgerModule();
    const ledger = [
      { id: "F1", fingerprint: "adversary|src/x.ts|descriptions are emitted as unquoted yaml scalars", stage: "adversary", invariant: "spec", severity: "blocker", file: "src/x.ts", line: 53, description: "Descriptions are emitted as unquoted YAML scalars", evidence: "Psych::SyntaxError", status: "open", openedPass: 1, fixedPass: null, fixedCommit: null, confirmedBy: null, reappeared: true },
    ];
    // Pass 3 of that run: the verifier passed and opened its findings with "F1 is FIXED", the check passed, and the
    // confirmation adversary passed. The verifier does not cover an adversary finding, but it must not stop the
    // check from confirming it either.
    const r = {
      stages: ["fix", "verify", "check", "adversary"],
      commit: "c3",
      stageResults: {
        verify: { passed: true, findings: ["F1 is FIXED. src/x.ts:53 now emits a quoted scalar.", "Acceptance criterion 4 waits on the docs task."], acceptance: [] },
        check: { passed: true, commandsRun: [], acceptance: [], findings: [], inScope: true, issues: [] },
        adversary: { ran: true, verdict: "pass", summary: "F1 is fixed", issues: [], commandsRun: [], error: null },
      },
    };
    const u = updateLedger(ledger, r, 3, true);
    // updateLedger's return grows a fourth key, `dropped` (card ledger-ignores-not-a-defect-notes). Round 2 rule 6
    // partitions dropped findings before the confirms-filter, so the passing verifier's own "waits on the docs
    // task" note (it names no path, so the clause still applies) is now recorded as a dropped note; "F1 is FIXED"
    // still confirms F1 by id (rule 4), so it is never a candidate for dropping.
    expect(u).toEqual({ opened: [], fixed: ["F1"], reopened: [], dropped: [{ stage: "verify", file: "", description: "Acceptance criterion 4 waits on the docs task.", why: "not-a-defect" }] });
    expect(ledger[0]).toMatchObject({ status: "fixed", fixedPass: 3, fixedCommit: "c3", confirmedBy: "check" });
  });

  it("still reopens and keeps entries on a real re-report", () => {
    const { updateLedger } = ledgerModule();
    const fixedEntry = () => ({ id: "F1", fingerprint: "verify|src/x.ts|returns 1 expected 2", stage: "verify", invariant: "verification", severity: "blocker", file: "src/x.ts", line: 3, description: "returns 1, expected 2", evidence: "got 1", status: "fixed", openedPass: 1, fixedPass: 2, fixedCommit: "c2", confirmedBy: "check", reappeared: false });
    // A failing check that names the id reopens it.
    let ledger = [fixedEntry()];
    let u = updateLedger(ledger, { stages: ["fix", "check"], commit: "c3", stageResults: { check: { passed: false, commandsRun: [], acceptance: [], findings: ["F1: still returns 1 on the empty input"], inScope: true, issues: [] } } }, 3, true);
    expect(u.reopened).toEqual(["F1"]);
    expect(ledger[0]).toMatchObject({ status: "open", reappeared: true, fixedPass: null });
    // So does a passing check whose free-text finding says the finding is still open.
    ledger = [fixedEntry()];
    u = updateLedger(ledger, { stages: ["fix", "check"], commit: "c3", stageResults: { check: { passed: true, commandsRun: [], acceptance: [], findings: ["F1: still returns 1 on the empty input"], inScope: true, issues: [] } } }, 3, true);
    expect(u.reopened).toEqual(["F1"]);
    // A failing verifier that confirms F1 fixed and reports something else opens the new finding only.
    ledger = [fixedEntry()];
    u = updateLedger(ledger, { stages: ["fix", "verify"], commit: "c3", stageResults: { verify: { passed: false, findings: ["F1 fixed: returns 2 now", "src/y.ts throws on null input"], acceptance: [] } } }, 3, true);
    // Same return-shape change as above (card ledger-ignores-not-a-defect-notes, not a bent expectation): neither
    // finding here is dropped, so dropped is [].
    expect(u).toEqual({ opened: ["F2"], fixed: [], reopened: [], dropped: [] });
    expect(ledger.map((e) => [e.id, e.status])).toEqual([["F1", "fixed"], ["F2", "open"]]);
  });

  describe("ledger drops not-a-defect and out-of-scope notes (card ledger-ignores-not-a-defect-notes)", () => {
    // Fixture finding texts below are the ledger-relevant lines from three /doug-next run reports named in the
    // card's brief (wf_5e92c034-5b4, wf_9fec46f1-44b, wf_7e44dc78-ed6), copied here as literals; the tester never
    // reads the run records under the home directory at test time.

    it("T1 (wf_5e92c034-5b4): a not-a-defect note about a sibling's file is dropped by the text rule, the same note reworded without the phrases is dropped by the file rule, real findings on owned files still open, and a clean pass 2 clears the ledger without a stall [Shape #1 text+file rules, #2 dropped key, #3 no stall]", () => {
      const { updateLedger } = ledgerModule();
      const task = { id: "setup-script", files: ["scripts/setup.sh", "tests/setup-script.test.mjs"] };
      const f1 = "tests/setup-script.test.mjs: Test case (e) is a false pass: the empty-input branch is asserted against the wrong exit code.";
      const f2 = "Acceptance commands 4 (docs/onboarding.md greps, exit 2 — file does not exist) and 5 (README.md greps, exit 1) fail. They check files this task does not own (docs/onboarding.md, README.md); they wait on the onboarding-docs task and do not fail this task.";
      const f3 = "scripts/setup.sh: Everything else verified by execution and matches the spec: scripts/setup.sh is committed mode 100755 and the shebang is #!/usr/bin/env bash.";
      const ledger = [];
      const r = { task, stages: ["verify"], commit: "c1", stageResults: { verify: { passed: false, findings: [f1, f2, f3], acceptance: [] } } };
      const u = updateLedger(ledger, r, 1, true);
      // Text rule fires first: F2 waits on a sibling task, so it is dropped before the file rule is ever checked.
      expect(u.opened).toEqual(["F1", "F2"]);
      expect(ledger.map((e) => [e.id, e.description])).toEqual([["F1", f1], ["F2", f3]]);
      expect(u.dropped).toEqual([{ stage: "verify", file: "docs/onboarding.md", description: f2, why: "not-a-defect" }]);

      // Same acceptance-boundary note, reworded without any of the card's phrases: it still drops, now on the
      // file rule, because docs/onboarding.md is outside this task's owned files (a sibling's file).
      const f2b = "Acceptance commands 4 and 5 fail on docs/onboarding.md and README.md.";
      const ledgerB = [];
      const rB = { task, stages: ["verify"], commit: "c1", stageResults: { verify: { passed: false, findings: [f1, f2b, f3], acceptance: [] } } };
      const uB = updateLedger(ledgerB, rB, 1, true);
      expect(uB.dropped).toEqual([{ stage: "verify", file: "docs/onboarding.md", description: f2b, why: "outside-owned-files" }]);

      // Pass 2: a clean verify (no findings) fixes both open entries; the dropped note never counted toward
      // openFindings, reopened, or a stall - nothing keeps the task out now.
      const r2 = { task, stages: ["verify"], commit: "c2", stageResults: { verify: { passed: true, findings: [], acceptance: [] } } };
      const u2 = updateLedger(ledger, r2, 2, true);
      expect(u2.fixed).toEqual(["F1", "F2"]);
      expect(u2.dropped).toEqual([]);
      expect(ledger.filter((e) => e.status === "open")).toEqual([]);
    });

    it("T2 (wf_9fec46f1-44b): three 'holds'/'not charged' notes are dropped while the real findings - including two with no file in the text - still open [Shape #1 text rule]", () => {
      const { updateLedger } = ledgerModule();
      const task = { id: "onboarding-docs", files: ["docs/onboarding.md", "README.md"] };
      const f1 = "README.md: the new `## Onboarding` section is not placed after the `## Install` section, it is spliced into the middle of it ...";
      const f2 = "Acceptance criterion 'Running scripts/setup.sh changes nothing outside the repository ...' has no $ command and covers scripts/setup.sh, which task setup-script owns (not in this task's owned list docs/onboarding.md, README.md). Exercised indirectly: ... Not charged against this task.";
      const f3 = "Acceptance criterion 'Every step in docs/onboarding.md states both what it writes and what it never does' holds: the four numbered steps ...";
      const f4 = "Acceptance criterion 'docs/live-runs.md is unchanged by this plan' holds: `git diff --stat ...` is empty ...";
      const f5 = "Every factual claim in docs/onboarding.md checks out against scripts/setup.sh (...)";
      const f6 = "Test integrity: the diff touches no test file and no source file; nothing skipped, weakened, or deleted. Commit 7784ede carries no attribution trailer.";
      const ledger = [];
      const r = { task, stages: ["check"], commit: "c1", stageResults: { check: { passed: false, commandsRun: [], acceptance: [], findings: [f1, f2, f3, f4, f5, f6], inScope: true, issues: [] } } };
      const u = updateLedger(ledger, r, 1, true);
      // Card ledger-check-notes-as-blockers: the new check-note rule runs right after the id exemption, before
      // this card's own text rules, and reads the finding's raw text (not the criterion-quote-stripped text those
      // rules use). F1 ("is not placed") and F3 (its quoted criterion name contains 'never', so the raw text still
      // carries a failure word even though that 'never' sits inside the span CRITERION_HOLDS later strips) still
      // reach their pre-existing rules unchanged. F4's quoted criterion name carries no failure word at all, so it
      // is now dropped earlier, as 'check-note' rather than 'not-a-defect' - the same drop, a different why. F5
      // ("checks out") and F6 ("Test integrity" ... "nothing skipped, weakened, or deleted") are check-stage notes
      // that report no failure - exactly the shape that card's rule drops - so what used to open as F2/F3 (under
      // the old rule list alone, before that card) is now dropped instead.
      expect(u.opened).toEqual(["F1"]);
      expect(ledger.map((e) => [e.id, e.description, e.file])).toEqual([
        ["F1", f1, ""],
      ]);
      expect(u.dropped).toEqual([
        { stage: "check", file: "scripts/setup.sh", description: f2, why: "not-a-defect" },
        { stage: "check", file: "docs/onboarding.md", description: f3, why: "not-a-defect" },
        { stage: "check", file: "docs/live-runs.md", description: f4, why: "check-note" },
        { stage: "check", file: "docs/onboarding.md", description: f5, why: "check-note" },
        { stage: "check", file: "", description: f6, why: "check-note" },
      ]);
    });

    it("T3 (wf_7e44dc78-ed6): 'Not a defect, for the record' on an owned file is dropped; the real finding still opens [Shape #1 text rule]", () => {
      const { updateLedger } = ledgerModule();
      const task = { id: "setup-script", files: ["scripts/setup.sh", "tests/setup-script.test.mjs"] };
      const f1 = "tests/setup-script.test.mjs: assertion on stderr is missing; the script's error path is never exercised.";
      const f3 = "Not a defect, for the record: scripts/setup.sh itself matches the spec in every branch when exercised directly (...)";
      const ledger = [];
      const r = { task, stages: ["verify"], commit: "c1", stageResults: { verify: { passed: false, findings: [f1, f3], acceptance: [] } } };
      const u = updateLedger(ledger, r, 1, true);
      expect(u.opened).toEqual(["F1"]);
      expect(ledger.map((e) => [e.id, e.description])).toEqual([["F1", f1]]);
      expect(u.dropped).toEqual([{ stage: "verify", file: "scripts/setup.sh", description: f3, why: "not-a-defect" }]);
    });

    it("T4: a review issue outside the owned files still opens when the reviewer marked it out-of-scope drift (invariant 'scope'), but the identical issue at 'quality' severity is dropped by the file rule [Shape #1 file rule + review-scope exemption]", () => {
      const { updateLedger } = ledgerModule();
      const task = { id: "a", files: ["src/x.ts"] };
      const issue = { severity: "blocker", file: "packages/other/y.ts", description: "changed a file outside the owned list" };
      const scoped = { task, stages: ["review"], commit: "c1", stageResults: { review: { specCompliant: true, inScope: false, approve: false, issues: [issue] } } };
      const ledger1 = [];
      const u1 = updateLedger(ledger1, scoped, 1, true);
      expect(u1.opened).toEqual(["F1"]);
      expect(ledger1[0].invariant).toBe("scope");
      expect(u1.dropped).toEqual([]);

      const unscoped = { task, stages: ["review"], commit: "c1", stageResults: { review: { specCompliant: true, inScope: true, approve: false, issues: [issue] } } };
      const ledger2 = [];
      const u2 = updateLedger(ledger2, unscoped, 1, true);
      expect(u2.opened).toEqual([]);
      expect(u2.dropped).toEqual([{ stage: "review", file: "packages/other/y.ts", description: issue.description, why: "outside-owned-files" }]);
    });

    it("T5: an id-prefixed confirmation is exempt from the text rule (even though its own wording says 'holds'), and 'holds' used as a verb - not followed by punctuation or the end - never drops a brand-new finding [Shape #1 id-report exemption, 'holds' lookahead]", () => {
      const { updateLedger } = ledgerModule();
      const task = { id: "a", files: ["src/x.ts"] };
      const ledger = [
        { id: "F1", fingerprint: "verify|src/x.ts|returns 1 expected 2", stage: "verify", invariant: "verification", severity: "blocker", file: "src/x.ts", line: 3, description: "returns 1, expected 2", evidence: "got 1", status: "open", openedPass: 1, fixedPass: null, fixedCommit: null, confirmedBy: null, reappeared: false },
      ];
      // Round 2 rule 4: the id exemption now fires for "whatever the verdict", checked before the confirms
      // filter, not only for verdict 'fixed'/'open' checked after it as in round 1. "F1 fixed: ..." still has
      // verdict 'fixed', so it is exempt from the text rule either way and dropped stays [] here; T10 below pins
      // the verdict-null case (e.g. "F1: the deadlock holds.") that only the widened rule 4 exemption reaches.
      const r1 = { task, stages: ["verify"], commit: "c2", stageResults: { verify: { passed: true, findings: ["F1 fixed: the criterion holds now"], acceptance: [] } } };
      const u1 = updateLedger(ledger, r1, 2, true);
      expect(u1.fixed).toEqual(["F1"]);
      expect(u1.dropped).toEqual([]);

      const ledger2 = [];
      const r2 = { task, stages: ["verify"], commit: "c3", stageResults: { verify: { passed: false, findings: ["src/x.ts: the mutex holds the file handle open after close()"], acceptance: [] } } };
      const u2 = updateLedger(ledger2, r2, 1, true);
      expect(u2.opened).toEqual(["F1"]);
      expect(u2.dropped).toEqual([]);
    });

    it("T6: through the fix loop, a dropped note lands on the attempt as a note, never as a finding, and never blocks convergence [Shape #3 attempt notes]", async () => {
      const { agent } = scripted({
        "implement:a": () => implResult,
        "verify:a": (i) =>
          i === 0
            ? { taskId: "a", passed: false, findings: ["src/x.ts returns 1, expected 2", "lib/other.mjs: this criterion waits on the b task."] }
            : { taskId: "a", passed: true, findings: [] },
        "review:a": () => passingReview,
        "check:a": () => passingCheck,
        "fix:a": () => ({ ...implResult, commit: "c2" }),
      });
      const r = await loadLoop({ agent, fixAttempts: 2 }).runTask(task, "main");
      expect(r.attempts[0].newFindings).toEqual(["F1"]);
      expect(r.attempts[0].notes).toEqual([
        { stage: "verify", file: "lib/other.mjs", description: "lib/other.mjs: this criterion waits on the b task.", why: "not-a-defect" },
      ]);
      expect(r.stopReason).toBeNull();
    });

    // Round 2: the reviewer's pass-1 findings against the real section (B1 blocker, MAJ1-4, MIN1-2).

    it("T7 (B1): the owned check uses samePath, so a verifier's shortened form of an owned path is not outside; a passing check with a blocker issue on that same file still opens it - the integrate-anyway path is closed [Round 2 rule 1 samePath]", () => {
      const { updateLedger } = ledgerModule();
      const task = { id: "g", files: ["plugins/doug-gates/lib/secret-rules.mjs"] };
      const f1 = "lib/secret-rules.mjs: the secret regex misses AWS keys, so the gate passes a leaked key.";
      const ledger = [];
      const r = { task, stages: ["verify"], commit: "c1", stageResults: { verify: { passed: false, findings: [f1], acceptance: [] } } };
      const u = updateLedger(ledger, r, 1, true);
      expect(u.opened).toEqual(["F1"]);
      expect(u.dropped).toEqual([]);

      const ledger2 = [];
      const r2 = { task, stages: ["check"], commit: "c1", stageResults: { check: { passed: true, commandsRun: [], acceptance: [], findings: [], inScope: true, issues: [{ severity: "blocker", file: "lib/secret-rules.mjs", description: "the secret regex misses AWS keys", evidence: null }] } } };
      const u2 = updateLedger(ledger2, r2, 1, true);
      expect(u2.opened).toEqual(["F1"]);
    });

    it("T8 (MAJ2): the file rule reads every path a finding names, not just findingFile's first match, so an owned path named second in the prose is not dropped; a findingFiles entry for that finding overrides the prose paths entirely [Round 2 rule 2 paths]", () => {
      const { updateLedger } = ledgerModule();
      const task = { id: "a", files: ["src/x.ts"] };
      const text = "Compared against docs/spec.md, src/x.ts returns 1 where the spec requires 2.";

      let ledger = [];
      let u = updateLedger(ledger, { task, stages: ["verify"], commit: "c1", stageResults: { verify: { passed: false, findings: [text], acceptance: [] } } }, 1, true);
      expect(u.opened).toEqual(["F1"]);
      expect(u.dropped).toEqual([]);

      ledger = [];
      u = updateLedger(ledger, { task, stages: ["verify"], commit: "c1", stageResults: { verify: { passed: false, findings: [text], findingFiles: [{ finding: text, files: ["docs/spec.md"] }], acceptance: [] } } }, 1, true);
      expect(u.dropped).toEqual([{ stage: "verify", file: "docs/spec.md", description: text, why: "outside-owned-files" }]);

      ledger = [];
      u = updateLedger(ledger, { task, stages: ["verify"], commit: "c1", stageResults: { verify: { passed: false, findings: [text], findingFiles: [{ finding: text, files: ["src/x.ts"] }], acceptance: [] } } }, 1, true);
      expect(u.opened).toEqual(["F1"]);
      expect(u.dropped).toEqual([]);
    });

    it("T9 (MAJ3): 'waits on' only reads as the plan-task sense when none of the finding's paths are owned, and 'holds' only fires as a criterion verdict, so a handler that itself waits, a stale lock that holds, and a deadlock that still holds - all on the owned file - stay real findings; the same wordings on an unowned or path-less note still drop [Round 2 rule 5b/5c]", () => {
      const { updateLedger } = ledgerModule();
      const task = { id: "a", files: ["src/x.ts"] };
      const texts = [
        "src/x.ts: the request handler waits on the cleanup task and the process never exits.",
        "src/x.ts: the stale lock holds, so the second writer never proceeds.",
        "src/x.ts: after the retry the deadlock still holds.",
      ];
      const ledger = [];
      const r = { task, stages: ["verify"], commit: "c1", stageResults: { verify: { passed: false, findings: texts, acceptance: [] } } };
      const u = updateLedger(ledger, r, 1, true);
      expect(u.opened).toEqual(["F1", "F2", "F3"]);
      expect(u.dropped).toEqual([]);

      const criterionText = "Acceptance criterion 'docs/onboarding.md lists every step' holds: all four steps present.";
      let ledger2 = [];
      let u2 = updateLedger(ledger2, { task, stages: ["verify"], commit: "c1", stageResults: { verify: { passed: false, findings: [criterionText], acceptance: [] } } }, 1, true);
      expect(u2.dropped).toEqual([{ stage: "verify", file: "docs/onboarding.md", description: criterionText, why: "not-a-defect" }]);

      const noPathText = "Acceptance criterion 4 waits on the docs task.";
      ledger2 = [];
      u2 = updateLedger(ledger2, { task, stages: ["verify"], commit: "c1", stageResults: { verify: { passed: false, findings: [noPathText], acceptance: [] } } }, 1, true);
      expect(u2.dropped).toEqual([{ stage: "verify", file: "", description: noPathText, why: "not-a-defect" }]);
    });

    it("T10 (MAJ1): the id exemption reaches a re-report whose verdict is null too ('the deadlock holds.', 'the criterion holds: nothing changed.'), so it can never confirm its own open entry by absence; a real reopening ('F2 still fails ...') still works [Round 2 rule 4 id exemption 'whatever the verdict']", () => {
      const { updateLedger } = ledgerModule();
      const task = { id: "a", files: ["src/x.ts"] };
      const open = (id) => ({ id, fingerprint: `verify|src/x.ts|${id} placeholder`, stage: "verify", invariant: "verification", severity: "blocker", file: "src/x.ts", line: 3, description: `${id} placeholder finding`, evidence: null, status: "open", openedPass: 1, fixedPass: null, fixedCommit: null, confirmedBy: null, reappeared: false });

      let ledger = [open("F1")];
      let u = updateLedger(ledger, { task, stages: ["verify"], commit: "c2", stageResults: { verify: { passed: false, findings: ["F1: the deadlock holds."], acceptance: [] } } }, 2, true);
      expect(ledger[0].status).toBe("open");
      expect(u.fixed).toEqual([]);
      expect(u.dropped).toEqual([]);

      ledger = [open("F2")];
      u = updateLedger(ledger, { task, stages: ["verify"], commit: "c2", stageResults: { verify: { passed: false, findings: ["F2: the criterion holds: nothing changed."], acceptance: [] } } }, 2, true);
      expect(ledger[0].status).toBe("open");
      expect(u.fixed).toEqual([]);
      expect(u.dropped).toEqual([]);

      ledger = [open("F2")];
      u = updateLedger(ledger, { task, stages: ["verify"], commit: "c2", stageResults: { verify: { passed: false, findings: ["F2 still fails; the note above was not a defect."], acceptance: [] } } }, 2, true);
      expect(ledger[0].status).toBe("open");
      expect(u.dropped).toEqual([]);
    });

    it("T11 (the .doug/.claude exemption): a note naming a path under .doug/ or .claude/ is never outside the owned files, even though the task owns something else entirely [unpinned mechanism, already correct]", () => {
      const { updateLedger } = ledgerModule();
      const task = { id: "a", files: ["src/x.ts"] };
      let ledger = [];
      let u = updateLedger(ledger, { task, stages: ["verify"], commit: "c1", stageResults: { verify: { passed: false, findings: ["the plan in .doug/plan.json names a file the task does not own"], acceptance: [] } } }, 1, true);
      expect(u.opened).toEqual(["F1"]);
      expect(u.dropped).toEqual([]);

      ledger = [];
      u = updateLedger(ledger, { task, stages: ["verify"], commit: "c1", stageResults: { verify: { passed: false, findings: ["the setting in .claude/settings.json names a file the task does not own"], acceptance: [] } } }, 1, true);
      expect(u.opened).toEqual(["F1"]);
      expect(u.dropped).toEqual([]);
    });

    it("T12 (MIN2): an adversary blocker on a file outside the owned list is never dropped, by the file rule or the text rule - the card is about the verifier's and checker's own notes, not the adversary's [Round 2 rule 3 adversary exempt]", () => {
      const { updateLedger } = ledgerModule();
      const task = { id: "a", files: ["src/x.ts"] };
      const adv = (description) => ({ task, stages: ["adversary"], commit: "c1", stageResults: { adversary: { ran: true, verdict: "fail", summary: "s", issues: [{ severity: "blocker", file: "packages/other/y.ts", description, evidence: null }], commandsRun: [], error: null } } });

      let ledger = [];
      let u = updateLedger(ledger, adv("deletes the cache"), 1, true);
      expect(u.opened).toEqual(["F1"]);
      expect(u.dropped).toEqual([]);

      ledger = [];
      u = updateLedger(ledger, adv("not a defect: it only deletes a fixture the sandbox recreates"), 1, true);
      expect(u.opened).toEqual(["F1"]);
      expect(u.dropped).toEqual([]);
    });

    it("T13 (the fix-pass notes site): through the fix loop, a fix pass that makes no new commit still carries `notes` as an array on its own attempt - the site the reviewer found unpinned [Round 2 rule 7]", async () => {
      const { agent } = scripted({
        "implement:a": () => implResult,
        "verify:a": () => ({ taskId: "a", passed: false, findings: ["src/x.ts returns 1, expected 2"] }),
        "review:a": () => passingReview,
        "check:a": () => passingCheck,
        "fix:a": () => ({ ...implResult, summary: "nothing to do", commit: "c1" }),
      });
      const r = await loadLoop({ agent, fixAttempts: 3 }).runTask(task, "main");
      const last = r.attempts[r.attempts.length - 1];
      expect(last.stages).toEqual(["fix"]);
      expect(Array.isArray(last.notes)).toBe(true);
    });

    it("T14 (MIN1): a passing stage's own not-a-defect note is recorded as a dropped note too, not silently discarded before droppedWhy ever sees it [Round 2 rule 6 partition before the confirms filter]", () => {
      const { updateLedger } = ledgerModule();
      const task = { id: "a", files: ["src/x.ts"] };
      const note = "Acceptance criterion 4 waits on the docs task.";
      const ledger = [];
      const r = { task, stages: ["verify"], commit: "c1", stageResults: { verify: { passed: true, findings: [note], acceptance: [] } } };
      const u = updateLedger(ledger, r, 1, true);
      expect(u).toEqual({ opened: [], fixed: [], reopened: [], dropped: [{ stage: "verify", file: "", description: note, why: "not-a-defect" }] });
    });

    // Round 3: the reviewer's pass-2 findings against the round-2 section (two residual majors, two of the minors).

    it("T15 (MAJ1 criterion-failure guard): a criterion FAILURE report is real even though it also says 'holds' - the failure-word guard keeps a failing criterion out of the not-a-defect rule; a genuine 'the criterion ... holds:' with no failure word still drops [Round 3 rule 5 failure-word guard]", () => {
      const { updateLedger } = ledgerModule();
      const task = { id: "a", files: ["src/x.ts"] };
      const texts = [
        "Acceptance criterion 3 (mutex released) fails: the mutex still holds.",
        "src/x.ts: acceptance criterion 2 fails because the writer lock holds, blocking the consumer.",
        "src/x.ts: the criterion that the cache never grows unbounded no longer holds.",
        "Acceptance criterion 2 (the queue drains) fails\nthe writer lock holds, so the consumer never wakes",
      ];
      const ledger = [];
      const r = { task, stages: ["verify"], commit: "c1", stageResults: { verify: { passed: false, findings: texts, acceptance: [] } } };
      const u = updateLedger(ledger, r, 1, true);
      expect(u.opened).toEqual(["F1", "F2", "F3", "F4"]);
      expect(u.dropped).toEqual([]);

      const criterionText = "Acceptance criterion 'docs/onboarding.md lists every step' holds: all four steps present.";
      const ledger2 = [];
      const u2 = updateLedger(ledger2, { task, stages: ["verify"], commit: "c1", stageResults: { verify: { passed: false, findings: [criterionText], acceptance: [] } } }, 1, true);
      expect(u2.dropped).toEqual([{ stage: "verify", file: "docs/onboarding.md", description: criterionText, why: "not-a-defect" }]);
    });

    it("T16 (MAJ2 path-less failure guard): a real, path-less finding whose own text says something else waits is not the plan-task sense and stays real; the classic path-less 'Acceptance criterion 4 waits on the docs task.' note still drops [Round 3 rule 5 failure-word guard]", () => {
      const { updateLedger } = ledgerModule();
      const task = { id: "a", files: ["src/x.ts"] };
      const texts = [
        "The request handler waits on the cleanup task and the process never exits.",
        "Acceptance command 2 fails: the server waits on the migration task and never binds the port.",
      ];
      const ledger = [];
      const r = { task, stages: ["verify"], commit: "c1", stageResults: { verify: { passed: false, findings: texts, acceptance: [] } } };
      const u = updateLedger(ledger, r, 1, true);
      expect(u.opened).toEqual(["F1", "F2"]);
      expect(u.dropped).toEqual([]);

      const noteText = "Acceptance criterion 4 waits on the docs task.";
      const ledger2 = [];
      const u2 = updateLedger(ledger2, { task, stages: ["verify"], commit: "c1", stageResults: { verify: { passed: false, findings: [noteText], acceptance: [] } } }, 1, true);
      expect(u2.dropped).toEqual([{ stage: "verify", file: "", description: noteText, why: "not-a-defect" }]);
    });

    it("T17 (MIN1 empty findingFiles fallback): a findingFiles entry with an empty files array is not authoritative - it falls back to the prose paths, so the owned src/x.ts named in the text still exempts this finding from the waits-on rule [Round 3 rule 2 empty findingFiles fallback]", () => {
      const { updateLedger } = ledgerModule();
      const task = { id: "a", files: ["src/x.ts"] };
      const text = "src/x.ts: the queue waits on the drain task and never empties.";
      const ledger = [];
      const r = { task, stages: ["verify"], commit: "c1", stageResults: { verify: { passed: false, findings: [text], findingFiles: [{ finding: text, files: [] }], acceptance: [] } } };
      const u = updateLedger(ledger, r, 1, true);
      expect(u.opened).toEqual(["F1"]);
      expect(u.dropped).toEqual([]);
    });

    it("T18 (MIN2 check scope invariant): a check's own inScope=false blocker issue opens with invariant 'scope', the same exemption a reviewer's scope finding gets, since the check stands in for the reviewer [Round 3 rule 2 check scope invariant]", () => {
      const { updateLedger } = ledgerModule();
      const task = { id: "a", files: ["src/x.ts"] };
      const ledger = [];
      const r = { task, stages: ["check"], commit: "c1", stageResults: { check: { passed: true, commandsRun: [], acceptance: [], findings: [], inScope: false, issues: [{ severity: "blocker", file: "lib/other.mjs", description: "task touched a file it does not own" }] } } };
      const u = updateLedger(ledger, r, 1, true);
      expect(u.opened).toEqual(["F1"]);
      expect(ledger[0].invariant).toBe("scope");
      expect(u.dropped).toEqual([]);
    });

    // Round 3b: the coder's own round-3 mutation run found M9, M10, M18 and M19 survived, because every fixture
    // that used to expose them also carried a failure word or an empty-line span, so the failure-word guard alone
    // kept it real. These fixtures carry no word from idReport's `open` list and no 'never', so only the named
    // mechanism - not the guard - can be what keeps each one real.

    it("T19 (M9, criterion anchor): 'holds' reports with no 'criterion' in the sentence and no failure word, 'holds' itself sitting directly before terminal punctuation, are real only because the text rule requires 'criterion' before 'holds' [Round 3 rule 5b criterion anchor]", () => {
      const { updateLedger } = ledgerModule();
      const task = { id: "a", files: ["src/x.ts"] };
      const texts = [
        "src/x.ts: the write lock holds.",
        "src/x.ts: across the whole request the write lock holds, doubling p99 latency.",
      ];
      const ledger = [];
      const r = { task, stages: ["verify"], commit: "c1", stageResults: { verify: { passed: false, findings: texts, acceptance: [] } } };
      const u = updateLedger(ledger, r, 1, true);
      expect(u.opened).toEqual(["F1", "F2"]);
      expect(u.dropped).toEqual([]);
    });

    it("T20 (M10, waits-on owned condition): a 'waits on ... task' report on an owned path and no failure word is real only because the waits-on rule is conditioned on the path being unowned [Round 3 rule 5c owned condition]", () => {
      const { updateLedger } = ledgerModule();
      const task = { id: "a", files: ["src/x.ts"] };
      const text = "src/x.ts: the request handler waits on the cleanup task before returning, so every response is delayed by five seconds.";
      const ledger = [];
      const r = { task, stages: ["verify"], commit: "c1", stageResults: { verify: { passed: false, findings: [text], acceptance: [] } } };
      const u = updateLedger(ledger, r, 1, true);
      expect(u.opened).toEqual(["F1"]);
      expect(u.dropped).toEqual([]);
    });

    it("T21 (M19, empty findingFiles fallback): a 'waits on ... task' report with an empty findingFiles entry and no failure word is real only because the empty entry falls back to the owned prose path [Round 3 rule 2 empty findingFiles fallback]", () => {
      const { updateLedger } = ledgerModule();
      const task = { id: "a", files: ["src/x.ts"] };
      const text = "src/x.ts: the queue waits on the drain task before it accepts a second item.";
      const ledger = [];
      const r = { task, stages: ["verify"], commit: "c1", stageResults: { verify: { passed: false, findings: [text], findingFiles: [{ finding: text, files: [] }], acceptance: [] } } };
      const u = updateLedger(ledger, r, 1, true);
      expect(u.opened).toEqual(["F1"]);
      expect(u.dropped).toEqual([]);
    });

    it("T22 (sentence scope of the failure-word guard): a failure word in a later sentence never guards an earlier criterion-holds match; a bare newline with no punctuation before it still bounds the sentence on its own [Round 3 rule 5 guard, sentence scope]", () => {
      const { updateLedger } = ledgerModule();
      const task = { id: "a", files: ["src/x.ts"] };
      const periodText = "Acceptance criterion 'the section exists' holds: it is present. The build fails on main.";
      const semicolonText = "Acceptance criterion 'the section exists' holds: it is present; the build fails on main.";
      // The period-before-whitespace lookahead already bounds a sentence at "present." regardless of whether '\n'
      // is a separate boundary alternative (whitespace includes '\n'), so a fixture that keeps that trailing
      // period cannot pin a boundary mutation that drops '\n' from BOUNDARY - it drops either way. This fixture
      // removes the period so only the bare newline bounds the first sentence, which does distinguish the two.
      const newlineText = "Acceptance criterion 'the section exists' holds: it is present\nThe build fails on main.";
      for (const text of [periodText, semicolonText, newlineText]) {
        const ledger = [];
        const r = { task, stages: ["verify"], commit: "c1", stageResults: { verify: { passed: false, findings: [text], acceptance: [] } } };
        const u = updateLedger(ledger, r, 1, true);
        expect(u.dropped).toEqual([{ stage: "verify", file: "", description: text, why: "not-a-defect" }]);
      }
    });

    it("T23 (quote blanking is narrow): a failure word inside a second quoted span, not the criterion's own quoted name, still guards the drop - only the quote immediately after 'criterion' is blanked [Round 3 rule 5 guard, quote blanking]", () => {
      const { updateLedger } = ledgerModule();
      const task = { id: "a", files: ["src/x.ts"] };
      const text = "Acceptance criterion 'the cache is bounded' holds: the log line reads 'never evicted'.";
      const ledger = [];
      const r = { task, stages: ["verify"], commit: "c1", stageResults: { verify: { passed: false, findings: [text], acceptance: [] } } };
      const u = updateLedger(ledger, r, 1, true);
      expect(u.opened).toEqual(["F1"]);
      expect(u.dropped).toEqual([]);
    });
  });

  describe("ledger drops check-stage notes that report no failure (card ledger-check-notes-as-blockers)", () => {
    // Fixture strings below are copied as literals from the real check-stage output of wf_2f62b9d5-3b5 (card
    // public-release, landed as f2e199a), task release-script pass 2, saved at
    // .doug/.state/briefs/ledger-check-notes-as-blockers.check.json. The tester never reads that file at test time.

    it("TA (the goal's pin, wf_2f62b9d5-3b5 pass 2): a failing check's two positive free-text notes (the fix-delta-is-owned note and the nothing-published note) open no new blockers; F2 stays open (re-reported by id and by the blocker issue), F1 is fixed, and the release-docs note is still dropped by the existing file rule [the run that stopped after two of five fix attempts on two positive check notes]", () => {
      const { updateLedger } = ledgerModule();
      const task = {
        id: "release-script",
        files: ["scripts/release.mjs", "tests/release.test.mjs", "package.json", "packages/doug-cli/package.json", "packages/doug-codex/package.json", "plugins/doug-flow/package.json", "plugins/doug-gates/package.json"],
      };

      // Pass 1: an earlier failing check opens F1 (the npm-skip note) and F2 (the checkRelease-throws note).
      const pass1Findings = [
        "npm --version failed, so the pack test skips without a documented reason.",
        "checkRelease throws TypeError on marketplace.json parsed to null in scripts/release.mjs.",
      ];
      const ledger = [];
      const r1 = { task, stages: ["check"], commit: "c1", stageResults: { check: { passed: false, commandsRun: [], acceptance: [], findings: pass1Findings, inScope: true, issues: [] } } };
      const u1 = updateLedger(ledger, r1, 1, true);
      expect(u1.opened).toEqual(["F1", "F2"]);

      // Pass 2: the saved check result verbatim.
      const f1 = "F1 fixed: with npm removed from PATH, the JSON reporter shows 'skipped | release stage (skipped: npm --version failed) packs and installs the staged cli and codex packages'. The fix uses describe.skipIf with the reason in the describe name, and the pack test's assertions are unchanged.";
      const f2 = "F2: still open. scripts/release.mjs is not in the fix delta. A probe against a temp manifest copy shows checkRelease throws TypeError \"Cannot read properties of null (reading 'version')\" when .claude-plugin/marketplace.json is `null`, and returns [] (release check ok) when root package.json is `null`. Expected: a problem line naming the file in both cases, never a throw or an empty array.";
      const f3 = "tests/release-docs.test.mjs exits 1 with 'No test files found'. That file belongs to the docs task (README, docs/getting-started.md, docs/releasing.md), not this task's owned list, so it waits on that task and does not fail this one.";
      const f4 = "Fix delta (8fd7ce2..HEAD) touches only tests/release.test.mjs, which is owned. It removes beforeAll/ctx.skip and moves the skip conditions to module level under describe.skipIf. No assertions were removed and no .only or .todo was added.";
      const f5 = "Nothing is published: no npm publish or pnpm publish invocation in scripts/release.mjs, tests/release.test.mjs, or package.json.";
      const findingFiles = [
        {
          finding: "F2: checkRelease throws TypeError on marketplace.json containing JSON `null` and returns [] (all rules skipped) when root package.json is `null`; expected a problem line naming the file, never a throw or a false ok.",
          files: ["scripts/release.mjs"],
        },
      ];
      const issue = {
        severity: "blocker",
        file: "scripts/release.mjs",
        description: "F2 still open: checkRelease throws when .claude-plugin/marketplace.json parses to null, and returns [] (release check ok) when root package.json parses to null. The fix delta did not touch scripts/release.mjs.",
        evidence: "marketplace null THROWS: Cannot read properties of null (reading 'version'); root null: []",
      };
      const r2 = {
        task,
        stages: ["check"],
        commit: "c2",
        stageResults: { check: { passed: false, commandsRun: [], acceptance: [], findings: [f1, f2, f3, f4, f5], findingFiles, inScope: true, issues: [issue] } },
      };
      const u2 = updateLedger(ledger, r2, 2, true);

      // No new blocker (F3/F4) opens from the two positive notes.
      expect(u2.opened).toEqual([]);
      expect(u2.fixed).toEqual(["F1"]);
      expect(ledger.find((e) => e.id === "F2").status).toBe("open");
      expect(ledger.map((e) => e.id)).toEqual(["F1", "F2"]);

      // The release-docs note stays dropped by the existing file rule (unowned file, guarded by 'not' in its own
      // sentence so the waits-on text rule never reaches it); the two positive notes are now dropped as check-notes.
      expect(u2.dropped).toEqual([
        { stage: "check", file: "tests/release-docs.test.mjs", description: f3, why: "outside-owned-files" },
        { stage: "check", file: "tests/release.test.mjs", description: f4, why: "check-note" },
        { stage: "check", file: "scripts/release.mjs", description: f5, why: "check-note" },
      ]);
    });

    it("TB: a failing check's non-id finding that reports a failure still opens a blocker, whether it says 'failed', 'throws', or 'missing' [the failure-word guard on the new rule]", () => {
      const { updateLedger } = ledgerModule();
      const task = { id: "release-script", files: ["scripts/release.mjs", "tests/release.test.mjs"] };

      const cases = [
        "pnpm exec vitest run tests/release.test.mjs exits 1: 2 tests failed.",
        "checkRelease throws TypeError on a null marketplace.json in scripts/release.mjs.",
        "scripts/release.mjs is missing a null check for the marketplace manifest.",
      ];
      for (const text of cases) {
        const ledger = [];
        const r = { task, stages: ["check"], commit: "c1", stageResults: { check: { passed: false, commandsRun: [], acceptance: [], findings: [text], inScope: true, issues: [] } } };
        const u = updateLedger(ledger, r, 1, true);
        expect(u.opened).toEqual(["F1"]);
        expect(u.dropped).toEqual([]);
      }
    });

    it("TC: a failing check's blocker issue with no failure word in its description still opens a blocker - the new rule reads only the check's free-text findings, never its issues [rule scoped to findings, not issues]", () => {
      const { updateLedger } = ledgerModule();
      const task = { id: "release-script", files: ["scripts/release.mjs"] };
      // "accepts" carries no CHECK_NOTE_FAILURE_WORD (round 2 widened the list to include returns/returned,
      // so this description was rewritten off that word to keep testing the rule-scoped-to-findings claim).
      const issue = { severity: "blocker", file: "scripts/release.mjs", description: "checkRelease accepts a null root package.json.", evidence: null };
      const ledger = [];
      const r = { task, stages: ["check"], commit: "c1", stageResults: { check: { passed: false, commandsRun: [], acceptance: [], findings: [], inScope: true, issues: [issue] } } };
      const u = updateLedger(ledger, r, 1, true);
      expect(u.opened).toEqual(["F1"]);
      expect(u.dropped).toEqual([]);
    });

    it("TD: a failing verify stage's finding with no failure word, on an owned file, still opens a blocker - the new rule is check-only [rule scoped to the check stage]", () => {
      const { updateLedger } = ledgerModule();
      const task = { id: "release-script", files: ["scripts/release.mjs"] };
      const ledger = [];
      const r = { task, stages: ["verify"], commit: "c1", stageResults: { verify: { passed: false, findings: ["scripts/release.mjs was rewritten end to end."], acceptance: [] } } };
      const u = updateLedger(ledger, r, 1, true);
      expect(u.opened).toEqual(["F1"]);
      expect(u.dropped).toEqual([]);
    });

    it("TE: a passing check's non-id note still opens nothing and is not recorded as dropped either - the new rule only reaches a blocking finding, and a passing check's findings are never blocking [rule gated on `blocking`, behaviour-neutral here]", () => {
      const { updateLedger } = ledgerModule();
      const task = { id: "release-script", files: ["scripts/release.mjs"] };
      const ledger = [];
      const r = { task, stages: ["check"], commit: "c1", stageResults: { check: { passed: true, commandsRun: [], acceptance: [], findings: ["Everything looks fine in scripts/release.mjs."], inScope: true, issues: [] } } };
      const u = updateLedger(ledger, r, 1, true);
      expect(u.opened).toEqual([]);
      expect(u.dropped).toEqual([]);
    });

    it("TF (id exemption ordering, round 2): a failing check's only finding re-reports F1 by id ('F1: the README.md link to docs/x.md points at a moved page.') with no failure word from the old or widened list in the clause; F1 stays open, is not fixed, and the finding is never recorded as dropped - the check-note rule runs after the idReport exemption, never before it", () => {
      const { updateLedger } = ledgerModule();
      const task = { id: "release-script", files: ["scripts/release.mjs", "tests/release.test.mjs", "README.md", "docs/x.md"] };

      // Pass 1: verify opens F1 on an owned file.
      const ledger = [];
      const r1 = { task, stages: ["verify"], commit: "c1", stageResults: { verify: { passed: false, findings: ["README.md: the install steps are missing a link to docs/x.md."], acceptance: [] } } };
      const u1 = updateLedger(ledger, r1, 1, true);
      expect(u1.opened).toEqual(["F1"]);

      // Pass 2 (newCommit true): a failing check whose only finding re-reports F1 by id, with no failure word.
      const r2 = { task, stages: ["check"], commit: "c2", stageResults: { check: { passed: false, commandsRun: [], acceptance: [], findings: ["F1: the README.md link to docs/x.md points at a moved page."], inScope: true, issues: [] } } };
      const u2 = updateLedger(ledger, r2, 2, true);
      expect(u2.opened).toEqual([]);
      expect(u2.fixed).toEqual([]);
      expect(u2.dropped).toEqual([]);
      expect(ledger.find((e) => e.id === "F1").status).toBe("open");
    });

    // TG (round 2): the widened failure-word vocabulary the check-note rule must recognise, one phrase per family,
    // each on an owned path so only the failure-word guard is under test. Every case below is a real defect report
    // and must open a blocker; several fail today (dropped as a check-note) because their wording carries none of
    // CHECK_NOTE_FAILURE_WORD's current words - they are red by design until that list widens.
    const tgTask = { id: "release-script", files: ["scripts/release.mjs", "tests/release.test.mjs", "README.md", "docs/x.md"] };
    const tgOpens = (text) => {
      const { updateLedger } = ledgerModule();
      const ledger = [];
      const r = { task: tgTask, stages: ["check"], commit: "c1", stageResults: { check: { passed: false, commandsRun: [], acceptance: [], findings: [text], inScope: true, issues: [] } } };
      const u = updateLedger(ledger, r, 1, true);
      expect(u.opened).toEqual(["F1"]);
      expect(u.dropped).toEqual([]);
    };

    it("TG1 (doesn't): \"scripts/release.mjs doesn't validate the manifest version.\" opens a blocker", () => {
      tgOpens("scripts/release.mjs doesn't validate the manifest version.");
    });

    it("TG2 (dead): \"The README.md link to docs/x.md is dead.\" opens a blocker", () => {
      tgOpens("The README.md link to docs/x.md is dead.");
    });

    it("TG3 (lacks): \"commit abc1234 lacks the test for rule 3 in tests/release.test.mjs\" opens a blocker", () => {
      tgOpens("commit abc1234 lacks the test for rule 3 in tests/release.test.mjs");
    });

    it("TG4 (unmet criterion): \"Acceptance criterion 'x' is unmet in scripts/release.mjs.\" opens a blocker", () => {
      tgOpens("Acceptance criterion 'x' is unmet in scripts/release.mjs.");
    });

    it("TG5 (hangs): \"scripts/release.mjs hangs on a null manifest.\" opens a blocker", () => {
      tgOpens("scripts/release.mjs hangs on a null manifest.");
    });

    it("TG6 (can't): \"scripts/release.mjs can't read a null manifest.\" opens a blocker", () => {
      tgOpens("scripts/release.mjs can't read a null manifest.");
    });

    it("TG7 (exits non-zero): \"pnpm exec vitest run tests/release.test.mjs exits 2.\" opens a blocker", () => {
      tgOpens("pnpm exec vitest run tests/release.test.mjs exits 2.");
    });

    it("TG8 (expected): \"scripts/release.mjs: expected a problem line, got [].\" opens a blocker", () => {
      tgOpens("scripts/release.mjs: expected a problem line, got [].");
    });

    it("TG9 (error): \"scripts/release.mjs logs an error when the manifest is null.\" opens a blocker", () => {
      tgOpens("scripts/release.mjs logs an error when the manifest is null.");
    });

    it("TG10 (wrong): \"scripts/release.mjs reads the wrong field for the manifest version.\" opens a blocker", () => {
      tgOpens("scripts/release.mjs reads the wrong field for the manifest version.");
    });

    it("TG11 (crash): \"scripts/release.mjs crashes on a null manifest.\" opens a blocker", () => {
      tgOpens("scripts/release.mjs crashes on a null manifest.");
    });
  });

  it("always shows the fix agent both ledger sections", () => {
    const mod = ledgerModule();
    const fixPrompt = new Function("plan", "fixAttempts", "ledgerText", CONSTS + fnSlice("function fixPrompt(") + "\nreturn fixPrompt;")({ title: "P" }, 3, mod.ledgerText);
    const t = { id: "a", title: "A", spec: "Do S.", files: ["src/x.ts"], verify: "vitest run src/x.test.ts" };
    const r = { impl: { branch: "doug/a", worktreePath: "/wt" } };
    const heading = "Fixed earlier in this task (do not undo these; bringing one back blocks):";

    // The heading is the standing "do not undo these" instruction, so it is in front of the fix agent from the
    // first pass on, before anything has been fixed.
    const empty = fixPrompt(t, r, 2, "main", []);
    expect(empty).toContain("Open findings (fix every one; a checking stage decides when one is fixed):");
    expect(empty).toContain(heading);
    expect(empty).toContain("- (none yet)");

    const later = fixPrompt(t, r, 3, "main", [
      { id: "F1", stage: "verify", invariant: "verification", severity: "blocker", file: "src/x.ts", line: 3, description: "returns 1, expected 2", evidence: "got 1", status: "open", openedPass: 2, reappeared: false },
      { id: "F2", stage: "adversary", invariant: "data-integrity", severity: "blocker", file: "src/y.ts", line: null, description: "deletes the cache", evidence: null, status: "fixed", openedPass: 1, fixedPass: 2, fixedCommit: "abcdef1234567", confirmedBy: "check", reappeared: false },
    ]);
    expect(later).toContain(heading);
    expect(later).not.toContain("- (none yet)");
    expect(later).toContain("F1 [verify/verification]");
    expect(later).toContain("F2 [adversary/data-integrity] fixed in abcdef1, confirmed by check (pass 2)");
  });

  it("adds the lessons header and text to implementPrompt, leadPrompt, workerPrompt, and fixPrompt only when task.lessons is set, and caps it at 2000 characters (card memory-recall #2)", () => {
    const header = "Lessons from earlier runs on this repository (memory; each cites where it was learned):";
    const withLessons = { ...task, lessons: "- [abc0000000000000] a lesson learned earlier (pattern)" };

    const implementPrompt = new Function("plan", CONSTS + fnSlice("function implementPrompt(") + "\nreturn implementPrompt;")(defaultPlan);
    const implWith = implementPrompt(withLessons, "main");
    expect(implWith).toContain(header);
    expect(implWith).toContain(withLessons.lessons);
    expect(implementPrompt(task, "main")).not.toContain(header);

    const leadPrompt = new Function("plan", fnSlice("function leadPrompt(") + "\nreturn leadPrompt;")(defaultPlan);
    expect(leadPrompt(withLessons, "main")).toContain(header);
    expect(leadPrompt(task, "main")).not.toContain(header);

    const workerPrompt = new Function("plan", CONSTS + fnSlice("function workerPrompt(") + "\nreturn workerPrompt;")(defaultPlan);
    const brief = { id: "core", title: "Core", spec: "do the core", files: ["src/x.ts"] };
    const lead = { branch: "doug/task-a" };
    expect(workerPrompt(withLessons, brief, 1, lead)).toContain(header);
    expect(workerPrompt(task, brief, 1, lead)).not.toContain(header);

    const mod = ledgerModule();
    const fixPrompt = new Function("plan", "fixAttempts", "ledgerText", CONSTS + fnSlice("function fixPrompt(") + "\nreturn fixPrompt;")(defaultPlan, 3, mod.ledgerText);
    const r = { impl: { branch: "doug/task-a", worktreePath: "/wt/a" }, worktreeGone: false };
    expect(fixPrompt(withLessons, r, 2, "main", [])).toContain(header);
    expect(fixPrompt(task, r, 2, "main", [])).not.toContain(header);

    // The workflow re-slices at 2000 characters, the belt to plan.mjs json's own cap; each of the four prompts
    // does its own slicing (review minor 3: mutating just one, e.g. leadPrompt's, left the suite green before).
    const long = "x".repeat(2500);
    const longTask = { ...task, lessons: long };
    const capped = implementPrompt(longTask, "main");
    expect(capped).toContain(long.slice(0, 2000));
    expect(capped).not.toContain(long.slice(0, 2001));
    const leadCapped = leadPrompt(longTask, "main");
    expect(leadCapped).toContain(long.slice(0, 2000));
    expect(leadCapped).not.toContain(long.slice(0, 2001));
    const workerCapped = workerPrompt(longTask, brief, 1, lead);
    expect(workerCapped).toContain(long.slice(0, 2000));
    expect(workerCapped).not.toContain(long.slice(0, 2001));
    const fixCapped = fixPrompt(longTask, r, 2, "main", []);
    expect(fixCapped).toContain(long.slice(0, 2000));
    expect(fixCapped).not.toContain(long.slice(0, 2001));
  });

  it("adds the code-context header and text to implementPrompt, leadPrompt, workerPrompt, and fixPrompt only when task.codeContext is set, and caps it at 2000 characters (card semantic-index, brief B)", () => {
    const header = "Code the semantic index found relevant to this task (path:lines; read these first, they are not the files you own):";
    const withCodeContext = { ...task, codeContext: "- src/y.ts:10-20  export function y() {" };

    const implementPrompt = new Function("plan", CONSTS + fnSlice("function implementPrompt(") + "\nreturn implementPrompt;")(defaultPlan);
    const implWith = implementPrompt(withCodeContext, "main");
    expect(implWith).toContain(header);
    expect(implWith).toContain(withCodeContext.codeContext);
    expect(implementPrompt(task, "main")).not.toContain(header);

    const leadPrompt = new Function("plan", fnSlice("function leadPrompt(") + "\nreturn leadPrompt;")(defaultPlan);
    expect(leadPrompt(withCodeContext, "main")).toContain(header);
    expect(leadPrompt(task, "main")).not.toContain(header);

    const workerPrompt = new Function("plan", CONSTS + fnSlice("function workerPrompt(") + "\nreturn workerPrompt;")(defaultPlan);
    const brief = { id: "core", title: "Core", spec: "do the core", files: ["src/x.ts"] };
    const lead = { branch: "doug/task-a" };
    expect(workerPrompt(withCodeContext, brief, 1, lead)).toContain(header);
    expect(workerPrompt(task, brief, 1, lead)).not.toContain(header);

    const mod = ledgerModule();
    const fixPrompt = new Function("plan", "fixAttempts", "ledgerText", CONSTS + fnSlice("function fixPrompt(") + "\nreturn fixPrompt;")(defaultPlan, 3, mod.ledgerText);
    const r = { impl: { branch: "doug/task-a", worktreePath: "/wt/a" }, worktreeGone: false };
    expect(fixPrompt(withCodeContext, r, 2, "main", [])).toContain(header);
    expect(fixPrompt(task, r, 2, "main", [])).not.toContain(header);

    // The workflow re-slices at 2000 characters, the belt to plan.mjs json's own cap; each of the four prompts
    // does its own slicing, the same as task.lessons above.
    const long = "x".repeat(2500);
    const longTask = { ...task, codeContext: long };
    const capped = implementPrompt(longTask, "main");
    expect(capped).toContain(long.slice(0, 2000));
    expect(capped).not.toContain(long.slice(0, 2001));
    const leadCapped = leadPrompt(longTask, "main");
    expect(leadCapped).toContain(long.slice(0, 2000));
    expect(leadCapped).not.toContain(long.slice(0, 2001));
    const workerCapped = workerPrompt(longTask, brief, 1, lead);
    expect(workerCapped).toContain(long.slice(0, 2000));
    expect(workerCapped).not.toContain(long.slice(0, 2001));
    const fixCapped = fixPrompt(longTask, r, 2, "main", []);
    expect(fixCapped).toContain(long.slice(0, 2000));
    expect(fixCapped).not.toContain(long.slice(0, 2001));
  });

  // ---- card workflow-reads-commit-from-git: the loop records a pass's commit from the worktree head a
  // verifier/check stage reports (VERIFY_SCHEMA/CHECK_SCHEMA `head`), not from the implementer's claimed commit,
  // since the implementer's report is not trusted. ----
  describe("card workflow-reads-commit-from-git", () => {
    const passingVerify = { taskId: "a", passed: true, findings: [] };

    const verifyPromptFn = new Function(
      "plan", "acceptanceEntries", "CONTRADICTION_MARKER", "ENVIRONMENT_MARKER",
      CONSTS + fnSlice("function verifyPrompt(") + "\nreturn verifyPrompt;",
    )(defaultPlan, acceptanceEntriesFn(), "SPEC CONTRADICTS ACCEPTANCE", "ENVIRONMENT ONLY");
    const sizeCheckPromptFn = new Function(
      "plan", "acceptanceEntries", "CONTRADICTION_MARKER", "ENVIRONMENT_MARKER",
      CONSTS + fnSlice("function sizeCheckPrompt(") + "\nreturn sizeCheckPrompt;",
    )(defaultPlan, acceptanceEntriesFn(), "SPEC CONTRADICTS ACCEPTANCE", "ENVIRONMENT ONLY");
    const checkPromptFn = new Function(
      "plan", "CONTRADICTION_MARKER", "ENVIRONMENT_MARKER", "acceptanceEntries", "ledgerText",
      fnSlice("function checkPrompt(") + "\nreturn checkPrompt;",
    )(defaultPlan, "SPEC CONTRADICTS ACCEPTANCE", "ENVIRONMENT ONLY", acceptanceEntriesFn(), ledgerModule().ledgerText);
    const confirmationLinesFn = new Function(
      "ledgerText",
      fnSlice("function confirmationLines(") + "\nreturn confirmationLines;",
    )(ledgerModule().ledgerText);

    // stageHead accepts only a trimmed 40-char lowercase hex sha (T7): these are 40-hex fixtures standing in for
    // real ones, distinct per test so a mixup shows up as a wrong-value failure. The implementer's claimed commit
    // is never validated that way, so its fixtures stay short and obviously fake ("c1wrong" etc.).
    const HEAD_C1 = "1".repeat(40);
    const HEAD_C2 = "2".repeat(40);
    const HEAD_STALE = "5".repeat(40);
    const HEAD_S1 = "3".repeat(40);

    it("T1: records the verifier's head over the implementer's wrong commit on a passing first pass, and warns", async () => {
      const logs = [];
      const { agent } = scripted({
        "implement:a": () => ({ ...implResult, commit: "c1wrong" }),
        "verify:a": () => ({ ...passingVerify, head: HEAD_C1 }),
        "review:a": () => passingReview,
      });
      const r = await loadLoop({ agent, fixAttempts: 2, log: (line) => logs.push(line) }).runTask(task, "main");
      expect(r.commit).toBe(HEAD_C1);
      expect(r.attempts[0].commit).toBe(HEAD_C1);
      expect(r.attempts[0].ready).toBe(true);
      expect(logs.some((l) => l.includes("c1wrong") && l.includes(HEAD_C1))).toBe(true);
    });

    it("T2: on a fix pass where both the verifier and the check report a head, the check's (run last) wins", async () => {
      const { agent } = scripted({
        "implement:a": () => implResult,
        "verify:a": (i) => (i === 0
          ? { taskId: "a", passed: false, findings: ["src/x.ts returns 1, expected 2"], head: HEAD_C1 }
          : { ...passingVerify, head: HEAD_STALE }),
        "review:a": () => passingReview,
        "check:a": () => ({ ...passingCheck, head: HEAD_C2 }),
        "fix:a": () => ({ ...implResult, commit: "c2wrong" }),
      });
      const r = await loadLoop({ agent, fixAttempts: 2 }).runTask(task, "main");
      expect(r.commit).toBe(HEAD_C2);
      expect(r.attempts[1].commit).toBe(HEAD_C2);
      const f1 = r.ledger.find((e) => e.id === "F1");
      expect(f1.fixedCommit).toBe(HEAD_C2);
    });

    it("T3: size-S first pass records the check's head over the implementer's wrong commit", async () => {
      const sTask = { ...task, size: "S" };
      const { agent } = scripted({
        "implement:a": () => ({ ...implResult, commit: "s1wrong" }),
        "check:a": () => ({ ...passingCheck, head: HEAD_S1 }),
      });
      const r = await loadLoop({ agent, fixAttempts: 2 }).runTask(sTask, "main");
      expect(r.commit).toBe(HEAD_S1);
    });

    it("T4: keeps the implementer's commit when no stage reports a head (fallback, display only)", async () => {
      const { agent } = scripted({
        "implement:a": () => implResult,
        "verify:a": () => passingVerify,
        "review:a": () => passingReview,
      });
      const r = await loadLoop({ agent, fixAttempts: 2 }).runTask(task, "main");
      expect(r.commit).toBe("c1");
    });

    it("T5: pins `head` on VERIFY_SCHEMA/CHECK_SCHEMA, the git rev-parse HEAD step in the prompts, and the report reading r.commit", () => {
      const verifyStart = source.indexOf("const VERIFY_SCHEMA");
      const VERIFY_SCHEMA = new Function(source.slice(verifyStart, source.indexOf("\n}\n", verifyStart) + 3) + "\nreturn VERIFY_SCHEMA;")();
      expect(VERIFY_SCHEMA.required).toContain("head");
      const checkStart = source.indexOf("const CHECK_SCHEMA");
      const CHECK_SCHEMA = new Function(source.slice(checkStart, source.indexOf("\n}\n", checkStart) + 3) + "\nreturn CHECK_SCHEMA;")();
      expect(CHECK_SCHEMA.required).toContain("head");

      const vText = verifyPromptFn(task, implResult, "main");
      expect(vText).toContain("git rev-parse HEAD");
      expect(vText).toContain("head");
      const sText = sizeCheckPromptFn(task, implResult, "main");
      expect(sText).toContain("git rev-parse HEAD");
      expect(sText).toContain("head");
      const cText = checkPromptFn(task, implResult, null, "main", []);
      expect(cText).toContain("git rev-parse HEAD");
      expect(cText).toContain("head");

      expect(source).toMatch(/commit:\s*r\.commit/);
      expect(source).not.toMatch(/commit:\s*r\.impl\s*\?\s*r\.impl\.commit/);
    });

    it("T6: the check prompt's and the adversary confirm prompt's diff ranges use the branch, never the implementer's claimed commit", () => {
      const impl = { ...implResult, commit: "bogus", branch: "doug/task-a" };
      const cText = checkPromptFn(task, impl, "c1real", "main", []);
      expect(cText).toContain("..doug/task-a");
      expect(cText).not.toContain("bogus");

      const confirmImpl = { ...implResult, commit: "bogus", branch: "doug/task-a", prevCommit: "c1real" };
      const confirmText = confirmationLinesFn(2, [], confirmImpl).join("\n");
      expect(confirmText).toContain("Confirm each open finding one by one");
      expect(confirmText).toContain("c1real..doug/task-a");
      expect(confirmText).not.toContain("bogus");
    });

    it("T7: normalises a stage's head - trims a real sha, and treats an abbreviated one as no head at all", async () => {
      const realSha = "f6a3bfa5a63d1d5f30aa4c6cef0837f824e6c29a";
      // (a) a real-looking sha with a trailing newline is trimmed before it is recorded.
      const a = scripted({
        "implement:a": () => ({ ...implResult, commit: "c1wrong" }),
        "verify:a": () => ({ taskId: "a", passed: true, findings: [], head: `${realSha}\n` }),
        "review:a": () => passingReview,
      });
      const ra = await loadLoop({ agent: a.agent, fixAttempts: 2 }).runTask(task, "main");
      expect(ra.commit).toBe(realSha);

      // (b) an abbreviated hash is not a canonical head: the implementer's claimed commit is kept (fallback), and
      // no mismatch is logged, since there is nothing canonical to compare it against.
      const logs = [];
      const b = scripted({
        "implement:a": () => implResult,
        "verify:a": () => ({ taskId: "a", passed: true, findings: [], head: "f6a3bfa" }),
        "review:a": () => passingReview,
      });
      const rb = await loadLoop({ agent: b.agent, fixAttempts: 2, log: (l) => logs.push(l) }).runTask(task, "main");
      expect(rb.commit).toBe("c1");
      expect(logs.some((l) => l.includes("f6a3bfa"))).toBe(false);
    });

    it("T8: the report's per-task commit is the recorded head, not the implementer's claimed commit", async () => {
      const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
      async function runWorkflowLocal(plan, agent) {
        const bodyStart = source.indexOf("\n}\n") + 3;
        const body = new AsyncFunction("args", "agent", "pipeline", "parallel", "phase", "log", "budget", source.slice(bodyStart));
        const pipeline = async (items, fn) => { const out = []; for (const item of items) out.push(await fn(item)); return out };
        const parallel = async (fns) => Promise.all(fns.map((f) => f()));
        return body(plan, agent, pipeline, parallel, (x) => x, () => {}, null);
      }
      const head = "a".repeat(40);
      const wfPlan = { status: "approved", title: "P", goal: "G", install: null, verify: ["true"], acceptance: [], adversary: false, fixAttempts: 3, baseBranch: "main", integrationBranch: "doug/int", tasks: [{ id: "a", title: "A", spec: "Do a.", files: ["src/a.ts"], verify: "true" }] };
      const wfAgent = async (prompt, opts) => {
        const label = String(opts.label);
        if (label === "implement:a") return { taskId: "a", branch: "doug/task-a", worktreePath: "/wt/a", filesTouched: [], commandsRun: [], summary: "done", blocked: false, commit: "c1wrong" };
        if (label === "verify:a") return { taskId: "a", passed: true, commandsRun: [], findings: [], acceptance: [], head };
        if (label === "review:a") return { taskId: "a", specCompliant: true, inScope: true, approve: true, issues: [] };
        if (label === "integrate:level-0") return { branch: "doug/int", merged: ["doug/task-a"], conflicts: [], verify: [], ok: true };
        return null;
      };
      const report = await runWorkflowLocal(wfPlan, wfAgent);
      expect(report.levels[0].tasks[0].commit).toBe(head);
    });
  });

  describe("card fallback-adversary-blocker-evidence", () => {
    // R12 mirrored for the fallback adversary (packages/doug-codex/src/contract.ts is the source of truth for the
    // Codex-side check; change both together). The fallback's commandsRun is self-reported by the agent, not the
    // runtime's own record, so this is weaker than the Codex check. Crew seats 2+ are out of scope (finding F4 of that card's review).
    const fallback = { model: "opus", effort: "high" };
    const codexDown = { taskId: "a", ran: false, verdict: "inconclusive", summary: "", issues: [], commandsRun: [], error: "codex-failed: codex exec exited 1: usage limit" };
    const passing = {
      "implement:a": () => implResult,
      "verify:a": () => ({ taskId: "a", passed: true, findings: [] }),
      "review:a": () => passingReview,
      "check:a": () => passingCheck,
      "adversary:a": () => codexDown,
    };
    const runFallback = async (fbHandler, { fixAttempts = 3, extra = {} } = {}) => {
      const s = scripted({ ...passing, ...extra, "adversary-fallback:a": fbHandler });
      const r = await loadLoop({ agent: s.agent, fixAttempts, adversary: { command: "x", timeoutMs: 1, fallback } }).runTask(task, "main");
      return { r, calls: s.calls };
    };
    const NO_EVIDENCE = "is a blocker with no evidence; a blocker cites a command in commandsRun that shows the failure";
    const NO_COMMAND = "is a blocker whose evidence names no command in commandsRun and quotes no line of any command's output; static inspection alone is major at most";
    const prefixed = (reason, description) => `[adversary-claude: downgraded from blocker, R12: ${reason}] ${description}`;
    // stopReason is null on a ready (non-blocked) task or a string naming why it stopped; a mutation that lets an
    // odd shape throw inside the loop surfaces as a stopReason string containing "threw" (the loop's own catch).
    const neverThrew = (stopReason) => stopReason === null || (typeof stopReason === "string" && !/threw/.test(stopReason));

    it("T1: a blocker with empty or null evidence is downgraded to major and the fail verdict flips to pass (R12 no-evidence)", async () => {
      const { r, calls } = await runFallback(() => ({
        taskId: "a", ran: true, verdict: "fail", summary: "no evidence given",
        issues: [
          { severity: "blocker", file: "src/x.ts", description: "the function returns 1", evidence: "" },
          { severity: "blocker", file: "src/x.ts", description: "the function is wrong", evidence: null },
        ],
        commandsRun: [{ command: "pnpm test", ok: true, exitCode: 0 }],
        error: null,
      }), { fixAttempts: 0 });
      expect(r.attempts[0].adversary.verdict, "R12 no-evidence: both blockers downgraded, none left, fail flips to pass").toBe("pass");
      expect(r.attempts[0].adversary.blocked, "no blocker severity left, so the task is not blocked").toBe(false);
      expect(labelled(calls, "fix:").length, "not blocked, so no fix pass is launched").toBe(0);
      expect(r.adv.issues.length, "an evidence-free blocker is downgraded in place, never dropped").toBe(2);
      expect(r.adv.issues.map((i) => i.severity), "R12: both downgraded to major").toEqual(["major", "major"]);
      expect(r.adv.issues[0].description, "prefix names adversary-claude and R12, original description kept").toBe(prefixed(NO_EVIDENCE, "the function returns 1"));
      expect(r.adv.issues[1].description, "evidence: null fails the same no-evidence rule as evidence: \"\"").toBe(prefixed(NO_EVIDENCE, "the function is wrong"));
      expect(r.adv.downgraded, "downgraded records index and reason per issue").toEqual([
        { index: 0, reason: NO_EVIDENCE },
        { index: 1, reason: NO_EVIDENCE },
      ]);
    });

    it("T2: a blocker whose evidence names no recorded command is downgraded (R12 no-command)", async () => {
      const { r } = await runFallback(() => ({
        taskId: "a", ran: true, verdict: "fail", summary: "off by one",
        issues: [{ severity: "blocker", file: "src/x.ts", description: "wrong", evidence: "the function returns 1" }],
        commandsRun: [{ command: "pnpm test", ok: true, exitCode: 0 }],
        error: null,
      }), { fixAttempts: 0 });
      expect(r.adv.issues[0].severity, "R12 no-command: downgraded to major").toBe("major");
      expect(r.adv.issues[0].description, "reason names the no-command rule").toBe(prefixed(NO_COMMAND, "wrong"));
      expect(r.adv.downgraded, "one downgrade recorded for the one issue").toEqual([{ index: 0, reason: NO_COMMAND }]);
      expect(r.attempts[0].adversary.verdict, "no blocker left: fail flips to pass").toBe("pass");
    });

    it("T3: a blocker citing a passing command but quoting none of its output is downgraded (R12 no-quote)", async () => {
      const { r } = await runFallback(() => ({
        taskId: "a", ran: true, verdict: "fail", summary: "logic wrong",
        issues: [{ severity: "blocker", file: "src/x.ts", description: "wrong", evidence: "pnpm test passed but the logic is wrong" }],
        commandsRun: [{ command: "pnpm test", ok: true, exitCode: 0, outputTail: "3 passed" }],
        error: null,
      }), { fixAttempts: 0 });
      expect(r.adv.issues[0].severity, "R12 no-quote: cites a passing command, quotes nothing, downgraded").toBe("major");
      expect(r.adv.issues[0].description, 'reason names the cited command and "quotes none of its output"').toBe(
        prefixed('cites "pnpm test", which exited 0, and quotes none of its output', "wrong"),
      );
    });

    it("T4: a blocker citing a command that actually failed stays a blocker across a fix pass (real failure, not downgraded)", async () => {
      const realFailure = () => ({
        taskId: "a", ran: true, verdict: "fail", summary: "off by one",
        issues: [{ severity: "blocker", file: "src/x.ts", description: "pnpm test: FAIL x.test", evidence: "pnpm test: FAIL x.test" }],
        commandsRun: [{ command: "pnpm test", ok: false, exitCode: 1 }],
        error: null,
      });
      const { r, calls } = await runFallback(realFailure, { fixAttempts: 1, extra: { "fix:a": () => ({ ...implResult, commit: "c2" }) } });
      expect(r.adv.issues[0].severity, "a command that actually failed is real evidence, not downgraded").toBe("blocker");
      expect(r.adv.downgraded, "nothing downgraded").toBeUndefined();
      expect(r.attempts[0].adversary.verdict, "the fail verdict stands").toBe("fail");
      expect(r.attempts[0].adversary.blocked, "still blocks").toBe(true);
      expect(labelled(calls, "fix:").length, "a real blocker still launches a fix pass").toBe(1);
    });

    it("T5: a blocker that quotes a line of a passing command's recorded output stays a blocker (R12 quote satisfies the bar)", async () => {
      const { r } = await runFallback(() => ({
        taskId: "a", ran: true, verdict: "fail", summary: "off by one",
        issues: [{ severity: "blocker", file: "src/x.ts", description: "wrong", evidence: "pnpm test prints 'warning: x is deprecated'" }],
        commandsRun: [{ command: "pnpm test", ok: true, exitCode: 0, outputTail: "warning: x is deprecated\n3 passed" }],
        error: null,
      }), { fixAttempts: 0 });
      expect(r.adv.issues[0].severity, "quotes a line of the recorded output: not downgraded").toBe("blocker");
      expect(r.adv.downgraded, "nothing downgraded").toBeUndefined();
    });

    it("T6: a fail with zero issues still blocks (adversaryBlocking's no-op rule, nothing to downgrade); a fail with one real and one evidence-free blocker downgrades only the second", async () => {
      const { r: noOp } = await runFallback(() => ({ taskId: "a", ran: true, verdict: "fail", summary: "", issues: [], commandsRun: [], error: null }), { fixAttempts: 0 });
      expect(noOp.attempts[0].adversary.verdict, "no issues to downgrade: verdict stays fail").toBe("fail");
      expect(noOp.attempts[0].adversary.blocked, "adversaryBlocking blocks a fail with zero issues").toBe(true);
      expect(noOp.adv.downgraded, "nothing to downgrade").toBeUndefined();

      const { r: mixed } = await runFallback(() => ({
        taskId: "a", ran: true, verdict: "fail", summary: "two issues",
        issues: [
          { severity: "blocker", file: "src/x.ts", description: "real", evidence: "pnpm test: FAIL x.test" },
          { severity: "blocker", file: "src/x.ts", description: "not real", evidence: "" },
        ],
        commandsRun: [{ command: "pnpm test", ok: false, exitCode: 1 }],
        error: null,
      }), { fixAttempts: 0 });
      expect(mixed.adv.issues[0].severity, "the real blocker is left alone").toBe("blocker");
      expect(mixed.adv.issues[1].severity, "the evidence-free one is downgraded").toBe("major");
      expect(mixed.adv.downgraded, "only the second issue is downgraded").toEqual([{ index: 1, reason: NO_EVIDENCE }]);
      expect(mixed.attempts[0].adversary.verdict, "a blocker remains: fail is left alone, not flipped to pass").toBe("fail");
      expect(mixed.attempts[0].adversary.blocked, "still blocks").toBe(true);
    });

    it("T7: the primary Codex-relayed result is untouched (fallback-only scope; R12 for Codex is run.ts's job)", async () => {
      const s = scripted({
        ...passing,
        "adversary:a": () => ({ taskId: "a", ran: true, verdict: "fail", summary: "wrong", issues: [{ severity: "blocker", file: "src/x.ts", description: "wrong", evidence: "" }], commandsRun: [], error: null }),
        "adversary-fallback:a": () => { throw new Error("must not run"); },
      });
      const r = await loadLoop({ agent: s.agent, fixAttempts: 0, adversary: { command: "x", timeoutMs: 1, fallback } }).runTask(task, "main");
      expect(labelled(s.calls, "adversary-fallback:").length, "codex itself succeeded, so the fallback never runs").toBe(0);
      expect(r.adv.issues[0].severity, "the primary Codex result is not touched by enforceFallbackEvidence").toBe("blocker");
      expect(r.adv.issues[0].description, "no adversary-claude downgrade prefix on the primary path").toBe("wrong");
      expect(r.attempts[0].adversary.blocked, "an evidence-free blocker from Codex still blocks here; enforcement for it lives in run.ts").toBe(true);
    });

    it("T8: evidence naming the inner command of a recorded shell wrapper still cites it (innerCommand unwrapping)", async () => {
      const { r } = await runFallback(() => ({
        taskId: "a", ran: true, verdict: "fail", summary: "off by one",
        issues: [{ severity: "blocker", file: "src/x.ts", description: "wrong", evidence: "pnpm test: FAIL x.test" }],
        commandsRun: [{ command: "/bin/zsh -lc 'pnpm test'", ok: false, exitCode: 1 }],
        error: null,
      }), { fixAttempts: 0 });
      expect(r.adv.issues[0].severity, "innerCommand unwraps the shell wrapper; the inner command is cited and failed").toBe("blocker");
      expect(r.adv.downgraded, "nothing downgraded").toBeUndefined();
    });

    it("T9: pins the outputTail schema field (R1), the fallback prompt asking for it (R2), the docs rule (R5), and the call sites (card crew-seat-blocker-evidence adds a second)", () => {
      const advSchemaStart = source.indexOf("const ADVERSARY_SCHEMA");
      const ADVERSARY_SCHEMA_BUILT = new Function(source.slice(advSchemaStart, source.indexOf("\n}\n", advSchemaStart) + 3) + "\nreturn ADVERSARY_SCHEMA;")();
      expect(ADVERSARY_SCHEMA_BUILT.properties.commandsRun.items.properties.outputTail, "R1: commandsRun gains outputTail so a blocker can quote a line of it").toBeDefined();

      const fallbackAdversaryPromptFn = new Function(
        "plan", "BLOCKER_GATE", "confirmationLines", "acceptanceEntries",
        fnSlice("function fallbackAdversaryPrompt(") + "\nreturn fallbackAdversaryPrompt;",
      )({ verify: ["pnpm test:unit"], acceptance: ["it works"] }, blockerGate(), () => [], acceptanceEntriesFn());
      const p = fallbackAdversaryPromptFn({ id: "a", title: "A", spec: "Do S.", files: ["src/a.ts"], verify: "vitest run src/a.test.ts" }, { branch: "doug/a", worktreePath: "/wt" }, "main", "codex-failed: usage limit", 1, []);
      expect(p, "R2: the fallback prompt asks for outputTail on each commandsRun entry").toContain("outputTail");

      const docsText = readFileSync(join(root, "../../docs/worker-contract.md"), "utf8");
      const rule8 = docsText.slice(docsText.indexOf("8. **A blocker is a demonstrated failure**"), docsText.indexOf("9. **A partial is graceful degradation"));
      expect(rule8, "R5: rule 8 mentions the fallback").toMatch(/fallback/);
      expect(rule8, "R5: rule 8 says the fallback's commandsRun is self-reported, weaker than the Codex check").toMatch(/self-reported|reports itself/);

      // card crew-seat-blocker-evidence: a second call site, the crew-seat thunk in runAdversaryCrew, applies the
      // same check to each further seat's result; only these two, the fallback assignment in runAdversary and the
      // crew-seat thunk, should ever call it.
      const callSites = (source.match(/(?<!function )enforceFallbackEvidence\(/g) || []).length;
      expect(callSites, "exactly twice: the fallback assignment in runAdversary and the crew-seat thunk").toBe(2);
    });

    it("T10: an inconclusive verdict is never flipped by a downgrade, though the issue itself is downgraded", async () => {
      const { r } = await runFallback(() => ({
        taskId: "a", ran: true, verdict: "inconclusive", summary: "environment denial",
        issues: [{ severity: "blocker", file: "src/x.ts", description: "wrong", evidence: "" }],
        commandsRun: [],
        error: null,
      }), { fixAttempts: 0 });
      expect(r.adv.issues[0].severity, "the evidence-free blocker is downgraded like any other").toBe("major");
      expect(r.adv.downgraded, "the downgrade is recorded").toEqual([{ index: 0, reason: NO_EVIDENCE }]);
      expect(r.adv.verdict, "inconclusive is never flipped to pass, unlike fail").toBe("inconclusive");
      expect(r.attempts[0].adversary.verdict, "inconclusive stays inconclusive").toBe("inconclusive");
    });

    it("T11a: a command reported ok but with a non-zero recorded exitCode still counts as a failure (commandFailed: ok === false OR a non-zero exitCode)", async () => {
      const stillFailing = () => ({
        taskId: "a", ran: true, verdict: "fail", summary: "off by one",
        issues: [{ severity: "blocker", file: "src/x.ts", description: "pnpm test failed", evidence: "pnpm test failed" }],
        commandsRun: [{ command: "pnpm test", ok: true, exitCode: 1 }],
        error: null,
      });
      const { r, calls } = await runFallback(stillFailing, { fixAttempts: 1, extra: { "fix:a": () => ({ ...implResult, commit: "c2" }) } });
      expect(r.adv.issues[0].severity, "ok: true but exitCode: 1 is still a recorded failure, not downgraded").toBe("blocker");
      expect(r.adv.downgraded, "nothing downgraded").toBeUndefined();
      expect(r.attempts[0].adversary.verdict, "the fail verdict stands").toBe("fail");
      expect(r.attempts[0].adversary.blocked, "still blocks").toBe(true);
      expect(labelled(calls, "fix:").length, "a real failure (by exitCode, despite ok: true) still launches a fix pass").toBe(1);
    });

    it("T11b: odd commandsRun/issues shapes in the fallback result never throw (a null entry, a non-object entry, a missing array)", async () => {
      // runFallback awaited directly, inside try/catch: an uncaught throw inside the loop would reject this
      // promise, not just set stopReason, so "resolves" is checked by catching, not by reading the result.
      const resolves = async (fbHandler) => {
        try {
          return { threw: null, result: await runFallback(fbHandler, { fixAttempts: 0 }) };
        } catch (e) {
          return { threw: e, result: null };
        }
      };

      // A commandsRun full of junk: null, a bare string, and an object whose command is not a string. None of
      // them is a usable command, so the blocker is downgraded for naming no command, not by throwing on null.
      const { threw: threw1, result: junk } = await resolves(() => ({
        taskId: "a", ran: true, verdict: "fail", summary: "off by one",
        issues: [{ severity: "blocker", file: "src/x.ts", description: "wrong", evidence: "pnpm test failed" }],
        commandsRun: [null, "pnpm test", { command: 42, ok: false }],
        error: null,
      }));
      expect(threw1, "a null/non-object commandsRun entry resolves rather than throwing").toBeNull();
      expect(neverThrew(junk.r.stopReason), "and does not encode the throw into stopReason either").toBe(true);
      expect(junk.r.adv.issues[0].severity, "none of the junk entries names a usable command: downgraded for naming no command").toBe("major");
      expect(junk.r.adv.issues[0].description, "the no-command reason, not a crash").toBe(prefixed(NO_COMMAND, "wrong"));

      // commandsRun missing entirely (not just empty): defaults to [], never throws (R3).
      const { threw: threw2, result: missingCommands } = await resolves(() => ({
        taskId: "a", ran: true, verdict: "fail", summary: "off by one",
        issues: [{ severity: "blocker", file: "src/x.ts", description: "wrong", evidence: "pnpm test failed" }],
        error: null,
      }));
      expect(threw2, "a missing commandsRun resolves rather than throwing").toBeNull();
      expect(neverThrew(missingCommands.r.stopReason), "and does not encode the throw into stopReason either").toBe(true);

      // issues missing entirely: never throws.
      const { threw: threw3, result: missingIssues } = await resolves(() => ({
        taskId: "a", ran: true, verdict: "fail", summary: "off by one",
        commandsRun: [],
        error: null,
      }));
      expect(threw3, "a missing issues array resolves rather than throwing").toBeNull();
      expect(neverThrew(missingIssues.r.stopReason), "and does not encode the throw into stopReason either").toBe(true);
    });

    describe("crew seats (card crew-seat-blocker-evidence)", () => {
      // Same crew shapes as the "fans a crew of reviewers and adversaries out" test (~lines 1076-1200): a two-
      // adversary crew, seat 1 through runAdversary (the Codex path here always "ran", so its fallback never
      // fires), seat 2 through runAdversaryCrew's thunk (the doug-flow:adversary-claude agent, labelled
      // "adversary-2:a"). R12 (enforceFallbackEvidence) applies to each further seat's result, same as the
      // fallback's own, before mergeAdversaries; seat 1 stays out of scope (that's Codex's own check in run.ts).
      const codex = { command: "codex-review", timeoutMs: 1000, fallback: { model: "opus", effort: "high" }, crewModel: { model: "opus", effort: "high" } };
      const crewTask = { ...task, crew: { adversaries: 2 } };
      const adversaryPass = (summary) => ({ taskId: "a", ran: true, verdict: "pass", summary, issues: [], commandsRun: [{ command: "true", ok: true }], error: null });

      it("C1: a seat-2 evidence-free blocker is downgraded by R12 before the merge, so it no longer blocks", async () => {
        const { agent, calls } = scripted({
          "implement:a": () => implResult,
          "verify:a": () => ({ taskId: "a", passed: true, findings: [] }),
          "review:a": () => passingReview,
          "adversary:a": () => adversaryPass("could not refute"),
          "adversary-2:a": () => ({
            taskId: "a", ran: true, verdict: "fail", summary: "off by one",
            issues: [{ severity: "blocker", file: "src/x.ts", description: "loses the last item", evidence: "" }],
            commandsRun: [{ command: "pnpm test", ok: true, exitCode: 0 }],
            error: null,
          }),
        });
        const r = await loadLoop({ agent, fixAttempts: 3, adversary: codex }).runTask(crewTask, "main");
        expect(labelled(calls, "fix:").length, "downgraded away: not blocked, so no fix pass is launched").toBe(0);
        expect(r.attempts[0].adversary.blocked, "no blocker severity left after R12: not blocked").toBe(false);
        expect(r.attempts[0].adversary.verdict, "the merged verdict flips to pass").toBe("pass");
        const majors = r.adv.issues.filter((i) => i.severity === "major");
        expect(majors.length, "the downgraded issue is kept in the merge, not dropped").toBe(1);
        expect(
          majors[0].description.startsWith("[adversary-claude: downgraded from blocker, R12: is a blocker with no evidence"),
          "seat 2's issue carries the adversary-claude R12 no-evidence prefix",
        ).toBe(true);
        expect(r.adv.issues.some((i) => i.file === ""), "no synthesized blocker from mergeAdversaries' empty-issues rule").toBe(false);
      });

      it("C2: a seat-2 blocker whose evidence names a command that actually failed still blocks", async () => {
        const { agent, calls } = scripted({
          "implement:a": () => implResult,
          "verify:a": () => ({ taskId: "a", passed: true, findings: [] }),
          "review:a": () => passingReview,
          "adversary:a": () => adversaryPass("could not refute"),
          "adversary-2:a": () => ({
            taskId: "a", ran: true, verdict: "fail", summary: "off by one",
            issues: [{ severity: "blocker", file: "src/x.ts", description: "loses the last item", evidence: "pnpm test: FAIL" }],
            commandsRun: [{ command: "pnpm test", ok: false, exitCode: 1 }],
            error: null,
          }),
          "fix:a": () => ({ ...implResult, commit: "c2" }),
        });
        const r = await loadLoop({ agent, fixAttempts: 1, adversary: codex }).runTask(crewTask, "main");
        expect(labelled(calls, "fix:").length, "a real, cited failure still launches a fix pass").toBe(1);
        expect(r.attempts[0].adversary.blocked, "a cited command that actually failed is real evidence: still blocks").toBe(true);
        expect(r.adv.issues[0].severity, "seat 2's issue stays a blocker").toBe("blocker");
        expect(r.adv.issues[0].description, "no downgrade prefix on a real blocker").toBe("loses the last item");
      });

      it("C3: seat 1 (Codex) is out of scope for this card: an evidence-free blocker there still blocks with no downgrade prefix", async () => {
        const { agent, calls } = scripted({
          "implement:a": () => implResult,
          "verify:a": () => ({ taskId: "a", passed: true, findings: [] }),
          "review:a": () => passingReview,
          "adversary:a": () => ({
            taskId: "a", ran: true, verdict: "fail", summary: "wrong",
            issues: [{ severity: "blocker", file: "src/x.ts", description: "wrong", evidence: "" }],
            commandsRun: [],
            error: null,
          }),
          "adversary-2:a": () => adversaryPass("nothing found"),
        });
        const r = await loadLoop({ agent, fixAttempts: 0, adversary: codex }).runTask(crewTask, "main");
        expect(labelled(calls, "fix:").length, "not retried at fixAttempts: 0").toBe(0);
        expect(r.attempts[0].adversary.blocked, "seat 1's evidence-free blocker is Codex's own check (run.ts), not this card's: still blocks").toBe(true);
        expect(r.adv.issues[0].severity, "seat 1's issue stays a blocker").toBe("blocker");
        expect(r.adv.issues[0].description, "no adversary-claude downgrade prefix on seat 1's issue").toBe("wrong");
      });

      it("C4: a null from seat 2 resolves rather than throwing; the merge falls back to seat 1", async () => {
        const { agent, calls } = scripted({
          "implement:a": () => implResult,
          "verify:a": () => ({ taskId: "a", passed: true, findings: [] }),
          "review:a": () => passingReview,
          "adversary:a": () => adversaryPass("could not refute"),
          "adversary-2:a": () => null,
        });
        const r = await loadLoop({ agent, fixAttempts: 0, adversary: codex }).runTask(crewTask, "main");
        expect(neverThrew(r.stopReason), "a null seat 2 never surfaces as a throw").toBe(true);
        expect(r.attempts[0].adversary.ran, "resolves; the merge falls back to what seat 1 reported").toBe(true);
        expect(r.attempts[0].adversary.verdict, "seat 1's own verdict, seat 2 dropped").toBe("pass");
        expect(r.attempts[0].adversary.blocked).toBe(false);
        expect(r.adv.summary, "the merge summary lists only the seat that returned something").toBe("seat 1: could not refute");
        expect(labelled(calls, "fix:").length).toBe(0);
      });

      it("C6: with three seats, R12 applies to whichever further seat filed the evidence-free blocker, not just seat 2 or the last seat", async () => {
        // C1 alone leaves "each further seat" unpinned: a mutation that wraps only `seat === 2`, or only
        // `seat === crew.adversaries`, would still pass C1-C4 (both are true for seat 2 of 2). Three seats
        // separate "seat 2" and "the last seat" so each sub-case below catches a different one of those mutations.
        const crewTask3 = { ...task, crew: { adversaries: 3 } };
        const evidenceFreeBlocker = {
          taskId: "a", ran: true, verdict: "fail", summary: "off by one",
          issues: [{ severity: "blocker", file: "src/x.ts", description: "loses the last item", evidence: "" }],
          commandsRun: [{ command: "pnpm test", ok: true, exitCode: 0 }],
          error: null,
        };

        // Sub-case 1: the middle seat (adversary-2, not the last seat) files the evidence-free blocker.
        const { agent: agentA, calls: callsA } = scripted({
          "implement:a": () => implResult,
          "verify:a": () => ({ taskId: "a", passed: true, findings: [] }),
          "review:a": () => passingReview,
          "adversary:a": () => adversaryPass("could not refute"),
          "adversary-2:a": () => evidenceFreeBlocker,
          "adversary-3:a": () => adversaryPass("nothing found"),
        });
        const a = await loadLoop({ agent: agentA, fixAttempts: 3, adversary: codex }).runTask(crewTask3, "main");
        expect(labelled(callsA, "fix:").length, "downgraded away: no fix pass (seat 2 of 3)").toBe(0);
        expect(a.attempts[0].adversary.blocked, "no blocker severity left: not blocked (seat 2 of 3)").toBe(false);
        const majorsA = a.adv.issues.filter((i) => i.severity === "major");
        expect(majorsA.length, "seat 2's issue is downgraded, kept once").toBe(1);
        expect(
          majorsA[0].description.startsWith("[adversary-claude: downgraded from blocker, R12: is a blocker with no evidence"),
          "seat 2 (not the last seat) carries the R12 prefix: catches a mutation wrapping only the last seat",
        ).toBe(true);
        expect(a.adv.issues.some((i) => i.file === ""), "no synthesized blocker (seat 2 of 3)").toBe(false);

        // Sub-case 2: the last seat (adversary-3, not seat 2) files the evidence-free blocker.
        const { agent: agentB, calls: callsB } = scripted({
          "implement:a": () => implResult,
          "verify:a": () => ({ taskId: "a", passed: true, findings: [] }),
          "review:a": () => passingReview,
          "adversary:a": () => adversaryPass("could not refute"),
          "adversary-2:a": () => adversaryPass("nothing found"),
          "adversary-3:a": () => evidenceFreeBlocker,
        });
        const b = await loadLoop({ agent: agentB, fixAttempts: 3, adversary: codex }).runTask(crewTask3, "main");
        expect(labelled(callsB, "fix:").length, "downgraded away: no fix pass (seat 3 of 3)").toBe(0);
        expect(b.attempts[0].adversary.blocked, "no blocker severity left: not blocked (seat 3 of 3)").toBe(false);
        const majorsB = b.adv.issues.filter((i) => i.severity === "major");
        expect(majorsB.length, "seat 3's issue is downgraded, kept once").toBe(1);
        expect(
          majorsB[0].description.startsWith("[adversary-claude: downgraded from blocker, R12: is a blocker with no evidence"),
          "seat 3 (not seat 2) carries the R12 prefix: catches a mutation wrapping only seat === 2",
        ).toBe(true);
        expect(b.adv.issues.some((i) => i.file === ""), "no synthesized blocker (seat 3 of 3)").toBe(false);
      });
    });

    describe("card fallback-evidence-output-citation", () => {
      // packages/doug-codex/src/contract.ts is the source of truth (OUTPUT_CITATION_MIN_CHARS, citedCommands' third
      // arm, and the new reason-B text); the workflow's mirror in enforceFallbackEvidence (used by both the fallback
      // adversary and crew seats 2+) must match it byte for byte. Reuses runFallback, prefixed, NO_COMMAND, and
      // neverThrew from the sibling "card fallback-adversary-blocker-evidence" describe above.
      const contractSource = readFileSync(join(root, "../../packages/doug-codex/src/contract.ts"), "utf8");
      // The real recipe-skills shape (brief of card codex-review-r12-prose-evidence, 02e6f91): prose plus a quoted
      // output line, a double-quoted zsh wrapper command (so innerCommand cannot unwrap it) that exited 1.
      const recipeEvidence =
        'A Node probe created package.json with `scripts:{dev:"",release:""}`, ran detect and generateSkills, and exited 1 after printing `{"detectedScripts":{"dev":"","release":""},"paths":[".claude/skills/doug-skills/SKILL.md"]}`.';
      const recipeCommand = '/bin/zsh -lc "node --input-type=module -e \'...\'"';
      const recipeOutputTail = '{"detectedScripts":{"dev":"","release":""},"paths":[".claude/skills/doug-skills/SKILL.md"]}\n';

      it("F1: the real recipe-skills evidence (prose plus a quoted output line, double-quoted wrapper) stays a blocker", async () => {
        const { r } = await runFallback(() => ({
          taskId: "a", ran: true, verdict: "fail", summary: "recipe skills probe failed",
          issues: [{ severity: "blocker", file: "src/x.ts", description: "wrong", evidence: recipeEvidence }],
          commandsRun: [{ command: recipeCommand, ok: false, exitCode: 1, outputTail: recipeOutputTail }],
          error: null,
        }), { fixAttempts: 0 });
        expect(r.adv.issues[0].severity, "R12 output-citation: a quoted output line >=16 chars cites the command; stays a blocker").toBe("blocker");
        expect(r.adv.downgraded, "R12 output-citation: nothing downgraded").toBeUndefined();
        expect(r.attempts[0].adversary.verdict, "R12 output-citation: a real blocker leaves the fail verdict standing").toBe("fail");
        expect(r.attempts[0].adversary.blocked, "R12 output-citation: still blocks").toBe(true);
      });

      it("F2: the output-citation floor is 16 chars — under it, downgraded with the new reason; at 16 it cites, at 15 it does not", async () => {
        const { r: underFloor } = await runFallback(() => ({
          taskId: "a", ran: true, verdict: "fail", summary: "probe printed ok",
          issues: [{ severity: "blocker", file: "src/x.ts", description: "wrong", evidence: "the probe printed ok 1 and all good, yet the spec wants a failure" }],
          commandsRun: [{ command: "pnpm test", ok: true, exitCode: 0, outputTail: "ok 1\nall good\n" }],
          error: null,
        }), { fixAttempts: 0 });
        expect(underFloor.adv.issues[0].severity, "R12 output-citation floor: quoted lines under 16 chars do not cite; downgraded").toBe("major");
        expect(underFloor.adv.issues[0].description, "R12 output-citation floor: downgraded with the new no-command reason").toBe(prefixed(NO_COMMAND, "wrong"));
        expect(underFloor.attempts[0].adversary.verdict, "R12 output-citation floor: no blocker left, fail flips to pass").toBe("pass");

        const at16 = "abcdefghijklmnop"; // 16 chars, exactly the floor
        const { r: r16 } = await runFallback(() => ({
          taskId: "a", ran: true, verdict: "fail", summary: "off by one",
          issues: [{ severity: "blocker", file: "src/x.ts", description: "wrong", evidence: `the log shows ${at16} clearly` }],
          commandsRun: [{ command: "pnpm probe", ok: false, exitCode: 1, outputTail: `${at16}\n` }],
          error: null,
        }), { fixAttempts: 0 });
        expect(r16.adv.issues[0].severity, "R12 output-citation floor: a 16-char quoted output line cites the command; stays a blocker").toBe("blocker");
        expect(r16.adv.downgraded, "R12 output-citation floor: nothing downgraded at exactly 16 chars").toBeUndefined();

        const at15 = "abcdefghijklmno"; // 15 chars, one under the floor
        const { r: r15 } = await runFallback(() => ({
          taskId: "a", ran: true, verdict: "fail", summary: "off by one",
          issues: [{ severity: "blocker", file: "src/x.ts", description: "wrong", evidence: `the log shows ${at15} clearly` }],
          commandsRun: [{ command: "pnpm probe", ok: false, exitCode: 1, outputTail: `${at15}\n` }],
          error: null,
        }), { fixAttempts: 0 });
        expect(r15.adv.issues[0].severity, "R12 output-citation floor: a 15-char quoted output line does not cite; downgraded").toBe("major");
        expect(r15.adv.issues[0].description, "R12 output-citation floor: downgraded with the new no-command reason at 15 chars").toBe(prefixed(NO_COMMAND, "wrong"));
      });

      it("F3: a blocker quoting a passing, unnamed command's output stays a blocker (output citation is proof on its own)", async () => {
        const { r } = await runFallback(() => ({
          taskId: "a", ran: true, verdict: "fail", summary: "widget exploded",
          issues: [{ severity: "blocker", file: "src/x.ts", description: "wrong", evidence: "the log says warning: widget exploded here, which is the actual defect" }],
          commandsRun: [{ command: "pnpm build", ok: true, exitCode: 0, outputTail: "warning: widget exploded here" }],
          error: null,
        }), { fixAttempts: 0 });
        expect(r.adv.issues[0].severity, "R12 output-citation: the quoted output line is proof even though the command passed and is unnamed").toBe("blocker");
        expect(r.adv.downgraded, "R12 output-citation: nothing downgraded").toBeUndefined();
      });

      it("F4: odd commandsRun entries never throw once the output-citation arm is added", async () => {
        const { r } = await runFallback(() => ({
          taskId: "a", ran: true, verdict: "fail", summary: "off by one",
          issues: [{ severity: "blocker", file: "src/x.ts", description: "wrong", evidence: "the function is wrong" }],
          commandsRun: [null, 42, { command: 7 }, { command: "x", outputTail: 12345, exitCode: 1 }],
          error: null,
        }), { fixAttempts: 0 });
        expect(neverThrew(r.stopReason), "R12 output-citation: odd commandsRun entries (null, a number, a non-string command, a non-string outputTail) resolve rather than throwing").toBe(true);
        expect(r.adv.issues[0].severity, "R12 output-citation: none of the junk entries cites anything; downgraded").toBe("major");
        expect(r.adv.issues[0].description, "R12 output-citation: downgraded with the new no-command reason, not a crash").toBe(prefixed(NO_COMMAND, "wrong"));
      });

      it("F5: OUTPUT_CITATION_MIN_CHARS is 16 in both the workflow mirror and packages/doug-codex/src/contract.ts", () => {
        const workflowMatch = /OUTPUT_CITATION_MIN_CHARS\s*=\s*(\d+)/.exec(source);
        const contractMatch = /OUTPUT_CITATION_MIN_CHARS\s*=\s*(\d+)/.exec(contractSource);
        expect(workflowMatch, "F5: the workflow mirror declares OUTPUT_CITATION_MIN_CHARS").not.toBeNull();
        expect(contractMatch, "F5: contract.ts declares OUTPUT_CITATION_MIN_CHARS").not.toBeNull();
        expect(Number(workflowMatch[1]), "F5: the workflow's floor is 16, matching contract.ts").toBe(16);
        expect(Number(contractMatch[1]), "F5: contract.ts's floor is 16").toBe(16);
      });

      it("F6: a non-string command is never coerced to a string that could match a stray digit in the evidence (citedCommands' command-is-a-string guard)", async () => {
        const { r } = await runFallback(() => ({
          taskId: "a", ran: true, verdict: "fail", summary: "off by one",
          issues: [{ severity: "blocker", file: "src/x.ts", description: "wrong", evidence: "line 7 of the file is wrong" }],
          commandsRun: [{ command: 7, ok: false, exitCode: 1 }],
          error: null,
        }), { fixAttempts: 0 });
        expect(neverThrew(r.stopReason), "F6 guard: a non-string command resolves rather than throwing").toBe(true);
        expect(r.adv.issues[0].severity, "F6 guard: a non-string command (7) is not coerced to \"7\" and matched against a stray digit in the evidence; never cited, downgraded").toBe("major");
        expect(r.adv.issues[0].description, "F6 guard: downgraded with the no-command reason").toBe(prefixed(NO_COMMAND, "wrong"));
      });

      it("F7: quotesOutput's own 4-char floor still applies at the second call site (a named, exited-0 command still needs its output quoted), unaffected by the 16-char citation floor", async () => {
        const { r: r4 } = await runFallback(() => ({
          taskId: "a", ran: true, verdict: "fail", summary: "off by one",
          issues: [{ severity: "blocker", file: "src/x.ts", description: "wrong", evidence: "pnpm test printed 3 failed" }],
          commandsRun: [{ command: "pnpm test", ok: true, exitCode: 0, outputTail: "3 failed\n" }],
          error: null,
        }), { fixAttempts: 0 });
        expect(r4.adv.issues[0].severity, "F7: a named command plus a quoted output line at the 4-char floor stays a blocker").toBe("blocker");
        expect(r4.adv.downgraded, "F7: nothing downgraded at the 4-char floor").toBeUndefined();

        const { r: r3 } = await runFallback(() => ({
          taskId: "a", ran: true, verdict: "fail", summary: "off by one",
          issues: [{ severity: "blocker", file: "src/x.ts", description: "wrong", evidence: "pnpm test printed err" }],
          commandsRun: [{ command: "pnpm test", ok: true, exitCode: 0, outputTail: "err\n" }],
          error: null,
        }), { fixAttempts: 0 });
        expect(r3.adv.issues[0].severity, "F7: a quoted line under the 4-char floor does not satisfy the second check; downgraded").toBe("major");
        expect(r3.adv.issues[0].description, 'F7: reason names the cited command and "quotes none of its output"').toBe(
          prefixed('cites "pnpm test", which exited 0, and quotes none of its output', "wrong"),
        );
      });
    });
  });

  describe("card integration-acceptance-recorded", () => {
    // The final level's integrate stage runs plan.acceptance on the integration branch after the merge and records
    // integration.acceptance: [{ text, command, ok, exitCode }] (mirrors VERIFY_SCHEMA/CHECK_SCHEMA's item shape).
    // enforceIntegrationAcceptance(integration, isLastLevel, entries) is the pure helper both call sites route
    // their integratePrompt() result through before anything reads .ok.
    const entries = acceptanceEntriesFn();
    const twoEntries = [
      { text: "a works", command: "cmd-a" },
      { text: "b works", command: "cmd-b" },
    ];
    const getEnforce = () => new Function(fnSlice("function enforceIntegrationAcceptance(") + "\nreturn enforceIntegrationAcceptance;")();
    const integratePromptOf = (plan, integrationBranch = "doug/integration") => {
      const start = source.indexOf("function integratePrompt(");
      const slice = source.slice(start, source.indexOf("\n}\n", start) + 3);
      return new Function(
        "plan", "integrationBranch", "acceptanceEntries",
        CONSTS + slice + "\nreturn integratePrompt;",
      )(plan, integrationBranch, entries);
    };
    const oneResult = { impl: { branch: "doug/task-a", worktreePath: "/wt/a" } };

    it("S1: INTEGRATE_SCHEMA carries the verifier's acceptance item shape, still not required", () => {
      const start = source.indexOf("const INTEGRATE_SCHEMA");
      const slice = source.slice(start, source.indexOf("\n}\n", start) + 3);
      const INTEGRATE_SCHEMA = new Function(slice + "\nreturn INTEGRATE_SCHEMA;")();
      expect(INTEGRATE_SCHEMA.required).toEqual(["branch", "merged", "conflicts", "verify", "ok"]);
      expect(INTEGRATE_SCHEMA.properties.acceptance).toBeDefined();
      expect(INTEGRATE_SCHEMA.properties.acceptance.type).toBe("array");
      expect(INTEGRATE_SCHEMA.properties.acceptance.items.required).toEqual(["text", "command", "ok", "exitCode"]);
      expect(INTEGRATE_SCHEMA.properties.acceptance.items.properties).toMatchObject({
        text: { type: "string" },
        command: { type: "string" },
        ok: { type: "boolean" },
        exitCode: { type: ["integer", "null"] },
      });
    });

    it("P1: the last level's integrate prompt carries step 3b with every acceptance command and the report/run rule", () => {
      const plan = { title: "P", install: null, verify: ["true"], acceptance: [{ text: "a works", command: "cmd-a" }, { text: "b works", command: "cmd-b" }] };
      const integratePrompt = integratePromptOf(plan);
      const text = integratePrompt(0, [oneResult], "main", true, false, true);
      expect(text).toMatch(/\n3b\./);
      expect(text).toContain("- a works");
      expect(text).toContain("  $ cmd-a");
      expect(text).toContain("- b works");
      expect(text).toContain("  $ cmd-b");
      expect(text).toContain("{ text, command, ok, exitCode }");
      expect(text).toContain("acceptance: []");
      expect(text.toLowerCase()).toContain("did not run");
      expect(text.toLowerCase()).toContain("exactly as written");
    });

    it("P2: an earlier level's prompt never mentions acceptance", () => {
      const plan = { title: "P", install: null, verify: ["true"], acceptance: [{ text: "a works", command: "cmd-a" }] };
      const integratePrompt = integratePromptOf(plan);
      const text = integratePrompt(0, [oneResult], "main", false, false, true);
      expect(text.toLowerCase()).not.toContain("acceptance");
    });

    it("P3: on the last level, step 3b comes before the worktree-removal step, for both keepWorktree values", () => {
      const plan = { title: "P", install: null, verify: ["true"], acceptance: [{ text: "a works", command: "cmd-a" }] };
      const integratePrompt = integratePromptOf(plan);
      for (const keepWorktree of [true, false]) {
        const text = integratePrompt(0, [oneResult], "main", true, keepWorktree, true);
        const i3b = text.indexOf("3b.");
        const i5 = text.indexOf("5. This is the last level");
        expect(i3b, `keepWorktree=${keepWorktree}: step 3b must be present`).toBeGreaterThan(-1);
        expect(i5, `keepWorktree=${keepWorktree}: the worktree-removal step must be present`).toBeGreaterThan(-1);
        expect(i3b, `keepWorktree=${keepWorktree}: 3b must come before the worktree-removal step`).toBeLessThan(i5);
      }
    });

    it("P4: the last level's step 6 names acceptance among what makes ok=true", () => {
      const plan = { title: "P", install: null, verify: ["true"], acceptance: [{ text: "a works", command: "cmd-a" }] };
      const integratePrompt = integratePromptOf(plan);
      const text = integratePrompt(0, [oneResult], "main", true, false, true);
      const line6 = text.split("\n").find((l) => l.startsWith("6."));
      expect(line6, "a step 6 line must exist").toBeDefined();
      expect(line6.toLowerCase()).toContain("acceptance");
    });

    it("P5: a plan with no acceptance commands still gets step 3b, saying acceptance: []", () => {
      const plan = { title: "P", install: null, verify: ["true"], acceptance: [] };
      const integratePrompt = integratePromptOf(plan);
      const text = integratePrompt(0, [oneResult], "main", true, false, true);
      expect(text).toMatch(/\n3b\./);
      expect(text).toContain("acceptance: []");
    });

    it("F7: the last-level prompt carries both round-2 sentences after 'Never report one you did not run' and before the worktree-removal step; an earlier level still has no 'acceptance'", () => {
      const plan = { title: "P", install: null, verify: ["true"], acceptance: [{ text: "a works", command: "cmd-a" }, { text: "b works", command: "cmd-b" }] };
      const integratePrompt = integratePromptOf(plan);
      const text = integratePrompt(0, [oneResult], "main", true, false, true);
      const iNeverReport = text.indexOf("Never report one you did not run");
      const iSentenceA = text.indexOf("Report each command string exactly as it is written above, character for character, even when you ran it behind a cd or git -C prefix: the workflow matches your report to the plan by that string, and a command it cannot match counts as not run and fails the integration.");
      const iSentenceB = text.indexOf("A criterion with no $ line is not yours to judge here: do not report it.");
      const i5 = text.indexOf("5. This is the last level");
      expect(iNeverReport, "the base sentence must be present").toBeGreaterThan(-1);
      expect(iSentenceA, "R5's first sentence must be present").toBeGreaterThan(-1);
      expect(iSentenceB, "R5's second sentence must be present").toBeGreaterThan(-1);
      expect(i5, "the worktree-removal step must be present").toBeGreaterThan(-1);
      expect(iSentenceA).toBeGreaterThan(iNeverReport);
      expect(iSentenceB).toBeGreaterThan(iSentenceA);
      expect(iSentenceB).toBeLessThan(i5);

      const earlier = integratePrompt(0, [oneResult], "main", false, false, true);
      expect(earlier.toLowerCase()).not.toContain("acceptance");
    });

    it("E1: all acceptance items ok leaves ok and reason untouched, keeps acceptance as sent", () => {
      const enforceIntegrationAcceptance = getEnforce();
      const integration = {
        branch: "b", merged: ["x"], conflicts: [], verify: [{ command: "v", ok: true }], ok: true,
        acceptance: [
          { text: "a works", command: "cmd-a", ok: true, exitCode: 0 },
          { text: "b works", command: "cmd-b", ok: true, exitCode: 0 },
        ],
      };
      const result = enforceIntegrationAcceptance(integration, true, twoEntries);
      expect(result.ok).toBe(true);
      expect(result.reason).toBeUndefined();
      expect(result.acceptance).toEqual(integration.acceptance);
    });

    it("E2: one failing acceptance item flips ok false with an exact reason", () => {
      const enforceIntegrationAcceptance = getEnforce();
      const integration = {
        ok: true,
        acceptance: [
          { text: "a works", command: "cmd-a", ok: false, exitCode: 1 },
          { text: "b works", command: "cmd-b", ok: true, exitCode: 0 },
        ],
      };
      const result = enforceIntegrationAcceptance(integration, true, twoEntries);
      expect(result.ok).toBe(false);
      expect(result.reason).toBe("acceptance command failed: a works ($ cmd-a, exit 1)");
    });

    it("E3: two failing items are both named in the reason, joined with '; '", () => {
      const enforceIntegrationAcceptance = getEnforce();
      const integration = {
        ok: true,
        acceptance: [
          { text: "a works", command: "cmd-a", ok: false, exitCode: 1 },
          { text: "b works", command: "cmd-b", ok: false, exitCode: 2 },
        ],
      };
      const result = enforceIntegrationAcceptance(integration, true, twoEntries);
      expect(result.ok).toBe(false);
      expect(result.reason).toBe("acceptance command failed: a works ($ cmd-a, exit 1); b works ($ cmd-b, exit 2)");
    });

    it("E4: a command the agent never reported is appended as a failing item and fails the integration", () => {
      const enforceIntegrationAcceptance = getEnforce();
      const integration = { ok: true, acceptance: [{ text: "a works", command: "cmd-a", ok: true, exitCode: 0 }] };
      const result = enforceIntegrationAcceptance(integration, true, twoEntries);
      // F6/R4 (round 2): an unreported command is distinguished from a real failure by its own reason clause and
      // carries reported: false; this is a goal-driven edit of this card's own round-1 test, not a new mechanism.
      expect(result.acceptance).toContainEqual({ text: "b works", command: "cmd-b", ok: false, exitCode: null, reported: false });
      expect(result.ok).toBe(false);
      expect(result.reason).toBe("acceptance command not reported: b works ($ cmd-b)");
    });

    it("F1: matching trims both sides; the result carries the plan's spelling; exactly one item per plan command", () => {
      const enforceIntegrationAcceptance = getEnforce();
      const integration = {
        ok: true,
        acceptance: [
          { text: "a works", command: "cmd-a", ok: true, exitCode: 0 },
          { text: "b works", command: " cmd-b ", ok: true, exitCode: 0 },
        ],
      };
      const result = enforceIntegrationAcceptance(integration, true, twoEntries);
      expect(result.ok).toBe(true);
      expect(result.acceptance).toHaveLength(2);
      expect(result.acceptance).toContainEqual({ text: "b works", command: "cmd-b", ok: true, exitCode: 0 });
    });

    it("F2: a reported item spelled with a cd/git -C prefix doesn't match; the plan command is appended as not reported", () => {
      const enforceIntegrationAcceptance = getEnforce();
      const integration = {
        ok: true,
        acceptance: [
          { text: "a works", command: "cd .claude/worktrees/doug-integration && cmd-a", ok: true, exitCode: 0 },
          { text: "b works", command: "cmd-b", ok: true, exitCode: 0 },
        ],
      };
      const result = enforceIntegrationAcceptance(integration, true, twoEntries);
      // Exactly one item per plan command, not four for two: the mismatched report is dropped, not kept alongside
      // a synthesized item for the plan's own spelling.
      expect(result.acceptance).toHaveLength(2);
      expect(result.acceptance).toContainEqual({ text: "a works", command: "cmd-a", ok: false, exitCode: null, reported: false });
      expect(result.acceptance).toContainEqual({ text: "b works", command: "cmd-b", ok: true, exitCode: 0 });
      expect(result.ok).toBe(false);
      expect(result.reason).toBe("acceptance command not reported: a works ($ cmd-a)");
    });

    it("F3: a reported prose item with an empty command is dropped and never fails the integration on its own", () => {
      const enforceIntegrationAcceptance = getEnforce();
      const integration = {
        ok: true,
        acceptance: [
          { text: "a works", command: "cmd-a", ok: true, exitCode: 0 },
          { text: "b works", command: "cmd-b", ok: true, exitCode: 0 },
          { text: "looks fine to me", command: "", ok: false, exitCode: null },
        ],
      };
      const result = enforceIntegrationAcceptance(integration, true, twoEntries);
      expect(result.acceptance).toHaveLength(2);
      expect(result.ok).toBe(true);
      expect(result.reason).toBeUndefined();
    });

    it("F9: a mixed plan's prose entry (command: null) is skipped, leaving only the command item; an all-prose plan reports empty acceptance", () => {
      const enforceIntegrationAcceptance = getEnforce();
      const mixedEntries = [
        { text: "looks fine to me", command: null },
        { text: "a works", command: "cmd-a" },
      ];
      const integration = {
        ok: true,
        acceptance: [{ text: "a works", command: "cmd-a", ok: true, exitCode: 0 }],
      };
      const result = enforceIntegrationAcceptance(integration, true, mixedEntries);
      expect(result.acceptance).toEqual([{ text: "a works", command: "cmd-a", ok: true, exitCode: 0 }]);
      expect(result.ok).toBe(true);
      expect(result.reason).toBeUndefined();

      const proseOnlyEntries = [{ text: "looks fine to me", command: null }];
      const proseIntegration = { ok: true, acceptance: [] };
      const proseResult = enforceIntegrationAcceptance(proseIntegration, true, proseOnlyEntries);
      expect(proseResult.acceptance).toEqual([]);
      expect(proseResult.ok).toBe(true);
      expect(proseResult.reason).toBeUndefined();
    });

    it("F4: a failed report and an unreported command combine, failed clause first, then not-reported, joined with '; '", () => {
      const enforceIntegrationAcceptance = getEnforce();
      const integration = {
        ok: true,
        acceptance: [{ text: "a works", command: "cmd-a", ok: false, exitCode: 2 }],
      };
      const result = enforceIntegrationAcceptance(integration, true, twoEntries);
      expect(result.ok).toBe(false);
      expect(result.reason).toBe("acceptance command failed: a works ($ cmd-a, exit 2); acceptance command not reported: b works ($ cmd-b)");
    });

    it("F5: reported items carry no reported key; only a synthesized (unreported) item has reported: false", () => {
      const enforceIntegrationAcceptance = getEnforce();
      const integration = {
        ok: true,
        acceptance: [{ text: "a works", command: "cmd-a", ok: true, exitCode: 0 }],
      };
      const result = enforceIntegrationAcceptance(integration, true, twoEntries);
      const reportedItem = result.acceptance.find((item) => item.command === "cmd-a");
      const syntheticItem = result.acceptance.find((item) => item.command === "cmd-b");
      expect(reportedItem).toBeDefined();
      expect(syntheticItem).toBeDefined();
      expect("reported" in reportedItem).toBe(false);
      expect(syntheticItem.reported).toBe(false);
    });

    it("E5: not the last level strips any acceptance key and leaves ok untouched", () => {
      const enforceIntegrationAcceptance = getEnforce();
      const integration = { ok: true, acceptance: ["whatever the agent sent"] };
      const result = enforceIntegrationAcceptance(integration, false, twoEntries);
      expect(result.ok).toBe(true);
      expect("acceptance" in result).toBe(false);
    });

    it("E6: a plan with no acceptance commands gives acceptance: [] and never fails here", () => {
      const enforceIntegrationAcceptance = getEnforce();
      const integration = { ok: true };
      const result = enforceIntegrationAcceptance(integration, true, []);
      expect(result.acceptance).toEqual([]);
      expect(result.ok).toBe(true);
      expect(result.reason).toBeUndefined();
    });

    it("E7: odd shapes (null, a string, a non-array acceptance, non-object items) never throw and give a sensible result", () => {
      const enforceIntegrationAcceptance = getEnforce();
      expect(() => enforceIntegrationAcceptance(null, true, twoEntries)).not.toThrow();
      expect(enforceIntegrationAcceptance(null, true, twoEntries)).toBeNull();
      expect(() => enforceIntegrationAcceptance("weird", true, twoEntries)).not.toThrow();
      expect(enforceIntegrationAcceptance("weird", true, twoEntries)).toBe("weird");

      const nonArray = enforceIntegrationAcceptance({ ok: true, acceptance: "not-an-array" }, true, twoEntries);
      expect(Array.isArray(nonArray.acceptance)).toBe(true);
      expect(nonArray.acceptance).toHaveLength(2);
      expect(nonArray.ok).toBe(false);

      const withJunkItems = enforceIntegrationAcceptance(
        { ok: true, acceptance: [null, 42, { text: "a works", command: "cmd-a", ok: true, exitCode: 0 }] },
        true,
        twoEntries,
      );
      expect(withJunkItems.acceptance.every((item) => item && typeof item === "object")).toBe(true);
      expect(withJunkItems.acceptance).toContainEqual({ text: "a works", command: "cmd-a", ok: true, exitCode: 0 });
      expect(withJunkItems.acceptance).toContainEqual({
        text: "b works",
        command: "cmd-b",
        ok: false,
        exitCode: null,
        reported: false,
      });
      expect(withJunkItems.ok).toBe(false);
    });

    it("E8: never mutates its argument", () => {
      const enforceIntegrationAcceptance = getEnforce();
      const integration = { ok: true, acceptance: [{ text: "a works", command: "cmd-a", ok: false, exitCode: 1 }] };
      const clone = JSON.parse(JSON.stringify(integration));
      enforceIntegrationAcceptance(integration, true, twoEntries);
      expect(integration).toEqual(clone);
    });

    it("C1: both integrate call sites route their result through enforceIntegrationAcceptance before anything reads .ok", () => {
      const site1 = source.indexOf("retryOnce(integratePrompt(li, ready, baseBranch, li === levels.length - 1,");
      expect(site1, "call site 1 (first integration) not found").toBeGreaterThan(-1);
      const stmt1Start = source.lastIndexOf("integration = ", site1);
      const ok1 = source.indexOf("if (integration && integration.ok) {", stmt1Start);
      const enforce1 = source.indexOf("enforceIntegrationAcceptance(", stmt1Start);
      expect(enforce1, "call site 1 must call enforceIntegrationAcceptance").toBeGreaterThan(-1);
      expect(enforce1, "call site 1: enforceIntegrationAcceptance must run before the integration.ok check").toBeLessThan(ok1);

      const site2 = source.indexOf("retryOnce(integratePrompt(li, fixedReady, levelBase, li === levels.length - 1, true, false)");
      expect(site2, "call site 2 (re-integration) not found").toBeGreaterThan(-1);
      const stmt2Start = source.lastIndexOf("const again = ", site2);
      const ok2 = source.indexOf("if (again && again.ok)", stmt2Start);
      const enforce2 = source.indexOf("enforceIntegrationAcceptance(", stmt2Start);
      expect(enforce2, "call site 2 (re-integration) must call enforceIntegrationAcceptance").toBeGreaterThan(-1);
      expect(enforce2, "call site 2: enforceIntegrationAcceptance must run before again.ok is read").toBeLessThan(ok2);
    });
  });

  describe("card ledger-nonblocking-notes-hold-integration", () => {
    // Fixture strings below are copied verbatim from .doug/.state/briefs/ledger-run-strings.json (run
    // wf_cb484cb2-93d, task python-detect), the two pass results the card's brief cites. The tester never
    // paraphrases them.
    const p1RealDefect =
      "Dependency-line detection misses single-line (inline) dependency arrays, the most common PEP 621 / PEP 735 form. Spec: testFramework is pytest when \"the text 'pytest' appears in a dependency line of pyproject.toml or any root requirements*.txt\", and the same wording for ruff/black. Observed, via an independent probe calling detect() on a temp repo whose only file is pyproject.toml containing `[project]\ndependencies = [\"pytest>=7\", \"ruff>=0.1\", \"black>=24\"]`: testFramework null, linter null, formatter null (expected pytest / ruff / ruff-format). Same null result for `[dependency-groups]\ndev = [\"pytest\", \"ruff\"]`. Multi-line arrays, poetry table entries and requirements.txt lines do match. Cause: dependencyMentioned() in packages/doug-cli/src/detect/python.ts anchors the package name at the start of a trimmed line (`^[\\s\"'-]*<name>\\b`), so a name inside `dependencies = [...]` on one line never matches — even though the module comment claims it \"Matches array entries like \\\"pytest>=7.0\\\",\". No test in detect-python.test.ts exercises a dependency-mention-only project (the uv fixture uses `dependencies = []` plus explicit [tool.*] tables), so the gap is unpinned. Consequence: a uv/pip project that declares pytest and ruff inline gets commands.test, commands.lint, formatter and both single-test commands null, which is what the downstream config/anchor tasks consume.";
    const p1AcceptanceWait1 =
      "Acceptance commands 2, 3, 5 and 6 fail only because the files they name do not exist yet on this branch: packages/doug-cli/tests/python-config.test.ts, tests/python-surfaces.test.ts and tests/python-init.test.ts are not in this task's owned list (vitest exits 1 with 'No test files found'), and acceptance 6 exits 1 at the first missing of those three files. detect-python.test.ts itself contains no node:child_process. These wait on the later generator/fixture/surface tasks of the plan and do not fail this task.";
    const p1AcceptanceWait2 =
      "Acceptance command 4 fails because packages/doug-cli/tests/fixtures/py-uv does not exist on this branch; the fixture is not in this task's owned list and waits on the later fixture task. Does not fail this task.";
    const p1NitEgg =
      "Non-blocking nit (no fix required unless the planner disagrees): generatedDirs only lists a root *.egg-info entry when it is a directory (isDir filter), while the spec says \"any root entry ending in .egg-info\"; a file named x.egg-info is dropped. Real egg-info entries are directories.";
    const p1NitBlack =
      "Non-blocking nit: the black signal is read from pyproject.toml only; \"black\" in a root requirements*.txt produces no formatter (probe: a repo whose only file is requirements.txt containing `black==24.1` gives formatter null). The spec spells out \"pyproject.toml or a root requirements*.txt\" for ruff but only \"a dependency line\" for black, so this reading is defensible.";
    const p1Praise =
      "Everything else I probed matches the spec: manager precedence uv>poetry>pdm>pipenv>hatch>pip with notes naming both markers; poetry via poetry-core in [build-system] requires; run prefixes and prefixed command strings; pip install -r sorted-first requirements file, pip install -e . fallback, null when neither; full hatch command/formatter suppression with linter/typeChecker/testFramework retained and the note; pytest config precedence incl. bare pytest.ini, tox.ini [pytest], setup.cfg [tool:pytest]; ruff suppressing black with a note; mypy src vs mypy . by srcLayout; .venv/bin and .venv/Scripts; .python-version then requires-python; migrations at two levels from root and from src/ with node_modules/dot-dirs skipped plus alembic/versions; generated dirs sorted; empty/malformed/CRLF pyproject handled without throwing; present:false returns the exact empty record with no notes. Scope and commit trailers are clean; typecheck and test:unit both pass.";
    const p2F1Fixed =
      "F1 fixed: dependencyMentioned() now also matches a quoted name anywhere in the line. Independent probe (vitest run against the worktree's detect/index.js from a scratch config, temp repo whose only file is pyproject.toml with `[project]\ndependencies = [\"pytest>=7\", \"ruff>=0.1\", \"black>=24\"]`) returns testFramework \"pytest\", commands.test \"pytest\", singleTestCommand \"pytest <path/to/test_file.py>\", singleTestNodeIdCommand \"pytest <path/to/test_file.py>::<test_name>\", linter \"ruff\", formatter {name:\"ruff\",command:\"ruff format .\"}, commands.lint \"ruff check .\", commands.formatCheck \"ruff format --check .\". `[dependency-groups] dev = [\"pytest\", \"ruff\"]` gives the same. Multi-line arrays, poetry table entries, requirements.txt lines, CRLF pyproject, and hatch command suppression are unchanged (probed). The gap is now pinned by a new test, \"detect python: inline (single-line) dependency arrays\", in packages/doug-cli/tests/detect-python.test.ts.";
    const p2F2Waived =
      "F2 waived (unchanged, and the finding itself records it as a non-blocking nit needing no fix): probe on a repo with setup.py plus a regular file named x.egg-info still gives generatedDirs []. Real .egg-info entries are directories, so no behavioral consequence; not counted open.";
    const p2F3Waived =
      "F3 waived (unchanged, and the finding itself records it as a defensible non-blocking nit): probe on a repo whose only file is requirements.txt containing `black==24.1` still gives formatter null and commands.formatCheck null. The spec names \"a dependency line\" for black without naming requirements files; not counted open.";
    const p2F4Fixed =
      "F4 fixed: reconfirmed on this pass. Manager precedence with notes, poetry-core build-system detection, run prefixes and prefixed commands, pip install -r / -e . fallbacks, full hatch suppression (probe: hatch.toml plus inline pytest+ruff deps gives every commands.* null, singleTestCommand null, formatter null, while linter \"ruff\", typeChecker, testFramework \"pytest\" remain), pytest config precedence, mypy src vs ., venv layouts, .python-version vs requires-python, migration and generated dirs, malformed/CRLF handling, present:false empty record: all pass via packages/doug-cli/tests/detect-python.test.ts (17 tests, exit 0) plus my probes. Scope clean (only the two owned files), commit message carries no Co-Authored-By/Claude-Session trailer, pnpm typecheck exit 0 and pnpm test:unit exit 0 (2123 passed).";
    const p2AcceptanceWait =
      "Acceptance commands 2, 3, 5 and 6 exit 1 only because packages/doug-cli/tests/python-config.test.ts, python-surfaces.test.ts and python-init.test.ts do not exist yet; acceptance 4 exits 1 because packages/doug-cli/tests/fixtures/py-uv does not exist. None of those paths is in this task's owned list, so they wait on the later plan tasks (the config/anchor generator task, the surfaces task, the py-uv fixture + init task). detect-python.test.ts itself exists and contains no node:child_process (grep count 0), so this task's share of criterion 6 holds.";
    const p2MinorNote =
      "New minor observed in the fix delta (not a blocker, reported for the planner): the added quoted-mention regex `[\"']\\s*<name>\\b` is position-blind within a line, so a quoted mention outside a dependency array also fires. Probe: pyproject.toml with `[project]\nname = \"app\"\nkeywords = [\"pytest\", \"black\"]\ndependencies = []` returns testFramework \"pytest\" and formatter {name:\"black\",command:\"black .\"} even though nothing is depended on. `classifiers = [\"Framework :: Pytest\"]` and `packages = [\"ruffles\"]` correctly do not match.";
    // Card d-waiver-structural-rule: a plain, non-self-declared (blocking) ledger description, used by the W1-W3
    // tests below so a disputed waiver has a real defect to be tested against.
    const blockingDesc = "generatedDirs drops a root x.egg-info file; spec says any root entry ending in .egg-info.";

    // isReady is inside the startTask..runTask block; a standalone slice gives the guard test the real function.
    // Its last line calls adversaryOk(r.adv, adversaryRequired(r.task)), so those two are wired in for real
    // (round 2 R3: the readiness assertion must be built on an otherwise-ready result, not just the early
    // returns, so isReady has to actually reach that line) - adversaryRequired stubbed to "no adversary
    // configured" (adversaryOk(null, false) is true) since these tests are about the ledger fields, not the
    // adversary.
    const isReadyFn = new Function(
      "adversaryOk", "adversaryRequired",
      fnSlice("function isReady(") + "\nreturn isReady;",
    )(new Function(adversaryOkSource() + "\nreturn adversaryOk;")(), () => false);
    // An otherwise-ready result the way the existing loop tests build one: implementer not blocked/partial,
    // verifier passed, reviewer approved, no adversary required.
    const readyResult = (extra) => ({ impl: { blocked: false, partial: false }, ver: { passed: true }, rev: { approve: true }, adv: null, task: {}, reopened: [], openFindings: [], ...extra });

    it("P1: a verifier finding that declares itself non-blocking is never opened as a ledger blocker, even from a failed stage, and the drop reason is recorded [mutation M1, round 2 R3]", () => {
      const { updateLedger } = ledgerModule();
      const pyTask = { id: "python-detect", files: ["packages/doug-cli/src/detect/python.ts", "packages/doug-cli/tests/detect-python.test.ts"] };
      const ledger = [];
      const r = { task: pyTask, stages: ["verify"], commit: "c1", stageResults: { verify: { passed: false, findings: [p1RealDefect, p1NitEgg, p1NitBlack], acceptance: [] } } };
      const u = updateLedger(ledger, r, 1, true);
      expect(u.opened, "only the real defect opens; the two self-declared non-blocking nits do not, even though the stage failed").toEqual(["F1"]);
      expect(ledger.map((e) => e.description)).toEqual([p1RealDefect]);
      expect(ledger.some((e) => e.description === p1NitEgg), "the egg-info nit must never become a ledger entry").toBe(false);
      expect(ledger.some((e) => e.description === p1NitBlack), "the black nit must never become a ledger entry").toBe(false);
      // R3: the drop reason itself, not just the absence of a ledger entry.
      expect(u.dropped.find((d) => d.description === p1NitEgg), "egg-info nit dropped as 'non-blocking'").toMatchObject({ why: "non-blocking" });
      expect(u.dropped.find((d) => d.description === p1NitBlack), "black nit dropped as 'non-blocking'").toMatchObject({ why: "non-blocking" });
    });

    it("P1 (round 2 R1): the anchor is a leading self-declaration, not the word anywhere - real defects that merely contain 'non-blocking', including at the very start of the sentence, still open [mutations M1b, MR1]", () => {
      const { updateLedger } = ledgerModule();
      const pyTask = { id: "python-detect", files: ["src/fetch.ts"] };
      const anchorLeak1 = "The non-blocking path in fetch() still drops the error.";
      const anchorLeak2 = "BLOCKER: the retry queue is fine, but the earlier non-blocking nit is now a crash.";
      // R1 must-keep prose: each starts with the literal word "non-blocking" but is not one of the accepted
      // self-declaration shapes (not "nit|note|observation|comment|remark", not immediately followed by
      // ':' ',' '(' or ' - '), so a regex that accepts the bare adjective (mutation MR1) would wrongly drop these.
      const keep1 = "Non-blocking reads return 0 bytes and the caller treats that as EOF, truncating the file.";
      const keep2 = "Non-blocking IO path drops the error when the socket closes early.";
      const keep3 = "Non-blocking in name only: this crashes on an empty array.";
      // Round 3: a comma after "Non-blocking" is prose punctuation here, not shape b's self-declaration comma -
      // the coder is narrowing shape b to ':' and ' - ' only, so this stays red until that lands. The parenthetical
      // here is "(async)", not one of shape d's fixed labels, and is preceded by a space (not "directly followed"
      // as shape b's '(' requires), so it was never a self-declaration either way.
      const keep4 = "Non-blocking, buffered writes lose the last chunk when the stream closes.";
      const keep5 = "Non-blocking (async) reads return 0 bytes at EOF, truncating the file.";
      const ledger = [];
      const findings = [anchorLeak1, anchorLeak2, keep1, keep2, keep3, keep4, keep5];
      const r = { task: pyTask, stages: ["verify"], commit: "c1", stageResults: { verify: { passed: false, findings, acceptance: [] } } };
      const u = updateLedger(ledger, r, 1, true);
      expect(u.opened, "every one of these seven real defects opens, even though each mentions 'non-blocking'").toEqual(["F1", "F2", "F3", "F4", "F5", "F6", "F7"]);
      expect(ledger.map((e) => e.description)).toEqual(findings);
      expect(u.dropped).toEqual([]);
    });

    it("P1 (round 2 R1): self-declaration shapes b, c, d, e, and the unhyphenated spelling all drop as 'non-blocking' [mutation MR1d]", () => {
      const { updateLedger } = ledgerModule();
      const pyTask = { id: "python-detect", files: ["src/x.ts"] };
      const shapeB = "Non-blocking: the comment is stale";
      const shapeC = "Minor, non-blocking nit: the docstring is stale.";
      const shapeD = "Nit (non-blocking): the comment says pytest but the code checks unittest.";
      const shapeE = "[non-blocking] the note above is cosmetic.";
      const unhyphenated = "Non blocking nit: x";
      const shapes = [shapeB, shapeC, shapeD, shapeE, unhyphenated];
      const ledger = [];
      const r = { task: pyTask, stages: ["verify"], commit: "c1", stageResults: { verify: { passed: false, findings: shapes, acceptance: [] } } };
      const u = updateLedger(ledger, r, 1, true);
      expect(u.opened, "none of these self-declared non-blocking notes opens a ledger entry").toEqual([]);
      expect(ledger).toEqual([]);
      expect(u.dropped.map((d) => d.why)).toEqual(shapes.map(() => "non-blocking"));
      expect(u.dropped.map((d) => d.description)).toEqual(shapes);
    });

    it("P2: idReport reads a leading waived/non-blocking/advisory clause as verdict 'waived', checked before the open-word test [mutations M2, M2b, MR2b]", () => {
      const { idReport } = ledgerModule();
      // Both real strings say 'still' later in the clause: an open-word test run first, or a deleted waived
      // branch, reads 'open' instead.
      expect(idReport(p2F2Waived)).toEqual({ id: "F2", verdict: "waived" });
      expect(idReport(p2F3Waived)).toEqual({ id: "F3", verdict: "waived" });
      expect(idReport("F3 is waived")).toEqual({ id: "F3", verdict: "waived" });
      expect(idReport("F2: advisory only")).toEqual({ id: "F2", verdict: "waived" });
      // Round 2 R2: the waived-start set also knows "non-blocking" itself (mutation MR2b removes it), through
      // an optional leading ':'/','/'-'/whitespace, an optional copula (is/was/remains/stays/is still/still),
      // and an optional article (a/an).
      expect(idReport("F2: non-blocking, unchanged.")).toEqual({ id: "F2", verdict: "waived" });
      expect(idReport("F3 remains a non-blocking nit needing no fix: the probe still gives formatter null.")).toEqual({ id: "F3", verdict: "waived" });
      expect(idReport("F2 is still a non-blocking nit, no fix required.")).toEqual({ id: "F2", verdict: "waived" });
      // "unchanged (" only counts as a waived-start when the same clause also says non-blocking/nit (the real
      // string with 'waived' swapped for 'unchanged').
      expect(idReport("F2 unchanged (the finding itself records it as a non-blocking nit needing no fix): probe still gives [].")).toEqual({ id: "F2", verdict: "waived" });
    });

    it("P2 (round 2 R2, negative): a waived-looking word that is not at the start of the clause stays 'open'; 'fixed' is never stolen by a mid-clause 'waived' [mutation MR2a]", () => {
      const { idReport } = ledgerModule();
      // MR2a: the anchor requires the (copula/article-stripped) clause to START with a waived word. "waived"
      // appearing later in the clause must not match once the anchor is removed.
      expect(idReport("F2 was wrongly waived: the probe still returns 1.")).toEqual({ id: "F2", verdict: "open" });
      expect(idReport("F2: the implementer waived this, but I disagree - still returns 1.")).toEqual({ id: "F2", verdict: "open" });
      // A genuine negation stays open via the existing open-word path.
      expect(idReport("F2 is not waived")).toEqual({ id: "F2", verdict: "open" });
      expect(idReport("F2 cannot be waived: still returns 1.")).toEqual({ id: "F2", verdict: "open" });
      expect(idReport("F2 should not be waived.")).toEqual({ id: "F2", verdict: "open" });
      // The clause here does not start with a waived word ("the advisory note..."), so 'fixed' still wins.
      expect(idReport("F2 fixed: the advisory note no longer applies.")).toEqual({ id: "F2", verdict: "fixed" });
      // Round 3: "unchanged (" only counts as a waived-start when the same clause also says non-blocking/nit;
      // here it says neither, so this stays 'open' on the existing open-word path ('still').
      expect(idReport("F2 unchanged (see the previous pass): still returns 1.")).toEqual({ id: "F2", verdict: "open" });
    });

    it("card d-waiver-structural-rule: idReport no longer vetoes a disputed waiver by wording - a clause that starts on a recognised waived word reads 'waived' whatever else it says; only the ledger's own recorded description (confirmsFinding/updateLedger below) decides whether that waiver is honoured [mutation MW4]", () => {
      const { idReport } = ledgerModule();
      // These two are the round 2 R2 MR2c fixtures: a but/wrongly/disagree/now-required veto used to cancel the
      // waived reading here. The reviewer's round 2 (408192d) then tried 12/12 other disputing phrasings the word
      // list never covered - "F2 waived incorrectly: still returns 1." reads 'waived' by idReport exactly the
      // same way, which is why the veto could never be extended to cover them: the fix removes the veto instead
      // (mutation MW4 reinstates it, turning all three back to 'open' and failing this test).
      expect(idReport("F2 not counted open by the implementer but still reproduces.")).toEqual({ id: "F2", verdict: "waived" });
      expect(idReport("F2: advisory only in the old spec, now required and still failing.")).toEqual({ id: "F2", verdict: "waived" });
      expect(idReport("F2 waived incorrectly: still returns 1.")).toEqual({ id: "F2", verdict: "waived" });
    });

    it("P2 (round 2 R2) loop-level: a fully passing check writing 'F3 remains a non-blocking nit...' against a fixed F3 does not reopen it [mutation MR2b]", () => {
      const { updateLedger } = ledgerModule();
      const pyTask = { id: "python-detect", files: ["packages/doug-cli/src/detect/python.ts"] };
      const fixedF3 = { id: "F3", fingerprint: "verify|python.ts|black-formatter", stage: "verify", invariant: "verification", severity: "blocker", file: "", line: null, description: p1NitBlack, evidence: null, status: "fixed", openedPass: 1, fixedPass: 1, fixedCommit: "c1", confirmedBy: "check", reappeared: false };
      const ledger = [fixedF3];
      const r = { task: pyTask, stages: ["check"], commit: "c2", stageResults: { check: { passed: true, findings: ["F3 remains a non-blocking nit needing no fix: the probe still gives formatter null."], commandsRun: [], acceptance: [], issues: [], inScope: true } } };
      const u = updateLedger(ledger, r, 2, true);
      expect(u.reopened, "a re-report anchored on 'non-blocking' (not the word 'waived') must not reopen the entry it names").toEqual([]);
      expect(ledger.find((e) => e.id === "F3").status).toBe("fixed");
    });

    it("card d-waiver-structural-rule: confirmsFinding honours a 'waived' verdict only when the ledger's own entry for that id is a self-declared non-blocking note - not by the finding's own wording, and never with no ledger to check against [mutations MW1, MW2]", () => {
      const { confirmsFinding } = ledgerModule();
      const ledger = [
        { id: "F2", description: p1NitEgg },
        { id: "F3", description: p1NitBlack },
      ];
      expect(confirmsFinding({ description: p2F2Waived, confirms: false }, ledger)).toBe(true);
      expect(confirmsFinding({ description: p2F3Waived, confirms: false }, ledger)).toBe(true);
      // No ledger passed at all: nothing to check the waiver against, so it does not confirm (mutation MW2 - honour
      // no waived verdict at all - is also indistinguishable here; W4 below pins the true side of the predicate).
      expect(confirmsFinding({ description: p2F2Waived, confirms: false })).toBe(false);
      // The ledger holds F2, but its own recorded description is a real (blocking) defect, not a self-declared
      // non-blocking note: mutation MW1 (honour every waived verdict, dropping the ledger/predicate check) would
      // wrongly confirm this.
      const blockingLedger = [{ id: "F2", description: blockingDesc }];
      expect(confirmsFinding({ description: p2F2Waived, confirms: false }, blockingLedger)).toBe(false);
    });

    it("W1 (card d-waiver-structural-rule): a disputed waiver against an open, blocking (not self-declared non-blocking) ledger entry stays open, not fixed [mutation MW1]", () => {
      const { updateLedger } = ledgerModule();
      const pyTask = { id: "python-detect", files: ["packages/doug-cli/src/detect/python.ts"] };
      const openF2 = { id: "F2", fingerprint: "verify|python.ts|egg-info-file", stage: "verify", invariant: "verification", severity: "blocker", file: "", line: null, description: blockingDesc, evidence: null, status: "open", openedPass: 1, fixedPass: null, fixedCommit: null, confirmedBy: null, reappeared: false };
      const ledger = [openF2];
      const r = { task: pyTask, stages: ["check"], commit: "c2", stageResults: { check: { passed: true, findings: ["F2 waived incorrectly: still returns 1."], commandsRun: [], acceptance: [], issues: [], inScope: true } } };
      const u = updateLedger(ledger, r, 2, true);
      expect(u.fixed, "the entry's own description is not a self-declared non-blocking note, so the disputed waiver does not close it").not.toContain("F2");
      expect(ledger.find((e) => e.id === "F2").status).toBe("open");
    });

    it("W2 (card d-waiver-structural-rule): a second disputing phrasing against the same kind of entry also stays open [mutation MW1]", () => {
      const { updateLedger } = ledgerModule();
      const pyTask = { id: "python-detect", files: ["packages/doug-cli/src/detect/python.ts"] };
      const openF2 = { id: "F2", fingerprint: "verify|python.ts|egg-info-file", stage: "verify", invariant: "verification", severity: "blocker", file: "", line: null, description: blockingDesc, evidence: null, status: "open", openedPass: 1, fixedPass: null, fixedCommit: null, confirmedBy: null, reappeared: false };
      const ledger = [openF2];
      const r = { task: pyTask, stages: ["check"], commit: "c2", stageResults: { check: { passed: true, findings: ["F2 not counted open by the implementer, however it still reproduces."], commandsRun: [], acceptance: [], issues: [], inScope: true } } };
      const u = updateLedger(ledger, r, 2, true);
      expect(u.fixed, "this phrasing has no word-list veto word either ('however', not 'but'), yet the structural rule still keeps it open").not.toContain("F2");
      expect(ledger.find((e) => e.id === "F2").status).toBe("open");
    });

    it("W3 (card d-waiver-structural-rule): a waiver the finding's own words self-declare, against an entry whose own recorded description does not, reopens the fixed entry - the entry's description decides, not the finding's [mutation MW3, MW3b]", () => {
      const { updateLedger } = ledgerModule();
      const pyTask = { id: "python-detect", files: ["packages/doug-cli/src/detect/python.ts"] };
      const fixedF2 = { id: "F2", fingerprint: "verify|python.ts|egg-info-file", stage: "verify", invariant: "verification", severity: "blocker", file: "", line: null, description: blockingDesc, evidence: null, status: "fixed", openedPass: 1, fixedPass: 1, fixedCommit: "c1", confirmedBy: "check", reappeared: false };
      const ledger = [fixedF2];
      // MW3b: falling back to the finding's own id-stripped text ("non-blocking: unchanged, still returns 1.")
      // when the entry's description does not self-declare would also honour this waiver, since that stripped
      // text itself matches the shape-b anchor ("non-blocking" immediately followed by ':'). Only the entry's own
      // recorded description may decide.
      const r = { task: pyTask, stages: ["check"], commit: "c2", stageResults: { check: { passed: true, findings: ["F2 non-blocking: unchanged, still returns 1."], commandsRun: [], acceptance: [], issues: [], inScope: true } } };
      const u = updateLedger(ledger, r, 2, true);
      expect(u.reopened, "the entry's own recorded description decides the waiver, not the finding's self-declaring text").toEqual(["F2"]);
      expect(ledger.find((e) => e.id === "F2").status).toBe("open");
    });

    it("P2: a waived report is not a re-report - it never reopens a fixed entry, even from a failing stage where the finding's own blocking flag is true [mutation M2; also W2/MW2 - the entry's description (p1NitEgg) is a self-declared non-blocking note, so the waiver must still be honoured]", () => {
      const { updateLedger } = ledgerModule();
      const pyTask = { id: "python-detect", files: ["packages/doug-cli/src/detect/python.ts"] };
      const fixedF2 = { id: "F2", fingerprint: "verify|python.ts|egg-info", stage: "verify", invariant: "verification", severity: "blocker", file: "", line: null, description: p1NitEgg, evidence: null, status: "fixed", openedPass: 1, fixedPass: 1, fixedCommit: "c1", confirmedBy: "check", reappeared: false };
      const ledger = [fixedF2];
      // The stage overall fails (an unrelated blocker elsewhere), so every plain finding it reports - including
      // this waived one - carries blocking: true; only the waived verdict, not the blocking flag, must stop it.
      const r = { task: pyTask, stages: ["check"], commit: "c2", stageResults: { check: { passed: false, findings: [p2F2Waived], commandsRun: [], acceptance: [], issues: [{ severity: "minor", file: "x", description: "unrelated" }], inScope: true } } };
      const u = updateLedger(ledger, r, 2, true);
      expect(u.reopened, "a waived report must not reopen the entry it names").toEqual([]);
      expect(ledger.find((e) => e.id === "F2").status).toBe("fixed");
    });

    it("W4 / P2: a passing check that waives an open entry whose own description is a self-declared non-blocking note closes it through the covering-stage absence rule, not by opening it further [mutation M2; MW2]", () => {
      const { updateLedger } = ledgerModule();
      const pyTask = { id: "python-detect", files: ["packages/doug-cli/src/detect/python.ts"] };
      const openF2 = { id: "F2", fingerprint: "verify|python.ts|egg-info", stage: "verify", invariant: "verification", severity: "blocker", file: "", line: null, description: p1NitEgg, evidence: null, status: "open", openedPass: 1, fixedPass: null, fixedCommit: null, confirmedBy: null, reappeared: false };
      const ledger = [openF2];
      const r = { task: pyTask, stages: ["check"], commit: "c2", stageResults: { check: { passed: true, findings: [p2F2Waived], commandsRun: [], acceptance: [], issues: [], inScope: true } } };
      const u = updateLedger(ledger, r, 2, true);
      expect(u.fixed, "the covering stage's absence of a real re-report closes the entry, the same as if nothing had mentioned it").toContain("F2");
      expect(ledger.find((e) => e.id === "F2").status).toBe("fixed");
    });

    // P3 was dropped: it would have made a non-blocking re-report of a passing stage never reopen a fixed entry,
    // but that contradicts "still reopens and keeps entries on a real re-report" (~line 2503) and "blocks the
    // pass when a finding the ledger recorded as fixed comes back" (~line 2186), which pin unconditional
    // reopening on any re-report as deliberate. P1 + P2 alone close the incident.

    it("G (guard): a genuinely reappeared blocker still reopens and holds readiness - a failed check reporting 'F2: still returns 1' against a fixed F2 reopens it [mutation MG]", () => {
      const { updateLedger } = ledgerModule();
      const pyTask = { id: "python-detect", files: ["packages/doug-cli/src/detect/python.ts"] };
      const fixedF2 = { id: "F2", fingerprint: "check|python.ts|returns 1", stage: "check", invariant: "verification", severity: "blocker", file: "packages/doug-cli/src/detect/python.ts", line: null, description: "packages/doug-cli/src/detect/python.ts: returns 1", evidence: null, status: "fixed", openedPass: 1, fixedPass: 1, fixedCommit: "c1", confirmedBy: "check", reappeared: false };
      const ledger = [fixedF2];
      const r = { task: pyTask, stages: ["check"], commit: "c2", stageResults: { check: { passed: false, findings: ["F2: still returns 1"], commandsRun: [], acceptance: [], issues: [], inScope: true } } };
      const u = updateLedger(ledger, r, 2, true);
      expect(u.reopened).toEqual(["F2"]);
      expect(ledger.find((e) => e.id === "F2").status).toBe("open");
      // Round 2 R3: not vacuous - an otherwise-ready result (impl not blocked/partial, verifier passed, reviewer
      // approved, adversary ok) is still held out of readiness by `reopened`, and is ready once it is empty.
      // Disabling the `r.reopened` line in isReady (mutation MR3) would read this same object as ready.
      expect(isReadyFn(readyResult({ reopened: u.reopened })), "reopened ['F2'] holds the task out of readiness").toBe(false);
      expect(isReadyFn(readyResult({ reopened: [] })), "an otherwise-ready result with nothing reopened is ready").toBe(true);
    });

    it("E2E: replaying the run's shape through runTask - self-declared non-blocking nits never block, and the task is ready after pass 2 with no third implementer call", async () => {
      const e2eTask = { id: "python-detect", title: "Python detect", spec: "Detect Python stacks and their commands.", files: ["packages/doug-cli/src/detect/python.ts", "packages/doug-cli/tests/detect-python.test.ts"], verify: "pnpm exec vitest run packages/doug-cli/tests/detect-python.test.ts" };
      const e2ePlan = { title: "P", install: null, verify: ["true"], acceptance: [{ text: "x", command: "true" }], tasks: [e2eTask] };
      const e2eImpl = { taskId: "python-detect", branch: "doug/task-python-detect", worktreePath: "/wt/python-detect", filesTouched: ["packages/doug-cli/src/detect/python.ts"], commandsRun: [], summary: "add python detector", blocked: false, commit: "c1" };
      const e2eReview = { taskId: "python-detect", specCompliant: true, inScope: true, approve: true, issues: [] };
      const { agent, calls } = scripted({
        "implement:python-detect": () => e2eImpl,
        "verify:python-detect": (i) =>
          i === 0
            ? { taskId: "python-detect", passed: false, findings: [p1RealDefect, p1AcceptanceWait1, p1AcceptanceWait2, p1NitEgg, p1NitBlack, p1Praise], acceptance: [] }
            : { taskId: "python-detect", passed: true, findings: [], acceptance: [] },
        "review:python-detect": () => e2eReview,
        "fix:python-detect": () => ({ ...e2eImpl, commit: "c2" }),
        // p2F2Waived/p2F3Waived are dropped from this replay (card d-waiver-structural-rule): in the real run
        // wf_cb484cb2-93d those ids named the two self-declared non-blocking nits, but here the nits are dropped
        // before ever entering the ledger (P1, above), so F2 is the praise finding and there is no F3 - a waiver
        // of "F2"/"F3" in this replay would name an entry (or no entry) the structural rule correctly does not
        // honour, which is not what this E2E is testing. The waived-and-honoured path (waiving an entry whose own
        // recorded description is a self-declared non-blocking note) is pinned by the W4 and "a waived report is
        // not a re-report" unit tests above, against real ledger entries built from p1NitEgg/p1NitBlack.
        "check:python-detect": () => ({ taskId: "python-detect", passed: true, commandsRun: [], acceptance: [], findings: [p2F1Fixed, p2F4Fixed, p2AcceptanceWait, p2MinorNote], issues: [], inScope: true }),
        "adversary:python-detect": () => ({ taskId: "python-detect", ran: true, verdict: "pass", summary: "", issues: [], commandsRun: [], error: null }),
      });
      const r = await loadLoop({ agent, fixAttempts: 2, adversary: { command: "codex-review", timeoutMs: 1 }, plan: e2ePlan }).runTask(e2eTask, "main");
      expect(labelled(calls, "fix:").map((c) => c.opts.label), "no third implementer call").toEqual(["fix:python-detect:2"]);
      expect(r.stopReason).toBeNull();
      expect(r.attempts.length).toBe(2);
      expect(r.attempts[1].ready, "ready after pass 2").toBe(true);
      expect(r.reopened).toEqual([]);
      expect(r.openFindings).toEqual([]);
      expect(r.ledger.some((e) => e.description === p1NitEgg), "the egg-info nit never entered the ledger").toBe(false);
      expect(r.ledger.some((e) => e.description === p1NitBlack), "the black nit never entered the ledger").toBe(false);
      expect(r.ledger.every((e) => e.status === "fixed"), "every ledger entry that did open (the real defect and the praise finding) is closed").toBe(true);
    });
  });
});

describe("dependency gate", () => {
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  // Runs the whole template body the way the Workflow runtime runs it, so the level loop itself is exercised.
  async function runWorkflow(plan, agent) {
    const bodyStart = source.indexOf("\n}\n") + 3;
    const body = new AsyncFunction("args", "agent", "pipeline", "parallel", "phase", "log", "budget", source.slice(bodyStart));
    const logs = [];
    const pipeline = async (items, fn) => {
      const out = [];
      for (const item of items) out.push(await fn(item));
      return out;
    };
    const parallel = async (fns) => Promise.all(fns.map((f) => f()));
    const report = await body(plan, agent, pipeline, parallel, (x) => x, (m) => logs.push(m), null);
    return { report, logs };
  }

  // A plan with one size-S task and one full task, an adversary configured, and stubs for every stage; `level` is
  // the level adversary's answer per call (first review, then the confirmation).
  function shapedRun(level, { blockerFile = "src/a.ts", fixReady = true, fixWorktree = null, fix = null } = {}) {
    const t = (id, extra) => ({ id, title: id.toUpperCase(), spec: "Do it.", files: [`src/${id}.ts`], verify: "true", ...extra });
    const plan = { status: "approved", title: "P", goal: "G", install: null, verify: ["true"], acceptance: [], adversary: { command: "codex-review", timeoutMs: 1000, fallback: false }, fixAttempts: 3, baseBranch: "main", integrationBranch: "doug/int", tasks: [t("a", { size: "S" }), t("b", { size: "M" })] };
    const calls = [];
    let levelCalls = 0;
    const agent = async (prompt, opts) => {
      const label = String(opts.label);
      calls.push({ label, prompt, opts });
      const [stage, id] = label.split(":");
      const pass = (kind) => ({ taskId: id, ran: true, verdict: "pass", summary: kind, issues: [], commandsRun: [], error: null });
      if (stage === "fix" && fix) return fix(label);
      if (stage === "implement" || stage === "fix") return { taskId: id, branch: `doug/task-${id}`, worktreePath: stage === "fix" && fixWorktree ? fixWorktree : `/wt/${id}`, filesTouched: [], commandsRun: [], summary: "done", blocked: false, commit: stage === "fix" ? `c-${id}-fix` : `c-${id}` };
      if (stage === "check") return { taskId: id, passed: fixReady || label === "check:a", commandsRun: [], acceptance: [], findings: fixReady || label === "check:a" ? [] : ["src/a.ts still wrong"], issues: [], inScope: true };
      if (stage === "verify") return { taskId: id, passed: true, commandsRun: [], findings: [], acceptance: [] };
      if (stage === "review") return { taskId: id, specCompliant: true, inScope: true, approve: true, issues: [] };
      if (stage === "adversary" && id === "b") return pass("task");
      if (stage === "adversary") {
        const answer = level[Math.min(levelCalls, level.length - 1)];
        levelCalls++;
        return answer === "fail"
          ? { taskId: id, ran: true, verdict: "fail", summary: "the level is wrong", issues: [{ severity: "blocker", file: blockerFile, line: 1, description: "returns 1", evidence: "node -e ... exit 1" }], commandsRun: [], error: null }
          : pass("level");
      }
      if (stage === "integrate") return { branch: "doug/int", merged: ["doug/task-a", "doug/task-b"], conflicts: [], verify: [], ok: true };
      return null;
    };
    return { plan, agent, calls };
  }

  it("reviews a level's size-S tasks once on the integration branch, after the merge, and records the shape per task", async () => {
    const { plan, agent, calls } = shapedRun(["pass"]);
    const { report, logs } = await runWorkflow(plan, agent);
    const labels = calls.map((c) => c.label);
    // The harness pipeline runs one task at a time: a's whole chain, then b's, then the level.
    expect(labels).toEqual(["implement:a", "check:a", "implement:b", "verify:b", "review:b", "adversary:b", "integrate:level-0", "adversary:level-0"]);
    const level = calls.find((c) => c.label === "adversary:level-0");
    expect(level.prompt).toContain("--base 'main' --head 'doug/int' --dir '.claude/worktrees/doug-integration'");
    expect(level.prompt).toContain("Task a: A");
    expect(level.prompt).not.toContain("Task b: B");
    expect(level.prompt).toContain("Every blocker must name the file it is about");
    expect(level.opts).toMatchObject({ agentType: "doug-flow:adversary", phase: "Adversary" });
    expect(calls.find((c) => c.label === "integrate:level-0").prompt).toContain("keep the integration worktree: the adversary reviews the merged size-S tasks there");
    const [a, b] = report.levels[0].tasks;
    expect(a).toMatchObject({ id: "a", shape: "S", size: "S", adversary: null, stages: ["implement", "check"] });
    expect(b).toMatchObject({ id: "b", shape: "full", size: "M" });
    expect(b.adversary.verdict).toBe("pass");
    expect(report.levels[0].levelAdversary).toEqual({ ran: true, verdict: "pass", blocked: false, summary: "level", issues: [], commandsRun: [], error: null, usage: null, durationMs: null, tasks: ["a"] });
    expect(report.ok).toBe(true);
    expect(logs.some((l) => /level 0 adversary/i.test(l))).toBe(false);
  });

  it("T4: the report copies usage and durationMs into both the task adversary and the level adversary via a shared adversaryUsage(adv) helper (card adversary-usage-in-report, design item 3)", async () => {
    const sliceFn = (head) => {
      const s = source.indexOf(head);
      return source.slice(s, source.indexOf("\n}\n", s) + 3);
    };
    const adversaryUsage = new Function(sliceFn("function adversaryUsage(") + "\nreturn adversaryUsage;")();
    expect(adversaryUsage({ usage: { inputTokens: 670279, outputTokens: 5649 }, durationMs: 338000 }), "T4: a numeric usage/durationMs pair is copied through unchanged").toEqual({ usage: { inputTokens: 670279, outputTokens: 5649 }, durationMs: 338000 });
    expect(adversaryUsage({ usage: null, durationMs: 500 }), "T4: usage:null must stay null even when durationMs is numeric").toEqual({ usage: null, durationMs: 500 });
    expect(adversaryUsage({}), "T4: a result with neither field normalises to both null").toEqual({ usage: null, durationMs: null });
    const merged = { usage: { inputTokens: 10, outputTokens: 20 }, durationMs: 999, fallback: false };
    expect(adversaryUsage(merged), "T4: a merged crew result's usage/durationMs are copied the same way").toEqual({ usage: { inputTokens: 10, outputTokens: 20 }, durationMs: 999 });
    // R4 (round 2 minor 7): durationMs: 0 is a real, numeric duration and must not be treated as falsy/absent
    // (`(adv && adv.durationMs) || null` would wrongly normalise it to null).
    expect(adversaryUsage({ usage: null, durationMs: 0 }), "R4: durationMs: 0 must be kept as 0, not treated as absent").toEqual({ usage: null, durationMs: 0 });

    // Source pin: both write sites (the task entry in report.levels.push, and runLevelAdversary) must call the
    // helper by name rather than reading r.adv.usage / adv.usage by hand at only one of the two sites.
    const taskEntryIdx = source.indexOf("adversary: r.adv ? {", source.indexOf("report.levels.push({"));
    const taskEntryLine = source.slice(taskEntryIdx, source.indexOf("\n", taskEntryIdx));
    expect(taskEntryLine, "T4: the task entry's adversary object must call adversaryUsage(r.adv), not read usage/durationMs by hand").toContain("adversaryUsage(r.adv)");
    expect(sliceFn("async function runLevelAdversary("), "T4: runLevelAdversary's returned object must also call adversaryUsage(adv)").toMatch(/adversaryUsage\(adv\)/);

    // End to end: the workflow's own report carries the relay's usage/durationMs at both sites.
    const { plan, agent } = shapedRun(["pass"]);
    const withUsage = async (prompt, opts) => {
      const r = await agent(prompt, opts);
      if (!r) return r;
      if (opts.label === "adversary:b") return { ...r, usage: { inputTokens: 670279, outputTokens: 5649 }, durationMs: 338000 };
      if (opts.label === "adversary:level-0") return { ...r, usage: { inputTokens: 100, outputTokens: 50 }, durationMs: 1000 };
      return r;
    };
    const { report } = await runWorkflow(plan, withUsage);
    const [, b] = report.levels[0].tasks;
    expect(b.adversary, "T4: end to end, the workflow report's task adversary entry must carry the relay's usage and durationMs").toMatchObject({ usage: { inputTokens: 670279, outputTokens: 5649 }, durationMs: 338000 });
    expect(report.levels[0].levelAdversary, "T4: end to end, the level adversary entry must carry them too").toMatchObject({ usage: { inputTokens: 100, outputTokens: 50 }, durationMs: 1000 });
  });

  it("stops a task still partial after its one resume and never merges its branch (card worker-context-handoff)", async () => {
    const plan = { status: "approved", title: "P", goal: "G", install: null, verify: ["true"], acceptance: [], adversary: false, fixAttempts: 3, baseBranch: "main", integrationBranch: "doug/int", tasks: [{ id: "a", title: "A", spec: "Do a.", files: ["src/a.ts"], verify: "true" }, { id: "b", title: "B", spec: "Do b.", files: ["src/b.ts"], verify: "true" }] };
    const handoff1 = { completed: ["scaffold"], remaining: ["finish it"], next: "write the fix", verify: "true" };
    const handoff2 = { completed: ["scaffold", "partial fix"], remaining: ["still broken"], next: "retry the fix", verify: "true" };
    const calls = [];
    const agent = async (prompt, opts) => {
      const label = String(opts.label);
      calls.push({ label, prompt, opts });
      if (label === "implement:a") return { taskId: "a", branch: "doug/task-a", worktreePath: "/wt/a", filesTouched: [], commandsRun: [], summary: "partial", blocked: false, commit: "c1", partial: true, handoff: handoff1 };
      if (label === "resume:a") return { taskId: "a", branch: "doug/task-a", worktreePath: "/wt/a", filesTouched: [], commandsRun: [], summary: "still partial", blocked: false, commit: "c2", partial: true, handoff: handoff2 };
      if (label === "implement:b") return { taskId: "b", branch: "doug/task-b", worktreePath: "/wt/b", filesTouched: [], commandsRun: [], summary: "done", blocked: false, commit: "c-b" };
      if (label === "verify:b") return { taskId: "b", passed: true, commandsRun: [], findings: [], acceptance: [] };
      if (label === "review:b") return { taskId: "b", specCompliant: true, inScope: true, approve: true, issues: [] };
      if (label === "integrate:level-0") return { branch: "doug/int", merged: ["doug/task-b"], conflicts: [], verify: [], ok: true };
      return null;
    };
    const { report } = await runWorkflow(plan, agent);
    const labels = calls.map((c) => c.label);
    expect(labels).toEqual(["implement:a", "resume:a", "implement:b", "verify:b", "review:b", "integrate:level-0"]);
    expect(labels.filter((l) => l === "resume:a")).toHaveLength(1);
    const [a, b] = report.levels[0].tasks;
    expect(a).toMatchObject({ id: "a", partial: true, handoff: handoff2, resumed: 1 });
    expect(a.stopReason).toMatch(/^partial after resume: still broken/);
    expect(b).toMatchObject({ id: "b", partial: false, handoff: null, resumed: 0, stopReason: null });
    const integrateCall = calls.find((c) => c.label === "integrate:level-0");
    expect(integrateCall.prompt).toContain("doug/task-b");
    expect(integrateCall.prompt).not.toContain("doug/task-a");
    expect(report.ok).toBe(false);
  });

  it("keeps a fix-pass partial out of integration even when the follow-up checks pass (rule 7 major, reviewer follow-up)", async () => {
    // The live bug the reviewer found: a fix pass returns partial=true with a handoff and a new commit; the
    // rerun verifier and the confirming check both pass. Without isReady's explicit partial guard this task
    // would read ready (every stage boolean true) and its branch would reach integratePrompt.
    const plan = { status: "approved", title: "P", goal: "G", install: null, verify: ["true"], acceptance: [], adversary: false, fixAttempts: 3, baseBranch: "main", integrationBranch: "doug/int", tasks: [{ id: "a", title: "A", spec: "Do a.", files: ["src/a.ts"], verify: "true" }, { id: "b", title: "B", spec: "Do b.", files: ["src/b.ts"], verify: "true" }] };
    const handoff = { completed: ["half the fix"], remaining: ["still returns 1"], next: "keep fixing src/a.ts", verify: "true" };
    const calls = [];
    const agent = async (prompt, opts) => {
      const label = String(opts.label);
      calls.push({ label, prompt, opts });
      if (label === "implement:a") return { taskId: "a", branch: "doug/task-a", worktreePath: "/wt/a", filesTouched: [], commandsRun: [], summary: "done", blocked: false, commit: "c1" };
      if (label === "verify:a") return { taskId: "a", passed: false, commandsRun: [], findings: ["src/a.ts returns 1"], acceptance: [] };
      if (label === "review:a") return { taskId: "a", specCompliant: true, inScope: true, approve: true, issues: [] };
      if (label === "fix:a:2") return { taskId: "a", branch: "doug/task-a", worktreePath: "/wt/a", filesTouched: [], commandsRun: [], summary: "partial fix", blocked: false, commit: "c2", partial: true, handoff };
      if (label === "verify:a:2") return { taskId: "a", passed: true, commandsRun: [], findings: [], acceptance: [] };
      if (label === "check:a:2") return { taskId: "a", passed: true, commandsRun: [], acceptance: [], findings: [], issues: [], inScope: true };
      if (label === "implement:b") return { taskId: "b", branch: "doug/task-b", worktreePath: "/wt/b", filesTouched: [], commandsRun: [], summary: "done", blocked: false, commit: "c-b" };
      if (label === "verify:b") return { taskId: "b", passed: true, commandsRun: [], findings: [], acceptance: [] };
      if (label === "review:b") return { taskId: "b", specCompliant: true, inScope: true, approve: true, issues: [] };
      if (label === "integrate:level-0") return { branch: "doug/int", merged: ["doug/task-b"], conflicts: [], verify: [], ok: true };
      return null;
    };
    const { report } = await runWorkflow(plan, agent);
    const labels = calls.map((c) => c.label);
    expect(labels).toEqual(["implement:a", "verify:a", "review:a", "fix:a:2", "verify:a:2", "check:a:2", "implement:b", "verify:b", "review:b", "integrate:level-0"]);
    const [a, b] = report.levels[0].tasks;
    expect(a).toMatchObject({ id: "a", partial: true, handoff, resumed: 0 });
    // A fix-pass partial was never resumed, so it gets its own wording, distinct from the resumed case above.
    expect(a.stopReason).toMatch(/^partial on a fix pass: still returns 1/);
    expect(b).toMatchObject({ id: "b", partial: false, stopReason: null });
    const integrateCall = calls.find((c) => c.label === "integrate:level-0");
    expect(integrateCall.prompt).toContain("doug/task-b");
    expect(integrateCall.prompt).not.toContain("doug/task-a");
    expect(report.ok).toBe(false);
  });

  it("records memoryUsed per task from task.lessonIds, defaulting to [] when the task has none (card memory-recall #2)", async () => {
    const { plan, agent } = shapedRun(["pass"]);
    plan.tasks[1].lessonIds = ["lesson-1", "lesson-2"];
    const { report } = await runWorkflow(plan, agent);
    const [a, b] = report.levels[0].tasks;
    expect(a.memoryUsed).toEqual([]);
    expect(b.memoryUsed).toEqual(["lesson-1", "lesson-2"]);
  });

  it("clears memoryUsed for a reused task and for a task whose dependency never integrated, even with lessonIds set (card memory-recall #2, review minor 2)", async () => {
    const t = (id, extra) => ({ id, title: id.toUpperCase(), spec: "Do it.", files: [`src/${id}.ts`], verify: "true", ...extra });
    const plan = {
      status: "approved", title: "P", goal: "G", install: null, verify: ["true"], acceptance: [],
      adversary: false, fixAttempts: 0, baseBranch: "main", integrationBranch: "doug/int",
      tasks: [
        t("a", { lessonIds: ["l-a"] }),
        t("c", { reuse: "doug/task-c", lessonIds: ["l-c"] }),
        t("b", { dependsOn: ["a"], lessonIds: ["l-b"] }),
      ],
    };
    const agent = async (prompt, opts) => {
      const label = String(opts.label);
      const [stage, id] = label.split(":");
      if (stage === "reuse") return { taskId: id, branch: `doug/task-${id}`, worktreePath: `/wt/${id}`, filesTouched: [], commandsRun: [], summary: "reused", blocked: false, commit: `c-${id}` };
      if (stage === "implement") return { taskId: id, branch: `doug/task-${id}`, worktreePath: `/wt/${id}`, filesTouched: [], commandsRun: [], summary: "done", blocked: false, commit: `c-${id}` };
      // task a's verify fails and fixAttempts is 0, so it never becomes ready; task b (level 1) depends on it and
      // is skipped (never launched, r.impl stays null) rather than run against a base that never integrated it.
      if (stage === "verify") return { taskId: id, passed: id !== "a", commandsRun: [], findings: id === "a" ? ["broken"] : [], acceptance: [] };
      if (stage === "review") return { taskId: id, specCompliant: true, inScope: true, approve: true, issues: [] };
      if (stage === "integrate") return { branch: "doug/int", merged: [], conflicts: [], verify: [], ok: true };
      return null;
    };
    const { report } = await runWorkflow(plan, agent);
    const level0 = report.levels[0].tasks;
    const a = level0.find((x) => x.id === "a");
    const c = level0.find((x) => x.id === "c");
    const b = report.levels[1].tasks.find((x) => x.id === "b");
    expect(a.implemented).toBe(true);
    expect(a.memoryUsed).toEqual(["l-a"]);
    expect(c.reused).toBe("doug/task-c");
    expect(c.memoryUsed).toEqual([]);
    expect(b.implemented).toBe(false);
    expect(b.blockedReason).toBe("dependency a was not integrated");
    expect(b.memoryUsed).toEqual([]);
  });

  it("records indexUsed per task from task.codeContextIds, defaulting to [] when the task has none (card semantic-index, brief B)", async () => {
    const { plan, agent } = shapedRun(["pass"]);
    plan.tasks[1].codeContextIds = ["chunk-1", "chunk-2"];
    const { report } = await runWorkflow(plan, agent);
    const [a, b] = report.levels[0].tasks;
    expect(a.indexUsed).toEqual([]);
    expect(b.indexUsed).toEqual(["chunk-1", "chunk-2"]);
  });

  it("clears indexUsed for a reused task and for a task whose dependency never integrated, even with codeContextIds set (card semantic-index, brief B)", async () => {
    const t = (id, extra) => ({ id, title: id.toUpperCase(), spec: "Do it.", files: [`src/${id}.ts`], verify: "true", ...extra });
    const plan = {
      status: "approved", title: "P", goal: "G", install: null, verify: ["true"], acceptance: [],
      adversary: false, fixAttempts: 0, baseBranch: "main", integrationBranch: "doug/int",
      tasks: [
        t("a", { codeContextIds: ["ci-a"] }),
        t("c", { reuse: "doug/task-c", codeContextIds: ["ci-c"] }),
        t("b", { dependsOn: ["a"], codeContextIds: ["ci-b"] }),
      ],
    };
    const agent = async (prompt, opts) => {
      const label = String(opts.label);
      const [stage, id] = label.split(":");
      if (stage === "reuse") return { taskId: id, branch: `doug/task-${id}`, worktreePath: `/wt/${id}`, filesTouched: [], commandsRun: [], summary: "reused", blocked: false, commit: `c-${id}` };
      if (stage === "implement") return { taskId: id, branch: `doug/task-${id}`, worktreePath: `/wt/${id}`, filesTouched: [], commandsRun: [], summary: "done", blocked: false, commit: `c-${id}` };
      // task a's verify fails and fixAttempts is 0, so it never becomes ready; task b (level 1) depends on it and
      // is skipped (never launched, r.impl stays null) rather than run against a base that never integrated it.
      if (stage === "verify") return { taskId: id, passed: id !== "a", commandsRun: [], findings: id === "a" ? ["broken"] : [], acceptance: [] };
      if (stage === "review") return { taskId: id, specCompliant: true, inScope: true, approve: true, issues: [] };
      if (stage === "integrate") return { branch: "doug/int", merged: [], conflicts: [], verify: [], ok: true };
      return null;
    };
    const { report } = await runWorkflow(plan, agent);
    const level0 = report.levels[0].tasks;
    const a = level0.find((x) => x.id === "a");
    const c = level0.find((x) => x.id === "c");
    const b = report.levels[1].tasks.find((x) => x.id === "b");
    expect(a.implemented).toBe(true);
    expect(a.indexUsed).toEqual(["ci-a"]);
    expect(c.reused).toBe("doug/task-c");
    expect(c.indexUsed).toEqual([]);
    expect(b.implemented).toBe(false);
    expect(b.blockedReason).toBe("dependency a was not integrated");
    expect(b.indexUsed).toEqual([]);
  });

  it("feeds a level adversary blocker back to the owning size-S task as a fix pass, merges again, and confirms", async () => {
    const { plan, agent, calls } = shapedRun(["fail", "pass"]);
    const { report, logs } = await runWorkflow(plan, agent);
    const labels = calls.map((c) => c.label);
    expect(labels.slice(labels.indexOf("adversary:level-0"))).toEqual(["adversary:level-0", "fix:a:3", "check:a:3", "integrate:level-0:2", "adversary:level-0:confirm"]);
    const fix = calls.find((c) => c.label === "fix:a:3").prompt;
    expect(fix).toContain("F1 [adversary/");
    expect(fix).toContain("src/a.ts");
    expect(calls.find((c) => c.label === "adversary:level-0:confirm").prompt).toContain("confirm each one is fixed");
    const a = report.levels[0].tasks[0];
    expect(a.attempts.map((x) => x.stages)).toEqual([["implement", "check"], ["level-adversary"], ["fix", "check"]]);
    expect(a.attempts[1]).toMatchObject({ blockingStage: "adversary", newFindings: ["F1"], ready: false });
    expect(a.ledger.map((e) => [e.id, e.stage, e.status])).toEqual([["F1", "adversary", "fixed"]]);
    expect(a.stopReason).toBeNull();
    expect(a.passes).toBe(3);
    expect(report.levels[0].levelAdversary).toMatchObject({ blocked: true, verdict: "fail", tasks: ["a"], fixed: [{ task: "a", ready: true, stopReason: null }], reintegration: { ok: true }, confirm: { verdict: "pass", blocked: false } });
    expect(report.stoppedAtLevel).toBeUndefined();
    expect(report.ok).toBe(true);
    expect(logs).toContain("a: the level adversary blocked it (1 blocker); fix pass");
  });

  it("C1: the level report's integration.acceptance is the re-integration's, not the first integration's (card integration-acceptance-recorded, behaviour 4)", async () => {
    const { plan, agent } = shapedRun(["fail", "pass"]);
    plan.acceptance = [{ text: "a works", command: "cmd-a" }];
    const withAcceptance = async (prompt, opts) => {
      const r = await agent(prompt, opts);
      if (!r) return r;
      if (opts.label === "integrate:level-0") return { ...r, acceptance: [{ text: "first-call", command: "cmd-a", ok: true, exitCode: 0 }] };
      if (opts.label === "integrate:level-0:2") return { ...r, acceptance: [{ text: "second-call", command: "cmd-a", ok: true, exitCode: 0 }] };
      return r;
    };
    const { report } = await runWorkflow(plan, withAcceptance);
    // Level 0 is this plan's only (and so its last) level; the level-adversary fix pass re-integrates once
    // (label integrate:level-0:2), and that later, final state of the branch is what the report must carry.
    expect(report.levels[0].integration.acceptance).toEqual([{ text: "second-call", command: "cmd-a", ok: true, exitCode: 0 }]);
  });

  it("F8: a last-level integration whose acceptance fails logs 'integration failed' with the reason (round-1 minor 2)", async () => {
    const { plan, agent } = shapedRun(["pass"]);
    // The agent's integrate stage returns ok:true with no acceptance at all, so the plan's one command is
    // synthesized as not reported and fails the integration via enforceIntegrationAcceptance.
    plan.acceptance = [{ text: "a works exactly", command: "cmd-a" }];
    const { report, logs } = await runWorkflow(plan, agent);
    expect(report.ok).toBe(false);
    expect(report.stoppedAtLevel).toBe(0);
    const line = logs.find((l) => l.includes("integration failed"));
    expect(line, "an 'integration failed' log line must exist").toBeDefined();
    expect(line).toContain("acceptance command not reported: a works exactly ($ cmd-a)");
  });

  it("spawns the level-adversary fix pass in a created worktree on the task branch, since integration removed the first one", async () => {
    const { plan, agent, calls } = shapedRun(["fail", "pass"], { fixWorktree: "/wt/a-fix" });
    const { report, logs } = await runWorkflow(plan, agent);
    // The task's worktree went with the level's integration (integrate step 4), so the fix pass gets a fresh one
    // the way the first implement pass does, and checks the task branch out in it.
    const fix = calls.find((c) => c.label === "fix:a:3");
    expect(fix.opts).toMatchObject({ isolation: "worktree", agentType: "doug-flow:implementer", phase: "Implement" });
    expect(fix.prompt).toContain("git checkout doug/task-a");
    expect(fix.prompt).toContain("git worktree remove --force");
    expect(fix.prompt).toContain("/wt/a) was removed");
    expect(fix.prompt).not.toContain("existing worktree /wt/a on branch");
    expect(fix.prompt).toContain("worktreePath = the absolute path of your worktree");
    // The check and the second integration read the worktree the fix pass reported, not the removed one.
    expect(calls.find((c) => c.label === "check:a:3").prompt).toContain("Worktree: /wt/a-fix");
    expect(calls.find((c) => c.label === "integrate:level-0:2").prompt).toContain("for each of /wt/a-fix.");
    const a = report.levels[0].tasks[0];
    expect(a).toMatchObject({ branch: "doug/task-a", commit: "c-a-fix", stopReason: null });
    expect(report.ok).toBe(true);
    expect(logs.some((l) => /fix attempt 2 of 3 in a new worktree on doug\/task-a \(\/wt\/a went with the level.s integration\)/.test(l))).toBe(true);
  });

  it("keeps the branch when the level-adversary fix pass returns no structured result", async () => {
    const NO_RESULT = "implementer returned no structured result";
    const { plan, agent, calls } = shapedRun(["fail", "pass"], {
      fix: () => {
        throw new Error("agent ended without structured output");
      },
    });
    const { report } = await runWorkflow(plan, agent);
    const labels = calls.map((c) => c.label);
    // Two attempts remained of three: both return nothing, the loop stops in place, and nothing is re-integrated.
    // Each fix call rejects on both its fresh attempt and its launch-level retry (card stage-agent-retry-on-no-output).
    expect(labels.filter((l) => l.startsWith("fix:"))).toEqual(["fix:a:3", "fix:a:3:retry", "fix:a:4", "fix:a:4:retry"]);
    expect(labels.filter((l) => l.startsWith("check:a:") || l === "integrate:level-0:2" || l.includes("confirm"))).toEqual([]);
    const a = report.levels[0].tasks[0];
    expect(a.branch).toBe("doug/task-a");
    expect(a.commit).toBe("c-a");
    expect(a.implemented).toBe(true);
    expect(a.attempts.map((x) => x.stages)).toEqual([["implement", "check"], ["level-adversary"], ["fix"], ["fix"]]);
    expect(a.attempts[2]).toMatchObject({ pass: 3, commit: "c-a", blockingStage: "adversary", retriable: { ok: true, reason: NO_RESULT } });
    expect(a.stopReason).toBe(`${NO_RESULT}; fix attempts exhausted (3 of 3)`);
    expect(a.stopReason).not.toContain("task stage threw");
    expect(report.levels[0].levelAdversary.fixed).toEqual([{ task: "a", ready: false, stopReason: a.stopReason }]);
    expect(report.stoppedAtLevel).toBe(0);
    expect(report.ok).toBe(false);
  });

  it("stops the level when the confirmation still blocks, or when a blocker names a file no task of the level owns", async () => {
    const stuck = shapedRun(["fail", "fail"]);
    const { report } = await runWorkflow(stuck.plan, stuck.agent);
    expect(report.stoppedAtLevel).toBe(0);
    expect(report.ok).toBe(false);
    expect(report.levels[0].tasks[0].stopReason).toBe("level adversary still blocked after a fix pass: the level is wrong");
    expect(report.levels[0].levelAdversary.confirm).toMatchObject({ blocked: true });
    const nobody = shapedRun(["fail"], { blockerFile: "lib/z.js" });
    const r2 = await runWorkflow(nobody.plan, nobody.agent);
    expect(nobody.calls.map((c) => c.label).filter((l) => l.startsWith("fix:") || l.includes("confirm"))).toEqual([]);
    expect(r2.report.levels[0].levelAdversary).toMatchObject({ blocked: true, unowned: ["lib/z.js"], fixed: [] });
    expect(r2.report.levels[0].tasks[0].stopReason).toBe("level adversary blocked on lib/z.js: the level is wrong");
    expect(r2.report.stoppedAtLevel).toBe(0);
    expect(r2.logs).toContain("level 0 adversary blocked on files no task of this level owns: lib/z.js; no fix pass");
    // A fix pass whose check still fails is not re-integrated, and the level stops with the task's own reason.
    const unfixed = shapedRun(["fail", "pass"], { fixReady: false });
    const r3 = await runWorkflow(unfixed.plan, unfixed.agent);
    expect(unfixed.calls.map((c) => c.label)).not.toContain("integrate:level-0:2");
    expect(r3.report.levels[0].levelAdversary.fixed[0].ready).toBe(false);
    expect(r3.report.stoppedAtLevel).toBe(0);
  });

  it("L1: routes a level adversary blocker on a full-shape task's own file to that task's fix pass, the same way a size-S owner is routed (card level-adversary-routes-owner)", async () => {
    const { plan, agent, calls } = shapedRun(["fail", "pass"], { blockerFile: "src/b.ts" });
    const { report, logs } = await runWorkflow(plan, agent);
    const labels = calls.map((c) => c.label);
    // The blocker named b's own file (a full-shape task, never in sReady), so the fix pass must go to b, not
    // be recorded as unowned the way it would if the owner lookup still only searched the level's size-S tasks.
    expect(labels).toContain("fix:b:3");
    expect(labels).toContain("integrate:level-0:2");
    expect(labels).toContain("adversary:level-0:confirm");
    expect(report.levels[0].levelAdversary.unowned).toBeUndefined();
    expect(report.levels[0].levelAdversary.fixed).toEqual(expect.arrayContaining([expect.objectContaining({ task: "b" })]));
    expect(report.levels[0].levelAdversary.confirm).toMatchObject({ verdict: "pass", blocked: false });
    expect(report.stoppedAtLevel).toBeUndefined();
    expect(report.ok).toBe(true);
    expect(logs).toContain("b: the level adversary blocked it (1 blocker); fix pass");
  });

  it("L2: a level adversary blocker on a file no task of the level owns (S or full-shape) still stays unowned, with no fix pass (rule 1 does not widen unowned to everything)", async () => {
    const { plan, agent, calls } = shapedRun(["fail"], { blockerFile: "lib/nobody-owns.js" });
    const { report, logs } = await runWorkflow(plan, agent);
    expect(calls.map((c) => c.label).filter((l) => l.startsWith("fix:") || l.includes("confirm"))).toEqual([]);
    expect(report.levels[0].levelAdversary).toMatchObject({ blocked: true, unowned: ["lib/nobody-owns.js"], fixed: [] });
    expect(report.levels[0].tasks.every((t) => !t.stopReason || t.stopReason.includes("lib/nobody-owns.js"))).toBe(true);
    expect(report.stoppedAtLevel).toBe(0);
    expect(report.ok).toBe(false);
    expect(logs.some((l) => l.includes("lib/nobody-owns.js") && l.includes("no fix pass"))).toBe(true);
  });

  it("M-a: a routed full-shape owner that still doesn't clear after its fix pass carries the level-adversary stopReason too, not left null (review round 2, card level-adversary-routes-owner)", async () => {
    const { plan, agent } = shapedRun(["fail", "fail"], { blockerFile: "src/b.ts" });
    const { report } = await runWorkflow(plan, agent);
    // b is the full-shape owner routed by rule 1; the confirm still blocks, so the widened stopReason loop
    // (`for (const r of new Set([...sReady, ...perTask.keys()]))`, not the old `for (const r of sReady)`) must
    // reach b too, or a full-shape owner whose fix pass did not clear would be reported succeeded (stopReason
    // null) even though the level stopped on it.
    const b = report.levels[0].tasks.find((t) => t.id === "b");
    expect(b.stopReason).toBe("level adversary still blocked after a fix pass: the level is wrong");
    expect(report.levels[0].levelAdversary.confirm).toMatchObject({ blocked: true });
    expect(report.stoppedAtLevel).toBe(0);
    expect(report.ok).toBe(false);
  });

  it("a full-shape task's report keeps a non-blocking fail's issues and integrates it (card fix-loop-minor-verdict)", async () => {
    const plan = {
      status: "approved", title: "P", goal: "G", install: null, verify: ["true"], acceptance: [],
      adversary: { command: "codex-review", timeoutMs: 1000, fallback: false }, fixAttempts: 2,
      baseBranch: "main", integrationBranch: "doug/int",
      tasks: [{ id: "a", title: "A", spec: "Do it.", files: ["src/a.ts"], verify: "true" }],
    };
    const agent = async (prompt, opts) => {
      const [stage, id] = String(opts.label).split(":");
      if (stage === "implement") return { taskId: id, branch: "doug/task-a", worktreePath: "/wt/a", filesTouched: ["src/a.ts"], commandsRun: [], summary: "done", blocked: false, commit: "c1" };
      if (stage === "verify") return { taskId: id, passed: true, commandsRun: [], findings: [], acceptance: [] };
      if (stage === "review") return { taskId: id, specCompliant: true, inScope: true, approve: true, issues: [] };
      if (stage === "adversary") return { taskId: id, ran: true, verdict: "fail", summary: "a text-format nit", issues: [{ severity: "minor", file: "src/a.ts", description: "prefer const" }], commandsRun: [], error: null };
      if (stage === "integrate") return { branch: "doug/int", merged: ["doug/task-a"], conflicts: [], verify: [], ok: true };
      return null;
    };
    const { report } = await runWorkflow(plan, agent);
    const a = report.levels[0].tasks[0];
    expect(a.adversary).toMatchObject({ ran: true, verdict: "fail", blocked: false, issues: [{ severity: "minor", file: "src/a.ts", description: "prefer const" }] });
    expect(a.stopReason).toBeNull();
    expect(report.ok).toBe(true);
  });

  it("never launches a task whose dependency did not integrate, and integrates the rest of its level", async () => {
    const t = (id, extra) => ({ id, title: id.toUpperCase(), spec: "Do it.", files: [`src/${id}.ts`], verify: "true", ...extra });
    const plan = {
      status: "approved",
      title: "P",
      goal: "G",
      install: null,
      verify: ["true"],
      acceptance: [],
      adversary: false,
      fixAttempts: 0,
      baseBranch: "main",
      integrationBranch: "doug/int",
      tasks: [t("a"), t("c"), t("b", { dependsOn: ["a"] })],
    };
    const labels = [];
    const agent = async (prompt, opts) => {
      const label = String(opts.label);
      labels.push(label);
      const id = label.split(":")[1];
      if (label.startsWith("implement:")) return { taskId: id, branch: `doug/task-${id}`, worktreePath: `/wt/${id}`, filesTouched: [], commandsRun: [], summary: "done", blocked: false, commit: `c-${id}` };
      // Task a fails verification and cannot be fixed (fixAttempts 0), so it never integrates.
      if (label.startsWith("verify:")) return { taskId: id, passed: id !== "a", commandsRun: [], findings: id === "a" ? [`src/a.ts returns 1, expected 2`] : [], acceptance: [] };
      if (label.startsWith("review:")) return { taskId: id, specCompliant: true, inScope: true, approve: true, issues: [] };
      if (label.startsWith("integrate:")) return { branch: "doug/int", merged: ["doug/task-c"], conflicts: [], verify: [], ok: true };
      return null;
    };
    const { report, logs } = await runWorkflow(plan, agent);

    // Nothing was ever launched for b.
    expect(labels.filter((l) => l.split(":")[1] === "b")).toEqual([]);
    expect(labels).toContain("implement:a");
    expect(labels).toContain("implement:c");

    const b = report.levels[1].tasks.find((x) => x.id === "b");
    expect(b.implemented).toBe(false);
    expect(b.blockedReason).toBe("dependency a was not integrated");
    expect(b.stopReason).toBe("dependency a was not integrated");
    expect(b.stages).toEqual([]);
    expect(b.passes).toBe(0);
    expect(logs).toContain("b not launched: dependency a was not integrated");
    // Rule 6b logs one line for a gated task: the not-integrated line of the level loop must not repeat it.
    expect(logs.filter((l) => /^b\b/.test(l))).toEqual(["b not launched: dependency a was not integrated"]);

    // Level 0 still integrated the task that was ready, and the run is not a success.
    expect(report.levels[0].integration.ok).toBe(true);
    expect(report.levels[0].tasks.find((x) => x.id === "a").stopReason).toContain("fix attempts exhausted");
    expect(report.ok).toBe(false);
  });

  it("pauses at a human gate once its level integrated, continues past an opened gate, and never pauses after the last level", async () => {
    const t = (id, extra) => ({ id, title: id.toUpperCase(), spec: "Do it.", files: [`src/${id}.ts`], verify: "true", ...extra });
    const base = { status: "approved", title: "P", goal: "G", install: null, verify: ["true"], acceptance: [], adversary: false, fixAttempts: 0, baseBranch: "main", integrationBranch: "doug/int" };
    const stub = () => {
      const labels = [];
      const agent = async (prompt, opts) => {
        const label = String(opts.label);
        labels.push(label);
        const id = label.split(":")[1];
        if (label.startsWith("implement:")) return { taskId: id, branch: `doug/task-${id}`, worktreePath: `/wt/${id}`, filesTouched: [], commandsRun: [], summary: "done", blocked: false, commit: `c-${id}` };
        if (label.startsWith("verify:")) return { taskId: id, passed: true, commandsRun: [], findings: [], acceptance: [] };
        if (label.startsWith("review:")) return { taskId: id, specCompliant: true, inScope: true, approve: true, issues: [] };
        if (label.startsWith("integrate:")) return { branch: "doug/int", merged: [`doug/task-${id}`], conflicts: [], verify: [], ok: true };
        return null;
      };
      return { agent, labels };
    };
    const gatedTasks = [t("a", { gate: "human" }), t("b", { dependsOn: ["a"] })];

    // The gate holds: level 0 integrates, then the run pauses and b is never launched. Not ok, not stopped.
    let s = stub();
    let { report, logs } = await runWorkflow({ ...base, tasks: gatedTasks }, s.agent);
    expect(report.paused).toEqual({ level: 0, gate: "human", next: ["b"] });
    expect(report.stoppedAtLevel).toBeUndefined();
    expect(report.ok).toBe(false);
    expect(report.levels).toHaveLength(1);
    expect(report.levels[0].integration.ok).toBe(true);
    expect(report.levels[0].tasks[0].gate).toBe("human");
    expect(s.labels.some((l) => l.endsWith(":b"))).toBe(false);
    expect(logs.some((l) => l.includes("pausing before level 1 (b)") && l.includes("plan.mjs gate open 0"))).toBe(true);

    // The gate opened (plan.gatesOpened): the same plan runs through both levels.
    s = stub();
    ({ report, logs } = await runWorkflow({ ...base, gatesOpened: [0], tasks: gatedTasks }, s.agent));
    expect(report.paused).toBeUndefined();
    expect(report.ok).toBe(true);
    expect(report.levels).toHaveLength(2);
    expect(report.levels[1].tasks[0].gate).toBe("auto");
    expect(s.labels).toContain("implement:b");

    // A gate on the last level is the landing itself: no pause.
    s = stub();
    ({ report } = await runWorkflow({ ...base, tasks: [t("a"), t("b", { dependsOn: ["a"], gate: "human" })] }, s.agent));
    expect(report.paused).toBeUndefined();
    expect(report.ok).toBe(true);
    expect(report.levels).toHaveLength(2);
  });

  it("launches a dependent task once its dependency integrated", async () => {
    const t = (id, extra) => ({ id, title: id.toUpperCase(), spec: "Do it.", files: [`src/${id}.ts`], verify: "true", ...extra });
    const plan = {
      status: "approved",
      title: "P",
      goal: "G",
      install: null,
      verify: ["true"],
      acceptance: [],
      adversary: false,
      fixAttempts: 0,
      baseBranch: "main",
      integrationBranch: "doug/int",
      tasks: [t("a"), t("b", { dependsOn: ["a"] })],
    };
    const labels = [];
    const agent = async (prompt, opts) => {
      const label = String(opts.label);
      labels.push(label);
      const id = label.split(":")[1];
      if (label.startsWith("implement:")) return { taskId: id, branch: `doug/task-${id}`, worktreePath: `/wt/${id}`, filesTouched: [], commandsRun: [], summary: "done", blocked: false, commit: `c-${id}` };
      if (label.startsWith("verify:")) return { taskId: id, passed: true, commandsRun: [], findings: [], acceptance: [] };
      if (label.startsWith("review:")) return { taskId: id, specCompliant: true, inScope: true, approve: true, issues: [] };
      if (label.startsWith("integrate:")) return { branch: "doug/int", merged: [`doug/task-${id}`], conflicts: [], verify: [], ok: true };
      return null;
    };
    const { report } = await runWorkflow(plan, agent);
    expect(labels).toContain("implement:b");
    expect(report.levels[1].tasks[0].blockedReason).toBeNull();
    expect(report.ok).toBe(true);
  });

  it("recreates the integration worktree only on the run's first integration; a later level reuses it as is (card integration-worktree-stale)", async () => {
    const t = (id, extra) => ({ id, title: id.toUpperCase(), spec: "Do it.", files: [`src/${id}.ts`], verify: "true", ...extra });
    const plan = {
      status: "approved",
      title: "P",
      goal: "G",
      install: null,
      verify: ["true"],
      acceptance: [],
      adversary: false,
      fixAttempts: 0,
      baseBranch: "main",
      integrationBranch: "doug/int",
      tasks: [t("a"), t("b", { dependsOn: ["a"] })],
    };
    const calls = [];
    const agent = async (prompt, opts) => {
      const label = String(opts.label);
      calls.push({ label, prompt });
      const id = label.split(":")[1];
      if (label.startsWith("implement:")) return { taskId: id, branch: `doug/task-${id}`, worktreePath: `/wt/${id}`, filesTouched: [], commandsRun: [], summary: "done", blocked: false, commit: `c-${id}` };
      if (label.startsWith("verify:")) return { taskId: id, passed: true, commandsRun: [], findings: [], acceptance: [] };
      if (label.startsWith("review:")) return { taskId: id, specCompliant: true, inScope: true, approve: true, issues: [] };
      if (label.startsWith("integrate:")) return { branch: "doug/int", merged: [`doug/task-${id}`], conflicts: [], verify: [], ok: true };
      return null;
    };
    const { report } = await runWorkflow(plan, agent);
    expect(report.ok).toBe(true);
    const level0 = calls.find((c) => c.label === "integrate:level-0");
    const level1 = calls.find((c) => c.label === "integrate:level-1");
    expect(level0.prompt).toContain("this is the run's first integration; the worktree may be a leftover of an earlier run and is never reused as is");
    expect(level0.prompt).toContain("git worktree add -B doug/int .claude/worktrees/doug-integration main");
    expect(level0.prompt).not.toContain("if it exists (a previous level made it): use it as is");
    expect(level1.prompt).toContain("if it exists (a previous level made it): use it as is");
    expect(level1.prompt).not.toContain("this is the run's first integration");
  });

  it("the fix-loop re-integration never recreates the worktree, even though it follows the run's first integration", async () => {
    const { plan, agent, calls } = shapedRun(["fail", "pass"]);
    await runWorkflow(plan, agent);
    const first = calls.find((c) => c.label === "integrate:level-0");
    const again = calls.find((c) => c.label === "integrate:level-0:2");
    expect(first.prompt).toContain("this is the run's first integration");
    expect(again.prompt).toContain("if it exists (a previous level made it): use it as is");
    expect(again.prompt).not.toContain("this is the run's first integration");
  });

  it("a task whose stage throws is still reported with the branch it would have used, blocked, and no commit (card integration-worktree-stale); a task carrying reuse records its reuse branch instead (card thrown-reuse-task-branch)", async () => {
    const t = (id, extra) => ({ id, title: id.toUpperCase(), spec: "Do it.", files: [`src/${id}.ts`], verify: "true", ...extra });
    const plan = { status: "approved", title: "P", goal: "G", install: null, verify: ["true"], acceptance: [], adversary: false, fixAttempts: 0, baseBranch: "main", integrationBranch: "doug/int", tasks: [t("a"), t("b", { reuse: "doug/task-b-stale-1" })] };
    // A thrown error (e.g. the implementer committed but never called StructuredOutput) never reaches here: the
    // runtime's real pipeline() catches a throwing item and resolves its slot to null, like parallel() does (see
    // plainParallel above), so this stub reproduces that rather than the naive sequential one runWorkflow uses.
    const bodyStart = source.indexOf("\n}\n") + 3;
    const body = new AsyncFunction("args", "agent", "pipeline", "parallel", "phase", "log", "budget", source.slice(bodyStart));
    const agent = async () => {
      throw new Error("agent ended without structured output");
    };
    const pipeline = async (items, fn) => Promise.all(items.map((item) => Promise.resolve().then(() => fn(item)).catch(() => undefined)));
    const parallel = async (fns) => Promise.all(fns.map((f) => f()));
    const logs = [];
    const report = await body(plan, agent, pipeline, parallel, (x) => x, (m) => logs.push(m), null);
    const a = report.levels[0].tasks[0];
    expect(a.implemented).toBe(false);
    expect(a.branch).toBe("doug/task-a");
    expect(a.commit).toBeNull();
    expect(a.stopReason).toBe("task stage threw (agent error, unknown agent type, or user skip)");
    const b = report.levels[0].tasks[1];
    expect(b.implemented).toBe(false);
    expect(b.branch).toBe("doug/task-b-stale-1");
    expect(b.commit).toBeNull();
  });
});

describe("plugin layout", () => {
  const manifest = JSON.parse(readFileSync(join(root, ".claude-plugin/plugin.json"), "utf8"));
  it("points at existing directories and lists agents as files (a directory string fails `claude plugin validate`)", () => {
    for (const key of ["skills", "workflows"]) expect(existsSync(join(root, manifest[key])), key).toBe(true);
    expect(Array.isArray(manifest.agents)).toBe(true);
    for (const a of manifest.agents) expect(existsSync(join(root, a)), a).toBe(true);
    expect(manifest.agents.map((a) => a.split("/").pop()).sort()).toEqual(readdirSync(join(root, "agents")).sort());
    expect(manifest.name).toBe("doug-flow");
  });
  it("ships the eight agents with valid frontmatter and read-only verifier, reviewer, researcher and both adversaries", () => {
    const names = readdirSync(join(root, "agents")).sort();
    expect(names).toEqual(["adversary-claude.md", "adversary.md", "implementer.md", "lead.md", "planner.md", "researcher.md", "reviewer.md", "verifier.md"]);
    for (const f of names) {
      const fm = parseFrontmatter(readFileSync(join(root, "agents", f), "utf8"));
      expect(fm, f).not.toBeNull();
      expect(fm.name + ".md").toBe(f);
      expect(fm.description.length).toBeGreaterThan(40);
    }
    for (const f of ["verifier.md", "reviewer.md", "adversary.md", "adversary-claude.md", "researcher.md"]) {
      const fm = parseFrontmatter(readFileSync(join(root, "agents", f), "utf8"));
      expect(fm.disallowedTools).toContain("Edit");
      expect(fm.disallowedTools).toContain("Write");
    }
    // The default researcher reads the web and the checkout, never writes, and says what it could not confirm.
    const researcher = parseFrontmatter(readFileSync(join(root, "agents/researcher.md"), "utf8"));
    for (const t of ["WebFetch", "WebSearch", "Read", "Bash"]) expect(researcher.tools).toContain(t);
    expect(researcher.memory).toBe("none");
    const researcherText = readFileSync(join(root, "agents/researcher.md"), "utf8");
    for (const s of ["one question", "unverified", "URL", "never install", "not a message to a person"]) expect(researcherText).toContain(s);
    expect(researcherText).toMatch(/never guess/i);
    // Card research-fetch-cap: researchers ran unbounded searches/fetches and took a computer down; Method rule 6
    // states the budget the research-cap.mjs hook enforces, exactly (tester's brief).
    expect(researcherText).toContain(
      "6. Budget: at most 6 WebSearch plus WebFetch calls for your question (research.maxFetches; a hook denies the next one). Try sources in the order the question lists them, and write your findings before the budget runs out, marking anything still unanswered unverified.",
    );
    const planner = parseFrontmatter(readFileSync(join(root, "agents/planner.md"), "utf8"));
    expect(planner.disallowedTools).toContain("Edit");
    // The researcher runs on the `plan` row (opus, high); the Agent tool has no effort parameter, so the row's
    // effort is honored only through the agent's own frontmatter, matching the planner's.
    expect(researcher.effort).toBe("high");
    expect(researcher.effort).toBe(planner.effort);
  });
  it("keeps the Agent tool out of every writable role, so only the lead and the workflow spawn agents (card agent-tool-policy)", () => {
    // 2026-09-09: a writable agent with no tools line inherits every tool, Agent included, and Claude Code lets
    // a subagent spawn subagents up to three layers deep by default. A role that can edit must not also spawn.
    for (const f of readdirSync(join(root, "agents")).sort()) {
      const fm = parseFrontmatter(readFileSync(join(root, "agents", f), "utf8"));
      const deniesAgent = (fm.disallowedTools || "").split(",").map((s) => s.trim()).includes("Agent");
      // sub-agents.md documents a scoped form, `Agent(worker, researcher)`, that still grants spawning: a plain
      // token match on "Agent" would miss it and call the role read-only when it can still spawn.
      const namesAgent = (s) => s === "Agent" || s.startsWith("Agent(");
      const allowsOnlyListed = fm.tools !== undefined && !fm.tools.split(",").map((s) => s.trim()).some(namesAgent);
      expect(deniesAgent || allowsOnlyListed, f).toBe(true);
    }
    for (const f of ["implementer.md", "lead.md"]) {
      const fm = parseFrontmatter(readFileSync(join(root, "agents", f), "utf8"));
      expect(fm.disallowedTools, f).toContain("Agent");
    }
  });
  it("tells the planner that a consumer task depends on its producer, so it lands in a later level (card planner-producer-level)", () => {
    // 2026-09-07, board-reorder (4 runs): a page task that PUTs to a route another task adds, in the same level,
    // blocked at the adversary every run, since the adversary judges the branch against the whole plan goal.
    const planner = readFileSync(join(root, "agents/planner.md"), "utf8");
    for (const s of ["later level", "route", "subcommand", "`dependsOn`", "judges a task branch against the whole plan goal", "plan.mjs validate"]) expect(planner).toContain(s);
    expect(planner).toMatch(/names a file, route, or subcommand (that )?another task owns or introduces/);
  });
  it("tells the planner to search the semantic code index before deciding tasks when memory.index.enabled is true (card semantic-index, brief B)", () => {
    const planner = readFileSync(join(root, "agents/planner.md"), "utf8");
    expect(planner).toContain('memory.mjs" index search');
    expect(planner).toContain("memory.index.enabled");
  });
  it("leaves the implementer's model to the user: the planner sets no tier on its own, and doug-next names any task off the implement row", () => {
    // 2026-09-06: the planner tagged a task "tier": "cheap" by itself and the implementer ran on haiku while the
    // Models table says implement is sonnet. The rows in CLAUDE.md are the user's; a plan lowers one only when asked.
    const planner = readFileSync(join(root, "agents/planner.md"), "utf8");
    expect(planner).not.toContain('"tier": "cheap"');
    expect(planner).toContain("Do not set `tier`, `model`, or `effort` on a task unless the request names one");
    expect(planner).not.toMatch(/tag bounded, mechanical work/);
    const next = readFileSync(join(root, "skills/doug-next/SKILL.md"), "utf8");
    expect(next).toContain("any task whose implementer is not on the implement row");
  });
  it("ships twelve skills and only the user can invoke approve, implement, next, core-next, and doug-swarm", () => {
    const skills = readdirSync(join(root, "skills")).sort();
    expect(skills).toEqual(["core-next", "doug-approve", "doug-decide", "doug-implement", "doug-learn", "doug-next", "doug-plan", "doug-swarm", "harness-fix", "research", "run-report", "swarm-launch"]);
    for (const s of skills) {
      const fm = parseFrontmatter(readFileSync(join(root, "skills", s, "SKILL.md"), "utf8"));
      expect(fm.name).toBe(s);
      expect(fm.description.length).toBeGreaterThan(40);
    }
    for (const s of ["doug-approve", "doug-implement", "doug-next", "core-next", "doug-swarm"]) {
      const fm = parseFrontmatter(readFileSync(join(root, "skills", s, "SKILL.md"), "utf8"));
      expect(fm["disable-model-invocation"]).toBe("true");
    }
    // The hand-track loop has the same two human gates, refuses flow cards, and records through board.mjs.
    const core = readFileSync(join(root, "skills/core-next/SKILL.md"), "utf8");
    expect(core.match(/AskUserQuestion/g).length).toBeGreaterThanOrEqual(2);
    expect(core).toContain("Starting is never automatic");
    expect(core).toContain("next --track hand");
    expect(core).toContain("record <id> --hand");
    expect(core).toContain("flow-track card");
    expect(core).toContain("pnpm test:unit");
    expect(core).toContain("harness-fix");
    expect(parseFrontmatter(core)["allowed-tools"]).toContain("AskUserQuestion");
    // harness-fix is the procedure itself: the model may invoke it, and it names a test file for every module.
    const fix = readFileSync(join(root, "skills/harness-fix/SKILL.md"), "utf8");
    expect(parseFrontmatter(fix)["disable-model-invocation"]).toBeUndefined();
    for (const t of ["template.test.mjs", "board.test.mjs", "plan.test.mjs", "replan.test.mjs", "land.test.mjs", "hooks.test.mjs", "proposal.test.ts", "contract.test.ts"]) expect(fix).toContain(t);
    for (const rule of [".doug/hooks/scripts", "scriptPath", "pnpm test:unit", "Never `pnpm test`", "flow-board.d.ts", "trailers"]) expect(fix).toContain(rule);
    // Every test file the skill names exists.
    for (const m of fix.matchAll(/`((?:plugins|packages)\/[^`]+\.test\.(?:mjs|ts))`/g)) expect(existsSync(join(root, "..", "..", m[1])), m[1]).toBe(true);
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
    // Decision A: the flow track's reviewer agent is unchanged and never gets the mutation instruction.
    const flowReviewer = readFileSync(join(root, "agents/reviewer.md"), "utf8");
    expect(flowReviewer, "flow track's reviewer stays free of the mutation rule (mutation-check-contract)").not.toContain("mutate");

    // The loop's two human gates are real prompts, and the skill never approves on its own.
    const next = readFileSync(join(root, "skills/doug-next/SKILL.md"), "utf8");
    expect(next.match(/AskUserQuestion/g).length).toBeGreaterThanOrEqual(3);
    expect(next).toContain("Approval is never automatic");
    expect(parseFrontmatter(next)["allowed-tools"]).toContain("AskUserQuestion");
    // doug-next refuses a hand-track card by id, and both loops record a landing through run-report.
    expect(next).toContain('"track": "hand"');
    expect(next).toContain("run-report");
    expect(core).toContain("run-report");
    const report = readFileSync(join(root, "skills/run-report/SKILL.md"), "utf8");
    expect(parseFrontmatter(report)["disable-model-invocation"]).toBeUndefined();
    for (const s of ["board.mjs\" record", "board.mjs\" summary", "--hand", "never estimate"]) expect(report).toContain(s);
    // A run's cost is measured from the local transcripts by cost.mjs, never estimated; doug-next hands the run id over.
    expect(report).toContain('scripts/cost.mjs" <run-id>');
    // A hand-track landing also records through memory.mjs, mirroring the workflow form's step 4.
    const handSection = report.slice(report.indexOf("## A hand-track landing"), report.indexOf("## Then"));
    expect(handSection).toContain("memory.mjs");
    expect(handSection).toContain("record <id> --hand");
    // Every adversary block is classified real, marginal, or false when the run is recorded.
    for (const s of ["--adversary", "real", "marginal", "false", "pass-<n>"]) expect(report).toContain(s);
    expect(next).toContain("cost.mjs");
    expect(next).toContain("never estimate");
    const dougSwarmText = readFileSync(join(root, "skills/doug-swarm/SKILL.md"), "utf8");
    for (const skill of [next, core, dougSwarmText]) {
      expect(skill).not.toContain("doug-board");
      expect(skill).not.toContain("moved to In flow");
    }
  });
  it("T5 (card artifact-path-removal): the doug-board skill is gone", () => {
    expect(existsSync(join(root, "skills/doug-board"))).toBe(false);
  });
  it("harness-fix's module table names a test file for every lib/*.mjs and scripts/*.mjs under plugins/doug-flow, not just an incidental mention elsewhere in section 1 (card harness-fix-memory-row)", () => {
    const fix = readFileSync(join(root, "skills/harness-fix/SKILL.md"), "utf8");
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
  // card learn-signals: doug-learn only the user invokes, and it never applies a proposal without asking.
  it("doug-learn asks before applying, one proposal at a time, and only the user invokes it (card learn-signals)", () => {
    const learn = readFileSync(join(root, "skills/doug-learn/SKILL.md"), "utf8");
    const fm = parseFrontmatter(learn);
    expect(fm["disable-model-invocation"]).toBe("true");
    expect(fm["allowed-tools"]).toContain("AskUserQuestion");
    expect(learn).toContain('learn.mjs" propose');
    expect(learn).toContain('learn.mjs" apply');
    const applyIdxs = [...learn.matchAll(/apply/g)].map((m) => m.index);
    expect(applyIdxs.some((i) => /never/.test(learn.slice(Math.max(0, i - 80), i + 80)))).toBe(true);
    expect(learn).toContain("AskUserQuestion");
  });
  // card memory-decisions: doug-decide is the only honest writer of docs/decisions/ and .claude/rules/, and it
  // never applies a proposal without asking, one at a time.
  it("doug-decide asks before applying, one proposal at a time, and only the user invokes it (card memory-decisions)", () => {
    const decide = readFileSync(join(root, "skills/doug-decide/SKILL.md"), "utf8");
    const fm = parseFrontmatter(decide);
    expect(fm["disable-model-invocation"]).toBe("true");
    expect(fm["allowed-tools"]).toContain("AskUserQuestion");
    expect(fm["allowed-tools"]).toContain("memory.mjs");
    expect(fm["allowed-tools"]).toContain("learn.mjs");
    expect(decide).toContain('memory.mjs" decision propose');
    expect(decide).toContain('memory.mjs" decision amend');
    expect(decide).toContain('memory.mjs" rule propose');
    expect(decide).toContain('learn.mjs" apply');
    const applyIdxs = [...decide.matchAll(/apply/g)].map((m) => m.index);
    expect(applyIdxs.some((i) => /never/.test(decide.slice(Math.max(0, i - 80), i + 80)))).toBe(true);
    expect(decide).toContain("AskUserQuestion");
    expect(decide).toContain("protect-paths.mjs refuses");
  });
  // card import-in-run-report: memory.mjs import rolls any auto-memory file written since the last import
  // into the lessons store; it must run before memory.mjs record in every section that lands a run, on both
  // tracks, or freshly-written lessons never reach the store.
  it("runs memory.mjs import before memory.mjs record in every landing section (card import-in-run-report)", () => {
    const report = readFileSync(join(root, "skills/run-report/SKILL.md"), "utf8");
    const sections = [
      ["## A workflow run (flow track)", "## A batch (several cards in one plan)"],
      ["## A batch (several cards in one plan)", "## A hand-track landing"],
      ["## A hand-track landing", "## Then"],
    ];
    for (const [startHeading, endHeading] of sections) {
      const from = report.indexOf(startHeading);
      const to = report.indexOf(endHeading, from);
      expect(from, startHeading).toBeGreaterThan(-1);
      expect(to, startHeading).toBeGreaterThan(from);
      const section = report.slice(from, to);
      const importIdx = section.indexOf('memory.mjs" import');
      const recordIdx = section.indexOf('memory.mjs" record');
      expect(importIdx, startHeading).toBeGreaterThan(-1);
      expect(recordIdx, startHeading).toBeGreaterThan(-1);
      expect(importIdx, startHeading).toBeLessThan(recordIdx);
      const importStep = section.slice(importIdx, recordIdx);
      expect(importStep, startHeading).toContain("an exit 1 naming Node is said in the chat and the landing goes on");
    }
  });
  // card rehearsal-docs: the rehearsal runner was documented only in its own header comment and harness-fix rule
  // 8; docs/rehearsals.md is the page, and this test is its own citation check so the page cannot cite a path,
  // command, or helper name that has gone stale, the way the harness-fix table's test-file paths are checked above.
  // The public export leaves docs/rehearsals.md out, so this citation check runs only where the page exists.
  it.skipIf(IS_SNAPSHOT)("docs/rehearsals.md cites only files, commands, and helpers that exist (card rehearsal-docs)", () => {
    const repoRoot = join(root, "..", "..");
    const page = readFileSync(join(repoRoot, "docs/rehearsals.md"), "utf8");
    const rehearseLib = readFileSync(join(root, "lib/rehearse.mjs"), "utf8");
    const exportedNames = new Set([...rehearseLib.matchAll(/export (?:function|const) ([A-Za-z_]\w*)/g)].map((m) => m[1]));

    // A fenced ```...``` code block's own inline backticks (a node -e one-liner quoting JS template literals) are
    // not citations to check; strip fenced blocks before pairing single-backtick spans, or the triple-backtick
    // fence markers themselves mis-pair with those inner backticks and swallow the rest of the file into one token.
    const proseOnly = page.replace(/```[\s\S]*?```/g, "");
    const tokens = [...proseOnly.matchAll(/`([^`]+)`/g)].map((m) => m[1]);

    // Path check: a token that looks like a repository path (has a "/" or a familiar file extension), does not
    // start with a placeholder marker (~, $, -, <, http — a URL, a flag, an env-style prefix, or a scenario
    // placeholder like <scenario>/<timestamp>), and carries no glob/placeholder/whitespace character is checked
    // against the real repository tree (a trailing "/" is stripped first). Skipped: command lines (anything with
    // a space — already excluded by the whitespace rule below), paths under .doug/.state/ (run artifacts,
    // never checked in), and .doug/plan.json (written by /doug-plan per run; absent from the public export).
    for (const raw of tokens) {
      const looksLikePath = raw.includes("/") || /\.(md|mjs|js|ts|json|jsonl)$/.test(raw);
      if (!looksLikePath) continue;
      if (/^(~|\$|-|<|\/|http)/.test(raw)) continue; // a leading "/" is a slash command (/doug-next), not a repo path
      if (/[<*{\s]/.test(raw)) continue;
      const token = raw.endsWith("/") ? raw.slice(0, -1) : raw;
      if (token.startsWith(".doug/.state/") || token === ".doug/plan.json") continue;
      expect(existsSync(join(repoRoot, token)), token).toBe(true);
    }

    // Named helpers: each must appear backticked on the page and be a real export of lib/rehearse.mjs.
    const namedHelpers = ["assertGateHeld", "assertFlowGateHeld", "assertImplemented", "assertHandBuilt", "assertTwoParents", "pluginsLoaded", "slashCommandPresent", "unresolvedAgentNames", "sessionCost", "prepareFixture", "ESTIMATES", "SCENARIO_STAGES"];
    for (const name of namedHelpers) {
      expect(tokens.some((t) => t === name || t.startsWith(`${name}(`)), name).toBe(true);
      expect(exportedNames.has(name), name).toBe(true);
    }

    // Generic check, per token (not merely "does the right spelling appear somewhere" — a table row that
    // misspells one mention used to survive because the correct spelling still appeared elsewhere on the page):
    // a backticked token that names a function call (an identifier immediately followed by "(", e.g.
    // `assertGateHeld(` or `assertGateHeld(dir, stream, ...)`), that is bare ALL_CAPS, or that is a bare
    // `assert*`-shaped identifier (every assertion helper's own naming convention, so a table cell that just
    // writes the plain name is checked too) must itself be a real export of lib/rehearse.mjs, except the two env
    // vars the runner reads (never exports; checked against the module's own text instead).
    for (const raw of tokens) {
      const call = /^([A-Za-z_]\w*)\(/.exec(raw);
      const bareAllCaps = /^[A-Z][A-Z0-9_]*$/.test(raw) ? raw : null;
      const bareAssert = /^assert[A-Z]\w*$/.test(raw) ? raw : null; // assertX...; bare "assert" itself is the stage-shape word, not a helper
      const name = call ? call[1] : bareAllCaps || bareAssert;
      if (!name) continue;
      if (name === "DOUG_REHEARSE_CLAUDE" || name === "CLAUDE_PROJECT_DIR") {
        expect(rehearseLib, name).toContain(name);
        continue;
      }
      expect(exportedNames.has(name), name).toBe(true);
    }

    // The section content the card requires.
    for (const s of [
      "fix-hours",
      "ts-basic",
      "AskUserQuestion",
      "$2.16",
      "$4.15",
      "$4.32",
      "$2.13",
      "gates-live-check",
      "rehearsal-swarm-splittable",
      "--spend",
      "--card",
      "Artifact",
      "CLAUDE_PROJECT_DIR",
      "Rehearsal",
      "gate.jsonl",
      "implement.jsonl",
      "last-report.json",
      "~/.claude/projects/",
      "DOUG_REHEARSE_CLAUDE",
      "afterAll",
      "tempDirs",
      "{ ok, message }",
    ]) expect(page, s).toContain(s);

    const fix = readFileSync(join(root, "skills/harness-fix/SKILL.md"), "utf8");
    expect(fix).toContain("docs/rehearsals.md");
    // card readme-scannable: the docs/rehearsals.md mention lives in the Layout section, moved to docs/reference.md.
    const referenceDoc = readFileSync(join(repoRoot, "docs/reference.md"), "utf8");
    expect(referenceDoc).toContain("docs/rehearsals.md");
  });
  // 2026-09-07 (card core-next-swarm-opt-in): a size M or L hand-track card got no parallelism, while the lead
  // model was doing implement/verify/review work itself instead of only orchestrating, on both tracks.
  it("core-next: a size M or L hand-track card may run as a swarm, and the lead only orchestrates on both tracks (card core-next-swarm-opt-in)", () => {
    const core = readFileSync(join(root, "skills/core-next/SKILL.md"), "utf8");
    expect(core.match(/AskUserQuestion/g).length).toBeGreaterThanOrEqual(5);
    for (const s of [
      "size",
      "M or L",
      "by hand",
      "swarm-launch",
      "plan.mjs set swarm on",
      "doug-plan",
      "Approval is never automatic",
      "workflows/doug-implement.js",
      "plugins/doug-gates/scripts",
      "plugins/doug-flow/agents",
      "record <id> --hand",
      "record <id> <report",
      "`implement` row",
      "`review` row",
      "`worker` row",
      "never implements",
      "Agent tool",
      "both tracks",
    ]) expect(core, s).toContain(s);
    const coreFm = parseFrontmatter(core);
    expect(coreFm["allowed-tools"]).toContain("Agent");
    expect(coreFm["allowed-tools"]).toContain("Workflow");
    expect(coreFm["allowed-tools"]).toContain("AskUserQuestion");
    expect(coreFm["disable-model-invocation"]).toBe("true");
    expect(core).not.toContain("board build --artifact");

    const fix = readFileSync(join(root, "skills/harness-fix/SKILL.md"), "utf8");
    for (const s of ["`implement` row", "`review` row", "lead", "Agent tool", "both tracks"]) expect(fix, s).toContain(s);

    const swarmLaunch = readFileSync(join(root, "skills/swarm-launch/SKILL.md"), "utf8");
    expect(swarmLaunch).toContain("/core-next");

    const claude = readFileSync(join(root, "..", "..", "CLAUDE.md"), "utf8");
    expect(claude).toContain("both tracks");
    for (const s of ["`implement`", "`review`", "`worker` row", "Agent tool"]) expect(claude, s).toContain(s);
    expect(claude.split("\n").length).toBeLessThanOrEqual(61);

    // The public export leaves docs/decisions/ out; the ADR is checked only where it exists.
    if (!IS_SNAPSHOT) {
      const decision = readFileSync(join(root, "..", "..", "docs/decisions/0005-two-tracks.md"), "utf8");
      for (const s of ["Amendment", "2026-09-07", "swarm", "workflows/doug-implement.js", "both tracks", "verify, review, and adversary"]) expect(decision, s).toContain(s);
    }
  });
  // 2026-09-13 (card claude-md-from-lessons): CLAUDE.md's tracked line budget and its source-cited edits file
  // (.doug/claude-md-edits.json, consumed by `memory.mjs claude-md propose`) both need a standing guard.
  it("claude-md-from-lessons: CLAUDE.md stays under 60 lines with its parsed headers, and .doug/claude-md-edits.json is source-cited (card claude-md-from-lessons)", () => {
    const claudeMdPath = join(root, "..", "..", "CLAUDE.md");
    const claude = readFileSync(claudeMdPath, "utf8");
    const countLines = (text) => (text === "" ? 0 : text.endsWith("\n") ? text.split("\n").length - 1 : text.split("\n").length);
    expect(countLines(claude)).toBeLessThanOrEqual(60);
    for (const s of ["## Models", "| Work      | Model   | Effort  |", "|-----------|---------|---------|"]) expect(claude, s).toContain(s);

    const commandsIdx = claude.indexOf("## Commands");
    expect(commandsIdx).toBeGreaterThanOrEqual(0);
    const fenceStart = claude.indexOf("```sh", commandsIdx);
    expect(fenceStart).toBeGreaterThanOrEqual(0);
    const fenceEnd = claude.indexOf("```", fenceStart + 5);
    expect(fenceEnd).toBeGreaterThan(fenceStart);
    const commandsBlock = claude.slice(fenceStart, fenceEnd);
    for (const s of ["pnpm install --frozen-lockfile", "pnpm typecheck", "pnpm test:unit", "pnpm exec vitest run", "pnpm test", "pnpm build"]) {
      expect(commandsBlock, s).toContain(s);
    }

    // .doug/claude-md-edits.json is a dev-repo file, absent from the public export; the CLAUDE.md checks above
    // still run there.
    const editsPath = join(root, "..", "..", ".doug/claude-md-edits.json");
    if (!existsSync(editsPath)) return;
    const edits = JSON.parse(readFileSync(editsPath, "utf8"));
    expect(Array.isArray(edits.add)).toBe(true);
    expect(edits.add.length).toBeGreaterThan(0);
    for (const entry of edits.add) {
      expect(typeof entry.source === "string" && entry.source.trim() !== "", JSON.stringify(entry)).toBe(true);
      expect(typeof entry.heading === "string" && claude.includes(entry.heading), JSON.stringify(entry)).toBe(true);
    }
    const hookScriptsDir = join(root, "..", "..", ".doug/hooks/scripts");
    for (const entry of edits.remove || []) {
      expect(typeof entry.source === "string" && entry.source.trim() !== "", JSON.stringify(entry)).toBe(true);
      expect(typeof entry.enforcedBy === "string" && entry.enforcedBy.trim() !== "", JSON.stringify(entry)).toBe(true);
      if (entry.enforcedBy.endsWith(".mjs")) {
        expect(existsSync(join(hookScriptsDir, entry.enforcedBy)), entry.enforcedBy).toBe(true);
      }
    }
  });
  // 2026-09-13 (card core-next-batch-swarm): /doug-next took several cards in one merged plan; /core-next still
  // took exactly one. The batch primitive (board.mjs next --batch, plan.mjs merge) was already track-aware, but
  // the skill never called it that way, and by-hand cards have no batch (a batch there is only step 5's loop with
  // fewer gates, not worth collapsing n approvals for).
  it("core-next: /core-next <id> <id>... or --batch <n> runs several hand-track cards as one swarmed batch; by-hand stays one card at a time (card core-next-batch-swarm)", () => {
    const core = readFileSync(join(root, "skills/core-next/SKILL.md"), "utf8");

    // Selection forms reuse /doug-next's batch machinery verbatim: next --batch <n> --track hand, plan.mjs merge,
    // per-card drafts, and the batch's cost/summary reporting forms.
    for (const s of [
      "/core-next <id> <id>...",
      "/core-next --batch <n>",
      "next --batch <n> --track hand",
      "plan.mjs merge",
      ".doug/.state/drafts/<id>.json",
      "plan.mjs validate --file",
      "--by-card",
      "--shared-cost",
      // Minor 2 (review): the batch summary line must carry --wall and --commit too, or runSummary prints
      // "wall not measured" and omits the sha (run-report's batch section line 35 always passes them).
      'summary <report.json> --card <id> --wall "<m> min" --commit <merge sha>',
    ]) expect(core, s).toContain(s);

    // Minor 3 (review): the batch's planners are spawned in one message, mirroring /doug-next line 43.
    expect(core).toContain("in the same message so they run in parallel");

    // The swarm-only scope: a batch runs only as a swarm, and by-hand stays one card at a time.
    expect(core).toContain("A batch runs only as a swarm");
    expect(core).toContain("one card at a time");

    // Eligibility is checked before any planner is spawned (design question b).
    expect(core).toContain("before the start gate and before any planner");
    expect(core).toMatch(/set aside/);
    // Minor 4 (review): the all-set-aside edge (nothing left to batch) is named, not silently a no-op.
    expect(core).toContain("sets every card of the batch aside");
    expect(core).toContain("whether by a set-aside or by a drop");

    // Never plan.mjs set card for a batch: merge's cards replaces it (design question b, continued).
    expect(core).toContain("Never `plan.mjs set card` for a batch");
    // Minor 6 (review): tightened guard. Every occurrence of "plan.mjs set card" is either inside the
    // single-card ("Otherwise, for one card") paragraph, or has "Never"/"not"/"never" in the 12 characters
    // right before it — not merely somewhere on the same line, which a line like
    // 'Never `plan.mjs set card` for a batch. Batch: also run `plan.mjs set card <id>`' would satisfy for its
    // SECOND, unguarded occurrence even though the guard belongs only to the first.
    {
      const paragraphAt = (text, idx) => {
        const start = text.lastIndexOf("\n\n", idx) + 2;
        let end = text.indexOf("\n\n", idx);
        if (end === -1) end = text.length;
        return text.slice(start, end);
      };
      // "?\s+ covers both the prose form ("plan.mjs set card") and the real command form
      // (`.../plan.mjs" set card <id>`, a quote then a space between the script path and the subcommand).
      const re = /plan\.mjs"?\s+set card/g;
      let m;
      let occurrences = 0;
      while ((m = re.exec(core))) {
        occurrences++;
        const idx = m.index;
        const para = paragraphAt(core, idx);
        if (para.trimStart().startsWith("Otherwise, for one card")) continue;
        const before = core.slice(Math.max(0, idx - 12), idx);
        expect(/never|not/i.test(before), `unguarded occurrence at index ${idx}: "...${before}[plan.mjs set card]..."`).toBe(true);
      }
      expect(occurrences).toBeGreaterThanOrEqual(2); // the batch refusal and the single-card set, at least
    }

    // The one start gate for the whole batch (design question a), and the paused/failed/dissolved batch (c).
    expect(core).toMatch(/one .*start gate/i);
    // Minor 5 (review): assert the actual batch Stop sentence, not the vacuous substring "Stop".
    expect(core).toContain("Stop on a batch moves every card back to Ready");
    expect(core).toContain("dissolves it");
    expect(core).toContain("board.mjs move <id> ready");
    expect(core).toContain('"Board: <id>, <id> done as <sha>"');
    // plan.mjs set swarm on appears in the batch paragraph itself (the one with plan.mjs merge), not only the
    // single-card path.
    {
      const mergeIdx = core.indexOf("merge <id> <id>...");
      expect(mergeIdx).toBeGreaterThan(-1);
      const paragraphAt = (text, idx) => {
        const start = text.lastIndexOf("\n\n", idx) + 2;
        let end = text.indexOf("\n\n", idx);
        if (end === -1) end = text.length;
        return text.slice(start, end);
      };
      expect(paragraphAt(core, mergeIdx)).toContain("set swarm on");
    }

    // Docs updated where they contrasted /doug-next's batch as if /core-next had none.
    const boardDoc = readFileSync(join(root, "..", "..", "docs/board.md"), "utf8");
    expect(boardDoc).toContain("`/doug-next`, or `/core-next` with `--track hand`, plans together in one plan");
    // Minor 1 (review): README also contrasted /core-next with /doug-next's batch as flow-track-only.
    // card readme-scannable: this sentence lives in "The board" section, moved to docs/reference.md.
    const readmeBatch = readFileSync(join(root, "..", "..", "docs/reference.md"), "utf8");
    expect(readmeBatch).toContain("`/core-next <id> <id>...` or `/core-next --batch <n>` does the same for hand-track cards, swarm-only");
  });
  // 2026-09-13/14 (card hand-track-tester-and-mutations): across seven /core-next cards the opus reviewer's rule-7
  // mutations caught three misses the sonnet coder had reported green, and two further defects came from the
  // lead's brief paraphrasing the workflow instead of quoting it. The coder was choosing its own single mutation
  // (the one its test obviously catches), not the case the card complained about.
  it("harness-fix rule 7 lists one mutation per case, and core-next spawns a tester before the coder and requires quoted facts (card hand-track-tester-and-mutations)", () => {
    const harnessFix = readFileSync(join(root, "skills/harness-fix/SKILL.md"), "utf8");
    const core = readFileSync(join(root, "skills/core-next/SKILL.md"), "utf8");

    // Sentence 1: the mutation-list rule (harness-fix rule 7).
    const mutationListSentence =
      "the brief lists one mutation per case the card's goal names, each with the test that must fail; the coder runs every listed mutation and reports each result; the reviewer reruns the list and adds its own";
    expect(harnessFix, mutationListSentence).toContain(mutationListSentence);

    // Sentence 2: the tester seat (core-next step 3), in two parts.
    const testerSpawnSentence =
      "before the coder, spawn the project's `tester` agent (`.claude/agents/tester.md`, on the `implement` row) with the goal as the acceptance list and the test file `harness-fix` names, so the failing tests are written from the card, not from the code";
    expect(core, testerSpawnSentence).toContain(testerSpawnSentence);
    const testerNoEditSentence =
      "the coder then makes them pass and may not edit a test except with a stated reason in its report; the reviewer checks that rule";
    expect(core, testerNoEditSentence).toContain(testerNoEditSentence);

    // Sentence 3: quote, never paraphrase (core-next step 3).
    const quoteSentence =
      "a fact the brief states about the workflow, a hook contract, or a model row is copied verbatim from CLAUDE.md, README, docs, or the code with its path, never paraphrased; a claim the lead cannot cite goes into the brief as unverified";
    expect(core, quoteSentence).toContain(quoteSentence);

    // Order: the tester is named before the coder in step 3.
    const testerIdx = core.indexOf(testerSpawnSentence);
    const coderIdx = core.indexOf("the project's `coder` agent");
    expect(testerIdx).toBeGreaterThan(-1);
    expect(coderIdx).toBeGreaterThan(-1);
    expect(testerIdx).toBeLessThan(coderIdx);

    // The explicit ordering sentence itself (M11: deleting it entirely must fail).
    const orderSentence =
      "The order is: research (when called for), harness-fix, the brief, the tester, the coder, the reviewer";
    expect(core, orderSentence).toContain(orderSentence);

    // The mutation-list-rule-7 clause in the brief instructions (M13: deleting it must fail).
    const briefMutationListClause =
      "the mutation list rule 7 now demands (one mutation per case the card's goal names, each with the test that must fail)";
    expect(core, briefMutationListClause).toContain(briefMutationListClause);

    // The tester, not the coder, writes the test (M16: deleting this clause must fail; M17: flipping it to
    // "the coder writes" must fail).
    const testerWritesClause =
      "the tester writes or extends that file first, from the goal; the coder runs only that file while iterating and does not write tests";
    expect(core, testerWritesClause).toContain(testerWritesClause);

    // The tester's seat is unconditional: no size-S carve-out that has the lead skip the tester and write the
    // failing tests itself (M14: prepending such a carve-out to the tester paragraph must fail).
    const paragraphAt = (text, idx) => {
      const start = text.lastIndexOf("\n\n", idx) + 2;
      let end = text.indexOf("\n\n", idx);
      if (end === -1) end = text.length;
      return text.slice(start, end);
    };
    const testerParagraph = paragraphAt(core, testerIdx);
    expect(testerParagraph).not.toMatch(/skip|instead of the tester|without the tester/i);
  });
  // 2026-09-14 (card subagent-stop-gate-tester-red): the tester's own report must end with the
  // tests_red_by_design claim so the SubagentStop gate lets it stop once, instead of retrying the suite.
  it("T10 core-next step 3 tells the tester to end its report with the tests_red_by_design claim (card subagent-stop-gate-tester-red)", () => {
    const core = readFileSync(join(root, "skills/core-next/SKILL.md"), "utf8");
    const testerSpawnSentence =
      "before the coder, spawn the project's `tester` agent (`.claude/agents/tester.md`, on the `implement` row) with the goal as the acceptance list and the test file `harness-fix` names, so the failing tests are written from the card, not from the code";
    const sentence =
      "Tell the tester to end its report with the `tests_red_by_design` claim naming the test files it left red, so the SubagentStop gate lets it stop; the lead's own Stop stays red until the coder's change lands.";
    expect(core).toContain(sentence);
    const testerIdx = core.indexOf(testerSpawnSentence);
    expect(testerIdx).toBeGreaterThan(-1);
    const paragraphAt = (text, idx) => {
      const start = text.lastIndexOf("\n\n", idx) + 2;
      let end = text.indexOf("\n\n", idx);
      if (end === -1) end = text.length;
      return text.slice(start, end);
    };
    const testerParagraph = paragraphAt(core, testerIdx);
    expect(testerParagraph).toContain(sentence);
    expect(testerParagraph).not.toMatch(/skip|instead of the tester|without the tester/i);
  });
  // 2026-09-24 (card tester-claim-missed-in-handback, pass 2): the SubagentStop gate now reads the hand-back
  // as a fallback when last_assistant_message holds no claim, so the plain text and the hand-back are both live.
  it("core-next step 3 tells the tester the claim may sit in plain text or the hand-back, plain text read first (card tester-claim-missed-in-handback)", () => {
    const core = readFileSync(join(root, "skills/core-next/SKILL.md"), "utf8");
    expect(core).toContain(
      "The claim may sit in the tester's final plain-text message or in its hand-back call; the gate reads the plain text first, then the last hand-back."
    );
  });
  // 2026-09-14 (card harness-fix-tester-seat-wording): found by the reviewer of hand-track-tester-and-mutations —
  // core-next step 3 already spawns the project's tester agent to write the failing tests from the card's goal,
  // but harness-fix's own section 0 still said the coder "implements, tests first" and section 1's intro read
  // as if the coder wrote the test, contradicting the seat core-next just gave the tester.
  it("harness-fix names the tester agent on the implement row as the one who writes the test first, and no longer says the coder tests first (card harness-fix-tester-seat-wording)", () => {
    const fix = readFileSync(join(root, "skills/harness-fix/SKILL.md"), "utf8");
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
    const fix = readFileSync(join(root, "skills/harness-fix/SKILL.md"), "utf8");
    expect(fix).toContain(
      "A tester that leaves tests red by design ends with its tests_red_by_design claim, in its final plain-text message or its hand-back call; the SubagentStop gate reads both."
    );
  });
  // 2026-09-14 (card landing-suggests-follow-ups): after proposal-ledger-forgeable landed on 2026-09-12, the
  // user had to ask "do we need a follow up card?" before the two follow-up cards it produced were added by
  // hand — /core-next step 4 recorded the landing and step 5 asked only "take the next card?", so whether a
  // follow-up card got written depended on the user asking. This test pins the new step both skills gain
  // between recording the landing and the continue gate: it gathers the run's own follow-up candidates and
  // offers them with AskUserQuestion before the continue gate, adding accepted ones with `doug board add`.
  it("K core-next and doug-next gather follow-up candidates and offer them with AskUserQuestion before the continue gate (card landing-suggests-follow-ups)", () => {
    const core = readFileSync(join(root, "skills/core-next/SKILL.md"), "utf8");
    const dougNext = readFileSync(join(root, "skills/doug-next/SKILL.md"), "utf8");

    // K1 position: the new section sits after the landing step and before the (renumbered) continue gate, in
    // both skills.
    const coreRecordIdx = core.indexOf("## 4. Record and land");
    const coreFollowUpIdx = core.indexOf("## 5. Follow-up cards");
    const coreGateIdx = core.indexOf("## 6. Human gate: continue");
    expect(coreRecordIdx, "core-next: '## 4. Record and land' not found").toBeGreaterThan(-1);
    expect(coreFollowUpIdx, "core-next: '## 5. Follow-up cards' not found").toBeGreaterThan(-1);
    expect(coreGateIdx, "core-next: '## 6. Human gate: continue' not found").toBeGreaterThan(-1);
    expect(coreFollowUpIdx).toBeGreaterThan(coreRecordIdx);
    expect(coreFollowUpIdx).toBeLessThan(coreGateIdx);

    const dougLandIdx = dougNext.indexOf("## 5. Land");
    const dougFollowUpIdx = dougNext.indexOf("## 6. Follow-up cards");
    const dougGateIdx = dougNext.indexOf("## 7. Human gate: continue");
    expect(dougLandIdx, "doug-next: '## 5. Land' not found").toBeGreaterThan(-1);
    expect(dougFollowUpIdx, "doug-next: '## 6. Follow-up cards' not found").toBeGreaterThan(-1);
    expect(dougGateIdx, "doug-next: '## 7. Human gate: continue' not found").toBeGreaterThan(-1);
    expect(dougFollowUpIdx).toBeGreaterThan(dougLandIdx);
    expect(dougFollowUpIdx).toBeLessThan(dougGateIdx);

    // K2 multiSelect form: the exact AskUserQuestion sentence, verbatim, in both skills.
    // 2026-09-19 (card core-next-condition-open): the follow-up option's fields gain class alongside size, so
    // a `doug board add` follow-up carries a class from the start; core-next and doug-next stay identical.
    const multiSelectSentence =
      'Otherwise ask once with `AskUserQuestion`, `multiSelect: true`, one option per suggestion with a proposed id, title, column, size, class, track, and deps on the landed card, plus a "none" option.';
    expect(core, multiSelectSentence).toContain(multiSelectSentence);
    expect(dougNext, multiSelectSentence).toContain(multiSelectSentence);

    // K3 the add rule: `doug board add` (never a script), `doug board reorder <id> --top`, and Decide when a
    // decision is needed, in both skills.
    const addRuleSentence = "Each accepted suggestion is added with `doug board add` (never a script that edits the record)";
    expect(core, addRuleSentence).toContain(addRuleSentence);
    expect(dougNext, addRuleSentence).toContain(addRuleSentence);
    expect(core, "`doug board reorder <id> --top`").toContain("`doug board reorder <id> --top`");
    expect(dougNext, "`doug board reorder <id> --top`").toContain("`doug board reorder <id> --top`");
    expect(core, "to Decide when it needs a decision").toContain("to Decide when it needs a decision");
    expect(dougNext, "to Decide when it needs a decision").toContain("to Decide when it needs a decision");

    // K4 no candidates, no question: the exact sentence, in both skills.
    const noCandidatesSentence = "A landing with no candidates skips the question.";
    expect(core, noCandidatesSentence).toContain(noCandidatesSentence);
    expect(dougNext, noCandidatesSentence).toContain(noCandidatesSentence);

    // K5 never invented: the exact sentence, in both skills.
    const neverInventedSentence =
      "Suggestions come only from what the run actually reported, never invented; each carries the one-line reason and cites the pass that found it.";
    expect(core, neverInventedSentence).toContain(neverInventedSentence);
    expect(dougNext, neverInventedSentence).toContain(neverInventedSentence);

    // 2026-09-15 (card follow-up-step-threshold): the K12 batch chain ran eight S cards because the follow-up
    // step had no threshold on out-of-scope findings. Pin the threshold sentence in both skills' follow-up
    // sections.
    const thresholdSentence =
      "A reviewer's out-of-scope finding is offered only when it is realistic drift (a form a model or a person would plausibly write) or when one card would close the whole class; otherwise it goes in the landing note and the lead recommends none.";
    const coreFollowUpSection = core.slice(coreFollowUpIdx, coreGateIdx);
    const dougFollowUpSection = dougNext.slice(dougFollowUpIdx, dougGateIdx);
    expect(coreFollowUpSection, "core-next follow-up step: threshold sentence must be present").toContain(
      thresholdSentence
    );
    expect(dougFollowUpSection, "doug-next follow-up step: threshold sentence must be present").toContain(
      thresholdSentence
    );

    // K6 one commit, no republish: the served page shows the new cards live, in both skills.
    expect(core, "core-next should contain 'follow-ups added:'").toContain("follow-ups added:");
    expect(core, "core-next should contain the served-page sentence").toContain("shows the new cards without a republish");
    expect(dougNext, "doug-next should contain 'follow-ups added:'").toContain("follow-ups added:");
    expect(dougNext, "doug-next should contain the served-page sentence").toContain("shows the new cards without a republish");

    // K7 doug-next only: the frontmatter allowed-tools list is widened for `doug board add`.
    const dougFm = parseFrontmatter(dougNext);
    expect(dougFm["allowed-tools"], "doug-next frontmatter allowed-tools").toContain("Bash(doug board *)");

    // K8 (review follow-up): the add command carries deps on the landed card, in both skills.
    expect(core, "--deps <landed-id> --column <ready|decide>").toContain("--deps <landed-id> --column <ready|decide>");
    expect(dougNext, "--deps <landed-id> --column <ready|decide>").toContain("--deps <landed-id> --column <ready|decide>");

    // K9 (review follow-up): track-specific candidate sources, exact sentence per skill.
    const coreCandidatesSentence =
      'Before the continue gate, gather the follow-up candidates this landing produced: the coder\'s and reviewer\'s "left out", "not closed", and "found on the way" items, the landing note, and any defect the reviewer marked out of scope.';
    expect(core, coreCandidatesSentence).toContain(coreCandidatesSentence);
    const dougCandidatesSentence =
      "Before the continue gate, gather the follow-up candidates this landing produced: the report's review issues, the adversary blocks classified marginal or false whose reason names a hole, the integrate stage's conflicts and failed verify tails, and the landing summary.";
    expect(dougNext, dougCandidatesSentence).toContain(dougCandidatesSentence);

    // K10 (review follow-up): the one-commit sentence, exact, in both skills.
    const oneCommitSentence =
      'Then one commit `"Board: <id> follow-ups added: <new-id>, <new-id>"`, whatever the count; the served page (`doug board serve`) shows the new cards without a republish.';
    expect(core, oneCommitSentence).toContain(oneCommitSentence);
    expect(dougNext, oneCommitSentence).toContain(oneCommitSentence);

    // K11 (review follow-up): the batch sentence, exact, in both skills.
    const batchSentence =
      "Batch: each suggestion's deps name the card of the batch it came from; still one question and one commit for the whole batch.";
    expect(core, batchSentence).toContain(batchSentence);
    expect(dougNext, batchSentence).toContain(batchSentence);
  });
  // 2026-09-15: the reviewer of card landing-suggests-follow-ups (d598739) found doug-swarm is a third landing
  // loop with a continue gate and no follow-up cards step. Card doug-swarm-follow-up-step gives it the same step.
  it("K12 doug-swarm gathers follow-up candidates and offers them with AskUserQuestion before its continue gate (card doug-swarm-follow-up-step)", () => {
    const swarm = readFileSync(join(root, "skills/doug-swarm/SKILL.md"), "utf8");

    // position: the new section sits after the landing step and before the (renumbered) continue gate; the old
    // "## 6. Human gate: continue" header must be gone (a stale second step 6 must fail).
    const landIdx = swarm.indexOf("## 5. Land and record");
    const followUpIdx = swarm.indexOf("## 6. Follow-up cards");
    const gateIdx = swarm.indexOf("## 7. Human gate: continue");
    expect(landIdx, "doug-swarm: '## 5. Land and record' not found").toBeGreaterThan(-1);
    expect(followUpIdx, "doug-swarm: '## 6. Follow-up cards' not found").toBeGreaterThan(-1);
    expect(gateIdx, "doug-swarm: '## 7. Human gate: continue' not found").toBeGreaterThan(-1);
    expect(followUpIdx, "doug-swarm: follow-up section must come after the landing step").toBeGreaterThan(landIdx);
    expect(gateIdx, "doug-swarm: continue gate must come after the follow-up section").toBeGreaterThan(followUpIdx);
    expect(swarm, "doug-swarm: stale '## 6. Human gate: continue' header must be gone").not.toContain("## 6. Human gate: continue");

    // the candidates sentence, verbatim.
    const candidatesSentence =
      "Before the continue gate, gather the follow-up candidates this landing produced: the report's review issues, the adversary blocks classified marginal or false whose reason names a hole, the integrate stage's conflicts and failed verify tails, and the landing summary.";
    expect(swarm, candidatesSentence).toContain(candidatesSentence);

    // the never-invented sentence, verbatim.
    const neverInventedSentence =
      "Suggestions come only from what the run actually reported, never invented; each carries the one-line reason and cites the pass that found it.";
    expect(swarm, neverInventedSentence).toContain(neverInventedSentence);

    // the no-candidates sentence, verbatim.
    const noCandidatesSentence = "A landing with no candidates skips the question.";
    expect(swarm, noCandidatesSentence).toContain(noCandidatesSentence);

    // the multiSelect sentence, verbatim.
    // 2026-09-19 (card core-next-condition-open): the follow-up option's fields gain class alongside size,
    // matching core-next and doug-next.
    const multiSelectSentence =
      'Otherwise ask once with `AskUserQuestion`, `multiSelect: true`, one option per suggestion with a proposed id, title, column, size, class, track, and deps on the landed card, plus a "none" option.';
    expect(swarm, multiSelectSentence).toContain(multiSelectSentence);

    // the add rule: the add sentence, the reorder fragment, the Decide fragment, and the deps/column fragment.
    const addRuleSentence = "Each accepted suggestion is added with `doug board add` (never a script that edits the record)";
    expect(swarm, addRuleSentence).toContain(addRuleSentence);
    expect(swarm, "`doug board reorder <id> --top`").toContain("`doug board reorder <id> --top`");
    expect(swarm, "to Decide when it needs a decision").toContain("to Decide when it needs a decision");
    expect(swarm, "--deps <landed-id> --column <ready|decide>").toContain("--deps <landed-id> --column <ready|decide>");

    // the one-commit sentence, verbatim, and the served-page phrase.
    const oneCommitSentence =
      'Then one commit `"Board: <id> follow-ups added: <new-id>, <new-id>"`, whatever the count; the served page (`doug board serve`) shows the new cards without a republish.';
    expect(swarm, oneCommitSentence).toContain(oneCommitSentence);
    expect(swarm, "doug-swarm should contain the served-page sentence").toContain("shows the new cards without a republish");

    // frontmatter: allowed-tools widened for `doug board add`, AskUserQuestion still present, model invocation still disabled.
    const swarmFm = parseFrontmatter(swarm);
    expect(swarmFm["allowed-tools"], "doug-swarm frontmatter allowed-tools").toContain("Bash(doug board *)");
    expect(swarmFm["allowed-tools"], "doug-swarm frontmatter allowed-tools").toContain("Bash(node *bin.js board *)");
    expect(swarmFm["allowed-tools"], "doug-swarm frontmatter allowed-tools").toContain("AskUserQuestion");
    expect(swarmFm["disable-model-invocation"], "doug-swarm frontmatter disable-model-invocation").toBe("true");

    // 2026-09-15 (card doug-swarm-k12-unpinned-cases): the reviewer of card doug-swarm-follow-up-step (239918c)
    // found mutation R2 that K12 passed silently. Pin the goal-without-a-card sentence (R2).

    // assertion 9 (R2): the goal-without-a-card sentence, verbatim, in section 6.
    const section6 = swarm.slice(followUpIdx, gateIdx);
    const goalWithoutCardSentence =
      "A goal without a card (section 1's second bullet) skips this step, the way section 5 says such a run skips the board steps.";
    expect(section6, "doug-swarm section 6: goal-without-a-card sentence must be present").toContain(goalWithoutCardSentence);

    // 2026-09-15 (card follow-up-step-threshold): the K12 batch chain ran eight S cards because the follow-up
    // step had no threshold on out-of-scope findings. Pin the threshold sentence in doug-swarm's section 6.
    const thresholdSentence =
      "A reviewer's out-of-scope finding is offered only when it is realistic drift (a form a model or a person would plausibly write) or when one card would close the whole class; otherwise it goes in the landing note and the lead recommends none.";
    expect(section6, "doug-swarm follow-up step: threshold sentence must be present").toContain(thresholdSentence);

    const dougNextBatchSentence =
      "Batch: each suggestion's deps name the card of the batch it came from; still one question, one commit, and one republish for the whole batch.";
    expect(swarm, "doug-swarm: doug-next's batch sentence must not appear").not.toContain(dougNextBatchSentence);
    const body = swarm.replace(/^---\n[\s\S]*?\n---/, "");
    // assertion 10 (R3, card doug-swarm-k12-batch-any-prefix): closes the K12 batch-paragraph chain begun by
    // doug-swarm-follow-up-step. Each later card in the chain — doug-swarm-k12-unpinned-cases (any batch
    // paragraph, not just doug-next's exact sentence), doug-swarm-k12-batch-any-section (not scoped to section
    // 6), doug-swarm-k12-batch-forms (indentation, markdown emphasis, and case), doug-swarm-k12-batch-list-item
    // (list and heading markers), doug-swarm-k12-batch-delimiters (paren-numbered lists and space-less
    // headings), doug-swarm-k12-batch-seven-hash (seven-or-more-hash headings), and
    // doug-swarm-k12-batch-escaped-hash (a backslash-escaped hash run) — widened the regex by one Markdown
    // prefix form, and each review found the next form the regex still missed. This card closes the class by
    // design with a prefix-agnostic regex: a line is rejected when the first letters on it, after any run of
    // non-letter characters (whitespace, list markers, hashes, backslashes, blockquote and emphasis markers,
    // backticks, digits), spell "batch" followed by optional whitespace and a colon. Chosen `[^a-z]*` (not the
    // line-local `[^a-z\n]*` alternative) — the class excludes letters case-insensitively either way, and
    // letting the non-letter run span a blank line still only matches when some line's first letters spell
    // "batch:" (tester's brief, fact F5). The only lines this cannot catch start with a letter, which is the
    // control class by definition, so no further prefix card follows this one. The chain's history stays in
    // git and docs/live-runs.md.
    expect(
      body,
      "doug-swarm: no line whose first letters spell batch followed by a colon, behind any non-letter prefix (whitespace, list marker, hashes, backslashes, blockquote, emphasis, backtick, digits), after the frontmatter",
    ).not.toMatch(/^[^a-z]*batch\s*:/im);
  });
  it("names a research step before the plan for a card whose goal depends on facts outside the repository", () => {
    // 2026-09-06: run-trace and precompact-anchor each needed the claude-code-guide agent ad hoc; no procedure said so.
    const research = readFileSync(join(root, "skills/research/SKILL.md"), "utf8");
    const fm = parseFrontmatter(research);
    expect(fm["disable-model-invocation"]).toBeUndefined();
    expect(fm["allowed-tools"]).toContain("Agent");
    // When to take it, which agent runs it (the plugin's researcher by default, the guide for Claude Code questions),
    // several researchers with distinct questions merging into one note.
    for (const s of ["outside the repository", "claude-code-guide", "doug-flow:researcher", "WebFetch", "distinct question", "one note", "sources", "unverified", "in parallel", ".doug/.state/research/"]) expect(research).toContain(s);
    expect(research).not.toContain("general-purpose");
    // Card research-fetch-cap: the lead puts the budget and the raw URLs, in priority order, into each question.
    expect(research).toContain("Each question names the budget (at most 6 WebSearch plus WebFetch calls, research.maxFetches) and lists the raw URLs to try, in priority order.");
    // Pass 2, P2: the budget is per agent, not per question, so a reused guide must be told its budget is shared.
    expect(research).toContain(
      "The fetch budget (research.maxFetches) counts per agent, so a reused guide shares one budget across every question sent to it; when a question needs its own budget, spawn a fresh guide instead."
    );
    expect(research).toMatch(/never guess/i);
    // The plan row's effort is honored through the researcher agent's own frontmatter (card research-effort-row).
    expect(research).not.toContain("not honored");
    expect(research).toContain("no effort parameter");
    expect(research).toContain("effort: high");
    // Both loops and the plan skill say when to take it; the planner names the facts it relied on.
    for (const f of ["skills/core-next/SKILL.md", "skills/doug-plan/SKILL.md", "skills/doug-next/SKILL.md"]) {
      const text = readFileSync(join(root, f), "utf8");
      expect(text, f).toContain("research");
      expect(text, f).toContain("outside the repository");
    }
    const planner = readFileSync(join(root, "agents/planner.md"), "utf8");
    expect(planner).toContain("facts outside the repository");
    expect(planner).toContain("Do not set a `crew` unless the request names one");
    expect(planner).toContain("unverified");
    // card readme-scannable: "The research step." paragraph lives in "The flow" section, moved to docs/reference.md.
    const readme = readFileSync(join(root, "..", "..", "docs/reference.md"), "utf8");
    expect(readme).toContain("**The research step.**");
    expect(readme).toContain("`researcher` agent");
  });
  it("ships the swarm as a lead inside a plan task: the lead agent, the doug-swarm launch step, the opt-in, and the amended decision", () => {
    const lead = parseFrontmatter(readFileSync(join(root, "agents/lead.md"), "utf8"));
    expect(lead.name).toBe("lead");
    expect(lead.model).toBe("inherit");
    const leadText = readFileSync(join(root, "agents/lead.md"), "utf8");
    for (const s of ["never widen", "no file is in two briefs", "--no-ff", "git worktree remove --force", "Co-Authored-By"]) expect(leadText).toContain(s);
    const launch = readFileSync(join(root, "skills/swarm-launch/SKILL.md"), "utf8");
    expect(parseFrontmatter(launch)["disable-model-invocation"]).toBeUndefined();
    for (const s of ["approved", "plan.mjs set swarm on", "Workflow(", "No swarm runs in the background", "worker:<task>:<n>", "never a wider brief"]) expect(launch).toContain(s);
    expect(readFileSync(join(root, "skills/doug-implement/SKILL.md"), "utf8")).toContain("swarm-launch");
    // The /doug-swarm command (card swarm-command): plans on the plan row with swarm on, the same approval gate as
    // doug-next, the shared launch step, and doug-next's land and record steps; refuses a hand-track card.
    const command = readFileSync(join(root, "skills/doug-swarm/SKILL.md"), "utf8");
    expect(parseFrontmatter(command)["allowed-tools"]).toContain("AskUserQuestion");
    expect(command.match(/AskUserQuestion/g).length).toBeGreaterThanOrEqual(2);
    for (const s of ["Approval is never automatic", "plan.mjs set swarm on", "swarm-launch", "`plan` row", "doug-flow:planner", '"track": "hand"', "no swarm runs in the background", "run-report", "research", "plan.mjs land"]) expect(command).toContain(s);
    // 2026-09-07 (card doug-next-lead-only): the planner used to plan on the `lead` row (the session model,
    // since lead is inherit here); it now plans on the `plan` row like every other planner spawn.
    expect(command).not.toMatch(/plans? on the `lead` row/);
    expect(command).not.toContain("Workflow({");
    expect(readFileSync(join(root, "skills/doug-next/SKILL.md"), "utf8")).toContain("plan.mjs set swarm on");
    // card readme-scannable: these two pins live in "The flow" section, moved to docs/reference.md.
    expect(readFileSync(join(root, "..", "..", "docs/reference.md"), "utf8")).toContain("`/doug-swarm <card-id | goal>`");
    // The public export leaves docs/decisions/ out; the ADR is checked only where it exists.
    if (!IS_SNAPSHOT) {
      const decision = readFileSync(join(root, "..", "..", "docs/decisions/0001-hierarchical-swarms.md"), "utf8");
      expect(decision).toContain("Amended 2026-09-06 (card swarm-lead)");
      expect(decision).toContain("the plan, not the launcher, is what gates it");
    }
    expect(readFileSync(join(root, "..", "..", "docs/reference.md"), "utf8")).toContain("**The swarm inside a task.**");
    // The worker row is in this repository's own table.
    expect(readFileSync(join(root, "..", "..", "CLAUDE.md"), "utf8")).toMatch(/\| worker\s+\| sonnet\s+\| medium\s+\|/);
  });
  it("doug-next: the lead only orchestrates; planning and research run on the plan row and adversary classification on the review row (card doug-next-lead-only)", () => {
    const dougPlan = readFileSync(join(root, "skills/doug-plan/SKILL.md"), "utf8");
    for (const s of ["`plan` row", 'subagent_type: "doug-flow:planner", model:', "plan.mjs models", "never plans"]) expect(dougPlan, s).toContain(s);

    const research = readFileSync(join(root, "skills/research/SKILL.md"), "utf8");
    for (const s of ["`plan` row", "plan.mjs models", "never researches"]) expect(research, s).toContain(s);

    const report = readFileSync(join(root, "skills/run-report/SKILL.md"), "utf8");
    for (const s of ["`review` row", 'subagent_type: "doug-flow:reviewer"', "never reclassifies"]) expect(report, s).toContain(s);

    const next = readFileSync(join(root, "skills/doug-next/SKILL.md"), "utf8");
    for (const s of ["## Who does the work", "lead only", "`plan` row", "`review` row", "both tracks", "never plans", 'subagent_type: "doug-flow:planner", model:']) expect(next, s).toContain(s);

    const core = readFileSync(join(root, "skills/core-next/SKILL.md"), "utf8");
    const swarm = readFileSync(join(root, "skills/doug-swarm/SKILL.md"), "utf8");
    expect(swarm).toContain("`plan` row");
    expect(swarm).not.toMatch(/plans? on the `lead` row/);

    // Every planner spawn (single card and batch, on both tracks, from a swarm too) carries the plan row's
    // model; none is left bare (card doug-next-lead-only, follow-up).
    for (const [name, text] of [["doug-next", next], ["doug-plan", dougPlan], ["core-next", core], ["doug-swarm", swarm]]) {
      const spawns = text.match(/subagent_type: "doug-flow:planner"/g) || [];
      expect(spawns.length, name).toBeGreaterThan(0);
      expect(text.match(/subagent_type: "doug-flow:planner"(?!, model:)/g), name).toBeNull();
    }

    // run-report's reviewer prompt pins that there is no worktree/diff and the exact output format.
    expect(report).toContain("no worktree");
    expect(report).toContain("=<real|marginal|false>: ");

    // README's /doug-swarm paragraph used to say the planner plans on the `lead` row; that was the session
    // model, since lead is inherit here. It now plans on the `plan` row like every other planner spawn.
    // card readme-scannable: this paragraph lives in "The flow" section, moved to docs/reference.md.
    const readmeSwarm = readFileSync(join(root, "..", "..", "docs/reference.md"), "utf8");
    expect(readmeSwarm).toContain("`plan` row");
    expect(readmeSwarm).not.toMatch(/planner plans on the `lead` row/);

    const claude = readFileSync(join(root, "..", "..", "CLAUDE.md"), "utf8");
    expect(claude).toContain("| plan ");
    expect(claude.trimEnd().split("\n").length).toBeLessThanOrEqual(60);

    // The public export leaves docs/decisions/ out; the ADR is checked only where it exists.
    if (!IS_SNAPSHOT) expect(readFileSync(join(root, "..", "..", "docs/decisions/0005-two-tracks.md"), "utf8")).toContain("`plan` row");
  });
  it("a research note for a card that lands is promoted to docs/research/ (card research-notes-survive)", () => {
    const research = readFileSync(join(root, "skills/research/SKILL.md"), "utf8");
    expect(research).toContain("promoted to `docs/research/<card-id>.md`");
    expect(research).toContain("stays in state");

    const report = readFileSync(join(root, "skills/run-report/SKILL.md"), "utf8");
    for (const s of ["promotes `.doug/.state/research/<id>.md` to `docs/research/<id>.md`", "add that path to the landing commit"]) expect(report, s).toContain(s);
    expect(report.match(/promotes `\.doug\/\.state\/research\/<id>\.md` to `docs\/research\/<id>\.md`/g).length).toBe(2);

    const core = readFileSync(join(root, "skills/core-next/SKILL.md"), "utf8");
    expect(core).toContain("docs/research/<id>.md");

    // The flow track's own landing commit needs the promoted path too, same as core-next's.
    const dougNext = readFileSync(join(root, "skills/doug-next/SKILL.md"), "utf8");
    expect(dougNext).toContain("docs/research/<id>.md");
  });
  it("names the registered workflow with its plugin prefix everywhere it is launched (card doug-implement-workflow-name)", () => {
    // 2026-09-09 swarm rehearsal (fixture doug-rehearse-swarm-qtDM52): doug-implement step 3 called
    // Workflow({ name: "doug-implement", args }) and got "Workflow doug-implement not found. Available:
    // deep-research, doug-flow:doug-implement", then retried with the prefixed name and succeeded.
    // doug-next and swarm-launch already named it with the prefix; doug-implement must say the same.
    for (const f of ["skills/doug-implement/SKILL.md", "skills/swarm-launch/SKILL.md", "skills/doug-next/SKILL.md"]) {
      const text = readFileSync(join(root, f), "utf8");
      expect(text, f).toContain('Workflow({ name: "doug-flow:doug-implement"');
      expect(text, f).not.toContain('name: "doug-implement"');
      expect(text, f).toContain('scriptPath: "${CLAUDE_PLUGIN_ROOT}/workflows/doug-implement.js"');
    }
  });
  it("core-next stamps the landing condition and classes follow-up cards (card core-next-condition-open)", () => {
    // 2026-09-19: every hand row of the day had harness_commit and class null because the Start bullet never
    // ran `memory.mjs condition open <id>` before the brief, and step 5's `doug board add` line carried no
    // --class, so five of six cards landed with no class.
    const core = readFileSync(join(root, "skills/core-next/SKILL.md"), "utf8");
    // Reviewer finding: the plugin-root form, like every other command in this file, never this machine's
    // absolute path.
    expect(core, "Start bullet must stamp the condition before the brief, plugin-root form").toContain(
      'node "${CLAUDE_PLUGIN_ROOT}/scripts/memory.mjs" condition open <id>'
    );
    expect(core, "condition.json is what memory.mjs record --hand reads to fill the condition columns").toContain(
      ".doug/.state/reports/<id>/condition.json"
    );
    // Reviewer finding: it is `memory.mjs record --hand` (the outcomes-store recorder) that reads
    // condition.json, not `board.mjs record --hand` (which only appends the docs/live-runs.md line).
    expect(core, "the Start bullet must name memory.mjs record --hand as condition.json's reader").toContain(
      "which `memory.mjs record --hand`"
    );
    expect(core, "the Start bullet's batch note covers one condition open per card").toContain(
      "one `condition open` per card"
    );
    const classTag = "--class <tests-only|prose|gate-script|code|docs|eval|decision>";
    const startIdx = core.indexOf(classTag);
    expect(startIdx, "the Start bullet must give a card a class before stamping its condition").toBeGreaterThanOrEqual(0);
    const followUpHeadingIdx = core.indexOf("## 5. Follow-up cards");
    expect(followUpHeadingIdx, "SKILL.md must still have a '## 5. Follow-up cards' section").toBeGreaterThanOrEqual(0);
    const addLineIdx = core.indexOf(classTag, followUpHeadingIdx);
    expect(addLineIdx, "the follow-up `doug board add` line must also carry --class").toBeGreaterThan(followUpHeadingIdx);
    expect(addLineIdx, "the Start bullet's --class and the follow-up add line's --class must be two distinct occurrences").not.toBe(startIdx);
    expect(core, "the follow-up question's option text must list class alongside size").toContain(
      "one option per suggestion with a proposed id, title, column, size, class, track, and deps"
    );

    // Reviewer finding: the same --class-after-the-follow-up-heading position, pinned against doug-next and
    // doug-swarm too (the way K12 reads doug-swarm's SKILL.md). Neither skill has a class-stamping Start
    // bullet like core-next's, so each carries --class once, on its follow-up `doug board add` line.
    const dougNext = readFileSync(join(root, "skills/doug-next/SKILL.md"), "utf8");
    const dougNextFollowUpHeadingIdx = dougNext.indexOf("## 6. Follow-up cards");
    expect(dougNextFollowUpHeadingIdx, "doug-next must still have a '## 6. Follow-up cards' section").toBeGreaterThanOrEqual(0);
    const dougNextAddLineIdx = dougNext.indexOf(classTag, dougNextFollowUpHeadingIdx);
    expect(dougNextAddLineIdx, "doug-next's follow-up `doug board add` line must carry --class after the heading").toBeGreaterThan(dougNextFollowUpHeadingIdx);

    const dougSwarm = readFileSync(join(root, "skills/doug-swarm/SKILL.md"), "utf8");
    const dougSwarmFollowUpHeadingIdx = dougSwarm.indexOf("## 6. Follow-up cards");
    expect(dougSwarmFollowUpHeadingIdx, "doug-swarm must still have a '## 6. Follow-up cards' section").toBeGreaterThanOrEqual(0);
    const dougSwarmAddLineIdx = dougSwarm.indexOf(classTag, dougSwarmFollowUpHeadingIdx);
    expect(dougSwarmAddLineIdx, "doug-swarm's follow-up `doug board add` line must carry --class after the heading").toBeGreaterThan(dougSwarmFollowUpHeadingIdx);
  });
});

describe("plan CLI", () => {
  it("validates, approves, writes the anchor, and refuses invalid plans", () => {
    const dir = mkdtempSync(join(tmpdir(), "doug-plancli-"));
    const script = join(root, "scripts/plan.mjs");
    const run = (cmd) => spawnSync(process.execPath, [script, cmd, dir], { encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: "" } });
    expect(run("validate").status).toBe(2);
    const good = {
      version: 1, title: "T", goal: "A goal that explains the change.", status: "draft", acceptance: ["it works"], verify: ["true"],
      tasks: [{ id: "one", title: "One", spec: "Do the one thing that the plan describes.", files: ["a.ts"] }],
    };
    mkdirSync(join(dir, ".doug"));
    writeFileSync(join(dir, ".doug/plan.json"), JSON.stringify({ ...good, tasks: [] }));
    expect(run("approve").status).toBe(1);
    writeFileSync(join(dir, ".doug/plan.json"), JSON.stringify(good));
    expect(run("validate").status).toBe(0);
    expect(run("approve").status).toBe(0);
    expect(JSON.parse(readFileSync(join(dir, ".doug/plan.json"), "utf8")).status).toBe("approved");
    expect(run("anchor").status).toBe(0);
    expect(readFileSync(join(dir, ".doug/anchor.md"), "utf8")).toContain("one: One -> a.ts");
    const json = JSON.parse(run("json").stdout);
    expect(json.title).toBe("T");
    expect(json.tasks[0]).toMatchObject({ model: "inherit", effort: "inherit" });
    expect(json.models.source).toBeNull();
  });
  it("resolves model tiers from the CLAUDE.md Models table into json and refuses unknown tiers", () => {
    const dir = mkdtempSync(join(tmpdir(), "doug-plancli-models-"));
    const script = join(root, "scripts/plan.mjs");
    const run = (cmd) => spawnSync(process.execPath, [script, cmd, dir], { encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: "" } });
    mkdirSync(join(dir, ".doug"));
    writeFileSync(join(dir, "CLAUDE.md"), "## Models\n\n| Work | Model | Effort |\n|---|---|---|\n| implement | sonnet | medium |\n| verify | inherit | high |\n| cheap | haiku | low |\n");
    const base = { version: 1, title: "T", goal: "A goal that explains the change.", status: "draft", acceptance: ["ok"], verify: ["true"] };
    const t = (id, extra) => ({ id, title: id, spec: "Do the thing the plan describes here.", files: [`${id}.ts`], ...extra });
    writeFileSync(join(dir, ".doug/plan.json"), JSON.stringify({ ...base, tasks: [t("a"), t("b", { tier: "cheap" }), t("c", { model: "opus", effort: "max" })] }));
    expect(run("validate").status).toBe(0);
    const json = JSON.parse(run("json").stdout);
    expect(json.models.source).toBe("CLAUDE.md");
    expect(json.models.roles.verify).toEqual({ model: "inherit", effort: "high" });
    expect(json.tasks.map((x) => [x.model, x.effort])).toEqual([["sonnet", "medium"], ["haiku", "low"], ["opus", "max"]]);
    expect(run("models").stdout).toContain('"cheap"');
    const show = run("show").stdout;
    expect(show).toContain("Models (from CLAUDE.md)");
    expect(show).toContain("b: haiku / low (tier cheap)");
    writeFileSync(join(dir, ".doug/plan.json"), JSON.stringify({ ...base, tasks: [t("a", { tier: "nope" })] }));
    const bad = run("validate");
    expect(bad.status).toBe(1);
    expect(bad.stderr).toMatch(/tier "nope" is not defined/);
    expect(run("json").status).toBe(1);
    expect(run("approve").status).toBe(1);
  });
});

// card adversary-usage-in-report (decision 0007 follow-up): ADVERSARY_SCHEMA, the two relay prompts' Return
// sentence, and the agent's Method step all gain usage/durationMs so the copied ReviewResult.usage and
// ReviewResult.durationMs actually reach the report (T4, the write sites themselves, lives with the fix loop's
// dependency-gate tests above, which already have runWorkflow/shapedRun to exercise the report end to end).
describe("card adversary-usage-in-report: schema, prompts, and the relay's Method step", () => {
  const slice = (head) => {
    const s = source.indexOf(head);
    return source.slice(s, source.indexOf("\n}\n", s) + 3);
  };

  it("T1: ADVERSARY_SCHEMA gains optional usage and durationMs properties, neither required (design item 2)", () => {
    const advSchemaStart = source.indexOf("const ADVERSARY_SCHEMA");
    const ADVERSARY_SCHEMA_BUILT = new Function(source.slice(advSchemaStart, source.indexOf("\n}\n", advSchemaStart) + 3) + "\nreturn ADVERSARY_SCHEMA;")();
    expect(ADVERSARY_SCHEMA_BUILT.properties.usage, "T1: ADVERSARY_SCHEMA must declare a usage property (ReviewResult.usage copied through)").toBeDefined();
    expect(ADVERSARY_SCHEMA_BUILT.properties.durationMs, "T1: ADVERSARY_SCHEMA must declare a durationMs property (ReviewResult.durationMs copied through)").toBeDefined();
    expect(ADVERSARY_SCHEMA_BUILT.required, "T1: usage must not be required (the fallback adversary and the Claude crew seat return neither)").not.toContain("usage");
    expect(ADVERSARY_SCHEMA_BUILT.required, "T1: durationMs must not be required either").not.toContain("durationMs");
  });

  it("T2: both adversary prompts' Return sentence names usage and durationMs (design item 2)", () => {
    const adversaryPromptSrc = slice("function adversaryPrompt(");
    expect(adversaryPromptSrc, "T2: adversaryPrompt's Return sentence must ask the relay to copy usage").toMatch(/Return: taskId="\$\{task\.id\}"[^`]*usage/);
    expect(adversaryPromptSrc, "T2: adversaryPrompt's Return sentence must ask the relay to copy durationMs").toMatch(/Return: taskId="\$\{task\.id\}"[^`]*durationMs/);
    // R5 (round 2 minor 9): a looser "usage appears somewhere" match would also pass if usage were named in some
    // unrelated aside; pin the field list itself, the phrase naming what gets copied from the JSON.
    expect(adversaryPromptSrc, "R5: adversaryPrompt's Return sentence must list error, usage, durationMs together as the copied fields").toContain("error, usage, durationMs copied from the JSON");

    const levelAdversaryPromptSrc = slice("function levelAdversaryPrompt(");
    expect(levelAdversaryPromptSrc, "T2: levelAdversaryPrompt's Return sentence must ask the relay to copy usage").toMatch(/Return: taskId="level-\$\{li\}"[^`]*usage/);
    expect(levelAdversaryPromptSrc, "T2: levelAdversaryPrompt's Return sentence must ask the relay to copy durationMs").toMatch(/Return: taskId="level-\$\{li\}"[^`]*durationMs/);
    expect(levelAdversaryPromptSrc, "R5: levelAdversaryPrompt's Return sentence must list error, usage, durationMs together as the copied fields too").toContain("error, usage, durationMs copied from the JSON");
  });

  it("R1: mergeAdversaries carries the usage-bearing seat's usage/durationMs, and null when no seat has usage (round 2 major 1)", () => {
    const adversaryOkSrc = source.slice(source.indexOf("function adversaryBlocking("), source.indexOf("\n}\n", source.indexOf("function adversaryOk(")) + 3);
    const adversaryOkFn = new Function(adversaryOkSrc + "\nreturn adversaryOk;")();
    const adversaryUsageFn = new Function(slice("function adversaryUsage(") + "\nreturn adversaryUsage;")();
    const mergeAdversariesFn = new Function(
      "adversaryOk", "adversaryUsage",
      slice("function mergeAdversaries(") + "\nreturn mergeAdversaries;",
    )(adversaryOkFn, adversaryUsageFn);

    const codexSeat = { taskId: "a", ran: true, verdict: "pass", summary: "codex", issues: [], commandsRun: [], error: null, usage: { inputTokens: 10, outputTokens: 2 }, durationMs: 5 };
    const claudeSeat = { taskId: "a", ran: true, verdict: "pass", summary: "claude", issues: [], commandsRun: [], error: null };
    const merged = mergeAdversariesFn([codexSeat, claudeSeat]);
    expect(merged, "R1: a crew of a Codex seat with usage and a Claude seat without must merge to seat 1's usage and durationMs").toMatchObject({ usage: { inputTokens: 10, outputTokens: 2 }, durationMs: 5 });

    const bothNoUsage = mergeAdversariesFn([claudeSeat, { ...claudeSeat, summary: "claude2" }]);
    expect(bothNoUsage, "R1: two seats without usage must merge to usage: null, durationMs: null, not throw or drop the keys").toMatchObject({ usage: null, durationMs: null });
  });

  it("T3: agents/adversary.md Method step 2 names usage and durationMs among the copied fields (design item 1)", () => {
    const md = readFileSync(join(root, "agents/adversary.md"), "utf8");
    const step2Start = md.indexOf("2. The command prints one JSON object.");
    expect(step2Start, "T3: step 2 must still exist with its original opening wording").toBeGreaterThan(-1);
    const step2 = md.slice(step2Start, md.indexOf("3. If the command exits 2", step2Start));
    expect(step2, "T3: Method step 2 must name usage among the copied fields").toMatch(/usage/);
    expect(step2, "T3: Method step 2 must name durationMs among the copied fields").toMatch(/durationMs/);
  });
});

describe("card swarm-when-to-use-docs: the pinned when-to-swarm sentence is documented in three places", () => {
  // Char for char from docs/decisions/0001-hierarchical-swarms.md, section "Amendment 2026-09-20" (landed 63360b6).
  // The public export leaves docs/decisions/ out and rewrites the file reference to "decision 0001" in the shipped
  // prose; the sentence is pinned in whichever form the tree in front of the test carries.
  const ADR_IN_TREE = !IS_SNAPSHOT;
  const PINNED_SENTENCE = "The swarm pays on a task with independent deliverables that share no new symbol; a plan of small coupled tasks runs as the pipeline (" + (ADR_IN_TREE ? "`docs/decisions/0001-hierarchical-swarms.md`" : "decision 0001") + ", Amendment 2026-09-20: one brief per task at +2.67 USD and +6.1 min against the pipeline on 2026-09-11; five briefs, 8/8 hidden tests, 8.31 USD, 8.5 min on 2026-09-19).";

  it("doug-swarm/SKILL.md carries the pinned when-to-swarm sentence", () => {
    const text = readFileSync(join(root, "skills/doug-swarm/SKILL.md"), "utf8");
    expect(text, "plugins/doug-flow/skills/doug-swarm/SKILL.md must contain the pinned when-to-swarm sentence").toContain(PINNED_SENTENCE);
  });

  it("swarm-launch/SKILL.md carries the pinned when-to-swarm sentence", () => {
    const text = readFileSync(join(root, "skills/swarm-launch/SKILL.md"), "utf8");
    expect(text, "plugins/doug-flow/skills/swarm-launch/SKILL.md must contain the pinned when-to-swarm sentence").toContain(PINNED_SENTENCE);
  });

  it("docs/reference.md carries the pinned when-to-swarm sentence (card readme-scannable: this bullet moved from README.md's \"The flow\" section)", () => {
    const text = readFileSync(join(root, "..", "..", "docs/reference.md"), "utf8");
    expect(text, "docs/reference.md must contain the pinned when-to-swarm sentence").toContain(PINNED_SENTENCE);
  });
});

// Card report-save-wrapper, MP: the "save the report JSON" sentence in each of these three skills must say the
// saved file is the `result` object of the Workflow tool's output, not just "the report JSON"/"the report".
describe("card report-save-wrapper: the saved-report sentence names the result object", () => {
  const PINNED_PHRASE = "the `result` object of the Workflow";

  it("doug-next/SKILL.md's save-the-report sentence names the result object", () => {
    const text = readFileSync(join(root, "skills/doug-next/SKILL.md"), "utf8");
    expect(text, "plugins/doug-flow/skills/doug-next/SKILL.md must contain the pinned phrase").toContain(PINNED_PHRASE);
  });

  it("core-next/SKILL.md's save-the-report sentence names the result object", () => {
    const text = readFileSync(join(root, "skills/core-next/SKILL.md"), "utf8");
    expect(text, "plugins/doug-flow/skills/core-next/SKILL.md must contain the pinned phrase").toContain(PINNED_PHRASE);
  });

  it("doug-swarm/SKILL.md's save-the-report sentence names the result object", () => {
    const text = readFileSync(join(root, "skills/doug-swarm/SKILL.md"), "utf8");
    expect(text, "plugins/doug-flow/skills/doug-swarm/SKILL.md must contain the pinned phrase").toContain(PINNED_PHRASE);
  });
});

// Card run-report-codex-cost: the Codex adversary's cost is a separate figure from --cost (Claude's own), never
// folded into it. run-report/SKILL.md carries two sentences pinned verbatim from the brief, and the workflow
// form's step 3 and step 7 command lines gain the optional --codex-cost flag.
describe("card run-report-codex-cost: the Codex cost sentences and flag are documented in run-report/SKILL.md", () => {
  const T1_SENTENCE = "The Codex line after it, when present, is the Codex adversary's cost: pass its USD as --codex-cost <usd> to record and summary; it is never added to --cost.";
  const T2_SENTENCE = "Pass the Codex line's USD as --codex-cost to the first card's record only.";

  it("T1: step 1 (workflow form) carries the pinned Codex-line sentence", () => {
    const text = readFileSync(join(root, "skills/run-report/SKILL.md"), "utf8");
    expect(text, "plugins/doug-flow/skills/run-report/SKILL.md step 1 must contain the pinned sentence").toContain(T1_SENTENCE);
  });

  it("T2: the batch form's step 1 carries the pinned first-card-only sentence", () => {
    const text = readFileSync(join(root, "skills/run-report/SKILL.md"), "utf8");
    expect(text, "plugins/doug-flow/skills/run-report/SKILL.md batch step 1 must contain the pinned sentence").toContain(T2_SENTENCE);
  });

  it("T3: the workflow form's step 3 and step 7 command lines each gain [--codex-cost <usd>]", () => {
    const text = readFileSync(join(root, "skills/run-report/SKILL.md"), "utf8");
    const step3Idx = text.indexOf("3. `node \"${CLAUDE_PLUGIN_ROOT}/scripts/board.mjs\" record");
    const step7Idx = text.indexOf("7. `node \"${CLAUDE_PLUGIN_ROOT}/scripts/board.mjs\" summary");
    expect(step3Idx, "the workflow form's step 3 (board.mjs record) must be present").toBeGreaterThanOrEqual(0);
    expect(step7Idx, "the workflow form's step 7 (board.mjs summary) must be present").toBeGreaterThan(step3Idx);
    const step3Line = text.slice(step3Idx, text.indexOf("\n", step3Idx));
    const step7Line = text.slice(step7Idx, text.indexOf("\n", step7Idx));
    expect(step3Line, "step 3's command line must gain [--codex-cost <usd>]").toContain("[--codex-cost <usd>]");
    expect(step7Line, "step 7's command line must gain [--codex-cost <usd>]").toContain("[--codex-cost <usd>]");
  });

  it("m-2 (card run-report-codex-cost, review round 1): the batch form's step 3 command line carries [--codex-cost <usd>, first card only]", () => {
    const text = readFileSync(join(root, "skills/run-report/SKILL.md"), "utf8");
    const batchIdx = text.indexOf("## A batch (several cards in one plan)");
    expect(batchIdx, "the batch section must be present").toBeGreaterThanOrEqual(0);
    const batchStep3Idx = text.indexOf("3. For each card, in the plan's `cards` order: `node \"${CLAUDE_PLUGIN_ROOT}/scripts/board.mjs\" record", batchIdx);
    expect(batchStep3Idx, "the batch form's step 3 (board.mjs record) must be present").toBeGreaterThanOrEqual(0);
    const batchStep3Line = text.slice(batchStep3Idx, text.indexOf("\n", batchStep3Idx));
    expect(batchStep3Line, "the batch step 3 command line must gain [--codex-cost <usd>, first card only]").toContain(
      "[--codex-cost <usd>, first card only]"
    );
  });

  it("m-3 (card run-report-codex-cost, review round 1): core-next step 4.1 pairs --codex-cost <usd> with \"when cost.mjs printed a Codex line\" in the same sentence", () => {
    const text = readFileSync(join(root, "skills/core-next/SKILL.md"), "utf8");
    const recordAndLandIdx = text.indexOf("## 4. Record and land");
    expect(recordAndLandIdx, "core-next: '## 4. Record and land' must be present").toBeGreaterThanOrEqual(0);
    const step1Idx = text.indexOf("1. Invoke the `run-report` skill.", recordAndLandIdx);
    expect(step1Idx, "core-next step 4.1 must be present").toBeGreaterThanOrEqual(0);
    const step1End = text.indexOf("\n2. `node", step1Idx);
    const step1Text = text.slice(step1Idx, step1End === -1 ? undefined : step1End);
    const flagIdx = step1Text.indexOf("--codex-cost <usd>");
    expect(flagIdx, "step 4.1 must mention --codex-cost <usd>").toBeGreaterThanOrEqual(0);
    // Find the sentence (bounded by '. ') that carries the flag, and require the companion phrase in that
    // same sentence, not merely somewhere else in the step.
    const sentenceStart = step1Text.lastIndexOf(". ", flagIdx) + 1;
    const sentenceEndRel = step1Text.indexOf(". ", flagIdx);
    const sentence = step1Text.slice(sentenceStart, sentenceEndRel === -1 ? undefined : sentenceEndRel + 1);
    expect(sentence, "the --codex-cost <usd> sentence must say when cost.mjs printed a Codex line").toContain(
      "when cost.mjs printed a Codex line"
    );
  });
});

// 2026-09-24 (card decision-0011-followthrough): ADR 0011's five decisions land as prose only. Each pin below
// quotes the ADR's own wording (docs/decisions/0011-five-harness-decisions-scratch-copy-mutations-no-lead-tester.md)
// verbatim, never a paraphrase, so a coder who deletes the new sentence fails the pin.
describe("card decision-0011-followthrough: ADR 0011's scratch-copy, scratch-location, unclassed-rows, and race-limit sentences", () => {
  // ADR item 1: mutations run in a scratch copy or worktree under .doug/.state, never the live checkout. One
  // sentence carrying this quote lands in .claude/agents/reviewer.md, .claude/agents/coder.md (their generator,
  // packages/doug-cli/src/generate/agents.ts, is already covered byte-for-byte by
  // packages/doug-cli/tests/agents.test.ts's "reproduces this repository's .claude/agents byte for byte" test),
  // harness-fix's rule 7, and core-next's step 3.
  const MUTATION_SCRATCH_COPY =
    "each mutation in a scratch copy or git worktree under `.doug/.state`, run the one test file there, and remove the copy";

  it("ADR 0011 item 1: .claude/agents/reviewer.md carries the scratch-copy-mutation sentence", () => {
    const text = readFileSync(join(root, "..", "..", ".claude/agents/reviewer.md"), "utf8");
    expect(text, ".claude/agents/reviewer.md must carry the ADR 0011 item 1 sentence").toContain(MUTATION_SCRATCH_COPY);
  });

  it("ADR 0011 item 1: .claude/agents/coder.md carries the scratch-copy-mutation sentence", () => {
    const text = readFileSync(join(root, "..", "..", ".claude/agents/coder.md"), "utf8");
    expect(text, ".claude/agents/coder.md must carry the ADR 0011 item 1 sentence").toContain(MUTATION_SCRATCH_COPY);
  });

  it("ADR 0011 item 1: harness-fix's rule 7 carries the scratch-copy-mutation sentence", () => {
    const text = readFileSync(join(root, "skills/harness-fix/SKILL.md"), "utf8");
    expect(text, "harness-fix SKILL.md rule 7 must carry the ADR 0011 item 1 sentence").toContain(MUTATION_SCRATCH_COPY);
  });

  it("ADR 0011 item 1: core-next's '## 3. Build it by hand' carries the scratch-copy-mutation sentence", () => {
    const text = readFileSync(join(root, "skills/core-next/SKILL.md"), "utf8");
    const idx = text.indexOf("## 3. Build it by hand");
    expect(idx, "core-next: '## 3. Build it by hand' must be present").toBeGreaterThanOrEqual(0);
    const nextIdx = text.indexOf("## 4.", idx);
    const section = text.slice(idx, nextIdx === -1 ? undefined : nextIdx);
    expect(section, "core-next step 3 must carry the ADR 0011 item 1 sentence").toContain(MUTATION_SCRATCH_COPY);
  });

  // ADR item 3: scratch files go under .doug/.state/scratch, never the Claude Code session scratchpad (outside
  // the project, which protect-paths keeps refusing). Named in CLAUDE.md (folded into an existing line, no new
  // line added — claude-md-from-lessons already pins the 60-line cap) and in the generated agent files that
  // write scratch. Chosen: coder.md (writes the scratch copy for its own mutation runs, per item 1, and any
  // other scratch/temp file) and tester.md (writes scratch/temp files while iterating a test; its tools have no
  // restriction against Bash-written temp files). Not chosen: reviewer.md — its only documented scratch use is
  // the item-1 mutation copy, whose location that sentence already names (`.doug/.state`); reviewer is
  // read-only apart from Bash (disallowedTools: Edit, Write, MultiEdit, NotebookEdit) and has no other
  // scratch-writing rule that would need the more specific `/scratch` sub-path spelled out again.
  const SCRATCH_LOCATION =
    "Scratch files go under `.doug/.state/scratch`; protect-paths keeps refusing the Claude Code session scratchpad, which is outside the project.";

  it("ADR 0011 item 3: CLAUDE.md names .doug/.state/scratch, folded into an existing line (no new line)", () => {
    const text = readFileSync(join(root, "..", "..", "CLAUDE.md"), "utf8");
    expect(text, "CLAUDE.md must carry the ADR 0011 item 3 sentence").toContain(SCRATCH_LOCATION);
  });

  it("ADR 0011 item 3: .claude/agents/coder.md names .doug/.state/scratch", () => {
    const text = readFileSync(join(root, "..", "..", ".claude/agents/coder.md"), "utf8");
    expect(text, ".claude/agents/coder.md must carry the ADR 0011 item 3 sentence").toContain(SCRATCH_LOCATION);
  });

  it("ADR 0011 item 3: .claude/agents/tester.md names .doug/.state/scratch", () => {
    const text = readFileSync(join(root, "..", "..", ".claude/agents/tester.md"), "utf8");
    expect(text, ".claude/agents/tester.md must carry the ADR 0011 item 3 sentence").toContain(SCRATCH_LOCATION);
  });

  // ADR item 4: outcome measurement starts from rows stamped at schema v7; earlier rows get no hand
  // classification and no class-only backfill command, so they keep whatever class `condition backfill` gave
  // them (usually none) rather than staying unconditionally unclassed -- `condition backfill` (docs/memory.md
  // lines 70-75) does set `class` from the board card on a pre-v7 row when the card has one, so "stay unclassed"
  // was wrong; review major on card decision-0011-followthrough caught the contradiction and gave this wording.
  const UNCLASSED_ROWS =
    "Rows from before it get no hand classification and no class-only backfill command, so they keep whatever class `condition backfill` gave them (usually none).";

  it("ADR 0011 item 4: docs/memory.md carries the unclassed-earlier-rows sentence near the schema v7 paragraph", () => {
    const text = readFileSync(join(root, "..", "..", "docs/memory.md"), "utf8");
    expect(text, "docs/memory.md must carry the ADR 0011 item 4 sentence").toContain(UNCLASSED_ROWS);
    const v7Idx = text.indexOf("Schema v7 adds seven columns");
    const v8Idx = text.indexOf("Schema v8 (card `run-report-codex-cost`)");
    expect(v7Idx, "docs/memory.md must still name the schema v7 paragraph").toBeGreaterThanOrEqual(0);
    expect(v8Idx, "docs/memory.md must still name the schema v8 paragraph").toBeGreaterThan(v7Idx);
    const sentenceIdx = text.indexOf(UNCLASSED_ROWS);
    expect(sentenceIdx, "the sentence must sit between the schema v7 and schema v8 paragraphs, not somewhere unrelated").toBeGreaterThan(v7Idx);
    expect(sentenceIdx).toBeLessThan(v8Idx);
  });

  // ADR item 5: the block ledger's race class keeps its known limit, documented in the module comment: a check
  // command that leaves unignored untracked output behind makes every block read 'race', and a content change
  // to an already-dirty file is not seen. Its vendored copy (.doug/hooks/lib/block-ledger.mjs) is already kept
  // byte-identical by plugins/doug-gates/tests/vendored-copies.test.mjs, so no separate pin is needed for that.
  const RACE_LIMIT =
    "a check command that leaves unignored untracked output behind makes every block read 'race', and a content change to an already-dirty file is not seen";

  it("ADR 0011 item 5: block-ledger.mjs's module comment states the race-class limit", () => {
    const text = readFileSync(join(root, "..", "doug-gates/lib/block-ledger.mjs"), "utf8");
    expect(text, "plugins/doug-gates/lib/block-ledger.mjs must carry the ADR 0011 item 5 sentence").toContain(RACE_LIMIT);
  });
});

// 2026-09-25 (card agents-gate-timeout-handback): a command that can run past 120 s (e.g. pnpm test:unit, which
// took ~150-170 s on 2026-09-24) must be run with the Bash timeout set to 600000, unpiped, with a hand-back only
// after it exits -- otherwise Claude Code moves it to the background at the 120 s default and the caller loses
// its result. One new Rules bullet, verbatim, in coder.md, tester.md, and reviewer.md; the generator is covered
// by packages/doug-cli/tests/agents.test.ts's byte-for-byte pin.
describe("card agents-gate-timeout-handback: the Bash-timeout-600000 rule in coder, tester, and reviewer", () => {
  const TIMEOUT_600000_RULE =
    "Run any command that can take over 120 s, such as pnpm test:unit, with the Bash timeout set to 600000, and hand back only after it exits.";

  it("agents-gate-timeout-handback: .claude/agents/coder.md carries the Bash-timeout-600000 rule", () => {
    const text = readFileSync(join(root, "..", "..", ".claude/agents/coder.md"), "utf8");
    expect(text, ".claude/agents/coder.md must carry the Bash-timeout-600000 rule").toContain(TIMEOUT_600000_RULE);
  });

  it("agents-gate-timeout-handback: .claude/agents/tester.md carries the Bash-timeout-600000 rule", () => {
    const text = readFileSync(join(root, "..", "..", ".claude/agents/tester.md"), "utf8");
    expect(text, ".claude/agents/tester.md must carry the Bash-timeout-600000 rule").toContain(TIMEOUT_600000_RULE);
  });

  it("agents-gate-timeout-handback: .claude/agents/reviewer.md carries the Bash-timeout-600000 rule", () => {
    const text = readFileSync(join(root, "..", "..", ".claude/agents/reviewer.md"), "utf8");
    expect(text, ".claude/agents/reviewer.md must carry the Bash-timeout-600000 rule").toContain(TIMEOUT_600000_RULE);
  });
});

// 2026-09-25 (card tests-only-card-skips-coder): a hand card whose goal says tests only (no production change)
// runs as tester then reviewer, with no coder. Pins the three sentences verbatim, each in its named file and
// section (S1 core-next step 3, S2 harness-fix section 0, S3 the generated tester.md). No production code exists
// yet, so all three are red by design.
describe("card tests-only-card-skips-coder: the tests-only-card rule in core-next, harness-fix, and tester.md", () => {
  it("S1: core-next step 3 tells the tester to run a tests-only card alone, as its own paragraph after the tester-spawn paragraph", () => {
    const core = readFileSync(join(root, "skills/core-next/SKILL.md"), "utf8");
    const SENTENCE =
      "A tests-only card (its goal says tests only, no production change) runs as tester then reviewer, with no coder: the tester writes the test from the goal, runs the brief's mutation list itself in a scratch copy or git worktree under `.doug/.state`, and reports each result; the reviewer reruns the list and adds its own.";
    expect(core, SENTENCE).toContain(SENTENCE);

    const h3 = core.indexOf("## 3. Build it by hand");
    const h4 = core.indexOf("## 4. Record and land");
    expect(h3, "core-next: '## 3. Build it by hand' not found").toBeGreaterThan(-1);
    expect(h4, "core-next: '## 4. Record and land' not found").toBeGreaterThan(-1);
    const step3 = core.slice(h3, h4);
    expect(step3, "S1 must sit inside step 3").toContain(SENTENCE);

    // Its own paragraph, directly after the paragraph that begins "Next: before the coder, spawn the
    // project's `tester` agent".
    const anchor = "Next: before the coder, spawn the project's `tester` agent";
    const anchorIdx = core.indexOf(anchor);
    expect(anchorIdx, "anchor paragraph not found").toBeGreaterThan(-1);
    const anchorParaEnd = core.indexOf("\n\n", anchorIdx);
    expect(anchorParaEnd, "anchor paragraph has no following blank line").toBeGreaterThan(-1);
    let nextParaEnd = core.indexOf("\n\n", anchorParaEnd + 2);
    if (nextParaEnd === -1) nextParaEnd = core.length;
    const nextPara = core.slice(anchorParaEnd + 2, nextParaEnd).trim();
    expect(nextPara, "the paragraph right after the tester-spawn paragraph must be exactly S1").toBe(SENTENCE);

    // Respect the existing pin: no "skip"/"instead of the tester"/"without the tester" wording.
    expect(SENTENCE).not.toMatch(/skip|instead of the tester|without the tester/i);
  });

  it("S2: harness-fix section 0 tells the tester to run a tests-only card's mutation list itself, as the section's last sentence", () => {
    const fix = readFileSync(join(root, "skills/harness-fix/SKILL.md"), "utf8");
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

  it("S3: .claude/agents/tester.md tells the tester to run a tests-only card's mutation list in a scratch copy, as the last Rules bullet", () => {
    const tester = readFileSync(join(root, "..", "..", ".claude/agents/tester.md"), "utf8");
    const SENTENCE =
      "On a tests-only card, run the brief's mutation list yourself in a scratch copy or git worktree under `.doug/.state`, run the one test file there, report each result, and remove the copy; never edit a production file in the live checkout.";
    expect(tester, SENTENCE).toContain(SENTENCE);

    const rulesIdx = tester.indexOf("## Rules");
    const notesIdx = tester.indexOf("## Project notes");
    expect(rulesIdx, ".claude/agents/tester.md has no '## Rules' heading").toBeGreaterThan(-1);
    expect(notesIdx, ".claude/agents/tester.md has no '## Project notes' heading").toBeGreaterThan(rulesIdx);
    const rulesSection = tester.slice(rulesIdx, notesIdx);
    const bullets = rulesSection.split("\n").filter((l) => l.startsWith("- "));
    expect(bullets[bullets.length - 1], "S3 must be the last '## Rules' bullet").toBe(`- ${SENTENCE}`);
  });
});

// card op-learn-gate-shape: the hand-track gate line is no longer the literal "typecheck 0; unit <n> passed" -
// it is derived per-project from .doug/config.json's stopGate.commands, one `<command> <exit>` clause per
// entry, in that order, joined by "; ". run-report/SKILL.md carries the pinned rule sentence and both
// run-report and core-next use the placeholder `--gate "<gate line>"` instead of the old literal.
describe("card op-learn-gate-shape: the hand-track gate line is project-derived, not Doug's own literal", () => {
  const PINNED_GATE_RULE_SENTENCE =
    "one `<command> <exit>` clause per entry of `.doug/config.json` `stopGate.commands`, in that order, joined by `; `";
  const OLD_GATE_LITERAL = "typecheck 0; unit <n> passed";

  it("run-report/SKILL.md's hand-track section carries the pinned gate-rule sentence verbatim", () => {
    const report = readFileSync(join(root, "skills/run-report/SKILL.md"), "utf8");
    expect(report, "run-report/SKILL.md must carry the pinned gate-rule sentence").toContain(PINNED_GATE_RULE_SENTENCE);
  });

  it("neither run-report/SKILL.md nor core-next/SKILL.md contains the old Doug-only gate literal", () => {
    const report = readFileSync(join(root, "skills/run-report/SKILL.md"), "utf8");
    const core = readFileSync(join(root, "skills/core-next/SKILL.md"), "utf8");
    expect(report, "run-report/SKILL.md must not contain the old gate literal").not.toContain(OLD_GATE_LITERAL);
    expect(core, "core-next/SKILL.md must not contain the old gate literal").not.toContain(OLD_GATE_LITERAL);
  });

  it("both run-report/SKILL.md and core-next/SKILL.md use the --gate \"<gate line>\" placeholder", () => {
    const report = readFileSync(join(root, "skills/run-report/SKILL.md"), "utf8");
    const core = readFileSync(join(root, "skills/core-next/SKILL.md"), "utf8");
    expect(report, 'run-report/SKILL.md must contain --gate "<gate line>"').toContain('--gate "<gate line>"');
    expect(core, 'core-next/SKILL.md must contain --gate "<gate line>"').toContain('--gate "<gate line>"');
  });
});
