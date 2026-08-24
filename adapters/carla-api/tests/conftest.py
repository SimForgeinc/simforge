"""Shared fixtures: real env-server sessions over repo-committed instances."""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import pytest

# Never render browser clips during tests.
os.environ.setdefault("UNISCENARIO_FRAMES", "off")

ADAPTER_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = ADAPTER_ROOT.parents[1]
sys.path.insert(0, str(ADAPTER_ROOT))

from simforge_carla_api import Client  # noqa: E402


def _dev_assets_root() -> Path:
    link = ADAPTER_ROOT / ".dev-assets"
    if link.exists():
        return link.resolve()
    return REPO_ROOT / "dev-assets"


def _instance_for(map_id: str) -> Path | None:
    """A real scenario-instance for ``map_id`` from committed/local pools."""
    from simforge_carla_api.maps import find_instance_for_map, instance_search_roots

    return find_instance_for_map(map_id, instance_search_roots())


@pytest.fixture(scope="session")
def dev_assets_root() -> Path:
    return _dev_assets_root()


@pytest.fixture(scope="session")
def yale_client():
    from simforge_carla_api.maps import build_episode_spec

    if _instance_for("yale-street") is None:
        pytest.skip("no yale-street scenario-instance available")
    spec_path, _ = build_episode_spec("yale-street")
    client = Client(episodes_spec=spec_path)
    yield client
    client.close()


@pytest.fixture(scope="session")
def yale_world(yale_client):
    world = yale_client.get_world()
    world.tick()  # ensure engine state exists
    return world


@pytest.fixture(scope="session")
def richmond_world():
    from simforge_carla_api.maps import build_episode_spec

    if _instance_for("richmond-field-station") is None:
        pytest.skip("no richmond-field-station scenario-instance available")
    spec_path, _ = build_episode_spec("richmond-field-station")
    client = Client(episodes_spec=spec_path)
    try:
        world = client.get_world()
        world.tick()
        yield world
    finally:
        client.close()
