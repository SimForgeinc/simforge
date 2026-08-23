"""Frozen perception instrument: YOLO11s COCO-pretrained, versioned + hashed.

The instrument is never retrained and never fine-tuned on either domain; both
real corpus frames and translated engine frames are scored by the identical
weights so per-class deltas isolate distribution shift, not detector variance.
"""

from __future__ import annotations

import hashlib
import json
import os
from dataclasses import dataclass
from pathlib import Path

INSTRUMENT_NAME = "yolo11s"
INSTRUMENT_WEIGHTS_URL = (
    "https://github.com/ultralytics/assets/releases/download/v8.3.0/yolo11s.pt"
)

# COCO id -> our collapsed evaluation class.
COCO_TO_CLASS = {
    0: "pedestrian",   # person
    1: "bicycle",      # bicycle (riders counted separately below)
    2: "vehicle",      # car
    3: "motorcycle",
    5: "vehicle",      # bus
    6: "train",
    7: "vehicle",      # truck
}

EVAL_CLASSES = ["vehicle", "pedestrian", "bicycle", "motorcycle"]

# Confidence floor for all instrument reads. Pinned: changing it changes the
# gate and requires re-baselining the whole corpus.
CONF_THRESHOLD = 0.25
IOU_MATCH_THRESHOLD = 0.5


@dataclass(frozen=True)
class Instrument:
    name: str
    weights_path: str
    weights_sha256: str
    ultralytics_version: str
    torch_version: str
    device: str


def _sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def load_instrument(cache_dir: Path) -> tuple[Instrument, "object"]:
    """Load the frozen YOLO11s instrument, pinning provenance."""
    import torch
    import ultralytics
    from ultralytics import YOLO

    cache_dir.mkdir(parents=True, exist_ok=True)
    weights = cache_dir / "yolo11s.pt"
    if not weights.exists():
        # ultralytics downloads to cwd; fetch explicitly then move.
        tmp = YOLO(INSTRUMENT_NAME + ".pt")
        src = Path(str(tmp.ckpt_path)) if getattr(tmp, "ckpt_path", None) else None
        del tmp
        if src is None or not Path(src).exists():
            raise RuntimeError("could not locate downloaded yolo11s.pt")
        os.replace(src, weights)
    model = YOLO(str(weights))
    inst = Instrument(
        name=INSTRUMENT_NAME,
        weights_path=str(weights),
        weights_sha256=_sha256_file(weights),
        ultralytics_version=ultralytics.__version__,
        torch_version=torch.__version__,
        device="cpu",
    )
    return inst, model


def detect(model, image_paths: list[Path], conf: float = CONF_THRESHOLD) -> list[list[dict]]:
    """Run the instrument over images; returns per-image detection lists.

    Each detection: {class, conf, bbox:[x,y,w,h] in pixels}.
    """
    results = model.predict(
        [str(p) for p in image_paths],
        conf=conf,
        iou=0.45,
        imgsz=640,
        device="cpu",
        verbose=False,
    )
    out: list[list[dict]] = []
    for r in results:
        dets = []
        boxes = r.boxes
        if boxes is not None:
            for xyxy, cid, cf in zip(
                boxes.xyxy.tolist(), boxes.cls.tolist(), boxes.conf.tolist()
            ):
                cls = COCO_TO_CLASS.get(int(cid))
                if cls is None:
                    continue
                x1, y1, x2, y2 = xyxy
                dets.append(
                    {
                        "class": cls,
                        "conf": round(cf, 4),
                        "bbox": [
                            round(x1, 1), round(y1, 1),
                            round(x2 - x1, 1), round(y2 - y1, 1),
                        ],
                        "coco_cls": int(cid),
                    }
                )
        out.append(dets)
    return out


def provenance(inst: Instrument) -> dict:
    return {
        "name": inst.name,
        "version": f"ultralytics {inst.ultralytics_version} / torch {inst.torch_version}",
        "weightsSha256": inst.weights_sha256,
        "confThreshold": CONF_THRESHOLD,
        "iouMatch": IOU_MATCH_THRESHOLD,
        "device": inst.device,
    }


def save_detections(path: Path, records: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w") as f:
        for rec in records:
            f.write(json.dumps(rec) + "\n")


def load_detections(path: Path) -> list[dict]:
    with open(path) as f:
        return [json.loads(line) for line in f if line.strip()]
