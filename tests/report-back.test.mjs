// Card detached-run-report-back: scripts/report-back.mjs (reportLine, reportBack, postCompletion) and the two runners
// that use it (evals/run.mjs, scripts/rehearse.mjs). A fake unix-socket server stands in for the launching session's
// CLAUDE_CODE_MESSAGING_SOCKET; nothing here reaches a real session. Children are spawned async so this process's event
// loop keeps serving the fake socket.
import { describe, it, expect, afterAll, vi } from "vitest";
import { createServer } from "node:net";
import { mkdtempSync, rmSync, writeFileSync, chmodSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reportLine, reportBack, postCompletion } from "../scripts/report-back.mjs";
import { newBoard, addCard, saveBoard } from "../plugins/doug-flow/lib/board.mjs";
import { here, trackedTempDir, run, tempDirs } from "./rehearse-fixtures.mjs";

const runMjs = join(here, "..", "evals", "run.mjs");
const rehearseMjs = join(here, "..", "scripts", "rehearse.mjs");
const toRemove = [];
afterAll(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
  for (const p of toRemove) rmSync(p, { recursive: true, force: true });
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A fake messaging socket. Records each connection's raw text; frames() splits on newlines.
async function fakeSocket({ keepOpen = false } = {}) {
  let dir = mkdtempSync(join(tmpdir(), "rb-"));
  if (join(dir, "s.sock").length >= 100) {
    rmSync(dir, { recursive: true, force: true });
    dir = mkdtempSync("/tmp/rb-");
  }
  toRemove.push(dir);
  const path = join(dir, "s.sock");
  const conns = [];
  const socks = [];
  const server = createServer({ allowHalfOpen: keepOpen }, (sock) => {
    const rec = { text: "" };
    conns.push(rec);
    socks.push(sock);
    sock.on("data", (d) => (rec.text += d.toString("utf8")));
    sock.on("error", () => {});
  });
  await new Promise((res) => server.listen(path, res));
  toRemove.push(path);
  return {
    path,
    conns,
    frames: () => conns.flatMap((c) => c.text.split("\n").filter(Boolean)),
    async waitFrames(n, ms = 3000) {
      const end = Date.now() + ms;
      while (Date.now() < end && this.frames().length < n) await sleep(25);
      return this.frames();
    },
    close: () => new Promise((res) => (server.close(() => res()), socks.forEach((k) => k.destroy()))),
  };
}

const LINE = reportLine({ kind: "eval run", passed: true, summary: "1/1 sessions passed", costUsd: 1.5, resultPath: "/r.json" });

describe("reportLine", () => {
  it("carries the kind, the PASS verdict, the summary, the cost and the result path", () => {
    expect(LINE).toContain("eval run");
    expect(LINE).toContain("PASS");
    expect(LINE).toContain("1/1 sessions passed");
    expect(LINE).toContain("cost $1.50");
    expect(LINE).toContain("/r.json");
    expect(LINE).toContain("A report only; it approves nothing.");
  });
  it("says FAIL and not PASS when the run failed", () => {
    const l = reportLine({ kind: "rehearsal", passed: false, summary: "start failed", costUsd: 0, resultPath: null });
    expect(l).toContain("FAIL");
    expect(l).not.toContain("PASS");
  });
  it("names an unknown cost and a missing result path", () => {
    const l = reportLine({ kind: "eval run", passed: false, summary: "crashed: x", costUsd: null, resultPath: null });
    expect(l).toContain("cost unknown");
    expect(l).toContain("result none");
  });
});

describe("reportBack", () => {
  it("sends the auth frame first, then one user frame carrying the line exactly", async () => {
    const s = await fakeSocket();
    const r = await reportBack(LINE, { env: { CLAUDE_CODE_MESSAGING_SOCKET: s.path, CLAUDE_CODE_MESSAGING_TOKEN: "tok-1" } });
    expect(r).toEqual({ sent: true });
    const frames = await s.waitFrames(2);
    expect(frames).toHaveLength(2);
    expect(JSON.parse(frames[0])).toEqual({ type: "auth", token: "tok-1" });
    expect(JSON.parse(frames[1])).toEqual({ type: "user", message: { role: "user", content: LINE } });
    await s.close();
  });
  it("attests no mode and wraps nothing: the content has no cross-session envelope", async () => {
    const s = await fakeSocket();
    await reportBack(LINE, { env: { CLAUDE_CODE_MESSAGING_SOCKET: s.path, CLAUDE_CODE_MESSAGING_TOKEN: "t" } });
    const frames = await s.waitFrames(2);
    const content = JSON.parse(frames[1]).message.content;
    expect(content).toBe(LINE);
    expect(content).not.toContain("cross-session-message");
    expect(content).not.toContain("from-mode");
    await s.close();
  });
  it("a socket without a token, a token without a socket, or blanks: unavailable, nothing connected", async () => {
    const s = await fakeSocket();
    const r1 = await reportBack(LINE, { env: { CLAUDE_CODE_MESSAGING_SOCKET: s.path } });
    const r2 = await reportBack(LINE, { env: { CLAUDE_CODE_MESSAGING_SOCKET: s.path, CLAUDE_CODE_MESSAGING_TOKEN: "  " } });
    const r3 = await reportBack(LINE, { env: { CLAUDE_CODE_MESSAGING_TOKEN: "t" } });
    const r4 = await reportBack(LINE, { env: {} });
    for (const r of [r1, r2, r3, r4]) expect(r).toEqual({ sent: false, reason: "unavailable" });
    await sleep(150);
    expect(s.conns).toHaveLength(0);
    await s.close();
  });
  it("a socket path that does not exist resolves sent:false and never rejects", async () => {
    const r = await reportBack(LINE, { env: { CLAUDE_CODE_MESSAGING_SOCKET: join(tmpdir(), "no-such-dir", "x.sock"), CLAUDE_CODE_MESSAGING_TOKEN: "t" } });
    expect(r.sent).toBe(false);
    expect(typeof r.reason).toBe("string");
    expect(r.reason).not.toBe("");
  });
  it("a server that accepts and never closes does not hang the send", async () => {
    const s = await fakeSocket({ keepOpen: true });
    const t0 = Date.now();
    const r = await Promise.race([
      reportBack(LINE, { env: { CLAUDE_CODE_MESSAGING_SOCKET: s.path, CLAUDE_CODE_MESSAGING_TOKEN: "t" } }),
      sleep(5000).then(() => "hung"),
    ]);
    expect(r, "reportBack must resolve without waiting for the server to close").toEqual({ sent: true });
    expect(Date.now() - t0).toBeLessThan(5000);
    const frames = await s.waitFrames(2);
    expect(frames).toHaveLength(2);
    await s.close();
  });
});

describe("postCompletion", () => {
  function sink() {
    const out = [];
    return { out, write: (t) => (out.push(String(t)), true) };
  }
  it("prints nothing when the socket is unavailable", async () => {
    const err = sink();
    const r = await postCompletion(LINE, { env: {}, stderr: err });
    expect(r).toEqual({ sent: false, reason: "unavailable" });
    expect(err.out).toEqual([]);
  });
  it("writes exactly one 'report-back not sent:' line on a failed send and does not throw", async () => {
    const err = sink();
    const r = await postCompletion(LINE, { env: { CLAUDE_CODE_MESSAGING_SOCKET: join(tmpdir(), "nope", "x.sock"), CLAUDE_CODE_MESSAGING_TOKEN: "t" }, stderr: err });
    expect(r.sent).toBe(false);
    expect(err.out).toHaveLength(1);
    expect(err.out[0]).toMatch(/^report-back not sent: .+\n?$/);
  });
  it("posts the line on a working socket and prints nothing", async () => {
    const s = await fakeSocket();
    const err = sink();
    const r = await postCompletion(LINE, { env: { CLAUDE_CODE_MESSAGING_SOCKET: s.path, CLAUDE_CODE_MESSAGING_TOKEN: "t" }, stderr: err });
    expect(r).toEqual({ sent: true });
    expect((await s.waitFrames(2))).toHaveLength(2);
    expect(err.out).toEqual([]);
    await s.close();
  });
});

function childEnv(extra = {}, drop = []) {
  const env = { ...process.env, ...extra };
  for (const k of drop) delete env[k];
  return env;
}
const withSocket = (s) => ({ CLAUDE_CODE_MESSAGING_SOCKET: s.path, CLAUDE_CODE_MESSAGING_TOKEN: "tok-run" });
const NO_SOCKET = ["CLAUDE_CODE_MESSAGING_SOCKET", "CLAUDE_CODE_MESSAGING_TOKEN"];
const userFrames = (s) => s.frames().map((f) => JSON.parse(f)).filter((f) => f.type === "user");

const OK_ARGS = [runMjs, "--tasks", "no-such-task", "--judge", "off", "--conditions", "baseline"];
function removeDetails(stdout) {
  const m = stdout.match(/Details: (.+)/);
  if (m) rmSync(m[1].trim(), { force: true });
  return m ? m[1].trim() : null;
}

describe("evals/run.mjs report-back", () => {
  it("posts one PASS line with the results file when it completes", async () => {
    const s = await fakeSocket();
    const r = await run(process.execPath, OK_ARGS, { env: childEnv(withSocket(s)) });
    const file = removeDetails(r.stdout);
    expect(r.status, r.stderr).toBe(0);
    expect(file).toBeTruthy();
    const frames = await s.waitFrames(2);
    expect(JSON.parse(frames[0])).toEqual({ type: "auth", token: "tok-run" });
    const users = userFrames(s);
    expect(users).toHaveLength(1);
    const c = users[0].message.content;
    for (const part of ["eval run", "PASS", "0/0", file]) expect(c).toContain(part);
    await s.close();
  });
  it("posts one FAIL line naming the crash when it throws, and still exits 1", async () => {
    const s = await fakeSocket();
    const r = await run(process.execPath, [runMjs, "--suite", "no-such-suite"], { env: childEnv(withSocket(s)) });
    expect(r.status).toBe(1);
    await s.waitFrames(2);
    const users = userFrames(s);
    expect(users).toHaveLength(1);
    const c = users[0].message.content;
    for (const part of ["eval run", "FAIL", "crashed"]) expect(c).toContain(part);
    await s.close();
  });
  it("a dead socket never fails the run: exit 0, Details printed, one 'report-back not sent:' stderr line", async () => {
    const dead = join(tmpdir(), "no-such-dir", "x.sock");
    const r = await run(process.execPath, OK_ARGS, { env: childEnv({ CLAUDE_CODE_MESSAGING_SOCKET: dead, CLAUDE_CODE_MESSAGING_TOKEN: "t" }) });
    removeDetails(r.stdout);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("Details:");
    expect(r.stderr.split("\n").filter((l) => l.startsWith("report-back not sent:"))).toHaveLength(1);
  });
  it("a dry run posts nothing", async () => {
    const s = await fakeSocket();
    const r = await run(process.execPath, [runMjs, "--dry-run", "--tasks", "fix-hours"], { env: childEnv(withSocket(s)) });
    expect(r.status, r.stderr).toBe(0);
    await sleep(300);
    expect(s.conns).toHaveLength(0);
    await s.close();
  });
  it("is silent without the socket: same exit, no report-back text, nothing connected", async () => {
    const s = await fakeSocket();
    const r = await run(process.execPath, OK_ARGS, { env: childEnv({}, NO_SOCKET) });
    removeDetails(r.stdout);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout + r.stderr).not.toMatch(/doug report-back:|report-back not sent/);
    await sleep(200);
    expect(s.conns).toHaveLength(0);
    await s.close();
  });
});

function rehearseTarget() {
  const targetDir = trackedTempDir("rb-rehearse-target-");
  let board = { ...newBoard(), components: ["flow"] };
  board = addCard(board, { id: "c", title: "C", goal: "g", component: "flow", size: "S", track: "hand", column: "ready" });
  saveBoard(targetDir, board);
  const bin = join(trackedTempDir("rb-fake-claude-"), "claude");
  writeFileSync(bin, "#!/usr/bin/env node\nprocess.exit(1);\n");
  chmodSync(bin, 0o755);
  return { targetDir, bin };
}

describe("scripts/rehearse.mjs report-back", () => {
  it("posts one FAIL rehearsal line when a scenario fails, and exits 1", async () => {
    const s = await fakeSocket();
    const { targetDir, bin } = rehearseTarget();
    const r = await run(process.execPath, [rehearseMjs, "start", "--spend", "--card", "c", targetDir], { env: childEnv({ ...withSocket(s), DOUG_REHEARSE_CLAUDE: bin }) });
    expect(r.status, r.stderr + r.stdout).toBe(1);
    await s.waitFrames(2);
    const users = userFrames(s);
    expect(users).toHaveLength(1);
    expect(users[0].message.content).toContain("rehearsal");
    expect(users[0].message.content).toContain("FAIL");
    await s.close();
  });
  it("a replay run (DOUG_REPLAY_SCENARIO set) posts nothing even with the socket", async () => {
    const s = await fakeSocket();
    const { targetDir, bin } = rehearseTarget();
    const r = await run(process.execPath, [rehearseMjs, "start", "--spend", "--card", "c", targetDir], { env: childEnv({ ...withSocket(s), DOUG_REHEARSE_CLAUDE: bin, DOUG_REPLAY_SCENARIO: "start" }) });
    expect(r.status, r.stderr + r.stdout).toBe(1);
    expect(r.stdout + r.stderr).not.toMatch(/doug report-back:|report-back not sent/);
    await sleep(300);
    expect(s.conns).toHaveLength(0);
    await s.close();
  });
  it("a blank DOUG_REPLAY_SCENARIO still posts one line", async () => {
    const s = await fakeSocket();
    const { targetDir, bin } = rehearseTarget();
    const r = await run(process.execPath, [rehearseMjs, "start", "--spend", "--card", "c", targetDir], { env: childEnv({ ...withSocket(s), DOUG_REHEARSE_CLAUDE: bin, DOUG_REPLAY_SCENARIO: "" }) });
    expect(r.status, r.stderr + r.stdout).toBe(1);
    await s.waitFrames(2);
    expect(userFrames(s)).toHaveLength(1);
    await s.close();
  });
  it("is silent without the socket: same exit, no report-back text, nothing connected", async () => {
    const s = await fakeSocket();
    const { targetDir, bin } = rehearseTarget();
    const r = await run(process.execPath, [rehearseMjs, "start", "--spend", "--card", "c", targetDir], { env: childEnv({ DOUG_REHEARSE_CLAUDE: bin }, NO_SOCKET) });
    expect(r.status, r.stderr + r.stdout).toBe(1);
    expect(r.stdout + r.stderr).not.toMatch(/doug report-back:|report-back not sent/);
    await sleep(200);
    expect(s.conns).toHaveLength(0);
    await s.close();
  });
  it("the estimate-only run (no --spend) posts nothing", async () => {
    const s = await fakeSocket();
    const r = await run(process.execPath, [rehearseMjs], { env: childEnv(withSocket(s)) });
    expect(r.status).toBe(2);
    await sleep(300);
    expect(s.conns).toHaveLength(0);
    await s.close();
  });
});

describe("evals/run.mjs completion verdict", () => {
  const load = async () => (await import("../evals/run.mjs")).completionReport;
  it("a run where one of two sessions failed is FAIL, not PASS", async () => {
    const completionReport = await load();
    expect(typeof completionReport, "evals/run.mjs must export completionReport(results, resultPath)").toBe("function");
    const v = completionReport([{ success: true, costUsd: 0.5 }, { success: false, costUsd: 0.25 }], "/tmp/r.json");
    expect(v.passed).toBe(false);
    expect(v.summary).toBe("1/2 sessions passed");
    expect(v.kind).toBe("eval run");
    expect(v.resultPath).toBe("/tmp/r.json");
    expect(v.costUsd).toBeCloseTo(0.75);
    const line = reportLine(v);
    expect(line).toContain("FAIL");
    expect(line).not.toContain("PASS");
  });
  it("a run where every session passed is PASS, and a run where none did is FAIL", async () => {
    const completionReport = await load();
    const all = completionReport([{ success: true }, { success: true }], "/tmp/r.json");
    expect(all.passed).toBe(true);
    expect(all.summary).toBe("2/2 sessions passed");
    expect(reportLine(all)).toContain("PASS");
    const none = completionReport([{ success: false }, { success: false }], "/tmp/r.json");
    expect(none.passed).toBe(false);
    expect(none.summary).toBe("0/2 sessions passed");
  });
  it("an empty run stays PASS (0/0)", async () => {
    const completionReport = await load();
    const v = completionReport([], "/tmp/r.json");
    expect(v.passed).toBe(true);
    expect(v.summary).toBe("0/0 sessions passed");
  });
  it("the main block posts the exported verdict unchanged, with no inline passed literal", () => {
    const src = readFileSync(runMjs, "utf8");
    const start = src.indexOf("fileURLToPath(import.meta.url) === process.argv[1]");
    expect(start).toBeGreaterThan(-1);
    const block = src.slice(start);
    const thenEnd = block.indexOf(".catch(");
    expect(thenEnd).toBeGreaterThan(-1);
    const success = block.slice(0, thenEnd);
    expect(success).toMatch(/reportLine\(\s*completionReport\(\s*out\.results\s*,\s*out\.file\s*\)\s*\)/);
    expect(success).not.toMatch(/passed\s*:/);
    expect(success).not.toMatch(/ok\s*===/);
  });
});

describe("report-back timeout default", () => {
  const ENV = { CLAUDE_CODE_MESSAGING_SOCKET: join(tmpdir(), "no-such-dir", "t.sock"), CLAUDE_CODE_MESSAGING_TOKEN: "t" };
  it("reportBack with no timeoutMs times out at 2000 ms", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const p = reportBack(LINE, { env: ENV });
      vi.advanceTimersByTime(1999);
      vi.advanceTimersByTime(1);
      expect(await p).toEqual({ sent: false, reason: "timed out after 2000 ms" });
    } finally {
      vi.useRealTimers();
    }
  });
  it("postCompletion with no timeoutMs (as evals/run.mjs calls it) uses the 2000 ms default", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const out = [];
      const p = postCompletion(LINE, { env: ENV, stderr: { write: (t) => (out.push(String(t)), true) } });
      vi.advanceTimersByTime(1999);
      vi.advanceTimersByTime(1);
      await p;
      expect(out).toEqual(["report-back not sent: timed out after 2000 ms\n"]);
    } finally {
      vi.useRealTimers();
    }
  });
});

// Card report-back-bypass-delivery: the docs say how a detached run reaches a bypass-mode lead (path c1).
describe("report-back delivery docs (card report-back-bypass-delivery)", () => {
  const readme = readFileSync(join(here, "..", "evals", "README.md"), "utf8");
  const start = readme.search(/^## Report-back/m);
  const rest = readme.slice(start + 1);
  const end = rest.indexOf("\n## ");
  const section = (end === -1 ? rest : rest.slice(0, end)).replace(/\s+/g, " ");

  it("finds the README Report-back section", () => {
    expect(start).toBeGreaterThanOrEqual(0);
    expect(section.length).toBeGreaterThan(100);
  });
  it("names run_in_background as the launch form, not nohup node evals/run.mjs", () => {
    expect(section).toContain("run_in_background");
    expect(section).not.toContain("nohup node evals/run.mjs");
  });
  it("says the run is launched from the lead, not a subagent or Workflow seat", () => {
    expect(section).toMatch(/from the lead/i);
    expect(section).toMatch(/subagent/i);
    expect(section).toMatch(/Workflow/);
  });
  it("says a nohup launch is held by a bypass-mode lead (no-mode-asserted)", () => {
    const advice = section.slice(0, section.indexOf("Checked 2026"));
    expect(advice).toMatch(/A `nohup` launch is re-parented to pid 1/);
    expect(advice).toMatch(/bypass-mode lead holds the line \(`no-mode-asserted`\)/);
    expect(advice).toMatch(/do not launch detached runs with `nohup`/);
  });
  it("says the lead gets two notices for one run", () => {
    expect(section).toMatch(/two notices/i);
    expect(section).toMatch(/background-task notification/i);
    expect(section).toMatch(/report-back line/i);
  });
  it("no longer says the line is held unless the user sets crossSessionInbound", () => {
    expect(section).not.toContain("unless the user sets `crossSessionInbound`");
  });

  const rehearse = readFileSync(rehearseMjs, "utf8").split("\n");
  const rs = rehearse.findIndex((l) => l.startsWith("// Report-back:"));
  let re = rs + 1;
  while (re < rehearse.length && /^\/\/ +\S/.test(rehearse[re])) re++;
  const comment = rehearse.slice(rs, re).join(" ").replace(/\/\//g, "").replace(/\s+/g, " ");

  it("scripts/rehearse.mjs Report-back comment names run_in_background and drops the crossSessionInbound-accept sentence", () => {
    expect(rs).toBeGreaterThanOrEqual(0);
    expect(comment).toContain("run_in_background");
    expect(comment).not.toMatch(/unless the user sets crossSessionInbound/);
    expect(comment).not.toMatch(/crossSessionInbound to "accept"/);
  });
});
