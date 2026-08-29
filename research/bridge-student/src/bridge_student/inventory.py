"""Pair inventory + scale-out cost calculator for the WS3 bridge corpus.

Inventories aligned (render frame, conditioning, teacher frame) triplets
available on disk and computes the exact generation/training requirements to
reach a 100k-pair corpus, expressed in GPU-days on 4xA100-40GB.

  python -m bridge_student.inventory --clips-roots ~/w0-data/clips-pov \
      --teacher-roots ~/ws3-bridge/teacher-frames --out inventory.json \
      --teacher-s-per-frame <measured> [--target-pairs 100000]
"""

from __future__ import annotations

import argparse
import json
import os


def count_clips(root: str) -> dict:
    out = {}
    if not root or not os.path.isdir(root):
        return out
    for clip in sorted(os.listdir(root)):
        frames_dir = os.path.join(root, clip, "frames")
        gt_path = os.path.join(root, clip, "gt.jsonl")
        if os.path.isdir(frames_dir) and os.path.isfile(gt_path):
            n = len([f for f in os.listdir(frames_dir) if f.endswith(".png")])
            out[clip] = {"frames": n}
        elif clip.endswith(".mp4"):
            out[clip[:-4]] = {"frames": None, "video": True}
    return out


def count_teacher_frames(teacher_root: str) -> dict:
    out = {}
    if not teacher_root or not os.path.isdir(teacher_root):
        return out
    for clip in sorted(os.listdir(teacher_root)):
        d = os.path.join(teacher_root, clip)
        if os.path.isdir(d):
            out[clip] = len([f for f in os.listdir(d) if f.endswith(".png")])
    return out


def main(argv=None):
    p = argparse.ArgumentParser()
    p.add_argument("--clips-roots", nargs="*", default=[],
                   help="render clip roots (each containing <clip>/frames/*.png + gt.jsonl)")
    p.add_argument("--translated-videos", nargs="*", default=[],
                   help="dirs of translated <clip>.mp4 (teacher outputs not yet frame-extracted)")
    p.add_argument("--teacher-roots", nargs="*", default=[],
                   help="frame-extracted teacher dirs (<root>/<clip>/<NNNNN>.png)")
    p.add_argument("--out", required=True)
    p.add_argument("--target-pairs", type=int, default=100000)
    # measured constants (W0_REPORT.md / V2_RESULTS.md / render logs):
    p.add_argument("--h3-s-per-clip", type=float, default=895.0,
                   help="measured H3 Ref2VA warm latency per 60-frame clip on one A100")
    p.add_argument("--h3-gpu", type=int, default=1,
                   help="GPUs per H3 translation job")
    p.add_argument("--render-s-per-frame", type=float, default=2.0,
                   help="local RTX 5080 render+GT capture per frame (upper bound incl. browser overhead)")
    p.add_argument("--train-gpu-days-per-100k", type=float, default=None,
                   help="override training-cost model")
    args = p.parse_args(argv)

    inv = {"schema": "simforge-oss.bridge-pair-inventory.v1", "sources": {}}
    total_render_frames = 0
    for r in args.clips_roots:
        clips = count_clips(r)
        frames = sum(c["frames"] or 0 for c in clips.values())
        total_render_frames += frames
        inv["sources"][r] = {"kind": "render-clips", "clips": clips, "frames": frames}

    total_teacher_videos = 0
    for r in args.translated_videos:
        files = [f for f in os.listdir(r) if f.endswith(".mp4")] if os.path.isdir(r) else []
        total_teacher_videos += len(files)
        inv["sources"][r] = {"kind": "translated-video", "clips": sorted(f[:-4] for f in files)}

    total_teacher_frames = 0
    for r in args.teacher_roots:
        tf = count_teacher_frames(r)
        total_teacher_frames += sum(tf.values())
        inv["sources"][r] = {"kind": "teacher-frames", "clips": tf, "frames": sum(tf.values())}

    # Aligned pairs: render frame + GT + extracted teacher frame.
    aligned = 0
    tr_root = args.teacher_roots[0] if args.teacher_roots else None
    if tr_root:
        for r in args.clips_roots:
            for clip, meta in count_clips(r).items():
                n = meta.get("frames") or 0
                tdir = os.path.join(tr_root, clip)
                if os.path.isdir(tdir):
                    have = len([f for f in os.listdir(tdir) if f.endswith(".png")])
                    aligned += min(n, have)
    else:
        aligned = 0
    inv["totals"] = {
        "render_frames": total_render_frames,
        "teacher_videos": total_teacher_videos,
        "teacher_frames_extracted": total_teacher_frames,
        "aligned_pairs_now": aligned,
    }

    # Scale-out: pairs needed -> clips needed -> generation cost.
    target = args.target_pairs
    frames_per_clip = 60
    clips_needed = -(-target // frames_per_clip)  # ceil
    h3_clip_gpu_s = args.h3_s_per_clip * args.h3_gpu

    gen = {
        "target_pairs": target,
        "clips_needed_60f": clips_needed,
        "h3_seconds_per_clip_measured": args.h3_s_per_clip,
        "h3_clip_gpu_seconds": round(h3_clip_gpu_s, 1),
        "h3_generation_gpu_days_4xa100": round(
            clips_needed * h3_clip_gpu_s / (4 * 86400.0), 2),
        "render_wall_hours_local_gpu": round(
            clips_needed * frames_per_clip * args.render_s_per_frame / 3600.0, 1),
    }
    inv["scale_out"] = gen

    if args.train_gpu_days_per_100k is not None:
        inv["scale_out"]["training_gpu_days_4xa100"] = args.train_gpu_days_per_100k

    with open(args.out, "w") as f:
        json.dump(inv, f, indent=2)
    print(json.dumps(inv["totals"], indent=2))
    print("inventory written:", args.out)


if __name__ == "__main__":
    main()
