import { describe, it, expect } from "vitest";
import { createTask } from "../src/model/task.js";

describe("createTask", () => {
  it("creates an open task with the given id, title, and createdAt", () => {
    const now = new Date("2024-01-01T00:00:00.000Z");
    expect(createTask(1, "Ship it", now)).toEqual({
      id: 1,
      title: "Ship it",
      status: "open",
      createdAt: "2024-01-01T00:00:00.000Z",
    });
  });

  it("throws on an empty or whitespace-only title", () => {
    const now = new Date();
    expect(() => createTask(1, "", now)).toThrow();
    expect(() => createTask(1, "   ", now)).toThrow();
  });
});
