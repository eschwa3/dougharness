import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const binSrc = readFileSync(fileURLToPath(new URL("../src/bin.ts", import.meta.url)), "utf8");
const PACKAGE_DIR = fileURLToPath(new URL("..", import.meta.url));
const pkgVersion = (JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")) as { version: string }).version;
const referenceDoc = readFileSync(fileURLToPath(new URL("../../../docs/reference.md", import.meta.url)), "utf8");
const boardSrc = readFileSync(fileURLToPath(new URL("../src/board.ts", import.meta.url)), "utf8");

describe("doug help usage text", () => {
  it("lists every board subcommand the board dispatch switch handles", () => {
    const names = [...boardSrc.matchAll(/case "([a-z]+)":/g)].map((m) => m[1]);
    expect(names.length).toBeGreaterThan(8);
    for (const name of names) {
      expect(binSrc).toContain(`doug board ${name}`);
    }
  });

  it("card board-v2-docs-reference: docs/reference.md names every board subcommand and the epic, milestone and labels init forms", () => {
    const names = [...boardSrc.matchAll(/case "([a-z]+)":/g)].map((m) => m[1]);
    for (const name of names) {
      expect(referenceDoc, `reference.md must mention doug board ${name}`).toContain(`doug board ${name}`);
    }
    expect(referenceDoc).toContain("doug board labels init");
    expect(referenceDoc).toContain("--status planned|active|done");
  });

  it("lists the ablate budget and judge flags", () => {
    expect(binSrc).toContain("--max-budget-usd");
    expect(binSrc).toContain("--judge auto|codex|claude|off");
    expect(binSrc).toContain("--judge-model");
  });

  it("card doug-doctor: the HELP text lists doug doctor [dir] [--json] with its read-only, exit-1-on-fail summary", () => {
    expect(binSrc).toContain("  doug doctor [dir] [--json]   Read-only install health check; exit 1 on any fail.");
  });

  it("m-1 (card run-report-codex-cost): board record and summary usage lines carry [--codex-cost <usd>]", () => {
    const recordIdx = binSrc.indexOf("doug board record <id> <report.json>");
    const summaryIdx = binSrc.indexOf("doug board summary <report.json>");
    expect(recordIdx, "bin.ts must document doug board record").toBeGreaterThanOrEqual(0);
    expect(summaryIdx, "bin.ts must document doug board summary").toBeGreaterThanOrEqual(0);
    const recordLine = binSrc.slice(recordIdx, binSrc.indexOf("\n", recordIdx));
    const summaryLine = binSrc.slice(summaryIdx, binSrc.indexOf("\n", summaryIdx));
    expect(recordLine, "record usage line must gain [--codex-cost <usd>]").toContain("[--codex-cost <usd>]");
    expect(summaryLine, "summary usage line must gain [--codex-cost <usd>]").toContain("[--codex-cost <usd>]");
  });

  for (const flag of ["--version", "-v"]) {
    it(`card cli-version-flag: \`doug ${flag}\` prints the package version on one line and exits 0`, () => {
      const r = spawnSync(process.execPath, ["--import", "tsx", "src/bin.ts", flag], {
        cwd: PACKAGE_DIR,
        env: { ...process.env, PATH: process.env.PATH },
        encoding: "utf8",
      });
      expect(r.status).toBe(0);
      expect(r.stdout).toBe(`${pkgVersion}\n`);
      expect(r.stdout).not.toContain("doug init detects");
    }, 60_000);
  }

  it("card cli-version-flag: the HELP text lists doug --version", () => {
    expect(binSrc).toContain("doug --version");
  });

  it("card cli-version-flag: docs/reference.md names doug --version", () => {
    expect(referenceDoc).toContain("doug --version");
  });
});
