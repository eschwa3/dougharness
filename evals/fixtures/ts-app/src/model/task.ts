/** A single tracked task. */
export type Status = "open" | "done";

export interface Task {
  id: number;
  title: string;
  status: Status;
  createdAt: string;
}

/** Creates a new, open task. Throws if the title is empty or whitespace-only. */
export function createTask(id: number, title: string, now: Date): Task {
  if (title.trim().length === 0) throw new Error("title must not be empty");
  return { id, title, status: "open", createdAt: now.toISOString() };
}
