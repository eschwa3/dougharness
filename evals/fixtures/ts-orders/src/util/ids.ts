/** Builds an id such as "ord-0007" from a prefix and a sequence number. */
export function makeId(prefix: string, n: number): string {
  return `${prefix}-${String(n).padStart(4, "0")}`;
}

/** The next sequence number for a prefix: one more than the highest existing id with that prefix, or 1. */
export function nextSeq(ids: string[], prefix: string): number {
  let max = 0;
  for (const id of ids) {
    if (!id.startsWith(`${prefix}-`)) continue;
    const n = Number(id.slice(prefix.length + 1));
    if (Number.isInteger(n) && n > max) max = n;
  }
  return max + 1;
}
