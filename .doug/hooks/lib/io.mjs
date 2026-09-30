// Hook I/O against the Claude Code hook contract (Sept 2026).
// - Input: one JSON object on stdin.
// - Output: exit 0 with a JSON decision on stdout. Exit 2 with stderr only as a last resort.
// Every hook fails OPEN on its own bugs, but visibly: a systemMessage names the hook and the error.

export async function readInput(timeoutMs = 3000) {
  const chunks = [];
  const done = new Promise((resolve) => {
    process.stdin.on("data", (c) => chunks.push(c));
    process.stdin.on("end", resolve);
    process.stdin.on("error", resolve);
    setTimeout(resolve, timeoutMs).unref();
  });
  await done;
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

// Field-name compatibility across doc revisions.
export function toolResponse(input) {
  return input.tool_response ?? input.tool_output ?? null;
}
export function userPrompt(input) {
  return input.prompt ?? input.user_prompt ?? "";
}
export function sessionStartReason(input) {
  return input.source ?? input.session_start_reason ?? "";
}

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

export function allow() {
  process.exit(0);
}

export function denyTool(reason) {
  emit({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  });
  process.exit(0);
}

export function askTool(reason) {
  emit({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "ask",
      permissionDecisionReason: reason,
    },
  });
  process.exit(0);
}

export function addContext(hookEventName, text, extra = {}) {
  emit({ ...extra, hookSpecificOutput: { hookEventName, additionalContext: text } });
  process.exit(0);
}

export function blockStop(reason) {
  emit({ decision: "block", reason });
  process.exit(0);
}

export function systemMessage(message) {
  emit({ systemMessage: message });
  process.exit(0);
}

// Wraps a hook main() so that an unexpected exception never silently blocks or silently passes.
export function runHook(name, main) {
  readInput()
    .then((input) => main(input))
    .then(() => process.exit(0))
    .catch((err) => {
      const msg = `[doug:${name}] hook error, failing open: ${err && err.stack ? err.stack.split("\n")[0] : String(err)}`;
      process.stderr.write(msg + "\n");
      emit({ systemMessage: msg });
      process.exit(0);
    });
}
