import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

// engines-test-path-encoding: new URL(...).pathname percent-encodes spaces (and drops everything after a '#'),
// so a repo root containing either made readFileSync throw ENOENT; join() builds a plain path.
function readPackageJson(relativePath) {
  const path = join(repoRoot, relativePath);
  return JSON.parse(readFileSync(path, "utf8"));
}

const workspacePackages = [
  "packages/doug-cli/package.json",
  "packages/doug-codex/package.json",
  "plugins/doug-flow/package.json",
  "plugins/doug-gates/package.json",
];

describe("engines.node floor", () => {
  const rootPkg = readPackageJson("package.json");
  const rootNode = rootPkg.engines && rootPkg.engines.node;

  it("root package.json declares an engines.node string", () => {
    expect(typeof rootNode).toBe("string");
  });

  for (const relativePath of workspacePackages) {
    it(`${relativePath} matches the root engines.node`, () => {
      const pkg = readPackageJson(relativePath);
      expect(pkg.engines && pkg.engines.node).toBe(rootNode);
    });
  }
});
