import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadTasks, saveTasks, nextId } from "../src/store/store.js";
import type { Task } from "../src/model/task.js";

describe("store", () => {
  it("loadTasks returns an empty list for a missing file", () => {
    const path = join(mkdtempSync(join(tmpdir(), "ts-app-store-")), "tasks.json");
    expect(loadTasks(path)).toEqual([]);
  });

  it("round-trips tasks through saveTasks and loadTasks", () => {
    const path = join(mkdtempSync(join(tmpdir(), "ts-app-store-")), "tasks.json");
    const tasks: Task[] = [{ id: 1, title: "First", status: "open", createdAt: "2024-01-01T00:00:00.000Z" }];
    saveTasks(path, tasks);
    expect(loadTasks(path)).toEqual(tasks);
  });

  it("nextId is one more than the highest existing id, or 1 when empty", () => {
    expect(nextId([])).toBe(1);
    expect(
      nextId([
        { id: 1, title: "a", status: "open", createdAt: "x" },
        { id: 5, title: "b", status: "open", createdAt: "x" },
      ])
    ).toBe(6);
  });
});
