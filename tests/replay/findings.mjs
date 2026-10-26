// Findings writer for the e2e replay and journey tests (docs/specs/ci-e2e/architecture.md 4.3, pseudocode 7).
// A finding is one broken replay or journey step; recordFindings merges a source's findings into one shared
// JSON file under a lock directory, so the replay file and the journey file can write to it in parallel.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, rmdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const FINDINGS_FILE = join(ROOT, ".doug/.state/e2e/findings.json");

const LOCK_RETRY_MS = 100;
const LOCK_CAP_MS = 10_000;

// Stable across runs: lowercase, with paths, hex runs of 7 or more (shas) and digits removed, then every
// non-letter run turned into one dash and the result cut to 60 characters.
export function slug(message) {
  return String(message)
    .replace(/(?:[A-Za-z]:)?\/[^\s"'`)\]]+/g, " ")
    .replace(/\b[0-9a-f]{7,}\b/gi, " ")
    .replace(/\d+/g, " ")
    .toLowerCase()
    .replace(/[^a-z]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/, "");
}

export function commitUnderTest(root = ROOT) {
  try {
    const opts = { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] };
    const sha = execFileSync("git", ["rev-parse", "HEAD"], opts).trim();
    const dirty = execFileSync("git", ["status", "--porcelain"], opts).trim() !== "";
    return dirty ? `${sha}-dirty` : sha;
  } catch {
    return "unknown";
  }
}

export function finding({ scenario, stage, message, kind, suspect = "either", replayFile = null, reproduce = null, source }) {
  const assertion = slug(message);
  return {
    key: `${scenario}/${stage}/${assertion}`,
    scenario,
    stage,
    assertion,
    message: String(message),
    commit: commitUnderTest(ROOT),
    kind,
    suspect,
    replayFile,
    reproduce,
    source,
    at: new Date().toISOString(),
  };
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Takes the lock directory; true when held. After the 10 s cap it gives up and returns false.
function takeLock(lock) {
  const start = Date.now();
  for (;;) {
    try {
      mkdirSync(lock);
      return true;
    } catch (e) {
      if (!e || e.code !== "EEXIST") return false;
    }
    if (Date.now() - start >= LOCK_CAP_MS) return false;
    sleep(LOCK_RETRY_MS);
  }
}

// Drops every entry whose `source` is this source, appends the new findings, and writes the file through a tmp
// file and a rename. Never throws: a missing or unreadable file starts from an empty list, and a lock that
// cannot be taken within 10 s lets the write go ahead unlocked (the rename keeps the file whole).
export function recordFindings(source, findings, { file = FINDINGS_FILE } = {}) {
  try {
    mkdirSync(dirname(file), { recursive: true });
    const lock = `${file}.lock`;
    const held = takeLock(lock);
    try {
      let existing = [];
      try {
        const parsed = JSON.parse(readFileSync(file, "utf8"));
        if (Array.isArray(parsed)) existing = parsed;
      } catch {
        // missing or unreadable: start fresh
      }
      const merged = existing.filter((f) => !f || f.source !== source).concat(findings);
      const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(merged, null, 2)}\n`);
      renameSync(tmp, file);
    } finally {
      if (held) {
        try {
          rmdirSync(lock);
        } catch {
          // already gone
        }
      }
    }
  } catch {
    // a findings writer must never fail the test that called it
  }
}
