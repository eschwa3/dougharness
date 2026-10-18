// Usage-path scenarios P06 P07 P10: the flow track's plan lifecycle through the real plan.mjs on temp projects.
import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { planCli, planProject, planOf, readJson, writeJson } from "./fixture.mjs";

const planFile = (dir) => join(dir, ".doug/plan.json");
const reportFile = (dir) => join(dir, ".doug/.state/last-report.json");

describe("flow track usage paths", () => {
  it("P06 flow track: plan validate -> approve -> done with an ok report: status approved then done", () => {
    const dir = planProject();
    const v = planCli(dir, "validate");
    expect(v.status, v.stdout + v.stderr).toBe(0);
    const a = planCli(dir, "approve");
    expect(a.status, a.stderr).toBe(0);
    expect(readJson(planFile(dir)).status).toBe("approved");
    writeJson(reportFile(dir), { plan: "Scenario plan", ok: true, levels: [] });
    const d = planCli(dir, "done");
    expect(d.status, d.stderr).toBe(0);
    expect(readJson(planFile(dir)).status).toBe("done");
  });

  it("P06 an invalid plan is refused at approve and stays a draft", () => {
    const dir = planProject({ acceptance: [] });
    const a = planCli(dir, "approve");
    expect(a.status).not.toBe(0);
    expect(readJson(planFile(dir)).status).toBe("draft");
  });

  it("P07 swarm: plan.mjs set swarm on, approve, json shows swarm true; off clears it", () => {
    const dir = planProject();
    const s = planCli(dir, "set", "swarm", "on");
    expect(s.status, s.stderr).toBe(0);
    expect(planCli(dir, "approve").status).toBe(0);
    const j = planCli(dir, "json");
    expect(j.status, j.stderr).toBe(0);
    expect(JSON.parse(j.stdout).swarm).toBe(true);
    expect(planCli(dir, "set", "swarm", "off").status).toBe(0);
    expect(JSON.parse(planCli(dir, "json").stdout).swarm).not.toBe(true);
  });

  it("P10 replan: an approved plan with a not-ok report cannot be marked done, replan sends it back to draft", () => {
    const dir = planProject();
    expect(planCli(dir, "approve").status).toBe(0);
    writeJson(reportFile(dir), { plan: "Scenario plan", ok: false, stoppedAtLevel: 0, levels: [] });
    const d = planCli(dir, "done");
    expect(d.status).not.toBe(0);
    expect(d.stderr).toMatch(/not ok/);
    expect(readJson(planFile(dir)).status).toBe("approved");
    const r = planCli(dir, "replan");
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/draft again/);
    expect(readJson(planFile(dir)).status).toBe("draft");
  });

  it("P10 replan without a report is refused and the plan keeps its status", () => {
    const dir = planProject({ status: "approved" });
    const r = planCli(dir, "replan");
    expect(r.status).not.toBe(0);
    expect(readJson(planFile(dir)).status).toBe("approved");
  });
});
