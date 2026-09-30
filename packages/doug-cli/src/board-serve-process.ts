// Process-management helpers for `doug board serve`: the pidfile at .doug/.state/board-serve.json,
// detecting and reusing a running server, spawning a detached one, stopping one, and opening a
// browser. startBoardServer (board-serve.ts) stays free of all of this.
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface PidfileData {
  pid: number;
  port: number;
  url: string;
  record: string;
}

const PIDFILE_RELPATH = ".doug/.state/board-serve.json";
const LOG_RELPATH = ".doug/.state/board-serve.log";

export function pidfilePath(dir: string): string {
  return join(dir, PIDFILE_RELPATH);
}

export function logPath(dir: string): string {
  return join(dir, LOG_RELPATH);
}

export function readPidfile(dir: string): PidfileData | null {
  try {
    const data = JSON.parse(readFileSync(pidfilePath(dir), "utf8")) as Partial<PidfileData>;
    if (
      typeof data.pid === "number" &&
      typeof data.port === "number" &&
      typeof data.url === "string" &&
      typeof data.record === "string"
    ) {
      return data as PidfileData;
    }
    return null;
  } catch {
    return null;
  }
}

export function writePidfile(dir: string, data: PidfileData): void {
  const file = pidfilePath(dir);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(data));
}

export function removePidfile(dir: string): void {
  try {
    unlinkSync(pidfilePath(dir));
  } catch {
    // already gone
  }
}

// Removes the pidfile only while it still names this pid, so a fresh server that has since
// replaced it (or a stop that already removed it) is left alone.
export function removePidfileIfOwn(dir: string, pid: number): void {
  const data = readPidfile(dir);
  if (data && data.pid === pid) removePidfile(dir);
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function urlAnswers(url: string, timeoutMs: number): Promise<boolean> {
  try {
    const res = await fetch(new URL("api/board", url), { signal: AbortSignal.timeout(timeoutMs) });
    return res.status === 200;
  } catch {
    return false;
  }
}

// Returns the pid a doug board serve at the URL names as its own, from the x-doug-board-serve-pid
// header it sets on every response (any status: even a 500 from a board it cannot load still
// carries the header). Returns null on a fetch error, a missing header, or a header that is not a
// positive decimal integer — including a reused pid with some unrelated listener bound at that URL.
export async function servingPid(url: string, timeoutMs: number): Promise<number | null> {
  try {
    const res = await fetch(new URL("api/board", url), { signal: AbortSignal.timeout(timeoutMs) });
    try {
      await res.body?.cancel();
    } catch {
      // best effort
    }
    const header = res.headers.get("x-doug-board-serve-pid");
    if (header && /^[1-9]\d*$/.test(header)) return Number(header);
    return null;
  } catch {
    return null;
  }
}

// Reads the pidfile and validates it names a live, answering server. A pidfile that fails either
// check is stale and is removed; the caller then starts fresh.
export async function findRunningServer(dir: string): Promise<PidfileData | null> {
  const data = readPidfile(dir);
  if (!data) return null;
  if (!isAlive(data.pid) || !(await urlAnswers(data.url, 1000))) {
    removePidfile(dir);
    return null;
  }
  return data;
}

function lastLines(file: string, n: number): string {
  try {
    const text = readFileSync(file, "utf8");
    return text.split("\n").slice(-n).join("\n");
  } catch {
    return "";
  }
}

// Launches the URL in a browser: BROWSER when set (no shell, URL as its only argument), else the
// platform opener. A spawn failure is reported to stderr and never changes the caller's exit code.
// Callers await this: it resolves once the child has either spawned successfully or failed, so a
// failure is on stderr before a caller that exits right after (--detach, reuse) does so; it never
// waits past a short grace period otherwise, so it stays effectively fire-and-forget.
export async function openBrowser(url: string, stderr: (s: string) => void): Promise<void> {
  let command: string;
  let args: string[];
  let windowsVerbatimArguments = false;
  const browserEnv = process.env.BROWSER;
  if (browserEnv) {
    command = browserEnv;
    args = [url];
  } else if (process.platform === "darwin") {
    command = "open";
    args = [url];
  } else if (process.platform === "win32") {
    command = "cmd";
    args = ["/c", "start", '""', url];
    // cmd.exe's `start` needs the empty-title arg passed through untouched; Node's normal
    // Windows argument quoting would otherwise mangle the bare `""`.
    windowsVerbatimArguments = true;
  } else {
    command = "xdg-open";
    args = [url];
  }
  try {
    const child = spawn(command, args, { detached: true, stdio: "ignore", windowsVerbatimArguments });
    await new Promise<void>((resolve) => {
      const finish = (): void => {
        clearTimeout(timer);
        child.off("error", onError);
        child.off("spawn", onSpawn);
        resolve();
      };
      const onError = (): void => {
        stderr(`Could not open a browser; open ${url} yourself.\n`);
        finish();
      };
      const onSpawn = (): void => finish();
      const timer = setTimeout(finish, 500);
      child.once("error", onError);
      child.once("spawn", onSpawn);
    });
    child.unref();
  } catch {
    stderr(`Could not open a browser; open ${url} yourself.\n`);
  }
}

// Spawns a detached `doug board serve <dir> --port <port>` (no --detach: the child runs the plain
// foreground path, and writes its own pidfile once it listens). process.execArgv/argv[1] carry
// over the current entry point so this also works under `node --import tsx src/bin.ts`.
export function spawnDetached(dir: string, port: number): ChildProcess {
  const file = logPath(dir);
  mkdirSync(dirname(file), { recursive: true });
  const fd = openSync(file, "a");
  const child = spawn(
    process.execPath,
    [...process.execArgv, process.argv[1], "board", "serve", dir, "--port", String(port)],
    { detached: true, stdio: ["ignore", fd, fd] },
  );
  closeSync(fd);
  child.unref();
  return child;
}

// Waits for the detached child's pidfile to name its pid with a URL that answers, or throws with
// the log's tail if the child exits first or the wait times out.
export async function waitForDetached(dir: string, child: ChildProcess, timeoutMs: number): Promise<PidfileData> {
  let childExited = false;
  let exitCode: number | null = null;
  child.once("exit", (code) => {
    childExited = true;
    exitCode = code;
  });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (childExited) {
      throw new Error(
        `doug board serve --detach exited with ${exitCode} before it started listening\n${lastLines(logPath(dir), 40)}`,
      );
    }
    const data = readPidfile(dir);
    if (data && data.pid === child.pid && (await urlAnswers(data.url, 500))) return data;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(
    `doug board serve --detach did not start within ${Math.round(timeoutMs / 1000)}s\n${lastLines(logPath(dir), 40)}`,
  );
}

// Sends SIGTERM to a pidfile's process, but only once it is confirmed to be a live process AND the
// server answering at the pidfile's URL names that same pid in its x-doug-board-serve-pid header —
// not just any live pid the pidfile happens to name, and not just any listener bound at that URL (a
// crash can leave a pidfile whose pid was since reused by an unrelated process, with some unrelated
// listener now bound at its old URL). Unlike the reuse check, this does not require a 200: a
// detached server whose board record it cannot load is still ours to stop, even while it answers
// api/board with a 500. Waits up to timeoutMs for it to exit, removing the pidfile if the process
// is gone. Returns data: null when nothing was running (a stale pidfile, if any, is removed).
export async function stopRunningServer(
  dir: string,
  timeoutMs: number,
): Promise<{ stopped: boolean; data: PidfileData | null }> {
  const data = readPidfile(dir);
  if (!data || !isAlive(data.pid) || (await servingPid(data.url, 1000)) !== data.pid) {
    removePidfile(dir);
    return { stopped: false, data: null };
  }
  try {
    process.kill(data.pid, "SIGTERM");
  } catch {
    removePidfile(dir);
    return { stopped: false, data: null };
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && isAlive(data.pid)) {
    await new Promise((r) => setTimeout(r, 100));
  }
  const stopped = !isAlive(data.pid);
  if (stopped) removePidfile(dir);
  return { stopped, data };
}
