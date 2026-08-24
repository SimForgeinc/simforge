"""WSB5 demo: gym-adapter-shaped zero-copy consumption + latency numbers.

Starts nothing itself; expects native-render-service already running.
Usage: python3 demo_step_latency.py <socket> <n_steps>
"""
import sys, time
import numpy as np
from simforge_native import NativeRenderClient

socket_path = sys.argv[1]
steps = int(sys.argv[2]) if len(sys.argv) > 2 else 200

client = NativeRenderClient(socket_path)
camera = {
    "sensorId": "demo-cam",
    "width": 736,
    "height": 416,
    "fovDeg": 58.0,
    "eye": [580.45, 14.44, -1655.66],
    "target": [590.40, 14.35, -1648.96],
}

# First step includes per-camera first-render setup; measure steady state after.
obs0, _ = client.step(0, [camera])
rgb_view = obs0["demo-cam"]["rgb"]
depth_view = obs0["demo-cam"]["depth"]
print("rgb view:", rgb_view.shape, rgb_view.dtype, "| depth view:", depth_view.shape, depth_view.dtype)
print("zero-copy into shm ring:", np.shares_memory(rgb_view, client.shm), np.shares_memory(depth_view, client.shm))
print("rgb non-uniform:", float(rgb_view.std()) > 1.0, "| finite depth fraction:",
      float(np.isfinite(depth_view).mean()))

lat = []
t0 = time.perf_counter()
for tick in range(1, steps + 1):
    t_start = time.perf_counter()
    obs, server_ms = client.step(tick, [camera])
    lat.append((time.perf_counter() - t_start) * 1000.0)
wall_s = time.perf_counter() - t0

lat.sort()
p = lambda q: lat[min(len(lat) - 1, int(q * len(lat)))]
print(f"steps={steps} wall={wall_s:.3f}s steps/s={steps / wall_s:.1f}")
print(f"step latency ms: avg={sum(lat)/len(lat):.3f} p50={p(0.5):.3f} p99={p(0.99):.3f}")
client.close()
