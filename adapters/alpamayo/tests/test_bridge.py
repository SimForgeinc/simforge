"""Shim unit tests: shm frame bundles -> Alpamayo wire observations.

Uses the ring recorded by the REAL Rust render service
(renderer/service/testdata/bundle-ring.shm.gz: yale fixture tile, 2 cams
64x48 rgb, sim ticks 1..3) plus synthetic views for history-roll checks.

Run (repo root): python3 -m pytest adapters/alpamayo/tests/test_bridge.py
Deps: numpy, pytest (torch/PIL optional — those tests self-skip).
"""
import gzip
import pathlib
import shutil
import sys

import numpy as np
import pytest

REPO = pathlib.Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO / "adapters" / "alpamayo" / "src"))
sys.path.insert(0, str(REPO / "renderer" / "service" / "python"))

from simforge_alpamayo.bridge import (  # noqa: E402
    ALPAMAYO_CAMERA_INDEX,
    BundleObservationBridge,
    constant_velocity_history,
    ego_history_from_positions,
    profile_camera_map,
    rgba_view_to_rgb_bytes,
)
from simforge_native import BundleRingReader  # noqa: E402

TESTDATA = REPO / "renderer" / "service" / "testdata"

# Recorded ring cameras -> model slots (front wide=1, front tele=6).
RING_MAP = {"front": 1, "rear": 6}
HIST = constant_velocity_history()


@pytest.fixture()
def ring_path(tmp_path):
    out = tmp_path / "bundle-ring.shm"
    with gzip.open(TESTDATA / "bundle-ring.shm.gz", "rb") as src, open(out, "wb") as dst:
        shutil.copyfileobj(src, dst)
    return out


def synthetic_views(tick: int, w: int = 8, h: int = 6) -> dict[str, np.ndarray]:
    return {
        sensor: np.full((h, w, 4), 10 * tick + k, dtype=np.uint8)
        for k, sensor in enumerate(RING_MAP)
    }


def test_profile_maps_mirror_the_authored_presets():
    assert profile_camera_map("alpamayo-2cam") == {
        "camera_front_wide_120fov": 1,
        "camera_front_tele_30fov": 6,
    }
    assert profile_camera_map("alpamayo-4cam") == {
        "camera_cross_left_120fov": 0,
        "camera_front_wide_120fov": 1,
        "camera_cross_right_120fov": 2,
        "camera_front_tele_30fov": 6,
    }
    assert sorted(ALPAMAYO_CAMERA_INDEX.values()) == list(range(7))
    with pytest.raises(ValueError, match="unknown rig profile"):
        profile_camera_map("alpamayo-9cam")


def test_bridge_rejects_bad_camera_maps():
    with pytest.raises(ValueError, match="duplicate model camera index"):
        BundleObservationBridge({"a": 1, "b": 1})
    with pytest.raises(ValueError, match="outside 0..6"):
        BundleObservationBridge({"a": 7})
    with pytest.raises(ValueError, match="must not be empty"):
        BundleObservationBridge({})


def test_recorded_ring_to_wire_observation(ring_path):
    import json

    manifest = json.loads((TESTDATA / "bundle-ring.manifest.json").read_text())
    reader = BundleRingReader(str(ring_path))
    bridge = BundleObservationBridge(RING_MAP)
    # Replay every recorded tick (1..3) by explicit frameBundle-style ref.
    last = None
    for tick in manifest["ticks"]:
        last = reader.bundle_at(tick["bundleOffset"], tick["bundleLen"], verify=True)
        assert last.sim_tick == tick["simTick"]
        convert_s = bridge.push_bundle(last)
        assert convert_s > 0.0 and bridge.last_convert_s == convert_s
    assert bridge.ticks_pushed == 3

    obs = bridge.observation(HIST)
    # Sorted by model camera index: front(1) then rear(6).
    assert [c["camera_id"] for c in obs["cameras"]] == [1, 6]
    for cam in obs["cameras"]:
        assert cam["encoding"] == "raw"
        assert (cam["width"], cam["height"]) == (64, 48)
        assert len(cam["frames"]) == 4  # 3 real ticks + 1 cold-start pad
        assert all(len(f) == 64 * 48 * 3 for f in cam["frames"])
    # Bytes must equal a manual strip of the zero-copy RGBA view.
    views = last.views()
    expected = np.ascontiguousarray(views["front"]["rgb"][:, :, :3]).tobytes()
    assert obs["cameras"][0]["frames"][-1] == expected
    assert obs["ego_history_xyz"][-1] == [0.0, 0.0, 0.0]
    del views, last
    reader.close()


def test_history_rolls_oldest_out_newest_last():
    bridge = BundleObservationBridge(RING_MAP)
    for tick in range(1, 6):  # 5 ticks through a 4-deep window
        bridge.push_views(synthetic_views(tick))
    obs = bridge.observation(HIST)
    front = obs["cameras"][0]["frames"]
    firsts = [f[0] for f in front]  # first byte encodes the tick
    assert firsts == [20, 30, 40, 50]  # oldest -> newest, tick 1 rolled out
    assert bridge.ticks_pushed == 5


def test_cold_start_pads_with_oldest_frame():
    bridge = BundleObservationBridge(RING_MAP)
    bridge.push_views(synthetic_views(1))
    bridge.push_views(synthetic_views(2))
    front = bridge.observation(HIST)["cameras"][0]["frames"]
    assert [f[0] for f in front] == [10, 10, 10, 20]


def test_missing_mapped_camera_and_dim_changes_fail():
    bridge = BundleObservationBridge(RING_MAP)
    with pytest.raises(ValueError, match="missing mapped cameras"):
        bridge.push_views({"front": np.zeros((6, 8, 4), dtype=np.uint8)})
    bridge.push_views(synthetic_views(1))
    with pytest.raises(ValueError, match="dims changed"):
        bridge.push_views(synthetic_views(2, w=16, h=12))


def test_resize_path_produces_target_dims():
    pytest.importorskip("PIL")
    bridge = BundleObservationBridge(RING_MAP, size=(4, 3))
    bridge.push_views(synthetic_views(1))
    cam = bridge.observation(HIST)["cameras"][0]
    assert (cam["width"], cam["height"]) == (4, 3)
    assert all(len(f) == 4 * 3 * 3 for f in cam["frames"])


def test_rgba_pack_rejects_non_rgba():
    with pytest.raises(ValueError, match="frame view"):
        rgba_view_to_rgb_bytes(np.zeros((6, 8), dtype=np.uint8))


def test_ego_history_helpers():
    hist = constant_velocity_history(speed_mps=10.0, hz=10.0)
    assert len(hist) == 16 and hist[-1] == [0.0, 0.0, 0.0]
    assert hist[0] == [-15.0, 0.0, 0.0]

    # World track heading 90deg (+y): ego frame must see it as +x forward.
    world = [[0.0, float(i), 0.0] for i in range(16)]
    ego = ego_history_from_positions(world, heading_rad=np.pi / 2)
    assert ego[-1] == [0.0, 0.0, 0.0]
    assert ego[0][0] == pytest.approx(-15.0)
    assert ego[0][1] == pytest.approx(0.0, abs=1e-9)

    # Short histories pad by replicating the oldest position.
    padded = ego_history_from_positions([[5.0, 0.0, 0.0], [6.0, 0.0, 0.0]])
    assert len(padded) == 16
    assert padded[0] == padded[13] == [-1.0, 0.0, 0.0]


def test_wire_observation_decodes_on_the_server_side():
    """End-of-pipe schema check against the REAL server decoder (needs torch)."""
    torch = pytest.importorskip("torch")
    from simforge_alpamayo.obs import decode_observation

    bridge = BundleObservationBridge(profile_camera_map("alpamayo-2cam"))
    for tick in range(1, 5):
        bridge.push_views({
            "camera_front_wide_120fov": np.full((6, 8, 4), tick, dtype=np.uint8),
            "camera_front_tele_30fov": np.full((6, 8, 4), tick + 100, dtype=np.uint8),
        })
    decoded = decode_observation(bridge.observation(HIST))
    assert decoded["frames"].shape == (8, 3, 6, 8)
    assert decoded["frames"].dtype == torch.uint8
    assert decoded["camera_indices"].tolist() == [1, 6]
    assert decoded["ego_history_xyz"].shape == (1, 1, 16, 3)
