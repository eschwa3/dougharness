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
//   autopilot.mjs pick [--max <n>]            JSON { launch, needsPlan, held, alone }; a held line per held card on stderr
//   autopilot.mjs queen-args <id> --kind <flow|hand>   writes .doug/.state/reports/<id>/queen-args.json, prints its path
//   autopilot.mjs launched <id> --run <wf_id> --kind <flow|hand> --worktree <abs> --args-file <path>
//   autopilot.mjs report --run <wf_id> --file <result.json>   saves the queen's report, prints land|resume|ask
//   autopilot.mjs resumed <id> --run <wf_id>
//   autopilot.mjs lock-wait <id> --ms <n>
//   autopilot.mjs end
// --dir <d> names the project (default cwd). Exit 0 done; 1 no run or unknown card; 2 bad usage.
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadModels } from "../lib/models.mjs";
import { AUTOPILOT_FILE, STEPS, readAutopilot } from "../lib/autopilot-view.mjs";
import { contextThreshold } from "../lib/context.mjs";
import { classifyNotification, pickCards, workersMax } from "../lib/coordinator.mjs";
import { nextReadyCards } from "../lib/board.mjs";
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
const clearStep = (c) => {
  delete c.step;
  delete c.stepStartedAt;
};

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
    const ready = nextReadyCards(board, { track: "any", batch: Math.max(1, board.cards.length) })
      .cards.filter((c) => !flyingIds.has(c.id))
      .map(shape);
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
      args = {
        card: { id: b.id, title: b.title ?? null, size: b.size ?? null, class: b.class ?? null, goal: b.goal ?? "" },
        options: {
          testerAgent: true,
          research: false,
          install: (config.commands && config.commands.install) || null,
          gateCommand: "node .doug/hooks/scripts/verify.mjs",
          branch: `card/${id}`,
          base: "main",
        },
        models: loadModels(dir),
        repoRoot: dir,
        worktreePath: join(dir, ".claude/worktrees", `card-${id}`),
      };
    }
    const out = join(dir, ".doug/.state/reports", id, "queen-args.json");
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify(args) + "\n");
    process.stdout.write(out + "\n");
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
    if (parsed !== null) {
      const dest = kind === "flow" ? join(dir, reportPathFor(c.id)) : join(dir, ".doug/.state/reports", c.id, "card-report.json");
      try {
        mkdirSync(dirname(dest), { recursive: true });
        writeFileSync(dest, JSON.stringify(kind === "hand" && parsed.report ? parsed.report : parsed, null, 2) + "\n");
      } catch (e) {
        process.stderr.write(`autopilot: warning: cannot write ${dest}: ${e.code || e.message}\n`);
      }
    }
    const v = classifyNotification(kind, { status: "completed", result: parsed === null ? text : parsed });
    say(`${c.id} ${v.action}${v.reason ? ` ${v.reason}` : ""}`);
    break;
  }
  case "resumed": {
    if (!id) usage("resumed needs a card id");
    const run = need("run");
    const s = load();
    const c = cardOf(s, id);
    c.resumes = (c.resumes || 0) + 1;
    c.runId = run;
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
  case "end": {
    const s = load();
    s.status = "ended";
    s.endedAt = new Date().toISOString();
    save(s);
    say("ended");
    break;
  }
  default:
    usage(`unknown subcommand${cmd ? ` ${cmd}` : ""}; use start, add, card, step, land, stop, filed, caps, pick, launched, report, resumed, lock-wait, or end`);
}
