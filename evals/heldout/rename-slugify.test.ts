import { it, expect } from "vitest";
import * as strings from "../src/strings.js";
it("held-out: toSlug exists and slugify is gone", () => {
  expect(typeof (strings as any).toSlug).toBe("function");
  expect((strings as any).slugify).toBeUndefined();
  expect((strings as any).toSlug("Hello World")).toBe("hello-world");
});
