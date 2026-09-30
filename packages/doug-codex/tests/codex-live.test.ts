// Integration: really spawns `codex exec` against a repo whose "fix" keeps the bug the spec says to fix.
// Skips cleanly when codex is not installed. Costs real Codex usage when it runs.
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { runCodexReview } from "../src/run.js";
import { makeRepo } from "./helpers.js";

const nested = !!process.env.DOUG_CODEX_REVIEW;
const codexPresent = nested ? false : spawnSync("codex", ["--version"], { encoding: "utf8" }).status === 0;
const skipReason = nested
  ? "DOUG_CODEX_REVIEW is set: this test spawns codex-review and is already running inside one"
  : codexPresent
    ? ""
    : "codex is not installed; skipping the live integration test";

describe.skipIf(nested || !codexPresent)(`codex-review live${skipReason ? ` (${skipReason})` : ""}`, () => {
  it(
    "runs codex sandboxed, returns a schema-valid result with real command exit codes, leaves the tree untouched, and catches the unfixed bug",
    async () => {
      const repo = makeRepo();
      const r = await runCodexReview({
        spec: "Fix add(a, b) in src/add.js so that it returns a + b (it currently returns a - b). Add a test that would fail before the fix and pass after it.",
        base: repo.base,
        head: repo.head,
        dir: repo.dir,
        verifyCommands: ["node --test"],
        timeoutMs: 8 * 60 * 1000,
      });
      // Structural contract, independent of what the model decided.
      expect(r.reviewer).toBe("codex");
      expect(r.codexExitCode).toBe(0);
      expect(r.error, JSON.stringify(r.error)).toBeNull();
      expect(["pass", "fail", "inconclusive"]).toContain(r.verdict);
      expect(r.changedFiles).toEqual(["add.test.js", "src/add.js"]);
      for (const c of r.commandsRun) {
        expect(typeof c.command).toBe("string");
        expect(c.exitCode === null || Number.isInteger(c.exitCode)).toBe(true);
        expect(c.ok).toBe(c.exitCode === 0);
      }
      expect(r.usage && r.usage.outputTokens).toBeGreaterThan(0);
      // The bug is unfixed and the test asserts the bug: an adversarial reviewer must not pass this.
      expect(r.verdict).toBe("fail");
      expect(r.issues.some((i) => i.severity === "blocker" && /add\.js|add\.test\.js/.test(i.file))).toBe(true);
      process.stdout.write(`\n[codex-live] verdict=${r.verdict} issues=${r.issues.length} commands=${r.commandsRun.length} durationMs=${r.durationMs} tokens=${JSON.stringify(r.usage)}\n`);
    },
    10 * 60 * 1000,
  );
});
