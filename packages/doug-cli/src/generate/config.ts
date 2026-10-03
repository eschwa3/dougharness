import { homedir } from "node:os";
import { join } from "node:path";
import { projectSlug } from "@dougharness/flow/lib/cost.mjs";
import type { Detection } from "../detect/types.js";

export interface DougConfig {
  version: 1;
  doug: { name: string };
  packageManager: string | null;
  commands: Record<string, string>;
  formatter: { command: string[]; extensions: string[] } | null;
  protectedPaths: string[];
  allowedOutsidePaths: string[];
  bash: { denyNoVerify: boolean; denyForcePushTo: string[]; denyDestructive: boolean; packageManagerGuard: boolean };
  secrets: { enabled: boolean; ignorePaths: string[] };
  editLoop: { threshold: number; windowMinutes: number };
  stopGate: { commands: string[]; onlyIfEdited: boolean; timeoutMs: number; hookTimeoutSec: number; maxBlocks: number; ignoreChangedPaths: string[]; planScope: boolean };
  checkpoint: { enabled: boolean; mode: "commit" | "tag" };
  budget: { maxTurns: number | null };
  anchor: string[];
  // Card no-nested-agents-gate: Claude Code's per-project subagent nesting depth
  // (https://code.claude.com/docs/en/sub-agents.md). 1 = subagents cannot spawn subagents (the rule: only
  // the session lead orchestrates agents); null = leave the setting alone. No hook reads this key.
  // Card init-workflow-settings: promptCacheTtl maps to the top-level subagentPromptCacheTtl setting
  // ("5m" | "1h"); null = leave alone.
  // maxConcurrentWorkflowAgents maps to env CLAUDE_CODE_WORKFLOW_MAX_CONCURRENT_AGENTS (1-256); null = leave alone.
  subagents: {
    maxSpawnDepth: number | null;
    promptCacheTtl?: string | null;
    maxConcurrentWorkflowAgents?: number | null;
  };
}

export function generateConfig(d: Detection): DougConfig {
  const n = d.node;
  const p = d.python;
  const commands: Record<string, string> = {};
  if (n.commands.install) commands.install = n.commands.install;
  for (const key of ["test", "test:unit", "lint", "typecheck", "build", "format"] as const) {
    const c = n.commands[key];
    if (c) commands[key] = c.command;
  }
  // Snapshot of the Node-only command keys, taken before the Python merge below. The stop gate's Node
  // ordering (computed further down) reads this snapshot, not `commands`, so a Python command landing on a
  // plain key never perturbs the Node gate logic.
  const nodeCommands = { ...commands };

  // Project policy (python-config): a Python command takes the plain key when Node has none of that name;
  // when both stacks have one, Node keeps the plain key and Python's arrives under a "py:" prefix. The plain
  // "format" key always means the checking form (the stop gate runs it to fail on unformatted files, not to
  // rewrite them), so it reads from d.python.commands.formatCheck, not .format.
  if (p.present) {
    const pyByKey: [string, string | null][] = [
      ["install", p.commands.install],
      ["test", p.commands.test],
      ["lint", p.commands.lint],
      ["typecheck", p.commands.typecheck],
      ["format", p.commands.formatCheck],
    ];
    for (const [key, value] of pyByKey) {
      if (!value) continue;
      if (commands[key]) commands[`py:${key}`] = value;
      else commands[key] = value;
    }
  }

  const protectedPaths = new Set<string>([".env", ".env.*", ".git/**", "node_modules/**", ".doug/config.json"]);
  if (n.lockfile) protectedPaths.add(n.lockfile);
  for (const m of d.repo.migrationDirs) protectedPaths.add(`${m}/**`);
  for (const g of d.repo.generatedDirs) protectedPaths.add(`${g}/**`);
  for (const path of d.repo.infraPaths) protectedPaths.add(path);
  if (p.present) {
    if (p.lockfile) protectedPaths.add(p.lockfile);
    for (const m of p.migrationDirs) protectedPaths.add(`${m}/**`);
    for (const g of p.generatedDirs) protectedPaths.add(`${g}/**`);
  }

  // The project's own Claude Code auto-memory directory is outside the project by construction (it lives under
  // ~/.claude), so an honest Edit/Write there is refused by protect-paths.mjs unless it is allowlisted
  // (docs/decisions/0006).
  const autoMemoryDir = join(homedir(), ".claude", "projects", projectSlug(d.dir), "memory");

  // Stop gate: cheapest reliable checks first. Build is excluded unless it is the only type check. The Node
  // ordering below is computed from `nodeCommands` (the pre-Python snapshot), never from the merged
  // `commands`, so a Python command that took over a plain key (no Node command of that name) cannot change
  // which Node checks the gate runs or their order.
  const gate: string[] = [];
  if (nodeCommands.typecheck) gate.push("typecheck");
  if (nodeCommands.lint) gate.push("lint");
  if (nodeCommands["test:unit"]) gate.push("test:unit");
  else if (nodeCommands.test) gate.push("test");
  if (!nodeCommands.typecheck && n.typescript && nodeCommands.build && /\btsc\b/.test(n.commands.build?.body || "")) gate.unshift("build");
  // Python keys appended after the Node ordering above, in typecheck/lint/test order: the plain key when
  // Python owns it outright (no Node command of that name), otherwise the "py:"-prefixed key.
  if (p.present) {
    const pyGateSources: [string, string | null][] = [
      ["typecheck", p.commands.typecheck],
      ["lint", p.commands.lint],
      ["test", p.commands.test],
    ];
    for (const [name, value] of pyGateSources) {
      if (!value) continue;
      gate.push(nodeCommands[name] ? `py:${name}` : name);
    }
  }

  const branches = new Set<string>(["main", "master"]);
  if (d.repo.defaultBranch) branches.add(d.repo.defaultBranch);

  const anchor: string[] = [];
  if (n.packageManager) anchor.push(`Use ${n.packageManager} for installs and scripts. Never mix package managers.`);
  if (n.singleTestCommand) anchor.push(`Run a single test file with: ${n.singleTestCommand}`);
  if (n.nodeVersion) anchor.push(`Node ${n.nodeVersion} (${n.nodeVersionSource}).`);
  // Combined rather than a separate near-duplicate sentence when both stacks have migration dirs.
  const allMigrationDirs = [...new Set([...d.repo.migrationDirs, ...(p.present ? p.migrationDirs : [])])];
  if (allMigrationDirs.length) anchor.push(`Never hand-edit ${allMigrationDirs.join(", ")}; generate migrations with the project's tool.`);
  if (p.present) {
    if (p.manager && p.managerSource) anchor.push(`Use ${p.manager} for Python installs and runs. Never mix Python package managers.`);
    if (p.singleTestCommand) anchor.push(`Run a single Python test file with: ${p.singleTestCommand}`);
    if (p.pythonVersion && p.pythonVersionSource) anchor.push(`Python ${p.pythonVersion} (${p.pythonVersionSource}).`);
  }

  return {
    version: 1,
    doug: { name: "Doug" },
    packageManager: n.packageManager,
    commands,
    formatter: n.formatter ? { command: n.formatter.command, extensions: n.formatter.extensions } : null,
    protectedPaths: [...protectedPaths],
    allowedOutsidePaths: [autoMemoryDir],
    bash: { denyNoVerify: true, denyForcePushTo: [...branches], denyDestructive: true, packageManagerGuard: !!n.packageManager },
    secrets: { enabled: true, ignorePaths: [] },
    editLoop: { threshold: 6, windowMinutes: 30 },
    stopGate: {
      commands: gate,
      onlyIfEdited: true,
      timeoutMs: 300000,
      // Must equal the stop-gate hook's own `timeout` (plugins/doug-gates/hooks/hooks.json, seconds) on both
      // Stop and SubagentStop, which `doug init` also copies into the generated settings.json (card
      // stop-gate-budget-under-hook-timeout). Nothing else keeps the two in step.
      hookTimeoutSec: 600,
      maxBlocks: 3,
      ignoreChangedPaths: [
        ...(n.lockfile ? [n.lockfile] : []),
        ...(p.present && p.lockfile ? [p.lockfile] : []),
        ".doug/config.json",
      ],
      planScope: true,
    },
    checkpoint: { enabled: false, mode: "commit" },
    budget: { maxTurns: null },
    anchor,
    subagents: { maxSpawnDepth: 1, promptCacheTtl: "1h", maxConcurrentWorkflowAgents: 4 },
  };
}
