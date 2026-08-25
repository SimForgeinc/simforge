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
import subprocess
import sys
import time
import zipfile

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


def inventory(args) -> None:
    campaign, repo, out = Path(args.campaign), Path(args.repo), Path(args.out)
    jobs = campaign_job_map(campaign)
    ledger = load(campaign / "ledger.json")
    rows = []
    for selected in load(campaign / "selection.json"):
        doc_id = selected["docId"]
        scenario = load(campaign / "transformed" / f"{doc_id}.json")
        subject, sensors = scenario_sensors(scenario)
        video = carla_video(campaign, doc_id, jobs)
        spec = ffprobe(video) if video else {}
        record = ledger.get("documents", {}).get(doc_id, {})
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
            "carlaA100RenderS": times[-1] if times else (record.get("renderS") if record.get("lane") == "carla" else None),
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
        job = {"schema": "simforge.bevy-campaign-job/v1", **row, "fps": FPS, "width": WIDTH, "height": HEIGHT,
               "frameCount": len(states), "corpusGlbs": corpus_glbs(repo, map_id),
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
    moved["corpusGlbs"] = []
    for value in job["corpusGlbs"]:
        path = Path(value)
        if ".corpus" not in path.parts:
            moved["corpusGlbs"].append(value)
            continue
        corpus_index = path.parts.index(".corpus")
        moved["corpusGlbs"].append(str(root / "corpus" / Path(*path.parts[corpus_index + 1:])))
    moved["vehicleModels"] = str(root / "catalog" / "vehicles-carla")
    return moved


def render_playback(args) -> None:
    job_path = Path(args.job)
    job = relocated_job(load(job_path), job_path)
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    initial_y = load(Path(job["jobDir"]) / "scene-playback.json")["frames"][0]["actors"][0]["position"][1]
    cmd = [args.binary, "--glbs", ",".join(job["corpusGlbs"]), "--scene-state", str(Path(job["jobDir"]) / "scene-playback.json"),
           "--ticks", str(job["frameCount"]), "--width", str(job["width"]), "--height", str(job["height"]),
           "--fov", str(job["chase"]["camera"]["verticalFovDeg"]), "--warmup", "20", "--ground-y", str(initial_y),
           "--camera", "follow", "--chase-dist", "8.6", "--chase-height", "3.2", "--out-dir", str(out),
           "--vehicle-models", job["vehicleModels"]]
    started = time.time(); samples = []
    process = subprocess.Popen(cmd, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    while process.poll() is None:
        sample = subprocess.run(["nvidia-smi", "--query-gpu=utilization.gpu,memory.used", "--format=csv,noheader,nounits"],
                                text=True, capture_output=True)
        if sample.returncode == 0:
            try: samples.append([int(v.strip()) for v in sample.stdout.strip().split(",")])
            except ValueError: pass
        time.sleep(1)
    log = process.stdout.read() if process.stdout else ""
    (out / "renderer.log").write_text(log)
    if process.returncode:
        raise SystemExit(f"renderer exited {process.returncode}")
    wall = time.time() - started
    benchmark = {"docId": job["docId"], "wallS": wall, "fps": job["frameCount"] / wall,
                 "gpuUtilMeanPct": statistics.fmean(s[0] for s in samples) if samples else None,
                 "gpuUtilMaxPct": max((s[0] for s in samples), default=None),
                 "vramMaxMiB": max((s[1] for s in samples), default=None)}
    dump(out / "benchmark.json", benchmark)
    encode_pngs(str(out / "frame-%04d.rgb.png"), out / "chase-cam-trailing.mp4", job["fps"])
    print(json.dumps(benchmark))

def render_shard(args) -> None:
    shard = load(Path(args.shard))
    failures = []
    for doc_id in shard["documents"]:
        job = Path(args.jobs) / doc_id / "job.json"
        output = Path(args.out) / doc_id
        try:
            render_playback(argparse.Namespace(job=str(job), binary=args.binary, out=str(output)))
        except (Exception, SystemExit) as error:
            failures.append({"docId": doc_id, "cause": str(error)})
    dump(Path(args.out) / "shard-results.json", {
        "host": shard.get("host"), "documents": len(shard["documents"]), "failures": failures,
    })
    if failures:
        raise SystemExit(f"{len(failures)} shard documents failed")




def deploy(args) -> None:
    repo, parity = Path(args.repo), Path(args.parity)
    for host in HOSTS if not args.host else [args.host]:
        run(["ssh", f"root@{host}", f"mkdir -p {REMOTE_ROOT}/bin {REMOTE_ROOT}/corpus {REMOTE_ROOT}/catalog {REMOTE_ROOT}/jobs {REMOTE_ROOT}/outputs"])
        run(["rsync", "-a", "--checksum", args.binary, f"root@{host}:{REMOTE_ROOT}/bin/scen-play"])
        run(["rsync", "-a", "--checksum", str(repo / "scripts/bevy-campaign-parity.py"), f"root@{host}:{REMOTE_ROOT}/bin/"])
        run(["rsync", "-a", "--checksum", str(repo / "catalog/vehicles-carla") + "/", f"root@{host}:{REMOTE_ROOT}/catalog/vehicles-carla/"])
        run(["rsync", "-a", "--checksum", str(repo / ".corpus/belmont-research-center") + "/", f"root@{host}:{REMOTE_ROOT}/corpus/belmont-research-center/"])
        run(["rsync", "-a", "--checksum", str(repo / ".corpus/richmond-field-station") + "/", f"root@{host}:{REMOTE_ROOT}/corpus/richmond-field-station/"])
        run(["rsync", "-a", "--checksum", str(parity / "jobs") + "/", f"root@{host}:{REMOTE_ROOT}/jobs/"])
        run(["rsync", "-a", str(parity / "shards" / f"{host}.json"), f"root@{host}:{REMOTE_ROOT}/shard.json"])
        print(json.dumps({"host": host, "deployed": True}))


def fleet(args) -> None:
    hosts = HOSTS if not args.host else [args.host]
    def execute(host: str) -> tuple[str, int, str]:
        remote = (
            f"SIMFORGE_BEVY_CAMPAIGN_ROOT={REMOTE_ROOT} python3 {REMOTE_ROOT}/bin/bevy-campaign-parity.py "
            f"render-shard --shard {REMOTE_ROOT}/shard.json --jobs {REMOTE_ROOT}/jobs "
            f"--binary {REMOTE_ROOT}/bin/scen-play --out {REMOTE_ROOT}/outputs"
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
        if carla: carla_times.append(float(carla))
        model_report = root / "bevy" / doc / "actor-visuals.json"
        exact = None
        if model_report.exists():
            report = load(model_report); values = report.get("actors", [])
            exact = sum(a.get("source") == "glb" for a in values) / len(values) if values else None
        rows.append((doc, item["mapId"], "yes" if manifest.get("complete") else "no", wall, benchmark.get("fps"),
                     benchmark.get("gpuUtilMeanPct"), benchmark.get("vramMaxMiB"), carla, exact))
    lines = ["# Bevy/CARLA parity scorecard", "", "Scores below are evidence-backed mechanical proxies; no unperformed human visual review is claimed.", "",
             "## Benchmark summary", "",
             f"- Bevy RTX 3080 wall time: n={len(bevy_times)}, p50={percentile(bevy_times,.5)}, p95={percentile(bevy_times,.95)} seconds.",
             f"- CARLA A100 wall time: n={len(carla_times)}, p50={percentile(carla_times,.5)}, p95={percentile(carla_times,.95)} seconds.", "",
             "## Per-document evidence", "",
             "| doc | map | artifact parity | Bevy wall s | fps | GPU util % | VRAM MiB | CARLA A100 s | exact actor GLB ratio |",
             "|---|---|---:|---:|---:|---:|---:|---:|---:|"]
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
    q = sub.add_parser("render-playback"); q.add_argument("--job", required=True); q.add_argument("--binary", required=True); q.add_argument("--out", required=True); q.set_defaults(func=render_playback)
    q = sub.add_parser("render-shard"); q.add_argument("--shard", required=True); q.add_argument("--jobs", required=True); q.add_argument("--binary", required=True); q.add_argument("--out", required=True); q.set_defaults(func=render_shard)
    q = sub.add_parser("deploy"); q.add_argument("--repo", required=True); q.add_argument("--parity", required=True); q.add_argument("--binary", required=True); q.add_argument("--host"); q.set_defaults(func=deploy)
    q = sub.add_parser("fleet"); q.add_argument("--parity", required=True); q.add_argument("--host"); q.set_defaults(func=fleet)
    q = sub.add_parser("compose"); q.add_argument("--campaign", required=True); q.add_argument("--parity", required=True); q.set_defaults(func=compose)
    q = sub.add_parser("scorecard"); q.add_argument("--parity", required=True); q.set_defaults(func=scorecard)
    return p


if __name__ == "__main__":
    ns = parser().parse_args()
    ns.func(ns)
