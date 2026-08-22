//! Wire protocol for the native render service.
//!
//! Conventions mirror packages/rl-env/src/env-server.ts: every message is one
//! u32-LE length-prefixed msgpack payload (max [`MAX_FRAME_BYTES`]); requests
//! carry `{ i: <sequence>, op: "<verb>", ... }`; responses echo `i`.
use serde::{Deserialize, Serialize};

/// Wire protocol version; bumped on any breaking frame change.
pub const NATIVE_SERVICE_PROTOCOL_VERSION: u32 = 1;

/// Hard cap on one framed message; guards against a corrupt length prefix.
pub const MAX_FRAME_BYTES: usize = 64 * 1024 * 1024;

/// One rig camera in a render request. Poses are absolute world-space
/// eye/target points (y-up), matching the spike / W0 camera convention.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceCamera {
    pub sensor_id: String,
    pub width: u32,
    pub height: u32,
    /// Vertical FOV degrees.
    pub fov_deg: f32,
    pub eye: [f32; 3],
    pub target: [f32; 3],
}

#[derive(Clone, Debug, Deserialize)]
pub struct WireRequest {
    #[serde(default)]
    pub i: u64,
    #[serde(flatten)]
    pub body: RequestBody,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum RequestBody {
    /// Handshake: protocol version, prewarmed scene info, shm location.
    Hello,
    /// Add more tiles before first render (map prewarm extension).
    Load { glbs: Vec<String> },
    /// Render one tick for the given cameras; passes rgb+id+depth.
    Render {
        tick_id: u64,
        cameras: Vec<ServiceCamera>,
        /// When present, PNG export of this tick happens asynchronously into
        /// this directory (PNG demoted to async export per WSB5).
        #[serde(default)]
        export_dir: Option<String>,
    },
    Close,
}

#[derive(Debug, Serialize)]
pub struct WireResponse {
    pub i: u64,
    #[serde(flatten)]
    pub body: ResponseBody,
}

#[derive(Debug, Serialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum ResponseBody {
    Hello {
        ok: bool,
        protocol: u32,
        profile: String,
        legend_entries: usize,
        shm: ShmInfo,
    },
    Load {
        ok: bool,
        tiles: usize,
    },
    Render {
        ok: bool,
        tick_id: u64,
        /// One record per produced pass payload.
        frames: Vec<FrameRecord>,
        /// Server-side render+publish wall time, milliseconds.
        server_ms: f64,
    },
    Close {
        ok: bool,
    },
    Error {
        ok: bool,
        error: String,
    },
}

/// Shared-memory ring descriptor handed out at hello.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ShmInfo {
    pub path: String,
    /// Total capacity bytes (including the meta page).
    pub size_bytes: u64,
    /// Records start after this many reserved bytes (meta page).
    pub meta_bytes: u64,
}

impl WireResponse {
    pub fn error(i: u64, error: impl Into<String>) -> Self {
        Self { i, body: ResponseBody::Error { ok: false, error: error.into() } }
    }
}

/// One produced pass payload published into the shm ring.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrameRecord {
    pub sensor_id: String,
    /// `rgb | id | depth`
    pub pass: String,
    /// Physical byte offset of the record start inside the shm file.
    pub offset: u64,
    /// Payload byte length (row-padded).
    pub len: u64,
    pub width: u32,
    pub height: u32,
    /// `rgba8` (RGB + ID) or `depth32f` (raw reverse-Z Depth32Float).
    pub format: String,
    pub tick_id: u64,
}

/* --------------------------------------------------------------- framing */

/// Incremental frame splitter: feed transport chunks, pull complete payloads
/// (same contract as rl-env's FrameReader).
pub struct FrameReader {
    buf: Vec<u8>,
}

impl FrameReader {
    pub fn new() -> Self {
        Self { buf: Vec::new() }
    }

    /// Feed one transport chunk; returns every complete payload in order.
    pub fn push(&mut self, chunk: &[u8]) -> Result<Vec<Vec<u8>>, String> {
        self.buf.extend_from_slice(chunk);
        let mut out = Vec::new();
        loop {
            if self.buf.len() < 4 {
                return Ok(out);
            }
            let len = u32::from_le_bytes([self.buf[0], self.buf[1], self.buf[2], self.buf[3]])
                as usize;
            if len > MAX_FRAME_BYTES {
                return Err(format!("frame length {len} exceeds cap"));
            }
            if self.buf.len() < 4 + len {
                return Ok(out);
            }
            out.push(self.buf[4..4 + len].to_vec());
            self.buf.drain(..4 + len);
        }
    }
}

/// Encode one length-prefixed msgpack-serializable message.
pub fn encode_frame<T: Serialize>(value: &T) -> Result<Vec<u8>, rmp_serde::encode::Error> {
    let payload = rmp_serde::to_vec_named(value)?;
    let mut out = Vec::with_capacity(4 + payload.len());
    out.extend_from_slice(&(payload.len() as u32).to_le_bytes());
    out.extend_from_slice(&payload);
    Ok(out)
}

/// Decode one length-prefixed request payload.
pub fn decode_request(payload: &[u8]) -> Result<WireRequest, String> {
    rmp_serde::from_slice(payload).map_err(|e| format!("bad request: {e}"))
}
