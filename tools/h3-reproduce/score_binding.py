#!/usr/bin/env python3
"""Per-clip source<->output spatial-binding scorer (WS1 frozen instrument).

Uses the exact frozen instrument from tools/bridge-fidelity: yolo11s COCO
(weights sha256 85a76fe8...), conf floor 0.25, match IoU 0.5, device cpu,
imgsz 640, collapsed classes vehicle/pedestrian/bicycle/motorcycle.

Frames are aligned by index from t=0; boxes are compared in
resolution-normalized coordinates so clips of different sizes are comparable.

Metrics per class, aggregated over aligned frames:
  src_det        detections in the source clip
  out_det        detections in the output clip
  recall         fraction of source dets matched by an output det (IoU>=0.5)
  binding_iou    mean IoU over matched pairs (spatial binding tightness)
  hallucination  fraction of output dets with no source counterpart
  deletion       1 - recall

Usage:
  score_binding.py --source SRC.mp4 --output OUT.mp4 [--max-frames N]
                   [--stride S] [--label NAME] [--work DIR] --out result.json
"""
from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import tempfile
from pathlib import Path

CONF_THRESHOLD = 0.25
IOU_MATCH_THRESHOLD = 0.5
FROZEN_WEIGHTS_SHA256 = (
    "85a76fe86dd8afe384648546b56a7a78580c7cb7b404fc595f97969322d502d5"
)
COCO_TO_CLASS = {0: "pedestrian", 1: "bicycle", 2: "vehicle", 3: "motorcycle",
                 5: "vehicle", 6: "train", 7: "vehicle"}
EVAL_CLASSES = ["vehicle", "pedestrian", "bicycle", "motorcycle"]
FROZEN_WEIGHTS = Path(
    "/home/path/UniScenarios-ws/ws1-reality-anchor/tools/bridge-fidelity"
    "/.corpus/weights/yolo11s.pt")


def probe(path: Path) -> dict:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
         "stream=width,height,nb_frames,avg_frame_rate,duration", "-of", "json",
         str(path)],
        capture_output=True, text=True, check=True)
    return json.loads(out.stdout)["streams"][0]


def extract_frames(video: Path, dst: Path, max_frames: int, stride: int) -> list[Path]:
    dst.mkdir(parents=True, exist_ok=True)
    existing = sorted(dst.glob("f*.jpg"))
    if existing:
        return existing
    subprocess.run(
        ["ffmpeg", "-v", "error", "-i", str(video), "-vf",
         f"select='not(mod(n,{stride}))'", "-vsync", "vfr", "-frames:v",
         str(max_frames), "-q:v", "3", str(dst / "f%05d.jpg")],
        check=True)
    return sorted(dst.glob("f*.jpg"))


def load_model():
    from ultralytics import YOLO
    w = FROZEN_WEIGHTS
    if not w.exists():
        tmp = YOLO("yolo11s.pt")
        w = Path(str(tmp.ckpt_path))
    sha = hashlib.sha256(w.read_bytes()).hexdigest()
    if sha != FROZEN_WEIGHTS_SHA256:
        raise SystemExit(f"weights sha mismatch: {sha}")
    return YOLO(str(w))


def detect(model, frames: list[Path]) -> list[list[dict]]:
    results = model.predict([str(p) for p in frames], conf=CONF_THRESHOLD,
                            iou=0.45, imgsz=640, device="cpu", verbose=False)
    out = []
    for r in results:
        dets = []
        W, H = r.orig_shape[1], r.orig_shape[0]
        boxes = r.boxes
        if boxes is not None:
            for xyxy, cid, cf in zip(boxes.xyxy.tolist(), boxes.cls.tolist(),
                                     boxes.conf.tolist()):
                cls = COCO_TO_CLASS.get(int(cid))
                if cls is None:
                    continue
                x1, y1, x2, y2 = xyxy
                dets.append({"class": cls, "conf": float(cf),
                             "nbox": [x1 / W, y1 / H, (x2 - x1) / W,
                                      (y2 - y1) / H]})
        out.append(dets)
    return out


def iou(a, b):
    ax, ay, aw, ah = a
    bx, by, bw, bh = b
    x1, y1 = max(ax, bx), max(ay, by)
    x2, y2 = min(ax + aw, bx + bw), min(ay + ah, by + bh)
    inter = max(0.0, x2 - x1) * max(0.0, y2 - y1)
    union = aw * ah + bw * bh - inter
    return inter / union if union > 0 else 0.0


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", required=True)
    ap.add_argument("--output", required=True)
    ap.add_argument("--max-frames", type=int, default=192)
    ap.add_argument("--stride", type=int, default=2)
    ap.add_argument("--label", default=None)
    ap.add_argument("--work", default=None)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    src, outp = Path(args.source), Path(args.output)
    work = Path(args.work or tempfile.mkdtemp(prefix="bind_"))
    sinfo, oinfo = probe(src), probe(outp)
    sframes = extract_frames(src, work / "src", args.max_frames, args.stride)
    oframes = extract_frames(outp, work / "out", args.max_frames, args.stride)
    n = min(len(sframes), len(oframes))
    sframes, oframes = sframes[:n], oframes[:n]

    model = load_model()
    sdets, odets = detect(model, sframes), detect(model, oframes)

    per_class = {c: {"src_det": 0, "out_det": 0, "matched": 0,
                     "iou_sum": 0.0} for c in EVAL_CLASSES}
    for i in range(n):
        for c in EVAL_CLASSES:
            s = [d for d in sdets[i] if d["class"] == c]
            o = [d for d in odets[i] if d["class"] == c]
            per_class[c]["src_det"] += len(s)
            per_class[c]["out_det"] += len(o)
            matched_o = set()
            for d in s:
                best, bj = 0.0, None
                for j, e in enumerate(o):
                    v = iou(d["nbox"], e["nbox"])
                    if v > best:
                        best, bj = v, j
                if best >= IOU_MATCH_THRESHOLD and bj not in matched_o:
                    matched_o.add(bj)
                    per_class[c]["matched"] += 1
                    per_class[c]["iou_sum"] += best

    classes = {}
    tot = {"src_det": 0, "out_det": 0, "matched": 0}
    for c in EVAL_CLASSES:
        pc = per_class[c]
        rec = pc["matched"] / pc["src_det"] if pc["src_det"] else None
        bind = pc["iou_sum"] / pc["matched"] if pc["matched"] else None
        hal = ((pc["out_det"] - pc["matched"]) / pc["out_det"]
               if pc["out_det"] else None)
        classes[c] = {
            "src_det": pc["src_det"], "out_det": pc["out_det"],
            "recall": round(rec, 4) if rec is not None else None,
            "binding_iou": round(bind, 4) if bind is not None else None,
            "hallucination": round(hal, 4) if hal is not None else None,
            "deletion": round(1 - rec, 4) if rec is not None else None,
        }
        for k in tot:
            tot[k] += pc[k]

    overall_rec = tot["matched"] / tot["src_det"] if tot["src_det"] else None
    result = {
        "label": args.label or f"{src.name} -> {outp.name}",
        "instrument": {"name": "yolo11s",
                       "weightsSha256": FROZEN_WEIGHTS_SHA256,
                       "confThreshold": CONF_THRESHOLD,
                       "iouMatch": IOU_MATCH_THRESHOLD, "device": "cpu"},
        "source": {"path": str(src), **{k: sinfo.get(k) for k in
                                        ("width", "height", "nb_frames",
                                         "avg_frame_rate")}},
        "output": {"path": str(outp), **{k: oinfo.get(k) for k in
                                        ("width", "height", "nb_frames",
                                         "avg_frame_rate")}},
        "frames_compared": n,
        "per_class": classes,
        "overall": {
            "recall": round(overall_rec, 4) if overall_rec is not None else None,
            "hallucination": round(
                (tot["out_det"] - tot["matched"]) / tot["out_det"], 4)
            if tot["out_det"] else None,
        },
    }
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    with open(args.out, "w") as f:
        json.dump(result, f, indent=2)
    print(json.dumps({"label": result["label"], "frames": n,
                      "per_class": classes, "overall": result["overall"]},
                     indent=2))


if __name__ == "__main__":
    main()
