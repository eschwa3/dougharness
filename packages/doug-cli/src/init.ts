import { createInterface } from "node:readline";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { detect } from "./detect/index.js";
import { buildProposal, summarize } from "./generate/proposal.js";
import { renderDiff } from "./diff.js";
import { applyChanges } from "./apply.js";
import { readMemoryConfig } from "@dougharness/flow/lib/embeddings.mjs";
import { runMemorySetup } from "./memory-setup.js";
import type { MemorySetupDeps } from "./memory-setup.js";
import { collectChecks, renderDoctor } from "./doctor.js";
import type { CheckStatus, DoctorDeps, DoctorReport } from "./doctor.js";

export interface InitOptions {
  dir: string;
  yes: boolean;
  dryRun: boolean;
  color: boolean;
  quiet: boolean;
  /** Skip the vendored hook file diffs in the printout (they are long and identical every time). */
  showHookFiles: boolean;
  /** Defaults to process.stdin.isTTY. */
  isTTY?: boolean;
  /** Defaults to the readline prompt. */
  ask?: (question: string) => Promise<string>;
  /** Passed through to runMemorySetup. */
  memorySetup?: MemorySetupDeps;
  /** Output sink; defaults to stdout with a newline. quiet still suppresses everything. */
  out?: (s: string) => void;
  /** Passed to collectChecks for the closing setup check. */
  doctor?: DoctorDeps;
}

export const READY_LINE = "You're ready. Next:";
export const NOT_READY_LINE = "Not ready: fix the fail lines above, then run doug doctor.";

const GREENFIELD_LINE =
  'Empty repository: run /doug-start in Claude Code to start from an idea, or follow the manual recipe (https://github.com/eschwa3/dougharness/blob/main/docs/getting-started.md#starting-from-an-empty-repository, "Starting from an empty repository") and then re-run doug init so the gates detect its commands.';

async function defaultAsk(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer: string = await new Promise((res) => rl.question(question, res));
  rl.close();
  return answer;
}

// Offer semantic memory setup. Never throws and never changes init's exit code.
async function memoryStep(opts: InitOptions, dir: string, isTTY: boolean, ask: (q: string) => Promise<string>, log: (s: string) => void): Promise<void> {
  try {
    if (readMemoryConfig(dir).embeddings) {
      log("Semantic memory is configured.");
      return;
    }
    if (opts.yes || !isTTY) {
      log("Semantic memory is off (keyword-only). Enable it any time: doug memory setup");
      return;
    }
    const answer = (await ask("Set up semantic memory now? [Y/n] ")).trim().toLowerCase();
    if (answer !== "" && !answer.startsWith("y")) return;
    const deps: MemorySetupDeps = { ...opts.memorySetup, ask, isTTY };
    if (!deps.out && opts.quiet) deps.out = () => {};
    else if (!deps.out && opts.out) deps.out = opts.out;
    await runMemorySetup({ dir }, deps);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`Semantic memory step failed (${msg}). Run: doug memory setup`);
  }
}

function cliVersion(): string {
  try {
    return String((createRequire(import.meta.url)("../package.json") as { version: string }).version);
  } catch {
    return "unknown";
  }
}

// Closing setup check plus the ready screen. Never throws and never changes init's exit code.
async function finalScreen(opts: InitOptions, dir: string, isEmpty: boolean, wroteClaudeMd: boolean, log: (s: string) => void): Promise<void> {
  log("");
  log("Setup check (the same checks as doug doctor):");
  let ready = false;
  try {
    const initFix = resolve(opts.dir) === resolve(opts.doctor?.cwd ?? process.cwd()) ? "doug init" : `doug init ${/\s/.test(opts.dir) ? JSON.stringify(opts.dir) : opts.dir}`;
    const checks = await collectChecks(dir, opts.doctor ?? {}, initFix);
    const counts: Record<CheckStatus, number> = { ok: 0, warn: 0, fail: 0, skip: 0 };
    for (const c of checks) counts[c.status]++;
    const report: DoctorReport = { dir, cliVersion: opts.doctor?.cliVersion ?? cliVersion(), ok: counts.fail === 0, counts, checks };
    log(renderDoctor(report).replace(/\n$/, ""));
    ready = report.ok;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`Setup check failed (${msg}). Run: doug doctor`);
  }
  log("");
  log(ready ? READY_LINE : NOT_READY_LINE);
  log("  1. claude                  open Claude Code here; the hooks are active immediately");
  log(
    isEmpty
      ? '  2. write the walking-skeleton card first (docs/getting-started.md, "Starting from an empty repository"), then re-run doug init'
      : "  2. doug board add <id> --title <t> --goal <g>   queue a card; doug board serve --open shows the board",
  );
  log("  3. /doug-next             in Claude Code: plan, approve, and run the next Ready card");
  if (wroteClaudeMd) log("  Edit CLAUDE.md's Gotchas section by hand; keep it short.");
  log("  Re-check any time: doug doctor");
}

export async function runInit(opts: InitOptions): Promise<number> {
  const dir = resolve(opts.dir);
  const log = (s: string) => {
    if (opts.quiet) return;
    if (opts.out) opts.out(s);
    else process.stdout.write(s + "\n");
  };
  const isTTY = opts.isTTY ?? !!process.stdin.isTTY;
  const ask = opts.ask ?? defaultAsk;
  const detection = detect(dir);
  const proposal = buildProposal(detection);

  log("");
  log("Detected:");
  log(summarize(proposal));
  if (proposal.notes.length) {
    log("");
    log("Notes:");
    for (const n of proposal.notes) log(`  - ${n}`);
  }
  log("");
  if (detection.repo.isEmpty) {
    log(GREENFIELD_LINE);
    log("");
  }

  if (proposal.changes.length === 0) {
    log("Nothing to change. The project is already configured.");
    if (!opts.dryRun) {
      await memoryStep(opts, dir, isTTY, ask, log);
      if (!opts.quiet) await finalScreen(opts, dir, detection.repo.isEmpty, false, log);
    }
    return 0;
  }

  const hookFiles = proposal.changes.filter((c) => c.path.startsWith(".doug/hooks/"));
  const visible = proposal.changes.filter((c) => opts.showHookFiles || !c.path.startsWith(".doug/hooks/"));
  log(`Proposed changes (${proposal.changes.length} files):`);
  log("");
  for (const c of visible) {
    log(renderDiff(c, { color: opts.color }));
    log("");
  }
  if (!opts.showHookFiles && hookFiles.length) {
    log(`create  .doug/hooks/  (${hookFiles.length} vendored hook files from @dougharness/gates; pass --show-hooks to print them)`);
    log("");
  }

  if (opts.dryRun) {
    log("Dry run. Nothing written.");
    return 0;
  }
  if (!opts.yes) {
    if (!isTTY) {
      log("Not a TTY and --yes not given. Nothing written.");
      return 2;
    }
    const ok = /^y(es)?$/i.test((await ask("Apply these changes? [y/N] ")).trim());
    if (!ok) {
      log("Aborted. Nothing written.");
      return 1;
    }
  }
  const written = applyChanges(dir, proposal.changes);
  log(`Wrote ${written.length} files.`);
  await memoryStep(opts, dir, isTTY, ask, log);
  if (!opts.quiet) await finalScreen(opts, dir, detection.repo.isEmpty, written.includes("CLAUDE.md"), log);
  return 0;
}
