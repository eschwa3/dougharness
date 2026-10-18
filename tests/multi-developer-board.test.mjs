import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const RESEARCH_DIR = path.join(root, "docs/research");
const PROPOSALS_DIR = path.join(root, "docs/proposals");
const NOTE = path.join(RESEARCH_DIR, "multi-developer-board.md");
const ADR = path.join(PROPOSALS_DIR, "multi-developer-board.md");

// The public export deletes docs/research and docs/proposals, so the suites skip there. Guards key on the
// directories, never on the files: a missing note or ADR where the directory exists must fail, not skip.
const notePresentDir = existsSync(RESEARCH_DIR);
const adrPresentDir = existsSync(PROPOSALS_DIR);

const readNote = () => readFileSync(NOTE, "utf8");
const readAdr = () => readFileSync(ADR, "utf8");

// Sections split on "## " (level 2) headings outside code fences. `deep` also splits on "### ".
function sections(md, deep = false) {
  const out = [];
  let cur = null;
  let fenced = false;
  const re = deep ? /^#{2,3} (.+)$/ : /^## (.+)$/;
  for (const line of md.split("\n")) {
    if (/^\s*```/.test(line)) fenced = !fenced;
    const m = !fenced && re.exec(line);
    if (m) {
      cur = { heading: m[1].trim(), lines: [] };
      out.push(cur);
    } else if (cur) {
      cur.lines.push(line);
    }
  }
  return out;
}

const textOf = (s) => `${s.heading}\n${s.lines.join("\n")}`;

// Items start with `marker`; indented continuation lines belong to the item.
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

const BULLET = /^\s*[-*] /;
const ANY_ITEM = /^\s*(?:[-*]|\d+\.)\s/;
const find = (secs, re) => secs.filter((s) => re.test(s.heading));

const SOURCE = [
  /https?:\/\//,
  /[\w./-]+\.[a-z]{2,4}:\d+/i, // repo path with :line
  /command output/i,
  /output of/i,
  /\bunverified\b/i,
];

// Option letters. A section "is about" an option when its heading carries the label or the topic words.
const OPTION_HEAD = {
  a: /\(a\)|option a\b|claims?|leases?|git/i,
  b: /\(b\)|option b\b|served board|team server|shared served/i,
  c: /\(c\)|option c\b|external tracker|tracker sync|GitHub Issues|Linear/i,
};

// The ADR's Decision section must carry a line "Substrate: option (x)" (also "Chosen substrate: ...") whose
// value names exactly one of (a), (b), (c). That letter is the chosen substrate for the tests below.
function chosenLetter(adrMd) {
  const decision = find(sections(adrMd), /^decision/i)[0];
  if (!decision) return { error: "no ## Decision section" };
  const line = decision.lines.find((l) => /^\s*(?:[-*]\s*)?\**(?:chosen\s+)?substrate\**\s*:/i.test(l));
  if (!line) return { error: 'Decision section has no "Substrate: option (a|b|c)" line' };
  const value = line.replace(/^[^:]*:/, "");
  const letters = new Set();
  for (const m of value.matchAll(/\(([abc])\)|\boption\s+([abc])\b/gi)) letters.add((m[1] || m[2]).toLowerCase());
  if (letters.size !== 1) return { error: `Substrate line must name exactly one of (a), (b), (c); found: ${[...letters].join(",") || "none"}` };
  return { letter: [...letters][0] };
}

// ---------- research note ----------

describe("multi-developer-board note guard", () => {
  it("fails when docs/research exists but the note does not", () => {
    if (!existsSync(RESEARCH_DIR)) return;
    expect(existsSync(NOTE), `docs/research exists but ${NOTE} is missing`).toBe(true);
  });
  it("fails when docs/proposals exists but the draft ADR does not", () => {
    if (!existsSync(PROPOSALS_DIR)) return;
    expect(existsSync(ADR), `docs/proposals exists but ${ADR} is missing`).toBe(true);
  });
});

describe.skipIf(!notePresentDir)("multi-developer-board research note", () => {
  it("the note exists and is longer than 1000 characters", () => {
    expect(existsSync(NOTE), `missing ${NOTE}`).toBe(true);
    expect(readNote().trim().length).toBeGreaterThan(1000);
  });

  it("has a ## heading or labelled part for each of options (a), (b) and (c)", () => {
    const secs = sections(readNote(), true);
    for (const [letter, re] of Object.entries(OPTION_HEAD)) {
      const hit = find(secs, re).filter((s) => textOf(s).trim().length > 200);
      expect(hit.length, `no substantive ## or ### section for option (${letter}); headings: ${secs.map((s) => s.heading).join(" | ")}`).toBeGreaterThan(0);
    }
    const md = readNote();
    expect(md).toMatch(/GitHub (Issues|Projects)/);
    expect(md).toMatch(/Linear/);
    expect(md).toMatch(/doug board serve/);
    expect(md).toMatch(/lease/i);
  });

  it("has a comparable-tools ## section citing agent-teams and beads", () => {
    const md = readNote();
    const sec = find(sections(md), /comparable|prior art|other tools/i);
    expect(sec.length, "no ## heading matching /comparable|prior art|other tools/i").toBeGreaterThan(0);
    expect(md).toContain("https://code.claude.com/docs/en/agent-teams");
    expect(md).toContain("https://github.com/steveyegge/beads");
    const body = sec.map(textOf).join("\n");
    expect(body).toMatch(/claim/i);
    expect(body).toMatch(/WIP|limit/i);
  });

  it("the two-clones section names each thing that breaks, one bullet per area", () => {
    const sec = find(sections(readNote()), /two clones|what breaks|breaks/i);
    expect(sec.length, "no ## heading matching /two clones|what breaks|breaks/i").toBeGreaterThan(0);
    const bullets = sec.flatMap((s) => items(s.lines, BULLET)).map((b) => b.text);
    const areas = {
      "board.json": /board\.json/,
      Ready: /\bReady\b/,
      "In flow": /in[- ]flow/i,
      "plan.json": /plan\.json/,
      anchor: /anchor/i,
      "live-runs.md": /live-runs\.md/,
      memory: /memory/i,
      "board page (serve)": /\bserve\b|board page/i,
    };
    for (const [name, re] of Object.entries(areas)) {
      expect(
        bullets.some((b) => re.test(b)),
        `no bullet in the two-clones section covers ${name}`,
      ).toBe(true);
    }
    expect(
      bullets.some((b) => /follow-up/i.test(b) && /duplicate|collid|collision|race|same id/i.test(b)),
      "no bullet on follow-up filing races (duplicate id / collision)",
    ).toBe(true);
  });

  it("has a per-developer local state ## section that mentions .doug/.state", () => {
    const sec = find(sections(readNote()), /local|per-developer/i);
    expect(sec.length, "no ## heading matching /local|per-developer/i").toBeGreaterThan(0);
    expect(sec.map(textOf).join("\n")).toContain(".doug/.state");
  });

  it("has a reuse section that names ADR 0015", () => {
    const sec = find(sections(readNote()), /reuse|reuses|builds on|already decides/i);
    expect(sec.length, "no ## heading matching /reuse|builds on|already decides/i").toBeGreaterThan(0);
    expect(sec.map(textOf).join("\n")).toMatch(/\b0015\b/);
  });

  it("every claim bullet outside the follow-up list carries a URL, repo path:line, 'command output' or 'unverified'", () => {
    const secs = sections(readNote()).filter((s) => !/follow-up/i.test(s.heading));
    const bare = [];
    let count = 0;
    for (const s of secs) {
      for (const it of items(s.lines, BULLET)) {
        count++;
        if (!SOURCE.some((re) => re.test(it.text))) bare.push(`[${s.heading}] ${it.text.split("\n")[0].slice(0, 100)}`);
      }
    }
    expect(count, "the note has too few claim bullets").toBeGreaterThan(12);
    expect(bare, `claim bullets without a source:\n${bare.join("\n")}`).toEqual([]);
  });

  it("ends in a follow-up section", () => {
    const secs = sections(readNote());
    expect(secs.length).toBeGreaterThan(4);
    expect(secs[secs.length - 1].heading).toMatch(/follow-up/i);
  });
});

// ---------- draft ADR ----------

describe.skipIf(!adrPresentDir)("multi-developer-board draft ADR", () => {
  it("exists with Context, Decision and Consequences sections", () => {
    expect(existsSync(ADR), `missing ${ADR}`).toBe(true);
    const heads = sections(readAdr()).map((s) => s.heading);
    for (const h of ["Context", "Decision", "Consequences"]) {
      expect(
        heads.some((x) => x.toLowerCase().startsWith(h.toLowerCase())),
        `no ## ${h} section; headings: ${heads.join(" | ")}`,
      ).toBe(true);
    }
  });

  it("status is proposed or draft, not accepted, and names /doug-decide", () => {
    const md = readAdr();
    const m = /^[ \t>*_-]*status\**\s*:\**\s*(.+)$/im.exec(md);
    expect(m, "no Status: line").not.toBeNull();
    expect(m[1].trim(), "status must start with proposed or draft").toMatch(/^[*_]*(proposed|draft)/i);
    expect(md).toContain("/doug-decide");
  });

  it('the Decision section names exactly one of options (a), (b), (c) on a "Substrate:" line', () => {
    const r = chosenLetter(readAdr());
    expect(r.error, r.error).toBeUndefined();
    expect(["a", "b", "c"]).toContain(r.letter);
  });

  it("has a claim section naming assignee, claimedAt and lease expiry", () => {
    const sec = find(sections(readAdr()), /claim/i);
    expect(sec.length, "no ## heading matching /claim/i").toBeGreaterThan(0);
    const body = sec.map(textOf).join("\n");
    expect(body).toMatch(/assignee/);
    expect(body).toMatch(/claimedAt/);
    expect(body).toMatch(/lease/i);
    expect(body).toMatch(/expir/i);
    expect(body).toMatch(/leaseExpiresAt/);
  });

  it("has a conflict section with at least two rules", () => {
    const sec = find(sections(readAdr()), /conflict/i);
    expect(sec.length, "no ## heading matching /conflict/i").toBeGreaterThan(0);
    const rules = sec.flatMap((s) => items(s.lines, ANY_ITEM));
    expect(rules.length, "conflict section lists fewer than 2 rules").toBeGreaterThanOrEqual(2);
  });

  it("lists at least two follow-up cards, each with a kebab-case id", () => {
    const sec = find(sections(readAdr()), /follow-up/i);
    expect(sec.length, "no ## heading matching /follow-up/i").toBeGreaterThan(0);
    const KEBAB = /`[a-z][a-z0-9]*(?:-[a-z0-9]+)+`/;
    const cards = sec.flatMap((s) => items(s.lines, ANY_ITEM)).filter((it) => KEBAB.test(it.text));
    expect(cards.length, "fewer than 2 follow-up items with a `kebab-case-id`").toBeGreaterThanOrEqual(2);
  });

  it("mentions all three options and rejects the two not chosen as alternatives", () => {
    const md = readAdr();
    const r = chosenLetter(md);
    expect(r.error, r.error).toBeUndefined();
    const alt = find(sections(md), /alternative|rejected/i);
    expect(alt.length, "no heading matching /alternative|rejected/i").toBeGreaterThan(0);
    const body = alt.map((s) => s.lines.join("\n")).join("\n");
    for (const letter of ["a", "b", "c"].filter((l) => l !== r.letter)) {
      const entries = items(body.split("\n"), ANY_ITEM).filter((it) =>
        new RegExp(`\\(${letter}\\)|option ${letter}\\b`, "i").test(it.text.split("\n")[0]),
      );
      expect(entries.length > 0, `rejected option (${letter}) has no entry under alternatives`).toBe(true);
    }
  });
});
