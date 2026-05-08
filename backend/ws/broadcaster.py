"""WebSocket broadcasting — single connected_clients set + broadcast helper."""
from __future__ import annotations

from typing import Any

from fastapi import WebSocket


class Broadcaster:
    """Holds connected WebSocket clients and broadcasts JSON events to all."""

    def __init__(self) -> None:
        self._clients: set[WebSocket] = set()

    def add(self, ws: WebSocket) -> None:
        self._clients.add(ws)

    def remove(self, ws: WebSocket) -> None:
        self._clients.discard(ws)

    async def broadcast(self, event: dict[str, Any]) -> None:
        stale: list[WebSocket] = []
        for ws in self._clients:
            try:
                await ws.send_json(event)
            except Exception:
                stale.append(ws)
        for ws in stale:
            self._clients.discard(ws)


broadcaster = Broadcaster()
