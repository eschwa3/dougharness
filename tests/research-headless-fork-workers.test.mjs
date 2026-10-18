import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const RESEARCH_DIR = path.join(root, "docs/research");
const NOTE = path.join(RESEARCH_DIR, "research-headless-fork-workers.md");

// The public export deletes docs/research, so the whole suite is skipped there. The guard keys on the
// directory, never on the note: a missing note in this repo must fail, not skip.
const researchDirPresent = existsSync(RESEARCH_DIR);

function readNote() {
  return readFileSync(NOTE, "utf8");
}

// Sections split on "## " headings outside code fences.
function sections(md) {
  const out = [];
  let cur = null;
  let fenced = false;
  for (const line of md.split("\n")) {
    if (/^```/.test(line)) fenced = !fenced;
    const m = !fenced && /^## (.+)$/.exec(line);
    if (m) {
      cur = { heading: m[1].trim(), lines: [] };
      out.push(cur);
    } else if (cur) {
      cur.lines.push(line);
    }
  }
  return out;
}

// Items start with `marker` (bullet or number); indented continuation lines belong to the item.
function items(lines, marker) {
  const out = [];
  let cur = null;
  let fenced = false;
  for (const line of lines) {
    if (/^\s*```/.test(line)) fenced = !fenced;
    if (fenced) continue;
    if (marker.test(line)) {
      cur = { text: line };
      out.push(cur);
    } else if (cur && /^\s+\S/.test(line)) {
      cur.text += "\n" + line;
    } else if (/^\s*$/.test(line) || /^#/.test(line)) {
      cur = null;
    }
  }
  return out;
}

const RANKED = /ranked follow-up cards/i;

// Outside the skipIf: where docs/research exists, a missing note must fail, never skip.
describe("research-headless-fork-workers note guard", () => {
  it("fails when docs/research exists but the note does not", () => {
    if (!existsSync(RESEARCH_DIR)) return;
    expect(existsSync(NOTE), `docs/research exists but ${NOTE} is missing`).toBe(true);
  });
});

describe.skipIf(!researchDirPresent)("research-headless-fork-workers note", () => {
  it("guard keys on the docs/research directory, so a missing note fails", () => {
    expect(researchDirPresent).toBe(true);
    expect(existsSync(RESEARCH_DIR)).toBe(true);
  });

  it("the note exists at docs/research/research-headless-fork-workers.md", () => {
    expect(existsSync(NOTE), `missing ${NOTE}`).toBe(true);
    expect(readNote().trim().length).toBeGreaterThan(1000);
  });

  it("covers flow stages, hand-track seats, swarm workers and background chores, each under its own ## heading", () => {
    const heads = sections(readNote()).map((s) => s.heading);
    const areas = {
      "flow stages": /flow stage/i,
      "hand-track seats": /hand[- ]track/i,
      "swarm workers": /swarm/i,
      "background chores": /background chore|chores/i,
    };
    for (const [name, re] of Object.entries(areas)) {
      expect(
        heads.some((h) => re.test(h)),
        `no ## heading for area "${name}"; headings: ${heads.join(" | ")}`,
      ).toBe(true);
    }
  });

  it("names the seats and jobs each area is about", () => {
    const md = readNote();
    for (const word of ["verify", "review", "adversary", "tester", "coder", "reviewer", "reflect", "rehearsal", "eval"]) {
      expect(md.toLowerCase(), `note never mentions "${word}"`).toContain(word);
    }
  });

  it("every claim bullet outside the ranked list carries a source", () => {
    const secs = sections(readNote()).filter((s) => !RANKED.test(s.heading));
    const SOURCE = [
      /https?:\/\//,
      /[\w./-]+\.[a-z]{2,4}:\d+/i, // repo path with :line
      /command output/i,
      /output of/i,
      /\bunverified\b/i,
    ];
    const bare = [];
    let count = 0;
    for (const s of secs) {
      for (const it of items(s.lines, /^\s*[-*] /)) {
        count++;
        if (!SOURCE.some((re) => re.test(it.text))) bare.push(`[${s.heading}] ${it.text.split("\n")[0].slice(0, 100)}`);
      }
    }
    expect(count, "the note has no claim bullets").toBeGreaterThan(8);
    expect(bare, `claim bullets without a source:\n${bare.join("\n")}`).toEqual([]);
  });

  it.each([
    ["sub-agents", "https://code.claude.com/docs/en/sub-agents"],
    ["prompt-caching", "https://code.claude.com/docs/en/prompt-caching"],
    ["headless", "https://code.claude.com/docs/en/headless"],
    ["workflows", "https://code.claude.com/docs/en/workflows"],
  ])("cites the primary Claude Code doc %s", (_name, url) => {
    expect(readNote()).toContain(url);
  });

  it("measures efficiency from cost.mjs and the run-file stage times", () => {
    const md = readNote();
    expect(md).toMatch(/cost\.mjs/);
    expect(md).toMatch(/workflowProgress/);
    expect(md).toMatch(/wall clock/i);
    expect(md).toMatch(/USD|\$\d/);
  });

  it("states the accuracy constraint as a catch rate", () => {
    const md = readNote();
    expect(md).toMatch(/catch rate/i);
    expect(md).toMatch(/adversary/i);
  });

  it("states the fork-versus-Sonnet cost arithmetic and the cache TTL", () => {
    const md = readNote();
    expect(md).toMatch(/cache/i);
    expect(md).toMatch(/\bTTL\b/);
    expect(md).toMatch(/Opus/);
    expect(md).toMatch(/Sonnet/);
  });

  it("ends in the ranked follow-up cards section", () => {
    const secs = sections(readNote());
    expect(secs.length).toBeGreaterThan(4);
    expect(secs[secs.length - 1].heading).toMatch(RANKED);
  });

  it("each ranked card is a numbered item with a wall saving in minutes and a USD saving", () => {
    const secs = sections(readNote());
    const last = secs[secs.length - 1];
    expect(last.heading).toMatch(RANKED);
    const ranked = items(last.lines, /^\s*\d+\.\s/);
    expect(ranked.length, "fewer than 3 numbered ranked cards").toBeGreaterThanOrEqual(3);
    ranked.forEach((it, i) => {
      const label = `ranked item ${i + 1}: ${it.text.split("\n")[0].slice(0, 80)}`;
      expect(it.text, `${label} lacks a wall saving in minutes`).toMatch(/\d+(\.\d+)?\s*(-|to|–)?\s*\d*\s*min(ute)?s?\b/i);
      expect(it.text, `${label} lacks a $ saving`).toMatch(/\$\s?\d/);
    });
  });
});
