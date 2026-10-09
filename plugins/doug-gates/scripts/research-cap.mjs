#!/usr/bin/env node
// PreToolUse (WebFetch|WebSearch|Bash): card research-fetch-cap, extended by card research-cap-bash-fetch.
// Researchers ran unbounded searches and fetches and took a computer down (four of five researchers burned all
// 30 turns fetching and wrote nothing). This caps each subagent's combined WebSearch, WebFetch, and Bash
// curl/wget calls at research.maxFetches (default 6, .doug/config.json), denying the call past the cap and
// telling the agent to write its findings now instead.
//
// Counted from a per-agent counter file, not the run trace: trace.mjs runs as a separate PreToolUse hook on the
// same event, in parallel with this one, so the current call's own trace line may or may not exist yet when
// this hook reads it. A counter file this hook owns and appends to itself has no such race with another hook.
//
// Bash counting (card research-cap-bash-fetch): a Bash command is split into its top-level simple commands by
// this script's own splitTopLevel (quote- and heredoc-aware; see its comment below, round 2) and each split
// command's resolved forms (bash-rules commandForms, which walks past prefixes such as sudo, env, an env
// assignment, and a shell's -c script) are checked for a first word whose basename, lower-cased, is curl or
// wget. A split command counts as one fetch when any of its forms resolves that way; an ordinary Bash command
// with no curl/wget form is never counted and never denied by this hook. This hook now spawns on every
// subagent's and every main-session Bash call, not only its WebFetch/WebSearch calls.
//
// Known limits (round 2, major 2 - measured, not guessed): the cap is a budget nudge for researchers, not a
// security boundary. Not counted at all: xargs curl; a for/while loop body (do curl ...); timeout 10 curl ...;
// eval curl ...; and any other wrapper resolveVerb does not skip (docker run ... curl, ssh host curl); other
// fetchers (gh api, a node -e "fetch(...)" one-liner, python, etc.). Counted although no network call happens:
// curl --version, curl --help. A shell -c script with several curls in it (bash -c 'curl a; curl b') counts
// once, since commandForms reads the whole -c script as one form.
//
// Loopback exemption (card research-cap-localhost, whole-command grammar, fix pass 5): a local model probe is not
// web research, so it is neither counted nor denied. The exemption applies only when the entire raw command
// string, before any splitting, is ONE simple fetch (isLoopbackFetch):
//   1. Trimmed, it tokenizes into words. Single quotes are literal; double quotes may not hold $, a backtick, a
//      backslash or !; an unterminated quote is not exempt. Outside quotes only space, tab, [A-Za-z0-9._:/=@%+,-]
//      and a redirect's > are allowed, so & | ; ( ) { } [ ] * ? ~ # $ ` \ ! < and a newline are never exempt.
//   2. The first word is exactly curl or wget: no path, wrapper, assignment or other case.
//   3. Every other word is an allowlisted option (value-less -s -S -f -L -i -v -g or --silent and similar,
//      combinable in one short token; value-taking -o -H -d -X -w -m for curl, -O -T and --header for wget,
//      whose value is any word and is never URL-checked), a redirect, or a loopback URL: host exactly localhost,
//      127.0.0.1 or [::1] with an optional scheme and port, matched whole (localhost.evil.com, localhost@evil.com
//      and 127.0.0.1.nip.io are remote). [::1] is a glob unquoted, so it is exempt only inside quotes. At least
//      one loopback URL is required; there is no other positional word.
//   4. A redirect is only >, >> or 2>, attached to or followed by one unquoted, charset-clean target that is
//      exactly /dev/null or does not start with /dev/ (bash opens /dev/tcp and /dev/udp as sockets).
// A command outside the grammar is not an error: it is counted by bashFetchVerbs exactly as at HEAD, one count
// per split command whose first resolved fetch form is curl or wget. Only Bash curl/wget is affected; WebFetch
// and WebSearch always count. Anything doubtful counts: a compound line, a pipe, a wrapper, a mixed local and
// remote command, no URL such as curl --version, other 127.x addresses, 0.0.0.0, host.docker.internal.
// Accepted limits of the exemption: an env proxy (https_proxy=http://evil.com in the environment, not on the
// command) routes the request out; -L, and wget by default, follow a redirect a local server can point at a
// remote host; a ~/.curlrc or ~/.wgetrc can add a URL or a proxy.
//
// Known limit: several calls issued in one message can each read the same count before any of them appends, so
// a single burst can push an agent's count past the cap by the number of calls it issues at once.
//
// Known limits (round 2 reviewer, measured against this script): splitTopLevel tracks quotes and heredocs only,
// so it still miscounts (a false count, and a false denial at the cap) text after an unquoted "#" comment that
// contains a separator and the verb (`ls -la # see notes; curl https://x` counts one; `curl https://x # note;
// wget y` counts two), an ANSI-C quoted string (`echo $'it\'s; curl x'`), and a backslash line-continuation
// whose next line begins with the bare verb. A shell -c script is seen only when the fetch is its first
// command: `bash -c 'curl a; curl b'` counts one, `bash -c "echo hi; curl https://x"` and
// `sh -c 'cd /tmp && curl https://x'` count zero, and so does `if true; then curl https://x; fi`. Also not
// counted at all: command substitution `$(curl ...)`, backticks, a `( ... )` subshell, process substitution
// `<(curl ...)`, and a quoted or backslashed verb (`"curl"`, `\curl`). The count is read before the appends, so
// one command with several fetches can push an agent's count past the cap by that command's own number of
// fetches (five used plus a command with three fetches ends at eight of six) - the same shape as the several-
// calls-in-one-message limit above.
//
// Fail-open, visibly (P3, card research-fetch-cap): this script has no local try/catch of its own. An I/O error
// (e.g. the counter path is unreadable) propagates to runHook (lib/io.mjs), which allows the call but emits a
// systemMessage naming this hook, so the failure is visible instead of silently swallowed here.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { runHook, allow, denyTool } from "../lib/io.mjs";
import { loadConfig, projectDir } from "../lib/config.mjs";
import { commandForms } from "../lib/bash-rules.mjs";

const RESEARCH_CAP_DIR_RELPATH = ".doug/.state/research-cap";
const FETCH_VERBS = new Set(["curl", "wget"]);

function safeId(id) {
  return String(id || "")
    .replace(/[^A-Za-z0-9_.-]/g, "_")
    .replace(/\.{2,}/g, "_")
    .slice(0, 120);
}

function counterFile(dir, sessionId, agentId) {
  // A missing or empty session id falls back to "no-session", like the trace hook's safeId (P5): the agent id
  // is never empty at this point (the caller already returned early when it was).
  return join(dir, RESEARCH_CAP_DIR_RELPATH, safeId(sessionId || "no-session"), `${safeId(agentId)}.log`);
}

function countCalls(file) {
  if (!existsSync(file)) return 0;
  return readFileSync(file, "utf8").split("\n").filter((l) => l.trim()).length;
}

// A form's first word, with its basename lower-cased (a path prefix stripped, matching bash-rules'
// case-insensitive-filesystem reasoning): "sudo curl https://x" -> "sudo", "/usr/bin/curl https://x" -> "curl".
function firstWordBasename(form) {
  const first = String(form).trim().split(/\s+/)[0] || "";
  return first.slice(first.lastIndexOf("/") + 1).toLowerCase();
}

// Round 2 (card research-cap-bash-fetch, major 1): splits a compound Bash command line into its top-level
// simple commands, quote- and heredoc-aware, walking the string once. Unlike bash-rules' splitCommands (which
// splits on ; && || | & and newline everywhere, quote-blind), this only splits on those outside single quotes,
// outside double quotes (a backslash-escaped \" inside double quotes does not close them), and outside a
// heredoc body - so quoted text that merely mentions ";" or "curl" is never miscounted as a separate command.
//
// A heredoc starts at <<WORD, <<-WORD, <<'WORD', or <<"WORD" (never <<<, a here-string: three or more "<" in a
// row is never treated as a heredoc operator). Its body is every line after the operator's line up to the line
// that is exactly WORD (a <<- terminator may be indented with leading tabs); that body is dropped from the
// command text entirely, and the newline that closes the terminator line is treated like any other top-level
// newline (it ends the command that carried the heredoc). An unterminated quote or heredoc has no closing
// point, so it swallows the rest of the string into the current command - fewer splits than a real shell would
// make, never more. Never throws: a malformed <<-with-no-word falls back to literal "<<" text; a non-string
// command returns [].
function splitTopLevel(command) {
  if (typeof command !== "string") return [];
  const results = [];
  let current = "";
  const push = () => {
    const trimmed = current.trim();
    if (trimmed) results.push(trimmed);
    current = "";
  };

  let inSingle = false;
  let inDouble = false;
  let heredocWord = null; // trigger seen on the current line, body starts at the next newline
  let heredocDash = false;
  let inHeredocBody = false;
  let heredocLine = ""; // buffers the body line currently being read, to compare against heredocWord

  const n = command.length;
  let i = 0;
  while (i < n) {
    const ch = command[i];

    if (inHeredocBody) {
      if (ch === "\n") {
        const line = heredocDash ? heredocLine.replace(/^\t+/, "") : heredocLine;
        heredocLine = "";
        if (line === heredocWord) {
          inHeredocBody = false;
          heredocWord = null;
          push(); // the terminator's newline ends the command that carried the heredoc, like any other newline
        }
        i += 1;
        continue;
      }
      heredocLine += ch;
      i += 1;
      continue;
    }

    if (inSingle) {
      current += ch;
      if (ch === "'") inSingle = false;
      i += 1;
      continue;
    }

    if (inDouble) {
      if (ch === "\\" && command[i + 1] === '"') {
        current += ch + command[i + 1];
        i += 2;
        continue;
      }
      current += ch;
      if (ch === '"') inDouble = false;
      i += 1;
      continue;
    }

    if (ch === "'") {
      inSingle = true;
      current += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      current += ch;
      i += 1;
      continue;
    }

    if (ch === "<") {
      let j = i;
      while (command[j] === "<") j += 1;
      const run = j - i;
      if (run !== 2) {
        // one "<" (a plain redirect) or three-plus (a here-string, <<<, or longer): never a heredoc operator
        current += command.slice(i, j);
        i = j;
        continue;
      }
      let k = j;
      let dash = false;
      if (command[k] === "-") {
        dash = true;
        k += 1;
      }
      while (command[k] === " " || command[k] === "\t") k += 1;
      let word = "";
      if (command[k] === "'" || command[k] === '"') {
        const q = command[k];
        k += 1;
        while (k < n && command[k] !== q) {
          word += command[k];
          k += 1;
        }
        if (k < n) k += 1; // skip the closing quote
      } else {
        while (k < n && /[^\s;&|<>()]/.test(command[k])) {
          word += command[k];
          k += 1;
        }
      }
      if (!word) {
        // no word found after "<<": not a valid heredoc trigger, treat the two "<" as ordinary text
        current += command.slice(i, j);
        i = j;
        continue;
      }
      current += command.slice(i, k); // the operator text itself is part of the command that carries it
      heredocWord = word;
      heredocDash = dash;
      i = k;
      continue;
    }

    if (ch === "\n") {
      if (heredocWord !== null) {
        inHeredocBody = true;
        heredocLine = "";
        i += 1;
        continue;
      }
      push();
      i += 1;
      continue;
    }
    if (ch === "&" && command[i + 1] === "&") {
      push();
      i += 2;
      continue;
    }
    if (ch === "|" && command[i + 1] === "|") {
      push();
      i += 2;
      continue;
    }
    if (ch === ";" || ch === "|" || ch === "&") {
      push();
      i += 1;
      continue;
    }

    current += ch;
    i += 1;
  }
  push(); // an unterminated quote or heredoc body just folds whatever is left into this last command
  return results;
}

const LOOPBACK_TOKEN = /^(?:[a-z][a-z0-9+.-]*:\/\/)?(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:[/?#].*)?$/i;
const UNQUOTED_SAFE = /[A-Za-z0-9._:/=@%+,-]/;
const REDIRECT = /^2?>>?(.*)$/;
const REDIRECT_TARGET = /^[A-Za-z0-9._:/=@%+,-]+$/;

// Option allowlist. A loopback fetch may carry only these options; every other option (-K/--config, -x/--proxy,
// wget -i/--input-file, --url, --, curl -T, anything unknown) can hide a remote target or proxy. Value-less flags
// may be combined in one short token; a value-taking letter may come last with its value attached (-qO-,
// -sSo/tmp/x). A value is never URL-checked.
const FETCH_OPTIONS = {
  curl: {
    flags: new Set("sSfLivg"),
    longFlags: new Set(["silent", "show-error", "fail", "location", "include", "verbose", "compressed", "no-progress-meter"]),
    valueShort: new Set("oHdXwm"),
    valueLong: new Set(["output", "header", "data", "data-raw", "data-binary", "json", "request", "write-out", "max-time", "connect-timeout"]),
  },
  wget: {
    flags: new Set("q"),
    longFlags: new Set(["quiet"]),
    valueShort: new Set("OT"),
    valueLong: new Set(["output-document", "header", "post-data", "timeout"]),
  },
};

// Words of one simple command, or null when the text leaves the grammar's character set (rule 1). Each word keeps
// its raw source text (quotes included), its unquoted value, and whether it holds an unquoted redirect ">".
function tokenize(text) {
  const words = [];
  let raw = "";
  let val = "";
  let gt = false;
  let open = false;
  let quote = "";
  const end = () => {
    if (open) words.push({ raw, val, gt });
    raw = "";
    val = "";
    gt = false;
    open = false;
  };
  for (const ch of text) {
    if (quote) {
      raw += ch;
      if (ch === quote) quote = "";
      else if (quote === '"' && "$`\\!".includes(ch)) return null;
      else val += ch;
    } else if (ch === " " || ch === "\t") end();
    else {
      open = true;
      raw += ch;
      if (ch === "'" || ch === '"') quote = ch;
      else if (ch === ">") {
        gt = true;
        val += ch;
      } else if (UNQUOTED_SAFE.test(ch)) val += ch;
      else return null;
    }
  }
  if (quote) return null;
  end();
  return words;
}

// True only when the whole raw command is one simple loopback fetch (see the header). Never throws: string tests
// only; anything outside the grammar returns false and is counted as at HEAD.
function isLoopbackFetch(command) {
  const words = tokenize(String(command).trim());
  if (!words || words.length < 2 || !Object.hasOwn(FETCH_OPTIONS, words[0].raw)) return false;
  const opts = FETCH_OPTIONS[words[0].raw];
  let urls = 0;
  let wantValue = false;
  for (let k = 1; k < words.length; k += 1) {
    const { raw, val, gt } = words[k];
    if (gt) {
      const m = REDIRECT.exec(raw);
      if (!m) return false;
      let target = m[1];
      if (target === "") {
        k += 1;
        if (k >= words.length) return false;
        target = words[k].raw;
      }
      if (!REDIRECT_TARGET.test(target) || (target.startsWith("/dev/") && target !== "/dev/null")) return false;
    } else if (wantValue) wantValue = false;
    else if (raw.startsWith("--")) {
      const eq = val.indexOf("=");
      const name = val.slice(2, eq === -1 ? undefined : eq);
      if (opts.valueLong.has(name)) wantValue = eq === -1;
      else if (eq !== -1 || !opts.longFlags.has(name)) return false;
    } else if (raw.startsWith("-")) {
      if (raw.length === 1) return false;
      for (let c = 1; c < raw.length; c += 1) {
        if (opts.flags.has(raw[c])) continue;
        if (!opts.valueShort.has(raw[c])) return false;
        wantValue = c === raw.length - 1;
        break;
      }
    } else if (LOOPBACK_TOKEN.test(val) && !/\s/.test(val)) urls += 1;
    else return false;
  }
  return urls > 0;
}

// Returns one verb ("curl" or "wget") per split command of a Bash command line that resolves to a fetch;
// non-fetch split commands contribute nothing. A non-string command (missing, or e.g. a number) is zero
// fetches. commandForms runs on each split command's original text with its quotes intact (it does its own
// quote parsing for a shell -c script), never on stripped or reconstructed text. A command that is one simple
// loopback fetch (isLoopbackFetch) is not a fetch to count.
function bashFetchVerbs(command) {
  if (isLoopbackFetch(command)) return [];
  const verbs = [];
  for (const cmd of splitTopLevel(command)) {
    for (const form of commandForms(cmd)) {
      const verb = firstWordBasename(form);
      if (FETCH_VERBS.has(verb)) {
        verbs.push(verb);
        break;
      }
    }
  }
  return verbs;
}

runHook("research-cap", async (input) => {
  const agentId = input.agent_id;
  if (!agentId) return allow(); // the main session is never capped

  const dir = projectDir(input);
  const cfg = loadConfig(dir);
  const max = cfg.research && cfg.research.maxFetches;
  if (!Number.isInteger(max) || max <= 0) return allow(); // cap off

  let entries;
  if (input.tool_name === "Bash") {
    const verbs = bashFetchVerbs(input.tool_input && input.tool_input.command);
    if (verbs.length === 0) return allow(); // an ordinary Bash command is never counted or denied here
    entries = verbs.map((verb) => ({ tool: "Bash", verb }));
  } else {
    entries = [{ tool: input.tool_name }];
  }

  const file = counterFile(dir, input.session_id, agentId);
  const count = countCalls(file);
  if (count >= max) {
    return denyTool(
      `[doug] Research budget reached: this agent has used ${count} of ${max} WebSearch/WebFetch/curl/wget ` +
        `calls (research.maxFetches in .doug/config.json). Stop searching now: write your findings from what ` +
        `you have, and mark anything unanswered unverified.`,
    );
  }
  mkdirSync(join(dir, RESEARCH_CAP_DIR_RELPATH, safeId(input.session_id || "no-session")), { recursive: true });
  for (const entry of entries) {
    appendFileSync(file, JSON.stringify({ t: new Date().toISOString(), ...entry }) + "\n");
  }
  return allow();
});
