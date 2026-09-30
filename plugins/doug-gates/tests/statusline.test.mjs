import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync, writeFileSync, cpSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeProject, scriptsDir } from "./helpers.mjs";
import { statePath } from "../lib/state.mjs";

// Spawned from a cwd that is NOT the project in the JSON, so every path must come from stdin.
const otherDir = mkdtempSync(join(tmpdir(), "doug-elsewhere-"));

// Card statusline-installed-version: the version the plugin-tree run of statusline.mjs resolves to when a
// project's config carries none, or a stale one — the version recorded in the plugin's own package.json (there
// is no vendored VERSION file at plugins/doug-gates itself, only under a project's .doug/hooks).
const installed = JSON.parse(readFileSync(join(scriptsDir, "..", "package.json"), "utf8")).version;

// A fixture that mimics a project's vendored .doug/hooks: the real plugin's scripts/ and lib/ copied under
// <dir>/.doug/hooks, so the script under test resolves `here` (its own directory) to <dir>/.doug/hooks/scripts
// and looks for ../VERSION and ../package.json exactly as it would in a real vendored project.
function makeVendoredFixture() {
  const dir = mkdtempSync(join(tmpdir(), "doug-vendored-"));
  cpSync(scriptsDir, join(dir, ".doug/hooks/scripts"), { recursive: true });
  cpSync(join(scriptsDir, "..", "lib"), join(dir, ".doug/hooks/lib"), { recursive: true });
  return dir;
}

function writeConfigVersion(dir, version) {
  writeFileSync(join(dir, ".doug/config.json"), JSON.stringify({ doug: { name: "Doug", version } }));
}

function run(input, scriptPath = join(scriptsDir, "statusline.mjs")) {
  const env = { ...process.env };
  delete env.CLAUDE_PROJECT_DIR;
  const res = spawnSync(process.execPath, [scriptPath], {
    input: typeof input === "string" ? input : JSON.stringify(input),
    encoding: "utf8",
    cwd: otherDir,
    env,
    timeout: 30000,
  });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

const config = { doug: { name: "Doug", version: "0.1.0" } };
const base = (dir, extra = {}) => ({
  workspace: { current_dir: dir, project_dir: dir },
  model: { id: "claude-opus", display_name: "Opus" },
  context_window: { used_percentage: 8 },
  ...extra,
});

function expectLine(res, line) {
  expect(res.status).toBe(0);
  expect(res.stderr).toBe("");
  expect(res.stdout.trim()).toBe(line);
}

describe("statusline", () => {
  it("prints product, model, branch and context", () => {
    const dir = makeProject({ git: true, config });
    expectLine(run(base(dir)), `Doug ${installed} · Opus · main · ctx 8%`);
  });

  it("rounds a fractional percentage", () => {
    const dir = makeProject({ git: true, config });
    expectLine(run(base(dir, { context_window: { used_percentage: 12.4 } })), `Doug ${installed} · Opus · main · ctx 12%`);
  });

  it("prints ctx -- when context_window is absent or null", () => {
    const dir = makeProject({ git: true, config });
    const noWindow = base(dir);
    delete noWindow.context_window;
    expectLine(run(noWindow), `Doug ${installed} · Opus · main · ctx --`);
    expectLine(run(base(dir, { context_window: { used_percentage: null } })), `Doug ${installed} · Opus · main · ctx --`);
  });

  it("omits the branch outside a git repo", () => {
    const dir = makeProject({ config });
    expectLine(run(base(dir)), `Doug ${installed} · Opus · ctx 8%`);
  });

  it("prints the installed version when there is no config (card statusline-installed-version)", () => {
    const dir = makeProject({ git: true });
    expectLine(run(base(dir)), `Doug ${installed} · Opus · main · ctx 8%`);
  });

  it("omits the model when absent", () => {
    const dir = makeProject({ git: true, config });
    const input = base(dir);
    delete input.model;
    expectLine(run(input), `Doug ${installed} · main · ctx 8%`);
  });

  it("resolves both dirs from legacy top-level cwd", () => {
    const dir = makeProject({ git: true, config });
    const input = base(dir, { cwd: dir });
    delete input.workspace;
    expectLine(run(input), `Doug ${installed} · Opus · main · ctx 8%`);
  });

  it("falls back to Doug on empty, non-JSON, or non-object stdin", () => {
    expectLine(run(""), "Doug");
    expectLine(run("not json"), "Doug");
    expectLine(run("[1,2]"), "Doug");
    expectLine(run("null"), "Doug");
  });

  describe("installed version resolution (card statusline-installed-version)", () => {
    it("S1: config says 0.1.0, and the plugin-tree run prints the installed version, not the stale config one", () => {
      expect(installed).not.toBe("0.1.0");
      const dir = makeProject({ config });
      expectLine(run(base(dir)), `Doug ${installed} · Opus · ctx 8%`);
    });

    it("S2: a vendored VERSION file wins over an older config version", () => {
      const dir = makeVendoredFixture();
      writeFileSync(join(dir, ".doug/hooks/VERSION"), "9.9.9\n");
      writeConfigVersion(dir, "0.1.0");
      expectLine(run(base(dir), join(dir, ".doug/hooks/scripts/statusline.mjs")), "Doug 9.9.9 · Opus · ctx 8%");
    });

    it("S3: no VERSION file falls back to the config version", () => {
      const dir = makeVendoredFixture();
      writeConfigVersion(dir, "0.1.0");
      expectLine(run(base(dir), join(dir, ".doug/hooks/scripts/statusline.mjs")), "Doug 0.1.0 · Opus · ctx 8%");
    });

    it("S4: no VERSION and no config falls back to the bare name", () => {
      const dir = makeVendoredFixture();
      const res = run(base(dir), join(dir, ".doug/hooks/scripts/statusline.mjs"));
      expect(res.status).toBe(0);
      expect(res.stderr).toBe("");
      expect(res.stdout.trim().startsWith("Doug · ")).toBe(true);
    });

    it("S5: a whitespace-only VERSION file is treated as empty, falling back to config", () => {
      const dir = makeVendoredFixture();
      writeFileSync(join(dir, ".doug/hooks/VERSION"), "   \n\t ");
      writeConfigVersion(dir, "0.1.0");
      expectLine(run(base(dir), join(dir, ".doug/hooks/scripts/statusline.mjs")), "Doug 0.1.0 · Opus · ctx 8%");
    });

    it("S6: a package.json with an unrelated name is ignored even with no VERSION file", () => {
      const dir = makeVendoredFixture();
      writeFileSync(join(dir, ".doug/hooks/package.json"), JSON.stringify({ name: "x", version: "7.7.7" }));
      writeConfigVersion(dir, "0.1.0");
      expectLine(run(base(dir), join(dir, ".doug/hooks/scripts/statusline.mjs")), "Doug 0.1.0 · Opus · ctx 8%");
    });

    it("S7: VERSION is read relative to the running script, not the project dir", () => {
      const scriptDir = makeVendoredFixture(); // A: the running script lives under A/.doug/hooks/scripts
      writeFileSync(join(scriptDir, ".doug/hooks/VERSION"), "9.9.9\n");
      const projectDir = makeProject({ config: { doug: { name: "Doug", version: "0.1.0" } } }); // B: a different project dir
      mkdirSync(join(projectDir, ".doug/hooks"), { recursive: true });
      writeFileSync(join(projectDir, ".doug/hooks/VERSION"), "8.8.8\n");
      expectLine(run(base(projectDir), join(scriptDir, ".doug/hooks/scripts/statusline.mjs")), "Doug 9.9.9 · Opus · ctx 8%");
    });
  });

  describe("contextWindow (card context-window-handoff)", () => {
    const enabled = { doug: { name: "Doug", version: "0.1.0" }, contextWindow: { enabled: true, threshold: 80, repeatAfter: 5 } };

    it("records pct and an ISO timestamp into session state when enabled", () => {
      const dir = makeProject({ config: enabled });
      const res = run(base(dir, { session_id: "sess-1", context_window: { used_percentage: 85 } }));
      expect(res.status).toBe(0);
      const state = JSON.parse(readFileSync(statePath(dir, "sess-1"), "utf8"));
      expect(state.context.pct).toBe(85);
      expect(() => new Date(state.context.at).toISOString()).not.toThrow();
    });

    it("writes nothing when contextWindow is disabled (the default)", () => {
      const dir = makeProject({ config: { doug: { name: "Doug", version: "0.1.0" } } });
      run(base(dir, { session_id: "sess-1", context_window: { used_percentage: 85 } }));
      expect(existsSync(statePath(dir, "sess-1"))).toBe(false);
    });

    it("writes nothing without a session_id, even when enabled and pct is present", () => {
      const dir = makeProject({ config: enabled });
      const input = base(dir, { context_window: { used_percentage: 85 } });
      delete input.session_id;
      run(input);
      expect(existsSync(join(dir, ".doug/.state"))).toBe(false);
    });

    it("writes nothing when context_window is null, even when enabled and session_id is present", () => {
      const dir = makeProject({ config: enabled });
      run(base(dir, { session_id: "sess-1", context_window: { used_percentage: null } }));
      expect(existsSync(statePath(dir, "sess-1"))).toBe(false);
    });

    it("marks the segment at and above the threshold, and not below it", () => {
      const dir = makeProject({ config: enabled, git: true });
      expectLine(run(base(dir, { context_window: { used_percentage: 79 } })), `Doug ${installed} · Opus · main · ctx 79%`);
      expectLine(run(base(dir, { context_window: { used_percentage: 80 } })), `Doug ${installed} · Opus · main · ctx 80% compact?`);
      expectLine(run(base(dir, { context_window: { used_percentage: 85 } })), `Doug ${installed} · Opus · main · ctx 85% compact?`);
    });

    it("respects a configured threshold, not the default 80", () => {
      const custom = { doug: { name: "Doug", version: "0.1.0" }, contextWindow: { enabled: true, threshold: 50, repeatAfter: 5 } };
      const dir = makeProject({ config: custom, git: true });
      expectLine(run(base(dir, { context_window: { used_percentage: 49 } })), `Doug ${installed} · Opus · main · ctx 49%`);
      expectLine(run(base(dir, { context_window: { used_percentage: 55 } })), `Doug ${installed} · Opus · main · ctx 55% compact?`);
    });

    it("does not mark the segment when disabled, even over the threshold", () => {
      const dir = makeProject({ config: { doug: { name: "Doug", version: "0.1.0" } }, git: true });
      expectLine(run(base(dir, { context_window: { used_percentage: 95 } })), `Doug ${installed} · Opus · main · ctx 95%`);
    });

    it("(minor 4) a malformed config prints no stderr, falling back exactly as a missing config would", () => {
      const dir = makeProject({ config: {}, git: true }); // makeProject writes valid JSON; overwrite it broken
      writeFileSync(join(dir, ".doug/config.json"), "{ not json");
      expectLine(run(base(dir)), `Doug ${installed} · Opus · main · ctx 8%`);
    });
  });
});
