"""Generic atomic-write JSON persistence with asyncio locking.

Designed for small (<1MB) state files like task lists and queue snapshots.
Not optimized for large blobs.
"""
from __future__ import annotations

import asyncio
import json
import logging
import tempfile
import time
from pathlib import Path
from typing import Callable, Generic, TypeVar

logger = logging.getLogger(__name__)

T = TypeVar("T")


class JsonStore(Generic[T]):
    """Atomic JSON persistence backed by a single file.

    All public methods are coroutines and use one asyncio.Lock per instance.
    Write strategy: serialize to a sibling .tmp file, fsync, rename over the
    target. This survives kill -9 mid-write — readers see either the old or
    the new content, never partial.
    """

    def __init__(
        self,
        path: Path,
        default_factory: Callable[[], T],
    ) -> None:
        self._path = Path(path)
        self._lock = asyncio.Lock()
        self._default_factory = default_factory
        self._path.parent.mkdir(parents=True, exist_ok=True)

    async def load(self) -> T:
        async with self._lock:
            return self._load_unlocked()

    async def save(self, data: T) -> None:
        async with self._lock:
            self._save_unlocked(data)

    async def update(self, mutator: Callable[[T], T]) -> T:
        """Read-modify-write under a single lock acquisition."""
        async with self._lock:
            current = self._load_unlocked()
            new_data = mutator(current)
            self._save_unlocked(new_data)
            return new_data

    def _load_unlocked(self) -> T:
        if not self._path.exists():
            return self._default_factory()
        try:
            return json.loads(self._path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError) as e:
            logger.error(
                "State file %s corrupted (%s) — using default and aside-renaming",
                self._path,
                e,
            )
            self._move_aside_corrupted()
            return self._default_factory()

    def _save_unlocked(self, data: T) -> None:
        tmp = tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            dir=self._path.parent,
            delete=False,
            suffix=".tmp",
        )
        tmp_path = Path(tmp.name)
        try:
            json.dump(data, tmp, ensure_ascii=False, indent=2, sort_keys=True)
            tmp.flush()
            try:
                import os as _os

                _os.fsync(tmp.fileno())
            except OSError:
                pass
            tmp.close()
            tmp_path.replace(self._path)
        except Exception:
            tmp.close()
            tmp_path.unlink(missing_ok=True)
            raise

    def _move_aside_corrupted(self) -> None:
        try:
            target = self._path.with_suffix(
                self._path.suffix + f".corrupted-{int(time.time())}"
            )
            self._path.rename(target)
            logger.warning("Renamed corrupted state to %s", target)
        except OSError:
            pass
