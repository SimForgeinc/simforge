"""Aligned (conditioning, target) pair dataset for the bridge student.

Pairs are (engine render frame + trace-derived G-buffer conditioning) ->
(RGB style target). Targets come from a teacher translation directory when
available (frame-aligned PNGs named ``<clip>/<NNNNN>.png``), otherwise the
render frame itself is used as the target so the recipe is trainable on
render-only corpora (license-safe; see docs/teacher-license-decision.md).
"""

from __future__ import annotations

import os
from dataclasses import dataclass

import numpy as np
import torch
from PIL import Image

from .gbuffer import GBufferRenderer, condition_stack, frame_size, load_gt


@dataclass
class PairIndex:
    """Flat index of (clip, frame_idx) pairs with target availability."""

    items: list  # list of (clip, frame_idx, has_teacher)
    clips_root: str
    teacher_root: str | None


def build_pair_index(clips_root: str, teacher_root: str | None = None) -> PairIndex:
    items = []
    for clip in sorted(os.listdir(clips_root)):
        clip_dir = os.path.join(clips_root, clip)
        frames_dir = os.path.join(clip_dir, "frames")
        gt_path = os.path.join(clip_dir, "gt.jsonl")
        if not (os.path.isdir(frames_dir) and os.path.isfile(gt_path)):
            continue
        n_frames = len([f for f in os.listdir(frames_dir) if f.endswith(".png")])
        tdir = None
        if teacher_root:
            cand = os.path.join(teacher_root, clip)
            if os.path.isdir(cand):
                tdir = cand
        for i in range(n_frames):
            has_teacher = False
            if tdir is not None:
                has_teacher = os.path.isfile(os.path.join(tdir, f"{i:05d}.png"))
            items.append((clip, i, has_teacher))
    return PairIndex(items=items, clips_root=clips_root, teacher_root=teacher_root)


class BridgePairDataset(torch.utils.data.Dataset):
    def __init__(
        self,
        clips_root: str,
        teacher_root: str | None = None,
        resolution: int | tuple[int, int] = 384,
        cache_dir: str | None = None,
        require_teacher: bool = False,
        max_depth_m: float = 80.0,
    ):
        self.index = build_pair_index(clips_root, teacher_root)
        if require_teacher:
            self.index.items = [it for it in self.index.items if it[2]]
        if isinstance(resolution, int):
            resolution = (resolution, resolution)
        self.resolution = resolution  # (h, w)
        self.cache_dir = cache_dir
        if cache_dir:
            os.makedirs(cache_dir, exist_ok=True)
        self.max_depth_m = max_depth_m
        self._renderer_cache = {}
        self._gt_cache = {}

    def __len__(self):
        return len(self.index.items)

    def _renderer(self, clip):
        if clip not in self._renderer_cache:
            w, h = frame_size(self.index.clips_root, clip)
            self._renderer_cache[clip] = GBufferRenderer(w, h)
        return self._renderer_cache[clip]

    def _gt(self, clip):
        if clip not in self._gt_cache:
            path = os.path.join(self.index.clips_root, clip, "gt.jsonl")
            self._gt_cache[clip] = load_gt(path)
        return self._gt_cache[clip]

    def _conditions(self, clip: str, idx: int) -> np.ndarray:
        cache_key = f"{clip}_{idx:05d}.npz"
        if self.cache_dir:
            p = os.path.join(self.cache_dir, cache_key)
            if os.path.isfile(p):
                with np.load(p) as z:
                    return z["cond"]
        buf = self._renderer(clip).render_frame(self._gt(clip)[idx])
        cond = condition_stack(buf, max_depth_m=self.max_depth_m)
        if self.cache_dir:
            np.savez_compressed(p, cond=cond)
        return cond

    @staticmethod
    def _resize(arr: np.ndarray, hw: tuple[int, int], is_mask: bool) -> np.ndarray:
        im = Image.fromarray(arr)
        resample = Image.NEAREST if is_mask else Image.BILINEAR
        return np.asarray(im.resize((hw[1], hw[0]), resample))

    def __getitem__(self, i: int):
        clip, idx, has_teacher = self.index.items[i]
        hw = self.resolution
        cond = self._conditions(clip, idx)
        # channel-last -> torch layout; nearest/bilinear resize per channel type
        depth = self._resize(cond[..., 0], hw, False)
        sem_rgb = (
            self._resize(cond[..., 1:4].astype(np.uint8), hw, True).astype(np.float32) / 255.0
        )
        inst = self._resize(cond[..., 4], hw, True)
        valid = self._resize((cond[..., 5] * 255).astype(np.uint8), hw, True)
        cond_t = np.concatenate(
            [depth[..., None], sem_rgb, inst[..., None], (valid / 255.0)[..., None]],
            axis=2,
        )

        tgt_path = None
        if has_teacher and self.index.teacher_root:
            tgt_path = os.path.join(self.index.teacher_root, clip, f"{idx:05d}.png")
        if tgt_path is None or not os.path.isfile(tgt_path):
            tgt_path = os.path.join(
                self.index.clips_root, clip, "frames", f"frame-{idx:05d}.png"
            )
        target = np.asarray(Image.open(tgt_path).convert("RGB").resize((hw[1], hw[0]), Image.LANCZOS))

        cond_t = torch.from_numpy(cond_t.astype(np.float32)).permute(2, 0, 1)
        target_t = torch.from_numpy(target.astype(np.float32)).permute(2, 0, 1) / 127.5 - 1.0
        return {"cond": cond_t, "target": target_t, "clip": clip, "frame": idx}


def split_index(index: PairIndex, val_clips: list[str]) -> tuple[PairIndex, PairIndex]:
    val_set = set(val_clips)
    train_items = [it for it in index.items if it[0] not in val_set]
    val_items = [it for it in index.items if it[0] in val_set]
    train = PairIndex(items=train_items, clips_root=index.clips_root, teacher_root=index.teacher_root)
    val = PairIndex(items=val_items, clips_root=index.clips_root, teacher_root=index.teacher_root)
    return train, val
