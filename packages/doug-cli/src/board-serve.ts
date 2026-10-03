// `doug board serve`: the board page over loopback, so a drag can write the record. It is a plain
// node:http server on 127.0.0.1 with three routes; a move or a reorder goes through the same
// moveCard/reorderCard/saveBoard calls the CLI uses, so it is validated the same way. It logs
// nothing and reports nothing anywhere.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { watch as fsWatch, watchFile, unwatchFile, type FSWatcher } from "node:fs";
import { basename, dirname } from "node:path";
import { boardPath, findCard, loadBoard, moveCard, reorderCard, saveBoard } from "@dougharness/flow/lib/board.mjs";
import { buildBoardPage } from "./board-page.js";

const HOST = "127.0.0.1";
const CARDS_PREFIX = "/api/cards/";
const MAX_BODY = 1024 * 1024;
const DEBOUNCE_MS = 100;
const POLL_INTERVAL_MS = 500;

export interface BoardServer {
  port: number;
  url: string;
  close(): Promise<void>;
}

interface EventClient {
  res: ServerResponse;
  lastSent: string | null;
}

// Watches the directory of the board record (it is replaced by rename, so a file-inode watch would
// miss the change) and calls onChange, debounced, whenever the record's own basename is touched.
// Also polls the record file alongside fs.watch, because fs.watch can drop a change under load; a
// repeated trigger is harmless since onRecordChange skips a board the client already has. When
// fs.watch is unavailable or errors, the poll carries on alone.
function watchRecord(dir: string, mode: "fs" | "poll", onChange: () => void): { stop(): void } {
  const record = boardPath(dir);
  const recordDir = dirname(record);
  const recordName = basename(record);
  let debounce: ReturnType<typeof setTimeout> | null = null;
  const trigger = (): void => {
    if (debounce) return;
    debounce = setTimeout(() => {
      debounce = null;
      onChange();
    }, DEBOUNCE_MS);
  };

  let watcher: FSWatcher | null = null;
  let polling = false;

  const startBackstop = (): void => {
    if (polling) return;
    polling = true;
    watchFile(record, { interval: POLL_INTERVAL_MS }, () => trigger());
  };

  const startPolling = (): void => {
    startBackstop();
    if (watcher) {
      try {
        watcher.close();
      } catch {
        // already gone
      }
      watcher = null;
    }
  };

  if (mode === "poll") {
    startPolling();
  } else {
    try {
      watcher = fsWatch(recordDir, (_event, filename) => {
        if (filename && filename !== recordName) return;
        trigger();
      });
      watcher.on("error", startPolling);
      startBackstop();
    } catch {
      startPolling();
    }
  }

  return {
    stop: () => {
      if (debounce) clearTimeout(debounce);
      if (watcher) {
        try {
          watcher.close();
        } catch {
          // already gone
        }
      }
      if (polling) unwatchFile(record);
    },
  };
}

function send(
  res: ServerResponse,
  status: number,
  type: string,
  body: string,
  headers: Record<string, string> = {},
): void {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store", ...headers });
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  send(res, status, "application/json; charset=utf-8", JSON.stringify(value));
}

function sendError(
  res: ServerResponse,
  status: number,
  message: string,
  headers: Record<string, string> = {},
): void {
  send(res, status, "application/json; charset=utf-8", JSON.stringify({ error: message }), headers);
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

class BodyTooLarge extends Error {}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    req.on("data", (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > MAX_BODY) {
        // Do not destroy the request here: the caller still has to answer 413, and a destroyed
        // socket would leave the client with a connection reset instead of the status.
        settled = true;
        reject(new BodyTooLarge("the request body is too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}

// Answer an oversize body, then swallow the rest of it so the client can read the response before
// the socket goes away.
function sendTooLarge(req: IncomingMessage, res: ServerResponse, message: string): void {
  res.on("finish", () => {
    if (!req.socket.destroyed) req.socket.destroy();
  });
  sendError(res, 413, message, { connection: "close" });
  req.resume();
}

async function handlePut(dir: string, id: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: string;
  try {
    body = await readBody(req);
  } catch (err) {
    if (err instanceof BodyTooLarge) sendTooLarge(req, res, err.message);
    else sendError(res, 400, messageOf(err));
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    sendError(res, 400, "the request body is not JSON");
    return;
  }
  const record = parsed as { column?: unknown; before?: unknown; after?: unknown } | null;
  const column = record?.column;
  if (typeof column !== "string" || column === "") {
    sendError(res, 400, 'the request body needs a "column" string');
    return;
  }
  const before = record?.before;
  const after = record?.after;
  if (before !== undefined && (typeof before !== "string" || before === "")) {
    sendError(res, 400, 'the request body\'s "before" must be a non-empty string');
    return;
  }
  if (after !== undefined && (typeof after !== "string" || after === "")) {
    sendError(res, 400, 'the request body\'s "after" must be a non-empty string');
    return;
  }
  if (before !== undefined && after !== undefined) {
    sendError(res, 400, 'the request body may carry "before" or "after", not both');
    return;
  }
  try {
    const board = loadBoard(dir);
    const card = findCard(board, id);
    let next = card.column === column ? board : moveCard(board, id, column);
    if (before !== undefined) next = reorderCard(next, id, { before: before as string });
    else if (after !== undefined) next = reorderCard(next, id, { after: after as string });
    saveBoard(dir, next);
    sendJson(res, 200, next);
  } catch (err) {
    sendError(res, 400, messageOf(err));
  }
}

function handleEvents(dir: string, clients: Set<EventClient>, req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-store",
    connection: "keep-alive",
  });
  const client: EventClient = { res, lastSent: null };
  try {
    const serialized = JSON.stringify(loadBoard(dir));
    client.lastSent = serialized;
    res.write(`event: board\ndata: ${serialized}\n\n`);
  } catch {
    // A record that fails to load sends nothing; the client still gets later changes.
  }
  clients.add(client);
  req.on("close", () => {
    clients.delete(client);
  });
}

async function handle(dir: string, clients: Set<EventClient>, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const path = new URL(req.url || "/", `http://${HOST}`).pathname;
  if (req.method === "GET" && path === "/api/events") {
    handleEvents(dir, clients, req, res);
    return;
  }
  if (req.method === "GET" && path === "/") {
    try {
      send(res, 200, "text/html; charset=utf-8", buildBoardPage(dir).html);
    } catch (err) {
      send(res, 500, "text/plain; charset=utf-8", messageOf(err) + "\n");
    }
    return;
  }
  if (req.method === "GET" && path === "/api/board") {
    try {
      sendJson(res, 200, loadBoard(dir));
    } catch (err) {
      sendError(res, 500, messageOf(err));
    }
    return;
  }
  if (req.method === "PUT" && path.startsWith(CARDS_PREFIX)) {
    let id: string;
    try {
      id = decodeURIComponent(path.slice(CARDS_PREFIX.length));
    } catch {
      sendError(res, 400, "the card id is not valid");
      return;
    }
    await handlePut(dir, id, req, res);
    return;
  }
  sendError(res, 404, "not found");
}

export function startBoardServer(dir: string, opts: { port: number; watch?: "fs" | "poll" }): Promise<BoardServer> {
  return new Promise((resolve, reject) => {
    const clients = new Set<EventClient>();
    const server = createServer((req, res) => {
      res.setHeader("x-doug-board-serve-pid", String(process.pid));
      handle(dir, clients, req, res).catch((err) => {
        if (res.headersSent) res.end();
        else sendError(res, 500, messageOf(err));
      });
    });
    const onRecordChange = (): void => {
      let serialized: string;
      try {
        serialized = JSON.stringify(loadBoard(dir));
      } catch {
        // Mid-write or invalid; keep watching and try again on the next change.
        return;
      }
      for (const client of clients) {
        if (client.lastSent === serialized) continue;
        client.lastSent = serialized;
        client.res.write(`event: board\ndata: ${serialized}\n\n`);
      }
    };
    const watcher = watchRecord(dir, opts.watch ?? "fs", onRecordChange);
    const onError = (err: Error): void => reject(err);
    server.once("error", onError);
    server.listen(opts.port, HOST, () => {
      server.off("error", onError);
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : opts.port;
      resolve({
        port,
        url: `http://${HOST}:${port}/`,
        close: () =>
          new Promise<void>((done) => {
            watcher.stop();
            for (const client of clients) client.res.end();
            clients.clear();
            server.close(() => done());
            // Keep-alive sockets would hold the listener open otherwise.
            server.closeAllConnections?.();
          }),
      });
    });
  });
}
