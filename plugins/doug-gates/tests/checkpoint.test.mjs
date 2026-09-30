import { describe, it, expect } from "vitest";
import { refName, commitMessage, checkpoint, describeCheckpoint } from "../lib/checkpoint.mjs";
import { makeProject } from "./helpers.mjs";

describe("checkpoint helpers", () => {
  it("names tags by UTC time under doug/checkpoint/", () => {
    expect(refName(new Date("2026-09-04T15:04:05.123Z"))).toBe("doug/checkpoint/20260904T150405Z");
  });
  it("puts the gate results in the message body", () => {
    expect(commitMessage({}, [{ name: "typecheck", ok: true }, { name: "test", ok: true }])).toBe("doug: checkpoint\n\ngate: typecheck ok, test ok");
    expect(commitMessage({ checkpoint: { message: "wip" } }, [])).toBe("wip");
  });
  it("skips without touching git when disabled, outside a repo, or with nothing changed", () => {
    const dir = makeProject();
    expect(checkpoint({ dir, cfg: {}, changed: ["a"] })).toEqual({ skipped: "disabled" });
    expect(checkpoint({ dir, cfg: { checkpoint: { enabled: true } }, changed: null })).toEqual({ skipped: "not a git repository" });
    expect(checkpoint({ dir, cfg: { checkpoint: { enabled: true } }, changed: [] })).toEqual({ skipped: "no changes" });
  });
  it("describes every outcome", () => {
    expect(describeCheckpoint({ error: "boom" })).toBe("[doug] Checkpoint failed: boom");
    expect(describeCheckpoint({ skipped: "detached HEAD" })).toBe("[doug] Checkpoint skipped: detached HEAD.");
    expect(describeCheckpoint({ mode: "commit", ref: "main", sha: "abc1234" })).toBe("[doug] Checkpoint committed as abc1234 on main.");
    expect(describeCheckpoint({ mode: "tag", ref: "doug/checkpoint/x", sha: "abc1234" })).toContain("git checkout doug/checkpoint/x -- .");
  });
});
