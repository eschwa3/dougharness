import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const binSrc = readFileSync(fileURLToPath(new URL("../src/bin.ts", import.meta.url)), "utf8");
const boardSrc = readFileSync(fileURLToPath(new URL("../src/board.ts", import.meta.url)), "utf8");

describe("doug help usage text", () => {
  it("lists every board subcommand the board dispatch switch handles", () => {
    const names = [...boardSrc.matchAll(/case "([a-z]+)":/g)].map((m) => m[1]);
    expect(names.length).toBeGreaterThan(8);
    for (const name of names) {
      expect(binSrc).toContain(`doug board ${name}`);
    }
  });

  it("lists the ablate budget and judge flags", () => {
    expect(binSrc).toContain("--max-budget-usd");
    expect(binSrc).toContain("--judge auto|codex|claude|off");
    expect(binSrc).toContain("--judge-model");
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
});
