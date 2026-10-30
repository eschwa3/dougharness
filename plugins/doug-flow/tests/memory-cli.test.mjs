import { describe, it, expect } from "vitest";
import { spawnSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, chmodSync, readFileSync, readdirSync, openSync, closeSync, copyFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { projectSlug } from "../lib/cost.mjs";
import { openMemory, addLesson, getLesson, supersedeLesson, writeRunHistory, readRunHistory, setLessonEmbedding, conditionConfigHash, recordOutcomes, handOutcomeRow, stopOutcomeRow, memoryConfig, FAILURE_REFLECT_SCHEMA, PITFALL_LEDGER_RELPATH, readPitfallOccurrences, PROJECT_MODEL_SCHEMA } from "../lib/memory.mjs";

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
  const dir = mkdtempSync(join(tmpdir(), "doug-memory-cli-"));
  mkdirSync(join(dir, ".doug")); // a Doug project: dirFrom refuses a directory with no .doug/ (card memory-dir-requires-doug)
  return dir;
}

function bareDir() {
  return mkdtempSync(join(tmpdir(), "doug-memory-bare-")); // not a Doug project: no .doug/
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

// A fake `claude` that fails if it is ever called: it drops a marker file next to itself and exits 7. A test passes
// it to a --dry-run and asserts the marker is absent (card memory-reflect-dry-run-spends: --dry-run spends nothing).
function writeFakeClaudeMustNotRun(dir) {
  const scriptPath = join(dir, "fake-claude-must-not-run.mjs");
  const marker = join(dir, "claude-was-called.marker");
  const body =
    "#!/usr/bin/env node\n" +
    'import { writeFileSync } from "node:fs";\n' +
    `writeFileSync(${JSON.stringify(marker)}, "called", "utf8");\n` +
    'process.stderr.write("fake-claude: must not be called under --dry-run\\n");\n' +
    "process.exit(7);\n";
  writeFileSync(scriptPath, body, "utf8");
  chmodSync(scriptPath, 0o755);
  return { bin: scriptPath, marker };
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

  // Card cost-price-haiku-5-5 (M8): runReflect's cost measurement prices each transcript message on its own tier.
  it("prices a reflect transcript's claude-haiku-5-5 messages per message by prompt length (usd_source transcript)", () => {
    const dir = tempDir();
    const claudeDir = tempDir();
    const sessionId = "sess-h55";
    const projDir = join(claudeDir, "projects", projectSlug(dir));
    mkdirSync(projDir, { recursive: true });
    // Two 60,000-input messages, each at the low tier ($0.10/MTok): 2 * 60000 * 0.10 / 1e6 = 0.012. Pricing their summed
    // 120,000 tokens at the high tier ($0.50/MTok) would give 0.06.
    const line = (id) => JSON.stringify({ type: "assistant", message: { id, model: "claude-haiku-5-5", usage: { input_tokens: 60_000, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } });
    writeFileSync(join(projDir, `${sessionId}.jsonl`), line("msg_1") + "\n" + line("msg_2") + "\n", "utf8");
    const claudeBin = writeFakeClaudeSuccess(dir, { structured_output: { lessons: [] }, session_id: sessionId, total_cost_usd: 0.9999, is_error: false });
    const res = run(["reflect", fixtureReport, dir, "--claude-bin", claudeBin, "--claude-dir", claudeDir], dir);
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toContain("$0.0120 (transcript)");
    rmSync(dir, { recursive: true, force: true });
    rmSync(claudeDir, { recursive: true, force: true });
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

  it("--dry-run applies nothing and makes no model call (no reflections row, no lessons appended, claude bin never spawned)", () => {
    const dir = tempDir();
    const { bin, marker } = writeFakeClaudeMustNotRun(dir);
    const res = run(["reflect", fixtureReport, dir, "--claude-bin", bin, "--dry-run"], dir);
    expect(res.status, res.stderr).toBe(0);
    expect(existsSync(marker)).toBe(false);
    expect(res.stdout).toContain("(dry run)");
    expect(res.stdout).toContain("$0.0000");
    // card memory-dry-run-no-model-call: --dry-run prints the prompt that would be sent
    expect(res.stdout).toContain("You are proposing at most 3 lessons for a coding harness's memory store");
    expect(JSON.parse(run(["lessons", dir, "--json"], dir).stdout)).toHaveLength(0);
    // proof no reflections row was written: a real reflect right after is not a no-op.
    const okBin = writeFakeClaudeSuccess(dir, { structured_output: { lessons: [] }, session_id: "sess-dry", total_cost_usd: 0.02, is_error: false });
    const real = run(["reflect", fixtureReport, dir, "--claude-bin", okBin], dir);
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

describe("memory.mjs reflect: CLAUDE.md candidates (card reflect-offers-claude-md)", () => {
  function claudeMdProject() {
    const dir = tempDir();
    writeFileSync(
      join(dir, "CLAUDE.md"),
      "# Project instructions\n\n## Gotchas\n\n- Vendored hook files changed mid session leave stale state.\n\n## Models\n\n| Work | Model | Effort |\n|---|---|---|\n| plan | opus | high |\n",
      "utf8",
    );
    return dir;
  }
  const lesson = (text, claudeMd) => ({
    kind: "pitfall",
    text,
    citation: "report:agents-generator/F1",
    task: "agents-generator",
    notDerivableBecause: "not written anywhere in the repo today",
    claudeMd,
  });
  const envelope = (lessons) => ({ structured_output: { lessons }, session_id: "sess-cm", total_cost_usd: 0.01, is_error: false });

  it("prints one line per candidate and per drop, --json carries both arrays, and the prompt asks for claudeMd with the CLAUDE.md headings", () => {
    const dir = claudeMdProject();
    const promptFile = join(dir, "prompt.txt");
    const claudeBin = writeFakeClaudeCapturingPrompt(
      dir,
      envelope([
        lesson("The adversary needs owned files listed exactly or retriable checks fail silently", { heading: "## Gotchas", line: "- Quartz widgets need fencing before any polishing starts." }),
        lesson("A reviewer pass that edits tests must state a reason or the lead sends it back", { heading: "## Nowhere", line: "- Zebra crossings pause every polishing cycle." }),
      ]),
      promptFile,
    );
    const args = ["reflect", fixtureReport, dir, "--adversary", "F1=real: confirmed by fix", "--claude-bin", claudeBin];
    const res = run(args, dir);
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toMatch(/claude-md candidate for lesson [0-9a-f]+: node .*memory\.mjs claude-md propose --file .*\.json/);
    expect(res.stdout).toMatch(/claude-md candidate for lesson [0-9a-f]+ dropped: .*## Nowhere/);
    const prompt = readFileSync(promptFile, "utf8");
    expect(prompt).toContain("claudeMd");
    expect(prompt).toContain("## Gotchas");

    // the printed command actually turns the candidate into a diff
    const cmd = res.stdout.match(/claude-md candidate for lesson [0-9a-f]+: (node .*)$/m)[1];
    const parts = cmd.split(" ");
    const file = parts[parts.length - 1];
    expect(existsSync(file)).toBe(true);
    const proposed = run(["claude-md", "propose", "--file", file, dir], dir);
    expect(proposed.status, proposed.stderr).toBe(0);
  });

  it("--json carries claudeMd and claudeMdDropped", () => {
    const dir = claudeMdProject();
    const claudeBin = writeFakeClaudeSuccess(
      dir,
      envelope([
        lesson("The adversary needs owned files listed exactly or retriable checks fail silently", { heading: "## Gotchas", line: "- Quartz widgets need fencing before any polishing starts." }),
        lesson("A reviewer pass that edits tests must state a reason or the lead sends it back", { heading: "## Models", line: "- Zebra crossings pause every polishing cycle." }),
      ]),
    );
    const res = run(["reflect", fixtureReport, dir, "--adversary", "F1=real: confirmed by fix", "--claude-bin", claudeBin, "--json"], dir);
    expect(res.status, res.stderr).toBe(0);
    const json = JSON.parse(res.stdout);
    expect(json.claudeMd).toHaveLength(1);
    expect(json.claudeMd[0]).toMatchObject({ lessonId: expect.any(String), file: expect.stringContaining("claude-md-candidates"), command: expect.stringContaining("claude-md propose --file") });
    expect(json.claudeMdDropped).toHaveLength(1);
    expect(json.claudeMdDropped[0].reason).toContain("Models");
  });
});

describe("memory.mjs reflect: CLAUDE.md candidate fixes (card reflect-offers-claude-md)", () => {
  const NOVEL = { heading: "## Gotchas", line: "- Quartz widgets need fencing before any polishing starts." };
  function claudeMdProject() {
    const dir = tempDir();
    writeFileSync(
      join(dir, "CLAUDE.md"),
      "# Project instructions\n\n## Gotchas\n\n- Vendored hook files changed mid session leave stale state.\n\n## Models\n\n| Work | Model | Effort |\n|---|---|---|\n| plan | opus | high |\n",
      "utf8"
    );
    return dir;
  }
  const handLesson = (claudeMd) => ({
    kind: "pattern",
    text: "uploads retry with jittered backoff",
    citation: "report:c1",
    task: "c1",
    notDerivableBecause: "learned only from this landing",
    claudeMd,
  });
  const envelope = (lessons) => ({ structured_output: { lessons }, session_id: "sess-cm2", total_cost_usd: 0.01, is_error: false });
  function seedHand(dir) {
    const base = join(dir, ".doug", ".state", "reports", "c1");
    mkdirSync(join(base, "briefs"), { recursive: true });
    mkdirSync(join(base, "reviews"), { recursive: true });
    writeFileSync(join(base, "lessons.json"), JSON.stringify({ card: "c1", query: "q", mode: "keyword", reason: null, ids: [], text: "x", recalledAt: "2026-10-07T00:00:00.000Z" }), "utf8");
    writeFileSync(join(base, "briefs", "1-coder.md"), "BRIEF", "utf8");
    writeFileSync(join(base, "reviews", "1.md"), "REVIEW", "utf8");
  }

  it("reflect --hand with claude-md-candidates a plain file: exit 0, the lesson is appended, the drop line is printed, no stack", () => {
    const dir = claudeMdProject();
    try {
      seedHand(dir);
      mkdirSync(join(dir, ".doug/.state/learn"), { recursive: true });
      writeFileSync(join(dir, ".doug/.state/learn/claude-md-candidates"), "plain file\n", "utf8");
      const claudeBin = writeFakeClaudeSuccess(dir, envelope([handLesson(NOVEL)]));
      const res = run(["reflect", "--hand", "c1", dir, "--commit", "abc1234", "--claude-bin", claudeBin], dir);
      expect(res.status, res.stderr).toBe(0);
      expect(res.stdout).toMatch(/claude-md candidate for lesson [0-9a-f]+ dropped: .*(EEXIST|ENOTDIR|exists|not a directory)/i);
      const lessons = JSON.parse(run(["lessons", dir, "--json"], dir).stdout);
      expect(lessons.filter((l) => l.source_agent === "reflect")).toHaveLength(1);
      const m = openMemory(dir);
      try {
        const row = m.prepare("SELECT * FROM reflections").get();
        expect(row.proposed).toBe(1);
        expect(row.rejected).not.toBeNull();
      } finally {
        m.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--dry-run makes no model call, so it proposes and writes no CLAUDE.md candidate", () => {
    const dir = claudeMdProject();
    try {
      const { bin, marker } = writeFakeClaudeMustNotRun(dir);
      const res = run(["reflect", fixtureReport, dir, "--adversary", "F1=real: confirmed by fix", "--claude-bin", bin, "--dry-run"], dir);
      expect(res.status, res.stderr).toBe(0);
      expect(existsSync(marker)).toBe(false);
      expect(res.stdout).not.toContain("claude-md candidate");
      expect(res.stdout).not.toContain("claude-md propose --file");
      expect(existsSync(join(dir, ".doug/.state/learn/claude-md-candidates"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("memory.mjs reflect --harmful (card reflect-harmful-irrelevant-lessons)", () => {
  const counters = (dir, id) => {
    const m = openMemory(dir);
    try {
      return m.prepare("SELECT helpful, harmful FROM lessons WHERE id = ?").get(id);
    } finally {
      m.close();
    }
  };
  const flowReport = (dir, used) => {
    const file = join(dir, "flow-report.json");
    writeFileSync(
      file,
      JSON.stringify({
        plan: "harm",
        ok: true,
        levels: [{ index: 0, tasks: [{ id: "t1", verified: true, passes: 1, stopReason: null, reviewIssues: [], verifierFindings: [], memoryUsed: used }] }],
      }),
      "utf8"
    );
    return file;
  };
  const seed = (dir, n) => {
    const m = openMemory(dir);
    const ids = [];
    for (let i = 0; i < n; i++) ids.push(addLesson(m, { kind: "pattern", source: { agent: "worker" }, text: `seeded lesson number ${i} about uploads` }).id);
    m.close();
    return ids;
  };
  const okBin = (dir) => writeFakeClaudeSuccess(dir, { structured_output: { lessons: [] }, session_id: "sess-harm", total_cost_usd: 0, is_error: false });

  it("flow form: --harmful <id> (repeatable) bumps harmful on the named id only and earns it no helpful", () => {
    const dir = tempDir();
    try {
      const [L, K] = seed(dir, 2);
      const res = run(["reflect", flowReport(dir, [L, K]), dir, "--harmful", L, "--claude-bin", okBin(dir)], dir);
      expect(res.status, res.stderr).toBe(0);
      expect(counters(dir, L)).toEqual({ helpful: 0, harmful: 1 });
      expect(counters(dir, K)).toEqual({ helpful: 1, harmful: 0 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("flow form: --harmful repeated names two ids and both are bumped", () => {
    const dir = tempDir();
    try {
      const [L, K] = seed(dir, 2);
      const res = run(["reflect", flowReport(dir, [L, K]), dir, "--harmful", L, "--harmful", K, "--claude-bin", okBin(dir)], dir);
      expect(res.status, res.stderr).toBe(0);
      expect(counters(dir, L)).toEqual({ helpful: 0, harmful: 1 });
      expect(counters(dir, K)).toEqual({ helpful: 0, harmful: 1 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("flow form: a --harmful id outside memoryUsed exits 1 naming it, with no counter change and no reflections row", () => {
    const dir = tempDir();
    try {
      const [L, K] = seed(dir, 2);
      const res = run(["reflect", flowReport(dir, [L]), dir, "--harmful", K, "--claude-bin", okBin(dir)], dir);
      expect(res.status).toBe(1);
      expect(res.stderr).toContain(K);
      expect(counters(dir, L)).toEqual({ helpful: 0, harmful: 0 });
      expect(counters(dir, K)).toEqual({ helpful: 0, harmful: 0 });
      const again = run(["reflect", flowReport(dir, [L]), dir, "--claude-bin", okBin(dir)], dir);
      expect(again.stdout).not.toContain("Already reflected");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("both usage strings mention --harmful", () => {
    const dir = tempDir();
    try {
      const flow = run(["reflect"], dir);
      expect(flow.status).toBe(2);
      expect(flow.stderr).toContain("--harmful");
      const hand = run(["reflect", "--hand"], dir);
      expect(hand.status).toBe(2);
      expect(hand.stderr).toContain("--harmful");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
    // The lead fetched L1 into the brief (the real CLI records it); "lxunknown" was indexed but never fetched.
    const shown = run(["lesson", "show", L1, dir, "--card", "c1"], dir);
    if (shown.status !== 0) throw new Error(`lesson show failed: ${shown.stderr}`);
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
      expect(hr.levels[0].tasks[0].memoryUsed).toEqual([L1]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Card memory-reflect-fetched-only: helpful counts only lessons fetched with lesson show --card.
  const fetchedFile = (dir, card = "c1") => join(dir, ".doug", ".state", "reports", card, "fetched.jsonl");
  function setupTwo(dir, { fetch = [] } = {}) {
    const m = openMemory(dir);
    const A = addLesson(m, { kind: "pattern", source: { agent: "worker" }, text: "lesson A about uploads" }).id;
    const B = addLesson(m, { kind: "pattern", source: { agent: "worker" }, text: "lesson B about schemas" }).id;
    m.close();
    const base = reportsDir(dir);
    mkdirSync(join(base, "briefs"), { recursive: true });
    mkdirSync(join(base, "reviews"), { recursive: true });
    writeFileSync(join(base, "lessons.json"), JSON.stringify({ card: "c1", query: "q", mode: "keyword", reason: null, ids: [A, B], text: "x", recalledAt: "2026-10-07T00:00:00.000Z" }), "utf8");
    writeFileSync(join(base, "briefs", "1-coder.md"), "brief", "utf8");
    writeFileSync(join(base, "reviews", "1.md"), "review", "utf8");
    for (const id of fetch(A, B)) {
      const r = run(["lesson", "show", id, dir, "--card", "c1"], dir);
      if (r.status !== 0) throw new Error(r.stderr);
    }
    return { A, B };
  }
  const handUsed = (dir) => JSON.parse(readFileSync(join(reportsDir(dir), "hand-report.json"), "utf8")).levels[0].tasks[0].memoryUsed;

  // Card memory-reflect-dry-run-spends: --dry-run makes no model call and spends nothing.
  it("D1: reflect --hand --dry-run never spawns the claude bin, still prints what it would credit, and credits nothing", () => {
    const dir = tempDir();
    try {
      const { A } = setupTwo(dir, { fetch: (a) => [a] });
      const { bin, marker } = writeFakeClaudeMustNotRun(dir);
      const res = reflect(dir, bin, ["--dry-run"]);
      expect(res.status, res.stderr).toBe(0);
      expect(existsSync(marker)).toBe(false);
      expect(res.stdout).toContain("(dry run)");
      expect(res.stdout).toContain(`helpful +1 (${A})`);
      expect(res.stdout).toContain("no model call");
      expect(res.stdout).toContain("$0.0000");
      expect(res.stdout).toContain("You are proposing at most 3 lessons for a coding harness's memory store");
      expect(helpfulOf(dir, A)).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("D2: reflect --hand --dry-run --json reports usd 0, proposed null and the counters it would credit", () => {
    const dir = tempDir();
    try {
      const { A } = setupTwo(dir, { fetch: (a) => [a] });
      const { bin, marker } = writeFakeClaudeMustNotRun(dir);
      const res = reflect(dir, bin, ["--dry-run", "--json"]);
      expect(res.status, res.stderr).toBe(0);
      expect(existsSync(marker)).toBe(false);
      const out = JSON.parse(res.stdout);
      expect(out.dryRun).toBe(true);
      expect(out.usd).toBe(0);
      expect(out.proposed).toBeNull();
      expect(out.appended).toEqual([]);
      expect(out.counters.helpful).toEqual([A]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("f1: a fetched lesson gets helpful +1 and is in memoryUsed; an indexed lesson never fetched stays at 0 and is absent", () => {
    const dir = tempDir();
    try {
      const { A, B } = setupTwo(dir, { fetch: (a) => [a] });
      const res = reflect(dir, claudeOk(dir, []));
      expect(res.status, res.stderr).toBe(0);
      expect(helpfulOf(dir, A)).toBe(1);
      expect(helpfulOf(dir, B)).toBe(0);
      expect(handUsed(dir)).toEqual([A]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("f2: nothing fetched (no fetched.jsonl) credits nothing and does not throw", () => {
    const dir = tempDir();
    try {
      const { A, B } = setupTwo(dir, { fetch: () => [] });
      expect(existsSync(fetchedFile(dir))).toBe(false);
      const res = reflect(dir, claudeOk(dir, []));
      expect(res.status, res.stderr).toBe(0);
      expect(helpfulOf(dir, A)).toBe(0);
      expect(helpfulOf(dir, B)).toBe(0);
      expect(handUsed(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("f3: a lesson fetched twice counts once, memoryUsed follows lessons.json order, a malformed line is skipped, and a fetched id outside lessons.json is not credited", () => {
    const dir = tempDir();
    try {
      const { A, B } = setupTwo(dir, { fetch: (a, b) => [b, a, b] });
      const m = openMemory(dir);
      const C = addLesson(m, { kind: "pattern", source: { agent: "worker" }, text: "lesson C not indexed" }).id;
      m.close();
      writeFileSync(fetchedFile(dir), "not json at all\n" + JSON.stringify({ id: C, at: "2026-10-19T00:00:00.000Z" }) + "\n{\"id\":\n", { flag: "a" });
      const res = reflect(dir, claudeOk(dir, []));
      expect(res.status, res.stderr).toBe(0);
      expect(handUsed(dir)).toEqual([A, B]);
      expect(helpfulOf(dir, A)).toBe(1);
      expect(helpfulOf(dir, B)).toBe(1);
      expect(helpfulOf(dir, C)).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("f4: --harmful must name a fetched lesson; an indexed but unfetched id exits 1", () => {
    const dir = tempDir();
    try {
      const { A, B } = setupTwo(dir, { fetch: (a) => [a] });
      const bad = reflect(dir, claudeOk(dir, []), ["--harmful", B]);
      expect(bad.status).toBe(1);
      expect(bad.stderr).toContain(B);
      const ok = reflect(dir, claudeOk(dir, []), ["--harmful", A]);
      expect(ok.status, ok.stderr).toBe(0);
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

  it("hand form: --harmful <id> bumps harmful on that id with no helpful even though the card verified; an id outside lessons.json exits 1 naming it", () => {
    const dir = tempDir();
    try {
      const L1 = setup(dir);
      const bad = reflect(dir, claudeOk(dir, []), ["--harmful", "lxnotused"]);
      expect(bad.status).toBe(1);
      expect(bad.stderr).toContain("lxnotused");
      expect(helpfulOf(dir, L1)).toBe(0);
      const res = reflect(dir, claudeOk(dir, []), ["--harmful", L1]);
      expect(res.status, res.stderr).toBe(0);
      const m = openMemory(dir);
      try {
        expect(m.prepare("SELECT helpful, harmful FROM lessons WHERE id = ?").get(L1)).toEqual({ helpful: 0, harmful: 1 });
      } finally {
        m.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
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

  // card reflect-review-key-text: --review takes `R<n>` or `<card>/R<n>`; both are recorded as `<card>/R<n>`.
  const ledgerIds = (dir) => {
    const hr = JSON.parse(readFileSync(join(reportsDir(dir), "hand-report.json"), "utf8"));
    return hr.levels[0].tasks[0].ledger.map((e) => e.id);
  };

  it("review key: the shorthand R1 is accepted and recorded as c1/R1", () => {
    const dir = tempDir();
    try {
      setup(dir);
      const res = reflect(dir, claudeOk(dir, []), ["--review", "R1=real: shorthand"]);
      expect(res.status, res.stderr).toBe(0);
      expect(ledgerIds(dir)).toEqual(["c1/R1"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("review key: the full c1/R1 still works and is recorded as c1/R1", () => {
    const dir = tempDir();
    try {
      setup(dir);
      const res = reflect(dir, claudeOk(dir, []), ["--review", "c1/R1=real: full"]);
      expect(res.status, res.stderr).toBe(0);
      expect(ledgerIds(dir)).toEqual(["c1/R1"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("review key: R1 and c1/R1 together name one finding (no 'no adversary block named' error, one ledger entry); R1 and R2 stay two", () => {
    const dir = tempDir();
    try {
      setup(dir);
      const res = reflect(dir, claudeOk(dir, []), ["--review", "R1=real: a", "--review", "c1/R1=real: b"]);
      expect(res.status, res.stderr).toBe(0);
      expect(res.stderr).not.toContain("no adversary block named");
      expect(ledgerIds(dir)).toEqual(["c1/R1"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    const dir2 = tempDir();
    try {
      setup(dir2);
      const res = reflect(dir2, claudeOk(dir2, []), ["--review", "R1=real: a", "--review", "R2=marginal: b"]);
      expect(res.status, res.stderr).toBe(0);
      expect(ledgerIds(dir2).sort()).toEqual(["c1/R1", "c1/R2"]);
    } finally {
      rmSync(dir2, { recursive: true, force: true });
    }
  });

  it("review key: another card's full key exits 2 naming both accepted forms", () => {
    const dir = tempDir();
    try {
      setup(dir);
      const res = reflect(dir, claudeOk(dir, []), ["--review", "other/R1=real: x"]);
      expect(res.status).toBe(2);
      expect(res.stderr).toContain("R<n> or c1/R<n>");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("review key: a suffix after the card prefix (c1/R1/x) exits 2", () => {
    const dir = tempDir();
    try {
      setup(dir);
      const res = reflect(dir, claudeOk(dir, []), ["--review", "c1/R1/x=real: x"]);
      expect(res.status).toBe(2);
      expect(res.stderr).toContain("R<n> or c1/R<n>");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("review key: the same finding twice with different classes exits 2", () => {
    const dir = tempDir();
    try {
      setup(dir);
      const res = reflect(dir, claudeOk(dir, []), ["--review", "R1=real: a", "--review", "c1/R1=false: b"]);
      expect(res.status).toBe(2);
      expect(res.stderr).toContain("twice with different classes");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("review key: the reflect prompt lists a hand block once as report:c1/R1", () => {
    const dir = tempDir();
    try {
      setup(dir);
      const promptFile = join(dir, "prompt.txt");
      const res = reflect(dir, claudeOk(dir, [], promptFile), ["--review", "R1=real: a"]);
      expect(res.status, res.stderr).toBe(0);
      const prompt = readFileSync(promptFile, "utf8");
      expect(prompt).toContain("report:c1/R1 class=real");
      expect(prompt).not.toContain("report:c1/c1/R1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("review key: --review does not change which lessons count helpful (real, marginal, false, either key form)", () => {
    const withoutDir = tempDir();
    let baseline;
    try {
      const L1 = setup(withoutDir);
      const res = reflect(withoutDir, claudeOk(withoutDir, []), ["--json"]);
      expect(res.status, res.stderr).toBe(0);
      baseline = JSON.parse(res.stdout).counters.helpful;
      expect(baseline).toEqual([L1]);
    } finally {
      rmSync(withoutDir, { recursive: true, force: true });
    }
    for (const review of ["R1=real: x", "c1/R1=real: x", "R1=marginal: x", "R1=false: x"]) {
      const dir = tempDir();
      try {
        const L1 = setup(dir);
        const res = reflect(dir, claudeOk(dir, []), ["--json", "--review", review]);
        expect(res.status, `${review}: ${res.stderr}`).toBe(0);
        expect(JSON.parse(res.stdout).counters.helpful, review).toEqual(baseline);
        expect(helpfulOf(dir, L1), review).toBe(1);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it("memory-outcome-arms: --rounds n writes passes n and fix_passes n-1 onto the landing's hand outcomes row", () => {
    const dir = tempDir();
    try {
      setup(dir);
      const rec = run(["record", "c1", "--hand", dir, "--commit", "abc1234"], dir);
      expect(rec.status, rec.stderr).toBe(0);
      const res = reflect(dir, claudeOk(dir, []), ["--rounds", "3"]);
      expect(res.status, res.stderr).toBe(0);
      const rows = JSON.parse(run(["outcomes", dir, "--json"], dir).stdout).filter((r) => r.run === "hand:abc1234" && r.task === "c1");
      expect(rows).toHaveLength(1);
      expect(rows[0].passes).toBe(3);
      expect(rows[0].fix_passes).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("memory-outcome-arms: without --rounds the row's passes and fix_passes stay null (the default 1 is never written)", () => {
    const dir = tempDir();
    try {
      setup(dir);
      expect(run(["record", "c1", "--hand", dir, "--commit", "abc1234"], dir).status).toBe(0);
      const res = reflect(dir, claudeOk(dir, []));
      expect(res.status, res.stderr).toBe(0);
      const [row] = JSON.parse(run(["outcomes", dir, "--json"], dir).stdout).filter((r) => r.run === "hand:abc1234");
      expect(row.passes).toBeNull();
      expect(row.fix_passes).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("memory-record-keeps-rounds: record --hand after reflect --hand --rounds 3 keeps passes 3 and fix_passes 2", () => {
    const dir = tempDir();
    try {
      setup(dir);
      expect(run(["record", "c1", "--hand", dir, "--commit", "abc1234"], dir).status).toBe(0);
      const res = reflect(dir, claudeOk(dir, []), ["--rounds", "3"]);
      expect(res.status, res.stderr).toBe(0);
      const again = run(["record", "c1", "--hand", dir, "--commit", "abc1234", "--note", "re-record"], dir);
      expect(again.status, again.stderr).toBe(0);
      const rows = JSON.parse(run(["outcomes", dir, "--json"], dir).stdout).filter((r) => r.run === "hand:abc1234" && r.task === "c1");
      expect(rows).toHaveLength(1);
      expect(rows[0].note).toBe("re-record");
      expect(rows[0].passes).toBe(3);
      expect(rows[0].fix_passes).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("memory-record-keeps-rounds: a rerun that says Already reflected still writes --rounds", () => {
    const dir = tempDir();
    try {
      setup(dir);
      expect(run(["record", "c1", "--hand", dir, "--commit", "abc1234"], dir).status).toBe(0);
      const first = reflect(dir, claudeOk(dir, []));
      expect(first.status, first.stderr).toBe(0);
      const second = reflect(dir, claudeOk(dir, []), ["--rounds", "1"]);
      expect(second.status, second.stderr).toBe(0);
      expect(second.stdout).toContain("Already reflected");
      const [row] = JSON.parse(run(["outcomes", dir, "--json"], dir).stdout).filter((r) => r.run === "hand:abc1234");
      expect(row.passes).toBe(1);
      expect(row.fix_passes).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("memory-outcome-arms: --dry-run --rounds 3 leaves passes and fix_passes null", () => {
    const dir = tempDir();
    try {
      setup(dir);
      expect(run(["record", "c1", "--hand", dir, "--commit", "abc1234"], dir).status).toBe(0);
      const res = reflect(dir, claudeOk(dir, []), ["--rounds", "3", "--dry-run"]);
      expect(res.status, res.stderr).toBe(0);
      const [row] = JSON.parse(run(["outcomes", dir, "--json"], dir).stdout).filter((r) => r.run === "hand:abc1234");
      expect(row.passes).toBeNull();
      expect(row.fix_passes).toBeNull();
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

// Card parallel-card-queens, brief B2 fix pass: a stale .doug/plan.json for another card is not read for this card.
describe("memory.mjs record --card with a stale single plan", () => {
  const plan = (card) => ({ version: 1, title: "T", goal: "g", status: "approved", acceptance: ["a"], verify: ["true"], card, tasks: [{ id: "agents-generator", title: "t", spec: "s", files: ["src/owned.ts"] }] });
  const recordRow = (planCard) => {
    const dir = tempDir();
    mkdirSync(join(dir, ".doug"), { recursive: true });
    writeFileSync(join(dir, ".doug/plan.json"), JSON.stringify(plan(planCard)));
    const r = run(["record", fixtureReport, dir, "--run", "wf_7092b963-6a5", "--claude-dir", fixtureClaude, "--card", "standard-agents"], dir);
    expect(r.status, r.stderr).toBe(0);
    return JSON.parse(run(["outcomes", dir, "--json"], dir).stdout)[0];
  };
  it("does not attach the stale plan's owned files to another card's outcome, and does for its own card", () => {
    expect(recordRow("other-card").files).toBeNull();
    expect(recordRow("standard-agents").files).toEqual(["src/owned.ts"]);
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
      ["harnessCommit", "configHash", "class", "arm", "assignedBy", "exploreProbability", "openedAt", "memoryConfig"].sort()
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

describe("memory.mjs lessons --unconfirmed", () => {
  const seed = (dir, texts) => {
    const m = openMemory(dir);
    try {
      return texts.map((text, i) =>
        addLesson(m, { kind: i % 2 ? "pitfall" : "pattern", source: { agent: "worker" }, text, created: `2026-10-0${i + 1}T00:00:00.000Z` }).id
      );
    } finally {
      m.close();
    }
  };
  const sql = (dir, stmt, ...args) => {
    const m = openMemory(dir);
    try {
      m.prepare(stmt).run(...args);
    } finally {
      m.close();
    }
  };
  const ids = (dir, extra = []) => JSON.parse(run(["lessons", "--unconfirmed", dir, "--json", ...extra], dir).stdout).map((r) => r.id);

  it("lists a fresh lesson with id, kind, created and title in text and --json", () => {
    const dir = tempDir();
    try {
      const [a] = seed(dir, ["First line title\nsecond line body"]);
      const json = run(["lessons", "--unconfirmed", dir, "--json"], dir);
      expect(json.status, json.stderr).toBe(0);
      expect(JSON.parse(json.stdout)).toEqual([{ id: a, kind: "pattern", created: "2026-10-01T00:00:00.000Z", title: "First line title" }]);
      const text = run(["lessons", "--unconfirmed", dir], dir);
      expect(text.status, text.stderr).toBe(0);
      for (const part of [a, "pattern", "2026-10-01T00:00:00.000Z", "First line title"]) expect(text.stdout).toContain(part);
      expect(text.stdout).not.toContain("second line body");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("leaves out a lesson whose helpful count is above 0", () => {
    const dir = tempDir();
    try {
      const [a, b] = seed(dir, ["alpha lesson", "beta lesson"]);
      sql(dir, "UPDATE lessons SET helpful = 1 WHERE id = ?", a);
      expect(ids(dir)).toEqual([b]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("leaves out a lesson whose harmful count is above 0", () => {
    const dir = tempDir();
    try {
      const [a, b] = seed(dir, ["alpha lesson", "beta lesson"]);
      sql(dir, "UPDATE lessons SET harmful = 1 WHERE id = ?", a);
      expect(ids(dir)).toEqual([b]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("after lesson show --card, that id is no longer listed (fetches under any card count)", () => {
    const dir = tempDir();
    try {
      const [a, b, c] = seed(dir, ["alpha lesson", "beta lesson", "gamma lesson"]);
      expect(run(["lesson", "show", a, dir, "--card", "c1"], dir).status).toBe(0);
      expect(run(["lesson", "show", b, dir, "--card", "c2"], dir).status).toBe(0);
      expect(ids(dir)).toEqual([c]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not count a lesson show without --card as a fetch", () => {
    const dir = tempDir();
    try {
      const [a] = seed(dir, ["alpha lesson"]);
      expect(run(["lesson", "show", a, dir], dir).status).toBe(0);
      expect(ids(dir)).toEqual([a]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("skips malformed fetched.jsonl lines without throwing", () => {
    const dir = tempDir();
    try {
      const [a, b] = seed(dir, ["alpha lesson", "beta lesson"]);
      const fdir = join(dir, ".doug", ".state", "reports", "cx");
      mkdirSync(fdir, { recursive: true });
      writeFileSync(join(fdir, "fetched.jsonl"), `not json\n${JSON.stringify({ id: a, at: "2026-10-01T00:00:00.000Z" })}\n{"broken\n`, "utf8");
      mkdirSync(join(dir, ".doug", ".state", "reports", "empty"), { recursive: true });
      const res = run(["lessons", "--unconfirmed", dir, "--json"], dir);
      expect(res.status, res.stderr).toBe(0);
      expect(JSON.parse(res.stdout).map((r) => r.id)).toEqual([b]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("leaves out an archived lesson", () => {
    const dir = tempDir();
    try {
      const [a, b] = seed(dir, ["alpha lesson", "beta lesson"]);
      sql(dir, "UPDATE lessons SET archived = ?, archived_reason = ? WHERE id = ?", "2026-10-10T00:00:00.000Z", "test", a);
      expect(ids(dir)).toEqual([b]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("leaves out a superseded lesson and lists its live successor", () => {
    const dir = tempDir();
    try {
      const [a, b] = seed(dir, ["old lesson", "new lesson"]);
      const m = openMemory(dir);
      try {
        supersedeLesson(m, a, b);
      } finally {
        m.close();
      }
      expect(ids(dir)).toEqual([b]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("leaves out a stale lesson", () => {
    const dir = tempDir();
    try {
      const [a, b] = seed(dir, ["alpha lesson", "beta lesson"]);
      sql(dir, "UPDATE lessons SET stale = ? WHERE id = ?", "2026-10-10T00:00:00.000Z", a);
      expect(ids(dir)).toEqual([b]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("prints 'no unconfirmed lessons' and creates no store on an empty directory", () => {
    const dir = tempDir();
    try {
      const text = run(["lessons", "--unconfirmed", dir], dir);
      expect(text.status, text.stderr).toBe(0);
      expect(text.stdout).toContain("no unconfirmed lessons");
      const json = run(["lessons", "--unconfirmed", dir, "--json"], dir);
      expect(json.status, json.stderr).toBe(0);
      expect(JSON.parse(json.stdout)).toEqual([]);
      expect(existsSync(join(dir, ".doug", ".state", "memory", "memory.db"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is read-only: lesson rows are unchanged after listing", () => {
    const dir = tempDir();
    try {
      seed(dir, ["alpha lesson", "beta lesson"]);
      const snap = () => {
        const m = openMemory(dir);
        try {
          return JSON.stringify(m.prepare("SELECT * FROM lessons ORDER BY id").all());
        } finally {
          m.close();
        }
      };
      const before = snap();
      expect(run(["lessons", "--unconfirmed", dir], dir).status).toBe(0);
      expect(snap()).toBe(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exits 2 with usage on stderr when combined with --search or --all", () => {
    const dir = tempDir();
    try {
      seed(dir, ["alpha lesson"]);
      for (const extra of [["--search", "alpha"], ["--all"]]) {
        const res = run(["lessons", "--unconfirmed", dir, ...extra], dir);
        expect(res.status, extra.join(" ")).toBe(2);
        expect(res.stderr).toContain("unconfirmed");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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

  // Card memory-progressive-access (ADR 0019): the brief carries an index with token costs, not the 400-character cut.
  it("M5: a seeded 1000-char multi-line lesson prints as one index line with its token cost and not its second line; the header is unchanged", async () => {
    const dir = tempDir();
    try {
      writeBoard(dir);
      const first = "upload retries need exponential backoff on flaky networks";
      const text = first + "\n" + "SECONDLINE-marker ".repeat(60).slice(0, 1000 - first.length - 1);
      expect(text.length).toBe(1000);
      const [l] = seed(dir, [{ text }]);
      const res = await runAsync(["brief-lessons", "c1", dir], dir, NO_OLLAMA);
      expect(res.status, res.stderr).toBe(0);
      expect(res.stdout.split("\n")[0]).toBe(workflowHeader());
      expect(lessonLines(res.stdout)).toEqual([`- [${l.id}] ${first} (pattern, ~250 tokens)`]);
      expect(res.stdout).not.toContain("SECONDLINE");
      const saved = JSON.parse(readFileSync(lessonsFile(dir), "utf8"));
      expect(saved.ids).toEqual([l.id]);
      expect(saved.text).toContain(`- [${l.id}] ${first} (pattern, ~250 tokens)`);
      expect(saved.omitted).toEqual([]);
      expect(memoryUsedIds(res.stdout)).toEqual([l.id]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("M6: --k 20 over 20 matching lessons names the lessons the index budget dropped before memoryUsed, and lessons.json.omitted lists the same ids", async () => {
    const dir = tempDir();
    try {
      writeBoard(dir);
      const head = (i) => `lesson ${i} upload retries flaky networks backoff `.padEnd(100, "x");
      const all = seed(dir, Array.from({ length: 20 }, (_, i) => ({ text: head(i) + "\ndetail line " + i })));
      const res = await runAsync(["brief-lessons", "c1", dir, "--k", "20"], dir, NO_OLLAMA);
      expect(res.status, res.stderr).toBe(0);
      const lines = res.stdout.split("\n");
      const shown = lessonLines(res.stdout).map(idOf);
      const at = lines.findIndex((l) => l.startsWith("index: omitted"));
      expect(at).toBeGreaterThan(-1);
      const m = /^index: omitted (\d+) lessons over the 2000-character index budget: (.+)$/.exec(lines[at]);
      expect(m, lines[at]).not.toBeNull();
      const omitted = m[2].split(", ");
      expect(Number(m[1])).toBe(omitted.length);
      expect(omitted.length).toBeGreaterThan(0);
      expect(shown.length).toBeGreaterThan(0);
      expect([...shown, ...omitted].sort()).toEqual(all.map((l) => l.id).sort());
      expect(lessonLines(res.stdout).join("\n").length).toBeLessThanOrEqual(2000);
      const mu = lines.findIndex((l) => l.startsWith("memoryUsed: "));
      expect(at).toBeGreaterThan(lines.map((l, i) => (l.startsWith("- [") ? i : -1)).reduce((a, b) => Math.max(a, b)));
      expect(at).toBeLessThan(mu);
      expect(memoryUsedIds(res.stdout)).toEqual(shown);
      const saved = JSON.parse(readFileSync(lessonsFile(dir), "utf8"));
      expect(saved.omitted).toEqual(omitted);
      expect(saved.ids).toEqual(shown);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("with few lessons no line starts `index: omitted` and lessons.json.omitted is []; with no database or a corrupt one it is [] too", async () => {
    const dir = tempDir();
    try {
      writeBoard(dir);
      seed(dir, [{ text: "upload retries need exponential backoff on flaky networks" }, { text: "cap upload retries so flaky networks cannot loop forever" }]);
      const res = await runAsync(["brief-lessons", "c1", dir], dir, NO_OLLAMA);
      expect(res.status, res.stderr).toBe(0);
      expect(res.stdout.split("\n").some((l) => l.startsWith("index: omitted"))).toBe(false);
      expect(JSON.parse(readFileSync(lessonsFile(dir), "utf8")).omitted).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    const bare = tempDir();
    try {
      writeBoard(bare);
      expect((await runAsync(["brief-lessons", "c1", bare], bare, NO_OLLAMA)).status).toBe(0);
      expect(JSON.parse(readFileSync(lessonsFile(bare), "utf8")).omitted).toEqual([]);
      mkdirSync(join(bare, ".doug", ".state", "memory"), { recursive: true });
      writeFileSync(dbFile(bare), "this is not a sqlite database ".repeat(200), "utf8");
      expect((await runAsync(["brief-lessons", "c1", bare], bare, NO_OLLAMA)).status).toBe(0);
      expect(JSON.parse(readFileSync(lessonsFile(bare), "utf8")).omitted).toEqual([]);
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });

  it("q1: a queen-path fetch (brief-lessons and lesson show run from the card worktree with the repo root as [dir]) lands in main and reflect --hand on main credits it after the worktree is gone", async () => {
    const main = tempDir();
    try {
      writeBoard(main);
      const wt = join(main, ".claude", "worktrees", "card-c1");
      mkdirSync(wt, { recursive: true });
      const [A, B] = seed(main, [{ text: "upload retries need exponential backoff on flaky networks" }, { text: "cap upload retries so flaky networks cannot loop forever" }]);
      const bl = await runAsync(["brief-lessons", "c1", main], wt, NO_OLLAMA);
      expect(bl.status, bl.stderr).toBe(0);
      const shown = run(["lesson", "show", A.id, main, "--card", "c1"], wt);
      expect(shown.status, shown.stderr).toBe(0);
      const reports = join(main, ".doug", ".state", "reports", "c1");
      const fetched = readFileSync(join(reports, "fetched.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l).id);
      expect(fetched).toEqual([A.id]);
      expect(existsSync(join(reports, "lessons.json"))).toBe(true);
      expect(existsSync(join(wt, ".doug", ".state"))).toBe(false);
      rmSync(wt, { recursive: true, force: true });
      mkdirSync(join(reports, "briefs"), { recursive: true });
      mkdirSync(join(reports, "reviews"), { recursive: true });
      writeFileSync(join(reports, "briefs", "1-coder.md"), "brief", "utf8");
      writeFileSync(join(reports, "reviews", "1.md"), "review", "utf8");
      const claude = writeFakeClaudeSuccess(main, { structured_output: { lessons: [] }, session_id: "sess-q", total_cost_usd: 0.01, is_error: false });
      const res = run(["reflect", "--hand", "c1", main, "--commit", "abc1234", "--claude-bin", claude], main);
      expect(res.status, res.stderr).toBe(0);
      const m = openMemory(main);
      let rows;
      try {
        rows = Object.fromEntries(m.prepare("SELECT id, helpful FROM lessons").all().map((r) => [r.id, r.helpful]));
      } finally {
        m.close();
      }
      expect(rows[A.id]).toBe(1);
      expect(rows[B.id]).toBe(0);
      const hr = JSON.parse(readFileSync(join(reports, "hand-report.json"), "utf8"));
      expect(hr.levels[0].tasks[0].memoryUsed).toEqual([A.id]);
    } finally {
      rmSync(main, { recursive: true, force: true });
    }
  });
});

describe("memory.mjs lesson show (card memory-progressive-access)", () => {
  const memDir = (dir) => join(dir, ".doug", ".state", "memory");
  const body = (stdout) => stdout.slice(stdout.indexOf("\n\n") + 2).replace(/\n$/, "");
  const seedOne = (dir, extra = {}) => {
    const m = openMemory(dir);
    const row = addLesson(m, { kind: "pattern", source: { agent: "worker" }, text: "text", ...extra });
    m.close();
    return row;
  };

  it("M7, M8: prints the cost line, the citation line, a blank line and then the whole text, never cut", () => {
    const dir = tempDir();
    try {
      const text = "Full lesson heading\n" + "alpha beta gamma delta. ".repeat(80).slice(0, 1480) + "\nTAIL-MARKER-END";
      expect(text.length).toBeGreaterThan(1400);
      const row = seedOne(dir, { text, citation: "docs/x.md:12" });
      const res = run(["lesson", "show", row.id, dir], dir);
      expect(res.status, res.stderr).toBe(0);
      const lines = res.stdout.split("\n");
      expect(lines[0]).toBe(`lesson ${row.id} (pattern, ~${Math.ceil(text.length / 4)} tokens)`);
      expect(lines[1]).toBe("citation: docs/x.md:12");
      expect(lines[2]).toBe("");
      expect(body(res.stdout)).toBe(text);
      expect(res.stdout).toContain("TAIL-MARKER-END");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("M8: a lesson with no citation prints `citation: none`", () => {
    const dir = tempDir();
    try {
      const row = seedOne(dir, { text: "plain lesson", kind: "pitfall" });
      const res = run(["lesson", "show", row.id, dir], dir);
      expect(res.status, res.stderr).toBe(0);
      const lines = res.stdout.split("\n");
      expect(lines[0]).toBe(`lesson ${row.id} (pitfall, ~3 tokens)`);
      expect(lines[1]).toBe("citation: none");
      expect(lines[2]).toBe("");
      expect(body(res.stdout)).toBe("plain lesson");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("M9: a superseded lesson and a stale-marked lesson are shown with their status, not hidden", () => {
    const dir = tempDir();
    try {
      const m = openMemory(dir);
      const older = addLesson(m, { kind: "pattern", source: { agent: "worker" }, text: "older lesson text", citation: "a.md:1" });
      const newer = addLesson(m, { kind: "pattern", source: { agent: "worker" }, text: "newer lesson text", citation: "b.md:1" });
      supersedeLesson(m, older.id, newer.id);
      const stale = addLesson(m, { kind: "pattern", source: { agent: "worker" }, text: "stale lesson text", citation: "c.md:1" });
      m.prepare("UPDATE lessons SET stale = ? WHERE id = ?").run("2026-10-01T00:00:00.000Z", stale.id);
      m.close();
      const sup = run(["lesson", "show", older.id, dir], dir);
      expect(sup.status, sup.stderr).toBe(0);
      expect(sup.stdout.split("\n")).toContain(`superseded by ${newer.id}`);
      expect(sup.stdout.split("\n").indexOf(`superseded by ${newer.id}`)).toBeLessThan(sup.stdout.split("\n").indexOf(""));
      expect(body(sup.stdout)).toBe("older lesson text");
      const st = run(["lesson", "show", stale.id, dir], dir);
      expect(st.status, st.stderr).toBe(0);
      expect(st.stdout.split("\n")).toContain("stale since 2026-10-01T00:00:00.000Z");
      expect(body(st.stdout)).toBe("stale lesson text");
      const plain = run(["lesson", "show", newer.id, dir], dir);
      expect(plain.stdout).not.toContain("superseded by");
      expect(plain.stdout).not.toContain("stale since");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is read-only: showing a stale lesson writes no column", () => {
    const dir = tempDir();
    try {
      const row = seedOne(dir, { text: "stale one" });
      let m = openMemory(dir);
      m.prepare("UPDATE lessons SET stale = ? WHERE id = ?").run("2026-10-01T00:00:00.000Z", row.id);
      const before = getLesson(m, row.id);
      m.close();
      expect(run(["lesson", "show", row.id, dir], dir).status).toBe(0);
      m = openMemory(dir);
      const after = getLesson(m, row.id);
      m.close();
      expect(after).toEqual(before);
      expect(after.stale).toBe("2026-10-01T00:00:00.000Z");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("M10: with no memory store it exits 1 naming the lesson and creates nothing; an unknown id in a seeded store exits 1", () => {
    const dir = tempDir();
    try {
      const res = run(["lesson", "show", "abc", dir], dir);
      expect(res.status).toBe(1);
      expect(res.stderr).toContain("no lesson abc");
      expect(res.stdout).toBe("");
      expect(existsSync(memDir(dir))).toBe(false);
      expect(existsSync(join(dir, ".doug", ".state"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    const seeded = tempDir();
    try {
      seedOne(seeded, { text: "one" });
      const res = run(["lesson", "show", "zzz", seeded], seeded);
      expect(res.status).toBe(1);
      expect(res.stderr).toContain("no lesson zzz");
      expect(res.stdout).toBe("");
    } finally {
      rmSync(seeded, { recursive: true, force: true });
    }
  });

  it("a missing id exits 2 with the usage, which lists `lesson show`; so does the bare `lesson` command", () => {
    const dir = tempDir();
    try {
      const res = run(["lesson", "show"], dir);
      expect(res.status).toBe(2);
      expect(res.stderr).toContain("lesson show");
      const bare = run(["lesson"], dir);
      expect(bare.status).toBe(2);
      expect(bare.stderr).toContain("lesson show");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("M11: --json carries tokens and hasVector and no embedding blob", () => {
    const dir = tempDir();
    try {
      const text = "json lesson " + "w".repeat(90);
      const m = openMemory(dir);
      const withVec = addLesson(m, { kind: "project", source: { agent: "worker" }, text, citation: "j.md:1" });
      setLessonEmbedding(m, withVec.id, { model: "embeddinggemma", dims: 4, vector: Float32Array.from([1, 0, 0, 0]) });
      const noVec = addLesson(m, { kind: "project", source: { agent: "worker" }, text: "no vector here" });
      m.close();
      const a = JSON.parse(run(["lesson", "show", withVec.id, dir, "--json"], dir).stdout);
      expect(a.id).toBe(withVec.id);
      expect(a.text).toBe(text);
      expect(a.kind).toBe("project");
      expect(a.citation).toBe("j.md:1");
      expect(a.tokens).toBe(Math.ceil(text.length / 4));
      expect(a.hasVector).toBe(true);
      expect(a).not.toHaveProperty("embedding");
      const b = JSON.parse(run(["lesson", "show", noVec.id, dir, "--json"], dir).stdout);
      expect(b.hasVector).toBe(false);
      expect(b).not.toHaveProperty("embedding");
      expect(b.tokens).toBe(4);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("memory.mjs lesson show --card (card memory-reflect-fetched-only)", () => {
  const seed = (dir) => {
    const m = openMemory(dir);
    try {
      return addLesson(m, { kind: "pattern", source: { agent: "worker" }, text: "fetchable lesson" }).id;
    } finally {
      m.close();
    }
  };
  const file = (dir, card) => join(dir, ".doug", ".state", "reports", card, "fetched.jsonl");

  it("g1: --card appends one {id, at} line per fetch and still prints the lesson", () => {
    const dir = tempDir();
    try {
      const id = seed(dir);
      const a = run(["lesson", "show", id, dir, "--card", "c9"], dir);
      expect(a.status, a.stderr).toBe(0);
      expect(a.stdout).toContain("fetchable lesson");
      run(["lesson", "show", id, dir, "--card", "c9"], dir);
      const lines = readFileSync(file(dir, "c9"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
      expect(lines).toHaveLength(2);
      for (const l of lines) {
        expect(l.id).toBe(id);
        expect(Number.isNaN(Date.parse(l.at))).toBe(false);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("g2: without --card nothing is written; an unknown id with --card exits 1 and writes nothing", () => {
    const dir = tempDir();
    try {
      const id = seed(dir);
      expect(run(["lesson", "show", id, dir], dir).status).toBe(0);
      expect(existsSync(join(dir, ".doug", ".state", "reports"))).toBe(false);
      const unknown = run(["lesson", "show", "zzzz", dir, "--card", "c9"], dir);
      expect(unknown.status).toBe(1);
      expect(existsSync(file(dir, "c9"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("g3: a --card value that is not a plain id exits 2 and writes nothing", () => {
    const dir = tempDir();
    try {
      const id = seed(dir);
      for (const bad of ["../escape", "a/b", "..", ".hidden", ""]) {
        const res = run(["lesson", "show", id, dir, "--card", bad], dir);
        expect(res.status, `card ${JSON.stringify(bad)}`).toBe(2);
      }
      expect(existsSync(join(dir, ".doug", ".state", "escape"))).toBe(false);
      expect(existsSync(join(dir, ".doug", ".state", "reports"))).toBe(false);
      expect(existsSync(join(dir, ".doug", "escape"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("memory.mjs history show (card memory-progressive-access)", () => {
  const scan = (t) => (t.includes("SECRETMARK") ? { rule: "testRule" } : null);
  const entry = (n, text = "text " + n, extra = {}) => ({ kind: "hand-back", seat: "lead", round: n, source: "journal.jsonl", value: text, ...extra });

  it("M16: a card id lists its runs with entry counts and cost", () => {
    const dir = tempDir();
    try {
      writeRunHistory(dir, { card: "c1", run: "wf_a", entries: [entry(1, "abcdefgh"), entry(2, "abcd")], scan });
      writeRunHistory(dir, { card: "c1", run: "wf_b", entries: [entry(1)], scan });
      const res = run(["history", "show", "c1", dir], dir);
      expect(res.status, res.stderr).toBe(0);
      expect(res.stdout.split("\n").filter(Boolean)).toEqual(["history c1: 2 runs", "c1/wf_a  2 entries  ~3 tokens", "c1/wf_b  1 entries  ~2 tokens"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("M13, M14: a run id lists each entry with its cost, marks a truncated or redacted entry, and shows the cap line", () => {
    const dir = tempDir();
    try {
      const entries = [
        { kind: "report", seat: null, round: null, source: "report.json", value: "abcdefgh" },
        entry(2, "q".repeat(300)),
        entry(3, "has SECRETMARK inside"),
        entry(4),
        entry(5),
      ];
      const probe = writeRunHistory(join(dir, "probe"), { card: "c1", run: "wf_1", entries, scan, maxEntryBytes: 100 });
      const lens = readFileSync(probe.path, "utf8").split("\n").filter((x) => x !== "").map((x) => Buffer.byteLength(x) + 1);
      const cap = lens[0] + lens[1] + lens[2] + 3;
      writeRunHistory(dir, { card: "c1", run: "wf_1", entries, scan, maxEntryBytes: 100, maxRunBytes: cap });
      const res = run(["history", "show", "c1/wf_1", dir], dir);
      expect(res.status, res.stderr).toBe(0);
      const lines = res.stdout.split("\n").filter(Boolean);
      const data = readRunHistory(dir, { card: "c1", run: "wf_1" });
      expect(lines[0]).toMatch(/^history c1\/wf_1: \d+ entries, ~\d+ tokens$/);
      expect(lines[0]).toContain(`, ~${data.tokens} tokens`);
      expect(lines[1]).toBe("1  report  -  -  report.json  ~2 tokens");
      expect(lines[2]).toBe("2  hand-back  lead  2  journal.jsonl  ~25 tokens truncated from 300 bytes");
      expect(lines[3]).toBe(`3  hand-back  lead  3  journal.jsonl  ~${Math.ceil("[redacted: testRule]".length / 4)} tokens redacted: testRule`);
      expect(lines[4]).toBe(`4  cap  dropped 2 entries over ${cap} bytes`);
      expect(lines).toHaveLength(5);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("M12: a card/run:line id prints the header with the cost, a blank line and the entry text unchanged", () => {
    const dir = tempDir();
    try {
      writeRunHistory(dir, { card: "c1", run: "wf_1", entries: [entry(1), entry(2, "line one\n\nline three  spaced"), entry(3)], scan });
      const res = run(["history", "show", "history:c1/wf_1.jsonl:2", dir], dir);
      expect(res.status, res.stderr).toBe(0);
      const lines = res.stdout.split("\n");
      expect(lines[0]).toBe("history c1/wf_1:2 (hand-back, seat lead, round 2, journal.jsonl, ~7 tokens)");
      expect(lines[1]).toBe("");
      expect(res.stdout.slice(res.stdout.indexOf("\n\n") + 2).replace(/\n$/, "")).toBe("line one\n\nline three  spaced");
      const first = run(["history", "show", "c1/wf_1:1", dir], dir);
      expect(first.stdout).toContain("text 1");
      expect(first.stdout).not.toContain("line one");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("M14: a line fetch says when the entry was truncated at capture or redacted", () => {
    const dir = tempDir();
    try {
      writeRunHistory(dir, { card: "c1", run: "wf_1", entries: [entry(1, "z".repeat(300)), entry(2, "has SECRETMARK inside")], scan, maxEntryBytes: 100 });
      const t = run(["history", "show", "c1/wf_1:1", dir], dir).stdout.split("\n");
      expect(t[0]).toBe("history c1/wf_1:1 (hand-back, seat lead, round 1, journal.jsonl, ~25 tokens)");
      expect(t[1]).toBe("truncated at capture: 300 bytes, head kept");
      expect(t[2]).toBe("");
      expect(t[3]).toBe("z".repeat(100));
      const r = run(["history", "show", "c1/wf_1:2", dir], dir).stdout.split("\n");
      expect(r[1]).toBe("redacted: testRule");
      expect(r[2]).toBe("");
      expect(r[3]).toBe("[redacted: testRule]");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--json prints readRunHistory's object and needs no memory database", () => {
    const dir = tempDir();
    try {
      writeRunHistory(dir, { card: "c1", run: "wf_1", entries: [entry(1), entry(2)], scan });
      const res = run(["history", "show", "c1/wf_1", dir, "--json"], dir);
      expect(res.status, res.stderr).toBe(0);
      expect(JSON.parse(res.stdout)).toEqual(readRunHistory(dir, { card: "c1", run: "wf_1" }));
      const one = run(["history", "show", "c1/wf_1:2", dir, "--json"], dir);
      expect(JSON.parse(one.stdout)).toEqual(readRunHistory(dir, { card: "c1", run: "wf_1", line: 2 }));
      expect(existsSync(join(dir, ".doug", ".state", "memory"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("M15: a bad id exits 2 and a missing id exits 2", () => {
    const dir = tempDir();
    try {
      for (const bad of ["../x", "c1/..:1", "c1/wf:0"]) {
        const res = run(["history", "show", bad, dir], dir);
        expect(res.status, bad).toBe(2);
        expect(res.stderr, bad).toContain("bad history id");
      }
      expect(run(["history", "show"], dir).status).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a missing card, run or line exits 1 with one stderr line naming it, and creates nothing", () => {
    const dir = tempDir();
    try {
      const none = run(["history", "show", "nope", dir], dir);
      expect(none.status).toBe(1);
      expect(none.stderr.trim().split("\n")).toHaveLength(1);
      expect(none.stderr).toContain("no history");
      writeRunHistory(dir, { card: "c1", run: "wf_1", entries: [entry(1), entry(2), entry(3)], scan });
      const noRun = run(["history", "show", "c1/wf_9", dir], dir);
      expect(noRun.status).toBe(1);
      expect(noRun.stderr).toContain("no history");
      const noLine = run(["history", "show", "c1/wf_1:9", dir], dir);
      expect(noLine.status).toBe(1);
      expect(noLine.stderr.trim().split("\n")).toHaveLength(1);
      expect(noLine.stderr).toContain("no line 9 in c1/wf_1 (3 lines)");
      expect(existsSync(join(dir, ".doug", ".state", "memory"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("memory.mjs record --hand --cost (card usd-budget-size-class)", () => {
  const base = (dir) => ["record", "hand-track-outcomes", "--hand", dir, "--commit", "abc1234def5", "--wall", "34 min", "--gate", "gate text"];
  const rows = (dir) => JSON.parse(run(["outcomes", dir, "--json"], dir).stdout);

  it("C1: --cost <usd> fills the outcome row's usd column and leaves the other workflow-only columns null", () => {
    const dir = tempDir();
    const res = run([...base(dir), "--cost", "3.21"], dir);
    expect(res.status, res.stderr).toBe(0);
    const [row] = rows(dir);
    expect(row.usd).toBe(3.21);
    expect(row.tokens).toBeNull();
    expect(row.codex_usd).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });

  it("C2: without --cost usd stays null, not 0", () => {
    const dir = tempDir();
    expect(run(base(dir), dir).status).toBe(0);
    expect(rows(dir)[0].usd).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });

  it("C3: re-recording the same commit with --cost updates the row's usd", () => {
    const dir = tempDir();
    expect(run(base(dir), dir).status).toBe(0);
    const again = run([...base(dir), "--cost", "4.5"], dir);
    expect(again.status, again.stderr).toBe(0);
    expect(rows(dir)).toHaveLength(1);
    expect(rows(dir)[0].usd).toBe(4.5);
    rmSync(dir, { recursive: true, force: true });
  });

  it("C4: a non-numeric or negative --cost is refused with exit 2 naming --cost, and records nothing", () => {
    for (const bad of ["abc", "-1", "$3", ""]) {
      const dir = tempDir();
      const res = run([...base(dir), "--cost", bad], dir);
      expect(res.status, `--cost "${bad}"`).toBe(2);
      expect(res.stderr, `--cost "${bad}"`).toContain("--cost");
      expect(res.stderr, `--cost "${bad}"`).not.toMatch(/unknown option/i);
      expect(rows(dir), `--cost "${bad}"`).toHaveLength(0);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("C5: the hand usage line names --cost", () => {
    const dir = tempDir();
    const res = run(["record", "--hand", dir], dir);
    expect(res.status).toBe(2);
    expect(res.stderr).toContain("[--cost <usd>]");
    rmSync(dir, { recursive: true, force: true });
  });
});

// card recall-window-report: the stale window reports what it hid.
describe("recall window report (card recall-window-report)", () => {
  const DAY = 86400000;
  const ago = (n) => new Date(Date.now() - n * DAY - 3600000).toISOString();
  const NOTE = (hid, total, days, oldest) => `window: hid ${hid} of ${total} live lessons older than ${days} days (oldest ${oldest} days)`;
  const NO_OLLAMA = { DOUG_OLLAMA_BASE_URL: "http://127.0.0.1:1" };
  const hookScript = join(here, "..", "scripts", "session-recall.mjs");
  const lessonsFile = (dir) => join(dir, ".doug", ".state", "reports", "c1", "lessons.json");
  const card = { id: "c1", title: "Retry flaky uploads", goal: "make upload retries robust against flaky networks", column: "flow" };

  function seedRows(dir, rows) {
    const m = openMemory(dir);
    for (const [text, created] of rows) addLesson(m, { kind: "pattern", source: { agent: "worker" }, text, created });
    m.close();
  }
  function writeBoard(dir) {
    mkdirSync(join(dir, ".doug"), { recursive: true });
    const board = { version: 1, updated: "2026-10-07", columns: [{ id: "ready", title: "Ready" }, { id: "flow", title: "In flow" }], components: [], tags: [], cards: [card] };
    writeFileSync(join(dir, ".doug", "board.json"), JSON.stringify(board), "utf8");
  }
  function hook(dir) {
    return new Promise((resolvePromise) => {
      const child = spawn(process.execPath, [hookScript], { cwd: dir, env: { ...process.env, CLAUDE_PROJECT_DIR: dir, DOUG_SESSION_RECALL: "", ...NO_OLLAMA } });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      child.on("close", (status) => resolvePromise({ status, stdout, stderr }));
      child.stdin.on("error", () => {});
      child.stdin.end(JSON.stringify({ hook_event_name: "SessionStart", source: "startup", cwd: dir }));
    });
  }
  const ctx = (res) => JSON.parse(res.stdout).hookSpecificOutput.additionalContext;
  const FRESH = "upload retries need exponential backoff on flaky networks";

  it("recall with one fresh and one 100-day-old lesson prints the window line as line 2", () => {
    const dir = mkdtempSync(join(tmpdir(), "doug-memory-cli-"));
    try {
      seedRows(dir, [[FRESH, ago(1)], ["old upload retries note", ago(100)]]);
      const res = run(["recall", "upload retries", dir], dir);
      expect(res.status, res.stderr).toBe(0);
      expect(res.stdout.split("\n")[1]).toBe(NOTE(1, 2, 30, 100));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("recall --json has hidden.count 1, hidden.total 2, hidden.oldestDays 100", () => {
    const dir = mkdtempSync(join(tmpdir(), "doug-memory-cli-"));
    try {
      seedRows(dir, [[FRESH, ago(1)], ["old upload retries note", ago(100)]]);
      const res = run(["recall", "upload retries", dir, "--json"], dir);
      expect(res.status, res.stderr).toBe(0);
      expect(JSON.parse(res.stdout).hidden).toEqual({ count: 1, total: 2, oldestDays: 100 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("recall with memory.staleDays 10 and a 20-day-old lesson names 10 days in the window line", () => {
    const dir = mkdtempSync(join(tmpdir(), "doug-memory-cli-"));
    try {
      mkdirSync(join(dir, ".doug"), { recursive: true });
      writeFileSync(join(dir, ".doug", "config.json"), JSON.stringify({ memory: { staleDays: 10 } }), "utf8");
      seedRows(dir, [[FRESH, ago(1)], ["old upload retries note", ago(20)]]);
      const res = run(["recall", "upload retries", dir], dir);
      expect(res.status, res.stderr).toBe(0);
      expect(res.stdout.split("\n")[1]).toBe(NOTE(1, 2, 10, 20));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("brief-lessons with memory.staleDays 10 and a 20-day-old lesson names 10 days in the window line before memoryUsed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "doug-memory-cli-"));
    try {
      writeBoard(dir);
      writeFileSync(join(dir, ".doug", "config.json"), JSON.stringify({ memory: { staleDays: 10 } }), "utf8");
      seedRows(dir, [[FRESH, ago(1)], ["old upload retries note", ago(20)]]);
      const res = await runAsync(["brief-lessons", "c1", dir], dir, NO_OLLAMA);
      expect(res.status, res.stderr).toBe(0);
      const lines = res.stdout.split("\n");
      const w = lines.indexOf(NOTE(1, 2, 10, 20));
      const u = lines.findIndex((l) => l.startsWith("memoryUsed: "));
      expect(w).toBeGreaterThan(-1);
      expect(u).toBeGreaterThan(w);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("recall with memory.staleDays 10 and a 20-day-old lesson names 10 days in the window line", () => {
    const dir = mkdtempSync(join(tmpdir(), "doug-memory-cli-"));
    try {
      mkdirSync(join(dir, ".doug"), { recursive: true });
      writeFileSync(join(dir, ".doug", "config.json"), JSON.stringify({ memory: { staleDays: 10 } }), "utf8");
      seedRows(dir, [[FRESH, ago(1)], ["old upload retries note", ago(20)]]);
      const res = run(["recall", "upload retries", dir], dir);
      expect(res.status, res.stderr).toBe(0);
      expect(res.stdout.split("\n")[1]).toBe(NOTE(1, 2, 10, 20));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("brief-lessons with memory.staleDays 10 and a 20-day-old lesson names 10 days in the window line before memoryUsed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "doug-memory-cli-"));
    try {
      writeBoard(dir);
      writeFileSync(join(dir, ".doug", "config.json"), JSON.stringify({ memory: { staleDays: 10 } }), "utf8");
      seedRows(dir, [[FRESH, ago(1)], ["old upload retries note", ago(20)]]);
      const res = await runAsync(["brief-lessons", "c1", dir], dir, NO_OLLAMA);
      expect(res.status, res.stderr).toBe(0);
      const lines = res.stdout.split("\n");
      const w = lines.indexOf(NOTE(1, 2, 10, 20));
      const u = lines.findIndex((l) => l.startsWith("memoryUsed: "));
      expect(w).toBeGreaterThan(-1);
      expect(u).toBeGreaterThan(w);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("brief-lessons with a matching fresh lesson and an old lesson prints the window line before memoryUsed and lessons.json.hidden.count is 1", async () => {
    const dir = mkdtempSync(join(tmpdir(), "doug-memory-cli-"));
    try {
      writeBoard(dir);
      seedRows(dir, [[FRESH, ago(1)], ["old upload retries note", ago(100)]]);
      const res = await runAsync(["brief-lessons", "c1", dir], dir, NO_OLLAMA);
      expect(res.status, res.stderr).toBe(0);
      const lines = res.stdout.split("\n");
      const w = lines.indexOf(NOTE(1, 2, 30, 100));
      const u = lines.findIndex((l) => l.startsWith("memoryUsed: "));
      expect(w).toBeGreaterThan(-1);
      expect(u).toBeGreaterThan(w);
      expect(JSON.parse(readFileSync(lessonsFile(dir), "utf8")).hidden.count).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("brief-lessons whose only lesson is 100 days old prints `No lessons recalled for c1.` then the window line", async () => {
    const dir = mkdtempSync(join(tmpdir(), "doug-memory-cli-"));
    try {
      writeBoard(dir);
      seedRows(dir, [["old upload retries note", ago(100)]]);
      const res = await runAsync(["brief-lessons", "c1", dir], dir, NO_OLLAMA);
      expect(res.status, res.stderr).toBe(0);
      const lines = res.stdout.split("\n");
      const n = lines.findIndex((l) => l.includes("No lessons recalled for c1."));
      expect(n).toBeGreaterThan(-1);
      expect(lines[n + 1]).toBe(NOTE(1, 1, 30, 100));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("recall and brief-lessons with only fresh lessons print no line starting `window:`", async () => {
    const dir = mkdtempSync(join(tmpdir(), "doug-memory-cli-"));
    try {
      writeBoard(dir);
      seedRows(dir, [[FRESH, ago(1)]]);
      const r = run(["recall", "upload retries", dir], dir);
      expect(r.stdout.split("\n").filter((l) => l.startsWith("window:"))).toEqual([]);
      const b = await runAsync(["brief-lessons", "c1", dir], dir, NO_OLLAMA);
      expect(b.stdout).toContain("memoryUsed: ");
      expect(b.stdout.split("\n").filter((l) => l.startsWith("window:"))).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("session-recall with a flow card, a matching fresh lesson and an old lesson -> additionalContext contains the window line", async () => {
    const dir = mkdtempSync(join(tmpdir(), "doug-memory-cli-"));
    try {
      writeBoard(dir);
      seedRows(dir, [[FRESH, ago(1)], ["old upload retries note", ago(100)]]);
      const res = await hook(dir);
      expect(res.status, res.stderr).toBe(0);
      const c = ctx(res);
      expect(c).toContain(FRESH);
      expect(c.split("\n")).toContain(NOTE(1, 2, 30, 100));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("session-recall with no flow card, memory.staleDays 10, one fresh and one 20-day-old lesson -> additionalContext contains the window line at 10 days", async () => {
    const dir = mkdtempSync(join(tmpdir(), "doug-memory-cli-"));
    try {
      mkdirSync(join(dir, ".doug"), { recursive: true });
      writeFileSync(join(dir, ".doug", "config.json"), JSON.stringify({ memory: { staleDays: 10 } }), "utf8");
      seedRows(dir, [[FRESH, ago(1)], ["twenty day old note", ago(20)]]);
      const res = await hook(dir);
      expect(res.status, res.stderr).toBe(0);
      const c = ctx(res);
      expect(c).toContain(FRESH);
      expect(c).toContain(NOTE(1, 2, 10, 20));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("session-recall whose only lesson is 100 days old emits additionalContext containing the window line", async () => {
    const dir = mkdtempSync(join(tmpdir(), "doug-memory-cli-"));
    try {
      writeBoard(dir);
      seedRows(dir, [["old upload retries note", ago(100)]]);
      const res = await hook(dir);
      expect(res.status, res.stderr).toBe(0);
      const c = ctx(res);
      expect(c.startsWith("[doug] ")).toBe(true);
      expect(c).toContain(NOTE(1, 1, 30, 100));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// Card memory-outcome-arms: the memory configuration is stamped into condition.json, copied onto the outcomes
// row by `record --hand`, and `memory.mjs arms` compares the arms from existing rows.
const sortKeysDeep = (v) =>
  Array.isArray(v) ? v.map(sortKeysDeep) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeysDeep(v[k])])) : v;

describe("memory.mjs condition open: memoryConfig (card memory-outcome-arms)", () => {
  it("stamps memoryConfig from the project's embeddings config and staleDays", () => {
    const dir = gitRepoDir();
    writeConditionBoard(dir);
    const embeddings = { provider: "openai-compatible", baseUrl: "http://127.0.0.1:9/v1", model: "embeddinggemma", dims: 768, apiKeyEnv: "SOME_KEY" };
    writeFileSync(join(dir, ".doug", "config.json"), JSON.stringify({ memory: { embeddings, staleDays: 14 } }), "utf8");
    const res = run(["condition", "open", "classed-card", dir], dir);
    expect(res.status, res.stderr).toBe(0);
    const written = JSON.parse(readFileSync(join(dir, ".doug", ".state", "reports", "classed-card", "condition.json"), "utf8"));
    expect(written.memoryConfig).toEqual(memoryConfig({ embeddings, staleDays: 14 }));
    expect(written.memoryConfig.embeddings).toEqual({ provider: "openai-compatible", model: "embeddinggemma", dims: 768 });
    expect(written.memoryConfig.staleDays).toBe(14);
    rmSync(dir, { recursive: true, force: true });
  });

  it("with no memory config the stamp is keyword-only with staleDays 30", () => {
    const dir = gitRepoDir();
    writeConditionBoard(dir);
    const res = run(["condition", "open", "classed-card", dir], dir);
    expect(res.status, res.stderr).toBe(0);
    const written = JSON.parse(readFileSync(join(dir, ".doug", ".state", "reports", "classed-card", "condition.json"), "utf8"));
    expect(written.memoryConfig).toEqual(memoryConfig({ embeddings: null, staleDays: 30 }));
    expect(written.memoryConfig.embeddings).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });

  it("record --hand after condition open stores the canonical memory_config JSON on the row; without a condition it is null", () => {
    const dir = gitRepoDir();
    writeConditionBoard(dir);
    writeFileSync(join(dir, ".doug", "config.json"), JSON.stringify({ memory: { staleDays: 21 } }), "utf8");
    expect(run(["condition", "open", "classed-card", dir], dir).status).toBe(0);
    const condition = JSON.parse(readFileSync(join(dir, ".doug", ".state", "reports", "classed-card", "condition.json"), "utf8"));
    const res = run(["record", "classed-card", "--hand", dir, "--commit", "abc1234def5"], dir);
    expect(res.status, res.stderr).toBe(0);
    const [row] = JSON.parse(run(["outcomes", dir, "--json"], dir).stdout);
    expect(row.memory_config).toBe(JSON.stringify(sortKeysDeep(condition.memoryConfig)));
    expect(JSON.parse(row.memory_config).staleDays).toBe(21);
    rmSync(dir, { recursive: true, force: true });

    const bare = tempDir();
    expect(run(["record", "no-condition-card", "--hand", bare, "--commit", "abc1234def5"], bare).status).toBe(0);
    const [bareRow] = JSON.parse(run(["outcomes", bare, "--json"], bare).stdout);
    expect(bareRow.memory_config).toBeNull();
    rmSync(bare, { recursive: true, force: true });
  });
});

describe("memory.mjs track stamps (card memory-flow-index-fetch)", () => {
  it("M5: condition open stamps the hand delivery, index+fetch", () => {
    const dir = gitRepoDir();
    writeConditionBoard(dir);
    expect(run(["condition", "open", "classed-card", dir], dir).status).toBe(0);
    const written = JSON.parse(readFileSync(join(dir, ".doug", ".state", "reports", "classed-card", "condition.json"), "utf8"));
    expect(written.memoryConfig.delivery).toBe("index+fetch");
    expect(written.memoryConfig.lessonChars).toBeUndefined();
    rmSync(dir, { recursive: true, force: true });
  });

  it("M4: record <report.json> stamps the flow row index+fetch with a 4000-token fetch and the project's staleDays", () => {
    const dir = tempDir();
    try {
      mkdirSync(join(dir, ".doug"), { recursive: true });
      writeFileSync(join(dir, ".doug", "config.json"), JSON.stringify({ memory: { staleDays: 21 } }), "utf8");
      const res = run(["record", fixtureReport, dir], dir);
      expect(res.status, res.stderr).toBe(0);
      const rows = JSON.parse(run(["outcomes", dir, "--json"], dir).stdout);
      expect(rows).toHaveLength(1);
      expect(rows[0].track).toBe("flow");
      const cfg = JSON.parse(rows[0].memory_config);
      expect(cfg.delivery).toBe("index+fetch");
      expect(cfg.fetchTokens).toBe(4000);
      expect(cfg.lessonChars).toBeUndefined();
      expect(cfg.totalChars).toBeUndefined();
      expect(cfg.staleDays).toBe(21);
      expect(rows[0].memory_config).toBe(JSON.stringify(sortKeysDeep(memoryConfig({ embeddings: null, staleDays: 21, track: "flow" }))));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("M6: a hand row and a flow row in one store form two arms, both index+fetch and told apart by fetchTokens, none unstamped", () => {
    const dir = gitRepoDir();
    try {
      writeConditionBoard(dir);
      expect(run(["condition", "open", "classed-card", dir], dir).status).toBe(0);
      expect(run(["record", "classed-card", "--hand", dir, "--commit", "abc1234def5"], dir).status).toBe(0);
      const rec = run(["record", fixtureReport, dir], dir);
      expect(rec.status, rec.stderr).toBe(0);
      const out = JSON.parse(run(["arms", dir, "--min", "1", "--json"], dir).stdout);
      expect(out.unstamped).toBe(0);
      expect(out.arms).toHaveLength(2);
      const cfgs = out.arms.map((a) => JSON.parse(a.config));
      expect(cfgs.map((c) => c.delivery)).toEqual(["index+fetch", "index+fetch"]);
      expect(cfgs.filter((c) => c.fetchTokens !== undefined)).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("memory.mjs arms (card memory-outcome-arms)", () => {
  const cond = (cfg) => ({ harnessCommit: "h1", configHash: "c1", class: "code", arm: "code/default", assignedBy: "policy", exploreProbability: null, memoryConfig: cfg });
  const cfgA = () => memoryConfig({ embeddings: null, staleDays: 30 });
  const cfgB = () => memoryConfig({ embeddings: null, staleDays: 14 });
  function seed(dir, specs) {
    const m = openMemory(dir);
    try {
      let i = 0;
      for (const [cfg, n] of specs) {
        for (let j = 0; j < n; j++) {
          i++;
          const now = `2026-10-${String(1 + Math.floor(i / 20)).padStart(2, "0")}T00:${String(i % 20).padStart(2, "0")}:00.000Z`;
          recordOutcomes(m, [handOutcomeRow({ card: `card-${i}`, commit: `sha${i}`, now, condition: cond(cfg), cost: 1 })]);
        }
      }
    } finally {
      m.close();
    }
  }

  it("--min 2 --json reports min 2, both two-landing arms ready, and comparable true", () => {
    const dir = tempDir();
    try {
      seed(dir, [[cfgA(), 2], [cfgB(), 2]]);
      const res = run(["arms", dir, "--min", "2", "--json"], dir);
      expect(res.status, res.stderr).toBe(0);
      const out = JSON.parse(res.stdout);
      expect(out.min).toBe(2);
      expect(out.arms).toHaveLength(2);
      expect(out.arms.map((a) => a.ready)).toEqual([true, true]);
      expect(out.arms.map((a) => a.landings)).toEqual([2, 2]);
      expect(out.comparable).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the default threshold is 12: two small arms are not ready and not comparable", () => {
    const dir = tempDir();
    try {
      seed(dir, [[cfgA(), 2], [cfgB(), 2]]);
      const out = JSON.parse(run(["arms", dir, "--json"], dir).stdout);
      expect(out.min).toBe(12);
      expect(out.arms.map((a) => a.ready)).toEqual([false, false]);
      expect(out.comparable).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--min must be an integer >= 1: 0, 1.5 and abc exit 2 with usage", () => {
    const dir = tempDir();
    try {
      seed(dir, [[cfgA(), 1]]);
      for (const bad of ["0", "1.5", "abc"]) {
        const res = run(["arms", dir, "--min", bad], dir);
        expect(res.status, bad).toBe(2);
        expect(res.stderr, bad).toContain("usage");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("text output says 'not compared: 3 of 12 landings' for an arm with 3 landings, and not for a ready arm", () => {
    const dir = tempDir();
    try {
      seed(dir, [[cfgA(), 3]]);
      const res = run(["arms", dir], dir);
      expect(res.status, res.stderr).toBe(0);
      expect(res.stdout).toContain("not compared: 3 of 12 landings");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    const ready = tempDir();
    try {
      seed(ready, [[cfgA(), 2]]);
      const res = run(["arms", ready, "--min", "2"], ready);
      expect(res.status, res.stderr).toBe(0);
      expect(res.stdout).not.toContain("not compared");
    } finally {
      rmSync(ready, { recursive: true, force: true });
    }
  });

  it("with no memory.db it prints 'No outcomes recorded.', exits 0 and creates no database", () => {
    const dir = tempDir();
    try {
      const res = run(["arms", dir], dir);
      expect(res.status, res.stderr).toBe(0);
      expect(res.stdout).toContain("No outcomes recorded.");
      expect(existsSync(join(dir, ".doug", ".state", "memory", "memory.db"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// Card memory-run-coverage: `reflect --hand` writes the by-hand run history (report, briefs, reviews) with the
// redaction and caps the queen path uses, and `outcomes` names a stop row's blocks as gate blocks.
describe("card memory-run-coverage: by-hand run history", () => {
  const secretRules = join(here, "..", "..", "doug-gates", "lib", "secret-rules.mjs");
  // Secret fixture built at runtime so the secret-scan hook does not refuse this file.
  const GH = "gh" + "p_" + "A1b2C3d4".repeat(5);
  const histFile = (dir) => join(dir, ".doug", ".state", "history", "c1", "hand_abc1234.jsonl");
  const hist = (dir) => readFileSync(histFile(dir), "utf8").split("\n").filter((x) => x !== "").map((x) => JSON.parse(x));
  function proj({ brief = "BRIEF-BODY the coder brief", review = "REVIEW-BODY nothing found", vendored = true } = {}) {
    const dir = tempDir();
    const base = join(dir, ".doug", ".state", "reports", "c1");
    mkdirSync(join(base, "briefs"), { recursive: true });
    mkdirSync(join(base, "reviews"), { recursive: true });
    writeFileSync(join(base, "briefs", "1-coder.md"), brief, "utf8");
    writeFileSync(join(base, "reviews", "1.md"), review, "utf8");
    if (vendored) {
      mkdirSync(join(dir, ".doug", "hooks", "lib"), { recursive: true });
      writeFileSync(join(dir, ".doug", "hooks", "lib", "secret-rules.mjs"), readFileSync(secretRules, "utf8"), "utf8");
    }
    return dir;
  }
  const claude = (dir) => writeFakeClaudeSuccess(dir, { structured_output: { lessons: [] }, session_id: "sess-hand", total_cost_usd: 0.01, is_error: false });
  const reflect = (dir, extra = []) => run(["reflect", "--hand", "c1", dir, "--commit", "abc1234", "--claude-bin", claude(dir), ...extra], dir);

  it("reflect --hand writes the by-hand run history with report, brief and review lines", () => {
    const dir = proj();
    try {
      const res = reflect(dir);
      expect(res.status, res.stderr).toBe(0);
      const lines = hist(dir);
      const report = lines.filter((l) => l.kind === "report");
      expect(report).toHaveLength(1);
      expect(report[0].card).toBe("c1");
      expect(report[0].run).toBe("hand:abc1234");
      expect(report[0].source).toBe("hand-report.json");
      expect(report[0].redacted).toBeNull();
      expect(JSON.parse(report[0].text).commit).toBe("abc1234");
      const briefs = lines.filter((l) => l.kind === "brief");
      expect(briefs).toHaveLength(1);
      expect(briefs[0].source).toBe("briefs/1-coder.md");
      expect(briefs[0].seat).toBe("coder");
      expect(briefs[0].round).toBe(1);
      expect(briefs[0].text).toBe("BRIEF-BODY the coder brief");
      const reviews = lines.filter((l) => l.kind === "review");
      expect(reviews).toHaveLength(1);
      expect(reviews[0].source).toBe("reviews/1.md");
      expect(reviews[0].seat).toBe("reviewer");
      expect(reviews[0].round).toBe(1);
      expect(reviews[0].text).toBe("REVIEW-BODY nothing found");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("by-hand history redacts a brief carrying a secret", () => {
    const dir = proj({ brief: `use token ${GH} here` });
    try {
      const res = reflect(dir);
      expect(res.status, res.stderr).toBe(0);
      const lines = hist(dir);
      const brief = lines.find((l) => l.kind === "brief");
      expect(typeof brief.redacted).toBe("string");
      expect(brief.redacted).not.toBe("no-scanner");
      expect(brief.text).toBe(`[redacted: ${brief.redacted}]`);
      const rep = lines.find((l) => l.kind === "report");
      expect(typeof rep.redacted).toBe("string");
      const review = lines.find((l) => l.kind === "review");
      expect(review.redacted).toBeNull();
      expect(review.text).toBe("REVIEW-BODY nothing found");
      expect(readFileSync(histFile(dir), "utf8")).not.toContain(GH);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("by-hand history caps an oversized brief", () => {
    const dir = proj({ brief: "B".repeat(70000) });
    try {
      const res = reflect(dir);
      expect(res.status, res.stderr).toBe(0);
      const brief = hist(dir).find((l) => l.kind === "brief");
      expect(brief.truncated).toBe(true);
      expect(brief.bytes).toBe(70000);
      expect(Buffer.byteLength(brief.text)).toBeLessThanOrEqual(65536);
      expect(brief.text.startsWith("BBBB")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reflect --hand --dry-run writes no run history", () => {
    const dir = proj();
    try {
      const res = reflect(dir, ["--dry-run"]);
      expect(res.status, res.stderr).toBe(0);
      expect(existsSync(histFile(dir))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("card memory-run-coverage: outcomes labels a stop row's blocks", () => {
  const blocks = [
    { at: "T1", hook: "subagent-stop", agent: "doug-flow:coder", class: "real", reason: "red" },
    { at: "T2", hook: "subagent-stop", agent: "doug-flow:coder", class: "real", reason: "red again" },
  ];
  function seed(dir) {
    const m = openMemory(dir);
    try {
      const stop = stopOutcomeRow({ card: "c1", report: { outcome: "stopped", reason: "hook-blocked", detail: "d" }, reportHash: "abcdef0123456789abcd", run: "wf_c1", blocks });
      const flowStop = { ...stopOutcomeRow({ card: "f1", report: { outcome: "stopped", reason: "x", detail: "y" }, reportHash: "1234567890abcdef1234", run: "wf_f1", blocks: [blocks[0]] }), track: "flow" };
      recordOutcomes(m, [stop, flowStop, handOutcomeRow({ card: "c2", commit: "sha22" })]);
    } finally {
      m.close();
    }
  }

  it("outcomes names a stop row's blocks as gate blocks, never as adversary blocks", () => {
    const dir = tempDir();
    try {
      seed(dir);
      const res = run(["outcomes", dir], dir);
      expect(res.status, res.stderr).toBe(0);
      const lines = res.stdout.trim().split("\n");
      const hand = lines.find((l) => l.startsWith("stop:abcdef012345"));
      expect(hand).toContain("gate blocks 2");
      expect(hand).not.toContain("adversary");
      expect(hand).not.toContain("block(s)");
      const flow = lines.find((l) => l.startsWith("stop:1234567890ab"));
      expect(flow).toContain("gate blocks 1");
      expect(flow).not.toContain("adversary");
      expect(flow).not.toContain("block(s)");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("outcomes leaves a landing row's adversary segment alone", () => {
    const dir = tempDir();
    try {
      seed(dir);
      const res = run(["outcomes", dir], dir);
      const landed = res.stdout.trim().split("\n").find((l) => l.startsWith("hand:sha22"));
      expect(landed).toContain("adversary none (null block(s))");
      expect(landed).not.toContain("gate blocks");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("memory.mjs reflect --failures (card memory-failure-lessons)", () => {
  const REF = "history:c1/wf_1:3";
  const seedHistory = (dir) => {
    const J = (o) => JSON.stringify(o);
    const block = (cls) => ({ hook: "stop-gate", at: "2026-10-20T00:00:00.000Z", agent: null, reason: `a ${cls} block reason`, class: cls, session: "s-cli", failures: [{ command: "pnpm test:unit", exit: 1, timedOut: false, tail: "FAIL boom" }] });
    writeRunHistory(dir, {
      card: "c1",
      run: "wf_1",
      scan: () => null,
      entries: [
        { kind: "report", source: "card-report.json", value: J({ outcome: "stopped", reason: "gate", stoppedAt: "coder", detail: "gate stayed red", worktree: "/wt/c1", filesChanged: [] }) },
        { kind: "block", source: "blocks.jsonl", value: J(block("race")) },
        { kind: "block", source: "blocks.jsonl", value: J(block("real")) },
      ],
    });
  };
  // A fake claude that records its argv and stdin, then answers with the envelope.
  const fakeCapturing = (dir, lessons, argsFile, promptFile) => {
    const scriptPath = join(dir, "fake-claude-failures.mjs");
    writeFileSync(
      scriptPath,
      "#!/usr/bin/env node\n" +
        'import { readFileSync, writeFileSync } from "node:fs";\n' +
        `writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(process.argv.slice(2)));\n` +
        `writeFileSync(${JSON.stringify(promptFile)}, readFileSync(0, "utf8"));\n` +
        `process.stdout.write(${JSON.stringify(JSON.stringify({ structured_output: { lessons }, session_id: "sess-f", total_cost_usd: 0.01, is_error: false }))});\n`,
      "utf8"
    );
    chmodSync(scriptPath, 0o755);
    return scriptPath;
  };
  const prop = (over = {}) => ({ kind: "pitfall", text: "Never leave the gate red when the coder stops because the stop hook then blocks every later turn", citation: REF, notDerivableBecause: "only visible in this stopped run", ...over });
  const lessonRows = (dir) => JSON.parse(run(["lessons", dir, "--json"], dir).stdout);

  it("the fake claude-bin receives FAILURE_REFLECT_SCHEMA in --json-schema and the appended pitfall cites a history ref", () => {
    const dir = tempDir();
    try {
      seedHistory(dir);
      const argsFile = join(dir, "args.json");
      const promptFile = join(dir, "prompt.txt");
      const claudeBin = fakeCapturing(dir, [prop()], argsFile, promptFile);
      const res = run(["reflect", "--failures", "c1", dir, "--claude-bin", claudeBin, "--session", "s-opt"], dir);
      expect(res.status, res.stderr).toBe(0);
      const args = JSON.parse(readFileSync(argsFile, "utf8"));
      expect(JSON.parse(args[args.indexOf("--json-schema") + 1])).toEqual(FAILURE_REFLECT_SCHEMA);
      expect(readFileSync(promptFile, "utf8")).toContain(REF);
      const rows = lessonRows(dir);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ kind: "pitfall", citation: REF, card: "c1", source_agent: "reflect" });
      expect(readPitfallOccurrences(dir)).toHaveLength(1);
      expect(readPitfallOccurrences(dir)[0]).toMatchObject({ lesson: rows[0].id, citation: REF, card: "c1", run: "wf_1", session: "s-cli" });
      expect(res.stdout).toMatch(/race/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("with --dry-run prints the would-append line and leaves the lessons table and pitfalls.jsonl unchanged", () => {
    const dir = tempDir();
    try {
      seedHistory(dir);
      const claudeBin = fakeCapturing(dir, [prop()], join(dir, "a.json"), join(dir, "p.txt"));
      const res = run(["reflect", "--failures", "c1", dir, "--claude-bin", claudeBin, "--dry-run"], dir);
      expect(res.status, res.stderr).toBe(0);
      expect(res.stdout).toContain("(dry run)");
      expect(lessonRows(dir)).toHaveLength(0);
      expect(existsSync(join(dir, PITFALL_LEDGER_RELPATH))).toBe(false);
      const real = run(["reflect", "--failures", "c1", dir, "--claude-bin", claudeBin], dir);
      expect(real.status, real.stderr).toBe(0);
      expect(real.stdout).not.toContain("Already reflected");
      expect(lessonRows(dir)).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("card memory-dry-run-no-model-call: --dry-run never spawns the claude bin, prints the prompt that would be sent and what it would write, and writes nothing", () => {
    const dir = tempDir();
    try {
      seedHistory(dir);
      const { bin, marker } = writeFakeClaudeMustNotRun(dir);
      const res = run(["reflect", "--failures", "c1", dir, "--claude-bin", bin, "--dry-run"], dir);
      expect(res.status, res.stderr).toBe(0);
      expect(existsSync(marker)).toBe(false);
      expect(res.stdout).toContain("(dry run)");
      expect(res.stdout).toContain("reading the FAILURES of one card");
      expect(res.stdout).toContain(REF);
      expect(res.stdout).toMatch(/would (write|append)/i);
      expect(lessonRows(dir)).toHaveLength(0);
      expect(existsSync(join(dir, PITFALL_LEDGER_RELPATH))).toBe(false);
      // no reflections row was written: a real run right after is not a no-op.
      const okBin = fakeCapturing(dir, [prop()], join(dir, "a.json"), join(dir, "p.txt"));
      const real = run(["reflect", "--failures", "c1", dir, "--claude-bin", okBin], dir);
      expect(real.status, real.stderr).toBe(0);
      expect(real.stdout).not.toContain("Already reflected");
      expect(lessonRows(dir)).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a second run on the same history is a no-op", () => {
    const dir = tempDir();
    try {
      seedHistory(dir);
      const claudeBin = fakeCapturing(dir, [prop()], join(dir, "a.json"), join(dir, "p.txt"));
      expect(run(["reflect", "--failures", "c1", dir, "--claude-bin", claudeBin], dir).status).toBe(0);
      const second = run(["reflect", "--failures", "c1", dir, "--claude-bin", claudeBin], dir);
      expect(second.status, second.stderr).toBe(0);
      expect(second.stdout).toContain("Already reflected");
      expect(lessonRows(dir)).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a card with no failure items exits 0 without ever spawning claude", () => {
    const dir = tempDir();
    try {
      const res = run(["reflect", "--failures", "quiet", dir, "--claude-bin", join(dir, "no-such-claude")], dir);
      expect(res.status, res.stderr).toBe(0);
      expect(lessonRows(dir)).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is exclusive with a report path: exit 2 and nothing created", () => {
    const dir = tempDir();
    try {
      const report = join(dir, "report.json");
      writeFileSync(report, "{}");
      const res = run(["reflect", "--failures", "c1", report], dir);
      expect(res.status).toBe(2);
      const missing = join(dir, "nope", "report.json");
      expect(run(["reflect", "--failures", "c1", missing], dir).status).toBe(2);
      expect(existsSync(join(dir, "nope"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is exclusive with --hand: exit 2", () => {
    const dir = tempDir();
    try {
      const res = run(["reflect", "--failures", "c1", "--hand", "c1", dir], dir);
      expect(res.status).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("memory.mjs reflect: supersedes and repeats (card memory-reflect-supersede)", () => {
  const proposal = (extra) => ({
    kind: "pitfall",
    text: "The adversary needs owned files listed exactly or retriable checks fail silently",
    citation: "report:agents-generator/F1",
    task: "agents-generator",
    notDerivableBecause: "not written anywhere in the repo today",
    ...extra,
  });
  const envelope = (lessons) => ({ structured_output: { lessons }, session_id: "sess-sup", total_cost_usd: 0.01, is_error: false });
  const seedLesson = (dir, text) => {
    const m = openMemory(dir);
    const row = addLesson(m, { text, kind: "pattern", citation: "report:agents-generator", source: { agent: "worker" } });
    m.close();
    return row;
  };
  const args = (dir, claudeBin, extra = []) => ["reflect", fixtureReport, dir, "--adversary", "F1=real: confirmed by fix", "--claude-bin", claudeBin, ...extra];

  it("M14: an unknown supersedes id prints a `  note:` line naming the id (exit 0), and --json carries notes and superseded arrays", () => {
    const dir = tempDir();
    try {
      const claudeBin = writeFakeClaudeSuccess(dir, envelope([proposal({ supersedes: "ffffffffffffffff" })]));
      // a real run in its own project dir (a --dry-run makes no model call, so it has no proposal to note).
      const textDir = tempDir();
      try {
        const res = run(args(textDir, claudeBin), textDir);
        expect(res.status, res.stderr).toBe(0);
        const noteLine = res.stdout.split("\n").find((l) => l.startsWith("  note:"));
        expect(noteLine).toBeDefined();
        expect(noteLine).toContain("ffffffffffffffff");
      } finally {
        rmSync(textDir, { recursive: true, force: true });
      }

      const json = run(args(dir, claudeBin, ["--json"]), dir);
      expect(json.status, json.stderr).toBe(0);
      const out = JSON.parse(json.stdout);
      expect(Array.isArray(out.notes)).toBe(true);
      expect(out.notes).toHaveLength(1);
      expect(out.notes[0]).toContain("ffffffffffffffff");
      expect(out.superseded).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a valid supersedes through the CLI supersedes the old lesson, prints `superseded 1 (old->new)` in the summary, and --json lists the pair", () => {
    const dir = tempDir();
    try {
      const old = seedLesson(dir, "Recall in this repo is keyword only because the embedding server returns three hundred eighty four dimensions");
      const claudeBin = writeFakeClaudeSuccess(dir, envelope([proposal({ supersedes: old.id })]));
      const res = run(args(dir, claudeBin), dir);
      expect(res.status, res.stderr).toBe(0);
      expect(res.stdout).toMatch(/superseded 1/);
      expect(res.stdout).toContain(old.id);
      const m = openMemory(dir);
      try {
        const row = getLesson(m, old.id);
        expect(row.superseded_by).toEqual(expect.any(String));
        expect(getLesson(m, row.superseded_by).source_agent).toBe("reflect");
      } finally {
        m.close();
      }
      // a second reflect of a different report is not available; pin --json on a fresh store instead.
      const dir2 = tempDir();
      try {
        const old2 = seedLesson(dir2, "Recall in this repo is keyword only because the embedding server returns three hundred eighty four dimensions");
        const bin2 = writeFakeClaudeSuccess(dir2, envelope([proposal({ supersedes: old2.id })]));
        const json = JSON.parse(run(args(dir2, bin2, ["--json"]), dir2).stdout);
        expect(json.superseded).toHaveLength(1);
        expect(json.superseded[0].old).toBe(old2.id);
        expect(json.superseded[0].new).toBe(json.appended[0]);
        expect(json.notes).toEqual([]);
      } finally {
        rmSync(dir2, { recursive: true, force: true });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// Card memory-project-model (ADR 0019 L2): `memory.mjs model regen [dir] [--claude-bin] [--model] [--max-usd] [--dry-run] [--json]`
// and `memory.mjs model show [dir]`, end to end against a fake claude-bin. Never a real model call.
describe("memory.mjs model regen / model show (card memory-project-model)", () => {
  const MODEL_REL = join(".doug", "project-model.md");
  const modelFile = (dir) => join(dir, MODEL_REL);
  const GHOST = "0123456789abcdef";
  const stmt = (section, text, citations) => ({ section, text, citations });

  function seed(dir) {
    const m = openMemory(dir);
    try {
      const a = addLesson(m, { text: "Orphaned vitest workers hang the stop gate until the group is killed", kind: "pitfall", citation: "a.md", source: { agent: "t" } });
      const b = addLesson(m, { text: "Seed mutation fixtures from a real record so they bite", kind: "pattern", citation: "b.md", source: { agent: "t" } });
      const old = addLesson(m, { text: "Superseded advice about the old gate runner", kind: "pattern", citation: "old.md", source: { agent: "t" } });
      const fresh = addLesson(m, { text: "Current advice about the gate runner", kind: "pattern", citation: "fresh.md", source: { agent: "t" } });
      supersedeLesson(m, old.id, fresh.id);
      writeRunHistory(dir, {
        card: "c1",
        run: "wf_1",
        scan: () => null,
        entries: [1, 2, 3].map((n) => ({ kind: "hand-back", seat: "lead", round: n, source: "journal.jsonl", value: `entry ${n}` })),
      });
      return { a, b, old, fresh };
    } finally {
      m.close();
    }
  }

  // A fake claude that records argv and stdin, then prints the envelope.
  function fakeModelClaude(dir, envelope, { argsFile = join(dir, "args.json"), promptFile = join(dir, "prompt.txt"), marker = join(dir, "called.txt") } = {}) {
    const scriptPath = join(dir, "fake-claude-model.mjs");
    writeFileSync(
      scriptPath,
      "#!/usr/bin/env node\n" +
        'import { readFileSync, writeFileSync } from "node:fs";\n' +
        `writeFileSync(${JSON.stringify(marker)}, "called");\n` +
        `writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(process.argv.slice(2)));\n` +
        `writeFileSync(${JSON.stringify(promptFile)}, readFileSync(0, "utf8"));\n` +
        `process.stdout.write(${JSON.stringify(JSON.stringify(envelope))});\n`,
      "utf8"
    );
    chmodSync(scriptPath, 0o755);
    return scriptPath;
  }
  const envelope = (statements, extra = {}) => ({ structured_output: { statements }, session_id: "sess-model", total_cost_usd: 0.0123, is_error: false, ...extra });
  const regen = (dir, bin, extra = []) => run(["model", "regen", dir, "--claude-bin", bin, ...extra], dir);
  const tree = (dir, rel = "") =>
    readdirSync(join(dir, rel), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? tree(dir, join(rel, e.name)) : [join(rel, e.name)])).sort();

  function goodAndBad(ids) {
    return [
      stmt("conventions", "Seed mutation fixtures from a real record", [ids.b.id]),
      stmt("failure-patterns", "Orphaned vitest workers hang the gate", ["history:c1/wf_1:2", ids.a.id]),
      stmt("open-risks", "Cites an id that is not in the store", [GHOST]),
      stmt("failure-patterns", "One good citation and one bad one", [ids.a.id, "c1/wf_9"]),
    ];
  }

  it("spawns claude with the schema, the cheap-tier default model, the 0.5 budget and the prompt on stdin; writes the file and prints the one-line summary", () => {
    const dir = tempDir();
    try {
      const ids = seed(dir);
      const claudeBin = fakeModelClaude(dir, envelope(goodAndBad(ids)));
      const res = regen(dir, claudeBin);
      expect(res.status, res.stderr).toBe(0);
      const args = JSON.parse(readFileSync(join(dir, "args.json"), "utf8"));
      expect(args).toContain("-p");
      expect(JSON.parse(args[args.indexOf("--json-schema") + 1])).toEqual(PROJECT_MODEL_SCHEMA);
      expect(args[args.indexOf("--model") + 1]).toBe("haiku");
      expect(args[args.indexOf("--max-budget-usd") + 1]).toBe("0.5");
      const prompt = readFileSync(join(dir, "prompt.txt"), "utf8");
      expect(prompt).toContain(ids.a.id);
      expect(prompt).toContain(ids.b.id);
      expect(prompt).toContain(ids.fresh.id);
      expect(prompt).not.toContain(ids.old.id); // a superseded lesson is not an input
      expect(prompt).toContain("c1/wf_1");

      const text = readFileSync(modelFile(dir), "utf8");
      expect(text.startsWith("# Project model\n")).toBe(true);
      expect(text).toMatch(/Generated by `memory\.mjs model regen` on \d{4}-\d{2}-\d{2}; do not edit by hand\./);
      expect(text).toContain("- Orphaned vitest workers hang the gate [history:c1/wf_1:2, " + ids.a.id + "]");
      expect(text).toContain("- Seed mutation fixtures from a real record [" + ids.b.id + "]");
      expect(text.indexOf("## Failure patterns")).toBeLessThan(text.indexOf("## Conventions"));
      expect(text).not.toContain("## Open risks");
      expect(text).not.toContain("not in the store");
      expect(text).not.toContain("One good citation");
      expect(res.stdout.trim()).toBe(
        `Wrote .doug/project-model.md: 2 statements, ${text.length} characters (cap 2000); dropped 2 unresolved, 0 over cap; $0.0123 (claude)`
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("M5: --json prints { path, statements, chars, cap, unresolved, overCap, dropped, usd, usdSource, dryRun } with the dropped statements named", () => {
    const dir = tempDir();
    try {
      const ids = seed(dir);
      const res = regen(dir, fakeModelClaude(dir, envelope(goodAndBad(ids))), ["--json"]);
      expect(res.status, res.stderr).toBe(0);
      const j = JSON.parse(res.stdout);
      expect(Object.keys(j).sort()).toEqual(["cap", "chars", "dropped", "dryRun", "overCap", "path", "statements", "unresolved", "usd", "usdSource"]);
      expect(j.path.endsWith(".doug/project-model.md")).toBe(true);
      expect(j).toMatchObject({ statements: 2, cap: 2000, unresolved: 2, overCap: 0, usd: 0.0123, usdSource: "claude", dryRun: false });
      expect(j.chars).toBe(readFileSync(modelFile(dir), "utf8").length);
      expect(j.dropped).toEqual([
        { text: "Cites an id that is not in the store", reason: "unresolved", citations: [GHOST] },
        { text: "One good citation and one bad one", reason: "unresolved", citations: [ids.a.id, "c1/wf_9"] },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("card memory-dry-run-no-model-call: --dry-run never spawns the claude bin, writes no file, prints the prompt and a `Would write` line; --json carries prompt, usd 0 and dryRun true", () => {
    const dir = tempDir();
    try {
      const ids = seed(dir);
      const { bin, marker } = writeFakeClaudeMustNotRun(dir);
      const res = regen(dir, bin, ["--dry-run"]);
      expect(res.status, res.stderr).toBe(0);
      expect(existsSync(marker)).toBe(false);
      expect(existsSync(modelFile(dir))).toBe(false);
      expect(res.stdout).toContain("You write the project model of a coding harness");
      expect(res.stdout).toContain(ids.b.id);
      expect(res.stdout).toMatch(/Would write \.doug\/project-model\.md/);
      expect(res.stdout).not.toContain("Wrote ");
      const jr = regen(dir, bin, ["--dry-run", "--json"]);
      expect(jr.status, jr.stderr).toBe(0);
      expect(existsSync(marker)).toBe(false);
      const j = JSON.parse(jr.stdout);
      expect(j.dryRun).toBe(true);
      expect(j.usd).toBe(0);
      expect(j.prompt).toContain("You write the project model of a coding harness");
      expect(j.prompt).toContain(ids.b.id);
      expect(existsSync(modelFile(dir))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("M6/M8: over the cap the file is at most 2000 characters and the line and --json count the statements left out", () => {
    const dir = tempDir();
    try {
      const ids = seed(dir);
      // 19 statements with a 78-character text each: about 2130 characters with the header, so some must go.
      const many = Array.from({ length: 19 }, (_, i) => stmt("failure-patterns", `S${String(i + 1).padStart(2, "0")} `.padEnd(78, "x"), [ids.a.id]));
      const claudeBin = fakeModelClaude(dir, envelope(many));
      const res = regen(dir, claudeBin, ["--json"]);
      expect(res.status, res.stderr).toBe(0);
      const j = JSON.parse(res.stdout);
      const text = readFileSync(modelFile(dir), "utf8");
      expect(text.length).toBeLessThanOrEqual(2000);
      expect(j.chars).toBe(text.length);
      expect(j.overCap).toBeGreaterThanOrEqual(1);
      expect(j.statements + j.overCap).toBe(19);
      expect(j.unresolved).toBe(0);
      expect(text.split("\n").filter((l) => l.startsWith("- "))).toHaveLength(j.statements);
      const line = regen(dir, claudeBin).stdout.trim();
      expect(line).toContain(`dropped 0 unresolved, ${j.overCap} over cap`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--model, --max-usd and --claude-bin are passed through; DOUG_CLAUDE_BIN is used without --claude-bin", () => {
    const dir = tempDir();
    try {
      const ids = seed(dir);
      const claudeBin = fakeModelClaude(dir, envelope(goodAndBad(ids)));
      const res = regen(dir, claudeBin, ["--model", "sonnet", "--max-usd", "1.25"]);
      expect(res.status, res.stderr).toBe(0);
      const args = JSON.parse(readFileSync(join(dir, "args.json"), "utf8"));
      expect(args[args.indexOf("--model") + 1]).toBe("sonnet");
      expect(args[args.indexOf("--max-budget-usd") + 1]).toBe("1.25");
      rmSync(join(dir, "args.json"));
      const viaEnv = spawnSync(process.execPath, [script, "model", "regen", dir], { cwd: dir, encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: "", DOUG_CLAUDE_BIN: claudeBin } });
      expect(viaEnv.status, viaEnv.stderr).toBe(0);
      expect(existsSync(join(dir, "args.json"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the default model is the CLAUDE.md Models table's cheap tier", () => {
    const dir = tempDir();
    try {
      const ids = seed(dir);
      writeFileSync(join(dir, "CLAUDE.md"), "# P\n\n## Models\n\n| Work | Model | Effort |\n|---|---|---|\n| cheap | sonnet | low |\n", "utf8");
      const res = regen(dir, fakeModelClaude(dir, envelope(goodAndBad(ids))));
      expect(res.status, res.stderr).toBe(0);
      const args = JSON.parse(readFileSync(join(dir, "args.json"), "utf8"));
      expect(args[args.indexOf("--model") + 1]).toBe("sonnet");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--max-usd must be a positive number: 0, a negative, and text exit 2 with no model call and no file", () => {
    const dir = tempDir();
    try {
      const ids = seed(dir);
      const claudeBin = fakeModelClaude(dir, envelope(goodAndBad(ids)));
      for (const bad of ["0", "-1", "abc"]) {
        const res = regen(dir, claudeBin, ["--max-usd", bad]);
        expect(res.status, bad).toBe(2);
        expect(res.stderr, bad).toContain("--max-usd");
      }
      expect(existsSync(join(dir, "called.txt"))).toBe(false);
      expect(existsSync(modelFile(dir))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("with no store it prints one stderr line, exits 1, makes no model call and writes nothing", () => {
    const dir = tempDir();
    try {
      const claudeBin = fakeModelClaude(dir, envelope([stmt("conventions", "x", [GHOST])]));
      const res = regen(dir, claudeBin);
      expect(res.status).toBe(1);
      expect(res.stderr.trim().split("\n")).toHaveLength(1);
      expect(res.stderr.trim()).not.toBe("");
      expect(existsSync(join(dir, "called.txt"))).toBe(false);
      expect(existsSync(join(dir, ".doug", ".state"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("M10: a failed model call (garbage output, is_error, a missing statements array, a nonzero exit) exits 1 with one stderr line and leaves the existing file untouched", () => {
    const dir = tempDir();
    try {
      const ids = seed(dir);
      mkdirSync(join(dir, ".doug"), { recursive: true });
      const OLD = "# Project model\n\nOLD CONTENT kept as is\n";
      writeFileSync(modelFile(dir), OLD, "utf8");
      const failing = join(dir, "fake-claude-exit.mjs");
      writeFileSync(failing, "#!/usr/bin/env node\nprocess.stderr.write('boom\\n');process.exit(7);\n", "utf8");
      chmodSync(failing, 0o755);
      const bins = {
        garbage: writeFakeClaudeGarbage(dir),
        isError: fakeModelClaude(dir, envelope([], { is_error: true, result: "budget exceeded" })),
        noArray: fakeModelClaude(dir, { structured_output: {}, session_id: "s", total_cost_usd: 0.01, is_error: false }),
        exit7: failing,
        missingBin: join(dir, "no-such-claude"),
      };
      for (const [name, bin] of Object.entries(bins)) {
        const res = regen(dir, bin);
        expect(res.status, name).toBe(1);
        expect(res.stderr.trim().split("\n"), name).toHaveLength(1);
        expect(readFileSync(modelFile(dir), "utf8"), name).toBe(OLD);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("zero surviving statements exits 1, leaves the existing file untouched, and says nothing was written with the drop counts", () => {
    const dir = tempDir();
    try {
      const ids = seed(dir);
      mkdirSync(join(dir, ".doug"), { recursive: true });
      const OLD = "# Project model\n\nOLD CONTENT kept as is\n";
      writeFileSync(modelFile(dir), OLD, "utf8");
      const allBad = envelope([stmt("conventions", "ghost", [GHOST]), stmt("open-risks", "half", [ids.a.id, "c1/wf_9"])]);
      const res = regen(dir, fakeModelClaude(dir, allBad));
      expect(res.status).toBe(1);
      expect(res.stdout + res.stderr).toMatch(/nothing was written/i);
      expect(res.stdout + res.stderr).toContain("2 unresolved");
      expect(readFileSync(modelFile(dir), "utf8")).toBe(OLD);
      const empty = regen(dir, fakeModelClaude(dir, envelope([])));
      expect(empty.status).toBe(1);
      expect(readFileSync(modelFile(dir), "utf8")).toBe(OLD);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("regen overwrites an existing file", () => {
    const dir = tempDir();
    try {
      const ids = seed(dir);
      mkdirSync(join(dir, ".doug"), { recursive: true });
      writeFileSync(modelFile(dir), "stale\n", "utf8");
      const res = regen(dir, fakeModelClaude(dir, envelope(goodAndBad(ids))));
      expect(res.status, res.stderr).toBe(0);
      expect(readFileSync(modelFile(dir), "utf8")).toContain("# Project model");
      expect(readFileSync(modelFile(dir), "utf8")).not.toContain("stale");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("M9: model show prints the file verbatim and creates nothing", () => {
    const dir = tempDir();
    try {
      mkdirSync(join(dir, ".doug"), { recursive: true });
      const content = "# Project model\n\n## Conventions\n- keep  double  spaces and a trailing space \n- last line [aaaaaaaaaaaaaaaa]\n";
      writeFileSync(modelFile(dir), content, "utf8");
      const before = tree(dir);
      const res = run(["model", "show", dir], dir);
      expect(res.status, res.stderr).toBe(0);
      expect(res.stdout).toBe(content);
      expect(tree(dir)).toEqual(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("M9: model show with no file prints one stderr line, exits 1 and creates nothing", () => {
    const dir = tempDir();
    try {
      const res = run(["model", "show", dir], dir);
      expect(res.status).toBe(1);
      expect(res.stdout).toBe("");
      expect(res.stderr.trim().split("\n")).toHaveLength(1);
      expect(res.stderr.trim()).not.toBe("");
      expect(existsSync(join(dir, ".doug", ".state"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("model with no subcommand or an unknown one prints usage naming both subcommands and exits 2", () => {
    const dir = tempDir();
    try {
      for (const argv of [["model"], ["model", "frobnicate"], ["model", "regen-all", dir]]) {
        const res = run([...argv], dir);
        expect(res.status, argv.join(" ")).toBe(2);
        expect(res.stderr, argv.join(" ")).toMatch(/usage/i);
        expect(res.stderr).toContain("model regen");
        expect(res.stderr).toContain("model show");
      }
      expect(existsSync(join(dir, ".doug", ".state"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the usage header of scripts/memory.mjs and docs/memory.md document both subcommands", () => {
    const lines = readFileSync(script, "utf8").split("\n").slice(1);
    const header = lines.slice(0, lines.findIndex((l) => !l.startsWith("//"))).join("\n"); // the top comment block only
    expect(header).toContain("memory.mjs model regen");
    expect(header).toContain("memory.mjs model show");
    expect(header).toContain("--max-usd");
    const doc = readFileSync(join(here, "..", "..", "..", "docs", "memory.md"), "utf8");
    expect(doc).toContain("## memory.mjs model regen / model show");
    expect(doc).toContain(".doug/project-model.md");
  });
});

// card memory-archived-readers: every live-lesson reader skips an archived lesson; lesson unarchive restores one.
describe("memory.mjs archived readers and lesson unarchive (card memory-archived-readers)", () => {
  const EMBED = (server) => ({ provider: "openai-compatible", baseUrl: serverBaseUrl(server), model: "embeddinggemma", dims: 4 });
  const vec = (dims = 4) => Float32Array.from(Array.from({ length: dims }, (_, j) => (j === 0 ? 1 : 0)));
  const seed = (dir, rows) => {
    const m = openMemory(dir);
    const ids = rows.map(({ text, vectored = false, archived = false }) => {
      const row = addLesson(m, { text, kind: "pattern", source: { agent: "worker" } });
      if (vectored) setLessonEmbedding(m, row.id, { model: "embeddinggemma", dims: 4, vector: vec() });
      if (archived) m.prepare("UPDATE lessons SET archived = ?, archived_reason = ? WHERE id = ?").run("2026-09-29T00:00:00.000Z", "harmful 2, helpful 0", row.id);
      return row.id;
    });
    m.close();
    return ids;
  };

  it("M2: an archived lesson embedded under the configured pair does not count as matching, so lesson add reports the pair as new", async () => {
    const dir = tempDir();
    const server = await startFakeOllama();
    try {
      seed(dir, [
        { text: "archived but vectored", vectored: true, archived: true },
        { text: "live unvectored" },
      ]);
      writeMemoryConfig(dir, EMBED(server));
      const res = await runAsync(["lesson", "add", "--text", "brand new lesson", "--kind", "pattern", dir, "--json"], dir);
      expect(res.status, res.stderr).toBe(0);
      expect(res.stderr).toMatch(/embeddinggemma\/4 is new to this store/);
      expect(JSON.parse(res.stdout).embedding_model).toBeNull();
    } finally {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("M3: reembed's still-unvectored warning counts only live lessons", async () => {
    const dir = tempDir();
    const server = await startFakeOllama({}, { failOn: "poison" });
    try {
      seed(dir, [{ text: "lesson one" }, { text: "lesson two" }, { text: "lesson poison" }, { text: "archived lesson", archived: true }]);
      writeMemoryConfig(dir, EMBED(server));
      const res = await runAsync(["reembed", dir, "--batch", "1", "--no-check"], dir);
      expect(res.status, res.stderr).toBe(0);
      const lines = stderrLines(res).filter(Boolean);
      expect(lines[lines.length - 1]).toBe("WARNING: 1 of 3 lessons still have no vector for embeddinggemma/4; retry with memory.mjs reembed --batch 4");
    } finally {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("M7: lesson unarchive restores an archived lesson to recall; exit 0, row and text unchanged", () => {
    const dir = tempDir();
    try {
      const [id] = seed(dir, [{ text: "quokka migration notes" }]);
      const m = openMemory(dir);
      m.prepare("UPDATE lessons SET archived = ?, archived_reason = ?, harmful = 2 WHERE id = ?").run("2026-09-29T00:00:00.000Z", "harmful 2", id);
      m.close();
      expect(run(["recall", "quokka migration", dir], dir).stdout).not.toContain(id);
      const res = run(["lesson", "unarchive", id, dir], dir);
      expect(res.status, res.stderr).toBe(0);
      expect(run(["recall", "quokka migration", dir], dir).stdout).toContain(id);
      const m2 = openMemory(dir);
      const row = getLesson(m2, id);
      m2.close();
      expect(row.archived).toBeNull();
      expect(row.archived_reason).toBeNull();
      expect(row.text).toBe("quokka migration notes");
      expect(row.harmful).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("M8: lesson unarchive of a live lesson exits 1 with a message naming the id", () => {
    const dir = tempDir();
    try {
      const [id] = seed(dir, [{ text: "a live lesson" }]);
      const res = run(["lesson", "unarchive", id, dir], dir);
      expect(res.status).toBe(1);
      expect(res.stderr).toContain(id);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("M9: lesson unarchive of an unknown id exits 1 with a message naming the id", () => {
    const dir = tempDir();
    try {
      seed(dir, [{ text: "some lesson" }]);
      const res = run(["lesson", "unarchive", "does-not-exist", dir], dir);
      expect(res.status).toBe(1);
      expect(res.stderr).toContain("does-not-exist");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// Card memory-hand-stop-rows: a stopped by-hand run records exactly one stop row via `record <id> --hand --stop`.
describe("memory.mjs record --hand --stop", () => {
  const stopRows = (dir) => JSON.parse(run(["outcomes", dir, "--json"], dir).stdout);

  it("record <id> --hand --stop <reason> --detail <text> records one hand stop row (run stop:<12 hex>, track hand, commit null, stop_class/stop_reason)", () => {
    const dir = tempDir();
    const res = run(["record", "stopped-card", "--hand", "--stop", "gate-red", dir, "--detail", "typecheck failed twice"], dir);
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toContain("Recorded a hand-track stop for stopped-card");
    const rows = stopRows(dir);
    expect(rows).toHaveLength(1);
    expect(rows[0].track).toBe("hand");
    expect(rows[0].card).toBe("stopped-card");
    expect(rows[0].task).toBe("stopped-card");
    expect(rows[0].run).toMatch(/^stop:[0-9a-f]{12}$/);
    expect(rows[0].commit_sha).toBeNull();
    expect(rows[0].stop_class).toBe("gate-red");
    expect(rows[0].stop_reason).toBe("typecheck failed twice");
    rmSync(dir, { recursive: true, force: true });
  });

  it("stop_reason falls back to the reason when --detail is absent or blank", () => {
    const dir = tempDir();
    expect(run(["record", "c1", "--hand", "--stop", "hook-blocked", dir], dir).status).toBe(0);
    expect(run(["record", "c2", "--hand", "--stop", "hook-blocked", dir, "--detail", "   "], dir).status).toBe(0);
    for (const r of stopRows(dir)) expect(r.stop_reason).toBe("hook-blocked");
    rmSync(dir, { recursive: true, force: true });
  });

  it("recording the same by-hand stop twice leaves exactly one stop row (second run: 0 new, 1 updated), and a different reason adds a row", () => {
    const dir = tempDir();
    const args = ["record", "stopped-card", "--hand", "--stop", "gate-red", dir, "--detail", "d", "--json"];
    const first = run(args, dir);
    expect(first.status, first.stderr).toBe(0);
    expect(JSON.parse(first.stdout)).toMatchObject({ card: "stopped-card", inserted: 1, updated: 0 });
    // Let the clock move so a time-dependent identity would differ.
    const t = Date.now();
    while (Date.now() - t < 1100) { /* wait */ }
    const second = run(args, dir);
    expect(second.status, second.stderr).toBe(0);
    expect(JSON.parse(second.stdout)).toMatchObject({ inserted: 0, updated: 1 });
    expect(stopRows(dir)).toHaveLength(1);
    expect(JSON.parse(first.stdout).run).toBe(JSON.parse(second.stdout).run);
    expect(run(["record", "stopped-card", "--hand", "--stop", "other", dir, "--detail", "d"], dir).status).toBe(0);
    expect(stopRows(dir)).toHaveLength(2);
    rmSync(dir, { recursive: true, force: true });
  });

  it("two stops of one card with the same reason and detail but different condition openedAt record two rows", () => {
    const dir = tempDir();
    const file = join(dir, ".doug/.state/reports/open-card/condition.json");
    mkdirSync(join(dir, ".doug/.state/reports/open-card"), { recursive: true });
    const args = ["record", "open-card", "--hand", "--stop", "gate-red", dir, "--detail", "d", "--json"];
    writeFileSync(file, JSON.stringify({ openedAt: "2026-10-01T00:00:00.000Z" }), "utf8");
    const first = run(args, dir);
    expect(first.status, first.stderr).toBe(0);
    writeFileSync(file, JSON.stringify({ openedAt: "2026-10-02T00:00:00.000Z" }), "utf8");
    const second = run(args, dir);
    expect(second.status, second.stderr).toBe(0);
    expect(JSON.parse(second.stdout)).toMatchObject({ inserted: 1, updated: 0 });
    expect(JSON.parse(first.stdout).run).not.toBe(JSON.parse(second.stdout).run);
    expect(stopRows(dir)).toHaveLength(2);
    rmSync(dir, { recursive: true, force: true });
  });

  it("with condition.json the by-hand stop row copies its memory_config (hand stamp, sorted-key JSON) and harness_commit; arms counts it in the hand arm with stops 1, unstamped 0", () => {
    const dir = gitRepoDir();
    writeConditionBoard(dir);
    expect(run(["condition", "open", "classed-card", dir], dir).status).toBe(0);
    const condition = JSON.parse(readFileSync(join(dir, ".doug/.state/reports/classed-card/condition.json"), "utf8"));
    const res = run(["record", "classed-card", "--hand", "--stop", "gate-red", dir, "--detail", "x"], dir);
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).not.toMatch(/unstamped/);
    const [row] = stopRows(dir);
    expect(row.harness_commit).toBe(condition.harnessCommit);
    expect(row.config_hash).toBe(condition.configHash);
    expect(row.memory_config).not.toBeNull();
    const cfg = JSON.parse(row.memory_config);
    expect(cfg).toEqual(condition.memoryConfig);
    expect(cfg.fetch).toBeUndefined();
    expect(Object.keys(cfg)).toEqual([...Object.keys(cfg)].sort());
    const arms = JSON.parse(run(["arms", dir, "--json"], dir).stdout);
    expect(arms.unstamped).toBe(0);
    expect(arms.arms).toHaveLength(1);
    expect(arms.arms[0].stops).toBe(1);
    expect(arms.arms[0].landings).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });

  it("without condition.json it still records (exit 0), prints an unstamped line, and --json reports stamped false", () => {
    const dir = tempDir();
    const res = run(["record", "nc", "--hand", "--stop", "gate-red", dir], dir);
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toMatch(/unstamped/);
    expect(stopRows(dir)[0].memory_config).toBeNull();
    const j = run(["record", "nc2", "--hand", "--stop", "gate-red", dir, "--json"], dir);
    expect(JSON.parse(j.stdout).stamped).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it("usage errors exit 2 and write nothing: --stop with no value, --stop with --commit, a report path as the id", () => {
    const dir = tempDir();
    expect(run(["record", "c", "--hand", dir, "--stop"], dir).status).toBe(2);
    expect(run(["record", "c", "--hand", "--stop", "gate-red", dir, "--commit", "abc1234"], dir).status).toBe(2);
    expect(run(["record", fixtureReport, "--hand", "--stop", "gate-red", dir], dir).status).toBe(2);
    expect(existsSync(join(dir, ".doug/.state/memory"))).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it("--hand with neither --stop nor --commit keeps the usage error", () => {
    const dir = tempDir();
    expect(run(["record", "c", "--hand", dir], dir).status).toBe(2);
    rmSync(dir, { recursive: true, force: true });
  });

  it("the usage header and docs/memory.md name the --stop form", () => {
    const src = readFileSync(script, "utf8");
    expect(src).toContain("--hand --stop");
    expect(readFileSync(join(here, "..", "..", "..", "docs", "memory.md"), "utf8")).toContain("--hand --stop");
  });
});

// Card detach-background-chores: `reflect --detach` starts the same reflect as a detached job and returns; `job <name>`
// reads it later (done -> reflect's one-line summary, running -> pending, failed -> exit 1). Fake claude blocks on a
// release marker the test writes, never on a sleep.
describe("memory.mjs reflect --detach and job", () => {
  const reportsDir = (dir) => join(dir, ".doug", ".state", "reports", "c1");
  const jobsDir = (dir) => join(dir, ".doug", ".state", "jobs");
  function seed(dir) {
    const m = openMemory(dir);
    addLesson(m, { kind: "pattern", source: { agent: "worker" }, text: "the first seeded lesson about uploads" });
    m.close();
    const base = reportsDir(dir);
    mkdirSync(join(base, "briefs"), { recursive: true });
    mkdirSync(join(base, "reviews"), { recursive: true });
    writeFileSync(join(base, "briefs", "1-coder.md"), "brief", "utf8");
    writeFileSync(join(base, "reviews", "1.md"), "review", "utf8");
  }
  // A fake claude that waits for `release` to exist, then prints the envelope, or exits 1 when `fail` is set.
  function writeGatedClaude(dir, envelope, release, fail = false) {
    const p = join(dir, "fake-claude-gated.mjs");
    const body =
      "#!/usr/bin/env node\n" +
      'import { readFileSync, existsSync } from "node:fs";\n' +
      'readFileSync(0, "utf8");\n' +
      `const release = ${JSON.stringify(release)};\n` +
      "const t0 = Date.now();\n" +
      "while (!existsSync(release) && Date.now() - t0 < 8000) await new Promise((r) => setTimeout(r, 25));\n" +
      (fail
        ? 'process.stderr.write("fake-claude: boom\\n"); process.exit(1);\n'
        : `process.stdout.write(${JSON.stringify(JSON.stringify(envelope))});\n`);
    writeFileSync(p, body, "utf8");
    chmodSync(p, 0o755);
    return p;
  }
  const lesson = {
    kind: "pattern",
    text: "uploads retry with jittered backoff",
    citation: "report:c1",
    task: "c1",
    notDerivableBecause: "learned only from this landing",
  };
  const okEnvelope = { structured_output: { lessons: [lesson] }, session_id: "sess-det", total_cost_usd: 0.01, is_error: false };
  const start = (dir, bin, commit = "abc1234") => run(["reflect", "--hand", "c1", dir, "--commit", commit, "--claude-bin", bin, "--detach"], dir);
  const job = (dir, name = "reflect-c1") => run(["job", name, dir], dir);
  // Bounded wait on the job leaving "pending"; no elapsed-time assertion, only a safety deadline.
  function settle(dir, name = "reflect-c1") {
    const deadline = Date.now() + 30000;
    let res = job(dir, name);
    while (/pending/.test(res.stdout) && Date.now() < deadline) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
      res = job(dir, name);
    }
    return res;
  }
  function reapAll(dir) {
    try {
      for (const f of readdirSync(jobsDir(dir))) {
        if (!f.endsWith(".json")) continue;
        const pid = JSON.parse(readFileSync(join(jobsDir(dir), f), "utf8")).pid;
        if (pid) {
          try {
            process.kill(-pid, "SIGKILL");
          } catch {
            try {
              process.kill(pid, "SIGKILL");
            } catch {}
          }
        }
      }
    } catch {}
  }

  it("reflect --detach returns while the job is still running", () => {
    const dir = tempDir();
    try {
      seed(dir);
      const release = join(dir, "release");
      const started = start(dir, writeGatedClaude(dir, okEnvelope, release));
      expect(started.status, started.stderr).toBe(0);
      expect(started.stdout).toContain("reflect-c1");
      const pending = job(dir);
      expect(pending.status, pending.stderr).toBe(0);
      expect(pending.stdout).toContain("pending");
      writeFileSync(release, "go", "utf8");
      settle(dir);
    } finally {
      reapAll(dir);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("job prints reflect's one-line summary when the detached reflect finished, and the proposed lesson is in the store", () => {
    const dir = tempDir();
    try {
      seed(dir);
      const release = join(dir, "release");
      expect(start(dir, writeGatedClaude(dir, okEnvelope, release)).status).toBe(0);
      writeFileSync(release, "go", "utf8");
      const done = settle(dir);
      expect(done.status, done.stderr).toBe(0);
      expect(done.stdout).toContain("Reflected on");
      expect(done.stdout).not.toContain("pending");
      const lessons = JSON.parse(run(["lessons", dir, "--json"], dir).stdout);
      expect(lessons.filter((l) => l.source_agent === "reflect")).toHaveLength(1);
    } finally {
      reapAll(dir);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("job reports pending while the detached reflect is still running, exit 0", () => {
    const dir = tempDir();
    try {
      seed(dir);
      const release = join(dir, "release");
      expect(start(dir, writeGatedClaude(dir, okEnvelope, release)).status).toBe(0);
      const res = job(dir);
      expect(res.status).toBe(0);
      expect(res.stdout).toContain("pending");
      expect(res.stdout).not.toContain("Reflected on");
      writeFileSync(release, "go", "utf8");
      settle(dir);
    } finally {
      reapAll(dir);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("job reports a failed detached reflect with exit 1, the exit code and reflect's stderr reason", () => {
    const dir = tempDir();
    try {
      seed(dir);
      const release = join(dir, "release");
      expect(start(dir, writeGatedClaude(dir, okEnvelope, release, true)).status).toBe(0);
      writeFileSync(release, "go", "utf8");
      const res = settle(dir);
      expect(res.status).toBe(1);
      expect(res.stdout + res.stderr).toContain("failed");
      expect(res.stdout + res.stderr).toContain("cheap-row pass failed");
    } finally {
      reapAll(dir);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reflect --detach with a usage error still exits 2 and starts no job", () => {
    const dir = tempDir();
    try {
      const res = run(["reflect", "--hand", dir, "--detach"], dir);
      expect(res.status).toBe(2);
      expect(existsSync(jobsDir(dir))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Fixture job files: the reader decides from the job file and log, not from what the child was.
  const fixtureJob = (dir, name, state, log) => {
    mkdirSync(jobsDir(dir), { recursive: true });
    writeFileSync(join(jobsDir(dir), `${name}.json`), JSON.stringify({ name, argv: ["x"], startedAt: "2026-10-27T10:00:00.000Z", ...state }), "utf8");
    writeFileSync(join(jobsDir(dir), `${name}.log`), log, "utf8");
  };

  it("job reports failed when the job process is gone and no result was written", () => {
    const dir = tempDir();
    try {
      const gone = spawnSync(process.execPath, ["-e", ""]).pid;
      fixtureJob(dir, "reflect-gone", { pid: gone }, "");
      const res = job(dir, "reflect-gone");
      expect(res.status).toBe(1);
      expect(res.stdout + res.stderr).toContain("failed");
      expect(res.stdout + res.stderr).not.toContain("pending");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("job reports pending for a live pid with no result in the job file", () => {
    const dir = tempDir();
    try {
      fixtureJob(dir, "reflect-live", { pid: process.pid }, "");
      const res = job(dir, "reflect-live");
      expect(res.status).toBe(0);
      expect(res.stdout).toContain("pending");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("job --wait polls a still-running job until it is done and prints reflect's summary", () => {
    const dir = tempDir();
    try {
      seed(dir);
      const release = join(dir, "release");
      const started = start(dir, writeGatedClaude(dir, okEnvelope, release));
      expect(started.status, started.stderr).toBe(0);
      // The job is still pending when the wait starts; the release marker lands only after.
      const gate = spawn(process.execPath, ["-e", `setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(release)}, "go"), 300)`], { stdio: "ignore" });
      const res = run(["job", "reflect-c1", dir, "--wait", "30"], dir);
      gate.kill();
      expect(res.status, res.stderr).toBe(0);
      expect(res.stdout).toContain("Reflected on");
      expect(res.stdout).not.toContain("pending");
    } finally {
      reapAll(dir);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("job --wait stops at the cap and says pending, exit 0", () => {
    const dir = tempDir();
    try {
      fixtureJob(dir, "reflect-live", { pid: process.pid }, "");
      const res = run(["job", "reflect-live", dir, "--wait", "1"], dir);
      expect(res.status).toBe(0);
      expect(res.stdout).toContain("pending");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("job --wait with a non-number exits 2", () => {
    const dir = tempDir();
    try {
      fixtureJob(dir, "reflect-live", { pid: process.pid }, "");
      expect(run(["job", "reflect-live", dir, "--wait", "soon"], dir).status).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("job --earlier reports an earlier landing's pending, failed and unread jobs once, and not the ones already read", () => {
    const dir = tempDir();
    try {
      const gone = spawnSync(process.execPath, ["-e", ""]).pid;
      fixtureJob(dir, "reflect-pend", { pid: process.pid }, "");
      fixtureJob(dir, "reflect-dead", { pid: gone, exitCode: 1, endedAt: "2026-10-27T10:01:00.000Z" }, "reflect: the cheap-row pass failed for dead: boom\n");
      fixtureJob(dir, "reflect-unread", { pid: gone, exitCode: 0, endedAt: "2026-10-27T10:01:20.000Z" }, "Reflected on unread: 1 lesson\n");
      fixtureJob(dir, "reflect-read", { pid: gone, exitCode: 0, endedAt: "2026-10-27T10:01:20.000Z", reportedAt: "2026-10-27T10:02:00.000Z" }, "Reflected on read: 0 lessons\n");
      const first = run(["job", "--earlier", dir], dir);
      expect(first.status).toBe(1);
      expect(first.stdout).toContain("reflect-pend: pending");
      expect(first.stdout).toContain("reflect-dead: failed");
      expect(first.stdout).toContain("Reflected on unread");
      expect(first.stdout).not.toContain("Reflected on read");
      const second = run(["job", "--earlier", dir], dir);
      expect(second.status).toBe(0);
      expect(second.stdout).toContain("reflect-pend: pending");
      expect(second.stdout).not.toContain("reflect-dead");
      expect(second.stdout).not.toContain("Reflected on unread");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a job name an ended job already used reports the new job: failed with its exit code, and unread for job --earlier", () => {
    const dir = tempDir();
    try {
      seed(dir);
      const release1 = join(dir, "release1");
      writeFileSync(release1, "go", "utf8");
      expect(start(dir, writeGatedClaude(dir, okEnvelope, release1)).status).toBe(0);
      const first = run(["job", "reflect-c1", dir, "--wait", "30"], dir);
      expect(first.status, first.stderr).toBe(0);
      const release2 = join(dir, "release2");
      const second = start(dir, writeGatedClaude(dir, okEnvelope, release2, true), "def5678");
      expect(second.status, second.stderr).toBe(0);
      expect(job(dir).stdout).toContain("pending");
      writeFileSync(release2, "go", "utf8");
      const res = run(["job", "reflect-c1", dir, "--wait", "30"], dir);
      expect(res.status).toBe(1);
      expect(res.stdout).toContain("failed");
      expect(res.stdout).toContain("exit 1");
      const st = JSON.parse(readFileSync(join(jobsDir(dir), "reflect-c1.json"), "utf8"));
      expect(st.exitCode).toBe(1);
    } finally {
      reapAll(dir);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a failed job under a reused name is reported once by job --earlier", () => {
    const dir = tempDir();
    try {
      seed(dir);
      const release1 = join(dir, "release1");
      writeFileSync(release1, "go", "utf8");
      expect(start(dir, writeGatedClaude(dir, okEnvelope, release1)).status).toBe(0);
      expect(run(["job", "reflect-c1", dir, "--wait", "30"], dir).status).toBe(0);
      const release2 = join(dir, "release2");
      writeFileSync(release2, "go", "utf8");
      expect(start(dir, writeGatedClaude(dir, okEnvelope, release2, true), "def5678").status).toBe(0);
      const deadline = Date.now() + 30000;
      while (Date.now() < deadline) {
        const st = JSON.parse(readFileSync(join(jobsDir(dir), "reflect-c1.json"), "utf8"));
        if (st.exitCode !== undefined) break;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
      }
      const earlier = run(["job", "--earlier", dir], dir);
      expect(earlier.status).toBe(1);
      expect(earlier.stdout).toContain("reflect-c1: failed");
    } finally {
      reapAll(dir);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a second start while a live job holds the name is refused and leaves the live job's log and file intact", () => {
    const dir = tempDir();
    try {
      seed(dir);
      const release = join(dir, "release");
      expect(start(dir, writeGatedClaude(dir, okEnvelope, release)).status).toBe(0);
      const before = readFileSync(join(jobsDir(dir), "reflect-c1.json"), "utf8");
      const pid = JSON.parse(before).pid;
      appendFileSync(join(jobsDir(dir), "reflect-c1.log"), "LIVE-LOG-MARKER\n");
      const refused = start(dir, writeGatedClaude(dir, okEnvelope, join(dir, "other")));
      expect(refused.status).not.toBe(0);
      expect(refused.stderr).toContain("reflect-c1");
      expect(refused.stderr).toContain(String(pid));
      expect(readFileSync(join(jobsDir(dir), "reflect-c1.log"), "utf8")).toContain("LIVE-LOG-MARKER");
      expect(JSON.parse(readFileSync(join(jobsDir(dir), "reflect-c1.json"), "utf8")).pid).toBe(pid);
      writeFileSync(release, "go", "utf8");
      settle(dir);
    } finally {
      reapAll(dir);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("job files are replaced whole: no temp files are left after a detached reflect finished", () => {
    const dir = tempDir();
    try {
      seed(dir);
      const release = join(dir, "release");
      writeFileSync(release, "go", "utf8");
      const started = start(dir, writeGatedClaude(dir, okEnvelope, release));
      expect(started.status, started.stderr).toBe(0);
      const res = run(["job", "reflect-c1", dir, "--wait", "30"], dir);
      expect(res.status, res.stderr).toBe(0);
      expect(readdirSync(jobsDir(dir)).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    } finally {
      reapAll(dir);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("job on an unknown name exits 1", () => {
    const dir = tempDir();
    try {
      expect(job(dir, "reflect-nope").status).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Runs the real runner (`__jobrun`) with its stdio on the job log, as startDetachedJob does, waiting for it to end.
  function runRunner(dir, name, command) {
    mkdirSync(jobsDir(dir), { recursive: true });
    const fd = openSync(join(jobsDir(dir), `${name}.log`), "w");
    try {
      return spawnSync(process.execPath, [script, "__jobrun", dir, name, "--", ...command], { cwd: dir, stdio: ["ignore", fd, fd] });
    } finally {
      closeSync(fd);
    }
  }

  it("the job runner runs a non-reflect command detached and reports its last line and exit code", () => {
    const dir = tempDir();
    try {
      runRunner(dir, "rehearse-ok", [process.execPath, "-e", 'console.log("first"); console.log("the rehearsal line")']);
      const ok = job(dir, "rehearse-ok");
      expect(ok.status).toBe(0);
      expect(ok.stdout).toContain("the rehearsal line");
      expect(ok.stdout).not.toContain("Reflected");
      expect(JSON.parse(readFileSync(join(jobsDir(dir), "rehearse-ok.json"), "utf8")).exitCode).toBe(0);
      runRunner(dir, "rehearse-bad", [process.execPath, "-e", 'console.log("work"); console.log("it broke"); process.exit(3)']);
      expect(JSON.parse(readFileSync(join(jobsDir(dir), "rehearse-bad.json"), "utf8")).exitCode).toBe(3);
      const bad = job(dir, "rehearse-bad");
      expect(bad.status).toBe(1);
      expect(bad.stdout + bad.stderr).toContain("failed");
      expect(bad.stdout + bad.stderr).toContain("3");
      expect(bad.stdout + bad.stderr).toContain("it broke");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  describe("report form", () => {
    // Report in another cwd, addressed by a relative path; the project dir is a positional argument.
    const startReport = (dir, other, bin, extra) =>
      spawnSync(process.execPath, [script, "reflect", "report.json", dir, "--claude-bin", bin, ...extra, "--detach"], { cwd: other, encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: "" } });

    it("reflect <report> --detach returns while the job runs, names the job reflect-<card>, and resolves the report against the caller's cwd", () => {
      const dir = tempDir();
      const other = tempDir();
      try {
        copyFileSync(fixtureReport, join(other, "report.json"));
        const release = join(dir, "release");
        const started = startReport(dir, other, writeGatedClaude(dir, okEnvelope, release), ["--card", "k1"]);
        expect(started.status, started.stderr).toBe(0);
        expect(started.stdout).toContain("reflect-k1");
        const pending = job(dir, "reflect-k1");
        expect(pending.status).toBe(0);
        expect(pending.stdout).toContain("pending");
        writeFileSync(release, "go", "utf8");
        const done = settle(dir, "reflect-k1");
        expect(done.status, done.stdout + done.stderr).toBe(0);
        expect(done.stdout).toContain("Reflected on");
      } finally {
        reapAll(dir);
        rmSync(dir, { recursive: true, force: true });
        rmSync(other, { recursive: true, force: true });
      }
    });

    it("the report-form job is named reflect-<run> with --run, else reflect-<12 hex of the report hash>", () => {
      const dir = tempDir();
      const other = tempDir();
      try {
        copyFileSync(fixtureReport, join(other, "report.json"));
        const release = join(dir, "release");
        writeFileSync(release, "go", "utf8");
        const bin = writeGatedClaude(dir, okEnvelope, release);
        const byRun = startReport(dir, other, bin, ["--run", "r9"]);
        expect(byRun.status, byRun.stderr).toBe(0);
        expect(byRun.stdout).toContain("reflect-r9");
        const bare = startReport(dir, other, bin, []);
        expect(bare.status, bare.stderr).toBe(0);
        const hashName = (bare.stdout.match(/reflect-[0-9a-f]{12}\b/) || [])[0];
        expect(hashName).toBeTruthy();
        settle(dir, "reflect-r9");
        settle(dir, hashName);
      } finally {
        reapAll(dir);
        rmSync(dir, { recursive: true, force: true });
        rmSync(other, { recursive: true, force: true });
      }
    });
  });
});

// card memory-failures-wiring: reflect --failures can run detached (job failures-<card>), the way autopilot and
// doug-hand start it when a card stops. The job name never collides with a landing's reflect-<card> job.
describe("memory.mjs reflect --failures --detach (card memory-failures-wiring)", () => {
  const jobsDir = (dir) => join(dir, ".doug", ".state", "jobs");
  const seed = (dir) =>
    writeRunHistory(dir, {
      card: "c1",
      run: "wf_1",
      scan: () => null,
      entries: [
        { kind: "report", source: "card-report.json", value: JSON.stringify({ outcome: "stopped", reason: "gate", stoppedAt: "coder", detail: "gate stayed red", worktree: "/wt/c1", filesChanged: [] }) },
      ],
    });
  // A fake claude that records its argv, waits for `release`, then answers with an envelope holding no lessons.
  const gated = (dir, release, argsFile) => {
    const p = join(dir, "fake-claude-failures-gated.mjs");
    writeFileSync(
      p,
      "#!/usr/bin/env node\n" +
        'import { readFileSync, existsSync, writeFileSync } from "node:fs";\n' +
        `writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(process.argv.slice(2)));\n` +
        'readFileSync(0, "utf8");\n' +
        `const release = ${JSON.stringify(release)};\n` +
        "const t0 = Date.now();\n" +
        "while (!existsSync(release) && Date.now() - t0 < 5000) await new Promise((r) => setTimeout(r, 25));\n" +
        `process.stdout.write(${JSON.stringify(JSON.stringify({ structured_output: { lessons: [] }, session_id: "sess-fd", total_cost_usd: 0.01, is_error: false }))});\n`,
      "utf8"
    );
    chmodSync(p, 0o755);
    return p;
  };
  const reap = (dir) => {
    try {
      for (const f of readdirSync(jobsDir(dir))) {
        if (!f.endsWith(".json")) continue;
        const pid = JSON.parse(readFileSync(join(jobsDir(dir), f), "utf8")).pid;
        if (!pid) continue;
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          try {
            process.kill(pid, "SIGKILL");
          } catch {}
        }
      }
    } catch {}
  };

  it("returns at once with 'failures-c1: started detached', writes jobs/failures-c1.json (not reflect-c1), and the job later prints the Reflected line", () => {
    const dir = tempDir();
    try {
      seed(dir);
      const release = join(dir, "release");
      const argsFile = join(dir, "args.json");
      const bin = gated(dir, release, argsFile);
      const started = run(["reflect", "--failures", "c1", dir, "--claude-bin", bin, "--max-usd", "0.5", "--detach"], dir);
      expect(started.status, started.stderr).toBe(0);
      expect(started.stdout).toContain("failures-c1: started detached");
      expect(existsSync(join(jobsDir(dir), "failures-c1.json"))).toBe(true);
      expect(existsSync(join(jobsDir(dir), "reflect-c1.json"))).toBe(false);
      const pending = run(["job", "failures-c1", dir], dir);
      expect(pending.stdout).toContain("pending");
      writeFileSync(release, "go", "utf8");
      const done = run(["job", "failures-c1", dir, "--wait", "30"], dir);
      expect(done.status, done.stdout + done.stderr).toBe(0);
      expect(done.stdout).toContain("Reflected");
      const args = JSON.parse(readFileSync(argsFile, "utf8"));
      expect(args[args.indexOf("--max-budget-usd") + 1]).toBe("0.5");
      expect(args[args.indexOf("--model") + 1]).toBe("haiku");
    } finally {
      reap(dir);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a second --detach while failures-c1 is still running exits 1 and starts no second job", () => {
    const dir = tempDir();
    try {
      seed(dir);
      const release = join(dir, "release");
      const bin = gated(dir, release, join(dir, "args.json"));
      expect(run(["reflect", "--failures", "c1", dir, "--claude-bin", bin, "--detach"], dir).status).toBe(0);
      const again = run(["reflect", "--failures", "c1", dir, "--claude-bin", bin, "--detach"], dir);
      expect(again.status).toBe(1);
      writeFileSync(release, "go", "utf8");
    } finally {
      reap(dir);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// Card memory-dir-requires-doug: rehearsal-sweep-1-6 (2026-10-28) ran memory.mjs recall from plugins/doug-flow/scripts and
// openMemory created an empty .doug/.state/memory/memory.db there. dirFrom now refuses a directory with no .doug/.
describe("memory.mjs refuses a directory that is not a Doug project (card memory-dir-requires-doug)", () => {
  it("recall from a cwd with no .doug/ exits 1 with 'not a Doug project' and creates no file", () => {
    const cwd = bareDir();
    try {
      const res = run(["recall", "anything"], cwd);
      expect(res.status, res.stderr).toBe(1);
      expect(res.stderr).toContain("not a Doug project");
      expect(res.stdout).toBe("");
      expect(readdirSync(cwd)).toEqual([]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("recall with a [dir] positional that has no .doug/ is refused and creates nothing there, even from a cwd that has .doug/", () => {
    const cwd = tempDir();
    const target = bareDir();
    try {
      const res = run(["recall", "anything", target], cwd);
      expect(res.status, res.stderr).toBe(1);
      expect(res.stderr).toContain("not a Doug project");
      expect(readdirSync(target)).toEqual([]);
      expect(readdirSync(join(cwd, ".doug"))).toEqual([]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(target, { recursive: true, force: true });
    }
  });

  it("a Doug project with .doug/ but no store still works: recall exits 0 with the keyword-only header", () => {
    const cwd = tempDir();
    try {
      const res = run(["recall", "anything"], cwd);
      expect(res.status, res.stderr).toBe(0);
      expect(res.stdout).toContain("recall: keyword-only");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("the refusal applies to other subcommands too (lessons) and a usage error still exits 2", () => {
    const cwd = bareDir();
    try {
      const res = run(["lessons"], cwd);
      expect(res.status).toBe(1);
      expect(res.stderr).toContain("not a Doug project");
      expect(readdirSync(cwd)).toEqual([]);
      expect(run(["recall"], cwd).status).toBe(2);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

// Card memory-docs-detach-job: docs/memory.md documents reflect --detach, memory.mjs job, job --earlier, and the refusal.
describe("docs/memory.md documents reflect --detach and memory.mjs job", () => {
  const doc = readFileSync(join(here, "..", "..", "..", "docs", "memory.md"), "utf8");
  const section = (heading) => {
    const i = doc.indexOf(heading);
    expect(i, `${heading} present`).toBeGreaterThanOrEqual(0);
    const rest = doc.slice(i + heading.length);
    const next = rest.search(/\n## /);
    return next < 0 ? rest : rest.slice(0, next);
  };

  it("the reflect section names --detach on the report and --hand forms, the start line, and the job names", () => {
    const s = section("## `memory.mjs reflect`");
    expect(s).toContain("[--detach]");
    expect(s).toContain("reflect --hand <card-id> [dir] --commit <sha> [--rounds <n>]");
    expect(s).toMatch(/--rounds <n>\][^\n]*--detach|--detach[^\n]*--note/);
    expect(s).toContain("<name>: started detached (pid <pid>); read it with: memory.mjs job <name>");
    expect(s).toContain("reflect-<card-id>");
    expect(s).toContain("reflect-<--card, else --run, else");
  });

  it("the job section documents usage, files, the three states, --wait, --earlier, and exit codes", () => {
    const s = section("## `memory.mjs job`");
    expect(s).toContain("memory.mjs job <name> [dir] [--wait <seconds>]");
    expect(s).toContain("memory.mjs job --earlier [dir]");
    expect(s).toContain(".doug/.state/jobs/<name>.json");
    expect(s).toContain("<name>.log");
    expect(s).toContain("(job <name>, <n> s)");
    expect(s).toContain("<name>: pending (started <iso>, pid <pid>)");
    expect(s).toContain("<name>: failed (exit <n>|signal <s>)");
    expect(s).toContain("is gone and wrote no result");
    expect(s).toContain("earlier job <line>");
    expect(s).toContain("no earlier jobs unread");
    expect(s).toMatch(/whole seconds/);
    expect(s).toMatch(/no such job/);
  });

  it("the job section documents the refusal when a live job holds the name, and reuse after it ended", () => {
    const s = section("## `memory.mjs job`");
    expect(s).toContain("job <name> is already running (pid <pid>); read it with: memory.mjs job <name>");
    expect(s).toMatch(/exit 1/);
    expect(s).toMatch(/untouched/);
    expect(s).toMatch(/reused/);
  });
});
