// The parallel-card coordinator (card parallel-card-queens, ADR 0015): the pure decisions main makes while
// several card queens run in one session. Which cards may run together (D1 disjointness), how many slots are
// free, what a queen's finished run means, which done card lands next, which autopilot caps are reached.
// Pure and import-free: the decisions are testable with fakes, and a host that is not Claude Code can reuse them.

export const WORKERS_MAX_DEFAULT = 3;
export const WORKERS_MAX_LIMIT = 16;

// The configured workers.max when it is an integer from 1 to 16; the default silently when the key (or
// workers) is absent; the default plus one warn() call otherwise.
export function workersMax(config, warn = () => {}) {
  const v = config && config.workers ? config.workers.max : undefined;
  if (v === undefined) return WORKERS_MAX_DEFAULT;
  if (Number.isInteger(v) && v >= 1 && v <= WORKERS_MAX_LIMIT) return v;
  warn(`workers.max must be an integer from 1 to ${WORKERS_MAX_LIMIT}; using ${WORKERS_MAX_DEFAULT}`);
  return WORKERS_MAX_DEFAULT;
}

// Paths every card records into; they never make two cards conflict.
const IGNORED_PATHS = [".doug/board.json", "docs/live-runs.md", "board.json", "live-runs.md"];
// A goal naming one of these runs alone: parallel cards would collide on the file (by basename), or on the
// config (by full path).
const SOLO_BASENAMES = ["package.json", "pnpm-lock.yaml", "package-lock.json", "yarn.lock", "CLAUDE.md"];
const SOLO_PATHS = [".doug/config.json"];

function norm(p) {
  return String(p)
    .replace(/\\/g, "/")
    .replace(/\/{2,}/g, "/")
    .replace(/^(\.\/)+/, "")
    .replace(/\/+$/, "");
}

function baseName(p) {
  const parts = norm(p).split("/");
  return parts[parts.length - 1];
}

// Extensions seen in this repository; a token whose last segment has another one (Date.now, claude.ai, v1.2)
// is prose, not a path.
const FILE_EXTS = ["mjs", "js", "ts", "tsx", "json", "md", "yaml", "yml", "sh", "toml", "lock", "txt", "jsonl", "py", "db", "html", "css"];
const PATH_CHARS = /^[A-Za-z0-9_.\-/*?@]+$/;
// Prose pairs that look like a/b when no roots list is given.
const PROSE_PAIRS = ["and/or", "either/or", "yes/no", "input/output", "read/write", "true/false", "he/she"];

// A name that is only a dot and a word (.state, .git): a dot-directory, not a file with an extension.
function isDotName(p) {
  return /^\.[^.]+$/.test(baseName(p));
}

function hasFileExt(t) {
  if (isDotName(t)) return false;
  const m = /\.([A-Za-z0-9]+)$/.exec(baseName(t));
  return !!m && FILE_EXTS.includes(m[1].toLowerCase());
}

// a/{b,c} -> a/b, a/c (first group, recursively). An unclosed brace is left as it is.
function expandBraces(t) {
  const open = t.indexOf("{");
  const close = open < 0 ? -1 : t.indexOf("}", open);
  if (open < 0 || close < 0) return [t];
  const out = [];
  for (const alt of t.slice(open + 1, close).split(",")) out.push(...expandBraces(t.slice(0, open) + alt + t.slice(close + 1)));
  return out;
}

function cleanToken(raw) {
  let t = raw;
  for (let i = 0; i < 4; i++) {
    const before = t;
    t = t.replace(/^[([<"'`]+/, "").replace(/['\u2019]s$/, "").replace(/:\d+(-\d+)?$/, "");
    t = t.replace(/[)\]>"'`,;:!?.]+$/, "");
    if (t.endsWith("}") && !t.includes("{")) t = t.slice(0, -1);
    if (t === before) break;
  }
  return t;
}

// The file and directory paths a goal names. Sentence punctuation, a trailing :line or :line-line and a
// possessive 's are dropped; a/{b,c} expands to a/b and a/c; a trailing slash (a directory) is kept. Slash
// commands, @scopes and prose (and/or, Date.now) are not paths. A slash token with no extension and no
// trailing slash counts only when its first segment is in opts.roots; with no roots given it is kept.
export function goalPaths(goal, opts) {
  if (typeof goal !== "string") return [];
  const roots = opts && Array.isArray(opts.roots) ? opts.roots : null;
  const out = [];
  for (const raw of goal.split(/\s+/)) {
    const cleaned = cleanToken(raw);
    if (!cleaned || cleaned.startsWith("/") || cleaned.startsWith("@") || cleaned.includes("://")) continue;
    for (const t of expandBraces(cleaned)) {
      if (!t || !PATH_CHARS.test(t) || !/[A-Za-z]/.test(t)) continue;
      let ok;
      if (!t.includes("/")) ok = hasFileExt(t);
      else if (t.endsWith("/") || hasFileExt(t)) ok = true;
      else if (roots) ok = roots.includes(t.split("/")[0]);
      else ok = !PROSE_PAIRS.includes(t.toLowerCase()) && (isDotName(t) || !baseName(t).includes("."));
      if (ok && !out.includes(t)) out.push(t);
    }
  }
  return out;
}

function handPaths(card, opts) {
  return goalPaths(card.goal, opts).filter((p) => !IGNORED_PATHS.includes(norm(p)));
}

function soloFile(card, opts) {
  for (const p of goalPaths(card.goal, opts)) {
    const n = norm(p);
    if (SOLO_PATHS.includes(n) || SOLO_BASENAMES.includes(baseName(n))) return n;
  }
  return null;
}

function isDirEntry(p) {
  return /\/$/.test(String(p)) || isDotName(p) || !baseName(p).includes(".");
}

function covers(dir, file) {
  const d = norm(dir);
  const f = norm(file);
  return d !== "" && (f === d || f.startsWith(d + "/"));
}

// Two goal paths overlap: the same path, one inside the other, or the same file name.
function pathsOverlap(p, q) {
  if (covers(p, q) || covers(q, p)) return true;
  return !isDirEntry(p) && !isDirEntry(q) && baseName(p) === baseName(q);
}

const GLOB_CHARS = /[*?{]/;

function globToRegExp(glob) {
  let re = "";
  const g = norm(glob);
  let inBrace = false;
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === "*") {
      if (g[i + 1] === "*") {
        i++;
        if (g[i + 1] === "/") {
          i++;
          re += "(?:.*/)?";
        } else re += ".*";
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if (c === "{" && g.indexOf("}", i) >= 0) {
      inBrace = true;
      re += "(?:";
    } else if (c === "}" && inBrace) {
      inBrace = false;
      re += ")";
    } else if (c === "," && inBrace) re += "|";
    else re += c.replace(/[.+^$()|[\]\\]/g, "\\$&");
  }
  return new RegExp("^" + re + "$");
}

// The directory a glob is rooted in: its literal prefix up to the last slash before the first glob character.
function globRoot(glob) {
  const g = norm(glob);
  const at = g.search(GLOB_CHARS);
  const lead = at < 0 ? g : g.slice(0, at);
  const cut = lead.lastIndexOf("/");
  return cut < 0 ? "" : lead.slice(0, cut);
}

// Do two plan ownership entries (exact file, directory or glob) overlap? Same semantics as scope.mjs's
// ownsPath, tried both ways; a glob against anything also counts when their directories nest.
function entriesOverlap(a, b) {
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return false;
  const gx = GLOB_CHARS.test(x);
  const gy = GLOB_CHARS.test(y);
  if (!gx && !gy) return covers(x, y) || covers(y, x);
  if (gx && !gy && globToRegExp(x).test(y)) return true;
  if (gy && !gx && globToRegExp(y).test(x)) return true;
  const rx = gx ? globRoot(x) : x;
  const ry = gy ? globRoot(y) : y;
  if (rx === "" || ry === "") return true;
  return covers(rx, ry) || covers(ry, rx);
}

function ownedFiles(card) {
  const out = [];
  const tasks = card.plan && Array.isArray(card.plan.tasks) ? card.plan.tasks : [];
  for (const t of tasks) for (const f of (t && t.files) || []) if (typeof f === "string") out.push(f);
  return out;
}

function taskIds(card) {
  const tasks = card.plan && Array.isArray(card.plan.tasks) ? card.plan.tasks : [];
  return tasks.map((t) => t && t.id).filter((id) => typeof id === "string");
}

function conflict(b, why) {
  return { with: b.id, why };
}

function flowWithFlow(a, b) {
  if (!a.plan || !b.plan) return conflict(b, `the plan of ${a.plan ? b.id : a.id} is not known yet`);
  const ids = taskIds(b);
  const shared = taskIds(a).find((id) => ids.includes(id));
  if (shared) return conflict(b, `both plans have a task id "${shared}"`);
  const mine = ownedFiles(a);
  const theirs = ownedFiles(b);
  for (const f of mine) for (const g of theirs) if (entriesOverlap(f, g)) return conflict(b, `both plans own ${norm(f) === norm(g) ? norm(f) : `${norm(f)} and ${norm(g)}`}`);
  return null;
}

function flowWithHand(f, h, opts) {
  if (!f.plan) return conflict(h, `the plan of ${f.id} is not known yet`);
  if (soloFile(h, opts)) return conflict(h, `${h.id} names ${soloFile(h, opts)}, so it runs alone`);
  for (const p of handPaths(h, opts)) {
    for (const o of ownedFiles(f)) {
      const bare = !norm(p).includes("/");
      if (entriesOverlap(o, p) || (bare && !GLOB_CHARS.test(o) && baseName(o) === norm(p))) {
        return conflict(h, `the plan owns ${norm(o)}, which the goal names (${norm(p)})`);
      }
    }
  }
  if (!f.component || !h.component) return conflict(h, "a card with no component conflicts with everything");
  if (f.component === h.component) return conflict(h, `same component ${f.component}`);
  return null;
}

function handWithHand(a, b, opts) {
  const sa = soloFile(a, opts);
  if (sa) return conflict(b, `${a.id} names ${sa}, so it runs alone`);
  const sb = soloFile(b, opts);
  if (sb) return conflict(b, `${b.id} names ${sb}, so it runs alone`);
  const pa = handPaths(a, opts);
  const pb = handPaths(b, opts);
  for (const p of pa) for (const q of pb) if (pathsOverlap(p, q)) return conflict(b, `both goals name ${norm(p) === norm(q) ? norm(p) : `${norm(p)} and ${norm(q)}`}`);
  if (!a.component || !b.component) return conflict(b, "a card with no component conflicts with everything");
  if (a.component === b.component) return conflict(b, `same component ${a.component}`);
  return null;
}

// null when the two cards may run together, else { with: b.id, why }. A flow card carries its plan as `.plan`.
export function cardConflict(a, b, opts) {
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return { with: b && b.id !== undefined ? b.id : null, why: "a card is missing" };
  if (a.track === "flow" && b.track === "flow") return flowWithFlow(a, b);
  if (a.track === "flow") return flowWithHand(a, b, opts);
  if (b.track === "flow") {
    const c = flowWithHand(b, a, opts);
    return c && conflict(b, c.why);
  }
  return handWithHand(a, b, opts);
}

// "hand" or "flow" for a card a queen can run; "alone" for a swarm or a decision card, which runs by itself.
export function queenKind(card) {
  if (!card) return "alone";
  if (card.swarm || card.class === "decision") return "alone";
  return card.track === "flow" ? "flow" : "hand";
}

// Which ready cards to start now. A flow card without a plan comes back as needsPlan (its owned files are
// unknown until a planner runs); with a plan it is checked like any card. A card is launched when it conflicts
// with nothing in flight and nothing launched before it; otherwise it is held against what it met first.
// needsPlan and launch together never exceed `slots`; a held card takes no slot.
export function pickCards(arg) {
  const { ready = [], inFlight = [], slots = 0, plans = {}, roots } = arg && typeof arg === "object" ? arg : {};
  const out = { launch: [], needsPlan: [], held: [], alone: [] };
  const opts = { roots };
  const planOf = (c) => (plans && typeof plans === "object" && Object.hasOwn(plans, c.id) ? plans[c.id] : null);
  const withPlan = (c) => (c.track === "flow" && planOf(c) ? { ...c, plan: planOf(c) } : c);
  const running = (inFlight || []).filter((c) => c && typeof c === "object").map(withPlan);
  const launched = [];
  let blocked = false;
  for (const raw of ready || []) {
    if (!raw || typeof raw !== "object") continue;
    if (queenKind(raw) === "alone") {
      // An alone card does not starve: the first one runnable in board order stops later launches. It is returned
      // only when nothing is in flight, launched in this pick, or waiting for a plan.
      if (running.length === 0 && out.launch.length === 0 && out.needsPlan.length === 0) out.alone.push(raw.id);
      blocked = true;
      continue;
    }
    if (blocked) continue;
    if (out.launch.length + out.needsPlan.length >= slots) continue;
    if (raw.track === "flow" && !planOf(raw)) {
      out.needsPlan.push(raw.id);
      continue;
    }
    const card = withPlan(raw);
    let met = null;
    for (const other of [...running, ...launched]) {
      met = cardConflict(card, other, opts);
      if (met) break;
    }
    if (met) out.held.push({ id: raw.id, with: met.with, why: met.why });
    else {
      out.launch.push(raw.id);
      launched.push(card);
    }
  }
  return out;
}

function parseResult(result) {
  if (typeof result === "string") {
    try {
      return JSON.parse(result);
    } catch {
      return null;
    }
  }
  return result && typeof result === "object" ? result : null;
}

// What a queen's finished run means for main: land it, resume it (the run died, or its result is unreadable, or
// a seat's agent returned null), or ask the user (the other queens keep running meanwhile).
export function classifyNotification(kind, arg) {
  const { status, result } = arg || {};
  if (status !== "completed") return { action: "resume", reason: `run status ${status}` };
  const r = parseResult(result);
  if (!r) return { action: "resume", reason: "result unreadable" };
  if (kind === "flow") {
    if (r.ok === true) return { action: "land" };
    if (r.paused) {
      const p = r.paused;
      return { action: "ask", reason: `paused at a ${p.gate || "human"} gate (level ${p.level})` };
    }
    if (r.ok === false) return { action: "ask", reason: "the run stopped" + (r.stoppedAtLevel !== undefined ? ` at level ${r.stoppedAtLevel}` : "") };
    return { action: "ask", reason: "unrecognised result" };
  }
  // The queen's real result (card-queen.js) carries outcome; the wrapper shape carries kind. Both are read.
  const verdict = r.kind ?? r.outcome;
  if (verdict === "done") return { action: "land" };
  if (verdict === "stopped") {
    if (r.reason === "agent-null") return { action: "resume", reason: "agent-null" };
    return { action: "ask", reason: r.reason };
  }
  return { action: "ask", reason: "unrecognised result" };
}

// The done cards waiting to land, first in first out by doneAt. One lands at a time: while a card is landing
// nothing else is next.
export function landQueue(state) {
  const cards = state && Array.isArray(state.cards) ? state.cards : [];
  const done = cards
    .filter((c) => c && typeof c === "object")
    .map((c, i) => ({ c, i }))
    .filter(({ c }) => c.state === "done")
    .sort((x, y) => {
      const a = x.c.doneAt || "￿";
      const b = y.c.doneAt || "￿";
      return a < b ? -1 : a > b ? 1 : x.i - y.i;
    })
    .map(({ c }) => c.id);
  const busy = cards.some((c) => c && c.state === "landing");
  return { next: busy || done.length === 0 ? null : done[0], queue: done };
}

// The names of the caps whose used value is at or over the cap. An unset cap is ignored.
export function capsReached(caps, used) {
  const out = [];
  for (const name of ["usd", "wallMin", "contextPct"]) {
    const cap = caps ? caps[name] : undefined;
    const v = used ? used[name] : undefined;
    if (typeof cap === "number" && Number.isFinite(cap) && typeof v === "number" && v >= cap) out.push(name);
  }
  return out;
}

// The queen's short run label (card queen-run-name): the first two hyphen segments of the card id (the id itself
// with fewer), or the full id when another id in `others` (the card's own id excluded) shortens to the same form.
const shortForm = (id) => String(id).split("-").slice(0, 2).join("-");
export function queenLabel(id, others = []) {
  const short = shortForm(id);
  return others.some((o) => o !== id && shortForm(o) === short) ? String(id) : short;
}

// The queen script's source with only its meta literal renamed: name becomes "<label> card-queen" (hand) or
// "<label> flow-queen" (flow), description gets "<label>: " in front. Throws when either is missing from the meta.
export function renameQueenMeta(source, { kind, label }) {
  const start = source.indexOf("export const meta = {");
  if (start < 0) throw new Error("no meta literal in the queen script");
  const e = source.indexOf("\n}", start);
  const end = e < 0 ? source.length : e;
  let meta = source.slice(start, end);
  const nameRe = /^(\s*name: ')[^']*(',)/m;
  const descRe = /^(\s*description: ')/m;
  if (!nameRe.test(meta)) throw new Error("no meta name in the queen script");
  if (!descRe.test(meta)) throw new Error("no meta description in the queen script");
  const suffix = kind === "flow" ? "flow-queen" : "card-queen";
  meta = meta.replace(nameRe, (_m, a, b) => `${a}${label} ${suffix}${b}`).replace(descRe, (_m, a) => `${a}${label}: `);
  return source.slice(0, start) + meta + source.slice(end);
}
