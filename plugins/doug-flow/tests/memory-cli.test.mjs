import { describe, it, expect } from "vitest";
import { spawnSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, chmodSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { projectSlug } from "../lib/cost.mjs";
import { openMemory, addLesson, setLessonEmbedding, conditionConfigHash, recordOutcomes, handOutcomeRow } from "../lib/memory.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, "..", "scripts", "memory.mjs");
const fixtureClaude = join(here, "fixtures", "claude");
const fixtureReport = join(here, "fixtures", "reports", "memory-record.json");

const run = (args, cwd) => spawnSync(process.execPath, [script, ...args], { cwd, encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: "" } });

// spawnSync blocks this process's event loop until the child exits, so a fake HTTP server hosted in this same
// test process can never answer a request from that child (it would deadlock waiting on itself). The provider
// tests below host a fake server here and need the CLI child to reach it, so they use this async variant
// instead, which does not block the event loop.
function runAsync(args, cwd, extraEnv = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [script, ...args], { cwd, env: { ...process.env, CLAUDE_PROJECT_DIR: "", ...extraEnv } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (status) => resolvePromise({ status, stdout, stderr }));
  });
}

function tempDir() {
  return mkdtempSync(join(tmpdir(), "doug-memory-cli-"));
}

function writeMemoryConfig(dir, embeddings) {
  mkdirSync(join(dir, ".doug"), { recursive: true });
  writeFileSync(join(dir, ".doug", "config.json"), JSON.stringify({ memory: { embeddings } }), "utf8");
}

// A tiny stand-in Ollama/OpenAI-compatible server: /api/version, /api/tags, and /v1/embeddings. Each input text
// is looked up in `vectorsByText` (exact match); a text not in that map falls back to the old fixed vector
// (dims taken from the request, [1, 0, 0, ...]) — so every existing caller that never registers a vector keeps
// getting the same fixed vector for everything, and a card memory-measure test can register real per-text
// vectors for a cosine sanity check to score.
function startFakeOllama(vectorsByText = {}, { port = 0, failOn = null } = {}) {
  const server = createServer((req, res) => {
    if (req.url === "/api/version") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ version: "0.30.10" }));
      return;
    }
    if (req.url === "/api/tags") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ models: [{ name: "embeddinggemma:latest", model: "embeddinggemma:latest" }] }));
      return;
    }
    if (req.url === "/v1/embeddings") {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (failOn && body.input.some((t) => t.includes(failOn))) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end("{}");
          return;
        }
        const dims = body.dimensions || 4;
        const fixed = Array.from({ length: dims }, (_, j) => (j === 0 ? 1 : 0));
        const data = body.input.map((text, i) => ({ index: i, embedding: vectorsByText[text] || fixed }));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data }));
      });
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end("{}");
  });
  return new Promise((resolveReady) => server.listen(port, "127.0.0.1", () => resolveReady(server)));
}

// Card recall-fallback-warning (D2): with no provider configured, the CLI probes for a local Ollama (default
// http://localhost:11434). A test never reaches a real Ollama: the probe's base URL is overridden with
// DOUG_OLLAMA_BASE_URL (the one new interface these tests pin) and pointed at a server the test owns.
function listenForProbe(handler) {
  return new Promise((resolveReady) => {
    const server = createServer(handler);
    server.listen(0, "127.0.0.1", () => resolveReady(server));
  });
}
const probeEnv = (server) => ({ DOUG_OLLAMA_BASE_URL: `http://127.0.0.1:${server.address().port}` });
const nothingThereHandler = (req, res) => {
  res.writeHead(404, { "content-type": "application/json" });
  res.end("{}");
};
function fakeOllamaHandler(req, res) {
  if (req.url === "/api/version") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ version: "0.30.10" }));
  } else if (req.url === "/api/tags") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ models: [{ name: "embeddinggemma:latest", model: "embeddinggemma:latest" }] }));
  } else {
    res.writeHead(404);
    res.end("{}");
  }
}
const stderrLines = (res) => res.stderr.split("\n");

// A valid 12+12 sanity pairs file for `embed-check`/`reembed --pairs`. Sentence text doubles as the fake
// server's lookup key: each pair's cosine is controlled directly via `vectorsByText`, so tests never depend on
// the repo's own plugins/doug-flow/lib/data/pairs.json. `overrides` lets one test bend a single sentence's
// vector to force a specific pair's score.
function writeSanityPairsFixture(dir, { margin = 0.15, paraphraseCosine = 0.9, unrelatedCosine = 0.1, overrides = {} } = {}) {
  const paraphrase = [];
  const unrelated = [];
  const vectorsByText = {};
  const b = (cos) => [cos, Math.sqrt(Math.max(0, 1 - cos * cos))];
  for (let i = 0; i < 12; i++) {
    const [sa, sb] = [`sanity paraphrase ${i} a`, `sanity paraphrase ${i} b`];
    paraphrase.push([sa, sb]);
    vectorsByText[sa] = [1, 0];
    vectorsByText[sb] = b(paraphraseCosine);
  }
  for (let i = 0; i < 12; i++) {
    const [sa, sb] = [`sanity unrelated ${i} a`, `sanity unrelated ${i} b`];
    unrelated.push([sa, sb]);
    vectorsByText[sa] = [0, 1];
    vectorsByText[sb] = [Math.sqrt(Math.max(0, 1 - unrelatedCosine * unrelatedCosine)), unrelatedCosine];
  }
  Object.assign(vectorsByText, overrides);
  const file = join(dir, "sanity-pairs.json");
  writeFileSync(file, JSON.stringify({ margin, paraphrase, unrelated }), "utf8");
  return { file, vectorsByText };
}

function serverBaseUrl(server) {
  return `http://127.0.0.1:${server.address().port}`;
}

// A fake `claude` binary for `reflect`'s propose spawn: a shebang node script that asserts --json-schema and
// --model were passed and the prompt landed on stdin, then prints the given envelope verbatim as its one line
// of stdout — exactly the shape runReflect's real propose parses (structured_output, session_id, total_cost_usd).
function writeFakeClaudeSuccess(dir, envelope) {
  const scriptPath = join(dir, "fake-claude-success.mjs");
  const body =
    "#!/usr/bin/env node\n" +
    'import { readFileSync } from "node:fs";\n' +
    "const args = process.argv.slice(2);\n" +
    'const stdin = readFileSync(0, "utf8");\n' +
    'if (!args.includes("--json-schema")) { process.stderr.write("fake-claude: missing --json-schema\\n"); process.exit(3); }\n' +
    'if (!args.includes("--model")) { process.stderr.write("fake-claude: missing --model\\n"); process.exit(3); }\n' +
    'if (!stdin || !stdin.trim()) { process.stderr.write("fake-claude: empty prompt on stdin\\n"); process.exit(3); }\n' +
    `process.stdout.write(${JSON.stringify(JSON.stringify(envelope))});\n`;
  writeFileSync(scriptPath, body, "utf8");
  chmodSync(scriptPath, 0o755);
  return scriptPath;
}

// A fake `claude` that prints a notice line before the JSON envelope and another line after it (minor 3): the
// real `claude -p --output-format json` contract says one JSON object, but a stray notice/warning line landing
// on stdout around it is exactly what the last-balanced-object parser exists to tolerate.
function writeFakeClaudeWithNoise(dir, envelope) {
  const scriptPath = join(dir, "fake-claude-noisy.mjs");
  const body =
    "#!/usr/bin/env node\n" +
    'import { readFileSync } from "node:fs";\n' +
    "const args = process.argv.slice(2);\n" +
    'const stdin = readFileSync(0, "utf8");\n' +
    'if (!args.includes("--json-schema")) { process.stderr.write("fake-claude: missing --json-schema\\n"); process.exit(3); }\n' +
    'if (!args.includes("--model")) { process.stderr.write("fake-claude: missing --model\\n"); process.exit(3); }\n' +
    'if (!stdin || !stdin.trim()) { process.stderr.write("fake-claude: empty prompt on stdin\\n"); process.exit(3); }\n' +
    'process.stdout.write("Notice: a curly brace in this line { does not open anything }\\n");\n' +
    `process.stdout.write(${JSON.stringify(JSON.stringify(envelope))} + "\\n");\n` +
    'process.stdout.write("(trailing notice line after the envelope)\\n");\n';
  writeFileSync(scriptPath, body, "utf8");
  chmodSync(scriptPath, 0o755);
  return scriptPath;
}

// A fake `claude` that writes the prompt it received (stdin) to promptFile before answering with the envelope,
// so a test can assert what the reflect prompt actually carried (card worker-context-handoff: the per-task
// partial= line and the no-blame rule).
function writeFakeClaudeCapturingPrompt(dir, envelope, promptFile) {
  const scriptPath = join(dir, "fake-claude-capture.mjs");
  const body =
    "#!/usr/bin/env node\n" +
    'import { readFileSync, writeFileSync } from "node:fs";\n' +
    "const args = process.argv.slice(2);\n" +
    'const stdin = readFileSync(0, "utf8");\n' +
    `writeFileSync(${JSON.stringify(promptFile)}, stdin, "utf8");\n` +
    'if (!args.includes("--json-schema")) { process.stderr.write("fake-claude: missing --json-schema\\n"); process.exit(3); }\n' +
    'if (!args.includes("--model")) { process.stderr.write("fake-claude: missing --model\\n"); process.exit(3); }\n' +
    `process.stdout.write(${JSON.stringify(JSON.stringify(envelope))});\n`;
  writeFileSync(scriptPath, body, "utf8");
  chmodSync(scriptPath, 0o755);
  return scriptPath;
}

// A fake `claude` that prints unparseable stdout, the "prints garbage" failure case.
function writeFakeClaudeGarbage(dir) {
  const scriptPath = join(dir, "fake-claude-garbage.mjs");
  const body = "#!/usr/bin/env node\nprocess.stdout.write('not valid json at all');\n";
  writeFileSync(scriptPath, body, "utf8");
  chmodSync(scriptPath, 0o755);
  return scriptPath;
}

// A transcript at the path runReflect's cost measurement reads: <claudeDir>/projects/<projectSlug(dir)>/<sessionId>.jsonl,
// one assistant message line in the shape transcriptUsage parses (plugins/doug-flow/tests/cost.test.mjs).
function writeFakeReflectTranscript(claudeDir, dir, sessionId, { model = "claude-haiku-4-5", input = 1000, output = 500 } = {}) {
  const projDir = join(claudeDir, "projects", projectSlug(dir));
  mkdirSync(projDir, { recursive: true });
  const file = join(projDir, `${sessionId}.jsonl`);
  const line = JSON.stringify({
    type: "assistant",
    message: { id: "msg_1", model, usage: { input_tokens: input, output_tokens: output, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
  });
  writeFileSync(file, line + "\n", "utf8");
  return file;
}

describe("memory.mjs reflect", () => {
  it("spawns --claude-bin with --json-schema, --model, and the prompt on stdin, appends the proposed lesson, and prices it from a matching transcript (usd_source transcript)", () => {
    const dir = tempDir();
    const claudeDir = tempDir();
    const sessionId = "sess-reflect-1";
    writeFakeReflectTranscript(claudeDir, dir, sessionId, { model: "claude-haiku-4-5", input: 1000, output: 500 });
    const claudeBin = writeFakeClaudeSuccess(dir, {
      structured_output: {
        lessons: [
          {
            kind: "pitfall",
            text: "The adversary needs owned files listed exactly or retriable checks fail silently",
            citation: "report:agents-generator/F1",
            task: "agents-generator",
            notDerivableBecause: "not written anywhere in the repo today",
          },
        ],
      },
      session_id: sessionId,
      total_cost_usd: 0.02,
      is_error: false,
    });
    const res = run(["reflect", fixtureReport, dir, "--adversary", "F1=real: confirmed by fix", "--claude-bin", claudeBin, "--claude-dir", claudeDir], dir);
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toContain("appended 1");
    expect(res.stdout).toContain("(transcript)");

    const rows = JSON.parse(run(["lessons", dir, "--json"], dir).stdout);
    expect(rows).toHaveLength(1);
    expect(rows[0].source_agent).toBe("reflect");
    expect(rows[0].task).toBe("agents-generator");
    rmSync(dir, { recursive: true, force: true });
    rmSync(claudeDir, { recursive: true, force: true });
  });

  it("carries partial= per task and the no-blame rule in the prompt sent to the model (card worker-context-handoff)", () => {
    const dir = tempDir();
    const promptFile = join(dir, "prompt.txt");
    const claudeBin = writeFakeClaudeCapturingPrompt(dir, { structured_output: { lessons: [] }, session_id: "sess-partial", total_cost_usd: 0.01, is_error: false }, promptFile);
    const res = run(["reflect", fixtureReport, dir, "--claude-bin", claudeBin], dir);
    expect(res.status, res.stderr).toBe(0);
    const prompt = readFileSync(promptFile, "utf8");
    expect(prompt).toMatch(/agents-generator: verified=true passes=2 stopReason=null partial=false/);
    expect(prompt).toContain("a task marked partial=true below ran out of context, not verification; propose no lesson that blames its code or its tests for that");
    rmSync(dir, { recursive: true, force: true });
  });

  // Card report-save-wrapper: reflect must also accept the same fixture report saved as the Workflow tool's own
  // output shape ({ summary, agentCount, logs, result: <report> }) - reflect is covered here since an existing
  // test (above) already drives it cheaply from a report file with a fake claude bin.
  it("reflect accepts a wrapped report the same as bare (same fixture report, wrapped)", () => {
    const dir = tempDir();
    const inner = JSON.parse(readFileSync(fixtureReport, "utf8"));
    const wrappedPath = join(dir, "wrapped-report.json");
    writeFileSync(wrappedPath, JSON.stringify({ summary: "x", agentCount: 1, logs: [], result: inner }));
    const promptFile = join(dir, "prompt.txt");
    const claudeBin = writeFakeClaudeCapturingPrompt(dir, { structured_output: { lessons: [] }, session_id: "sess-wrapped", total_cost_usd: 0.01, is_error: false }, promptFile);
    const res = run(["reflect", wrappedPath, dir, "--claude-bin", claudeBin], dir);
    expect(res.status, res.stderr).toBe(0);
    const prompt = readFileSync(promptFile, "utf8");
    expect(prompt).toMatch(/agents-generator: verified=true passes=2 stopReason=null partial=false/);
    rmSync(dir, { recursive: true, force: true });
  });

  it("parses the last balanced JSON object on stdout, tolerating a notice line printed before and after the envelope (minor 3)", () => {
    const dir = tempDir();
    const claudeBin = writeFakeClaudeWithNoise(dir, {
      structured_output: { lessons: [] },
      session_id: "sess-noisy",
      total_cost_usd: 0.01,
      is_error: false,
    });
    const res = run(["reflect", fixtureReport, dir, "--claude-bin", claudeBin], dir);
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toContain("proposed 0");
    rmSync(dir, { recursive: true, force: true });
  });

  it("falls back to the envelope's total_cost_usd (usd_source claude) when the transcript file cannot be found, printed to 4 decimals so a haiku-cheap pass never reads as $0.00 (minor 5)", () => {
    const dir = tempDir();
    const claudeBin = writeFakeClaudeSuccess(dir, { structured_output: { lessons: [] }, session_id: "sess-missing", total_cost_usd: 0.0043, is_error: false });
    const res = run(["reflect", fixtureReport, dir, "--claude-bin", claudeBin, "--claude-dir", join(dir, "no-such-claude-dir")], dir);
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toContain("$0.0043 (claude)");
    expect(res.stdout).not.toContain("$0.00 ");
    rmSync(dir, { recursive: true, force: true });
  });

  it("prints 'cost not measured' rather than a dollar figure when neither a transcript nor total_cost_usd is available (minor 5)", () => {
    const dir = tempDir();
    const claudeBin = writeFakeClaudeSuccess(dir, { structured_output: { lessons: [] }, session_id: null, is_error: false });
    const res = run(["reflect", fixtureReport, dir, "--claude-bin", claudeBin, "--claude-dir", join(dir, "no-such-claude-dir")], dir);
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toContain("cost not measured");
    expect(res.stdout).not.toContain("$null");
    rmSync(dir, { recursive: true, force: true });
  });

  it("exits 1 naming the failure when claude prints no parseable JSON, but the counters are still applied and committed", () => {
    const dir = tempDir();
    const claudeBin = writeFakeClaudeGarbage(dir);
    const res = run(["reflect", fixtureReport, dir, "--claude-bin", claudeBin], dir);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("reflect");
    expect(res.stderr.toLowerCase()).toMatch(/parseable json/);
    // a second reflect on the same report is a no-op only once a reflections row exists, proving the counters
    // pass committed despite the LLM pass failing.
    const second = run(["reflect", fixtureReport, dir, "--claude-bin", claudeBin], dir);
    expect(second.status, second.stderr).toBe(0);
    expect(second.stdout).toContain("Already reflected");
    rmSync(dir, { recursive: true, force: true });
  });

  it("--dry-run applies nothing (no reflections row, no lessons appended) but still runs the LLM pass and measures its cost", () => {
    const dir = tempDir();
    const claudeBin = writeFakeClaudeSuccess(dir, { structured_output: { lessons: [] }, session_id: "sess-dry", total_cost_usd: 0.02, is_error: false });
    const res = run(["reflect", fixtureReport, dir, "--claude-bin", claudeBin, "--dry-run"], dir);
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toContain("(dry run)");
    expect(res.stdout).toContain("$0.02");
    expect(JSON.parse(run(["lessons", dir, "--json"], dir).stdout)).toHaveLength(0);
    // proof no reflections row was written: a real reflect right after is not a no-op.
    const real = run(["reflect", fixtureReport, dir, "--claude-bin", claudeBin], dir);
    expect(real.status, real.stderr).toBe(0);
    expect(real.stdout).not.toContain("Already reflected");
    rmSync(dir, { recursive: true, force: true });
  });

  it("is a no-op on a second reflect of the same report, exit 0, and --json returns the stored row", () => {
    const dir = tempDir();
    const claudeBin = writeFakeClaudeSuccess(dir, { structured_output: { lessons: [] }, session_id: "sess-once", total_cost_usd: 0.01, is_error: false });
    const first = run(["reflect", fixtureReport, dir, "--claude-bin", claudeBin], dir);
    expect(first.status, first.stderr).toBe(0);
    const second = run(["reflect", fixtureReport, dir, "--claude-bin", claudeBin], dir);
    expect(second.status, second.stderr).toBe(0);
    expect(second.stdout).toContain("Already reflected");
    const json = run(["reflect", fixtureReport, dir, "--claude-bin", claudeBin, "--json"], dir);
    expect(json.status, json.stderr).toBe(0);
    expect(JSON.parse(json.stdout).report_hash).toBeTruthy();
    rmSync(dir, { recursive: true, force: true });
  });

  it("reflect --hand without a card id exits 2 with the hand usage, no longer refusing --hand outright (card memory-every-session)", () => {
    const dir = tempDir();
    const res = run(["reflect", "--hand"], dir);
    expect(res.status).toBe(2);
    expect(res.stderr).toContain("usage");
    expect(res.stderr).toContain("--hand");
    expect(res.stderr).toContain("--commit");
    expect(res.stderr).not.toContain("--hand is not accepted");
    rmSync(dir, { recursive: true, force: true });
  });

  it("exits 1 naming the report's blocks when --adversary names an id the report lacks", () => {
    const dir = tempDir();
    const claudeBin = writeFakeClaudeSuccess(dir, { structured_output: { lessons: [] }, session_id: "sess-badadv", total_cost_usd: 0, is_error: false });
    const res = run(["reflect", fixtureReport, dir, "--claude-bin", claudeBin, "--adversary", "F9=false"], dir);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("F1");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("memory.mjs reflect --hand", () => {
  const reportsDir = (dir, id = "c1") => join(dir, ".doug", ".state", "reports", id);
  const claudeOk = (dir, lessons, promptFile) => {
    const env = { structured_output: { lessons }, session_id: "sess-hand", total_cost_usd: 0.01, is_error: false };
    return promptFile ? writeFakeClaudeCapturingPrompt(dir, env, promptFile) : writeFakeClaudeSuccess(dir, env);
  };
  const proposal = (over = {}) => ({
    kind: "pattern",
    text: "uploads retry with jittered backoff",
    citation: "report:c1",
    task: "c1",
    notDerivableBecause: "learned only from this landing",
    ...over,
  });
  const helpfulOf = (dir, id) => {
    const m = openMemory(dir);
    try {
      const row = m.prepare("SELECT helpful FROM lessons WHERE id = ?").get(id);
      return row ? row.helpful : null;
    } finally {
      m.close();
    }
  };
  // Seeds one real lesson (L1), the saved hand inputs naming [L1, "lxunknown"], one brief, one review.
  function setup(dir, { brief = "BRIEF-BODY-MARKER the coder brief", review = "REVIEW-BODY-MARKER reviewer found nothing" } = {}) {
    const m = openMemory(dir);
    const L1 = addLesson(m, { kind: "pattern", source: { agent: "worker" }, text: "the first seeded lesson about uploads" }).id;
    m.close();
    const base = reportsDir(dir);
    mkdirSync(join(base, "briefs"), { recursive: true });
    mkdirSync(join(base, "reviews"), { recursive: true });
    writeFileSync(
      join(base, "lessons.json"),
      JSON.stringify({ card: "c1", query: "q", mode: "keyword", reason: null, ids: [L1, "lxunknown"], text: "x", recalledAt: "2026-10-07T00:00:00.000Z" }),
      "utf8"
    );
    writeFileSync(join(base, "briefs", "1-coder.md"), brief, "utf8");
    writeFileSync(join(base, "reviews", "1.md"), review, "utf8");
    return L1;
  }
  const reflect = (dir, claudeBin, extra = []) => run(["reflect", "--hand", "c1", dir, "--commit", "abc1234", "--claude-bin", claudeBin, ...extra], dir);

  it("c1: bumps helpful on the lessons.json ids that exist, ignores unknown ones, appends the proposal, writes the reflections row and hand-report.json", () => {
    const dir = tempDir();
    try {
      const L1 = setup(dir);
      const res = reflect(dir, claudeOk(dir, [proposal()]), ["--rounds", "1", "--note", "landed clean"]);
      expect(res.status, res.stderr).toBe(0);
      expect(helpfulOf(dir, L1)).toBe(1);
      expect(helpfulOf(dir, "lxunknown")).toBeNull();
      const lessons = JSON.parse(run(["lessons", dir, "--json"], dir).stdout);
      expect(lessons.filter((l) => l.source_agent === "reflect")).toHaveLength(1);
      const m = openMemory(dir);
      let rows;
      try {
        rows = m.prepare("SELECT * FROM reflections").all();
      } finally {
        m.close();
      }
      expect(rows).toHaveLength(1);
      expect(rows[0].card).toBe("c1");
      expect(rows[0].commit_sha).toBe("abc1234");
      const hr = JSON.parse(readFileSync(join(reportsDir(dir), "hand-report.json"), "utf8"));
      expect(hr.track).toBe("hand");
      expect(hr.commit).toBe("abc1234");
      expect(hr.levels[0].tasks[0].memoryUsed).toEqual([L1, "lxunknown"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("c2: the prompt carries the brief, the reviewer report, the note, and memoryUsed; a 6000-char brief is cut at 4000 with the truncation marker", () => {
    const dir = tempDir();
    try {
      const L1 = setup(dir, { brief: "§".repeat(6000) });
      const promptFile = join(dir, "prompt.txt");
      const res = reflect(dir, claudeOk(dir, [], promptFile), ["--note", "NOTE-MARKER-xyz"]);
      expect(res.status, res.stderr).toBe(0);
      const prompt = readFileSync(promptFile, "utf8");
      expect(prompt).toContain("REVIEW-BODY-MARKER");
      expect(prompt).toContain("NOTE-MARKER-xyz");
      expect(prompt).toContain(`memoryUsed: ${L1}`);
      expect(prompt).toContain("§".repeat(4000) + "…[truncated]");
      expect(prompt).not.toContain("§".repeat(4001));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("c3: five valid proposals append three and reject the rest with the cap reason", () => {
    const dir = tempDir();
    try {
      setup(dir);
      const texts = [
        "alpha uploads retry jittered backoff",
        "beta schema migrations need explicit rollback tests",
        "gamma fixtures isolate clock dependent assertions",
        "delta hooks must fail open on malformed stdin",
        "epsilon board edits never go through scripts",
      ];
      const res = reflect(dir, claudeOk(dir, texts.map((text) => proposal({ text }))), ["--json"]);
      expect(res.status, res.stderr).toBe(0);
      const out = JSON.parse(res.stdout);
      expect(out.appended).toHaveLength(3);
      expect(out.rejected).toHaveLength(2);
      for (const r of out.rejected) expect(r.reason).toBe("at most 3 lessons appended per reflection");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("c4: a pitfall needs a --review classed real; a pattern needs --rounds 1", () => {
    const pit = proposal({ kind: "pitfall", text: "pitfall about unbounded retry loops", citation: "report:c1/R1" });
    const cases = [
      { name: "pitfall without --review", props: [pit], extra: [], rejected: "has no block classed real" },
      { name: "pitfall with R1=false", props: [pit], extra: ["--rounds", "2", "--review", "R1=false: not a defect"], rejected: "has no block classed real" },
      { name: "pitfall with R1=real", props: [pit], extra: ["--rounds", "2", "--review", "R1=real: x"], rejected: null },
      { name: "pattern after 2 rounds", props: [proposal()], extra: ["--rounds", "2"], rejected: "did not verify on its first pass" },
    ];
    for (const c of cases) {
      const dir = tempDir();
      try {
        setup(dir);
        const res = reflect(dir, claudeOk(dir, c.props), ["--json", ...c.extra]);
        expect(res.status, `${c.name}: ${res.stderr}`).toBe(0);
        const out = JSON.parse(res.stdout);
        if (c.rejected) {
          expect(out.appended, c.name).toHaveLength(0);
          expect(out.rejected[0].reason, c.name).toContain(c.rejected);
        } else {
          expect(out.appended, c.name).toHaveLength(1);
          expect(out.rejected, c.name).toHaveLength(0);
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it("c5: a second identical run says Already reflected, exits 0, and bumps nothing again", () => {
    const dir = tempDir();
    try {
      const L1 = setup(dir);
      const bin = claudeOk(dir, [proposal()]);
      const first = reflect(dir, bin);
      expect(first.status, first.stderr).toBe(0);
      expect(helpfulOf(dir, L1)).toBe(1);
      const second = reflect(dir, bin);
      expect(second.status, second.stderr).toBe(0);
      expect(second.stdout).toContain("Already reflected");
      expect(helpfulOf(dir, L1)).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("c6: when the model pass fails the run exits 1 but the counters stand", () => {
    const dir = tempDir();
    try {
      const L1 = setup(dir);
      const bad = join(dir, "fail-claude.mjs");
      writeFileSync(bad, "#!/usr/bin/env node\nprocess.stderr.write('boom');\nprocess.exit(1);\n", "utf8");
      chmodSync(bad, 0o755);
      const res = reflect(dir, bad);
      expect(res.status).toBe(1);
      expect(helpfulOf(dir, L1)).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("c7: no --commit exits 2 with usage", () => {
    const dir = tempDir();
    try {
      setup(dir);
      const res = run(["reflect", "--hand", "c1", dir, "--claude-bin", claudeOk(dir, [])], dir);
      expect(res.status).toBe(2);
      expect(res.stderr).toContain("usage");
      expect(res.stderr).toContain("reflect --hand");
      expect(res.stderr).toContain("--commit");
      expect(existsSync(join(reportsDir(dir), "hand-report.json"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("memory.mjs record", () => {
  it("records a run's outcomes with cost, blocks, card, and commit, and is idempotent on a second record", () => {
    const dir = tempDir();
    const first = run(
      [
        "record",
        fixtureReport,
        dir,
        "--run",
        "wf_7092b963-6a5",
        "--claude-dir",
        fixtureClaude,
        "--card",
        "standard-agents",
        "--commit",
        "abc1234",
        "--adversary",
        "F1=real: confirmed by the fix commit",
      ],
      dir
    );
    expect(first.status, first.stderr).toBe(0);
    expect(first.stdout).toContain("Recorded 1 outcome(s) for wf_7092b963-6a5 in .doug/.state/memory/memory.db (1 new, 0 updated).");

    const listed = run(["outcomes", dir, "--json"], dir);
    expect(listed.status, listed.stderr).toBe(0);
    const rows = JSON.parse(listed.stdout);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.task).toBe("agents-generator");
    expect(row.run).toBe("wf_7092b963-6a5");
    expect(row.card).toBe("standard-agents");
    expect(row.commit_sha).toBe("abc1234");
    expect(row.fix_passes).toBe(1);
    expect(row.tokens).toEqual({
      input: 180,
      output: 26359,
      cacheRead: 1219887,
      cacheWrite: 243183,
      cacheWrite1h: 0,
      agents: 8,
      source: "transcripts",
    });
    expect(row.usd).toBeCloseTo(1.845665, 5);
    expect(row.blocks).toHaveLength(1);
    expect(row.blocks[0]).toMatchObject({ id: "F1", class: "real" });

    const second = run(
      [
        "record",
        fixtureReport,
        dir,
        "--run",
        "wf_7092b963-6a5",
        "--claude-dir",
        fixtureClaude,
        "--card",
        "standard-agents",
        "--commit",
        "abc1234",
        "--adversary",
        "F1=real: confirmed by the fix commit",
      ],
      dir
    );
    expect(second.status, second.stderr).toBe(0);
    expect(second.stdout).toContain("Recorded 1 outcome(s) for wf_7092b963-6a5 in .doug/.state/memory/memory.db (0 new, 1 updated).");
    const stillOne = JSON.parse(run(["outcomes", dir, "--json"], dir).stdout);
    expect(stillOne).toHaveLength(1);

    rmSync(dir, { recursive: true, force: true });
  });

  it("records tokens and USD as null and prints a note when the run's journal cannot be found", () => {
    const dir = tempDir();
    const res = run(["record", fixtureReport, dir, "--run", "wf_missing_run", "--claude-dir", fixtureClaude], dir);
    expect(res.status, res.stderr).toBe(0);
    expect(res.stderr).toContain("Note: no journal for run wf_missing_run; tokens and USD recorded as null.");
    const rows = JSON.parse(run(["outcomes", dir, "--json"], dir).stdout);
    expect(rows).toHaveLength(1);
    expect(rows[0].tokens).toBeNull();
    expect(rows[0].usd).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });

  it("without --run, names the run report:<12 hex> and leaves tokens/USD null", () => {
    const dir = tempDir();
    const res = run(["record", fixtureReport, dir], dir);
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toMatch(/Recorded 1 outcome\(s\) for report:[0-9a-f]{12} in/);
    const rows = JSON.parse(run(["outcomes", dir, "--json"], dir).stdout);
    expect(rows).toHaveLength(1);
    expect(rows[0].run).toMatch(/^report:[0-9a-f]{12}$/);
    expect(rows[0].tokens).toBeNull();
    expect(rows[0].usd).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });

  // Card report-save-wrapper, M3: the same fixture report saved as the Workflow tool's own output shape ({
  // summary, agentCount, logs, result: <report> }) instead of bare must record the same outcome (record imports
  // unwrapReport from lib/plan.mjs and applies it to what it parsed).
  it("M3: record accepts a wrapped report the same as bare (same fixture report, wrapped)", () => {
    const dir = tempDir();
    const inner = JSON.parse(readFileSync(fixtureReport, "utf8"));
    const wrappedPath = join(dir, "wrapped-report.json");
    writeFileSync(wrappedPath, JSON.stringify({ summary: "x", agentCount: 1, logs: [], result: inner }));
    const res = run(["record", wrappedPath, dir], dir);
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toMatch(/Recorded 1 outcome\(s\) for report:[0-9a-f]{12} in/);
    const rows = JSON.parse(run(["outcomes", dir, "--json"], dir).stdout);
    expect(rows).toHaveLength(1);
    expect(rows[0].task).toBe("agents-generator");
    expect(rows[0].tokens).toBeNull();
    expect(rows[0].usd).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });

  it("takes files from the plan's task and the plan's own card when --card is absent and the task's card is null", () => {
    const dir = tempDir();
    mkdirSync(join(dir, ".doug"), { recursive: true });
    writeFileSync(
      join(dir, ".doug", "plan.json"),
      JSON.stringify({
        card: "the-plan-card",
        tasks: [{ id: "agents-generator", card: null, files: ["plugins/doug-flow/lib/a.mjs", "plugins/doug-flow/lib/b.mjs"] }],
      }),
      "utf8"
    );
    const res = run(["record", fixtureReport, dir], dir);
    expect(res.status, res.stderr).toBe(0);
    const rows = JSON.parse(run(["outcomes", dir, "--json"], dir).stdout);
    expect(rows).toHaveLength(1);
    expect(rows[0].files).toEqual(["plugins/doug-flow/lib/a.mjs", "plugins/doug-flow/lib/b.mjs"]);
    expect(rows[0].card).toBe("the-plan-card");
    rmSync(dir, { recursive: true, force: true });
  });

  it("prints a flow row's text line unchanged: run, task, verified, review, adversary, passes, tokens, usd, commit", () => {
    const dir = tempDir();
    run(
      [
        "record",
        fixtureReport,
        dir,
        "--run",
        "wf_7092b963-6a5",
        "--claude-dir",
        fixtureClaude,
        "--card",
        "standard-agents",
        "--commit",
        "abc1234",
        "--adversary",
        "F1=real: confirmed by the fix commit",
      ],
      dir
    );
    const res = run(["outcomes", dir], dir);
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout.trim()).toBe(
      "wf_7092b963-6a5  agents-generator  verified yes  review 1 issue(s)  adversary pass (1 block(s))  passes 2  tokens 180/26359  usd 1.85  commit abc1234"
    );
    rmSync(dir, { recursive: true, force: true });
  });

  it("prints 'partial yes' right after verified for a partial task, and omits it when unset (card worker-context-handoff)", () => {
    const dir = tempDir();
    const report = {
      levels: [{ index: 0, tasks: [
        { id: "partial-task", implemented: true, verified: false, reviewed: false, partial: true, stopReason: "partial on a fix pass: still broken", reviewIssues: [] },
        { id: "done-task", implemented: true, verified: true, reviewed: true, reviewIssues: [] },
      ] }],
    };
    const reportPath = join(dir, "partial-report.json");
    writeFileSync(reportPath, JSON.stringify(report), "utf8");
    const rec = run(["record", reportPath, dir, "--run", "wf_cli_test"], dir);
    expect(rec.status, rec.stderr).toBe(0);
    const res = run(["outcomes", dir], dir);
    expect(res.status, res.stderr).toBe(0);
    const lines = res.stdout.trim().split("\n");
    const partialLine = lines.find((l) => l.includes("partial-task"));
    const doneLine = lines.find((l) => l.includes("done-task"));
    expect(partialLine).toContain("verified no  partial yes  review");
    expect(doneLine).not.toContain("partial");
    rmSync(dir, { recursive: true, force: true });
  });

  it("exits 1 naming the report's block when --adversary names an id the report lacks", () => {
    const dir = tempDir();
    const res = run(["record", fixtureReport, dir, "--adversary", "F9=false"], dir);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("F1");
    rmSync(dir, { recursive: true, force: true });
  });

  it("exits 1 on a missing report path", () => {
    const dir = tempDir();
    const res = run(["record", join(dir, "nope.json")], dir);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("nope.json");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("memory.mjs record --hand", () => {
  it("records a hand-track landing and reads it back with the not-applicable columns null", () => {
    const dir = tempDir();
    const res = run(
      [
        "record",
        "hand-track-outcomes",
        "--hand",
        dir,
        "--commit",
        "abc1234def5",
        "--wall",
        "34 min",
        "--gate",
        "typecheck 0; unit 639 passed",
        "--note",
        "landed by hand",
      ],
      dir
    );
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toContain(
      "Recorded a hand-track landing for hand-track-outcomes at abc1234def5 in .doug/.state/memory/memory.db (1 new, 0 updated)."
    );

    const rows = JSON.parse(run(["outcomes", dir, "--json"], dir).stdout);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.track).toBe("hand");
    expect(row.run).toBe("hand:abc1234def5");
    expect(row.task).toBe("hand-track-outcomes");
    expect(row.card).toBe("hand-track-outcomes");
    expect(row.commit_sha).toBe("abc1234def5");
    expect(row.wall_clock).toBe("34 min");
    expect(row.gate).toBe("typecheck 0; unit 639 passed");
    expect(row.note).toBe("landed by hand");
    rmSync(dir, { recursive: true, force: true });
  });

  it("normalises an empty or whitespace-only --wall/--gate/--note to null rather than storing the empty string", () => {
    const dir = tempDir();
    // --wall given last, with no following value, yields "" from the parser.
    const res = run(["record", "hand-track-outcomes", "--hand", dir, "--commit", "abc1234def5", "--gate", "   ", "--note", "x", "--wall"], dir);
    expect(res.status, res.stderr).toBe(0);
    const [row] = JSON.parse(run(["outcomes", dir, "--json"], dir).stdout);
    expect(row.wall_clock).toBeNull();
    expect(row.gate).toBeNull();
    expect(row.note).toBe("x");
    rmSync(dir, { recursive: true, force: true });
  });

  it("is idempotent on a second record of the same commit, and a different commit adds a second row", () => {
    const dir = tempDir();
    const args = ["record", "hand-track-outcomes", "--hand", dir, "--commit", "abc1234def5", "--wall", "34 min", "--gate", "gate text"];
    const first = run(args, dir);
    expect(first.status, first.stderr).toBe(0);
    expect(first.stdout).toContain("(1 new, 0 updated).");

    const second = run(args, dir);
    expect(second.status, second.stderr).toBe(0);
    expect(second.stdout).toContain("(0 new, 1 updated).");
    expect(JSON.parse(run(["outcomes", dir, "--json"], dir).stdout)).toHaveLength(1);

    const third = run(
      ["record", "hand-track-outcomes", "--hand", dir, "--commit", "9999999999", "--wall", "5 min", "--gate", "gate text"],
      dir
    );
    expect(third.status, third.stderr).toBe(0);
    expect(third.stdout).toContain("(1 new, 0 updated).");
    expect(JSON.parse(run(["outcomes", dir, "--json"], dir).stdout)).toHaveLength(2);
    rmSync(dir, { recursive: true, force: true });
  });

  it("shows null (not falsy defaults) for the columns that don't exist on the hand track", () => {
    const dir = tempDir();
    run(["record", "hand-track-outcomes", "--hand", dir, "--commit", "abc1234def5", "--wall", "34 min", "--gate", "gate text"], dir);
    const [row] = JSON.parse(run(["outcomes", dir, "--json"], dir).stdout);
    for (const c of [
      "run_id", "report_hash", "files", "size", "passes", "fix_passes", "review_issue_count", "blocks", "tokens", "usd",
      "verified", "adversary_verdict",
    ]) {
      expect(row[c], `${c} should be null`).toBeNull();
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it("prints a hand row's text line as null, never a false zero, with the hand-only columns", () => {
    const dir = tempDir();
    run(["record", "hand-track-outcomes", "--hand", dir, "--commit", "abc1234def5", "--wall", "34 min", "--gate", "typecheck 0; unit 639 passed"], dir);
    const res = run(["outcomes", dir], dir);
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toContain("hand");
    expect(res.stdout).toContain("34 min");
    expect(res.stdout).toContain("typecheck 0; unit 639 passed");
    expect(res.stdout).not.toContain("review 0 issue(s)");
    expect(res.stdout).not.toContain("(0 block(s))");
    expect(res.stdout).toContain("review null issue(s)");
    expect(res.stdout).toContain("(null block(s))");
    rmSync(dir, { recursive: true, force: true });
  });

  it("does not disturb a workflow row recorded into the same store", () => {
    const dir = tempDir();
    const wf = run(
      ["record", fixtureReport, dir, "--run", "wf_7092b963-6a5", "--claude-dir", fixtureClaude, "--card", "standard-agents", "--commit", "abc1234", "--adversary", "F1=real: confirmed by the fix commit"],
      dir
    );
    expect(wf.status, wf.stderr).toBe(0);
    const hand = run(["record", "hand-track-outcomes", "--hand", dir, "--commit", "9999999999", "--wall", "5 min", "--gate", "gate text"], dir);
    expect(hand.status, hand.stderr).toBe(0);

    const rows = JSON.parse(run(["outcomes", dir, "--json"], dir).stdout);
    expect(rows).toHaveLength(2);
    const flowRow = rows.find((r) => r.run === "wf_7092b963-6a5");
    expect(flowRow.track).toBe("flow");
    expect(flowRow.fix_passes).toBe(1);
    expect(typeof flowRow.review_issue_count).toBe("number");
    expect(Array.isArray(flowRow.blocks)).toBe(true);

    const byTask = JSON.parse(run(["outcomes", dir, "--task", "agents-generator", "--json"], dir).stdout);
    expect(byTask).toHaveLength(1);
    expect(byTask[0].run).toBe("wf_7092b963-6a5");
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes the store under the [dir] positional, not cwd, when they differ", () => {
    const dbDir = tempDir();
    const otherCwd = tempDir();
    const res = run(["record", "hand-track-outcomes", "--hand", dbDir, "--commit", "abc1234def5", "--wall", "5 min", "--gate", "gate text"], otherCwd);
    expect(res.status, res.stderr).toBe(0);
    expect(existsSync(join(dbDir, ".doug", ".state", "memory", "memory.db"))).toBe(true);
    expect(existsSync(join(otherCwd, ".doug", ".state", "memory", "memory.db"))).toBe(false);
    rmSync(dbDir, { recursive: true, force: true });
    rmSync(otherCwd, { recursive: true, force: true });
  });

  it("exits 2 with usage when --hand lacks --commit, or is combined with --run or a report path", () => {
    const dir = tempDir();
    const noCommit = run(["record", "hand-track-outcomes", "--hand", dir], dir);
    expect(noCommit.status).toBe(2);
    expect(noCommit.stderr).toContain("usage");

    const withRun = run(["record", "hand-track-outcomes", "--hand", dir, "--commit", "abc1234", "--run", "wf_1"], dir);
    expect(withRun.status).toBe(2);
    expect(withRun.stderr).toContain("usage");

    const withReportPath = run(["record", "hand-track-outcomes", "--hand", fixtureReport, dir, "--commit", "abc1234"], dir);
    expect(withReportPath.status).toBe(2);
    expect(withReportPath.stderr).toContain("usage");
    rmSync(dir, { recursive: true, force: true });
  });

  it("rejects a report path given as the card id, exit 2, naming that --hand takes a card id not a report", () => {
    const dir = tempDir();
    const res = run(["record", fixtureReport, "--hand", dir, "--commit", "sha1"], dir);
    expect(res.status).toBe(2);
    expect(res.stderr).toContain("usage");
    expect(res.stderr).toContain("--hand takes a card id, not a report");
    rmSync(dir, { recursive: true, force: true });
  });

  it("rejects a card id that merely ends in .json even if the file doesn't exist", () => {
    const dir = tempDir();
    const res = run(["record", "some/made-up/report.json", "--hand", dir, "--commit", "sha1"], dir);
    expect(res.status).toBe(2);
    expect(res.stderr).toContain("--hand takes a card id, not a report");
    rmSync(dir, { recursive: true, force: true });
  });
});

// A real temp git repo (like gitRepoDir below, defined once for `index build`/`status`/`search`) plus a
// .doug/board.json with one classed and one unclassed card, for `condition open`/`condition backfill` (card
// outcomes-condition-columns). The board is written straight to disk, uncommitted: condition open/backfill read
// it from the working tree, never from git, so it never needs to be part of a commit.
function writeConditionBoard(dir, cards) {
  mkdirSync(join(dir, ".doug"), { recursive: true });
  const board = {
    version: 1,
    updated: "2026-09-16",
    columns: [{ id: "ready", title: "Ready" }],
    components: [],
    tags: [],
    cards: cards || [
      { id: "classed-card", title: "Classed card", goal: "do the thing", column: "ready", class: "code" },
      { id: "unclassed-card", title: "Unclassed card", goal: "do another thing", column: "ready" },
    ],
  };
  writeFileSync(join(dir, ".doug", "board.json"), JSON.stringify(board, null, 2), "utf8");
}

// A plain (no .doug) git repo, its own user configured, for a `condition open` test that needs an explicit
// "no HEAD yet" repo rather than gitRepoDir's ready-made first commit.
function bareGitRepo(dir) {
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  spawnSync("git", ["config", "user.email", "t@example.com"], { cwd: dir });
  spawnSync("git", ["config", "user.name", "t"], { cwd: dir });
}

// A commit on `main` at an exact date, via GIT_COMMITTER_DATE/GIT_AUTHOR_DATE, for condition backfill's
// git-log-by-timestamp test: dates far in the past/future so the test never depends on the real wall clock at
// the moment it runs.
function commitAt(dir, message, isoDate, files = {}) {
  for (const [p, content] of Object.entries(files)) {
    const abs = join(dir, p);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  spawnSync("git", ["add", "-A"], { cwd: dir });
  const env = { ...process.env, GIT_COMMITTER_DATE: isoDate, GIT_AUTHOR_DATE: isoDate };
  const res = spawnSync("git", ["commit", "-q", "-m", message], { cwd: dir, env });
  if (res.status !== 0) throw new Error(`git commit failed: ${res.stderr}`);
  return spawnSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).stdout.trim();
}

describe("memory.mjs condition open", () => {
  it("writes the exact shape: harnessCommit = HEAD, configHash from conditionConfigHash, class/arm from the board, assignedBy policy, exploreProbability null (card outcomes-condition-columns)", () => {
    const dir = gitRepoDir();
    writeConditionBoard(dir);
    const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).stdout.trim();
    const res = run(["condition", "open", "classed-card", dir], dir);
    expect(res.status, res.stderr).toBe(0);

    const file = join(dir, ".doug", ".state", "reports", "classed-card", "condition.json");
    expect(existsSync(file)).toBe(true);
    const written = JSON.parse(readFileSync(file, "utf8"));
    expect(written.harnessCommit).toBe(head);
    expect(written.configHash).toBe(conditionConfigHash(dir));
    expect(written.class).toBe("code");
    expect(written.arm).toBe("code/default");
    expect(written.assignedBy).toBe("policy");
    expect(written.exploreProbability).toBeNull();
    expect(typeof written.openedAt).toBe("string");
    expect(Object.keys(written).sort()).toEqual(
      ["harnessCommit", "configHash", "class", "arm", "assignedBy", "exploreProbability", "openedAt"].sort()
    );
    rmSync(dir, { recursive: true, force: true });
  });

  it("refuses a second open, exit 1, leaving the file byte-identical", () => {
    const dir = gitRepoDir();
    writeConditionBoard(dir);
    const first = run(["condition", "open", "classed-card", dir], dir);
    expect(first.status, first.stderr).toBe(0);
    const file = join(dir, ".doug", ".state", "reports", "classed-card", "condition.json");
    const before = readFileSync(file, "utf8");

    const second = run(["condition", "open", "classed-card", dir], dir);
    expect(second.status).toBe(1);
    expect(second.stderr).toContain(".doug/.state/reports/classed-card/condition.json");
    expect(readFileSync(file, "utf8")).toBe(before);
    rmSync(dir, { recursive: true, force: true });
  });

  it("refuses an unclassed card, exit 1 naming the card, and writes nothing", () => {
    const dir = gitRepoDir();
    writeConditionBoard(dir);
    const res = run(["condition", "open", "unclassed-card", dir], dir);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("unclassed-card");
    expect(existsSync(join(dir, ".doug", ".state", "reports", "unclassed-card", "condition.json"))).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it("refuses a card missing from the board, exit 1 naming the card", () => {
    const dir = gitRepoDir();
    writeConditionBoard(dir);
    const res = run(["condition", "open", "no-such-card", dir], dir);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("no-such-card");
    rmSync(dir, { recursive: true, force: true });
  });

  it("refuses when the repo has no commits yet (no HEAD), exit 1 with a clear line", () => {
    const dir = tempDir();
    bareGitRepo(dir);
    writeConditionBoard(dir);
    const res = run(["condition", "open", "classed-card", dir], dir);
    expect(res.status).toBe(1);
    expect(res.stderr.trim().length).toBeGreaterThan(0);
    rmSync(dir, { recursive: true, force: true });
  });

  it("exits 2 with usage when no card id is given", () => {
    const dir = gitRepoDir();
    const res = run(["condition", "open"], dir);
    expect(res.status).toBe(2);
    expect(res.stderr).toContain("usage");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("memory.mjs condition usage", () => {
  it("exits 2 with usage for a bare 'condition' or an unknown subcommand", () => {
    const dir = gitRepoDir();
    const bare = run(["condition"], dir);
    expect(bare.status).toBe(2);
    expect(bare.stderr).toContain("usage");
    const unknown = run(["condition", "frobnicate"], dir);
    expect(unknown.status).toBe(2);
    expect(unknown.stderr).toContain("usage");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("memory.mjs record --hand: condition columns", () => {
  it("fills the condition columns from an existing condition.json (card outcomes-condition-columns)", () => {
    const dir = gitRepoDir();
    writeConditionBoard(dir);
    const openRes = run(["condition", "open", "classed-card", dir], dir);
    expect(openRes.status, openRes.stderr).toBe(0);
    const conditionFile = join(dir, ".doug", ".state", "reports", "classed-card", "condition.json");
    const condition = JSON.parse(readFileSync(conditionFile, "utf8"));

    const res = run(["record", "classed-card", "--hand", dir, "--commit", "abc1234def5", "--wall", "5 min", "--gate", "gate text"], dir);
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).not.toMatch(/unstamped/);

    const [row] = JSON.parse(run(["outcomes", dir, "--json"], dir).stdout);
    expect(row.harness_commit).toBe(condition.harnessCommit);
    expect(row.config_hash).toBe(condition.configHash);
    expect(row.class).toBe("code");
    expect(row.arm).toBe("code/default");
    expect(row.assigned_by).toBe("policy");
    expect(row.explore_probability).toBeNull();
    expect(row.backfilled).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });

  it("without a condition.json still records the row (exit 0) and prints the exact unstamped line on stdout", () => {
    const dir = tempDir();
    const res = run(
      ["record", "no-condition-card", "--hand", dir, "--commit", "abc1234def5", "--wall", "5 min", "--gate", "gate text"],
      dir
    );
    expect(res.status, res.stderr).toBe(0);
    const lines = res.stdout.trim().split("\n");
    expect(lines).toContain(
      "No condition.json for no-condition-card: this landing is unstamped (memory.mjs condition open no-condition-card writes one before the brief)."
    );
    for (const line of lines) {
      expect(line).not.toContain("<card>");
    }
    const [row] = JSON.parse(run(["outcomes", dir, "--json"], dir).stdout);
    expect(row.track).toBe("hand");
    for (const c of ["harness_commit", "config_hash", "class", "arm", "assigned_by", "explore_probability"]) {
      expect(row[c]).toBeNull();
    }
    expect(row.backfilled).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });

  it("--json carries stamped: true|false instead of the unstamped line", () => {
    const unstampedDir = tempDir();
    const unstampedRes = run(["record", "no-condition-card", "--hand", unstampedDir, "--commit", "abc1234def5", "--json"], unstampedDir);
    expect(unstampedRes.status, unstampedRes.stderr).toBe(0);
    expect(unstampedRes.stdout).not.toMatch(/unstamped/);
    expect(JSON.parse(unstampedRes.stdout).stamped).toBe(false);
    rmSync(unstampedDir, { recursive: true, force: true });

    const stampedDir = gitRepoDir();
    writeConditionBoard(stampedDir);
    run(["condition", "open", "classed-card", stampedDir], stampedDir);
    const stampedRes = run(["record", "classed-card", "--hand", stampedDir, "--commit", "abc1234def5", "--json"], stampedDir);
    expect(stampedRes.status, stampedRes.stderr).toBe(0);
    expect(JSON.parse(stampedRes.stdout).stamped).toBe(true);
    rmSync(stampedDir, { recursive: true, force: true });
  });
});

describe("memory.mjs condition backfill", () => {
  it("stamps a null-harness_commit row with the last commit at or before its recorded timestamp on main, sets class from the board, marks backfilled 1, and is idempotent (card outcomes-condition-columns)", () => {
    const dir = tempDir();
    bareGitRepo(dir);
    // Far in the past, so it is always at or before "now" (when `record` stamps the row's `recorded` time).
    const firstSha = commitAt(dir, "first", "2000-01-01T00:00:00", { "a.txt": "a\n" });
    writeConditionBoard(dir);

    const recRes = run(["record", "classed-card", "--hand", dir, "--commit", "deadbeefcafe", "--wall", "5 min", "--gate", "gate text"], dir);
    expect(recRes.status, recRes.stderr).toBe(0);

    // Far in the future, so it always lands strictly after the row's recorded time: the row must resolve to
    // `firstSha`, not this one.
    commitAt(dir, "second", "2099-01-01T00:00:00", { "b.txt": "b\n" });

    const res = run(["condition", "backfill", dir], dir);
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout.trim()).toBe("Backfilled 1 outcomes rows with a harness commit.");

    const [row] = JSON.parse(run(["outcomes", dir, "--json"], dir).stdout);
    expect(row.harness_commit).toBe(firstSha);
    expect(row.class).toBe("code");
    expect(row.backfilled).toBe(1);
    expect(row.config_hash).toBeNull();

    const second = run(["condition", "backfill", dir], dir);
    expect(second.status, second.stderr).toBe(0);
    expect(second.stdout.trim()).toBe("Backfilled 0 outcomes rows with a harness commit.");
    const [rowAfter] = JSON.parse(run(["outcomes", dir, "--json"], dir).stdout);
    expect(rowAfter).toEqual(row);
    rmSync(dir, { recursive: true, force: true });
  });

  it("--json reports {backfilled: n}", () => {
    const dir = tempDir();
    bareGitRepo(dir);
    commitAt(dir, "first", "2000-01-01T00:00:00", { "a.txt": "a\n" });
    writeConditionBoard(dir);
    run(["record", "classed-card", "--hand", dir, "--commit", "deadbeefcafe"], dir);

    const res = run(["condition", "backfill", dir, "--json"], dir);
    expect(res.status, res.stderr).toBe(0);
    expect(JSON.parse(res.stdout)).toEqual({ backfilled: 1 });

    const second = run(["condition", "backfill", dir, "--json"], dir);
    expect(second.status, second.stderr).toBe(0);
    expect(JSON.parse(second.stdout)).toEqual({ backfilled: 0 });
    rmSync(dir, { recursive: true, force: true });
  });

  it("a missing board is not an error; class stays null", () => {
    const dir = tempDir();
    bareGitRepo(dir);
    commitAt(dir, "only", "2000-01-01T00:00:00", { "a.txt": "a\n" });
    const recRes = run(["record", "no-board-card", "--hand", dir, "--commit", "cafefeed"], dir);
    expect(recRes.status, recRes.stderr).toBe(0);

    const res = run(["condition", "backfill", dir], dir);
    expect(res.status, res.stderr).toBe(0);
    const [row] = JSON.parse(run(["outcomes", dir, "--json"], dir).stdout);
    expect(row.harness_commit).not.toBeNull();
    expect(row.class).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });

  it("(review) a row recorded before the first commit on main stays untouched (harness_commit null, backfilled 0) and is not counted (brief F10)", () => {
    const dir = tempDir();
    bareGitRepo(dir);
    // Dated far in the future, so the row's own `recorded` (the real "now" the CLI stamps it with) is always
    // strictly before this commit: `git log --before=<recorded>` on main finds nothing at all.
    commitAt(dir, "first", "2099-01-01T00:00:00", { "a.txt": "a\n" });
    writeConditionBoard(dir);

    const recRes = run(["record", "classed-card", "--hand", dir, "--commit", "cafefeed"], dir);
    expect(recRes.status, recRes.stderr).toBe(0);

    const res = run(["condition", "backfill", dir], dir);
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout.trim()).toBe("Backfilled 0 outcomes rows with a harness commit.");

    const [row] = JSON.parse(run(["outcomes", dir, "--json"], dir).stdout);
    expect(row.harness_commit).toBeNull();
    expect(row.backfilled).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });

  it("(review) keeps a row's already-set class when the board card has no class (or no board at all)", () => {
    const dir = tempDir();
    bareGitRepo(dir);
    commitAt(dir, "first", "2000-01-01T00:00:00", { "a.txt": "a\n" });
    // No board written at all: findCard/loadBoard resolve to null for every card, so the UPDATE's
    // COALESCE(cardClass, class) must fall back to the row's own already-set class rather than nulling it.
    const recRes = run(["record", "already-classed-card", "--hand", dir, "--commit", "cafefeed"], dir);
    expect(recRes.status, recRes.stderr).toBe(0);
    const m = openMemory(dir);
    m.exec(`UPDATE outcomes SET class = 'code' WHERE run = 'hand:cafefeed'`);
    m.close();

    const res = run(["condition", "backfill", dir], dir);
    expect(res.status, res.stderr).toBe(0);
    const [row] = JSON.parse(run(["outcomes", dir, "--json"], dir).stdout);
    expect(row.harness_commit).not.toBeNull();
    expect(row.class).toBe("code");
    rmSync(dir, { recursive: true, force: true });
  });

  it("(review) honours --first-parent: a merged side-branch commit dated between the row and its mainline ancestor is never picked over the mainline commit", () => {
    const dir = tempDir();
    bareGitRepo(dir);
    const mainSha = commitAt(dir, "on main", "2000-01-01T00:00:00", { "a.txt": "a\n" });
    spawnSync("git", ["checkout", "-q", "-b", "feature"], { cwd: dir });
    const sideSha = commitAt(dir, "on feature", "2005-01-01T00:00:00", { "side.txt": "side\n" });
    spawnSync("git", ["checkout", "-q", "main"], { cwd: dir });
    const mergeEnv = { ...process.env, GIT_COMMITTER_DATE: "2020-01-01T00:00:00", GIT_AUTHOR_DATE: "2020-01-01T00:00:00" };
    const mergeRes = spawnSync("git", ["merge", "-q", "--no-ff", "-m", "merge feature", "feature"], { cwd: dir, env: mergeEnv });
    expect(mergeRes.status, String(mergeRes.stderr)).toBe(0);

    // The row's `recorded` sits strictly between the side commit (2005) and the merge commit (2020): a plain
    // (non --first-parent) `git log --before` on main can find the side commit here, since it is an ancestor of
    // main's tip; --first-parent must skip it and resolve to the true mainline commit instead.
    const m = openMemory(dir);
    const row = handOutcomeRow({ card: "merge-test-card", commit: "cafefeed", now: "2010-01-01T00:00:00.000Z" });
    recordOutcomes(m, [row]);
    m.close();

    const res = run(["condition", "backfill", dir], dir);
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout.trim()).toBe("Backfilled 1 outcomes rows with a harness commit.");

    const [stored] = JSON.parse(run(["outcomes", dir, "--json"], dir).stdout);
    expect(stored.harness_commit).toBe(mainSha);
    expect(stored.harness_commit).not.toBe(sideSha);
    rmSync(dir, { recursive: true, force: true });
  });

  it("(review) a repo with no main branch exits 0, prints Backfilled 0, and writes exactly one stderr line naming main", () => {
    const dir = tempDir();
    // A git repo whose default branch is not "main" at all: `git log ... main` cannot resolve the ref.
    spawnSync("git", ["init", "-q", "-b", "trunk"], { cwd: dir });
    spawnSync("git", ["config", "user.email", "t@example.com"], { cwd: dir });
    spawnSync("git", ["config", "user.name", "t"], { cwd: dir });
    commitAt(dir, "on trunk", "2000-01-01T00:00:00", { "a.txt": "a\n" });

    const m = openMemory(dir);
    const row = handOutcomeRow({ card: "no-main-card", commit: "cafefeed" });
    recordOutcomes(m, [row]);
    m.close();

    const res = run(["condition", "backfill", dir], dir);
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout.trim()).toBe("Backfilled 0 outcomes rows with a harness commit.");
    const stderrLines = res.stderr.trim().split("\n").filter(Boolean);
    expect(stderrLines).toHaveLength(1);
    expect(stderrLines[0]).toContain("main");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("memory.mjs outcomes", () => {
  it("filters by --task and prints 'no outcomes recorded' on an empty store", () => {
    const dir = tempDir();
    const empty = run(["outcomes", dir], dir);
    expect(empty.status, empty.stderr).toBe(0);
    expect(empty.stdout).toContain("no outcomes recorded");

    run(["record", fixtureReport, dir, "--run", "wf_a"], dir);
    run(["record", fixtureReport, dir, "--run", "wf_b"], dir);
    const byTask = run(["outcomes", dir, "--task", "agents-generator", "--json"], dir);
    expect(byTask.status, byTask.stderr).toBe(0);
    expect(JSON.parse(byTask.stdout)).toHaveLength(2);
    const byMissingTask = run(["outcomes", dir, "--task", "no-such-task", "--json"], dir);
    expect(JSON.parse(byMissingTask.stdout)).toHaveLength(0);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("memory.mjs lessons", () => {
  it("prints 'no lessons' and an empty JSON array on a fresh store", () => {
    const dir = tempDir();
    const text = run(["lessons", dir], dir);
    expect(text.status, text.stderr).toBe(0);
    expect(text.stdout).toContain("no lessons");
    const json = run(["lessons", dir, "--json"], dir);
    expect(json.status, json.stderr).toBe(0);
    expect(JSON.parse(json.stdout)).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("memory.mjs lesson add", () => {
  it("writes a lesson readable through memory.mjs lessons, defaulting source-agent to lead", () => {
    const dir = tempDir();
    const res = run(["lesson", "add", "--text", "Use pnpm, never npm.", "--kind", "pattern", dir], dir);
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toContain("Added lesson");
    expect(res.stdout).toContain("(pattern)");

    const rows = JSON.parse(run(["lessons", dir, "--json"], dir).stdout);
    expect(rows).toHaveLength(1);
    expect(rows[0].text).toBe("Use pnpm, never npm.");
    expect(rows[0].kind).toBe("pattern");
    expect(rows[0].source_agent).toBe("lead");
    rmSync(dir, { recursive: true, force: true });
  });

  it("accepts each of the four kinds", () => {
    for (const kind of ["feedback", "project", "pitfall", "pattern"]) {
      const dir = tempDir();
      const res = run(["lesson", "add", "--text", `a ${kind} lesson`, "--kind", kind, dir], dir);
      expect(res.status, `${kind}: ${res.stderr}`).toBe(0);
      const [row] = JSON.parse(run(["lessons", dir, "--json"], dir).stdout);
      expect(row.kind).toBe(kind);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exits non-zero naming the problem on an invalid kind", () => {
    const dir = tempDir();
    const res = run(["lesson", "add", "--text", "x", "--kind", "nonsense", dir], dir);
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain("kind");
    rmSync(dir, { recursive: true, force: true });
  });

  it("exits non-zero naming the problem on empty text", () => {
    const dir = tempDir();
    const res = run(["lesson", "add", "--text", "   ", "--kind", "pattern", dir], dir);
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain("text");
    rmSync(dir, { recursive: true, force: true });
  });

  it("refuses --source-agent auto-memory, naming it as the import's namespace", () => {
    const dir = tempDir();
    const res = run(["lesson", "add", "--text", "x", "--kind", "pattern", "--source-agent", "auto-memory", dir], dir);
    expect(res.status).toBe(2);
    expect(res.stderr).toContain("auto-memory");
    expect(res.stderr).toContain("namespace");
    const rows = JSON.parse(run(["lessons", dir, "--json"], dir).stdout);
    expect(rows).toHaveLength(0);
    rmSync(dir, { recursive: true, force: true });
  });

  it("refuses --source-agent auto-memory normalized: leading/trailing whitespace and any case", () => {
    for (const value of [" auto-memory", "Auto-Memory", "auto-memory\n"]) {
      const dir = tempDir();
      const res = run(["lesson", "add", "--text", "x", "--kind", "pattern", "--source-agent", value, dir], dir);
      expect(res.status, `${JSON.stringify(value)}: ${res.stderr}`).toBe(2);
      expect(res.stderr).toContain("auto-memory");
      expect(res.stderr).toContain("namespace");
      const rows = JSON.parse(run(["lessons", dir, "--json"], dir).stdout);
      expect(rows).toHaveLength(0);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("trims a normal --source-agent value when storing it", () => {
    const dir = tempDir();
    const res = run(["lesson", "add", "--text", "x", "--kind", "pattern", "--source-agent", " reviewer ", dir], dir);
    expect(res.status, res.stderr).toBe(0);
    const rows = JSON.parse(run(["lessons", dir, "--json"], dir).stdout);
    expect(rows[0].source_agent).toBe("reviewer");
    rmSync(dir, { recursive: true, force: true });
  });

  it("prints the created row as --json", () => {
    const dir = tempDir();
    const res = run(
      ["lesson", "add", "--text", "scoped lesson", "--kind", "pitfall", "--scope", "plugins/doug-flow/**, packages/**", "--card", "some-card", "--commit", "abc1234", "--source-model", "opus", dir, "--json"],
      dir
    );
    expect(res.status, res.stderr).toBe(0);
    const row = JSON.parse(res.stdout);
    expect(row.text).toBe("scoped lesson");
    expect(row.kind).toBe("pitfall");
    expect(row.scope).toEqual(["plugins/doug-flow/**", "packages/**"]);
    expect(row.card).toBe("some-card");
    expect(row.commit_sha).toBe("abc1234");
    expect(row.source_model).toBe("opus");
    rmSync(dir, { recursive: true, force: true });
  });

  it("exits 1 cleanly, not a stack trace, when the same lesson is added twice", () => {
    const dir = tempDir();
    const first = run(["lesson", "add", "--text", "duplicate me", "--kind", "pattern", dir], dir);
    expect(first.status, first.stderr).toBe(0);
    const second = run(["lesson", "add", "--text", "duplicate me", "--kind", "pattern", dir], dir);
    expect(second.status).toBe(1);
    expect(second.stderr).toContain("already exists");
    expect(second.stderr).not.toContain("at file://");
    rmSync(dir, { recursive: true, force: true });
  });

  it("keeps 'lesson add' and 'lessons' unambiguous", () => {
    const dir = tempDir();
    const add = run(["lesson", "add", "--text", "distinct", "--kind", "pattern", dir], dir);
    expect(add.status, add.stderr).toBe(0);
    const list = run(["lessons", dir], dir);
    expect(list.status, list.stderr).toBe(0);
    expect(list.stdout).toContain("distinct");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("memory.mjs recall", () => {
  it("is keyword-only with no provider configured: text and json", () => {
    const dir = tempDir();
    run(["lesson", "add", "--text", "always run pnpm typecheck before the gate", "--kind", "pattern", dir], dir);
    run(["lesson", "add", "--text", "the stop gate blocks unscoped edits", "--kind", "pitfall", dir], dir);

    const text = run(["recall", "pnpm typecheck gate", dir], dir);
    expect(text.status, text.stderr).toBe(0);
    expect(text.stdout.split("\n")[0]).toBe("recall: keyword-only (no provider configured)");
    expect(text.stdout).toContain("pnpm typecheck");

    const json = run(["recall", "pnpm typecheck gate", dir, "--json"], dir);
    expect(json.status, json.stderr).toBe(0);
    const result = JSON.parse(json.stdout);
    expect(result.mode).toBe("keyword-only");
    expect(result.reason).toBe("no provider configured");
    expect(result.provider).toBeNull();
    expect(Array.isArray(result.lessons)).toBe(true);
    expect(result.lessons.length).toBeGreaterThan(0);
    expect(result.lessons[0]).toHaveProperty("score");
    expect(result.lessons[0]).toHaveProperty("sides");
    rmSync(dir, { recursive: true, force: true });
  });

  it("exits 2 with usage on a missing query", () => {
    const dir = tempDir();
    const res = run(["recall"], dir);
    expect(res.status).toBe(2);
    expect(res.stderr).toContain("usage");
    rmSync(dir, { recursive: true, force: true });
  });

  it("(review #2) refuses a --k that is not an integer >= 1, exit 2 with usage, rather than silently returning nothing", () => {
    const dir = tempDir();
    run(["lesson", "add", "--text", "retry flaky uploads", "--kind", "pattern", dir], dir);
    for (const bad of ["0", "-1", "abc", "1.5"]) {
      const res = run(["recall", "retry flaky", dir, "--k", bad], dir);
      expect(res.status, `--k ${bad}: ${res.stderr}`).toBe(2);
      expect(res.stderr).toContain("usage");
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it("goes hybrid once a provider is configured and reembed has run", async () => {
    const dir = tempDir();
    const server = await startFakeOllama();
    try {
      writeMemoryConfig(dir, { provider: "openai-compatible", baseUrl: serverBaseUrl(server), model: "embeddinggemma", dims: 4 });
      await runAsync(["lesson", "add", "--text", "flaky tests need a retry policy", "--kind", "pattern", dir], dir);
      // The fixed-vector fake returns the same vector for every input, which would fail the cosine sanity
      // check reembed now runs on a model/dims change (card memory-measure); --no-check is the documented
      // escape hatch for exactly this non-semantic test double.
      const embed = await runAsync(["reembed", dir, "--no-check"], dir);
      expect(embed.status, embed.stderr).toBe(0);

      const recall = await runAsync(["recall", "flaky tests", dir, "--json"], dir);
      const result = JSON.parse(recall.stdout);
      expect(result.mode).toBe("hybrid");
      expect(result.provider).toBe("openai-compatible");
      // (MAJOR 5) the raw JSON text must never carry the embedding blob or its model/dims columns.
      expect(recall.stdout).not.toMatch(/"embedding"/);
      expect(recall.stdout).not.toMatch(/"embedding_model"/);
      expect(recall.stdout).not.toMatch(/"embedding_dims"/);
      expect(result.lessons[0]).toHaveProperty("hasVector", true);
    } finally {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("(MINOR 12) falls back to keyword-only, naming the failure and still returning the lesson, exit 0, when the configured provider is down (closed port)", async () => {
    const dir = tempDir();
    const server = await startFakeOllama();
    try {
      writeMemoryConfig(dir, { provider: "openai-compatible", baseUrl: serverBaseUrl(server), model: "embeddinggemma", dims: 4 });
      // Establish embeddinggemma/4 as already used in this store first (card memory-measure: best-effort add
      // never embeds a model/dims pair that is new to the store — only `reembed`, after its sanity check, may
      // do that) so the add below actually embeds, giving recall a real stored vector to fall back off of.
      run(["lesson", "add", "--text", "seed lesson", "--kind", "pattern", dir], dir);
      const seed = await runAsync(["reembed", dir, "--no-check"], dir);
      expect(seed.status, seed.stderr).toBe(0);

      await runAsync(["lesson", "add", "--text", "flaky tests need a retry policy", "--kind", "pattern", dir], dir);
      server.close();
      // Same model/dims, now pointed at a closed port: the stored vector still matches, but the provider itself
      // cannot answer the query embed.
      writeMemoryConfig(dir, { provider: "openai-compatible", baseUrl: "http://127.0.0.1:1", model: "embeddinggemma", dims: 4 });
      const res = run(["recall", "flaky tests", dir, "--json"], dir);
      expect(res.status, res.stderr).toBe(0);
      const result = JSON.parse(res.stdout);
      expect(result.mode).toBe("keyword-only");
      expect(typeof result.reason).toBe("string");
      expect(result.reason).not.toBe("no provider configured");
      expect(result.reason).not.toMatch(/no vectors stored/);
      expect(result.lessons.length).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("(MINOR 12) a punctuation-only query returns no lessons, exit 0, without error (an empty string is a usage error at the CLI boundary — covered above)", () => {
    const dir = tempDir();
    run(["lesson", "add", "--text", "retry flaky uploads", "--kind", "pattern", dir], dir);
    const punctuation = run(["recall", "!!! ??? ...", dir, "--json"], dir);
    expect(punctuation.status, punctuation.stderr).toBe(0);
    expect(JSON.parse(punctuation.stdout).lessons).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("honors memory.staleDays from .doug/config.json: a 40-day-old lesson is excluded by default (30) and returned once staleDays is 60", () => {
    const dir = tempDir();
    const m = openMemory(dir);
    addLesson(m, {
      text: "an old lesson about flaky uploads from forty days back",
      kind: "pattern",
      source: { agent: "worker" },
      created: new Date(Date.now() - 40 * 86400000).toISOString(),
    });
    m.close();

    const noKey = run(["recall", "flaky uploads", dir, "--json"], dir);
    expect(noKey.status, noKey.stderr).toBe(0);
    expect(JSON.parse(noKey.stdout).lessons).toEqual([]);

    mkdirSync(join(dir, ".doug"), { recursive: true });
    writeFileSync(join(dir, ".doug", "config.json"), JSON.stringify({ memory: { staleDays: 60 } }), "utf8");
    const withKey = run(["recall", "flaky uploads", dir, "--json"], dir);
    expect(withKey.status, withKey.stderr).toBe(0);
    expect(JSON.parse(withKey.stdout).lessons.length).toBeGreaterThan(0);

    rmSync(dir, { recursive: true, force: true });
  });

  it("warns on stderr and behaves as 30 when memory.staleDays is not a positive number", () => {
    const dir = tempDir();
    const m = openMemory(dir);
    addLesson(m, {
      text: "an old lesson about flaky uploads from forty days back",
      kind: "pattern",
      source: { agent: "worker" },
      created: new Date(Date.now() - 40 * 86400000).toISOString(),
    });
    m.close();

    mkdirSync(join(dir, ".doug"), { recursive: true });
    writeFileSync(join(dir, ".doug", "config.json"), JSON.stringify({ memory: { staleDays: "sixty" } }), "utf8");

    const res = run(["recall", "flaky uploads", dir, "--json"], dir);
    expect(res.status, res.stderr).toBe(0);
    expect(res.stderr).toContain("[doug] .doug/config.json memory.staleDays is not a positive number; using 30");
    // Behaves as 30, not "any positive number": the 40-day-old lesson is still excluded.
    expect(JSON.parse(res.stdout).lessons).toEqual([]);

    rmSync(dir, { recursive: true, force: true });
  });
});

// card recall-fallback-warning (D3/D5/D6): a degraded recall says so on stderr; stdout headers stay as they are.
describe("memory.mjs recall: degraded warning (card recall-fallback-warning)", () => {
  const EMBED_CFG = (baseUrl) => ({ provider: "openai-compatible", baseUrl, model: "embeddinggemma", dims: 4 });
  const seedLessons = (dir, texts, { vectored = texts.length, model = "embeddinggemma", dims = 4 } = {}) => {
    const m = openMemory(dir);
    texts.forEach((text, i) => {
      const row = addLesson(m, { text, kind: "pattern", source: { agent: "worker" } });
      if (i < vectored) setLessonEmbedding(m, row.id, { model, dims, vector: Float32Array.from(Array.from({ length: dims }, (_, j) => (j === 0 ? 1 : 0))) });
    });
    m.close();
  };

  it("(a) a query-time embed timeout warns with the cold-model hint; exit 0, header unchanged, lesson still returned", async () => {
    const dir = tempDir();
    // Accepts the connection and never answers: the provider's own 2s timeout is the failure.
    const hanging = createServer(() => {});
    await new Promise((r) => hanging.listen(0, "127.0.0.1", r));
    try {
      seedLessons(dir, ["flaky tests need a retry policy"]);
      writeMemoryConfig(dir, EMBED_CFG(serverBaseUrl(hanging)));
      const res = await runAsync(["recall", "flaky tests", dir], dir);
      expect(res.status, res.stderr).toBe(0);
      expect(stderrLines(res)).toContain(
        "WARNING: memory recall degraded to keyword-only: timeout; run memory.mjs doctor (a cold model can time out on first use; retry)"
      );
      expect(res.stdout.split("\n")[0]).toBe("recall: keyword-only (timeout)");
      expect(res.stdout).toContain("flaky tests need a retry policy");
    } finally {
      hanging.closeAllConnections();
      hanging.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("an unreachable provider warns with `run memory.mjs doctor` and no cold-model hint", async () => {
    const dir = tempDir();
    seedLessons(dir, ["flaky tests need a retry policy"]);
    writeMemoryConfig(dir, EMBED_CFG("http://127.0.0.1:1"));
    const res = await runAsync(["recall", "flaky tests", dir], dir);
    expect(res.status, res.stderr).toBe(0);
    const warning = stderrLines(res).find((l) => l.startsWith("WARNING: memory recall degraded to keyword-only: "));
    expect(warning).toMatch(/^WARNING: memory recall degraded to keyword-only: request failed: .+; run memory\.mjs doctor$/);
    expect(res.stderr).not.toContain("cold model");
    rmSync(dir, { recursive: true, force: true });
  });

  it("(c) vectors stored for another model: warns 'no vectors stored for <model>/<dims>; run memory.mjs reembed'", async () => {
    const dir = tempDir();
    seedLessons(dir, ["flaky tests need a retry policy"], { model: "other-model", dims: 8 });
    writeMemoryConfig(dir, EMBED_CFG("http://127.0.0.1:1"));
    const res = await runAsync(["recall", "flaky tests", dir], dir);
    expect(res.status, res.stderr).toBe(0);
    expect(stderrLines(res)).toContain("WARNING: memory recall degraded to keyword-only: no vectors stored for embeddinggemma/4; run memory.mjs reembed");
    expect(res.stdout.split("\n")[0]).toBe("recall: keyword-only (no vectors stored for embeddinggemma/4)");
    rmSync(dir, { recursive: true, force: true });
  });

  it("(f) no provider configured but a local Ollama with the model is detected: warns to run doctor to enable it", async () => {
    const probe = await listenForProbe(fakeOllamaHandler);
    const dir = tempDir();
    try {
      seedLessons(dir, ["flaky tests need a retry policy"], { vectored: 0 });
      const res = await runAsync(["recall", "flaky tests", dir], dir, probeEnv(probe));
      expect(res.status, res.stderr).toBe(0);
      const warning = stderrLines(res).find((l) => l.startsWith("WARNING: memory recall degraded to keyword-only: "));
      expect(warning).toMatch(
        /^WARNING: memory recall degraded to keyword-only: no provider configured, but .*embeddinggemma.* is available; run memory\.mjs doctor to enable it$/
      );
      expect(res.stdout.split("\n")[0]).toBe("recall: keyword-only (no provider configured)");
    } finally {
      probe.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("(e) no provider configured, vectors stored for some model: warns 'configure memory.embeddings (memory.mjs doctor)'", async () => {
    const probe = await listenForProbe(nothingThereHandler);
    const dir = tempDir();
    try {
      seedLessons(dir, ["flaky tests need a retry policy"], { model: "other-model", dims: 8 });
      const res = await runAsync(["recall", "flaky tests", dir], dir, probeEnv(probe));
      expect(res.status, res.stderr).toBe(0);
      expect(stderrLines(res)).toContain(
        "WARNING: memory recall degraded to keyword-only: no provider configured; configure memory.embeddings (memory.mjs doctor)"
      );
    } finally {
      probe.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("(g) no provider configured, none detected, no vectors stored: no WARNING at all, header unchanged", async () => {
    const probe = await listenForProbe(nothingThereHandler);
    const dir = tempDir();
    try {
      seedLessons(dir, ["flaky tests need a retry policy"], { vectored: 0 });
      const res = await runAsync(["recall", "flaky tests", dir], dir, probeEnv(probe));
      expect(res.status, res.stderr).toBe(0);
      expect(res.stderr).not.toContain("WARNING");
      expect(res.stdout.split("\n")[0]).toBe("recall: keyword-only (no provider configured)");
    } finally {
      probe.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("partial coverage in hybrid mode: warns 'N of M lessons have no vector; run memory.mjs reembed' and stays hybrid", async () => {
    const dir = tempDir();
    const server = await startFakeOllama();
    try {
      seedLessons(dir, ["flaky retry one", "flaky retry two", "flaky retry three"], { vectored: 1 });
      writeMemoryConfig(dir, EMBED_CFG(serverBaseUrl(server)));
      const res = await runAsync(["recall", "flaky retry", dir], dir);
      expect(res.status, res.stderr).toBe(0);
      expect(stderrLines(res)).toContain("WARNING: 2 of 3 lessons have no vector; run memory.mjs reembed");
      expect(res.stderr).not.toContain("degraded to keyword-only");
      expect(res.stdout.split("\n")[0]).toMatch(/^recall: hybrid/);
    } finally {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a fully vectored hybrid recall prints no WARNING", async () => {
    const dir = tempDir();
    const server = await startFakeOllama();
    try {
      seedLessons(dir, ["flaky retry one", "flaky retry two"]);
      writeMemoryConfig(dir, EMBED_CFG(serverBaseUrl(server)));
      const res = await runAsync(["recall", "flaky retry", dir], dir);
      expect(res.status, res.stderr).toBe(0);
      expect(res.stderr).not.toContain("WARNING");
    } finally {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("(D5) reembed with one failing batch ends with the still-unvectored warning on stderr, exit status unchanged (0)", async () => {
    const dir = tempDir();
    const server = await startFakeOllama({}, { failOn: "poison" });
    try {
      seedLessons(dir, ["lesson one", "lesson two", "lesson poison"], { vectored: 0 });
      writeMemoryConfig(dir, EMBED_CFG(serverBaseUrl(server)));
      const res = await runAsync(["reembed", dir, "--batch", "1", "--no-check"], dir);
      expect(res.status, res.stderr).toBe(0);
      expect(res.stdout).toMatch(/Embedded 2\/3 lesson\(s\)/);
      const lines = stderrLines(res).filter(Boolean);
      expect(lines[lines.length - 1]).toBe("WARNING: 1 of 3 lessons still have no vector for embeddinggemma/4; retry with memory.mjs reembed --batch 4");
    } finally {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("(D5) a reembed that vectors every lesson prints no WARNING", async () => {
    const dir = tempDir();
    const server = await startFakeOllama();
    try {
      seedLessons(dir, ["lesson one", "lesson two"], { vectored: 0 });
      writeMemoryConfig(dir, EMBED_CFG(serverBaseUrl(server)));
      const res = await runAsync(["reembed", dir, "--no-check"], dir);
      expect(res.status, res.stderr).toBe(0);
      expect(res.stderr).not.toContain("WARNING");
    } finally {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("index search prints the code-index warning (with `memory.mjs index build`) when a configured provider has no vectors", async () => {
    const dir = gitRepoDir({ "src/upload.mjs": "// retry flaky uploads here\nexport const x = 1;\n" });
    const build = run(["index", "build", dir], dir);
    expect(build.status, build.stderr).toBe(0);
    writeMemoryConfig(dir, EMBED_CFG("http://127.0.0.1:1"));
    const res = await runAsync(["index", "search", "retry flaky uploads", dir], dir);
    expect(res.status, res.stderr).toBe(0);
    expect(stderrLines(res)).toContain("WARNING: code index search degraded to keyword-only: no vectors stored for embeddinggemma/4; run memory.mjs index build");
    expect(res.stdout.split("\n")[0]).toMatch(/^index: keyword-only \(no vectors stored for embeddinggemma\/4\)/);
    rmSync(dir, { recursive: true, force: true });
  });
});

// card recall-fallback-warning review findings: the probe is bounded, runs only when no provider is configured,
// and never POSTs an embed.
describe("memory.mjs recall: Ollama probe discipline (card recall-fallback-warning)", () => {
  function recordingServer(handler) {
    const seen = [];
    const server = createServer((req, res) => {
      seen.push(`${req.method} ${req.url}`);
      handler(req, res);
    });
    return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ server, seen })));
  }
  const seedOne = (dir) => {
    const m = openMemory(dir);
    addLesson(m, { text: "flaky tests need a retry policy", kind: "pattern", source: { agent: "worker" } });
    m.close();
  };

  it("a probe server that accepts and never answers: recall exits 0 in under 3000 ms with no WARNING", async () => {
    const { server, seen } = await recordingServer(() => {});
    const dir = tempDir();
    try {
      seedOne(dir);
      const started = Date.now();
      const res = await runAsync(["recall", "flaky tests", dir], dir, probeEnv(server));
      const elapsed = Date.now() - started;
      expect(res.status, res.stderr).toBe(0);
      expect(elapsed).toBeLessThan(3000);
      expect(res.stderr).not.toContain("WARNING");
      expect(seen.length).toBeGreaterThan(0); // the probe really ran against this server
    } finally {
      server.closeAllConnections();
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the probe shares ONE 1500 ms deadline: version and tags each answering after ~1000 ms means no detection, exit 0 in under 2000 ms", async () => {
    const { server } = await recordingServer((req, res) => {
      setTimeout(() => {
        if (res.destroyed || res.writableEnded) return;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          req.url === "/api/version"
            ? JSON.stringify({ version: "0.30.10" })
            : JSON.stringify({ models: [{ name: "embeddinggemma:latest", model: "embeddinggemma:latest" }] })
        );
      }, 1000);
    });
    const dir = tempDir();
    try {
      seedOne(dir);
      const started = Date.now();
      const res = await runAsync(["recall", "flaky tests", dir], dir, probeEnv(server));
      const elapsed = Date.now() - started;
      expect(res.status, res.stderr).toBe(0);
      expect(elapsed).toBeLessThan(2000);
      expect(res.stderr).not.toContain("WARNING");
      expect(res.stderr).not.toContain("is available");
    } finally {
      server.closeAllConnections();
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("with a provider configured, recall makes no request to the probe server", async () => {
    const { server, seen } = await recordingServer(nothingThereHandler);
    const dir = tempDir();
    try {
      seedOne(dir);
      writeMemoryConfig(dir, { provider: "openai-compatible", baseUrl: "http://127.0.0.1:1", model: "embeddinggemma", dims: 4 });
      const res = await runAsync(["recall", "flaky tests", dir], dir, probeEnv(server));
      expect(res.status, res.stderr).toBe(0);
      expect(seen).toEqual([]);
    } finally {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the probe sends only GET requests, never POST /v1/embeddings", async () => {
    const { server, seen } = await recordingServer(nothingThereHandler);
    const dir = tempDir();
    try {
      seedOne(dir);
      const res = await runAsync(["recall", "flaky tests", dir], dir, probeEnv(server));
      expect(res.status, res.stderr).toBe(0);
      expect(seen.length).toBeGreaterThan(0);
      for (const r of seen) expect(r.startsWith("GET "), r).toBe(true);
    } finally {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("memory.mjs doctor", () => {
  it("says keyword-only and gives the enable snippet with no provider configured", async () => {
    const dir = tempDir();
    const hits = [];
    const server = await listenForProbe((req, res) => { hits.push(req.url); nothingThereHandler(req, res); });
    try {
      const res = await runAsync(["doctor", dir], dir, probeEnv(server));
      expect(res.status, res.stderr).toBe(0);
      expect(res.stdout).toMatch(/keyword-only/);
      expect(res.stdout).toMatch(/"provider": "openai-compatible"/);
      expect(hits.length, "the unconfigured probe must go to DOUG_OLLAMA_BASE_URL").toBeGreaterThanOrEqual(1);
      expect(hits).toContain("/api/version");
    } finally {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a configured memory.embeddings.baseUrl wins over DOUG_OLLAMA_BASE_URL", async () => {
    const dir = tempDir();
    const hitsA = [];
    const hitsB = [];
    const serverA = await listenForProbe((req, res) => { hitsA.push(req.url); fakeOllamaHandler(req, res); });
    const serverB = await listenForProbe((req, res) => { hitsB.push(req.url); fakeOllamaHandler(req, res); });
    try {
      writeMemoryConfig(dir, { provider: "openai-compatible", baseUrl: serverBaseUrl(serverA), model: "embeddinggemma", dims: 4 });
      const res = await runAsync(["doctor", dir], dir, probeEnv(serverB));
      expect(res.status, res.stderr).toBe(0);
      expect(hitsA.length).toBeGreaterThanOrEqual(1);
      expect(hitsB).toHaveLength(0);
    } finally {
      serverA.close();
      serverB.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports what it found against a fake Ollama", async () => {
    const dir = tempDir();
    const server = await startFakeOllama();
    try {
      writeMemoryConfig(dir, { provider: "openai-compatible", baseUrl: serverBaseUrl(server), model: "embeddinggemma", dims: 4 });
      const res = await runAsync(["doctor", dir], dir);
      expect(res.status, res.stderr).toBe(0);
      expect(res.stdout).toMatch(/embeddinggemma\/4/);
      expect(res.stdout).not.toMatch(/keyword-only/);

      const json = await runAsync(["doctor", dir, "--json"], dir);
      const parsed = JSON.parse(json.stdout);
      expect(parsed.probe.reachable).toBe(true);
      expect(parsed.probe.modelPresent).toBe(true);
    } finally {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("(MINOR 8) prints the invalid-config warning exactly once, not once per internal read", async () => {
    const dir = tempDir();
    const hits = [];
    const server = await listenForProbe((req, res) => { hits.push(req.url); nothingThereHandler(req, res); });
    try {
      mkdirSync(join(dir, ".doug"), { recursive: true });
      writeFileSync(join(dir, ".doug", "config.json"), JSON.stringify({ memory: { embeddings: { provider: "bogus" } } }), "utf8");
      const res = await runAsync(["doctor", dir], dir, probeEnv(server));
      expect(res.status, res.stderr).toBe(0);
      const warnings = res.stderr.split("\n").filter((l) => l.includes("memory.embeddings is not a valid shape"));
      expect(warnings).toHaveLength(1);
      expect(hits.length, "an invalid config probes the override URL, not localhost:11434").toBeGreaterThanOrEqual(1);
    } finally {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("memory.mjs doctor: unsloth preset (card embedding-providers-unsloth)", () => {
  // Fake keys are built at runtime: no credential-looking literal in this file.
  const goodToken = ["unsloth", "test", "token", String(process.pid)].join("-");
  const testToken = ["unsloth", "wrong", "token", String(process.pid)].join("-");

  function startModelsServer(accept, models) {
    return new Promise((resolvePromise) => {
      const server = createServer((req, res) => {
        res.setHeader("content-type", "application/json");
        if (req.url === "/v1/models") {
          if (req.headers.authorization !== `Bearer ${accept}`) {
            res.writeHead(401);
            res.end(JSON.stringify({ detail: "Not authenticated" }));
            return;
          }
          res.writeHead(200);
          res.end(JSON.stringify({ object: "list", data: models }));
          return;
        }
        res.writeHead(404);
        res.end("{}");
      });
      server.listen(0, "127.0.0.1", () => resolvePromise(server));
    });
  }

  it("a missing key names UNSLOTH_API_KEY, and a wrong key's value never appears in stdout or stderr", async () => {
    const dir = tempDir();
    const server = await startModelsServer(goodToken, [{ id: "ggml-org/embeddinggemma-300M-GGUF", loaded: true }]);
    try {
      writeMemoryConfig(dir, { preset: "unsloth", baseUrl: serverBaseUrl(server), model: "embeddinggemma", dims: 512 });
      const noKey = await runAsync(["doctor", dir], dir, { UNSLOTH_API_KEY: "" });
      expect(noKey.status, noKey.stderr).toBe(0);
      expect(noKey.stdout).toMatch(/server requires a key: set UNSLOTH_API_KEY/);

      const wrong = await runAsync(["doctor", dir], dir, { UNSLOTH_API_KEY: testToken });
      expect(wrong.status, wrong.stderr).toBe(0);
      expect(wrong.stdout).toMatch(/server rejected the key in UNSLOTH_API_KEY/);
      expect(wrong.stdout + wrong.stderr).not.toContain(testToken);
      const json = await runAsync(["doctor", dir, "--json"], dir, { UNSLOTH_API_KEY: testToken });
      expect(json.stdout + json.stderr).not.toContain(testToken);
    } finally {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("with the right key it reports the model listed and loaded, without printing the key", async () => {
    const dir = tempDir();
    const server = await startModelsServer(goodToken, [{ id: "ggml-org/embeddinggemma-300M-GGUF", loaded: true }]);
    try {
      writeMemoryConfig(dir, { preset: "unsloth", baseUrl: serverBaseUrl(server), model: "embeddinggemma", dims: 512 });
      const json = await runAsync(["doctor", dir, "--json"], dir, { UNSLOTH_API_KEY: goodToken });
      expect(json.status, json.stderr).toBe(0);
      const parsed = JSON.parse(json.stdout);
      expect(parsed.probe.reachable).toBe(true);
      expect(parsed.probe.modelPresent).toBe(true);
      expect(parsed.probe.modelLoaded).toBe(true);
      expect(json.stdout + json.stderr).not.toContain(goodToken);
    } finally {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("doctor --json and text never contain the key when the server echoes it in a 500 body", async () => {
    const dir = tempDir();
    const server = await new Promise((resolvePromise) => {
      const s = createServer((req, res) => {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ detail: `rejected ${String(req.headers.authorization)} as ${String(req.headers.authorization).replace("Bearer ", "")}` }));
      });
      s.listen(0, "127.0.0.1", () => resolvePromise(s));
    });
    try {
      writeMemoryConfig(dir, { preset: "unsloth", baseUrl: serverBaseUrl(server), model: "embeddinggemma", dims: 512 });
      const json = await runAsync(["doctor", dir, "--json"], dir, { UNSLOTH_API_KEY: testToken });
      expect(json.status, json.stderr).toBe(0);
      expect(json.stdout + json.stderr).not.toContain(testToken);
      const text = await runAsync(["doctor", dir], dir, { UNSLOTH_API_KEY: testToken });
      expect(text.stdout + text.stderr).not.toContain(testToken);
      expect(JSON.parse(json.stdout).probe.reachable).toBe(false);
    } finally {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("doctor never prints the key when a voyage-preset or no-preset embed probe gets an echoing 400", async () => {
    const dir = tempDir();
    const server = await new Promise((resolvePromise) => {
      const s = createServer((req, res) => {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ detail: `rejected ${String(req.headers.authorization)}` }));
      });
      s.listen(0, "127.0.0.1", () => resolvePromise(s));
    });
    try {
      const cases = [
        [{ preset: "voyage", baseUrl: serverBaseUrl(server), model: "voyage-4", dims: 4 }, { VOYAGE_API_KEY: testToken }],
        [{ provider: "openai-compatible", baseUrl: serverBaseUrl(server), model: "m", dims: 4, apiKeyEnv: "MY_EMBED_ENV" }, { MY_EMBED_ENV: testToken }],
      ];
      for (const [conf, env] of cases) {
        writeMemoryConfig(dir, conf);
        const json = await runAsync(["doctor", dir, "--json"], dir, env);
        expect(json.status, json.stderr).toBe(0);
        expect(JSON.parse(json.stdout).probe.reason).toMatch(/HTTP 400/);
        expect(json.stdout + json.stderr).not.toContain(testToken);
        const text = await runAsync(["doctor", dir], dir, env);
        expect(text.stdout + text.stderr).not.toContain(testToken);
      }
    } finally {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("with nothing configured it prints one snippet per preset", async () => {
    const dir = tempDir();
    const hits = [];
    const server = await listenForProbe((req, res) => { hits.push(req.url); nothingThereHandler(req, res); });
    try {
      const res = await runAsync(["doctor", dir], dir, probeEnv(server));
      expect(res.status, res.stderr).toBe(0);
      for (const p of ["ollama", "unsloth", "openai", "voyage"]) expect(res.stdout, p).toMatch(new RegExp(`"preset": "${p}"`));
      expect(hits.length, "the unconfigured probe must go to DOUG_OLLAMA_BASE_URL").toBeGreaterThanOrEqual(1);
    } finally {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("memory.mjs embed-check", () => {
  it("prints ok and exits 0 when paraphrases clear the margin over unrelated pairs", async () => {
    const dir = tempDir();
    const { file, vectorsByText } = writeSanityPairsFixture(dir, { margin: 0.15, paraphraseCosine: 0.9, unrelatedCosine: 0.1 });
    const server = await startFakeOllama(vectorsByText);
    try {
      writeMemoryConfig(dir, { provider: "openai-compatible", baseUrl: serverBaseUrl(server), model: "test-embed", dims: 2 });
      const res = await runAsync(["embed-check", dir, "--pairs", file], dir);
      expect(res.status, res.stderr).toBe(0);
      expect(res.stdout).toMatch(/embed-check: ok \(gap 0\.80 >= margin 0\.15; paraphrase mean 0\.90, unrelated mean 0\.10\)/);

      const json = await runAsync(["embed-check", dir, "--pairs", file, "--json"], dir);
      expect(json.status, json.stderr).toBe(0);
      const result = JSON.parse(json.stdout);
      expect(result.ok).toBe(true);
      expect(result.failures).toEqual([]);
    } finally {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("FAILS and exits 1 on a margin-only miss, with no offending pair listed", async () => {
    const dir = tempDir();
    // Every paraphrase and every unrelated pair scores the same 0.5, so the mean gap is 0 (< margin) but no
    // single paraphrase pair falls below the unrelated mean.
    const { file, vectorsByText } = writeSanityPairsFixture(dir, { margin: 0.15, paraphraseCosine: 0.5, unrelatedCosine: 0.5 });
    const server = await startFakeOllama(vectorsByText);
    try {
      writeMemoryConfig(dir, { provider: "openai-compatible", baseUrl: serverBaseUrl(server), model: "test-embed", dims: 2 });
      const res = await runAsync(["embed-check", dir, "--pairs", file], dir);
      expect(res.status).toBe(1);
      expect(res.stdout).toMatch(/embed-check: FAILED \(gap 0\.0000 is below the margin 0\.15\)/);
      expect(res.stdout.trim().split("\n")).toHaveLength(1);
    } finally {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("FAILS and exits 1 with the offending pair on its own line when one paraphrase pair scores below the unrelated mean", async () => {
    const dir = tempDir();
    const { file, vectorsByText } = writeSanityPairsFixture(dir, {
      margin: 0.15,
      paraphraseCosine: 0.9,
      unrelatedCosine: 0.1,
      overrides: { "sanity paraphrase 5 b": [0.05, Math.sqrt(1 - 0.05 * 0.05)] },
    });
    const server = await startFakeOllama(vectorsByText);
    try {
      writeMemoryConfig(dir, { provider: "openai-compatible", baseUrl: serverBaseUrl(server), model: "test-embed", dims: 2 });
      const res = await runAsync(["embed-check", dir, "--pairs", file], dir);
      expect(res.status).toBe(1);
      expect(res.stdout).toMatch(/embed-check: FAILED \(1 paraphrase pair\(s\) scored below the unrelated mean/);
      expect(res.stdout).toMatch(/sanity paraphrase 5 a.*sanity paraphrase 5 b.*cosine 0\.0500/);
    } finally {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses, naming the path and --pairs, when the pairs file is missing", () => {
    const dir = tempDir();
    writeMemoryConfig(dir, { provider: "openai-compatible", baseUrl: "http://127.0.0.1:1", model: "test-embed", dims: 2 });
    const missing = join(dir, "does-not-exist.json");
    const res = run(["embed-check", dir, "--pairs", missing], dir);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain(missing);
    expect(res.stderr).toContain("--pairs");
    rmSync(dir, { recursive: true, force: true });
  });

  it("exits 1 when no embedding provider is configured", () => {
    const dir = tempDir();
    const res = run(["embed-check", dir], dir);
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/no embedding provider configured/);
    rmSync(dir, { recursive: true, force: true });
  });

  it("exits 2 and prints the usage when --pairs is given with no value, before any provider check", () => {
    const dir = tempDir();
    // No memory config written at all: a provider check would fail with exit 1 first if usage validation
    // did not run before it.
    const res = run(["embed-check", dir, "--pairs"], dir);
    expect(res.status).toBe(2);
    expect(res.stderr).toContain("usage: memory.mjs embed-check [dir] [--pairs <file>] [--json]");
    expect(res.stderr).toMatch(/--pairs/);
    rmSync(dir, { recursive: true, force: true });
  });

  it("exits 2 and prints the usage on an unknown flag, before any provider check", () => {
    const dir = tempDir();
    const res = run(["embed-check", dir, "--bogus"], dir);
    expect(res.status).toBe(2);
    expect(res.stderr).toContain("usage: memory.mjs embed-check [dir] [--pairs <file>] [--json]");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("memory.mjs reembed", () => {
  it("refuses with a clear line and exit 1 when no provider is configured", () => {
    const dir = tempDir();
    const res = run(["reembed", dir], dir);
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/no embedding provider configured/);
    rmSync(dir, { recursive: true, force: true });
  });

  it("(MINOR 7) refuses a --batch that is not an integer >= 1, exit 2 with usage, rather than looping forever", () => {
    const dir = tempDir();
    writeMemoryConfig(dir, { provider: "openai-compatible", baseUrl: "http://127.0.0.1:1", model: "embeddinggemma", dims: 4 });
    for (const bad of ["0", "-1", "abc", "1.5"]) {
      const res = run(["reembed", dir, "--batch", bad], dir);
      expect(res.status, `--batch ${bad}: ${res.stderr}`).toBe(2);
      expect(res.stderr).toContain("usage");
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it("--check and --no-check together are a usage error, exit 2", () => {
    const dir = tempDir();
    writeMemoryConfig(dir, { provider: "openai-compatible", baseUrl: "http://127.0.0.1:1", model: "embeddinggemma", dims: 4 });
    const res = run(["reembed", dir, "--check", "--no-check"], dir);
    expect(res.status).toBe(2);
    expect(res.stderr).toContain("usage");
    rmSync(dir, { recursive: true, force: true });
  });

  it("prints a progress line per batch on stderr and embeds every pending lesson; a second reembed under the same model then skips the check entirely", async () => {
    const dir = tempDir();
    const server = await startFakeOllama();
    try {
      // Add two lessons with no provider configured yet, so neither is embedded by lesson add's own
      // best-effort step; reembed then has real work to do once the provider is configured. The fixed-vector
      // fake would fail the cosine sanity check (every vector identical), so this first, model-changing
      // reembed uses --no-check — the escape hatch documented for exactly this kind of non-semantic double.
      run(["lesson", "add", "--text", "lesson one", "--kind", "pattern", dir], dir);
      run(["lesson", "add", "--text", "lesson two", "--kind", "pattern", dir], dir);
      writeMemoryConfig(dir, { provider: "openai-compatible", baseUrl: serverBaseUrl(server), model: "embeddinggemma", dims: 4 });

      const res = await runAsync(["reembed", dir, "--batch", "1", "--no-check"], dir);
      expect(res.status, res.stderr).toBe(0);
      expect(res.stderr).toMatch(/embed-check: skipped \(--no-check\)/);
      expect(res.stdout).toMatch(/Embedded 2\/2 lesson\(s\)/);
      expect(res.stderr.trim().split("\n")).toEqual(["embed-check: skipped (--no-check)", "embedded 1/2", "embedded 2/2"]);

      // Every lesson is now embedded under embeddinggemma/4, so this reembed is not a model/dims change: the
      // check must not run even without --no-check, and it does not fail against the same fixed-vector fake.
      const json = await runAsync(["reembed", dir, "--json"], dir);
      expect(json.status, json.stderr).toBe(0);
      expect(json.stderr).not.toMatch(/embed-check/);
      const result = JSON.parse(json.stdout);
      expect(result).toEqual({ total: 0, embedded: 0, failed: 0, reason: null, check: "not-needed" });
    } finally {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("on a fresh store, the sanity check FAILS against the fixed-vector fake and reembed embeds nothing", async () => {
    const dir = tempDir();
    const server = await startFakeOllama();
    try {
      run(["lesson", "add", "--text", "lesson one", "--kind", "pattern", dir], dir);
      run(["lesson", "add", "--text", "lesson two", "--kind", "pattern", dir], dir);
      writeMemoryConfig(dir, { provider: "openai-compatible", baseUrl: serverBaseUrl(server), model: "embeddinggemma", dims: 4 });
      const { file } = writeSanityPairsFixture(dir, { margin: 0.15 });

      const res = await runAsync(["reembed", dir, "--pairs", file], dir);
      expect(res.status).toBe(1);
      expect(res.stdout).toMatch(/embed-check: FAILED/);
      expect(res.stderr).toMatch(/embed-check failed; refusing to reembed/);

      const all = JSON.parse(run(["lessons", dir, "--json"], dir).stdout);
      expect(all.every((l) => l.embedding_model === null)).toBe(true);
    } finally {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--check forces the sanity check even when the model/dims haven't changed, still failing against the fixed-vector fake", async () => {
    const dir = tempDir();
    const server = await startFakeOllama();
    try {
      run(["lesson", "add", "--text", "lesson one", "--kind", "pattern", dir], dir);
      writeMemoryConfig(dir, { provider: "openai-compatible", baseUrl: serverBaseUrl(server), model: "embeddinggemma", dims: 4 });
      const embedded = await runAsync(["reembed", dir, "--no-check"], dir);
      expect(embedded.status, embedded.stderr).toBe(0);

      const { file } = writeSanityPairsFixture(dir, { margin: 0.15 });
      const res = await runAsync(["reembed", dir, "--pairs", file, "--check"], dir);
      expect(res.status).toBe(1);
      expect(res.stdout).toMatch(/embed-check: FAILED/);
    } finally {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("memory.mjs lesson add / import: best-effort embedding", () => {
  it("embeds the new lesson when a provider is configured, readable back as a hybrid recall vector", async () => {
    const dir = tempDir();
    const server = await startFakeOllama();
    try {
      writeMemoryConfig(dir, { provider: "openai-compatible", baseUrl: serverBaseUrl(server), model: "embeddinggemma", dims: 4 });
      // Establish embeddinggemma/4 as already used in this store first (see the reviewer-MAJOR-1 test below):
      // best-effort add never embeds a model/dims pair that is new to the store.
      run(["lesson", "add", "--text", "seed lesson", "--kind", "pattern", dir], dir);
      const seed = await runAsync(["reembed", dir, "--no-check"], dir);
      expect(seed.status, seed.stderr).toBe(0);

      const res = await runAsync(["lesson", "add", "--text", "retry flaky uploads", "--kind", "pattern", dir, "--json"], dir);
      expect(res.status, res.stderr).toBe(0);
      const row = JSON.parse(res.stdout);
      expect(row.embedding_model).toBe("embeddinggemma");
      expect(row.embedding_dims).toBe(4);
    } finally {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("prints one stderr note and still exits 0 when the configured provider is unreachable (once the model is already established)", async () => {
    const dir = tempDir();
    const server = await startFakeOllama();
    try {
      writeMemoryConfig(dir, { provider: "openai-compatible", baseUrl: serverBaseUrl(server), model: "embeddinggemma", dims: 4 });
      run(["lesson", "add", "--text", "seed lesson", "--kind", "pattern", dir], dir);
      const seed = await runAsync(["reembed", dir, "--no-check"], dir);
      expect(seed.status, seed.stderr).toBe(0);
    } finally {
      server.close();
    }
    writeMemoryConfig(dir, { provider: "openai-compatible", baseUrl: "http://127.0.0.1:1", model: "embeddinggemma", dims: 4 });
    const res = run(["lesson", "add", "--text", "retry flaky uploads", "--kind", "pattern", dir], dir);
    expect(res.status, res.stderr).toBe(0);
    expect(res.stderr).toMatch(/Note: embedding with .* failed for 1 lesson\(s\)/);
    rmSync(dir, { recursive: true, force: true });
  });

  it("(MINOR 13) embeds only the row just added; a pre-existing pending row is left alone", async () => {
    const dir = tempDir();
    const server = await startFakeOllama();
    try {
      writeMemoryConfig(dir, { provider: "openai-compatible", baseUrl: serverBaseUrl(server), model: "embeddinggemma", dims: 4 });
      run(["lesson", "add", "--text", "seed lesson", "--kind", "pattern", dir], dir);
      const seed = await runAsync(["reembed", dir, "--no-check"], dir);
      expect(seed.status, seed.stderr).toBe(0);

      // Provider unreachable for this one add, so it fails to embed and stays pending — same as any other
      // best-effort embedding failure, unrelated to the new-model gate (the model is already established above).
      writeMemoryConfig(dir, { provider: "openai-compatible", baseUrl: "http://127.0.0.1:1", model: "embeddinggemma", dims: 4 });
      const pendingRes = run(["lesson", "add", "--text", "pending lesson one", "--kind", "pattern", dir, "--json"], dir);
      expect(pendingRes.status, pendingRes.stderr).toBe(0);
      const pending = JSON.parse(pendingRes.stdout);
      expect(pending.embedding_model).toBeNull();

      writeMemoryConfig(dir, { provider: "openai-compatible", baseUrl: serverBaseUrl(server), model: "embeddinggemma", dims: 4 });
      const freshRes = await runAsync(["lesson", "add", "--text", "fresh lesson two", "--kind", "pattern", dir, "--json"], dir);
      expect(freshRes.status, freshRes.stderr).toBe(0);
      const fresh = JSON.parse(freshRes.stdout);
      expect(fresh.embedding_model).toBe("embeddinggemma");

      const all = JSON.parse(run(["lessons", dir, "--json"], dir).stdout);
      const stillPending = all.find((l) => l.id === pending.id);
      expect(stillPending.embedding_model).toBeNull();
    } finally {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("(reviewer MAJOR 1) never embeds a lesson under a model/dims pair new to the store; the following reembed then runs the sanity check and refuses", async () => {
    const dir = tempDir();
    const server = await startFakeOllama();
    try {
      run(["lesson", "add", "--text", "lesson one", "--kind", "pattern", dir], dir);
      run(["lesson", "add", "--text", "lesson two", "--kind", "pattern", dir], dir);
      writeMemoryConfig(dir, { provider: "openai-compatible", baseUrl: serverBaseUrl(server), model: "embeddinggemma", dims: 4 });

      const addRes = await runAsync(["lesson", "add", "--text", "third lesson", "--kind", "pattern", dir, "--json"], dir);
      expect(addRes.status, addRes.stderr).toBe(0);
      const added = JSON.parse(addRes.stdout);
      expect(added.embedding_model).toBeNull();
      expect(addRes.stderr).toMatch(/embeddinggemma\/4 is new to this store/);
      expect(addRes.stderr).toMatch(/memory\.mjs reembed/);

      const beforeReembed = JSON.parse(run(["lessons", dir, "--json"], dir).stdout);
      expect(beforeReembed.every((l) => l.embedding_model === null)).toBe(true);

      // The following reembed is the one place a new model/dims pair may be committed to — and only past its
      // sanity check. The fixed-vector fake fails that check, so nothing gets embedded here either.
      const { file } = writeSanityPairsFixture(dir, { margin: 0.15 });
      const reembedRes = await runAsync(["reembed", dir, "--pairs", file], dir);
      expect(reembedRes.status).toBe(1);
      expect(reembedRes.stdout).toMatch(/embed-check: FAILED/);

      const afterReembed = JSON.parse(run(["lessons", dir, "--json"], dir).stdout);
      expect(afterReembed.every((l) => l.embedding_model === null)).toBe(true);
    } finally {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("(MINOR 6) reembed --json reports whether the check ran: skipped, not-needed, or ok", async () => {
    const dir = tempDir();
    const { file, vectorsByText } = writeSanityPairsFixture(dir, { margin: 0.15, paraphraseCosine: 0.9, unrelatedCosine: 0.1 });
    const server = await startFakeOllama(vectorsByText);
    try {
      writeMemoryConfig(dir, { provider: "openai-compatible", baseUrl: serverBaseUrl(server), model: "test-embed", dims: 2 });
      run(["lesson", "add", "--text", "sanity paraphrase 0 a", "--kind", "pattern", dir], dir);

      const skipped = await runAsync(["reembed", dir, "--no-check", "--json"], dir);
      expect(skipped.status, skipped.stderr).toBe(0);
      expect(JSON.parse(skipped.stdout).check).toBe("skipped");

      const notNeeded = await runAsync(["reembed", dir, "--json"], dir);
      expect(notNeeded.status, notNeeded.stderr).toBe(0);
      expect(JSON.parse(notNeeded.stdout).check).toBe("not-needed");

      run(["lesson", "add", "--text", "another lesson", "--kind", "pattern", dir], dir);
      const forcedOk = await runAsync(["reembed", dir, "--pairs", file, "--check", "--json"], dir);
      expect(forcedOk.status, forcedOk.stderr).toBe(0);
      expect(JSON.parse(forcedOk.stdout).check).toBe("ok");
    } finally {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// A real temp git repo for `index build`/`status`/`search`, which need `git ls-files` under the hood.
function gitRepoDir(files = { "README.md": "readme\n" }) {
  const dir = tempDir();
  const g = (...args) => spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  g("init", "-q", "-b", "main");
  g("config", "user.email", "t@example.com");
  g("config", "user.name", "t");
  for (const [p, content] of Object.entries(files)) {
    const abs = join(dir, p);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  g("add", "-A");
  g("commit", "-q", "-m", "base");
  return dir;
}

describe("memory.mjs index build", () => {
  it("populates the index and prints a keyword-only summary line with no provider; --json returns the buildIndex result", () => {
    const dir = gitRepoDir({ "src/a.mjs": "export const a = 1;\n", "src/b.mjs": "export const b = 2;\n" });
    const res = run(["index", "build", dir], dir);
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toMatch(/^index: 2 files, \d+ chunks \(2 changed, 0 removed\); keyword-only \(no provider configured\)/);

    const json = run(["index", "build", dir, "--json"], dir);
    expect(json.status, json.stderr).toBe(0);
    const result = JSON.parse(json.stdout);
    expect(result.files).toBe(2);
    expect(result.filesChanged).toBe(0); // already built above; nothing changed since
    expect(result.reason).toBe("no provider configured");
    rmSync(dir, { recursive: true, force: true });
  });

  it("exits 0 keyword-only when the configured provider is at a closed port, never nonzero for a down provider", () => {
    const dir = gitRepoDir({ "src/a.mjs": "export const a = 1;\n" });
    writeMemoryConfig(dir, { provider: "openai-compatible", baseUrl: "http://127.0.0.1:1", model: "embeddinggemma", dims: 4 });
    const res = run(["index", "build", dir], dir);
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toMatch(/keyword-only/);
    rmSync(dir, { recursive: true, force: true });
  });

  it("embeds under a working provider with --no-check, reporting the model/dims in the summary line", async () => {
    const dir = gitRepoDir({ "src/a.mjs": "export const a = 1;\n" });
    const server = await startFakeOllama();
    try {
      writeMemoryConfig(dir, { provider: "openai-compatible", baseUrl: serverBaseUrl(server), model: "embeddinggemma", dims: 4 });
      const res = await runAsync(["index", "build", dir, "--no-check"], dir);
      expect(res.status, res.stderr).toBe(0);
      expect(res.stdout).toMatch(/embedded \d+ of \d+ under embeddinggemma\/4 in [\d.]+s/);
    } finally {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exits 2 with usage on a bad --batch, before touching the provider or the git repo", () => {
    const dir = gitRepoDir();
    for (const bad of ["0", "-1", "abc"]) {
      const res = run(["index", "build", dir, "--batch", bad], dir);
      expect(res.status, `--batch ${bad}: ${res.stderr}`).toBe(2);
      expect(res.stderr).toContain("usage");
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it("exits 2 with usage when --check and --no-check are both given", () => {
    const dir = gitRepoDir();
    const res = run(["index", "build", dir, "--check", "--no-check"], dir);
    expect(res.status).toBe(2);
    expect(res.stderr).toContain("usage");
    rmSync(dir, { recursive: true, force: true });
  });

  it("a non-git directory exits nonzero naming the failure, never a stack trace", () => {
    const dir = tempDir();
    const res = run(["index", "build", dir], dir);
    expect(res.status).not.toBe(0);
    expect(res.stderr.toLowerCase()).toMatch(/git/);
    rmSync(dir, { recursive: true, force: true });
  });

  it("(review MINOR 2, MINOR 3) prints embedSeconds to one decimal, and appends '<n> failed (<reason>)' on a partial embed failure", async () => {
    const dir = gitRepoDir({
      "src/a.mjs": "export const a = 1;\n",
      "src/b.mjs": "export const b = 2;\n",
      "src/c.mjs": "export const c = 3;\n",
    });
    let requestCount = 0;
    // Fails exactly the second of three batch-of-1 requests, so the build has a genuine partial failure
    // (2 embedded, 1 failed) rather than an all-or-nothing outcome.
    const server = createServer((req, res) => {
      if (req.url !== "/v1/embeddings") {
        res.writeHead(404, { "content-type": "application/json" });
        res.end("{}");
        return;
      }
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        requestCount++;
        if (requestCount === 2) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "boom" }));
          return;
        }
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const dims = body.dimensions || 4;
        const data = body.input.map((_, i) => ({ index: i, embedding: Array.from({ length: dims }, (_, j) => (j === 0 ? 1 : 0)) }));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data }));
      });
    });
    await new Promise((resolveReady) => server.listen(0, "127.0.0.1", resolveReady));
    try {
      writeMemoryConfig(dir, { provider: "openai-compatible", baseUrl: serverBaseUrl(server), model: "embeddinggemma", dims: 4 });
      const res = await runAsync(["index", "build", dir, "--batch", "1", "--no-check"], dir);
      expect(res.status, res.stderr).toBe(0);
      expect(res.stdout).toMatch(/embedded 2 of 3 under embeddinggemma\/4 in \d+\.\ds; 1 failed \(HTTP 500/);
    } finally {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("memory.mjs index status", () => {
  it("prints built: never and every size count 0 on a never-built index, counting every file as added", () => {
    const dir = gitRepoDir({ "src/a.mjs": "export const a = 1;\n", "src/b.mjs": "export const b = 2;\n" });
    const res = run(["index", "status", dir], dir);
    expect(res.status, res.stderr).toBe(0);
    const lines = res.stdout.trim().split("\n");
    expect(lines[0]).toMatch(/^index: 0 files, 0 chunks, 0 bytes of text, \d+ bytes on disk$/);
    expect(lines[1]).toBe("embedded: none (no provider configured)");
    expect(lines[2]).toBe("built: never");
    expect(lines[3]).toMatch(/^refresh: 2 added, 0 changed, 0 removed; \d+ chunks to embed, time unmeasured \(no measured build\)$/);

    const json = run(["index", "status", dir, "--json"], dir);
    expect(json.status, json.stderr).toBe(0);
    const result = JSON.parse(json.stdout);
    expect(result.files).toBe(0);
    expect(result.built).toBeNull();
    expect(result.refresh.added).toBe(2);
    rmSync(dir, { recursive: true, force: true });
  });

  it("reports real counts and HEAD equality after a build", () => {
    const dir = gitRepoDir({ "src/a.mjs": "export const a = 1;\n" });
    const build = run(["index", "build", dir], dir);
    expect(build.status, build.stderr).toBe(0);
    const res = run(["index", "status", dir], dir);
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toMatch(/^index: 1 files, \d+ chunks, \d+ bytes of text, \d+ bytes on disk/);
    expect(res.stdout).toMatch(/built: .* \(current\)/);
    rmSync(dir, { recursive: true, force: true });
  });

  it("(review MINOR 1) prints '0 chunks to embed' with no time clause when nothing is pending", () => {
    const dir = gitRepoDir({ "src/a.mjs": "export const a = 1;\n" });
    const build = run(["index", "build", dir], dir);
    expect(build.status, build.stderr).toBe(0);
    const res = run(["index", "status", dir], dir);
    expect(res.status, res.stderr).toBe(0);
    const refreshLine = res.stdout.trim().split("\n").find((l) => l.startsWith("refresh:"));
    expect(refreshLine).toBe("refresh: 0 added, 0 changed, 0 removed; 0 chunks to embed");
    rmSync(dir, { recursive: true, force: true });
  });

  it("(review MAJOR 1) a no-op rebuild does not wipe an earlier build's measured rate", async () => {
    const dir = gitRepoDir({ "src/a.mjs": "export const a = 1;\n" });
    const server = await startFakeOllama();
    try {
      writeMemoryConfig(dir, { provider: "openai-compatible", baseUrl: serverBaseUrl(server), model: "embeddinggemma", dims: 4 });
      const built = await runAsync(["index", "build", dir, "--no-check"], dir);
      expect(built.status, built.stderr).toBe(0);
      const rebuilt = await runAsync(["index", "build", dir, "--no-check"], dir);
      expect(rebuilt.status, rebuilt.stderr).toBe(0);

      writeFileSync(join(dir, "src/b.mjs"), "export const b = 2;\n");
      spawnSync("git", ["add", "-A"], { cwd: dir });
      spawnSync("git", ["commit", "-q", "-m", "add b"], { cwd: dir });

      const res = run(["index", "status", dir, "--json"], dir);
      expect(res.status, res.stderr).toBe(0);
      const result = JSON.parse(res.stdout);
      expect(result.refresh.chunksToEmbed).toBeGreaterThan(0);
      expect(result.refresh.rateReason).toBeNull();
      expect(result.refresh.seconds).not.toBeNull();
    } finally {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("memory.mjs index search", () => {
  it("is keyword-only with no provider: text and --json", () => {
    const dir = gitRepoDir({ "src/upload.mjs": "// retry flaky uploads here\nexport const x = 1;\n" });
    const build = run(["index", "build", dir], dir);
    expect(build.status, build.stderr).toBe(0);

    const text = run(["index", "search", "retry flaky uploads", dir], dir);
    expect(text.status, text.stderr).toBe(0);
    expect(text.stdout.split("\n")[0]).toMatch(/^index: keyword-only \(no provider configured\)/);
    expect(text.stdout).toContain("src/upload.mjs");

    const json = run(["index", "search", "retry flaky uploads", dir, "--json"], dir);
    expect(json.status, json.stderr).toBe(0);
    const result = JSON.parse(json.stdout);
    expect(result.mode).toBe("keyword-only");
    expect(result.chunks.length).toBeGreaterThan(0);
    expect(result.chunks[0].sides).toEqual(["bm25"]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("exits 2 with usage on a missing query", () => {
    const dir = gitRepoDir();
    const res = run(["index", "search"], dir);
    expect(res.status).toBe(2);
    expect(res.stderr).toContain("usage");
    rmSync(dir, { recursive: true, force: true });
  });

  it("--k must be an integer >= 1, exit 2 with usage otherwise", () => {
    const dir = gitRepoDir({ "src/a.mjs": "export const a = 1;\n" });
    run(["index", "build", dir], dir);
    for (const bad of ["0", "-1", "abc"]) {
      const res = run(["index", "search", "a", dir, "--k", bad], dir);
      expect(res.status, `--k ${bad}: ${res.stderr}`).toBe(2);
      expect(res.stderr).toContain("usage");
    }
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("memory.mjs index usage", () => {
  it("exits 2 with usage for a bare 'index' or an unknown subcommand", () => {
    const dir = gitRepoDir();
    const bare = run(["index"], dir);
    expect(bare.status).toBe(2);
    expect(bare.stderr).toContain("usage");
    const unknown = run(["index", "frobnicate"], dir);
    expect(unknown.status).toBe(2);
    expect(unknown.stderr).toContain("usage");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("memory.mjs usage", () => {
  it("exits 2 with usage on stderr for no subcommand or an unknown one", () => {
    const dir = tempDir();
    const none = run([], dir);
    expect(none.status).toBe(2);
    expect(none.stderr).toContain("usage");
    const unknown = run(["frobnicate"], dir);
    expect(unknown.status).toBe(2);
    expect(unknown.stderr).toContain("usage");
    rmSync(dir, { recursive: true, force: true });
  });
});

// Card memory-every-session, brief A: the SessionStart recall hook (plugins/doug-flow/scripts/session-recall.mjs).
describe("session-recall.mjs (SessionStart)", () => {
  const hookScript = join(here, "..", "scripts", "session-recall.mjs");
  const EMBED_CFG = (baseUrl) => ({ provider: "openai-compatible", baseUrl, model: "embeddinggemma", dims: 4 });
  const dbFile = (dir) => join(dir, ".doug", ".state", "memory", "memory.db");

  // Spawns the hook like Claude Code does: JSON payload on stdin, the project dir in CLAUDE_PROJECT_DIR.
  function hook(dir, input, extraEnv = {}) {
    return new Promise((resolvePromise) => {
      const started = Date.now();
      const child = spawn(process.execPath, [hookScript], { cwd: dir, env: { ...process.env, CLAUDE_PROJECT_DIR: dir, DOUG_SESSION_RECALL: "", ...extraEnv } });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      child.on("close", (status) => resolvePromise({ status, stdout, stderr, elapsed: Date.now() - started }));
      child.stdin.on("error", () => {});
      child.stdin.end(typeof input === "string" ? input : JSON.stringify({ hook_event_name: "SessionStart", source: "startup", cwd: dir, ...input }));
    });
  }

  function writeFlowBoard(dir, cards) {
    mkdirSync(join(dir, ".doug"), { recursive: true });
    const board = {
      version: 1,
      updated: "2026-10-07",
      columns: [
        { id: "ready", title: "Ready" },
        { id: "flow", title: "In flow" },
      ],
      components: [],
      tags: [],
      cards,
    };
    writeFileSync(join(dir, ".doug", "board.json"), JSON.stringify(board, null, 2), "utf8");
  }
  const flowCard = { id: "c1", title: "Retry flaky uploads", goal: "make upload retries robust against flaky networks", column: "flow" };

  function seed(dir, lessons) {
    const m = openMemory(dir);
    const rows = lessons.map((l) => {
      const row = addLesson(m, { kind: "pattern", source: { agent: "worker" }, ...l });
      if (l.helpful) m.prepare("UPDATE lessons SET helpful = ? WHERE id = ?").run(l.helpful, row.id);
      if (l.vector) setLessonEmbedding(m, row.id, { model: "embeddinggemma", dims: 4, vector: Float32Array.from(l.vector) });
      return row;
    });
    m.close();
    return rows;
  }
  const context = (res) => {
    const out = JSON.parse(res.stdout);
    expect(out.hookSpecificOutput.hookEventName).toBe("SessionStart");
    return out.hookSpecificOutput.additionalContext;
  };
  const lessonLines = (text) => text.split("\n").filter((l) => l.startsWith("- ["));

  it("a1: a card in the flow column with matching lessons -> additionalContext carries both ids, `for c1`, and starts `[doug] Lessons`", async () => {
    const dir = tempDir();
    try {
      writeFlowBoard(dir, [flowCard]);
      const [l1, l2] = seed(dir, [
        { text: "upload retries need exponential backoff on flaky networks" },
        { text: "cap upload retries so flaky networks cannot loop forever" },
      ]);
      for (const source of ["startup", "clear"]) {
        const res = await hook(dir, { source });
        expect(res.status, res.stderr).toBe(0);
        const ctx = context(res);
        expect(ctx.startsWith("[doug] Lessons")).toBe(true);
        expect(ctx).toContain(`[${l1.id}]`);
        expect(ctx).toContain(`[${l2.id}]`);
        expect(ctx).toContain("for c1");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a2: no memory.db -> exit 0, empty stdout, and .doug/.state/memory is not created", async () => {
    const dir = tempDir();
    try {
      writeFlowBoard(dir, [flowCard]);
      const res = await hook(dir, {});
      expect(res.status, res.stderr).toBe(0);
      expect(res.stdout).toBe("");
      expect(existsSync(join(dir, ".doug", ".state", "memory"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a3: a corrupt memory.db -> exit 0, stdout is exactly one systemMessage naming session-recall, no hookSpecificOutput", async () => {
    const dir = tempDir();
    try {
      writeFlowBoard(dir, [flowCard]);
      mkdirSync(join(dir, ".doug", ".state", "memory"), { recursive: true });
      writeFileSync(dbFile(dir), "this is not a sqlite database ".repeat(200), "utf8");
      const res = await hook(dir, {});
      expect(res.status, res.stderr).toBe(0);
      const lines = res.stdout.split("\n").filter((l) => l.trim());
      expect(lines).toHaveLength(1);
      const out = JSON.parse(lines[0]);
      expect(out.systemMessage).toContain("session-recall");
      expect(out.hookSpecificOutput).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a4: source compact (and resume) -> exit 0 with empty stdout even with matching lessons", async () => {
    const dir = tempDir();
    try {
      writeFlowBoard(dir, [flowCard]);
      seed(dir, [{ text: "upload retries need exponential backoff on flaky networks" }]);
      for (const source of ["compact", "resume"]) {
        const res = await hook(dir, { source });
        expect(res.status, res.stderr).toBe(0);
        expect(res.stdout, source).toBe("");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a5: twelve 1000-char lessons -> the lesson block stays within 2000 chars and holds at least one line", async () => {
    const dir = tempDir();
    try {
      writeFlowBoard(dir, [flowCard]);
      seed(dir, Array.from({ length: 12 }, (_, i) => ({ text: `upload retries flaky note${i} ` + `word${i} `.repeat(150) })));
      const res = await hook(dir, {});
      expect(res.status, res.stderr).toBe(0);
      const lines = lessonLines(context(res));
      expect(lines.length).toBeGreaterThanOrEqual(1);
      expect(lines.join("\n").length).toBeLessThanOrEqual(2000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a6: embeddings against a fake Ollama with vectors -> header names `hybrid via`; a closed port -> `keyword-only (` and the lessons still appear", async () => {
    const dir = tempDir();
    const server = await startFakeOllama();
    try {
      writeFlowBoard(dir, [flowCard]);
      const [l1] = seed(dir, [{ text: "upload retries need exponential backoff on flaky networks", vector: [1, 0, 0, 0] }]);
      writeMemoryConfig(dir, EMBED_CFG(serverBaseUrl(server)));
      const hybrid = await hook(dir, {});
      expect(hybrid.status, hybrid.stderr).toBe(0);
      const hybridCtx = context(hybrid);
      expect(hybridCtx).toContain("hybrid via");
      expect(hybridCtx).toContain(`[${l1.id}]`);

      writeMemoryConfig(dir, EMBED_CFG("http://127.0.0.1:1"));
      const down = await hook(dir, {});
      expect(down.status, down.stderr).toBe(0);
      const downCtx = context(down);
      expect(downCtx).toContain("keyword-only (");
      expect(downCtx).toContain(`[${l1.id}]`);
    } finally {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a7: an embed that ignores timeoutMs (fetch preloaded to stall 8 s) -> the 3000 ms deadline race returns keyword output, `embeddings timed out`, within 4500 ms", async () => {
    // createProvider reads globalThis.fetch when the hook builds the provider, so a --import preload that
    // swaps fetch for one that ignores its AbortSignal stands in for a provider the 1500 ms timeout cannot bound.
    const dir = tempDir();
    try {
      writeFlowBoard(dir, [flowCard]);
      const [l1] = seed(dir, [{ text: "upload retries need exponential backoff on flaky networks", vector: [1, 0, 0, 0] }]);
      writeMemoryConfig(dir, EMBED_CFG("http://127.0.0.1:1"));
      const preload = join(dir, "stall-fetch.mjs");
      writeFileSync(preload, 'globalThis.fetch = () => new Promise((_, reject) => setTimeout(() => reject(new Error("stalled")), 8000));\n', "utf8");
      const res = await hook(dir, {}, { NODE_OPTIONS: `--import ${pathToFileURL(preload).href}` });
      expect(res.status, res.stderr).toBe(0);
      const ctx = context(res);
      expect(ctx).toContain("keyword-only (embeddings timed out)");
      expect(ctx).toContain(`[${l1.id}]`);
      expect(res.elapsed).toBeLessThan(4500);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20000);

  it("a8: no card in the flow column -> query-free top lessons, helpful 3 listed before helpful 0 (even when the helpful-0 one is newer)", async () => {
    const dir = tempDir();
    try {
      writeFlowBoard(dir, [{ id: "r1", title: "A ready card", goal: "not started", column: "ready" }]);
      const now = Date.now();
      const [good, fresh] = seed(dir, [
        { text: "the lesson that proved helpful three times", helpful: 3, created: new Date(now - 5 * 86400000).toISOString() },
        { text: "a newer lesson nobody has used yet", helpful: 0, created: new Date(now - 1 * 86400000).toISOString() },
      ]);
      const res = await hook(dir, {});
      expect(res.status, res.stderr).toBe(0);
      const ctx = context(res);
      expect(ctx).toContain("top by helpful-harmful");
      expect(ctx.indexOf(`[${good.id}]`)).toBeGreaterThan(-1);
      expect(ctx.indexOf(`[${fresh.id}]`)).toBeGreaterThan(-1);
      expect(ctx.indexOf(`[${good.id}]`)).toBeLessThan(ctx.indexOf(`[${fresh.id}]`));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Added by the reviewer finding on card memory-every-session: the try/catch around loadBoard had no test.
  it("a8b: a DB plus an invalid board file -> the top-lessons context, not a systemMessage", async () => {
    const dir = tempDir();
    try {
      const [l1] = seed(dir, [{ text: "a lesson that survives a broken board file", helpful: 2 }]);
      writeFileSync(join(dir, ".doug", "board.json"), "{ this is not json", "utf8");
      const res = await hook(dir, {});
      expect(res.status, res.stderr).toBe(0);
      expect(res.stdout).not.toContain("systemMessage");
      const ctx = context(res);
      expect(ctx).toContain("top by helpful-harmful");
      expect(ctx).toContain(`[${l1.id}]`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a9: DOUG_SESSION_RECALL=0 -> empty stdout; so does memory.sessionRecall false in .doug/config.json", async () => {
    const dir = tempDir();
    try {
      writeFlowBoard(dir, [flowCard]);
      seed(dir, [{ text: "upload retries need exponential backoff on flaky networks" }]);
      const control = await hook(dir, {});
      expect(control.stdout).not.toBe("");
      const env = await hook(dir, {}, { DOUG_SESSION_RECALL: "0" });
      expect(env.status, env.stderr).toBe(0);
      expect(env.stdout).toBe("");
      writeFileSync(join(dir, ".doug", "config.json"), JSON.stringify({ memory: { sessionRecall: false } }), "utf8");
      const cfg = await hook(dir, {});
      expect(cfg.status, cfg.stderr).toBe(0);
      expect(cfg.stdout).toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a10: garbage stdin -> exit 0 and nothing thrown", async () => {
    const dir = tempDir();
    try {
      writeFlowBoard(dir, [flowCard]);
      seed(dir, [{ text: "upload retries need exponential backoff on flaky networks" }]);
      for (const junk of ["", "not json {{{", "[1,2", "null"]) {
        const res = await hook(dir, junk);
        expect(res.status, `${JSON.stringify(junk)}: ${res.stderr}`).toBe(0);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("memory.mjs brief-lessons", () => {
  const EMBED_CFG = (baseUrl) => ({ provider: "openai-compatible", baseUrl, model: "embeddinggemma", dims: 4 });
  const dbFile = (dir) => join(dir, ".doug", ".state", "memory", "memory.db");
  const lessonsFile = (dir, id = "c1") => join(dir, ".doug", ".state", "reports", id, "lessons.json");
  // No configured provider means the CLI probes a local Ollama; point the probe at a dead port.
  const NO_OLLAMA = { DOUG_OLLAMA_BASE_URL: "http://127.0.0.1:1" };
  const card = { id: "c1", title: "Retry flaky uploads", goal: "make upload retries robust against flaky networks", column: "ready" };

  // The header string the workflow puts above a task's lessons, read out of the workflow source.
  function workflowHeader() {
    const src = readFileSync(join(here, "..", "workflows", "doug-implement.js"), "utf8");
    const m = /`(Lessons from earlier runs on this repository \(memory; each cites where it was learned\):)`/.exec(src);
    if (!m) throw new Error("lessons header not found in doug-implement.js");
    return m[1];
  }

  function writeBoard(dir, cards = [card]) {
    mkdirSync(join(dir, ".doug"), { recursive: true });
    const board = {
      version: 1,
      updated: "2026-10-07",
      columns: [
        { id: "ready", title: "Ready" },
        { id: "flow", title: "In flow" },
      ],
      components: [],
      tags: [],
      cards,
    };
    writeFileSync(join(dir, ".doug", "board.json"), JSON.stringify(board, null, 2), "utf8");
  }

  function seed(dir, lessons) {
    const m = openMemory(dir);
    const rows = lessons.map((l) => {
      const row = addLesson(m, { kind: "pattern", source: { agent: "worker" }, ...l });
      if (l.vector) setLessonEmbedding(m, row.id, { model: "embeddinggemma", dims: 4, vector: Float32Array.from(l.vector) });
      return row;
    });
    m.close();
    return rows;
  }

  const lessonLines = (stdout) => stdout.split("\n").filter((l) => l.startsWith("- ["));
  const idOf = (line) => /^- \[([^\]]+)\]/.exec(line)[1];
  const memoryUsedIds = (stdout) => {
    const line = stdout.split("\n").find((l) => l.startsWith("memoryUsed: "));
    return line ? line.slice("memoryUsed: ".length).split(",").map((s) => s.trim()).filter(Boolean) : null;
  };

  it("b1: a seeded card and matching lessons -> first line is the workflow's header, `- [id]` lines, and lessons.json ids == stdout ids == the memoryUsed line", async () => {
    const dir = tempDir();
    try {
      writeBoard(dir);
      const [l1, l2] = seed(dir, [
        { text: "upload retries need exponential backoff on flaky networks" },
        { text: "cap upload retries so flaky networks cannot loop forever" },
      ]);
      const res = await runAsync(["brief-lessons", "c1", dir], dir, NO_OLLAMA);
      expect(res.status, res.stderr).toBe(0);
      expect(res.stdout.split("\n")[0]).toBe(workflowHeader());
      const lines = lessonLines(res.stdout);
      const ids = lines.map(idOf);
      expect(ids.sort()).toEqual([l1.id, l2.id].sort());
      expect(memoryUsedIds(res.stdout)).toEqual(lines.map(idOf));
      const saved = JSON.parse(readFileSync(lessonsFile(dir), "utf8"));
      expect(saved.card).toBe("c1");
      expect(saved.ids).toEqual(lines.map(idOf));
      expect(saved.mode).toBe("keyword-only");
      expect(typeof saved.query).toBe("string");
      expect(saved.query).toContain("Retry flaky uploads");
      expect(typeof saved.text).toBe("string");
      expect(typeof saved.recalledAt).toBe("string");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("b2: a configured fake Ollama with vectors -> lessons.json mode is hybrid", async () => {
    const dir = tempDir();
    const server = await startFakeOllama();
    try {
      writeBoard(dir);
      writeMemoryConfig(dir, EMBED_CFG(serverBaseUrl(server)));
      const [l1] = seed(dir, [{ text: "upload retries need exponential backoff on flaky networks", vector: [1, 0, 0, 0] }]);
      const res = await runAsync(["brief-lessons", "c1", dir], dir);
      expect(res.status, res.stderr).toBe(0);
      expect(res.stdout.split("\n")[0]).toBe(workflowHeader());
      expect(lessonLines(res.stdout).map(idOf)).toContain(l1.id);
      const saved = JSON.parse(readFileSync(lessonsFile(dir), "utf8"));
      expect(saved.mode).toBe("hybrid");
      expect(saved.ids).toContain(l1.id);
    } finally {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("b3: no memory database -> exit 0, `No lessons recalled for c1.`, lessons.json ids [], and the database is not created", async () => {
    const dir = tempDir();
    try {
      writeBoard(dir);
      const res = await runAsync(["brief-lessons", "c1", dir], dir, NO_OLLAMA);
      expect(res.status, res.stderr).toBe(0);
      expect(res.stdout).toContain("No lessons recalled for c1.");
      expect(JSON.parse(readFileSync(lessonsFile(dir), "utf8")).ids).toEqual([]);
      expect(existsSync(dbFile(dir))).toBe(false);
      expect(existsSync(join(dir, ".doug", ".state", "memory"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("b4: a corrupt memory.db -> exit 0, stderr `memory recall skipped`, lessons.json ids []", async () => {
    const dir = tempDir();
    try {
      writeBoard(dir);
      mkdirSync(join(dir, ".doug", ".state", "memory"), { recursive: true });
      writeFileSync(dbFile(dir), "this is not a sqlite database ".repeat(200), "utf8");
      const res = await runAsync(["brief-lessons", "c1", dir], dir, NO_OLLAMA);
      expect(res.status, res.stderr).toBe(0);
      expect(res.stderr).toContain("memory recall skipped");
      expect(JSON.parse(readFileSync(lessonsFile(dir), "utf8")).ids).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("b5: an unknown card -> exit 1 and `no card nope`", async () => {
    const dir = tempDir();
    try {
      writeBoard(dir);
      const res = await runAsync(["brief-lessons", "nope", dir], dir, NO_OLLAMA);
      expect(res.status).toBe(1);
      expect(res.stderr + res.stdout).toContain("no card nope");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("b6: ten 1000-char lessons -> the lesson block is at most 2000 chars and lessons.json ids are exactly the rendered lines", async () => {
    const dir = tempDir();
    try {
      writeBoard(dir);
      const filler = "upload retries flaky networks backoff ".repeat(40).slice(0, 1000);
      const all = seed(dir, Array.from({ length: 10 }, (_, i) => ({ text: `lesson ${i} ${filler}` })));
      const res = await runAsync(["brief-lessons", "c1", dir], dir, NO_OLLAMA);
      expect(res.status, res.stderr).toBe(0);
      const lines = lessonLines(res.stdout);
      expect(lines.length).toBeGreaterThanOrEqual(1);
      expect(lines.length).toBeLessThan(all.length);
      expect(lines.join("\n").length).toBeLessThanOrEqual(2000);
      const ids = lines.map(idOf);
      expect(JSON.parse(readFileSync(lessonsFile(dir), "utf8")).ids).toEqual(ids);
      expect(memoryUsedIds(res.stdout)).toEqual(ids);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
