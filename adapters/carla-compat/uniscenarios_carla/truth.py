"""Bridge between the facade and the V1 truth-stream subscription client.

Lives here so ``uniscenarios_carla`` does not hard-depend on the gym
package: :func:`_load_truth_stream_module` imports
``adapters/uniscenarios-gym/uniscenarios_gym/truth_stream.py`` by path.

In truth-stream mode the facade runs ONE env-server in socket mode
(:class:`TruthStreamConnection`) and speaks every op through it, so the
pushed per-engine-tick ground-truth frames belong to the exact simulation
being stepped.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path


def _load_truth_stream_module():
    """Import uniscenarios_gym.truth_stream by file path."""
    pkg_dir = Path(__file__).resolve().parents[3] / "adapters" / "uniscenarios-gym"
    module_file = pkg_dir / "uniscenarios_gym" / "truth_stream.py"
    if not module_file.exists():
        raise RuntimeError(f"truth-stream client not found at {module_file}")
    if str(pkg_dir) not in sys.path:
        sys.path.insert(0, str(pkg_dir))
    spec = importlib.util.spec_from_file_location(
        "uniscenarios_gym_truth_stream", module_file)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)  # type: ignore[union-attr]
    return module


class TruthStreamConnection:
    """Full request/reply env-server connection over the truth-stream socket."""

    def __init__(self, episodes_spec: str, session: int = 0):
        module = _load_truth_stream_module()
        self._ts = module.TruthStreamClient(episodes_spec, session=session)

    def request(self, document):
        return self._ts.request(dict(document))

    @property
    def alive(self) -> bool:
        return getattr(self._ts, "_failed", False) is False

    def close(self) -> None:
        try:
            self._ts.unsubscribe()
        except Exception:  # pragma: no cover - best effort
            pass
        self._ts.close()


def _feed_over(ts_client) -> "TruthFeed":
    feed = TruthFeed.__new__(TruthFeed)
    feed._client = ts_client  # noqa: SLF001 - shared-process wiring
    feed.latest = None
    feed.dropped_total = 0
    return feed


def open_connection(episodes_spec: str | None, session: int = 0):
    """Socket-mode connection + subscribed TruthFeed on ONE process."""
    if not episodes_spec:
        raise RuntimeError("truth-stream mode needs an episodes spec")
    conn = TruthStreamConnection(episodes_spec, session)
    conn._ts.subscribe()  # noqa: SLF001 - same-module object
    return conn, _feed_over(conn._ts)


class TruthFeed:
    """Facade-facing view over one subscribed truth stream.

    Keeps only the LATEST frame (consumers want current ground truth, not a
    backlog) plus the server's cumulative gap counter for honesty.
    """

    def __init__(self, ts_client):
        self._client = ts_client
        self.latest: dict | None = None
        self.dropped_total = 0

    def pump(self, timeout_s: float = 0.05) -> dict | None:
        """Drain pending frames, keeping the newest. Returns it (or None)."""
        seen = None
        for frame in self._client.ticks(timeout_s=timeout_s):
            seen = frame
            try:
                if len(self._client._ticks) == 0:  # noqa: SLF001 - drained
                    break
            except AttributeError:
                break
        if seen is not None:
            self.latest = seen
            self.dropped_total = int(seen.get("dropped", self.dropped_total))
        return self.latest

    @property
    def actors(self) -> list[dict]:
        """Ground-truth actor records of the latest frame (may be [])."""
        if self.latest is None:
            return []
        return list(self.latest.get("frame", {}).get("actors", []))

    @property
    def signals(self) -> list[dict]:
        """Signal snapshots at the latest frame's tick (V1 contract)."""
        if self.latest is None:
            return []
        return list(self.latest.get("signals", []))

    def digest_matches(self, map_id: str, xodr_sha256: str) -> bool:
        """The V2X map-digest rule applied to the stream identity pair."""
        latest = self.latest or {}
        return (latest.get("mapId") in (None, map_id)
                and latest.get("xodrSha256") in (None, xodr_sha256))

    def close(self) -> None:
        self._client.close()
