// Proves the mechanism in tests/setup/tmpdir.mjs: os.tmpdir() is scoped to a fresh directory for this
// test file, mkdtempSync lands under it, and a spawned child process (default env) sees the same
// scoped root. The afterAll removal itself cannot be asserted here (a test can't observe its own
// file's afterAll) - that's proven by the before/after directory counts in the card's report instead.
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, basename } from "node:path";
import { execFileSync } from "node:child_process";

describe("tests/setup/tmpdir.mjs", () => {
  it("scopes os.tmpdir() to a doug-tests- directory", () => {
    expect(tmpdir()).toMatch(/\/doug-tests-[^/]+$/);
  });

  it("routes mkdtempSync under a doug-tests- root, not just wherever tmpdir() points", () => {
    // Checking the probe's parent against a fixed doug-tests- pattern, rather than against tmpdir()
    // itself (`dir.startsWith(tmpdir())`), which is true by construction - mkdtempSync always lands
    // under whatever tmpdir() returns, scoped or not, so that check alone proves nothing about scoping.
    const probe = mkdtempSync(join(tmpdir(), "probe-"));
    expect(basename(dirname(probe))).toMatch(/^doug-tests-/);
  });

  it("routes a spawned child process's os.tmpdir() to the same doug-tests- root", () => {
    const out = execFileSync(process.execPath, ["-e", "process.stdout.write(require('node:os').tmpdir())"], {
      encoding: "utf8",
    });
    // Checked against the doug-tests- prefix, not only equality with this process's tmpdir(): without
    // the scoping, both processes would still read the same unscoped system temp dir by coincidence
    // (TMPDIR is inherited either way), so equality alone would pass even with scoping removed.
    expect(basename(out)).toMatch(/^doug-tests-/);
    expect(out).toBe(tmpdir());
  });
});
