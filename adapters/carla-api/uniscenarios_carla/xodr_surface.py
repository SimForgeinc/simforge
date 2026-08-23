"""Road-surface Z from the source OpenDRIVE (ground-truth for placement).

The topology index carries 2-D lane polylines only. Twin placement needs a
road-surface Z, which lives in the XODR itself:

- ``<planView>`` geometry elements (``line``, ``arc``, ``spiral``) define
  each road's reference line; spirals are integrated numerically with a
  fine curvature step (no closed-form Fresnel evaluation needed at this
  accuracy).
- ``<elevation>`` profiles define z as a cubic in reference-line ``s``.

``RoadSurface.z_at(road_id, x, y)`` projects the query point onto that
road's reference polyline and evaluates the elevation cubic there — the
same "coarse estimate from the OpenDRIVE profile" the legacy bridge's
``gps_to_carla`` documents when it snaps waypoint Z.
"""

from __future__ import annotations

import math
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from pathlib import Path

#: Reference-line sampling step for spiral integration (metres).
_SPIRAL_STEP_M = 2.0


@dataclass(frozen=True)
class _Polyline:
    xs: list[float]
    ys: list[float]
    cum: list[float]  # cumulative arc length, cum[0] = 0

    def s_of(self, index: int, t: float) -> float:
        return self.cum[index] + t * (self.cum[index + 1] - self.cum[index])


@dataclass(frozen=True)
class _Elevation:
    """Cubic z(s) = a + b·s + c·s² + d·s³ starting at ``start_s``."""

    start_s: float
    a: float
    b: float
    c: float
    d: float

    def z_at(self, s: float) -> float:
        ds = s - self.start_s
        return self.a + self.b * ds + self.c * ds * ds + self.d * ds ** 3


class RoadSurface:
    """Per-road reference polylines + elevation profiles from one .xodr."""

    def __init__(self, xodr_path: str | Path):
        root = ET.parse(xodr_path).getroot()
        self._polylines: dict[int, _Polyline] = {}
        self._elevations: dict[int, list[_Elevation]] = {}
        for road in root.iter("road"):
            road_id = int(road.get("id"))
            self._polylines[road_id] = self._parse_plan_view(road)
            self._elevations[road_id] = self._parse_elevations(road)

    # ------------------------------------------------------------- parsing

    @staticmethod
    def _parse_plan_view(road) -> _Polyline:
        view = road.find("planView")
        xs: list[float] = []
        ys: list[float] = []
        cum: list[float] = [0.0]
        if view is None:
            return _Polyline([0.0], [0.0], [0.0])
        x = y = heading = 0.0
        first = True
        for geom in view:
            length = float(geom.get("length", "0"))
            if length <= 0:
                continue
            if first:
                x = float(geom.get("x", "0"))
                y = float(geom.get("y", "0"))
                heading = float(geom.get("hdg", "0"))
                xs.append(x)
                ys.append(y)
                first = False
            curve = RoadSurface._curve_of(geom)
            steps = max(1, math.ceil(length / _SPIRAL_STEP_M))
            ds = length / steps
            curv_start, curv_end = curve
            for i in range(steps):
                frac = i / steps
                k = curv_start + (curv_end - curv_start) * frac
                x += math.cos(heading + k * ds / 2) * ds
                y += math.sin(heading + k * ds / 2) * ds
                heading += k * ds
                xs.append(x)
                ys.append(y)
                cum.append(cum[-1] + ds)
        if len(xs) < 2:
            xs.append(xs[0] + 1.0)
            ys.append(ys[0])
            cum.append(cum[-1] + 1.0)
        return _Polyline(xs=xs, ys=ys, cum=cum)

    @staticmethod
    def _curve_of(geom) -> tuple[float, float]:
        line = geom.find("line")
        if line is not None:
            return 0.0, 0.0
        arc = geom.find("arc")
        if arc is not None:
            k = float(arc.get("curvature", "0"))
            return k, k
        spiral = geom.find("spiral")
        if spiral is not None:
            return (float(spiral.get("curvStart", "0")),
                    float(spiral.get("curvEnd", "0")))
        return 0.0, 0.0

    @staticmethod
    def _parse_elevations(road) -> list[_Elevation]:
        out: list[_Elevation] = []
        profile = road.find("elevationProfile")
        if profile is None:
            out.append(_Elevation(0.0, 0.0, 0.0, 0.0, 0.0))
            return out
        for el in profile.iter("elevation"):
            out.append(_Elevation(
                start_s=float(el.get("s", "0")),
                a=float(el.get("a", "0")),
                b=float(el.get("b", "0")),
                c=float(el.get("c", "0")),
                d=float(el.get("d", "0")),
            ))
        if not out:
            out.append(_Elevation(0.0, 0.0, 0.0, 0.0, 0.0))
        out.sort(key=lambda e: e.start_s)
        return out

    # ------------------------------------------------------------- queries

    def has_road(self, road_id: int) -> bool:
        return road_id in self._polylines

    def project_onto_reference(self, road_id: int,
                               x: float, y: float) -> float | None:
        """Reference-line arc length of the nearest point on road ``road_id``."""
        poly = self._polylines.get(road_id)
        if poly is None:
            return None
        best_d2 = math.inf
        best_s = None
        for i in range(len(poly.xs) - 1):
            ax, ay = poly.xs[i], poly.ys[i]
            bx, by = poly.xs[i + 1], poly.ys[i + 1]
            abx, aby = bx - ax, by - ay
            denom = abx * abx + aby * aby
            if denom == 0.0:
                t, d2 = 0.0, (x - ax) ** 2 + (y - ay) ** 2
            else:
                t = max(0.0, min(1.0, ((x - ax) * abx + (y - ay) * aby) / denom))
                px, py = ax + t * abx, ay + t * aby
                d2 = (x - px) ** 2 + (y - py) ** 2
            if d2 < best_d2:
                best_d2 = d2
                best_s = poly.s_of(i, t)
        return best_s

    def elevation_at(self, road_id: int, s: float) -> float | None:
        elevs = self._elevations.get(road_id)
        if not elevs:
            return None
        active = elevs[0]
        for e in elevs:
            if e.start_s <= s:
                active = e
            else:
                break
        return active.z_at(s)

    def z_at(self, road_id: int, x: float, y: float,
             max_reference_distance_m: float = 25.0) -> float | None:
        """Road-surface Z under ``(x, y)`` on road ``road_id``, or None.

        Returns None when the point sits farther than
        ``max_reference_distance_m`` from the road's reference line (the
        query is then off this road; callers fall back to their own logic).
        """
        s = self.project_onto_reference(road_id, x, y)
        if s is None:
            return None
        poly = self._polylines[road_id]
        # Reject far-lateral hits by re-checking distance to the sampled line.
        idx = min(range(len(poly.cum)), key=lambda i: abs(poly.cum[i] - s))
        dx, dy = poly.xs[idx] - x, poly.ys[idx] - y
        if math.hypot(dx, dy) > max_reference_distance_m + _SPIRAL_STEP_M:
            return None
        return self.elevation_at(road_id, s)

    def z_anywhere(self, x: float, y: float) -> float | None:
        """Surface Z from whichever road's reference line passes closest."""
        best: tuple[float, float] | None = None  # (distance, z)
        for road_id in self._polylines:
            s = self.project_onto_reference(road_id, x, y)
            if s is None:
                continue
            poly = self._polylines[road_id]
            idx = min(range(len(poly.cum)), key=lambda i: abs(poly.cum[i] - s))
            d = math.hypot(poly.xs[idx] - x, poly.ys[idx] - y)
            z = self.elevation_at(road_id, s)
            if z is not None and (best is None or d < best[0]):
                best = (d, z)
        return best[1] if best else None


_SURFACE_CACHE: dict[str, RoadSurface] = {}


def load_surface(dev_assets_root: Path | str, map_id: str,
                 browser_dir: str = "browser") -> RoadSurface:
    """Cached RoadSurface for one map's source or browser map.xodr."""
    key = f"{Path(dev_assets_root).resolve()}:{map_id}"
    surface = _SURFACE_CACHE.get(key)
    if surface is None:
        base = Path(dev_assets_root) / map_id
        candidates = [base / "xodr.xodr", base / browser_dir / "map.xodr"]
        path = next((c for c in candidates if c.exists()), None)
        if path is None:
            raise FileNotFoundError(f"no source .xodr for {map_id} under {base}")
        surface = RoadSurface(path)
        _SURFACE_CACHE[key] = surface
    return surface
