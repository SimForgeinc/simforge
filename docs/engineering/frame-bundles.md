# Frame bundles (F4): atomic multi-camera sensor frames over the shm ring

Status: implemented (lane/shmbridge). Owner: ShmBridge. Consumed by PolicyStep's
`frameBundle` observation ref (`packages/training-env/src/policy-step.ts`).

The native render service (`renderer/service`) publishes per-tick, per-camera
frames into a single-writer shared-memory ring (`renderer/service/src/shm.rs`).
F4 adds *bundles*: one atomic record per sim tick covering ALL rig cameras, so
a policy runner can consume a calibrated multi-camera frame set zero-copy and
can never observe a torn (partially written) tick.

## Wire op: `render_bundle` (protocol V2, additive)

Request (`{i, op:"render_bundle", ...}` over the existing u32-LE
length-prefixed msgpack socket):

| field | type | semantics |
|---|---|---|
| `sim_tick` | u64 | bundle identity; becomes `tick_id` of every record |
| `cameras` | `ServiceCamera[]?` | upserts the retained rig (registration order kept). Omit on the hot loop; the rig persists across calls. `reset_cameras` clears it. |
| `tick_index` | u32? | scene-state frame to apply before rendering (as in `render`) |
| `passes` | string[]? | subset of `rgb\|id\|depth\|semantic`; default `["rgb"]`. GPU pass set is frozen per camera at first registration. |

Response: `{ok, sim_tick, bundle_offset, bundle_len, frames[], server_ms}` —
`frames[]` are the usual FrameRecords plus `digest` (CRC32/IEEE of payload
bytes, 8-char lowercase hex). `bundle_offset`/`bundle_len` locate the bundle
record for `bundle_at`-style consumers and PolicyStep frameBundle refs.

Publish order per tick (single writer, deterministic): every camera in rig
registration order × requested passes in canonical order (rgb, id, depth,
semantic) → one `bundle` table record → meta-page latest-bundle pointer flip.

## Ring layout additions

All integers little-endian. Pre-existing: meta page `[0..8)` magic
`"UNISHRI1"`, `[8..16)` monotonic `write_cursor_total`; 128-byte record
headers; records never straddle the file end.

Meta page (new):

| bytes | field |
|---|---|
| `[16..24)` | bundle seqlock (0 = never published; odd = writer mid-flip) |
| `[24..32)` | latest bundle record offset (physical, header start) |
| `[32..40)` | latest bundle payload length |
| `[40..48)` | latest bundle `sim_tick` |

Bundle record: ordinary ring record with `sensor_id="__bundle__"`,
`pass="bundle"`, format tag `4`. Payload:

```
header (32 B): magic "SFBNDL01" u64 | sim_tick u64 | start_cursor u64
               | n_entries u32 | entries_crc u32 (CRC32 of entries region)
entry  (96 B): camera_id[48] | pass[16] | payload_offset u64 | payload_len u64
               | width u32 | height u32 | format u32 | digest u32
```

`payload_offset` points at PAYLOAD bytes (record header at `-128`).
`digest` is CRC32 (IEEE) of the payload — deterministic per rendered frame,
`zlib.crc32` / `crc32fast` / `@simforge/render` `crc32()` all agree.
Payloads keep the wgpu 256-byte row alignment: `rowStride = payload_len /
height` for 4-byte-per-pixel formats.

## Atomicity contract (consumers never see torn bundles)

1. **Pointer**: seqlock read of `[16..48)` — retry while odd or changed.
2. **Table**: `entries_crc` covers the whole entries region; a mid-overwrite
   bundle record fails CRC (or magic) and is rejected.
3. **Payloads**: per-frame `digest` verify (QA / non-hot paths).
4. **Liveness (hot loop)**: `write_cursor_total - start_cursor <=
   capacity - 4096` — cheap check that the writer has not lapped the ring
   since this bundle's first frame. Size the ring for ≥2 bundles (the service
   also refuses to publish a bundle larger than the ring).

## Consumer APIs

**Python (policy runner, zero-copy)** — `renderer/service/python/simforge_native`:

```python
from simforge_native import BundleRingReader, NativeRenderClient

# Pull mode (separate process, shm only):
reader = BundleRingReader("/dev/shm/<ring>")
for bundle in reader.iter_bundles():          # yields each new sim_tick
    obs = bundle.views()                      # {cam: {pass: np view}} zero-copy
    ...                                       # (H,W,4) u8 rgba8 / (H,W) f32 depth
    if not bundle.still_valid(): continue     # writer lapped mid-use
reader.latest(verify=True)                    # digest-verified snapshot
reader.bundle_at(offset, length)              # from a frameBundle ref

# Push mode (same process as the RPC driver):
client = NativeRenderClient(socket_path)
obs, resp = client.step_bundle(sim_tick, cameras)   # cameras only on first call
```

Zero-copy views pin the mmap: drop views before `reader.close()`.
`verify=True` raises `TornBundleError` on any digest/liveness failure.

**TypeScript (studio worker, copying)** — `@simforge/render/native`:

```ts
import { ShmBundleReader } from '@simforge/render/native';
const reader = new ShmBundleReader(shmPath);
const bundle = reader.latestNew();   // null until a NEW sim_tick appears
// bundle.entries[i]: {cameraId, pass, byteOffset, byteLength, width, height,
//                     format, digest}; bundle.payloads[i]: verified Buffer copy
```

Every payload is copied and digest-verified at read time; `TornBundleError`
means the writer lapped mid-read — retry on the next poll.

**Rust (in-repo)** — `service::shm::{read_bundle_pointer, decode_bundle,
read_record_header}` mirror the same protocol for tests and future native
consumers.

## PolicyStep frameBundle mapping

`FrameBundleRef {shmName, simTick, cameras[]}` (locked with PolicyStep
2026-08-24): `shmName` = ring path from `hello.shm.path`; per camera
`{id, digest, byteOffset, byteLength, width, height, format}` map 1:1 from
the `render_bundle` response frames (`digest` hex, `byteOffset = offset+128`).

## Tests & bench

- Rust: `cargo test -p service shm::` — bundle roundtrip, torn-table CRC,
  seqlock pointer + digest validation, wraparound expiry, no-straddle.
- Python: `python3 -m pytest tests/test_bundles.py` (from
  `renderer/service/python`) against `renderer/service/testdata/
  bundle-ring.shm.gz`, a ring recorded by the real service.
- TS: `npx vitest run src/native/shm-bundles.test.ts` (packages/render),
  same recorded ring.
- Bench: `renderer/service/python/bench_bundles.py` — sustained 10 Hz
  render+publish+consume latency; results in the lane report.
