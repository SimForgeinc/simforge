#!/usr/bin/env python3
"""Standalone Bevy campaign preparation, fleet rollout, artifact assembly and parity QA.

The script deliberately has no SimCloud/control-plane dependency.  Renderer output is a
named-stream directory; camera, lidar and radar streams are assembled without knowing
how the persistent renderer process is implemented.
"""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
import csv
import hashlib
import json
import math
import os
from pathlib import Path
import re
import shutil
import statistics
import socket
import subprocess
import sys
import time
import zipfile
import zlib

FPS = 24
WIDTH = 1280
HEIGHT = 720
DURATION_S = 20.0
CAMERAS = [f"pronto-cam{i}" for i in range(8)] + ["chase-cam-trailing"]
LIDARS = [
    "pronto-lidar-front-left", "pronto-lidar-front-left-wide",
    "pronto-lidar-front-right", "pronto-lidar-front-right-wide",
    "pronto-lidar-rear-left", "pronto-lidar-rear-right",
]
RADARS = [f"pronto-rad-0{i}" for i in range(1, 5)]
HOSTS = [f"rtx3080-0{i}" for i in range(1, 5)]
MAP_SLUG = {
    "Belmont Research Center": "belmont-research-center",
    "Richmond Field Station": "richmond-field-station",
}
REMOTE_ROOT = "/opt/simforge/bevy-campaign-parity"
VEGETATION_DISTANCE_M = 120.0
VEGETATION_GLB_BUDGET_BYTES = 256 << 20


def load(path: Path):
    return json.loads(path.read_text())


def dump(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n")


def run(args: list[str], *, cwd: Path | None = None, capture: bool = False) -> subprocess.CompletedProcess:
    return subprocess.run(args, cwd=cwd, check=True, text=True, capture_output=capture)


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(8 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def percentile(values: list[float], q: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    at = (len(ordered) - 1) * q
    lo, hi = math.floor(at), math.ceil(at)
    return ordered[lo] if lo == hi else ordered[lo] * (hi - at) + ordered[hi] * (at - lo)


def ffprobe(path: Path) -> dict:
    result = run([
        "ffprobe", "-v", "error", "-select_streams", "v:0",
        "-show_entries", "stream=codec_name,width,height,r_frame_rate,avg_frame_rate,nb_frames,duration",
        "-of", "json", str(path),
    ], capture=True)
    streams = json.loads(result.stdout).get("streams", [])
    return streams[0] if streams else {}


def video_coverage(path: Path) -> dict:
    signal = run([
        "ffmpeg", "-v", "error", "-i", str(path), "-vf", "signalstats,metadata=print:file=-",
        "-an", "-f", "null", "-",
    ], capture=True)
    luma = [float(value) for value in re.findall(r"lavfi\.signalstats\.YAVG=([0-9.]+)", signal.stdout)]
    hashes = run(["ffmpeg", "-v", "error", "-i", str(path), "-an", "-f", "framemd5", "-"], capture=True)
    frame_hashes = [line.rsplit(",", 1)[-1].strip() for line in hashes.stdout.splitlines() if line and not line.startswith("#")]
    mean_luma = statistics.fmean(luma) if luma else 0.0
    return {"meanLuma": mean_luma, "nonBlank": mean_luma > 2.0, "uniqueFrames": len(set(frame_hashes))}


def campaign_job_map(campaign: Path) -> dict[str, list[str]]:
    by_doc: dict[str, list[str]] = {}
    qa_records = load(campaign / "qa-records.json") if (campaign / "qa-records.json").exists() else {}
    for job_id, record in qa_records.items():
        if record.get("engine") == "carla" and record.get("docId"):
            by_doc.setdefault(record["docId"], []).append(job_id)
    ledger = load(campaign / "ledger.json")
    for doc_id, record in ledger.get("documents", {}).items():
        if record.get("lane") != "carla":
            continue
        ids = [h.get("jobId") for h in record.get("history", [])] + [record.get("jobId")]
        for job_id in ids:
            if job_id and job_id not in by_doc.setdefault(doc_id, []):
                by_doc[doc_id].append(job_id)
    live = load(campaign / "live-carla-state.json") if (campaign / "live-carla-state.json").exists() else {}
    for doc_id, record in live.get("documents", {}).items():
        job_id = record.get("jobId")
        if job_id and job_id not in by_doc.setdefault(doc_id, []):
            by_doc[doc_id].append(job_id)
    return by_doc


def carla_video(campaign: Path, doc_id: str, jobs: dict[str, list[str]]) -> Path | None:
    candidates = []
    for job_id in jobs.get(doc_id, []):
        video = campaign / "qa" / job_id / "chase-cam-trailing.mp4"
        if video.is_file():
            candidates.append(video)
    return max(candidates, key=lambda p: p.stat().st_mtime) if candidates else None


def route_table(scenario: dict) -> dict[str, list[dict]]:
    table = {}
    for interaction in scenario.get("choreography", {}).get("interactions", []):
        if interaction.get("verb") != "route":
            continue
        points = interaction.get("target", {}).get("points")
        if isinstance(points, list) and points:
            table[interaction["actor"]] = sorted(points, key=lambda p: float(p.get("timeS", 0)))
    return table


def pose_at(role: dict, points: list[dict] | None, t: float) -> tuple[list[float], float, list[float]]:
    initial = role.get("pose", {})
    p0 = initial.get("position", {})
    y = float(p0.get("y", 0))
    if not points:
        return [float(p0.get("x", 0)), y, float(p0.get("z", 0))], float(initial.get("headingRad", 0)), [0, 0, 0]
    if t <= float(points[0].get("timeS", 0)):
        a, b = points[0], points[min(1, len(points) - 1)]
    elif t >= float(points[-1].get("timeS", 0)):
        a = b = points[-1]
    else:
        index = next(i for i in range(len(points) - 1) if float(points[i + 1]["timeS"]) >= t)
        a, b = points[index], points[index + 1]
    ta, tb = float(a.get("timeS", 0)), float(b.get("timeS", 0))
    u = 0 if tb == ta else (t - ta) / (tb - ta)
    x = float(a["x"]) + (float(b["x"]) - float(a["x"])) * u
    z = float(a["z"]) + (float(b["z"]) - float(a["z"])) * u
    dt = tb - ta
    vx = 0 if dt == 0 else (float(b["x"]) - float(a["x"])) / dt
    vz = 0 if dt == 0 else (float(b["z"]) - float(a["z"])) / dt
    heading = float(initial.get("headingRad", 0)) if abs(vx) + abs(vz) < 1e-8 else math.atan2(-vz, vx)
    return [x, y, z], heading, [vx, 0, vz]


def quat_y(heading: float) -> list[float]:
    return [0, math.sin(heading / 2), 0, math.cos(heading / 2)]


def scenario_sensors(scenario: dict) -> tuple[str, list[dict]]:
    subject = scenario.get("metricSubject")
    role = next((r for r in scenario.get("roles", []) if r.get("id") == subject), None)
    if role is None:
        role = next((
            r for r in scenario.get("roles", [])
            if any(s.get("id") == "chase-cam-trailing" for s in r.get("actor", {}).get("sensors", []))
        ), None)
        subject = role.get("id") if role else None
    if role is None:
        raise ValueError("scenario has no metricSubject or chase-camera sensor host")
    sensors = role.get("actor", {}).get("sensors", [])
    ids = {s.get("id") for s in sensors}
    expected = set(CAMERAS + LIDARS + RADARS)
    if ids != expected:
        raise ValueError(f"rig mismatch: missing={sorted(expected-ids)} extra={sorted(ids-expected)}")
    return subject, sensors


def scene_documents(scenario: dict, map_id: str, fps: int) -> tuple[list[dict], dict]:
    subject, _ = scenario_sensors(scenario)
    routes = route_table(scenario)
    duration = float(scenario.get("choreography", {}).get("clipSeconds", DURATION_S))
    count = int(round(duration * fps))
    roles = scenario.get("roles", [])
    descriptors = []
    for role in roles:
        actor = role.get("actor", {})
        dims = actor.get("dims", {})
        descriptors.append({
            "id": "ego" if role["id"] == subject else role["id"],
            "catalogId": actor.get("catalogId", "unknown"),
            "actorClass": actor.get("class", "prop"),
            "dims": {"l": dims.get("length", 1), "w": dims.get("width", 1), "h": dims.get("height", 1)},
            "color": role.get("extensions", {}).get("studio.presentation.bodyColor"),
        })
    frames, states = [], []
    weather_name = str(scenario.get("environment", {}).get("weather", "clear")).lower()
    weather = "rain" if "rain" in weather_name else "fog" if "fog" in weather_name else "clear"
    minutes = scenario.get("environment", {}).get("extensions", {}).get("org.simforge.sceneTime.v1", {}).get("minutes", 12 * 60)
    for tick in range(count):
        t = tick / fps
        records = []
        for role in roles:
            position, heading, velocity = pose_at(role, routes.get(role["id"]), t)
            actor = role.get("actor", {})
            records.append({
                "id": "ego" if role["id"] == subject else role["id"],
                "kind": "spawn" if tick == 0 else "update",
                "catalogId": actor.get("catalogId", "unknown"),
                "actorClass": actor.get("class", "prop"),
                "transform": {"position": position, "rotation": quat_y(heading)},
                "color": role.get("extensions", {}).get("studio.presentation.bodyColor"),
                "position": position, "rotation": quat_y(heading), "yawRad": heading,
                "velocity": velocity,
            })
        states.append({"version": "scene-state.v1", "mapId": map_id, "tick": tick, "tickHz": fps,
                       "weather": {"preset": weather}, "timeOfDay": minutes / 60, "actors": records})
        frames.append({"tick": tick, "t": t, "actors": [
            {k: r[k] for k in ("id", "kind", "position", "rotation", "yawRad", "velocity")} for r in records
        ]})
    playback = {"version": "scene-state.v1", "mapId": map_id, "frame": "map-y-up", "dt": 1 / fps,
                "tickHz": fps, "tickCount": count, "weather": {"preset": weather, "fog_density": 0,
                "rain_intensity": 0, "wetness": 0}, "timeOfDay": minutes / 60, "profile": "cinematic",
                "actors": descriptors, "frames": frames}
    return states, playback


def corpus_glbs(repo: Path, map_id: str) -> list[str]:
    root = repo / ".corpus" / map_id
    manifest = load(root / "manifest.json")
    paths = []
    for record in manifest["files"]:
        rel = record["path"]
        if record.get("kind") != "glb" or "/veg_" in rel:
            continue
        if rel.endswith("road.glb") or ".lod" not in rel or rel.endswith(".lod0.glb"):
            path = root / rel
            if path.is_file():
                paths.append(str(path.resolve()))
    if not paths:
        raise FileNotFoundError(f"no materialized corpus GLBs for {map_id}")
    return paths

def corpus_vegetation(repo: Path, map_id: str) -> tuple[list[str], list[str]]:
    root = repo / ".corpus" / map_id
    manifest = load(root / "manifest.json")
    prototypes, sidecars = [], []
    for record in manifest["files"]:
        rel = record["path"]
        path = root / rel
        if not path.is_file():
            continue
        if "/veg_" in rel and rel.endswith(".lod0.glb"):
            prototypes.append(str(path.resolve()))
        elif rel.endswith(".instances.json"):
            sidecars.append(str(path.resolve()))
    return prototypes, sidecars


def inventory(args) -> None:
    campaign, repo, out = Path(args.campaign), Path(args.repo), Path(args.out)
    jobs = campaign_job_map(campaign)
    ledger = load(campaign / "ledger.json")
    live = load(campaign / "live-carla-state.json") if (campaign / "live-carla-state.json").exists() else {}
    rows = []
    for selected in load(campaign / "selection.json"):
        doc_id = selected["docId"]
        scenario = load(campaign / "transformed" / f"{doc_id}.json")
        subject, sensors = scenario_sensors(scenario)
        video = carla_video(campaign, doc_id, jobs)
        spec = ffprobe(video) if video else {}
        record = ledger.get("documents", {}).get(doc_id, {})
        live_record = live.get("documents", {}).get(doc_id, {})
        video_job_id = video.parent.name if video else None
        video_timing = next((
            float(h["renderS"]) for h in record.get("history", [])
            if h.get("jobId") == video_job_id and h.get("renderS")
        ), None)
        times = [] if record.get("lane") != "carla" else [
            float(h["renderS"]) for h in record.get("history", [])
            if h.get("state") == "succeeded" and h.get("renderS")
        ]
        rows.append({
            "docId": doc_id, "mapId": MAP_SLUG[selected["map"]], "map": selected["map"], "dataset": selected.get("dataset"),
            "subjectActorId": subject, "actors": [{"id": r["id"], "catalogId": r.get("actor", {}).get("catalogId"),
                "class": r.get("actor", {}).get("class"), "static": r.get("actor", {}).get("static", False)} for r in scenario.get("roles", [])],
            "sensors": [{"id": s["id"], "type": s["type"], "mount": s.get("mount"), "camera": s.get("camera")} for s in sensors],
            "chase": next(s for s in sensors if s["id"] == "chase-cam-trailing"),
            "video": {"path": str(video) if video else None, **spec},
            "durationS": float(scenario.get("choreography", {}).get("clipSeconds", DURATION_S)),
            "carlaA100RenderS": video_timing if video_timing is not None else (
                live_record.get("renderS") if live_record.get("state") == "succeeded" else (
                    times[-1] if times else (record.get("renderS") if record.get("lane") == "carla" else None)
                )
            ),
        })
    dump(out, {"schema": "simforge.bevy-campaign-inventory/v1", "documents": rows})
    print(json.dumps({"documents": len(rows), "carlaVideos": sum(bool(r["video"]["path"]) for r in rows),
                      "carlaTimings": sum(r["carlaA100RenderS"] is not None for r in rows)}))


def prepare(args) -> None:
    campaign, repo, root = Path(args.campaign), Path(args.repo), Path(args.out)
    inventory_path = root / "campaign-inventory.json"
    ns = argparse.Namespace(campaign=str(campaign), repo=str(repo), out=str(inventory_path))
    inventory(ns)
    inventory_doc = load(inventory_path)
    for row in inventory_doc["documents"]:
        doc_id, map_id = row["docId"], row["mapId"]
        scenario_path = campaign / "transformed" / f"{doc_id}.json"
        scenario = load(scenario_path)
        states, playback = scene_documents(scenario, map_id, FPS)
        job_dir = root / "jobs" / doc_id
        dump(job_dir / "scene-states.json", states)
        dump(job_dir / "scene-playback.json", playback)
        shutil.copy2(scenario_path, job_dir / "scenario.json")
        veg_glbs, veg_sidecars = corpus_vegetation(repo, map_id)
        job = {"schema": "simforge.bevy-campaign-job/v1", **row, "fps": FPS, "width": WIDTH, "height": HEIGHT,
               "frameCount": len(states), "corpusGlbs": corpus_glbs(repo, map_id),
               "vegGlbs": veg_glbs, "vegSidecars": veg_sidecars,
               "vehicleModels": str((repo / "catalog/vehicles-carla").resolve()),
               "rigProgram": str((repo / "qualification/render-qualification-program.v1.json").resolve()),
               "xodr": str((Path("/home/path/local-uniscenarios/maps") / map_id / "xodr.xodr").resolve()),
               "jobDir": str(job_dir.resolve())}
        dump(job_dir / "job.json", job)
    shards = [[] for _ in HOSTS]
    for index, row in enumerate(inventory_doc["documents"]):
        shards[index % len(HOSTS)].append(row["docId"])
    for host, docs in zip(HOSTS, shards):
        dump(root / "shards" / f"{host}.json", {"host": host, "documents": docs})
    print(json.dumps({"prepared": len(inventory_doc["documents"]), "shards": [len(s) for s in shards]}))


def encode_pngs(pattern: str, output: Path, fps: int = FPS) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    run(["ffmpeg", "-y", "-loglevel", "error", "-framerate", str(fps), "-i", pattern,
         "-c:v", "libx264", "-preset", "fast", "-crf", "18", "-pix_fmt", "yuv420p",
         "-r", str(fps), "-movflags", "+faststart", str(output)])


def archive_stream(directory: Path, output: Path, suffix: str) -> int:
    files = sorted(directory.glob(f"*.{suffix}"))
    if not files:
        return 0
    output.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
        for path in files:
            archive.write(path, path.name)
    return len(files)


def draw_points(points: list[tuple[float, float, int]], out: Path, width: int = 640, height: int = 360) -> None:
    pixels = bytearray([8, 12, 18]) * (width * height)
    scale = min(width, height) / 220
    cx, cy = width // 2, height // 2
    for x, y, strength in points:
        px, py = int(cx + x * scale), int(cy - y * scale)
        if 1 <= px < width - 1 and 1 <= py < height - 1:
            for oy in (-1, 0, 1):
                for ox in (-1, 0, 1):
                    at = ((py + oy) * width + px + ox) * 3
                    pixels[at:at + 3] = bytes((min(255, strength), min(255, strength + 35), 255))
    out.parent.mkdir(parents=True, exist_ok=True)
    with out.open("wb") as stream:
        stream.write(f"P6\n{width} {height}\n255\n".encode())
        stream.write(pixels)


def lidar_points(path: Path) -> list[tuple[float, float, int]]:
    rows, body = [], False
    for line in path.read_text(errors="replace").splitlines():
        if not body:
            body = line.strip() == "end_header"
            continue
        fields = line.split()
        if len(fields) >= 4:
            rows.append((float(fields[0]), float(fields[2]), max(30, int(float(fields[3]) * 255))))
    return rows


def radar_points(path: Path) -> list[tuple[float, float, int]]:
    rows = []
    with path.open(newline="") as stream:
        for row in csv.DictReader(stream):
            depth, az = float(row["depth_m"]), float(row["azimuth_rad"])
            rows.append((depth * math.cos(az), depth * math.sin(az), 210))
    return rows


def assemble(args) -> None:
    job = load(Path(args.job))
    raw, out = Path(args.raw), Path(args.out)
    started = time.time()
    artifacts = []
    for sensor in CAMERAS:
        directory = raw / sensor
        pattern = directory / "%08d.rgb.png"
        if not (directory / "00000000.rgb.png").exists():
            pattern = directory / "frame-%06d.rgb.png"
        if Path(str(pattern).replace("%08d", "00000000").replace("%06d", "000000")).exists():
            video = out / f"{sensor}.mp4"
            encode_pngs(str(pattern), video, job["fps"])
            artifacts.append((sensor, "sensor-video", video))
    for sensor, suffix, parser in [(s, "ply", lidar_points) for s in LIDARS] + [(s, "csv", radar_points) for s in RADARS]:
        directory = raw / sensor
        count = archive_stream(directory, out / f"{sensor}.zip", suffix)
        if not count:
            continue
        viz = out / "viz" / sensor
        for index, source in enumerate(sorted(directory.glob(f"*.{suffix}"))):
            draw_points(parser(source), viz / f"{index:08d}.ppm")
        video = out / f"{sensor}.mp4"
        encode_pngs(str(viz / "%08d.ppm"), video, job["fps"])
        artifacts.extend([(sensor, "sensor-video", video), (sensor, "sensor-archive", out / f"{sensor}.zip")])
    manifest = []
    for sensor, kind, path in artifacts:
        manifest.append({"sensorId": sensor, "kind": kind, "relativePath": path.name,
                         "mediaType": "video/mp4" if path.suffix == ".mp4" else "application/zip",
                         "sizeBytes": path.stat().st_size, "sha256": sha256(path)})
    expected = {(s, "sensor-video") for s in CAMERAS + LIDARS + RADARS} | {(s, "sensor-archive") for s in LIDARS + RADARS}
    actual = {(a["sensorId"], a["kind"]) for a in manifest}
    dump(out / "manifest.json", {"schema": "simforge.bevy-artifact-manifest/v1", "docId": job["docId"],
                                 "artifacts": manifest, "complete": actual == expected,
                                 "missing": sorted([list(v) for v in expected - actual])})
    dump(out / "assembly-benchmark.json", {"wallS": time.time() - started, "artifactCount": len(manifest)})
    print(json.dumps({"docId": job["docId"], "artifacts": len(manifest), "missing": len(expected - actual)}))


def relocated_job(job: dict, job_path: Path) -> dict:
    """Resolve prepared local paths after the portable job is copied to a fleet host."""
    if Path(job["jobDir"]).is_dir() and all(Path(p).is_file() for p in job["corpusGlbs"]):
        return job
    root = Path(os.environ.get("SIMFORGE_BEVY_CAMPAIGN_ROOT", REMOTE_ROOT))
    moved = dict(job)
    moved["jobDir"] = str(job_path.parent)
    def relocate(values: list[str]) -> list[str]:
        resolved = []
        for value in values:
            path = Path(value)
            if ".corpus" not in path.parts:
                resolved.append(value)
                continue
            corpus_index = path.parts.index(".corpus")
            resolved.append(str(root / "corpus" / Path(*path.parts[corpus_index + 1:])))
        return resolved
    moved["corpusGlbs"] = relocate(job["corpusGlbs"])
    moved["vegGlbs"] = relocate(job.get("vegGlbs", []))
    moved["vegSidecars"] = relocate(job.get("vegSidecars", []))
    moved["vehicleModels"] = str(root / "catalog" / "vehicles-carla")
    return moved

def budget_vegetation(job: dict) -> tuple[list[str], dict]:
    """Choose route-near vegetation prototypes within the measured 10 GB fleet budget."""
    states = load(Path(job["jobDir"]) / "scene-states.json")
    route = [
        actor["transform"]["position"]
        for frame in states[::FPS]
        for actor in frame["actors"]
        if actor["id"] == "ego" and actor["kind"] != "despawn"
    ]
    if not route:
        return [], {"distanceM": VEGETATION_DISTANCE_M, "glbBudgetBytes": VEGETATION_GLB_BUDGET_BYTES,
                    "selectedGlbs": 0, "selectedBytes": 0, "selectedInstances": 0}

    glbs_by_stem = {
        str(Path(path)).removesuffix(".lod0.glb"): path
        for path in job.get("vegGlbs", [])
    }
    candidates = []
    for sidecar in job.get("vegSidecars", []):
        data = load(Path(sidecar))
        transforms = data.get("transforms", [])
        if not transforms:
            continue
        distance_sq = min(
            (transforms[index + 12] - point[0]) ** 2 + (transforms[index + 14] - point[2]) ** 2
            for index in range(0, len(transforms), 16)
            for point in route
        )
        stem = str(Path(sidecar)).removesuffix(".instances.json")
        glb = glbs_by_stem.get(stem)
        if glb and distance_sq <= VEGETATION_DISTANCE_M ** 2:
            candidates.append((distance_sq, glb, sum(data.get("counts", []))))

    selected, selected_bytes, selected_instances = [], 0, 0
    for _, glb, instances in sorted(candidates, key=lambda value: (value[0], value[1])):
        size = Path(glb).stat().st_size
        if selected_bytes + size > VEGETATION_GLB_BUDGET_BYTES:
            continue
        selected.append(glb)
        selected_bytes += size
        selected_instances += instances
    return selected, {
        "distanceM": VEGETATION_DISTANCE_M,
        "glbBudgetBytes": VEGETATION_GLB_BUDGET_BYTES,
        "selectedGlbs": len(selected),
        "selectedBytes": selected_bytes,
        "selectedInstances": selected_instances,
    }

def service_cameras(job: dict) -> list[dict]:
    cameras = []
    for sensor in job["sensors"]:
        if sensor["type"] != "dash_camera":
            continue
        mount = sensor["mount"]
        position = mount["position"]
        rotation = mount.get("rotation", {})
        chase = sensor["id"] == "chase-cam-trailing"
        cameras.append({
            "sensorId": sensor["id"], "width": job["width"], "height": job["height"],
            "fovDeg": sensor["camera"]["verticalFovDeg"], "eye": [0, 0, 0], "target": [1, 0, 0],
            "profile": "cinematic" if chase else "sensor",
            "attach": {
                "actorId": "ego",
                "offsetM": [position["x"], position.get("z", 0), position["y"]],
                "yawDeg": math.degrees(rotation.get("yawRad", 0)),
                "pitchDeg": math.degrees(rotation.get("pitchRad", 0)),
                "lookAtActor": chase,
            },
        })
    return cameras


def service_range_sensors(job: dict) -> tuple[list[dict], list[dict]]:
    authored = {
        sensor_id: {"horizontalFovDeg": 120.0, "verticalFovDeg": 70.0 if "wide" in sensor_id or "rear" in sensor_id else 25.0}
        for sensor_id in LIDARS
    }
    authored.update({
        sensor_id: {"horizontalFovDeg": 30.0, "verticalFovDeg": 30.0}
        for sensor_id in RADARS
    })
    lidars, radars = [], []
    for sensor in job["sensors"]:
        if sensor["type"] not in {"lidar", "radar"}:
            continue
        mount = sensor["mount"]
        position, rotation = mount["position"], mount["rotation"]
        base = {
            "sensorId": sensor["id"],
            "attach": {
                "actorId": "ego",
                "offsetM": [position["x"], position.get("z", 0), position["y"]],
                "yawDeg": math.degrees(rotation.get("yawRad", 0)),
            },
        }
        spec = authored[sensor["id"]]
        if sensor["type"] == "lidar":
            lidars.append(base | {
                "channels": 4,
                "rotationFrequencyHz": 10.0,
                "pointsPerSecond": 2560,
                "horizontalFovDeg": spec["horizontalFovDeg"],
                "verticalFovDeg": spec["verticalFovDeg"],
                "rangeM": 80.0,
            })
        else:
            radars.append(base | {
                "pointsPerSecond": 1280,
                "horizontalFovDeg": spec["horizontalFovDeg"],
                "verticalFovDeg": spec["verticalFovDeg"],
                "rangeM": 80.0,
            })
    return lidars, radars


def finalize_service_artifacts(job: dict, out: Path) -> dict:
    artifacts = [(sensor, "sensor-video", out / f"{sensor}.mp4") for sensor in CAMERAS]
    for sensor, suffix, parser in (
        [(sensor, "ply", lidar_points) for sensor in LIDARS]
        + [(sensor, "csv", radar_points) for sensor in RADARS]
    ):
        archive = out / f"{sensor}.zip"
        count = archive_stream(out / sensor, archive, suffix)
        if not count:
            continue
        viz = out / "viz" / sensor
        for index, source in enumerate(sorted((out / sensor).glob(f"*.{suffix}"))):
            draw_points(parser(source), viz / f"{index:08d}.ppm")
        video = out / f"{sensor}.mp4"
        encode_pngs(str(viz / "%08d.ppm"), video, job["fps"])
        artifacts.extend([(sensor, "sensor-video", video), (sensor, "sensor-archive", archive)])
    manifest = []
    for sensor, kind, path in artifacts:
        if not path.is_file():
            continue
        manifest.append({
            "sensorId": sensor,
            "kind": kind,
            "relativePath": path.name,
            "mediaType": "video/mp4" if path.suffix == ".mp4" else "application/zip",
            "sizeBytes": path.stat().st_size,
            "sha256": sha256(path),
        })
    expected = (
        {(sensor, "sensor-video") for sensor in CAMERAS + LIDARS + RADARS}
        | {(sensor, "sensor-archive") for sensor in LIDARS + RADARS}
    )
    actual = {(artifact["sensorId"], artifact["kind"]) for artifact in manifest}
    result = {
        "schema": "simforge.bevy-artifact-manifest/v1",
        "docId": job["docId"],
        "artifacts": manifest,
        "complete": actual == expected,
        "missing": sorted([list(value) for value in expected - actual]),
    }
    dump(out / "manifest.json", result)
    shutil.rmtree(out / "viz", ignore_errors=True)
    for sensor in LIDARS + RADARS:
        shutil.rmtree(out / sensor, ignore_errors=True)
    return result


def write_actor_visuals(job: dict, campaign_root: Path, out: Path) -> None:
    vehicle_entries = load(campaign_root / "catalog" / "vehicles-carla" / "catalog-models.json")["entries"]
    pedestrian_entries = load(campaign_root / "catalog" / "pedestrians-carla" / "catalog-models.json")["entries"]
    actors = []
    for actor in job["actors"]:
        catalog_id = actor.get("catalogId")
        actor_class = actor.get("class")
        if catalog_id in vehicle_entries:
            source, resolution = "glb", "exact"
        elif actor_class == "pedestrian" and pedestrian_entries:
            source = "glb"
            resolution = "exact" if catalog_id in pedestrian_entries else "deterministic"
        else:
            source, resolution = "cuboid", "unknown"
        actors.append({
            "actorId": "ego" if actor["id"] == job["subjectActorId"] else actor["id"],
            "catalogId": catalog_id,
            "actorClass": actor_class,
            "source": source,
            "resolution": resolution,
        })
    dump(out / "actor-visuals.json", {"docId": job["docId"], "actors": actors})




def render_service(args) -> None:
    client_root = Path(args.client_root)
    sys.path.insert(0, str(client_root))
    from simforge_native.client import NativeRenderClient

    job_path = Path(args.job)
    job = relocated_job(load(job_path), job_path)
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    frame_count = min(job["frameCount"], args.ticks) if args.ticks else job["frameCount"]
    campaign_root = Path(os.environ.get("SIMFORGE_BEVY_CAMPAIGN_ROOT", REMOTE_ROOT))
    vegetation, vegetation_budget = budget_vegetation(job)
    scene = {
        "glbs": job["corpusGlbs"], "vegGlbs": vegetation, "profile": "sensor",
        "profileConfig": {"cinematic": {"taa": True, "ssr": True, "ssao": True, "ssaoUltra": True}},
        "nearM": 0.05, "farM": 1000, "warmupFrames": 20,
        "vehicleModels": str(campaign_root / "catalog" / "vehicles-carla"),
        "pedestrianModels": str(campaign_root / "catalog" / "pedestrians-carla"),
    }
    scene_path, socket_path, shm_path = out / "service-scene.json", out / "renderer.sock", out / "frames.shm"
    dump(scene_path, scene)
    socket_path.unlink(missing_ok=True)
    shm_path.unlink(missing_ok=True)
    log_stream = (out / "renderer.log").open("w")
    service = subprocess.Popen([
        args.binary, "--scene", str(scene_path), "--socket", str(socket_path),
        "--shm", str(shm_path), "--shm-size-mb", "512",
    ], stdout=log_stream, stderr=subprocess.STDOUT, text=True)
    deadline = time.time() + 300
    while not socket_path.exists() and service.poll() is None and time.time() < deadline:
        time.sleep(0.1)
    if not socket_path.exists():
        raise RuntimeError("native-render-service did not become ready")
    client = NativeRenderClient(str(socket_path))
    states = load(Path(job["jobDir"]) / "scene-states.json")[:frame_count]
    response = client.load_scene_state(states)
    if not response.get("ok"):
        raise RuntimeError(f"load_scene_state failed: {response}")
    cameras = service_cameras(job)
    lidars, radars = service_range_sensors(job)
    for sensor in lidars + radars:
        (out / sensor["sensorId"]).mkdir(parents=True, exist_ok=True)
    encoders = {}
    for camera in cameras:
        path = out / f"{camera['sensorId']}.mp4"
        encoders[camera["sensorId"]] = subprocess.Popen([
            "ffmpeg", "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgba",
            "-s", f"{job['width']}x{job['height']}", "-r", str(job["fps"]), "-i", "pipe:0",
            "-c:v", "libx264", "-preset", "fast", "-crf", "18", "-pix_fmt", "yuv420p",
            "-movflags", "+faststart", str(path),
        ], stdin=subprocess.PIPE)
    samples, server_ms = [], []
    replay_digest = hashlib.sha256()
    started = time.time()
    try:
        for tick in range(frame_count):
            response = client.render_bundle(
                tick,
                cameras if tick == 0 else None,
                tick_index=tick,
                passes=["rgb"],
                lidars=lidars if tick == 0 else None,
                radars=radars if tick == 0 else None,
            )
            if not response.get("ok"):
                raise RuntimeError(f"render_bundle tick {tick} failed: {response}")
            server_ms.append(float(response["server_ms"]))
            for frame in sorted(response["frames"], key=lambda value: (value["sensorId"], value["pass"])):
                replay_digest.update(f"{tick}:{frame['sensorId']}:{frame['pass']}:{frame.get('digest','')}\\n".encode())
            for frame in response["frames"]:
                payload = client.read_record(frame)
                digest = f"{zlib.crc32(payload) & 0xffffffff:08x}"
                if digest != frame["digest"]:
                    raise RuntimeError(
                        f"CRC mismatch for {frame['sensorId']} tick {tick}: {digest} != {frame['digest']}"
                    )
                if frame["pass"] == "rgb":
                    encoders[frame["sensorId"]].stdin.write(payload)
                elif frame["pass"] in {"lidar", "radar"}:
                    suffix = "ply" if frame["pass"] == "lidar" else "csv"
                    (out / frame["sensorId"] / f"{tick:08d}.{suffix}").write_bytes(payload)
            if tick % 12 == 0:
                sample = subprocess.run(["nvidia-smi", "--query-gpu=utilization.gpu,memory.used", "--format=csv,noheader,nounits"],
                                        text=True, capture_output=True)
                if sample.returncode == 0:
                    samples.append([int(v.strip()) for v in sample.stdout.strip().split(",")])
    finally:
        for encoder in encoders.values():
            if encoder.stdin:
                encoder.stdin.close()
            encoder.wait()
        client.close()
        if service.poll() is None:
            service.terminate()
        service.wait(timeout=30)
        log_stream.close()
        socket_path.unlink(missing_ok=True)
        shm_path.unlink(missing_ok=True)
    wall = time.time() - started
    manifest = finalize_service_artifacts(job, out)
    benchmark = {
        "docId": job["docId"], "wallS": wall, "fps": frame_count / wall,
        "serverFrameMsMean": statistics.fmean(server_ms), "serverFrameMsP95": percentile(server_ms, .95),
        "gpuUtilMeanPct": statistics.fmean(s[0] for s in samples) if samples else None,
        "gpuUtilP95Pct": percentile([s[0] for s in samples], .95),
        "vramMaxMiB": max((s[1] for s in samples), default=None),
        "vramP50MiB": percentile([s[1] for s in samples], .5),
        "vramP95MiB": percentile([s[1] for s in samples], .95),
        "vegetationBudget": vegetation_budget,
        "replayDigest": replay_digest.hexdigest(),
        "coverage": video_coverage(out / "chase-cam-trailing.mp4"),
        "artifactCount": len(manifest["artifacts"]),
        "artifactComplete": manifest["complete"],
    }
    write_actor_visuals(job, campaign_root, out)
    dump(out / "benchmark.json", benchmark)
    print(json.dumps(benchmark))


def render_playback(args) -> None:
    job_path = Path(args.job)
    job = relocated_job(load(job_path), job_path)
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    frame_count = min(job["frameCount"], args.ticks) if args.ticks else job["frameCount"]
    initial_y = load(Path(job["jobDir"]) / "scene-playback.json")["frames"][0]["actors"][0]["position"][1]
    cmd = [args.binary, "--glbs", ",".join(job["corpusGlbs"]), "--scene-state", str(Path(job["jobDir"]) / "scene-playback.json"),
           "--ticks", str(frame_count), "--width", str(job["width"]), "--height", str(job["height"]),
           "--fov", str(job["chase"]["camera"]["verticalFovDeg"]), "--warmup", "20", "--ground-y", str(initial_y),
           "--camera", "follow", "--chase-dist", "8.6", "--chase-height", "3.2", "--out-dir", str(out),
           "--vehicle-models", job["vehicleModels"]]
    started = time.time()
    samples = []
    process = subprocess.Popen(cmd, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    while process.poll() is None:
        sample = subprocess.run(["nvidia-smi", "--query-gpu=utilization.gpu,memory.used", "--format=csv,noheader,nounits"],
                                text=True, capture_output=True)
        if sample.returncode == 0:
            try:
                samples.append([int(v.strip()) for v in sample.stdout.strip().split(",")])
            except ValueError:
                pass
        time.sleep(1)
    log = process.stdout.read() if process.stdout else ""
    (out / "renderer.log").write_text(log)
    if process.returncode:
        raise SystemExit(f"renderer exited {process.returncode}")
    wall = time.time() - started
    benchmark = {"docId": job["docId"], "wallS": wall, "fps": frame_count / wall,
                 "gpuUtilMeanPct": statistics.fmean(s[0] for s in samples) if samples else None,
                 "gpuUtilMaxPct": max((s[0] for s in samples), default=None),
                 "vramMaxMiB": max((s[1] for s in samples), default=None)}
    video_path = out / "chase-cam-trailing.mp4"
    encode_pngs(str(out / "frame-%04d.rgb.png"), video_path, job["fps"])
    benchmark["coverage"] = video_coverage(video_path)
    dump(out / "benchmark.json", benchmark)
    print(json.dumps(benchmark))

def render_shard(args) -> None:
    shard = load(Path(args.shard))
    failures, retries = [], []
    for doc_id in shard["documents"]:
        job = Path(args.jobs) / doc_id / "job.json"
        output = Path(args.out) / doc_id
        last_error = None
        for attempt in range(2):
            try:
                render_service(argparse.Namespace(job=str(job), binary=args.binary, client_root=args.client_root, out=str(output), ticks=args.ticks))
                if attempt:
                    retries.append({"docId": doc_id, "attempts": attempt + 1})
                last_error = None
                break
            except (Exception, SystemExit) as error:
                last_error = str(error)
        if last_error is not None:
            failures.append({"docId": doc_id, "cause": last_error, "attempts": 2})
    dump(Path(args.out) / "shard-results.json", {
        "host": shard.get("host"), "documents": len(shard["documents"]), "failures": failures,
        "retries": retries,
    })
    if failures:
        raise SystemExit(f"{len(failures)} shard documents failed")



def deploy(args) -> None:
    repo, parity = Path(args.repo), Path(args.parity)
    for host in HOSTS if not args.host else [args.host]:
        run(["ssh", f"root@{host}", f"mkdir -p {REMOTE_ROOT}/bin {REMOTE_ROOT}/corpus {REMOTE_ROOT}/catalog {REMOTE_ROOT}/jobs {REMOTE_ROOT}/outputs"])
        run(["rsync", "-a", "--checksum", args.binary, f"root@{host}:{REMOTE_ROOT}/bin/native-render-service"])
        run(["rsync", "-a", "--checksum", str(repo / "renderer/service/python/simforge_native") + "/", f"root@{host}:{REMOTE_ROOT}/bin/simforge_native/"])
        run(["rsync", "-a", "--checksum", str(repo / "scripts/bevy-campaign-parity.py"), f"root@{host}:{REMOTE_ROOT}/bin/bevy-campaign-parity.py"])
        run(["rsync", "-a", "--checksum", str(repo / "catalog/vehicles-carla") + "/", f"root@{host}:{REMOTE_ROOT}/catalog/vehicles-carla/"])
        run(["rsync", "-a", "--checksum", str(repo / "catalog/pedestrians-carla") + "/", f"root@{host}:{REMOTE_ROOT}/catalog/pedestrians-carla/"])
        run(["rsync", "-a", "--checksum", str(repo / ".corpus/belmont-research-center") + "/", f"root@{host}:{REMOTE_ROOT}/corpus/belmont-research-center/"])
        run(["rsync", "-a", "--checksum", str(repo / ".corpus/richmond-field-station") + "/", f"root@{host}:{REMOTE_ROOT}/corpus/richmond-field-station/"])
        run(["rsync", "-a", "--checksum", str(parity / "jobs") + "/", f"root@{host}:{REMOTE_ROOT}/jobs/"])
        if args.image_archive:
            archive = Path(args.image_archive)
            remote_archive = f"{REMOTE_ROOT}/{archive.name}"
            run(["rsync", "-a", "--checksum", str(archive), f"root@{host}:{remote_archive}"])
            run(["ssh", f"root@{host}", f"docker load --input {remote_archive} >/dev/null"])
        run(["rsync", "-a", str(parity / "shards" / f"{host}.json"), f"root@{host}:{REMOTE_ROOT}/shard.json"])
        print(json.dumps({"host": host, "deployed": True}))


def fleet(args) -> None:
    hosts = HOSTS if not args.host else [args.host]
    def execute(host: str) -> tuple[str, int, str]:
        remote = (
            f"SIMFORGE_BEVY_CAMPAIGN_ROOT={REMOTE_ROOT} "
            f"python3 {REMOTE_ROOT}/bin/bevy-campaign-parity.py render-shard "
            f"--shard {REMOTE_ROOT}/shard.json --jobs {REMOTE_ROOT}/jobs "
            f"--binary {REMOTE_ROOT}/bin/native-render-service --client-root {REMOTE_ROOT}/bin "
            f"--out {REMOTE_ROOT}/outputs"
        )
        result = subprocess.run(["ssh", f"root@{host}", remote], text=True, capture_output=True)
        return host, result.returncode, result.stdout + result.stderr
    failures = []
    with ThreadPoolExecutor(max_workers=len(hosts)) as pool:
        for host, code, log in pool.map(execute, hosts):
            Path(args.parity, "fleet-logs").mkdir(parents=True, exist_ok=True)
            Path(args.parity, "fleet-logs", f"{host}.log").write_text(log)
            run(["rsync", "-a", f"root@{host}:{REMOTE_ROOT}/outputs/", str(Path(args.parity) / "bevy") + "/"])
            if code:
                failures.append(host)
    if failures:
        raise SystemExit("fleet failures: " + ", ".join(failures))


def compose(args) -> None:
    root, campaign = Path(args.parity), Path(args.campaign)
    inventory_doc = load(root / "campaign-inventory.json"); sxs = root / "sxs"; grids = root / "grids"
    sxs.mkdir(parents=True, exist_ok=True); grids.mkdir(parents=True, exist_ok=True)
    for row in inventory_doc["documents"]:
        doc_id = row["docId"]; left = Path(row["video"]["path"]) if row["video"]["path"] else None
        right = root / "bevy" / doc_id / "chase-cam-trailing.mp4"
        if not left or not left.is_file() or not right.is_file():
            continue
        run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(left), "-i", str(right), "-filter_complex",
             "[0:v]scale=1280:720,fps=24[l];[1:v]scale=1280:720,fps=24[r];[l][r]hstack=inputs=2[v]",
             "-map", "[v]", "-t", "20", "-c:v", "libx264", "-crf", "20", "-preset", "fast", "-pix_fmt", "yuv420p", str(sxs / f"{doc_id}.mp4")])
        times = [1, 4, 7, 10, 14, 18]
        filters = []
        inputs = []
        for index, t in enumerate(times):
            inputs += ["-ss", str(t), "-i", str(sxs / f"{doc_id}.mp4")]
            filters.append(f"[{index}:v]scale=960:270[v{index}]")
        graph = ";".join(filters) + ";[v0][v1][v2]hstack=3[top];[v3][v4][v5]hstack=3[bot];[top][bot]vstack=2[out]"
        run(["ffmpeg", "-y", "-loglevel", "error", *inputs, "-filter_complex", graph, "-map", "[out]", "-frames:v", "1", "-q:v", "2", str(grids / f"{doc_id}.jpg")])
    print(json.dumps({"sxs": len(list(sxs.glob("*.mp4"))), "grids": len(list(grids.glob("*.jpg")))}))


def scorecard(args) -> None:
    root = Path(args.parity); inventory_doc = load(root / "campaign-inventory.json")
    rows, bevy_times, carla_times = [], [], []
    for item in inventory_doc["documents"]:
        doc = item["docId"]; benchmark_path = root / "bevy" / doc / "benchmark.json"
        benchmark = load(benchmark_path) if benchmark_path.exists() else {}
        manifest_path = root / "bevy" / doc / "manifest.json"
        manifest = load(manifest_path) if manifest_path.exists() else {}
        wall = benchmark.get("wallS"); carla = item.get("carlaA100RenderS")
        if wall: bevy_times.append(float(wall))
        if carla:
            carla_times.append(float(carla))
        model_report = root / "bevy" / doc / "actor-visuals.json"
        exact = "unavailable"
        if model_report.exists():
            report = load(model_report)
            values = report.get("actors", [])
            exact = sum(a.get("source") == "glb" for a in values) / len(values) if values else "unavailable"
        visual_path = root / "visual-scores" / f"{doc}.json"
        visual = load(visual_path) if visual_path.exists() else {}
        rows.append((
            doc, item["mapId"], "yes" if manifest.get("complete") else "no", wall, benchmark.get("fps"),
            benchmark.get("gpuUtilMeanPct"), benchmark.get("vramMaxMiB"), carla, exact,
            visual.get("materials", "unreviewed"), visual.get("lighting", "unreviewed"),
            visual.get("roadDetail", "unreviewed"), visual.get("framing", "unreviewed"),
            visual.get("gap", "visual review pending"),
        ))
    lines = ["# Bevy/CARLA parity scorecard", "", "Scores below are evidence-backed mechanical proxies; no unperformed human visual review is claimed.", "",
             "## Benchmark summary", "",
             f"- Bevy RTX 3080 wall time: n={len(bevy_times)}, p50={percentile(bevy_times,.5)}, p95={percentile(bevy_times,.95)} seconds.",
             f"- CARLA A100 wall time: n={len(carla_times)}, p50={percentile(carla_times,.5)}, p95={percentile(carla_times,.95)} seconds.", "",
             "## Per-document evidence", "",
             "| doc | map | artifact parity | Bevy wall s | fps | GPU util % | VRAM MiB | CARLA A100 s | actor model correctness | materials | lighting | road detail | framing | worst gap |",
             "|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|"]
    for row in rows:
        lines.append("| " + " | ".join("" if v is None else f"{v:.3f}" if isinstance(v, float) else str(v) for v in row) + " |")
    incomplete = [r[0] for r in rows if r[2] != "yes"]
    lines += ["", "## Honest gap list", "", f"- Artifact-incomplete documents ({len(incomplete)}): " + (", ".join(incomplete) if incomplete else "none"),
              "- Materials, lighting, road detail, and framing require review of the saved 3x2 grids; this harness does not manufacture subjective ratings.",
              "- Worst-gap ordering is artifact-incomplete first, then lowest exact actor-GLB ratio, then slowest Bevy wall time."]
    (root / "scorecard.md").write_text("\n".join(lines) + "\n")
    print(json.dumps({"documents": len(rows), "complete": len(rows) - len(incomplete)}))


def parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(); sub = p.add_subparsers(dest="command", required=True)
    q = sub.add_parser("inventory"); q.add_argument("--campaign", required=True); q.add_argument("--repo", required=True); q.add_argument("--out", required=True); q.set_defaults(func=inventory)
    q = sub.add_parser("prepare"); q.add_argument("--campaign", required=True); q.add_argument("--repo", required=True); q.add_argument("--out", required=True); q.set_defaults(func=prepare)
    q = sub.add_parser("assemble"); q.add_argument("--job", required=True); q.add_argument("--raw", required=True); q.add_argument("--out", required=True); q.set_defaults(func=assemble)
    q = sub.add_parser("render-playback"); q.add_argument("--job", required=True); q.add_argument("--binary", required=True); q.add_argument("--out", required=True); q.add_argument("--ticks", type=int); q.set_defaults(func=render_playback)
    q = sub.add_parser("render-service"); q.add_argument("--job", required=True); q.add_argument("--binary", required=True); q.add_argument("--client-root", required=True); q.add_argument("--out", required=True); q.add_argument("--ticks", type=int); q.set_defaults(func=render_service)
    q = sub.add_parser("render-shard"); q.add_argument("--shard", required=True); q.add_argument("--jobs", required=True); q.add_argument("--binary", required=True); q.add_argument("--client-root", required=True); q.add_argument("--out", required=True); q.add_argument("--ticks", type=int); q.set_defaults(func=render_shard)
    q = sub.add_parser("deploy"); q.add_argument("--repo", required=True); q.add_argument("--parity", required=True); q.add_argument("--binary", required=True); q.add_argument("--image-archive"); q.add_argument("--host"); q.set_defaults(func=deploy)
    q = sub.add_parser("fleet"); q.add_argument("--parity", required=True); q.add_argument("--image", default="simforge/bevy-campaign-runner:final"); q.add_argument("--host"); q.set_defaults(func=fleet)
    q = sub.add_parser("compose"); q.add_argument("--campaign", required=True); q.add_argument("--parity", required=True); q.set_defaults(func=compose)
    q = sub.add_parser("scorecard"); q.add_argument("--parity", required=True); q.set_defaults(func=scorecard)
    return p


if __name__ == "__main__":
    ns = parser().parse_args()
    ns.func(ns)
