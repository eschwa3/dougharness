import { formatTask } from "../format.js";
import { loadTasks } from "../store/store.js";
import type { Ctx, CommandResult } from "../cli.js";

/** `list`: prints one line per task via `formatTask`, in id order, and `(no tasks)` when empty. */
export function list(_args: string[], ctx: Ctx): CommandResult {
  const tasks = [...loadTasks(ctx.storePath)].sort((a, b) => a.id - b.id);
  if (tasks.length === 0) return { code: 0, out: ["(no tasks)"], err: [] };
  return { code: 0, out: tasks.map((t) => formatTask(t)), err: [] };
}
