// Usage-path scenarios P03 P04 P08 P09: the autopilot loop (fixed caps, grown caps, stop and ask, resume) through the
// real autopilot.mjs on a temp project, with canned queen reports. No model runs.
import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { autopilot, boardProject, readJson, writeJson } from "./fixture.mjs";

const state = (dir) => readJson(join(dir, ".doug/.state/autopilot.json"));
const cardOf = (dir, id) => state(dir).cards.find((c) => c.id === id);

function launch(dir, id, run, kind = "hand") {
  const argsFile = join(dir, `${id}-args.json`);
  writeJson(argsFile, { card: id, options: {} });
  const r = autopilot(dir, "launched", id, "--run", run, "--kind", kind, "--worktree", join(dir, `wt-${id}`), "--args-file", argsFile);
  expect(r.status, r.stderr).toBe(0);
}
function report(dir, run, body) {
  const f = join(dir, `result-${run}.json`);
  writeJson(f, body);
  return autopilot(dir, "report", "--run", run, "--file", f);
}
const designStop = { outcome: "stopped", reason: "design-decision", stoppedAt: "tester", detail: "Which column should it use?", history: [{ seat: "tester", round: 1, result: "stopped" }] };

describe("autopilot usage paths", () => {
  it("P03 autopilot fixed: start -> card -> report land -> land -> end, with the caps on the state file", () => {
    const dir = boardProject();
    const s = autopilot(dir, "start", "--cards", "hand-one,flow-one", "--usd-cap", "12.5", "--wall-cap", "90");
    expect(s.status, s.stderr).toBe(0);
    expect(state(dir).caps).toMatchObject({ usd: 12.5, wallMin: 90 });
    expect(autopilot(dir, "card", "hand-one").status).toBe(0);
    expect(cardOf(dir, "hand-one").state).toBe("running");
    launch(dir, "hand-one", "wf_p03");
    const r = report(dir, "wf_p03", { outcome: "done", reason: null, commit: "abc1234", history: [] });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.trim()).toBe("autopilot: hand-one land");
    expect(readJson(join(dir, ".doug/.state/reports/hand-one/card-report.json")).commit).toBe("abc1234");
    expect(autopilot(dir, "land", "hand-one", "--commit", "abc1234").status).toBe(0);
    expect(cardOf(dir, "hand-one")).toMatchObject({ state: "landed", commit: "abc1234" });
    expect(cardOf(dir, "flow-one").state).toBe("queued");
    expect(autopilot(dir, "end").status).toBe(0);
    expect(state(dir).status).toBe("ended");
  });

  it("P04 autopilot unlimited: add with grown caps raises them and queues the card; a repeat add changes no queue", () => {
    const dir = boardProject();
    autopilot(dir, "start", "--cards", "hand-one", "--usd-cap", "10", "--wall-cap", "60");
    const a = autopilot(dir, "add", "flow-two", "--usd-cap", "25", "--wall-cap", "180");
    expect(a.status, a.stderr).toBe(0);
    expect(state(dir).caps).toMatchObject({ usd: 25, wallMin: 180 });
    expect(state(dir).cards.map((c) => c.id)).toEqual(["hand-one", "flow-two"]);
    const again = autopilot(dir, "add", "flow-two");
    expect(again.stdout).toMatch(/already queued/);
    expect(state(dir).cards).toHaveLength(2);
    expect(state(dir).caps.usd).toBe(25); // no flag, no change
  });

  it("P08 stop and ask: a design-decision stop prints ask, the answer turns it into resume with the answer", () => {
    const dir = boardProject();
    autopilot(dir, "start", "--cards", "hand-one", "--usd-cap", "10", "--wall-cap", "60");
    launch(dir, "hand-one", "wf_p08");
    const asked = report(dir, "wf_p08", designStop);
    expect(asked.stdout.trim()).toBe("autopilot: hand-one ask design-decision");
    const other = report(dir, "wf_p08", { ...designStop, reason: "gate-red-twice" });
    expect(other.stdout.trim()).toBe("autopilot: hand-one ask gate-red-twice");
    report(dir, "wf_p08", designStop);
    const ans = autopilot(dir, "answer", "hand-one", "--answer", "Use the backlog column.");
    expect(ans.status, ans.stderr).toBe(0);
    const saved = readJson(join(dir, ".doug/.state/reports/hand-one/queen-args.json"));
    expect(saved.options.answers).toEqual([{ seat: "tester", question: "Which column should it use?", answer: "Use the backlog column.", round: 1, run: "wf_p08" }]);
    const again = report(dir, "wf_p08", designStop);
    expect(again.stdout.trim()).toBe("autopilot: hand-one resume with the answer");
  });

  it("P09 resume: an agent-null stop prints resume; resumed counts it and records the new run id", () => {
    const dir = boardProject();
    autopilot(dir, "start", "--cards", "hand-one", "--usd-cap", "10", "--wall-cap", "60");
    launch(dir, "hand-one", "wf_p09a");
    const r = report(dir, "wf_p09a", { outcome: "stopped", reason: "agent-null", stoppedAt: "lead", history: [] });
    expect(r.stdout.trim()).toBe("autopilot: hand-one resume agent-null");
    const res = autopilot(dir, "resumed", "hand-one", "--run", "wf_p09b");
    expect(res.status, res.stderr).toBe(0);
    expect(cardOf(dir, "hand-one")).toMatchObject({ resumes: 1, runId: "wf_p09b" });
    autopilot(dir, "resumed", "hand-one", "--run", "wf_p09c");
    expect(cardOf(dir, "hand-one")).toMatchObject({ resumes: 2, runId: "wf_p09c" });
    expect(report(dir, "wf_p09a", { outcome: "done" }).status).toBe(1); // the old run id no longer maps to a card
  });
});
