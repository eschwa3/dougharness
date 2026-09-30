import type { PythonDetection, PythonManager } from "./types.js";
import { exists, isDir, listDir, readText } from "./fs.js";

const REQUIREMENTS_RE = /^requirements.*\.txt$/;
const GENERATED_CANDIDATES = [".venv", "venv", "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache", "build", "dist"];
const SKIP_DIR_NAMES = new Set([".git", "node_modules", ".venv", "__pycache__"]);

function rootRequirementsFiles(dir: string): string[] {
  return listDir(dir).filter((f) => REQUIREMENTS_RE.test(f));
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Strips a "# ..." comment from a line, ignoring "#" that appears inside a quoted
// string (single or double). Not a TOML parser: only tracks quote state char by char,
// enough to keep "poetry-core" out of a trailing comment while leaving quoted values
// (which never contain "#" in practice here) untouched.
function stripLineComment(line: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (ch === "#" && !inSingle && !inDouble) return line.slice(0, i);
  }
  return line;
}

// Table-header match that also allows a dotted sub-table, e.g. "tool.ruff" matches
// both "[tool.ruff]" and "[tool.ruff.lint]". Line-anchored, tolerant of CRLF.
function hasTableHeader(text: string, dotted: string): boolean {
  const re = new RegExp(`^\\s*\\[${escapeRegExp(dotted)}(\\..+)?\\]\\s*\\r?$`, "m");
  return re.test(text);
}

// Exact table/section header match, no sub-table allowed.
function hasExactHeader(text: string | null, header: string): boolean {
  if (!text) return false;
  const re = new RegExp(`^\\s*\\[${escapeRegExp(header)}\\]\\s*\\r?$`, "m");
  return re.test(text);
}

// Returns the body of a top-level table (everything up to the next "[" header, or EOF).
// This is a line-anchored substring scan, not a TOML parser: it is only used to look for
// a literal marker (e.g. "poetry-core") inside a section, never to parse structured data.
function sectionBody(text: string, header: string): string | null {
  const re = new RegExp(`\\[${escapeRegExp(header)}\\]\\s*([\\s\\S]*?)(?=\\r?\\n\\s*\\[|$)`);
  const m = text.match(re);
  return m ? m[1] : null;
}

// Looks for `name` as a dependency entry: a quoted list item at the start of a line
// ("ruff>=0.4"), a poetry-style key/value line (ruff = "^0.4"), or a quoted token
// anywhere in a single-line TOML array (dependencies = ["pytest", "ruff"]). Not a TOML
// parser; a line-anchored scan, comment-stripped before the array scan.
function depMention(text: string, name: string): boolean {
  const escaped = escapeRegExp(name);
  const quoted = new RegExp(`^\\s*["']${escaped}(?:[^a-zA-Z0-9_-]|$)`);
  const assign = new RegExp(`^\\s*${escaped}\\s*=`);
  const boundary = new RegExp(`^${escaped}(?:[^a-zA-Z0-9_-]|$)`);
  return text.split(/\r?\n/).some((l) => {
    if (quoted.test(l) || assign.test(l)) return true;
    const stripped = stripLineComment(l);
    if (!/^\s*["']/.test(stripped) && !/=\s*\[/.test(stripped)) return false;
    const tokenRe = /"([^"]*)"|'([^']*)'/g;
    let m: RegExpExecArray | null;
    while ((m = tokenRe.exec(stripped))) {
      const token = m[1] ?? m[2] ?? "";
      if (boundary.test(token)) return true;
    }
    return false;
  });
}

function reqMention(lines: string[], name: string): boolean {
  const re = new RegExp(`^\\s*${escapeRegExp(name)}(?:[=<>!~\\s]|$)`);
  return lines.some((l) => re.test(l));
}

function reqFilesHaveDependency(dir: string, reqFiles: string[], name: string): boolean {
  for (const f of reqFiles) {
    const text = readText(dir, f);
    if (!text) continue;
    if (reqMention(text.split(/\r?\n/), name)) return true;
  }
  return false;
}

function dirHasPytestFile(dir: string, rel: string): boolean {
  if (!isDir(dir, rel)) return false;
  return listDir(dir, rel).some((f) => /^test_.*\.py$/.test(f) || /_test\.py$/.test(f));
}

function srcLayoutOk(dir: string): boolean {
  if (!isDir(dir, "src")) return false;
  return listDir(dir, "src").some((e) => isDir(dir, `src/${e}`) || e.endsWith(".py"));
}

// Migration directories: "migrations" folders that carry an __init__.py, searched at most
// two levels below the repository root and, separately, at most two levels below src/.
function collectMigrationDirs(root: string, startRel: string, maxDepth: number, out: Set<string>): void {
  const walk = (rel: string, depth: number) => {
    for (const entry of listDir(root, rel)) {
      if (entry.startsWith(".") || SKIP_DIR_NAMES.has(entry)) continue;
      const childRel = rel === "." ? entry : `${rel}/${entry}`;
      if (!isDir(root, childRel)) continue;
      if (entry === "migrations" && exists(root, `${childRel}/__init__.py`)) out.add(childRel);
      if (depth + 1 < maxDepth) walk(childRel, depth + 1);
    }
  };
  walk(startRel, 0);
}

const RUN_PREFIX: Record<PythonManager, string | null> = {
  uv: "uv run",
  poetry: "poetry run",
  pdm: "pdm run",
  pipenv: "pipenv run",
  hatch: null,
  pip: null,
};

export function detectPython(dir: string, notes: string[]): PythonDetection {
  const reqFiles = rootRequirementsFiles(dir);
  const hasPyproject = exists(dir, "pyproject.toml");
  const hasSetupPy = exists(dir, "setup.py");
  const hasSetupCfg = exists(dir, "setup.cfg");
  const hasPipfile = exists(dir, "Pipfile");
  const hasUvLock = exists(dir, "uv.lock");
  const hasPoetryLock = exists(dir, "poetry.lock");
  const hasPdmLock = exists(dir, "pdm.lock");
  const hasPipfileLock = exists(dir, "Pipfile.lock");

  const present =
    hasPyproject || hasSetupPy || hasSetupCfg || hasPipfile || hasUvLock || hasPoetryLock || hasPdmLock || hasPipfileLock || reqFiles.length > 0;

  const empty: PythonDetection = {
    present: false,
    manager: null,
    managerSource: null,
    lockfile: null,
    runPrefix: null,
    pythonVersion: null,
    pythonVersionSource: null,
    venvDir: null,
    venvBinDir: null,
    commands: { install: null, test: null, lint: null, format: null, formatCheck: null, typecheck: null },
    testFramework: null,
    testConfigFile: null,
    testDirs: [],
    singleTestCommand: null,
    singleTestNodeIdCommand: null,
    linter: null,
    formatter: null,
    typeChecker: null,
    typeCheckerConfigFile: null,
    srcLayout: false,
    migrationDirs: [],
    generatedDirs: [],
  };
  if (!present) return empty;

  const pyproject = readText(dir, "pyproject.toml") ?? "";
  const setupCfg = readText(dir, "setup.cfg");
  const toxIni = readText(dir, "tox.ini");
  const pytestIni = readText(dir, "pytest.ini");
  const dotPytestIni = readText(dir, ".pytest.ini");

  // Manager precedence (uv > poetry > pdm > pipenv > hatch > pip) is project policy, not a
  // documented rule from any of these tools.
  const buildSystemBody = sectionBody(pyproject, "build-system");
  const requiresMatch = buildSystemBody ? buildSystemBody.match(/^\s*requires\s*=\s*\[([^\]]*)\]/m) : null;
  const requiresWithoutComments = requiresMatch
    ? requiresMatch[1]
        .split("\n")
        .map((line) => stripLineComment(line))
        .join("\n")
    : "";
  const poetryCore = !!requiresMatch && /poetry-core/.test(requiresWithoutComments);
  const poetryTable = hasTableHeader(pyproject, "tool.poetry");
  const hatchToml = exists(dir, "hatch.toml");
  const hatchTable = hasTableHeader(pyproject, "tool.hatch");

  type Candidate = { manager: PythonManager; matched: boolean; source: string | null; lockfile: string | null };
  const candidates: Candidate[] = [
    {
      manager: "uv",
      matched: hasUvLock || hasTableHeader(pyproject, "tool.uv"),
      source: hasUvLock ? "uv.lock" : hasTableHeader(pyproject, "tool.uv") ? "[tool.uv] in pyproject.toml" : null,
      lockfile: hasUvLock ? "uv.lock" : null,
    },
    {
      manager: "poetry",
      matched: hasPoetryLock || poetryTable || poetryCore,
      source: hasPoetryLock
        ? "poetry.lock"
        : poetryTable
          ? "[tool.poetry] in pyproject.toml"
          : poetryCore
            ? "poetry-core in [build-system] requires"
            : null,
      lockfile: hasPoetryLock ? "poetry.lock" : null,
    },
    { manager: "pdm", matched: hasPdmLock, source: hasPdmLock ? "pdm.lock" : null, lockfile: hasPdmLock ? "pdm.lock" : null },
    {
      manager: "pipenv",
      matched: hasPipfileLock || hasPipfile,
      source: hasPipfileLock ? "Pipfile.lock" : hasPipfile ? "Pipfile" : null,
      lockfile: hasPipfileLock ? "Pipfile.lock" : null,
    },
    {
      manager: "hatch",
      matched: hatchToml || hatchTable,
      source: hatchToml ? "hatch.toml" : hatchTable ? "[tool.hatch] in pyproject.toml" : null,
      lockfile: null,
    },
  ];

  const winnerIdx = candidates.findIndex((c) => c.matched);
  let manager: PythonManager = "pip";
  let managerSource: string | null = null;
  let lockfile: string | null = null;
  if (winnerIdx >= 0) {
    manager = candidates[winnerIdx].manager;
    managerSource = candidates[winnerIdx].source;
    lockfile = candidates[winnerIdx].lockfile;
    for (let i = winnerIdx + 1; i < candidates.length; i++) {
      const other = candidates[i];
      if (other.matched) {
        notes.push(`${other.source} (${other.manager}) is also present; ${managerSource} (${manager}) wins by manager precedence.`);
      }
    }
  }

  const runPrefix = RUN_PREFIX[manager];
  const withPrefix = (cmd: string) => (runPrefix ? `${runPrefix} ${cmd}` : cmd);

  // Test framework: a config marker, a dependency mention, or a tests/test directory with
  // pytest-shaped file names. A configured section always wins over a bare pytest.ini file.
  const pytestConfigured: [string, boolean][] = [
    ["pyproject.toml", hasExactHeader(pyproject, "tool.pytest.ini_options")],
    ["pytest.ini", hasExactHeader(pytestIni, "pytest")],
    [".pytest.ini", hasExactHeader(dotPytestIni, "pytest")],
    ["tox.ini", hasExactHeader(toxIni, "pytest")],
    ["setup.cfg", hasExactHeader(setupCfg, "tool:pytest")],
  ];
  let testConfigFile = pytestConfigured.find(([, ok]) => ok)?.[0] ?? null;
  if (!testConfigFile) {
    if (exists(dir, "pytest.ini")) testConfigFile = "pytest.ini";
    else if (exists(dir, ".pytest.ini")) testConfigFile = ".pytest.ini";
  }
  const testFrameworkDetected =
    testConfigFile !== null ||
    depMention(pyproject, "pytest") ||
    reqFilesHaveDependency(dir, reqFiles, "pytest") ||
    dirHasPytestFile(dir, "tests") ||
    dirHasPytestFile(dir, "test");
  const testFramework: "pytest" | null = testFrameworkDetected ? "pytest" : null;
  if (!testFramework) testConfigFile = null;

  const testDirs = ["tests", "test"].filter((d) => isDir(dir, d));

  // Lint/format: ruff is a drop-in replacement for black/isort/flake8, so a ruff signal
  // wins outright and no black command is ever emitted alongside it.
  const ruffSignal =
    exists(dir, ".ruff.toml") ||
    exists(dir, "ruff.toml") ||
    hasTableHeader(pyproject, "tool.ruff") ||
    depMention(pyproject, "ruff") ||
    reqFilesHaveDependency(dir, reqFiles, "ruff");
  const blackSignal = hasExactHeader(pyproject, "tool.black") || depMention(pyproject, "black");

  let linter: "ruff" | null = null;
  let formatter: PythonDetection["formatter"] = null;
  if (ruffSignal) {
    linter = "ruff";
    formatter = { name: "ruff", command: withPrefix("ruff format .") };
    if (blackSignal) notes.push("Both a ruff signal and a black marker are present; ruff replaces black, so only ruff commands are proposed.");
  } else if (blackSignal) {
    formatter = { name: "black", command: withPrefix("black .") };
  }

  // Type checker.
  const mypyConfigured: [string, boolean][] = [
    ["mypy.ini", exists(dir, "mypy.ini")],
    [".mypy.ini", exists(dir, ".mypy.ini")],
    ["pyproject.toml", hasExactHeader(pyproject, "tool.mypy")],
    ["setup.cfg", hasExactHeader(setupCfg, "mypy")],
  ];
  const mypyHit = mypyConfigured.find(([, ok]) => ok) ?? null;
  const typeChecker: "mypy" | null = mypyHit ? "mypy" : null;
  const typeCheckerConfigFile = mypyHit ? mypyHit[0] : null;

  const srcLayout = srcLayoutOk(dir);

  // venv layout: bin on POSIX, Scripts on Windows.
  const venvDir = isDir(dir, ".venv") ? ".venv" : null;
  const venvBinDir = isDir(dir, ".venv/bin") ? ".venv/bin" : isDir(dir, ".venv/Scripts") ? ".venv/Scripts" : null;

  // .python-version as the primary version source is project policy, read before
  // pyproject's documented requires-python key.
  let pythonVersion: string | null = null;
  let pythonVersionSource: string | null = null;
  const pv = readText(dir, ".python-version");
  if (pv) {
    const firstLine = pv.split(/\r?\n/).find((l) => l.trim().length > 0);
    if (firstLine) {
      pythonVersion = firstLine.trim();
      pythonVersionSource = ".python-version";
    }
  }
  if (!pythonVersion) {
    const m = pyproject.match(/^\s*requires-python\s*=\s*["']([^"']*)["']/m);
    if (m) {
      pythonVersion = m[1];
      pythonVersionSource = "pyproject.toml requires-python";
    }
  }

  // Migration directories.
  const migrationDirs = new Set<string>();
  if (isDir(dir, "alembic/versions")) migrationDirs.add("alembic/versions");
  collectMigrationDirs(dir, ".", 2, migrationDirs);
  if (isDir(dir, "src")) collectMigrationDirs(dir, "src", 2, migrationDirs);

  // Generated/cache directories.
  const generatedDirs = [
    ...GENERATED_CANDIDATES.filter((d) => isDir(dir, d)),
    ...listDir(dir).filter((e) => e.endsWith(".egg-info") && isDir(dir, e)),
  ].sort();

  const commands: PythonDetection["commands"] = { install: null, test: null, lint: null, format: null, formatCheck: null, typecheck: null };

  if (manager === "uv") commands.install = "uv sync --locked";
  else if (manager === "poetry") commands.install = "poetry install";
  else if (manager === "pdm") commands.install = "pdm install";
  else if (manager === "pipenv") commands.install = "pipenv install";
  else if (manager === "pip") {
    if (reqFiles.length > 0) commands.install = `pip install -r ${[...reqFiles].sort()[0]}`;
    else if (hasSetupPy || hasPyproject) commands.install = "pip install -e .";
  }

  if (testFramework) commands.test = withPrefix("pytest");
  let singleTestCommand: string | null = testFramework ? withPrefix("pytest <path/to/test_file.py>") : null;
  let singleTestNodeIdCommand: string | null = testFramework ? withPrefix("pytest <path/to/test_file.py>::<test_name>") : null;

  if (ruffSignal) {
    commands.lint = withPrefix("ruff check .");
    commands.formatCheck = withPrefix("ruff format --check .");
  } else if (formatter?.name === "black") {
    commands.formatCheck = withPrefix("black --check .");
  }
  commands.format = formatter ? formatter.command : null;

  if (typeChecker) commands.typecheck = withPrefix(srcLayout ? "mypy src" : "mypy .");

  // hatch's `run`/install forms were not verified this session (research note marks them
  // unverified), so no commands are proposed for a hatch project, whatever markers it has.
  if (manager === "hatch") {
    commands.install = null;
    commands.test = null;
    commands.lint = null;
    commands.format = null;
    commands.formatCheck = null;
    commands.typecheck = null;
    singleTestCommand = null;
    singleTestNodeIdCommand = null;
    formatter = null;
    notes.push("hatch's run and install forms were not verified this session, so no commands are proposed for a hatch project.");
  }

  return {
    present: true,
    manager,
    managerSource,
    lockfile,
    runPrefix,
    pythonVersion,
    pythonVersionSource,
    venvDir,
    venvBinDir,
    commands,
    testFramework,
    testConfigFile,
    testDirs,
    singleTestCommand,
    singleTestNodeIdCommand,
    linter,
    formatter,
    typeChecker,
    typeCheckerConfigFile,
    srcLayout,
    migrationDirs: [...migrationDirs].sort(),
    generatedDirs,
  };
}
