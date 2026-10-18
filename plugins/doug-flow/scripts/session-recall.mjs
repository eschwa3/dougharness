#!/usr/bin/env node
// SessionStart hook (card memory-every-session, brief A): puts the repository's top lessons into a fresh
// session's context. Runs on source startup|clear only. Query = title and goal of the card(s) in the board's
// flow column, else the query-free top lessons by helpful minus harmful. Keyword recall first; when an
// embeddings provider is configured a hybrid recall races a 3000 ms deadline and wins if it lands. Never
// creates the memory database, never exits non-zero: any exception is one stderr line plus a systemMessage.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DEADLINE_MS = 3000;
const PROVIDER_TIMEOUT_MS = 1500;
const K = 5;

function readStdin(ms) {
  return new Promise((resolve) => {
    let data = "";
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve(data);
    };
    const timer = setTimeout(finish, ms);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (d) => (data += d));
    process.stdin.on("end", () => {
      clearTimeout(timer);
      finish();
    });
    process.stdin.on("error", finish);
  });
}

function parseInput(text) {
  try {
    const v = JSON.parse(text);
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

function optedOut(dir) {
  if (process.env.DOUG_SESSION_RECALL === "0") return true;
  try {
    const raw = JSON.parse(readFileSync(join(dir, ".doug", "config.json"), "utf8"));
    return !!(raw && raw.memory && raw.memory.sessionRecall === false);
  } catch {
    return false;
  }
}

function write(obj) {
  return new Promise((resolve) => process.stdout.write(JSON.stringify(obj) + "\n", resolve));
}

async function run() {
  const input = parseInput(await readStdin(1000));
  const dir = process.env.CLAUDE_PROJECT_DIR || (typeof input.cwd === "string" && input.cwd) || process.cwd();
  const source = input.source;
  if (source !== "startup" && source !== "clear") return;
  if (optedOut(dir)) return;
  // Checked before anything opens it: a missing database is never created here.
  if (!existsSync(join(dir, ".doug", ".state", "memory", "memory.db"))) return;

  const { openMemory, recallLessons, topLessons, renderLessons, degradedReason, windowHidden, windowNote } = await import("../lib/memory.mjs");
  const { readMemoryConfig, readMemoryStaleDays, createProvider } = await import("../lib/embeddings.mjs");
  const { loadBoard } = await import("../lib/board.mjs");

  let cards = [];
  try {
    cards = loadBoard(dir).cards.filter((c) => c.column === "flow");
  } catch {
    cards = [];
  }
  const staleDays = readMemoryStaleDays(dir);
  const m = openMemory(dir);
  let lessons;
  let header;
  let scope;
  let hidden = null;
  try {
    if (cards.length) {
      const query = cards.map((c) => `${c.title}\n${c.goal || ""}`).join("\n");
      scope = `for ${cards.map((c) => c.id).join(", ")}`;
      const provider = createProvider(readMemoryConfig(dir), { timeoutMs: PROVIDER_TIMEOUT_MS });
      let result = await recallLessons(m, query, { k: K, checkoutDir: dir, staleDays, provider: null });
      if (provider) {
        let timer;
        const deadline = new Promise((resolve) => {
          timer = setTimeout(() => resolve(null), DEADLINE_MS);
        });
        const hybrid = recallLessons(m, query, { k: K, checkoutDir: dir, staleDays, provider });
        hybrid.catch(() => {});
        const won = await Promise.race([hybrid, deadline]);
        clearTimeout(timer);
        if (won) result = won;
        else result = { ...result, mode: "keyword-only", reason: "embeddings timed out" };
      }
      header =
        result.mode === "hybrid"
          ? `recall: hybrid via ${result.provider} ${provider.model}/${provider.dims}`
          : `recall: keyword-only (${degradedReason(result)})`;
      lessons = result.lessons;
      hidden = result.hidden;
    } else {
      scope = "the repository: top by helpful-harmful";
      header = null;
      lessons = topLessons(m, { k: K, staleDays });
      hidden = windowHidden(m, { staleDays });
    }
  } finally {
    // A raced-out hybrid recall may still be running; closing the handle makes it fail into its catch.
    try {
      m.close();
    } catch {
      // ignore
    }
  }
  const rendered = renderLessons(lessons);
  const note = windowNote(hidden, staleDays);
  if (rendered.text === null && !note) return;
  const additionalContext =
    rendered.text === null
      ? `[doug] ${note}`
      : `[doug] Lessons from this repository's memory (${header ? `${header}; ` : ""}${scope}):\n${rendered.text}\n` +
        (note ? `${note}\n` : "") +
        "Each line is [lesson id] text (citation). When you brief an agent, paste the lessons that apply and list their ids as memoryUsed.";
  await write({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext } });
}

try {
  await run();
} catch (err) {
  const first = String((err && err.message) || err).split("\n")[0];
  process.stderr.write(`[doug:session-recall] hook error, failing open: ${first}\n`);
  await write({ systemMessage: `[doug:session-recall] hook error, failing open: ${first}` });
}
process.exit(0);
