import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, cpSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";

import { detect } from "../src/detect/index.js";
import { buildProposal, summarize } from "../src/generate/proposal.js";
import { applyChanges } from "../src/apply.js";

// End-to-end test for the py-uv fixture: proves doug init proposes and writes the whole Python stack
// pack for a uv + pytest + ruff + mypy project in src layout. Follows tests/proposal.test.ts's
// convention: copy the fixture into a mkdtempSync dir, then call the same functions runInit calls
// (detect, buildProposal, applyChanges) and assert on what landed on disk. Never spawns a child
// process and never runs python, uv, pytest, ruff or mypy against the fixture.

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, "fixtures", "py-uv");

function copyFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "doug-python-init-"));
  cpSync(fixture, dir, { recursive: true });
  return dir;
}

describe("py-uv fixture: detect()", () => {
  const dir = copyFixture();
  const d = detect(dir);

  it("identifies uv, pytest, ruff and mypy with the exact strings", () => {
    expect(d.python.present).toBe(true);
    expect(d.python.manager).toBe("uv");
    expect(d.python.lockfile).toBe("uv.lock");
    expect(d.python.runPrefix).toBe("uv run");
    expect(d.python.testFramework).toBe("pytest");
    expect(d.python.linter).toBe("ruff");
    expect(d.python.typeChecker).toBe("mypy");
  });

  it("finds the src layout, venv bin dir, migration dir and python version", () => {
    expect(d.python.srcLayout).toBe(true);
    expect(d.python.venvBinDir).toBe(".venv/bin");
    expect(d.python.migrationDirs).toContain("alembic/versions");
    expect(d.python.pythonVersion).toBe("3.11.4");
  });
});

describe("py-uv fixture: buildProposal + applyChanges", () => {
  const dir = copyFixture();
  const d = detect(dir);
  const p = buildProposal(d);
  applyChanges(dir, p.changes);

  const cfg = JSON.parse(readFileSync(join(dir, ".doug/config.json"), "utf8"));

  it("writes the exact python command map", () => {
    expect(cfg.commands.install).toBe("uv sync --locked");
    expect(cfg.commands.test).toBe("uv run pytest");
    expect(cfg.commands.lint).toBe("uv run ruff check .");
    expect(cfg.commands.format).toBe("uv run ruff format --check .");
    expect(cfg.commands.typecheck).toBe("uv run mypy src");
  });

  it("wires the stop gate in the config task's defined order", () => {
    expect(cfg.stopGate.commands).toEqual(["typecheck", "lint", "test"]);
  });

  it("protects .env, .env.*, uv.lock, alembic/versions/** and .venv/**", () => {
    for (const p2 of [".env", ".env.*", "uv.lock", "alembic/versions/**", ".venv/**"]) {
      expect(cfg.protectedPaths).toContain(p2);
    }
  });

  it("proposes no Node command at all: no pnpm or npm anywhere in commands or stopGate.commands", () => {
    const commandsText = JSON.stringify(cfg.commands);
    expect(commandsText).not.toContain("pnpm");
    expect(commandsText).not.toContain("npm");
    const gateText = JSON.stringify(cfg.stopGate.commands);
    expect(gateText).not.toContain("pnpm");
    expect(gateText).not.toContain("npm");
  });

  it("CLAUDE.md names uv, the single-test command, ruff and mypy, and no Node strings", () => {
    const md = readFileSync(join(dir, "CLAUDE.md"), "utf8");
    expect(md).toContain("uv");
    expect(md).toContain("uv run pytest <path/to/test_file.py>");
    expect(md).toContain("ruff");
    expect(md).toContain("mypy");
    expect(md).not.toContain("npm");
    expect(md).not.toContain("pnpm");
    expect(md).not.toContain("vitest");
  });

  it("settings.json permissions.allow contains the uv pytest Bash rule", () => {
    const settings = JSON.parse(readFileSync(join(dir, ".claude/settings.json"), "utf8"));
    expect(settings.permissions.allow).toContain("Bash(uv run pytest *)");
  });

  it("writes exactly the skills the surfaces generator proposes for this fixture", () => {
    const expected = new Set([
      "test",
      "migrate",
      "preflight",
      "characterization-test",
      "doug-skills",
      ...(d.repo.isGit ? ["pr"] : []),
    ]);
    const skillPaths = p.changes.map((c) => c.path).filter((path) => path.startsWith(".claude/skills/") && path.endsWith("SKILL.md"));
    const names = new Set(skillPaths.map((path) => path.split("/")[2]));
    expect(names).toEqual(expected);
    for (const name of names) {
      expect(readFileSync(join(dir, `.claude/skills/${name}/SKILL.md`), "utf8").length).toBeGreaterThan(0);
    }
  });

  it("writes a tester agent quoting the python single-test command", () => {
    const tester = readFileSync(join(dir, ".claude/agents/tester.md"), "utf8");
    expect(tester).toContain(d.python.singleTestCommand as string);
  });

  it("summarize prints the python manager, test, lint and typecheck rows", () => {
    const summary = summarize(p);
    expect(summary).toMatch(/python manager\s+uv/);
    expect(summary).toMatch(/python test\s+uv run pytest/);
    expect(summary).toMatch(/python lint\s+uv run ruff check \./);
    expect(summary).toMatch(/python typecheck\s+uv run mypy src/);
  });
});
