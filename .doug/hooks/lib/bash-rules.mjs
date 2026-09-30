// Pure rule functions for the Bash guard so they can be unit-tested without spawning.

const PM_INSTALL_VERBS = {
  npm: /^(install|i|add|ci|uninstall|remove|rm|un|update|up|dedupe|link)\b/,
  pnpm: /^(install|i|add|remove|rm|uninstall|un|update|up|dedupe|link)\b/,
  yarn: /^(install|add|remove|up|upgrade|dedupe|link)\b|^$/,
  bun: /^(install|i|add|remove|rm|update|link)\b/,
};

// Card bash-rules-quote-aware-split: splits a compound shell command into simple commands using the shared
// quote-aware scanner (scanTop, below) instead of a quote-blind regex - a separator-looking character sitting
// inside a quoted word (a commit message, a node -e program) is no longer mistaken for a real "&&"/"||"/";"/
// "|"/"&"/"|&"/newline, and the body of every unquoted-or-double-quoted "$(...)" or backtick substitution
// really executes, so its pieces are split out too, recursively (research Q1.5; design decided by the lead,
// point 3). Falls back to today's quote-blind split - checking MORE than a real shell would, never less - when
// the scanner hits an unterminated quote or substitution (a heredoc body looks the same to it, and heredocs are
// out of scope - point 4) or throws for any other reason (a hook reader must never throw - CLAUDE.md Gotchas).
// A bare "&" (backgrounds the command before it, redirection forms excepted) and bash's "|&" (a pipe connector,
// treated the same as a bare "|") joined this set in review round 5 (third review) - see scanTop's comment.
const ALL_SEPS = new Set(["&&", "||", ";", "|", "&", "|&", "\n"]);

// Review round 2 (M1): a substitution body recurses through splitCommands one call per nesting level, and each
// call re-walks nearly the whole remaining string (cutOnSeparators -> scanTop -> scanParenBody), so an
// adversarial "$(" nest costs O(depth^2), and - far worse - enough real recursion depth (measured: a few
// thousand levels) can push commandForms's/splitCommands's own JS call stack to the point where a RangeError
// thrown mid-scan is caught here, and the catch's OWN quoteBlindSplit call then tries to compile the regex-split
// machinery while the stack is still that deep: V8 can fail that allocation as a FATAL, UNCATCHABLE process
// abort (measured: exit 134, "RegExpCompiler Allocation failed - process out of memory"), not a normal thrown
// exception - so the try/catch below cannot save it, and the whole hook process would die instead of failing
// open. Capping the recursion depth avoids both: past the cap, the remaining (however deeply the text still
// looks nested) body text is handed to quoteBlindSplit ONCE - a single linear regex pass, cheap regardless of
// how it looks - instead of recursing into it, so real call-stack depth never approaches the danger zone and
// total work stays linear in the input length. The cap is internal only, tracked by splitCommandsAt (below) -
// the EXPORTED splitCommands(command) takes exactly one parameter (review round 3, minor 4: a second exported
// parameter with a default, as this used to be, is a footgun - an accidental `somePieces.map(splitCommands)`
// elsewhere would silently pass Array.prototype.map's own index argument as depth, corrupting the cap). A
// caller that wants to recurse with a depth passed in calls the internal splitCommandsAt directly instead.
const SUBSTITUTION_DEPTH_CAP = 25;

// Review round 5: the same "&" rule as scanTop (a bare "&" backgrounds the command before it, unless it's part
// of a redirection - immediately preceded by "<"/">" or immediately followed by ">"), and "|&" as one unit,
// added to the quote-blind fallback's own split pattern too. The call was made to add it (not leave the
// fallback quote-blind): a regex split only ever ADDS cut points, and no DESTRUCTIVE row (or checkNoVerify's,
// checkForcePush's, ...) pattern requires trailing context past its own anchor (each is "^verb ... target" with
// a "\b" or "(\s|$)" right after the target, never "target and nothing else in the whole piece") - so an extra
// cut can only ever produce a SMALLER piece that still contains the same anchored match, never lose one HEAD
// would have found. Verified directly (see the coder's report) against the required no-false-positive set
// (cmd 2>&1, cmd >&2, cmd &>/dev/null, cmd 1>&2, cmd <&0, make -j4 &, git log 2>&1 | head, a 2>&1 | tee f, a
// quoted "&") on both the quote-aware AND (by temporarily forcing the fallback) the quote-blind path.
const QUOTE_BLIND_SEP = /\s*(?:&&|\|&|\|\||;|\|)\s*|\s*(?<![<>])&(?!>)\s*|\n/;

function quoteBlindSplit(str) {
  return str
    .split(QUOTE_BLIND_SEP)
    .map((s) => s.trim())
    .filter(Boolean)
    .map(stripUnmatchedTrailingQuote);
}

// Review round 3 (Q18 fixture): quoteBlindSplit alone does not know "$(", "(", ")", or a backtick from any other
// character, so past the depth cap a body still wrapped in more than one un-recursed "$(...)" layer comes back
// as ONE piece that still starts with "$(" - checkDestructive's rows all anchor on the start of the piece
// (^rm, ^git, ^(sudo\s+)?chmod, ...), so a leading "$(" defeats every one of them even though a trailing ")"
// left over from a stage that DOES get isolated (a real separator inside the nest) does not (no row anchors at
// the END too - see checkPipeGroups' Q18 case). Turning every "$(", bare "(", ")", and backtick into a separator
// character first - before the regex split, not instead of it - fixes this: it costs one more linear pass (still
// O(remaining length), no recursion added), and it can only ever ADD split points, never remove a real one, so a
// destructive command sitting at the center of an arbitrarily deep bare "$(...)" nest becomes its own clean piece
// regardless of how many un-recursed layers are left (checks more, never less, same principle as everywhere
// else in this module).
function flattenParensForFallback(str) {
  return str.replace(/\$\(|[()`]/g, ";");
}

// Review round 2 (B1 blocker): quoteBlindSplit runs on the WHOLE original string once scanTop gives up on an
// unterminated quote or substitution - and on THAT path quote pairing across the whole string is unreliable by
// definition (that is why the quote-aware scan gave up), so a piece the quote-blind regex cuts out can end with
// a single, unmatched trailing quote character left over from a quote the scanner "closed" far earlier in the
// string than where it was really opened (e.g. an apostrophe inside a "#" comment - not recognised, a known
// limit - merges quote state across an intervening real command, so a later, perfectly ordinary 'sh -c "cd x &&
// rm -rf ~"' gets cut at its OWN "&&" after all, leaving "rm -rf ~'" as its own piece). The DESTRUCTIVE catalogue
// no longer carries an allowance for that stray quote (Q14 dropped it, since the quote-aware path normally never
// produces one), so this fallback strips it itself instead, keeping DESTRUCTIVE's rows clean. "Unmatched" = that
// quote character occurs an odd number of times in the piece; only a TRAILING occurrence is stripped. A leading
// or embedded unmatched quote (the piece just before this one, e.g. "sh -c 'echo a") is left alone: it is not
// glued to whatever destructive target follows in a LATER piece, so stripping it would catch nothing, and
// commandForms's own fallback word-split already recovers that piece's literal text (echo a) well enough to run
// its per-command checks with nothing of security value lost - see the coder's report for the full trace.
function stripUnmatchedTrailingQuote(piece) {
  for (const q of ["'", '"']) {
    if (!piece.endsWith(q)) continue;
    let count = 0;
    for (let i = 0; i < piece.length; i += 1) if (piece[i] === q) count += 1;
    if (count % 2 === 1) return piece.slice(0, -1);
  }
  return piece;
}

export function splitCommands(command) {
  return splitCommandsAt(command, 0);
}

function splitCommandsAt(command, depth) {
  try {
    const str = String(command);
    const cut = cutOnSeparators(str, ALL_SEPS);
    if (!cut) return quoteBlindSplit(str);
    const pieces = cut.pieces.slice();
    for (const body of cut.subs) {
      if (depth >= SUBSTITUTION_DEPTH_CAP) {
        pieces.push(...quoteBlindSplit(flattenParensForFallback(body))); // past the cap: checks more, never less
      } else {
        pieces.push(...splitCommandsAt(body, depth + 1));
      }
    }
    return pieces;
  } catch {
    return quoteBlindSplit(String(command));
  }
}

// Plain, quote-blind word split - unchanged, and deliberately left that way: normalizeGit, checkForcePush, and
// checkPipeToShell's own shell-verb matching (matchesShellStage) all resolve a PREFIX (sudo, env, a flag's own
// argument, ...), which this card's goal does not ask to make quote-aware, and a quoted argument containing a
// space there is explicitly out of scope (see checkPipeToShell's comment below). Only commandForms's own word
// split (wordsQ, further down) is quote-aware, per the design.
function words(cmd) {
  return cmd.split(/\s+/).filter(Boolean);
}

// ---------------------------------------------------------------------------------------------------------
// Card bash-rules-quote-aware-split: one small scanner, shared by splitCommands (above), checkPipeToShell, and
// commandForms's word split (wordsQ). It is a guard: where a reading is ambiguous, it checks MORE text, never
// less (design decided by the lead).
//
// Scanner states (research Q1.1-4, 6): unquoted ("top"); single-quoted ("squote", literal to the next "'",
// backslash not an escape); double-quoted ("dquote", backslash escapes only $, `, ", \, and a raw newline - any
// other backslash is left in the word as an ordinary character; a "'" inside is inert); ANSI-C $'...' ("ansic",
// where \' and \\ do not end it - other backslash escapes are not reproduced here, a known limit, since nothing
// in this module needs to reconstruct \n/\t/... beyond keeping the quote open); $"..." reads as double-quoted.
// An unquoted backslash escapes the very next character (so \', \", \;, \|, \& are ordinary text and never open
// a quote or split - research Q1.3); an unquoted backslash-newline is a continuation, removed rather than
// treated as a separator or a word break. Closing a quote does not end the word (adjacent quoted/unquoted runs
// glue into one - research Q1.6).
//
// Separators recognised at the top level only: &&, ||, ;, |, and a raw newline - exactly today's set (Left out:
// a bare "&" is not added by this card).
//
// Command substitution executes (research Q1.5): the body of every "$(...)" and backtick pair that is unquoted
// or inside double quotes (not inside single- or ANSI-C-quoted text, where "$(" and "`" are just ordinary
// characters) is collected into `subs`, in the order encountered; the caller re-scans each body the same way,
// recursively, through the SAME exported entry points (splitCommands, checkPipeToShell), not through this
// function calling itself - so a nested substitution keeps recursing all the way down through ordinary
// top-level scans. Quotes inside a substitution's body are tracked independently of whatever quote the "$("
// itself sits inside (a stack, not a boolean: scanParenBody below starts its own body scan fresh in the "top"
// state). "$((...))" is read as a substitution too (its body is "(...)" verbatim) - over-checking is fine.
//
// Known limits, stated as limits, not bugs: a word-initial "#" comment and a heredoc body are not recognised
// (over-report only, never under-report - research Q1.7); zsh's RC_QUOTES, bash 5.x, and dash's lack of
// $'...' are unverified or divergent, and the bash/zsh reading is the one this scanner takes; a "(...)" subshell
// or "{ ...; }" group is not unwrapped (unchanged from today).
//
// Returns null when the string ends inside an unterminated quote or substitution - a real shell would run
// nothing at all (research Q1.8), but with no heredoc state a heredoc body looks the same to this scanner, so
// the caller falls back to the old quote-blind split for the whole string instead of denying nothing or
// throwing (checks more, never less).
function isDquoteEscapable(c) {
  return c === "$" || c === "`" || c === '"' || c === "\\" || c === "\n";
}

// Finds the index of the backtick that closes the one at str[i] (str[i] === "`"): a backslash escapes the next
// character, so \` and \\ do not end it early. Returns -1 when the string ends first (unterminated).
function scanBacktickBody(str, i) {
  let j = i + 1;
  while (j < str.length) {
    const c = str[j];
    if (c === "\\") { j += 2; continue; }
    if (c === "`") return j;
    j += 1;
  }
  return -1;
}

// Finds the index of the ")" that closes the "(" at str[i] (str[i] === "("): every unquoted "(" (bare, or the
// one right after a "$") nests one level deeper and every unquoted ")" closes one, so a paren inside a nested
// quote or a nested backtick substitution is never mistaken for this one's close; a paren inside single- or
// double-quoted text does not count at all (research Q1.5's "in ; ner" example: quotes reset at "(" and are
// tracked independently of the outer context). Known limit (review round 2): a "case" pattern's own unquoted
// ")" (case $x in a) ... ;; esac inside a "$(...)") is taken as this substitution's close too, since this
// scanner has no case-statement state - real zsh (and some bash builds) still runs such a body as one
// substitution past that point, so this is an under-parse of the substitution's true extent, not just an
// over-report; not fixed here, out of scope for this card. Returns -1 when the string ends first (unterminated).
function scanParenBody(str, i) {
  let depth = 1;
  let j = i + 1;
  let state = "top";
  while (j < str.length) {
    const c = str[j];
    if (state === "top") {
      if (c === "\\") { j += 2; continue; }
      if (c === "'") { state = "squote"; j += 1; continue; }
      if (c === '"') { state = "dquote"; j += 1; continue; }
      if (c === "$" && str[j + 1] === "'") { state = "ansic"; j += 2; continue; }
      if (c === "`") {
        const close = scanBacktickBody(str, j);
        if (close < 0) return -1;
        j = close + 1;
        continue;
      }
      if (c === "(") { depth += 1; j += 1; continue; }
      if (c === ")") {
        depth -= 1;
        if (depth === 0) return j;
        j += 1;
        continue;
      }
      j += 1;
      continue;
    }
    if (state === "squote") {
      if (c === "'") state = "top";
      j += 1;
      continue;
    }
    if (state === "dquote") {
      if (c === "\\" && isDquoteEscapable(str[j + 1])) { j += 2; continue; }
      if (c === '"') state = "top";
      j += 1;
      continue;
    }
    // ansic
    if (c === "\\") { j += 2; continue; }
    if (c === "'") state = "top";
    j += 1;
  }
  return -1;
}

// The one full pass: walks str once, classifying every character as inside a quote or at the top level, and
// records - at the top level only - every separator occurrence (&&, ||, ;, |, a bare "&", bash's "|&", or "\n"
// - see the "&" comment below for why a bare "&" is in this list now), every run of whitespace (so a
// word-level splitter can use the same pass - see wordsQ), and the raw body text of every live substitution
// (see the block comment above). Returns null on an unterminated quote or substitution.
//
// Review round 5 (third review, blocker of the same shape as the ANSI-C one): the brief's original "Left out:
// a bare & stays unadded" premise (splitCommands never used to dequote anything, so an escaped-then-bare "&&"
// inside a -c script string never became a real one) no longer holds once dequoteScript exists - "sh -c "echo
// \&& git reset --hard"" dequotes to "echo \&& git reset --hard", and a real shell reads that as "echo \&"
// (backgrounded, the backslash making the FIRST "&" literal) followed by a real, unescaped SECOND "&" that
// starts "git reset --hard" as its own command. HEAD only denied this by accident (its quote-blind split saw
// the raw "&&" in the ORIGINAL, still-quoted text); the current (pre-round-5) code parses the quotes correctly,
// sees one escaped "&" and one literal, unescaped "&" that isn't a separator anywhere in this scanner, and
// allows it - a real deny->allow regression, confirmed against real bash AND zsh (both run the second command;
// files run as `bash file` / `zsh file`, not through this session's own shell). A bare "&" is a real command
// separator (backgrounds the command before it) EXCEPT as part of a redirection: immediately preceded by ">"
// or "<" (2>&1, >&2, <&0, >&file - the fd-duplication and any-target forms) or immediately followed by ">"
// (&>file, &>>file - bash's combined stdout+stderr redirect) - confirmed with real bash/zsh probes (files, not
// this session's shell): `echo a & echo b`, `echo a 2>&1 & echo b`, and `echo a &>/dev/null; echo b` all behave
// exactly as a shell reader would expect (the first backgrounds and prints out of order; the second the same,
// the redirection unaffected; the third redirects "a" away with nothing backgrounded). This also closes an old
// gap the round-1 brief left out on purpose (back when dequoting didn't exist to make it urgent): HEAD allowed
// both `sleep 1 & rm -rf ~` and `sh -c 'echo a & rm -rf ~'`, and both really run the second command - both are
// denied now. Bash's `|&` (shorthand for `2>&1 |`) is recognised as ONE unit, a pipe connector, not a bare "&"
// immediately after a bare "|" (which would otherwise wrongly background "curl url |" - a syntax error - and
// read "& sh" as a separate, unrelated group, breaking checkPipeToShell's "curl/wget stage followed by a shell
// stage somewhere later in the SAME chain" logic for `curl url |& sh`; HEAD didn't catch this either - its own
// quote-blind split had no "&" handling at all and split "curl url |& sh" into ["curl url", "& sh"], and
// checkPipeToShell returned null on it, same as before this fix for a different, accidental reason).
function scanTop(str) {
  const seps = [];
  const spaces = [];
  const subs = [];
  let state = "top";
  let i = 0;
  while (i < str.length) {
    const c = str[i];
    if (state === "top") {
      if (c === "\\") {
        if (str[i + 1] === "\n") { i += 2; continue; } // backslash-newline: continuation, removed
        i += 2; // escapes the very next character, whatever it is (never opens a quote, never splits)
        continue;
      }
      if (c === "'") { state = "squote"; i += 1; continue; }
      if (c === '"') { state = "dquote"; i += 1; continue; }
      if (c === "$" && str[i + 1] === "'") { state = "ansic"; i += 2; continue; }
      if (c === "$" && str[i + 1] === '"') { state = "dquote"; i += 2; continue; } // $"..." reads as dquote
      if (c === "$" && str[i + 1] === "(") {
        const close = scanParenBody(str, i + 1);
        if (close < 0) return null;
        subs.push(str.slice(i + 2, close));
        i = close + 1;
        continue;
      }
      if (c === "`") {
        const close = scanBacktickBody(str, i);
        if (close < 0) return null;
        subs.push(str.slice(i + 1, close));
        i = close + 1;
        continue;
      }
      if (c === "\n") { seps.push({ start: i, end: i + 1, text: "\n" }); i += 1; continue; }
      if (c === " " || c === "\t" || c === "\r") {
        let j = i + 1;
        while (j < str.length && (str[j] === " " || str[j] === "\t" || str[j] === "\r")) j += 1;
        spaces.push({ start: i, end: j });
        i = j;
        continue;
      }
      if (c === "&" && str[i + 1] === "&") { seps.push({ start: i, end: i + 2, text: "&&" }); i += 2; continue; }
      if (c === "|" && str[i + 1] === "&") { seps.push({ start: i, end: i + 2, text: "|&" }); i += 2; continue; }
      if (c === "|" && str[i + 1] === "|") { seps.push({ start: i, end: i + 2, text: "||" }); i += 2; continue; }
      if (c === ";") { seps.push({ start: i, end: i + 1, text: ";" }); i += 1; continue; }
      if (c === "|") { seps.push({ start: i, end: i + 1, text: "|" }); i += 1; continue; }
      if (c === "&") {
        // A bare "&" is a separator (backgrounds what precedes it) unless it's part of a redirection - see the
        // block comment above scanTop for the citations and the "|&" note.
        const isRedirect = str[i - 1] === ">" || str[i - 1] === "<" || str[i + 1] === ">";
        if (!isRedirect) seps.push({ start: i, end: i + 1, text: "&" });
        i += 1;
        continue;
      }
      i += 1; // an ordinary top-level character, including a bare "(" or ")" - not unwrapped (Left out)
      continue;
    }
    if (state === "squote") {
      if (c === "'") state = "top";
      i += 1;
      continue;
    }
    if (state === "dquote") {
      if (c === "\\" && isDquoteEscapable(str[i + 1])) { i += 2; continue; }
      if (c === '"') { state = "top"; i += 1; continue; }
      if (c === "$" && str[i + 1] === "(") {
        const close = scanParenBody(str, i + 1);
        if (close < 0) return null;
        subs.push(str.slice(i + 2, close));
        i = close + 1;
        continue;
      }
      if (c === "`") {
        const close = scanBacktickBody(str, i);
        if (close < 0) return null;
        subs.push(str.slice(i + 1, close));
        i = close + 1;
        continue;
      }
      i += 1;
      continue;
    }
    // ansic
    if (c === "\\") { i += 2; continue; }
    if (c === "'") { state = "top"; }
    i += 1;
  }
  if (state !== "top") return null; // unterminated quote or substitution
  return { seps, spaces, subs };
}

// Cuts str into raw pieces at every top-level separator whose text is in `kinds` (splitCommands passes all
// five; checkPipeToShell passes them in two separate calls - groups at &&/||/;/\n, then each group's stages at
// | - so a bare "|" is never a group cut and &&/||/;/\n are never a stage cut). Returns null (caller falls back)
// on an unterminated quote/substitution; otherwise { pieces, subs }, pieces trimmed and empties dropped.
function cutOnSeparators(str, kinds) {
  const scanned = scanTop(str);
  if (!scanned) return null;
  const cuts = scanned.seps.filter((s) => kinds.has(s.text));
  const pieces = [];
  let start = 0;
  for (const cut of cuts) {
    pieces.push(str.slice(start, cut.start));
    start = cut.end;
  }
  pieces.push(str.slice(start));
  return { pieces: pieces.map((p) => p.trim()).filter(Boolean), subs: scanned.subs };
}

// Strips every leading git global option after "git" so every rule below can anchor on the verb without an
// option being mistaken for it: a git verb never starts with "-", so ANY leading token starting with "-" is
// skipped, not just an allowlist (a prior version allowlisted -C, -c, --git-dir, --work-tree, --no-pager, which
// let every other global option - -P, --paginate, --literal-pathspecs, --no-optional-locks, --exec-path=,
// --namespace=, etc. - through as if it were the verb). The exact space forms -C, -c, --git-dir, --work-tree
// still consume the next token as their separate-token argument (their attached forms, e.g. -C<dir>, -c<k=v>,
// --git-dir=<path>, already carry the argument in the same token and need no extra skip). Every other
// "-"-prefixed token skips just itself. The walk stops at the first token that doesn't start with "-": that is
// the verb, so it can never be skipped even if it looks like an option's argument (a two-token option's
// argument is the one exception, since it's consumed by definition). Commands that don't start with "git" (a
// bare word followed by whitespace) are returned unchanged.
export function normalizeGit(cmd) {
  const w = words(cmd);
  if (w[0] !== "git") return cmd;
  let i = 1;
  while (i < w.length) {
    const tok = w[i];
    if (!tok.startsWith("-")) break; // the verb: never eaten
    if (tok === "-C" || tok === "-c" || tok === "--git-dir" || tok === "--work-tree") {
      i += 2; // option + its separate-token argument
      continue;
    }
    i += 1; // every other leading "-" option skips just itself
  }
  return ["git", ...w.slice(i)].join(" ");
}

export function checkNoVerify(cmd) {
  const normalized = normalizeGit(cmd);
  if (/^git\s+(commit|push|merge|rebase|cherry-pick)\b/.test(normalized) && /(^|\s)--no-verify(\s|$)/.test(normalized)) {
    return `"--no-verify" skips the repository's git hooks. Run the hooks; fix what they report.`;
  }
  return null;
}

export function checkForcePush(cmd, protectedBranches, currentBranch) {
  const normalized = normalizeGit(cmd);
  if (!/^git\s+push\b/.test(normalized)) return null;
  const forced = /(^|\s)(-f|--force|--force-with-lease(=\S+)?|--force-if-includes)(\s|$)/.test(normalized) || /\s\+[A-Za-z0-9_./-]+/.test(normalized);
  if (!forced) return null;
  const w = words(normalized).slice(2).filter((x) => !x.startsWith("-"));
  // git push [remote] [refspec]
  const refspec = w[1] || null;
  let target = null;
  if (refspec) {
    const m = refspec.replace(/^\+/, "").split(":");
    target = (m[1] || m[0]).replace(/^refs\/heads\//, "");
  } else {
    target = currentBranch;
  }
  if (target && protectedBranches.includes(target)) {
    return `Force-pushing to "${target}" rewrites shared history. Push a new branch or ask the user.`;
  }
  return null;
}

// Card bash-rules-prefixed-commands: the target alternation also matches a trailing "/" or "/*" on the root,
// home, "$HOME", and parent-directory forms (./, ./*, /*, ~/, ~/*, $HOME/, $HOME/*, ../, ../*), which real
// shells treat the same as the bare form (rm -rf ~/* deletes everything under $HOME, same danger as rm -rf ~).
// An arbitrary absolute path (rm -rf /tmp/x) still isn't one of these tokens, so it stays allowed.
// Round 2 (R5, since card bash-rules-quote-aware-split: allowance removed, see Q14): the target used to accept
// one optional trailing "'" or '"' before the end/whitespace boundary, because the old quote-blind splitCommands
// split "sh -c 'cd x && rm -rf ~'" on the && sitting inside the quotes, leaving "rm -rf ~'" (a stray trailing
// quote with no matching opener in that piece) as its own split command. On the quote-aware path splitCommands
// never splits inside the quotes in the first place - there is no stray quote left to allow for THERE - and
// commandForms re-splits the extracted -c script itself to find the same target as a clean piece (Q8), so the
// allowance is gone from this row: a real trailing quote right after the target on that path (an actual
// unterminated word, not an artifact of the old split) is no longer specially permitted either, over-denying
// that arguably-safe edge the old code let through. That claim does NOT extend to the quote-blind FALLBACK path
// (an unterminated quote or substitution elsewhere in the string): a stray trailing quote can still land on a
// piece there, so quoteBlindSplit strips one itself (review round 2, B1: stripUnmatchedTrailingQuote, above)
// rather than this row growing the allowance back.
const DESTRUCTIVE = [
  { re: /^rm\s+(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r|--recursive\s+--force|-r\s+-f|-f\s+-r)\s+(\/\*|\/|~\/\*|~\/|~|\$HOME\/\*|\$HOME\/|\$HOME|\.\/\*|\.\/|\.\.\/\*|\.\.\/|\.\.|\.|\*)(\s|$)/, why: "recursive delete of the root, home, current, or parent directory" },
  { re: /^rm\s+-[a-zA-Z]*r[a-zA-Z]*\s+\/(\s|$)/, why: "recursive delete of the filesystem root" },
  { re: /^git\s+reset\s+--hard\b/, why: "git reset --hard discards uncommitted work" },
  { re: /^git\s+clean\s+-[a-zA-Z]*f/, why: "git clean -f deletes untracked files" },
  { re: /^git\s+(checkout|restore)\s+(--\s+)?\.(\s|$)/, why: "reverting the whole working tree discards uncommitted work" },
  { re: /^git\s+branch\s+-D\b/, why: "force-deleting a branch" },
  { re: /^git\s+push\s+.*--delete\b/, why: "deleting a remote branch" },
  { re: /\bDROP\s+(TABLE|DATABASE|SCHEMA)\b/i, why: "dropping a table, schema, or database" },
  { re: /^(sudo\s+)?chmod\s+-R\s+777\s+\//, why: "recursive chmod 777 on the filesystem root" },
  { re: /^(sudo\s+)?mkfs\b|^dd\s+.*of=\/dev\//, why: "formatting or overwriting a block device" },
];

export function checkDestructive(cmd) {
  const normalized = normalizeGit(cmd);
  for (const { re, why } of DESTRUCTIVE) {
    if (re.test(normalized)) return `Blocked: ${why}. If the user wants this, they can run it themselves or disable bash.denyDestructive in .doug/config.json.`;
  }
  return null;
}

// Runs on the WHOLE command string, before splitCommands (which splits on "|" too and would sever the
// relationship between a download and the shell it's piped into). Internally splits on the top-level
// separators (&&, ||, ;, newline) that keep a pipeline's stages together, then walks each pipeline's stages
// looking for a chain that starts with a curl/wget stage and has a shell stage ANYWHERE later in the chain -
// not only as the last stage: the download still reaches the shell even when something else (tee, cat, ...)
// sits after it too. A shell stage's prefix is a loop, not a fixed order: at each position it accepts an env
// assignment (FOO=1), a "sudo" prefix (matched by basename, so /usr/bin/sudo counts too; accepting flags that
// take a separate argument such as -u root, -g wheel, --user=root, an attached "--long=value" as a single
// token, and a bare "--" that ends the option list - and, card bash-rules-sudo-shell-flags, marking the whole
// stage a shell stage outright when -s/--shell or -i/--login is met with no command word left after sudo's
// options: see scanSudoOptions and the SUDO_ARG_FLAGS comment below), or an "env" prefix (matched by basename too, so
// /usr/bin/env counts; accepting its own "--long=value", "--", and flags that take a separate argument such as
// -u NAME, -C DIR, -S STRING - see ENV_ARG_FLAGS - with the same rules), and keeps looping so any of these can
// repeat in any order (env before sudo, an assignment after either, sudo again, ...) until a token matches
// none of them: that token is the candidate verb, matched by its basename (the text after the last "/") so an
// absolute path like /bin/sh or /usr/local/bin/bash matches too. env's -S/--split-string is unlike every other
// env option: when its value (in any spelling: a separate token "-S value", an attached "-Svalue", or an
// attached "--split-string=value") is a non-empty word that doesn't itself start with "-", that value IS the
// command GNU env runs, so meeting it ends the walk right there: the result is just whether that value's
// basename is a shell (env -S sh, env -Ssh, and env --split-string=sh all reach a shell), and nothing after
// the value - a real verb, another prefix - is examined (env -S tee sh runs "tee", with "sh" as tee's own
// argument, not a shell stage). But real env only treats the value as the command under that condition: an
// empty value (env --split-string=) or one that looks like another option (env -S -i sh) is not the command,
// so env keeps parsing options from there and the actual command comes from what follows (env -S -i echo HIT
// prints HIT) - the walk re-examines that same token (the separate-token form) or moves past it and continues
// (an attached form, whose value can't be split back into its own token).
//
// Card bash-rules-command-wrappers: six more prefixes are taken, each one more branch of the same loop,
// matched by basename like sudo and env (so /usr/bin/nice, /usr/bin/time, /usr/bin/nohup count too; exec and
// command are shell builtins with no path form, but basename matching is harmless and keeps one shape) and
// each walking its options with skipPrefixOptions and its own argument-flag set:
//   - nice: -n and --adjustment take the next token; the legacy negative form (nice -10 sh) is a "-"-prefixed
//     token that isn't a recognised flag, so it falls to the generic "skip just itself" branch, same as any
//     unrecognised short option; --adjustment=N is one token, handled by the existing "--long=value" branch.
//   - time: -f, -o, --format, --output take the next token (bash's keyword and GNU/BSD /usr/bin/time both run
//     the next word regardless); -p, -a, -v take none.
//   - nohup: no flags of its own worth modelling (--help/--version run nothing, but that's not modelled -
//     over-denying is the safe side here, as elsewhere in this module).
//   - exec: -a takes the next token (exec -a NAME sh sets argv0 and still runs sh); -c, -l take none.
//   - command: no flags take a following token, but -v and -V are terminal rather than merely argument-free:
//     real command -v NAME / -V NAME print information and run NOTHING, so meeting either ends the walk right
//     there with "not a shell stage" (see scanCommandOptions) - nothing after it, including a real shell verb,
//     is examined. -p takes no argument. Card bash-rules-combined-short-flags: a combined short-flag cluster
//     (bash's exec -cla NAME, BSD time -po FILE, sudo -Eu root, env -iu PATH) IS modelled, for every wrapper
//     that walks its options with skipPrefixOptions, scanSudoOptions (sudo, same clustering rules plus its own
//     shell-flag tracking - card bash-rules-sudo-shell-flags), or scanEnvOptions - clusterFlag reads the cluster
//     letter by letter, left to right, against the wrapper's argument-flag set, the way getopt does (see
//     clusterFlag for the exact rule). command is the one exception: it keeps its exact -v/-V check unclustered, so a cluster
//     like -pv is not -v and command -pv sh is still caught - over-denying on the safe side, pinned by a test
//     rather than fixed.
//   - busybox: no flags modelled (busybox's own options - --list, --install, --help - run no applet); a
//     "-"-prefixed token after busybox falls to the generic skip and is treated as consuming just itself, which
//     over-denies busybox --list sh (real busybox --list doesn't run sh) - the safe side, as with nohup above.
//     busybox <applet> runs the applet, so busybox sh is a shell stage, busybox env sh continues through the
//     env branch above, and busybox ash is caught too, since card bash-rules-shell-verb-set added ash to
//     SHELL_VERBS below.
// Out of scope, deliberately: "xargs" (curl url | xargs sudo -u root sh runs the shell with the downloaded
// bytes as an argument list, not on stdin, and taking xargs would mean modelling xargs's own flags to find
// where its command starts) and a quoted argument containing a space (sudo -p 'enter pw' sh, env -S 'sh -c x',
// time -f '%e s' sh): this module parses no quotes, so a quoted token is indistinguishable from several bare
// ones.
//
// Card bash-rules-shell-verb-set: the set was sh, bash, zsh, dash, ksh, fish - missing several real shells
// (busybox's ash, csh, tcsh, mksh, yash, busybox's hush) and any versioned binary name (bash5, bash-5.2,
// zsh-5.9), all real ways to run a shell that this module let through. The decision, and why:
//   - ash, csh, tcsh, mksh, yash, hush join the Set outright: each is a real, independently-shipped shell binary
//     (ash is also busybox's default shell, hush is busybox's minimal one), no different in kind from the six
//     already listed.
//   - bash and zsh alone also match a versioned form (VERSIONED_SHELL below): the shape is taken on the card's
//     word, not on confirmed usage - bash5, bash-5.2, and zsh-5.9 are the forms the goal names as the ones to
//     catch. Whether any distribution or manual install actually ships a binary under one of these names is
//     unverified (see the brief's Facts). The acceptance is over-deny either way: a name nobody ships resolves
//     to no binary, so the rule catches nothing real and costs nothing. The suffix is on bash and zsh only, not
//     folded into a regex over every name in the Set, because those are the two names the goal calls out; a
//     version number after "dash" or "fish" (dash-0.5, fish2) is not a form the goal names, and guessing at it
//     would claim more than is known.
//   - Interpreters that are not shells - python, perl, node, ruby - stay out: each reads a script from stdin
//     only under its own flag ("python -" or "-c", "perl -", "node -", "ruby -"), never bare, so catching them
//     needs a different rule shaped around those flags, not a name added to a shell-verb set. That is a
//     separate card if one is wanted; python3 is explicitly out of scope by this card's goal.
const SHELL_VERBS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish", "ash", "csh", "tcsh", "mksh", "yash", "hush"]);

// Card bash-rules-shell-verb-set: a version suffix is recognized on bash and zsh only (see the comment above) -
// an optional dash followed by a digit and any run of digits/dots, so "bash5", "bash-5.2", and "zsh-5.9" match
// but "bashful" and "zsh-" (no digit) do not. The same run-of-digits-and-dots shape also matches strings no
// real version number takes, such as a trailing dot ("bash5.", "bash-5.2.") or a leading zero ("bash05") -
// over-deny, the safe side: a name nobody ships this way just resolves to no binary.
const VERSIONED_SHELL = /^(bash|zsh)-?[0-9][0-9.]*$/;

// Single point of truth for "is this basename a shell verb", used at the one call site (matchesShellWords)
// instead of a bare SHELL_VERBS.has so the versioned-bash/zsh form is checked too.
function isShellVerb(name) {
  return SHELL_VERBS.has(name) || VERSIONED_SHELL.test(name);
}

// An env-style assignment token (FOO=1, PATH=/x:/y): a bare NAME= prefix, distinct from a "--long=value" flag
// because it doesn't start with "-".
const ENV_ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;

// sudo flags that consume the next token as their argument (short forms and their long equivalents); a flag
// not in this set (e.g. -E) takes no argument and leaves the following token alone.
//
// Card bash-rules-sudo-shell-flags: -s/--shell and -i/--login are NOT in this set - like -E, they take no
// argument - but meeting either (bare, as the long form, or as a cluster letter - see below) marks the whole
// sudo stage a shell stage when nothing but options and env assignments (which sudo sets rather than runs)
// follows: sudo execs the shell with no -c in that case, and a shell with no operands reads stdin as its
// script. man sudo, -s: "Run the shell ... If no command is specified, an interactive shell is executed.";
// -i: "Run the shell ... as a login shell. ... If no command is specified, an interactive shell is executed."
// POSIX sh: "If there are no operands and the -c option is not specified, the -s option shall be assumed" /
// "-s Read commands from the standard input." If a command word follows instead, sudo passes it to the shell
// via -c and that command's stdin is the pipe, not the shell's: man sudo, both entries, "If a command is
// specified, it is passed to the shell as a simple command using the -c option." So the walk continues from
// that word exactly as it would without the flag (curl url | sudo -s sh is caught by the verb; curl url |
// sudo -s tee f is null - see scanSudoOptions, called from matchesShellWords's sudo branch).
//
// sudo's getopt string (src/parse_args.c, tag v1.9.17p2: "+Aa:BbC:c:D:Eeg:Hh::iKklNnPp:R:r:SsT:t:U:u:Vv") takes
// no argument for s or i, so in a cluster (sudo -Es, -su, -sh, -Ei, ...) the letters are read left to right and
// s/i is looked for only among the letters BEFORE the cluster's first argument-taking letter (all letters when
// there is none): a letter after that point belongs to the argument-taking flag's value, not to the shell
// decision (sudo -us: u is first and argument-taking, so its attached value "s" is the username, not a shell
// flag - the walk continues to whatever follows, unaffected; sudo -su: s comes first, so it marks the stage,
// and the trailing u takes "sh" as its argument, an over-deny per below). Flags keep their case throughout this
// module (see basenameOf's comment): -S (capital, --stdin, read the sudo password from stdin) is unrelated and
// never marks the stage.
//
// Two corrections from the research note, both over-deny (the safe side, as elsewhere in this module: a form
// nobody's real sudo would run this way just costs a needless block):
//   - real `sudo -sh sh` prints usage and runs nothing: sudo's getopt entry for -h is `h::`, an OPTIONAL
//     ATTACHED value only, so inside a cluster -h consumes nothing from the next word at all - it just sets
//     help mode (the separate "-h HOST" meaning "the target host" applies only when the whole token is exactly
//     "-h", per parse_args.c's got_host_flag macro, which a cluster like "-sh" never satisfies). With -s already
//     setting MODE_SHELL, parse_args.c's mode-vs-valid_flags check then fails against the help mode -h set, so
//     real sudo calls usage() and runs nothing. Consuming the next word ("sh") as -h's argument is THIS
//     MODULE's own model of -h, not sudo's - SUDO_ARG_FLAGS treats -h as --host, taking a separate token, the
//     way most of sudo's other argument flags work. So this module still marks curl url | sudo -sh sh as a
//     shell stage: telling the help-mode case apart needs modelling got_host_flag itself, which this card's
//     goal doesn't ask for.
//   - real sudo rejects -i combined with -s or -E ("you may not specify both the -i and -s/-E options" -
//     parse_args.c). This module still marks curl url | sudo -Ei and friends.
const SUDO_ARG_FLAGS = new Set([
  "-u", "-g", "-h", "-p", "-C", "-D", "-R", "-r", "-t", "-T", "-U",
  "--user", "--group", "--host", "--prompt", "--close-from", "--chdir", "--chroot", "--role", "--type",
  "--command-timeout", "--other-user",
]);

// env flags that consume a separate following token as their argument (GNU env). -a/--argv0, --block-signal,
// --default-signal, and --ignore-signal also accept an attached "=value" form, which the "--long=value" branch
// below already handles by consuming the token whole - fine for these, since only env itself needs the value.
// -S/--split-string is the exception: it accepts the same attached "=value" form (and its own attached short
// form, "-Svalue"), but its value is a command line, not a plain argument, so it is examined rather than merely
// consumed - and only actually consumed (as env's command) when it's a non-empty, non-option word; otherwise
// env keeps parsing options from there - see scanEnvOptions. -i, -0, -v, --ignore-environment, --null, --debug
// take no argument.
const ENV_ARG_FLAGS = new Set([
  "-u", "--unset", "-C", "--chdir", "-S", "--split-string",
  "-a", "--argv0", "--block-signal", "--default-signal", "--ignore-signal",
]);

// nice: -n/--adjustment take the next token as the adjustment value; a bare "-10"-style legacy adjustment is
// not in this set, so it falls to skipPrefixOptions's generic "skip just itself" branch.
const NICE_ARG_FLAGS = new Set(["-n", "--adjustment"]);

// time: -f/-o/--format/--output take the next token; -p/-a/-v (not listed here) take none, so they fall to
// skipPrefixOptions's generic no-argument branch.
const TIME_ARG_FLAGS = new Set(["-f", "-o", "--format", "--output"]);

// exec: -a takes the next token (sets argv0); -c/-l (not listed here) take none.
const EXEC_ARG_FLAGS = new Set(["-a"]);

// nohup and busybox take no flags worth modelling; empty sets keep them the same shape as every other prefix
// (every "-"-prefixed token they meet falls to skipPrefixOptions's generic "skip just itself" branch).
const NOHUP_ARG_FLAGS = new Set([]);
const BUSYBOX_ARG_FLAGS = new Set([]);

// Card bash-rules-shell-verb-case: the basename is lower-cased before every comparison against SHELL_VERBS or a
// prefix name, because macOS's default case-insensitive filesystem resolves SH to /bin/sh and would run the
// download; on a case-sensitive filesystem this only over-denies a name that wouldn't resolve there anyway (no
// SH binary), the safe side. Only the basename is lower-cased here - flags (env's -S/-s, command's -v/-V, ...)
// keep their case and are compared exactly as written, everywhere else in this module.
function basenameOf(tok) {
  return tok.slice(tok.lastIndexOf("/") + 1).toLowerCase(); // matches an absolute path (/bin/sh, /usr/bin/env) by its tail
}

// Card bash-rules-combined-short-flags: a "cluster" is a single-dash token of two or more letters (bash's
// exec -cla NAME, BSD time -po FILE, sudo -Eu root, env -iu PATH). `--long`, `--long=value`, `--`, a lone
// `-x`, a legacy numeric adjustment (nice's -10, -n5), and an attached env -S value (-Ssh: a leading S, not a
// cluster with S found partway through) are not clusters here and keep their existing handling elsewhere.
// getopt reads a cluster letter by letter, left to right, against the wrapper's argument-flag set (each
// letter L looked up as "-L"): the FIRST letter found in the set decides - if it's the LAST letter, the
// cluster consumes the next token as that flag's argument (-Eu root, -la NAME, -po FILE, -iu PATH); otherwise
// the rest of the token is that flag's attached value and the cluster is self-contained (-uroot, -fo where o
// is f's value). No letter in the set (every letter a no-argument flag) is self-contained too - both
// self-contained cases fall to the caller's existing generic "skip just itself" branch, unchanged.
//
// One helper, used from both skipPrefixOptions and scanEnvOptions. scanEnvOptions needs more than a yes/no:
// its -S/--split-string letter is terminal (the value is a command line, not a plain argument - see
// scanEnvOptions), so this returns the matched letter and the token's remainder after it (the attached value
// when the letter isn't last), not just whether the next token is consumed. Returns null when tok isn't a
// cluster, or is one with no letter in argFlags (both self-contained).
const CLUSTER_RE = /^-[A-Za-z]{2,}$/;
function clusterFlag(tok, argFlags) {
  if (!CLUSTER_RE.test(tok)) return null;
  const letters = tok.slice(1);
  for (let j = 0; j < letters.length; j += 1) {
    if (argFlags.has("-" + letters[j])) {
      return { letter: letters[j], last: j === letters.length - 1, rest: letters.slice(j + 1) };
    }
  }
  return null;
}

// Walks an option run starting at i for a prefix command with no special-value flag of its own to track (nice,
// time, nohup, exec, busybox - each calls this directly): "--" ends the options (consuming itself),
// "--long=value" is one token, a flag in argFlags consumes a separate following token, a combined short-flag
// cluster ending in an argument-taking letter consumes a separate following token too (see clusterFlag), and
// any other "-"-prefixed token consumes just itself. sudo and env share this same option shape but each needs
// its own extra tracking on top of it (sudo's -s/-i/--shell/--login mark the whole stage a shell stage, env's
// -S/--split-string value can itself be the command), so each walks its options with its own function built on
// these rules - scanSudoOptions and scanEnvOptions - rather than calling this one directly.
// Returns the index just past the options, i.e. where the next prefix token or the verb starts.
function skipPrefixOptions(w, i, argFlags, onArgFlag) {
  while (i < w.length) {
    const tok = w[i];
    if (tok === "--") {
      i += 1;
      break;
    }
    if (!tok.startsWith("-")) break; // not an option token: an env assignment, another prefix, or the verb
    if (tok.includes("=")) {
      i += 1; // "--long=value" is one token
      continue;
    }
    if (argFlags.has(tok)) {
      if (onArgFlag) onArgFlag(tok, w[i + 1]);
      i += 2; // flag + its separate-token argument
      continue;
    }
    const cluster = clusterFlag(tok, argFlags);
    if (cluster && cluster.last) {
      if (onArgFlag) onArgFlag(tok, w[i + 1]);
      i += 2; // cluster + its separate-token argument (matched letter is last: exec -la NAME, sudo -Eu root)
      continue;
    }
    i += 1; // flag that takes no argument (e.g. -E, -i), or a self-contained cluster (-uroot, -fo)
  }
  return i;
}

// Walks an env prefix's option run starting at i (just past "env"/"/usr/bin/env"). Unlike skipPrefixOptions
// (used for nice, time, nohup, exec, and busybox, none of which have such a flag) or scanSudoOptions (sudo has
// no split-string-like flag either), this gives -S/--split-string - in any spelling: separate token
// "-S value", attached "-Svalue", or attached "--split-string=value" - special handling: real env treats the
// value as the command to run only when it is a non-empty word that doesn't itself start with "-" (env -S -i
// echo HIT runs "echo", not "-i"); when it qualifies, that value is env's command, so it (and everything after
// it) is handed back to the prefix walk to decide - a wrapper value (sudo, nice, nohup, exec, time, command,
// busybox, env, or an env assignment) walks its own branch there, and a plain word is matched by basename
// exactly as before. For the separate-token form the value is already its own token, so this returns { next }
// pointing at it and lets matchesShellWords's loop continue from there. For an attached form (whose value can't
// be pulled back out as its own token) there is no token to point { next } at, so this returns { splice: value,
// next } instead: the caller replaces everything up to `next` with the single token `value` and resumes its own
// loop at index 0 - a rebuild, not a recursive call, so nested attached values (env -Senv -Senv ... sh) cost no
// call-stack depth no matter how many there are. Otherwise (the value is missing, empty, or itself option-
// shaped) it isn't the command, so env keeps parsing options from there: for the separate-token form the walk
// re-examines that same value token as the next option (advancing by 1, not 2, past just the flag), and for an
// attached form the walk simply moves past that one token, as it would past any other no-argument flag. Returns
// { splice, next } when an attached form's value qualifies as the command, or { next } with the index of the
// value (when it qualifies, separate-token form) or of the first non-option token (the next prefix or the verb)
// otherwise.
function scanEnvOptions(w, i) {
  while (i < w.length) {
    const tok = w[i];
    if (tok === "-S" || tok === "--split-string") {
      const value = w[i + 1];
      if (value && !value.startsWith("-")) return { next: i + 1 };
      i += 1; // not the command: re-scan the value token itself (or, if there is none, the walk just ends)
      continue;
    }
    const attached = /^-S(.+)$/.exec(tok) || /^--split-string=(.*)$/.exec(tok);
    if (attached) {
      const value = attached[1];
      if (value && !value.startsWith("-")) return { splice: value, next: i + 1 };
      i += 1; // not the command: this token carried no other option to re-scan, so it's simply skipped
      continue;
    }
    if (tok === "--") return { next: i + 1 };
    if (!tok.startsWith("-")) return { next: i }; // not an option token: an env assignment, another prefix, or the verb
    if (tok.includes("=")) {
      i += 1; // "--long=value" is one token
      continue;
    }
    if (ENV_ARG_FLAGS.has(tok)) {
      i += 2; // flag + its separate-token argument
      continue;
    }
    const cluster = clusterFlag(tok, ENV_ARG_FLAGS);
    if (cluster && cluster.letter === "S") {
      // S is the first set-letter in the cluster (e.g. -iS, -iSsh): the same split-string value rule applies,
      // to the next token when S is last (env -iS sh) or to the token's remainder when it isn't (env -iSsh).
      // S-last is the separate-token case (the value is w[i + 1], its own token); S-mid-token is the attached
      // case (the value is the cluster's remainder, not its own token), so it splices the same as -Svalue.
      if (cluster.last) {
        const value = w[i + 1];
        if (value && !value.startsWith("-")) return { next: i + 1 };
        i += 1; // not the command: re-scan the next token
        continue;
      }
      const value = cluster.rest;
      if (value && !value.startsWith("-")) return { splice: value, next: i + 1 };
      i += 1; // not the command: move past this token
      continue;
    }
    if (cluster && cluster.last) {
      i += 2; // cluster + its separate-token argument (matched letter is last: env -iu PATH)
      continue;
    }
    i += 1; // flag that takes no argument (e.g. -i), or a self-contained cluster
  }
  return { next: i };
}

// Walks a "command" prefix's option run starting at i (just past "command"/basename "command"). Unlike every
// other prefix in this module, "command" has no flag that consumes a following token, but "-v" and "-V" are
// terminal rather than merely argument-free: real command -v NAME and command -V NAME print information and
// run NOTHING, so meeting either ends the walk right there - the result is "not a shell stage" regardless of
// what follows, including a real shell verb (command -v sh prints a path, it doesn't run one). "-p" takes no
// argument and is walked like any other no-argument flag; combined short forms (e.g. "-pv") are not modelled.
// Returns { shell: false } when it stopped on -v/-V, or { next } with the index of the first non-option token
// (the next prefix or the verb) otherwise.
function scanCommandOptions(w, i) {
  while (i < w.length) {
    const tok = w[i];
    if (tok === "-v" || tok === "-V") return { shell: false };
    if (tok === "--") {
      i += 1;
      break;
    }
    if (!tok.startsWith("-")) break; // not an option token: another prefix, or the verb
    if (tok.includes("=")) {
      i += 1; // "--long=value" is one token
      continue;
    }
    i += 1; // "-p" or any other no-argument flag
  }
  return { next: i };
}

// Card bash-rules-sudo-shell-flags: walks sudo's option run starting at i (just past "sudo"/basename "sudo"),
// modelled on scanCommandOptions. Uses the same rules as skipPrefixOptions ("--" ends the options, consuming
// itself; "--long=value" is one token; a flag in SUDO_ARG_FLAGS or a cluster ending in one consumes a separate
// following token, via clusterFlag; any other "-"-prefixed token consumes just itself), so sudo's argument
// flags (-u root, --user=root, a cluster like -Eu root, ...) are skipped exactly as before. Additionally tracks
// whether the stage is shell-flagged: -s, -i, --shell, --login, or (for a cluster) a letter "s" or "i" found
// among the letters before the cluster's first argument-taking letter (all letters when there is none) - see
// the SUDO_ARG_FLAGS comment for the getopt-order reasoning and its two over-deny corrections. Returns
// { next, shell }: { next } is the index just past the options (where the next prefix token, an env assignment,
// or the candidate verb starts), and { shell } is true iff a shell flag was met anywhere in the run - the caller
// (matchesShellWords's sudo branch) still has to check whether anything but env assignments remains at `next`
// before deciding the stage is a shell stage outright, since a command word there is that command's stdin
// instead (curl url | sudo -s tee f), not the shell's.
function scanSudoOptions(w, i) {
  let shell = false;
  while (i < w.length) {
    const tok = w[i];
    if (tok === "--") {
      i += 1;
      break;
    }
    if (!tok.startsWith("-")) break; // not an option token: an env assignment, another prefix, or the verb
    if (tok === "--shell" || tok === "--login") {
      shell = true;
      i += 1;
      continue;
    }
    if (tok.includes("=")) {
      i += 1; // "--long=value" (e.g. --user=root) - not a shell flag
      continue;
    }
    if (tok === "-s" || tok === "-i") {
      shell = true;
      i += 1;
      continue;
    }
    if (SUDO_ARG_FLAGS.has(tok)) {
      i += 2; // flag + its separate-token argument
      continue;
    }
    const cluster = clusterFlag(tok, SUDO_ARG_FLAGS);
    if (CLUSTER_RE.test(tok)) {
      const letters = tok.slice(1);
      // The letters before the cluster's first argument-taking letter (clusterFlag found it, if any): that
      // letter's own value (attached, or the next token) is not examined, per the getopt-order reasoning above.
      // No argument-taking letter at all (cluster === null) means every letter is examined.
      const prefix = cluster ? letters.slice(0, letters.length - cluster.rest.length - 1) : letters;
      if (prefix.includes("s") || prefix.includes("i")) shell = true;
      if (cluster && cluster.last) {
        i += 2; // cluster + its separate-token argument (matched letter is last: sudo -Eu root, -sh sh)
        continue;
      }
      i += 1; // self-contained: no argument-taking letter, or its value is attached (sudo -uroot, -us)
      continue;
    }
    i += 1; // flag that takes no argument (e.g. -E, -H), or a bare -S (--stdin; too short to be a cluster)
  }
  return { next: i, shell };
}

// Card bash-rules-normalise-match-text: recognises ONE redirection word - an operator (optionally preceded by a
// bare fd number, e.g. "2>", and optionally combined with an attached target with no space, e.g. ">f",
// "2>/dev/null") - checked once per iteration inside resolveVerb's own loop (below), so a redirection is dropped
// whether it's the very first token or sits between two already-resolved prefixes; by the time resolveVerb
// returns, `w.slice(i)` never starts with one, which is what lets normalizedForms (further down) skip repeating
// this same walk (round 3, reviewer M2a - see its own comment). Returns 0 (not a redirection at all), 1 (the
// word IS the redirection, target attached or none needed), or 2 (the word is a BARE operator whose target is
// the following, separate word - "> f", "&> f" - which real shells read as this operator's target, never as a
// prefix name or the verb, so it's consumed too).
const LEADING_REDIR_RE = /^\d*(&>>|&>|>>|<>|>&|<&|>|<)(.*)$/;
function redirWordSpan(tok) {
  const m = LEADING_REDIR_RE.exec(tok);
  if (!m) return 0;
  return m[2] === "" ? 2 : 1;
}

// Walks a stage's already-split words from index i, resolving prefixes (env assignments, sudo, env, nice,
// time, nohup, exec, command, busybox) until it lands on the candidate verb. Split out of matchesShellStage so
// scanEnvOptions can hand an -S/--split-string value back into this same walk when that value qualifies as
// env's command. That handoff is a rebuild of `w`, not a recursive call (see the "splice" case below): every
// handoff replaces one or more consumed tokens with the single value token, so `w` strictly shrinks by at least
// one token each time, and the loop below runs no deeper than one stack frame no matter how many wrappers are
// nested (env -Senv -Senv ... sh).
// Card bash-rules-prefixed-commands: also shared with commandForms, which needs the resolved word array and
// verb index (not just a shell/not-shell verdict), so the walk itself no longer decides an outcome - it returns
// { w, i } once it lands on a candidate verb (i may be w.length when nothing followed the prefixes), or
// { terminal } when a prefix's own option decided the outcome without a verb: "shell" for a sudo stage flagged
// -s/-i/--shell/--login with nothing but env assignments left after it (sudo execs the shell directly, see the
// scanSudoOptions call below), or "notShell" for command -v/-V (which prints and runs nothing - see
// scanCommandOptions). matchesShellWords below turns that into its verb-or-terminal verdict unchanged.
//
// Card bash-rules-normalise-match-text (round 2): two things are resolved INSIDE this walk, not just once at
// its call site, because a redirection or a resolved prefix can each put the NEXT thing this loop needs to
// recognise out of a plain, exact-text match's reach, and either can recur (a redirection can sit ahead of a
// prefix, a prefix can consume it and leave another redirection ahead of the verb - `> f sudo rm -rf ~` and
// `sudo > f rm -rf ~` are both real spellings a real shell runs the same way):
//   - a leading redirection word (redirWordSpan, below) is skipped at the TOP of every iteration, before this
//     token is looked at as anything else - so it's dropped whether it sits before the very first prefix or
//     between two already-resolved ones, not merely once at the start.
//   - `base`/`isBase` (the name this loop compares against "sudo"/"env"/.../ENV_ASSIGN) is read from the
//     token's DEQUOTED text, not its raw text - a quote or a backslash in front of a prefix name ("'sudo'" rm
//     -rf ~, \env FOO=1 sh) must not defeat an exact-string comparison any more than it would defeat a real
//     shell's own lookup of the binary. Only the NAME is dequoted here: every argument-flag set this loop's
//     helpers match below (SUDO_ARG_FLAGS, ENV_ARG_FLAGS, a "--long=value", a cluster via clusterFlag, ...)
//     still reads the RAW token, unchanged - a quoted FLAG is out of this card's scope, and dequoting it too
//     would risk changing which flag a cluster or an attached form is read as, for no fixture that needs it.
//     The returned `{w, i}` itself is unaffected by this: `w` is still the array the caller passed in (or
//     resolveVerb's own env-splice rebuild, unrelated to this round), and `i` is just an index into it - the
//     caller (isShellVerb by way of commandForms/matchesShellWords) dequotes `w[i]` itself before comparing it
//     against a shell name, the same way this loop now does for a prefix name.
//
// Round 3 (tester's live probes P3 `$'s\h' -c ...` and P4 `$'sud\o' rm -rf ~`, both confirmed real in zsh 5.9
// only - bash 3.2.57's ANSI-C reading of an unrecognised escape keeps the backslash, so "s\h"/"sud\o" stay
// non-matching text there, but zsh's reading drops it, resolving to the real "sh"/"sudo"): `isBase` checks the
// token's name against BOTH readings (dequoteScript's "bash" and "zsh" - see its own comment for why they can
// differ), not bash alone, and recognises the prefix (or, at the caller, the shell verb) when EITHER one
// matches - a spelling only one real shell's ANSI-C reading resolves to a real prefix/verb name is still a real
// spelling that shell truly runs, so missing it because the OTHER reading didn't resolve would be losing a
// deny, the one thing this module never does. Only ONE walk still happens, though: which reading matched is
// never examined past this check, because nothing downstream (SUDO_ARG_FLAGS, a cluster, findScriptCandidates,
// ...) reads the prefix/verb token's text again - everything after it operates on the RAW words that follow,
// unaffected by which reading recognised the name in front of them.
function resolveVerb(w, i) {
  while (i < w.length) {
    const tok = w[i];
    const span = redirWordSpan(tok);
    if (span) {
      i += span; // a leading redirection (and its own separate-word target, when it has one): never the verb
      continue;
    }
    const dqBash = dequoteScript(tok, "bash");
    const dqZsh = dequoteScript(tok, "zsh");
    const baseBash = basenameOf(dqBash);
    const baseZsh = basenameOf(dqZsh);
    const isBase = (name) => baseBash === name || baseZsh === name;
    if (ENV_ASSIGN.test(dqBash) || ENV_ASSIGN.test(dqZsh)) {
      i += 1; // FOO=1, in any position, any number of times
      continue;
    }
    if (isBase("sudo")) {
      const result = scanSudoOptions(w, i + 1);
      // Card bash-rules-sudo-shell-flags: a shell flag (see scanSudoOptions) makes the stage a shell stage
      // outright ONLY when nothing but env assignments (sudo sets these, it doesn't run them) is left after
      // sudo's options - a real command word there is that command's stdin instead, so the walk continues from
      // it exactly as today (the loop below, on the next iteration, matches it as a verb, another prefix, or
      // nothing left). Skipping assignments here (rather than relying on the loop's own ENV_ASSIGN check on its
      // next iteration) is what lets "shell flag, then only assignments, then nothing" resolve to true instead
      // of falling through to "no verb found" -> false.
      let j = result.next;
      while (j < w.length && ENV_ASSIGN.test(w[j])) j += 1;
      if (result.shell && j >= w.length) return { terminal: "shell" };
      i = result.next;
      continue;
    }
    if (isBase("env")) {
      const result = scanEnvOptions(w, i + 1);
      if ("splice" in result) {
        // An attached -S/--split-string value qualified as env's command: rebuild the word array with that
        // value as the new first word, followed by whatever came after it, and resume this same loop at 0 -
        // no recursive call, so this is safe no matter how many attached values are nested.
        w = [result.splice, ...w.slice(result.next)];
        i = 0;
        continue;
      }
      i = result.next; // separate-token -S/--split-string value, or no qualifying value: continue the walk
      continue;
    }
    if (isBase("nice")) {
      i = skipPrefixOptions(w, i + 1, NICE_ARG_FLAGS);
      continue;
    }
    if (isBase("time")) {
      i = skipPrefixOptions(w, i + 1, TIME_ARG_FLAGS);
      continue;
    }
    if (isBase("nohup")) {
      i = skipPrefixOptions(w, i + 1, NOHUP_ARG_FLAGS);
      continue;
    }
    if (isBase("exec")) {
      i = skipPrefixOptions(w, i + 1, EXEC_ARG_FLAGS);
      continue;
    }
    if (isBase("command")) {
      const result = scanCommandOptions(w, i + 1);
      if ("shell" in result) return { terminal: "notShell" }; // -v/-V: terminal, see scanCommandOptions
      i = result.next;
      continue;
    }
    if (isBase("busybox")) {
      i = skipPrefixOptions(w, i + 1, BUSYBOX_ARG_FLAGS);
      continue;
    }
    break; // none of the above: this token is the candidate verb
  }
  return { w, i };
}

// Thin wrapper over resolveVerb's walk: true for a sudo stage terminal-flagged as a shell, false for a
// command -v/-V terminal, and otherwise whether the resolved verb's basename is a shell. Unchanged behavior
// from before the card bash-rules-prefixed-commands split.
function matchesShellWords(w, i) {
  const r = resolveVerb(w, i);
  if (r.terminal === "shell") return true;
  if (r.terminal === "notShell") return false;
  const verb = r.w[r.i];
  if (!verb) return false;
  return isShellVerb(basenameOf(verb));
}

function matchesShellStage(stage) {
  return matchesShellWords(words(stage), 0);
}

// Review round 5: "&" joins GROUP_SEPS (a real shell ends the command before it, and starts a new job - a
// separate group, no different from ";" for this purpose) but NOT STAGE_SEPS (it never appears usefully inside
// an already-open pipeline: a "|" or "|&" always ends a stage before any "&" would be reachable there). "|&"
// joins STAGE_SEPS (bash's stderr-merging pipe connector, a stage boundary like "|") but NOT GROUP_SEPS (it is
// part of one pipeline, not a group ender) - see scanTop's comment for the "|&" reasoning and the HEAD-parity
// check for `curl url |& sh`.
const GROUP_SEPS = new Set(["&&", "||", ";", "&", "\n"]);
const STAGE_SEPS = new Set(["|", "|&"]);
const PIPE_REASON =
  "Blocked: piping a download into a shell runs unreviewed remote code. Download to a file, read it, then run it. If the user wants this, they can run it themselves or disable bash.denyDestructive in .doug/config.json.";

// Card bash-rules-quote-aware-split: one group's stages, quote-aware (a bare "|" inside a quoted argument - an
// unrelated echo, a URL's own ";" or "|" - is never mistaken for a pipe stage boundary, Q12; bash's "|&" is one
// stage boundary, not "|" plus a stray "&" - review round 5). Falls back to the old quote-blind split on an
// unterminated quote, same as splitCommands.
function pipeStages(group) {
  const cut = cutOnSeparators(group, STAGE_SEPS);
  if (cut) return cut.pieces;
  return group.split(/\s*\|\s*/).map((s) => s.trim()).filter(Boolean);
}

// Card bash-rules-quote-aware-split: the group/stage analysis for one command string - quote-aware groups at
// &&, ||, ;, a bare "&", and newline (a bare "|" or "|&" is not a group separator - Q12, review round 5), each
// group's stages at "|" or "|&" (pipeStages above) - and, design point 5, recursion into every substitution
// body's own groups too, so a curl|sh chain hidden inside a "$(...)" or backtick is still caught. Because
// scanTop finds a substitution wherever it sits - inside an ordinary quoted argument or inside what looks like
// inert text such as a heredoc body (heredocs carry no state of their own here, a known limit) - a "$(... curl
// ... | sh)" written inside either is still denied even where a real shell would just treat it as literal
// text: an over-denial on the safe side, not a miss. Falls back to the old quote-blind group split (unchanged -
// review round 5 did not extend this fallback regex to "&"/"|&", see the coder's report) on an unterminated
// quote.
function checkPipeGroups(str) {
  const cut = cutOnSeparators(str, GROUP_SEPS);
  const groups = cut ? cut.pieces : str.split(/\s*(?:&&|\|\||;)\s*|\n/).map((s) => s.trim()).filter(Boolean);
  const subs = cut ? cut.subs : [];
  for (const group of groups) {
    const stages = pipeStages(group);
    if (stages.length < 2) continue;
    if (!/^(curl|wget)\b/.test(stages[0])) continue;
    if (stages.slice(1).some((s) => matchesShellStage(s))) return PIPE_REASON;
  }
  for (const body of subs) {
    const reason = checkPipeGroups(body);
    if (reason) return reason;
  }
  return null;
}

export function checkPipeToShell(command) {
  try {
    // A newline directly after a "|" (optional trailing spaces before it, blank lines, CRLF, and leading spaces
    // on the next non-blank line) is a shell line continuation, not a command separator - collapse it so the
    // pipeline stays one group.
    const collapsed = String(command).replace(/\|[ \t]*(?:\r?\n[ \t]*)+/g, "| ");
    return checkPipeGroups(collapsed);
  } catch {
    return null;
  }
}

// A hard reset on the current branch when that branch is protected: rewrites local history the team relies
// on being stable. Null when the branch isn't protected, or is unknown (no git repo, detached HEAD, etc.).
export function checkResetHardOnProtected(cmd, protectedBranches, currentBranch) {
  if (!/^git\s+reset\s+--hard\b/.test(normalizeGit(cmd))) return null;
  if (!currentBranch || !protectedBranches.includes(currentBranch)) return null;
  return `git reset --hard on "${currentBranch}" rewrites the protected branch's local history. Reset on a feature branch, or ask the user.`;
}

// Card bash-rules-quote-aware-split: commandForms's own word split - quote-aware (design point 6), unlike the
// plain `words` above, so the prefix forms it joins back are character-for-character what they are today for
// already-passing inputs (a dequoted join would turn env git commit -m "x --no-verify y" into a false deny).
// Built on the same shared scanner (scanTop) as splitCommands and checkPipeToShell; falls back to the old
// quote-blind whitespace split on an unterminated quote.
function wordsQ(cmd) {
  const str = String(cmd);
  const scanned = scanTop(str);
  if (!scanned) return str.split(/\s+/).filter(Boolean);
  const out = [];
  let start = 0;
  for (const gap of scanned.spaces) {
    if (gap.start > start) out.push(str.slice(start, gap.start));
    start = gap.end;
  }
  if (start < str.length) out.push(str.slice(start));
  return out;
}

// Card bash-rules-quote-aware-split, design point 6: finds which word(s) after a shell verb are candidate -c
// scripts (research Q2). Walks the option run starting just after the verb (index i): "--" and zsh's
// end-of-options markers "-", "+", "+-" are consumed and never mistaken for the script itself; "--rcfile",
// "--init-file", and zsh's "--emulate" (like -o/-O) consume the next word as their own separate-token argument;
// any other long option ("--login", "--norc", an attached "--rcfile=x", ...) consumes only itself; a
// single-dash-or-plus, letters-only cluster (this subsumes the bare "-c" token, a one-letter cluster) is read
// left to right: a "c" anywhere in it means a -c form was seen (the walk CONTINUES past it rather than stopping,
// unlike the old code - research Q2.5); an "o" or "O" anywhere in it, if it is the LAST letter, consumes the
// next word as that flag's argument and the walk continues past it too ("-co pipefail" reads "pipefail" as -o's
// argument, not the script - Q9); an "o"/"O" that is present but NOT the last letter is ambiguous about which
// word the shell actually reads next (bash and zsh do not agree here - research Q2.3-4), so BOTH the next word
// and the one after it are returned as candidate scripts, and the walk stops there rather than guessing (Q11:
// checks more, never less). The first token that is none of these ends the option run: that word is the sole
// candidate script, when a -c form was ever seen. Returns { cSeen, candidates }, candidates holding 0, 1, or 2
// indices into w; the caller ignores candidates when cSeen is false (a script FILE with no -c, not modelled).
function findScriptCandidates(w, i) {
  let j = i + 1;
  let cSeen = false;
  while (j < w.length) {
    const tok = w[j];
    if (tok === "--" || tok === "-" || tok === "+" || tok === "+-") { j += 1; continue; }
    if (tok === "--rcfile" || tok === "--init-file" || tok === "--emulate") { j += 2; continue; }
    if (/^--[A-Za-z-]+(=.*)?$/.test(tok)) { j += 1; continue; }
    if (/^[-+][A-Za-z]+$/.test(tok)) {
      const letters = tok.slice(1);
      if (letters.includes("c")) cSeen = true;
      const oIdx = letters.search(/[oO]/);
      if (oIdx === -1) { j += 1; continue; } // no o/O in this cluster: self-contained, itself only
      if (oIdx === letters.length - 1) { j += 2; continue; } // ends in o/O: consumes the next word as its argument
      return { cSeen, candidates: [j + 1, j + 2].filter((k) => k < w.length) }; // mid-cluster o/O: ambiguous (Q11)
    }
    break; // not an option token: the script, when a -c form was seen
  }
  return { cSeen, candidates: cSeen && j < w.length ? [j] : [] };
}

// Card bash-rules-quote-aware-split, design point 6: dequotes ONE candidate script word (only this word is
// dequoted - every other form commandForms builds keeps its raw, quoted text). Walks the word's own quote
// states with the same rules as the shared scanner and builds the literal text a real shell would pass as the
// argument: single-quoted spans verbatim; double-quoted spans with their backslash escapes of $, `, ", \, and a
// line continuation resolved (any other backslash is left as-is, research Q1.2 - S3's FOO=\"a\" case relies on
// this); ANSI-C $'...' spans with \\ and \' resolved the same way in both readings, but an OTHER, unrecognised
// $'...' escape (\;, \|, ...) diverges: bash's real behaviour is to leave both characters as-is (\X stays \X -
// this is the "bash" reading), zsh's is to drop the backslash and keep just the character (X - the "zsh"
// reading) - review round 3, reviewer-measured: `sh -c $'echo <sep> X'` with one backslash before the separator
// runs X under zsh only, three backslashes runs it under bash only, two (round 2's pin e) runs it under
// neither, and a bare separator runs it under both; verified directly against real bash 3.2.57 and zsh 5.9 here
// (files run as `bash file` / `zsh file`, not through this session's own shell, so this reader's own escaping
// never enters it). `reading` selects which; the caller (commandForms) computes both and only runs the second
// one when it differs from the first. Card bash-rules-normalise-match-text closed the gap the paragraph above
// this one used to describe here: an ANSI-C escape that DECODES TO a separator character rather than merely
// losing its backslash - \n (literal backslash-n, two characters), \xHH (one or two hex digits), \NNN (one to
// three octal digits), and (round 3, the tester's live probes P3/P4/P6/P7/P5u; round 4, the reviewer's probes
// P12/P13/P17 corrected the digit count) \uHHHH (one to four hex digits - GNU Bash's own documented shape and
// zsh 5.9's real short-form behaviour, greedy, stopping at the first non-hex character, exactly like \xHH),
// \UHHHHHHHH (one to eight, the same shape), \cX (a control character), and \C-X (round 4: zsh's own spelling of
// the identical control character) - is now decoded to the real byte it names (a real newline for \n;
// String.fromCharCode/fromCodePoint of the hex value for \x/\u/\U; X's own character code XORed with 0x40 for
// \cX and \C-X), so a script hiding a destructive command behind `sh -c $'echo a\x3brm -rf ~'`, `\073`, `;`,
// `\U0000003b` (all four ";"), or `\cJ`/`\C-j` (both a real newline) is caught once the decoded text is
// re-split by splitCommands, the same as a plain, undisguised separator would be. \n, \xHH, and \NNN are
// decoded identically by real bash and real zsh, so decoding them once, unconditionally of `reading`, is simply
// correct for both. \u, \U, \cX, and \C-X are NOT: real bash 3.2.57 predates \U and has no \C- form at all
// (leaves either inert, its literal characters kept) and real zsh 5.9 leaves \cX inert the same way (confirmed
// live, all directions) - but this module decodes ALL EIGHT escapes in BOTH readings regardless, which is still
// the safe direction rather than a claim about either shell's real behaviour: commandForms already runs the
// bash- and zsh-read candidate scripts as separate, independent forms, so a reading a real shell wouldn't
// actually take on THIS card's own escapes is just one more candidate that either matches a row (still a real
// spelling the OTHER shell truly runs, so nothing is over-denied) or doesn't (costs nothing) - it can only ever
// ADD a candidate, never lose the one the reading-specific behaviour would have produced. All eight run before,
// and unconditionally of, the divergent "other, unrecognised escape" branch just below, which is what still
// differs by `reading` - the one place bash and zsh genuinely diverge in a way this module cannot simply decode
// past (see that branch's own comment). \U guards against an invalid code point (a surrogate half, or past
// 0x10FFFF, P15's pin) rather
// than letting String.fromCodePoint throw, falling through to the ordinary fallback on either, per this
// function's never-throws rule. The module still does not reproduce bash/zsh's full C-style escape table (\t,
// \a, \e, and the handful of others neither the tester's probes nor this card's goal named) - decoding one of
// those would cost nothing either way (this module has never been asked whether any of them can decode to a
// separator in some shell, and does not claim to know), so none is added speculatively.
// Double-quoted spans have their backslash escapes of $, `, ", \, and a line continuation resolved (any other
// backslash is left as-is, research Q1.2 - S3's FOO=\"a\" case relies on this); unquoted text unchanged (an
// unquoted backslash still escapes the next character, so \; stays a literal ; - research Q1.3). A "$(...)" or
// backtick substitution's own span is copied through verbatim rather than walked as quotes, the same as the
// shared scanner, since it is independently re-parsed once splitCommands sees the dequoted result. Never
// throws: an unterminated quote just passes the remaining text through unchanged instead of losing it.
function dequoteScript(word, reading = "bash") {
  let out = "";
  let i = 0;
  let state = "top";
  while (i < word.length) {
    const c = word[i];
    if (state === "top" || state === "dquote") {
      if (c === "$" && word[i + 1] === "(") {
        const close = scanParenBody(word, i + 1);
        if (close < 0) return out + word.slice(i);
        out += word.slice(i, close + 1);
        i = close + 1;
        continue;
      }
      if (c === "`") {
        const close = scanBacktickBody(word, i);
        if (close < 0) return out + word.slice(i);
        out += word.slice(i, close + 1);
        i = close + 1;
        continue;
      }
    }
    if (state === "top") {
      if (c === "\\") {
        if (word[i + 1] === "\n") { i += 2; continue; }
        out += word[i + 1] === undefined ? c : word[i + 1];
        i += 2;
        continue;
      }
      if (c === "'") { state = "squote"; i += 1; continue; }
      if (c === '"') { state = "dquote"; i += 1; continue; }
      if (c === "$" && word[i + 1] === "'") { state = "ansic"; i += 2; continue; }
      out += c;
      i += 1;
      continue;
    }
    if (state === "squote") {
      if (c === "'") { state = "top"; i += 1; continue; }
      out += c;
      i += 1;
      continue;
    }
    if (state === "dquote") {
      if (c === "\\" && isDquoteEscapable(word[i + 1])) {
        out += word[i + 1] === "\n" ? "" : word[i + 1];
        i += 2;
        continue;
      }
      if (c === '"') { state = "top"; i += 1; continue; }
      out += c;
      i += 1;
      continue;
    }
    // ansic
    if (c === "\\" && (word[i + 1] === "'" || word[i + 1] === "\\")) { out += word[i + 1]; i += 2; continue; }
    // Card bash-rules-normalise-match-text: \n, \xHH, and \NNN decode to the real byte they name, identically
    // for both readings (see the function comment above) - checked before the divergent fallback below so
    // neither reading's "keep both / drop the backslash" branch ever sees them.
    if (c === "\\" && word[i + 1] === "n") { out += "\n"; i += 2; continue; }
    if (c === "\\" && word[i + 1] === "x") {
      const hex = /^[0-9a-fA-F]{1,2}/.exec(word.slice(i + 2, i + 4));
      if (hex) { out += String.fromCharCode(parseInt(hex[0], 16)); i += 2 + hex[0].length; continue; }
    }
    if (c === "\\" && /^[0-7]/.test(word[i + 1] || "")) {
      const oct = /^[0-7]{1,3}/.exec(word.slice(i + 1, i + 4));
      out += String.fromCharCode(parseInt(oct[0], 8) & 0xff);
      i += 1 + oct[0].length;
      continue;
    }
    // Card bash-rules-normalise-match-text, round 3 (tester's live probes P3/P4/P6/P7/P5u), extended round 4
    // (reviewer probes P12/P13/P17, all confirmed live in real bash 3.2.57 and zsh 5.9, and P12/P13 additionally
    // against the GNU Bash Reference Manual's ANSI-C Quoting section, since a real bash 4.2+ install - this
    // module protects more than just this one test machine's 3.2.57 - reads \u/\U this way too): \uHHHH is ONE
    // TO FOUR hex digits (not a fixed four - round 3's `{4}` under-matched the manual's own documented shape,
    // and zsh 5.9's real short form: \u3b decodes the 2 available digits and stops at the first non-hex
    // character, exactly like \xHH above), \UHHHHHHHH is one to eight the same way (round 3's `{8}` under-matched
    // it identically), \cX is a control character (X's own character code XORed with 0x40, the standard
    // control-character derivation: \cJ -> 'J' 0x4A ^ 0x40 -> 0x0A, a real newline; case-insensitive - bash
    // itself reads \cj and \cJ alike, P16), and \C-X (round 4: zsh's OWN spelling of the identical control
    // character, decoded the same case-insensitive way - \C-j and \cj both give control-J) - all decode
    // identically for BOTH readings, same as \n/\xHH/\NNN above - even though real bash 3.2.57 leaves \U and
    // \C- inert (predates \U; has no \C- form at all) and real zsh 5.9 leaves \cX inert (confirmed live, all
    // three directions), decoding all of them in BOTH readings is the safe direction: this module already runs
    // the bash- and zsh-read candidate scripts as SEPARATE, independent forms (commandForms), so a reading a
    // real shell wouldn't actually take is just an extra candidate that either matches a row (still a real
    // spelling the OTHER shell really runs, so no over-deny of anything safe) or doesn't (costs nothing) - never
    // a way to LOSE a deny the correct, reading-specific behaviour would have caught. \U guards against an
    // invalid code point (a surrogate half, or a value past 0x10FFFF, P15's pin) rather than letting
    // String.fromCodePoint throw - falls through to the ordinary fallback below on either, per this function's
    // never-throws rule; the SAME range check applies whether the greedy {1,8} match consumed one hex digit or
    // eight.
    if (c === "\\" && word[i + 1] === "u") {
      const hex = /^[0-9a-fA-F]{1,4}/.exec(word.slice(i + 2, i + 6));
      if (hex) { out += String.fromCharCode(parseInt(hex[0], 16)); i += 2 + hex[0].length; continue; }
    }
    if (c === "\\" && word[i + 1] === "U") {
      const hex = /^[0-9a-fA-F]{1,8}/.exec(word.slice(i + 2, i + 10));
      if (hex) {
        const cp = parseInt(hex[0], 16);
        if (cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff)) {
          out += String.fromCodePoint(cp);
          i += 2 + hex[0].length;
          continue;
        }
      }
    }
    if (c === "\\" && word[i + 1] === "c" && word[i + 2] !== undefined) {
      out += String.fromCharCode(word[i + 2].toUpperCase().charCodeAt(0) ^ 0x40);
      i += 3;
      continue;
    }
    if (c === "\\" && word[i + 1] === "C" && word[i + 2] === "-" && word[i + 3] !== undefined) {
      out += String.fromCharCode(word[i + 3].toUpperCase().charCodeAt(0) ^ 0x40);
      i += 4;
      continue;
    }
    if (c === "\\" && word[i + 1] !== undefined) {
      // An unrecognised $'...' escape: bash keeps both characters, zsh drops the backslash (see the function
      // comment - this is the one place the two shells' ANSI-C reading diverges).
      out += reading === "zsh" ? word[i + 1] : c + word[i + 1];
      i += 2;
      continue;
    }
    if (c === "'") { state = "top"; i += 1; continue; }
    out += c;
    i += 1;
  }
  return out;
}

// Card bash-rules-quote-aware-split: the strings evaluateBash's five per-command checks (checkNoVerify,
// checkForcePush, checkResetHardOnProtected, checkDestructive, checkPackageManager) run on for one split
// command, since each anchors on the start of the string it's given and so misses a denied command sitting
// behind a resolvable prefix (sudo, an env assignment, env, nice, time, nohup, exec, command, busybox) or a
// shell's -c string. Always includes cmd itself. When resolveVerb's walk consumed or rebuilt anything - i > 0
// (an ordinary prefix was skipped) or the returned word array isn't the one passed in (an attached env
// -S/--split-string value spliced in a new array and reset i to 0 on it, so i > 0 alone missed a denied command
// sitting right behind it, e.g. env -Sgit reset --hard) - also includes the resolved word array from the verb
// onward. When that verb's basename is a shell, findScriptCandidates (above) locates 0, 1, or 2 candidate -c
// script words; each candidate is dequoted (dequoteScript) - the ONLY word this function dequotes - twice, once
// per shell reading (review round 3: bash and zsh decode an unrecognised ANSI-C escape differently, see
// dequoteScript's comment), the second one skipped when it comes out identical to the first (no duplicate
// forms) - the same "more than one candidate when a reading is ambiguous" shape findScriptCandidates already
// uses for a mid-cluster o/O. Each resulting script is re-split at its own top-level separators with the same
// quote-aware splitCommands (this is what keeps "sh -c 'cd x && rm -rf ~'" denied once the top-level split no
// longer cuts inside the quotes - Q8), and each resulting piece is fed back through this same function one
// depth deeper, so a nested shell -c is caught too (bounded at depth 3, not itself a reason to deny). Never
// throws: any unexpected shape just falls back to [cmd].
//
// Card bash-rules-normalise-match-text: every DESTRUCTIVE row, and checkNoVerify, checkForcePush, and
// checkPackageManager, anchor on the raw start of the string they're given (^rm, ^git\s+push\b, ...) - the same
// shape resolveVerb's prefix-walk above works around for sudo/env/... but not for a spelling that puts a quote
// or a redirection in front of the verb itself, or hides the target behind quoting (rm -rf "$HOME", "rm" -rf ~,
// git push --force origin "main") or a leading redirection at the piece's own start (> f rm -rf ~, the split's
// own left-behind ">f"/"2>/dev/null"). Rather than adding a spelling to every row, normalizedForms (below) builds
// ONE further form: dequote every word of the given array (dequoteScript - the same function the -c script path
// above already uses, so a quoted or backslashed verb/target/branch reads exactly as a real shell would pass
// it) and rejoin with single spaces. Word boundaries are kept - dequoting per word, not the whole piece as one
// blob - specifically so a destructive-looking QUOTED ARGUMENT to an unrelated command (echo "rm -rf ~", grep
// 'git reset --hard' f) still can't reach the ^-anchor: the real leading word (echo, grep) stays first in the
// joined text.
//
// Round 2 (reviewer + tester, case 9): round 1 built this from either the WHOLE original word array, or - for a
// resolved prefix's own slice - not at all, so a quote or a redirection in front of the VERB ITSELF ("bash" -c
// ..., \bash -c ..., > f bash -c ..., sudo "rm" -rf ~, env "git" reset --hard, > f sudo rm -rf ~,
// sudo > f rm -rf ~) still slipped past both the shell/-c-script path (isShellVerb never saw the dequoted name)
// and this one (the flat form kept a resolved prefix, or an un-skipped redirection, glued to its front - "sudo
// rm -rf ~" matches no DESTRUCTIVE row any more than "rm -rf ~" behind a real, unresolved "sudo" would). Fixed
// by moving the redirection-skip and the dequote-for-recognition INTO resolveVerb's own walk (see its comment)
// rather than only ever applying them once, outside it, to a word array resolveVerb never re-examines: a
// redirection is now dropped at the TOP of every one of resolveVerb's loop iterations (wherever it sits - the
// front, or between two resolved prefixes), and a prefix name or the final verb is recognised from its DEQUOTED
// text. commandForms (below) now calls normalizedForms on `w.slice(i)` - resolveVerb's OWN resolved slice,
// already past every redirection and prefix - instead of the whole original array, so this form starts exactly
// at the verb regardless of what preceded it. Pushed only when the RESOLVED, DEQUOTED verb is not a shell: a
// shell-invoking form (bash -c ..., sh -c ...) already gets an equivalent, and more precise, normalisation from
// the -c-script extraction below (the script argument is dequoted and re-split on its own, once per recursion
// depth); adding this flat, whole-piece form there too would be a redundant extra form at every depth that
// never changes which check fires - only the form COUNT commandForms returns, which an existing fixture (R2,
// card bash-rules-prefixed-commands) pins exactly - see the coder's report.
//
// Parameter-expansion decision (module comment, this card): $HOME and ${HOME} are matched BY NAME - dequoteScript
// already leaves a bare or quoted $HOME/${HOME} as that literal text (it doesn't look up environment values), so
// no new lookup is added; normalizedForms additionally rewrites ${HOME} to $HOME (one substitution, so the
// existing DESTRUCTIVE row's "\$HOME" alternative - already carrying the "/" and "/*" variants - covers both
// spellings without a second, parallel set of alternatives). Nothing else is resolved: an indirect variable
// (X=~; rm -rf $X), a default-value expansion (${HOME:-/}), or a command substitution's own output are
// explicitly OUT of scope - the guard has no shell to run and so no way to learn what value they would carry
// (case 7, a pin). Over-denials this normalisation introduces, on the safe side per this module's rule (checks
// more, never less): a lone quoted word run as a command name now denies if its dequoted text matches a row
// ("rm -rf ~" typed as one quoted argument to nothing, an edge no real script writes); a resolved prefix's own
// name or a redirection is never mistaken for a check target, only ever skipped; and, as in commandForms's own
// -c-script forms, this doubles as a bash and a zsh reading (kept as two forms only when they differ) - see
// normalizedForms. Two more, round 3: `"FOO=1" rm -rf ~` - resolveVerb's ENV_ASSIGN check (see its comment) now
// matches the token's DEQUOTED text, so a QUOTED assignment word is skipped as if it were the unquoted form,
// even though quoting it actually defeats a real shell's own assignment-word recognition (a real shell tries to
// run a program literally named `FOO=1` instead, `rm -rf ~` never becoming its own command at all) - denied here
// regardless, since telling that apart would mean tracking which characters of the token were originally
// quoted, which this walk does not do. `git commit -m '--no-verify'` (pinned in the test file as P11) - the
// commit MESSAGE, not the flag, but normalizedForms's dequoting strips the surrounding quotes from -m's
// argument, leaving a real whitespace boundary around the text "--no-verify" that checkNoVerify's own
// whitespace-bounded regex cannot tell from the real flag.
//
// Round 3 (reviewer M2a): normalizedForms used to call its own stripLeadingRedirections on `w` first, but by the
// time commandForms calls normalizedForms(w.slice(i)), resolveVerb's walk (above) has ALREADY skipped every
// redirection ahead of the verb - unconditionally, on every iteration, regardless of what recognised the
// verb - so that call was always a no-op (span 0 on the first word) on every input commandForms actually passes.
// Removed rather than kept as dead insurance: this module already used redirWordSpan directly wherever a
// redirection actually needs skipping (resolveVerb's own loop), and a second, unreachable copy of the same walk
// invited exactly the "is this still needed" question the reviewer asked - answered here by removing it, not by
// leaving a comment promising it was harmless.
function normalizedForms(w) {
  if (w.length === 0) return [];
  const build = (reading) => w.map((t) => dequoteScript(t, reading).replace(/\$\{HOME\}/g, "$HOME")).join(" ");
  const bash = build("bash");
  const zsh = build("zsh");
  return bash === zsh ? [bash] : [bash, zsh];
}

export function commandForms(cmd, depth = 0) {
  const forms = [cmd];
  try {
    const original = wordsQ(cmd);
    const r = resolveVerb(original, 0);
    if (r.terminal) return forms;
    const { w, i } = r;
    const verb = w[i];
    // Card bash-rules-normalise-match-text, round 2: the verb this loop compares against isShellVerb is
    // DEQUOTED first - a quote or a backslash in front of a real shell name ("bash", 'sh', \bash) must not
    // defeat isShellVerb's exact-name match any more than it defeats a real shell's own lookup of the binary
    // (case 9, round 2's fix; resolveVerb above does the same for a PREFIX name).
    //
    // Round 3 (tester's live probe P3, `$'s\h' -c 'rm -rf ~'`, confirmed real in zsh 5.9 only - bash 3.2.57's
    // ANSI-C reading of the unrecognised \h escape keeps the backslash, "s\h" resolving to nothing real, but
    // zsh's reading drops it, resolving to the real "sh"): round 2's comment here claimed the zsh reading "only
    // matters inside a -c script's own $'...' content, never for a bare verb name" - false, since a bare verb
    // name can itself be a $'...' word, and P3 is exactly that. verbIsShell now checks BOTH readings
    // (dequoteScript "bash" and "zsh"), the same "recognise if EITHER matches" rule resolveVerb's own isBase
    // uses (see its comment) and for the identical reason: a spelling only one real shell's reading resolves to
    // a real shell name is still a real spelling that shell truly runs. verbIsShell is used for BOTH isShellVerb
    // decisions below - whether to push the flat normalised form (this one is for an ORDINARY, non-shell verb
    // only: a shell-invoking form (bash -c ..., sh -c ...) already gets an equivalent, and more precise,
    // normalisation from the -c-script extraction that follows, once per recursion depth down to the same
    // depth-3 cap; adding this flat, whole-piece form there TOO would just be a redundant extra form at every
    // depth - confirmed: it never changes which check fires, only inflates commandForms's own form count, which
    // the depth-cap fixture (R2, card bash-rules-prefixed-commands) pins exactly) - and whether to descend into
    // -c-script extraction at all (which reading recognised the verb is not examined past this point: the
    // script-candidate walk and dequoteScript's own two-reading extraction, right below, are unaffected either
    // way). normalizedForms is built from `w.slice(i)` - resolveVerb's OWN resolved slice, already walked past
    // every redirection and prefix - not the whole original array, so a resolved prefix (sudo, env, ...) or a
    // redirection that used to sit ahead of the verb is never glued to the front of this flat form either
    // (round 2's other half of case 9: sudo "rm" -rf ~, env "git" reset --hard, > f sudo rm -rf ~,
    // sudo > f rm -rf ~).
    const verbIsShell =
      !!verb && (isShellVerb(basenameOf(dequoteScript(verb, "bash"))) || isShellVerb(basenameOf(dequoteScript(verb, "zsh"))));
    if (!verb || !verbIsShell) {
      for (const n of normalizedForms(w.slice(i))) if (!forms.includes(n)) forms.push(n);
    }
    if (i > 0 || w !== original) forms.push(w.slice(i).join(" "));
    if (depth >= 3 || !verb || !verbIsShell) return forms;
    const { cSeen, candidates } = findScriptCandidates(w, i);
    if (!cSeen) return forms;
    for (const idx of candidates) {
      const bashScript = dequoteScript(w[idx], "bash");
      const zshScript = dequoteScript(w[idx], "zsh");
      const scripts = bashScript === zshScript ? [bashScript] : [bashScript, zshScript];
      for (const script of scripts) {
        if (!script) continue;
        for (const piece of splitCommands(script)) {
          forms.push(...commandForms(piece, depth + 1));
        }
      }
    }
    return forms;
  } catch {
    return [cmd];
  }
}

export function checkPackageManager(cmd, expected) {
  if (!expected) return null;
  const m = /^(npm|pnpm|yarn|bun)\s*(.*)$/.exec(cmd);
  if (!m) return null;
  const [, pm, rest] = m;
  if (pm === expected) return null;
  const verb = PM_INSTALL_VERBS[pm];
  if (verb && verb.test(rest.trim())) {
    return `This project uses ${expected}, not ${pm}. Mixing package managers corrupts the lockfile. Use "${expected} ${rest.trim() || "install"}".`;
  }
  return null;
}

export function evaluateBash(command, { config, currentBranch }) {
  const reasons = [];
  // Runs once on the whole command string, before splitCommands, so the pipe relation survives; its reason
  // goes first, ahead of anything the per-command loop below finds.
  if (config.bash.denyDestructive) {
    const pipeReason = checkPipeToShell(command);
    if (pipeReason) reasons.push(pipeReason);
  }
  for (const cmd of splitCommands(command)) {
    // Card bash-rules-prefixed-commands: run the five per-command checks (each anchored on the start of the
    // string it's given) on every form commandForms resolves for this split command - cmd itself, a prefix
    // (sudo, an env assignment, env, nice, ...) resolved away, and a shell's -c string evaluated as its own
    // command - not just cmd. A reason already found on an earlier form is never pushed twice.
    for (const form of commandForms(cmd)) {
      const checks = [];
      if (config.bash.denyNoVerify) checks.push(checkNoVerify(form));
      if (config.bash.denyForcePushTo && config.bash.denyForcePushTo.length) {
        checks.push(checkForcePush(form, config.bash.denyForcePushTo, currentBranch));
        // Independent of denyDestructive: a repository that turns the destructive catalogue off still keeps its
        // protected branches safe from a hard reset.
        checks.push(checkResetHardOnProtected(form, config.bash.denyForcePushTo, currentBranch));
      }
      if (config.bash.denyDestructive) checks.push(checkDestructive(form));
      if (config.bash.packageManagerGuard) checks.push(checkPackageManager(form, config.packageManager));
      for (const r of checks) if (r && !reasons.includes(r)) reasons.push(r);
    }
  }
  return reasons;
}
