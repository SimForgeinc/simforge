"""Python port of the slice of ``@simforge/maps``'s LaneGraph that the
CARLA ``Map``/``Waypoint`` surface needs.

Backed directly by the map pipeline artifact
``dev-assets/<mapId>/browser/topology-index.json.gz`` (the same TopologyIndex
the TS ``LaneGraph`` consumes). Implements:

- travel-ordered polylines (positive-id lanes run *against* OpenDRIVE ``s``
  and are flipped, per the map-intel rule; the junction-gate refinement is
  NOT ported — documented limitation);
- uniform-grid ``nearest_lane`` over polyline segments;
- pose-at-arc-length, interpolated lane widths;
- travel-direction successor/predecessor hops (OpenDRIVE predecessor/successor
  swap for positive-id lanes).

All ``s`` here is travel-ordered arc length from the lane's entry, matching
map-intel conventions.
"""

from __future__ import annotations

import gzip
import json
import math
from dataclasses import dataclass
from pathlib import Path

GRID_CELL_M = 20.0
DEFAULT_MAX_DISTANCE_M = 150.0


@dataclass(frozen=True)
class LaneNode:
    rsl: str
    road_id: int
    section_id: int
    lane_id: int
    points: list[tuple[float, float]]  # travel order
    cum: list[float]  # cumulative arc length over `points`
    length_m: float
    lane_type: str
    is_junction: bool
    junction_id: int | None
    speed_limit_kph: float | None
    width_samples: list[dict]  # source-order [{s, widthM}]
    travel_successors: list[str]
    travel_predecessors: list[str]

    @property
    def row_key(self) -> str:
        return f"{self.road_id}:{self.section_id}"


@dataclass(frozen=True)
class LaneHit:
    lane: LaneNode
    s: float
    distance_m: float
    offset_m: float  # signed lateral offset, left of travel direction positive
    heading_rad: float
    point: tuple[float, float]


def _cumulative_lengths(points: list[tuple[float, float]]) -> list[float]:
    cum = [0.0]
    for i in range(1, len(points)):
        dx = points[i][0] - points[i - 1][0]
        dy = points[i][1] - points[i - 1][1]
        cum.append(cum[-1] + math.hypot(dx, dy))
    return cum


def _heading(a: tuple[float, float], b: tuple[float, float]) -> float:
    return math.atan2(b[1] - a[1], b[0] - a[0])


class LaneGraphLite:
    """Query-ready view over one map's topology index."""

    def __init__(self, topology_index: dict) -> None:
        self.map_name = topology_index.get("mapName", "")
        self._by_rsl: dict[str, LaneNode] = {}
        self._grid: dict[tuple[int, int], list[tuple[str, int]]] = {}
        self._build(topology_index["lanes"])

    # ---------------------------------------------------------------- build

    def _build(self, lanes: dict) -> None:
        for rsl, raw in lanes.items():
            road_id = int(raw["roadId"])
            section_id = int(raw.get("section", 0))
            lane_id = int(raw["laneId"])
            src_points = [(float(p["x"]), float(p["y"])) for p in raw["polyline"]]
            reversed_lane = lane_id > 0
            points = src_points[::-1] if reversed_lane else src_points
            cum = _cumulative_lengths(points)
            node = LaneNode(
                rsl=rsl,
                road_id=road_id,
                section_id=section_id,
                lane_id=lane_id,
                points=points,
                cum=cum,
                length_m=cum[-1],
                lane_type=str(raw.get("laneType", "shoulder")),
                is_junction=bool(raw.get("isJunction", False)),
                junction_id=raw.get("junctionId"),
                speed_limit_kph=raw.get("speedLimitKph"),
                width_samples=list(raw.get("widthSamples", [])),
                # Positive-id lanes travel against s ⇒ OpenDRIVE predecessors
                # are their travel successors (and vice versa).
                travel_successors=list(raw.get("predecessors") if reversed_lane else raw.get("successors")) or [],
                travel_predecessors=list(raw.get("successors") if reversed_lane else raw.get("predecessors")) or [],
            )
            self._by_rsl[rsl] = node
            for i in range(len(points) - 1):
                ax, ay = points[i]
                bx, by = points[i + 1]
                cx = int((ax + bx) / 2 // GRID_CELL_M)
                cy = int((ay + by) / 2 // GRID_CELL_M)
                self._grid.setdefault((cx, cy), []).append((rsl, i))

    # -------------------------------------------------------------- lookup

    @staticmethod
    def _cell_of(x: float, y: float) -> tuple[int, int]:
        return int(x // GRID_CELL_M), int(y // GRID_CELL_M)

    @staticmethod
    def _project_segment(p: tuple[float, float], a: tuple[float, float], b: tuple[float, float]):
        abx, aby = b[0] - a[0], b[1] - a[1]
        denom = abx * abx + aby * aby
        if denom == 0.0:
            t, dist2 = 0.0, (p[0] - a[0]) ** 2 + (p[1] - a[1]) ** 2
        else:
            t = max(0.0, min(1.0, ((p[0] - a[0]) * abx + (p[1] - a[1]) * aby) / denom))
            px, py = a[0] + t * abx, a[1] + t * aby
            dist2 = (p[0] - px) ** 2 + (p[1] - py) ** 2
        return t, dist2

    def nearest_lane(self, p: tuple[float, float], *, max_distance_m: float = DEFAULT_MAX_DISTANCE_M,
                     lane_types=("driving",)) -> LaneHit | None:
        """Grid-ring nearest-lane query; returns travel-order hit or None."""
        base = self._cell_of(*p)
        best: LaneHit | None = None
        for ring in range(0, 64):
            candidates: list[tuple[str, int]] = []
            for cx in range(base[0] - ring, base[0] + ring + 1):
                for cy in range(base[1] - ring, base[1] + ring + 1):
                    if max(abs(cx - base[0]), abs(cy - base[1])) != ring:
                        continue
                    candidates.extend(self._grid.get((cx, cy), ()))
            if not candidates:
                if ring > 2 and best is not None:
                    break  # rings only widen; best cannot improve past this
                continue
            for rsl, seg in candidates:
                node = self._by_rsl[rsl]
                if lane_types and node.lane_type not in lane_types:
                    continue
                a, b = node.points[seg], node.points[seg + 1]
                t, dist2 = self._project_segment(p, a, b)
                d = math.sqrt(dist2)
                if d > max_distance_m:
                    continue
                if best is not None and d >= best.distance_m:
                    continue
                s_along = node.cum[seg] + t * (node.cum[seg + 1] - node.cum[seg])
                qx, qy = a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])
                heading = _heading(a, b)
                # Signed lateral offset: left of travel direction positive.
                cross = -(qx - p[0]) * math.sin(heading) + (qy - p[1]) * math.cos(heading)
                best = LaneHit(
                    lane=node,
                    s=s_along,
                    distance_m=d,
                    offset_m=cross,
                    heading_rad=heading,
                    point=(qx, qy),
                )
            if best is not None and ring >= 2 and best.distance_m <= ring * GRID_CELL_M:
                break
        return best

    # ---------------------------------------------------------------- pose

    def pose_at(self, lane: LaneNode, s: float) -> tuple[tuple[float, float], float] | None:
        """Point and travel heading at arc length ``s`` (clamped)."""
        s = max(0.0, min(lane.length_m, s))
        for i in range(1, len(lane.cum)):
            if lane.cum[i] >= s or i == len(lane.cum) - 1:
                seg_len = lane.cum[i] - lane.cum[i - 1]
                t = 0.0 if seg_len == 0 else (s - lane.cum[i - 1]) / seg_len
                a, b = lane.points[i - 1], lane.points[i]
                return (
                    (a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])),
                    _heading(a, b),
                )
        return None

    def width_at(self, lane: LaneNode, s_travel: float) -> float:
        """Interpolated lane width at travel arc length ``s_travel``."""
        samples = lane.width_samples
        if not samples:
            return 0.0
        s_src = (lane.length_m - s_travel) if lane.lane_id > 0 else s_travel
        prev = samples[0]
        for sample in samples[1:]:
            if sample["s"] >= s_src:
                span = sample["s"] - prev["s"]
                if span <= 0:
                    return float(sample["widthM"])
                w = prev["widthM"] + (sample["widthM"] - prev["widthM"]) * (s_src - prev["s"]) / span
                return float(w)
            prev = sample
        return float(prev["widthM"])

    def get(self, rsl: str) -> LaneNode | None:
        return self._by_rsl.get(rsl)

    def all_lanes(self) -> list[LaneNode]:
        return list(self._by_rsl.values())

def load_topology_index(dev_assets_root: Path | str, map_id: str) -> dict:
    """Read the map's TopologyIndex (flat or ``browser/`` layout)."""
    base = Path(dev_assets_root) / map_id
    for candidate in (base / "topology-index.json.gz",
                      base / "browser" / "topology-index.json.gz"):
        if candidate.exists():
            with gzip.open(candidate, "rt", encoding="utf-8") as handle:
                return json.load(handle)
    raise FileNotFoundError(f"no topology-index.json.gz under {base}")


def find_dev_assets(explicit: str | None = None) -> Path:
    """Resolve the dev-assets root holding the map artifacts."""
    import os

    candidates = []
    if explicit or os.environ.get("SCEN_DEV_ASSETS"):
        candidates.append(Path(explicit or os.environ["SCEN_DEV_ASSETS"]))
    repo_root = Path(__file__).resolve().parents[3]
    candidates.append(repo_root / "dev-assets")
    candidates.append(Path("/home/path/UniScenarios/dev-assets"))
    for candidate in candidates:
        if candidate.is_dir() and any(candidate.glob("*/browser/topology-index.json.gz")):
            return candidate.resolve()
    raise RuntimeError(
        f"no dev-assets root with <map>/browser/topology-index.json.gz found "
        f"(tried {[str(c) for c in candidates]}; set SCEN_DEV_ASSETS)"
    )
