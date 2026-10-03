import { describe, it, expect, beforeAll } from "vitest";
import { spawnSync } from "node:child_process";
import {
  readFileSync,
  writeFileSync,
  mkdtempSync,
  mkdirSync,
  cpSync,
  rmSync,
  existsSync,
  readdirSync,
  statSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { checkRelease, stageRelease } from "../scripts/release.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

const MANIFEST_PATHS = [
  "package.json",
  "packages/doug-cli/package.json",
  "packages/doug-codex/package.json",
  "plugins/doug-flow/package.json",
  "plugins/doug-gates/package.json",
  "plugins/doug-flow/.claude-plugin/plugin.json",
  "plugins/doug-gates/.claude-plugin/plugin.json",
];
const MARKETPLACE_PATH = ".claude-plugin/marketplace.json";
const LICENSE_PATHS = ["LICENSE", "plugins/doug-flow/LICENSE", "plugins/doug-gates/LICENSE"];

function makeFixtureRoot() {
  const root = mkdtempSync(join(tmpdir(), "release-fixture-"));
  for (const relPath of [...MANIFEST_PATHS, MARKETPLACE_PATH, ...LICENSE_PATHS]) {
    const dest = join(root, relPath);
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(join(repoRoot, relPath), dest);
  }
  return root;
}

function writeJson(root, relPath, value) {
  writeFileSync(join(root, relPath), JSON.stringify(value, null, 2));
}

function readJson(root, relPath) {
  return JSON.parse(readFileSync(join(root, relPath), "utf8"));
}

describe("release check (real repo)", () => {
  it("runs clean at the repo root and prints ok", () => {
    const result = spawnSync(process.execPath, ["scripts/release.mjs", "check"], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("release check: ok");
  });

  it("returns no problems for the real repo's manifests", () => {
    expect(checkRelease(repoRoot)).toEqual([]);
  });
});

describe("release check mutations", () => {
  it("flags a version mismatch in a plugin.json", () => {
    const root = makeFixtureRoot();
    try {
      const pluginJsonPath = "plugins/doug-gates/.claude-plugin/plugin.json";
      const manifest = readJson(root, pluginJsonPath);
      manifest.version = "9.9.9";
      writeJson(root, pluginJsonPath, manifest);

      const problems = checkRelease(root);
      expect(problems.some((p) => p.includes(pluginJsonPath))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("flags a missing private field (version mismatch style rule)", () => {
    const root = makeFixtureRoot();
    try {
      const relPath = "plugins/doug-flow/package.json";
      const manifest = readJson(root, relPath);
      delete manifest.private;
      writeJson(root, relPath, manifest);

      const problems = checkRelease(root);
      expect(problems.some((p) => p.includes(relPath))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("flags a version added to the doug-flow marketplace entry", () => {
    const root = makeFixtureRoot();
    try {
      const marketplace = readJson(root, MARKETPLACE_PATH);
      const entry = marketplace.plugins.find((p) => p.name === "doug-flow");
      entry.version = "0.1.0";
      writeJson(root, MARKETPLACE_PATH, marketplace);

      const problems = checkRelease(root);
      expect(problems.some((p) => p.includes(MARKETPLACE_PATH))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not throw when packages/doug-codex/package.json is invalid JSON", () => {
    const root = makeFixtureRoot();
    try {
      const relPath = "packages/doug-codex/package.json";
      writeFileSync(join(root, relPath), "{");

      let problems;
      expect(() => {
        problems = checkRelease(root);
      }).not.toThrow();
      expect(problems.some((p) => p.includes(relPath))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not throw and reports a problem when marketplace.json is null", () => {
    const root = makeFixtureRoot();
    try {
      writeFileSync(join(root, MARKETPLACE_PATH), "null");

      let problems;
      expect(() => {
        problems = checkRelease(root);
      }).not.toThrow();
      expect(problems.some((p) => p.includes(MARKETPLACE_PATH))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not return [] when root package.json is null", () => {
    const root = makeFixtureRoot();
    try {
      writeFileSync(join(root, "package.json"), "null");

      let problems;
      expect(() => {
        problems = checkRelease(root);
      }).not.toThrow();
      expect(problems).not.toEqual([]);
      expect(problems.some((p) => p.includes("package.json"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns [] for the unmutated fixture copy", () => {
    const root = makeFixtureRoot();
    try {
      expect(checkRelease(root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function npmVersionOk() {
  const result = spawnSync("npm", ["--version"], { encoding: "utf8" });
  return result.status === 0;
}

const cliDistBin = join(repoRoot, "packages/doug-cli/dist/bin.js");
const codexDistBin = join(repoRoot, "packages/doug-codex/dist/bin.js");
const distMissing = !existsSync(cliDistBin) || !existsSync(codexDistBin);
const npmMissing = !npmVersionOk();
const skipStage = distMissing || npmMissing;
const skipReason = distMissing
  ? "run pnpm build first (packages/doug-cli/dist/bin.js or packages/doug-codex/dist/bin.js missing)"
  : npmMissing
    ? "npm --version failed"
    : "";

describe.skipIf(skipStage)(`release stage and npm pack${skipReason ? ` (skipped: ${skipReason})` : ""}`, () => {
  const tmpRoot = mkdtempSync(join(tmpdir(), "release-stage-"));
  const outDir = join(tmpRoot, "out");
  const packDest = join(tmpRoot, "pack");
  const npmCache = join(tmpRoot, "npm-cache");
  mkdirSync(packDest, { recursive: true });
  mkdirSync(npmCache, { recursive: true });

  let stageResult;
  beforeAll(() => {
    stageResult = stageRelease(repoRoot, outDir);
  });

  it(
    "stages a cli package.json with no workspace: values, no scripts/devDependencies, and bundleDependencies",
    () => {
      expect(stageResult.ok).toBe(true);
      const cliPkg = readJson(outDir, "cli/package.json");
      const values = Object.values(cliPkg.dependencies || {});
      expect(values.some((v) => typeof v === "string" && v.startsWith("workspace:"))).toBe(false);
      expect(cliPkg.scripts).toBeUndefined();
      expect(cliPkg.devDependencies).toBeUndefined();
      expect(cliPkg.bundleDependencies).toEqual(["@dougharness/flow", "@dougharness/gates"]);
    },
    120000,
  );

  it("no staged skill or agent names plugins/doug-, packages/doug-, or evals/", () => {
    expect(stageResult.ok).toBe(true);
    const bundled = join(outDir, "cli/node_modules/@dougharness");
    const walkFiles = (p) =>
      statSync(p).isDirectory() ? readdirSync(p).flatMap((n) => walkFiles(join(p, n))) : [p];
    const hits = [];
    let scanned = 0;
    for (const name of readdirSync(bundled)) {
      for (const sub of ["skills", "agents"]) {
        const dir = join(bundled, name, sub);
        if (!existsSync(dir)) continue;
        for (const file of walkFiles(dir)) {
          scanned += 1;
          readFileSync(file, "utf8")
            .split("\n")
            .forEach((line, i) => {
              const m = /plugins\/doug-|packages\/doug-|evals\//.exec(line);
              if (m) hits.push(`${file}:${i + 1}: ${m[0]}`);
            });
        }
      }
    }
    expect(scanned).toBeGreaterThan(0);
    expect(hits).toEqual([]);
  });

  it(
    "npm pack --dry-run-equivalent (json, offline) succeeds for both staged packages and bundles files",
    () => {
      const env = {
        ...process.env,
        npm_config_cache: npmCache,
        npm_config_update_notifier: "false",
      };

      const cliResult = spawnSync(
        "npm",
        ["pack", "--json", "--ignore-scripts", "--offline", "--pack-destination", packDest],
        { cwd: join(outDir, "cli"), encoding: "utf8", env },
      );
      expect(cliResult.status).toBe(0);
      const cliInfo = JSON.parse(cliResult.stdout)[0];
      const cliFiles = cliInfo.files.map((f) => f.path);
      expect(cliFiles).toContain("LICENSE");
      expect(cliFiles).toContain("dist/bin.js");
      expect(cliFiles).toContain("node_modules/@dougharness/gates/hooks/hooks.json");
      expect(cliFiles).toContain("node_modules/@dougharness/flow/lib/board.mjs");

      const codexResult = spawnSync(
        "npm",
        ["pack", "--json", "--ignore-scripts", "--offline", "--pack-destination", packDest],
        { cwd: join(outDir, "codex"), encoding: "utf8", env },
      );
      expect(codexResult.status).toBe(0);
      const codexInfo = JSON.parse(codexResult.stdout)[0];
      const codexFiles = codexInfo.files.map((f) => f.path);
      expect(codexFiles).toContain("LICENSE");
      expect(codexFiles).toContain("dist/bin.js");
    },
    120000,
  );

  it(
    "the packed cli tarball runs `doug init --dry-run` against a fixture project",
    () => {
      const env = {
        ...process.env,
        npm_config_cache: npmCache,
        npm_config_update_notifier: "false",
      };
      const packResult = spawnSync(
        "npm",
        ["pack", "--json", "--ignore-scripts", "--offline", "--pack-destination", packDest],
        { cwd: join(outDir, "cli"), encoding: "utf8", env },
      );
      expect(packResult.status).toBe(0);
      const tgzName = JSON.parse(packResult.stdout)[0].filename;
      const tgzPath = join(packDest, tgzName);

      const installDir = join(tmpRoot, "install", "node_modules", "@dougharness", "cli");
      mkdirSync(installDir, { recursive: true });
      const extractResult = spawnSync("tar", ["-xzf", tgzPath, "-C", installDir, "--strip-components=1"], {
        encoding: "utf8",
      });
      expect(extractResult.status).toBe(0);

      const fixtureSrc = join(repoRoot, "packages/doug-cli/tests/fixtures/ts-pnpm");
      const fixtureDest = join(tmpRoot, "fixture-ts-pnpm");
      cpSync(fixtureSrc, fixtureDest, { recursive: true });

      const runResult = spawnSync(
        process.execPath,
        [join(installDir, "dist/bin.js"), "init", fixtureDest, "--dry-run", "--no-color"],
        { cwd: tmpRoot, encoding: "utf8" },
      );
      expect(runResult.status).toBe(0);
      expect(runResult.stdout).toContain("vendored hook files from @dougharness/gates");
    },
    120000,
  );

  it(
    "the packed codex tarball runs `codex-review --help`",
    () => {
      const env = {
        ...process.env,
        npm_config_cache: npmCache,
        npm_config_update_notifier: "false",
      };
      const packResult = spawnSync(
        "npm",
        ["pack", "--json", "--ignore-scripts", "--offline", "--pack-destination", packDest],
        { cwd: join(outDir, "codex"), encoding: "utf8", env },
      );
      expect(packResult.status).toBe(0);
      const tgzName = JSON.parse(packResult.stdout)[0].filename;
      const tgzPath = join(packDest, tgzName);

      const installDir = join(tmpRoot, "install", "node_modules", "@dougharness", "codex");
      mkdirSync(installDir, { recursive: true });
      const extractResult = spawnSync("tar", ["-xzf", tgzPath, "-C", installDir, "--strip-components=1"], {
        encoding: "utf8",
      });
      expect(extractResult.status).toBe(0);

      const runResult = spawnSync(process.execPath, [join(installDir, "dist/bin.js"), "--help"], {
        cwd: tmpRoot,
        encoding: "utf8",
      });
      expect(runResult.status).toBe(0);
      expect(runResult.stdout).toContain("codex-review");
    },
    120000,
  );
});
