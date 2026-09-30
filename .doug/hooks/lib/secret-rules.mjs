// Pure rule functions for the secret-scan guard so they can be unit-tested without spawning.
// Only new text (Write content, Edit/MultiEdit new_string, NotebookEdit new_source, Bash command)
// is ever scanned; old_string is never included, so removing a secret is never blocked.

// AWS access key ids: of the IAM unique-ID prefixes, only AKIA (long-term) and ASIA (temporary STS)
// denote access key ids (docs.aws.amazon.com .../reference_identifiers.html). The documented example
// id is the prefix plus 16 [A-Z0-9] characters; the AccessKeyId API contract allows 16-128 `\w`
// characters, so the suffix is widened to 16 or more (docs.aws.amazon.com .../API_AccessKey.html).
const AWS_KEY_ID_SRC = "(?<![A-Za-z0-9])(?:AKIA|ASIA)[A-Z0-9]{16,}(?![A-Za-z0-9])";

// PEM private-key headers: RFC 7468's ABNF (`preeb = "-----BEGIN " label "-----"`; a label is one or
// more labelchars joined by a single SP or "-") applied to the PRIVATE KEY (section 10) and ENCRYPTED
// PRIVATE KEY (section 11) labels; RSA/DSA/EC/SM2/OPENSSH are OpenSSL/OpenSSH label words preceding
// it (rfc-editor.org/rfc/rfc7468.txt). The label-word count and length are capped (round 2, M1) so the
// group is a single bounded repeat, not an unbounded quantifier nested inside another.
const PEM_PRIVATE_KEY_SRC = "-----BEGIN (?:[A-Z0-9]{1,20} ){0,3}PRIVATE KEY-----";

// GitHub tokens: the classic prefixes ghp_/gho_/ghu_/ghs_/ghr_ (docs.github.com, "about authentication
// to GitHub") each followed by 36-255 characters (github.blog's "up to 255 characters" integrator
// guidance; "30 random plus a 6-character checksum" is stated there for OAuth (gho_) tokens only —
// the other prefixes' 36-char shape is an inference from the same page, not separately documented),
// the github_pat_ fine-grained form (internal shape undocumented; 22 is Doug's own floor, 255 the
// same integrator ceiling), and the 2026 stateless installation-token form ghs_<appid>_<JWT>
// (docs.github.com, same page). Every repeat is bounded (round 2, M1) so no run is rescanned from
// every start position, and the trailing check is (?![A-Za-z0-9]), not \b, so a token glued to a
// following "_" still hits (round 2, m1).
const GITHUB_TOKEN_SRC =
  "\\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,255}(?![A-Za-z0-9])" +
  "|\\bgithub_pat_[A-Za-z0-9_]{22,255}(?![A-Za-z0-9])" +
  "|\\bghs_[0-9]{1,10}_[A-Za-z0-9_-]{8,2048}\\.[A-Za-z0-9_-]{8,2048}\\.[A-Za-z0-9_-]{8,2048}(?![A-Za-z0-9])";

// Slack tokens: bot/user/workflow/app-level strings begin xoxb-/xoxp-/xwfp-/xapp-, each divided into
// dash-separated sections whose final section is the secret (docs.slack.dev/authentication/tokens);
// rotation gives refresh tokens a bare "xoxe-" prefix (docs.slack.dev/authentication/using-token-
// rotation) — a rotated *access* token's "xoxe." prefix needs no separate alternative, since the
// xoxp-/xoxb- token it wraps already matches on its own (round 2, m2: the old xoxe\. alternative was
// dead code). The prefix match below is a single bounded literal (no nested quantifier, round 2, M1);
// scanSlackToken then reads the run of dash-joined sections and checks the final section's length in
// plain code, never with a `(?:[A-Za-z0-9]+-)*` group, so nothing is rescanned from every start
// position. The final section must be at least 6 characters (the documented pre-2016 legacy minimum);
// xoxa-/xoxr-/xoxs- have no Slack source and are dropped.
const SLACK_PREFIX_SRC = "\\b(?:xoxb|xoxp|xwfp|xapp|xoxe)-";
const SLACK_RUN_CHARS = /[A-Za-z0-9-]/;
const SLACK_RUN_WINDOW = 512; // generous vs. any real Slack token; keeps the scan bounded per match

function scanSlackToken(text) {
  const re = new RegExp(SLACK_PREFIX_SRC, "g");
  let m;
  while ((m = re.exec(text))) {
    const start = m.index + m[0].length;
    const end = Math.min(text.length, start + SLACK_RUN_WINDOW);
    let i = start;
    while (i < end && SLACK_RUN_CHARS.test(text[i])) i++;
    const run = text.slice(start, i);
    const sections = run.split("-");
    const last = sections[sections.length - 1];
    if (last.length >= 6) return true;
    re.lastIndex = Math.max(re.lastIndex, i);
  }
  return false;
}

// Inline credential assignment: Doug's own rule (round 2 redesign, no external source), written
// independently of the prior rule. The regex finds a credential key name — captured in group 1, so
// its left boundary can be judged in code, not the regex — (password, passwd, pwd, secret, client
// secret, api key, access token, auth token, private key, access key — words joined by `_`, `-`, or
// nothing, case-insensitive) followed by `=`/`:` and an optional opening quote (captured in group 2).
// Left boundary (round 4, since round 3's letter/digit exclusion also killed camelCase and glued
// keys like dbPassword/jwtSecret/dbpassword — see isValidKeyBoundary): the long names may be
// preceded by anything at all, including `$` (round 5 correction: PHP/Perl spell a variable with a
// leading `$`, e.g. `$password = "..."`, and that is a real assignment, not shell interpolation);
// only the bare `pwd` alternative keeps round 3's strict rule (not preceded by a letter, digit, or
// `$`), with one exception — a lower-to-upper case step right before it (dbPwd hits; XPWD, preceded
// by an upper-case letter, does not; nor does $PWD/$pwd, the shell-variable case that rule exists
// for). The VALUE itself is read
// by plain code, not by a regex quantifier, from a single bounded slice taken up front (round 3,
// R3-2: that one slice backs both the end-of-line check and the closing-quote search below, so
// neither is an unbounded scan over the rest of the text — see readInlineValue). A quoted value ends
// at the next quote character of the SAME kind that opened it, within that slice and never past its
// first newline (round 3, R3-3: an embedded apostrophe inside a double-quoted value no longer ends
// it early; no matching quote on the line disqualifies the match rather than swallowing the rest of
// the slice). A bare value ends at the next whitespace/`;`/`,`/`)`/`}`/`]`. It is flagged when the
// value is 12+ characters, has at least one letter and at least one digit or one of `/+=`, is not a
// reference (starts with `$`, `{`, `<`, `%`, `process.env`, or `os.environ`), is not a filesystem
// path or network address whether quoted or bare (round 3 R3-1, widened round 4: see
// isInlinePathOrUrl), and is not a configured placeholder prefix.
const INLINE_KEY_SRC =
  "(password|passwd|pwd|secret|client[_-]?secret|api[_-]?key|access[_-]?token|auth[_-]?token|private[_-]?key|access[_-]?key)" +
  "\\s*[:=]\\s*([\"'`])?";
const INLINE_BARE_STOP = /^[^\s;,)}\]]*/;
const INLINE_WINDOW = 4096; // shared bound for the quoted branch's end-of-line and closing-quote search
const INLINE_BARE_WINDOW = 512;
const INLINE_REFERENCE_MARKERS = /^[${<%]/;
const INLINE_PATH_START = /^(?:\/|\.\/|\.\.\/|~)/;
const INLINE_ANY_QUOTE = /["'`]/;
const INLINE_LETTER_OR_DIGIT = /[A-Za-z0-9]/;
const INLINE_LOWER = /[a-z]/;
const INLINE_UPPER = /[A-Z]/;

// Judges a matched key name's left boundary in plain code (round 4), since the exception for `pwd`
// (a camelCase step is allowed; any other letter/digit is not) needs the matched key's own casing,
// which a single case-insensitive regex can't branch on. `left` is the character immediately before
// the key, or undefined at the start of the text. The long names may be preceded by anything at all
// (dbPassword, jwtSecret, dbpassword, ADMIN_API_KEY, and a PHP/Perl `$password = "..."` or
// `$secret = '...'` all still hit — round 5 correction: a leading `$` is how those languages spell
// a variable, not shell/template interpolation, so it is not excluded there). Only bare `pwd` is
// pickier: `left` must be absent, not a letter or digit, or — the camelCase exception — a lower-case
// letter immediately followed by an upper-case first letter of the match (dbPwd hits; XPWD and
// $PWD/$pwd, the shell-variable false positive round 3 introduced this rule for, do not).
function isValidKeyBoundary(left, keyText) {
  if (left === undefined) return true;
  if (keyText.toLowerCase() !== "pwd") return true;
  if (left === "$") return false;
  if (!INLINE_LETTER_OR_DIGIT.test(left)) return true;
  return INLINE_LOWER.test(left) && INLINE_UPPER.test(keyText.charAt(0));
}

// Reads the value following a matched key+separator. Quoted: slice at most INLINE_WINDOW characters
// once (bounding both checks below to that one slice, round 3, R3-2), cut the slice at its first
// newline if any (a value never spans lines), then find the next occurrence of the SAME quote
// character within what's left; no such quote means no value (null), never "keep scanning" or "keep
// the rest of the slice" (round 3, R3-3). Bare: up to the next whitespace/`;`/`,`/`)`/`}`/`]`, itself
// a single bounded slice.
function readInlineValue(text, pos, quote) {
  if (quote) {
    const window = text.slice(pos, Math.min(text.length, pos + INLINE_WINDOW));
    const newline = window.indexOf("\n");
    const line = newline === -1 ? window : window.slice(0, newline);
    const rel = line.indexOf(quote);
    if (rel === -1) return null;
    const value = line.slice(0, rel);
    // A real value never itself starts with a quote character of any kind (that first character
    // would immediately close an empty value) or with whitespace (round 4: a wider left-boundary
    // means the "opening" quote is now sometimes the tail of an unrelated string a few characters
    // earlier — e.g. a key matched inside a JS string literal whose own closing quote sits right
    // where a value would start, with the match then running on to the next quote later in the
    // source line); either shape means the match crossed into unrelated text, so there is no value.
    if (INLINE_ANY_QUOTE.test(value.charAt(0)) || /\s/.test(value.charAt(0))) return null;
    return value;
  }
  const window = text.slice(pos, Math.min(text.length, pos + INLINE_BARE_WINDOW));
  return INLINE_BARE_STOP.exec(window)[0];
}

function isInlineReference(value) {
  const lower = value.toLowerCase();
  return INLINE_REFERENCE_MARKERS.test(value) || lower.startsWith("process.env") || lower.startsWith("os.environ");
}

// A value naming a filesystem location or a network address is not a credential literal (round 3,
// R3-1, widened to quoted values in round 4): it starts with a slash, a `./` or `../` relative
// prefix, or a `~` home shorthand, or it carries a scheme separator (colon, two slashes) further in.
function isInlinePathOrUrl(value) {
  return INLINE_PATH_START.test(value) || value.includes(":" + "//");
}

export const RULES = [
  {
    id: "awsKeyId",
    what: "an AWS access key id",
    source: [
      "https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_identifiers.html",
      "https://docs.aws.amazon.com/IAM/latest/UserGuide/id_credentials_access-keys.html",
      "https://docs.aws.amazon.com/IAM/latest/APIReference/API_AccessKey.html",
    ],
    test: (text) => new RegExp(AWS_KEY_ID_SRC).test(text),
  },
  {
    id: "pemPrivateKey",
    what: "a PEM private-key header",
    source: "https://www.rfc-editor.org/rfc/rfc7468.txt",
    test: (text) => new RegExp(PEM_PRIVATE_KEY_SRC).test(text),
  },
  {
    id: "githubToken",
    what: "a GitHub token",
    source: [
      "https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/about-authentication-to-github",
      "https://github.blog/engineering/platform-security/behind-githubs-new-authentication-token-formats/",
    ],
    test: (text) => new RegExp(GITHUB_TOKEN_SRC).test(text),
  },
  {
    id: "slackToken",
    what: "a Slack token",
    source: ["https://docs.slack.dev/authentication/tokens", "https://docs.slack.dev/authentication/using-token-rotation"],
    test: (text) => scanSlackToken(text),
  },
  {
    id: "inlineAssignment",
    what: "an inline credential assignment (password, secret, api_key, or token with a literal value)",
    source: "Doug's own design (no external source)",
    test: (text, secrets) => {
      const placeholders = ((secrets && secrets.placeholders) || []).map((p) => String(p).toLowerCase());
      const re = new RegExp(INLINE_KEY_SRC, "gi");
      let m;
      while ((m = re.exec(text))) {
        const left = m.index > 0 ? text.charAt(m.index - 1) : undefined;
        if (!isValidKeyBoundary(left, m[1])) continue;
        const pos = m.index + m[0].length;
        const quote = m[2];
        const value = readInlineValue(text, pos, quote);
        if (value === null || value.length < 12) continue;
        if (!/[A-Za-z]/.test(value)) continue;
        if (!/[0-9/+=]/.test(value)) continue;
        if (isInlineReference(value)) continue;
        if (isInlinePathOrUrl(value)) continue;
        const lower = value.toLowerCase();
        if (placeholders.some((p) => lower.startsWith(p))) continue;
        return true;
      }
      return false;
    },
  },
];

// Returns { rule, what } for the first enabled rule that hits, else null.
export function scanText(text, secrets) {
  if (typeof text !== "string") return null;
  for (const rule of RULES) {
    if (secrets && secrets.rules && secrets.rules[rule.id] === false) continue;
    if (rule.test(text, secrets)) return { rule: rule.id, what: rule.what };
  }
  return null;
}

// Extracts the candidate texts to scan (and their labels/paths) from a tool_input.
export function candidateTexts(toolInput) {
  if (!toolInput || typeof toolInput !== "object") return [];
  const out = [];
  const pathOf = (v) => (typeof v === "string" ? v : null);
  if (typeof toolInput.command === "string") {
    out.push({ label: "this command", path: null, text: toolInput.command });
  }
  if (typeof toolInput.content === "string") {
    const path = pathOf(toolInput.file_path);
    out.push({ label: path ?? "this edit", path, text: toolInput.content });
  }
  if (typeof toolInput.new_string === "string") {
    const path = pathOf(toolInput.file_path);
    out.push({ label: path ?? "this edit", path, text: toolInput.new_string });
  }
  if (typeof toolInput.new_source === "string") {
    const path = pathOf(toolInput.notebook_path);
    out.push({ label: path ?? "this edit", path, text: toolInput.new_source });
  }
  if (Array.isArray(toolInput.edits)) {
    for (const e of toolInput.edits) {
      if (e && typeof e === "object" && typeof e.new_string === "string") {
        const raw = toolInput.file_path ?? e.file_path ?? null;
        const path = pathOf(raw);
        out.push({ label: path ?? "this edit", path, text: e.new_string });
      }
    }
  }
  return out;
}

export function denyReason(hit, label) {
  const lead =
    label === "this command"
      ? `Refusing to run this command: it contains what looks like ${hit.what} (rule ${hit.rule}).`
      : `Refusing to write ${label}: it contains what looks like ${hit.what} (rule ${hit.rule}).`;
  return (
    lead +
    ` Reference credentials through an environment variable or a secret manager instead of writing them into files or commands. If this is a placeholder, add its prefix to secrets.placeholders in .doug/config.json; to exempt a path, add it to secrets.ignorePaths; secrets.rules.${hit.rule}: false turns the rule off.`
  );
}
