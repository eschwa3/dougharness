import { describe, it, expect } from "vitest";
import { slugify } from "../src/strings.js";

describe("slugify", () => {
  it("lowercases and dashes", () => {
    expect(slugify("Hello World")).toBe("hello-world");
  });
  it("strips accents and punctuation", () => {
    expect(slugify("Crème brûlée!")).toBe("creme-brulee");
  });
});
