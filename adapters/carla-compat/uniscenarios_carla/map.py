"""``carla.Map`` / ``carla.Waypoint`` backed by map-intel topology data."""

from __future__ import annotations

import math
from dataclasses import dataclass, field

from ._lanegraph import LaneGraphLite, LaneHit, LaneNode, find_dev_assets, load_topology_index
from .geom import Location, Rotation, Transform

#: Lane types treated as drivable for waypoint queries.
DRIVING_LANE_TYPES = ("driving",)


@dataclass(frozen=True)
class Waypoint:
    """A point on the road graph. Mirrors the used subset of carla.Waypoint."""

    transform: Transform
    road_id: int
    section_id: int
    lane_id: int
    s: float  # travel-ordered arc length along this lane, metres
    lane_width: float
    lane_type: str = "driving"
    is_junction: bool = False
    _graph: LaneGraphLite | None = field(default=None, repr=False)
    _lane: LaneNode | None = field(default=None, repr=False)

    # -- topology neighbours ------------------------------------------------

    def next(self, distance: float) -> list["Waypoint"]:
        """Waypoints roughly ``distance`` metres ahead in travel direction."""
        if self._graph is None or self._lane is None:
            return []
        return _walk(self._graph, self._lane, self.s, float(distance), forward=True)

    def previous(self, distance: float) -> list["Waypoint"]:
        """Waypoints roughly ``distance`` metres behind in travel direction."""
        if self._graph is None or self._lane is None:
            return []
        return _walk(self._graph, self._lane, self.s, float(distance), forward=False)

    def _neighbour_lane(self, side: str) -> "Waypoint | None":
        if self._graph is None or self._lane is None:
            return None
        row = [r for r, n in self._graph._by_rsl.items()
               if n.row_key == self._lane.row_key and n.lane_type in DRIVING_LANE_TYPES]
        row.sort(key=lambda r: int(r.split(":")[2]))
        try:
            idx = row.index(self._lane.rsl)
        except ValueError:
            return None
        # Right-hand traffic: driving lanes have negative ids; the more
        # negative id is farther right.
        j = idx - 1 if side == "right" else idx + 1
        if not (0 <= j < len(row)):
            return None
        node = self._graph.get(row[j])
        if node is None:
            return None
        return _waypoint_from_hit(self._graph, LaneHit(
            lane=node, s=min(self.s, node.length_m), distance_m=0.0, offset_m=0.0,
            heading_rad=0.0, point=(0.0, 0.0)))

    def get_left_lane(self) -> "Waypoint | None":
        return self._neighbour_lane("left")

    def get_right_lane(self) -> "Waypoint | None":
        return self._neighbour_lane("right")


def _waypoint_from_hit(graph: LaneGraphLite, hit: LaneHit) -> Waypoint:
    pose = graph.pose_at(hit.lane, hit.s)
    if pose is None:  # pragma: no cover - degenerate lane
        pose = (hit.lane.points[0], 0.0)
    (x, y), heading = pose
    return Waypoint(
        transform=Transform(location=Location(x=x, y=y, z=0.0),
                            rotation=Rotation(yaw=math.degrees(heading))),
        road_id=hit.lane.road_id,
        section_id=hit.lane.section_id,
        lane_id=hit.lane.lane_id,
        s=hit.s,
        lane_width=graph.width_at(hit.lane, hit.s),
        lane_type=hit.lane.lane_type,
        is_junction=hit.lane.is_junction,
        _graph=graph,
        _lane=hit.lane,
    )


def _walk(graph: LaneGraphLite, lane: LaneNode, s: float, distance: float, *, forward: bool) -> list[Waypoint]:
    """BFS along travel successors/predecessors until ``distance`` is covered."""
    results: list[Waypoint] = []
    travelled = 0.0
    current, cursor = lane, s
    while True:
        remaining = distance - travelled
        edge = current.length_m - cursor if forward else cursor
        if edge >= remaining:
            target = cursor + remaining if forward else cursor - remaining
            results.append(_waypoint_from_hit(graph, LaneHit(
                lane=current, s=target, distance_m=0.0, offset_m=0.0,
                heading_rad=0.0, point=(0.0, 0.0))))
            return results
        travelled += edge
        hops = current.travel_successors if forward else current.travel_predecessors
        nexts = [graph.get(r) for r in hops]
        nexts = [n for n in nexts if n is not None and n.lane_type in DRIVING_LANE_TYPES]
        if not nexts:
            return results
        # Branch: emit a waypoint at each continuation, but only continue the
        # walk along the first (carla returns all; deep branching explodes).
        current = nexts[0]
        cursor = 0.0 if forward else current.length_m
        for extra in nexts[1:]:
            at = 0.0 if forward else extra.length_m
            results.append(_waypoint_from_hit(graph, LaneHit(
                lane=extra, s=at, distance_m=0.0, offset_m=0.0, heading_rad=0.0, point=(0.0, 0.0))))


class Map:
    """``carla.Map`` facade: name, waypoints, recommended spawn points."""

    def __init__(self, map_id: str, graph: LaneGraphLite, spawn_points: list[Transform]) -> None:
        self.name = map_id
        self._graph = graph
        self._spawn_points = spawn_points

    # -- queries ------------------------------------------------------------

    def get_waypoint(self, location: Location, project_to_road: bool = True,
                     lane_type=DRIVING_LANE_TYPES) -> Waypoint | None:
        """Nearest driving lane waypoint to a world location (or None)."""
        hit = self._graph.nearest_lane((location.x, location.y), lane_types=DRIVING_LANE_TYPES)
        if hit is None:
            if project_to_road:
                return None
            return None
        return _waypoint_from_hit(self._graph, hit)

    def get_spawn_points(self) -> list[Transform]:
        """The authored scenario's spawn poses (engine is scenario-authoritative)."""
        return list(self._spawn_points)

    def get_topology(self) -> list[tuple[Waypoint, Waypoint]]:
        """(entry, exit) waypoint pairs, one per driving lane."""
        pairs: list[tuple[Waypoint, Waypoint]] = []
        for lane in self._graph.all_lanes():
            if lane.lane_type not in DRIVING_LANE_TYPES:
                continue
            start = self._graph.pose_at(lane, 0.0)
            end = self._graph.pose_at(lane, lane.length_m)
            if start is None or end is None:
                continue
            pairs.append((
                self.get_waypoint(Location(x=start[0][0], y=start[0][1], z=0.0)),
                self.get_waypoint(Location(x=end[0][0], y=end[0][1], z=0.0)),
            ))
        return [(a, b) for a, b in pairs if a is not None and b is not None]

    # -- unsupported surface (explicit) -------------------------------------

    def get_waypoint_xodr(self, road_id: int, lane_id: int, s: float):
        raise NotImplementedError("carla.Map.get_waypoint_xodr: not backed yet (see README coverage matrix)")

    def __repr__(self) -> str:  # pragma: no cover - cosmetic
        return f"Map(name={self.name!r})"


def load_map(map_id: str, dev_assets_root: str | None = None,
             spawn_points: list[Transform] | None = None) -> Map:
    root = find_dev_assets(dev_assets_root)
    topology = load_topology_index(root, map_id)
    return Map(map_id, LaneGraphLite(topology), spawn_points or [])
