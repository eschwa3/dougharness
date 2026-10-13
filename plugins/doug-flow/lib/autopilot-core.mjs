// The pure half of the autopilot view (card autopilot-live-queue): no Node imports, so the live pane's hooks module
// (which may import only its own files) can use it. lib/autopilot-view.mjs re-exports it and adds the file read.
export const AUTOPILOT_FILE = ".doug/.state/autopilot.json";
export const STEPS = ["research", "tester", "coder", "reviewer", "gate", "commit", "record"];
// A running file untouched for this long is no longer a live run (the lead died or the session closed). The lead's
// conservative choice where the card is silent.
export const INACTIVE_MS = 2 * 60 * 60 * 1000;

// The state parsed from file text, or null for invalid JSON, a wrong version, or a non-object. Never throws.
export function parseAutopilot(text) {
  try {
    const s = JSON.parse(text);
    if (!s || typeof s !== "object" || Array.isArray(s) || s.version !== 1) return null;
    if (s.cards !== undefined && !Array.isArray(s.cards)) return null;
    return s;
  } catch {
    return null;
  }
}

const hhmm = (iso) => {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

const usd = (n) => (typeof n === "number" ? `$${n.toFixed(2)}` : "-");
const num = (n, suffix = "") => (typeof n === "number" ? `${n}${suffix}` : "-");

// The view of a state at `now` (a Date or a millisecond count), or null for a null state.
export function autopilotView(state, now = new Date()) {
  if (!state || typeof state !== "object") return null;
  const nowMs = new Date(now).getTime();
  const ended = state.status === "ended";
  const updated = Date.parse(state.updatedAt);
  const stale = !ended && !(nowMs - updated <= INACTIVE_MS);
  const mode = ended ? "ended" : stale ? "inactive" : "running";
  const live = mode === "running";

  const cards = (Array.isArray(state.cards) ? state.cards : [])
    .filter((c) => c && typeof c === "object")
    .map((c) => {
      let cardState = c.state;
      let detail = "";
      if (cardState === "running" && !live) {
        cardState = "interrupted";
        detail = "interrupted";
      } else if (cardState === "running") {
        detail = c.step ? `${c.step} since ${hhmm(c.stepStartedAt)}`.trim() : "started";
      } else if (cardState === "landed") {
        detail = c.commit ? String(c.commit) : "";
      } else if (cardState === "stopped") {
        detail = c.reason ? String(c.reason) : "";
      }
      return { id: c.id, title: c.title ?? "", size: c.size ?? "", class: c.class ?? "", state: cardState, detail };
    });

  const runningCard = live ? (Array.isArray(state.cards) ? state.cards : []).find((c) => c && c.state === "running") : null;
  const running = live
    ? (Array.isArray(state.cards) ? state.cards : []).filter((c) => c && c.state === "running").map((c) => ({ id: c.id, runId: c.runId ?? null }))
    : [];
  const current = runningCard ? { id: runningCard.id, step: runningCard.step ?? null, since: runningCard.step ? hhmm(runningCard.stepStartedAt) : null } : null;

  const landed = cards.filter((c) => c.state === "landed").length;
  const stopped = cards.filter((c) => c.state === "stopped").length;
  const header =
    mode === "ended"
      ? `Autopilot ended ${hhmm(state.endedAt ?? state.updatedAt)}: ${landed} landed, ${stopped} stopped`.replace(/\s+:/, ":")
      : mode === "inactive"
        ? `Autopilot inactive since ${hhmm(state.updatedAt)}`
        : `Autopilot running since ${hhmm(state.startedAt)}`;

  const caps = state.caps && typeof state.caps === "object" ? state.caps : {};
  const used = state.used && typeof state.used === "object" ? state.used : {};
  return {
    mode,
    header,
    cards,
    current,
    running,
    caps: {
      usd: `${usd(used.usd)} / ${usd(caps.usd)}`,
      wall: `${num(used.wallMin)} / ${num(caps.wallMin)} min`,
      context: `${num(used.contextPct, "%")} / ${num(caps.contextPct, "%")}`,
    },
    filed: (Array.isArray(state.filed) ? state.filed : []).filter((f) => f && typeof f === "object").map((f) => ({ ...f })),
  };
}

// Whether the live pane should open on its own: a running, still-active run whose startedAt is not the one already
// opened for (a closed pane is not reopened for the same run). `autoOpen` false (autopilot.autoOpenPane) turns it off.
export function shouldOpenPane(state, lastOpenedStartedAt, autoOpen = true, now = new Date()) {
  if (autoOpen === false) return false;
  if (!state || typeof state !== "object") return false;
  if (state.status !== "running") return false;
  if (typeof state.startedAt !== "string" || state.startedAt === "") return false;
  if (state.startedAt === lastOpenedStartedAt) return false;
  return autopilotView(state, now)?.mode === "running";
}

const MARKS = { landed: "✓", running: "▶", stopped: "✗", queued: "·", interrupted: "!" };

// The view as text lines for a text surface: the header, one line per card, a caps line, one line per filed card.
export function autopilotLines(view) {
  if (!view) return [];
  const lines = [view.header];
  for (const c of view.cards) {
    const shape = [c.size, c.class].filter(Boolean).join("/");
    lines.push(`${MARKS[c.state] ?? "?"} ${c.id}${c.title ? ` ${c.title}` : ""}${shape ? ` (${shape})` : ""}${c.detail ? ` ${c.detail}` : ""}`);
  }
  lines.push(`caps: usd ${view.caps.usd}, wall ${view.caps.wall}, context ${view.caps.context}`);
  for (const f of view.filed) {
    lines.push(`+ ${f.id} (${f.kind}${f.from ? ` from ${f.from}` : ""}) ${f.position ?? ""}`.trimEnd());
  }
  return lines;
}
