"""Observation decoding and synthetic-observation generation.

Observation schema (msgpack map, all keys optional unless noted):
    cameras: list of camera maps, REQUIRED
        camera_id: int 0..6 (see CAMERA_DISPLAY_NAMES in upstream helper)
        frames:    list of frame payloads, oldest -> newest (t0 last),
                   exactly ``num_frames_per_camera`` entries (default 4)
        encoding:  "raw" | "jpeg" | "png"   (default "raw")
        width/height: required for "raw" (H*W*3 uint8 RGB bytes)
    ego_history_xyz: 16 x [x, y, z] floats, local frame at t0 (last == origin)
    ego_history_rot: 16 x 3x3 row-major floats (default: identity)
    nav_text: optional navigation instruction string
"""

from __future__ import annotations

import io
from typing import Any

import numpy as np
import torch

NUM_HISTORY_STEPS = 16
NUM_FRAMES_PER_CAMERA = 4
# 512 x 384 == 196,608 px == upstream MAX_PIXELS: no resize surprises.
SYNTH_W, SYNTH_H = 512, 384


def decode_observation(obs: dict[str, Any]) -> dict[str, Any]:
    """Decode a wire observation into model-ready tensors.

    Returns dict with:
        frames: uint8 tensor (N_cams * n_frames, 3, H, W), camera-id ascending
        camera_indices: int64 tensor (N_cams,)
        ego_history_xyz: float32 (1, 1, 16, 3)
        ego_history_rot: float32 (1, 1, 16, 3, 3)
        nav_text: str | None
    """
    cameras = obs.get("cameras")
    if not cameras:
        raise ValueError("observation.cameras is required and must be non-empty")

    cams = sorted(cameras, key=lambda c: int(c["camera_id"]))
    cam_ids = [int(c["camera_id"]) for c in cams]
    if len(set(cam_ids)) != len(cam_ids):
        raise ValueError(f"duplicate camera_id in observation: {cam_ids}")

    per_cam: list[torch.Tensor] = []
    for cam in cams:
        frames = cam.get("frames") or []
        if len(frames) != NUM_FRAMES_PER_CAMERA:
            raise ValueError(
                f"camera {cam['camera_id']}: expected {NUM_FRAMES_PER_CAMERA} frames, "
                f"got {len(frames)}"
            )
        decoded = [_decode_frame(f, cam) for f in frames]
        per_cam.append(torch.stack(decoded, dim=0))  # (n_frames, 3, H, W)

    frames = torch.cat(per_cam, dim=0)  # (N_cams * n_frames, 3, H, W)
    camera_indices = torch.tensor(cam_ids, dtype=torch.int64)

    hist_xyz = obs.get("ego_history_xyz")
    if hist_xyz is None:
        raise ValueError("observation.ego_history_xyz is required (16 x [x,y,z])")
    hist_xyz = np.asarray(hist_xyz, dtype=np.float32)
    if hist_xyz.shape != (NUM_HISTORY_STEPS, 3):
        raise ValueError(f"ego_history_xyz must be (16, 3), got {hist_xyz.shape}")

    hist_rot = obs.get("ego_history_rot")
    if hist_rot is None:
        hist_rot = np.broadcast_to(
            np.eye(3, dtype=np.float32), (NUM_HISTORY_STEPS, 3, 3)
        ).copy()
    else:
        hist_rot = np.asarray(hist_rot, dtype=np.float32)
        if hist_rot.shape != (NUM_HISTORY_STEPS, 3, 3):
            raise ValueError(f"ego_history_rot must be (16, 3, 3), got {hist_rot.shape}")

    return {
        "frames": frames,
        "camera_indices": camera_indices,
        "ego_history_xyz": torch.from_numpy(hist_xyz)[None, None],
        "ego_history_rot": torch.from_numpy(hist_rot)[None, None],
        "nav_text": obs.get("nav_text"),
    }


def _decode_frame(frame: Any, cam: dict[str, Any]) -> torch.Tensor:
    """Decode one frame payload to a uint8 (3, H, W) tensor."""
    encoding = cam.get("encoding", "raw")
    if encoding == "raw":
        w, h = int(cam["width"]), int(cam["height"])
        arr = np.frombuffer(frame, dtype=np.uint8)
        if arr.size != h * w * 3:
            raise ValueError(f"raw frame size {arr.size} != {h}x{w}x3")
        arr = arr.reshape(h, w, 3)
    elif encoding in ("jpeg", "png"):
        from PIL import Image

        arr = np.asarray(Image.open(io.BytesIO(frame)).convert("RGB"))
    else:
        raise ValueError(f"unknown frame encoding: {encoding}")
    return torch.from_numpy(np.ascontiguousarray(arr.transpose(2, 0, 1)))


# ---------------------------------------------------------------------------
# Synthetic observations (latency measurement / smoke tests)
# ---------------------------------------------------------------------------

PROFILE_CAMERAS = {
    # front wide + front tele
    2: [1, 6],
    # dataset default: cross-left, front-wide, cross-right, front-tele
    4: [0, 1, 2, 6],
    # full rig
    7: [0, 1, 2, 3, 4, 5, 6],
}


def synthetic_observation(
    num_cameras: int = 2,
    seed: int = 0,
    speed_mps: float = 8.0,
    width: int = SYNTH_W,
    height: int = SYNTH_H,
) -> dict[str, Any]:
    """Deterministic synthetic wire-format observation.

    Frames are a structured road-like gradient plus seeded noise so that
    different (seed, camera) pairs produce distinct inputs while remaining
    byte-reproducible.
    """
    if num_cameras not in PROFILE_CAMERAS:
        raise ValueError(f"num_cameras must be one of {sorted(PROFILE_CAMERAS)}")
    rng = np.random.default_rng(seed)

    yy = np.linspace(0.0, 1.0, height, dtype=np.float32)[:, None, None]
    xx = np.linspace(0.0, 1.0, width, dtype=np.float32)[None, :, None]

    cameras = []
    for cam_id in PROFILE_CAMERAS[num_cameras]:
        frames = []
        for t in range(NUM_FRAMES_PER_CAMERA):
            sky = np.array([120, 160, 210], dtype=np.float32) * (1.0 - yy)
            road = np.array([90, 90, 95], dtype=np.float32) * yy
            base = np.broadcast_to(sky + road, (height, width, 3)).copy()
            # dashed center line that "moves" with t to fake ego motion
            phase = (yy[..., 0] * 12 + t * 0.7 + cam_id) % 1.0
            lane = ((np.abs(xx[..., 0] - 0.5) < 0.006) & (phase < 0.55))
            base[lane] = np.array([235, 220, 90], dtype=np.float32)
            noise = rng.normal(0.0, 6.0, size=(height, width, 3)).astype(np.float32)
            img = np.clip(base + noise, 0, 255).astype(np.uint8)
            frames.append(img.tobytes())
        cameras.append(
            {
                "camera_id": cam_id,
                "frames": frames,
                "encoding": "raw",
                "width": width,
                "height": height,
            }
        )

    # straight-line history at constant speed along +x, t0 at origin
    dt = 0.1
    hist_xyz = [
        [-(NUM_HISTORY_STEPS - 1 - i) * speed_mps * dt, 0.0, 0.0]
        for i in range(NUM_HISTORY_STEPS)
    ]

    return {
        "cameras": cameras,
        "ego_history_xyz": hist_xyz,
        # rot omitted -> identity
    }
