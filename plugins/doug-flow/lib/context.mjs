// The lead's own context reading (card autopilot-unlimited): scripts/context.mjs prints the last assistant line's
// usage in the session transcript against its model's window, and whether it is at autopilot.contextThreshold.
// windowFor and contextReading are copied from plugins/doug-gates/lib/agent-context.mjs: the plugins install
// separately, so doug-flow cannot import across the boundary (as learn.mjs keeps its own local glob copy).

import { readFileSync, existsSync } from "node:fs";

// 1M for a Fable/Opus/Sonnet 5 model, 200k otherwise (an unknown or missing model errs early, on the smaller window).
export function windowFor(model) {
  if (typeof model !== "string") return 200000;
  return /fable-5|opus-5|sonnet-5/.test(model) ? 1000000 : 200000;
}

// The last assistant line with usage in a transcript file, against its model's window. null when the file is
// missing, unreadable, or has no assistant line carrying usage.
export function contextReading(file, { windows = windowFor } = {}) {
  if (!file || !existsSync(file)) return null;
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return null;
  }
  let lastMessage = null;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (o && o.type === "assistant" && o.message && o.message.usage) lastMessage = o.message;
  }
  if (!lastMessage) return null;
  const u = lastMessage.usage;
  const tokens = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
  const model = lastMessage.model || null;
  const window = windows(model);
  return { tokens, model, window, pct: Math.round((100 * tokens) / window) };
}

export const CONTEXT_THRESHOLD_DEFAULT = 60;

// The configured autopilot.contextThreshold when it is a finite number in 1..100; the default silently when the key
// (or autopilot) is absent or null; the default plus one warn() call otherwise.
export function contextThreshold(config, warn = () => {}) {
  const v = config && config.autopilot ? config.autopilot.contextThreshold : undefined;
  if (v === undefined || v === null) return CONTEXT_THRESHOLD_DEFAULT;
  if (typeof v === "number" && Number.isFinite(v) && v >= 1 && v <= 100) return v;
  warn(`autopilot.contextThreshold must be a number from 1 to 100; using ${CONTEXT_THRESHOLD_DEFAULT}`);
  return CONTEXT_THRESHOLD_DEFAULT;
}

export function atThreshold(pct, threshold) {
  return pct >= threshold;
}
