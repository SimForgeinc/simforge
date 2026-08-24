"""``carla.Color`` + ``world.debug`` as a no-op draw-call queue.

The legacy bridge visualizes V2X zones and moving geofences with
``world.debug.draw_line(...)`` on the CARLA server. On this engine the
server draws nothing; instead every call is recorded into a retrievable
overlay list so frontends (native renderer, browser) can draw the same
geometry. Retrieval: ``world.debug.overlay`` / ``world.debug.consume()``.
"""

from __future__ import annotations

import itertools
import threading
from dataclasses import dataclass, field


@dataclass(frozen=True)
class Color:
    """carla.Color: 8-bit channels."""

    r: int = 0
    g: int = 0
    b: int = 0
    a: int = 255

    def __repr__(self) -> str:  # pragma: no cover - cosmetic
        return f"Color({self.r},{self.g},{self.b},{self.a})"


@dataclass(frozen=True)
class DrawLine:
    begin: tuple[float, float, float]
    end: tuple[float, float, float]
    thickness: float
    color: Color
    life_time: float
    persistent_lines: bool


@dataclass(frozen=True)
class DrawPoint:
    location: tuple[float, float, float]
    size: float
    color: Color
    life_time: float
    persistent_lines: bool


@dataclass
class DebugOverlay:
    """Recorded draw calls; safe against concurrent tick/callback use."""

    lines: list[DrawLine] = field(default_factory=list)
    points: list[DrawPoint] = field(default_factory=list)
    _lock: threading.Lock = field(default_factory=threading.Lock, repr=False)

    def record_line(self, call: DrawLine) -> None:
        with self._lock:
            self.lines.append(call)

    def record_point(self, call: DrawPoint) -> None:
        with self._lock:
            self.points.append(call)

    def snapshot(self) -> dict:
        with self._lock:
            return {
                "lines": [
                    {"begin": c.begin, "end": c.end, "thickness": c.thickness,
                     "color": [c.color.r, c.color.g, c.color.b, c.color.a],
                     "life_time": c.life_time, "persistent": c.persistent_lines}
                    for c in self.lines
                ],
                "points": [
                    {"location": c.location, "size": c.size,
                     "color": [c.color.r, c.color.g, c.color.b, c.color.a],
                     "life_time": c.life_time, "persistent": c.persistent_lines}
                    for c in self.points
                ],
            }


class DebugHelper:
    """The ``world.debug`` surface: records instead of drawing."""

    def __init__(self) -> None:
        self.overlay = DebugOverlay()
        self._counter = itertools.count()

    def draw_line(self, begin, end, thickness: float = 0.1, color=None,
                  life_time: float = -1.0, persistent_lines: bool = True) -> None:
        """Record one line segment (CARLA signature; lifetime semantics kept).

        ``life_time=-1``/``persistent_lines=True`` matches CARLA's default:
        the call stays in the overlay until explicitly consumed.
        """
        color = color or Color(255, 0, 0)
        self.overlay.record_line(DrawLine(
            begin=_xyz(begin), end=_xyz(end), thickness=float(thickness),
            color=color, life_time=float(life_time),
            persistent_lines=bool(persistent_lines)))

    def draw_point(self, location, size: float = 0.1, color=None,
                   life_time: float = -1.0, persistent_lines: bool = True) -> None:
        color = color or Color(255, 0, 0)
        self.overlay.record_point(DrawPoint(
            location=_xyz(location), size=float(size), color=color,
            life_time=float(life_time), persistent_lines=bool(persistent_lines)))

    def consume(self, clear: bool = True) -> dict:
        """Return and optionally clear the recorded overlay (frontend pull)."""
        snap = self.overlay.snapshot()
        if clear:
            self.clear()
        return snap

    def clear(self) -> None:
        self.overlay.lines.clear()
        self.overlay.points.clear()

def _xyz(v) -> tuple[float, float, float]:
    if hasattr(v, "x"):
        return (float(v.x), float(v.y), float(v.z))
    return (float(v[0]), float(v[1]), float(v[2]))
