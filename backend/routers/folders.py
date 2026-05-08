"""Folders endpoint — exposes Telegram dialog filters to the frontend."""
from __future__ import annotations

from dataclasses import asdict

from fastapi import APIRouter

from services.folder_service import FolderService


def make_router(folder_service: FolderService) -> APIRouter:
    """Create and return an APIRouter with the /folders endpoint.

    Args:
        folder_service: Service instance for retrieving folder data.

    Returns:
        Configured APIRouter.
    """
    router = APIRouter()

    @router.get("/folders")
    async def get_folders(account: str = ""):
        payload = await folder_service.get_folders(account=account)
        return {
            "folders": [asdict(f) for f in payload["folders"]],
            # Convert chat_ids tuples → lists so JSON serializes naturally.
            "chat_to_folders": {
                str(k): list(v) for k, v in payload["chat_to_folders"].items()
            },
        }

    return router
