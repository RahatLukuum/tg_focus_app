"""Anthropic Claude API client — Haiku 4.5 + prompt caching + auto-retry."""
from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Optional

from anthropic import AsyncAnthropic

logger = logging.getLogger(__name__)


DEFAULT_SYSTEM_PROMPT = (
    "Ты — помощник пользователя в Telegram-переписке. "
    "Сгенерируй подходящий ответ на последнее сообщение собеседника. "
    "Пиши кратко и по делу. Отвечай на том же языке, что и собеседник."
)


@dataclass(frozen=True)
class ClaudeConfig:
    """Immutable configuration for ClaudeClient.

    Args:
        api_key: Anthropic API key.
        model: Model identifier to use for completions.
        max_tokens: Maximum tokens in the generated response.
    """

    api_key: str
    model: str = "claude-haiku-4-5"
    max_tokens: int = 1024


class ClaudeClient:
    """Thin wrapper over AsyncAnthropic with system caching baked in.

    SDK auto-retries on 429/5xx with exponential backoff (max_retries=3).
    Callers should catch anthropic.APIStatusError to map to HTTP errors.
    """

    def __init__(self, cfg: ClaudeConfig) -> None:
        self._cfg = cfg
        self._client = AsyncAnthropic(api_key=cfg.api_key, max_retries=3)

    async def generate_reply(
        self,
        history: list[dict],
        system_prompt: Optional[str] = None,
    ) -> str:
        """Generate a reply from Claude given a conversation history.

        Args:
            history: List of message dicts with 'role' and 'content' keys.
            system_prompt: Optional override for the system prompt. Defaults
                to DEFAULT_SYSTEM_PROMPT when not provided.

        Returns:
            Concatenated text from all text blocks in the response, stripped
            of leading/trailing whitespace.
        """
        sys_text = system_prompt or DEFAULT_SYSTEM_PROMPT
        resp = await self._client.messages.create(
            model=self._cfg.model,
            max_tokens=self._cfg.max_tokens,
            system=[
                {
                    "type": "text",
                    "text": sys_text,
                    "cache_control": {"type": "ephemeral"},
                }
            ],
            messages=history,
        )
        text_blocks = [b.text for b in resp.content if b.type == "text"]
        return "\n".join(text_blocks).strip()

    async def aclose(self) -> None:
        """Close the underlying HTTP client. Call from app lifespan shutdown."""
        await self._client.close()
