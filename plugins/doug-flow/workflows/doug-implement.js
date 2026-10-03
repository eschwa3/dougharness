export const meta = {
  name: 'doug-implement',
  description: 'Implement an approved Doug plan: one implementer per task in its own worktree, then verify, review, and integrate',
  whenToUse: 'After /doug-plan produced .doug/plan.json and the user approved it with /doug-approve. Pass the plan JSON as args.',
  phases: [
    { title: 'Implement', detail: 'one implementer per task, fresh context, own worktree (with swarm on, a lead splits a full-shape task into worker briefs, workers implement them in parallel, and the lead merges); a task marked reuse checks out its recorded branch instead; a task whose dependency did not integrate is never launched; a block the checks can describe is fixed in place until the task budget, the fix-attempt ceiling, a pass that made no new commit, or two consecutive passes raising a new blocker stops it' },
    { title: 'Verify', detail: 'a separate verifier runs the task command in the worktree on the first pass; a fix pass runs one focused check over the fix delta instead, and the full verifier again only when the verifier is the stage that blocked' },
    { title: 'Review', detail: 'spec compliance, then quality, against the diff on the first pass; on a fix pass the focused check carries scope and regression risk unless the reviewer is the stage that blocked; a task whose crew names two reviewers gets a second one in parallel with a distinct brief' },
    { title: 'Adversary', detail: 'codex-review (a different model, read-only) explores freely on the first pass and confirms the open findings on later passes, under one material blocker gate; when it cannot run, a Claude adversary on plan.adversary.fallback stands in; blockers stop integration' },
    { title: 'Integrate', detail: 'merge the level into the integration branch and run plan.verify' },
  ],
}

// ---- Guards ---------------------------------------------------------------
const plan = args
if (!plan || typeof plan !== 'object' || !Array.isArray(plan.tasks)) {
  throw new Error('doug-implement needs the plan object as args. Run: node <doug-flow>/scripts/plan.mjs json')
}
if (plan.status !== 'approved') {
  throw new Error(`Plan status is "${plan.status}", not "approved". Nothing implemented. Approve it first with /doug-approve.`)
}
const integrationBranch = plan.integrationBranch || `doug/${plan.tasks.map(t => t.id).join('-').slice(0, 40)}`
// Adversarial review by a second model. plan.adversary: false disables it; { command, timeoutMs, fallback } overrides the defaults.
// The command is @dougharness/codex's `codex-review` (on PATH when the package is installed; or "node <path>/dist/bin.js").
// When codex-review cannot review at all (Codex not installed, `codex exec` failed such as on a usage limit, timed out,
// or printed nothing parseable), a Claude adversary on adversary.fallback ({ model, effort }, default opus / high)
// reviews the change instead, so a missing Codex does not block the plan. fallback: false keeps the strict rule: a
// configured review that did not run blocks. For a review that ran, only a "fail" verdict or a blocker issue blocks.
const ADVERSARY_FALLBACK_MODEL = 'opus'
const ADVERSARY_FALLBACK_EFFORT = 'high'
// adversary.fallback resolved: false, or { model, effort } where "inherit" means the session model / the agent's own default effort.
function resolveFallback(cfg) {
  if (cfg === false) return false
  const o = cfg && typeof cfg === 'object' ? cfg : {}
  const model = o.model === 'inherit' ? undefined : o.model || ADVERSARY_FALLBACK_MODEL
  const effort = o.effort === 'inherit' ? undefined : o.effort || ADVERSARY_FALLBACK_EFFORT
  return { model, effort }
}
const adversaryConfig = plan.adversary && typeof plan.adversary === 'object' ? plan.adversary : {}
// A crew with two adversaries (card crew-sizing) seats the Claude adversary next to Codex: a different model, on the
// fallback row when the plan names one, on the fallback defaults otherwise (fallback: false only says a Codex that
// cannot run blocks; it does not choose the second seat's model).
const adversary = plan.adversary === false ? null : { command: 'codex-review', timeoutMs: 900000, ...adversaryConfig, fallback: resolveFallback(adversaryConfig.fallback), crewModel: resolveFallback(adversaryConfig.fallback === false ? {} : adversaryConfig.fallback) }
// How many times a blocked task may relaunch its implementer in the same worktree before the level stops. 0 disables the loop.
const fixAttempts = Number.isInteger(plan.fixAttempts) && plan.fixAttempts >= 0 ? plan.fixAttempts : 5
// Per-task ceilings for the whole loop, so a task that will not converge stops cheaply instead of spending a run on
// one card. Agents are counted here and always enforced; tokens and wall time come from the runtime's budget
// primitive and are enforced only when it reports them. plan.budget overrides any of the three. Keep these three
// numbers equal to lib/plan.mjs's DEFAULT_BUDGET.
const DEFAULT_BUDGET = { agents: 12, tokens: 400000, wallMinutes: 40 }
const taskBudget = { ...DEFAULT_BUDGET, ...(plan.budget && typeof plan.budget === 'object' ? plan.budget : {}) }
// The phrase the verifier and reviewer put at the start of a finding when the spec cannot satisfy the plan's
// acceptance criteria. Such a block goes back to the planner and is never retried.
const CONTRADICTION_MARKER = 'SPEC CONTRADICTS ACCEPTANCE'
// Why a task stopped: every halt site sets one of these as stopClass beside its prose stopReason. Kept equal to
// STOP_CLASSES in lib/board.mjs by a template test (this file may not import).
const STOP_CLASSES = ['implementer-blocked', 'partial', 'stage-missing', 'spec-contradiction', 'environment', 'adversary-not-run', 'outside-owned', 'new-blockers-twice', 'fix-attempts-exhausted', 'stalled', 'budget', 'no-new-commit', 'dependency-skipped', 'stage-threw', 'level-adversary']
// The phrase a verifier, checker, or size-check puts at the start of a finding when a command could not run for
// an environment reason (a tool missing from the worktree even after the install step, a sandbox denial) rather
// than a defect in the diff. The fix loop never retries such a finding (card reused-s-task-worktree-install):
// retriable() stops on it the same way it stops on CONTRADICTION_MARKER.
const ENVIRONMENT_MARKER = 'ENVIRONMENT ONLY'
// The one rule about commit messages, in every prompt that commits or checks commits: this repository records
// attribution nowhere in git, and plan.mjs land refuses a branch that carries either trailer.
const NO_TRAILERS = 'Commit messages carry no attribution trailers: no Co-Authored-By line and no Claude-Session line, whatever your defaults say. A commit with either is a finding and the plan cannot land.'
// The one rule about a partial result, in every prompt a worker (or a resumed worker) can end with one from
// (card worker-context-handoff): quotes the harness's context notice (a PostToolUse hook in plugins/doug-gates) so
// a worker knows partial=true is only for a worker the harness itself told to stop, never a first resort, and only
// at a boundary, with a handoff. Keep this identical everywhere it appears; the template tests assert it.
const PARTIAL_RULE = 'Return partial=true only after a hook told you "[doug] Worker context at <pct>% of <window> tokens": stop at a boundary (finish the file you are on and its named test, then commit), then return partial=true with a handoff (completed, remaining, next, verify). Do not start another file. Without that notice, partial=true is refused at your stop.'
// The one sentence about a partial branch, in the two prompts that merge or integrate branches: a partial is
// graceful degradation, never a finished result, so it is never the thing that lands.
const PARTIAL_NEVER_MERGED = 'A branch whose worker or task result was partial is never merged; if you find one in the list below, stop and report it as a block.'

// Pipeline shape by task size (decision 0005 point 3). An S task runs implement, then one focused check on the verify
// row that does the verifier's and the reviewer's work, and no adversary of its own; the adversary reviews a level's S
// tasks together, on the integration branch, after the merge, and a blocker there goes back to the task that owns the
// file as a fix pass. M, L, and an unsized task keep the full shape.
function taskShape(task) {
  return task && task.size === 'S' ? 'S' : 'full'
}
function adversaryRequired(task) {
  return !!adversary && taskShape(task) !== 'S'
}
const INTEGRATION_WORKTREE = '.claude/worktrees/doug-integration'

// What an adversarial reviewer may call a blocker. The same text is in the two adversary agent files and in
// codex-review's own prompt; change all four together.
const BLOCKER_GATE = [
  'What counts as a blocker: a blocker must demonstrate either a failure of a spec sentence or acceptance criterion, which you quote, or a violation of a repository invariant: safety, security, data integrity, public compatibility, or required verification (a verify or acceptance command that exits non-zero).',
  'It must be caused by this diff, on a supported or reasonably foreseeable input, and carry a reproduction: a command you ran (an entry in commandsRun) whose exit code or quoted output shows the failure; a finding from static inspection alone, with no command that demonstrates it, is major at most.',
  'A test-coverage gap against the spec (a requirement without a test, an assertion missing) is major and never a blocker: the reviewer owns spec compliance, so say so in the issue.',
  'An input the spec names as unsupported, or a pathological input no supported caller produces, is at most minor.',
  'This is not a downgrade of destructive behavior: a change that deletes, overwrites, or corrupts data the spec did not name is a blocker under data integrity even when no spec sentence forbids it.',
  'A `fail` verdict requires at least one `blocker` issue: an issue that is only `major` or `minor` is reported with a `pass` verdict, and a review whose findings are all advisory passes with notes.',
]

// Normalizes plan.acceptance (prose strings or { text, command } objects) into { text, command } pairs,
// command null when the entry carries none. Mirrors lib/plan.mjs's export; inlined because the workflow cannot import it.
function acceptanceEntries(list) {
  return Array.isArray(list) ? list.map(a => (typeof a === 'string' ? { text: a, command: null } : a && typeof a === 'object' ? { text: String(a.text), command: typeof a.command === 'string' && a.command.trim() ? a.command : null } : { text: String(a), command: null })) : []
}

// ---- Model tiers -------------------------------------------------------------
// `plan.mjs json` resolves the CLAUDE.md Models table into plan.models.roles and each task's model/effort.
// "inherit" means: model = the session model, effort = this workflow's default for the role.
const DEFAULT_EFFORT = { lead: undefined, worker: undefined, implement: undefined, verify: 'high', review: 'high', adversary: 'low', integrate: 'high', supervise: 'low' }
const roleModels = (plan.models && plan.models.roles) || {}
// The adversary row may name "codex": the review runs on Codex (plan.adversary.command) and the Claude agent
// that launches it and relays the verdict is only a relay, so it runs on haiku. `relay` is that agent's model.
const ADVERSARY_RELAY_MODEL = 'haiku'
// Checking out a reused branch is mechanical, so it runs on the same small model as the adversary relay.
const CHECKOUT_MODEL = ADVERSARY_RELAY_MODEL
// The fix-loop supervisor (card fix-loop-supervisor) runs on the `cheap` tier of the Models table; a table without
// one puts it on the relay model, since reading a task's passes and writing a brief is small work.
const SUPERVISOR_FALLBACK_MODEL = ADVERSARY_RELAY_MODEL
function tierFor(role, task) {
  const src = role === 'implement' && task
    ? { model: task.model, effort: task.effort }
    : role === 'supervise'
      ? (plan.models && plan.models.tiers && plan.models.tiers.cheap) || { model: SUPERVISOR_FALLBACK_MODEL }
      : roleModels[role] || {}
  const model = src.model && src.model !== 'inherit' ? src.model : undefined
  const effort = src.effort && src.effort !== 'inherit' ? src.effort : DEFAULT_EFFORT[role]
  if (role === 'adversary' && model === 'codex') return { model, effort, relay: ADVERSARY_RELAY_MODEL }
  return { model, effort }
}
function agentOpts(role, task, extra) {
  const t = tierFor(role, task)
  const opts = { ...extra }
  if (t.relay) opts.model = t.relay
  else if (t.model) opts.model = t.model
  if (t.effort) opts.effort = t.effort
  return opts
}
function describeTier(role, task) {
  const t = tierFor(role, task)
  const out = { model: t.model || 'inherit', effort: t.effort || 'inherit' }
  if (t.relay) out.relay = t.relay
  return out
}
// codex-review accepts minimal|low|medium|high|xhigh (packages/doug-codex/src/schema.ts REASONING_EFFORTS); the Models
// table also allows max, which maps to xhigh, Codex's highest documented level. A plan's own adversary.effort wins over
// the row; a value outside this map passes no --effort, so the review runs at Codex's configured default.
const CODEX_REASONING_EFFORT = { minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'xhigh' }
if (adversary) adversary.effort = CODEX_REASONING_EFFORT[adversary.effort || tierFor('adversary').effort]

// ---- Levelization (same algorithm as lib/plan.mjs; scripts cannot import files) ----
function levelize(tasks) {
  const byId = new Map(tasks.map(t => [t.id, t]))
  const level = new Map()
  const visiting = new Set()
  function depth(id, chain) {
    if (level.has(id)) return level.get(id)
    if (visiting.has(id)) throw new Error(`dependency cycle: ${[...chain, id].join(' -> ')}`)
    visiting.add(id)
    let d = 0
    for (const dep of byId.get(id).dependsOn || []) d = Math.max(d, depth(dep, [...chain, id]) + 1)
    visiting.delete(id)
    level.set(id, d)
    return d
  }
  for (const t of tasks) depth(t.id, [])
  const max = Math.max(...level.values())
  const out = []
  for (let i = 0; i <= max; i++) out.push(tasks.filter(t => level.get(t.id) === i))
  return out
}

// ---- Schemas ----------------------------------------------------------------
const IMPLEMENT_SCHEMA = {
  type: 'object',
  required: ['taskId', 'branch', 'worktreePath', 'filesTouched', 'commandsRun', 'summary', 'blocked', 'commit'],
  properties: {
    taskId: { type: 'string' },
    branch: { type: 'string', description: 'git branch name holding the work' },
    worktreePath: { type: 'string', description: 'absolute path of the worktree' },
    filesTouched: { type: 'array', items: { type: 'string' } },
    commandsRun: { type: 'array', items: { type: 'object', required: ['command', 'ok'], properties: { command: { type: 'string' }, ok: { type: 'boolean' } } } },
    summary: { type: 'string' },
    blocked: { type: 'boolean' },
    blockedReason: { type: 'string' },
    commit: { type: 'string', description: 'git rev-parse HEAD in the worktree after committing' },
    partial: { type: 'boolean', description: 'true when the worker stopped at a boundary rather than finishing, after the harness measured its context and told it to' },
    handoff: {
      type: 'object',
      description: 'present when partial is true: what a fresh worker needs to pick the remaining work up',
      properties: {
        completed: { type: 'array', items: { type: 'string' } },
        remaining: { type: 'array', items: { type: 'string' } },
        next: { type: 'string' },
        verify: { type: 'string' },
      },
    },
  },
}
// The lead's split of one task into worker briefs (card swarm-lead): each brief owns a disjoint subset of the task's
// files; the workflow refuses a brief that names anything else, because the lead may split, never widen.
const LEAD_SCHEMA = {
  type: 'object',
  required: ['taskId', 'branch', 'worktreePath', 'briefs', 'blocked', 'splitReason'],
  properties: {
    taskId: { type: 'string' },
    branch: { type: 'string', description: 'the task branch the lead created; the workers branch from it and the lead merges back into it' },
    worktreePath: { type: 'string', description: 'absolute path of the lead worktree' },
    briefs: { type: 'array', items: { type: 'object', required: ['id', 'title', 'spec', 'files'], properties: { id: { type: 'string' }, title: { type: 'string' }, spec: { type: 'string' }, files: { type: 'array', items: { type: 'string' } }, verify: { type: ['string', 'null'] } } } },
    blocked: { type: 'boolean' },
    blockedReason: { type: 'string' },
    // Card swarm-topology (candidate 2): why the task split the way it did, or why one brief is right when it did
    // not split. Required so the report can tell "unsplittable" from "did not try".
    splitReason: { type: 'string', description: 'why the task split into these briefs, or why one brief is right when it did not split' },
    // Card swarm-topology (candidate 3): the names, signatures, and files each brief exports or consumes, written
    // once by the lead at split time; optional because a single-brief task has nothing to cross-reference.
    interfaces: { type: 'string', description: 'the interfaces each brief exports or consumes, for every worker prompt' },
  },
}
const VERIFY_SCHEMA = {
  type: 'object',
  required: ['taskId', 'passed', 'commandsRun', 'findings', 'acceptance', 'head'],
  properties: {
    taskId: { type: 'string' },
    passed: { type: 'boolean' },
    commandsRun: { type: 'array', items: { type: 'object', required: ['command', 'ok'], properties: { command: { type: 'string' }, ok: { type: 'boolean' }, outputTail: { type: 'string' } } } },
    findings: { type: 'array', items: { type: 'string' } },
    findingFiles: { type: 'array', description: 'one entry per finding that fails the task and names a file: the finding text and the worktree-relative paths of existing repository files it concerns; never a fixture, scratch, or temp path; [] when none', items: { type: 'object', required: ['finding', 'files'], properties: { finding: { type: 'string' }, files: { type: 'array', items: { type: 'string' } } } } },
    acceptance: { type: 'array', description: 'one entry per acceptance command listed in the prompt, [] when none', items: { type: 'object', required: ['text', 'command', 'ok', 'exitCode'], properties: { text: { type: 'string' }, command: { type: 'string' }, ok: { type: 'boolean' }, exitCode: { type: ['integer', 'null'] } } } },
    head: { type: 'string', description: 'the full 40-character output of git rev-parse HEAD in the worktree on the task branch, read before anything else runs' },
  },
}
const REVIEW_SCHEMA = {
  type: 'object',
  required: ['taskId', 'specCompliant', 'inScope', 'approve', 'issues'],
  properties: {
    taskId: { type: 'string' },
    specCompliant: { type: 'boolean' },
    inScope: { type: 'boolean', description: 'every changed file is in the task\'s owned files' },
    approve: { type: 'boolean' },
    issues: { type: 'array', items: { type: 'object', required: ['severity', 'file', 'description'], properties: { severity: { type: 'string', enum: ['blocker', 'major', 'minor'] }, file: { type: 'string' }, description: { type: 'string' } } } },
  },
}
// The one focused check that stands in for the verifier and the reviewer on a fix pass: it runs the commands and
// reviews only the fix delta, so its result carries both a verifier's and a reviewer's fields.
const CHECK_SCHEMA = {
  type: 'object',
  required: ['taskId', 'passed', 'commandsRun', 'acceptance', 'findings', 'issues', 'inScope', 'head'],
  properties: {
    taskId: { type: 'string' },
    passed: { type: 'boolean' },
    commandsRun: { type: 'array', items: { type: 'object', required: ['command', 'ok'], properties: { command: { type: 'string' }, ok: { type: 'boolean' }, outputTail: { type: 'string' } } } },
    acceptance: { type: 'array', description: 'one entry per acceptance command listed in the prompt, [] when none', items: { type: 'object', required: ['text', 'command', 'ok', 'exitCode'], properties: { text: { type: 'string' }, command: { type: 'string' }, ok: { type: 'boolean' }, exitCode: { type: ['integer', 'null'] } } } },
    findings: { type: 'array', items: { type: 'string' } },
    findingFiles: { type: 'array', description: 'one entry per finding that fails the task and names a file: the finding text and the worktree-relative paths of existing repository files it concerns; never a fixture, scratch, or temp path; [] when none', items: { type: 'object', required: ['finding', 'files'], properties: { finding: { type: 'string' }, files: { type: 'array', items: { type: 'string' } } } } },
    issues: { type: 'array', items: { type: 'object', required: ['severity', 'file', 'description'], properties: { severity: { type: 'string', enum: ['blocker', 'major', 'minor'] }, file: { type: 'string' }, line: { type: ['integer', 'null'] }, description: { type: 'string' }, evidence: { type: ['string', 'null'] } } } },
    inScope: { type: 'boolean', description: 'every file the fix delta changed is in the task\'s owned files' },
    head: { type: 'string', description: 'the full 40-character output of git rev-parse HEAD in the worktree on the task branch, read before anything else runs' },
  },
}
// The supervisor's brief for a stalled fix loop. No verdict field: the supervisor cannot pass or fail anything.
const SUPERVISE_SCHEMA = {
  type: 'object',
  required: ['taskId', 'brief', 'directions'],
  properties: {
    taskId: { type: 'string' },
    brief: { type: 'string', description: 'what the passes tried and what failed each time, from the evidence given; a few sentences' },
    directions: { type: 'array', minItems: 2, maxItems: 3, items: { type: 'string' }, description: 'two or three alternative directions for the next fix pass, each different from what the passes tried' },
  },
}
const ADVERSARY_SCHEMA = {
  type: 'object',
  required: ['taskId', 'ran', 'verdict', 'summary', 'issues', 'commandsRun', 'error'],
  properties: {
    taskId: { type: 'string' },
    ran: { type: 'boolean', description: 'true only if codex-review printed parseable JSON, or the fallback adversary reviewed the change itself' },
    verdict: { type: 'string', enum: ['pass', 'fail', 'inconclusive'] },
    summary: { type: 'string' },
    issues: { type: 'array', items: { type: 'object', required: ['severity', 'file', 'description'], properties: { severity: { type: 'string', enum: ['blocker', 'major', 'minor'] }, file: { type: 'string' }, line: { type: ['integer', 'null'] }, description: { type: 'string' }, evidence: { type: ['string', 'null'] } } } },
    commandsRun: { type: 'array', items: { type: 'object', required: ['command', 'ok'], properties: { command: { type: 'string' }, ok: { type: 'boolean' }, exitCode: { type: ['integer', 'null'] }, outputTail: { type: 'string', description: 'the last lines of the command output, so a blocker can quote one' } } } },
    error: { type: ['string', 'null'], description: 'error.kind and message from codex-review when the review could not run; null otherwise' },
    usage: { type: ['object', 'null'], properties: { inputTokens: { type: 'integer' }, outputTokens: { type: 'integer' } }, description: 'ReviewResult.usage copied from codex-review; null when it printed none or the fallback reviewed' },
    durationMs: { type: ['integer', 'null'], description: 'ReviewResult.durationMs copied from codex-review; null otherwise' },
  },
}
const INTEGRATE_SCHEMA = {
  type: 'object',
  required: ['branch', 'merged', 'conflicts', 'verify', 'ok'],
  properties: {
    branch: { type: 'string' },
    merged: { type: 'array', items: { type: 'string' } },
    conflicts: { type: 'array', items: { type: 'string' } },
    verify: { type: 'array', items: { type: 'object', required: ['command', 'ok'], properties: { command: { type: 'string' }, ok: { type: 'boolean' }, outputTail: { type: 'string' } } } },
    ok: { type: 'boolean' },
    // Card integration-acceptance-recorded: only the last level's integrate stage fills this in (step 3b of
    // integratePrompt); not required, since an earlier level has not built the whole plan yet.
    acceptance: { type: 'array', description: 'one entry per acceptance command listed in the prompt, [] when none', items: { type: 'object', required: ['text', 'command', 'ok', 'exitCode'], properties: { text: { type: 'string' }, command: { type: 'string' }, ok: { type: 'boolean' }, exitCode: { type: ['integer', 'null'] } } } },
  },
}

// Card integration-acceptance-recorded (round 2): routes an integrate stage's raw result through the same
// acceptance rule the verifier applies per task, but only on the last level (earlier levels have not built the
// whole plan yet). Matching is by trimmed command string, not object identity or spelling, since an agent may
// legitimately report a command behind a cd or git -C prefix; the result's `command` is always the plan's own
// spelling (its `text` is whatever the matched item reported). A reported item that matches no plan command
// (empty, prose, or unrecognised) is dropped rather than trusted or blamed. A plan command with no matching
// report is appended as { ..., reported: false } - unreported and failed are different causes and get different
// reason clauses. Pure: never mutates its argument, never throws on odd shapes.
function enforceIntegrationAcceptance(integration, isLastLevel, entries) {
  if (!integration || typeof integration !== 'object') return integration
  if (!isLastLevel) {
    const rest = { ...integration }
    delete rest.acceptance
    return rest
  }
  const reported = Array.isArray(integration.acceptance) ? integration.acceptance.filter(a => a && typeof a === 'object') : []
  const acceptance = []
  for (const e of entries) {
    if (!e.command) continue
    const wantCommand = String(e.command).trim()
    if (!wantCommand) continue
    const match = reported.find(a => typeof a.command === 'string' && String(a.command).trim() === wantCommand)
    acceptance.push(match
      ? { text: match.text, command: e.command, ok: match.ok, exitCode: match.exitCode }
      : { text: e.text, command: e.command, ok: false, exitCode: null, reported: false })
  }
  const failed = acceptance.filter(a => a.reported === undefined && a.ok !== true)
  const notReported = acceptance.filter(a => a.reported === false)
  const parts = []
  if (failed.length) parts.push('acceptance command failed: ' + failed.map(a => `${a.text} ($ ${a.command}, exit ${a.exitCode})`).join('; '))
  if (notReported.length) parts.push('acceptance command not reported: ' + notReported.map(a => `${a.text} ($ ${a.command})`).join('; '))
  if (!parts.length) return { ...integration, acceptance }
  return { ...integration, acceptance, ok: false, reason: parts.join('; ') }
}

// ---- Finding ledger ----------------------------------------------------------
// One list per task of every blocking finding the stages raised, with a stable id. It is what the fix agent is
// given (so a later pass cannot undo an earlier fix without noticing), what the confirmation adversary is asked to
// confirm, and how the loop decides whether a pass raised anything new.
// Card ledger-ignores-not-a-defect-notes: a checking stage's own words can say a note is not a defect, or that it
// names a file outside this task's owned list; such a note is dropped before matching, never becomes a ledger
// entry, and is recorded on the attempt instead, so it can no longer keep a converged task out of integration.
const LEDGER_CHAR_BUDGET = 8000

// Stage, file and the shape of the text, so the same complaint worded slightly differently still matches.
function fingerprint(stage, file, text) {
  const path = String(file == null ? '' : file).trim().replace(/^\.\//, '')
  const body = String(text == null ? '' : text)
    .toLowerCase()
    .replace(/:\d+/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, 80)
  return `${stage}|${path}|${body}`
}

// The repository invariant an adversary issue is about, from its own words.
function adversaryInvariant(text) {
  const t = String(text == null ? '' : text).toLowerCase()
  if (t.includes('security')) return 'security'
  if (/data loss|data integrity|corrupt|destructive|delete|overwrite/.test(t)) return 'data-integrity'
  if (t.includes('compatibility')) return 'compatibility'
  if (t.includes('verification')) return 'verification'
  return 'spec'
}

// The first repo-relative path a free-text finding names, so a verifier finding still lands on a file.
function findingFile(text) {
  const m = String(text == null ? '' : text).match(/(?<![\w./-])(?:[\w.-]+\/)+[\w.-]+\.[A-Za-z0-9]+/)
  return m ? m[0].replace(/^\.\//, '') : ''
}

// Every repo-relative path a free-text finding names, for the ledger's file rule (round 2 rule 2, MAJ2: the file
// rule must read every path the finding names, not just findingFile's first match). When `findingFiles` carries an
// entry for this exact finding (trimmed match) whose `files` array is non-empty, that entry's files are
// authoritative and win outright over the prose (round 3 rule 2, MIN1: an empty files array is not authoritative -
// it falls back to the prose scan below, the same as no entry at all); otherwise every slash-separated token
// ending in an extension in the text, leading './' stripped, deduped.
function findingTextPaths(text, findingFilesList) {
  const trimmed = String(text == null ? '' : text).trim()
  const listed = (findingFilesList || []).find(e => e.finding.trim() === trimmed)
  if (listed && listed.files.length) return listed.files.map(p => String(p).trim().replace(/^\.\//, '')).filter(Boolean)
  const seen = new Set()
  for (const m of String(text == null ? '' : text).matchAll(/(?<![\w./-])(?:[\w.-]+\/)+[\w.-]+\.[A-Za-z0-9]+/g)) seen.add(m[0].replace(/^\.\//, ''))
  return [...seen]
}

// What one stage reported on a pass, or null when that stage produced nothing to read. `blocking` marks the
// findings that keep the task out of integration; the rest are recorded only so a re-report can reopen a fixed entry.
// 'level-adversary' is the level's review of a size-S task, read and recorded as the adversary stage.
function stageFindings(r, stageKey) {
  const stage = stageKey === 'level-adversary' ? 'adversary' : stageKey
  const res = (r.stageResults || {})[stageKey]
  if (!res) return null
  const out = []
  if (stage === 'verify' || stage === 'check') {
    // The check stands in for both the verifier and the reviewer, so it blocks on everything the projected pair
    // blocks on: a failed command run, a file outside the owned list, or a blocker issue. Reading only `passed`
    // would drop a blocker issue raised on an otherwise passing run out of the ledger, and the next fix pass
    // would never be told about the very thing that blocked it.
    const blocking = stage === 'check'
      ? !res.passed || res.inScope === false || (res.issues || []).some(i => i.severity === 'blocker')
      : !res.passed
    const findingFilesList = Array.isArray(res.findingFiles) ? res.findingFiles.filter(e => e && typeof e.finding === 'string' && Array.isArray(e.files)) : []
    for (const f of res.findings || []) {
      if (typeof f !== 'string') continue
      // source 'finding' (card ledger-check-notes-as-blockers): marks a check's free-text finding, as opposed to a
      // check `issues` entry below (which carries no source), so droppedWhy can gate only the former on failure wording.
      out.push({ stage, blocking, severity: 'blocker', invariant: 'verification', file: findingFile(f), line: null, description: f, evidence: null, confirms: !blocking, paths: findingTextPaths(f, findingFilesList), source: 'finding' })
    }
    if (stage === 'check') {
      // Round 3 rule 2, MIN2: the check stands in for the reviewer, so a check issue gets invariant 'scope' when
      // the check itself read the run as out of scope, the same mark a reviewer's own scope finding carries.
      const checkInvariant = res.inScope === false ? 'scope' : 'verification'
      for (const i of res.issues || []) out.push({ stage, blocking: blocking && i.severity === 'blocker', severity: i.severity, invariant: checkInvariant, file: i.file || '', line: i.line || null, description: i.description, evidence: i.evidence || null, paths: i.file ? [i.file] : [] })
    }
    return out
  }
  if (stage === 'review') {
    const blocking = !res.approve
    const invariant = res.specCompliant === false ? 'spec' : res.inScope === false ? 'scope' : 'quality'
    for (const i of res.issues || []) out.push({ stage, blocking, severity: i.severity, invariant, file: i.file || '', line: i.line || null, description: i.description, evidence: i.evidence || null, paths: i.file ? [i.file] : [] })
    return out
  }
  if (stage === 'adversary') {
    if (!res.ran) return null
    const blockers = (res.issues || []).filter(i => i.severity === 'blocker')
    // A fail verdict blocks only with a blocker issue, or with no issue at all (card fix-loop-minor-verdict).
    // Before this, a fail with only major or minor issues still synthesized a blocking finding from the summary
    // below (the same synthesis the empty-issues case still uses), so the fix pass was briefed with one
    // un-actionable prose finding naming no file or line, not zero findings; it could not act on it, made no
    // commit, and the task never converged. Such a fail is pass-with-notes instead and does not block.
    const blocked = blockers.length > 0 || (res.verdict === 'fail' && !(res.issues || []).length)
    for (const i of res.issues || []) out.push({ stage, blocking: blocked && i.severity === 'blocker', severity: i.severity, invariant: adversaryInvariant(i.description), file: i.file || '', line: i.line || null, description: i.description, evidence: i.evidence || null })
    if (blocked && !blockers.length) out.push({ stage, blocking: true, severity: 'blocker', invariant: adversaryInvariant(res.summary), file: '', line: null, description: res.summary, evidence: null })
    return out
  }
  return null
}

// An explicit id prefix wins over the fingerprint: that is how a stage re-reports another stage's finding.
function matchFinding(ledger, f) {
  const m = /^(F\d+)\b/.exec(String(f.description == null ? '' : f.description).trim())
  if (m) {
    const byId = ledger.find(e => e.id === m[1])
    if (byId) return byId
  }
  const fp = fingerprint(f.stage, f.file, f.description)
  return ledger.find(e => e.fingerprint === fp) || null
}

// What a finding that starts with a ledger id says about it, read from its first clause: 'fixed' ("F3 fixed: ...",
// "F3 is FIXED.", "F3: no longer returns 1"), 'waived', 'open' ("F3: still returns 1", "F3 is not fixed"), or null
// when the text names the id without saying any of those. A confirmation is never a re-report; without this, a
// checking stage that confirms a fix in the words the prompts ask for reopens the very entry it confirmed.
//
// 'waived' (round 2, R2) is read after stripping, from the start of the clause, any leading ':'/','/'-'/whitespace,
// then an optional copula ('is still', 'is', 'was', 'remains', 'stays', or bare 'still'), then an optional article
// ('a'/'an'). What remains must then itself START with one of: 'waived', 'advisory', 'non-blocking' (hyphen or
// space optional, or none: 'non blocking'/'nonblocking'), 'not counted open', or 'unchanged (' - the last only when
// the clause also names 'non-blocking' or 'nit' somewhere else (the real string with 'waived' swapped for
// 'unchanged'), so a bare, unrelated "unchanged (...)" note never reads as a waiver. Only that exact start counts:
// "F2 was wrongly waived: ..." and "F2: the implementer waived this, but I disagree - ..." say the word only
// mid-clause and never reach this branch (mutation MR2a: dropping the anchor and matching 'waived' anywhere would
// misread both as waived, and a live blocker would integrate). A negation of 'waived' itself ('is not waived',
// 'cannot be waived', 'should not be waived', 'not waived') needs no separate handling: 'not'/'cannot'/'should' are
// none of the copulas this strips, so the remainder never begins with a recognised word and the clause falls through
// to the open-word test on its own 'not'.
//
// Card d-waiver-structural-rule: idReport reads 'waived' from the clause's own wording alone and is otherwise a pure
// text reader - it does not know the ledger, so it cannot itself tell a disputed waiver from an honoured one. A
// wording veto (mutation MR2c) once cancelled the waived reading back to 'open' when the clause also contained
// 'but', 'wrongly', 'disagree', or 'now required'; the reviewer then found 12 of 12 other disputing phrasings
// ("F2 waived incorrectly: still returns 1.") that veto never covered. Whether a 'waived' verdict is honoured is now
// decided structurally, against the ledger entry's own recorded description (confirmsFinding below), never by any
// word idReport can see.
function idReport(text) {
  const m = /^\s*(F\d+)\b(.*)$/s.exec(String(text == null ? '' : text))
  if (!m) return null
  // A sentence ends at a period followed by whitespace or the end, so a file name like agents.ts does not end it.
  const clause = m[2].split(/[;\n]|\.(?=\s|$)/)[0].toLowerCase()
  const rest = clause.replace(/^[\s:,-]*(?:(?:is\s+still|is|was|remains|stays|still)\s+)?(?:(?:a|an)\s+)?/, '')
  const waivedStart = /^(?:waived\b|advisory\b|non[\s-]?blocking\b|not\s+counted\s+open\b|unchanged\s*\()/
  const unchangedMissingContext = /^unchanged\s*\(/.test(rest) && !/non[\s-]?blocking|\bnit\b/.test(clause)
  if (waivedStart.test(rest) && !unchangedMissingContext) return { id: m[1], verdict: 'waived' }
  const open = /\b(not|still|unfixed|partially|remains|regress\w*|reappear\w*|broken|fails?|isn't|wasn't|hasn't)\b/
  const done = /\b(fixed|resolved|addressed|no longer)\b/
  const at = clause.search(done)
  if (at >= 0 && !open.test(clause.slice(0, at))) return { id: m[1], verdict: 'fixed' }
  if (open.test(clause)) return { id: m[1], verdict: 'open' }
  return { id: m[1], verdict: null }
}

// A stage confirms a finding when it says so, when it passed and its free-text findings name the id without saying
// the finding is still open, when the finding's own text says 'fixed', or when it says 'waived' AND the ledger's own
// recorded entry for that id is itself a self-declared non-blocking note (card d-waiver-structural-rule:
// selfDeclaredNonBlocking, checked against the entry's own description, never the finding's own wording). Any other
// waived claim - the entry blocking, the entry missing, or no ledger passed at all - does not confirm: it is a
// re-report exactly like an 'open' verdict, so it can reopen a fixed entry or hold an open one open, whatever the
// reporting finding's own `confirms`/`blocking` flags say. Only a re-report can reopen or keep an entry.
function confirmsFinding(f, ledger) {
  const r = idReport(f.description)
  if (r && r.verdict === 'fixed') return true
  if (r && r.verdict === 'waived') {
    const entry = Array.isArray(ledger) ? ledger.find(e => e.id === r.id) : null
    return !!entry && selfDeclaredNonBlocking(entry.description)
  }
  return !!f.confirms && !(r && r.verdict === 'open')
}

// Two paths name the same file when they are equal, when one is the other shortened from the left (a verifier
// writes lib/secret-rules.mjs for plugins/doug-gates/lib/secret-rules.mjs), or when the first is a directory the
// second is under. Copied verbatim from samePath (workflow line ~1447): the ledger section is evaluated on its
// own by ledgerModule() and cannot import it.
function ledgerSamePath(owned, p) {
  return owned === p || owned.endsWith('/' + p) || p.endsWith('/' + owned) || p.startsWith(owned + '/')
}

// True when p (leading './' stripped) is one of task's owned files, by ledgerSamePath.
function pathOwned(p, task) {
  if (!task || !Array.isArray(task.files)) return false
  return task.files.some(owned => ledgerSamePath(String(owned).trim().replace(/^\.\//, ''), p))
}

// True when p is owned, or under the two directories every task may always touch.
function pathProtected(p, task) {
  return p.startsWith('.doug/') || p.startsWith('.claude/') || pathOwned(p, task)
}

// The failure words a text-rule match must be checked against (round 3 rule 5 guard): idReport's own `open` word
// list, reused, plus 'never' (idReport never needed it - a re-report never says a fix "never" held - but a fresh
// criterion-failure or waits-on report often does: "the process never exits.").
const FAILURE_WORD = /\b(not|still|unfixed|partially|remains|regress\w*|reappear\w*|broken|fails?|isn't|wasn't|hasn't|never)\b/i

// Card ledger-check-notes-as-blockers (run wf_2f62b9d5-3b5, task release-script pass 2): the failure words a
// check-stage `finding` (never an `issues` entry - those open on severity alone) must carry to open a blocker at
// all. Two real, positive check notes ('Fix delta ... touches only tests/release.test.mjs, which is owned' and
// 'Nothing is published: no npm publish or pnpm publish invocation ...') carried none of these and still opened
// phantom blockers F3/F4, stopping the run after two of five fix attempts. FAILURE_WORD above plus the failure
// vocabulary a real check report uses that list lacks: failed/failing/failure, throws/threw/throw, error(s),
// exit(s|ed) (a non-zero exit is always reported as a number after this word), non-zero/nonzero, missing, wrong,
// crash*, expected (as in "Expected: a problem line, never a throw."), return(s|ed) (a check reporting a wrong
// return value, "src/x.ts returns 1" with no other qualifier, is a bare defect report, not a confirmation - the
// pre-existing size-S loop-mechanics fixture at that exact text). Round 2 (reviewer: real check failure reports
// without a listed word were being dropped) widens it again with: doesn't/don't/didn't/can't/cannot/won't, lacks/
// lacking, unmet, hangs/hung, dead. Deliberately NOT added: 'no', 'red', or 'trailer' - T2's f6 ("carries no
// attribution trailer") and TA's own dropped notes ("No assertions were removed", "Nothing is published: no npm
// publish...") are genuine confirmations that must stay dropped as check-notes, and any of those three words would
// wrongly keep them open. A separate regex, not an extension of FAILURE_WORD itself: idReport and
// hasUnguardedMatch's own guard read FAILURE_WORD and must keep its narrower, re-report-tuned list unchanged.
const CHECK_NOTE_FAILURE_WORD = /\b(not|still|unfixed|partially|remains|regress\w*|reappear\w*|broken|fails?|isn't|wasn't|hasn't|never|failed|failing|failure|throws?|threw|errors?|exit(?:s|ed)?|non-?zero|missing|wrong|crash\w*|expected|returns?|returned|doesn't|don't|didn't|can't|cannot|won't|lacks?|lacking|unmet|hangs?|hung|dead)\b/i

// The sentence containing text[atIndex], bounded the way idReport bounds a clause: ';', a newline, or a period
// followed by whitespace or the end. Used by the round 3 failure-word guard, which reads the whole sentence a
// candidate match sits in, not just the text up to the match, so a failure word appearing after the match (a
// waits-on clause followed by "...and the process never exits.") still guards it.
function sentenceContaining(text, atIndex) {
  const BOUNDARY = /[;\n]|\.(?=\s|$)/g
  let start = 0
  let m
  while ((m = BOUNDARY.exec(text))) {
    if (atIndex <= m.index) return text.slice(start, m.index)
    start = m.index + m[0].length
  }
  return text.slice(start)
}

// The verify/check prompts only ask a stage to name the criterion in a finding (2b: "a finding that names the
// criterion"), not to quote it - the three 2026-09-18 run fixtures just happen to show stages single-quoting the
// criterion name in a verdict ("Acceptance criterion 'X' holds: ..."), a stage habit this blanking relies on, not a
// prompt contract. A failure word that happens to sit inside that quoted name (a criterion about something that
// "never" happens) describes the criterion, not the stage's verdict on it, and must not guard a drop against the
// stage's own "holds:" (wf_9fec46f1 F3: 'Every step ... states both what it writes and what it never does'). Only
// the single-quoted span immediately after the word 'criterion' is blanked, so a contraction like "isn't" elsewhere
// in the sentence is untouched; a criterion name in double quotes or with none at all is not blanked, so a failure
// word inside it still guards the match and the note is kept - the safe direction when the habit does not hold.
function stripCriterionQuote(text) {
  return text.replace(/(\bcriterion\b[^'\n]{0,60})'[^'\n]*'/gi, "$1''")
}

// True when some match of `regex` in `text` sits in a sentence carrying no FAILURE_WORD outside a quoted criterion
// name - the case rule 5b/5c drops on. A match whose sentence does carry one (a criterion FAILURE report that also
// says 'holds', a real waits-on report that also says the process 'never' exits) is guarded and never counted here.
function hasUnguardedMatch(text, regex) {
  const g = new RegExp(regex.source, regex.flags.includes('g') ? regex.flags : regex.flags + 'g')
  let m
  while ((m = g.exec(text))) {
    if (!FAILURE_WORD.test(stripCriterionQuote(sentenceContaining(text, m.index)))) return true
    if (m.index === g.lastIndex) g.lastIndex += 1
  }
  return false
}

// True when text itself opens by declaring the issue non-blocking, in one of the shapes droppedWhy recognises: a
// leading "Non-blocking nit/note/observation/comment/remark", "Non-blocking: ..." or "Non-blocking - ...", "Minor,
// non-blocking nit: ...", "Nit (non-blocking): ...", or "[non-blocking] ..." (hyphen, space, or nothing:
// "non-blocking", "non blocking", "nonblocking"). Lifted out of droppedWhy (card d-waiver-structural-rule) so
// confirmsFinding can also check a ledger entry's own recorded description against the same rule, structurally,
// instead of the word-list veto idReport used to carry.
function selfDeclaredNonBlocking(text) {
  const NB = 'non[\\s-]?blocking'
  const NON_BLOCKING = new RegExp(
    `^(?:(?:minor|note|nit)\\s*[:,]\\s*)?(?:${NB}\\s+(?:nit|note|observation|comment|remark)\\b|${NB}(?::|\\s-\\s))` +
      `|^(?:nit|note|minor)\\s*\\(\\s*${NB}\\s*\\)\\s*:` +
      `|^\\[\\s*${NB}\\s*\\]`,
    'i',
  )
  return NON_BLOCKING.test(String(text == null ? '' : text))
}

// Card ledger-ignores-not-a-defect-notes, round 3: the reason a candidate finding is a note, not a defect, or null
// to keep it. Only verify, check and review findings are candidates at all - an adversary blocker is never dropped,
// by either rule, since the card is about the verifier's and checker's own notes (round 2 rule 3). A finding that
// starts with a ledger id (idReport non-null, whatever the verdict - open, fixed, waived, or null, as in "F1: the
// deadlock holds.") is exempt from every rule below: it is a re-report or a confirmation of an entry that already
// exists, and dropping it would confirm that entry by absence (round 2 rule 4, MAJ1). Otherwise the non-blocking
// rule runs first: the finding is dropped when its text LEADS with a self-declared non-blocking label, not merely
// when it starts with the bare adjective (round 2, R1) - "non-blocking"/"non blocking"/"nonblocking" (hyphen
// optional), case-insensitive, in one of five shapes: (a) the phrase followed by nit/note/observation/comment/remark
// ("Non-blocking nit (no fix required...): ...", "Non-blocking nit: ..."); (b) the phrase directly followed by ':'
// or ' - ' (round 3: not ',' or '(' - "Non-blocking, buffered writes lose the last chunk when the stream closes."
// and "Non-blocking (async) reads return 0 bytes at EOF, truncating the file." are real defects a comma or a bare
// paren would have wrongly dropped; "Non-blocking: the comment is stale" still drops on ':'); (c) a Minor/Note/Nit
// label (':' or ',') ahead of shape a or b ("Minor, non-blocking nit: ...", "Note: non-blocking: ..."); (d)
// Nit/Note/Minor '(' the phrase ')' ':' ("Nit (non-blocking): ..."); (e) '[' the phrase ']' at the very start
// ("[non-blocking] the note above is cosmetic."). Dropped even from a failed stage, because it is the stage's own
// report that its finding does not need to hold up integration, not a criterion result the ledger should ever gate
// readiness on. Anchored at the very start, and requiring one of those shapes rather than the bare word, so a real
// defect whose subject merely starts with "Non-blocking" still opens: "Non-blocking reads return 0 bytes and the
// caller treats that as EOF, truncating the file.", "Non-blocking IO path drops the error when the socket closes
// early.", and "Non-blocking in name only: this crashes on an empty array." (the colon here is not adjacent to the
// phrase, so shape b does not fire) all stay real, as does a real defect that merely contains the words mid-sentence
// ("The non-blocking path in fetch() still drops the error.", mutation M1b) or after a label the rule does not
// recognise ("BLOCKER: ... the earlier non-blocking nit is now a crash."). Loosening the anchor to the bare
// adjective (mutation MR1) reopens all three "stays real" examples above; dropping shapes d/e (mutation MR1d) stops
// their own two examples from dropping; restoring ',' in shape b (round 3 mutation) reopens the comma example
// above. Then the existing text rule runs, case-insensitively: (a) 'not a defect', 'not charged against this task',
// 'do(es) not fail this task' anywhere in the text, ungated - "they wait on the onboarding-docs task and do not fail this task"
// drops on (a) alone, whatever the rest of the sentence says; (b) 'holds' only as a criterion verdict - 'criterion'
// earlier in the same sentence and 'holds' followed by ':', '.', ',', ';' or the end - unless the match's own
// sentence carries a FAILURE_WORD, so "Acceptance criterion 3 (mutex released) fails: the mutex still holds." stays
// real (round 3 rule 5 guard, MAJ1); (c) 'wait(s) on (the )?<word> task' only when none of the finding's paths is
// owned and the match's sentence carries no FAILURE_WORD - "The request handler waits on the cleanup task and the
// process never exits." stays real on the 'never' alone, even though it names no path at all (round 3 rule 5 guard,
// MAJ2). The file rule then drops a finding whose `paths` (stageFindings attaches every path the finding names, not
// just the first) is non-empty and none of those paths is protected - owned by ledgerSamePath, or under
// '.doug/'/'.claude/' - unless the reviewer or the check marked it out-of-scope drift (stage 'review' or 'check'
// with invariant 'scope', the mark for inScope=false, round 3 rule 2 MIN2: the check stands in for the reviewer);
// a finding naming no path, or a run whose task carries no files array, is never outside (round 2 rule 1 samePath /
// rule 2 paths, B1/MAJ2).
//
// Praise ("Everything else I probed matches the spec: ...", the real F4 string from wf_cb484cb2-93d) is
// deliberately left out of this rule (card ledger-nonblocking-notes-hold-integration, P1): it names no
// self-declaring word at all, so covering it would need a wide heuristic (a leading "Everything else...matches the
// spec" phrase, or similar) with no anchor as narrow as "non-blocking", and a wide one risks swallowing a real
// defect phrased the same way. Left as an ordinary finding, it opens a ledger entry like any other and is closed by
// the covering-stage absence rule the next time nothing re-reports it - which is what the E2E test below exercises.
function droppedWhy(f, task) {
  if (f.stage !== 'verify' && f.stage !== 'check' && f.stage !== 'review') return null
  const text = String(f.description == null ? '' : f.description)
  if (idReport(text)) return null
  // Card ledger-check-notes-as-blockers: a check's free-text finding (source 'finding', stageFindings above -
  // never a check `issues` entry, TC) that is blocking but whose text carries no CHECK_NOTE_FAILURE_WORD is the
  // check confirming something holds, not reporting a defect, so it opens no ledger entry. Scoped to the check
  // stage alone (TD: a verify finding with the same wording still opens); a passing check's findings are never
  // `blocking` (stageFindings), so this never reaches TE's confirm-only note either way.
  if (f.stage === 'check' && f.source === 'finding' && f.blocking && !CHECK_NOTE_FAILURE_WORD.test(text)) return 'check-note'
  if (selfDeclaredNonBlocking(text)) return 'non-blocking'
  const paths = (Array.isArray(f.paths) ? f.paths : []).map(p => String(p).trim().replace(/^\.\//, '')).filter(Boolean)
  const NOT_A_DEFECT = /\bnot a defect\b|\bnot charged against this task\b|\bdo(?:es)?\s+not\s+fail\s+this\s+task\b/i
  if (NOT_A_DEFECT.test(text)) return 'not-a-defect'
  // [^.\n] alone would stop at the first '.' in a bare filename mid-sentence (docs/onboarding.md); the lookahead
  // excludes only a sentence-ending period (one followed by whitespace or the end), the same rule idReport uses.
  // Round 3 had also excluded '\n' from the middle group to keep 5b within one line, so a criterion FAILURE report
  // on one line couldn't reach an unrelated 'holds' on the next; round 3b drops that restriction as redundant with
  // the sentence-bounded failure-word guard below (hasUnguardedMatch's own sentence lookup already stops at a
  // newline, so a match that crosses one is judged by the sentence its match *starts* in, same as before).
  const CRITERION_HOLDS = /\bcriterion\b(?:(?!\.(?:\s|$))[\s\S])*?\bholds(?=[:.,;]|\s*$)/i
  if (hasUnguardedMatch(text, CRITERION_HOLDS)) return 'not-a-defect'
  const WAITS_ON_TASK = /\bwaits?\s+on\s+(?:the\s+)?[\w-]+\s+task\b/i
  if (!paths.some(p => pathOwned(p, task)) && hasUnguardedMatch(text, WAITS_ON_TASK)) return 'not-a-defect'
  const outOfScopeDrift = (f.stage === 'review' || f.stage === 'check') && f.invariant === 'scope'
  if (paths.length && task && Array.isArray(task.files) && !outOfScopeDrift && !paths.some(p => pathProtected(p, task))) return 'outside-owned-files'
  return null
}

// Applies one pass to the ledger, stage by stage in the order the stages ran, and returns the ids that opened,
// were confirmed fixed, and came back. A stage confirms an open entry by running and not reporting it: its own
// stage, the focused check, and the confirmation adversary all count, and only on a pass that made a new commit.
function updateLedger(ledger, r, pass, newCommit) {
  const opened = []
  const fixed = []
  const reopened = []
  const dropped = []
  const touched = new Set()
  for (const stage of r.stages || []) {
    const reported = stageFindings(r, stage)
    if (reported === null) continue
    // Card ledger-ignores-not-a-defect-notes, round 2 rule 6: droppedWhy runs on every finding the stage reported,
    // before the confirms-filter below, so a passing stage's own not-a-defect note (which would otherwise satisfy
    // confirmsFinding and vanish silently, MIN1) is still recorded as a dropped note. With the id exemption in
    // droppedWhy, no id-prefixed finding is ever dropped, so a drop can never confirm an entry by absence.
    const kept = []
    for (const f of reported) {
      const why = droppedWhy(f, r.task)
      if (why) dropped.push({ stage: f.stage, file: f.file, description: f.description, why })
      else kept.push(f)
    }
    // A finding that confirms an entry fixed is not a re-report of it: it must neither keep the entry open nor
    // stop a later stage from confirming it. Two runs of 2026-09-06 stalled on exactly that. Dropped findings are
    // excluded before this filter runs, so they can never confirm, reopen, or open a ledger entry either.
    const reReports = kept.filter(f => !confirmsFinding(f, ledger))
    if (newCommit) {
      for (const e of ledger) {
        if (e.status !== 'open' || e.openedPass === pass || touched.has(e.id)) continue
        const covers = e.stage === stage || stage === 'check' || (stage === 'adversary' && pass > 1)
        if (!covers) continue
        if (reReports.some(f => matchFinding(ledger, f) === e)) continue
        e.status = 'fixed'
        e.fixedPass = pass
        e.fixedCommit = r.commit || null
        e.confirmedBy = stage
        fixed.push(e.id)
      }
    }
    for (const f of reReports) {
      const entry = matchFinding(ledger, f)
      if (entry) {
        touched.add(entry.id)
        if (f.evidence) entry.evidence = f.evidence
        if (entry.status === 'fixed') {
          // Reopening drops the record of the fix that did not hold: keeping fixedPass, fixedCommit and confirmedBy
          // would show an open finding as fixed in a commit and confirmed by a stage that has just contradicted itself.
          entry.status = 'open'
          entry.reappeared = true
          entry.fixedPass = null
          entry.fixedCommit = null
          entry.confirmedBy = null
          const i = fixed.indexOf(entry.id)
          if (i >= 0) fixed.splice(i, 1)
          if (!reopened.includes(entry.id)) reopened.push(entry.id)
        }
        continue
      }
      if (!f.blocking) continue
      const created = {
        id: `F${ledger.length + 1}`,
        fingerprint: fingerprint(f.stage, f.file, f.description),
        stage: f.stage,
        invariant: f.invariant,
        severity: f.severity,
        file: f.file,
        line: f.line,
        description: f.description,
        evidence: f.evidence,
        status: 'open',
        openedPass: pass,
        fixedPass: null,
        fixedCommit: null,
        confirmedBy: null,
        reappeared: false,
      }
      ledger.push(created)
      touched.add(created.id)
      opened.push(created.id)
    }
  }
  return { opened, fixed, reopened, dropped }
}

// The ledger as prompt text: open entries in full, fixed ones as a line each, inside a character budget.
// The two parts are shrunk together against the one budget and only then split, so a prompt that prints them
// under separate headings still costs no more than LEDGER_CHAR_BUDGET in total.
// kind is 'open', 'fixed', or anything else for both.
function ledgerText(ledger, kind) {
  const open = (ledger || []).filter(e => e.status === 'open')
  const done = (ledger || []).filter(e => e.status === 'fixed')
  const clip = (s, n) => {
    const t = String(s == null ? '' : s)
    return n && t.length > n ? `${t.slice(0, n)}...` : t
  }
  const openBlock = (e, descCap, evCap) => [
    `${e.id} [${e.stage}/${e.invariant}] ${e.severity} ${e.file || '(no file)'}${e.line ? `:${e.line}` : ''}${e.reappeared ? ' (reappeared after being fixed)' : ''}`,
    `  ${clip(e.description, descCap)}`,
    `  evidence: ${e.evidence ? clip(e.evidence, evCap) : 'none'}`,
  ]
  const fixedLine = e => `${e.id} [${e.stage}/${e.invariant}] fixed in ${String(e.fixedCommit || 'unknown').slice(0, 7)}, confirmed by ${e.confirmedBy || 'unknown'} (pass ${e.fixedPass})`
  const render = (descCap, evCap, dropped) => {
    const openLines = []
    for (const e of open) openLines.push(...openBlock(e, descCap, evCap))
    const doneLines = []
    if (dropped > 0) doneLines.push(`... and ${dropped} earlier fixed findings omitted (${done[0].id}-${done[dropped - 1].id})`)
    for (const e of done.slice(dropped)) doneLines.push(fixedLine(e))
    return { open: openLines.join('\n'), fixed: doneLines.join('\n') }
  }
  const both = s => [s.open, s.fixed].filter(Boolean).join('\n')
  const fits = s => both(s).length <= LEDGER_CHAR_BUDGET
  let text = render(0, 0, 0)
  if (!fits(text)) text = render(0, 240, 0)
  if (!fits(text)) {
    text = render(400, 240, 0)
    for (let dropped = 1; dropped <= done.length && !fits(text); dropped++) text = render(400, 240, dropped)
  }
  if (!fits(text)) {
    // Clipping the fields and dropping the fixed lines is not a bound: enough open entries still overrun the
    // budget. The cap is what every prompt built from the ledger is sized against, so the last step is a hard
    // clip of the open part, keeping the (already minimal) fixed part inside the same budget.
    const note = '\n... ledger truncated at the character budget'
    const room = Math.max(0, LEDGER_CHAR_BUDGET - text.fixed.length - (text.fixed ? 1 : 0) - note.length)
    text = { open: text.open.slice(0, room) + note, fixed: text.fixed }
  }
  if (kind === 'open') return text.open
  if (kind === 'fixed') return text.fixed
  return both(text)
}

// ---- Prompts -----------------------------------------------------------------
function implementPrompt(task, baseBranch, opts) {
  const resume = !!(opts && opts.resume)
  const branchCheck = resume
    ? `   Before that, if git rev-parse --verify --quiet refs/heads/doug/task-${task.id} succeeds, the branch doug/task-${task.id} was created by the previous agent for this task in this same run, which stopped without returning a result; it is yours, not stale. Find that agent's worktree with git worktree list --porcelain (the one with branch refs/heads/doug/task-${task.id}); if none is listed, go straight to the checkout. If it has uncommitted changes to owned files, commit them there first with a message starting "${task.id}: ". ${NO_TRAILERS} Then remove that worktree with git worktree remove --force <path>, then git checkout doug/task-${task.id} in your own worktree and continue the task from that branch's state (do not recreate the branch or reset it). Never return blocked for the branch existing.`
    : `   Before that, if git rev-parse --verify --quiet refs/heads/doug/task-${task.id} succeeds, the branch is a leftover of an earlier run: do not check it out or build on it; change nothing and return blocked=true with blockedReason "stale branch doug/task-${task.id} already exists; run plan.mjs replan, which renames it".`
  return [
    `You are implementing exactly one task from an approved plan. Work only in your own git worktree.`,
    ``,
    `Plan: ${plan.title}`,
    `Goal: ${plan.goal}`,
    ``,
    `Task ${task.id}: ${task.title}`,
    `Spec:`,
    task.spec,
    ...(typeof task.lessons === 'string' && task.lessons ? ['', `Lessons from earlier runs on this repository (memory; each cites where it was learned):`, String(task.lessons).slice(0, 2000)] : []),
    ...(typeof task.codeContext === 'string' && task.codeContext ? ['', `Code the semantic index found relevant to this task (path:lines; read these first, they are not the files you own):`, String(task.codeContext).slice(0, 2000)] : []),
    ``,
    `Files you own (you may create or edit ONLY these): ${task.files.join(', ')}`,
    task.verify ? `Verification command for this task: ${task.verify}` : `Verification: run the project's test command.`,
    ``,
    `Rules:`,
    `1. First run: git checkout -b doug/task-${task.id} ${baseBranch} (or start from ${baseBranch} if the worktree already has it). If ${baseBranch} does not exist, use the current branch.`,
    branchCheck,
    `   A fresh worktree has no installed dependencies: if the verification command needs them, run the project's install command first${plan.install ? ` (${plan.install})` : ''}. Installing is not a file change you own; do not commit lockfile changes it makes.`,
    `2. Touch no file outside your owned list. If the task cannot be done without another file, stop and report blocked=true with the reason.`,
    `3. Run the verification command before finishing and report each command with its real exit status. Never report a command you did not run.`,
    `4. Commit your work on the branch with a message starting "${task.id}: ". ${NO_TRAILERS}`,
    `5. Return the structured result. filesTouched must come from git, not memory, and commit must be the output of git rev-parse HEAD in your worktree after that commit.`,
    `6. ${PARTIAL_RULE}`,
  ].join('\n')
}

function reusePrompt(task, baseBranch) {
  return [
    `You are starting a task from a branch that already passed verification, review, and the adversary on an earlier pass of this plan. Do not implement anything and do not edit any file; the checks run again on this branch after you.`,
    ``,
    `Plan: ${plan.title}`,
    `Task ${task.id}: ${task.title}`,
    `Branch to reuse: ${task.reuse}`,
    `Files the task owns: ${task.files.join(', ')}`,
    ``,
    `Steps, all inside your own worktree:`,
    `1. git checkout ${task.reuse}. If git refuses because the branch is checked out in another worktree, that worktree is a leftover of the earlier pass under .claude/worktrees: find it with git worktree list --porcelain, remove it with git worktree remove --force <path>, and check out again.`,
    plan.install
      ? `2. Run the project's install command (${plan.install}) before the checks run. Installing is not a file change; do not commit anything it changes. Should you commit at all, ${NO_TRAILERS}`
      : `2. If the task's verification command needs dependencies, run the project's install command. Installing is not a file change; do not commit anything it changes. Should you commit at all, ${NO_TRAILERS}`,
    `3. Return taskId="${task.id}", branch="${task.reuse}", worktreePath = the absolute path of your worktree (git rev-parse --show-toplevel), filesTouched = the output of git diff --name-only ${baseBranch}...HEAD, commandsRun with real exit statuses, commit = the output of git rev-parse HEAD, summary "reused ${task.reuse} at <commit>", blocked=false. Report blocked=true with the reason only if the branch does not exist or cannot be checked out.`,
  ].join('\n')
}

// ---- Swarm prompts (card swarm-lead) --------------------------------------------
// The lead splits one full-shape task into worker briefs inside that task's owned files; workers implement their
// briefs in parallel on the worker row; the lead merges their branches into the task branch, and the verifier,
// reviewer, and adversary read the merged branch exactly as they read a single implementer's.
function leadPrompt(task, baseBranch, opts) {
  const resume = !!(opts && opts.resume)
  const branchCheck = resume
    ? `   Before that, if git rev-parse --verify --quiet refs/heads/doug/task-${task.id} succeeds, the branch doug/task-${task.id} was created by the previous agent for this task in this same run, which stopped without returning a result; it is yours, not stale. Find that agent's worktree with git worktree list --porcelain (the one with branch refs/heads/doug/task-${task.id}); if none is listed, go straight to the checkout. If it has uncommitted changes to owned files, commit them there first with a message starting "${task.id}: ". ${NO_TRAILERS} Then remove that worktree with git worktree remove --force <path>, then git checkout doug/task-${task.id} in your own worktree and continue the task from that branch's state (do not recreate the branch or reset it). Never return blocked for the branch existing.`
    : `   Before that, if git rev-parse --verify --quiet refs/heads/doug/task-${task.id} succeeds, the branch is a leftover of an earlier run: do not check it out or build on it; change nothing and return blocked=true with blockedReason "stale branch doug/task-${task.id} already exists; run plan.mjs replan, which renames it".`
  return [
    `You are the lead of a swarm for exactly one task of an approved plan. You split the task into worker briefs; you do not implement anything and you edit no file. Work only in your own git worktree.`,
    ``,
    `Plan: ${plan.title}`,
    `Goal: ${plan.goal}`,
    ``,
    `Task ${task.id}: ${task.title}`,
    `Spec:`,
    task.spec,
    ...(typeof task.lessons === 'string' && task.lessons ? ['', `Lessons from earlier runs on this repository (memory; each cites where it was learned):`, String(task.lessons).slice(0, 2000)] : []),
    ...(typeof task.codeContext === 'string' && task.codeContext ? ['', `Code the semantic index found relevant to this task (path:lines; read these first, they are not the files you own):`, String(task.codeContext).slice(0, 2000)] : []),
    ``,
    `Files the task owns: ${task.files.join(', ')}`,
    task.verify ? `Verification command for the task: ${task.verify}` : `Verification: the project's test command.`,
    ``,
    `Steps:`,
    `1. git checkout -b doug/task-${task.id} ${baseBranch} (if ${baseBranch} does not exist, use the current branch). This is the task branch; the workers branch from it and you merge them back into it.`,
    branchCheck,
    `2. Read the spec and the owned files, then decide whether the task splits. The trigger is positive, not file count: it splits when it has two or more deliverables that each have their own test (or can be verified on its own) and share no new symbol beyond what you write in interfaces below; a brief owns one deliverable and its test. File count alone is not a reason to split: independence of deliverables is.`,
    `3. One brief is right only when the deliverables cannot be separated; say why in splitReason, so the report can tell an unsplittable task from one you did not try to split. More than four briefs is rarely right. A brief that would need another brief's file is the wrong split.`,
    `4. Every file in a brief is one of the task's owned files, and no file is in two briefs: the lead may split, never widen, and two workers never share a file or a worktree.`,
    `5. Give every brief this checklist, adapted from a research lead's brief: an objective, the test to write and how to run it, the interfaces it exposes or consumes, its scope boundaries (its files, nothing else), and the expected result shape. Give a brief its own verify command only when one exists for its files; otherwise leave verify null and the task command applies.`,
    `6. When you split into more than one brief, also return interfaces: the names, signatures, and files each brief exports or consumes, written once here, so every worker prompt carries the same design.`,
    `7. Return taskId="${task.id}", branch="doug/task-${task.id}", worktreePath = the absolute path of your worktree (git rev-parse --show-toplevel), briefs, splitReason (required on every result, split or not), blocked=false. Return blocked=true with the reason only when the task cannot be split without a file outside the owned list; then the plan runs it with a single implementer instead (plan.mjs set swarm off).`,
  ].join('\n')
}

function workerPrompt(task, brief, n, lead) {
  const verify = brief.verify || task.verify
  // Card swarm-topology (candidate 3): every sibling brief of this task, so the worker knows what it must conform
  // to and what is not its business; the task it belongs to still owns only the files its own brief lists below.
  const siblings = (Array.isArray(lead.briefs) ? lead.briefs : []).filter(b => b.id !== brief.id)
  return [
    `You are worker ${n} of a swarm implementing one part of task ${task.id} from an approved plan. You get one brief, the files it owns, and a verification command; the other parts are other workers' business. Work only in your own git worktree.`,
    ``,
    `Plan: ${plan.title}`,
    `Goal: ${plan.goal}`,
    ``,
    `Task ${task.id}: ${task.title}. Its full spec, for background only - your brief below is your part of it:`,
    task.spec,
    ``,
    `Brief ${brief.id}: ${brief.title}`,
    `Spec:`,
    brief.spec,
    ...(typeof task.lessons === 'string' && task.lessons ? ['', `Lessons from earlier runs on this repository (memory; each cites where it was learned):`, String(task.lessons).slice(0, 2000)] : []),
    ...(typeof task.codeContext === 'string' && task.codeContext ? ['', `Code the semantic index found relevant to this task (path:lines; read these first, they are not the files you own):`, String(task.codeContext).slice(0, 2000)] : []),
    ...(typeof lead.interfaces === 'string' && lead.interfaces ? ['', `Interfaces the briefs export or consume (the lead's design; conform to it, do not redesign it):`, lead.interfaces.slice(0, 2000)] : []),
    ...(siblings.length ? ['', `Sibling briefs of this task (their files are not yours to touch; conform to what they export):`, ...siblings.map(s => `  - ${s.id}: ${s.title} (${(Array.isArray(s.files) ? s.files : []).join(', ')})`)] : []),
    ``,
    `Files you own (you may create or edit ONLY these): ${brief.files.join(', ')}`,
    verify ? `Verification command: ${verify}` : `Verification: run the project's test command.`,
    ``,
    `Rules:`,
    `1. First run: git checkout -b doug/task-${task.id}-w${n} ${lead.branch} (the task branch the lead created; it exists in this repository).`,
    `   A fresh worktree has no installed dependencies: if the verification command needs them, run the project's install command first${plan.install ? ` (${plan.install})` : ''}. Installing is not a file change you own; do not commit lockfile changes it makes.`,
    `2. Touch no file outside your owned list. If the brief cannot be done without another file, stop and report blocked=true with a blockedReason that names exactly what you need - the file, the symbol or interface, or the decision - because the lead may re-brief you once on it; a vague reason wastes that chance.`,
    `3. Run the verification command before finishing and report each command with its real exit status. Never report a command you did not run.`,
    `4. Commit your work on the branch with a message starting "${task.id}: w${n} ". ${NO_TRAILERS}`,
    `5. Return the structured result. filesTouched must come from git diff --name-only ${lead.branch}...HEAD, and commit must be the output of git rev-parse HEAD in your worktree after that commit.`,
    `6. ${PARTIAL_RULE}`,
  ].join('\n')
}

// `workers` is who gets merged (finished workers only); `allWorkers` (candidate 2 review, minor 5) is every worker
// that ever ran, blocked ones included, so a blocked round-one worker's worktree is still cleaned up instead of
// left an orphan - it defaults to `workers` for the plain, no-rebrief case where the two are the same list.
function leadMergePrompt(task, lead, workers, baseBranch, allWorkers = workers) {
  return [
    `You are the lead of the swarm for task ${task.id}. The workers have committed; merge their branches into the task branch and hand it to the checks. Work only in your worktree ${lead.worktreePath} on branch ${lead.branch}: cd there first, and never edit anything under the repository root.`,
    PARTIAL_NEVER_MERGED,
    ``,
    `Task ${task.id}: ${task.title}`,
    `Owned files: ${task.files.join(', ')}`,
    task.verify ? `Verification command for the task: ${task.verify}` : `Verification: run the project's test command.`,
    ``,
    `Worker branches, in order:`,
    ...workers.map(w => `  ${w.n}. ${w.branch} (brief ${w.id}: ${w.files.join(', ')})${w.worktreePath ? `, worktree ${w.worktreePath}` : ''}`),
    ``,
    `Steps:`,
    `1. git merge --no-ff each worker branch in that order. Resolve a conflict only inside the owned files and only by keeping both workers' intent; a conflict that needs any other file is a block, not a fix.`,
    `2. If the verification command needs dependencies, run the project's install command${plan.install ? ` (${plan.install})` : ''}; do not commit what it changes. Then run the verification command; it must pass. Report every command with its real exit status and never one you did not run.`,
    `3. Do not implement missing pieces yourself: a brief a worker did not finish is a block with its name. ${NO_TRAILERS}`,
    `4. Remove every worker worktree to leave the repository tidy, merged or not (a blocked worker's is an orphan otherwise): git worktree remove --force <path> for each one below. Keep their branches.`,
    ...allWorkers.filter(w => w.worktreePath).map(w => `  - ${w.worktreePath} (worker ${w.n}: ${w.id})`),
    `5. Return taskId="${task.id}", branch="${lead.branch}", worktreePath="${lead.worktreePath}", filesTouched from git diff --name-only ${baseBranch}...HEAD, commandsRun, commit from git rev-parse HEAD after the last merge, summary naming the briefs merged, blocked=false; blocked=true with the reason when a merge or the verification failed for a reason in the code.`,
  ].join('\n')
}

// Card swarm-topology (candidate 2): one worker blocked does not end the task - the lead gets one chance to
// re-brief the unfinished pieces, in its existing worktree (no new worktree, no isolation key). `workers` is every
// round-one outcome (so the lead sees a finished sibling's commit, not just the blocked ones); `blockedWorkers` is
// the subset that needs a revised brief.
function leadRebriefPrompt(task, lead, workers, blockedWorkers) {
  const finished = workers.filter(w => !w.blocked)
  return [
    `You are the lead of the swarm for task ${task.id}. One or more workers are blocked; you get one chance to re-brief the unfinished pieces. You implement nothing and edit no file. Work only in your existing worktree ${lead.worktreePath} on branch ${lead.branch}: cd there first, create no new branch, and never edit anything under the repository root.`,
    ``,
    `Plan: ${plan.title}`,
    `Goal: ${plan.goal}`,
    ``,
    `Task ${task.id}: ${task.title}`,
    `Spec:`,
    task.spec,
    ...(typeof lead.interfaces === 'string' && lead.interfaces ? ['', `Interfaces from the first split:`, lead.interfaces.slice(0, 2000)] : []),
    ``,
    `Finished workers (their files and commits are done; not yours to reopen):`,
    ...(finished.length ? finished.map(w => `  - ${w.id}: ${w.title} (${w.files.join(', ')}), commit ${w.commit}`) : ['  - (none)']),
    ``,
    `Blocked briefs, and what each worker said it needs:`,
    ...blockedWorkers.map(w => `  - ${w.id}: ${w.title} (${w.files.join(', ')}): ${w.blockedReason}`),
    ``,
    `Steps:`,
    `1. Return revised briefs for the unfinished pieces only. Every file in a revised brief must be a file of one of the blocked briefs above: never a file a finished worker already committed, never a file outside the task.`,
    `2. Revised briefs are disjoint, the same rule as the first split.`,
    `3. You may re-split a blocked brief into smaller briefs, or re-brief it as one brief carrying the missing decision or interface the worker named - most blocks are a missing piece of information, not a missing file. Revised briefs are never more than the blocked briefs plus one, and more than four is never right.`,
    `4. Return splitReason saying what changed and why, required as on the first split.`,
    `5. Return blocked=true with the reason only when the block genuinely needs a file outside the ones listed above; the task then blocks with the original worker's reason.`,
    `6. Return taskId="${task.id}", branch="${lead.branch}", worktreePath="${lead.worktreePath}".`,
  ].join('\n')
}

function fixPrompt(task, r, pass, baseBranch, ledger, brief) {
  const open = ledgerText(ledger, 'open')
  const done = ledgerText(ledger, 'fixed')
  // After integration the task's worktree is gone (the integrator removed it), so the pass starts in a fresh one
  // the runtime made and checks the task branch out there, the way a reused task does.
  const where = r.worktreeGone
    ? `Work only in the git worktree you were started in, on branch ${r.impl.branch}: the task's earlier worktree (${r.impl.worktreePath}) was removed when its level integrated. First run git checkout ${r.impl.branch} there; if git refuses because the branch is checked out in another worktree, that worktree is a leftover under .claude/worktrees: find it with git worktree list --porcelain, remove it with git worktree remove --force <path>, and check out again. Create no branch, and never edit anything under the repository root.`
    : `Work only in the existing worktree ${r.impl.worktreePath} on branch ${r.impl.branch}: cd there first, create no worktree and no branch, and never edit anything under the repository root.`
  const lines = [
    `You are fixing your own task after its checks blocked it. This is fix attempt ${pass - 1} of ${fixAttempts} for task ${task.id}. ${where}`,
    ``,
    `Plan: ${plan.title}`,
    `Task ${task.id}: ${task.title}`,
    `Spec:`,
    task.spec,
    ...(typeof task.lessons === 'string' && task.lessons ? ['', `Lessons from earlier runs on this repository (memory; each cites where it was learned):`, String(task.lessons).slice(0, 2000)] : []),
    ...(typeof task.codeContext === 'string' && task.codeContext ? ['', `Code the semantic index found relevant to this task (path:lines; read these first, they are not the files you own):`, String(task.codeContext).slice(0, 2000)] : []),
    ``,
    `Files you own (you may create or edit ONLY these): ${task.files.join(', ')}`,
    task.verify ? `Verification command for this task: ${task.verify}` : `Verification: run the project's test command.`,
    ``,
    `Open findings (fix every one; a checking stage decides when one is fixed):`,
    open || `- (none listed)`,
  ]
  // Both sections always render: the heading is the standing instruction not to undo earlier fixes, and it has to
  // be in front of the fix agent on every pass, not only once something has already been fixed.
  lines.push(``)
  lines.push(`Fixed earlier in this task (do not undo these; bringing one back blocks):`)
  lines.push(done || `- (none yet)`)
  if (brief) {
    // The supervisor found the loop stalled: the same finding blocked twice, or a pass re-attacked cleared code.
    lines.push(``)
    lines.push(`Supervisor brief (this task is stalled: change direction, do not repeat what the earlier passes tried):`)
    lines.push(brief)
  }
  lines.push(``)
  lines.push(`Rules:`)
  lines.push(`1. Touch no file outside your owned list. If a finding can only be met by changing another file, stop and return blocked=true with the reason.`)
  lines.push(`2. Do not delete, skip, or weaken any test to make a check pass; make the code satisfy it. If that is impossible within the spec, return blocked=true and say why.`)
  lines.push(`3. Run the verification command before finishing; it must pass. Report every command with its real exit status and never one you did not run.`)
  lines.push(`4. Commit on ${r.impl.branch} with a message starting "${task.id}: fix ". Do not amend or rewrite earlier commits. A pass that ends with no new commit stops the task. ${NO_TRAILERS}`)
  lines.push(`5. Return the structured result with taskId="${task.id}", branch="${r.impl.branch}", worktreePath${r.worktreeGone ? ' = the absolute path of your worktree (git rev-parse --show-toplevel)' : `="${r.impl.worktreePath}"`}, filesTouched from git diff --name-only ${baseBranch}...HEAD, commit from git rev-parse HEAD after your commit, blocked=false.`)
  lines.push(`6. ${PARTIAL_RULE}`)
  return lines.join('\n')
}

// A fresh worker picking up a usable partial (card worker-context-handoff, rule 2): same worktree and branch as a
// fix pass (no new worktree, no new branch), briefed with the original spec plus the handoff verbatim. brief, when
// given, is the swarm worker's own brief (id, title, spec, files, verify); its absence means this is the task's own
// single implementer resuming.
function resumePrompt(task, prev, handoff, baseBranch, brief) {
  const owner = brief || task
  const who = brief ? `worker ${brief.id} of task ${task.id}'s swarm` : `task ${task.id}`
  const verify = brief ? (brief.verify || task.verify) : task.verify
  const completed = (Array.isArray(handoff.completed) ? handoff.completed : []).join('; ') || '(none)'
  const remaining = (Array.isArray(handoff.remaining) ? handoff.remaining : []).join('; ')
  return [
    `You are resuming ${who} after the previous worker stopped partway through at the harness's context notice. Work only in the existing worktree ${prev.worktreePath} on branch ${prev.branch}: cd there first, create no worktree and no branch, and never edit anything under the repository root.`,
    ``,
    `Plan: ${plan.title}`,
    brief ? `Brief ${brief.id}: ${brief.title}` : `Task ${task.id}: ${task.title}`,
    `Spec:`,
    owner.spec,
    ``,
    `Files you own (you may create or edit ONLY these): ${owner.files.join(', ')}`,
    verify ? `Verification command: ${verify}` : `Verification: run the project's test command.`,
    ``,
    `Handoff from the previous worker: completed: ${completed}; remaining: ${remaining}; next: ${handoff.next}; verify: ${handoff.verify}`,
    `Do not redo completed items; continue from "next" and finish what "remaining" lists.`,
    ``,
    `Rules:`,
    `1. Touch no file outside your owned list. If the work cannot be done without another file, stop and report blocked=true with the reason.`,
    `2. Run the verification command before finishing and report each command with its real exit status. Never report a command you did not run.`,
    `3. Commit your work on ${prev.branch} with a message starting "${task.id}: resume ". ${NO_TRAILERS}`,
    `4. ${PARTIAL_RULE}`,
    `5. Return the structured result. filesTouched must come from git diff --name-only ${baseBranch}...HEAD, and commit must be the output of git rev-parse HEAD in your worktree after that commit.`,
  ].join('\n')
}

// The supervisor's brief (card fix-loop-supervisor, after NVIDIA AVO's self-supervision loop): the task's passes so
// far, the ledger, and the stall signals the loop detected. It edits nothing and decides nothing about findings.
function supervisePrompt(task, r, attempts, ledger, signals) {
  const stalls = signals.map(x => x.kind === 're-attack' ? `pass ${x.pass} re-attacked ${x.file}, which pass ${x.clearedPass} had already cleared` : `${x.finding} blocked twice${x.reappeared ? ' (reappeared after being fixed)' : ''} (open after passes ${x.passes.join(', ')})`)
  const passes = attempts.map(a => {
    const adv = a.adversary ? (a.adversary.ran ? `${a.adversary.verdict}${a.adversary.blocked ? ' (blocked)' : ''}` : 'did not run') : 'none'
    const cmds = (a.commands || []).map(c => `    ${c.command} (${c.exitCode === null || c.exitCode === undefined ? 'exit unknown' : `exit ${c.exitCode}`})`)
    return [
      `Pass ${a.pass}: ${(a.stages || []).join(', ')}; commit ${a.commit ? String(a.commit).slice(0, 7) : 'none'}; verify ${a.verified ? 'yes' : 'no'}, review ${a.reviewed ? 'yes' : 'no'}, adversary ${adv}; blocked at ${a.blockingStage || 'no stage'}; new findings: ${(a.newFindings || []).join(', ') || 'none'}; fixed: ${(a.fixedFindings || []).join(', ') || 'none'}`,
      `  commands:`,
      ...(cmds.length ? cmds : ['    (none recorded)']),
    ].join('\n')
  })
  return [
    `You are the supervisor of task ${task.id}'s fix loop. The loop is stalled: ${stalls.join('; ')}. Read the passes and the ledger below and write a brief for the next fix pass: what was tried, what failed each time, and two or three alternative directions drawn from this evidence, each different from what the passes tried.`,
    ``,
    `Plan: ${plan.title}`,
    `Task ${task.id}: ${task.title}`,
    `Spec:`,
    task.spec,
    ``,
    `Files the task owns: ${task.files.join(', ')}`,
    `Branch ${r.impl && r.impl.branch ? r.impl.branch : 'unknown'}${r.impl && r.impl.worktreePath ? `, worktree ${r.impl.worktreePath} (read it if you need to; never write there)` : ''}`,
    ``,
    `Passes so far (${attempts.length} of a possible ${fixAttempts + 1}):`,
    ...passes,
    ``,
    `Ledger (open findings in full, fixed ones as a line each):`,
    ledgerText(ledger, 'both') || '(empty)',
    ``,
    `Rules:`,
    `1. You edit nothing and run no command that changes the worktree or the repository; you may read files and run read-only commands.`,
    `2. Your brief is not a verdict: every open finding above stays open until a checking stage confirms it, and you never say a finding is fixed, wrong, or unimportant.`,
    `3. Directions must be concrete and different from what the passes tried (a different file, a different approach, a test written first, a re-read of the failing command's output), never a restatement.`,
    `4. Return taskId="${task.id}", brief, and directions.`,
  ].join('\n')
}

function verifyPrompt(task, impl, baseBranch) {
  return [
    `You are a verifier. You did not write this code. Your job is to run it, not to read and approve it.`,
    ``,
    `Task ${task.id}: ${task.title}`,
    `Spec:`,
    task.spec,
    ``,
    `Plan acceptance criteria (the spec must be consistent with these; a line starting with $ is the command that checks the criterion above it and exits 0 when it holds):`,
    ...acceptanceEntries(plan.acceptance || []).flatMap(a => a.command ? [`- ${a.text}`, `  $ ${a.command}`] : [`- ${a.text}`]),
    ``,
    `Worktree: ${impl.worktreePath}`,
    `Branch: ${impl.branch}`,
    `Implementer says it ran: ${impl.commandsRun.map(c => `${c.command} (${c.ok ? 'ok' : 'FAILED'})`).join('; ') || 'nothing'}`,
    ``,
    `Do all of this inside the worktree directory:`,
    `0. Run git rev-parse HEAD and return its full output as head; the loop records the task's commit from this, not from the implementer.`,
    `1. Run ${task.verify || plan.verify[0] || 'the project test command'} and record the real exit status and the last lines of output.`,
    `2. Run every acceptance command above (the $ lines) inside the worktree, exactly as written, with the worktree as the working directory, and report each one in \`acceptance\` as { text, command, ok, exitCode } with its real exit code (ok means exit code 0; exitCode null only if the command could not start). Never report one you did not run; return acceptance: [] when the plan lists no commands. For criteria without a command, exercise the behavior directly (a script, a CLI call, a test file) rather than reading code and reasoning that it works.`,
    `2b. An acceptance command that exits non-zero because it checks a criterion this task's spec covers makes passed=false, with a finding that names the criterion. One that checks a criterion only another task of this plan can satisfy (its files are not in this task's owned list: ${task.files.join(', ')}) does not fail this task: report it with ok=false and say in findings which task it waits on.`,
    `3. Check git diff ${baseBranch}...${impl.branch} for files outside the owned list: ${task.files.join(', ')}. ${baseBranch} is this branch's base (an integration branch when the task follows an earlier level), so files that already exist there are not this task's changes.`,
    `3b. Check git log ${baseBranch}..${impl.branch} --format=%h%x20%B: ${NO_TRAILERS} Report such a commit as a finding that names it, and passed=false.`,
    `4. passed=true only if the verification command succeeded, every acceptance command this task is responsible for exited 0, and the behavior matches the spec. List concrete findings otherwise.`,
    `4b. For each finding that fails the task and names a file, add { finding, files } to findingFiles: the finding's text and the worktree-relative paths of the existing repository files it concerns (${task.files.join(', ')} are this task's). Never list a fixture, scratch, or temp path. A finding with an entry is attributed by that list, not by the paths in its text, so name the files a fix would touch.`,
    `5. If the spec and an acceptance criterion cannot both hold, do not pick one: add a finding that starts with "${CONTRADICTION_MARKER}: " and names the conflict. The workflow never retries such a finding; it goes back to the planner.`,
    ...(plan.install ? [`If the worktree has no installed dependencies (e.g. no node_modules), run the project's install command first (${plan.install}); installing writes no tracked file and is not an edit.`] : []),
    `Use only tools already installed in the worktree (its test runner, its compiler, plain node). Do not npx-install or download anything else; a command that cannot run for an environment reason and not a code reason (a tool not found after the install, a sandbox denial) is reported as a finding that starts with "${ENVIRONMENT_MARKER}: " naming the command and what the shell said. The workflow does not send such a finding to a fix pass. A command that runs and fails, or cannot start because of anything in the diff (a missing module the diff should provide, a compile error), is a code finding, never ${ENVIRONMENT_MARKER}.`,
    `Do not edit any file. Put scratch scripts under the system temp directory, never in the worktree.`,
  ].join('\n')
}

function checkPrompt(task, impl, prevCommit, baseBranch, ledger) {
  const open = ledgerText(ledger, 'open')
  return [
    `You are the single check on a fix pass for task ${task.id}. You did not write this code. The full verifier and reviewer already ran on an earlier pass, so your job is to run the commands again and to read only what the fix changed.`,
    ``,
    `Task ${task.id}: ${task.title}`,
    `Spec:`,
    task.spec,
    ``,
    `Plan acceptance criteria (the spec must be consistent with these; a line starting with $ is the command that checks the criterion above it and exits 0 when it holds):`,
    ...acceptanceEntries(plan.acceptance || []).flatMap(a => a.command ? [`- ${a.text}`, `  $ ${a.command}`] : [`- ${a.text}`]),
    ``,
    `Worktree: ${impl.worktreePath}`,
    `Branch: ${impl.branch}`,
    `The fix delta is git diff ${prevCommit || baseBranch}..${impl.branch}.`,
    ``,
    `Do all of this inside the worktree directory:`,
    `0. Run git rev-parse HEAD and return its full output as head; the loop records the task's commit from this, not from the implementer.`,
    `1. Run ${task.verify || plan.verify[0] || 'the project test command'} and record the real exit status and the last lines of output.`,
    `2. Run every acceptance command above (the $ lines) inside the worktree, exactly as written, with the worktree as the working directory, and report each one in \`acceptance\` as { text, command, ok, exitCode } with its real exit code (ok means exit code 0; exitCode null only if the command could not start). Never report one you did not run; return acceptance: [] when the plan lists no commands. For criteria without a command, exercise the behavior directly (a script, a CLI call, a test file) rather than reading code and reasoning that it works.`,
    `2b. An acceptance command that exits non-zero because it checks a criterion this task's spec covers makes passed=false, with a finding that names the criterion. One that checks a criterion only another task of this plan can satisfy (its files are not in this task's owned list: ${task.files.join(', ')}) does not fail this task: report it with ok=false and say in findings which task it waits on.`,
    `3. Review only the fix delta, not the whole change again: regression risk in what it touched, scope (any file it changed outside the owned list ${task.files.join(', ')} makes inScope=false), and tests it weakened, skipped, or deleted. Report those as issues.`,
    `4. Confirm each open finding below, one by one, and say for each whether it is fixed. Name each listed finding once, starting with its id: "F3 fixed: <what shows it>" when it is fixed, or "F3: still returns 1" when it is not; the workflow reads the first words after the id, and a finding that names an id is never counted as open unless it says so.`,
    open || `(no open findings; confirm only the delta)`,
    `5. passed=true only when the verification command exited 0, every acceptance command this task is responsible for exited 0, no open finding above remains, and you have no blocker issue.`,
    `5b. For each finding that fails the task and names a file, add { finding, files } to findingFiles: the finding's text and the worktree-relative paths of the existing repository files it concerns (${task.files.join(', ')} are this task's). Never list a fixture, scratch, or temp path. A finding with an entry is attributed by that list, not by the paths in its text, so name the files a fix would touch.`,
    `6. If the spec and an acceptance criterion cannot both hold, do not pick one: add a finding that starts with "${CONTRADICTION_MARKER}: " and names the conflict. The workflow never retries such a finding; it goes back to the planner.`,
    ...(plan.install ? [`If the worktree has no installed dependencies (e.g. no node_modules), run the project's install command first (${plan.install}); installing writes no tracked file and is not an edit.`] : []),
    `Use only tools already installed in the worktree (its test runner, its compiler, plain node). Do not npx-install or download anything else; a command that cannot run for an environment reason and not a code reason (a tool not found after the install, a sandbox denial) is reported as a finding that starts with "${ENVIRONMENT_MARKER}: " naming the command and what the shell said. The workflow does not send such a finding to a fix pass. A command that runs and fails, or cannot start because of anything in the diff (a missing module the diff should provide, a compile error), is a code finding, never ${ENVIRONMENT_MARKER}.`,
    `Do not edit any file. Put scratch scripts under the system temp directory, never in the worktree.`,
  ].join('\n')
}

// The one check of a size-S task: the verifier's job and the reviewer's job in one agent on the verify row.
function sizeCheckPrompt(task, impl, baseBranch) {
  return [
    `You are the one check on size-S task ${task.id}: the verifier's job and the reviewer's job in one pass. You did not write this code. Run it, then read the diff ${baseBranch}...${impl.branch}. No separate verifier, reviewer, or adversary runs for this task; the adversary reviews the level's S tasks together on the integration branch after the merge, so what you miss reaches it.`,
    ``,
    `Task ${task.id}: ${task.title}`,
    `Spec:`,
    task.spec,
    ``,
    `Plan acceptance criteria (the spec must be consistent with these; a line starting with $ is the command that checks the criterion above it and exits 0 when it holds):`,
    ...acceptanceEntries(plan.acceptance || []).flatMap(a => a.command ? [`- ${a.text}`, `  $ ${a.command}`] : [`- ${a.text}`]),
    ``,
    `Worktree: ${impl.worktreePath}`,
    `Branch: ${impl.branch}`,
    `Implementer says it ran: ${impl.commandsRun.map(c => `${c.command} (${c.ok ? 'ok' : 'FAILED'})`).join('; ') || 'nothing'}`,
    ``,
    `Do all of this inside the worktree directory:`,
    `0. Run git rev-parse HEAD and return its full output as head; the loop records the task's commit from this, not from the implementer.`,
    `1. Run ${task.verify || plan.verify[0] || 'the project test command'} and record the real exit status and the last lines of output.`,
    `2. Run every acceptance command above (the $ lines) inside the worktree, exactly as written, and report each one in \`acceptance\` as { text, command, ok, exitCode } with its real exit code (ok means exit code 0; exitCode null only if the command could not start). Never report one you did not run; return acceptance: [] when the plan lists no commands. For criteria without a command, exercise the behavior directly rather than reading code and reasoning that it works.`,
    `2b. An acceptance command that exits non-zero because it checks a criterion this task's spec covers makes passed=false, with a finding that names the criterion. One that checks a criterion only another task of this plan can satisfy (its files are not in this task's owned list: ${task.files.join(', ')}) does not fail this task: report it with ok=false and say in findings which task it waits on.`,
    `3. Check git diff ${baseBranch}...${impl.branch} for files outside the owned list: ${task.files.join(', ')}. Any such file makes inScope=false. ${baseBranch} is this branch's base, so files that already exist there are not this task's changes.`,
    `3b. Check git log ${baseBranch}..${impl.branch} --format=%h%x20%B: ${NO_TRAILERS} Report such a commit as a finding that names it, and passed=false.`,
    `4. Review the diff as the reviewer would, in two passes: spec compliance first (does it do what the spec says, all of it, and nothing else?), then quality (correctness risks, missing tests for new behavior, error handling, naming consistent with surrounding code; do not request refactors beyond the task). Report those as issues with severity blocker, major, or minor, a file, and a line.`,
    `4b. For each finding that fails the task and names a file, add { finding, files } to findingFiles: the finding's text and the worktree-relative paths of the existing repository files it concerns. Never list a fixture, scratch, or temp path.`,
    `5. passed=true only when the verification command exited 0, every acceptance command this task is responsible for exited 0, the behavior matches the spec, and you have no blocker issue.`,
    `6. If the spec and an acceptance criterion cannot both hold, do not pick one: add a finding that starts with "${CONTRADICTION_MARKER}: " and names the conflict. The workflow never retries such a finding; it goes back to the planner.`,
    ...(plan.install ? [`If the worktree has no installed dependencies (e.g. no node_modules), run the project's install command first (${plan.install}); installing writes no tracked file and is not an edit.`] : []),
    `Use only tools already installed in the worktree (its test runner, its compiler, plain node). Do not npx-install or download anything else; a command that cannot run for an environment reason and not a code reason (a tool not found after the install, a sandbox denial) is reported as a finding that starts with "${ENVIRONMENT_MARKER}: " naming the command and what the shell said. The workflow does not send such a finding to a fix pass. A command that runs and fails, or cannot start because of anything in the diff (a missing module the diff should provide, a compile error), is a code finding, never ${ENVIRONMENT_MARKER}.`,
    `Do not edit any file. Put scratch scripts under the system temp directory, never in the worktree.`,
  ].join('\n')
}

// The spec the level adversary reviews against: every size-S task merged into the level, with its owned files.
function levelSpecLines(sReady) {
  return sReady.flatMap(r => [`Task ${r.task.id}: ${r.task.title}`, `Owned files: ${r.task.files.join(', ')}`, r.task.spec, ``])
}

// codex-review over a level's size-S tasks on the integration branch, once, after the merge (and once more to confirm
// a fix pass). Every blocker must name a file, because that is how it finds the task it goes back to.
function levelAdversaryPrompt(li, sReady, levelBase, confirming) {
  const verify = (plan.verify || []).filter(Boolean)
  const guard = t => String(t).replace(/^DOUG_SPEC_EOF$/gm, 'DOUG_SPEC_EOF ')
  const command = [
    `cat <<'DOUG_SPEC_EOF' | ${adversary.command} --base ${shellQuote(levelBase)} --head ${shellQuote(integrationBranch)} --dir ${shellQuote(INTEGRATION_WORKTREE)} --spec - --timeout-ms ${adversary.timeoutMs}${typeof adversary.effort === 'string' && adversary.effort ? ` --effort ${adversary.effort}` : ''}${verify.map(v => ` --verify ${shellQuote(v)}`).join('')}`,
    `Level ${li} of plan "${guard(plan.title)}": the size-S tasks below were merged into ${integrationBranch} with one focused check each and no adversary of their own. Review them together against their specs. Every blocker must name the file it is about, so it can go back to the task that owns that file.`,
    ...(confirming ? [`A fix pass answered the blockers you raised on this level; confirm each one is fixed, name it as fixed or still open, and check the fix for regressions rather than exploring afresh.`] : [`This is the first review of this level: explore freely and try to refute the changes however you can.`]),
    ``,
    ...levelSpecLines(sReady).map(guard),
    `Note to the reviewer: codex-review sets DOUG_CODEX_REVIEW=1 in your environment. A check that would spawn codex-review cannot run inside it, so tests that spawn it skip when that variable is set and name it as the reason. Such a skip is expected and is not a weakened, disabled, or skipped test; do not report it as an issue.`,
    `A check that fails only because your sandbox denied it something the code needs from the environment, such as EPERM when a test listens on 127.0.0.1, is an environment denial: it is inconclusive, not a blocker, so name it in the summary and do not report it as an issue or fail the review on it.`,
    ...BLOCKER_GATE,
    `DOUG_SPEC_EOF`,
  ].join('\n')
  return [
    `Run the adversarial reviewer for level ${li} of the plan (its size-S tasks, merged on ${integrationBranch}) and relay its verdict. Do not review the code yourself and do not edit anything.`,
    ``,
    `Run exactly this command with the Bash tool from the repository root (it pipes the spec on stdin; the timeout is ${adversary.timeoutMs} ms, so set the tool timeout at least that high):`,
    '```',
    command,
    '```',
    ``,
    `The command prints one JSON object and exits 0 (no blockers), 1 (fail verdict or blocker issue), or 2 (could not review). All three are normal; report what it printed.`,
    `Return: taskId="level-${li}", ran=true if JSON was printed, and verdict, summary, issues, commandsRun, error, usage, durationMs copied from the JSON (error = "<kind>: <message>" or null; usage and durationMs copied as printed, or null when the JSON carried none).`,
    `If the command itself is not found, return ran=false, verdict="inconclusive", error="codex-review not found: <what the shell said>".`,
  ].join('\n')
}

function levelFallbackAdversaryPrompt(li, sReady, levelBase, why, confirming) {
  const verify = (plan.verify || []).filter(Boolean)
  return [
    `You are the adversarial reviewer for level ${li} of plan "${plan.title}", standing in for codex-review, which could not run (${why}). The size-S tasks below were merged into ${integrationBranch} with one focused check each and no adversary of their own. Your job is to refute them together, in worktree ${INTEGRATION_WORKTREE} (relative to the repository root); the diff is ${levelBase}...${integrationBranch}.`,
    ``,
    ...levelSpecLines(sReady),
    `Plan acceptance criteria:`,
    ...acceptanceEntries(plan.acceptance || []).map(a => `- ${a.text}`),
    ``,
    `Run every one of these commands in the worktree and record each in commandsRun with its real exit code:`,
    ...verify.map(v => `  $ ${v}`),
    confirming
      ? `Then confirm the blockers you raised on this level are fixed, name each as fixed or still open, and check the fix for regressions rather than exploring afresh.`
      : `Then try to break the changes: inputs the tests do not cover, a spec sentence or acceptance criterion a diff does not meet, a test that was weakened, skipped, or deleted, and behavior outside the owned files. When a suspicion needs a check, write a throwaway one, run it, and remove it before you finish.`,
    `Every blocker must name the file it is about, so it can go back to the task that owns that file.`,
    `A check that fails only because the environment denied it something the code needs (EPERM on a local listener, or a test that needs the same Codex that could not run for you) is an environment denial: it is inconclusive, not a blocker; name it in the summary and do not report it as an issue.`,
    ...BLOCKER_GATE,
    `Return: taskId="level-${li}", ran=true, error=null; verdict "fail" only when at least one issue is a "blocker" (a spec or an acceptance criterion not met, or a verify command exiting non-zero, for a reason in the code) - an issue that is only "major" or "minor" passes with notes; "pass" when you could not refute the changes, "inconclusive" only when the environment kept you from checking; issues with severity "blocker" for anything that must keep the level out, each with file, line, and evidence. Do not edit any file.`,
  ].join('\n')
}

// The reviewer does not see the verifier's result: the two run together on a first pass and each judges the diff on
// its own; the focused check on a fix pass is the one that reads both.
// seat > 1 is a second pair of eyes launched in parallel with the first (card crew-sizing): it is told what a first
// reviewer reading spec line by line is likely to miss, so two reviewers do not file the same finding twice.
function reviewPrompt(task, impl, baseBranch, seat = 1) {
  return [
    `You are a reviewer. Review the diff ${baseBranch}...${impl.branch} in worktree ${impl.worktreePath} against the task spec. Two passes: spec compliance first, then quality. ${baseBranch} is this branch's base (an integration branch when the task follows an earlier level); files that already exist there are not this task's changes.`,
    ...(seat > 1 ? [
      ``,
      `You are reviewer ${seat} of ${seat}: another reviewer is reading this diff at the same time with the standard brief and will check the spec sentence by sentence and the owned-file list. Do not repeat that work. Concentrate on what a first reviewer is likely to miss: behavior on inputs the spec does not name, a test that passes for the wrong reason or asserts less than its name says, error paths and partial failure, concurrency and ordering, a call site elsewhere in the repository that the change silently breaks, and anything the spec implies but does not state. File only what you have shown; your findings are merged with the other reviewer's, and a duplicate collapses to one entry.`,
    ] : []),
    ``,
    `Task ${task.id}: ${task.title}`,
    `Spec:`,
    task.spec,
    `Owned files: ${task.files.join(', ')}`,
    `Plan acceptance criteria:`,
    ...acceptanceEntries(plan.acceptance || []).flatMap(a => a.command ? [`- ${a.text}`, `  $ ${a.command}`] : [`- ${a.text}`]),
    ``,
    `Pass 1, spec compliance: does the diff do what the spec says, all of it, and nothing else? Any file outside the owned list makes inScope=false.`,
    `Pass 2, quality: correctness risks, missing tests for new behavior, error handling, naming consistent with surrounding code. Do not request refactors beyond the task.`,
    `approve=true only if specCompliant, inScope, and there are no blocker issues. Do not edit any file.`,
    `An issue whose description starts with "${CONTRADICTION_MARKER}: " means the spec and an acceptance criterion cannot both hold; use that prefix only for that case, because the workflow sends it back to the planner instead of relaunching the implementer.`,
  ].join('\n')
}

function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`
}

// The confirmation section a fix pass adds to an adversary prompt: the reviewer stops exploring and confirms what
// the ledger already holds, so pass after pass cannot each raise a fresh unrelated blocker.
function confirmationLines(pass, ledger, impl) {
  const open = ledgerText(ledger, 'open')
  const done = ledgerText(ledger, 'fixed')
  return [
    ``,
    `Confirmation pass ${pass}`,
    `This is not a fresh exploration. Earlier passes of this task already raised the findings below; your job is to say whether they are fixed and whether the fix broke anything.`,
    `Open findings, in full:`,
    open || `(none)`,
    `Already fixed on an earlier pass (report one only if it came back):`,
    done || `(none)`,
    `Confirm each open finding one by one, and check the fix delta git diff ${impl.prevCommit || 'the previous pass commit'}..${impl.branch} for regressions.`,
    `Name each listed finding once, starting with its id: "F3 fixed: <what shows it>" when it is fixed, or "F3: still returns 1" when it is not; the workflow reads the first words after the id, and a finding that names an id is never counted as open unless it says so. A finding you re-report at any severity keeps its entry open.`,
    `A new blocker that is not in the list above is allowed only for a demonstrated security, data-loss, destructive, or corruption defect. Report every other new observation as minor.`,
  ]
}

function adversaryPrompt(task, impl, baseBranch, pass, ledger) {
  const verify = [task.verify, ...(plan.verify || [])].filter(Boolean)
  const guard = s => String(s).replace(/^DOUG_SPEC_EOF$/gm, 'DOUG_SPEC_EOF ')
  const command = [
    `cat <<'DOUG_SPEC_EOF' | ${adversary.command} --base ${shellQuote(baseBranch)} --head ${shellQuote(impl.branch)} --dir ${shellQuote(impl.worktreePath)} --spec - --timeout-ms ${adversary.timeoutMs}${typeof adversary.effort === 'string' && adversary.effort ? ` --effort ${adversary.effort}` : ''}${verify.map(v => ` --verify ${shellQuote(v)}`).join('')}`,
    `Task ${task.id}: ${task.title}`,
    ``,
    guard(task.spec),
    ``,
    ...(pass > 1 ? confirmationLines(pass, ledger, impl).map(guard) : [`This is the first pass of this task: explore freely and try to refute the change however you can.`]),
    ``,
    `Note to the reviewer: codex-review sets DOUG_CODEX_REVIEW=1 in your environment. A check that would spawn codex-review cannot run inside it, so tests that spawn it skip when that variable is set and name it as the reason. Such a skip is expected and is not a weakened, disabled, or skipped test; do not report it as an issue. Any other skip is still suspect.`,
    `A check that fails only because your sandbox denied it something the code needs from the environment, such as EPERM when a test listens on 127.0.0.1, is an environment denial: it is inconclusive, not a blocker, so name it in the summary and do not report it as an issue or fail the review on it.`,
    ...BLOCKER_GATE,
    `DOUG_SPEC_EOF`,
  ].join('\n')
  return [
    `Run the adversarial reviewer for task ${task.id} and relay its verdict. Do not review the code yourself and do not edit anything.`,
    ``,
    `Run exactly this command with the Bash tool (it pipes the spec on stdin; the timeout is ${adversary.timeoutMs} ms, so set the tool timeout at least that high):`,
    '```',
    command,
    '```',
    ``,
    `The command prints one JSON object and exits 0 (no blockers), 1 (fail verdict or blocker issue), or 2 (could not review). All three are normal; report what it printed.`,
    `Return: taskId="${task.id}", ran=true if JSON was printed, and verdict, summary, issues, commandsRun, error, usage, durationMs copied from the JSON (error = "<kind>: <message>" or null; usage and durationMs copied as printed, or null when the JSON carried none).`,
    `If the command itself is not found, return ran=false, verdict="inconclusive", error="codex-review not found: <what the shell said>".`,
  ].join('\n')
}

// What an adversary review that ran counts as blocking (card fix-loop-minor-verdict): a blocker issue, or a fail
// verdict with an empty issues array - the one case that leaves the fix loop nothing else to point at, so
// stageFindings synthesizes a blocker finding from the summary. Before this, a fail with only major or minor
// issues synthesized that same summary-only finding too, so the fix pass was briefed with one un-actionable
// finding - the reviewer's prose, naming no file or line - not zero: it could not act on it, made no commit, and
// the task never converged (three runs on card memory-outcomes, 2026-09-07). Such a fail is now pass-with-notes
// instead and does not block.
function adversaryBlocking(adv) {
  const issues = (adv && adv.issues) || []
  if (issues.some(i => i.severity === 'blocker')) return true
  return !!(adv && adv.verdict === 'fail' && issues.length === 0)
}

function adversaryOk(adv, configured = false) {
  // With an adversary configured, a review that did not run blocks: the plan promised a second model's
  // verdict before integration, and "absent" must not read as "passed". plan.adversary: false is the only
  // way to skip it. An inconclusive verdict that ran does not block; only a blocking verdict does (adversaryBlocking).
  if (configured && (!adv || !adv.ran)) return false
  if (!adv || !adv.ran) return true
  return !adversaryBlocking(adv)
}

function adversaryUnavailable(adv) {
  // codex-review exits 2 and sets error when it could not review at all (not installed, codex failed, timed out,
  // unparseable output); that is what the fallback stands in for. A review that ran but could not decide (an
  // environment denial, say) has error null and is not a reason to fall back. A worktree the reviewer modified is
  // corrupted evidence, not unavailability: it stays blocked.
  if (!adv || !adv.ran) return !(adv && adv.error && /^worktree-modified\b/.test(adv.error))
  return adv.verdict === 'inconclusive' && !!adv.error && !/^worktree-modified\b/.test(adv.error)
}

function fallbackAdversaryPrompt(task, impl, baseBranch, why, pass, ledger) {
  const verify = [task.verify, ...(plan.verify || [])].filter(Boolean)
  return [
    `You are the adversarial reviewer for task ${task.id}, standing in for codex-review, which could not run (${why}). Your job is to refute the change on branch ${impl.branch} in worktree ${impl.worktreePath}; the diff is ${baseBranch}...${impl.branch}. ${baseBranch} is this branch's base (an integration branch when the task follows an earlier level); files that already exist there are not this task's changes. Do not edit any file.`,
    ``,
    `Task ${task.id}: ${task.title}`,
    `Spec:`,
    task.spec,
    `Owned files: ${task.files.join(', ')}`,
    `Plan acceptance criteria:`,
    ...acceptanceEntries(plan.acceptance || []).flatMap(a => a.command ? [`- ${a.text}`, `  $ ${a.command}`] : [`- ${a.text}`]),
    ...(pass > 1 ? confirmationLines(pass, ledger, impl) : []),
    ``,
    `Run every one of these commands in the worktree and record each in commandsRun with its real exit code and outputTail (the last lines of its output):`,
    ...verify.map(v => `  $ ${v}`),
    `A blocker's evidence must name one of those commands, and either that command failed or the evidence quotes a line of its outputTail; otherwise the loop records it as major.`,
    pass > 1
      ? `Then confirm the open findings above and check the fix delta for regressions rather than exploring afresh.`
      : `Then try to break the change: inputs the tests do not cover, a spec sentence or acceptance criterion the diff does not meet, a test that was weakened, skipped, or deleted, and behavior outside the owned files. When a suspicion needs a check, write a throwaway one, run it, and remove it before you finish.`,
    `A check that fails only because the environment denied it something the code needs (EPERM on a local listener, or a test that needs the same Codex that could not run for you) is an environment denial: it is inconclusive, not a blocker; name it in the summary and do not report it as an issue.`,
    ...BLOCKER_GATE,
    `Return: taskId="${task.id}", ran=true, error=null; verdict "fail" only when at least one issue is a "blocker" (the spec or an acceptance criterion not met, or a verify command exiting non-zero, for a reason in the code) - an issue that is only "major" or "minor" passes with notes; "pass" when you could not refute the change, "inconclusive" only when the environment kept you from checking; issues with severity "blocker" for anything that must keep the change out of integration, each with file, line, and evidence (the command and output that shows it).`,
  ].join('\n')
}

function integratePrompt(levelIndex, results, baseBranch, isLastLevel, keepWorktree, firstIntegration) {
  const branches = results.map(r => r.impl.branch)
  const worktrees = results.map(r => r.impl.worktreePath)
  return [
    `You are the integration owner for level ${levelIndex} of plan "${plan.title}".`,
    `Integration branch: ${integrationBranch}. Never check it out in the user's main working tree; use a dedicated worktree so the user's checkout is left exactly as it was.`,
    PARTIAL_NEVER_MERGED,
    `Merge these task branches into it, in this order: ${branches.join(', ')}.`,
    `They are local branches of this repository (each was made in its own worktree); no fetch is needed.`,
    ``,
    `Steps:`,
    `1. From the repository root, find or create the integration worktree at .claude/worktrees/doug-integration:`,
    ...(firstIntegration
      ? [
        `   this is the run's first integration; the worktree may be a leftover of an earlier run and is never reused as is: if it exists, git worktree remove --force .claude/worktrees/doug-integration (then git worktree prune).`,
        `   In every case create it fresh: git worktree add -B ${integrationBranch} .claude/worktrees/doug-integration ${baseBranch}`,
      ]
      : [
        `   if it does not exist: git worktree add -B ${integrationBranch} .claude/worktrees/doug-integration ${baseBranch}`,
        `   if it exists (a previous level made it): use it as is; it already has ${integrationBranch} checked out.`,
      ]),
    `   Do every following git and verify command inside that worktree (git -C or cd into it).`,
    `2. Merge each branch with a merge commit (git merge --no-ff <branch>). If a merge conflicts, resolve it only if the resolution is mechanical and obviously correct; otherwise git merge --abort and list the branch in conflicts. ${NO_TRAILERS} That includes the merge commits you make here.`,
    `3. Install dependencies there if the verify commands need them and they are missing${plan.install ? ` (${plan.install})` : ''}. Then run every command in: ${plan.verify.length ? plan.verify.map(v => `"${v}"`).join(', ') : 'the project test command'} and record real exit statuses.`,
    // Card integration-acceptance-recorded: only the last level runs the plan's acceptance commands, and only
    // after the merges above - the plan is not complete at an earlier level, so its prompt never mentions this.
    ...(isLastLevel
      ? [
        `3b. Plan acceptance criteria (a line starting with $ is the command that checks the criterion above it and exits 0 when it holds; the plan is complete at this level, so run every one now):`,
        ...acceptanceEntries(plan.acceptance || []).flatMap(a => a.command ? [`- ${a.text}`, `  $ ${a.command}`] : [`- ${a.text}`]),
        `Run every $ command above inside this integration worktree, exactly as written, after the merges, and report each one in \`acceptance\` as { text, command, ok, exitCode } with its real exit code (ok means exit code 0; exitCode null only if the command could not start). Never report one you did not run; return acceptance: [] when the plan lists no commands.`,
        `Report each command string exactly as it is written above, character for character, even when you ran it behind a cd or git -C prefix: the workflow matches your report to the plan by that string, and a command it cannot match counts as not run and fails the integration.`,
        `A criterion with no $ line is not yours to judge here: do not report it.`,
      ]
      : []),
    `4. If every merge succeeded, remove the merged task worktrees to leave the repository tidy: git worktree remove --force <path> for each of ${worktrees.join(', ')}. Keep their branches.`,
    isLastLevel && !keepWorktree ? `5. This is the last level. Also remove the integration worktree (git worktree remove --force .claude/worktrees/doug-integration); the branch ${integrationBranch} keeps the result.` : isLastLevel ? `5. This is the last level, but keep the integration worktree: the adversary reviews the merged size-S tasks there, and plan.mjs land reuses and removes it.` : `5. Keep the integration worktree; the next level merges into it.`,
    isLastLevel
      ? `6. ok=true only if all merges succeeded, all verify commands passed, and every acceptance command exited 0. Do not push. Do not check out anything in the main working tree.`
      : `6. ok=true only if all merges succeeded and all verify commands passed. Do not push. Do not check out anything in the main working tree.`,
  ].join('\n')
}

// ---- Task loop -------------------------------------------------------------------
// One task from start to a verdict: implement (or check out a reused branch), then verify, review and the
// adversary. While the block is one the checks described inside the task's own files, relaunch the implementer in
// the same worktree; a fix pass reruns the stage that blocked, then one focused check, then the adversary, and the
// loop stops as soon as it stops converging (no new commit, two consecutive novel blockers, or the task budget).
async function startTask(task, baseBranch, launch = agent) {
  if (task.reuse) return launch(reusePrompt(task, baseBranch), { label: `reuse:${task.id}`, phase: 'Implement', isolation: 'worktree', schema: IMPLEMENT_SCHEMA, model: CHECKOUT_MODEL })
  if (swarmApplies(task)) return runSwarm(task, baseBranch, launch)
  const first = await launch(implementPrompt(task, baseBranch), agentOpts('implement', task, { label: `implement:${task.id}`, phase: 'Implement', isolation: 'worktree', agentType: 'doug-flow:implementer', schema: IMPLEMENT_SCHEMA }), implementPrompt(task, baseBranch, { resume: true }))
  if (!first || first.blocked || first.partial !== true) return first
  if (!partialOf(first)) return blockedPartial(first)
  return resumePartialOnce(first, handoff => {
    log(`${task.id} returned partial (next: ${handoff.next}); resuming once`)
    return launch(resumePrompt(task, first, handoff, baseBranch), agentOpts('implement', task, { label: `resume:${task.id}`, phase: 'Implement', agentType: 'doug-flow:implementer', schema: IMPLEMENT_SCHEMA }))
  })
}

// ---- Partial results (card worker-context-handoff) -------------------------------
// The handoff a partial result carries, only when it is usable (rule 3): present, and remaining/next/verify are
// non-empty. null means the claim cannot be resumed - the caller blocks instead of retrying it.
function partialOf(res) {
  if (!res || res.partial !== true) return null
  const h = res.handoff
  if (!h || typeof h !== 'object') return null
  const remaining = Array.isArray(h.remaining) ? h.remaining.filter(s => typeof s === 'string' && s.trim()) : []
  if (!remaining.length) return null
  if (typeof h.next !== 'string' || !h.next.trim()) return null
  if (typeof h.verify !== 'string' || !h.verify.trim()) return null
  return h
}

// Rule 3: a partial with no usable handoff is never resumed; it is blocked like any other implementer block, not
// retried by the fix loop.
function blockedPartial(res) {
  return { ...res, partial: false, blocked: true, blockedReason: 'partial without a handoff' }
}

// Rule 2: a usable partial is resumed exactly once, by `doResume` (which the caller wires to the right prompt: the
// task's own, or a swarm worker's). A result with no usable partial passes through unchanged. `resumed` and
// `partialHandoff` land on the object the rest of the pipeline reads as the implementer's result; a still-partial
// resumed result keeps its own `partial`/`handoff` so the caller can recognize and block it (rule 2's second half).
async function resumePartialOnce(res, doResume) {
  const handoff = partialOf(res)
  if (!handoff) return res
  const resumed = await doResume(handoff)
  if (!resumed) return { ...res, resumed: 1, blocked: true, blockedReason: 'resume returned nothing (spawn failure or no structured output)' }
  return { ...resumed, resumed: 1, ...(resumed.partial === true ? {} : { partialHandoff: handoff }) }
}
// ---- Swarm inside a task (card swarm-lead) --------------------------------------
// With plan.swarm on, a full-shape task's implementer stage becomes: a lead splits the task into worker briefs, the
// workers implement them in parallel in their own worktrees on the worker row, and the lead merges their branches
// into the task branch. What comes out is an implementer result, so the verify, review, adversary, ledger, budget,
// and integrate stages run unchanged on it; a fix pass is one implementer in the lead's worktree, as it is today.
// Scope never widens: a brief that names a file the task does not own blocks the task before any worker runs.

// A test file, by path: a test/tests/__tests__/spec directory segment, a tests/ prefix, or a .test./.spec./_test./
// Test. basename infix. Card swarm-topology's shape gate counts everything else as a source file.
function isTestFile(p) {
  const path = String(p)
  if (/(^|\/)(test|tests|__tests__|spec)\//.test(path)) return true
  const base = path.slice(path.lastIndexOf('/') + 1)
  return /\.test\.|\.spec\.|_test\.|Test\./.test(base)
}

// Card swarm-topology (candidate 1), the shape gate: a task splits only when it owns two or more source files (not
// counting their tests). One source file plus its tests is a single deliverable no lead can usefully divide, so it
// runs as a single implementer even with swarm on. Deterministic: no tokens spent deciding.
function splittable(task) {
  const files = Array.isArray(task.files) ? task.files : []
  return files.filter(f => !isTestFile(f)).length >= 2
}

function swarmApplies(task) {
  if (plan.swarm !== true || task.reuse || taskShape(task) === 'S') return false
  if (!splittable(task)) {
    log(`${task.id} shape gate: one source file and its tests; runs as a single implementer, not a lead`)
    return false
  }
  return true
}

// The report's per-task record of why a task did or did not run as a swarm (card swarm-topology): reason mirrors
// the shape gate's own precedence (a reused task never reaches the gate, a size-S task keeps its own shape, then
// the file count), and splitReason/briefs are the lead's own words and count, only when the task actually swarmed.
function swarmReport(task, impl) {
  if (plan.swarm !== true) return null
  const reason = task.reuse ? 'reuse' : taskShape(task) === 'S' ? 'size S' : !splittable(task) ? 'one source file and its tests' : 'two or more source files'
  // Read off reason rather than calling swarmApplies again: swarmApplies logs the shape-gate line itself, and this
  // report is built for every task after startTask already ran it once - a second call would double the log.
  const applies = reason === 'two or more source files'
  return {
    applies,
    reason,
    splitReason: applies && impl ? impl.splitReason || null : null,
    // The first split's own brief count (candidate 2 review, minor 6): round-one workers only, so a re-brief that
    // adds round-two workers does not inflate what was actually split at the start; a result with no `round` field
    // (older shape) falls back to every worker, as briefs did before rounds existed.
    briefs: applies && impl && Array.isArray(impl.workers)
      ? (impl.workers.some(w => w && w.round !== undefined) ? impl.workers.filter(w => w.round === 1).length : impl.workers.length)
      : null,
    // Card swarm-topology (candidate 2): the lead's one re-brief, when the first split left a worker blocked; null
    // when the task never needed one.
    rebrief: applies && impl ? impl.rebrief || null : null,
    // Card swarm-topology (candidate 3): whether the plan opted into the deterministic per-worker check, and which
    // worker ids (if any) failed it; [] when the check never ran or found nothing.
    workerCheck: plan.workerCheck === true,
    checkFailed: applies && impl && Array.isArray(impl.checkFailed) ? impl.checkFailed : [],
  }
}

async function runSwarm(task, baseBranch, launch) {
  const stages = ['lead']
  const workers = []
  // Card swarm-topology (candidate 2, review): `blocked` reads `lead` and `rebrief` at call time (both declared
  // with `let` below), so a block after the lead has answered - including a second-round block - still carries
  // the lead's own branch/worktree and splitReason, and the re-brief record when there was one, into the result
  // swarmReport reads.
  let lead = null
  let rebrief = null
  const blocked = (reason, extra) => ({ taskId: task.id, branch: `doug/task-${task.id}`, worktreePath: '', filesTouched: [], commandsRun: [], summary: reason, blocked: true, blockedReason: reason, commit: null, swarmStages: stages, workers, ...(lead && lead.splitReason ? { splitReason: lead.splitReason } : {}), ...(rebrief ? { rebrief } : {}), checkFailed: workers.filter(w => w.checkFailed).map(w => w.id), ...(extra || {}) })
  lead = await launch(leadPrompt(task, baseBranch), agentOpts('lead', null, { label: `lead:${task.id}`, phase: 'Implement', isolation: 'worktree', agentType: 'doug-flow:lead', schema: LEAD_SCHEMA }), leadPrompt(task, baseBranch, { resume: true }))
  if (!lead) return blocked('lead returned nothing (spawn failure or no structured output)')
  if (lead.blocked) return blocked(`lead blocked: ${lead.blockedReason || 'no reason given'}`)
  if (!lead.splitReason || !String(lead.splitReason).trim()) return blocked('lead gave no splitReason')
  const briefs = Array.isArray(lead.briefs) ? lead.briefs : []
  if (!briefs.length) return blocked('lead returned no worker briefs')
  const seen = new Set()
  for (const b of briefs) {
    const files = Array.isArray(b.files) ? b.files : []
    if (!files.length) return blocked(`lead brief ${b.id} owns no file`)
    for (const f of files) {
      if (!task.files.some(o => samePath(o, f))) return blocked(`lead brief ${b.id} names a file the task does not own: ${f}`)
      if ([...seen].some(s => samePath(s, f))) return blocked(`lead briefs overlap on ${f}`)
      seen.add(f)
    }
  }
  log(`${task.id} lead split the task into ${briefs.length} brief${briefs.length === 1 ? '' : 's'}: ${briefs.map(b => b.id).join(', ')}`)

  // One round of workers for a list of briefs, numbered from startN (card swarm-topology candidate 2): shared by
  // the first split and the one re-brief round, partial-resume included, so a re-briefed brief runs exactly like
  // an original one. `leadView` is what workerPrompt/resumePrompt see as "the lead": round one passes the lead
  // itself; round two (review MAJOR 1) passes a view whose briefs/interfaces are the surviving picture - the
  // finished round-one briefs plus the revised ones, never a replaced brief - so a round-two worker's siblings and
  // interfaces reflect what is actually still running, not the abandoned first split.
  const runRound = async (briefList, round, startN, leadView = lead) => {
    const results = await parallel(briefList.map((b, i) => async () => {
      const n = startN + i
      stages.push(`worker-${n}`)
      const w = await launch(workerPrompt(task, b, n, leadView), agentOpts('worker', null, { label: `worker:${task.id}:${n}`, phase: 'Implement', isolation: 'worktree', agentType: 'doug-flow:implementer', schema: IMPLEMENT_SCHEMA }))
      if (!w || w.blocked || w.partial !== true) return w
      if (!partialOf(w)) return blockedPartial(w)
      return resumePartialOnce(w, handoff => {
        log(`${task.id} worker ${n} (${b.id}) returned partial (next: ${handoff.next}); resuming once`)
        // The worker's own basis is the lead's branch (workerPrompt's own filesTouched line uses it, not the
        // task's baseBranch), so a resumed worker's filesTouched is computed the same way.
        return launch(resumePrompt(task, w, handoff, leadView.branch, b), agentOpts('worker', null, { label: `resume:${task.id}:${n}`, phase: 'Implement', agentType: 'doug-flow:implementer', schema: IMPLEMENT_SCHEMA }))
      })
    }))
    return briefList.map((b, i) => {
      const n = startN + i
      const w = results ? results[i] : null
      // Rule 4: a worker still partial after its one resume blocks the task like any other worker block, so the
      // merge never launches on it, and it never reaches the re-brief either.
      const stillPartial = !!(w && w.partial === true)
      const stillPartialReason = () => `partial after resume: ${(w.handoff && Array.isArray(w.handoff.remaining) ? w.handoff.remaining.join('; ') : '')}`
      return {
        n,
        id: b.id,
        title: b.title,
        files: b.files,
        round,
        branch: w && w.branch ? w.branch : null,
        worktreePath: w && w.worktreePath ? w.worktreePath : null,
        commit: w ? w.commit || null : null,
        filesTouched: w ? w.filesTouched || [] : [],
        commandsRun: w ? w.commandsRun || [] : [],
        blocked: !w || !!w.blocked || stillPartial,
        blockedReason: !w ? 'worker returned nothing (spawn failure or no structured output)' : stillPartial ? stillPartialReason() : w.blocked ? w.blockedReason || 'no reason given' : null,
        partial: stillPartial,
        handoff: stillPartial ? w.handoff || null : null,
        resumed: w ? w.resumed || 0 : 0,
      }
    })
  }

  // Card swarm-topology (candidate 3): a deterministic per-worker check before the merge, behind plan.workerCheck -
  // no agent spawned, no tokens spent. Every file a worker touched must be one of its own brief's files, and it
  // must have committed; a failure is marked blocked the same way an implementer's own block is, so it takes the
  // same one-re-brief-then-block path as any other block. Runs after every round, not only the first, so a
  // round-two worker that widens is caught before the merge as well.
  const checkWorkers = round => {
    stages.push('worker-check')
    for (const w of round) {
      if (w.blocked || w.partial) continue
      const outside = (w.filesTouched || []).find(f => !w.files.some(o => samePath(o, f)))
      const reason = outside !== undefined ? `worker check: touched a file outside its brief: ${outside}` : !w.commit ? 'worker check: no commit' : null
      if (!reason) continue
      w.blocked = true
      w.blockedReason = reason
      w.checkFailed = true
    }
  }

  const round1 = await runRound(briefs, 1, 1)
  workers.push(...round1)
  if (plan.workerCheck === true) checkWorkers(round1)
  const round1Blocked = round1.filter(w => w.blocked)
  if (round1Blocked.length) {
    const reason = `worker${round1Blocked.length === 1 ? '' : 's'} blocked: ${round1Blocked.map(w => `${w.n} (${w.id}): ${w.blockedReason}`).join('; ')}`
    // Rule 4: a worker still partial after its resume blocks the task exactly as before - no re-brief attempt.
    if (round1Blocked.some(w => w.partial)) return blocked(reason, { worktreePath: lead.worktreePath, branch: lead.branch })
    // Rule 2: one re-brief, in the lead's existing worktree (no isolation key, no new worktree), same schema as the
    // first split.
    stages.push('lead-rebrief')
    const revised = await launch(leadRebriefPrompt(task, lead, round1, round1Blocked), agentOpts('lead', null, { label: `lead-rebrief:${task.id}`, phase: 'Implement', agentType: 'doug-flow:lead', schema: LEAD_SCHEMA }))
    const leadFail = !revised
      ? 'lead rebrief returned nothing (spawn failure or no structured output)'
      : revised.blocked
        ? `lead rebrief blocked: ${revised.blockedReason || 'no reason given'}`
        : !Array.isArray(revised.briefs) || !revised.briefs.length
          ? 'lead rebrief returned no worker briefs'
          : !revised.splitReason || !String(revised.splitReason).trim()
            ? 'lead rebrief gave no splitReason'
            : null
    // Rule 4: a lead-rebrief that cannot be used blocks the task with the original workers' reasons plus the
    // lead's own, and no second-round worker ever launches. Neither `rebriefed` nor `rebrief` is set here (review
    // minor 3 and 4): the lead never actually produced a usable re-brief, so there is nothing to record as one.
    if (leadFail) return blocked(`${reason}; ${leadFail}`, { worktreePath: lead.worktreePath, branch: lead.branch })
    // Rule 3: the revised briefs are checked the same deterministic way as the first split, plus the one rule the
    // first split has no need of - every file in a revised brief is a file of a blocked brief, never a file a
    // finished worker already committed and never a file outside the task (both implied by that one check, since
    // the first split already kept the blocked briefs' files disjoint from the finished ones').
    const blockedFiles = round1Blocked.flatMap(w => w.files)
    const seen2 = new Set()
    for (const b of revised.briefs) {
      const files = Array.isArray(b.files) ? b.files : []
      if (!files.length) return blocked(`${reason}; lead rebrief ${b.id} owns no file`, { worktreePath: lead.worktreePath, branch: lead.branch })
      for (const f of files) {
        if (!blockedFiles.some(o => samePath(o, f))) return blocked(`${reason}; lead rebrief ${b.id} names a file not from a blocked brief: ${f}`, { worktreePath: lead.worktreePath, branch: lead.branch })
        if ([...seen2].some(s => samePath(s, f))) return blocked(`${reason}; lead rebrief briefs overlap on ${f}`, { worktreePath: lead.worktreePath, branch: lead.branch })
        seen2.add(f)
      }
    }
    // The revised briefs passed every check: this is now a real re-brief, on the record whatever round two does
    // (review minor 3 and 4) - a round-two block still reports why the task re-briefed at all.
    for (const w of round1Blocked) w.rebriefed = true
    rebrief = { reason: revised.splitReason, briefs: revised.briefs.length }
    log(`${task.id} lead re-briefed ${round1Blocked.length} blocked brief${round1Blocked.length === 1 ? '' : 's'} into ${revised.briefs.length} revised brief${revised.briefs.length === 1 ? '' : 's'}: ${revised.briefs.map(b => b.id).join(', ')}`)
    const finishedBriefs = briefs.filter(b => round1.some(w => !w.blocked && w.id === b.id))
    const round2Lead = { ...lead, briefs: [...finishedBriefs, ...revised.briefs], interfaces: typeof revised.interfaces === 'string' && revised.interfaces ? revised.interfaces : lead.interfaces }
    const round2 = await runRound(revised.briefs, 2, workers.length + 1, round2Lead)
    workers.push(...round2)
    if (plan.workerCheck === true) checkWorkers(round2)
    const round2Blocked = round2.filter(w => w.blocked)
    // Rule 4: a second block ends the task as today - no merge launches.
    if (round2Blocked.length) return blocked(`worker${round2Blocked.length === 1 ? '' : 's'} blocked: ${round2Blocked.map(w => `${w.n} (${w.id}): ${w.blockedReason}`).join('; ')}`, { worktreePath: lead.worktreePath, branch: lead.branch })
  }
  stages.push('lead-merge')
  // Rule 3: the merge prompt lists only workers that are not blocked - finished round-one workers plus round-two
  // workers, in the order they were pushed. `workers` itself (review minor 5) still goes to leadMergePrompt as the
  // worktree-removal list, blocked ones included, so a blocked worker's worktree is not left an orphan.
  const finished = workers.filter(w => !w.blocked)
  const merged = await launch(leadMergePrompt(task, lead, finished, baseBranch, workers), agentOpts('lead', null, { label: `lead-merge:${task.id}`, phase: 'Implement', agentType: 'doug-flow:lead', schema: IMPLEMENT_SCHEMA }))
  if (!merged) return blocked('lead merge returned nothing (spawn failure or no structured output)', { worktreePath: lead.worktreePath, branch: lead.branch })
  return { ...merged, branch: merged.branch || lead.branch, worktreePath: merged.worktreePath || lead.worktreePath, swarmStages: stages, workers, splitReason: lead.splitReason, rebrief, checkFailed: workers.filter(w => w.checkFailed).map(w => w.id) }
}


// Tokens and wall time as the Workflow runtime reports them, or nulls. The primitive is optional and its shape is
// not this workflow's to guarantee, so every reading is guarded and nothing here ever throws: the binding may be
// missing and each property read may itself throw (a getter, a proxy), so the read sits inside the try as well.
function runtimeSpend() {
  const num = key => {
    try {
      const b = typeof budget !== 'undefined' ? budget : null
      if (!b || typeof b !== 'object') return null
      const v = b[key]
      return typeof v === 'number' && Number.isFinite(v) ? v : null
    } catch (e) {
      return null
    }
  }
  let tokens = num('spent')
  if (tokens === null) {
    const total = num('total')
    const remaining = num('remaining')
    tokens = total !== null && remaining !== null ? total - remaining : null
  }
  return { tokens, elapsedMs: num('elapsedMs') }
}

// Two paths name the same file when they are equal, when one is the other shortened from the left (a verifier
// writes lib/secret-rules.mjs for plugins/doug-gates/lib/secret-rules.mjs), or when the first is a directory the
// second is under.
function samePath(owned, p) {
  return owned === p || owned.endsWith('/' + p) || p.endsWith('/' + owned) || p.startsWith(owned + '/')
}

// a/b/{c.js, d/e.js} in prose is a/b/c.js a/b/d/e.js.
function expandBraces(text) {
  return String(text).replace(/((?:[\w.-]+\/)+)\{([^{}]+)\}/g, (m, prefix, list) => list.split(',').map(s => prefix + s.trim()).join(' '))
}

// The repo-relative paths the blocking findings name. Structured first: review and adversary issue files, and the
// verifier's findingFiles list, which it fills with existing repository files, so a finding with an entry is read
// from the list, never from its text. Prose second: slash-separated tokens ending in an extension in the remaining
// verifier findings, braces expanded; a token preceded by /, ., - or a word character belongs to a larger token (an
// absolute worktree path, say) and is skipped. The workflow cannot look at the disk, so a prose path counts only
// when the run already knows the file: a plan task owns it or the implementer touched it. Anything else in prose,
// a fixture inside a temp project or a scratch file, is ignored rather than treated as outside the owned set.
function findingPaths(r) {
  const out = []
  const add = p => {
    if (typeof p !== 'string') return
    const trimmed = p.trim()
    if (!trimmed) return
    out.push(trimmed.replace(/^\.\//, ''))
  }
  // Only the stages that blocked count: a passing verifier or reviewer may mention any path in prose. Same rule
  // as adversaryOk (a fail with only major/minor issues does not block); configured is irrelevant here since
  // r.adv.ran is already true.
  const advBlocked = r.adv && r.adv.ran && !adversaryOk(r.adv, true)
  for (const issue of (r.rev && !r.rev.approve ? r.rev.issues : []) || []) add(issue.file)
  for (const issue of (advBlocked ? r.adv.issues : []) || []) add(issue.file)
  if (!(r.ver && !r.ver.passed)) return out
  const listed = Array.isArray(r.ver.findingFiles) ? r.ver.findingFiles.filter(e => e && typeof e.finding === 'string' && Array.isArray(e.files)) : []
  for (const e of listed) for (const f of e.files) add(f)
  const known = [...(plan.tasks || []).flatMap(t => (Array.isArray(t.files) ? t.files : [])), ...((r.impl && r.impl.filesTouched) || [])].filter(f => typeof f === 'string')
  for (const finding of r.ver.findings || []) {
    if (typeof finding !== 'string' || listed.some(e => e.finding.trim() === finding.trim())) continue
    for (const m of expandBraces(finding).matchAll(/(?<![\w./-])(?:[\w.-]+\/)+[\w.-]+\.[A-Za-z0-9]+/g)) {
      const p = m[0].replace(/^\.\//, '')
      if (known.some(f => samePath(f, p))) add(p)
    }
  }
  return out
}

function ownsPath(task, p) {
  // Plan state and worktree paths are never code a task owns.
  return task.files.some(f => samePath(f, p)) || p.startsWith('.doug/') || p.startsWith('.claude/')
}

// A path another task of this plan owns. A verifier that names a sibling's file is describing work this plan has
// already assigned to someone else - an acceptance criterion waiting on that task, most often - not this task
// leaving its lane, so such a path must not turn a fixable block into a replan.
function ownedBySibling(task, p) {
  return (plan.tasks || []).some(t => t.id !== task.id && Array.isArray(t.files) && ownsPath(t, p))
}

// Can this block be fixed by the same implementer, or must a human see it?
function retriable(task, r) {
  if (!r.impl) return { ok: false, reason: 'implementer returned nothing', stopClass: 'stage-missing' }
  // A fix pass that returned no structured result changed nothing the loop knows of: the branch and worktree it
  // had are still there, so the same implementer is asked again.
  if (r.noResult) return { ok: true, reason: r.noResult }
  if (r.impl.blocked) return { ok: false, reason: `implementer blocked: ${r.impl.blockedReason || 'no reason given'}`, stopClass: 'implementer-blocked' }
  // A partial result is not a check failure, whether it came from the initial worker's one resume or from a fix
  // pass: the fix loop never retries it (card worker-context-handoff).
  if (r.impl.partial) return { ok: false, reason: 'a partial result is not retried by the fix loop', stopClass: 'partial' }
  // Only a stage that actually ran can be missing; a fix pass deliberately skips the stages that did not block.
  const ran = r.stages || []
  if (ran.includes('verify') && !r.ver) return { ok: false, reason: 'verifier returned nothing', stopClass: 'stage-missing' }
  if (ran.includes('review') && !r.rev) return { ok: false, reason: 'reviewer returned nothing', stopClass: 'stage-missing' }
  if (ran.includes('check') && !r.check) return { ok: false, reason: 'check returned nothing', stopClass: 'stage-missing' }
  const texts = [...((r.ver && r.ver.findings) || []), ...(((r.rev && r.rev.issues) || []).map(i => i.description))]
  const contradiction = texts.find(t => typeof t === 'string' && t.includes(CONTRADICTION_MARKER))
  if (contradiction) return { ok: false, reason: `spec contradicts acceptance: ${contradiction}`, stopClass: 'spec-contradiction' }
  const environmentOnly = texts.find(t => typeof t === 'string' && t.includes(ENVIRONMENT_MARKER))
  if (environmentOnly) return { ok: false, reason: `environment, not the code: ${environmentOnly}`, stopClass: 'environment' }
  if (adversary && r.adv && !r.adv.ran) return { ok: false, reason: `adversary did not run: ${r.adv.error || 'no reason given'}`, stopClass: 'adversary-not-run' }
  const outside = [...new Set(findingPaths(r).filter(p => !ownsPath(task, p) && !ownedBySibling(task, p)))]
  if (outside.length) return { ok: false, reason: `findings name files outside the owned set: ${outside.join(', ')}`, stopClass: 'outside-owned' }
  return { ok: true, reason: 'every finding is within the owned files' }
}

function isReady(r) {
  // A task still partial after its one resume is never ready, whatever a check would say (card
  // worker-context-handoff, rule 2): graceful degradation is its own outcome, not a pass.
  if (r.impl && r.impl.partial) return false
  // A finding the ledger already recorded as fixed and that came back keeps the task out even when every stage
  // passed. This is deliberately unconditional: updateLedger reopens on any re-report matched by id or fingerprint,
  // whatever that re-report's own `blocking` flag or severity says - a passing check's free-text "F1: still returns
  // 1..." reopens F1 ("still reopens and keeps entries on a real re-report"), and so does a passing-verdict
  // adversary's *minor*-severity issue naming the same id ("blocks the pass when a finding the ledger recorded as
  // fixed comes back"). Gating this on the reporting finding's own blocking flag would silently let either of those
  // real reappearances through. A 'waived' report only stays out of the re-report list (card d-waiver-structural-rule)
  // when the ledger's own entry for that id is itself a self-declared non-blocking note (confirmsFinding above); a
  // disputed waiver against a blocking entry reaches here as an ordinary re-report and can reopen or keep an entry
  // open exactly the same way.
  if (r.reopened && r.reopened.length) return false
  // So does one no stage has confirmed fixed. A minor re-report keeps an entry open without blocking any stage, so
  // without this a task could integrate carrying a blocker the ledger still holds against it.
  if (r.openFindings && r.openFindings.length) return false
  return !!(r.impl && !r.impl.blocked && r.ver && r.ver.passed && r.rev && r.rev.approve && adversaryOk(r.adv, adversaryRequired(r.task)))
}

function notReadyWhy(r) {
  if (!r.impl) return 'implementer returned nothing (agent errored, was skipped, or its agent type is not loaded)'
  if (r.impl.blocked) return `blocked: ${r.impl.blockedReason}`
  // A resumed worker's second partial names itself "after resume"; a partial declared mid-fix-loop was never
  // resumed at all (no fresh worker was ever launched for it), so it gets its own wording (card
  // worker-context-handoff, reviewer follow-up).
  if (r.impl.partial) {
    const remaining = r.impl.handoff && Array.isArray(r.impl.handoff.remaining) ? r.impl.handoff.remaining.join('; ') : ''
    return r.impl.resumed ? `partial after resume: ${remaining}` : `partial on a fix pass: ${remaining}`
  }
  if (r.noResult) return r.noResult
  if (r.reopened && r.reopened.length) return `a fixed finding reappeared: ${r.reopened.join(', ')}`
  if ((r.stages || []).includes('check') && !r.check) return 'focused check returned nothing'
  if (r.check && !(r.check.passed && r.rev && r.rev.approve)) return 'focused check failed'
  if (!r.ver || !r.ver.passed) return 'verification failed'
  if (!(r.rev && r.rev.approve)) return 'review rejected'
  if (!adversaryOk(r.adv, adversaryRequired(r.task))) return `adversary blocked: ${r.adv ? r.adv.summary : 'no adversary result'}`
  if (r.openFindings && r.openFindings.length) return `open finding: ${r.openFindings.join(', ')}`
  return 'not ready and no stage said why'
}

// card fallback-adversary-blocker-evidence: R12 mirrored for the fallback adversary, whose structured result never
// passes through packages/doug-codex/src/contract.ts (lines 34-99, the source of truth for the Codex-side check;
// change both together). Differences from contract.ts, and only these: a commandsRun entry counts as failed when
// `ok === false` or `exitCode` is a non-zero integer (the fallback's commandsRun requires ok but not exitCode), and
// the description prefix names adversary-claude, not codex-review. Applied to the fallback's own result in
// runAdversary, below, and to each crew seat 2+ in runAdversaryCrew (card crew-seat-blocker-evidence); never to
// the primary Codex seat.
function innerCommand(command) {
  const m = /^\/bin\/(?:ba|z)?sh\s+-l?c\s+'([\s\S]*)'$/.exec(String(command).trim())
  return (m ? m[1] : String(command)).trim()
}
function squash(s) {
  return String(s).replace(/\s+/g, ' ').trim()
}
// card fallback-evidence-output-citation: OUTPUT_CITATION_MIN_CHARS, citedCommands' third arm below, and the new
// reason-B text in blockerEvidenceProblem mirror packages/doug-codex/src/contract.ts's output-citation rule, the
// source of truth; change both together.
// The floor for citing a command by its output alone (contract.ts's comment: a bare 4-char floor would let any
// blocker cite almost any command once a command need not be named at all).
const OUTPUT_CITATION_MIN_CHARS = 16
// A commandsRun entry can be any odd shape the agent reported (R3 never throws): not an object, or command not a
// string, counts as uncited rather than a crash (mirrors passCommands' own `if (!c || typeof c !== 'object')`).
function citedCommands(evidence, commandsRun) {
  const ev = squash(evidence)
  return commandsRun.filter(c => {
    if (!c || typeof c !== 'object' || typeof c.command !== 'string') return false
    const whole = squash(c.command)
    const inner = squash(innerCommand(c.command))
    return (whole.length > 0 && ev.includes(whole)) || (inner.length >= 4 && ev.includes(inner)) || quotesOutput(evidence, c.outputTail, OUTPUT_CITATION_MIN_CHARS)
  })
}
function quotesOutput(evidence, outputTail, minChars = 4) {
  if (!outputTail) return false
  const ev = squash(evidence)
  return String(outputTail).split('\n').map(l => squash(l)).some(l => l.length >= minChars && ev.includes(l))
}
function commandFailed(c) {
  return !!c && (c.ok === false || (typeof c.exitCode === 'number' && Number.isInteger(c.exitCode) && c.exitCode !== 0))
}
function blockerEvidenceProblem(issue, commandsRun) {
  const evidence = typeof issue.evidence === 'string' ? issue.evidence.trim() : ''
  if (!evidence) return 'is a blocker with no evidence; a blocker cites a command in commandsRun that shows the failure'
  const cited = citedCommands(evidence, commandsRun)
  if (!cited.length) return "is a blocker whose evidence names no command in commandsRun and quotes no line of any command's output; static inspection alone is major at most"
  if (!cited.some(c => commandFailed(c) || quotesOutput(evidence, c.outputTail))) {
    // c.ok !== false is redundant here (commandFailed already ruled that out above); kept for defensive symmetry.
    const named = cited.map(c => `${JSON.stringify(innerCommand(c.command))}, which ${c.exitCode === null && c.ok !== false ? 'did not complete' : 'exited 0'}`).join(', ')
    return `cites ${named}, and quotes none of its output`
  }
  return null
}
function enforceFallbackEvidence(result) {
  const commandsRun = Array.isArray(result.commandsRun) ? result.commandsRun : []
  const downgraded = []
  const issues = (Array.isArray(result.issues) ? result.issues : []).map((issue, index) => {
    if (issue.severity !== 'blocker') return issue
    const reason = blockerEvidenceProblem(issue, commandsRun)
    if (!reason) return issue
    downgraded.push({ index, reason })
    return { ...issue, severity: 'major', description: `[adversary-claude: downgraded from blocker, R12: ${reason}] ${issue.description}` }
  })
  const stillBlocked = issues.some(it => it.severity === 'blocker')
  const verdict = result.verdict === 'fail' && downgraded.length > 0 && !stillBlocked ? 'pass' : result.verdict
  return { ...result, issues, verdict, ...(downgraded.length ? { downgraded } : {}) }
}

// The second model's verdict, with the Claude fallback when codex-review could not review at all. Pushes what it
// launched onto `stages` so the pass records every agent it spent.
// subject, when given, replaces the task: { id, label, prompt(), fallbackPrompt(why) } for a level review.
async function runAdversary(task, impl, pass, baseBranch, ledger, launch, stages, subject) {
  const suffix = pass > 1 ? `:${pass}` : ''
  const id = subject ? subject.id : task.id
  stages.push('adversary')
  let adv = await launch(subject ? subject.prompt() : adversaryPrompt(task, impl, baseBranch, pass, ledger), agentOpts('adversary', task, { label: subject ? subject.label : `adversary:${task.id}${suffix}`, phase: 'Adversary', agentType: 'doug-flow:adversary', schema: ADVERSARY_SCHEMA }))
  // A null result means the agent itself failed (could not spawn, or returned nothing): record that, do not pass it.
  if (adv === null) adv = { ran: false, verdict: 'inconclusive', blocked: true, summary: '', issues: [], commandsRun: [], error: 'adversary agent returned nothing (spawn failure or no structured output)' }
  // codex-review could not review: a Claude adversary stands in when the plan allows it, so a missing Codex does not block.
  if (adversary.fallback && adversaryUnavailable(adv)) {
    const why = adv.error || 'no reason given'
    log(`${id} adversary could not run (${why}); falling back to a Claude adversary on ${adversary.fallback.model || 'the session model'}`)
    const opts = { label: subject ? `${subject.label}-fallback` : `adversary-fallback:${task.id}${suffix}`, phase: 'Adversary', agentType: 'doug-flow:adversary-claude', schema: ADVERSARY_SCHEMA }
    if (adversary.fallback.model) opts.model = adversary.fallback.model
    if (adversary.fallback.effort) opts.effort = adversary.fallback.effort
    stages.push('adversary-fallback')
    const fb = await launch(subject ? subject.fallbackPrompt(why) : fallbackAdversaryPrompt(task, impl, baseBranch, why, pass, ledger), opts)
    const used = { model: adversary.fallback.model || 'inherit', effort: adversary.fallback.effort || 'inherit', reason: why }
    // A fallback that returns nothing is still an absent review: record it, do not pass it.
    adv = fb ? { ...enforceFallbackEvidence(fb), fallback: used } : { ...adv, ran: false, fallback: used, error: `${why}; the fallback adversary returned nothing (spawn failure or no structured output)` }
  }
  if (adv && !adv.ran) log(`${id} adversary did not run: ${adv.error || 'no reason given'}`)
  else if (adv && adv.verdict === 'inconclusive') log(`${id} adversary inconclusive: ${adv.error || adv.summary}`)
  return adv
}

// ---- Crew (card crew-sizing) ---------------------------------------------------
// A task (or the plan) declares how many reviewers and adversaries read it; default one each. More coders is a
// split into more tasks, never a shared worktree, so the crew has no coders row. Researchers run before planning
// (the research skill) and are not launched here.
function crewOf(task) {
  const src = { ...((plan.crew && typeof plan.crew === 'object') ? plan.crew : {}), ...((task && task.crew && typeof task.crew === 'object') ? task.crew : {}) }
  const n = v => (Number.isInteger(v) && v > 0 ? v : 1)
  return { reviewers: n(src.reviewers), adversaries: n(src.adversaries) }
}

// One review out of several: every seat must approve, and every seat's issues are kept, so a finding one reviewer
// filed reaches the ledger where the fingerprint collapses a duplicate to one id. A seat that returned nothing is
// dropped; when no seat returned anything the stage returned nothing.
function mergeReviews(seats) {
  const got = seats.filter(Boolean)
  if (!got.length) return null
  if (got.length === 1 && seats.length === 1) return got[0]
  return {
    taskId: got[0].taskId,
    specCompliant: got.every(r => r.specCompliant),
    inScope: got.every(r => r.inScope),
    approve: got.every(r => r.approve),
    issues: got.flatMap(r => r.issues || []),
    seats: got.length,
  }
}

// One verdict out of several adversaries: a fail or a blocker from any seat blocks; the verdict is pass only when
// every seat that ran passed; a seat that could not run leaves ran=false only when none ran.
// Card adversary-usage-in-report: normalises an adversary result's usage/durationMs for the report (both the task
// entry and the level entry call this, so the shape can only drift in one place). usage is kept only when it is an
// object with numeric inputTokens/outputTokens (a fallback or crew seat that never touched codex-review has none);
// durationMs only when it is a number. Anything else normalises to null rather than being copied through as is.
function adversaryUsage(adv) {
  const u = adv && adv.usage && typeof adv.usage === 'object' && typeof adv.usage.inputTokens === 'number' && typeof adv.usage.outputTokens === 'number' ? adv.usage : null
  const d = adv && typeof adv.durationMs === 'number' ? adv.durationMs : null
  return { usage: u, durationMs: d }
}

function mergeAdversaries(seats) {
  const got = seats.filter(Boolean)
  if (!got.length) return null
  if (got.length === 1 && seats.length === 1) return got[0]
  const ran = got.filter(a => a.ran)
  const verdict = ran.some(a => a.verdict === 'fail') ? 'fail' : ran.length && ran.every(a => a.verdict === 'pass') ? 'pass' : 'inconclusive'
  const first = got[0]
  // A seat's blocking rule (card fix-loop-minor-verdict) is evaluated on its own before the issues are merged: a
  // seat that ran and would block alone (adversaryOk) but raised no blocker issue of its own (a fail with an
  // empty issues array) gets one synthesized here from its summary, the same one stageFindings would synthesize
  // for a lone adversary. Without this, flattening its empty issues alongside another seat's non-blocking minor
  // issue leaves the merged array non-empty with no blocker, and adversaryBlocking reads that as pass-with-notes
  // even though this seat alone should have blocked.
  const issues = got.flatMap((a, i) => {
    const own = a.issues || []
    if (a.ran && !adversaryOk(a, true) && !own.some(x => x.severity === 'blocker')) {
      return [...own, { severity: 'blocker', file: '', description: a.summary || `seat ${i + 1} failed with no issue reported`, evidence: null }]
    }
    return own
  })
  // Card adversary-usage-in-report: usage/durationMs are per-agent, not additive across seats reviewing the same
  // diff on different models, so the merged result carries the values of the first seat that has usage (the
  // configured review, seat 1, when codex-review actually ran for it) rather than summing or dropping them.
  // adversaryUsage(usageSeat || {}) always yields explicit usage/durationMs keys (null, null when no seat has
  // usage), so the merged shape never drops them the way a conditional spread would.
  const usageSeat = got.find(a => adversaryUsage(a).usage)
  return {
    taskId: first.taskId,
    ran: ran.length > 0,
    verdict,
    summary: got.map((a, i) => `seat ${i + 1}: ${a.summary || (a.ran ? a.verdict : 'did not run')}`).join(' | '),
    issues,
    commandsRun: got.flatMap(a => a.commandsRun || []),
    error: ran.length ? null : (got.find(a => a.error) || {}).error || null,
    ...(first.fallback ? { fallback: first.fallback } : {}),
    ...adversaryUsage(usageSeat || {}),
    seats: got.length,
  }
}

// The crew's adversaries: seat 1 is the configured review (Codex through its relay, with the Claude fallback when it
// cannot run); each further seat is the Claude adversary on adversary.crewModel, a different model reading the same
// diff at the same time. Every seat is pushed onto `stages` so the pass records every agent it spent.
async function runAdversaryCrew(task, impl, pass, baseBranch, ledger, launch, stages) {
  const crew = crewOf(task)
  const suffix = pass > 1 ? `:${pass}` : ''
  const seatModel = (adversary && adversary.crewModel) || {}
  const thunks = [() => runAdversary(task, impl, pass, baseBranch, ledger, launch, stages)]
  for (let seat = 2; seat <= crew.adversaries; seat++) {
    const opts = { label: `adversary-${seat}:${task.id}${suffix}`, phase: 'Adversary', agentType: 'doug-flow:adversary-claude', schema: ADVERSARY_SCHEMA }
    if (seatModel.model) opts.model = seatModel.model
    if (seatModel.effort) opts.effort = seatModel.effort
    // Pushed inside the thunk, after seat 1 has pushed its own stage, so the pass records the seats in launch order.
    thunks.push(() => {
      stages.push(`adversary-${seat}`)
      // card crew-seat-blocker-evidence: this seat's result gets the same R12 evidence check as the fallback in
      // runAdversary, before mergeAdversaries sees it, so an evidence-free blocker downgrades here too.
      return launch(fallbackAdversaryPrompt(task, impl, baseBranch, `crew seat ${seat} of ${crew.adversaries}: a second adversary on a different model, reading the diff alongside codex-review`, pass, ledger), opts)
        .then(res => (res ? enforceFallbackEvidence(res) : res))
    })
  }
  if (thunks.length === 1) return thunks[0]()
  const seats = await parallel(thunks)
  return mergeAdversaries(seats || [])
}

// The one check stands in for both stages, so the rest of the loop and the report read it as they read them.
function readCheck(check) {
  const blocker = (check.issues || []).some(i => i.severity === 'blocker')
  return {
    ver: { taskId: check.taskId, passed: check.passed, commandsRun: check.commandsRun || [], findings: check.findings || [], findingFiles: Array.isArray(check.findingFiles) ? check.findingFiles : [], acceptance: Array.isArray(check.acceptance) ? check.acceptance : [] },
    rev: { taskId: check.taskId, specCompliant: check.passed, inScope: check.inScope, approve: !!(check.passed && check.inScope && !blocker), issues: check.issues || [] },
  }
}

// A pass is blocked by the adversary only when a review that actually ran returned a blocking verdict. An absent
// review (codex missing, the agent returned nothing) still keeps the task out of integration through isReady, but
// there is no adversarial review to point a fix pass at, so it is not recorded as the blocking stage.
function adversaryBlocked(adv) {
  return !!(adv && adv.ran) && !adversaryOk(adv, !!adversary)
}

// card workflow-reads-commit-from-git: the implementer's claimed commit is not trusted (it can invent a hash whose
// short prefix matches the real head, and replan's full-hash compare then treats a passed branch as stale). The
// verifier and the focused check both run `git rev-parse HEAD` in the worktree as their first step and report it as
// `head`; stageHead picks the one from whichever stage ran last on this pass (the check, when there is one, since a
// fix pass runs it after the verifier) as the recorded commit. Only a canonical 40-hex head counts: git's own output
// carries a trailing newline, and an agent could paste the abbreviated form instead of the full one, and either one
// recorded verbatim would make lib/plan.mjs's verbatim replan compare print the very "is not the recorded commit;
// re-implementing" this card exists to delete. A candidate that is not exactly 40 hex characters once trimmed is no
// head from that stage (falls through to the next, then to the implementer's claimed commit for display only), and
// the mismatch log below fires only for a canonical head. It is `head` being required in both schemas (R1), not the
// absence of a verifier result, that keeps a passing verifier or check from reaching this fallback: a stage that ran
// and returned a result always carries a head field, canonical or not. Only a stage that returned nothing at all
// (older fakes, a dead agent) or returned a non-canonical head falls back, and a pass on the fallback is not reused
// by lib/plan.mjs's replan (`passedAttempt`) unless the implementer's claimed commit happens to equal the real head.
function stageHead(ver, check) {
  const canonical = x => {
    const h = x && typeof x.head === 'string' ? x.head.trim() : ''
    return /^[0-9a-f]{40}$/.test(h) ? h : null
  }
  return canonical(check) || canonical(ver) || null
}

// baseBranch is a parameter, not the outer binding, so this block can be built and exercised on its own.
// ctx: { ledger, launch, lead, prevCommit, blocking }. On pass 1 the verifier and the reviewer both run and the
// adversary follows when both passed. On a fix pass only the stage that blocked reruns, then the focused check,
// then the adversary; the first stage that blocks ends the pass.
async function runChecks(task, impl, pass, baseBranch, ctx) {
  const c = ctx || {}
  const ledger = c.ledger || []
  const launch = c.launch || agent
  const stages = Array.isArray(c.lead) ? [...c.lead] : c.lead ? [c.lead] : []
  const stageResults = {}
  let ver = null
  let rev = null
  let adv = null
  let check = null
  let blockingStage = null
  const suffix = pass > 1 ? `:${pass}` : ''
  if (pass === 1 && taskShape(task) === 'S') {
    // Size S: one focused check on the verify row does the verifier's and the reviewer's work; no adversary here.
    stages.push('check')
    check = await launch(sizeCheckPrompt(task, impl, baseBranch), agentOpts('verify', task, { label: `check:${task.id}`, phase: 'Verify', agentType: 'doug-flow:verifier', schema: CHECK_SCHEMA }))
    stageResults.check = check
    if (check) ({ ver, rev } = readCheck(check))
    blockingStage = !(check && check.passed && rev && rev.approve) ? 'check' : null
  } else if (pass === 1) {
    // The verifier and the reviewer are both read-only and neither reads the other's result, so a first pass
    // launches them together; a null from either (skipped, or dead after retries) is that stage returning nothing.
    stages.push('verify')
    stages.push('review')
    const crew = crewOf(task)
    for (let seat = 2; seat <= crew.reviewers; seat++) stages.push(`review-${seat}`)
    const pair = await parallel([
      () => launch(verifyPrompt(task, impl, baseBranch), agentOpts('verify', task, { label: `verify:${task.id}`, phase: 'Verify', agentType: 'doug-flow:verifier', schema: VERIFY_SCHEMA })),
      () => launch(reviewPrompt(task, impl, baseBranch), agentOpts('review', task, { label: `review:${task.id}`, phase: 'Review', agentType: 'doug-flow:reviewer', schema: REVIEW_SCHEMA })),
      ...Array.from({ length: crew.reviewers - 1 }, (_, i) => () => launch(reviewPrompt(task, impl, baseBranch, i + 2), agentOpts('review', task, { label: `review-${i + 2}:${task.id}`, phase: 'Review', agentType: 'doug-flow:reviewer', schema: REVIEW_SCHEMA }))),
    ])
    ver = (pair && pair[0]) || null
    rev = pair ? mergeReviews(pair.slice(1)) : null
    stageResults.verify = ver
    stageResults.review = rev
    // Only changes that already passed verification and review are worth a second model's time.
    if (adversary && ver && ver.passed && rev && rev.approve) {
      adv = await runAdversaryCrew(task, impl, pass, baseBranch, ledger, launch, stages)
      stageResults.adversary = adv
    }
    blockingStage = !(ver && ver.passed) ? 'verify' : !(rev && rev.approve) ? 'review' : adversaryBlocked(adv) ? 'adversary' : null
  } else {
    const first = c.blocking || 'verify'
    const order = [first, ...['check', 'adversary'].filter(s => s !== first)]
    for (const stage of order) {
      if (stage === 'adversary' && !adversaryRequired(task)) continue
      if (stage === 'verify') {
        stages.push('verify')
        ver = await launch(verifyPrompt(task, impl, baseBranch), agentOpts('verify', task, { label: `verify:${task.id}${suffix}`, phase: 'Verify', agentType: 'doug-flow:verifier', schema: VERIFY_SCHEMA }))
        stageResults.verify = ver
        if (!(ver && ver.passed)) { blockingStage = 'verify'; break }
      } else if (stage === 'review') {
        stages.push('review')
        const crew = crewOf(task)
        for (let seat = 2; seat <= crew.reviewers; seat++) stages.push(`review-${seat}`)
        const seats = await parallel(Array.from({ length: crew.reviewers }, (_, i) => () => launch(reviewPrompt(task, impl, baseBranch, i + 1), agentOpts('review', task, { label: `review${i ? `-${i + 1}` : ''}:${task.id}${suffix}`, phase: 'Review', agentType: 'doug-flow:reviewer', schema: REVIEW_SCHEMA }))))
        rev = mergeReviews(seats || [])
        stageResults.review = rev
        if (!(rev && rev.approve)) { blockingStage = 'review'; break }
      } else if (stage === 'check') {
        stages.push('check')
        check = await launch(checkPrompt(task, impl, c.prevCommit || null, baseBranch, ledger), agentOpts('verify', task, { label: `check:${task.id}:${pass}`, phase: 'Verify', agentType: 'doug-flow:verifier', schema: CHECK_SCHEMA }))
        stageResults.check = check
        // The one check stands in for both stages, so the rest of the loop and the report read it as they read them.
        if (check) ({ ver, rev } = readCheck(check))
        if (!(check && check.passed && rev && rev.approve)) { blockingStage = 'check'; break }
      } else {
        adv = await runAdversaryCrew(task, impl, pass, baseBranch, ledger, launch, stages)
        stageResults.adversary = adv
        if (!adversaryOk(adv, !!adversary)) { if (adversaryBlocked(adv)) blockingStage = 'adversary'; break }
      }
    }
  }
  const head = stageHead(ver, check)
  if (head && impl.commit && head !== impl.commit) log(`${task.id} pass ${pass}: implementer reported commit ${impl.commit} but the worktree head is ${head}; recording the head`)
  return { task, impl, ver, rev, adv, check, pass, stages, stageResults, blockingStage, commit: head || impl.commit || null }
}

// resume, when given, is a task result the level adversary blocked after integration: { impl, ver, rev, adv, commit,
// pass, attempts, ledger }. Its blockers enter the ledger as the adversary stage of a new pass and the loop below fixes
// them the way it fixes any adversary block.
// ---- The fix-loop supervisor (card fix-loop-supervisor) ----------------------
// The two stall signals, read from the ledger and the pass that just ended (r): a finding still open after a fix
// pass targeted it (or one that came back), and a fix pass that touched a file whose findings an earlier pass had
// already cleared while nothing on that file was open. Deterministic, so the report can be checked against it.
function stallSignals(ledger, r) {
  const pass = r.pass
  const entries = ledger || []
  const range = (from, to) => { const out = []; for (let i = from; i <= to; i++) out.push(i); return out }
  const out = []
  for (const e of entries) {
    if (e.status !== 'open') continue
    if (e.reappeared) out.push({ kind: 'repeat', finding: e.id, passes: range(Math.min(e.openedPass, pass), pass), reappeared: true })
    else if (e.openedPass < pass) out.push({ kind: 'repeat', finding: e.id, passes: range(e.openedPass, pass) })
  }
  const touched = r.impl && Array.isArray(r.impl.filesTouched) ? r.impl.filesTouched : []
  for (const f of touched) {
    const cleared = entries.filter(e => e.file === f && Number.isInteger(e.fixedPass) && e.fixedPass < pass)
    if (!cleared.length) continue
    const openGoingIn = entries.some(e => e.file === f && e.openedPass < pass && (e.status === 'open' || (Number.isInteger(e.fixedPass) && e.fixedPass >= pass)))
    if (openGoingIn) continue
    out.push({ kind: 're-attack', file: f, clearedPass: Math.max(...cleared.map(e => e.fixedPass)), pass })
  }
  return out
}

// The commands a pass ran, across its stages, as { command, exitCode } for the supervisor to read.
function passCommands(r) {
  const out = []
  for (const stage of [r.impl, r.ver, r.rev, r.check, r.adv]) {
    for (const c of (stage && Array.isArray(stage.commandsRun) ? stage.commandsRun : [])) {
      if (!c || typeof c !== 'object') continue
      const exitCode = Number.isInteger(c.exitCode) ? c.exitCode : typeof c.ok === 'boolean' ? (c.ok ? 0 : 1) : null
      out.push({ command: String(c.command == null ? '' : c.command), exitCode })
    }
  }
  return out
}

// One line per signal for a stop reason.
function describeStall(signals) {
  return signals.map(x => x.kind === 're-attack' ? `${x.file} re-attacked on pass ${x.pass} after being cleared on pass ${x.clearedPass}` : `${x.finding} still open after ${x.passes.length} passes`).join('; ')
}

// The brief the loop writes itself when the supervisor returned nothing: the evidence, and directions that at least
// change what the next pass does first.
function fallbackBrief(signals, attempts, ledger) {
  const lines = [`The supervisor returned no brief; this is the loop's own reading of the passes.`]
  for (const x of signals) {
    if (x.kind === 're-attack') lines.push(`- ${x.file} was cleared on pass ${x.clearedPass} and pass ${x.pass} changed it again with nothing open on it.`)
    else {
      const e = (ledger || []).find(y => y.id === x.finding)
      lines.push(`- ${x.finding} open after passes ${x.passes.join(', ')}${e ? ` [${e.stage}] ${e.file || '(no file)'}: ${String(e.description).slice(0, 120)}` : ''}${x.reappeared ? ' (reappeared after being fixed)' : ''}`)
    }
  }
  const tried = attempts.filter(a => (a.stages || []).includes('fix')).map(a => `pass ${a.pass} (commit ${a.commit ? String(a.commit).slice(0, 7) : 'none'}, blocked at ${a.blockingStage || 'no stage'})`)
  if (tried.length) lines.push(`Fix passes so far: ${tried.join('; ')}.`)
  lines.push(`Directions:`)
  lines.push(`1. Re-read the failing command's output and the finding's evidence before changing any code, and state in the commit message what the earlier fix misread.`)
  lines.push(`2. Change a different part of the code than the last pass touched; if the finding is in a test, make the code satisfy the test rather than adjusting how it is exercised.`)
  lines.push(`3. Write the smallest failing check for the open finding first, run it, then fix it.`)
  return lines.join('\n')
}

// The single retry every stage agent() call gets, wherever it is launched from (a task's own pipeline or the level
// loop's integrate and level-adversary calls). A schema'd agent that ends without calling StructuredOutput makes
// agent() reject (the runtime's own five attempts already exhausted); a stopped, blocked, or API-failed agent
// resolves null instead and is never retried here, since a null resolution never reaches this catch. One retry with
// the same prompt and the same opts except `label`, which gets a `:retry` suffix so the progress view tells the two
// apart, unless the caller passes `retryPrompt` (card implementer-retry-own-branch: the implement and lead launches
// pass their own resume prompt, so the relaunch picks up its predecessor's own-run branch instead of the first
// prompt's stale-branch refusal); a second rejection propagates unchanged for the caller's own handling. `who` names
// the task or level the line is logged under; `onRetry`, when given, runs once the retry is decided (a task counts
// the extra agent).
async function retryOnce(prompt, opts, who, onRetry, retryPrompt) {
  try {
    return await agent(prompt, opts)
  } catch (e) {
    const message = e && e.message ? e.message : e
    log(`${who} ${opts.label}: stage agent threw (${message}); retrying once`)
    if (onRetry) onRetry()
    return agent(retryPrompt !== undefined ? retryPrompt : prompt, { ...opts, label: `${opts.label}:retry` })
  }
}

async function runTask(task, baseBranch, resume) {
  const attempts = resume ? resume.attempts : []
  const ledger = resume ? resume.ledger : []
  const startedAt = runtimeSpend()
  const counted = { agents: 0 }
  // Every agent this task launches goes through here, so the budget counts what the task actually cost.
  const launch = (prompt, opts, retryPrompt) => {
    counted.agents += 1
    return retryOnce(prompt, opts, task.id, () => { counted.agents += 1 }, retryPrompt)
  }
  const measure = () => {
    const now = runtimeSpend()
    return {
      agents: counted.agents,
      tokens: now.tokens === null || startedAt.tokens === null ? null : now.tokens - startedAt.tokens,
      elapsedMs: now.elapsedMs === null || startedAt.elapsedMs === null ? null : now.elapsedMs - startedAt.elapsedMs,
    }
  }
  const budgetOf = () => {
    const spent = measure()
    const enforced = ['agents']
    if (spent.tokens !== null) enforced.push('tokens')
    if (spent.elapsedMs !== null) enforced.push('elapsedMs')
    return { limits: taskBudget, spent, enforced }
  }
  const record = (res, prev) => {
    const u = updateLedger(ledger, res, res.pass, !!(res.commit && res.commit !== prev))
    res.newFindings = u.opened
    res.fixedFindings = u.fixed
    res.reopened = u.reopened
    // Every entry still open after this pass, in the order they were raised: what keeps the task out of integration.
    res.openFindings = ledger.filter(e => e.status === 'open').map(e => e.id)
    // Card ledger-ignores-not-a-defect-notes: notes dropped this pass, so the report still shows them (attempts.push).
    res.droppedFindings = u.dropped
    return res
  }
  const lead = task.reuse ? 'reuse' : 'implement'
  let r
  if (resume) {
    // The integrator removed the task's worktree when the level merged (integrate step 4), so a fix pass here
    // cannot be sent back to it: worktreeGone makes the pass start in a fresh worktree on the task branch.
    r = { task, impl: resume.impl, ver: resume.ver, rev: resume.rev, adv: resume.adv, check: null, pass: resume.pass + 1, stages: ['level-adversary'], stageResults: { 'level-adversary': resume.adv }, blockingStage: 'adversary', commit: resume.commit, worktreeGone: true }
    record(r, resume.commit)
  } else {
    const first = await startTask(task, baseBranch, launch)
    if (first && first.blocked) log(`${task.id} blocked: ${first.blockedReason || 'no reason given'}`)
    // A swarm's first pass spent a lead, its workers, and a merge; the pass records each of them.
    const leadStages = first && Array.isArray(first.swarmStages) ? first.swarmStages : [lead]
    r = !first
      ? { task, impl: null, ver: null, rev: null, adv: null, check: null, pass: 1, stages: leadStages, stageResults: {}, blockingStage: null, commit: null }
      : first.blocked || first.partial
        ? { task, impl: first, ver: null, rev: null, adv: null, check: null, pass: 1, stages: leadStages, stageResults: {}, blockingStage: null, commit: first.commit || null }
        : await runChecks(task, first, 1, baseBranch, { ledger, launch, lead: leadStages })
    record(r, null)
  }
  while (true) {
    const ready = isReady(r)
    const decision = ready ? null : retriable(task, r)
    attempts.push({
      pass: r.pass,
      stages: r.stages,
      commit: r.commit,
      blockingStage: r.blockingStage,
      verified: !!(r.ver && r.ver.passed),
      reviewed: !!(r.rev && r.rev.approve),
      adversary: r.adv ? { ran: r.adv.ran, verdict: r.adv.verdict, blocked: !adversaryOk(r.adv, adversaryRequired(task)), summary: r.adv.summary, ...(r.adv.fallback ? { fallback: r.adv.fallback } : {}) } : null,
      newFindings: r.newFindings || [],
      fixedFindings: r.fixedFindings || [],
      notes: r.droppedFindings || [],
      ready,
      retriable: decision,
      spent: measure(),
      commands: passCommands(r),
    })
    // The last supervisor that ran on this task, for the report; null when none did.
    const lastSupervisor = () => { for (let i = attempts.length - 1; i >= 0; i--) if (attempts[i].supervisor) return attempts[i].supervisor; return null }
    if (ready) return { ...r, attempts, ledger, budget: budgetOf(), stopReason: null, stopClass: null, supervisor: lastSupervisor() }
    const why = notReadyWhy(r)
    const halt = (stopClass, reason) => {
      for (const e of ledger) if (e.status === 'open') log(`${task.id} open finding ${e.id} [${e.stage}] ${e.file || '(no file)'}: ${String(e.description).slice(0, 120)}`)
      return { ...r, attempts, ledger, budget: budgetOf(), stopReason: reason, stopClass, supervisor: lastSupervisor() }
    }
    if (!decision.ok) return halt(decision.stopClass, `${why}; not retried: ${decision.reason}`)
    // Two passes in a row that each raise a blocker nobody had seen means the checks are exploring, not converging.
    const last = attempts[attempts.length - 1]
    const prior = attempts[attempts.length - 2]
    if (prior && last.newFindings.length && prior.newFindings.length) {
      return halt('new-blockers-twice', `${why}; stopped: two consecutive passes raised new blockers (${prior.newFindings.join(', ')}; ${last.newFindings.join(', ')})`)
    }
    if (attempts.length > fixAttempts) return halt('fix-attempts-exhausted', `${why}; fix attempts exhausted (${fixAttempts} of ${fixAttempts})`)
    // The supervisor (card fix-loop-supervisor): before a fix pass after the first, when the stall signals fire. A
    // pass that returned no result attacked nothing, so it is not a stall. A task stalled a second time stops here
    // instead of spending the remaining fix budget; otherwise the supervisor runs after the budget check below, on
    // the supervise tier, spending one agent the projection counts, and its brief goes into the next fix prompt. It
    // changes no verdict: the ledger is untouched, and the stop is the loop's.
    const signals = r.pass >= 2 && !r.noResult ? stallSignals(ledger, r) : []
    const lastAttempt = attempts[attempts.length - 1]
    if (signals.length && attempts.some(a => a.supervisor && a.supervisor.stalled)) {
      const findings = [...new Set(signals.filter(x => x.kind === 'repeat').map(x => x.finding))]
      lastAttempt.supervisor = { ran: false, stalled: true, brief: null, signals, stop: { kind: 'stalled', attempts: attempts.length, findings } }
      return halt('stalled', `${why}; stopped: stalled twice (${describeStall(signals)})`)
    }
    const blocking = r.blockingStage || 'verify'
    // What the next pass would cost: the fix agent plus the stages rule 3 would run. The adversary stage spends two
    // agents only when the previous pass actually fell back to the Claude adversary (codex-review could not review,
    // so the stand-in launched too); a fallback that is merely configured costs nothing, and counting it would stop
    // fix passes the budget can pay for.
    const fellBack = (r.stages || []).includes('adversary-fallback')
    const crew = crewOf(task)
    const advAgents = adversaryRequired(task) ? (fellBack ? 1 : 0) + crew.adversaries : 0
    const firstStage = blocking === 'adversary' ? advAgents : blocking === 'review' ? crew.reviewers : 1
    const nextStages = firstStage + (blocking === 'check' ? 0 : 1) + (blocking === 'adversary' ? 0 : advAgents)
    const spent = measure()
    const passesDone = attempts.length
    let over = null
    const projectedAgents = spent.agents + 1 + nextStages + (signals.length ? 1 : 0)
    if (projectedAgents > taskBudget.agents) over = `agents ${projectedAgents} > ${taskBudget.agents}`
    // The mean per completed pass is added unrounded: rounding it down lets a projection that clears the limit
    // only by a fraction launch a pass the budget cannot pay for. Only the printed number is rounded.
    const show = n => (Number.isInteger(n) ? String(n) : n.toFixed(2))
    if (!over && spent.tokens !== null) {
      const projected = spent.tokens + spent.tokens / passesDone
      if (projected > taskBudget.tokens) over = `tokens ${show(projected)} > ${taskBudget.tokens}`
    }
    if (!over && spent.elapsedMs !== null) {
      const limit = taskBudget.wallMinutes * 60000
      const projected = spent.elapsedMs + spent.elapsedMs / passesDone
      if (projected > limit) over = `elapsedMs ${show(projected)} > ${limit}`
    }
    if (over) return halt('budget', `${why}; stopped: next attempt would exceed the task budget (${over})`)
    const pass = r.pass + 1
    let brief = null
    if (signals.length) {
      let result = null
      try {
        result = await launch(supervisePrompt(task, r, attempts, ledger, signals), agentOpts('supervise', task, { label: `supervise:${task.id}:${pass}`, phase: 'Implement', schema: SUPERVISE_SCHEMA }))
      } catch (e) {
        log(`${task.id} supervisor threw: ${e && e.message ? e.message : e}`)
      }
      const ran = !!(result && typeof result === 'object')
      const directions = ran && Array.isArray(result.directions) ? result.directions.filter(d => typeof d === 'string' && d.trim()) : []
      brief = ran && typeof result.brief === 'string' && result.brief.trim()
        ? [result.brief.trim(), ...(directions.length ? ['Directions:', ...directions.map((d, i) => `${i + 1}. ${d.trim()}`)] : [])].join('\n')
        : fallbackBrief(signals, attempts, ledger)
      lastAttempt.supervisor = { ran, stalled: true, brief, signals, stop: null }
      log(`${task.id} stalled (${describeStall(signals)}); supervisor ${ran ? 'briefed' : 'returned nothing, loop briefed'} the next fix pass`)
    }
    const prevCommit = r.commit
    // The worktree is gone once the level integrated: then the pass gets a fresh one from the runtime, the way the
    // first implement pass does, and the prompt checks the task branch out in it. Otherwise no isolation key:
    // `isolation: 'worktree'` would make a fresh worktree. Without it the agent runs from the repository root like
    // the verifier and reviewer, and the prompt sends it into the existing worktree.
    const fresh = !!r.worktreeGone
    log(`${task.id} ${why}; fix attempt ${pass - 1} of ${fixAttempts} in ${fresh ? `a new worktree on ${r.impl.branch} (${r.impl.worktreePath} went with the level's integration)` : r.impl.worktreePath}`)
    let fix = null
    let failure = null
    try {
      fix = await launch(fixPrompt(task, r, pass, baseBranch, ledger, brief), agentOpts('implement', task, { label: `fix:${task.id}:${pass}`, phase: 'Implement', ...(fresh ? { isolation: 'worktree' } : {}), agentType: 'doug-flow:implementer', schema: IMPLEMENT_SCHEMA }))
    } catch (e) {
      // An implementer that ends without calling StructuredOutput makes agent() throw. Letting that out of the
      // task would drop the whole task to null (branch lost, attempts lost, 'task stage threw'); it is a pass.
      failure = e
    }
    if (!fix) {
      // No structured result: nothing for a check to look at, but the branch and worktree the loop knows are
      // untouched, so this is a retriable block on the pass, not the end of the task. The next pass sees the same
      // open findings; the report keeps the branch for replan.
      const reason = 'implementer returned no structured result'
      log(`${task.id} fix pass ${pass}: ${reason}${failure ? ` (${failure && failure.message ? failure.message : failure})` : ''}; keeping branch ${r.impl.branch}`)
      r = record({ task, impl: r.impl, ver: null, rev: null, adv: null, check: null, pass, stages: ['fix'], stageResults: {}, blockingStage: r.blockingStage, commit: prevCommit, noResult: reason, worktreeGone: r.worktreeGone }, prevCommit)
      continue
    }
    const worktreePath = fresh && fix.worktreePath ? fix.worktreePath : r.impl.worktreePath
    // The fix result decides the pass on its own: a blocked fix or a branch still on the previous commit both mean
    // the pass produced nothing for a check to look at. Run no stage and stop here. A blocked fix keeps the
    // implementer-blocked reason; the other reports the empty pass.
    const fixBlocked = !!fix.blocked
    if (fixBlocked || !fix.commit || fix.commit === prevCommit) {
      // The swarm (if any) ran in the first pass; a fix pass is one implementer, so `fix` itself carries none of
      // workers/swarmStages/splitReason/rebrief. Without carrying them forward, a fixed swarmed task's report loses
      // its swarm record on the very pass that made it converge (card swarm-topology review, then candidate 2).
      const impl = { ...fix, branch: r.impl.branch, worktreePath, ...(r.impl.workers ? { workers: r.impl.workers, swarmStages: r.impl.swarmStages, splitReason: r.impl.splitReason, rebrief: r.impl.rebrief, checkFailed: r.impl.checkFailed } : {}) }
      r = record({ task, impl, ver: null, rev: null, adv: null, check: null, pass, stages: ['fix'], stageResults: {}, blockingStage: null, commit: fix.commit || null }, prevCommit)
      const decided = fixBlocked ? retriable(task, r) : null
      attempts.push({ pass, stages: ['fix'], commit: r.commit, blockingStage: null, verified: false, reviewed: false, adversary: null, newFindings: r.newFindings || [], fixedFindings: r.fixedFindings || [], notes: r.droppedFindings || [], ready: false, retriable: decided, spent: measure(), commands: passCommands(r) })
      return fixBlocked ? halt(decided.stopClass, `${notReadyWhy(r)}; not retried: ${decided.reason}`) : halt('no-new-commit', `${why}; stopped: fix pass ${pass} made no new commit on ${impl.branch}`)
    }
    const next = { ...fix, branch: r.impl.branch, worktreePath, prevCommit, ...(r.impl.workers ? { workers: r.impl.workers, swarmStages: r.impl.swarmStages, splitReason: r.impl.splitReason, rebrief: r.impl.rebrief, checkFailed: r.impl.checkFailed } : {}) }
    r = record(await runChecks(task, next, pass, baseBranch, { ledger, launch, lead: 'fix', prevCommit, blocking }), prevCommit)
  }
}

// One adversarial review of a level's size-S tasks on the integration branch; the same relay, fallback, and verdict
// rules as a task's adversary. `tasks` names what it reviewed.
async function runLevelAdversary(li, sReady, levelBase, confirming) {
  const subject = {
    id: `level-${li}`,
    label: `adversary:level-${li}${confirming ? ':confirm' : ''}`,
    prompt: () => levelAdversaryPrompt(li, sReady, levelBase, confirming),
    fallbackPrompt: why => levelFallbackAdversaryPrompt(li, sReady, levelBase, why, confirming),
  }
  const adv = await runAdversary(null, null, 1, levelBase, [], (p, o) => retryOnce(p, o, `level-${li}`), [], subject)
  return { ran: !!(adv && adv.ran), verdict: adv ? adv.verdict : 'inconclusive', blocked: !adversaryOk(adv, true), summary: adv ? adv.summary : '', issues: (adv && adv.issues) || [], commandsRun: (adv && adv.commandsRun) || [], error: (adv && adv.error) || null, tasks: sReady.map(r => r.task.id), ...adversaryUsage(adv), ...(adv && adv.fallback ? { fallback: adv.fallback } : {}) }
}

// ---- Run -----------------------------------------------------------------------
const levels = levelize(plan.tasks)
log(`Plan "${plan.title}": ${plan.tasks.length} tasks in ${levels.length} level(s). Integration branch ${integrationBranch}.`)
log(`Per-task budget: ${taskBudget.agents} agents, ${taskBudget.tokens} tokens, ${taskBudget.wallMinutes} minutes; up to ${fixAttempts} fix attempts.`)

const report = { plan: plan.title, integrationBranch, modelsSource: (plan.models && plan.models.source) || null, budget: taskBudget, swarm: { on: plan.swarm === true, workerCheck: plan.workerCheck === true }, levels: [] }

// A task counts towards a successful run only when the loop let it through: a stopped task carries a stopReason (an
// unfixed blocker, a fix that changed nothing, a reappeared finding, an exhausted budget) and never reached
// integration, so the stage booleans alone - which a reopened finding leaves all true - must not read as success.
function taskSucceeded(t) {
  return !t.stopReason && t.implemented && t.verified && t.reviewed && !(t.adversary && t.adversary.blocked)
}
let baseBranch = plan.baseBranch || 'HEAD'
// The ids that actually reached the integration branch. A task whose dependency is not in here is building on
// ground that does not exist, so it is not launched at all.
const integrated = new Set()
// Whether this run has integrated yet, so integratePrompt knows when to treat the worktree as a possible
// leftover from an earlier run rather than trusting it. Tracked explicitly rather than assumed from li === 0
// so it stays right regardless of level shape, and so the :2 re-integration (always passed false) never recreates.
let integratedOnce = false

for (let li = 0; li < levels.length; li++) {
  const level = levels[li]
  log(`Level ${li}: ${level.map(t => t.id).join(', ')}`)

  for (const t of level) if (t.reuse) log(`${t.id}: reusing ${t.reuse}; no implementer`)

  // A dependency that did not integrate makes the dependent task unrunnable: its base does not carry the work it
  // was written against, so launching it only spends agents to fail. Record it and let the level integrate the rest.
  const runnable = []
  const skipped = new Map()
  for (const t of level) {
    const missing = (t.dependsOn || []).filter(d => !integrated.has(d))
    if (!missing.length) {
      runnable.push(t)
      continue
    }
    const reason = missing.length > 1 ? `dependencies ${missing.join(', ')} were not integrated` : `dependency ${missing[0]} was not integrated`
    log(`${t.id} not launched: ${reason}`)
    skipped.set(t, { task: t, impl: null, ver: null, rev: null, adv: null, check: null, attempts: [], ledger: [], budget: null, stages: [], stopReason: reason, stopClass: 'dependency-skipped', skippedReason: reason })
  }

  // Implement (or reuse) -> verify -> review -> adversary -> fix, per task, no barrier between tasks.
  const results = await pipeline(
    runnable,
    task => runTask(task, baseBranch),
  )

  // A stage that throws (agent error, unknown agent type, user skip) drops the item to null; keep the task in the report.
  // The fallback's impl carries the branch the task would have used (task.reuse when the task carries one, since a
  // reuse checkout works on that branch, not doug/task-<id>; doug/task-<id> otherwise, the convention every fresh
  // implement/lead prompt follows) so replan can find and retire it even though nothing here confirms a branch
  // was ever made; blocked:true keeps `implemented` false so reusePlan still refuses to reuse it.
  const threwFallback = task => {
    const reason = 'task stage threw (agent error, unknown agent type, or user skip)'
    return { task, impl: { taskId: task.id, branch: task.reuse || `doug/task-${task.id}`, worktreePath: '', filesTouched: [], commandsRun: [], summary: reason, blocked: true, blockedReason: reason, commit: null }, ver: null, rev: null, adv: null, check: null, attempts: [], ledger: [], budget: null, stopReason: reason, stopClass: 'stage-threw' }
  }
  const byTask = new Map(runnable.map((task, i) => [task, results[i] || threwFallback(task)]))
  const ready = level.map(task => byTask.get(task) || skipped.get(task)).filter(isReady)
  const notReady = level.map(task => byTask.get(task) || skipped.get(task)).filter(r => !ready.includes(r))
  // A task the dependency gate skipped already logged its one line there; logging it again here would say the
  // same thing twice for a task that was never launched.
  for (const r of notReady) if (!r.skippedReason) log(`${r.task.id} not integrated: ${r.stopReason}`)

  let integration = null
  let levelAdversary = null
  const levelBase = baseBranch
  const sReady = adversary ? ready.filter(r => taskShape(r.task) === 'S') : []
  if (ready.length) {
    integration = enforceIntegrationAcceptance(await retryOnce(integratePrompt(li, ready, baseBranch, li === levels.length - 1, sReady.length > 0, !integratedOnce), agentOpts('integrate', null, { label: `integrate:level-${li}`, phase: 'Integrate', schema: INTEGRATE_SCHEMA }), `level-${li}`), li === levels.length - 1, acceptanceEntries(plan.acceptance || []))
    integratedOnce = true
    if (integration && integration.ok) {
      baseBranch = integrationBranch
      for (const r of ready) integrated.add(r.task.id)
    }
  }
  // The size-S tasks of this level had no adversary of their own: one review of them together, on the integration
  // branch, after the merge. A blocker goes back to the task that owns its file as a fix pass, the fixed branches are
  // merged again, and the adversary confirms once; a level still blocked after that stops the run.
  if (integration && integration.ok && sReady.length) {
    levelAdversary = await runLevelAdversary(li, sReady, levelBase, false)
    if (levelAdversary.blocked) {
      const blockers = levelAdversary.issues.filter(i => i.severity === 'blocker')
      const items = blockers.length ? blockers : [{ severity: 'blocker', file: '', description: levelAdversary.summary || 'the level adversary blocked without an issue', evidence: null }]
      const perTask = new Map()
      const unowned = []
      for (const i of items) {
        const file = String(i.file || '').trim().replace(/^\.\//, '')
        const owner = file ? ready.find(r => ownsPath(r.task, file)) : null
        if (!owner) unowned.push(file || '(no file)')
        else perTask.set(owner, [...(perTask.get(owner) || []), i])
      }
      levelAdversary.fixed = []
      if (unowned.length) {
        levelAdversary.unowned = unowned
        log(`level ${li} adversary blocked on files no task of this level owns: ${unowned.join(', ')}; no fix pass`)
      } else {
        for (const [r, issues] of perTask) {
          log(`${r.task.id}: the level adversary blocked it (${issues.length} blocker${issues.length === 1 ? '' : 's'}); fix pass`)
          const adv = { ran: true, verdict: 'fail', summary: levelAdversary.summary, issues, commandsRun: levelAdversary.commandsRun, error: null }
          const again = await runTask(r.task, levelBase, { impl: r.impl, ver: r.ver, rev: r.rev, adv, commit: r.commit, pass: r.pass, attempts: r.attempts, ledger: r.ledger })
          byTask.set(r.task, again)
          levelAdversary.fixed.push({ task: r.task.id, ready: isReady(again), stopReason: again.stopReason, stopClass: again.stopClass || null })
        }
        const fixedReady = [...perTask.keys()].map(r => byTask.get(r.task)).filter(isReady)
        if (fixedReady.length === perTask.size) {
          const again = enforceIntegrationAcceptance(await retryOnce(integratePrompt(li, fixedReady, levelBase, li === levels.length - 1, true, false), agentOpts('integrate', null, { label: `integrate:level-${li}:2`, phase: 'Integrate', schema: INTEGRATE_SCHEMA }), `level-${li}`), li === levels.length - 1, acceptanceEntries(plan.acceptance || []))
          levelAdversary.reintegration = again
          // The re-integration is the final state of the branch, so its acceptance (not the first integration's)
          // is what the level report carries (card integration-acceptance-recorded, behaviour 4). Only
          // `acceptance` is copied onto the level's `integration`; a failed re-integration's own `ok` and
          // `reason` stay on `levelAdversary.reintegration`, not on the level report.
          if (integration && li === levels.length - 1 && again && typeof again === 'object') integration.acceptance = again.acceptance
          if (again && again.ok) levelAdversary.confirm = await runLevelAdversary(li, sReady.map(r => byTask.get(r.task) || r), levelBase, true)
        }
      }
      const cleared = !!(levelAdversary.confirm && !levelAdversary.confirm.blocked)
      if (!cleared) {
        for (const r of new Set([...sReady, ...perTask.keys()])) {
          const cur = byTask.get(r.task) || r
          if (!cur.stopReason) {
            cur.stopReason = levelAdversary.unowned ? `level adversary blocked on ${levelAdversary.unowned.join(', ')}: ${levelAdversary.summary}` : levelAdversary.confirm ? `level adversary still blocked after a fix pass: ${levelAdversary.confirm.summary}` : levelAdversary.reintegration ? 'the fixed branches did not integrate again' : `level adversary blocked: ${levelAdversary.summary}`
            cur.stopClass = 'level-adversary'
          }
          byTask.set(r.task, cur)
        }
        for (const r of ready) integrated.delete(r.task.id)
      }
    }
  }
  const done = level.map(task => byTask.get(task) || skipped.get(task))

  report.levels.push({
    index: li,
    tasks: done.map(r => ({
      id: r.task.id,
      implemented: !!r.impl && !r.impl.blocked,
      blockedReason: r.skippedReason || (r.impl && r.impl.blocked ? r.impl.blockedReason : null),
      // What the last pass ran, [] for a task that was never launched.
      stages: r.stages || [],
      verified: !!(r.ver && r.ver.passed),
      verifierFindings: r.ver ? r.ver.findings : [],
      acceptance: r.ver && Array.isArray(r.ver.acceptance) ? r.ver.acceptance : [],
      reviewed: !!(r.rev && r.rev.approve),
      reviewIssues: r.rev ? r.rev.issues : [],
      inScope: r.rev ? r.rev.inScope : null,
      // The ids of the lessons plan.mjs json recalled for this task and actually put in front of an implementer
      // (card memory-recall #2): [] when none matched, when the task reused an earlier branch (reusePrompt
      // carries no lessons), or when no implementer ever launched.
      memoryUsed: r.task.reuse || !r.impl ? [] : Array.isArray(r.task.lessonIds) ? r.task.lessonIds : [],
      // The ids of the code chunks plan.mjs json's semantic index search actually put in front of an implementer
      // (card semantic-index, brief B): [] when none matched, when the task reused an earlier branch (reusePrompt
      // carries no code context), or when no implementer ever launched.
      indexUsed: r.task.reuse || !r.impl ? [] : Array.isArray(r.task.codeContextIds) ? r.task.codeContextIds : [],
      adversary: r.adv ? { ran: r.adv.ran, verdict: r.adv.verdict, blocked: !adversaryOk(r.adv, adversaryRequired(r.task)), summary: r.adv.summary, issues: r.adv.issues, commandsRun: r.adv.commandsRun, error: r.adv.error, ...adversaryUsage(r.adv), ...(r.adv.fallback ? { fallback: r.adv.fallback } : {}) } : null,
      size: r.task.size || null,
      shape: taskShape(r.task),
      gate: r.task.gate || 'auto',
      branch: r.impl ? r.impl.branch : null,
      commit: r.commit || null,
      // Graceful degradation (card worker-context-handoff): true only when the task's own outcome is still partial
      // after its one resume; handoff is what a fresh worker (or plan.mjs replan) needs; resumed counts the extra
      // agent the resume itself spent.
      partial: !!(r.impl && r.impl.partial),
      handoff: (r.impl && r.impl.handoff) || null,
      resumed: (r.impl && r.impl.resumed) || 0,
      reused: r.task.reuse || null,
      card: r.task.card || null,
      crew: crewOf(r.task),
      // The swarm's workers when the plan opted in (brief, files, branch, commit, block per worker); null otherwise.
      workers: r.impl && Array.isArray(r.impl.workers) ? r.impl.workers : null,
      // Why this task did or did not run as a swarm (card swarm-topology); null on a plan that never opted in.
      swarm: swarmReport(r.task, r.impl),
      specHash: r.task.specHash || null,
      attempts: r.attempts,
      passes: r.attempts.length,
      stopReason: r.stopReason,
      stopClass: r.stopClass || null,
      // The fix-loop supervisor's last word on the task: ran, stalled, the brief it injected, and the stop when the
      // task stalled twice ({ kind: 'stalled', attempts, findings }); null when the loop never stalled.
      supervisor: r.supervisor || null,
      // What the task cost and what the checks are still holding against it.
      budget: r.budget || null,
      ledger: r.ledger || [],
      // What each stage ran on, so cost can be attributed to a tier. "inherit" = session model / role default effort.
      models: { implement: describeTier('implement', r.task), verify: describeTier('verify'), review: describeTier('review'), adversary: describeTier('adversary'), supervise: describeTier('supervise'), tier: r.task.tier || null, ...(r.task.reuse ? { checkout: { model: CHECKOUT_MODEL, effort: 'inherit' } } : {}), ...(plan.swarm === true ? { lead: describeTier('lead'), worker: describeTier('worker') } : {}) },
    })),
    integration,
    integrationModel: ready.length ? describeTier('integrate') : null,
    levelAdversary,
  })

  // A level that failed integration stops the run: later levels would build on broken ground. So does a level
  // adversary that is still blocked after its one fix pass.
  if (levelAdversary && levelAdversary.blocked && !(levelAdversary.confirm && !levelAdversary.confirm.blocked)) {
    log(`Level ${li} adversary blocked the level; stopping before level ${li + 1}.`)
    report.stoppedAtLevel = li
    break
  }
  if (ready.length && !(integration && integration.ok)) {
    log(`Level ${li} integration failed; stopping before level ${li + 1}.${integration && integration.reason ? ` ${integration.reason}` : ''}`)
    report.stoppedAtLevel = li
    break
  }
  if (!ready.length && level.length) {
    log(`Nothing in level ${li} was ready; stopping.`)
    report.stoppedAtLevel = li
    break
  }
  // A human gate (decision 0002 #2): a task with gate: 'human' pauses the run after its level has integrated, until
  // the user opens it (plan.gatesOpened names the level, plan.mjs gate open <n>) and resumes the run with its id;
  // the levels already run replay from the runtime's cache. The gate after the last level is the landing itself.
  if (li < levels.length - 1 && level.some(t => t.gate === 'human') && !(Array.isArray(plan.gatesOpened) && plan.gatesOpened.includes(li))) {
    log(`Level ${li} ends at a human gate; pausing before level ${li + 1} (${levels[li + 1].map(t => t.id).join(', ')}). Open it with plan.mjs gate open ${li} and resume the run with its id.`)
    report.paused = { level: li, gate: 'human', next: levels[li + 1].map(t => t.id) }
    break
  }
}

report.ok = report.stoppedAtLevel === undefined && !report.paused && report.levels.every(l => l.tasks.every(taskSucceeded))
return report
