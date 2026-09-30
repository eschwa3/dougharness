// Loads .doug/config.json from the project directory and merges defaults.
// The installer writes this file; hooks only read it. No network, no LLM.

import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

export const CONFIG_RELPATH = ".doug/config.json";

export const DEFAULTS = Object.freeze({
  version: 1,
  packageManager: null,
  commands: {},
  formatter: null,
  protectedPaths: [".env", ".env.*", ".git/**", "node_modules/**", ".doug/config.json"],
  // Written only through an approved proposal diff (card memory-decisions): a new ADR, an ADR amendment, or a
  // rules file is rendered by decisions.mjs and applied with `learn.mjs apply` after the user approves it.
  // protect-paths.mjs refuses the Edit/Write/MultiEdit/NotebookEdit tools on these, and the Stop gate flags a
  // Bash-written change to them whose content is not recorded in the applied-proposal ledger
  // (.doug/.state/proposals/applied.jsonl). Set to [] to turn this off.
  proposalPaths: ["docs/decisions/**", ".claude/rules/**"],
  // Paths outside the project directory (protect-paths.mjs) that an Edit/Write/MultiEdit/NotebookEdit may still
  // touch: each entry is an absolute or ~-prefixed file or directory path (lib/paths.mjs isAllowedOutside).
  // Empty by default so an existing project's behavior is unchanged.
  allowedOutsidePaths: [],
  bash: {
    denyNoVerify: true,
    denyForcePushTo: ["main", "master"],
    denyDestructive: true,
    packageManagerGuard: true,
  },
  // Deny secrets in edits/commands (lib/secret-rules.mjs): an AWS key id, a PEM private-key header,
  // a GitHub/Slack token, or an inline password/secret/api_key/token assignment with a literal value.
  secrets: {
    enabled: true,
    rules: { awsKeyId: true, pemPrivateKey: true, githubToken: true, slackToken: true, inlineAssignment: true },
    placeholders: ["your_", "your-", "xxx", "placeholder", "example", "changeme", "dummy", "fake", "sample", "redacted"],
    ignorePaths: [],
  },
  editLoop: { threshold: 6, windowMinutes: 30 },
  stopGate: {
    commands: [],
    onlyIfEdited: true,
    timeoutMs: 300000,
    // Card stop-gate-budget-under-hook-timeout: the platform's own Stop/SubagentStop hook `timeout`
    // (plugins/doug-gates/hooks/hooks.json and .claude/settings.json, seconds), the gate reads this
    // to bound its own wait-plus-commands under it — a hook the platform kills is cancelled, fails
    // open, and its output is discarded. Must equal that hook's declared `timeout`; nothing else keeps
    // them in step (vendored-copies.test.mjs pins it). A non-number or non-positive value reads as 600.
    hookTimeoutSec: 600,
    maxBlocks: 3,
    // Card stop-gate-deferral-cap: consecutive main Stops a subagent-in-flight deferral (D3 below) may skip
    // before the gate runs the full verification anyway. A non-number, non-finite, or below-1 value (0,
    // negative, a string, null, an object) reads as the default, 10 (stop-gate.mjs's normaliser).
    maxDeferrals: 10,
    // Protected paths that tools other than Edit may legitimately change (lockfiles via the package manager;
    // .doug/config.json, written by `doug init`). They stay protected from hand edits — protect-paths.mjs still
    // refuses the Edit/Write tool on them, and that refusal is the control that matters — but the Stop scan,
    // which only catches Bash-originated writes after the fact, does not flag them. .doug/config.json needs this
    // for the same reason a lockfile does: the installer's own first-run output must not block the very first
    // Stop.
    ignoreChangedPaths: [".doug/config.json"],
    // With an approved or done .doug/plan.json, block the stop when a changed file is outside the
    // files the plan's tasks own (lib/scope.mjs). ignoreChangedPaths applies here too.
    planScope: true,
    // Block the stop while this session has run no test or verify command itself (lib/evidence.mjs): the gate
    // commands, any other configured command, a known test runner, or one of evidencePatterns (regular expressions).
    requireEvidence: true,
    evidencePatterns: [],
  },
  // Checkpoint on green (lib/checkpoint.mjs): when the stop gate passes with changes present, commit
  // on the current branch ("commit") or tag a commit built off a temporary index ("tag"). Off by default.
  checkpoint: { enabled: false, mode: "commit", message: "doug: checkpoint" },
  // Run trace (lib/trace.mjs): one JSONL line per subagent start/stop and tool call under .doug/.state/trace/.
  trace: { enabled: true },
  budget: { maxTurns: null },
  anchor: [],
  // Context-window handoff (card context-window-handoff): the status line records context_window.used_percentage
  // into session state when enabled, and the Stop gate advises (never compacts) at a green boundary once pct
  // reaches threshold. Off by default so an existing project is unchanged. repeatAfter is the points of growth
  // required before the Stop-gate notice repeats. Requires trace.enabled (on by default): the notice's "no
  // subagent running" claim reads the run trace, so it stays silent while the trace is off rather than guess.
  contextWindow: { enabled: false, threshold: 80, repeatAfter: 5 },
  // Per-subagent cap on WebSearch plus WebFetch calls (scripts/research-cap.mjs, card research-fetch-cap): null
  // or 0 turns it off. The main session is never capped.
  research: { maxFetches: 6 },
});

export function projectDir(input) {
  return resolve(process.env.CLAUDE_PROJECT_DIR || (input && input.cwd) || process.cwd());
}

function deepMerge(base, over) {
  if (Array.isArray(base) || Array.isArray(over)) return over ?? base;
  if (typeof base !== "object" || base === null) return over ?? base;
  const out = { ...base };
  for (const [k, v] of Object.entries(over || {})) {
    out[k] = k in base && typeof base[k] === "object" && !Array.isArray(base[k]) ? deepMerge(base[k], v) : v;
  }
  return out;
}

// Card gates-config-shape-check (decision, option a), widened by card gates-config-shape-all-arrays: every
// array-typed value in DEFAULTS (nested objects included) — the keys the gates iterate directly (matchAny's
// `for (const raw of patterns)` in lib/glob.mjs, or an unguarded `for (const entry of ...)`) — must never reach a
// gate as anything but an array. deepMerge's own ternary only recurses into an object base, so an array-typed
// default's raw override (of any shape, including null) is assigned straight through. Fold that back to the
// default here: a non-null, non-array value (a number, string, object, or boolean) warns once on stderr naming
// the dotted path and falls back to its default, the way memory.embeddings already does
// (plugins/doug-flow/lib/embeddings.mjs:48). An explicit null falls back to the default silently: for these keys
// deepMerge's object branch (`out[k] = ... deepMerge(base[k], v) : v`) assigns v straight through, so a null
// override already reached the gates as null before ddcc165 — the fallback here now covers that case too,
// without a warning, matching the rest of loadConfig's `over ?? base` convention. A valid array, including [],
// passes through unchanged. Array entries of the wrong type are out of scope. Derived by walking DEFAULTS itself
// (not a hand list), so a new array-typed default is covered automatically. A parent object replaced by a
// non-object in the user file (e.g. `stopGate: [1]`) is walked against DEFAULTS's shape, not the user's, so it
// never throws; that parent's own shape is otherwise unchanged from HEAD behaviour (no new parent normalisation).
function arrayShapePaths(defaults, prefix = []) {
  let out = [];
  for (const [k, v] of Object.entries(defaults)) {
    const path = [...prefix, k];
    if (Array.isArray(v)) out.push(path);
    else if (v && typeof v === "object") out = out.concat(arrayShapePaths(v, path));
  }
  return out;
}

function normaliseArrayShapes(cfg) {
  for (const path of arrayShapePaths(DEFAULTS)) {
    // Walk cfg alongside path, stopping (leaving cfg as-is) if a parent along the way is not a plain object —
    // covers a parent replaced by a non-object (stopGate: [1], secrets: "x") without throwing.
    let parent = cfg;
    let ok = true;
    for (let i = 0; i < path.length - 1; i++) {
      const next = parent[path[i]];
      if (next === null || typeof next !== "object" || Array.isArray(next)) {
        ok = false;
        break;
      }
      parent = next;
    }
    if (!ok) continue;
    const key = path[path.length - 1];
    const v = parent[key];
    if (v === undefined || Array.isArray(v)) continue;
    const def = path.reduce((o, k) => o[k], DEFAULTS);
    if (v === null) {
      parent[key] = def;
      continue;
    }
    process.stderr.write(`[doug] ${CONFIG_RELPATH} ${path.join(".")} is not an array; using the default\n`);
    parent[key] = def;
  }
}

export function loadConfig(dir) {
  const file = join(dir, CONFIG_RELPATH);
  if (!existsSync(file)) return { ...DEFAULTS, _present: false };
  try {
    const raw = JSON.parse(readFileSync(file, "utf8"));
    const merged = { ...deepMerge(DEFAULTS, raw), _present: true };
    normaliseArrayShapes(merged);
    return merged;
  } catch (err) {
    // A broken config must never silently disable gates. Fall back to defaults and say so.
    process.stderr.write(`[doug] ${CONFIG_RELPATH} is unreadable (${err.message}); using defaults\n`);
    return { ...DEFAULTS, _present: false, _error: String(err.message) };
  }
}
