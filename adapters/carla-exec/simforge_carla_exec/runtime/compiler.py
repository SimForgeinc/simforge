from __future__ import annotations

import hashlib
import json
import math
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field, replace
from typing import Callable, Mapping

from .contract import MAX_ACTOR_COUNT, MAX_ACTOR_FRAME_STATES, MAX_DURATION_SECONDS, ContractError, reject_unsafe_xml_envelope

STEP_SECONDS = 0.02
MAX_FRAMES = int(MAX_DURATION_SECONDS / STEP_SECONDS) + 1
SUPPORTED_ACTOR_KINDS = {"vehicle", "car", "truck", "bus", "van", "motorcycle", "bicycle", "scooter", "pedestrian", "animal", "static_object"}

# Every indication `CONTROL_INDICATIONS` (`@simforge/engine`) can
# put on a signal head, and therefore every `state` the writer can emit on a
# `TrafficSignalStateAction`.  This tuple is the interpreter half of that
# contract: the exhaustiveness pairing lives in
# `tests/test_worker.py::test_signal_indications_cover_every_writer_indication`
# and in the cross-language golden corpus.
#
# Arrow and lane-use indications are NOT extra colours.  A head's arrow/X glyph
# is *hardware* — it is derived from the plan's protected turns, never from the
# phase word (see `signal-head-model.ts`, "Arrow lenses come from the PLAN").
# So `green_arrow` is a green lamp on an arrow head, and the renderer resolves
# it to the same lamp as `green`.  `backend.SIGNAL_LAMP_BY_INDICATION` owns that
# resolution; keeping the authored word in the plan keeps the `.xosc` — which is
# both the execution contract and the user-facing export — lossless.
SIGNAL_INDICATIONS = (
    "green", "yellow", "red", "flashing_yellow", "flashing_red", "off",
    "green_arrow", "yellow_arrow", "red_x", "proceed", "stop",
)

# The appearance vocabulary the writer emits and the renderer executes.
VEHICLE_LIGHT_TYPES = (
    "indicatorLeft", "indicatorRight", "warningLights",
    "brakeLights", "reversingLights", "specialPurposeLights",
    "daytimeRunningLights", "lowBeam", "highBeam",
)
VEHICLE_LIGHT_MODES = ("on", "off", "flashing")
# `trunk` is an XML 1.4 vehicleComponentType and the official XSD accepts it,
# but CARLA 0.10.0's `carla.VehicleDoor` binding exports only FL/FR/RL/RR/All,
# so a `trunk` animation could never be actuated.  The writer rejects
# `doors.rear` at export for that reason; accepting it here would only move the
# failure to render time.  Rear doors would need RL/RR, which the set-key
# schema does not currently distinguish.
VEHICLE_COMPONENT_TYPES = ("doorFrontLeft", "doorFrontRight")

LIFECYCLE_SPAWN = "spawn"
LIFECYCLE_ACTIVE = "active"
LIFECYCLE_ABSENT = "absent"


@dataclass(frozen=True)
class ActorBinding:
    id: str
    entity_ref: str
    kind: str
    catalog_name: str
    materialized_traffic_eligible: bool = False
    # Actors with an Init pose but no timed trajectory are authored stationary
    # entities. Native CARLA settles them once, then holds them kinematically.
    static: bool = False


@dataclass(frozen=True)
class ActorFrame:
    lifecycle: str
    x: float
    y: float
    z: float
    heading_deg: float
    speed_mps: float
    #: Latched appearance state, keyed `light.<vehicleLightType>`,
    #: `door.<vehicleComponentType>` or `cue.<userDefinedAnimationType>`.
    appearance: Mapping[str, str] = field(default_factory=dict)
    #: The body was knocked off its feet before this frame. OpenSCENARIO carries
    #: where it slid to but has no posture for it, so the export declares the
    #: time in a `uniscenarios.trajectoryReplay.knockedDownAtS.*` header property
    #: and the backend lays the actor down from here.
    downed: bool = False


@dataclass(frozen=True)
class PlanFrame:
    index: int
    t: float
    actors: Mapping[str, ActorFrame]
    signals: Mapping[str, str]


@dataclass(frozen=True)
class ExecutionPlan:
    schema: str
    fixed_timestep_s: float
    actors: Mapping[str, ActorBinding]
    frames: tuple[PlanFrame, ...]
    sha256: str
    semantic_metadata: Mapping[str, object] = field(default_factory=dict)


def _semantic_metadata(
    properties: Mapping[str, str],
    actors: Mapping[str, ActorBinding],
) -> Mapping[str, object]:
    """Parse the exporter-owned semantic ledger embedded in FileHeader.

    Older local fixtures intentionally remain compilable, but are marked
    incomplete so they can never produce acceptance-eligible managed parity
    evidence. Once any v1 ledger property is present, the complete set is
    mandatory and malformed or identity-drifting metadata fails closed.
    """
    prefix = "uniscenarios.trajectoryReplay."
    required = {
        "actorIds": f"{prefix}actorIds.v1",
        "authoredActorIds": f"{prefix}authoredActorIds.v1",
        "interactions": f"{prefix}interactions.v1",
        "events": f"{prefix}events.v1",
        "signals": f"{prefix}signals.v1",
        "environment": f"{prefix}environment.v1",
        "surfacePatches": f"{prefix}surfacePatches.v1",
        "occluders": f"{prefix}occluders.v1",
    }
    present = [name for name in required.values() if name in properties]
    if not present:
        return {
            "complete": False,
            "actorIds": sorted(actors),
            "authoredActorIds": sorted(actors),
            "interactionIds": [],
            "events": [],
            "signals": [],
            "environment": {},
            "surfacePatchIds": [],
            "occluderIds": [],
            "hasPerception": False,
            "sha256": hashlib.sha256(b"legacy-incomplete-semantic-metadata").hexdigest(),
        }
    missing = [name for name in required.values() if name not in properties]
    if missing:
        raise ContractError(f"trajectory replay semantic metadata is incomplete: {', '.join(sorted(missing))}")

    parsed: dict[str, object] = {}
    for key, name in required.items():
        try:
            parsed[key] = json.loads(properties[name])
        except (TypeError, json.JSONDecodeError) as exc:
            raise ContractError(f"trajectory replay semantic metadata {name} is invalid JSON") from exc
    actor_ids = parsed["actorIds"]
    authored_actor_ids = parsed["authoredActorIds"]
    if (
        not isinstance(actor_ids, list)
        or any(not isinstance(item, str) or not item for item in actor_ids)
        or len(set(actor_ids)) != len(actor_ids)
        or set(actor_ids) != set(actors)
    ):
        raise ContractError("trajectory replay actor identity ledger differs from executable actors")
    if (
        not isinstance(authored_actor_ids, list)
        or any(not isinstance(item, str) or not item for item in authored_actor_ids)
        or len(set(authored_actor_ids)) != len(authored_actor_ids)
        or set(authored_actor_ids) != set(actor_ids)
    ):
        raise ContractError("trajectory replay authored actor identity ledger is invalid")

    def ledger_ids(value: object, label: str) -> list[str]:
        if not isinstance(value, list):
            raise ContractError(f"trajectory replay {label} ledger must be an array")
        ids: list[str] = []
        for index, item in enumerate(value):
            if not isinstance(item, Mapping):
                raise ContractError(f"trajectory replay {label}[{index}] must be an object")
            identifier = item.get("id")
            if not isinstance(identifier, str) or not identifier:
                raise ContractError(f"trajectory replay {label}[{index}].id is required")
            ids.append(identifier)
        if len(set(ids)) != len(ids):
            raise ContractError(f"trajectory replay {label} ledger contains duplicate ids")
        return ids

    interaction_ids = ledger_ids(parsed["interactions"], "interactions")
    surface_patch_ids = ledger_ids(parsed["surfacePatches"], "surface patches")
    occluder_ids = ledger_ids(parsed["occluders"], "occluders")
    events = parsed["events"]
    signals = parsed["signals"]
    environment = parsed["environment"]
    if not isinstance(events, list) or any(not isinstance(item, Mapping) for item in events):
        raise ContractError("trajectory replay events ledger must be an array of objects")
    if not isinstance(signals, list) or any(not isinstance(item, Mapping) for item in signals):
        raise ContractError("trajectory replay signals ledger must be an array of objects")
    if not isinstance(environment, Mapping):
        raise ContractError("trajectory replay environment ledger must be an object")
    perception_name = f"{prefix}perception.v1"
    perception: object | None = None
    if perception_name in properties:
        try:
            perception = json.loads(properties[perception_name])
        except json.JSONDecodeError as exc:
            raise ContractError("trajectory replay perception metadata is invalid JSON") from exc

    canonical = {
        "actorIds": actor_ids,
        "authoredActorIds": authored_actor_ids,
        "interactionIds": interaction_ids,
        "events": events,
        "signals": signals,
        "environment": environment,
        "surfacePatchIds": surface_patch_ids,
        "occluderIds": occluder_ids,
        "perception": perception,
    }
    return {
        "complete": True,
        **canonical,
        "hasPerception": perception_name in properties,
        "sha256": hashlib.sha256(
            json.dumps(canonical, sort_keys=True, separators=(",", ":")).encode()
        ).hexdigest(),
    }


def _finite(raw: str | None, label: str) -> float:
    try:
        result = float(raw)  # type: ignore[arg-type]
    except (TypeError, ValueError) as exc:
        raise ContractError(f"{label} must be finite") from exc
    if not math.isfinite(result):
        raise ContractError(f"{label} must be finite")
    return result


def _property_map(entity: ET.Element) -> dict[str, str]:
    return {item.get("name", ""): item.get("value", "") for item in entity.findall(".//Property")}


def _kind(entity: ET.Element, properties: Mapping[str, str]) -> str:
    explicit = properties.get("uniscenario.actorKind") or properties.get("uniscenarios.actorKind")
    if explicit:
        return explicit
    if entity.find("Vehicle") is not None:
        return "vehicle"
    if entity.find("Pedestrian") is not None:
        return "pedestrian"
    return "static_object"


def _entities(root: ET.Element, abort: Callable[[], None]) -> dict[str, ActorBinding]:
    result: dict[str, ActorBinding] = {}
    for entity in root.findall("./Entities/ScenarioObject"):
        abort()
        entity_ref = entity.get("name")
        if not entity_ref:
            raise ContractError("ScenarioObject.name is required")
        properties = _property_map(entity)
        catalog_tag = next((item.get("value", "")[len("catalog:"):] for item in entity.findall(".//Property") if item.get("name") in {"uniscenario.tag", "uniscenarios.tag"} and item.get("value", "").startswith("catalog:")), None)
        actor_id = properties.get("uniscenario.actorId") or properties.get("uniscenarios.actorId")
        actor_id = actor_id or entity_ref.removeprefix("actor_")
        if actor_id in result:
            raise ContractError(f"duplicate actor identity {actor_id}")
        catalog = entity.find("CatalogReference")
        inline = entity.find("Vehicle")
        if inline is None:
            inline = entity.find("Pedestrian")
        if inline is None:
            inline = entity.find("MiscObject")
        catalog_name = (catalog.get("entryName") if catalog is not None else None) or catalog_tag or (
            inline.get("name") if inline is not None else entity_ref
        )
        actor_kind = _kind(entity, properties)
        if actor_kind not in SUPPORTED_ACTOR_KINDS:
            raise ContractError(f"actor {actor_id} has unsupported kind {actor_kind}")
        materialized_traffic_eligible = (
            actor_id.startswith("ambient:")
            and properties.get("uniscenarios.actorOrigin") == "canonical-ambient"
        )
        result[actor_id] = ActorBinding(actor_id, entity_ref, actor_kind, catalog_name, materialized_traffic_eligible)
    if not result:
        raise ContractError("OpenSCENARIO must contain at least one ScenarioObject")
    return result


def _initial_positions(root: ET.Element, actors: Mapping[str, ActorBinding], abort: Callable[[], None]) -> dict[str, tuple[float, ...]]:
    by_ref = {binding.entity_ref: actor_id for actor_id, binding in actors.items()}
    result: dict[str, tuple[float, ...]] = {}
    for private in root.findall("./Storyboard/Init/Actions/Private"):
        abort()
        actor_id = by_ref.get(private.get("entityRef", ""))
        position = private.find(".//TeleportAction/Position/WorldPosition")
        if actor_id and position is not None:
            result[actor_id] = (
                _finite(position.get("x"), "initial x"),
                _finite(position.get("y"), "initial y"),
                _finite(position.get("z", "0"), "initial z"),
                _finite(position.get("h", "0"), "initial heading"),
                0.0,
            )
    return result


def _trajectory_vertices(action: ET.Element, abort: Callable[[], None]) -> list[tuple[float, ...]]:
    abort()
    timing = action.find("./TimeReference/Timing")
    if (
        timing is None
        or timing.get("domainAbsoluteRelative") != "absolute"
        or _finite(timing.get("scale"), "trajectory timing scale") != 1.0
        or _finite(timing.get("offset"), "trajectory timing offset") != 0.0
    ):
        raise ContractError("trajectory replay requires absolute Timing with scale 1 and offset 0")
    trajectory = action.find("./TrajectoryRef/Trajectory")
    if trajectory is None:
        raise ContractError("trajectory replay requires an inline TrajectoryRef")
    polyline = trajectory.find("./Shape/Polyline")
    if polyline is None:
        raise ContractError("trajectory replay requires a Polyline shape")
    vertices: list[tuple[float, ...]] = []
    for index, vertex in enumerate(polyline.findall("./Vertex")):
        if index % 128 == 0:
            abort()
        world = vertex.find("./Position/WorldPosition")
        if world is None:
            raise ContractError("only WorldPosition trajectory vertices are supported")
        motion = vertex.find("./Motion")
        vertices.append((
            _finite(vertex.get("time"), "trajectory time"),
            _finite(world.get("x"), "trajectory x"),
            _finite(world.get("y"), "trajectory y"),
            _finite(world.get("z", "0"), "trajectory z"),
            _finite(world.get("h", "0"), "trajectory heading"),
            _finite(motion.get("speed_longitudinal"), "trajectory speed") if motion is not None else math.nan,
        ))
    if not vertices:
        raise ContractError("trajectory Polyline must contain vertices")
    abort()
    vertices.sort(key=lambda item: item[0])
    abort()
    for index, (left, right) in enumerate(zip(vertices, vertices[1:])):
        if index % 128 == 0:
            abort()
        if right[0] <= left[0]:
            raise ContractError("trajectory vertex times must be strictly increasing")
    return vertices


def _trajectories(root: ET.Element, actors: Mapping[str, ActorBinding], abort: Callable[[], None]) -> dict[str, list[tuple[float, ...]]]:
    abort()
    by_ref = {binding.entity_ref: actor_id for actor_id, binding in actors.items()}
    result: dict[str, list[tuple[float, ...]]] = {}

    def add(actor_id: str, action: ET.Element) -> None:
        if actor_id in result:
            raise ContractError(f"actor {actor_id} has multiple replay trajectories")
        result[actor_id] = _trajectory_vertices(action, abort)

    # The canonical Scenario trajectory-replay profile starts each actor's
    # FollowTrajectoryAction from Storyboard/Init. OpenSCENARIO 1.4 permits
    # private routing actions there and this avoids a second, trigger-mediated
    # start time. Keep accepting the equivalent Story/ManeuverGroup form for
    # standards-compliant packages authored outside Scenario.
    for private in root.findall("./Storyboard/Init/Actions/Private"):
        abort()
        actor_id = by_ref.get(private.get("entityRef", ""))
        actions = private.findall("./PrivateAction/RoutingAction/FollowTrajectoryAction")
        if actions and actor_id is None:
            raise ContractError("Init trajectory references an unknown ScenarioObject")
        for action in actions:
            add(actor_id, action)  # type: ignore[arg-type]

    for group in root.findall("./Storyboard/Story//ManeuverGroup"):
        abort()
        refs = [item.get("entityRef", "") for item in group.findall("./Actors/EntityRef")]
        actor_ids = [by_ref[item] for item in refs if item in by_ref]
        actions = group.findall(".//FollowTrajectoryAction")
        if not actions:
            continue
        if not actor_ids:
            raise ContractError("replay ManeuverGroup references no known actor")
        for actor_id in actor_ids:
            for action in actions:
                add(actor_id, action)
    abort()
    return result


def _signal_timeline(root: ET.Element, abort: Callable[[], None]) -> tuple[dict[str, str], list[tuple[float, str, str]]]:
    initial: dict[str, str] = {}
    events: list[tuple[float, str, str]] = []
    allowed = set(SIGNAL_INDICATIONS)
    for action in root.findall("./Storyboard/Init//TrafficSignalStateAction"):
        abort()
        name, state = action.get("name"), action.get("state")
        if not name or state not in allowed:
            raise ContractError("traffic signal initialization has an unsupported identity or state")
        initial[name] = state
    for event in root.findall("./Storyboard/Story//Event"):
        abort()
        actions = event.findall(".//TrafficSignalStateAction")
        if not actions:
            continue
        at = _event_time(event, "traffic signal replay event")
        for action in actions:
            abort()
            name, state = action.get("name"), action.get("state")
            if not name or state not in allowed:
                raise ContractError("traffic signal replay event has an unsupported identity or state")
            events.append((at, name, state))
    events.sort()
    return initial, events


def _event_time(event: ET.Element, label: str) -> float:
    condition = event.find("./StartTrigger//SimulationTimeCondition")
    if condition is None:
        raise ContractError(f"{label} must use a SimulationTimeCondition")
    return _finite(condition.get("value"), f"{label} time")


def _appearance_settings(action: ET.Element) -> list[tuple[str, str]]:
    """Translate one `AppearanceAction` into latched appearance settings.

    The writer's whole appearance vocabulary is accepted here.  What the CARLA
    renderer can physically execute is a separate question answered in
    `backend.py`: `light.*` and `door.*` reach pixels, `cue.*` (OpenSCENARIO
    `UserDefinedAnimation`, used for `pose.*` articulation and `audio.horn`) is
    carried through the plan and reported as unrendered instead of failing the
    job.  Rejecting it here is what used to kill every render carrying one.
    """
    light = action.find("./LightStateAction")
    if light is not None:
        vehicle_light = light.find("./LightType/VehicleLight")
        state = light.find("./LightState")
        light_type = vehicle_light.get("vehicleLightType") if vehicle_light is not None else None
        mode = state.get("mode") if state is not None else None
        if light_type not in VEHICLE_LIGHT_TYPES or mode not in VEHICLE_LIGHT_MODES:
            raise ContractError("appearance light action has an unsupported light type or mode")
        return [(f"light.{light_type}", mode)]
    animation = action.find("./AnimationAction")
    if animation is not None:
        component = animation.find("./AnimationType/ComponentAnimation/VehicleComponent")
        if component is not None:
            component_type = component.get("vehicleComponentType")
            state = animation.find("./AnimationState")
            raw = state.get("state") if state is not None else None
            if component_type not in VEHICLE_COMPONENT_TYPES or raw not in {"0", "1"}:
                raise ContractError("appearance component animation has an unsupported component or state")
            return [(f"door.{component_type}", "open" if raw == "1" else "closed")]
        user_defined = animation.find("./AnimationType/UserDefinedAnimation")
        cue = user_defined.get("userDefinedAnimationType") if user_defined is not None else None
        if cue:
            return [(f"cue.{cue}", "requested")]
    raise ContractError("trajectory-replay appearance action is not a light, door, or user-defined cue")


def _appearance_and_lifecycle(
    root: ET.Element,
    actors: Mapping[str, ActorBinding],
    abort: Callable[[], None],
) -> tuple[list[tuple[float, str, str, str]], dict[str, float]]:
    """Collect latched appearance settings and despawn times from the Story."""
    by_ref = {binding.entity_ref: actor_id for actor_id, binding in actors.items()}
    settings: list[tuple[float, str, str, str]] = []
    despawn_at: dict[str, float] = {}
    for group in root.findall("./Storyboard/Story//ManeuverGroup"):
        abort()
        refs = [item.get("entityRef", "") for item in group.findall("./Actors/EntityRef")]
        group_actors = [by_ref[item] for item in refs if item in by_ref]
        for event in group.findall(".//Event"):
            abort()
            appearance = event.findall(".//AppearanceAction")
            deletions = [
                item for item in event.findall(".//EntityAction")
                if item.find("./DeleteEntityAction") is not None
            ]
            if not appearance and not deletions:
                continue
            at = _event_time(event, "appearance or entity-lifecycle replay event")
            if appearance:
                if not group_actors:
                    raise ContractError("appearance ManeuverGroup references no known actor")
                for actor_id in group_actors:
                    for action in appearance:
                        abort()
                        for key, value in _appearance_settings(action):
                            settings.append((at, actor_id, key, value))
            for entity_action in deletions:
                abort()
                actor_id = by_ref.get(entity_action.get("entityRef", ""))
                if actor_id is None:
                    raise ContractError("DeleteEntityAction references an unknown ScenarioObject")
                despawn_at[actor_id] = min(at, despawn_at.get(actor_id, at))
    settings.sort(key=lambda item: (item[0], item[1], item[2]))
    return settings, despawn_at


def _derived_longitudinal_speed(
    left: tuple[float, ...],
    right: tuple[float, ...],
    heading: float,
) -> float:
    velocity_x = (right[1] - left[1]) / (right[0] - left[0])
    velocity_y = (right[2] - left[2]) / (right[0] - left[0])
    return velocity_x * math.cos(heading) + velocity_y * math.sin(heading)


def _sample(points: list[tuple[float, ...]], t: float, abort: Callable[[], None]) -> tuple[float, ...]:
    abort()
    if t <= points[0][0]:
        value = points[0][1:]
        speed = value[4]
        if math.isnan(speed):
            speed = _derived_longitudinal_speed(points[0], points[1], value[3]) if len(points) > 1 else 0.0
        return (*value[:4], speed)
    if t >= points[-1][0]:
        value = points[-1][1:]
        speed = value[4]
        if math.isnan(speed):
            speed = _derived_longitudinal_speed(points[-2], points[-1], value[3]) if len(points) > 1 else 0.0
        return (*value[:4], speed)
    low, high = 0, len(points) - 1
    while high - low > 1:
        abort()
        middle = (low + high) // 2
        if points[middle][0] <= t:
            low = middle
        else:
            high = middle
    left, right = points[low], points[high]
    ratio = (t - left[0]) / (right[0] - left[0])
    heading_delta = (right[4] - left[4] + math.pi) % (2 * math.pi) - math.pi
    values = tuple(left[index] + (right[index] - left[index]) * ratio for index in (1, 2, 3))
    heading = left[4] + heading_delta * ratio
    speed = left[5] + (right[5] - left[5]) * ratio
    if math.isnan(speed):
        # OpenSCENARIO longitudinal speed is signed.  When an exporter omits
        # Motion.speed_longitudinal, recover that sign by projecting the
        # segment velocity onto the actor's authored forward axis.  Using the
        # old Euclidean magnitude silently turned reverse trajectories into
        # forward throttle requests in native CARLA execution.
        speed = _derived_longitudinal_speed(left, right, heading)
    return (*values, heading, speed)


def _canonical_plan_sha256(
    actors: Mapping[str, ActorBinding],
    frames: tuple[PlanFrame, ...],
    semantic_metadata: Mapping[str, object],
    abort: Callable[[], None],
) -> str:
    digest = hashlib.sha256()
    first = True
    def add(part: str) -> None:
        nonlocal first
        if not first:
            digest.update(b"\n")
        digest.update(part.encode())
        first = False
    add("uniscenario.execution-plan/v1")
    add(str(STEP_SECONDS))
    if semantic_metadata.get("complete"):
        add(f"M|{semantic_metadata['sha256']}")
    for actor_id in sorted(actors):
        abort()
        actor = actors[actor_id]
        add(f"A|{actor.id}|{actor.entity_ref}|{actor.kind}|{actor.catalog_name}")
    for frame in frames:
        abort()
        add(f"F|{frame.index}|{frame.t:.9f}")
        for actor_id in sorted(frame.actors):
            abort()
            state = frame.actors[actor_id]
            add(f"S|{actor_id}|{state.lifecycle}|{state.x:.9f}|{state.y:.9f}|{state.z:.9f}|{state.heading_deg:.9f}|{state.speed_mps:.9f}")
            if state.downed:
                # Appended only when a body went down, so every plan that came
                # before knockdowns existed keeps its exact digest.
                add(f"D|{actor_id}")
            if state.appearance:
                # Appended only when present, so plans without appearance state
                # keep the exact digest they had before appearance existed.
                add("P|" + actor_id + "|" + ",".join(
                    f"{key}={state.appearance[key]}" for key in sorted(state.appearance)
                ))
        for signal_id in sorted(frame.signals):
            abort()
            add(f"L|{signal_id}|{frame.signals[signal_id]}")
    abort()
    return digest.hexdigest()


def substitute_actor_catalog_bindings(
    plan: ExecutionPlan,
    substitutions: Mapping[str, str],
    abort: Callable[[], None] | None = None,
) -> ExecutionPlan:
    """Return a hash-honest plan with selected runtime catalog identities replaced."""
    if not substitutions:
        return plan
    check = abort or (lambda: None)
    unknown = sorted(set(substitutions) - set(plan.actors))
    if unknown:
        raise ContractError(
            "runtime catalog substitutions reference unknown actors: "
            + ", ".join(unknown)
        )
    actors = {
        actor_id: (
            replace(binding, catalog_name=substitutions[actor_id])
            if actor_id in substitutions
            else binding
        )
        for actor_id, binding in plan.actors.items()
    }
    digest = _canonical_plan_sha256(actors, plan.frames, plan.semantic_metadata, check)
    return replace(plan, actors=actors, sha256=digest)


def compile_xosc14(xml_bytes: bytes, abort: Callable[[], None] | None = None) -> ExecutionPlan:
    check = abort or (lambda: None)
    check()
    reject_unsafe_xml_envelope(xml_bytes)
    try:
        root = ET.fromstring(xml_bytes)
    except ET.ParseError as exc:
        raise ContractError(f"invalid OpenSCENARIO XML: {exc}") from exc
    check()
    if root.tag != "OpenSCENARIO":
        raise ContractError("root element must be OpenSCENARIO")
    header = root.find("FileHeader")
    if header is None or header.get("revMajor") != "1" or header.get("revMinor") != "4":
        raise ContractError("FileHeader must declare OpenSCENARIO XML 1.4")
    header_properties = _property_map(header)
    execution_mode = header_properties.get("uniscenario.executionMode") or header_properties.get("uniscenarios.executionMode")
    # A knocked-down body is a simulation outcome with no OpenSCENARIO element,
    # so the exporter declares it per actor in the header. Absent for every
    # scenario where nobody was run over.
    knocked_down_at: dict[str, float] = {}
    for name, value in header_properties.items():
        for prefix in ("uniscenario.trajectoryReplay.knockedDownAtS.", "uniscenarios.trajectoryReplay.knockedDownAtS."):
            if not name.startswith(prefix):
                continue
            try:
                knocked_down_at[name[len(prefix):]] = float(value)
            except ValueError as exc:
                raise ContractError(f"invalid knockdown time for {name[len(prefix):]}: {value!r}") from exc
    if execution_mode != "trajectory-replay":
        raise ContractError("render worker requires the OpenSCENARIO 1.4 trajectory-replay export profile")
    if root.findall(".//UserDefinedAction"):
        raise ContractError("this worker version does not support user-defined actions")
    for entity_action in root.findall("./Storyboard/Story//EntityAction"):
        if entity_action.find("./DeleteEntityAction") is None:
            raise ContractError("this worker version does not support runtime entity add actions")
    for global_action in root.findall("./Storyboard/Story//GlobalAction"):
        if (
            global_action.find(".//TrafficSignalStateAction") is None
            and global_action.find(".//DeleteEntityAction") is None
        ):
            raise ContractError("trajectory-replay contains an unsupported global action")
    for private_action in root.findall("./Storyboard/Story//PrivateAction"):
        if (
            private_action.find(".//FollowTrajectoryAction") is None
            and private_action.find("./AppearanceAction") is None
        ):
            raise ContractError("trajectory-replay Story may only contain FollowTrajectoryAction or AppearanceAction private actions")
    check()
    actors = _entities(root, check)
    if len(actors) > MAX_ACTOR_COUNT:
        raise ContractError(f"compiled plan exceeds {MAX_ACTOR_COUNT} actors")
    semantic_metadata = _semantic_metadata(header_properties, actors)
    check()
    initial = _initial_positions(root, actors, check)
    check()
    trajectories = _trajectories(root, actors, check)
    actors = {
        actor_id: ActorBinding(
            binding.id,
            binding.entity_ref,
            binding.kind,
            binding.catalog_name,
            binding.materialized_traffic_eligible,
            actor_id not in trajectories,
        )
        for actor_id, binding in actors.items()
    }
    check()
    initial_signals, signal_events = _signal_timeline(root, check)
    check()
    appearance_settings, despawn_at = _appearance_and_lifecycle(root, actors, check)
    check()
    if not trajectories:
        raise ContractError("worker requires at least one timed Polyline trajectory")
    missing = [actor_id for actor_id in actors if actor_id not in trajectories and actor_id not in initial]
    if missing:
        raise ContractError(f"actors lack an executable position or trajectory: {', '.join(sorted(missing))}")
    end = max(points[-1][0] for points in trajectories.values())
    if end > MAX_DURATION_SECONDS:
        raise ContractError(f"scenario duration exceeds {MAX_DURATION_SECONDS:g} seconds")
    count = int(round(end / STEP_SECONDS)) + 1
    if count < 1 or count > MAX_FRAMES:
        raise ContractError(f"compiled plan must contain 1..{MAX_FRAMES} frames")
    if count * len(actors) > MAX_ACTOR_FRAME_STATES:
        raise ContractError(f"compiled plan exceeds {MAX_ACTOR_FRAME_STATES} actor-frame states")
    frames: list[PlanFrame] = []
    signal_state = dict(initial_signals)
    signal_event_index = 0
    appearance_state: dict[str, dict[str, str]] = {}
    appearance_index = 0
    for index in range(count):
        if index % 50 == 0:
            check()
        t = round(index * STEP_SECONDS, 9)
        while signal_event_index < len(signal_events) and signal_events[signal_event_index][0] <= t + 1e-9:
            _, signal_id, state = signal_events[signal_event_index]
            signal_state[signal_id] = state
            signal_event_index += 1
        while appearance_index < len(appearance_settings) and appearance_settings[appearance_index][0] <= t + 1e-9:
            _, actor_id, key, value = appearance_settings[appearance_index]
            appearance_state.setdefault(actor_id, {})[key] = value
            appearance_index += 1
        states: dict[str, ActorFrame] = {}
        for actor_id, binding in actors.items():
            if len(states) % 32 == 0:
                check()
            points = trajectories.get(actor_id)
            raw = _sample(points, t, check) if points else initial.get(actor_id, (0, 0, 0, 0, 0))
            despawn = despawn_at.get(actor_id)
            if despawn is not None and t >= despawn - 1e-9:
                lifecycle = LIFECYCLE_ABSENT
            else:
                lifecycle = LIFECYCLE_SPAWN if index == 0 else LIFECYCLE_ACTIVE
            downed_at = knocked_down_at.get(actor_id)
            states[actor_id] = ActorFrame(
                lifecycle, raw[0], raw[1], raw[2], math.degrees(raw[3]), raw[4],
                dict(appearance_state.get(actor_id, {})),
                downed_at is not None and t >= downed_at - 1e-9,
            )
        frames.append(PlanFrame(index, t, states, dict(signal_state)))
    immutable = tuple(frames)
    check()
    digest = _canonical_plan_sha256(actors, immutable, semantic_metadata, check)
    return ExecutionPlan(
        "uniscenario.execution-plan/v1",
        STEP_SECONDS,
        actors,
        immutable,
        digest,
        semantic_metadata,
    )
