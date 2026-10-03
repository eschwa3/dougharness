#!/usr/bin/env node
// Zero-dependency release check and stage script (node builtins only). Never runs npm, pnpm, git
// or the network, and never publishes. It prints the manual publish steps that follow.
import {
  readFileSync,
  existsSync,
  mkdirSync,
  rmSync,
  cpSync,
  writeFileSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const VERSIONED_MANIFESTS = [
  "package.json",
  "packages/doug-cli/package.json",
  "packages/doug-codex/package.json",
  "plugins/doug-flow/package.json",
  "plugins/doug-gates/package.json",
  "plugins/doug-flow/.claude-plugin/plugin.json",
  "plugins/doug-gates/.claude-plugin/plugin.json",
];

const PRIVATE_PLUGIN_MANIFESTS = [
  "plugins/doug-flow/package.json",
  "plugins/doug-gates/package.json",
];

const PUBLISHED_PACKAGE_MANIFESTS = [
  ["packages/doug-cli/package.json", "packages/doug-cli"],
  ["packages/doug-codex/package.json", "packages/doug-codex"],
];

// Workspace package name -> its repo-relative package.json, restricted to the packages rule 3
// requires to be private (so a cli workspace: dependency on anything else is a problem, not a
// silent bundle).
const WORKSPACE_PACKAGE_BY_NAME = {
  "@dougharness/flow": "plugins/doug-flow/package.json",
  "@dougharness/gates": "plugins/doug-gates/package.json",
};

function readManifest(root, relPath, problems) {
  const abs = join(root, relPath);
  let text;
  try {
    text = readFileSync(abs, "utf8");
  } catch (err) {
    problems.push(`${relPath}: cannot read file (${err.code || err.message})`);
    return null;
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch (err) {
    problems.push(`${relPath}: invalid JSON (${err.message})`);
    return null;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    problems.push(`${relPath}: field "<root>" must parse to a plain object`);
    return null;
  }
  return value;
}

/**
 * Returns an array of problem strings (never throws). Each names the offending file
 * (repo-relative) and, where applicable, the field.
 */
export function checkRelease(root) {
  const problems = [];

  const manifestsByPath = {};
  for (const relPath of VERSIONED_MANIFESTS) {
    manifestsByPath[relPath] = readManifest(root, relPath, problems);
  }

  const rootPkg = manifestsByPath["package.json"];
  const version = rootPkg && typeof rootPkg.version === "string" ? rootPkg.version : null;

  // Rule 1: version match.
  if (version !== null) {
    for (const relPath of VERSIONED_MANIFESTS) {
      if (relPath === "package.json") continue;
      const manifest = manifestsByPath[relPath];
      if (!manifest) continue;
      if (manifest.version !== version) {
        problems.push(
          `${relPath}: field "version" is ${JSON.stringify(manifest.version)}, expected ${JSON.stringify(version)}`,
        );
      }
    }
  } else if (rootPkg) {
    problems.push(`package.json: field "version" is missing or not a string`);
  }

  // Rule 2: marketplace.json carries no version anywhere, and lists exactly doug-gates/doug-flow.
  const marketplace = readManifest(root, ".claude-plugin/marketplace.json", problems);
  if (marketplace) {
    if (marketplace.version !== undefined) {
      problems.push(`.claude-plugin/marketplace.json: field "version" must not be set`);
    }
    if (
      marketplace.metadata &&
      typeof marketplace.metadata === "object" &&
      marketplace.metadata.version !== undefined
    ) {
      problems.push(`.claude-plugin/marketplace.json: field "metadata.version" must not be set`);
    }
    const plugins = Array.isArray(marketplace.plugins) ? marketplace.plugins : [];
    for (const entry of plugins) {
      if (entry && typeof entry === "object" && entry.version !== undefined) {
        problems.push(
          `.claude-plugin/marketplace.json: entry ${JSON.stringify(entry.name)} must not set field "version"`,
        );
      }
    }
    const names = plugins
      .filter((entry) => entry && typeof entry === "object")
      .map((entry) => entry.name)
      .sort();
    const expectedNames = ["doug-flow", "doug-gates"];
    if (JSON.stringify(names) !== JSON.stringify(expectedNames)) {
      problems.push(
        `.claude-plugin/marketplace.json: field "plugins" must list exactly doug-gates and doug-flow, got ${JSON.stringify(names)}`,
      );
    }
  }

  // Rule 3: the two plugin packages are private.
  for (const relPath of PRIVATE_PLUGIN_MANIFESTS) {
    const manifest = manifestsByPath[relPath];
    if (!manifest) continue;
    if (manifest.private !== true) {
      problems.push(`${relPath}: field "private" must be true`);
    }
  }

  // Rule 4: the two published packages carry the fields npm publish needs.
  for (const [relPath, dir] of PUBLISHED_PACKAGE_MANIFESTS) {
    const manifest = manifestsByPath[relPath];
    if (!manifest) continue;
    if (manifest.private === true) {
      problems.push(`${relPath}: field "private" must not be true`);
    }
    const access = manifest.publishConfig && manifest.publishConfig.access;
    if (access !== "public") {
      problems.push(`${relPath}: field "publishConfig.access" must be "public"`);
    }
    if (manifest.license !== "MIT") {
      problems.push(`${relPath}: field "license" must be "MIT"`);
    }
    const repoDir = manifest.repository && manifest.repository.directory;
    if (repoDir !== dir) {
      problems.push(`${relPath}: field "repository.directory" must equal ${JSON.stringify(dir)}`);
    }
  }

  // Rule 5: LICENSE files are byte-identical to the root LICENSE.
  let rootLicense = null;
  try {
    rootLicense = readFileSync(join(root, "LICENSE"));
  } catch (err) {
    problems.push(`LICENSE: cannot read file (${err.code || err.message})`);
  }
  if (rootLicense) {
    for (const relPath of ["plugins/doug-flow/LICENSE", "plugins/doug-gates/LICENSE"]) {
      try {
        const content = readFileSync(join(root, relPath));
        if (!content.equals(rootLicense)) {
          problems.push(`${relPath}: not byte-identical to root LICENSE`);
        }
      } catch (err) {
        problems.push(`${relPath}: cannot read file (${err.code || err.message})`);
      }
    }
  }

  // Rule 6: cli workspace: dependencies name a workspace package rule 3 requires private;
  // codex has no workspace: dependency at all.
  const cliManifest = manifestsByPath["packages/doug-cli/package.json"];
  if (cliManifest && cliManifest.dependencies && typeof cliManifest.dependencies === "object") {
    for (const [depName, depValue] of Object.entries(cliManifest.dependencies)) {
      if (typeof depValue === "string" && depValue.startsWith("workspace:")) {
        const workspacePath = WORKSPACE_PACKAGE_BY_NAME[depName];
        const workspaceManifest = workspacePath ? manifestsByPath[workspacePath] : null;
        if (
          !workspacePath ||
          !PRIVATE_PLUGIN_MANIFESTS.includes(workspacePath) ||
          !workspaceManifest ||
          workspaceManifest.name !== depName
        ) {
          problems.push(
            `packages/doug-cli/package.json: workspace dependency "${depName}" does not name a workspace package rule 3 requires private`,
          );
        }
      }
    }
  }
  const codexManifest = manifestsByPath["packages/doug-codex/package.json"];
  if (codexManifest && codexManifest.dependencies && typeof codexManifest.dependencies === "object") {
    for (const [depName, depValue] of Object.entries(codexManifest.dependencies)) {
      if (typeof depValue === "string" && depValue.startsWith("workspace:")) {
        problems.push(
          `packages/doug-codex/package.json: field "dependencies.${depName}" must not be a workspace: dependency`,
        );
      }
    }
  }

  return problems;
}

/**
 * Stages the cli and codex npm packages under outDir (default <root>/.doug/.state/release).
 * Returns { ok: true, staged: { cli, codex } } or { ok: false, problems } or
 * { ok: false, reason }. Writes nothing on any failure.
 */
export function stageRelease(root, outDir) {
  const out = outDir || join(root, ".doug/.state/release");

  const problems = checkRelease(root);
  if (problems.length > 0) {
    return { ok: false, problems };
  }

  const cliDistBin = join(root, "packages/doug-cli/dist/bin.js");
  const codexDistBin = join(root, "packages/doug-codex/dist/bin.js");
  if (!existsSync(cliDistBin) || !existsSync(codexDistBin)) {
    return { ok: false, reason: "run pnpm build first" };
  }

  const rootPkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const version = rootPkg.version;

  const cliOut = join(out, "cli");
  const codexOut = join(out, "codex");
  rmSync(cliOut, { recursive: true, force: true });
  rmSync(codexOut, { recursive: true, force: true });
  mkdirSync(cliOut, { recursive: true });
  mkdirSync(codexOut, { recursive: true });

  // codex: no workspace dependencies, so no bundling.
  const codexPkg = JSON.parse(readFileSync(join(root, "packages/doug-codex/package.json"), "utf8"));
  delete codexPkg.scripts;
  delete codexPkg.devDependencies;
  writeFileSync(join(codexOut, "package.json"), JSON.stringify(codexPkg, null, 2) + "\n");
  cpSync(join(root, "packages/doug-codex/dist"), join(codexOut, "dist"), {
    recursive: true,
    dereference: true,
  });
  cpSync(join(root, "LICENSE"), join(codexOut, "LICENSE"), { dereference: true });

  // cli: pin workspace: dependencies to the release version and bundle them.
  const cliPkg = JSON.parse(readFileSync(join(root, "packages/doug-cli/package.json"), "utf8"));
  delete cliPkg.scripts;
  delete cliPkg.devDependencies;
  const bundleNames = [];
  if (cliPkg.dependencies && typeof cliPkg.dependencies === "object") {
    for (const [depName, depValue] of Object.entries(cliPkg.dependencies)) {
      if (typeof depValue === "string" && depValue.startsWith("workspace:")) {
        cliPkg.dependencies[depName] = version;
        bundleNames.push(depName);
      }
    }
  }
  bundleNames.sort();
  cliPkg.bundleDependencies = bundleNames;
  writeFileSync(join(cliOut, "package.json"), JSON.stringify(cliPkg, null, 2) + "\n");
  cpSync(join(root, "packages/doug-cli/dist"), join(cliOut, "dist"), {
    recursive: true,
    dereference: true,
  });
  cpSync(join(root, "packages/doug-cli/templates"), join(cliOut, "templates"), {
    recursive: true,
    dereference: true,
  });
  cpSync(join(root, "LICENSE"), join(cliOut, "LICENSE"), { dereference: true });

  const nodeModulesDir = join(cliOut, "node_modules");
  mkdirSync(nodeModulesDir, { recursive: true });
  for (const depName of bundleNames) {
    const workspacePath = WORKSPACE_PACKAGE_BY_NAME[depName];
    if (!workspacePath) continue;
    const workspaceDir = dirname(join(root, workspacePath));
    const workspacePkg = JSON.parse(readFileSync(join(root, workspacePath), "utf8"));
    const depOut = join(nodeModulesDir, ...depName.split("/"));
    mkdirSync(depOut, { recursive: true });
    cpSync(join(workspaceDir, "package.json"), join(depOut, "package.json"), { dereference: true });
    cpSync(join(workspaceDir, "LICENSE"), join(depOut, "LICENSE"), { dereference: true });
    const files = Array.isArray(workspacePkg.files) ? workspacePkg.files : [];
    for (const entry of files) {
      cpSync(join(workspaceDir, entry), join(depOut, entry), { recursive: true, dereference: true });
    }
  }

  return { ok: true, staged: { cli: cliOut, codex: codexOut } };
}

function parseStageArgs(rest) {
  const outIdx = rest.indexOf("--out");
  if (outIdx === -1) return {};
  return { outDir: rest[outIdx + 1] };
}

function main() {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const [cmd, ...rest] = process.argv.slice(2);

  if (cmd === "check") {
    const problems = checkRelease(root);
    if (problems.length === 0) {
      const rootPkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
      console.log(`release check: ok (version ${rootPkg.version})`);
      process.exit(0);
    }
    for (const problem of problems) console.error(problem);
    process.exit(1);
    return;
  }

  if (cmd === "stage") {
    const { outDir } = parseStageArgs(rest);
    const result = stageRelease(root, outDir);
    if (!result.ok) {
      if (result.problems) {
        for (const problem of result.problems) console.error(problem);
      } else if (result.reason) {
        console.error(result.reason);
      }
      process.exit(1);
      return;
    }
    console.log(`staged cli package: ${result.staged.cli}`);
    console.log(`staged codex package: ${result.staged.codex}`);
    console.log("next: run the manual pre-publish check, then npm publish.");
    process.exit(0);
    return;
  }

  console.error("usage: node scripts/release.mjs <check|stage [--out <dir>]>");
  process.exit(64);
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  main();
}
