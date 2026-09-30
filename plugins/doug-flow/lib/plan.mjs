// The plan file (.doug/plan.json): schema, validation, levelization, and status changes.
// This is the single source of truth for what gets implemented. The workflow refuses to run
// on anything but an approved plan. Pure functions; no I/O except load/save.

import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import { isModelName, EFFORTS } from "./models.mjs";

export const PLAN_RELPATH = ".doug/plan.json";
export const REPORT_RELPATH = ".doug/.state/last-report.json";
// One draft per card of a batch (card parallel-cards): the planner for card <id> writes .doug/.state/drafts/<id>.json
// and `plan.mjs merge` joins them into the plan file.
export const DRAFTS_RELPATH = ".doug/.state/drafts";
export const STATUSES = ["draft", "approved", "done", "rejected"];
export const SIZES = ["S", "M", "L"];
export const GATES = ["auto", "human"];
// Crew per role (card crew-sizing): researchers before planning, reviewers and adversaries after implementation,
// default one each. More coders is a split into more tasks, so there is no coders row.
export const CREW_ROLES = ["researchers", "reviewers", "adversaries"];

// Error strings for a crew object at `where` (the plan or a task); [] when valid or absent.
function crewErrors(crew, where) {
  if (crew === undefined) return [];
  if (!crew || typeof crew !== "object" || Array.isArray(crew)) return [`${where} must be an object with ${CREW_ROLES.join(", ")} when present`];
  const errors = [];
  for (const k of Object.keys(crew)) {
    if (!CREW_ROLES.includes(k)) errors.push(`${where}.${k} is not a crew role (${CREW_ROLES.join(", ")})`);
    else if (!(Number.isInteger(crew[k]) && crew[k] > 0)) errors.push(`${where}.${k} must be a positive integer`);
  }
  return errors;
}

// The crew a task runs with: the task's own over the plan's, one per role by default.
export function crewOf(plan, task) {
  const src = { ...(plan && plan.crew && typeof plan.crew === "object" ? plan.crew : {}), ...(task && task.crew && typeof task.crew === "object" ? task.crew : {}) };
  const out = {};
  for (const k of CREW_ROLES) out[k] = Number.isInteger(src[k]) && src[k] > 0 ? src[k] : 1;
  return out;
}
// Agent scaling (proposal C, card agent-scaling-rules): one task for single-file work, three to five for a
// feature, never more than eight. The validator warns; it does not refuse, since the planner may have a reason.
export const FEATURE_TASKS = 5;
export const TASK_CAP = 8;
export const DEFAULT_BUDGET = { agents: 12, tokens: 400000, wallMinutes: 40 };

export function loadPlan(dir, relpath = PLAN_RELPATH) {
  const file = join(dir, relpath);
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, "utf8"));
}

export function draftPath(card) {
  return `${DRAFTS_RELPATH}/${card}.json`;
}

export function savePlan(dir, plan) {
  const file = join(dir, PLAN_RELPATH);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = file + "." + process.pid + ".tmp";
  writeFileSync(tmp, JSON.stringify(plan, null, 2) + "\n");
  renameSync(tmp, file);
}

// Sha256 hex over a task's contract (spec, files, verify command). A task whose contract changed since
// the recorded pass loses its `specHash` match and so cannot be reused. Computed here in Node because the
// workflow template may not import node:crypto; the workflow only ever copies task.specHash into its report.
export function specHash(task) {
  return createHash("sha256").update(JSON.stringify([task.spec, task.files, task.verify === undefined ? null : task.verify])).digest("hex");
}

// A copy of the plan whose every task carries its current specHash, for `plan.mjs json` to hand the
// workflow (the plan file itself is not rewritten).
export function withSpecHashes(plan) {
  return { ...plan, tasks: plan.tasks.map((t) => ({ ...t, specHash: specHash(t) })) };
}

export function loadReport(dir) {
  const file = join(dir, REPORT_RELPATH);
  if (!existsSync(file)) return null;
  try {
    return unwrapReport(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    return null;
  }
}

// Card report-save-wrapper: the Workflow tool's own output is { summary, agentCount, logs, result, ... }; the
// report every reader expects is `result`. Unwraps only when `obj` itself carries no array `levels` and
// `obj.result` is a non-null object that does carry an array `levels`; otherwise returns `obj` unchanged (a bare
// report, null, a non-object, and a wrapper whose result has no levels are all left alone). Never throws.
export function unwrapReport(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj.levels)) return obj;
  const result = obj.result;
  if (result && typeof result === "object" && Array.isArray(result.levels)) return result;
  return obj;
}

// The report entry's recorded shape (what actually ran, and what its recorded checks correspond to): "S" only when
// entry.shape is exactly "S"; a full-shape entry or an older report predating the `shape` field both come back
// "full".
function entryShape(entry) {
  return entry && entry.shape === "S" ? "S" : "full";
}

// Whether a level's one shared adversary review (levelAdversary: the level adversary reviews an S task alongside
// the rest of its level's S tasks together, on the integration branch, after the merge — not per task) satisfies a
// size-S task's own adversary requirement in its place; the reason it does not, or null when it does. The review
// only ever covers the level's ready S tasks (doug-implement.js's sReady — a task with a stopReason, not ready,
// never made it into the branch the review ran against), recorded by id in `levelAdversary.tasks`: a task whose id
// is not in that list is treated as not covered, same as a report predating the `tasks` field entirely (a missing
// list must never be read as "covers everything"). A block later routed to one S task and cleared by a re-review
// (`confirm.blocked === false`) counts as satisfied, same as the routed-blocker path's own per-task re-review would.
function levelAdversaryFailure(levelAdversary, taskId) {
  if (!levelAdversary || !levelAdversary.ran) return "level adversary did not run";
  if (!Array.isArray(levelAdversary.tasks) || !levelAdversary.tasks.includes(taskId)) {
    return "level adversary did not review this task";
  }
  if (!levelAdversary.blocked) return null;
  if (levelAdversary.confirm && levelAdversary.confirm.blocked === false) return null;
  if (Array.isArray(levelAdversary.unowned) && levelAdversary.unowned.length) {
    return `level adversary blocked on files no task of the level owned: ${levelAdversary.summary || levelAdversary.verdict}`;
  }
  return `level adversary blocked: ${levelAdversary.summary || levelAdversary.verdict}`;
}

// A full-shape task's own adversary can pass while its level's shared adversary later blocks, uncleared, on a
// file that task owns (card level-adversary-routes-owner, rule 2: the old workflow recorded such a blocker as
// unowned, or a routed fix pass never cleared it -- either way the task must not be judged solely on its own
// passed adversary). Ownership is matched the same way the workflow's level-adversary routing matches it (see
// samePath below), not the exact `task.files` match plan.mjs uses elsewhere (planWarnings/validatePlan's
// `mine.has(f)`). Returns the reason, or null when nothing applies.
// Two paths name the same file when they are equal, when one is the other shortened from the left (a verifier
// writes lib/secret-rules.mjs for plugins/doug-gates/lib/secret-rules.mjs), or when the first is a directory the
// second is under. Mirrors doug-implement.js samePath exactly (the workflow file cannot import, so the logic is
// mirrored here, the way R12 is mirrored); ownsPath's `.doug/`/`.claude/` catch-all is deliberately left out, since
// in the workflow it hands such a blocker to the first ready task, which replan cannot identify, and those paths
// are never code a task owns.
function samePath(owned, p) {
  return owned === p || owned.endsWith("/" + p) || p.endsWith("/" + owned) || p.startsWith(owned + "/");
}

function levelAdversaryOwnedBlocker(task, levelAdversary) {
  if (!levelAdversary || !levelAdversary.blocked) return null;
  if (levelAdversary.confirm && levelAdversary.confirm.blocked === false) return null;
  const files = Array.isArray(task.files) ? task.files : [];
  const issues = Array.isArray(levelAdversary.issues) ? levelAdversary.issues : [];
  const hit = issues.find((i) => {
    if (!i || i.severity !== "blocker" || typeof i.file !== "string") return false;
    const file = i.file.trim().replace(/^\.\//, "");
    return file && files.some((f) => samePath(f, file));
  });
  if (!hit) return null;
  return `level adversary blocked on ${hit.file}, owned by this task, and was not cleared: ${levelAdversary.summary || levelAdversary.verdict}`;
}

// Why a task's final pass did not pass every checking stage, or null when it did. A size-S task carries no
// adversary of its own (the level adversary reviews a level's S tasks together, after the merge): when its own
// entry never ran one, `levelAdversary` (that task's level's one shared review) is consulted in its place instead
// of the usual "adversary did not run"/"adversary blocked" reasons, which would be false for an S task whose own
// check passed and whose level adversary passed. A size-S task whose own adversary DID run (the level blocker was
// routed to it as a fix pass) is unaffected by any of this and falls through to the same checks a full-shape task
// gets. A full-shape task whose own adversary passed still fails here when its level's shared adversary blocked,
// uncleared, on a file it owns (levelAdversaryOwnedBlocker, rule 2); a full-shape task whose own adversary already
// blocked keeps that reason instead, unaffected by rule 2.
function stageFailure(plan, task, entry, levelAdversary) {
  if (!entry.verified) return "verification failed";
  if (!entry.reviewed) return "review rejected";
  if (plan.adversary === false) return null;
  const ownRan = Boolean(entry.adversary && entry.adversary.ran);
  if (entryShape(entry) === "S" && !ownRan) return levelAdversaryFailure(levelAdversary, entry.id);
  if (!ownRan) return "adversary did not run";
  if (entry.adversary.blocked) return `adversary blocked: ${entry.adversary.summary || entry.adversary.verdict}`;
  return levelAdversaryOwnedBlocker(task, levelAdversary);
}

// The latest pass of the run on which the branch head passed verify, review, and the adversary, for a task whose
// final pass did not: a fix pass that made no commit runs no stage, and a pass can stop on a ledger hold with every
// stage green. Only a pass whose commit is still the recorded head counts, because reuse starts from the head; a
// later commit that then failed leaves nothing to reuse. On a fix pass (doug-implement.js runChecks, pass > 1),
// the full verifier or reviewer reruns only when it was the stage that blocked the previous pass; otherwise (and
// always after that) the focused check stands in for both, via readCheck mapping the check onto ver/rev. Either
// way, a.verified/a.reviewed on the attempt record reflect whatever actually ran for that pass (the full stage or
// the check), true only when it passed. For a size-S task (entry.shape === "S") whose own attempt record ran no
// adversary, `levelAdversary` (that task's level's one shared review, level-wide rather than per pass, so the same
// value applies to every attempt at the recorded head) stands in for it, same as stageFailure. A full-shape task's
// attempt whose own adversary ran and passed is still not a satisfying pass when the level-wide blocker applies
// (levelAdversaryOwnedBlocker, rule 2, review round 2 B1): the block is level-wide, not per-attempt, so it rules
// out every attempt at the head the same way, and skipping this check here would let this fallback hand a routed
// owner straight back to reuse even though stageFailure just judged it failed for exactly that reason.
function passedAttempt(plan, task, entry, levelAdversary) {
  const head = typeof entry.commit === "string" && entry.commit ? entry.commit : null;
  if (!head || !Array.isArray(entry.attempts)) return null;
  const shape = entryShape(entry);
  for (let i = entry.attempts.length - 1; i >= 0; i--) {
    const a = entry.attempts[i];
    if (!a || a.commit !== head || !a.verified || !a.reviewed) continue;
    if (plan.adversary === false) return a;
    const ownRan = Boolean(a.adversary && a.adversary.ran);
    if (shape === "S" && !ownRan) {
      if (levelAdversaryFailure(levelAdversary, entry.id)) continue;
      return a;
    }
    if (!ownRan || a.adversary.blocked) continue;
    if (levelAdversaryOwnedBlocker(task, levelAdversary)) continue;
    return a;
  }
  return null;
}

// staleName (worktrees.mjs) numbers a rename by the smallest n not yet taken, but a rename can later be deleted
// (by hand, or by some other cleanup) leaving a gap; the scan below cannot assume the names are contiguous.
const MAX_STALE_RENAME_SCAN = 50;

// Resolves a recorded reuse branch against the working tree. `git`, when given, is `{ branchHead(name) }` ->
// sha|null; without it (the default, keeping reusePlan pure) the branch is used exactly as recorded, no existence
// or head check performed. With it, a recorded branch is only ever reused from a head the report actually saw: the
// branch of the recorded name is accepted on its name alone when the report recorded no commit for the task
// (`commit` absent, null, or "" — nothing was ever captured to check a head against, so requiring one here would
// refuse every such reuse; the same `typeof === "string" && commit` guard as passedAttempt's `head` above), otherwise
// its head must equal `commit` by exact string comparison, the same as the stale scan below and passedAttempt's own
// head check: an abbreviated or otherwise non-sha `commit` in a report will not match a full sha head and so now
// goes fresh, where before this card it would have been accepted by name regardless. When the recorded name's head
// does not so qualify (the branch is gone entirely, or it exists but points somewhere else — e.g. a stray
// `doug/task-<id>` the implementer's `git checkout -b` left behind after a run died before reporting), the highest
// `<branch>-stale-<n>` (n from 1 to MAX_STALE_RENAME_SCAN) whose head equals `commit` is used instead: a stale
// rename wins even over a same-named branch with the wrong head, because the recorded work is really there, just
// filed under another name, and a stray branch must not be allowed to hide it. But that scan only runs when a
// commit was recorded to match against (it needs something to compare a candidate's head to); with no commit
// recorded, a stray branch of the recorded name is accepted by name and the scan for a rename of the real work is
// not attempted — that is the same trade the no-commit acceptance above makes, on the same reasoning: without a
// commit there is nothing to tell the two apart by. Returns { ok: true, branch, renamed } on success, or
// { ok: false, mismatch, head } when nothing resolves and the task must go fresh: `mismatch` is true when the
// recorded name exists but disqualified it (so the caller can name the mismatch rather than claim the branch is
// gone), false when the name was simply absent; `head` is that disqualifying head, or null when the name was absent.
function resolveReuseBranch(branch, commit, git) {
  if (!git || typeof git.branchHead !== "function") return { ok: true, branch, renamed: false };
  const hasCommit = typeof commit === "string" && commit;
  const head = git.branchHead(branch);
  if (head && (!hasCommit || head === commit)) return { ok: true, branch, renamed: false };
  let match = null;
  if (hasCommit) {
    for (let n = 1; n <= MAX_STALE_RENAME_SCAN; n++) {
      const name = `${branch}-stale-${n}`;
      const h = git.branchHead(name);
      if (h && h === commit) match = name;
    }
  }
  if (match) return { ok: true, branch: match, renamed: true };
  return { ok: false, mismatch: Boolean(head), head: head || null };
}

// Pure by default: decides which tasks from a prior workflow report can be reused (implementer skipped; verify,
// review, and adversary run again) rather than re-implemented from scratch. `report` may be null. `opts` (any of
// undefined, null, or an object) may carry `git`, an optional `{ branchHead(name) -> sha|null }` resolver; without
// it the function touches no git state and every existing caller is unaffected. With it, reuse never starts from a
// head the report never saw: a recorded branch must have the recorded commit as its head (see resolveReuseBranch
// for the no-commit-recorded exception), or it is resolved to its `-stale-<n>` rename when that rename's head is
// the commit this pass recorded (a prior replan may have renamed it because the task went fresh, and this replan
// finds the task's specHash matches again — or the recorded name was reused elsewhere, e.g. a stray
// `git checkout -b` from a run that died before reporting), or the task goes fresh with a reason naming which case
// it was: the branch gone entirely, or present with a head that does not match. Each decision also carries
// `renamed`: true only when the reuse was resolved to such a rename, so a caller can report that without parsing
// `reason`.
export function reusePlan(plan, report, opts) {
  const { git } = opts || {};
  const entries = new Map(); // id -> { entry, levelAdversary }
  for (const level of (report && Array.isArray(report.levels) ? report.levels : [])) {
    const levelAdversary = level && level.levelAdversary !== undefined ? level.levelAdversary : null;
    for (const t of (level && Array.isArray(level.tasks) ? level.tasks : [])) {
      if (t && typeof t.id === "string") entries.set(t.id, { entry: t, levelAdversary });
    }
  }

  const decided = new Map(); // id -> { reuse, reason }
  const levels = levelize(plan.tasks);
  for (const level of levels) {
    for (const task of level) {
      const rec = entries.get(task.id);
      const entry = rec ? rec.entry : undefined;
      const levelAdversary = rec ? rec.levelAdversary : null;
      const failed = entry && entry.implemented ? stageFailure(plan, task, entry, levelAdversary) : null;
      const viaPass = failed ? passedAttempt(plan, task, entry, levelAdversary) : null;
      let reuse = null;
      let renamed = false;
      let reason;
      if (!entry) {
        reason = "not in the last report";
      } else if (!entry.implemented) {
        reason = typeof entry.blockedReason === "string" ? `implementer blocked: ${entry.blockedReason}` : "not implemented";
      } else if (failed && !viaPass) {
        reason = failed;
      } else if (typeof entry.branch !== "string" || !entry.branch) {
        reason = "no branch recorded";
      } else if (typeof entry.specHash !== "string") {
        reason = "no spec hash recorded (report predates replan)";
      } else if (entry.specHash !== specHash(task)) {
        reason = "spec changed since the recorded pass";
      } else {
        const badDep = (task.dependsOn || []).find((d) => !(decided.get(d) && decided.get(d).reuse));
        if (badDep !== undefined) {
          reason = `depends on ${badDep}, which is not reused`;
        } else {
          const resolved = resolveReuseBranch(entry.branch, entry.commit, git);
          if (!resolved.ok) {
            reason = resolved.mismatch
              ? `recorded branch ${entry.branch} head ${resolved.head.slice(0, 7)} is not the recorded commit ${entry.commit}; re-implementing`
              : `recorded branch ${entry.branch} no longer exists; re-implementing`;
          } else {
            reuse = resolved.branch;
            renamed = resolved.renamed;
            // Which record (the entry's own, or the matched earlier attempt's own) actually satisfied the
            // adversary requirement decides the wording: the task's own adversary keeps the existing "adversary"
            // wording unchanged, but a size-S task satisfied instead by its level's shared review must not claim a
            // task adversary that never ran.
            const satisfiedBy = viaPass || entry;
            const viaLevel = plan.adversary !== false && entryShape(entry) === "S" && !(satisfiedBy.adversary && satisfiedBy.adversary.ran);
            const adversaryWord = viaLevel ? "the level adversary" : "adversary";
            const base = viaPass
              ? `passed verify, review, and ${adversaryWord} on pass ${viaPass.pass} of the last run; the branch head ${entry.commit.slice(0, 7)} is unchanged since`
              : `passed verify, review, and ${adversaryWord} on ${entry.branch}`;
            reason = renamed ? `${base}; ${entry.branch} was renamed to ${resolved.branch} since the last report` : base;
          }
        }
      }
      decided.set(task.id, { reuse, reason, renamed });
    }
  }

  const decisions = plan.tasks.map((t) => ({ id: t.id, reuse: decided.get(t.id).reuse, reason: decided.get(t.id).reason, renamed: decided.get(t.id).renamed }));
  const next = { ...plan, status: "draft" };
  delete next.approvedAt;
  delete next.doneAt;
  next.tasks = plan.tasks.map((t) => {
    const { reuse } = decided.get(t.id);
    const { reuse: _drop, ...rest } = t;
    return reuse ? { ...rest, reuse } : rest;
  });
  return { plan: next, decisions };
}

// Error strings for tasks whose `reuse` mark no longer matches what a fresh replan decision would give
// (e.g. the report was regenerated, or the spec changed after the mark was set). Empty when no task
// carries `reuse`. `opts` is passed through to reusePlan unchanged (see its `git` option) so a reuse mark
// resolved to a renamed branch by replan is not flagged stale here for want of the same resolver.
export function staleReuseErrors(plan, report, opts = {}) {
  if (!plan.tasks.some((t) => t.reuse !== undefined)) return [];
  const { decisions } = reusePlan(plan, report, opts);
  const byId = new Map(decisions.map((d) => [d.id, d]));
  const errors = [];
  for (const t of plan.tasks) {
    if (t.reuse === undefined) continue;
    const fresh = byId.get(t.id);
    if (!fresh || fresh.reuse !== t.reuse) {
      errors.push(`task "${t.id}" is marked reuse: ${t.reuse} but ${fresh ? fresh.reason : "not in the last report"}; run plan.mjs replan`);
    }
  }
  return errors;
}

// Normalizes an acceptance list (already validated) into one { text, command } per entry, in order.
// A string entry gives command: null. An object entry gives its trimmed-nonempty command, or null.
// Any other entry (null, number, array) is stringified into text with command: null.
export function acceptanceEntries(list) {
  if (!Array.isArray(list)) return [];
  return list.map((a) => {
    if (typeof a === "string") return { text: a, command: null };
    if (a && typeof a === "object" && !Array.isArray(a)) {
      const command = typeof a.command === "string" && a.command.trim() ? a.command : null;
      return { text: String(a.text), command };
    }
    return { text: String(a), command: null };
  });
}

function isRelPath(p) {
  return typeof p === "string" && p.length > 0 && !p.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(p) && !p.split(/[\\/]/).includes("..");
}

// Returns an array of error strings. Empty means valid.
export function validatePlan(plan) {
  const errors = [];
  if (!plan || typeof plan !== "object") return ["plan must be an object"];
  if (plan.version !== 1) errors.push("version must be 1");
  if (typeof plan.title !== "string" || !plan.title.trim()) errors.push("title is required");
  if (typeof plan.goal !== "string" || !plan.goal.trim()) errors.push("goal is required");
  if (!STATUSES.includes(plan.status)) errors.push(`status must be one of ${STATUSES.join(", ")}`);
  if (!Array.isArray(plan.acceptance) || plan.acceptance.length === 0) {
    errors.push("acceptance must be a non-empty array");
  } else {
    plan.acceptance.forEach((a, i) => {
      const validString = typeof a === "string" && a.trim();
      const validObject = a && typeof a === "object" && !Array.isArray(a) && typeof a.text === "string" && a.text.trim() && typeof a.command === "string" && a.command.trim();
      if (!validString && !validObject) errors.push(`acceptance[${i}] must be a non-empty string or { text, command } with non-empty strings`);
    });
  }
  if (!Array.isArray(plan.verify) || !plan.verify.every((v) => typeof v === "string" && v.trim())) errors.push("verify must be an array of command strings");
  if (plan.card !== undefined && (typeof plan.card !== "string" || !plan.card.trim())) errors.push("card must be a non-empty string when present");
  // A batch (several cards in one plan) lists its cards; every task then names the card it belongs to.
  let cards = null;
  if (plan.cards !== undefined) {
    if (!Array.isArray(plan.cards) || plan.cards.length === 0 || !plan.cards.every((c) => typeof c === "string" && c.trim())) errors.push("cards must be an array of card ids when present");
    else {
      cards = plan.cards;
      const seen = new Set();
      for (const c of cards) {
        if (seen.has(c)) errors.push(`cards lists "${c}" twice`);
        seen.add(c);
      }
    }
  }
  if (plan.fixAttempts !== undefined && !(Number.isInteger(plan.fixAttempts) && plan.fixAttempts >= 0)) errors.push("fixAttempts must be a non-negative integer when present");
  errors.push(...crewErrors(plan.crew, "crew"));
  // The swarm opt-in (card swarm-lead): a lead splits each full-shape task into worker briefs inside its owned files.
  if (plan.swarm !== undefined && typeof plan.swarm !== "boolean") errors.push("swarm must be true or false when present");
  // Card swarm-topology (candidate 3): the deterministic per-worker check before the merge, behind the swarm opt-in.
  if (plan.workerCheck !== undefined && typeof plan.workerCheck !== "boolean") errors.push("workerCheck must be true or false when present");
  if (plan.gatesOpened !== undefined && (!Array.isArray(plan.gatesOpened) || !plan.gatesOpened.every((n) => Number.isInteger(n) && n >= 0))) errors.push("gatesOpened must be an array of level indexes when present");
  if (plan.budget !== undefined) {
    if (plan.budget === null || Array.isArray(plan.budget) || typeof plan.budget !== "object" || Object.getPrototypeOf(plan.budget) !== Object.prototype) {
      errors.push("budget must be an object with agents, tokens, and/or wallMinutes when present");
    } else {
      if (plan.budget.agents !== undefined) {
        if (!(Number.isInteger(plan.budget.agents) && plan.budget.agents > 0)) {
          errors.push("budget.agents must be a positive integer when present");
        }
      }
      if (plan.budget.tokens !== undefined) {
        if (!(Number.isInteger(plan.budget.tokens) && plan.budget.tokens > 0)) {
          errors.push("budget.tokens must be a positive integer when present");
        }
      }
      if (plan.budget.wallMinutes !== undefined) {
        if (!(typeof plan.budget.wallMinutes === "number" && Number.isFinite(plan.budget.wallMinutes) && plan.budget.wallMinutes > 0)) {
          errors.push("budget.wallMinutes must be a positive number when present");
        }
      }
      for (const key of Object.keys(plan.budget)) {
        if (!["agents", "tokens", "wallMinutes"].includes(key)) {
          errors.push(`budget.${key} is not a budget measure (agents, tokens, wallMinutes)`);
        }
      }
    }
  }
  if (plan.adversary !== undefined && plan.adversary !== false) {
    if (!plan.adversary || typeof plan.adversary !== "object" || Array.isArray(plan.adversary)) errors.push("adversary must be false or an object when present");
    else if (plan.adversary.fallback !== undefined && plan.adversary.fallback !== false) {
      const fb = plan.adversary.fallback;
      if (!fb || typeof fb !== "object" || !isModelName(fb.model)) errors.push("adversary.fallback must be false or { model, effort? } with a model name (opus, sonnet, haiku, fable, inherit, or a model id)");
      else if (fb.effort !== undefined && !EFFORTS.includes(fb.effort)) errors.push(`adversary.fallback.effort must be one of ${EFFORTS.join(", ")}`);
    }
  }
  if (!Array.isArray(plan.tasks) || plan.tasks.length === 0) {
    errors.push("tasks must be a non-empty array");
    return errors;
  }

  const ids = new Set();
  const owners = new Map(); // file -> taskId
  for (const [i, t] of plan.tasks.entries()) {
    const where = `tasks[${i}]`;
    if (!t || typeof t !== "object") {
      errors.push(`${where} must be an object`);
      continue;
    }
    if (typeof t.id !== "string" || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(t.id)) errors.push(`${where}.id must match ^[a-z0-9][a-z0-9-]{0,39}$`);
    else if (ids.has(t.id)) errors.push(`${where}.id "${t.id}" is duplicated`);
    else ids.add(t.id);
    if (typeof t.title !== "string" || !t.title.trim()) errors.push(`${where}.title is required`);
    if (typeof t.spec !== "string" || t.spec.trim().length < 20) errors.push(`${where}.spec must describe the task (at least 20 characters)`);
    if (!Array.isArray(t.files) || t.files.length === 0) errors.push(`${where}.files must list at least one owned file`);
    else {
      for (const f of t.files) {
        if (!isRelPath(f)) errors.push(`${where}.files contains an invalid path: ${JSON.stringify(f)}`);
      }
    }
    if (t.verify !== undefined && (typeof t.verify !== "string" || !t.verify.trim())) errors.push(`${where}.verify must be a command string when present`);
    if (t.dependsOn !== undefined && (!Array.isArray(t.dependsOn) || !t.dependsOn.every((d) => typeof d === "string"))) errors.push(`${where}.dependsOn must be an array of task ids`);
    if (t.reuse !== undefined && (typeof t.reuse !== "string" || !t.reuse.trim())) errors.push(`${where}.reuse must be a non-empty branch name when present`);
    // Size decides the pipeline shape (decision 0005): S runs implement and one focused check, with the adversary once
    // per level on the integration branch; M and L keep the full shape. Unsized means full.
    if (t.size !== undefined && !SIZES.includes(t.size)) errors.push(`${where}.size must be one of ${SIZES.join(", ")} when present`);
    // A human gate (decision 0002 #2) pauses the run after this task's level has integrated, until the user opens it.
    if (t.gate !== undefined && !GATES.includes(t.gate)) errors.push(`${where}.gate must be one of ${GATES.join(", ")} when present`);
    // Model tier fields are optional strings; their values are checked against CLAUDE.md by lib/models.mjs.
    for (const k of ["model", "effort", "tier"]) {
      if (t[k] !== undefined && (typeof t[k] !== "string" || !t[k].trim())) errors.push(`${where}.${k} must be a non-empty string when present`);
    }
    errors.push(...crewErrors(t.crew, `${where}.crew`));
    if (t.card !== undefined && (typeof t.card !== "string" || !t.card.trim())) errors.push(`${where}.card must be a non-empty string when present`);
    else if (cards && t.card === undefined) errors.push(`${where}.card is required when the plan has cards`);
    else if (cards && !cards.includes(t.card)) errors.push(`${where}.card "${t.card}" is not one of the plan's cards (${cards.join(", ")})`);
  }

  // Dependencies must exist and be acyclic.
  for (const t of plan.tasks) {
    for (const d of t.dependsOn || []) {
      if (!ids.has(d)) errors.push(`task "${t.id}" depends on unknown task "${d}"`);
      if (d === t.id) errors.push(`task "${t.id}" depends on itself`);
    }
  }
  if (errors.length === 0) {
    try {
      levelize(plan.tasks);
    } catch (e) {
      errors.push(e.message);
    }
  }

  // One owner per file, unless the tasks are ordered by a dependency edge.
  if (errors.length === 0) {
    const order = levelOrder(plan.tasks);
    for (const t of plan.tasks) {
      for (const f of t.files) {
        const prev = owners.get(f);
        if (prev && prev !== t.id) {
          const a = plan.tasks.find((x) => x.id === prev);
          const related = (t.dependsOn || []).includes(prev) || (a.dependsOn || []).includes(t.id) || order.get(prev) !== order.get(t.id);
          if (!related) errors.push(`file "${f}" is owned by both "${prev}" and "${t.id}" with no dependency between them`);
        }
        owners.set(f, t.id);
      }
    }
  }
  // A task that names another task's file in its spec or verify command consumes what that task builds: it must
  // depend on it, so it lands in a later level (card planner-producer-level, 2026-09-07: the adversary judges a task
  // branch against the whole plan goal, and a consumer in the producer's level blocked every run). A dependency in
  // either direction, direct or transitive, satisfies the rule: a producer may describe its consumer.
  if (errors.length === 0) {
    const byId = new Map(plan.tasks.map((t) => [t.id, t]));
    const ancestors = (id, seen = new Set()) => {
      for (const d of byId.get(id).dependsOn || []) if (!seen.has(d)) { seen.add(d); ancestors(d, seen); }
      return seen;
    };
    plan.tasks.forEach((t, i) => {
      const text = `${t.spec} ${t.verify || ""}`;
      const mine = new Set(t.files);
      const up = ancestors(t.id);
      const reported = new Set();
      for (const other of plan.tasks) {
        if (other.id === t.id || reported.has(other.id) || up.has(other.id) || ancestors(other.id).has(t.id)) continue;
        const named = other.files.find((f) => !mine.has(f) && text.includes(f));
        if (named) {
          reported.add(other.id);
          errors.push(`task "${t.id}" names "${named}", owned by "${other.id}", but does not depend on it; add "${other.id}" to tasks[${i}].dependsOn so "${t.id}" lands in a later level`);
        }
      }
    });
  }
  return errors;
}

// Warnings (not errors) about the plan's shape: too many tasks for one plan, or several tasks for one file.
export function planWarnings(plan) {
  const out = [];
  if (!plan || !Array.isArray(plan.tasks)) return out;
  const n = plan.tasks.length;
  if (n > TASK_CAP) out.push(`${n} tasks: never more than eight in one plan; split the work into two cards or merge tasks that share a file group`);
  else if (n > FEATURE_TASKS) out.push(`${n} tasks: a feature is three to five; merge tasks that share a file group or split the plan`);
  const files = new Set(plan.tasks.flatMap((t) => (Array.isArray(t.files) ? t.files : [])));
  if (n > 1 && files.size === 1) out.push(`${n} tasks own the same single file (${[...files][0]}): single-file work is one task`);
  return out;
}

// Level indexes that end at a human gate: any task in the level carries gate: "human".
export function humanGateLevels(plan) {
  return levelize(plan.tasks).map((lvl, i) => (lvl.some((t) => t.gate === "human") ? i : -1)).filter((i) => i >= 0);
}

// Groups tasks into dependency levels. Level 0 has no deps; level N depends only on levels < N.
export function levelize(tasks) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const level = new Map();
  const visiting = new Set();
  function depth(id, chain) {
    if (level.has(id)) return level.get(id);
    if (visiting.has(id)) throw new Error(`dependency cycle: ${[...chain, id].join(" -> ")}`);
    visiting.add(id);
    const t = byId.get(id);
    let d = 0;
    for (const dep of t.dependsOn || []) d = Math.max(d, depth(dep, [...chain, id]) + 1);
    visiting.delete(id);
    level.set(id, d);
    return d;
  }
  for (const t of tasks) depth(t.id, []);
  const max = Math.max(...level.values());
  const levels = [];
  for (let i = 0; i <= max; i++) levels.push(tasks.filter((t) => level.get(t.id) === i));
  return levels;
}

function levelOrder(tasks) {
  const m = new Map();
  levelize(tasks).forEach((lvl, i) => lvl.forEach((t) => m.set(t.id, i)));
  return m;
}

// The branch the workflow integrates into. Must stay identical to the expression in
// workflows/doug-implement.js (the workflow cannot import this file); tests/template.test.mjs checks that.
export function integrationBranchFor(plan) {
  return plan.integrationBranch || `doug/${plan.tasks.map((t) => t.id).join("-").slice(0, 40)}`;
}

// Several cards in one plan (card parallel-cards). `drafts` is [{ card, plan }], one validated draft per card;
// `order` (card ids, board order) decides the sequence when given, else the order passed. The result is one draft
// plan whose tasks carry their card: level k of the batch is the union of each card's level k, since every draft's
// own dependsOn edges are kept and nothing else moves a task. A file two cards own is not refused: the later card's
// task gains a dependsOn edge to every task of the earlier card that owns it, so the file is edited in sequence with
// each card keeping its own spec, verify, and acceptance; `sequenced` lists each edge added. A task id a later card
// reuses is renamed <card>-<id> (its own dependsOn rewritten; `renamed` lists it). Only a cycle across cards is
// refused, by card name. Plan-level settings (install, baseBranch, adversary, budget, fixAttempts) come from the
// first draft that sets them; a later draft that disagrees is named in `notes`.
export function mergePlans(drafts, { order = null } = {}) {
  if (!Array.isArray(drafts) || drafts.length < 2) throw new Error("a batch needs at least two cards");
  const ids = drafts.map((d) => d.card);
  for (const [i, id] of ids.entries()) if (ids.indexOf(id) !== i) throw new Error(`card "${id}" is listed twice`);
  let ordered = drafts;
  if (Array.isArray(order)) {
    const rank = (id) => (order.includes(id) ? order.indexOf(id) : order.length + ids.indexOf(id));
    ordered = [...drafts].sort((a, b) => rank(a.card) - rank(b.card));
  }
  // A draft may depend on a task of another draft in the batch (a hand edit, or a deliberate sequence); only a
  // dependency no draft has is unknown here. Whether such edges form a cycle is checked on the merged tasks below.
  const elsewhere = new Set(ordered.flatMap((d) => (Array.isArray(d.plan && d.plan.tasks) ? d.plan.tasks : []).map((t) => t && t.id)));
  for (const d of ordered) {
    const errors = validatePlan(d.plan).filter((e) => {
      const m = /^task "[^"]+" depends on unknown task "([^"]+)"$/.exec(e);
      return !(m && elsewhere.has(m[1]));
    });
    if (errors.length) throw new Error(`draft for card ${d.card} is invalid:\n${errors.map((e) => "  - " + e).join("\n")}`);
  }

  const cards = ordered.map((d) => d.card);
  const taken = new Set();
  const renamed = [];
  const tasks = [];
  const cardOf = new Map(); // merged task id -> card
  for (const d of ordered) {
    const rename = new Map();
    for (const t of d.plan.tasks) {
      let id = t.id;
      if (taken.has(id)) {
        id = `${d.card}-${t.id}`;
        renamed.push({ card: d.card, from: t.id, to: id });
      }
      rename.set(t.id, id);
      taken.add(id);
    }
    for (const t of d.plan.tasks) {
      const next = { ...t, id: rename.get(t.id), card: d.card };
      if (Array.isArray(t.dependsOn)) next.dependsOn = t.dependsOn.map((x) => rename.get(x) || x);
      tasks.push(next);
      cardOf.set(next.id, d.card);
    }
  }

  // Sequence overlapping files: later card's task after every earlier-card task that owns the file.
  const sequenced = [];
  const owners = new Map(); // file -> [{ card, task }] in merge order
  for (const t of tasks) {
    for (const f of t.files) {
      const prev = owners.get(f) || [];
      for (const p of prev) {
        if (p.card === t.card) continue;
        const deps = Array.isArray(t.dependsOn) ? t.dependsOn : [];
        if (!deps.includes(p.task)) t.dependsOn = [...deps, p.task];
        sequenced.push({ file: f, after: { card: p.card, task: p.task }, task: { card: t.card, task: t.id } });
      }
      owners.set(f, [...prev, { card: t.card, task: t.id }]);
    }
  }

  try {
    levelize(tasks);
  } catch (e) {
    const m = /^dependency cycle: (.*)$/.exec(e.message);
    if (!m) throw e;
    const chain = m[1].split(" -> ");
    const involved = [...new Set(chain.map((id) => cardOf.get(id)).filter(Boolean))];
    const named = involved.length > 1 ? `across cards ${involved.slice(0, -1).join(", ")} and ${involved[involved.length - 1]}` : `within card ${involved[0]}`;
    throw new Error(`dependency cycle ${named}: ${m[1]}`);
  }

  const first = ordered[0].plan;
  const plan = {
    version: 1,
    title: `${cards.length} cards: ${cards.join(", ")}`,
    goal: ordered.map((d) => `${d.card}: ${d.plan.goal}`).join("\n\n"),
    status: "draft",
    cards,
  };
  const notes = [];
  for (const key of ["baseBranch", "install", "adversary", "budget", "fixAttempts"]) {
    let from = null;
    for (const d of ordered) {
      if (d.plan[key] === undefined) continue;
      if (from === null) {
        plan[key] = d.plan[key];
        from = d.card;
      } else if (JSON.stringify(d.plan[key]) !== JSON.stringify(plan[key])) {
        notes.push(`${key}: kept ${JSON.stringify(plan[key])} from ${from}; ${d.card} asked for ${JSON.stringify(d.plan[key])}`);
      }
    }
  }
  plan.acceptance = ordered.flatMap((d) => d.plan.acceptance.map((a) => (typeof a === "string" ? `[${d.card}] ${a}` : { ...a, text: `[${d.card}] ${a.text}` })));
  plan.verify = [...new Set(ordered.flatMap((d) => d.plan.verify || []))];
  plan.tasks = tasks;
  return { plan, sequenced, renamed, notes };
}

export function setStatus(plan, status, at) {
  if (!STATUSES.includes(status)) throw new Error(`invalid status ${status}`);
  const next = { ...plan, status };
  if (status === "approved") next.approvedAt = at;
  if (status === "done") next.doneAt = at;
  return next;
}

// Text summary for humans, used by `plan show` and the approval skill.
export function renderPlan(plan) {
  const out = [];
  out.push(`${plan.title}  [${plan.status}]`);
  if (typeof plan.card === "string" && plan.card.trim()) out.push(`Card: ${plan.card}`);
  if (Array.isArray(plan.cards) && plan.cards.length) out.push(`Cards: ${plan.cards.join(", ")}`);
  out.push(`Goal: ${plan.goal}`);
  out.push("");
  out.push("Acceptance:");
  for (const { text, command } of acceptanceEntries(plan.acceptance)) {
    out.push(`  - ${text}`);
    if (command) out.push(`    $ ${command}`);
  }
  if (plan.verify && plan.verify.length) {
    out.push("Verify after integration:");
    for (const v of plan.verify) out.push(`  $ ${v}`);
  }
  out.push(`Fix attempts per blocked task: ${plan.fixAttempts === undefined ? "5 (default)" : plan.fixAttempts}`);
  const agents = plan.budget?.agents ?? DEFAULT_BUDGET.agents;
  const tokens = plan.budget?.tokens ?? DEFAULT_BUDGET.tokens;
  const wallMinutes = plan.budget?.wallMinutes ?? DEFAULT_BUDGET.wallMinutes;
  const agentsStr = plan.budget?.agents !== undefined ? `${agents}` : `${agents} (default)`;
  const tokensStr = plan.budget?.tokens !== undefined ? `${tokens}` : `${tokens} (default)`;
  const wallStr = plan.budget?.wallMinutes !== undefined ? `${wallMinutes} min` : `${wallMinutes} min (default)`;
  out.push(`Budget per task: agents ${agentsStr}, tokens ${tokensStr}, wall ${wallStr}`);
  if (plan.crew && typeof plan.crew === "object") out.push(`Crew per task: ${CREW_ROLES.map((k) => `${k} ${crewOf(plan, null)[k]}`).join(", ")} (a task's own crew overrides)`);
  if (plan.swarm === true) out.push("Swarm: on (a lead on the lead row splits each full-shape task into worker briefs inside its owned files; workers on the worker row implement them in parallel; the lead merges before the checks)");
  if (plan.workerCheck === true) out.push("Worker check: on (before the merge the workflow checks each swarm worker's filesTouched against its brief and that it committed; a failure is a block the lead may re-brief once)");
  if (plan.adversary === false) out.push("Adversary: off");
  else {
    const fb = plan.adversary && plan.adversary.fallback;
    const cmd = plan.adversary && typeof plan.adversary.command === "string" && plan.adversary.command.trim() ? plan.adversary.command : "codex-review (or .doug/config.json commands.adversary)";
    const fallback = fb === false ? "off; a review that does not run blocks" : `Claude adversary on ${(fb && fb.model) || "opus"} / ${(fb && fb.effort) || "high"}`;
    out.push(`Adversary: ${cmd}; if it cannot run: ${fallback}`);
  }
  out.push("");
  const levels = levelize(plan.tasks);
  levels.forEach((lvl, i) => {
    out.push(`Level ${i}${i === 0 ? " (no dependencies, runs in parallel)" : ""}:`);
    for (const t of lvl) {
      out.push(`  ${t.id}: ${t.title}`);
      if (typeof t.card === "string" && t.card) out.push(`      card: ${t.card}`);
      out.push(`      owns: ${t.files.join(", ")}`);
      if (t.dependsOn && t.dependsOn.length) out.push(`      after: ${t.dependsOn.join(", ")}`);
      if (t.verify) out.push(`      verify: ${t.verify}`);
      if (t.reuse) out.push(`      reuse: ${t.reuse} (implementer skipped; verify, review, adversary run again)`);
      out.push(`      size: ${t.size || "unsized"} (${t.size === "S" ? "implement, one focused check; the adversary reviews the level on the integration branch" : "full shape: implement, verify and review together, adversary"})`);
      const crew = crewOf(plan, t);
      if (CREW_ROLES.some((k) => crew[k] > 1)) out.push(`      crew: ${CREW_ROLES.filter((k) => crew[k] > 1).map((k) => `${k} ${crew[k]}`).join(", ")}${t.size === "S" ? " (a size-S task runs one focused check; the crew applies to the full shape)" : ""}`);
      if (t.gate === "human") out.push(`      gate: human (${(plan.gatesOpened || []).includes(i) ? "opened; the run continues past this level" : `the run pauses after level ${i} integrates; open it with plan.mjs gate open ${i} and resume the run with its id`})`);
    }
  });
  return out.join("\n");
}
