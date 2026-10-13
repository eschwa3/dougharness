// Inlines plugins/doug-flow/lib/card-loop.mjs into plugins/doug-flow/workflows/card-queen.js between marker lines.
// A workflow script containing import() fails before the run starts (workflows.md:362), so the contract is copied in.
// Run as a script (pnpm workflows:sync); tests/card-queen.test.mjs fails when the copy drifts.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const BEGIN = "// ---- BEGIN card-loop.mjs (inlined by pnpm workflows:sync; do not edit) ----";
export const END = "// ---- END card-loop.mjs ----";

export function inlineCardLoop(libSource) {
  const body = libSource.replace(/^export\s+/gm, "").replace(/\s+$/, "");
  return `${BEGIN}\n${body}\n${END}`;
}

export function syncCardLoop({ lib, workflow }) {
  const block = inlineCardLoop(readFileSync(lib, "utf8"));
  const source = readFileSync(workflow, "utf8");
  const a = source.indexOf(BEGIN);
  const b = source.indexOf(END);
  if (a < 0 || b < a) throw new Error(`${workflow} needs the BEGIN and END marker lines, in that order`);
  const out = source.slice(0, a) + block + source.slice(b + END.length);
  if (out === source) return false;
  writeFileSync(workflow, out);
  return true;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const changed = syncCardLoop({
    lib: join(root, "plugins/doug-flow/lib/card-loop.mjs"),
    workflow: join(root, "plugins/doug-flow/workflows/card-queen.js"),
  });
  console.log(changed ? "card-queen.js updated from card-loop.mjs" : "card-queen.js already in sync with card-loop.mjs");
}
