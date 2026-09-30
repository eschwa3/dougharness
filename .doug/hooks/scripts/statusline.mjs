#!/usr/bin/env node
// Claude Code status line: prints one line like `Doug <version> · Opus · main · ctx 8%`.
// Reads the status-line JSON Claude Code passes on stdin. Never prints an error, always exits 0;
// each segment degrades on its own, and any thrown error falls back to the bare line `Doug`.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { DEFAULTS } from "../lib/config.mjs";
import { loadState, saveState } from "../lib/state.mjs";

const SEP = " · ";

// Reads one JSON object from stdin. Empty or unparseable stdin throws so main() prints the
// bare fallback line instead of guessing paths from process.cwd().
async function readInput(timeoutMs) {
  const chunks = [];
  await new Promise((resolve) => {
    process.stdin.on("data", (c) => chunks.push(c));
    process.stdin.on("end", resolve);
    process.stdin.on("error", resolve);
    setTimeout(resolve, timeoutMs).unref();
  });
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) throw new Error("empty stdin");
  const input = JSON.parse(text);
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("stdin is not a JSON object");
  return input;
}

function nonEmpty(v) {
  return typeof v === "string" && v.trim() !== "";
}

// Resolves the version to print, in order: the vendored VERSION record next to this script, this
// package's own package.json (only when it is @dougharness/gates, not a project's unrelated one),
// then the project's .doug/config.json doug.version fallback. Each step gets its own try/catch and
// only a non-empty trimmed value counts; the caller falls back to the bare name when this returns "".
function resolveVersion(here, projectDir) {
  try {
    const v = readFileSync(join(here, "..", "VERSION"), "utf8").trim();
    if (v) return v;
  } catch {
    // no vendored VERSION file
  }
  try {
    const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8"));
    if (pkg && pkg.name === "@dougharness/gates" && nonEmpty(pkg.version)) return pkg.version.trim();
  } catch {
    // no package.json here, or it isn't @dougharness/gates
  }
  try {
    const cfg = JSON.parse(readFileSync(join(projectDir, ".doug", "config.json"), "utf8"));
    const doug = cfg && typeof cfg === "object" ? cfg.doug : null;
    if (doug && typeof doug === "object" && nonEmpty(doug.version)) return doug.version.trim();
  } catch {
    // missing or unreadable config
  }
  return "";
}

function productSegment(projectDir) {
  let name = "Doug";
  try {
    const cfg = JSON.parse(readFileSync(join(projectDir, ".doug", "config.json"), "utf8"));
    const doug = cfg && typeof cfg === "object" ? cfg.doug : null;
    if (doug && typeof doug === "object" && nonEmpty(doug.name)) name = doug.name.trim();
  } catch {
    // missing or unreadable config: bare product name
  }
  const here = dirname(fileURLToPath(import.meta.url));
  const version = resolveVersion(here, projectDir);
  return version ? `${name} ${version}` : name;
}

function branchSegment(workDir) {
  try {
    const res = spawnSync("git", ["branch", "--show-current"], {
      cwd: workDir,
      encoding: "utf8",
      timeout: 2000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (res.status !== 0 || res.error) return null;
    const branch = (res.stdout || "").trim();
    return branch || null;
  } catch {
    return null;
  }
}

// Reads only contextWindow out of .doug/config.json, deep-merged onto its defaults, without loadConfig's
// stderr line on a broken file (minor 4: this script's header promises it never prints an error).
function loadContextWindowConfig(projectDir) {
  let cw = null;
  try {
    const raw = JSON.parse(readFileSync(join(projectDir, ".doug", "config.json"), "utf8"));
    if (raw && typeof raw === "object" && raw.contextWindow && typeof raw.contextWindow === "object") cw = raw.contextWindow;
  } catch {
    // missing or unreadable config: contextWindow defaults (off)
  }
  return { contextWindow: { ...DEFAULTS.contextWindow, ...cw } };
}

function contextSegment(input, cfg) {
  const pct = input.context_window?.used_percentage;
  if (typeof pct !== "number" || !Number.isFinite(pct)) return "ctx --";
  const rounded = Math.round(pct);
  const threshold = cfg?.contextWindow?.threshold ?? 80;
  const marker = cfg?.contextWindow?.enabled && rounded >= threshold ? " compact?" : "";
  return `ctx ${rounded}%${marker}`;
}

// Records the rounded pct into session state (lib/state.mjs) for the Stop gate to read, only when the
// contextWindow feature is on, a session_id and a finite pct are both present, and the rounded value actually
// changed (the status line runs often). Never lets a state read/write failure change the printed line.
function recordContext(input, projectDir, cfg) {
  try {
    if (!cfg?.contextWindow?.enabled) return;
    if (!nonEmpty(input.session_id)) return;
    const pct = input.context_window?.used_percentage;
    if (typeof pct !== "number" || !Number.isFinite(pct)) return;
    const rounded = Math.round(pct);
    const state = loadState(projectDir, input.session_id);
    if (state.context && state.context.pct === rounded) return;
    // Keep notifiedAt (set by the Stop gate) across a pct update, so growth is tracked from the last notice
    // rather than reset by every status-line render.
    state.context = { ...(state.context || {}), pct: rounded, at: new Date().toISOString() };
    saveState(projectDir, input.session_id, state);
  } catch {
    // never let a state write failure change the status line output
  }
}

async function main() {
  const input = await readInput(1500);
  const ws = input.workspace && typeof input.workspace === "object" ? input.workspace : {};
  const projectDir = ws.project_dir ?? ws.current_dir ?? input.cwd ?? process.cwd();
  const workDir = ws.current_dir ?? input.cwd ?? process.cwd();

  const cfg = loadContextWindowConfig(projectDir);

  const segments = [productSegment(projectDir)];
  if (nonEmpty(input.model?.display_name)) segments.push(input.model.display_name.trim());
  const branch = branchSegment(workDir);
  if (branch) segments.push(branch);
  segments.push(contextSegment(input, cfg));
  recordContext(input, projectDir, cfg);

  process.stdout.write(segments.join(SEP) + "\n");
}

main()
  .then(() => process.exit(0))
  .catch(() => {
    process.stdout.write("Doug\n");
    process.exit(0);
  });
