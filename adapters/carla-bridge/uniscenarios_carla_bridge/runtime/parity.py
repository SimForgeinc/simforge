from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any, Iterable, Mapping

from .compiler import LIFECYCLE_ABSENT, PlanFrame


@dataclass(frozen=True)
class ParityReport:
    accepted: bool
    samples: int
    max_error: Mapping[str, float]
    violation_counts: Mapping[str, int]
    failed_actor_ids: tuple[str, ...] = ()
    lifecycle_mismatches: int = 0
    signal_mismatches: int = 0
    discrete_mismatches: int = 0
    first_contact: Mapping[str, Any] | None = None
    collision_events: tuple[Mapping[str, Any], ...] = ()
    segments: Mapping[str, Mapping[str, Any]] = field(default_factory=dict)
    segment_failed_actor_ids: Mapping[str, tuple[str, ...]] = field(default_factory=dict)
    reference_accepted: bool = False
    reference_thresholds: Mapping[str, float] = field(default_factory=dict)
    acceptance_thresholds: Mapping[str, float] = field(default_factory=dict)
    reference_violation_counts: Mapping[str, int] = field(default_factory=dict)


class ParityAccumulator:
    def __init__(self, thresholds: Mapping[str, float]):
        reference_defaults = {
            "positionM": 0.25,
            "headingDeg": 2.0,
            "speedMps": 0.25,
        }
        self.thresholds = {
            "positionM": 2.0,
            "headingDeg": 5.0,
            "speedMps": 1.0,
            **thresholds,
        }
        self.reference_thresholds = {
            **reference_defaults,
            **{key: value for key, value in thresholds.items() if key not in reference_defaults},
        }
        self.max_error = {key: 0.0 for key in self.thresholds}
        self.violations = {key: 0 for key in self.thresholds}
        self.reference_violations = {key: 0 for key in self.thresholds}
        self.samples = 0
        self.lifecycle_mismatches = 0
        self.signal_mismatches = 0
        self.discrete_mismatches = 0
        self.first_contact: dict[str, Any] | None = None
        self.collisions: list[dict[str, Any]] = []
        self.segment_samples = {"throughFirstContact": 0, "postContact": 0}
        self.segment_max_error = {
            segment: {key: 0.0 for key in self.thresholds}
            for segment in self.segment_samples
        }
        self.segment_violations = {
            segment: {key: 0 for key in self.thresholds}
            for segment in self.segment_samples
        }
        self.segment_failed_actor_ids: dict[str, set[str]] = {
            segment: set() for segment in self.segment_samples
        }
        self.previous_expected_speed: dict[str, float] = {}
        self.failed_actor_ids: set[str] = set()
        self.dropped_actor_ids: set[str] = set()
        self.static_planar_offsets: dict[str, tuple[float, float]] = {}

    def configure_spawn_placement(
        self,
        dropped_actor_ids: Iterable[str] = (),
        static_planar_offsets: Mapping[str, tuple[float, float]] | None = None,
    ) -> None:
        """Register spawn-placement decisions made before frame zero.

        A dropped actor has no CARLA body: it is excluded from the readback
        closure and never evaluated. A nudged STATIC actor is measured against
        its recorded collision-free placement; the nudge itself is reported
        separately as a spawn-placement divergence, not hidden.
        """
        self.dropped_actor_ids = set(dropped_actor_ids)
        self.static_planar_offsets = {
            actor_id: (float(offset[0]), float(offset[1]))
            for actor_id, offset in (static_planar_offsets or {}).items()
        }

    def observe(
        self,
        expected: PlanFrame,
        actual: Mapping[str, Mapping[str, Any]],
        *,
        actual_signals: Mapping[str, str] | None = None,
        collision_events: Iterable[Mapping[str, Any]] = (),
    ) -> None:
        events = [dict(item) for item in collision_events]
        if events and self.first_contact is None:
            first = min(events, key=lambda item: (int(item.get("frame", expected.index)), str(item.get("pair", ""))))
            self.first_contact = {
                "frame": int(first.get("frame", expected.index)),
                "t": float(first.get("t", expected.t)),
                "pair": list(first.get("pair", ())),
            }
        self.collisions.extend(events)
        segment = "postContact" if self.first_contact and expected.index > int(self.first_contact["frame"]) else "throughFirstContact"

        expected_present = {
            actor_id for actor_id, target in expected.actors.items()
            if target.lifecycle != LIFECYCLE_ABSENT and actor_id not in self.dropped_actor_ids
        }
        actual_present = {
            actor_id for actor_id, value in actual.items()
            if bool(value.get("present", actor_id in expected_present))
        }
        unknown_actual = set(actual) - set(expected.actors)
        if unknown_actual or actual_present != expected_present:
            raise RuntimeError("CARLA readback active actor closure differs from the execution plan")

        if actual_signals is not None and dict(actual_signals) != dict(expected.signals):
            self.signal_mismatches += 1
        for actor_id, target in expected.actors.items():
            if actor_id in self.dropped_actor_ids:
                continue
            if target.lifecycle == LIFECYCLE_ABSENT:
                value = actual.get(actor_id)
                if value is not None and bool(value.get("present", False)):
                    self.lifecycle_mismatches += 1
                continue
            value = actual[actor_id]
            actual_lifecycle = value.get("lifecycle")
            if actual_lifecycle is not None and actual_lifecycle != target.lifecycle:
                self.lifecycle_mismatches += 1
                self.failed_actor_ids.add(actor_id)
            actual_appearance = value.get("appearance")
            if actual_appearance is not None and dict(actual_appearance) != dict(target.appearance):
                self.discrete_mismatches += 1
                self.failed_actor_ids.add(actor_id)
            offset = self.static_planar_offsets.get(actor_id, (0.0, 0.0))
            errors = {
                "positionM": math.sqrt(
                    (target.x + offset[0] - value["x"]) ** 2
                    + (target.y + offset[1] - value["y"]) ** 2
                    + (target.z - value["z"]) ** 2
                ),
                "headingDeg": abs((target.heading_deg - value["headingDeg"] + 180) % 360 - 180),
                "speedMps": abs(target.speed_mps - value["speedMps"]),
            }
            prior_speed = self.previous_expected_speed.get(actor_id)
            actual_acceleration = value.get("accelerationMps2")
            if "accelerationMps2" in self.thresholds and prior_speed is not None and actual_acceleration is not None:
                expected_acceleration = (target.speed_mps - prior_speed) / 0.02
                errors["accelerationMps2"] = abs(expected_acceleration - float(actual_acceleration))
            self.previous_expected_speed[actor_id] = target.speed_mps
            for key, error in errors.items():
                self.max_error[key] = max(self.max_error[key], error)
                self.violations[key] += int(error > self.thresholds[key])
                self.reference_violations[key] += int(error > self.reference_thresholds[key])
                if error > self.thresholds[key]:
                    self.failed_actor_ids.add(actor_id)
                    self.segment_failed_actor_ids[segment].add(actor_id)
                self.segment_max_error[segment][key] = max(self.segment_max_error[segment][key], error)
                self.segment_violations[segment][key] += int(error > self.thresholds[key])
            self.samples += 1
            self.segment_samples[segment] += 1

    def report(self) -> ParityReport:
        exact_mismatches = self.lifecycle_mismatches + self.signal_mismatches + self.discrete_mismatches
        segments = {
            segment: {
                "samples": self.segment_samples[segment],
                "maxError": dict(self.segment_max_error[segment]),
                "violationCounts": dict(self.segment_violations[segment]),
            }
            for segment in self.segment_samples
        }
        return ParityReport(
            not any(self.violations.values()) and exact_mismatches == 0,
            self.samples,
            self.max_error,
            self.violations,
            tuple(sorted(self.failed_actor_ids)),
            self.lifecycle_mismatches,
            self.signal_mismatches,
            self.discrete_mismatches,
            self.first_contact,
            tuple(self.collisions),
            segments,
            {
                segment: tuple(sorted(actor_ids))
                for segment, actor_ids in self.segment_failed_actor_ids.items()
            },
            not any(self.reference_violations.values()) and exact_mismatches == 0,
            dict(self.reference_thresholds),
            dict(self.thresholds),
            dict(self.reference_violations),
        )
