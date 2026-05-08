"""AI reply generation via Anthropic Claude (Haiku 4.5)."""
from __future__ import annotations

import logging
from typing import Any, Optional

from anthropic import APIStatusError
from fastapi import APIRouter, HTTPException
from pyrogram import Client

from deps.auth import AuthDeps
from services.claude_client import ClaudeClient

logger = logging.getLogger(__name__)


async def _build_history(client: Client, chat_id: int, *, limit: int = 20) -> list[dict]:
    history: list[dict] = []
    async for m in client.get_chat_history(chat_id, limit=limit):
        text = (m.text or m.caption or "").strip()
        if text:
            role = "assistant" if m.outgoing else "user"
            history.append({"role": role, "content": text})
    history.reverse()
    return history


def make_router(
    claude: Optional[ClaudeClient],
    auth: AuthDeps,
) -> APIRouter:
    router = APIRouter()

    @router.post("/generate_reply")
    async def generate_reply(payload: dict[str, Any]):
        if claude is None:
            raise HTTPException(status_code=500, detail="ANTHROPIC_API_KEY not configured")
        chat_id_raw = payload.get("chat_id")
        if chat_id_raw is None:
            raise HTTPException(status_code=400, detail="chat_id is required")
        try:
            chat_id = int(chat_id_raw)
        except Exception:
            raise HTTPException(status_code=400, detail="invalid chat_id")
        account = str(payload.get("account", "")).strip()
        user_prompt = str(payload.get("prompt", "")).strip()

        client = await auth.get_authorized_client(account)
        history = await _build_history(client, chat_id, limit=20)
        if not history:
            raise HTTPException(status_code=400, detail="No messages to generate reply from")

        try:
            reply = await claude.generate_reply(
                history, system_prompt=user_prompt or None
            )
        except APIStatusError as e:
            error_type = getattr(e, "type", None) or ""
            logger.error(
                "Claude APIStatusError: type=%s status=%s message=%s",
                error_type,
                e.status_code,
                e.message,
            )
            if error_type == "rate_limit_error":
                raise HTTPException(status_code=429, detail="Claude rate limit, try again")
            if error_type == "overloaded_error":
                raise HTTPException(status_code=503, detail="Claude overloaded")
            raise HTTPException(status_code=502, detail=f"Claude API error: {e.message}")
        except Exception:
            logger.exception("Claude unexpected error")
            raise HTTPException(status_code=500, detail="Internal error")

        if not reply:
            raise HTTPException(status_code=500, detail="Empty response from Claude")
        return {"ok": True, "reply": reply}

    return router
