//! Server loop: prewarm a map once, then serve render requests.
//!
//! Single-client-at-a-time (a new connection replaces the old, mirroring
//! env-server's serveSocket). All Bevy work stays on the server thread; the
//! socket is drained synchronously between renders — deterministic by
//! construction.
//!
//! V2 protocol (V4 SensorRig) adds `load_scene_state`, `reset_cameras`,
//! `encode_jpeg`, per-camera rigid `attach` + semantic + CARLA depth
use crate::proto::{
    decode_request, encode_frame, CameraAttach, FrameReader, FrameRecord, RequestBody, ResponseBody,
    ServiceCamera, ShmInfo, WireRequest, WireResponse, JpegItem,
    NATIVE_SERVICE_PROTOCOL_VERSION,
};
use crate::scene::SceneState;
use crate::shm::{ShmRing, FORMAT_DEPTH32F, FORMAT_JPEG, FORMAT_RGBA8};
use anyhow::{Context, Result};
use render_core::engine::{CameraSpec, LegendEntry, Lighting, PassSet, Profile, SceneApp};
use std::collections::HashMap;
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
///
/// WSB5 erratum fix (repro: any `native-render-service` launch on
/// 4ec6e43's engine panicked at engine.rs:381 — `add_camera` asserted
/// `!ready` after `wait_until_ready` had flipped it): the warmup camera is
/// registered BEFORE the readiness barrier, which is also the documented
/// SceneApp contract.
pub fn prewarm(spec: &SceneSpec) -> Result<SceneApp> {
    let mut app = SceneApp::new(&spec.lighting)?;
    app.load_tiles(&spec.glbs)?;
    // Warm shaders with a throwaway camera so the first real request does not
    // pay pipeline compilation. Registered pre-readiness per SceneApp rules.
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
    let _legend = app.wait_until_ready()?;
    app.warmup(spec.warmup_frames);
    Ok(app)
}

/// wgpu COPY_BYTES_PER_ROW_ALIGNMENT — must match render-core's readback
/// row stride (`RenderDevice::align_copy_bytes_per_row`).
fn row_stride(width: u32, pixel_bytes: usize) -> usize {
    let row = width as usize * pixel_bytes;
    row.div_ceil(256) * 256
}

/// Cached payload of one pass from the last rendered tick (JPEG source).
struct CachedPass {
    data: Vec<u8>,
    width: u32,
    height: u32,
    stride: usize,
    tick_id: u64,
}

/// Everything the dispatch loop owns. Bevy's App is not Send, so the whole
/// state stays on one thread by design.
pub struct ServiceState {
    pub app: SceneApp,
    pub profile: Profile,
    pub shm_path: String,
    pub shm: ShmRing,
    pub near_m: f32,
    pub far_m: f32,
    /// Static instance legend (id -> mesh name), frozen at readiness.
    legend: HashMap<u32, String>,
    /// Loaded scene-state stream (V2 `load_scene_state`).
    scene: Vec<SceneState>,
    /// Index of the most recently applied scene frame.
    current_tick: Option<u32>,
    /// Pass payloads from the last render (V2 `encode_jpeg` source).
    cache: HashMap<String, CachedPass>,
}

impl ServiceState {
    pub fn new(app: SceneApp, profile: Profile, shm_path: String, shm: ShmRing, near_m: f32, far_m: f32) -> Self {
        let legend: HashMap<u32, String> = app
            .legend()
            .into_iter()
            .map(|LegendEntry { id, name }| (id, name))
            .collect();
        Self {
            app,
            profile,
            shm_path,
            shm,
            near_m,
            far_m,
            legend,
            scene: Vec::new(),
            current_tick: None,
            cache: HashMap::new(),
        }
    }
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

/// CARLA ego-view transform scaled by vehicle bounds (drive_server.py
/// `_transform_for_view` "hood" view is the V2X product default).
fn dispatch(state: &mut ServiceState, request: WireRequest) -> WireResponse {
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
                    legend_entries: state.legend.len(),
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
        RequestBody::LoadSceneState { states } => {
            if let Some(first) = states.first() {
                if let Err(error) = first.validate() {
                    return WireResponse::error(i, error);
                }
            }
            let ticks = states.len();
            let map_id = states.first().map(|s| s.map_id.clone()).unwrap_or_default();
            state.scene = states;
            state.current_tick = None;
            WireResponse { i, body: ResponseBody::LoadSceneState { ok: true, ticks, map_id } }
        }
        RequestBody::ResetCameras => {
            state.app.clear_cameras();
            state.cache.clear();
            WireResponse { i, body: ResponseBody::ResetCameras { ok: true } }
        }
        RequestBody::Render { tick_id, cameras, export_dir, tick_index } => {
            render_tick(state, i, tick_id, cameras, export_dir, tick_index)
        }
        RequestBody::EncodeJpeg { items } => encode_jpeg_op(state, i, items),
        RequestBody::Close => WireResponse { i, body: ResponseBody::Close { ok: true } },
    }
}

/// Apply scene-state frame `index` to the world (spawn/update/despawn).
fn apply_scene_tick(state: &mut ServiceState, index: u32) -> Result<(), String> {
    let frame = state
        .scene
        .get(index as usize)
        .ok_or_else(|| format!("tick_index {index} out of range (loaded {} ticks)", state.scene.len()))?;
    for actor in &frame.actors {
        match actor.kind.as_str() {
            "despawn" => state.app.remove_actor(&actor.id),
            "spawn" | "update" => {
                let class = actor.actor_class.clone().unwrap_or_else(|| "prop".into());
                let dims = actor_dims(&class);
                let yaw = quat_yaw(&actor.transform.rotation);
                // Traces carry no height channel: snap onto the static ground
                // field whenever the doc does not pin a ground elevation.
                let snap = actor.transform.position[1].abs() < 1e-4 && frame.ground_y.is_none();
                state.app.upsert_actor(
                    &actor.id,
                    &class,
                    actor.transform.position,
                    yaw,
                    dims,
                    class_color(&class),
                    snap,
                );
            }
            other => return Err(format!("unknown actor kind {other:?} for {}", actor.id)),
        }
    }
    state.current_tick = Some(index);
    Ok(())
}

fn quat_yaw(q: &[f32; 4]) -> f32 {
    let [x, y, z, w] = *q;
    // Yaw about +Y from a unit quaternion.
    let sin = 2.0 * (w * y + z * x);
    let cos = 1.0 - 2.0 * (y * y + z * z);
    sin.atan2(cos)
}

/// Interim actor geometry: cuboids per class until the prop-catalog actor
/// pipeline lands in render-core (same stand-in as the WSB3 harness).
fn actor_dims(class: &str) -> [f32; 3] {
    match class {
        "car" => [4.5, 1.6, 1.8],
        "truck" | "bus" => [8.0, 3.0, 2.5],
        "motorcycle" | "cyclist" => [2.2, 1.5, 0.9],
        "pedestrian" => [0.5, 1.8, 0.5],
        _ => [1.0, 1.0, 1.0],
    }
}

fn class_color(class: &str) -> [f32; 3] {
    match class {
        "car" => [0.65, 0.67, 0.70],
        "truck" | "bus" => [0.55, 0.58, 0.62],
        "motorcycle" | "cyclist" => [0.60, 0.55, 0.45],
        "pedestrian" => [0.75, 0.65, 0.55],
        _ => [0.5, 0.5, 0.5],
    }
}

/// Resolve a camera pose: explicit eye/target, or rigid attachment against
/// the current scene frame.
fn resolve_pose(
    state: &ServiceState,
    cam: &ServiceCamera,
) -> Result<([f32; 3], [f32; 3]), String> {
    let Some(attach) = &cam.attach else {
        return Ok((cam.eye, cam.target));
    };
    let index = state
        .current_tick
        .ok_or_else(|| "attach requested but no scene tick applied yet".to_string())?;
    let frame = &state.scene[index as usize];
    let actor = frame
        .actors
        .iter()
        .find(|a| a.id == attach.actor_id && a.kind != "despawn")
        .ok_or_else(|| format!("attach actor {:?} not present in tick {index}", attach.actor_id))?;
    let yaw = quat_yaw(&actor.transform.rotation);
    let pos = actor.transform.position;
    let ground = state.app.ground_at(pos[0], pos[2]);
    // Actor-local mount (x fwd, y right, z up) -> world (y-up, yaw about +Y).
    let (sy, cy) = yaw.sin_cos();
    let off = attach.offset_m;
    let eye = [
        pos[0] + cy * off[0] + sy * off[1],
        ground + off[2],
        pos[2] - sy * off[0] + cy * off[1],
    ];
    // CARLA yaw is left-handed (clockwise from above); Uni yaw is CCW, so a
    // CARLA-relative mount yaw subtracts. Pitch passes through (negative =
    // down, matching CARLA semantics).
    let total_yaw = yaw - attach.yaw_deg.to_radians();
    let pitch = attach.pitch_deg.to_radians();
    let (ty, tyc) = total_yaw.sin_cos();
    let (sp, cp) = pitch.sin_cos();
    let dir = [cp * tyc, sp, -cp * ty];
    const TARGET_DIST: f32 = 50.0;
    let target = [
        eye[0] + TARGET_DIST * dir[0],
        eye[1] + TARGET_DIST * dir[1],
        eye[2] + TARGET_DIST * dir[2],
    ];
    Ok((eye, target))
}

fn ensure_camera(state: &mut ServiceState, cam: &ServiceCamera) -> bool {
    if state.app.cameras().any(|c| c.sensor_id == cam.sensor_id) {
        return false;
    }
    state.app.add_camera(
        CameraSpec {
            sensor_id: cam.sensor_id.clone(),
            width: cam.width,
            height: cam.height,
            fov_y_deg: cam.fov_deg,
            near: state.near_m,
            far: state.far_m,
            passes: PassSet { rgb: true, id: true, depth: true },
        },
        state.profile,
    );
    true
}

fn render_tick(
    state: &mut ServiceState,
    i: u64,
    tick_id: u64,
    cameras: Vec<ServiceCamera>,
    export_dir: Option<String>,
    tick_index: Option<u32>,
) -> WireResponse {
    let t0 = std::time::Instant::now();
    if let Some(index) = tick_index {
        if let Err(error) = apply_scene_tick(state, index) {
            return WireResponse::error(i, error);
        }
    }
    let mut any_new_camera = false;
    for cam in &cameras {
        any_new_camera |= ensure_camera(state, cam);
        let (eye, target) = match resolve_pose(state, cam) {
            Ok(pose) => pose,
            Err(error) => return WireResponse::error(i, error),
        };
        if let Err(error) = state.app.set_pose(&cam.sensor_id, &eye, &target) {
            return WireResponse::error(i, format!("set pose: {error:#}"));
        }
    }
    let _ = any_new_camera;
    // Readback returns the PREVIOUS render's buffer: pose/scene updates lag
    // one render_once (empirically shown by the two-pose hash probe: pose-A
    // request returned pose-B pixels; new cameras return stale buffers).
    // Flush one render so the capture render below reflects the poses and
    // scene tick applied above. TODO(render-core): reorder readback so a
    // single render returns current-frame buffers, then drop this flush.
    if let Err(error) = state.app.render_once() {
        return WireResponse::error(i, format!("render (flush): {error:#}"));
    }
    let passes = match state.app.render_once() {
        Ok(passes) => passes,
        Err(error) => return WireResponse::error(i, format!("render: {error:#}")),
    };
    let mut frames = Vec::new();
    let mut export_payloads: Vec<(String, String, u32, u32, Vec<u8>)> = Vec::new();
    // Publish in deterministic order: cameras in request order,
    // passes rgb/id/depth/semantic within each.
    for cam in &cameras {
        let stride = row_stride(cam.width, 4);
        let mut publish = |state: &mut ServiceState,
                           pass: &str,
                           format_tag: u32,
                           format_name: &str,
                           data: Vec<u8>,
                           frames: &mut Vec<FrameRecord>| {
            match state.shm.publish(
                &cam.sensor_id,
                pass,
                cam.width,
                cam.height,
                format_tag,
                tick_id,
                &data,
            ) {
                Ok(offset) => {
                    frames.push(FrameRecord {
                        sensor_id: cam.sensor_id.clone(),
                        pass: pass.to_string(),
                        offset,
                        len: data.len() as u64,
                        width: cam.width,
                        height: cam.height,
                        format: format_name.to_string(),
                        tick_id,
                    });
                    Ok(())
                }
                Err(error) => Err(format!("publish: {error}")),
            }
        };
        for (pass, key, format_tag, format_name) in [
            ("rgb", format!("{}:rgb", cam.sensor_id), FORMAT_RGBA8, "rgba8"),
            ("id", format!("{}:id", cam.sensor_id), FORMAT_RGBA8, "rgba8"),
        ] {
            let Some(data) = passes.get(&key) else { continue };
            if let Err(error) = publish(state, pass, format_tag, format_name, data.clone(), &mut frames) {
                return WireResponse::error(i, error);
            }
            state.cache.insert(
                key.clone(),
                CachedPass { data: data.clone(), width: cam.width, height: cam.height, stride, tick_id },
            );
            if export_dir.is_some() {
                export_payloads.push((cam.sensor_id.clone(), pass.to_string(), cam.width, cam.height, data.clone()));
            }
        }
        // Depth: raw reverse-Z passthrough (v0) or CARLA 24-bit packing (V2).
        {
            let key = format!("{}:depth", cam.sensor_id);
            if let Some(data) = passes.get(&key) {
                let carla = cam.depth_encoding.as_deref() == Some("carla");
                let out = if carla {
                    crate::carla::depth_to_carla(data, cam.width, cam.height, stride, state.near_m, state.far_m)
                } else {
                    data.clone()
                };
                if let Err(error) = publish(
                    state,
                    "depth",
                    FORMAT_DEPTH32F,
                    if carla { "carla-depth-bgra" } else { "depth32f" },
                    out,
                    &mut frames,
                ) {
                    return WireResponse::error(i, error);
                }
                state.cache.insert(
                    key,
                    CachedPass { data: data.clone(), width: cam.width, height: cam.height, stride, tick_id },
                );
                if export_dir.is_some() {
                    export_payloads.push((cam.sensor_id.clone(), "depth".into(), cam.width, cam.height, data.clone()));
                }
            }
        }
        // Semantic (V2): class remap of the instance-ID pass into the CARLA
        // byte layout. Derived, not rendered — see carla::semantic_from_ids.
        if cam.semantic {
            let key = format!("{}:id", cam.sensor_id);
            let Some(id_data) = passes.get(&key) else {
                return WireResponse::error(i, format!("semantic requested but no id pass for {}", cam.sensor_id));
            };
            let legend = &state.legend;
            let app = &state.app;
            let out = crate::carla::semantic_from_ids(id_data, cam.width, cam.height, stride, |id| {
                if let Some(class) = app.actor_instance_class(id) {
                    return crate::carla::actor_class_of(class);
                }
                legend
                    .get(&id)
                    .map(|name| crate::carla::static_class_of(name))
                    .unwrap_or(0)
            });
            if let Err(error) = publish(state, "semantic", FORMAT_RGBA8, "rgba8", out, &mut frames) {
                return WireResponse::error(i, error);
            }
            if export_dir.is_some() {
                if let Some(data) = passes.get(&key) {
                    let legend = &state.legend;
                    let app = &state.app;
                    let out = crate::carla::semantic_from_ids(data, cam.width, cam.height, stride, |id| {
                        if let Some(class) = app.actor_instance_class(id) {
                            return crate::carla::actor_class_of(class);
                        }
                        legend.get(&id).map(|n| crate::carla::static_class_of(n)).unwrap_or(0)
                    });
                    export_payloads.push((cam.sensor_id.clone(), "semantic".into(), cam.width, cam.height, out));
                }
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

fn encode_jpeg_op(state: &mut ServiceState, i: u64, items: Vec<JpegItem>) -> WireResponse {
    let t0 = std::time::Instant::now();
    let mut frames = Vec::new();
    for item in &items {
        let key = format!("{}:{}", item.sensor_id, item.pass);
        let Some(cached) = state.cache.get(&key) else {
            return WireResponse::error(i, format!("no cached pass {key} (render first)"));
        };
        let rgba = crate::carla::strip_rgba_padding(&cached.data, cached.width, cached.height, cached.stride);
        // RGBA -> RGB.
        let mut rgb = Vec::with_capacity(cached.width as usize * cached.height as usize * 3);
        for px in rgba.chunks_exact(4) {
            rgb.extend_from_slice(&px[..3]);
        }
        let tick_id = cached.tick_id;
        let (w, h) = (cached.width, cached.height);
        let jpeg = match crate::carla::encode_jpeg(&rgb, w, h, item.quality) {
            Ok(j) => j,
            Err(error) => return WireResponse::error(i, error),
        };
        match state.shm.publish(
            &item.sensor_id,
            "jpeg",
            w,
            h,
            FORMAT_JPEG,
            tick_id,
            &jpeg,
        ) {
            Ok(offset) => frames.push(FrameRecord {
                sensor_id: item.sensor_id.clone(),
                pass: "jpeg".into(),
                offset,
                len: jpeg.len() as u64,
                width: w,
                height: h,
                format: "jpeg".into(),
                tick_id,
            }),
            Err(error) => return WireResponse::error(i, format!("publish: {error}")),
        }
    }
    let server_ms = t0.elapsed().as_secs_f64() * 1000.0;
    WireResponse { i, body: ResponseBody::EncodeJpeg { ok: true, tick_id: state.cache.values().next().map(|c| c.tick_id).unwrap_or(0), frames, server_ms } }
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
