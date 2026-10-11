#!/usr/bin/env node
// Run the gate commands (stopGate.commands, or --command), or credit a verified-tree record of the same tree
// (card verified-tree-record). Usage:
//   node .doug/hooks/scripts/verify.mjs [--no-credit] [--json] [--dir <project>] [--cwd <tree dir>] [--timeout-ms <n>]
//     [--record-dir <dir>] [--credit-dir <dir>]... [--by <writer>] [--command <cmd>]...
// Exit: 0 all green or credited; 1 any command failed or timed out; 2 usage error or no commands.
// No count ratchet and no scans here (no session baseline); the Stop gate does those. Takes the Stop gate's .doug/.state/gate.lock around the commands (card verify-takes-gate-lock).

import { spawnSync } from "node:child_process";
import { unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig } from "../lib/config.mjs";
import { gateLockPath, readGateLock, pidIsLive, writeGateLock, takeOverGateLock, resolveHookTimeoutSec, lockStaleByAge, normalizedTimeoutMs, lockWaitBoundMs } from "../lib/gate-lock.mjs";
import { runCommand, tail } from "../lib/run.mjs";
import { parseTotals, readSummaries, sumTotals } from "../lib/test-totals.mjs";
import { computeTree, readRecord, writeRecord, removeRecord, creditable, resolveCommands } from "../lib/verified-tree.mjs";

function parseArgs(argv) {
  const o = { noCredit: false, json: false, commands: [], creditDirs: [] };
  const val = (i) => (i + 1 < argv.length ? argv[i + 1] : null);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--no-credit") o.noCredit = true;
    else if (a === "--json") o.json = true;
    else if (a === "--dir" || a === "--cwd" || a === "--record-dir" || a === "--credit-dir" || a === "--command" || a === "--by" || a === "--timeout-ms") {
      const v = val(i);
      if (v === null) return { error: `${a} needs a value` };
      i++;
      if (a === "--command") o.commands.push(v);
      else if (a === "--credit-dir") o.creditDirs.push(v);
      else if (a === "--timeout-ms") {
        const n = Number(v);
        if (!Number.isInteger(n) || n <= 0) return { error: "--timeout-ms needs a positive integer" };
        o.timeoutMs = n;
      }
      else o[a === "--dir" ? "dir" : a === "--cwd" ? "cwd" : a === "--by" ? "by" : "recordDir"] = v;
    } else return { error: `unknown argument ${a}` };
  }
  return o;
}

function toplevel() {
  try {
    const env = {};
    for (const [k, v] of Object.entries(process.env)) if (!k.startsWith("GIT_")) env[k] = v;
    const r = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: process.cwd(), encoding: "utf8", env, timeout: 10000 });
    if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
  } catch {
    // fall through
  }
  return process.cwd();
}

function passed(totals) {
  const s = totals && totals.status === "ok" ? readSummaries(totals) : null;
  if (!s) return null;
  const t = sumTotals(s);
  return t.total - t.skipped - t.todo;
}

function gateLine(entries) {
  return "gate: " + entries.map((e) => `${e.name} ${e.exit}${e.passed === null || e.passed === undefined ? "" : ` (${e.passed} passed)`}`).join("; ");
}

function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.error) {
    process.stderr.write(`[doug] verify: ${o.error}\n`);
    return 2;
  }
  const dir = resolve(o.dir || toplevel());
  const cwd = resolve(o.cwd || dir);
  const recordDir = resolve(o.recordDir || dir);
  const cfg = loadConfig(dir);
  const commands = o.commands.length ? o.commands.map((c) => ({ name: c, command: c })) : resolveCommands(cfg);
  if (commands.length === 0) {
    process.stderr.write("[doug] verify: no commands (stopGate.commands is empty and no --command given)\n");
    return 2;
  }
  let treeBefore = computeTree(cwd);

  // Credits a verified-tree record of the same tree when one exists; returns the exit code, or null.
  const tryCredit = () => {
  if (!o.noCredit && treeBefore) {
    const wanted = commands.map((c) => c.command);
    let record = null;
    let fromOther = false;
    for (const [i, d] of [recordDir, ...o.creditDirs.map((c) => resolve(c))].entries()) {
      const rec = readRecord(d);
      if (rec && creditable(cwd, cfg, rec, treeBefore, wanted).ok) {
        record = rec;
        fromOther = i > 0;
        break;
      }
    }
    if (record) {
      if (fromOther) writeRecord(recordDir, { ...record, tree: treeBefore, by: `${o.by || "verify"} (from ${record.by || "unknown"})`, at: new Date().toISOString() });
      const entries = record.commands.map((c) => ({ name: c.name, exit: c.exit, passed: passed(record.totals[c.command]) }));
      if (o.json) {
        const results = record.commands.map((c) => ({ name: c.name, command: c.command, ok: true, status: c.exit, timedOut: false, durationMs: c.durationMs, outputTail: "" }));
        process.stdout.write(JSON.stringify({ ok: true, credited: "verified-tree", tree: treeBefore, record, results }) + "\n");
      } else {
        process.stdout.write(`[doug] verify: credited verified-tree record (tree ${treeBefore.slice(0, 7)}, by ${record.by || "unknown"}, ${record.at}, node ${record.node}); commands not re-run. --no-credit runs them.\n`);
        process.stdout.write(gateLine(entries) + "\n");
      }
      return 0;
    }
  }
  return null;
  };
  const first = tryCredit();
  if (first !== null) return first;

  const timeoutMs = o.timeoutMs ? o.timeoutMs : (cfg.stopGate && normalizedTimeoutMs(cfg)) ?? 600000;
  const waitBoundMs = lockWaitBoundMs(timeoutMs, commands.length);

  // Card verify-takes-gate-lock: one full suite at a time per checkout, the same gate.lock the Stop gate takes
  // (lib/gate-lock.mjs). A live holder is waited on for up to timeoutMs x command count (the Stop gate's bound), then the record is re-checked (the
  // holder's green run may have just written it); a lock still held after the bound is taken over and the
  // commands run. Released only by the exit handler below, so every return path (green, red, throw) frees it.
  let lockOwned = false;
  process.on("exit", () => {
    try {
      if (!lockOwned) return;
      const lock = readGateLock(dir);
      if (lock && lock.pid === process.pid) unlinkSync(gateLockPath(dir));
    } catch {
      // never throw from an exit handler
    }
  });
  try {
    writeGateLock(dir, o.by || "verify");
    lockOwned = true;
  } catch (err) {
    if (!err || err.code !== "EEXIST") {
      lockOwned = false; // an unwritable .doug/.state: run unlocked rather than hang
    } else {
      const hookTimeoutMs = resolveHookTimeoutSec(cfg) * 1000;
      const stale = (l) => !l || !pidIsLive(l.pid) || lockStaleByAge(l, hookTimeoutMs);
      const held = readGateLock(dir);
      if (stale(held)) {
        takeOverGateLock(dir, o.by || "verify");
        lockOwned = true;
      } else {
        const deadline = Date.now() + waitBoundMs;
        let live = held;
        const nap = new Int32Array(new SharedArrayBuffer(4));
        while (true) {
          live = readGateLock(dir);
          if (stale(live) || Date.now() >= deadline) break;
          Atomics.wait(nap, 0, 0, 200);
        }
        treeBefore = computeTree(cwd);
        const again = tryCredit();
        if (again !== null) return again;
        if (!stale(live)) process.stderr.write(`[doug] verify: gate.lock still held by pid ${live.pid} after ${waitBoundMs} ms; running the commands anyway.\n`);
        takeOverGateLock(dir, o.by || "verify");
        lockOwned = true;
      }
    }
  }
  const results = [];
  const recCommands = [];
  const totals = {};
  const entries = [];
  for (const c of commands) {
    const r = runCommand(c.command, { cwd, timeoutMs });
    const exit = r.status === null || r.status === undefined ? 1 : r.status;
    const parsed = r.ok ? parseTotals(r.stdout + "\n" + r.stderr) : { status: "none" };
    results.push({ name: c.name, command: c.command, ok: r.ok, status: r.status, timedOut: r.timedOut, durationMs: r.durationMs, outputTail: tail(`${r.stdout}\n${r.stderr}`) });
    recCommands.push({ name: c.name, command: c.command, exit, durationMs: r.durationMs });
    if (r.ok && parsed.status === "ok") totals[c.command] = parsed;
    entries.push({ name: c.name, exit, passed: r.ok ? passed(parsed) : null });
    if (!o.json) {
      process.stdout.write(`[doug] verify: \`${c.command}\` exit ${r.timedOut ? "timeout" : exit} (${(r.durationMs / 1000).toFixed(1)} s)\n`);
      if (!r.ok) process.stdout.write(`${r.stderr}${r.stdout}\n`);
    }
    if (!r.ok) break;
  }
  const ok = results.length === commands.length && results.every((r) => r.ok);
  if (ok) {
    const treeAfter = computeTree(cwd);
    if (treeBefore && treeAfter && treeBefore === treeAfter) {
      writeRecord(recordDir, { version: 1, tree: treeAfter, node: process.version, at: new Date().toISOString(), by: o.by || "verify", commands: recCommands, totals });
    }
  } else {
    removeRecord(recordDir);
  }
  if (o.json) process.stdout.write(JSON.stringify({ ok, credited: null, tree: treeBefore, record: null, results }) + "\n");
  else process.stdout.write(gateLine(entries) + "\n");
  return ok ? 0 : 1;
}

let code = 1;
try {
  code = main();
} catch (err) {
  process.stderr.write(`[doug] verify: ${err && err.message ? err.message : err}\n`);
  code = 1;
}
process.exitCode = code;
