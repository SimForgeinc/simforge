"""Bridge: shm frame bundles -> Alpamayo `act` observations.

Maps Bevy-rendered rig frames (renderer/service `render_bundle`, consumed
via ``simforge_native.BundleRingReader`` zero-copy views) onto the wire
observation documented in ``obs.py``: correct ``camera_id`` assignment,
RGBA->RGB packing, optional resize, and the 4-frame history window
assembled across sim ticks.

Zero-copy notes: frames stay numpy views into the shm ring right up to the
final RGBA->RGB pack, which is the one unavoidable copy — the model server
wants contiguous ``H*W*3`` bytes while the ring stores 256-byte-row-padded
RGBA. ``push_bundle`` records that conversion cost per tick in
``last_convert_s``.

This module deliberately has no torch dependency so policy runners can use
it without the inference venv; the authoritative decode lives in
``obs.decode_observation`` on the server side.
"""

from __future__ import annotations

import time
from collections import deque
from collections.abc import Mapping
from typing import Any

import numpy as np

#: Upstream Alpamayo 1.5 camera-index convention (NVlabs/alpamayo1.5
#: load_physical_aiavdataset.py). MIRROR of ``ALPAMAYO_CAMERA_INDEX`` in
#: packages/scenario/src/schema/v2/sensor-rigs.ts — keep byte-identical.
ALPAMAYO_CAMERA_INDEX: dict[str, int] = {
    "camera_cross_left_120fov": 0,
    "camera_front_wide_120fov": 1,
    "camera_cross_right_120fov": 2,
    "camera_rear_left_70fov": 3,
    "camera_rear_tele_30fov": 4,
    "camera_rear_right_70fov": 5,
    "camera_front_tele_30fov": 6,
}

#: Sensor ids per authored rig preset, camera-index ascending (mirrors the
#: `alpamayo-2cam` / `alpamayo-4cam` presets in packages/scenario).
RIG_PROFILES: dict[str, tuple[str, ...]] = {
    "alpamayo-2cam": ("camera_front_wide_120fov", "camera_front_tele_30fov"),
    "alpamayo-4cam": (
        "camera_cross_left_120fov",
        "camera_front_wide_120fov",
        "camera_cross_right_120fov",
        "camera_front_tele_30fov",
    ),
}

# Local mirrors of obs.py constants (obs.py imports torch; this module must not).
NUM_FRAMES_PER_CAMERA = 4
NUM_HISTORY_STEPS = 16


def profile_camera_map(profile: str) -> dict[str, int]:
    """{preset sensor id -> model camera index} for an authored rig preset."""
    try:
        sensors = RIG_PROFILES[profile]
    except KeyError:
        raise ValueError(
            f"unknown rig profile {profile!r} (have {sorted(RIG_PROFILES)})"
        ) from None
    return {sensor_id: ALPAMAYO_CAMERA_INDEX[sensor_id] for sensor_id in sensors}


def rgba_view_to_rgb_bytes(
    view: np.ndarray, size: tuple[int, int] | None = None
) -> tuple[bytes, int, int]:
    """Pack one (H, W, 4) RGBA view into contiguous H*W*3 RGB bytes.

    ``size`` is an optional (width, height) resize target; PIL is imported
    lazily so the no-resize hot path stays numpy-only. Returns
    ``(bytes, width, height)``.
    """
    if view.ndim != 3 or view.shape[2] < 3:
        raise ValueError(f"expected (H, W, >=3) frame view, got {view.shape}")
    height, width = view.shape[0], view.shape[1]
    if size is not None and (width, height) != size:
        from PIL import Image

        rgb = np.ascontiguousarray(view[:, :, :3])
        image = Image.fromarray(rgb, mode="RGB").resize(size, Image.BILINEAR)
        width, height = size
        return image.tobytes(), width, height
    return np.ascontiguousarray(view[:, :, :3]).tobytes(), width, height


class BundleObservationBridge:
    """Accumulates per-camera frame history across ticks and emits wire obs.

    ``camera_map`` maps ring sensor ids (bundle entry ``camera_id`` strings)
    to model camera indices 0..6. Sensors present in the bundle but absent
    from the map are ignored, so a rig may carry extra QA cameras.

    History semantics (matches obs.py: frames oldest -> newest, t0 last):
    every ``push_bundle`` appends one frame per mapped camera to a rolling
    4-deep window. Until 4 ticks have been pushed, ``observation()`` pads by
    replicating the OLDEST available frame — the standard cold-start
    approximation for a fixed-length history model.
    """

    def __init__(
        self,
        camera_map: Mapping[str, int],
        num_frames: int = NUM_FRAMES_PER_CAMERA,
        size: tuple[int, int] | None = None,
    ):
        if not camera_map:
            raise ValueError("camera_map must not be empty")
        indices = list(camera_map.values())
        if len(set(indices)) != len(indices):
            raise ValueError(f"duplicate model camera index in map: {dict(camera_map)}")
        for sensor_id, index in camera_map.items():
            if not 0 <= int(index) <= 6:
                raise ValueError(f"camera index {index} for {sensor_id!r} outside 0..6")
        self.camera_map = dict(camera_map)
        self.num_frames = int(num_frames)
        self.size = size
        self._frames: dict[str, deque[bytes]] = {
            sensor_id: deque(maxlen=self.num_frames) for sensor_id in self.camera_map
        }
        self._dims: dict[str, tuple[int, int]] = {}
        self.ticks_pushed = 0
        self.last_convert_s = 0.0
        self.total_convert_s = 0.0

    @classmethod
    def for_profile(
        cls, profile: str, size: tuple[int, int] | None = None
    ) -> "BundleObservationBridge":
        return cls(profile_camera_map(profile), size=size)

    def push_views(self, views: Mapping[str, np.ndarray]) -> float:
        """Ingest one tick of {sensor id: (H, W, 4) rgba view}.

        Returns the RGBA->RGB conversion wall time in seconds (also stored
        in ``last_convert_s``).
        """
        missing = [s for s in self.camera_map if s not in views]
        if missing:
            raise ValueError(f"bundle tick missing mapped cameras: {missing}")
        t0 = time.perf_counter()
        packed: dict[str, tuple[bytes, int, int]] = {
            sensor_id: rgba_view_to_rgb_bytes(views[sensor_id], self.size)
            for sensor_id in self.camera_map
        }
        elapsed = time.perf_counter() - t0
        for sensor_id, (payload, width, height) in packed.items():
            dims = (width, height)
            previous = self._dims.get(sensor_id)
            if previous is not None and previous != dims:
                raise ValueError(
                    f"{sensor_id}: frame dims changed {previous} -> {dims} mid-history"
                )
            self._dims[sensor_id] = dims
            self._frames[sensor_id].append(payload)
        self.ticks_pushed += 1
        self.last_convert_s = elapsed
        self.total_convert_s += elapsed
        return elapsed

    def push_bundle(self, bundle: Any, pass_: str = "rgb") -> float:
        """Ingest one ``simforge_native`` Bundle (zero-copy views, rgb pass)."""
        views: dict[str, np.ndarray] = {}
        for entry in bundle.entries:
            if entry.camera_id in self.camera_map and entry.pass_ == pass_:
                if entry.format != "rgba8":
                    raise ValueError(
                        f"{entry.camera_id}/{pass_}: expected rgba8, got {entry.format}"
                    )
                views[entry.camera_id] = bundle.view(entry)
        return self.push_views(views)

    @property
    def ready(self) -> bool:
        """At least one full tick per mapped camera has been ingested."""
        return self.ticks_pushed > 0

    def observation(
        self,
        ego_history_xyz: Any,
        ego_history_rot: Any | None = None,
        nav_text: str | None = None,
    ) -> dict[str, Any]:
        """Wire-format `act` observation (see obs.py schema docstring)."""
        if not self.ready:
            raise ValueError("no frames pushed yet")
        hist = np.asarray(ego_history_xyz, dtype=np.float32)
        if hist.shape != (NUM_HISTORY_STEPS, 3):
            raise ValueError(f"ego_history_xyz must be (16, 3), got {hist.shape}")
        cameras = []
        for sensor_id, index in sorted(self.camera_map.items(), key=lambda kv: kv[1]):
            window = list(self._frames[sensor_id])
            # Cold start: replicate the oldest frame; newest stays t0 (last).
            window = [window[0]] * (self.num_frames - len(window)) + window
            width, height = self._dims[sensor_id]
            cameras.append(
                {
                    "camera_id": index,
                    "frames": window,
                    "encoding": "raw",
                    "width": width,
                    "height": height,
                }
            )
        obs: dict[str, Any] = {
            "cameras": cameras,
            "ego_history_xyz": hist.tolist(),
        }
        if ego_history_rot is not None:
            rot = np.asarray(ego_history_rot, dtype=np.float32)
            if rot.shape != (NUM_HISTORY_STEPS, 3, 3):
                raise ValueError(f"ego_history_rot must be (16, 3, 3), got {rot.shape}")
            obs["ego_history_rot"] = rot.tolist()
        if nav_text is not None:
            obs["nav_text"] = nav_text
        return obs


def constant_velocity_history(
    speed_mps: float = 8.0, hz: float = 10.0, steps: int = NUM_HISTORY_STEPS
) -> list[list[float]]:
    """Straight-line ego history along +x, t0 (last entry) at the origin."""
    dt = 1.0 / hz
    return [
        [-(steps - 1 - i) * speed_mps * dt, 0.0, 0.0] for i in range(steps)
    ]


def ego_history_from_positions(
    world_xyz: Any, heading_rad: float = 0.0, steps: int = NUM_HISTORY_STEPS
) -> list[list[float]]:
    """Convert the last ``steps`` world positions into the ego frame at t0.

    ``world_xyz`` is (N >= 1, 3), oldest -> newest. The newest position
    becomes the origin; ``heading_rad`` is the ego yaw at t0 in the same
    world frame (rotation about +z, x-forward ego convention). Histories
    shorter than ``steps`` are padded by replicating the oldest position.
    """
    positions = np.asarray(world_xyz, dtype=np.float64)
    if positions.ndim != 2 or positions.shape[1] != 3 or positions.shape[0] < 1:
        raise ValueError(f"world_xyz must be (N>=1, 3), got {positions.shape}")
    if positions.shape[0] < steps:
        pad = np.repeat(positions[:1], steps - positions.shape[0], axis=0)
        positions = np.concatenate([pad, positions], axis=0)
    positions = positions[-steps:]
    delta = positions - positions[-1]
    cos_h, sin_h = np.cos(-heading_rad), np.sin(-heading_rad)
    ego = np.empty_like(delta)
    ego[:, 0] = cos_h * delta[:, 0] - sin_h * delta[:, 1]
    ego[:, 1] = sin_h * delta[:, 0] + cos_h * delta[:, 1]
    ego[:, 2] = delta[:, 2]
    return [[float(v) for v in row] for row in ego]
