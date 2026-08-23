#!/usr/bin/env python3
"""V1 TruthStream end-to-end proof runner.

Spawns the env-server on the yale-street signalized-junction episode,
subscribes from Python, steps the RL request/reply loop (unchanged semantics),
and logs 200 engine ticks of the live truth stream: per-actor acceleration,
populated signal snapshots, a 10 Hz client-side decimation demo, and a
byte-equality check across two identical runs.

Usage: python3 qualification/v2x-truth-stream/run-subscriber.py <run-tag>
"""

from __future__ import annotations

import hashlib
import importlib.util
import subprocess
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent

# Load the module directly so the runner does not require gymnasium (the
# package __init__ pulls the Gymnasium env; the truth-stream client needs only
# stdlib + msgpack).
_spec = importlib.util.spec_from_file_location(
    "truth_stream", HERE.parent.parent / "adapters" / "uniscenarios-gym" / "uniscenarios_gym" / "truth_stream.py"
)
_truth_stream = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_truth_stream)
TruthStreamClient = _truth_stream.TruthStreamClient

TICKS_TO_LOG = 200
DECIMATE_EVERY = 5  # 50 Hz engine -> 10 Hz consumer


def collect(run_tag: str) -> Path:
    log_path = HERE / f"truth-stream-{run_tag}.jsonl"
    summary = {
        "ticks": 0,
        "accel_nonzero": 0,
        "signal_records": 0,
        "signal_populated": 0,  # snapshots with phaseStartTick/phaseEndTick set
        "failure_states": {},
        "spawn_updates_despawns": [0, 0, 0],
        "decimated_10hz": 0,
        "dropped_total": None,
    }
    lines: list[str] = []
    with TruthStreamClient(str(HERE / "episodes.spec.json")) as client:
        print("hello:", json.dumps(client.hello, sort_keys=True))
        client.subscribe()
        reset = client.request({"op": "reset", "s": 0})
        print("reset t:", reset["t"])

        logged = 0
        stream = client.ticks()
        while logged < TICKS_TO_LOG:
            frame = next(stream, None)
            if frame is None:
                break
            # Advance the environment through its unchanged RL request/reply.
            # The donor choreography can legitimately terminate (collision/goal);
            # the subscription survives a re-reset, so collect continuously and
            # note how many episode lives the window spanned.
            try:
                step = client.request({"op": "step", "s": 0, "a": {}})
            except RuntimeError as error:
                print("episode refused step:", error)
                client.request({"op": "reset", "s": 0})
                summary["resets"] = summary.get("resets", 0) + 1
                continue
            if logged == 0:
                print("step reply keys:", sorted(step["info"].keys()) if "info" in step else sorted(step.keys()))
            if step["term"] or step["trunc"]:
                summary["episode_ends"] = summary.get("episode_ends", 0) + 1
            logged += 1

            summary["ticks"] += 1
            summary["dropped_total"] = frame["dropped"]
            for actor in frame["frame"]["actors"]:
                kind = actor["kind"]
                idx = {"spawn": 0, "update": 1, "despawn": 2}[kind]
                summary["spawn_updates_despawns"][idx] += 1
                accel = actor.get("acceleration")
                assert accel is not None, "acceleration missing from actor record"
                if any(abs(a) > 1e-9 for a in accel):
                    summary["accel_nonzero"] += 1
            for snap in frame["signals"]:
                summary["signal_records"] += 1
                if snap["phaseStartTick"] is not None and snap["phaseEndTick"] is not None:
                    summary["signal_populated"] += 1
                failure = snap.get("failureState")
                if failure:
                    summary["failure_states"][failure] = summary["failure_states"].get(failure, 0) + 1
            if frame["tick"] % DECIMATE_EVERY == 0:
                summary["decimated_10hz"] += 1
            # Canonical JSON of the raw wire document — byte-comparable across runs.
            lines.append(json.dumps(frame, sort_keys=True, separators=(",", ":")))
        client.unsubscribe()

    log_path.write_text("\n".join(lines) + "\n")
    digest = hashlib.sha256(log_path.read_bytes()).hexdigest()
    print(f"[{run_tag}] summary:", json.dumps(summary))
    print(f"[{run_tag}] sha256({log_path.name}) = {digest}")
    (HERE / f"truth-stream-{run_tag}-summary.json").write_text(
        json.dumps({"summary": summary, "sha256": digest}, indent=2) + "\n"
    )
    return log_path


def main() -> None:
    try:
        run_a = collect("run1")
        run_b = collect("run2")
    finally:
        subprocess.run(["pkill", "-f", "env-server.js --episodes"], check=False)
    equal = run_a.read_bytes() == run_b.read_bytes()
    print("BYTE-IDENTICAL ACROSS RUNS:", equal)
    if not equal:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
