// Shared helpers for git-hooks.test.mjs, git-hooks-docs.test.mjs and git-hooks-dist.test.mjs (card
// split-git-hooks-rehearse-tests): moved verbatim from the original single file. Each test file keeps its own
// vi.setConfig and the afterEach macrotask turn.
import { spawnSync, spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// The repo's real hook directory, not a copy: the test proves the file that ships.
export const HOOKS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", ".githooks");

// Every git spawn starts from an env with git's own location variables removed,
// so the test stays in its temp repos even when it runs inside the outer hook.
export function cleanEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith("GIT_")) env[k] = v;
  }
  return env;
}

export function git(cwd, args, extraEnv = {}) {
  return spawnSync("git", args, { cwd, encoding: "utf8", env: { ...cleanEnv(), ...extraEnv } });
}

// Each case gets a fresh repo whose package.json maps `typecheck` and
// `test:unit` to trivial scripts, so the hook's `pnpm typecheck` /
// `pnpm test:unit` calls resolve to the case's exit codes.
export function makeRepo({ typecheckExit, unitExit }) {
  const cwd = mkdtempSync(join(tmpdir(), "doug-githooks-"));
  git(cwd, ["init", "-q", "-b", "main"]);
  git(cwd, ["config", "user.name", "Test"]);
  git(cwd, ["config", "user.email", "test@example.com"]);
  git(cwd, ["config", "core.hooksPath", HOOKS_DIR]);
  writeFileSync(
    join(cwd, "package.json"),
    JSON.stringify(
      {
        name: "fixture",
        private: true,
        scripts: { typecheck: "node typecheck.mjs", "test:unit": "node test-unit.mjs" },
      },
      null,
      2,
    ),
  );
  // typecheck also fails on any git location vars the hook let through: with
  // GIT_DIR / GIT_INDEX_FILE set, git spawned by the real test suite would
  // operate on the committing repo instead of its own temp repos.
  writeFileSync(
    join(cwd, "typecheck.mjs"),
    `console.log("TYPECHECK-MARKER");\n` +
      `const leaked = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_PREFIX", "GIT_COMMON_DIR"].filter((k) => k in process.env);\n` +
      `if (leaked.length) { console.log("LEAKED-GIT-ENV=" + leaked.join(",")); process.exit(1); }\n` +
      `process.exit(${typecheckExit});\n`,
  );
  writeFileSync(join(cwd, "test-unit.mjs"), `console.log("UNIT-MARKER");\nprocess.exit(${unitExit});\n`);
  git(cwd, ["add", "-A"]);
  return cwd;
}

// GIT_DIR / GIT_WORK_TREE point at the same temp repo, so they are harmless
// here; git forwards them to the hook, which makes the leak check deterministic
// rather than depending on which variables git happens to export.
export function commit(cwd) {
  const r = git(cwd, ["commit", "-q", "-m", "x"], { GIT_DIR: join(cwd, ".git"), GIT_WORK_TREE: cwd });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

// An async spawn that never rejects: resolves { status, stdout, stderr } like spawnSync's result.
export function runAsync(bin, args, { cwd, env } = {}) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let child;
    try {
      child = spawn(bin, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      resolve({ status: null, stdout, stderr: String(e) });
      return;
    }
    child.stdout.setEncoding("utf8").on("data", (d) => (stdout += d));
    child.stderr.setEncoding("utf8").on("data", (d) => (stderr += d));
    child.on("error", (e) => (stderr += String(e)));
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}
export function gitA(cwd, args, extraEnv = {}) {
  return runAsync("git", args, { cwd, env: { ...cleanEnv(), ...extraEnv } });
}
export async function commitA(cwd) {
  const r = await gitA(cwd, ["commit", "-q", "-m", "x"], { GIT_DIR: join(cwd, ".git"), GIT_WORK_TREE: cwd });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

// Async twin of makeRepo for the docs-rule cases (identical fixture, async git calls).
export async function makeRepoA({ typecheckExit, unitExit }) {
  const cwd = mkdtempSync(join(tmpdir(), "doug-githooks-"));
  await gitA(cwd, ["init", "-q", "-b", "main"]);
  await gitA(cwd, ["config", "user.name", "Test"]);
  await gitA(cwd, ["config", "user.email", "test@example.com"]);
  await gitA(cwd, ["config", "core.hooksPath", HOOKS_DIR]);
  writeFileSync(
    join(cwd, "package.json"),
    JSON.stringify({ name: "fixture", private: true, scripts: { typecheck: "node typecheck.mjs", "test:unit": "node test-unit.mjs" } }, null, 2),
  );
  writeFileSync(
    join(cwd, "typecheck.mjs"),
    `console.log("TYPECHECK-MARKER");\n` +
      `const leaked = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_PREFIX", "GIT_COMMON_DIR"].filter((k) => k in process.env);\n` +
      `if (leaked.length) { console.log("LEAKED-GIT-ENV=" + leaked.join(",")); process.exit(1); }\n` +
      `process.exit(${typecheckExit});\n`,
  );
  writeFileSync(join(cwd, "test-unit.mjs"), `console.log("UNIT-MARKER");\nprocess.exit(${unitExit});\n`);
  await gitA(cwd, ["add", "-A"]);
  return cwd;
}

// card gate-output-names-failures (R3): the "full output kept at <path>" line is not quoted, so this grabs
// everything up to the end of that line.
export function extractLogPath(out, cwd) {
  const m = out.match(/full output kept at (\S+)/);
  if (!m) return null;
  return m[1].startsWith("/") ? m[1] : join(cwd, m[1]);
}
