"""Unix-socket MessagePack server exposing Alpamayo 1.5 act().

Ops (request: {"op": ..., ...} -> response: {"ok": bool, ...}):
    hello   -> service info (quant, pins, load state)
    health  -> {"status": "ok"|"loading", "vram": {...}, "warmed": bool}
    warmup  {"cams": 2}                 -> runs one synthetic act, returns ms
    act     {"obs": {...}, "seed": int, "params": {...}} -> trajectory+reasoning
    reset   -> ack (stateless engine; provided for policy_step parity)
    close   -> closes this connection
    shutdown-> stops the server process

Run:
    python -m simforge_alpamayo.server --socket /tmp/simforge-alpamayo.sock \
        --quant nf4 --warmup-cams 2
"""

from __future__ import annotations

import argparse
import logging
import os
import signal
import socket
import sys
import time
import traceback

from simforge_alpamayo.engine import AlpamayoEngine
from simforge_alpamayo.obs import synthetic_observation
from simforge_alpamayo.protocol import recv_msg, send_msg

logger = logging.getLogger("simforge_alpamayo.server")


class Server:
    def __init__(self, socket_path: str, engine: AlpamayoEngine):
        self.socket_path = socket_path
        self.engine = engine
        self._running = True

    def warmup(self, cams: int = 2, seed: int = 0) -> dict:
        t0 = time.monotonic()
        obs = synthetic_observation(num_cameras=cams, seed=seed)
        result = self.engine.act(obs, seed=seed, num_traj_samples=1)
        self.engine.warmed = True
        return {
            "warmup_ms": (time.monotonic() - t0) * 1e3,
            "timings": result["timings"],
            "vram": result["vram"],
        }

    def handle(self, req: dict) -> tuple[dict, str]:
        """Returns (response, action) where action in {"", "close", "shutdown"}."""
        op = req.get("op")
        if op == "hello":
            return {"ok": True, **self.engine.info()}, ""
        if op == "health":
            return {
                "ok": True,
                "status": "ok" if self.engine.model is not None else "loading",
                "warmed": self.engine.warmed,
                "vram": self.engine.vram(),
            }, ""
        if op == "warmup":
            return {"ok": True, **self.warmup(int(req.get("cams", 2)))}, ""
        if op == "act":
            params = req.get("params") or {}
            result = self.engine.act(
                req["obs"],
                seed=int(req.get("seed", 0)),
                top_p=float(params.get("top_p", 0.98)),
                temperature=float(params.get("temperature", 0.6)),
                num_traj_samples=int(params.get("num_traj_samples", 1)),
                max_generation_length=int(params.get("max_generation_length", 256)),
                num_diffusion_steps=params.get("num_diffusion_steps"),
            )
            return {"ok": True, "result": result}, ""
        if op == "reset":
            return {"ok": True}, ""
        if op == "close":
            return {"ok": True}, "close"
        if op == "shutdown":
            return {"ok": True}, "shutdown"
        return {"ok": False, "error": f"unknown op: {op}"}, ""

    def serve(self) -> None:
        if os.path.exists(self.socket_path):
            os.unlink(self.socket_path)
        srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        srv.bind(self.socket_path)
        srv.listen(1)
        logger.info("listening on %s", self.socket_path)
        print(f"READY {self.socket_path}", flush=True)

        while self._running:
            conn, _ = srv.accept()
            try:
                while True:
                    req = recv_msg(conn)
                    if req is None:
                        break
                    try:
                        resp, action = self.handle(req)
                    except Exception as exc:  # keep the service alive
                        logger.error("op failed: %s", exc)
                        traceback.print_exc()
                        resp, action = {"ok": False, "error": str(exc)}, ""
                    send_msg(conn, resp)
                    if action == "close":
                        break
                    if action == "shutdown":
                        self._running = False
                        break
            finally:
                conn.close()
        srv.close()
        os.unlink(self.socket_path)
        logger.info("server stopped")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--socket", default="/tmp/simforge-alpamayo.sock")
    parser.add_argument("--quant", default="nf4", choices=["nf4", "fp8", "bf16"])
    parser.add_argument("--warmup-cams", type=int, default=0,
                        help="run a synthetic warmup act with N cameras after load (0=skip)")
    parser.add_argument("--log-level", default="INFO")
    args = parser.parse_args()

    logging.basicConfig(
        level=args.log_level,
        format="%(asctime)s %(name)s %(levelname)s %(message)s",
        stream=sys.stderr,
    )

    engine = AlpamayoEngine(quant=args.quant)
    server = Server(args.socket, engine)

    def _stop(*_a):
        raise SystemExit(0)

    signal.signal(signal.SIGTERM, _stop)
    signal.signal(signal.SIGINT, _stop)

    engine.load()
    logger.info("post-load VRAM: %s", engine.vram())
    if args.warmup_cams:
        info = server.warmup(cams=args.warmup_cams)
        logger.info("warmup: %.0f ms, VRAM %s", info["warmup_ms"], info["vram"])
    server.serve()


if __name__ == "__main__":
    main()
