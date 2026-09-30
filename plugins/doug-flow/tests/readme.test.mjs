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
