import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { detect } from "../src/detect/index.js";
import { generateConfig } from "../src/generate/config.js";
import { generateAgents, AGENT_MARK, LEGACY_AGENT_MARK, isDougAgent, spliceProjectNotes } from "../src/generate/agents.js";

const here = dirname(fileURLToPath(import.meta.url));
const tsPnpm = join(here, "fixtures", "ts-pnpm");
const npmBare = join(here, "fixtures", "npm-bare");

function noTestFrameworkDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "doug-agents-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x" }));
  return dir;
}

function byPath(files: { path: string; content: string }[]) {
  return Object.fromEntries(files.map((f) => [f.path, f.content]));
}

describe("generateAgents", () => {
  it("proposes coder, architect, reviewer, researcher, tester in order for ts-pnpm (has a test framework)", () => {
    const d = detect(tsPnpm);
    const cfg = generateConfig(d);
    const files = generateAgents(d, cfg);
    expect(files.map((f) => f.path)).toEqual([
      ".claude/agents/coder.md",
      ".claude/agents/architect.md",
      ".claude/agents/reviewer.md",
      ".claude/agents/researcher.md",
      ".claude/agents/tester.md",
    ]);
  });

  it("omits tester when no test framework is detected", () => {
    const dir = noTestFrameworkDir();
    const d = detect(dir);
    const cfg = generateConfig(d);
    const files = generateAgents(d, cfg);
    expect(files.map((f) => f.path)).toEqual([
      ".claude/agents/coder.md",
      ".claude/agents/architect.md",
      ".claude/agents/reviewer.md",
      ".claude/agents/researcher.md",
    ]);
  });

  it("proposes coder, architect, reviewer, researcher, tester in order for npm-bare (has a test framework)", () => {
    const d = detect(npmBare);
    const cfg = generateConfig(d);
    const files = generateAgents(d, cfg);
    expect(d.node.testFramework).toBeTruthy();
    expect(files.map((f) => f.path)).toEqual([
      ".claude/agents/coder.md",
      ".claude/agents/architect.md",
      ".claude/agents/reviewer.md",
      ".claude/agents/researcher.md",
      ".claude/agents/tester.md",
    ]);
  });

  function frontmatterLines(content: string): string[] {
    const lines = content.split("\n");
    const end = lines.indexOf("---", 1);
    return lines.slice(0, end + 1);
  }

  it("sets complete, exact frontmatter per role, with tools/disallowedTools only for read-only roles", () => {
    const d = detect(tsPnpm);
    const cfg = generateConfig(d);
    const files = byPath(generateAgents(d, cfg));

    expect(frontmatterLines(files[".claude/agents/coder.md"])).toEqual([
      "---",
      "name: coder",
      `description: ${JSON.stringify(
        "Implements a requested change in this repository, runs its checks, and reports what it ran"
      )}`,
      "model: inherit",
      "disallowedTools: Agent",
      "doug: generated",
      "---",
    ]);

    expect(frontmatterLines(files[".claude/agents/architect.md"])).toEqual([
      "---",
      "name: architect",
      `description: ${JSON.stringify(
        "Reads the code and returns a design: files to change, tests to add, and the command that verifies each; writes no code"
      )}`,
      "model: inherit",
      "tools: Read, Grep, Glob, Bash",
      "disallowedTools: Edit, Write, MultiEdit, NotebookEdit",
      "doug: generated",
      "---",
    ]);

    expect(frontmatterLines(files[".claude/agents/reviewer.md"])).toEqual([
      "---",
      "name: reviewer",
      `description: ${JSON.stringify(
        "Reviews a diff against its request, runs the project checks, and reports blocker, major, and minor findings; never edits"
      )}`,
      "model: inherit",
      "tools: Read, Grep, Glob, Bash",
      "disallowedTools: Edit, Write, MultiEdit, NotebookEdit",
      "doug: generated",
      "---",
    ]);

    // The researcher is read-only on the checkout and may read the web; it is the one role with a wider tools line.
    expect(frontmatterLines(files[".claude/agents/researcher.md"])).toEqual([
      "---",
      "name: researcher",
      `description: ${JSON.stringify(
        "Answers one question about a fact outside this repository (a CLI's output, a third-party API, a package's constraints) from primary sources, quoting each fact's URL or command output and marking the rest unverified; never writes"
      )}`,
      "model: inherit",
      "tools: Read, Grep, Glob, Bash, WebFetch, WebSearch",
      "disallowedTools: Edit, Write, MultiEdit, NotebookEdit",
      "doug: generated",
      "---",
    ]);

    expect(frontmatterLines(files[".claude/agents/tester.md"])).toEqual([
      "---",
      "name: tester",
      `description: ${JSON.stringify(
        `Writes and runs tests with ${d.node.testFramework} for a named behavior; edits test files only`
      )}`,
      "model: inherit",
      "disallowedTools: Agent",
      "doug: generated",
      "---",
    ]);
  });

  it("gives every writable role disallowedTools: Agent and no tools line, and keeps Agent out of every read-only role's tools allowlist", () => {
    const d = detect(tsPnpm);
    const cfg = generateConfig(d);
    const files = byPath(generateAgents(d, cfg));
    for (const path of [".claude/agents/coder.md", ".claude/agents/tester.md"]) {
      const lines = frontmatterLines(files[path]);
      expect(lines, path).toContain("disallowedTools: Agent");
      expect(lines.find((l) => l.startsWith("tools:")), path).toBeUndefined();
    }
    for (const path of [".claude/agents/architect.md", ".claude/agents/reviewer.md", ".claude/agents/researcher.md"]) {
      const toolsLine = frontmatterLines(files[path]).find((l) => l.startsWith("tools:"));
      expect(toolsLine, path).toBeDefined();
      expect(toolsLine, path).not.toContain("Agent");
    }
  });

  it("puts doug: generated as the last frontmatter line and keeps the HTML comment out of the body entirely, with every file under 40 lines", () => {
    const d = detect(tsPnpm);
    const cfg = generateConfig(d);
    const files = generateAgents(d, cfg);
    for (const f of files) {
      const lines = f.content.split("\n");
      const closingIdx = lines.indexOf("---", 1);
      expect(closingIdx).toBeGreaterThan(0);
      expect(lines[closingIdx - 1]).toBe(AGENT_MARK);
      expect(AGENT_MARK).toBe("doug: generated");
      for (const line of lines) expect(line.startsWith("<!--")).toBe(false);
      const firstBodyLine = lines[closingIdx + 1];
      expect(["", "## Facts", "## Rules"]).toContain(firstBodyLine);
      expect(lines.length).toBeLessThan(40);
    }
  });

  it("ends every generated file with an empty ## Project notes section as its last heading, with exactly one trailing newline", () => {
    const d = detect(tsPnpm);
    const cfg = generateConfig(d);
    const files = generateAgents(d, cfg);
    for (const f of files) {
      expect(f.content.endsWith("\n## Project notes\n")).toBe(true);
      expect(f.content.endsWith("\n\n")).toBe(false);
      const headings = [...f.content.matchAll(/^## .+$/gm)].map((m) => m[0]);
      expect(headings[headings.length - 1]).toBe("## Project notes");
    }
  });

  it("carries detected pm, single-test, and gate commands into coder for ts-pnpm", () => {
    const d = detect(tsPnpm);
    const cfg = generateConfig(d);
    const files = byPath(generateAgents(d, cfg));
    const coder = files[".claude/agents/coder.md"];
    expect(coder).toContain("pnpm exec vitest run <path/to/file.test.ts>");
    expect(coder).toContain("pnpm typecheck then pnpm lint then pnpm test");
    expect(coder).not.toContain("npm ci");
  });

  it("prefers a test:unit script over test in coder's gate fact and the config's stopGate.commands", () => {
    const dir = mkdtempSync(join(tmpdir(), "doug-agents-testunit-"));
    cpSync(tsPnpm, dir, { recursive: true });
    const pkg = JSON.parse(readFileSync(join(tsPnpm, "package.json"), "utf8"));
    pkg.scripts["test:unit"] = "vitest run --exclude live";
    writeFileSync(join(dir, "package.json"), JSON.stringify(pkg));
    const d = detect(dir);
    const cfg = generateConfig(d);
    expect(cfg.stopGate.commands).toEqual(["typecheck", "lint", "test:unit"]);
    const files = byPath(generateAgents(d, cfg));
    const coder = files[".claude/agents/coder.md"];
    expect(coder).toContain("pnpm typecheck then pnpm lint then pnpm test:unit");
  });

  it("carries the detected test framework's single-test command into tester for npm-bare", () => {
    const d = detect(npmBare);
    const cfg = generateConfig(d);
    const files = byPath(generateAgents(d, cfg));
    const tester = files[".claude/agents/tester.md"];
    expect(tester).toContain("node --test");
  });

  it("tells the reviewer to mutate the mechanism rather than only read the diff (card mutation-check-contract)", () => {
    const d = detect(tsPnpm);
    const cfg = generateConfig(d);
    const reviewer = byPath(generateAgents(d, cfg))[".claude/agents/reviewer.md"];
    expect(reviewer).toContain("mutate or remove it, rerun the test, and confirm it fails before reverting");
  });

  it("T9 tells the tester to end a red-by-design report with the tests_red_by_design claim (card subagent-stop-gate-tester-red)", () => {
    const d = detect(tsPnpm);
    const cfg = generateConfig(d);
    const tester = byPath(generateAgents(d, cfg))[".claude/agents/tester.md"];
    expect(tester).toContain(
      'When your new tests are meant to stay red until the coder\'s change, end your final message with a JSON object {"tests_red_by_design": ["<test file>", ...]} naming every test file you left failing by its repository-relative path, report the red once, and do not rerun the suite to make a gate pass.'
    );
  });

  // 2026-09-25 (card tests-only-card-skips-coder): a hand card whose goal says tests only (no production
  // change) runs as tester then reviewer, with no coder; the tester runs the brief's mutation list itself.
  // No production code exists yet, so this is red by design.
  it("S3: tells the tester to run a tests-only card's mutation list itself, in a scratch copy, never touching a production file (card tests-only-card-skips-coder)", () => {
    const d = detect(tsPnpm);
    const cfg = generateConfig(d);
    const tester = byPath(generateAgents(d, cfg))[".claude/agents/tester.md"];
    expect(tester).toContain(
      "On a tests-only card, run the brief's mutation list yourself in a scratch copy or git worktree under `.doug/.state`, run the one test file there, report each result, and remove the copy; never edit a production file in the live checkout."
    );
  });

  it("tells the tester the claim may sit in the plain-text message or the hand-back, and the gate reads plain text first (card tester-claim-missed-in-handback)", () => {
    const d = detect(tsPnpm);
    const cfg = generateConfig(d);
    const tester = byPath(generateAgents(d, cfg))[".claude/agents/tester.md"];
    expect(tester).toContain(
      "Put that JSON line either as the last line of your final plain-text message or inside your hand-back message: the SubagentStop gate reads your last plain-text message first and, when that holds no claim, your last hand-back call."
    );
  });

  it("T1 tells the coder to stop and report a test-vs-brief conflict instead of changing production to fit the test (card coder-stops-on-test-brief-conflict)", () => {
    const d = detect(tsPnpm);
    const cfg = generateConfig(d);
    const coder = byPath(generateAgents(d, cfg))[".claude/agents/coder.md"];
    expect(coder).toContain(
      "When a test contradicts the brief or the card's goal, do not change production code to fit the test; stop and report the conflict, quoting both, so the lead can send it back to the tester."
    );
  });

  it("gives the researcher the package manager fact only, and the unverified and never-install rules", () => {
    const d = detect(tsPnpm);
    const cfg = generateConfig(d);
    const researcher = byPath(generateAgents(d, cfg))[".claude/agents/researcher.md"];
    expect(researcher).toContain("- Use pnpm only.");
    expect(researcher).not.toContain("Before finishing run");
    expect(researcher).not.toContain("Run one test file");
    for (const s of ["one question", "Primary sources first", "Never install", "unverified", "never guess"]) expect(researcher).toContain(s);
  });

  it("caps the generated researcher's WebSearch plus WebFetch calls at research.maxFetches, enforced by a hook (card research-fetch-cap)", () => {
    const d = detect(tsPnpm);
    const cfg = generateConfig(d);
    const researcher = byPath(generateAgents(d, cfg))[".claude/agents/researcher.md"];
    // Pass 2, P1: the generated researcher gets the whole rule, not just the fragment naming the cap.
    expect(researcher).toContain(
      "Budget: at most 6 WebSearch plus WebFetch calls for your question (research.maxFetches; a hook denies the next one). Try sources in the order the question lists them, and write your findings before the budget runs out, marking anything still unanswered unverified."
    );
  });

  it("omits single-test and gate facts from coder when nothing was detected", () => {
    const dir = noTestFrameworkDir();
    const d = detect(dir);
    const cfg = generateConfig(d);
    const files = byPath(generateAgents(d, cfg));
    const coder = files[".claude/agents/coder.md"];
    expect(coder).not.toContain("Run one test file");
    expect(coder).not.toContain("Before finishing run");
  });

  it("is a pure function: two calls give deep-equal arrays", () => {
    const d = detect(tsPnpm);
    const cfg = generateConfig(d);
    expect(generateAgents(d, cfg)).toEqual(generateAgents(d, cfg));
  });

  it("isDougAgent: true for new-form (doug: generated in frontmatter) and old-form (LEGACY_AGENT_MARK) files, false with neither, false when doug: generated is only in the body", () => {
    const newForm = "---\nname: coder\ndoug: generated\n---\n\nbody text\n";
    expect(isDougAgent(newForm)).toBe(true);
    const oldForm = `${LEGACY_AGENT_MARK}\nsome text`;
    expect(isDougAgent(oldForm)).toBe(true);
    expect(isDougAgent("---\nname: coder\n---\nhand-written, no marker")).toBe(false);
    const inBodyOnly = "---\nname: coder\n---\ndoug: generated\n";
    expect(isDougAgent(inBodyOnly)).toBe(false);
  });

  it("isDougAgent (MAJOR, reviewer, anchoring): a later '---' with no opening fence is a horizontal rule, not a closing fence, even when a line reads doug: generated", () => {
    // The first line isn't "---", so there is no real frontmatter block for the later "---" to close.
    const noFrontmatterAtAll = "intro\ndoug: generated\nmore\n---\nrest\n";
    expect(isDougAgent(noFrontmatterAtAll)).toBe(false);
  });

  it("isDougAgent (MINOR, reviewer, CRLF): a Windows checkout with \\r\\n line endings still refreshes", () => {
    const crlf = "---\r\nname: coder\r\ndoug: generated\r\n---\r\nbody\r\n";
    expect(isDougAgent(crlf)).toBe(true);
  });

  it("writes byte-identical files to disk that isDougAgent still recognizes under the new doug: generated form, each ending in exactly one trailing newline and with no HTML comment", () => {
    const d = detect(tsPnpm);
    const cfg = generateConfig(d);
    const files = generateAgents(d, cfg);
    const outDir = mkdtempSync(join(tmpdir(), "doug-agents-out-"));
    mkdirSync(join(outDir, ".claude", "agents"), { recursive: true });
    for (const f of files) {
      expect(f.content.endsWith("\n")).toBe(true);
      expect(f.content.endsWith("\n\n")).toBe(false);
      expect(f.content.includes("<!--")).toBe(false);
      const abs = join(outDir, f.path);
      writeFileSync(abs, f.content);
      const readBack = readFileSync(abs, "utf8");
      expect(readBack).toBe(f.content);
      expect(isDougAgent(readBack)).toBe(true);
    }
  });

  it("quotes the description so a colon inside it cannot break YAML frontmatter", () => {
    const d = detect(tsPnpm);
    const cfg = generateConfig(d);
    const files = byPath(generateAgents(d, cfg));
    const architect = files[".claude/agents/architect.md"];
    const descriptionLine = architect.split("\n").find((l) => l.startsWith("description:"));
    // The architect description contains "design:", which would end the YAML
    // mapping value early if emitted unquoted. It must be a valid double-quoted
    // YAML scalar instead.
    expect(descriptionLine).toBe(
      `description: ${JSON.stringify(
        "Reads the code and returns a design: files to change, tests to add, and the command that verifies each; writes no code"
      )}`
    );
    expect(descriptionLine).toMatch(/^description: ".*"$/);
  });

  it("spliceProjectNotes carries an existing ## Project notes section verbatim across a refresh, and no-ops when the existing file has no such heading", () => {
    const generated =
      "---\nname: coder\ndoug: generated\n---\n\n## Rules\n\n- rule one\n\n## Project notes\n";
    const existing =
      "---\nname: coder\ndoug: generated\n---\n\n## Rules\n\n- rule one (stale)\n\n## Project notes\n" +
      "- Never add commit trailers.\n- Two tracks: see docs/decisions/0005.\n- Ask before touching CI.\n";
    const result = spliceProjectNotes(generated, existing);
    const genHeadingIdx = generated.indexOf("## Project notes");
    const existingHeadingIdx = existing.indexOf("## Project notes");
    const expected = generated.slice(0, genHeadingIdx) + existing.slice(existingHeadingIdx);
    expect(result).toBe(expected);
    expect(result.endsWith("- Ask before touching CI.\n")).toBe(true);

    const oldFormExisting = `${LEGACY_AGENT_MARK}\nstale body, no heading\n`;
    expect(spliceProjectNotes(generated, oldFormExisting)).toBe(generated);
  });

  it("spliceProjectNotes (3a): a decoy line that merely mentions ## Project notes mid-line splices from the real heading, not the decoy (MINOR, reviewer)", () => {
    const generated =
      "---\nname: coder\ndoug: generated\n---\n\n## Rules\n\n- rule one\n\n## Project notes\n";
    const customContent = "- Never add commit trailers.\n";
    const withDecoyLine =
      "---\nname: coder\ndoug: generated\n---\n\n## Rules\n\n- rule one (stale)\nsee ## Project notes below\n\n## Project notes\n" +
      customContent;
    const result = spliceProjectNotes(generated, withDecoyLine);
    const genHeadingIdx = generated.indexOf("## Project notes");
    const realHeadingIdx = withDecoyLine.lastIndexOf("## Project notes");
    const expected = generated.slice(0, genHeadingIdx) + withDecoyLine.slice(realHeadingIdx);
    expect(result).toBe(expected);
    expect(result.endsWith(customContent)).toBe(true);
    expect(result).not.toContain("see ## Project notes below");
  });

  it("spliceProjectNotes (3b): a file with only a ### Project notes heading (one hash too many) has no section, so the generated file comes back unchanged (MINOR, reviewer)", () => {
    const generated =
      "---\nname: coder\ndoug: generated\n---\n\n## Rules\n\n- rule one\n\n## Project notes\n";
    const customContent = "- Never add commit trailers.\n";
    const onlyThreeHashHeading =
      "---\nname: coder\ndoug: generated\n---\n\n## Rules\n\n- rule one (stale)\n\n### Project notes\n" + customContent;
    expect(spliceProjectNotes(generated, onlyThreeHashHeading)).toBe(generated);
  });

  it("spliceProjectNotes splices from the FIRST ## Project notes heading when an existing file has two, preserving both to EOF verbatim (pin, MINOR reviewer)", () => {
    const generated =
      "---\nname: coder\ndoug: generated\n---\n\n## Rules\n\n- rule one\n\n## Project notes\n";
    const existing =
      "---\nname: coder\ndoug: generated\n---\n\n## Rules\n\n- rule one (stale)\n\n## Project notes\n" +
      "- first section content\n\n## Project notes\n- duplicated heading, kept verbatim\n";
    const result = spliceProjectNotes(generated, existing);
    const genHeadingIdx = generated.indexOf("## Project notes");
    const firstExistingHeadingIdx = existing.indexOf("## Project notes");
    const expected = generated.slice(0, genHeadingIdx) + existing.slice(firstExistingHeadingIdx);
    expect(result).toBe(expected);
    expect(result).toContain("- first section content");
    expect(result).toContain("- duplicated heading, kept verbatim");
    // The whole tail from the first heading, second heading line included, must be carried byte for byte.
    expect(result.endsWith("- duplicated heading, kept verbatim\n")).toBe(true);
  });

  // 2026-09-15 (card agents-reference-test): project-agents.test.ts line 103 walks only the generator's
  // side — it iterates generateAgents' files and compares each to disk, so it never visits a doug-marked
  // file on disk the generator doesn't emit, and a dropped or reordered role passes it too (the loop only
  // ever touches paths generateAgents returns). This test is the disk-side complement: it lists what's
  // actually in .claude/agents and compares that set, and the path order, against what the generator emits.
  it("reproduces this repository's .claude/agents byte for byte: same paths in the same order, identical content, and nothing doug-marked on disk that the generator does not emit (card agents-reference-test)", () => {
    const root = fileURLToPath(new URL("../../..", import.meta.url));
    const d = detect(root);
    const cfg = generateConfig(d);
    const files = generateAgents(d, cfg);

    expect(files.map((f) => f.path)).toEqual([
      ".claude/agents/coder.md",
      ".claude/agents/architect.md",
      ".claude/agents/reviewer.md",
      ".claude/agents/researcher.md",
      ".claude/agents/tester.md",
    ]);

    const agentsDir = join(root, ".claude/agents");
    const dougMarkedOnDisk = readdirSync(agentsDir)
      .filter((name) => isDougAgent(readFileSync(join(agentsDir, name), "utf8")))
      .map((name) => `.claude/agents/${name}`)
      .sort();
    const generatedPaths = files.map((f) => f.path).sort();
    const extra = dougMarkedOnDisk.filter((p) => !generatedPaths.includes(p));
    const missing = generatedPaths.filter((p) => !dougMarkedOnDisk.includes(p));
    expect(
      dougMarkedOnDisk,
      `extra doug-marked path(s) on disk not emitted by generateAgents: ${JSON.stringify(extra)}; missing generated path(s) not found on disk: ${JSON.stringify(missing)}`
    ).toEqual(generatedPaths);

    for (const file of files) {
      const diskPath = join(root, file.path);
      expect(readFileSync(diskPath, "utf8"), file.path).toBe(file.content);
    }
  });
});
