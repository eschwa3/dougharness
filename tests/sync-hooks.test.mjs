import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { tmpdir } from "node:os";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

// Imported lazily so the live-repo cases (f, g) still run while scripts/sync-hooks.mjs does not exist.
async function syncHooks(opts) {
  const mod = await import("../scripts/sync-hooks.mjs");
  return mod.syncHooks(opts);
}

function put(root, rel, text) {
  const p = join(root, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, text);
}

function listFiles(root, sub) {
  const out = [];
  const walk = (rel) => {
    for (const e of readdirSync(join(root, rel), { withFileTypes: true })) {
      const r = join(rel, e.name);
      if (e.isDirectory()) walk(r);
      else out.push(r);
    }
  };
  if (existsSync(join(root, sub))) walk(sub);
  return out.sort();
}

describe("syncHooks", () => {
  let tmp, from, to;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "sync-hooks-"));
    from = join(tmp, "gates");
    to = join(tmp, "hooks");
    put(from, "scripts/a.mjs", "a1");
    put(from, "lib/x.mjs", "x1");
    put(to, "scripts/a.mjs", "a1");
    put(to, "lib/x.mjs", "x1");
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it("(a) copies a new source file in scripts/", async () => {
    put(from, "scripts/new.mjs", "fresh");
    await syncHooks({ from, to });
    expect(readFileSync(join(to, "scripts/new.mjs"), "utf8")).toBe("fresh");
  });

  it("(b) overwrites a changed file", async () => {
    put(from, "scripts/a.mjs", "a2");
    await syncHooks({ from, to });
    expect(readFileSync(join(to, "scripts/a.mjs"), "utf8")).toBe("a2");
  });

  it("(c) copies a new file in lib/", async () => {
    put(from, "lib/y.mjs", "why");
    await syncHooks({ from, to });
    expect(readFileSync(join(to, "lib/y.mjs"), "utf8")).toBe("why");
  });

  it("(d) deletes target files the source lacks", async () => {
    put(to, "scripts/stale.mjs", "old");
    put(to, "lib/stale.mjs", "old");
    await syncHooks({ from, to });
    expect(existsSync(join(to, "scripts/stale.mjs"))).toBe(false);
    expect(existsSync(join(to, "lib/stale.mjs"))).toBe(false);
  });

  it("(e) leaves a top-level target file like VERSION alone", async () => {
    put(to, "VERSION", "1.2.3\n");
    put(from, "scripts/new.mjs", "fresh");
    await syncHooks({ from, to });
    expect(readFileSync(join(to, "VERSION"), "utf8")).toBe("1.2.3\n");
  });

  it("(f) the live .doug/hooks scripts and lib equal plugins/doug-gates", () => {
    const gates = join(repoRoot, "plugins/doug-gates");
    const hooks = join(repoRoot, ".doug/hooks");
    for (const sub of ["scripts", "lib"]) {
      const src = listFiles(gates, sub);
      expect(listFiles(hooks, sub), `${sub} file set differs`).toEqual(src);
      for (const rel of src) {
        expect(readFileSync(join(hooks, rel)).equals(readFileSync(join(gates, rel))), `${rel} differs`).toBe(true);
      }
    }
  });

  it("(g) root package.json has hooks:sync and build invokes it", () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
    expect(pkg.scripts["hooks:sync"]).toContain("scripts/sync-hooks.mjs");
    expect(pkg.scripts.build).toMatch(/hooks:sync|sync-hooks/);
  });
});
