#!/usr/bin/env python3
"""V4 SensorRig proof run: 4 Richmond twin cameras + ego RGB/semantic/depth
over 100 ticks of a richmond scene-state stream, through the WSB5 native
render service (protocol v2), with timings and JPEG streaming measurement.

Outputs (default run/evidence/v4-rig-proof/):
  timings.json        per-tick render ms, jpeg ms, fps summary
  frames/tick-XXXXXX.<sensor>.<pass>.png|.bin  (first tick, via export_dir)
  ch1-vs-real.png     side-by-side of rendered ch1 vs the real Richmond feed
                      (when a reference frame exists in the V2X repo)

Usage:
  native-render-service --socket ... --scene <scene.json> &   # separate
  python3 scripts/v2x/run_rig_proof.py --socket /tmp/v4.sock \
      --rig native/sensors/rigs/richmond-twin-rig.v1.json \
      --scene-state /tmp/richmond-scene-state.json \
      --ticks 100 --out run/evidence/v4-rig-proof
"""
from __future__ import annotations

import argparse
import json
import math
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "native/service/python"))
from uniscenarios_native.client import NativeRenderClient  # noqa: E402

TICK_S = 0.05  # product cadence: 20 Hz (CARLA sensor_tick 0.05 analogue)


def load_rig(path: Path) -> dict:
    return json.loads(path.read_text())


def twin_cameras(rig: dict, width=1280, height=960) -> list[dict]:
    """Service camera requests for the 4 calibrated site cameras.

    Placement: shared-tmerc grid (exact planar), y resolved by the service's
    ground height field + pole height. Yaw/pitch come straight from the rig
    JSON (legacy-CARLA anchored — see frameProvenance; renders against the
    Uni bundle are expected to misalign where geometry moved, by verdict).
    """
    cams = []
    for c in rig["cameras"]:
        x, z = c["sceneEyeXz"]
        eye_y = c["heightM"]  # ground offset resolved server-side only for attach;
        # fixed cams sit on the pole: use ground field via a tiny trick — the
        # service resolves attach actors, so for fixed cams we send explicit
        # eye/target with y = height above the sampled ground is not known
        # client-side; use 0 ground + heightM (richmond road grid is near-flat).
        yaw = math.radians(c["carlaYawDeg"])
        pitch = math.radians(c["pitchDeg"])
        # Uni frame: yaw about +Y, forward = (cos yaw, 0, -sin yaw); CARLA
        # yaw is left-handed so negate.
        fwd = (math.cos(-yaw), 0.0, -math.sin(-yaw))
        eye = [x, eye_y, z]
        target = [
            eye[0] + 50.0 * fwd[0] * math.cos(pitch),
            eye[1] + 50.0 * math.sin(pitch),
            eye[2] + 50.0 * fwd[2] * math.cos(pitch),
        ]
        cams.append({
            "sensorId": c["id"],
            "width": width,
            "height": height,
            # vertical FOV for the service; aspect matches 4:3 intrinsics
            "fovDeg": c["fovDeg"]["trueVertical"],
            "eye": eye,
            "target": target,
            "semantic": False,
            "depthEncoding": None,
        })
    return cams


def ego_camera() -> dict:
    """Product ego RGB: 736x416, CARLA fov 90 horizontal -> vertical 59.4,
    rigidly attached to actor 'ego' (hood view analogue: +x 1.5 m, z 1.3 m),
    semantic + CARLA depth at the perception cadence."""
    return {
        "sensorId": "ego",
        "width": 736,
        "height": 416,
        "fovDeg": 2.0 * math.degrees(math.atan(math.tan(math.radians(90.0 / 2)) * 416 / 736)),
        "eye": [0, 0, 0],
        "target": [1, 0, 0],
        "semantic": True,
        "depthEncoding": "carla",
        "attach": {"actorId": "ego", "offsetM": [1.5, 0.0, 1.3], "yawDeg": 0.0, "pitchDeg": 0.0},
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--socket", default="/tmp/v4-proof.sock")
    ap.add_argument("--rig", default="native/sensors/rigs/richmond-twin-rig.v1.json")
    ap.add_argument("--scene-state", required=True, help="scene-state.v1 stream JSON (list of tick docs)")
    ap.add_argument("--ticks", type=int, default=100)
    ap.add_argument("--out", default="run/evidence/v4-rig-proof")
    ap.add_argument("--jpeg-quality", type=int, default=70)
    args = ap.parse_args()

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    (out / "frames").mkdir(exist_ok=True)

    rig = load_rig(Path(args.rig))
    stream = json.loads(Path(args.scene_state).read_text())
    if isinstance(stream, dict):
        stream = [stream]
    ticks = min(args.ticks, len(stream))

    client = NativeRenderClient(args.socket)
    assert client.hello["protocol"] == 2, client.hello
    resp = client.load_scene_state(stream)
    assert resp["ok"], resp
    print(f"scene stream loaded: {resp['ticks']} ticks, map {resp['map_id']}")

    cams = twin_cameras(rig) + [ego_camera()]
    render_ms, jpeg_ms = [], []
    t_wall0 = time.perf_counter()

    for t in range(ticks):
        obs, server_ms = client.step(tick_id=t, cameras=cams, tick_index=t)
        render_ms.append(server_ms)
        # JPEG stream: encode the ego RGB from the last tick's cache, every
        # tick (20 fps product cadence alongside renders).
        jresp = client.encode_jpeg([{"sensorId": "ego", "pass": "rgb", "quality": args.jpeg_quality}])
        assert jresp["ok"], jresp
        jpeg_ms.append(jresp["server_ms"])
        if t == 0:
            # persist evidence frames of tick 0
            for sensor, passes in obs.items():
                for name, view in passes.items():
                    if name == "depth":
                        p = out / "frames" / f"tick-{t:06d}.{sensor}.depth.f32.bin"
                        p.write_bytes(view.tobytes())
                        continue
                    if name == "jpeg":
                        p = out / "frames" / f"tick-{t:06d}.{sensor}.jpeg.jpg"
                        p.write_bytes(view.tobytes())
                        continue
                    p = out / "frames" / f"tick-{t:06d}.{sensor}.{name}.png"
                    try:
                        import numpy as np
                        from PIL import Image
                        Image.fromarray(np.ascontiguousarray(view)).save(p)
                    except ImportError:
                        p.with_suffix(".raw").write_bytes(view.tobytes())
            # keep the raw jpeg of the last tick too
            ego_jpeg = obs.get("ego", {}).get("jpeg")
            if ego_jpeg is not None:
                (out / "frames" / f"tick-{ticks - 1:06d}.ego.jpeg.jpg").write_bytes(
                    ego_jpeg.tobytes())

    wall = time.perf_counter() - t_wall0

    import numpy as np
    r = np.array(render_ms)
    j = np.array(jpeg_ms)
    summary = {
        "ticks": ticks,
        "cameras": [c["sensorId"] for c in cams],
        "renderMs": {"mean": float(r.mean()), "p50": float(np.percentile(r, 50)),
                      "p95": float(np.percentile(r, 95)), "max": float(r.max())},
        "jpegMs": {"mean": float(j.mean()), "p95": float(np.percentile(j, 95))},
        "sustainedFpsWallClock": ticks / wall,
        "renderOnlyFpsAtMean": 1000.0 / float(r.mean()),
        "jpegOnlyFpsAtMean": 1000.0 / float(j.mean()) if j.mean() > 0 else None,
        "jpegThroughputPxS": float(736 * 416 / j.mean() * 1000) if j.mean() > 0 else None,
        "targetFps": 20.0,
        "meetsTarget": bool(1000.0 / (r.mean() + j.mean()) >= 20.0),
        "wallSeconds": wall,
        "protocol": 2,
    }
    (out / "timings.json").write_text(json.dumps(summary, indent=2))
    print(json.dumps(summary, indent=2))
    client.close()

    # Side-by-side vs the real feed, if a reference exists in the V2X repo.
    real = Path(
        "/home/path/V2XCarla/v2x-backend-threejs/docs/evidence/"
        "view-align-20260815/ch1-chamfer-after.jpg"
    )
    rendered = out / "frames" / "tick-000000.ch1.rgb.png"
    if real.exists() and rendered.exists():
        try:
            from PIL import Image, ImageDraw
            import numpy as np
            a = Image.open(real).convert("RGB")
            b = Image.open(rendered).convert("RGB")
            h = 480
            a = a.resize((int(a.width * h / a.height), h))
            b = b.resize((int(b.width * h / b.height), h))
            canvas = Image.new("RGB", (a.width + b.width + 20, h + 40), (24, 24, 24))
            canvas.paste(a, (0, 40))
            canvas.paste(b, (a.width + 20, 40))
            d = ImageDraw.Draw(canvas)
            d.text((8, 8), f"REAL ch1 (legacy lineage feed) — {real.name}", fill=(255, 220, 120))
            d.text((a.width + 28, 8), "RENDERED ch1 (Uni assets, 0737f3d9-anchored pose — expect misalignment)", fill=(140, 220, 255))
            canvas.save(out / "ch1-vs-real.png")
            print(f"wrote {out/'ch1-vs-real.png'}")
        except Exception as e:  # noqa: BLE001
            print(f"side-by-side skipped: {e}")


if __name__ == "__main__":
    main()
