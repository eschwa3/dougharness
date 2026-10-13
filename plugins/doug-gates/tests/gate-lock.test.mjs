// card gate-lock-shared (ADR 0015): gate.lock lives under the git common dir, shared by every worktree of a
// repo, with a fallback to the per-checkout path. Lib-level cases; the Stop gate and verify.mjs waiting across
// worktrees are in hooks-stop-gate-runner.test.mjs (B1w) and verified-tree.test.mjs (W1).
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, realpathSync, chmodSync, readFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, isAbsolute, relative, dirname, basename } from "node:path";
import { gateLockPath, readGateLock, writeGateLock, takeOverGateLock } from "../lib/gate-lock.mjs";

const OLD = ".doug/.state/gate.lock";
const git = (cwd, args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), "doug-gl-"));
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "t@example.com"]);
  git(dir, ["config", "user.name", "t"]);
  writeFileSync(join(dir, "a.txt"), "a");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "base"]);
  return dir;
}
function addWorktree(dir, name) {
  const wt = join(mkdtempSync(join(tmpdir(), "doug-gl-wt-")), name);
  git(dir, ["worktree", "add", "-q", "-b", name, wt]);
  return wt;
}
// realpath of the deepest existing ancestor, plus the not-yet-existing remainder.
function normalize(p) {
  let head = p;
  const rest = [];
  while (!existsSync(head)) {
    rest.unshift(basename(head));
    head = dirname(head);
  }
  return join(realpathSync(head), ...rest);
}

describe("gateLockPath: one path for every worktree of a repo (card gate-lock-shared)", () => {
  it("G1: the main checkout and two linked worktrees resolve the same absolute lock path, under the git common dir", () => {
    const main = makeRepo();
    const a = addWorktree(main, "wta");
    const b = addWorktree(main, "wtb");
    const p = gateLockPath(main);
    expect(gateLockPath(a)).toBe(p);
    expect(gateLockPath(b)).toBe(p);
    expect(isAbsolute(p), "a relative `git rev-parse` answer (.git in the main checkout) must be resolved against dir").toBe(true);
    const common = realpathSync(join(main, ".git"));
    expect(relative(common, normalize(p)).startsWith(".."), `lock path ${p} must sit under the common dir ${common}`).toBe(false);
    for (const wt of [a, b, main]) {
      expect(p, "the lock must not be per checkout").not.toBe(join(wt, OLD));
    }
  });

  it("G1b: a subdirectory of a checkout resolves the same path as its root", () => {
    const main = makeRepo();
    mkdirSync(join(main, "sub/deep"), { recursive: true });
    expect(gateLockPath(join(main, "sub/deep"))).toBe(gateLockPath(main));
  });

  it("G2: a lock written through one worktree is read through the other (same {pid, session, at}), and is exclusive", () => {
    const main = makeRepo();
    const wt = addWorktree(main, "wta");
    writeGateLock(main, "sess-main");
    const seen = readGateLock(wt);
    expect(seen && seen.pid).toBe(process.pid);
    expect(seen.session).toBe("sess-main");
    expect(typeof seen.at).toBe("number");
    expect(() => writeGateLock(wt, "sess-wt"), "a second worktree must not create a lock that exists").toThrow();
    expect(readGateLock(main).session).toBe("sess-main");
  });
});

describe("gateLockPath: fallback to the per-checkout path, never throwing (card gate-lock-shared)", () => {
  const savedPath = process.env.PATH;
  afterEach(() => {
    process.env.PATH = savedPath;
  });

  it("G3: a directory that is not in any git repo keeps the old per-checkout path", () => {
    const dir = mkdtempSync(join(tmpdir(), "doug-gl-nogit-"));
    expect(gateLockPath(dir)).toBe(join(dir, OLD));
  });

  it("G3b: a directory that does not exist falls back to the old path instead of throwing", () => {
    const dir = join(mkdtempSync(join(tmpdir(), "doug-gl-gone-")), "missing");
    expect(() => gateLockPath(dir)).not.toThrow();
    expect(gateLockPath(dir)).toBe(join(dir, OLD));
    expect(readGateLock(dir), "the reader fails open on a missing dir").toBeNull();
  });

  it("G3c: git unavailable (spawn error) inside a real repo falls back to the old path", () => {
    const main = makeRepo();
    process.env.PATH = "";
    expect(() => gateLockPath(main)).not.toThrow();
    expect(gateLockPath(main)).toBe(join(main, OLD));
  });

  it("G4b: an existing <common>/doug directory that is not writable falls back to the old path", () => {
    if (typeof process.getuid === "function" && process.getuid() === 0) return; // root ignores file modes
    const main = makeRepo();
    const lockDir = join(main, ".git", "doug");
    mkdirSync(lockDir);
    chmodSync(lockDir, 0o555);
    try {
      expect(gateLockPath(main)).toBe(join(main, OLD));
    } finally {
      chmodSync(lockDir, 0o755);
    }
  });

  it("G7: repeated calls in one process return the same path even when the common dir turns unwritable between them (memoized)", () => {
    if (typeof process.getuid === "function" && process.getuid() === 0) return; // root ignores file modes
    const main = makeRepo();
    const common = join(main, ".git");
    const lib = new URL("../lib/gate-lock.mjs", import.meta.url).href;
    const script = `import { gateLockPath } from ${JSON.stringify(lib)};
import { chmodSync } from "node:fs";
const a = gateLockPath(${JSON.stringify(main)});
chmodSync(${JSON.stringify(common)}, 0o555);
const b = gateLockPath(${JSON.stringify(main)});
chmodSync(${JSON.stringify(common)}, 0o755);
console.log(JSON.stringify([a, b]));`;
    const [a, b] = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" }));
    expect(a).not.toBe(join(main, OLD));
    expect(b, "the second call must not re-resolve").toBe(a);
  });

  it("G4: a git common dir that is not writable falls back to the old per-checkout path", () => {
    if (typeof process.getuid === "function" && process.getuid() === 0) return; // root ignores file modes
    const main = makeRepo();
    const common = join(main, ".git");
    chmodSync(common, 0o555);
    try {
      expect(gateLockPath(main)).toBe(join(main, OLD));
      expect(() => readGateLock(main)).not.toThrow();
    } finally {
      chmodSync(common, 0o755);
    }
  });
});

describe("writing the lock creates its own parent directory (card gate-lock-shared)", () => {
  it("G5: writeGateLock in a fresh repo creates the lock's parent and the lock reads back", () => {
    const main = makeRepo();
    const p = gateLockPath(main);
    expect(existsSync(dirname(p)), "fresh repo: the lock's parent does not exist yet").toBe(false);
    writeGateLock(main, "s1");
    expect(existsSync(p)).toBe(true);
    expect(JSON.parse(readFileSync(p, "utf8")).session).toBe("s1");
    expect(readGateLock(main).pid).toBe(process.pid);
  });

  it("G5b: takeOverGateLock in a fresh repo creates the lock's parent too", () => {
    const main = makeRepo();
    takeOverGateLock(main, "s2");
    expect(readGateLock(main) && readGateLock(main).session).toBe("s2");
  });

  it("G5c: outside a repo the old .doug/.state directory is still created", () => {
    const dir = mkdtempSync(join(tmpdir(), "doug-gl-nogit-"));
    writeGateLock(dir, "s3");
    expect(existsSync(join(dir, OLD))).toBe(true);
    rmSync(join(dir, OLD));
    takeOverGateLock(dir, "s4");
    expect(readGateLock(dir).session).toBe("s4");
  });

  it("G6: the reader returns null, never throws, for garbage and for a lock with no usable pid", () => {
    const main = makeRepo();
    const p = gateLockPath(main);
    mkdirSync(dirname(p), { recursive: true });
    for (const content of ["", "{not json", "null", JSON.stringify({ pid: 0 }), JSON.stringify({ pid: -1, session: "x" })]) {
      writeFileSync(p, content);
      expect(() => readGateLock(main)).not.toThrow();
      expect(readGateLock(main), `content ${JSON.stringify(content)}`).toBeNull();
    }
  });
});
