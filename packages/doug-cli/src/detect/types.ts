export type PackageManager = "pnpm" | "npm" | "yarn" | "bun";

export interface ScriptCommand {
  /** Name of the package.json script, e.g. "test". */
  script: string;
  /** Full shell command to run it, e.g. "pnpm test". */
  command: string;
  /** What the script runs, verbatim from package.json. */
  body: string;
}

export interface NodeDetection {
  present: boolean;
  packageManager: PackageManager | null;
  packageManagerSource: "packageManager-field" | "lockfile" | "default" | null;
  nodeVersion: string | null;
  nodeVersionSource: string | null;
  scripts: Record<string, string>;
  commands: {
    install: string | null;
    test: ScriptCommand | null;
    "test:unit": ScriptCommand | null;
    lint: ScriptCommand | null;
    typecheck: ScriptCommand | null;
    build: ScriptCommand | null;
    format: ScriptCommand | null;
  };
  testFramework: "vitest" | "jest" | "mocha" | "node:test" | null;
  singleTestCommand: string | null;
  formatter: { name: "prettier" | "biome"; command: string[]; extensions: string[] } | null;
  linter: "eslint" | "biome" | null;
  typescript: boolean;
  tsStrict: boolean | null;
  monorepo: { tool: "pnpm-workspace" | "npm-workspaces" | "turbo" | "nx" | "lerna"; packages: string[] }[] ;
  lockfile: string | null;
}

export type PythonManager = "uv" | "poetry" | "pdm" | "pipenv" | "hatch" | "pip";

export interface PythonDetection {
  present: boolean;
  manager: PythonManager | null;
  managerSource: string | null;
  lockfile: string | null;
  runPrefix: string | null;
  pythonVersion: string | null;
  pythonVersionSource: string | null;
  venvDir: string | null;
  venvBinDir: string | null;
  commands: {
    install: string | null;
    test: string | null;
    lint: string | null;
    format: string | null;
    formatCheck: string | null;
    typecheck: string | null;
  };
  testFramework: "pytest" | null;
  testConfigFile: string | null;
  testDirs: string[];
  singleTestCommand: string | null;
  singleTestNodeIdCommand: string | null;
  linter: "ruff" | null;
  formatter: { name: "ruff" | "black"; command: string } | null;
  typeChecker: "mypy" | null;
  typeCheckerConfigFile: string | null;
  srcLayout: boolean;
  migrationDirs: string[];
  generatedDirs: string[];
}

export interface RepoDetection {
  isGit: boolean;
  defaultBranch: string | null;
  ci: string[];
  gitHooks: ("husky" | "lefthook" | "pre-commit" | "commitlint")[];
  envFiles: string[];
  migrationDirs: string[];
  generatedDirs: string[];
  // Protected-path patterns for infra state doug init should propose: infra/prod/**, *.tfvars / **/*.tfvars,
  // terraform.tfstate / **/terraform.tfstate, each only when found (card bash-rules-prod).
  infraPaths: string[];
  existingAgentFiles: string[];
  hasClaudeMd: boolean;
  hasClaudeSettings: boolean;
  readmeHasSetup: boolean;
}

export interface Detection {
  dir: string;
  node: NodeDetection;
  python: PythonDetection;
  repo: RepoDetection;
  /** Human-readable notes about why a decision was made. Shown in the proposal. */
  notes: string[];
}
