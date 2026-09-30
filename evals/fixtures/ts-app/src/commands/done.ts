import { loadTasks, saveTasks } from "../store/store.js";
import type { Ctx, CommandResult } from "../cli.js";

/** `done <id>`: marks a task done and prints `done #<id>`. An unknown id is code 1, err names it. */
export function done(args: string[], ctx: Ctx): CommandResult {
  const id = Number(args[0]);
  const tasks = loadTasks(ctx.storePath);
  const task = tasks.find((t) => t.id === id);
  if (!task) return { code: 1, out: [], err: [`no such task: ${args[0]}`] };
  task.status = "done";
  saveTasks(ctx.storePath, tasks);
  return { code: 0, out: [`done #${task.id}`], err: [] };
}
