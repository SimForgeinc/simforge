"""Dev-assets map inventory and per-map episode-spec resolution.

Map list semantics: a "CARLA map" here is one dev-assets map directory
carrying ``bundle.json``. The bundle pins the immutable identity the V2X
contract requires every V2X-facing artifact to carry:

    {mapId, xodrSha256}

``load_world`` = a **new env-server session** on that map: an episode spec
is materialized from the instance catalog (a real scenario-instance for
the target map), and a fresh env-server subprocess replaces the old one.
Optional ``weather``/``traffic`` overrides are baked into the
materialized instance's ``operationalConditions`` before launch.
"""

from __future__ import annotations

import json
import os
import tempfile
from dataclasses import dataclass, field
from pathlib import Path


@dataclass(frozen=True)
class MapInfo:
    """One dev-assets map with its pinned digest identity."""

    map_id: str
    label: str
    xodr_sha256: str
    path: Path

    def digest(self) -> dict:
        """The V2X map-digest rule: consumers MUST refuse mismatches."""
        return {"mapId": self.map_id, "xodrSha256": self.xodr_sha256}


def available_maps(dev_assets_root: str | None = None) -> list[MapInfo]:
    """Every dev-assets map that carries a bundle.json."""
    root = _dev_assets_root(dev_assets_root)
    maps: list[MapInfo] = []
    for entry in sorted(root.iterdir()):
        bundle = entry / "bundle.json"
        if not entry.is_dir() or not bundle.exists():
            continue
        doc = json.loads(bundle.read_text())
        maps.append(MapInfo(
            map_id=entry.name,
            label=str(doc.get("label") or entry.name),
            xodr_sha256=str(doc.get("xodrSha256") or ""),
            path=entry,
        ))
    return maps


def resolve_map_info(map_name: str, dev_assets_root: str | None = None) -> MapInfo:
    """Resolve by exact map id or by case/underscore-normalized name."""
    maps = available_maps(dev_assets_root)

    def norm(s: str) -> str:
        return s.replace("-", "_").replace(" ", "_").lower()

    for info in maps:
        if info.map_id == map_name:
            return info
    for info in maps:
        if norm(info.map_id) == norm(map_name) or norm(info.label) == norm(map_name):
            return info
    raise RuntimeError(
        f"unknown map {map_name!r}; available maps: {[m.map_id for m in maps]}")


def read_map_digest(map_name: str, dev_assets_root: str | None = None) -> dict:
    return resolve_map_info(map_name, dev_assets_root).digest()


# --------------------------------------------------------------- instances

def instance_search_roots(extra: list[str] | None = None) -> list[Path]:
    """Where to look for scenario-instance JSONs, priority order.

    ``UNISCENARIO_INSTANCE_DIRS`` (colon-separated) first, then the repo's
    committed examples/fixtures, then the local machine's w0 instance pool.
    """
    roots: list[Path] = []
    env = os.environ.get("UNISCENARIO_INSTANCE_DIRS")
    if env:
        roots.extend(Path(p) for p in env.split(":") if p)
    repo = Path(__file__).resolve().parents[3]
    roots.append(repo / "examples" / "edge-cases")
    roots.append(repo / "fixtures" / "evidence")
    roots.append(repo / "examples")
    if extra:
        roots.extend(Path(p) for p in extra)
    roots.append(Path("/home/path/w0-data/instances"))
    return [r for r in roots if r.is_dir()]


def _iter_instance_files(roots: list[Path], per_root_cap: int = 2000):
    seen: set[Path] = set()
    for root in roots:
        count = 0
        for path in sorted(root.rglob("*.json")):
            real = path.resolve()
            if real in seen:
                continue
            seen.add(real)
            yield path
            count += 1
            if count >= per_root_cap:
                break


def find_instance_for_map(map_id: str,
                          roots: list[Path] | None = None) -> Path | None:
    """The first scenario-instance whose input targets ``map_id``.

    Only real instances qualify: the ``scenario-instance`` envelope or a
    raw ``SimScenarioInput`` carrying an ``actors`` array (intent/catalog
    documents also carry ``mapId`` but are not runnable).
    """
    for path in _iter_instance_files(roots or instance_search_roots()):
        if not _is_runnable_instance(path):
            continue
        try:
            inp = _instance_input(path)
        except (OSError, ValueError):
            continue
        if inp is not None and inp.get("mapId") == map_id:
            return path
    return None


def _instance_input(path: Path) -> dict | None:
    doc = json.loads(path.read_text())
    inp = doc.get("input") if isinstance(doc.get("input"), dict) else doc
    return inp if isinstance(inp, dict) else None


def _is_runnable_instance(path: Path) -> bool:
    try:
        doc = json.loads(path.read_text())
    except (OSError, ValueError):
        return False
    if isinstance(doc, dict) and doc.get("kind") == "scenario-instance":
        return True
    return isinstance(doc, dict) and isinstance(doc.get("actors"), list)


def instance_catalog(roots: list[Path] | None = None) -> dict[str, list[str]]:
    """map_id → instance paths (diagnostics / tests)."""
    catalog: dict[str, list[str]] = {}
    for path in _iter_instance_files(roots or instance_search_roots()):
        if not _is_runnable_instance(path):
            continue
        try:
            inp = _instance_input(path)
        except (OSError, ValueError):
            continue
        mid = (inp or {}).get("mapId")
        if mid:
            catalog.setdefault(str(mid), []).append(str(path))
    return catalog


# ------------------------------------------------------------ spec building

def build_episode_spec(map_id: str, *, weather_patch: dict | None = None,
                       dev_assets_root: str | None = None,
                       workdir: str | None = None,
                       roots: list[Path] | None = None) -> tuple[str, str]:
    """Materialize ``(spec_path, instance_path)`` for one load_world call.

    ``weather_patch`` is a partial operationalConditions document (see
    weather.to_operational_conditions / scenario_weather_patch); it is
    merged into the instance copy so the new session is *born* with those
    conditions.
    """
    info = resolve_map_info(map_id, dev_assets_root)
    instance = find_instance_for_map(info.map_id, roots)
    if instance is None:
        catalog = instance_catalog(roots)
        raise RuntimeError(
            f"no scenario instance available for map {info.map_id!r}; "
            f"catalog: { {k: len(v) for k, v in catalog.items()} } — point "
            f"UNISCENARIO_INSTANCE_DIRS at a pool of instances")
    topology = next((c for c in (info.path / "browser" / "topology-index.json.gz",
                                 info.path / "topology-index.json.gz") if c.exists()), None)
    if topology is None:
        raise FileNotFoundError(f"no topology-index.json.gz for {info.map_id!r} under {info.path}")

    out_dir = Path(workdir or tempfile.mkdtemp(prefix="simforge-load-"))
    out_dir.mkdir(parents=True, exist_ok=True)

    doc = json.loads(instance.read_text())
    if weather_patch:
        inp = dict(doc.get("input") or {})
        conditions = dict(inp.get("operationalConditions") or {})
        effects = dict(conditions.get("effects") or {})
        patch_effects = weather_patch.get("effects") or {}
        conditions.update({k: v for k, v in weather_patch.items() if k != "effects"})
        effects.update(patch_effects)
        if effects:
            conditions["effects"] = effects
        inp["operationalConditions"] = conditions
        doc["input"] = inp
        instance_path = out_dir / f"{info.map_id}-loaded.json"
        instance_path.write_text(json.dumps(doc))
    else:
        instance_path = instance.resolve()
    spec_path = out_dir / f"{info.map_id}.episodes.json"
    spec_path.write_text(json.dumps({
        "version": 1,
        "instances": [{"input": str(instance_path), "topology": str(topology)}],
    }))
    return str(spec_path), str(instance_path)



def _dev_assets_root(explicit: str | None) -> Path:
    from ._lanegraph import find_dev_assets
    return Path(find_dev_assets(explicit))
