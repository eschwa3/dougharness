// Plan-versus-diff scope: when .doug/plan.json is approved (or done and not yet landed), the union of
// the files its tasks own is the only thing a session may change.
// Pure functions plus one reader; the stop gate decides, this file only computes.

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { globToRegExp, matchAny, normalizePath } from "./glob.mjs";

export const PLAN_RELPATH = ".doug/plan.json";
export const ENFORCED_STATUSES = ["approved", "done"];
// The flow's own files change during a run and are never out of scope. Per-session hook state too.
// board.json moves uncommitted with the live board server; it lands in the card's landing commit.
export const ALWAYS_ALLOWED = [".doug/plan.json", ".doug/anchor.md", ".doug/.state/**", ".doug/board.json"];

// Returns { plan, reason }. plan is set only when the file exists, parses, has tasks, and is in an
// enforced status; reason says why not otherwise ("no-plan", "unreadable", "status:draft", "invalid").
export function loadScopePlan(dir) {
  const file = join(dir, PLAN_RELPATH);
  if (!existsSync(file)) return { plan: null, reason: "no-plan" };
  let plan;
  try {
    plan = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    return { plan: null, reason: "unreadable", error: String(err.message) };
  }
  if (!plan || typeof plan !== "object" || !Array.isArray(plan.tasks)) return { plan: null, reason: "invalid" };
  if (!ENFORCED_STATUSES.includes(plan.status)) return { plan: null, reason: `status:${plan.status}` };
  // plan.mjs land records `landed`; a landed plan has been merged and no longer holds scope.
  if (plan.landed) return { plan: null, reason: "landed" };
  return { plan, reason: null };
}

const GLOB_CHARS = /[*?{]/;

// Does a plan ownership entry cover this path? Exact file, a directory (with or without a trailing
// slash), or a glob matched against the whole relative path. No basename matching: a task that owns
// "README.md" does not own "docs/README.md".
export function ownsPath(owned, file) {
  if (typeof owned !== "string" || typeof file !== "string") return false;
  const o = normalizePath(owned).replace(/\/+$/, "");
  const f = normalizePath(file);
  if (!o) return false;
  if (GLOB_CHARS.test(o)) return globToRegExp(o).test(f);
  return f === o || f.startsWith(o + "/");
}

// Sorted union of every path the plan's tasks own.
export function planScope(plan) {
  const out = new Set();
  for (const t of plan.tasks || []) for (const f of t.files || []) if (typeof f === "string") out.add(normalizePath(f));
  return [...out].sort();
}

function segments(p) {
  return normalizePath(p).split("/").filter(Boolean);
}

function sharedDepth(a, b) {
  const x = segments(a).slice(0, -1); // directories only; the basename never counts
  const y = segments(b).slice(0, -1);
  let n = 0;
  while (n < x.length && n < y.length && x[n] === y[n]) n++;
  return n;
}

// Tasks whose owned files sit closest to this file in the tree: longest shared directory prefix,
// ties kept in plan order. Empty when no task owns anything in a directory the file shares.
export function nearestTasks(plan, file) {
  let best = 0;
  const hits = [];
  for (const t of plan.tasks || []) {
    let depth = 0;
    let via = null;
    for (const f of t.files || []) {
      const d = sharedDepth(f, file);
      if (d > depth || via === null) {
        depth = d;
        via = f;
      }
    }
    if (via === null || depth === 0) continue;
    if (depth > best) {
      best = depth;
      hits.length = 0;
    }
    if (depth === best) hits.push({ id: t.id, via });
  }
  return hits;
}

// Changed files the plan does not cover, after the ignore list and the flow's own files.
// Each entry: { file, nearest: [{ id, via }] }.
export function scopeViolations(changed, plan, { ignore = [] } = {}) {
  const owned = planScope(plan);
  const out = [];
  for (const raw of changed) {
    const file = normalizePath(raw);
    if (matchAny(ALWAYS_ALLOWED, file)) continue;
    if (ignore.length && matchAny(ignore, file)) continue;
    if (owned.some((o) => ownsPath(o, file))) continue;
    out.push({ file, nearest: nearestTasks(plan, file) });
  }
  return out;
}

export function describeViolations(violations, plan) {
  const lines = [`Files changed outside the ${plan.status} plan "${plan.title}" (${PLAN_RELPATH}):`];
  for (const v of violations) {
    const near = v.nearest.length ? `nearest task${v.nearest.length > 1 ? "s" : ""}: ${v.nearest.map((n) => `${n.id} (owns ${n.via})`).join(", ")}` : "no task owns anything near it";
    lines.push(`  ${v.file}  ${near}`);
  }
  lines.push(
    "The plan is the contract. Revert these files, or add them to the owning task's files and have the user re-approve the plan. " +
      "Paths that legitimately change outside any task (lockfiles, generated files) belong in stopGate.ignoreChangedPaths in .doug/config.json.",
  );
  return lines.join("\n");
}
