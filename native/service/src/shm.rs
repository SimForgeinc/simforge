//! Shared-memory ring buffer for zero-copy frame handoff.
//!
//! Layout: `[meta page: META_BYTES][records...]`. The meta page starts with
//! `u64 write_cursor_total` — the total number of payload bytes ever written
//! (monotonic). A record's physical offset is derived so records never
//! straddle the end of the file; consumers compute physical offsets from the
//! offsets returned in render responses and detect overruns via tick/seq
//! bookkeeping on their side.
use anyhow::{bail, Context, Result};
use memmap2::MmapMut;
use std::fs::OpenOptions;
use std::io::Write;
use std::path::Path;

/// Reserved meta bytes at the start of the ring.
pub const META_BYTES: u64 = 4096;
/// Fixed record header size preceding every payload.
pub const RECORD_HEADER_BYTES: usize = 128;
const RING_MAGIC: u64 = 0x554e_4953_4852_4931; // "UNISHRI1"

pub struct ShmRing {
    map: MmapMut,
    capacity: usize,
    /// Total payload+header bytes ever published (monotonic, starts at META).
    cursor_total: u64,
}

impl ShmRing {
    /// Create (or truncate) a shm-backed ring at `path`.
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
