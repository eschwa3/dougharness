// Usage-path scenarios P01 P02 P12 P13: board selection, batches, filing and board edits, driven through the real
// board.mjs, plan.mjs and autopilot.mjs scripts on temp projects. No model runs.
import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { addCard, loadBoard, saveBoard, findCard } from "../../plugins/doug-flow/lib/board.mjs";
import { autopilot, boardCli, boardProject, planCli, planOf, readJson, tmp, writeJson } from "./fixture.mjs";

describe("board usage paths", () => {
  it("P01 doug-next single: board.mjs next skips the Ready card with an undone dep and routes by track", () => {
    const dir = boardProject();
    const flow = boardCli(dir, "next");
    expect(flow.status, flow.stderr).toBe(0);
    expect(JSON.parse(flow.stdout).id).toBe("flow-one"); // "waits" comes first on the board but depends on a card not Done
    const hand = boardCli(dir, "next", "--track", "hand");
    expect(hand.status, hand.stderr).toBe(0);
    expect(JSON.parse(hand.stdout).id).toBe("hand-one");
    const none = boardCli(dir, "next", "--tag", "no-such-tag");
    expect(none.status).not.toBe(0);
  });

  it("P02 batch: next --batch 2 returns exactly two cards, then plan.mjs merge joins their drafts into one plan", () => {
    const dir = boardProject();
    const r = boardCli(dir, "next", "--batch", "2");
    expect(r.status, r.stderr).toBe(0);
    const cards = JSON.parse(r.stdout);
    expect(cards.map((c) => c.id)).toEqual(["flow-one", "flow-two"]);
    const taskOf = (id) => ({ id: `${id}-t`, title: id, spec: `Do the thing for ${id} with a test.`, files: [`src/${id}.ts`] });
    for (const c of cards) writeJson(join(dir, `.doug/.state/drafts/${c.id}.json`), planOf({ title: `Plan ${c.id}`, tasks: [taskOf(c.id)] }));
    const m = planCli(dir, "merge", ...cards.map((c) => c.id));
    expect(m.status, m.stderr + m.stdout).toBe(0);
    const merged = readJson(join(dir, ".doug/plan.json"));
    expect(merged.status).toBe("draft");
    expect(merged.tasks.map((t) => t.card).sort()).toEqual(["flow-one", "flow-two"]);
  });

  it("P12 follow-up and user-card filing: addCard to backlog, reorder --top, and autopilot filed records kind, from and position", () => {
    const dir = boardProject();
    saveBoard(dir, addCard(loadBoard(dir), { id: "follow-up-x", title: "Follow up X", goal: "A follow-up found during a landing.", size: "S", component: "flow", column: "backlog" }, { date: "2026-10-02" }));
    const added = findCard(loadBoard(dir), "follow-up-x");
    expect(added.column).toBe("backlog");
    const re = boardCli(dir, "reorder", "follow-up-x", "--top");
    expect(re.status, re.stderr).toBe(0);
    const backlog = loadBoard(dir).cards.filter((c) => c.column === "backlog").map((c) => c.id);
    expect(backlog[0]).toBe("follow-up-x");

    expect(autopilot(dir, "start", "--cards", "flow-one", "--usd-cap", "10", "--wall-cap", "60").status).toBe(0);
    const f = autopilot(dir, "filed", "follow-up-x", "--kind", "follow-up", "--from", "flow-one", "--position", "Backlog top");
    expect(f.status, f.stderr).toBe(0);
    const u = autopilot(dir, "filed", "user-card-y", "--kind", "user", "--position", "Ready top");
    expect(u.status, u.stderr).toBe(0);
    const s = readJson(join(dir, ".doug/.state/autopilot.json"));
    expect(s.filed).toEqual([
      { id: "follow-up-x", kind: "follow-up", from: "flow-one", position: "Backlog top" },
      { id: "user-card-y", kind: "user", position: "Ready top" },
    ]);
  });

  it("P13 board edits: board.mjs move, edit and reorder on a temp board put the card where it was told", () => {
    const dir = boardProject();
    const mv = boardCli(dir, "move", "flow-three", "backlog", "--source", "scenario");
    expect(mv.status, mv.stderr).toBe(0);
    expect(findCard(loadBoard(dir), "flow-three")).toMatchObject({ column: "backlog", source: "scenario" });
    const ed = boardCli(dir, "edit", "flow-three", "--title", "Flow three edited", "--size", "L");
    expect(ed.status, ed.stderr).toBe(0);
    expect(findCard(loadBoard(dir), "flow-three")).toMatchObject({ title: "Flow three edited", size: "L", column: "backlog" });
    const re = boardCli(dir, "reorder", "flow-two", "--bottom");
    expect(re.status, re.stderr).toBe(0);
    const ready = loadBoard(dir).cards.filter((c) => c.column === "ready").map((c) => c.id);
    expect(ready[ready.length - 1]).toBe("flow-two");
    const done = boardCli(dir, "move", "flow-one", "done");
    expect(done.status, done.stderr).toBe(0);
    expect(findCard(loadBoard(dir), "flow-one").column).toBe("done");
    const bad = boardCli(dir, "move", "flow-one", "nowhere");
    expect(bad.status).not.toBe(0);
  });
});
