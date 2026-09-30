import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

function readJson(relativePath) {
  const path = join(repoRoot, relativePath);
  return JSON.parse(readFileSync(path, "utf8"));
}

const manifest = readJson(".claude-plugin/marketplace.json");

describe("marketplace manifest", () => {
  it("parses and has a valid name and owner", () => {
    expect(typeof manifest.name).toBe("string");
    expect(manifest.name).toMatch(/^[a-z0-9-]+$/);
    expect(typeof manifest.owner).toBe("object");
    expect(typeof manifest.owner.name).toBe("string");
    expect(manifest.owner.name.length).toBeGreaterThan(0);
  });

  it("lists exactly doug-gates and doug-flow", () => {
    const names = manifest.plugins.map((p) => p.name).sort();
    expect(names).toEqual(["doug-flow", "doug-gates"]);
  });

  it("each entry's source resolves to a plugin.json whose name matches", () => {
    for (const entry of manifest.plugins) {
      expect(entry.source.startsWith("./")).toBe(true);
      expect(entry.source.split("/")).not.toContain("..");

      const pluginJsonPath = join(repoRoot, entry.source, ".claude-plugin/plugin.json");
      expect(existsSync(pluginJsonPath)).toBe(true);

      const pluginJson = JSON.parse(readFileSync(pluginJsonPath, "utf8"));
      expect(pluginJson.name).toBe(entry.name);
    }
  });

  it("carries no version anywhere (plugin.json owns it)", () => {
    expect(manifest.version).toBeUndefined();
    expect(manifest.metadata.version).toBeUndefined();
    for (const entry of manifest.plugins) {
      expect(entry.version).toBeUndefined();
    }
  });

  it("copies the root LICENSE byte for byte into each plugin directory", () => {
    const rootLicense = readFileSync(join(repoRoot, "LICENSE"));
    for (const entry of manifest.plugins) {
      const pluginLicense = readFileSync(join(repoRoot, entry.source, "LICENSE"));
      expect(pluginLicense.equals(rootLicense)).toBe(true);
    }
  });
});
