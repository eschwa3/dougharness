// Card test-unit-budget: scripts/test-budget.mjs runs test:unit (or --command <cmd>), parses vitest's Duration line,
// and exits 1 over budget. Each test drives it against a fake node script; spawns are async (see rehearse-fixtures.mjs).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(ROOT, "scripts/test-budget.mjs");
let dir;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "test-budget-"));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let n = 0;
// A fake test:unit: prints `lines` (raw JS expression text), optionally writes a marker, exits `code`.
function fake({ out = "", code = 0, marker, kill } = {}) {
  const f = join(dir, `fake-${n++}.mjs`);
  writeFileSync(
    f,
    `${marker ? `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "spawned");` : ""}
process.stdout.write(${JSON.stringify(out)});
${kill ? `process.kill(process.pid, ${JSON.stringify(kill)});` : ""}
process.exit(${code});`,
  );
  return `node ${JSON.stringify(f)}`;
}
const dur = (s) => `   Test Files  3 passed (3)\n   Duration  ${s}s (transform 3.86s, tests 2306.12s)\n`;

function run(args) {
  return new Promise((resolve) => {
    const p = spawn("node", [SCRIPT, ...args], { cwd: ROOT, env: { ...process.env, NO_COLOR: "1" } });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("close", (code) => resolve({ code, out }));
  });
}

describe("scripts/test-budget.mjs", () => {
  it("exits 0 under budget and names the Duration and the budget", async () => {
    const r = await run(["--budget", "200", "--command", fake({ out: dur("150.00") })]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("150");
    expect(r.out).toContain("200");
  });

  it("exits 1 over budget, naming both figures and saying over budget", async () => {
    const r = await run(["--budget", "200", "--command", fake({ out: dur("250.50") })]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("250.5");
    expect(r.out).toContain("200");
    expect(r.out).toMatch(/over budget/i);
  });

  it("defaults the budget to 200 s", async () => {
    expect((await run(["--command", fake({ out: dur("199.00") })])).code).toBe(0);
    expect((await run(["--command", fake({ out: dur("201.00") })])).code).toBe(1);
  });

  it("exits 1 saying the run failed when the command fails, not a budget message", async () => {
    const r = await run(["--budget", "200", "--command", fake({ out: dur("100.00"), code: 1 })]);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/fail/i);
    expect(r.out).not.toMatch(/over budget/i);
  });

  it("exits 2 when no Duration line is found", async () => {
    const r = await run(["--command", fake({ out: "all good\n" })]);
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/no duration/i);
  });

  it("parses an ANSI-coloured Duration line", async () => {
    const out = "\x1b[2m   Duration \x1b[22m 250.00s\x1b[2m (transform 3s)\x1b[22m\n";
    const r = await run(["--budget", "200", "--command", fake({ out })]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("250");
    expect(r.out).toMatch(/over budget/i);
  });

  it.each([["abc"], ["0"]])("rejects --budget %s with exit 2 before spawning", async (bad) => {
    const marker = join(dir, `marker-${bad}`);
    const r = await run(["--budget", bad, "--command", fake({ out: dur("1.00"), marker })]);
    expect(r.code).toBe(2);
    expect(existsSync(marker)).toBe(false);
  });

  it("passes the command's stdout through", async () => {
    const r = await run(["--command", fake({ out: "passthrough-marker-line\n" + dur("10.00"), code: 1 })]);
    expect(r.out).toContain("passthrough-marker-line");
  });

  it("uses the summary line, the last Duration match, not an earlier slow-test line", async () => {
    const out = "   \u2713 parses > Duration 5s parses 400ms\n" + "   Duration  250.00s (transform 1s)\n";
    const r = await run(["--budget", "200", "--command", fake({ out })]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("250");
    expect(r.out).toMatch(/over budget/i);
  });

  it("exits 0 when Duration equals the budget exactly", async () => {
    const r = await run(["--budget", "200", "--command", fake({ out: dur("200.00") })]);
    expect(r.code).toBe(0);
    expect(r.out).not.toMatch(/over budget/i);
  });

  it("exits 1 naming the signal when the command is killed", async () => {
    const r = await run(["--budget", "200", "--command", fake({ out: dur("100.00"), kill: "SIGKILL" })]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("SIGKILL");
  });

  // R3: a compound --command so no shell can exec the node fake (dash execs a lone command, hiding the signal).
  it("R3-a: exits 1 naming SIGKILL, not exit 137, when a compound command's child is killed", async () => {
    const r = await run(["--budget", "200", "--command", `${fake({ out: dur("100.00"), kill: "SIGKILL" })} ; exit $?`]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("SIGKILL");
    expect(r.out).not.toContain("exit 137");
  });

  it("R3-b: SIGTERM to the script reaches the command's node child and the script exits", async () => {
    const ready = join(dir, "r3b-ready");
    const marker = join(dir, "r3b-sigterm");
    const f = join(dir, "r3b-fake.mjs");
    writeFileSync(
      f,
      `import { writeFileSync } from "node:fs";
process.on("SIGTERM", () => { writeFileSync(${JSON.stringify(marker)}, "term"); process.exit(0); });
writeFileSync(${JSON.stringify(ready)}, String(process.pid));
setTimeout(() => {}, 30000);`,
    );
    const p = spawn("node", [SCRIPT, "--command", `node ${JSON.stringify(f)} ; exit $?`], {
      cwd: ROOT,
      env: { ...process.env, NO_COLOR: "1" },
      stdio: ["ignore", "ignore", "ignore"],
    });
    let exited = false;
    p.on("close", () => (exited = true));
    const wait = async (cond, ms) => {
      const end = Date.now() + ms;
      while (Date.now() < end && !cond()) await new Promise((r) => setTimeout(r, 50));
      return cond();
    };
    try {
      expect(await wait(() => existsSync(ready), 10000)).toBe(true);
      p.kill("SIGTERM");
      const done = await wait(() => exited, 5000);
      const gotTerm = existsSync(marker);
      expect({ exited: done, gotTerm }).toEqual({ exited: true, gotTerm: true });
    } finally {
      try {
        process.kill(Number(readFileSync(ready, "utf8")), "SIGKILL");
      } catch {}
      p.kill("SIGKILL");
    }
  }, 30000);
});
