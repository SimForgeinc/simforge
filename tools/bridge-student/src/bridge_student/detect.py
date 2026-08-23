"""Frozen-detector frame dumps for the bridge auditor.

Runs the WS1 RealityAnchor frozen perception stack (yolo11s, ultralytics,
pinned conf/IoU) over a directory tree of frames and writes detection dumps in
the same schema as the W0 audit dumps, so auditor rejection rates are directly
comparable to the WS1 bridge-fidelity scorecard gates.

Pinned parameters (must match WS1 scorecard):
  detector yolo11s, ultralytics 8.4.126, conf 0.25, match IoU 0.5,
  classes [car, truck, bus, person, bicycle, motorcycle],
  weightsSha256 85a76fe86dd8afe384648546b56a7a78580c7cb7b404fc595f97969322d502d5

  python -m bridge_student.detect --frames-root ~/ws3-bridge/teacher-frames \
      --weights ~/models/yolo11s.pt --out ~/ws3-bridge/det/yolo11s-teacher.json
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os

CLASSES = ["car", "truck", "bus", "person", "bicycle", "motorcycle"]
# yolo11 COCO ids for the frozen class set
COCO_IDS = {"car": 2, "truck": 7, "bus": 5, "person": 0, "bicycle": 1, "motorcycle": 3}
ID_TO_CLS = {v: k for k, v in COCO_IDS.items()}


def sha256_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def main(argv=None):
    p = argparse.ArgumentParser()
    p.add_argument("--frames-root", required=True,
                   help="dir of <clip>/<NNNNN>.png frame trees")
    p.add_argument("--weights", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--conf", type=float, default=0.25)
    p.add_argument("--iou", type=float, default=0.5)
    p.add_argument("--device", default="cpu")
    p.add_argument("--clips", nargs="*", default=None)
    args = p.parse_args(argv)

    from ultralytics import YOLO

    model = YOLO(args.weights)
    out = {
        "source_tag": os.path.basename(args.frames_root.rstrip("/")),
        "detector": "yolo11s",
        "weights_sha256": sha256_file(args.weights),
        "classes": CLASSES,
        "conf": args.conf,
        "iou": args.iou,
        "detections": [],
    }
    clips = args.clips or sorted(os.listdir(args.frames_root))
    for clip in clips:
        cdir = os.path.join(args.frames_root, clip)
        if not os.path.isdir(cdir):
            continue
        frames = sorted(f for f in os.listdir(cdir) if f.endswith(".png"))
        results = model.predict(
            [os.path.join(cdir, f) for f in frames],
            conf=args.conf, iou=args.iou, device=args.device, verbose=False,
            classes=[COCO_IDS[c] for c in CLASSES],
        )
        for fname, r in zip(frames, results):
            boxes = r.boxes
            dets = []
            for xyxy, cls_id, conf in zip(
                boxes.xyxy.tolist(), boxes.cls.tolist(), boxes.conf.tolist()
            ):
                cname = ID_TO_CLS.get(int(cls_id))
                if cname is None:
                    continue
                dets.append({"cls": cname, "conf": round(float(conf), 3),
                             "xyxy": [round(v, 1) for v in xyxy]})
            out["detections"].append({"clip": clip, "file": fname, "dets": dets})
        print(f"{clip}: {len(frames)} frames, "
              f"{sum(len(d['dets']) for d in out['detections'][-len(frames):])} dets", flush=True)

    with open(args.out, "w") as f:
        json.dump(out, f)
    print("wrote", args.out)


if __name__ == "__main__":
    main()
