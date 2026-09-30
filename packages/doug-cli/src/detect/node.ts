import type { NodeDetection, PackageManager, ScriptCommand } from "./types.js";
import { exists, firstExisting, readJson, readText } from "./fs.js";

interface PackageJson {
  packageManager?: string;
  engines?: { node?: string };
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  workspaces?: string[] | { packages?: string[] };
  prettier?: unknown;
  eslintConfig?: unknown;
  jest?: unknown;
}

const LOCKFILES: [string, PackageManager][] = [
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["bun.lockb", "bun"],
  ["bun.lock", "bun"],
  ["package-lock.json", "npm"],
];

export function runScript(pm: PackageManager, script: string): string {
  if (pm === "npm") return script === "test" || script === "start" ? `npm ${script}` : `npm run ${script}`;
  if (pm === "yarn") return `yarn ${script}`;
  if (pm === "bun") return `bun run ${script}`;
  return `pnpm ${script}`;
}

function execBin(pm: PackageManager, bin: string): string[] {
  if (pm === "npm") return ["npx", bin];
  if (pm === "yarn") return ["yarn", bin];
  if (pm === "bun") return ["bunx", bin];
  return ["pnpm", "exec", bin];
}

function pick(scripts: Record<string, string>, pm: PackageManager, names: string[]): ScriptCommand | null {
  for (const n of names) {
    if (scripts[n]) return { script: n, command: runScript(pm, n), body: scripts[n] };
  }
  return null;
}

export function detectNode(dir: string, notes: string[]): NodeDetection {
  const pkg = readJson<PackageJson>(dir, "package.json");
  const empty: NodeDetection = {
    present: false,
    packageManager: null,
    packageManagerSource: null,
    nodeVersion: null,
    nodeVersionSource: null,
    scripts: {},
    commands: { install: null, test: null, "test:unit": null, lint: null, typecheck: null, build: null, format: null },
    testFramework: null,
    singleTestCommand: null,
    formatter: null,
    linter: null,
    typescript: false,
    tsStrict: null,
    monorepo: [],
    lockfile: null,
  };
  if (!pkg) return empty;

  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  const has = (name: string) => name in deps;
  const scripts = pkg.scripts || {};

  // Package manager: packageManager field wins, then lockfile, then npm.
  let pm: PackageManager = "npm";
  let pmSource: NodeDetection["packageManagerSource"] = "default";
  const lock = LOCKFILES.find(([f]) => exists(dir, f)) || null;
  if (pkg.packageManager) {
    const name = pkg.packageManager.split("@")[0] as PackageManager;
    if (["pnpm", "npm", "yarn", "bun"].includes(name)) {
      pm = name;
      pmSource = "packageManager-field";
    }
  } else if (lock) {
    pm = lock[1];
    pmSource = "lockfile";
  }
  if (lock && pmSource === "packageManager-field" && lock[1] !== pm) {
    notes.push(`packageManager field says ${pm} but ${lock[0]} is present; using ${pm}.`);
  }

  // Node version pins.
  let nodeVersion: string | null = null;
  let nodeVersionSource: string | null = null;
  const nvmrc = readText(dir, ".nvmrc") ?? readText(dir, ".node-version");
  if (nvmrc) {
    nodeVersion = nvmrc.trim();
    nodeVersionSource = exists(dir, ".nvmrc") ? ".nvmrc" : ".node-version";
  } else if (pkg.engines?.node) {
    nodeVersion = pkg.engines.node;
    nodeVersionSource = "package.json engines.node";
  }

  // Formatter.
  let formatter: NodeDetection["formatter"] = null;
  const prettierCfg = firstExisting(dir, [
    ".prettierrc", ".prettierrc.json", ".prettierrc.js", ".prettierrc.cjs", ".prettierrc.mjs",
    ".prettierrc.yaml", ".prettierrc.yml", ".prettierrc.toml", "prettier.config.js", "prettier.config.cjs", "prettier.config.mjs",
  ]);
  const biomeCfg = firstExisting(dir, ["biome.json", "biome.jsonc"]);
  if (biomeCfg || has("@biomejs/biome")) {
    formatter = { name: "biome", command: [...execBin(pm, "biome"), "format", "--write"], extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".jsonc", ".css"] };
  } else if (prettierCfg || pkg.prettier || has("prettier")) {
    formatter = { name: "prettier", command: [...execBin(pm, "prettier"), "--write"], extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".md", ".css", ".scss", ".yaml", ".yml", ".html"] };
  }

  // Linter.
  let linter: NodeDetection["linter"] = null;
  if (biomeCfg || has("@biomejs/biome")) linter = "biome";
  else if (has("eslint") || pkg.eslintConfig || firstExisting(dir, ["eslint.config.js", "eslint.config.mjs", "eslint.config.cjs", "eslint.config.ts", ".eslintrc", ".eslintrc.js", ".eslintrc.cjs", ".eslintrc.json", ".eslintrc.yml", ".eslintrc.yaml"])) linter = "eslint";

  // Test framework and single-test syntax.
  let testFramework: NodeDetection["testFramework"] = null;
  let singleTestCommand: string | null = null;
  const runner = execBin(pm, "");
  const bin = (name: string) => [...runner.slice(0, -1), name].join(" ");
  if (has("vitest") || firstExisting(dir, ["vitest.config.ts", "vitest.config.js", "vitest.config.mts", "vitest.config.mjs"])) {
    testFramework = "vitest";
    singleTestCommand = `${bin("vitest")} run <path/to/file.test.ts>`;
  } else if (has("jest") || pkg.jest || firstExisting(dir, ["jest.config.js", "jest.config.ts", "jest.config.cjs", "jest.config.mjs", "jest.config.json"])) {
    testFramework = "jest";
    singleTestCommand = `${bin("jest")} <path/to/file.test.ts>`;
  } else if (has("mocha")) {
    testFramework = "mocha";
    singleTestCommand = `${bin("mocha")} <path/to/file.test.js>`;
  } else if (scripts.test && /node\s+--test/.test(scripts.test)) {
    testFramework = "node:test";
    singleTestCommand = "node --test <path/to/file.test.js>";
  }

  // TypeScript.
  const tsconfig = readJson<{ compilerOptions?: { strict?: boolean } }>(dir, "tsconfig.json");
  const typescript = !!tsconfig || has("typescript");
  const tsStrict = tsconfig?.compilerOptions?.strict ?? null;

  // Monorepo.
  const monorepo: NodeDetection["monorepo"] = [];
  if (exists(dir, "pnpm-workspace.yaml")) {
    const y = readText(dir, "pnpm-workspace.yaml") || "";
    const pkgs = [...y.matchAll(/^\s*-\s*["']?([^"'\n]+)["']?\s*$/gm)].map((m) => m[1].trim());
    monorepo.push({ tool: "pnpm-workspace", packages: pkgs });
  }
  if (pkg.workspaces) {
    const pkgs = Array.isArray(pkg.workspaces) ? pkg.workspaces : pkg.workspaces.packages || [];
    monorepo.push({ tool: "npm-workspaces", packages: pkgs });
  }
  if (exists(dir, "turbo.json")) monorepo.push({ tool: "turbo", packages: [] });
  if (exists(dir, "nx.json")) monorepo.push({ tool: "nx", packages: [] });
  if (exists(dir, "lerna.json")) monorepo.push({ tool: "lerna", packages: [] });

  const commands = {
    install: pm === "npm" ? "npm ci" : pm === "yarn" ? "yarn install --frozen-lockfile" : pm === "bun" ? "bun install --frozen-lockfile" : "pnpm install --frozen-lockfile",
    test: pick(scripts, pm, ["test", "test:unit", "test:ci"]),
    "test:unit": pick(scripts, pm, ["test:unit"]),
    lint: pick(scripts, pm, ["lint", "lint:ci", "eslint"]),
    typecheck: pick(scripts, pm, ["typecheck", "type-check", "tsc", "check-types", "types"]),
    build: pick(scripts, pm, ["build", "compile"]),
    format: pick(scripts, pm, ["format", "fmt", "prettier"]),
  };
  if (!commands.typecheck && typescript && scripts.build && /\btsc\b/.test(scripts.build)) {
    notes.push("No typecheck script; build runs tsc, so build doubles as the type check.");
  }

  return {
    present: true,
    packageManager: pm,
    packageManagerSource: pmSource,
    nodeVersion,
    nodeVersionSource,
    scripts,
    commands,
    testFramework,
    singleTestCommand,
    formatter,
    linter,
    typescript,
    tsStrict,
    monorepo,
    lockfile: lock ? lock[0] : null,
  };
}
