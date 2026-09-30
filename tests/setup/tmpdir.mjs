// Vitest setup file (registered in vitest.config.ts's test.setupFiles). Every test file that calls
// mkdtempSync(join(tmpdir(), ...)) - directly or through library code / spawned child processes it
// invokes with the default env - leaves its temp dir under os.tmpdir() with no cleanup. Rather than
// edit the 35 test files that do this, this file scopes os.tmpdir() to a fresh directory per test
// file (setupFiles run once per module context, and Vitest gives each test file its own) and removes
// that directory in afterAll, on success or failure alike. Sweeping by ownership (this file's own
// scoped root) rather than by name prefix means it can never delete another worker's live fixture.
import { afterAll } from "vitest";
import { mkdtempSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Capture the real OS temp dir before overriding TMPDIR, so the scoped root is created under the
// actual system location rather than nested under a previous test file's root (setupFiles run fresh
// per file, but capture defensively in case TMPDIR is already set in the environment).
const originalTmpdir = tmpdir();
const root = mkdtempSync(join(originalTmpdir, "doug-tests-"));
// os.tmpdir() returns TMPDIR verbatim (it does not resolve symlinks), and on macOS the real temp dir
// lives under /private/var while /var is a symlink to it; realpath-ing here keeps a test that resolves
// a path itself (or compares one against os.tmpdir()) from seeing a symlink mismatch. Stored once as
// a constant: process.env.TMPDIR is mutable (a test could reassign or delete it), so cleanup below
// removes this captured value, never whatever TMPDIR happens to hold by the time it runs.
const realRoot = realpathSync(root);
process.env.TMPDIR = realRoot;

let removed = false;
function cleanup() {
  if (removed) return;
  removed = true;
  try {
    // force: true already tolerates a path that is already gone (no throw), so afterAll and the
    // exit fallback below can both call this with no ordering requirement between them.
    rmSync(realRoot, { recursive: true, force: true });
  } catch (err) {
    console.error(`tests/setup/tmpdir.mjs: failed to remove ${realRoot}: ${err.message}`);
  }
}

afterAll(cleanup);
// A file that only collects tests (`vitest list`) or throws during collection runs this setup module
// but never reaches afterAll, leaving an empty doug-tests-* root behind. process.on("exit") is the
// documented fallback for that, but measured against `vitest list` it never fires here: Vitest's
// default forks pool tears a collect-only worker down with SIGTERM, not a normal exit, and "exit"
// only fires on a normal exit. SIGTERM/SIGINT run cleanup and then re-raise the default disposition
// (removing this handler and re-sending the signal) rather than calling process.exit() themselves, so
// the worker still ends the way Vitest expects; "exit" stays registered too as a fallback for a
// normal exit this file's own reasoning didn't anticipate.
process.on("exit", cleanup);
for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    cleanup();
    process.removeAllListeners(sig);
    process.kill(process.pid, sig);
  });
}
