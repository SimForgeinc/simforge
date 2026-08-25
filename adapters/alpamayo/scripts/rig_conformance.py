"""Camera-rig conformance: authored Alpamayo rig -> Bevy render -> shm bundle
-> bridge shim -> REAL Alpamayo NF4 server -> trajectories.

Renders the `alpamayo-2cam` (or `alpamayo-4cam`) preset via the native render
service's `render_bundle` op on a real map tile, assembles the 4-frame
history window with `simforge_alpamayo.bridge`, and drives N `act` calls
through the model server, recording per-stage latency and VRAM.

Both servers must already be running, e.g.:
  native-render-service --socket /tmp/sf-camerarig-render.sock \
      --shm /dev/shm/sf-camerarig-ring --scene <yale scene.json>
  scripts/run_server.sh --quant nf4 --socket /tmp/simforge-alpamayo.sock

Usage:
  python scripts/rig_conformance.py --render-socket ... --shm ... \
      --model-socket ... [--profile alpamayo-2cam] [--acts 5] [--seed 42]
      [--out out/rig_conformance.json]

Camera geometry mirrors the authored presets in
packages/scenario/src/schema/v2/sensor-rigs.ts (ALPAMAYO_CAMERA_TEMPLATES):
actor frame +X forward / +Y up / +Z left, horizontal FoV preserved, frames
rendered at the model-native 512x384.
"""

from __future__ import annotations

import argparse
import json
import math
import pathlib
import subprocess
import sys
import time

REPO = pathlib.Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO / "adapters" / "alpamayo" / "src"))
sys.path.insert(0, str(REPO / "renderer" / "service" / "python"))

from simforge_alpamayo.bridge import (  # noqa: E402
    BundleObservationBridge,
    ego_history_from_positions,
    profile_camera_map,
)
from simforge_alpamayo.client import AlpamayoClient  # noqa: E402
from simforge_native import BundleRingReader, NativeRenderClient  # noqa: E402

WIDTH, HEIGHT = 512, 384  # model-native render size (== Qwen MAX_PIXELS)

# Mirror of the authored camera templates (mount in actor frame, metres;
# yaw degrees, +left; horizontal FoV degrees).
CAMERA_GEOMETRY = {
    "camera_cross_left_120fov": {"fwd": 1.9, "up": 1.46, "left": 0.42, "yaw": -55.0, "hfov": 120.0},
    "camera_front_wide_120fov": {"fwd": 2.05, "up": 1.5, "left": 0.0, "yaw": 0.0, "hfov": 120.0},
    "camera_cross_right_120fov": {"fwd": 1.9, "up": 1.46, "left": -0.42, "yaw": 55.0, "hfov": 120.0},
    "camera_front_tele_30fov": {"fwd": 2.08, "up": 1.52, "left": 0.0, "yaw": 0.0, "hfov": 30.0},
}

# Ego start pose on the yale fixture tile (same viewpoint as the F4 bench).
EGO_START = [580.45, 12.94, -1655.66]  # ground-ish: bench eye minus camera height
EGO_LOOK = [590.40, 12.85, -1648.96]


def vertical_fov(hfov_deg: float, aspect: float) -> float:
    return math.degrees(2 * math.atan(math.tan(math.radians(hfov_deg) / 2) / aspect))


def rig_cameras(profile: str, ego_xz: tuple[float, float], heading: float) -> list[dict]:
    """ServiceCamera list for the preset at one ego pose (y-up world)."""
    cams = []
    fwd = (math.cos(heading), math.sin(heading))  # world (x, z)
    left = (fwd[1], -fwd[0])  # 90deg left of forward in Bevy's y-up frame
    ground_y = EGO_START[1]
    for sensor_id in profile_camera_map(profile):
        g = CAMERA_GEOMETRY[sensor_id]
        eye_x = ego_xz[0] + fwd[0] * g["fwd"] + left[0] * g["left"]
        eye_z = ego_xz[1] + fwd[1] * g["fwd"] + left[1] * g["left"]
        eye_y = ground_y + g["up"]
        aim = heading - math.radians(g["yaw"])  # +yaw is left; world yaw runs x->z
        cams.append({
            "sensorId": sensor_id,
            "width": WIDTH,
            "height": HEIGHT,
            "fovDeg": vertical_fov(g["hfov"], WIDTH / HEIGHT),
            "eye": [eye_x, eye_y, eye_z],
            "target": [eye_x + 10 * math.cos(aim), eye_y, eye_z + 10 * math.sin(aim)],
        })
    return cams


def vram_mib() -> dict:
    try:
        query = subprocess.run(
            ["nvidia-smi", "--query-gpu=memory.used,memory.total", "--format=csv,noheader,nounits"],
            capture_output=True, text=True, check=True, timeout=10,
        ).stdout.strip().split(", ")
        return {"used_mib": int(query[0]), "total_mib": int(query[1])}
    except Exception as error:  # noqa: BLE001 - diagnostics only
        return {"error": str(error)}


def pct(sorted_values: list[float], q: float) -> float:
    return sorted_values[min(len(sorted_values) - 1, int(q * len(sorted_values)))]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--render-socket", required=True)
    parser.add_argument("--shm", required=True)
    parser.add_argument("--model-socket", required=True)
    parser.add_argument("--profile", default="alpamayo-2cam",
                        choices=["alpamayo-2cam", "alpamayo-4cam"])
    parser.add_argument("--acts", type=int, default=5)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--speed-mps", type=float, default=8.0)
    parser.add_argument("--hz", type=float, default=10.0)
    parser.add_argument("--out", default=None)
    args = parser.parse_args()

    heading = math.atan2(EGO_LOOK[2] - EGO_START[2], EGO_LOOK[0] - EGO_START[0])
    render = NativeRenderClient(args.render_socket)
    render.reset_cameras()
    reader = BundleRingReader(args.shm)
    bridge = BundleObservationBridge.for_profile(args.profile)
    model = AlpamayoClient(args.model_socket)
    hello = model.hello()
    print("model hello:", json.dumps({k: v for k, v in hello.items() if k != "pins"}))

    history_depth = bridge.num_frames
    total_ticks = history_depth - 1 + args.acts
    step = args.speed_mps / args.hz
    ego_world: list[list[float]] = []
    records: list[dict] = []
    vram_before = vram_mib()

    for tick in range(total_ticks):
        ego_xz = (EGO_START[0] + math.cos(heading) * step * tick,
                  EGO_START[2] + math.sin(heading) * step * tick)
        # FLU ego history (frozen with TrajExec: x forward, y LEFT, z up).
        # Bevy world is y-up with left = -z when facing +x, so map the ground
        # plane as (x, -z) to keep the helper's rotation frame right-handed.
        ego_world.append([ego_xz[0], -ego_xz[1], EGO_START[1]])
        cameras = rig_cameras(args.profile, ego_xz, heading)

        t0 = time.perf_counter()
        response = render.render_bundle(tick, cameras)  # upsert poses every tick
        assert response["ok"], response
        t1 = time.perf_counter()
        bundle = reader.bundle_at(response["bundle_offset"], response["bundle_len"],
                                  verify=True)
        assert bundle.sim_tick == tick
        convert_s = bridge.push_bundle(bundle)
        t2 = time.perf_counter()

        record = {
            "tick": tick,
            "render_ms": (t1 - t0) * 1e3,
            "consume_convert_ms": (t2 - t1) * 1e3,
            "bridge_convert_ms": convert_s * 1e3,
            "digests": {e.camera_id: e.digest_hex for e in bundle.entries},
        }

        if tick >= history_depth - 1:
            obs = bridge.observation(ego_history_from_positions(
                ego_world,
                heading_rad=math.atan2(-math.sin(heading), math.cos(heading)),
            ))
            t3 = time.perf_counter()
            resp = model.act(obs, seed=args.seed, num_traj_samples=1)
            t4 = time.perf_counter()
            if not resp.get("ok"):
                raise SystemExit(f"act failed at tick {tick}: {resp.get('error')}")
            result = resp["result"]
            trajectories = result["trajectories"]
            assert len(trajectories) == 1 and len(trajectories[0]) == 64, (
                len(trajectories), len(trajectories[0]))
            assert all(len(wp) == 3 for wp in trajectories[0])
            record.update({
                "act_wall_ms": (t4 - t3) * 1e3,
                "server_timings": result.get("timings"),
                "server_vram": result.get("vram"),
                "traj_first_wp": trajectories[0][0],
                "traj_last_wp": trajectories[0][-1],
                "reasoning_head": (result["reasoning"][0] or "")[:160],
            })
            print(f"tick {tick}: act wall={record['act_wall_ms']:.0f} ms "
                  f"last_wp={[round(v, 2) for v in trajectories[0][-1]]}")
        records.append(record)

    vram_after = vram_mib()
    model.close()
    render.close()
    del bundle
    reader.close()

    acts = [r for r in records if "act_wall_ms" in r]
    act_ms = sorted(r["act_wall_ms"] for r in acts)
    render_ms = sorted(r["render_ms"] for r in records)
    convert_ms = sorted(r["bridge_convert_ms"] for r in records)
    summary = {
        "profile": args.profile,
        "acts": len(acts),
        "act_wall_ms": {"p50": pct(act_ms, 0.5), "max": act_ms[-1], "all": act_ms},
        "render_ms": {"p50": pct(render_ms, 0.5), "max": render_ms[-1]},
        "bridge_convert_ms": {"p50": pct(convert_ms, 0.5), "max": convert_ms[-1]},
        "vram": {"before": vram_before, "after": vram_after},
        "records": records,
    }
    print(f"\nprofile={args.profile} acts={len(acts)} "
          f"act p50={pct(act_ms, 0.5):.0f} ms max={act_ms[-1]:.0f} ms | "
          f"render p50={pct(render_ms, 0.5):.2f} ms | "
          f"bridge convert p50={pct(convert_ms, 0.5):.2f} ms")
    print(f"vram before={vram_before} after={vram_after}")
    if args.out:
        out = pathlib.Path(args.out)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(summary, indent=2))
        print("wrote", out)


if __name__ == "__main__":
    main()
