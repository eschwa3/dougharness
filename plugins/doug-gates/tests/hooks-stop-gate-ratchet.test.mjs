import { describe, it, expect, afterEach } from "vitest";
import { writeFileSync, appendFileSync, mkdirSync, readFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { makeProject, runHookScript } from "./helpers.mjs";
// card stop-gate-skips-orphan-subagent-stops: the state file the test seeds directly is written/read through
// loadState/saveState (the module's own default shape), never a guessed JSON literal.
import { loadState, saveState } from "../lib/state.mjs";
import { baseConfig } from "./hooks-fixtures.mjs";
// card verified-tree-record: records are built and inspected through the lib itself.
import { computeTree, readRecord, writeRecord as writeTreeRecord, RECORD_RELPATH } from "../lib/verified-tree.mjs";
// Load-proofing (card gate-docs-skip-unless-named, same mechanism as 7d1c99b): vitest's worker answers its main
// process over an RPC whose calls time out after 60 s, and this file's cases spawn synchronously (git, hook
// scripts, the gate's own commands), awaiting only microtasks between tests, so the loop never turned and the
// replies queued behind the whole run. One macrotask turn after each test lets them through.
afterEach(() => new Promise((resolve) => setTimeout(resolve, 0)));

describe("card test-count-ratchet (end to end)", () => {
  const CMD = "cat summary.txt";
  const LAST_GREEN = ".doug/.state/test-totals.json";
  const WAIVERS = ".doug/.state/test-count-waivers";
  const T = { total: 137, skipped: 0, todo: 0 }; // the session's baseline unless a case says otherwise

  // The vitest summary block, colour off, for the given counts (total includes skipped and todo).
  const summary = ({ total, skipped = 0, todo = 0 }) => {
    const segs = [];
    if (total - skipped - todo > 0) segs.push(`${total - skipped - todo} passed`);
    if (skipped) segs.push(`${skipped} skipped`);
    if (todo) segs.push(`${todo} todo`);
    return ` Test Files  1 passed (1)\n      Tests  ${segs.join(" | ")} (${total})\n   Start at  08:34:30\n   Duration  242ms\n`;
  };
  const waiver = (t, s, d, reason = "removed the obsolete suite") => `test-count-waiver: total=${t} skipped=${s} todo=${d}; ${reason}`;

  // A real session, through the real hook scripts: last-green record (optional) -> SessionStart -> edits ->
  // optional commit carrying a waiver line -> the command's output on disk. Returns the project dir.
  function makeCountProject({ lastGreen, output, commitMsg, preBaselineCommitMsg, waiverFile, waiverFileAsDir, command = CMD } = {}) {
    const cfg = { ...baseConfig, commands: { test: command } };
    const dir = makeProject({ config: cfg, git: true });
    writeFileSync(join(dir, ".gitignore"), ".doug/.state/\n");
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src/a.ts"), "base");
    writeFileSync(join(dir, "src/b.ts"), "base");
    execFileSync("git", ["add", "-A"], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", "base"], { cwd: dir });
    if (preBaselineCommitMsg) execFileSync("git", ["commit", "-q", "--allow-empty", "-m", preBaselineCommitMsg], { cwd: dir });
    mkdirSync(join(dir, ".doug/.state"), { recursive: true });
    if (lastGreen !== undefined) writeFileSync(join(dir, LAST_GREEN), typeof lastGreen === "string" ? lastGreen : JSON.stringify(lastGreen));
    runHookScript("session-start-baseline", { hook_event_name: "SessionStart", source: "startup" }, { dir });
    if (waiverFileAsDir) mkdirSync(join(dir, WAIVERS));
    else if (waiverFile !== undefined) writeFileSync(join(dir, WAIVERS), waiverFile);
    writeFileSync(join(dir, "src/a.ts"), "edited this session");
    runHookScript("edit-loop", { tool_name: "Edit", tool_input: { file_path: "src/a.ts" } }, { dir });
    if (commitMsg) {
      execFileSync("git", ["add", "src/a.ts"], { cwd: dir });
      execFileSync("git", ["commit", "-q", "-m", commitMsg], { cwd: dir });
      writeFileSync(join(dir, "src/b.ts"), "edited after the commit"); // keep a dirty change so the gate still has work
      runHookScript("edit-loop", { tool_name: "Edit", tool_input: { file_path: "src/b.ts" } }, { dir });
    }
    if (output !== undefined) writeFileSync(join(dir, "summary.txt"), output);
    return dir;
  }
  const stop = (dir) => runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
  const readJson = (dir, rel) => JSON.parse(readFileSync(join(dir, rel), "utf8"));
  const sessionState = (dir) => readJson(dir, ".doug/.state/test-session.json");
  const traceReasons = (dir) => {
    const file = join(dir, ".doug/.state/trace/test-session.jsonl");
    if (!existsSync(file)) return [];
    return readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).map((l) => l.reason).filter((x) => typeof x === "string");
  };
  const green = (r) => {
    expect(r.json, "expected an allow with no message").toBeNull();
  };
  const blocked = (r) => {
    expect(r.json && r.json.decision).toBe("block");
    return r.json.reason;
  };

  describe("SessionStart copies the last-green record (D1)", () => {
    it("copies the last-green record into state.testTotals in the same write as the baseline", () => {
      const record = { [CMD]: { total: 137, skipped: 4, todo: 2 } };
      const dir = makeCountProject({ lastGreen: record });
      const state = sessionState(dir);
      expect(state.testTotals).toEqual(record);
      expect(state.baselineSource).toBe("session-start");
    });
    it("leaves state.testTotals null when there is no record, and does not fail", () => {
      const dir = makeCountProject({});
      const state = sessionState(dir);
      expect(state).toHaveProperty("testTotals", null);
      expect(state.baseline).not.toBeNull();
    });
    it("never overwrites a non-null state.testTotals", () => {
      const dir = makeProject({ config: baseConfig, git: true });
      mkdirSync(join(dir, ".doug/.state"), { recursive: true });
      runHookScript("edit-loop", { tool_name: "Edit", tool_input: { file_path: "src/a.ts" } }, { dir }); // creates the state file, baseline still null
      const state = loadState(dir, "test-session");
      state.testTotals = { [CMD]: { total: 50, skipped: 1, todo: 1 } };
      saveState(dir, "test-session", state);
      writeFileSync(join(dir, LAST_GREEN), JSON.stringify({ [CMD]: { total: 999, skipped: 0, todo: 0 } }));
      const r = runHookScript("session-start-baseline", { hook_event_name: "SessionStart", source: "startup" }, { dir });
      expect(r.status).toBe(0);
      const after = sessionState(dir);
      expect(after.baseline).not.toBeNull(); // this fire did capture the baseline...
      expect(after.testTotals).toEqual({ [CMD]: { total: 50, skipped: 1, todo: 1 } }); // ...and left the existing totals alone
    });
    it("a garbage last-green file leaves state.testTotals null, exits 0, prints no fail-open message", () => {
      const dir = makeProject({ config: baseConfig, git: true });
      mkdirSync(join(dir, ".doug/.state"), { recursive: true });
      writeFileSync(join(dir, LAST_GREEN), "{{{ not json \u0000\u0001");
      const r = runHookScript("session-start-baseline", { hook_event_name: "SessionStart", source: "startup" }, { dir });
      expect(r.status).toBe(0);
      expect(r.json).toBeNull();
      expect(sessionState(dir).testTotals).toBeNull();
    });
    it("a last-green path that is a directory leaves state.testTotals null and does not fail", () => {
      const dir = makeProject({ config: baseConfig, git: true });
      mkdirSync(join(dir, LAST_GREEN), { recursive: true });
      const r = runHookScript("session-start-baseline", { hook_event_name: "SessionStart", source: "startup" }, { dir });
      expect(r.status).toBe(0);
      expect(r.json).toBeNull();
      expect(sessionState(dir).testTotals).toBeNull();
    });
  });

  describe("the block (D6)", () => {
    it("a dropped test blocks and the reason names both numbers", () => {
      const dir = makeCountProject({ lastGreen: { [CMD]: T }, output: summary({ total: 131 }) }); // skipped and todo unchanged at 0
      const reason = blocked(stop(dir));
      expect(reason).toContain("137");
      expect(reason).toContain("131");
      expect(reason).not.toContain("failed (exit"); // a count problem is not a failed command (D9)
    });
    it("an added it.skip blocks (skipped rose, total unchanged) and the reason names both numbers", () => {
      const dir = makeCountProject({ lastGreen: { [CMD]: { total: 137, skipped: 11, todo: 0 } }, output: summary({ total: 137, skipped: 19 }) });
      const reason = blocked(stop(dir));
      expect(reason).toContain("11");
      expect(reason).toContain("19");
    });
    it("a todo that rose blocks (total and skipped unchanged) and the reason names both numbers", () => {
      const dir = makeCountProject({ lastGreen: { [CMD]: { total: 137, skipped: 0, todo: 21 } }, output: summary({ total: 137, todo: 29 }) });
      const reason = blocked(stop(dir));
      expect(reason).toContain("21");
      expect(reason).toContain("29");
    });
    it("a rise in total with skipped and todo falling passes", () => {
      const dir = makeCountProject({ lastGreen: { [CMD]: { total: 137, skipped: 19, todo: 21 } }, output: summary({ total: 140, skipped: 11, todo: 12 }) });
      green(stop(dir));
    });
    it("unchanged totals pass", () => {
      const dir = makeCountProject({ lastGreen: { [CMD]: { total: 137, skipped: 4, todo: 2 } }, output: summary({ total: 137, skipped: 4, todo: 2 }) });
      green(stop(dir));
    });
    it("a blocked count records no verified tree and leaves the last-green record as it was (D9)", () => {
      const record = { [CMD]: T };
      const dir = makeCountProject({ lastGreen: record, output: summary({ total: 131 }) });
      blocked(stop(dir));
      expect(sessionState(dir).verified ?? null).toBeNull();
      expect(readJson(dir, LAST_GREEN)).toEqual(record);
    });
    it("compares only the same command's baseline: a command with no entry gets no check, logged (D2)", () => {
      const dir = makeCountProject({ lastGreen: { "some other command": T }, output: summary({ total: 5 }) });
      green(stop(dir));
      expect(traceReasons(dir).some((x) => /count check/i.test(x) && /baseline/i.test(x))).toBe(true);
    });
    it("a main-checkout run compares against the last-green record, not the session-start copy (card ratchet-stale-session-baseline)", () => {
      const dir = makeCountProject({ lastGreen: { [CMD]: T }, output: summary({ total: 131 }) });
      // Another seat goes green at 131 after this session started and rewrites the shared record: 131 is not a drop from it.
      writeFileSync(join(dir, LAST_GREEN), JSON.stringify({ [CMD]: { total: 131, skipped: 0, todo: 0 } }));
      green(stop(dir));
      expect(sessionState(dir).testTotals).toEqual({ [CMD]: T }); // the session copy itself is untouched
    });
  });

  describe("the last-green record (D1)", () => {
    it("a green run writes its totals for the command", () => {
      const dir = makeCountProject({ lastGreen: { [CMD]: T }, output: summary({ total: 140 }) });
      green(stop(dir));
      expect(readJson(dir, LAST_GREEN)[CMD]).toEqual([{ total: 140, skipped: 0, todo: 0 }]); // ADR 0013: a list
    });
    it("a first green run with no baseline creates the record", () => {
      const dir = makeCountProject({ output: summary({ total: 12, skipped: 1 }) });
      expect(existsSync(join(dir, LAST_GREEN))).toBe(false);
      green(stop(dir));
      expect(readJson(dir, LAST_GREEN)[CMD]).toEqual([{ total: 12, skipped: 1, todo: 0 }]); // ADR 0013: a list
    });
    it("a red run (command exits non-zero) writes no record", () => {
      const dir = makeCountProject({ output: summary({ total: 12 }), command: "cat summary.txt; exit 1" });
      const reason = blocked(stop(dir));
      expect(reason).toContain("failed (exit 1)");
      expect(existsSync(join(dir, LAST_GREEN))).toBe(false);
    });
    it("a green run whose output has no summary writes no entry", () => {
      const dir = makeCountProject({ output: "all fine\n" });
      green(stop(dir));
      const has = existsSync(join(dir, LAST_GREEN)) && readJson(dir, LAST_GREEN)[CMD] !== undefined;
      expect(has).toBe(false);
    });
  });

  describe("waivers (D7)", () => {
    const dropped = () => ({ lastGreen: { [CMD]: T }, output: summary({ total: 131 }) }); // delta: total=-6 skipped=0 todo=0
    it("a covering waiver in a commit message since the baseline passes", () => {
      green(stop(makeCountProject({ ...dropped(), commitMsg: `prune tests\n\n${waiver("-6", "0", "0")}\n` })));
    });
    it("fixture check: with a commit since the baseline the gate still runs the command (a red command blocks)", () => {
      const dir = makeCountProject({ output: summary({ total: 5 }), commitMsg: "some commit", command: "cat summary.txt; exit 1" });
      expect(blocked(stop(dir))).toContain("failed (exit 1)");
    });
    it("a covering waiver in the waiver file passes", () => {
      green(stop(makeCountProject({ ...dropped(), waiverFile: `# waivers\n${waiver("-6", "+0", "-0")}\n` })));
    });
    it("a waiver that differs from the actual delta in total only does not pass", () => {
      const reason = blocked(stop(makeCountProject({ ...dropped(), commitMsg: waiver("-5", "0", "0") })));
      expect(reason).toContain("131");
    });
    it("a waiver-file line that differs in total only does not pass", () => {
      blocked(stop(makeCountProject({ ...dropped(), waiverFile: waiver("-7", "0", "0") + "\n" })));
    });
    it("a waiver that differs in skipped only does not pass", () => {
      blocked(stop(makeCountProject({ ...dropped(), commitMsg: waiver("-6", "+1", "0") })));
    });
    it("a waiver that differs in todo only does not pass", () => {
      blocked(stop(makeCountProject({ ...dropped(), commitMsg: waiver("-6", "0", "-1") })));
    });
    it("a waiver with an empty reason does not pass", () => {
      blocked(stop(makeCountProject({ ...dropped(), commitMsg: "test-count-waiver: total=-6 skipped=0 todo=0; " })));
      blocked(stop(makeCountProject({ ...dropped(), waiverFile: "test-count-waiver: total=-6 skipped=0 todo=0;\n" })));
    });
    it("a waiver in a commit made before the session's baseline does not pass", () => {
      blocked(stop(makeCountProject({ ...dropped(), preBaselineCommitMsg: waiver("-6", "0", "0") })));
    });
    it("a covering waiver passes a skipped rise; one number off does not (the delta is now minus baseline)", () => {
      const rose = { lastGreen: { [CMD]: { total: 137, skipped: 11, todo: 0 } }, output: summary({ total: 137, skipped: 19 }) };
      green(stop(makeCountProject({ ...rose, commitMsg: waiver("0", "+8", "0") })));
      blocked(stop(makeCountProject({ ...rose, commitMsg: waiver("0", "+7", "0") })));
    });
    it("an unreadable or garbage waiver file never throws: the gate still blocks on the count", () => {
      const garbage = makeCountProject({ ...dropped(), waiverFile: "\u0000\u0001\u0002 not a waiver �\n" });
      expect(blocked(stop(garbage))).toContain("131");
      const asDir = makeCountProject({ ...dropped(), waiverFileAsDir: true });
      expect(blocked(stop(asDir))).toContain("131");
    });
  });

  // ADR 0013 replaces the D5 "conflicting summaries fail closed" describe: differing summaries are an ordered
  // list, compared with the baseline's list (one entry per Tests line). Shapes: state.testTotals[cmd] and the
  // last-green entry are arrays [{total,skipped,todo}, ...]; the old {total,skipped,todo} is read as a list of one.
  describe("per-package summaries: the baseline is a list (ADR 0013)", () => {
    const P1 = { total: 100, skipped: 0, todo: 0 };
    const P2 = { total: 37, skipped: 0, todo: 0 };
    const two = [P1, P2];
    const out2 = (a, b) => summary(a) + summary(b);
    const countNotes = (dir) => {
      const file = join(dir, ".doug/.state/trace/test-session.jsonl");
      if (!existsSync(file)) return [];
      return readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((l) => l.event === "CountCheck");
    };

    it("(a) baseline of 2 summaries, run prints 2 whose sums hold: passes, and last-green keeps the 2-entry list", () => {
      const dir = makeCountProject({ lastGreen: { [CMD]: two }, output: out2(P1, P2) });
      expect(sessionState(dir).testTotals[CMD]).toEqual(two); // fixture check: the list reached state as written
      green(stop(dir));
      expect(readJson(dir, LAST_GREEN)[CMD]).toEqual(two);
    });
    it("(a2) a rise in the summed total with the same number of summaries passes; skipped may fall", () => {
      green(stop(makeCountProject({ lastGreen: { [CMD]: two }, output: out2({ total: 105 }, P2) })));
    });
    it("(b) same count, summed total dropped: blocks with today's regression text, naming both sums", () => {
      const dir = makeCountProject({ lastGreen: { [CMD]: two }, output: out2(P1, { total: 31 }) });
      const reason = blocked(stop(dir));
      expect(reason).toContain("test count regressed");
      expect(reason).toContain("total dropped from 137 (baseline) to 131 (now)");
      expect(reason).toContain("test-count-waiver: total=-6 skipped=0 todo=0");
    });
    it("(b2) the drop is in the second summary only: the sum catches it (comparing only the first summary would pass)", () => {
      blocked(stop(makeCountProject({ lastGreen: { [CMD]: two }, output: out2(P1, { total: 20 }) })));
    });
    it("(b3) a drop in one summary offset by a rise in the other is level in sum and passes", () => {
      green(stop(makeCountProject({ lastGreen: { [CMD]: two }, output: out2({ total: 90 }, { total: 47 }) })));
    });
    it("(b4) skipped rising across the sum blocks with the skipped text", () => {
      const reason = blocked(stop(makeCountProject({ lastGreen: { [CMD]: two }, output: out2(P1, { total: 37, skipped: 3 }) })));
      expect(reason).toContain("skipped rose from 0 (baseline) to 3 (now)");
    });
    it("(b5) a matching waiver, in a commit message or the waiver file, covers a same-count drop", () => {
      const run = { lastGreen: { [CMD]: two }, output: out2(P1, { total: 31 }) };
      green(stop(makeCountProject({ ...run, commitMsg: `prune\n\n${waiver("-6", "0", "0")}\n` })));
      green(stop(makeCountProject({ ...run, waiverFile: waiver("-6", "0", "0") + "\n" })));
    });
    it("(c) baseline 1, run prints 2 (a forged extra line): blocks, no waiver covers it, the reason names 1 and 2", () => {
      const forged = summary(T) + "      Tests  1 passed (1)\n";
      const any = [waiver("0", "0", "0"), waiver("+1", "0", "0"), waiver("-136", "0", "0"), waiver("-100", "0", "0")].join("\n");
      const dir = makeCountProject({ lastGreen: { [CMD]: [T] }, output: forged, commitMsg: any, waiverFile: any });
      const reason = blocked(stop(dir));
      expect(reason).toMatch(/summar/i);
      expect(reason).toMatch(/\b1\b/);
      expect(reason).toMatch(/\b2\b/);
      expect(sessionState(dir).verified ?? null).toBeNull();
      expect(readJson(dir, LAST_GREEN)).toEqual({ [CMD]: [T] }); // a block leaves last-green alone
    });
    it("(c2) the forged line is the same as the real one (byte-identical duplicate): still two summaries, blocks against 1", () => {
      blocked(stop(makeCountProject({ lastGreen: { [CMD]: [T] }, output: summary(T) + summary(T) })));
    });
    it("(c3) an old-shape baseline {total,skipped,todo} is a list of one: a forged second summary blocks", () => {
      blocked(stop(makeCountProject({ lastGreen: { [CMD]: T }, output: summary(T) + "      Tests  1 passed (1)\n" })));
    });
    it("(d) baseline 2, run prints 1: blocks, no waiver covers it, the reason names 2 and 1", () => {
      const any = [waiver("0", "0", "0"), waiver("-37", "0", "0"), waiver("+0", "0", "0")].join("\n");
      const reason = blocked(stop(makeCountProject({ lastGreen: { [CMD]: two }, output: summary({ total: 137 }), commitMsg: any, waiverFile: any })));
      expect(reason).toMatch(/summar/i);
      expect(reason).toMatch(/\b2\b/);
      expect(reason).toMatch(/\b1\b/);
    });
    it("(d2) a count mismatch is not a conflict message and not a failed command", () => {
      const reason = blocked(stop(makeCountProject({ lastGreen: { [CMD]: two }, output: summary({ total: 137 }) })));
      expect(reason).not.toMatch(/conflict/i);
      expect(reason).not.toContain("failed (exit");
    });
    it("(e) no baseline, run prints 3 differing summaries: never blocks, logs a CountCheck line, writes the 3-entry list to last-green", () => {
      const three = [{ total: 5 }, { total: 9, skipped: 2 }, { total: 1 }];
      const dir = makeCountProject({ output: three.map(summary).join("") });
      green(stop(dir));
      const notes = countNotes(dir);
      expect(notes.some((n) => /baseline/i.test(n.reason)), JSON.stringify(notes)).toBe(true);
      expect(readJson(dir, LAST_GREEN)[CMD]).toEqual([
        { total: 5, skipped: 0, todo: 0 },
        { total: 9, skipped: 2, todo: 0 },
        { total: 1, skipped: 0, todo: 0 },
      ]);
    });
    it("(e1) no baseline: the CountCheck trace line carries each summary's values (ADR 0013), not only a count", () => {
      const dir = makeCountProject({ output: summary({ total: 311 }) + summary({ total: 523 }) });
      green(stop(dir));
      const notes = countNotes(dir).filter((n) => /baseline/i.test(n.reason));
      expect(notes.length, JSON.stringify(countNotes(dir))).toBeGreaterThan(0);
      expect(notes[0].reason).toContain("311");
      expect(notes[0].reason).toContain("523");
    });
    it("(e2) no baseline, a forged-looking 1 and 137 pair never blocks either", () => {
      green(stop(makeCountProject({ output: `      Tests  1 passed (1)\n${summary(T)}` })));
    });
    it("(e3) a baseline for a different command is no baseline: 3 differing summaries pass", () => {
      green(stop(makeCountProject({ lastGreen: { "some other command": two }, output: [5, 9, 1].map((n) => summary({ total: n })).join("") })));
    });
    it("(f) an old-shape baseline {total,skipped,todo} and a run printing 1 summary works as today: equal passes, a drop blocks, and a waiver covers it", () => {
      green(stop(makeCountProject({ lastGreen: { [CMD]: T }, output: summary(T) })));
      const dropped = { lastGreen: { [CMD]: T }, output: summary({ total: 131 }) };
      expect(blocked(stop(makeCountProject(dropped)))).toContain("total dropped from 137 (baseline) to 131 (now)");
      green(stop(makeCountProject({ ...dropped, commitMsg: waiver("-6", "0", "0") })));
    });
    it("(f2) after a green run the old-shape baseline is rewritten as the list of one", () => {
      const dir = makeCountProject({ lastGreen: { [CMD]: T }, output: summary({ total: 140 }) });
      green(stop(dir));
      expect(readJson(dir, LAST_GREEN)[CMD]).toEqual([{ total: 140, skipped: 0, todo: 0 }]);
    });
    it("(h) a garbage list baseline (a non-numeric entry, an empty list) is no baseline: no throw, no block, trace says so", () => {
      for (const bad of [[], [P1, { total: "many" }], [P1, null]]) {
        const dir = makeCountProject({ lastGreen: { [CMD]: bad }, output: out2(P1, { total: 1 }) });
        green(stop(dir));
        expect(traceReasons(dir).some((x) => /count check/i.test(x) && /baseline/i.test(x)), JSON.stringify(bad)).toBe(true);
      }
    });
    it("(i) a run printing the same number of summaries as an unrelated shorter list is not mistaken: baseline 3, run prints 2 blocks", () => {
      blocked(stop(makeCountProject({ lastGreen: { [CMD]: [P1, P2, { total: 3, skipped: 0, todo: 0 }] }, output: out2(P1, P2) })));
    });
  });

  describe("no check when there is nothing to compare (D8)", () => {
    it("no summary line passes and leaves a trace line saying the count check did not run", () => {
      const dir = makeCountProject({ lastGreen: { [CMD]: T }, output: "everything passed, honest\n" });
      green(stop(dir));
      expect(traceReasons(dir).some((x) => /count check/i.test(x) && /summary/i.test(x))).toBe(true);
    });
    it("an unparseable summary passes with the same trace line", () => {
      const dir = makeCountProject({ lastGreen: { [CMD]: T }, output: "      Tests  lots passed (many)\n" });
      green(stop(dir));
      expect(traceReasons(dir).some((x) => /count check/i.test(x) && /summary/i.test(x))).toBe(true);
    });
    it("a `no tests` summary passes with the trace line", () => {
      const dir = makeCountProject({ lastGreen: { [CMD]: T }, output: "      Tests  no tests\n" });
      green(stop(dir));
      expect(traceReasons(dir).some((x) => /count check/i.test(x) && /summary/i.test(x))).toBe(true);
    });
    it("no baseline passes and leaves a trace line saying the count check did not run", () => {
      const dir = makeCountProject({ output: summary({ total: 5 }) });
      green(stop(dir));
      expect(traceReasons(dir).some((x) => /count check/i.test(x) && /baseline/i.test(x))).toBe(true);
    });
    it("a garbage last-green file means no baseline: the gate decides on its own checks, no fail-open message", () => {
      const dir = makeCountProject({ lastGreen: "{{{ nope", output: summary({ total: 5 }) });
      green(stop(dir));
      expect(traceReasons(dir).some((x) => /count check/i.test(x))).toBe(true);
    });
    it("a garbage state.testTotals does not throw the gate", () => {
      const dir = makeCountProject({ output: summary({ total: 5 }) });
      const state = loadState(dir, "test-session");
      state.testTotals = "junk";
      saveState(dir, "test-session", state);
      green(stop(dir));
    });
    it("a baseline entry that is not numbers does not throw the gate", () => {
      const dir = makeCountProject({ output: summary({ total: 5 }) });
      const state = loadState(dir, "test-session");
      state.testTotals = { [CMD]: { total: "many", skipped: null } };
      saveState(dir, "test-session", state);
      green(stop(dir));
    });
  });

  describe("review m4: a baseline entry with a negative or fractional count is no baseline", () => {
    // Each case would block if the entry were compared: a fractional total above the run's, a negative skipped
    // below the run's 0 (a "rise"), a negative todo likewise.
    const cases = [
      ["fractional total", { total: 137.5, skipped: 0, todo: 0 }, summary({ total: 137 })],
      ["negative skipped", { total: 137, skipped: -3, todo: 0 }, summary({ total: 137 })],
      ["negative todo", { total: 137, skipped: 0, todo: -2 }, summary({ total: 137 })],
      ["fractional skipped", { total: 137, skipped: 0.5, todo: 0 }, summary({ total: 137, skipped: 1 })],
    ];
    for (const [name, entry, output] of cases) {
      it(`${name}: not compared, the gate passes and the trace says there is no baseline`, () => {
        const dir = makeCountProject({ lastGreen: { [CMD]: entry }, output });
        expect(sessionState(dir).testTotals[CMD]).toEqual(entry); // fixture check: the entry reached state as written
        green(stop(dir));
        expect(traceReasons(dir).some((x) => /count check/i.test(x) && /baseline/i.test(x))).toBe(true);
      });
    }
  });

  describe("review m2: count-check notes honour trace.enabled false", () => {
    it("a no-summary run passes and writes no trace file", () => {
      const dir = makeCountProject({ lastGreen: { [CMD]: T }, output: "everything passed, honest\n" });
      writeFileSync(join(dir, ".doug/config.json"), JSON.stringify({ ...baseConfig, commands: { test: CMD }, trace: { enabled: false } }));
      green(stop(dir));
      expect(existsSync(join(dir, ".doug/.state/trace/test-session.jsonl"))).toBe(false);
      expect(traceReasons(dir)).toEqual([]);
    });
    it("control: with trace enabled the same run does leave the count-check line", () => {
      const dir = makeCountProject({ lastGreen: { [CMD]: T }, output: "everything passed, honest\n" });
      writeFileSync(join(dir, ".doug/config.json"), JSON.stringify({ ...baseConfig, commands: { test: CMD }, trace: { enabled: true } }));
      green(stop(dir));
      expect(traceReasons(dir).some((x) => /count check/i.test(x))).toBe(true);
    });
  });

  describe("review m1: a count problem is not a failed command for the tests_red_by_design claim (D9)", () => {
    const GREEN_CMD = "cat green.txt";
    const RED_CMD = "echo ' FAIL  tests/a.test.mjs > it'; exit 1";
    function testerProject(greenOutput) {
      const dir = makeProject({ config: { ...baseConfig, commands: { red: RED_CMD, counted: GREEN_CMD }, stopGate: { ...baseConfig.stopGate, commands: ["red", "counted"] } }, git: true });
      mkdirSync(join(dir, "tests"));
      writeFileSync(join(dir, "tests/a.test.mjs"), "it fails on purpose");
      writeFileSync(join(dir, "green.txt"), greenOutput);
      runHookScript("edit-loop", { tool_name: "Write", tool_input: { file_path: "tests/a.test.mjs" }, agent_id: "ag1", agent_type: "tester" }, { dir });
      const state = loadState(dir, "test-session");
      state.testTotals = { [GREEN_CMD]: T };
      saveState(dir, "test-session", state);
      return dir;
    }
    const claimInput = { hook_event_name: "SubagentStop", agent_id: "ag1", agent_type: "tester", last_assistant_message: `Red as designed.\n${JSON.stringify({ tests_red_by_design: ["tests/a.test.mjs"] })}` };
    it("control: the red command alone, the green one at its baseline, is allowed by the claim", () => {
      const r = runHookScript("stop-gate", claimInput, { dir: testerProject(summary(T)) });
      expect(r.json.decision).toBeUndefined();
      expect(r.json.systemMessage).toContain("stopped with tests red by design: tests/a.test.mjs");
    });
    it("the same scenario with the green command's total dropped blocks, naming the count problem", () => {
      const r = runHookScript("stop-gate", claimInput, { dir: testerProject(summary({ total: 131 })) });
      expect(r.json.decision).toBe("block");
      expect(r.json.reason).toContain("test count regressed");
      expect(r.json.reason).toContain("137");
      expect(r.json.reason).toContain("131");
    });
  });
});

// card trace-redact-secrets (T9): the trace script passes the project's secrets config to the line builder.
// The token is built by concatenation so this file never holds a whole token.
describe("trace script redaction (card trace-redact-secrets)", () => {
  const GH = "ghp_" + "aB3dE5gH7jK9mN1pQ3sT5vX7zA9cE1gI3kM5";
  const input = { hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "tu1", tool_input: { command: "echo " + GH } };
  const lines = (dir) =>
    readFileSync(join(dir, ".doug/.state/trace/test-session.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));

  it("T9 default config writes the token redacted; a config disabling githubToken writes it unredacted", () => {
    const def = makeProject({ config: { trace: { enabled: true } }, git: true });
    runHookScript("trace", input, { dir: def });
    const [l1] = lines(def);
    expect(l1.detail).toBe("[redacted: githubToken]");
    expect(readFileSync(join(def, ".doug/.state/trace/test-session.jsonl"), "utf8")).not.toContain(GH.slice(0, 12));

    const off = makeProject({ config: { trace: { enabled: true }, secrets: { rules: { githubToken: false } } }, git: true });
    runHookScript("trace", input, { dir: off });
    const [l2] = lines(off);
    expect(l2.detail).toContain(GH);
  });
});

// card gate-skip-readonly-researchers: a SubagentStop whose agent changed nothing in the working tree since it
// started (same HEAD, same tree identities) skips the verification commands even when the run trace shows Bash
// lines (so no-agent-changes cannot apply). The start fingerprint is recorded by the trace hook on
// SubagentStart; these tests fire that hook for real and pin behaviour, not where the fingerprint is stored.
describe("card gate-skip-readonly-researchers", () => {
  const runsLogRelpath = ".doug/.state/runs.log";
  const runsCount = (dir) => (existsSync(join(dir, runsLogRelpath)) ? readFileSync(join(dir, runsLogRelpath), "utf8").length : 0);

  function makeConfig() {
    return {
      ...baseConfig,
      commands: { "test:unit": `${process.execPath} -e "require('fs').appendFileSync('${runsLogRelpath}','x')"` },
      stopGate: { commands: ["test:unit"], onlyIfEdited: true, maxBlocks: 3, timeoutMs: 10000, requireEvidence: false },
      trace: { enabled: true },
    };
  }

  // Committed base plus a file this session edited before any agent started (dirty at start).
  function makeEditedProject() {
    const dir = makeProject({ config: makeConfig(), git: true });
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src/a.ts"), "base");
    execFileSync("git", ["add", "-A"], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", "base"], { cwd: dir });
    writeFileSync(join(dir, "src/a.ts"), "edited before the agent started");
    runHookScript("edit-loop", { tool_name: "Edit", tool_input: { file_path: "src/a.ts" } }, { dir });
    return dir;
  }

  const agentIds = (id, type) => ({ agent_id: id, agent_type: type });
  const fireStart = (dir, id, type) => runHookScript("trace", { hook_event_name: "SubagentStart", ...agentIds(id, type) }, { dir });
  const fireBash = (dir, id, type) =>
    runHookScript("trace", { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" }, tool_use_id: "tu1", ...agentIds(id, type) }, { dir });
  const stop = (dir, id, type, extra = {}) =>
    runHookScript("stop-gate", { hook_event_name: "SubagentStop", ...agentIds(id, type), ...extra }, { dir });
  const traceLines = (dir) => {
    const file = join(dir, ".doug/.state/trace/test-session.jsonl");
    return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  };

  it("(a) a researcher with a Bash line whose tree is unchanged since SubagentStart stops without a gate run, reason tree-unchanged", () => {
    const dir = makeEditedProject();
    fireStart(dir, "ag1", "researcher");
    fireBash(dir, "ag1", "researcher");
    const r = stop(dir, "ag1", "researcher");
    expect(r.json, "an unchanged tree must be allowed").toBeNull();
    expect(runsCount(dir), "no verification command may run").toBe(0);
    const line = traceLines(dir).find((l) => l.event === "SubagentStop");
    expect(line, "a SubagentStop trace line").toBeTruthy();
    expect(line.reason).toBe("tree-unchanged");
    expect(line.decision).toBe("allow");
  });

  it("(b) the agent edits a tracked file between start and stop: the gate runs", () => {
    const dir = makeEditedProject();
    fireStart(dir, "ag1", "researcher");
    fireBash(dir, "ag1", "researcher");
    writeFileSync(join(dir, "src/a.ts"), "edited again during the agent's life");
    stop(dir, "ag1", "researcher");
    expect(runsCount(dir)).toBe(1);
  });

  it("(b2) the agent creates an untracked file between start and stop: the gate runs", () => {
    const dir = makeEditedProject();
    fireStart(dir, "ag1", "researcher");
    fireBash(dir, "ag1", "researcher");
    writeFileSync(join(dir, "src/new.ts"), "created during the agent's life");
    stop(dir, "ag1", "researcher");
    expect(runsCount(dir)).toBe(1);
  });

  it("(c) a tester with an unchanged tree but a tests_red_by_design claim still runs the gate", () => {
    const dir = makeEditedProject();
    fireStart(dir, "ag1", "tester");
    fireBash(dir, "ag1", "tester");
    stop(dir, "ag1", "tester", {
      last_assistant_message: `Tests are red as designed.\n${JSON.stringify({ tests_red_by_design: ["src/a.ts"] })}`,
    });
    expect(runsCount(dir)).toBe(1);
  });

  it("(d) no start record for the agent (SubagentStart never went through the hook): the gate runs", () => {
    const dir = makeEditedProject();
    // A coder, not a researcher: a read-only agent type is skipped by the older type rule when no trace line vouches for it.
    fireBash(dir, "ag1", "coder");
    stop(dir, "ag1", "coder");
    expect(runsCount(dir)).toBe(1);
  });

  it("(e) HEAD moves between start and stop with no dirty change: the gate runs", () => {
    const dir = makeEditedProject();
    fireStart(dir, "ag1", "researcher");
    fireBash(dir, "ag1", "researcher");
    execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "moved head"], { cwd: dir });
    stop(dir, "ag1", "researcher");
    expect(runsCount(dir)).toBe(1);
  });

  it("(f) a tester with an unchanged tree whose tests_red_by_design claim is only in the last hand-back still runs the gate", () => {
    const dir = makeEditedProject();
    fireStart(dir, "ag1", "tester");
    fireBash(dir, "ag1", "tester");
    // Outside the project: a file inside it would change the tree after start and make the gate run regardless.
    const transcriptPath = join(mkdtempSync(join(tmpdir(), "doug-f-")), "transcript.jsonl");
    const message = JSON.stringify({ tests_red_by_design: ["src/a.ts"] });
    writeFileSync(
      transcriptPath,
      JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "SubagentHandback", input: { message } }] } }) + "\n",
    );
    stop(dir, "ag1", "tester", { agent_transcript_path: transcriptPath, last_assistant_message: "Report delivered via SubagentHandback." });
    expect(runsCount(dir)).toBe(1);
  });

  it("(g) a successful Edit in the agent's own trace with the tree unchanged since start (no Bash) still runs the gate", () => {
    const dir = makeEditedProject();
    fireStart(dir, "ag1", "coder");
    const edit = { tool_name: "Edit", tool_input: { file_path: "src/a.ts" }, tool_use_id: "tu2", ...agentIds("ag1", "coder") };
    runHookScript("trace", { hook_event_name: "PreToolUse", ...edit }, { dir });
    runHookScript("trace", { hook_event_name: "PostToolUse", tool_response: { success: true }, ...edit }, { dir });
    const post = traceLines(dir).find((l) => l.event === "PostToolUse" && l.tool === "Edit");
    expect(post && post.ok, "fixture: the trace must record the Edit as successful").toBe(true);
    stop(dir, "ag1", "coder");
    expect(runsCount(dir)).toBe(1);
  });
});

describe("card stop-gate-no-test-paths", () => {
  const runsRel = ".doug/.state/runs.log";
  const runs = (dir) => (existsSync(join(dir, runsRel)) ? readFileSync(join(dir, runsRel), "utf8").length : 0);
  const stateOf = (dir) => JSON.parse(readFileSync(join(dir, ".doug/.state/test-session.json"), "utf8"));
  const traceOf = (dir) => {
    const file = join(dir, ".doug/.state/trace/test-session.jsonl");
    return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  };
  const git = (dir, ...args) => execFileSync("git", args, { cwd: dir });
  // Each gate run appends one "x" to runs.log (inside .doug/.state, which the tree fingerprint ignores).
  const cfgWith = (noTestPaths, extra = {}) => {
    const c = {
      ...baseConfig,
      commands: { test: `${process.execPath} -e "require('fs').appendFileSync('${runsRel}','x')"` },
      stopGate: { commands: ["test"], onlyIfEdited: true, maxBlocks: 3, timeoutMs: 10000, requireEvidence: false },
      trace: { enabled: true },
      ...extra,
    };
    if (noTestPaths !== undefined) c.preCommit = { noTestPaths };
    return c;
  };
  const stop = (dir) => runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
  const subStop = (dir) => runHookScript("stop-gate", { hook_event_name: "SubagentStop", agent_id: "agA", agent_type: "coder" }, { dir });

  // A committed base (src/a.ts, docs/x.md, .doug/board.json), then src/a.ts edited this session and a first
  // Stop that runs the gate green: state.verified is recorded with src/a.ts dirty. The run counter is 1 after.
  function makeGreen(config) {
    const dir = makeProject({ config, git: true });
    mkdirSync(join(dir, "src"));
    mkdirSync(join(dir, "docs"));
    writeFileSync(join(dir, "src/a.ts"), "base");
    writeFileSync(join(dir, "docs/x.md"), "base");
    writeFileSync(join(dir, "src/b.ts"), "base b");
    writeFileSync(join(dir, ".doug/board.json"), "{}");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "base");
    writeFileSync(join(dir, "src/a.ts"), "edited this session");
    runHookScript("edit-loop", { tool_name: "Edit", tool_input: { file_path: "src/a.ts" } }, { dir });
    const first = stop(dir);
    expect(first.json, "fixture: the first gate must run green").toBeNull();
    expect(runs(dir), "fixture: the first gate must run the command once").toBe(1);
    expect(stateOf(dir).verified, "fixture: green records state.verified").toBeTruthy();
    return dir;
  }
  const commitOnly = (dir, file) => {
    git(dir, "add", file);
    git(dir, "commit", "-q", "-m", `change ${file}`);
  };

  it("a1 a dirty board-only change since the last green skips: allow, no command, trace reason no-test-paths, lastGate.skipped", () => {
    const dir = makeGreen(cfgWith([".doug/board.json"]));
    writeFileSync(join(dir, ".doug/board.json"), '{"changed":1}');
    const r = stop(dir);
    expect(r.json, JSON.stringify(r.json)).toBeNull();
    expect(runs(dir), "no configured command may run").toBe(1);
    expect(traceOf(dir).some((l) => l.reason === "no-test-paths"), "a trace line must carry reason no-test-paths").toBe(true);
    expect(stateOf(dir).lastGate && stateOf(dir).lastGate.skipped).toBe("no-test-paths");
  });

  it("a2 a committed board-only change since the last green skips the same way", () => {
    const dir = makeGreen(cfgWith([".doug/board.json"]));
    writeFileSync(join(dir, ".doug/board.json"), '{"changed":1}');
    commitOnly(dir, ".doug/board.json");
    const r = stop(dir);
    expect(r.json, JSON.stringify(r.json)).toBeNull();
    expect(runs(dir)).toBe(1);
    expect(traceOf(dir).some((l) => l.reason === "no-test-paths")).toBe(true);
    expect(stateOf(dir).lastGate && stateOf(dir).lastGate.skipped).toBe("no-test-paths");
  });

  it("g1 a source path committed unchanged since verification, then a board-only commit, still skips", () => {
    const dir = makeGreen(cfgWith([".doug/board.json"]));
    commitOnly(dir, "src/a.ts");
    writeFileSync(join(dir, ".doug/board.json"), '{"changed":1}');
    commitOnly(dir, ".doug/board.json");
    const r = stop(dir);
    expect(r.json, JSON.stringify(r.json)).toBeNull();
    expect(runs(dir), "no configured command may run").toBe(1);
    expect(traceOf(dir).some((l) => l.reason === "no-test-paths")).toBe(true);
    expect(stateOf(dir).lastGate && stateOf(dir).lastGate.skipped).toBe("no-test-paths");
  });

  it("g2 a source path whose content changed after verification and was committed runs the gate", () => {
    const dir = makeGreen(cfgWith([".doug/board.json"]));
    writeFileSync(join(dir, "src/a.ts"), "edited after verification");
    commitOnly(dir, "src/a.ts");
    writeFileSync(join(dir, ".doug/board.json"), '{"changed":1}');
    commitOnly(dir, ".doug/board.json");
    const r = stop(dir);
    expect(r.json, JSON.stringify(r.json)).toBeNull();
    expect(runs(dir), "the gate must run").toBe(2);
  });

  it("g3 a committed source path absent from the verified record runs the gate", () => {
    const dir = makeGreen(cfgWith([".doug/board.json"]));
    expect(stateOf(dir).verified.tree["src/b.ts"], "fixture: src/b.ts is not in the record").toBeUndefined();
    writeFileSync(join(dir, "src/b.ts"), "new b");
    commitOnly(dir, "src/b.ts");
    writeFileSync(join(dir, ".doug/board.json"), '{"changed":1}');
    commitOnly(dir, ".doug/board.json");
    const r = stop(dir);
    expect(r.json, JSON.stringify(r.json)).toBeNull();
    expect(runs(dir), "the gate must run").toBe(2);
  });

  it("a3 SubagentStop skips on a board-only change too", () => {
    const dir = makeGreen(cfgWith([".doug/board.json"]));
    writeFileSync(join(dir, ".doug/board.json"), '{"changed":1}');
    const r = subStop(dir);
    expect(r.json, JSON.stringify(r.json)).toBeNull();
    expect(runs(dir)).toBe(1);
    expect(traceOf(dir).some((l) => l.event === "SubagentStop" && l.reason === "no-test-paths")).toBe(true);
  });

  it("b1 a dirty board change plus a dirty source change runs the gate", () => {
    const dir = makeGreen(cfgWith([".doug/board.json"]));
    writeFileSync(join(dir, ".doug/board.json"), '{"changed":1}');
    writeFileSync(join(dir, "src/a.ts"), "edited again");
    stop(dir);
    expect(runs(dir), "a path off the list must run the gate").toBe(2);
  });

  it("b2 a committed board change plus a dirty source change since the green runs the gate", () => {
    const dir = makeGreen(cfgWith([".doug/board.json"]));
    writeFileSync(join(dir, ".doug/board.json"), '{"changed":1}');
    commitOnly(dir, ".doug/board.json");
    writeFileSync(join(dir, "src/a.ts"), "edited again");
    stop(dir);
    expect(runs(dir)).toBe(2);
  });

  it("b3 a committed source change plus a dirty board change runs the gate", () => {
    const dir = makeGreen(cfgWith([".doug/board.json"]));
    writeFileSync(join(dir, "docs/x.md"), "committed change");
    commitOnly(dir, "docs/x.md");
    writeFileSync(join(dir, ".doug/board.json"), '{"changed":1}');
    stop(dir);
    expect(runs(dir)).toBe(2);
  });

  it("c1 a missing noTestPaths list runs the gate", () => {
    const dir = makeGreen(cfgWith(undefined));
    writeFileSync(join(dir, ".doug/board.json"), '{"changed":1}');
    stop(dir);
    expect(runs(dir)).toBe(2);
  });

  it("c2 an empty noTestPaths list runs the gate", () => {
    const dir = makeGreen(cfgWith([]));
    writeFileSync(join(dir, ".doug/board.json"), '{"changed":1}');
    stop(dir);
    expect(runs(dir)).toBe(2);
  });

  it("c3 a list holding a non-string or empty entry runs the gate (fail closed, like pre-commit)", () => {
    const dir = makeGreen(cfgWith([".doug/board.json", 7]));
    writeFileSync(join(dir, ".doug/board.json"), '{"changed":1}');
    stop(dir);
    expect(runs(dir)).toBe(2);
  });

  it("d no prior green verification this session: a board-only change runs the gate", () => {
    const config = cfgWith([".doug/board.json"]);
    const dir = makeProject({ config, git: true });
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src/a.ts"), "base");
    writeFileSync(join(dir, ".doug/board.json"), "{}");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "base");
    writeFileSync(join(dir, ".doug/board.json"), '{"changed":1}');
    runHookScript("edit-loop", { tool_name: "Edit", tool_input: { file_path: ".doug/board.json" } }, { dir });
    stop(dir);
    expect(runs(dir), "with no state.verified there is no baseline to compare against").toBe(1);
  });

  it("e1 a directory entry covers a file under it (prefix rule)", () => {
    const dir = makeGreen(cfgWith(["docs/"]));
    writeFileSync(join(dir, "docs/x.md"), "changed");
    const r = stop(dir);
    expect(r.json, JSON.stringify(r.json)).toBeNull();
    expect(runs(dir)).toBe(1);
    expect(stateOf(dir).lastGate && stateOf(dir).lastGate.skipped).toBe("no-test-paths");
  });

  it("e2 a glob-looking entry does not match (exact semantics, same as pre-commit)", () => {
    const dir = makeGreen(cfgWith(["docs/*"]));
    writeFileSync(join(dir, "docs/x.md"), "changed");
    stop(dir);
    expect(runs(dir)).toBe(2);
  });

  it("f a board-only skip still runs the scans: a protected path on the list still blocks", () => {
    const dir = makeGreen(cfgWith([".doug/board.json"], { protectedPaths: [...baseConfig.protectedPaths, ".doug/board.json"] }));
    writeFileSync(join(dir, ".doug/board.json"), '{"changed":1}');
    const r = stop(dir);
    expect(r.json && r.json.decision).toBe("block");
    expect(r.json.reason).toContain("Protected files were modified");
    expect(runs(dir), "the commands are skipped even though the scan blocks").toBe(1);
  });

  it("g a rename out of a source path into a listed directory runs the gate (moved-from path counts)", () => {
    const dir = makeGreen(cfgWith(["docs/"]));
    git(dir, "mv", "src/b.ts", "docs/b.ts");
    stop(dir);
    expect(runs(dir), "src/b.ts changed (moved away) and is off the list").toBe(2);
  });

  it("h a source file dirty at the green then reverted, plus a board edit, runs the gate", () => {
    const dir = makeGreen(cfgWith([".doug/board.json"]));
    git(dir, "checkout", "--", "src/a.ts");
    writeFileSync(join(dir, ".doug/board.json"), '{"changed":1}');
    stop(dir);
    expect(runs(dir), "the reverted source path moved since the green").toBe(2);
  });

  it("i an exact entry does not cover a sibling path sharing its prefix", () => {
    const dir = makeGreen(cfgWith([".doug/board.json"]));
    writeFileSync(join(dir, ".doug/board.json.bak"), "x");
    stop(dir);
    expect(runs(dir)).toBe(2);
  });

  it("j a no-test-paths skip leaves state.verified unchanged", () => {
    const dir = makeGreen(cfgWith([".doug/board.json"]));
    const before = stateOf(dir).verified;
    writeFileSync(join(dir, ".doug/board.json"), '{"changed":1}');
    const r = stop(dir);
    expect(r.json, JSON.stringify(r.json)).toBeNull();
    expect(stateOf(dir).lastGate && stateOf(dir).lastGate.skipped, "fixture: the skip must have happened").toBe("no-test-paths");
    expect(stateOf(dir).verified).toEqual(before);
  });

  // card no-test-paths-plan-files: .doug/plan.json is a noTestPaths entry in this repo and in doug init's default.
  const PLAN = ".doug/plan.json";
  const writePlan = (dir, body) => writeFileSync(join(dir, PLAN), body);

  it("P1 a plan.json-only change (dirty, then committed) with the list holding it skips: no command, lastGate.skipped no-test-paths", () => {
    const dir = makeGreen(cfgWith([PLAN]));
    writePlan(dir, '{"v":1}');
    const r = stop(dir);
    expect(r.json, JSON.stringify(r.json)).toBeNull();
    expect(runs(dir), "no configured command may run on a dirty plan.json").toBe(1);
    expect(stateOf(dir).lastGate && stateOf(dir).lastGate.skipped).toBe("no-test-paths");
    commitOnly(dir, PLAN);
    const r2 = stop(dir);
    expect(r2.json, JSON.stringify(r2.json)).toBeNull();
    expect(runs(dir), "no configured command may run on a committed plan.json").toBe(1);
    expect(stateOf(dir).lastGate && stateOf(dir).lastGate.skipped).toBe("no-test-paths");
  });

  it("P2 a planner SubagentStop whose only change is plan.json, with the list holding it, runs no command and is allowed", () => {
    const dir = makeGreen(cfgWith([PLAN]));
    writePlan(dir, '{"v":1}');
    const r = runHookScript("stop-gate", { hook_event_name: "SubagentStop", agent_id: "agP", agent_type: "planner" }, { dir });
    expect(r.json, JSON.stringify(r.json)).toBeNull();
    expect(runs(dir), "the planner's plan.json write must not run the suite").toBe(1);
    expect(stateOf(dir).lastGate && stateOf(dir).lastGate.skipped).toBe("no-test-paths");
  });

  it("P3 the same plan.json-only change with the list lacking plan.json runs the gate", () => {
    const dir = makeGreen(cfgWith([".doug/board.json"]));
    writePlan(dir, '{"v":1}');
    stop(dir);
    expect(runs(dir), "plan.json off the list must run the gate").toBe(2);
  });
});

// card verified-tree-record, brief B: the Stop and SubagentStop gates write .doug/.state/verified-tree.json after a
// green run and credit a record of the same tree (or a tree differing only on preCommit.noTestPaths) instead of
// re-running. Every gate command appends to .doug/.state/ran.marker (outside the tree), so a run is countable
// without changing the tree, and prints a vitest Tests line so totals are recorded.
describe("card verified-tree-record", () => {
  const CMD =
    `${process.execPath} -e "const fs=require('fs');fs.mkdirSync('.doug/.state',{recursive:true});` +
    `fs.appendFileSync('.doug/.state/ran.marker','x');console.log(' Tests  3 passed (3)');` +
    `process.exit(fs.existsSync('fail.flag')?1:0)"`;
  const cfgFor = (extra = {}) => ({
    ...baseConfig,
    commands: { test: CMD },
    preCommit: { noTestPaths: [".doug/board.json"] },
    ...extra,
  });
  const git = (dir, ...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
  const commitAll = (dir, msg = "next") => {
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", msg);
  };
  function makeRec(config = cfgFor()) {
    const dir = makeProject({ config, git: true });
    writeFileSync(join(dir, ".gitignore"), ".doug/.state/\n");
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src/a.js"), "base");
    commitAll(dir, "base");
    return dir;
  }
  const tree = (dir) => {
    mkdirSync(join(dir, ".doug/.state"), { recursive: true });
    return computeTree(dir);
  };
  const markEdited = (dir, sid = "test-session") =>
    runHookScript("edit-loop", { session_id: sid, tool_name: "Edit", tool_input: { file_path: "src/a.js" } }, { dir });
  const edit = (dir, content, sid = "test-session") => {
    writeFileSync(join(dir, "src/a.js"), content);
    markEdited(dir, sid);
  };
  const stop = (dir, sid = "test-session") => runHookScript("stop-gate", { session_id: sid, hook_event_name: "Stop" }, { dir });
  const runs = (dir) => {
    const f = join(dir, ".doug/.state/ran.marker");
    return existsSync(f) ? readFileSync(f, "utf8").length : 0;
  };
  const sessionState = (dir, sid = "test-session") => JSON.parse(readFileSync(join(dir, `.doug/.state/${sid}.json`), "utf8"));
  const totalsFor = (total) => ({ [CMD]: { status: "ok", summaries: [{ total, skipped: 0, todo: 0 }], totals: { total, skipped: 0, todo: 0 } } });
  const goodRecord = (dir, over = {}) => ({
    version: 1,
    tree: tree(dir),
    node: process.version,
    at: new Date().toISOString(),
    by: "verify",
    commands: [{ name: "test", command: CMD, exit: 0, durationMs: 5 }],
    totals: totalsFor(3),
    ...over,
  });
  const seed = (dir, over) => {
    writeTreeRecord(dir, goodRecord(dir, over));
  };

  it("R1: a green Stop writes the record for the current tree, with the node version and totals keyed by command", () => {
    const dir = makeRec();
    edit(dir, "edited");
    const r = stop(dir);
    expect(r.json, JSON.stringify(r.json)).toBeNull();
    expect(runs(dir)).toBe(1);
    const rec = readRecord(dir);
    expect(rec, "a green Stop must write .doug/.state/verified-tree.json").not.toBeNull();
    expect(rec.by).toBe("stop");
    expect(rec.tree).toBe(tree(dir));
    expect(rec.node).toBe(process.version);
    expect(rec.commands).toEqual([expect.objectContaining({ name: "test", command: CMD, exit: 0 })]);
    expect(rec.totals[CMD]).toMatchObject({ status: "ok", summaries: [{ total: 3, skipped: 0, todo: 0 }] });
  });

  it("R2: a fresh session credits the record across a commit: no command runs, lastGate.credited is verified-tree, state.verified set", () => {
    const dir = makeRec();
    edit(dir, "edited");
    expect(stop(dir).json).toBeNull();
    expect(runs(dir)).toBe(1);
    commitAll(dir);
    markEdited(dir, "s2");
    const r = stop(dir, "s2");
    expect(r.json, JSON.stringify(r.json)).toBeNull();
    expect(runs(dir), "the recorded commands must not run again").toBe(1);
    const state = sessionState(dir, "s2");
    expect(state.lastGate.ok).toBe(true);
    expect(state.lastGate.results[0]).toMatchObject({ name: "test", ok: true, credited: "verified-tree" });
    expect(state.verified).toBeTruthy();
  });

  it("R3: a fresh session credits the record across a diff that touches only preCommit.noTestPaths", () => {
    const dir = makeRec();
    edit(dir, "edited");
    expect(stop(dir).json).toBeNull();
    writeFileSync(join(dir, ".doug/board.json"), '{"cards":[]}');
    commitAll(dir);
    markEdited(dir, "s2");
    const r = stop(dir, "s2");
    expect(r.json, JSON.stringify(r.json)).toBeNull();
    expect(runs(dir)).toBe(1);
    expect(sessionState(dir, "s2").lastGate.results[0].credited).toBe("verified-tree");
  });

  it("R4: a diff that touches a source file refuses the credit: the commands run and a new record names the new tree", () => {
    const dir = makeRec();
    edit(dir, "edited");
    expect(stop(dir).json).toBeNull();
    const before = readRecord(dir).tree;
    edit(dir, "edited again", "s2");
    const r = stop(dir, "s2");
    expect(r.json, JSON.stringify(r.json)).toBeNull();
    expect(runs(dir)).toBe(2);
    const rec = readRecord(dir);
    expect(rec.tree).not.toBe(before);
    expect(rec.tree).toBe(tree(dir));
  });

  it("R5: a record of a different command set refuses the credit (tree equal, so only the command set differs)", () => {
    // control: the same fixture with a matching record credits, so the refusal below is the poisoned field's doing
    const ctl = makeRec();
    edit(ctl, "edited");
    seed(ctl);
    expect(stop(ctl).json).toBeNull();
    expect(runs(ctl), "control: a matching record must be credited").toBe(0);
    const dir = makeRec();
    edit(dir, "edited");
    seed(dir, { commands: [{ name: "other", command: "some other command", exit: 0, durationMs: 5 }], totals: {} });
    const r = stop(dir);
    expect(r.json, JSON.stringify(r.json)).toBeNull();
    expect(runs(dir)).toBe(1);
  });

  it("R6: a record from another Node version, or a malformed record file, refuses the credit and the hook still exits 0 with a gate result", () => {
    // control: the same fixture with a matching record credits, so the refusal below is the poisoned field's doing
    const ctl = makeRec();
    edit(ctl, "edited");
    seed(ctl);
    expect(stop(ctl).json).toBeNull();
    expect(runs(ctl), "control: a matching record must be credited").toBe(0);
    const dir = makeRec();
    edit(dir, "edited");
    seed(dir, { node: "v0.0.0" });
    const a = stop(dir);
    expect(a.status).toBe(0);
    expect(runs(dir)).toBe(1);

    const dir2 = makeRec();
    edit(dir2, "edited");
    mkdirSync(join(dir2, ".doug/.state"), { recursive: true });
    writeFileSync(join(dir2, RECORD_RELPATH), "{");
    const b = stop(dir2);
    expect(b.status).toBe(0);
    expect(b.json, JSON.stringify(b.json)).toBeNull();
    expect(runs(dir2)).toBe(1);
  });

  it("R7: a red run removes the record", () => {
    const dir = makeRec();
    edit(dir, "edited");
    expect(stop(dir).json).toBeNull();
    expect(readRecord(dir)).not.toBeNull();
    writeFileSync(join(dir, "fail.flag"), "1");
    markEdited(dir, "s2");
    const r = stop(dir, "s2");
    expect(r.json && r.json.decision, JSON.stringify(r.json)).toBe("block");
    expect(runs(dir)).toBe(2);
    expect(existsSync(join(dir, RECORD_RELPATH)), "a red run must remove the record").toBe(false);
  });

  it("R8: the count ratchet applies to the recorded totals of a credited run; a record without totals runs the commands instead", () => {
    const seedBaseline = (dir) => {
      markEdited(dir); // creates the session state
      const state = loadState(dir, "test-session");
      state.testTotals = { [CMD]: { total: 5, skipped: 0, todo: 0 } };
      saveState(dir, "test-session", state);
    };
    const dir = makeRec();
    edit(dir, "edited");
    seedBaseline(dir);
    seed(dir, { totals: totalsFor(4) });
    const r = stop(dir);
    expect(r.json && r.json.decision, JSON.stringify(r.json)).toBe("block");
    expect(r.json.reason).toContain("test count regressed");
    expect(runs(dir), "the credited command must not run").toBe(0);

    const dir2 = makeRec();
    edit(dir2, "edited");
    seedBaseline(dir2);
    seed(dir2, { totals: {} });
    stop(dir2);
    expect(runs(dir2), "a baseline with no readable recorded totals must run the commands").toBe(1);
  });

  it("R9: scans and evidence still run on a credited gate", () => {
    // protected files
    const dir = makeRec();
    runHookScript("session-start-baseline", { hook_event_name: "SessionStart", source: "startup" }, { dir });
    writeFileSync(join(dir, ".env"), "SECRET=1");
    markEdited(dir);
    seed(dir);
    const p = stop(dir);
    expect(p.json && p.json.decision, JSON.stringify(p.json)).toBe("block");
    expect(p.json.reason).toContain("Protected files were modified");
    expect(runs(dir), "the credited command must not run").toBe(0);

    // evidence
    const cfg = cfgFor({ stopGate: { ...baseConfig.stopGate, requireEvidence: true } });
    const dir2 = makeRec(cfg);
    edit(dir2, "edited");
    seed(dir2);
    const noEvidence = stop(dir2);
    expect(noEvidence.json && noEvidence.json.decision, JSON.stringify(noEvidence.json)).toBe("block");
    expect(noEvidence.json.reason).toContain("No test or verify command ran in this session");
    expect(runs(dir2)).toBe(0);
    runHookScript("guard-bash", { tool_name: "Bash", tool_input: { command: "node .doug/hooks/scripts/verify.mjs" } }, { dir: dir2 });
    const withEvidence = stop(dir2);
    expect(withEvidence.json, JSON.stringify(withEvidence.json)).toBeNull();
    expect(runs(dir2)).toBe(0);
    expect(sessionState(dir2).lastGate.results[0].credited).toBe("verified-tree");
  });

  it("R10: a coder SubagentStop on a recorded tree is credited: allow, no command runs", () => {
    const dir = makeRec(cfgFor({ trace: { enabled: true } }));
    edit(dir, "edited");
    const traceFile = join(dir, ".doug/.state/trace/test-session.jsonl");
    mkdirSync(dirname(traceFile), { recursive: true });
    const line = (l) => ({ t: new Date().toISOString(), event: null, session: "test-session", agent: null, agentType: null, tool: null, toolUseId: null, detail: null, ok: null, tokens: null, context: null, reason: null, ...l });
    writeFileSync(
      traceFile,
      [
        line({ event: "SubagentStart", agent: "ag1", agentType: "coder" }),
        line({ event: "PreToolUse", agent: "ag1", agentType: "coder", tool: "Edit" }),
        line({ event: "PostToolUse", agent: "ag1", agentType: "coder", tool: "Edit", ok: true }),
      ].map((l) => JSON.stringify(l)).join("\n") + "\n",
    );
    seed(dir);
    const r = runHookScript("stop-gate", { hook_event_name: "SubagentStop", agent_id: "ag1", agent_type: "coder" }, { dir });
    expect(r.json, JSON.stringify(r.json)).toBeNull();
    expect(runs(dir), "a credited SubagentStop must not run the commands").toBe(0);
    expect(sessionState(dir).lastGate.results[0].credited).toBe("verified-tree");
  });

  it("R11: a stale red for the same tree does not shadow a matching green record", () => {
    const dir = makeRec();
    edit(dir, "edited");
    writeFileSync(join(dir, "fail.flag"), "1");
    markEdited(dir);
    const red = stop(dir);
    expect(red.json && red.json.decision, JSON.stringify(red.json)).toBe("block");
    expect(runs(dir)).toBe(1);
    seed(dir); // a green record for exactly this (failing-flag) tree, as another agent's verify run would leave
    const r = stop(dir);
    expect(r.json, JSON.stringify(r.json)).toBeNull();
    expect(runs(dir), "the green record must be credited rather than the red reused or the commands rerun").toBe(1);
    expect(sessionState(dir).lastGate.results[0].credited).toBe("verified-tree");
  });

  it("R12: a Stop whose command changes a non-ignored file while it runs ends green but writes no record", () => {
    const MUT =
      `${process.execPath} -e "const fs=require('fs');fs.mkdirSync('.doug/.state',{recursive:true});` +
      `fs.appendFileSync('.doug/.state/ran.marker','x');fs.writeFileSync('src/changed-by-gate.js','mutated');` +
      `console.log(' Tests  3 passed (3)')"`;
    const dir = makeRec(cfgFor({ commands: { test: MUT } }));
    edit(dir, "edited");
    const r = stop(dir);
    expect(r.json, JSON.stringify(r.json)).toBeNull();
    expect(runs(dir), "the command must have really run").toBe(1);
    expect(existsSync(join(dir, "src/changed-by-gate.js")), "the command must have changed the tree").toBe(true);
    expect(readRecord(dir), "a tree that changed across the run must not be recorded").toBeNull();
  });
});

// card worktree-count-baseline: a worktree subagent's count check compares the worktree against its own earlier
// green runs (<wt>/.doug/.state/test-totals.json), never against the main checkout's SessionStart snapshot, and a
// green worktree run writes its totals to the worktree, leaving main's record alone. A worktree without a dist
// build skips tests that main (with dist) runs; against main's baseline that read as a rise in skipped.
describe("card worktree-count-baseline", () => {
  const CMD = "cat .doug/.state/summary.txt";
  const REC = ".doug/.state/test-totals.json";
  const agentType = "doug-flow:implementer";
  const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  const summary = ({ total, skipped = 0 }) => {
    const segs = [`${total - skipped} passed`];
    if (skipped) segs.push(`${skipped} skipped`);
    return ` Test Files  1 passed (1)\n      Tests  ${segs.join(" | ")} (${total})\n   Duration  242ms\n`;
  };

  // Main checkout with a baseline of {total 100, skipped 0} taken at SessionStart; a worktree under .claude/worktrees.
  function makeFixture() {
    const dir = makeProject({ config: { ...baseConfig, commands: { test: CMD } }, git: true });
    writeFileSync(join(dir, ".gitignore"), ".doug/.state/\n");
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src/a.ts"), "base");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "base");
    mkdirSync(join(dir, ".doug/.state"), { recursive: true });
    writeFileSync(join(dir, REC), JSON.stringify({ [CMD]: [{ total: 100, skipped: 0, todo: 0 }] }));
    runHookScript("session-start-baseline", { hook_event_name: "SessionStart", source: "startup" }, { dir });
    const wt = join(dir, ".claude/worktrees/wt1");
    git(dir, "worktree", "add", "-q", wt, "-b", "wt1-branch");
    mkdirSync(join(wt, ".doug/.state"), { recursive: true });
    return { dir, wt };
  }

  const traceFile = (dir) => join(dir, ".doug/.state/trace/test-session.jsonl");
  // One worktree agent's life: it commits a change in the worktree, the command prints `out` there, then it stops.
  let n = 0;
  function wtStop(dir, wt, out) {
    n += 1;
    const agent = `ag${n}`;
    const file = join(wt, "src/a.ts");
    writeFileSync(file, `work ${n}`);
    git(wt, "add", "src/a.ts");
    git(wt, "commit", "-q", "-m", `work ${n}`);
    writeFileSync(join(wt, ".doug/.state/summary.txt"), summary(out));
    mkdirSync(dirname(traceFile(dir)), { recursive: true });
    const base = { t: new Date().toISOString(), event: null, session: "test-session", agent, agentType, tool: null, toolUseId: null, detail: null, ok: null, tokens: null, context: null, reason: null };
    const lines = [
      { event: "SubagentStart" },
      { event: "PostToolUse", tool: "Write", ok: true, detail: file },
      { event: "PostToolUse", tool: "Bash", ok: true, detail: "git add src/a.ts && git commit -m work" },
    ].map((l) => JSON.stringify({ ...base, ...l }));
    appendFileSync(traceFile(dir), lines.join("\n") + "\n");
    runHookScript("edit-loop", { tool_name: "Write", tool_input: { file_path: file }, agent_id: agent }, { dir });
    return runHookScript("stop-gate", { hook_event_name: "SubagentStop", agent_id: agent, agent_type: agentType }, { dir });
  }
  const rec = (d) => JSON.parse(readFileSync(join(d, REC), "utf8"));

  it("WCB1: a worktree run printing skipped 53 against a main baseline of skipped 0, with no record of its own, is allowed", () => {
    const { dir, wt } = makeFixture();
    const r = wtStop(dir, wt, { total: 100, skipped: 53 });
    expect(r.json, JSON.stringify(r.json)).toBeNull();
  });

  it("WCB2: a worktree whose own record holds skipped 53 and whose run prints skipped 54 is blocked", () => {
    const { dir, wt } = makeFixture();
    writeFileSync(join(wt, REC), JSON.stringify({ [CMD]: [{ total: 100, skipped: 53, todo: 0 }] }));
    const r = wtStop(dir, wt, { total: 100, skipped: 54 });
    expect(r.json && r.json.decision, JSON.stringify(r.json)).toBe("block");
    expect(r.json.reason).toContain("test count regressed");
    expect(r.json.reason).toContain("skipped rose from 53 (baseline) to 54 (now)");
  });

  it("WCB3: a green worktree run seeds the worktree's own record, leaves main's untouched, and a later rise there blocks", () => {
    const { dir, wt } = makeFixture();
    const first = wtStop(dir, wt, { total: 100, skipped: 53 });
    expect(first.json, JSON.stringify(first.json)).toBeNull();
    expect(rec(wt)[CMD][0]).toMatchObject({ total: 100, skipped: 53 });
    expect(rec(dir)[CMD][0], "main's last-green record must not take the worktree's counts").toMatchObject({ total: 100, skipped: 0 });
    const second = wtStop(dir, wt, { total: 100, skipped: 54 });
    expect(second.json && second.json.decision, JSON.stringify(second.json)).toBe("block");
    expect(second.json.reason).toContain("skipped rose from 53 (baseline) to 54 (now)");
  });
});

// card ratchet-stale-session-baseline: a main-checkout run compares against the live last-green record (as a
// worktree run does), a seat that edited no file is never blocked by a count change, a real drop still blocks.
describe("card ratchet-stale-session-baseline", () => {
  const CMD = "cat summary.txt";
  const LAST_GREEN = ".doug/.state/test-totals.json";
  const WAIVERS = ".doug/.state/test-count-waivers";
  const summary = ({ total, skipped = 0, todo = 0 }) => {
    const segs = [];
    if (total - skipped - todo > 0) segs.push(`${total - skipped - todo} passed`);
    if (skipped) segs.push(`${skipped} skipped`);
    if (todo) segs.push(`${todo} todo`);
    return ` Test Files  1 passed (1)\n      Tests  ${segs.join(" | ")} (${total})\n   Start at  08:34:30\n   Duration  242ms\n`;
  };
  const rec = (total, skipped = 0) => ({ [CMD]: { total, skipped, todo: 0 } });

  // Session start with `startRec`, then the shared record becomes `nowRec` (another seat's green) and the run prints `out`.
  function makeProj({ startRec, nowRec, out, waiverFile }) {
    const dir = makeProject({ config: { ...baseConfig, commands: { test: CMD }, trace: { enabled: true } }, git: true });
    writeFileSync(join(dir, ".gitignore"), ".doug/.state/\n");
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src/a.ts"), "base");
    writeFileSync(join(dir, "src/b.ts"), "base");
    execFileSync("git", ["add", "-A"], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", "base"], { cwd: dir });
    mkdirSync(join(dir, ".doug/.state"), { recursive: true });
    if (startRec) writeFileSync(join(dir, LAST_GREEN), JSON.stringify(startRec));
    runHookScript("session-start-baseline", { hook_event_name: "SessionStart", source: "startup" }, { dir });
    if (nowRec) writeFileSync(join(dir, LAST_GREEN), JSON.stringify(nowRec));
    if (waiverFile !== undefined) writeFileSync(join(dir, WAIVERS), waiverFile);
    writeFileSync(join(dir, "src/a.ts"), "edited this session");
    runHookScript("edit-loop", { tool_name: "Edit", tool_input: { file_path: "src/a.ts" } }, { dir });
    writeFileSync(join(dir, "summary.txt"), out);
    return dir;
  }
  const mainStop = (dir) => runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
  const ids = (id, type) => ({ agent_id: id, agent_type: type });
  const fireStart = (dir, id, type) => runHookScript("trace", { hook_event_name: "SubagentStart", ...ids(id, type) }, { dir });
  const fireBash = (dir, id, type) =>
    runHookScript("trace", { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" }, tool_use_id: "tu1", ...ids(id, type) }, { dir });
  const fireEdit = (dir, id, type) => {
    const e = { tool_name: "Edit", tool_input: { file_path: "src/a.ts" }, tool_use_id: "tu2", ...ids(id, type) };
    runHookScript("trace", { hook_event_name: "PreToolUse", ...e }, { dir });
    runHookScript("trace", { hook_event_name: "PostToolUse", tool_response: { success: true }, ...e }, { dir });
  };
  const subStop = (dir, id, type) => runHookScript("stop-gate", { hook_event_name: "SubagentStop", ...ids(id, type) }, { dir });
  const isBlock = (r) => r.json && r.json.decision === "block";

  it("M1: skipped moved 0 -> 53 at session start, record now 53: a main Stop printing 53 skipped passes", () => {
    const dir = makeProj({ startRec: rec(100, 0), nowRec: rec(100, 53), out: summary({ total: 100, skipped: 53 }) });
    const r = mainStop(dir);
    expect(isBlock(r), JSON.stringify(r.json)).toBeFalsy();
  });

  it("M3: a main Stop printing a drop below the last-green record (137 -> 135) blocks and names 137", () => {
    const dir = makeProj({ startRec: rec(131), nowRec: rec(137), out: summary({ total: 135 }) });
    const r = mainStop(dir);
    expect(isBlock(r), JSON.stringify(r.json)).toBe(true);
    expect(r.json.reason).toContain("total dropped from 137 (baseline) to 135 (now)");
  });

  it("M6: with no readable record, the session-start copy still gates a main Stop", () => {
    const dir = makeProj({ startRec: rec(137), out: summary({ total: 131 }) });
    rmSync(join(dir, LAST_GREEN), { force: true });
    const r = mainStop(dir);
    expect(isBlock(r), JSON.stringify(r.json)).toBe(true);
    expect(r.json.reason).toContain("137");
  });

  it("M7: the waiver file works against the last-green record (delta relative to 137)", () => {
    const dir = makeProj({
      startRec: rec(131),
      nowRec: rec(137),
      out: summary({ total: 135 }),
      waiverFile: "test-count-waiver: total=-2 skipped=0 todo=0; removed the obsolete suite\n",
    });
    const r = mainStop(dir);
    expect(isBlock(r), JSON.stringify(r.json)).toBeFalsy();
  });

  it("M2: a read-only seat (Bash only, no Edit-type call, tree changed by another seat) with a changed count is not blocked", () => {
    const dir = makeProj({ startRec: rec(100, 0), out: summary({ total: 100, skipped: 53 }) });
    fireStart(dir, "ag1", "doug-flow:lead");
    fireBash(dir, "ag1", "doug-flow:lead");
    writeFileSync(join(dir, "src/b.ts"), "another seat edited the main checkout"); // defeats tree-unchanged
    const r = subStop(dir, "ag1", "doug-flow:lead");
    expect(isBlock(r), JSON.stringify(r.json)).toBeFalsy();
  });

  it("M4: that exempted stop does not lower the bar: the record is untouched and a later main Stop still blocks", () => {
    const dir = makeProj({ startRec: rec(100, 0), out: summary({ total: 100, skipped: 53 }) });
    fireStart(dir, "ag1", "doug-flow:lead");
    fireBash(dir, "ag1", "doug-flow:lead");
    writeFileSync(join(dir, "src/b.ts"), "another seat edited the main checkout");
    expect(isBlock(subStop(dir, "ag1", "doug-flow:lead"))).toBeFalsy();
    expect(JSON.parse(readFileSync(join(dir, LAST_GREEN), "utf8"))).toEqual(rec(100, 0));
    const r = mainStop(dir);
    expect(isBlock(r), JSON.stringify(r.json)).toBe(true);
    expect(r.json.reason).toContain("skipped rose from 0 (baseline) to 53 (now)");
  });

  it("M5: a seat with a successful Edit in its own trace is still blocked by a count regression", () => {
    const dir = makeProj({ startRec: rec(100, 0), out: summary({ total: 100, skipped: 53 }) });
    fireStart(dir, "ag1", "coder");
    fireEdit(dir, "ag1", "coder");
    const r = subStop(dir, "ag1", "coder");
    expect(isBlock(r), JSON.stringify(r.json)).toBe(true);
    expect(r.json.reason).toContain("test count regressed");
  });
});

// card block-ledger-failing-output: a block whose only problem is the test-count ratchet is classed
// "test-count" (not real, not race), with failures []; any other problem alongside keeps the other class.
describe("card block-ledger-failing-output (test-count class)", () => {
  const CMD = "cat summary.txt";
  const LEDGER = ".doug/.state/blocks.jsonl";
  const summary = (total) =>
    ` Test Files  1 passed (1)\n      Tests  ${total} passed (${total})\n   Start at  08:34:30\n   Duration  242ms\n`;
  function project(extraCommands) {
    const commands = { test: CMD, ...extraCommands };
    const dir = makeProject({ config: { ...baseConfig, commands }, git: true });
    writeFileSync(join(dir, ".gitignore"), ".doug/.state/\n");
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src/a.ts"), "base");
    execFileSync("git", ["add", "-A"], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", "base"], { cwd: dir });
    mkdirSync(join(dir, ".doug/.state"), { recursive: true });
    writeFileSync(join(dir, ".doug/.state/test-totals.json"), JSON.stringify({ [CMD]: { total: 137, skipped: 0, todo: 0 } }));
    runHookScript("session-start-baseline", { hook_event_name: "SessionStart", source: "startup" }, { dir });
    if (extraCommands) {
      writeFileSync(
        join(dir, ".doug/config.json"),
        JSON.stringify({
          ...baseConfig,
          commands,
          stopGate: { commands: Object.keys(commands), onlyIfEdited: true, maxBlocks: 3, timeoutMs: 10000, requireEvidence: false },
        }),
      );
    }
    writeFileSync(join(dir, "src/a.ts"), "edited this session");
    runHookScript("edit-loop", { tool_name: "Edit", tool_input: { file_path: "src/a.ts" } }, { dir });
    writeFileSync(join(dir, "summary.txt"), summary(131));
    return dir;
  }
  const ledgerOf = (dir) =>
    readFileSync(join(dir, LEDGER), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

  it("a dropped-test block's ledger line has class test-count and failures []", () => {
    const dir = project();
    const r = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
    expect(r.json.decision).toBe("block");
    expect(r.json.reason).toContain("131");
    const lines = ledgerOf(dir);
    expect(lines.length).toBe(1);
    expect(lines[0].class).toBe("test-count");
    expect(lines[0].failures).toEqual([]);
    expect(lines[0].cwd).toBe(dir);
    expect(lines[0].tree).toBe(computeTree(dir));
  });

  it("a count regression plus a failing second command is classed real, not test-count, and failures names the failing command", () => {
    const dir = project({ other: "echo other-broke; exit 1" });
    const r = runHookScript("stop-gate", { hook_event_name: "Stop" }, { dir });
    expect(r.json.decision).toBe("block");
    expect(r.json.reason).toContain("131");
    expect(r.json.reason).toContain("failed (exit");
    const line = ledgerOf(dir)[0];
    expect(line.class).not.toBe("test-count");
    expect(line.failures).toHaveLength(1);
    expect(line.failures[0].command).toBe("echo other-broke; exit 1");
    expect(line.failures[0].tail).toContain("other-broke");
  });
});
