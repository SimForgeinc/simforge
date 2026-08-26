"""Environment-name compatibility for the SimForge CARLA executor process."""

from __future__ import annotations

import os
import warnings

_warned_legacy_names: set[str] = set()


def simforge_env(name: str, default: str | None = None) -> str | None:
    """Read SIMFORGE_<name>, falling back once-warned to UNISCENARIO_<name>."""
    canonical_name = f"SIMFORGE_{name}"
    if canonical_name in os.environ:
        return os.environ[canonical_name]

    legacy_name = f"UNISCENARIO_{name}"
    value = os.environ.get(legacy_name)
    if value is not None and legacy_name not in _warned_legacy_names:
        _warned_legacy_names.add(legacy_name)
        warnings.warn(
            f"{legacy_name} is deprecated; set {canonical_name} instead.",
            RuntimeWarning,
            stacklevel=2,
        )
    return default if value is None else value
