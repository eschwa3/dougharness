from acme.tasks import complete_task, new_task


def test_new_task_starts_incomplete():
    task = new_task("write tests")
    assert task.done is False


def test_complete_task_marks_done():
    task = complete_task(new_task("ship it"))
    assert task.done is True
