// Test helpers: a throwaway git repo with a base and head commit, and a fake `codex` executable
// that speaks the same JSONL as `codex exec --json` so the adapter's failure modes are testable offline.

import { mkdtempSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

export function git(dir: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** Creates a repo whose main has add(a,b) = a - b, and a branch `fix` (left checked out) that adds a test but keeps the bug. */
export function makeRepo(): { dir: string; base: string; head: string } {
  const dir = mkdtempSync(join(tmpdir(), "codex-review-repo-"));
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@example.com");
  git(dir, "config", "user.name", "t");
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fx", type: "module", scripts: { test: "node --test" } }, null, 2) + "\n");
  writeFileSync(join(dir, "src/add.js"), "export function add(a, b) {\n  return a - b;\n}\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "base");
  git(dir, "checkout", "-q", "-b", "fix");
  writeFileSync(join(dir, "src/add.js"), "export function add(a, b) {\n  return a - b; // fixed\n}\n");
  writeFileSync(join(dir, "add.test.js"), 'import { test } from "node:test";\nimport assert from "node:assert";\nimport { add } from "./src/add.js";\ntest("add", () => { assert.equal(add(2, 2), 0); });\n');
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "fix: add test");
  return { dir, base: "main", head: "fix" };
}

export type FakeMode = "ok" | "fail-verdict" | "nonzero" | "prose" | "nofinal" | "hang" | "bad-shape" | "mutate" | "blocker-no-evidence";

/**
 * Writes an executable fake codex. It records its argv and stdin to <dir>/received.json, then emits
 * JSONL according to FAKE_CODEX_MODE. Returns the binary path and the record path.
 */
export function makeFakeCodex(): { bin: string; received: string } {
  const dir = mkdtempSync(join(tmpdir(), "fake-codex-"));
  const received = join(dir, "received.json");
  const bin = join(dir, "codex");
  const script = `#!/usr/bin/env node
const fs = require("node:fs");
const mode = process.env.FAKE_CODEX_MODE || "ok";
const argv = process.argv.slice(2);
let stdin = "";
try { stdin = fs.readFileSync(0, "utf8"); } catch {}
fs.writeFileSync(${JSON.stringify(received)}, JSON.stringify({ argv, stdin, cwd: process.cwd(), env: process.env }));
const emit = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
emit({ type: "thread.started", thread_id: "fake-thread" });
emit({ type: "turn.started" });
emit({ type: "item.started", item: { id: "item_1", type: "command_execution", command: "/bin/zsh -lc 'node --test'", aggregated_output: "", exit_code: null, status: "in_progress" } });
emit({ type: "item.completed", item: { id: "item_1", type: "command_execution", command: "/bin/zsh -lc 'node --test'", aggregated_output: "ok 1 - add\\n", exit_code: 0, status: "completed" } });
emit({ type: "item.completed", item: { id: "item_2", type: "command_execution", command: "/bin/zsh -lc 'node -e \\"process.exit(3)\\"'", aggregated_output: "", exit_code: 3, status: "failed" } });
process.stdout.write("not json at all\\n");
if (mode === "hang") { setTimeout(() => {}, 60000); }
else {
  if (mode === "nonzero") { process.stderr.write("boom\\n"); process.exit(7); }
  const oIdx = argv.indexOf("-o");
  const last = (text) => { emit({ type: "item.completed", item: { id: "item_3", type: "agent_message", text } }); if (oIdx >= 0) fs.writeFileSync(argv[oIdx + 1], text); };
  if (mode === "ok") last(JSON.stringify({ verdict: "pass", summary: "Could not break it.", issues: [] }));
  if (mode === "mutate") { fs.appendFileSync("src/add.js", "// reviewer was here\\n"); fs.writeFileSync("scratch.txt", "x"); last(JSON.stringify({ verdict: "pass", summary: "Fixed it for you.", issues: [] })); }
  if (mode === "fail-verdict") last(JSON.stringify({ verdict: "fail", summary: "add still subtracts.", issues: [{ severity: "blocker", file: "src/add.js", line: 2, description: "add(2,2) returns 0", evidence: "node -e \\"process.exit(3)\\" exited 3 with add(2,2) = 0" }, { severity: "minor", file: "add.test.js", description: "test asserts the bug" }] }));
  if (mode === "blocker-no-evidence") last(JSON.stringify({ verdict: "fail", summary: "add still subtracts, allegedly.", issues: [{ severity: "blocker", file: "src/add.js", line: 2, description: "add(2,2) returns 0" }] }));
  if (mode === "prose") last("I think it is fine, no JSON for you.");
  if (mode === "bad-shape") last(JSON.stringify({ verdict: "maybe", summary: 1, issues: "none" }));
  emit({ type: "turn.completed", usage: { input_tokens: 1234, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 56, reasoning_output_tokens: 0 } });
  process.exit(0);
}
`;
  writeFileSync(bin, script);
  chmodSync(bin, 0o755);
  return { bin, received };
}
