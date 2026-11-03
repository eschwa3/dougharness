import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { missingPredictions, predictionEntries, predictionWarning } from "../run.mjs";

// Card eval-preregistration: the runner warns when an arm has no dated prediction entry.

const here = dirname(fileURLToPath(import.meta.url));
const runner = join(here, "../run.mjs");
const doc = [
  "# Predictions",
  "```",
  "## 2026-01-01 fenced, example: not an entry",
  "```",
  "## 2026-01-01 pipeline, swarm: split rules",
  "- **Hypothesis:** x",
  "## 2026-13-45 memory: bad date",
  "## 2999-01-01 crew",
  "## 2026-02-02 Not_An_Arm, swarm-cheap",
].join("\n");

describe("predictionEntries", () => {
  it("reads dated headings outside fences, with arms before the first colon", () => {
    expect(predictionEntries(doc)).toEqual([
      { date: "2026-01-01", arms: ["pipeline", "swarm"] },
      { date: "2999-01-01", arms: ["crew"] },
      { date: "2026-02-02", arms: ["swarm-cheap"] },
    ]);
  });
  it("returns [] for null and undefined", () => {
    expect(predictionEntries(null)).toEqual([]);
    expect(predictionEntries(undefined)).toEqual([]);
  });
});

describe("missingPredictions", () => {
  it("lists conditions with no entry dated on or before today, deduplicated, in input order", () => {
    expect(missingPredictions(["memory", "swarm", "crew", "swarm", "pipeline", "memory"], doc, "2026-06-01")).toEqual(["memory", "crew"]);
    expect(missingPredictions(["crew"], doc, "2999-01-01")).toEqual([]);
  });
  it("treats null markdown as every condition missing", () => {
    expect(missingPredictions(["a", "b"], null, "2026-06-01")).toEqual(["a", "b"]);
  });
});

describe("predictionWarning", () => {
  it("is null for an empty list and names the file and conditions otherwise", () => {
    expect(predictionWarning([], "f.md")).toBeNull();
    expect(predictionWarning(["swarm", "memory"], "f.md")).toBe(
      "warning: no dated prediction in f.md for swarm, memory; add one to docs/evals-predictions.md and commit it before launch",
    );
  });
});

function dry(file) {
  return spawnSync(process.execPath, [runner, "--dry-run", "--conditions", "pipeline,swarm", "--tasks", "fix-hours-planned", "--predictions", file], { encoding: "utf8" });
}

describe("runner warning", () => {
  const dir = mkdtempSync(join(tmpdir(), "predictions-"));
  it("warns for a condition without an entry", () => {
    const f = join(dir, "a.md");
    writeFileSync(f, "## 2026-01-01 pipeline\n");
    const r = dry(f);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toContain("no dated prediction");
    expect(r.stderr).toContain("swarm");
  });
  it("is silent when every condition has a dated entry", () => {
    const f = join(dir, "b.md");
    writeFileSync(f, "## 2026-01-01 pipeline, swarm\n");
    const r = dry(f);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).not.toContain("no dated prediction");
  });
  it("does not throw on a missing file and names both conditions", () => {
    const r = dry(join(dir, "nope.md"));
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toContain("pipeline");
    expect(r.stderr).toContain("swarm");
  });
});

describe("docs/evals-predictions.md", () => {
  const text = readFileSync(join(here, "../../docs/evals-predictions.md"), "utf8");
  it("carries the pinned sentences, labels, metrics, and outcomes", () => {
    for (const s of [
      "An entry is written, dated, and committed before its run launches.",
      "Entries are append-only once their run starts.",
      "A wrong prediction is reported as wrong next to its result.",
    ]) expect(text).toContain(s);
    for (const l of ["Hypothesis", "Metric", "Confirms", "Falsifies", "Runs", "Outcomes", "Result"]) expect(text).toContain(`- **${l}:**`);
    for (const m of ["hidden-set pass rate", "defect-judge count", "cost", "wall time"]) expect(text).toContain(m);
    for (const w of ["keep", "redesign", "drop"]) expect(text).toContain(w);
  });
  it("ships no real entry", () => {
    expect(predictionEntries(text)).toEqual([]);
  });
});
