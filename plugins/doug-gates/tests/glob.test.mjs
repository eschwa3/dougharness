import { describe, it, expect } from "vitest";
import { matchGlob, matchAny } from "../lib/glob.mjs";

describe("matchGlob", () => {
  it("matches basenames anywhere for slash-less patterns", () => {
    expect(matchGlob(".env", ".env")).toBe(true);
    expect(matchGlob(".env", "apps/web/.env")).toBe(true);
    expect(matchGlob(".env.*", ".env.local")).toBe(true);
    expect(matchGlob(".env.*", ".env")).toBe(false);
    expect(matchGlob("*.lock", "yarn.lock")).toBe(true);
  });
  it("treats bare directory patterns as prefixes", () => {
    expect(matchGlob("dist", "dist/index.js")).toBe(true);
    expect(matchGlob("dist", "src/dist.ts")).toBe(false);
    expect(matchGlob("prisma/migrations", "prisma/migrations/0001_init/migration.sql")).toBe(true);
  });
  it("handles ** and * and ?", () => {
    expect(matchGlob("dist/**", "dist/a/b/c.js")).toBe(true);
    expect(matchGlob("**/migrations/**", "db/migrations/1.sql")).toBe(true);
    expect(matchGlob("**/migrations/**", "migrations/1.sql")).toBe(true);
    expect(matchGlob("src/*.ts", "src/a.ts")).toBe(true);
    expect(matchGlob("src/*.ts", "src/x/a.ts")).toBe(false);
    expect(matchGlob("file?.txt", "file1.txt")).toBe(true);
  });
  it("supports brace alternatives", () => {
    expect(matchGlob("*.{ts,tsx}", "a.tsx")).toBe(true);
    expect(matchGlob("*.{ts,tsx}", "a.js")).toBe(false);
  });
  it("escapes regex metacharacters", () => {
    expect(matchGlob("a.b", "axb")).toBe(false);
    expect(matchGlob("a+b", "a+b")).toBe(true);
  });
});

describe("matchAny", () => {
  it("returns the matching pattern and honors negation", () => {
    expect(matchAny([".env", "dist/**"], "dist/x.js")).toBe("dist/**");
    expect(matchAny([".env", "dist/**", "!dist/keep.js"], "dist/keep.js")).toBeNull();
    expect(matchAny([".env"], "src/a.ts")).toBeNull();
  });
});
