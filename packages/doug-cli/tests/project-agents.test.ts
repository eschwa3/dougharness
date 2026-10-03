import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { detect } from "../src/detect/index.js";
import { generateConfig } from "../src/generate/config.js";
import { generateAgents, AGENT_MARK, LEGACY_AGENT_MARK, spliceSkills } from "../src/generate/agents.js";

// The repository's own project agents under .claude/agents are the hand-kept reference output that the
// standard-agents card's generator must reproduce byte for byte on this repository (decision 0005, card
// project-agents). This test pins their shape so a hand edit cannot drift from what a generated file looks like.
const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const AGENTS = join(ROOT, ".claude/agents");

function frontmatter(text: string): { fields: Record<string, string>; lists: Record<string, string[]>; body: string[] } {
  const lines = text.split("\n");
  expect(lines[0]).toBe("---");
  const end = lines.indexOf("---", 1);
  expect(end).toBeGreaterThan(1);
  const fields: Record<string, string> = {};
  const lists: Record<string, string[]> = {};
  let listKey: string | null = null;
  for (const line of lines.slice(1, end)) {
    // Reason (card role-skills-preload): a frontmatter `skills:` block is a YAML list, so its `  - name` item
    // lines must parse as items of the open key instead of failing the key: value shape.
    const item = /^\s+- (.*)$/.exec(line);
    if (item && listKey) {
      lists[listKey].push(item[1]);
      continue;
    }
    // Only `skills:` may open a list: a bare `model:` or `tools:` with no value is a malformed field and must
    // keep failing the key: value shape below instead of parsing as an empty list.
    const key = /^(skills):$/.exec(line);
    if (key) {
      listKey = key[1];
      lists[listKey] = [];
      continue;
    }
    listKey = null;
    const m = /^([a-zA-Z]+): (.*)$/.exec(line);
    expect(m, line).not.toBeNull();
    fields[(m as RegExpMatchArray)[1]] = (m as RegExpMatchArray)[2];
  }
  return { fields, lists, body: lines.slice(end + 1) };
}

describe("this repository's project agents", () => {
  const names = ["coder", "architect", "reviewer", "researcher", "tester"];

  it("exist, are short, and carry the doug: generated frontmatter field and an empty ## Project notes section a generated file carries", () => {
    for (const name of names) {
      const file = join(AGENTS, `${name}.md`);
      expect(existsSync(file), file).toBe(true);
      const text = readFileSync(file, "utf8");
      expect(text.endsWith("\n")).toBe(true);
      expect(text.endsWith("\n\n")).toBe(false);
      expect(text.split("\n").length - 1, `${name} lines`).toBeLessThan(40);
      const { fields } = frontmatter(text);
      expect(fields.name).toBe(name);
      expect(fields.description.startsWith('"') && fields.description.endsWith('"')).toBe(true);
      expect(fields.model).toBe("inherit");
      expect(fields.doug, name).toBe("generated");
      expect(AGENT_MARK, name).toBe("doug: generated");
      const lines = text.split("\n");
      const closingIdx = lines.indexOf("---", 1);
      expect(lines[closingIdx - 1], `${name} last frontmatter line`).toBe(AGENT_MARK);
      for (const line of lines) expect(line.startsWith("<!--"), name).toBe(false);
      expect(text.includes(LEGACY_AGENT_MARK), name).toBe(false);
      expect(text.endsWith("\n## Project notes\n"), name).toBe(true);
      expect(text).toContain("## Rules");
    }
  });

  it("makes architect, reviewer, and researcher read-only, and gives coder and tester no tools line but disallowedTools: Agent", () => {
    for (const name of ["architect", "reviewer"]) {
      const { fields } = frontmatter(readFileSync(join(AGENTS, `${name}.md`), "utf8"));
      expect(fields.tools).toBe("Read, Grep, Glob, Bash");
      expect(fields.disallowedTools).toBe("Edit, Write, MultiEdit, NotebookEdit");
    }
    const researcher = frontmatter(readFileSync(join(AGENTS, "researcher.md"), "utf8")).fields;
    expect(researcher.tools).toBe("Read, Grep, Glob, Bash, WebFetch, WebSearch");
    expect(researcher.disallowedTools).toBe("Edit, Write, MultiEdit, NotebookEdit");
    for (const name of ["coder", "tester"]) {
      const { fields } = frontmatter(readFileSync(join(AGENTS, `${name}.md`), "utf8"));
      expect(fields.tools).toBeUndefined();
      expect(fields.disallowedTools).toBe("Agent");
    }
  });

  it("keeps the hand-written flow-debugger read-only and pointed at the run's journal and report", () => {
    const text = readFileSync(join(AGENTS, "flow-debugger.md"), "utf8");
    const { fields, body } = frontmatter(text);
    expect(fields.name).toBe("flow-debugger");
    expect(fields.tools).toBe("Read, Grep, Glob, Bash");
    expect(fields.disallowedTools).toBe("Edit, Write, MultiEdit, NotebookEdit");
    expect(body[0]).toContain("Kept by hand");
    for (const s of ["journal.jsonl", "last-report.json", "stopReason", "harness defect", "code defect", "doug-implement.js", "verbatim"]) expect(text).toContain(s);
  });

  it("carries only this repository's detected commands as facts", () => {
    const coder = readFileSync(join(AGENTS, "coder.md"), "utf8");
    expect(coder).toContain("- Use pnpm only.");
    expect(coder).toContain("- Run one test file with: pnpm exec vitest run <path/to/file.test.ts>");
    expect(coder).toContain("- Before finishing run: pnpm typecheck then pnpm test:unit");
    expect(coder).toContain("- Monorepo (pnpm-workspace,npm-workspaces): run scripts from the package you are changing.");
    expect(coder).not.toContain("npm ci");
    const reviewer = readFileSync(join(AGENTS, "reviewer.md"), "utf8");
    expect(reviewer).toContain("- CI: .github/workflows/ci.yml. Mirror its checks locally.");
    // card mutation-check-contract: a mechanism-exists card's tests can pass with the mechanism gone, so the
    // reviewer is told to mutate rather than only read.
    expect(reviewer).toContain("mutate or remove it, rerun the test, and confirm it fails before reverting");
    const tester = readFileSync(join(AGENTS, "tester.md"), "utf8");
    expect(tester).toContain("Writes and runs tests with vitest");
    expect(tester).not.toContain("Before finishing run");
    const researcher = readFileSync(join(AGENTS, "researcher.md"), "utf8");
    expect(researcher).toContain("- Use pnpm only.");
    expect(researcher).not.toContain("Before finishing run");
    expect(researcher).toContain("unverified");
    // Card research-fetch-cap, pass 2 (P1): the checked-in project researcher carries the whole budget rule,
    // the same full sentence as the plugin one, not just the fragment naming the cap.
    expect(researcher).toContain(
      "Budget: at most 6 WebSearch, WebFetch, curl, or wget calls for your question, counted together (research.maxFetches; a hook denies the next one). Try sources in the order the question lists them, and write your findings before the budget runs out, marking anything still unanswered unverified."
    );
    // Card researcher-line-numbers: quotes carry a line number from the raw page.
    expect(researcher).toContain(
      "Primary sources first (official docs, the tool's own --help, the package's repository); quote a page verbatim with its line number in the raw page (curl -sL <url> | grep -n '<phrase>'), or the command and its output, and say whether it was observed or documented; a quote without a line is marked no line."
    );
  });

  it("reproduces this repository's checked-in agent files byte for byte from this repository's own detection", () => {
    // card generated-agents-drift: every assertion above is a toContain, so it catches only a removed or
    // reworded substring, not an added line, a deleted-but-otherwise-fine line, or a whitespace change. This
    // compares the WHOLE file (frontmatter included, not just the body below AGENT_MARK): the generator emits
    // the whole file, the whole file is what `doug init` would overwrite a hand-kept file with, so the whole
    // file is what must be pinned. The existing line-by-line frontmatter assertions above stay: they're cheap
    // and they localize a failure to a field instead of just a line number.
    const d = detect(ROOT);
    const cfg = generateConfig(d);
    const files = generateAgents(d, cfg);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const diskPath = join(ROOT, file.path);
      expect(existsSync(diskPath), `${file.path}: generateAgents emits this path but no such file is checked in`).toBe(true);
      const disk = readFileSync(diskPath, "utf8");
      // Reason (card role-skills-preload): the frontmatter `skills:` block is user-owned by design (like
      // `## Project notes`), so a refresh keeps it and the generator never emits it; compare against the
      // generated text with the disk's own block spliced in.
      const expected = spliceSkills(file.content, disk);
      if (disk === expected) continue;
      const diskLines = disk.split("\n");
      const genLines = expected.split("\n");
      let line = 1;
      while (diskLines[line - 1] === genLines[line - 1]) line++;
      throw new Error(
        `${file.path} line ${line} differs from generateAgents' output:\n` +
          `  checked-in: ${JSON.stringify(diskLines[line - 1])}\n` +
          `  generated:  ${JSON.stringify(genLines[line - 1])}`
      );
    }
  });

  it("preloads exactly harness-fix in coder, tester and reviewer, and nothing in architect and researcher (card role-skills-preload)", () => {
    for (const name of ["coder", "tester", "reviewer"]) {
      const { lists } = frontmatter(readFileSync(join(AGENTS, `${name}.md`), "utf8"));
      expect(lists.skills, name).toEqual(["harness-fix"]);
    }
    for (const name of ["architect", "researcher"]) {
      const { lists, fields } = frontmatter(readFileSync(join(AGENTS, `${name}.md`), "utf8"));
      expect(lists.skills, name).toBeUndefined();
      expect(fields.skills, name).toBeUndefined();
    }
  });

  it("never emits flow-debugger.md, so the hand-kept file can't be swept in and clobbered", () => {
    // flow-debugger.md is hand-kept with no generator counterpart (it documents reading a specific run's
    // journal and report, which generateAgents has no facts about). It is excluded here not by a hand-written
    // name list but simply because generateAgents never produces that path: the loop above only ever touches
    // paths generateAgents returns, so a file the generator doesn't know about can never be read, compared, or
    // (later, in doug init) overwritten by it. This assertion pins that: if generateAgents ever grew a
    // "flow-debugger" spec, this would need a deliberate decision, not a silent sweep-in.
    const d = detect(ROOT);
    const cfg = generateConfig(d);
    const files = generateAgents(d, cfg);
    expect(files.map((f) => f.path)).not.toContain(".claude/agents/flow-debugger.md");
  });
});
