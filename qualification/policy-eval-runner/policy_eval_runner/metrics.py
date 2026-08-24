"""Episode metrics and Bench2Drive-style ability decomposition.

Per episode the runner records the reward return, collision/goal flags and
the engine-grade pair minima (min distance, min TTC, min path-TTC, min PET)
streamed by the policy-eval server. Aggregation mirrors Bench2Drive's
(2406.03877) multi-ability decomposition adapted to our scenario classes:

- success rate per ability  — reached route end without a collision;
- collision rate per ability;
- driving-score proxy per ability — success rate (documented adaptation:
  we have no route-completion percentage, so completion is binary);
- composite score — macro mean over abilities.
"""

from __future__ import annotations

import hashlib
import struct
from typing import Any

EPS_TTC = 1e-6


def digest_frame(digest: "hashlib._Hash", frame: dict[str, Any]) -> None:
    if frame["state_vector"] is not None:
        digest.update(frame["state_vector"].astype("<f8").tobytes())
    if frame["bev"] is not None:
        digest.update(frame["bev"].astype("<f4").tobytes())
    digest.update(struct.pack("<d", float(frame["reward"])))
    digest.update(struct.pack("<d", float(frame["t"])))


def ego_minima(frame: dict[str, Any], ego: str) -> tuple[float, float, float, float]:
    """(minDistanceM, minTtcS, minPathTtcS, minPetS) over ego pairs."""
    min_d = min_ttc = min_path = min_pet = float("inf")
    for row in frame["minima"]:
        a, b = row[0], row[1]
        if a != ego and b != ego:
            continue
        min_d = min(min_d, float(row[2]))
        min_ttc = min(min_ttc, float(row[3]))
        min_path = min(min_path, float(row[4]))
        min_pet = min(min_pet, float(row[5]))
    return min_d, min_ttc, min_path, min_pet


def episode_record(entry: dict[str, Any], frames_meta: dict[str, Any]) -> dict[str, Any]:
    record = {
        "entryId": entry["entryId"],
        "ability": entry["ability"],
        "shift": entry["shift"],
        "mapId": entry["mapId"],
        "seed": entry["seed"],
        **frames_meta,
        "success": bool(frames_meta["goal"]) and not bool(frames_meta["collision"]),
    }
    return record


def aggregate(records: list[dict[str, Any]]) -> dict[str, Any]:
    def group_stats(rows: list[dict[str, Any]]) -> dict[str, Any] | None:
        if not rows:
            return None
        n = len(rows)
        collisions = sum(1 for r in rows if r["collision"])
        goals = sum(1 for r in rows if r["goal"])
        successes = sum(1 for r in rows if r["success"])
        ttcs = [r["minTtcS"] for r in rows if r["minTtcS"] is not None]
        pets = [r["minPetS"] for r in rows if r["minPetS"] is not None]
        return {
            "n": n,
            "successRate": round(successes / n, 4),
            "collisionRate": round(collisions / n, 4),
            "goalRate": round(goals / n, 4),
            "meanReturn": round(sum(r["return"] for r in rows) / n, 3),
            "meanLength": round(sum(r["length"] for r in rows) / n, 1),
            "meanMinTtcS": round(sum(ttcs) / len(ttcs), 3) if ttcs else None,
            "meanMinPetS": round(sum(pets) / len(pets), 3) if pets else None,
        }

    by_ability: dict[str, dict[str, Any]] = {}
    for ability in sorted({r["ability"] for r in records}):
        stats = group_stats([r for r in records if r["ability"] == ability])
        assert stats is not None
        by_ability[ability] = stats

    overall = group_stats(records)
    assert overall is not None
    # Composite: macro mean of per-ability success rate (Bench2Drive-style),
    # so an ability with many easy cells cannot drown a hard one.
    composite_success = sum(a["successRate"] for a in by_ability.values()) / len(by_ability)
    micro_collision = overall["collisionRate"]
    return {
        "perAbility": by_ability,
        "composite": {
            "successRate": round(composite_success, 4),
            "microCollisionRate": micro_collision,
            "meanReturn": overall["meanReturn"],
            "episodes": overall["n"],
        },
    }
