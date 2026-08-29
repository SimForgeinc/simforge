"""Environment access for the SimForge CARLA executor process."""

from __future__ import annotations

import os


def simforge_env(name: str, default: str | None = None) -> str | None:
    """Read a canonical SIMFORGE_<name> environment variable."""
    return os.environ.get(f"SIMFORGE_{name}", default)
