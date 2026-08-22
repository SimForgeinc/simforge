//! Server loop: prewarm a map once, then serve render requests.
//!
//! Single-client-at-a-time (a new connection replaces the old, mirroring
//! env-server's serveSocket). All Bevy work stays on the server thread; the
//! socket is drained synchronously between renders — deterministic by
//! construction.
use crate::proto::{
    decode_request, encode_frame, FrameReader, FrameRecord, RequestBody, ResponseBody, ShmInfo,
    WireResponse, NATIVE_SERVICE_PROTOCOL_VERSION,
};
use crate::shm::ShmRing;
use anyhow::{Context, Result};
use render_core::engine::{CameraSpec, Lighting, PassSet, Profile, SceneApp};
use std::io::Write;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::Path;

/// Scene description for prewarm (subset of the batch job schema).
#[derive(Clone, Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SceneSpec {
    pub glbs: Vec<String>,
    #[serde(default)]
    pub lighting: Lighting,
    pub profile: Profile,
    #[serde(default = "default_near")]
    pub near_m: f32,
    #[serde(default = "default_far")]
    pub far_m: f32,
    #[serde(default = "default_warmup")]
    pub warmup_frames: u32,
}

fn default_near() -> f32 {
    0.5
}
fn default_far() -> f32 {
    900.0
}
fn default_warmup() -> u32 {
    10
}

/// Prewarm the scene (tiles + ID pass + shader warmup) and return the app.
pub fn prewarm(spec: &SceneSpec) -> Result<SceneApp> {
    let mut app = SceneApp::new(&spec.lighting);
    app.load_tiles(&spec.glbs)?;
    let _legend = app.wait_until_ready()?;
    // Warm shaders with a throwaway camera so the first real request does not
    // pay pipeline compilation.
    app.add_camera(
        CameraSpec {
            sensor_id: "__prewarm__".into(),
            width: 64,
            height: 64,
            fov_y_deg: 58.0,
            near: spec.near_m,
            far: spec.far_m,
            passes: PassSet { rgb: true, id: false, depth: false },
        },
        spec.profile,
    );
    app.warmup(spec.warmup_frames);
    Ok(app)
}

/// Everything the dispatch loop owns. Bevy's App is not Send, so the whole
/// state stays on one thread by design.
pub struct ServiceState {
    pub app: SceneApp,
    pub profile: Profile,
    pub shm_path: String,
    pub shm: ShmRing,
}

/// Serve one unix socket until killed or `close`. A new connection replaces
/// the old one (env-server serveSocket convention).
pub fn serve(mut state: ServiceState, socket_path: &Path) -> Result<()> {
    let _ = std::fs::remove_file(socket_path);
    let listener = UnixListener::bind(socket_path)
        .with_context(|| format!("bind {}", socket_path.display()))?;
    eprintln!(
        "native-render-service listening on {} (profile {:?})",
        socket_path.display(),
        state.profile
    );

    loop {
        let (stream, _) = listener.accept()?;
        match handle_connection(&mut state, stream) {
            Ok(CloseConnection::ClientClose) | Ok(CloseConnection::Eof) => {}
            Err(error) => eprintln!("connection error: {error:#}"),
        }
    }
}

enum CloseConnection {
    ClientClose,
    Eof,
}

fn handle_connection(state: &mut ServiceState, stream: UnixStream) -> Result<CloseConnection> {
    let mut reader = FrameReader::new();
    let mut buf = [0u8; 65536];
    let mut writer = stream.try_clone()?;
    loop {
        let n = std::io::Read::read(&mut &stream, &mut buf)?;
        if n == 0 {
            return Ok(CloseConnection::Eof);
        }
        for payload in reader.push(&buf[..n]).map_err(anyhow::Error::msg)? {
            let request = decode_request(&payload).map_err(anyhow::Error::msg)?;
            let response = dispatch(state, request);
            writer.write_all(&encode_frame(&response)?)?;
            if matches!(response.body, ResponseBody::Close { .. }) {
                return Ok(CloseConnection::ClientClose);
            }
        }
    }
}

fn dispatch(state: &mut ServiceState, request: crate::proto::WireRequest) -> WireResponse {
    let i = request.i;
    match request.body {
        RequestBody::Hello => {
            let (size_bytes, meta_bytes, _) = state.shm.path_size_meta();
            WireResponse {
                i,
                body: ResponseBody::Hello {
                    ok: true,
                    protocol: NATIVE_SERVICE_PROTOCOL_VERSION,
                    profile: format!("{:?}", state.profile).to_lowercase(),
                    legend_entries: 0,
                    shm: ShmInfo {
                        path: state.shm_path.clone(),
                        size_bytes,
                        meta_bytes,
                    },
                },
            }
        }
        RequestBody::Load { glbs } => {
            let tiles = glbs.len();
            match state.app.load_tiles(&glbs).and_then(|()| state.app.wait_until_ready().map(|_| ())) {
                Ok(()) => WireResponse { i, body: ResponseBody::Load { ok: true, tiles } },
                Err(error) => WireResponse::error(i, format!("load failed: {error:#}")),
            }
        }
        RequestBody::Render { tick_id, cameras, export_dir } => {
            let t0 = std::time::Instant::now();
            for cam in &cameras {
                ensure_camera(state, cam);
                if let Err(error) = state.app.set_pose(&cam.sensor_id, &cam.eye, &cam.target) {
                    return WireResponse::error(i, format!("set pose: {error:#}"));
                }
            }
            let passes = match state.app.render_once() {
                Ok(passes) => passes,
                Err(error) => return WireResponse::error(i, format!("render: {error:#}")),
            };
            let mut frames = Vec::new();
            let mut export_payloads: Vec<(String, String, u32, u32, Vec<u8>)> = Vec::new();
            // Publish in deterministic order: cameras in request order,
            // passes rgb/id/depth within each.
            for cam in &cameras {
                for (pass, key, format_tag, format_name) in [
                    ("rgb", format!("{}:rgb", cam.sensor_id), 1u32, "rgba8"),
                    ("id", format!("{}:id", cam.sensor_id), 1u32, "rgba8"),
                    ("depth", format!("{}:depth", cam.sensor_id), 2u32, "depth32f"),
                ] {
                    let Some(data) = passes.get(&key) else { continue };
                    match state.shm.publish(
                        &cam.sensor_id,
                        pass,
                        cam.width,
                        cam.height,
                        format_tag,
                        tick_id,
                        data,
                    ) {
                        Ok(offset) => frames.push(FrameRecord {
                            sensor_id: cam.sensor_id.clone(),
                            pass: pass.to_string(),
                            offset,
                            len: data.len() as u64,
                            width: cam.width,
                            height: cam.height,
                            format: format_name.to_string(),
                            tick_id,
                        }),
                        Err(error) => return WireResponse::error(i, format!("publish: {error:#}")),
                    }
                    if export_dir.is_some() {
                        export_payloads.push((
                            cam.sensor_id.clone(),
                            pass.to_string(),
                            cam.width,
                            cam.height,
                            data.clone(),
                        ));
                    }
                }
            }
            let server_ms = t0.elapsed().as_secs_f64() * 1000.0;
            if let Some(dir) = export_dir {
                std::fs::create_dir_all(&dir).ok();
                std::thread::spawn(move || {
                    async_export_pngs(&dir, tick_id, &export_payloads);
                });
            }
            WireResponse { i, body: ResponseBody::Render { ok: true, tick_id, frames, server_ms } }
        }
        RequestBody::Close => WireResponse { i, body: ResponseBody::Close { ok: true } },
    }
}

fn ensure_camera(state: &mut ServiceState, cam: &crate::proto::ServiceCamera) {
    if state.app.cameras().any(|c| c.sensor_id == cam.sensor_id) {
        return;
    }
    state.app.add_camera(
        CameraSpec {
            sensor_id: cam.sensor_id.clone(),
            width: cam.width,
            height: cam.height,
            fov_y_deg: cam.fov_deg,
            near: 0.5,
            far: 900.0,
            passes: PassSet { rgb: true, id: true, depth: true },
        },
        state.profile,
    );
}

/// PNG demotion: encoding happens off the critical path after the response.
fn async_export_pngs(dir: &str, tick_id: u64, payloads: &[(String, String, u32, u32, Vec<u8>)]) {
    use render_core::engine::strip_padding;
    for (sensor_id, pass, w, h, data) in payloads {
        let raw = strip_padding(data, *w as usize, *h as usize, 4);
        let name = match pass.as_str() {
            "depth" => format!("tick-{tick_id:06}.{sensor_id}.depth.f32.bin"),
            other => format!("tick-{tick_id:06}.{sensor_id}.{other}.png"),
        };
        let path = Path::new(dir).join(name);
        let result: std::io::Result<()> = if pass == "depth" {
            std::fs::write(&path, raw)
        } else {
            match image::RgbaImage::from_raw(*w, *h, raw) {
                Some(img) => img
                    .save(&path)
                    .map_err(|e| std::io::Error::other(e.to_string())),
                None => Err(std::io::Error::other("bad rgba")),
            }
        };
        if let Err(error) = result {
            eprintln!("async export failed for {path:?}: {error}");
        }
    }
}
