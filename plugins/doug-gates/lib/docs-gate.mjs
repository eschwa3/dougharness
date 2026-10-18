// card gate-docs-skip-unless-named: the docs rule shared by the Stop gate and the pre-commit hook
// (.githooks/pre-commit). A changed docs/**/*.md file does not by itself run the suite. When every changed path
// is on preCommit.noTestPaths or is a docs .md (and at least one is a docs .md not on the list), the tracked
// test files whose text names that doc (its repo-relative path, or its basename, which also covers a
// join("docs", "decisions", "<basename>") spelling) decide; non-test code outside a tests/ directory counts a
// doc as named only by its full repo-relative path (a basename in a comment is ignored): none -> { kind: "skip" }; some -> { kind:
// "targeted", files } (repo-relative, sorted). Anything else, or any doubt, returns null: run the full gate.
// Never throws (a throw would reach runHook, which fails open and would skip the gate).
// CLI (used by .githooks/pre-commit): staged paths on stdin, the config JSON in DOUG_NO_TEST_CONFIG, cwd =
// the repo; prints "skip", or "targeted" then one file per line; prints nothing for the full gate.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

const TEST_FILE = /\.test\.(mjs|js|ts|cjs)$/;
const CODE_FILE = /\.(mjs|js|ts|cjs|sh)$/;
// Only plainly shell-safe paths are handed to a command line; anything else runs the full gate.
const SAFE_PATH = /^[A-Za-z0-9_.@+/-]+$/;

export function isDocsMarkdown(p) {
  return typeof p === "string" && p.startsWith("docs/") && p.endsWith(".md");
}

function noTestHit(list, p) {
  return list.some((e) => (e.endsWith("/") ? p.startsWith(e) : p === e));
}

function validList(cfg) {
  const list = cfg && cfg.preCommit && cfg.preCommit.noTestPaths;
  return Array.isArray(list) && list.length > 0 && list.every((e) => typeof e === "string" && e !== "") ? list : null;
}

// -> sorted test files naming any of `docs`, or null (unreadable tree, or a file that cannot be mapped to test
// files names a doc).
function namingTests(dir, docs, tracked) {
  const pathNeedles = [...new Set(docs)];
  const wideNeedles = [...new Set(docs.flatMap((d) => [d, basename(d)]))];
  const found = [];
  for (const f of tracked) {
    const isTest = TEST_FILE.test(f);
    const underTests = f.startsWith("tests/") || f.includes("/tests/");
    const code = CODE_FILE.test(f) && !f.startsWith("docs/");
    if (!isTest && !underTests && !code) continue;
    if (f.startsWith("docs/")) continue;
    const text = readFileSync(join(dir, f), "utf8");
    // code outside tests/ names a doc only by its full repo-relative path; tests and test helpers also by basename
    const needles = isTest || underTests ? wideNeedles : pathNeedles;
    if (!needles.some((n) => text.includes(n))) continue;
    if (!isTest) return null; // a helper or source file reads the doc: cannot be mapped to test files
    found.push(f);
  }
  return found.sort();
}

// preCommit.docsTests: absent or [] -> []; otherwise the entries, or null when malformed or not a tracked file.
function docsTestsList(cfg, tracked) {
  const v = cfg && cfg.preCommit && cfg.preCommit.docsTests;
  if (v === undefined) return [];
  if (!Array.isArray(v) || !v.every((e) => typeof e === "string" && e !== "")) return null;
  const set = new Set(tracked);
  return v.every((e) => set.has(e)) ? v : null;
}

// moved: the changed paths (Set or array). Returns { kind: "skip" } | { kind: "targeted", files } | null.
export function docsGateDecision(dir, cfg, moved) {
  try {
    const list = validList(cfg);
    if (!list) return null;
    const paths = [...moved];
    if (paths.length === 0 || !paths.every((p) => typeof p === "string" && p !== "")) return null;
    const docs = paths.filter((p) => !noTestHit(list, p));
    if (docs.length === 0 || !docs.every(isDocsMarkdown)) return null;
    const raw = execFileSync("git", ["ls-files", "-z"], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10000, maxBuffer: 64 * 1024 * 1024 });
    const tracked = raw.split("\0").filter(Boolean);
    const named = namingTests(dir, docs, tracked);
    const extra = docsTestsList(cfg, tracked);
    if (!named || !extra) return null;
    const files = [...new Set([...named, ...extra])].sort();
    if (files.length === 0) return { kind: "skip" };
    if (!files.every((f) => SAFE_PATH.test(f))) return null;
    return { kind: "targeted", files };
  } catch {
    return null;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const cfg = JSON.parse(process.env.DOUG_NO_TEST_CONFIG);
    const staged = readFileSync(0, "utf8").split("\n").filter((l) => l !== "");
    const d = docsGateDecision(process.cwd(), cfg, staged);
    if (d && d.kind === "skip") process.stdout.write("skip\n");
    else if (d) process.stdout.write(`targeted\n${d.files.join("\n")}\n`);
  } catch {
    // no output: the hook runs the full gate
  }
}
