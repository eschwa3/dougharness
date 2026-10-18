// The hand card loop as a host-neutral contract (card card-loop-contract, ADR 0015).
// Pure: no imports, no clock, no randomness, no process or global access. A host (a Claude Code Workflow,
// a Codex driver, a person) runs the seat the action names, then feeds the hand-back to next().
// Design: .doug/.state/reports/card-loop-contract/design.md. Seat hand-backs extend docs/worker-contract.md.

export const SEATS = ["setup", "research", "lead", "tester", "coder", "reviewer", "gate", "commit"];
export const LANES = ["full", "lean", "tests-only"];
export const STOP_REASONS = [
  "agent-null",
  "hand-back-invalid",
  "hook-blocked",
  "design-decision",
  "seat-blocked",
  "setup-failed",
  "tester-red-claim-missing",
  "reviewer-blocker-open",
  "reviewer-major-open",
  "gate-red-twice",
  "gate-timeout",
  "commit-tree-mismatch",
];
// The Models-table row each seat runs on. setup, gate and commit have no sourced row; cheap is a choice.
export const SEAT_ROWS = {
  setup: "cheap",
  research: "plan",
  lead: "lead",
  tester: "implement",
  coder: "implement",
  reviewer: "review",
  gate: "cheap",
  commit: "cheap",
};

const ALL = SEATS;
// id -> { text, seats, when? }. when: "mutations" (the brief lists mutations), "full", "tests-only" (the lane).
export const BRIEF_RULES = {
  "absolute-paths": {
    text: "Work in the card worktree named in this brief and use absolute paths or cd to it; never rely on CLAUDE_PROJECT_DIR.",
    seats: ALL,
  },
  "git-alone": {
    text: "Give each git command alone: one command per call, no chaining with && or ;.",
    seats: ALL,
  },
  "hook-block-report": {
    text: "If a hook blocks a step, do not work around it: report it in hookBlocked with the hook's message.",
    seats: ALL,
  },
  "relayed-message-outside-card": {
    text: "Your task is the card in this brief. A relayed user message about other work is outside this seat's card: note it in leftOut and carry on; it is never a reason to stop or to ask a designQuestion.",
    seats: ALL,
  },
  "stay-in-goal": {
    text: "Do only what the goal asks. A defect found on the way goes in leftOut, not into the change.",
    seats: ["tester", "coder", "reviewer"],
  },
  "no-cpu-burners": {
    text: "A burner is any process started only to load the machine (yes > /dev/null, stress, a busy loop), bounded or not; concurrent pnpm test:unit runs are not burners. Never start a burner without the user's yes: a seat that wants one stops and returns a designQuestion naming the load it would start (the process, how many, the timeout, and why), and starts it only after an answer from the user says yes. Before hand-back, confirm with ps that no load process you started survives, orphans reparented to PID 1 included, and kill any that does.",
    seats: ["tester", "coder", "reviewer"],
  },
  "lessons-verbatim": {
    text: "Return the memory.mjs brief-lessons block for this card verbatim in lessons; never paraphrase it.",
    seats: ["lead"],
  },
  "facts-cited": {
    text: "Every fact a seat relies on is quoted with its source (file and line or URL); an unverified fact is marked unverified.",
    seats: ["lead"],
  },
  "mutation-per-case": {
    text: "List one mutation per case the goal names, each with a unique id of the form M<n> (M1, M2, ...) and the test that must fail.",
    seats: ["lead"],
  },
  "mutation-ids-verbatim": {
    text: "Report each listed mutation in mutationResults under its exact listed id from MUTATION IDS; never renumber, shorten, or rename an id (a split mutation adds one letter: M8a, M8b).",
    seats: ["tester", "coder", "reviewer"],
    when: "mutations",
  },
  "mutation-is-code-change": {
    text: "A mutation is a code change to a file in the card worktree that a test catches; a check that is not a code mutation (a git diff, a file-absence check) goes in reviewerChecks, never in mutations.",
    seats: ["lead"],
  },
  "red-claim": {
    text: "Tests that are red by design are named in tests_red_by_design; without the claim the card stops. If the new tests pass at baseline (pins), return tests_red_by_design [] and report every listed mutation in mutationResults, run in a scratch copy; the card goes on only when each one failed.",
    seats: ["tester"],
    when: "full",
  },
  "tests-only-no-production-edit": {
    text: "Tests-only card: never edit a production file in the live checkout; run the mutations in a scratch copy and report each result.",
    seats: ["tester", "coder"],
    when: "tests-only",
  },
  "no-test-edit-without-reason": {
    text: "Do not edit a test except with a stated reason in testsEdited (file and reason).",
    seats: ["coder"],
  },
  "mutations-in-scratch": {
    text: "Apply each listed mutation in a scratch copy or worktree under .doug/.state, confirm the run path shows the copy, run the one test file, and remove the copy; report each result.",
    seats: ["coder", "reviewer", "tester"],
    when: "mutations",
  },
  "reviewer-reruns-mutations": {
    text: "Rerun every listed mutation yourself and add your own (own: true); read the diff only after running them.",
    seats: ["reviewer"],
  },
  "no-trailers": {
    text: "Commit without Co-Authored-By or Claude-Session trailers.",
    seats: ["commit"],
  },
  "commit-foreground": {
    text: "Run git commit in the foreground with the Bash tool timeout set to 600000 ms: the pre-commit hook runs the full unit suite and takes over the 2-minute default.",
    seats: ["commit"],
  },
  "commit-no-background": {
    text: "Never use run_in_background, a Monitor, or a sleep loop for git commit: a background commit dies when your seat ends. Wait for the command to return.",
    seats: ["commit"],
  },
  "commit-sha-from-git-log": {
    text: "Report the sha only from git log -1 --format=%H after git commit has returned; never report a sha you did not read from it.",
    seats: ["commit"],
  },
  "gate-no-git-writes": {
    text: "Run the gate commands only. Never run git add, git commit, or any other command that writes to git; the commit seat is the only seat that commits.",
    seats: ["gate"],
  },
  "gate-timeout-is-load": {
    text: "When verify.mjs prints `exit timeout` for a command, report that command with timedOut: true; a timeout is load, not a red or a block, so leave blocked unset.",
    seats: ["gate"],
  },
  "commit-no-file-edits": {
    text: "Never edit, create, delete, or format a file: commit exactly the tree the gate seat passed (GATED TREE). A change the commit seems to need goes in blocked, never into the tree.",
    seats: ["commit"],
  },
  "commit-reports-tree": {
    text: "After git commit returns, run node .doug/hooks/lib/verified-tree.mjs tree with the card worktree path as its argument and report its output as tree; a tree that differs from GATED TREE stops the card.",
    seats: ["commit"],
  },
  "gate-reports-tree": {
    text: "After the gate commands, run node .doug/hooks/lib/verified-tree.mjs tree with the card worktree path as its argument and report its output as tree.",
    seats: ["gate"],
  },
  "leave-plan-anchor-out": {
    text: "Leave .doug/plan.json and .doug/anchor.md out of the commit unless the card is about them.",
    seats: ["commit"],
  },
};

// ---- hand-back schemas (JSON Schema literals; the host may pass one as a Workflow schema or --output-schema) ----

const S = { type: "string" };
const NES = { type: "string", minLength: 1 };
const MUTATION_ID_PATTERN = "^M[1-9][0-9]*$";
const TREE = { type: "string", pattern: "^([0-9a-f]{40}|[0-9a-f]{64})$" };
const INT_OR_NULL = { type: ["integer", "null"] };
const STRS = { type: "array", items: S };
const CMD = {
  type: "object",
  properties: { command: S, exitCode: INT_OR_NULL, timedOut: { type: "boolean" } },
  required: ["command", "exitCode"],
};
const MUT_RESULT = {
  type: "object",
  properties: { id: S, failed: { type: "boolean" }, test: S, assertion: S, own: { type: "boolean" } },
  required: ["id", "failed", "test"],
};
const CODER_MUT_RESULT = {
  type: "object",
  properties: { id: S, failed: { type: "boolean" }, test: S, assertion: S, own: { type: "boolean" }, notRun: NES },
  required: ["id"],
};
const ENVELOPE = {
  seat: { type: "string", enum: SEATS },
  hookBlocked: { type: "object", properties: { message: NES }, required: ["message"] },
  designQuestion: S,
  blocked: S,
  leftOut: STRS,
};
function schema(seat, props, required) {
  return {
    type: "object",
    properties: { ...ENVELOPE, seat: { type: "string", enum: [seat] }, ...props },
    required: ["seat", ...required],
  };
}
export const HAND_BACK_SCHEMAS = {
  setup: schema(
    "setup",
    { worktree: NES, branch: NES, install: { anyOf: [{ type: "null" }, CMD] } },
    ["worktree", "branch", "install"],
  ),
  research: schema("research", { note: NES }, ["note"]),
  lead: schema(
    "lead",
    {
      lessons: S,
      facts: {
        type: "array",
        items: { type: "object", properties: { text: NES, source: NES }, required: ["text", "source"] },
      },
      unverified: STRS,
      testFiles: STRS,
      reviewerChecks: STRS,
      mutations: {
        type: "array",
        items: {
          type: "object",
          properties: { id: { type: "string", minLength: 1, pattern: MUTATION_ID_PATTERN }, case: S, mutation: S, test: S },
          required: ["id", "case", "mutation", "test"],
        },
      },
    },
    ["lessons", "facts", "unverified", "testFiles", "mutations"],
  ),
  tester: schema(
    "tester",
    {
      files: { type: "array", items: NES, minItems: 1 },
      tests_red_by_design: STRS,
      mutationResults: { type: "array", items: MUT_RESULT },
    },
    ["files"],
  ),
  coder: schema(
    "coder",
    {
      filesChanged: STRS,
      commandsRun: { type: "array", items: CMD },
      testsEdited: {
        type: "array",
        items: { type: "object", properties: { file: S, reason: NES }, required: ["file", "reason"] },
      },
      mutationResults: { type: "array", items: CODER_MUT_RESULT },
    },
    ["filesChanged", "commandsRun", "testsEdited"],
  ),
  reviewer: schema(
    "reviewer",
    {
      verdict: { type: "string", enum: ["pass", "fail"] },
      findings: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: S,
            severity: { type: "string", enum: ["blocker", "major", "minor"] },
            file: S,
            description: S,
            evidence: { type: ["string", "null"] },
          },
          required: ["id", "severity", "file", "description"],
        },
      },
      commandsRun: { type: "array", items: CMD },
      mutationResults: { type: "array", items: MUT_RESULT },
    },
    ["verdict", "findings", "commandsRun", "mutationResults"],
  ),
  gate: schema(
    "gate",
    { commands: { type: "array", items: CMD, minItems: 1 }, gateLine: NES, lockWaitMs: INT_OR_NULL, tree: TREE },
    ["commands", "gateLine", "tree"],
  ),
  commit: schema("commit", { sha: { type: "string", pattern: "^[0-9a-f]{7,40}$" }, branch: S, tree: TREE }, ["sha", "branch", "tree"]),
};

// The schema a seat is handed on a lane. Only the tests-only tester may report notRun (validateHandBack's tester
// case), so only there are its mutationResults items CODER_MUT_RESULT; the plain table is the full-lane contract.
export function handBackSchema(seat, lane) {
  if (seat === "tester" && lane === "tests-only") {
    const base = HAND_BACK_SCHEMAS.tester;
    return {
      ...base,
      properties: { ...base.properties, mutationResults: { type: "array", items: CODER_MUT_RESULT } },
    };
  }
  return HAND_BACK_SCHEMAS[seat];
}

// ---- small helpers ----

const cp = (x) => JSON.parse(JSON.stringify(x));
const isObj = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
const isStr = (x) => typeof x === "string";
const nonBlank = (x) => typeof x === "string" && x.trim() !== "";
const isAbs = (x) => nonBlank(x) && (x.startsWith("/") || /^[A-Za-z]:[\\/]/.test(x));
const exitOk = (x) => x === null || Number.isInteger(x);
const strArr = (x) => Array.isArray(x) && x.every(isStr);

function checkCmds(list, path, errs, needOne) {
  if (!Array.isArray(list)) {
    errs.push(path + " must be an array");
    return;
  }
  if (needOne && list.length === 0) errs.push(path + " must not be empty");
  list.forEach((c, i) => {
    if (!isObj(c) || !isStr(c.command) || !exitOk(c.exitCode) || c.exitCode === undefined) {
      errs.push(`${path}[${i}] needs a command string and an integer or null exitCode`);
    }
  });
}

// A reported id covers listed id L when it is L or L plus one lowercase letter (a split such as M1a, M1b).
function coversId(reported, listed) {
  if (reported === listed) return true;
  return typeof reported === "string" && reported.length === listed.length + 1 && reported.startsWith(listed) && /[a-z]$/.test(reported);
}

function checkMutResults(list, path, errs, allowNotRun = false) {
  if (!Array.isArray(list)) {
    errs.push(path + " must be an array");
    return false;
  }
  let good = true;
  list.forEach((m, i) => {
    if (allowNotRun && isObj(m) && m.notRun !== undefined) {
      if (!nonBlank(m.id) || !nonBlank(m.notRun)) {
        errs.push(`${path}[${i}] notRun needs id and a non-empty reason string`);
        good = false;
      }
    } else if (!isObj(m) || !nonBlank(m.id) || typeof m.failed !== "boolean" || !isStr(m.test)) {
      errs.push(`${path}[${i}] needs id, failed (boolean) and test`);
      good = false;
    }
  });
  return good;
}

// ---- lanes and state ----

export function laneFor(card) {
  if (!isObj(card)) return "full";
  if (card.class === "tests-only") return "tests-only";
  if (card.size === "S" && (card.class === "prose" || card.class === "docs")) return "lean";
  return "full";
}

// options.answers: the user's answers to design questions, { seat, question, answer, round?, run? } each.
function checkAnswers(answers) {
  if (answers === undefined || answers === null) return [];
  const bad = (why) => new TypeError("options.answers " + why);
  if (!Array.isArray(answers)) throw bad("must be an array");
  return answers.map((a, i) => {
    if (!isObj(a)) throw bad(`[${i}] must be an object`);
    if (!SEATS.includes(a.seat)) throw bad(`[${i}].seat must be one of the seats`);
    if (!isStr(a.question)) throw bad(`[${i}].question must be a string`);
    if (!nonBlank(a.answer)) throw bad(`[${i}].answer must be a non-blank string`);
    if (a.round !== undefined && !(Number.isInteger(a.round) && a.round > 0)) throw bad(`[${i}].round must be a positive integer`);
    return { ...a };
  });
}

export function initialState(card, options = {}) {
  if (!isObj(card) || !nonBlank(card.id) || !isStr(card.goal)) {
    throw new TypeError("card needs an id and a goal string");
  }
  const o = isObj(options) ? options : {};
  return {
    version: 1,
    answers: checkAnswers(o.answers),
    card: {
      id: card.id,
      title: card.title ?? null,
      size: card.size ?? null,
      class: card.class ?? null,
      goal: card.goal,
    },
    lane: laneFor(card),
    testerAgent: o.testerAgent !== false,
    research: o.research === true,
    install: o.install ?? null,
    gateCommand: o.gateCommand ?? "node .doug/hooks/scripts/verify.mjs",
    branch: o.branch ?? "card/" + card.id,
    base: o.base ?? "main",
    worktree: null,
    researchNote: null,
    material: { lessons: "", facts: [], unverified: [], testFiles: [], mutations: [], reviewerChecks: [] },
    notRun: [],
    redTests: [],
    counters: { coderRounds: 0, fixPasses: 0, redGates: 0 },
    seatRuns: {},
    fixFor: null,
    lastFindings: [],
    lastGate: null,
    gateTree: null,
    pending: "setup",
    outcome: null,
    history: [],
    acc: {
      findings: [],
      downgraded: [],
      mutations: [],
      testsEdited: [],
      filesChanged: [],
      followUps: [],
      gateLine: null,
      lockWaitMs: 0,
      commit: null,
    },
  };
}

const buildSeat = (s) => (s.lane === "tests-only" && s.testerAgent ? "tester" : "coder");
const effectiveMutations = (s) => (s.lane === "lean" ? [] : s.material.mutations);

// ---- briefs and actions ----

function ruleApplies(rule, seat, s) {
  if (!rule.seats.includes(seat)) return false;
  if (rule.when === "full") return s.lane === "full";
  if (rule.when === "tests-only") return s.lane === "tests-only";
  if (rule.when === "mutations") {
    if (effectiveMutations(s).length === 0) return false;
    return seat !== "tester" || s.lane === "tests-only";
  }
  return true;
}

function buildBrief(s) {
  const seat = s.pending;
  const fixing = seat === buildSeat(s) && s.fixFor !== null;
  const brief = {
    seat,
    row: SEAT_ROWS[seat],
    round: (s.seatRuns[seat] || 0) + 1,
    lane: s.lane,
    card: { id: s.card.id, title: s.card.title, goal: s.card.goal },
    worktree: s.worktree,
    branch: s.branch,
    lessons: s.material.lessons,
    facts: cp(s.material.facts),
    unverified: cp(s.material.unverified),
    testFiles: cp(s.material.testFiles),
    mutations: cp(effectiveMutations(s)),
    reviewerChecks: seat === "reviewer" ? cp(s.material.reviewerChecks || []) : [],
    notRun: seat === "reviewer" ? cp(s.notRun || []) : [],
    rules: Object.entries(BRIEF_RULES)
      .filter(([, r]) => ruleApplies(r, seat, s))
      .map(([id, r]) => ({ id, text: r.text })),
    findings: fixing && s.fixFor === "review" ? cp(s.lastFindings) : [],
    gate: fixing && s.fixFor === "gate" ? cp(s.lastGate) : null,
    redTests: cp(s.redTests),
    answers: (s.answers || [])
      .filter((a) => a.seat === seat && (a.round === undefined || a.round <= (s.seatRuns[seat] || 0) + 1))
      .map((a) => ({ question: a.question, answer: a.answer })),
    writeTestsFirst: seat === "coder" && s.counters.coderRounds === 0 && (s.lane === "lean" || !s.testerAgent),
    researchNote: s.researchNote,
    handBack: cp(handBackSchema(seat, s.lane)),
  };
  if (seat === "setup") {
    brief.install = s.install;
    brief.base = s.base;
  }
  if (seat === "gate" || seat === "reviewer") brief.gateCommand = s.gateCommand;
  if (seat === "commit") brief.gateTree = s.gateTree;
  return brief;
}

function buildReport(s) {
  const stopped = s.outcome && s.outcome.kind === "stopped";
  return {
    card: cp(s.card),
    lane: s.lane,
    outcome: stopped ? "stopped" : "done",
    reason: stopped ? s.outcome.reason : null,
    stoppedAt: stopped ? s.outcome.seat : null,
    detail: stopped ? s.outcome.detail : null,
    branch: s.branch,
    worktree: s.worktree,
    commit: s.acc.commit,
    gateLine: s.acc.gateLine,
    lockWaitMs: s.acc.lockWaitMs || 0,
    rounds: s.counters.coderRounds,
    counters: cp(s.counters),
    review: { findings: cp(s.acc.findings), downgraded: cp(s.acc.downgraded) },
    mutations: cp(s.acc.mutations),
    testsRedByDesign: cp(s.redTests),
    testsEdited: cp(s.acc.testsEdited),
    filesChanged: cp(s.acc.filesChanged),
    followUps: cp(s.acc.followUps),
    researchNote: s.researchNote ?? null,
    cost: null,
  };
}

export function currentAction(state) {
  if (state.outcome) {
    const report = buildReport(state);
    return state.outcome.kind === "stopped"
      ? { kind: "stopped", reason: state.outcome.reason, report }
      : { kind: "done", report };
  }
  return { kind: "seat", seat: state.pending, brief: buildBrief(state) };
}

// ---- validation ----

function validBlocker(f) {
  return isObj(f) && f.severity === "blocker" && nonBlank(f.evidence);
}

export function validateHandBack(state, handBack) {
  try {
    return validate(state, handBack);
  } catch (e) {
    return ["hand-back could not be checked: " + String(e && e.message)];
  }
}

function validate(state, hb) {
  const errs = [];
  if (!isObj(hb)) return ["hand-back must be an object"];
  const seat = state.pending;
  if (!seat) return ["no seat is pending"];
  if (hb.seat !== seat) errs.push(`seat must be "${seat}", got ${JSON.stringify(hb.seat) ?? "nothing"}`);
  if (hb.hookBlocked !== undefined && !(isObj(hb.hookBlocked) && nonBlank(hb.hookBlocked.message))) {
    errs.push("hookBlocked needs a non-empty message");
  }
  if (hb.designQuestion !== undefined && !isStr(hb.designQuestion)) errs.push("designQuestion must be a string");
  if (hb.blocked !== undefined && !isStr(hb.blocked)) errs.push("blocked must be a string");
  if (hb.leftOut !== undefined && !strArr(hb.leftOut)) errs.push("leftOut must be an array of strings");

  const muts = effectiveMutations(state);
  const needCover = (list, path, ids) => {
    if (!Array.isArray(list)) return;
    const have = list.filter(isObj).map((m) => m.id);
    for (const id of ids) if (!have.some((h) => coversId(h, id))) errs.push(`${path} is missing listed mutation ${id}`);
  };
  const first = state.counters.coderRounds === 0;

  switch (seat) {
    case "setup": {
      if (!isAbs(hb.worktree)) errs.push("worktree must be an absolute path");
      if (!nonBlank(hb.branch)) errs.push("branch must be a non-empty string");
      if (!("install" in hb)) errs.push("install is required (null when there is no install command)");
      else if (hb.install === null) {
        if (state.install !== null) errs.push("install must report the install command that ran");
      } else checkCmds([hb.install], "install", errs, false);
      break;
    }
    case "research":
      if (!nonBlank(hb.note)) errs.push("note must be the researcher's cited note text or a path, not blank");
      break;
    case "lead": {
      if (!isStr(hb.lessons)) errs.push("lessons must be a string");
      if (!Array.isArray(hb.facts)) errs.push("facts must be an array");
      else {
        hb.facts.forEach((f, i) => {
          if (!isObj(f) || !nonBlank(f.text) || !nonBlank(f.source)) errs.push(`facts[${i}] needs text and a non-empty source`);
        });
      }
      if (!strArr(hb.unverified)) errs.push("unverified must be an array of strings");
      if (!strArr(hb.testFiles)) errs.push("testFiles must be an array of strings");
      if (hb.reviewerChecks !== undefined && !strArr(hb.reviewerChecks)) errs.push("reviewerChecks must be an array of strings");
      if (!Array.isArray(hb.mutations)) errs.push("mutations must be an array");
      else {
        const ids = new Set();
        hb.mutations.forEach((m, i) => {
          if (!isObj(m) || !nonBlank(m.id) || !isStr(m.case) || !isStr(m.mutation) || !isStr(m.test)) {
            errs.push(`mutations[${i}] needs id, case, mutation and test`);
          } else if (ids.has(m.id)) errs.push(`mutations[${i}] repeats id ${m.id}`);
          else if (!new RegExp(MUTATION_ID_PATTERN).test(m.id)) errs.push(`mutations[${i}] id ${m.id} must have the form M<n> (M1, M2, ...)`);
          else ids.add(m.id);
        });
      }
      break;
    }
    case "tester": {
      if (!Array.isArray(hb.files) || hb.files.length === 0 || !hb.files.every(nonBlank)) {
        errs.push("files must be a non-empty array of paths");
      }
      if (hb.tests_red_by_design !== undefined && !strArr(hb.tests_red_by_design)) {
        errs.push("tests_red_by_design must be an array of strings");
      }
      let shaped = true;
      if (hb.mutationResults !== undefined) shaped = checkMutResults(hb.mutationResults, "mutationResults", errs, state.lane === "tests-only");
      if (state.lane === "tests-only" && shaped && Array.isArray(hb.mutationResults)) {
        hb.mutationResults.forEach((m, i) => {
          if (isObj(m) && m.notRun !== undefined && !muts.some((x) => x.id === m.id)) {
            errs.push(`mutationResults[${i}] notRun id ${m.id} is not a listed mutation`);
          }
        });
      }
      if (state.lane === "tests-only" && first && muts.length > 0) {
        if (hb.mutationResults === undefined) errs.push("mutationResults is required on the first run");
        else if (shaped) needCover(hb.mutationResults, "mutationResults", muts.map((m) => m.id));
      }
      break;
    }
    case "coder": {
      if (!strArr(hb.filesChanged)) errs.push("filesChanged must be an array of strings");
      checkCmds(hb.commandsRun, "commandsRun", errs, false);
      if (!Array.isArray(hb.testsEdited)) errs.push("testsEdited must be an array");
      else {
        hb.testsEdited.forEach((t, i) => {
          if (!isObj(t) || !isStr(t.file) || !nonBlank(t.reason)) errs.push(`testsEdited[${i}] needs a file and a stated reason`);
        });
      }
      let shaped = true;
      if (hb.mutationResults !== undefined) shaped = checkMutResults(hb.mutationResults, "mutationResults", errs, true);
      if (shaped && Array.isArray(hb.mutationResults)) {
        hb.mutationResults.forEach((m, i) => {
          if (isObj(m) && m.notRun !== undefined && !muts.some((x) => x.id === m.id)) {
            errs.push(`mutationResults[${i}] notRun id ${m.id} is not a listed mutation`);
          }
        });
      }
      if (first && muts.length > 0) {
        if (hb.mutationResults === undefined) errs.push("mutationResults is required on the first round");
        else if (shaped) needCover(hb.mutationResults, "mutationResults", muts.map((m) => m.id));
      }
      break;
    }
    case "reviewer": {
      if (hb.verdict !== "pass" && hb.verdict !== "fail") errs.push('verdict must be "pass" or "fail"');
      let blocker = false;
      if (!Array.isArray(hb.findings)) errs.push("findings must be an array");
      else {
        hb.findings.forEach((f, i) => {
          if (
            !isObj(f) ||
            !isStr(f.id) ||
            !["blocker", "major", "minor"].includes(f.severity) ||
            !isStr(f.file) ||
            !nonBlank(f.description) ||
            (f.evidence !== undefined && f.evidence !== null && !isStr(f.evidence))
          ) {
            errs.push(`findings[${i}] needs id, severity (blocker|major|minor), file and description`);
          } else if (validBlocker(f)) blocker = true;
        });
      }
      if (hb.verdict === "pass" && blocker) errs.push("verdict pass contradicts an evidenced blocker");
      checkCmds(hb.commandsRun, "commandsRun", errs, false);
      if (Array.isArray(hb.mutationResults)) {
        hb.mutationResults.forEach((m, i) => {
          if (isObj(m) && m.notRun !== undefined) errs.push(`mutationResults[${i}] notRun is not allowed for the reviewer`);
        });
      }
      if (checkMutResults(hb.mutationResults, "mutationResults", errs)) {
        const listed = muts.map((m) => m.id);
        needCover(hb.mutationResults, "mutationResults", listed);
        for (const m of hb.mutationResults) {
          if (!listed.some((l) => coversId(m.id, l)) && m.own !== true) errs.push(`mutationResults id ${m.id} is not listed and not marked own`);
        }
      }
      break;
    }
    case "gate": {
      checkCmds(hb.commands, "commands", errs, true);
      if (Array.isArray(hb.commands) && hb.commands.some((c) => c && isStr(c.command) && GIT_WRITE_RE.test(c.command))) {
        errs.push("gate seat must not run git add or git commit");
      }
      if (!nonBlank(hb.gateLine)) errs.push("gateLine must be a non-empty string");
      if (!(isStr(hb.tree) && TREE_RE.test(hb.tree))) errs.push("tree must be 40 or 64 lowercase hex characters");
      if (hb.lockWaitMs !== undefined && hb.lockWaitMs !== null && !Number.isInteger(hb.lockWaitMs)) {
        errs.push("lockWaitMs must be an integer or null");
      }
      break;
    }
    case "commit": {
      if (!(isStr(hb.sha) && /^[0-9a-f]{7,40}$/.test(hb.sha))) errs.push("sha must be 7 to 40 lowercase hex characters");
      if (!nonBlank(hb.branch)) errs.push("branch must be a non-empty string");
      if (!(isStr(hb.tree) && TREE_RE.test(hb.tree))) errs.push("tree must be 40 or 64 lowercase hex characters");
      break;
    }
    default:
      errs.push("unknown seat " + seat);
  }
  return errs;
}

// ---- next ----

const TREE_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

// git add / git commit at the start of a command or after a shell separator, global options (-C <path>, -c k=v, --flag) allowed before the verb.
const GIT_WRITE_RE = /(?:^|[;&|(\n]\s*)git(?:\s+(?:-[Cc]\s+(?:"[^"]*"|'[^']*'|\S+)|--[\w-]+(?:=\S+)?))*\s+(?:add|commit)\b/;

function stopWith(s, reason, detail) {
  const seat = s.pending;
  const state = {
    ...s,
    pending: null,
    outcome: { kind: "stopped", reason, seat, detail },
    history: [...s.history, { seat, round: s.seatRuns[seat] || 0, result: "stopped", note: reason }],
  };
  return { state, action: currentAction(state) };
}

function advance(s, pending, result, extra = {}) {
  const seat = s.pending;
  const state = {
    ...s,
    ...extra,
    pending,
    history: [...s.history, { seat, round: s.seatRuns[seat], result }],
  };
  return { state, action: currentAction(state) };
}

function union(list, add) {
  const out = [...list];
  for (const x of add) if (!out.includes(x)) out.push(x);
  return out;
}

export function next(state, handBack) {
  const s = cp(state);
  if (s.outcome || !s.pending) return { state: s, action: currentAction(s) };
  const P = s.pending;
  const H = handBack;

  // C1 .. C2
  if (H === null || H === undefined) return stopWith(s, "agent-null", `the ${P} seat's agent returned no hand-back`);
  if (!isObj(H) || H.seat !== P) {
    return stopWith(s, "hand-back-invalid", validateHandBack(s, H).join("; "));
  }
  s.seatRuns = { ...s.seatRuns, [P]: (s.seatRuns[P] || 0) + 1 };
  const round = s.seatRuns[P];
  if (strArr(H.leftOut)) s.acc = { ...s.acc, followUps: union(s.acc.followUps, H.leftOut) };

  // C3 .. C6
  if (isObj(H.hookBlocked) && nonBlank(H.hookBlocked.message)) return stopWith(s, "hook-blocked", H.hookBlocked.message);
  if (nonBlank(H.designQuestion)) return stopWith(s, "design-decision", H.designQuestion);
  if (P === "gate" && Array.isArray(H.commands) && H.commands.some((c) => isObj(c) && c.timedOut === true)) {
    return stopWith({ ...s, lastGate: { commands: cp(H.commands), gateLine: H.gateLine } }, "gate-timeout", typeof H.gateLine === "string" ? H.gateLine : "a gate command timed out");
  }
  if (nonBlank(H.blocked)) return stopWith(s, "seat-blocked", H.blocked);
  const errs = validateHandBack(s, H);
  if (errs.length > 0) return stopWith(s, "hand-back-invalid", errs.join("; "));

  switch (P) {
    case "setup": {
      if (H.install !== null && H.install.exitCode !== 0) {
        return stopWith(s, "setup-failed", `install exited ${H.install.exitCode === null ? "without a code" : H.install.exitCode}`);
      }
      return advance(s, s.research ? "research" : "lead", "ok", { worktree: H.worktree, branch: H.branch });
    }
    case "research":
      return advance(s, "lead", "ok", { researchNote: H.note });
    case "lead": {
      const material = {
        lessons: H.lessons,
        facts: cp(H.facts),
        unverified: cp(H.unverified),
        testFiles: cp(H.testFiles),
        mutations: cp(H.mutations),
        reviewerChecks: strArr(H.reviewerChecks) ? cp(H.reviewerChecks) : [],
      };
      const to = s.lane === "lean" || !s.testerAgent ? "coder" : "tester";
      return advance(s, to, "ok", { material });
    }
    case "tester": {
      const acc = { ...s.acc, filesChanged: union(s.acc.filesChanged, H.files) };
      if (Array.isArray(H.mutationResults) && s.lane === "tests-only") acc.mutations = cp(H.mutationResults);
      if (s.lane === "tests-only") {
        const seenT = new Set((s.notRun || []).map((n) => n.id));
        const notRunT = [...(s.notRun || [])];
        for (const m of Array.isArray(H.mutationResults) ? H.mutationResults : []) {
          if (isObj(m) && m.notRun !== undefined && !seenT.has(m.id)) {
            seenT.add(m.id);
            notRunT.push({ id: m.id, reason: m.notRun });
          }
        }
        return advance(s, "reviewer", "ok", {
          acc,
          notRun: notRunT,
          fixFor: null,
          counters: { ...s.counters, coderRounds: s.counters.coderRounds + 1 },
        });
      }
      const claim = H.tests_red_by_design;
      if (Array.isArray(claim) && claim.length === 0) {
        // Pin-only card: the new tests pass at baseline. Go on only when every listed mutation was run and failed.
        const listed = effectiveMutations(s).map((m) => m.id);
        const results = Array.isArray(H.mutationResults) ? H.mutationResults.filter(isObj) : [];
        const bad = listed.filter((id) => {
          const cov = results.filter((m) => coversId(m.id, id));
          return cov.length === 0 || cov.some((m) => m.failed !== true);
        });
        if (listed.length > 0 && bad.length === 0) {
          return advance(s, "coder", "ok", { acc, redTests: [] });
        }
        return stopWith(
          s,
          "tester-red-claim-missing",
          listed.length === 0
            ? "the tester returned an empty tests_red_by_design claim and no mutation is listed to show the pins bite"
            : `the tester returned an empty tests_red_by_design claim but mutation ${bad.join(", ")} was not run or survived`,
        );
      }
      if (!(Array.isArray(claim) && claim.length > 0 && claim.every(nonBlank))) {
        return stopWith(s, "tester-red-claim-missing", "the tester returned no tests_red_by_design claim");
      }
      return advance(s, "coder", "ok", { acc, redTests: cp(claim) });
    }
    case "coder": {
      const acc = {
        ...s.acc,
        filesChanged: union(s.acc.filesChanged, H.filesChanged),
        testsEdited: [...s.acc.testsEdited, ...H.testsEdited.map((t) => ({ round, file: t.file, reason: t.reason }))],
      };
      const seen = new Set((s.notRun || []).map((n) => n.id));
      const notRun = [...(s.notRun || [])];
      for (const m of Array.isArray(H.mutationResults) ? H.mutationResults : []) {
        if (isObj(m) && m.notRun !== undefined && !seen.has(m.id)) {
          seen.add(m.id);
          notRun.push({ id: m.id, reason: m.notRun });
        }
      }
      return advance(s, "reviewer", "ok", {
        acc,
        notRun,
        fixFor: null,
        counters: { ...s.counters, coderRounds: s.counters.coderRounds + 1 },
      });
    }
    case "reviewer": {
      const downgraded = [];
      const findings = H.findings.map((f) => {
        const weak = f.severity === "blocker" && !nonBlank(f.evidence);
        if (weak) downgraded.push({ round, id: f.id, reason: "blocker without evidence, treated as major" });
        return {
          round,
          id: f.id,
          severity: weak ? "major" : f.severity,
          file: f.file,
          description: f.description,
          evidence: f.evidence ?? null,
        };
      });
      const acc = {
        ...s.acc,
        findings: [...s.acc.findings, ...findings],
        downgraded: [...s.acc.downgraded, ...downgraded],
        mutations: cp(H.mutationResults),
      };
      const blockers = findings.filter((f) => f.severity === "blocker");
      // An evidenced major gets the same one fix pass; a major without evidence and a minor stay advisory.
      const majors = findings.filter((f) => f.severity === "major" && nonBlank(f.evidence));
      if (blockers.length === 0 && majors.length === 0) return advance(s, "gate", "ok", { acc });
      if (s.counters.fixPasses >= 1) {
        if (blockers.length > 0) {
          return stopWith(
            { ...s, acc },
            "reviewer-blocker-open",
            "blocker still open after one fix pass: " + blockers.map((f) => f.id).join(", "),
          );
        }
        return stopWith(
          { ...s, acc },
          "reviewer-major-open",
          "major with evidence still open after one fix pass: " + majors.map((f) => f.id).join(", "),
        );
      }
      return advance(s, buildSeat(s), "blockers", {
        acc,
        fixFor: "review",
        counters: { ...s.counters, fixPasses: 1 },
        lastFindings: findings.filter((f) => f.severity !== "minor"),
      });
    }
    case "gate": {
      const lastGate = { commands: cp(H.commands), gateLine: H.gateLine };
      const waited = { ...s.acc, lockWaitMs: (s.acc.lockWaitMs || 0) + (Number.isInteger(H.lockWaitMs) ? H.lockWaitMs : 0) };
      s.acc = waited;
      if (H.commands.every((c) => c.exitCode === 0)) {
        return advance(s, "commit", "ok", { lastGate, gateTree: H.tree, acc: { ...waited, gateLine: H.gateLine } });
      }
      const redGates = s.counters.redGates + 1;
      const counters = { ...s.counters, redGates };
      if (redGates >= 2) return stopWith({ ...s, lastGate, counters }, "gate-red-twice", H.gateLine);
      return advance(s, buildSeat(s), "red", { lastGate, counters, fixFor: "gate" });
    }
    default: {
      // commit
      if (H.tree !== s.gateTree) {
        return stopWith(s, "commit-tree-mismatch", `commit ${H.sha} tree ${H.tree} differs from the gated tree ${s.gateTree}`);
      }
      const state = {
        ...s,
        pending: null,
        outcome: { kind: "done" },
        acc: { ...s.acc, commit: H.sha },
        history: [...s.history, { seat: P, round, result: "ok" }],
      };
      return { state, action: currentAction(state) };
    }
  }
}

// ---- briefPrompt: a pure text renderer of a brief for every host ----

const bullets = (items) => items.map((x) => "- " + x).join("\n");

export function briefPrompt(brief, { repoRoot, worktreePath } = {}) {
  const b = brief;
  const out = [];
  out.push(`SEAT: ${b.seat} (round ${b.round}, lane ${b.lane}, model row ${b.row})`);
  out.push(`CARD ${b.card.id}${b.card.title ? ": " + b.card.title : ""}`);
  out.push("GOAL:\n" + b.card.goal);
  if (b.answers && b.answers.length > 0) {
    out.push("ANSWERS FROM THE USER (to your design questions; build on them):\n" + bullets(b.answers.map((a) => `Q: ${a.question} A: ${a.answer}`)));
  }
  out.push("WORKTREE: " + worktreePath);
  if (b.seat === "setup") {
    out.push(
      "SETUP:\n" +
        `Create the card worktree: git -C ${repoRoot} worktree add -b ${b.branch} ${worktreePath} ${b.base}\n` +
        (b.install
          ? `Then run the install command in ${worktreePath}: ${b.install}`
          : "There is no install command; skip the install and report install as null."),
    );
  }
  if (b.researchNote) out.push("RESEARCH NOTE:" + (b.researchNote.includes("\n") ? "\n" : " ") + b.researchNote);
  if (b.lessons) out.push("LESSONS BLOCK verbatim:\n" + b.lessons);
  if (b.facts.length > 0) out.push("FACTS (with sources):\n" + bullets(b.facts.map((f) => `${f.text} [${f.source}]`)));
  if (b.unverified.length > 0) out.push("UNVERIFIED:\n" + bullets(b.unverified));
  if (b.testFiles.length > 0) out.push("TEST FILES:\n" + bullets(b.testFiles));
  if (b.mutations.length > 0) {
    out.push("MUTATIONS:\n" + bullets(b.mutations.map((m) => `${m.id} (${m.case}): ${m.mutation}; test that must fail: ${m.test}`)));
    if ((b.rules || []).some((r) => r.id === "mutation-ids-verbatim")) {
      out.push("MUTATION IDS (report each verbatim in mutationResults): " + b.mutations.map((m) => m.id).join(", "));
    }
  }
  if (b.notRun && b.notRun.length > 0) {
    out.push(
      "NOT RUN BY THE CODER (report each with failed true or false):\n" + bullets(b.notRun.map((n) => `${n.id}: ${n.reason}`)),
    );
  }
  if (b.reviewerChecks && b.reviewerChecks.length > 0) out.push("REVIEWER CHECKS:\n" + bullets(b.reviewerChecks));
  if (b.redTests.length > 0) out.push("TESTS RED BY DESIGN:\n" + bullets(b.redTests));
  if (b.writeTestsFirst) out.push("Write the test first, in the file that covers the module, then the change.");
  if (b.findings.length > 0) {
    out.push(
      "FINDINGS TO FIX:\n" +
        bullets(b.findings.map((f) => `${f.id} [${f.severity}] ${f.file}: ${f.description}${f.evidence ? " (evidence: " + f.evidence + ")" : ""}`)),
    );
  }
  if (b.gate) {
    out.push(
      "RED GATE TO FIX:\n" +
        bullets(b.gate.commands.map((c) => `${c.command} exited ${c.exitCode}`)) +
        "\n" +
        b.gate.gateLine,
    );
  }
  if (b.gateCommand) out.push("GATE COMMAND: " + b.gateCommand);
  if (b.gateTree) out.push("GATED TREE: " + b.gateTree);
  out.push("RULES:\n" + bullets(b.rules.map((r) => r.text)));
  out.push("HAND-BACK: return JSON matching this schema:\n" + JSON.stringify(b.handBack, null, 2));
  return out.join("\n\n") + "\n";
}
