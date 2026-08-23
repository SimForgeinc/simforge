"""Trace-derived G-buffers for the WS3 bridge student.

Renders per-frame conditioning maps (depth, semantic, instance, valid mask)
directly from the W0 engine ground truth (``gt.jsonl``,
schema ``uniscenarios.w0-frame-gt.v1``) using the exact camera conventions of
the W0 audit projection (three.js PerspectiveCamera: eye/target in scene coords
(x, up, zScene), vertical FOV, up=+Y; actor boxes centered at
yScene + h/2 with yaw = headingRad about +Y and forward (cos yaw, -sin yaw)).

These are TRUE engine G-buffers in the sense that matters for the plan:
geometry is pinned by engine state, not by any image model. The production
path will take the same channels from renderer passes; this rasterizer exists
so the student recipe is trainable now on the existing W0 corpus without
touching the render pipeline.

Output buffers per frame (all at native clip resolution):
  depth     float32 meters (np.inf where no geometry)
  semantic  uint8 class index (SEM_CLASSES)
  instance  int32 actor slot index (-1 background)
  valid     bool (finite depth)
"""

from __future__ import annotations

import json
import math
import os
from dataclasses import dataclass

import numpy as np

MAX_DIST_M = 250.0
NEAR_M = 0.05

# Fixed semantic layout — part of the student's conditioning contract.
SEM_CLASSES = {
    "background": 0,
    "car": 1,
    "truck": 2,
    "bus": 3,
    "pedestrian": 4,
    "bicycle": 5,
    "motorcycle": 6,
    "rider": 7,
    "prop": 8,
}
SAFETY_KINDS = {"car", "truck", "bus", "pedestrian", "bicycle", "motorcycle", "rider"}

# Palette used only for human-inspectable PNGs.
PALETTE = np.array(
    [
        (0, 0, 0),         # background
        (70, 130, 180),    # car
        (180, 70, 90),     # truck
        (220, 160, 40),    # bus
        (230, 60, 60),     # pedestrian
        (60, 200, 120),    # bicycle
        (40, 170, 170),    # motorcycle
        (150, 100, 220),   # rider
        (110, 110, 110),   # prop
    ],
    dtype=np.uint8,
)


@dataclass
class Camera:
    eye: np.ndarray
    fwd: np.ndarray
    right: np.ndarray
    up: np.ndarray
    w: int
    h: int
    tan_v: float


def make_camera(cam_json: dict, width: int, height: int) -> Camera:
    eye = np.asarray(cam_json["eye"], dtype=np.float64)
    tgt = np.asarray(cam_json["target"], dtype=np.float64)
    tan_v = math.tan(math.radians(cam_json["fovDeg"]) / 2.0)
    fwd = tgt - eye
    fwd = fwd / np.linalg.norm(fwd)
    world_up = np.array([0.0, 1.0, 0.0])
    right = np.cross(fwd, world_up)
    right = right / np.linalg.norm(right)
    up = np.cross(right, fwd)
    return Camera(eye, fwd, right, up, width, height, tan_v)


def actor_corners(a: dict) -> np.ndarray:
    """8 corners of the oriented box in scene coords (W0 audit convention)."""
    yaw = a["headingRad"]
    fx, fz = math.cos(yaw), -math.sin(yaw)
    sx, sz = -fz, fx
    cx_, cy_, cz_ = a["x"], a.get("yScene", 0.0) + a["dims"]["h"] / 2.0, a["zScene"]
    hl, hw, hh = a["dims"]["l"] / 2.0, a["dims"]["w"] / 2.0, a["dims"]["h"] / 2.0
    pts = []
    for dl in (-hl, hl):
        for dw in (-hw, hw):
            for dh in (-hh, hh):
                pts.append(
                    [cx_ + fx * dl + sx * dw, cy_ + dh, cz_ + fz * dl + sz * dw]
                )
    return np.asarray(pts, dtype=np.float64)


def _to_camera(points: np.ndarray, cam: Camera) -> np.ndarray:
    d = points - cam.eye
    return np.stack([d @ cam.right, d @ cam.up, d @ cam.fwd], axis=1)


def _project(cam_points: np.ndarray, cam: Camera) -> np.ndarray:
    cz = cam_points[:, 2]
    u = cam.w / 2 + (cam.w / 2) * cam_points[:, 0] / (cz * cam.tan_v * (cam.w / cam.h))
    v = cam.h / 2 - (cam.h / 2) * cam_points[:, 1] / (cz * cam.tan_v)
    return np.stack([u, v, cz], axis=1)


def _clip_near(poly_cam: np.ndarray, near: float) -> np.ndarray:
    """Sutherland-Hodgman clip of a camera-space polygon against z > near."""
    out = []
    n = len(poly_cam)
    for i in range(n):
        cur = poly_cam[i]
        nxt = poly_cam[(i + 1) % n]
        cin, nin = cur[2] > near, nxt[2] > near
        if cin:
            out.append(cur)
        if cin != nin:
            t = (near - cur[2]) / (nxt[2] - cur[2])
            out.append(cur + t * (nxt - cur))
    return np.asarray(out, dtype=np.float64)


# Box faces as quads over corner indices from actor_corners ordering
# (dl, dw, dh) loops -> index = i*4 + j*2 + k with bits (dl,dw,dh).
_FACES = [
    (0, 1, 3, 2),  # dl- : (0,0,0)(0,0,1)(0,1,1)(0,1,0)
    (4, 6, 7, 5),  # dl+
    (0, 4, 5, 1),  # dw-
    (2, 3, 7, 6),  # dw+
    (0, 2, 6, 4),  # dh-
    (1, 5, 7, 3),  # dh+
]


def _rasterize_tri(
    depth: np.ndarray,
    sem: np.ndarray,
    inst: np.ndarray,
    tri_uv: np.ndarray,
    tri_invz: np.ndarray,
    sem_val: int,
    inst_val: int,
) -> None:
    xs = tri_uv[:, 0]
    ys = tri_uv[:, 1]
    x0 = max(int(np.floor(xs.min())), 0)
    x1 = min(int(np.ceil(xs.max())) + 1, depth.shape[1])
    y0 = max(int(np.floor(ys.min())), 0)
    y1 = min(int(np.ceil(ys.max())) + 1, depth.shape[0])
    if x0 >= x1 or y0 >= y1:
        return
    gx, gy = np.meshgrid(
        np.arange(x0, x1, dtype=np.float64) + 0.5,
        np.arange(y0, y1, dtype=np.float64) + 0.5,
    )
    x_a, y_a = xs[0], ys[0]
    x_b, y_b = xs[1], ys[1]
    x_c, y_c = xs[2], ys[2]
    den = (y_b - y_c) * (x_a - x_c) + (x_c - x_b) * (y_a - y_c)
    if abs(den) < 1e-12:
        return
    w_a = ((y_b - y_c) * (gx - x_c) + (x_c - x_b) * (gy - y_c)) / den
    w_b = ((y_c - y_a) * (gx - x_c) + (x_a - x_c) * (gy - y_c)) / den
    w_c = 1.0 - w_a - w_b
    inside = (
        (w_a >= 0) & (w_b >= 0) & (w_c >= 0) & (w_a <= 1) & (w_b <= 1) & (w_c <= 1)
    )
    if not inside.any():
        return
    # Perspective-correct depth: 1/z is affine in screen space.
    invz = w_a * tri_invz[0] + w_b * tri_invz[1] + w_c * tri_invz[2]
    sub_depth = depth[y0:y1, x0:x1]
    upd = inside & (invz < sub_depth)
    if not upd.any():
        return
    zvals = np.where(invz > 1e-9, 1.0 / np.maximum(invz, 1e-12), MAX_DIST_M * 10)
    sub_depth[upd] = zvals[upd]
    sem[y0:y1, x0:x1][upd] = sem_val
    inst[y0:y1, x0:x1][upd] = inst_val


class GBufferRenderer:
    """Renders conditioning maps from a gt.jsonl frame record."""

    def __init__(self, width: int, height: int, max_dist_m: float = MAX_DIST_M):
        self.width = width
        self.height = height
        self.max_dist_m = max_dist_m

    def render_frame(self, gt_record: dict) -> dict:
        h, w = self.height, self.width
        depth = np.full((h, w), np.inf, dtype=np.float64)
        sem = np.zeros((h, w), dtype=np.uint8)
        inst = np.full((h, w), -1, dtype=np.int32)
        cam = make_camera(gt_record["camera"], w, h)

        entries = list(gt_record.get("actors", []))
        prop_offset = len(entries)
        entries.extend(gt_record.get("props", []))
        # Far-to-near is unnecessary: we keep an exact z-buffer.
        slot = 0
        for idx, ent in enumerate(entries):
            is_prop = idx >= prop_offset
            kind = str(ent.get("kind", "")).lower()
            if not ent.get("present", True):
                continue
            if is_prop:
                sem_val = SEM_CLASSES["prop"]
            elif kind in SEM_CLASSES:
                sem_val = SEM_CLASSES[kind]
            else:
                continue
            center = np.asarray(
                [ent["x"], ent.get("yScene", 0.0) + ent["dims"]["h"] / 2.0, ent["zScene"]],
                dtype=np.float64,
            )
            dist = float(np.linalg.norm(center - cam.eye))
            if dist > self.max_dist_m:
                continue
            if dist < 2.0 * ent["dims"]["l"]:
                # camera-mounted carrier actor (POV set): excluded like the audit
                continue
            corners = actor_corners(ent)
            cps = _to_camera(corners, cam)
            for quad in _FACES:
                poly = cps[list(quad)]
                poly = _clip_near(poly, NEAR_M)
                if len(poly) < 3:
                    continue
                proj = _project(poly, cam)
                uv = proj[:, :2]
                invz = 1.0 / proj[:, 2]
                for t in range(1, len(uv) - 1):
                    _rasterize_tri(
                        depth, sem, inst,
                        np.stack([uv[0], uv[t], uv[t + 1]]),
                        np.array([invz[0], invz[t], invz[t + 1]]),
                        sem_val,
                        slot,
                    )
            slot += 1

        return {
            "depth": depth,
            "semantic": sem,
            "instance": inst,
            "valid": np.isfinite(depth),
        }


def condition_stack(buffers: dict, max_depth_m: float = 80.0) -> np.ndarray:
    """Assemble the fixed 6-channel float32 conditioning stack in [0, 1].

    Channels: [depth/max_depth, sem_r, sem_g, sem_b, instance_norm, valid].
    """
    h, w = buffers["semantic"].shape
    depth = np.clip(buffers["depth"], 0.0, max_depth_m) / max_depth_m
    depth = np.nan_to_num(depth, nan=0.0, posinf=0.0)
    pal = PALETTE[buffers["semantic"]]
    inst = (buffers["instance"] + 1).astype(np.float32) / 256.0
    valid = buffers["valid"].astype(np.float32)
    return np.concatenate(
        [
            depth[..., None].astype(np.float32),
            pal.astype(np.float32) / 255.0,
            inst[..., None],
            valid[..., None],
        ],
        axis=2,
    )


def semantic_palette_png(sem: np.ndarray) -> np.ndarray:
    return PALETTE[sem]


def load_gt(path: str) -> list[dict]:
    records = []
    with open(path) as f:
        for line in f:
            line = line.strip()
            if line:
                records.append(json.loads(line))
    return records


def frame_size(clips_root: str, clip: str) -> tuple[int, int]:
    """Read the actual rendered frame size from the first frame PNG."""
    from PIL import Image

    frames_dir = os.path.join(clips_root, clip, "frames")
    names = sorted(os.listdir(frames_dir))
    with Image.open(os.path.join(frames_dir, names[0])) as im:
        return im.size  # (w, h)
