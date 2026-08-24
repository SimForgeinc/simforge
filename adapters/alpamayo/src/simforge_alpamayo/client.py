"""Blocking client for the simforge-alpamayo server + smoke-test CLI.

    python -m simforge_alpamayo.client --socket /tmp/simforge-alpamayo.sock \
        --cams 2 --seed 42
"""

from __future__ import annotations

import argparse
import json
import socket
import time
from typing import Any

from simforge_alpamayo.protocol import recv_msg, send_msg


class AlpamayoClient:
    def __init__(self, socket_path: str = "/tmp/simforge-alpamayo.sock", timeout: float = 600.0):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(timeout)
        self.sock.connect(socket_path)

    def call(self, req: dict[str, Any]) -> dict[str, Any]:
        send_msg(self.sock, req)
        resp = recv_msg(self.sock)
        if resp is None:
            raise ConnectionError("server closed connection")
        return resp

    def hello(self) -> dict:
        return self.call({"op": "hello"})

    def health(self) -> dict:
        return self.call({"op": "health"})

    def warmup(self, cams: int = 2) -> dict:
        return self.call({"op": "warmup", "cams": cams})

    def act(self, obs: dict, seed: int = 0, **params) -> dict:
        return self.call({"op": "act", "obs": obs, "seed": seed, "params": params})

    def close(self) -> None:
        try:
            self.call({"op": "close"})
        finally:
            self.sock.close()


def main() -> None:
    from simforge_alpamayo.obs import synthetic_observation

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--socket", default="/tmp/simforge-alpamayo.sock")
    parser.add_argument("--cams", type=int, default=2, choices=[2, 4, 7])
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--samples", type=int, default=1)
    args = parser.parse_args()

    client = AlpamayoClient(args.socket)
    print("hello:", json.dumps({k: v for k, v in client.hello().items() if k != "pins"}))
    print("health:", json.dumps(client.health()))

    obs = synthetic_observation(num_cameras=args.cams, seed=args.seed)
    t0 = time.monotonic()
    resp = client.act(obs, seed=args.seed, num_traj_samples=args.samples)
    wall_ms = (time.monotonic() - t0) * 1e3
    if not resp.get("ok"):
        raise SystemExit(f"act failed: {resp.get('error')}")
    result = resp["result"]
    traj = result["trajectories"][0]
    print(f"act[{args.cams}cam] wall={wall_ms:.0f}ms server={result['timings']}")
    print(f"trajectory: {len(result['trajectories'])} sample(s) x {len(traj)} waypoints")
    print("  first 3 wp:", [[round(v, 3) for v in wp] for wp in traj[:3]])
    print("  last  wp  :", [round(v, 3) for v in traj[-1]])
    print("reasoning[0]:", (result["reasoning"][0] or "")[:400])
    print("vram:", json.dumps(result["vram"]))
    client.close()


if __name__ == "__main__":
    main()
