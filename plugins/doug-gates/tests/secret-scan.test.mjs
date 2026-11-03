import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeProject, runHookScript, decision, context } from "./helpers.mjs";
import { scanText, candidateTexts, denyReason, RULES } from "../lib/secret-rules.mjs";
import { DEFAULTS } from "../lib/config.mjs";

const here = dirname(fileURLToPath(import.meta.url));

// Every fixture below is built by string concatenation, never a whole literal token:
// the secret-scan hook refuses a Write/Edit whose text contains a whole token, and this
// file must never flag itself (see "never flags its own source ... or this test file").

// -- AWS access key ids (AKIA/ASIA only; docs.aws.amazon.com) --
const AWS_AKIA = "AKIA" + "IOSFODNN7EXAMPLE"; // documented example id (20 chars)
const AWS_ASIA = "ASIA" + "IOSFODNN7EXAMPLE"; // temporary STS access key id, same shape
const AWS_AKIA_SHORT = "AKIA" + "IOSFODNN7EXAMPL"; // 15 chars after prefix, one short
const AWS_AIDA = "AIDA" + "IOSFODNN7EXAMPLE"; // IAM user id, not an access key: dropped
const AWS_AROA = "AROA" + "IOSFODNN7EXAMPLE"; // role id, not an access key: dropped
const AWS_A3T = "A3T" + "A" + "IOSFODNN7EXAMPLE"; // undocumented/legacy prefix: dropped

// -- PEM private-key headers (RFC 7468) --
const PEM_BARE = "-----BEGIN " + "PRIVATE KEY-----";
const PEM_ENCRYPTED = "-----BEGIN " + "ENCRYPTED PRIVATE KEY-----";
const PEM_RSA = "-----BEGIN " + "RSA PRIVATE KEY-----";
const PEM_DSA = "-----BEGIN " + "DSA PRIVATE KEY-----";
const PEM_EC = "-----BEGIN " + "EC PRIVATE KEY-----";
const PEM_SM2 = "-----BEGIN " + "SM2 PRIVATE KEY-----";
const PEM_OPENSSH = "-----BEGIN " + "OPENSSH PRIVATE KEY-----";
const PEM_PUBLIC = "-----BEGIN " + "PUBLIC KEY-----";
const PEM_CERT = "-----BEGIN " + "CERTIFICATE-----";
const PEM_LOWERCASE = "-----BEGIN " + "rsa private key-----";

// -- GitHub tokens (docs.github.com / github.blog) --
const GH_GHP = "ghp_" + "a".repeat(36);
const GH_GHO = "gho_" + "b".repeat(36);
const GH_GHU = "ghu_" + "c".repeat(36);
const GH_GHS = "ghs_" + "d".repeat(36);
const GH_GHR = "ghr_" + "e".repeat(36);
const GH_PAT = "github_pat_" + "A".repeat(22);
const GH_STATELESS = "ghs_" + "123456" + "_" + "abcDEF123" + "." + "ghiJKL456" + "." + "mnoPQR789_-"; // ghs_<appid>_<JWT>
const GH_GHP_SHORT = "ghp_" + "a".repeat(35); // one short of 36
const GH_BAD_PREFIX = "ghx_" + "a".repeat(36); // not a documented prefix

// -- Slack tokens (docs.slack.dev) --
const SLACK_HEX = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4"; // 32-char hex, documented example shape
const SLACK_XOXB = "xoxb" + "-111-222-333-" + SLACK_HEX;
const SLACK_XOXP = "xoxp" + "-111-222-333-" + SLACK_HEX;
const SLACK_XWFP = "xwfp" + "-111-222-333-" + SLACK_HEX;
const SLACK_XAPP = "xapp" + "-1-A1B2C3D4E5-" + SLACK_HEX;
const SLACK_XOXE_ACCESS = "xoxe." + "xoxp-1-" + SLACK_HEX;
const SLACK_XOXE_REFRESH = "xoxe-1-" + SLACK_HEX;
const SLACK_LEGACY10 = "xoxp" + "-111-222-333-" + "abcdefghij"; // pre-2016 10-char secret
const SLACK_LEGACY6 = "xoxb" + "-111-" + "abcdef"; // pre-2016 6-char secret
const SLACK_XOXA = "xoxa" + "-111-222-333-" + SLACK_HEX; // no Slack source: dropped
const SLACK_XOXR = "xoxr" + "-111-222-333-" + SLACK_HEX; // no Slack source: dropped
const SLACK_XOXS = "xoxs" + "-111-222-333-" + SLACK_HEX; // no Slack source: dropped

// -- Inline credential assignment (Doug's own design) --
const PW = "password = " + "hunter2hunter2";
const KEY = "api_key: '" + "sk1234567890abcdef'";
const ENV = "DB_PASSWORD=" + "abc123abc123";
const API_DASH = "api-key = " + "sk1234567890abcdef"; // dash between words
const API_NONE = "apikey: " + "sk1234567890abcdef"; // no separator between words
const ACCESS_NONE = "accesstoken=" + "abc123abc123"; // "access token" with no separator
const AUTH_UNDERSCORE = "auth_token: " + "abc123abc123";
const CLIENT_DASH = "client-secret=" + "abc123abc123";

// -- Round 2 (B1): new key names, letter+digit-or-symbol requirement, reference carve-outs --
const PWD = "pwd = " + "hunter2hunter2";
const PRIVATE_KEY_UNDERSCORE = "private_key: " + "abc123abc123";
const PRIVATE_KEY_NONE = "privatekey: " + "abc123abc123";
const ACCESS_KEY_DASH = "access-key=" + "abc123abc123";
const ACCESS_KEY_NONE = "accesskey=" + "abc123abc123";
const DIGIT_ONLY_NO_LETTER = "password=" + "123456789012"; // 12 digits, no letter: dropped
const SYMBOL_NO_DIGIT_WITH_LETTER = "secret=" + "abcdefghij/klmn"; // letter + "/", no digit
const QUOTED_SPANS_SPACE = 'api_key = "' + "sk1234567890 extra" + '"'; // quoted value up to the closing quote
const BARE_STOPS_AT_COMMA = "(auth_token=" + "abc123abc123" + ",more)"; // bare value up to a delimiter
const REF_DOLLAR = "token = " + "$" + "SOME_TOKEN_VALUE_123"; // reference, not a literal
const REF_BRACE = "password: " + "{DB_PASSWORD_123}";
const REF_ANGLE = "auth_token = " + "<INSERT_TOKEN_123>";
const REF_PERCENT = "secret: " + "%SECRET_VALUE_123%";
const REF_PROCESS_ENV = "password = " + "process.env.DB_PASS_1XX";
const REF_OS_ENVIRON = "secret = " + "os.environ.DB_SECRET_1";

// -- Round 2 (m1/m3/m4): word-boundary, trailing-guard, and single-space pins --
const GH_GHP_UNDERSCORE_SUFFIX = GH_GHP + "_old"; // a real token immediately followed by "_"
const SLACK_XOXB_UNDERSCORE_SUFFIX = SLACK_XOXB + "_bak";
const AWS_AKIA_LOWER_SUFFIX = AWS_AKIA + "x"; // lower-case letter right after the id
const PEM_TWO_SPACE = "-----BEGIN " + " " + "PRIVATE KEY-----"; // two spaces after BEGIN
const PEM_TAB = "-----BEGIN" + "\t" + "PRIVATE KEY-----"; // a tab instead of the single space

// -- Round 2 (M1): adversarial strings, one per rule, built from the rule's own start (a
// bounded repeat of a short literal, never a whole matching token in this file's own source),
// so the pattern under test must still run in roughly linear time against it. awsKeyId,
// pemPrivateKey, and inlineAssignment are measured at the brief's full 1 MB (all sub-10ms on
// the current implementation). githubToken and slackToken's patterns backtrack badly enough at
// 1 MB (confirmed by hand: githubToken 88s, slackToken did not finish in 3 minutes) that this
// file would hang, so those two are run at a smaller, deliberately chosen size instead (112 KB
// and 50 KB below) -- still far slower than linear on the pre-fix code, but fast enough
// that this file stays runnable either way.
const ADV_AWS = "AKIA".repeat(262144); // 1,048,576 chars (~1 MB)
const ADV_PEM = "-----BEGIN ".repeat(95325); // 1,048,575 chars (~1 MB)
const ADV_GITHUB = ("-" + "gh" + "s_1_").repeat(16000); // 112,000 chars (112 KB)
const ADV_SLACK = ("xo" + "xb-").repeat(10000); // 50,000 chars (50 KB)
const ADV_INLINE = "password=".repeat(120000); // 1,080,000 chars (~1 MB)

// -- Round 3 (R3-1): false positives that must not hit --
const PATH_PWD_LINE = "export PATH=" + "$" + "PWD" + ":" + "/usr/local/bin" + ":" + "$" + "PATH";
const DOCKER_PWD_LINE = "docker run -v " + "$" + "PWD" + ":" + "/workspace/project";
const PRIVATE_KEY_PEM_PATH = "private_key: " + "/etc/ssl/private/server" + ".pem";
const SECRET_VAULT_URL = "secret: " + "https" + "://vault.example.com/v1/secret/data/prod";
const MY_PWD_LINE = "MY_" + "PWD=" + "abcdefghijkl12"; // preceded by "_": still hits (PWD commonly means password in env names)
const XPWD_LINE = "X" + "PWD=" + "abcdefghijkl12"; // preceded by a letter: left-boundary near-miss
const PWD_BARE = "pwd=" + "abcdefghijkl12"; // sanity: a real bare key must still hit

// -- Round 3 (R3-2): 1 MB single-line (no newline) adversarial strings, built from the rule's
// own key+quote start, measured by hand against the current implementation: pwd-line 1.9s,
// password-line 1.0s (both well above linear scaling before the fix; neither is catastrophic, so kept at the
// brief's full ~1 MB size).
const ADV_INLINE_PWD_QUOTE = ("pwd" + "='").repeat(209715); // ~1 MB
const ADV_INLINE_PASSWORD_QUOTE = ("password" + '="').repeat(104858); // ~1 MB

// -- Round 3 (R3-3): a double-quoted value containing an apostrophe, built from parts --
const R3_APOSTROPHE_VALUE = "password: " + '"' + "It" + "'" + "s-a-secret-" + "123456" + '"';

// -- Round 4: a 13-char mixed letter+digit literal, shared by the cases below.
const V13 = "abcdefghij" + "123";

// -- Round 4 (1): camelCase/glued keys must still hit. Names below deliberately avoid any
// key-name substring so declaring them can never itself read back as "key = <opening quote of
// a long literal>" (the const name is not the key; only the string value's own text is).
const CAMEL_CONST_LINE = "const dbPassword = " + '"' + V13 + '"' + ";";
const CAMEL_PROP_LINE = "adminPassword: " + "'" + V13 + "'" + ",";
const CAMEL_SECRET_LINE = "const jwtSecret = " + '"' + V13 + '"' + ";";
const CAMEL_APIKEY_LINE = "githubApiKey = " + "'" + V13 + "'";
const GLUED_LOWER_LINE = "dbpassword=" + V13;
const GLUED_STEP_LINE = "dbPwd=" + V13; // lower-to-upper step right before "Pwd"

// -- Round 4 (2) / Round 5 correction: the "$" exclusion applies to "pwd" only -- $PWD is the
// shell-variable false positive, but a $-prefixed long key name assigned a literal (PHP/Perl)
// is a real credential and must still hit.
const ECHO_PWD_LINE = "echo " + "$" + "pwd" + ":" + V13; // still NOT hit
const ECHO_PASSWORD_LINE = "echo " + "$" + "PASSWORD" + "=" + V13; // Round 5: now hits

// -- Round 5: PHP/Perl $-prefixed keys assigned a literal must hit.
const PHP_DOLLAR_LINE_1 = "$" + "password = " + '"' + V13 + '"' + ";";
const PHP_DOLLAR_LINE_2 = "$" + "api_key = " + "'" + V13 + "'" + ";";
const PERL_DOLLAR_LINE = "my " + "$" + "secret = " + "'" + V13 + "'" + ";";

// -- Round 4 (3): a quoted path/URL value must not hit either (Round 3's carve-out only
// checked bare values).
const QUOTED_PEM_PATH = "private_key: " + '"' + "/etc/ssl/private/server" + ".pem" + '"';
const QUOTED_VAULT_URL = "secret: " + '"' + "https" + "://vault.example.com/v1/secret/data/prod" + '"';

// -- Export secret scan card: Anthropic, OpenAI and npm token shapes, built from parts --
const BODY_MIX = "aB3_-xY9Qz7K2mZp9TdW4vLb8NcR3sYh6JfG1aEu0oXi"; // 44 chars of [A-Za-z0-9_-]
const BODY_90 = BODY_MIX + BODY_MIX + "cD"; // 90 chars
const BODY_ALNUM_48 = "Q7xK2mZp9TdW4vLb8NcR3sYh6JfG1aEu0oXiB5nM4wVt2Hq8"; // 48 alnum
const BODY_ALNUM_36 = "Q7xK2mZp9TdW4vLb8NcR3sYh6JfG1aEu0oXi"; // 36 alnum
const ANT_KEY = "sk-" + "ant-" + "api03-" + BODY_90;
const OPENAI_LEGACY = "sk-" + BODY_ALNUM_48;
const OPENAI_PROJ = "sk-" + "proj-" + BODY_90 + BODY_MIX;
const OPENAI_SVC = "sk-" + "svcacct-" + BODY_90;
const OPENAI_ADMIN = "sk-" + "admin-" + BODY_ALNUM_48;
const NPM_TOKEN = "npm" + "_" + BODY_ALNUM_36;
const NPM_TOKEN_LONG = "npm" + "_" + BODY_ALNUM_36 + "abcd";
const NPM_TOKEN_SHORT = "npm" + "_" + BODY_ALNUM_36.slice(0, 35); // one short of 36

const ADV_ANT = ("sk-" + "ant-").repeat(150000); // ~1 MB
const ADV_ANT_LONG = "sk-" + "ant-" + "a".repeat(1 << 20);
const ADV_OPENAI = ("sk-" + "proj-").repeat(131072); // ~1 MB
const ADV_OPENAI_LEGACY_LONG = "sk-" + "a".repeat(1 << 20);
const ADV_NPM_NEAR = ("npm" + "_" + "a".repeat(35)).repeat(29000); // ~1 MB, every start one char short
const ADV_NPM_LONG = "npm" + "_" + "a".repeat(1 << 20);

const VENDOR_SOURCE_FILES = [
  "../lib/secret-rules.mjs",
  "../scripts/secret-scan.mjs",
  "../../../.doug/hooks/lib/secret-rules.mjs",
  "../../../.doug/hooks/scripts/secret-scan.mjs",
];

describe("rule sources", () => {
  it("carries no third-party attribution header in any source file", () => {
    // The former source's name, built from parts so this test file never carries it whole.
    const formerSource = new RegExp("ap" + "ex", "i");
    for (const rel of VENDOR_SOURCE_FILES) {
      const text = readFileSync(join(here, rel), "utf8");
      expect(text, rel).not.toMatch(formerSource);
      expect(text, rel).not.toMatch(/adapted from/i);
    }
  });

  it("gives every rule a non-empty source", () => {
    for (const rule of RULES) {
      expect(rule.source, rule.id).toBeTruthy();
    }
  });

  it("cites an https URL on the vendor's own domain for every non-inline rule", () => {
    const vendorDomains = {
      awsKeyId: "docs.aws.amazon.com",
      pemPrivateKey: "rfc-editor.org",
      githubToken: ["docs.github.com", "github.blog"],
      slackToken: "docs.slack.dev",
      anthropicKey: ["platform.claude.com", "docs.anthropic.com", "docs.claude.com"],
      openaiKey: ["platform.openai.com", "developers.openai.com", "raw.githubusercontent.com/openai/", "github.com/openai/"],
      npmToken: ["github.blog", "docs.npmjs.com"],
    };
    for (const rule of RULES) {
      if (rule.id === "inlineAssignment") continue;
      const domains = vendorDomains[rule.id];
      const sources = Array.isArray(rule.source) ? rule.source : [rule.source];
      for (const src of sources) {
        expect(src, rule.id).toMatch(/^https:\/\//);
        const list = Array.isArray(domains) ? domains : [domains];
        expect(list.some((d) => src.includes(d)), `${rule.id}: ${src}`).toBe(true);
      }
    }
  });
});

describe("awsKeyId", () => {
  it("hits the documented AKIA example id", () => {
    expect(scanText(AWS_AKIA, DEFAULTS.secrets)).toEqual({ rule: "awsKeyId", what: "an AWS access key id" });
  });

  it("hits an ASIA temporary access key id", () => {
    expect(scanText(AWS_ASIA, DEFAULTS.secrets)).toEqual({ rule: "awsKeyId", what: "an AWS access key id" });
  });

  it("rejects an id one character short", () => {
    expect(scanText(AWS_AKIA_SHORT, DEFAULTS.secrets)).toBeNull();
  });

  it("hits a longer id (16 or more characters after the prefix, per the API's 16-128 contract)", () => {
    expect(scanText(AWS_AKIA + "X", DEFAULTS.secrets)).toEqual({ rule: "awsKeyId", what: "an AWS access key id" });
  });

  it("rejects an id glued to a preceding alphanumeric character", () => {
    expect(scanText("x" + AWS_AKIA, DEFAULTS.secrets)).toBeNull();
  });

  it("rejects AIDA/AROA/A3T ids (not access-key prefixes; behaviour change from the old rule)", () => {
    expect(scanText(AWS_AIDA, DEFAULTS.secrets)).toBeNull();
    expect(scanText(AWS_AROA, DEFAULTS.secrets)).toBeNull();
    expect(scanText(AWS_A3T, DEFAULTS.secrets)).toBeNull();
  });

  it("rejects an id followed by a lower-case letter (m3, trailing-guard pin)", () => {
    expect(scanText(AWS_AKIA_LOWER_SUFFIX, DEFAULTS.secrets)).toBeNull();
  });
});

describe("pemPrivateKey", () => {
  it("hits a bare PRIVATE KEY header", () => {
    expect(scanText(PEM_BARE, DEFAULTS.secrets)).toEqual({ rule: "pemPrivateKey", what: "a PEM private-key header" });
  });

  it("hits ENCRYPTED PRIVATE KEY", () => {
    expect(scanText(PEM_ENCRYPTED, DEFAULTS.secrets).rule).toBe("pemPrivateKey");
  });

  it("hits RSA/DSA/EC/SM2/OPENSSH PRIVATE KEY", () => {
    for (const t of [PEM_RSA, PEM_DSA, PEM_EC, PEM_SM2, PEM_OPENSSH]) {
      expect(scanText(t, DEFAULTS.secrets), t).toEqual({ rule: "pemPrivateKey", what: "a PEM private-key header" });
    }
  });

  it("rejects PUBLIC KEY and CERTIFICATE headers", () => {
    expect(scanText(PEM_PUBLIC, DEFAULTS.secrets)).toBeNull();
    expect(scanText(PEM_CERT, DEFAULTS.secrets)).toBeNull();
  });

  it("rejects a lower-case label (RFC 7468 labels are upper-case)", () => {
    expect(scanText(PEM_LOWERCASE, DEFAULTS.secrets)).toBeNull();
  });

  it("rejects text missing the leading dashes", () => {
    expect(scanText("BEGIN " + "PRIVATE KEY", DEFAULTS.secrets)).toBeNull();
  });

  it("rejects two spaces or a tab after BEGIN (m4, RFC 7468's single-space rule; behaviour change)", () => {
    expect(scanText(PEM_TWO_SPACE, DEFAULTS.secrets)).toBeNull();
    expect(scanText(PEM_TAB, DEFAULTS.secrets)).toBeNull();
  });
});

describe("githubToken", () => {
  it("hits each documented prefix at 36 characters", () => {
    for (const t of [GH_GHP, GH_GHO, GH_GHU, GH_GHS, GH_GHR]) {
      expect(scanText(t, DEFAULTS.secrets).rule, t).toBe("githubToken");
    }
  });

  it("hits the github_pat_ fine-grained form", () => {
    expect(scanText(GH_PAT, DEFAULTS.secrets).rule).toBe("githubToken");
  });

  it("hits the 2026 stateless ghs_<appid>_<JWT> form", () => {
    expect(scanText(GH_STATELESS, DEFAULTS.secrets).rule).toBe("githubToken");
  });

  it("rejects a classic token one character short of 36", () => {
    expect(scanText(GH_GHP_SHORT, DEFAULTS.secrets)).toBeNull();
  });

  it("rejects an undocumented prefix", () => {
    expect(scanText(GH_BAD_PREFIX, DEFAULTS.secrets)).toBeNull();
  });

  it("hits a real token immediately followed by an underscore (m1, word-boundary pin)", () => {
    expect(scanText(GH_GHP_UNDERSCORE_SUFFIX, DEFAULTS.secrets).rule).toBe("githubToken");
  });
});

describe("slackToken", () => {
  it("hits xoxb-, xoxp-, xwfp-, and xapp- tokens", () => {
    for (const t of [SLACK_XOXB, SLACK_XOXP, SLACK_XWFP, SLACK_XAPP]) {
      expect(scanText(t, DEFAULTS.secrets).rule, t).toBe("slackToken");
    }
  });

  it("hits rotated tokens (xoxe. access token prefix and xoxe- refresh token)", () => {
    expect(scanText(SLACK_XOXE_ACCESS, DEFAULTS.secrets).rule).toBe("slackToken");
    expect(scanText(SLACK_XOXE_REFRESH, DEFAULTS.secrets).rule).toBe("slackToken");
  });

  it("hits legacy 6- and 10-character secrets", () => {
    expect(scanText(SLACK_LEGACY10, DEFAULTS.secrets).rule).toBe("slackToken");
    expect(scanText(SLACK_LEGACY6, DEFAULTS.secrets).rule).toBe("slackToken");
  });

  it("rejects xoxa-, xoxr-, xoxs- (no Slack source found; behaviour change from the old rule)", () => {
    expect(scanText(SLACK_XOXA, DEFAULTS.secrets)).toBeNull();
    expect(scanText(SLACK_XOXR, DEFAULTS.secrets)).toBeNull();
    expect(scanText(SLACK_XOXS, DEFAULTS.secrets)).toBeNull();
  });

  it("hits a real token immediately followed by an underscore (m1, word-boundary pin)", () => {
    expect(scanText(SLACK_XOXB_UNDERSCORE_SUFFIX, DEFAULTS.secrets).rule).toBe("slackToken");
  });

  it("keeps the xoxe. rotated-access-token form hitting once the dead alternative is dropped (m2)", () => {
    expect(scanText(SLACK_XOXE_ACCESS, DEFAULTS.secrets).rule).toBe("slackToken");
  });
});

describe("inlineAssignment", () => {
  it("hits password/api_key/env-style assignments with a literal value", () => {
    expect(scanText(PW, DEFAULTS.secrets).rule).toBe("inlineAssignment");
    expect(scanText(KEY, DEFAULTS.secrets).rule).toBe("inlineAssignment");
    expect(scanText(ENV, DEFAULTS.secrets).rule).toBe("inlineAssignment");
    expect(scanText("PASSWORD: " + "Abc123Abc123", DEFAULTS.secrets).rule).toBe("inlineAssignment");
  });

  it("hits key names joined by a dash, no separator, or an underscore", () => {
    expect(scanText(API_DASH, DEFAULTS.secrets).rule, API_DASH).toBe("inlineAssignment");
    expect(scanText(API_NONE, DEFAULTS.secrets).rule, API_NONE).toBe("inlineAssignment");
    expect(scanText(ACCESS_NONE, DEFAULTS.secrets).rule, ACCESS_NONE).toBe("inlineAssignment");
    expect(scanText(AUTH_UNDERSCORE, DEFAULTS.secrets).rule, AUTH_UNDERSCORE).toBe("inlineAssignment");
    expect(scanText(CLIENT_DASH, DEFAULTS.secrets).rule, CLIENT_DASH).toBe("inlineAssignment");
  });

  it("does not flag non-literal or placeholder assignments", () => {
    for (const t of [
      "password: hashedPassword",
      "password: process.env.DB_PASSWORD",
      "password=${DB_PASSWORD}",
      'password: "<your-password-123>"',
      "access_token = response.json()",
      'password: "short1"',
      'api_key = "your_api_key_here_123"',
      'secret: "changeme12345"',
      'secret: "example-secret-0001"',
      "client_secret: secretRefFromVault",
    ]) {
      expect(scanText(t, DEFAULTS.secrets), t).toBeNull();
    }
  });

  it("honors configured placeholder prefixes", () => {
    const secrets = { ...DEFAULTS.secrets, placeholders: ["acme_"] };
    expect(scanText("password = " + '"your_pass_12345"', secrets)).not.toBeNull();
    expect(scanText("password = " + '"acme_pass_12345"', secrets)).toBeNull();
  });
});

describe("inlineAssignment (Round 2 design, B1)", () => {
  it("hits new key names: pwd, private key, and access key", () => {
    for (const t of [PWD, PRIVATE_KEY_UNDERSCORE, PRIVATE_KEY_NONE, ACCESS_KEY_DASH, ACCESS_KEY_NONE]) {
      expect(scanText(t, DEFAULTS.secrets).rule, t).toBe("inlineAssignment");
    }
  });

  it("requires a letter in the value in addition to a digit or symbol (behaviour change)", () => {
    expect(scanText(DIGIT_ONLY_NO_LETTER, DEFAULTS.secrets)).toBeNull();
  });

  it("still hits a value with a letter and a symbol but no digit", () => {
    expect(scanText(SYMBOL_NO_DIGIT_WITH_LETTER, DEFAULTS.secrets).rule).toBe("inlineAssignment");
  });

  it("reads a quoted value up to its closing quote, spaces included", () => {
    expect(scanText(QUOTED_SPANS_SPACE, DEFAULTS.secrets).rule).toBe("inlineAssignment");
  });

  it("reads a bare value up to a delimiter such as a comma or closing paren", () => {
    expect(scanText(BARE_STOPS_AT_COMMA, DEFAULTS.secrets).rule).toBe("inlineAssignment");
  });

  it("does not flag a value starting with a reference marker ($, {, <, %)", () => {
    for (const t of [REF_DOLLAR, REF_BRACE, REF_ANGLE, REF_PERCENT]) {
      expect(scanText(t, DEFAULTS.secrets), t).toBeNull();
    }
  });

  it("does not flag a value starting with process.env or os.environ", () => {
    expect(scanText(REF_PROCESS_ENV, DEFAULTS.secrets)).toBeNull();
    expect(scanText(REF_OS_ENVIRON, DEFAULTS.secrets)).toBeNull();
  });
});

// Same-run scaling check instead of a wall-clock budget: one scan of the full text (8n) is
// compared with 8 scans of its first eighth (n) timed in one block, so both intervals are about
// the same length. Linear gives a ratio near 1, a quadratic pattern near 7-8; the threshold is 3.
// The best of RUNS rounds is kept for each side. This does not make load hit both sides alike;
// the loose threshold and FLOOR_MS (sub-ms rules, timer jitter) absorb it.
const RUNS = 3;
const FLOOR_MS = 20;
const MAX_RATIO = 3;
function expectLinearScan(text) {
  const small = text.slice(0, text.length >> 3);
  scanText(small, DEFAULTS.secrets); // warm up
  let tSmall = Infinity;
  let tBig = Infinity;
  for (let i = 0; i < RUNS; i++) {
    let t0 = performance.now();
    for (let k = 0; k < 8; k++) scanText(small, DEFAULTS.secrets);
    tSmall = Math.min(tSmall, performance.now() - t0);
    t0 = performance.now();
    scanText(text, DEFAULTS.secrets);
    tBig = Math.min(tBig, performance.now() - t0);
  }
  expect(tBig, `8 x n=${small.length} ${tSmall.toFixed(1)} ms, 8n=${text.length} ${tBig.toFixed(1)} ms`).toBeLessThan(
    MAX_RATIO * Math.max(tSmall, FLOOR_MS),
  );
}

describe("linear-time patterns (M1)", () => {
  it("scans a 1 MB AWS-shaped adversarial string within budget", () => {
    expectLinearScan(ADV_AWS);
  });

  it("scans a 1 MB PEM-shaped adversarial string within budget", () => {
    expectLinearScan(ADV_PEM);
  });

  it("scans a 112 KB GitHub-shaped adversarial string within budget", () => {
    expectLinearScan(ADV_GITHUB);
  });

  it("scans a 50 KB Slack-shaped adversarial string within budget", () => {
    expectLinearScan(ADV_SLACK);
  });

  it("scans a 1 MB inline-assignment-shaped adversarial string within budget", () => {
    expectLinearScan(ADV_INLINE);
  });
});

describe("linear-time patterns (export secret scan card)", () => {
  it("scans a 1 MB Anthropic-prefix adversarial string within budget", () => {
    expectLinearScan(ADV_ANT);
  });

  it("scans a 1 MB single Anthropic-shaped run within budget", () => {
    expectLinearScan(ADV_ANT_LONG);
  });

  it("scans a 1 MB OpenAI-prefix adversarial string within budget", () => {
    expectLinearScan(ADV_OPENAI);
  });

  it("scans a 1 MB single legacy OpenAI-shaped run within budget", () => {
    expectLinearScan(ADV_OPENAI_LEGACY_LONG);
  });

  it("scans a 1 MB npm-shaped string of one-short tokens within budget", () => {
    expectLinearScan(ADV_NPM_NEAR);
  });

  it("scans a 1 MB single npm-shaped run within budget", () => {
    expectLinearScan(ADV_NPM_LONG);
  });
});

describe("inlineAssignment (Round 3, false positives, R3-1)", () => {
  it("does not flag $PWD used as a shell variable in export PATH or docker -v", () => {
    expect(scanText(PATH_PWD_LINE, DEFAULTS.secrets), PATH_PWD_LINE).toBeNull();
    expect(scanText(DOCKER_PWD_LINE, DEFAULTS.secrets), DOCKER_PWD_LINE).toBeNull();
  });

  it("does not flag a private_key value that is an absolute .pem path", () => {
    expect(scanText(PRIVATE_KEY_PEM_PATH, DEFAULTS.secrets), PRIVATE_KEY_PEM_PATH).toBeNull();
  });

  it("does not flag a secret value that is a vault https URL", () => {
    expect(scanText(SECRET_VAULT_URL, DEFAULTS.secrets), SECRET_VAULT_URL).toBeNull();
  });

  it("still hits a key preceded by an underscore (PWD commonly means password in env names)", () => {
    expect(scanText(MY_PWD_LINE, DEFAULTS.secrets).rule, MY_PWD_LINE).toBe("inlineAssignment");
  });

  it("does not flag a key preceded by a letter (left boundary near-miss)", () => {
    expect(scanText(XPWD_LINE, DEFAULTS.secrets), XPWD_LINE).toBeNull();
  });

  it("still hits a real bare pwd= key with no preceding character", () => {
    expect(scanText(PWD_BARE, DEFAULTS.secrets).rule).toBe("inlineAssignment");
  });
});

describe("linear-time patterns (R3-2, single line, no newline)", () => {
  it("scans a 1 MB single-line pwd='-shaped adversarial string within budget", () => {
    expectLinearScan(ADV_INLINE_PWD_QUOTE);
  });

  it("scans a 1 MB single-line password=\"-shaped adversarial string within budget", () => {
    expectLinearScan(ADV_INLINE_PASSWORD_QUOTE);
  });
});

describe("inlineAssignment (Round 3, quoted value with an apostrophe, R3-3)", () => {
  it("reads a double-quoted value past an embedded apostrophe, stopping at the matching double quote", () => {
    expect(scanText(R3_APOSTROPHE_VALUE, DEFAULTS.secrets).rule, R3_APOSTROPHE_VALUE).toBe("inlineAssignment");
  });
});

describe("inlineAssignment (Round 4)", () => {
  it("hits camelCase and glued key names, not only underscore/dash-joined ones", () => {
    for (const t of [CAMEL_CONST_LINE, CAMEL_PROP_LINE, CAMEL_SECRET_LINE, CAMEL_APIKEY_LINE, GLUED_LOWER_LINE, GLUED_STEP_LINE]) {
      expect(scanText(t, DEFAULTS.secrets), t).not.toBeNull();
      expect(scanText(t, DEFAULTS.secrets).rule, t).toBe("inlineAssignment");
    }
  });

  it("still does not flag XPWD= (letter-preceded) or $PWD (the shell-variable false positive)", () => {
    expect(scanText(XPWD_LINE, DEFAULTS.secrets), XPWD_LINE).toBeNull();
    expect(scanText(ECHO_PWD_LINE, DEFAULTS.secrets), ECHO_PWD_LINE).toBeNull();
  });

  it("hits a $-prefixed long key name assigned a literal (PHP/Perl; Round 5 correction)", () => {
    for (const t of [ECHO_PASSWORD_LINE, PHP_DOLLAR_LINE_1, PHP_DOLLAR_LINE_2, PERL_DOLLAR_LINE]) {
      expect(scanText(t, DEFAULTS.secrets), t).not.toBeNull();
      expect(scanText(t, DEFAULTS.secrets).rule, t).toBe("inlineAssignment");
    }
  });

  it("does not flag a quoted value that is a path or URL (the Round 3 carve-out covered bare values only)", () => {
    expect(scanText(QUOTED_PEM_PATH, DEFAULTS.secrets), QUOTED_PEM_PATH).toBeNull();
    expect(scanText(QUOTED_VAULT_URL, DEFAULTS.secrets), QUOTED_VAULT_URL).toBeNull();
  });
});

describe("anthropicKey", () => {
  it("hits an sk-ant-api03- key with a long body", () => {
    expect(scanText(ANT_KEY, DEFAULTS.secrets)).toEqual({ rule: "anthropicKey", what: "an Anthropic API key" });
  });

  it("does not hit a key glued to a preceding alphanumeric character", () => {
    expect(scanText("x" + ANT_KEY, DEFAULTS.secrets)).toBeNull();
  });

  it("names anthropicKey, not inlineAssignment, for a key assigned to an env var", () => {
    expect(scanText("ANTHROPIC_API_KEY=" + ANT_KEY, DEFAULTS.secrets).rule).toBe("anthropicKey");
  });

  it("does not hit the documented prefix alone, in prose, or with an ellipsis body", () => {
    expect(scanText("keys start with sk-" + "ant-", DEFAULTS.secrets)).toBeNull();
    expect(scanText("keys start with sk-" + "ant- and sk-" + "proj-, shown once", DEFAULTS.secrets)).toBeNull();
    expect(scanText("see sk-" + "ant-api03-... in the console", DEFAULTS.secrets)).toBeNull();
    expect(scanText("sk-" + "ant-api03-xxxx", DEFAULTS.secrets)).toBeNull();
  });

  it("honors secrets.rules.anthropicKey = false", () => {
    const secrets = { ...DEFAULTS.secrets, rules: { ...DEFAULTS.secrets.rules, anthropicKey: false } };
    expect(scanText(ANT_KEY, secrets)).toBeNull();
  });
});

describe("openaiKey", () => {
  it("hits a legacy sk- key (48 alphanumerics)", () => {
    expect(scanText(OPENAI_LEGACY, DEFAULTS.secrets)).toEqual({ rule: "openaiKey", what: "an OpenAI API key" });
  });

  it("hits sk-proj-, sk-svcacct- and sk-admin- keys", () => {
    for (const t of [OPENAI_PROJ, OPENAI_SVC, OPENAI_ADMIN]) {
      expect(scanText(t, DEFAULTS.secrets), t.slice(0, 12)).toEqual({ rule: "openaiKey", what: "an OpenAI API key" });
    }
  });

  it("names openaiKey, not inlineAssignment, for a key assigned to an env var", () => {
    expect(scanText("OPENAI_API_KEY=" + OPENAI_PROJ, DEFAULTS.secrets).rule).toBe("openaiKey");
  });

  it("does not hit the short placeholders in OpenAI's own spec", () => {
    for (const t of ["sk-" + "abcdefghijklmnop123", "sk-" + "admin-1234abcd", "sk-" + "abc...def", "sk-" + "admin...def"]) {
      expect(scanText(t, DEFAULTS.secrets), t).toBeNull();
    }
  });

  it("does not hit kebab words and ids that contain sk-", () => {
    for (const t of [
      "task-queen-args-0001",
      "risk-register",
      "desk-lamp",
      "sk-" + "learn",
      "pip install sk-" + "learn",
      "ask-for-help-with-this-very-long-kebab-case-identifier-name-here",
      "task-queen-args-0001-with-a-long-suffix-of-extra-kebab-words-here",
    ]) {
      expect(scanText(t, DEFAULTS.secrets), t).toBeNull();
    }
  });

  it("does not hit a key glued to a preceding alphanumeric character", () => {
    expect(scanText("x" + OPENAI_LEGACY, DEFAULTS.secrets)).toBeNull();
  });

  it("honors secrets.rules.openaiKey = false", () => {
    const secrets = { ...DEFAULTS.secrets, rules: { ...DEFAULTS.secrets.rules, openaiKey: false } };
    expect(scanText(OPENAI_PROJ, secrets)).toBeNull();
  });
});

describe("npmToken", () => {
  it("hits npm_ followed by 36 alphanumerics, and longer", () => {
    expect(scanText(NPM_TOKEN, DEFAULTS.secrets)).toEqual({ rule: "npmToken", what: "an npm access token" });
    expect(scanText(NPM_TOKEN_LONG, DEFAULTS.secrets).rule).toBe("npmToken");
  });

  it("names npmToken for a .npmrc auth line and for an env assignment", () => {
    expect(scanText("//registry.npmjs.org/:_authToken=" + NPM_TOKEN, DEFAULTS.secrets).rule).toBe("npmToken");
    expect(scanText("NPM_TOKEN=" + NPM_TOKEN, DEFAULTS.secrets).rule).toBe("npmToken");
  });

  it("does not hit npm's own variables", () => {
    for (const t of [
      "npm_package_version",
      "npm_config_registry",
      "npm_config_user_agent",
      "$npm_lifecycle_event",
      'echo "$npm_package_version"',
      "process.env.npm_config_user_agent",
      "npm_config_onnxruntime_node_install=1",
    ]) {
      expect(scanText(t, DEFAULTS.secrets), t).toBeNull();
    }
  });

  it("does not hit a token one character short, or one glued to a preceding alphanumeric", () => {
    expect(scanText(NPM_TOKEN_SHORT, DEFAULTS.secrets)).toBeNull();
    expect(scanText("x" + NPM_TOKEN, DEFAULTS.secrets)).toBeNull();
  });

  it("honors secrets.rules.npmToken = false", () => {
    const secrets = { ...DEFAULTS.secrets, rules: { ...DEFAULTS.secrets.rules, npmToken: false } };
    expect(scanText(NPM_TOKEN, secrets)).toBeNull();
  });
});

describe("new rules in the shared table", () => {
  it("lists the three ids, enabled, in DEFAULTS and in RULES before inlineAssignment", () => {
    for (const id of ["anthropicKey", "openaiKey", "npmToken"]) {
      expect(DEFAULTS.secrets.rules[id], id).toBe(true);
      expect(RULES.findIndex((r) => r.id === id), id).toBeGreaterThanOrEqual(0);
      expect(RULES.findIndex((r) => r.id === id), id).toBeLessThan(RULES.findIndex((r) => r.id === "inlineAssignment"));
    }
  });

  it("scanText over every tracked text file of this repo gets zero hits from the three new rules", () => {
    const root = join(here, "../../..");
    const ls = spawnSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8", maxBuffer: 1 << 28 });
    expect(ls.status).toBe(0);
    const only = { rules: { awsKeyId: false, pemPrivateKey: false, githubToken: false, slackToken: false, inlineAssignment: false } };
    let scanned = 0;
    const hits = [];
    for (const rel of ls.stdout.split("\0").filter(Boolean)) {
      let buf;
      try {
        buf = readFileSync(join(root, rel));
      } catch {
        continue; // deleted in the working tree, or a symlink target gone
      }
      if (buf.includes(0)) continue;
      scanned++;
      const hit = scanText(buf.toString("utf8"), only);
      if (hit) hits.push(rel + " [" + hit.rule + "]");
    }
    expect(scanned).toBeGreaterThan(100);
    expect(hits).toEqual([]);
  });
});

describe("scanText", () => {
  it("honors a disabled rule while others still fire", () => {
    const secrets = { ...DEFAULTS.secrets, rules: { ...DEFAULTS.secrets.rules, inlineAssignment: false } };
    expect(scanText(PW, secrets)).toBeNull();
    expect(scanText(AWS_AKIA, secrets)).not.toBeNull();
  });

  it("returns null for a non-string", () => {
    expect(scanText(42, DEFAULTS.secrets)).toBeNull();
  });

  it("never flags its own source, the script, config.mjs, or this test file", () => {
    for (const rel of ["../lib/secret-rules.mjs", "../scripts/secret-scan.mjs", "../lib/config.mjs", "./secret-scan.test.mjs"]) {
      const text = readFileSync(join(here, rel), "utf8");
      expect(scanText(text, DEFAULTS.secrets), rel).toBeNull();
    }
  });
});

describe("candidateTexts", () => {
  it("yields the command for Bash", () => {
    const out = candidateTexts({ command: "echo hi" });
    expect(out).toEqual([{ label: "this command", path: null, text: "echo hi" }]);
  });

  it("yields content with the file path for Write", () => {
    const out = candidateTexts({ file_path: "src/a.ts", content: "clean" });
    expect(out).toEqual([{ label: "src/a.ts", path: "src/a.ts", text: "clean" }]);
  });

  it("yields new_string only for Edit, never old_string", () => {
    const out = candidateTexts({ file_path: "src/a.ts", old_string: AWS_AKIA, new_string: "clean" });
    expect(out).toEqual([{ label: "src/a.ts", path: "src/a.ts", text: "clean" }]);
  });

  it("yields one entry per edit with the top-level file_path for MultiEdit", () => {
    const out = candidateTexts({
      file_path: "src/a.ts",
      edits: [
        { old_string: "x", new_string: "one" },
        { old_string: "y", new_string: "two" },
      ],
    });
    expect(out).toEqual([
      { label: "src/a.ts", path: "src/a.ts", text: "one" },
      { label: "src/a.ts", path: "src/a.ts", text: "two" },
    ]);
  });

  it("yields new_source with the notebook path for NotebookEdit", () => {
    const out = candidateTexts({ notebook_path: "nb.ipynb", new_source: "print(1)" });
    expect(out).toEqual([{ label: "nb.ipynb", path: "nb.ipynb", text: "print(1)" }]);
  });

  it("returns [] for a non-object toolInput", () => {
    expect(candidateTexts(42)).toEqual([]);
  });

  it("falls back to a null path and 'this edit' label when file_path is not a string", () => {
    const out = candidateTexts({ file_path: 42, content: "clean" });
    expect(out).toEqual([{ label: "this edit", path: null, text: "clean" }]);
  });
});

describe("denyReason", () => {
  it("names the command or the file, and the rule, without echoing the match", () => {
    const hit = { rule: "awsKeyId", what: "an AWS access key id" };
    expect(denyReason(hit, "this command")).toMatch(/^Refusing to run this command/);
    expect(denyReason(hit, "src/a.ts")).toMatch(/^Refusing to write src\/a\.ts/);
    expect(denyReason(hit, "src/a.ts")).toContain("awsKeyId");
  });
});

describe("secret-scan hook", () => {
  it("denies a Write containing an AWS key id, naming the rule and file but not the key", () => {
    const dir = makeProject();
    const r = runHookScript("secret-scan", { tool_name: "Write", tool_input: { file_path: "src/a.ts", content: `const k = "${AWS_AKIA}";` } }, { dir });
    expect(decision(r)).toBe("deny");
    expect(context(r) || "").not.toContain(AWS_AKIA);
    const reason = r.json.hookSpecificOutput.permissionDecisionReason;
    expect(reason).toContain("awsKeyId");
    expect(reason).toContain("src/a.ts");
    expect(reason).not.toContain(AWS_AKIA);
  });

  it("denies a Bash command containing a GitHub token without echoing it", () => {
    const dir = makeProject();
    const r = runHookScript("secret-scan", { tool_name: "Bash", tool_input: { command: "export GITHUB_TOKEN=" + GH_GHP } }, { dir });
    expect(decision(r)).toBe("deny");
    const reason = r.json.hookSpecificOutput.permissionDecisionReason;
    expect(reason).not.toContain(GH_GHP);
  });

  it("denies a Write carrying an Anthropic, OpenAI or npm token, naming the rule and not echoing the token", () => {
    const dir = makeProject();
    for (const [tok, rule] of [
      [ANT_KEY, "anthropicKey"],
      [OPENAI_PROJ, "openaiKey"],
      [NPM_TOKEN, "npmToken"],
    ]) {
      const r = runHookScript("secret-scan", { tool_name: "Write", tool_input: { file_path: "src/a.ts", content: `const k = "${tok}";` } }, { dir });
      expect(decision(r), rule).toBe("deny");
      const reason = r.json.hookSpecificOutput.permissionDecisionReason;
      expect(reason).toContain(rule);
      expect(reason).not.toContain(tok);
    }
  });

  it("allows a Bash command that reads npm's own variables", () => {
    const dir = makeProject();
    const r = runHookScript("secret-scan", { tool_name: "Bash", tool_input: { command: 'echo "$npm_package_version" "$npm_config_user_agent" $npm_lifecycle_event' } }, { dir });
    expect(r.json).toBeNull();
  });

  it("allows an Edit whose old_string carries a secret but new_string is clean", () => {
    const dir = makeProject();
    const r = runHookScript("secret-scan", { tool_name: "Edit", tool_input: { file_path: "src/a.ts", old_string: AWS_AKIA, new_string: "clean" } }, { dir });
    expect(r.json).toBeNull();
  });

  it("denies a MultiEdit whose second edit carries a Slack token", () => {
    const dir = makeProject();
    const r = runHookScript(
      "secret-scan",
      {
        tool_name: "MultiEdit",
        tool_input: {
          file_path: "src/a.ts",
          edits: [
            { old_string: "a", new_string: "clean" },
            { old_string: "b", new_string: "const t = " + '"' + SLACK_XOXB + '";' },
          ],
        },
      },
      { dir }
    );
    expect(decision(r)).toBe("deny");
  });

  it("respects secrets.ignorePaths", () => {
    const dir = makeProject({ config: { secrets: { ignorePaths: ["fixtures/**"] } } });
    const allowed = runHookScript("secret-scan", { tool_name: "Write", tool_input: { file_path: "fixtures/keys.txt", content: AWS_AKIA } }, { dir });
    expect(allowed.json).toBeNull();
    const denied = runHookScript("secret-scan", { tool_name: "Write", tool_input: { file_path: "src/a.ts", content: AWS_AKIA } }, { dir });
    expect(decision(denied)).toBe("deny");
  });

  it("allows everything when secrets.enabled is false", () => {
    const dir = makeProject({ config: { secrets: { enabled: false } } });
    const r = runHookScript("secret-scan", { tool_name: "Write", tool_input: { file_path: "src/a.ts", content: AWS_AKIA } }, { dir });
    expect(r.json).toBeNull();
  });

  it("denies using defaults when there is no config file at all", () => {
    const dir = makeProject();
    const r = runHookScript("secret-scan", { tool_name: "Write", tool_input: { file_path: "src/a.ts", content: AWS_AKIA } }, { dir });
    expect(decision(r)).toBe("deny");
  });

  it("exits clean with no decision on garbage input", () => {
    const dir = makeProject();
    const r = runHookScript("secret-scan", { tool_name: "Write", tool_input: 42 }, { dir });
    expect(r.status).toBe(0);
    expect(r.json).toBeNull();
  });
});
