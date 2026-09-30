// Reader for the applied-proposal ledger, .doug/.state/proposals/applied.jsonl (cards memory-decisions,
// proposal-ledger-forgeable): one JSON line per successful `learn.mjs apply` to a proposal-only path
// (docs/decisions/**, .claude/rules/** by default - proposalPaths in .doug/config.json), written by
// plugins/doug-flow/lib/learn.mjs's applyProposal. Duplicated here rather than imported across the plugin
// boundary - no workspace dependency exists between doug-gates and doug-flow (lib/learn.mjs's own header
// comment states the same precedent for its local glob matcher). The line shape is a contract shared with the
// writer: { target, sha256, diffSha256, at, proposal }, where `proposal` is the diff file's path relative to
// `dir` (forward slashes) and `diffSha256` is the sha256 of that diff file's bytes. A row's sha256 alone is not
// enough to trust (card proposal-ledger-forgeable: a hand-written line can carry any sha256 it likes) - see
// isAppliedContent below for the re-derivation this module runs instead. A row is untrusted, agent-writable
// data read at Stop time: every field is treated as adversarial input (wrong type, wrong shape, a path that
// escapes containment), and no exception from checking one row may ever escape isAppliedContent - runHook
// (plugins/doug-gates/lib/io.mjs) fails a hook open on an uncaught exception, which would skip the whole Stop
// gate, not just this check (review BLOCKER 1).
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

export const PROPOSAL_LEDGER_RELPATH = ".doug/.state/proposals/applied.jsonl";

// Duplicated from plugins/doug-flow/lib/learn.mjs's own export of the same constant - no cross-plugin import
// (see this file's header comment). A genuine ledger line's `proposal` must resolve under here.
const LEARN_STATE_RELPATH = ".doug/.state/learn";

// review MINOR 7 / MINOR 10: each candidate row costs a `git show` and a `git apply` (~30ms); a ledger padded
// with many matching-but-bogus rows could push a single Stop check past the hook timeout. Only rows whose
// target and sha256 already match are ever verified (cheap, in-memory), deduped by `proposal` (below) so a
// pile of rows that all name the same diff costs one verification, not one per row, then capped to the most
// recently appended this many DISTINCT proposals. This does not close every way to exhaust the cap: an
// adversary who appends 20 or more rows naming 20 or more genuinely distinct bogus proposal paths can still
// push a real row out of the window - but that fails closed (a block), never open, so it costs availability,
// never lets a forgery through.
const MAX_VERIFIED_ROWS = 20;

// Every spawned git call gets a hard ceiling (ms) so a hung or adversarially slow git invocation cannot itself
// become the way to blow the Stop-gate timeout (review MINOR 7).
const GIT_TIMEOUT_MS = 5000;

// Every well-formed line, tolerant of a missing file or a torn line (a crashed process mid-write) - never fatal.
export function readAppliedLedger(dir) {
  const file = join(dir, PROPOSAL_LEDGER_RELPATH);
  if (!existsSync(file)) return [];
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const out = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const o = JSON.parse(line);
      if (o && typeof o === "object" && o.target) out.push(o);
    } catch {
      // a torn line is skipped, never fatal
    }
  }
  return out;
}

function sha256OfBytes(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

// sha256 of relPath's current bytes under dir, or the sha of empty content when it cannot be read (a deleted or
// never-created target) - matches applyProposal's own convention for a deleted target.
function currentSha256(dir, relPath) {
  try {
    return sha256OfBytes(readFileSync(join(dir, relPath)));
  } catch {
    return sha256OfBytes(Buffer.alloc(0));
  }
}

// review MINOR 8: the writer (applyProposal) refuses a diff that touches more than one file, or whose one
// target differs from what the caller expected - a ledger row must not trust a diff that the writer itself
// would have refused. Every "+++ b/" AND "--- a/" header is parsed (the union of both sides' file names,
// mirroring learn.mjs's own parseDiffTargets - duplicated locally, not imported, for the same reason as
// everything else in this file's header comment); "/dev/null" never matches either pattern, so a creation or
// deletion diff's placeholder side is naturally excluded. True only when the diff names exactly one path and
// that path is relPath.
function diffNamesOnly(diffText, relPath) {
  const targets = new Set();
  for (const m of diffText.matchAll(/^\+\+\+ b\/(.+)$/gm)) targets.add(m[1]);
  for (const m of diffText.matchAll(/^--- a\/(.+)$/gm)) targets.add(m[1]);
  return targets.size === 1 && targets.has(relPath);
}

// The committed base of relPath at `ref` (default HEAD) in dir, as a Buffer, or null when the path is not at
// that ref (a new file), the ref does not exist at all (a repo with no commits yet, or a base sha git no
// longer knows), or the git call times out (GIT_TIMEOUT_MS) or fails.
function readCommittedBase(dir, relPath, ref) {
  const target = typeof ref === "string" && ref ? ref : "HEAD";
  const result = spawnSync("git", ["show", `${target}:${relPath}`], { cwd: dir, timeout: GIT_TIMEOUT_MS });
  if (result.status !== 0) return null;
  return result.stdout;
}

// Re-derivation at one ref (card proposal-ledger-forgeable): write the committed base of `relPath` at
// `relPath`, read at `ref`, inside a fresh temp dir (omitted entirely when there is no base at that ref, so a
// `--- /dev/null` new-file diff can still create it - git apply refuses to create a file that already
// exists), `git apply` the diff there (git apply works as a plain patch tool outside a git repository; cwd is
// the temp dir, never `dir` itself, so nothing real is ever touched), and compare the resulting bytes (empty
// if the diff deleted the file) against `currentSha`. Any failure - a `git apply` that does not succeed or
// times out (GIT_TIMEOUT_MS), or an unexpected exception - means the diff does not reproduce what is on disk
// now from this particular ref, so this attempt does not satisfy the check. The temp dir is always removed.
function diffAppliesAtRef(dir, relPath, diffAbsPath, currentSha, ref) {
  let tmp;
  try {
    tmp = mkdtempSync(join(tmpdir(), "doug-ledger-verify-"));
    const committedBase = readCommittedBase(dir, relPath, ref);
    const targetInTmp = join(tmp, relPath);
    if (committedBase !== null) {
      mkdirSync(dirname(targetInTmp), { recursive: true });
      writeFileSync(targetInTmp, committedBase);
    }
    const applied = spawnSync("git", ["apply", diffAbsPath], { cwd: tmp, timeout: GIT_TIMEOUT_MS });
    if (applied.status !== 0) return false;
    let resultBytes;
    try {
      resultBytes = readFileSync(targetInTmp);
    } catch {
      resultBytes = Buffer.alloc(0);
    }
    return sha256OfBytes(resultBytes) === currentSha;
  } catch {
    return false;
  } finally {
    if (tmp) {
      try {
        rmSync(tmp, { recursive: true, force: true });
      } catch {
        // best-effort cleanup; a leftover temp dir is harmless
      }
    }
  }
}

// `base` (card stop-scan-committed-changes) is the session's baseline HEAD when known, tried first: a diff
// that created `relPath` after that baseline still applies onto "absent" even once the session has since
// committed `relPath` itself (HEAD would otherwise already equal the current bytes, and git apply refuses to
// create a file that already exists there). M1 fix: when the base attempt fails, HEAD is also tried before
// giving up, not only when `base` is null/omitted - a second approved apply on the same target, committed
// in-session after the first (so its preimage is the first version, not the pre-session base), re-derives
// correctly onto HEAD even though it cannot re-derive onto the pre-session base at all. Every other check
// (row shape, containment, diffSha256, diffNamesOnly) is unchanged; this only widens which ref the content
// re-derivation itself is allowed to succeed against.
function diffReproducesCurrentContent(dir, relPath, diffAbsPath, currentSha, base) {
  const refs = typeof base === "string" && base && base !== "HEAD" ? [base, "HEAD"] : ["HEAD"];
  return refs.some((ref) => diffAppliesAtRef(dir, relPath, diffAbsPath, currentSha, ref));
}

// One row's full verification, wrapped so that no exception - a malformed field of any type, an unreadable
// path, a git call throwing - can ever escape (review BLOCKER 1: an uncaught exception here would fail the
// whole Stop hook open, not just this row). Returns false, never throws.
function rowIsGenuine(dir, relPath, sha, learnDirAbs, row, base) {
  try {
    if (typeof row.diffSha256 !== "string" || typeof row.proposal !== "string") return false;
    const diffAbsPath = resolve(dir, row.proposal);
    if (diffAbsPath !== learnDirAbs && !diffAbsPath.startsWith(`${learnDirAbs}${sep}`)) return false;
    const diffBuf = readFileSync(diffAbsPath);
    if (sha256OfBytes(diffBuf) !== row.diffSha256) return false;
    if (!diffNamesOnly(diffBuf.toString("utf8"), relPath)) return false;
    return diffReproducesCurrentContent(dir, relPath, diffAbsPath, sha, base);
  } catch {
    return false;
  }
}

// True when relPath's current content sha256 matches an applied-ledger line for that same target AND that
// line's diff (a) is a real file under dir/.doug/.state/learn/, (b) has the sha256 the row claims for it, (c)
// names relPath and no other file, and (d) applied onto the committed base of relPath, reproduces exactly the
// bytes on disk now (card proposal-ledger-forgeable). Any row missing `diffSha256` or `proposal`, or carrying
// either as anything but a string - the old, pre-hardening line shape, or a forged/malformed one - never
// satisfies this: a hand-written sha256 alone is not proof of an approved `learn.mjs apply` any more, it is
// only what the ledger claims happened. `base` (card stop-scan-committed-changes) is the ref re-derivation
// tries first, forwarded to diffReproducesCurrentContent - the caller's session baseline HEAD when it has
// one, so a target the session itself committed since that baseline is still checked against what existed
// before the session started, not only against HEAD (which, once the target is committed, already equals the
// current bytes and would make a new-file diff fail to apply there). HEAD is always tried too (M1 review
// fix) - a second approved apply on the same target, committed in-session after the first, has the first
// version as its preimage and can only re-derive onto HEAD, not onto the pre-session base. With `base` null
// or omitted, only HEAD is tried, exactly as before this card.
export function isAppliedContent(dir, relPath, { base = null } = {}) {
  const sha = currentSha256(dir, relPath);
  const learnDirAbs = resolve(dir, LEARN_STATE_RELPATH);
  const matching = readAppliedLedger(dir).filter((row) => row && row.target === relPath && row.sha256 === sha);
  // review MINOR 10: dedupe by `proposal` before capping to MAX_VERIFIED_ROWS - many rows naming the very same
  // diff (repeated or near-repeated bogus lines) must cost one verification slot, not one per row, or a large
  // enough pile of them could push a genuine row for this same target/sha256 out of the last-N window even
  // though every one of those rows resolves to a single distinct diff file. A Map naturally keeps only the
  // last-seen entry per key, and the ledger is append-only (later == newer), so the newest occurrence of each
  // distinct `proposal` wins.
  const byProposal = new Map();
  for (const row of matching) byProposal.set(row.proposal, row);
  const candidates = [...byProposal.values()].slice(-MAX_VERIFIED_ROWS).reverse(); // newest distinct proposal first
  return candidates.some((row) => rowIsGenuine(dir, relPath, sha, learnDirAbs, row, base));
}
