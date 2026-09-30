import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { Detection } from "../detect/types.js";
import type { FileChange } from "../diff.js";
import { generateConfig, type DougConfig } from "./config.js";
import { generateClaudeMd } from "./claude-md.js";
import { mergeSettings, gatesSourceDir } from "./settings.js";
import { generateAgents, isDougAgent, spliceProjectNotes } from "./agents.js";
import { generateSkills, isDougSkill } from "./skills.js";
import { newBoard, BOARD_RELPATH, FALLBACK_RELPATH } from "@dougharness/flow/lib/board.mjs";

export interface Proposal {
  detection: Detection;
  config: DougConfig;
  changes: FileChange[];
  notes: string[];
}

function readIfExists(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    throw err;
  }
}

function walk(root: string, sub: string, out: { rel: string; abs: string }[]) {
  for (const name of readdirSync(join(root, sub)).sort()) {
    const rel = join(sub, name);
    const abs = join(root, rel);
    if (statSync(abs).isDirectory()) walk(root, rel, out);
    else out.push({ rel: rel.split("\\").join("/"), abs });
  }
}

export function buildProposal(d: Detection): Proposal {
  const dir = d.dir;
  const notes = [...d.notes];
  const config = generateConfig(d);
  const changes: FileChange[] = [];

  // 1. .doug/config.json
  changes.push({
    path: ".doug/config.json",
    before: readIfExists(join(dir, ".doug/config.json")),
    after: JSON.stringify(config, null, 2) + "\n",
    reason: "Gate configuration read by the hooks. Everything in it was detected, not guessed.",
  });

  // 1b. .doug/board.json: only when no board exists yet at either record path.
  if (!existsSync(join(dir, BOARD_RELPATH)) && !existsSync(join(dir, FALLBACK_RELPATH))) {
    changes.push({
      path: ".doug/board.json",
      before: null,
      after: JSON.stringify(newBoard(), null, 2) + "\n",
      reason: "The development board: the queue of scoped cards for the project's work. It starts empty with the default columns (add cards with `doug board add`); /doug-next reads it to pick the next card.",
    });
  }

  // 2. Vendored hook scripts.
  const src = gatesSourceDir();
  const files: { rel: string; abs: string }[] = [];
  walk(src, "scripts", files);
  walk(src, "lib", files);
  for (const f of files) {
    const target = `.doug/hooks/${f.rel}`;
    changes.push({ path: target, before: readIfExists(join(dir, target)), after: readFileSync(f.abs, "utf8"), reason: "Vendored from @dougharness/gates. Zero dependencies; refreshed by re-running `doug init`." });
  }

  // 2b. .doug/hooks/VERSION: records the installed @dougharness/gates version the status line reads, so it
  // stays in sync with the vendored scripts above without a user hand-maintaining it.
  const gatesPkgVersion = JSON.parse(readFileSync(join(src, "package.json"), "utf8")).version as string;
  changes.push({
    path: ".doug/hooks/VERSION",
    before: readIfExists(join(dir, ".doug/hooks/VERSION")),
    after: `${gatesPkgVersion}\n`,
    reason: "Records the installed @dougharness/gates version so the status line prints it, instead of a version hand-maintained in config. Re-synced on every `doug init` re-run.",
  });

  // 3. .claude/settings.json (merge).
  const settingsPath = join(dir, ".claude/settings.json");
  const existingSettingsText = readIfExists(settingsPath);
  let existingSettings: Record<string, unknown> | null = null;
  if (existingSettingsText) {
    try {
      existingSettings = JSON.parse(existingSettingsText);
    } catch {
      notes.push(".claude/settings.json exists but is not valid JSON; it will be left untouched. Fix it and rerun.");
    }
  }
  if (!existingSettingsText || existingSettings) {
    const merged = mergeSettings(existingSettings, d, config, src);
    changes.push({ path: ".claude/settings.json", before: existingSettingsText, after: JSON.stringify(merged, null, 2) + "\n", reason: "Hooks wired to the vendored scripts, the status line pointed at the vendored script, plus an allowlist for the detected commands. Existing entries are kept." });
  }

  // 4. CLAUDE.md: create only if absent. Otherwise leave it and say so.
  if (!d.repo.hasClaudeMd) {
    changes.push({ path: "CLAUDE.md", before: null, after: generateClaudeMd(d, config), reason: "Short by design: commands, tooling facts, working agreement. Add gotchas by hand." });
  } else {
    notes.push("CLAUDE.md already exists and is left untouched. Consider trimming it to commands, tooling facts, and gotchas.");
  }
  if (d.repo.existingAgentFiles.length) {
    notes.push(`Existing agent config found (${d.repo.existingAgentFiles.join(", ")}). Not imported in this version; consider an @import from CLAUDE.md.`);
  }

  // 4b. .claude/agents/*.md: standard project subagents.
  for (const file of generateAgents(d, config)) {
    const target = join(dir, file.path);
    const existing = readIfExists(target);
    if (existing !== null && !isDougAgent(existing)) {
      notes.push(`${file.path} exists and was not written by doug init; left untouched. Add \`doug: generated\` to the frontmatter to let doug init refresh it.`);
    } else {
      const after = existing !== null ? spliceProjectNotes(file.content, existing) : file.content;
      changes.push({
        path: file.path,
        before: existing,
        after,
        reason: `Project subagent for the ${file.path.replace(/^.*\//, "").replace(/\.md$/, "")} role; carries only detected commands. Remove \`doug: generated\` from the frontmatter to stop doug init from refreshing it; the \`## Project notes\` section is yours and survives a refresh.`,
      });
    }
  }

  // 4c. .claude/skills/*: generated project skills, same refresh rule as 4b's agents.
  for (const file of generateSkills(d, config)) {
    const target = join(dir, file.path);
    const existing = readIfExists(target);
    const isSkillMd = file.path.endsWith("SKILL.md");
    if (existing !== null && !isDougSkill(existing)) {
      const addWhat = isSkillMd
        ? "Add `doug: generated` under `metadata:` in the frontmatter to let doug init refresh it."
        : "Add the `# doug: generated` comment line to let doug init refresh it.";
      notes.push(`${file.path} exists and was not written by doug init; left untouched. ${addWhat}`);
    } else {
      const after = isSkillMd && existing !== null ? spliceProjectNotes(file.content, existing) : file.content;
      const skillName = file.path.replace(/^\.claude\/skills\//, "").split("/")[0];
      changes.push({
        path: file.path,
        before: existing,
        after,
        reason: `Project skill for ${skillName}; carries only detected commands. Remove \`doug: generated\` from the frontmatter to stop doug init from refreshing it; the \`## Project notes\` section is yours and survives a refresh.`,
      });
    }
  }

  // 5. .gitignore: state dir.
  const gi = readIfExists(join(dir, ".gitignore"));
  if (!gi || !/^\.doug\/\.state\/?$/m.test(gi)) {
    changes.push({ path: ".gitignore", before: gi, after: (gi ? gi.replace(/\n?$/, "\n") : "") + ".doug/.state/\n", reason: "Per-session hook state is local." });
  }

  // Drop no-op changes.
  const effective = changes.filter((c) => c.before !== c.after);
  return { detection: d, config, changes: effective, notes };
}

const SKIPPED_SKILL_REASONS: [string, string][] = [
  ["run", "no dev, start, or serve script detected"],
  ["test", "no test command detected"],
  ["migrate", "no migration directory detected"],
  ["release", "no release, publish, or version script detected"],
  ["pr", "not a git repository"],
  ["preflight", "no gate commands detected"],
  ["characterization-test", "no test framework detected"],
];

export function summarize(p: Proposal): string {
  const d = p.detection;
  const n = d.node;
  const agentNames = generateAgents(d, p.config).map((f) => f.path.replace(/^.*\//, "").replace(/\.md$/, ""));
  const skillNames = Array.from(
    new Set(
      generateSkills(d, p.config)
        .filter((f) => f.path.endsWith("SKILL.md"))
        .map((f) => f.path.replace(/^\.claude\/skills\//, "").replace(/\/SKILL\.md$/, "")),
    ),
  );
  const rows: [string, string][] = [
    ["directory", relative(process.cwd(), d.dir) || "."],
    ["package manager", n.packageManager ? `${n.packageManager} (${n.packageManagerSource})` : "none detected"],
    ["test", n.commands.test?.command ?? "none"],
    ["lint", n.commands.lint?.command ?? "none"],
    ["typecheck", n.commands.typecheck?.command ?? "none"],
    ["formatter", n.formatter ? n.formatter.name : "none"],
    ["protected paths", p.config.protectedPaths.join(", ")],
    ["stop gate", p.config.stopGate.commands.length ? p.config.stopGate.commands.join(" → ") : "none (no commands detected)"],
    ["agents", agentNames.length ? agentNames.join(", ") : "none"],
    ["skills", skillNames.join(", ")],
  ];
  if (d.python.present) {
    const py = d.python;
    rows.push(
      ["python manager", py.manager ? `${py.manager} (${py.managerSource ?? "none detected"})` : "none detected"],
      ["python test", py.commands.test ?? "none"],
      ["python lint", py.commands.lint ?? "none"],
      ["python typecheck", py.commands.typecheck ?? "none"],
    );
  }
  const w = Math.max(...rows.map((r) => r[0].length));
  const lines = rows.map(([k, v]) => `  ${k.padEnd(w)}  ${v}`);
  const generated = new Set(skillNames);
  for (const [skill, reason] of SKIPPED_SKILL_REASONS) {
    if (!generated.has(skill)) {
      lines.push(`  ${reason}: ${skill} skipped; run /doug-skills when one exists`);
    }
  }
  return lines.join("\n");
}
