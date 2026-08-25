#!/usr/bin/env python
"""E3 gate: verify restyled keyframes keep object layout (frozen instrument).

yolo11s COCO conf 0.25, match IoU 0.5 — same as the binding scorer, applied
to single frames: source frame (resized to the restyle resolution) vs each
restyled candidate, in resolution-normalized coords.
Usage:
  bridge-student/.venv/bin/python e3_kf_check.py --src src_frame0.png \
      --dir restyled --tag first --out kf_check_first.json
"""
from __future__ import annotations

import argparse
import glob
import json
import os

W, H = 736, 416
CLASSES = {0: "pedestrian", 1: "bicycle", 2: "vehicle", 3: "motorcycle",
           5: "vehicle", 6: "train", 7: "vehicle"}
EVAL = ["vehicle", "pedestrian", "bicycle", "motorcycle"]


def iou(a, b):
    ax, ay, aw, ah = a
    bx, by, bw, bh = b
    x1, y1 = max(ax, bx), max(ay, by)
    x2, y2 = min(ax + aw, bx + bw), min(ay + ah, by + bh)
    inter = max(0, x2 - x1) * max(0, y2 - y1)
    union = aw * ah + bw * bh - inter
    return inter / union if union > 0 else 0.0


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", required=True)
    ap.add_argument("--dir", required=True)
    ap.add_argument("--tag", required=True, help="first|last variant prefix")
    ap.add_argument("--weights", default=os.path.expanduser("~/models/yolo11s.pt"))
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    from ultralytics import YOLO
    model = YOLO(args.weights)

    def det(path):
        from PIL import Image
        im = Image.open(path).convert("RGB").resize((W, H), Image.LANCZOS)
        tmp = path + f".{args.tag}_resize_tmp.png"
        im.save(tmp)
        r = model.predict(tmp, conf=0.25, imgsz=640, device="cpu", verbose=False)[0]
        os.remove(tmp)
        out = []
        for b in r.boxes:
            c = CLASSES.get(int(b.cls))
            if c in EVAL:
                x1, y1, x2, y2 = b.xyxyn[0].tolist()
                out.append({"class": c, "box": [x1, y1, x2 - x1, y2 - y1],
                            "conf": float(b.conf)})
        return out

    src = det(args.src)
    result = {"source": {"path": args.src, "dets": len(src),
                         "by_class": {c: sum(1 for d in src if d["class"] == c)
                                      for c in EVAL}},
              "candidates": {}}
    for path in sorted(glob.glob(os.path.join(args.dir, f"{args.tag}_*.png"))):
        name = os.path.splitext(os.path.basename(path))[0]
        cand = det(path)
        matched, iou_sum = 0, 0.0
        used = set()
        for d in src:
            best, bj = 0.0, None
            for j, e in enumerate(cand):
                v = iou(d["box"], e["box"])
                if v > best:
                    best, bj = v, j
            if best >= 0.5 and bj not in used:
                used.add(bj)
                matched += 1
                iou_sum += best
        rec = matched / len(src) if src else None
        bind = iou_sum / matched if matched else None
        hal = ((len(cand) - matched) / len(cand)) if cand else None
        result["candidates"][name] = {
            "file": os.path.basename(path), "dets": len(cand),
            "matched": matched,
            "recall": round(rec, 4) if rec is not None else None,
            "binding_iou": round(bind, 4) if bind is not None else None,
            "hallucination": round(hal, 4) if hal is not None else None}
        print(name, result["candidates"][name], flush=True)

    with open(args.out, "w") as f:
        json.dump(result, f, indent=2)


if __name__ == "__main__":
    main()
