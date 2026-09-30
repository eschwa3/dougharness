import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { Task } from "../model/task.js";

/** Loads tasks from a JSON file. A missing file is an empty list. */
export function loadTasks(path: string): Task[] {
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, "utf8");
  if (raw.trim().length === 0) return [];
  return JSON.parse(raw) as Task[];
}

/** Writes tasks to a JSON file. */
export function saveTasks(path: string, tasks: Task[]): void {
  writeFileSync(path, JSON.stringify(tasks, null, 2) + "\n");
}

/** The next unused id: one more than the highest existing id, or 1 when empty. */
export function nextId(tasks: Task[]): number {
  return tasks.reduce((max, t) => Math.max(max, t.id), 0) + 1;
}
