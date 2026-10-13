// card verified-tree-record, brief A: lib/verified-tree.mjs (tree hash, record, creditable) and
// scripts/verify.mjs end to end. Design: .doug/.state/briefs/verified-tree-record-design.md sections 1, 4, 6.
import { describe, it, expect } from "vitest";
import { spawnSync, spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync, renameSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseTotals } from "../lib/test-totals.mjs";
import * as gateLock from "../lib/gate-lock.mjs";
const { gateLockPath } = gateLock;
import { computeTree, readRecord, writeRecord, removeRecord, creditable, noTestPathHit, resolveCommands, RECORD_RELPATH } from "../lib/verified-tree.mjs";

const VERIFY = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "verify.mjs");
const GATE_LOCK_LIB = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), "..", "lib", "gate-lock.mjs")).href;

function cleanEnv(extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith("GIT_")) env[k] = v;
  return { ...env, ...extra };
}
function git(cwd, args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", env: cleanEnv() });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}
function write(dir, rel, text) {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), text);
}
function makeRepo(files = {}, { commit = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "doug-vt-"));
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "t@example.com"]);
  git(dir, ["config", "user.name", "t"]);
  for (const [rel, text] of Object.entries(files)) write(dir, rel, text);
  if (commit) commitAll(dir);
  return dir;
}
function commitAll(dir, msg = "c") {
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "--allow-empty", "-m", msg]);
}
const headTree = (dir) => git(dir, ["rev-parse", "HEAD^{tree}"]);

const BASE = { ".gitignore": "node_modules/\n.env\n", "a.js": "export const a = 1;\n" };

describe("computeTree (card verified-tree-record V1-V4)", () => {
  it("V1: a clean commit hashes to HEAD^{tree}; an untracked file is included; ignored files are not", () => {
    const dir = makeRepo(BASE);
    expect(computeTree(dir)).toBe(headTree(dir));
    write(dir, "x.js", "x\n");
    const expected = makeRepo({ ...BASE, "x.js": "x\n" });
    expect(computeTree(dir)).toBe(headTree(expected));
    // ignored files never change the sha
    write(dir, "node_modules/p/index.js", "module.exports = 1;\n");
    write(dir, ".env", "SECRET=1\n");
    expect(computeTree(dir)).toBe(headTree(expected));
  });

  it("V1: .doug/.state, .claude/worktrees and .doug/anchor.md are absent, untracked and tracked", () => {
    const plain = makeRepo(BASE);
    const want = headTree(plain);
    // untracked, not gitignored here (no ignore rules for them)
    const u = makeRepo(BASE);
    write(u, ".doug/.state/ran.marker", "1\n");
    write(u, ".doug/.state/sub/deep.json", "{}\n");
    write(u, ".claude/worktrees/w1/file.txt", "w\n");
    write(u, ".doug/anchor.md", "anchor\n");
    expect(computeTree(u)).toBe(want);
    // tracked: force-added into the real index and committed, then modified
    const t = makeRepo(BASE, { commit: false });
    write(t, ".doug/.state/ran.marker", "1\n");
    write(t, ".claude/worktrees/w1/file.txt", "w\n");
    write(t, ".doug/anchor.md", "anchor v1\n");
    commitAll(t);
    write(t, ".doug/.state/ran.marker", "2\n");
    write(t, ".claude/worktrees/w1/file.txt", "w2\n");
    write(t, ".doug/anchor.md", "anchor v2\n");
    expect(computeTree(t)).toBe(want);
  });

  it("V2: leaves the real index and the staged diff alone, and no temp index file behind", () => {
    const dir = makeRepo(BASE);
    write(dir, "x.js", "x\n");
    write(dir, "a.js", "export const a = 2;\n");
    git(dir, ["add", "a.js"]);
    write(dir, "y.js", "y\n");
    const indexBefore = readFileSync(join(dir, ".git/index"));
    const cachedBefore = git(dir, ["diff", "--cached"]);
    const statusBefore = git(dir, ["status", "--porcelain"]);
    expect(computeTree(dir)).toMatch(/^[0-9a-f]{40}([0-9a-f]{24})?$/);
    expect(readFileSync(join(dir, ".git/index")).equals(indexBefore)).toBe(true);
    expect(git(dir, ["diff", "--cached"])).toBe(cachedBefore);
    expect(git(dir, ["status", "--porcelain"])).toBe(statusBefore);
    const state = join(dir, ".doug/.state");
    const left = existsSync(state) ? readdirSync(state).filter((f) => f.startsWith("verified-tree.index")) : [];
    expect(left).toEqual([]);
  });

  it("V2: honours a custom tmpDir for the temp index and cleans it", () => {
    const dir = makeRepo(BASE);
    write(dir, "x.js", "x\n");
    const tmp = mkdtempSync(join(tmpdir(), "doug-vt-tmp-"));
    expect(computeTree(dir, { tmpDir: tmp })).toMatch(/^[0-9a-f]{40}/);
    expect(readdirSync(tmp)).toEqual([]);
  });

  it("V3: the sha is the same before and after the working tree is committed", () => {
    const dir = makeRepo(BASE);
    write(dir, "x.js", "x\n");
    write(dir, "a.js", "export const a = 3;\n");
    write(dir, "docs/n.md", "n\n");
    const before = computeTree(dir);
    commitAll(dir);
    expect(computeTree(dir)).toBe(before);
    expect(headTree(dir)).toBe(before);
  });

  // Mb: git's racy-clean check compares entry mtimes with the index FILE's mtime. A same-size edit made in the
  // same second as the last index write only reads as changed if the temp index copy keeps the real index's times.
  it("V2b: a same-size edit in the same second as the last index write is still hashed (racy git)", () => {
    const sleepMs = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    const sec = (p) => Math.floor(statSync(p).mtimeMs / 1000);
    let dir = null;
    for (let attempt = 0; attempt < 8 && !dir; attempt++) {
      // start early in a second so the next few steps share it
      sleepMs(1000 - (Date.now() % 1000) + 20);
      const d = makeRepo({ "f.txt": "aaaa\n" });
      write(d, "f.txt", "bbbb\n");
      git(d, ["add", "f.txt"]); // real index written now, entry mtime = this second
      write(d, "f.txt", "cccc\n"); // same size, same second, index still says bbbb
      if (sec(join(d, "f.txt")) === sec(join(d, ".git/index"))) dir = d;
    }
    expect(dir, "could not land the edit in the index's second after 8 attempts").not.toBeNull();
    sleepMs(1000 - (Date.now() % 1000) + 50); // the next whole second: the temp index copy would now look newer
    const scratch = mkdtempSync(join(tmpdir(), "doug-vt-fresh-"));
    const freshIndex = join(scratch, "index");
    const fresh = (args) => {
      const r = spawnSync("git", args, { cwd: dir, encoding: "utf8", env: cleanEnv({ GIT_INDEX_FILE: freshIndex }) });
      if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
      return r.stdout.trim();
    };
    fresh(["add", "-A"]);
    const expected = fresh(["write-tree"]);
    expect(expected).not.toBe(headTree(dir));
    expect(computeTree(dir)).toBe(expected);
  });

  it("V4: null for a non-repo dir", () => {
    const dir = mkdtempSync(join(tmpdir(), "doug-vt-norepo-"));
    write(dir, "a.js", "a\n");
    expect(computeTree(dir)).toBeNull();
  });

  it("V4: null when the tree holds a gitlink (nested repo)", () => {
    const dir = makeRepo(BASE);
    const sub = join(dir, "vendor/sub");
    mkdirSync(sub, { recursive: true });
    git(sub, ["init", "-q", "-b", "main"]);
    git(sub, ["config", "user.email", "t@example.com"]);
    git(sub, ["config", "user.name", "t"]);
    write(sub, "f.txt", "f\n");
    git(sub, ["add", "-A"]);
    git(sub, ["commit", "-q", "-m", "s"]);
    expect(computeTree(dir)).toBeNull();
  });

  it("V4: null when an entry is assume-unchanged or skip-worktree", () => {
    const a = makeRepo(BASE);
    git(a, ["update-index", "--assume-unchanged", "a.js"]);
    expect(computeTree(a)).toBeNull();
    const b = makeRepo(BASE);
    git(b, ["update-index", "--skip-worktree", "a.js"]);
    expect(computeTree(b)).toBeNull();
  });

  it("V4: GIT_INDEX_FILE / GIT_DIR in the environment do not change the result", () => {
    const dir = makeRepo(BASE);
    write(dir, "x.js", "x\n");
    const want = computeTree(dir);
    expect(want).not.toBeNull();
    const decoy = makeRepo({ "other.txt": "o\n" });
    const saved = { d: process.env.GIT_DIR, i: process.env.GIT_INDEX_FILE, w: process.env.GIT_WORK_TREE };
    try {
      process.env.GIT_DIR = join(decoy, ".git");
      process.env.GIT_INDEX_FILE = join(decoy, ".git/index");
      process.env.GIT_WORK_TREE = decoy;
      expect(computeTree(dir)).toBe(want);
    } finally {
      for (const [k, v] of [["GIT_DIR", saved.d], ["GIT_INDEX_FILE", saved.i], ["GIT_WORK_TREE", saved.w]]) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
    expect(readdirSync(decoy)).not.toContain("x.js");
  });
});

const CMDS = ["pnpm typecheck", "pnpm test:unit"];
const SHA_A = "a".repeat(40);
function validRecord(over = {}) {
  return {
    version: 1,
    tree: SHA_A,
    node: process.version,
    at: "2026-10-07T00:00:00.000Z",
    by: "verify",
    commands: [
      { name: "typecheck", command: CMDS[0], exit: 0, durationMs: 100 },
      { name: "test:unit", command: CMDS[1], exit: 0, durationMs: 200 },
    ],
    totals: {},
    ...over,
  };
}
const recPath = (dir) => join(dir, RECORD_RELPATH);

describe("record read/write (card verified-tree-record V5-V6)", () => {
  it("RECORD_RELPATH is .doug/.state/verified-tree.json", () => {
    expect(RECORD_RELPATH).toBe(".doug/.state/verified-tree.json");
  });

  it("V5: a valid record reads back; totals may be empty or hold parseTotals results", () => {
    const dir = mkdtempSync(join(tmpdir(), "doug-vt-rec-"));
    mkdirSync(join(dir, ".doug/.state"), { recursive: true });
    writeFileSync(recPath(dir), JSON.stringify(validRecord()));
    expect(readRecord(dir)).toEqual(validRecord());
    const withTotals = validRecord({ totals: { "pnpm test:unit": { status: "ok", summaries: [{ total: 3, skipped: 0, todo: 0 }] } } });
    writeFileSync(recPath(dir), JSON.stringify(withTotals));
    expect(readRecord(dir)).toEqual(withTotals);
  });

  it("V5: null for a missing file, bad JSON, version 2, a bad tree, empty commands, a non-integer exit; never throws", () => {
    const dir = mkdtempSync(join(tmpdir(), "doug-vt-rec-"));
    expect(readRecord(dir)).toBeNull();
    mkdirSync(join(dir, ".doug/.state"), { recursive: true });
    const bad = [
      "{",
      "null",
      "[]",
      JSON.stringify(validRecord({ version: 2 })),
      JSON.stringify(validRecord({ tree: "xyz" })),
      JSON.stringify(validRecord({ tree: "A".repeat(40) })),
      JSON.stringify(validRecord({ tree: "a".repeat(41) })),
      JSON.stringify(validRecord({ commands: [] })),
      JSON.stringify(validRecord({ commands: "pnpm test" })),
      JSON.stringify(validRecord({ commands: [{ name: "t", command: "x", exit: 0.5, durationMs: 1 }] })),
      JSON.stringify(validRecord({ commands: [{ name: "t", command: "x", exit: "0", durationMs: 1 }] })),
      JSON.stringify(validRecord({ commands: [{ name: "t", command: "", exit: 0, durationMs: 1 }] })),
      JSON.stringify(validRecord({ commands: [{ name: "t", command: "x", exit: 0 }] })),
      JSON.stringify(validRecord({ totals: [] })),
      JSON.stringify(validRecord({ totals: null })),
      JSON.stringify(validRecord({ node: 22 })),
      JSON.stringify(validRecord({ at: undefined })),
    ];
    for (const text of bad) {
      writeFileSync(recPath(dir), text);
      expect(readRecord(dir), text).toBeNull();
    }
    // a directory where the file should be: still null, no throw
    rmSync(recPath(dir), { force: true });
    mkdirSync(recPath(dir));
    expect(readRecord(dir)).toBeNull();
  });

  it("V6: writeRecord round-trips, creates .doug/.state, replaces an older record, and leaves no tmp file", () => {
    const dir = mkdtempSync(join(tmpdir(), "doug-vt-rec-"));
    writeRecord(dir, validRecord());
    expect(readRecord(dir)).toEqual(validRecord());
    writeRecord(dir, validRecord({ tree: "b".repeat(40), by: "stop" }));
    expect(readRecord(dir).tree).toBe("b".repeat(40));
    expect(readdirSync(join(dir, ".doug/.state"))).toEqual(["verified-tree.json"]);
  });

  it("V6: removeRecord deletes the record and tolerates a missing one", () => {
    const dir = mkdtempSync(join(tmpdir(), "doug-vt-rec-"));
    writeRecord(dir, validRecord());
    removeRecord(dir);
    expect(existsSync(recPath(dir))).toBe(false);
    expect(() => removeRecord(dir)).not.toThrow();
    expect(() => removeRecord(join(dir, "nope"))).not.toThrow();
  });
});

describe("noTestPathHit and resolveCommands", () => {
  it("noTestPathHit: exact match, or prefix match for an entry ending in /", () => {
    expect(noTestPathHit([".doug/board.json"], ".doug/board.json")).toBe(true);
    expect(noTestPathHit([".doug/board.json"], ".doug/board.json.bak")).toBe(false);
    expect(noTestPathHit(["docs/"], "docs/a/b.md")).toBe(true);
    expect(noTestPathHit(["docs/"], "docsx/a.md")).toBe(false);
    expect(noTestPathHit(["docs/"], "src/a.js")).toBe(false);
  });

  it("resolveCommands maps stopGate.commands through cfg.commands, keeping names and config order", () => {
    const cfg = { commands: { typecheck: "pnpm typecheck", test: "pnpm test:unit" }, stopGate: { commands: ["typecheck", "test", "echo raw", 7] } };
    expect(resolveCommands(cfg)).toEqual([
      { name: "typecheck", command: "pnpm typecheck" },
      { name: "test", command: "pnpm test:unit" },
      { name: "echo raw", command: "echo raw" },
    ]);
  });
});

describe("creditable (card verified-tree-record V7)", () => {
  const LIST = [".doug/board.json", "docs/"];
  const cfgWith = (noTestPaths) => ({ preCommit: noTestPaths === undefined ? {} : { noTestPaths } });
  const BASEFILES = {
    ".gitignore": ".doug/.state/\n",
    "a.js": "a\n",
    "src/a.js": "export const a = 1;\n",
    "docs/x": "x\n",
    ".doug/board.json": "{}\n",
    ".doug/config.json": "{}\n",
  };
  // A committed repo whose current tree is the record's tree; `mutate` then changes the working tree.
  function scenario(mutate = () => {}) {
    const dir = makeRepo(BASEFILES);
    const recTree = computeTree(dir);
    mutate(dir);
    return { dir, recTree, curTree: computeTree(dir) };
  }
  const check = (s, { cfg = cfgWith(LIST), record = {}, commands = CMDS } = {}) => creditable(s.dir, cfg, validRecord({ tree: s.recTree, ...record }), s.curTree, commands);

  it("an equal tree credits with an empty diff", () => {
    const s = scenario();
    expect(s.curTree).toBe(s.recTree);
    expect(check(s)).toEqual({ ok: true, diff: [] });
  });

  it("an equal tree credits even with no noTestPaths list", () => {
    const s = scenario();
    for (const list of [undefined, [], [""]]) expect(check(s, { cfg: cfgWith(list) }).ok).toBe(true);
  });

  it("a diff of only .doug/board.json (exact entry) credits and names the path", () => {
    const s = scenario((d) => write(d, ".doug/board.json", '{"cards":[1]}\n'));
    expect(s.curTree).not.toBe(s.recTree);
    const r = check(s);
    expect(r.ok).toBe(true);
    expect(r.diff).toEqual([".doug/board.json"]);
  });

  it("a diff of only docs/x under a docs/ entry credits", () => {
    const s = scenario((d) => write(d, "docs/x", "changed\n"));
    expect(check(s).ok).toBe(true);
  });

  it("docs/x plus src/a.js does not credit", () => {
    const s = scenario((d) => {
      write(d, "docs/x", "changed\n");
      write(d, "src/a.js", "export const a = 2;\n");
    });
    const r = check(s);
    expect(r.ok).toBe(false);
    expect(typeof r.why).toBe("string");
  });

  it("a rename out of src/ into docs/ does not credit (the source path counts)", () => {
    const s = scenario((d) => {
      mkdirSync(join(d, "docs"), { recursive: true });
      renameSync(join(d, "src/a.js"), join(d, "docs/a.js"));
    });
    expect(check(s).ok).toBe(false);
  });

  it("a deleted source file does not credit", () => {
    const s = scenario((d) => rmSync(join(d, "src/a.js")));
    expect(check(s).ok).toBe(false);
  });

  it(".doug/config.json in the diff never credits, even when listed", () => {
    const s = scenario((d) => write(d, ".doug/config.json", '{"x":1}\n'));
    expect(check(s, { cfg: cfgWith([".doug/config.json", "docs/"]) }).ok).toBe(false);
    expect(check(s, { cfg: cfgWith([".doug/"]) }).ok).toBe(false);
  });

  it("a missing, empty or blank-entry list credits only an equal tree", () => {
    const s = scenario((d) => write(d, "docs/x", "changed\n"));
    for (const list of [undefined, [], [""], "docs/", [1]]) expect(check(s, { cfg: cfgWith(list) }).ok, JSON.stringify(list)).toBe(false);
    expect(creditable(s.dir, {}, validRecord({ tree: s.recTree }), s.curTree, CMDS).ok).toBe(false);
  });

  it("the same command set in another order credits; an extra, missing or changed command does not", () => {
    const s = scenario();
    expect(check(s, { commands: [CMDS[1], CMDS[0]] }).ok).toBe(true);
    expect(check(s, { commands: [...CMDS, "pnpm build"] }).ok).toBe(false);
    expect(check(s, { commands: [CMDS[0]] }).ok).toBe(false);
    expect(check(s, { commands: [CMDS[0], "pnpm test"] }).ok).toBe(false);
  });

  it("a record with a non-zero exit does not credit", () => {
    const s = scenario();
    const commands = validRecord().commands.map((c, i) => (i === 1 ? { ...c, exit: 1 } : c));
    expect(check(s, { record: { commands } }).ok).toBe(false);
  });

  it("a record from another Node version does not credit", () => {
    const s = scenario();
    expect(check(s, { record: { node: "v0.0.0" } }).ok).toBe(false);
  });

  it("an invalid current tree or malformed record does not credit", () => {
    const s = scenario();
    expect(creditable(s.dir, cfgWith(LIST), validRecord({ tree: s.recTree }), null, CMDS).ok).toBe(false);
    expect(creditable(s.dir, cfgWith(LIST), validRecord({ tree: s.recTree }), "not-a-sha", CMDS).ok).toBe(false);
    expect(creditable(s.dir, cfgWith(LIST), { version: 1 }, s.curTree, CMDS).ok).toBe(false);
    expect(creditable(s.dir, cfgWith(LIST), null, s.curTree, CMDS).ok).toBe(false);
  });

  it("a record tree unknown to git does not credit (pruned or foreign)", () => {
    const s = scenario((d) => write(d, "docs/x", "changed\n"));
    const r = creditable(s.dir, cfgWith(LIST), validRecord({ tree: "0123456789abcdef0123456789abcdef01234567" }), s.curTree, CMDS);
    expect(r.ok).toBe(false);
  });
});

describe("verify.mjs end to end (card verified-tree-record V8)", () => {
  const T = [
    `import { appendFileSync, mkdirSync } from "node:fs";`,
    `mkdirSync(".doug/.state", { recursive: true });`,
    `appendFileSync(".doug/.state/ran.marker", "ran\\n");`,
    `console.log("Tests  3 passed (3)");`,
    ``,
  ].join("\n");
  const T_RED = T.replace(`console.log("Tests  3 passed (3)");`, `console.log("FAILING-OUTPUT-MARK");\nconsole.error("FAILING-STDERR-MARK");\nprocess.exit(1);`);
  const CONFIG = { commands: { test: "node t.mjs" }, stopGate: { commands: ["test"], timeoutMs: 60000 } };

  function fixture({ git: useGit = true, config = CONFIG } = {}) {
    const files = { "t.mjs": T, ".doug/config.json": JSON.stringify(config), ".gitignore": ".doug/.state/\n" };
    if (useGit) return makeRepo(files);
    const dir = mkdtempSync(join(tmpdir(), "doug-vt-nogit-"));
    for (const [rel, text] of Object.entries(files)) write(dir, rel, text);
    return dir;
  }
  const verify = (dir, args = []) => {
    const r = spawnSync(process.execPath, [VERIFY, ...args], { cwd: dir, encoding: "utf8", env: cleanEnv(), timeout: 60000 });
    return { status: r.status, stdout: r.stdout || "", stderr: r.stderr || "", out: `${r.stdout || ""}${r.stderr || ""}` };
  };
  const runs = (dir) => {
    const p = join(dir, ".doug/.state/ran.marker");
    return existsSync(p) ? readFileSync(p, "utf8").split("\n").filter(Boolean).length : 0;
  };
  const lastLine = (s) => s.trim().split("\n").pop();

  it("a green run prints the gate line last, exits 0, and writes a record for the tree", () => {
    const dir = fixture();
    const r = verify(dir);
    expect(r.status, r.out).toBe(0);
    expect(lastLine(r.stdout)).toBe("gate: test 0 (3 passed)");
    expect(runs(dir)).toBe(1);
    const rec = readRecord(dir);
    expect(rec, "expected a valid record at " + RECORD_RELPATH).not.toBeNull();
    expect(rec.by).toBe("verify");
    expect(rec.tree).toBe(computeTree(dir));
    expect(rec.node).toBe(process.version);
    expect(rec.commands.map((c) => [c.name, c.command, c.exit])).toEqual([["test", "node t.mjs", 0]]);
    expect(rec.totals["node t.mjs"]?.status).toBe("ok");
  });

  it("a second run on the same tree is credited: says so, does not rerun, same gate line", () => {
    const dir = fixture();
    expect(verify(dir).status).toBe(0);
    const r = verify(dir);
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain("credited verified-tree record");
    expect(runs(dir)).toBe(1);
    expect(lastLine(r.stdout)).toBe("gate: test 0 (3 passed)");
  });

  it("--no-credit runs the commands even with a matching record", () => {
    const dir = fixture();
    verify(dir);
    const r = verify(dir, ["--no-credit"]);
    expect(r.status, r.out).toBe(0);
    expect(r.out).not.toContain("credited verified-tree record");
    expect(runs(dir)).toBe(2);
  });

  // Mh: a command that edits the tree mid-run must leave no record (treeBefore !== treeAfter).
  for (const [label, edit] of [
    ["a tracked file", `appendFileSync("a.js", "// edited\\n");`],
    ["a new untracked non-ignored file", `writeFileSync("generated.txt", "new\\n");`],
  ]) {
    it(`a command that edits ${label} mid-run: exit by result, no record written`, () => {
      const script = T.replace(`import { appendFileSync, mkdirSync } from "node:fs";`, `import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";`).replace(`console.log("Tests`, `${edit}\nconsole.log("Tests`);
      const dir = makeRepo({ "a.js": "export const a = 1;\n", "t.mjs": script, ".doug/config.json": JSON.stringify(CONFIG), ".gitignore": ".doug/.state/\n" });
      const r = verify(dir);
      expect(r.status, r.out).toBe(0);
      expect(runs(dir)).toBe(1);
      expect(lastLine(r.stdout)).toBe("gate: test 0 (3 passed)");
      expect(existsSync(join(dir, RECORD_RELPATH)), "a tree that changed during the run must not be recorded").toBe(false);
    });
  }

  it("a changed tree is not credited and runs again", () => {
    const dir = fixture();
    verify(dir);
    write(dir, "extra.js", "export {};\n");
    const r = verify(dir);
    expect(r.status, r.out).toBe(0);
    expect(runs(dir)).toBe(2);
    expect(readRecord(dir).tree).toBe(computeTree(dir));
  });

  it("a red run exits 1, prints the failing output untruncated, and removes the record", () => {
    const dir = fixture();
    expect(verify(dir).status).toBe(0);
    expect(readRecord(dir)).not.toBeNull();
    write(dir, "t.mjs", T_RED);
    const r = verify(dir);
    expect(r.status, r.out).toBe(1);
    expect(r.out).toContain("FAILING-OUTPUT-MARK");
    expect(r.out).toContain("FAILING-STDERR-MARK");
    expect(existsSync(recPath(dir))).toBe(false);
  });

  it("a non-git dir runs the commands, exits 0, and writes no record", () => {
    const dir = fixture({ git: false });
    const r = verify(dir);
    expect(r.status, r.out).toBe(0);
    expect(runs(dir)).toBe(1);
    expect(existsSync(recPath(dir))).toBe(false);
    expect(lastLine(r.stdout)).toBe("gate: test 0 (3 passed)");
  });

  it("--command replaces the configured commands", () => {
    const dir = fixture();
    const r = verify(dir, ["--command", "node t.mjs", "--command", "node -e \"process.exit(0)\""]);
    expect(r.status, r.out).toBe(0);
    expect(runs(dir)).toBe(1);
    expect(lastLine(r.stdout)).toMatch(/^gate: node t\.mjs 0 \(3 passed\); node -e .* 0$/);
  });

  it("--json prints one object with ok, credited, tree and per-command results", () => {
    const dir = fixture();
    const r = verify(dir, ["--json"]);
    expect(r.status, r.out).toBe(0);
    const j = JSON.parse(r.stdout.trim());
    expect(j.ok).toBe(true);
    expect(j.credited).toBeFalsy();
    expect(j.tree).toBe(computeTree(dir));
    expect(j.results).toHaveLength(1);
    expect(j.results[0]).toMatchObject({ name: "test", command: "node t.mjs", ok: true, timedOut: false });
    const again = JSON.parse(verify(dir, ["--json"]).stdout.trim());
    expect(again.ok).toBe(true);
    expect(again.credited).toBeTruthy();
    expect(runs(dir)).toBe(1);
  });

  // Card flow-suite-dedupe: a record of the same tree in another directory (a task worktree) credits through --credit-dir.
  const sameTreeTwice = () => {
    const b = fixture();
    expect(verify(b).status).toBe(0);
    const a = fixture();
    expect(computeTree(a)).toBe(computeTree(b));
    return { a, b };
  };

  it("VD1: --credit-dir credits a record of the same tree held in another dir, and writes it into the record dir", () => {
    const { a, b } = sameTreeTwice();
    const r = verify(a, ["--json", "--credit-dir", b]);
    expect(r.status, r.out).toBe(0);
    expect(runs(a), "a credited command must not run").toBe(0);
    const j = JSON.parse(r.stdout.trim());
    expect(j.credited).toBe("verified-tree");
    expect(readRecord(a)?.tree).toBe(computeTree(a));
  });

  it("VD3: --credit-dir refuses a record whose tree differs from the cwd tree, and one whose command set differs; the commands run", () => {
    const { a, b } = sameTreeTwice();
    write(a, "extra.js", "export {};\n");
    expect(computeTree(a)).not.toBe(computeTree(b));
    const r1 = verify(a, ["--json", "--credit-dir", b]);
    expect(r1.status, r1.out).toBe(0);
    expect(runs(a), "a differing tree must not be credited").toBe(1);
    expect(JSON.parse(r1.stdout.trim()).credited).toBeFalsy();

    const { a: a2, b: b2 } = sameTreeTwice();
    const r2 = verify(a2, ["--json", "--credit-dir", b2, "--command", "node t.mjs", "--command", "node -e \"process.exit(0)\""]);
    expect(r2.status, r2.out).toBe(0);
    expect(runs(a2), "a differing command set must not be credited").toBe(1);
    expect(JSON.parse(r2.stdout.trim()).credited).toBeFalsy();
  });

  it("VD2: without --credit-dir the same setup runs the commands", () => {
    const { a } = sameTreeTwice();
    const r = verify(a, ["--json"]);
    expect(r.status, r.out).toBe(0);
    expect(runs(a)).toBe(1);
  });

  it("no commands configured: usage error, exit 2", () => {
    const dir = fixture({ config: { stopGate: { commands: [] } } });
    const r = verify(dir);
    expect(r.status, r.out).toBe(2);
    expect(runs(dir)).toBe(0);
  });
});

// Card verify-takes-gate-lock: verify.mjs takes the Stop gate's gate.lock (gateLockPath) around its commands.
describe("verify.mjs takes gate.lock (card verify-takes-gate-lock)", () => {
  const T = [
    `import { appendFileSync, mkdirSync, copyFileSync, existsSync } from "node:fs";`,
    `import { gateLockPath } from "${GATE_LOCK_LIB}";`,
    `mkdirSync(".doug/.state", { recursive: true });`,
    `appendFileSync(".doug/.state/ran.marker", "ran\\n");`,
    `if (existsSync(gateLockPath(process.cwd()))) copyFileSync(gateLockPath(process.cwd()), ".doug/.state/lock.seen");`,
    `console.log("Tests  3 passed (3)");`,
    ``,
  ].join("\n");
  const T_RED = T.replace(`console.log("Tests  3 passed (3)");`, `console.error("RED-MARK");\nprocess.exit(1);`);
  const CONFIG = { commands: { test: "node t.mjs" }, stopGate: { commands: ["test"], timeoutMs: 60000 } };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const fixture = () => makeRepo({ "t.mjs": T, ".doug/config.json": JSON.stringify(CONFIG), ".gitignore": ".doug/.state/\n" });
  const runs = (dir) => {
    const p = join(dir, ".doug/.state/ran.marker");
    return existsSync(p) ? readFileSync(p, "utf8").split("\n").filter(Boolean).length : 0;
  };
  const lastLine = (s) => s.trim().split("\n").pop();
  function startVerify(dir, args = []) {
    const child = spawn(process.execPath, [VERIFY, ...args], { cwd: dir, env: cleanEnv() });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const t0 = Date.now();
    const done = new Promise((res) => child.on("close", (status) => res({ status, stdout, stderr, out: stdout + stderr, ms: Date.now() - t0 })));
    return { child, done, exited: () => child.exitCode !== null || child.signalCode !== null };
  }
  function sleeper() {
    return spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
  }
  function holdLock(dir, pid) {
    mkdirSync(dirname(gateLockPath(dir)), { recursive: true });
    writeFileSync(gateLockPath(dir), JSON.stringify({ pid, session: "holder", at: Date.now() }));
  }
  const holderRecord = (dir) => ({
    version: 1,
    tree: computeTree(dir),
    node: process.version,
    at: new Date().toISOString(),
    by: "holder",
    commands: [{ name: "test", command: "node t.mjs", exit: 0, durationMs: 5 }],
    totals: { "node t.mjs": parseTotals("Tests  3 passed (3)\n") },
  });

  it("T1: waits on a held lock, then credits the holder's record without running the commands", async () => {
    const dir = fixture();
    const holder = sleeper();
    try {
      holdLock(dir, holder.pid);
      const v = startVerify(dir);
      await sleep(800);
      expect(v.exited(), "verify.mjs must wait while a live holder has gate.lock").toBe(false);
      expect(runs(dir)).toBe(0);
      writeRecord(dir, holderRecord(dir));
      rmSync(gateLockPath(dir));
      const r = await v.done;
      expect(r.status, r.out).toBe(0);
      expect(r.out).toContain("credited verified-tree record");
      expect(r.out).toContain("by holder");
      expect(lastLine(r.stdout)).toBe("gate: test 0 (3 passed)");
      expect(runs(dir), "the commands must not run when the holder's record credits").toBe(0);
      expect(existsSync(gateLockPath(dir)), "a credited run leaves no lock behind").toBe(false);
    } finally {
      holder.kill();
    }
  }, 30000);

  it("T2: a lock still held when the wait bound runs out: runs the commands itself and says it waited", async () => {
    const dir = fixture();
    const holder = sleeper();
    try {
      holdLock(dir, holder.pid);
      const r = await startVerify(dir, ["--timeout-ms", "1500"]).done;
      expect(r.status, r.out).toBe(0);
      expect(r.ms, "must have waited for the bound before running").toBeGreaterThanOrEqual(1000);
      expect(runs(dir)).toBe(1);
      expect(r.out).toContain("gate.lock");
      expect(r.out).toMatch(/still held/i);
      expect(r.out).not.toContain("credited verified-tree record");
      expect(lastLine(r.stdout)).toBe("gate: test 0 (3 passed)");
    } finally {
      holder.kill();
    }
  }, 30000);

  it("T3: a stale lock (dead pid) is taken over without waiting and the commands run", async () => {
    const dir = fixture();
    const dead = spawnSync(process.execPath, ["-e", ""], { stdio: "ignore" });
    holdLock(dir, dead.pid);
    const r = await startVerify(dir, ["--timeout-ms", "8000"]).done;
    expect(r.status, r.out).toBe(0);
    expect(r.ms, "a dead holder must not make verify wait out the bound").toBeLessThan(5000);
    expect(runs(dir)).toBe(1);
    expect(existsSync(gateLockPath(dir))).toBe(false);
  }, 30000);

  it("T4: holds the lock under its own pid while the commands run and releases it after, green or red", async () => {
    const dir = fixture();
    const v = startVerify(dir);
    const pid = v.child.pid;
    const r = await v.done;
    expect(r.status, r.out).toBe(0);
    const seen = JSON.parse(readFileSync(join(dir, ".doug/.state/lock.seen"), "utf8"));
    expect(seen.pid, "gate.lock names the verify.mjs process while its commands run").toBe(pid);
    expect(existsSync(gateLockPath(dir)), "no lock left after a green run").toBe(false);

    write(dir, "t.mjs", T_RED);
    const red = await startVerify(dir).done;
    expect(red.status, red.out).toBe(1);
    expect(red.out).toContain("RED-MARK");
    expect(existsSync(gateLockPath(dir)), "no lock left after a red run").toBe(false);
  }, 30000);

  // Card gate-lock-shared: gate.lock is shared by every worktree of the repo, so verify.mjs run inside worktree
  // B waits on a lock a live holder took through worktree A, then runs and holds that same shared lock.
  it("W1: verify.mjs in worktree B waits on a lock held via worktree A, then runs and holds the shared lock under its own pid", async () => {
    const dirA = fixture();
    const dirB = join(mkdtempSync(join(tmpdir(), "doug-vt-wt-")), "wtb");
    git(dirA, ["worktree", "add", "-q", "-b", "wtb", dirB]);
    expect(gateLockPath(dirB), "both worktrees must resolve one lock path").toBe(gateLockPath(dirA));
    const holder = sleeper();
    try {
      holdLock(dirA, holder.pid);
      const v = startVerify(dirB);
      await sleep(800);
      expect(v.exited(), "verify.mjs in worktree B must wait while a live holder has the lock via worktree A").toBe(false);
      expect(runs(dirB)).toBe(0);
      rmSync(gateLockPath(dirA));
      const r = await v.done;
      expect(r.status, r.out).toBe(0);
      expect(runs(dirB), "having waited, worktree B's verify runs its commands").toBe(1);
      const seen = JSON.parse(readFileSync(join(dirB, ".doug/.state/lock.seen"), "utf8"));
      expect(seen.pid, "the shared lock names the verify.mjs process while its commands run").toBe(v.child.pid);
      expect(existsSync(gateLockPath(dirA)), "no lock left behind").toBe(false);
    } finally {
      holder.kill();
    }
  }, 30000);

  // Card verify-lock-wait-bound D1/D3/D4: the wait bound is the per-command timeout x the command count (the
  // Stop gate's bound), the "still held" line goes to stderr, and the tree is recomputed after the wait.
  it("D1 unit: normalizedTimeoutMs and lockWaitBoundMs live in gate-lock.mjs", () => {
    expect(typeof gateLock.normalizedTimeoutMs).toBe("function");
    expect(typeof gateLock.lockWaitBoundMs).toBe("function");
    const n = (t) => gateLock.normalizedTimeoutMs({ stopGate: { timeoutMs: t } });
    expect(n(300)).toBe(300);
    expect(n(2.5)).toBe(2);
    expect(n(0.5)).toBe(1);
    for (const bad of ["abc", 0, -5, NaN, Infinity, null, undefined]) expect(n(bad)).toBeNull();
    expect(gateLock.lockWaitBoundMs(300, 2)).toBe(600);
    expect(gateLock.lockWaitBoundMs(300, 1)).toBe(300);
    expect(gateLock.lockWaitBoundMs(300, 0)).toBe(300);
    expect(gateLock.lockWaitBoundMs(600000, 2)).toBe(1200000);
  });

  it("D1: with two commands the lock wait bound is timeoutMs x 2, so a holder releasing after 1.5 x timeoutMs is waited out and credited", async () => {
    const dir = fixture();
    const holder = sleeper();
    try {
      holdLock(dir, holder.pid);
      const v = startVerify(dir, ["--timeout-ms", "800", "--command", "node t.mjs", "--command", "node t.mjs second"]);
      await sleep(1200);
      expect(v.exited(), "a flat 800 ms bound would have given up and run the commands by now").toBe(false);
      expect(runs(dir)).toBe(0);
      writeRecord(dir, { ...holderRecord(dir), commands: [
        { name: "node t.mjs", command: "node t.mjs", exit: 0, durationMs: 5 },
        { name: "node t.mjs second", command: "node t.mjs second", exit: 0, durationMs: 5 },
      ], totals: { "node t.mjs": parseTotals("Tests  3 passed (3)\n"), "node t.mjs second": parseTotals("Tests  3 passed (3)\n") } });
      rmSync(gateLockPath(dir));
      const r = await v.done;
      expect(r.status, r.out).toBe(0);
      expect(r.out).toContain("credited verified-tree record");
      expect(r.out).not.toMatch(/still held/i);
      expect(runs(dir), "the holder's record credits; no command runs").toBe(0);
    } finally {
      holder.kill();
    }
  }, 30000);

  it("D3: under --json the 'still held' line goes to stderr with the bound actually used; stdout's last line is the JSON result", async () => {
    const dir = fixture();
    const holder = sleeper();
    try {
      holdLock(dir, holder.pid);
      const r = await startVerify(dir, ["--json", "--timeout-ms", "400"]).done;
      expect(r.status, r.out).toBe(0);
      expect(r.stderr).toMatch(/gate\.lock still held by pid \d+ after 400 ms/);
      expect(r.stdout).not.toMatch(/still held/i);
      const j = JSON.parse(lastLine(r.stdout));
      expect(j.ok).toBe(true);
      expect(runs(dir)).toBe(1);
    } finally {
      holder.kill();
    }
  }, 30000);

  it("D3: without --json the 'still held' line is also on stderr, not stdout", async () => {
    const dir = fixture();
    const holder = sleeper();
    try {
      holdLock(dir, holder.pid);
      const r = await startVerify(dir, ["--timeout-ms", "400"]).done;
      expect(r.status, r.out).toBe(0);
      expect(r.stderr).toMatch(/still held/i);
      expect(r.stdout).not.toMatch(/still held/i);
    } finally {
      holder.kill();
    }
  }, 30000);

  it("D4: the tree is recomputed after the wait: a record for the tree as it changed during the wait is credited", async () => {
    const dir = fixture();
    const holder = sleeper();
    try {
      holdLock(dir, holder.pid);
      const v = startVerify(dir);
      await sleep(800);
      expect(v.exited()).toBe(false);
      write(dir, "changed-while-waiting.txt", "new\n");
      writeRecord(dir, holderRecord(dir));
      rmSync(gateLockPath(dir));
      const r = await v.done;
      expect(r.status, r.out).toBe(0);
      expect(r.out).toContain("credited verified-tree record");
      expect(runs(dir), "a stale pre-wait tree would not match the record and would run the commands").toBe(0);
    } finally {
      holder.kill();
    }
  }, 30000);

  // Card parallel-card-queens B4: the time spent waiting on gate.lock is reported (json lockWaitMs, a text line).
  it("V01: a live lock released after ~800 ms gives lockWaitMs >= 300 under --json and the 'waited' line in text mode", async () => {
    for (const json of [true, false]) {
      const dir = fixture();
      const holder = sleeper();
      try {
        holdLock(dir, holder.pid);
        const v = startVerify(dir, json ? ["--json"] : []);
        await sleep(800); // node start-up eats part of the sleep before the wait begins
        rmSync(gateLockPath(dir));
        const r = await v.done;
        expect(r.status, r.out).toBe(0);
        expect(runs(dir), "no holder record, so the commands run").toBe(1);
        if (json) {
          const j = JSON.parse(lastLine(r.stdout));
          expect(j.lockWaitMs, "json result carries the wait").toBeGreaterThanOrEqual(300);
          expect(j.lockWaitMs).toBeLessThan(20000);
        } else {
          const m = r.out.match(/\[doug\] verify: waited (\d+) ms on gate\.lock/);
          expect(m, r.out).not.toBeNull();
          expect(Number(m[1])).toBeGreaterThanOrEqual(300);
        }
      } finally {
        holder.kill();
      }
    }
  }, 30000);

  it("V02: no lock held: lockWaitMs is 0 under --json and text mode prints no 'waited' line", async () => {
    const dirJ = fixture();
    const rj = await startVerify(dirJ, ["--json"]).done;
    expect(rj.status, rj.out).toBe(0);
    expect(JSON.parse(lastLine(rj.stdout)).lockWaitMs).toBe(0);
    const dirT = fixture();
    const rt = await startVerify(dirT).done;
    expect(rt.status, rt.out).toBe(0);
    expect(rt.out).not.toMatch(/waited \d+ ms on gate\.lock/);
  }, 30000);
});
