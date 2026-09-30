// Runs the adapter end to end against a fake codex binary: argv contract, prompt on stdin, and every failure mode.
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync, realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runCodexReview, codexArgs, resolveNetworkAccess, NETWORK_ACCESS_OVERRIDE, reasoningEffortOverride } from "../src/run.js";
import { MODEL_REVIEW_SCHEMA, REASONING_EFFORTS } from "../src/schema.js";
import { checkReviewResult } from "../src/contract.js";
import { makeRepo, makeFakeCodex, git } from "./helpers.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");

let repo: ReturnType<typeof makeRepo>;
let fake: ReturnType<typeof makeFakeCodex>;
beforeAll(() => {
  repo = makeRepo();
  fake = makeFakeCodex();
});

function review(mode: string, extra: Partial<Parameters<typeof runCodexReview>[0]> = {}) {
  process.env.FAKE_CODEX_MODE = mode;
  return runCodexReview({ spec: "add(a, b) must return a + b and be covered by a test.", base: repo.base, head: repo.head, dir: repo.dir, codexBin: fake.bin, verifyCommands: ["node --test"], ...extra });
}

describe("codexArgs", () => {
  it("always runs sandboxed (workspace-write by default), ephemeral, with the output schema, and without the user's MCP servers", () => {
    const a = codexArgs({ schemaFile: "/s.json", lastMessageFile: "/l.txt", dir: "/repo" });
    expect(a.slice(0, 2)).toEqual(["exec", "--json"]);
    expect(a).toContain("--ephemeral");
    expect(a.join(" ")).toContain("--sandbox workspace-write");
    expect(codexArgs({ schemaFile: "s", lastMessageFile: "l", dir: "d", sandbox: "read-only" }).join(" ")).toContain("--sandbox read-only");
    expect(a.join(" ")).toContain("-C /repo");
    expect(a.join(" ")).toContain("--output-schema /s.json");
    expect(a.join(" ")).toContain("-c mcp_servers={}");
    expect(a[a.length - 1]).toBe("-");
    expect(a).not.toContain("--dangerously-bypass-approvals-and-sandbox");
  });
  it("ships a schema that satisfies the API's strict mode: every property is required", () => {
    const check = (node: any) => {
      if (node && typeof node === "object" && node.type === "object" && node.properties) {
        expect(node.additionalProperties).toBe(false);
        expect([...(node.required || [])].sort()).toEqual(Object.keys(node.properties).sort());
        for (const v of Object.values(node.properties)) check(v);
      }
      if (node && node.items) check(node.items);
    };
    check(MODEL_REVIEW_SCHEMA);
  });
  it("passes model, keep-mcp and config overrides through", () => {
    const a = codexArgs({ schemaFile: "s", lastMessageFile: "l", dir: "d", model: "gpt-x", keepMcpServers: true, configOverrides: ["foo=1"] });
    expect(a.join(" ")).toContain("-m gpt-x");
    expect(a.join(" ")).not.toContain("mcp_servers={}");
    expect(a.join(" ")).toContain("-c foo=1");
  });
});

describe("runCodexReview with a fake codex", () => {
  it("passes the prompt on stdin, runs in the target dir, and reports the model's pass verdict with real command evidence", async () => {
    const r = await review("ok");
    expect(r.error).toBeNull();
    expect(r.verdict).toBe("pass");
    expect(r.changedFiles).toEqual(["add.test.js", "src/add.js"]);
    expect(r.commandsRun).toEqual([
      { command: "/bin/zsh -lc 'node --test'", exitCode: 0, ok: true, outputTail: "ok 1 - add\n" },
      { command: "/bin/zsh -lc 'node -e \"process.exit(3)\"'", exitCode: 3, ok: false, outputTail: undefined },
    ]);
    expect(r.usage).toEqual({ inputTokens: 1234, outputTokens: 56 });
    expect(r.codexExitCode).toBe(0);
    const got = JSON.parse(readFileSync(fake.received, "utf8"));
    expect(realpathSync(got.cwd)).toBe(realpathSync(r.dir));
    expect(got.argv.join(" ")).toContain("--sandbox workspace-write");
    expect(r.sandbox).toBe("workspace-write");
    expect(got.stdin).toContain("add(a, b) must return a + b");
    expect(got.stdin).toContain("+  return a - b; // fixed");
    expect(got.stdin).toContain("`node --test`");
    const schemaFile = got.argv[got.argv.indexOf("--output-schema") + 1];
    expect(schemaFile).toMatch(/schema\.json$/);
  });
  it("surfaces a fail verdict with its issues and does not invent extra ones", async () => {
    const r = await review("fail-verdict");
    expect(r.verdict).toBe("fail");
    expect(r.issues).toHaveLength(2);
    expect(r.issues[0]).toMatchObject({ severity: "blocker", file: "src/add.js", line: 2 });
    expect(r.error).toBeNull();
  });
  it("is inconclusive with codex-not-found when the binary does not exist", async () => {
    const r = await review("ok", { codexBin: "/nonexistent/codex-binary" });
    expect(r.verdict).toBe("inconclusive");
    expect(r.error?.kind).toBe("codex-not-found");
    expect(r.changedFiles).toEqual(["add.test.js", "src/add.js"]);
  });
  it("is inconclusive with codex-failed and the stderr tail on a non-zero exit, keeping the evidence gathered", async () => {
    const r = await review("nonzero");
    expect(r.verdict).toBe("inconclusive");
    expect(r.error).toMatchObject({ kind: "codex-failed", message: "codex exec exited 7" });
    expect((r.error as any).stderrTail).toContain("boom");
    expect(r.commandsRun).toHaveLength(2);
    expect(r.codexExitCode).toBe(7);
  });
  it("is inconclusive with unparseable when the final message is prose", async () => {
    const r = await review("prose");
    expect(r.verdict).toBe("inconclusive");
    expect(r.error).toMatchObject({ kind: "unparseable", message: "final message is not JSON" });
    expect((r.error as any).raw).toContain("no JSON for you");
  });
  it("is inconclusive with unparseable when the JSON has the wrong shape", async () => {
    const r = await review("bad-shape");
    expect(r.error?.kind).toBe("unparseable");
    expect(r.error?.message).toMatch(/verdict must be one of/);
  });
  it("is inconclusive with no-final-message when codex ends without an agent message", async () => {
    const r = await review("nofinal");
    expect(r.error?.kind).toBe("no-final-message");
    expect(r.commandsRun).toHaveLength(2);
  });
  it("kills codex and reports timeout when it hangs", async () => {
    const r = await review("hang", { timeoutMs: 800 });
    expect(r.verdict).toBe("inconclusive");
    expect(r.error?.kind).toBe("timeout");
    expect(r.commandsRun).toHaveLength(2);
    expect(r.durationMs).toBeLessThan(10000);
  }, 15000);
  it("voids the review with worktree-modified when the reviewer changed the working tree, even if it claims a pass", async () => {
    const own = makeRepo();
    const r = await review("mutate", { dir: own.dir, base: own.base, head: own.head });
    expect(r.verdict).toBe("inconclusive");
    expect(r.error?.kind).toBe("worktree-modified");
    expect((r.error as any).changes).toEqual(["+  M src/add.js", "+ ?? scratch.txt"]);
    expect(r.commandsRun).toHaveLength(2);
  });
  it("refuses to review when head is not what is checked out in dir, since commands would test the wrong code", async () => {
    const own = makeRepo();
    git(own.dir, "checkout", "-q", "main");
    const r = await review("ok", { dir: own.dir, base: own.base, head: own.head });
    expect(r.verdict).toBe("inconclusive");
    expect(r.error?.kind).toBe("git");
    expect(r.error?.message).toMatch(/fix .* is not what is checked out/);
    expect(r.changedFiles).toEqual(["add.test.js", "src/add.js"]);
  });
  it("is inconclusive with a git error when a ref does not resolve, without spawning codex", async () => {
    process.env.FAKE_CODEX_MODE = "ok";
    const r = await runCodexReview({ spec: "x", base: "no-such-ref", dir: repo.dir, codexBin: "/nonexistent/codex-binary" });
    expect(r.error?.kind).toBe("git");
    expect(r.error?.message).toMatch(/no-such-ref/);
  });
  it("sets DOUG_CODEX_REVIEW=1 on the spawned codex and records the marker as passed, and inherited when it was already set", async () => {
    const prev = process.env.DOUG_CODEX_REVIEW;
    try {
      delete process.env.DOUG_CODEX_REVIEW;
      const r = await review("ok");
      const got = JSON.parse(readFileSync(fake.received, "utf8"));
      expect(got.env.DOUG_CODEX_REVIEW).toBe("1");
      expect(r.marker).toEqual({ name: "DOUG_CODEX_REVIEW", passed: true, inherited: false });

      process.env.DOUG_CODEX_REVIEW = "1";
      const r2 = await review("ok");
      expect(r2.marker.inherited).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.DOUG_CODEX_REVIEW;
      else process.env.DOUG_CODEX_REVIEW = prev;
    }
  });
  it("marker.passed is false before codex is spawned and true once it was", async () => {
    process.env.FAKE_CODEX_MODE = "ok";
    const gitErr = await runCodexReview({ spec: "x", base: "no-such-ref", dir: repo.dir, codexBin: "/nonexistent/codex-binary" });
    expect(gitErr.marker.passed).toBe(false);
    const notFound = await review("ok", { codexBin: "/nonexistent/codex-binary" });
    expect(notFound.marker.passed).toBe(true);
  });
  it("C8: runCodexReview downgrades an evidence-free blocker to major, prefixes its description, sets downgraded, and flips the verdict to pass", async () => {
    const r = await review("blocker-no-evidence");
    expect(r.verdict).toBe("pass");
    expect(r.issues).toHaveLength(1);
    expect(r.issues[0].severity).toBe("major");
    expect(r.issues[0].file).toBe("src/add.js");
    expect(r.issues[0].line).toBe(2);
    expect(r.issues[0].description).toMatch(/^\[codex-review: downgraded from blocker, R12: .+\] add\(2,2\) returns 0$/);
    expect((r as any).downgraded).toEqual([{ index: 0, reason: expect.any(String) }]);
    expect((r as any).downgraded[0].reason.length).toBeGreaterThan(0);
    expect(checkReviewResult(r)).toEqual([]);
  });
  it("C8: a blocker citing a recorded command that exited non-zero stays a blocker with verdict fail", async () => {
    const r = await review("fail-verdict");
    expect(r.verdict).toBe("fail");
    const blocker = r.issues.find((i) => i.severity === "blocker");
    expect(blocker).toBeDefined();
    expect(blocker!.description).toBe("add(2,2) returns 0");
    expect((r as any).downgraded).toBeUndefined();
    expect(checkReviewResult(r)).toEqual([]);
  });
  it(
    "the live Codex test skips under the marker",
    () => {
      const r = spawnSync(process.execPath, [join(root, "node_modules/vitest/vitest.mjs"), "run", "packages/doug-codex/tests/codex-live.test.ts", "--reporter=json"], {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env, DOUG_CODEX_REVIEW: "1" },
      });
      const json = JSON.parse(r.stdout.slice(r.stdout.indexOf("{")));
      expect(json.numTotalTests).toBe(1);
      expect(json.numPendingTests).toBe(1);
      expect(json.numFailedTests).toBe(0);
      const assertion = json.testResults[0].assertionResults[0];
      expect(assertion.status).toBe("skipped");
      expect(assertion.fullName).toContain("DOUG_CODEX_REVIEW");
    },
    60000,
  );
});

describe("card codex-review-network-access", () => {
  it("N1: codexArgs pushes NETWORK_ACCESS_OVERRIDE before the caller's configOverrides when networkAccess is true, and omits it when false or absent", () => {
    const withIt = codexArgs({ schemaFile: "s", lastMessageFile: "l", dir: "d", networkAccess: true, configOverrides: ["foo=1"] });
    expect(withIt.join(" "), "rule: networkAccess true adds -c NETWORK_ACCESS_OVERRIDE").toContain(`-c ${NETWORK_ACCESS_OVERRIDE}`);
    expect(NETWORK_ACCESS_OVERRIDE, "rule: NETWORK_ACCESS_OVERRIDE is exactly the sandbox_workspace_write.network_access=true override string").toBe("sandbox_workspace_write.network_access=true");
    const overrideIdx = withIt.indexOf(NETWORK_ACCESS_OVERRIDE);
    const fooIdx = withIt.indexOf("foo=1");
    expect(overrideIdx, "rule: the network-access override is pushed before the caller's configOverrides entries, so an explicit override comes later (that a later -c wins in codex is assumed, unverified)").toBeLessThan(fooIdx);
    const withFalse = codexArgs({ schemaFile: "s", lastMessageFile: "l", dir: "d", networkAccess: false, configOverrides: ["foo=1"] });
    expect(withFalse.join(" "), "rule: networkAccess false never adds the override").not.toContain(NETWORK_ACCESS_OVERRIDE);
    const withAbsent = codexArgs({ schemaFile: "s", lastMessageFile: "l", dir: "d", configOverrides: ["foo=1"] });
    expect(withAbsent.join(" "), "rule: networkAccess absent never adds the override").not.toContain(NETWORK_ACCESS_OVERRIDE);
  });

  it("N2: resolveNetworkAccess follows sandbox, verifyCommands, and an explicit override in that priority", () => {
    expect(resolveNetworkAccess({ sandbox: "workspace-write", verifyCommands: ["a"] }), "rule: workspace-write with a verify command defaults on").toBe(true);
    expect(resolveNetworkAccess({ sandbox: "workspace-write", verifyCommands: [] }), "rule: workspace-write with no verify command defaults off").toBe(false);
    expect(resolveNetworkAccess({ sandbox: "read-only", verifyCommands: ["a"] }), "rule: read-only is always off regardless of verify commands").toBe(false);
    expect(resolveNetworkAccess({ sandbox: "read-only", verifyCommands: ["a"], networkAccess: true }), "rule: read-only is off even when networkAccess is explicitly true, since Codex ignores the override there").toBe(false);
    expect(resolveNetworkAccess({ sandbox: "workspace-write", verifyCommands: [], networkAccess: true }), "rule: an explicit true wins over the no-verify default under workspace-write").toBe(true);
    expect(resolveNetworkAccess({ sandbox: "workspace-write", verifyCommands: ["a"], networkAccess: false }), "rule: an explicit false wins over the has-verify default under workspace-write").toBe(false);
    expect(resolveNetworkAccess({ verifyCommands: ["a"] }), "rule: an undefined sandbox behaves as workspace-write").toBe(true);
  });

  it("N3: runCodexReview passes the resolved networkAccess through codexArgs into the spawned argv", async () => {
    const withVerify = await review("ok");
    const got1 = JSON.parse(readFileSync(fake.received, "utf8"));
    expect(got1.argv.join(" "), "rule: default sandbox with a verify command passes the override").toContain(NETWORK_ACCESS_OVERRIDE);
    expect(withVerify.error, "N3 setup: the fake codex review ran without an adapter error").toBeNull();

    await review("ok", { verifyCommands: [] });
    const got2 = JSON.parse(readFileSync(fake.received, "utf8"));
    expect(got2.argv.join(" "), "rule: no verify command omits the override").not.toContain(NETWORK_ACCESS_OVERRIDE);

    await review("ok", { networkAccess: false });
    const got3 = JSON.parse(readFileSync(fake.received, "utf8"));
    expect(got3.argv.join(" "), "rule: networkAccess: false omits the override even with a verify command").not.toContain(NETWORK_ACCESS_OVERRIDE);

    await review("ok", { sandbox: "read-only" });
    const got4 = JSON.parse(readFileSync(fake.received, "utf8"));
    expect(got4.argv.join(" "), "rule: read-only sandbox omits the override even with a verify command").not.toContain(NETWORK_ACCESS_OVERRIDE);
  });
});

describe("card codex-review-effort", () => {
  it("E1: codexArgs pushes -c model_reasoning_effort=<level> after the mcp/network overrides and before the caller's configOverrides; absent adds nothing; REASONING_EFFORTS and reasoningEffortOverride are pinned", () => {
    expect(REASONING_EFFORTS, "rule: REASONING_EFFORTS is exactly the five documented levels, in order").toEqual(["minimal", "low", "medium", "high", "xhigh"]);
    expect(reasoningEffortOverride("xhigh"), "rule: reasoningEffortOverride(level) returns model_reasoning_effort=<level> verbatim").toBe("model_reasoning_effort=xhigh");

    const withIt = codexArgs({ schemaFile: "s", lastMessageFile: "l", dir: "d", effort: "low", configOverrides: ["foo=1"] });
    expect(withIt.join(" "), "rule: effort:'low' adds -c model_reasoning_effort=low").toContain("-c model_reasoning_effort=low");
    const mcpIdx = withIt.indexOf("mcp_servers={}");
    const effortIdx = withIt.indexOf("model_reasoning_effort=low");
    const fooIdx = withIt.indexOf("foo=1");
    expect(mcpIdx, "rule: the effort override is pushed after the mcp_servers={} override").toBeLessThan(effortIdx);
    expect(effortIdx, "rule: the effort override is pushed before the caller's configOverrides entries, so an explicit caller override for the same key comes later").toBeLessThan(fooIdx);

    const withAbsent = codexArgs({ schemaFile: "s", lastMessageFile: "l", dir: "d", configOverrides: ["foo=1"] });
    expect(withAbsent.join(" "), "rule: effort absent adds nothing about model_reasoning_effort").not.toContain("model_reasoning_effort");
  });

  it("E2: runCodexReview passes opts.effort into codexArgs, reaching the spawned codex argv; absent omits it (reads fake.received like N3)", async () => {
    await review("ok", { effort: "medium" });
    const got1 = JSON.parse(readFileSync(fake.received, "utf8"));
    expect(got1.argv.join(" "), "rule: effort:'medium' reaches the spawned codex argv as -c model_reasoning_effort=medium").toContain("-c model_reasoning_effort=medium");

    await review("ok", {});
    const got2 = JSON.parse(readFileSync(fake.received, "utf8"));
    expect(got2.argv.join(" "), "rule: without opts.effort the spawned argv has no model_reasoning_effort").not.toContain("model_reasoning_effort");
  });
});
