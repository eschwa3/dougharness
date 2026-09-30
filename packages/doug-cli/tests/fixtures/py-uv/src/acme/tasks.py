"""A tiny in-memory task model, standard library only."""

from dataclasses import dataclass


@dataclass
class Task:
    title: str
    done: bool = False


def new_task(title: str) -> Task:
    return Task(title=title)


def complete_task(task: Task) -> Task:
    task.done = True
    return task
