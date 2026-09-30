// PreCompact snapshot (decision 0002 #4, card precompact-anchor): what the next context must know, written into
// .doug/anchor.md between two marker lines so the rest of the anchor (the plan section, the user's own notes) is
// kept. Deterministic: the plan file, the decision files, this session's edited files and recent commands, and
// (card precompact-keeps-handoff) a git HEAD lookup shelled out to `git`. Nothing here estimates tokens; the
// compaction payload's estimates are ignored on purpose.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

export const SNAPSHOT_START = "<!-- doug:compaction-snapshot start -->";
export const SNAPSHOT_END = "<!-- doug:compaction-snapshot end -->";

export function readPlanSummary(dir) {
  const file = join(dir, ".doug/plan.json");
  if (!existsSync(file)) return null;
  try {
    const p = JSON.parse(readFileSync(file, "utf8"));
    if (!p || typeof p !== "object" || !Array.isArray(p.tasks)) return null;
    return { title: p.title || "(untitled)", status: p.status || "unknown", card: typeof p.card === "string" ? p.card : null, tasks: p.tasks.map((t) => ({ id: t.id, files: Array.isArray(t.files) ? t.files : [] })) };
  } catch {
    return null;
  }
}

// Short HEAD sha and current branch, tolerant of a non-repo or a git failure (moved from stop-gate.mjs; used by
// both the Stop gate's own handoff and the PreCompact snapshot).
export function gitHead(dir) {
  try {
    const sha = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: dir, encoding: "utf8", timeout: 2000 });
    const branch = spawnSync("git", ["branch", "--show-current"], { cwd: dir, encoding: "utf8", timeout: 2000 });
    return {
      sha: !sha.error && sha.status === 0 ? (sha.stdout || "").trim() || null : null,
      branch: !branch.error && branch.status === 0 ? (branch.stdout || "").trim() || null : null,
    };
  } catch {
    return { sha: null, branch: null };
  }
}

export function readDecisions(dir) {
  const d = join(dir, "docs/decisions");
  if (!existsSync(d)) return [];
  try {
    return readdirSync(d).filter((f) => f.endsWith(".md")).sort();
  } catch {
    return [];
  }
}

// The section text, without the markers. `handoff` is optional (card context-window-handoff): when present, the
// section gains a "Handoff boundary" block recording why the snapshot was taken outside a real compaction — the
// boundary name, the Stop gate's last result, the current HEAD, and the context pct that triggered it. Absent,
// the output is unchanged from before that card. The handoff block sits right after the heading line, before the
// plan/decisions/edited-files lines (card precompact-keeps-handoff, review MAJOR): those grow unbounded with a
// session's edited-file count, and SessionStart's re-injection caps the whole anchor at 4000 characters, so a few
// short handoff lines must be near the top to survive that cap on a long session.
export function snapshotSection({ plan, decisions, state, now, handoff }) {
  const lines = [`## Compaction snapshot (doug, ${now.toISOString()})`];
  if (handoff) {
    lines.push("");
    lines.push("### Handoff boundary");
    lines.push(`Boundary: ${handoff.boundary}`);
    if (handoff.gate) {
      const at = handoff.gate.at;
      lines.push(`Gate: ${handoff.gate.ok ? "green" : "red"}${Number.isFinite(at) ? ` (at ${new Date(at).toISOString()})` : ""}`);
    }
    const head = handoff.head || {};
    lines.push(`HEAD: ${head.sha || "unknown"}${head.branch ? ` (${head.branch})` : ""}`);
    if (typeof handoff.contextPct === "number") lines.push(`Context: ${handoff.contextPct}%`);
  }
  lines.push("");
  if (plan) {
    lines.push(`Plan: ${plan.title} [${plan.status}]${plan.card ? ` (card ${plan.card})` : ""}`);
    for (const t of plan.tasks) lines.push(`- ${t.id} owns ${t.files.length ? t.files.join(", ") : "(no files)"}`);
  } else lines.push("Plan: none in .doug/plan.json");
  lines.push("");
  lines.push(decisions.length ? `Decisions (docs/decisions): ${decisions.join(", ")}` : "Decisions: none under docs/decisions");
  const edited = (state && state.editedFiles) || [];
  const commands = ((state && state.commands) || []).slice(-10);
  lines.push("");
  lines.push(edited.length ? `Edited this session: ${edited.join(", ")}` : "Edited this session: nothing yet");
  lines.push(commands.length ? `Recent commands:\n${commands.map((c) => `- ${c}`).join("\n")}` : "Recent commands: none");
  return lines.join("\n");
}

// Splits anchor text into the compaction-snapshot block (markers included) and the rest, in the order each
// appeared. No snapshot section: `snapshot` is null and `rest` is the whole text unchanged. Used to put the
// snapshot first when re-injecting, so it is never cut by content that precedes it.
export function splitSnapshot(text) {
  const t = text || "";
  const start = t.indexOf(SNAPSHOT_START);
  const end = t.indexOf(SNAPSHOT_END);
  if (start < 0 || end < start) return { snapshot: null, rest: t };
  const endIdx = end + SNAPSHOT_END.length;
  const snapshot = t.slice(start, endIdx);
  const rest = (t.slice(0, start) + t.slice(endIdx)).replace(/\n{3,}/g, "\n\n").trim();
  return { snapshot, rest };
}

// The anchor with the snapshot section replaced or appended; the text outside the markers is kept byte for byte.
export function mergeSnapshot(anchorText, section) {
  const block = `${SNAPSHOT_START}\n${section}\n${SNAPSHOT_END}\n`;
  const text = anchorText || "";
  const start = text.indexOf(SNAPSHOT_START);
  const end = text.indexOf(SNAPSHOT_END);
  if (start >= 0 && end > start) return text.slice(0, start) + block + text.slice(end + SNAPSHOT_END.length).replace(/^\n/, "");
  if (!text.trim()) return block;
  return text.replace(/\n*$/, "\n\n") + block;
}
