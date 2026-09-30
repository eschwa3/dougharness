import type { Detection } from "../detect/types.js";
import type { DougConfig } from "./config.js";

// Generates a short CLAUDE.md: verbatim commands, tooling facts, and nothing derivable from the code.
// Research basis: agents reliably act on tooling instructions; overviews and style guides do not help
// and cost tokens (docs/reviews/07-tailored-install-research.md).

export function generateClaudeMd(d: Detection, cfg: DougConfig): string {
  const n = d.node;
  const p = d.python;
  const lines: string[] = [];
  lines.push("# Project instructions");
  lines.push("");
  lines.push("Guardrails are enforced by hooks configured in `.doug/config.json`; this file carries only what hooks cannot.");
  lines.push("");

  const cmds = Object.entries(cfg.commands);
  if (cmds.length) {
    lines.push("## Commands");
    lines.push("");
    lines.push("```sh");
    for (const [name, cmd] of cmds) lines.push(`${cmd.padEnd(40)} # ${name}`);
    if (n.singleTestCommand) lines.push(`${n.singleTestCommand.padEnd(40)} # single test file`);
    if (p.present && p.singleTestCommand) lines.push(`${p.singleTestCommand.padEnd(40)} # single Python test file`);
    lines.push("```");
    lines.push("");
    lines.push("Prefer running a single test file while iterating. Run the full gate before finishing.");
    lines.push("");
  }

  const facts: string[] = [];
  if (n.packageManager) facts.push(`Package manager is **${n.packageManager}** (${n.packageManagerSource === "packageManager-field" ? "package.json packageManager field" : n.lockfile}). Do not use another one.`);
  if (n.nodeVersion) facts.push(`Node ${n.nodeVersion} from ${n.nodeVersionSource}.`);
  if (n.formatter) facts.push(`${n.formatter.name} formats files automatically after every edit. Do not hand-format.`);
  if (n.linter) facts.push(`Lint with ${n.linter}; the stop gate runs it.`);
  if (n.typescript && n.tsStrict === false) facts.push("TypeScript strict mode is off; do not enable it in passing.");
  if (n.monorepo.length) facts.push(`Monorepo (${n.monorepo.map((m) => m.tool).join(", ")}). Run scripts from the package you are changing.`);
  if (d.repo.migrationDirs.length) facts.push(`Migrations live in ${d.repo.migrationDirs.join(", ")} and are protected. Generate them with the project's migration tool.`);
  if (d.repo.gitHooks.length) facts.push(`Git hooks (${d.repo.gitHooks.join(", ")}) run on commit. Never bypass them with --no-verify.`);
  if (d.repo.ci.length) facts.push(`CI: ${d.repo.ci.join(", ")}. The stop gate mirrors its checks locally.`);
  if (p.present) {
    if (p.manager && p.managerSource) facts.push(`Python package manager is **${p.manager}** (${p.managerSource}). Do not use another Python package manager.`);
    if (p.pythonVersion && p.pythonVersionSource) facts.push(`Python ${p.pythonVersion} from ${p.pythonVersionSource}.`);
    if (p.runPrefix) facts.push(`Run Python tools through \`${p.runPrefix}\`.`);
    else if (p.venvDir && p.venvBinDir) facts.push(`The project's virtualenv is \`${p.venvDir}\`; its executables are in \`${p.venvBinDir}\`.`);
    if (p.linter === "ruff") facts.push("ruff replaces black, isort and flake8 here; do not add them.");
    else if (p.formatter?.name === "black") facts.push("Formatting is checked with black.");
    if (p.typeChecker === "mypy" && p.typeCheckerConfigFile) facts.push(`Type-checked with mypy (${p.typeCheckerConfigFile}).`);
    if (p.migrationDirs.length) facts.push(`Python migrations live in ${p.migrationDirs.join(", ")} and are protected. Generate them with the project's migration tool.`);
  }
  if (facts.length) {
    lines.push("## Tooling facts");
    lines.push("");
    for (const f of facts) lines.push(`- ${f}`);
    lines.push("");
  }

  lines.push("## Working agreement");
  lines.push("");
  lines.push("- Do what was asked. Do not refactor, rename, or add files beyond the request.");
  lines.push("- Do not claim work is done until the gate passed in this session. Say what you ran.");
  lines.push("- If a hook blocks an action, do not work around it. Report it.");
  lines.push("- While `.doug/plan.json` is approved, change only files its tasks own. The stop gate blocks anything else; widen the plan and have it re-approved instead.");
  lines.push("");
  lines.push("## Gotchas");
  lines.push("");
  lines.push("<!-- Add project-specific pitfalls here, one line each. Keep this file under 60 lines. -->");
  lines.push("");
  lines.push(...MODELS_SECTION);
  return lines.join("\n");
}

/**
 * The Models table: which model and effort does which work when doug-flow runs a plan.
 * Parsed deterministically by doug-flow's plan CLI (lib/models.mjs) and resolved into the plan
 * before the workflow runs. "inherit" keeps the session model or the role's default effort.
 */
export const MODELS_SECTION: string[] = [
  "## Models",
  "",
  "Which model does which work when a Doug plan runs. `inherit` = the session model or the role's default effort.",
  "Rows that are not roles are named tiers a task can pick with `\"tier\": \"<name>\"` in the plan.",
  "",
  "| Work      | Model   | Effort  |",
  "|-----------|---------|---------|",
  "| plan      | opus    | high    |",
  "| lead      | inherit | high    |",
  "| worker    | sonnet  | medium  |",
  "| implement | inherit | inherit |",
  "| verify    | inherit | high    |",
  "| review    | inherit | high    |",
  "| adversary | inherit | low     |",
  "| integrate | inherit | high    |",
  "",
  "The `plan` row is the planner's and the research step's researchers'. The `lead` and `worker` rows are the swarm's (a plan with `swarm` on: the lead splits a task into worker briefs and merges them). `implement`, `verify`, `review`, and `integrate` are the workflow's stages of that name. The `adversary` row runs the adversarial reviewer through `codex-review` (Codex, which must be on PATH), relayed unchanged by a Claude agent; when Codex cannot run, the workflow falls back to `adversary-claude` on the plan's `adversary.fallback` (default Opus, high). The session model is the lead only and never does implement, verify, or review work itself.",
  "",
];
