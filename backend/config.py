"""Application configuration loaded from environment via python-decouple."""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from decouple import config


@dataclass(frozen=True)
class ProxyConfig:
    scheme: str
    hostname: str
    port: int
    username: Optional[str] = None
    password: Optional[str] = None

    def to_pyrogram_dict(self) -> dict:
        d: dict = {
            "scheme": self.scheme,
            "hostname": self.hostname,
            "port": self.port,
        }
        if self.username:
            d["username"] = self.username
        if self.password:
            d["password"] = self.password
        return d


@dataclass(frozen=True)
class AppConfig:
    api_id: int
    api_hash: str
    login: str
    session_dir: Path
    anthropic_api_key: str
    proxy: Optional[ProxyConfig]


def load_config() -> AppConfig:
    api_id = int(config("API_ID"))
    api_hash = config("API_HASH")
    login = config("LOGIN")
    default_session_dir = str((Path(__file__).parent / "sessions").resolve())
    session_dir = Path(config("SESSION_DIR", default=default_session_dir))
    session_dir.mkdir(parents=True, exist_ok=True)

    proxy = _load_proxy()
    anthropic_api_key = config("ANTHROPIC_API_KEY", default="")

    return AppConfig(
        api_id=api_id,
        api_hash=api_hash,
        login=login,
        session_dir=session_dir,
        anthropic_api_key=anthropic_api_key,
        proxy=proxy,
    )


def _load_proxy() -> Optional[ProxyConfig]:
    host = config("PROXY_HOST", default=None)
    port = config("PROXY_PORT", default=None)
    if not host or not port:
        return None
    try:
        return ProxyConfig(
            scheme=config("PROXY_SCHEME", default="socks5"),
            hostname=host,
            port=int(port),
            username=config("PROXY_USERNAME", default=None),
            password=config("PROXY_PASSWORD", default=None),
        )
    except (ValueError, TypeError):
        return None
