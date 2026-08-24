"""F4 bench: sustained 10 Hz render_bundle bundles, render+publish+consume latency.

Expects native-render-service already running. For each tick:
  t0 -> render_bundle RPC (render + shm publish) -> t1
     -> BundleRingReader.latest(verify=True): seqlock pointer, table CRC,
        per-frame CRC32 digest verify, zero-copy numpy views -> t2
Reports p50/p95/p99/max of (t1-t0), (t2-t1), (t2-t0), the 10 Hz deadline
miss count, and VRAM via nvidia-smi.

Usage: python3 bench_bundles.py <socket> <shm_path> <n_cams> <ticks> [--hz 10]
       [--width 1280] [--height 720] [--record-fixture <out_path> --small]
"""
from __future__ import annotations

import argparse
import subprocess
import time

import numpy as np

from simforge_native import BundleRingReader, NativeRenderClient

# Poses on the yale fixture tile (demo_step_latency.py viewpoint), fanned out
# like a roof rig: 7 headings around the ego point.
EGO_EYE = [580.45, 14.44, -1655.66]
EGO_TARGET = [590.40, 14.35, -1648.96]


def rig(n_cams: int, width: int, height: int) -> list[dict]:
    import math
    dx, dz = EGO_TARGET[0] - EGO_EYE[0], EGO_TARGET[2] - EGO_EYE[2]
    base = math.atan2(dz, dx)
    dist = math.hypot(dx, dz)
    cams = []
    for k in range(n_cams):
        yaw = base + (k - (n_cams - 1) / 2) * (2 * math.pi / max(n_cams, 6))
        cams.append({
            "sensorId": f"cam{k}",
            "width": width,
            "height": height,
            "fovDeg": 70.0,
            "eye": EGO_EYE,
            "target": [EGO_EYE[0] + dist * math.cos(yaw), EGO_TARGET[1],
                       EGO_EYE[2] + dist * math.sin(yaw)],
        })
    return cams


def vram_mib() -> str:
    try:
        out = subprocess.run(
            ["nvidia-smi", "--query-gpu=memory.used,memory.total", "--format=csv,noheader"],
            capture_output=True, text=True, timeout=5,
        ).stdout.strip()
        return out
    except Exception as error:  # noqa: BLE001 - bench diagnostics only
        return f"unavailable ({error})"


def pct(sorted_ms: list[float], q: float) -> float:
    return sorted_ms[min(len(sorted_ms) - 1, int(q * len(sorted_ms)))]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("socket")
    parser.add_argument("shm_path")
    parser.add_argument("n_cams", type=int)
    parser.add_argument("ticks", type=int)
    parser.add_argument("--hz", type=float, default=10.0)
    parser.add_argument("--width", type=int, default=1280)
    parser.add_argument("--height", type=int, default=720)
    args = parser.parse_args()

    client = NativeRenderClient(args.socket)
    client.reset_cameras()  # drop any rig left by earlier sessions
    reader = BundleRingReader(args.shm_path)
    cameras = rig(args.n_cams, args.width, args.height)

    # Warmup: registers cameras (GPU target allocation) outside the timed run.
    for tick in range(3):
        response = client.render_bundle(tick, cameras if tick == 0 else None)
        assert response["ok"], response
    bundle = reader.latest(verify=True)
    views = bundle.views()
    sample = views[cameras[0]["sensorId"]]["rgb"]
    print(f"warmup ok: tick={bundle.sim_tick} cams={len(bundle.entries)} "
          f"view={sample.shape} {sample.dtype} zero-copy={np.shares_memory(sample, reader.shm)} "
          f"non-uniform={float(sample.std()) > 1.0}")
    vram_start = vram_mib()

    period = 1.0 / args.hz
    render_ms: list[float] = []
    consume_ms: list[float] = []
    total_ms: list[float] = []
    misses = 0
    t_next = time.perf_counter()
    t_wall0 = time.perf_counter()
    for tick in range(10, 10 + args.ticks):
        t_next += period
        t0 = time.perf_counter()
        response = client.render_bundle(tick)
        assert response["ok"], response
        t1 = time.perf_counter()
        bundle = reader.latest(verify=True)
        assert bundle.sim_tick == tick, (bundle.sim_tick, tick)
        views = bundle.views()
        assert len(views) == args.n_cams
        t2 = time.perf_counter()
        render_ms.append((t1 - t0) * 1000)
        consume_ms.append((t2 - t1) * 1000)
        total_ms.append((t2 - t0) * 1000)
        now = time.perf_counter()
        if now > t_next:
            misses += 1
            t_next = now  # resync rather than cascade
        else:
            time.sleep(t_next - now)
    wall = time.perf_counter() - t_wall0
    vram_end = vram_mib()

    for name, xs in [("render+publish", render_ms), ("consume(verify)", consume_ms),
                     ("total", total_ms)]:
        xs = sorted(xs)
        print(f"{name:>16}: p50={pct(xs, 0.5):7.2f} p95={pct(xs, 0.95):7.2f} "
              f"p99={pct(xs, 0.99):7.2f} max={xs[-1]:7.2f} ms")
    print(f"ticks={args.ticks} wall={wall:.1f}s eff_hz={args.ticks / wall:.2f} "
          f"deadline_misses={misses} ({args.hz} Hz budget {period * 1000:.0f} ms)")
    print(f"vram start: {vram_start}")
    print(f"vram end:   {vram_end}")
    client.close()
    del views, sample, bundle  # zero-copy views pin the ring mapping
    reader.close()


if __name__ == "__main__":
    main()
