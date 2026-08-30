//! Reusable headless Bevy rendering engine for SimForge (`native` engine).
//!
//! Grown from scripts/renderer-spike/bevy-spike (GO verdict, FINDINGS.md):
//! DefaultPlugins minus Winit/Audio, no primary window, offscreen `Image`
//! render targets with GPU->CPU readback via copy_texture_to_buffer +
//! map_async. Unlike the spike CLI (which drives one App through a fixed
//! pose sequence), this module exposes a host-controlled [`SceneApp`]: the
//! owner calls [`SceneApp::render_once`] explicitly, which makes both the
//! job renderer and the long-lived service trivially sequential and
//! deterministic.
//!
//! Determinism contract (same construction rules as the spike):
//! MSAA Off, no temporal effects, deterministic instance-ID assignment
//! (meshes sorted by name then entity bits), fixed clear color, single
//! blocking readback per rendered frame.
//!
//! Lighting/profile routing: the scene is lit by the WSB4 lighting ladder
//! (`crate::lighting::spawn_lighting` — IBL sky, physical sun via the shared
//! spec docs/lighting-calibration.md) and every RGB camera gets its render
//! profile from `crate::profiles::RenderProfile::apply` (fixed EV100,
//! AgX cinematic stack, GTAO at rung ≥ 3). Temporal effects (TAA, motion
//! blur, auto-exposure) stay disabled: the host-driven single-step loop
//! renders exactly one frame per update.
use anyhow::{bail, Result};
use bevy::app::ScheduleRunnerPlugin;
use bevy::camera::visibility::RenderLayers;
use bevy::camera::RenderTarget;
use bevy::core_pipeline::tonemapping::Tonemapping;
use bevy::gltf::{Gltf, GltfMaterialName};
use bevy::light::DirectionalLightShadowMap;
use bevy::log::LogPlugin;
use bevy::prelude::*;
use bevy::render::camera::ExtractedCamera;
use bevy::render::render_asset::RenderAssets;
use bevy::render::render_resource::{
    Buffer, BufferDescriptor, BufferUsages, CommandEncoderDescriptor, MapMode, PollType,
    TexelCopyBufferInfo, TexelCopyBufferLayout, TextureFormat, TextureUsages,
};
use bevy::render::renderer::{RenderContext, RenderDevice, RenderGraph, RenderQueue};
use bevy::render::texture::GpuImage;
use bevy::render::view::ViewDepthTexture;
use bevy::render::{Extract, Render, RenderApp, RenderSystems};
use bevy::window::ExitCondition;
use bevy::world_serialization::{WorldAssetRoot, WorldInstance, WorldInstanceSpawner};
use crate::lighting::{self, LightingRung};
use crate::profiles::{RenderProfile, RenderProfileConfig};
use crate::weather::Weather;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::time::{Duration, Instant};

/// Render profile: part of the render intent (native-renderer plan WSB4).
///
/// - `Sensor`: linear output (no tonemapping), fixed exposure, zero temporal
///   effects — the hash-stable machine-vision profile.
/// - `Cinematic`: AgX tonemapping + authored look — human-facing; the full
///   realism stack (WSB4) layers on top of this variant.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Profile {
    Sensor,
    Cinematic,
}

impl Profile {
    fn render_profile(self) -> RenderProfile {
        match self {
            Profile::Sensor => RenderProfile::Sensor,
            Profile::Cinematic => RenderProfile::Cinematic,
        }
    }
}

/// Scene lighting configuration, resolved through the shared lighting spec
/// (docs/lighting-calibration.md) at rung ≥ 2. `sun_lux`/`ambient` are the
/// spike-calibrated legacy values consumed only at rung < 2.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Lighting {
    #[serde(default = "default_sun_elev")]
    pub sun_elev_deg: f32,
    #[serde(default = "default_sun_azim")]
    pub sun_azim_deg: f32,
    /// Legacy spike sun illuminance; used only at rung < 2.
    #[serde(default = "default_lux")]
    pub sun_lux: f32,
    /// Legacy spike flat ambient; used only at rung 0.
    #[serde(default = "default_ambient")]
    pub ambient: f32,
    /// Lighting-ladder rung (crate::lighting): 0 spike baseline, 1 IBL,
    /// 2 physical sun/EV100, 3 +GTAO/contact shadows, 4 +PCSS.
    #[serde(default = "default_rung")]
    pub rung: u8,
    /// Weather state feeding the `LightingPlan` (sun/sky scaling + EV100).
    #[serde(default)]
    pub weather: Weather,
    /// Equirectangular HDRI for the sky/IBL. `None` generates the
    /// deterministic analytic sky (`lighting::synthetic_sky_cubemap`).
    #[serde(default)]
    pub sky_hdr: Option<String>,
}

fn default_sun_elev() -> f32 {
    60.0
}
fn default_sun_azim() -> f32 {
    190.0
}
fn default_lux() -> f32 {
    12000.0
}
fn default_ambient() -> f32 {
    1.2
}
fn default_rung() -> u8 {
    3
}

impl Default for Lighting {
    fn default() -> Self {
        Self {
            sun_elev_deg: default_sun_elev(),
            sun_azim_deg: default_sun_azim(),
            sun_lux: default_lux(),
            ambient: default_ambient(),
            rung: default_rung(),
            weather: Weather::default(),
            sky_hdr: None,
        }
    }
}

/// Which passes to produce for one camera. Pass keys are `<sensor>:rgb|id|depth`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PassSet {
    #[serde(default = "default_true")]
    pub rgb: bool,
    #[serde(default)]
    pub id: bool,
    #[serde(default)]
    pub depth: bool,
}

fn default_true() -> bool {
    true
}

impl Default for PassSet {
    fn default() -> Self {
        Self { rgb: true, id: false, depth: false }
    }
}

impl PassSet {
    /// Every readback key this pass set produces for one sensor.
    pub fn keys(&self, sensor_id: &str) -> Vec<String> {
        let mut keys = Vec::with_capacity(3);
        if self.rgb {
            keys.push(format!("{sensor_id}:rgb"));
        }
        if self.id {
            keys.push(format!("{sensor_id}:id"));
        }
        if self.depth {
            keys.push(format!("{sensor_id}:depth"));
        }
        keys
    }
}

/// Static description of one logical rig camera.
#[derive(Clone, Debug)]
pub struct CameraSpec {
    pub sensor_id: String,
    pub width: u32,
    pub height: u32,
    /// Vertical field of view in degrees (spike / W0 convention).
    pub fov_y_deg: f32,
    pub near: f32,
    pub far: f32,
    pub passes: PassSet,
}

// ---------------------------------------------------------------------------
// Main world <-> render world plumbing (adapted from the spike)
// ---------------------------------------------------------------------------

struct SentPass {
    key: String,
    data: Vec<u8>,
}

#[derive(Resource, Deref)]
struct MainReceiver(crossbeam_channel::Receiver<SentPass>);
#[derive(Resource, Deref)]
struct RenderSender(crossbeam_channel::Sender<SentPass>);

/// Main-world marker: read back the RGB target (or its view depth texture)
/// identified by `src_image`, publishing rows under `key`.
#[derive(Component, Clone)]
struct ReadbackTarget {
    key: String,
    src_image: Handle<Image>,
    depth: bool,
}

/// One persistent GPU->CPU staging buffer in the render world.
struct StagingBuffer {
    key: String,
    src_image: Handle<Image>,
    depth: bool,
    padded_row: usize,
    height: u32,
    buffer: Buffer,
}

#[derive(Resource, Default)]
struct Staging(Vec<StagingBuffer>);

fn setup_target_image(
    images: &mut Assets<Image>,
    w: u32,
    h: u32,
    format: TextureFormat,
) -> Handle<Image> {
    let mut img = Image::new_target_texture(w, h, format, None);
    img.texture_descriptor.usage |= TextureUsages::COPY_SRC;
    images.add(img)
}

fn make_buffer(device: &RenderDevice, size_bytes: usize) -> Buffer {
    device.create_buffer(&BufferDescriptor {
        label: Some("native-readback"),
        size: size_bytes as u64,
        usage: BufferUsages::MAP_READ | BufferUsages::COPY_DST,
        mapped_at_creation: false,
    })
}

fn aligned_row(width: usize, pixel_size: usize) -> usize {
    RenderDevice::align_copy_bytes_per_row(width * pixel_size)
}

/// Strip wgpu 256-byte row padding from a readback buffer.
pub fn strip_padding(data: &[u8], width: usize, height: usize, pixel: usize) -> Vec<u8> {
    let row = width * pixel;
    let aligned = aligned_row(width, pixel);
    if row == aligned {
        return data[..row * height].to_vec();
    }
    data.chunks_exact(aligned)
        .take(height)
        .flat_map(|r| &r[..row])
        .copied()
        .collect()
}

fn sun_direction(elev_deg: f32, azim_deg: f32) -> Dir3 {
    // Unit vector pointing FROM the sun INTO the scene.
    let elev = elev_deg.to_radians();
    let azim = azim_deg.to_radians();
    let dir = Vec3::new(
        -(elev.cos() * azim.sin()),
        -elev.sin(),
        -(elev.cos() * azim.cos()),
    );
    Dir3::new(dir.normalize()).unwrap()
}

// ---------------------------------------------------------------------------
// Markers & state
// ---------------------------------------------------------------------------

#[derive(Component)]
struct TileLoad(Handle<Gltf>);
#[derive(Component)]
struct SceneSpawned;
#[derive(Component)]
struct IdClone;
#[derive(Component, Clone, Copy)]
struct InstanceId(u32);
#[derive(Component)]
struct ActorModelRoot;


/// One legend entry: instance-ID value -> source mesh name.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct LegendEntry {
    pub id: u32,
    pub name: String,
}

/// World-space triangle snapshot for deterministic CPU lidar/radar raycasts.
#[derive(Clone, Copy, Debug)]
pub struct SensorTriangle {
    pub a: [f32; 3],
    pub b: [f32; 3],
    pub c: [f32; 3],
    pub instance_id: u32,
}

#[derive(Resource, Default)]
struct Legend(Vec<LegendEntry>);

struct GroupEntities {
    spec: CameraSpec,
    rgb_entity: Entity,
    id_entity: Option<Entity>,
}

// ---------------------------------------------------------------------------
// SceneApp
// ---------------------------------------------------------------------------

/// Host-driven headless renderer over a static tile scene.
///
/// The Bevy `App` is never `run()`; every [`Self::render_once`] performs one
/// full main-world + render-world iteration ending in a blocking GPU
/// readback of all registered passes.

// ---------------------------------------------------------------------------
// Dynamic actors + ground height (V4 SensorRig)
// ---------------------------------------------------------------------------

/// Coarse ground-height lookup: minimum world vertex Y per grid cell.
///
/// Traces carry no height channel (scene-state.v1 groundY may be null), so
/// actor origins are snapped onto the static scene. Taking the per-cell
/// MINIMUM keeps walls/roofs from inflating the estimate: every mesh that
/// meets the ground contributes ground-level vertices, while anything
/// elevated (roofs, foliage) only raises the maximum.
#[derive(Default)]
struct GroundField {
    cell_m: f32,
    min_y: HashMap<(i64, i64), f32>,
}

impl GroundField {
    fn build(app: &mut App, cell_m: f32) -> GroundField {
        let world = app.world_mut();
        let mut field = GroundField { cell_m, min_y: HashMap::new() };
        let mut q = world.query::<(&Mesh3d, &GlobalTransform)>();
        let meshes = world.resource::<Assets<Mesh>>();
        for (mesh, gt) in q.iter(world) {
            let Some(mesh) = meshes.get(&mesh.0) else { continue };
            let Some(pos) = mesh.attribute(Mesh::ATTRIBUTE_POSITION) else { continue };
            let bevy::mesh::VertexAttributeValues::Float32x3(values) = pos else { continue };
            let gt = gt.to_matrix();
            for v in values.iter() {
                let p = gt.transform_point3(Vec3::from(*v));
                let key = (
                    (p.x / cell_m).floor() as i64,
                    (p.z / cell_m).floor() as i64,
                );
                field
                    .min_y
                    .entry(key)
                    .and_modify(|y| *y = y.min(p.y))
                    .or_insert(p.y);
            }
        }
        field
    }

    /// Ground height under (x, z); 0.0 where the scene has no geometry.
    fn sample(&self, x: f32, z: f32) -> f32 {
        let key = ((x / self.cell_m).floor() as i64, (z / self.cell_m).floor() as i64);
        self.min_y.get(&key).copied().unwrap_or(0.0)
    }
}

pub struct SceneApp {
    app: App,
    receiver: crossbeam_channel::Receiver<SentPass>,
    groups: Vec<GroupEntities>,
    next_camera_order: isize,
    ready: bool,
    /// Scene-state actors: id -> (cuboid entity, allocated instance id).
    actors: HashMap<String, (Entity, u32)>,
    /// Dynamic actor id -> (loaded catalog GLB root, authored scale, mesh count).
    actor_models: HashMap<String, (Entity, f32, usize)>,
    /// Per-actor cloned tint material handles. Catalog materials are shared
    /// assets, so tinting must never mutate the source GLB material.
    actor_tint_materials: HashMap<String, Vec<Handle<StandardMaterial>>>,
    /// Instance id -> semantic class name for dynamically spawned actors.
    actor_classes: HashMap<u32, String>,
    /// Next instance id for dynamic actors (beyond the static legend range).
    next_instance_id: u32,
    /// Coarse ground-height field (min vertex y per cell), built at readiness.
    ground: GroundField,
    /// Sky cubemap spawned by the lighting ladder (rung ≥ 1), attached as a
    /// `Skybox` to every RGB camera.
    sky: Option<Handle<Image>>,
    /// Skybox brightness from the resolved `LightingPlan`.
    skybox_brightness: f32,
    /// Fixed EV100 from the resolved `LightingPlan` (spec §Exposure).
    ev100_fixed: f32,
    profile_config: RenderProfileConfig,
}

impl SceneApp {
    /// Build the headless app with lights and render-world plumbing.
    ///
    /// Fails when the lighting ladder cannot be built (e.g. an unreadable
    /// `sky_hdr`).
    pub fn new(lighting: &Lighting) -> Result<Self> {
        Self::new_with_profile_config(lighting, RenderProfileConfig::default())
    }

    pub fn new_with_profile_config(
        lighting: &Lighting,
        profile_config: RenderProfileConfig,
    ) -> Result<Self> {
        profile_config.cinematic.validate()?;
        std::env::set_var("BEVY_ASSET_ROOT", "/");
        let (tx, rx) = crossbeam_channel::unbounded::<SentPass>();
        let mut app = App::new();
        // The reusable job/service engine may render sensor and cinematic
        // views together. PCSS is stochastic on current wgpu/Bevy and made
        // sensor RGB hashes differ between identical replays, so mixed
        // SceneApp lighting is capped at deterministic hard cascades.
        // The standalone cinematic CLI still exposes rung-4 PCSS.
        let rung = LightingRung(lighting.rung.min(3));
        let plan = lighting.weather.lighting_plan(None, lighting.sun_elev_deg);
        let sun_dir = sun_direction(lighting.sun_elev_deg, lighting.sun_azim_deg);
        app.insert_resource(ClearColor(Color::srgb(0.53, 0.74, 0.92)))
            .insert_resource(DirectionalLightShadowMap { size: 2048 })
            .insert_resource(Legend::default())
            .add_plugins((
                DefaultPlugins
                    .set(bevy::asset::AssetPlugin {
                        file_path: "/".into(),
                        ..default()
                    })
                    .set(WindowPlugin {
                        primary_window: None,
                        exit_condition: ExitCondition::DontExit,
                        ..default()
                    })
                    .disable::<bevy::winit::WinitPlugin>()
                    .disable::<bevy::audio::AudioPlugin>()
                    // The pipelined renderer steps the render app on its own
                    // thread driven by App::run(); our host-controlled update
                    // loop requires in-line render stepping.
                    .disable::<bevy::render::pipelined_rendering::PipelinedRenderingPlugin>()
                    .set(LogPlugin {
                        filter: "warn,wgpu_core=warn,wgpu_hal=warn,naga=warn".into(),
                        ..default()
                    }),
                ScheduleRunnerPlugin::run_loop(Duration::ZERO),
                crate::road_detail::RoadDetailPlugin,
            ))
            .add_systems(
                Update,
                (
                    spawn_loaded_tiles,
                    crate::veg::load_veg_roots,
                    crate::veg::instantiate_veg,
                )
                    .chain(),
            )
            .insert_resource(MainReceiver(rx.clone()));

        // WSB4 lighting ladder (shared spec: docs/lighting-calibration.md).
        // Spawned through Commands so the exact same `spawn_lighting` path
        // serves the CLI, the job runner and the service.
        let sky = {
            let world = app.world_mut();
            let sky = world.resource_scope(|world, mut images: Mut<Assets<Image>>| {
                let mut commands = world.commands();
                lighting::spawn_lighting(
                    &mut commands,
                    &mut images,
                    rung,
                    &plan,
                    sun_dir,
                    400.0,
                    lighting.sky_hdr.as_deref(),
                    (lighting.sun_lux, lighting.ambient),
                )
            })?;
            world.flush();
            sky
        };

        let render_app = app.get_sub_app_mut(RenderApp).unwrap();
        render_app
            .insert_resource(RenderSender(tx))
            .init_resource::<Staging>()
            .init_resource::<ExtractedTargets>()
            .add_systems(ExtractSchedule, extract_targets)
            .add_systems(RenderGraph, copy_passes)
            .add_systems(Render, sync_staging.before(copy_passes))
            .add_systems(Render, receive_passes.after(RenderSystems::Render));

        // Drive the plugin lifecycle to completion manually (we never call
        // app.run()): pump updates until plugins are built, then finish so the
        // render world has its RenderDevice before cameras register readbacks.
        while app.plugins_state() != bevy::app::PluginsState::Ready {
            app.update();
        }
        app.finish();
        app.cleanup();
        Ok(Self {
            app,
            receiver: rx,
            groups: Vec::new(),
            next_camera_order: 0,
            ready: false,
            actors: HashMap::new(),
            actor_models: HashMap::new(),
            actor_tint_materials: HashMap::new(),
            actor_classes: HashMap::new(),
            next_instance_id: 0,
            ground: GroundField::default(),
            sky,
            skybox_brightness: plan.skybox_brightness,
            ev100_fixed: plan.ev100_fixed.unwrap_or_else(|| {
                lighting.weather.sensor_ev100(lighting.sun_elev_deg)
            }),
            profile_config,
        })
    }


    /// Queue GLB tiles for loading. Call before [`Self::wait_until_ready`].
    pub fn load_tiles(&mut self, glbs: &[String]) -> Result<()> {
        for g in glbs {
            if !std::path::Path::new(g).is_absolute() {
                bail!("glb paths must be absolute: {g}");
            }
        }
        let server = self.app.world().resource::<AssetServer>().clone();
        for g in glbs {
            let path: String = g.trim_start_matches('/').to_owned();
            let handle: Handle<Gltf> = server.load(path);
            self.app.world_mut().spawn(TileLoad(handle));
        }
        Ok(())
    }

    /// Queue vegetation prototype GLBs plus their `.instances.json` sidecars.
    /// Keeping this separate from static tiles avoids accidentally drawing the
    /// uninstanced prototype roots.
    pub fn load_vegetation(&mut self, glbs: &[String]) -> Result<()> {
        for g in glbs {
            if !std::path::Path::new(g).is_absolute() {
                bail!("vegetation glb paths must be absolute: {g}");
            }
        }
        let server = self.app.world().resource::<AssetServer>().clone();
        let mut commands = self.app.world_mut().commands();
        crate::veg::spawn_veg(&mut commands, &server, glbs);
        Ok(())
    }

    /// Register a camera group (RGB target + optional ID camera + depth copy).
    ///
    /// Registration is allowed both before [`Self::wait_until_ready`] and
    /// after it (V4: per-request dynamic camera registration in the service).
    /// Post-ready groups join the already-finalized ID-pass layer directly;
    /// the legend is not re-derived, so IDs stay stable.
    pub fn add_camera(&mut self, spec: CameraSpec, profile: Profile) {

        let rgb_image = {
            let mut images = self.app.world_mut().resource_mut::<Assets<Image>>();
            setup_target_image(&mut images, spec.width, spec.height, TextureFormat::Rgba8UnormSrgb)
        };
        let rgb_handle = rgb_image.clone();

        let e = self.app.world_mut().spawn((
            Camera3d {
                depth_texture_usages: (TextureUsages::RENDER_ATTACHMENT
                    | TextureUsages::COPY_SRC)
                    .into(),
                ..default()
            },
            Projection::from(PerspectiveProjection {
                fov: spec.fov_y_deg.to_radians(),
                near: spec.near,
                far: spec.far,
                ..default()
            }),
            Msaa::Off,
            Camera { order: self.next_camera_order, ..default() },
            Transform::IDENTITY,
            RenderTarget::Image(rgb_image.into()),
        ));
        let rgb_entity = e.id();
        self.next_camera_order += 10;

        // Sensor views retain the deterministic contract. Cinematic views use
        // the configured temporal/reflection/filmic stack and can coexist in
        // the same SceneApp.
        {
            let world = self.app.world_mut();
            let mut commands = world.commands();
            profile.render_profile().apply(
                &mut commands,
                rgb_entity,
                self.ev100_fixed,
                self.sky.clone(),
                self.skybox_brightness,
                self.profile_config.cinematic,
            );
            // Sensor deliberately receives no stochastic screen-space
            // AO/contact pass. Cinematic owns those effects.
        }
        self.app.world_mut().flush();

        self.app.world_mut().spawn(ReadbackTarget {
            key: format!("{}:rgb", spec.sensor_id),
            src_image: rgb_handle.clone(),
            depth: false,
        });

        let id_entity = if spec.passes.id {
            let id_image = {
                let mut images = self.app.world_mut().resource_mut::<Assets<Image>>();
                setup_target_image(
                    &mut images,
                    spec.width,
                    spec.height,
                    TextureFormat::Rgba8UnormSrgb,
                )
            };
            self.app.world_mut().spawn(ReadbackTarget {
                key: format!("{}:id", spec.sensor_id),
                src_image: id_image.clone(),
                depth: false,
            });
            let cmd = self.app.world_mut().spawn((
                Camera3d::default(),
                Camera {
                    clear_color: ClearColorConfig::Custom(Color::BLACK),
                    order: self.next_camera_order,
                    ..default()
                },
                Projection::from(PerspectiveProjection {
                    fov: spec.fov_y_deg.to_radians(),
                    near: spec.near,
                    far: spec.far,
                    ..default()
                }),
                Msaa::Off,
                Tonemapping::None,
                Transform::IDENTITY,
                RenderTarget::Image(id_image.into()),
                RenderLayers::layer(1),
            ));
            self.next_camera_order += 10;
            Some(cmd.id())
        } else {
            None
        };

        if spec.passes.depth {
            self.app.world_mut().spawn(ReadbackTarget {
                key: format!("{}:depth", spec.sensor_id),
                src_image: rgb_handle,
                depth: true,
            });
        }

        self.groups.push(GroupEntities { spec, rgb_entity, id_entity });
        if self.ready {
            // Post-ready registration: pump one update so extraction and
            // pipeline compilation happen before the next render_once.
            self.app.update();
            while self.receiver.try_recv().is_ok() {}
        }
    }

    /// Registered camera specs (diagnostics).
    pub fn cameras(&self) -> impl Iterator<Item = &CameraSpec> {
        self.groups.iter().map(|g| &g.spec)
    }

    /// Frozen legend (static instance ids). Dynamic actors get ids above the
    /// static maximum; see [`Self::actor_instance_class`].
    pub fn legend(&self) -> Vec<LegendEntry> {
        self.app.world().resource::<Legend>().0.clone()
    }

    /// Ground height under (x, z) from the readiness height field.
    pub fn ground_at(&self, x: f32, z: f32) -> f32 {
        self.ground.sample(x, z)
    }

    /// Apply a `simforge.road-detail/v1` sidecar (splat-blended asphalt
    /// variants + wear/marking modulation + decal overlay) to the spawned
    /// scene. Call after [`Self::wait_until_ready`]; follow with
    /// [`Self::warmup`] so the extended-material pipelines compile before
    /// capture. No-op for the instance-ID pass (ID materials are never
    /// GLB-named).
    pub fn apply_road_detail(
        &mut self,
        sidecar_path: &str,
    ) -> Result<crate::road_detail::RoadDetailStats> {
        let stats =
            crate::road_detail::apply(&mut self.app, std::path::Path::new(sidecar_path))
                .map_err(|e| anyhow::anyhow!("{e:#}"))?;
        // Pump one update so the swapped materials extract before the next
        // render; drain any passes it produced.
        self.app.update();
        while self.receiver.try_recv().is_ok() {}
        Ok(stats)
    }

    /// Spawn or move one scene-state actor cuboid. The box is named
    /// `actor:<id>` and carries an instance id above the static legend range
    /// so ID-pass pixels resolve to the actor class.
    ///
    /// `position` is the actor origin on the ground; when `snap_ground` is
    /// set the y coordinate is replaced by the sampled ground height (traces
    /// carry no height channel).
    pub fn upsert_actor(
        &mut self,
        id: &str,
        class: &str,
        position: [f32; 3],
        yaw_rad: f32,
        dims: [f32; 3],
        color: [f32; 3],
        snap_ground: bool,
    ) {
        let y = if snap_ground { self.ground.sample(position[0], position[2]) } else { position[1] };
        let transform = Transform {
            translation: Vec3::new(position[0], y, position[2]),
            rotation: Quat::from_rotation_y(yaw_rad),
            scale: Vec3::ONE,
        };
        let model = self.actor_models.get(id).copied();
        let world = self.app.world_mut();
        if let Some((entity, _)) = self.actors.get(id) {
            if let Some(mut t) = world.get_mut::<Transform>(*entity) {
                *t = transform;
            }
            if let Some((model_entity, scale, _)) = model {
                if let Some(mut t) = world.get_mut::<Transform>(model_entity) {
                    t.translation = transform.translation;
                    t.rotation = transform.rotation;
                    t.scale = Vec3::splat(scale);
                }
            }
            return;
        }
        let instance_id = self.next_instance_id + 1;
        self.next_instance_id = instance_id;
        let mesh_handle = {
            let mut meshes = world.resource_mut::<Assets<Mesh>>();
            meshes.add(Cuboid::new(dims[0], dims[1], dims[2]))
        };
        let mat_handle = {
            let mut materials = world.resource_mut::<Assets<StandardMaterial>>();
            materials.add(StandardMaterial {
                base_color: Color::srgb(color[0], color[1], color[2]),
                ..default()
            })
        };
        // Deterministic instance-ID material for the layer-1 clone: same
        // RGB24 encoding as finalize_scene.
        let bytes = instance_id.to_le_bytes();
        let id_mat = {
            let mut materials = world.resource_mut::<Assets<StandardMaterial>>();
            materials.add(StandardMaterial {
                base_color: Color::srgb_u8(bytes[0], bytes[1], bytes[2]),
                unlit: true,
                ..default()
            })
        };
        let e = world.spawn((
            Name::new(format!("actor:{id}")),
            Mesh3d(mesh_handle.clone()),
            MeshMaterial3d(mat_handle),
            InstanceId(instance_id),
            transform,
        )).id();
        world.spawn((
            IdClone,
            Name::new(format!("actor:{id}")),
            Mesh3d(mesh_handle),
            MeshMaterial3d(id_mat),
            RenderLayers::layer(1),
            transform,
        ));
        self.actors.insert(id.to_string(), (e, instance_id));
        self.actor_classes.insert(instance_id, class.to_string());
    }

    /// Replace a spawned actor's visible cuboid with a catalog GLB while
    /// retaining its deterministic layer-1 cuboid as the sensor/ID proxy.
    ///
    /// Loading is blocking because the service must not acknowledge a tick
    /// until every modality sees the same fully-resident world.
    pub fn attach_actor_model(
        &mut self,
        actor_id: &str,
        glb_path: &std::path::Path,
        uniform_scale: f32,
        tint: Option<[f32; 3]>,
    ) -> Result<()> {
        let mesh_count_before = {
            let world = self.app.world_mut();
            let mut query = world.query::<&Mesh3d>();
            query.iter(world).count()
        };
        if self.actor_models.contains_key(actor_id) {
            return Ok(());
        }
        if !glb_path.is_absolute() || !glb_path.is_file() {
            bail!("actor model GLB is not an absolute existing file: {}", glb_path.display());
        }
        let (cuboid, _) = self
            .actors
            .get(actor_id)
            .copied()
            .ok_or_else(|| anyhow::anyhow!("attach model before actor spawn: {actor_id}"))?;
        let asset_path = glb_path.to_string_lossy().trim_start_matches('/').to_string();
        let server = self.app.world().resource::<AssetServer>().clone();
        let handle: Handle<Gltf> = server.load(asset_path);
        let deadline = Instant::now() + Duration::from_secs(300);
        let scene = loop {
            self.app.update();
            let scene = self
                .app
                .world()
                .resource::<Assets<Gltf>>()
                .get(&handle)
                .and_then(|gltf| gltf.default_scene.clone());
            if let Some(scene) = scene {
                break scene;
            }
            if Instant::now() > deadline {
                bail!("actor model failed to load: {}", glb_path.display());
            }
        };
        let base = self
            .app
            .world()
            .get::<Transform>(cuboid)
            .copied()
            .unwrap_or(Transform::IDENTITY);
        let mut model_transform = base;
        model_transform.scale = Vec3::splat(uniform_scale);
        let model_root = self
            .app
            .world_mut()
            .spawn((
                ActorModelRoot,
                Name::new(format!("actor-model:{actor_id}")),
                WorldAssetRoot(scene),
                model_transform,
            ))
            .id();
        self.app.world_mut().entity_mut(cuboid).insert(Visibility::Hidden);
        loop {
            self.app.update();
            let ready = {
                let world = self.app.world();
                match (
                    world.get::<WorldInstance>(model_root),
                    world.get_resource::<WorldInstanceSpawner>(),
                ) {
                    (Some(instance), Some(spawner)) => spawner.instance_is_ready(**instance),
                    _ => false,
                }
            };
            if ready {
                break;
            }
            if Instant::now() > deadline {
                bail!("actor model scene failed to instantiate: {}", glb_path.display());
            }
        }
        let tint_materials = if let Some(color) = tint {
            let targets = {
                let world = self.app.world();
                let mut stack = vec![model_root];
                let mut targets = Vec::new();
                while let Some(entity) = stack.pop() {
                    if let Some(children) = world.get::<Children>(entity) {
                        stack.extend(children.iter());
                    }
                    if world
                        .get::<GltfMaterialName>(entity)
                        .is_some_and(|name| &**name == "body_paint")
                    {
                        if let Some(material) =
                            world.get::<MeshMaterial3d<StandardMaterial>>(entity)
                        {
                            targets.push((entity, material.0.clone()));
                        }
                    }
                }
                targets
            };
            let Some((_, source_handle)) = targets.first() else {
                bail!(
                    "tintable actor model has no body_paint mesh slots: {}",
                    glb_path.display()
                );
            };
            let tinted_handle = {
                let world = self.app.world_mut();
                let mut tinted = world
                    .resource::<Assets<StandardMaterial>>()
                    .get(source_handle)
                    .cloned()
                    .ok_or_else(|| anyhow::anyhow!(
                        "body_paint material missing after actor model load: {}",
                        glb_path.display()
                    ))?;
                tinted.base_color = Color::srgb(color[0], color[1], color[2]);
                world.resource_mut::<Assets<StandardMaterial>>().add(tinted)
            };
            for (entity, _) in targets {
                self.app
                    .world_mut()
                    .entity_mut(entity)
                    .insert(MeshMaterial3d(tinted_handle.clone()));
            }
            vec![tinted_handle]
        } else {
            Vec::new()
        };
        let mesh_count_after = {
            let world = self.app.world_mut();
            let mut query = world.query::<&Mesh3d>();
            query.iter(world).count()
        };
        let model_mesh_count = mesh_count_after.saturating_sub(mesh_count_before);
        if model_mesh_count == 0 {
            bail!("actor model instantiated without mesh nodes: {}", glb_path.display());
        }
        self.actor_models.insert(
            actor_id.to_string(),
            (model_root, uniform_scale, model_mesh_count),
        );
        self.actor_tint_materials
            .insert(actor_id.to_string(), tint_materials);
        Ok(())
    }

    pub fn actor_has_model(&self, actor_id: &str) -> bool {
        self.actor_models.contains_key(actor_id)
    }

    pub fn actor_model_mesh_count(&self, actor_id: &str) -> usize {
        self.actor_models
            .get(actor_id)
            .map(|(_, _, count)| *count)
            .unwrap_or(0)
    }

    /// Effective sRGB base colors of this actor's cloned `body_paint`
    /// materials. Empty means the catalog model is not tintable.
    pub fn actor_model_tint_colors(&self, actor_id: &str) -> Vec<[f32; 4]> {
        let Some(handles) = self.actor_tint_materials.get(actor_id) else {
            return Vec::new();
        };
        let materials = self.app.world().resource::<Assets<StandardMaterial>>();
        handles
            .iter()
            .filter_map(|handle| materials.get(handle))
            .map(|material| material.base_color.to_srgba().to_f32_array())
            .collect()
    }
    /// Actor ids currently represented by visible scene geometry.
    pub fn actor_ids(&self) -> Vec<String> {
        self.actors.keys().cloned().collect()
    }

    /// Exclude or restore one actor's RGB geometry without touching its
    /// scene state or layer-1 instance-ID proxy.
    ///
    /// Catalog-backed actors keep their fallback cuboid hidden when restored;
    /// actors without a catalog model restore that cuboid instead.
    pub fn set_actor_visual_hidden(&mut self, actor_id: &str, hidden: bool) {
        let Some((actor, _)) = self.actors.get(actor_id).copied() else {
            return;
        };
        let model = self.actor_models.get(actor_id).map(|(entity, _, _)| *entity);
        let world = self.app.world_mut();
        if let Some(mut visibility) = world.get_mut::<Visibility>(actor) {
            *visibility = if hidden || model.is_some() {
                Visibility::Hidden
            } else {
                Visibility::Inherited
            };
        }
        if let Some(model) = model {
            if let Some(mut visibility) = world.get_mut::<Visibility>(model) {
                *visibility = if hidden {
                    Visibility::Hidden
                } else {
                    Visibility::Inherited
                };
            }
        }
    }


    /// Remove a despawned scene-state actor (both the visible box and its
    /// layer-1 ID clone).
    pub fn remove_actor(&mut self, id: &str) {
        if let Some((entity, instance)) = self.actors.remove(id) {
            let world = self.app.world_mut();
            let name = format!("actor:{id}");
            let mut q = world.query_filtered::<(Entity, &Name), With<IdClone>>();
            let clones: Vec<Entity> = q
                .iter(world)
                .filter(|(_, n)| n.as_str() == name)
                .map(|(e, _)| e)
                .collect();
            world.despawn(entity);
            for clone in clones {
                world.despawn(clone);
            }
            self.actor_classes.remove(&instance);
            if let Some((model, _, _)) = self.actor_models.remove(id) {
                world.despawn(model);
            }
            self.actor_tint_materials.remove(id);
        }
    }

    /// Semantic class name of a dynamic-actor instance id, if any.
    pub fn actor_instance_class(&self, instance_id: u32) -> Option<&str> {
        self.actor_classes.get(&instance_id).map(|s| s.as_str())
    }

    /// Stable instance id allocated to a dynamic actor, if it is spawned.
    pub fn actor_instance_id(&self, actor_id: &str) -> Option<u32> {
        self.actors.get(actor_id).map(|(_, instance_id)| *instance_id)
    }

    /// Snapshot either static map geometry or dynamic actor geometry.
    ///
    /// Static geometry is captured once by the long-lived service; only the
    /// small actor snapshot is rebuilt after each applied scene tick.
    pub fn sensor_triangles(&mut self, dynamic_actors: bool) -> Vec<SensorTriangle> {
        let world = self.app.world_mut();
        let mut query = world.query_filtered::<
            (&Mesh3d, &GlobalTransform, &InstanceId, Option<&Name>),
            Without<IdClone>,
        >();
        let meshes = world.resource::<Assets<Mesh>>();
        let mut out = Vec::new();
        for (mesh3d, transform, instance_id, name) in query.iter(world) {
            let is_actor = name.is_some_and(|name| name.as_str().starts_with("actor:"));
            if is_actor != dynamic_actors {
                continue;
            }
            let Some(mesh) = meshes.get(&mesh3d.0) else { continue };
            let Some(attribute) = mesh.attribute(Mesh::ATTRIBUTE_POSITION) else { continue };
            let bevy::mesh::VertexAttributeValues::Float32x3(vertices) = attribute else { continue };
            let matrix = transform.to_matrix();
            let mut push = |indices: [usize; 3]| {
                let point = |index: usize| matrix.transform_point3(Vec3::from(vertices[index])).to_array();
                out.push(SensorTriangle {
                    a: point(indices[0]),
                    b: point(indices[1]),
                    c: point(indices[2]),
                    instance_id: instance_id.0,
                });
            };
            match mesh.indices() {
                Some(bevy::mesh::Indices::U16(indices)) => {
                    for tri in indices.chunks_exact(3) {
                        push([tri[0] as usize, tri[1] as usize, tri[2] as usize]);
                    }
                }
                Some(bevy::mesh::Indices::U32(indices)) => {
                    for tri in indices.chunks_exact(3) {
                        push([tri[0] as usize, tri[1] as usize, tri[2] as usize]);
                    }
                }
                None => {
                    for first in (0..vertices.len()).step_by(3) {
                        if first + 2 < vertices.len() {
                            push([first, first + 1, first + 2]);
                        }
                    }
                }
            }
        }
        out
    }

    /// Drop every registered camera group (respawn-on-view-change primitive:
    /// the next render re-registers with fresh attributes). Also prunes the
    /// render-world staging buffers for the removed targets.
    pub fn clear_cameras(&mut self) {
        let sensor_ids: Vec<String> =
            self.groups.drain(..).map(|g| g.spec.sensor_id).collect();
        if sensor_ids.is_empty() {
            return;
        }
        let world = self.app.world_mut();
        let mut to_despawn: Vec<Entity> = Vec::new();
        let mut q = world.query::<(Entity, &ReadbackTarget)>();
        for (e, t) in q.iter(world) {
            if sensor_ids.iter().any(|s| t.key.starts_with(s.as_str())) {
                to_despawn.push(e);
            }
        }
        for e in to_despawn {
            world.despawn(e);
        }
        if let Some(render_app) = self.app.get_sub_app_mut(RenderApp) {
            if let Some(mut staging) = render_app.world_mut().get_resource_mut::<Staging>() {
                staging.0.retain(|b| {
                    !sensor_ids
                        .iter()
                        .any(|s| b.key.starts_with(format!("{s}:").as_str()))
                });
            }
        }
        self.next_camera_order = 0;
    }

    /// Update until all tiles are loaded, scenes spawned and instances built.
    /// Then builds the deterministic instance-ID pass. Returns the legend.
    pub fn wait_until_ready(&mut self) -> Result<Vec<LegendEntry>> {
        if self.ready {
            return Ok(self.app.world().resource::<Legend>().0.clone());
        }
        let deadline = Instant::now() + Duration::from_secs(300);
        loop {
            self.app.update();
            let world = self.app.world_mut();
            let pending_loads = {
                let mut q = world.query_filtered::<&TileLoad, Without<SceneSpawned>>();
                q.iter(world).count()
            };
            let pending_vegetation = {
                let mut q = world.query_filtered::<
                    &crate::veg::VegLoad,
                    (
                        Without<crate::veg::VegSceneSpawned>,
                        Without<crate::veg::VegFailed>,
                    ),
                >();
                q.iter(world).count()
            };
            let pending_instances = {
                let mut q = world.query_filtered::<
                    &crate::veg::VegRoot,
                    Without<crate::veg::VegInstantiated>,
                >();
                q.iter(world).count()
            };
            if pending_loads == 0 && pending_vegetation == 0 && pending_instances == 0 {
                // Collect instance entities under the query's mutable borrow,
                // then re-check readiness through plain world access.
                let roots: Vec<Entity> = {
                    let mut q = world.query::<(Entity, &WorldInstance)>();
                    q.iter(world).map(|(e, _)| e).collect()
                };
                if !roots.is_empty() && world.get_resource::<WorldInstanceSpawner>().is_some() {
                    let spawner = world.resource::<WorldInstanceSpawner>();
                    let all_ready =
                        roots.iter().all(|e| match world.get::<WorldInstance>(*e) {
                            Some(wi) => spawner.instance_is_ready(**wi),
                            None => false,
                        });
                    if all_ready {
                        break;
                    }
                }
            } else {
                // Drain any passes produced while loading so they cannot leak
                // into later captures.
                while self.receiver.try_recv().is_ok() {}
            }
            if Instant::now() > deadline {
                bail!("scene failed to become ready within 300 s");
            }
        }
        self.finalize_scene()?;
        self.ground = GroundField::build(&mut self.app, 2.0);
        self.ready = true;
        Ok(self.app.world().resource::<Legend>().0.clone())
    }

    fn finalize_scene(&mut self) -> Result<()> {
        let world = self.app.world_mut();

        // Deterministic instance-ID assignment: sort by mesh name then entity
        // bits (independent of ECS iteration order), then clone each mesh onto
        // render layer 1 under an unlit RGB24-encoded ID material.
        let mut entries: Vec<(String, u64, Entity, Handle<Mesh>, Option<Entity>, Transform)> =
            Vec::new();
        {
            let mut q = world.query::<(
                Entity,
                &Mesh3d,
                Option<&Name>,
                Option<&ChildOf>,
                Option<&Transform>,
            )>();
            for (e, mesh, name, child_of, transform) in q.iter(world) {
                entries.push((
                    name.map(|n| n.to_string())
                        .unwrap_or_else(|| format!("unnamed_mesh_{e}")),
                    e.to_bits(),
                    e,
                    mesh.0.clone(),
                    child_of.map(|c| c.parent()),
                    transform.copied().unwrap_or(Transform::IDENTITY),
                ));
            }
        }
        entries.sort_by(|a, b| a.0.cmp(&b.0).then(a.1.cmp(&b.1)));

        // Create all ID materials under one mutable borrow, then spawn the
        // clone entities once the assets borrow is released.
        let prepared: Vec<(
            u32,
            String,
            Entity,
            Handle<Mesh>,
            Handle<StandardMaterial>,
            Option<Entity>,
            Transform,
        )> = {
            let mut materials = world.resource_mut::<Assets<StandardMaterial>>();
            entries
                .into_iter()
                .enumerate()
                .map(|(i, (name, _, entity, mesh_h, parent, transform))| {
                    let id = (i + 1) as u32; // 0 reserved as background
                    let bytes = id.to_le_bytes();
                    let mat = materials.add(StandardMaterial {
                        base_color: Color::srgb_u8(bytes[0], bytes[1], bytes[2]),
                        unlit: true,
                        ..default()
                    });
                    (id, name, entity, mesh_h, mat, parent, transform)
                })
                .collect()
        };
        let mut legend = Vec::with_capacity(prepared.len());
        for (id, name, entity, mesh_h, mat, parent, transform) in prepared {
            world.entity_mut(entity).insert(InstanceId(id));
            let mut cmd = world.spawn((
                IdClone,
                Mesh3d(mesh_h),
                MeshMaterial3d(mat),
                RenderLayers::layer(1),
                transform,
            ));
            if let Some(p) = parent {
                cmd.insert(ChildOf(p));
            }
            legend.push(LegendEntry { id, name });
        }
        world.resource_mut::<Legend>().0 = legend;

        // One update so the newly spawned ID clones are extracted before the
        // first real render request.
        self.app.update();
        while self.receiver.try_recv().is_ok() {}
        Ok(())
    }

    /// Set the pose of a registered camera group (applies to RGB + ID cams).
    pub fn set_pose(&mut self, sensor_id: &str, eye: &[f32; 3], target: &[f32; 3]) -> Result<()> {
        let eye = Vec3::from_slice(eye);
        let target = Vec3::from_slice(target);
        let group = self
            .groups
            .iter()
            .find(|g| g.spec.sensor_id == sensor_id)
            .ok_or_else(|| anyhow::anyhow!("unknown sensor {sensor_id}"))?;
        let transform = Transform::from_translation(eye).looking_at(target, Vec3::Y);
        let world = self.app.world_mut();
        if let Some(mut t) = world.get_mut::<Transform>(group.rgb_entity) {
            *t = transform;
        }
        if let Some(id_entity) = group.id_entity {
            if let Some(mut t) = world.get_mut::<Transform>(id_entity) {
                *t = transform;
            }
        }
        Ok(())
    }

    /// Expected readback keys across all registered cameras.
    pub fn expected_keys(&self) -> Vec<String> {
        self.groups
            .iter()
            .flat_map(|g| g.spec.passes.keys(&g.spec.sensor_id))
            .collect()
    }

    /// Warmup iterations: lets shaders/pipelines compile so subsequent
    /// captures measure steady state. Discards all readbacks.
    pub fn warmup(&mut self, iterations: u32) {
        for _ in 0..iterations {
            self.app.update();
            while self.receiver.try_recv().is_ok() {}
        }
    }

    /// One full app iteration with blocking readback. Returns
    /// `"<sensor>:<pass>" -> raw row-padded bytes` for every expected key.
    pub fn render_once(&mut self) -> Result<HashMap<String, Vec<u8>>> {
        let expected = self.expected_keys();
        self.app.update();
        let mut passes = HashMap::new();
        while let Ok(p) = self.receiver.try_recv() {
            passes.insert(p.key, p.data);
        }
        let missing: Vec<String> =
            expected.iter().filter(|k| !passes.contains_key(*k)).cloned().collect();
        if !missing.is_empty() {
            bail!(
                "readback incomplete after update: got {:?}, missing {:?}",
                passes.keys().collect::<Vec<_>>(),
                missing
            );
        }
        Ok(passes)
    }

    pub fn is_ready(&self) -> bool {
        self.ready
    }
}

// ---------------------------------------------------------------------------
// Main-world systems
// ---------------------------------------------------------------------------

/// When a queued tile's GLTF resolves, spawn its default scene
/// (WorldAssetRoot) and mark it loaded.
fn spawn_loaded_tiles(
    mut commands: Commands,
    gltfs: Res<Assets<Gltf>>,
    loads: Query<(Entity, &TileLoad), Without<SceneSpawned>>,
) {
    for (e, tile) in &loads {
        let Some(gltf) = gltfs.get(&tile.0) else {
            continue;
        };
        let Some(scene) = gltf.default_scene.clone() else {
            panic!("GLB without default scene");
        };
        commands.entity(e).insert(SceneSpawned);
        commands.spawn((WorldAssetRoot(scene),));
    }
}

// ---------------------------------------------------------------------------
// Render-world systems (adapted verbatim from the spike)
// ---------------------------------------------------------------------------

/// Per-frame extraction of main-world readback targets.
#[derive(Resource, Default)]
struct ExtractedTargets(Vec<ReadbackTarget>);

fn extract_targets(
    targets: Extract<Query<&ReadbackTarget>>,
    mut out: ResMut<ExtractedTargets>,
) {
    let count = targets.iter().count();
    out.0 = targets.iter().cloned().collect();
    if std::env::var("NATIVE_DEBUG").is_ok() {
        eprintln!("extract_targets: {count}");
    }
}

/// Ensure a staging buffer exists for every registered readback target.
fn sync_staging(
    targets: Res<ExtractedTargets>,
    device: Res<RenderDevice>,
    gpu_images: Res<RenderAssets<GpuImage>>,
    mut staging: ResMut<Staging>,
) {
    for target in targets.0.iter() {
        if staging.0.iter().any(|b| b.src_image == target.src_image && b.depth == target.depth) {
            continue;
        }
        // Resolve dimensions from the GPU image (depth views share extents).
        let Some(gpu) = gpu_images.get(&target.src_image) else { continue };
        let width = gpu.texture_descriptor.size.width as usize;
        let height = gpu.texture_descriptor.size.height;
        let pixel: usize = if target.depth {
            4
        } else {
            gpu.texture_descriptor.format.block_copy_size(None).unwrap_or(4) as usize
        };
        let padded_row = aligned_row(width, pixel);
        if std::env::var("NATIVE_DEBUG").is_ok() {
            eprintln!("sync_staging: push {}", target.key);
        }
        staging.0.push(StagingBuffer {
            key: target.key.clone(),
            src_image: target.src_image.clone(),
            depth: target.depth,
            padded_row,
            height,
            buffer: make_buffer(&device, padded_row * height as usize),
        });
    }
}

fn copy_passes(
    ctx: RenderContext,
    queue: Res<RenderQueue>,
    staging: Res<Staging>,
    gpu_images: Res<RenderAssets<GpuImage>>,
    depth_views: Query<(Entity, &ExtractedCamera, &ViewDepthTexture)>,
) {
    if staging.0.is_empty() {
        return;
    }
    let mut encoder = ctx
        .render_device()
        .create_command_encoder(&CommandEncoderDescriptor::default());

    for b in staging.0.iter() {
        if b.depth {
            // Find the 3D view rendering to this readback's source image.
            let Some((_, _, view)) = depth_views.iter().find(|(_, cam, _)| {
                matches!(
                    cam.target,
                    Some(bevy::camera::NormalizedRenderTarget::Image(ref irt))
                        if irt.handle.id() == b.src_image.id()
                )
            }) else {
                continue;
            };
            let tex = &view.texture;
            encoder.copy_texture_to_buffer(
                tex.as_image_copy(),
                TexelCopyBufferInfo {
                    buffer: &b.buffer,
                    layout: TexelCopyBufferLayout {
                        offset: 0,
                        bytes_per_row: Some(
                            std::num::NonZero::<u32>::new(b.padded_row as u32).unwrap().into(),
                        ),
                        rows_per_image: None,
                    },
                },
                tex.size(),
            );
        } else {
            let Some(src) = gpu_images.get(&b.src_image) else {
                continue;
            };
            encoder.copy_texture_to_buffer(
                src.texture.as_image_copy(),
                TexelCopyBufferInfo {
                    buffer: &b.buffer,
                    layout: TexelCopyBufferLayout {
                        offset: 0,
                        bytes_per_row: Some(
                            std::num::NonZero::<u32>::new(b.padded_row as u32).unwrap().into(),
                        ),
                        rows_per_image: None,
                    },
                },
                src.texture_descriptor.size,
            );
        }
    }

    queue.submit(std::iter::once(encoder.finish()));
}

fn receive_passes(
    device: Res<RenderDevice>,
    sender: Res<RenderSender>,
    staging: Res<Staging>,
) {
    if staging.0.is_empty() {
        return;
    }

    let (s, r) = crossbeam_channel::bounded::<()>(staging.0.len());
    for b in &staging.0 {
        let tx = s.clone();
        b.buffer
            .slice(..)
            .map_async(MapMode::Read, move |res| {
                if res.is_err() {
                    panic!("map buffer failed");
                }
                let _ = tx.send(());
            });
    }
    device
        .poll(PollType::wait_indefinitely())
        .expect("poll device");
    for _ in &staging.0 {
        r.recv().expect("map_async result");
    }

    for b in &staging.0 {
        let data = b.buffer.slice(..).get_mapped_range().to_vec();
        let _ = sender.send(SentPass { key: b.key.clone(), data });
        b.buffer.unmap();
    }
}

fn b_key(b: &StagingBuffer) -> String {
    format!("{}:{}", if b.depth { "d" } else { "i" }, b.src_image.id())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[ignore = "focused GPU integration test"]
    fn service_actor_catalog_models_instantiate_mesh_nodes() {
        let repo = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        let vehicle = repo.join(
            "catalog/vehicles-carla/models/vehicle_sedan_lincoln_mkz_2020.glb",
        );
        let pedestrian =
            repo.join("catalog/pedestrians-carla/models/pedestrian_0015.glb");
        assert!(vehicle.is_file() && pedestrian.is_file());

        let mut app = SceneApp::new(&Lighting::default()).unwrap();
        app.load_tiles(&[vehicle.to_string_lossy().into_owned()])
            .unwrap();
        app.wait_until_ready().unwrap();

        app.upsert_actor(
            "vehicle-test",
            "car",
            [0.0, 0.0, 0.0],
            0.0,
            [4.5, 1.6, 1.8],
            [0.5, 0.5, 0.5],
            false,
        );
        app.attach_actor_model("vehicle-test", &vehicle, 1.0, Some([0.56, 0.18, 0.18]))
            .unwrap();
        app.upsert_actor(
            "walker-test",
            "pedestrian",
            [8.0, 0.0, 0.0],
            0.0,
            [0.5, 1.8, 0.5],
            [0.5, 0.5, 0.5],
            false,
        );
        app.attach_actor_model("walker-test", &pedestrian, 1.0, None)
            .unwrap();

        assert!(app.actor_model_mesh_count("vehicle-test") > 1);
        assert!(app.actor_model_mesh_count("walker-test") > 1);
        assert_eq!(
            app.actor_model_tint_colors("vehicle-test"),
            vec![[0.56, 0.18, 0.18, 1.0]]
        );
        assert!(app.actor_model_tint_colors("walker-test").is_empty());
        // Bevy's async asset tasks can still hold the test-only wgpu device
        // when the process tears down; the production service intentionally
        // lives for the process lifetime.
        std::mem::forget(app);
    }
}
