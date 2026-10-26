#!/usr/bin/env node
// Card test-unit-budget: run `pnpm test:unit`, parse vitest's `Duration  <n>s` summary line, and exit 1 when it
// exceeds the budget (default 200 s; `--budget <s>` overrides; `--command <cmd>` replaces `pnpm test:unit`).
// Exit 0 within budget, 1 over budget or when the run failed, 2 on a bad flag or no Duration line. Node builtins only.
import { spawn } from "node:child_process";
import os from "node:os";

const args = process.argv.slice(2);
let budget = 200;
let command = "pnpm test:unit";
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--budget") {
    const v = args[++i];
    budget = v !== undefined && /^\d+(\.\d+)?$/.test(v) ? Number(v) : NaN;
    if (!(budget > 0)) {
      console.error(`test-budget: --budget needs a positive number of seconds, got ${v}`);
      process.exit(2);
    }
  } else if (args[i] === "--command") {
    command = args[++i];
    if (!command) {
      console.error("test-budget: --command needs a command");
      process.exit(2);
    }
  } else {
    console.error(`test-budget: unknown argument ${args[i]}`);
    process.exit(2);
  }
}

const child = spawn(command, { shell: true, stdio: ["inherit", "pipe", "inherit"], detached: true });
let out = "";
child.stdout.on("data", (d) => {
  out += d;
  process.stdout.write(d);
});
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => {
    try {
      process.kill(-child.pid, sig);
    } catch {
      // ESRCH: the group is already gone
    }
  });
child.on("close", (code, signal) => {
  const clean = out.replace(/\x1b\[[0-9;]*m/g, "");
  const all = [...clean.matchAll(/Duration\s+(\d+(?:\.\d+)?)s/g)];
  const m = all.length ? all[all.length - 1] : null;
  if (signal) {
    console.error(`test-budget: the test run failed (killed by ${signal})`);
    process.exit(1);
  }
  if (code > 128) {
    const name = Object.entries(os.constants.signals).find(([, n]) => n === code - 128)?.[0];
    if (name) {
      console.error(`test-budget: the test run failed (killed by ${name})`);
      process.exit(1);
    }
  }
  if (code !== 0) {
    console.error(`test-budget: the test run failed (exit ${code})`);
    process.exit(1);
  }
  if (!m) {
    console.error("test-budget: no Duration line found in the output");
    process.exit(2);
  }
  const dur = Number(m[1]);
  if (dur > budget) {
    console.error(`test-budget: over budget, Duration ${dur}s > ${budget}s`);
    process.exit(1);
  }
  console.log(`test-budget: Duration ${dur}s within the ${budget}s budget`);
});
