import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
// The public snapshot leaves out docs the dev repo keeps (ADRs, run log, rehearsals, releasing); scripts/export-public.mjs
// is itself excluded from the snapshot, so its absence marks it. In dev a missing doc must fail, not skip.
const IS_SNAPSHOT = !existsSync(join(repoRoot, "scripts/export-public.mjs"));

function read(relPath) {
  return readFileSync(join(repoRoot, relPath), "utf8");
}

function measuredSection(readme) {
  const lines = readme.split("\n");
  const start = lines.findIndex((l) => l === "## Measured");
  expect(start, "README.md has no '## Measured' line").toBeGreaterThanOrEqual(0);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].startsWith("## ")) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

describe("release docs", () => {
  const readme = read("README.md");
  const liveRuns = IS_SNAPSHOT ? null : read("docs/live-runs.md");
  const gettingStarted = read("docs/getting-started.md");
  const releasing = IS_SNAPSHOT ? null : read("docs/releasing.md");

  // card readme-scannable: the Measured section moved from README.md to docs/reference.md, so each Measured
  // test reads docs/reference.md itself (not at describe scope, so a missing file only reddens these three).

  it.skipIf(IS_SNAPSHOT)("the Measured section quotes at least four dollar figures, each verbatim in docs/live-runs.md", () => {
    const referenceDoc = read("docs/reference.md");
    const section = measuredSection(referenceDoc);
    const dollarMatches = section.match(/\$\d+(?:\.\d+)?/g) || [];
    expect(dollarMatches.length).toBeGreaterThanOrEqual(4);
    for (const m of dollarMatches) {
      expect(liveRuns.includes(m), `dollar figure ${m} not found verbatim in docs/live-runs.md`).toBe(true);
    }
  });

  it.skipIf(IS_SNAPSHOT)("every minute figure in the Measured section is verbatim in docs/live-runs.md", () => {
    const referenceDoc = read("docs/reference.md");
    const section = measuredSection(referenceDoc);
    const minMatches = section.match(/\b\d+(?:\.\d+)? min\b/g) || [];
    expect(minMatches.length).toBeGreaterThan(0);
    for (const m of minMatches) {
      expect(liveRuns.includes(m), `minute figure "${m}" not found verbatim in docs/live-runs.md`).toBe(true);
    }
  });

  it.skipIf(IS_SNAPSHOT)("the Measured section cites docs/live-runs.md", () => {
    const referenceDoc = read("docs/reference.md");
    const section = measuredSection(referenceDoc);
    expect(section).toContain("docs/live-runs.md");
  });

  it("README points to docs/getting-started.md", () => {
    expect(readme).toContain("docs/getting-started.md");
  });

  it("docs/getting-started.md covers the marketplace, cli, and codex install", () => {
    expect(gettingStarted).toContain("marketplace add eschwa3/dougharness");
    expect(gettingStarted).toContain("@dougharness/cli");
    expect(gettingStarted).toContain("@dougharness/codex");

    const marketplace = JSON.parse(read(".claude-plugin/marketplace.json"));
    for (const entry of marketplace.plugins) {
      const expected = `${entry.name}@${marketplace.name}`;
      expect(
        gettingStarted.includes(expected),
        `docs/getting-started.md is missing "${expected}"`,
      ).toBe(true);
    }
  });

  it("docs/getting-started.md drops the pre-release caveat but keeps the contributor pointer", () => {
    expect(gettingStarted.toLowerCase()).not.toContain("first release");
    expect(gettingStarted).not.toContain("do not work yet");
    expect(gettingStarted).toContain("onboarding.md");
    expect(gettingStarted).toContain("--plugin-dir");
  });

  it.skipIf(IS_SNAPSHOT)("docs/releasing.md covers the check, stage, validate, and publish steps", () => {
    expect(releasing).toContain("pnpm release:check");
    expect(releasing).toContain("pnpm release:stage");
    expect(releasing).toContain("claude plugin validate");
    expect(releasing).toContain("pnpm publish -r");
  });

  it.skipIf(IS_SNAPSHOT)("docs/releasing.md has a Dev setup section naming the local-plugin steps", () => {
    const lines = releasing.split("\n");
    const start = lines.findIndex((l) => l === "## Dev setup");
    expect(start, "docs/releasing.md has no '## Dev setup' line").toBeGreaterThanOrEqual(0);
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) {
      if (lines[i].startsWith("## ")) {
        end = i;
        break;
      }
    }
    const section = lines.slice(start, end).join("\n");
    expect(section).toContain("claude plugin marketplace add");
    expect(section).toContain("/reload-plugins");
    expect(section).toContain("pnpm hooks:sync");
  });
});
