/** Ids look like "res-0007": a prefix, a dash and a four digit counter. */
export function formatId(prefix: string, n: number): string {
  return `${prefix}-${String(n).padStart(4, "0")}`;
}

/** The counter part of an id with the given prefix, or null when it does not match. */
export function idNumber(prefix: string, id: string): number | null {
  const match = new RegExp(`^${prefix}-(\\d+)$`).exec(id);
  return match ? Number(match[1]) : null;
}

/** The next unused id for a prefix, one past the highest counter among the existing ids. */
export function nextId(prefix: string, existing: string[]): string {
  let max = 0;
  for (const id of existing) {
    const n = idNumber(prefix, id);
    if (n !== null && n > max) max = n;
  }
  return formatId(prefix, max + 1);
}
