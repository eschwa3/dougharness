// plan.mjs land: merge the plan's integration branch into the base branch, only when the plan is done
// and the plan's verify commands pass on that branch right now. Code decides; the workflow report is
// not trusted for this. Refuses, with a reason and no partial state, otherwise.
//
//   1. plan status must be "done" (the user's call after a green run)
//   2. the integration branch must exist and be ahead of the base
//   3. the base branch must be the one checked out here; the user's branch is never switched
//   4. no tracked file outside .doug/ may be modified (git would refuse or half-apply the merge)
//   4b. no commit on the branch since the base carries a Co-Authored-By or Claude-Session line (this repository
//       records attribution nowhere in git; the workflow's prompts say so, and land is where it is enforced)
//   5. plan.install (if any), every plan.verify command, and then every acceptance command must pass
//      in a worktree of the branch
//   6. git merge --no-ff; a conflict is aborted and reported
//   7. the integration worktree is force-removed (it is land's own verify sandbox); then every other
//      worktree under .claude/worktrees whose branch is one of the plan's task branches or is already
//      merged into the base is removed too (kept, named, and never forced when it has local changes);
//      task branches are kept unless opts.deleteBranches (or config land.deleteBranches) asks to delete
//      them with `git branch -d` (never forced); the integration branch is never deleted; plan.landed
//      records the result

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acceptanceEntries, integrationBranchFor, savePlan } from "./plan.mjs";
import { removeFinishedWorktrees } from "./worktrees.mjs";

export const INTEGRATION_WORKTREE = ".claude/worktrees/doug-integration";

function git(dir, args) {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60000 }).trim();
}

function tryGit(dir, args) {
  try {
    return git(dir, args);
  } catch {
    return null;
  }
}

// Like tryGit, but keeps the error (with its stderr) instead of discarding it on failure.
function tryGitCapture(dir, args) {
  try {
    return { ok: true, output: git(dir, args) };
  } catch (err) {
    return { ok: false, error: err };
  }
}

export const TRAILER_RE = /^(Co-Authored-By|Claude-Session):/im;

// Every commit in base..branch whose message carries a Co-Authored-By or Claude-Session line: { sha, subject, trailers }.
export function trailerCommits(dir, base, branch) {
  const log = tryGit(dir, ["log", "--format=%x1e%h%x1f%s%x1f%B", `${base}..${branch}`]);
  if (!log) return [];
  const out = [];
  for (const rec of log.split("\x1e")) {
    if (!rec.trim()) continue;
    const [sha, subject, body] = rec.split("\x1f");
    const trailers = [...new Set((body || "").split("\n").map((l) => (TRAILER_RE.exec(l) || [])[1]).filter(Boolean).map((t) => (t.toLowerCase() === "co-authored-by" ? "Co-Authored-By" : "Claude-Session")))];
    if (trailers.length) out.push({ sha, subject, trailers });
  }
  return out;
}

function tail(text, lines = 30) {
  return String(text || "").trimEnd().split("\n").slice(-lines).join("\n");
}

// NO_COLOR, not FORCE_COLOR: colour libraries (picocolors/tinyrainbow, used by vitest) treat any FORCE_COLOR
// key in the environment as colour enabled, even "0", so a spawned command's acceptance-grep output carried
// ANSI escapes and missed a plain-text pattern (card land-force-color-enables-color). CI is kept when the
// caller already set it, defaulted to "1" otherwise; an inherited FORCE_COLOR is dropped, never passed through.
export function commandEnv(base = process.env) {
  const env = { ...base, CI: base.CI ?? "1", NO_COLOR: "1" };
  delete env.FORCE_COLOR;
  return env;
}

function run(command, cwd, timeoutMs) {
  const started = Date.now();
  const r = spawnSync(command, { cwd, shell: true, encoding: "utf8", timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, env: commandEnv() });
  const timedOut = r.error && r.error.code === "ETIMEDOUT";
  return { command, ok: !timedOut && r.status === 0, status: r.status, timedOut: !!timedOut, durationMs: Date.now() - started, outputTail: tail((r.stdout || "") + "\n" + (r.stderr || "")) };
}

// card verified-tree-record: run plan.verify through the project's vendored verify.mjs (--json), which computes the
// branch worktree's tree, credits a verified-tree record of it, or runs the commands and records the result for
// the MAIN checkout (--record-dir). Returns the entries land records under `verify` (command, ok, status, timedOut,
// durationMs, outputTail, plus credited: "verified-tree" when credited), stopping at the first failure like
// today's loop, or null when the output cannot be read (the caller then runs the loop unchanged).
// verify.mjs may wait timeoutMs x n on a held gate.lock and then run n commands of timeoutMs each.
export function vendoredVerifySpawnTimeoutMs(timeoutMs, n) {
  return 2 * timeoutMs * n + 60000;
}

function verifyViaVendored(script, dir, work, commands, timeoutMs) {
  try {
    const args = [script, "--json", "--by", "land", "--cwd", work, "--record-dir", dir, "--timeout-ms", String(timeoutMs), ...commands.flatMap((c) => ["--command", c])];
    const r = spawnSync(process.execPath, args, { cwd: work, encoding: "utf8", timeout: vendoredVerifySpawnTimeoutMs(timeoutMs, commands.length), maxBuffer: 64 * 1024 * 1024, env: commandEnv() });
    let out = null;
    try {
      out = JSON.parse(String(r.stdout || "").trim().split("\n").pop());
    } catch {
      out = null;
    }
    if (!out || !Array.isArray(out.results) || out.results.length === 0) {
      const why = r.error && r.error.code === "ETIMEDOUT" ? "timed out" : "gave no readable result";
      return { error: `the vendored verify.mjs ${why}; land does not re-run the commands` };
    }
    return out.results.map((x) => ({
      command: x.command,
      ok: x.ok === true,
      status: x.status,
      timedOut: !!x.timedOut,
      durationMs: x.durationMs,
      outputTail: x.outputTail || "",
      ...(out.credited ? { credited: out.credited } : {}),
    }));
  } catch (err) {
    return { error: `the vendored verify.mjs could not run: ${err && err.message}` };
  }
}

// Returns { ok: true, base, branch, mergeCommit, verify } or { ok: false, reason, verify? }. Never throws on a refusal.
export function landPlan(dir, plan, { timeoutMs = 600000, now = () => new Date(), deleteBranches = false } = {}) {
  if (!plan) return { ok: false, reason: "no plan" };
  if (plan.status !== "done") return { ok: false, reason: `plan status is "${plan.status}", not "done"; run plan.mjs done after a green doug-implement run` };
  if (plan.landed) return { ok: false, reason: `plan was already landed as ${plan.landed.mergeCommit} on ${plan.landed.at}` };
  const branch = integrationBranchFor(plan);
  if (tryGit(dir, ["rev-parse", "--verify", "-q", `refs/heads/${branch}`]) === null) return { ok: false, reason: `integration branch ${branch} does not exist; nothing to land` };

  const current = tryGit(dir, ["symbolic-ref", "--short", "-q", "HEAD"]);
  if (!current) return { ok: false, reason: "detached HEAD; check out the base branch first" };
  const base = plan.baseBranch || current;
  if (base !== current) return { ok: false, reason: `base branch is ${base} but ${current} is checked out; check out ${base} first (land never switches your branch)` };

  const baseTip = git(dir, ["rev-parse", base]);
  const branchTip = git(dir, ["rev-parse", branch]);
  if (tryGit(dir, ["merge-base", "--is-ancestor", branch, base]) !== null) return { ok: false, reason: `${branch} is already contained in ${base}; nothing to land` };

  const trailered = trailerCommits(dir, base, branch);
  if (trailered.length) return { ok: false, reason: `commits on ${branch} carry attribution trailers (Co-Authored-By or Claude-Session), which this repository does not record; rewrite them first:\n${trailered.map((c) => `  ${c.sha} ${c.subject} (${c.trailers.join(", ")})`).join("\n")}` };

  // Not through git(): its trim() would eat the leading status column of the first line.
  const dirty = execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
    .split("\n")
    .filter(Boolean)
    .map((l) => l.slice(3).replace(/^"|"$/g, ""))
    .filter((p) => !p.startsWith(".doug/"));
  if (dirty.length) return { ok: false, reason: `tracked files are modified: ${dirty.join(", ")}; commit or stash them first` };

  // Verify on the branch itself, in the integration worktree if the workflow left it, else a temporary one.
  const existing = join(dir, INTEGRATION_WORKTREE);
  const reuse = existsSync(existing) && tryGit(existing, ["symbolic-ref", "--short", "-q", "HEAD"]) === branch;
  let work = reuse ? existing : null;
  let temp = null;
  if (!work) {
    temp = mkdtempSync(join(tmpdir(), "doug-land-"));
    work = join(temp, "wt");
    try {
      git(dir, ["worktree", "add", "--detach", work, branch]);
    } catch (err) {
      rmSync(temp, { recursive: true, force: true });
      return { ok: false, reason: `could not create a worktree for ${branch}: ${tail(err.stderr || err.message, 3)}` };
    }
  }
  const verify = [];
  const acceptance = [];
  try {
    // card verified-tree-record: install always runs through run(). plan.verify goes through the vendored
    // verify.mjs when the project has one (it credits a verified-tree record of the branch's tree and writes one
    // for the main checkout after a green run); otherwise, or when it cannot be read, today's loop runs.
    const failVerify = (r) => {
      const why = r.timedOut ? `timed out after ${timeoutMs} ms` : `exit ${r.status}`;
      return { ok: false, reason: `verify failed on ${branch}: \`${r.command}\` (${why})\n${r.outputTail}`, verify, acceptance: [] };
    };
    if (plan.install) {
      const r = run(plan.install, work, timeoutMs);
      verify.push(r);
      if (!r.ok) return failVerify(r);
    }
    const verifyList = plan.verify || [];
    const vendored = join(dir, ".doug/hooks/scripts/verify.mjs");
    let viaVerify = null;
    if (verifyList.length && existsSync(vendored)) viaVerify = verifyViaVendored(vendored, dir, work, verifyList, timeoutMs);
    if (viaVerify && viaVerify.error) {
      return { ok: false, reason: `verify failed on ${branch}: ${viaVerify.error}`, verify, acceptance: [] };
    }
    if (viaVerify) {
      for (const r of viaVerify) {
        verify.push(r);
        if (!r.ok) return failVerify(r);
      }
    } else {
      for (const command of verifyList) {
        const r = run(command, work, timeoutMs);
        verify.push(r);
        if (!r.ok) return failVerify(r);
      }
    }

    const acceptanceCommands = acceptanceEntries(plan.acceptance).filter((a) => a.command);
    for (const a of acceptanceCommands) {
      // Card flow-suite-dedupe: a command identical to a plan.verify command already ran (green, or land returned above); reuse its result.
      const same = verify.slice(plan.install ? 1 : 0).find((v) => String(v.command).trim() === String(a.command).trim());
      const r = same ? null : run(a.command, work, timeoutMs);
      const entry = same
        ? { text: a.text, command: a.command, ok: same.ok, status: same.status, timedOut: false, durationMs: 0, outputTail: "", reused: "verify" }
        : { text: a.text, command: a.command, ok: r.ok, status: r.status, timedOut: r.timedOut, durationMs: r.durationMs, outputTail: r.outputTail };
      acceptance.push(entry);
      if (!entry.ok) {
        const why = entry.timedOut ? `timed out after ${timeoutMs} ms` : `exit ${entry.status}`;
        return { ok: false, reason: `acceptance failed on ${branch}: ${entry.text}\n\`${entry.command}\` (${why})\n${entry.outputTail}`, verify, acceptance };
      }
    }
  } finally {
    if (temp) {
      tryGit(dir, ["worktree", "remove", "--force", work]);
      rmSync(temp, { recursive: true, force: true });
    }
  }

  const summary = [
    ...verify.map((v) => `${v.command}: ${v.ok ? "ok" : "failed"}`),
    ...acceptance.map((a) => `${a.text} (${a.command}): ${a.ok ? "ok" : "failed"}`),
  ].join("\n");
  const message = `doug: land ${plan.title}\n\n${branch} -> ${base}\n${summary}`;
  try {
    git(dir, ["merge", "--no-ff", "--no-edit", "-m", message, branch]);
  } catch (err) {
    tryGit(dir, ["merge", "--abort"]);
    return { ok: false, reason: `merge of ${branch} into ${base} failed and was aborted:\n${tail(err.stdout + "\n" + err.stderr, 10)}`, verify };
  }
  const mergeCommit = git(dir, ["rev-parse", "--short", "HEAD"]);

  const removedWorktrees = [];
  if (existsSync(existing)) {
    // Resolve before removing (git deletes the directory, so realpath must run first); reported in
    // the same resolved form removeFinishedWorktrees uses, so removed never mixes /var and /private/var.
    let existingReal;
    try {
      existingReal = realpathSync(existing);
    } catch {
      existingReal = existing;
    }
    tryGit(dir, ["worktree", "remove", "--force", existing]);
    removedWorktrees.push(existingReal);
  }
  const taskBranches = (plan.tasks || []).flatMap((t) => [`doug/task-${t.id}`, ...(typeof t.reuse === "string" ? [t.reuse] : [])]);
  const wtResult = removeFinishedWorktrees(dir, { branches: taskBranches, mergedInto: base });
  const worktrees = { removed: [...removedWorktrees, ...wtResult.removed], kept: wtResult.kept };

  const branchesResult = { deleted: [], kept: [] };
  if (deleteBranches) {
    for (const name of taskBranches) {
      if (name === branch) continue;
      if (tryGit(dir, ["rev-parse", "--verify", "-q", `refs/heads/${name}`]) === null) continue;
      const del = tryGitCapture(dir, ["branch", "-d", name]);
      if (!del.ok) {
        const stderr = del.error.stderr || del.error.message || "";
        const lines = String(stderr).trimEnd().split("\n").filter((l) => l.trim());
        branchesResult.kept.push({ name, reason: lines.length ? lines[lines.length - 1].trim() : "git branch -d failed" });
      } else {
        branchesResult.deleted.push(name);
      }
    }
  }

  const landed = {
    at: now().toISOString(),
    base,
    branch,
    baseWas: baseTip.slice(0, 7),
    branchTip: branchTip.slice(0, 7),
    mergeCommit,
    verify: verify.map((v) => ({ command: v.command, ok: v.ok, durationMs: v.durationMs, ...(v.credited ? { credited: v.credited } : {}) })),
    acceptance: acceptance.map((a) => ({ text: a.text, command: a.command, ok: a.ok, durationMs: a.durationMs, ...(a.reused ? { reused: a.reused } : {}) })),
  };
  savePlan(dir, { ...plan, landed });
  return { ok: true, base, branch, mergeCommit, verify, acceptance, worktrees, branches: branchesResult };
}
