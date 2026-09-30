import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { detect } from "../src/detect/index.js";
import { generateConfig } from "../src/generate/config.js";
import { generateSkills, isDougSkill } from "../src/generate/skills.js";
import { AGENT_MARK } from "../src/generate/agents.js";

const here = dirname(fileURLToPath(import.meta.url));
const tsPnpm = join(here, "fixtures", "ts-pnpm");

function byPath(files: { path: string; content: string }[]) {
  return Object.fromEntries(files.map((f) => [f.path, f.content]));
}

function runReleaseFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "doug-skills-runrelease-"));
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "x", scripts: { dev: "vite", release: "np" } })
  );
  return dir;
}

describe("generateSkills", () => {
  it("proposes exactly six SKILL.md files plus preflight.sh, in order, for the ts-pnpm fixture (no run, no release)", () => {
    const d = detect(tsPnpm);
    // The fixture is inside this git checkout, which is what gates the pr skill.
    expect(d.repo.isGit).toBe(true);
    const cfg = generateConfig(d);
    const files = generateSkills(d, cfg);
    expect(files.map((f) => f.path)).toEqual([
      ".claude/skills/test/SKILL.md",
      ".claude/skills/migrate/SKILL.md",
      ".claude/skills/pr/SKILL.md",
      ".claude/skills/preflight/SKILL.md",
      ".claude/skills/preflight/scripts/preflight.sh",
      ".claude/skills/characterization-test/SKILL.md",
      ".claude/skills/doug-skills/SKILL.md",
    ]);
  });

  it("yields run and release, and neither test nor characterization-test, for a fixture with dev/release scripts and no test framework", () => {
    const dir = runReleaseFixture();
    const d = detect(dir);
    expect(d.node.testFramework).toBeNull();
    const cfg = generateConfig(d);
    const paths = generateSkills(d, cfg).map((f) => f.path);
    expect(paths).toContain(".claude/skills/run/SKILL.md");
    expect(paths).toContain(".claude/skills/release/SKILL.md");
    expect(paths).not.toContain(".claude/skills/test/SKILL.md");
    expect(paths).not.toContain(".claude/skills/characterization-test/SKILL.md");
  });

  it("yields exactly the manual-only doug-skills skill for a blank project with no package.json and no git", () => {
    const dir = mkdtempSync(join(tmpdir(), "doug-skills-blank-"));
    const d = detect(dir);
    expect(d.node.present).toBe(false);
    expect(d.repo.isGit).toBe(false);
    const cfg = generateConfig(d);
    const files = generateSkills(d, cfg);
    expect(files.map((f) => f.path)).toEqual([".claude/skills/doug-skills/SKILL.md"]);
    const content = files[0].content;
    expect(content).toContain("disable-model-invocation: true");
    expect(content).toContain("allowed-tools: Bash(doug init*)");
    const dryRunIdx = content.indexOf("doug init --dry-run");
    const yesIdx = content.indexOf("doug init --yes");
    expect(dryRunIdx).toBeGreaterThan(-1);
    expect(yesIdx).toBeGreaterThan(-1);
    expect(dryRunIdx).toBeLessThan(yesIdx);
  });

  it("marker: every SKILL.md carries the indented doug: generated marker under metadata, and isDougSkill recognizes every generated file including preflight.sh", () => {
    const d = detect(tsPnpm);
    const cfg = generateConfig(d);
    const files = generateSkills(d, cfg);
    for (const f of files) {
      if (f.path.endsWith("SKILL.md")) {
        expect(f.content).toContain(`metadata:\n  ${AGENT_MARK}`);
      }
      expect(isDougSkill(f.content), f.path).toBe(true);
    }
    expect(isDougSkill("---\nname: x\n---\nno marker here\n")).toBe(false);
  });

  it("marker: a SKILL.md with frontmatter but no marker is not recognized", () => {
    const noMarker = "---\nname: custom\ndescription: hand-written\n---\n\nbody\n";
    expect(isDougSkill(noMarker)).toBe(false);
  });

  it("manual-only: migrate, release, pr, preflight, doug-skills carry disable-model-invocation: true; run, test, characterization-test do not", () => {
    const d = detect(tsPnpm);
    const cfg = generateConfig(d);
    const files = byPath(generateSkills(d, cfg));
    for (const path of [
      ".claude/skills/migrate/SKILL.md",
      ".claude/skills/pr/SKILL.md",
      ".claude/skills/preflight/SKILL.md",
      ".claude/skills/doug-skills/SKILL.md",
    ]) {
      expect(files[path], path).toContain("disable-model-invocation: true");
    }
    for (const path of [".claude/skills/test/SKILL.md", ".claude/skills/characterization-test/SKILL.md"]) {
      expect(files[path], path).not.toContain("disable-model-invocation: true");
    }
  });

  it("allowed-tools: matches the test skill's exact line for the ts-pnpm fixture, and no generated file uses Bash(*)", () => {
    const d = detect(tsPnpm);
    const cfg = generateConfig(d);
    const files = byPath(generateSkills(d, cfg));
    const testSkill = files[".claude/skills/test/SKILL.md"];
    const allowedToolsLine = testSkill.split("\n").find((l) => l.startsWith("allowed-tools:"));
    expect(allowedToolsLine).toBe(`allowed-tools: Bash(${cfg.commands.test} *) Bash(${cfg.commands.test}) Edit Write Read Grep Glob`);
    for (const f of Object.values(files)) {
      expect(f).not.toContain("Bash(*)");
    }
  });

  it("allowed-tools: doug-skills is the one exception, exactly Bash(doug init*) with no Read/Grep/Glob suffix", () => {
    const d = detect(tsPnpm);
    const cfg = generateConfig(d);
    const files = byPath(generateSkills(d, cfg));
    const dougSkills = files[".claude/skills/doug-skills/SKILL.md"];
    const allowedToolsLine = dougSkills.split("\n").find((l) => l.startsWith("allowed-tools:"));
    expect(allowedToolsLine).toBe("allowed-tools: Bash(doug init*)");
  });

  it("carries the detected pm and gate commands into preflight.sh for the ts-pnpm fixture", () => {
    const d = detect(tsPnpm);
    const cfg = generateConfig(d);
    const files = byPath(generateSkills(d, cfg));
    const script = files[".claude/skills/preflight/scripts/preflight.sh"];
    expect(script.startsWith("#!/usr/bin/env bash\n")).toBe(true);
    expect(script).toContain(`# ${AGENT_MARK}`);
    expect(script).toContain("set -euo pipefail");
    for (const name of cfg.stopGate.commands) {
      expect(script).toContain(cfg.commands[name]);
    }
    const preflightSkill = files[".claude/skills/preflight/SKILL.md"];
    expect(preflightSkill).toContain('bash "${CLAUDE_SKILL_DIR}/scripts/preflight.sh"');
  });

  it("ends every SKILL.md with an empty ## Project notes section as its last heading", () => {
    const d = detect(tsPnpm);
    const cfg = generateConfig(d);
    for (const f of generateSkills(d, cfg)) {
      if (!f.path.endsWith("SKILL.md")) continue;
      expect(f.content.endsWith("\n## Project notes\n")).toBe(true);
      const headings = [...f.content.matchAll(/^## .+$/gm)].map((m) => m[0]);
      expect(headings[headings.length - 1]).toBe("## Project notes");
    }
  });

  it("is a pure function: two calls give deep-equal, byte-identical output for the ts-pnpm fixture", () => {
    const d = detect(tsPnpm);
    const cfg = generateConfig(d);
    expect(generateSkills(d, cfg)).toEqual(generateSkills(d, cfg));
  });

  it("writes byte-identical files to disk and isDougSkill still recognizes them", () => {
    const d = detect(tsPnpm);
    const cfg = generateConfig(d);
    const files = generateSkills(d, cfg);
    const outDir = mkdtempSync(join(tmpdir(), "doug-skills-out-"));
    for (const f of files) {
      const abs = join(outDir, f.path);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, f.content);
      expect(isDougSkill(f.content)).toBe(true);
    }
  });

  it("migrate names the migration directories and uses the project's own tool when no migration script exists", () => {
    const d = detect(tsPnpm);
    const cfg = generateConfig(d);
    const files = byPath(generateSkills(d, cfg));
    const migrate = files[".claude/skills/migrate/SKILL.md"];
    expect(d.repo.migrationDirs.length).toBeGreaterThan(0);
    expect(migrate).toContain(d.repo.migrationDirs[0]);
    expect(migrate).toContain("use the project's own migration tool");
  });

  it("placeholder: characterization-test's allowed-tools uses the command prefix before the placeholder, never the literal placeholder", () => {
    const d = detect(tsPnpm);
    const cfg = generateConfig(d);
    const files = byPath(generateSkills(d, cfg));
    const skill = files[".claude/skills/characterization-test/SKILL.md"];
    const allowedToolsLine = skill.split("\n").find((l) => l.startsWith("allowed-tools:"));
    expect(allowedToolsLine).toBe(
      "allowed-tools: Bash(pnpm exec vitest run *) Bash(pnpm exec vitest run) Bash(pnpm test *) Bash(pnpm test) Edit Write Read Grep Glob"
    );
    expect(skill).toContain("pnpm exec vitest run <path/to/file.test.ts>");
    for (const [path, f] of Object.entries(files)) {
      if (!path.endsWith("SKILL.md")) continue;
      const line = f.split("\n").find((l) => l.startsWith("allowed-tools:"));
      expect(line, path).not.toContain("<");
    }
  });

  it("bare form: pr's allowed-tools pairs each command with a star form and a bare form, per the repo's own bashPair rule", () => {
    const d = detect(tsPnpm);
    const cfg = generateConfig(d);
    const files = byPath(generateSkills(d, cfg));
    const pr = files[".claude/skills/pr/SKILL.md"];
    const allowedToolsLine = pr.split("\n").find((l) => l.startsWith("allowed-tools:"));
    expect(allowedToolsLine).toBe(
      "allowed-tools: Bash(git status *) Bash(git status) Bash(git diff *) Bash(git diff) Bash(git log *) Bash(git log) Bash(git add *) Bash(git add) Bash(git commit *) Bash(git commit) Bash(git push *) Bash(git push) Bash(gh pr create *) Bash(gh pr create) Read Grep Glob"
    );
  });

  it("fenced sh: every SKILL.md's Commands section is a fenced sh block, including migrate with no migration script", () => {
    const d = detect(tsPnpm);
    const cfg = generateConfig(d);
    const files = generateSkills(d, cfg);
    for (const f of files) {
      if (!f.path.endsWith("SKILL.md")) continue;
      const idx = f.content.indexOf("## Commands");
      expect(idx, f.path).toBeGreaterThan(-1);
      const after = f.content.slice(idx);
      expect(after.startsWith("## Commands\n\n```sh"), f.path).toBe(true);
    }
    const migrate = byPath(files)[".claude/skills/migrate/SKILL.md"];
    expect(migrate).toContain("use the project's own migration tool");
  });

  it("empty-string script: a package.json with empty-string dev and release scripts still yields run and release skills", () => {
    const dir = mkdtempSync(join(tmpdir(), "doug-skills-emptyscript-"));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x", scripts: { dev: "", release: "" } }));
    const d = detect(dir);
    const cfg = generateConfig(d);
    const paths = generateSkills(d, cfg).map((f) => f.path);
    expect(paths).toContain(".claude/skills/run/SKILL.md");
    expect(paths).toContain(".claude/skills/release/SKILL.md");
  });

  it("release is manual-only: release carries disable-model-invocation: true and run does not", () => {
    const dir = runReleaseFixture();
    const d = detect(dir);
    const cfg = generateConfig(d);
    const files = byPath(generateSkills(d, cfg));
    expect(files[".claude/skills/release/SKILL.md"]).toContain("disable-model-invocation: true");
    expect(files[".claude/skills/run/SKILL.md"]).not.toContain("disable-model-invocation: true");
  });
});
