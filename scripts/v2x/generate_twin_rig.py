#!/usr/bin/env python3
"""Generate the V2X Richmond twin-camera rig JSON (V4 SensorRig).

Reads the READ-ONLY V2XCarla calibration source
(`v2x-backend/config/cameras.json` + the shared pose model in
`v2x_common/camera_model.py`) and emits `v2x-twin-rig.v1`: per-channel poses,
intrinsics, lens distortion, and render FOVs, with full frame provenance.

The math replicates camera_model.py exactly (validated against its
docstring figures: ch1 true HFOV 99.65 deg vs pinhole 88.00):

- CARLA yaw   = wrap180(frame_heading_deg + yaw_deg - 90)   (site-frame pan
  composed ONCE with the site heading; composing per-camera heading_deg
  instead is legacy bug "bug 3").
- true H/VFOV = edge-to-edge angle between sensor-edge rays, with radial
  undistortion gain (1 + u1 r^2 + u2 r^4) applied to normalized edge radii;
  u1 renormalised onto the channel's own fx ((fx/ref_fx)^2 scaling).
- rectified_fx = W / (tan(far) - tan(near)) — reporting only.

Frame provenance (V5 MapParity verdict, docs/v2x-coordinate-contract.md on
branch v2x-map-parity): poses are anchored to the LEGACY deployed lineage
0737f3d9 (flat-earth inverse of the map georeference origin). The Uni bundle
80704cd1 shares a byte-identical tmerc georeference, so planar placement on
the shared grid is exact; road GEOMETRY moved between revisions (road 14,
nearest the pole: median 16.9 m), so renders against Uni-revision assets are
expected to misalign until 0737f3d9 is ingested as a Uni map derivative.

Usage:
  python3 scripts/v2x/generate_twin_rig.py \
      [--cameras /home/path/V2XCarla/v2x-backend/config/cameras.json] \
      --out native/sensors/rigs/richmond-twin-rig.v1.json
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path

# Deployed-lineage georeference origin (identical in both revisions).
LAT_0 = 37.9150891287087
LON_0 = -122.333308830857
# Uni richmond-field-station bundle XODR digest (map contract: every V2X
# artifact carries {mapId, xodrSha256} and consumers refuse mismatches).
UNI_XODR = Path(__file__).resolve().parents[2] / "dev-assets/richmond-field-station/xodr.xodr"
LEGACY_XODR = Path(
    "/home/path/V2XCarla/v2x-evidence/calibration/"
    "20260727T000000Z-map-lineage-vault/A-carla-deployed__Richmond_Field_Station_Richmond_CA.xodr"
)


def wrap180(deg: float) -> float:
    return (deg + 180.0) % 360.0 - 180.0


def sha256_of(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def correction(u1: float, u2: float, r: float) -> float:
    r2 = r * r
    return 1.0 + u1 * r2 + u2 * r2 * r2


def edge_to_edge_fov(near: float, far: float, u1: float, u2: float) -> float:
    if u1 != 0.0 or u2 != 0.0:
        near *= correction(u1, u2, abs(near))
        far *= correction(u1, u2, abs(far))
    return math.degrees(math.atan(far) - math.atan(near))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--cameras", default="/home/path/V2XCarla/v2x-backend/config/cameras.json")
    ap.add_argument("--out", default="native/sensors/rigs/richmond-twin-rig.v1.json")
    args = ap.parse_args()

    cfg = json.loads(Path(args.cameras).read_text())
    site = cfg["site"]
    lat, lon = site["lat"], site["lon"]
    frame_heading = site["frame_heading_deg"]

    # Legacy gps_to_carla (CARLA 0.10 path): flat-earth inverse around the map
    # georeference origin, exactly as geo_utils.py computes it.
    mpd_lat = 111_320.0
    mpd_lon = 111_320.0 * math.cos(math.radians(LAT_0))
    carla_x = (lon - LON_0) * mpd_lon          # easting metres
    carla_y = -(lat - LAT_0) * mpd_lat         # -northing metres

    # Shared-grid placement for the Uni renderer (GLB world frame:
    # x = map x/easting, z = -northing, y up).
    scene_xz = [round((lon - LON_0) * mpd_lon, 4), round(-(-(lat - LAT_0) * mpd_lat), 4)]

    cameras_out = []
    for c in cfg["cameras"]:
        intr = c["intrinsics"]
        d = c.get("distortion", {})
        ref_fx = d.get("ref_fx") or intr["fx"]
        ratio = intr["fx"] / ref_fx
        u1 = d.get("u1", 0.0) * ratio * ratio
        u2 = d.get("u2", 0.0) * (ratio ** 4)
        has_lens = not (u1 == 0.0 and u2 == 0.0)

        W, H = intr["width"], intr["height"]
        fx, fy, cx, cy = intr["fx"], intr["fy"], intr["cx"], intr["cy"]

        carla_yaw = wrap180(frame_heading + c["yaw_deg"] - 90.0)
        pitch = c["pitch_deg"]
        true_hfov = edge_to_edge_fov((-0.5 - cx) / fx, (W - 0.5 - cx) / fx, u1, u2)
        true_vfov = edge_to_edge_fov((-0.5 - cy) / fy, (H - 0.5 - cy) / fy, u1, u2)
        pinhole_hfov = math.degrees(2.0 * math.atan((W / 2.0) / fx))

        near_n = (-0.5 - cx) / fx
        far_n = (W - 0.5 - cx) / fx
        if has_lens:
            near_n *= correction(u1, u2, abs(near_n))
            far_n *= correction(u1, u2, abs(far_n))
        rectified_fx = W / (far_n - near_n)

        cameras_out.append({
            "id": c["id"],
            "deviceId": c.get("device_id"),
            "heightM": c["height_m"],
            "pitchDeg": pitch,
            "panDeg": c["yaw_deg"],
            "carlaYawDeg": round(carla_yaw, 4),
            "intrinsics": {
                "fx": fx, "fy": fy, "cx": cx, "cy": cy,
                "width": W, "height": H,
            },
            "distortion": {
                "model": d.get("model", "radial_undistort_r2"),
                "u1Renormalised": u1,
                "u2Renormalised": u2,
                "refFx": ref_fx,
                "measured": d.get("measured", False),
                "note": (
                    "UNDISTORTION-direction radial model "
                    "(r_u = r_d*(1 + u1*r_d^2 + u2*r_d^4)); never substitute "
                    "an OpenCV (k1,k2) fit."
                ),
            },
            "fovDeg": {
                "pinholeHorizontal": round(pinhole_hfov, 3),
                "trueHorizontal": round(true_hfov, 3),
                "trueVertical": round(true_vfov, 3),
                "renderNote": (
                    "Render at trueHorizontal/trueVertical to cover what the "
                    "real lens sees; the twin is a pinhole approximation of an "
                    "undistorted feed."
                ),
            },
            "rectifiedFx": round(rectified_fx, 2),
            # Legacy CARLA location relative to the deployed map origin.
            # z was snapped to road by gps_to_carla; the ground offset is
            # resolved at render time by the renderer's height field.
            "legacyCarlaLocationXy": [round(carla_x, 4), round(carla_y, 4)],
            "sceneEyeXz": scene_xz,
            "twinPose": c.get("twin_pose", {}),
        })

    rig = {
        "version": "v2x-twin-rig.v1",
        "mapId": "richmond-field-station",
        "xodrSha256": sha256_of(UNI_XODR),
        "frameProvenance": {
            "poseFrame": "legacy-carla@0737f3d9 (deployed lineage)",
            "legacyXodrSha256": sha256_of(LEGACY_XODR) if LEGACY_XODR.exists() else None,
            "georeference": f"+proj=tmerc +lat_0={LAT_0} +lon_0={LON_0} +k=1 +x_0=0 +y_0=0 +datum=WGS84",
            "georeferenceSharedWithUniBundle": True,
            "legacyLocationFormula": "gps_to_carla CARLA-0.10 flat-earth inverse (geo_utils.py)",
            "verdict": (
                "V5 MapParity option (a): ingest the deployed 0737f3d9 XODR as "
                "a new Uni map derivative; calibrations stay legacy-anchored. "
                "Until then, renders against Uni-bundle (80704cd1) assets are "
                "EXPECTED to misalign where geometry moved between revisions "
                "(road 14 nearest the pole: median 16.9 m shift); do not "
                "'fix' by nudging poses."
            ),
            "twinPoseOffsetsApplied": False,
        },
        "site": {
            "name": site["name"],
            "lat": lat,
            "lon": lon,
            "frameHeadingDeg": frame_heading,
            "frameHeadingProvenance": site.get("frame_heading_provenance", "")[:200],
        },
        "renderDefaults": {
            "profile": "sensor",
            "attachment": "fixed-world",
            "sensorTickSeconds": 0.05,
            "note": "20 fps product cadence; service renders on request.",
        },
        "cameras": cameras_out,
    }

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(rig, indent=2) + "\n")
    print(f"wrote {out} ({len(cameras_out)} cameras)")
    for c in cameras_out:
        f = c["fovDeg"]
        print(
            f"  {c['id']}: yaw={c['carlaYawDeg']:+8.3f} pitch={c['pitchDeg']:+7.2f} "
            f"trueHFOV={f['trueHorizontal']:7.3f} trueVFOV={f['trueVertical']:7.3f}"
        )


if __name__ == "__main__":
    main()
