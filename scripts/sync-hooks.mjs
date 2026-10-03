// Makes <to>/scripts and <to>/lib byte-identical to <from>/scripts and <from>/lib.
// Run as a script: plugins/doug-gates -> .doug/hooks at the repo root.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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

export function syncHooks({ from, to }) {
  const changes = [];
  for (const sub of ["scripts", "lib"]) {
    const src = listFiles(from, sub);
    const have = new Set(src);
    for (const rel of src) {
      const dest = join(to, rel);
      const bytes = readFileSync(join(from, rel));
      const existed = existsSync(dest);
      if (existed && readFileSync(dest).equals(bytes)) continue;
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, bytes);
      changes.push(`${existed ? "updated" : "added"} ${rel}`);
    }
    for (const rel of listFiles(to, sub)) {
      if (have.has(rel)) continue;
      rmSync(join(to, rel), { force: true });
      changes.push(`removed ${rel}`);
    }
  }
  return changes;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const changes = syncHooks({ from: join(root, "plugins/doug-gates"), to: join(root, ".doug/hooks") });
  console.log(changes.length ? changes.join("\n") : ".doug/hooks already in sync with plugins/doug-gates");
}
