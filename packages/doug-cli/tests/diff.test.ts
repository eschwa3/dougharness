import { describe, it, expect } from "vitest";
import { renderDiff } from "../src/diff.js";

describe("renderDiff", () => {
  it("renders a create", () => {
    const out = renderDiff({ path: "a.txt", before: null, after: "one\ntwo\n" });
    expect(out).toContain("create  a.txt");
    expect(out).toContain("--- /dev/null");
    expect(out).toContain("+one");
    expect(out).toContain("+two");
  });
  it("renders a modify with context and hunk header", () => {
    const before = ["a", "b", "c", "d", "e", "f", "g"].join("\n") + "\n";
    const after = ["a", "b", "c", "D", "e", "f", "g"].join("\n") + "\n";
    const out = renderDiff({ path: "x", before, after });
    expect(out).toContain("@@ -1,7 +1,7 @@");
    expect(out).toContain("-d");
    expect(out).toContain("+D");
    expect(out).toContain(" a");
  });
  it("reports no changes when identical", () => {
    expect(renderDiff({ path: "x", before: "same\n", after: "same\n" })).toContain("(no changes)");
  });
});
