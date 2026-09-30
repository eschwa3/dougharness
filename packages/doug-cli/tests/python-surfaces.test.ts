import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

import { detect } from "../src/detect/index.js";
import { generateConfig } from "../src/generate/config.js";
import { generateSkills } from "../src/generate/skills.js";
import { generateAgents } from "../src/generate/agents.js";
import { buildProposal, summarize } from "../src/generate/proposal.js";

const here = dirname(fileURLToPath(import.meta.url));
const tsPnpm = join(here, "fixtures", "ts-pnpm");

// Throwaway-repository helper, following tests/python-config.test.ts's convention: no child process,
// no network, everything built from fixture files under a fresh mkdtempSync dir.
function tempRepo(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `doug-python-surfaces-${prefix}-`));
}

function write(dir: string, rel: string, content: string): void {
  const full = join(dir, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

function mkdir(dir: string, rel: string): void {
  mkdirSync(join(dir, rel), { recursive: true });
}

function byPath(files: { path: string; content: string }[]) {
  return Object.fromEntries(files.map((f) => [f.path, f.content]));
}

function uvFullRepo(): string {
  const dir = tempRepo("uv-full");
  write(
    dir,
    "pyproject.toml",
    [
      "[project]",
      'name = "app"',
      'requires-python = ">=3.11"',
      "",
      "[tool.uv]",
      "managed = true",
      "",
      "[tool.ruff]",
      "line-length = 100",
      "",
      "[tool.mypy]",
      "strict = true",
      "",
      "[tool.pytest.ini_options]",
      'testpaths = ["tests"]',
      "",
    ].join("\n"),
  );
  write(dir, "uv.lock", "# lockfile\n");
  mkdir(dir, "src/app");
  write(dir, "src/app/main.py", "print('hi')\n");
  mkdir(dir, "tests");
  write(dir, "tests/test_main.py", "def test_ok():\n    assert True\n");
  return dir;
}

describe("generateSkills / generateAgents / summarize: uv + pytest + ruff + mypy", () => {
  const dir = uvFullRepo();
  const d = detect(dir);
  const cfg = generateConfig(d);
  expect(d.python.present).toBe(true);

  it("proposes the expected set of generated skill paths", () => {
    const files = generateSkills(d, cfg);
    expect(files.map((f) => f.path)).toEqual([
      ".claude/skills/test/SKILL.md",
      ".claude/skills/preflight/SKILL.md",
      ".claude/skills/preflight/scripts/preflight.sh",
      ".claude/skills/characterization-test/SKILL.md",
      ".claude/skills/doug-skills/SKILL.md",
    ]);
  });

  it("the test skill's command is the uv test command", () => {
    const files = byPath(generateSkills(d, cfg));
    expect(cfg.commands.test).toBe("uv run pytest");
    expect(files[".claude/skills/test/SKILL.md"]).toContain("uv run pytest");
  });

  it("the characterization-test skill names pytest and carries the single-test command", () => {
    const files = byPath(generateSkills(d, cfg));
    const content = files[".claude/skills/characterization-test/SKILL.md"];
    expect(content).toContain("Writes a characterization test with pytest that pins current behavior");
    expect(content).toContain(d.python.singleTestCommand as string);
  });

  it("the preflight script lists the Python gate commands in the config's stop-gate order", () => {
    const files = byPath(generateSkills(d, cfg));
    const script = files[".claude/skills/preflight/scripts/preflight.sh"];
    const gateCommands = cfg.stopGate.commands.map((name) => cfg.commands[name]);
    let lastIdx = -1;
    for (const c of gateCommands) {
      const idx = script.indexOf(c);
      expect(idx).toBeGreaterThan(lastIdx);
      lastIdx = idx;
    }
  });

  it("no allowed-tools entry contains a < placeholder", () => {
    const files = generateSkills(d, cfg);
    for (const f of files) {
      if (!f.path.endsWith("SKILL.md")) continue;
      const line = f.content.split("\n").find((l) => l.startsWith("allowed-tools:"));
      expect(line, f.path).toBeDefined();
      expect(line, f.path).not.toContain("<");
    }
  });

  it("the tester agent exists and quotes the Python single-test command", () => {
    const files = byPath(generateAgents(d, cfg));
    expect(files[".claude/agents/tester.md"]).toBeDefined();
    expect(files[".claude/agents/tester.md"]).toContain(d.python.singleTestCommand as string);
  });

  it("summarize prints the four python rows with the right values", () => {
    const p = buildProposal(d);
    const summary = summarize(p);
    expect(summary).toMatch(new RegExp(`python manager\\s+uv \\(${d.python.managerSource}\\)`));
    expect(summary).toMatch(/python test\s+uv run pytest/);
    expect(summary).toMatch(/python lint\s+uv run ruff check \./);
    expect(summary).toMatch(/python typecheck\s+uv run mypy src/);
  });
});

describe("generateSkills: only Python migration directories", () => {
  const dir = tempRepo("py-migrations");
  write(dir, "pyproject.toml", ["[project]", 'name = "app"', "", "[tool.uv]", "managed = true", ""].join("\n"));
  write(dir, "uv.lock", "# lockfile\n");
  write(dir, "app/migrations/__init__.py", "");

  const d = detect(dir);
  const cfg = generateConfig(d);

  it("has no repo migration dirs but a python one", () => {
    expect(d.repo.migrationDirs).toEqual([]);
    expect(d.python.migrationDirs).toEqual(["app/migrations"]);
  });

  it("generates the migrate skill naming the python migration directory", () => {
    const files = byPath(generateSkills(d, cfg));
    expect(files[".claude/skills/migrate/SKILL.md"]).toContain("app/migrations");
  });
});

describe("generateAgents: python-only repository", () => {
  const dir = tempRepo("python-only-tester");
  write(dir, "pyproject.toml", ["[project]", 'name = "app"', "", "[tool.uv]", "managed = true", ""].join("\n"));
  write(dir, "uv.lock", "# lockfile\n");
  mkdir(dir, "tests");
  write(dir, "tests/test_main.py", "def test_ok():\n    assert True\n");

  const d = detect(dir);
  const cfg = generateConfig(d);

  it("has no node test framework but a python one", () => {
    expect(d.node.testFramework).toBeNull();
    expect(d.python.testFramework).toBe("pytest");
  });

  it("proposes a tester agent quoting the python single-test command", () => {
    const files = byPath(generateAgents(d, cfg));
    expect(files[".claude/agents/tester.md"]).toBeDefined();
    expect(files[".claude/agents/tester.md"]).toContain(d.python.singleTestCommand as string);
  });
});

describe("generateSkills: node-only repo with two migration dirs keeps detector order", () => {
  const dir = tempRepo("node-two-migrations");
  write(dir, "package.json", JSON.stringify({ name: "app", scripts: { test: "vitest run" } }));
  mkdir(dir, "prisma/migrations");
  mkdir(dir, "migrations");

  const d = detect(dir);
  const cfg = generateConfig(d);

  it("does not sort a python-absent repo's migration directories", () => {
    expect(d.python.present).toBe(false);
    expect(d.repo.migrationDirs).toEqual(["prisma/migrations", "migrations"]);
    const files = byPath(generateSkills(d, cfg));
    expect(files[".claude/skills/migrate/SKILL.md"]).toContain(
      "List migration directories: prisma/migrations, migrations.",
    );
  });
});

describe("generateSkills: mixed Node+Python migration dirs are sorted and de-duplicated", () => {
  const dir = tempRepo("mixed-migrations");
  write(dir, "package.json", JSON.stringify({ name: "app", scripts: { test: "vitest run" } }));
  mkdir(dir, "prisma/migrations");
  write(dir, "pyproject.toml", ["[project]", 'name = "app"', "", "[tool.uv]", "managed = true", ""].join("\n"));
  write(dir, "uv.lock", "# lockfile\n");
  write(dir, "app/migrations/__init__.py", "");

  const d = detect(dir);
  const cfg = generateConfig(d);

  it("lists the union of migration directories, sorted and de-duplicated", () => {
    expect(d.python.present).toBe(true);
    expect(d.repo.migrationDirs.length).toBeGreaterThan(0);
    expect(d.python.migrationDirs.length).toBeGreaterThan(0);

    const expectedDirs = [...new Set([...d.repo.migrationDirs, ...d.python.migrationDirs])].sort();

    const files = byPath(generateSkills(d, cfg));
    const skillContent = files[".claude/skills/migrate/SKILL.md"];
    const skillLine = skillContent.split("\n").find((l) => l.includes("List migration directories:")) as string;
    const skillDirs = skillLine
      .trim()
      .replace(/^\d+\.\s*/, "")
      .replace("List migration directories: ", "")
      .replace(/\.$/, "")
      .split(", ");

    expect(skillDirs).toEqual(expectedDirs);
  });
});

describe("summarize: plain pip repository with no manager source", () => {
  const dir = tempRepo("plain-pip");
  write(dir, "requirements.txt", "flask\n");

  const d = detect(dir);

  it("prints the manager without a null source", () => {
    expect(d.python.present).toBe(true);
    expect(d.python.manager).toBe("pip");
    expect(d.python.managerSource).toBeNull();
    const p = buildProposal(d);
    const summary = summarize(p);
    expect(summary).not.toContain("null");
    expect(summary).toMatch(/python manager\s+pip/);
  });
});

describe("summarize: ts-pnpm fixture (no python)", () => {
  it("prints none of the four python rows", () => {
    const d = detect(tsPnpm);
    const p = buildProposal(d);
    expect(d.python.present).toBe(false);
    const summary = summarize(p);
    expect(summary).not.toContain("python manager");
    expect(summary).not.toContain("python test");
    expect(summary).not.toContain("python lint");
    expect(summary).not.toContain("python typecheck");
  });
});

describe("generateSkills / generateAgents: ts-pnpm fixture is byte-identical to the pre-python behavior", () => {
  const d = detect(tsPnpm);
  const cfg = generateConfig(d);

  it("generated skill files carry no Python string and the full skill path set is unchanged", () => {
    const files = generateSkills(d, cfg);
    expect(files.map((f) => f.path)).toEqual([
      ".claude/skills/test/SKILL.md",
      ".claude/skills/migrate/SKILL.md",
      ".claude/skills/pr/SKILL.md",
      ".claude/skills/preflight/SKILL.md",
      ".claude/skills/preflight/scripts/preflight.sh",
      ".claude/skills/characterization-test/SKILL.md",
      ".claude/skills/doug-skills/SKILL.md",
    ]);
    for (const f of files) {
      expect(f.content, f.path).not.toMatch(/[Pp]ython/);
    }
  });

  it("generated agent files carry no Python string and the full agent path set is unchanged", () => {
    const files = generateAgents(d, cfg);
    expect(files.map((f) => f.path)).toEqual([
      ".claude/agents/coder.md",
      ".claude/agents/architect.md",
      ".claude/agents/reviewer.md",
      ".claude/agents/researcher.md",
      ".claude/agents/tester.md",
    ]);
    for (const f of files) {
      expect(f.content, f.path).not.toMatch(/[Pp]ython/);
    }
  });
});
