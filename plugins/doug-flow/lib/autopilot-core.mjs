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

const MARKS = { landed: "✓", running: "▶", stopped: "✗", queued: "·", interrupted: "!" };
const usd = (n) => (typeof n === "number" ? `$${n.toFixed(2)}` : "-");
const num = (n, suffix = "") => (typeof n === "number" ? `${n}${suffix}` : "-");

const minutes = (ms) => Math.max(0, Math.floor(ms / 60000));
const mins = (fromMs, nowMs) => (typeof fromMs === "number" && Number.isFinite(fromMs) ? `${minutes(nowMs - fromMs)}m` : "");

// The seats of a queen run read from its journal texts (lines of {type: started|result|failed, key, agentId, label,
// phase}), in order. An entry is a key (a retry of a key replaces its agent, a key replayed in a resumed journal is
// the same seat); consecutive entries with one seat name (the phase lowercased) collapse into one seat. A seat is
// done when all its keys have a result, failed when none still runs and one failed, running otherwise. startedMs maps
// agentId to the seat's start; a running seat's elapsed is from its earliest running agent. Never throws.
export function journalSeats(texts, startedMs = {}, now = new Date()) {
  const nowMs = new Date(now).getTime();
  const entries = new Map();
  for (const text of Array.isArray(texts) ? texts : []) {
    for (const raw of String(text ?? "").split("\n")) {
      let o;
      try {
        o = JSON.parse(raw);
      } catch {
        continue;
      }
      if (!o || typeof o !== "object" || typeof o.key !== "string") continue;
      const e = entries.get(o.key);
      if (o.type === "started") {
        if (!e) entries.set(o.key, { phase: o.phase, label: o.label, agentId: o.agentId, status: "running" });
        else if (e.status !== "done") Object.assign(e, { agentId: o.agentId, status: "running" });
      } else if (o.type === "result" && e) e.status = "done";
      else if (o.type === "failed" && e && e.status !== "done") e.status = "failed";
    }
  }
  const seats = [];
  for (const e of entries.values()) {
    const name = (typeof e.phase === "string" && e.phase ? e.phase : String(e.label ?? "").split(":")[0]).toLowerCase();
    const last = seats[seats.length - 1];
    if (last && last.name === name) last.entries.push(e);
    else seats.push({ name, entries: [e] });
  }
  return seats.map(({ name, entries: es }) => {
    const running = es.filter((e) => e.status === "running");
    const status = running.length ? "running" : es.some((e) => e.status === "failed") ? "failed" : "done";
    const starts = running.map((e) => startedMs?.[e.agentId]).filter((m) => typeof m === "number" && Number.isFinite(m));
    return { name, status, elapsed: status === "running" && starts.length ? mins(Math.min(...starts), nowMs) : "" };
  });
}

// The agentId -> start millisecond map from a directory listing ($.fs.list or readdir + stat shaped
// { name, mtimeMs }): an agent-<id>.meta.json is written once at the seat's start.
export function startedFromList(list) {
  const out = {};
  for (const f of Array.isArray(list) ? list : []) {
    const m = f && typeof f.name === "string" ? /^agent-(.+)\.meta\.json$/.exec(f.name) : null;
    if (m && typeof f.mtimeMs === "number") out[m[1]] = f.mtimeMs;
  }
  return out;
}

const seatText = (seats) => seats.map((s) => (s.status === "done" ? `${s.name} ✓` : s.status === "failed" ? `${s.name} ✗` : `${s.name} ▶${s.elapsed ? ` ${s.elapsed}` : ""}`)).join(" ");

// A card main runs itself: its seat history from c.seats ({ step, startedAt }), or the single latest step.
function mainSeats(c, nowMs) {
  let list = Array.isArray(c.seats) ? c.seats.filter((x) => x && typeof x === "object" && x.step) : [];
  if (!list.length && c.step) list = [{ step: c.step, startedAt: c.stepStartedAt }];
  return list.map((x, i) =>
    i < list.length - 1 ? { name: String(x.step), status: "done", elapsed: "" } : { name: String(x.step), status: "running", elapsed: mins(Date.parse(x.startedAt), nowMs) },
  );
}

// The view of a state at `now` (a Date or a millisecond count), or null for a null state.
// `run` maps a card id to { journals: [text], startedMs: { agentId: ms } } for a queen card (the journal side reads it).
export function autopilotView(state, now = new Date(), run = {}) {
  if (!state || typeof state !== "object") return null;
  const nowMs = new Date(now).getTime();
  const ended = state.status === "ended";
  const updated = Date.parse(state.updatedAt);
  const stale = !ended && !(nowMs - updated <= INACTIVE_MS);
  const mode = ended ? "ended" : stale ? "inactive" : "running";
  const live = mode === "running";

  const groupOf = { running: "Running", queued: "Queued", landed: "Landed", stopped: "Stopped", interrupted: "Stopped" };
  const groups = ["Running", "Queued", "Landed", "Stopped"].map((title) => ({ title, cards: [] }));
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
      let status = "";
      if (cardState === "running") {
        const data = run && run[c.id];
        const fromJournal = data && Array.isArray(data.journals) ? journalSeats(data.journals, data.startedMs, nowMs) : [];
        const seats = fromJournal.length ? fromJournal : mainSeats(c, nowMs);
        status = seats.length ? seatText(seats) : "started";
      } else if (cardState === "landed") status = c.commit ? String(c.commit).slice(0, 7) : "";
      else if (cardState === "stopped") status = c.reason ? String(c.reason) : "";
      else if (cardState === "interrupted") status = "interrupted";
      const g = groups.find((x) => x.title === groupOf[cardState]);
      if (g) g.cards.push({ id: c.id, state: cardState, mark: MARKS[cardState] ?? "?", status });
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
    groups: groups.filter((g) => g.cards.length),
    spend: `${usd(used.usd)} / ${usd(caps.usd)}, ${typeof used.wallMin === "number" ? Math.round(used.wallMin) : "-"} / ${num(caps.wallMin)} min, ctx ${num(used.contextPct, "%")}`,
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

// Whether a new run may drop this state: an ended or inactive (stale) run; a running one is never cleared.
export function clearable(state, now = new Date()) {
  const v = autopilotView(state, now);
  return !!v && (v.mode === "ended" || v.mode === "inactive");
}

// The view as text lines for a text surface: the header, the Running / Queued / Landed / Stopped blocks (an empty
// block omitted, one short line per card), the spend line, one line per filed card.
export function autopilotLines(view) {
  if (!view) return [];
  const lines = [view.header];
  for (const g of view.groups ?? []) {
    lines.push(g.title);
    for (const c of g.cards) lines.push(`  ${c.mark} ${c.id}${c.status ? ` ${c.status}` : ""}`);
  }
  lines.push(view.spend);
  for (const f of view.filed) {
    lines.push(`+ ${f.id} (${f.kind}${f.from ? ` from ${f.from}` : ""}) ${f.position ?? ""}`.trimEnd());
  }
  return lines;
}
