import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseFrontmatter } from "../lib/memory-import.mjs";
import { projectSlug } from "../lib/cost.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, "..", "scripts", "memory.mjs");

const run = (args, cwd) => spawnSync(process.execPath, [script, ...args], { cwd, encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: "" } });

function tempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

const HARNESS_FILE = `---
metadata:
  type: feedback
  modified: 2026-09-04T14:27:06.533Z
---
Commits in this repo carry no Co-Authored-By or Claude-Session lines.
`;

const BUILD_PROGRESS_FILE = `---
type: project
---
Week 2 delivered: gates, doug init, doug-flow exercised live.
`;

const BUILD_PROGRESS_FILE_V2 = `---
type: project
---
Week 2 delivered, revised: gates, doug init, doug-flow exercised live, plus the memory store.
`;

const REFERENCE_FILE = `---
type: reference
---
The Models table is parsed by plugins/doug-flow/lib/models.mjs.
`;

const EMPTY_FILE = `---
type: project
---


`;

const NO_FRONTMATTER_FILE = `Just a plain note, no frontmatter at all.
`;

function setupMemoryDir(claudeDir, projectDir) {
  const slug = projectSlug(projectDir);
  const memDir = join(claudeDir, "projects", slug, "memory");
  mkdirSync(memDir, { recursive: true });
  writeFileSync(join(memDir, "harness-project-decisions.md"), HARNESS_FILE, "utf8");
  writeFileSync(join(memDir, "doug-build-progress.md"), BUILD_PROGRESS_FILE, "utf8");
  writeFileSync(join(memDir, "reference-note.md"), REFERENCE_FILE, "utf8");
  writeFileSync(join(memDir, "empty-note.md"), EMPTY_FILE, "utf8");
  writeFileSync(join(memDir, "no-frontmatter.md"), NO_FRONTMATTER_FILE, "utf8");
  writeFileSync(join(memDir, "MEMORY.md"), "- [Harness project decisions](harness-project-decisions.md)\n", "utf8");
  return memDir;
}

function snapshotDir(memDir) {
  const names = readdirSync(memDir).sort();
  const snapshot = {};
  for (const name of names) {
    const filePath = join(memDir, name);
    snapshot[name] = { content: readFileSync(filePath, "utf8"), mtimeMs: statSync(filePath).mtimeMs };
  }
  return snapshot;
}

describe("parseFrontmatter", () => {
  it("reads nested metadata: children without letting them override a top-level key", () => {
    const { data, body } = parseFrontmatter(`---
type: top
metadata:
  type: nested
  modified: 2026-09-04T14:27:06.533Z
---
body text
`);
    expect(data.type).toBe("top");
    expect(data.modified).toBe("2026-09-04T14:27:06.533Z");
    expect(body.trim()).toBe("body text");
  });

  it("reads top-level key: value lines with no metadata block", () => {
    const { data, body } = parseFrontmatter(`---
type: project
---
plain body
`);
    expect(data).toEqual({ type: "project" });
    expect(body.trim()).toBe("plain body");
  });

  it("strips one pair of surrounding single or double quotes", () => {
    const { data } = parseFrontmatter(`---
type: "project"
title: 'hello world'
---
body
`);
    expect(data.type).toBe("project");
    expect(data.title).toBe("hello world");
  });

  it("returns data = {} and the whole text as body when there is no leading --- line", () => {
    const text = "no frontmatter here\nsecond line\n";
    const { data, body } = parseFrontmatter(text);
    expect(data).toEqual({});
    expect(body).toBe(text);
  });
});

describe("memory.mjs import", () => {
  it("imports auto memory into lessons, is idempotent, and supersedes on a rewritten file", () => {
    const projectDir = tempDir("doug-memory-import-project-");
    const claudeDir = tempDir("doug-memory-import-claude-");
    const memDir = setupMemoryDir(claudeDir, projectDir);
    const before = snapshotDir(memDir);

    // First import: 4 lessons added (feedback, project, reference->project, no-frontmatter->project), 1 skipped (empty body).
    const first = run(["import", projectDir, "--claude-dir", claudeDir], projectDir);
    expect(first.status, first.stderr).toBe(0);
    expect(first.stdout).toContain(
      `Imported 4 lesson(s) from ${memDir}: 4 added, 0 updated (old row superseded), 0 unchanged, 1 skipped (empty), 0 retired (file deleted).`
    );

    const listed = run(["lessons", projectDir, "--json"], projectDir);
    expect(listed.status, listed.stderr).toBe(0);
    const rows = JSON.parse(listed.stdout);
    expect(rows).toHaveLength(4);
    expect(rows.some((r) => r.text.includes("MEMORY.md"))).toBe(false);
    expect(rows.some((r) => r.text.includes("empty"))).toBe(false);

    const harnessRow = rows.find((r) => r.text.includes("Co-Authored-By"));
    expect(harnessRow.kind).toBe("feedback");
    expect(harnessRow.created).toBe("2026-09-04T14:27:06.533Z");
    expect(harnessRow.citation).toBe(join(memDir, "harness-project-decisions.md"));
    expect(harnessRow.source_agent).toBe("auto-memory");

    const buildRow = rows.find((r) => r.text.includes("Week 2 delivered:"));
    expect(buildRow.kind).toBe("project");
    expect(Number.isFinite(Date.parse(buildRow.created))).toBe(true);

    const referenceRow = rows.find((r) => r.text.includes("Models table"));
    expect(referenceRow.kind).toBe("project");

    const noFrontmatterRow = rows.find((r) => r.text.includes("plain note"));
    expect(noFrontmatterRow.kind).toBe("project");

    expect(snapshotDir(memDir)).toEqual(before);

    // Second import: nothing changed on disk, so everything is unchanged.
    const second = run(["import", projectDir, "--claude-dir", claudeDir], projectDir);
    expect(second.status, second.stderr).toBe(0);
    expect(second.stdout).toContain(
      `Imported 0 lesson(s) from ${memDir}: 0 added, 0 updated (old row superseded), 4 unchanged, 1 skipped (empty), 0 retired (file deleted).`
    );
    expect(snapshotDir(memDir)).toEqual(before);

    // Rewrite one topic file's body, then import a third time.
    writeFileSync(join(memDir, "doug-build-progress.md"), BUILD_PROGRESS_FILE_V2, "utf8");
    const rewritten = snapshotDir(memDir);
    const third = run(["import", projectDir, "--claude-dir", claudeDir], projectDir);
    expect(third.status, third.stderr).toBe(0);
    expect(third.stdout).toContain(
      `Imported 1 lesson(s) from ${memDir}: 0 added, 1 updated (old row superseded), 3 unchanged, 1 skipped (empty), 0 retired (file deleted).`
    );
    expect(snapshotDir(memDir)).toEqual(rewritten);

    const all = JSON.parse(run(["lessons", projectDir, "--all", "--json"], projectDir).stdout);
    expect(all).toHaveLength(5);
    const oldBuildRow = all.find((r) => r.text.includes("Week 2 delivered:") && !r.text.includes("revised"));
    const newBuildRow = all.find((r) => r.text.includes("revised"));
    expect(oldBuildRow.superseded_by).toBe(newBuildRow.id);

    const stillActive = JSON.parse(run(["lessons", projectDir, "--json"], projectDir).stdout);
    expect(stillActive).toHaveLength(4);
    expect(stillActive.some((r) => r.id === oldBuildRow.id)).toBe(false);
    expect(stillActive.some((r) => r.id === newBuildRow.id)).toBe(true);

    rmSync(projectDir, { recursive: true, force: true });
    rmSync(claudeDir, { recursive: true, force: true });
  });

  it("no-clobber: a hand-authored lesson sharing an import's future citation is never superseded or duplicated by that import, which supersedes only its own prior row", () => {
    const projectDir = tempDir("doug-memory-import-no-clobber-project-");
    const claudeDir = tempDir("doug-memory-import-no-clobber-claude-");
    const slug = projectSlug(projectDir);
    const memDir = join(claudeDir, "projects", slug, "memory");
    mkdirSync(memDir, { recursive: true });
    const topicFile = join(memDir, "topic.md");
    writeFileSync(topicFile, BUILD_PROGRESS_FILE, "utf8");
    // The path importAutoMemory will use as the imported row's citation (memory-import.mjs:116).
    const futureCitation = topicFile;

    // A hand-authored lesson (default source-agent) deliberately citing that same path, added before any import.
    const handAdd = run(["lesson", "add", "--text", "Hand-authored note about the same file.", "--kind", "pattern", "--citation", futureCitation, projectDir, "--json"], projectDir);
    expect(handAdd.status, handAdd.stderr).toBe(0);
    const handRow = JSON.parse(handAdd.stdout);
    expect(handRow.source_agent).toBe("lead");

    // First import: must add its own row alongside the hand-authored one, not touch it.
    const first = run(["import", projectDir, "--claude-dir", claudeDir], projectDir);
    expect(first.status, first.stderr).toBe(0);
    expect(first.stdout).toContain("1 added, 0 updated");

    const afterFirst = JSON.parse(run(["lessons", projectDir, "--json"], projectDir).stdout);
    expect(afterFirst).toHaveLength(2);
    const handStillThere = afterFirst.find((r) => r.id === handRow.id);
    expect(handStillThere).toBeDefined();
    expect(handStillThere.superseded_by).toBeFalsy();
    const importedRow = afterFirst.find((r) => r.id !== handRow.id);
    expect(importedRow.source_agent).toBe("auto-memory");
    expect(importedRow.citation).toBe(futureCitation);

    // Rewrite the fixture file and import again: only the import's own prior row may be superseded.
    writeFileSync(topicFile, BUILD_PROGRESS_FILE_V2, "utf8");
    const second = run(["import", projectDir, "--claude-dir", claudeDir], projectDir);
    expect(second.status, second.stderr).toBe(0);
    expect(second.stdout).toContain("1 updated (old row superseded)");

    const active = JSON.parse(run(["lessons", projectDir, "--json"], projectDir).stdout);
    expect(active).toHaveLength(2);
    expect(active.some((r) => r.id === handRow.id)).toBe(true);
    const handAfterSecond = active.find((r) => r.id === handRow.id);
    expect(handAfterSecond.superseded_by).toBeFalsy();

    const all = JSON.parse(run(["lessons", projectDir, "--all", "--json"], projectDir).stdout);
    expect(all).toHaveLength(3);
    const oldImportRow = all.find((r) => r.id === importedRow.id);
    expect(oldImportRow.superseded_by).toBeTruthy();
    const newImportRow = all.find((r) => r.text.includes("revised"));
    expect(oldImportRow.superseded_by).toBe(newImportRow.id);
    // The hand-authored row is never the one superseded.
    const handRowInAll = all.find((r) => r.id === handRow.id);
    expect(handRowInAll.superseded_by).toBeFalsy();

    rmSync(projectDir, { recursive: true, force: true });
    rmSync(claudeDir, { recursive: true, force: true });
  });

  it("supersedes a same-named file's row even when the rewritten import comes from a different auto-memory dir (basename key, not the absolute citation path)", () => {
    const projectDir = tempDir("doug-memory-import-diffdir-project-");
    const claudeDirA = tempDir("doug-memory-import-diffdir-claudeA-");
    const claudeDirB = tempDir("doug-memory-import-diffdir-claudeB-");
    const slug = projectSlug(projectDir);
    const memDirA = join(claudeDirA, "projects", slug, "memory");
    mkdirSync(memDirA, { recursive: true });
    writeFileSync(join(memDirA, "topic.md"), BUILD_PROGRESS_FILE, "utf8");

    // First import from auto-memory dir A.
    const first = run(["import", projectDir, "--claude-dir", claudeDirA], projectDir);
    expect(first.status, first.stderr).toBe(0);
    expect(first.stdout).toContain("1 added, 0 updated");

    const afterFirst = JSON.parse(run(["lessons", projectDir, "--json"], projectDir).stdout);
    expect(afterFirst).toHaveLength(1);
    const firstRow = afterFirst[0];
    expect(firstRow.citation).toBe(join(memDirA, "topic.md"));

    // Same file name, rewritten body, imported from a different auto-memory dir B: the doc's claim is that
    // this still supersedes the row the first import wrote, regardless of where the auto-memory dir lives.
    const memDirB = join(claudeDirB, "projects", slug, "memory");
    mkdirSync(memDirB, { recursive: true });
    writeFileSync(join(memDirB, "topic.md"), BUILD_PROGRESS_FILE_V2, "utf8");

    const second = run(["import", projectDir, "--claude-dir", claudeDirB], projectDir);
    expect(second.status, second.stderr).toBe(0);
    expect(second.stdout).toContain("1 updated (old row superseded)");

    const active = JSON.parse(run(["lessons", projectDir, "--json"], projectDir).stdout);
    expect(active).toHaveLength(1);
    const newRow = active[0];
    expect(newRow.citation).toBe(join(memDirB, "topic.md"));
    expect(newRow.text).toContain("revised");

    const all = JSON.parse(run(["lessons", projectDir, "--all", "--json"], projectDir).stdout);
    expect(all).toHaveLength(2);
    const oldRow = all.find((r) => r.id === firstRow.id);
    expect(oldRow.superseded_by).toBe(newRow.id);

    rmSync(projectDir, { recursive: true, force: true });
    rmSync(claudeDirA, { recursive: true, force: true });
    rmSync(claudeDirB, { recursive: true, force: true });
  });

  it("prints 'no auto memory at <dir>' and exits 0 when the project has no auto-memory directory", () => {
    const projectDir = tempDir("doug-memory-import-empty-project-");
    const claudeDir = tempDir("doug-memory-import-empty-claude-");
    const res = run(["import", projectDir, "--claude-dir", claudeDir], projectDir);
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toContain("no auto memory at");
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(claudeDir, { recursive: true, force: true });
  });
});

// Card memory-import-retires-deleted: a rewritten auto-memory file supersedes its prior row (covered above),
// but until this behaviour lands a *deleted* file's lesson stays live and recallable forever. These cases cover
// retiring (marking `stale`) the lessons of files no longer present under the auto-memory dir.
describe("memory.mjs import: retires a deleted auto-memory file's lesson", () => {
  it("T1: a deleted file's lesson is retired (stale set), no longer recalled, and the summary reports it", () => {
    const projectDir = tempDir("doug-memory-retire-deleted-project-");
    const claudeDir = tempDir("doug-memory-retire-deleted-claude-");
    const slug = projectSlug(projectDir);
    const memDir = join(claudeDir, "projects", slug, "memory");
    mkdirSync(memDir, { recursive: true });
    writeFileSync(join(memDir, "a.md"), HARNESS_FILE, "utf8");
    writeFileSync(join(memDir, "b.md"), BUILD_PROGRESS_FILE, "utf8");

    const first = run(["import", projectDir, "--claude-dir", claudeDir], projectDir);
    expect(first.status, first.stderr).toBe(0);
    expect(first.stdout).toContain("2 added, 0 updated");

    const before = JSON.parse(run(["lessons", projectDir, "--json"], projectDir).stdout);
    const aRow = before.find((r) => r.citation === join(memDir, "a.md"));
    expect(aRow).toBeDefined();
    expect(aRow.stale).toBeFalsy();

    unlinkSync(join(memDir, "a.md"));
    const second = run(["import", projectDir, "--claude-dir", claudeDir], projectDir);
    expect(second.status, second.stderr).toBe(0);
    expect(second.stdout).toContain(
      `Imported 0 lesson(s) from ${memDir}: 0 added, 0 updated (old row superseded), 1 unchanged, 0 skipped (empty), 1 retired (file deleted).`
    );

    const after = JSON.parse(run(["lessons", projectDir, "--json"], projectDir).stdout);
    const aRowAfter = after.find((r) => r.id === aRow.id);
    expect(aRowAfter).toBeDefined();
    expect(aRowAfter.stale).toBeTruthy();

    const recalled = JSON.parse(run(["recall", "Co-Authored-By", projectDir, "--json"], projectDir).stdout);
    expect(recalled.lessons.some((l) => l.id === aRow.id)).toBe(false);

    rmSync(projectDir, { recursive: true, force: true });
    rmSync(claudeDir, { recursive: true, force: true });
  });

  it("T2: an unchanged sibling file's lesson stays live and recallable while another file is retired", () => {
    const projectDir = tempDir("doug-memory-retire-unchanged-project-");
    const claudeDir = tempDir("doug-memory-retire-unchanged-claude-");
    const slug = projectSlug(projectDir);
    const memDir = join(claudeDir, "projects", slug, "memory");
    mkdirSync(memDir, { recursive: true });
    writeFileSync(join(memDir, "a.md"), HARNESS_FILE, "utf8");
    writeFileSync(join(memDir, "b.md"), BUILD_PROGRESS_FILE, "utf8");

    run(["import", projectDir, "--claude-dir", claudeDir], projectDir);
    const bBefore = JSON.parse(run(["lessons", projectDir, "--json"], projectDir).stdout).find(
      (r) => r.citation === join(memDir, "b.md")
    );
    expect(bBefore).toBeDefined();

    unlinkSync(join(memDir, "a.md"));
    const second = run(["import", projectDir, "--claude-dir", claudeDir], projectDir);
    expect(second.stdout).toContain("1 retired (file deleted).");

    const bAfter = JSON.parse(run(["lessons", projectDir, "--json"], projectDir).stdout).find((r) => r.id === bBefore.id);
    expect(bAfter).toBeDefined();
    expect(bAfter.stale).toBeFalsy();

    const recalled = JSON.parse(run(["recall", "Week 2 delivered", projectDir, "--json"], projectDir).stdout);
    expect(recalled.lessons.some((l) => l.id === bBefore.id)).toBe(true);

    rmSync(projectDir, { recursive: true, force: true });
    rmSync(claudeDir, { recursive: true, force: true });
  });

  it("T3: a hand-authored lesson whose citation basename matches no current file is never marked stale", () => {
    const projectDir = tempDir("doug-memory-retire-hand-project-");
    const claudeDir = tempDir("doug-memory-retire-hand-claude-");
    const slug = projectSlug(projectDir);
    const memDir = join(claudeDir, "projects", slug, "memory");
    mkdirSync(memDir, { recursive: true });
    writeFileSync(join(memDir, "topic.md"), BUILD_PROGRESS_FILE, "utf8");

    const ghostCitation = join(memDir, "ghost.md");
    const handAdd = run(
      [
        "lesson",
        "add",
        "--text",
        "Hand-authored note citing a file that was never imported.",
        "--kind",
        "pattern",
        "--citation",
        ghostCitation,
        projectDir,
        "--json",
      ],
      projectDir
    );
    expect(handAdd.status, handAdd.stderr).toBe(0);
    const handRow = JSON.parse(handAdd.stdout);
    expect(handRow.source_agent).toBe("lead");
    expect(handRow.stale).toBeFalsy();

    const imported = run(["import", projectDir, "--claude-dir", claudeDir], projectDir);
    expect(imported.status, imported.stderr).toBe(0);
    expect(imported.stdout).toContain("0 retired (file deleted).");

    const after = JSON.parse(run(["lessons", projectDir, "--json"], projectDir).stdout).find((r) => r.id === handRow.id);
    expect(after).toBeDefined();
    expect(after.stale).toBeFalsy();

    rmSync(projectDir, { recursive: true, force: true });
    rmSync(claudeDir, { recursive: true, force: true });
  });

  it("T4: a missing auto-memory directory retires nothing", () => {
    const projectDir = tempDir("doug-memory-retire-missing-project-");
    const claudeDirSeed = tempDir("doug-memory-retire-missing-seed-");
    const slug = projectSlug(projectDir);
    const memDirSeed = join(claudeDirSeed, "projects", slug, "memory");
    mkdirSync(memDirSeed, { recursive: true });
    writeFileSync(join(memDirSeed, "seed.md"), BUILD_PROGRESS_FILE, "utf8");

    const seeded = run(["import", projectDir, "--claude-dir", claudeDirSeed], projectDir);
    expect(seeded.status, seeded.stderr).toBe(0);
    expect(seeded.stdout).toContain("1 added, 0 updated");
    const seededRow = JSON.parse(run(["lessons", projectDir, "--json"], projectDir).stdout)[0];
    expect(seededRow.stale).toBeFalsy();

    rmSync(claudeDirSeed, { recursive: true, force: true });

    const claudeDirMissing = tempDir("doug-memory-retire-missing-claude-");
    const res = run(["import", projectDir, "--claude-dir", claudeDirMissing], projectDir);
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toContain("no auto memory at");

    const after = JSON.parse(run(["lessons", projectDir, "--json"], projectDir).stdout).find((r) => r.id === seededRow.id);
    expect(after).toBeDefined();
    expect(after.stale).toBeFalsy();

    rmSync(projectDir, { recursive: true, force: true });
    rmSync(claudeDirMissing, { recursive: true, force: true });
  });

  it("T6: re-creating a deleted file with identical content restores (un-stales) its lesson", () => {
    const projectDir = tempDir("doug-memory-retire-restore-project-");
    const claudeDir = tempDir("doug-memory-retire-restore-claude-");
    const slug = projectSlug(projectDir);
    const memDir = join(claudeDir, "projects", slug, "memory");
    mkdirSync(memDir, { recursive: true });
    writeFileSync(join(memDir, "a.md"), HARNESS_FILE, "utf8");

    run(["import", projectDir, "--claude-dir", claudeDir], projectDir);
    const beforeId = JSON.parse(run(["lessons", projectDir, "--json"], projectDir).stdout)[0].id;

    unlinkSync(join(memDir, "a.md"));
    const retired = run(["import", projectDir, "--claude-dir", claudeDir], projectDir);
    expect(retired.stdout).toContain("1 retired (file deleted).");
    const staleRow = JSON.parse(run(["lessons", projectDir, "--json"], projectDir).stdout).find((r) => r.id === beforeId);
    expect(staleRow.stale).toBeTruthy();

    writeFileSync(join(memDir, "a.md"), HARNESS_FILE, "utf8");
    const restored = run(["import", projectDir, "--claude-dir", claudeDir], projectDir);
    expect(restored.status, restored.stderr).toBe(0);
    expect(restored.stdout).toContain(
      `Imported 0 lesson(s) from ${memDir}: 0 added, 0 updated (old row superseded), 1 unchanged, 0 skipped (empty), 0 retired (file deleted).`
    );

    const afterRestore = JSON.parse(run(["lessons", projectDir, "--json"], projectDir).stdout).find((r) => r.id === beforeId);
    expect(afterRestore).toBeDefined();
    expect(afterRestore.stale).toBeFalsy();

    const recalled = JSON.parse(run(["recall", "Co-Authored-By", projectDir, "--json"], projectDir).stdout);
    expect(recalled.lessons.some((l) => l.id === beforeId)).toBe(true);

    rmSync(projectDir, { recursive: true, force: true });
    rmSync(claudeDir, { recursive: true, force: true });
  });

  it("T7: a live row is not retired when a same-named, same-content file exists under a different auto-memory dir (basename key, not the absolute citation path)", () => {
    const projectDir = tempDir("doug-memory-retire-basename-project-");
    const claudeDirA = tempDir("doug-memory-retire-basename-claudeA-");
    const claudeDirB = tempDir("doug-memory-retire-basename-claudeB-");
    const slug = projectSlug(projectDir);
    const memDirA = join(claudeDirA, "projects", slug, "memory");
    mkdirSync(memDirA, { recursive: true });
    writeFileSync(join(memDirA, "topic.md"), BUILD_PROGRESS_FILE, "utf8");

    const first = run(["import", projectDir, "--claude-dir", claudeDirA], projectDir);
    expect(first.status, first.stderr).toBe(0);
    const row = JSON.parse(run(["lessons", projectDir, "--json"], projectDir).stdout)[0];
    expect(row.citation).toBe(join(memDirA, "topic.md"));

    // Same basename, identical content, a totally different auto-memory dir: the file is read as "unchanged"
    // (same id), so the row's own citation is never rewritten to point at dir B.
    const memDirB = join(claudeDirB, "projects", slug, "memory");
    mkdirSync(memDirB, { recursive: true });
    writeFileSync(join(memDirB, "topic.md"), BUILD_PROGRESS_FILE, "utf8");

    const second = run(["import", projectDir, "--claude-dir", claudeDirB], projectDir);
    expect(second.status, second.stderr).toBe(0);
    expect(second.stdout).toContain(
      `Imported 0 lesson(s) from ${memDirB}: 0 added, 0 updated (old row superseded), 1 unchanged, 0 skipped (empty), 0 retired (file deleted).`
    );

    const after = JSON.parse(run(["lessons", projectDir, "--json"], projectDir).stdout).find((r) => r.id === row.id);
    expect(after).toBeDefined();
    expect(after.stale).toBeFalsy();
    expect(after.citation).toBe(join(memDirA, "topic.md"));

    rmSync(projectDir, { recursive: true, force: true });
    rmSync(claudeDirA, { recursive: true, force: true });
    rmSync(claudeDirB, { recursive: true, force: true });
  });

  it("T8: a later no-op import does not re-count an already-stale row as retired", () => {
    const projectDir = tempDir("doug-memory-retire-idempotent-project-");
    const claudeDir = tempDir("doug-memory-retire-idempotent-claude-");
    const slug = projectSlug(projectDir);
    const memDir = join(claudeDir, "projects", slug, "memory");
    mkdirSync(memDir, { recursive: true });
    writeFileSync(join(memDir, "a.md"), HARNESS_FILE, "utf8");
    writeFileSync(join(memDir, "b.md"), BUILD_PROGRESS_FILE, "utf8");

    run(["import", projectDir, "--claude-dir", claudeDir], projectDir);
    unlinkSync(join(memDir, "a.md"));
    const second = run(["import", projectDir, "--claude-dir", claudeDir], projectDir);
    expect(second.stdout).toContain("1 retired (file deleted).");

    const third = run(["import", projectDir, "--claude-dir", claudeDir], projectDir);
    expect(third.status, third.stderr).toBe(0);
    expect(third.stdout).toContain(
      `Imported 0 lesson(s) from ${memDir}: 0 added, 0 updated (old row superseded), 1 unchanged, 0 skipped (empty), 0 retired (file deleted).`
    );

    rmSync(projectDir, { recursive: true, force: true });
    rmSync(claudeDir, { recursive: true, force: true });
  });
});
