//! Shared-memory ring buffer for zero-copy frame handoff.
//!
//! Layout: `[meta page: META_BYTES][records...]`. The meta page starts with
//! `u64 write_cursor_total` — the total number of payload bytes ever written
//! (monotonic). A record's physical offset is derived so records never
//! straddle the end of the file; consumers compute physical offsets from the
//! offsets returned in render responses and detect overruns via tick/seq
//! bookkeeping on their side.
//!
//! # Frame bundles (F4)
//!
//! A *bundle* is one atomic multi-camera tick: every per-camera frame record
//! is published first, then a single `bundle` record whose payload is a fixed
//! binary table over those frames (see [`encode_bundle`]), then the
//! latest-bundle pointer in the meta page is updated behind a seqlock.
//! Consumers therefore never observe a torn bundle:
//!
//! * the seqlock ([`META_BUNDLE_SEQ`]) guards the pointer triple
//!   (offset, len, sim_tick) — retry while odd or changed;
//! * `entries_crc` guards the bundle table itself;
//! * per-frame CRC32 digests (deterministic per rendered frame) guard the
//!   payload bytes;
//! * `start_cursor` allows the cheap liveness check
//!   `meta_write_cursor - start_cursor <= usable_bytes` — once the writer
//!   has lapped, the bundle is expired without touching payload bytes.
use anyhow::{bail, Context, Result};
use memmap2::MmapMut;
use std::fs::OpenOptions;
use std::io::Write;
use std::path::Path;
use std::sync::atomic::{fence, Ordering};

/// Reserved meta bytes at the start of the ring.
pub const META_BYTES: u64 = 4096;
/// Fixed record header size preceding every payload.
pub const RECORD_HEADER_BYTES: usize = 128;
const RING_MAGIC: u64 = 0x554e_4953_4852_4931; // "UNISHRI1"

/// Meta-page byte offsets of the latest-bundle pointer (all u64 LE).
/// `[0..8)` ring magic, `[8..16)` write_cursor_total (pre-existing).
pub const META_BUNDLE_SEQ: usize = 16;
pub const META_BUNDLE_OFFSET: usize = 24;
pub const META_BUNDLE_LEN: usize = 32;
pub const META_BUNDLE_TICK: usize = 40;

pub struct ShmRing {
    map: MmapMut,
    capacity: usize,
    /// Total payload+header bytes ever published (monotonic, starts at META).
    cursor_total: u64,
}


/// Record payload format tags (shm header offset 20).
pub const FORMAT_RGBA8: u32 = 1;
pub const FORMAT_DEPTH32F: u32 = 2;
/// V2: JPEG bytes (EncodeJpeg op).
pub const FORMAT_JPEG: u32 = 3;
/// F4: frame-bundle table record (see [`encode_bundle`]).
pub const FORMAT_BUNDLE: u32 = 4;

/// Reserved sensor id of bundle records in the ring.
pub const BUNDLE_SENSOR_ID: &str = "__bundle__";
/// Bundle payload magic: ASCII "SFBNDL01" little-endian.
pub const BUNDLE_MAGIC: u64 = u64::from_le_bytes(*b"SFBNDL01");
/// Fixed bundle payload header size.
pub const BUNDLE_HEADER_BYTES: usize = 32;
/// Fixed per-camera entry size in a bundle payload.
pub const BUNDLE_ENTRY_BYTES: usize = 96;
const BUNDLE_ID_BYTES: usize = 48;
const BUNDLE_PASS_BYTES: usize = 16;

/// One frame reference inside a bundle table.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BundleEntry {
    pub camera_id: String,
    pub pass: String,
    /// Physical byte offset of the PAYLOAD in the shm file (the 128-byte
    /// record header sits at `payload_offset - RECORD_HEADER_BYTES`).
    pub payload_offset: u64,
    pub payload_len: u64,
    pub width: u32,
    pub height: u32,
    pub format_tag: u32,
    /// CRC32 (IEEE) of the payload bytes.
    pub digest: u32,
}

/// Decoded bundle table.
#[derive(Clone, Debug)]
pub struct Bundle {
    pub sim_tick: u64,
    /// Writer's logical cursor before the first frame of this bundle.
    pub start_cursor: u64,
    pub entries: Vec<BundleEntry>,
}

/// Latest-bundle pointer read from the meta page.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BundlePointer {
    /// Physical offset of the bundle RECORD header.
    pub record_offset: u64,
    /// Bundle payload length.
    pub payload_len: u64,
    pub sim_tick: u64,
}

/// Encode a bundle table payload.
///
/// Layout (little-endian): `[0..8)` magic, `[8..16)` sim_tick,
/// `[16..24)` start_cursor, `[24..28)` n_entries u32, `[28..32)` entries_crc
/// u32 (CRC32 of the entries region), then `n_entries` fixed 96-byte
/// entries: id[48] pass[16] payload_offset u64, payload_len u64, width u32,
/// height u32, format_tag u32, digest u32.
pub fn encode_bundle(sim_tick: u64, start_cursor: u64, entries: &[BundleEntry]) -> Vec<u8> {
    let mut out = vec![0u8; BUNDLE_HEADER_BYTES + entries.len() * BUNDLE_ENTRY_BYTES];
    for (i, e) in entries.iter().enumerate() {
        let b = &mut out[BUNDLE_HEADER_BYTES + i * BUNDLE_ENTRY_BYTES..][..BUNDLE_ENTRY_BYTES];
        let id = e.camera_id.as_bytes();
        b[..id.len().min(BUNDLE_ID_BYTES)].copy_from_slice(&id[..id.len().min(BUNDLE_ID_BYTES)]);
        let p = e.pass.as_bytes();
        b[BUNDLE_ID_BYTES..BUNDLE_ID_BYTES + p.len().min(BUNDLE_PASS_BYTES)]
            .copy_from_slice(&p[..p.len().min(BUNDLE_PASS_BYTES)]);
        b[64..72].copy_from_slice(&e.payload_offset.to_le_bytes());
        b[72..80].copy_from_slice(&e.payload_len.to_le_bytes());
        b[80..84].copy_from_slice(&e.width.to_le_bytes());
        b[84..88].copy_from_slice(&e.height.to_le_bytes());
        b[88..92].copy_from_slice(&e.format_tag.to_le_bytes());
        b[92..96].copy_from_slice(&e.digest.to_le_bytes());
    }
    let entries_crc = crc32fast::hash(&out[BUNDLE_HEADER_BYTES..]);
    out[0..8].copy_from_slice(&BUNDLE_MAGIC.to_le_bytes());
    out[8..16].copy_from_slice(&sim_tick.to_le_bytes());
    out[16..24].copy_from_slice(&start_cursor.to_le_bytes());
    out[24..28].copy_from_slice(&(entries.len() as u32).to_le_bytes());
    out[28..32].copy_from_slice(&entries_crc.to_le_bytes());
    out
}

/// Decode and validate a bundle table payload (magic + entries CRC).
pub fn decode_bundle(payload: &[u8]) -> Result<Bundle> {
    if payload.len() < BUNDLE_HEADER_BYTES {
        bail!("bundle payload too short: {}", payload.len());
    }
    let magic = u64::from_le_bytes(payload[0..8].try_into().unwrap());
    if magic != BUNDLE_MAGIC {
        bail!("bad bundle magic {magic:#x}");
    }
    let sim_tick = u64::from_le_bytes(payload[8..16].try_into().unwrap());
    let start_cursor = u64::from_le_bytes(payload[16..24].try_into().unwrap());
    let n = u32::from_le_bytes(payload[24..28].try_into().unwrap()) as usize;
    let entries_crc = u32::from_le_bytes(payload[28..32].try_into().unwrap());
    let want = BUNDLE_HEADER_BYTES + n * BUNDLE_ENTRY_BYTES;
    if payload.len() < want {
        bail!("bundle payload truncated: {} < {want}", payload.len());
    }
    let entries_region = &payload[BUNDLE_HEADER_BYTES..want];
    let got_crc = crc32fast::hash(entries_region);
    if got_crc != entries_crc {
        bail!("bundle entries CRC mismatch (torn bundle): {got_crc:#x} != {entries_crc:#x}");
    }
    let mut entries = Vec::with_capacity(n);
    for i in 0..n {
        let b = &entries_region[i * BUNDLE_ENTRY_BYTES..][..BUNDLE_ENTRY_BYTES];
        let cstr = |s: &[u8]| {
            let end = s.iter().position(|&c| c == 0).unwrap_or(s.len());
            String::from_utf8_lossy(&s[..end]).into_owned()
        };
        entries.push(BundleEntry {
            camera_id: cstr(&b[..BUNDLE_ID_BYTES]),
            pass: cstr(&b[BUNDLE_ID_BYTES..64]),
            payload_offset: u64::from_le_bytes(b[64..72].try_into().unwrap()),
            payload_len: u64::from_le_bytes(b[72..80].try_into().unwrap()),
            width: u32::from_le_bytes(b[80..84].try_into().unwrap()),
            height: u32::from_le_bytes(b[84..88].try_into().unwrap()),
            format_tag: u32::from_le_bytes(b[88..92].try_into().unwrap()),
            digest: u32::from_le_bytes(b[92..96].try_into().unwrap()),
        });
    }
    Ok(Bundle { sim_tick, start_cursor, entries })
}

/// Seqlock read of the latest-bundle pointer from a mapped ring.
/// Returns None while no bundle has ever been published.
pub fn read_bundle_pointer(map: &[u8]) -> Option<BundlePointer> {
    loop {
        let s1 = u64::from_le_bytes(map[META_BUNDLE_SEQ..META_BUNDLE_SEQ + 8].try_into().unwrap());
        if s1 == 0 {
            return None;
        }
        if s1 % 2 == 1 {
            std::hint::spin_loop();
            continue;
        }
        fence(Ordering::Acquire);
        let record_offset =
            u64::from_le_bytes(map[META_BUNDLE_OFFSET..META_BUNDLE_OFFSET + 8].try_into().unwrap());
        let payload_len =
            u64::from_le_bytes(map[META_BUNDLE_LEN..META_BUNDLE_LEN + 8].try_into().unwrap());
        let sim_tick =
            u64::from_le_bytes(map[META_BUNDLE_TICK..META_BUNDLE_TICK + 8].try_into().unwrap());
        fence(Ordering::Acquire);
        let s2 = u64::from_le_bytes(map[META_BUNDLE_SEQ..META_BUNDLE_SEQ + 8].try_into().unwrap());
        if s1 == s2 {
            return Some(BundlePointer { record_offset, payload_len, sim_tick });
        }
    }
}

impl ShmRing {
    pub fn create(path: &Path, capacity_bytes: usize) -> Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).ok();
        }
        if capacity_bytes < META_BYTES as usize + 1024 {
            bail!("shm capacity too small");
        }
        // /dev/shm is tmpfs; plain files elsewhere also work for local demos.
        let mut file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(true)
            .open(path)
            .with_context(|| format!("open {}", path.display()))?;
        file.set_len(capacity_bytes as u64)?;
        file.write_all(&[])?;
        let mut map = unsafe { MmapMut::map_mut(&file)? };
        map[..8].copy_from_slice(&RING_MAGIC.to_le_bytes());
        map[8..16].copy_from_slice(&0u64.to_le_bytes());
        map.flush()?;
        Ok(Self { map, capacity: capacity_bytes, cursor_total: META_BYTES })
    }

    pub fn path_size_meta(&self) -> (u64, u64, u64) {
        (
            self.capacity as u64,
            META_BYTES,
            self.cursor_total,
        )
    }

    fn usable(&self) -> usize {
        self.capacity - META_BYTES as usize
    }

    /// Data-area capacity in bytes (excludes the meta page).
    pub fn usable_bytes(&self) -> u64 {
        self.usable() as u64
    }

    /// Writer's monotonic logical cursor (starts at META_BYTES).
    pub fn cursor_total(&self) -> u64 {
        self.cursor_total
    }

    /// Publish an atomic bundle table over already-published frame records,
    /// then flip the meta-page latest-bundle pointer behind the seqlock.
    /// Returns `(record_offset, payload_len)` of the bundle record.
    pub fn publish_bundle(
        &mut self,
        sim_tick: u64,
        start_cursor: u64,
        entries: &[BundleEntry],
    ) -> Result<(u64, u64)> {
        let payload = encode_bundle(sim_tick, start_cursor, entries);
        let record_offset = self.publish(
            BUNDLE_SENSOR_ID,
            "bundle",
            entries.len() as u32,
            0,
            FORMAT_BUNDLE,
            sim_tick,
            &payload,
        )?;
        // Seqlock write: odd -> fields -> even. Single writer by design.
        let seq0 = u64::from_le_bytes(
            self.map[META_BUNDLE_SEQ..META_BUNDLE_SEQ + 8].try_into().unwrap(),
        );
        self.map[META_BUNDLE_SEQ..META_BUNDLE_SEQ + 8].copy_from_slice(&(seq0 + 1).to_le_bytes());
        fence(Ordering::Release);
        self.map[META_BUNDLE_OFFSET..META_BUNDLE_OFFSET + 8]
            .copy_from_slice(&record_offset.to_le_bytes());
        self.map[META_BUNDLE_LEN..META_BUNDLE_LEN + 8]
            .copy_from_slice(&(payload.len() as u64).to_le_bytes());
        self.map[META_BUNDLE_TICK..META_BUNDLE_TICK + 8].copy_from_slice(&sim_tick.to_le_bytes());
        fence(Ordering::Release);
        self.map[META_BUNDLE_SEQ..META_BUNDLE_SEQ + 8].copy_from_slice(&(seq0 + 2).to_le_bytes());
        Ok((record_offset, payload.len() as u64))
    }

    /// Read-only view of the whole mapped ring (tests / same-process readers).
    pub fn as_bytes(&self) -> &[u8] {
        &self.map
    }

    /// Publish one record; returns its physical offset in the file.
    #[allow(clippy::too_many_arguments)]
    pub fn publish(
        &mut self,
        sensor_id: &str,
        pass: &str,
        width: u32,
        height: u32,
        format_tag: u32,
        tick_id: u64,
        payload: &[u8],
    ) -> Result<u64> {
        let record_len = RECORD_HEADER_BYTES + payload.len();
        if record_len > self.usable() {
            bail!("record {} bytes exceeds ring usable capacity", record_len);
        }
        // Physical position of cursor within the data area; wrap early enough
        // that the whole record fits before the end of the file.
        let pos = (self.cursor_total % self.capacity as u64) as usize;
        let max = self.capacity;
        let start_phys = if pos < META_BYTES as usize || pos + record_len > max {
            META_BYTES as usize
        } else {
            pos
        };
        if start_phys == META_BYTES as usize && pos != META_BYTES as usize {
            // Wrapped: resync cursor to the new generation boundary.
            let generation = self.cursor_total / self.capacity as u64;
            self.cursor_total = (generation + 1) * self.capacity as u64 + META_BYTES as u64;
        }

        let header = build_header(
            sensor_id,
            pass,
            width,
            height,
            format_tag,
            tick_id,
            payload.len() as u64,
        );
        self.map[start_phys..start_phys + RECORD_HEADER_BYTES].copy_from_slice(&header);
        self.map[start_phys + RECORD_HEADER_BYTES..start_phys + record_len]
            .copy_from_slice(payload);

        // Meta page: expose the post-write cursor for consumer overrun checks.
        let after = self.cursor_total + record_len as u64;
        self.map[8..16].copy_from_slice(&after.to_le_bytes());
        self.cursor_total = after;
        Ok(start_phys as u64)
    }
}

fn build_header(
    sensor_id: &str,
    pass: &str,
    width: u32,
    height: u32,
    format_tag: u32,
    tick_id: u64,
    payload_len: u64,
) -> [u8; RECORD_HEADER_BYTES] {
    let mut h = [0u8; RECORD_HEADER_BYTES];
    h[0..8].copy_from_slice(&RING_MAGIC.to_le_bytes());
    h[8..12].copy_from_slice(&1u32.to_le_bytes()); // header version
    h[12..16].copy_from_slice(&width.to_le_bytes());
    h[16..20].copy_from_slice(&height.to_le_bytes());
    h[20..24].copy_from_slice(&format_tag.to_le_bytes());
    h[24..32].copy_from_slice(&tick_id.to_le_bytes());
    h[32..40].copy_from_slice(&payload_len.to_le_bytes());
    let sid = sensor_id.as_bytes();
    h[40..(40 + sid.len().min(56))].copy_from_slice(&sid[..sid.len().min(56)]);
    let p = pass.as_bytes();
    h[96..(96 + p.len().min(32))].copy_from_slice(&p[..p.len().min(32)]);
    h
}

/// Parsed 128-byte record header (consumer mirror of [`build_header`]).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RecordHeader {
    pub width: u32,
    pub height: u32,
    pub format_tag: u32,
    pub tick_id: u64,
    pub payload_len: u64,
    pub sensor_id: String,
    pub pass: String,
}

/// Parse the record header at physical `offset` in a mapped ring.
pub fn read_record_header(map: &[u8], offset: usize) -> Result<RecordHeader> {
    if offset + RECORD_HEADER_BYTES > map.len() {
        bail!("record offset {offset} out of bounds");
    }
    let h = &map[offset..offset + RECORD_HEADER_BYTES];
    let magic = u64::from_le_bytes(h[0..8].try_into().unwrap());
    if magic != RING_MAGIC {
        bail!("bad record magic at {offset}: {magic:#x}");
    }
    let cstr = |s: &[u8]| {
        let end = s.iter().position(|&c| c == 0).unwrap_or(s.len());
        String::from_utf8_lossy(&s[..end]).into_owned()
    };
    Ok(RecordHeader {
        width: u32::from_le_bytes(h[12..16].try_into().unwrap()),
        height: u32::from_le_bytes(h[16..20].try_into().unwrap()),
        format_tag: u32::from_le_bytes(h[20..24].try_into().unwrap()),
        tick_id: u64::from_le_bytes(h[24..32].try_into().unwrap()),
        payload_len: u64::from_le_bytes(h[32..40].try_into().unwrap()),
        sensor_id: cstr(&h[40..96]),
        pass: cstr(&h[96..128]),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_ring(name: &str, capacity: usize) -> (std::path::PathBuf, ShmRing) {
        let path = std::env::temp_dir().join(format!("sf-shm-test-{name}-{}", std::process::id()));
        let ring = ShmRing::create(&path, capacity).unwrap();
        (path, ring)
    }

    /// Publish one camera frame; return its bundle entry.
    fn publish_frame(ring: &mut ShmRing, cam: &str, tick: u64, payload: &[u8]) -> BundleEntry {
        let offset = ring.publish(cam, "rgb", 4, 2, FORMAT_RGBA8, tick, payload).unwrap();
        BundleEntry {
            camera_id: cam.into(),
            pass: "rgb".into(),
            payload_offset: offset + RECORD_HEADER_BYTES as u64,
            payload_len: payload.len() as u64,
            width: 4,
            height: 2,
            format_tag: FORMAT_RGBA8,
            digest: crc32fast::hash(payload),
        }
    }

    fn publish_bundle_tick(ring: &mut ShmRing, tick: u64, cams: &[&str]) -> (u64, u64, Vec<BundleEntry>) {
        let start_cursor = ring.cursor_total();
        let entries: Vec<BundleEntry> = cams
            .iter()
            .map(|cam| {
                let payload: Vec<u8> = (0..32u8).map(|b| b.wrapping_mul(tick as u8 + 1)).collect();
                publish_frame(ring, cam, tick, &payload)
            })
            .collect();
        let (offset, len) = ring.publish_bundle(tick, start_cursor, &entries).unwrap();
        (offset, len, entries)
    }

    /// Full consumer-side validation of the latest bundle: seqlock pointer,
    /// record header, table CRC, liveness window, per-frame digests.
    fn validate_latest(ring: &ShmRing, expect_tick: u64) -> Result<Bundle> {
        let map = ring.as_bytes();
        let ptr = read_bundle_pointer(map).context("no bundle pointer")?;
        anyhow::ensure!(ptr.sim_tick == expect_tick, "pointer tick {} != {expect_tick}", ptr.sim_tick);
        let header = read_record_header(map, ptr.record_offset as usize)?;
        anyhow::ensure!(header.sensor_id == BUNDLE_SENSOR_ID && header.format_tag == FORMAT_BUNDLE);
        anyhow::ensure!(header.tick_id == expect_tick);
        let start = ptr.record_offset as usize + RECORD_HEADER_BYTES;
        let bundle = decode_bundle(&map[start..start + ptr.payload_len as usize])?;
        anyhow::ensure!(bundle.sim_tick == expect_tick);
        // Liveness: writer must not have lapped past the bundle's frames.
        let cursor_now = u64::from_le_bytes(map[8..16].try_into().unwrap());
        anyhow::ensure!(
            cursor_now - bundle.start_cursor <= ring.usable_bytes(),
            "bundle expired (writer lapped)"
        );
        for e in &bundle.entries {
            let payload = &map[e.payload_offset as usize..(e.payload_offset + e.payload_len) as usize];
            anyhow::ensure!(crc32fast::hash(payload) == e.digest, "frame digest mismatch for {}", e.camera_id);
            let rh = read_record_header(map, e.payload_offset as usize - RECORD_HEADER_BYTES)?;
            anyhow::ensure!(rh.tick_id == expect_tick && rh.sensor_id == e.camera_id);
        }
        Ok(bundle)
    }

    #[test]
    fn bundle_encode_decode_roundtrip() {
        let entries = vec![
            BundleEntry {
                camera_id: "front".into(),
                pass: "rgb".into(),
                payload_offset: 4224,
                payload_len: 32,
                width: 4,
                height: 2,
                format_tag: FORMAT_RGBA8,
                digest: 0xdead_beef,
            },
            BundleEntry {
                camera_id: "rear".into(),
                pass: "depth".into(),
                payload_offset: 8448,
                payload_len: 64,
                width: 4,
                height: 2,
                format_tag: FORMAT_DEPTH32F,
                digest: 1,
            },
        ];
        let payload = encode_bundle(7, 4096, &entries);
        assert_eq!(payload.len(), BUNDLE_HEADER_BYTES + 2 * BUNDLE_ENTRY_BYTES);
        let bundle = decode_bundle(&payload).unwrap();
        assert_eq!(bundle.sim_tick, 7);
        assert_eq!(bundle.start_cursor, 4096);
        assert_eq!(bundle.entries, entries);
        // Determinism: identical input encodes byte-identically.
        assert_eq!(payload, encode_bundle(7, 4096, &entries));
    }

    #[test]
    fn torn_bundle_table_is_detected() {
        let entries = vec![BundleEntry {
            camera_id: "front".into(),
            pass: "rgb".into(),
            payload_offset: 4224,
            payload_len: 32,
            width: 4,
            height: 2,
            format_tag: FORMAT_RGBA8,
            digest: 3,
        }];
        let mut payload = encode_bundle(1, 4096, &entries);
        payload[BUNDLE_HEADER_BYTES + 70] ^= 0xff; // corrupt payload_len field
        let err = decode_bundle(&payload).unwrap_err().to_string();
        assert!(err.contains("CRC mismatch"), "{err}");
    }

    #[test]
    fn latest_bundle_pointer_and_digests_validate() {
        let (path, mut ring) = temp_ring("latest", META_BYTES as usize + 64 * 1024);
        assert!(read_bundle_pointer(ring.as_bytes()).is_none(), "no pointer before first bundle");
        publish_bundle_tick(&mut ring, 1, &["front", "rear"]);
        let (offset, len, entries) = publish_bundle_tick(&mut ring, 2, &["front", "rear"]);
        let ptr = read_bundle_pointer(ring.as_bytes()).unwrap();
        assert_eq!(ptr, BundlePointer { record_offset: offset, payload_len: len, sim_tick: 2 });
        let bundle = validate_latest(&ring, 2).unwrap();
        assert_eq!(bundle.entries, entries);
        // Seqlock is even and counted one increment pair per bundle.
        let seq = u64::from_le_bytes(ring.as_bytes()[META_BUNDLE_SEQ..META_BUNDLE_SEQ + 8].try_into().unwrap());
        assert_eq!(seq, 4);
        drop(ring);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn records_never_straddle_ring_end() {
        let capacity = META_BYTES as usize + 2048;
        let (path, mut ring) = temp_ring("straddle", capacity);
        let mut last_cursor = ring.cursor_total();
        for tick in 0..200u64 {
            let payload = vec![tick as u8; 100 + (tick as usize * 37) % 400];
            let offset = ring.publish("cam", "rgb", 4, 2, FORMAT_RGBA8, tick, &payload).unwrap();
            assert!(offset >= META_BYTES, "record in meta page");
            assert!(
                offset as usize + RECORD_HEADER_BYTES + payload.len() <= capacity,
                "record straddles file end"
            );
            assert!(ring.cursor_total() > last_cursor, "cursor not monotonic");
            last_cursor = ring.cursor_total();
            // Meta write-cursor mirrors the writer cursor.
            let meta_cursor = u64::from_le_bytes(ring.as_bytes()[8..16].try_into().unwrap());
            assert_eq!(meta_cursor, ring.cursor_total());
        }
        drop(ring);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn wraparound_expires_stale_bundle() {
        // Ring only big enough for a handful of records: force a lap.
        let capacity = META_BYTES as usize + 4096;
        let (path, mut ring) = temp_ring("wrap", capacity);
        let (offset, len, entries) = publish_bundle_tick(&mut ring, 1, &["front"]);
        validate_latest(&ring, 1).unwrap();
        // Writer laps the ring with later frames (no new bundle).
        for tick in 2..40u64 {
            let payload = vec![tick as u8; 512];
            ring.publish("front", "rgb", 4, 2, FORMAT_RGBA8, tick, &payload).unwrap();
        }
        // The stale pointer still points at tick 1's bundle record location...
        let ptr = read_bundle_pointer(ring.as_bytes()).unwrap();
        assert_eq!(ptr, BundlePointer { record_offset: offset, payload_len: len, sim_tick: 1 });
        // ...but the liveness window rejects it without touching payloads.
        let map = ring.as_bytes();
        let cursor_now = u64::from_le_bytes(map[8..16].try_into().unwrap());
        let start_cursor = entries[0].payload_offset; // logical == physical pre-wrap
        assert!(
            cursor_now - (start_cursor - RECORD_HEADER_BYTES as u64) > ring.usable_bytes(),
            "expected writer to have lapped"
        );
        assert!(validate_latest(&ring, 1).is_err(), "stale bundle must fail validation");
        // A fresh bundle after the lap validates again.
        publish_bundle_tick(&mut ring, 40, &["front"]);
        validate_latest(&ring, 40).unwrap();
        drop(ring);
        let _ = std::fs::remove_file(path);
    }
}
