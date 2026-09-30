import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { localListenerDenied } from "./listen-probe.js";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const vitestCli = join(root, "node_modules/vitest/vitest.mjs");
const stub = pathToFileURL(join(root, "packages/doug-cli/tests/fixtures/listen-eperm.mjs")).href;

interface AssertionResult {
  fullName: string;
  status: string;
  failureMessages?: string[];
}

interface TestResult {
  assertionResults: AssertionResult[];
}

interface Report {
  numFailedTests: number;
  numPendingTests: number;
  testResults: TestResult[];
}

// Strips lines the stop gate would parse as a real failing file ("FAIL " or "×" prefixes) out of
// raw nested-report text, so a diagnostic message built from it cannot itself trip that gate.
function stopGateSafe(s: string): string {
  return s
    .split("\n")
    .map((line) => (/^\s*(FAIL |×)/.test(line) ? line.replace(/^(\s*)(FAIL |×)/, "$1[nested]") : line))
    .join("\n");
}

// Builds a message naming which nested assertions failed, so a non-zero exit status reads as
// "these assertions failed" rather than a bare "expected 1 to be 0".
function describeFailures(report: Report, exitStatus: number | null): string {
  const failed = report.testResults.flatMap((r) => r.assertionResults).filter((a) => a.status === "failed");
  if (failed.length === 0) {
    return `nested vitest run exited ${exitStatus} with no failed assertions in its report (numFailedTests=${report.numFailedTests})`;
  }
  const lines = failed.slice(0, 8).map((a) => {
    const messages = (a.failureMessages ?? []).join("\n").slice(0, 500);
    return `- ${a.fullName}\n${stopGateSafe(messages)}`;
  });
  const more = failed.length > 8 ? `\n... and ${failed.length - 8} more` : "";
  return `nested vitest run exited ${exitStatus} with ${failed.length} failed assertion(s):\n${lines.join("\n")}${more}`;
}

function runBoardPageTests(env: NodeJS.ProcessEnv): { status: number | null; report: Report } {
  const dir = mkdtempSync(join(tmpdir(), "doug-board-page-skip-"));
  const reportFile = join(dir, "report.json");
  const child = spawnSync(
    process.execPath,
    [vitestCli, "run", "packages/doug-cli/tests/board-page.test.ts", "--reporter=json", "--outputFile", reportFile],
    { cwd: root, env, encoding: "utf8" },
  );
  if (!existsSync(reportFile)) {
    const tail = (s: string) => (s ?? "").slice(-2000);
    throw new Error(`nested vitest run produced no report file\nstdout:\n${tail(child.stdout)}\nstderr:\n${tail(child.stderr)}`);
  }
  const report = JSON.parse(readFileSync(reportFile, "utf8")) as Report;
  return { status: child.status, report };
}

function assertionsFor(report: Report, prefix: string): AssertionResult[] {
  return report.testResults.flatMap((r) => r.assertionResults).filter((a) => a.fullName.startsWith(prefix));
}

const listenDenied = await localListenerDenied();

describe("board page serve skip", () => {
  it(
    "skips the serve tests with a reason naming EPERM when listen fails with EPERM",
    () => {
      const env = {
        ...process.env,
        NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${stub}`].filter(Boolean).join(" "),
      };
      const { status, report } = runBoardPageTests(env);
      expect(status, describeFailures(report, status)).toBe(0);
      expect(report.numFailedTests, describeFailures(report, status)).toBe(0);
      const serve = assertionsFor(report, "doug board serve");
      const build = assertionsFor(report, "doug board build");
      expect(serve.length).toBe(18);
      for (const a of serve) {
        expect(a.status).toBe("skipped");
        expect(a.fullName).toContain("EPERM");
        expect(a.fullName).toContain("127.0.0.1");
      }
      expect(build.length).toBeGreaterThanOrEqual(1);
      for (const a of build) {
        expect(a.status).toBe("passed");
      }
    },
    60000,
  );

  it.skipIf(listenDenied !== "")(
    `runs all board page tests when listening works${listenDenied ? ` (${listenDenied})` : ""}`,
    () => {
      const { status, report } = runBoardPageTests(process.env);
      expect(status, describeFailures(report, status)).toBe(0);
      expect(report.numFailedTests, describeFailures(report, status)).toBe(0);
      expect(report.numPendingTests, describeFailures(report, status)).toBe(0);
      const serve = assertionsFor(report, "doug board serve");
      expect(serve.length).toBe(18);
      for (const a of serve) {
        expect(a.status).toBe("passed");
      }
    },
    60000,
  );
});
