import { it, expect } from "vitest";
import { toSeconds } from "../src/duration.js";
import { titleCase } from "../src/strings.js";
it("held-out: toSeconds converts a duration to seconds", () => {
  expect(toSeconds("90s")).toBe(90);
  expect(toSeconds("5m")).toBe(300);
  expect(toSeconds("1500ms")).toBe(1.5);
  expect(() => toSeconds("soon")).toThrow();
});
it("held-out: titleCase capitalizes each word and collapses whitespace", () => {
  expect(titleCase("hello   WORLD")).toBe("Hello World");
  expect(titleCase("  nightly build ")).toBe("Nightly Build");
  expect(titleCase("")).toBe("");
});
