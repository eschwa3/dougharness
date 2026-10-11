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

  const BIN_CASES = [
    ["packages/doug-cli/package.json", "doug", "./dist/bin.js"],
    ["packages/doug-codex/package.json", "codex-review", "./dist/bin.js"],
    ["packages/doug-cli/package.json", "doug", "dist\\bin.js"],
    ["packages/doug-codex/package.json", "codex-review", "dist\\bin.js"],
  ];
  for (const [manifest, name, value] of BIN_CASES) {
    it(`flags ${manifest} bin.${name} = ${JSON.stringify(value)} as not npm-normalised`, () => {
      const root = makeFixtureRoot();
      try {
        const pkg = readJson(root, manifest);
        pkg.bin = { [name]: value };
        writeJson(root, manifest, pkg);

        const problems = checkRelease(root).filter(
          (p) => p.includes(manifest) && p.includes(`bin.${name}`),
        );
        expect(problems.length).toBeGreaterThan(0);
        expect(problems.some((p) => p.includes("dist/bin.js"))).toBe(true);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }

  it("flags a string-form bin that npm would normalise", () => {
    const root = makeFixtureRoot();
    try {
      const manifest = "packages/doug-cli/package.json";
      const pkg = readJson(root, manifest);
      pkg.bin = "./dist/bin.js";
      writeJson(root, manifest, pkg);

      const problems = checkRelease(root).filter((p) => p.includes(manifest) && /\bbin\b/.test(p));
      expect(problems.length).toBeGreaterThan(0);
      expect(problems.some((p) => p.includes("dist/bin.js"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // Whole bin step (npm 10.9.8 `npm pkg fix`, confirmed per form in a scratch dir): each form
  // below is changed or removed by npm, so release:check must flag it. Keys/forms, not just values.
  const BIN_MANIFEST = "packages/doug-cli/package.json";
  function binProblems(bin, { omit = false } = {}) {
    const root = makeFixtureRoot();
    try {
      const pkg = readJson(root, BIN_MANIFEST);
      if (omit) delete pkg.bin;
      else pkg.bin = bin;
      writeJson(root, BIN_MANIFEST, pkg);
      return checkRelease(root).filter((p) => p.includes(BIN_MANIFEST));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  // M1: npm rewrites {"pkg": "dist/bin.js"} (renames the command to the package name), even
  // though the path itself is already clean.
  it("flags a string-form bin even when its path is already clean", () => {
    const problems = binProblems("dist/bin.js");
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.some((p) => p.includes('"bin"') && /object/i.test(p))).toBe(true);
  });

  // M2: npm converts an array to {basename: path}.
  it("flags an array-form bin", () => {
    const problems = binProblems(["dist/bin.js"]);
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.some((p) => p.includes('"bin"') && /array/i.test(p))).toBe(true);
  });

  // M3: npm deletes an empty bin object.
  it("flags an empty bin object", () => {
    const problems = binProblems({});
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.some((p) => p.includes('"bin"') && /empty/i.test(p))).toBe(true);
  });

  // M4: npm deletes an entry whose value is "" (here the key is clean and the value is "").
  it("flags a bin entry with an empty value", () => {
    const problems = binProblems({ doug: "" });
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.some((p) => p.includes('"bin.doug"') && /empty/i.test(p))).toBe(true);
  });

  // M5: npm renames 'a/doug' to 'doug' (basename of the key); the value is clean.
  it("flags a bin key containing a slash", () => {
    const problems = binProblems({ "a/doug": "dist/bin.js" });
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.some((p) => p.includes("bin.a/doug") && p.includes('"doug"'))).toBe(true);
  });

  it("flags a bin key whose basename is empty", () => {
    const problems = binProblems({ "": "dist/bin.js" });
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.some((p) => p.includes('"bin."'))).toBe(true);
  });

  // M6: a value that secures to "./..." becomes "" in npm; "./" itself is not "" until that clause.
  for (const value of ["./", "."]) {
    it(`flags bin.doug = ${JSON.stringify(value)} (npm removes the entry)`, () => {
      const problems = binProblems({ doug: value });
      expect(problems.length).toBeGreaterThan(0);
      expect(problems.some((p) => p.includes('"bin.doug"') && /empty/i.test(p))).toBe(true);
    });
  }

  // M7: the inner rooted join strips "..": npm turns "../x" into "x".
  it("flags bin.doug = \"../x\" (npm cleans it to \"x\")", () => {
    const problems = binProblems({ doug: "../x" });
    expect(problems.some((p) => p.includes('"bin.doug"') && p.includes('"x"'))).toBe(true);
  });

  // M8: npm deletes an entry with a non-string value.
  it("flags a non-string bin value and names the field", () => {
    const problems = binProblems({ doug: 5 });
    expect(problems.some((p) => p.includes('"bin.doug"') && p.includes("must be a string"))).toBe(
      true,
    );
  });

  // M9: npm ignores bin: null, so it is no problem. (An absent bin is none either.)
  it("reports no bin problem when bin is null", () => {
    expect(binProblems(null)).toEqual([]);
  });

  it("reports no bin problem when bin is absent", () => {
    expect(binProblems(undefined, { omit: true })).toEqual([]);
  });

  // M10: a falsy non-null bin is skipped by npm but is not a usable bin; flag it.
  for (const bin of ["", false, 0]) {
    it(`flags the falsy bin ${JSON.stringify(bin)} as empty or invalid`, () => {
      const problems = binProblems(bin);
      expect(problems.some((p) => p.includes('"bin"') && /empty|invalid/i.test(p))).toBe(true);
    });
  }

  it("flags a truthy non-string, non-object bin", () => {
    const problems = binProblems(5);
    expect(problems.some((p) => p.includes('"bin"'))).toBe(true);
  });

  it("reports no bin problem when both packages use dist/bin.js", () => {
    const root = makeFixtureRoot();
    try {
      for (const [manifest, name] of [
        ["packages/doug-cli/package.json", "doug"],
        ["packages/doug-codex/package.json", "codex-review"],
      ]) {
        const pkg = readJson(root, manifest);
        pkg.bin = { [name]: "dist/bin.js" };
        writeJson(root, manifest, pkg);
      }
      expect(checkRelease(root)).toEqual([]);
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
  it(
    "npm pkg fix leaves each staged package.json unchanged (publish prints no correction)",
    () => {
      expect(stageResult.ok).toBe(true);
      const env = {
        ...process.env,
        npm_config_cache: npmCache,
        npm_config_update_notifier: "false",
      };
      for (const name of ["cli", "codex"]) {
        const dir = mkdtempSync(join(tmpRoot, `pkgfix-${name}-`));
        cpSync(join(outDir, name, "package.json"), join(dir, "package.json"));
        const before = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
        const result = spawnSync("npm", ["pkg", "fix", "--offline"], {
          cwd: dir,
          encoding: "utf8",
          env,
        });
        expect(result.status).toBe(0);
        const after = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
        expect(after).toEqual(before);
      }
    },
    120000,
  );
});
