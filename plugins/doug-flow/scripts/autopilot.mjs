#!/usr/bin/env node
// The lead's autopilot state file writer (card autopilot-live-queue): .doug/.state/autopilot.json, which the live pane
// and the served board's autopilot panel read. Each subcommand prints one line `autopilot: <what>`.
//   autopilot.mjs start --cards <id,id,...> --usd-cap <n> --wall-cap <min> [--context-threshold <pct>]
//   autopilot.mjs add <id> [--usd-cap <n>] [--wall-cap <min>]
//   autopilot.mjs card <id>
//   autopilot.mjs step <id> <research|tester|coder|reviewer|gate|commit|record>
//   autopilot.mjs land <id> --commit <sha>
//   autopilot.mjs stop <id> --reason "<why>"
//   autopilot.mjs filed <id> --kind <follow-up|user> [--from <card>] --position "<text>"
//   autopilot.mjs caps [--usd <n>] [--wall <min>] [--context <pct>]
//   autopilot.mjs pick [--max <n>] [--milestone <id>]            JSON { launch, needsPlan, held, alone }; a held line per held card on stderr
//   autopilot.mjs queen-args <id> --kind <flow|hand> [--with <id,id,...>] [--research on|off]   writes .doug/.state/reports/<id>/queen-args.json and the per-card queen.js beside it, prints both paths (args, then queen.js)
//   autopilot.mjs agent-types --kind <flow|hand>   prints the agent types that queen spawns, one per line
//   autopilot.mjs launched <id> --run <wf_id> --kind <flow|hand> --worktree <abs> --args-file <path>
//   autopilot.mjs report --run <wf_id> --file <result.json>   saves the queen's report (a hand card's inline researchNote is written to .doug/.state/research/<id>.md so record promotes it), prints land|resume|ask
//   autopilot.mjs answer <id> --answer "<text>"   records the user's answer to any asking stop in queen-args.json options.answers
//   autopilot.mjs resumed <id> --run <wf_id>   counts every resume, plain or with the answer, against the single plain resume
//   autopilot.mjs rerun-alone <id>   records a rerun-alone answer for a gate-timeout stop; refuses while another queen is in flight or after the card's one resume
//   autopilot.mjs leave <id> --reason "<text>"   records the user's choice to leave a card In flow
//   autopilot.mjs lock-wait <id> --ms <n>
//   autopilot.mjs clear   drops an ended or inactive run; a running run is kept
//   autopilot.mjs end
// --dir <d> names the project (default cwd). Exit 0 done; 1 no run or unknown card; 2 bad usage.
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadModels } from "../lib/models.mjs";
import { AUTOPILOT_FILE, STEPS, clearable, readAutopilot } from "../lib/autopilot-view.mjs";
import { contextThreshold } from "../lib/context.mjs";
import { classifyNotification, pickCards, queenLabel, renameQueenMeta, workersMax } from "../lib/coordinator.mjs";
import { nextReadyCards } from "../lib/board.mjs";
import { SEATS } from "../lib/card-loop.mjs";
import { planFor, reportPathFor } from "../lib/plan.mjs";

const argv = process.argv.slice(2);
const opts = {};
const pos = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith("--")) {
    opts[argv[i].slice(2)] = argv[i + 1] ?? "";
    i++;
  } else pos.push(argv[i]);
}
const [cmd, id, arg2] = pos;
const dir = resolve(opts.dir || process.cwd());
const file = join(dir, AUTOPILOT_FILE);

const usage = (msg) => {
  process.stderr.write(`autopilot: ${msg}\n`);
  process.exit(2);
};
const fail = (msg) => {
  process.stderr.write(`autopilot: ${msg}\n`);
  process.exit(1);
};
const number = (flag, v) => {
  const n = Number(v);
  if (v === undefined || v === "" || !Number.isFinite(n) || n < 0) usage(`--${flag} needs a non-negative number`);
  return n;
};
const need = (flag) => {
  if (opts[flag] === undefined || opts[flag] === "") usage(`--${flag} is required`);
  return opts[flag];
};

// tmp + rename, so a reader never sees a half-written file; the tmp name is not left behind.
function save(state) {
  state.updatedAt = new Date().toISOString();
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n");
  renameSync(tmp, file);
}
const say = (what) => process.stdout.write(`autopilot: ${what}\n`);
const NO_RUN = "no autopilot run; run autopilot.mjs start first";

function load() {
  const s = readAutopilot(dir);
  if (!s) fail(NO_RUN);
  if (!Array.isArray(s.cards)) s.cards = [];
  return s;
}
function cardOf(s, cardId) {
  const c = s.cards.find((x) => x.id === cardId);
  if (!c) fail(`unknown card ${cardId}`);
  return c;
}
const IN_FLIGHT = ["running", "done", "landing"];
const RERUN_ALONE = "Rerun alone: no other queen is in flight now.";
const othersInFlight = (s, id) => s.cards.filter((x) => x.id !== id && IN_FLIGHT.includes(x.state));
// The saved stop report and queen-args of a card, for the commands that answer an asking stop.
function savedStop(id, c) {
  const reportDir = join(dir, ".doug/.state/reports", id);
  let rep;
  try {
    rep = JSON.parse(readFileSync(join(reportDir, "card-report.json"), "utf8"));
  } catch (e) {
    fail(`cannot read the saved report for ${id}: ${e.code || e.message}`);
  }
  if (!rep || rep.outcome !== "stopped" || rep.reason === "agent-null" || !SEATS.includes(rep.stoppedAt)) fail(`${id} did not stop on an answerable ask stop`);
  const argsPath = join(reportDir, "queen-args.json");
  let qa;
  try {
    qa = JSON.parse(readFileSync(argsPath, "utf8"));
  } catch (e) {
    fail(`cannot read ${argsPath}: ${e.code || e.message}`);
  }
  const stopped = (Array.isArray(rep.history) ? rep.history : []).filter((h) => h && h.result === "stopped").pop();
  const entry = { seat: rep.stoppedAt, question: rep.detail, answer: "" };
  if (stopped && Number.isInteger(stopped.round) && stopped.round > 0) entry.round = stopped.round;
  entry.run = c.runId;
  return { rep, argsPath, qa, entry };
}
const clearStep = (c) => {
  delete c.step;
  delete c.stepStartedAt;
  delete c.seats;
};
// Where the queen run's journal lives: the main session's run dir under the user's Claude dir; "" without a session id.
function journalPath(run) {
  const sid = process.env.CLAUDE_CODE_SESSION_ID;
  if (!sid) return "";
  return join(homedir(), ".claude", "projects", dir.replace(/[^A-Za-z0-9]/g, "-"), sid, "subagents", "workflows", run, "journal.jsonl");
}

function boardCard(cardId) {
  try {
    const b = JSON.parse(readFileSync(join(dir, ".doug/board.json"), "utf8"));
    return b.cards.find((c) => c.id === cardId) || null;
  } catch {
    return null;
  }
}
// A swarm card carries the tag "swarm", a field swarm: true, or an explicit request in its goal ("run it as a
// swarm", "swarm: on"); the word swarm alone in a goal does not make one.
function isSwarmCard(c) {
  if (c.swarm === true || (Array.isArray(c.tags) && c.tags.includes("swarm"))) return true;
  return /\b(?:run|build|land)s?\b[^.]{0,20}\bas a swarm\b|\bswarm:\s*on\b/i.test(c.goal ?? "");
}
function queued(cardId) {
  const b = boardCard(cardId);
  const c = { id: cardId };
  for (const k of ["title", "size", "class"]) if (b && b[k] !== undefined) c[k] = b[k];
  c.state = "queued";
  return c;
}

switch (cmd) {
  case "start": {
    const ids = need("cards").split(",").map((x) => x.trim()).filter(Boolean);
    if (!ids.length) usage("--cards names no card");
    const usdCap = number("usd-cap", opts["usd-cap"]);
    const wallCap = number("wall-cap", opts["wall-cap"]);
    let threshold;
    if (opts["context-threshold"] !== undefined) threshold = number("context-threshold", opts["context-threshold"]);
    else {
      let config = {};
      try {
        config = JSON.parse(readFileSync(join(dir, ".doug/config.json"), "utf8"));
      } catch {
        // absent or unreadable: the default
      }
      threshold = contextThreshold(config);
    }
    const now = new Date().toISOString();
    save({
      version: 1,
      status: "running",
      startedAt: now,
      updatedAt: now,
      endedAt: null,
      caps: { usd: usdCap, wallMin: wallCap, contextPct: threshold },
      cards: ids.map(queued),
      filed: [],
    });
    say(`started with ${ids.length} card${ids.length === 1 ? "" : "s"}`);
    break;
  }
  case "add": {
    if (!id) usage("add needs a card id");
    const s = load();
    if (!s.caps || typeof s.caps !== "object") s.caps = {};
    if (opts["usd-cap"] !== undefined) s.caps.usd = number("usd-cap", opts["usd-cap"]);
    if (opts["wall-cap"] !== undefined) s.caps.wallMin = number("wall-cap", opts["wall-cap"]);
    const dup = s.cards.some((c) => c.id === id);
    if (!dup) s.cards.push(queued(id));
    save(s);
    say(dup ? `${id} already queued` : `added ${id}`);
    break;
  }
  case "card": {
    if (!id) usage("card needs a card id");
    const s = load();
    const c = cardOf(s, id);
    c.state = "running";
    clearStep(c);
    save(s);
    say(`${id} running`);
    break;
  }
  case "step": {
    if (!id || !arg2) usage("step needs a card id and a step");
    if (!STEPS.includes(arg2)) usage(`step must be one of ${STEPS.join(", ")}`);
    const s = load();
    const c = cardOf(s, id);
    c.step = arg2;
    c.stepStartedAt = new Date().toISOString();
    c.seats = [...(Array.isArray(c.seats) ? c.seats : []), { step: arg2, startedAt: c.stepStartedAt }];
    save(s);
    say(`${id} ${arg2}`);
    break;
  }
  case "land": {
    if (!id) usage("land needs a card id");
    const commit = need("commit");
    const s = load();
    const c = cardOf(s, id);
    c.state = "landed";
    c.commit = commit;
    delete c.reason;
    clearStep(c);
    save(s);
    say(`${id} landed ${commit}`);
    break;
  }
  case "stop": {
    if (!id) usage("stop needs a card id");
    const reason = need("reason");
    const s = load();
    const c = cardOf(s, id);
    c.state = "stopped";
    c.reason = reason;
    clearStep(c);
    save(s);
    say(`${id} stopped`);
    break;
  }
  case "filed": {
    if (!id) usage("filed needs a card id");
    const kind = need("kind");
    if (kind !== "follow-up" && kind !== "user") usage("--kind must be follow-up or user");
    const position = need("position");
    const s = load();
    if (!Array.isArray(s.filed)) s.filed = [];
    s.filed.push({ id, kind, ...(opts.from ? { from: opts.from } : {}), position });
    save(s);
    say(`filed ${id} (${kind})`);
    break;
  }
  case "caps": {
    const keys = ["usd", "wall", "context"].filter((k) => opts[k] !== undefined);
    if (!keys.length) usage("caps needs --usd, --wall, or --context");
    const vals = Object.fromEntries(keys.map((k) => [k, number(k, opts[k])]));
    const s = load();
    s.used = {
      ...(s.used || {}),
      ...(vals.usd !== undefined ? { usd: vals.usd } : {}),
      ...(vals.wall !== undefined ? { wallMin: vals.wall } : {}),
      ...(vals.context !== undefined ? { contextPct: vals.context } : {}),
      checkedAt: new Date().toISOString(),
    };
    save(s);
    say("caps recorded");
    break;
  }
  case "pick": {
    const s = load();
    let board;
    try {
      board = JSON.parse(readFileSync(join(dir, ".doug/board.json"), "utf8"));
    } catch {
      fail("no readable .doug/board.json");
    }
    let config = {};
    try {
      config = JSON.parse(readFileSync(join(dir, ".doug/config.json"), "utf8"));
    } catch {
      // absent or unreadable: the default
    }
    const max = opts.max !== undefined ? Math.floor(number("max", opts.max)) : workersMax(config, (m) => process.stderr.write(`autopilot: ${m}\n`));
    const trackOf = (c) => (c.track === "hand" ? "hand" : "flow");
    const shape = (c) => ({
      id: c.id,
      goal: c.goal ?? "",
      component: c.component,
      track: trackOf(c),
      class: c.class,
      swarm: isSwarmCard(c),
    });
    const flying = s.cards.filter((c) => ["running", "done", "landing"].includes(c.state));
    const flyingIds = new Set(flying.map((c) => c.id));
    const inFlight = flying.map((c) => {
      const b = boardCard(c.id);
      return b ? shape(b) : { id: c.id, goal: "", track: c.kind === "flow" ? "flow" : "hand" };
    });
    if (opts.milestone === "") usage("--milestone needs an id");
    let picked;
    try {
      picked = nextReadyCards(board, { track: "any", batch: Math.max(1, board.cards.length), milestone: opts.milestone });
    } catch (e) {
      fail(e instanceof Error ? e.message : String(e));
    }
    const ready = picked.cards.filter((c) => !flyingIds.has(c.id)).map(shape);
    const plans = {};
    for (const c of [...ready, ...inFlight]) {
      if (c.track !== "flow") continue;
      let p = null;
      try {
        p = planFor(dir, c.id);
      } catch {
        // an unreadable plan counts as no plan
      }
      if (p) plans[c.id] = p;
    }
    const roots = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
    const out = pickCards({ ready, inFlight, slots: Math.max(0, max - inFlight.length), plans, roots });
    for (const h of out.held) process.stderr.write(`held ${h.id}: overlaps ${h.with} (${h.why})\n`);
    process.stdout.write(JSON.stringify(out) + "\n");
    break;
  }
  case "queen-args": {
    if (!id) usage("queen-args needs a card id");
    const kind = need("kind");
    if (kind !== "flow" && kind !== "hand") usage("--kind must be flow or hand");
    if (opts.research !== undefined) {
      if (kind === "flow") usage("--research is for a hand card; research for a flow card runs before its plan (doug-next section 1)");
      if (opts.research !== "on" && opts.research !== "off") usage("--research must be on or off");
    }
    let args;
    if (kind === "flow") {
      try {
        args = JSON.parse(execFileSync(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), "plan.mjs"), "json", "--card", id], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 }));
      } catch (e) {
        fail(`plan.mjs json --card ${id} failed: ${String(e.stderr || e.message).trim()}`);
      }
    } else {
      const b = boardCard(id);
      if (!b) fail(`unknown card ${id}`);
      let config = {};
      try {
        config = JSON.parse(readFileSync(join(dir, ".doug/config.json"), "utf8"));
      } catch {
        // absent or unreadable: no install command
      }
      let base = "main";
      try {
        base = execFileSync("git", ["-C", dir, "symbolic-ref", "--short", "-q", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || "main";
      } catch {
        // not a git repo or a detached HEAD: main
      }
      args = {
        card: { id: b.id, title: b.title ?? null, size: b.size ?? null, class: b.class ?? null, goal: b.goal ?? "" },
        options: {
          testerAgent: true,
          research: opts.research === "on",
          install: (config.commands && config.commands.install) || null,
          gateCommand: "node .doug/hooks/scripts/verify.mjs",
          branch: `card/${id}`,
          base,
        },
        models: loadModels(dir),
        repoRoot: dir,
        worktreePath: join(dir, ".claude/worktrees", `card-${id}`),
      };
    }
    const out = join(dir, ".doug/.state/reports", id, "queen-args.json");
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify(args) + "\n");
    const flying = (readAutopilot(dir)?.cards ?? []).filter((c) => ["running", "done", "landing"].includes(c.state)).map((c) => c.id);
    const batch = String(opts.with ?? "").split(",").map((x) => x.trim()).filter(Boolean);
    const srcFile = join(dirname(fileURLToPath(import.meta.url)), "..", "workflows", kind === "hand" ? "card-queen.js" : "doug-implement.js");
    let renamed;
    try {
      renamed = renameQueenMeta(readFileSync(srcFile, "utf8"), { kind, label: queenLabel(id, [...flying, ...batch]) });
    } catch (e) {
      fail(`cannot build the per-card queen from ${srcFile}: ${e.message}`);
    }
    const script = join(dirname(out), "queen.js");
    rmSync(script, { force: true });
    writeFileSync(script, renamed);
    process.stdout.write(out + "\n" + script + "\n");
    break;
  }
  case "agent-types": {
    const kind = need("kind");
    if (kind !== "flow" && kind !== "hand") usage("--kind must be flow or hand");
    const wf = join(dirname(fileURLToPath(import.meta.url)), "..", "workflows", kind === "hand" ? "card-queen.js" : "doug-implement.js");
    let src;
    try {
      src = readFileSync(wf, "utf8");
    } catch (e) {
      fail(`cannot read ${wf}: ${e.message}`);
    }
    if (kind === "hand") {
      const m = src.match(/const AGENT_TYPES = \{([^}]*)\}/);
      if (!m) fail("AGENT_TYPES not found in card-queen.js");
      src = m[1];
    }
    const types = [...new Set([...src.matchAll(kind === "hand" ? /'(doug-flow:[\w-]+)'/g : /agentType: '([^']+)'/g)].map((x) => x[1]))];
    if (types.length === 0) fail("no agent types found");
    process.stdout.write(types.join("\n") + "\n");
    break;
  }
  case "launched": {
    if (!id) usage("launched needs a card id");
    const run = need("run");
    const kind = need("kind");
    if (kind !== "flow" && kind !== "hand") usage("--kind must be flow or hand");
    const worktree = need("worktree");
    const argsFile = need("args-file");
    const s = load();
    const c = cardOf(s, id);
    const reportDir = join(dir, ".doug/.state/reports", id);
    mkdirSync(reportDir, { recursive: true });
    try {
      copyFileSync(argsFile, join(reportDir, "queen-args.json"));
    } catch (e) {
      fail(`cannot read --args-file ${argsFile}: ${e.code || e.message}`);
    }
    c.state = "running";
    c.runId = run;
    c.kind = kind;
    c.worktree = worktree;
    clearStep(c);
    delete c.journals;
    const journal = journalPath(run);
    if (journal) c.journals = [journal];
    save(s);
    say(`${id} launched as ${run}`);
    break;
  }
  case "report": {
    const run = need("run");
    const resultFile = need("file");
    const s = load();
    const c = s.cards.find((x) => x.runId === run);
    if (!c) fail(`unknown run ${run}`);
    let text;
    try {
      text = readFileSync(resultFile, "utf8");
    } catch (e) {
      fail(`cannot read --file ${resultFile}: ${e.code || e.message}`);
    }
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      // unreadable: classify says resume
    }
    const kind = c.kind === "flow" ? "flow" : "hand";
    // The queen's task-output file wraps the result: {summary, agentCount, logs, result}.
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) && parsed.result !== null && typeof parsed.result === "object") {
      const bare = kind === "flow" ? !("ok" in parsed) && !("paused" in parsed) : !("card" in parsed) && !("outcome" in parsed);
      if (bare) parsed = parsed.result;
    }
    if (parsed !== null) {
      const dest = kind === "flow" ? join(dir, reportPathFor(c.id)) : join(dir, ".doug/.state/reports", c.id, "card-report.json");
      try {
        mkdirSync(dirname(dest), { recursive: true });
        writeFileSync(dest, JSON.stringify(kind === "hand" && parsed.report ? parsed.report : parsed, null, 2) + "\n");
      } catch (e) {
        process.stderr.write(`autopilot: warning: cannot write ${dest}: ${e.code || e.message}\n`);
      }
      if (kind === "hand") {
        const rep = parsed.report ?? parsed;
        const note = rep && typeof rep.researchNote === "string" ? rep.researchNote : "";
        if (note.trim() !== "") {
          const noteDest = join(dir, ".doug/.state/research", `${c.id}.md`);
          try {
            const oneLine = note.trim();
            let src = null;
            if (!oneLine.includes("\n") && oneLine.startsWith("/") && resolve(oneLine) !== resolve(noteDest) && existsSync(oneLine)) src = oneLine;
            if (resolve(oneLine) !== resolve(noteDest)) {
              mkdirSync(dirname(noteDest), { recursive: true });
              if (src) copyFileSync(src, noteDest);
              else writeFileSync(noteDest, note);
            }
          } catch (e) {
            process.stderr.write(`autopilot: warning: cannot write ${noteDest}: ${e.code || e.message}\n`);
          }
        }
      }
    }
    const v = classifyNotification(kind, { status: "completed", result: parsed === null ? text : parsed });
    if (v.action === "ask") {
      let answered = false;
      try {
        const saved = JSON.parse(readFileSync(join(dir, ".doug/.state/reports", c.id, "queen-args.json"), "utf8"));
        const rep = parsed?.report ?? parsed;
        const stop = (Array.isArray(rep?.history) ? rep.history : []).filter((h) => h && h.result === "stopped").pop();
        answered =
          Array.isArray(saved?.options?.answers) &&
          saved.options.answers.some(
            (a) => a && a.run === run && a.seat === rep?.stoppedAt && stop && a.round === stop.round && a.question === rep?.detail,
          );
      } catch {
        // no readable args: not answered
      }
      if (answered) {
        say(`${c.id} resume with the answer`);
        break;
      }
    }
    if (v.action === "ask" && v.reason === "gate-timeout" && !c.resumes && othersInFlight(s, c.id).length > 0) {
      c.state = "stopped";
      c.reason = "gate-timeout: rerun alone pending";
      save(s);
      say(`${c.id} rerun alone gate-timeout`);
      break;
    }
    say(`${c.id} ${v.action}${v.reason ? ` ${v.reason}` : ""}`);
    break;
  }
  case "answer": {
    if (!id) usage("answer needs a card id");
    const answer = need("answer");
    if (answer.trim() === "") usage("--answer needs a non-blank answer");
    const s = load();
    const c = cardOf(s, id);
    const { rep, argsPath, qa, entry } = savedStop(id, c);
    entry.answer = answer;
    qa.options = { ...(qa.options || {}), answers: [...(Array.isArray(qa.options?.answers) ? qa.options.answers : []), entry] };
    writeFileSync(argsPath, JSON.stringify(qa, null, 2) + "\n");
    say(`${id} answer recorded for ${entry.seat}`);
    break;
  }
  case "rerun-alone": {
    if (!id) usage("rerun-alone needs a card id");
    const s = load();
    const c = cardOf(s, id);
    const others = othersInFlight(s, id);
    if (others.length > 0) fail(`${others.map((x) => x.id).join(", ")} still in flight; rerun ${id} alone after it lands`);
    if (c.resumes >= 1) fail(`${id} was already resumed once`);
    const { rep, argsPath, qa, entry } = savedStop(id, c);
    entry.answer = RERUN_ALONE;
    qa.options = { ...(qa.options || {}), answers: [...(Array.isArray(qa.options?.answers) ? qa.options.answers : []), entry] };
    writeFileSync(argsPath, JSON.stringify(qa, null, 2) + "\n");
    say(`${id} rerun alone recorded for ${rep.stoppedAt}`);
    break;
  }
  case "leave": {
    if (!id) usage("leave needs a card id");
    const reason = need("reason");
    if (reason.trim() === "") usage("--reason needs a non-blank reason");
    const s = load();
    const c = cardOf(s, id);
    c.left = reason;
    save(s);
    say(`${id} left In flow: ${reason}`);
    break;
  }
  case "resumed": {
    if (!id) usage("resumed needs a card id");
    const run = need("run");
    const s = load();
    const c = cardOf(s, id);
    c.resumes = (c.resumes || 0) + 1;
    c.runId = run;
    c.state = "running";
    const journal = journalPath(run);
    if (journal) c.journals = [...(Array.isArray(c.journals) ? c.journals : []), journal];
    save(s);
    say(`${id} resumed as ${run}`);
    break;
  }
  case "lock-wait": {
    if (!id) usage("lock-wait needs a card id");
    const ms = number("ms", opts.ms);
    const s = load();
    const c = cardOf(s, id);
    c.lockWaitMs = (c.lockWaitMs || 0) + ms;
    save(s);
    say(`${id} lock wait ${c.lockWaitMs}ms`);
    break;
  }
  case "clear": {
    if (!existsSync(file)) say("nothing to clear");
    else {
      const s = readAutopilot(dir);
      if (!s) say("kept the unreadable file");
      else if (clearable(s, new Date())) {
        rmSync(file);
        say("cleared");
      } else say("kept the running run");
    }
    break;
  }
  case "end": {
    const s = load();
    if (s.cards.length > 0) {
      let board;
      try {
        board = JSON.parse(readFileSync(join(dir, ".doug/board.json"), "utf8"));
      } catch (e) {
        fail(`cannot read the board to check cards In flow: ${e.code || e.message}`);
      }
      const stuck = s.cards.filter((c) => {
        if ((board.cards || []).find((b) => b.id === c.id)?.column !== "flow") return false;
        if (c.resumes >= 1 || (typeof c.left === "string" && c.left.trim() !== "")) return false;
        let answers = [];
        try {
          answers = JSON.parse(readFileSync(join(dir, ".doug/.state/reports", c.id, "queen-args.json"), "utf8")).options.answers;
        } catch {
          // no readable args: not answered
        }
        return !(Array.isArray(answers) && answers.some((a) => a && a.run === c.runId && a.answer !== RERUN_ALONE));
      });
      if (stuck.length > 0) fail(`cannot end: ${stuck.map((c) => c.id).join(", ")} still In flow, neither resumed nor answered`);
    }
    s.status = "ended";
    s.endedAt = new Date().toISOString();
    save(s);
    say("ended");
    break;
  }
  default:
    usage(`unknown subcommand${cmd ? ` ${cmd}` : ""}; use start, add, card, step, land, stop, filed, caps, pick, launched, report, answer, rerun-alone, leave, resumed, lock-wait, clear, or end`);
}
