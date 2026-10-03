import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const PLUGINS = ["plugins/doug-flow", "plugins/doug-gates"];
const PATTERN = /plugins\/doug-|packages\/doug-|evals\//;
// Prompts: scanned in full. Everything else is scanned minus comment lines.
const FULL_DIRS = new Set(["skills", "agents", ".claude-plugin"]);
const COMMENT = /^(\/\/|\/\*|\*|#)/;

function walk(path) {
  const st = statSync(path);
  if (!st.isDirectory()) return [path];
  return readdirSync(path).flatMap((name) => walk(join(path, name)));
}

function scan(plugin) {
  const pluginDir = join(repoRoot, plugin);
  const pkg = JSON.parse(readFileSync(join(pluginDir, "package.json"), "utf8"));
  const hits = [];
  let scanned = 0;
  for (const entry of pkg.files) {
    const abs = join(pluginDir, entry);
    if (!existsSync(abs)) continue;
    const full = FULL_DIRS.has(entry.split("/")[0]);
    for (const file of walk(abs)) {
      scanned += 1;
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        if (!full && COMMENT.test(line.trim())) return;
        const m = PATTERN.exec(line);
        if (m) hits.push(`${relative(repoRoot, file)}:${i + 1}: ${m[0]} in ${line.trim()}`);
      });
    }
  }
  return { hits, scanned, files: pkg.files };
}

describe("shipped plugin files name no repo-internal paths", () => {
  for (const plugin of PLUGINS) {
    it(`${plugin}: no plugins/doug-, packages/doug-, or evals/ in its package.json files`, () => {
      const { hits, scanned, files } = scan(plugin);
      expect(files.length).toBeGreaterThan(0);
      expect(scanned).toBeGreaterThan(0);
      expect(hits).toEqual([]);
    });
  }
});
