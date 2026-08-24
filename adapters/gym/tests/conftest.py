"""Shared pytest fixtures: a server command and the synthetic episode spec."""

from __future__ import annotations

import shutil
from pathlib import Path

import pytest

ADAPTER_DIR = Path(__file__).resolve().parents[1]
REPO_DIR = ADAPTER_DIR.parents[1]
SPEC_PATH = Path(__file__).parent / "fixtures" / "synthetic-episode.json"

TSX = REPO_DIR / "node_modules" / ".bin" / "tsx"
SERVER_SRC = REPO_DIR / "packages" / "rl-env" / "src" / "env-server.ts"
SERVER_DIST = REPO_DIR / "packages" / "rl-env" / "dist" / "env-server.js"


def server_command() -> tuple[str, ...]:
    """Run the TS server from the workspace build, else from source via tsx."""
    if SERVER_DIST.exists():
        return ("node", str(SERVER_DIST))
    if TSX.exists() and SERVER_SRC.exists():
        return (str(TSX), str(SERVER_SRC))
    installed = shutil.which("simforge-env-server")
    if installed:
        return (installed,)
    raise RuntimeError("no simforge-env-server available: build @simforge/training-env first")


def _server_available() -> bool:
    return SERVER_DIST.exists() or (TSX.exists() and SERVER_SRC.exists()) or shutil.which("simforge-env-server") is not None


if not _server_available():  # pragma: no cover - environment guard
    pytest.skip("no env-server runtime available", allow_module_level=True)


@pytest.fixture(scope="session")
def server_cmd() -> tuple[str, ...]:
    return server_command()


@pytest.fixture(scope="session")
def spec() -> str:
    assert SPEC_PATH.exists(), f"missing episode spec fixture {SPEC_PATH}"
    return str(SPEC_PATH)
