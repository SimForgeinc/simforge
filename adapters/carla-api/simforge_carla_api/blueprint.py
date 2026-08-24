"""Blueprint library mirroring ``world.get_blueprint_library()``.

The catalog is small and static: the engine's actor surface is the authored
scenario, so blueprints exist for binding handles (vehicles/walkers by
``role_name``) and for sensor attachment.
"""

from __future__ import annotations

import fnmatch
from dataclasses import dataclass, field


@dataclass(frozen=True)
class ActorBlueprint:
    type_id: str
    role_name: str = ""
    attributes: dict = field(default_factory=dict)

    def has_attribute(self, key: str) -> bool:
        return key == "role_name" or key in self.attributes

    def get_attribute(self, key: str) -> str:
        if key == "role_name":
            return self.role_name
        return str(self.attributes.get(key, ""))

    def set_attribute(self, key: str, value: str) -> "ActorBlueprint":
        """Attribute writes return a copy (sensor config, e.g. image_size_x)."""
        attrs = dict(self.attributes)
        attrs[key] = value
        return ActorBlueprint(self.type_id, self.role_name, attrs)

    def match(self, wildcard: str) -> bool:
        return fnmatch.fnmatchcase(self.type_id, wildcard) or (
            wildcard.startswith("role_name=") and self.role_name == wildcard.split("=", 1)[1]
        )

    def __repr__(self) -> str:  # pragma: no cover - cosmetic
        return f"<Blueprint {self.type_id} role={self.role_name!r}>"


class BlueprintLibrary:
    """Filterable list of blueprints."""

    def __init__(self, blueprints: list[ActorBlueprint]) -> None:
        self._blueprints = blueprints

    def filter(self, wildcard: str) -> "BlueprintLibrary":
        return BlueprintLibrary([b for b in self._blueprints if b.match(wildcard)])

    def find(self, type_id: str) -> ActorBlueprint | None:
        for blueprint in self._blueprints:
            if blueprint.type_id == type_id:
                return blueprint
        return None

    def __iter__(self):
        return iter(self._blueprints)

    def __len__(self) -> int:
        return len(self._blueprints)

    def __getitem__(self, index: int) -> ActorBlueprint:
        return self._blueprints[index]


def default_blueprint_library(authored_roles: list[dict]) -> BlueprintLibrary:
    """Library with vehicle/walker entries for each authored scenario role."""
    blueprints: list[ActorBlueprint] = []
    for role in authored_roles:
        kind = role.get("kind", "vehicle")
        tags = role.get("tags", [])
        cls = next((t.split(":", 1)[1] for t in tags if t.startswith("class:")), None)
        if kind in ("vehicle", "car") or cls == "car":
            prefix = "vehicle.simforge"
        elif kind == "pedestrian" or cls == "pedestrian":
            prefix = "walker.pedestrian"
        else:
            prefix = f"actor.{kind}"
        blueprints.append(ActorBlueprint(
            type_id=f"{prefix}.{cls}",
            role_name=role["id"],
            attributes={"dims_l_m": role.get("dims", {}).get("l", ""),
                        "dims_w_m": role.get("dims", {}).get("w", ""),
                        "dims_h_m": role.get("dims", {}).get("h", "")},
        ))
    # Sensor blueprints are attachable regardless of authored roles.
    blueprints.append(ActorBlueprint(
        "sensor.camera.rgb",
        attributes={"image_size_x": "736", "image_size_y": "416", "fov": "58.0"},
    ))
    blueprints.append(ActorBlueprint(
        "sensor.camera.depth", attributes={"image_size_x": "736", "image_size_y": "416"},
    ))
    return BlueprintLibrary(blueprints)
