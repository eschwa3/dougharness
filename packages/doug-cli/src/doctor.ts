// `doug doctor [dir] [--json]`: a read-only install health check. Never writes; reads only.
import { accessSync, constants, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { delimiter, join, relative, resolve } from "node:path";
import { gatesSourceDir } from "./generate/settings.js";

export const DOCTOR_USAGE = `doug doctor [dir] [--json]

Read-only install health check: Node and SQLite FTS5, .doug/config.json, the vendored hooks, the hooks
registered in .claude/settings*.json, codex on PATH, the memory store, and the installed plugin versions.
Each check prints ok, warn, fail, or skip and, when warn or fail, one fix: command.
Exit 1 when any check fails, 0 otherwise, 2 on bad arguments. Never writes.
`;

export type CheckStatus = "ok" | "warn" | "fail" | "skip";
export interface CheckResult {
  id: string;
  status: CheckStatus;
  detail: string;
  fix: string | null;
}
export interface DoctorReport {
  dir: string;
  cliVersion: string;
  ok: boolean;
  counts: Record<CheckStatus, number>;
  checks: CheckResult[];
}
interface MemoryLib {
  probeSqliteFts5(): { ok: boolean; reason: string | null };
  inspectMemory(dir: string): {
    file: string;
    exists: boolean;
    userVersion: number | null;
    maxUserVersion: number;
    quickCheck: string | null;
    error: string | null;
  };
}
export interface DoctorDeps {
  nodeVersion?: string;
  loadMemoryLib?: () => Promise<MemoryLib>;
  gatesDir?: () => string;
  env?: Record<string, string | undefined>;
  claudeConfigDir?: string;
  cliVersion?: string;
  cwd?: string;
}
export interface DoctorIo {
  stdout: (s: string) => void;
  stderr: (s: string) => void;
}

const NODE_FIX = "install Node >=22.16";
const INSTALL_CLI_FIX = "npm install -g @dougharness/cli";
const FLOW_KEY = "doug-flow@dougharness";
const GATES_KEY = "doug-gates@dougharness";
const HOOKS_MARK = ".doug/hooks/scripts/";

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function result(id: string, status: CheckStatus, detail: string, fix: string | null = null): CheckResult {
  return { id, status, detail, fix: status === "warn" || status === "fail" ? fix : null };
}

// A check that throws (for example EACCES while listing a directory) is that check's fail, never a lost report.
// The fix is generic: the check's normal fix would not cure a read error.
function guard(id: string, fn: () => CheckResult): CheckResult {
  try {
    return fn();
  } catch (err) {
    return result(id, "fail", errMsg(err), "fix the error in detail (often a read permission), then re-run doug doctor");
  }
}

function nodeAtLeast(version: string, major: number, minor: number): boolean {
  const m = /^v?(\d+)\.(\d+)/.exec(version);
  if (!m) return false;
  const ma = Number(m[1]);
  const mi = Number(m[2]);
  return ma > major || (ma === major && mi >= minor);
}

function cmpVersion(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  const pb = b.split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

function listFiles(root: string, sub: string): string[] {
  const base = join(root, sub);
  const out: string[] = [];
  if (!existsSync(base)) return out;
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) out.push(relative(root, p));
    }
  };
  walk(base);
  return out.sort();
}

function readJson(file: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(readFileSync(file, "utf8")) };
  } catch (err) {
    return { ok: false, error: errMsg(err) };
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function hookCommands(settings: unknown): string[] {
  const out: string[] = [];
  if (!isObject(settings) || !isObject(settings.hooks)) return out;
  for (const entries of Object.values(settings.hooks)) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (!isObject(entry) || !Array.isArray(entry.hooks)) continue;
      for (const h of entry.hooks) {
        if (isObject(h) && h.type === "command" && typeof h.command === "string") out.push(h.command);
      }
    }
  }
  return out;
}

export async function collectChecks(dir: string, deps: DoctorDeps = {}, initFix = "doug init"): Promise<CheckResult[]> {
  const env = deps.env ?? process.env;
  const nodeVersion = deps.nodeVersion ?? process.versions.node;
  const checks: CheckResult[] = [];

  // 1. node
  let lib: MemoryLib | null = null;
  let nodeCheck: CheckResult;
  if (!nodeAtLeast(nodeVersion, 22, 16)) {
    nodeCheck = result("node", "fail", `Node ${nodeVersion}; needs >=22.16`, NODE_FIX);
  } else {
    try {
      lib = await (deps.loadMemoryLib ?? (() => import("@dougharness/flow/lib/memory.mjs") as Promise<MemoryLib>))();
      const probe = lib.probeSqliteFts5();
      nodeCheck = probe.ok
        ? result("node", "ok", `Node ${nodeVersion} with node:sqlite FTS5`)
        : result("node", "fail", `Node ${nodeVersion}: SQLite FTS5 unavailable${probe.reason ? ` (${probe.reason})` : ""}`, NODE_FIX);
    } catch (err) {
      lib = null;
      nodeCheck = result("node", "fail", `Node ${nodeVersion}: cannot load node:sqlite (${errMsg(err)})`, NODE_FIX);
    }
  }
  checks.push(nodeCheck);

  // 2. config
  const configFile = join(dir, ".doug", "config.json");
  checks.push(
    guard("config", () => {
      if (!existsSync(configFile)) return result("config", "fail", ".doug/config.json is missing", initFix);
      const parsed = readJson(configFile);
      if (!parsed.ok) return result("config", "fail", `.doug/config.json is not valid JSON (${parsed.error})`, initFix);
      if (!isObject(parsed.value)) return result("config", "fail", ".doug/config.json is not a JSON object", initFix);
      return result("config", "ok", ".doug/config.json parses");
    }),
  );

  // 3. hooks-vendored
  checks.push(
    guard("hooks-vendored", () => {
      let gates: string;
      try {
        gates = (deps.gatesDir ?? gatesSourceDir)();
      } catch (err) {
        return result("hooks-vendored", "fail", `cannot locate the installed @dougharness/gates (${errMsg(err)})`, INSTALL_CLI_FIX);
      }
      const hooksDir = join(dir, ".doug", "hooks");
      if (!existsSync(join(hooksDir, "scripts"))) return result("hooks-vendored", "fail", ".doug/hooks/scripts is missing", initFix);
      const bad: string[] = [];
      let total = 0;
      for (const rel of [...listFiles(gates, "scripts"), ...listFiles(gates, "lib")]) {
        total++;
        const mine = join(hooksDir, rel);
        try {
          if (!readFileSync(join(gates, rel)).equals(readFileSync(mine))) bad.push(`${rel} differs`);
        } catch {
          bad.push(`${rel} missing`);
        }
      }
      if (bad.length === 0) return result("hooks-vendored", "ok", `${total} vendored files match @dougharness/gates`);
      const shown = bad.slice(0, 5).join(", ") + (bad.length > 5 ? `, +${bad.length - 5} more` : "");
      return result("hooks-vendored", "fail", shown, initFix);
    }),
  );

  // 4. hooks-registered
  checks.push(
    guard("hooks-registered", () => {
      const files = [".claude/settings.json", ".claude/settings.local.json"];
      const commands: { file: string; command: string }[] = [];
      for (const rel of files) {
        const p = join(dir, rel);
        if (!existsSync(p)) {
          if (rel === files[0]) return result("hooks-registered", "fail", `${rel} is missing`, initFix);
          continue;
        }
        const parsed = readJson(p);
        if (!parsed.ok) return result("hooks-registered", "fail", `${rel} is not valid JSON (${parsed.error})`, `repair the JSON in ${rel}, then run ${initFix}`);
        for (const command of hookCommands(parsed.value)) commands.push({ file: rel, command });
      }
      if (!commands.some((c) => c.command.includes(HOOKS_MARK))) {
        return result("hooks-registered", "fail", "no hook in .claude/settings.json runs .doug/hooks/scripts/", initFix);
      }
      const ref = /\$\{?CLAUDE_PROJECT_DIR\}?\/([^\s"']+)/g;
      const missingHooks: string[] = [];
      const missingOther: { file: string; path: string }[] = [];
      for (const { file, command } of commands) {
        for (const m of command.matchAll(ref)) {
          const p = m[1];
          if (existsSync(join(dir, p))) continue;
          if (p.startsWith(".doug/hooks/")) missingHooks.push(p);
          else missingOther.push({ file, path: p });
        }
      }
      if (missingHooks.length > 0) return result("hooks-registered", "fail", `registered hook files are missing: ${missingHooks.slice(0, 5).join(", ")}`, initFix);
      if (missingOther.length > 0) {
        const first = missingOther[0];
        return result("hooks-registered", "fail", `a hook in ${first.file} points at ${first.path}, which does not exist`, `remove or repair that hook in ${first.file}`);
      }
      return result("hooks-registered", "ok", `${commands.length} hook commands, every referenced file exists`);
    }),
  );

  // 5. codex
  checks.push(
    guard("codex", () => {
      for (const entry of (env.PATH ?? "").split(delimiter)) {
        if (!entry) continue;
        const p = join(entry, "codex");
        try {
          if (!statSync(p).isFile()) continue;
          accessSync(p, constants.X_OK);
          return result("codex", "ok", `codex found at ${p}`);
        } catch {
          // keep looking
        }
      }
      return result("codex", "warn", "codex is not on PATH; the adversary falls back to Claude", "install the Codex CLI (docs/getting-started.md)");
    }),
  );

  // 6. memory
  checks.push(
    guard("memory", () => {
      if (nodeCheck.status === "fail" || !lib) return result("memory", "skip", "skipped: the node check failed");
      const info = lib.inspectMemory(dir);
      if (!info.exists) return result("memory", "skip", "no memory store yet; it is created on first memory use");
      const mv = "mv .doug/.state/memory/memory.db .doug/.state/memory/memory.db.broken";
      if (info.error) return result("memory", "fail", `memory store cannot be read (${info.error})`, mv);
      if (info.userVersion !== null && info.userVersion > info.maxUserVersion) {
        return result("memory", "fail", `memory store is user_version ${info.userVersion}; this CLI understands up to ${info.maxUserVersion}`, INSTALL_CLI_FIX);
      }
      if (info.quickCheck !== "ok") return result("memory", "fail", `memory store quick_check: ${info.quickCheck}`, mv);
      if (info.userVersion === null || info.userVersion < 1) return result("memory", "fail", `memory store has user_version ${info.userVersion}`, mv);
      return result("memory", "ok", `memory store opens (user_version ${info.userVersion})`);
    }),
  );

  // 7. plugin-versions
  checks.push(
    guard("plugin-versions", () => {
      const cliVersion = deps.cliVersion ?? cliPackageVersion();
      const cfgDir = deps.claudeConfigDir ?? env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
      const file = join(cfgDir, "plugins", "installed_plugins.json");
      const skip = (why: string) => result("plugin-versions", "skip", `skipped: ${why}`);
      if (!existsSync(file)) return skip("no installed_plugins.json");
      const parsed = readJson(file);
      if (!parsed.ok || !isObject(parsed.value)) return skip("installed_plugins.json is not readable");
      if (parsed.value.version !== 2 || !isObject(parsed.value.plugins)) return skip("installed_plugins.json has an unexpected format");
      const plugins = parsed.value.plugins;
      const pick = (key: string): string | null => {
        const records = plugins[key];
        if (!Array.isArray(records)) return null;
        const usable = records.filter((r): r is Record<string, unknown> => isObject(r) && typeof r.version === "string");
        const chosen = usable.find((r) => typeof r.projectPath === "string" && resolve(r.projectPath) === dir) ?? usable.find((r) => r.scope === "user");
        return chosen ? (chosen.version as string) : null;
      };
      const flow = pick(FLOW_KEY);
      const gates = pick(GATES_KEY);
      if (flow === null || gates === null) return skip("doug-flow or doug-gates is not in installed_plugins.json");
      const detail = `doug-flow ${flow}, doug-gates ${gates}, CLI ${cliVersion}`;
      for (const [key, version] of [
        [FLOW_KEY, flow],
        [GATES_KEY, gates],
      ] as const) {
        const c = cmpVersion(version, cliVersion);
        if (c < 0) return result("plugin-versions", "warn", detail, `claude plugin update ${key}`);
        if (c > 0) return result("plugin-versions", "warn", detail, `${INSTALL_CLI_FIX}@${version}`);
      }
      return result("plugin-versions", "ok", detail);
    }),
  );

  return checks;
}

function cliPackageVersion(): string {
  try {
    return String((createRequire(import.meta.url)("../package.json") as { version: string }).version);
  } catch {
    return "unknown";
  }
}

export function renderDoctor(report: DoctorReport): string {
  const out: string[] = [];
  for (const c of report.checks) {
    out.push(`${c.status.padEnd(4)}  ${c.id.padEnd(16)}  ${c.detail}`);
    if (c.fix) out.push(`      fix: ${c.fix}`);
  }
  const n = report.counts;
  out.push(`doctor: ${n.ok} ok, ${n.warn} warn, ${n.fail} fail, ${n.skip} skip`);
  return out.join("\n") + "\n";
}

export async function runDoctor(argv: string[], io?: DoctorIo, deps: DoctorDeps = {}): Promise<number> {
  const out: DoctorIo = io || {
    stdout: (s) => void process.stdout.write(s),
    stderr: (s) => void process.stderr.write(s),
  };
  let json = false;
  let help = false;
  const positional: string[] = [];
  for (const a of argv) {
    if (a === "--json") json = true;
    else if (a === "--help") help = true;
    else if (a.startsWith("-")) {
      out.stderr(`doug doctor: unknown option ${a}\n\n${DOCTOR_USAGE}`);
      return 2;
    } else positional.push(a);
  }
  if (help) {
    out.stdout(DOCTOR_USAGE);
    return 0;
  }
  if (positional.length > 1) {
    out.stderr(`doug doctor: expected at most one directory\n\n${DOCTOR_USAGE}`);
    return 2;
  }
  const dir = resolve(positional[0] ?? deps.cwd ?? process.cwd());
  const initFix = positional[0] ? `doug init ${/\s/.test(positional[0]) ? JSON.stringify(positional[0]) : positional[0]}` : "doug init";
  const checks = await collectChecks(dir, deps, initFix);
  const counts: Record<CheckStatus, number> = { ok: 0, warn: 0, fail: 0, skip: 0 };
  for (const c of checks) counts[c.status]++;
  const report: DoctorReport = {
    dir,
    cliVersion: deps.cliVersion ?? cliPackageVersion(),
    ok: counts.fail === 0,
    counts,
    checks,
  };
  out.stdout(json ? JSON.stringify(report, null, 2) + "\n" : renderDoctor(report));
  return counts.fail > 0 ? 1 : 0;
}
