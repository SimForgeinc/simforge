"""Quant-divergence comparison: run identical inputs through two quant modes.

Loads one engine at a time (both cannot fit in 16 GB), runs the same N
synthetic observations with identical seeds, saves trajectories, then reports
per-input ADE/FDE between the variants (average/final displacement in the
ego frame over the 64-waypoint, 6.4 s horizon).

Optionally (--clip) also runs the repo's golden-clip open-loop sanity check
(needs gated dataset access) and reports minADE vs ground truth per variant.

    python scripts/compare_quant.py --modes nf4 fp8 --n 10 --out out/divergence.json
    python scripts/compare_quant.py --modes nf4 --clip --out out/openloop_nf4.json
"""

from __future__ import annotations

import argparse
import gc
import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from simforge_alpamayo.obs import synthetic_observation  # noqa: E402

GOLDEN_CLIP = "030c760c-ae38-49aa-9ad8-f5650a545d26"  # upstream test_inference.py
GOLDEN_T0_US = 5_100_000


def run_variant(quant: str, n: int, cams: int, run_clip: bool) -> dict:
    import torch

    from simforge_alpamayo.engine import AlpamayoEngine

    engine = AlpamayoEngine(quant=quant)
    engine.load()
    print(f"[{quant}] loaded; vram={engine.vram()}", flush=True)

    out: dict = {"quant": quant, "trajs": [], "cot": [], "vram_after_load": engine.vram()}
    for i in range(n):
        obs = synthetic_observation(num_cameras=cams, seed=7000 + i)
        result = engine.act(obs, seed=7000 + i, num_traj_samples=1)
        out["trajs"].append(result["trajectories"][0])  # (64, 3)
        out["cot"].append(result["reasoning"][0])
        print(f"[{quant}] input {i}: total={result['timings']['total_ms']:.0f}ms", flush=True)
    out["vram_peak"] = engine.vram()

    if run_clip:
        out["open_loop"] = run_golden_clip(engine)

    del engine
    gc.collect()
    torch.cuda.empty_cache()
    return out


def run_golden_clip(engine) -> dict:
    """Upstream open-loop sanity: golden clip, minADE vs dataset ground truth."""
    from alpamayo1_5 import helper
    from alpamayo1_5.load_physical_aiavdataset import load_physical_aiavdataset

    data = load_physical_aiavdataset(GOLDEN_CLIP, t0_us=GOLDEN_T0_US)
    frames = data["image_frames"]  # (N_cams, 4, 3, H, W) uint8
    n_cams, n_frames, _, h, w = frames.shape
    obs = {
        "cameras": [
            {
                "camera_id": int(data["camera_indices"][c]),
                "frames": [
                    np.ascontiguousarray(
                        frames[c, f].numpy().transpose(1, 2, 0)
                    ).tobytes()
                    for f in range(n_frames)
                ],
                "encoding": "raw",
                "width": w,
                "height": h,
            }
            for c in range(n_cams)
        ],
        "ego_history_xyz": data["ego_history_xyz"][0, 0].numpy().tolist(),
        "ego_history_rot": data["ego_history_rot"][0, 0].numpy().tolist(),
    }
    result = engine.act(obs, seed=42, num_traj_samples=4)
    gt = data["ego_future_xyz"][0, 0, :, :2].numpy()  # (64, 2)
    trajs = np.asarray(result["trajectories"])[:, :, :2]  # (nj, 64, 2)
    ade = np.linalg.norm(trajs - gt[None], axis=-1).mean(-1)  # (nj,)
    fde = np.linalg.norm(trajs[:, -1] - gt[-1], axis=-1)
    return {
        "clip_id": GOLDEN_CLIP,
        "t0_us": GOLDEN_T0_US,
        "num_traj_samples": len(ade),
        "minADE_m": float(ade.min()),
        "ADE_per_sample_m": [float(a) for a in ade],
        "minFDE_m": float(fde.min()),
        "reasoning_sample": result["reasoning"][int(ade.argmin())],
        "gate": "upstream warns if minADE >= 1.0 m (sampling is stochastic)",
    }


def divergence(a: dict, b: dict) -> dict:
    rows = []
    for i, (ta, tb) in enumerate(zip(a["trajs"], b["trajs"])):
        ta = np.asarray(ta)[:, :2]
        tb = np.asarray(tb)[:, :2]
        ade = float(np.linalg.norm(ta - tb, axis=-1).mean())
        fde = float(np.linalg.norm(ta[-1] - tb[-1]))
        rows.append({"input": i, "ade_m": ade, "fde_m": fde,
                     "cot_identical": a["cot"][i] == b["cot"][i]})
    ades = [r["ade_m"] for r in rows]
    fdes = [r["fde_m"] for r in rows]
    return {
        "pair": f'{a["quant"]} vs {b["quant"]}',
        "inputs": rows,
        "ade_mean_m": float(np.mean(ades)),
        "ade_max_m": float(np.max(ades)),
        "fde_mean_m": float(np.mean(fdes)),
        "fde_max_m": float(np.max(fdes)),
        "cot_identical_count": sum(r["cot_identical"] for r in rows),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--modes", nargs="+", default=["nf4", "fp8"])
    parser.add_argument("--n", type=int, default=10)
    parser.add_argument("--cams", type=int, default=2)
    parser.add_argument("--clip", action="store_true",
                        help="also run the golden-clip open-loop check per variant")
    parser.add_argument("--out", default=None)
    args = parser.parse_args()

    variants = [run_variant(q, args.n, args.cams, args.clip) for q in args.modes]

    report: dict = {
        "n_inputs": args.n,
        "cams": args.cams,
        "variants": [
            {k: v for k, v in var.items() if k not in ("trajs",)} for var in variants
        ],
    }
    if len(variants) >= 2:
        report["divergence"] = divergence(variants[0], variants[1])

    print(json.dumps(report, indent=2, default=str))
    if args.out:
        Path(args.out).parent.mkdir(parents=True, exist_ok=True)
        Path(args.out).write_text(json.dumps(report, indent=2, default=str))
        print(f"wrote {args.out}")


if __name__ == "__main__":
    main()
