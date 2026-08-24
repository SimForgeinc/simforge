"""Build the GRPO prompt set from real SimForge W0 dashcam-POV clips.

Input : <w0-root>/clips-pov/<clip>/{manifest.json, gt.jsonl, frames/*.png}
Output: prompts.jsonl — one decision point per row:
  {id, clip, frame, image, intent, speed_mps, ref_traj: [[x,y] x T]}

Reference trajectories come from the engine trace ground truth (ego pose per
frame), expressed in the ego frame at the decision point:
  forward = component of displacement along ego heading
  left    = component 90 deg counter-clockwise (left) of heading
Waypoint 0 is (0, 0) at t0; remaining T-1 points every `dt` seconds.
"""
from __future__ import annotations

import argparse
import json
import math
import os
from pathlib import Path

FPS = 12.0


def load_gt(path: Path) -> list[dict]:
    with open(path) as f:
        return [json.loads(line) for line in f if line.strip()]


def find_frame(gt_rows: list[dict], frame: int) -> dict | None:
    return next((r for r in gt_rows if r["frame"] == frame), None)


def ego_pose(row: dict) -> tuple[float, float, float, float]:
    ego = next(a for a in row["actors"] if a["id"] == "ego")
    return ego["x"], ego["yScene"], ego["headingRad"], ego["speedMps"]


def ref_trajectory(rows: list[dict], start_frame: int, horizon_s: float, dt: float) -> list[list[float]] | None:
    """Ego-frame waypoints; index 0 is the origin at start_frame."""
    step = max(1, round(dt * FPS))
    n = int(round(horizon_s / dt)) + 1
    base = find_frame(rows, start_frame)
    if base is None:
        return None
    bx, by, bh, _ = ego_pose(base)
    cos_h, sin_h = math.cos(bh), math.sin(bh)
    pts = [[0.0, 0.0]]
    for i in range(1, n):
        row = find_frame(rows, start_frame + i * step)
        if row is None:
            return None
        x, y, _, _ = ego_pose(row)
        dx, dy = x - bx, y - by
        fwd = cos_h * dx + sin_h * dy          # along heading
        left = sin_h * dx - cos_h * dy         # +90deg (left-hand normal)
        pts.append([round(fwd, 2), round(left, 2)])
    return pts


def classify_intent(ref: list[list[float]], speed0: float) -> str:
    end_fwd, end_left = ref[-1]
    if abs(end_left) < 1.0:
        return "go-straight"
    return "turn-left" if end_left > 0 else "turn-right"


def user_text(intent: str, speed_mps: float, dt: float, n_points: int) -> str:
    return (
        f"You are planning for an autonomous vehicle. The image is the front dashcam view.\n"
        f"Current ego speed: {speed_mps:.1f} m/s. Navigation command: {intent}.\n"
        f"Predict the ego trajectory for the next {(n_points - 1) * dt:.1f} seconds as "
        f"{n_points} waypoints sampled every {dt:g} s, in the ego frame "
        f"(x = meters forward, y = meters to the left), starting from the current position.\n"
        f"Answer ONLY with the waypoints in this exact format:\n"
        f"<0.00,0.00> <x.xx,y.yy> ... ({n_points} waypoints total)"
    )


def build_row(clip: str, rows: list[dict], frame: int, dt: float, horizon_s: float,
              w0_root: Path, split: str) -> dict | None:
    ref = ref_trajectory(rows, frame, horizon_s, dt)
    base = find_frame(rows, frame)
    if ref is None or base is None:
        return None
    _, _, _, speed = ego_pose(base)
    intent = classify_intent(ref, speed)
    n = len(ref)
    return {
        "id": f"{clip}-f{frame:05d}",
        "clip": clip,
        "frame": frame,
        "split": split,
        "intent": intent,
        "speed_mps": round(speed, 2),
        "ref_traj": ref,
        "prompt": [
            {"role": "user", "content": [
                {"type": "image"},
                {"type": "text", "text": user_text(intent, speed, dt, n)},
            ]},
        ],
        # resolved by the trainer relative to --w0-root
        "_image_rel": f"clips-pov/{clip}/frames/frame-{frame:05d}.png",
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--w0-root", type=Path, default=Path(os.environ.get("W0_ROOT", "/home/path/w0-data")))
    ap.add_argument("--out", type=Path, default=Path(__file__).parent / "data" / "prompts.jsonl")
    ap.add_argument("--dt", type=float, default=0.5, help="waypoint spacing in seconds")
    ap.add_argument("--horizon", type=float, default=3.0, help="planning horizon in seconds")
    ap.add_argument("--stride", type=int, default=6, help="frames between decision points (12 fps)")
    ap.add_argument("--eval-clips", nargs="*", default=["fog-midblock", "night-rain-merge"],
                    help="clips held out from training")
    args = ap.parse_args()

    root = args.w0_root / "clips-pov"
    args.out.parent.mkdir(parents=True, exist_ok=True)
    n_train = n_eval = 0
    with open(args.out, "w") as out:
        for clip_dir in sorted(root.iterdir()):
            gt_path = clip_dir / "gt.jsonl"
            if not gt_path.is_file():
                continue
            rows = load_gt(gt_path)
            max_frame = max(r["frame"] for r in rows)
            split = "eval" if clip_dir.name in set(args.eval_clips) else "train"
            for frame in range(0, max_frame + 1, args.stride):
                row = build_row(clip_dir.name, rows, frame, args.dt, args.horizon, args.w0_root, split)
                if row is None:
                    continue
                out.write(json.dumps(row) + "\n")
                if split == "train":
                    n_train += 1
                else:
                    n_eval += 1
    print(json.dumps({"out": str(args.out), "train": n_train, "eval": n_eval}))


if __name__ == "__main__":
    main()
