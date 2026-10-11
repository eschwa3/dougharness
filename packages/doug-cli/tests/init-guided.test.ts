// Card init-guided-flow: doug init ends with the doctor checks and the ready screen.
import { describe, it, expect, afterEach } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, cpSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { runInit, READY_LINE, NOT_READY_LINE } from "../src/init.js";
import type { InitOptions } from "../src/init.js";
import { collectChecks } from "../src/doctor.js";
import type { DoctorDeps } from "../src/doctor.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, "fixtures", "ts-pnpm");
const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

function doctorDeps(): DoctorDeps {
  return { env: { PATH: tmp("doug-guided-path-") }, claudeConfigDir: tmp("doug-guided-claude-") };
}

async function initClean(opts: InitOptions): Promise<number> {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("GIT_") || k === "CLAUDE_PROJECT_DIR") {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  }
  try {
    return await runInit(opts);
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

function run(dir: string, doctor: DoctorDeps, lines: string[]): Promise<number> {
  return initClean({
    dir,
    yes: true,
    dryRun: false,
    color: false,
    quiet: false,
    showHookFiles: false,
    isTTY: false,
    out: (s) => void lines.push(...s.split("\n")),
    doctor,
  });
}

const ROW = /^(ok|warn|fail|skip)\s+(\S+)\s/;
function rowIds(lines: string[]): string[] {
  return lines.map((l) => ROW.exec(l)?.[2]).filter((x): x is string => !!x);
}
function tail(lines: string[]): string[] {
  return lines.filter((l) => l.trim() !== "");
}

const IDS = ["node", "config", "hooks-vendored", "hooks-registered", "statusline", "subagent-settings", "board", "codex", "adversary", "memory", "embeddings", "plugins", "plugin-versions"];

describe("doug init guided flow", () => {
  it("(a) prints the doctor checks and the ready screen", async () => {
    const dir = tmp("doug-guided-");
    cpSync(fixture, dir, { recursive: true });
    const deps = doctorDeps();
    const lines: string[] = [];
    expect(await run(dir, deps, lines)).toBe(0);
    const ids = rowIds(lines);
    const rows = await collectChecks(dir, deps);
    expect(ids).toEqual(rows.map((c) => c.id));
    expect(ids).toEqual(IDS);
    for (const r of rows) {
      const i = lines.findIndex((l) => ROW.exec(l)?.[2] === r.id);
      if (r.status === "warn" || r.status === "fail") expect(lines[i + 1]).toMatch(/^ {6}fix: \S/);
      if (["config", "hooks-vendored", "hooks-registered", "statusline", "subagent-settings", "board"].includes(r.id)) expect(r.status).toBe("ok");
    }
    const by = (id: string) => rows.find((r) => r.id === id)!;
    expect(by("plugins").fix).toContain("claude plugin marketplace add eschwa3/dougharness");
    expect(by("adversary").fix).toContain("@dougharness/codex");
    expect(by("adversary").detail).toContain("Claude adversary");
    expect(by("embeddings").fix).toContain("doug memory setup");
    const t = tail(lines);
    const n = t.length;
    expect(t[n - 6]).toBe(READY_LINE);
    expect(t[n - 5]).toContain("claude");
    expect(t[n - 4]).toContain("doug board add");
    expect(t[n - 4]).toContain("doug board serve --open");
    expect(t[n - 3]).toContain("/doug-next");
    expect(t[n - 2]).toContain("Edit CLAUDE.md");
    expect(t[n - 1]).toContain("doug doctor");
  });

  it("(b) a second run (nothing to change) prints the same checks", async () => {
    const dir = tmp("doug-guided-");
    cpSync(fixture, dir, { recursive: true });
    const deps = doctorDeps();
    await run(dir, deps, []);
    const lines: string[] = [];
    expect(await run(dir, deps, lines)).toBe(0);
    expect(lines.join("\n")).toContain("Nothing to change");
    expect(rowIds(lines)).toEqual(IDS);
    expect(lines).toContain(READY_LINE);
  });

  it("(c) a throwing check still exits 0 and ends with the re-check line", async () => {
    const dir = tmp("doug-guided-");
    cpSync(fixture, dir, { recursive: true });
    const deps: DoctorDeps = {
      get env(): Record<string, string | undefined> {
        throw new Error("boom");
      },
    };
    const lines: string[] = [];
    expect(await run(dir, deps, lines)).toBe(0);
    expect(lines.join("\n")).toContain("Setup check failed (boom)");
    expect(lines).toContain(NOT_READY_LINE);
    expect(tail(lines).at(-1)).toContain("Re-check any time: doug doctor");
  });

  it("(d) quiet captures no output", async () => {
    const dir = tmp("doug-guided-");
    cpSync(fixture, dir, { recursive: true });
    const lines: string[] = [];
    expect(await initClean({ dir, yes: true, dryRun: false, color: false, quiet: true, showHookFiles: false, isTTY: false, out: (s) => void lines.push(s), doctor: doctorDeps() })).toBe(0);
    expect(lines).toEqual([]);
  });

  it("(e) a real fail row (no throw) ends with NOT_READY_LINE, not READY_LINE, and exits 0", async () => {
    const dir = tmp("doug-guided-");
    cpSync(fixture, dir, { recursive: true });
    // A memory store that cannot be opened: the memory check reports fail without throwing. A garbage file
    // (not a chmod) so it also bites when the suite runs as root.
    mkdirSync(join(dir, ".doug", ".state", "memory"), { recursive: true });
    writeFileSync(join(dir, ".doug", ".state", "memory", "memory.db"), "this is not a sqlite database\n".repeat(64));
    const lines: string[] = [];
    expect(await run(dir, doctorDeps(), lines)).toBe(0);
    const failRows = lines.filter((l) => /^fail\s/.test(l));
    expect(failRows.length).toBeGreaterThan(0);
    expect(lines.join("\n")).not.toContain("Setup check failed");
    expect(lines).toContain(NOT_READY_LINE);
    expect(lines).not.toContain(READY_LINE);
  });

  it("(f) an empty repository's step 2 points at the walking-skeleton card, not the board-add line", async () => {
    const dir = tmp("doug-guided-empty-");
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")));
    expect(spawnSync("git", ["init", "-q"], { cwd: dir, env }).status).toBe(0);
    const lines: string[] = [];
    expect(await run(dir, doctorDeps(), lines)).toBe(0);
    // Copied exactly from init.ts finalScreen, the isEmpty branch of step 2 (line 100).
    const EMPTY_STEP2 = '  2. write the walking-skeleton card first (docs/getting-started.md, "Starting from an empty repository"), then re-run doug init';
    expect(lines).toContain(EMPTY_STEP2);
    // The non-empty step 2, copied exactly from init.ts line 101.
    expect(lines).not.toContain("  2. doug board add <id> --title <t> --goal <g>   queue a card; doug board serve --open shows the board");
  });
});
