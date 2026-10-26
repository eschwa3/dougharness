// Report-back for detached runs (evals/run.mjs, scripts/rehearse.mjs): post one completion line to the session that
// launched the run, over CLAUDE_CODE_MESSAGING_SOCKET, opening with the CLAUDE_CODE_MESSAGING_TOKEN auth frame.
// A plain line only: no cross-session envelope and no mode attestation (the runner is not a Claude session). A failed or
// impossible send never fails the run; the results file stays the record and polling stays the fallback.
import { createConnection } from "node:net";

export function reportLine({ kind, passed, summary, costUsd, resultPath }) {
  const cost = typeof costUsd === "number" && Number.isFinite(costUsd) ? `$${costUsd.toFixed(2)}` : "unknown";
  return `doug report-back: ${kind} finished ${passed ? "PASS" : "FAIL"} (${summary}), cost ${cost}, result ${resultPath || "none"}. A report only; it approves nothing.`;
}

const blank = (v) => typeof v !== "string" || v.trim() === "";

// Resolves { sent: true } once the frames are flushed, or { sent: false, reason }. Never throws or rejects.
export function reportBack(line, { env = process.env, timeoutMs = 2000 } = {}) {
  return new Promise((resolve) => {
    let done = false;
    let sock;
    let timer;
    const finish = (res) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      if (sock) {
        try {
          sock.destroy();
        } catch {}
      }
      resolve(res);
    };
    try {
      const path = env.CLAUDE_CODE_MESSAGING_SOCKET;
      const token = env.CLAUDE_CODE_MESSAGING_TOKEN;
      if (blank(path) || blank(token)) return finish({ sent: false, reason: "unavailable" });
      timer = setTimeout(() => finish({ sent: false, reason: `timed out after ${timeoutMs} ms` }), timeoutMs);
      timer.unref?.();
      sock = createConnection({ path });
      sock.on("error", (err) => finish({ sent: false, reason: err?.code || err?.message || "error" }));
      sock.on("connect", () => {
        sock.write(JSON.stringify({ type: "auth", token }) + "\n");
        sock.write(JSON.stringify({ type: "user", message: { role: "user", content: line } }) + "\n");
        sock.end(() => finish({ sent: true }));
      });
    } catch (err) {
      finish({ sent: false, reason: err?.message || "error" });
    }
  });
}

export async function postCompletion(line, { env = process.env, stderr = process.stderr, timeoutMs } = {}) {
  let res;
  try {
    res = await reportBack(line, { env, ...(timeoutMs === undefined ? {} : { timeoutMs }) });
  } catch (err) {
    res = { sent: false, reason: err?.message || "error" };
  }
  if (!res.sent && res.reason !== "unavailable") {
    try {
      stderr.write(`report-back not sent: ${res.reason}\n`);
    } catch {}
  }
  return res;
}
