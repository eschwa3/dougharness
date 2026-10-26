// Card rehearsal-harder-tier (G3): `rehearse.mjs --tier hard` end to end. Estimates and refusals never spawn claude
// (a fake claude on DOUG_REHEARSE_CLAUDE writes a marker if it is ever run), the dry run prepares all six ts-rentals
// fixtures and prints the tier estimate, a prepared hard-auto and hard-parallel board carries six Ready cards with
// their deps and an overlapping pair, and the docs section names the tier. Each case runs the CLI under its own TMPDIR
// and checks nothing of the runner's was left there. Prepared-fixture cases skip when the CLI is unbuilt, like
// tests/rehearse-fixture-orders.test.mjs. Never spawns the real claude and never passes --spend.
import { describe, it, expect, afterAll, vi } from "vitest";
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { CLI, ROOT, HARD_SCENARIOS, HARD_BASES, estimateLines, totalEstimate, scenarioTotal, capFor, stagesFor, HARD_ESTIMATES } from "../scripts/rehearse-lib.mjs";
import { cli, trackedTempDir, makeFakeClaude, run, git, inLib, tempDirs } from "./rehearse-fixtures.mjs";

afterAll(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});
vi.setConfig({ testTimeout: 600_000, hookTimeout: 600_000 });

const built = existsSync(CLI);
const IS_SNAPSHOT = !existsSync(join(ROOT, "scripts/export-public.mjs"));
const TASKS = JSON.parse(readFileSync(join(ROOT, "evals/tasks/ts-rentals.json"), "utf8"));

// One CLI run under its own TMPDIR with a marker fake claude; resolves the result plus whether claude was spawned and
// what the runner left in that TMPDIR.
async function runCli(args) {
  const tmp = trackedTempDir("hard-tier-tmp-");
  const marker = join(trackedTempDir("hard-tier-marker-"), "spawned");
  const claudeBin = makeFakeClaude("", { marker });
  const r = await run(process.execPath, [cli, ...args], { env: { ...process.env, TMPDIR: tmp, DOUG_REHEARSE_CLAUDE: claudeBin } });
  return { ...r, spawned: existsSync(marker), leftovers: readdirSync(tmp).filter((f) => f.startsWith("doug-rehearse-")) };
}

describe("rehearse.mjs --tier hard", () => {
  it("T01 each base with --tier hard prints the hard scenario's estimate and 'Add --spend', exits 2, spawns nothing", async () => {
    for (const base of HARD_BASES) {
      const r = await runCli([base, "--tier", "hard"]);
      expect(r.status, base).toBe(2);
      expect(r.stdout, base).toContain(`hard-${base}`);
      expect(r.stdout, base).toContain(`$${scenarioTotal(`hard-${base}`, "ts-rentals").toFixed(2)}`);
      expect(r.stdout, base).toContain("measured on ts-rentals");
      expect(r.stdout, base).not.toContain("unmeasured on ts-rentals");
      expect(r.stdout, base).toContain("Add --spend");
      expect(r.spawned, base).toBe(false);
      expect(r.leftovers, base).toEqual([]);
    }
  });

  it("T02 without --tier, `all` and the bare command print the cheap scenarios and total, never a hard- name", async () => {
    const lines = estimateLines();
    const total = `$${totalEstimate().toFixed(2)}`;
    for (const args of [[], ["all"]]) {
      const r = await runCli(args);
      expect(r.status, args.join(" ")).toBe(2);
      for (const l of lines) expect(r.stdout, args.join(" ")).toContain(l);
      expect(r.stdout).toContain(total);
      expect(r.stdout).not.toContain("hard-");
      expect(r.spawned).toBe(false);
      expect(r.leftovers).toEqual([]);
    }
  });

  it("T03 an unknown tier, a base with no hard version and a bare hard name are refused", async () => {
    const bogus = await runCli(["hand", "--tier", "bogus"]);
    expect(bogus.status).toBe(2);
    expect(bogus.stderr).toContain('unknown tier "bogus"; tiers are hard');
    const swarm = await runCli(["swarm", "--tier", "hard"]);
    expect(swarm.status).toBe(2);
    for (const b of HARD_BASES) expect(swarm.stderr).toContain(b);
    const prefixed = await runCli(["hard-auto", "--tier", "hard"]);
    expect(prefixed.status).toBe(2);
    for (const b of HARD_BASES) expect(prefixed.stderr).toContain(b);
    const bare = await runCli(["hard-auto"]);
    expect(bare.status).toBe(2);
    expect(bare.stderr).toContain("unknown scenario");
    for (const r of [bogus, swarm, prefixed, bare]) {
      expect(r.spawned).toBe(false);
      expect(r.leftovers).toEqual([]);
    }
  });

  it("T04 the hard tier runs on ts-rentals only; without the tier ts-rentals is an unknown fixture", async () => {
    for (const fixture of ["ts-orders", "ts-basic"]) {
      const r = await runCli(["auto", "--tier", "hard", "--fixture", fixture]);
      expect(r.status, fixture).toBe(2);
      expect(r.stderr, fixture).toContain("runs on ts-rentals only");
      expect(r.spawned).toBe(false);
      expect(r.leftovers).toEqual([]);
    }
    const plain = await runCli(["hand", "--fixture", "ts-rentals"]);
    expect(plain.status).toBe(2);
    expect(plain.stderr).toContain("unknown fixture");
    expect(plain.stderr).toContain("ts-basic");
    expect(plain.stderr).toContain("ts-orders");
    expect(plain.spawned).toBe(false);
    expect(plain.leftovers).toEqual([]);
  });

  it("T05 --tier hard --dry-run with --spend exits 2 and spawns nothing", async () => {
    const r = await runCli(["all", "--tier", "hard", "--dry-run", "--spend"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("--dry-run");
    expect(r.spawned).toBe(false);
    expect(r.leftovers).toEqual([]);
  });

  it("T06 --tier hard with no scenario prints the six rows and the total, and the usage line names [--tier hard]", async () => {
    const r = await runCli(["--tier", "hard"]);
    expect(r.status).toBe(2);
    for (const s of HARD_SCENARIOS) expect(r.stdout).toContain(s);
    expect(r.stdout).toContain(`$${totalEstimate({ tier: "hard" }).toFixed(2)}`);
    expect(r.stdout).toContain("$42.44");
    expect(r.stdout).not.toContain("$51.00");
    expect(r.stdout).toMatch(/usage:.*\[--tier hard\]/);
    expect(r.spawned).toBe(false);
    expect(r.leftovers).toEqual([]);
  });

  it.skipIf(!built)("T07 all --tier hard --dry-run prepares six ts-rentals fixtures, prints every stage with its cap and the $42.44 total, and cleans up", async () => {
    const r = await runCli(["all", "--tier", "hard", "--dry-run"]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.match(/^Stages on ts-rentals:$/gm)).toHaveLength(6);
    expect(r.stdout.match(/estimate source: measured on ts-rentals/g)).toHaveLength(6);
    const out = r.stdout.split("\n");
    for (const s of HARD_SCENARIOS) {
      // Search only this scenario's own block: its "Stages on" header up to its closing scenario line (hard-auto and
      // hard-parallel both have a 30-turn gate stage with different caps).
      const end = out.findIndex((l) => l.startsWith(`  scenario ${s}: `));
      expect(end, `${s} scenario line`).toBeGreaterThanOrEqual(0);
      const begin = out.slice(0, end).map((l) => l.startsWith("Stages on")).lastIndexOf(true);
      expect(begin, `${s} block`).toBeGreaterThanOrEqual(0);
      const block = out.slice(begin, end + 1);
      for (const st of await stagesOf(s)) {
        const line = block.find((l) => l.startsWith(`  ${st.name.padEnd(20)} ${st.kind.padEnd(8)}`) && (st.kind !== "session" || l.includes(`turns ${st.maxTurns},`)));
        expect(line, `${s}/${st.name}`).toBeTruthy();
        if (st.kind !== "act") expect(line, `${s}/${st.name}`).toContain(`cap $${st.cap.toFixed(2)}`);
        if (st.kind === "session") expect(line, `${s}/${st.name}`).toContain(`timeout ${st.timeoutMin} min`);
      }
      expect(r.stdout).toContain(`scenario ${s}: $${scenarioTotal(s, "ts-rentals").toFixed(2)} estimated`);
    }
    expect(r.stdout).toMatch(/^Estimated cost: \$42\.44$/m);
    expect(r.stdout).not.toContain("unmeasured");
    expect(r.spawned).toBe(false);
    expect(r.leftovers).toEqual([]);
  });

  describe("prepared hard boards", () => {
    async function prepare(scenario) {
      const fx = await inLib("prepareFixture", { scenario, fixture: "ts-rentals", tempPrefix: "doug-rehearse-test-" });
      tempDirs.push(fx.dir);
      return fx;
    }
    const readJson = (dir, rel) => JSON.parse(readFileSync(join(dir, rel), "utf8"));
    const filesOf = (id) => TASKS.tasks.find((t) => t.id === id).allowedFiles;

    it.skipIf(!built)("T08 hard-auto and hard-parallel boards hold six Ready cards with their deps, an overlapping pair, the right workers.max, the background cards, one commit and a clean tree; nothing names evals/solutions", async () => {
      for (const name of ["hard-auto", "hard-parallel"]) {
        const fx = await prepare(name);
        expect(fx.fixture).toBe("ts-rentals");
        const board = readJson(fx.dir, ".doug/board.json");
        const spec = TASKS.rehearsal.scenarios[name].cards;
        const readyIds = spec.filter((c) => c.column === "ready").map((c) => c.id);
        expect(readyIds, name).toHaveLength(6);
        for (const c of spec) {
          const on = board.cards.find((b) => b.id === c.id);
          expect(on, `${name}/${c.id}`).toBeTruthy();
          expect(on.column, `${name}/${c.id}`).toBe(c.column);
          expect(on.deps ?? [], `${name}/${c.id} deps`).toEqual(c.deps ?? []);
          expect(on.goal, `${name}/${c.id} goal`).toBeTruthy();
        }
        expect(readyIds.some((id) => (spec.find((c) => c.id === id).deps || []).length > 0), `${name}: a dep`).toBe(true);
        const owners = new Map();
        for (const id of readyIds) for (const f of filesOf(id)) owners.set(f, [...(owners.get(f) || []), id]);
        expect([...owners.values()].some((ids) => ids.length > 1), `${name}: two Ready cards share an owned file`).toBe(true);
        const config = readJson(fx.dir, ".doug/config.json");
        if (name === "hard-parallel") expect(config.workers.max, name).toBeGreaterThanOrEqual(2);
        else expect(config.workers?.max, name).toBeUndefined();
        for (const b of TASKS.rehearsal.background) expect(board.cards.map((c) => c.id), `${name}: background ${b.id}`).toContain(b.id);
        expect((await git(fx.dir, "log", "--oneline")).split("\n").filter(Boolean), name).toHaveLength(1);
        expect(await git(fx.dir, "status", "--porcelain"), `${name}: clean tree`).toBe("");
        // R16, prepared half: no board, goal or plan text points a session at the reference solutions.
        expect(JSON.stringify(board), name).not.toContain("evals/solutions");
        for (const c of board.cards) expect(`${c.title} ${c.goal}`, `${name}/${c.id}`).not.toContain("evals/solutions");
        for (const rel of [".doug/config.json", ".doug/plan.json"]) if (existsSync(join(fx.dir, rel))) expect(readFileSync(join(fx.dir, rel), "utf8"), `${name} ${rel}`).not.toContain("evals/solutions");
      }
    });
  });

  it.skipIf(IS_SNAPSHOT)("T09 docs/rehearsals.md has a harder-tier section naming every hard scenario, --tier hard, ts-rentals and $42.44", () => {
    const docs = readFileSync(join(ROOT, "docs/rehearsals.md"), "utf8");
    const start = docs.indexOf("### The harder tier (--tier hard)");
    expect(start).toBeGreaterThan(-1);
    const end = docs.indexOf("\n## 3.", start);
    expect(end).toBeGreaterThan(start);
    const section = docs.slice(start, end);
    for (const s of HARD_SCENARIOS) expect(section, s).toContain(s);
    for (const phrase of ["--tier hard", "ts-rentals", "$42.44", "approval"]) expect(section, phrase).toContain(phrase);
    expect(section).not.toContain("$51.00");
    expect(section).not.toContain("unmeasured on ts-rentals");
    expect(section).not.toContain("scaled from a ts-orders measurement");
    expect(section).toContain("2026-10-25");
    const rowOf = (name) => section.split("\n").filter((l) => l.startsWith(`| ${name} |`)).pop();
    for (const h of HARD_SCENARIOS) {
      const line = rowOf(h);
      expect(line, h).toBeDefined();
      const stages = Object.entries(HARD_ESTIMATES[h].stages).map(([n, usd]) => `${n} $${usd.toFixed(2)} (cap $${capFor(h, n).toFixed(2)})`).join(", ");
      expect(line, h).toContain(stages);
      expect(line, h).toContain(`| $${scenarioTotal(h).toFixed(2)} |`);
    }
    expect(rowOf("all --tier hard")).toContain("$42.44");
  });

  it.skipIf(IS_SNAPSHOT)("T11 the hard-auto row says maintenance-blackout shares availability.ts with fix-back-to-back-booking and has no dep; hard-parallel keeps the dep", () => {
    const docs = readFileSync(join(ROOT, "docs/rehearsals.md"), "utf8");
    const start = docs.indexOf("### The harder tier (--tier hard)");
    expect(start).toBeGreaterThan(-1);
    const section = docs.slice(start, docs.indexOf("\n## 3.", start));
    const row = (name) => section.split("\n").find((l) => l.startsWith(`| ${name} |`));
    const entry = (line, card) => {
      const at = line.indexOf(`\`${card}\``);
      expect(at, `${card} in row`).toBeGreaterThan(-1);
      const rest = line.slice(at);
      const semi = rest.indexOf(";");
      const bar = rest.indexOf(" |");
      return rest.slice(0, semi > -1 && semi < bar ? semi : bar);
    };
    const auto = row("hard-auto");
    expect(auto).toBeDefined();
    const blackout = entry(auto, "maintenance-blackout");
    expect(blackout).not.toContain("dep on");
    expect(blackout).toContain("no dep");
    expect(blackout.includes("src/calendar/availability.ts") || blackout.includes("same file")).toBe(true);
    const parallel = row("hard-parallel");
    expect(parallel).toBeDefined();
    expect(entry(parallel, "maintenance-blackout")).toContain("(dep on `fix-back-to-back-booking`");
  });

  it.skipIf(IS_SNAPSHOT)("T12 docs/rehearsals.md section 3 shows the hard-tier dry-run and live command lines", () => {
    const docs = readFileSync(join(ROOT, "docs/rehearsals.md"), "utf8");
    const start = docs.indexOf("## 3. How to run and retest");
    expect(start).toBeGreaterThan(-1);
    const end = docs.indexOf("\n## 4.", start);
    expect(end).toBeGreaterThan(start);
    const section = docs.slice(start, end);
    for (const phrase of ["--tier hard --dry-run", "--tier hard --card <id> --spend", "all --tier hard --card <id> --spend", "approval of the $42.44"]) expect(section, phrase).toContain(phrase);
  });

  it("T10 a bare --tier with no value is refused like an unknown tier: exit 2, 'tiers are hard', nothing spawned or left", async () => {
    for (const args of [["all", "--tier"], ["hand", "--tier"], ["--tier"]]) {
      const r = await runCli(args);
      expect(r.status, args.join(" ")).toBe(2);
      expect(r.stderr, args.join(" ")).toContain("tiers are hard");
      expect(r.spawned, args.join(" ")).toBe(false);
      expect(r.leftovers, args.join(" ")).toEqual([]);
    }
  });
});

// The stage shape T07 expects, read in the lib's own process (stage objects hold functions and cannot be cloned out of a
// worker, so this imports the library directly: a plain import spawns nothing).
async function stagesOf(scenario) {
  return stagesFor(scenario).map((st) => ({
    name: st.name,
    kind: st.kind,
    maxTurns: st.maxTurns,
    timeoutMin: st.timeoutMs ? Math.round(st.timeoutMs / 60000) : null,
    cap: st.kind === "act" ? 0 : capFor(scenario, st.name, "ts-rentals"),
  }));
}
