// Verification evidence (proposal B, card verification-evidence): did this session itself run a test or verify
// command? guard-bash records every allowed Bash command in the session state; the stop gate asks here whether any
// of them is one of the gate commands, another configured project command, a known test runner, or a pattern
// from stopGate.evidencePatterns. The gate's own run says whether verification passes; this says whether the
// agent ever looked, so "ran and failed" and "never ran" get different messages.

export const RUNNER_PATTERNS = [
  /\bvitest\b/,
  /\bjest\b/,
  /\bmocha\b/,
  /\bnode\s+--test\b/,
  /\bpytest\b/,
  /\bpython3?\s+-m\s+unittest\b/,
  /(^|[\s;&|(])tsc(\s|$)/,
  /\bcargo\s+test\b/,
  /\bgo\s+test\b/,
  /\bswift\s+test\b/,
  /\bxcodebuild\b.*\btest\b/,
  /\bmvn\b.*\btest\b/,
  /\bgradle\w*\b.*\btest\b/,
  /\bdotnet\s+test\b/,
  /\bmake\s+(test|check)\b/,
];

// The commands the stop gate runs, by name, plus every other configured project command except install.
export function evidenceCommands(cfg) {
  const out = [];
  for (const entry of (cfg.stopGate && cfg.stopGate.commands) || []) {
    if (typeof entry !== "string") continue;
    const named = cfg.commands && cfg.commands[entry];
    out.push(typeof named === "string" ? named : entry);
  }
  for (const [name, command] of Object.entries(cfg.commands || {})) {
    if (name === "install" || typeof command !== "string" || out.includes(command)) continue;
    out.push(command);
  }
  return out;
}

// { ran: the recorded commands that count as verification, looked: what counts }.
export function verificationEvidence(commands, cfg) {
  const looked = evidenceCommands(cfg);
  const extra = ((cfg.stopGate && cfg.stopGate.evidencePatterns) || []).flatMap((p) => {
    try {
      return [new RegExp(p)];
    } catch {
      return [];
    }
  });
  const ran = (commands || []).filter((c) => typeof c === "string" && (looked.some((g) => g && c.includes(g)) || RUNNER_PATTERNS.some((r) => r.test(c)) || extra.some((r) => r.test(c))));
  return { ran, looked };
}

export function describeMissingEvidence(looked, gatePassed) {
  const named = looked.length ? looked.map((c) => `\`${c}\``).join(", ") + ", " : "";
  return gatePassed
    ? `No test or verify command ran in this session (looked for ${named}or a test runner such as vitest, jest, or pytest). The gate ran them here and they pass, but run the test command yourself and report its result before finishing; do not report work as verified that you did not verify.`
    : `This session never ran a test or verify command itself (looked for ${named}or a test runner). Run it, read the failure above, and fix it before finishing.`;
}
