import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { Detection } from "../detect/types.js";
import type { DougConfig } from "./config.js";

// Merges Doug's hooks and a minimal permission allowlist into an existing .claude/settings.json.
// The hook wiring itself is derived from plugins/doug-gates/hooks/hooks.json (see dougHooks below), not
// hardcoded here, so the two can no longer drift (card generated-settings-wiring-drift). Hook commands point
// at the vendored copy under .doug/hooks so the project is self-contained.

export const HOOK_MARK = "\"$CLAUDE_PROJECT_DIR/.doug/hooks/scripts/";
export const STATUSLINE_COMMAND = "node .doug/hooks/scripts/statusline.mjs";
// Card no-nested-agents-gate: Claude Code's per-project subagent spawn depth (settings.md, sub-agents.md).
export const SUBAGENT_DEPTH_ENV = "CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH";

// A hook object as it appears in the generated settings.json: type/command are always present (command is the
// vendored form), and every other field hooks.json's hook carried (timeout, if, statusMessage, once, args,
// async, asyncRewake, shell, or a field not yet documented) rides along untouched - see dougHooks below.
type HookObject = { type: "command"; command: string; [key: string]: unknown };
type HookEntry = { matcher?: string; hooks: HookObject[]; [key: string]: unknown };
type Settings = {
  hooks?: Record<string, HookEntry[]>;
  statusLine?: { type: string; command?: string; padding?: number };
  permissions?: { allow?: string[]; deny?: string[]; ask?: string[] };
  env?: Record<string, string>;
  [k: string]: unknown;
};

function cmd(script: string) {
  return `node "$CLAUDE_PROJECT_DIR/.doug/hooks/scripts/${script}.mjs"`;
}

// Locates the gates package (scripts + lib + hooks.json) to vendor into the project.
export function gatesSourceDir(): string {
  const require = createRequire(import.meta.url);
  const pkg = require.resolve("@dougharness/gates/package.json");
  return dirname(pkg);
}

// The plugin's command form: node "${CLAUDE_PLUGIN_ROOT}/scripts/<name>.mjs".
const PLUGIN_COMMAND_RE = /^node "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/([A-Za-z0-9_-]+)\.mjs"$/;

// Rewrites one plugin-form command into the vendored form a generated project actually runs (cmd()'s shape).
// A command that isn't the plugin form throws rather than being dropped or copied through verbatim: a literal
// ${CLAUDE_PLUGIN_ROOT} in a project's settings.json would be a broken hook, so a future hooks.json entry that
// doesn't fit this shape has to be loud, not silently absent.
function vendoredCommand(pluginCommand: string, event: string, index: number, path: string): string {
  const m = PLUGIN_COMMAND_RE.exec(pluginCommand);
  if (!m) {
    throw new Error(
      `doug init: the ${event} hook ${index} in ${path} command is not the plugin form ` +
        `(node "\${CLAUDE_PLUGIN_ROOT}/scripts/<name>.mjs"): ${JSON.stringify(pluginCommand)}. ` +
        `Fix the command in the gates package.`
    );
  }
  return cmd(m[1]);
}

// Renders a value for a "found X" error message. `undefined` reads as "absent" (JSON.stringify(undefined) is
// undefined, not a string, which produced the "...: undefined" gap this hardening fixes); everything else is
// its JSON text, so a string comes back quoted and a number or a stray object is unambiguous.
function describeValue(v: unknown): string {
  return v === undefined ? "absent" : JSON.stringify(v);
}

// Renders a value's shape for a "found X" message about structure (an array vs. an object vs. a primitive)
// rather than about one field's exact value - used where the message is about what kind of thing was found,
// not what it equals.
function describeShape(v: unknown): string {
  if (v === undefined) return "undefined";
  if (v === null) return "null";
  if (Array.isArray(v)) return "an array";
  if (typeof v === "object") return "an object";
  return `${typeof v} ${JSON.stringify(v)}`;
}

// Reads and JSON-parses hooks.json, turning the two failures that aren't about the hooks shape itself (an
// unreadable file, invalid JSON) into a message that names the file and says what to do, instead of letting a
// raw fs or parser error reach bin.ts's generic "doug: <stack>" printer.
function readHooksJsonFile(path: string): unknown {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`doug init: cannot read ${path}: ${msg}. The @dougharness/gates package is incomplete; reinstall it.`);
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`doug init: ${path} is not valid JSON: ${msg}. Fix the file in the gates package.`);
  }
}

// Derives the hook wiring a generated project gets from plugins/doug-gates/hooks/hooks.json, the same
// declaration the plugin itself runs from. Checked field by field (card generated-settings-wiring-drift): the
// two describe the same 8 events, the same groups in the same order, the same matchers, scripts, and timeouts.
// They differ in exactly one way that has to survive the derivation, plus three things that are legitimately
// out of its scope:
//   1. Command prefix: the plugin form points at "${CLAUDE_PLUGIN_ROOT}/scripts/<x>.mjs"; a generated project
//      needs "$CLAUDE_PROJECT_DIR/.doug/hooks/scripts/<x>.mjs" (the vendored copy, so the project is
//      self-contained). vendoredCommand() above performs this one rewrite and nothing else.
//   2. The status line is a settings key, not a hook. hooks.json declares no statusline hook and must not;
//      STATUSLINE_COMMAND and the statusLine handling in mergeSettings stay outside this derivation.
//   3. permissions are settings-only and stay outside this derivation too.
//   4. No hook is excluded from a generated project today: every script hooks.json declares belongs in a
//      generated project. If that ever stops being true, the exclusion has to be an explicit named list here,
//      not a loosened comparison against hooks.json.
//   5. env (card no-nested-agents-gate: CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH) is settings-only too, like
//      statusLine and permissions; it stays outside this derivation.
export function dougHooks(gatesDir: string = gatesSourceDir()): Record<string, HookEntry[]> {
  const path = join(gatesDir, "hooks/hooks.json");
  const doc = readHooksJsonFile(path);
  // The whole document not being an object (an array, a string, a number, ...) is a different problem from an
  // object that merely lacks a "hooks" key, and needs its own message: describeShape(doc) would otherwise
  // describe the missing property, not the document itself, and print the confusing "found undefined" this
  // check exists to avoid.
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) {
    throw new Error(
      `doug init: ${path} is not a JSON object (found ${describeShape(doc)}); the file must have the shape ` +
        `{ "hooks": { "<Event>": [ { "matcher"?: ..., "hooks": [ ... ] } ] } }.`
    );
  }
  const hooksVal = (doc as Record<string, unknown>).hooks;
  if (hooksVal === undefined || hooksVal === null || typeof hooksVal !== "object" || Array.isArray(hooksVal)) {
    throw new Error(
      `doug init: ${path} has no "hooks" object (found ${describeShape(hooksVal)}); the file must have the shape ` +
        `{ "hooks": { "<Event>": [ { "matcher"?: ..., "hooks": [ ... ] } ] } }.`
    );
  }

  const out: Record<string, HookEntry[]> = {};
  for (const [event, groupsVal] of Object.entries(hooksVal as Record<string, unknown>)) {
    if (!Array.isArray(groupsVal)) {
      throw new Error(
        `doug init: ${path}'s "${event}" hook event is not an array (found ${describeShape(groupsVal)}); ` +
          `each event must be an array of hook groups.`
      );
    }
    out[event] = groupsVal.map((groupVal: unknown, gi: number) => {
      if (groupVal === null || typeof groupVal !== "object" || Array.isArray(groupVal)) {
        throw new Error(
          `doug init: the "${event}" hook group ${gi} in ${path} is not an object (found ${describeShape(groupVal)}); ` +
            `each group must be an object with a "hooks" array (and an optional "matcher").`
        );
      }
      const group = groupVal as Record<string, unknown>;
      if (!Array.isArray(group.hooks)) {
        throw new Error(
          `doug init: the "${event}" hook group ${gi} in ${path} has no "hooks" array (found ${describeShape(group.hooks)}); ` +
            `each group must have a "hooks": [ ... ] array of hook objects.`
        );
      }
      const hooks = group.hooks.map((hookVal: unknown, hi: number) => {
        if (hookVal === null || typeof hookVal !== "object" || Array.isArray(hookVal)) {
          throw new Error(`doug init: the ${event} hook ${hi} in ${path} is not an object (found ${describeShape(hookVal)}).`);
        }
        const h = hookVal as Record<string, unknown>;
        // Refuse rather than coerce: an absent type is not a command hook either, so a plugin field the
        // generator doesn't know how to vendor never gets silently turned into one.
        if (h.type !== "command") {
          throw new Error(
            `doug init: the ${event} hook ${hi} in ${path} has type ${describeValue(h.type)} but only "command" hooks ` +
              `can be vendored into a project; a prompt, agent, http, or mcp_tool hook has no script to copy. ` +
              `Change the hook or add vendoring for that type.`
          );
        }
        if (typeof h.command !== "string") {
          throw new Error(`doug init: the ${event} hook ${hi} in ${path} has no command string (found ${describeValue(h.command)}).`);
        }
        // Pass through, don't validate - this card's decision (hooks-json-read-hardening; the schema facts it's
        // based on are in docs/research/hooks-json-read-hardening.md, promoted there on landing): every field
        // the hook carries besides `command` rides along untouched, in hooks.json's key order, because the
        // generator's job is translating a file the plugin already runs from, not policing it against a schema
        // it doesn't fully know - Claude Code's handling of a key that isn't documented today is unverified,
        // and dropping a documented optional field (timeout, if, statusMessage, once, args, async,
        // asyncRewake, shell) would be exactly the mistranslation this card exists to remove. Spreading h
        // before overwriting `command` keeps it at its original position rather than moving it to the end.
        return { ...h, command: vendoredCommand(h.command, event, hi, path) } as HookObject;
      });
      // Pass through the group the same way: any extra key (e.g. `if`) survives untouched, and `hooks` is
      // overwritten in place so it keeps hooks.json's own key order (matcher before hooks) rather than being
      // rebuilt - which also keeps "absent stays absent": a matcher-less group here has no `matcher` key at
      // all, never an explicit `"matcher": undefined`, because JSON has no way to declare one.
      return { ...group, hooks } as HookEntry;
    });
  }
  return out;
}

function isDougEntry(e: HookEntry): boolean {
  return e.hooks.some((h) => h.command && h.command.includes(".doug/hooks/scripts/"));
}

export function permissionAllow(d: Detection, cfg: DougConfig): string[] {
  const out = new Set<string>();
  for (const c of Object.values(cfg.commands)) {
    // "pnpm test" -> Bash(pnpm test *) so flags and file args are allowed.
    out.add(`Bash(${c} *)`);
    out.add(`Bash(${c})`);
  }
  if (d.node.packageManager) {
    const pm = d.node.packageManager;
    out.add(`Bash(${pm} exec *)`);
    if (pm === "npm") out.add("Bash(npx *)");
  }
  if (d.node.singleTestCommand) {
    const bin = d.node.singleTestCommand.split(" <")[0];
    out.add(`Bash(${bin} *)`);
  }
  if (d.python.present && d.python.singleTestCommand) {
    const bin = d.python.singleTestCommand.split(" <")[0];
    out.add(`Bash(${bin} *)`);
  }
  out.add("Bash(git status *)");
  out.add("Bash(git diff *)");
  out.add("Bash(git log *)");
  return [...out];
}

export function mergeSettings(existing: Settings | null, d: Detection, cfg: DougConfig, gatesDir: string = gatesSourceDir()): Settings {
  const s: Settings = existing ? JSON.parse(JSON.stringify(existing)) : {};
  s.hooks = s.hooks || {};
  for (const [event, entries] of Object.entries(dougHooks(gatesDir))) {
    const kept = (s.hooks[event] || []).filter((e) => !isDougEntry(e));
    s.hooks[event] = [...kept, ...entries];
  }
  if (!s.statusLine || (typeof s.statusLine.command === "string" && s.statusLine.command.includes(".doug/hooks/scripts/statusline.mjs"))) {
    s.statusLine = { type: "command", command: STATUSLINE_COMMAND };
  }
  s.permissions = s.permissions || {};
  const allow = new Set<string>(s.permissions.allow || []);
  for (const rule of permissionAllow(d, cfg)) allow.add(rule);
  s.permissions.allow = [...allow];
  const deny = new Set<string>(s.permissions.deny || []);
  deny.add("Read(./.env)");
  deny.add("Read(./.env.*)");
  s.permissions.deny = [...deny];
  // Treat a missing cfg.subagents (an older config.json) as the default 1.
  const maxSpawnDepth = cfg.subagents ? cfg.subagents.maxSpawnDepth : 1;
  if (maxSpawnDepth !== null) {
    s.env = { ...(s.env || {}), [SUBAGENT_DEPTH_ENV]: String(maxSpawnDepth) };
  }
  return s;
}
