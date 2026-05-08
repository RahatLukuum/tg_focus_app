"""Task storage backed by JsonStore — persistent CRUD for TodoPage."""
from __future__ import annotations

import time
import uuid
from dataclasses import asdict, dataclass
from typing import Any, Optional

from services.state_store import JsonStore


@dataclass(frozen=True)
class Task:
    """Immutable task record persisted to JSON.

    Attributes:
        id: UUID4 string identifier.
        text: Task description text.
        done: Completion flag.
        created_at: Unix timestamp (seconds) of creation.
        chat_id: Optional Telegram chat ID for task source.
        chat_title: Optional human-readable chat title.
        account: Optional phone/account string for multi-account filtering.
    """

    id: str
    text: str
    done: bool
    created_at: int
    chat_id: Optional[int] = None
    chat_title: Optional[str] = None
    account: Optional[str] = None

    def to_dict(self) -> dict[str, Any]:
        """Serialize to plain dict for JSON storage."""
        return asdict(self)

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "Task":
        """Deserialize from a JSON-loaded dict.

        Args:
            d: Dictionary with task fields.

        Returns:
            Reconstructed Task instance.
        """
        return cls(
            id=d["id"],
            text=d["text"],
            done=bool(d["done"]),
            created_at=int(d["created_at"]),
            chat_id=d.get("chat_id"),
            chat_title=d.get("chat_title"),
            account=d.get("account"),
        )


class TaskStore:
    """CRUD over a list-of-Task JsonStore.

    All mutations are atomic via the underlying JsonStore lock.
    """

    def __init__(self, store: JsonStore) -> None:
        self._store = store

    async def list(self, account: str = "") -> list[Task]:
        """Return all tasks, optionally filtered by account.

        Args:
            account: If non-empty, return only tasks matching this account.

        Returns:
            List of Task objects.
        """
        data = await self._store.load()
        tasks = [Task.from_dict(d) for d in data]
        if account:
            tasks = [t for t in tasks if t.account == account]
        return tasks

    async def create(
        self,
        text: str,
        *,
        chat_id: Optional[int] = None,
        chat_title: Optional[str] = None,
        account: str = "",
    ) -> Task:
        """Create and persist a new task.

        Args:
            text: Task description.
            chat_id: Optional source chat ID.
            chat_title: Optional source chat title.
            account: Optional account identifier.

        Returns:
            Newly created Task instance.
        """
        task = Task(
            id=str(uuid.uuid4()),
            text=text,
            done=False,
            created_at=int(time.time()),
            chat_id=chat_id,
            chat_title=chat_title,
            account=account or None,
        )
        await self._store.update(lambda data: data + [task.to_dict()])
        return task

    async def update(
        self,
        task_id: str,
        *,
        done: Optional[bool] = None,
        text: Optional[str] = None,
    ) -> Optional[Task]:
        """Update an existing task's fields.

        Args:
            task_id: ID of the task to update.
            done: If provided, set the completion flag.
            text: If provided, replace the task text.

        Returns:
            Updated Task, or None if task_id not found.
        """
        if done is None and text is None:
            return await self._get(task_id)

        found: list[Optional[Task]] = [None]

        def mutator(data: list[dict[str, Any]]) -> list[dict[str, Any]]:
            new_data: list[dict[str, Any]] = []
            for d in data:
                if d["id"] == task_id:
                    if done is not None:
                        d = {**d, "done": bool(done)}
                    if text is not None:
                        d = {**d, "text": text}
                    found[0] = Task.from_dict(d)
                new_data.append(d)
            return new_data

        await self._store.update(mutator)
        return found[0]

    async def delete(self, task_id: str) -> bool:
        """Delete a task by ID.

        Args:
            task_id: ID of the task to remove.

        Returns:
            True if a task was removed, False if not found.
        """
        deleted = [False]

        def mutator(data: list[dict[str, Any]]) -> list[dict[str, Any]]:
            kept = [d for d in data if d["id"] != task_id]
            if len(kept) != len(data):
                deleted[0] = True
            return kept

        await self._store.update(mutator)
        return deleted[0]

    async def clear_completed(self, account: str = "") -> int:
        """Remove all completed tasks, optionally scoped to an account.

        Args:
            account: If non-empty, only clear completed tasks for this account.

        Returns:
            Number of tasks removed.
        """
        removed = [0]

        def mutator(data: list[dict[str, Any]]) -> list[dict[str, Any]]:
            kept: list[dict[str, Any]] = []
            for d in data:
                if d["done"] and (not account or d.get("account") == account):
                    removed[0] += 1
                    continue
                kept.append(d)
            return kept

        await self._store.update(mutator)
        return removed[0]

    async def _get(self, task_id: str) -> Optional[Task]:
        """Fetch a single task by ID without modification.

        Args:
            task_id: ID to look up.

        Returns:
            Matching Task or None.
        """
        for t in await self.list():
            if t.id == task_id:
                return t
        return None
