import { describe, it, expect, vi } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, cpSync, readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";

// Proves walk() in generate/proposal.ts sorts directory listings rather than relying on the filesystem to hand
// them back sorted (it usually does on macOS APFS, which would make a fixture-only test pass either way). Reverses
// the real result specifically for the two real vendored directories walk() reads, everything else passes through.
// This rig fails open: if the path match below ever stops firing (e.g. @dougharness/gates resolves from a real
// install instead of the pnpm workspace link, or plugins/doug-gates is renamed), the mock goes silent, APFS hands
// back already-sorted names on its own, and the sort assertions below would pass whether or not walk() sorts
// anything at all — exactly the vacuous-fixture trap this card exists to avoid. The `rig.hits` assertion is what
// guards against that: it fails loudly the moment the rig stops matching, so do not delete it as redundant with
// the sort assertions that follow it.
const rig = vi.hoisted(() => ({ hits: 0 }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    readdirSync: (...args: unknown[]) => {
      const dir = String(args[0]);
      if (dir.endsWith("doug-gates/scripts") || dir.endsWith("doug-gates/lib")) {
        rig.hits++;
        return [...(actual.readdirSync as (...a: unknown[]) => string[])(...args)].reverse();
      }
      return (actual.readdirSync as (...a: unknown[]) => unknown)(...args);
    },
  };
});
import { detect } from "../src/detect/index.js";
import { buildProposal, summarize } from "../src/generate/proposal.js";
import { generateConfig } from "../src/generate/config.js";
import { generateClaudeMd } from "../src/generate/claude-md.js";
import { mergeSettings, dougHooks, gatesSourceDir } from "../src/generate/settings.js";
import { applyChanges } from "../src/apply.js";
import { AGENT_MARK, LEGACY_AGENT_MARK } from "../src/generate/agents.js";
import { newBoard, loadBoard, validateBoard, DEFAULT_COLUMNS } from "@dougharness/flow/lib/board.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, "fixtures", "ts-pnpm");
const ROOT = join(here, "..", "..", "..");

function copyFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "doug-init-"));
  cpSync(fixture, dir, { recursive: true });
  return dir;
}

// Extracts a hook's script name from its plugin-form command (node "${CLAUDE_PLUGIN_ROOT}/scripts/<x>.mjs"),
// reimplemented locally rather than imported from plugins/doug-gates/tests/vendored-copies.test.mjs: that file
// belongs to plugins/doug-gates, this one to packages/doug-cli, and a doug-cli test must not depend on a
// plugin test file's internals.
function pluginScriptName(command: string): string | null {
  const m = /"\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/([^"/]+)"/.exec(command);
  return m ? m[1] : null;
}

function tempGatesDir(hooksDoc: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "doug-gates-hooks-"));
  mkdirSync(join(dir, "hooks"), { recursive: true });
  writeFileSync(join(dir, "hooks/hooks.json"), JSON.stringify(hooksDoc, null, 2));
  return dir;
}

// Same fixture shape as tempGatesDir, but writes raw text instead of JSON.stringify-ing an object, so a test
// can hand dougHooks a hooks.json that isn't even valid JSON.
function tempGatesDirRaw(hooksJsonText: string): string {
  const dir = mkdtempSync(join(tmpdir(), "doug-gates-hooks-"));
  mkdirSync(join(dir, "hooks"), { recursive: true });
  writeFileSync(join(dir, "hooks/hooks.json"), hooksJsonText);
  return dir;
}

// A gates dir whose hooks/hooks.json file was never written at all (not even the hooks/ subdirectory) - for
// the "hooks.json is missing" case.
function tempGatesDirMissing(): string {
  return mkdtempSync(join(tmpdir(), "doug-gates-hooks-"));
}

// Rewrites a plugin-form command (node "${CLAUDE_PLUGIN_ROOT}/scripts/<x>.mjs") into the vendored form dougHooks
// produces, independent of dougHooks itself (vendoredCommand isn't exported), so the "derives the generated
// wiring" test's expectations aren't computed with the same code under test.
function rewriteToVendoredCommand(pluginCommand: string): string {
  const script = pluginScriptName(pluginCommand); // already includes the .mjs extension
  if (!script) throw new Error(`test fixture bug: ${JSON.stringify(pluginCommand)} is not a plugin-form command`);
  return `node "$CLAUDE_PROJECT_DIR/.doug/hooks/scripts/${script}"`;
}

describe("generateConfig", () => {
  const d = detect(fixture);
  const cfg = generateConfig(d);
  it("wires detected commands into the stop gate in a sensible order", () => {
    expect(cfg.stopGate.commands).toEqual(["typecheck", "lint", "test"]);
    expect(cfg.commands.test).toBe("pnpm test");
  });
  it("protects lockfile, migrations, generated dirs and env files", () => {
    expect(cfg.protectedPaths).toContain("pnpm-lock.yaml");
    expect(cfg.protectedPaths).toContain("prisma/migrations/**");
    expect(cfg.protectedPaths).toContain("dist/**");
    expect(cfg.protectedPaths).toContain(".env");
    expect(cfg.protectedPaths).toContain(".doug/config.json");
    expect(cfg.stopGate.ignoreChangedPaths).toEqual(["pnpm-lock.yaml", ".doug/config.json"]);
  });
  it("turns on the package manager guard and produces anchor facts", () => {
    expect(cfg.packageManager).toBe("pnpm");
    expect(cfg.bash.packageManagerGuard).toBe(true);
    expect(cfg.anchor.join("\n")).toContain("pnpm");
    expect(cfg.checkpoint).toEqual({ enabled: false, mode: "commit" });
    expect(cfg.stopGate.planScope).toBe(true);
    expect(cfg.formatter?.command[2]).toBe("prettier");
  });
  it("carries the Doug product name, with no version field to hand-maintain (card statusline-installed-version)", () => {
    expect(cfg.doug).toEqual({ name: "Doug" });
  });
  it("proposes the project's own auto-memory directory in allowedOutsidePaths", async () => {
    const { projectSlug } = await import("@dougharness/flow/lib/cost.mjs");
    const { homedir } = await import("node:os");
    const expected = join(homedir(), ".claude", "projects", projectSlug(fixture), "memory");
    expect(cfg.allowedOutsidePaths).toEqual([expected]);
  });
});

// card bash-rules-prod, T6: generateConfig adds every d.repo.infraPaths entry to protectedPaths, after the
// generated dirs; a project with none of the infra markers (the ts-pnpm fixture) still carries no tfvars entry.
//
// Reviewer correction: the detector emits only the card's three flat patterns (glob.mjs's basename semantics
// make a **/-prefixed form dead weight), so protectedPaths must carry exactly those three and none starting
// with "**/".
describe("generateConfig: infraPaths (card bash-rules-prod, T6)", () => {
  it("adds each of the three infra/prod/**, *.tfvars, and terraform.tfstate patterns detect() found to protectedPaths, and no **/-prefixed form", () => {
    const dir = copyFixture();
    mkdirSync(join(dir, "infra/prod"), { recursive: true });
    writeFileSync(join(dir, "infra/prod/main.tf"), "x");
    writeFileSync(join(dir, "prod.tfvars"), "x");
    mkdirSync(join(dir, "envs/staging"), { recursive: true });
    writeFileSync(join(dir, "envs/staging/staging.tfvars"), "x");
    writeFileSync(join(dir, "envs/staging/terraform.tfstate"), "x");
    const cfg = generateConfig(detect(dir));
    for (const p of ["infra/prod/**", "*.tfvars", "terraform.tfstate"]) expect(cfg.protectedPaths).toContain(p);
    expect(cfg.protectedPaths.some((p) => p.startsWith("**/"))).toBe(false);
  });
  it("the ts-pnpm fixture (no infra markers) carries no tfvars entry", () => {
    const cfg = generateConfig(detect(fixture));
    expect(cfg.protectedPaths.some((p) => p.includes("tfvars"))).toBe(false);
  });
});

describe("generateClaudeMd", () => {
  it("stays short and carries commands and facts, not overviews", () => {
    const d = detect(fixture);
    const md = generateClaudeMd(d, generateConfig(d));
    const lines = md.split("\n");
    expect(lines.length).toBeLessThan(60);
    expect(md).toContain("pnpm test");
    expect(md).toContain("vitest run");
    expect(md).toContain("Package manager is **pnpm**");
    expect(md).toContain("While `.doug/plan.json` is approved, change only files its tasks own");
    expect(md).not.toMatch(/directory structure|architecture overview/i);
  });
  it("ends with a Models table with a routed plan and worker row and the rest defaulting to inherit", () => {
    const d = detect(fixture);
    const md = generateClaudeMd(d, generateConfig(d));
    const section = md.slice(md.indexOf("## Models"));
    expect(section).toMatch(/^\| Work\s+\| Model\s+\| Effort\s+\|$/m);
    expect(section).toMatch(/^\| plan\s+\| opus\s+\| high\s+\|$/m);
    expect(section).toMatch(/^\| worker\s+\| sonnet\s+\| medium\s+\|$/m);
    for (const role of ["lead", "implement", "verify", "review", "adversary", "integrate"]) expect(section).toMatch(new RegExp(`^\\| ${role}\\s+\\| inherit`, "m"));
  });
  it("parses the generated Models section with lib/models.mjs and covers every role", async () => {
    const { parseModelsSection, ROLES } = await import("@dougharness/flow/lib/models.mjs");
    const d = detect(fixture);
    const md = generateClaudeMd(d, generateConfig(d));
    const parsed = parseModelsSection(md);
    expect(parsed.errors).toEqual([]);
    expect(parsed.present).toBe(true);
    expect(Object.keys(parsed.roles).sort()).toEqual([...ROLES].sort());
    expect(parsed.roles.plan).toEqual({ model: "opus", effort: "high" });
    expect(parsed.roles.worker).toEqual({ model: "sonnet", effort: "medium" });
  });
  it("carries a prose paragraph after the table naming plan, worker, and adversary", () => {
    const d = detect(fixture);
    const md = generateClaudeMd(d, generateConfig(d));
    const section = md.slice(md.indexOf("## Models"));
    const afterTable = section.slice(section.lastIndexOf("| integrate"));
    const paragraph = afterTable.split("\n").filter((l) => l.trim().length > 0 && !l.startsWith("|"))[0] ?? "";
    expect(paragraph).toMatch(/`plan`/);
    expect(paragraph).toMatch(/`worker`/);
    expect(paragraph).toMatch(/`adversary`/);
    expect(paragraph).toMatch(/`codex-review`/);
    expect(paragraph).toMatch(/`adversary\.fallback`/);
  });
});

describe("mergeSettings", () => {
  it("keeps existing hooks and permissions and replaces prior doug entries", () => {
    const d = detect(fixture);
    const cfg = generateConfig(d);
    const existing = {
      model: "opus",
      hooks: {
        PreToolUse: [
          { matcher: "Bash", hooks: [{ type: "command", command: "echo user-hook" }] },
          { matcher: "Bash", hooks: [{ type: "command", command: 'node "$CLAUDE_PROJECT_DIR/.doug/hooks/scripts/old.mjs"' }] },
        ],
      },
      permissions: { allow: ["Bash(ls *)"] },
    };
    const merged = mergeSettings(existing as any, d, cfg) as any;
    expect(merged.model).toBe("opus");
    const pre = merged.hooks.PreToolUse.map((e: any) => e.hooks[0].command);
    expect(pre).toContain("echo user-hook");
    expect(pre.some((c: string) => c.includes("old.mjs"))).toBe(false);
    expect(pre.some((c: string) => c.includes("guard-bash.mjs"))).toBe(true);
    // Only the Edit/Write and Bash groups pair with secret-scan; the research-cap group (card research-fetch-cap)
    // is excluded by name (pass 2, P6), not by its hook count, which is a coincidence of what research-cap
    // happens to need rather than the reason it should be excluded here.
    expect(
      merged.hooks.PreToolUse.filter(
        (e: any) => e.matcher && e.matcher !== "WebFetch|WebSearch|Bash" && e.hooks[0].command.includes(".doug/hooks/scripts/")
      ).every((e: any) => e.hooks[1].command.includes("secret-scan.mjs"))
    ).toBe(true);
    // The matcher-less trace entry is a doug entry too, replaced on re-run like the others.
    expect(merged.hooks.PreToolUse.filter((e: any) => !e.matcher).map((e: any) => e.hooks[0].command)).toEqual(['node "$CLAUDE_PROJECT_DIR/.doug/hooks/scripts/trace.mjs"']);
    expect(merged.permissions.allow).toContain("Bash(ls *)");
    expect(merged.permissions.allow).toContain("Bash(pnpm test *)");
    expect(merged.permissions.deny).toContain("Read(./.env)");
    expect(merged.hooks.Stop[0].hooks[0].command).toContain("stop-gate.mjs");
  });
  it("adds the matcher-less baseline capture to SessionStart, even upgrading a project vendored before it existed", () => {
    const d = detect(fixture);
    const cfg = generateConfig(d);
    const existing = {
      hooks: { SessionStart: [{ matcher: "compact|resume", hooks: [{ type: "command", command: 'node "$CLAUDE_PROJECT_DIR/.doug/hooks/scripts/reanchor.mjs"', timeout: 5 }] }] },
    };
    const merged = mergeSettings(existing as any, d, cfg) as any;
    expect(merged.hooks.SessionStart).toHaveLength(2);
    expect(merged.hooks.SessionStart[1].matcher).toBeUndefined();
    expect(merged.hooks.SessionStart[1].hooks[0].command).toContain("session-start-baseline.mjs");
  });
  it("adds the status line when none is present", () => {
    const d = detect(fixture);
    const cfg = generateConfig(d);
    const merged = mergeSettings({ hooks: {} } as any, d, cfg) as any;
    expect(merged.statusLine).toEqual({ type: "command", command: "node .doug/hooks/scripts/statusline.mjs" });
  });
  it("keeps a user's own status line unchanged", () => {
    const d = detect(fixture);
    const cfg = generateConfig(d);
    const existing = { hooks: {}, statusLine: { type: "command", command: "my-status" } };
    const merged = mergeSettings(existing as any, d, cfg) as any;
    expect(merged.statusLine).toEqual({ type: "command", command: "my-status" });
  });
  it("replaces a legacy Doug status line command with the current one", () => {
    const d = detect(fixture);
    const cfg = generateConfig(d);
    const existing = {
      hooks: {},
      statusLine: { type: "command", command: 'node "$CLAUDE_PROJECT_DIR/.doug/hooks/scripts/statusline.mjs"' },
    };
    const merged = mergeSettings(existing as any, d, cfg) as any;
    expect(merged.statusLine).toEqual({ type: "command", command: "node .doug/hooks/scripts/statusline.mjs" });
  });

  // Card no-nested-agents-gate: mergeSettings writes the subagent spawn depth into env, settings-only, never
  // through a hook.
  describe("subagent spawn depth (card no-nested-agents-gate)", () => {
    it("writes env.CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH = \"1\" on an empty settings object, with the default config", () => {
      const d = detect(fixture);
      const cfg = generateConfig(d);
      const merged = mergeSettings({} as any, d, cfg) as any;
      expect(merged.env).toEqual({ CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: "1" });
    });
    it("keeps an existing env key and adds ours alongside it", () => {
      const d = detect(fixture);
      const cfg = generateConfig(d);
      const existing = { hooks: {}, env: { FOO: "bar" } };
      const merged = mergeSettings(existing as any, d, cfg) as any;
      expect(merged.env).toEqual({ FOO: "bar", CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: "1" });
    });
    it("maxSpawnDepth: null leaves an existing env untouched, including a different value of our own variable, and adds no env when there was none", () => {
      const d = detect(fixture);
      const cfg = { ...generateConfig(d), subagents: { maxSpawnDepth: null } };
      const existingWithOurVar = { hooks: {}, env: { FOO: "bar", CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: "3" } };
      const merged = mergeSettings(existingWithOurVar as any, d, cfg) as any;
      expect(merged.env).toEqual({ FOO: "bar", CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: "3" });

      const merged2 = mergeSettings({ hooks: {} } as any, d, cfg) as any;
      expect(merged2.env).toBeUndefined();
    });
    it("is idempotent across two merges", () => {
      const d = detect(fixture);
      const cfg = generateConfig(d);
      const once = mergeSettings({} as any, d, cfg) as any;
      const twice = mergeSettings(once, d, cfg) as any;
      expect(twice.env).toEqual({ CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: "1" });
    });
    it("treats a config with no subagents field at all as 1 (an older config.json)", () => {
      const d = detect(fixture);
      const cfg = generateConfig(d) as any;
      delete cfg.subagents;
      const merged = mergeSettings({} as any, d, cfg) as any;
      expect(merged.env).toEqual({ CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: "1" });
    });
    it("this repository's own .claude/settings.json carries the setting", () => {
      const settingsPath = join(ROOT, ".claude/settings.json");
      const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
      expect(settings.env?.CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH, `${settingsPath} is missing env.CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH (card no-nested-agents-gate)`).toBe("1");
    });
  });
});

describe("dougHooks derives the generated wiring from plugins/doug-gates/hooks/hooks.json", () => {
  it("equals what the plugin declares: same event, matcher, group order, and every hook field, only the command prefix rewritten", () => {
    const d = detect(fixture);
    const cfg = generateConfig(d);
    const merged = mergeSettings({ hooks: {} } as any, d, cfg) as any;
    const pluginHooks = JSON.parse(readFileSync(join(ROOT, "plugins/doug-gates/hooks/hooks.json"), "utf8")).hooks;

    // Same events, same order, on both sides first: iterating only hooks.json's events below would miss an
    // event that's present in the generated wiring but absent from hooks.json (or vice versa).
    expect(Object.keys(merged.hooks)).toEqual(Object.keys(pluginHooks));

    // Whole-object comparison (not a 4-field wiringKey) so a field the reader silently drops or adds is
    // visible: only `command` is expected to differ, rewritten from the plugin form to the vendored form.
    for (const [event, groups] of Object.entries(pluginHooks) as [string, any[]][]) {
      const wiredGroups = merged.hooks[event];
      expect(wiredGroups, `event ${event} is declared in hooks.json but missing from the generated wiring`).toBeDefined();
      expect(wiredGroups.length, `event ${event}: hooks.json has ${groups.length} group(s), generated wiring has ${wiredGroups?.length}`).toBe(groups.length);
      groups.forEach((group: any, gi: number) => {
        const wiredGroup = wiredGroups[gi];
        const expectedGroup = { ...group, hooks: group.hooks.map((h: any) => ({ ...h, command: rewriteToVendoredCommand(h.command) })) };
        expect(
          wiredGroup,
          `event ${event} group ${gi} differs from hooks.json's declaration (a dropped, added, or mistranslated field):\n` +
            `  hooks.json declares: ${JSON.stringify(expectedGroup)}\n` +
            `  generated wiring has: ${JSON.stringify(wiredGroup)}`
        ).toEqual(expectedGroup);
      });
    }
  });

  it("flows a changed hooks.json through: an added hook, a changed timeout, and a changed matcher all show up", () => {
    const base = {
      hooks: {
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [{ type: "command", command: 'node "${CLAUDE_PLUGIN_ROOT}/scripts/foo.mjs"', timeout: 5 }],
          },
          { hooks: [{ type: "command", command: 'node "${CLAUDE_PLUGIN_ROOT}/scripts/bar.mjs"', timeout: 30 }] },
        ],
      },
    };
    const before = dougHooks(tempGatesDir(base));
    expect(before.PreToolUse[0].matcher).toBe("Bash");
    expect(before.PreToolUse[0].hooks).toEqual([{ type: "command", command: 'node "$CLAUDE_PROJECT_DIR/.doug/hooks/scripts/foo.mjs"', timeout: 5 }]);

    // Drift: an added hook (baz) in the Bash group, foo's timeout changed 5 -> 15, and the group's matcher
    // changed Bash -> Edit|Write.
    const changed = {
      hooks: {
        PreToolUse: [
          {
            matcher: "Edit|Write",
            hooks: [
              { type: "command", command: 'node "${CLAUDE_PLUGIN_ROOT}/scripts/foo.mjs"', timeout: 15 },
              { type: "command", command: 'node "${CLAUDE_PLUGIN_ROOT}/scripts/baz.mjs"', timeout: 5 },
            ],
          },
          { hooks: [{ type: "command", command: 'node "${CLAUDE_PLUGIN_ROOT}/scripts/bar.mjs"', timeout: 30 }] },
        ],
      },
    };
    const after = dougHooks(tempGatesDir(changed));

    // Changed matcher.
    expect(after.PreToolUse[0].matcher).toBe("Edit|Write");
    // Changed timeout.
    expect(after.PreToolUse[0].hooks[0]).toEqual({ type: "command", command: 'node "$CLAUDE_PROJECT_DIR/.doug/hooks/scripts/foo.mjs"', timeout: 15 });
    // Added hook.
    expect(after.PreToolUse[0].hooks[1]).toEqual({ type: "command", command: 'node "$CLAUDE_PROJECT_DIR/.doug/hooks/scripts/baz.mjs"', timeout: 5 });
  });

  it("throws a doug init: message naming the file, the event and the command, when a hooks.json command isn't the plugin form", () => {
    const bad = {
      hooks: {
        Stop: [{ hooks: [{ type: "command", command: "echo not-a-plugin-command", timeout: 600 }] }],
      },
    };
    const dir = tempGatesDir(bad);
    const path = join(dir, "hooks/hooks.json");
    expect(() => dougHooks(dir)).toThrow(/^doug init:/);
    expect(() => dougHooks(dir)).toThrow(/Stop/);
    expect(() => dougHooks(dir)).toThrow(/echo not-a-plugin-command/);
    expect(() => dougHooks(dir)).toThrow(new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });

  it("keeps the status line out of the derivation", () => {
    const derived = dougHooks(gatesSourceDir());
    const commands = Object.values(derived)
      .flat()
      .flatMap((e) => e.hooks.map((h) => h.command));
    expect(commands.some((c) => c.includes("statusline.mjs"))).toBe(false);
  });

  it("mergeSettings threads its gatesDir argument through to dougHooks, rather than always reading the real gates package", () => {
    const d = detect(fixture);
    const cfg = generateConfig(d);
    const fake = {
      hooks: {
        Stop: [{ hooks: [{ type: "command", command: 'node "${CLAUDE_PLUGIN_ROOT}/scripts/only-fake.mjs"', timeout: 5 }] }],
      },
    };
    const merged = mergeSettings(null, d, cfg, tempGatesDir(fake)) as any;
    // Only what the fake gates dir declares shows up: not the real gates package's PreToolUse, PostToolUse, etc.
    expect(Object.keys(merged.hooks)).toEqual(["Stop"]);
    expect(merged.hooks.Stop).toEqual([{ hooks: [{ type: "command", command: 'node "$CLAUDE_PROJECT_DIR/.doug/hooks/scripts/only-fake.mjs"', timeout: 5 }] }]);
  });
});

// Card hooks-json-read-hardening: dougHooks() does I/O and used to trust hooks.json's shape completely, so a
// malformed file produced a raw runtime error (ENOENT, SyntaxError, "Cannot convert undefined or null to
// object", "Cannot read properties of undefined (reading 'map')") that bin.ts printed as "doug: <stack>",
// naming neither doug init, the gates package, nor the fix. Every case below must instead throw a legible
// Error whose message starts with "doug init:" and names the file.
describe("dougHooks refuses a malformed hooks.json with a legible doug init: message", () => {
  it("names the file when hooks.json is missing entirely", () => {
    const dir = tempGatesDirMissing();
    const path = join(dir, "hooks/hooks.json");
    expect(() => dougHooks(dir)).toThrow(/^doug init: cannot read /);
    expect(() => dougHooks(dir)).toThrow(new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });

  it("names the file and the parser's message when hooks.json is not valid JSON", () => {
    const dir = tempGatesDirRaw("{ this is not json");
    const path = join(dir, "hooks/hooks.json");
    expect(() => dougHooks(dir)).toThrow(/^doug init: .*is not valid JSON/);
    expect(() => dougHooks(dir)).toThrow(new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });

  it("refuses a file with no top-level \"hooks\" key", () => {
    const dir = tempGatesDir({ notHooks: {} });
    expect(() => dougHooks(dir)).toThrow(/doug init:/);
    expect(() => dougHooks(dir)).toThrow(/"hooks"/);
    expect(() => dougHooks(dir)).toThrow(/found undefined/);
  });

  it("refuses a file whose top-level \"hooks\" is null", () => {
    const dir = tempGatesDir({ hooks: null });
    expect(() => dougHooks(dir)).toThrow(/doug init:/);
    expect(() => dougHooks(dir)).toThrow(/"hooks"/);
    expect(() => dougHooks(dir)).toThrow(/found null/);
  });

  it("refuses a document that is not a JSON object at all (an array), describing the document, not a missing property", () => {
    const dir = tempGatesDir([1, 2, 3]);
    expect(() => dougHooks(dir)).toThrow(/doug init:/);
    expect(() => dougHooks(dir)).toThrow(/is not a JSON object/);
    expect(() => dougHooks(dir)).toThrow(/found an array/);
  });

  it("refuses an event whose value is not an array, naming the event", () => {
    const dir = tempGatesDir({ hooks: { Stop: { hooks: [] } } });
    expect(() => dougHooks(dir)).toThrow(/doug init:/);
    expect(() => dougHooks(dir)).toThrow(/"Stop"/);
    expect(() => dougHooks(dir)).toThrow(/not an array/);
  });

  it("refuses a group with no \"hooks\" array, naming the event and the group index", () => {
    const dir = tempGatesDir({ hooks: { Stop: [{ matcher: "Bash" }] } });
    expect(() => dougHooks(dir)).toThrow(/doug init:/);
    expect(() => dougHooks(dir)).toThrow(/"Stop"/);
    expect(() => dougHooks(dir)).toThrow(/group 0/);
    expect(() => dougHooks(dir)).toThrow(/"hooks" array/);
  });

  it("refuses a group that is null, naming the event and the group index, rather than throwing a raw TypeError", () => {
    const dir = tempGatesDir({ hooks: { Stop: [null] } });
    expect(() => dougHooks(dir)).toThrow(/doug init:/);
    expect(() => dougHooks(dir)).toThrow(/"Stop"/);
    expect(() => dougHooks(dir)).toThrow(/group 0/);
  });

  it("refuses a hook that is null, naming the event and the hook index, rather than throwing a raw TypeError", () => {
    const dir = tempGatesDir({ hooks: { Stop: [{ hooks: [null] }] } });
    expect(() => dougHooks(dir)).toThrow(/doug init:/);
    expect(() => dougHooks(dir)).toThrow(/Stop hook 0/);
  });

  it("refuses (never coerces) a hook whose type is not \"command\", naming the type found", () => {
    const dir = tempGatesDir({ hooks: { Stop: [{ hooks: [{ type: "prompt", prompt: "say hi" }] }] } });
    expect(() => dougHooks(dir)).toThrow(/doug init:/);
    expect(() => dougHooks(dir)).toThrow(/Stop hook 0/);
    expect(() => dougHooks(dir)).toThrow(/has type "prompt"/);
  });

  it("refuses (never defaults to command) a hook with no type field at all", () => {
    const dir = tempGatesDir({ hooks: { Stop: [{ hooks: [{ command: 'node "${CLAUDE_PLUGIN_ROOT}/scripts/x.mjs"' }] }] } });
    expect(() => dougHooks(dir)).toThrow(/doug init:/);
    expect(() => dougHooks(dir)).toThrow(/has type absent/);
  });

  it("refuses a command hook with a missing command, printing \"absent\" rather than nothing", () => {
    const dir = tempGatesDir({ hooks: { Stop: [{ hooks: [{ type: "command" }] }] } });
    expect(() => dougHooks(dir)).toThrow(/doug init:/);
    expect(() => dougHooks(dir)).toThrow(/Stop hook 0/);
    expect(() => dougHooks(dir)).toThrow(/no command string \(found absent\)/);
  });

  it("refuses a command hook whose command is not a string, naming the value found", () => {
    const dir = tempGatesDir({ hooks: { Stop: [{ hooks: [{ type: "command", command: 42 }] }] } });
    expect(() => dougHooks(dir)).toThrow(/doug init:/);
    expect(() => dougHooks(dir)).toThrow(/no command string \(found 42\)/);
  });
});

describe("dougHooks passes unknown group and hook fields through untouched", () => {
  it("carries an extra group key and extra hook keys through, in hooks.json's key order, rewriting only command", () => {
    const doc = {
      hooks: {
        PreToolUse: [
          {
            matcher: "Bash",
            if: "Bash(git *)",
            hooks: [
              {
                type: "command",
                command: 'node "${CLAUDE_PLUGIN_ROOT}/scripts/foo.mjs"',
                timeout: 5,
                blocking: true,
                statusMessage: "checking...",
                async: true,
                shell: "bash",
              },
            ],
          },
        ],
      },
    };
    const out = dougHooks(tempGatesDir(doc)) as any;
    const group = out.PreToolUse[0];

    expect(group).toEqual({
      matcher: "Bash",
      if: "Bash(git *)",
      hooks: [
        {
          type: "command",
          command: 'node "$CLAUDE_PROJECT_DIR/.doug/hooks/scripts/foo.mjs"',
          timeout: 5,
          blocking: true,
          statusMessage: "checking...",
          async: true,
          shell: "bash",
        },
      ],
    });
    expect(Object.keys(group)).toEqual(["matcher", "if", "hooks"]);
    expect(Object.keys(group.hooks[0])).toEqual(["type", "command", "timeout", "blocking", "statusMessage", "async", "shell"]);
  });
});

describe("buildProposal + applyChanges", () => {
  it("proposes config, vendored hooks, settings, CLAUDE.md and gitignore, then writes them", () => {
    const dir = copyFixture();
    const p = buildProposal(detect(dir));
    const paths = p.changes.map((c) => c.path);
    expect(paths).toContain(".doug/config.json");
    expect(paths).toContain(".doug/board.json");
    expect(paths).toContain(".doug/hooks/scripts/stop-gate.mjs");
    expect(paths).toContain(".doug/hooks/scripts/statusline.mjs");
    expect(paths).toContain(".doug/hooks/lib/io.mjs");
    expect(paths).toContain(".doug/hooks/scripts/secret-scan.mjs");
    expect(paths).toContain(".doug/hooks/lib/secret-rules.mjs");
    const stopGateChange = p.changes.find((c) => c.path === ".doug/hooks/scripts/stop-gate.mjs")!;
    expect(stopGateChange.reason).toContain("doug init");
    expect(stopGateChange.reason).not.toContain("--upgrade");
    expect(paths).toContain(".claude/settings.json");
    expect(paths).toContain("CLAUDE.md");
    expect(paths).toContain(".gitignore");
    expect(paths).toContain(".claude/agents/coder.md");
    expect(paths).toContain(".claude/agents/architect.md");
    expect(paths).toContain(".claude/agents/reviewer.md");
    expect(paths).toContain(".claude/agents/researcher.md");
    expect(paths).toContain(".claude/agents/tester.md");
    applyChanges(dir, p.changes);
    expect(existsSync(join(dir, ".doug/hooks/scripts/guard-bash.mjs"))).toBe(true);
    expect(existsSync(join(dir, ".doug/board.json"))).toBe(true);
    expect(existsSync(join(dir, ".claude/agents/coder.md"))).toBe(true);
    expect(readFileSync(join(dir, ".gitignore"), "utf8")).toContain(".doug/.state/");
    const settings = JSON.parse(readFileSync(join(dir, ".claude/settings.json"), "utf8"));
    // Card research-fetch-cap adds a WebFetch|WebSearch group between Bash and the matcher-less trace entry.
    expect(settings.hooks.PreToolUse).toHaveLength(4);
    expect(settings.hooks.PreToolUse.slice(0, 2).every((e: any) => e.hooks[1].command.includes("secret-scan.mjs"))).toBe(true);
    expect(settings.hooks.PreToolUse[2]).toEqual({
      matcher: "WebFetch|WebSearch|Bash",
      hooks: [{ type: "command", command: 'node "$CLAUDE_PROJECT_DIR/.doug/hooks/scripts/research-cap.mjs"', timeout: 5 }],
    });
    // The trace entry has no matcher, so every tool call is traced; SubagentStart and SubagentStop trace too.
    expect(settings.hooks.PreToolUse[3]).toEqual({ hooks: [{ type: "command", command: 'node "$CLAUDE_PROJECT_DIR/.doug/hooks/scripts/trace.mjs"', timeout: 5 }] });
    for (const ev of ["PostToolUse", "SubagentStart", "SubagentStop"]) expect(JSON.stringify(settings.hooks[ev])).toContain("trace.mjs");
    for (const ev of ["SessionStart", "PostCompact", "PreCompact"]) expect(JSON.stringify(settings.hooks[ev])).toContain("reanchor.mjs");
    // SessionStart also carries the matcher-less baseline capture (card stop-gate-session-start), alongside
    // the compact|resume reanchor entry, so a fresh doug init project actually runs the vendored script.
    expect(settings.hooks.SessionStart).toHaveLength(2);
    expect(settings.hooks.SessionStart[0].matcher).toBe("compact|resume");
    expect(settings.hooks.SessionStart[1].matcher).toBeUndefined();
    expect(settings.hooks.SessionStart[1].hooks[0].command).toContain("session-start-baseline.mjs");
    expect(existsSync(join(dir, ".doug/hooks/scripts/session-start-baseline.mjs"))).toBe(true);
    expect(settings.hooks.SubagentStop[0].hooks.map((h: any) => h.command)).toEqual(['node "$CLAUDE_PROJECT_DIR/.doug/hooks/scripts/trace.mjs"', 'node "$CLAUDE_PROJECT_DIR/.doug/hooks/scripts/stop-gate.mjs"']);
    expect(existsSync(join(dir, ".doug/hooks/scripts/trace.mjs"))).toBe(true);
    expect(settings.statusLine.command).toBe("node .doug/hooks/scripts/statusline.mjs");
    // Card no-nested-agents-gate: the generated settings.json carries the subagent spawn depth.
    expect(settings.env.CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH).toBe("1");
    const writtenConfig = JSON.parse(readFileSync(join(dir, ".doug/config.json"), "utf8"));
    expect(writtenConfig.doug.name).toBe("Doug");
    expect(writtenConfig.secrets.enabled).toBe(true);
    // Second run proposes nothing.
    const again = buildProposal(detect(dir));
    expect(again.changes).toEqual([]);
  });
  // Pins learn-signals' two trace events (InstructionsLoaded, PermissionDenied) on the settings.json doug init
  // actually writes, so a later hooks.json edit that drops either one fails this test instead of passing silently
  // (the generic derivation test compares generated wiring to hooks.json itself, so both sides would change together).
  it("carries the InstructionsLoaded and PermissionDenied trace groups from learn-signals", () => {
    const dir = copyFixture();
    const p = buildProposal(detect(dir));
    applyChanges(dir, p.changes);
    const settings = JSON.parse(readFileSync(join(dir, ".claude/settings.json"), "utf8"));
    const traceGroup = { hooks: [{ type: "command", command: 'node "$CLAUDE_PROJECT_DIR/.doug/hooks/scripts/trace.mjs"', timeout: 5 }] };
    expect(settings.hooks.InstructionsLoaded).toContainEqual(traceGroup);
    expect(settings.hooks.PermissionDenied).toContainEqual(traceGroup);
  });
  it("carries the research-cap gate's PreToolUse entry, wired for WebFetch and WebSearch (card research-fetch-cap)", () => {
    const dir = copyFixture();
    const p = buildProposal(detect(dir));
    applyChanges(dir, p.changes);
    const settings = JSON.parse(readFileSync(join(dir, ".claude/settings.json"), "utf8"));
    const preToolUse = settings.hooks.PreToolUse as { matcher?: string; hooks: { command: string }[] }[];
    const group = preToolUse.find((g) => g.matcher === "WebFetch|WebSearch|Bash");
    expect(group, `no WebFetch|WebSearch|Bash PreToolUse group in ${JSON.stringify(preToolUse, null, 2)}`).toBeDefined();
    expect(group!.hooks.some((h) => h.command.includes("research-cap.mjs"))).toBe(true);
    expect(existsSync(join(dir, ".doug/hooks/scripts/research-cap.mjs"))).toBe(true);
  });

  it("leaves an existing CLAUDE.md alone and says so", () => {
    const dir = copyFixture();
    writeFileSync(join(dir, "CLAUDE.md"), "# mine\n");
    const p = buildProposal(detect(dir));
    expect(p.changes.map((c) => c.path)).not.toContain("CLAUDE.md");
    expect(p.notes.join(" ")).toContain("CLAUDE.md already exists");
  });
  it("does not touch an unparseable settings.json", () => {
    const dir = copyFixture();
    mkdirSync(join(dir, ".claude"));
    writeFileSync(join(dir, ".claude/settings.json"), "{ nope");
    const p = buildProposal(detect(dir));
    expect(p.changes.map((c) => c.path)).not.toContain(".claude/settings.json");
    expect(p.notes.join(" ")).toContain("not valid JSON");
  });
  it("leaves a file with neither marker alone and says so, naming doug: generated", () => {
    const dir = copyFixture();
    mkdirSync(join(dir, ".claude/agents"), { recursive: true });
    writeFileSync(join(dir, ".claude/agents/coder.md"), "---\nname: coder\n---\nmine\n");
    const p = buildProposal(detect(dir));
    const paths = p.changes.map((c) => c.path);
    expect(paths).not.toContain(".claude/agents/coder.md");
    expect(paths).toContain(".claude/agents/architect.md");
    expect(paths).toContain(".claude/agents/reviewer.md");
    expect(paths).toContain(".claude/agents/researcher.md");
    expect(paths).toContain(".claude/agents/tester.md");
    expect(p.notes.join(" ")).toContain("not written by doug init");
    expect(p.notes.join(" ")).toContain("doug: generated");
  });
  it("refreshes an old-form (LEGACY_AGENT_MARK) agent file into the new doug: generated form with an empty ## Project notes section", () => {
    const dir = copyFixture();
    mkdirSync(join(dir, ".claude/agents"), { recursive: true });
    const stale = LEGACY_AGENT_MARK + "\nstale";
    writeFileSync(join(dir, ".claude/agents/reviewer.md"), stale);
    const p = buildProposal(detect(dir));
    const change = p.changes.find((c) => c.path === ".claude/agents/reviewer.md");
    expect(change).toBeDefined();
    expect(change!.before).toBe(stale);
    expect(change!.after).toContain(AGENT_MARK);
    expect(change!.after.includes("<!--")).toBe(false);
    expect(change!.after.endsWith("\n## Project notes\n")).toBe(true);
  });
  it("preserves a new-form agent file's ## Project notes content byte for byte across a refresh while refreshing its facts", () => {
    const dir = copyFixture();
    mkdirSync(join(dir, ".claude/agents"), { recursive: true });
    const customNotes = "- Never add commit trailers.\n- Two tracks: see docs/decisions/0005.\n";
    const existing =
      `---\nname: reviewer\ndescription: "stale"\nmodel: inherit\ntools: Read, Grep, Glob, Bash\n` +
      `disallowedTools: Edit, Write, MultiEdit, NotebookEdit\n${AGENT_MARK}\n---\n\n## Rules\n\n- stale rule\n\n## Project notes\n` +
      customNotes;
    writeFileSync(join(dir, ".claude/agents/reviewer.md"), existing);
    const p = buildProposal(detect(dir));
    const change = p.changes.find((c) => c.path === ".claude/agents/reviewer.md");
    expect(change).toBeDefined();
    expect(change!.after.endsWith(customNotes)).toBe(true);
    expect(change!.after).not.toContain("stale rule");
    expect(change!.after).toContain(AGENT_MARK);
  });
  it("summarizes the standard agents it would propose", () => {
    const d = detect(fixture);
    const p = buildProposal(d);
    expect(summarize(p)).toMatch(/agents\s+coder, architect, reviewer, researcher, tester/);
  });
  it("walks vendored scripts/ and lib/ in sorted order, independent of the readdirSync order the mock rigs", () => {
    const dir = copyFixture();
    const p = buildProposal(detect(dir));
    // Guards the rig itself (see the comment above the vi.mock block): if this is 0, the mock never matched
    // the real vendored directories and the assertions below would be proving nothing.
    expect(rig.hits).toBeGreaterThan(0);
    const names = (prefix: string) =>
      p.changes.filter((c) => c.path.startsWith(prefix)).map((c) => c.path.slice(prefix.length));
    const scripts = names(".doug/hooks/scripts/");
    const lib = names(".doug/hooks/lib/");
    expect(scripts.length).toBeGreaterThan(0);
    expect(lib.length).toBeGreaterThan(0);
    expect(scripts).toEqual([...scripts].sort());
    expect(lib).toEqual([...lib].sort());
  });
  it("carries the auto-memory directory in allowedOutsidePaths through the approval diff for .doug/config.json", async () => {
    const dir = copyFixture();
    const { projectSlug } = await import("@dougharness/flow/lib/cost.mjs");
    const { homedir } = await import("node:os");
    const expected = join(homedir(), ".claude", "projects", projectSlug(dir), "memory");
    const p = buildProposal(detect(dir));
    const change = p.changes.find((c) => c.path === ".doug/config.json");
    expect(change).toBeDefined();
    expect(change!.after).toContain(expected);
    applyChanges(dir, p.changes);
    const written = JSON.parse(readFileSync(join(dir, ".doug/config.json"), "utf8"));
    expect(written.allowedOutsidePaths).toEqual([expected]);
  });
  it("proposes an empty board with the default columns for a fresh project", () => {
    const dir = copyFixture();
    const p = buildProposal(detect(dir));
    const change = p.changes.find((c) => c.path === ".doug/board.json");
    expect(change).toBeDefined();
    expect(change!.before).toBeNull();
    expect(change!.reason).toContain("/doug-next");
    const parsed = JSON.parse(change!.after!);
    expect(parsed.columns).toEqual(DEFAULT_COLUMNS);
    expect(parsed.cards).toEqual([]);
    expect(parsed.components).toEqual([]);
    expect(validateBoard(parsed)).toEqual([]);
    applyChanges(dir, p.changes);
    expect(loadBoard(dir)).toEqual(parsed);
  });
  it("does not propose a board when .doug/board.json already exists", () => {
    const dir = copyFixture();
    mkdirSync(join(dir, ".doug"), { recursive: true });
    const existing = JSON.stringify(newBoard(), null, 2) + "\n";
    writeFileSync(join(dir, ".doug/board.json"), existing);
    const p = buildProposal(detect(dir));
    expect(p.changes.map((c) => c.path)).not.toContain(".doug/board.json");
    expect(p.changes.map((c) => c.path)).toContain(".doug/config.json");
    applyChanges(dir, p.changes);
    expect(readFileSync(join(dir, ".doug/board.json"), "utf8")).toBe(existing);
  });
  it("does not propose a board when only docs/board.json exists", () => {
    const dir = copyFixture();
    mkdirSync(join(dir, "docs"), { recursive: true });
    writeFileSync(join(dir, "docs/board.json"), JSON.stringify(newBoard(), null, 2) + "\n");
    const p = buildProposal(detect(dir));
    expect(p.changes.map((c) => c.path)).not.toContain(".doug/board.json");
    applyChanges(dir, p.changes);
    expect(existsSync(join(dir, ".doug/board.json"))).toBe(false);
  });
  it("skips writing a proposed file that was created since the proposal was built, leaving it untouched", () => {
    const dir = copyFixture();
    const p = buildProposal(detect(dir));
    const boardChange = p.changes.find((c) => c.path === ".doug/board.json");
    expect(boardChange).toBeDefined();
    expect(boardChange!.before).toBeNull();
    mkdirSync(join(dir, ".doug"), { recursive: true });
    const populated = JSON.stringify({ ...newBoard(), cards: [{ id: "c1", column: "ready", title: "t", goal: "g" }] }, null, 2) + "\n";
    writeFileSync(join(dir, ".doug/board.json"), populated);
    const written = applyChanges(dir, p.changes);
    expect(readFileSync(join(dir, ".doug/board.json"), "utf8")).toBe(populated);
    expect(written).not.toContain(".doug/board.json");
    expect(written).toContain(".doug/config.json");
  });
  it("P1: proposes .doug/hooks/VERSION recording the installed gates package's version (card statusline-installed-version)", () => {
    const dir = copyFixture();
    const p = buildProposal(detect(dir));
    const change = p.changes.find((c) => c.path === ".doug/hooks/VERSION");
    expect(change).toBeDefined();
    const gatesVersion = JSON.parse(readFileSync(join(gatesSourceDir(), "package.json"), "utf8")).version;
    expect(change!.after).toBe(gatesVersion + "\n");
  });

  it("P2: a re-run re-syncs a stale .doug/hooks/VERSION to the installed version, and touches nothing else", () => {
    const dir = copyFixture();
    const p0 = buildProposal(detect(dir));
    applyChanges(dir, p0.changes);
    writeFileSync(join(dir, ".doug/hooks/VERSION"), "0.1.0\n");
    const p1 = buildProposal(detect(dir));
    expect(p1.changes.map((c) => c.path)).toEqual([".doug/hooks/VERSION"]);
    const gatesVersion = JSON.parse(readFileSync(join(gatesSourceDir(), "package.json"), "utf8")).version;
    expect(p1.changes[0].after).toBe(gatesVersion + "\n");
  });

  it("also guards .doug/config.json against a file created since the proposal was built", () => {
    const dir = copyFixture();
    const p = buildProposal(detect(dir));
    const configChange = p.changes.find((c) => c.path === ".doug/config.json");
    expect(configChange).toBeDefined();
    expect(configChange!.before).toBeNull();
    mkdirSync(join(dir, ".doug"), { recursive: true });
    const populated = "not what doug init would write\n";
    writeFileSync(join(dir, ".doug/config.json"), populated);
    const written = applyChanges(dir, p.changes);
    expect(readFileSync(join(dir, ".doug/config.json"), "utf8")).toBe(populated);
    expect(written).not.toContain(".doug/config.json");
  });
});

describe("buildProposal: generated project skills", () => {
  it("proposes and writes generated project skills, including preflight's bundled script, carrying the doug: generated marker", () => {
    const dir = copyFixture();
    const p = buildProposal(detect(dir));
    const paths = p.changes.map((c) => c.path);
    expect(paths).toContain(".claude/skills/test/SKILL.md");
    expect(paths).toContain(".claude/skills/preflight/scripts/preflight.sh");
    applyChanges(dir, p.changes);
    expect(existsSync(join(dir, ".claude/skills/test/SKILL.md"))).toBe(true);
    expect(existsSync(join(dir, ".claude/skills/preflight/scripts/preflight.sh"))).toBe(true);
    const written = readFileSync(join(dir, ".claude/skills/test/SKILL.md"), "utf8");
    expect(written).toContain(AGENT_MARK);
  });
  it("leaves a hand-written SKILL.md with no marker untouched and notes the path", () => {
    const dir = copyFixture();
    mkdirSync(join(dir, ".claude/skills/test"), { recursive: true });
    writeFileSync(join(dir, ".claude/skills/test/SKILL.md"), "---\nname: test\n---\nmine\n");
    const p = buildProposal(detect(dir));
    const paths = p.changes.map((c) => c.path);
    expect(paths).not.toContain(".claude/skills/test/SKILL.md");
    expect(p.notes.join(" ")).toContain(".claude/skills/test/SKILL.md exists and was not written by doug init");
  });
  it("preserves a generated SKILL.md's filled-in ## Project notes section across a refresh", () => {
    const dir = copyFixture();
    const p0 = buildProposal(detect(dir));
    applyChanges(dir, p0.changes);
    const customNotes = "- Ask before adding a new script.\n";
    const generated = readFileSync(join(dir, ".claude/skills/test/SKILL.md"), "utf8");
    const existing = generated
      .replace('description: "Runs the project\'s test suite"', 'description: "stale description"')
      .replace(/## Project notes\n$/, `## Project notes\n${customNotes}`);
    writeFileSync(join(dir, ".claude/skills/test/SKILL.md"), existing);
    const p1 = buildProposal(detect(dir));
    const change = p1.changes.find((c) => c.path === ".claude/skills/test/SKILL.md");
    expect(change).toBeDefined();
    expect(change!.after.endsWith(customNotes)).toBe(true);
    expect(change!.after).not.toContain("stale description");
  });
  it("summarizes the generated skills in a skills row", () => {
    const d = detect(fixture);
    const p = buildProposal(d);
    expect(summarize(p)).toMatch(/skills\s+.*doug-skills/);
  });
  it("on an empty project directory, generates only doug-skills and names each skipped skill with its detector reason", () => {
    const dir = mkdtempSync(join(tmpdir(), "doug-init-empty-"));
    const d = detect(dir);
    expect(d.repo.isGit).toBe(false);
    const p = buildProposal(d);
    const paths = p.changes.map((c) => c.path);
    expect(paths).toContain(".claude/skills/doug-skills/SKILL.md");
    const summary = summarize(p);
    expect(summary).toMatch(/skills\s+doug-skills\s*$/m);
    expect(summary).toContain("no test command detected: test skipped; run /doug-skills when one exists");
    expect(summary).toContain("not a git repository: pr skipped; run /doug-skills when one exists");
    expect(summary).toContain("no gate commands detected: preflight skipped; run /doug-skills when one exists");
    expect(summary).toContain("no test framework detected: characterization-test skipped; run /doug-skills when one exists");
  });
});
