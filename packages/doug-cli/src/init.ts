import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { detect } from "./detect/index.js";
import { buildProposal, summarize } from "./generate/proposal.js";
import { renderDiff } from "./diff.js";
import { applyChanges } from "./apply.js";

export interface InitOptions {
  dir: string;
  yes: boolean;
  dryRun: boolean;
  color: boolean;
  quiet: boolean;
  /** Skip the vendored hook file diffs in the printout (they are long and identical every time). */
  showHookFiles: boolean;
}

async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer: string = await new Promise((res) => rl.question(question, res));
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

export async function runInit(opts: InitOptions): Promise<number> {
  const dir = resolve(opts.dir);
  const log = (s: string) => {
    if (!opts.quiet) process.stdout.write(s + "\n");
  };
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

  if (proposal.changes.length === 0) {
    log("Nothing to change. The project is already configured.");
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
    if (!process.stdin.isTTY) {
      log("Not a TTY and --yes not given. Nothing written.");
      return 2;
    }
    const ok = await confirm("Apply these changes? [y/N] ");
    if (!ok) {
      log("Aborted. Nothing written.");
      return 1;
    }
  }
  const written = applyChanges(dir, proposal.changes);
  log(`Wrote ${written.length} files.`);
  log("");
  log("Next: open Claude Code in this directory. Hooks are active immediately.");
  log("      Edit CLAUDE.md's Gotchas section by hand; keep the file short.");
  return 0;
}
