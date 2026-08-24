#!/usr/bin/env python3
"""Compile and sample a pre-sanitized Scenic program for research evaluation.

Input and output are JSON on stdin/stdout. This process never receives provider
credentials. The TypeScript adapter constructs the Scenic source from trusted
map slots; raw model output is deliberately not executed.
"""

from __future__ import annotations

import json
import os
import resource
import sys
import tempfile
import time
from pathlib import Path


def _limit_resources() -> None:
    # The map parser can briefly use substantial address space. Keep a hard CPU
    # ceiling while leaving enough memory for Richmond's OpenDRIVE geometry.
    resource.setrlimit(resource.RLIMIT_CPU, (40, 40))
    if hasattr(resource, "RLIMIT_FSIZE"):
        resource.setrlimit(resource.RLIMIT_FSIZE, (16 * 1024 * 1024, 16 * 1024 * 1024))


def main() -> int:
    _limit_resources()
    request = json.load(sys.stdin)
    source = request.get("source")
    if not isinstance(source, str) or not source or len(source) > 64_000:
        raise ValueError("source must be a non-empty Scenic program under 64 KiB")
    if any(token in source for token in ("import ", "from ", "exec(", "eval(", "open(", "__", "subprocess", "socket")):
        raise ValueError("Scenic source crossed the research adapter allowlist")
    seed = int(request.get("seed", 1))
    if seed < 0 or seed > 2_147_483_647:
        raise ValueError("seed is outside the supported range")

    # Import only after resource limits are active.
    import scenic  # type: ignore
    from scenic import scenarioFromFile  # type: ignore

    started = time.perf_counter()
    with tempfile.TemporaryDirectory(prefix="simforge-scenic-") as directory:
        path = Path(directory) / "candidate.scenic"
        path.write_text(source, encoding="utf-8")
        compile_started = time.perf_counter()
        scenario = scenarioFromFile(str(path), mode2D=True)
        compile_ms = round((time.perf_counter() - compile_started) * 1000)
        sample_started = time.perf_counter()
        scene, iterations = scenario.generate(maxIterations=200)
        sample_ms = round((time.perf_counter() - sample_started) * 1000)
    objects = []
    for index, obj in enumerate(scene.objects):
        position = obj.position
        objects.append({
            "index": index,
            "x": float(position.x),
            "y": float(position.y),
            "headingRad": float(obj.heading),
            "type": type(obj).__name__,
        })
    json.dump({
        "scenicVersion": getattr(scenic, "__version__", "3.1.0"),
        "compiled": True,
        "sampled": True,
        "iterations": int(iterations),
        "compileMs": compile_ms,
        "sampleMs": sample_ms,
        "objects": objects,
        "durationMs": round((time.perf_counter() - started) * 1000),
    }, sys.stdout, separators=(",", ":"))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        json.dump({"compiled": False, "sampled": False, "error": str(error)[:500]}, sys.stdout, separators=(",", ":"))
        raise SystemExit(2)
