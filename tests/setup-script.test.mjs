import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, chmodSync, readFileSync, existsSync, mkdirSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const realNodeDir = dirname(process.execPath);

const tmpDirs = [];

function makeTempClone() {
  const dir = mkdtempSync(join(tmpdir(), "setup-script-"));
  tmpDirs.push(dir);
  mkdirSync(join(dir, "scripts"), { recursive: true });
  cpSync(join(repoRoot, "scripts/setup.sh"), join(dir, "scripts/setup.sh"));
  chmodSync(join(dir, "scripts/setup.sh"), 0o755);
  cpSync(join(repoRoot, "package.json"), join(dir, "package.json"));
  cpSync(join(repoRoot, "pnpm-workspace.yaml"), join(dir, "pnpm-workspace.yaml"));
  return dir;
}

// Builds a stub bin dir (placed first on PATH) with a `pnpm` shim whose behaviour is controlled by
// env vars, and logs every invocation's argv to a log file the test can inspect.
function makeStubBinDir(opts = {}) {
  const {
    version = "9.15.4",
    globalBin = "",
    installExit = 0,
    linkExit = 0,
    node = false,
  } = opts;

  const dir = mkdtempSync(join(tmpdir(), "setup-script-bin-"));
  tmpDirs.push(dir);
  const logFile = join(dir, "pnpm-calls.log");
  writeFileSync(logFile, "");

  const pnpmShim = `#!/bin/sh
echo "$@" >> "${logFile}"
case "$1" in
  --version)
    echo "${version}"
    exit 0
    ;;
  bin)
    echo "${globalBin}"
    exit 0
    ;;
  --dir)
    # pnpm --dir packages/doug-cli link --global
    exit ${linkExit}
    ;;
  install)
    exit ${installExit}
    ;;
  build|-r)
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`;
  writeFileSync(join(dir, "pnpm"), pnpmShim);
  chmodSync(join(dir, "pnpm"), 0o755);

  if (node) {
    const nodeShim = `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "${node}"
  exit 0
fi
exec "${process.execPath}" "$@"
`;
    writeFileSync(join(dir, "node"), nodeShim);
    chmodSync(join(dir, "node"), 0o755);
  }

  return { dir, logFile };
}

// A bin dir holding only a `node` shim (no pnpm), for cases that must exercise the
// pnpm-not-found branch without shadowing the real pnpm on the developer's machine.
function makeNodeOnlyDir() {
  const dir = mkdtempSync(join(tmpdir(), "setup-script-node-only-"));
  tmpDirs.push(dir);
  const nodeShim = `#!/bin/sh\nexec "${process.execPath}" "$@"\n`;
  writeFileSync(join(dir, "node"), nodeShim);
  chmodSync(join(dir, "node"), 0o755);
  return dir;
}

function makeCodexStubDir() {
  const dir = mkdtempSync(join(tmpdir(), "setup-script-codex-"));
  tmpDirs.push(dir);
  writeFileSync(join(dir, "codex"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(dir, "codex"), 0o755);
  return dir;
}

// Standard utils (dirname, cat, test, ...) the script needs beyond node/pnpm/codex, appended after
// the stub dirs so the stubs still win for the commands under test.
const STANDARD_UTILS_PATH = "/bin:/usr/bin";

function runSetup(cloneDir, { path, env = {} } = {}) {
  return spawnSync("/bin/sh", [join(cloneDir, "scripts/setup.sh")], {
    cwd: cloneDir,
    env: {
      ...env,
      PATH: `${path}:${STANDARD_UTILS_PATH}`,
    },
    encoding: "utf8",
    timeout: 15000,
  });
}

afterAll(() => {
  for (const dir of tmpDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
});

describe("scripts/setup.sh", () => {
  it("(a) links doug when a global bin dir and codex are present", () => {
    const clone = makeTempClone();
    const { dir: stubBin, logFile } = makeStubBinDir({ globalBin: "/fake/global/bin" });
    const codexDir = makeCodexStubDir();
    const result = runSetup(clone, { path: `${stubBin}:${codexDir}:${realNodeDir}` });

    expect(result.status).toBe(0);
    const log = readFileSync(logFile, "utf8");
    expect(log).toContain("install");
    expect(log).toMatch(/build|-r/);
    expect(log).toContain("link");
    expect(result.stdout).toContain("linked doug");
    expect(result.stdout).toContain("codex found");
  });

  it("(b) reports codex missing but still succeeds", () => {
    const clone = makeTempClone();
    const { dir: stubBin } = makeStubBinDir({ globalBin: "/fake/global/bin" });
    const result = runSetup(clone, { path: `${stubBin}:${realNodeDir}` });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("codex not found");
  });

  it("(c) skips link when pnpm bin -g is empty", () => {
    const clone = makeTempClone();
    const { dir: stubBin, logFile } = makeStubBinDir({ globalBin: "" });
    const result = runSetup(clone, {
      path: `${stubBin}:${realNodeDir}`,
      env: { PNPM_HOME: "" },
    });

    expect(result.status).toBe(0);
    const log = readFileSync(logFile, "utf8");
    expect(log).not.toContain("link");
    expect(result.stdout).toContain(join(clone, "packages/doug-cli/dist/bin.js"));
  });

  it("(d) is idempotent: running twice both succeed with the same link line", () => {
    const clone = makeTempClone();
    const { dir: stubBin } = makeStubBinDir({ globalBin: "/fake/global/bin" });
    const codexDir = makeCodexStubDir();
    const path = `${stubBin}:${codexDir}:${realNodeDir}`;

    const first = runSetup(clone, { path });
    const second = runSetup(clone, { path });

    expect(first.status).toBe(0);
    expect(second.status).toBe(0);
    const firstLinkLine = first.stdout.split("\n").find((l) => l.includes("linked doug"));
    const secondLinkLine = second.stdout.split("\n").find((l) => l.includes("linked doug"));
    expect(firstLinkLine).toBeTruthy();
    expect(firstLinkLine).toBe(secondLinkLine);
  });

  it("(e) fails with one stderr line naming pnpm when pnpm is missing", () => {
    const clone = makeTempClone();
    const nodeOnly = makeNodeOnlyDir();
    const result = runSetup(clone, { path: `${nodeOnly}` });

    expect(result.status).not.toBe(0);
    const stderrLines = result.stderr.trim().split("\n").filter(Boolean);
    expect(stderrLines).toHaveLength(1);
    expect(stderrLines[0]).toContain("corepack enable pnpm");
  });

  it("(f) fails naming 22.16 when node is too old", () => {
    const clone = makeTempClone();
    const { dir: stubBin } = makeStubBinDir({ node: "v20.11.0" });
    const result = runSetup(clone, { path: `${stubBin}` });

    expect(result.status).not.toBe(0);
    const stderrLines = result.stderr.trim().split("\n").filter(Boolean);
    expect(stderrLines).toHaveLength(1);
    expect(stderrLines[0]).toContain("22.16");
  });

  it("(g) fails naming install when pnpm install fails, with no build or link calls", () => {
    const clone = makeTempClone();
    const { dir: stubBin, logFile } = makeStubBinDir({ globalBin: "/fake/global/bin", installExit: 1 });
    const result = runSetup(clone, { path: `${stubBin}:${realNodeDir}` });

    expect(result.status).not.toBe(0);
    const stderrLines = result.stderr.trim().split("\n").filter(Boolean);
    expect(stderrLines).toHaveLength(1);
    expect(stderrLines[0]).toContain("install");
    const log = readFileSync(logFile, "utf8");
    expect(log).not.toMatch(/build|-r/);
    expect(log).not.toContain("link");
  });

  it("(h) REQUIRED_NODE in scripts/setup.sh matches package.json engines.node", () => {
    const scriptSrc = readFileSync(join(repoRoot, "scripts/setup.sh"), "utf8");
    const match = scriptSrc.match(/REQUIRED_NODE="([^"]+)"/);
    expect(match).toBeTruthy();
    const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
    const enginesNode = pkg.engines.node;
    const floor = enginesNode.replace(/^>=/, "");
    expect(match[1]).toBe(floor);
  });

  it("(i) a failed link is not fatal and prints the fallback line", () => {
    const clone = makeTempClone();
    const { dir: stubBin, logFile } = makeStubBinDir({ globalBin: "/fake/global/bin", linkExit: 1 });
    const result = runSetup(clone, { path: `${stubBin}:${realNodeDir}` });

    expect(result.status).toBe(0);
    const log = readFileSync(logFile, "utf8");
    expect(log).toContain("link");
    expect(result.stdout).toContain(join(clone, "packages/doug-cli/dist/bin.js"));
  });

  it("(k) a missing packageManager field prints no undefined warning", () => {
    const clone = makeTempClone();
    const pkgPath = join(clone, "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    delete pkg.packageManager;
    writeFileSync(pkgPath, JSON.stringify(pkg));
    const { dir: stubBin } = makeStubBinDir({ globalBin: "/fake/global/bin" });
    const result = runSetup(clone, { path: `${stubBin}:${realNodeDir}` });

    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain("undefined");
    expect(result.stdout).toContain("onboarding.md");
  });

  it("(j) a pnpm version mismatch warns once and continues", () => {
    const clone = makeTempClone();
    const { dir: stubBin, logFile } = makeStubBinDir({ globalBin: "/fake/global/bin", version: "9.0.0" });
    const result = runSetup(clone, { path: `${stubBin}:${realNodeDir}` });

    expect(result.status).toBe(0);
    const warningLines = result.stdout.split("\n").filter((l) => l.includes("9.0.0") && l.includes("9.15.4"));
    expect(warningLines).toHaveLength(1);
    const log = readFileSync(logFile, "utf8");
    expect(log).toContain("install");
    expect(log).toMatch(/build|-r/);
    expect(log).toContain("link");
  });
});
