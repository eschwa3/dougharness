// Core of the e2e replay harness (docs/specs/ci-e2e/architecture.md 5.1): the invocation parser, step picker,
// stream builder, Stop-hook runner and findings writer in tests/replay/, and the fake claude binary itself.
// The fake is pointed at a scenario module of this file's own through DOUG_REPLAY_SCENARIO_FILE, so no scenario
// file under tests/replay/scenarios/ is needed. Child processes go through the async `run`; findings paths are
// temp dirs, never the repository's .doug/.state.
import { describe, it, expect, afterAll, vi } from "vitest";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { cleanEnv } from "../scripts/rehearse-lib.mjs";
import { run, trackedTempDir, tempDirs } from "./rehearse-fixtures.mjs";
import { FAKE, REPLAY_DIR, Stream, envelope, pickStep, readInvocation, withStage } from "./replay/lib.mjs";
import { FINDINGS_FILE, finding, recordFindings, slug } from "./replay/findings.mjs";

vi.setConfig({ testTimeout: 600_000, hookTimeout: 600_000 });
afterAll(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

const LIB_URL = pathToFileURL(join(REPLAY_DIR, "lib.mjs")).href;
const FINDINGS_URL = pathToFileURL(join(REPLAY_DIR, "findings.mjs")).href;

// Runs `body` (an async function body) in a child node process with the given module namespaces bound, and
// resolves the JSON it prints. Keeps the test process free of sync spawns.
async function inChild(body, { env = cleanEnv() } = {}) {
  const code = `import * as lib from ${JSON.stringify(LIB_URL)};\nimport * as findings from ${JSON.stringify(FINDINGS_URL)};\nconst out = await (async () => {\n${body}\n})();\nprocess.stdout.write(JSON.stringify(out ?? null));`;
  const r = await run(process.execPath, ["--input-type=module", "-e", code], { env });
  if (r.status !== 0) throw new Error(`child failed (${r.status}): ${r.stderr}`);
  return JSON.parse(r.stdout);
}

// Like `run`, with a stdin.
function runWithInput(bin, args, { cwd, env, input = "" }) {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (d) => (stdout += d));
    child.stderr.setEncoding("utf8").on("data", (d) => (stderr += d));
    child.on("close", (status, signal) => resolve({ status, signal, stdout, stderr }));
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

describe("readInvocation", () => {
  it("session mode: the prompt is the token after -p", () => {
    const inv = readInvocation(["-p", "/doug-next fix-hours", "--output-format", "stream-json", "--max-turns", "12"], "ignored");
    expect(inv).toEqual({ mode: "session", prompt: "/doug-next fix-hours", schema: null, maxTurns: 12 });
  });
  it("command mode: -p followed by a flag; the prompt is stdin and the schema is parsed", () => {
    const schema = { type: "object", properties: { lessons: { type: "array" } } };
    const inv = readInvocation(["-p", "--output-format", "json", "--json-schema", JSON.stringify(schema), "--model", "haiku"], "You are proposing at most 3 lessons");
    expect(inv.mode).toBe("command");
    expect(inv.prompt).toBe("You are proposing at most 3 lessons");
    expect(inv.schema).toEqual(schema);
    expect(inv.maxTurns).toBeNull();
  });
  it("command mode: no token after -p", () => {
    expect(readInvocation(["-p"], "from stdin")).toMatchObject({ mode: "command", prompt: "from stdin" });
  });
  it("an unparsable --json-schema gives a null schema", () => {
    expect(readInvocation(["-p", "--json-schema", "{nope"], "x").schema).toBeNull();
  });
});

describe("pickStep and withStage", () => {
  const steps = [
    { stage: "gate", match: /^\/doug-next \S+$/ },
    { stage: "build", match: "I answered Start" },
    { stage: "other", match: "never matches" },
  ];
  it("a string match is an includes", () => {
    expect(pickStep(steps, "/doug-next fix-hours\n\nI answered Start").stage).toBe("build");
  });
  it("a RegExp match is a test", () => {
    expect(pickStep(steps, "/doug-next fix-hours").stage).toBe("gate");
  });
  it("zero hits give the error", () => {
    expect(pickStep(steps, "something else")).toEqual({ error: "replay: no unique step for prompt" });
  });
  it("two hits give the error", () => {
    const two = [{ stage: "a", match: "foo" }, { stage: "b", match: /fo+/ }];
    expect(pickStep(two, "a foo b")).toEqual({ error: "replay: no unique step for prompt" });
  });
  it("withStage returns a patched copy and throws on an unknown stage", () => {
    const patched = withStage(steps, "build", { fail: 1 });
    expect(patched.find((s) => s.stage === "build").fail).toBe(1);
    expect(steps.find((s) => s.stage === "build").fail).toBeUndefined();
    expect(patched.find((s) => s.stage === "gate")).toBe(steps[0]);
    expect(() => withStage(steps, "nope", {})).toThrow(/nope/);
  });
});

describe("Stream", () => {
  it("init comes first, result last, parent is null by default, agent carries subagent_type", () => {
    const s = new Stream();
    s.init();
    const id = s.toolUse("Edit", { file_path: "/x/y" });
    s.toolResult(id, "ok");
    s.agent("doug-flow:spec-writer");
    s.toolUse("Bash", { command: "ls" }, { parent: "toolu_parent" });
    s.result();
    const lines = s.text().trim().split("\n").map((l) => JSON.parse(l));
    expect(lines[0]).toMatchObject({ type: "system", subtype: "init" });
    expect(lines[0].plugins.map((p) => p.name)).toEqual(["doug-flow", "doug-gates"]);
    expect(lines[0].slash_commands).toEqual([]);
    expect(lines.at(-1)).toMatchObject({ type: "result", total_cost_usd: 0 });
    const use = (n) => lines.find((l) => l.type === "assistant" && l.message.content[0].name === n);
    expect(use("Edit").parent_tool_use_id).toBeNull();
    expect(use("Edit").message.content[0].id).toBe(id);
    expect(lines.find((l) => l.type === "user").message.content[0].tool_use_id).toBe(id);
    expect(use("Agent").message.content[0].input.subagent_type).toBe("doug-flow:spec-writer");
    expect(use("Bash").parent_tool_use_id).toBe("toolu_parent");
  });
  it("init takes plugins and slash commands; result takes cost and text", () => {
    const s = new Stream();
    s.init({ plugins: ["a"], slashCommands: ["doug-flow:doug-next"] });
    s.result({ cost: 0.5, text: "fin" });
    const [init, result] = s.text().trim().split("\n").map((l) => JSON.parse(l));
    expect(init.plugins).toHaveLength(1);
    expect(init.slash_commands).toEqual(["doug-flow:doug-next"]);
    expect(result).toMatchObject({ total_cost_usd: 0.5, result: "fin" });
  });
  it("mirrors every line to its file, which lives under os.tmpdir() by default", () => {
    const s = new Stream();
    s.init();
    s.result();
    expect(readFileSync(s.path, "utf8")).toBe(s.text());
    expect(s.path.startsWith(tmpdir())).toBe(true);
    expect(new Stream().text()).toBe("");
  });
});

describe("envelope", () => {
  it("is one result JSON carrying structured_output.<key>", () => {
    const e = JSON.parse(envelope("lessons", [{ id: 1 }], { reviews: [] }));
    expect(e).toMatchObject({ type: "result", is_error: false, total_cost_usd: 0, session_id: "replay" });
    expect(e.structured_output).toEqual({ lessons: [{ id: 1 }], reviews: [] });
  });
});

describe("runStopHooks", () => {
  function project(commands) {
    const dir = trackedTempDir("replay-stop-");
    mkdirSync(join(dir, ".claude"), { recursive: true });
    writeFileSync(join(dir, ".claude/settings.json"), JSON.stringify({ hooks: { Stop: [{ hooks: commands.map((command) => ({ type: "command", command })) }] } }));
    return dir;
  }
  const call = (dir) => inChild(`return lib.runStopHooks(${JSON.stringify(dir)}, { sessionId: "sess-1", transcriptPath: "/tmp/t.jsonl" });`);

  it("allows when the stub prints nothing", async () => {
    expect(await call(project(["true"]))).toEqual({ blocked: false, reason: null, ran: 1 });
  });
  it("allows when no settings file exists", async () => {
    expect(await call(trackedTempDir("replay-stop-none-"))).toEqual({ blocked: false, reason: null, ran: 0 });
  });
  it("blocks on a last stdout line with decision block", async () => {
    const r = await call(project([`echo noise; echo '{"decision":"block","reason":"tests are red"}'`]));
    expect(r).toEqual({ blocked: true, reason: "tests are red", ran: 1 });
  });
  it("blocks on exit 2 and carries stderr", async () => {
    const r = await call(project(["echo gate refused >&2; exit 2"]));
    expect(r.blocked).toBe(true);
    expect(r.reason).toContain("gate refused");
  });
  it("does not block on another non-zero exit", async () => {
    expect((await call(project(["exit 1"]))).blocked).toBe(false);
  });
  it("stops at the first block; later commands do not run", async () => {
    const dir = project([`echo '{"decision":"block","reason":"r"}'`, "touch ran-second"]);
    const r = await call(dir);
    expect(r.ran).toBe(1);
    expect(existsSync(join(dir, "ran-second"))).toBe(false);
  });
  it("sets CLAUDE_PROJECT_DIR over a stale one and sends every payload field on stdin, with cwd the project", async () => {
    const dir = project(["cat > payload.json; printf %s \"$CLAUDE_PROJECT_DIR\" > env.txt; pwd -P > cwd.txt"]);
    const r = await inChild(`return lib.runStopHooks(${JSON.stringify(dir)}, { sessionId: "sess-1", transcriptPath: "/tmp/t.jsonl" });`, {
      env: { ...cleanEnv(), CLAUDE_PROJECT_DIR: "/stale/dir" },
    });
    expect(r.blocked).toBe(false);
    expect(readFileSync(join(dir, "env.txt"), "utf8")).toBe(dir);
    expect(readFileSync(join(dir, "cwd.txt"), "utf8").trim()).toBe(realpathSync(dir));
    expect(JSON.parse(readFileSync(join(dir, "payload.json"), "utf8"))).toEqual({
      session_id: "sess-1",
      cwd: dir,
      hook_event_name: "Stop",
      stop_hook_active: false,
      transcript_path: "/tmp/t.jsonl",
    });
  });
});

describe("tests/replay/claude", () => {
  const scenarioSrc = `
export const steps = [
  { stage: "one", match: "PROMPT-ONE",
    run: ({ stream }) => { stream.agent("doug-flow:spec-writer"); },
    fail: ({ stream }) => { stream.toolUse("Bash", { command: "echo failing" }); } },
  { stage: "cmd", match: "COMMAND-PROMPT",
    envelope: () => '{"type":"result","structured_output":{"lessons":[]}}',
    fail: () => '{"type":"result","is_error":false}' },
];
`;
  function setup({ stopCommand = null } = {}) {
    const root = trackedTempDir("replay-fake-");
    const scenario = join(root, "scenario.mjs");
    writeFileSync(scenario, scenarioSrc);
    const dir = join(root, "fixture");
    mkdirSync(join(dir, ".claude"), { recursive: true });
    const hooks = stopCommand ? { Stop: [{ hooks: [{ type: "command", command: stopCommand }] }] } : {};
    writeFileSync(join(dir, ".claude/settings.json"), JSON.stringify({ hooks }));
    const log = join(root, "replay.log");
    const env = cleanEnv({ DOUG_REPLAY_SCENARIO_FILE: scenario, DOUG_REPLAY_SCENARIO: "core-test", DOUG_REPLAY_LOG: log });
    delete env.DOUG_REPLAY_FAIL;
    return { root, dir, log, env, scenario };
  }

  it("has mode 755", () => {
    expect(statSync(FAKE).mode & 0o777).toBe(0o755);
  });
  it("exits 3 with nothing on stdout when no step matches the prompt", async () => {
    const { dir, env } = setup();
    const r = await run(FAKE, ["-p", "NO SUCH PROMPT"], { cwd: dir, env });
    expect(r.status).toBe(3);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("replay: no unique step for prompt");
  });
  it("exits 3 with nothing on stdout when the scenario file is missing", async () => {
    const { dir, env } = setup();
    const r = await run(FAKE, ["-p", "PROMPT-ONE"], { cwd: dir, env: { ...env, DOUG_REPLAY_SCENARIO_FILE: join(dir, "absent.mjs") } });
    expect(r.status).toBe(3);
    expect(r.stdout).toBe("");
  });
  it("a session step prints init first and the result last, and exits 0", async () => {
    const { dir, env } = setup();
    const r = await run(FAKE, ["-p", "PROMPT-ONE", "--output-format", "stream-json"], { cwd: dir, env });
    expect(r.status).toBe(0);
    const lines = r.stdout.trim().split("\n").map((l) => JSON.parse(l));
    expect(lines[0]).toMatchObject({ type: "system", subtype: "init" });
    expect(lines.at(-1)).toMatchObject({ type: "result", total_cost_usd: 0 });
    expect(JSON.stringify(lines)).toContain("doug-flow:spec-writer");
  });
  it("DOUG_REPLAY_FAIL equal to the stage runs the fail variant", async () => {
    const { dir, env } = setup();
    const r = await run(FAKE, ["-p", "PROMPT-ONE"], { cwd: dir, env: { ...env, DOUG_REPLAY_FAIL: "one" } });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("echo failing");
    expect(r.stdout).not.toContain("spec-writer");
  });
  it("DOUG_REPLAY_FAIL naming another stage leaves the run variant", async () => {
    const { dir, env } = setup();
    const r = await run(FAKE, ["-p", "PROMPT-ONE"], { cwd: dir, env: { ...env, DOUG_REPLAY_FAIL: "cmd" } });
    expect(r.stdout).toContain("spec-writer");
  });
  it("a Stop block logs the reason, prints no stream and ends the process by SIGTERM", async () => {
    const { dir, env, log } = setup({ stopCommand: `echo '{"decision":"block","reason":"red tree"}'` });
    const r = await run(FAKE, ["-p", "PROMPT-ONE"], { cwd: dir, env });
    expect(r.signal).toBe("SIGTERM");
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("red tree");
    expect(readFileSync(log, "utf8")).toContain("red tree");
  });
  it("the Stop hook sees the session id, the fixture as cwd and a transcript outside the fixture", async () => {
    const { dir, env } = setup({ stopCommand: "cat > payload.json" });
    const r = await run(FAKE, ["-p", "PROMPT-ONE"], { cwd: dir, env });
    expect(r.status).toBe(0);
    const payload = JSON.parse(readFileSync(join(dir, "payload.json"), "utf8"));
    expect(payload.hook_event_name).toBe("Stop");
    expect(relative(dir, payload.transcript_path).startsWith("..")).toBe(true);
    expect(existsSync(payload.transcript_path)).toBe(true);
  });
  it("command mode reads the prompt from stdin, prints the envelope and runs no Stop hook", async () => {
    const { dir, env } = setup({ stopCommand: "touch stop-ran; exit 2" });
    const args = ["-p", "--output-format", "json", "--json-schema", "{}"];
    const r = await runWithInput(FAKE, args, { cwd: dir, env, input: "COMMAND-PROMPT and more" });
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).structured_output).toEqual({ lessons: [] });
    expect(existsSync(join(dir, "stop-ran"))).toBe(false);
    const failed = await runWithInput(FAKE, args, { cwd: dir, env: { ...env, DOUG_REPLAY_FAIL: "cmd" }, input: "COMMAND-PROMPT" });
    expect(JSON.parse(failed.stdout).structured_output).toBeUndefined();
  });
  it("is a node script with a shebang and no extension", () => {
    expect(readFileSync(FAKE, "utf8").startsWith("#!/usr/bin/env node")).toBe(true);
    expect(dirname(FAKE)).toBe(REPLAY_DIR);
  });
});

describe("findings", () => {
  const findingsFile = () => join(trackedTempDir("replay-findings-"), "e2e", "findings.json");
  const sample = (over = {}) =>
    finding({ scenario: "hand", stage: "gate", message: "failed", kind: "replay-failed", suspect: "either", replayFile: "f.mjs", reproduce: "r", source: "a.test.mjs", ...over });

  it("slug is stable across messages that differ only in a sha, a temp path or digits", () => {
    const a = slug("commit 3f9a1c2b7e4d landed at /var/folders/xy/T/doug-rehearse-hand-123/src after 12 tries");
    const b = slug("commit 0a1b2c3d4e5f landed at /tmp/other/path/here after 7 tries");
    expect(a).toBe(b);
    expect(a).toMatch(/^[a-z-]+$/);
    expect(slug("x".repeat(200)).length).toBeLessThanOrEqual(60);
    expect(slug("The Build Stage FAILED!")).toBe("the-build-stage-failed");
    expect(slug("commit abcdefabcdef failed")).toBe(slug("commit fedcbafedcba failed"));
  });
  it("finding carries the 4.3 shape", () => {
    const f = sample({ message: "no spawn at /tmp/abc/def" });
    expect(Object.keys(f).sort()).toEqual(["assertion", "at", "commit", "key", "kind", "message", "reproduce", "replayFile", "scenario", "source", "stage", "suspect"].sort());
    expect(f.key).toBe(`hand/gate/${slug("no spawn at /tmp/abc/def")}`);
    expect(f.assertion).toBe(slug(f.message));
    expect(f.commit).toMatch(/^[0-9a-f]{40}(-dirty)?$|^unknown$/);
  });
  it("the default findings file is under the repository's .doug/.state/e2e", () => {
    expect(FINDINGS_FILE.endsWith(join(".doug", ".state", "e2e", "findings.json"))).toBe(true);
  });
  it("creates the file and its directory, and drops a source's old entries", () => {
    const file = findingsFile();
    recordFindings("a.test.mjs", [sample({ stage: "old1" }), sample({ stage: "old2" })], { file });
    recordFindings("b.test.mjs", [sample({ source: "b.test.mjs", stage: "keep" })], { file });
    recordFindings("a.test.mjs", [sample({ stage: "new" })], { file });
    const got = JSON.parse(readFileSync(file, "utf8"));
    expect(got.map((f) => f.stage).sort()).toEqual(["keep", "new"]);
    recordFindings("a.test.mjs", [], { file });
    expect(JSON.parse(readFileSync(file, "utf8")).map((f) => f.stage)).toEqual(["keep"]);
    expect(existsSync(`${file}.lock`)).toBe(false);
  });
  it("a corrupt file is replaced without a throw", () => {
    const file = findingsFile();
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, "{not json");
    expect(() => recordFindings("a.test.mjs", [sample()], { file })).not.toThrow();
    expect(JSON.parse(readFileSync(file, "utf8"))).toHaveLength(1);
  });
  it("two concurrent recordFindings lose no entry", async () => {
    const file = findingsFile();
    const call = (source, n) =>
      inChild(`
        for (let i = 0; i < ${n}; i++) {
          const f = findings.finding({ scenario: "s", stage: "${source}-" + i, message: "m", kind: "replay-failed", source: "${source}" });
          findings.recordFindings("${source}-" + i, [f], { file: ${JSON.stringify(file)} });
        }
        return true;`);
    await Promise.all([call("p", 12), call("q", 12)]);
    const got = JSON.parse(readFileSync(file, "utf8"));
    expect(got).toHaveLength(24);
    expect(new Set(got.map((f) => f.stage)).size).toBe(24);
  });
  it("a held lock times out at 10 s with no throw", async () => {
    const file = findingsFile();
    mkdirSync(dirname(file), { recursive: true });
    mkdirSync(`${file}.lock`);
    const t0 = Date.now();
    await inChild(`findings.recordFindings("a.test.mjs", [findings.finding({ scenario: "s", stage: "t", message: "m", kind: "replay-failed", source: "a.test.mjs" })], { file: ${JSON.stringify(file)} }); return true;`);
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeGreaterThanOrEqual(9_500);
    expect(elapsed).toBeLessThan(30_000);
    expect(existsSync(`${file}.lock`)).toBe(true);
  });
});

describe("writeWorkflowOutput", () => {
  it("reads the per-card plan, uses the plan's integration worktree, and names the hand report card-report.json", async () => {
    const dir = trackedTempDir("replay-wwo-");
    const out = await inChild(`
      const { execFileSync } = await import("node:child_process");
      const fs = await import("node:fs");
      const g = (...a) => execFileSync("git", a, { cwd: ${JSON.stringify(dir)}, encoding: "utf8" });
      g("init", "-q", "-b", "main"); g("config", "user.email", "t@t"); g("config", "user.name", "t");
      fs.mkdirSync(${JSON.stringify(dir)} + "/.doug/plans", { recursive: true });
      for (const id of ["c1", "c2"]) {
        fs.writeFileSync(${JSON.stringify(dir)} + "/.doug/plans/" + id + ".json", JSON.stringify({ card: id, integrationWorktree: ".claude/worktrees/int-" + id, tasks: [{ id: "t-" + id }] }));
      }
      fs.writeFileSync(${JSON.stringify(dir)} + "/a.txt", "a"); g("add", "-A"); g("commit", "-q", "-m", "init");
      const s = new lib.Stream();
      const a = lib.writeWorkflowOutput(${JSON.stringify(dir)}, s, { kind: "queen", cardId: "c1", report: {} });
      const b = lib.writeWorkflowOutput(${JSON.stringify(dir)}, s, { kind: "card-queen", cardId: "c2", report: {} });
      return { a: a.reportPath, b: b.reportPath };`);
    expect(out.a.endsWith("reports/c1/last-report.json")).toBe(true);
    expect(out.b.endsWith("reports/c2/card-report.json")).toBe(true);
    expect(existsSync(join(dir, ".claude/worktrees/int-c1"))).toBe(true);
    expect(existsSync(join(dir, ".claude/worktrees/int-c2"))).toBe(true);
  });

  it("merges into an integration branch and worktree that already exist", async () => {
    const dir = trackedTempDir("replay-wwo-exist-");
    const out = await inChild(`
      const { execFileSync } = await import("node:child_process");
      const fs = await import("node:fs");
      const g = (...a) => execFileSync("git", a, { cwd: ${JSON.stringify(dir)}, encoding: "utf8" });
      g("init", "-q", "-b", "main"); g("config", "user.email", "t@t"); g("config", "user.name", "t");
      fs.mkdirSync(${JSON.stringify(dir)} + "/.doug", { recursive: true });
      fs.writeFileSync(${JSON.stringify(dir)} + "/.doug/plan.json", JSON.stringify({ integrationBranch: "doug/existing", integrationWorktree: ".claude/worktrees/int", tasks: [{ id: "t1" }] }));
      fs.writeFileSync(${JSON.stringify(dir)} + "/a.txt", "a"); g("add", "-A"); g("commit", "-q", "-m", "init");
      g("worktree", "add", "-q", "-b", "doug/existing", ".claude/worktrees/int", "HEAD");
      const s = new lib.Stream();
      const r = lib.writeWorkflowOutput(${JSON.stringify(dir)}, s, { kind: "implement", fix: (wt) => fs.writeFileSync(wt + "/b.txt", "b"), report: {} });
      return { branch: r.branch, report: r.reportPath };`);
    expect(out.branch).toBe("doug/existing");
    expect(existsSync(join(dir, ".claude/worktrees/int/b.txt"))).toBe(true);
    expect(existsSync(out.report)).toBe(true);
  });
});
