// Card replay-skill-hash-stale: tests/replay/skill-hashes.json must equal the current sha256 of every pinned
// skill and workflow script. rehearse-replay E07 checks this too, but only under test:e2e; this runs in test:unit.
import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const pins = JSON.parse(readFileSync(join(ROOT, "tests/replay/skill-hashes.json"), "utf8"));

describe("replay skill-hash pins match the files", () => {
  it("pins at least one file", () => {
    expect(Object.values(pins).some((m) => Object.keys(m).length > 0)).toBe(true);
  });
  for (const [scenario, files] of Object.entries(pins)) {
    for (const [path, want] of Object.entries(files)) {
      it(`${scenario}: ${path} matches its pinned sha256`, () => {
        const got = createHash("sha256").update(readFileSync(join(ROOT, path))).digest("hex");
        expect(got, `${path} (pinned in tests/replay/skill-hashes.json under ${scenario}): pinned ${want}, now ${got}; review tests/replay/scenarios/${scenario}.mjs and update the pin in the same commit`).toBe(want);
      });
    }
  }
});
