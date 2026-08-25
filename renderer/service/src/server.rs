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
    decode_request, encode_frame, CameraAttach, CoverageRecord, FrameReader, FrameRecord, JpegItem,
    RequestBody, ResponseBody, ServiceCamera, ServiceLidar, ServiceRadar, ShmInfo, WireRequest,
    WireResponse, NATIVE_SERVICE_PROTOCOL_VERSION,
};
use crate::scene::{ActorState, SceneState};
use crate::shm::{
    BundleEntry, ShmRing, FORMAT_DEPTH32F, FORMAT_JPEG, FORMAT_LIDAR_PLY, FORMAT_RADAR_CSV,
    FORMAT_RGBA8,
};
use anyhow::{Context, Result};
use bevy::math::{EulerRot, Quat, Vec3};
use render_core::engine::{
    CameraSpec, LegendEntry, Lighting, PassSet, Profile, SceneApp, SensorTriangle,
};
use render_core::profiles::RenderProfileConfig;
use render_core::vehicle_model::{VehicleModelCatalog, VehicleModelEntry};
use sensors::bvh::{Hit, Raycast, RaycastScene, Tri};
use std::collections::HashMap;
use std::io::Write;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};

/// Scene description for prewarm (subset of the batch job schema).
#[derive(Clone, Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SceneSpec {
    pub glbs: Vec<String>,
    /// Vegetation prototype GLBs with sibling instance sidecars.
    #[serde(default)]
    pub veg_glbs: Vec<String>,
    #[serde(default)]
    pub lighting: Lighting,
    pub profile: Profile,
    /// Advanced cinematic settings; ignored by sensor cameras.
    #[serde(default)]
    pub profile_config: RenderProfileConfig,
    #[serde(default = "default_near")]
    pub near_m: f32,
    #[serde(default = "default_far")]
    pub far_m: f32,
    #[serde(default = "default_warmup")]
    pub warmup_frames: u32,
    /// CarlaVehicles catalog directories. Only models referenced by scene
    /// actors are loaded; unknown catalog ids retain the explicit cuboid
    /// fallback.
    #[serde(default)]
    pub vehicle_models: Option<String>,
    #[serde(default)]
    pub pedestrian_models: Option<String>,
    /// Optional actor-id -> absolute GLB override.
    #[serde(default)]
    pub actor_model_refs: HashMap<String, String>,
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
    let mut app =
        SceneApp::new_with_profile_config(&spec.lighting, spec.profile_config)?;
    app.load_tiles(&spec.glbs)?;
    app.load_vegetation(&spec.veg_glbs)?;
    // Warm both profile pipelines because campaign service scenes normally
    // inherit `sensor` while one per-camera override is cinematic.
    for (sensor_id, profile) in [
        ("__prewarm_sensor__", Profile::Sensor),
        ("__prewarm_cinematic__", Profile::Cinematic),
    ] {
        app.add_camera(
            CameraSpec {
                sensor_id: sensor_id.into(),
                width: 64,
                height: 64,
                fov_y_deg: 58.0,
                near: spec.near_m,
                far: spec.far_m,
                passes: PassSet { rgb: true, id: false, depth: false },
            },
            profile,
        );
    }
    let _legend = app.wait_until_ready()?;
    app.warmup(spec.warmup_frames);
    // Prewarm views must not consume render/readback work in every service
    // tick; real retained-rig cameras are registered on first request.
    app.clear_cameras();
    Ok(app)
}

/// wgpu COPY_BYTES_PER_ROW_ALIGNMENT — must match render-core's readback
/// row stride (`RenderDevice::align_copy_bytes_per_row`).
fn row_stride(width: u32, pixel_bytes: usize) -> usize {
    let row = width as usize * pixel_bytes;
    row.div_ceil(256) * 256
}

/// Fraction of visible pixels in an RGBA8 instance-ID readback. RGB encodes
/// the little-endian 24-bit ID; alpha is intentionally ignored because the
/// clear target and opaque geometry both carry alpha 255.
fn instance_coverage(data: &[u8], width: u32, height: u32) -> f64 {
    let stride = row_stride(width, 4);
    let visible = data
        .chunks_exact(stride)
        .take(height as usize)
        .flat_map(|row| row[..width as usize * 4].chunks_exact(4))
        .filter(|pixel| pixel[0] != 0 || pixel[1] != 0 || pixel[2] != 0)
        .count();
    visible as f64 / f64::from(width * height)
}

/// Cached payload of one pass from the last rendered tick (JPEG source).
struct CachedPass {
    data: Vec<u8>,
    width: u32,
    height: u32,
    stride: usize,
    tick_id: u64,
}

fn build_sensor_scene(triangles: Vec<SensorTriangle>) -> RaycastScene {
    let mut scene = RaycastScene::new();
    for triangle in triangles {
        scene.push_tri(Tri {
            a: Vec3::from_array(triangle.a),
            b: Vec3::from_array(triangle.b),
            c: Vec3::from_array(triangle.c),
            instance_id: triangle.instance_id,
        });
    }
    scene.build();
    scene
}

struct CombinedSensorScene<'a> {
    static_scene: &'a RaycastScene,
    actor_scene: &'a RaycastScene,
}

impl Raycast for CombinedSensorScene<'_> {
    fn cast(&self, origin: Vec3, direction: Vec3, max_distance: f32) -> Option<Hit> {
        match (
            self.static_scene.cast(origin, direction, max_distance),
            self.actor_scene.cast(origin, direction, max_distance),
        ) {
            (Some(static_hit), Some(actor_hit)) if actor_hit.distance < static_hit.distance => {
                Some(actor_hit)
            }
            (Some(static_hit), _) => Some(static_hit),
            (None, actor_hit) => actor_hit,
        }
    }
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
    /// Retained camera rig in registration order.
    rig: Vec<ServiceCamera>,
    /// Retained CPU sensor rigs in registration order.
    lidars: Vec<ServiceLidar>,
    radars: Vec<ServiceRadar>,
    /// Static map BVH, built once after prewarm and reused for every tick.
    static_sensor_scene: RaycastScene,
    vehicle_models: Option<VehicleModelCatalog>,
    pedestrian_models: Option<VehicleModelCatalog>,
    actor_model_refs: HashMap<String, PathBuf>,
}

impl ServiceState {
    pub fn new(
        mut app: SceneApp,
        spec: &SceneSpec,
        shm_path: String,
        shm: ShmRing,
    ) -> Result<Self> {
        let vehicle_models = spec
            .vehicle_models
            .as_deref()
            .map(|dir| VehicleModelCatalog::load(Path::new(dir)))
            .transpose()
            .context("load vehicle model catalog")?;
        let pedestrian_models = spec
            .pedestrian_models
            .as_deref()
            .map(|dir| VehicleModelCatalog::load(Path::new(dir)))
            .transpose()
            .context("load pedestrian model catalog")?;
        let legend: HashMap<u32, String> = app
            .legend()
            .into_iter()
            .map(|LegendEntry { id, name }| (id, name))
            .collect();
        let static_sensor_scene = build_sensor_scene(app.sensor_triangles(false));
        Ok(Self {
            app,
            profile: spec.profile,
            shm_path,
            shm,
            near_m: spec.near_m,
            far_m: spec.far_m,
            legend,
            scene: Vec::new(),
            current_tick: None,
            cache: HashMap::new(),
            rig: Vec::new(),
            lidars: Vec::new(),
            radars: Vec::new(),
            static_sensor_scene,
            vehicle_models,
            pedestrian_models,
            actor_model_refs: spec
                .actor_model_refs
                .iter()
                .map(|(actor, path)| (actor.clone(), PathBuf::from(path)))
                .collect(),
        })
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
            state.rig.clear();
            state.lidars.clear();
            state.radars.clear();
            WireResponse { i, body: ResponseBody::ResetCameras { ok: true } }
        }
        RequestBody::Render { tick_id, cameras, export_dir, tick_index } => {
            render_tick(state, i, tick_id, cameras, export_dir, tick_index)
        }
        RequestBody::RenderBundle {
            sim_tick,
            cameras,
            lidars,
            radars,
            tick_index,
            passes,
        } => {
            render_bundle_op(
                state, i, sim_tick, cameras, lidars, radars, tick_index, passes,
            )
        }
        RequestBody::EncodeJpeg { items } => encode_jpeg_op(state, i, items),
        RequestBody::Close => WireResponse { i, body: ResponseBody::Close { ok: true } },
    }
}

fn resolve_actor_model(state: &ServiceState, actor: &ActorState) -> Option<VehicleModelEntry> {
    if let Some(path) = state.actor_model_refs.get(&actor.id) {
        return Some(VehicleModelEntry {
            glb_path: path.clone(),
            attribution: String::new(),
            source: "scene-spec-override".to_string(),
            tintable: false,
            scale_to_dims: false,
            model_length_m: None,
        });
    }
    let catalog_id = actor.catalog_id.as_deref()?;
    if actor.actor_class.as_deref() == Some("pedestrian") {
        let catalog = state.pedestrian_models.as_ref()?;
        return catalog
            .resolve(catalog_id)
            .cloned()
            .or_else(|| {
                catalog
                    .resolve_deterministic(&actor.id)
                    .map(|(_, entry)| entry.clone())
            });
    }
    state
        .vehicle_models
        .as_ref()?
        .resolve(catalog_id)
        .cloned()
}

/// Apply scene-state frame `index` to the world (spawn/update/despawn).
fn apply_scene_tick(state: &mut ServiceState, index: u32) -> Result<(), String> {
    let frame = state
        .scene
        .get(index as usize)
        .cloned()
        .ok_or_else(|| format!("tick_index {index} out of range (loaded {} ticks)", state.scene.len()))?;
    for actor in &frame.actors {
        match actor.kind.as_str() {
            "despawn" => state.app.remove_actor(&actor.id),
            "spawn" | "update" => {
                let class = actor.actor_class.clone().unwrap_or_else(|| "prop".into());
                let dims = actor_dims(&class);
                let model = resolve_actor_model(state, actor);
                let yaw = quat_yaw(&actor.transform.rotation);
                let mut position = actor.transform.position;
                position[1] = actor_base_y(
                    position[1],
                    frame.ground_y,
                    state.app.ground_at(position[0], position[2]),
                );
                state.app.upsert_actor(
                    &actor.id,
                    &class,
                    position,
                    yaw,
                    dims,
                    class_color(&class),
                    false,
                );
                if let Some(model) = model {
                    if !state.app.actor_has_model(&actor.id) {
                        if !model.glb_path.is_file() {
                            return Err(format!(
                                "catalog model for {} is missing: {}",
                                actor.id,
                                model.glb_path.display()
                            ));
                        }
                        let scale = if model.scale_to_dims {
                            model
                                .model_length_m
                                .filter(|length| *length > 0.1)
                                .map(|length| dims[0] / length as f32)
                                .unwrap_or(1.0)
                        } else {
                            1.0
                        };
                        state
                            .app
                            .attach_actor_model(&actor.id, &model.glb_path, scale)
                            .map_err(|error| format!("load actor model {}: {error:#}", actor.id))?;
                    }
                }
            }
            other => return Err(format!("unknown actor kind {other:?} for {}", actor.id)),
        }
    }
    state.current_tick = Some(index);
    Ok(())
}

/// Height precedence for authored scene state. Non-zero actor Y is canonical;
/// frame `groundY` is the explicit fallback for legacy zero-height traces;
/// mesh sampling is only the last resort when neither is authored.
fn actor_base_y(authored_y: f32, frame_ground_y: Option<f32>, sampled_y: f32) -> f32 {
    if authored_y.abs() >= 1e-4 {
        authored_y
    } else {
        frame_ground_y.unwrap_or(sampled_y)
    }
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
        "van" | "suv" | "pickup" => [4.8, 1.9, 2.0],
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

fn resolved_actor_y(position_y: f32, authored_ground_y: Option<f32>, sampled_ground_y: f32) -> f32 {
    if position_y.abs() < 1e-4 && authored_ground_y.is_none() {
        sampled_ground_y
    } else {
        position_y
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
    let base_y = actor_base_y(
        pos[1],
        frame.ground_y,
        state.app.ground_at(pos[0], pos[2]),
    );
    // Actor-local mount (x fwd, y right, z up) -> world (y-up, yaw about +Y).
    let (sy, cy) = yaw.sin_cos();
    let off = attach.offset_m;
    let eye = [
        pos[0] + cy * off[0] + sy * off[1],
        base_y + off[2],
        pos[2] - sy * off[0] + cy * off[1],
    ];
    if attach.look_at_actor {
        return Ok((eye, [pos[0], base_y + 1.0, pos[2]]));
    }
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

struct ResolvedSensorMount {
    origin: Vec3,
    rotation: Quat,
    host_velocity: Vec3,
}

fn resolve_sensor_mount(
    state: &ServiceState,
    attach: &CameraAttach,
) -> Result<ResolvedSensorMount, String> {
    let index = state
        .current_tick
        .ok_or_else(|| "sensor attach requested but no scene tick applied yet".to_string())?;
    let frame = &state.scene[index as usize];
    let actor = frame
        .actors
        .iter()
        .find(|actor| actor.id == attach.actor_id && actor.kind != "despawn")
        .ok_or_else(|| {
            format!(
                "sensor attach actor {:?} not present in tick {index}",
                attach.actor_id
            )
        })?;
    let yaw = quat_yaw(&actor.transform.rotation);
    let position = actor.transform.position;
    let actor_y = resolved_actor_y(
        position[1],
        frame.ground_y,
        state.app.ground_at(position[0], position[2]),
    );
    let actor_rotation = Quat::from_rotation_y(yaw);
    // Wire mount coordinates are x-forward, y-right, z-up. The deterministic
    // sensor model's canonical local frame is x-forward, y-up, z-left.
    let local_offset = Vec3::new(
        attach.offset_m[0],
        attach.offset_m[2],
        -attach.offset_m[1],
    );
    let origin = Vec3::new(position[0], actor_y, position[2])
        + actor_rotation.mul_vec3(local_offset);
    let mount_rotation = Quat::from_euler(
        EulerRot::YXZ,
        attach.yaw_deg.to_radians(),
        attach.pitch_deg.to_radians(),
        attach.roll_deg.to_radians(),
    );
    Ok(ResolvedSensorMount {
        origin,
        rotation: actor_rotation * mount_rotation,
        host_velocity: Vec3::from_array(actor.velocity),
    })
}

fn upsert_lidar_rig(state: &mut ServiceState, sensor: &ServiceLidar) {
    match state
        .lidars
        .iter_mut()
        .find(|registered| registered.sensor_id == sensor.sensor_id)
    {
        Some(registered) => *registered = sensor.clone(),
        None => state.lidars.push(sensor.clone()),
    }
}

fn upsert_radar_rig(state: &mut ServiceState, sensor: &ServiceRadar) {
    match state
        .radars
        .iter_mut()
        .find(|registered| registered.sensor_id == sensor.sensor_id)
    {
        Some(registered) => *registered = sensor.clone(),
        None => state.radars.push(sensor.clone()),
    }
}

/// Upsert a camera spec into the retained rig (registration order kept).
fn upsert_rig(state: &mut ServiceState, cam: &ServiceCamera) {
    match state.rig.iter_mut().find(|c| c.sensor_id == cam.sensor_id) {
        Some(slot) => *slot = cam.clone(),
        None => state.rig.push(cam.clone()),
    }
}

fn ensure_camera(state: &mut ServiceState, cam: &ServiceCamera, passes: PassSet) -> bool {
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
            passes,
        },
        cam.profile.unwrap_or(state.profile),
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
        upsert_rig(state, cam);
        any_new_camera |= ensure_camera(state, cam, PassSet { rgb: true, id: true, depth: true });
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
    let mut coverage = Vec::with_capacity(cameras.len());
    let mut export_payloads: Vec<(String, String, u32, u32, Vec<u8>)> = Vec::new();
    // Publish in deterministic order: cameras in request order,
    // passes rgb/id/depth/semantic within each.
    for cam in &cameras {
        let stride = row_stride(cam.width, 4);
        let id_key = format!("{}:id", cam.sensor_id);
        let Some(id_data) = passes.get(&id_key) else {
            return WireResponse::error(i, format!("coverage requires id pass for {}", cam.sensor_id));
        };
        coverage.push(CoverageRecord {
            sensor_id: cam.sensor_id.clone(),
            fraction: instance_coverage(id_data, cam.width, cam.height),
        });
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
                        digest: None,
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
    WireResponse {
        i,
        body: ResponseBody::Render { ok: true, tick_id, frames, server_ms, coverage },
    }
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
                digest: None,
            }),
            Err(error) => return WireResponse::error(i, format!("publish: {error}")),
        }
    }
    let server_ms = t0.elapsed().as_secs_f64() * 1000.0;
    WireResponse { i, body: ResponseBody::EncodeJpeg { ok: true, tick_id: state.cache.values().next().map(|c| c.tick_id).unwrap_or(0), frames, server_ms } }
}

/// F4: render every rig camera for one sim tick and publish an atomic frame
fn publish_sensor_payload(
    state: &mut ServiceState,
    sensor_id: &str,
    pass: &str,
    format_tag: u32,
    format_name: &str,
    measurement_count: u32,
    sim_tick: u64,
    data: &[u8],
    entries: &mut Vec<BundleEntry>,
    frames: &mut Vec<FrameRecord>,
) -> Result<(), String> {
    let digest = crc32fast::hash(data);
    let offset = state
        .shm
        .publish(
            sensor_id,
            pass,
            measurement_count,
            1,
            format_tag,
            sim_tick,
            data,
        )
        .map_err(|error| format!("publish: {error}"))?;
    entries.push(BundleEntry {
        camera_id: sensor_id.to_string(),
        pass: pass.to_string(),
        payload_offset: offset + crate::shm::RECORD_HEADER_BYTES as u64,
        payload_len: data.len() as u64,
        width: measurement_count,
        height: 1,
        format_tag,
        digest,
    });
    frames.push(FrameRecord {
        sensor_id: sensor_id.to_string(),
        pass: pass.to_string(),
        offset,
        len: data.len() as u64,
        width: measurement_count,
        height: 1,
        format: format_name.to_string(),
        tick_id: sim_tick,
        digest: Some(format!("{digest:08x}")),
    });
    Ok(())
}

/// bundle (frames first, then the bundle table record, then the meta-page
/// latest-bundle pointer flip). Cameras keep rig registration order and
/// passes are canonical (rgb, id, depth, semantic) within each camera, so
/// ring layout and per-frame digests are deterministic for a deterministic
/// renderer.
fn render_bundle_op(
    state: &mut ServiceState,
    i: u64,
    sim_tick: u64,
    cameras: Option<Vec<ServiceCamera>>,
    lidars: Option<Vec<ServiceLidar>>,
    radars: Option<Vec<ServiceRadar>>,
    tick_index: Option<u32>,
    passes: Option<Vec<String>>,
) -> WireResponse {
    let t0 = std::time::Instant::now();
    // Requested pass set. Default rgb-only: the policy hot loop. The GPU
    // pass set is frozen per camera at first registration (`reset_cameras`
    // to change), matching existing V2 semantics.
    let requested = passes.unwrap_or_else(|| vec!["rgb".to_string()]);
    let mut want = PassSet { rgb: false, id: false, depth: false };
    let mut want_semantic = false;
    for pass in &requested {
        match pass.as_str() {
            "rgb" => want.rgb = true,
            "id" => want.id = true,
            "depth" => want.depth = true,
            "semantic" => want_semantic = true,
            other => return WireResponse::error(i, format!("unknown bundle pass {other:?}")),
        }
    }
    let want_id_output = want.id;
    if want_semantic {
        want.id = true; // semantic derives from the instance-ID pass
    }
    if let Some(cams) = &cameras {
        for cam in cams {
            upsert_rig(state, cam);
        }
    }
    if let Some(sensors) = &lidars {
        for sensor in sensors {
            upsert_lidar_rig(state, sensor);
        }
    }
    if let Some(sensors) = &radars {
        for sensor in sensors {
            upsert_radar_rig(state, sensor);
        }
    }
    if state.rig.is_empty() && state.lidars.is_empty() && state.radars.is_empty() {
        return WireResponse::error(
            i,
            "render_bundle: no sensors registered (send `cameras`, `lidars`, or `radars` once)",
        );
    }
    if let Some(index) = tick_index {
        if let Err(error) = apply_scene_tick(state, index) {
            return WireResponse::error(i, error);
        }
    }
    let rig = state.rig.clone();
    let lidar_rig = state.lidars.clone();
    let radar_rig = state.radars.clone();
    for cam in &rig {
        ensure_camera(state, cam, want);
        let (eye, target) = match resolve_pose(state, cam) {
            Ok(pose) => pose,
            Err(error) => return WireResponse::error(i, error),
        };
        if let Err(error) = state.app.set_pose(&cam.sensor_id, &eye, &target) {
            return WireResponse::error(i, format!("set pose: {error:#}"));
        }
    }
    // Same double-render flush as `render`: readback lags one render_once.
    if let Err(error) = state.app.render_once() {
        return WireResponse::error(i, format!("render (flush): {error:#}"));
    }
    let outputs = match state.app.render_once() {
        Ok(outputs) => outputs,
        Err(error) => return WireResponse::error(i, format!("render: {error:#}")),
    };

    let start_cursor = state.shm.cursor_total();
    let mut frames: Vec<FrameRecord> = Vec::new();
    let mut entries: Vec<BundleEntry> = Vec::new();
    for cam in &rig {
        let stride = row_stride(cam.width, 4);
        // (pass, format_tag, format_name, payload) in canonical order. A
        // requested pass missing from render output is a hard error: bundles
        // are all-or-nothing.
        let mut planned: Vec<(&str, u32, &str, Vec<u8>)> = Vec::new();
        let missing = |pass: &str| {
            format!(
                "render_bundle: pass {pass:?} missing for {} (registered without it? reset_cameras and re-register)",
                cam.sensor_id
            )
        };
        if want.rgb {
            match outputs.get(&format!("{}:rgb", cam.sensor_id)) {
                Some(data) => planned.push(("rgb", FORMAT_RGBA8, "rgba8", data.clone())),
                None => return WireResponse::error(i, missing("rgb")),
            }
        }
        if want_id_output {
            match outputs.get(&format!("{}:id", cam.sensor_id)) {
                Some(data) => planned.push(("id", FORMAT_RGBA8, "rgba8", data.clone())),
                None => return WireResponse::error(i, missing("id")),
            }
        }
        if want.depth {
            let carla = cam.depth_encoding.as_deref() == Some("carla");
            match outputs.get(&format!("{}:depth", cam.sensor_id)) {
                Some(data) => {
                    let out = if carla {
                        crate::carla::depth_to_carla(data, cam.width, cam.height, stride, state.near_m, state.far_m)
                    } else {
                        data.clone()
                    };
                    planned.push((
                        "depth",
                        FORMAT_DEPTH32F,
                        if carla { "carla-depth-bgra" } else { "depth32f" },
                        out,
                    ));
                }
                None => return WireResponse::error(i, missing("depth")),
            }
        }
        if want_semantic {
            let Some(id_data) = outputs.get(&format!("{}:id", cam.sensor_id)) else {
                return WireResponse::error(i, missing("semantic (id source)"));
            };
            let legend = &state.legend;
            let app = &state.app;
            let out = crate::carla::semantic_from_ids(id_data, cam.width, cam.height, stride, |id| {
                if let Some(class) = app.actor_instance_class(id) {
                    return crate::carla::actor_class_of(class);
                }
                legend.get(&id).map(|n| crate::carla::static_class_of(n)).unwrap_or(0)
            });
            planned.push(("semantic", FORMAT_RGBA8, "rgba8", out));
        }
        for (pass, format_tag, format_name, data) in planned {
            let digest = crc32fast::hash(&data);
            let offset = match state.shm.publish(
                &cam.sensor_id,
                pass,
                cam.width,
                cam.height,
                format_tag,
                sim_tick,
                &data,
            ) {
                Ok(offset) => offset,
                Err(error) => return WireResponse::error(i, format!("publish: {error}")),
            };
            entries.push(BundleEntry {
                camera_id: cam.sensor_id.clone(),
                pass: pass.to_string(),
                payload_offset: offset + crate::shm::RECORD_HEADER_BYTES as u64,
                payload_len: data.len() as u64,
                width: cam.width,
                height: cam.height,
                format_tag,
                digest,
            });
            frames.push(FrameRecord {
                sensor_id: cam.sensor_id.clone(),
                pass: pass.to_string(),
                offset,
                len: data.len() as u64,
                width: cam.width,
                height: cam.height,
                format: format_name.to_string(),
                tick_id: sim_tick,
                digest: Some(format!("{digest:08x}")),
            });
        }
    }
    if !lidar_rig.is_empty() || !radar_rig.is_empty() {
        let actor_scene = build_sensor_scene(state.app.sensor_triangles(true));
        let combined_scene = CombinedSensorScene {
            static_scene: &state.static_sensor_scene,
            actor_scene: &actor_scene,
        };
        let mut instance_velocities = HashMap::new();
        let tick_hz = state
            .current_tick
            .and_then(|index| state.scene.get(index as usize))
            .map(|frame| frame.tick_hz)
            .filter(|tick_hz| *tick_hz > 0.0)
            .unwrap_or(20.0);
        if let Some(frame) = state
            .current_tick
            .and_then(|index| state.scene.get(index as usize))
        {
            for actor in &frame.actors {
                if let Some(instance_id) = state.app.actor_instance_id(&actor.id) {
                    instance_velocities.insert(instance_id, Vec3::from_array(actor.velocity));
                }
            }
        }
        let instance_class = |instance_id| {
            state
                .app
                .actor_instance_class(instance_id)
                .map(sensors::taxonomy::SemanticClass::from_actor_class)
                .or_else(|| {
                    state
                        .legend
                        .get(&instance_id)
                        .map(|name| sensors::taxonomy::SemanticClass::from_mesh_name(name))
                })
                .unwrap_or(sensors::taxonomy::SemanticClass::Prop)
        };
        let mut sensor_payloads: Vec<(
            String,
            &'static str,
            u32,
            &'static str,
            u32,
            Vec<u8>,
        )> = Vec::with_capacity(lidar_rig.len() + radar_rig.len());
        for sensor in &lidar_rig {
            let mount = match resolve_sensor_mount(state, &sensor.attach) {
                Ok(mount) => mount,
                Err(error) => return WireResponse::error(i, error),
            };
            let config = sensors::lidar::LidarConfig {
                channels: sensor.channels,
                rotation_frequency_hz: sensor.rotation_frequency_hz,
                points_per_second: sensor.points_per_second,
                vfov_deg: sensor.vertical_fov_deg,
                hfov_deg: sensor.horizontal_fov_deg,
                range_m: sensor.range_m,
            };
            let points = sensors::lidar::scan(
                &combined_scene,
                &config,
                mount.origin,
                mount.rotation,
                &instance_class,
            );
            let count = points.len() as u32;
            sensor_payloads.push((
                sensor.sensor_id.clone(),
                "lidar",
                FORMAT_LIDAR_PLY,
                "ply-ascii",
                count,
                sensors::formats::encode_lidar_ply(&points),
            ));
        }
        for sensor in &radar_rig {
            let mount = match resolve_sensor_mount(state, &sensor.attach) {
                Ok(mount) => mount,
                Err(error) => return WireResponse::error(i, error),
            };
            let config = sensors::radar::RadarConfig::from_budget(
                Some(sensor.points_per_second),
                tick_hz,
                sensor.horizontal_fov_deg,
                sensor.vertical_fov_deg,
                sensor.range_m,
            );
            let detections = sensors::radar::scan(
                &combined_scene,
                &config,
                mount.origin,
                mount.rotation,
                mount.host_velocity,
                &|instance_id| {
                    instance_velocities
                        .get(&instance_id)
                        .copied()
                        .unwrap_or(Vec3::ZERO)
                },
            );
            let count = detections.len() as u32;
            sensor_payloads.push((
                sensor.sensor_id.clone(),
                "radar",
                FORMAT_RADAR_CSV,
                "radar-csv",
                count,
                sensors::formats::encode_radar_csv(&detections),
            ));
        }
        for (sensor_id, pass, format_tag, format_name, count, data) in sensor_payloads {
            if let Err(error) = publish_sensor_payload(
                state,
                &sensor_id,
                pass,
                format_tag,
                format_name,
                count,
                sim_tick,
                &data,
                &mut entries,
                &mut frames,
            ) {
                return WireResponse::error(i, error);
            }
        }
    }
    // A bundle bigger than the ring would overwrite its own frames; refuse
    // before flipping the pointer (frames are garbage, pointer stays valid).
    if state.shm.cursor_total() - start_cursor > state.shm.usable_bytes() {
        return WireResponse::error(
            i,
            format!(
                "render_bundle: bundle ({} bytes) exceeds ring capacity ({} usable); raise --shm-size-mb",
                state.shm.cursor_total() - start_cursor,
                state.shm.usable_bytes()
            ),
        );
    }
    match state.shm.publish_bundle(sim_tick, start_cursor, &entries) {
        Ok((bundle_offset, bundle_len)) => WireResponse {
            i,
            body: ResponseBody::RenderBundle {
                ok: true,
                sim_tick,
                bundle_offset,
                bundle_len,
                frames,
                server_ms: t0.elapsed().as_secs_f64() * 1000.0,
            },
        },
        Err(error) => WireResponse::error(i, format!("publish bundle: {error}")),
    }
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

#[cfg(test)]
mod tests {
    use super::{actor_base_y, instance_coverage, row_stride, CombinedSensorScene};
    use bevy::math::{Quat, Vec3};
    use sensors::bvh::{RaycastScene, Tri};
    use sensors::taxonomy::SemanticClass;

    #[test]
    fn coverage_counts_nonzero_rgb_and_ignores_alpha_and_padding() {
        let mut data = vec![0_u8; row_stride(2, 4) * 2];
        data[3] = 255; // Background alpha must not count.
        data[4] = 1;
        data[row_stride(2, 4) + 1] = 2;
        data[row_stride(2, 4) + 8] = 9; // Padding must not count.
        assert_eq!(instance_coverage(&data, 2, 2), 0.5);
    }

    #[test]
    fn authored_actor_height_precedes_mesh_ground() {
        assert_eq!(actor_base_y(2.225, None, -9.7), 2.225);
        assert_eq!(actor_base_y(0.0, Some(3.5), -9.7), 3.5);
        assert_eq!(actor_base_y(0.0, None, 1.75), 1.75);
    }

    fn deterministic_sensor_run() -> Vec<(Vec<u8>, Vec<u8>)> {
        let mut static_scene = RaycastScene::new();
        for (a, b, c) in [
            (
                Vec3::new(10.0, -10.0, -10.0),
                Vec3::new(10.0, 10.0, -10.0),
                Vec3::new(10.0, 10.0, 10.0),
            ),
            (
                Vec3::new(10.0, -10.0, -10.0),
                Vec3::new(10.0, 10.0, 10.0),
                Vec3::new(10.0, -10.0, 10.0),
            ),
        ] {
            static_scene.push_tri(Tri { a, b, c, instance_id: 1 });
        }
        static_scene.build();
        let actor_scene = RaycastScene::new();
        let scene = CombinedSensorScene {
            static_scene: &static_scene,
            actor_scene: &actor_scene,
        };
        let lidar = sensors::lidar::LidarConfig {
            channels: 2,
            rotation_frequency_hz: 2.0,
            points_per_second: 256,
            vfov_deg: 10.0,
            hfov_deg: 30.0,
            range_m: 30.0,
        };
        let radar = sensors::radar::RadarConfig::from_budget(
            Some(128),
            20.0,
            30.0,
            10.0,
            30.0,
        );
        (0..3)
            .map(|tick| {
                let origin = Vec3::new(tick as f32 * 0.25, 0.0, 0.0);
                let lidar_points = sensors::lidar::scan(
                    &scene,
                    &lidar,
                    origin,
                    Quat::IDENTITY,
                    &|_| SemanticClass::Road,
                );
                let radar_detections = sensors::radar::scan(
                    &scene,
                    &radar,
                    origin,
                    Quat::IDENTITY,
                    Vec3::ZERO,
                    &|_| Vec3::ZERO,
                );
                (
                    sensors::formats::encode_lidar_ply(&lidar_points),
                    sensors::formats::encode_radar_csv(&radar_detections),
                )
            })
            .collect()
    }

    #[test]
    fn persistent_lidar_radar_payloads_are_bit_identical_across_three_tick_runs() {
        let first = deterministic_sensor_run();
        let second = deterministic_sensor_run();
        assert_eq!(first, second);
        assert_ne!(first[0], first[2], "fixture must exercise distinct ticks");
    }
}
