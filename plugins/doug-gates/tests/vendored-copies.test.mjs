// This repository runs Doug on itself: the hooks Claude Code actually fires come from `.doug/hooks/{scripts,lib}`,
// vendored copies of `plugins/doug-gates/{scripts,lib}` (the `harness-fix` skill says to copy an edited gate
// script across, but nothing enforced it — see card vendored-hooks-drift). `hooks.test.mjs` holds the
// behavior tests that spawn the real scripts; this file asserts a repository-layout invariant instead — it
// spawns nothing — so a drift failure reads as its own line in the run output, and the behavior suite stays
// about behavior. It checks two things: the vendored copies are byte-identical to their plugin source (in both
// directions — a file added on one side and not the other is drift too), and this repository's real hook
// wiring in `.claude/settings.json` matches what `plugins/doug-gates/hooks/hooks.json` declares (decision:
// compare against `.claude/settings.json`, not an invented `.doug/hooks/hooks.json`, which does not exist and
// is out of scope here).

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULTS } from "../lib/config.mjs";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const PLUGIN_SCRIPTS = join(ROOT, "plugins/doug-gates/scripts");
const PLUGIN_LIB = join(ROOT, "plugins/doug-gates/lib");
const VENDORED_SCRIPTS = join(ROOT, ".doug/hooks/scripts");
const VENDORED_LIB = join(ROOT, ".doug/hooks/lib");

// Recursively lists the files under `dir` (dot-prefixed files AND directories skipped, symmetrically — a
// sensible .DS_Store guard), as paths relative to `dir` using "/" so a nested file compares and prints the same
// way a top-level one does. Returns leaf files only, never a directory path, so a fix command always names two
// real files.
function walkFiles(dir, base = dir) {
  let out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out = out.concat(walkFiles(full, base));
    else if (entry.isFile()) out.push(relative(base, full).split(sep).join("/"));
  }
  return out;
}

// Compares two directory trees file by file (recursively — a subdirectory present on both sides with differing
// contents, or present on only one side, is drift too, and must be reported the same legible way a top-level
// file is), reporting a drift the same way project-agents.test.ts does: the file, the 1-based line number, and
// both values, plus the exact `cp` command that fixes it — the message alone should make the fix obvious,
// without needing to open a diff tool.
function checkVendoredCopies(pluginDir, vendoredDir, pluginLabel, vendoredLabel) {
  const pluginPaths = new Set(walkFiles(pluginDir));
  const vendoredPaths = new Set(walkFiles(vendoredDir));

  for (const rel of pluginPaths) {
    if (!vendoredPaths.has(rel)) {
      throw new Error(
        `${pluginLabel}/${rel} has no vendored copy at ${vendoredLabel}/${rel}.\n` +
          `  fix: cp ${pluginLabel}/${rel} ${vendoredLabel}/${rel}`
      );
    }
  }
  for (const rel of vendoredPaths) {
    if (!pluginPaths.has(rel)) {
      throw new Error(
        `${vendoredLabel}/${rel} exists but has no source at ${pluginLabel}/${rel} (vendored copy is stale or was added by hand).\n` +
          `  fix: remove ${vendoredLabel}/${rel}, or add ${pluginLabel}/${rel} and then cp it across`
      );
    }
  }

  for (const rel of pluginPaths) {
    const pluginPath = join(pluginDir, rel);
    const vendoredPath = join(vendoredDir, rel);
    const pluginText = readFileSync(pluginPath, "utf8");
    const vendoredText = readFileSync(vendoredPath, "utf8");
    if (pluginText === vendoredText) continue;
    const pluginLines = pluginText.split("\n");
    const vendoredLines = vendoredText.split("\n");
    let line = 1;
    while (pluginLines[line - 1] === vendoredLines[line - 1]) line++;
    throw new Error(
      `${vendoredLabel}/${rel} has drifted from ${pluginLabel}/${rel} at line ${line}:\n` +
        `  ${pluginLabel}: ${JSON.stringify(pluginLines[line - 1])}\n` +
        `  ${vendoredLabel}: ${JSON.stringify(vendoredLines[line - 1])}\n` +
        `  fix: cp ${pluginLabel}/${rel} ${vendoredLabel}/${rel}`
    );
  }
}

// Extracts the script basename a hook command runs, normalizing away the two prefixes this repository uses:
// the plugin's `${CLAUDE_PLUGIN_ROOT}/scripts/<x>.mjs` and the vendored `$CLAUDE_PROJECT_DIR/.doug/hooks/scripts/<x>.mjs`.
// Returns null for a command that runs neither (the project's own business — ignored per decision 2).
function vendoredScriptName(command) {
  const m = /"\$CLAUDE_PROJECT_DIR\/\.doug\/hooks\/scripts\/([^"/]+)"/.exec(command);
  return m ? m[1] : null;
}
function pluginScriptName(command) {
  const m = /"\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/([^"/]+)"/.exec(command);
  return m ? m[1] : null;
}

// Flattens a hooks-config `hooks` object (the shape shared by hooks.json and settings.json's "hooks" key) into
// an ordered list per event: {event, matcher, script, timeout}, in event -> group -> hook document order.
// `scriptOf` picks out the script basename from a raw command, and returns null to drop entries that don't
// reference the family of scripts being compared (the plugin's own vs. the vendored copies).
function flattenHooks(hooksObj, scriptOf) {
  const out = [];
  for (const [event, groups] of Object.entries(hooksObj || {})) {
    for (const group of groups) {
      const matcher = group.matcher ?? null;
      for (const hook of group.hooks || []) {
        const script = scriptOf(hook.command || "");
        if (script === null) continue;
        out.push({ event, matcher, script, timeout: hook.timeout });
      }
    }
  }
  return out;
}

function wiringKey(entry) {
  return `${entry.event} matcher=${JSON.stringify(entry.matcher)} script=${entry.script} timeout=${entry.timeout}`;
}

describe("vendored hooks match their plugin source", () => {
  it("keeps .doug/hooks/scripts byte-identical to plugins/doug-gates/scripts, both files present on both sides", () => {
    checkVendoredCopies(PLUGIN_SCRIPTS, VENDORED_SCRIPTS, "plugins/doug-gates/scripts", ".doug/hooks/scripts");
  });

  it("keeps .doug/hooks/lib byte-identical to plugins/doug-gates/lib, both files present on both sides", () => {
    checkVendoredCopies(PLUGIN_LIB, VENDORED_LIB, "plugins/doug-gates/lib", ".doug/hooks/lib");
  });

  // Card statusline-installed-version: .doug/hooks/VERSION is the vendored copy's one source of truth for the
  // installed version the status line prints; it must stay synced to the gates package it was vendored from.
  it("keeps .doug/hooks/VERSION synced to plugins/doug-gates/package.json's version", () => {
    const gatesPkg = JSON.parse(readFileSync(join(ROOT, "plugins/doug-gates/package.json"), "utf8"));
    const vendoredVersion = readFileSync(join(ROOT, ".doug/hooks/VERSION"), "utf8").trim();
    expect(vendoredVersion).toBe(gatesPkg.version);
  });

  it("wires every plugin-declared hook into .claude/settings.json under the same event, matcher, script, order, and timeout", () => {
    const pluginHooks = JSON.parse(readFileSync(join(ROOT, "plugins/doug-gates/hooks/hooks.json"), "utf8")).hooks;
    const settingsHooks = JSON.parse(readFileSync(join(ROOT, ".claude/settings.json"), "utf8")).hooks;

    const declared = flattenHooks(pluginHooks, pluginScriptName);
    const wired = flattenHooks(settingsHooks, vendoredScriptName);

    expect(
      declared.length,
      `plugins/doug-gates/hooks/hooks.json declares ${declared.length} script hook(s), but only ${wired.length} matching entr${
        wired.length === 1 ? "y" : "ies"
      } run out of .doug/hooks/scripts in .claude/settings.json.\n` +
        `  declared: ${declared.map(wiringKey).join("\n            ")}\n` +
        `  wired:    ${wired.map(wiringKey).join("\n            ") || "(none)"}`
    ).toBe(wired.length);

    for (let i = 0; i < declared.length; i++) {
      const want = declared[i];
      const got = wired[i];
      // Position, not presence: both lists are the same length at this point, so what's wrong at index i is
      // that .claude/settings.json has a different hook there — not that hooks.json's hook is missing. Say so,
      // and print both entries, so a reordering (or a changed field) reads as a positional mismatch rather than
      // an absent hook.
      expect(
        wiringKey(got),
        `.claude/settings.json's wiring differs from plugins/doug-gates/hooks/hooks.json's declaration at position ${i + 1} ` +
          `of ${declared.length} (order matters here; this is not a missing hook, it's a different one at this position):\n` +
          `  hooks.json declares here:    ${wiringKey(want)}\n` +
          `  settings.json has here:      ${wiringKey(got)}`
      ).toBe(wiringKey(want));
    }
  });

  // Card stop-gate-budget-under-hook-timeout: the gate bounds its own wait-plus-commands to less than the
  // platform's own hook timeout (F1, research note: a hook the platform itself kills is cancelled, fails
  // open, and its output is discarded — an ungated stop). It learns that timeout from config
  // (stopGate.hookTimeoutSec) rather than from the hook's stdin (F2: undocumented, and unverified that one
  // exists), so the config default must be kept equal, by hand, to the `timeout` the stop-gate hook actually
  // carries on both Stop and SubagentStop in hooks.json and in this repository's real wiring, settings.json.
  it("pins stopGate.hookTimeoutSec (plugins/doug-gates/lib/config.mjs) to the stop-gate hook's own timeout on Stop and SubagentStop, in both hooks.json and settings.json", () => {
    const hookTimeoutSec = DEFAULTS.stopGate.hookTimeoutSec;
    const pluginHooks = JSON.parse(readFileSync(join(ROOT, "plugins/doug-gates/hooks/hooks.json"), "utf8")).hooks;
    const settingsHooks = JSON.parse(readFileSync(join(ROOT, ".claude/settings.json"), "utf8")).hooks;
    const isStopGate = (command) => (/stop-gate\.mjs/.test(command) ? "stop-gate.mjs" : null);

    for (const [label, hooksObj] of [
      ["plugins/doug-gates/hooks/hooks.json", pluginHooks],
      [".claude/settings.json", settingsHooks],
    ]) {
      for (const event of ["Stop", "SubagentStop"]) {
        const entries = flattenHooks({ [event]: hooksObj[event] || [] }, isStopGate);
        expect(entries.length, `${label}'s ${event} must declare exactly one stop-gate.mjs hook`).toBe(1);
        expect(
          entries[0].timeout,
          `${label}'s ${event} stop-gate.mjs hook timeout (${entries[0].timeout}) must equal DEFAULTS.stopGate.hookTimeoutSec (${hookTimeoutSec}) from plugins/doug-gates/lib/config.mjs — the gate reads this to bound itself under the platform's own hook timeout`,
        ).toBe(hookTimeoutSec);
      }
    }
  });
});
