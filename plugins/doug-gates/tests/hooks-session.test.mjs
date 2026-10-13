import { describe, it, expect } from "vitest";
import { writeFileSync, appendFileSync, mkdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { makeProject, runHookScript, context } from "./helpers.mjs";
import { splitSnapshot, SNAPSHOT_START, SNAPSHOT_END } from "../lib/anchor.mjs";
import { baseConfig } from "./hooks-fixtures.mjs";

describe("checkpoint-on-green", () => {
  const git = (dir, ...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
  function repo(checkpoint, config = baseConfig) {
    const dir = makeProject({ config: { ...config, checkpoint }, git: true });
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src/a.ts"), "export const a = 1");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "base");
    writeFileSync(join(dir, "src/a.ts"), "export const a = 2");
    writeFileSync(join(dir, "src/b.ts"), "export const b = 1");
    return dir;
  }
  it("is off by default: a green gate leaves the repo alone", () => {
    const dir = repo(undefined);
    expect(runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir }).json).toBeNull();
    expect(git(dir, "rev-list", "--count", "HEAD")).toBe("1");
  });
  it("commit mode records a checkpoint commit on the current branch when the gate passes", () => {
    const dir = repo({ enabled: true, mode: "commit" });
    mkdirSync(join(dir, ".claude/worktrees/wf_1"), { recursive: true });
    writeFileSync(join(dir, ".claude/worktrees/wf_1/junk.ts"), "");
    const r = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
    expect(r.json.decision).toBeUndefined();
    expect(r.json.systemMessage).toMatch(/Checkpoint committed as [0-9a-f]{7,} on main\./);
    expect(git(dir, "rev-list", "--count", "HEAD")).toBe("2");
    expect(git(dir, "log", "-1", "--format=%B")).toContain("doug: checkpoint\n\ngate: test ok");
    expect(git(dir, "ls-tree", "-r", "--name-only", "HEAD").split("\n").sort()).toEqual([".doug/config.json", "src/a.ts", "src/b.ts"]);
    expect(git(dir, "status", "--porcelain", "--untracked-files=all").split("\n").map((l) => l.trim()).sort()).toEqual(["?? .claude/worktrees/wf_1/junk.ts", "?? .doug/.state/test-session.json", "?? .doug/.state/trace/test-session.jsonl", "?? .doug/.state/verified-tree.json"]);
    const state = JSON.parse(readFileSync(join(dir, ".doug/.state/test-session.json"), "utf8"));
    expect(state.lastCheckpoint.mode).toBe("commit");
    expect(state.lastCheckpoint.ref).toBe("main");
    // A second green stop with the state file present (no .gitignore here) must not commit the state dir.
    writeFileSync(join(dir, "src/b.ts"), "export const b = 2");
    runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
    expect(git(dir, "rev-list", "--count", "HEAD")).toBe("3");
    expect(git(dir, "ls-tree", "-r", "--name-only", "HEAD")).not.toContain(".doug/.state");
  });
  it("tag mode tags a commit built from a temporary index and touches nothing else", () => {
    const dir = repo({ enabled: true, mode: "tag" });
    const head = git(dir, "rev-parse", "HEAD");
    const r = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
    expect(r.json.systemMessage).toMatch(/Checkpoint tagged doug\/checkpoint\/\d{8}T\d{6}Z \([0-9a-f]{7}\)/);
    expect(r.json.systemMessage).toContain("git checkout doug/checkpoint/");
    const tags = git(dir, "tag", "-l", "doug/checkpoint/*").split("\n").filter(Boolean);
    expect(tags).toHaveLength(1);
    expect(git(dir, "rev-parse", "HEAD")).toBe(head);
    expect(git(dir, "rev-parse", `${tags[0]}^`)).toBe(head);
    expect(git(dir, "ls-tree", "-r", "--name-only", tags[0])).toContain("src/b.ts");
    expect(git(dir, "show", `${tags[0]}:src/a.ts`)).toBe("export const a = 2");
    expect(git(dir, "diff", "--cached", "--name-only")).toBe(""); // real index untouched
    expect(git(dir, "status", "--porcelain").split("\n").map((l) => l.trim()).sort()).toEqual(["?? .doug/.state/", "?? src/b.ts", "M src/a.ts"]);
  });
  it("never runs while a protected path is dirty, even one the Stop scan ignores", () => {
    const dir = repo({ enabled: true, mode: "commit" }, { ...baseConfig, stopGate: { ...baseConfig.stopGate, ignoreChangedPaths: ["pnpm-lock.yaml"] } });
    writeFileSync(join(dir, "pnpm-lock.yaml"), "lockfileVersion: 9");
    const r = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
    expect(r.json.decision).toBeUndefined();
    expect(r.json.systemMessage).toContain("Checkpoint skipped: protected path dirty: pnpm-lock.yaml");
    expect(git(dir, "rev-list", "--count", "HEAD")).toBe("1");
  });
  it("does not checkpoint a failing gate and reports a bad mode instead of guessing", () => {
    const failing = repo({ enabled: true, mode: "commit" }, { ...baseConfig, commands: { test: "exit 1" } });
    expect(runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir: failing }).json.decision).toBe("block");
    expect(git(failing, "rev-list", "--count", "HEAD")).toBe("1");
    const bad = repo({ enabled: true, mode: "stash" });
    const r = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir: bad });
    expect(r.json.systemMessage).toContain("Checkpoint failed: checkpoint.mode must be one of commit, tag");
    expect(git(bad, "rev-list", "--count", "HEAD")).toBe("1");
  });
});

describe("reanchor", () => {
  it("emits anchor lines, commands, and the anchor file", () => {
    const dir = makeProject({ config: baseConfig });
    writeFileSync(join(dir, ".doug/anchor.md"), "Task: implement X. Owned files: src/x.ts");
    const r = runHookScript("reanchor", { hook_event_name: "SessionStart", source: "compact" }, { dir });
    const ctx = context(r);
    expect(ctx).toContain("Use pnpm, never npm.");
    expect(ctx).toContain("test: node -e");
    expect(ctx).toContain("Owned files: src/x.ts");
    expect(r.json.hookSpecificOutput.hookEventName).toBe("SessionStart");
  });
  it("puts the compaction snapshot first, ahead of the 4000-char cap, when the anchor's hand-written head is long", () => {
    const dir = makeProject({ config: baseConfig });
    const head = "# Old task\n\n" + "x".repeat(4200) + "\n";
    const section = "## Compaction snapshot (doug, 2026-09-09T19:21:42.000Z)\n\nPlan: none in .doug/plan.json";
    const block = `${SNAPSHOT_START}\n${section}\n${SNAPSHOT_END}\n`;
    writeFileSync(join(dir, ".doug/anchor.md"), head + "\n" + block);
    const r = runHookScript("reanchor", { hook_event_name: "SessionStart", source: "compact" }, { dir });
    const ctx = context(r);
    expect(ctx).toContain("Compaction snapshot (doug");
    expect(ctx.indexOf("Compaction snapshot (doug")).toBeLessThan(4000);
  });
  it("PostCompact emits no output at all, even with an anchor and config present", () => {
    const dir = makeProject({ config: baseConfig });
    writeFileSync(join(dir, ".doug/anchor.md"), "Task: implement X. Owned files: src/x.ts");
    const r = runHookScript("reanchor", { hook_event_name: "PostCompact" }, { dir });
    expect(r.status).toBe(0);
    expect(r.json).toBeNull();
    const empty = makeProject({ config: { anchor: [], commands: {} } });
    expect(runHookScript("reanchor", { hook_event_name: "PostCompact" }, { dir: empty }).json).toBeNull();
  });
  it("(ix) clears state.context on PostCompact (card context-window-handoff)", () => {
    const dir = makeProject({ config: { ...baseConfig, contextWindow: { enabled: true, threshold: 80, repeatAfter: 5 } } });
    mkdirSync(join(dir, ".doug/.state"), { recursive: true });
    writeFileSync(join(dir, ".doug/.state/test-session.json"), JSON.stringify({ context: { pct: 90, at: new Date().toISOString(), notifiedAt: 90 } }));
    const r = runHookScript("reanchor", { hook_event_name: "PostCompact" }, { dir });
    expect(r.json).toBeNull();
    const state = JSON.parse(readFileSync(join(dir, ".doug/.state/test-session.json"), "utf8"));
    expect(state.context).toBeUndefined();
  });
});

describe("splitSnapshot (lib/anchor.mjs)", () => {
  it("extracts the snapshot block and the rest, in original order", () => {
    const rest = "# Head\n\nHand notes.\n";
    const section = "## Compaction snapshot (doug, now)\n\nPlan: none";
    const text = rest + "\n" + SNAPSHOT_START + "\n" + section + "\n" + SNAPSHOT_END + "\n";
    const { snapshot, rest: r } = splitSnapshot(text);
    expect(snapshot).toContain(section);
    expect(snapshot.startsWith(SNAPSHOT_START)).toBe(true);
    expect(snapshot.endsWith(SNAPSHOT_END)).toBe(true);
    expect(r.trim()).toBe(rest.trim());
  });
  it("returns a null snapshot and the whole text as rest when there is no snapshot section", () => {
    const text = "just hand-written notes";
    const { snapshot, rest } = splitSnapshot(text);
    expect(snapshot).toBeNull();
    expect(rest).toBe(text);
  });
});

describe("reanchor on PreCompact (card precompact-anchor)", () => {
  it("snapshots the plan, ownership, decisions, edited files, and recent commands into the anchor, keeps the rest, and tells the user", () => {
    const dir = makeProject({ config: baseConfig });
    writeFileSync(join(dir, ".doug/plan.json"), JSON.stringify({ version: 1, title: "Fix hours", status: "approved", card: "fix-hours", tasks: [{ id: "fix", files: ["src/duration.ts", "tests/duration.test.ts"] }] }));
    mkdirSync(join(dir, "docs/decisions"), { recursive: true });
    writeFileSync(join(dir, "docs/decisions/0001-x.md"), "# x");
    writeFileSync(join(dir, "docs/decisions/notes.txt"), "not a decision");
    writeFileSync(join(dir, ".doug/anchor.md"), "# Fix hours\n\nMy own notes stay.\n");
    runHookScript("edit-loop", { tool_name: "Edit", tool_input: { file_path: "src/duration.ts" } }, { dir });
    runHookScript("guard-bash", { tool_name: "Bash", tool_input: { command: "pnpm test" } }, { dir });
    const r = runHookScript("reanchor", { hook_event_name: "PreCompact", compaction_trigger: "auto", estimated_tokens_before: 150000, estimated_tokens_after: 20000 }, { dir });
    expect(r.status).toBe(0);
    expect(r.json.hookSpecificOutput).toBeUndefined();
    expect(r.json.systemMessage).toContain("Compacting");
    expect(r.json.systemMessage).toContain(".doug/anchor.md");
    expect(r.json.systemMessage).toContain("re-injects it after compaction");
    expect(r.json.systemMessage).not.toMatch(/150000|20000|estimat/);
    const anchor = readFileSync(join(dir, ".doug/anchor.md"), "utf8");
    expect(anchor.startsWith("# Fix hours\n\nMy own notes stay.\n\n<!-- doug:compaction-snapshot start -->\n## Compaction snapshot (doug, ")).toBe(true);
    expect(anchor).toContain("Plan: Fix hours [approved] (card fix-hours)");
    expect(anchor).toContain("- fix owns src/duration.ts, tests/duration.test.ts");
    expect(anchor).toContain("Decisions (docs/decisions): 0001-x.md");
    expect(anchor).toContain("Edited this session: src/duration.ts");
    expect(anchor).toContain("Recent commands:\n- pnpm test");
    expect(anchor.endsWith("<!-- doug:compaction-snapshot end -->\n")).toBe(true);
    expect(anchor).not.toMatch(/150000|estimat/);
    // A second compaction replaces the section instead of stacking another one.
    runHookScript("guard-bash", { tool_name: "Bash", tool_input: { command: "pnpm typecheck" } }, { dir });
    runHookScript("reanchor", { hook_event_name: "PreCompact" }, { dir });
    const again = readFileSync(join(dir, ".doug/anchor.md"), "utf8");
    expect(again.split("compaction-snapshot start").length).toBe(2);
    expect(again).toContain("- pnpm typecheck");
    expect(again.startsWith("# Fix hours\n\nMy own notes stay.\n\n")).toBe(true);
    // PostCompact emits nothing; SessionStart(compact) carries the snapshot, reordered ahead of the hand-written text.
    const post = runHookScript("reanchor", { hook_event_name: "PostCompact" }, { dir });
    expect(post.json).toBeNull();
    const sessionStart = context(runHookScript("reanchor", { hook_event_name: "SessionStart", source: "compact" }, { dir }));
    expect(sessionStart).toContain("Compaction snapshot (doug");
    expect(sessionStart.indexOf("Compaction snapshot (doug")).toBeLessThan(sessionStart.indexOf("My own notes stay"));
  });
  it("S04 with no .doug/plan.json, the snapshot prints one Plan block per active per-card plan and skips landed ones (card parallel-card-queens)", () => {
    const dir = makeProject({ config: baseConfig });
    mkdirSync(join(dir, ".doug/plans"), { recursive: true });
    writeFileSync(join(dir, ".doug/plans/a.json"), JSON.stringify({ version: 1, title: "Card A", status: "approved", card: "card-a", tasks: [{ id: "ta", files: ["src/a.ts"] }] }));
    writeFileSync(join(dir, ".doug/plans/b.json"), JSON.stringify({ version: 1, title: "Card B", status: "approved", card: "card-b", tasks: [{ id: "tb", files: ["src/b.ts", "tests/b.test.ts"] }] }));
    writeFileSync(join(dir, ".doug/plans/old.json"), JSON.stringify({ version: 1, title: "Card Old", status: "done", card: "card-old", landed: { at: "2026-09-04T16:00:00.000Z", mergeCommit: "abc1234" }, tasks: [{ id: "to", files: ["src/old.ts"] }] }));
    writeFileSync(join(dir, ".doug/plans/bad.json"), "{ nope");
    const r = runHookScript("reanchor", { hook_event_name: "PreCompact" }, { dir });
    expect(r.status).toBe(0);
    const anchor = readFileSync(join(dir, ".doug/anchor.md"), "utf8");
    expect(anchor).toContain("Plan: Card A [approved] (card card-a)");
    expect(anchor).toContain("- ta owns src/a.ts");
    expect(anchor).toContain("Plan: Card B [approved] (card card-b)");
    expect(anchor).toContain("- tb owns src/b.ts, tests/b.test.ts");
    expect(anchor).not.toContain("Card Old");
    expect(anchor).not.toContain("Plan: none");
  });
  it("S04b a corrupt per-card file sorted ahead of good ones is skipped; the good ones still print (fix pass)", () => {
    const dir = makeProject({ config: baseConfig });
    mkdirSync(join(dir, ".doug/plans"), { recursive: true });
    writeFileSync(join(dir, ".doug/plans/0-bad.json"), "{ nope");
    writeFileSync(join(dir, ".doug/plans/a.json"), JSON.stringify({ version: 1, title: "Card A", status: "approved", card: "card-a", tasks: [{ id: "ta", files: ["src/a.ts"] }] }));
    writeFileSync(join(dir, ".doug/plans/b.json"), JSON.stringify({ version: 1, title: "Card B", status: "approved", card: "card-b", tasks: [{ id: "tb", files: ["src/b.ts"] }] }));
    runHookScript("reanchor", { hook_event_name: "PreCompact" }, { dir });
    const anchor = readFileSync(join(dir, ".doug/anchor.md"), "utf8");
    expect(anchor).toContain("Plan: Card A [approved] (card card-a)");
    expect(anchor).toContain("Plan: Card B [approved] (card card-b)");
  });
  it("creates the anchor when there is none and says so when there is no plan or decisions", () => {
    const dir = makeProject({ config: baseConfig });
    runHookScript("reanchor", { hook_event_name: "PreCompact" }, { dir });
    const anchor = readFileSync(join(dir, ".doug/anchor.md"), "utf8");
    expect(anchor.startsWith("<!-- doug:compaction-snapshot start -->")).toBe(true);
    expect(anchor).toContain("Plan: none in .doug/plan.json");
    expect(anchor).toContain("Decisions: none under docs/decisions");
    expect(anchor).toContain("Edited this session: nothing yet");
    expect(anchor).toContain("Recent commands: none");
  });

  it("(a) trigger manual, with a recorded gate and context pct, carries them into the Handoff boundary block (card precompact-keeps-handoff)", () => {
    const dir = makeProject({ config: baseConfig, git: true });
    writeFileSync(join(dir, "a.txt"), "x");
    execFileSync("git", ["add", "-A"], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", "base"], { cwd: dir });
    mkdirSync(join(dir, ".doug/.state"), { recursive: true });
    const at = Date.now();
    writeFileSync(join(dir, ".doug/.state/test-session.json"), JSON.stringify({ lastGate: { ok: true, at }, context: { pct: 85 } }));
    const r = runHookScript("reanchor", { hook_event_name: "PreCompact", trigger: "manual" }, { dir });
    expect(r.status).toBe(0);
    expect(r.json.hookSpecificOutput).toBeUndefined();
    const anchor = readFileSync(join(dir, ".doug/anchor.md"), "utf8");
    expect(anchor).toContain("### Handoff boundary");
    expect(anchor).toContain("Boundary: compaction (manual)");
    expect(anchor).toMatch(/Gate: green \(at \d{4}-\d{2}-\d{2}T/);
    expect(anchor).toMatch(/HEAD: [0-9a-f]{7,} \(main\)/);
    expect(anchor).toContain("Context: 85%");
  });

  it("(b) trigger auto, no lastGate, no context, outside a git repo: no Gate line, HEAD unknown, no Context line", () => {
    const dir = makeProject({ config: baseConfig });
    const r = runHookScript("reanchor", { hook_event_name: "PreCompact", trigger: "auto" }, { dir });
    expect(r.status).toBe(0);
    const anchor = readFileSync(join(dir, ".doug/anchor.md"), "utf8");
    expect(anchor).toContain("### Handoff boundary");
    expect(anchor).toContain("Boundary: compaction (auto)");
    expect(anchor).not.toContain("Gate:");
    expect(anchor).toContain("HEAD: unknown");
    expect(anchor).not.toContain("Context:");
  });

  it("(c) an absent trigger counts as auto", () => {
    const dir = makeProject({ config: baseConfig });
    const r = runHookScript("reanchor", { hook_event_name: "PreCompact" }, { dir });
    expect(r.status).toBe(0);
    const anchor = readFileSync(join(dir, ".doug/anchor.md"), "utf8");
    expect(anchor).toContain("Boundary: compaction (auto)");
  });

  it("(d) a green Stop's handoff survives a following PreCompact, now under the compaction boundary", () => {
    const contextConfig = { ...baseConfig, contextWindow: { enabled: true, threshold: 80, repeatAfter: 5 } };
    const dir = makeProject({ config: contextConfig, git: true });
    execFileSync("git", ["add", "-A"], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", "base"], { cwd: dir });
    runHookScript("statusline", { context_window: { used_percentage: 85 } }, { dir });
    runHookScript("edit-loop", { tool_name: "Edit", tool_input: { file_path: "a.ts" } }, { dir }); // verification passes: state.lastGate gets set
    const stop = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
    expect(stop.json.systemMessage).toContain("Context at 85%");
    const afterStop = readFileSync(join(dir, ".doug/anchor.md"), "utf8");
    expect(afterStop).toContain("Boundary: verification passed");
    expect(afterStop).toContain("Gate: green");

    const pre = runHookScript("reanchor", { hook_event_name: "PreCompact", trigger: "auto" }, { dir });
    expect(pre.status).toBe(0);
    const anchor = readFileSync(join(dir, ".doug/anchor.md"), "utf8");
    expect(anchor).toContain("Boundary: compaction (auto)");
    expect(anchor).toContain("Gate: green");
    expect(anchor).toMatch(/HEAD: [0-9a-f]{7,}/);
  });

  it("(e) the handoff block sits near the top, so it survives the SessionStart 4000-char cap on a long session (review MAJOR)", () => {
    const dir = makeProject({ config: baseConfig, git: true });
    execFileSync("git", ["add", "-A"], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", "base"], { cwd: dir });
    mkdirSync(join(dir, ".doug/.state"), { recursive: true });
    const editedFiles = Array.from({ length: 150 }, (_, i) => `plugins/doug-gates/tests/fixtures/some-very-long-nested-directory-name/file-${i}.ts`);
    writeFileSync(join(dir, ".doug/.state/test-session.json"), JSON.stringify({ editedFiles, lastGate: { ok: true, at: Date.now() } }));
    const pre = runHookScript("reanchor", { hook_event_name: "PreCompact", trigger: "auto" }, { dir });
    expect(pre.status).toBe(0);
    const anchor = readFileSync(join(dir, ".doug/anchor.md"), "utf8");
    const { snapshot } = splitSnapshot(anchor);
    expect(snapshot.length).toBeGreaterThan(4000); // the scenario actually exercises the cap below
    const r = runHookScript("reanchor", { hook_event_name: "SessionStart", source: "compact" }, { dir });
    const ctx = context(r);
    expect(ctx).toContain("Gate: green");
    expect(ctx).toMatch(/HEAD: [0-9a-f]{7,}/);
  });

  it("(f) a non-numeric gate.at still writes the snapshot, with Gate: green and no '(at' (review MINOR 1)", () => {
    const dir = makeProject({ config: baseConfig });
    mkdirSync(join(dir, ".doug/.state"), { recursive: true });
    writeFileSync(join(dir, ".doug/.state/test-session.json"), JSON.stringify({ lastGate: { ok: true, at: "not-a-date" } }));
    const r = runHookScript("reanchor", { hook_event_name: "PreCompact", trigger: "auto" }, { dir });
    expect(r.status).toBe(0);
    const anchor = readFileSync(join(dir, ".doug/anchor.md"), "utf8");
    expect(anchor).toContain("Gate: green");
    expect(anchor).not.toContain("(at");
  });
});

describe("robustness", () => {
  it("fails open with a visible message on garbage input", () => {
    const dir = makeProject({ config: baseConfig });
    const res = runHookScript("protect-paths", { tool_input: { file_path: 42 } }, { dir });
    expect(res.status).toBe(0);
  });
  it("state dir is created under .doug/.state", () => {
    const dir = makeProject({ config: baseConfig });
    runHookScript("edit-loop", { tool_name: "Edit", tool_input: { file_path: "a.ts" } }, { dir });
    expect(existsSync(join(dir, ".doug/.state"))).toBe(true);
  });
});

describe("trace", () => {
  it("appends one line per event, prints no decision, and reads a subagent's tokens from its transcript at SubagentStop", () => {
    const dir = makeProject({ config: baseConfig });
    const transcript = join(dir, "agent.jsonl");
    writeFileSync(transcript, JSON.stringify({ type: "assistant", message: { id: "m1", model: "claude-haiku-4-5", usage: { input_tokens: 5, output_tokens: 9 } } }) + "\n");
    const events = [
      { hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "t1", tool_input: { command: "pnpm test" } },
      { hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: "t1", tool_input: { command: "pnpm test" }, tool_response: { stdout: "ok" } },
      { hook_event_name: "SubagentStart", agent_id: "ag1", agent_type: "Explore" },
      { hook_event_name: "PreToolUse", agent_id: "ag1", agent_type: "Explore", tool_name: "Grep", tool_use_id: "t2", tool_input: { pattern: "x" } },
      { hook_event_name: "SubagentStop", agent_id: "ag1", agent_type: "Explore", agent_transcript_path: transcript, tool_use_id: "t3" },
    ];
    for (const e of events) {
      const r = runHookScript("trace", e, { dir });
      expect(r.status).toBe(0);
      expect(r.json).toBeNull();
      expect(r.stdout.trim()).toBe("");
    }
    const file = join(dir, ".doug/.state/trace/test-session.jsonl");
    expect(existsSync(file)).toBe(true);
    const lines = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.map((l) => l.event)).toEqual(["PreToolUse", "PostToolUse", "SubagentStart", "PreToolUse", "SubagentStop"]);
    expect(lines[0]).toMatchObject({ session: "test-session", agent: null, tool: "Bash", toolUseId: "t1", detail: "pnpm test", ok: null, tokens: null });
    expect(lines[1].ok).toBe(true);
    expect(lines[3]).toMatchObject({ agent: "ag1", agentType: "Explore", tool: "Grep", detail: "x" });
    expect(lines[4].tokens).toEqual({ input: 5, output: 9, cacheRead: 0, cacheWrite: 0, messages: 1, model: "claude-haiku-4-5" });
    for (const l of lines) expect(typeof l.t).toBe("string");
  });
  it("writes nothing when trace.enabled is false, and records null tokens when the transcript is missing", () => {
    const off = makeProject({ config: { ...baseConfig, trace: { enabled: false } } });
    runHookScript("trace", { hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: "a" } }, { dir: off });
    expect(existsSync(join(off, ".doug/.state/trace"))).toBe(false);
    const on = makeProject({ config: baseConfig });
    runHookScript("trace", { hook_event_name: "SubagentStop", agent_id: "ag2", agent_type: "coder", agent_transcript_path: join(on, "missing.jsonl") }, { dir: on });
    const [line] = readFileSync(join(on, ".doug/.state/trace/test-session.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(line).toMatchObject({ event: "SubagentStop", agent: "ag2", agentType: "coder", tokens: null });
  });

  it("traces InstructionsLoaded path-only (never file_content) and PermissionDenied with its reason, allowing both (card learn-signals)", () => {
    const dir = makeProject({ config: baseConfig });
    const loaded = runHookScript(
      "trace",
      { hook_event_name: "InstructionsLoaded", file_path: "/p/CLAUDE.md", load_reason: "session_start", file_content: "# secret prose that must never be traced" },
      { dir }
    );
    expect(loaded.status).toBe(0);
    expect(loaded.json).toBeNull();
    const denied = runHookScript(
      "trace",
      { hook_event_name: "PermissionDenied", tool_name: "Bash", tool_input: { command: "pnpm test" }, denial_reason: "auto mode denied" },
      { dir }
    );
    expect(denied.status).toBe(0);
    expect(denied.json).toBeNull();
    const raw = readFileSync(join(dir, ".doug/.state/trace/test-session.jsonl"), "utf8");
    expect(raw).not.toContain("secret prose");
    const [loadedLine, deniedLine] = raw.trim().split("\n").map((l) => JSON.parse(l));
    expect(loadedLine).toMatchObject({ event: "InstructionsLoaded", detail: "/p/CLAUDE.md", reason: "session_start" });
    expect(deniedLine).toMatchObject({ event: "PermissionDenied", tool: "Bash", detail: "pnpm test", ok: false, reason: "auto mode denied" });
  });

  describe("worker context handoff (card worker-context-handoff, brief A)", () => {
    const contextConfig = { ...baseConfig, contextWindow: { enabled: true, threshold: 80, repeatAfter: 5 } };
    // The documented layout (research note): <dirname of transcript_path>/<session_id>/subagents/agent-<id>.jsonl.
    // session_id defaults to "test-session" (helpers.mjs runHookScript).
    function subagentPaths(dir) {
      return { transcriptPath: join(dir, "proj", "main.jsonl"), derived: join(dir, "proj", "test-session", "subagents", "agent-ag1.jsonl") };
    }
    // Appends a new assistant line, the way a real transcript grows (contextReading reads the LAST one): a
    // second call always leaves the file strictly larger than the first, never coincidentally the same size.
    function seedTokens(file, tokens, model = "claude-sonnet-5") {
      mkdirSync(dirname(file), { recursive: true });
      appendFileSync(file, JSON.stringify({ type: "assistant", message: { model, usage: { input_tokens: tokens } } }) + "\n");
    }
    function post(dir, transcriptPath) {
      return runHookScript("trace", { hook_event_name: "PostToolUse", agent_id: "ag1", agent_type: "coder", transcript_path: transcriptPath, tool_name: "Edit", tool_input: { file_path: "a.ts" } }, { dir });
    }

    it("(a) records a reading below threshold, prints no notice, and carries the pct on the trace line (minor 6)", () => {
      const dir = makeProject({ config: contextConfig });
      const { transcriptPath, derived } = subagentPaths(dir);
      seedTokens(derived, 500000); // 50% of the 1M sonnet-5 window
      const r = post(dir, transcriptPath);
      expect(r.json).toBeNull();
      const state = JSON.parse(readFileSync(join(dir, ".doug/.state/test-session.json"), "utf8"));
      expect(state.agents.ag1.context).toMatchObject({ pct: 50, tokens: 500000, window: 1000000, model: "claude-sonnet-5" });
      const [line] = readFileSync(join(dir, ".doug/.state/trace/test-session.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
      expect(line.context).toBe(50);
    });

    it("(b) notices at or above threshold via additionalContext once, then again only after repeatAfter growth", () => {
      const dir = makeProject({ config: contextConfig });
      const { transcriptPath, derived } = subagentPaths(dir);
      seedTokens(derived, 800000); // 80%
      const first = post(dir, transcriptPath);
      expect(context(first)).toBe("[doug] Worker context at 80% of 1000000 tokens (threshold 80). Finish the file you are on and its named test, commit, then return partial=true with a handoff (completed, remaining, next, verify). Do not start another file.");

      seedTokens(derived, 840000); // 84%: below notifiedAt(80) + repeatAfter(5)
      const second = post(dir, transcriptPath);
      expect(context(second)).toBeNull();

      seedTokens(derived, 850000); // 85%: at notifiedAt + repeatAfter
      const third = post(dir, transcriptPath);
      expect(context(third)).toContain("Worker context at 85%");
    });

    it("(c) without agent_id, nothing is recorded — even with a transcript_path that would resolve to a real file (minor 7: the agent_id guard, not a missing path, is what stops it)", () => {
      const dir = makeProject({ config: contextConfig });
      const { transcriptPath } = subagentPaths(dir);
      // What "agent-undefined.jsonl" would derive to, were the `!input.agent_id` guard not there: a real,
      // readable transcript with real usage — so a regression that dropped the guard would show up here.
      seedTokens(join(dir, "proj", "test-session", "subagents", "agent-undefined.jsonl"), 900000);
      const r = runHookScript("trace", { hook_event_name: "PostToolUse", transcript_path: transcriptPath, tool_name: "Edit", tool_input: { file_path: "a.ts" } }, { dir });
      expect(r.json).toBeNull();
      expect(existsSync(join(dir, ".doug/.state/test-session.json"))).toBe(false);
    });

    it("(d) does nothing when contextWindow is disabled, even with agent_id and a real transcript", () => {
      const dir = makeProject({ config: baseConfig }); // contextWindow defaults disabled
      const { transcriptPath, derived } = subagentPaths(dir);
      seedTokens(derived, 900000);
      const r = post(dir, transcriptPath);
      expect(r.json).toBeNull();
      expect(existsSync(join(dir, ".doug/.state/test-session.json"))).toBe(false);
    });

    it("(e) a missing transcript records nothing but still appends the trace line, with context null", () => {
      const dir = makeProject({ config: contextConfig });
      const { transcriptPath } = subagentPaths(dir);
      const r = post(dir, transcriptPath);
      expect(r.json).toBeNull();
      expect(existsSync(join(dir, ".doug/.state/test-session.json"))).toBe(false);
      const [line] = readFileSync(join(dir, ".doug/.state/trace/test-session.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
      expect(line).toMatchObject({ event: "PostToolUse", agent: "ag1", context: null });
    });

    it("(minor 4) skips re-reading an unchanged transcript, by its cached byte size, recording nothing new", () => {
      const dir = makeProject({ config: contextConfig });
      const { transcriptPath, derived } = subagentPaths(dir);
      seedTokens(derived, 500000);
      const first = post(dir, transcriptPath);
      expect(first.json).toBeNull();
      const after1 = JSON.parse(readFileSync(join(dir, ".doug/.state/test-session.json"), "utf8"));
      expect(after1.agents.ag1.context).toMatchObject({ pct: 50, size: expect.any(Number) });

      // Same file, byte-for-byte: a second PostToolUse must not re-read it or touch the recorded entry at all.
      const second = post(dir, transcriptPath);
      expect(second.json).toBeNull();
      const after2 = JSON.parse(readFileSync(join(dir, ".doug/.state/test-session.json"), "utf8"));
      expect(after2.agents.ag1.context).toEqual(after1.agents.ag1.context);

      // The file did grow: the next PostToolUse reads it again and the entry changes.
      seedTokens(derived, 600000);
      const third = post(dir, transcriptPath);
      expect(third.json).toBeNull();
      const after3 = JSON.parse(readFileSync(join(dir, ".doug/.state/test-session.json"), "utf8"));
      expect(after3.agents.ag1.context.pct).toBe(60);
    });

    it("(major 2) reloads state immediately before saving and merges only this agent's entry, so a sibling agentBlocks bump and an edit-loop counter survive", () => {
      const dir = makeProject({ config: contextConfig });
      const { transcriptPath, derived } = subagentPaths(dir);
      seedTokens(derived, 500000);
      runHookScript("edit-loop", { tool_name: "Edit", tool_input: { file_path: "a.ts" } }, { dir });
      // Something else touched the same state file before this PostToolUse's own write: a SubagentStop block
      // count trace.mjs never looks at.
      const before = JSON.parse(readFileSync(join(dir, ".doug/.state/test-session.json"), "utf8"));
      before.agentBlocks = { x: 2 };
      writeFileSync(join(dir, ".doug/.state/test-session.json"), JSON.stringify(before));

      const r = post(dir, transcriptPath);
      expect(r.json).toBeNull();
      const state = JSON.parse(readFileSync(join(dir, ".doug/.state/test-session.json"), "utf8"));
      expect(state.agentBlocks).toEqual({ x: 2 });
      expect(state.editedFiles).toEqual(["a.ts"]);
      expect(state.agents.ag1.context).toMatchObject({ pct: 50 });
    });
  });
});

describe("verification evidence", () => {
  const withEvidence = { ...baseConfig, stopGate: { ...baseConfig.stopGate, requireEvidence: true } };
  it("guard-bash records the commands it lets through, not the ones it denies", () => {
    const dir = makeProject({ config: withEvidence });
    runHookScript("guard-bash", { tool_name: "Bash", tool_input: { command: "ls   -la\n" } }, { dir });
    runHookScript("guard-bash", { tool_name: "Bash", tool_input: { command: "npm install left-pad" } }, { dir });
    runHookScript("guard-bash", { tool_name: "Bash", tool_input: { command: "x".repeat(300) } }, { dir });
    const state = JSON.parse(readFileSync(join(dir, ".doug/.state/test-session.json"), "utf8"));
    expect(state.commands).toHaveLength(2);
    expect(state.commands[0]).toBe("ls -la");
    expect(state.commands[1]).toHaveLength(200);
  });
  it("blocks a green gate when the session never ran a test or verify command, and allows once it has", () => {
    const dir = makeProject({ config: withEvidence, git: true });
    runHookScript("edit-loop", { tool_name: "Edit", tool_input: { file_path: "a.ts" } }, { dir });
    runHookScript("guard-bash", { tool_name: "Bash", tool_input: { command: "ls -la" } }, { dir });
    const never = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
    expect(never.json.decision).toBe("block");
    expect(never.json.reason).toContain("No test or verify command ran in this session");
    expect(never.json.reason).toContain('`node -e "process.exit(0)"`');
    expect(never.json.reason).toContain("(1/3)");
    runHookScript("guard-bash", { tool_name: "Bash", tool_input: { command: "pnpm exec vitest run tests/a.test.ts" } }, { dir });
    const ran = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
    expect(ran.json).toBeNull();
    const state = JSON.parse(readFileSync(join(dir, ".doug/.state/test-session.json"), "utf8"));
    expect(state.lastGate.ok).toBe(true);
    expect(state.lastGate.evidence.ran).toEqual(["pnpm exec vitest run tests/a.test.ts"]);
    expect(state.stopBlocks).toBe(0);
  });
  it("tells ran-and-failed apart from never-ran", () => {
    const failing = { ...withEvidence, commands: { test: "echo FAIL-OUTPUT; exit 1" } };
    const dir = makeProject({ config: failing, git: true });
    runHookScript("edit-loop", { tool_name: "Edit", tool_input: { file_path: "a.ts" } }, { dir });
    const never = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
    expect(never.json.reason).toContain("FAIL-OUTPUT");
    expect(never.json.reason).toContain("never ran a test or verify command itself");
    runHookScript("guard-bash", { tool_name: "Bash", tool_input: { command: "echo FAIL-OUTPUT; exit 1" } }, { dir });
    const ran = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
    expect(ran.json.decision).toBe("block");
    expect(ran.json.reason).toContain("FAIL-OUTPUT");
    expect(ran.json.reason).not.toContain("never ran");
  });
  it("counts a gate command by name, any other configured command, or an evidencePatterns match, and is off with requireEvidence false", () => {
    const cfg = { ...withEvidence, commands: { test: 'node -e "process.exit(0)"', typecheck: "my-typecheck --strict", install: "pnpm install" }, stopGate: { ...withEvidence.stopGate, evidencePatterns: ["^just\\s+verify"] } };
    for (const [command, ok] of [["my-typecheck --strict", true], ["just verify all", true], ["pnpm install", false], ["cat README.md", false]]) {
      const dir = makeProject({ config: cfg, git: true });
      runHookScript("edit-loop", { tool_name: "Edit", tool_input: { file_path: "a.ts" } }, { dir });
      runHookScript("guard-bash", { tool_name: "Bash", tool_input: { command } }, { dir });
      const r = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
      expect(r.json === null, command).toBe(ok);
    }
    const off = makeProject({ config: baseConfig, git: true });
    runHookScript("edit-loop", { tool_name: "Edit", tool_input: { file_path: "a.ts" } }, { dir: off });
    expect(runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir: off }).json).toBeNull();
  });
});

describe("SubagentStop gate (card task-completed-gate)", () => {
  const git = (dir, ...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
  it("blocks a subagent from reporting done while verification fails, with its own counter and cap", () => {
    const dir = makeProject({ config: { ...baseConfig, commands: { test: "echo FAIL-OUTPUT; exit 1" }, stopGate: { ...baseConfig.stopGate, maxBlocks: 2 } }, git: true });
    runHookScript("edit-loop", { tool_name: "Edit", tool_input: { file_path: "a.ts" }, agent_id: "ag1", agent_type: "coder" }, { dir });
    const sub = { hook_event_name: "SubagentStop", agent_id: "ag1", agent_type: "coder", agent_transcript_path: "/nope" };
    const r1 = runHookScript("stop-gate", sub, { dir });
    expect(r1.json.decision).toBe("block");
    expect(r1.json.reason).toContain("Subagent coder (ag1) cannot report done: verification failed (1/2)");
    expect(r1.json.reason).toContain("FAIL-OUTPUT");
    expect(runHookScript("stop-gate", sub, { dir }).json.reason).toContain("(2/2)");
    const r3 = runHookScript("stop-gate", sub, { dir });
    expect(r3.json.decision).toBeUndefined();
    expect(r3.json.systemMessage).toContain("Subagent coder (ag1) was blocked 2 times and the gate is standing down for it");
    // Another subagent and the session's own Stop start from zero.
    expect(runHookScript("stop-gate", { ...sub, agent_id: "ag2" }, { dir }).json.reason).toContain("(1/2)");
    // Card stop-gate-lead-reuses-subagent-red: a main Stop reuses a subagent's red on the exact same tree, so
    // change the tree first (an edit-loop Edit without agent_id) for the main Stop to really run the commands.
    writeFileSync(join(dir, "a.ts"), "export const changedForMainStop = 1");
    runHookScript("edit-loop", { tool_name: "Edit", tool_input: { file_path: "a.ts" } }, { dir });
    const main = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
    expect(main.json.reason).toContain("[doug] Verification failed (1/2)");
    const state = JSON.parse(readFileSync(join(dir, ".doug/.state/test-session.json"), "utf8"));
    expect(state.agentBlocks).toEqual({ ag1: 2, ag2: 1 });
    expect(state.stopBlocks).toBe(1);
    expect(state.turns).toBe(1);
    expect(state.lastGate.subagent).toBeUndefined();
  });
  it("lets a subagent finish on a green gate without a checkpoint or a turn, and passes when its Stop hook is already active", () => {
    const dir = makeProject({ config: { ...baseConfig, checkpoint: { enabled: true, mode: "commit" } }, git: true });
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src/a.ts"), "export const a = 1");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "base");
    writeFileSync(join(dir, "src/a.ts"), "export const a = 2");
    const r = runHookScript("stop-gate", { hook_event_name: "SubagentStop", agent_id: "ag1", agent_type: "coder" }, { dir });
    expect(r.json).toBeNull();
    expect(git(dir, "rev-list", "--count", "HEAD")).toBe("1");
    const state = JSON.parse(readFileSync(join(dir, ".doug/.state/test-session.json"), "utf8"));
    expect(state.turns).toBe(0);
    expect(state.agentBlocks).toEqual({ ag1: 0 });
    expect(state.lastGate.ok).toBe(true);
    expect(state.lastGate.subagent).toEqual({ id: "ag1", type: "coder" });
    const failing = makeProject({ config: { ...baseConfig, commands: { test: "exit 1" } }, git: true });
    runHookScript("edit-loop", { tool_name: "Edit", tool_input: { file_path: "a.ts" } }, { dir: failing });
    expect(runHookScript("stop-gate", { hook_event_name: "SubagentStop", agent_id: "ag1", stop_hook_active: true }, { dir: failing }).json).toBeNull();
  });

  describe("partial claim refusal (card worker-context-handoff, brief A)", () => {
    const contextConfig = { ...baseConfig, contextWindow: { enabled: true, threshold: 80, repeatAfter: 5 } };
    const claim = (extra = {}) => JSON.stringify({ partial: true, completed: "did a", remaining: "do b", next: "start b", verify: "pnpm test", ...extra });
    function subagentPaths(dir) {
      return { transcriptPath: join(dir, "proj", "main.jsonl"), derived: join(dir, "proj", "test-session", "subagents", "agent-ag1.jsonl") };
    }
    // Appends a new assistant line, the way a real transcript grows (contextReading reads the LAST one): a
    // second call always leaves the file strictly larger than the first, never coincidentally the same size.
    function seedTokens(file, tokens, model = "claude-sonnet-5") {
      mkdirSync(dirname(file), { recursive: true });
      appendFileSync(file, JSON.stringify({ type: "assistant", message: { model, usage: { input_tokens: tokens } } }) + "\n");
    }

    it("(f) a partial claim with no recorded context reading is refused, counted through agentBlocks", () => {
      const dir = makeProject({ config: contextConfig, git: true });
      const input = { hook_event_name: "SubagentStop", agent_id: "ag1", agent_type: "coder", last_assistant_message: `Some prose before.\n${claim()}\nSome prose after.` };
      const r = runHookScript("stop-gate", input, { dir });
      expect(r.json.decision).toBe("block");
      expect(r.json.reason).toBe('[doug] Partial result refused: no context reading at or above 80% was recorded for this agent (none). A partial is only for a worker the harness told to stop. Finish the brief, or return blocked=true with the reason.');
      const state = JSON.parse(readFileSync(join(dir, ".doug/.state/test-session.json"), "utf8"));
      expect(state.agentBlocks).toEqual({ ag1: 1 });
    });

    it("(g) accepts a partial claim once the recorded maxPct reaches the threshold, and the normal gate then runs", () => {
      const dir = makeProject({ config: contextConfig, git: true });
      const { transcriptPath, derived } = subagentPaths(dir);
      seedTokens(derived, 800000); // 80%: at threshold
      runHookScript("trace", { hook_event_name: "PostToolUse", agent_id: "ag1", agent_type: "coder", transcript_path: transcriptPath, tool_name: "Edit", tool_input: { file_path: "a.ts" } }, { dir });
      writeFileSync(join(dir, "a.ts"), "x"); // something changed, so the normal gate has work to verify
      const input = { hook_event_name: "SubagentStop", agent_id: "ag1", agent_type: "coder", last_assistant_message: claim() };
      const r = runHookScript("stop-gate", input, { dir });
      expect(r.json).toBeNull(); // verification passes: normal green-gate allow
    });

    it("(h) a non-partial last_assistant_message is unaffected by the refusal check", () => {
      const dir = makeProject({ config: contextConfig, git: true });
      writeFileSync(join(dir, "a.ts"), "x");
      const plain = runHookScript("stop-gate", { hook_event_name: "SubagentStop", agent_id: "ag1", agent_type: "coder", last_assistant_message: "All done, nothing structured here." }, { dir });
      expect(plain.json).toBeNull();
      const falsePartial = runHookScript("stop-gate", { hook_event_name: "SubagentStop", agent_id: "ag1", agent_type: "coder", last_assistant_message: claim({ partial: false }) }, { dir });
      expect(falsePartial.json).toBeNull();
    });

    it("(i) refuses a partial claim when contextWindow is disabled entirely", () => {
      const dir = makeProject({ config: baseConfig, git: true }); // contextWindow defaults disabled
      const input = { hook_event_name: "SubagentStop", agent_id: "ag1", agent_type: "coder", last_assistant_message: claim() };
      const r = runHookScript("stop-gate", input, { dir });
      expect(r.json.decision).toBe("block");
      expect(r.json.reason).toBe('[doug] Partial result refused: no context reading at or above 80% was recorded for this agent (none). A partial is only for a worker the harness told to stop. Finish the brief, or return blocked=true with the reason.');
    });

    it("(minor 5) maxPct is a running maximum: a reading that dips (85 then 70) still accepts a partial claim", () => {
      const dir = makeProject({ config: contextConfig, git: true });
      const { transcriptPath, derived } = subagentPaths(dir);
      seedTokens(derived, 850000); // 85%
      runHookScript("trace", { hook_event_name: "PostToolUse", agent_id: "ag1", agent_type: "coder", transcript_path: transcriptPath, tool_name: "Edit", tool_input: { file_path: "a.ts" } }, { dir });
      seedTokens(derived, 700000); // 70%: dips back down, but maxPct stays 85
      runHookScript("trace", { hook_event_name: "PostToolUse", agent_id: "ag1", agent_type: "coder", transcript_path: transcriptPath, tool_name: "Edit", tool_input: { file_path: "a.ts" } }, { dir });
      writeFileSync(join(dir, "a.ts"), "x");
      const input = { hook_event_name: "SubagentStop", agent_id: "ag1", agent_type: "coder", last_assistant_message: claim() };
      const r = runHookScript("stop-gate", input, { dir });
      expect(r.json).toBeNull(); // accepted: verification passes, normal green-gate allow
    });

    it("(minor 9) after repeated partial refusals hit the cap, the gate stands down naming the refusal count, not verification", () => {
      const dir = makeProject({ config: { ...contextConfig, stopGate: { ...contextConfig.stopGate, maxBlocks: 1 } }, git: true });
      const input = { hook_event_name: "SubagentStop", agent_id: "ag1", agent_type: "coder", last_assistant_message: claim() };
      const first = runHookScript("stop-gate", input, { dir });
      expect(first.json.decision).toBe("block");
      const second = runHookScript("stop-gate", input, { dir });
      expect(second.json.decision).toBeUndefined();
      expect(second.json.systemMessage).toBe("[doug] Subagent coder (ag1)'s partial claim was refused 1 times and the gate is standing down for it. Do not treat its work as done.");
      expect(second.json.systemMessage).not.toContain("Verification is still failing");
    });

    it("(minor 10) when trace is disabled, refuses naming trace being off, not a measurement that could not be taken", () => {
      const dir = makeProject({ config: { ...contextConfig, trace: { enabled: false } }, git: true });
      const input = { hook_event_name: "SubagentStop", agent_id: "ag1", agent_type: "coder", last_assistant_message: claim() };
      const r = runHookScript("stop-gate", input, { dir });
      expect(r.json.decision).toBe("block");
      expect(r.json.reason).toBe(
        "[doug] Partial result refused: context readings need trace.enabled (it is off), so no reading could ever be recorded for this agent. A partial is only for a worker the harness told to stop. Finish the brief, or return blocked=true with the reason.",
      );
      const state = JSON.parse(readFileSync(join(dir, ".doug/.state/test-session.json"), "utf8"));
      expect(state.agentBlocks).toEqual({ ag1: 1 });
    });

    it("(minor 11) takes one fresh reading from the SubagentStop's own agent_transcript_path when nothing recorded so far clears the threshold", () => {
      const dir = makeProject({ config: contextConfig, git: true });
      const { derived } = subagentPaths(dir);
      seedTokens(derived, 900000); // 90%: never recorded via any PostToolUse
      writeFileSync(join(dir, "a.ts"), "x");
      const input = { hook_event_name: "SubagentStop", agent_id: "ag1", agent_type: "coder", agent_transcript_path: derived, last_assistant_message: claim() };
      const r = runHookScript("stop-gate", input, { dir });
      expect(r.json).toBeNull(); // accepted on the fresh reading alone
      const state = JSON.parse(readFileSync(join(dir, ".doug/.state/test-session.json"), "utf8"));
      expect(state.agents.ag1.context).toMatchObject({ pct: 90, maxPct: 90 });
    });

    describe("parsing edge cases (review MAJOR 1)", () => {
      // No context reading recorded in any of these: a message correctly recognized as a claim is refused
      // with the generic reason; one correctly recognized as NOT a claim falls through to the normal gate,
      // which allows here (nothing changed, so onlyIfEdited's early return applies).
      const refused = (message) => {
        const dir = makeProject({ config: contextConfig, git: true });
        const r = runHookScript("stop-gate", { hook_event_name: "SubagentStop", agent_id: "ag1", agent_type: "coder", last_assistant_message: message }, { dir });
        expect(r.json.decision, message).toBe("block");
        expect(r.json.reason, message).toContain("[doug] Partial result refused: no context reading");
      };
      const notAClaim = (message) => {
        const dir = makeProject({ config: contextConfig, git: true });
        const r = runHookScript("stop-gate", { hook_event_name: "SubagentStop", agent_id: "ag1", agent_type: "coder", last_assistant_message: message }, { dir });
        expect(r.json, message).toBeNull();
      };

      it("refuses despite an odd number of quotes in the prose before the claim (previously fell open)", () => {
        refused(`She said "let's ship it now.\n${claim()}`);
      });
      it("refuses despite a stray unmatched { in the prose before the claim (previously fell open)", () => {
        refused(`Something like { for an object, anyway:\n${claim()}`);
      });
      it("refuses when the claim is followed by another JSON object that lacks a partial key (previously fell open)", () => {
        refused(`${claim()}\nAlso note: {"unrelated": "stuff"}`);
      });
      it("still refuses the existing correct cases: nested braces, braces in a string, a fenced json block, two objects with the claim last", () => {
        refused(JSON.stringify({ partial: true, completed: "x", remaining: "y", next: "z", verify: "t", handoff: { note: "nested", ok: true } }));
        refused(JSON.stringify({ partial: true, completed: "x", note: "use {handlebars} and {{mustache}} syntax" }));
        refused("Here is my result:\n```json\n" + claim() + "\n```\n");
        refused(`{"unrelated": "stuff"}\n${claim()}`);
      });
      it("is not a claim: non-JSON prose, a truncated object, and partial as the string \"true\"", () => {
        notAClaim("All done here, nothing structured at all.");
        notAClaim('{"partial": true, "completed": "x", "remaining": "y"'); // no closing brace
        notAClaim(JSON.stringify({ partial: "true", completed: "x", remaining: "y", next: "z", verify: "t" }));
      });

      it("nested-key shadow: a nested object's own partial key never overrides its parent's (re-review)", () => {
        // The real claim (partial: true) sits at the top level; a nested "handoff.partial: false" must not
        // be picked instead just because its "{" starts later in the text.
        refused(JSON.stringify({ partial: true, completed: "a", handoff: { partial: false } }));
        // Fail-closed: no top-level candidate carries a "partial" key at all here, only a nested one — still
        // treated as a claim (and so refused, for lack of a reading) rather than silently waved through.
        refused(JSON.stringify({ result: { partial: true } }));
        // A real top-level claim followed by an unrelated object that itself nests a "partial" key: the real
        // claim, not the decoy's nested key, is still what gets picked.
        refused(`${claim()}\nnote ${JSON.stringify({ x: { partial: true } })}`);
      });

      it("(scan cost) a 200KB message whose claim sits in the last 2KB is still found and refused", () => {
        const filler = "x".repeat(198 * 1024); // no braces, far larger than the 32KB tail window
        refused(filler + "\n" + claim()); // ~198KB of filler, then the claim in the final ~2KB
      });

      it("(scan cost) returns quickly on 400KB of brace-heavy prose with no claim at all", () => {
        const dir = makeProject({ config: contextConfig, git: true });
        // Dense with unmatched "{" (about one every 20 characters, never closed) but still prose, not the
        // pathological case of nothing but "{" — what made the unbounded scan quadratic in message length.
        // 400KB (not 200KB): on the uncapped regression the scan cost is quadratic in payload length, and
        // 200KB alone (~4.3s) came in under an 8000ms bound; doubling the payload roughly quadruples that
        // regression cost while the capped path's cost stays flat.
        const chunk = "prose prose prose { ";
        const braceHeavy = chunk.repeat(Math.ceil((400 * 1024) / chunk.length));
        const startedAt = Date.now();
        const r = runHookScript("stop-gate", { hook_event_name: "SubagentStop", agent_id: "ag1", agent_type: "coder", last_assistant_message: braceHeavy }, { dir });
        const elapsedMs = Date.now() - startedAt;
        expect(r.json).toBeNull(); // no candidate ever balances: not a claim, normal gate allows
        expect(elapsedMs).toBeLessThan(8000);
      });
    });
  });

  describe("tests red by design (card subagent-stop-gate-tester-red)", () => {
    const claim = (files) => JSON.stringify({ tests_red_by_design: files });
    // card tester-claim-missed-in-handback, pass 2: a JSONL transcript line shaped like a real
    // SubagentHandback tool_use, per the brief's observed transcript shape (F: an assistant line with
    // message.content, an array; a hand-back is { type: "tool_use", name: "SubagentHandback", input: { message } }).
    function handbackLine(message) {
      return JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "SubagentHandback", input: { message } }] } });
    }
    function tracedLines(dir, sessionId = "test-session") {
      const file = join(dir, ".doug/.state/trace", `${sessionId}.jsonl`);
      if (!existsSync(file)) return [];
      return readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    }

    it("T1 a covered claim lets the tester stop, resets its counter, records lastGate.redByDesign, and traces the claim", () => {
      const dir = makeProject({
        config: { ...baseConfig, commands: { test: "echo ' FAIL  tests/a.test.mjs > it'; echo ' ❯ tests/a.test.mjs (3 tests | 1 failed)'; exit 1" } },
        git: true,
      });
      mkdirSync(join(dir, "tests"));
      writeFileSync(join(dir, "tests/a.test.mjs"), "it fails on purpose");
      runHookScript("edit-loop", { tool_name: "Write", tool_input: { file_path: "tests/a.test.mjs" }, agent_id: "ag1", agent_type: "tester" }, { dir });
      const input = {
        hook_event_name: "SubagentStop",
        agent_id: "ag1",
        agent_type: "tester",
        last_assistant_message: `Ran the new test; it fails as designed.\n${claim(["tests/a.test.mjs"])}`,
      };
      const r = runHookScript("stop-gate", input, { dir });
      expect(r.json.decision).toBeUndefined();
      expect(r.json.systemMessage).toContain("Subagent tester (ag1) stopped with tests red by design: tests/a.test.mjs");
      const state = JSON.parse(readFileSync(join(dir, ".doug/.state/test-session.json"), "utf8"));
      expect(state.agentBlocks).toEqual({ ag1: 0 });
      expect(state.lastGate.redByDesign).toEqual(["tests/a.test.mjs"]);
      const line = tracedLines(dir).find((l) => l.event === "SubagentStop" && l.reason === "tests_red_by_design");
      expect(line).toBeTruthy();
      expect(line.detail).toContain("tests/a.test.mjs");
    });

    it("T2 a failing file left out of the claim list is not covered: block, naming the uncovered file at the end", () => {
      const dir = makeProject({
        config: {
          ...baseConfig,
          commands: {
            test: "echo ' FAIL  tests/a.test.mjs > it'; echo ' FAIL  tests/b.test.mjs > it'; echo 'summary: tests/a.test.mjs failed again'; exit 1",
          },
        },
        git: true,
      });
      mkdirSync(join(dir, "tests"));
      writeFileSync(join(dir, "tests/a.test.mjs"), "a");
      writeFileSync(join(dir, "tests/b.test.mjs"), "b");
      runHookScript("edit-loop", { tool_name: "Write", tool_input: { file_path: "tests/a.test.mjs" }, agent_id: "ag1", agent_type: "tester" }, { dir });
      const input = { hook_event_name: "SubagentStop", agent_id: "ag1", agent_type: "tester", last_assistant_message: claim(["tests/a.test.mjs"]) };
      const r = runHookScript("stop-gate", input, { dir });
      expect(r.json.decision).toBe("block");
      expect(r.json.reason).toContain("(1/");
      const lines = r.json.reason.trim().split("\n");
      expect(lines[lines.length - 1]).toContain("tests/b.test.mjs");
      const state = JSON.parse(readFileSync(join(dir, ".doug/.state/test-session.json"), "utf8"));
      expect(state.agentBlocks).toEqual({ ag1: 1 });
    });

    it("T3 a listed file the tree does not show as changed is not covered: block, naming it at the end", () => {
      const dir = makeProject({
        config: { ...baseConfig, commands: { test: "echo ' FAIL  tests/a.test.mjs > it'; echo 'exit code 1'; exit 1" } },
        git: true,
      });
      mkdirSync(join(dir, "tests"));
      writeFileSync(join(dir, "tests/a.test.mjs"), "a");
      git(dir, "add", "-A");
      git(dir, "commit", "-q", "-m", "base");
      writeFileSync(join(dir, "other.ts"), "x");
      runHookScript("edit-loop", { tool_name: "Write", tool_input: { file_path: "other.ts" }, agent_id: "ag1", agent_type: "tester" }, { dir });
      const input = { hook_event_name: "SubagentStop", agent_id: "ag1", agent_type: "tester", last_assistant_message: claim(["tests/a.test.mjs"]) };
      const r = runHookScript("stop-gate", input, { dir });
      expect(r.json.decision).toBe("block");
      expect(r.json.reason).toContain("(1/");
      const lines = r.json.reason.trim().split("\n");
      expect(lines[lines.length - 1]).toContain("tests/a.test.mjs");
      const state = JSON.parse(readFileSync(join(dir, ".doug/.state/test-session.json"), "utf8"));
      expect(state.agentBlocks).toEqual({ ag1: 1 });
    });

    it("T4 a red whose output names no test file is not covered: block, saying the command named no test file", () => {
      const dir = makeProject({
        config: { ...baseConfig, commands: { test: "echo type error; exit 1" } },
        git: true,
      });
      runHookScript("edit-loop", { tool_name: "Edit", tool_input: { file_path: "a.ts" }, agent_id: "ag1", agent_type: "tester" }, { dir });
      const input = { hook_event_name: "SubagentStop", agent_id: "ag1", agent_type: "tester", last_assistant_message: claim(["tests/a.test.mjs"]) };
      const r = runHookScript("stop-gate", input, { dir });
      expect(r.json.decision).toBe("block");
      expect(r.json.reason).toContain("(1/");
      expect(r.json.reason).toMatch(/named no test file/i);
    });

    it("T5 the main Stop ignores the claim: still blocks with the ordinary reason", () => {
      const dir = makeProject({
        config: { ...baseConfig, commands: { test: "echo ' FAIL  tests/a.test.mjs > it'; exit 1" } },
        git: true,
      });
      mkdirSync(join(dir, "tests"));
      writeFileSync(join(dir, "tests/a.test.mjs"), "a");
      runHookScript("edit-loop", { tool_name: "Write", tool_input: { file_path: "tests/a.test.mjs" } }, { dir });
      const input = { hook_event_name: "Stop", last_assistant_message: claim(["tests/a.test.mjs"]) };
      const r = runHookScript("stop-gate", input, { dir });
      expect(r.json.decision).toBe("block");
      expect(r.json.reason).toContain("[doug] Verification failed (1/");
    });

    it("T6 no claim, same red, agent_type tester: the ordinary block runs, unchanged", () => {
      const dir = makeProject({
        config: { ...baseConfig, commands: { test: "echo ' FAIL  tests/a.test.mjs > it'; exit 1" } },
        git: true,
      });
      mkdirSync(join(dir, "tests"));
      writeFileSync(join(dir, "tests/a.test.mjs"), "a");
      runHookScript("edit-loop", { tool_name: "Write", tool_input: { file_path: "tests/a.test.mjs" }, agent_id: "ag1", agent_type: "tester" }, { dir });
      const input = {
        hook_event_name: "SubagentStop",
        agent_id: "ag1",
        agent_type: "tester",
        last_assistant_message: "Ran the tests; they fail as expected, no structured claim here.",
      };
      const r = runHookScript("stop-gate", input, { dir });
      expect(r.json.decision).toBe("block");
      expect(r.json.reason).toContain("Subagent tester (ag1) cannot report done: verification failed (1/");
    });

    it("T7 malformed claims (empty array, a string, an array of an empty string) are no claim: the ordinary block runs", () => {
      const malformed = [claim([]), JSON.stringify({ tests_red_by_design: "tests/a.test.mjs" }), claim([""])];
      for (const message of malformed) {
        const dir = makeProject({
          config: { ...baseConfig, commands: { test: "echo ' FAIL  tests/a.test.mjs > it'; exit 1" } },
          git: true,
        });
        mkdirSync(join(dir, "tests"));
        writeFileSync(join(dir, "tests/a.test.mjs"), "a");
        runHookScript("edit-loop", { tool_name: "Write", tool_input: { file_path: "tests/a.test.mjs" }, agent_id: "ag1", agent_type: "tester" }, { dir });
        const r = runHookScript("stop-gate", { hook_event_name: "SubagentStop", agent_id: "ag1", agent_type: "tester", last_assistant_message: message }, { dir });
        expect(r.json.decision, message).toBe("block");
        expect(r.json.reason, message).toContain("Subagent tester (ag1) cannot report done: verification failed (1/");
      }
    });

    it("T8 trace disabled: still allowed with the systemMessage, and no trace file is written", () => {
      const dir = makeProject({
        config: { ...baseConfig, trace: { enabled: false }, commands: { test: "echo ' FAIL  tests/a.test.mjs > it'; exit 1" } },
        git: true,
      });
      mkdirSync(join(dir, "tests"));
      writeFileSync(join(dir, "tests/a.test.mjs"), "a");
      runHookScript("edit-loop", { tool_name: "Write", tool_input: { file_path: "tests/a.test.mjs" }, agent_id: "ag1", agent_type: "tester" }, { dir });
      const input = { hook_event_name: "SubagentStop", agent_id: "ag1", agent_type: "tester", last_assistant_message: claim(["tests/a.test.mjs"]) };
      const r = runHookScript("stop-gate", input, { dir });
      expect(r.json.decision).toBeUndefined();
      expect(r.json.systemMessage).toContain("Subagent tester (ag1) stopped with tests red by design: tests/a.test.mjs");
      expect(existsSync(join(dir, ".doug/.state/trace/test-session.jsonl"))).toBe(false);
    });

    // 2026-09-14, reviewer findings on this card: two majors and three minors the T1-T8 tests above do not
    // constrain.
    it("T11 MAJOR: the claim is honoured only for agent_type \"tester\" exactly: the same covered claim from a coder still blocks, naming the type it saw", () => {
      const dir = makeProject({
        config: { ...baseConfig, commands: { test: "echo ' FAIL  tests/a.test.mjs > it'; exit 1" } },
        git: true,
      });
      mkdirSync(join(dir, "tests"));
      writeFileSync(join(dir, "tests/a.test.mjs"), "a");
      runHookScript("edit-loop", { tool_name: "Write", tool_input: { file_path: "tests/a.test.mjs" }, agent_id: "ag1", agent_type: "coder" }, { dir });
      const input = { hook_event_name: "SubagentStop", agent_id: "ag1", agent_type: "coder", last_assistant_message: claim(["tests/a.test.mjs"]) };
      const r = runHookScript("stop-gate", input, { dir });
      expect(r.json.decision).toBe("block");
      expect(r.json.reason).toContain("(1/");
      const lines = r.json.reason.trim().split("\n");
      expect(lines[lines.length - 1]).toMatch(/tester/i);
      expect(lines[lines.length - 1]).toContain("coder");
    });

    it("T12 MAJOR, preconditions: a dirty protected path plus the red plus a covered claim still blocks, and the reason never says red by design", () => {
      const dir = makeProject({
        config: { ...baseConfig, commands: { test: "echo ' FAIL  tests/a.test.mjs > it'; exit 1" } },
        git: true,
      });
      mkdirSync(join(dir, "tests"));
      writeFileSync(join(dir, "tests/a.test.mjs"), "a");
      writeFileSync(join(dir, ".env"), "SECRET=1"); // baseConfig.protectedPaths includes ".env"
      runHookScript("edit-loop", { tool_name: "Write", tool_input: { file_path: "tests/a.test.mjs" }, agent_id: "ag1", agent_type: "tester" }, { dir });
      const input = { hook_event_name: "SubagentStop", agent_id: "ag1", agent_type: "tester", last_assistant_message: claim(["tests/a.test.mjs"]) };
      const r = runHookScript("stop-gate", input, { dir });
      expect(r.json.decision).toBe("block");
      expect(r.json.reason).toContain(".env");
      expect(r.json.reason).not.toContain("red by design");
    });

    it("T13 MAJOR, preconditions: an approved plan whose tasks do not own tests/a.test.mjs, plus the red plus a covered claim, still blocks", () => {
      const plan = {
        version: 1,
        title: "Truncate helper",
        goal: "Add truncate to the strings module",
        status: "approved",
        acceptance: ["truncate exists"],
        verify: [],
        tasks: [{ id: "add-truncate", title: "Add truncate", spec: "Add truncate(input, max) to src/strings.ts with tests.", files: ["src/strings.ts"] }],
      };
      const dir = makeProject({
        config: { ...baseConfig, commands: { test: "echo ' FAIL  tests/a.test.mjs > it'; exit 1" } },
        git: true,
      });
      mkdirSync(join(dir, "src"));
      writeFileSync(join(dir, ".doug/plan.json"), JSON.stringify(plan));
      git(dir, "add", "-A");
      git(dir, "commit", "-q", "-m", "base");
      mkdirSync(join(dir, "tests"));
      writeFileSync(join(dir, "tests/a.test.mjs"), "a");
      runHookScript("edit-loop", { tool_name: "Write", tool_input: { file_path: "tests/a.test.mjs" }, agent_id: "ag1", agent_type: "tester" }, { dir });
      const input = { hook_event_name: "SubagentStop", agent_id: "ag1", agent_type: "tester", last_assistant_message: claim(["tests/a.test.mjs"]) };
      const r = runHookScript("stop-gate", input, { dir });
      expect(r.json.decision).toBe("block");
      expect(r.json.reason).toContain("outside the approved plan");
      expect(r.json.reason).not.toContain("red by design");
    });

    it("T14 MAJOR, preconditions: requireEvidence on with no verify command recorded, plus the red plus a covered claim, still blocks", () => {
      const dir = makeProject({
        config: { ...baseConfig, stopGate: { ...baseConfig.stopGate, requireEvidence: true }, commands: { test: "echo ' FAIL  tests/a.test.mjs > it'; exit 1" } },
        git: true,
      });
      mkdirSync(join(dir, "tests"));
      writeFileSync(join(dir, "tests/a.test.mjs"), "a");
      runHookScript("edit-loop", { tool_name: "Write", tool_input: { file_path: "tests/a.test.mjs" }, agent_id: "ag1", agent_type: "tester" }, { dir });
      const input = { hook_event_name: "SubagentStop", agent_id: "ag1", agent_type: "tester", last_assistant_message: claim(["tests/a.test.mjs"]) };
      const r = runHookScript("stop-gate", input, { dir });
      expect(r.json.decision).toBe("block");
      expect(r.json.reason).toContain("This session never ran a test or verify command itself");
      expect(r.json.reason).not.toContain("red by design");
    });

    it("T15 MINOR, parse: a FAIL line whose file token is wrapped in punctuation is still covered (leading punctuation is not part of the file)", () => {
      const dir = makeProject({
        config: { ...baseConfig, commands: { test: "echo '1 test failed at (tests/a.test.mjs:3:1)'; exit 1" } },
        git: true,
      });
      mkdirSync(join(dir, "tests"));
      writeFileSync(join(dir, "tests/a.test.mjs"), "a");
      runHookScript("edit-loop", { tool_name: "Write", tool_input: { file_path: "tests/a.test.mjs" }, agent_id: "ag1", agent_type: "tester" }, { dir });
      const input = { hook_event_name: "SubagentStop", agent_id: "ag1", agent_type: "tester", last_assistant_message: claim(["tests/a.test.mjs"]) };
      const r = runHookScript("stop-gate", input, { dir });
      expect(r.json.decision).toBeUndefined();
      expect(r.json.systemMessage).toContain("Subagent tester (ag1) stopped with tests red by design: tests/a.test.mjs");
    });

    it("T16 MINOR, parse (pin): the failing file printed as an absolute path under dir still matches a repo-relative claim", () => {
      const dir = makeProject({ git: true });
      mkdirSync(join(dir, "tests"));
      writeFileSync(join(dir, "tests/a.test.mjs"), "a");
      const abs = join(dir, "tests/a.test.mjs");
      mkdirSync(join(dir, ".doug"), { recursive: true });
      writeFileSync(join(dir, ".doug/config.json"), JSON.stringify({ ...baseConfig, commands: { test: `echo 'FAIL  ${abs} > it'; exit 1` } }));
      runHookScript("edit-loop", { tool_name: "Write", tool_input: { file_path: "tests/a.test.mjs" }, agent_id: "ag1", agent_type: "tester" }, { dir });
      const input = { hook_event_name: "SubagentStop", agent_id: "ag1", agent_type: "tester", last_assistant_message: claim(["tests/a.test.mjs"]) };
      const r = runHookScript("stop-gate", input, { dir });
      expect(r.json.decision).toBeUndefined();
      expect(r.json.systemMessage).toContain("Subagent tester (ag1) stopped with tests red by design: tests/a.test.mjs");
    });

    it("T17 MINOR, parse (pin): a passing-test line (✓) naming a file must not count as failing", () => {
      const dir = makeProject({
        config: { ...baseConfig, commands: { test: "echo ' ✓ tests/a.test.mjs (2 tests)'; echo ' FAIL  tests/b.test.mjs > it'; exit 1" } },
        git: true,
      });
      mkdirSync(join(dir, "tests"));
      writeFileSync(join(dir, "tests/a.test.mjs"), "a");
      writeFileSync(join(dir, "tests/b.test.mjs"), "b");
      runHookScript("edit-loop", { tool_name: "Write", tool_input: { file_path: "tests/a.test.mjs" }, agent_id: "ag1", agent_type: "tester" }, { dir });
      const input = { hook_event_name: "SubagentStop", agent_id: "ag1", agent_type: "tester", last_assistant_message: claim(["tests/a.test.mjs"]) };
      const r = runHookScript("stop-gate", input, { dir });
      expect(r.json.decision).toBe("block");
      const lines = r.json.reason.trim().split("\n");
      expect(lines[lines.length - 1]).toContain("tests/b.test.mjs");
    });

    it("T18 MINOR: a claim written with a leading './' is normalised", () => {
      const dir = makeProject({
        config: { ...baseConfig, commands: { test: "echo ' FAIL  tests/a.test.mjs > it'; exit 1" } },
        git: true,
      });
      mkdirSync(join(dir, "tests"));
      writeFileSync(join(dir, "tests/a.test.mjs"), "a");
      runHookScript("edit-loop", { tool_name: "Write", tool_input: { file_path: "tests/a.test.mjs" }, agent_id: "ag1", agent_type: "tester" }, { dir });
      const input = { hook_event_name: "SubagentStop", agent_id: "ag1", agent_type: "tester", last_assistant_message: claim(["./tests/a.test.mjs"]) };
      const r = runHookScript("stop-gate", input, { dir });
      expect(r.json.decision).toBeUndefined();
      expect(r.json.systemMessage).toContain("Subagent tester (ag1) stopped with tests red by design");
    });

    it("T19 MINOR, parse (pin): a ✓-line file is never counted as failing, even when it is the only file the claim omits", () => {
      const dir = makeProject({
        config: { ...baseConfig, commands: { test: "echo ' ✓ tests/ok.test.mjs (2 tests)'; echo ' FAIL  tests/b.test.mjs > it'; exit 1" } },
        git: true,
      });
      mkdirSync(join(dir, "tests"));
      writeFileSync(join(dir, "tests/ok.test.mjs"), "ok"); // untracked, like tests/b.test.mjs below
      writeFileSync(join(dir, "tests/b.test.mjs"), "b");
      runHookScript("edit-loop", { tool_name: "Write", tool_input: { file_path: "tests/b.test.mjs" }, agent_id: "ag1", agent_type: "tester" }, { dir });
      const input = { hook_event_name: "SubagentStop", agent_id: "ag1", agent_type: "tester", last_assistant_message: claim(["tests/b.test.mjs"]) };
      const r = runHookScript("stop-gate", input, { dir });
      expect(r.json.decision).toBeUndefined();
      expect(r.json.systemMessage).toContain("Subagent tester (ag1) stopped with tests red by design: tests/b.test.mjs");
    });

    // card tester-claim-missed-in-handback, pass 2: no fallback exists yet — the gate reads only
    // last_assistant_message, so H1/H2/H5 below are red until lastHandbackMessage() and its fallback land.
    it("H1 a claim only inside a SubagentHandback call, with the trailing plain text carrying no claim, is honoured via the hand-back fallback", () => {
      const dir = makeProject({
        config: { ...baseConfig, commands: { test: "echo ' FAIL  tests/a.test.mjs > it'; exit 1" } },
        git: true,
      });
      mkdirSync(join(dir, "tests"));
      writeFileSync(join(dir, "tests/a.test.mjs"), "a");
      runHookScript("edit-loop", { tool_name: "Write", tool_input: { file_path: "tests/a.test.mjs" }, agent_id: "ag1", agent_type: "tester" }, { dir });
      const transcriptPath = join(dir, "transcript.jsonl");
      writeFileSync(transcriptPath, handbackLine(claim(["tests/a.test.mjs"])) + "\n");
      const input = {
        hook_event_name: "SubagentStop",
        agent_id: "ag1",
        agent_type: "tester",
        agent_transcript_path: transcriptPath,
        last_assistant_message: "Report delivered via SubagentHandback.",
      };
      const r = runHookScript("stop-gate", input, { dir });
      // Asserted as a boolean (not a direct .toBeUndefined()/.toContain() on r.json) so a failure here never
      // prints the raw command output embedded in r.json.reason: that output itself contains a "FAIL
      // tests/a.test.mjs" line (the fixture's own echo), and an outer coverage-checking gate that scans this
      // test file's own stdout must not mistake that printed fixture text for a real uncovered failing file.
      expect(r.json.decision === undefined, "expected the hand-back fallback to honour the claim (stop-gate should return no decision, not block)").toBe(true);
      expect(r.json.systemMessage.includes("Subagent tester (ag1) stopped with tests red by design: tests/a.test.mjs"), "expected the red-by-design systemMessage").toBe(true);
      const state = JSON.parse(readFileSync(join(dir, ".doug/.state/test-session.json"), "utf8"));
      expect(state.redByDesignClaim).toBeTruthy();
      expect(state.redByDesignClaim.files).toEqual(["tests/a.test.mjs"]);
    });

    it("H2 among several hand-backs the LAST one's claim is used, both directions", () => {
      // first wrong file, last correct: honoured
      const dir = makeProject({
        config: { ...baseConfig, commands: { test: "echo ' FAIL  tests/a.test.mjs > it'; exit 1" } },
        git: true,
      });
      mkdirSync(join(dir, "tests"));
      writeFileSync(join(dir, "tests/a.test.mjs"), "a");
      runHookScript("edit-loop", { tool_name: "Write", tool_input: { file_path: "tests/a.test.mjs" }, agent_id: "ag1", agent_type: "tester" }, { dir });
      const transcriptPath = join(dir, "transcript.jsonl");
      writeFileSync(
        transcriptPath,
        [handbackLine(claim(["tests/other.test.mjs"])), handbackLine(claim(["tests/a.test.mjs"]))].join("\n") + "\n",
      );
      const input = {
        hook_event_name: "SubagentStop",
        agent_id: "ag1",
        agent_type: "tester",
        agent_transcript_path: transcriptPath,
        last_assistant_message: "Report delivered via SubagentHandback.",
      };
      const r = runHookScript("stop-gate", input, { dir });
      // Boolean-wrapped for the same reason as H1: a failure here must not print r.json.reason's embedded
      // "FAIL tests/a.test.mjs" fixture line to an outer gate scanning this test file's own stdout.
      expect(r.json.decision === undefined, "expected the LAST hand-back's claim to win (stop-gate should return no decision, not block)").toBe(true);
      expect(r.json.systemMessage.includes("Subagent tester (ag1) stopped with tests red by design: tests/a.test.mjs"), "expected the red-by-design systemMessage").toBe(true);

      // first correct, last wrong: blocks (the last one still wins, and it does not cover the failure)
      const dir2 = makeProject({
        config: { ...baseConfig, commands: { test: "echo ' FAIL  tests/a.test.mjs > it'; exit 1" } },
        git: true,
      });
      mkdirSync(join(dir2, "tests"));
      writeFileSync(join(dir2, "tests/a.test.mjs"), "a");
      runHookScript("edit-loop", { tool_name: "Write", tool_input: { file_path: "tests/a.test.mjs" }, agent_id: "ag1", agent_type: "tester" }, { dir: dir2 });
      const transcriptPath2 = join(dir2, "transcript.jsonl");
      writeFileSync(
        transcriptPath2,
        [handbackLine(claim(["tests/a.test.mjs"])), handbackLine(claim(["tests/other.test.mjs"]))].join("\n") + "\n",
      );
      const input2 = {
        hook_event_name: "SubagentStop",
        agent_id: "ag1",
        agent_type: "tester",
        agent_transcript_path: transcriptPath2,
        last_assistant_message: "Report delivered via SubagentHandback.",
      };
      const r2 = runHookScript("stop-gate", input2, { dir: dir2 });
      expect(r2.json.decision === "block", "expected the reversed order's LAST hand-back (the wrong file) to block").toBe(true);
    });

    it("H3 a non-tester agent_type with a hand-back claim still blocks with the agent_type message: the fallback does not bypass the tester-only check", () => {
      const dir = makeProject({
        config: { ...baseConfig, commands: { test: "echo ' FAIL  tests/a.test.mjs > it'; exit 1" } },
        git: true,
      });
      mkdirSync(join(dir, "tests"));
      writeFileSync(join(dir, "tests/a.test.mjs"), "a");
      runHookScript("edit-loop", { tool_name: "Write", tool_input: { file_path: "tests/a.test.mjs" }, agent_id: "ag1", agent_type: "coder" }, { dir });
      const transcriptPath = join(dir, "transcript.jsonl");
      writeFileSync(transcriptPath, handbackLine(claim(["tests/a.test.mjs"])) + "\n");
      const input = {
        hook_event_name: "SubagentStop",
        agent_id: "ag1",
        agent_type: "coder",
        agent_transcript_path: transcriptPath,
        last_assistant_message: "Report delivered via SubagentHandback.",
      };
      const r = runHookScript("stop-gate", input, { dir });
      expect(r.json.decision).toBe("block");
      const lines = r.json.reason.trim().split("\n");
      const lastLine = lines[lines.length - 1];
      // Boolean-wrapped (not two separate .toMatch/.toContain calls on the raw line) so a failure here never
      // prints lastLine itself: today, with no claim recognized at all, lastLine IS the fixture's raw "FAIL
      // tests/a.test.mjs > it" output, which an outer gate scanning this test file's own stdout must not
      // mistake for a real uncovered failing file.
      expect(/tester/i.test(lastLine) && lastLine.includes("coder"), "expected the block's last line to name the agent_type mismatch (tester vs coder)").toBe(true);
    });

    it("H4 a missing or malformed agent_transcript_path never throws; the ordinary block runs both times", () => {
      // nonexistent file
      const dir = makeProject({
        config: { ...baseConfig, commands: { test: "echo ' FAIL  tests/a.test.mjs > it'; exit 1" } },
        git: true,
      });
      mkdirSync(join(dir, "tests"));
      writeFileSync(join(dir, "tests/a.test.mjs"), "a");
      runHookScript("edit-loop", { tool_name: "Write", tool_input: { file_path: "tests/a.test.mjs" }, agent_id: "ag1", agent_type: "tester" }, { dir });
      const input = {
        hook_event_name: "SubagentStop",
        agent_id: "ag1",
        agent_type: "tester",
        agent_transcript_path: join(dir, "nope.jsonl"),
        last_assistant_message: "No structured claim here at all.",
      };
      const r = runHookScript("stop-gate", input, { dir });
      expect(r.json.decision, `expected a missing transcript path to fail open into the ordinary block, not throw; got ${JSON.stringify(r.json)}`).toBe("block");
      expect(r.json.reason).toContain("Subagent tester (ag1) cannot report done: verification failed (1/");

      // a file holding a garbage line
      const dir2 = makeProject({
        config: { ...baseConfig, commands: { test: "echo ' FAIL  tests/a.test.mjs > it'; exit 1" } },
        git: true,
      });
      mkdirSync(join(dir2, "tests"));
      writeFileSync(join(dir2, "tests/a.test.mjs"), "a");
      runHookScript("edit-loop", { tool_name: "Write", tool_input: { file_path: "tests/a.test.mjs" }, agent_id: "ag1", agent_type: "tester" }, { dir: dir2 });
      const transcriptPath2 = join(dir2, "transcript.jsonl");
      writeFileSync(transcriptPath2, "not valid json at all\n");
      const input2 = {
        hook_event_name: "SubagentStop",
        agent_id: "ag1",
        agent_type: "tester",
        agent_transcript_path: transcriptPath2,
        last_assistant_message: "No structured claim here at all.",
      };
      const r2 = runHookScript("stop-gate", input2, { dir: dir2 });
      expect(r2.json.decision, `expected a malformed transcript line to fail open into the ordinary block, not throw; got ${JSON.stringify(r2.json)}`).toBe("block");
      expect(r2.json.reason).toContain("Subagent tester (ag1) cannot report done: verification failed (1/");
    });

    it("H5 a valid claim in last_assistant_message wins over a different claim in the hand-back: plain text is read first", () => {
      const dir = makeProject({
        config: { ...baseConfig, commands: { test: "echo ' FAIL  tests/a.test.mjs > it'; exit 1" } },
        git: true,
      });
      mkdirSync(join(dir, "tests"));
      writeFileSync(join(dir, "tests/a.test.mjs"), "a");
      runHookScript("edit-loop", { tool_name: "Write", tool_input: { file_path: "tests/a.test.mjs" }, agent_id: "ag1", agent_type: "tester" }, { dir });
      const transcriptPath = join(dir, "transcript.jsonl");
      writeFileSync(transcriptPath, handbackLine(claim(["tests/other.test.mjs"])) + "\n");
      const input = {
        hook_event_name: "SubagentStop",
        agent_id: "ag1",
        agent_type: "tester",
        agent_transcript_path: transcriptPath,
        last_assistant_message: `Ran the new test; it fails as designed.\n${claim(["tests/a.test.mjs"])}`,
      };
      const r = runHookScript("stop-gate", input, { dir });
      expect(r.json.decision, `expected the plain-text claim to win over the hand-back's different claim; got ${JSON.stringify(r.json)}`).toBeUndefined();
      expect(r.json.systemMessage).toContain("Subagent tester (ag1) stopped with tests red by design: tests/a.test.mjs");
    });

    // card tester-claim-missed-in-handback, review round 1: three mechanisms of lastHandbackMessage
    // (stop-gate.mjs) unpinned by H1-H5 above. H6-H8 pin them; all three pass today.
    it("H6 (R3) a claim hand-back followed by a later assistant line with a SendMessage tool_use carrying a non-claim message: the claim is still honoured", () => {
      const dir = makeProject({
        config: { ...baseConfig, commands: { test: "echo ' FAIL  tests/a.test.mjs > it'; exit 1" } },
        git: true,
      });
      mkdirSync(join(dir, "tests"));
      writeFileSync(join(dir, "tests/a.test.mjs"), "a");
      runHookScript("edit-loop", { tool_name: "Write", tool_input: { file_path: "tests/a.test.mjs" }, agent_id: "ag1", agent_type: "tester" }, { dir });
      const transcriptPath = join(dir, "transcript.jsonl");
      // Same assistant-line shape as handbackLine, but tool_use.name is "SendMessage", not "SubagentHandback".
      // Its input.message is a plain string carrying no claim; only the `name` filter keeps it from winning.
      const sendMessageLine = JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "tool_use", name: "SendMessage", input: { message: "just checking in, no claim here" } }] },
      });
      writeFileSync(transcriptPath, [handbackLine(claim(["tests/a.test.mjs"])), sendMessageLine].join("\n") + "\n");
      const input = {
        hook_event_name: "SubagentStop",
        agent_id: "ag1",
        agent_type: "tester",
        agent_transcript_path: transcriptPath,
        last_assistant_message: "Report delivered via SubagentHandback.",
      };
      const r = runHookScript("stop-gate", input, { dir });
      expect(r.json.decision === undefined, "expected the SubagentHandback claim to still be honoured despite a later non-claim SendMessage call").toBe(true);
      expect(r.json.systemMessage.includes("Subagent tester (ag1) stopped with tests red by design: tests/a.test.mjs"), "expected the red-by-design systemMessage").toBe(true);
    });

    it("H7 (R2) a claim hand-back followed by more than 2 MiB of padding, with no later hand-back: it blocks because the claim lies outside the read window", () => {
      const dir = makeProject({
        config: { ...baseConfig, commands: { test: "echo ' FAIL  tests/a.test.mjs > it'; exit 1" } },
        git: true,
      });
      mkdirSync(join(dir, "tests"));
      writeFileSync(join(dir, "tests/a.test.mjs"), "a");
      runHookScript("edit-loop", { tool_name: "Write", tool_input: { file_path: "tests/a.test.mjs" }, agent_id: "ag1", agent_type: "tester" }, { dir });
      const transcriptPath = join(dir, "transcript.jsonl");
      // 10 x 300KB non-JSON lines = ~3MB, well past lastHandbackMessage's 2 MiB (HANDBACK_TAIL_BYTES) read
      // window, and none of them is a hand-back, so the only claim in the file falls entirely outside it.
      const paddingLines = Array.from({ length: 10 }, (_, i) => `padding line ${i} ` + "p".repeat(300 * 1024));
      writeFileSync(transcriptPath, [handbackLine(claim(["tests/a.test.mjs"])), ...paddingLines].join("\n") + "\n");
      const input = {
        hook_event_name: "SubagentStop",
        agent_id: "ag1",
        agent_type: "tester",
        agent_transcript_path: transcriptPath,
        last_assistant_message: "Report delivered via SubagentHandback.",
      };
      const r = runHookScript("stop-gate", input, { dir });
      expect(r.json.decision === "block", `expected the claim beyond the 2 MiB read window to be invisible to the fallback, blocking as usual; got decision=${r.json.decision}`).toBe(true);
    });

    it("H8 (R1) the window's first line is cut, and the claim sits in that cut line's tail: the tail would parse as a valid claim on its own, but is skipped, so it blocks", () => {
      const dir = makeProject({
        config: { ...baseConfig, commands: { test: "echo ' FAIL  tests/a.test.mjs > it'; exit 1" } },
        git: true,
      });
      mkdirSync(join(dir, "tests"));
      writeFileSync(join(dir, "tests/a.test.mjs"), "a");
      runHookScript("edit-loop", { tool_name: "Write", tool_input: { file_path: "tests/a.test.mjs" }, agent_id: "ag1", agent_type: "tester" }, { dir });
      const transcriptPath = join(dir, "transcript.jsonl");

      // lastHandbackMessage (stop-gate.mjs) only ever reads the file's last HANDBACK_TAIL_BYTES, and skips
      // whatever (possibly partial) first line that read produces. Lay the file out as
      // [leadingPadding][claimLine]\n[trailing], sized so the window starts exactly at claimLine's first
      // byte: the read window's first "line" IS claimLine, byte for byte — a complete, standalone-parseable
      // SubagentHandback claim — yet it is the skipped line, not a genuinely truncated fragment.
      const HANDBACK_TAIL_BYTES = 2 * 1024 * 1024;
      const claimLine = handbackLine(claim(["tests/a.test.mjs"])); // pure ASCII: byte length === char length
      const leadingPadding = "z".repeat(1000); // never read (lies before the window start); any length > 0 works
      const trailing = "y".repeat(HANDBACK_TAIL_BYTES - claimLine.length - 1); // makes size - start land exactly at leadingPadding.length
      writeFileSync(transcriptPath, leadingPadding + claimLine + "\n" + trailing);

      const size = statSync(transcriptPath).size;
      expect(size - HANDBACK_TAIL_BYTES).toBe(leadingPadding.length); // sanity: cut lands exactly at claimLine's own start

      const input = {
        hook_event_name: "SubagentStop",
        agent_id: "ag1",
        agent_type: "tester",
        agent_transcript_path: transcriptPath,
        last_assistant_message: "Report delivered via SubagentHandback.",
      };
      const r = runHookScript("stop-gate", input, { dir });
      expect(r.json.decision === "block", `expected the cut leading line to be skipped rather than read as a claim; got decision=${r.json.decision}`).toBe(true);
    });
  });
});
