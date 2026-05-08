"""Cross-cutting application dependencies."""
from deps.auth import AuthDeps
from deps.pyrogram_clients import PyrogramClientManager

__all__ = ["AuthDeps", "PyrogramClientManager"]
