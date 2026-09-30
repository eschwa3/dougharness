import { existsSync, mkdirSync, writeFileSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import type { FileChange } from "./diff.js";

export function applyChanges(dir: string, changes: FileChange[]): string[] {
  const written: string[] = [];
  for (const c of changes) {
    if (c.after === null) continue; // deletions are never proposed in this version
    const abs = join(dir, c.path);
    if (c.before === null && existsSync(abs)) continue; // created since the proposal was built; leave it
    mkdirSync(dirname(abs), { recursive: true });
    const tmp = abs + ".doug-tmp";
    writeFileSync(tmp, c.after);
    renameSync(tmp, abs);
    written.push(c.path);
  }
  return written;
}
