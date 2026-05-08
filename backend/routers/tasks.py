"""Tasks CRUD endpoint (TodoPage backend)."""
from __future__ import annotations

from dataclasses import asdict
from typing import Any

from fastapi import APIRouter, HTTPException

from services.task_store import TaskStore


def make_router(task_store: TaskStore) -> APIRouter:
    """Build and return an APIRouter with /tasks CRUD endpoints.

    Args:
        task_store: Injected TaskStore instance for persistence.

    Returns:
        Configured APIRouter.
    """
    router = APIRouter()

    @router.get("/tasks")
    async def list_tasks(account: str = "") -> dict[str, Any]:
        """Return all tasks, optionally filtered by account.

        Args:
            account: If provided, only return tasks for this account.

        Returns:
            Dict with ``tasks`` list.
        """
        tasks = await task_store.list(account=account)
        return {"tasks": [asdict(t) for t in tasks]}

    @router.post("/tasks")
    async def create_task(payload: dict[str, Any]) -> dict[str, Any]:
        """Create a new task.

        Args:
            payload: JSON body with ``text`` (required), plus optional
                     ``chat_id``, ``chat_title``, and ``account``.

        Returns:
            Dict with ``task`` containing the created task.

        Raises:
            HTTPException: 400 if text is missing or empty.
        """
        text = (payload.get("text") or "").strip()
        if not text:
            raise HTTPException(status_code=400, detail="text is required")
        chat_id_raw = payload.get("chat_id")
        chat_id = int(chat_id_raw) if chat_id_raw is not None else None
        chat_title = payload.get("chat_title")
        account = (payload.get("account") or "").strip()
        task = await task_store.create(
            text=text,
            chat_id=chat_id,
            chat_title=chat_title,
            account=account,
        )
        return {"task": asdict(task)}

    @router.patch("/tasks/{task_id}")
    async def patch_task(task_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        """Partially update a task.

        Args:
            task_id: ID of the task to update.
            payload: JSON body with optional ``done`` (bool) and/or ``text`` (str).

        Returns:
            Dict with ``task`` containing the updated task.

        Raises:
            HTTPException: 400 if neither ``done`` nor ``text`` is provided,
                           or if ``text`` is empty.
            HTTPException: 404 if the task is not found.
        """
        done = payload.get("done")
        text = payload.get("text")
        if done is None and text is None:
            raise HTTPException(status_code=400, detail="done or text is required")
        if text is not None:
            text = str(text).strip()
            if not text:
                raise HTTPException(status_code=400, detail="text cannot be empty")
        if done is not None:
            done = bool(done)
        updated = await task_store.update(task_id, done=done, text=text)
        if updated is None:
            raise HTTPException(status_code=404, detail="task not found")
        return {"task": asdict(updated)}

    # CRITICAL: /tasks/completed MUST be registered before /tasks/{task_id}
    # so FastAPI matches the literal path first.
    @router.delete("/tasks/completed")
    async def clear_completed(account: str = "") -> dict[str, Any]:
        """Delete all completed tasks, optionally scoped to an account.

        Args:
            account: If provided, only clear completed tasks for this account.

        Returns:
            Dict with ``ok`` and ``removed`` count.
        """
        removed = await task_store.clear_completed(account=account)
        return {"ok": True, "removed": removed}

    @router.delete("/tasks/{task_id}")
    async def delete_task(task_id: str) -> dict[str, Any]:
        """Delete a specific task by ID.

        Args:
            task_id: ID of the task to delete.

        Returns:
            Dict with ``ok: True``.

        Raises:
            HTTPException: 404 if the task is not found.
        """
        deleted = await task_store.delete(task_id)
        if not deleted:
            raise HTTPException(status_code=404, detail="task not found")
        return {"ok": True}

    return router
