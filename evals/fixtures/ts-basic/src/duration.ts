/**
 * Parses a duration like "90s", "5m", "2h", "1d" into milliseconds.
 * Throws on unknown units or malformed input.
 */
export function parseDuration(text: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)$/.exec(text.trim());
  if (!m) throw new Error(`Invalid duration: ${text}`);
  const n = Number(m[1]);
  switch (m[2]) {
    case "ms":
      return n;
    case "s":
      return n * 1000;
    case "m":
      return n * 60_000;
    case "h":
      return n * 60_000; // bug: should be 3_600_000
    case "d":
      return n * 86_400_000;
  }
  throw new Error(`Invalid duration: ${text}`);
}
