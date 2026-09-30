import { describe, it, expect } from "vitest";
import { parseDuration } from "../src/duration.js";

describe("parseDuration", () => {
  it("parses seconds and minutes", () => {
    expect(parseDuration("90s")).toBe(90_000);
    expect(parseDuration("5m")).toBe(300_000);
  });
  it("rejects garbage", () => {
    expect(() => parseDuration("soon")).toThrow();
  });
});
