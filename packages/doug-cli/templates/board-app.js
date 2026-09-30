// Doug Board: the page is the record. Cards are rendered from BOARD (embedded JSON); a move is
// written to the board file by `doug board serve`.
const CSS = `
:root{--ground:#f3f4f1;--surface:#fff;--ink:#1b1f1d;--ink-soft:#545c58;--rule:#d6dbd5;--rule-strong:#aeb6af;--accent:#2f6f4e;--accent-ink:#fff;--drop:#e2efe6;--code-bg:#eceee9;
--c-gates:#2f6f4e;--c-flow:#2b5f8a;--c-codex:#7a4d05;--c-init:#5d5a8f;--c-memory:#8a3b5e;--c-learn:#3e6e6a;--c-eval:#6b5d2a;--c-release:#4b5760;--c-decision:#8b2f2f}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){--ground:#15181a;--surface:#1c2022;--ink:#e6e9e5;--ink-soft:#a3aca6;--rule:#2d3336;--rule-strong:#465056;--accent:#6fbf95;--accent-ink:#0f1a14;--drop:#1f3a2c;--code-bg:#23282b;
--c-gates:#7fcaa3;--c-flow:#86b6e0;--c-codex:#e0b46b;--c-init:#b2aee6;--c-memory:#e08fb3;--c-learn:#8fc9c4;--c-eval:#d1c07a;--c-release:#aab5bd;--c-decision:#e58a8a}}
:root[data-theme=dark]{--ground:#15181a;--surface:#1c2022;--ink:#e6e9e5;--ink-soft:#a3aca6;--rule:#2d3336;--rule-strong:#465056;--accent:#6fbf95;--accent-ink:#0f1a14;--drop:#1f3a2c;--code-bg:#23282b;
--c-gates:#7fcaa3;--c-flow:#86b6e0;--c-codex:#e0b46b;--c-init:#b2aee6;--c-memory:#e08fb3;--c-learn:#8fc9c4;--c-eval:#d1c07a;--c-release:#aab5bd;--c-decision:#e58a8a}
*{box-sizing:border-box}html,body{margin:0}
body{background:var(--ground);color:var(--ink);font-family:"Source Sans 3","Helvetica Neue",Arial,sans-serif;font-size:15px;line-height:1.4;min-height:100vh}
h1{font-family:Archivo,"Helvetica Neue",Arial,sans-serif;font-size:26px;font-weight:700;letter-spacing:-.01em;margin:0}
.mono{font-family:"IBM Plex Mono",Menlo,monospace}
header{display:flex;flex-wrap:wrap;align-items:center;gap:10px 24px;padding:18px 24px 12px;border-bottom:2px solid var(--ink)}
header .sub{color:var(--ink-soft);font-size:14px}
.tools{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-left:auto}
.tools label{font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:var(--ink-soft);font-family:"IBM Plex Mono",Menlo,monospace}
select,button{font:inherit;font-size:14px;color:var(--ink);background:var(--surface);border:1px solid var(--rule-strong);border-radius:3px;padding:5px 9px}
button{cursor:pointer}button:focus-visible,select:focus-visible,.card:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.status{font-size:13px;color:var(--ink-soft);min-height:1.2em}
.board{display:grid;grid-auto-flow:column;grid-auto-columns:minmax(250px,1fr);gap:14px;padding:16px 24px 40px;overflow-x:auto;align-items:start}
.col{background:var(--surface);border:1px solid var(--rule);display:flex;flex-direction:column;min-height:200px}
.col.over{background:var(--drop);border-color:var(--accent)}
.col-head{padding:10px 12px 8px;border-bottom:1px solid var(--rule-strong);display:flex;align-items:baseline;gap:8px}
.col-head h2{font-family:"IBM Plex Mono",Menlo,monospace;font-size:12px;letter-spacing:.08em;text-transform:uppercase;font-weight:500;margin:0}
.col-head .n{margin-left:auto;font-family:"IBM Plex Mono",Menlo,monospace;font-size:12px;color:var(--ink-soft);font-variant-numeric:tabular-nums}
.col-hint{padding:6px 12px 0;font-size:12px;color:var(--ink-soft)}
.cards{padding:10px;display:flex;flex-direction:column;gap:8px;flex:1}
.card{background:var(--ground);border:1px solid var(--rule);padding:9px 10px 8px;cursor:grab;position:relative}
.card[hidden]{display:none}
.card.dragging{opacity:.45}
.card.drop-before{box-shadow:inset 0 3px 0 var(--accent)}
.card.drop-after{box-shadow:inset 0 -3px 0 var(--accent)}
.card .top{display:flex;gap:8px;align-items:center;margin-bottom:4px}
.chip{font-family:"IBM Plex Mono",Menlo,monospace;font-size:10.5px;letter-spacing:.05em;text-transform:uppercase;padding:1px 6px;border-radius:3px;border:1px solid currentColor}
.chip.hand{border-style:dashed;color:var(--ink-soft)}
.chip.tag{color:var(--ink-soft)}
.chip.class{color:var(--ink-soft)}
.size{margin-left:auto;font-family:"IBM Plex Mono",Menlo,monospace;font-size:11px;color:var(--ink-soft)}
.title{font-weight:600;font-size:14.5px;text-wrap:balance}
.meta{font-size:12px;color:var(--ink-soft);margin-top:3px}
.meta code{font-family:"IBM Plex Mono",Menlo,monospace;font-size:11px;background:var(--code-bg);padding:0 4px;border-radius:3px}
details{margin-top:6px}summary{font-size:12px;color:var(--accent);cursor:pointer}
.goal{font-size:13px;margin:6px 0 0;color:var(--ink);white-space:pre-wrap}
.move{margin-top:8px;display:flex;gap:6px;align-items:center}.move select{font-size:12px;padding:3px 6px}
.ro .card{cursor:default}.ro .move{display:none}
footer{padding:0 24px 24px;font-size:12px;color:var(--ink-soft)}
@media (max-width:720px){.board{grid-auto-columns:minmax(85vw,1fr)}}
`;

const FONTS = '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wght@500;700&family=Source+Sans+3:wght@400;600&family=IBM+Plex+Mono:wght@400;500&display=swap">';

function esc(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }

function cardHtml(c, columns) {
  const deps = (c.deps || []).length ? `<div class="meta">after <code>${c.deps.map(esc).join("</code> <code>")}</code></div>` : "";
  const opts = columns.map((col) => `<option value="${col.id}"${col.id === c.column ? " selected" : ""}>${esc(col.title)}</option>`).join("");
  const chip = c.component ? `<span class="chip" style="color:var(--c-${esc(c.component)})">${esc(c.component)}</span>` : "";
  // A hand-track card is built in the checkout, never by /doug-next (decision 0005); the chip says so at a glance.
  const hand = c.track === "hand" ? `<span class="chip hand" title="hand track: built in the checkout, not by /doug-next">by hand</span>` : "";
  const tags = c.tags && c.tags.length ? c.tags.map((t) => `<span class="chip tag">${esc(t)}</span>`).join("") : "";
  const cls = c.class ? `<span class="chip class" title="class">${esc(c.class)}</span>` : "";
  const compAttr = c.component ? ` data-component="${esc(c.component)}"` : "";
  const tagsAttr = c.tags && c.tags.length ? ` data-tags="${esc(c.tags.join(" "))}"` : "";
  return `<article class="card" draggable="true" tabindex="0" data-id="${esc(c.id)}"${compAttr} data-column="${esc(c.column)}"${tagsAttr}>
<div class="top">${chip}${hand}${tags}${cls}<span class="size">${esc(c.size || "")}</span></div>
<div class="title">${esc(c.title)}</div>
<div class="meta"><code>${esc(c.id)}</code>${c.source ? ` · ${esc(c.source)}` : ""}</div>
${deps}
${c.goal ? `<details><summary>goal</summary><p class="goal">${esc(c.goal)}</p></details>` : ""}
<div class="move"><label class="meta" for="mv-${esc(c.id)}">move to</label><select id="mv-${esc(c.id)}" data-move="${esc(c.id)}">${opts}</select></div>
</article>`;
}

// Done reads newest first: a card moves to Done long after it was added, so record order would bury the latest
// landing at the bottom of the longest column. Every other column keeps record order, which is priority.
function columnHtml(col, cards, columns) {
  const mine = cards.filter((c) => c.column === col.id);
  const ordered = col.id === "done" ? [...mine].reverse() : mine;
  const hint = col.id === "done" ? `${col.hint || ""}${col.hint ? " · " : ""}newest first` : col.hint || "";
  return `<section class="col" data-column="${esc(col.id)}">
<div class="col-head"><h2>${esc(col.title)}</h2><span class="n">${mine.length}</span></div>
<div class="col-hint">${esc(hint)}</div>
<div class="cards">${ordered.map((c) => cardHtml(c, columns)).join("\n")}</div>
</section>`;
}

function footerHtml(config) {
  const first = 'Drag a card to a column or above or below another card in its column, or use its "move to" select; Alt+Up and Alt+Down move the focused card within its column.';
  const rest = ` Served by doug board serve, a move writes ${esc(config.record)}; opened as a file, this page is read-only.`;
  return `<footer>${first}${rest}</footer>`;
}

// Which side of a card a drop lands on: the card's top half is "before", the bottom half is "after".
function dropPlacement(clientY, rect) {
  return clientY < rect.top + rect.height / 2 ? "before" : "after";
}

// Reorders `cards` per the library's reorderCard slot rule (the column's cards keep the same array
// slots; only their order changes) but never throws: a target that is the card itself or lives in
// another column returns an unchanged copy of the input. Never mutates its input.
function reorderCards(cards, id, placement) {
  const result = cards.slice();
  const key = placement && typeof placement === "object" && Object.prototype.hasOwnProperty.call(placement, "before")
    ? "before"
    : placement && typeof placement === "object" && Object.prototype.hasOwnProperty.call(placement, "after")
    ? "after"
    : null;
  const card = result.find((c) => c.id === id);
  if (!card || !key) return result;
  const targetId = placement[key];
  if (targetId === id) return result;
  const target = result.find((c) => c.id === targetId);
  if (!target || target.column !== card.column) return result;
  const column = card.column;
  const indices = [];
  result.forEach((c, i) => { if (c.column === column) indices.push(i); });
  const others = indices.map((i) => result[i]).filter((c) => c.id !== id);
  const targetPos = others.findIndex((c) => c.id === targetId);
  const insertAt = key === "before" ? targetPos : targetPos + 1;
  const reordered = [...others.slice(0, insertAt), card, ...others.slice(insertAt)];
  indices.forEach((slot, i) => { result[slot] = reordered[i]; });
  return result;
}

// Opens an SSE connection to `opts.url` and reconnects after a drop. `opts.EventSource`,
// `opts.setTimeout` and `opts.clearTimeout` are injected so a test can supply fakes; when omitted
// (as a real page's caller may do) they default to the global timer functions, so a dropped
// connection always reconnects. `opts.retryMs` (default 1000) is how long it waits after a drop
// before opening a new source. Returns { close() }, which closes the current source and cancels a
// pending retry.
function connectLive(opts) {
  const retryMs = opts.retryMs === undefined ? 1000 : opts.retryMs;
  const doSetTimeout = opts.setTimeout || setTimeout;
  const doClearTimeout = opts.clearTimeout || clearTimeout;
  let source = null;
  let retryTimer = null;
  let closed = false;
  let dropped = false;

  function open() {
    const es = new opts.EventSource(opts.url);
    source = es;
    es.addEventListener("open", () => {
      if (source !== es) return;
      dropped = false;
      opts.onState("live");
    });
    es.addEventListener("error", () => {
      if (source !== es) return;
      es.close();
      source = null;
      if (!dropped) {
        dropped = true;
        opts.onState("reconnecting");
      }
      retryTimer = doSetTimeout(() => {
        retryTimer = null;
        if (!closed) open();
      }, retryMs);
    });
    es.addEventListener("board", (e) => {
      if (source !== es) return;
      opts.onBoard(JSON.parse(e.data));
    });
  }
  open();

  return {
    close() {
      closed = true;
      if (retryTimer !== null) {
        try { doClearTimeout(retryTimer); } catch (_) {}
        retryTimer = null;
      }
      if (source) { source.close(); source = null; }
    },
  };
}

// The serialized shape of a board's columns: id, order, title, and hint. Two boards whose columns
// differ in any of these need a reload rather than an in-place re-render.
function columnShape(board) {
  return JSON.stringify(board.columns.map((c) => ({ id: c.id, title: c.title, hint: c.hint == null ? null : c.hint })));
}

// Sorted component list and sorted tag list, compared to decide whether the filters need a reload.
function componentAndTagShape(board) {
  return JSON.stringify({ components: [...board.components].sort(), tags: tagOptions(board.cards).sort() });
}

// The header's counts-and-record line: how many cards, how many done, when the record was last
// updated, and where it lives. Shared by the initial render and a live update's in-place patch.
function headerSubHtml(board, config) {
  const done = board.cards.filter((c) => c.column === "done").length;
  return `${board.cards.length} cards · ${done} done · updated ${esc(board.updated)} · record: <span class="mono">${esc(config.record)}</span>`;
}

function CSS_escape(s) { return (typeof window !== "undefined" && window.CSS && window.CSS.escape) ? window.CSS.escape(s) : String(s).replace(/"/g, '\\"'); }

// Applied to a live board pushed over SSE, in local mode. When the columns (their ids, order,
// titles, or hints) or the set of components/tags changed, the view is stale in ways an in-place
// patch cannot fix cleanly, so it reloads instead. Otherwise it re-renders each column's cards in
// place (the column elements carrying drop listeners are untouched) and the header counts line,
// and returns the board to keep as current state; a reload returns null. `opts.document` and
// `opts.location` default to the globals and are overridable for a test.
function applyLiveBoard(board, next, config, opts) {
  opts = opts || {};
  const doc = opts.document !== undefined ? opts.document : (typeof document !== "undefined" ? document : null);
  const loc = opts.location !== undefined ? opts.location : (typeof location !== "undefined" ? location : null);
  if (columnShape(board) !== columnShape(next) || componentAndTagShape(board) !== componentAndTagShape(next)) {
    if (loc && typeof loc.reload === "function") loc.reload();
    return null;
  }
  if (doc) {
    for (const col of next.columns) {
      const container = doc.querySelector('.col[data-column="' + CSS_escape(col.id) + '"] .cards');
      if (!container) continue;
      const mine = next.cards.filter((c) => c.column === col.id);
      const ordered = col.id === "done" ? [...mine].reverse() : mine;
      container.innerHTML = ordered.map((c) => cardHtml(c, next.columns)).join("\n");
    }
    const sub = doc.querySelector("header .sub");
    if (sub) sub.innerHTML = headerSubHtml(next, config);
  }
  return next;
}

// Sorted unique tags across the cards that carry any; an empty array when none does. Never mutates its input.
function tagOptions(cards) {
  const set = new Set();
  for (const c of cards) for (const t of c.tags || []) set.add(t);
  return Array.from(set).sort();
}

// Whether a card passes { component, tag } filters, where "" means no filter. A card with no `tags`
// matches the tag filter only when it is "". Never mutates its input.
function cardMatches(card, filters) {
  const component = (filters && filters.component) || "";
  const tag = (filters && filters.tag) || "";
  if (component && card.component !== component) return false;
  if (tag) {
    const tags = card.tags || [];
    if (!tags.includes(tag)) return false;
  }
  return true;
}

// The complete document for a given board state; `doug board serve` renders it from the record on
// every request.
function renderDoc(board, appSource, config) {
  const comps = board.components.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join("");
  const tags = tagOptions(board.cards);
  const tagFilter = tags.length
    ? `<label for="tag-filter">tag</label><select id="tag-filter"><option value="">all</option>${tags.map((t) => `<option value="${esc(t)}">${esc(t)}</option>`).join("")}</select>`
    : "";
  const head = `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>Doug Board</title>\n${FONTS}\n<style>${CSS}</style>\n</head>\n<body>\n`;
  const tail = `\n</body>\n</html>\n`;
  return head + `<header>
<div><h1>Doug Board</h1><div class="sub">${headerSubHtml(board, config)}</div></div>
<div class="tools">
<label for="filter">component</label><select id="filter"><option value="">all</option>${comps}</select>
${tagFilter ? tagFilter + "\n" : ""}<span class="status" id="filter-note"></span>
<button type="button" id="copy">Copy board JSON</button>
<span class="status" id="status"></span>
</div>
</header>
<main class="board" id="board">
${board.columns.map((col) => columnHtml(col, board.cards, board.columns)).join("\n")}
</main>
${footerHtml(config)}
<script type="application/json" id="board-config">${JSON.stringify(config).replace(/</g, "\\u003c")}<\/script>
<script type="application/json" id="board-data">${JSON.stringify(board).replace(/</g, "\\u003c")}<\/script>
<script id="app">${appSource}<\/script>` + tail;
}

function app() {
  const dataEl = document.getElementById("board-data");
  let board = JSON.parse(dataEl.textContent);
  const config = JSON.parse(document.getElementById("board-config").textContent);
  const local = config.mode === "local";
  const status = document.getElementById("status");
  // In local mode the page stays read-only until `doug board serve` answers for it.
  let readOnly = local;

  const say = (m) => { status.textContent = m; };
  const setReadOnly = (why) => { readOnly = true; document.body.classList.add("ro"); say(why); };

  function moveCard(id, column) {
    const card = board.cards.find((c) => c.id === id);
    if (!card || card.column === column) return;
    if (readOnly) { say("This view is read-only; the move was not saved."); return; }
    card.column = column;
    board.updated = new Date().toISOString().slice(0, 10);
    // Optimistic: move the element now; the save confirms it (or puts the view back).
    const el = document.querySelector(`.card[data-id="${CSS_escape(id)}"]`);
    const target = document.querySelector(`.col[data-column="${CSS_escape(column)}"] .cards`);
    if (el && target) { if (column === "done") target.prepend(el); else target.appendChild(el); el.dataset.column = column; }
    refreshCounts();
    if (local) save(id, { column: column });
  }

  // Places a card relative to another card, possibly moving it to that card's column first.
  // Same column rule as moveCard, minus its early return: an unchanged column still reorders.
  function placeCard(id, column, placement) {
    const key = Object.prototype.hasOwnProperty.call(placement, "before") ? "before" : "after";
    const targetId = placement[key];
    if (targetId === id) return;
    const card = board.cards.find((c) => c.id === id);
    if (!card) return;
    if (readOnly) { say("This view is read-only; the move was not saved."); return; }
    if (card.column !== column) card.column = column;
    const el = document.querySelector(`.card[data-id="${CSS_escape(id)}"]`);
    const targetEl = document.querySelector(`.card[data-id="${CSS_escape(targetId)}"]`);
    if (el) el.dataset.column = column;
    if (el && targetEl) { if (key === "before") targetEl.before(el); else targetEl.after(el); }
    refreshCounts();
    if (local) save(id, { column: column, [key]: targetId });
  }

  function refreshCounts() {
    for (const col of document.querySelectorAll(".col")) {
      col.querySelector(".n").textContent = col.querySelectorAll(".card:not([hidden])").length;
    }
  }

  // Local mode: `doug board serve` writes the move with the same library `doug board move` uses,
  // so it is validated the same way. Nothing on this path ever touches window.claude.
  let saving = false;
  async function save(id, body) {
    if (saving) return;
    saving = true;
    say("Saving…");
    try {
      const res = await fetch("/api/cards/" + encodeURIComponent(id), {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.status === 200) {
        board = await res.json();
        say("Saved to " + config.record + ".");
      } else {
        let message = "The move was rejected (" + res.status + ").";
        try { const body = await res.json(); if (body && body.error) message = body.error; } catch (_) {}
        reloadAfter(message);
      }
    } catch (_) {
      reloadAfter("Could not reach doug board serve; the move was not saved.");
    } finally {
      saving = false;
    }
  }

  // Say why the move did not stick, then put the view back to what the file says.
  function reloadAfter(message) {
    say(message);
    setTimeout(() => location.reload(), 1500);
  }

  // Drag and drop, including reordering: hovering over a card in another column (except Done)
  // remembers where the drop would land and marks the card with an insertion line.
  let dragId = null;
  let dropTarget = null;
  function clearDropMarks() {
    for (const el of document.querySelectorAll(".drop-before, .drop-after")) el.classList.remove("drop-before", "drop-after");
  }
  document.addEventListener("dragstart", (e) => {
    const card = e.target.closest && e.target.closest(".card");
    if (!card || readOnly) return;
    dragId = card.dataset.id;
    card.classList.add("dragging");
    e.dataTransfer.effectAllowed = "move";
    try { e.dataTransfer.setData("text/plain", dragId); } catch (_) {}
  });
  document.addEventListener("dragend", (e) => {
    const card = e.target.closest && e.target.closest(".card");
    if (card) card.classList.remove("dragging");
    for (const col of document.querySelectorAll(".col.over")) col.classList.remove("over");
    clearDropMarks();
    dropTarget = null;
  });
  document.addEventListener("dragover", (e) => {
    const card = e.target.closest && e.target.closest(".card");
    if (!card || !dragId || card.dataset.id === dragId) return;
    const col = card.closest(".col");
    if (!col || col.dataset.column === "done") return;
    e.preventDefault();
    const placement = dropPlacement(e.clientY, card.getBoundingClientRect());
    dropTarget = { id: card.dataset.id, placement: placement, column: col.dataset.column };
    clearDropMarks();
    card.classList.add(placement === "before" ? "drop-before" : "drop-after");
  });
  document.addEventListener("dragleave", (e) => {
    const card = e.target.closest && e.target.closest(".card");
    if (card) card.classList.remove("drop-before", "drop-after");
    dropTarget = null;
  });
  for (const col of document.querySelectorAll(".col")) {
    col.addEventListener("dragover", (e) => { if (dragId && !readOnly) { e.preventDefault(); col.classList.add("over"); } });
    col.addEventListener("dragleave", () => col.classList.remove("over"));
    col.addEventListener("drop", (e) => {
      e.preventDefault();
      col.classList.remove("over");
      const id = dragId || e.dataTransfer.getData("text/plain");
      dragId = null;
      const target = dropTarget && dropTarget.column === col.dataset.column ? dropTarget : null;
      clearDropMarks();
      dropTarget = null;
      if (!id) return;
      if (target) placeCard(id, col.dataset.column, target.placement === "before" ? { before: target.id } : { after: target.id });
      else moveCard(id, col.dataset.column);
    });
  }
  // Alt+Up / Alt+Down move the focused card within its column; Done stays chronological.
  document.addEventListener("keydown", (e) => {
    if (!e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
    const card = document.activeElement && document.activeElement.closest && document.activeElement.closest(".card");
    if (!card) return;
    const id = card.dataset.id;
    const column = card.dataset.column;
    if (column === "done") { e.preventDefault(); say("Done is chronological; it is not reordered."); return; }
    const list = card.closest(".cards");
    const cards = list ? Array.from(list.querySelectorAll(".card:not([hidden])")) : [];
    const idx = cards.indexOf(card);
    if (e.key === "ArrowUp") {
      const prev = idx > 0 ? cards[idx - 1] : null;
      if (!prev) { say("Already at the top."); return; }
      e.preventDefault();
      placeCard(id, column, { before: prev.dataset.id });
    } else {
      const next = idx >= 0 && idx < cards.length - 1 ? cards[idx + 1] : null;
      if (!next) { say("Already at the bottom."); return; }
      e.preventDefault();
      placeCard(id, column, { after: next.dataset.id });
    }
    card.focus();
  });
  // Touch fallback.
  document.addEventListener("change", (e) => {
    const sel = e.target.closest && e.target.closest("select[data-move]");
    if (sel) moveCard(sel.dataset.move, sel.value);
  });

  // Per-view filter (never written to the record).
  const filter = document.getElementById("filter");
  const tagFilter = document.getElementById("tag-filter");
  try { const saved = localStorage.getItem("doug-board-filter"); if (saved) filter.value = saved; } catch (_) {}
  if (tagFilter) {
    try {
      const saved = localStorage.getItem("doug-board-tag-filter");
      if (saved && Array.from(tagFilter.options).some((o) => o.value === saved)) tagFilter.value = saved;
    } catch (_) {}
  }
  // A tag itself may contain spaces (e.g. "needs review"), and data-tags joins every tag on the card
  // with a single space, so a naive split cannot tell a two-word tag from two one-word tags. Reconstruct
  // against the known tag options instead, matching the longest known tag first.
  const knownTags = tagFilter ? Array.from(tagFilter.options).map((o) => o.value).filter((v) => v) : [];
  const sortedKnownTags = [...knownTags].sort((a, b) => b.split(" ").length - a.split(" ").length);
  const parseCardTags = (attr) => {
    if (!attr) return [];
    const words = attr.split(" ");
    const tags = [];
    let i = 0;
    while (i < words.length) {
      const found = sortedKnownTags.find((t) => {
        const tWords = t.split(" ");
        return words.slice(i, i + tWords.length).join(" ") === t;
      });
      if (found) { tags.push(found); i += found.split(" ").length; }
      else { tags.push(words[i]); i += 1; }
    }
    return tags;
  };
  const applyFilter = () => {
    const component = filter.value;
    const tag = tagFilter ? tagFilter.value : "";
    for (const card of document.querySelectorAll(".card")) {
      const shape = { component: card.dataset.component || "", tags: parseCardTags(card.dataset.tags) };
      card.hidden = !cardMatches(shape, { component: component, tag: tag });
    }
    refreshCounts();
    // A saved filter is easy to forget; say what it hides so the column counts are not mistaken for the board.
    const all = document.querySelectorAll(".card").length;
    const shown = document.querySelectorAll(".card:not([hidden])").length;
    document.getElementById("filter-note").textContent = component || tag ? `showing ${shown} of ${all} cards` : "";
    try { localStorage.setItem("doug-board-filter", component); } catch (_) {}
    if (tagFilter) { try { localStorage.setItem("doug-board-tag-filter", tag); } catch (_) {} }
  };
  filter.addEventListener("change", applyFilter);
  if (tagFilter) tagFilter.addEventListener("change", applyFilter);
  applyFilter();

  document.getElementById("copy").addEventListener("click", async () => {
    const text = JSON.stringify(board, null, 2) + "\n";
    try { await navigator.clipboard.writeText(text); say("Board JSON copied; paste it into " + config.record + "."); }
    catch (_) { say("Clipboard unavailable here. Read the JSON from the page source (script#board-data)."); }
  });

  // Light up saving once the server answers.
  if (local) {
    // Hidden until the server answers, so a file:// copy never shows controls that cannot save.
    document.body.classList.add("ro");
    fetch("/api/board").then((res) => {
      if (!res || res.status !== 200) throw new Error("not served");
      return res.json();
    }).then(() => {
      readOnly = false;
      document.body.classList.remove("ro");
      say("");
      // Once served, follow the record live: another writer's move (or this tab's own, echoed
      // back) re-renders in place, or reloads when the columns or filters themselves changed.
      connectLive({
        EventSource: window.EventSource,
        url: "/api/events",
        setTimeout: window.setTimeout.bind(window),
        clearTimeout: window.clearTimeout.bind(window),
        onBoard: (next) => {
          const updated = applyLiveBoard(board, next, config);
          if (updated) {
            board = updated;
            refreshCounts();
            applyFilter();
          }
        },
        onState: (state) => {
          if (state === "reconnecting") say("Lost the connection to doug board serve; reconnecting…");
          else if (state === "live") say("");
        },
      });
    }).catch(() => setReadOnly("Read-only copy: run `doug board serve` and open the URL it prints to move cards."));
  }
}
