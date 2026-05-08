"""Shared pytest fixtures for backend tests."""
from __future__ import annotations

import os
from pathlib import Path

import pytest

# Set required env vars BEFORE main.py is imported, so decouple.config() succeeds.
os.environ.setdefault("API_ID", "12345")
os.environ.setdefault("API_HASH", "test_api_hash_for_unit_tests_only")
os.environ.setdefault("LOGIN", "test_session")
os.environ.setdefault("SESSION_DIR", str(Path(__file__).parent / "_session_tmp"))
Path(os.environ["SESSION_DIR"]).mkdir(parents=True, exist_ok=True)


@pytest.fixture
def tmp_state_dir(tmp_path: Path) -> Path:
    d = tmp_path / "state"
    d.mkdir()
    return d
