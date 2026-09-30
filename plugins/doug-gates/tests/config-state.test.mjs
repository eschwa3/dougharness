import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, symlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { loadConfig, DEFAULTS } from "../lib/config.mjs";
import { loadState, saveState, statePath, emptyState } from "../lib/state.mjs";
import { toProjectRelative, filePathsFromToolInput, isAllowedOutside } from "../lib/paths.mjs";
import { headAt, committedSince, walkProposalPathFiles } from "../lib/baseline.mjs";

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "doug-test-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("loadConfig", () => {
  it("returns defaults when no config exists", () => {
    const cfg = loadConfig(dir);
    expect(cfg._present).toBe(false);
    expect(cfg.protectedPaths).toEqual(DEFAULTS.protectedPaths);
    expect(cfg.bash.denyNoVerify).toBe(true);
    expect(cfg.allowedOutsidePaths).toEqual([]);
  });
  it("protects .doug/config.json itself by default", () => {
    expect(DEFAULTS.protectedPaths).toContain(".doug/config.json");
  });
  it("defaults proposalPaths to docs/decisions/** and .claude/rules/** (card memory-decisions)", () => {
    expect(DEFAULTS.proposalPaths).toEqual(["docs/decisions/**", ".claude/rules/**"]);
    expect(loadConfig(dir).proposalPaths).toEqual(["docs/decisions/**", ".claude/rules/**"]);
  });
  it("ignores .doug/config.json in the Stop scan by default, so the installer's own dirty output does not block a fresh install", () => {
    expect(DEFAULTS.stopGate.ignoreChangedPaths).toContain(".doug/config.json");
  });
  it("deep-merges objects and replaces arrays", () => {
    mkdirSync(join(dir, ".doug"));
    writeFileSync(join(dir, ".doug/config.json"), JSON.stringify({ protectedPaths: ["x/**"], bash: { denyNoVerify: false } }));
    const cfg = loadConfig(dir);
    expect(cfg._present).toBe(true);
    expect(cfg.protectedPaths).toEqual(["x/**"]);
    expect(cfg.bash.denyNoVerify).toBe(false);
    expect(cfg.bash.denyForcePushTo).toEqual(["main", "master"]);
  });
  it("merges allowedOutsidePaths from a config file", () => {
    mkdirSync(join(dir, ".doug"));
    writeFileSync(join(dir, ".doug/config.json"), JSON.stringify({ allowedOutsidePaths: ["/home/user/.claude/projects/x/memory"] }));
    const cfg = loadConfig(dir);
    expect(cfg.allowedOutsidePaths).toEqual(["/home/user/.claude/projects/x/memory"]);
  });
  it("falls back to defaults on a broken file instead of disabling gates", () => {
    mkdirSync(join(dir, ".doug"));
    writeFileSync(join(dir, ".doug/config.json"), "{ not json");
    const cfg = loadConfig(dir);
    expect(cfg._present).toBe(false);
    expect(cfg._error).toBeTruthy();
    expect(cfg.protectedPaths.length).toBeGreaterThan(0);
  });
  it("defaults research.maxFetches to 6 (card research-fetch-cap), and a project value overrides it", () => {
    expect(DEFAULTS.research).toEqual({ maxFetches: 6 });
    expect(loadConfig(dir).research).toEqual({ maxFetches: 6 });
    mkdirSync(join(dir, ".doug"));
    writeFileSync(join(dir, ".doug/config.json"), JSON.stringify({ research: { maxFetches: 2 } }));
    expect(loadConfig(dir).research).toEqual({ maxFetches: 2 });
  });
  it("defaults contextWindow to off, with threshold 80 and repeatAfter 5 (card context-window-handoff)", () => {
    expect(DEFAULTS.contextWindow).toEqual({ enabled: false, threshold: 80, repeatAfter: 5 });
    expect(loadConfig(dir).contextWindow).toEqual({ enabled: false, threshold: 80, repeatAfter: 5 });
  });
  it("keeps the other contextWindow defaults when a config sets only enabled", () => {
    mkdirSync(join(dir, ".doug"));
    writeFileSync(join(dir, ".doug/config.json"), JSON.stringify({ contextWindow: { enabled: true } }));
    const cfg = loadConfig(dir);
    expect(cfg.contextWindow).toEqual({ enabled: true, threshold: 80, repeatAfter: 5 });
  });
});

// Card gates-config-shape-check (decision, option a): for each of the four keys the gates iterate with a bare
// `for (const raw of patterns)` (matchAny, lib/glob.mjs) or an unguarded `for (const entry of ...)`
// (resolveCommands), a wrong-shape value (not an array) must fall back to that key's default and warn once on
// stderr naming the key, the way memory.embeddings already does (plugins/doug-flow/lib/embeddings.mjs:48). A
// valid array, including [], passes through unchanged; other keys are unaffected; loadConfig must never throw.
describe("loadConfig shape check (card gates-config-shape-check)", () => {
  function writeCfg(obj) {
    mkdirSync(join(dir, ".doug"), { recursive: true });
    writeFileSync(join(dir, ".doug/config.json"), JSON.stringify(obj));
  }
  // Captures every process.stderr.write call made during fn(), then restores it, mirroring the spy pattern
  // plugins/doug-flow/tests/embeddings.test.mjs uses for the same memory.embeddings warning.
  function withStderrSpy(fn) {
    const lines = [];
    const orig = process.stderr.write;
    process.stderr.write = (s) => {
      lines.push(s);
      return true;
    };
    try {
      return { result: fn(), lines };
    } finally {
      process.stderr.write = orig;
    }
  }

  const cases = [
    { key: "protectedPaths", set: (v) => ({ protectedPaths: v }), get: (cfg) => cfg.protectedPaths, def: DEFAULTS.protectedPaths },
    {
      key: "stopGate.ignoreChangedPaths",
      set: (v) => ({ stopGate: { ignoreChangedPaths: v } }),
      get: (cfg) => cfg.stopGate.ignoreChangedPaths,
      def: DEFAULTS.stopGate.ignoreChangedPaths,
    },
    { key: "stopGate.commands", set: (v) => ({ stopGate: { commands: v } }), get: (cfg) => cfg.stopGate.commands, def: DEFAULTS.stopGate.commands },
    { key: "allowedOutsidePaths", set: (v) => ({ allowedOutsidePaths: v }), get: (cfg) => cfg.allowedOutsidePaths, def: DEFAULTS.allowedOutsidePaths },
    // Card gates-config-shape-all-arrays: the six array-typed DEFAULTS keys the hand list (ARRAY_SHAPE_KEYS)
    // does not cover yet. Same cases as the four above, generated by the same loop below.
    { key: "proposalPaths", set: (v) => ({ proposalPaths: v }), get: (cfg) => cfg.proposalPaths, def: DEFAULTS.proposalPaths },
    {
      key: "bash.denyForcePushTo",
      set: (v) => ({ bash: { denyForcePushTo: v } }),
      get: (cfg) => cfg.bash.denyForcePushTo,
      def: DEFAULTS.bash.denyForcePushTo,
    },
    {
      key: "secrets.placeholders",
      set: (v) => ({ secrets: { placeholders: v } }),
      get: (cfg) => cfg.secrets.placeholders,
      def: DEFAULTS.secrets.placeholders,
    },
    {
      key: "secrets.ignorePaths",
      set: (v) => ({ secrets: { ignorePaths: v } }),
      get: (cfg) => cfg.secrets.ignorePaths,
      def: DEFAULTS.secrets.ignorePaths,
    },
    {
      key: "stopGate.evidencePatterns",
      set: (v) => ({ stopGate: { evidencePatterns: v } }),
      get: (cfg) => cfg.stopGate.evidencePatterns,
      def: DEFAULTS.stopGate.evidencePatterns,
    },
    { key: "anchor", set: (v) => ({ anchor: v }), get: (cfg) => cfg.anchor, def: DEFAULTS.anchor },
  ];

  for (const { key, set, get, def } of cases) {
    it(`falls back to the default and warns once naming the key when ${key} is a number`, () => {
      writeCfg(set(42));
      const { result: cfg, lines } = withStderrSpy(() => loadConfig(dir));
      expect(get(cfg)).toEqual(def);
      const hits = lines.filter((l) => l.includes(key) && l.includes("is not an array"));
      expect(hits.length, `expected exactly one stderr line naming ${key}; got ${JSON.stringify(lines)}`).toBe(1);
    });

    it(`falls back to the default and warns once naming the key when ${key} is a string`, () => {
      writeCfg(set("oops"));
      const { result: cfg, lines } = withStderrSpy(() => loadConfig(dir));
      expect(get(cfg)).toEqual(def);
      const hits = lines.filter((l) => l.includes(key) && l.includes("is not an array"));
      expect(hits.length, `expected exactly one stderr line naming ${key}; got ${JSON.stringify(lines)}`).toBe(1);
    });

    it(`falls back to the default and warns once naming the key when ${key} is an object`, () => {
      writeCfg(set({ not: "an array" }));
      const { result: cfg, lines } = withStderrSpy(() => loadConfig(dir));
      expect(get(cfg)).toEqual(def);
      const hits = lines.filter((l) => l.includes(key) && l.includes("is not an array"));
      expect(hits.length, `expected exactly one stderr line naming ${key}; got ${JSON.stringify(lines)}`).toBe(1);
    });

    it(`falls back to the default and warns once naming the key when ${key} is true`, () => {
      writeCfg(set(true));
      const { result: cfg, lines } = withStderrSpy(() => loadConfig(dir));
      expect(get(cfg)).toEqual(def);
      const hits = lines.filter((l) => l.includes(key) && l.includes("is not an array"));
      expect(hits.length, `expected exactly one stderr line naming ${key}; got ${JSON.stringify(lines)}`).toBe(1);
    });

    it(`passes a valid array through unchanged, with no warning, for ${key}`, () => {
      writeCfg(set(["x/**"]));
      const { result: cfg, lines } = withStderrSpy(() => loadConfig(dir));
      expect(get(cfg)).toEqual(["x/**"]);
      expect(lines.join(""), `expected no shape warning; got ${JSON.stringify(lines)}`).not.toMatch(/is not an array/);
    });

    it(`treats [] as valid (not invalid), passing it through unchanged for ${key}`, () => {
      writeCfg(set([]));
      const { result: cfg, lines } = withStderrSpy(() => loadConfig(dir));
      expect(get(cfg)).toEqual([]);
      expect(lines.join(""), `expected no shape warning for []; got ${JSON.stringify(lines)}`).not.toMatch(/is not an array/);
    });
  }

  it("normalises only the bad key; sibling keys and other config values are unaffected", () => {
    writeCfg({ protectedPaths: 42, bash: { denyNoVerify: false }, stopGate: { commands: ["test"] } });
    const { result: cfg } = withStderrSpy(() => loadConfig(dir));
    expect(cfg.protectedPaths).toEqual(DEFAULTS.protectedPaths);
    expect(cfg.bash.denyNoVerify).toBe(false);
    expect(cfg.stopGate.commands).toEqual(["test"]);
    expect(cfg.allowedOutsidePaths).toEqual(DEFAULTS.allowedOutsidePaths);
    expect(cfg.stopGate.ignoreChangedPaths).toEqual(DEFAULTS.stopGate.ignoreChangedPaths);
  });

  it("keeps today's behaviour for an explicit null: default via ??, no warning", () => {
    writeCfg({ protectedPaths: null, stopGate: { commands: null, ignoreChangedPaths: null }, allowedOutsidePaths: null });
    const { result: cfg, lines } = withStderrSpy(() => loadConfig(dir));
    expect(cfg.protectedPaths).toEqual(DEFAULTS.protectedPaths);
    expect(cfg.stopGate.commands).toEqual(DEFAULTS.stopGate.commands);
    expect(cfg.stopGate.ignoreChangedPaths).toEqual(DEFAULTS.stopGate.ignoreChangedPaths);
    expect(cfg.allowedOutsidePaths).toEqual(DEFAULTS.allowedOutsidePaths);
    expect(lines.join("")).not.toMatch(/is not an array/);
  });

  it("never throws when a bad-shape key is a number, string, object, or true, for all four keys at once", () => {
    writeCfg({ protectedPaths: 42, stopGate: { ignoreChangedPaths: "x", commands: {} }, allowedOutsidePaths: true });
    expect(() => withStderrSpy(() => loadConfig(dir))).not.toThrow();
  });

  // Card gates-config-shape-all-arrays: every array-typed value in DEFAULTS must be covered with no hand list
  // to edit. This walks DEFAULTS itself (nested objects included) rather than naming keys, so the check is
  // "derived from DEFAULTS" rather than pinned to today's ten keys — a hand list with only some of them, or a
  // walk that skips nested objects, both leave a path here uncovered.
  function walkArrayPaths(obj, prefix = []) {
    let out = [];
    for (const [k, v] of Object.entries(obj)) {
      const path = [...prefix, k];
      if (Array.isArray(v)) out.push(path);
      else if (v && typeof v === "object") out = out.concat(walkArrayPaths(v, path));
    }
    return out;
  }
  function buildNested(path, value) {
    const root = {};
    let cur = root;
    for (let i = 0; i < path.length - 1; i++) {
      cur[path[i]] = {};
      cur = cur[path[i]];
    }
    cur[path[path.length - 1]] = value;
    return root;
  }
  function getPath(obj, path) {
    return path.reduce((o, k) => (o == null ? undefined : o[k]), obj);
  }

  it("covers every array-typed default with no hand list, by walking DEFAULTS itself", () => {
    const paths = walkArrayPaths(DEFAULTS);
    // Sanity: the walk must actually find the ten known array-typed keys (protectedPaths, proposalPaths,
    // allowedOutsidePaths, bash.denyForcePushTo, secrets.placeholders, secrets.ignorePaths, stopGate.commands,
    // stopGate.ignoreChangedPaths, stopGate.evidencePatterns, anchor) or this test proves nothing.
    expect(paths.map((p) => p.join("."))).toEqual(
      expect.arrayContaining([
        "protectedPaths",
        "proposalPaths",
        "allowedOutsidePaths",
        "bash.denyForcePushTo",
        "secrets.placeholders",
        "secrets.ignorePaths",
        "stopGate.commands",
        "stopGate.ignoreChangedPaths",
        "stopGate.evidencePatterns",
        "anchor",
      ]),
    );
    for (const path of paths) {
      const dotted = path.join(".");
      writeCfg(buildNested(path, "oops"));
      const { result: cfg, lines } = withStderrSpy(() => loadConfig(dir));
      const def = getPath(DEFAULTS, path);
      expect(getPath(cfg, path), `expected ${dotted} to fall back to its default`).toEqual(def);
      const hits = lines.filter((l) => l.includes(dotted) && l.includes("is not an array"));
      expect(hits.length, `expected exactly one stderr line naming ${dotted}; got ${JSON.stringify(lines)}`).toBe(1);
    }
  });

  // Acceptance: "A parent object replaced by a non-object in the user file ... must not make loadConfig throw".
  // Both already pass at HEAD (today's hand list only ever touches its four leaves through plain property
  // access, which reads undefined rather than throwing when the parent above them is the wrong shape) — these
  // guard a future generic walk against adding a new throw when it recurses into a parent that turned out not
  // to be a plain object (mutation 4).
  it("does not throw when a parent object is replaced by a non-object array (stopGate: [1]), stays on the normal path, and leaves a sibling key alone", () => {
    writeCfg({ stopGate: [1], protectedPaths: ["x/**"] });
    expect(() => withStderrSpy(() => loadConfig(dir))).not.toThrow();
    const { result: cfg, lines } = withStderrSpy(() => loadConfig(dir));
    // Must go through the ordinary deepMerge/normalise path, not the broken-file catch-all (a real JSON parse
    // failure would also "not throw" here, but for the wrong reason: _present false, _error set, and every
    // key silently reset to its default rather than the user's own file being read at all).
    expect(cfg._present, "a parseable file with one oddly-shaped parent must still count as present").toBe(true);
    expect(lines.join(""), `expected no "is unreadable" fallback line; got ${JSON.stringify(lines)}`).not.toMatch(/is unreadable/);
    expect(cfg.protectedPaths, "a sibling key the user set must survive a malformed neighboring parent").toEqual(["x/**"]);
  });
  it('does not throw when a parent object is replaced by a non-object string (secrets: "x"), stays on the normal path, and leaves a sibling key alone', () => {
    writeCfg({ secrets: "x", bash: { denyNoVerify: false } });
    expect(() => withStderrSpy(() => loadConfig(dir))).not.toThrow();
    const { result: cfg, lines } = withStderrSpy(() => loadConfig(dir));
    expect(cfg._present, "a parseable file with one oddly-shaped parent must still count as present").toBe(true);
    expect(lines.join(""), `expected no "is unreadable" fallback line; got ${JSON.stringify(lines)}`).not.toMatch(/is unreadable/);
    expect(cfg.bash.denyNoVerify, "a sibling key the user set must survive a malformed neighboring parent").toBe(false);
  });
});

describe("state", () => {
  it("round-trips and sanitizes the session id", () => {
    const st = loadState(dir, "abc/../x");
    st.turns = 3;
    saveState(dir, "abc/../x", st);
    expect(existsSync(statePath(dir, "abc/../x"))).toBe(true);
    expect(statePath(dir, "abc/../x")).not.toContain("..");
    expect(loadState(dir, "abc/../x").turns).toBe(3);
  });
  it("returns an empty state for a missing session", () => {
    expect(loadState(dir, "nope").turns).toBe(0);
  });
  it("defaults baselineHead to null (card stop-scan-committed-changes)", () => {
    expect(emptyState().baselineHead).toBeNull();
  });
});

describe("baseline HEAD (card stop-scan-committed-changes)", () => {
  it("headAt and committedSince return null without a git repo", () => {
    expect(headAt(dir)).toBeNull();
    expect(committedSince(dir, "deadbeef")).toBeNull();
  });
  it("headAt returns null in a git repo with no commits yet; committedSince returns null for a non-string baseHead", () => {
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
    expect(headAt(dir)).toBeNull();
    expect(committedSince(dir, null)).toBeNull();
    expect(committedSince(dir, "")).toBeNull();
  });
  it("Minor 1: committedSince rejects a baseHead that does not look like a plausible git sha", () => {
    expect(committedSince(dir, "--output=/tmp/x")).toBeNull();
    expect(committedSince(dir, "not-hex-zzzz")).toBeNull();
    expect(committedSince(dir, "abc")).toBeNull(); // too short (< 7 hex chars)
  });
  it("Minor 3: a proposalPaths fixed prefix that resolves outside the project dir is skipped, not walked", () => {
    expect(walkProposalPathFiles(dir, ["../**"])).toEqual([]);
    expect(walkProposalPathFiles(dir, ["../../etc/**"])).toEqual([]);
  });
});

describe("paths", () => {
  it("makes paths project-relative and rejects escapes", () => {
    expect(toProjectRelative("/p/x", "/p/x/src/a.ts")).toBe("src/a.ts");
    expect(toProjectRelative("/p/x", "src/a.ts")).toBe("src/a.ts");
    expect(toProjectRelative("/p/x", "/p/y/a.ts")).toBeNull();
    expect(toProjectRelative("/p/x", "../y")).toBeNull();
  });
  it("extracts paths from Edit, Write and MultiEdit inputs", () => {
    expect(filePathsFromToolInput({ file_path: "a" })).toEqual(["a"]);
    expect(filePathsFromToolInput({ edits: [{ file_path: "b" }, { file_path: "c" }] })).toEqual(["b", "c"]);
    expect(filePathsFromToolInput(null)).toEqual([]);
  });
});

describe("isAllowedOutside", () => {
  it("allows an exact match and anything inside a directory entry", () => {
    expect(isAllowedOutside("/home/user/memory", ["/home/user/memory"])).toBe(true);
    expect(isAllowedOutside("/home/user/memory/notes.md", ["/home/user/memory"])).toBe(true);
  });
  it("requires a real path-segment boundary, not a plain prefix", () => {
    expect(isAllowedOutside("/home/user/memory-other/notes.md", ["/home/user/memory"])).toBe(false);
  });
  it("resolves .. on both sides so it cannot escape an allowed dir", () => {
    expect(isAllowedOutside("/home/user/memory/../escape.md", ["/home/user/memory"])).toBe(false);
    expect(isAllowedOutside("/home/user/memory/sub/x", ["/home/user/other/../memory"])).toBe(true);
  });
  it("ignores entries that are empty or not strings", () => {
    expect(isAllowedOutside("/home/user/memory/x", ["", null, 42, "/home/user/memory"])).toBe(true);
    expect(isAllowedOutside("/home/user/memory/x", ["", null, 42])).toBe(false);
  });
  it("is not fooled by a plain startsWith with no boundary check", () => {
    // Pins the segment-boundary requirement independent of the sibling-prefix test above.
    expect(isAllowedOutside("/a/allowed-evil", ["/a/allowed"])).toBe(false);
  });

  it("resolves a symlink inside an allowed directory to its real target, unit-level (item 3)", () => {
    // protect-paths.mjs (item 2) already realpath-resolves its own target before calling isAllowedOutside, so
    // an end-to-end test through the hook cannot isolate isAllowedOutside's OWN resolution from that caller's.
    // Calling it directly, with the raw (unresolved) symlink path, pins the fix isAllowedOutside must carry on
    // its own — the same primitive protect-paths.mjs also happens to apply upstream.
    const outsideDir = mkdtempSync(join(tmpdir(), "doug-outside-"));
    const secretFile = join(outsideDir, "secret.md");
    writeFileSync(secretFile, "outside");
    const allowedDir = mkdtempSync(join(tmpdir(), "doug-allowed-"));
    const linkInsideAllowed = join(allowedDir, "escape-link.md");
    symlinkSync(secretFile, linkInsideAllowed, "file");
    // Lexically, linkInsideAllowed sits inside allowedDir; really, it points outside it.
    expect(isAllowedOutside(linkInsideAllowed, [allowedDir])).toBe(false);
  });

  it("ignores an allowedOutsidePaths entry that is a symlink to the filesystem root", () => {
    // The entry resolves lexically to a harmless-looking path; only realpath reveals it is "/", which as a
    // containment prefix would match every absolute path and disable the guard entirely.
    const parent = mkdtempSync(join(tmpdir(), "doug-rootlink-"));
    const linkToRoot = join(parent, "allowed");
    symlinkSync("/", linkToRoot, "dir");
    expect(isAllowedOutside("/etc/hosts", [linkToRoot])).toBe(false);
    expect(isAllowedOutside(join(homedir(), ".ssh", "config"), [linkToRoot])).toBe(false);
    expect(isAllowedOutside(join(parent, "notes.md"), [linkToRoot])).toBe(false);
  });

  describe("tilde expansion (item 1: does not escape to the filesystem root)", () => {
    const origHome = process.env.HOME;
    afterEach(() => {
      if (origHome === undefined) delete process.env.HOME;
      else process.env.HOME = origHome;
    });

    it("~ resolves to the real home dir and allows a path under it", () => {
      expect(isAllowedOutside(join(homedir(), "x"), ["~"])).toBe(true);
    });
    it("~/ behaves the same as ~", () => {
      expect(isAllowedOutside(join(homedir(), "x"), ["~/"])).toBe(true);
    });
    it("~// allows only under home, not the whole filesystem", () => {
      expect(isAllowedOutside("/etc/hosts", ["~//"])).toBe(false);
      expect(isAllowedOutside(join(homedir(), "x"), ["~//"])).toBe(true);
    });
    it("~//etc allows $HOME/etc/... but not bare /etc/...", () => {
      expect(isAllowedOutside(join(homedir(), "etc", "passwd"), ["~//etc"])).toBe(true);
      expect(isAllowedOutside("/etc/passwd", ["~//etc"])).toBe(false);
    });
    it("~x is a literal relative path, not home-relative", () => {
      expect(isAllowedOutside(join(homedir(), "x", "y"), ["~x"])).toBe(false);
    });
    it("~root/x is treated literally, no special-user-home expansion", () => {
      expect(isAllowedOutside(join(homedir(), "y"), ["~root/x"])).toBe(false);
      expect(isAllowedOutside("/root/x/y", ["~root/x"])).toBe(false);
    });
    it("a literal ~ mid-path is left untouched", () => {
      expect(isAllowedOutside("/foo/~/bar/x", ["/foo/~/bar"])).toBe(true);
    });
    it("with HOME=/, entry ~ is ignored (resolves to the filesystem root) so nothing is allowed", () => {
      process.env.HOME = "/";
      expect(isAllowedOutside("/etc/hosts", ["~"])).toBe(false);
      expect(isAllowedOutside("/", ["~"])).toBe(false);
      expect(isAllowedOutside("/anything/at/all", ["~"])).toBe(false);
    });
    it("an explicit / entry is ignored even with a normal HOME", () => {
      expect(isAllowedOutside("/etc/hosts", ["/"])).toBe(false);
      expect(isAllowedOutside("/", ["/"])).toBe(false);
    });
  });
});
