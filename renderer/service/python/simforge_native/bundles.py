"""F4 frame-bundle consumer: zero-copy numpy views over the shm ring.

The native render service's `render_bundle` op publishes, per sim tick:
per-camera frame records, then one `bundle` table record, then a
latest-bundle pointer in the ring's meta page behind a seqlock. This module
is the pull-side consumer for policy runners: map the ring read-only,
follow the pointer, and expose each camera frame as a numpy VIEW into
shared memory (no copy).

Torn-bundle protection (never observe a partial tick):
* seqlock guards the (offset, len, sim_tick) pointer triple;
* `entries_crc` (CRC32) guards the bundle table;
* per-frame CRC32 digests guard payload bytes (`Bundle.verify()`);
* `Bundle.still_valid()` is the cheap hot-loop check: the writer's
  monotonic cursor must not have advanced more than the ring's usable
  size past the bundle's `start_cursor` (i.e. the writer has not lapped).

Binary layouts (all little-endian) mirror renderer/service/src/shm.rs:
  meta page:   [0..8) ring magic, [8..16) write_cursor_total,
               [16..24) bundle seq, [24..32) bundle record offset,
               [32..40) bundle payload len, [40..48) bundle sim_tick
  record hdr:  128 bytes: magic u64, version u32, width u32, height u32,
               format u32, tick u64, payload_len u64, sensor_id[56] @40,
               pass[32] @96
  bundle:      32-byte header (magic "SFBNDL01", sim_tick u64,
               start_cursor u64, n_entries u32, entries_crc u32) +
               96-byte entries (id[48], pass[16], payload_offset u64,
               payload_len u64, width u32, height u32, format u32,
               digest u32)
"""
from __future__ import annotations

import mmap
import struct
import time
import zlib
from dataclasses import dataclass

import numpy as np

META_BYTES = 4096
RECORD_HEADER_BYTES = 128
RING_MAGIC = 0x554E4953_48524931  # "UNISHRI1"
BUNDLE_MAGIC = int.from_bytes(b"SFBNDL01", "little")
BUNDLE_HEADER_BYTES = 32
BUNDLE_ENTRY_BYTES = 96

FORMAT_NAMES = {1: "rgba8", 2: "depth32f", 3: "jpeg", 4: "bundle"}


class TornBundleError(RuntimeError):
    """The bundle was overwritten or torn while being read."""


def _stride(width: int, pixel_bytes: int = 4) -> int:
    """wgpu COPY_BYTES_PER_ROW_ALIGNMENT (256) padded row stride."""
    return -(-(width * pixel_bytes) // 256) * 256


@dataclass(frozen=True)
class BundleEntry:
    camera_id: str
    pass_: str
    payload_offset: int  # payload bytes; record header at payload_offset-128
    payload_len: int
    width: int
    height: int
    format: str
    digest: int  # CRC32 (IEEE) of payload bytes

    @property
    def digest_hex(self) -> str:
        """8-char lowercase hex, as carried in frameBundle refs."""
        return f"{self.digest:08x}"


class Bundle:
    """One decoded atomic frame bundle over a mapped ring."""

    def __init__(self, ring: "BundleRingReader", sim_tick: int, start_cursor: int,
                 entries: list[BundleEntry]):
        self._ring = ring
        self.sim_tick = sim_tick
        self.start_cursor = start_cursor
        self.entries = entries

    def still_valid(self) -> bool:
        """Cheap liveness check: writer has not lapped past this bundle."""
        return self._ring.write_cursor() - self.start_cursor <= self._ring.usable_bytes

    def payload(self, entry: BundleEntry) -> memoryview:
        """Raw payload bytes of one entry (zero-copy memoryview)."""
        return memoryview(self._ring.shm)[entry.payload_offset:
                                          entry.payload_offset + entry.payload_len]

    def verify(self) -> bool:
        """Deep check: per-frame CRC32 digests + record headers + liveness."""
        for entry in self.entries:
            header = self._ring.record_header(entry.payload_offset - RECORD_HEADER_BYTES)
            if header is None or header[3] != self.sim_tick or header[5] != entry.camera_id:
                return False
            if zlib.crc32(self.payload(entry)) != entry.digest:
                return False
        return self.still_valid()

    def view(self, entry: BundleEntry) -> np.ndarray:
        """Zero-copy numpy view of one frame (row padding handled).

        rgba8 -> (H, W, 4) uint8; depth32f -> (H, W) float32; anything else
        stays a raw uint8 byte view.
        """
        shm, off = self._ring.shm, entry.payload_offset
        w, h = entry.width, entry.height
        if entry.format == "depth32f":
            stride = _stride(w)
            arr = np.frombuffer(shm, dtype="<f4", count=stride * h // 4, offset=off)
            return arr.reshape(h, stride // 4)[:, :w]
        if entry.format == "rgba8":
            stride = _stride(w)
            arr = np.frombuffer(shm, dtype=np.uint8, count=stride * h, offset=off)
            return arr.reshape(h, stride)[:, : w * 4].reshape(h, w, 4)
        return np.frombuffer(shm, dtype=np.uint8, count=entry.payload_len, offset=off)

    def views(self) -> dict[str, dict[str, np.ndarray]]:
        """{camera_id: {pass: zero-copy numpy view}} for every entry."""
        out: dict[str, dict[str, np.ndarray]] = {}
        for entry in self.entries:
            out.setdefault(entry.camera_id, {})[entry.pass_] = self.view(entry)
        return out


class BundleRingReader:
    """Read-only consumer over a ring file produced by the render service.

    Typical hot loop:
        reader = BundleRingReader(shm_path)
        for bundle in reader.iter_bundles():
            obs = bundle.views()          # zero-copy
            ...use obs...
            if not bundle.still_valid():  # writer lapped mid-use
                continue
    """

    def __init__(self, shm_path: str):
        self._file = open(shm_path, "rb")
        self.shm = mmap.mmap(self._file.fileno(), 0, prot=mmap.PROT_READ)
        self.path = shm_path
        magic = struct.unpack_from("<Q", self.shm, 0)[0]
        if magic != RING_MAGIC:
            raise ValueError(f"{shm_path}: not a simforge shm ring (magic {magic:#x})")
        self.usable_bytes = len(self.shm) - META_BYTES

    def close(self) -> None:
        try:
            self.shm.close()
        except BufferError as error:
            raise BufferError(
                "cannot close ring: zero-copy numpy views still reference the "
                "mapping — drop every Bundle/view (del or copy()) before close()"
            ) from error
        self._file.close()

    def __enter__(self) -> "BundleRingReader":
        return self

    def __exit__(self, *exc) -> None:
        self.close()

    # -- meta page -----------------------------------------------------------
    def write_cursor(self) -> int:
        return struct.unpack_from("<Q", self.shm, 8)[0]

    def _pointer(self) -> tuple[int, int, int] | None:
        """Seqlock read of (record_offset, payload_len, sim_tick)."""
        while True:
            s1 = struct.unpack_from("<Q", self.shm, 16)[0]
            if s1 == 0:
                return None  # no bundle ever published
            if s1 % 2 == 1:
                continue  # writer mid-flip
            offset, length, tick = struct.unpack_from("<QQQ", self.shm, 24)
            s2 = struct.unpack_from("<Q", self.shm, 16)[0]
            if s1 == s2:
                return offset, length, tick

    # -- records ---------------------------------------------------------------
    def record_header(self, offset: int) -> tuple | None:
        """(width, height, format, tick, payload_len, sensor_id, pass) or None."""
        h = bytes(memoryview(self.shm)[offset:offset + RECORD_HEADER_BYTES])
        if len(h) < RECORD_HEADER_BYTES or struct.unpack_from("<Q", h, 0)[0] != RING_MAGIC:
            return None
        width, height, fmt = struct.unpack_from("<III", h, 12)
        tick, payload_len = struct.unpack_from("<QQ", h, 24)
        sensor_id = h[40:96].split(b"\0", 1)[0].decode()
        pass_ = h[96:128].split(b"\0", 1)[0].decode()
        return width, height, fmt, tick, payload_len, sensor_id, pass_

    # -- bundles ---------------------------------------------------------------
    def _decode_bundle(self, record_offset: int, payload_len: int) -> Bundle:
        start = record_offset + RECORD_HEADER_BYTES
        payload = bytes(memoryview(self.shm)[start:start + payload_len])
        if len(payload) < BUNDLE_HEADER_BYTES:
            raise TornBundleError("bundle payload truncated")
        magic, sim_tick, start_cursor = struct.unpack_from("<QQQ", payload, 0)
        n, entries_crc = struct.unpack_from("<II", payload, 24)
        if magic != BUNDLE_MAGIC:
            raise TornBundleError(f"bad bundle magic {magic:#x}")
        want = BUNDLE_HEADER_BYTES + n * BUNDLE_ENTRY_BYTES
        if len(payload) < want:
            raise TornBundleError("bundle table truncated")
        region = payload[BUNDLE_HEADER_BYTES:want]
        if zlib.crc32(region) != entries_crc:
            raise TornBundleError("bundle table CRC mismatch (torn bundle)")
        entries = []
        for k in range(n):
            b = region[k * BUNDLE_ENTRY_BYTES:(k + 1) * BUNDLE_ENTRY_BYTES]
            camera_id = b[:48].split(b"\0", 1)[0].decode()
            pass_ = b[48:64].split(b"\0", 1)[0].decode()
            off, length = struct.unpack_from("<QQ", b, 64)
            width, height, fmt, digest = struct.unpack_from("<IIII", b, 80)
            entries.append(BundleEntry(
                camera_id=camera_id, pass_=pass_, payload_offset=off,
                payload_len=length, width=width, height=height,
                format=FORMAT_NAMES.get(fmt, str(fmt)), digest=digest,
            ))
        return Bundle(self, sim_tick, start_cursor, entries)

    def latest(self, verify: bool = True) -> Bundle | None:
        """Latest published bundle, or None. verify=True digest-checks every
        frame and raises TornBundleError if the writer lapped mid-read."""
        pointer = self._pointer()
        if pointer is None:
            return None
        bundle = self._decode_bundle(pointer[0], pointer[1])
        if verify and not bundle.verify():
            raise TornBundleError(f"bundle tick {bundle.sim_tick} failed verification")
        return bundle

    def bundle_at(self, record_offset: int, payload_len: int, verify: bool = True) -> Bundle:
        """Decode a bundle by explicit location (e.g. from a frameBundle ref
        or a render_bundle RPC response's bundle_offset/bundle_len)."""
        bundle = self._decode_bundle(record_offset, payload_len)
        if verify and not bundle.verify():
            raise TornBundleError(f"bundle tick {bundle.sim_tick} failed verification")
        return bundle

    def iter_bundles(self, poll_s: float = 0.0005, timeout_s: float | None = None,
                     verify: bool = False):
        """Yield each NEW bundle (by sim_tick) as the writer publishes them.

        verify=False by default: the hot loop relies on the seqlock +
        `still_valid()`; flip verify=True for QA/debug digest checking.
        Stops after `timeout_s` without a new bundle (None = forever).
        """
        last_tick = None
        deadline = None if timeout_s is None else time.monotonic() + timeout_s
        while True:
            pointer = self._pointer()
            if pointer is not None and pointer[2] != last_tick:
                bundle = self._decode_bundle(pointer[0], pointer[1])
                if verify and not bundle.verify():
                    raise TornBundleError(f"bundle tick {bundle.sim_tick} failed verification")
                last_tick = bundle.sim_tick
                deadline = None if timeout_s is None else time.monotonic() + timeout_s
                yield bundle
                continue
            if deadline is not None and time.monotonic() > deadline:
                return
            time.sleep(poll_s)
