"""Frame sources: how camera sensors get pixels.

One seam, per plan: the facade maps sensor requests onto whatever render path
exists. Today that is the browser engine (Studio three.js viewer driven by
``scripts/w0/render-clip.mjs``, the W0 POV clip renderer); when WSB5's native
render service lands it becomes a second FrameSource behind this same
protocol.
"""

from __future__ import annotations

import json
import os
import subprocess  # noqa: S404 - deliberate managed renderer invocation
import sys
from pathlib import Path
from typing import Protocol


class FrameSource(Protocol):
    """Where camera frames come from, keyed by time (seconds) and camera."""

    def start(self) -> None:
        """Materialize whatever backing artifact is needed."""

    def frame_at(self, t_s: float, camera_key: str) -> bytes | None:
        """PNG bytes at engine time ``t_s`` or None when outside the window."""
        ...

    def close(self) -> None: ...


class NullFrameSource:
    """Frame source with no pixels: sensors attach but never fire."""

    def start(self) -> None: ...
    def frame_at(self, t_s: float, camera_key: str) -> bytes | None:
        return None
    def close(self) -> None: ...


class BrowserClipFrameSource:
    """Renders an instance/trace pair through the browser engine once.

    Drives ``scripts/w0/render-clip.mjs`` (ego dashcam POV, 736x416, H3 rig)
    against a running Studio viewer (default http://localhost:5199). Frames are
    cached in ``workdir/frames/`` with a manifest; a matching existing render
    is reused instead of re-rendering.

    Limitation (documented in the README): frames follow the *authored*
    choreography of the instance/trace pair, so they match env-server state
    exactly only while the client sends empty actions.
    """

    RENDER_SCRIPT = Path(__file__).resolve().parents[3] / "scripts" / "w0" / "render-clip.mjs"

    def __init__(self, instance_path: str, trace_path: str, workdir: str,
                 *, seconds: float = 8.0, fps: int = 10,
                 width: int = 736, height: int = 416,
                 studio_url: str | None = None) -> None:
        self.instance_path = str(Path(instance_path).resolve())
        self.trace_path = str(Path(trace_path).resolve())
        self.workdir = Path(workdir)
        self.seconds = seconds
        self.fps = fps
        self.width = width
        self.height = height
        self.studio_url = studio_url or os.environ.get("UNISCENARIO_STUDIO_URL", "http://localhost:5199/")
        self._frames: list[Path] = []
        self._times: list[float] = []
        self._started = False

    # ------------------------------------------------------------------ api

    def start(self) -> None:
        if self._started:
            return
        frames_dir = self.workdir / "frames"
        sidecar = self.workdir / ".simforge-carla-api-cache.json"
        if sidecar.exists() and frames_dir.is_dir():
            cache = json.loads(sidecar.read_text())
            expected = self._cache_key()
            if all(str(cache.get(k)) == str(v) for k, v in expected.items()):
                self._load_cached(frames_dir)
                self._started = True
                return
        self._render(frames_dir)
        self._started = True

    def _cache_key(self) -> dict:
        return {
            "instance": self.instance_path,
            "trace": self.trace_path,
            "fps": self.fps,
            "width": self.width,
            "height": self.height,
            "seconds": self.seconds,
        }

    def _render(self, frames_dir: Path) -> None:
        if not self.RENDER_SCRIPT.exists():
            raise RuntimeError(f"renderer script missing: {self.RENDER_SCRIPT}")
        self.workdir.mkdir(parents=True, exist_ok=True)
        command = [
            "node", str(self.RENDER_SCRIPT),
            "--instance", self.instance_path,
            "--trace", self.trace_path,
            "--out", str(self.workdir),
            "--url", self.studio_url,
            "--camera", "pov",
            "--seconds", str(self.seconds),
            "--fps", str(self.fps),
            "--size", f"{self.width}x{self.height}",
        ]
        print(f"[simforge_carla_api] rendering {self.seconds}s @ {self.fps} fps via browser engine …",
              file=sys.stderr)
        result = subprocess.run(command, cwd=str(self.RENDER_SCRIPT.parents[2]),
                                capture_output=True, text=True)  # noqa: S603
        if result.returncode != 0:
            tail = "\n".join((result.stdout + result.stderr).splitlines()[-15:])
            raise RuntimeError(f"browser-engine render failed:\n{tail}")
        manifest = json.loads((self.workdir / "manifest.json").read_text())
        (self.workdir / ".simforge-carla-api-cache.json").write_text(json.dumps(self._cache_key()))
        self._load_cached(frames_dir)

    def _load_cached(self, frames_dir: Path) -> None:
        # render-clip's manifest carries the clip's absolute start time on the
        # trace clock; frames land at startT + i/fps.
        try:
            start_t = float(json.loads((frames_dir.parent / "manifest.json").read_text())["startT"])
        except Exception:
            start_t = 0.0
        files = sorted(frames_dir.glob("frame-*.png"))
        self._frames = files
        self._times = [start_t + i / self.fps for i in range(len(files))]


    def frame_at(self, t_s: float, camera_key: str) -> bytes | None:
        if not self._frames:
            return None
        index = min(range(len(self._times)),
                    key=lambda i: abs(self._times[i] - t_s))
        return self._frames[index].read_bytes()

    def close(self) -> None: ...

    @property
    def window_s(self) -> tuple[float, float]:
        return (self._times[0], self._times[-1]) if self._times else (0.0, 0.0)
