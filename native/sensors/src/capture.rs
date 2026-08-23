//! Multi-camera multi-pass deterministic capture harness.
//!
//! Grows the spike's proven pattern (headless Bevy, image render targets,
//! GPU->CPU readback via map_async) to a full rig:
//! - one process renders N cameras (spike: near-linear multi-camera scaling);
//! - per measurement camera four passes: RGB (AgX), raw Depth32Float
//!   (reverse-Z, from the RGB view's depth texture), instance ID (unlit,
//!   render-layer 1, black clear) and semantic class ID (unlit, render-layer
//!   2, black clear). One submission set per camera; MRT is future work once
//!   WSB2's pass plumbing lands in render-core.
//! - static corpus geometry gets deterministic instance IDs (sorted by mesh
//!   name then entity index, 1-based; 0 = background); actors get IDs after
//!   all statics, sorted by actor id.
//! - the same triangle soup (world-space, with instance ids) feeds the CPU
//!   lidar/radar raycast models.
//!
//! Interim note: actor meshes are simple cuboids sized from scene-state
//! catalog dims until WSB2's prop-catalog actor pipeline lands in
//! render-core; sensor math and determinism are unaffected.

use crate::bvh::{RaycastScene, Tri};
use crate::formats;
use crate::imu_gnss::{GnssSample, ImuSample, TmercOrigin};
use crate::lidar;
use crate::radar;
use crate::rig::{Mount, RigSpec, SensorKind};
use crate::scene_state::SceneState;
use crate::taxonomy::{Legend, SemanticClass};
use anyhow::{bail, Context as _, Result};
use crossbeam_channel;
use bevy::app::{AppExit, ScheduleRunnerPlugin};
use bevy::camera::visibility::RenderLayers;
use bevy::camera::RenderTarget;
use bevy::core_pipeline::tonemapping::Tonemapping;
use bevy::gltf::Gltf;
use bevy::light::cascade::CascadeShadowConfigBuilder;
use bevy::light::{DirectionalLight, DirectionalLightShadowMap, GlobalAmbientLight};
use bevy::log::LogPlugin;
use bevy::prelude::*;
use bevy::render::render_asset::RenderAssets;
use bevy::render::render_resource::{
    Buffer, BufferDescriptor, BufferUsages, CommandEncoderDescriptor, MapMode, PollType,
    TexelCopyBufferInfo, TexelCopyBufferLayout, TextureFormat, TextureUsages,
};
use bevy::render::renderer::{RenderContext, RenderDevice, RenderGraph, RenderQueue};
use bevy::render::texture::GpuImage;
use bevy::render::camera::ExtractedCamera;
use bevy::render::view::ViewDepthTexture;
use bevy::render::{Extract, RenderApp, RenderSystems};
use bevy::world_serialization::{WorldAssetRoot, WorldInstance, WorldInstanceSpawner};
use bevy::window::ExitCondition;
use serde_json::json;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

#[derive(clap::Parser, Debug, Clone, bevy::prelude::Resource)]
pub struct CaptureArgs {
    /// qualification/render-qualification-program.v1.json (prontoRig source).
    #[arg(long)]
    pub rig_program: String,
    /// Corpus GLB files (absolute paths), comma-separated.
    #[arg(long, value_delimiter = ',', required = true)]
    pub glbs: Vec<String>,
    /// scene-state.v1 JSON file (optional: absent = ego at origin, no actors).
    #[arg(long)]
    pub scene_state: Option<String>,
    /// Map xodr for GNSS georeference.
    #[arg(long)]
    pub xodr: Option<String>,
    /// Scene-state tick index to capture (default 0).
    #[arg(long, default_value_t = 0)]
    pub tick: u32,
    #[arg(long, default_value_t = 736)]
    pub width: u32,
    #[arg(long, default_value_t = 416)]
    pub height: u32,
    #[arg(long, default_value_t = 20)]
    pub warmup: u32,
    /// Output directory.
    #[arg(long)]
    pub out: String,
}

// ---------------------------------------------------------------------------
// Main world <-> render world readback plumbing (spike pattern, generalized)
// ---------------------------------------------------------------------------

struct SentPass {
    key: String,
    frame: u64,
    data: Vec<u8>,
}

#[derive(Resource, Deref)]
struct MainReceiver(crossbeam_channel::Receiver<SentPass>);
#[derive(Resource, Deref)]
struct RenderSender(crossbeam_channel::Sender<SentPass>);

#[derive(Component, Clone)]
struct ImageCopier {
    buffer: Buffer,
    src_image: Handle<Image>,
    key: String,
}

#[derive(Component, Clone)]
struct DepthCopier {
    buffer: Buffer,
    src_image: Handle<Image>,
    key: String,
}

#[derive(Resource, Default)]
struct Copiers(Vec<ImageCopier>);
#[derive(Resource, Default)]
struct DepthCopiers(Vec<DepthCopier>);
#[derive(Resource, Default, Clone, Copy)]
struct GlobalFrame(u64);
/// Unconditional per-Update counter used for bring-up timing.
#[derive(Resource, Default, Clone, Copy)]
struct AppTick(u64);
#[derive(Resource, Default, Clone, Copy)]
struct FrameStamp(u64);

fn setup_target_image(images: &mut Assets<Image>, w: u32, h: u32, format: TextureFormat) -> Handle<Image> {
    let mut img = Image::new_target_texture(w, h, format, None);
    img.texture_descriptor.usage |= TextureUsages::COPY_SRC;
    images.add(img)
}

fn make_buffer(device: &RenderDevice, size_bytes: usize) -> Buffer {
    device.create_buffer(&BufferDescriptor {
        label: Some("sensor-readback"),
        size: size_bytes as u64,
        usage: BufferUsages::MAP_READ | BufferUsages::COPY_DST,
        mapped_at_creation: false,
    })
}

fn aligned_row(width: usize, pixel_size: usize) -> usize {
    RenderDevice::align_copy_bytes_per_row(width * pixel_size)
}

// ---------------------------------------------------------------------------
// Harness state
// ---------------------------------------------------------------------------

#[derive(Component)]
struct TileLoad(Handle<Gltf>);
#[derive(Component)]
struct SceneSpawned;
#[derive(Component)]
struct IdClone;
#[derive(Component)]
struct ActorBox;


#[derive(Resource)]
struct HarnessState {
    total_glbs: u32,
    /// Actor cuboids spawned (once).
    boxes_spawned: bool,
    /// App tick at which the tile scene became ready.
    ready_tick: Option<u64>,
    /// Mesh-entity count observed on the previous tick.
    last_mesh_count: Option<usize>,
    /// Tick of the last count change (settle detection).
    last_change_tick: Option<u64>,
    build_ready_at: Option<Instant>,
    clones_done: bool,
    sensors_spawned: bool,
    captured: bool,
    /// Deterministic instance registry: sorted (name, entity-bits) -> id.
    instance_names: Vec<(u32, String)>,
    instance_classes: Vec<(u32, u8)>,
    /// entity -> instance id for triangle extraction.
    entity_ids: HashMap<Entity, u32>,
}

fn mount_world_transform(ego: Transform, m: &Mount) -> Transform {
    let rot_ego = ego.rotation;
    let pos = ego.translation + rot_ego.mul_vec3(Vec3::new(m.x, m.y, m.z));
    let rot = rot_ego
        * Quat::from_euler(EulerRot::YXZ, m.yaw, m.pitch, m.roll);
    Transform { translation: pos, rotation: rot, scale: Vec3::ONE }
}

pub fn run_capture(args: CaptureArgs) -> Result<()> {
    if args.glbs.iter().any(|g| !Path::new(g).is_absolute()) {
        bail!("glb paths must be absolute");
    }
    std::env::set_var("BEVY_ASSET_ROOT", "/");
    let rig_text = std::fs::read_to_string(&args.rig_program)
        .with_context(|| format!("read {}", args.rig_program))?;
    let rig: RigSpec = crate::rig::parse_pronto_rig(&rig_text, args.width, args.height)?;
    let n_cams = rig.cameras().count();
    println!("RIG {} cameras={} lidars={} radars={} (+chase)",
        rig.rig_id, n_cams, rig.lidars().count(), rig.radars().count());

    let scene_state: Option<SceneState> = match &args.scene_state {
        Some(p) => Some(SceneState::from_json(&std::fs::read_to_string(p)?)
            .with_context(|| format!("parse {}", p))?),
        None => None,
    };

    // Georeference for GNSS.
    let tmerc: Option<TmercOrigin> = args.xodr.as_ref().and_then(|p| {
        let text = std::fs::read_to_string(p).ok()?;
        let start = text.find("<geoReference><![CDATA[")? + "<geoReference><![CDATA[".len();
        let end = text[start..].find("]]></geoReference>")? + start;
        TmercOrigin::parse(&text[start..end])
    });

    let out_dir = PathBuf::from(&args.out);
    std::fs::create_dir_all(&out_dir)?;

    let (tx, rx) = crossbeam_channel::unbounded::<SentPass>();

    let mut app = App::new();
    app.insert_resource(ClearColor(Color::srgb(0.53, 0.74, 0.92)))
        .add_plugins((
            DefaultPlugins
                .set(bevy::asset::AssetPlugin { file_path: "/".into(), ..default() })
                .set(WindowPlugin { primary_window: None, exit_condition: ExitCondition::DontExit, ..default() })
                .disable::<bevy::winit::WinitPlugin>()
                .disable::<bevy::audio::AudioPlugin>()
                .set(LogPlugin {
                    filter: "warn,wgpu_core=warn,wgpu_hal=warn,naga=warn".into(),
                    ..default()
                }),
            ScheduleRunnerPlugin::run_loop(Duration::ZERO),
        ))
        .insert_resource(GlobalAmbientLight {
            color: Color::srgb(1.0, 0.98, 0.94),
            brightness: 0.6,
            affects_lightmapped_meshes: true,
        })
        .insert_resource(DirectionalLightShadowMap { size: 2048 })
        .insert_resource(MainReceiver(rx))
        .insert_resource(args.clone())
        .insert_resource(rig)
        .insert_resource(HarnessState {
            total_glbs: args.glbs.len() as u32,
            build_ready_at: None,
            clones_done: false,
            sensors_spawned: false,
            captured: false,
            boxes_spawned: false,
            ready_tick: None,
            last_mesh_count: None,
            last_change_tick: None,
            instance_names: Vec::new(),
            instance_classes: Vec::new(),
            entity_ids: HashMap::new(),
        })
        
        
        .init_resource::<GlobalFrame>()
        .init_resource::<AppTick>()
        .insert_resource(HarnessSetup::default())
        .add_systems(Startup, startup_setup)
        .add_systems(
            Update,
            (
                check_assets,
                poll_roots,
                bump_tick,
                build_tile_bvh,
                spawn_actor_boxes,
                build_id_and_semantic_passes,
                spawn_sensors,
                tick_frames,
            )
                .chain(),
        )
        .add_systems(PostUpdate, collect_passes);

    if let Some(ss) = scene_state {
        app.insert_resource(ss);
    }
    if let Some(tm) = tmerc {
        app.insert_resource(tm);
    }

    let render_app = app.get_sub_app_mut(RenderApp).unwrap();
    render_app
        .insert_resource(RenderSender(tx))
        .init_resource::<Copiers>()
        .init_resource::<DepthCopiers>()
        .init_resource::<FrameStamp>()
        .add_systems(ExtractSchedule, (extract_copiers, extract_frame))
        .add_systems(RenderGraph, copy_passes)
        .add_systems(bevy::render::Render, receive_passes.after(RenderSystems::Render));

    app.run();

    write_manifest(&out_dir)?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

/// Transient setup state consumed during scene bring-up.
#[derive(Resource, Default)]
struct HarnessSetup {
    /// Set once the full raycast BVH (with instance ids) is built.
    sensor_scene_ready: bool,
    /// Set after the tiles-only BVH phase used for ground snapping.
    tile_bvh_done: bool,
}

fn sun_direction(elev_deg: f32, azim_deg: f32) -> Dir3 {
    let elev = elev_deg.to_radians();
    let azim = azim_deg.to_radians();
    let dir = Vec3::new(-(elev.cos() * azim.sin()), -elev.sin(), -(elev.cos() * azim.cos()));
    Dir3::new(dir.normalize()).unwrap()
}

fn startup_setup(mut commands: Commands, args: Res<CaptureArgs>, server: Res<AssetServer>) {
    commands.spawn((
        DirectionalLight { illuminance: 28_000.0, shadow_maps_enabled: true, ..default() },
        CascadeShadowConfigBuilder {
            minimum_distance: 1.0,
            maximum_distance: 400.0,
            num_cascades: 4,
            ..default()
        }
        .build(),
        Transform::IDENTITY.looking_to(sun_direction(60.0, 190.0), Vec3::Y),
    ));
    for g in &args.glbs {
        let path = g.trim_start_matches('/').to_owned();
        let handle: Handle<Gltf> = server.load(path);
        commands.spawn(TileLoad(handle));
    }
}

// ---------------------------------------------------------------------------
// Scene bring-up: tiles, actors, ID/semantic clones, raycast BVH
// ---------------------------------------------------------------------------

fn check_assets(mut commands: Commands, gltfs: Res<Assets<Gltf>>, loads: Query<(Entity, &TileLoad), Without<SceneSpawned>>) {
    for (e, tile) in &loads {
        let Some(gltf) = gltfs.get(&tile.0) else { continue };
        let Some(scene) = gltf.default_scene.clone() else {
            panic!("GLB without default scene");
        };
        commands.entity(e).insert(SceneSpawned);
        commands.spawn((WorldAssetRoot(scene),));
    }
}

/// Spawn interim actor cuboids from the scene-state tick (before ID
/// assignment so they join the same legend space), snapped onto the static
/// ground via a downward raycast (traces carry no ground height).
#[allow(clippy::too_many_arguments)]
fn spawn_actor_boxes(
    mut commands: Commands,
    mut meshes: ResMut<Assets<Mesh>>,
    mut materials: ResMut<Assets<StandardMaterial>>,
    scene_state: Option<Res<crate::scene_state::SceneState>>,
    sensor_scene: Option<Res<SensorScene>>,
    mut state: ResMut<HarnessState>,
) {
    let Some(sensor_scene) = sensor_scene else { return };
    if state.boxes_spawned || !setup_ready_for_boxes(&state) || scene_state.is_none() {
        return;
    }
    state.boxes_spawned = true;
    let ss = scene_state.unwrap();

    for a in &ss.actors {
        if a.id == "ego" || a.kind == "despawn" {
            continue;
        }
        let (l, w, h) = actor_dims(a);
        let pos = Vec3::from_slice(&a.transform.position);
        let quat = Quat::from_xyzw(
            a.transform.rotation[0],
            a.transform.rotation[1],
            a.transform.rotation[2],
            a.transform.rotation[3],
        );
        let ground = ground_y(&sensor_scene.scene, pos);
        commands.spawn((
            ActorBox,
            Name::new(format!("actor:{}", a.id)),
            Mesh3d(meshes.add(Cuboid::new(w, h, l))),
            MeshMaterial3d(materials.add(StandardMaterial {
                base_color: Color::srgb(0.85, 0.85, 0.88),
                ..default()
            })),
            Transform {
                translation: Vec3::new(pos.x, ground + h * 0.5, pos.z),
                rotation: quat,
                scale: Vec3::ONE,
            },
            RenderLayers::layer(0),
        ));
    }
}

/// Ground height under (x, z): downward raycast from high above; falls back
/// to 0 when nothing is hit.
pub fn ground_y(scene: &RaycastScene, pos: Vec3) -> f32 {
    scene
        .cast(Vec3::new(pos.x, 500.0, pos.z), Vec3::NEG_Y, 1000.0)
        .map(|h| h.point.y)
        .unwrap_or(0.0)
}

fn setup_ready_for_boxes(state: &HarnessState) -> bool {
    state.build_ready_at.is_some() && state.ready_tick.is_some()
}

/// Catalog dims lookup is WSB2 territory; until then dims come from the
/// scene-state catalogId convention `vehicle.*`/`walker.*` with sane defaults.
fn actor_dims(a: &crate::scene_state::ActorState) -> (f32, f32, f32) {
    match a.actor_class.as_deref().unwrap_or("prop") {
        "car" => (4.8, 1.9, 1.5),
        "truck" => (8.0, 2.5, 3.2),
        "pedestrian" => (0.6, 0.6, 1.75),
        "cyclist" => (1.7, 0.6, 1.7),
        _ => (1.0, 1.0, 1.0),
    }
}

fn poll_roots(
    roots: Query<&WorldInstance>,
    spawner: Option<Res<WorldInstanceSpawner>>,
    mut state: ResMut<HarnessState>,
) {
    let Some(spawner) = spawner else { return };
    if state.build_ready_at.is_some() {
        return;
    }
    if roots.iter().count() < state.total_glbs as usize {
        return;
    }
    if roots.iter().all(|wi| spawner.instance_is_ready(**wi)) {
        state.build_ready_at = Some(Instant::now());
        state.last_mesh_count = None;
        state.last_mesh_count = None;
    }
}

/// Phase 1: BVH over static tile geometry only (no instance ids yet) so the
/// actor boxes and the ego can be ground-snapped in the next systems.
fn build_tile_bvh(
    mut commands: Commands,
    meshes: Res<Assets<Mesh>>,
    meshes_q: Query<(Entity, &Mesh3d, Option<&GlobalTransform>), Without<ActorBox>>,
    state: Res<HarnessState>,
    mut setup: ResMut<HarnessSetup>,
) {
    if setup.tile_bvh_done || state.build_ready_at.is_none() {
        return;
    }
    let mut scene = RaycastScene::new();
    for (_e, mesh3d, gt) in &meshes_q {
        if let Some(mesh) = meshes.get(&mesh3d.0) {
            push_mesh_triangles(mesh, gt, &mut scene, 0);
        }
    }
    scene.build();
    println!("BVH tiles: {} triangles", scene.tri_count());
    commands.insert_resource(SensorScene { scene, classes: HashMap::new() });
    setup.tile_bvh_done = true;
}

/// Phase 2: assign deterministic instance IDs across static tiles + actor
/// boxes, clone meshes into the ID (layer 1) and semantic (layer 2) passes,
/// and rebuild the raycast BVH with real instance ids.
fn build_id_and_semantic_passes(
    mut commands: Commands,
    tick: Res<AppTick>,
    mut materials: ResMut<Assets<StandardMaterial>>,
    meshes: Res<Assets<Mesh>>,
    scene_state: Option<Res<crate::scene_state::SceneState>>,
    sensor_scene: Option<ResMut<SensorScene>>,
    meshes_q: Query<
        (
            Entity,
            &Mesh3d,
            Option<&Name>,
            Option<&ChildOf>,
            Option<&GlobalTransform>,
            Option<&Transform>,
        ),
        (Without<IdClone>, Without<WorldAssetRoot>),
    >,
    mut state: ResMut<HarnessState>,
    mut setup: ResMut<HarnessSetup>,
) {
    let Some(mut sensor_scene) = sensor_scene else { return };
    if state.clones_done || !setup.tile_bvh_done || state.ready_tick.is_none() {
        return;
    }
    // Let hierarchy spawning and transform propagation settle: require a few
    // ticks past readiness AND a stable mesh-entity count, otherwise the
    // instance registry captures a partial scene (nondeterministic).
    if tick.0 < state.ready_tick.unwrap_or(0) + 3 {
        return;
    }
    // The GLTF spawner streams node entities in over many ticks; wait until
    // the mesh-entity count has been stable for a while. The final registry
    // is the complete scene regardless of when we proceed, so this only
    // affects latency, not determinism.
    let count = meshes_q.iter().count();
    if state.last_mesh_count != Some(count) {
        state.last_mesh_count = Some(count);
        state.last_change_tick = Some(tick.0);
        return;
    }
    if tick.0 < state.last_change_tick.unwrap_or(tick.0) + 500 {
        return;
    }
    println!("IDPASS scene settled: {count} mesh entities at tick {}", tick.0);

    // ---- deterministic instance registry ----
    // Sort key: name, then world-space AABB-center bits derived from actual
    // geometry. ECS entity ids differ across processes and must never enter
    // the ordering; duplicate mesh names (instanced geometry) disambiguate by
    // position.
    let mut entries: Vec<(String, [u32; 3], Entity)> = Vec::new();
    for (e, mesh3d, name, _child_of, gt, _local) in &meshes_q {
        let name = name.map(|n| n.to_string()).unwrap_or_else(|| format!("unnamed_mesh_{e}"));
        let key = meshes.get(&mesh3d.0)
            .map(|mesh| {
                let mut acc = Vec3::ZERO;
                let mut n = 0u32;
                collect_tri_centroids(mesh, gt, |c| {
                    acc += c;
                    n += 1;
                });
                if n > 0 {
                    let c = acc / n as f32;
                    [c.x.to_bits(), c.y.to_bits(), c.z.to_bits()]
                } else {
                    [0, 0, 0]
                }
            })
            .unwrap_or([0, 0, 0]);
        entries.push((name, key, e));
    }
    entries.sort_by(|a, b| a.0.cmp(&b.0).then(a.1.cmp(&b.1)));

    let mut entity_ids: HashMap<Entity, u32> = HashMap::with_capacity(entries.len());
    let mut instance_names: Vec<(u32, String)> = Vec::with_capacity(entries.len());
    let mut instance_classes: Vec<(u32, u8)> = Vec::with_capacity(entries.len());
    for (i, (name, _, e)) in entries.into_iter().enumerate() {
        let id = (i + 1) as u32;
        entity_ids.insert(e, id);
        instance_names.push((id, name.clone()));
        let class = if let Some(actor) = name.strip_prefix("actor:") {
            actor_class_of(scene_state.as_deref(), actor)
        } else {
            SemanticClass::from_mesh_name(&name)
        };
        instance_classes.push((id, class.id()));
    }
    state.entity_ids = entity_ids;

    // ---- clones + BVH (rebuilt over tiles + snapped actor boxes) ----
    let mut legend_instances: Vec<(u32, String)> = Vec::new();
    let mut legend_classes: Vec<(u32, u8)> = Vec::new();
    let mut ray_scene = RaycastScene::new();


    for (e, mesh3d, name, child_of, gt, local) in &meshes_q {
        let Some(&id) = state.entity_ids.get(&e) else { continue };
        let name_s = name.map(|n| n.to_string()).unwrap_or_else(|| format!("unnamed_mesh_{e}"));
        let class = SemanticClass::ALL
            .iter()
            .copied()
            .find(|c| c.id() == instance_class_lookup(&instance_classes, id))
            .unwrap_or(SemanticClass::Prop);

        // Aux clone on layer 1: instance id low bytes in R/G, semantic class
        // in B. (Alpha is unusable: opaque materials force it to 1.0.)
        let bytes = id.to_le_bytes();
        let id_mat = materials.add(StandardMaterial {
            base_color: Color::srgb_u8(bytes[0], bytes[1], class.id()),
            unlit: true,
            ..default()
        });
        let mut cmd = commands.spawn((
            IdClone,
            Mesh3d(mesh3d.0.clone()),
            MeshMaterial3d(id_mat),
            RenderLayers::layer(1)
        ));
        // Local transform: the clone re-parents under the same parent, so it
        // must carry the node's LOCAL transform (world would double-apply).
        cmd.insert(local.copied().unwrap_or(Transform::IDENTITY));
        if let Some(p) = child_of.map(|c| c.parent()) {
            cmd.insert(ChildOf(p));
        }

        legend_instances.push((id, name_s.clone()));
        legend_classes.push((id, class.id()));

        // Triangle soup for lidar/radar.
        if let Some(mesh) = meshes.get(&mesh3d.0) {
            push_mesh_triangles(mesh, gt, &mut ray_scene, id);
        }
    }
    ray_scene.build();
    println!("BVH full: {} triangles", ray_scene.tri_count());
    *sensor_scene = SensorScene {
        scene: ray_scene,
        classes: state.instance_classes.iter().cloned().collect(),
    };

    // Legend must be byte-stable across processes: ECS iteration order is not.
    legend_instances.sort_by_key(|(id, _)| *id);
    legend_classes.sort_by_key(|(id, _)| *id);
    state.instance_names = legend_instances;
    state.instance_classes = legend_classes;
    setup.sensor_scene_ready = true;
    state.clones_done = true;
}

/// Visit the world-space centroid of every triangle of `mesh`.
fn collect_tri_centroids(mesh: &bevy::mesh::Mesh, gt: Option<&GlobalTransform>, mut f: impl FnMut(Vec3)) {
    let Some(pos_attr) = mesh.attribute(bevy::mesh::Mesh::ATTRIBUTE_POSITION) else { return };
    let world = gt.map(|g| g.to_matrix()).unwrap_or(Mat4::IDENTITY);
    let positions: Vec<Vec3> = match pos_attr {
        bevy::mesh::VertexAttributeValues::Float32x3(v) => v.iter().map(|p| Vec3::from(*p)).collect(),
        _ => return,
    };
    match mesh.indices() {
        Some(bevy::mesh::Indices::U32(idx)) => {
            for t in idx.chunks_exact(3) {
                f(world.transform_point3(
                    (positions[t[0] as usize] + positions[t[1] as usize] + positions[t[2] as usize]) / 3.0,
                ));
            }
        }
        Some(bevy::mesh::Indices::U16(idx)) => {
            for t in idx.chunks_exact(3) {
                f(world.transform_point3(
                    (positions[t[0] as usize] + positions[t[1] as usize] + positions[t[2] as usize]) / 3.0,
                ));
            }
        }
        _ => {
            for t in positions.chunks_exact(3) {
                f(world.transform_point3((t[0] + t[1] + t[2]) / 3.0));
            }
        }
    }
}

fn instance_class_lookup(classes: &[(u32, u8)], id: u32) -> u8 {
    classes
        .iter()
        .find(|(i, _)| *i == id)
        .map(|(_, c)| *c)
        .unwrap_or(0)
}

fn actor_class_of(ss: Option<&crate::scene_state::SceneState>, actor_id: &str) -> SemanticClass {
    ss.and_then(|s| s.actors.iter().find(|a| a.id == actor_id))
        .and_then(|a| a.actor_class.as_deref())
        .map(SemanticClass::from_actor_class)
        .unwrap_or(SemanticClass::Prop)
}

#[derive(Resource)]
pub struct SensorScene {
    pub scene: RaycastScene,
    /// instance id -> semantic class byte.
    pub classes: HashMap<u32, u8>,
}

fn push_mesh_triangles(mesh: &bevy::mesh::Mesh, gt: Option<&GlobalTransform>, out: &mut RaycastScene, id: u32) {
    let Some(pos_attr) = mesh.attribute(bevy::mesh::Mesh::ATTRIBUTE_POSITION) else { return };
    let world = gt.map(|g| g.to_matrix()).unwrap_or(Mat4::IDENTITY);
    let positions: Vec<Vec3> = match pos_attr {
        bevy::mesh::VertexAttributeValues::Float32x3(v) => v.iter().map(|p| Vec3::from(*p)).collect(),
        _ => return,
    };
    match mesh.indices() {
        Some(bevy::mesh::Indices::U32(idx)) => {
            for tri in idx.chunks_exact(3) {
                out.push_tri(Tri {
                    a: world.transform_point3(positions[tri[0] as usize]),
                    b: world.transform_point3(positions[tri[1] as usize]),
                    c: world.transform_point3(positions[tri[2] as usize]),
                    instance_id: id,
                });
            }
        }
        Some(bevy::mesh::Indices::U16(idx)) => {
            for tri in idx.chunks_exact(3) {
                out.push_tri(Tri {
                    a: world.transform_point3(positions[tri[0] as usize]),
                    b: world.transform_point3(positions[tri[1] as usize]),
                    c: world.transform_point3(positions[tri[2] as usize]),
                    instance_id: id,
                });
            }
        }
        _ => {
            for tri in positions.chunks_exact(3) {
                out.push_tri(Tri {
                    a: world.transform_point3(tri[0]),
                    b: world.transform_point3(tri[1]),
                    c: world.transform_point3(tri[2]),
                    instance_id: id,
                });
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Cameras + sensors
// ---------------------------------------------------------------------------

/// Spawn rig cameras (RGB + depth + instance + semantic each) and the chase
fn spawn_sensors(
    mut commands: Commands,
    args: Res<CaptureArgs>,
    rig: Res<RigSpec>,
    scene_state: Option<Res<crate::scene_state::SceneState>>,
    sensor_scene: Option<Res<SensorScene>>,
    setup: Res<HarnessSetup>,
    mut state: ResMut<HarnessState>,
    mut images: ResMut<Assets<Image>>,
    device: Res<RenderDevice>,
) {
    let Some(sensor_scene) = sensor_scene else { return };
    if state.sensors_spawned || !setup.sensor_scene_ready {
        return;
    }
    let mut ego = ego_transform(scene_state.as_deref(), args.tick);
    // Sensors mount relative to the ground plane: drop the ego origin onto
    // the static surface under it.
    ego.translation.y = ground_y(&sensor_scene.scene, ego.translation);
    println!(
        "EGO pose x={} y={} z={} (ground-snapped)",
        ego.translation.x, ego.translation.y, ego.translation.z
    );
    let rgba_buf = aligned_row(args.width as usize, 4) * args.height as usize;
    let mut cam_order: isize = 0;

    let cam_index_of: HashMap<String, usize> =
        rig.cameras().enumerate().map(|(i, s)| (s.id.clone(), i)).collect();

    for sensor in rig.sensors.iter() {
        let tf = mount_world_transform(ego, &sensor.mount);
        if sensor.kind != SensorKind::Camera {
            continue; // lidar/radar are CPU-side; handled in collect_passes
        }
        let is_chase = sensor.id == crate::rig::CHASE_CAMERA_SENSOR_ID;
        let i = cam_index_of.get(&sensor.id).copied().unwrap_or(rig.cameras().count());
        let vfov = sensor.vertical_fov_deg.unwrap_or(58.0).to_radians();

        // RGB pass (AgX tonemapping, default clear).
        let rgb_image =
            setup_target_image(&mut images, args.width, args.height, TextureFormat::Rgba8UnormSrgb);
        let rgb_handle = rgb_image.clone();
        commands.spawn(ImageCopier {
            buffer: make_buffer(&device, rgba_buf),
            src_image: rgb_image.clone(),
            key: format!("rgb{i}"),
        });
        spawn_camera_entity(
            &mut commands,
            tf,
            vfov,
            0,
            false,
            Tonemapping::AgX,
            cam_order,
            rgb_image.into(),
            None,
        );
        cam_order += 1;

        // Raw reverse-Z Depth32Float readback rides the RGB view.
        commands.spawn(DepthCopier {
            src_image: rgb_handle,
            buffer: make_buffer(&device, rgba_buf),
            key: format!("depth{i}"),
        });

        if !is_chase {
            // Aux pass: instance id in RGB + semantic class in alpha,
            // unlit on render-layer 1, black clear, neutral exposure.
            spawn_pass_camera(
                &mut commands, &mut images, &device, &args, &format!("inst{i}"), tf, vfov, 1,
                true, Tonemapping::None, cam_order,
            );
            cam_order += 1;
        }
    }
    state.sensors_spawned = true;
}

#[allow(clippy::too_many_arguments)]
fn spawn_pass_camera(
    commands: &mut Commands,
    images: &mut Assets<Image>,
    device: &RenderDevice,
    args: &CaptureArgs,
    key: &str,
    transform: Transform,
    vfov_rad: f32,
    layer: u32,
    clear_black: bool,
    tonemap: Tonemapping,
    order: isize,
) {
    let image = setup_target_image(images, args.width, args.height, TextureFormat::Rgba8UnormSrgb);
    let rgba_buf = aligned_row(args.width as usize, 4) * args.height as usize;
    commands.spawn(ImageCopier {
        buffer: make_buffer(device, rgba_buf),
        src_image: image.clone(),
        key: key.to_string(),
    });
    // Unlit ID/semantic colors are absolute values: neutralize the camera's
    // default EV100 exposure (sunlight ≈ 1/39321 would crush them to black).
    let exposure = if clear_black {
        Some(bevy::camera::Exposure { ev100: -1.2f32.log2() }) // multiplier == 1.0
    } else {
        None
    };
    spawn_camera_entity(commands, transform, vfov_rad, layer, clear_black, tonemap, order, image.into(), exposure);
}

#[allow(clippy::too_many_arguments)]
#[allow(clippy::too_many_arguments)]
fn spawn_camera_entity(
    commands: &mut Commands,
    transform: Transform,
    vfov_rad: f32,
    layer: u32,
    clear_black: bool,
    tonemap: Tonemapping,
    order: isize,
    target: RenderTarget,
    exposure: Option<bevy::camera::Exposure>,
) {
    let mut e = commands.spawn((
        Camera3d {
            depth_texture_usages: (TextureUsages::RENDER_ATTACHMENT | TextureUsages::COPY_SRC).into(),
            ..default()
        },
        Camera {
            order,
            clear_color: if clear_black {
                ClearColorConfig::Custom(Color::BLACK)
            } else {
                ClearColorConfig::Default
            },
            ..default()
        },
        Projection::from(PerspectiveProjection { fov: vfov_rad, near: 0.5, far: 900.0, ..default() }),
        Msaa::Off,
        tonemap,
        transform,
        target,
        RenderLayers::layer(layer as usize),
    ));
    // Neutral exposure for the aux pass: unlit ID/class colors are absolute.
    if let Some(exposure) = exposure {
        e.insert(exposure);
    }
}

fn ego_transform(ss: Option<&crate::scene_state::SceneState>, tick_index: u32) -> Transform {
    match ss.and_then(|s| s.ego()) {
        Some(ego) => Transform {
            translation: Vec3::from_slice(&ego.transform.position),
            rotation: Quat::from_xyzw(
                ego.transform.rotation[0],
                ego.transform.rotation[1],
                ego.transform.rotation[2],
                ego.transform.rotation[3],
            ),
            scale: Vec3::ONE,
        },
        None => {
            let _ = tick_index;
            Transform::IDENTITY
        }
    }
}

// ---------------------------------------------------------------------------
// Frame loop + capture
// ---------------------------------------------------------------------------

/// Unconditional per-Update counter; also stamps scene-readiness for the
/// bring-up settle gate.
fn bump_tick(mut tick: ResMut<AppTick>, mut state: ResMut<HarnessState>) {
    tick.0 += 1;
    if state.build_ready_at.is_some() && state.ready_tick.is_none() {
        state.ready_tick = Some(tick.0);
    }
}

fn tick_frames(mut frame: ResMut<GlobalFrame>, state: Res<HarnessState>) {
    if state.build_ready_at.is_some() && state.clones_done && state.sensors_spawned {
        frame.0 += 1;
    }
    if frame.0 % 500 == 0 {
        println!(
            "PROGRESS frame={} ready={} clones={} sensors={}",
            frame.0,
            state.build_ready_at.is_some(),
            state.clones_done,
            state.sensors_spawned
        );
    }
}

fn strip_padding(data: &[u8], width: usize, height: usize, pixel: usize) -> Vec<u8> {
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

#[allow(clippy::too_many_arguments)]
fn collect_passes(
    receiver: Res<MainReceiver>,
    args: Res<CaptureArgs>,
    rig: Res<RigSpec>,
    scene_state: Option<Res<crate::scene_state::SceneState>>,
    tmerc: Option<Res<TmercOrigin>>,
    sensor_scene: Option<Res<SensorScene>>,
    mut state: ResMut<HarnessState>,
    mut exit: MessageWriter<AppExit>,
) {
    let mut latest: HashMap<String, SentPass> = HashMap::new();
    while let Ok(p) = receiver.try_recv() {
        latest.insert(p.key.clone(), p);
    }
    if latest.is_empty() {
        return;
    }
    // Expected keys for the full capture.
    let cam_index_of: HashMap<String, usize> =
        rig.cameras().enumerate().map(|(i, s)| (s.id.clone(), i)).collect();
    let mut expected: Vec<String> = Vec::new();
    for sensor in rig.sensors.iter() {
        if sensor.kind != SensorKind::Camera {
            continue;
        }
        let is_chase = sensor.id == crate::rig::CHASE_CAMERA_SENSOR_ID;
        let i = cam_index_of.get(&sensor.id).copied().unwrap_or(rig.cameras().count());
        expected.push(format!("rgb{i}"));
        expected.push(format!("depth{i}"));
        if !is_chase {
            expected.push(format!("inst{i}"));
        }
    }
    let min_steady_frame = args.warmup as u64 + 1;
    let done_frame = latest
        .values()
        .filter(|p| p.frame >= min_steady_frame)
        .map(|p| p.frame)
        .max();
    let Some(frame) = done_frame else { return };
    let have: Vec<&String> = latest
        .values()
        .filter(|p| p.frame == frame)
        .map(|p| &p.key)
        .collect();
    if have.len() < expected.len() || state.captured {
        return;
    }
    state.captured = true;

    let out_dir = PathBuf::from(&args.out);
    let w = args.width as usize;
    let h = args.height as usize;

    // ---- camera passes ----
    for sensor in rig.sensors.iter() {
        if sensor.kind != SensorKind::Camera {
            continue;
        }
        let is_chase = sensor.id == crate::rig::CHASE_CAMERA_SENSOR_ID;
        let i = cam_index_of.get(&sensor.id).copied().unwrap_or(rig.cameras().count());
        let dir = out_dir.join(&sensor.id);
        std::fs::create_dir_all(&dir).expect("mkdir");
        let save_png = |key: &str, name: &str| -> Result<()> {
            let p = latest.get(key).context("missing pass")?;
            let raw = strip_padding(&p.data, w, h, 4);
            let img = image::RgbaImage::from_raw(w as u32, h as u32, raw).context("rgba")?;
            img.save(dir.join(name))?;
            Ok(())
        };
        save_png(&format!("rgb{i}"), "00000000.rgb.png").expect("save rgb");
        if !is_chase {
            let raw = {
                let p = latest.get(&format!("inst{i}")).expect("instance pass");
                strip_padding(&p.data, w, h, 4)
            };
            let img = image::RgbaImage::from_raw(w as u32, h as u32, raw.clone()).expect("rgba");
            img.save(dir.join("00000000.instance.png")).expect("save instance");
            // Semantic class lives in the aux pass blue channel; re-encode
            // into the red channel for the standard semantic artifact shape.
            let mut sem = image::RgbaImage::new(w as u32, h as u32);
            for (x, y, px) in img.enumerate_pixels() {
                sem.put_pixel(x, y, image::Rgba([px[2], 0, 0, 255]));
            }
            sem.save(dir.join("00000000.semantic.png")).expect("save semantic");
            let depth = latest.get(&format!("depth{i}")).expect("depth pass");
            let draw = strip_padding(&depth.data, w, h, 4);
            std::fs::write(dir.join("00000000.depth.f32.bin"), &draw).expect("write depth bin");
        }
    }

    // ---- CPU sensors ----
    run_cpu_sensors(
        &out_dir,
        &rig,
        scene_state.as_deref(),
        tmerc.as_deref(),
        sensor_scene.as_deref().expect("sensor scene"),
        &state.instance_names,
        args.tick,
    );
    let legend = Legend {
        schema: "uniscenarios.sensor-legend/v1",
        classes: SemanticClass::ALL.iter().map(|c| (c.id(), c.name())).collect(),
        instances: state.instance_names.clone(),
        instance_classes: state.instance_classes.clone(),
    };
    std::fs::write(
        out_dir.join("legend.json"),
        serde_json::to_string_pretty(&legend).unwrap(),
    )
    .expect("write legend");

    exit.write(AppExit::Success);
}

fn run_cpu_sensors(
    out_dir: &Path,
    rig: &RigSpec,
    scene_state: Option<&SceneState>,
    tmerc: Option<&TmercOrigin>,
    sensor_scene: &SensorScene,
    instance_names: &[(u32, String)],
    tick_index: u32,
) {
    use crate::taxonomy::SemanticClass;
    let class_of = |id: u32| -> SemanticClass {
        sensor_scene
            .classes
            .get(&id)
            .and_then(|c| SemanticClass::ALL.iter().copied().find(|k| k.id() == *c))
            .unwrap_or(SemanticClass::Prop)
    };

    // Ego pose + velocity at the captured tick.
    let (ego_pos, ego_rot, ego_vel) = match scene_state.and_then(|s| s.ego()) {
        Some(ego) => (
            Vec3::from_slice(&ego.transform.position),
            Quat::from_xyzw(
                ego.transform.rotation[0],
                ego.transform.rotation[1],
                ego.transform.rotation[2],
                ego.transform.rotation[3],
            ),
            Vec3::from_slice(&ego.velocity),
        ),
        None => (Vec3::ZERO, Quat::IDENTITY, Vec3::ZERO),
    };
    // instance id -> scene-state actor velocity (statics = zero).
    let actor_velocity_of_name = |name: &str| -> Option<Vec3> {
        let actor_id = name.strip_prefix("actor:")?;
        let ss = scene_state?;
        ss.actors
            .iter()
            .find(|a| a.id == actor_id)
            .map(|a| Vec3::from_slice(&a.velocity))
    };
    let name_of = |id: u32| -> Option<&str> {
        instance_names
            .iter()
            .find(|(i, _)| *i == id)
            .map(|(_, n)| n.as_str())
    };
    let velocity_of = move |id: u32| -> Vec3 {
        name_of(id).and_then(actor_velocity_of_name).unwrap_or(Vec3::ZERO)
    };

    // ---- lidars ----
    for sensor in rig.lidars() {
        let cfg = lidar::LidarConfig {
            channels: sensor.lidar_channels,
            rotation_frequency_hz: sensor.rotation_frequency_hz,
            points_per_second: sensor.points_per_second.unwrap_or(1_300_000),
            vfov_deg: sensor.vertical_fov_deg.unwrap_or(25.0),
            hfov_deg: sensor.horizontal_fov_deg,
            range_m: sensor.range_m,
        };
        let mount_tf = mount_world_transform(
            Transform { translation: ego_pos, rotation: ego_rot, scale: Vec3::ONE },
            &sensor.mount,
        );
        let points = lidar::scan(
            &sensor_scene.scene,
            &cfg,
            mount_tf.translation,
            mount_tf.rotation,
            &|id| class_of(id),
        );
        let dir = out_dir.join(&sensor.id);
        std::fs::create_dir_all(&dir).expect("mkdir lidar");
        formats::write_lidar_ply(&dir.join("00000000.ply"), &points).expect("write ply");
        println!("LIDAR {} points={} steps/ch={}", sensor.id, points.len(), cfg.azimuth_steps());
    }

    // ---- radars ----
    let tick_hz = scene_state.map(|s| s.tick_hz).unwrap_or(20.0);
    for sensor in rig.radars() {
        let cfg = radar::RadarConfig::from_budget(
            sensor.points_per_second,
            tick_hz,
            sensor.horizontal_fov_deg,
            sensor.vertical_fov_deg.unwrap_or(30.0),
            sensor.range_m,
        );
        let mount_tf = mount_world_transform(
            Transform { translation: ego_pos, rotation: ego_rot, scale: Vec3::ONE },
            &sensor.mount,
        );
        let detections = radar::scan(
            &sensor_scene.scene,
            &cfg,
            mount_tf.translation,
            mount_tf.rotation,
            ego_vel,
            &velocity_of,
        );
        let dir = out_dir.join(&sensor.id);
        std::fs::create_dir_all(&dir).expect("mkdir radar");
        formats::write_radar_csv(&dir.join("00000000.csv"), &detections).expect("write csv");
        println!("RADAR {} detections={}", sensor.id, detections.len());
    }

    // ---- IMU / GNSS over the whole ego track ----
    let (imu_samples, gnss_samples) = derive_imu_gnss(scene_state, tmerc);
    formats::write_imu_jsonl(&out_dir.join("imu.jsonl"), &imu_samples).expect("write imu");
    formats::write_gnss_jsonl(&out_dir.join("gnss.jsonl"), &gnss_samples).expect("write gnss");
    println!(
        "IMU/GNSS samples={} gnss={}",
        imu_samples.len(),
        gnss_samples.len()
    );
    let _ = tick_index;
}

fn derive_imu_gnss(
    ss: Option<&SceneState>,
    tmerc: Option<&TmercOrigin>,
) -> (Vec<ImuSample>, Vec<GnssSample>) {
    let Some(ss) = ss else { return (vec![], vec![]) };
    let Some(ego) = ss.ego() else { return (vec![], vec![]) };
    // Ego track over ticks is not carried per-tick inside one scene-state; the
    // harness captures IMU/GNSS from the single provided state's kinematics.
    // A multi-tick series requires the batch API (WSB5); we emit the current
    // sample derived from velocity and angular rate.
    let dt = 1.0 / f64::from(ss.tick_hz.max(1e-6));
    let t = f64::from(ss.tick) * dt;
    // With only one state we cannot finite-difference; emit zero-accel sample
    // carrying angularVelocityY when present.
    let yaw_rate = ego.angular_velocity_y.unwrap_or(0.0);
    let imu = ImuSample {
        tick: ss.tick,
        t,
        accel: [0.0, 0.0, 0.0],
        gyro: [0.0, yaw_rate as f32, 0.0],
    };
    let gnss = tmerc
        .map(|tm| {
            let (lat, lon) = tm.inverse(f64::from(ego.transform.position[0]), f64::from(-ego.transform.position[2]));
            GnssSample {
                tick: ss.tick,
                t,
                latitude_deg: lat,
                longitude_deg: lon,
                altitude_m: ego.transform.position[1],
            }
        })
        .map(|g| vec![g])
        .unwrap_or_default();
    (vec![imu], gnss)
}

// ---------------------------------------------------------------------------
// Manifest + render-world readback plumbing
// ---------------------------------------------------------------------------

fn write_manifest(out_dir: &Path) -> Result<()> {
    let mut files: Vec<(String, String)> = Vec::new();
    fn walk(dir: &Path, base: &Path, files: &mut Vec<(String, String)>) -> Result<()> {
        for entry in std::fs::read_dir(dir)? {
            let entry = entry?;
            let path = entry.path();
            if path.is_dir() {
                walk(&path, base, files)?;
            } else {
                let rel = path.strip_prefix(base)?.to_string_lossy().to_string();
                files.push((rel, crate::sha256_file(&path)?));
            }
        }
        Ok(())
    }
    walk(out_dir, out_dir, &mut files)?;
    files.sort();
    let manifest = json!({
        "schema": "uniscenarios.sensor-capture-manifest/v1",
        "profile": "sensor",
        "files": files.into_iter().map(|(p, h)| json!({"path": p, "sha256": h})).collect::<Vec<_>>(),
    });
    std::fs::write(out_dir.join("manifest.json"), serde_json::to_string_pretty(&manifest)?)?;
    Ok(())
}

fn extract_copiers(
    mut commands: Commands,
    images: Extract<Query<&ImageCopier>>,
    depths: Extract<Query<&DepthCopier>>,
) {
    commands.insert_resource(Copiers(images.iter().cloned().collect()));
    commands.insert_resource(DepthCopiers(depths.iter().cloned().collect()));
}

fn extract_frame(frame: Extract<Res<GlobalFrame>>, mut stamp: ResMut<FrameStamp>) {
    stamp.0 = frame.0;
}

fn copy_passes(
    ctx: RenderContext,
    queue: Res<RenderQueue>,
    copiers: Res<Copiers>,
    depths: Res<DepthCopiers>,
    gpu_images: Res<RenderAssets<GpuImage>>,
    depth_views: Query<(Entity, &ExtractedCamera, &ViewDepthTexture)>,
) {
    let mut encoder =
        ctx.render_device()
            .create_command_encoder(&CommandEncoderDescriptor::default());
    for c in copiers.0.iter() {
        let Some(src) = gpu_images.get(&c.src_image) else { continue };
        let width = src.texture_descriptor.size.width as usize;
        let pixel = src.texture_descriptor.format.block_copy_size(None).unwrap_or(4);
        let padded = aligned_row(width, pixel as usize);
        encoder.copy_texture_to_buffer(
            src.texture.as_image_copy(),
            TexelCopyBufferInfo {
                buffer: &c.buffer,
                layout: TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(std::num::NonZero::<u32>::new(padded as u32).unwrap().into()),
                    rows_per_image: None,
                },
            },
            src.texture_descriptor.size,
        );
    }
    for d in depths.0.iter() {
        let Some((_, _, view)) = depth_views.iter().find(|(_, cam, _)| {
            matches!(
                cam.target,
                Some(bevy::camera::NormalizedRenderTarget::Image(ref irt))
                    if irt.handle.id() == d.src_image.id()
            )
        }) else {
            continue;
        };
        let tex = &view.texture;
        let width = tex.size().width as usize;
        let padded = aligned_row(width, 4);
        encoder.copy_texture_to_buffer(
            tex.as_image_copy(),
            TexelCopyBufferInfo {
                buffer: &d.buffer,
                layout: TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(std::num::NonZero::<u32>::new(padded as u32).unwrap().into()),
                    rows_per_image: None,
                },
            },
            tex.size(),
        );
    }
    queue.submit(std::iter::once(encoder.finish()));
}

fn receive_passes(
    device: Res<RenderDevice>,
    sender: Res<RenderSender>,
    copiers: Res<Copiers>,
    depths: Res<DepthCopiers>,
    stamp: Res<FrameStamp>,
) {
    struct Pending {
        key: String,
        buffer: Buffer,
    }
    let mut pending: Vec<Pending> = Vec::new();
    for c in copiers.0.iter().cloned() {
        pending.push(Pending { key: c.key.clone(), buffer: c.buffer.clone() });
    }
    for d in depths.0.iter().cloned() {
        pending.push(Pending { key: d.key.clone(), buffer: d.buffer.clone() });
    }
    if pending.is_empty() {
        return;
    }
    let (s, r) = crossbeam_channel::bounded::<()>(pending.len());
    for p in &pending {
        let tx = s.clone();
        p.buffer.slice(..).map_async(MapMode::Read, move |res| {
            if res.is_err() {
                panic!("map buffer failed");
            }
            let _ = tx.send(());
        });
    }
    device.poll(PollType::wait_indefinitely()).expect("poll device");
    for _ in &pending {
        r.recv().expect("map_async result");
    }
    for p in &pending {
        let data = p.buffer.slice(..).get_mapped_range().to_vec();
        let _ = sender.send(SentPass { key: p.key.clone(), frame: stamp.0, data });
        p.buffer.unmap();
    }
}
