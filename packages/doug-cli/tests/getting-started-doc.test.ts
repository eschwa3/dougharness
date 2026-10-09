import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { collectChecks } from "../src/doctor.js";
import { READY_LINE } from "../src/init.js";
import { BOARD_USAGE } from "../src/board.js";

const doc = readFileSync(new URL("../../../docs/getting-started.md", import.meta.url), "utf8");

describe("docs/getting-started.md matches the init flow", () => {
  it("names every doctor check id in backticks", async () => {
    const tmp = (n: string) => mkdtempSync(join(tmpdir(), `gs-${n}-`));
    const checks = await collectChecks(tmp("dir"), { env: { PATH: tmp("path") }, claudeConfigDir: tmp("cfg") });
    expect(checks.length).toBeGreaterThan(0);
    for (const c of checks) expect(doc, c.id).toContain("`" + c.id + "`");
  });

  it("quotes the final screen and the next-step commands", () => {
    expect(doc).toContain(READY_LINE);
    for (const s of ["doug doctor", "doug memory setup", "doug board serve"]) expect(doc).toContain(s);
  });
});

describe("docs/getting-started.md Start a new project section", () => {
  const section = (text: string): string => {
    const start = text.indexOf("## Start a new project\n");
    if (start < 0) return "";
    const rest = text.slice(start + 1);
    const next = rest.search(/\n## /);
    return next < 0 ? rest : rest.slice(0, next);
  };
  const help = readFileSync(new URL("../src/bin.ts", import.meta.url), "utf8");
  const usageLines = [...help.matchAll(/^ {2}(doug [^\n]*)$/gm)].map((m) => m[1]);
  const realCommands = new Set(usageLines.map((l) => l.split(/\s+/).slice(1, 3).filter((w) => /^[a-z]+$/.test(w)).join(" ")));
  const realTop = new Set(usageLines.map((l) => l.split(/\s+/)[1]));
  const addUsage = BOARD_USAGE.split("\n").find((l) => l.trim().startsWith("doug board add")) ?? "";

  it("exists and comes before Starting from an empty repository", () => {
    const a = doc.indexOf("## Start a new project\n");
    const b = doc.indexOf("## Starting from an empty repository\n");
    expect(a).toBeGreaterThan(-1);
    expect(b).toBeGreaterThan(a);
    expect(section(doc)).toContain("`/doug-next`");
  });

  it("names only real doug subcommands", () => {
    const cmds = [...section(doc).matchAll(/(?:^|[`\s$])doug ([a-z]+)(?: ([a-z]+))?/gm)];
    expect(cmds.length).toBeGreaterThan(0);
    for (const m of cmds) {
      expect(realTop, m[0]).toContain(m[1]);
      const two = `${m[1]} ${m[2]}`;
      const hasSubs = [...realCommands].some((c) => c.startsWith(m[1] + " "));
      if (hasSubs) expect(realCommands, m[0]).toContain(two);
    }
  });

  it("uses only flags doug board add takes", () => {
    const flags = [...section(doc).matchAll(/doug board add[^\n`]*|`(--[a-z]+)`/g)].flatMap((m) =>
      [...m[0].matchAll(/--[a-z]+/g)].map((f) => f[0]),
    );
    expect(flags).toContain("--title");
    expect(flags).toContain("--goal");
    for (const f of flags) expect(addUsage, f).toMatch(new RegExp(`${f}(?![a-z-])`));
  });

  it("files the board add card into Ready", () => {
    const cmd = section(doc).split("\n").find((l) => l.includes("doug board add")) ?? "";
    expect(cmd).toContain("--column ready");
  });
});
