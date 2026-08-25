"""Per-sensor MP4 export for CARLA renders.

Every sensor owns exactly one playable video: cameras adopt the h264 stream
their backend encoder already produced (raw frames pipe straight into ffmpeg
and never land on disk), LiDAR renders as a top-down point cloud coloured by
range, and radar as a range/azimuth plot coloured by radial velocity — the
same two visualisations the browser renderer ships, so a clip reads the same
in either engine.
"""
from __future__ import annotations
import shutil

import math
import subprocess
from collections import deque
from collections.abc import Callable, Iterator, Sequence
from pathlib import Path
from typing import Any

VIDEO_WIDTH = 1280
VIDEO_HEIGHT = 720
CAMERA_MODALITIES = frozenset({"rgb", "depth", "semantic", "instance", "normals"})
LIDAR_MODALITIES = frozenset({"lidar", "semantic-lidar"})
_BACKGROUND = (3, 7, 11)


class SensorVideoError(RuntimeError):
    """A sensor video could not be produced from the captured frames."""


def _ffmpeg_common(fps: float, destination: Path, max_bytes: int) -> list[str]:
    return [
        "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
        "-pix_fmt", "yuv420p", "-r", f"{fps:g}", "-movflags", "+faststart",
        "-fs", str(max_bytes), str(destination),
    ]


def _frame_paths(sensor_dir: Path, extension: str, expected_frame_count: int) -> list[Path]:
    frames = sorted(sensor_dir.glob(f"*.{extension}"))
    if len(frames) != expected_frame_count:
        raise SensorVideoError(
            f"{sensor_dir.name} has {len(frames)} {extension} frames, expected {expected_frame_count}"
        )
    return frames


def encode_camera_video(
    sensor_dir: Path,
    fps: float,
    destination: Path,
    expected_frame_count: int,
    max_bytes: int,
) -> Path:
    """Adopt the camera's streamed h264 file; cameras persist no frame files."""
    stream = sensor_dir / "stream.mp4"
    if not stream.is_file() or stream.stat().st_size == 0:
        raise SensorVideoError(f"camera {sensor_dir.name} produced no encoded video stream")
    if stream.stat().st_size > max_bytes:
        raise SensorVideoError(f"camera video {sensor_dir.name} exceeds its budget")
    shutil.copyfile(stream, destination)
    return destination


def _blank_frame() -> bytearray:
    row = bytes(_BACKGROUND) * VIDEO_WIDTH
    return bytearray(row * VIDEO_HEIGHT)


def _plot(frame: bytearray, x: int, y: int, colour: tuple[int, int, int], radius: int = 1) -> None:
    for dy in range(-radius, radius + 1):
        row = y + dy
        if row < 0 or row >= VIDEO_HEIGHT:
            continue
        base = row * VIDEO_WIDTH * 3
        for dx in range(-radius, radius + 1):
            column = x + dx
            if column < 0 or column >= VIDEO_WIDTH:
                continue
            offset = base + column * 3
            frame[offset] = colour[0]
            frame[offset + 1] = colour[1]
            frame[offset + 2] = colour[2]


def _range_colour(ratio: float) -> tuple[int, int, int]:
    """Near returns warm, far returns cool, matching the browser point-cloud ramp."""
    ratio = 0.0 if ratio < 0 else 1.0 if ratio > 1 else ratio
    return (
        int(255 * (1.0 - 0.75 * ratio)),
        int(90 + 130 * (1.0 - abs(ratio - 0.5) * 2)),
        int(70 + 185 * ratio),
    )


def _velocity_colour(velocity: float, scale: float) -> tuple[int, int, int]:
    """Approaching returns blue, receding returns red, saturating at `scale` m/s."""
    magnitude = min(1.0, abs(velocity) / scale) if scale > 0 else 0.0
    if velocity < 0:
        return (60, int(150 + 105 * magnitude), 255)
    return (255, int(120 - 60 * magnitude), int(90 - 40 * magnitude))


def _grid(frame: bytearray, range_m: float, scale: float, origin_x: int, origin_y: int) -> None:
    for ring in range(1, int(range_m // 20) + 1):
        radius = ring * 20 * scale
        if radius < 4:
            continue
        steps = max(64, int(radius * 4))
        for step in range(steps):
            angle = 2 * math.pi * step / steps
            _plot(
                frame,
                origin_x + int(radius * math.sin(angle)),
                origin_y - int(radius * math.cos(angle)),
                (22, 42, 52),
                radius=0,
            )


def _read_lidar_points(path: Path) -> list[tuple[float, float, float, float]]:
    points: list[tuple[float, float, float, float]] = []
    with path.open("r", encoding="utf-8", errors="replace") as handle:
        in_body = False
        for line in handle:
            if not in_body:
                if line.startswith("end_header"):
                    in_body = True
                continue
            parts = line.split()
            if len(parts) < 3:
                continue
            try:
                x, y, z = float(parts[0]), float(parts[1]), float(parts[2])
                intensity = float(parts[3]) if len(parts) > 3 else 1.0
            except ValueError:
                continue
            points.append((x, y, z, intensity))
    return points


def _read_radar_detections(path: Path) -> list[tuple[float, float, float, float]]:
    detections: list[tuple[float, float, float, float]] = []
    with path.open("r", encoding="utf-8", errors="replace") as handle:
        for index, line in enumerate(handle):
            if index == 0 and line.lower().startswith("depth"):
                continue
            parts = line.strip().split(",")
            if len(parts) < 4:
                continue
            try:
                detections.append((float(parts[0]), float(parts[1]), float(parts[2]), float(parts[3])))
            except ValueError:
                continue
    return detections


def _sweep_window_ticks(fps: float, rotation_hz: float) -> int:
    """Ticks needed for one full lidar revolution at the capture cadence.

    A CARLA lidar delivers only the sector swept during each fixed tick, so a
    single per-tick bucket is a strobing partial pinwheel (~150° at 10 Hz /
    24 fps). One revolution spans fps / rotation_hz ticks.
    """
    if rotation_hz <= 0.0:
        return 1
    return max(1, math.ceil(fps / rotation_hz))


def _lidar_frames(
    frames: Sequence[Path],
    range_m: float,
    fps: float,
    rotation_hz: float,
) -> Iterator[bytes]:
    # Returns cluster within a few tens of metres, so cap the view well inside a 200 m sensor
    # range; otherwise the cloud collapses into a dot at the centre of the frame.
    span = max(1.0, min(range_m, 60.0))
    scale = min(VIDEO_WIDTH / (span * 2.2), VIDEO_HEIGHT / (span * 2.2))
    origin_x, origin_y = VIDEO_WIDTH // 2, VIDEO_HEIGHT // 2
    # Video frame N accumulates the tick buckets of the full revolution that
    # ENDS at tick N, so every frame shows a complete 360° cloud whose newest
    # sector shares camera frame N's sim time — coherent and time-aligned.
    window = _sweep_window_ticks(fps, rotation_hz)
    revolution: deque[list[tuple[float, float, float, float]]] = deque(maxlen=window)
    for path in frames:
        revolution.append(_read_lidar_points(path))
        frame = _blank_frame()
        _grid(frame, span, scale, origin_x, origin_y)
        for bucket in revolution:
            for x, y, _z, intensity in bucket:
                distance = math.hypot(x, y)
                if distance > span:
                    continue
                colour = _range_colour(distance / span)
                shade = 0.75 + 0.25 * min(1.0, max(0.0, intensity))
                _plot(
                    frame,
                    origin_x - int(y * scale),
                    origin_y - int(x * scale),
                    (int(colour[0] * shade), int(colour[1] * shade), int(colour[2] * shade)),
                    radius=2,
                )
        yield bytes(frame)


def _radar_frames(frames: Sequence[Path], range_m: float) -> Iterator[bytes]:
    span = max(1.0, range_m)
    scale = min(VIDEO_WIDTH * 0.45, VIDEO_HEIGHT * 0.85) / span
    origin_x, origin_y = VIDEO_WIDTH // 2, int(VIDEO_HEIGHT * 0.92)
    for path in frames:
        frame = _blank_frame()
        _grid(frame, span, scale, origin_x, origin_y)
        detections = _read_radar_detections(path)
        velocities = [abs(item[3]) for item in detections]
        # Radar velocity units are not guaranteed, so normalise per frame instead of assuming m/s.
        velocity_scale = max(velocities) if velocities else 1.0
        for depth, azimuth, _altitude, velocity in detections:
            if depth > span:
                continue
            _plot(
                frame,
                origin_x + int(math.sin(azimuth) * depth * scale),
                origin_y - int(math.cos(azimuth) * depth * scale),
                _velocity_colour(velocity, velocity_scale),
                radius=2,
            )
        yield bytes(frame)


def _encode_raw_frames(
    frames: Iterator[bytes],
    fps: float,
    destination: Path,
    max_bytes: int,
    check_abort: Callable[[], None],
) -> Path:
    command = [
        "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
        "-f", "rawvideo", "-pix_fmt", "rgb24",
        "-s", f"{VIDEO_WIDTH}x{VIDEO_HEIGHT}", "-framerate", f"{fps:g}", "-i", "-",
        *_ffmpeg_common(fps, destination, max_bytes),
    ]
    process = subprocess.Popen(command, stdin=subprocess.PIPE, stderr=subprocess.PIPE)
    assert process.stdin is not None
    try:
        for payload in frames:
            check_abort()
            process.stdin.write(payload)
    finally:
        process.stdin.close()
        stderr = process.stderr.read() if process.stderr else b""
        code = process.wait()
    if code:
        raise SensorVideoError(f"ffmpeg failed for {destination.name}: {stderr.decode(errors='replace')[:400]}")
    return destination


def encode_sensor_video(
    sensor: Any,
    output_dir: Path,
    destination: Path,
    fps: float,
    expected_frame_count: int,
    max_bytes: int,
    check_abort: Callable[[], None],
) -> Path:
    """Produce one MP4 for `sensor` from the frames it already captured."""
    sensor_dir = output_dir / sensor.artifact_name
    if not sensor_dir.is_dir():
        raise SensorVideoError(f"sensor {sensor.artifact_name} captured no frames")
    modality = sensor.modality
    if modality in CAMERA_MODALITIES:
        return encode_camera_video(sensor_dir, fps, destination, expected_frame_count, max_bytes)
    if modality in LIDAR_MODALITIES:
        frames = _frame_paths(sensor_dir, "ply", expected_frame_count)
        range_m = float(sensor.config.get("rangeM", 100.0))
        rotation_hz = float(sensor.config.get("rotationFrequencyHz", 10.0))
        return _encode_raw_frames(
            _lidar_frames(frames, range_m, fps, rotation_hz), fps, destination, max_bytes, check_abort,
        )
    if modality == "radar":
        frames = _frame_paths(sensor_dir, "csv", expected_frame_count)
        range_m = float(sensor.config.get("rangeM", 100.0))
        return _encode_raw_frames(_radar_frames(frames, range_m), fps, destination, max_bytes, check_abort)
    raise SensorVideoError(f"sensor {sensor.artifact_name} has no video representation for {modality}")
