#!/usr/bin/env node
// CLI for the plan file. Used by the doug-plan, doug-approve, and doug-implement skills.
//   Any command takes --card <id> (right after the command): it works on the card's plan .doug/plans/<id>.json
//   and report .doug/.state/reports/<id>/last-report.json instead of .doug/plan.json (card parallel-card-queens)
//   plan.mjs anchor --cards [dir]
//                               writes .doug/anchor.md as one section per approved per-card plan, keeping the
//                               "## Autopilot handoff" section of the old anchor
//   plan.mjs validate [dir] [--file <path>]
//                               exit 0 if .doug/plan.json (or the plan at --file, a card's draft) is valid, 1 with errors otherwise
//   plan.mjs show [dir] [--file <path>]
//                               human-readable summary, including resolved model tiers
//   plan.mjs merge <card> <card>... [dir]
//                               several cards in one plan: join the drafts .doug/.state/drafts/<card>.json (one per
//                               card, written by that card's planner) into .doug/plan.json as one draft whose tasks
//                               carry their card, in board order when .doug/board.json is present. A file two cards
//                               own is sequenced (the later card's task depends on the earlier card's), printed, never
//                               refused; a cycle across cards is refused by name. Refuses to replace an approved plan
//                               that has not landed
//   plan.mjs json [dir]         the plan as JSON with model tiers resolved (for the Workflow tool as args)
//   plan.mjs models [dir]       the parsed CLAUDE.md Models table as JSON
//   plan.mjs approve [dir]      draft -> approved (validates first); also retires the doug/task-<id> branch of
//                               any task with no reuse mark, renaming it -stale-<n> the way replan does
//   plan.mjs reject [dir]       -> rejected
//   plan.mjs done [--force] [dir]
//                               -> done; refuses when .doug/.state/last-report.json shows the last run of this
//                               plan paused at a human gate or stopped without finishing ok; --force overrides
//                               (not the paused refusal) and prints a warning
//   plan.mjs anchor [dir]       writes .doug/anchor.md from the plan (survives compaction)
//   plan.mjs land [--delete-branches] [dir]
//                               merge the integration branch into the base branch with --no-ff, only when
//                               the plan is done and its verify commands pass on that branch; exit 1
//                               otherwise. Also removes finished task worktrees under .claude/worktrees
//                               (kept, and named, when one has local changes). --delete-branches (or
//                               land.deleteBranches: true in .doug/config.json) also deletes the plan's
//                               task branches after the merge with `git branch -d`; the integration
//                               branch is always kept
//   plan.mjs land-card <id> --branch <b> --worktree <abs> [--base main]
//                               land a hand card with no plan file: rebase its worktree on the base, gate the rebased
//                               tree through verify.mjs, fast-forward the base, remove the card worktree; prints the
//                               commit, the gate line, lockWaitMs and the removed worktrees; exit 1 on a refusal
//   plan.mjs set <key> <value> [dir]
//                               set install, baseBranch, integrationBranch, integrationWorktree (under .claude/worktrees/), adversary.command,
//                               adversary.fallback (<model>[/<effort>], or off), card, fixAttempts, swarm (on|off),
//                               or workerCheck (on|off) in the plan file
//                               (the file is what the workflow and land read; never pass these as launch args only)
//   plan.mjs replan [dir]       set the plan back to draft and mark tasks that passed verify, review, and
//                               adversary in .doug/.state/last-report.json with reuse: <branch>. A fresh task's
//                               worktree under .claude/worktrees is removed (its uncommitted work saved first to
//                               .doug/.state/replan/<stamp>/<task>.diff) and its branch renamed <branch>-stale-<n>;
//                               a reused task keeps both. The integration worktree and branch are untouched.
// json and land fill `install` from .doug/config.json commands.install and `adversary.command` from
// commands.adversary (`{root}` = the project directory) when the plan has none.

import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { integrationWorktreeFor, loadPlan, savePlan, validatePlan, setStatus, renderPlan, levelize, withSpecHashes, loadReport, reusePlan, staleReuseErrors, REPORT_RELPATH, acceptanceEntries, humanGateLevels, planWarnings, mergePlans, draftPath, PLAN_RELPATH, PLANS_RELPATH, planPathFor, reportPathFor } from "../lib/plan.mjs";
import { loadBoard, boardPath } from "../lib/board.mjs";
import { loadModels, validateModelRefs, resolvePlanModels, renderModels, isModelName, EFFORTS } from "../lib/models.mjs";
import { landPlan, INTEGRATION_WORKTREE } from "../lib/land.mjs";
import { landCard } from "../lib/card-land.mjs";
import { removeFinishedWorktrees, retireTaskWorktrees, retireIntegrationWorktree, branchHead, isGitRepo } from "../lib/worktrees.mjs";
import { readMemoryConfig, readMemoryStaleDays, readIndexConfig, createProvider } from "../lib/embeddings.mjs";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";

// The project's install command from .doug/config.json, used when the plan does not name one.
function configInstall(d) {
  const file = join(d, ".doug/config.json");
  if (!existsSync(file)) return null;
  try {
    const c = JSON.parse(readFileSync(file, "utf8"));
    return c && c.commands && typeof c.commands.install === "string" ? c.commands.install : null;
  } catch {
    return null;
  }
}
// The adversary command from .doug/config.json commands.adversary, with `{root}` replaced by the project
// directory, used when the plan does not name one (plan.adversary === false still disables the adversary).
function configAdversary(d) {
  const file = join(d, ".doug/config.json");
  if (!existsSync(file)) return null;
  try {
    const c = JSON.parse(readFileSync(file, "utf8"));
    const cmd = c && c.commands && typeof c.commands.adversary === "string" ? c.commands.adversary.trim() : "";
    return cmd ? cmd.replace(/\{root\}/g, d) : null;
  } catch {
    return null;
  }
}
// Whether plan.mjs land should delete task branches after merging, from .doug/config.json land.deleteBranches.
// A missing or unparsable config, or anything other than boolean true, means false.
function configDeleteBranches(d) {
  const file = join(d, ".doug/config.json");
  if (!existsSync(file)) return false;
  try {
    const c = JSON.parse(readFileSync(file, "utf8"));
    return !!(c && c.land && c.land.deleteBranches === true);
  } catch {
    return false;
  }
}
// card plan-base-branch-default: the branch checked out in d, or on a detached HEAD its full sha (noted on
// stderr); null when d is not a git repository or git fails.
function currentBase(d) {
  const git = (...args) => execFileSync("git", args, { cwd: d, encoding: "utf8", stdio: "pipe" }).trim();
  try {
    const b = git("symbolic-ref", "--short", "-q", "HEAD");
    if (b) return b;
  } catch {}
  try {
    const sha = git("rev-parse", "--verify", "-q", "HEAD");
    if (!sha) return null;
    process.stderr.write(`[doug] plan.mjs: detached HEAD; baseBranch set to ${sha}\n`);
    return sha;
  } catch {
    return null;
  }
}
function withDefaults(p, d) {
  let out = p;
  if (typeof out.baseBranch !== "string" || !out.baseBranch.trim()) {
    const base = currentBase(d);
    if (base) out = { ...out, baseBranch: base };
  }
  if (!out.install && configInstall(d)) out = { ...out, install: configInstall(d) };
  const hasCommand = out.adversary && typeof out.adversary === "object" && typeof out.adversary.command === "string" && out.adversary.command.trim();
  if (out.adversary !== false && !hasCommand && configAdversary(d)) out = { ...out, adversary: { ...(out.adversary && typeof out.adversary === "object" ? out.adversary : {}), command: configAdversary(d) } };
  return out;
}
// Mirrors lib/memory.mjs's exported MEMORY_DB_RELPATH by value, not by import: importing that module loads
// node:sqlite at its top level (review MAJOR/MINOR 4), so the mere existence check below must not pull it in
// on a Node that lacks node:sqlite, or every plan.mjs json without a database would eat that module's load
// error. Keep this in sync with lib/memory.mjs if that constant ever moves.
const MEMORY_DB_RELPATH = ".doug/.state/memory/memory.db";

// Wraps a provider so a down or slow embeddings endpoint is ever hit once per `plan.mjs json` run: the first
// embed() failure is cached and handed to every later caller with no further request (the degraded-recall
// WARNING for it comes from warnOnce below, once per distinct line). Without this, a plan with many tasks rediscovers the same dead endpoint
// once per task, each paying its own request or timeout (review MAJOR: measured 26.8s for 8 tasks against a
// black-holed baseUrl). null in, null out: recallLessons already treats a null provider as keyword-only.
// card recall-fallback-warning: each distinct degraded-recall warning is printed once per run, not once per task;
// and the local-provider probe (only when no provider is configured) runs once per run too.
const warnedLines = new Set();
function warnOnce(line) {
  if (!line || warnedLines.has(line)) return;
  warnedLines.add(line);
  process.stderr.write(line + "\n");
}
let detectedOnce = null;
function detectOnce(provider) {
  if (provider) return Promise.resolve(null);
  if (!detectedOnce) detectedOnce = import("../lib/memory.mjs").then((mod) => mod.detectLocalProvider());
  return detectedOnce;
}
function cachingProvider(provider) {
  if (!provider) return null;
  let failure = null;
  return {
    name: provider.name,
    model: provider.model,
    dims: provider.dims,
    async embed(texts, opts) {
      if (failure) return failure;
      const result = await provider.embed(texts, opts);
      if (!result.ok) failure = result;
      return result;
    },
  };
}

// Attaches per-task recalled lessons (card memory-recall #2) to the plan JSON `plan.mjs json` emits, never to
// the plan file. Nothing reads a plan-level recall (the planner recalls on its own, before writing the plan),
// so only tasks are queried, one provider round trip saved per run. node:sqlite (via lib/memory.mjs) is loaded
// lazily, and only after confirming the database file exists, so this still works on an older Node with no
// database: any failure past that point (a broken database file, node:sqlite missing despite a database being
// present, ...) prints one stderr line and the plan comes back with no lessons fields, never a nonzero exit.
// `provider` is shared with attachCodeContext (card semantic-index, brief B) so a down or slow embeddings
// endpoint is discovered once per run across both attach steps, not once per step.
async function attachLessons(plan, dir, provider) {
  if (!existsSync(join(dir, MEMORY_DB_RELPATH))) return plan;
  try {
    const { openMemory, recallLessons, degradedWarning, degradedReason, renderLessons } = await import("../lib/memory.mjs");
    const staleDays = readMemoryStaleDays(dir);
    const m = openMemory(dir);
    try {
      const detectedProvider = await detectOnce(provider);
      // An empty lesson store has nothing to degrade (a code-index-only database, say): no warning for it.
      const hasLessons = m.prepare("SELECT 1 FROM lessons WHERE superseded_by IS NULL AND stale IS NULL LIMIT 1").get() !== undefined;
      const tasks = [];
      for (const task of plan.tasks) {
        const taskRecall = await recallLessons(m, `${task.title}\n${task.spec}`, { files: task.files, k: 8, checkoutDir: dir, provider, staleDays, detectedProvider });
        if (hasLessons) warnOnce(degradedWarning(taskRecall, { what: "memory recall", detectedProvider }));
        const taskLessons = renderLessons(taskRecall.lessons);
        const lessonsText = taskLessons.text !== null && taskRecall.degraded ? `(recall was keyword-only: ${degradedReason(taskRecall, detectedProvider)})\n${taskLessons.text}` : taskLessons.text;
        tasks.push(taskLessons.text === null ? task : { ...task, lessons: lessonsText, lessonIds: taskLessons.ids });
      }
      return { ...plan, tasks };
    } finally {
      m.close();
    }
  } catch (err) {
    process.stderr.write(`[doug] memory recall skipped: ${err.message}\n`);
    return plan;
  }
}

// Renders code chunks the same skip-not-stop way renderLessons (lib/memory.mjs) renders lessons, one line per chunk:
// "- <path>:<start>-<end>  <first non-blank line of the chunk, trimmed to 120 chars>". codeContextIds carries
// exactly the ids of the lines kept, in rank order. { text: null, ids: [] } when nothing rendered, the caller's
// cue to omit the fields entirely.
const CODE_CONTEXT_CHAR_CAP = 2000;
function firstNonBlankLine(text) {
  const line = String(text ?? "")
    .split("\n")
    .find((l) => l.trim()) || "";
  return line.trim().slice(0, 120);
}
function renderCodeContext(chunks) {
  const text = [];
  const ids = [];
  let length = 0;
  for (const c of Array.isArray(chunks) ? chunks : []) {
    const line = `- ${c.path}:${c.startLine}-${c.endLine}  ${firstNonBlankLine(c.text)}`;
    const nextLength = length + (text.length ? 1 : 0) + line.length;
    if (nextLength > CODE_CONTEXT_CHAR_CAP) continue;
    text.push(line);
    ids.push(c.id);
    length = nextLength;
  }
  return text.length ? { text: text.join("\n"), ids } : { text: null, ids: [] };
}

// Attaches per-task code context from the opt-in semantic code index (card semantic-index, brief B) to the plan
// JSON `plan.mjs json` emits, never to the plan file and never at plan level. Runs only when memory.index.enabled
// is true and the store holds at least one chunk; otherwise the plan comes back unchanged and nothing is
// printed. `provider` is the same cachingProvider instance attachLessons uses, so the endpoint is probed once
// per run, not twice. Any failure past that point (a broken database, node:sqlite missing) prints one stderr
// line and the plan comes back without the fields, never a nonzero exit.
async function attachCodeContext(plan, dir, provider) {
  if (!readIndexConfig(dir).enabled) return plan;
  if (!existsSync(join(dir, MEMORY_DB_RELPATH))) return plan;
  try {
    const { openMemory, degradedWarning, degradedReason } = await import("../lib/memory.mjs");
    const { searchIndex } = await import("../lib/code-index.mjs");
    const m = openMemory(dir);
    try {
      const chunkCount = m.prepare("SELECT COUNT(*) AS n FROM code_chunks").get().n;
      if (chunkCount === 0) return plan;
      const detectedProvider = await detectOnce(provider);
      const tasks = [];
      for (const task of plan.tasks) {
        const result = await searchIndex(m, `${task.title}\n${task.spec}`, { k: 6, provider, detectedProvider });
        warnOnce(degradedWarning(result, { what: "code index search", code: true, detectedProvider }));
        const rendered = renderCodeContext(result.chunks);
        const codeText = rendered.text !== null && result.degraded ? `(code search was keyword-only: ${degradedReason(result, detectedProvider)})\n${rendered.text}` : rendered.text;
        tasks.push(rendered.text === null ? task : { ...task, codeContext: codeText, codeContextIds: rendered.ids });
      }
      return { ...plan, tasks };
    } finally {
      m.close();
    }
  } catch (err) {
    process.stderr.write(`[doug] code index skipped: ${err.message}\n`);
    return plan;
  }
}

const SETTABLE = ["install", "baseBranch", "integrationBranch", "integrationWorktree", "adversary.command", "adversary.fallback", "card", "fixAttempts", "swarm", "workerCheck"];

const [cmd, ...argsRaw] = process.argv.slice(2);
// --card=<id> is the same as --card <id>.
const argsWithCard = argsRaw.flatMap((a) => (a.startsWith("--card=") ? ["--card", a.slice("--card=".length)] : [a]));
// --card <id> (card parallel-card-queens): the command works on that card's plan .doug/plans/<id>.json and report
// .doug/.state/reports/<id>/last-report.json instead of the single .doug/plan.json. The flag and its value are
// stripped before any positional is read.
const cardFlag = argsWithCard.indexOf("--card");
const cardId = cardFlag >= 0 ? argsWithCard[cardFlag + 1] : undefined;
const rawArgs = cardFlag >= 0 ? argsWithCard.filter((_, i) => i !== cardFlag && i !== cardFlag + 1) : argsWithCard;
if (cardFlag >= 0 && (!cardId || cardId.startsWith("--") || !/^[A-Za-z0-9._-]+$/.test(cardId) || cardId.startsWith("."))) {
  process.stderr.write("plan.mjs --card needs a card id (letters, digits, . _ -)\n");
  process.exit(2);
}
const cardPlanRel = cardId ? planPathFor(cardId) : PLAN_RELPATH;
const reportRel = cardId ? reportPathFor(cardId) : REPORT_RELPATH;
const anchorCards = cmd === "anchor" && rawArgs.includes("--cards");
// --file <path>: validate or show a plan file other than .doug/plan.json (a card's draft), relative to the project dir.
const fileFlag = rawArgs.indexOf("--file");
const planFile = fileFlag >= 0 && (cmd === "validate" || cmd === "show") ? rawArgs[fileFlag + 1] : undefined;
const restArgs = fileFlag >= 0 ? rawArgs.filter((_, i) => i !== fileFlag && i !== fileFlag + 1) : rawArgs;
const firstNonFlag = (args) => args.find((a) => !a.startsWith("--"));
// For merge the card ids come first and the optional dir last: the last positional counts as the dir only when it is one.
const lastDirArg = (args) => {
  const positional = args.filter((a) => !a.startsWith("--"));
  const last = positional[positional.length - 1];
  return last && existsSync(last) && statSync(last).isDirectory() ? last : undefined;
};
const dirArg = cmd === "land-card" ? undefined : cmd === "set" || cmd === "gate" ? restArgs.slice(2).find((a) => !a.startsWith("--")) : cmd === "merge" ? lastDirArg(restArgs) : firstNonFlag(restArgs);
const dir = resolve(process.env.CLAUDE_PROJECT_DIR || dirArg || process.cwd());
const deleteBranchesFlag = cmd === "land" && restArgs.includes("--delete-branches");
const forceDoneFlag = cmd === "done" && restArgs.includes("--force");
// Lets reusePlan/staleReuseErrors resolve a recorded reuse branch that a prior replan renamed to
// <branch>-stale-<n> (card fix-loop-reuse-after-fix-pass): both replan (which decides fresh reuse marks) and
// approve (which recomputes them to check a hand-set mark isn't stale) must agree, or approve would refuse a
// plan replan just wrote. Undefined outside a git working tree, checked with git's own `rev-parse --git-dir`
// (not a `.git`-presence check, which misses a relocated GIT_DIR or a `dir` inside a repo but not at its root),
// so reusePlan falls back to its pure default there instead of treating every recorded branch as missing.
const gitResolver = isGitRepo(dir) ? { branchHead: (name) => branchHead(dir, name) } : undefined;

function fail(msg, code = 1) {
  process.stderr.write(msg + "\n");
  process.exit(code);
}

const plan = anchorCards ? null : loadPlan(dir, planFile || cardPlanRel);
if (!plan && cmd !== undefined && cmd !== "models" && cmd !== "merge" && cmd !== "land-card" && !anchorCards) fail(`No plan at ${join(dir, planFile || cardPlanRel)}. Run /doug-plan first.`, 2);
const models = loadModels(dir);

function allErrors(p) {
  return [...validatePlan(p), ...models.errors, ...validateModelRefs(p, models)];
}

// Shape warnings are printed, never refused: the planner may have a reason, and the user sees them at approval.
function printWarnings(p) {
  const warnings = planWarnings(p);
  if (warnings.length) process.stdout.write("Warnings:\n" + warnings.map((w) => "  ! " + w).join("\n") + "\n");
}

switch (cmd) {
  case "validate": {
    const errors = allErrors(plan);
    if (errors.length) fail("Plan is invalid:\n" + errors.map((e) => "  - " + e).join("\n"));
    process.stdout.write(`Plan is valid: ${plan.tasks.length} tasks in ${levelize(plan.tasks).length} levels, status ${plan.status}.\n`);
    printWarnings(plan);
    break;
  }
  case "show": {
    const errors = allErrors(plan);
    process.stdout.write(renderPlan(plan) + "\n");
    const resolved = resolvePlanModels(plan, models);
    process.stdout.write(`\nModels${models.source ? ` (from ${models.source})` : ""}:\n${renderModels(resolved.models).join("\n")}\n`);
    for (const t of resolved.tasks) if (t.model !== "inherit" || t.effort !== "inherit") process.stdout.write(`  ${t.id}: ${t.model}${t.effort !== "inherit" ? ` / ${t.effort}` : ""}${t.tier ? ` (tier ${t.tier})` : ""}\n`);
    if (errors.length) fail("\nPlan is invalid:\n" + errors.map((e) => "  - " + e).join("\n"));
    printWarnings(plan);
    break;
  }
  case "json": {
    const errors = models.errors.concat(validateModelRefs(plan, models));
    if (errors.length) fail("Cannot resolve models:\n" + errors.map((e) => "  - " + e).join("\n"));
    const provider = cachingProvider(createProvider(readMemoryConfig(dir)));
    const withLessons = await attachLessons(withDefaults(plan, dir), dir, provider);
    const withCodeContext = await attachCodeContext(withLessons, dir, provider);
    process.stdout.write(JSON.stringify(resolvePlanModels(withSpecHashes(withCodeContext), models)) + "\n");
    break;
  }
  case "models": {
    process.stdout.write(JSON.stringify(models, null, 2) + "\n");
    if (models.errors.length) fail("Models table has errors:\n" + models.errors.map((e) => "  - " + e).join("\n"));
    break;
  }
  case "approve": {
    const errors = allErrors(plan);
    if (errors.length) fail("Refusing to approve an invalid plan:\n" + errors.map((e) => "  - " + e).join("\n"));
    if (plan.tasks.some((t) => t.reuse !== undefined)) {
      const reuseErrors = staleReuseErrors(plan, loadReport(dir, reportRel), { git: gitResolver });
      if (reuseErrors.length) fail("Refusing to approve: stale reuse marks:\n" + reuseErrors.map((e) => "  - " + e).join("\n"));
    }
    if (plan.status === "approved") {
      process.stdout.write("Plan is already approved.\n");
      break;
    }
    // A replan can mark a task reusable and keep its doug/task-<id> branch; if the reuse mark is then removed by
    // hand (the spec changed), that branch is left behind for the next launch's checkout to collide with. Retire
    // (same as replan's retireTaskWorktrees: worktree removed, uncommitted work saved first, branch renamed
    // -stale-<n>) the branch of every task with no reuse mark. This runs exactly once, on the real draft ->
    // approved transition, never on a re-approve of an already-approved plan and never on a landed plan (its
    // land --delete-branches looks up task branches by name): a re-approve typed while a run is in flight (a
    // second terminal, or someone re-approving before the gate opens and the relaunch) must not force-remove
    // the running implementer's worktree or rename its live branch out from under it. Tasks marked reuse are
    // never passed in. The integration worktree is untouched here; replan retires that.
    if (gitResolver && !plan.landed) {
      const fresh = plan.tasks.filter((t) => t.reuse === undefined).map((t) => ({ id: t.id, branch: `doug/task-${t.id}` }));
      const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
      const retired = retireTaskWorktrees(dir, { tasks: fresh, saveDir: join(dir, ".doug/.state/replan", stamp) });
      for (const s of retired.saved) process.stdout.write(`  saved diff ${s.path}\n`);
      for (const p of retired.removed) process.stdout.write(`  removed worktree ${p}\n`);
      for (const r of retired.renamed) process.stdout.write(`  renamed branch ${r.from} to ${r.to}\n`);
    }
    printWarnings(plan);
    savePlan(dir, setStatus(plan, "approved", new Date().toISOString()), cardPlanRel);
    process.stdout.write(`Approved: ${plan.title}. Run /doug-implement to execute it.\n`);
    break;
  }
  case "reject": {
    savePlan(dir, setStatus(plan, "rejected"), cardPlanRel);
    process.stdout.write("Plan rejected. Edit it or run /doug-plan again.\n");
    break;
  }
  case "done": {
    // A run paused at a human gate has levels still to run; landing it would merge half a plan. --force does not
    // override this: a paused run genuinely has work left, unlike a stopped one that merely failed.
    const lastReport = loadReport(dir, reportRel);
    if (lastReport && lastReport.paused && typeof lastReport.paused.level === "number" && lastReport.plan === plan.title && plan.status === "approved") fail(`Refusing to mark the plan done: the last run is paused at the human gate after level ${lastReport.paused.level} (next: ${(lastReport.paused.next || []).join(", ")}). Open it with plan.mjs gate open ${lastReport.paused.level} and resume the run with its id, or reject the plan.`);
    // A run that stopped short (a failed level, a level adversary still blocked) or otherwise finished not-ok must
    // not be markable done: that would let land merge a broken run. --force overrides with a printed warning.
    if (lastReport && lastReport.plan === plan.title && plan.status === "approved" && lastReport.ok !== true) {
      const stopReasons = [];
      for (const level of Array.isArray(lastReport.levels) ? lastReport.levels : []) {
        for (const t of Array.isArray(level.tasks) ? level.tasks : []) {
          if (typeof t.stopReason === "string" && t.stopReason.trim()) stopReasons.push(`${t.id}: ${t.stopReason}`);
        }
      }
      const levelPart = typeof lastReport.stoppedAtLevel === "number" ? `it stopped at level ${lastReport.stoppedAtLevel}` : "it finished not ok with no stopped level";
      const reasonsPart = stopReasons.length ? ` (${stopReasons.join("; ")})` : " (no task recorded a stopReason)";
      if (!forceDoneFlag) fail(`Refusing to mark the plan done: the last run is not ok; ${levelPart}${reasonsPart}. Re-plan with plan.mjs replan and run again, or plan.mjs done --force to override.`);
      process.stderr.write(`Warning: marking the plan done although the last run is not ok (${typeof lastReport.stoppedAtLevel === "number" ? `stopped at level ${lastReport.stoppedAtLevel}` : "finished not ok with no stopped level"}).\n`);
    }
    savePlan(dir, setStatus(plan, "done", new Date().toISOString()), cardPlanRel);
    process.stdout.write("Plan marked done.\n");
    break;
  }
  case "anchor": {
    const anchorLines = (p) => {
      const cardLines = typeof p.card === "string" && p.card.trim() ? [`Card: ${p.card}`, ""] : Array.isArray(p.cards) && p.cards.length ? [`Cards: ${p.cards.join(", ")}`, ""] : [];
      const acceptanceLines = acceptanceEntries(p.acceptance).flatMap(({ text, command }) => (command ? [`- ${text}`, `  $ ${command}`] : [`- ${text}`]));
      const lines = [`# ${p.title}`, "", ...cardLines, p.goal, "", "Acceptance:", ...acceptanceLines, "", "Tasks and owned files:"];
      for (const t of p.tasks) lines.push(`- ${t.id}${t.card ? ` [${t.card}]` : ""}: ${t.title} -> ${t.files.join(", ")}${t.reuse ? ` (reuse ${t.reuse})` : ""}`);
      return lines;
    };
    if (anchorCards) {
      // One section per approved, not-landed per-card plan; the "## Autopilot handoff" section of the old anchor is kept.
      const plansDir = join(dir, PLANS_RELPATH);
      const sections = [];
      for (const name of existsSync(plansDir) ? readdirSync(plansDir).filter((f) => f.endsWith(".json")).sort() : []) {
        const p = loadPlan(dir, `${PLANS_RELPATH}/${name}`);
        if (p && p.status === "approved" && !p.landed) sections.push(anchorLines(p).join("\n"));
      }
      const anchorFile = join(dir, ".doug/anchor.md");
      let handoff = "";
      if (existsSync(anchorFile)) {
        const old = readFileSync(anchorFile, "utf8");
        const at = old.startsWith("## Autopilot handoff") ? 0 : old.indexOf("\n## Autopilot handoff");
        if (at >= 0) {
          const from = at === 0 ? 0 : at + 1;
          const next = old.indexOf("\n## ", from + 1);
          handoff = old.slice(from, next >= 0 ? next + 1 : undefined).replace(/\n*$/, "\n");
        }
      }
      writeFileSync(anchorFile, [...sections.map((x) => x + "\n"), ...(handoff ? [handoff] : [])].join("\n"));
      process.stdout.write(`Wrote .doug/anchor.md (${sections.length} card plans)\n`);
      break;
    }
    writeFileSync(join(dir, ".doug/anchor.md"), anchorLines(plan).join("\n") + "\n");
    process.stdout.write("Wrote .doug/anchor.md\n");
    break;
  }
  case "land": {
    const deleteBranches = deleteBranchesFlag || configDeleteBranches(dir);
    const r = landPlan(dir, withDefaults(plan, dir), { deleteBranches, ...(cardId ? { rebase: true, ownOnly: true, planRelpath: cardPlanRel } : {}) });
    if (!r.ok) fail(`Refusing to land: ${r.reason}`);
    process.stdout.write(`Landed ${r.branch} into ${r.base} as ${r.mergeCommit}.\n`);
    process.stdout.write(`lockWaitMs ${r.lockWaitMs ?? 0}\n`);
    for (const v of r.verify) process.stdout.write(`  verify ${v.ok ? "ok" : "failed"}: ${v.command} (${v.durationMs} ms)\n`);
    for (const a of r.acceptance) process.stdout.write(`  acceptance ${a.ok ? "ok" : "failed"}: ${a.text} (${a.durationMs} ms)\n`);
    for (const p of r.worktrees.removed) process.stdout.write(`  removed worktree ${p}\n`);
    for (const k of r.worktrees.kept) process.stdout.write(`  kept worktree ${k.path}: ${k.reason}\n`);
    for (const n of r.branches.deleted) process.stdout.write(`  deleted branch ${n}\n`);
    for (const k of r.branches.kept) process.stdout.write(`  kept branch ${k.name}: ${k.reason}\n`);
    process.stdout.write(`The branch ${r.branch} is kept; delete it when you no longer need it. Recorded in ${cardPlanRel} as landed.\n`);
    break;
  }
  case "land-card": {
    // plan.mjs land-card <id> --branch <b> --worktree <abs> [--base main]: land a hand card (no plan file needed).
    const opt = (name) => {
      const i = restArgs.indexOf(name);
      return i >= 0 ? restArgs[i + 1] : undefined;
    };
    const id = restArgs.find((a, i) => !a.startsWith("--") && !(i > 0 && restArgs[i - 1].startsWith("--")));
    const r = landCard(dir, { id, branch: opt("--branch"), worktree: opt("--worktree"), base: opt("--base") || "main" });
    if (!r.ok) fail(`Refusing to land: ${r.reason}`);
    process.stdout.write(`Landed ${r.id || opt("--branch")} as ${r.commit}.\n${r.gateLine}\nlockWaitMs ${r.lockWaitMs}\n`);
    for (const p of r.removed) process.stdout.write(`  removed worktree ${p}\n`);
    for (const k of r.kept) process.stdout.write(`  kept worktree ${k.path}: ${k.reason}\n`);
    break;
  }
  case "gate": {
    // plan.mjs gate open <level>: release the human gate after that level so a resumed run continues past it.
    const [, action, levelArg] = [cmd, ...rawArgs];
    const gated = humanGateLevels(plan);
    if (action !== "open" || !/^\d+$/.test(String(levelArg))) fail(`usage: plan.mjs gate open <level> [dir]${gated.length ? `\nlevels with a human gate: ${gated.join(", ")}` : "\nthis plan has no human gate"}`, 2);
    if (plan.landed) fail("Refusing to change a landed plan.");
    const level = Number(levelArg);
    if (!gated.includes(level)) fail(`plan.mjs gate open: level ${level} has no human gate${gated.length ? ` (levels with one: ${gated.join(", ")})` : " (this plan has none)"}`, 2);
    const opened = [...new Set([...(plan.gatesOpened || []), level])].sort((a, b) => a - b);
    savePlan(dir, { ...plan, gatesOpened: opened }, cardPlanRel);
    process.stdout.write(`Opened the human gate after level ${level}. Resume the run with its id; levels already run replay, and the run continues with level ${level + 1}.\n`);
    break;
  }
  case "set": {
    const [, key, value] = [cmd, ...rawArgs];
    if (!SETTABLE.includes(key) || typeof value !== "string" || !value.trim()) fail(`usage: plan.mjs set <${SETTABLE.join("|")}> <value> [dir]`, 2);
    if (existsSync(value) && statSync(value).isDirectory()) fail(`plan.mjs set ${key}: the value ${JSON.stringify(value)} is a directory; the value comes before the optional [dir] argument.\nusage: plan.mjs set <${SETTABLE.join("|")}> <value> [dir]`, 2);
    if (plan.landed) fail("Refusing to change a landed plan.");
    const next = { ...plan };
    if (key === "adversary.command") next.adversary = { ...(plan.adversary && typeof plan.adversary === "object" ? plan.adversary : {}), command: value };
    else if (key === "adversary.fallback") {
      // The Claude adversary that stands in when codex-review cannot run: "<model>[/<effort>]", or "off" to block instead.
      if (plan.adversary === false) fail("plan.mjs set adversary.fallback: the adversary is off (adversary: false); the fallback only stands in for a configured adversary.", 2);
      const base = plan.adversary && typeof plan.adversary === "object" ? plan.adversary : {};
      if (/^(off|false|none)$/i.test(value.trim())) next.adversary = { ...base, fallback: false };
      else {
        const [model, effort, extra] = value.split("/").map((s) => s.trim());
        if (extra !== undefined || !isModelName(model) || (effort !== undefined && !EFFORTS.includes(effort))) fail(`plan.mjs set adversary.fallback: the value must be "off" or <model>[/<effort>] with effort one of ${EFFORTS.join(", ")}, got ${JSON.stringify(value)}`, 2);
        next.adversary = { ...base, fallback: effort ? { model, effort } : { model } };
      }
    } else if (key === "swarm") {
      // The swarm opt-in: a lead splits each full-shape task into worker briefs and merges the workers' branches.
      if (!/^(on|off|true|false)$/i.test(value.trim())) fail(`plan.mjs set swarm: the value must be on or off, got ${JSON.stringify(value)}`, 2);
      next.swarm = /^(on|true)$/i.test(value.trim());
    } else if (key === "workerCheck") {
      // Card swarm-topology (candidate 3): a deterministic per-worker check before the merge, behind the swarm opt-in.
      if (!/^(on|off|true|false)$/i.test(value.trim())) fail(`plan.mjs set workerCheck: the value must be on or off, got ${JSON.stringify(value)}`, 2);
      next.workerCheck = /^(on|true)$/i.test(value.trim());
    } else if (key === "fixAttempts") {
      if (!/^\d+$/.test(value)) fail(`plan.mjs set fixAttempts: the value must be a non-negative integer, got ${JSON.stringify(value)}`, 2);
      next.fixAttempts = Number(value);
    } else next[key] = value;
    if (key === "integrationWorktree") {
      const bad = validatePlan(next).filter((e) => e.includes("integrationWorktree"));
      if (bad.length) fail(`plan.mjs set integrationWorktree: ${bad.join("; ")}`, 2);
    }
    savePlan(dir, next, cardPlanRel);
    process.stdout.write(`Set ${key} in ${cardPlanRel}.\n`);
    break;
  }
  case "merge": {
    const cardIds = restArgs.filter((a) => !a.startsWith("--") && a !== dirArg);
    if (cardIds.length < 2) fail("usage: plan.mjs merge <card> <card>... [dir]  (at least two cards)", 2);
    if (plan && plan.status === "approved" && !plan.landed) fail(`Refusing to replace an approved plan that has not landed ("${plan.title}"); land it with plan.mjs done and plan.mjs land, or reject it.`);
    const drafts = [];
    for (const card of cardIds) {
      const d = loadPlan(dir, draftPath(card));
      if (!d) fail(`no draft for card ${card} at ${draftPath(card)}; its planner writes it (one planner per card, in parallel).`);
      drafts.push({ card, plan: d });
    }
    // Board order decides the sequence when the board is there; otherwise the order given.
    let order = null;
    if (existsSync(boardPath(dir))) {
      try {
        order = loadBoard(dir).cards.map((c) => c.id);
      } catch {
        order = null;
      }
    }
    let merged;
    try {
      merged = mergePlans(drafts, { order });
    } catch (e) {
      fail(e.message);
    }
    const errors = allErrors(merged.plan);
    if (errors.length) fail("The merged plan is invalid:\n" + errors.map((e) => "  - " + e).join("\n"));
    savePlan(dir, merged.plan);
    process.stdout.write(`Merged ${merged.plan.cards.length} cards into ${PLAN_RELPATH}: ${merged.plan.cards.join(", ")}${order ? " (board order)" : ""}.\n`);
    for (const r of merged.renamed) process.stdout.write(`  task ${r.card}/${r.from} renamed ${r.to} (the id was taken by an earlier card)\n`);
    for (const s of merged.sequenced) process.stdout.write(`  ${s.file}: ${s.task.card}/${s.task.task} runs after ${s.after.card}/${s.after.task} (both own it)\n`);
    for (const n of merged.notes) process.stdout.write(`  ${n}\n`);
    if (!merged.sequenced.length) process.stdout.write("  no file is owned by two cards; every level runs its cards' tasks in parallel\n");
    process.stdout.write(`Plan is valid: ${merged.plan.tasks.length} tasks in ${levelize(merged.plan.tasks).length} levels, status draft.\n`);
    printWarnings(merged.plan);
    break;
  }
  case "replan": {
    if (plan.landed) fail("Refusing to replan a landed plan.");
    const report = loadReport(dir, reportRel);
    if (report === null) fail(`No report at ${reportRel}; run the workflow first (doug-next saves its report there).`);
    const { plan: next, decisions } = reusePlan(plan, report, { git: gitResolver });
    savePlan(dir, next, cardPlanRel);
    process.stdout.write(`Plan "${plan.title}" is a draft again.\n`);
    for (const d of decisions) {
      if (d.reuse) process.stdout.write(d.renamed ? `  ${d.id}: reuse ${d.reuse} (${d.reason})\n` : `  ${d.id}: reuse ${d.reuse}\n`);
      else process.stdout.write(`  ${d.id}: fresh (${d.reason})\n`);
    }
    // A fresh task's worktree and branch are retired so the next run starts clean (its uncommitted work is saved
    // first); a reused task keeps both, since the checkout agent takes over its branch.
    const reused = new Set(decisions.filter((d) => d.reuse).map((d) => d.id));
    const fresh = [];
    for (const level of (report && Array.isArray(report.levels) ? report.levels : [])) {
      for (const t of (level && Array.isArray(level.tasks) ? level.tasks : [])) {
        if (t && typeof t.branch === "string" && t.branch && !reused.has(t.id)) fresh.push({ id: t.id, branch: t.branch });
      }
    }
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
    const retired = retireTaskWorktrees(dir, { tasks: fresh, saveDir: join(dir, ".doug/.state/replan", stamp) });
    for (const s of retired.saved) process.stdout.write(`  saved diff ${s.path}\n`);
    for (const p of retired.removed) process.stdout.write(`  removed worktree ${p}\n`);
    for (const r of retired.renamed) process.stdout.write(`  renamed branch ${r.from} to ${r.to}\n`);
    // The integration worktree is cleared too: a leftover from the plan's last run must not be reused as is by
    // the next one (card integration-worktree-stale). Its branch is untouched; the workflow's first integration
    // recreates the worktree from the base branch.
    const integrationRetired = retireIntegrationWorktree(dir, integrationWorktreeFor(plan));
    if (integrationRetired.removed) process.stdout.write(`  removed integration worktree ${integrationRetired.removed}\n`);
    process.stdout.write("Review it with plan.mjs show, edit .doug/plan.json if a fresh task needs a new spec, then approve.\n");
    break;
  }
  default:
    fail("usage: plan.mjs <validate|show|json|models|approve|reject|done|anchor|land|land-card|set|replan|gate|merge> [dir]", 2);
}
