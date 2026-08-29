from __future__ import annotations

import hashlib
import json
import math
from dataclasses import dataclass
from typing import Any, Mapping

from .compiler import (
    ActorBinding,
    ActorFrame,
    ExecutionPlan,
    LIFECYCLE_ACTIVE,
    LIFECYCLE_ABSENT,
    LIFECYCLE_SPAWN,
    PlanFrame,
)
from .contract import ContractError, MAX_ACTOR_COUNT, MAX_ACTOR_FRAME_STATES, SHA256, canonical_json

SCHEMA = "simforge.materialized-traffic.v1"
# historical name retained for stored-data compat
HISTORICAL_SCHEMA = "uniscenarios.materialized-traffic.v1"
PROVIDERS = {"disabled", "native", "sumo"}
KINDS = {"vehicle", "pedestrian", "bicycle", "obstacle"}
SIGNAL_STATES = {"green", "yellow", "red", "off"}
ACTOR_STATE_FIELDS = {"t", "present", "x", "z", "headingRad", "speedMps", "accelerationMps2", "signals"}


@dataclass(frozen=True)
class TrafficActorState:
    t: float
    present: bool
    x: float
    z: float
    heading_rad: float
    speed_mps: float
    acceleration_mps2: float
    signals: int


@dataclass(frozen=True)
class TrafficActor:
    id: str
    kind: str
    states: tuple[TrafficActorState, ...]


@dataclass(frozen=True)
class TrafficSignal:
    id: str
    states: tuple[tuple[float, str], ...]


@dataclass(frozen=True)
class MaterializedTraffic:
    source_input_digest: str
    map_asset_id: str
    map_version_id: str
    provider_id: str
    provider_version: str
    provider_seed: str
    fixed_step_seconds: float
    duration_seconds: float
    actors: tuple[TrafficActor, ...]
    signals: tuple[TrafficSignal, ...]
    sha256: str


def _pairs(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ContractError(f"materialized traffic contains duplicate JSON field {key}")
        result[key] = value
    return result


def _object(value: Any, fields: set[str], label: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping) or set(value) != fields:
        raise ContractError(f"{label} has invalid fields")
    return value


def _string(value: Mapping[str, Any], field: str, label: str, *, empty: bool = False) -> str:
    item = value.get(field)
    if not isinstance(item, str) or (not empty and not item):
        qualifier = "a string" if empty else "a non-empty string"
        raise ContractError(f"{label}.{field} must be {qualifier}")
    return item


def _number(value: Any, label: str, *, nonnegative: bool = False) -> float:
    if not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(value):
        raise ContractError(f"{label} must be finite")
    number = float(value)
    if nonnegative and number < 0:
        raise ContractError(f"{label} must be nonnegative")
    return number


def _ordered_ids(items: Any, label: str) -> list[Mapping[str, Any]]:
    if not isinstance(items, list):
        raise ContractError(f"materialized traffic {label} must be an array")
    if any(not isinstance(item, Mapping) for item in items):
        raise ContractError(f"materialized traffic {label} entries must be objects")
    typed = list(items)
    ids = [_string(item, "id", f"materialized traffic {label} entry") for item in typed]
    if ids != sorted(set(ids), key=lambda item: item.encode("utf-16-be", errors="surrogatepass")):
        raise ContractError(f"materialized traffic {label} must be sorted by unique id")
    return typed


def _grid_times(duration: float, step: float) -> tuple[float, ...]:
    if step <= 0:
        raise ContractError("materialized traffic fixedStepSeconds must be positive")
    intervals = round(duration / step)
    if not math.isclose(intervals * step, duration, rel_tol=0, abs_tol=1e-9):
        raise ContractError("materialized traffic durationSeconds must lie on the fixed-step grid")
    return tuple(round(index * step, 9) for index in range(intervals + 1))


def _require_complete_times(raw_states: Any, expected: tuple[float, ...], label: str) -> list[Mapping[str, Any]]:
    if not isinstance(raw_states, list) or len(raw_states) != len(expected):
        raise ContractError(f"{label} states must cover every fixed-step frame")
    if any(not isinstance(item, Mapping) for item in raw_states):
        raise ContractError(f"{label} states must be objects")
    states = list(raw_states)
    actual = [_number(item.get("t"), f"{label}.states.t", nonnegative=True) for item in states]
    if any(not math.isclose(t, expected[index], rel_tol=0, abs_tol=1e-9) for index, t in enumerate(actual)):
        raise ContractError(f"{label} states must be strictly ordered and time-complete on the fixed-step grid")
    return states


def parse_materialized_traffic(
    body: bytes,
    *,
    expected_digest: str,
    source_input_digest: str,
    map_asset_id: str,
    map_version_id: str,
    provider_id: str,
    provider_version: str,
    provider_seed: str,
    fixed_step_seconds: float,
    duration_seconds: float,
) -> MaterializedTraffic:
    actual_digest = hashlib.sha256(body).hexdigest()
    if actual_digest != expected_digest:
        raise ContractError(f"materializedTraffic digest mismatch: expected {expected_digest}, got {actual_digest}")
    try:
        value = json.loads(body.decode("utf-8"), object_pairs_hook=_pairs)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ContractError("materialized traffic must be valid UTF-8 JSON") from exc
    root = _object(value, {"schema", "sourceInputDigest", "map", "provider", "fixedStepSeconds", "durationSeconds", "actors", "signals"}, "materialized traffic")
    if canonical_json(root).encode("utf-8") != body:
        raise ContractError("materialized traffic bytes must be canonical JSON")
    if root.get("schema") not in {SCHEMA, HISTORICAL_SCHEMA}:
        raise ContractError(f"materialized traffic schema must equal {SCHEMA}")
    artifact_source = _string(root, "sourceInputDigest", "materialized traffic")
    if not SHA256.fullmatch(artifact_source) or artifact_source != source_input_digest:
        raise ContractError("materialized traffic sourceInputDigest does not match the execution package")
    map_value = _object(root.get("map"), {"assetId", "versionId"}, "materialized traffic map")
    if _string(map_value, "assetId", "materialized traffic map") != map_asset_id or _string(map_value, "versionId", "materialized traffic map") != map_version_id:
        raise ContractError("materialized traffic map identity does not match the execution package")
    provider = _object(root.get("provider"), {"id", "version", "seed"}, "materialized traffic provider")
    artifact_provider = _string(provider, "id", "materialized traffic provider")
    if artifact_provider not in PROVIDERS or artifact_provider != provider_id:
        raise ContractError("materialized traffic provider does not match the execution package")
    if _string(provider, "version", "materialized traffic provider") != provider_version:
        raise ContractError("materialized traffic provider version does not match the execution package")
    if _string(provider, "seed", "materialized traffic provider", empty=True) != provider_seed:
        raise ContractError("materialized traffic provider seed does not match the execution package")
    step = _number(root.get("fixedStepSeconds"), "materialized traffic fixedStepSeconds")
    duration = _number(root.get("durationSeconds"), "materialized traffic durationSeconds", nonnegative=True)
    if not math.isclose(step, fixed_step_seconds, rel_tol=0, abs_tol=1e-12):
        raise ContractError("materialized traffic fixedStepSeconds does not match the execution plan")
    if not math.isclose(duration, duration_seconds, rel_tol=0, abs_tol=1e-9):
        raise ContractError("materialized traffic durationSeconds does not match the execution plan")
    grid = _grid_times(duration, step)

    actors: list[TrafficActor] = []
    for actor in _ordered_ids(root.get("actors"), "actors"):
        _object(actor, {"id", "kind", "states"}, "materialized traffic actor")
        actor_id = _string(actor, "id", "materialized traffic actor")
        kind = _string(actor, "kind", f"materialized traffic actor {actor_id}")
        if kind not in KINDS:
            raise ContractError(f"materialized traffic actor {actor_id} kind is unsupported")
        states: list[TrafficActorState] = []
        for raw in _require_complete_times(actor.get("states"), grid, f"materialized traffic actor {actor_id}"):
            _object(raw, ACTOR_STATE_FIELDS, f"materialized traffic actor {actor_id} state")
            bitmask = raw.get("signals")
            if not isinstance(bitmask, int) or isinstance(bitmask, bool) or not 0 <= bitmask <= 0xFFFFFFFF:
                raise ContractError(f"materialized traffic actor {actor_id} state signals must be uint32")
            present = raw.get("present")
            if not isinstance(present, bool):
                raise ContractError(f"materialized traffic actor {actor_id} state present must be boolean")
            numeric_payload = (raw["x"], raw["z"], raw["headingRad"], raw["speedMps"], raw["accelerationMps2"])
            if not present and (any(item != 0 for item in numeric_payload) or bitmask != 0):
                raise ContractError(f"materialized traffic actor {actor_id} absent state must use the canonical zero payload")
            states.append(TrafficActorState(
                _number(raw["t"], "actor state t", nonnegative=True),
                present,
                _number(raw["x"], "actor state x"),
                _number(raw["z"], "actor state z"),
                _number(raw["headingRad"], "actor state headingRad"),
                _number(raw["speedMps"], "actor state speedMps", nonnegative=True),
                _number(raw["accelerationMps2"], "actor state accelerationMps2"),
                bitmask,
            ))
        actors.append(TrafficActor(actor_id, kind, tuple(states)))

    signals: list[TrafficSignal] = []
    for signal in _ordered_ids(root.get("signals"), "signals"):
        _object(signal, {"id", "states"}, "materialized traffic signal")
        signal_id = _string(signal, "id", "materialized traffic signal")
        states: list[tuple[float, str]] = []
        for raw in _require_complete_times(signal.get("states"), grid, f"materialized traffic signal {signal_id}"):
            _object(raw, {"t", "state"}, f"materialized traffic signal {signal_id} state")
            state = _string(raw, "state", f"materialized traffic signal {signal_id} state")
            if state not in SIGNAL_STATES:
                raise ContractError(f"materialized traffic signal {signal_id} state is unsupported")
            states.append((_number(raw["t"], "signal state t", nonnegative=True), state))
        signals.append(TrafficSignal(signal_id, tuple(states)))

    if len(actors) > MAX_ACTOR_COUNT or len(actors) * len(grid) > MAX_ACTOR_FRAME_STATES:
        raise ContractError("materialized traffic exceeds actor execution limits")
    if artifact_provider == "disabled" and (actors or signals or provider_version != "none" or provider_seed != ""):
        raise ContractError("disabled materialized traffic must use the canonical empty contract")
    return MaterializedTraffic(
        artifact_source, map_asset_id, map_version_id, artifact_provider, provider_version, provider_seed,
        step, duration, tuple(actors), tuple(signals), actual_digest,
    )


_CATALOG_BY_KIND = {
    "vehicle": "vehicle.sedan",
    "pedestrian": "pedestrian.adult",
    "bicycle": "vehicle.bicycle",
    "obstacle": "vehicle.sedan",
}
_WORKER_KIND = {"obstacle": "static_object"}


def merge_materialized_traffic(
    plan: ExecutionPlan,
    traffic: MaterializedTraffic,
    allowed_overlap_actor_ids: frozenset[str] = frozenset(),
) -> ExecutionPlan:
    if not traffic.actors and not traffic.signals:
        return plan
    actors = dict(plan.actors)
    overlap = sorted(set(actors) & {actor.id for actor in traffic.actors})
    authored_overlap = [actor_id for actor_id in overlap if (
        not actors[actor_id].materialized_traffic_eligible or actor_id not in allowed_overlap_actor_ids
    )]
    if authored_overlap:
        raise ContractError(f"materialized traffic actors collide with authored actors: {', '.join(authored_overlap)}")
    if set(overlap) != set(allowed_overlap_actor_ids):
        raise ContractError("materialized traffic overlap membership does not match the signed execution manifest")
    for actor in traffic.actors:
        if actor.id not in actors:
            actors[actor.id] = ActorBinding(actor.id, f"materialized_{actor.id}", _WORKER_KIND.get(actor.kind, actor.kind), _CATALOG_BY_KIND[actor.kind])
    if len(actors) > MAX_ACTOR_COUNT or len(actors) * len(plan.frames) > MAX_ACTOR_FRAME_STATES:
        raise ContractError("merged execution plan exceeds actor execution limits")
    traffic_by_id = {actor.id: actor for actor in traffic.actors}
    signal_by_id = {signal.id: signal for signal in traffic.signals}
    frames: list[PlanFrame] = []
    for index, frame in enumerate(plan.frames):
        actor_states = dict(frame.actors)
        for actor_id, actor in traffic_by_id.items():
            state = actor.states[index]
            appearance = {
                "light.indicatorRight": "on" if state.signals & 0x1 else "off",
                "light.indicatorLeft": "on" if state.signals & 0x2 else "off",
                "light.warningLights": "on" if state.signals & 0x3 == 0x3 else "off",
            } if actor.kind in {"vehicle", "bicycle"} else {}
            actor_states[actor_id] = ActorFrame(
                (LIFECYCLE_ABSENT if not state.present else
                 LIFECYCLE_SPAWN if index == 0 or not actor.states[index - 1].present else LIFECYCLE_ACTIVE),
                state.x, state.z, 0.0, math.degrees(state.heading_rad), state.speed_mps, appearance,
            )
        signal_states = dict(frame.signals)
        for signal_id, signal in signal_by_id.items():
            signal_states[signal_id] = signal.states[index][1]
        frames.append(PlanFrame(frame.index, frame.t, actor_states, signal_states))
    immutable = tuple(frames)
    digest_value = {
        "schema": plan.schema,
        "fixedTimestepS": plan.fixed_timestep_s,
        "materializedTrafficSha256": traffic.sha256,
        "actors": [vars(actors[actor_id]) for actor_id in sorted(actors)],
        "frames": [
            {
                "index": frame.index,
                "t": frame.t,
                "actors": {actor_id: vars(state) for actor_id, state in sorted(frame.actors.items())},
                "signals": dict(sorted(frame.signals.items())),
            }
            for frame in immutable
        ],
    }
    sha256 = hashlib.sha256(canonical_json(digest_value).encode("utf-8")).hexdigest()
    return ExecutionPlan(
        plan.schema,
        plan.fixed_timestep_s,
        actors,
        immutable,
        sha256,
        plan.semantic_metadata,
    )
