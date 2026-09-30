import { it, expect } from "vitest";
import { parseDuration } from "../src/duration.js";
it("held-out: hours and days", () => {
  expect(parseDuration("2h")).toBe(7_200_000);
  expect(parseDuration("1.5h")).toBe(5_400_000);
  expect(parseDuration("1d")).toBe(86_400_000);
  expect(parseDuration("5m")).toBe(300_000);
});
