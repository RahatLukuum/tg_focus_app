"""Telegram dialog folders + per-account archive state.

Wraps the Pyrogram raw method `messages.GetDialogFilters` and caches the
result for `ttl_seconds`. Archive state (set of archived chat_ids per account)
is updated externally via `set_archived()` — typically called from /bootstrap
when iterating dialogs (each dialog carries `dialog.folder_id == 1` if
archived).
"""
from __future__ import annotations

import logging
import time
from dataclasses import dataclass
from typing import Any, Optional

logger = logging.getLogger(__name__)

# Pyrogram raw imports are optional — only needed at runtime when calling
# Telegram. Tests inject mocked clients via the manager.
try:  # pragma: no cover - import-time guard, exercised by integration only
    from pyrogram.raw.functions.messages import GetDialogFilters  # type: ignore
except Exception:  # pragma: no cover
    GetDialogFilters = None  # type: ignore


@dataclass(frozen=True)
class Folder:
    """Immutable representation of a Telegram dialog folder (filter)."""

    id: int
    title: str
    chat_ids: tuple[int, ...]


class FolderService:
    """Loads + caches Telegram folder definitions; tracks archived chats.

    Cache key is the account string ("" for the default account).
    Archive set is independent of the folder cache and is mutated by callers.
    """

    def __init__(self, manager: Any, ttl_seconds: int = 60) -> None:
        self._manager = manager
        self._ttl = ttl_seconds
        self._cache: dict[str, tuple[float, dict[str, Any]]] = {}
        self._archived: dict[str, set[int]] = {}

    async def get_folders(self, account: str = "") -> dict[str, Any]:
        """Return ``{folders: [Folder...], chat_to_folders: {chat_id: [folder_id...]}}``.

        Excludes Telegram's pseudo "All chats" default filter (which has no
        ``include_peers`` attribute). On API error, returns an empty payload.

        Args:
            account: Account identifier string. Empty string uses default client.

        Returns:
            Dict with ``folders`` list and ``chat_to_folders`` mapping.
        """
        key = (account or "").strip()
        now = time.monotonic()
        cached = self._cache.get(key)
        if cached and (now - cached[0]) < self._ttl:
            return cached[1]

        client = self._client_for(key)
        await self._manager.ensure_connected(client)

        if GetDialogFilters is None:
            # Pyrogram raw missing — operating in test/sandbox mode.
            # In tests, the mock client's invoke() is used directly below;
            # this branch only triggers when the import itself failed.
            try:
                raw = await client.invoke(None)
                payload = self._parse_filters(raw)
            except Exception:
                logger.warning(
                    "GetDialogFilters failed for account=%r", key, exc_info=True
                )
                payload = {"folders": [], "chat_to_folders": {}}
        else:
            try:
                raw = await client.invoke(GetDialogFilters())
                payload = self._parse_filters(raw)
            except Exception:
                logger.warning(
                    "GetDialogFilters failed for account=%r", key, exc_info=True
                )
                payload = {"folders": [], "chat_to_folders": {}}

        self._cache[key] = (now, payload)
        return payload

    def invalidate(self, account: str = "") -> None:
        """Clear the cached folder data for the given account.

        Args:
            account: Account identifier string. Empty string uses default client.
        """
        self._cache.pop((account or "").strip(), None)

    def is_archived(self, account: str, chat_id: int) -> bool:
        """Return True if the given chat is in the archived set for the account.

        Args:
            account: Account identifier string.
            chat_id: Telegram chat ID (signed int).

        Returns:
            True if the chat is archived for this account.
        """
        return chat_id in self._archived.get((account or "").strip(), set())

    def get_cached_chat_folders(self, account: str, chat_id: int) -> list[int]:
        """Non-blocking cache lookup for handler hot-path.

        Returns [] if the cache hasn't been primed for this account yet.
        Reading the cache is synchronous and atomic — safe to call from
        within the same event loop as `get_folders()`.

        Args:
            account: Account identifier string.
            chat_id: Telegram chat ID (signed int).

        Returns:
            List of folder IDs the chat belongs to, or [] if not cached.
        """
        cached = self._cache.get((account or "").strip())
        if not cached:
            return []
        _ts, payload = cached
        return list(payload.get("chat_to_folders", {}).get(chat_id, []))

    def set_archived(self, account: str, chat_ids: set[int]) -> None:
        """Replace the archived-chats set for the given account.

        Args:
            account: Account identifier string.
            chat_ids: Full set of archived chat IDs (replaces previous set).
        """
        self._archived[(account or "").strip()] = set(chat_ids)

    def _client_for(self, account: str) -> Any:
        """Return the appropriate Pyrogram client for the given account key.

        Args:
            account: Stripped account identifier. Empty string means default.

        Returns:
            Pyrogram client instance.
        """
        if not account:
            return self._manager.default
        return self._manager.get_or_create(account)

    @staticmethod
    def _parse_filters(raw: Any) -> dict[str, Any]:
        """Parse raw Telegram dialog filters into structured payload.

        Args:
            raw: Raw response from GetDialogFilters — either a list or an
                 object with a ``.filters`` attribute.

        Returns:
            Dict with ``folders`` list of :class:`Folder` and
            ``chat_to_folders`` mapping chat IDs to folder ID lists.
        """
        # Some Pyrogram versions return a wrapper with a `.filters` attribute,
        # others return a list directly. Normalize.
        if hasattr(raw, "filters"):
            iterable = raw.filters
        else:
            iterable = raw

        folders: list[Folder] = []
        chat_to_folders: dict[int, list[int]] = {}

        for f in iterable or []:
            # The default "All chats" filter has no include_peers.
            if not hasattr(f, "include_peers"):
                continue
            title = getattr(f, "title", None) or ""
            fid = getattr(f, "id", None)
            if fid is None:
                continue
            chat_ids: list[int] = []
            for peer in f.include_peers or []:
                cid = FolderService._peer_chat_id(peer)
                if cid is None:
                    continue
                chat_ids.append(cid)
                chat_to_folders.setdefault(cid, []).append(fid)
            folders.append(
                Folder(id=int(fid), title=str(title), chat_ids=tuple(chat_ids))
            )

        return {"folders": folders, "chat_to_folders": chat_to_folders}

    @staticmethod
    def _peer_chat_id(peer: Any) -> Optional[int]:
        """Map a raw peer to a signed chat_id matching Pyrogram's public convention.

        Pyrogram's public API uses these conventions for the chat_id field:
          - User: positive integer (e.g. 12345)
          - Basic legacy group: negative integer (e.g. -12345)
          - Supergroup/channel: -100<channel_id> (e.g. -1001234567890)

        Raw DialogFilter peers expose:
          - InputPeerUser.user_id   → positive
          - InputPeerChat.chat_id   → bare positive (legacy group)
          - InputPeerChannel.channel_id → bare positive (supergroup/channel)

        Args:
            peer: Raw Pyrogram peer object.

        Returns:
            Signed integer chat ID, or None if peer type is unrecognized.
        """
        if hasattr(peer, "user_id"):
            return int(peer.user_id)
        if hasattr(peer, "channel_id"):
            # Pyrogram public ID for supergroups/channels = -100<channel_id>
            return int(f"-100{int(peer.channel_id)}")
        if hasattr(peer, "chat_id"):
            # Legacy basic groups: negate the bare id
            return -int(peer.chat_id)
        return None
