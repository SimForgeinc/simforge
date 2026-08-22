//! Reusable headless Bevy rendering engine for UniScenarios (`native` engine).
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
use anyhow::{bail, Result};
use bevy::app::ScheduleRunnerPlugin;
use bevy::camera::visibility::RenderLayers;
use bevy::camera::RenderTarget;
use bevy::core_pipeline::tonemapping::Tonemapping;
use bevy::gltf::Gltf;
use bevy::light::cascade::CascadeShadowConfigBuilder;
use bevy::light::{DirectionalLight, DirectionalLightShadowMap, GlobalAmbientLight};
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
    fn tonemapping(self) -> Tonemapping {
        match self {
            Profile::Sensor => Tonemapping::None,
            Profile::Cinematic => Tonemapping::AgX,
        }
    }
}

/// Sun + ambient lighting configuration (spike-calibrated yale-street values).
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
pub struct Lighting {
    #[serde(default = "default_sun_elev")]
    pub sun_elev_deg: f32,
    #[serde(default = "default_sun_azim")]
    pub sun_azim_deg: f32,
    #[serde(default = "default_lux")]
    pub sun_lux: f32,
    #[serde(default = "default_ambient")]
    pub ambient: f32,
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

impl Default for Lighting {
    fn default() -> Self {
        Self {
            sun_elev_deg: default_sun_elev(),
            sun_azim_deg: default_sun_azim(),
            sun_lux: default_lux(),
            ambient: default_ambient(),
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

/// One legend entry: instance-ID value -> source mesh name.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct LegendEntry {
    pub id: u32,
    pub name: String,
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
pub struct SceneApp {
    app: App,
    receiver: crossbeam_channel::Receiver<SentPass>,
    groups: Vec<GroupEntities>,
    next_camera_order: isize,
    ready: bool,
}

impl SceneApp {
    /// Build the headless app with lights and render-world plumbing.
    pub fn new(lighting: &Lighting) -> Self {
        std::env::set_var("BEVY_ASSET_ROOT", "/");
        let (tx, rx) = crossbeam_channel::unbounded::<SentPass>();
        let mut app = App::new();
        app.insert_resource(ClearColor(Color::srgb(0.53, 0.74, 0.92)))
            .insert_resource(GlobalAmbientLight {
                color: Color::srgb(1.0, 0.98, 0.94),
                brightness: lighting.ambient,
                affects_lightmapped_meshes: true,
            })
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
            ))
            .add_systems(Update, spawn_loaded_tiles)
            .insert_resource(MainReceiver(rx.clone()));
        // placeholder

        app.world_mut().spawn((
            DirectionalLight {
                illuminance: lighting.sun_lux,
                shadow_maps_enabled: true,
                ..default()
            },
            CascadeShadowConfigBuilder {
                minimum_distance: 1.0,
                maximum_distance: 400.0,
                num_cascades: 4,
                ..default()
            }
            .build(),
            Transform::IDENTITY.looking_to(
                sun_direction(lighting.sun_elev_deg, lighting.sun_azim_deg),
                Vec3::Y,
            ),
        ));

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
        Self { app, receiver: rx, groups: Vec::new(), next_camera_order: 0, ready: false }
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

    /// Register a camera group (RGB target + optional ID camera + depth copy).
    pub fn add_camera(&mut self, spec: CameraSpec, profile: Profile) {
        assert!(!self.ready, "cameras must be added before rendering starts");

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
            profile.tonemapping(),
            Camera { order: self.next_camera_order, ..default() },
            Transform::IDENTITY,
            RenderTarget::Image(rgb_image.into()),
        ));
        let rgb_entity = e.id();
        self.next_camera_order += 10;

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
    }

    /// Registered camera specs (diagnostics).
    pub fn cameras(&self) -> impl Iterator<Item = &CameraSpec> {
        self.groups.iter().map(|g| &g.spec)
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
            if pending_loads == 0 {
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
        self.ready = true;
        Ok(self.app.world().resource::<Legend>().0.clone())
    }

    fn finalize_scene(&mut self) -> Result<()> {
        let world = self.app.world_mut();

        // Deterministic instance-ID assignment: sort by mesh name then entity
        // bits (independent of ECS iteration order), then clone each mesh onto
        // render layer 1 under an unlit RGB24-encoded ID material.
        let mut entries: Vec<(String, u64, Handle<Mesh>, Option<Entity>, Transform)> = Vec::new();
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
                    mesh.0.clone(),
                    child_of.map(|c| c.parent()),
                    transform.copied().unwrap_or(Transform::IDENTITY),
                ));
            }
        }
        entries.sort_by(|a, b| a.0.cmp(&b.0).then(a.1.cmp(&b.1)));

        // Create all ID materials under one mutable borrow, then spawn the
        // clone entities once the assets borrow is released.
        let prepared: Vec<(u32, String, Handle<Mesh>, Handle<StandardMaterial>, Option<Entity>, Transform)> = {
            let mut materials = world.resource_mut::<Assets<StandardMaterial>>();
            entries
                .into_iter()
                .enumerate()
                .map(|(i, (name, _, mesh_h, parent, transform))| {
                    let id = (i + 1) as u32; // 0 reserved as background
                    let bytes = id.to_le_bytes();
                    let mat = materials.add(StandardMaterial {
                        base_color: Color::srgb_u8(bytes[0], bytes[1], bytes[2]),
                        unlit: true,
                        ..default()
                    });
                    (id, name, mesh_h, mat, parent, transform)
                })
                .collect()
        };
        let mut legend = Vec::with_capacity(prepared.len());
        for (id, name, mesh_h, mat, parent, transform) in prepared {
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
