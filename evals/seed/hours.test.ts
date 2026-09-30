import { it, expect } from "vitest";
import { parseDuration } from "../src/duration.js";
it("parses hours", () => {
  expect(parseDuration("2h")).toBe(7_200_000);
});
