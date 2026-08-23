"""``carla.LaneType`` bit flags over the map-intel lane vocabulary.

The topology index stores a per-lane ``laneType`` string (``driving``,
``sidewalk``, ``shoulder``, ``parking``). CARLA models these as bitmask
flags so callers can query several types at once
(``lane_type=carla.LaneType.Driving | carla.LaneType.Sidewalk``). The bit
values mirror the CARLA 0.9.x PythonAPI constants; the *identity* of the
constants is what consumers rely on, not their numeric value.
"""

from __future__ import annotations

#: Flag name → CARLA bit value.
_FLAG_VALUES: dict[str, int] = {
    "NONE": 0x0,
    "Driving": 0x1,
    "Sidewalk": 0x2,
    "Shoulder": 0x4,
    "Parking": 0x8,
    "Bidirectional": 0x10,
    "Median": 0x20,
    "Special1": 0x40,
    "Special2": 0x80,
    "Special3": 0x100,
    "RoadWorks": 0x200,
    "Restricted": 0x400,
}


def _mask(other) -> int:
    return other.value if isinstance(other, LaneType) else int(other)


class LaneType:
    """Bitmask flags mirroring carla.LaneType (subset actually backed here).

    The class attributes are ``LaneType`` *instances* wrapping the CARLA
    bit values, so ``LaneType.Driving | LaneType.Sidewalk`` stays a
    LaneType and compares equal to both instances and raw ints.
    """

    def __init__(self, value: int = 0):
        self.value = int(value)

    @classmethod
    def from_topology(cls, lane_type_str: str) -> "LaneType":
        """Map a topology-index ``laneType`` string to its flag."""
        flag = TOPOLOGY_TO_LANE_TYPE.get(lane_type_str)
        if flag is None:
            return cls.Shoulder  # unknown vocabulary degrades to Shoulder
        return flag

    def __or__(self, other) -> "LaneType":
        return LaneType(self.value | _mask(other))

    __ror__ = __or__

    def __and__(self, other) -> "LaneType":
        return LaneType(self.value & _mask(other))

    def __eq__(self, other) -> bool:
        if isinstance(other, LaneType):
            return self.value == other.value
        if isinstance(other, int):
            return self.value == other
        return NotImplemented

    def __hash__(self) -> int:
        return hash(self.value)

    def __repr__(self) -> str:
        names = [n for n, v in _FLAG_VALUES.items()
                 if v and self.value & v == v]
        return f"LaneType({'|'.join(names) or 'NONE'})"


# Class-level flag instances (defined after the class body).
for _name, _value in _FLAG_VALUES.items():
    setattr(LaneType, _name, LaneType(_value))

#: Topology-index lane-type string → CARLA bit value.
TOPOLOGY_TO_FLAG: dict[str, int] = {
    "driving": _FLAG_VALUES["Driving"],
    "sidewalk": _FLAG_VALUES["Sidewalk"],
    "shoulder": _FLAG_VALUES["Shoulder"],
    "parking": _FLAG_VALUES["Parking"],
    "bidirectional": _FLAG_VALUES["Bidirectional"],
    "median": _FLAG_VALUES["Median"],
    "restricted": _FLAG_VALUES["Restricted"],
    "roadWorks": _FLAG_VALUES["RoadWorks"],
}

#: Topology-index lane-type string → flag instance.
TOPOLOGY_TO_LANE_TYPE: dict[str, LaneType] = {
    topo: getattr(LaneType, next(n for n, v in _FLAG_VALUES.items() if v == flag))
    for topo, flag in TOPOLOGY_TO_FLAG.items()
}
