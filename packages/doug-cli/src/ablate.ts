// `doug ablate`: success rate and mean cost per condition (baseline, gates, full) for an eval task set.
// With --from <file> it summarizes an existing evals/out result and spends nothing. Without it, it runs the
// repository's evals/run.mjs (real `claude -p` sessions, real tokens) and summarizes the file the runner wrote.
// Nothing is estimated: a session whose cost the runner could not read is counted, shown, and left out of the mean.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

export interface AblateIo {
  stdout(s: string): void;
  stderr(s: string): void;
}

export const ABLATE_USAGE = `Usage:
  doug ablate --from <evals/out/file.json> [--from <file> ...] [--json]
  doug ablate [dir] [--tasks a,b] [--conditions baseline,gates,full] [--runs <n>] [--max-turns <n>] [--suite <name>]
              [--max-budget-usd <n>] [--judge auto|codex|claude|off] [--judge-model <name>] [--dry-run] [--json]

With --from, existing results are summarized and nothing runs. Without it, <dir>/evals/run.mjs runs the task
set under each condition (real claude -p sessions, real tokens; --dry-run only prints its plan) and the result
file it writes to <dir>/evals/out is summarized. Success means the task's checks passed and every changed file
was in scope; mean cost is over the sessions whose cost the runner could read. A "memory" condition (card
memory-measure) is compared against "pipeline" on five measures, including mean turns, with a shipping verdict.
`;

export interface EvalResult {
  task: string;
  condition: string;
  run?: number;
  costUsd?: number | null;
  turns?: number | null;
  durationMs?: number | null;
  verified?: boolean;
  inScope?: boolean;
  success?: boolean;
  // The memory arm's wiring tripwire (card memory-measure): true only when every task that received recalled
  // lessons actually used at least one of them. Absent on every other condition.
  memoryWired?: boolean;
  // The hidden-test pass rate (card eval-accuracy): files copied in after mustPass runs, scored separately from
  // the acceptance set; null when the task carries no hidden set. Absent (not even a null key) on a result file
  // written before this card.
  hidden?: { total: number; passed: number; rate: number } | null;
  // The post-landing defect judge (card eval-accuracy): null when the judge was off or there was nothing to
  // judge. `error` is non-null only when the judge itself could not review (worktree-modified, spawn failure,
  // git failure); such a row is inconclusive and left out of every defects mean (see spreadOf below).
  defects?: {
    judge: string | null;
    verdict: string | null;
    blocker: number;
    major: number;
    minor: number;
    total: number;
    error: string | null;
  } | null;
}

// Shorthand for the non-null shapes above, used by the filters that build spreads and per-task means.
type EvalHidden = NonNullable<EvalResult["hidden"]>;
type EvalDefects = NonNullable<EvalResult["defects"]>;

export interface EvalFile {
  suite?: string;
  options?: { conditions?: string[] };
  results: EvalResult[];
}

export interface ConditionSummary {
  condition: string;
  sessions: number;
  successes: number;
  successRate: number;
  verified: number;
  inScope: number;
  priced: number;
  totalCostUsd: number;
  meanCostUsd: number | null;
  meanTurns: number | null;
  // Orchestration arms (card swarm-tiering-eval) are compared on these two as well.
  meanDurationMs: number | null;
  scopeViolations: number;
  // How many sessions of this condition carried memoryWired true (card memory-measure), out of `sessions`; null
  // when no result of this condition carries the field at all (every condition but memory).
  memoryWired: number | null;
  // Mean, min, max, and n for six measures over this condition's sessions (card eval-accuracy): success and
  // scopeViolations are 1/0 per session, cost is over priced sessions, wall is durationMs in minutes, hidden is
  // hidden.rate (sessions with hidden null left out), defects is defects.total (sessions with defects null, or
  // a non-null defects.error, left out — an inconclusive judge is never averaged in). null when nothing entered.
  spread: ConditionSpread;
  // How many of this condition's sessions actually entered the defects spread (non-null defects, null error);
  // null when no result of this condition carries a `defects` field at all (mirrors memoryWired's null-when-
  // absent design, so a file from before this card is indistinguishable from a run with the judge off).
  judged: number | null;
}

// One measure's spread over the sessions that carried a value for it; null when none did.
export interface Spread {
  mean: number;
  min: number;
  max: number;
  n: number;
}

export interface ConditionSpread {
  success: Spread | null;
  hidden: Spread | null;
  defects: Spread | null;
  scopeViolations: Spread | null;
  cost: Spread | null;
  wall: Spread | null;
}

export interface TaskSummary {
  task: string;
  condition: string;
  sessions: number;
  successes: number;
  meanCostUsd: number | null;
  meanHidden: number | null;
  meanDefects: number | null;
}

export interface Ablation {
  suite: string | null;
  sources: string[];
  sessions: number;
  tasks: string[];
  conditions: ConditionSummary[];
  byTask: TaskSummary[];
  unpriced: number;
}

// The three install conditions, then the orchestration arms in evals/run.mjs (compared against pipeline).
const CONDITION_ORDER = ["baseline", "gates", "full", "pipeline", "swarm", "swarm-cheap", "crew", "swarm-crew", "memory"];
const ARM_CONDITIONS = ["swarm", "swarm-cheap", "crew", "swarm-crew"];
// The memory arm (card memory-measure) is compared against pipeline separately from the other arms above: on
// five measures, not four (mean turns joins the other four), with its own swarm-rule verdict line.
const MEMORY_CONDITION = "memory";

function mean(values: number[]): number | null {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
}

// Mean, min, max, and n over any list of numbers (card eval-accuracy); null when the list is empty, so a caller
// never has to special-case "no sessions entered this measure" separately from the shape of the result.
export function spreadOf(values: number[]): Spread | null {
  if (!values.length) return null;
  return { mean: values.reduce((a, b) => a + b, 0) / values.length, min: Math.min(...values), max: Math.max(...values), n: values.length };
}

function priced(rs: EvalResult[]): number[] {
  return rs.map((r) => r.costUsd).filter((c): c is number => typeof c === "number" && Number.isFinite(c));
}

function orderConditions(seen: string[]): string[] {
  const known = CONDITION_ORDER.filter((c) => seen.includes(c));
  const rest = seen.filter((c) => !CONDITION_ORDER.includes(c));
  return [...known, ...rest];
}

// One summary over any number of result files (several runs of the same suite add up).
export function summarizeEval(files: { source: string; data: EvalFile }[]): Ablation {
  const results = files.flatMap((f) => (Array.isArray(f.data.results) ? f.data.results : []));
  const suites = [...new Set(files.map((f) => f.data.suite).filter((s): s is string => typeof s === "string"))];
  const conditionsSeen = [...new Set(results.map((r) => r.condition))];
  const conditions = orderConditions(conditionsSeen).map((condition): ConditionSummary => {
    const rs = results.filter((r) => r.condition === condition);
    const costs = priced(rs);
    const turns = rs.map((r) => r.turns).filter((t): t is number => typeof t === "number");
    const durations = rs.map((r) => r.durationMs).filter((d): d is number => typeof d === "number" && Number.isFinite(d));
    const successes = rs.filter((r) => r.success === true).length;
    const wiredResults = rs.filter((r) => typeof r.memoryWired === "boolean");
    const hiddenValues = rs
      .map((r) => r.hidden)
      .filter((h): h is EvalHidden => h != null)
      .map((h) => h.rate);
    const judgedRows = rs.map((r) => r.defects).filter((d): d is EvalDefects => d != null && d.error === null);
    const hasDefects = rs.some((r) => r.defects !== undefined);
    return {
      condition,
      sessions: rs.length,
      successes,
      successRate: rs.length ? successes / rs.length : 0,
      verified: rs.filter((r) => r.verified === true).length,
      inScope: rs.filter((r) => r.inScope === true).length,
      priced: costs.length,
      totalCostUsd: costs.reduce((a, b) => a + b, 0),
      meanCostUsd: mean(costs),
      meanTurns: mean(turns),
      meanDurationMs: mean(durations),
      scopeViolations: rs.filter((r) => r.inScope === false).length,
      memoryWired: wiredResults.length ? wiredResults.filter((r) => r.memoryWired === true).length : null,
      spread: {
        success: spreadOf(rs.map((r) => (r.success === true ? 1 : 0))),
        hidden: spreadOf(hiddenValues),
        defects: spreadOf(judgedRows.map((d) => d.total)),
        scopeViolations: spreadOf(rs.map((r) => (r.inScope === false ? 1 : 0))),
        cost: spreadOf(costs),
        wall: spreadOf(durations.map((d) => d / 60000)),
      },
      judged: hasDefects ? judgedRows.length : null,
    };
  });
  const tasks = [...new Set(results.map((r) => r.task))];
  const byTask: TaskSummary[] = [];
  for (const task of tasks) {
    for (const c of conditions) {
      const rs = results.filter((r) => r.task === task && r.condition === c.condition);
      if (!rs.length) continue;
      const hiddenValues = rs
        .map((r) => r.hidden)
        .filter((h): h is EvalHidden => h != null)
        .map((h) => h.rate);
      const defectsValues = rs
        .map((r) => r.defects)
        .filter((d): d is EvalDefects => d != null && d.error === null)
        .map((d) => d.total);
      byTask.push({
        task,
        condition: c.condition,
        sessions: rs.length,
        successes: rs.filter((r) => r.success === true).length,
        meanCostUsd: mean(priced(rs)),
        meanHidden: mean(hiddenValues),
        meanDefects: mean(defectsValues),
      });
    }
  }
  return {
    suite: suites.length === 1 ? suites[0] : suites.length ? suites.join(", ") : null,
    sources: files.map((f) => f.source),
    sessions: results.length,
    tasks,
    conditions,
    byTask,
    unpriced: results.length - priced(results).length,
  };
}

const pct = (n: number): string => `${Math.round(n * 100)}%`;
const usd = (n: number | null): string => (n === null ? "no cost" : `$${n.toFixed(3)}`);
const num = (n: number | null, digits = 1): string => (n === null ? "-" : n.toFixed(digits));

// A single run is never reported as a range: a mean cell shows `mean (min-max)` only once two or more sessions
// fed the measure (card eval-accuracy); with one, or none, it renders the way a plain mean always has.
const enDash = "–";
const rangeStr = (min: number, max: number, fmt: (n: number) => string): string => `${fmt(min)}${enDash}${fmt(max)}`;

function costCell(spread: Spread | null, fallback: number | null, priced: number, sessions: number): string {
  const base = spread === null ? usd(fallback) : spread.n >= 2 ? `${usd(spread.mean)} (${rangeStr(spread.min, spread.max, (n) => `$${n.toFixed(3)}`)})` : usd(spread.mean);
  return `${base}${priced < sessions ? ` (${priced} priced)` : ""}`;
}

function wallCell(spread: Spread | null): string {
  if (spread === null) return "-";
  const base = `${num(spread.mean)} min`;
  return spread.n >= 2 ? `${base} (${rangeStr(spread.min, spread.max, (n) => num(n))})` : base;
}

// Appends " (<k> of <n>)" whenever fewer sessions carried a hidden set than the condition ran: not every task
// carries `hidden`, so a session without one is silently absent from the spread rather than counted as 0%.
function hiddenCell(spread: Spread | null, sessions: number): string {
  if (spread === null) return "-";
  const base = spread.n >= 2 ? `${pct(spread.mean)} (${rangeStr(spread.min, spread.max, pct)})` : pct(spread.mean);
  const note = spread.n < sessions ? ` (${spread.n} of ${sessions})` : "";
  return base + note;
}

// Appends " (<k> judged)" whenever fewer sessions were actually judged than the condition ran (card eval-
// accuracy's amendment): an inconclusive judge (worktree-modified, spawn failure, git failure) leaves its
// session's defects out of the spread entirely, so the mean would otherwise look like it covered every session.
// The note still appears when spread is null (every judge came back inconclusive): "- (0 judged)" rather than a
// bare "-" that reads as if the judge never ran at all.
function defectsCell(spread: Spread | null, judged: number | null, sessions: number): string {
  const base = spread === null ? "-" : spread.n >= 2 ? `${spread.mean.toFixed(1)} (${spread.min}${enDash}${spread.max})` : String(spread.mean);
  const note = judged !== null && judged < sessions ? ` (${judged} judged)` : "";
  return base + note;
}

// The swarm rule's verdict for the memory arm (card memory-measure): ships on by default only when at least one
// of the five measures against pipeline improved and none worsened. Lower is better for scope violations, cost,
// turns, and wall clock; higher is better for success. A measure with no comparable data (a null mean on either
// side) counts as neither improved nor worsened.
export function memoryVerdict(memoryCond: ConditionSummary, pipeline: ConditionSummary): string {
  const points = Math.round((memoryCond.successRate - pipeline.successRate) * 100);
  const scope = memoryCond.scopeViolations - pipeline.scopeViolations;
  const costDelta = memoryCond.meanCostUsd !== null && pipeline.meanCostUsd !== null ? memoryCond.meanCostUsd - pipeline.meanCostUsd : null;
  const turnsDelta = memoryCond.meanTurns !== null && pipeline.meanTurns !== null ? memoryCond.meanTurns - pipeline.meanTurns : null;
  const wallDelta = memoryCond.meanDurationMs !== null && pipeline.meanDurationMs !== null ? memoryCond.meanDurationMs - pipeline.meanDurationMs : null;
  const measures = [
    { name: "success", improved: points > 0, worsened: points < 0 },
    { name: "scope violations", improved: scope < 0, worsened: scope > 0 },
    { name: "cost", improved: costDelta !== null && costDelta < 0, worsened: costDelta !== null && costDelta > 0 },
    { name: "turns", improved: turnsDelta !== null && turnsDelta < 0, worsened: turnsDelta !== null && turnsDelta > 0 },
    { name: "wall clock", improved: wallDelta !== null && wallDelta < 0, worsened: wallDelta !== null && wallDelta > 0 },
  ];
  const worsened = measures.filter((m) => m.worsened).map((m) => m.name);
  const improved = measures.filter((m) => m.improved);
  if (worsened.length === 0 && improved.length > 0) return "memory: ships on by default";
  if (worsened.length) return `memory: ships off by default (${worsened.join(", ")} worsened)`;
  return "memory: ships off by default (nothing improved)";
}

export function renderAblation(a: Ablation): string {
  const lines: string[] = [];
  const suite = a.suite ? `suite ${a.suite}` : "results";
  lines.push(`Ablation of ${suite}: ${a.sessions} session${a.sessions === 1 ? "" : "s"} from ${a.sources.join(", ")}; ${a.tasks.length} task${a.tasks.length === 1 ? "" : "s"}${a.tasks.length ? ` (${a.tasks.join(", ")})` : ""}.`);
  lines.push("");
  // The Wired column (card memory-measure) only appears when some result actually carries memoryWired — every
  // condition but memory leaves it out entirely, so a run with no memory arm shows no Wired column. Hidden
  // follows the same non-null-spread rule (card eval-accuracy). Defects instead keys on the field's presence
  // (`judged !== null`, the same signal `judged` itself is built from) rather than on the spread being non-null,
  // so a run where every judge came back inconclusive still shows a Defects column (with "- (0 judged)") instead
  // of looking like the judge never ran. Neither field exists in a result file from before this card, so neither
  // column appears for one — but that file's Mean cost and Mean wall cells can still gain a `mean (min–max)`
  // range once a condition in it has two or more sessions: that rendering upgrade isn't gated on this card's
  // new fields at all.
  const anyWired = a.conditions.some((c) => c.memoryWired !== null);
  const anyHidden = a.conditions.some((c) => c.spread.hidden !== null);
  const anyDefects = a.conditions.some((c) => c.judged !== null);
  const header = [
    "Condition",
    "Sessions",
    "Success",
    "Verified",
    "In scope",
    "Mean cost",
    "Mean turns",
    "Mean wall",
    ...(anyHidden ? ["Hidden"] : []),
    ...(anyDefects ? ["Defects"] : []),
    ...(anyWired ? ["Wired"] : []),
  ];
  lines.push(`| ${header.join(" | ")} |`);
  lines.push(`|${header.map(() => "---").join("|")}|`);
  for (const c of a.conditions) {
    const cells = [
      c.condition,
      String(c.sessions),
      `${c.successes}/${c.sessions} (${pct(c.successRate)})`,
      `${c.verified}/${c.sessions}`,
      `${c.inScope}/${c.sessions}`,
      costCell(c.spread.cost, c.meanCostUsd, c.priced, c.sessions),
      num(c.meanTurns),
      wallCell(c.spread.wall),
      ...(anyHidden ? [hiddenCell(c.spread.hidden, c.sessions)] : []),
      ...(anyDefects ? [defectsCell(c.spread.defects, c.judged, c.sessions)] : []),
      ...(anyWired ? [c.memoryWired === null ? "-" : `${c.memoryWired}/${c.sessions}`] : []),
    ];
    lines.push(`| ${cells.join(" | ")} |`);
  }
  // A single run is never reported as a difference (card eval-accuracy): every "Against ..." line below prints
  // only when both sides ran two or more sessions, so a lone claude -p session's noise never reads as a finding.
  const singleRunLine = (ref: string, cond: ConditionSummary, refSummary: ConditionSummary): string =>
    `Against ${ref}, ${cond.condition}: single run (n=${cond.sessions} vs n=${refSummary.sessions}), not reported as a difference.`;
  // The hidden pass rate and defect count deltas (card eval-accuracy) that the arm and memory lines below append
  // after their existing measures: omitted, never fabricated, unless BOTH sides drew on two or more sessions for
  // that measure specifically — a condition can clear the overall single-run gate above on `sessions` while a
  // single session (or zero) carried a hidden set or a conclusive judge, and one sample is still not a spread.
  const twoOrMore = (s: Spread | null): s is Spread => s !== null && s.n >= 2;
  const hiddenDefectsFragments = (c: ConditionSummary, ref: ConditionSummary): string => {
    const parts: string[] = [];
    if (twoOrMore(c.spread.hidden) && twoOrMore(ref.spread.hidden)) {
      const d = Math.round((c.spread.hidden.mean - ref.spread.hidden.mean) * 100);
      parts.push(`${d >= 0 ? "+" : ""}${d} points hidden pass rate`);
    }
    if (twoOrMore(c.spread.defects) && twoOrMore(ref.spread.defects)) {
      const d = c.spread.defects.mean - ref.spread.defects.mean;
      parts.push(`${d >= 0 ? "+" : ""}${d.toFixed(1)} defects`);
    }
    return parts.length ? `, ${parts.join(", ")}` : "";
  };
  const baseline = a.conditions.find((c) => c.condition === "baseline");
  const others = a.conditions.filter((c) => c.condition !== "baseline");
  if (baseline && others.length) {
    lines.push("");
    for (const c of others) {
      if (c.sessions < 2 || baseline.sessions < 2) {
        lines.push(singleRunLine("baseline", c, baseline));
        continue;
      }
      const points = Math.round((c.successRate - baseline.successRate) * 100);
      const cost = c.meanCostUsd !== null && baseline.meanCostUsd !== null ? `${c.meanCostUsd - baseline.meanCostUsd >= 0 ? "+" : "-"}$${Math.abs(c.meanCostUsd - baseline.meanCostUsd).toFixed(3)} mean cost` : "cost not comparable";
      lines.push(`Against baseline, ${c.condition}: ${points >= 0 ? "+" : ""}${points} points success, ${cost}.`);
    }
  }
  // The orchestration arms against the fixed pipeline: success, scope violations, cost, and wall clock, the four
  // measures decision 0001 names, plus hidden pass rate and defects (card eval-accuracy) when both sides have
  // them. The swarm ships disabled by default unless one improves without another worsening.
  const pipeline = a.conditions.find((c) => c.condition === "pipeline");
  const arms = a.conditions.filter((c) => ARM_CONDITIONS.includes(c.condition));
  if (pipeline && arms.length) {
    lines.push("");
    for (const c of arms) {
      if (c.sessions < 2 || pipeline.sessions < 2) {
        lines.push(singleRunLine("pipeline", c, pipeline));
        continue;
      }
      const points = Math.round((c.successRate - pipeline.successRate) * 100);
      const scope = c.scopeViolations - pipeline.scopeViolations;
      const cost = c.meanCostUsd !== null && pipeline.meanCostUsd !== null ? `${c.meanCostUsd - pipeline.meanCostUsd >= 0 ? "+" : "-"}$${Math.abs(c.meanCostUsd - pipeline.meanCostUsd).toFixed(3)} mean cost` : "cost not comparable";
      const wall = c.meanDurationMs !== null && pipeline.meanDurationMs !== null ? `${c.meanDurationMs - pipeline.meanDurationMs >= 0 ? "+" : "-"}${num(Math.abs(c.meanDurationMs - pipeline.meanDurationMs) / 60000)} min wall` : "wall not comparable";
      lines.push(`Against pipeline, ${c.condition}: ${points >= 0 ? "+" : ""}${points} points success, ${scope >= 0 ? "+" : ""}${scope} scope violations, ${cost}, ${wall}${hiddenDefectsFragments(c, pipeline)}.`);
    }
  }
  // The memory arm against pipeline (card memory-measure), on a fifth measure the arms above do not carry: mean
  // turns, alongside the same four success/scope/cost/wall clock as above (plus hidden/defects, card eval-
  // accuracy). A separate block so the existing arm lines' format is untouched. No verdict line follows a
  // single-run comparison: there is nothing to ship a verdict on.
  const memoryCond = a.conditions.find((c) => c.condition === MEMORY_CONDITION);
  if (pipeline && memoryCond) {
    lines.push("");
    if (memoryCond.sessions < 2 || pipeline.sessions < 2) {
      lines.push(singleRunLine("pipeline", memoryCond, pipeline));
    } else {
      const points = Math.round((memoryCond.successRate - pipeline.successRate) * 100);
      const scope = memoryCond.scopeViolations - pipeline.scopeViolations;
      const cost =
        memoryCond.meanCostUsd !== null && pipeline.meanCostUsd !== null
          ? `${memoryCond.meanCostUsd - pipeline.meanCostUsd >= 0 ? "+" : "-"}$${Math.abs(memoryCond.meanCostUsd - pipeline.meanCostUsd).toFixed(3)} mean cost`
          : "cost not comparable";
      const turnsNote =
        memoryCond.meanTurns !== null && pipeline.meanTurns !== null
          ? `${memoryCond.meanTurns - pipeline.meanTurns >= 0 ? "+" : "-"}${num(Math.abs(memoryCond.meanTurns - pipeline.meanTurns))} mean turns`
          : "turns not comparable";
      const wall =
        memoryCond.meanDurationMs !== null && pipeline.meanDurationMs !== null
          ? `${memoryCond.meanDurationMs - pipeline.meanDurationMs >= 0 ? "+" : "-"}${num(Math.abs(memoryCond.meanDurationMs - pipeline.meanDurationMs) / 60000)} min wall`
          : "wall not comparable";
      lines.push(
        `Against pipeline, memory: ${points >= 0 ? "+" : ""}${points} points success, ${scope >= 0 ? "+" : ""}${scope} scope violations, ${cost}, ${turnsNote}, ${wall}${hiddenDefectsFragments(memoryCond, pipeline)}.`
      );
      lines.push(memoryVerdict(memoryCond, pipeline));
    }
  }
  if (a.tasks.length > 1) {
    lines.push("");
    const taskHeader = ["Task", "Condition", "Sessions", "Success", "Mean cost", ...(anyHidden ? ["Hidden"] : []), ...(anyDefects ? ["Defects"] : [])];
    lines.push(`| ${taskHeader.join(" | ")} |`);
    lines.push(`|${taskHeader.map(() => "---").join("|")}|`);
    for (const t of a.byTask) {
      const cells = [
        t.task,
        t.condition,
        String(t.sessions),
        `${t.successes}/${t.sessions}`,
        usd(t.meanCostUsd),
        ...(anyHidden ? [t.meanHidden === null ? "-" : pct(t.meanHidden)] : []),
        ...(anyDefects ? [t.meanDefects === null ? "-" : t.meanDefects.toFixed(1)] : []),
      ];
      lines.push(`| ${cells.join(" | ")} |`);
    }
  }
  if (a.unpriced) {
    lines.push("");
    lines.push(`Note: ${a.unpriced} session${a.unpriced === 1 ? " has" : "s have"} no cost (the runner could not read claude -p's JSON); means are over the priced sessions only.`);
  }
  return lines.join("\n") + "\n";
}

const BOOLEAN_FLAGS = new Set(["json", "help", "dry-run"]);
const RUNNER_OPTIONS = ["tasks", "conditions", "runs", "max-turns", "suite", "max-budget-usd", "judge", "judge-model"];

interface Parsed {
  opts: Record<string, string | true>;
  from: string[];
  positional: string[];
}

function parse(argv: string[]): Parsed {
  const opts: Record<string, string | true> = {};
  const from: string[] = [];
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      positional.push(a);
      continue;
    }
    const name = a.slice(2);
    if (BOOLEAN_FLAGS.has(name)) opts[name] = true;
    else if (name === "from") from.push(argv[++i] ?? "");
    else opts[name] = argv[++i] ?? "";
  }
  return { opts, from, positional };
}

function readEvalFile(file: string): EvalFile {
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(`cannot read ${file}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!data || typeof data !== "object" || !Array.isArray((data as EvalFile).results)) throw new Error(`${file} is not an eval result: no results array`);
  return data as EvalFile;
}

export function newestResult(outDir: string, since: number): string | null {
  if (!existsSync(outDir)) return null;
  // Names are ISO timestamps (evals/run.mjs), so lexicographic order is chronological: sort descending by name
  // before the stable mtime sort, so an equal-mtime tie (plausible for files written in the same run) resolves
  // to the newer name, not the older one.
  const files = readdirSync(outDir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .reverse()
    .map((f) => ({ file: join(outDir, f), mtime: statSync(join(outDir, f)).mtimeMs }))
    .filter((f) => f.mtime >= since)
    .sort((x, y) => y.mtime - x.mtime);
  return files.length ? files[0].file : null;
}

export async function runAblate(argv: string[], io?: AblateIo): Promise<number> {
  const out: AblateIo = io || {
    stdout: (s) => void process.stdout.write(s),
    stderr: (s) => void process.stderr.write(s),
  };
  const { opts, from, positional } = parse(argv);
  if (opts.help === true) {
    out.stdout(ABLATE_USAGE);
    return 0;
  }
  const emit = (files: { source: string; data: EvalFile }[]): void => {
    const summary = summarizeEval(files);
    out.stdout(opts.json === true ? JSON.stringify(summary, null, 2) + "\n" : renderAblation(summary));
  };
  try {
    if (from.length) {
      if (from.some((f) => !f)) throw new Error("--from needs a file");
      emit(from.map((f) => ({ source: f, data: readEvalFile(resolve(f)) })));
      return 0;
    }
    const dir = resolve(positional[0] || process.cwd());
    const runner = join(dir, "evals", "run.mjs");
    if (!existsSync(runner)) {
      out.stderr(`no eval runner at ${runner}; pass the repository directory, or --from <evals/out/file.json> to summarize an existing result\n`);
      return 1;
    }
    const args = [runner];
    for (const name of RUNNER_OPTIONS) {
      const v = opts[name];
      if (typeof v === "string") args.push(`--${name}`, v);
    }
    if (opts["dry-run"] === true) args.push("--dry-run");
    const started = Date.now();
    const r = spawnSync(process.execPath, args, { cwd: dir, stdio: "inherit" });
    if (r.status !== 0) {
      out.stderr(`evals/run.mjs exited with ${r.status === null ? `signal ${r.signal}` : `status ${r.status}`}; nothing summarized\n`);
      return r.status ?? 1;
    }
    if (opts["dry-run"] === true) return 0;
    const file = newestResult(join(dir, "evals", "out"), started);
    if (!file) {
      out.stderr(`evals/run.mjs wrote no result under ${join(dir, "evals", "out")}\n`);
      return 1;
    }
    out.stdout("\n");
    emit([{ source: file, data: readEvalFile(file) }]);
    return 0;
  } catch (err) {
    out.stderr(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}
