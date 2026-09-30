// Unified diff rendering with no dependencies. Line-based LCS; fine for config-sized files.

export interface FileChange {
  path: string;
  before: string | null;
  after: string | null;
  /** Why this file is proposed. Shown above the diff. */
  reason?: string;
}

type Op = { kind: " " | "+" | "-"; line: string };

function lcsOps(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  const dp: Uint32Array[] = [];
  for (let i = 0; i <= n; i++) dp.push(new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ kind: " ", line: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ kind: "-", line: a[i] });
      i++;
    } else {
      ops.push({ kind: "+", line: b[j] });
      j++;
    }
  }
  while (i < n) ops.push({ kind: "-", line: a[i++] });
  while (j < m) ops.push({ kind: "+", line: b[j++] });
  return ops;
}

function splitLines(s: string | null): string[] {
  if (s === null || s === "") return [];
  const lines = s.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

export interface DiffOptions {
  color?: boolean;
  context?: number;
}

export function renderDiff(change: FileChange, opts: DiffOptions = {}): string {
  const color = opts.color ?? false;
  const ctx = opts.context ?? 3;
  const c = (code: string, s: string) => (color ? `[${code}m${s}[0m` : s);
  const a = splitLines(change.before);
  const b = splitLines(change.after);
  const header: string[] = [];
  const status = change.before === null ? "create" : change.after === null ? "delete" : "modify";
  header.push(c("1", `${status}  ${change.path}`));
  if (change.reason) header.push(c("2", `        ${change.reason}`));
  header.push(c("36", `--- ${change.before === null ? "/dev/null" : "a/" + change.path}`));
  header.push(c("36", `+++ ${change.after === null ? "/dev/null" : "b/" + change.path}`));

  const ops = lcsOps(a, b);
  if (ops.every((o) => o.kind === " ")) return header[0] + "\n        (no changes)";

  // Group into hunks with context.
  const out: string[] = [...header];
  let i = 0;
  while (i < ops.length) {
    if (ops[i].kind === " ") {
      i++;
      continue;
    }
    const start = Math.max(0, i - ctx);
    let end = i;
    let lastChange = i;
    while (end < ops.length && end - lastChange <= ctx) {
      if (ops[end].kind !== " ") lastChange = end;
      end++;
    }
    end = Math.min(ops.length, lastChange + ctx + 1);
    // Compute line numbers for the hunk header.
    let aLine = 1;
    let bLine = 1;
    for (let k = 0; k < start; k++) {
      if (ops[k].kind !== "+") aLine++;
      if (ops[k].kind !== "-") bLine++;
    }
    let aCount = 0;
    let bCount = 0;
    for (let k = start; k < end; k++) {
      if (ops[k].kind !== "+") aCount++;
      if (ops[k].kind !== "-") bCount++;
    }
    out.push(c("36", `@@ -${aLine},${aCount} +${bLine},${bCount} @@`));
    for (let k = start; k < end; k++) {
      const o = ops[k];
      const text = o.kind + o.line;
      out.push(o.kind === "+" ? c("32", text) : o.kind === "-" ? c("31", text) : text);
    }
    i = end;
  }
  return out.join("\n");
}
