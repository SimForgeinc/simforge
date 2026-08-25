"""F4 Python bundle-reader test against a ring recorded by the REAL Rust
service (renderer/service/testdata/bundle-ring.shm.gz: yale fixture tile,
2 cams 64x48 rgb, sim ticks 1..3, recorded via render_bundle RPC).

Run: python3 -m pytest tests/test_bundles.py  (from renderer/service/python)
"""
import gzip
import json
import pathlib
import shutil
import struct
import sys

import numpy as np
import pytest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
from simforge_native import BundleRingReader, TornBundleError  # noqa: E402

TESTDATA = pathlib.Path(__file__).resolve().parents[2] / "testdata"


@pytest.fixture()
def ring_path(tmp_path):
    out = tmp_path / "bundle-ring.shm"
    with gzip.open(TESTDATA / "bundle-ring.shm.gz", "rb") as src, open(out, "wb") as dst:
        shutil.copyfileobj(src, dst)
    return out


@pytest.fixture()
def manifest():
    return json.loads((TESTDATA / "bundle-ring.manifest.json").read_text())


def test_latest_matches_recorded_manifest(ring_path, manifest):
    reader = BundleRingReader(str(ring_path))
    bundle = reader.latest(verify=True)
    last = manifest["ticks"][-1]
    assert bundle.sim_tick == last["simTick"]
    assert bundle.still_valid()
    assert [(e.camera_id, e.pass_, e.payload_offset, e.payload_len, e.width, e.height,
             e.format, e.digest_hex) for e in bundle.entries] == [
        (f["sensorId"], f["pass"], f["offset"] + 128, f["len"], f["width"], f["height"],
         f["format"], f["digest"]) for f in last["frames"]]
    reader.close()


def test_zero_copy_views_and_shapes(ring_path):
    reader = BundleRingReader(str(ring_path))
    bundle = reader.latest(verify=True)
    views = bundle.views()
    assert set(views) == {"front", "rear"}
    rgb = views["front"]["rgb"]
    assert rgb.shape == (48, 64, 4) and rgb.dtype == np.uint8
    assert np.shares_memory(rgb, reader.shm), "views must be zero-copy"
    assert float(rgb.std()) > 1.0, "rendered frame must be non-uniform"
    # front and rear look different directions -> different pixels
    assert not np.array_equal(rgb, views["rear"]["rgb"])
    del views, rgb, bundle
    reader.close()


def test_bundle_at_reads_earlier_ticks(ring_path, manifest):
    reader = BundleRingReader(str(ring_path))
    for tick in manifest["ticks"]:
        bundle = reader.bundle_at(tick["bundleOffset"], tick["bundleLen"], verify=True)
        assert bundle.sim_tick == tick["simTick"]
        assert [e.digest_hex for e in bundle.entries] == [f["digest"] for f in tick["frames"]]
    reader.close()


def test_iter_bundles_sees_latest_then_times_out(ring_path):
    reader = BundleRingReader(str(ring_path))
    seen = [b.sim_tick for b in reader.iter_bundles(timeout_s=0.05, verify=True)]
    assert seen == [3], "static recorded ring has exactly one newest bundle"
    reader.close()


def test_corrupted_payload_fails_digest_verify(ring_path, manifest):
    data = bytearray(ring_path.read_bytes())
    frame = manifest["ticks"][-1]["frames"][0]
    data[frame["offset"] + 128 + 100] ^= 0xFF  # flip one payload byte
    ring_path.write_bytes(data)
    reader = BundleRingReader(str(ring_path))
    with pytest.raises(TornBundleError):
        reader.latest(verify=True)
    # unverified read still parses the (intact) table
    bundle = reader.latest(verify=False)
    assert bundle.sim_tick == 3 and not bundle.verify()
    reader.close()


def test_torn_bundle_table_detected(ring_path, manifest):
    data = bytearray(ring_path.read_bytes())
    last = manifest["ticks"][-1]
    data[last["bundleOffset"] + 128 + 32 + 70] ^= 0xFF  # corrupt an entry field
    ring_path.write_bytes(data)
    reader = BundleRingReader(str(ring_path))
    with pytest.raises(TornBundleError, match="CRC mismatch"):
        reader.latest(verify=False)
    reader.close()


def test_writer_lap_expires_bundle(ring_path):
    # Simulate the writer lapping: advance the meta write-cursor beyond the
    # ring's usable size past the recorded bundle's start_cursor.
    reader = BundleRingReader(str(ring_path))
    bundle = reader.latest(verify=True)
    assert bundle.still_valid()
    reader.close()

    data = bytearray(ring_path.read_bytes())
    lapped = bundle.start_cursor + (len(data) - 4096) + 1
    struct.pack_into("<Q", data, 8, lapped)
    ring_path.write_bytes(data)

    reader = BundleRingReader(str(ring_path))
    stale = reader.latest(verify=False)
    assert not stale.still_valid()
    assert not stale.verify()
    with pytest.raises(TornBundleError):
        reader.latest(verify=True)
    reader.close()
