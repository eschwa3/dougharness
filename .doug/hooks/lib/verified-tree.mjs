// Verified-tree record (card verified-tree-record): "these commands exited 0 on exactly this tree".
//
// computeTree hashes the WORKING tree (tracked, modified and untracked-but-not-ignored files) into a git tree
// sha through a private temp index, so the real index and the staged diff are never touched. A writer records
// the sha after a green run; a reader credits the record when the current tree is the recorded one, or differs
// only on preCommit.noTestPaths (the pre-commit rule), under the same Node and the same command set.
//
// Standing: a record is an honest-path record, not proof. A forged record credits Stop, SubagentStop, land and
// verify.mjs (accepted, same standing as the proposal ledger, decision 0006 amendment). The commit cannot be
// forged past: the pre-commit hook never reads it.
//
// Every export except resolveCommands never throws (hook readers fail open): failure returns null / false / no-op.
// resolveCommands is moved unchanged from stop-gate.mjs and expects a loaded config.

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";

export const RECORD_RELPATH = ".doug/.state/verified-tree.json";
export const EXCLUDED = [".doug/.state", ".claude/worktrees", ".doug/anchor.md"];

const SHA_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const GIT_FLAGS = ["-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false"];

function cleanGitEnv(extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith("GIT_")) env[k] = v;
  return { ...env, ...extra };
}

function git(dir, args, env) {
  return spawnSync("git", [...GIT_FLAGS, ...args], { cwd: dir, encoding: "utf8", env, timeout: 10000, maxBuffer: 64 * 1024 * 1024 });
}

function unlinkQuiet(p) {
  try {
    unlinkSync(p);
  } catch {
    // already gone
  }
}

export function computeTree(dir, opts) {
  let tmpIndex = null;
  try {
    const tmpDir = (opts && opts.tmpDir) || join(dir, ".doug/.state");
    const baseEnv = cleanGitEnv();
    const where = git(dir, ["rev-parse", "--git-path", "index"], baseEnv);
    if (where.status !== 0) return null;
    const realIndex = resolve(dir, String(where.stdout).trim());
    mkdirSync(tmpDir, { recursive: true });
    tmpIndex = join(tmpDir, `verified-tree.index.${process.pid}.${randomBytes(4).toString("hex")}`);
    if (existsSync(realIndex)) {
      // Stat BEFORE copying: a git replacing the index between copy and stat would pair new times with old bytes.
      const st = statSync(realIndex);
      copyFileSync(realIndex, tmpIndex);
      // git's racy-clean check compares entry mtimes with the index FILE's mtime; a fresh copy would look newer
      // than the real index and let a same-size edit made in the same instant as the last index write read as
      // unchanged (a stale blob in the tree). Keep the real index's times, floored to whole seconds (an older
      // time is always the safe side, and it needs no nanosecond support).
      utimesSync(tmpIndex, Math.floor(st.atimeMs / 1000), Math.floor(st.mtimeMs / 1000));
    }
    const env = cleanGitEnv({ GIT_INDEX_FILE: tmpIndex });
    // No pathspec and no exclude pathspecs: an exclude of a gitignored dir makes `git add` exit 1.
    if (git(dir, ["add", "-A"], env).status !== 0) return null;
    // The seed may carry tracked entries for excluded paths (anchor.md is tracked in this repo).
    if (git(dir, ["rm", "-r", "-q", "-f", "--cached", "--ignore-unmatch", "--", ...EXCLUDED], env).status !== 0) return null;
    const staged = git(dir, ["ls-files", "-s"], env);
    if (staged.status !== 0) return null;
    if (String(staged.stdout).split("\n").some((l) => l.startsWith("160000 "))) return null;
    const tags = git(dir, ["ls-files", "-v"], env);
    if (tags.status !== 0) return null;
    if (String(tags.stdout).split("\n").some((l) => /^[a-zS] /.test(l))) return null;
    const w = git(dir, ["write-tree"], env);
    if (w.status !== 0) return null;
    const sha = String(w.stdout).trim();
    return SHA_RE.test(sha) ? sha : null;
  } catch {
    return null;
  } finally {
    if (tmpIndex) {
      unlinkQuiet(tmpIndex);
      unlinkQuiet(`${tmpIndex}.lock`);
    }
  }
}

const isObj = (x) => x !== null && typeof x === "object" && !Array.isArray(x);

export function validRecord(r) {
  try {
    return (
      isObj(r) &&
      r.version === 1 &&
      typeof r.tree === "string" &&
      SHA_RE.test(r.tree) &&
      Array.isArray(r.commands) &&
      r.commands.length > 0 &&
      r.commands.every((c) => isObj(c) && typeof c.name === "string" && typeof c.command === "string" && c.command !== "" && Number.isInteger(c.exit) && typeof c.durationMs === "number") &&
      isObj(r.totals) &&
      typeof r.node === "string" &&
      typeof r.at === "string"
    );
  } catch {
    return false;
  }
}

export function readRecord(dir) {
  try {
    const r = JSON.parse(readFileSync(join(dir, RECORD_RELPATH), "utf8"));
    return validRecord(r) ? r : null;
  } catch {
    return null;
  }
}

export function writeRecord(dir, record) {
  let tmp = null;
  try {
    mkdirSync(join(dir, ".doug/.state"), { recursive: true });
    tmp = join(dir, `${RECORD_RELPATH}.tmp.${process.pid}.${randomBytes(4).toString("hex")}`);
    writeFileSync(tmp, JSON.stringify(record));
    renameSync(tmp, join(dir, RECORD_RELPATH));
    return true;
  } catch {
    if (tmp) unlinkQuiet(tmp);
    return false;
  }
}

export function removeRecord(dir) {
  try {
    unlinkSync(join(dir, RECORD_RELPATH));
  } catch {
    // ENOENT or unremovable: nothing to do
  }
}

// The pre-commit rule (.githooks/pre-commit, lib/baseline.mjs): equal to the entry, or under an entry ending in `/`.
export function noTestPathHit(list, p) {
  try {
    return list.some((e) => (e.endsWith("/") ? p.startsWith(e) : p === e));
  } catch {
    return false;
  }
}

export function resolveCommands(cfg) {
  const out = [];
  for (const entry of cfg.stopGate.commands || []) {
    if (typeof entry !== "string") continue;
    const named = cfg.commands && cfg.commands[entry];
    out.push({ name: entry, command: typeof named === "string" ? named : entry });
  }
  return out;
}

// -> { ok: true, diff } or { ok: false, why }.
export function creditable(dir, cfg, record, currentTree, commands) {
  try {
    if (!validRecord(record)) return { ok: false, why: "no valid record" };
    if (!record.commands.every((c) => c.exit === 0)) return { ok: false, why: "record has a failing command" };
    if (record.node !== process.version) return { ok: false, why: "record is from another Node version" };
    if (typeof currentTree !== "string" || !SHA_RE.test(currentTree)) return { ok: false, why: "current tree unknown" };
    const rec = new Set(record.commands.map((c) => c.command));
    const now = new Set(commands);
    if (rec.size !== now.size || ![...rec].every((c) => now.has(c))) return { ok: false, why: "command set differs" };
    if (record.tree === currentTree) return { ok: true, diff: [] };
    const list = cfg && cfg.preCommit && cfg.preCommit.noTestPaths;
    if (!Array.isArray(list) || list.length === 0 || !list.every((e) => typeof e === "string" && e !== "")) return { ok: false, why: "tree differs and no noTestPaths list" };
    const d = git(dir, ["diff-tree", "-r", "-z", "--name-only", "--no-renames", record.tree, currentTree], cleanGitEnv());
    if (d.status !== 0) return { ok: false, why: "recorded tree unknown to git" };
    const diff = String(d.stdout).split("\0").filter((p) => p !== "");
    if (diff.length === 0) return { ok: false, why: "empty diff between differing trees" };
    if (diff.includes(".doug/config.json")) return { ok: false, why: ".doug/config.json changed" };
    const bad = diff.find((p) => !noTestPathHit(list, p));
    if (bad !== undefined) return { ok: false, why: `${bad} changed and is not a no-test path` };
    return { ok: true, diff };
  } catch {
    return { ok: false, why: "error" };
  }
}

// CLI for the pre-commit hook: `node verified-tree.mjs tree [dir]` prints the tree sha (empty on failure);
// `node verified-tree.mjs record <treeBefore> <commandsJson> [dir]` writes a by-pre-commit record when the
// working tree is still treeBefore. Always exits 0.
function isMain() {
  try {
    return !!process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}
if (isMain()) {
  try {
    const [cmd, a, b, c] = process.argv.slice(2);
    if (cmd === "tree") {
      process.stdout.write(computeTree(a || process.cwd()) || "");
    } else if (cmd === "record") {
      const dir = c || process.cwd();
      const after = computeTree(dir);
      if (after && after === a) {
        const commands = JSON.parse(b);
        const totals = {};
        for (const cm of commands) {
          if (cm.totals && cm.totals.status === "ok") totals[cm.command] = cm.totals;
        }
        writeRecord(dir, {
          version: 1,
          tree: after,
          node: process.version,
          at: new Date().toISOString(),
          by: "pre-commit",
          commands: commands.map((cm) => ({ name: cm.name, command: cm.command, exit: cm.exit, durationMs: cm.durationMs })),
          totals,
        });
      }
    }
  } catch {
    // never fail the hook
  }
}
