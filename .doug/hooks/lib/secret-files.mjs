// Whole-file secret scan for the export and the npm stage: runs the shared rules (secret-rules.mjs) line by line.
import { scanText } from "./secret-rules.mjs";
import { matchAny } from "./glob.mjs";

/** Binary the way git decides: a NUL within the first 8000 bytes. A later NUL leaves the file text. */
export function isBinary(buf) {
  return buf.subarray(0, 8000).includes(0);
}

/**
 * Scans [{ path, text }] with the shared secret rules, one line at a time. Returns [{ path, line, rule }],
 * at most one entry per line, never any matched text. secrets.ignorePaths (globs over path), secrets.rules
 * and secrets.placeholders apply; secrets.enabled does not (the release scan is not the edit gate).
 */
export function secretScanFiles(files, secrets) {
  const hits = [];
  const ignore = (secrets && secrets.ignorePaths) || [];
  for (const f of files) {
    if (ignore.length > 0 && matchAny(ignore, f.path)) continue;
    const lines = f.text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const hit = scanText(lines[i], secrets);
      if (hit) hits.push({ path: f.path, line: i + 1, rule: hit.rule });
    }
  }
  return hits;
}
