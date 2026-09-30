import { it, expect } from "vitest";
import { formatDuration } from "../src/duration.js";
import { titleCase } from "../src/strings.js";
import { describeSchedule } from "../src/schedule.js";
it("held-out: formatDuration renders whole units, largest first", () => {
  expect(formatDuration(0)).toBe("0ms");
  expect(formatDuration(1500)).toBe("1s 500ms");
  expect(formatDuration(90_000)).toBe("1m 30s");
  expect(formatDuration(5_400_000)).toBe("1h 30m");
  expect(formatDuration(86_400_000)).toBe("1d");
  expect(formatDuration(90_061_001)).toBe("1d 1h 1m 1s 1ms");
});
it("held-out: titleCase capitalizes each word and collapses whitespace", () => {
  expect(titleCase("hello   WORLD")).toBe("Hello World");
  expect(titleCase("  nightly build ")).toBe("Nightly Build");
  expect(titleCase("")).toBe("");
});
it("held-out: describeSchedule combines the slug, the parsed interval, and the label", () => {
  expect(describeSchedule("Nightly Build", "90m")).toEqual({ slug: "nightly-build", everyMs: 5_400_000, label: "Nightly Build every 1h 30m" });
  expect(describeSchedule("  crème  BRÛLÉE check ", "45s")).toEqual({ slug: "creme-brulee-check", everyMs: 45_000, label: "Crème Brûlée Check every 45s" });
  expect(() => describeSchedule("x", "soon")).toThrow();
});
