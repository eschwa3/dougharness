import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

import { detect } from "../src/detect/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const fx = (name: string) => join(here, "fixtures", name);

// Local temp-repo helper, following tests/detect.test.ts's convention: build a throwaway
// repository under a fresh mkdtempSync dir and write files/dirs into it.
function tempRepo(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `doug-detect-py-${prefix}-`));
}

function write(dir: string, rel: string, content: string): void {
  const full = join(dir, rel);
  const parent = dirname(full);
  mkdirSync(parent, { recursive: true });
  writeFileSync(full, content);
}

function mkdir(dir: string, rel: string): void {
  mkdirSync(join(dir, rel), { recursive: true });
}

describe("detectPython: uv project", () => {
  const dir = tempRepo("uv");
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
      'line-length = 100',
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

  const d = detect(dir).python;

  it("picks uv from uv.lock", () => {
    expect(d.present).toBe(true);
    expect(d.manager).toBe("uv");
    expect(d.managerSource).toBe("uv.lock");
    expect(d.lockfile).toBe("uv.lock");
    expect(d.runPrefix).toBe("uv run");
  });

  it("emits every command string, prefixed with uv run where applicable", () => {
    expect(d.commands.install).toBe("uv sync --locked");
    expect(d.commands.test).toBe("uv run pytest");
    expect(d.commands.lint).toBe("uv run ruff check .");
    expect(d.commands.format).toBe("uv run ruff format .");
    expect(d.commands.formatCheck).toBe("uv run ruff format --check .");
    expect(d.commands.typecheck).toBe("uv run mypy src");
  });

  it("emits single-test commands verbatim", () => {
    expect(d.singleTestCommand).toBe("uv run pytest <path/to/test_file.py>");
    expect(d.singleTestNodeIdCommand).toBe("uv run pytest <path/to/test_file.py>::<test_name>");
  });

  it("detects python version, venv, src layout and pytest", () => {
    expect(d.pythonVersion).toBe("3.11.4");
    expect(d.pythonVersionSource).toBe(".python-version");
    expect(d.srcLayout).toBe(true);
    expect(d.testFramework).toBe("pytest");
    expect(d.testConfigFile).toBe("pyproject.toml");
    expect(d.testDirs).toEqual(["tests"]);
    expect(d.linter).toBe("ruff");
    expect(d.typeChecker).toBe("mypy");
    expect(d.typeCheckerConfigFile).toBe("pyproject.toml");
  });
});

describe("detectPython: poetry via [tool.poetry]", () => {
  const dir = tempRepo("poetry-table");
  write(dir, "pyproject.toml", ["[tool.poetry]", 'name = "app"', ""].join("\n"));
  const d = detect(dir).python;
  it("picks poetry from the table", () => {
    expect(d.manager).toBe("poetry");
    expect(d.managerSource).toBe("[tool.poetry] in pyproject.toml");
    expect(d.runPrefix).toBe("poetry run");
    expect(d.commands.install).toBe("poetry install");
  });
});

describe("detectPython: poetry via poetry-core build-system only", () => {
  const dir = tempRepo("poetry-core");
  write(
    dir,
    "pyproject.toml",
    ["[build-system]", 'requires = ["poetry-core>=1.0.0"]', 'build-backend = "poetry.core.masonry.api"', ""].join("\n"),
  );
  const d = detect(dir).python;
  it("picks poetry from poetry-core in build-system requires", () => {
    expect(d.manager).toBe("poetry");
    expect(d.managerSource).toBe("poetry-core in [build-system] requires");
  });
});

describe("detectPython: setuptools with a comment merely mentioning poetry-core", () => {
  const dir = tempRepo("poetry-core-comment-only");
  write(
    dir,
    "pyproject.toml",
    [
      "[build-system]",
      "requires = [",
      '  "setuptools",',
      "  # poetry-core is intentionally not required",
      "]",
      "",
    ].join("\n"),
  );
  const d = detect(dir).python;
  it("does not pick poetry from a commented-out mention", () => {
    expect(d.manager).toBe("pip");
    expect(d.managerSource).toBeNull();
  });
});

describe("detectPython: poetry-core spread across multiple lines with comments", () => {
  const dir = tempRepo("poetry-core-multiline-comment");
  write(
    dir,
    "pyproject.toml",
    [
      "[build-system]",
      "requires = [",
      "  # this project actually uses poetry",
      '  "poetry-core>=1.0.0",',
      "]",
      "",
    ].join("\n"),
  );
  const d = detect(dir).python;
  it("still picks poetry from a real requires entry among comments", () => {
    expect(d.manager).toBe("poetry");
    expect(d.managerSource).toBe("poetry-core in [build-system] requires");
  });
});

describe("detectPython: pdm project", () => {
  const dir = tempRepo("pdm");
  write(dir, "pyproject.toml", ['[project]', 'name = "app"', ""].join("\n"));
  write(dir, "pdm.lock", "# lock\n");
  const d = detect(dir).python;
  it("picks pdm from pdm.lock", () => {
    expect(d.manager).toBe("pdm");
    expect(d.managerSource).toBe("pdm.lock");
    expect(d.runPrefix).toBe("pdm run");
    expect(d.commands.install).toBe("pdm install");
  });
});

describe("detectPython: pipenv project", () => {
  const dir = tempRepo("pipenv");
  write(dir, "Pipfile", "[packages]\n");
  write(dir, "Pipfile.lock", "{}\n");
  const d = detect(dir).python;
  it("picks pipenv from Pipfile.lock", () => {
    expect(d.manager).toBe("pipenv");
    expect(d.managerSource).toBe("Pipfile.lock");
    expect(d.runPrefix).toBe("pipenv run");
    expect(d.commands.install).toBe("pipenv install");
  });
});

describe("detectPython: hatch project suppresses commands", () => {
  const dir = tempRepo("hatch");
  write(
    dir,
    "pyproject.toml",
    [
      "[tool.hatch]",
      "",
      "[tool.ruff]",
      "line-length = 88",
      "",
      "[tool.mypy]",
      "strict = true",
      "",
      "[tool.pytest.ini_options]",
      'testpaths = ["tests"]',
      "",
    ].join("\n"),
  );
  mkdir(dir, "tests");
  write(dir, "tests/test_a.py", "def test_a():\n    assert True\n");
  const d = detect(dir).python;

  it("detects hatch as the manager but proposes no commands", () => {
    expect(d.manager).toBe("hatch");
    expect(d.runPrefix).toBeNull();
    expect(d.commands.install).toBeNull();
    expect(d.commands.test).toBeNull();
    expect(d.commands.lint).toBeNull();
    expect(d.commands.format).toBeNull();
    expect(d.commands.formatCheck).toBeNull();
    expect(d.commands.typecheck).toBeNull();
    expect(d.singleTestCommand).toBeNull();
    expect(d.singleTestNodeIdCommand).toBeNull();
    expect(d.formatter).toBeNull();
  });

  it("still names the tools it found, not the commands to run them", () => {
    expect(d.linter).toBe("ruff");
    expect(d.typeChecker).toBe("mypy");
    expect(d.testFramework).toBe("pytest");
  });

  it("notes that hatch commands were not verified", () => {
    expect(detect(dir).notes.some((n) => /hatch/i.test(n) && /not verified/i.test(n))).toBe(true);
  });
});

describe("detectPython: plain pip project", () => {
  const dir = tempRepo("pip");
  write(dir, "requirements-dev.txt", "pytest\nruff\n");
  write(dir, "requirements.txt", "flask\n");
  const d = detect(dir).python;
  it("falls back to pip and installs the sorted-first requirements file", () => {
    expect(d.manager).toBe("pip");
    expect(d.commands.install).toBe("pip install -r requirements-dev.txt");
  });
  it("still detects pytest and ruff from the dependency lines", () => {
    expect(d.testFramework).toBe("pytest");
    expect(d.linter).toBe("ruff");
  });
});

describe("detectPython: uv wins over poetry, with a note naming both", () => {
  const dir = tempRepo("uv-and-poetry");
  write(dir, "pyproject.toml", ["[tool.poetry]", 'name = "app"', ""].join("\n"));
  write(dir, "uv.lock", "\n");
  write(dir, "poetry.lock", "\n");
  const d = detect(dir).python;
  const notes = detect(dir).notes;
  it("uv wins", () => {
    expect(d.manager).toBe("uv");
    expect(d.managerSource).toBe("uv.lock");
  });
  it("names both markers in a note", () => {
    expect(notes.some((n) => n.includes("poetry.lock") && n.includes("uv.lock"))).toBe(true);
  });
});

describe("detectPython: ruff and black both present emits no black command", () => {
  const dir = tempRepo("ruff-and-black");
  write(dir, "pyproject.toml", ["[tool.ruff]", "line-length = 88", "", "[tool.black]", "line-length = 88", ""].join("\n"));
  const d = detect(dir).python;
  it("uses ruff only", () => {
    expect(d.linter).toBe("ruff");
    expect(d.formatter?.name).toBe("ruff");
    expect(d.commands.lint).toBe("ruff check .");
    expect(d.commands.format).toBe("ruff format .");
    expect(d.commands.formatCheck).toBe("ruff format --check .");
    expect(JSON.stringify(d)).not.toMatch(/black/);
  });
  it("notes the black marker was also found", () => {
    expect(detect(dir).notes.some((n) => /black/i.test(n))).toBe(true);
  });
});

describe("detectPython: black-only project", () => {
  const dir = tempRepo("black-only");
  write(dir, "pyproject.toml", ["[tool.black]", "line-length = 88", ""].join("\n"));
  const d = detect(dir).python;
  it("proposes black commands and no linter", () => {
    expect(d.linter).toBeNull();
    expect(d.commands.lint).toBeNull();
    expect(d.formatter).toEqual({ name: "black", command: "black ." });
    expect(d.commands.format).toBe("black .");
    expect(d.commands.formatCheck).toBe("black --check .");
  });
});

describe("detectPython: Django-style migrations plus alembic", () => {
  const dir = tempRepo("migrations");
  write(dir, "setup.py", "");
  mkdir(dir, "app/migrations");
  write(dir, "app/migrations/__init__.py", "");
  mkdir(dir, "alembic/versions");
  const d = detect(dir).python;
  it("finds both migration directories", () => {
    expect(d.migrationDirs).toEqual(["alembic/versions", "app/migrations"]);
  });
});

describe("detectPython: POSIX venv", () => {
  const dir = tempRepo("venv-posix");
  write(dir, "pyproject.toml", "[project]\n");
  mkdir(dir, ".venv/bin");
  const d = detect(dir).python;
  it("finds .venv/bin", () => {
    expect(d.venvDir).toBe(".venv");
    expect(d.venvBinDir).toBe(".venv/bin");
    expect(d.generatedDirs).toEqual([".venv"]);
  });
});

describe("detectPython: Windows venv", () => {
  const dir = tempRepo("venv-windows");
  write(dir, "pyproject.toml", "[project]\n");
  mkdir(dir, ".venv/Scripts");
  const d = detect(dir).python;
  it("finds .venv/Scripts", () => {
    expect(d.venvDir).toBe(".venv");
    expect(d.venvBinDir).toBe(".venv/Scripts");
    expect(d.generatedDirs).toEqual([".venv"]);
  });
});

describe("detectPython: single-line dependencies array", () => {
  const dir = tempRepo("single-line-deps");
  write(dir, "pyproject.toml", ["[project]", 'name = "app"', 'dependencies = ["pytest", "ruff"]', ""].join("\n"));
  const d = detect(dir).python;
  it("detects pytest and ruff from a single-line array", () => {
    expect(d.testFramework).toBe("pytest");
    expect(d.linter).toBe("ruff");
    expect(d.commands.test).toBe("pytest");
    expect(d.commands.lint).toBe("ruff check .");
    expect(d.commands.format).toBe("ruff format .");
  });
});

describe("detectPython: single-line optional-dependencies group", () => {
  const dir = tempRepo("optional-deps");
  write(
    dir,
    "pyproject.toml",
    [
      "[project]",
      'name = "app"',
      'dependencies = ["flask"]',
      "",
      "[project.optional-dependencies]",
      'dev = ["pytest>=8", "ruff"]',
      "",
    ].join("\n"),
  );
  const d = detect(dir).python;
  it("detects pytest and ruff from the optional-dependencies group", () => {
    expect(d.testFramework).toBe("pytest");
    expect(d.linter).toBe("ruff");
  });
});

describe("detectPython: continuation line with several quoted dependencies", () => {
  const dir = tempRepo("continuation-deps");
  write(dir, "pyproject.toml", ["[project]", 'name = "app"', "dependencies = [", '  "flask", "pytest", "ruff",', "]", ""].join("\n"));
  const d = detect(dir).python;
  it("detects pytest and ruff from a multi-line array", () => {
    expect(d.testFramework).toBe("pytest");
    expect(d.linter).toBe("ruff");
  });
});

describe("detectPython: dependency names only inside a comment", () => {
  const dir = tempRepo("comment-only-deps");
  write(
    dir,
    "pyproject.toml",
    [
      "[project]",
      'name = "app"',
      'dependencies = ["flask"]  # "pytest" "ruff" "black" later',
      '# dev = ["pytest", "ruff"]',
      "",
    ].join("\n"),
  );
  const d = detect(dir).python;
  it("does not detect pytest, ruff or black from commented-out text", () => {
    expect(d.testFramework).toBeNull();
    expect(d.linter).toBeNull();
    expect(d.formatter).toBeNull();
    expect(d.commands.lint).toBeNull();
    expect(d.commands.format).toBeNull();
  });
});

describe("detectPython: generated directories", () => {
  const dir = tempRepo("generated-dirs");
  write(dir, "pyproject.toml", "[project]\n");
  mkdir(dir, "build");
  mkdir(dir, "dist");
  mkdir(dir, "__pycache__");
  mkdir(dir, "app.egg-info");
  write(dir, "notes.egg-info", "not a directory\n");
  const d = detect(dir).python;
  it("finds and sorts the generated directories, excluding the file", () => {
    expect(d.generatedDirs).toEqual(["__pycache__", "app.egg-info", "build", "dist"]);
  });
});

describe("detectPython: bare pytest.ini plus a configured tox.ini", () => {
  const dir = tempRepo("bare-pytest-ini-tox");
  write(dir, "pytest.ini", "; just a comment, no [pytest] section\n");
  write(dir, "tox.ini", "[tox]\nenvlist = py311\n\n[pytest]\naddopts = -q\n");
  write(dir, "pyproject.toml", "[project]\n");
  const d = detect(dir).python;
  it("prefers the configured tox.ini over the bare pytest.ini", () => {
    expect(d.testFramework).toBe("pytest");
    expect(d.testConfigFile).toBe("tox.ini");
  });
});

describe("detectPython: only a bare pytest.ini", () => {
  const dir = tempRepo("bare-pytest-ini-only");
  write(dir, "pytest.ini", "; just a comment, no [pytest] section\n");
  write(dir, "pyproject.toml", "[project]\n");
  const d = detect(dir).python;
  it("uses the bare pytest.ini as the marker", () => {
    expect(d.testFramework).toBe("pytest");
    expect(d.testConfigFile).toBe("pytest.ini");
  });
});

describe("detectPython: malformed pyproject.toml", () => {
  const dir = tempRepo("malformed");
  write(dir, "pyproject.toml", "this is not valid toml {{{ [[[ \r\n\r\n\x00garbage");
  it("does not throw and reports present without crashing", () => {
    expect(() => detect(dir)).not.toThrow();
    const d = detect(dir).python;
    expect(d.present).toBe(true);
  });
});

describe("detectPython: empty pyproject.toml", () => {
  const dir = tempRepo("empty-pyproject");
  write(dir, "pyproject.toml", "");
  it("does not throw and reports the pip fallback with nothing detected", () => {
    expect(() => detect(dir)).not.toThrow();
    const d = detect(dir).python;
    expect(d.present).toBe(true);
    expect(d.manager).toBe("pip");
    expect(d.linter).toBeNull();
    expect(d.typeChecker).toBeNull();
    expect(d.testFramework).toBeNull();
  });
});

describe("detectPython: ts-pnpm fixture has no python", () => {
  const d = detect(fx("ts-pnpm")).python;
  it("reports the empty record", () => {
    expect(d.present).toBe(false);
    expect(d.manager).toBeNull();
    expect(d.managerSource).toBeNull();
    expect(d.lockfile).toBeNull();
    expect(d.runPrefix).toBeNull();
    expect(d.pythonVersion).toBeNull();
    expect(d.pythonVersionSource).toBeNull();
    expect(d.venvDir).toBeNull();
    expect(d.venvBinDir).toBeNull();
    expect(d.commands).toEqual({ install: null, test: null, lint: null, format: null, formatCheck: null, typecheck: null });
    expect(d.testFramework).toBeNull();
    expect(d.testConfigFile).toBeNull();
    expect(d.testDirs).toEqual([]);
    expect(d.singleTestCommand).toBeNull();
    expect(d.singleTestNodeIdCommand).toBeNull();
    expect(d.linter).toBeNull();
    expect(d.formatter).toBeNull();
    expect(d.typeChecker).toBeNull();
    expect(d.typeCheckerConfigFile).toBeNull();
    expect(d.srcLayout).toBe(false);
    expect(d.migrationDirs).toEqual([]);
    expect(d.generatedDirs).toEqual([]);
  });
});
