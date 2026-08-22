"""Project engine ground truth (W0 frame-gt v1) into the rendered image plane.

The W0 renderer solves a per-frame pinhole camera (eye, target, vertical FOV)
in scene space; actor boxes are oriented 3D boxes in the same space
(x, zScene horizontal, yScene = base height). Projecting each box's 8 corners
and taking the screen-space AABB yields pixel ground truth that is
byte-consistent with the engine trace (same channels the renderer used).
"""

from __future__ import annotations

import math

# Engine actor kinds -> collapsed evaluation classes.
KIND_TO_CLASS = {
    "car": "vehicle",
    "vehicle": "vehicle",
    "truck": "vehicle",
    "bus": "vehicle",
    "van": "vehicle",
    "pedestrian": "pedestrian",
    "vru": "pedestrian",
    "bicycle": "bicycle",
    "cyclist": "bicycle",
    "motorcycle": "motorcycle",
}

PROP_KIND_DEFAULT = "vehicle"  # parked rows etc. render as vehicles


def _basis(eye, target):
    fx, fy, fz = target[0] - eye[0], target[1] - eye[1], target[2] - eye[2]
    flen = math.sqrt(fx * fx + fy * fy + fz * fz)
    f = (fx / flen, fy / flen, fz / flen)
    up = (0.0, 1.0, 0.0)
    # right = normalize(cross(f, up))
    rx = f[1] * up[2] - f[2] * up[1]
    ry = f[2] * up[0] - f[0] * up[2]
    rz = f[0] * up[1] - f[1] * up[0]
    rl = math.sqrt(rx * rx + ry * ry + rz * rz)
    r = (rx / rl, ry / rl, rz / rl)
    u = (
        r[1] * f[2] - r[2] * f[1],
        r[2] * f[0] - r[0] * f[2],
        r[0] * f[1] - r[1] * f[0],
    )
    return f, r, u


def _corners(pos, dims, heading) -> list[tuple[float, float, float]]:
    """8 corners of an oriented box: pos is base-center (x, yBase, z),
    dims {l,w,h}, heading rotates about +Y in the x-z plane."""
    l, w, h = dims["l"], dims["w"], dims["h"]
    cx, cy, cz = pos
    # heading measured in engine x-z plane; forward in scene space.
    fx, fz = math.cos(heading), -math.sin(heading)
    rx, rz = -fz, fx
    out = []
    for dl in (-l / 2, l / 2):
        for dw in (-w / 2, w / 2):
            px = cx + dl * fx + dw * rx
            pz = cz + dl * fz + dw * rz
            for dh in (0.0, h):
                out.append((px, cy + dh, pz))
    return out


def project_gt(record: dict, width: int, height: int) -> list[dict]:
    """Return pixel GT boxes [{class, bbox:[x,y,w,h], id}] for one frame record."""
    cam = record["camera"]
    eye, target = cam["eye"], cam["target"]
    fov_v = math.radians(cam.get("fovDeg", 58.0))
    f, r, u = _basis(eye, target)

    aspect = width / height
    tan_h = math.tan(fov_v / 2) * aspect
    tan_v = math.tan(fov_v / 2)

    boxes: list[dict] = []
    actors = list(record.get("actors", [])) + list(record.get("props", []))
    for a in actors:
        if not a.get("present", True):
            continue
        kind = a.get("kind") or PROP_KIND_DEFAULT
        cls = KIND_TO_CLASS.get(kind)
        if cls is None:
            continue
        if a.get("id") == "ego":
            continue  # pinned ego body hidden from POV renders but kept in GT
        pos = (a["x"], a.get("yScene", 0.0), a["zScene"])
        corners = _corners(pos, a["dims"], a.get("headingRad", 0.0))

        xs: list[float] = []
        ys: list[float] = []
        behind = False
        for p in corners:
            dx, dy, dz = p[0] - eye[0], p[1] - eye[1], p[2] - eye[2]
            zc = dx * f[0] + dy * f[1] + dz * f[2]
            if zc <= 0.05:
                behind = True
                break
            xc = dx * r[0] + dy * r[1] + dz * r[2]
            yc = dx * u[0] + dy * u[1] + dz * u[2]
            xs.append(width / 2 + (xc / zc) * (width / 2) / tan_h)
            ys.append(height / 2 - (yc / zc) * (height / 2) / tan_v)
        if behind or not xs:
            continue
        x1, x2 = max(min(xs), 0.0), min(max(xs), float(width))
        y1, y2 = max(min(ys), 0.0), min(max(ys), float(height))
        w, h = x2 - x1, y2 - y1
        if w < 4 or h < 4:
            continue  # sub-visible at render resolution
        boxes.append(
            {
                "class": cls,
                "bbox": [round(x1, 1), round(y1, 1), round(w, 1), round(h, 1)],
                "id": a.get("id"),
            }
        )
    return boxes
