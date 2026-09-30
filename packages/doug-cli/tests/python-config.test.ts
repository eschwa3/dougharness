import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

import { detect } from "../src/detect/index.js";
import { generateConfig } from "../src/generate/config.js";
import { generateClaudeMd } from "../src/generate/claude-md.js";
import { mergeSettings } from "../src/generate/settings.js";

// Throwaway-repository helper, following tests/detect-python.test.ts's convention: no child process,
// no network, everything built from fixture files under a fresh mkdtempSync dir.
function tempRepo(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `doug-python-config-${prefix}-`));
}

function write(dir: string, rel: string, content: string): void {
  const full = join(dir, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

function mkdir(dir: string, rel: string): void {
  mkdirSync(join(dir, rel), { recursive: true });
}

describe("generateConfig / generateClaudeMd / mergeSettings: uv + pytest + ruff + mypy", () => {
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
  write(dir, ".python-version", "3.11.4\n");
  mkdir(dir, "src/app");
  write(dir, "src/app/main.py", "print('hi')\n");
  mkdir(dir, "tests");
  write(dir, "tests/test_main.py", "def test_ok():\n    assert True\n");
  // Migration dirs: alembic/versions (no __init__.py needed) and a Django-style app migrations dir.
  mkdir(dir, "alembic/versions");
  write(dir, "app/migrations/__init__.py", "");
  // Generated/cache dirs.
  mkdir(dir, ".venv");
  mkdir(dir, "__pycache__");
  mkdir(dir, ".pytest_cache");
  mkdir(dir, ".mypy_cache");
  mkdir(dir, ".ruff_cache");

  const d = detect(dir);
  const cfg = generateConfig(d);
  const md = generateClaudeMd(d, cfg);

  it("builds the exact command map from python alone", () => {
    expect(cfg.commands).toEqual({
      install: "uv sync --locked",
      test: "uv run pytest",
      lint: "uv run ruff check .",
      typecheck: "uv run mypy src",
      format: "uv run ruff format --check .",
    });
  });

  it("orders the stop gate typecheck, lint, test", () => {
    expect(cfg.stopGate.commands).toEqual(["typecheck", "lint", "test"]);
  });

  it("protects .env, .env.*, the lockfile, migration globs and cache/venv globs", () => {
    expect(cfg.protectedPaths).toContain(".env");
    expect(cfg.protectedPaths).toContain(".env.*");
    expect(cfg.protectedPaths).toContain("uv.lock");
    expect(cfg.protectedPaths).toContain("alembic/versions/**");
    expect(cfg.protectedPaths).toContain("app/migrations/**");
    expect(cfg.protectedPaths).toContain(".venv/**");
    expect(cfg.protectedPaths).toContain("__pycache__/**");
    expect(cfg.protectedPaths).toContain(".pytest_cache/**");
    expect(cfg.protectedPaths).toContain(".mypy_cache/**");
    expect(cfg.protectedPaths).toContain(".ruff_cache/**");
  });

  it("gains the python lockfile in stopGate.ignoreChangedPaths", () => {
    expect(cfg.stopGate.ignoreChangedPaths).toContain("uv.lock");
  });

  it("carries manager, single-test, version and migration anchor lines", () => {
    expect(cfg.anchor).toContain("Use uv for Python installs and runs. Never mix Python package managers.");
    expect(cfg.anchor).toContain("Run a single Python test file with: uv run pytest <path/to/test_file.py>");
    expect(cfg.anchor).toContain("Python 3.11.4 (.python-version).");
    expect(cfg.anchor).toContain("Never hand-edit alembic/versions, app/migrations; generate migrations with the project's tool.");
  });

  it("adds the single-test permission", () => {
    const merged = mergeSettings({} as any, d, cfg) as any;
    expect(merged.permissions.allow).toContain("Bash(uv run pytest *)");
  });

  it("CLAUDE.md contains the single-test line and the manager, ruff and mypy bullets", () => {
    expect(md).toContain("uv run pytest <path/to/test_file.py>");
    expect(md).toContain("single Python test file");
    expect(md).toMatch(/Python package manager is \*\*uv\*\*/);
    expect(md).toContain("ruff replaces black, isort and flake8 here; do not add them.");
    expect(md).toMatch(/Type-checked with mypy/);
  });
});

describe("generateConfig: both a package.json and a pyproject.toml", () => {
  const dir = tempRepo("both-stacks");
  write(dir, "pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
  write(
    dir,
    "package.json",
    JSON.stringify(
      {
        name: "app",
        scripts: { test: "vitest run", lint: "eslint .", typecheck: "tsc --noEmit" },
        devDependencies: { vitest: "^2.0.0", eslint: "^9.0.0" },
      },
      null,
      2,
    ),
  );
  write(
    dir,
    "pyproject.toml",
    ["[project]", 'name = "app"', "", "[tool.uv]", "managed = true", "", "[tool.ruff]", "line-length = 100", "", "[tool.pytest.ini_options]", 'testpaths = ["tests"]', ""].join("\n"),
  );
  write(dir, "uv.lock", "# lockfile\n");
  mkdir(dir, "tests");
  write(dir, "tests/test_main.py", "def test_ok():\n    assert True\n");

  const d = detect(dir);
  const cfg = generateConfig(d);

  it("keeps the Node plain keys and puts the Python ones under py:", () => {
    expect(cfg.commands.test).toBe("pnpm test");
    expect(cfg.commands.lint).toBe("pnpm lint");
    expect(cfg.commands.typecheck).toBe("pnpm typecheck");
    expect(cfg.commands["py:test"]).toBe("uv run pytest");
    expect(cfg.commands["py:lint"]).toBe("uv run ruff check .");
    expect(cfg.commands["py:typecheck"]).toBeUndefined();
  });

  it("lists both stacks' keys in the stop gate", () => {
    expect(cfg.stopGate.commands).toEqual(["typecheck", "lint", "test", "py:lint", "py:test"]);
  });
});

describe("generateConfig: Node has lint only (no typecheck script), Python has mypy and ruff", () => {
  const dir = tempRepo("lint-only");
  write(dir, "pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
  write(
    dir,
    "package.json",
    JSON.stringify(
      {
        name: "app",
        scripts: { lint: "eslint ." },
        devDependencies: { eslint: "^9.0.0" },
      },
      null,
      2,
    ),
  );
  write(
    dir,
    "pyproject.toml",
    ["[project]", 'name = "app"', "", "[tool.ruff]", "line-length = 100", "", "[tool.mypy]", "strict = true", ""].join("\n"),
  );

  const d = detect(dir);
  const cfg = generateConfig(d);

  it("gives Python the plain typecheck key (Node has none) and py:lint (Node already has lint)", () => {
    expect(cfg.commands.lint).toBe("pnpm lint");
    expect(cfg.commands.typecheck).toBe("mypy .");
    expect(cfg.commands["py:lint"]).toBe("ruff check .");
  });

  it("keeps the Node ordering (lint alone, no typecheck of its own) then appends Python's typecheck and py:lint", () => {
    expect(cfg.stopGate.commands).toEqual(["lint", "typecheck", "py:lint"]);
  });
});

describe("generateConfig: Node has a tsc build script but no typecheck script, Python has mypy", () => {
  const dir = tempRepo("tsc-build-only");
  write(dir, "pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
  write(
    dir,
    "package.json",
    JSON.stringify(
      {
        name: "app",
        scripts: { build: "tsc" },
        devDependencies: { typescript: "^5.0.0" },
      },
      null,
      2,
    ),
  );
  write(dir, "tsconfig.json", "{}\n");
  write(dir, "mypy.ini", "[mypy]\nstrict = True\n");
  write(dir, "pyproject.toml", ["[project]", 'name = "app"', ""].join("\n"));

  const d = detect(dir);
  const cfg = generateConfig(d);

  it("keeps build as the only Node type check and adds Python's typecheck after it", () => {
    expect(cfg.stopGate.commands).toEqual(["build", "typecheck"]);
  });
});

describe("generateConfig: poetry repository", () => {
  const dir = tempRepo("poetry");
  write(
    dir,
    "pyproject.toml",
    ["[tool.poetry]", 'name = "app"', 'version = "0.1.0"', "", "[tool.poetry.dependencies]", 'python = "^3.11"', ""].join("\n"),
  );
  write(dir, "poetry.lock", "# lockfile\n");
  mkdir(dir, "tests");
  write(dir, "tests/test_main.py", "def test_ok():\n    assert True\n");

  const d = detect(dir);
  const cfg = generateConfig(d);

  it("reads poetry run commands", () => {
    expect(cfg.commands.install).toBe("poetry install");
    expect(cfg.commands.test).toBe("poetry run pytest");
  });
});

describe("generateConfig: black-only repository", () => {
  const dir = tempRepo("black");
  write(dir, "pyproject.toml", ["[project]", 'name = "app"', "", "[tool.black]", "line-length = 88", ""].join("\n"));

  const d = detect(dir);
  const cfg = generateConfig(d);

  it("uses black --check . for the format key and never mentions ruff", () => {
    expect(cfg.commands.format).toBe("black --check .");
    expect(JSON.stringify(cfg.commands)).not.toMatch(/ruff/);
  });
});

describe("generateConfig / generateClaudeMd: ts-pnpm fixture is untouched by python.present === false", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const fixture = join(here, "fixtures", "ts-pnpm");
  const d = detect(fixture);
  const cfg = generateConfig(d);
  const md = generateClaudeMd(d, cfg);

  it("has no python signal", () => {
    expect(d.python.present).toBe(false);
  });

  it("emits no python/uv/pytest strings anywhere in the generated config or CLAUDE.md", () => {
    const cfgText = JSON.stringify(cfg);
    expect(cfgText.toLowerCase()).not.toContain("python");
    expect(cfgText).not.toContain("uv ");
    expect(cfgText).not.toContain("pytest");
    expect(md.toLowerCase()).not.toContain("python");
    expect(md).not.toContain("uv ");
    expect(md).not.toContain("pytest");
  });
});
