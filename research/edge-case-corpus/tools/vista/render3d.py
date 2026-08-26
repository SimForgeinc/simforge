#!/usr/bin/env python3
"""
WS-3 3D video renderer for the SimForge-vista edge-case corpus.

Renders each corpus scenario as an H.264 MP4 *from the real SimForge 3D
world* (studio + viewer, three.js) by driving the Studio dev server
in Chrome through scripts/export-render.mjs (playwright-core).

It does not reimplement any renderer. It is a batch driver:
  * resolves instance/trace/result triplets from a dataset .jsonl (or a scan of
    /tmp/vista-harv-deliver),
  * runs scripts/export-render.mjs --evidence-class corpus once per scenario,
  * reads the manifest each run writes and records its integrity verdict,
  * writes/updates INDEX.json incrementally after every scenario so a killed
    run keeps everything it already produced.

PREREQUISITE - the Studio dev server must already be running, started ONCE:
    pnpm --filter @simforge-oss/studio dev --host 127.0.0.1 --port 5199

Usage:
    python3 render3d.py --records /tmp/vista-dataset-all/train.jsonl \
                        --records /tmp/vista-dataset-all/test.jsonl \
                        --out /tmp/vista-3d --concurrency 4

    python3 render3d.py --instance <path>.instance.json --out /tmp/vista-3d

INDEX.json shape (matches what audit.py consumes):
    {"generatedAt":..., "records":[{"scenarioId","mp4","integrity":{...}}, ...]}
"""
from __future__ import annotations

import argparse
import collections
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

REPO = Path(__file__).resolve().parents[4]
EXPORTER = REPO / "scripts" / "export-render.mjs"
DEFAULT_URL = "http://127.0.0.1:5199"

_index_lock = threading.Lock()


# --------------------------------------------------------------------------- inputs
def load_records(record_files: list[Path], scan_root: Path | None) -> list[dict]:
    """Dataset .jsonl records win; a directory scan is the fallback."""
    out: list[dict] = []
    seen: set[str] = set()
    for file in record_files:
        with file.open() as handle:
            for line in handle:
                line = line.strip()
                if not line:
                    continue
                rec = json.loads(line)
                key = rec["scenarioId"]
                if key in seen:
                    continue
                seen.add(key)
                out.append({
                    "scenarioId": key,
                    "archetypeId": rec.get("archetypeId"),
                    "mapId": rec.get("mapId"),
                    "siteId": rec.get("siteId"),
                    "split": file.stem,
                    "instance": rec["instance"],
                })
    if scan_root is not None:
        for instance in sorted(scan_root.rglob("draw-*.instance.json")):
            parts = instance.relative_to(scan_root).parts
            key = f"{parts[2]}#{instance.name.split('.')[0].split('-')[1]}"
            if key in seen:
                continue
            seen.add(key)
            out.append({
                "scenarioId": key,
                "archetypeId": parts[0],
                "mapId": parts[1],
                "siteId": parts[2],
                "split": "scan",
                "instance": str(instance),
            })
    return out


def triplet(instance: str) -> tuple[Path, Path, Path]:
    base = str(instance)[: -len(".instance.json")]
    return Path(instance), Path(base + ".trace.json.gz"), Path(base + ".result.json")


# --------------------------------------------------------------------------- errors
ANSI = re.compile(r"\x1b\[[0-9;]*m|\[[0-9]{1,3}m")

FAILURE_KINDS = (
    ("upstream-artifact-hash-mismatch", re.compile(r"evidence integrity failed")),
    ("composition-occluded", re.compile(r"incident composition failed")),
    ("camera-clearance", re.compile(r"camera intersects actor clearance")),
    ("preflight-rejected", re.compile(r"scenario render preflight rejected")),
    ("browser-diagnostics", re.compile(r"browser-diagnostics-empty")),
    ("evidence-gate-rejected", re.compile(r"scenario visual evidence rejected")),
    ("quality-preference", re.compile(r"render-quality preference is")),
    ("map-mismatch", re.compile(r"Studio loaded map")),
    ("playwright-timeout", re.compile(r"TimeoutError|Timeout \d+ms exceeded")),
    ("studio-unreachable", re.compile(r"net::ERR_|ECONNREFUSED")),
    ("ffmpeg", re.compile(r"encoded video mismatch|ffmpeg")),
)


def extract_error(log_text: str) -> tuple[str, str]:
    """Return (failureKind, one-line error message) from an exporter log.

    The exporter prints thousands of `[progress]` lines, so a raw tail is
    useless for auditing. Pull the actual thrown `Error:` line out and bucket
    it, and keep the buckets stable so a partial corpus can be grouped.
    """
    text = ANSI.sub("", log_text)
    thrown = re.findall(r"^\s*(?:Uncaught )?Error: .*$", text, re.M)
    message = thrown[-1].strip() if thrown else text.strip().splitlines()[-1][:400] if text.strip() else "no output"
    for kind, pattern in FAILURE_KINDS:
        if pattern.search(message) or pattern.search(text[-4000:]):
            return kind, message[:600]
    return "unknown", message[:600]


# --------------------------------------------------------------------------- render
def render_one(rec: dict, out_root: Path, url: str, quality: str, fps: int,
               width: int, height: int, timeout_s: int, force: bool,
               camera_search: bool = True) -> dict:
    instance, trace, result = triplet(rec["instance"])
    scenario_out = out_root / rec["scenarioId"]
    manifest_file = scenario_out / "manifest.json"
    log_file = out_root / "_logs" / f"{rec['scenarioId']}.log"
    log_file.parent.mkdir(parents=True, exist_ok=True)

    entry = {
        "scenarioId": rec["scenarioId"],
        "archetypeId": rec.get("archetypeId"),
        "mapId": rec.get("mapId"),
        "siteId": rec.get("siteId"),
        "split": rec.get("split"),
        "instance": str(instance),
        "mp4": None,
        "manifest": None,
        "integrity": None,
        "status": "pending",
        "failureKind": None,
        "error": None,
        "log": str(log_file),
        "seconds": None,
    }

    for path in (instance, trace, result):
        if not path.exists():
            entry.update(status="missing-input", failureKind="missing-input",
                         error=f"missing {path}")
            return entry

    if manifest_file.exists() and not force:
        return finalise(entry, manifest_file, scenario_out, 0.0)

    shutil.rmtree(scenario_out, ignore_errors=True)
    cmd = [
        "node", str(EXPORTER),
        "--url", url,
        "--instance", str(instance),
        "--trace", str(trace),
        "--result", str(result),
        "--out", str(scenario_out),
        "--headless",
        "--fps", str(fps),
        "--width", str(width),
        "--height", str(height),
        "--evidence-class", "corpus",
        "--quality", quality,
        "--pin-page",
        "--progress",
        # The analytic camera solvers aim along the incident sightline, which on
        # a real city map is often occupied by a building. Without the search a
        # third of the corpus is (correctly) rejected by the composition gate.
        *(["--camera-search"] if camera_search else []),
    ]
    started = time.time()
    with log_file.open("w") as log:
        log.write(" ".join(cmd) + "\n")
        log.flush()
        try:
            proc = subprocess.run(cmd, cwd=REPO, stdout=log, stderr=subprocess.STDOUT,
                                  timeout=timeout_s)
            code = proc.returncode
        except subprocess.TimeoutExpired:
            entry.update(status="timeout", failureKind="driver-timeout",
                         error=f"exporter exceeded {timeout_s}s",
                         seconds=round(time.time() - started, 2))
            record_failure(scenario_out, entry)
            return entry
    elapsed = round(time.time() - started, 2)
    if code != 0 or not manifest_file.exists():
        kind, message = extract_error(log_file.read_text())
        entry.update(status="render-failed", failureKind=kind,
                     error=f"exit {code}: {message}", seconds=elapsed)
        record_failure(scenario_out, entry)
        return entry
    return finalise(entry, manifest_file, scenario_out, elapsed)


def record_failure(scenario_out: Path, entry: dict) -> None:
    """A failed scenario keeps a readable error next to whatever it did write."""
    try:
        scenario_out.mkdir(parents=True, exist_ok=True)
        (scenario_out / "error.json").write_text(json.dumps({
            "scenarioId": entry["scenarioId"],
            "status": entry["status"],
            "failureKind": entry.get("failureKind"),
            "error": entry.get("error"),
            "seconds": entry.get("seconds"),
            "log": entry.get("log"),
        }, indent=2) + "\n")
    except OSError:
        pass


def finalise(entry: dict, manifest_file: Path, scenario_out: Path, elapsed: float | None) -> dict:
    manifest = json.loads(manifest_file.read_text())
    integrity = dict(manifest.get("integrity") or {})
    assessment = manifest.get("machineAssessment") or {}
    video = manifest.get("video") or {}
    mp4 = scenario_out / video.get("file", "video.mp4")
    integrity.update({
        # audit.py accepts either spelling for the instance/trace hash gates.
        "instanceHashMatches": integrity.get("instanceInputHashMatches"),
        "manifestInputHashMatches": integrity.get("instanceInputHashMatches"),
        "traceHashMatches": integrity.get("traceInputHashMatches"),
        "machineVerdict": assessment.get("verdict"),
        "failedGates": [g["id"] for g in assessment.get("gates", []) if g.get("status") != "pass"],
        "manifestScenarioId": manifest.get("scenarioId"),
        "inputHash": manifest.get("inputHash"),
        "traceDigest": manifest.get("traceDigest"),
        "videoSha256": video.get("sha256"),
        "videoFrameCount": video.get("frameCount"),
        "videoFps": video.get("fps"),
        "videoDurationSeconds": video.get("durationSeconds"),
        "resultBinding": (manifest.get("resultBinding") or {}).get("mode"),
    })
    passed = (
        integrity.get("instanceInputHashMatches") is True
        and integrity.get("traceInputHashMatches") is True
        and integrity.get("mapIdsExactMatch") is True
        and integrity.get("actorIdsExactMatch") is True
        and assessment.get("verdict") == "pass"
        and mp4.exists()
    )
    integrity["pass"] = passed
    entry.update({
        "mp4": str(mp4) if mp4.exists() else None,
        "manifest": str(manifest_file),
        "integrity": integrity,
        "status": "ok" if passed else "integrity-failed",
        "failureKind": None if passed else "integrity-failed",
        "error": None if passed else f"failed gates: {integrity['failedGates']}",
    })
    if elapsed is not None:
        entry["seconds"] = elapsed
    if not passed:
        record_failure(scenario_out, entry)
    return entry


# --------------------------------------------------------------------------- index
def write_index(index_file: Path, entries: dict, meta: dict) -> None:
    """INDEX.json is a bare JSON ARRAY of entries.

    audit.py does `ent = json.load(open(idx))` then `for e in ent`, so a
    top-level object would silently iterate its keys and report zero coverage.
    Run metadata therefore goes to INDEX-meta.json next to it.
    """
    records = [entries[k] for k in sorted(entries)]
    ok = [r for r in records if r["status"] == "ok"]
    tmp = index_file.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(records, indent=2) + "\n")
    tmp.replace(index_file)

    meta_file = index_file.parent / "INDEX-meta.json"
    durations = sorted(r["seconds"] for r in ok if r["seconds"])
    meta_tmp = meta_file.with_suffix(".json.tmp")
    meta_tmp.write_text(json.dumps({
        "schema": "uniscenarios.vista.3d-video-index-meta.v1",
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "renderer": "studio 3D world (viewer/three.js) via scripts/export-render.mjs",
        **meta,
        "summary": {
            "total": len(records),
            "ok": len(ok),
            "failed": len(records) - len(ok),
            "successRate": round(len(ok) / len(records), 4) if records else None,
            "medianSecondsPerScenario": durations[len(durations) // 2] if durations else None,
            "failureKinds": dict(sorted(collections.Counter(
                r.get("failureKind") for r in records if r["status"] != "ok"
            ).items(), key=lambda kv: -kv[1])),
            "failuresByArchetype": dict(sorted(collections.Counter(
                r.get("archetypeId") for r in records if r["status"] != "ok"
            ).items(), key=lambda kv: -kv[1])),
        },
    }, indent=2) + "\n")
    meta_tmp.replace(meta_file)


# --------------------------------------------------------------------------- main
def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--records", action="append", type=Path, default=[],
                    help="dataset .jsonl (repeatable); e.g. /tmp/vista-dataset-all/train.jsonl")
    ap.add_argument("--scan", type=Path, default=None,
                    help="fallback: scan a harvest root for draw-*.instance.json")
    ap.add_argument("--instance", type=Path, default=None, help="render a single instance.json")
    ap.add_argument("--out", type=Path, default=Path("/tmp/vista-3d"))
    ap.add_argument("--url", default=DEFAULT_URL)
    ap.add_argument("--quality", default="minimal",
                    help="studio render-quality preset seeded into localStorage (default: minimal)")
    ap.add_argument("--fps", type=int, default=12)
    ap.add_argument("--width", type=int, default=1600, help="browser viewport width")
    ap.add_argument("--height", type=int, default=960, help="browser viewport height")
    ap.add_argument("--concurrency", type=int, default=4)
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--timeout", type=int, default=900, help="per-scenario exporter timeout (s)")
    ap.add_argument("--force", action="store_true", help="re-render even if manifest.json exists")
    ap.add_argument("--no-camera-search", dest="camera_search", action="store_false",
                    help="disable the occlusion-aware camera orbit search (on by default)")
    ap.set_defaults(camera_search=True)
    ap.add_argument("--reindex", action="store_true",
                    help="rebuild INDEX.json from artifacts already on disk; render nothing")
    args = ap.parse_args()

    if args.instance:
        records = [{"scenarioId": args.instance.parent.name + "#" + args.instance.name.split(".")[0],
                    "archetypeId": None, "mapId": None, "siteId": args.instance.parent.name,
                    "split": "single", "instance": str(args.instance)}]
    else:
        records = load_records(args.records, args.scan)
    if args.limit:
        records = records[: args.limit]
    if not records:
        print("no scenarios selected", file=sys.stderr)
        return 2

    args.out.mkdir(parents=True, exist_ok=True)
    index_file = args.out / "INDEX.json"
    entries: dict[str, dict] = {}

    if args.reindex:
        # Rebuild INDEX.json from whatever is already on disk, with the real
        # thrown error for every failure. Renders nothing.
        prior = {}
        if index_file.exists():
            try:
                prior = {e["scenarioId"]: e for e in json.loads(index_file.read_text())
                         if isinstance(e, dict) and e.get("scenarioId")}
            except (ValueError, KeyError):
                prior = {}
        for rec in records:
            entry = {
                "scenarioId": rec["scenarioId"], "archetypeId": rec.get("archetypeId"),
                "mapId": rec.get("mapId"), "siteId": rec.get("siteId"), "split": rec.get("split"),
                "instance": rec["instance"], "mp4": None, "manifest": None, "integrity": None,
                "status": "not-attempted", "failureKind": None, "error": None,
                "log": str(args.out / "_logs" / f"{rec['scenarioId']}.log"),
                "seconds": (prior.get(rec["scenarioId"]) or {}).get("seconds"),
            }
            scenario_out = args.out / rec["scenarioId"]
            manifest_file = scenario_out / "manifest.json"
            log_file = args.out / "_logs" / f"{rec['scenarioId']}.log"
            if manifest_file.exists():
                entry = finalise(entry, manifest_file, scenario_out, None)
            elif log_file.exists():
                kind, message = extract_error(log_file.read_text())
                entry.update(status="render-failed", failureKind=kind, error=message)
                record_failure(scenario_out, entry)
            entries[entry["scenarioId"]] = entry
        write_index(index_file, entries, {"mode": "reindex", "url": args.url})
        print(json.dumps(json.loads((args.out / "INDEX-meta.json").read_text())["summary"], indent=2))
        return 0

    meta = {
        "url": args.url,
        "quality": args.quality,
        "fps": args.fps,
        "viewport": {"width": args.width, "height": args.height},
        "concurrency": args.concurrency,
        "cameraSearch": args.camera_search,
    }
    started = time.time()
    done = 0
    with ThreadPoolExecutor(max_workers=args.concurrency) as pool:
        futures = {
            pool.submit(render_one, rec, args.out, args.url, args.quality, args.fps,
                        args.width, args.height, args.timeout, args.force, args.camera_search): rec
            for rec in records
        }
        for future in as_completed(futures):
            rec = futures[future]
            try:
                entry = future.result()
            except Exception as exc:  # noqa: BLE001 - a driver crash must not lose the index
                entry = {"scenarioId": rec["scenarioId"], "status": "driver-error",
                         "error": repr(exc), "mp4": None, "integrity": None, "seconds": None}
            done += 1
            with _index_lock:
                entries[entry["scenarioId"]] = entry
                meta["wallSecondsSoFar"] = round(time.time() - started, 1)
                meta["secondsPerScenarioWallClock"] = round((time.time() - started) / done, 2)
                write_index(index_file, entries, meta)
            print(f"[{done}/{len(records)}] {entry['scenarioId']} {entry['status']} "
                  f"{entry.get('seconds')}s", flush=True)

    wall = time.time() - started
    ok = sum(1 for e in entries.values() if e["status"] == "ok")
    print(json.dumps({
        "index": str(index_file),
        "total": len(entries),
        "ok": ok,
        "wallSeconds": round(wall, 1),
        "secondsPerScenarioWallClock": round(wall / max(1, len(entries)), 2),
        "concurrency": args.concurrency,
        "rendersPerHour": round(3600.0 / (wall / max(1, len(entries))), 1),
    }, indent=2))
    return 0 if ok == len(entries) else 1


if __name__ == "__main__":
    raise SystemExit(main())
