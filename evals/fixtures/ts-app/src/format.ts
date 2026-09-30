import type { Task } from "./model/task.js";

/** Renders a task as `#<id> [<status>] <title>`. */
export function formatTask(t: Task): string {
  return `#${t.id} [${t.status}] ${t.title}`;
}
