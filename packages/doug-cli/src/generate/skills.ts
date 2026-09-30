import type { Detection } from "../detect/types.js";
import type { DougConfig } from "./config.js";
import { runScript } from "../detect/node.js";
import { AGENT_MARK } from "./agents.js";

// Generates project skills under .claude/skills/ from what the detectors actually found: one SKILL.md per
// skill (plus preflight's bundled script), the same way generate/agents.ts proposes subagents. Pure function
// of its arguments: no filesystem, no clock, no randomness, so the same inputs give byte-identical output.

export interface SkillFile {
  path: string;
  content: string;
}

const PROJECT_NOTES_HEADING = "## Project notes";

interface SkillSpec {
  name: string;
  description: string;
  allowedTools: string;
  manualOnly: boolean;
  commands: { kind: "sh"; lines: string[] };
  steps: string[] | null;
  rules: string[];
}

function bashPair(command: string): string[] {
  return [`Bash(${command} *)`, `Bash(${command})`];
}

// The permission tokens must come from the command text before its placeholder: a literal
// `<path/to/file.test.ts>` in a Bash rule can never match. Returns the joined prefix of tokens
// before the first token containing `<`, the whole command when there is no such token, or null
// when the command begins with the placeholder token.
function permissionPrefix(command: string): string | null {
  const tokens = command.split(/\s+/);
  const idx = tokens.findIndex((t) => t.includes("<"));
  if (idx === 0) return null;
  if (idx === -1) return command;
  return tokens.slice(0, idx).join(" ");
}

function firstScript(scripts: Record<string, string>, names: string[]): string | null {
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(scripts, name)) return name;
  }
  return null;
}

function renderSkill(spec: SkillSpec): string {
  const lines: string[] = [];
  lines.push("---");
  lines.push(`name: ${spec.name}`);
  lines.push(`description: ${JSON.stringify(spec.description)}`);
  lines.push(`allowed-tools: ${spec.allowedTools}`);
  if (spec.manualOnly) lines.push("disable-model-invocation: true");
  lines.push("metadata:");
  lines.push(`  ${AGENT_MARK}`);
  lines.push("---");
  lines.push("");
  lines.push("## Commands");
  lines.push("");
  lines.push("```sh");
  for (const c of spec.commands.lines) lines.push(c);
  lines.push("```");
  lines.push("");
  if (spec.steps) {
    lines.push("## Steps");
    lines.push("");
    spec.steps.forEach((s, i) => lines.push(`${i + 1}. ${s}`));
    lines.push("");
  }
  lines.push("## Rules");
  lines.push("");
  for (const r of spec.rules) lines.push(`- ${r}`);
  lines.push("");
  lines.push(PROJECT_NOTES_HEADING);
  return lines.join("\n") + "\n";
}

export function generateSkills(d: Detection, cfg: DougConfig): SkillFile[] {
  const n = d.node;
  const pm = n.packageManager ?? "npm";
  const files: SkillFile[] = [];

  // 1. run
  const runScriptName = firstScript(n.scripts, ["dev", "start", "serve"]);
  if (runScriptName) {
    const command = runScript(pm, runScriptName);
    files.push({
      path: ".claude/skills/run/SKILL.md",
      content: renderSkill({
        name: "run",
        description: `Starts the project's dev server with its \`${runScriptName}\` script`,
        allowedTools: [...bashPair(command), "Read", "Grep", "Glob"].join(" "),
        manualOnly: false,
        commands: { kind: "sh", lines: [command] },
        steps: null,
        rules: [
          "Run the command and report what it prints.",
          "Stop the server before finishing when it does not exit on its own.",
        ],
      }),
    });
  }

  // 2. test
  if (cfg.commands.test) {
    const command = cfg.commands.test;
    files.push({
      path: ".claude/skills/test/SKILL.md",
      content: renderSkill({
        name: "test",
        description: "Runs the project's test suite",
        allowedTools: [...bashPair(command), "Edit", "Write", "Read", "Grep", "Glob"].join(" "),
        manualOnly: false,
        commands: { kind: "sh", lines: [command] },
        steps: null,
        rules: [
          "Run the full suite and report the real exit status.",
          "Add or update a test with the change; never delete one to make it pass.",
        ],
      }),
    });
  }

  // 3. migrate
  const migrationDirs = d.python.present
    ? [...new Set([...d.repo.migrationDirs, ...d.python.migrationDirs])].sort()
    : d.repo.migrationDirs;
  if (migrationDirs.length) {
    const migrateScriptName = firstScript(n.scripts, ["migrate", "db:migrate", "migrate:dev", "prisma:migrate"]);
    const command = migrateScriptName ? runScript(pm, migrateScriptName) : null;
    const dirs = migrationDirs.join(", ");
    files.push({
      path: ".claude/skills/migrate/SKILL.md",
      content: renderSkill({
        name: "migrate",
        description: "Runs the project's database migrations",
        allowedTools: (command ? [...bashPair(command), "Read", "Grep", "Glob"] : ["Read", "Grep", "Glob"]).join(" "),
        manualOnly: true,
        commands: command
          ? { kind: "sh", lines: [command] }
          : {
              kind: "sh",
              lines: ["# No migration script was detected; use the project's own migration tool."],
            },
        steps: command
          ? [`List migration directories: ${dirs}.`, `Run \`${command}\`.`, "Verify the migration applied cleanly."]
          : [
              `List migration directories: ${dirs}.`,
              "Use the project's own migration tool to apply pending migrations.",
              "Verify the migration applied cleanly.",
            ],
        rules: ["Never hand-edit a migration file already applied.", "Report what ran and its result."],
      }),
    });
  }

  // 4. release
  const releaseScriptName = firstScript(n.scripts, ["release", "publish", "version"]);
  if (releaseScriptName) {
    const command = runScript(pm, releaseScriptName);
    files.push({
      path: ".claude/skills/release/SKILL.md",
      content: renderSkill({
        name: "release",
        description: `Runs the project's release with its \`${releaseScriptName}\` script`,
        allowedTools: [...bashPair(command), "Read", "Grep", "Glob"].join(" "),
        manualOnly: true,
        commands: { kind: "sh", lines: [command] },
        steps: ["Confirm the working tree is clean.", `Run \`${command}\`.`, "Verify the release published."],
        rules: ["Never release from a dirty working tree.", "Report what ran and its result."],
      }),
    });
  }

  // 5. pr
  if (d.repo.isGit) {
    const base = d.repo.defaultBranch;
    const pushCmd = "git push -u origin HEAD";
    const prCmd = base ? `gh pr create --base ${base} --fill` : "gh pr create --fill";
    files.push({
      path: ".claude/skills/pr/SKILL.md",
      content: renderSkill({
        name: "pr",
        description: "Opens a pull request for the current branch",
        allowedTools: [
          ...["git status", "git diff", "git log", "git add", "git commit", "git push", "gh pr create"].flatMap(
            bashPair
          ),
          "Read",
          "Grep",
          "Glob",
        ].join(" "),
        manualOnly: true,
        commands: {
          kind: "sh",
          lines: ["git status", "git diff", "git log", "git add <files>", 'git commit -m "<message>"', pushCmd, prCmd],
        },
        steps: [
          "Check status with `git status`.",
          "Review the diff with `git diff` and the history with `git log`.",
          "Stage and commit with `git add` and `git commit`.",
          `Push with \`${pushCmd}\`.`,
          `Open the PR with \`${prCmd}\`${base ? ` against \`${base}\`` : ""}.`,
        ],
        rules: ["Never force-push.", "Report the PR URL when it opens."],
      }),
    });
  }

  // 6. preflight
  if (cfg.stopGate.commands.length) {
    const gateCommands = cfg.stopGate.commands.map((name) => cfg.commands[name]);
    const scriptInvocation = 'bash "${CLAUDE_SKILL_DIR}/scripts/preflight.sh"';
    files.push({
      path: ".claude/skills/preflight/SKILL.md",
      content: renderSkill({
        name: "preflight",
        description: "Runs the project's gate commands in order before finishing",
        allowedTools: [...gateCommands.flatMap(bashPair), "Bash(bash *)", "Read", "Grep", "Glob"].join(" "),
        manualOnly: true,
        commands: { kind: "sh", lines: [scriptInvocation] },
        steps: gateCommands.map((c) => `Run \`${c}\`.`),
        rules: ["Run every gate command; do not skip one to save time.", "Report each command's real exit status."],
      }),
    });
    const scriptLines = ["#!/usr/bin/env bash", `# ${AGENT_MARK}`, "set -euo pipefail"];
    for (const c of gateCommands) {
      scriptLines.push(`echo "Running: ${c}"`);
      scriptLines.push(c);
    }
    files.push({ path: ".claude/skills/preflight/scripts/preflight.sh", content: scriptLines.join("\n") + "\n" });
  }

  // 7. characterization-test
  if (n.testFramework || d.python.testFramework) {
    const pythonOnly = !n.testFramework;
    const named = pythonOnly
      ? [d.python.singleTestCommand, d.python.present ? (cfg.commands["py:test"] ?? cfg.commands.test) : null].filter(
          (c): c is string => !!c
        )
      : [n.singleTestCommand, cfg.commands.test].filter((c): c is string => !!c);
    const frameworkName = pythonOnly ? "pytest" : n.testFramework;
    const permissionPrefixes = [...new Set(named.map(permissionPrefix).filter((p): p is string => p !== null))];
    files.push({
      path: ".claude/skills/characterization-test/SKILL.md",
      content: renderSkill({
        name: "characterization-test",
        description: `Writes a characterization test with ${frameworkName} that pins current behavior`,
        allowedTools: [...permissionPrefixes.flatMap(bashPair), "Edit", "Write", "Read", "Grep", "Glob"].join(" "),
        manualOnly: false,
        commands: { kind: "sh", lines: named },
        steps: null,
        rules: [
          "Run the single-test command after writing the test.",
          "Never delete or weaken the test to make it pass.",
        ],
      }),
    });
  }

  // 8. doug-skills (always generated, manual-only, the refresh path)
  files.push({
    path: ".claude/skills/doug-skills/SKILL.md",
    content: renderSkill({
      name: "doug-skills",
      description: "Refreshes this project's generated skills and agents by re-running doug init",
      allowedTools: "Bash(doug init*)",
      manualOnly: true,
      commands: { kind: "sh", lines: ["doug init --dry-run", "doug init --yes"] },
      steps: [
        "Run `doug init --dry-run` in the project directory to print the proposal.",
        "Show the proposal to the user.",
        "Run `doug init --yes` only after the user says yes.",
      ],
      rules: [
        "This is how the skills above appear once the project has code the detectors can see.",
        "Never invent another doug init flag.",
      ],
    }),
  });

  return files;
}

export function isDougSkill(text: string): boolean {
  const withoutBom = text.startsWith("﻿") ? text.slice(1) : text;
  const lines = withoutBom.split("\n").map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
  if (lines[0] === "---") {
    const closingIdx = lines.indexOf("---", 1);
    if (closingIdx > 0) {
      return lines.slice(0, closingIdx).some((l) => l.trim() === AGENT_MARK);
    }
  }
  return lines.slice(0, 5).some((l) => l.trim() === `# ${AGENT_MARK}`);
}
