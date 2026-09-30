import { resolve } from "node:path";
import type { Detection } from "./types.js";
import { detectNode } from "./node.js";
import { detectPython } from "./python.js";
import { detectRepo } from "./repo.js";

export type { Detection } from "./types.js";

export function detect(dirInput: string): Detection {
  const dir = resolve(dirInput);
  const notes: string[] = [];
  const node = detectNode(dir, notes);
  const python = detectPython(dir, notes);
  const repo = detectRepo(dir, notes);
  return { dir, node, python, repo, notes };
}
