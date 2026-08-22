#!/usr/bin/env python3
"""Verify Bevy spike ID + depth passes against camera geometry and W0 GT."""
import json, sys
import numpy as np
from PIL import Image

prefix = sys.argv[1] if len(sys.argv) > 1 else 'out/bevy_a_run1'
eye = np.array([580.4496, 14.439602088928222, -1655.6614])
target = np.array([590.4016391009538, 14.352102088928222, -1648.956407999029])
fov = 58.0; W, H = 736, 416; near, far = 0.5, 900.0
ground_y = 12.99

fwd = target - eye; fwd /= np.linalg.norm(fwd)
right = np.cross(fwd, [0, 1, 0]); right /= np.linalg.norm(right)
up = np.cross(right, fwd)

idimg = np.array(Image.open(f'{prefix}.id.png'))
raw = np.fromfile(f'{prefix}.depth.f32.bin', dtype='<f4')
assert raw.size == H * W, (raw.size, H * W)
depth = raw.reshape(H, W)
legend = {l['id']: l['name'] for l in json.load(open(f'{prefix}.legend.json'))}

ids = (idimg[:, :, 0].astype(np.uint32)
       | (idimg[:, :, 1].astype(np.uint32) << 8)
       | (idimg[:, :, 2].astype(np.uint32) << 16))
uniq = sorted(set(ids.ravel().tolist()))
bg = int((ids == 0).sum())
print(f'unique instance IDs visible: {len(uniq)} (background pixels {bg}/{H*W} = {bg/(H*W):.1%})')
for i in uniq[1:6]:
    print(f'  id {i} -> {legend.get(i, "MISSING")[:60]}')

def ray_dir(px, py):
    ndc_x = (px + 0.5) / W * 2 - 1
    ndc_y = 1 - (py + 0.5) / H * 2
    t = np.tan(np.radians(fov) / 2)
    d = fwd + right * ndc_x * t * (W / H) + up * ndc_y * t
    return d / np.linalg.norm(d)

errs = []
for py in range(300, 384, 8):
    for px in range(200, 500, 30):
        dv = float(depth[py, px])
        if dv <= 0.001:
            continue
        dist = near / dv          # reverse-Z: view distance = near/d
        r = ray_dir(px, py)
        if r[1] >= -1e-4:
            continue
        tg = (ground_y - eye[1]) / r[1]
        if 0 < tg < far:
            errs.append((dist, tg))
errs = np.array(errs)
ratio = errs[:, 0] / errs[:, 1]
print(f'depth-vs-geometry on road pixels: n={len(errs)} '
      f'dist_ratio mean={ratio.mean():.4f} std={ratio.std():.4f}')

ped = np.array([642.1497, 13.59, -1608.0448])
rel = ped - eye; dist_ped = np.linalg.norm(rel)
cam = np.array([np.dot(rel, right), np.dot(rel, up), np.dot(rel, fwd)])
px = int((cam[0] / cam[2] / (np.tan(np.radians(fov) / 2)) * (W / H) + 1) / 2 * W)
py = int((1 - cam[1] / cam[2] / np.tan(np.radians(fov) / 2)) / 2 * H)
if 0 <= px < W and 0 <= py < H:
    dv = float(depth[py, px])
    print(f'GT pedestrian pixel ({px},{py}) expected_dist={dist_ped:.1f}m '
          f'depth_raw={dv:.4f} -> dist={near/max(dv,1e-6):.1f}m')
else:
    print('GT pedestrian outside frame')
