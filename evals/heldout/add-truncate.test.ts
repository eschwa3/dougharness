import { it, expect } from "vitest";
import { truncate } from "../src/strings.js";
it("held-out: truncate", () => {
  expect(truncate("hello", 5)).toBe("hello");
  expect(truncate("hello", 10)).toBe("hello");
  expect(truncate("hello world", 5)).toBe("hell…");
  expect(truncate("", 3)).toBe("");
});
