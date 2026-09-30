// The codex-review binary: argument parsing, stdin spec, JSON on stdout, exit codes.
import { describe, it, expect, beforeAll } from "vitest";
import { spawnSync } from "node:child_process";
import { writeFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, HELP } from "../src/cli.js";
import { NETWORK_ACCESS_OVERRIDE } from "../src/run.js";
import { makeRepo, makeFakeCodex } from "./helpers.js";

const here = dirname(fileURLToPath(import.meta.url));
const binTs = join(here, "..", "src", "bin.ts");

function runCli(args: string[], opts: { stdin?: string; env?: Record<string, string> } = {}) {
  const r = spawnSync(process.execPath, ["--import", "tsx", binTs, ...args], { encoding: "utf8", input: opts.stdin, env: { ...process.env, ...(opts.env || {}) }, cwd: join(here, "..") });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe("parseArgs", () => {
  it("requires --base and a spec source", () => {
    expect(parseArgs([])).toBe("--base is required");
    expect(parseArgs(["--base", "main"])).toMatch(/--spec-file/);
    expect(parseArgs(["--base", "main", "--spec", "-"])).toMatchObject({ base: "main", specStdin: true });
    expect(parseArgs(["--base", "main", "--spec-file", "s.md", "--verify", "a", "--verify", "b", "--keep-mcp"])).toMatchObject({ specFile: "s.md", verify: ["a", "b"], keepMcp: true });
  });
  it("rejects unknown flags, missing values and bad timeouts", () => {
    expect(parseArgs(["--bogus"])).toBe("unknown argument: --bogus");
    expect(parseArgs(["--base"])).toBe("--base needs a value");
    expect(parseArgs(["--base", "m", "--spec", "-", "--timeout-ms", "x"])).toBe("--timeout-ms must be a positive number");
    expect(parseArgs(["--base", "m", "--spec", "-", "--sandbox", "danger-full-access"])).toBe("--sandbox must be one of read-only, workspace-write");
    expect(parseArgs(["--base", "m", "--spec", "-", "--sandbox", "read-only"])).toMatchObject({ sandbox: "read-only" });
  });

  it("documents --sandbox in the Usage synopsis, not just the flag list", () => {
    const usage = HELP.slice(HELP.indexOf("Usage:"), HELP.indexOf("\n\n", HELP.indexOf("Usage:")));
    expect(usage).toContain("--sandbox");
  });
  it("lets --help through without other flags", () => {
    expect(parseArgs(["--help"])).toMatchObject({ help: true });
  });
});

describe("card codex-review-network-access", () => {
  it("N4: --network-access / --no-network-access parse and are documented", () => {
    const on = parseArgs(["--base", "m", "--spec", "-", "--network-access"]);
    expect(on, "rule: --network-access sets networkAccess true").toMatchObject({ networkAccess: true });
    const off = parseArgs(["--base", "m", "--spec", "-", "--no-network-access"]);
    expect(off, "rule: --no-network-access sets networkAccess false").toMatchObject({ networkAccess: false });
    const neither = parseArgs(["--base", "m", "--spec", "-"]) as any;
    expect(neither.networkAccess === undefined, "rule: neither flag given leaves networkAccess undefined").toBe(true);

    const usage = HELP.slice(HELP.indexOf("Usage:"), HELP.indexOf("\n\n", HELP.indexOf("Usage:")));
    expect(usage, "rule: the Usage synopsis mentions --network-access").toContain("--network-access");
    expect(HELP, "rule: the flag list mentions --no-network-access").toContain("--no-network-access");
  });
});

describe("card codex-review-effort", () => {
  it("parseArgs --effort parses to a level, rejects an unknown one with the exact usage error, requires a value, and is documented in HELP", () => {
    expect(parseArgs(["--base", "m", "--spec", "-", "--effort", "high"]), "rule: --effort <level> sets effort").toMatchObject({ effort: "high" });
    expect(parseArgs(["--base", "m", "--spec", "-", "--effort", "bogus"]), "rule: an unknown level is exactly this usage error").toBe("--effort must be one of minimal, low, medium, high, xhigh");
    expect(parseArgs(["--base", "m", "--spec", "-", "--effort"]), "rule: --effort with no following value").toBe("--effort needs a value");
    expect(HELP, "rule: HELP mentions --effort").toContain("--effort");
    expect(HELP, "rule: HELP explains the mapping to -c model_reasoning_effort=<level>").toContain("model_reasoning_effort");
  });
});

describe("codex-review binary", () => {
  let repo: ReturnType<typeof makeRepo>;
  let fake: ReturnType<typeof makeFakeCodex>;
  beforeAll(() => {
    repo = makeRepo();
    fake = makeFakeCodex();
  });
  it("exits 64 with help on a usage error and 0 on --help", () => {
    const bad = runCli([]);
    expect(bad.status).toBe(64);
    expect(bad.stderr).toContain("--base is required");
    expect(runCli(["--help"]).status).toBe(0);
  });
  it("reads the spec from stdin, prints ReviewResult JSON and exits 0 on pass", () => {
    const r = runCli(["--base", repo.base, "--head", repo.head, "--dir", repo.dir, "--spec", "-", "--codex", fake.bin], { stdin: "add returns a + b", env: { FAKE_CODEX_MODE: "ok" } });
    expect(r.status, r.stderr).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.verdict).toBe("pass");
    expect(out.reviewer).toBe("codex");
    expect(out.commandsRun[1].exitCode).toBe(3);
  });
  it("exits 1 on a fail verdict and 2 when the review could not run", () => {
    const specFile = join(repo.dir, "spec.md");
    writeFileSync(specFile, "add returns a + b\n");
    const fail = runCli(["--base", repo.base, "--head", repo.head, "--dir", repo.dir, "--spec-file", specFile, "--codex", fake.bin], { env: { FAKE_CODEX_MODE: "fail-verdict" } });
    expect(fail.status).toBe(1);
    expect(JSON.parse(fail.stdout).issues[0].severity).toBe("blocker");
    const missing = runCli(["--base", repo.base, "--head", repo.head, "--dir", repo.dir, "--spec-file", specFile, "--codex", "/nonexistent/codex"]);
    expect(missing.status).toBe(2);
    expect(JSON.parse(missing.stdout).error.kind).toBe("codex-not-found");
  });
  it("exits 64 on an empty spec", () => {
    const r = runCli(["--base", repo.base, "--dir", repo.dir, "--spec", "-"], { stdin: "  \n" });
    expect(r.status).toBe(64);
  });
  it("N5: bin.ts wires parsed.networkAccess through to runCodexReview, so the binary's own spawned codex argv carries or omits the override", () => {
    const on = runCli(["--base", repo.base, "--head", repo.head, "--dir", repo.dir, "--spec", "-", "--codex", fake.bin, "--verify", "node --test"], { stdin: "add returns a + b", env: { FAKE_CODEX_MODE: "ok" } });
    expect(on.status, "rule(setup): the review run must exit 0 pass for the argv fixture read afterward to be meaningful").toBe(0);
    const gotOn = JSON.parse(readFileSync(fake.received, "utf8"));
    expect(gotOn.argv.join(" "), "rule: bin.ts passes parsed.networkAccess through to runCodexReview, so the default (workspace-write plus a --verify command) reaches the codex process the binary spawns").toContain(NETWORK_ACCESS_OVERRIDE);

    const off = runCli(["--base", repo.base, "--head", repo.head, "--dir", repo.dir, "--spec", "-", "--codex", fake.bin, "--verify", "node --test", "--no-network-access"], { stdin: "add returns a + b", env: { FAKE_CODEX_MODE: "ok" } });
    expect(off.status, "rule(setup): the review run must exit 0 pass for the argv fixture read afterward to be meaningful").toBe(0);
    const gotOff = JSON.parse(readFileSync(fake.received, "utf8"));
    expect(gotOff.argv.join(" "), "rule: --no-network-access on the CLI reaches runCodexReview through bin.ts and suppresses the override on the codex process the binary spawns").not.toContain(NETWORK_ACCESS_OVERRIDE);
  });
  it("E3: bin.ts wires parsed.effort through to runCodexReview, so --effort <level> reaches the binary's own spawned codex argv as -c model_reasoning_effort=<level>", () => {
    const r = runCli(["--base", repo.base, "--head", repo.head, "--dir", repo.dir, "--spec", "-", "--codex", fake.bin, "--effort", "high"], { stdin: "add returns a + b", env: { FAKE_CODEX_MODE: "ok" } });
    expect(r.status, r.stderr).toBe(0);
    const got = JSON.parse(readFileSync(fake.received, "utf8"));
    expect(got.argv.join(" "), "rule: --effort high on the CLI reaches runCodexReview through bin.ts and appears in the spawned codex argv as -c model_reasoning_effort=high").toContain("-c model_reasoning_effort=high");
  });
});
