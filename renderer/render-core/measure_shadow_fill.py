#!/usr/bin/env python3
"""WSB4 shadow-fill check: mean luminance of shadowed vs sunlit ROAD pixels.

Road pixels: lower-center band of frame (drivable surface, verified against
the instance-ID pass). Sunlit vs shadowed classes: Otsu split over that band.

Reference ratio used: on a clear day a horizontal surface receives ~100 klx
direct sun plus ~10-25 klx sky diffuse (WMO/CIE clear-sky values), so the
physically plausible shadowed/sunlit luminance ratio is ~0.10-0.30 and the
fill should be sky-tinted (bluer than the sunlit area).
"""
import sys, numpy as np
from PIL import Image

def otsu(vals):
    hist,_ = np.histogram((vals*255).astype(np.uint8), bins=256, range=(0,256))
    total = hist.sum(); sum_all = np.dot(np.arange(256), hist)
    sb=0.; wb=0.; bt=127; bv=-1.
    for t in range(256):
        wb += hist[t]
        if wb==0: continue
        wf = total-wb
        if wf==0: break
        sb += t*hist[t]
        mb=sb/wb; mf=(sum_all-sb)/wf
        v=wb*wf*(mb-mf)**2
        if v>bv: bv,bt=v,t
    return bt/255.

def analyze(name):
    im=np.asarray(Image.open(name).convert("RGB"),np.float32)/255.
    lum=im@np.array([0.2126,0.7152,0.0722])
    h,w=lum.shape
    road=lum[int(h*0.55):int(h*0.97), int(w*0.05):int(w*0.95)]
    t=otsu(road.ravel())
    lit=road[road>t]; shd=road[road<=t]
    ratio=shd.mean()/max(lit.mean(),1e-9)
    rgb=im[int(h*0.55):int(h*0.97), int(w*0.05):int(w*0.95)]
    rl=rgb[:,:,0][road<=t].mean(); bl=rgb[:,:,2][road<=t].mean()
    print(f"{name}: sunlit={lit.mean():.4f}(n={lit.size}) shadow={shd.mean():.4f}(n={shd.size}) "
          f"ratio={ratio:.3f} shadow_B-R_tint={bl-rl:+.4f}")
    return ratio

for n in sys.argv[1:]: analyze(n)
