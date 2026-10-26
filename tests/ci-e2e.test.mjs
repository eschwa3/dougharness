// Card ci-e2e (docs/specs/ci-e2e/architecture.md 5.5): docs/rehearsals.md names every replayed scenario, CI uploads the
// findings file on failure, and the CI test steps match the package.json scripts (test:e2e exists only when the
// budget fallback applied). No figure from a measurement is pinned here.
import { describe, it, expect } from "vitest";
import { existsSync, globSync, readFileSync } from "node:fs";
import { dirname, join, matchesGlob } from "node:path";
import { fileURLToPath } from "node:url";
import { SCENARIOS, HARD_SCENARIOS } from "../scripts/rehearse-lib.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const IS_SNAPSHOT = !existsSync(join(ROOT, "scripts/export-public.mjs"));
const read = (p) => readFileSync(join(ROOT, p), "utf8");

describe("ci-e2e docs and CI", () => {
  it.skipIf(IS_SNAPSHOT)("every scenario name appears in the Replays section of docs/rehearsals.md", () => {
    const docs = read("docs/rehearsals.md");
    const start = docs.indexOf("### Replays (no model, $0)");
    expect(start).toBeGreaterThan(-1);
    const end = docs.indexOf("\n## 3.", start);
    expect(end).toBeGreaterThan(start);
    const section = docs.slice(start, end);
    for (const name of [...SCENARIOS, ...HARD_SCENARIOS]) expect(section, name).toContain(`\`${name}\``);
  });

  it.skipIf(IS_SNAPSHOT)("ci.yml uploads the findings file on failure", () => {
    const ci = read(".github/workflows/ci.yml");
    expect(ci).toContain("actions/upload-artifact@v4");
    expect(ci).toMatch(/if: failure\(\)/);
    expect(ci).toContain(".doug/.state/e2e/findings.json");
    expect(ci).toMatch(/include-hidden-files:\s*true/);
  });

  it.skipIf(IS_SNAPSHOT)("ci.yml test steps match the package.json scripts", () => {
    const ci = read(".github/workflows/ci.yml");
    const scripts = JSON.parse(read("package.json")).scripts;
    const runs = [...ci.matchAll(/^\s*run:\s*(.+)$/gm)].map((m) => m[1].trim());
    if (scripts["test:e2e"]) {
      expect(runs).toContain("pnpm test:e2e");
      expect(runs).toContain("pnpm test:unit");
      expect(runs).not.toContain("pnpm test");
      expect(scripts["test:unit"]).toContain("tests/rehearse-replay.test.mjs");
      expect(scripts["test:unit"]).toContain("tests/e2e-journey.test.mjs");
      expect(scripts["test:unit"]).toContain("--exclude");
      expect(scripts.test).toBe("vitest run");
    } else {
      expect(runs).toContain("pnpm test");
    }
  });

  it.skipIf(IS_SNAPSHOT)("ci.yml references no secrets", () => {
    expect(read(".github/workflows/ci.yml")).not.toContain("secrets.");
  });
});

// Card test-unit-budget: the seven rehearse fixture suites move from test:unit to test:rehearse, and CI still runs
// every test file through one of test:unit, test:e2e, test:rehearse.
const REHEARSE_SUITES = [
  "tests/rehearse-auto.test.mjs",
  "tests/rehearse-scenarios.test.mjs",
  "tests/rehearse.test.mjs",
  "tests/rehearse-fixture-rentals.test.mjs",
  "tests/rehearse-fixture-orders.test.mjs",
  "tests/rehearse-hard-tier.test.mjs",
  "tests/rehearse-hard-assert.test.mjs",
];
const CODEX_LIVE = "packages/doug-codex/tests/codex-live.test.ts";

// Statically evaluate a `vitest run ...` script: --exclude globs drop a file; positional args are substring filters.
function runsFile(script, file) {
  const tokens = [...script.matchAll(/'([^']*)'|"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]);
  const args = tokens.slice(tokens.indexOf("run") + 1);
  const excludes = [];
  const filters = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--exclude") excludes.push(args[++i]);
    else if (args[i].startsWith("--exclude=")) excludes.push(args[i].slice(10));
    else if (!args[i].startsWith("-")) filters.push(args[i]);
  }
  if (excludes.some((g) => matchesGlob(file, g))) return false;
  return filters.length === 0 || filters.some((f) => file.includes(f));
}

describe("test-unit-budget split", () => {
  const scripts = () => JSON.parse(read("package.json")).scripts;

  it.skipIf(IS_SNAPSHOT)("package.json has test:rehearse and CI runs it", () => {
    expect(scripts()["test:rehearse"]).toBeTruthy();
    const ci = read(".github/workflows/ci.yml");
    const runs = [...ci.matchAll(/^\s*run:\s*(.+)$/gm)].map((m) => m[1].trim());
    expect(runs).toContain("pnpm test:rehearse");
  });

  it.skipIf(IS_SNAPSHOT)("test:unit excludes the seven rehearse suites; test:rehearse runs them and not the replay", () => {
    const s = scripts();
    expect(s["test:rehearse"]).toBeTruthy();
    for (const f of REHEARSE_SUITES) {
      expect(runsFile(s["test:unit"], f), `unit runs ${f}`).toBe(false);
      expect(runsFile(s["test:rehearse"], f), `rehearse skips ${f}`).toBe(true);
    }
    expect(runsFile(s["test:rehearse"], "tests/rehearse-replay.test.mjs")).toBe(false);
    expect(runsFile(s["test:e2e"], "tests/rehearse-replay.test.mjs")).toBe(true);
  });

  it.skipIf(IS_SNAPSHOT)("every test file on disk runs under test:unit, test:e2e or test:rehearse", () => {
    const s = scripts();
    const include = [
      "plugins/*/tests/**/*.test.mjs",
      "packages/*/tests/**/*.test.ts",
      "evals/tests/**/*.test.mjs",
      "tests/**/*.test.mjs",
    ];
    const files = include.flatMap((g) => globSync(g, { cwd: ROOT })).filter((f) => !f.includes("node_modules"));
    expect(files.length).toBeGreaterThan(50);
    for (const f of REHEARSE_SUITES) expect(files, f).toContain(f);
    const uncovered = files.filter(
      (f) => f !== CODEX_LIVE && !["test:unit", "test:e2e", "test:rehearse"].some((n) => s[n] && runsFile(s[n], f)),
    );
    expect(uncovered).toEqual([]);
  });
});
