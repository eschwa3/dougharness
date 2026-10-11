#!/usr/bin/env node
// The lead's own context percentage (card autopilot-unlimited), read from the session transcript.
//   context.mjs [dir] [--session <id|latest>] [--claude-dir <path>]
//     dir         the project directory (default cwd); <dir>/.doug/config.json supplies autopilot.contextThreshold
//     --session   a session id or latest, as cost.mjs --session. Default: the CLAUDE_CODE_SESSION_ID environment
//                 variable (the lead's own session, so a newer non-lead transcript, such as a reflect pass, is not read);
//                 latest only when it is unset or empty. A variable naming a session with no transcript exits 1.
//     --claude-dir where ~/.claude lives (tests point it at a fixture)
// Prints one line and exits 0; exits 1 with a stderr message when there is no transcript or no usage line.
import { readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { sessionTranscriptPath } from "../lib/cost.mjs";
import { atThreshold, contextReading, contextThreshold } from "../lib/context.mjs";

const argv = process.argv.slice(2);
const opts = {};
const positional = [];
for (let i = 0; i < argv.length; i++) {
  if (!argv[i].startsWith("--")) {
    positional.push(argv[i]);
    continue;
  }
  opts[argv[i].slice(2)] = argv[i + 1] ?? "";
  i++;
}

const dir = resolve(positional[0] || process.cwd());
let config = {};
try {
  config = JSON.parse(readFileSync(join(dir, ".doug/config.json"), "utf8"));
} catch {
  // absent or unreadable: defaults
}
const threshold = contextThreshold(config, (m) => process.stderr.write(`[doug] ${m}\n`));

let file;
try {
  file = sessionTranscriptPath({ session: opts.session || process.env.CLAUDE_CODE_SESSION_ID || "latest", ...(opts["claude-dir"] ? { claudeDir: resolve(opts["claude-dir"]) } : {}), projectDir: dir });
} catch (err) {
  process.stderr.write(`context: ${err.message}\n`);
  process.exit(1);
}
const r = contextReading(file);
if (!r) {
  process.stderr.write(`context: no usage line in ${file}\n`);
  process.exit(1);
}
process.stdout.write(
  `context: ${r.pct}% (${r.tokens} of ${r.window} tokens, ${r.model}); threshold ${threshold}% (autopilot.contextThreshold) -> ${atThreshold(r.pct, threshold) ? "stop" : "continue"}\n`,
);
