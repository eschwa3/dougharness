import { createTask } from "../model/task.js";
import { loadTasks, nextId, saveTasks } from "../store/store.js";
import type { Ctx, CommandResult } from "../cli.js";

/** `add <title>`: creates a task and prints `added #<id> <title>`. */
export function add(args: string[], ctx: Ctx): CommandResult {
  const title = args.join(" ");
  const tasks = loadTasks(ctx.storePath);
  let task;
  try {
    task = createTask(nextId(tasks), title, ctx.now());
  } catch (err) {
    return { code: 1, out: [], err: [(err as Error).message] };
  }
  tasks.push(task);
  saveTasks(ctx.storePath, tasks);
  return { code: 0, out: [`added #${task.id} ${task.title}`], err: [] };
}
