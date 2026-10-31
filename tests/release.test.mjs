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
import { checkRelease, loadTransforms, stageRelease, stagedPathFor } from "../scripts/release.mjs";

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

// Card public-export-confidential: the stage applies the export's TRANSFORMS to the staged copies, so npm text equals GitHub text.
describe("stagedPathFor maps a repo path to its path under the stage out dir", () => {
  const cases = [
    ["plugins/doug-flow/skills/doug-next/SKILL.md", "cli/node_modules/@dougharness/flow/skills/doug-next/SKILL.md"],
    ["plugins/doug-flow/lib/board.mjs", "cli/node_modules/@dougharness/flow/lib/board.mjs"],
    ["plugins/doug-gates/scripts/stop-gate.mjs", "cli/node_modules/@dougharness/gates/scripts/stop-gate.mjs"],
    ["plugins/doug-gates/.claude-plugin/plugin.json", "cli/node_modules/@dougharness/gates/.claude-plugin/plugin.json"],
    ["packages/doug-cli/src/generate/claude-md.ts", "cli/dist/generate/claude-md.js"],
    ["packages/doug-cli/templates/board-app.js", "cli/templates/board-app.js"],
    ["packages/doug-codex/src/bin.ts", "codex/dist/bin.js"],
  ];
  for (const [repoPath, staged] of cases) {
    it(`${repoPath} -> ${staged}`, () => {
      expect(stagedPathFor(repoRoot, repoPath)).toBe(staged);
    });
  }
  it("returns null for a path the stage does not copy", () => {
    for (const p of ["README.md", "CLAUDE.md", "docs/memory.md", "package.json", "scripts/release.mjs", ".doug/hooks/scripts/stop-gate.mjs", "tests/release.test.mjs", "plugins/doug-flow/tests/template.test.mjs", "plugins/doug-flow/package.json"]) {
      expect(stagedPathFor(repoRoot, p), p).toBeNull();
    }
  });
});

describe("loadTransforms", () => {
  it("returns [] for a root without scripts/export-public.mjs (the public tree)", async () => {
    const root = mkdtempSync(join(tmpdir(), "release-notransforms-"));
    try {
      expect(await loadTransforms(root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("stageRelease applies transforms (fixture root, no build needed)", () => {
  const SKILL = "plugins/doug-flow/skills/doug-next/SKILL.md";
  const GATE = "plugins/doug-gates/scripts/stop-gate.mjs";
  const CLI_SRC = "packages/doug-cli/src/generate/claude-md.ts";
  const CLI_DIST = "packages/doug-cli/dist/generate/claude-md.js";
  const FROM_SKILL = "runs n queens unattended (docs/research/x.md section 4).";
  const FROM_GATE = "(docs/research/y.md Q1: 88 events)";
  const FROM_CLI = "and cost tokens (docs/reviews/07-z.md).";

  function makeStageFixture() {
    const root = makeFixtureRoot();
    const put = (rel, text) => {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), text);
    };
    for (const pkg of ["plugins/doug-flow", "plugins/doug-gates"]) {
      for (const entry of readJson(root, `${pkg}/package.json`).files) {
        mkdirSync(join(root, pkg, entry), { recursive: true });
        writeFileSync(join(root, pkg, entry, ".keep"), "");
      }
    }
    put(SKILL, `before ${FROM_SKILL} after\n`);
    put(GATE, `// ${FROM_GATE}\n`);
    put("plugins/doug-flow/lib/untouched.mjs", "// keep me\n");
    put("packages/doug-cli/dist/bin.js", "// bin\n");
    put(CLI_DIST, `        // ${FROM_CLI}\n`);
    put("packages/doug-cli/templates/t.txt", "t\n");
    put("packages/doug-codex/dist/bin.js", "// codex bin\n");
    return root;
  }

  const transforms = [
    { file: SKILL, from: FROM_SKILL, to: "runs n queens unattended." },
    { file: GATE, from: FROM_GATE, to: "(88 events)" },
    { file: CLI_SRC, from: FROM_CLI, to: "and cost tokens." },
  ];

  it("writes the transformed text into the bundled skill, the bundled gate script and the cli dist file, and leaves other files alone", () => {
    const root = makeStageFixture();
    const out = join(root, "stage-out");
    try {
      const res = stageRelease(root, out, { transforms });
      expect(res.ok, JSON.stringify(res)).toBe(true);
      const read = (rel) => readFileSync(join(out, rel), "utf8");
      expect(read("cli/node_modules/@dougharness/flow/skills/doug-next/SKILL.md")).toBe("before runs n queens unattended. after\n");
      expect(read("cli/node_modules/@dougharness/gates/scripts/stop-gate.mjs")).toBe("// (88 events)\n");
      expect(read("cli/dist/generate/claude-md.js")).toBe("        // and cost tokens.\n");
      expect(read("cli/node_modules/@dougharness/flow/lib/untouched.mjs")).toBe("// keep me\n");
      // the dev copy is never edited
      expect(readFileSync(join(root, SKILL), "utf8")).toContain(FROM_SKILL);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("without transforms the staged text is the dev text", () => {
    const root = makeStageFixture();
    const out = join(root, "stage-out");
    try {
      expect(stageRelease(root, out).ok).toBe(true);
      expect(readFileSync(join(out, "cli/node_modules/@dougharness/flow/skills/doug-next/SKILL.md"), "utf8")).toContain(FROM_SKILL);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns ok:false naming the file when a mapped transform string is missing, and leaves no staged dir", () => {
    const root = makeStageFixture();
    const out = join(root, "stage-out");
    try {
      const res = stageRelease(root, out, {
        transforms: [...transforms, { file: SKILL, from: "a sentence that drifted away", to: "x" }],
      });
      expect(res.ok).toBe(false);
      expect(JSON.stringify(res)).toContain("doug-next/SKILL.md");
      expect(JSON.stringify(res)).toContain("a sentence that drifted away");
      expect(existsSync(join(out, "cli"))).toBe(false);
      expect(existsSync(join(out, "codex"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("ignores a transform for a file the stage does not copy", () => {
    const root = makeStageFixture();
    const out = join(root, "stage-out");
    try {
      const res = stageRelease(root, out, { transforms: [...transforms, { file: "README.md", from: "not in any package", to: "x" }] });
      expect(res.ok, JSON.stringify(res)).toBe(true);
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

describe.skipIf(distMissing)(
  `release stage applies the real TRANSFORMS to the built dist${distMissing ? " (skipped: run pnpm build first, packages/*/dist missing)" : ""}`,
  () => {
    it(
      "every mapped transform's string is found in the staged dist and replaced",
      async () => {
        const transforms = await loadTransforms(repoRoot);
        const mapped = transforms.filter((t) => stagedPathFor(repoRoot, t.file) !== null);
        expect(mapped.length).toBeGreaterThan(0);
        const mappedFiles = mapped.map((t) => t.file);
        for (const name of ["claude-md.ts", "settings.ts", "config.ts"]) {
          expect(
            mappedFiles.some((f) => String(f).includes(`packages/doug-cli/src`) && String(f).endsWith(`/${name}`)),
            `transform for packages/doug-cli/src/${name} is mapped`,
          ).toBe(true);
        }
        const out = mkdtempSync(join(tmpdir(), "release-dist-transforms-"));
        try {
          const res = stageRelease(repoRoot, out, { transforms });
          expect(res.problems ?? []).toEqual([]);
          expect(res.ok).toBe(true);
          for (const t of mapped) {
            const staged = readFileSync(join(out, stagedPathFor(repoRoot, t.file)), "utf8");
            expect(staged, `${t.file} contains its replacement`).toContain(t.to);
            if (!t.to.includes(t.from)) {
              expect(staged, `${t.file} no longer contains ${t.from}`).not.toContain(t.from);
            }
          }
        } finally {
          rmSync(out, { recursive: true, force: true });
        }
      },
      120000,
    );
  },
);

describe("release.mjs main rejection", () => {
  it("prints one release: line, no stack, and exits 1 when loadTransforms rejects", () => {
    const root = mkdtempSync(join(tmpdir(), "release-main-reject-"));
    try {
      mkdirSync(join(root, "scripts"), { recursive: true });
      cpSync(join(repoRoot, "scripts/release.mjs"), join(root, "scripts/release.mjs"));
      writeFileSync(join(root, "scripts/export-public.mjs"), 'throw new Error("boom from export-public");\n');
      const result = spawnSync(process.execPath, [join(root, "scripts/release.mjs"), "stage"], {
        encoding: "utf8",
      });
      expect(result.stderr).toContain("release: boom from export-public");
      expect(result.stderr).not.toMatch(/^\s+at /m);
      expect(result.status).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
