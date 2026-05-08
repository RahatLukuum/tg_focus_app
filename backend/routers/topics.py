"""GET /topics — list forum topics for a supergroup."""
from __future__ import annotations

from fastapi import APIRouter

from deps.auth import AuthDeps
from services.topics_service import TopicsService


def make_router(topics_service: TopicsService, auth: AuthDeps) -> APIRouter:
    router = APIRouter()

    @router.get("/topics")
    async def get_topics(chat_id: int, account: str = ""):
        # Ensures the account's client is authorized; raises 401 otherwise.
        await auth.get_authorized_client(account)
        topics = await topics_service.get_topics(account=account, chat_id=int(chat_id))
        return {"chat_id": int(chat_id), "topics": topics}

    return router
