// Pins the polling backstop in board-serve.ts's "fs" watch mode: fs.watch can silently drop a change
// under load, so a record change it never reports must still be pushed over /api/events. Its own
// file because a file-level vi.mock of node:fs would otherwise cover every test in board-page.test.ts;
// here the mock is a pass-through unless `dropWatch.on` is set.
import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBoard } from "../src/board.js";
import { startBoardServer } from "../src/board-serve.js";
import { localListenerDenied } from "./listen-probe.js";

const dropWatch = vi.hoisted(() => ({ on: false }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const { EventEmitter } = await import("node:events");
  return {
    ...actual,
    // When on, fs.watch yields a watcher that never reports anything: the dropped-event case.
    watch: ((...args: Parameters<typeof actual.watch>) => {
      if (!dropWatch.on) return actual.watch(...args);
      const w = new EventEmitter() as unknown as ReturnType<typeof actual.watch>;
      (w as unknown as { close: () => void }).close = () => {};
      return w;
    }) as typeof actual.watch,
  };
});

const listenDenied = await localListenerDenied();

async function run(argv: string[]) {
  return runBoard(argv, { stdout: () => {}, stderr: () => {} });
}

interface EventReader {
  reader: ReadableStreamDefaultReader<Uint8Array>;
  buffer: string;
}

async function readEvents(state: EventReader, count: number, timeoutMs: number): Promise<Array<{ event: string; data: string }>> {
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

describe.skipIf(listenDenied !== "")("board serve, watch fs: polling backstop", () => {
  it(
    "a board change fs.watch never reports is still pushed to a connected /api/events client, once",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "doug-board-backstop-"));
      expect(await run(["init", dir])).toBe(0);
      expect(await run(["add", "one", "--title", "First card", "--goal", "Do it", dir])).toBe(0);
      const record = join(dir, ".doug/board.json");
      dropWatch.on = true;
      const server = await startBoardServer(dir, { port: 0, watch: "fs" });
      try {
        const res = await fetch(server.url + "api/events");
        const state: EventReader = { reader: (res.body as ReadableStream<Uint8Array>).getReader(), buffer: "" };

        const first = await readEvents(state, 1, 10000);
        expect(first).toHaveLength(1);

        expect(await run(["move", "one", "done", dir])).toBe(0);

        const second = await readEvents(state, 1, 8000);
        expect(second).toHaveLength(1);
        const pushed = JSON.parse(second[0].data) as { cards: { id: string; column: string }[] };
        expect(pushed.cards.find((c) => c.id === "one")?.column).toBe("done");

        // A byte-identical rewrite touches the record again; the backstop must not resend the board.
        writeFileSync(record, readFileSync(record, "utf8"));
        const extra = await readEvents(state, 1, 1500);
        expect(extra).toHaveLength(0);
      } finally {
        dropWatch.on = false;
        await server.close();
      }
    },
    30000,
  );
});
