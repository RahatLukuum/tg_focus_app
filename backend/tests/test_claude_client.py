"""Tests for services.claude_client.ClaudeClient (mocked Anthropic SDK)."""
from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from services.claude_client import ClaudeClient, ClaudeConfig, DEFAULT_SYSTEM_PROMPT


def make_response(text: str):
    block = SimpleNamespace(type="text", text=text)
    return SimpleNamespace(content=[block])


@pytest.fixture
def cfg() -> ClaudeConfig:
    return ClaudeConfig(api_key="sk-test", model="claude-haiku-4-5", max_tokens=512)


async def test_generate_reply_returns_concatenated_text(cfg: ClaudeConfig):
    client = ClaudeClient(cfg)
    mock_create = AsyncMock(return_value=make_response("hello world"))
    client._client = MagicMock()
    client._client.messages = MagicMock()
    client._client.messages.create = mock_create

    history = [{"role": "user", "content": "hi"}]
    reply = await client.generate_reply(history)
    assert reply == "hello world"


async def test_generate_reply_applies_default_system_prompt(cfg: ClaudeConfig):
    client = ClaudeClient(cfg)
    mock_create = AsyncMock(return_value=make_response("ok"))
    client._client = MagicMock()
    client._client.messages = MagicMock()
    client._client.messages.create = mock_create

    await client.generate_reply([{"role": "user", "content": "hi"}])

    call_kwargs = mock_create.call_args.kwargs
    assert call_kwargs["model"] == "claude-haiku-4-5"
    assert call_kwargs["max_tokens"] == 512
    system_blocks = call_kwargs["system"]
    assert isinstance(system_blocks, list)
    assert system_blocks[0]["text"] == DEFAULT_SYSTEM_PROMPT
    assert system_blocks[0]["cache_control"] == {"type": "ephemeral"}


async def test_generate_reply_custom_system_prompt(cfg: ClaudeConfig):
    client = ClaudeClient(cfg)
    mock_create = AsyncMock(return_value=make_response("ok"))
    client._client = MagicMock()
    client._client.messages = MagicMock()
    client._client.messages.create = mock_create

    await client.generate_reply(
        [{"role": "user", "content": "hi"}],
        system_prompt="be a pirate",
    )
    assert mock_create.call_args.kwargs["system"][0]["text"] == "be a pirate"


async def test_generate_reply_concatenates_multiple_text_blocks(cfg: ClaudeConfig):
    client = ClaudeClient(cfg)
    response = SimpleNamespace(
        content=[
            SimpleNamespace(type="text", text="part one"),
            SimpleNamespace(type="text", text="part two"),
        ]
    )
    mock_create = AsyncMock(return_value=response)
    client._client = MagicMock()
    client._client.messages = MagicMock()
    client._client.messages.create = mock_create

    reply = await client.generate_reply([{"role": "user", "content": "hi"}])
    assert reply == "part one\npart two"


async def test_generate_reply_strips_whitespace(cfg: ClaudeConfig):
    client = ClaudeClient(cfg)
    mock_create = AsyncMock(return_value=make_response("  spaced  \n"))
    client._client = MagicMock()
    client._client.messages = MagicMock()
    client._client.messages.create = mock_create

    reply = await client.generate_reply([{"role": "user", "content": "hi"}])
    assert reply == "spaced"


async def test_constructor_uses_max_retries_3():
    """We trust the SDK auto-retry — verify config is forwarded."""
    cfg = ClaudeConfig(api_key="sk-x")
    client = ClaudeClient(cfg)
    # AsyncAnthropic stores max_retries on the underlying client.
    assert client._client.max_retries == 3
