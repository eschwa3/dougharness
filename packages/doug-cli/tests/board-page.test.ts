import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { request as httpRequest } from "node:http";
import { runBoard } from "../src/board.js";
import { renderBoardPage } from "../src/board-page.js";
import { startBoardServer } from "../src/board-serve.js";
import { localListenerDenied } from "./listen-probe.js";

const PACKAGE_DIR = fileURLToPath(new URL("..", import.meta.url));

const listenDenied = await localListenerDenied();

function fresh(): string {
  return mkdtempSync(join(tmpdir(), "doug-board-page-"));
}

async function run(argv: string[]) {
  let stdout = "";
  let stderr = "";
  const code = await runBoard(argv, {
    stdout: (s) => void (stdout += s),
    stderr: (s) => void (stderr += s),
  });
  return { code, stdout, stderr };
}

function readBoard(dir: string, rel = ".doug/board.json") {
  return JSON.parse(readFileSync(join(dir, rel), "utf8"));
}

const COLUMNS = [
  { id: "decide", title: "Decide" },
  { id: "backlog", title: "Backlog" },
  { id: "ready", title: "Ready" },
  { id: "flow", title: "In flow" },
  { id: "done", title: "Done" },
];

function boardFile(cards: object[], components: string[] = []) {
  return JSON.stringify({ version: 1, updated: "2026-01-01", columns: COLUMNS, components, cards }, null, 2) + "\n";
}

// A board with two cards: one that carries a component, one that does not.
async function twoCardBoard(dir: string): Promise<void> {
  expect((await run(["init", dir])).code).toBe(0);
  const board = readBoard(dir);
  board.components = ["cli"];
  writeFileSync(join(dir, ".doug/board.json"), JSON.stringify(board, null, 2) + "\n");
  expect((await run(["add", "one", "--title", "First card", "--goal", "Do it", "--component", "cli", dir])).code).toBe(0);
  expect((await run(["add", "two", "--title", "Second card", "--goal", "Do that", dir])).code).toBe(0);
}

// The embedded record: the page escapes "<" so the JSON cannot close its own script tag.
function embeddedBoard(html: string) {
  const m = html.match(/<script type="application\/json" id="board-data">([\s\S]*?)<\/script>/);
  expect(m).not.toBeNull();
  return JSON.parse((m as RegExpMatchArray)[1].replace(/\\u003c/g, "<"));
}

function articleFor(html: string, id: string): string {
  const m = html.match(new RegExp(`<article[^>]*data-id="${id}"[\\s\\S]*?</article>`));
  expect(m).not.toBeNull();
  return (m as RegExpMatchArray)[0];
}

describe("doug board build", () => {
  it("prints a complete, read-only document for the record", async () => {
    const dir = fresh();
    await twoCardBoard(dir);
    const r = await run(["build", dir]);
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
    expect(r.stdout.startsWith("<!doctype html>")).toBe(true);
    expect(r.stdout.endsWith("</html>\n")).toBe(true);
    expect(embeddedBoard(r.stdout)).toEqual(readBoard(dir));
    expect(r.stdout).toContain('id="board-config">{"mode":"local","record":".doug/board.json"}');
    expect(r.stdout).toContain("First card");
    expect(r.stdout).toContain("Second card");
    expect(r.stdout).toContain("Read-only copy");
    expect(articleFor(r.stdout, "one")).toContain('class="chip"');
    expect(articleFor(r.stdout, "two")).not.toContain('class="chip"');
    expect(articleFor(r.stdout, "two")).not.toContain("data-component");
  });

  it("marks hand-track cards with a by-hand chip and lists Done newest first", async () => {
    const dir = fresh();
    mkdirSync(join(dir, ".doug"), { recursive: true });
    writeFileSync(
      join(dir, ".doug/board.json"),
      boardFile([
        { id: "h", column: "ready", title: "Hand card", track: "hand", deps: [], goal: "g" },
        { id: "d1", column: "done", title: "Older done", deps: [], goal: "g" },
        { id: "d2", column: "done", title: "Newer done", deps: [], goal: "g" },
      ]),
    );
    const r = await run(["build", dir]);
    expect(r.code).toBe(0);
    expect(articleFor(r.stdout, "h")).toContain('<span class="chip hand" title="hand track: a gated by-hand change">by hand</span>');
    expect(articleFor(r.stdout, "d1")).not.toContain("chip hand");
    const done = r.stdout.slice(r.stdout.indexOf('data-column="done">'));
    expect(done.indexOf('data-id="d2"')).toBeLessThan(done.indexOf('data-id="d1"'));
    expect(done).toContain("newest first");
    // Ready keeps record order: it is the priority order.
    expect(embeddedBoard(r.stdout).cards.map((c: { id: string }) => c.id)).toEqual(["h", "d1", "d2"]);
  });

  it("renders tag chips, data-tags, and the tag-filter select when cards carry tags", async () => {
    const dir = fresh();
    mkdirSync(join(dir, ".doug"), { recursive: true });
    writeFileSync(
      join(dir, ".doug/board.json"),
      boardFile([
        { id: "a", column: "ready", title: "A card", deps: [], goal: "g", tags: ["bug", "docs"] },
        { id: "b", column: "ready", title: "B card", deps: [], goal: "g", tags: ["bug"] },
        { id: "c", column: "ready", title: "C card", deps: [], goal: "g" },
      ]),
    );
    const r = await run(["build", dir]);
    expect(r.code).toBe(0);
    const a = articleFor(r.stdout, "a");
    expect(a).toContain('data-tags="bug docs"');
    expect(a).toContain('<span class="chip tag">bug</span>');
    expect(a).toContain('<span class="chip tag">docs</span>');
    const c = articleFor(r.stdout, "c");
    expect(c).not.toContain("data-tags");
    expect(c).not.toContain("chip tag");
    expect(r.stdout).toContain('<label for="tag-filter">tag</label><select id="tag-filter">');
    expect(r.stdout).toContain('<option value="">all</option>');
    expect(r.stdout).toContain('<option value="bug">bug</option>');
    expect(r.stdout).toContain('<option value="docs">docs</option>');
  });

  it("renders no tag-filter and no data-tags when no card carries a tag", async () => {
    const dir = fresh();
    await twoCardBoard(dir);
    const r = await run(["build", dir]);
    expect(r.code).toBe(0);
    const body = r.stdout.slice(0, r.stdout.indexOf('<script type="application/json" id="board-config">'));
    expect(body).not.toContain("tag-filter");
    expect(body).not.toContain("data-tags=");
    expect(articleFor(r.stdout, "one")).toBe(
      '<article class="card" draggable="true" tabindex="0" data-id="one" data-component="cli" data-column="backlog">\n' +
        '<div class="top"><span class="chip" style="color:var(--c-cli)">cli</span><span class="size"></span></div>\n' +
        '<div class="title">First card</div>\n' +
        '<div class="meta"><code>one</code></div>\n' +
        '\n' +
        '<details><summary>goal</summary><p class="goal">Do it</p></details>\n' +
        '<div class="move"><label class="meta" for="mv-one">move to</label><select id="mv-one" data-move="one"><option value="decide">Decide</option><option value="backlog" selected>Backlog</option><option value="ready">Ready</option><option value="flow">In flow</option><option value="done">Done</option></select></div>\n' +
        '</article>',
    );
  });

  it("names docs/board.json as the record when only it exists", async () => {
    const dir = fresh();
    mkdirSync(join(dir, "docs"), { recursive: true });
    writeFileSync(join(dir, "docs/board.json"), boardFile([{ id: "one", column: "ready", title: "First card", deps: [], goal: "g" }]));
    const r = await run(["build", dir]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('id="board-config">{"mode":"local","record":"docs/board.json"}');
    expect(existsSync(join(dir, ".doug/board.json"))).toBe(false);
  });

  it("T4 (card artifact-path-removal; card board-cli-unknown-flags): `--artifact` is an unknown flag for build and is rejected, writing nothing", async () => {
    const dir = fresh();
    await twoCardBoard(dir);
    const r = await run(["build", dir, "--artifact"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("--artifact");
    expect(r.stderr).toContain("doug board build");
    expect(r.stdout).toBe("");
  });

  it("T4 (card artifact-path-removal): the served/local page source never carries the artifact-publish script", async () => {
    const dir = fresh();
    await twoCardBoard(dir);
    const r = await run(["build", dir]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).not.toContain('claude.use("artifact")');
  });

  it("renders a class chip next to the size when a card carries one, and nothing when none does (card board-card-class C6)", async () => {
    const dir = fresh();
    mkdirSync(join(dir, ".doug"), { recursive: true });
    writeFileSync(
      join(dir, ".doug/board.json"),
      boardFile([
        { id: "a", column: "ready", title: "A card", deps: [], goal: "g", class: "code" },
        { id: "b", column: "ready", title: "B card", deps: [], goal: "g" },
      ]),
    );
    const r = await run(["build", dir]);
    expect(r.code).toBe(0);
    const a = articleFor(r.stdout, "a");
    // The chip carries title="class" so it can be told apart from a same-named tag chip.
    expect(a).toContain('<span class="chip class" title="class">code</span>');
    const b = articleFor(r.stdout, "b");
    expect(b).not.toContain("chip class");
  });

  it("fails when there is no board", async () => {
    const r = await run(["build", fresh()]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("no board at");
    expect(r.stdout).toBe("");
  });
});

// A raw PUT: fetch() will not hand back a response that arrives before the whole body is sent.
function putRaw(port: number, path: string, body: string): Promise<{ status: number; text: string }> {
  return new Promise((done, fail) => {
    let settled = false;
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path,
        method: "PUT",
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => void (text += chunk));
        res.on("error", () => {});
        res.on("end", () => {
          settled = true;
          done({ status: res.statusCode ?? 0, text });
        });
      },
    );
    // The server closes the socket once the 413 is out; an error after that is not the test's business.
    req.on("error", (err) => { if (!settled) fail(err); });
    req.write(body);
    req.end();
  });
}

// Reads Server-Sent Events off a fetch() body stream, decoding "event: X\ndata: Y\n\n" frames as
// they arrive, so a test can wait for the Nth board event without polling the record file itself.
interface EventReader {
  reader: ReadableStreamDefaultReader<Uint8Array>;
  buffer: string;
}

function eventReaderFor(res: Response): EventReader {
  return { reader: (res.body as ReadableStream<Uint8Array>).getReader(), buffer: "" };
}

// Reads the next `count` SSE frames off an already-open reader, decoding "event: X\ndata: Y\n\n" as
// they arrive, so a test can wait for the Nth board event without polling the record file itself.
// Never closes the reader: a caller reads from the same stream across several calls.
//
// The default window is generous (not the naive "SSE push is basically instant" ~1s) because under
// a full `pnpm test:unit` run this file's own tests run twice at once: once as vitest schedules it
// directly, and once inside board-page-skip.test.ts's nested vitest child. Dozens of concurrently
// running node/tsx processes across the whole suite can starve this process's event loop long enough
// that the very first SSE "board" push arrives well past a short window (reproduced live: "pushes the
// current board, then a move, over /api/events" failed with `first` empty, `expected [] to have a
// length of 1 but got +0`, under two concurrent full `pnpm test:unit` runs plus four extra parallel
// copies of this file). A caller that means to assert an event's absence still passes an explicit,
// short timeoutMs.
async function readEvents(state: EventReader, count: number, timeoutMs = 10000): Promise<Array<{ event: string; data: string }>> {
  const events: Array<{ event: string; data: string }> = [];
  const decoder = new TextDecoder();
  const deadline = Date.now() + timeoutMs;
  while (events.length < count) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const timedOut = Symbol("timeout");
    const result = await Promise.race([
      state.reader.read(),
      new Promise<typeof timedOut>((resolve) => setTimeout(() => resolve(timedOut), remaining)),
    ]);
    if (result === timedOut) break;
    const { value, done } = result as ReadableStreamReadResult<Uint8Array>;
    if (done) break;
    state.buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = state.buffer.indexOf("\n\n")) !== -1) {
      const frame = state.buffer.slice(0, idx);
      state.buffer = state.buffer.slice(idx + 2);
      const eventMatch = frame.match(/^event: (.*)$/m);
      const dataMatch = frame.match(/^data: (.*)$/m);
      if (eventMatch && dataMatch) events.push({ event: eventMatch[1], data: dataMatch[1] });
      if (events.length >= count) break;
    }
  }
  return events;
}

// Spawns the CLI the way the SIGINT test does, capturing stdout/stderr as they arrive so a test
// can wait on output without buffering it all up front.
function spawnCli(args: string[], env: NodeJS.ProcessEnv = process.env) {
  const child = spawn(process.execPath, ["--import", "tsx", "src/bin.ts", ...args], { cwd: PACKAGE_DIR, env });
  let out = "";
  let err = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (d: string) => void (out += d));
  child.stderr.on("data", (d: string) => void (err += d));
  const exited = new Promise<number | null>((done) => child.on("exit", (code) => done(code)));
  return {
    child,
    exited,
    stdout: () => out,
    stderr: () => err,
  };
}

// Polls a running child's captured stdout for a URL, failing fast if the child exits first.
function waitForUrlInOutput(get: () => string, exited: Promise<number | null>, label: string): Promise<string> {
  return new Promise<string>((done, fail) => {
    const timer = setInterval(() => {
      const m = get().match(/http:\/\/127\.0\.0\.1:\d+\//);
      if (m) {
        clearInterval(timer);
        done(m[0]);
      }
    }, 50);
    exited.then((code) => {
      clearInterval(timer);
      fail(new Error(`${label} exited with ${code} before printing a URL: ${get()}`));
    });
  });
}

async function waitForFile(file: string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(file)) return readFileSync(file, "utf8");
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for ${file}`);
}

describe.skipIf(listenDenied !== "")(`doug board serve${listenDenied ? ` (${listenDenied})` : ""}`, () => {
  it("serves the page and writes a move to the record", async () => {
    const dir = fresh();
    await twoCardBoard(dir);
    const server = await startBoardServer(dir, { port: 0 });
    try {
      expect(server.port).toBeGreaterThan(0);
      expect(server.url).toBe(`http://127.0.0.1:${server.port}/`);

      const page = await fetch(server.url);
      expect(page.status).toBe(200);
      expect(page.headers.get("content-type")).toContain("text/html");
      expect(await page.text()).toContain('id="board-data"');

      const api = await fetch(server.url + "api/board");
      expect(api.status).toBe(200);
      expect(await api.json()).toEqual(readBoard(dir));

      const moved = await fetch(server.url + "api/cards/one", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ column: "done" }),
      });
      expect(moved.status).toBe(200);
      const body = (await moved.json()) as { cards: { id: string; column: string }[]; updated: string };
      expect(body.cards.find((c) => c.id === "one")?.column).toBe("done");
      const saved = readBoard(dir);
      expect(saved.cards.find((c: { id: string }) => c.id === "one").column).toBe("done");
      expect(saved.updated).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(await (await fetch(server.url)).text()).toContain('data-id="one" data-component="cli" data-column="done"');

      const before = readFileSync(join(dir, ".doug/board.json"), "utf8");
      const badColumn = await fetch(server.url + "api/cards/one", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ column: "nowhere" }),
      });
      expect(badColumn.status).toBe(400);
      expect(((await badColumn.json()) as { error: string }).error).toContain('unknown column "nowhere"');
      expect(readFileSync(join(dir, ".doug/board.json"), "utf8")).toBe(before);

      const badBody = await fetch(server.url + "api/cards/one", { method: "PUT", body: "{" });
      expect(badBody.status).toBe(400);

      const missing = await fetch(server.url + "api/cards/missing", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ column: "done" }),
      });
      expect(missing.status).toBe(400);

      const notFound = await fetch(server.url + "nope");
      expect(notFound.status).toBe(404);
    } finally {
      await server.close();
    }
  });

  it("/api/board names the serving pid in x-doug-board-serve-pid on a 200 and on a 500", async () => {
    const dir = fresh();
    await twoCardBoard(dir);
    const server = await startBoardServer(dir, { port: 0 });
    try {
      const ok = await fetch(server.url + "api/board");
      expect(ok.status).toBe(200);
      expect(ok.headers.get("x-doug-board-serve-pid")).toBe(String(process.pid));

      writeFileSync(join(dir, ".doug/board.json"), "not json");
      const bad = await fetch(server.url + "api/board");
      expect(bad.status).toBe(500);
      expect(bad.headers.get("x-doug-board-serve-pid")).toBe(String(process.pid));
    } finally {
      await server.close();
    }
  });

  it("reorders a card within a column, and moves then places when the column also changes", async () => {
    const dir = fresh();
    await twoCardBoard(dir);
    const server = await startBoardServer(dir, { port: 0 });
    try {
      const reordered = await fetch(server.url + "api/cards/two", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ column: "backlog", before: "one" }),
      });
      expect(reordered.status).toBe(200);
      const reorderedBody = (await reordered.json()) as { cards: { id: string }[]; updated: string };
      expect(reorderedBody.cards.filter((c) => c.id === "one" || c.id === "two").map((c) => c.id)).toEqual(["two", "one"]);
      expect(reorderedBody.updated).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      const savedAfterReorder = readBoard(dir);
      expect(savedAfterReorder.cards.filter((c: { id: string }) => c.id === "one" || c.id === "two").map((c: { id: string }) => c.id)).toEqual(["two", "one"]);
      expect(savedAfterReorder.updated).toMatch(/^\d{4}-\d{2}-\d{2}$/);

      expect((await run(["add", "three", "--title", "Third card", "--goal", "Do the other", "--column", "ready", dir])).code).toBe(0);

      const movedAndPlaced = await fetch(server.url + "api/cards/one", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ column: "ready", before: "three" }),
      });
      expect(movedAndPlaced.status).toBe(200);
      const movedAndPlacedBody = (await movedAndPlaced.json()) as { cards: { id: string; column: string }[] };
      const readyIds = movedAndPlacedBody.cards.filter((c) => c.column === "ready").map((c) => c.id);
      expect(readyIds).toEqual(["one", "three"]);

      const before = readFileSync(join(dir, ".doug/board.json"), "utf8");

      const targetElsewhere = await fetch(server.url + "api/cards/two", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ column: "backlog", after: "three" }),
      });
      expect(targetElsewhere.status).toBe(400);
      expect(((await targetElsewhere.json()) as { error: string }).error).toContain("is in ready, not backlog");
      expect(readFileSync(join(dir, ".doug/board.json"), "utf8")).toBe(before);

      const both = await fetch(server.url + "api/cards/two", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ column: "backlog", before: "one", after: "one" }),
      });
      expect(both.status).toBe(400);
      expect(((await both.json()) as { error: string }).error).toBe('the request body may carry "before" or "after", not both');
      expect(readFileSync(join(dir, ".doug/board.json"), "utf8")).toBe(before);

      const emptyBefore = await fetch(server.url + "api/cards/two", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ column: "backlog", before: "" }),
      });
      expect(emptyBefore.status).toBe(400);
      expect(readFileSync(join(dir, ".doug/board.json"), "utf8")).toBe(before);
    } finally {
      await server.close();
    }
  });

  it("answers an oversize move body with 413 and leaves the record alone", async () => {
    const dir = fresh();
    await twoCardBoard(dir);
    const record = join(dir, ".doug/board.json");
    const before = readFileSync(record, "utf8");
    const server = await startBoardServer(dir, { port: 0 });
    try {
      const res = await putRaw(server.port, "/api/cards/one", "x".repeat(1024 * 1024 + 100));
      expect(res.status).toBe(413);
      expect((JSON.parse(res.text) as { error: string }).error).toContain("too large");
    } finally {
      await server.close();
    }
    expect(readFileSync(record, "utf8")).toBe(before);
  });

  it(
    "pushes the current board, then a move, over /api/events",
    async () => {
      const dir = fresh();
      await twoCardBoard(dir);
      const server = await startBoardServer(dir, { port: 0 });
      try {
        const res = await fetch(server.url + "api/events");
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toContain("text/event-stream");
        const state = eventReaderFor(res);

        const first = await readEvents(state, 1);
        expect(first).toHaveLength(1);
        expect(first[0].event).toBe("board");
        expect(JSON.parse(first[0].data)).toEqual(readBoard(dir));

        expect((await run(["move", "one", "done", dir])).code).toBe(0);

        const second = await readEvents(state, 1);
        expect(second).toHaveLength(1);
        const pushed = JSON.parse(second[0].data) as { cards: { id: string; column: string }[] };
        expect(pushed.cards.find((c) => c.id === "one")?.column).toBe("done");
      } finally {
        await server.close();
      }
    },
    // Two sequential readEvents() calls at readEvents' own default window; the vitest-global default
    // testTimeout (20000ms) is too tight to hold both under load (see readEvents' own comment).
    30000,
  );

  it(
    "pushes over /api/events under watch: poll too, and never repeats a board a client already has",
    async () => {
      const dir = fresh();
      await twoCardBoard(dir);
      const record = join(dir, ".doug/board.json");
      const server = await startBoardServer(dir, { port: 0, watch: "poll" });
      try {
        const res = await fetch(server.url + "api/events");
        const state = eventReaderFor(res);
        const first = await readEvents(state, 1);
        expect(first).toHaveLength(1);
        expect(JSON.parse(first[0].data)).toEqual(readBoard(dir));

        expect((await run(["move", "one", "done", dir])).code).toBe(0);

        const second = await readEvents(state, 1);
        expect(second).toHaveLength(1);
        expect((JSON.parse(second[0].data) as { cards: { id: string; column: string }[] }).cards.find((c) => c.id === "one")?.column).toBe("done");

        // Rewriting the record with byte-identical content still changes its mtime, so the poller
        // fires again; the client must not be sent the same board a second time in a row.
        const contents = readFileSync(record, "utf8");
        writeFileSync(record, contents);
        const extra = await readEvents(state, 1, 1200);
        expect(extra).toHaveLength(0);
      } finally {
        await server.close();
      }
    },
    // See the readEvents timeout note above the previous test.
    30000,
  );

  it(
    "a client connected after a write under watch: poll receives that board once, not again when the poll fires",
    async () => {
      const dir = fresh();
      await twoCardBoard(dir);
      const record = join(dir, ".doug/board.json");
      // Write before the server (and any client) even exists, so the very first thing a client sees
      // is the already-moved board.
      expect((await run(["move", "one", "done", dir])).code).toBe(0);
      const server = await startBoardServer(dir, { port: 0, watch: "poll" });
      try {
        const res = await fetch(server.url + "api/events");
        const state = eventReaderFor(res);
        const first = await readEvents(state, 1);
        expect(first).toHaveLength(1);
        const firstBoard = JSON.parse(first[0].data) as { cards: { id: string; column: string }[] };
        expect(firstBoard.cards.find((c) => c.id === "one")?.column).toBe("done");

        // The poll interval fires against byte-identical content; the initial event already counted
        // as sent, so the client must not be sent the same board again.
        const contents = readFileSync(record, "utf8");
        writeFileSync(record, contents);
        const extra = await readEvents(state, 1, 1200);
        expect(extra).toHaveLength(0);
      } finally {
        await server.close();
      }
    },
    // See the readEvents timeout note above the earlier events tests.
    30000,
  );

  it("ends the /api/events stream when the server closes", async () => {
    const dir = fresh();
    await twoCardBoard(dir);
    const server = await startBoardServer(dir, { port: 0 });
    const res = await fetch(server.url + "api/events");
    const state = eventReaderFor(res);
    await readEvents(state, 1);
    await server.close();
    const { done } = await state.reader.read();
    expect(done).toBe(true);
  });

  it("runs in the foreground until SIGINT", async () => {
    const dir = fresh();
    await twoCardBoard(dir);
    const child = spawn(process.execPath, ["--import", "tsx", "src/bin.ts", "board", "serve", dir, "--port", "0"], {
      cwd: PACKAGE_DIR,
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d: string) => void (stdout += d));
    child.stderr.on("data", (d: string) => void (stderr += d));
    const exited = new Promise<number | null>((done) => child.on("exit", (code) => done(code)));

    const url = await new Promise<string>((done, fail) => {
      const timer = setInterval(() => {
        const m = stdout.match(/http:\/\/127\.0\.0\.1:(\d+)\//);
        if (m) {
          clearInterval(timer);
          done(m[0]);
        }
      }, 50);
      exited.then((code) => {
        clearInterval(timer);
        fail(new Error(`doug board serve exited with ${code}: ${stderr || stdout}`));
      });
    });
    expect(stdout).toContain(`Serving .doug/board.json at ${url}`);

    const moved = await fetch(url + "api/cards/two", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ column: "ready" }),
    });
    expect(moved.status).toBe(200);
    expect(readBoard(dir).cards.find((c: { id: string }) => c.id === "two").column).toBe("ready");

    const printed = stdout;
    child.kill("SIGINT");
    expect(await exited).toBe(0);
    expect(stdout).toBe(printed);
  });

  it("reuses a live foreground server for a second serve, and replaces a pidfile naming a dead pid", async () => {
    const dir = fresh();
    await twoCardBoard(dir);
    const pidfile = join(dir, ".doug/.state/board-serve.json");
    const first = spawnCli(["board", "serve", dir, "--port", "0"]);
    let third: ReturnType<typeof spawnCli> | null = null;
    try {
      const firstUrl = await waitForUrlInOutput(first.stdout, first.exited, "first serve");
      expect(existsSync(pidfile)).toBe(true);

      const second = spawnSync(process.execPath, ["--import", "tsx", "src/bin.ts", "board", "serve", dir, "--port", "0"], {
        cwd: PACKAGE_DIR,
        env: process.env,
        encoding: "utf8",
      });
      expect(second.status).toBe(0);
      expect(second.stdout).toBe(`Already serving .doug/board.json at ${firstUrl}\n`);

      // Kill without letting it clean up its own pidfile, leaving a stale entry naming a dead pid.
      first.child.kill("SIGKILL");
      await first.exited;
      expect(existsSync(pidfile)).toBe(true);

      third = spawnCli(["board", "serve", dir, "--port", "0"]);
      const thirdUrl = await waitForUrlInOutput(third.stdout, third.exited, "third serve");
      expect(third.stdout()).toContain(`Serving .doug/board.json at ${thirdUrl}`);
      expect(third.stdout()).not.toContain("Already serving");
      const pidfileData = JSON.parse(readFileSync(pidfile, "utf8"));
      expect(pidfileData.pid).toBe(third.child.pid);
    } finally {
      if (!first.child.killed) first.child.kill("SIGKILL");
      if (third && !third.child.killed) {
        third.child.kill("SIGINT");
        await third.exited;
      }
    }
  });

  it("serves detached, is discoverable and stoppable, and a second stop reports none running", async () => {
    const dir = fresh();
    await twoCardBoard(dir);
    const pidfile = join(dir, ".doug/.state/board-serve.json");
    const detach = spawnSync(
      process.execPath,
      ["--import", "tsx", "src/bin.ts", "board", "serve", dir, "--detach", "--port", "0"],
      { cwd: PACKAGE_DIR, env: process.env, encoding: "utf8" },
    );
    try {
      expect(detach.status).toBe(0);
      const m = detach.stdout.match(
        /Serving \.doug\/board\.json at (http:\/\/127\.0\.0\.1:\d+\/) in the background \(pid (\d+)\); doug board serve --stop ends it\.\n/,
      );
      expect(m).not.toBeNull();
      const url = (m as RegExpMatchArray)[1];
      const pid = Number((m as RegExpMatchArray)[2]);
      expect((await fetch(url + "api/board")).status).toBe(200);
      const pidfileData = JSON.parse(readFileSync(pidfile, "utf8"));
      expect(pidfileData.pid).toBe(pid);
      expect(pidfileData.url).toBe(url);

      const stop = spawnSync(process.execPath, ["--import", "tsx", "src/bin.ts", "board", "serve", dir, "--stop"], {
        cwd: PACKAGE_DIR,
        env: process.env,
        encoding: "utf8",
      });
      expect(stop.status).toBe(0);
      expect(stop.stdout).toBe(`Stopped doug board serve (pid ${pid}) at ${url}.\n`);
      await expect(fetch(url + "api/board")).rejects.toThrow();
      expect(existsSync(pidfile)).toBe(false);

      const secondStop = spawnSync(process.execPath, ["--import", "tsx", "src/bin.ts", "board", "serve", dir, "--stop"], {
        cwd: PACKAGE_DIR,
        env: process.env,
        encoding: "utf8",
      });
      expect(secondStop.status).toBe(0);
      expect(secondStop.stdout).toBe(`No doug board serve is running for .doug/board.json.\n`);
    } finally {
      if (existsSync(pidfile)) {
        try {
          const data = JSON.parse(readFileSync(pidfile, "utf8"));
          process.kill(data.pid, "SIGKILL");
        } catch {
          // already gone
        }
      }
    }
  });

  it("--detach on a malformed board.json fails fast, spawning no child and leaving no pidfile (F3)", async () => {
    const dir = fresh();
    await twoCardBoard(dir);
    const pidfile = join(dir, ".doug/.state/board-serve.json");
    writeFileSync(join(dir, ".doug/board.json"), "not json");

    const detach = spawnSync(
      process.execPath,
      ["--import", "tsx", "src/bin.ts", "board", "serve", dir, "--detach", "--port", "0"],
      { cwd: PACKAGE_DIR, env: process.env, encoding: "utf8" },
    );
    expect(detach.status).toBe(1);
    expect(existsSync(pidfile)).toBe(false);

    // Give a wrongly-spawned child a moment to have bound a port, then confirm --stop finds
    // nothing (rather than only that the pidfile is absent, which a leaked, unreachable child
    // would also leave true).
    await new Promise((r) => setTimeout(r, 200));
    const stop = spawnSync(process.execPath, ["--import", "tsx", "src/bin.ts", "board", "serve", dir, "--stop"], {
      cwd: PACKAGE_DIR,
      env: process.env,
      encoding: "utf8",
    });
    expect(stop.status).toBe(0);
    expect(stop.stdout).toBe(`No doug board serve is running for .doug/board.json.\n`);
  });

  it("--stop leaves an unrelated live process alone when the pidfile's server does not answer, and reports none running", async () => {
    const dir = fresh();
    await twoCardBoard(dir);
    const pidfile = join(dir, ".doug/.state/board-serve.json");
    mkdirSync(join(dir, ".doug/.state"), { recursive: true });
    // A live process that is not a doug board serve, standing in for a reused pid: the pidfile
    // names it as alive, but nothing answers at its recorded URL.
    const other = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"]);
    try {
      await new Promise<void>((done) => other.once("spawn", () => done()));
      writeFileSync(
        pidfile,
        JSON.stringify({ pid: other.pid, port: 1, url: "http://127.0.0.1:1/", record: ".doug/board.json" }),
      );

      const stop = spawnSync(process.execPath, ["--import", "tsx", "src/bin.ts", "board", "serve", dir, "--stop"], {
        cwd: PACKAGE_DIR,
        env: process.env,
        encoding: "utf8",
      });
      expect(stop.status).toBe(0);
      expect(stop.stdout).toBe(`No doug board serve is running for .doug/board.json.\n`);
      expect(existsSync(pidfile)).toBe(false);
      expect(() => process.kill(other.pid as number, 0)).not.toThrow();
    } finally {
      other.kill("SIGKILL");
    }
  });

  it("--stop leaves an unrelated live pid alone when a foreign listener without the pid header answers at the pidfile's URL", async () => {
    const dir = fresh();
    await twoCardBoard(dir);
    const pidfile = join(dir, ".doug/.state/board-serve.json");
    mkdirSync(join(dir, ".doug/.state"), { recursive: true });
    const marker = join(dir, "sigterm-marker");
    // Stands in for a live process whose pid the pidfile names but which is not the server
    // answering at the pidfile's URL: it must never receive the SIGTERM --stop would send its
    // pid, proven by the marker file its own SIGTERM handler would write, not by kill(pid, 0)
    // (a signalled child can survive as a zombie under spawnSync and still look alive).
    const sleeper = spawn(process.execPath, [
      "-e",
      "process.on('SIGTERM', () => { require('fs').writeFileSync(process.env.MARKER, 'x'); }); setInterval(() => {}, 60000); process.stdout.write('ready');",
    ], { env: { ...process.env, MARKER: marker } });
    let sleeperOut = "";
    sleeper.stdout.setEncoding("utf8");
    sleeper.stdout.on("data", (d: string) => void (sleeperOut += d));
    // A foreign listener bound at the pidfile's URL, answering every request 200 but never naming
    // any pid in x-doug-board-serve-pid.
    const listener = spawn(process.execPath, [
      "-e",
      "require('http').createServer((_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); }).listen(0, '127.0.0.1', function () { process.stdout.write(String(this.address().port)); });",
    ]);
    let listenerPort = "";
    listener.stdout.setEncoding("utf8");
    listener.stdout.on("data", (d: string) => void (listenerPort += d));
    try {
      await new Promise<void>((done, fail) => {
        const timer = setInterval(() => {
          if (sleeperOut.includes("ready")) {
            clearInterval(timer);
            done();
          }
        }, 20);
        sleeper.once("exit", (code) => {
          clearInterval(timer);
          fail(new Error(`sleeper exited with ${code} before ready`));
        });
      });
      await new Promise<void>((done, fail) => {
        const timer = setInterval(() => {
          if (listenerPort) {
            clearInterval(timer);
            done();
          }
        }, 20);
        listener.once("exit", (code) => {
          clearInterval(timer);
          fail(new Error(`listener exited with ${code} before listening`));
        });
      });
      const listenerUrl = `http://127.0.0.1:${listenerPort}/`;
      writeFileSync(
        pidfile,
        JSON.stringify({ pid: sleeper.pid, port: Number(listenerPort), url: listenerUrl, record: ".doug/board.json" }),
      );

      const stop = spawnSync(process.execPath, ["--import", "tsx", "src/bin.ts", "board", "serve", dir, "--stop"], {
        cwd: PACKAGE_DIR,
        env: process.env,
        encoding: "utf8",
      });
      expect(stop.status).toBe(0);
      expect(stop.stdout).toBe(`No doug board serve is running for .doug/board.json.\n`);
      expect(existsSync(pidfile)).toBe(false);
      expect(existsSync(marker)).toBe(false);
      expect(() => process.kill(sleeper.pid as number, 0)).not.toThrow();
      const stillUp = await fetch(listenerUrl + "api/board");
      expect(stillUp.status).toBe(200);
    } finally {
      sleeper.kill("SIGKILL");
      listener.kill("SIGKILL");
    }
  });

  it("--stop leaves an unrelated live pid alone when the listener at the pidfile's URL names a different serving pid", async () => {
    const dir = fresh();
    await twoCardBoard(dir);
    const pidfile = join(dir, ".doug/.state/board-serve.json");
    mkdirSync(join(dir, ".doug/.state"), { recursive: true });
    const marker = join(dir, "sigterm-marker");
    const sleeper = spawn(process.execPath, [
      "-e",
      "process.on('SIGTERM', () => { require('fs').writeFileSync(process.env.MARKER, 'x'); }); setInterval(() => {}, 60000); process.stdout.write('ready');",
    ], { env: { ...process.env, MARKER: marker } });
    let sleeperOut = "";
    sleeper.stdout.setEncoding("utf8");
    sleeper.stdout.on("data", (d: string) => void (sleeperOut += d));
    // A foreign listener bound at the pidfile's URL that names its own pid (not the sleeper's) in
    // x-doug-board-serve-pid.
    const listener = spawn(process.execPath, [
      "-e",
      "require('http').createServer((_req, res) => { res.writeHead(200, { 'content-type': 'application/json', 'x-doug-board-serve-pid': String(process.pid) }); res.end('{}'); }).listen(0, '127.0.0.1', function () { process.stdout.write(String(this.address().port)); });",
    ]);
    let listenerPort = "";
    listener.stdout.setEncoding("utf8");
    listener.stdout.on("data", (d: string) => void (listenerPort += d));
    try {
      await new Promise<void>((done, fail) => {
        const timer = setInterval(() => {
          if (sleeperOut.includes("ready")) {
            clearInterval(timer);
            done();
          }
        }, 20);
        sleeper.once("exit", (code) => {
          clearInterval(timer);
          fail(new Error(`sleeper exited with ${code} before ready`));
        });
      });
      await new Promise<void>((done, fail) => {
        const timer = setInterval(() => {
          if (listenerPort) {
            clearInterval(timer);
            done();
          }
        }, 20);
        listener.once("exit", (code) => {
          clearInterval(timer);
          fail(new Error(`listener exited with ${code} before listening`));
        });
      });
      const listenerUrl = `http://127.0.0.1:${listenerPort}/`;
      writeFileSync(
        pidfile,
        JSON.stringify({ pid: sleeper.pid, port: Number(listenerPort), url: listenerUrl, record: ".doug/board.json" }),
      );

      const stop = spawnSync(process.execPath, ["--import", "tsx", "src/bin.ts", "board", "serve", dir, "--stop"], {
        cwd: PACKAGE_DIR,
        env: process.env,
        encoding: "utf8",
      });
      expect(stop.status).toBe(0);
      expect(stop.stdout).toBe(`No doug board serve is running for .doug/board.json.\n`);
      expect(existsSync(pidfile)).toBe(false);
      expect(existsSync(marker)).toBe(false);
      expect(() => process.kill(sleeper.pid as number, 0)).not.toThrow();
      const stillUp = await fetch(listenerUrl + "api/board");
      expect(stillUp.status).toBe(200);
    } finally {
      sleeper.kill("SIGKILL");
      listener.kill("SIGKILL");
    }
  });

  it("--stop finds and kills an orphaned detached server that answers but never with a 200 (the waitForDetached-timeout case)", async () => {
    const dir = fresh();
    await twoCardBoard(dir);
    const pidfile = join(dir, ".doug/.state/board-serve.json");
    mkdirSync(join(dir, ".doug/.state"), { recursive: true });
    // A real listener standing in for a detached `doug board serve` whose board record it cannot
    // load: it binds and answers every request, just never with a 200, so a waitForDetached wait
    // would time out on it and leave it running with the pidfile naming it (see F3).
    const orphan = spawn(process.execPath, [
      "-e",
      "require('http').createServer((_req, res) => { res.writeHead(500, { 'x-doug-board-serve-pid': String(process.pid) }); res.end('{}'); }).listen(0, '127.0.0.1', function () { process.stdout.write(String(this.address().port)); });",
    ]);
    let orphanPort = "";
    orphan.stdout.setEncoding("utf8");
    orphan.stdout.on("data", (d: string) => void (orphanPort += d));
    try {
      await new Promise<void>((done, fail) => {
        const timer = setInterval(() => {
          if (orphanPort) {
            clearInterval(timer);
            done();
          }
        }, 20);
        orphan.once("exit", (code) => {
          clearInterval(timer);
          fail(new Error(`orphan server exited with ${code} before listening`));
        });
      });
      const url = `http://127.0.0.1:${orphanPort}/`;
      expect((await fetch(url + "api/board")).status).toBe(500);
      writeFileSync(
        pidfile,
        JSON.stringify({ pid: orphan.pid, port: Number(orphanPort), url, record: ".doug/board.json" }),
      );

      // Run --stop with the CLI's own event loop free (not spawnSync) so this process can reap
      // the orphan's SIGTERM exit as it happens, rather than leaving it a zombie that would still
      // answer kill(pid, 0) as alive for the length of a blocking wait.
      const stop = spawnCli(["board", "serve", dir, "--stop"]);
      const stopCode = await stop.exited;
      expect(stopCode).toBe(0);
      expect(stop.stdout()).toBe(`Stopped doug board serve (pid ${orphan.pid}) at ${url}.\n`);
      expect(existsSync(pidfile)).toBe(false);
      await new Promise((r) => setTimeout(r, 50));
      expect(() => process.kill(orphan.pid as number, 0)).toThrow();
    } finally {
      if (!orphan.killed) orphan.kill("SIGKILL");
    }
  });

  it("opens the browser named by BROWSER once a detached server is ready", async () => {
    const dir = fresh();
    await twoCardBoard(dir);
    const pidfile = join(dir, ".doug/.state/board-serve.json");
    const outFile = join(dir, "browser-out.txt");
    const scriptFile = join(dir, "browser-stub.sh");
    writeFileSync(scriptFile, `#!/bin/sh\necho "$1" > ${JSON.stringify(outFile)}\n`);
    chmodSync(scriptFile, 0o755);
    const detach = spawnSync(
      process.execPath,
      ["--import", "tsx", "src/bin.ts", "board", "serve", dir, "--detach", "--open", "--port", "0"],
      { cwd: PACKAGE_DIR, env: { ...process.env, BROWSER: scriptFile }, encoding: "utf8" },
    );
    try {
      expect(detach.status).toBe(0);
      const m = detach.stdout.match(/at (http:\/\/127\.0\.0\.1:\d+\/) in the background/);
      expect(m).not.toBeNull();
      const url = (m as RegExpMatchArray)[1];
      const written = await waitForFile(outFile, 2000);
      expect(written.trim()).toBe(url);
    } finally {
      if (existsSync(pidfile)) {
        try {
          const data = JSON.parse(readFileSync(pidfile, "utf8"));
          process.kill(data.pid, "SIGKILL");
        } catch {
          // already gone
        }
      }
    }
  });

  it("reports a browser that fails to open, on --detach --open and on reuse with --open", async () => {
    const dir = fresh();
    await twoCardBoard(dir);
    const pidfile = join(dir, ".doug/.state/board-serve.json");
    const badBrowser = join(dir, "no-such-browser");
    const env = { ...process.env, BROWSER: badBrowser };
    const detach = spawnSync(
      process.execPath,
      ["--import", "tsx", "src/bin.ts", "board", "serve", dir, "--detach", "--open", "--port", "0"],
      { cwd: PACKAGE_DIR, env, encoding: "utf8" },
    );
    try {
      expect(detach.status).toBe(0);
      expect(detach.stderr).toContain("Could not open a browser; open ");
      expect(detach.stderr).toContain(" yourself.\n");

      const reuse = spawnSync(
        process.execPath,
        ["--import", "tsx", "src/bin.ts", "board", "serve", dir, "--open", "--port", "0"],
        { cwd: PACKAGE_DIR, env, encoding: "utf8" },
      );
      expect(reuse.status).toBe(0);
      expect(reuse.stdout).toContain("Already serving .doug/board.json at ");
      expect(reuse.stderr).toContain("Could not open a browser; open ");
      expect(reuse.stderr).toContain(" yourself.\n");
    } finally {
      if (existsSync(pidfile)) {
        try {
          const data = JSON.parse(readFileSync(pidfile, "utf8"));
          process.kill(data.pid, "SIGKILL");
        } catch {
          // already gone
        }
      }
    }
  });
});

// The page's own connectLive/applyLiveBoard, extracted from the template the same way board-template.test.ts
// extracts dropPlacement: no listener needed, no real EventSource or DOM.
const templateSource = readFileSync(new URL("../templates/board-app.js", import.meta.url), "utf8");
const { connectLive, applyLiveBoard, app } = new Function(
  templateSource + "\nreturn { connectLive, applyLiveBoard, app };",
)() as {
  connectLive: (opts: {
    EventSource: new (url: string) => FakeEventSource;
    url: string;
    setTimeout?: (fn: () => void, ms: number) => number;
    clearTimeout?: (id: number) => void;
    retryMs?: number;
    onBoard: (board: unknown) => void;
    onState: (state: "live" | "reconnecting") => void;
  }) => { close(): void };
  app: () => void;
  applyLiveBoard: (
    board: { columns: Array<{ id: string; title: string; hint?: string }>; components: string[]; cards: Array<{ id: string; tags?: string[] }> },
    next: unknown,
    config: { record: string },
    opts?: { document?: unknown; location?: { reload(): void } },
  ) => unknown;
};

// A minimal fake EventSource: a plain event target good enough for connectLive's addEventListener
// usage, with a constructor that records its url and a close() that marks it closed.
class FakeEventSource {
  url: string;
  closed = false;
  listeners: Record<string, Array<(e: unknown) => void>> = {};
  constructor(url: string) {
    this.url = url;
  }
  addEventListener(type: string, fn: (e: unknown) => void): void {
    (this.listeners[type] ||= []).push(fn);
  }
  fire(type: string, event: unknown = {}): void {
    for (const fn of this.listeners[type] || []) fn(event);
  }
  close(): void {
    this.closed = true;
  }
}

describe("connectLive", () => {
  function fakeTimers() {
    const pending: Array<{ fn: () => void; ms: number }> = [];
    const setTimeout = (fn: () => void, ms: number): number => {
      pending.push({ fn, ms });
      return pending.length;
    };
    const fire = () => {
      const next = pending.shift();
      if (next) next.fn();
    };
    return { setTimeout, fire, pending };
  }

  it("reconnects after an error, going live again on the new source's open", () => {
    const instances: FakeEventSource[] = [];
    class Recording extends FakeEventSource {
      constructor(url: string) {
        super(url);
        instances.push(this);
      }
    }
    const states: string[] = [];
    const { setTimeout, fire } = fakeTimers();
    const conn = connectLive({
      EventSource: Recording,
      url: "/api/events",
      setTimeout,
      onBoard: () => {},
      onState: (s) => states.push(s),
    });
    expect(instances).toHaveLength(1);
    instances[0].fire("error");
    expect(states).toEqual(["reconnecting"]);
    expect(instances[0].closed).toBe(true);
    expect(instances).toHaveLength(1);
    fire();
    expect(instances).toHaveLength(2);
    expect(instances[1].url).toBe("/api/events");
    instances[1].fire("open");
    expect(states).toEqual(["reconnecting", "live"]);
    conn.close();
  });

  it("calls onBoard with the parsed data of a board event", () => {
    const instances: FakeEventSource[] = [];
    class Recording extends FakeEventSource {
      constructor(url: string) {
        super(url);
        instances.push(this);
      }
    }
    const boards: unknown[] = [];
    const conn = connectLive({
      EventSource: Recording,
      url: "/api/events",
      setTimeout: () => 0,
      onBoard: (b) => boards.push(b),
      onState: () => {},
    });
    instances[0].fire("board", { data: JSON.stringify({ ok: true }) });
    expect(boards).toEqual([{ ok: true }]);
    conn.close();
  });

  it("close() cancels a pending retry, so the fired timer opens no new source", () => {
    const instances: FakeEventSource[] = [];
    class Recording extends FakeEventSource {
      constructor(url: string) {
        super(url);
        instances.push(this);
      }
    }
    const { setTimeout, fire } = fakeTimers();
    const conn = connectLive({
      EventSource: Recording,
      url: "/api/events",
      setTimeout,
      onBoard: () => {},
      onState: () => {},
    });
    instances[0].fire("error");
    conn.close();
    fire();
    expect(instances).toHaveLength(1);
  });

  it("ignores a late error, open, or board event from a source that has been replaced", () => {
    const instances: FakeEventSource[] = [];
    class Recording extends FakeEventSource {
      constructor(url: string) {
        super(url);
        instances.push(this);
      }
    }
    const states: string[] = [];
    const boards: unknown[] = [];
    const { setTimeout, fire } = fakeTimers();
    connectLive({
      EventSource: Recording,
      url: "/api/events",
      setTimeout,
      onBoard: (b) => boards.push(b),
      onState: (s) => states.push(s),
    });
    const stale = instances[0];
    stale.fire("error");
    fire();
    expect(instances).toHaveLength(2);
    // The replaced (first) source firing late changes nothing.
    stale.fire("error");
    stale.fire("open");
    stale.fire("board", { data: JSON.stringify({ stale: true }) });
    expect(states).toEqual(["reconnecting"]);
    expect(boards).toEqual([]);
  });
});

describe("applyLiveBoard", () => {
  it("reloads instead of patching when a column's title, hint, or order changed", () => {
    const board = { columns: COLUMNS.map((c) => ({ ...c })), components: [], cards: [] };
    const cases: Array<(cols: typeof COLUMNS) => typeof COLUMNS> = [
      (cols) => cols.map((c, i) => (i === 0 ? { ...c, title: "Renamed" } : c)),
      (cols) => cols.map((c, i) => (i === 0 ? { ...c, hint: "new hint" } : c)),
      (cols) => [cols[1], cols[0], ...cols.slice(2)],
    ];
    for (const mutate of cases) {
      const next = { ...board, columns: mutate(COLUMNS) };
      let reloaded = false;
      const result = applyLiveBoard(board, next, { record: ".doug/board.json" }, { location: { reload: () => void (reloaded = true) } });
      expect(reloaded).toBe(true);
      expect(result).toBeNull();
    }
  });

  it("reloads when the component or tag set changed", () => {
    const board = { columns: COLUMNS, components: ["cli"], cards: [{ id: "a", tags: ["bug"] }] };
    const next = { ...board, components: ["cli", "flow"] };
    let reloaded = false;
    const result = applyLiveBoard(board, next, { record: ".doug/board.json" }, { location: { reload: () => void (reloaded = true) } });
    expect(reloaded).toBe(true);
    expect(result).toBeNull();
  });

  it("patches in place, without reloading, when only card content changed", () => {
    const board = { columns: COLUMNS, components: ["cli"], cards: [{ id: "a", column: "ready", tags: ["bug"], title: "A" }] };
    const next = { ...board, cards: [{ id: "a", column: "done", tags: ["bug"], title: "A moved" }] };
    let reloaded = false;
    const containers: Record<string, { innerHTML: string }> = {};
    const fakeDoc = {
      querySelector(sel: string) {
        const m = sel.match(/data-column="([^"]+)"/);
        if (m) return (containers[m[1]] ||= { innerHTML: "" });
        if (sel === "header .sub") return { innerHTML: "" };
        return null;
      },
    };
    const result = applyLiveBoard(board, next, { record: ".doug/board.json" }, {
      location: { reload: () => void (reloaded = true) },
      document: fakeDoc,
    });
    expect(reloaded).toBe(false);
    expect(result).toEqual(next);
    expect(containers.done.innerHTML).toContain("A moved");
  });
});

// A small, real DOM built by parsing renderBoardPage()'s own output, good enough for the exact
// selectors board-app.js uses (#id, .class, [data-x="y"], :not([hidden]), a single descendant
// space, and comma lists). Unlike a hand-rolled querySelector that matches any selector containing
// a substring, this only matches what the real markup's tags, classes and attributes say, so app()
// can run against it end to end.
interface DomNode {
  tag: string;
  attrs: Record<string, string>;
  children: DomNode[];
  parent: DomNode | null;
  raw: string;
  html: string;
  contentStart: number;
}

const VOID_TAGS = new Set(["link", "meta", "br", "img", "input", "hr"]);
const RAW_TAGS = new Set(["script", "style"]);

function parseAttrs(s: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*("([^"]*)"|'([^']*)'|[^\s"'=<>`]+))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    const name = m[1].toLowerCase();
    attrs[name] = m[3] !== undefined ? m[3] : m[4] !== undefined ? m[4] : m[2] !== undefined ? m[2] : "";
  }
  return attrs;
}

function parseDom(html: string): DomNode {
  const root: DomNode = { tag: "#root", attrs: {}, children: [], parent: null, raw: "", html: "", contentStart: 0 };
  const stack: DomNode[] = [root];
  let i = 0;
  const n = html.length;
  while (i < n) {
    const lt = html.indexOf("<", i);
    if (lt === -1) break;
    if (html[lt + 1] === "!") {
      i = html.indexOf(">", lt) + 1;
      continue;
    }
    if (html[lt + 1] === "/") {
      const gt = html.indexOf(">", lt);
      const name = html.slice(lt + 2, gt).trim().toLowerCase();
      for (let s = stack.length - 1; s > 0; s--) {
        if (stack[s].tag === name) {
          stack[s].html = html.slice(stack[s].contentStart, lt);
          stack.length = s;
          break;
        }
      }
      i = gt + 1;
      continue;
    }
    const gt = html.indexOf(">", lt);
    let tagContent = html.slice(lt + 1, gt);
    let selfClose = false;
    if (tagContent.endsWith("/")) {
      selfClose = true;
      tagContent = tagContent.slice(0, -1);
    }
    const spaceIdx = tagContent.search(/\s/);
    const tagName = (spaceIdx === -1 ? tagContent : tagContent.slice(0, spaceIdx)).toLowerCase();
    const attrsStr = spaceIdx === -1 ? "" : tagContent.slice(spaceIdx);
    const node: DomNode = { tag: tagName, attrs: parseAttrs(attrsStr), children: [], parent: stack[stack.length - 1], raw: "", html: "", contentStart: 0 };
    stack[stack.length - 1].children.push(node);
    i = gt + 1;
    if (RAW_TAGS.has(tagName) && !selfClose) {
      const closeTag = "</" + tagName;
      const closeIdx = html.indexOf(closeTag, i);
      const end = closeIdx === -1 ? n : closeIdx;
      node.raw = html.slice(i, end);
      node.html = node.raw;
      i = closeIdx === -1 ? n : html.indexOf(">", closeIdx) + 1;
    } else if (!VOID_TAGS.has(tagName) && !selfClose) {
      node.contentStart = i;
      stack.push(node);
    }
  }
  return root;
}

function classesOf(node: DomNode): string[] {
  return (node.attrs.class || "").split(/\s+/).filter(Boolean);
}

interface Compound {
  tag: string | null;
  id: string | null;
  classes: string[];
  attrs: Array<{ name: string; value: string | null }>;
  nots: Compound[];
}

function parseCompound(str: string): Compound {
  let s = str;
  const c: Compound = { tag: null, id: null, classes: [], attrs: [], nots: [] };
  const tagMatch = s.match(/^[A-Za-z][\w-]*/);
  if (tagMatch) {
    c.tag = tagMatch[0].toLowerCase();
    s = s.slice(tagMatch[0].length);
  }
  const re = /(:not\(([^)]*)\))|(#[-\w]+)|(\.[-\w]+)|(\[[^\]]*\])/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    if (m[1]) c.nots.push(parseCompound(m[2]));
    else if (m[3]) c.id = m[3].slice(1);
    else if (m[4]) c.classes.push(m[4].slice(1));
    else if (m[5]) {
      const inner = m[5].slice(1, -1);
      const eq = inner.match(/^([-\w]+)=("([^"]*)"|'([^']*)')$/);
      if (eq) c.attrs.push({ name: eq[1], value: eq[3] !== undefined ? eq[3] : (eq[4] as string) });
      else c.attrs.push({ name: inner, value: null });
    }
  }
  return c;
}

function matchesCompound(node: DomNode, c: Compound): boolean {
  if (c.tag && node.tag !== c.tag) return false;
  if (c.id && node.attrs.id !== c.id) return false;
  const classes = classesOf(node);
  for (const cls of c.classes) if (!classes.includes(cls)) return false;
  for (const a of c.attrs) {
    if (a.value === null) {
      if (!(a.name in node.attrs)) return false;
    } else if (node.attrs[a.name] !== a.value) return false;
  }
  for (const not of c.nots) if (matchesCompound(node, not)) return false;
  return true;
}

function matchesSelectorList(node: DomNode, selector: string): boolean {
  return selector.split(",").some((part) => matchesCompound(node, parseCompound(part.trim())));
}

function descendants(node: DomNode): DomNode[] {
  const out: DomNode[] = [];
  for (const c of node.children) {
    out.push(c);
    out.push(...descendants(c));
  }
  return out;
}

function queryAll(root: DomNode, selector: string): DomNode[] {
  const results: DomNode[] = [];
  for (const part of selector.split(",")) {
    const compounds = part.trim().split(/\s+/).map(parseCompound);
    let candidates: DomNode[];
    if (compounds.length === 1) {
      candidates = descendants(root).filter((n) => matchesCompound(n, compounds[0]));
    } else {
      let sets: DomNode[] = descendants(root).filter((n) => matchesCompound(n, compounds[0]));
      for (let k = 1; k < compounds.length; k++) {
        const next: DomNode[] = [];
        for (const anc of sets) {
          for (const d of descendants(anc)) {
            if (matchesCompound(d, compounds[k]) && !next.includes(d)) next.push(d);
          }
        }
        sets = next;
      }
      candidates = sets;
    }
    for (const n of candidates) if (!results.includes(n)) results.push(n);
  }
  return results;
}

// A live element view over a DomNode: mutations (classList, hidden, textContent, innerHTML) write
// straight through to the node, so state set by one query is visible to the next.
function wrapNode(node: DomNode): any {
  return {
    tagName: node.tag.toUpperCase(),
    get id() {
      return node.attrs.id || "";
    },
    get className() {
      return node.attrs.class || "";
    },
    set className(v: string) {
      node.attrs.class = v;
    },
    classList: {
      add: (...cls: string[]) => {
        const set = new Set(classesOf(node));
        for (const c of cls) set.add(c);
        node.attrs.class = Array.from(set).join(" ");
      },
      remove: (...cls: string[]) => {
        const set = new Set(classesOf(node));
        for (const c of cls) set.delete(c);
        node.attrs.class = Array.from(set).join(" ");
      },
      contains: (c: string) => classesOf(node).includes(c),
    },
    get dataset() {
      const ds: Record<string, string> = {};
      for (const k of Object.keys(node.attrs)) {
        if (k.startsWith("data-")) {
          const camel = k.slice(5).replace(/-([a-z])/g, (_: string, c: string) => c.toUpperCase());
          ds[camel] = node.attrs[k];
        }
      }
      return ds;
    },
    getAttribute: (name: string) => (name in node.attrs ? node.attrs[name] : null),
    setAttribute: (name: string, v: string) => {
      node.attrs[name] = String(v);
    },
    hasAttribute: (name: string) => name in node.attrs,
    get hidden() {
      return "hidden" in node.attrs;
    },
    set hidden(v: boolean) {
      if (v) node.attrs.hidden = "";
      else delete node.attrs.hidden;
    },
    get textContent() {
      return node.raw !== "" ? node.raw : node.html;
    },
    set textContent(v: unknown) {
      const s = String(v);
      node.raw = s;
      node.html = s;
      node.children = [];
    },
    get innerHTML() {
      return node.html;
    },
    set innerHTML(v: string) {
      node.html = v;
      node.children = [];
    },
    get value() {
      return node.attrs.value || "";
    },
    set value(v: string) {
      node.attrs.value = v;
    },
    addEventListener: () => {},
    querySelector: (sel: string) => {
      const r = queryAll(node, sel);
      return r[0] ? wrapNode(r[0]) : null;
    },
    querySelectorAll: (sel: string) => queryAll(node, sel).map(wrapNode),
    closest: (sel: string) => {
      let n: DomNode | null = node;
      while (n) {
        if (n !== node.parent && matchesSelectorList(n, sel)) return wrapNode(n);
        n = n.parent;
      }
      return null;
    },
  };
}

function buildDocument(html: string): any {
  const root = parseDom(html);
  return {
    getElementById: (id: string) => {
      const found = descendants(root).find((n) => n.attrs.id === id);
      return found ? wrapNode(found) : null;
    },
    querySelector: (sel: string) => {
      const r = queryAll(root, sel);
      return r[0] ? wrapNode(r[0]) : null;
    },
    querySelectorAll: (sel: string) => queryAll(root, sel).map(wrapNode),
    addEventListener: () => {},
    get body() {
      const b = descendants(root).find((n) => n.tag === "body");
      return wrapNode(b || root);
    },
  };
}

// Runs the real app() (extracted from the template above) against a document parsed from the real
// renderBoardPage() output, so the connectLive wiring and the live-update wiring are both exercised
// exactly as a browser would exercise them, not through a hand-rolled fake.
describe("app() against real renderBoardPage() markup", () => {
  async function setUp() {
    const dir = fresh();
    await twoCardBoard(dir);
    const board = readBoard(dir);
    const html = renderBoardPage(board, { mode: "local", record: ".doug/board.json" });
    const doc = buildDocument(html);
    const instances: FakeEventSource[] = [];
    class Recording extends FakeEventSource {
      constructor(url: string) {
        super(url);
        instances.push(this);
      }
    }
    const pending: Array<() => void> = [];
    const fakeSetTimeout = (fn: () => void): number => {
      pending.push(fn);
      return pending.length;
    };
    let reloaded = false;
    const saved = {
      document: (globalThis as any).document,
      window: (globalThis as any).window,
      fetch: (globalThis as any).fetch,
      location: (globalThis as any).location,
    };
    (globalThis as any).document = doc;
    (globalThis as any).window = { EventSource: Recording, setTimeout: fakeSetTimeout, clearTimeout: () => {} };
    (globalThis as any).fetch = async (url: string) => {
      if (url === "/api/board") return { status: 200, json: async () => board };
      throw new Error("unexpected fetch " + url);
    };
    (globalThis as any).location = { reload: () => void (reloaded = true) };
    const restore = () => {
      (globalThis as any).document = saved.document;
      (globalThis as any).window = saved.window;
      (globalThis as any).fetch = saved.fetch;
      (globalThis as any).location = saved.location;
    };
    app();
    // Flush the fetch("/api/board").then().then() chain (pure promises: one macrotask tick drains
    // every pending microtask first).
    await new Promise((r) => setTimeout(r, 0));
    return { dir, board, instances, pending, restore, reloaded: () => reloaded };
  }

  it("reconnects after a dropped connection instead of throwing (regression for the missing setTimeout)", async () => {
    const { instances, pending, restore } = await setUp();
    try {
      expect(instances).toHaveLength(1);
      expect(() => instances[0].fire("error")).not.toThrow();
      expect(pending).toHaveLength(1);
      pending[0]();
      expect(instances).toHaveLength(2);
    } finally {
      restore();
    }
  });

  it("reloads the page when a live board's column order changed", async () => {
    const { instances, board, restore, reloaded } = await setUp();
    try {
      const next = { ...board, columns: [board.columns[1], board.columns[0], ...board.columns.slice(2)] };
      instances[0].fire("board", { data: JSON.stringify(next) });
      expect(reloaded()).toBe(true);
    } finally {
      restore();
    }
  });
});
