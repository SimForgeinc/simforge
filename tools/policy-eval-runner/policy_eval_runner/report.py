"""Report assembly and the regression gate.

A report is versioned and keyed by the suite hash; the gate compares a new
report's arms against a pinned baseline JSON and exits nonzero on regression.
Deterministic simulation means a healthy rerun reproduces the baseline
numbers bit-for-bit on the same machine, so the default tolerances only
absorb cross-host floating-point drift, not real regressions.
"""

from __future__ import annotations

import json
import pathlib
from typing import Any

REPORT_VERSION = 1

# Exit codes (documented contract of the runner CLI).
EXIT_OK = 0
EXIT_USAGE = 2
EXIT_REGRESSION = 3
EXIT_GATE_ERROR = 4


def build_report(
    suite: dict[str, Any],
    arms: dict[str, dict[str, Any]],
    checkpoint: str | None,
    perturbations: dict[str, Any],
    entries_run: int,
) -> dict[str, Any]:
    return {
        "reportVersion": REPORT_VERSION,
        "suiteHash": suite["suiteHash"],
        "suiteName": suite["name"],
        "entriesRun": entries_run,
        "checkpoint": checkpoint,
        "perturbations": perturbations,
        "arms": arms,
    }


def _regressions(
    arm_new: dict[str, Any],
    arm_base: dict[str, Any],
    tol_success: float,
    tol_collision: float,
) -> list[str]:
    problems: list[str] = []
    new_c = arm_new["composite"]
    base_c = arm_base["composite"]
    if new_c["successRate"] < base_c["successRate"] - tol_success:
        problems.append(
            f"composite successRate {new_c['successRate']} < baseline {base_c['successRate']} (tol {tol_success})"
        )
    if new_c["microCollisionRate"] > base_c["microCollisionRate"] + tol_collision:
        problems.append(
            f"collision rate {new_c['microCollisionRate']} > baseline {base_c['microCollisionRate']} (tol {tol_collision})"
        )
    for ability, base_stats in arm_base["perAbility"].items():
        new_stats = arm_new["perAbility"].get(ability)
        if new_stats is None:
            problems.append(f"ability {ability} missing from new report")
            continue
        if new_stats["successRate"] < base_stats["successRate"] - tol_success:
            problems.append(
                f"{ability} successRate {new_stats['successRate']} < baseline {base_stats['successRate']}"
            )
        if new_stats["collisionRate"] > base_stats["collisionRate"] + tol_collision:
            problems.append(
                f"{ability} collisionRate {new_stats['collisionRate']} > baseline {base_stats['collisionRate']}"
            )
    return problems


def check_regression(
    new_report: dict[str, Any],
    baseline_path: str | pathlib.Path,
    tol_success: float = 0.02,
    tol_collision: float = 0.02,
) -> tuple[bool, list[str]]:
    """Compare against a pinned baseline; returns (passed, problems)."""
    baseline = json.loads(pathlib.Path(baseline_path).read_text())
    if baseline.get("suiteHash") != new_report["suiteHash"]:
        return False, [
            f"baseline suiteHash {baseline.get('suiteHash')} != report suiteHash {new_report['suiteHash']}"
        ]
    problems: list[str] = []
    for arm, arm_new in new_report["arms"].items():
        arm_base = baseline.get("arms", {}).get(arm)
        if arm_base is None:
            continue  # arms added after the baseline pin are not gated
        problems.extend(_regressions(arm_new, arm_base, tol_success, tol_collision))
    return (len(problems) == 0, problems)
