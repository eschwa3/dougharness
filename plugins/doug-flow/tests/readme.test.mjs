import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

const root = fileURLToPath(new URL("../../../", import.meta.url));

// Three tokens that look like repo paths inside backticks but are not:
const EXCEPTIONS = Object.freeze([
  "docs/README.md", // illustrative counterexample in the plan-scope paragraph
  "docs/board.json", // the legacy fallback record path
  "docs/decisions/0002", // ADR shorthand, not a path
]);

// Files Doug writes into a project at run time (the board, the approved plan, the anchor, promoted research
// notes, the ADRs under docs/decisions, the run log docs/live-runs.md). This repository tracks its own copies, but the public export leaves them out, so there they may be
// absent: skipped only when untracked, and checked like any other path when tracked.
const RUNTIME_PATHS = Object.freeze([".doug/board.json", ".doug/plan.json", ".doug/anchor.md", "docs/research", "docs/decisions", "docs/live-runs.md"]);

function codeSpans(markdown) {
  const spans = [];
  const inlineRe = /`([^`\n]+)`/g;
  let m;
  while ((m = inlineRe.exec(markdown)) !== null) {
    spans.push(m[1]);
  }
  const fencedRe = /```[a-z]*\n([\s\S]*?)```/g;
  while ((m = fencedRe.exec(markdown)) !== null) {
    for (const line of m[1].split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length > 0) spans.push(trimmed);
    }
  }
  return spans;
}

function readRoot(relPath) {
  return readFileSync(path.join(root, relPath), "utf8");
}


const GUARDED_FILES = ["README.md", "docs/reference.md"];

describe("README guard", () => {
  it("every backticked repo path in README.md and docs/reference.md is tracked in git", () => {
    const tracked = execFileSync("git", ["ls-files"], {
      cwd: root,
      encoding: "utf8",
    })
      .split("\n")
      .filter((line) => line.length > 0);
    const trackedSet = new Set(tracked);
    const prefixSet = new Set();
    for (const file of tracked) {
      const parts = file.split("/");
      for (let i = 1; i < parts.length; i++) {
        prefixSet.add(parts.slice(0, i).join("/"));
      }
    }

    const pathRe = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+\/?$/;
    const allMissing = [];

    // card readme-scannable: reference detail moved from README.md into docs/reference.md, so the same
    // tracked-path guard runs over both files (rule B).
    for (const file of GUARDED_FILES) {
      const text = readRoot(file);
      const spans = codeSpans(text);

      const candidateSet = new Set();
      for (const span of spans) {
        const words = span.split(/[\s,;:()"]+/);
        for (let word of words) {
          word = word.replace(/[.,;:)]+$/, "");
          if (!pathRe.test(word)) continue;
          if (word.endsWith("/")) word = word.slice(0, -1);
          const firstSegment = word.split("/")[0];
          if (!trackedSet.has(firstSegment) && !prefixSet.has(firstSegment)) continue;
          candidateSet.add(word);
        }
      }

      for (const exception of EXCEPTIONS) {
        candidateSet.delete(exception);
      }
      for (const runtimePath of RUNTIME_PATHS) {
        if (!trackedSet.has(runtimePath) && !prefixSet.has(runtimePath)) candidateSet.delete(runtimePath);
      }

      const candidates = [...candidateSet];

      let ignoredSet = new Set();
      if (candidates.length > 0) {
        const stdinLines = candidates.flatMap((c) => [c, `${c}/`]);
        const result = spawnSync("git", ["check-ignore", "--stdin"], {
          cwd: root,
          input: stdinLines.join("\n"),
          encoding: "utf8",
        });
        if (result.status !== 0 && result.status !== 1) {
          throw new Error(
            `git check-ignore failed with status ${result.status}: ${result.stderr}`
          );
        }
        ignoredSet = new Set(
          result.stdout
            .split("\n")
            .map((line) => line.trim())
            .filter((line) => line.length > 0)
            .map((line) => (line.endsWith("/") ? line.slice(0, -1) : line))
        );
      }

      const checked = candidates.filter((c) => !ignoredSet.has(c));
      const missing = checked.filter(
        (c) => !trackedSet.has(c) && !prefixSet.has(c)
      );
      for (const m of missing) allMissing.push(`${file}: ${m}`);
    }

    expect(allMissing, `Missing repo paths referenced: ${allMissing.join(", ")}`).toEqual([]);
  });

  it("the exception list holds only the three documented non-paths", () => {
    expect(EXCEPTIONS).toEqual([
      "docs/README.md",
      "docs/board.json",
      "docs/decisions/0002",
    ]);
  });

  it("the runtime-path list holds only the six paths the public export leaves out", () => {
    expect(RUNTIME_PATHS).toEqual([".doug/board.json", ".doug/plan.json", ".doug/anchor.md", "docs/research", "docs/decisions", "docs/live-runs.md"]);
  });

  it("every pnpm command shown in README.md or docs/reference.md is a package.json script or a pnpm builtin", () => {
    const pkg = JSON.parse(readRoot("package.json"));
    const scripts = new Set(Object.keys(pkg.scripts || {}));
    const builtins = new Set([
      "install",
      "exec",
      "run",
      "dlx",
      "add",
      "remove",
      "why",
      "list",
    ]);

    const missing = [];
    const pnpmRe = /\bpnpm\s+([a-zA-Z0-9:._-]+)/g;
    for (const file of GUARDED_FILES) {
      const spans = codeSpans(readRoot(file));
      for (const span of spans) {
        let m;
        while ((m = pnpmRe.exec(span)) !== null) {
          const word = m[1];
          if (!builtins.has(word) && !scripts.has(word)) {
            missing.push(`${file}: ${word}`);
          }
        }
      }
    }

    expect(missing, `Unknown pnpm commands: ${missing.join(", ")}`).toEqual([]);
  });

  it("every doug command shown in README.md or docs/reference.md appears in the CLI usage", () => {
    const bin = readRoot("packages/doug-cli/src/bin.ts");
    const board = readRoot("packages/doug-cli/src/board.ts");
    const usage = bin + "\n" + board;

    const dougRe = /\bdoug\s+([a-z][a-z-]*)(?:\s+([a-z][a-z-]*))?/g;
    const missing = [];
    for (const file of GUARDED_FILES) {
      const spans = codeSpans(readRoot(file));
      for (const span of spans) {
        let m;
        while ((m = dougRe.exec(span)) !== null) {
          const [, first, second] = m;
          const firstPhrase = `doug ${first}`;
          if (!usage.includes(firstPhrase)) {
            missing.push(`${file}: ${firstPhrase}`);
            continue;
          }
          if (second) {
            const secondPhrase = `doug ${first} ${second}`;
            if (!usage.includes(secondPhrase)) {
              missing.push(`${file}: ${secondPhrase}`);
            }
          }
        }
      }
    }

    expect(missing, `doug commands not found in CLI usage: ${missing.join(", ")}`).toEqual([]);
  });

  it(
    "every test-count claim in README.md or docs/reference.md matches the measured unit suite",
    () => {
      const result = spawnSync(
        "pnpm",
        ["exec", "vitest", "list", "--exclude", "**/codex-live.test.ts", "--json"],
        {
          cwd: root,
          encoding: "utf8",
          maxBuffer: 1024 * 1024 * 64,
        }
      );

      const stdout = result.stdout || "";
      const startIdx = stdout.indexOf("[");
      expect(startIdx, `no JSON array found in vitest list output: ${stdout}`).toBeGreaterThanOrEqual(0);
      const jsonText = stdout.slice(startIdx);
      const tests = JSON.parse(jsonText);

      const testCount = tests.length;
      const fileSet = new Set(tests.map((t) => t.file));
      const fileCount = fileSet.size;

      expect(testCount).toBeGreaterThan(0);
      expect(fileCount).toBeGreaterThan(0);

      for (const file of GUARDED_FILES) {
        const text = readRoot(file);
        const lines = text.split("\n");
        for (const line of lines) {
          if (!line.includes("test:unit")) continue;

          const testsRe = /(\d[\d,]*)\s+(?:unit\s+)?tests\b/g;
          let m;
          while ((m = testsRe.exec(line)) !== null) {
            const claimed = Number(m[1].replace(/,/g, ""));
            expect(claimed, `test count claim in ${file}: ${line}`).toBe(testCount);
          }

          const filesRe = /(\d[\d,]*)\s+(?:test\s+)?files\b/g;
          while ((m = filesRe.exec(line)) !== null) {
            const claimed = Number(m[1].replace(/,/g, ""));
            expect(claimed, `file count claim in ${file}: ${line}`).toBe(fileCount);
          }
        }
      }
    },
    120000
  );

  it("the memoryUsed sentence matches the code rule in doug-implement.js (card memory-docs-drift #4)", () => {
    // card readme-scannable: the sentence may live in either file now; assert the union contains it (rule B).
    const combined = GUARDED_FILES.map((f) => readRoot(f)).join("\n");
    expect(combined).toContain("no implementer ran");
    const workflow = readRoot("plugins/doug-flow/workflows/doug-implement.js");
    expect(workflow).toContain("r.task.reuse || !r.impl ? []");
  });
});

// Helpers for the readme-scannable tests below: a minimal heading/section parser.
// A "section" runs from one `## ` heading to the next `## ` heading (or EOF).
function headings(markdown) {
  const lines = markdown.split("\n");
  const result = [];
  lines.forEach((line, idx) => {
    if (/^## /.test(line)) {
      result.push({ text: line.replace(/^## /, "").trim(), line: idx });
    }
  });
  return result;
}

function sectionBody(markdown, headingText) {
  const lines = markdown.split("\n");
  const hs = headings(markdown);
  const idx = hs.findIndex((h) => h.text === headingText);
  if (idx === -1) return null;
  const start = hs[idx].line + 1;
  const end = idx + 1 < hs.length ? hs[idx + 1].line : lines.length;
  return lines.slice(start, end).join("\n");
}

// Top-level bullets: lines starting with "- " with no leading whitespace (not nested list items).
function topLevelBullets(sectionText) {
  return sectionText
    .split("\n")
    .filter((line) => /^- /.test(line));
}

function fencedBlocks(markdown) {
  const blocks = [];
  const fencedRe = /```[a-z]*\n([\s\S]*?)```/g;
  let m;
  while ((m = fencedRe.exec(markdown)) !== null) {
    blocks.push(m[1]);
  }
  return blocks;
}

function fencedBlocksTyped(markdown, lang) {
  const blocks = [];
  const re = new RegExp("```" + lang + "\\n([\\s\\S]*?)```", "g");
  let m;
  while ((m = re.exec(markdown)) !== null) {
    blocks.push(m[1]);
  }
  return blocks;
}

function stripFences(markdown) {
  return markdown.replace(/```[\s\S]*?```/g, "");
}

// GitHub's own heading-to-anchor slug: lowercase, strip anything that isn't a word char/space/hyphen, spaces to hyphens.
function githubSlug(text) {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-");
}

function relativeLinks(markdown) {
  const linkRe = /\]\(([^)]+)\)/g;
  const links = [];
  let m;
  while ((m = linkRe.exec(markdown)) !== null) {
    const target = m[1].trim();
    if (target.startsWith("http://") || target.startsWith("https://")) continue;
    if (target.startsWith("#")) continue;
    links.push(target);
  }
  return links;
}

const REFERENCE_SECTIONS = [
  "Install from a clone",
  "Onboarding",
  "Gates",
  "The flow",
  "The board",
  "Status line",
  "The worker contract",
  "Layout",
  "Measured",
];

describe("README scannable (card readme-scannable)", () => {
  it("S1: opens '# Doug'; before the first '## ' heading: at most 3 badge lines, a <=120-char promise line naming Claude Code, and one mermaid fenced block", () => {
    const readme = readRoot("README.md");
    const lines = readme.split("\n");
    expect(lines[0], "README must open with '# Doug'").toBe("# Doug");

    const hs = headings(readme);
    expect(hs.length, "README must have at least one '## ' heading").toBeGreaterThan(0);

    const introLines = lines.slice(1, hs[0].line);
    const introText = introLines.join("\n");

    const badgeLines = introLines.filter((l) => l.trim().startsWith("[!["));
    expect(badgeLines.length, `expected at most 3 badge lines, found ${badgeLines.length}`).toBeLessThanOrEqual(3);

    const mermaidBlocks = fencedBlocksTyped(introText, "mermaid");
    expect(
      mermaidBlocks.length,
      `expected exactly one mermaid fenced block before the first '## ' heading, found ${mermaidBlocks.length}`
    ).toBe(1);

    const proseCandidates = stripFences(introText)
      .split("\n")
      .filter((l) => {
        const t = l.trim();
        return t.length > 0 && !t.startsWith("[![");
      });
    expect(proseCandidates.length, "there must be a prose line before the first '## ' heading").toBeGreaterThan(0);
    const promiseLine = proseCandidates[0].trim();
    expect(promiseLine.length, `promise line must be at most 120 chars: "${promiseLine}"`).toBeLessThanOrEqual(120);
    expect(promiseLine, `promise line must name "Claude Code": "${promiseLine}"`).toContain("Claude Code");
  });

  it("S2: 'Why Doug' is the first '## ' heading, has 3-5 top-level bullets, each starting '- **' with a tracked-path backtick span", () => {
    const readme = readRoot("README.md");
    const hs = headings(readme);
    expect(hs[0]?.text, "the first '## ' heading must be 'Why Doug'").toBe("Why Doug");

    const body = sectionBody(readme, "Why Doug");
    expect(body, "README must have a '## Why Doug' section").not.toBeNull();
    const bullets = topLevelBullets(body);
    expect(bullets.length, `expected 3-5 bullets, found ${bullets.length}`).toBeGreaterThanOrEqual(3);
    expect(bullets.length, `expected 3-5 bullets, found ${bullets.length}`).toBeLessThanOrEqual(5);

    const tracked = execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" })
      .split("\n")
      .filter((l) => l.length > 0);
    const trackedSet = new Set(tracked);
    const prefixSet = new Set();
    for (const file of tracked) {
      const parts = file.split("/");
      for (let i = 1; i < parts.length; i++) prefixSet.add(parts.slice(0, i).join("/"));
    }

    const bad = [];
    for (const bullet of bullets) {
      if (!bullet.startsWith("- **")) {
        bad.push(`does not start with '- **': ${bullet}`);
        continue;
      }
      const spans = [...bullet.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
      const hasTrackedPath = spans.some((s) => s.includes("/") && (trackedSet.has(s) || prefixSet.has(s)));
      if (!hasTrackedPath) bad.push(`no tracked-file/directory backtick span: ${bullet}`);
    }
    expect(bad, bad.join(" | ")).toEqual([]);
  });

  it("S3: 'Quickstart' is the second '## ' heading, with one fenced block of at most 4 command lines, and points to /doug-plan and docs/getting-started.md", () => {
    const readme = readRoot("README.md");
    const hs = headings(readme);
    expect(hs[1]?.text, "the second '## ' heading must be 'Quickstart'").toBe("Quickstart");

    const body = sectionBody(readme, "Quickstart");
    expect(body, "README must have a '## Quickstart' section").not.toBeNull();
    const blocks = fencedBlocks(body);
    expect(blocks.length, `expected exactly one fenced block in Quickstart, found ${blocks.length}`).toBe(1);

    const blockLines = blocks[0].split("\n").filter((l) => l.trim().length > 0);
    expect(blockLines.length, `expected at most 4 non-empty command lines, found ${blockLines.length}`).toBeLessThanOrEqual(4);
    const comments = blockLines.filter((l) => l.trim().startsWith("#"));
    expect(comments, `no comment lines allowed in the Quickstart block: ${comments.join(", ")}`).toEqual([]);

    const required = [
      "claude plugin marketplace add eschwa3/dougharness",
      "claude plugin install doug-gates@dougharness",
      "claude plugin install doug-flow@dougharness",
      "@dougharness/cli init",
    ];
    const blockText = blocks[0];
    const missing = required.filter((r) => !blockText.includes(r));
    expect(missing, `Quickstart fenced block must contain each of: ${missing.join(", ")}`).toEqual([]);

    expect(body, "Quickstart section must mention /doug-plan").toContain("/doug-plan");
    expect(body, "Quickstart section must link docs/getting-started.md").toContain("docs/getting-started.md");
  });

  it("S4: README.md is at most 100 lines", () => {
    const readme = readRoot("README.md");
    const lines = readme.split("\n");
    const lineCount = readme.endsWith("\n") ? lines.length - 1 : lines.length;
    expect(lineCount, `README.md has ${lineCount} lines, expected at most 100`).toBeLessThanOrEqual(100);
  });

  it("S5: docs/reference.md has a '## ' heading for each moved section, and README.md links each as docs/reference.md#<github-slug>", () => {
    const referenceDoc = readRoot("docs/reference.md");
    const hs = headings(referenceDoc);
    const headingTexts = new Set(hs.map((h) => h.text));
    const missingHeadings = REFERENCE_SECTIONS.filter((s) => !headingTexts.has(s));
    expect(missingHeadings, `docs/reference.md is missing headings: ${missingHeadings.join(", ")}`).toEqual([]);

    const readme = readRoot("README.md");
    const missingLinks = REFERENCE_SECTIONS.filter((s) => !readme.includes(`](docs/reference.md#${githubSlug(s)})`));
    expect(missingLinks, `README.md is missing a docs/reference.md# link for: ${missingLinks.join(", ")}`).toEqual([]);
  });

  it("S6: every plugin-install line names a real plugin and marketplace; every npm i -g / npx line names a real package (keeps T5's intent)", () => {
    const marketplace = JSON.parse(readRoot(".claude-plugin/marketplace.json"));
    const marketplaceName = marketplace.name;
    const pluginNames = new Set((marketplace.plugins || []).map((p) => p.name));

    const pkgFiles = execFileSync("git", ["ls-files", "packages/*/package.json"], {
      cwd: root,
      encoding: "utf8",
      shell: true,
    })
      .split("\n")
      .filter((l) => l.length > 0);
    const pkgNames = new Set(pkgFiles.map((f) => JSON.parse(readRoot(f)).name));

    const installRe = /(?:\/plugin install|claude plugin install) ([A-Za-z0-9._-]+)@([A-Za-z0-9._-]+)/g;
    const npmRe = /npm i(?:nstall)? -g ([^\s`]+)/g;
    const npxRe = /npx ([^\s`]+)/g;

    const badInstalls = [];
    const badNpm = [];
    const badNpx = [];

    for (const file of GUARDED_FILES) {
      const text = readRoot(file);
      let m;
      while ((m = installRe.exec(text)) !== null) {
        const [, plugin, market] = m;
        if (!pluginNames.has(plugin) || market !== marketplaceName) badInstalls.push(`${file}: ${m[0]}`);
      }
      while ((m = npmRe.exec(text)) !== null) {
        if (!pkgNames.has(m[1])) badNpm.push(`${file}: ${m[0]}`);
      }
      while ((m = npxRe.exec(text)) !== null) {
        const pkg = m[1].replace(/[.,;:)]+$/, "");
        if (!pkgNames.has(pkg)) badNpx.push(`${file}: ${m[0]}`);
      }
    }

    expect(badInstalls, `install lines must name a real plugin and the marketplace's own name (${marketplaceName}): ${badInstalls.join(", ")}`).toEqual([]);
    expect(badNpm, `npm i -g lines must name a real packages/*/package.json name (${[...pkgNames].join(", ")}): ${badNpm.join(", ")}`).toEqual([]);
    expect(badNpx, `npx lines must name a real packages/*/package.json name (${[...pkgNames].join(", ")}): ${badNpx.join(", ")}`).toEqual([]);
  });

  it("S7: every relative markdown link in README.md and docs/reference.md resolves, relative to its own file's directory, to a tracked file or directory", () => {
    const tracked = execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" })
      .split("\n")
      .filter((l) => l.length > 0);
    const trackedSet = new Set(tracked);
    const dirSet = new Set();
    for (const file of tracked) {
      const parts = file.split("/");
      for (let i = 1; i < parts.length; i++) dirSet.add(parts.slice(0, i).join("/"));
    }

    const fileDirs = { "README.md": "", "docs/reference.md": "docs" };
    const missing = [];
    for (const [file, dir] of Object.entries(fileDirs)) {
      const text = readRoot(file);
      for (const link of relativeLinks(text)) {
        const withoutAnchor = link.split("#")[0];
        if (withoutAnchor.length === 0) continue;
        const resolved = dir ? path.posix.normalize(`${dir}/${withoutAnchor}`) : path.posix.normalize(withoutAnchor);
        if (!trackedSet.has(resolved) && !dirSet.has(resolved)) {
          missing.push(`${file}: ${link} -> ${resolved}`);
        }
      }
    }
    expect(missing, `Relative links that do not resolve to a tracked path: ${missing.join(", ")}`).toEqual([]);
  });

  it("T6: the status line example (docs/reference.md, moved from README.md's 'Status line' section) reads the root package.json's version, and no 'Doug 0.1.0' appears (card statusline-installed-version)", () => {
    const referenceDoc = readRoot("docs/reference.md");
    const readme = readRoot("README.md");
    const rootPkg = JSON.parse(readRoot("package.json"));
    expect(referenceDoc).toContain(`Doug ${rootPkg.version} ·`);
    expect(referenceDoc.includes("Doug 0.1.0"), "docs/reference.md must not contain 'Doug 0.1.0'").toBe(false);
    expect(readme.includes("Doug 0.1.0"), "README.md must not contain 'Doug 0.1.0'").toBe(false);
  });
});

// Card readme-rewrite: the README's top screen sells five powers, the quickstart is three commands that match
// init-complete, memory.embeddings links to docs/memory.md, and the recall docs describe the dense ranking.
//
// Rule for "the top screen": everything before the '## Quickstart' heading (the title, promise, diagram, and the
// powers). The quickstart closes the top screen; the powers must come first. Phrases are pinned loosely
// (alternations), not exact prose.
function topScreen(readme) {
  const lines = readme.split("\n");
  const q = lines.findIndex((l) => /^## Quickstart\s*$/.test(l));
  expect(q, "README must have a '## Quickstart' heading").toBeGreaterThan(0);
  return lines.slice(0, q).join("\n");
}

// The top-level bullets and paragraphs (blank-line separated blocks) of the top screen, outside code fences.
function topBlocks(readme) {
  return stripFences(topScreen(readme)).split(/\n\s*\n/).map((b) => b.trim()).filter((b) => b.length > 0);
}

const POWERS = [
  ["gates an agent cannot talk past", [/\bgates?\b/i, /(talk(s|ed)? (its way )?past|talk(s)? (its|their) way|edit(s)? (its|their) way|cannot be (talked|argued)|can'?t (be )?(talk|argu)|cannot (be )?(talk|argu)|trust(s|ing)? (the agent|its|their)'?s? word|not (its|their|the agent'?s) word)/i]],
  ["tests written first", [/tests?[- ](are )?(written )?first|test-first|failing tests?[^.\n]{0,40}first|tests? before (the )?(code|change|implementation)/i]],
  ["every change mutation-proven", [/mutation/i]],
  ["an adversary on a different model", [/adversar/i, /(different|second|another|other|separate|independent) model|\bCodex\b/i]],
  ["memory that makes the next run better", [/\bmemory\b|\blessons?\b/i, /next (run|task|card|session)|before the next|better|improv/i]],
  ["a board that runs the queue", [/\bboard\b/i, /queue|cards?/i]],
  ["autopilot", [/autopilot/i]],
];

describe("README top screen powers (card readme-rewrite)", () => {
  it("P1: the top screen (everything before '## Quickstart') names each of the five powers by a distinctive phrase", () => {
    const top = topScreen(readRoot("README.md"));
    const missing = [];
    for (const [name, pats] of POWERS) {
      const failed = pats.filter((p) => !p.test(top));
      if (failed.length > 0) missing.push(`${name} (${failed.map(String).join(" ; ")})`);
    }
    expect(missing, `top screen is missing: ${missing.join(" | ")}`).toEqual([]);
  });

  it("P2: board and autopilot are named together in one block, with the real autopilot command /doug-next --auto", () => {
    const blocks = topBlocks(readRoot("README.md"));
    const hit = blocks.find((b) => /\bboard\b/i.test(b) && /autopilot/i.test(b));
    expect(hit, "no single top-screen bullet or paragraph names both the board and autopilot").toBeDefined();
    expect(hit, "the board/autopilot block must name `/doug-next --auto`, the real autopilot command").toContain("/doug-next --auto");
    const skill = readRoot("plugins/doug-flow/skills/doug-next/SKILL.md");
    expect(skill, "doug-next must still document --auto").toContain("--auto");
  });

  it("P3: honesty: mutation proof is a hand-track practice (the flow has no mutation stage), so the block that claims it says 'hand'", () => {
    const blocks = topBlocks(readRoot("README.md"));
    const mutationBlocks = blocks.filter((b) => /mutation/i.test(b));
    expect(mutationBlocks.length, "the top screen must mention mutation proof").toBeGreaterThan(0);
    // Reviewer finding: strip backtick spans first, or a cited path like `.../doug-hand/SKILL.md` satisfies \bhand\b.
    const unqualified = mutationBlocks.filter((b) => !/\bhand\b/i.test(b.replace(/`[^`]*`/g, "")));
    expect(unqualified, `mutation proof must be scoped to the hand track, not claimed for every flow run: ${unqualified.join(" | ")}`).toEqual([]);
    // The claim stays true of the code: the hand-track skill is where mutations are required; the flow workflow has none.
    expect(readRoot("plugins/doug-flow/skills/doug-hand/SKILL.md")).toMatch(/mutation/i);
    expect(readRoot("plugins/doug-flow/workflows/doug-implement.js")).not.toMatch(/mutation (stage|list|proof)/i);
  });

  it("P4: the top screen stays a screen: the powers and quickstart sit in the first 60 lines", () => {
    const lines = readRoot("README.md").split("\n");
    const q = lines.findIndex((l) => /^## Quickstart\s*$/.test(l));
    expect(q, `'## Quickstart' starts at line ${q + 1}`).toBeLessThan(60);
  });
});

describe("README quickstart matches init-complete (card readme-rewrite)", () => {
  // init-complete settled (docs/getting-started.md, packages/doug-cli/src/doctor.ts): the plugin install is the
  // three-command chain doctor prints as its fix line, then `doug init`, then `claude` (the final screen's step 1).
  it("Q1: the Quickstart sh block is exactly 3 commands: the doctor install chain, the cli init, then claude", () => {
    const readme = readRoot("README.md");
    const body = sectionBody(readme, "Quickstart");
    expect(body, "README must have a '## Quickstart' section").not.toBeNull();
    const blocks = fencedBlocksTyped(body, "sh");
    expect(blocks.length, "exactly one sh block in Quickstart").toBe(1);
    const cmds = blocks[0].split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
    expect(cmds.length, `Quickstart sh block must hold exactly 3 commands, found ${cmds.length}: ${cmds.join(" / ")}`).toBe(3);

    const gs = readRoot("docs/getting-started.md");
    const shellInstall = fencedBlocksTyped(gs, "sh")[0].split("\n").map((l) => l.trim()).filter(Boolean);
    expect(shellInstall.length, "getting-started's shell install block is the three plugin commands").toBe(3);
    const chain = shellInstall.join(" && ");
    expect(cmds[0], "command 1 is the documented install chain (docs/getting-started.md 'Or from a shell')").toBe(chain);
    expect(readRoot("packages/doug-cli/src/doctor.ts"), "the chain is the one doug doctor prints as its fix line").toContain(chain);

    expect(cmds[1], "command 2 is the CLI init").toMatch(/^npx @dougharness\/cli init \.$/);
    expect(gs).toContain("npx @dougharness/cli init");
    expect(cmds[2], "command 3 is `claude`, step 1 of init's final screen").toBe("claude");
    expect(gs, "init's final screen (getting-started) starts with `claude`").toMatch(/1\.\s+claude\b/);
  });
});

describe("README links memory.embeddings to docs/memory.md (card readme-rewrite)", () => {
  it("M1: a markdown link whose text names memory.embeddings points at docs/memory.md (an anchor, if any, is a real heading)", () => {
    const readme = readRoot("README.md");
    const m = readme.match(/\[[^\]]*memory\.embeddings[^\]]*\]\(docs\/memory\.md(?:#([^)]*))?\)/);
    expect(m, "no [..memory.embeddings..](docs/memory.md) link in README.md").not.toBeNull();
    if (m[1]) {
      const slugs = headings(readRoot("docs/memory.md")).map((h) => githubSlug(h.text));
      expect(slugs, `docs/memory.md has no heading for #${m[1]}`).toContain(m[1]);
    }
  });
});

describe("recall docs describe the dense ranking (card readme-rewrite, absorbs recall-docs-drift)", () => {
  const recallSection = () => sectionBody(readRoot("docs/memory.md"), "`memory.mjs recall`");

  it("D1: docs/memory.md's recall section names cosine, recency, scope, lesson-id ties, unembedded BM25 hits appended, and the BM25 fallback", () => {
    const s = recallSection();
    expect(s, "docs/memory.md must have the '## `memory.mjs recall`' section").not.toBeNull();
    const checks = {
      cosine: /cosine/i,
      recency: /recency/i,
      scope: /scope/i,
      "lesson-id ties": /ties?[^.\n]{0,60}(lesson )?id|(lesson )?id[^.\n]{0,60}ties?/i,
      "unembedded BM25 hits appended": /(append|after)[^.\n]{0,120}(no vector|without a vector|unembedded|not embedded|no stored vector)|(no vector|without a vector|unembedded|not embedded|no stored vector)[^.\n]{0,120}(append|after)/i,
      "BM25 fallback": /BM25[^.\n]{0,100}(fall ?back|fallback|keyword-only|without)|(fall ?back|fallback)[^.\n]{0,100}BM25/i,
    };
    const missing = Object.entries(checks).filter(([, re]) => !re.test(s)).map(([k]) => k);
    expect(missing, `recall section is missing: ${missing.join(", ")}`).toEqual([]);
  });

  it("D2: the recall section no longer says cosine is fused with BM25 by reciprocal rank fusion (the shipped ranking is dense)", () => {
    const s = recallSection();
    expect(s).not.toBeNull();
    expect(s).not.toMatch(/fuses BM25[^.]*reciprocal rank fusion/i);
  });

  it("D3: the Task prefixes paragraph in docs/memory.md lists the mxbai and qwen3 query prefixes, as lib/embeddings.mjs adds them", () => {
    const doc = readRoot("docs/memory.md");
    const start = doc.indexOf("**Task prefixes.**");
    expect(start, "docs/memory.md must keep its '**Task prefixes.**' paragraph").toBeGreaterThanOrEqual(0);
    const para = doc.slice(start).split(/\n\s*\n/)[0];
    expect(para, "mxbai").toMatch(/mxbai/i);
    expect(para, "qwen3").toMatch(/qwen3/i);
    expect(para, "mxbai query prefix text").toContain("Represent this sentence for searching relevant passages:");
    expect(para, "qwen3 query prefix text").toContain("Instruct: Given a web search query, retrieve relevant passages that answer the query");
    const code = readRoot("plugins/doug-flow/lib/embeddings.mjs");
    expect(code).toContain("Represent this sentence for searching relevant passages: ");
    expect(code).toContain("Instruct: Given a web search query, retrieve relevant passages that answer the query");
  });

  it("D4: the memory.mjs header usage text for `recall` describes the dense ranking", () => {
    const src = readRoot("plugins/doug-flow/scripts/memory.mjs");
    const start = src.indexOf("//   memory.mjs recall <query>");
    expect(start, "memory.mjs header must document `recall`").toBeGreaterThanOrEqual(0);
    const rest = src.slice(start).split("\n");
    const entry = [rest[0]];
    for (const line of rest.slice(1)) {
      if (/^\/\/   memory\.mjs /.test(line) || !line.startsWith("//")) break;
      entry.push(line);
    }
    const text = entry.map((l) => l.replace(/^\/\/\s*/, "")).join(" ").replace(/\s+/g, " ");
    const checks = {
      cosine: /cosine/i,
      recency: /recency/i,
      scope: /scope|--files/i,
      "lesson-id ties": /ties?[^.;]{0,60}\bid\b|\bid\b[^.;]{0,60}ties?/i,
      "unembedded BM25 hits appended": /append/i,
      "BM25 fallback": /BM25[^.;]{0,100}(fall ?back|keyword-only|without)|(fall ?back|keyword-only)[^.;]{0,100}BM25/i,
    };
    const missing = Object.entries(checks).filter(([, re]) => !re.test(text)).map(([k]) => k);
    expect(missing, `memory.mjs recall usage text is missing: ${missing.join(", ")}`).toEqual([]);
    expect(text, "usage text must not describe the old reciprocal-rank-fusion ranking as the ranking").not.toMatch(/fused by reciprocal rank fusion with cosine/i);
  });
});
