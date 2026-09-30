#!/usr/bin/env node
// CLI for deterministic proposals from the outcomes/lessons store and the run trace (card learn-signals), on
// top of lib/learn.mjs. Log-then-propose, never auto-apply: `propose` only ever writes under
// .doug/.state/learn/, never a tracked file; `apply` is the one command that ever touches the checkout, and
// only for a proposal file named on the command line.
//   learn.mjs signals [dir] [--json]
//                                                 prints the signal summary (outcomes, lessons, trace), one
//                                                 block per source, counts only
//   learn.mjs propose [dir] [--json]
//                                                 collects signals, renders each candidate change as a unified
//                                                 diff, writes them under .doug/.state/learn/<timestamp>/, and
//                                                 prints one line per proposal ("no proposals" and exit 0 when
//                                                 there are none)
//   learn.mjs apply <proposal-file> [dir] [--json]
//                                                 applies ONE proposal's diff with `git apply`; exit 1 with the
//                                                 reason when refused (a protected target, or a diff that no
//                                                 longer applies cleanly). Never called by `propose`.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

const USAGE = "usage: learn.mjs <signals|propose|apply> ...\n" + "  learn.mjs signals [dir] [--json]\n" + "  learn.mjs propose [dir] [--json]\n" + "  learn.mjs apply <proposal-file> [dir] [--json]\n";

function fail(msg, code = 1) {
  process.stderr.write(`${msg}\n`);
  process.exit(code);
}

const argv = process.argv.slice(2);
const opts = {};
const positional = [];
for (const a of argv) {
  if (a.startsWith("--")) {
    const name = a.slice(2);
    if (name !== "json") fail(`unknown flag --${name}\n\n${USAGE}`, 2);
    opts.json = true;
    continue;
  }
  positional.push(a);
}
const [cmd, ...rest] = positional;

function dirFrom(args, n) {
  return resolve(process.env.CLAUDE_PROJECT_DIR || args[n] || process.cwd());
}

function readClaudeMd(dir) {
  const file = join(dir, "CLAUDE.md");
  return existsSync(file) ? readFileSync(file, "utf8") : "";
}

function readConfig(dir) {
  const file = join(dir, ".doug/config.json");
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

// Mirrors template.test.mjs's parseFrontmatter: a single "---\n...\n---" block, one "key: value" per line.
// Adequate for name/description, the only two fields `tighten` looks at.
function parseFrontmatter(text) {
  const m = /^---\n([\s\S]*?)\n---/.exec(text);
  if (!m) return null;
  const out = {};
  for (const line of m[1].split("\n")) {
    const kv = /^([A-Za-z_-]+):\s*(.*)$/.exec(line);
    if (kv) out[kv[1]] = kv[2].trim();
  }
  return out;
}

// Every doug-flow skill this plugin ships (../skills, relative to this script — the plugin's own skills, not
// the project under analysis): { name, description, file } for `tighten` to weigh against trace invocation
// counts. `file` (review MINOR 7) is the real absolute path this skill's SKILL.md was read from, so
// proposeChanges can point a tighten proposal's `target` at the file it actually looked at instead of a
// hardcoded guess.
function readOwnSkills() {
  const skillsDir = join(here, "..", "skills");
  if (!existsSync(skillsDir)) return [];
  const out = [];
  for (const name of readdirSync(skillsDir)) {
    const file = join(skillsDir, name, "SKILL.md");
    if (!existsSync(file)) continue;
    const fm = parseFrontmatter(readFileSync(file, "utf8"));
    if (fm) out.push({ name: fm.name || name, description: fm.description || "", file });
  }
  return out;
}

function signalsText(s) {
  return [
    `outcomes: ${s.outcomes.rows.length} rows, ${s.outcomes.gateFailures} gate failures, blocks real=${s.outcomes.blocksByClass.real} marginal=${s.outcomes.blocksByClass.marginal} false=${s.outcomes.blocksByClass.false}, fixPasses sum=${s.outcomes.fixPasses.sum} max=${s.outcomes.fixPasses.max}, usd sum=${s.outcomes.usd.sum.toFixed(2)} n=${s.outcomes.usd.n}, cards=${Object.keys(s.outcomes.byCard).length}`,
    `lessons: ${s.lessons.total} total, ${s.lessons.live} live, ${s.lessons.helpful} helpful, ${s.lessons.harmful} harmful, ${s.lessons.stale} stale, ${s.lessons.repeated.length} repeated`,
    `trace: ${s.trace.files.length} files, ${s.trace.denials.length} denials, ${s.trace.unmatched.length} unmatched (reported only, never a proposal signal), ${s.trace.skills.length} skills invoked, ${s.trace.instructionsLoaded.length} instruction files loaded`,
  ].join("\n");
}

try {
  switch (cmd) {
    case "signals": {
      const dir = dirFrom(rest, 0);
      const { openMemory } = await import("../lib/memory.mjs");
      const { collectSignals } = await import("../lib/learn.mjs");
      const m = openMemory(dir);
      let signals;
      try {
        signals = collectSignals(m, { dir });
      } finally {
        m.close();
      }
      process.stdout.write(opts.json ? `${JSON.stringify(signals, null, 2)}\n` : `${signalsText(signals)}\n`);
      break;
    }
    case "propose": {
      const dir = dirFrom(rest, 0);
      const { openMemory } = await import("../lib/memory.mjs");
      const { collectSignals, proposeChanges, writeProposals } = await import("../lib/learn.mjs");
      const m = openMemory(dir);
      let signals;
      try {
        signals = collectSignals(m, { dir });
      } finally {
        m.close();
      }
      const proposals = proposeChanges(signals, { dir, claudeMd: readClaudeMd(dir), config: readConfig(dir), skills: readOwnSkills() });
      const written = proposals.length ? writeProposals(proposals, { dir }) : null;
      if (opts.json) {
        process.stdout.write(`${JSON.stringify({ proposals, dir: written ? written.dir : null }, null, 2)}\n`);
      } else if (!proposals.length) {
        process.stdout.write("no proposals\n");
      } else {
        for (const p of proposals) process.stdout.write(`${p.id} ${p.kind} ${p.target}: ${p.reason}\n`);
        process.stdout.write(`written to ${written.dir}\n`);
      }
      break;
    }
    case "apply": {
      if (!rest[0]) fail(USAGE, 2);
      const file = resolve(rest[0]);
      const dir = dirFrom(rest, 1);
      const { applyProposal } = await import("../lib/learn.mjs");
      const result = applyProposal(file, { dir });
      if (!result.ok) {
        if (opts.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        process.stderr.write(`${result.reason}\n`);
        process.exit(1);
      }
      process.stdout.write(opts.json ? `${JSON.stringify(result, null, 2)}\n` : `applied ${result.target}\n`);
      break;
    }
    default:
      fail(USAGE, 2);
  }
} catch (err) {
  fail(err.message);
}
