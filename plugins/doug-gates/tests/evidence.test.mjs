import { describe, it, expect } from "vitest";
import { RUNNER_PATTERNS, describeMissingEvidence, evidenceCommands, verificationEvidence } from "../lib/evidence.mjs";

const cfg = { commands: { test: "pnpm test:unit", typecheck: "pnpm typecheck", install: "pnpm install --frozen-lockfile", build: "pnpm build" }, stopGate: { commands: ["typecheck", "test"], evidencePatterns: ["^just\\s+check"] } };

describe("verification evidence", () => {
  it("lists the gate commands first, then the other configured commands, never install", () => {
    expect(evidenceCommands(cfg)).toEqual(["pnpm typecheck", "pnpm test:unit", "pnpm build"]);
    expect(evidenceCommands({ stopGate: { commands: ["true"] } })).toEqual(["true"]);
  });
  it("accepts a gate command inside a longer line, a known runner, or a configured pattern, and nothing else", () => {
    const { ran, looked } = verificationEvidence(["git status", "pnpm typecheck && pnpm test:unit", "npx vitest run x", "just check", "pnpm install", "echo tsc-like", 42], cfg);
    expect(looked).toEqual(["pnpm typecheck", "pnpm test:unit", "pnpm build"]);
    expect(ran).toEqual(["pnpm typecheck && pnpm test:unit", "npx vitest run x", "just check"]);
    expect(verificationEvidence([], cfg).ran).toEqual([]);
    expect(verificationEvidence(["pytest -q"], { commands: {}, stopGate: { commands: [], evidencePatterns: ["("] } }).ran).toEqual(["pytest -q"]);
    expect(RUNNER_PATTERNS.some((r) => r.test("cargo test --workspace"))).toBe(true);
    expect(RUNNER_PATTERNS.some((r) => r.test("cargo build"))).toBe(false);
    expect(RUNNER_PATTERNS.some((r) => r.test("pnpm exec tsc --noEmit"))).toBe(true);
    expect(RUNNER_PATTERNS.some((r) => r.test("echo tsc-like"))).toBe(false);
  });
  it("words a green gate and a failed gate differently and names what it looked for", () => {
    const green = describeMissingEvidence(["pnpm test"], true);
    expect(green).toContain("No test or verify command ran in this session");
    expect(green).toContain("`pnpm test`");
    expect(green).toContain("they pass");
    const red = describeMissingEvidence([], false);
    expect(red).toContain("never ran a test or verify command itself");
    expect(red).not.toContain("they pass");
  });
});
