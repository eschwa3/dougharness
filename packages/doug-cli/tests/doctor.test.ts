// Card doug-doctor: `doug doctor [dir] [--json]`, a read-only install health check. Written from the card goal and
// the design before src/doctor.ts exists. Fixtures live under tmpdir(); a project is one real `doug init --yes`
// run (so the hooks, settings and config are exactly what init writes), copied per test.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runInit } from "../src/init.js";
import { gatesSourceDir } from "../src/generate/settings.js";
import { DOCTOR_USAGE, runDoctor } from "../src/doctor.js";
// @ts-expect-error plain ESM, no shipped types
import * as realMemoryLib from "../../../plugins/doug-flow/lib/memory.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = resolve(here, "..");
const REPO_ROOT = resolve(here, "../../..");
const fixture = join(here, "fixtures", "ts-pnpm");
const CLI_VERSION = "1.0.2";
const IDS = ["node", "config", "hooks-vendored", "hooks-registered", "codex", "memory", "plugin-versions"];

type Check = { id: string; status: "ok" | "warn" | "fail" | "skip"; detail: string; fix: string | null };
type Report = {
  dir: string;
  cliVersion: string;
  ok: boolean;
  counts: { ok: number; warn: number; fail: number; skip: number };
  checks: Check[];
};
type Deps = Record<string, unknown>;

const scratch: string[] = [];
function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), `doug-doctor-${prefix}-`));
  scratch.push(d);
  return d;
}

let template: string;
let codexBin: string; // a PATH dir holding an executable `codex`
let emptyBin: string; // a PATH dir holding nothing

beforeAll(async () => {
  template = tmp("template");
  cpSync(fixture, template, { recursive: true });
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("GIT_") || k === "CLAUDE_PROJECT_DIR") {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  }
  try {
    const status = await runInit({ dir: template, yes: true, dryRun: false, color: false, quiet: true, showHookFiles: false });
    if (status !== 0) throw new Error(`doug init failed in the template: ${status}`);
  } finally {
    for (const [k, v] of Object.entries(saved)) if (v !== undefined) process.env[k] = v;
  }
  codexBin = tmp("codexbin");
  writeFileSync(join(codexBin, "codex"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(codexBin, "codex"), 0o755);
  emptyBin = tmp("emptybin");
}, 120_000);

afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});

function project(): string {
  const dir = tmp("proj");
  cpSync(template, dir, { recursive: true });
  return dir;
}

// A config dir that holds no installed_plugins.json, so plugin-versions reports skip and the real ~/.claude is
// never read.
function noPluginsDir(): string {
  return tmp("claudecfg");
}

function baseDeps(extra: Deps = {}): Deps {
  return {
    nodeVersion: "22.16.0",
    cliVersion: CLI_VERSION,
    env: { PATH: codexBin },
    claudeConfigDir: noPluginsDir(),
    ...extra,
  };
}

async function run(dir: string, args: string[] = [], deps: Deps = baseDeps()) {
  let stdout = "";
  let stderr = "";
  const code = await runDoctor([dir, ...args], { stdout: (s: string) => void (stdout += s), stderr: (s: string) => void (stderr += s) }, deps as never);
  return { code, stdout, stderr };
}

async function report(dir: string, deps: Deps = baseDeps()): Promise<{ code: number; report: Report }> {
  const r = await run(dir, ["--json"], deps);
  return { code: r.code, report: JSON.parse(r.stdout) as Report };
}

async function check(dir: string, id: string, deps: Deps = baseDeps()): Promise<Check & { code: number }> {
  const { code, report: rep } = await report(dir, deps);
  const c = rep.checks.find((x) => x.id === id);
  if (!c) throw new Error(`no check ${id} in ${JSON.stringify(rep.checks.map((x) => x.id))}`);
  return { ...c, code };
}

function files(dir: string, sub: string): string[] {
  return readdirSync(join(dir, sub), { withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => e.name)
    .sort();
}

function flipByte(file: string) {
  const buf = readFileSync(file);
  const i = Math.floor(buf.length / 2);
  buf[i] = buf[i] ^ 0x01; // same length, one byte different
  writeFileSync(file, buf);
}

function snapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      const rel = relative(root, p);
      const st = statSync(p);
      if (e.isDirectory()) {
        out[rel + "/"] = `dir ${st.mtimeMs}`;
        walk(p);
      } else {
        out[rel] = `${st.size} ${st.mtimeMs} ${createHash("sha256").update(readFileSync(p)).digest("hex")}`;
      }
    }
  };
  walk(root);
  return out;
}

function seedMemory(dir: string) {
  const m = realMemoryLib.openMemory(dir);
  m.close();
}

function writePlugins(cfgDir: string, body: unknown) {
  mkdirSync(join(cfgDir, "plugins"), { recursive: true });
  writeFileSync(join(cfgDir, "plugins", "installed_plugins.json"), typeof body === "string" ? body : JSON.stringify(body));
}

function rec(version: string, extra: Record<string, unknown> = {}) {
  return { scope: "user", installPath: `/x/${version}`, version, ...extra };
}

describe("doug doctor: arguments, usage, exit codes", () => {
  it("--help prints DOCTOR_USAGE on stdout and exits 0", async () => {
    let stdout = "";
    const code = await runDoctor(["--help"], { stdout: (s: string) => void (stdout += s), stderr: () => {} }, baseDeps() as never);
    expect(code).toBe(0);
    expect(DOCTOR_USAGE).toContain("doug doctor");
    expect(stdout).toBe(DOCTOR_USAGE);
  });

  it("an unknown flag exits 2 with the usage and writes no report", async () => {
    const dir = project();
    const r = await run(dir, ["--bogus"]);
    expect(r.code).toBe(2);
    expect(r.stdout + r.stderr).toContain(DOCTOR_USAGE.trim().split("\n")[0]);
    expect(r.stdout).not.toMatch(/^doctor: /m);
  });

  it("a healthy project exits 0 even with warn and skip rows (codex absent, no store, no plugin record)", async () => {
    const dir = project();
    const { code, report: rep } = await report(dir, baseDeps({ env: { PATH: emptyBin } }));
    expect(rep.checks.find((c) => c.id === "codex")!.status).toBe("warn");
    expect(rep.checks.find((c) => c.id === "memory")!.status).toBe("skip");
    expect(rep.checks.find((c) => c.id === "plugin-versions")!.status).toBe("skip");
    expect(rep.counts.fail).toBe(0);
    expect(rep.ok).toBe(true);
    expect(code).toBe(0);
    const text = await run(dir, [], baseDeps({ env: { PATH: emptyBin } }));
    expect(text.code).toBe(0);
  });

  it("any fail exits 1 in both text and --json mode", async () => {
    const dir = project();
    writeFileSync(join(dir, ".doug", "config.json"), "{");
    expect((await run(dir)).code).toBe(1);
    expect((await run(dir, ["--json"])).code).toBe(1);
  });
});

describe("doug doctor: output shapes", () => {
  it("--json: dir, cliVersion, ok, counts, and exactly the seven checks in order with fix non-null only for warn/fail", async () => {
    const dir = project();
    writeFileSync(join(dir, ".doug", "config.json"), "{"); // a fail
    const { report: rep } = await report(dir, baseDeps({ env: { PATH: emptyBin } })); // plus a warn and skips
    expect(Object.keys(rep).sort()).toEqual(["checks", "cliVersion", "counts", "dir", "ok"]);
    expect(rep.dir).toBe(resolve(dir));
    expect(rep.cliVersion).toBe(CLI_VERSION);
    expect(rep.checks.map((c) => c.id)).toEqual(IDS);
    expect(Object.keys(rep.counts).sort()).toEqual(["fail", "ok", "skip", "warn"]);
    const tally = { ok: 0, warn: 0, fail: 0, skip: 0 };
    for (const c of rep.checks) {
      expect(Object.keys(c).sort()).toEqual(["detail", "fix", "id", "status"]);
      expect(["ok", "warn", "fail", "skip"]).toContain(c.status);
      expect(typeof c.detail).toBe("string");
      if (c.status === "warn" || c.status === "fail") {
        expect(typeof c.fix, `${c.id} (${c.status}) must carry a fix`).toBe("string");
        expect(c.fix!.length).toBeGreaterThan(0);
      } else {
        expect(c.fix, `${c.id} (${c.status}) must have fix null`).toBeNull();
      }
      tally[c.status]++;
    }
    expect(rep.counts).toEqual(tally);
    expect(tally.fail).toBeGreaterThan(0);
    expect(tally.warn).toBeGreaterThan(0);
    expect(tally.skip).toBeGreaterThan(0);
    expect(tally.ok).toBeGreaterThan(0);
    expect(rep.ok).toBe(false);
  });

  it("--json ok is true exactly when counts.fail is 0", async () => {
    const { report: rep } = await report(project());
    expect(rep.counts.fail).toBe(0);
    expect(rep.ok).toBe(true);
  });

  it("text: one line per check, a fix line under warn/fail rows, and the doctor: summary last", async () => {
    const dir = project();
    writeFileSync(join(dir, ".doug", "config.json"), "{");
    const r = await run(dir, [], baseDeps({ env: { PATH: emptyBin } }));
    const lines = r.stdout.trimEnd().split("\n");
    const rows = lines.filter((l) => /^(ok|warn|fail|skip)\s/.test(l));
    expect(rows.map((l) => l.split(/\s+/)[1])).toEqual(IDS);
    expect(lines.some((l) => /^ {6}fix: .+/.test(l))).toBe(true);
    const fixLines = lines.filter((l) => /^ {6}fix: /.test(l));
    const nonOk = rows.filter((l) => /^(warn|fail)\s/.test(l));
    expect(fixLines).toHaveLength(nonOk.length);
    expect(lines[lines.length - 1]).toMatch(/^doctor: \d+ ok, \d+ warn, \d+ fail, \d+ skip$/);
  });
});

describe("doug doctor: missing .doug", () => {
  it("config and hooks-vendored fail with fix: doug init, memory skips, exit 1, and nothing is created", async () => {
    const dir = tmp("empty");
    const before = snapshot(dir);
    const { code, report: rep } = await report(dir);
    const by = Object.fromEntries(rep.checks.map((c) => [c.id, c]));
    expect(code).toBe(1);
    expect(by.config.status).toBe("fail");
    expect(by.config.fix).toMatch(/^doug init( |$)/);
    expect(by["hooks-vendored"].status).toBe("fail");
    expect(by["hooks-vendored"].fix).toMatch(/^doug init( |$)/);
    expect(by.memory.status).toBe("skip");
    const text = await run(dir);
    expect(text.stdout).toMatch(/^ {6}fix: doug init/m);
    expect(existsSync(join(dir, ".doug"))).toBe(false);
    expect(snapshot(dir)).toEqual(before);
  });
});

describe("check node", () => {
  it("ok at 22.16.0 with a working FTS5", async () => {
    const c = await check(project(), "node", baseDeps({ nodeVersion: "22.16.0" }));
    expect(c.status).toBe("ok");
    expect(c.fix).toBeNull();
  });

  it("fail at 22.15.1 with fix: install Node >=22.16", async () => {
    const c = await check(project(), "node", baseDeps({ nodeVersion: "22.15.1" }));
    expect(c.status).toBe("fail");
    expect(c.fix).toContain("install Node >=22.16");
    expect(c.code).toBe(1);
  });

  it("fail when the FTS5 probe reports not ok", async () => {
    const lib = { ...realMemoryLib, probeSqliteFts5: () => ({ ok: false, reason: "no such module: fts5" }) };
    const c = await check(project(), "node", baseDeps({ loadMemoryLib: async () => lib }));
    expect(c.status).toBe("fail");
    expect(c.fix).toContain("install Node >=22.16");
  });

  it("fail when the memory library cannot be loaded, and memory then skips", async () => {
    const dir = project();
    seedMemory(dir);
    const deps = baseDeps({
      loadMemoryLib: async () => {
        throw new Error("boom: cannot load node:sqlite");
      },
    });
    const { report: rep } = await report(dir, deps);
    expect(rep.checks.find((c) => c.id === "node")!.status).toBe("fail");
    expect(rep.checks.find((c) => c.id === "memory")!.status).toBe("skip");
  });
});

describe("check isolation", () => {
  it("memory skips when node failed only because the FTS5 probe returned {ok:false}", async () => {
    const dir = project();
    seedMemory(dir);
    const lib = { ...realMemoryLib, probeSqliteFts5: () => ({ ok: false, reason: "no such module: fts5" }) };
    const { report: rep } = await report(dir, baseDeps({ loadMemoryLib: async () => lib }));
    expect(rep.checks.find((c) => c.id === "node")!.status).toBe("fail");
    const mem = rep.checks.find((c) => c.id === "memory")!;
    expect(mem.status).toBe("skip");
    expect(mem.fix).toBeNull();
  });

  it.skipIf(typeof process.getuid === "function" && process.getuid() === 0)(
    "a check that throws (unreadable gates scripts/sub) reports fail with the message and a fix, the other six still report, exit 1, --json parses",
    async () => {
      const gates = tmp("gates");
      const real = gatesSourceDir();
      cpSync(join(real, "scripts"), join(gates, "scripts"), { recursive: true });
      cpSync(join(real, "lib"), join(gates, "lib"), { recursive: true });
      const sub = join(gates, "scripts", "sub");
      mkdirSync(sub);
      writeFileSync(join(sub, "x.mjs"), "// x\n");
      chmodSync(sub, 0o000);
      try {
        const deps = baseDeps({ gatesDir: () => gates });
        const r = await run(project(), ["--json"], deps);
        expect(r.code).toBe(1);
        const rep = JSON.parse(r.stdout) as Report;
        expect(rep.checks.map((c) => c.id)).toEqual(IDS);
        const hv = rep.checks.find((c) => c.id === "hooks-vendored")!;
        expect(hv.status).toBe("fail");
        expect(hv.detail).toMatch(/EACCES|permission denied/i);
        expect(typeof hv.fix).toBe("string");
        expect(hv.fix!.length).toBeGreaterThan(0);
        for (const c of rep.checks.filter((x) => x.id !== "hooks-vendored")) {
          expect(["ok", "warn", "fail", "skip"]).toContain(c.status);
        }
        expect(rep.checks.find((c) => c.id === "config")!.status).toBe("ok");
        expect(rep.checks.find((c) => c.id === "codex")!.status).toBe("ok");
        expect(rep.counts.fail).toBe(1);
        expect(rep.ok).toBe(false);
        const text = await run(project(), [], deps);
        expect(text.code).toBe(1);
        expect(text.stdout).toMatch(/^doctor: \d+ ok, \d+ warn, 1 fail, \d+ skip$/m);
      } finally {
        chmodSync(sub, 0o755);
      }
    },
  );
});

describe("check config", () => {
  it("ok on a JSON object", async () => {
    const dir = project();
    writeFileSync(join(dir, ".doug", "config.json"), "{}");
    expect((await check(dir, "config")).status).toBe("ok");
  });

  it("ok on the config doug init wrote", async () => {
    expect((await check(project(), "config")).status).toBe("ok");
  });

  it("fail on invalid JSON with fix: doug init", async () => {
    const dir = project();
    writeFileSync(join(dir, ".doug", "config.json"), "{");
    const c = await check(dir, "config");
    expect(c.status).toBe("fail");
    expect(c.fix).toMatch(/^doug init( |$)/);
  });

  it("fail on JSON that is not an object", async () => {
    const dir = project();
    writeFileSync(join(dir, ".doug", "config.json"), "[]");
    const c = await check(dir, "config");
    expect(c.status).toBe("fail");
    expect(c.fix).toMatch(/^doug init( |$)/);
  });

  it("fail when config.json is missing", async () => {
    const dir = project();
    rmSync(join(dir, ".doug", "config.json"));
    expect((await check(dir, "config")).status).toBe("fail");
  });
});

describe("check hooks-vendored", () => {
  it("ok on the exact copy doug init made", async () => {
    const c = await check(project(), "hooks-vendored");
    expect(c.status).toBe("ok");
    expect(c.fix).toBeNull();
  });

  it("ok when .doug/hooks carries extra files the gates package does not have", async () => {
    const dir = project();
    writeFileSync(join(dir, ".doug", "hooks", "scripts", "my-extra.mjs"), "// mine\n");
    expect((await check(dir, "hooks-vendored")).status).toBe("ok");
  });

  it("fail on a same-length byte flip in a scripts file, naming it, with fix: doug init", async () => {
    const dir = project();
    const name = files(gatesSourceDir(), "scripts")[0];
    flipByte(join(dir, ".doug", "hooks", "scripts", name));
    const c = await check(dir, "hooks-vendored");
    expect(c.status).toBe("fail");
    expect(c.detail).toContain(name);
    expect(c.fix).toMatch(/^doug init( |$)/);
  });

  it("fail on a same-length byte flip in a lib file", async () => {
    const dir = project();
    const name = files(gatesSourceDir(), "lib")[0];
    flipByte(join(dir, ".doug", "hooks", "lib", name));
    const c = await check(dir, "hooks-vendored");
    expect(c.status).toBe("fail");
    expect(c.detail).toContain(name);
  });

  it("fail when a vendored script is deleted", async () => {
    const dir = project();
    const name = files(gatesSourceDir(), "scripts")[0];
    rmSync(join(dir, ".doug", "hooks", "scripts", name));
    const c = await check(dir, "hooks-vendored");
    expect(c.status).toBe("fail");
    expect(c.detail).toContain(name);
  });

  it("fail when .doug/hooks is missing", async () => {
    const dir = project();
    rmSync(join(dir, ".doug", "hooks"), { recursive: true });
    const c = await check(dir, "hooks-vendored");
    expect(c.status).toBe("fail");
    expect(c.fix).toMatch(/^doug init( |$)/);
  });

  it("fail with the install fix when the gates directory cannot be resolved", async () => {
    const c = await check(
      project(),
      "hooks-vendored",
      baseDeps({
        gatesDir: () => {
          throw new Error("Cannot find module '@dougharness/gates/package.json'");
        },
      }),
    );
    expect(c.status).toBe("fail");
    expect(c.fix).toContain("npm install -g @dougharness/cli");
  });
});

describe("check hooks-registered", () => {
  const LOCAL = ".claude/settings.local.json";
  const localHook = (command: string) => JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command }] }] } });

  it("ok on the settings doug init wrote, with every referenced script present", async () => {
    const c = await check(project(), "hooks-registered");
    expect(c.status).toBe("ok");
    expect(c.fix).toBeNull();
  });

  it("fail when a referenced vendored script was deleted, with fix: doug init", async () => {
    const dir = project();
    rmSync(join(dir, ".doug", "hooks", "scripts", "protect-paths.mjs"));
    const c = await check(dir, "hooks-registered");
    expect(c.status).toBe("fail");
    expect(c.fix).toMatch(/^doug init( |$)/);
  });

  it("fail when .claude/settings.json is missing", async () => {
    const dir = project();
    rmSync(join(dir, ".claude", "settings.json"));
    const c = await check(dir, "hooks-registered");
    expect(c.status).toBe("fail");
    expect(c.fix).toMatch(/^doug init( |$)/);
  });

  it("fail on invalid JSON, telling the user to repair it first", async () => {
    const dir = project();
    writeFileSync(join(dir, ".claude", "settings.json"), "{");
    const c = await check(dir, "hooks-registered");
    expect(c.status).toBe("fail");
    expect(c.fix).toContain("repair the JSON in .claude/settings.json");
  });

  it("fail when settings.local.json is invalid JSON, naming that file", async () => {
    const dir = project();
    writeFileSync(join(dir, LOCAL), "{");
    const c = await check(dir, "hooks-registered");
    expect(c.status).toBe("fail");
    expect(c.fix).toContain("repair the JSON in .claude/settings.local.json");
  });

  it("fail when no hook command names .doug/hooks/scripts/", async () => {
    const dir = project();
    writeFileSync(join(dir, ".claude", "settings.json"), JSON.stringify({ hooks: {} }));
    const c = await check(dir, "hooks-registered");
    expect(c.status).toBe("fail");
    expect(c.fix).toMatch(/^doug init( |$)/);
  });

  it("fail on a broken reference found only in settings.local.json, outside .doug/hooks, with a remove-or-repair fix", async () => {
    const dir = project();
    writeFileSync(join(dir, LOCAL), localHook('node "$CLAUDE_PROJECT_DIR/tools/missing-hook.mjs"'));
    const c = await check(dir, "hooks-registered");
    expect(c.status).toBe("fail");
    expect(c.fix).toContain("remove or repair that hook in");
    expect(c.fix).toContain("settings.local.json");
  });

  it("checks the ${CLAUDE_PROJECT_DIR} brace form: ok when the file exists, fail when it does not", async () => {
    const dir = project();
    mkdirSync(join(dir, "tools"), { recursive: true });
    writeFileSync(join(dir, "tools", "present.mjs"), "// hook\n");
    writeFileSync(join(dir, LOCAL), localHook('node "${CLAUDE_PROJECT_DIR}/tools/present.mjs"'));
    expect((await check(dir, "hooks-registered")).status).toBe("ok");
    writeFileSync(join(dir, LOCAL), localHook('node "${CLAUDE_PROJECT_DIR}/tools/absent.mjs"'));
    expect((await check(dir, "hooks-registered")).status).toBe("fail");
  });

  it("does not check a command that never names CLAUDE_PROJECT_DIR", async () => {
    const dir = project();
    writeFileSync(join(dir, LOCAL), localHook("node /no/such/place/anywhere.mjs"));
    expect((await check(dir, "hooks-registered")).status).toBe("ok");
  });
});

describe("check codex", () => {
  it("ok when an executable codex is on deps.env.PATH", async () => {
    const c = await check(project(), "codex", baseDeps({ env: { PATH: codexBin } }));
    expect(c.status).toBe("ok");
    expect(c.fix).toBeNull();
  });

  it("warn (never fail) with the install fix when no codex is on deps.env.PATH, even if the process PATH has one", async () => {
    const c = await check(project(), "codex", baseDeps({ env: { PATH: emptyBin } }));
    expect(c.status).toBe("warn");
    expect(c.fix).toContain("install the Codex CLI (docs/getting-started.md)");
    expect(c.code).toBe(0);
  });

  it("reads the injected PATH, not process.env.PATH", async () => {
    const saved = process.env.PATH;
    process.env.PATH = codexBin;
    try {
      const c = await check(project(), "codex", baseDeps({ env: { PATH: emptyBin } }));
      expect(c.status).toBe("warn");
    } finally {
      process.env.PATH = saved;
    }
  });

  it("warn when codex is on PATH but not executable", async () => {
    const dir = tmp("noexec");
    writeFileSync(join(dir, "codex"), "#!/bin/sh\n");
    chmodSync(join(dir, "codex"), 0o644);
    const c = await check(project(), "codex", baseDeps({ env: { PATH: dir } }));
    expect(c.status).toBe("warn");
  });
});

describe("check memory", () => {
  it("ok on a seeded current-version store", async () => {
    const dir = project();
    seedMemory(dir);
    const c = await check(dir, "memory");
    expect(c.status).toBe("ok");
    expect(c.fix).toBeNull();
  });

  it("skip, not fail, when no store exists yet", async () => {
    const c = await check(project(), "memory");
    expect(c.status).toBe("skip");
    expect(c.fix).toBeNull();
  });

  it("fail on a file that is not a database, with the mv fix", async () => {
    const dir = project();
    const file = join(dir, ".doug", ".state", "memory", "memory.db");
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, "this is not a sqlite database, just text padding ".repeat(40));
    const c = await check(dir, "memory");
    expect(c.status).toBe("fail");
    expect(c.fix).toContain("mv .doug/.state/memory/memory.db .doug/.state/memory/memory.db.broken");
    expect(c.code).toBe(1);
  });

  it("fail on a store newer than this CLI understands (user_version 9), with the install fix", async () => {
    const dir = project();
    seedMemory(dir);
    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
    const file = join(dir, ".doug", ".state", "memory", "memory.db");
    const db = new DatabaseSync(file);
    db.exec("PRAGMA user_version = 9");
    db.close();
    const c = await check(dir, "memory");
    expect(c.status).toBe("fail");
    expect(c.fix).toContain("npm install -g @dougharness/cli");
  });
});

describe("check plugin-versions", () => {
  const FLOW = "doug-flow@dougharness";
  const GATES = "doug-gates@dougharness";
  const withPlugins = (body: unknown) => {
    const cfg = tmp("claudecfg");
    writePlugins(cfg, body);
    return baseDeps({ claudeConfigDir: cfg });
  };

  it("ok when both installed versions equal the CLI version", async () => {
    const c = await check(project(), "plugin-versions", withPlugins({ version: 2, plugins: { [FLOW]: [rec("1.0.2")], [GATES]: [rec("1.0.2")] } }));
    expect(c.status).toBe("ok");
    expect(c.fix).toBeNull();
  });

  it("warn with a claude plugin update fix when doug-flow is older than the CLI", async () => {
    const c = await check(project(), "plugin-versions", withPlugins({ version: 2, plugins: { [FLOW]: [rec("1.0.1")], [GATES]: [rec("1.0.2")] } }));
    expect(c.status).toBe("warn");
    expect(c.fix).toContain(`claude plugin update ${FLOW}`);
    expect(c.code).toBe(0);
  });

  it("warn with an npm install fix naming the plugin version when doug-gates is newer than the CLI", async () => {
    const c = await check(project(), "plugin-versions", withPlugins({ version: 2, plugins: { [FLOW]: [rec("1.0.2")], [GATES]: [rec("1.0.3")] } }));
    expect(c.status).toBe("warn");
    expect(c.fix).toContain("npm install -g @dougharness/cli@1.0.3");
  });

  it("skips when installed_plugins.json is missing", async () => {
    const c = await check(project(), "plugin-versions", baseDeps({ claudeConfigDir: tmp("claudecfg") }));
    expect(c.status).toBe("skip");
    expect(c.fix).toBeNull();
  });

  it("skips (never fails) on unparsable JSON", async () => {
    const c = await check(project(), "plugin-versions", withPlugins("{ not json"));
    expect(c.status).toBe("skip");
    expect(c.code).toBe(0);
  });

  it("skips on a top-level version other than 2", async () => {
    const c = await check(project(), "plugin-versions", withPlugins({ version: 3, plugins: { [FLOW]: [rec("1.0.2")], [GATES]: [rec("1.0.2")] } }));
    expect(c.status).toBe("skip");
  });

  it("skips when either plugin record is missing", async () => {
    const c = await check(project(), "plugin-versions", withPlugins({ version: 2, plugins: { [FLOW]: [rec("1.0.2")] } }));
    expect(c.status).toBe("skip");
  });

  it("prefers the record whose projectPath equals the checked dir over the user-scope record", async () => {
    const dir = project();
    const stale = withPlugins({
      version: 2,
      plugins: {
        [FLOW]: [rec("1.0.2"), rec("1.0.1", { scope: "project", projectPath: dir })],
        [GATES]: [rec("1.0.2")],
      },
    });
    expect((await check(dir, "plugin-versions", stale)).status).toBe("warn");
    const fresh = withPlugins({
      version: 2,
      plugins: {
        [FLOW]: [rec("1.0.1"), rec("1.0.2", { scope: "project", projectPath: dir })],
        [GATES]: [rec("1.0.2")],
      },
    });
    expect((await check(dir, "plugin-versions", fresh)).status).toBe("ok");
  });

  it("honors env.CLAUDE_CONFIG_DIR when no claudeConfigDir is injected", async () => {
    const cfg = tmp("claudecfg");
    writePlugins(cfg, { version: 2, plugins: { [FLOW]: [rec("1.0.1")], [GATES]: [rec("1.0.2")] } });
    const deps = baseDeps({ env: { PATH: codexBin, CLAUDE_CONFIG_DIR: cfg } });
    delete deps.claudeConfigDir;
    expect((await check(project(), "plugin-versions", deps)).status).toBe("warn");
  });
});

describe("doug doctor never writes", () => {
  it("leaves every path's size, mtime and sha256 unchanged in text and --json mode, on a full project with a seeded store", async () => {
    const dir = project();
    seedMemory(dir);
    const before = snapshot(dir);
    await run(dir);
    expect(snapshot(dir)).toEqual(before);
    await run(dir, ["--json"]);
    expect(snapshot(dir)).toEqual(before);
  });

  it("leaves a project with a broken store and broken hooks untouched", async () => {
    const dir = project();
    const file = join(dir, ".doug", ".state", "memory", "memory.db");
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, "garbage ".repeat(100));
    flipByte(join(dir, ".doug", "hooks", "scripts", files(gatesSourceDir(), "scripts")[0]));
    const before = snapshot(dir);
    await run(dir);
    await run(dir, ["--json"]);
    expect(snapshot(dir)).toEqual(before);
  });
});

describe("doug doctor through the real bin and the docs", () => {
  it("bin.ts dispatches `doctor <dir> --json`: parseable report, exit 1 on a directory with no .doug", () => {
    const dir = tmp("binempty");
    const r = spawnSync(process.execPath, ["--import", "tsx", "src/bin.ts", "doctor", dir, "--json"], {
      cwd: PACKAGE_DIR,
      env: { ...process.env, PATH: process.env.PATH },
      encoding: "utf8",
    });
    expect(r.status).toBe(1);
    const rep = JSON.parse(r.stdout) as Report;
    expect(rep.ok).toBe(false);
    expect(rep.checks.map((c) => c.id)).toEqual(IDS);
    expect(rep.checks.find((c) => c.id === "config")!.fix).toMatch(/^doug init/);
    expect(existsSync(join(dir, ".doug"))).toBe(false);
  }, 60_000);

  it("docs/onboarding.md names the command and lists it as never writing", () => {
    const doc = readFileSync(join(REPO_ROOT, "docs", "onboarding.md"), "utf8");
    expect(doc).toContain("doug doctor");
    expect(doc).toMatch(/Never writes anything[^\n]*`doug doctor`/);
  });
});
