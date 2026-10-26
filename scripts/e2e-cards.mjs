#!/usr/bin/env node
// Files the findings of a broken replay or journey step as Backlog cards (architecture 4.4 of docs/specs/ci-e2e).
// Usage: node scripts/e2e-cards.mjs [findings.json] [--dir <repo>]
// The board is read with loadBoard and written only through the doug CLI (packages/doug-cli/dist/bin.js).
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadBoard, DONE } from "../plugins/doug-flow/lib/board.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(root, "packages", "doug-cli", "dist", "bin.js");
const FINDINGS_FILE = join(".doug", ".state", "e2e", "findings.json");

const slugPart = (s) =>
  String(s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

export function cardIdFor(f) {
  const scenario = slugPart(f.scenario) || "journey";
  return `e2e-${scenario}-${slugPart(f.stage)}`;
}

export function goalFor(f, { regressionOf = null } = {}) {
  const lines = [
    `Scenario: ${f.scenario}`,
    `Stage: ${f.stage}`,
    `Message: ${f.message}`,
    `Commit: ${f.commit}`,
    `Reproduce: ${f.reproduce}`,
  ];
  if (f.suspect === "replay") lines.push(`the replay may be wrong: ${f.replayFile}`);
  if (regressionOf) lines.push(`regression of ${regressionOf} (Done)`);
  return lines.join("\n");
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function planCards(findings, board) {
  const cards = [...(board?.cards ?? [])];
  const seen = new Map();
  const out = [];
  for (const f of findings) {
    const id = cardIdFor(f);
    if (seen.has(id)) {
      out.push({ action: "fold", id: seen.get(id), key: f.key });
      continue;
    }
    seen.set(id, id);
    const re = new RegExp(`^${escapeRe(id)}(?:-(\\d+))?$`);
    const family = cards.filter((c) => re.test(c.id));
    let target = id;
    let regressionOf = null;
    if (family.length) {
      if (family.some((c) => c.column !== DONE)) {
        out.push({ action: "skip", id });
        continue;
      }
      let max = 0;
      for (const c of family) max = Math.max(max, Number(re.exec(c.id)[1] ?? 0));
      target = `${id}-${max + 1}`;
      regressionOf = family.find((c) => c.id === id)?.id ?? family[family.length - 1].id;
    }
    seen.set(id, target);
    cards.push({ id: target, column: "backlog" });
    out.push({ action: "add", id: target, title: `e2e: ${f.scenario} ${f.stage} broken`, goal: goalFor(f, { regressionOf }) });
  }
  return out;
}

export function main(argv) {
  const rest = [];
  let dir = root;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--dir") dir = resolve(argv[++i] ?? "");
    else rest.push(argv[i]);
  }
  const file = rest[0] ? resolve(rest[0]) : join(dir, FINDINGS_FILE);
  let findings = [];
  if (existsSync(file)) {
    try {
      const raw = readFileSync(file, "utf8").trim();
      findings = raw ? JSON.parse(raw) : [];
    } catch (e) {
      process.stderr.write(`cannot read ${file}: ${e.message}\n`);
      return 1;
    }
  }
  if (!Array.isArray(findings) || findings.length === 0) {
    process.stdout.write("no findings\n");
    return 0;
  }
  const board = loadBoard(dir);
  for (const step of planCards(findings, board)) {
    if (step.action === "skip") process.stdout.write(`skipped ${step.id}: card exists\n`);
    else if (step.action === "fold") process.stdout.write(`folded into ${step.id}: ${step.key}\n`);
    else {
      const add = ["board", "add", step.id, "--title", step.title, "--goal", step.goal, "--size", "S", "--class", "code", "--track", "hand", "--column", "backlog", dir];
      const top = ["board", "reorder", step.id, "--top", dir];
      for (const args of [add, top]) {
        const r = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8" });
        if (r.status !== 0) {
          process.stderr.write(`doug ${args.slice(0, 3).join(" ")} failed (${r.status}): ${(r.stderr || r.stdout || "").trim()}\n`);
          return 1;
        }
      }
      process.stdout.write(`filed ${step.id}\n`);
    }
  }
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
