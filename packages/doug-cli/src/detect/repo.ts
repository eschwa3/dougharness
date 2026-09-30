import { execFileSync } from "node:child_process";
import type { RepoDetection } from "./types.js";
import { exists, isDir, listDir, readText } from "./fs.js";

const MIGRATION_DIR_CANDIDATES = [
  "prisma/migrations", "drizzle", "drizzle/migrations", "migrations", "db/migrate", "db/migrations",
  "alembic/versions", "supabase/migrations", "src/migrations", "database/migrations",
];

const GENERATED_DIR_CANDIDATES = ["dist", "build", "out", ".next", ".nuxt", ".output", "coverage", "generated", "__generated__", ".turbo", ".svelte-kit"];

const AGENT_FILES = [
  "AGENTS.md", ".cursorrules", ".cursor/rules", ".github/copilot-instructions.md", ".windsurfrules", ".clinerules", ".devin/rules",
];

const INFRA_SKIP_DIRS = new Set(["node_modules", ".git"]);
const INFRA_WALK_MAX_LEVEL = 3;

// Walks the repo (skipping node_modules, .git, and the detected generated dirs, at every level) up to three
// directory levels deep looking for a *.tfvars or terraform.tfstate file, at the root or nested. glob.mjs's
// patterns are slash-free basename matches, so *.tfvars and terraform.tfstate already match at any depth: only
// presence (root or nested) matters, not where. listDir/isDir already fail open (return [] / false) on an
// unreadable directory, so the walk never throws.
function collectTfMarkers(dir: string, generatedDirs: string[]): { hasTfvars: boolean; hasTfstate: boolean } {
  const skip = new Set([...INFRA_SKIP_DIRS, ...generatedDirs]);
  let hasTfvars = false;
  let hasTfstate = false;
  function walk(rel: string, level: number): void {
    for (const name of listDir(dir, rel)) {
      const relPath = rel === "." ? name : `${rel}/${name}`;
      if (isDir(dir, relPath)) {
        if (skip.has(name)) continue;
        if (level + 1 <= INFRA_WALK_MAX_LEVEL) walk(relPath, level + 1);
        continue;
      }
      if (/\.tfvars$/.test(name)) hasTfvars = true;
      else if (name === "terraform.tfstate") hasTfstate = true;
    }
  }
  walk(".", 0);
  return { hasTfvars, hasTfstate };
}

function detectInfraPaths(dir: string, generatedDirs: string[]): string[] {
  const { hasTfvars, hasTfstate } = collectTfMarkers(dir, generatedDirs);
  const infraPaths: string[] = [];
  if (isDir(dir, "infra/prod")) infraPaths.push("infra/prod/**");
  if (hasTfvars) infraPaths.push("*.tfvars");
  if (hasTfstate) infraPaths.push("terraform.tfstate");
  return infraPaths;
}

function git(dir: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 }).trim();
  } catch {
    return null;
  }
}

export function detectRepo(dir: string, notes: string[]): RepoDetection {
  const isGit = git(dir, ["rev-parse", "--is-inside-work-tree"]) === "true";
  let defaultBranch: string | null = null;
  if (isGit) {
    const remoteHead = git(dir, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
    if (remoteHead) defaultBranch = remoteHead.replace(/^origin\//, "");
    else {
      const current = git(dir, ["rev-parse", "--abbrev-ref", "HEAD"]);
      if (current && current !== "HEAD") defaultBranch = current;
    }
  }

  const ci: string[] = [];
  if (isDir(dir, ".github/workflows")) ci.push(...listDir(dir, ".github/workflows").filter((f) => /\.ya?ml$/.test(f)).map((f) => `.github/workflows/${f}`));
  for (const f of [".gitlab-ci.yml", ".circleci/config.yml", "Jenkinsfile", "bitbucket-pipelines.yml", "azure-pipelines.yml"]) if (exists(dir, f)) ci.push(f);

  const gitHooks: RepoDetection["gitHooks"] = [];
  if (isDir(dir, ".husky")) gitHooks.push("husky");
  if (exists(dir, "lefthook.yml") || exists(dir, ".lefthook.yml")) gitHooks.push("lefthook");
  if (exists(dir, ".pre-commit-config.yaml")) gitHooks.push("pre-commit");
  if (["commitlint.config.js", "commitlint.config.cjs", "commitlint.config.mjs", "commitlint.config.ts", ".commitlintrc", ".commitlintrc.json", ".commitlintrc.js"].some((f) => exists(dir, f))) gitHooks.push("commitlint");

  const envFiles = listDir(dir).filter((f) => /^\.env(\..+)?$/.test(f) && !/\.example$|\.sample$|\.template$/.test(f));
  const gitignore = readText(dir, ".gitignore") || "";
  if (envFiles.length && !/^\s*\.env/m.test(gitignore)) notes.push("Env files exist but .gitignore does not mention .env.");

  const migrationDirs = MIGRATION_DIR_CANDIDATES.filter((d) => isDir(dir, d));
  const generatedDirs = GENERATED_DIR_CANDIDATES.filter((d) => isDir(dir, d) || new RegExp(`^/?${d.replace(".", "\\.")}/?$`, "m").test(gitignore));

  const infraPaths = detectInfraPaths(dir, generatedDirs);

  const existingAgentFiles = AGENT_FILES.filter((f) => exists(dir, f));
  const hasClaudeMd = exists(dir, "CLAUDE.md");
  const hasClaudeSettings = exists(dir, ".claude/settings.json");
  const readme = readText(dir, "README.md") || "";
  const readmeHasSetup = /^#+\s*(getting started|setup|installation|install|development|running)/im.test(readme);

  return { isGit, defaultBranch, ci, gitHooks, envFiles, migrationDirs, generatedDirs, infraPaths, existingAgentFiles, hasClaudeMd, hasClaudeSettings, readmeHasSetup };
}
