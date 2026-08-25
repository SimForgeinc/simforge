//! Wire protocol for the native render service.
//!
//! Conventions mirror packages/rl-env/src/env-server.ts: every message is one
//! u32-LE length-prefixed msgpack payload (max [`MAX_FRAME_BYTES`]); requests
//! carry `{ i: <sequence>, op: "<verb>", ... }`; responses echo `i`.
use serde::{Deserialize, Serialize};

/// Wire protocol version; bumped on any breaking frame change.
///
/// V2 (V4 SensorRig): adds `load_scene_state`, `reset_cameras`,
/// `encode_jpeg`; extends `render` with optional `tickIndex`; extends
/// cameras with optional rigid `attach`, `semantic`, and CARLA
/// `depthEncoding`. All V2 additions are optional; V1 clients keep working.
pub const NATIVE_SERVICE_PROTOCOL_VERSION: u32 = 2;

/// Rigid attachment of a camera to a scene-state actor (CARLA
/// `AttachmentType.Rigid` analogue): the pose is re-resolved from the
/// actor's transform on every rendered tick, so the camera never lags or
/// springs. `offsetM` is the mount position in actor-local frame
/// (x forward, y right, z up, metres); yaw/pitch are degrees relative to
/// the actor heading.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CameraAttach {
    pub actor_id: String,
    #[serde(default)]
    pub offset_m: [f32; 3],
    #[serde(default)]
    pub yaw_deg: f32,
    #[serde(default)]
    pub pitch_deg: f32,
    /// Aim at the attached actor origin instead of projecting the mount's
    /// yaw/pitch. Intended for trailing chase cameras; sensor mounts leave it
    /// false and retain their calibrated rigid orientation.
    #[serde(default)]
    pub look_at_actor: bool,
}

/// Hard cap on one framed message; guards against a corrupt length prefix.
pub const MAX_FRAME_BYTES: usize = 64 * 1024 * 1024;

#[derive(Clone, Debug, Deserialize)]
pub struct WireRequest {
    #[serde(default)]
    pub i: u64,
    #[serde(flatten)]
    pub body: RequestBody,
}

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
    /// V2: also produce the semantic output (derived from the instance-ID
    /// pass, CARLA byte layout). Requires an `id`-capable camera.
    #[serde(default)]
    pub semantic: bool,
    /// V2: `"linear"` (default, raw reverse-Z Depth32Float passthrough) or
    /// `"carla"` (24-bit fixed point over a 1000 m far plane, BGRA order).
    #[serde(default)]
    pub depth_encoding: Option<String>,
    /// V2: rigid attachment — when present, eye/target are re-resolved from
    /// the attached actor's scene-state transform every render and the
    /// explicit eye/target fields are ignored.
    #[serde(default)]
    pub attach: Option<CameraAttach>,
    /// Optional per-camera render profile. Omit to inherit the service scene
    /// profile. A campaign chase camera can therefore be cinematic while the
    /// retained Pronto cameras remain sensor-profile and hash-stable.
    #[serde(default)]
    pub profile: Option<render_core::engine::Profile>,
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
        /// V2: apply this frame index of the loaded scene-state stream before
        /// rendering (actor spawn/update/despawn + ego attach resolution).
        #[serde(default)]
        tick_index: Option<u32>,
    },
    /// V2: load a scene-state.v1 stream (one document per tick, in order).
    /// Actors are created lazily on the first rendered tick that references
    /// them. `mapId`/`xodrSha256` must match the prewarmed scene contract.
    LoadSceneState { states: Vec<crate::scene::SceneState> },
    /// V2: drop every registered camera; the next `render` re-registers with
    /// fresh attributes (CARLA respawn-on-view-change analogue).
    ResetCameras,
    /// V2: JPEG-encode cached pass payloads from the last rendered tick and
    /// publish the results into the shm ring as `jpeg` records.
    EncodeJpeg { items: Vec<JpegItem> },
    /// F4: render every rig camera for one sim tick and publish an atomic
    /// frame bundle (per-camera frames + one bundle table record + the
    /// meta-page latest-bundle pointer). `cameras`, when present, upserts the
    /// retained rig (registration order preserved); when absent, the rig from
    /// previous `render_bundle`/`render` calls is reused. `passes` defaults
    /// to `["rgb"]` and is frozen per camera at first registration
    /// (`reset_cameras` to change).
    RenderBundle {
        sim_tick: u64,
        #[serde(default)]
        cameras: Option<Vec<ServiceCamera>>,
        /// Scene-state frame to apply before rendering (as in `render`).
        #[serde(default)]
        tick_index: Option<u32>,
        /// Subset of `rgb | id | depth | semantic`.
        #[serde(default)]
        passes: Option<Vec<String>>,
    },
    Close,
}

/// One requested JPEG encoding from the last rendered tick's cache.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JpegItem {
    pub sensor_id: String,
    pub pass: String,
    pub quality: u8,
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
    /// V2: scene-state stream accepted.
    LoadSceneState {
        ok: bool,
        ticks: usize,
        map_id: String,
    },
    /// V2: all cameras dropped.
    ResetCameras {
        ok: bool,
    },
    /// V2: JPEG records published into the shm ring.
    EncodeJpeg {
        ok: bool,
        tick_id: u64,
        frames: Vec<FrameRecord>,
        /// Server-side encode+publish wall time, milliseconds.
        server_ms: f64,
    },
    /// F4: atomic frame bundle published.
    RenderBundle {
        ok: bool,
        sim_tick: u64,
        /// Physical offset of the bundle RECORD header in the shm file.
        bundle_offset: u64,
        /// Bundle table payload length.
        bundle_len: u64,
        /// One record per published frame, digests populated.
        frames: Vec<FrameRecord>,
        /// Server-side render+publish wall time, milliseconds.
        server_ms: f64,
    },
    Render {
        ok: bool,
        tick_id: u64,
        /// One record per produced pass payload.
        frames: Vec<FrameRecord>,
        /// Server-side render+publish wall time, milliseconds.
        server_ms: f64,
        /// Fraction of camera pixels whose instance ID is non-zero.
        coverage: Vec<CoverageRecord>,
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
    /// `rgb | id | depth | semantic | jpeg`
    pub pass: String,
    pub offset: u64,
    /// Payload byte length (row-padded).
    pub len: u64,
    pub width: u32,
    pub height: u32,
    /// `rgba8` (RGB + ID + semantic), `depth32f` (raw reverse-Z
    /// Depth32Float), or `jpeg` (V2 EncodeJpeg output; 1 byte per pixel).
    pub format: String,
    pub tick_id: u64,
    /// F4 (`render_bundle` only): CRC32 (IEEE) of the payload bytes as
    /// 8-char lowercase hex. Absent on V1/V2 `render`/`encode_jpeg` frames,
    /// keeping those responses byte-identical.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub digest: Option<String>,
}

/// Geometry coverage measured from the instance-ID pass already rendered for
/// a camera. A zero ID is the deterministic clear/background value.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoverageRecord {
    pub sensor_id: String,
    pub fraction: f64,
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

#[cfg(test)]
mod tests {
    use super::*;
    use render_core::engine::Profile;

    #[test]
    fn camera_profile_is_optional_and_camel_case() {
        let base = r#"{
            "sensorId":"pronto-cam0","width":1920,"height":1080,"fovDeg":60,
            "eye":[0,2,0],"target":[1,2,0]
        }"#;
        let sensor: ServiceCamera = serde_json::from_str(base).unwrap();
        assert_eq!(sensor.profile, None);

        let cinematic: ServiceCamera = serde_json::from_str(
            &base.replace(
                "\"eye\"",
                "\"profile\":\"cinematic\",\"eye\"",
            ),
        )
        .unwrap();
        assert_eq!(cinematic.profile, Some(Profile::Cinematic));
    }
}
