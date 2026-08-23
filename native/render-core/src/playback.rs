//! Trace playback: scene-state.v1 → per-tick rendering.
//!
//! Loads corpus GLB tiles, spawns catalog-bound actor meshes driven by the
//! scene-state document, renders RGB + instance-ID (+ optional motion-vector
//! G-buffer) per tick at the requested resolution with GPU→CPU readback, and
//! writes frames plus timings (+ legend, + MV validation report).

use crate::catalog::actor_parts;
use crate::motion_vector::{decode_rg16f, MotionVectorMaterial};
use crate::readback::{
    self, Copiers, GlobalFrame, MainReceiver, PassCopier, SentPass,
};
use crate::scene_state::{ActorDesc, ActorTickKind, SceneState};
use crate::lighting::{self, LightingRung};
use crate::post_grain::apply_cpu_grain;
use crate::profiles::{CinematicFx, RenderProfile};
use crate::veg;
use crate::weather::{self as weather_mod, Weather};
use anyhow::{bail, Result};
use bevy::app::{AppExit, ScheduleRunnerPlugin};
use bevy::asset::AssetPlugin;
use bevy::camera::visibility::RenderLayers;
use bevy::camera::RenderTarget;
use bevy::core_pipeline::tonemapping::Tonemapping;
use bevy::gltf::Gltf;
use bevy::light::{DirectionalLight, DirectionalLightShadowMap};
use bevy::log::LogPlugin;
use bevy::math::Affine3A;
use bevy::pbr::PreviousGlobalTransform;
use bevy::prelude::*;
use bevy::render::render_resource::{
    CommandEncoderDescriptor, Extent3d, TextureFormat, TextureUsages,
};
use bevy::render::renderer::{RenderContext, RenderDevice};
use bevy::world_serialization::{WorldAssetRoot, WorldInstance, WorldInstanceSpawner};
use bevy::window::ExitCondition;
use clap::Parser;
use serde_json::json;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

/// Instance IDs for actors start here; tiles occupy 1..=N below the band.
pub const ACTOR_ID_BASE: u32 = 1_000_000;

#[derive(Parser, Debug, Clone)]
pub struct PlaybackArgs {
    /// Corpus GLB tiles (absolute paths), comma-separated.
    #[arg(long, value_delimiter = ',', required = true)]
    pub glbs: Vec<String>,
    /// scene-state.v1 document to play back.
    #[arg(long)]
    pub scene_state: PathBuf,
    /// Ticks to render (default: min(120, document length)).
    #[arg(long)]
    pub ticks: Option<u32>,
    #[arg(long, default_value_t = 736)]
    pub width: u32,
    #[arg(long, default_value_t = 416)]
    pub height: u32,
    #[arg(long, default_value_t = 58.0)]
    pub fov: f32,
    #[arg(long, default_value_t = 0.5)]
    pub near: f32,
    #[arg(long, default_value_t = 900.0)]
    pub far: f32,
    /// Warmup frames (shader compile) before tick 0 is captured.
    #[arg(long, default_value_t = 30)]
    pub warmup: u32,
    /// First trace tick to play (skips everything before it).
    #[arg(long)]
    pub start_tick: Option<usize>,
    /// Road-surface elevation for actor origins (traces are heightless).
    #[arg(long, default_value_t = 12.99)]
    pub ground_y: f32,
    /// `static` fixes the camera at the initial chase pose; `follow` tracks
    /// ego with a chase cam; `pov` pins a dashcam to the ego windshield
    /// (W0 convention: eye +1.45 m, look-ahead 12 m along heading).
    #[arg(long, default_value = "follow")]
    pub camera: String,
    /// Chase-cam geometry: distance behind / height above the ego.
    #[arg(long, default_value_t = 9.0)]
    pub chase_dist: f32,
    #[arg(long, default_value_t = 3.0)]
    pub chase_height: f32,
    /// Enable the motion-vector G-buffer pass (layer 2).
    #[arg(long, default_value_t = false)]
    pub mv: bool,
    /// Lighting foundation ladder rung 0-5 (0=spike baseline, 1=IBL sky,
    /// 2=physical sun/EV100, 3=GTAO+contact shadows, 4=PCSS, 5=Solari GI).
    #[arg(long, default_value_t = 4)]
    pub rung: u8,
    /// Render profile: sensor (linear, fixed EV100) or cinematic (full stack).
    #[arg(long, default_value = "cinematic")]
    pub profile: String,
    /// Weather state: clear | fog | rain | night.
    #[arg(long, default_value = "clear")]
    pub weather: String,
    /// HDRI for the sky/IBL (equirectangular .hdr).
    #[arg(long, default_value = "/home/path/local-uniscenarios/maps/yale-street/browser/3d/env/sky.hdr")]
    pub sky: String,
    /// Sun elevation degrees (rung < 2 fallback).
    #[arg(long, default_value_t = 38.0)]
    pub sun_elev: f32,
    /// Sun azimuth degrees (rung < 2 fallback).
    #[arg(long, default_value_t = 145.0)]
    pub sun_azim: f32,
    /// Spike lux used when the rung has no physical sun.
    #[arg(long, default_value_t = 28_000.0)]
    pub lux: f32,
    /// Ambient brightness used at rung 0 only.
    #[arg(long, default_value_t = 0.6)]
    pub ambient: f32,
    /// Enable SSR (deferred path) — deterministic, off by default.
    #[arg(long, default_value_t = false)]
    pub ssr: bool,
    /// Cinematic: temporal anti-aliasing (known ghosting; off for capture).
    #[arg(long, default_value_t = false)]
    pub taa: bool,
    /// Cinematic CPU-readback film-grain intensity (0 disables).
    #[arg(long, default_value_t = 0.04)]
    pub grain: f32,
    /// Vegetation GLBs with .instances.json sidecars, comma-separated;
    /// instanced via render_core::veg.
    #[arg(long, value_delimiter = ',')]
    pub veg_glbs: Vec<String>,
    /// Cinematic chromatic-aberration intensity (0 disables).
    #[arg(long, default_value_t = 1.2)]
    pub ca: f32,
    /// Cinematic DoF aperture in f-stops (higher = deeper focus).
    #[arg(long, default_value_t = 6.5)]
    pub dof_fstops: f32,
    /// Cinematic: disable depth of field entirely.
    #[arg(long, default_value_t = false)]
    pub no_dof: bool,
    /// Cinematic motion-blur shutter angle in degrees (0 disables).
    #[arg(long, default_value_t = 90.0)]
    pub shutter: f32,
    /// Cinematic bloom intensity (Bloom::NATURAL is 0.15; 0 disables).
    #[arg(long, default_value_t = 0.15)]
    pub bloom: f32,
    /// Wall-clock ms to wait after scene-ready before ticking frames (lets
    /// lazy GLB/veg uploads land in the uncapped headless loop).
    #[arg(long, default_value_t = 0)]
    pub settle_ms: i64,
    /// Output directory for frames + reports.
    #[arg(long)]
    pub out_dir: String,
    /// After playback, numerically validate MV against finite differences of
    /// GT transforms for this actor id (requires --mv).
    #[arg(long)]
    pub validate_mv_actor: Option<String>,
}

// ---------------------------------------------------------------------------
// Markers & resources
// ---------------------------------------------------------------------------

#[derive(Component)]
struct TileLoad {
    handle: Handle<Gltf>,
    /// Position in the CLI --glbs list; spawn order follows it.
    index: usize,
}
#[derive(Component)]
struct SceneSpawned;
#[derive(Component)]
struct IdClone;
#[derive(Component)]
struct MvClone;
#[derive(Component)]
struct CameraMarker;

#[derive(Component)]
struct ActorRoot {
    id: String,
}

#[derive(Resource, Clone)]
struct Playback {
    args: PlaybackArgs,
    state: std::sync::Arc<SceneState>,
    n_ticks: u32,
}

#[derive(Resource, Default)]
struct Readiness {
    loaded_at: Option<Instant>,
    build_ready_at: Option<Instant>,
    tiles_id_done: bool,
    actors_spawned: bool,
}

#[derive(Resource, Default)]
struct ActorRegistry {
    roots: HashMap<String, Entity>,
    instance_ids: HashMap<String, u32>,
    next_instance_id: u32,
    /// MV clone entity -> part offset matrix (root-local).
    mv_clones: HashMap<String, Vec<(Entity, Mat4)>>,
    /// MV clone entity -> affine applied at the previous rendered tick.
    mv_prev: HashMap<Entity, Affine3A>,
}

#[derive(Resource, Default)]
struct Legend {
    entries: Vec<serde_json::Value>,
}

#[derive(Resource)]
struct PlayCursor {
    /// Next scene-state frame index to apply.
    next_frame: usize,
    /// Rendered frame -> applied frame index (for pass correlation).
    frame_to_tick: HashMap<u64, usize>,
    /// Applied-but-not-yet-captured ticks (backpressure: one in flight).
    awaiting: u64,
}

#[derive(Resource, Default)]
struct Metrics {
    capture_start: Option<Instant>,
    last_capture_at: Option<Instant>,
    frame_period_ms: Vec<f64>,
    readback_us_total: u64,
    captured: u64,
    /// Per-tick saved artifacts for validation: (tick, id_bytes, mv_bytes).
    prev_pass: Option<(usize, Vec<u8>, Vec<u8>)>,
    mv_validation: Vec<serde_json::Value>,
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

pub fn run(mut args: PlaybackArgs) -> Result<()> {
    let path = args.scene_state.clone();
    let mut doc = SceneState::load(&path)?;
    if doc.version != crate::scene_state::SCENE_STATE_VERSION {
        bail!("unsupported scene-state version {}", doc.version);
    }
    if let Some(start) = args.start_tick {
        let start = start.min(doc.frames.len().saturating_sub(1));
        doc.frames.drain(..start);
    }
    let n_ticks = args.ticks.unwrap_or(120).min(doc.frames.len() as u32).max(1);
    if !args.glbs.iter().all(|g| Path::new(g).is_absolute()) {
        bail!("glb paths must be absolute");
    }
    if args.validate_mv_actor.is_some() && args.camera != "static" {
        bail!("--validate-mv-actor requires --camera static (the v1 MV pass isolates object motion)");
    }
    let weather = Weather::parse(&args.weather)?;
    let profile = RenderProfile::parse(&args.profile)?;
    std::env::set_var("BEVY_ASSET_ROOT", "/");
    std::fs::create_dir_all(&args.out_dir)?;

    let playback = Playback {
        state: std::sync::Arc::new(doc),
        n_ticks,
        args: args.clone(),
    };

    let mut app = App::new();
    app.insert_resource(ClearColor(Color::srgb(0.53, 0.74, 0.92)))
        .add_plugins((
            DefaultPlugins
                .set(AssetPlugin {
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
                .set(LogPlugin {
                    filter: "warn,wgpu_core=warn,wgpu_hal=warn,naga=warn".into(),
                    ..default()
                }),
            ScheduleRunnerPlugin::run_loop(Duration::ZERO),
            MaterialPlugin::<MotionVectorMaterial>::default(),
        ))
        .insert_resource(DirectionalLightShadowMap { size: 2048 })
        .insert_resource(weather)
        .insert_resource(profile)
        .insert_resource(playback.clone())
        .insert_resource(Readiness::default())
        .insert_resource(ActorRegistry::default())
        .insert_resource(Legend::default())
        .insert_resource(PlayCursor {
            next_frame: 0,
            frame_to_tick: HashMap::new(),
            awaiting: 0,
        })
        .insert_resource(Metrics::default())
        .insert_resource(CameraPose {
            eye: [0.0; 3],
            target: [0.0; 3],
        })
        .init_resource::<WetnessApplied>()
        .init_resource::<GlobalFrame>()
        .add_systems(Startup, startup_setup)
        .add_systems(
            Update,
            (
                check_assets,
                poll_roots,
                on_scene_ready,
                apply_tick,
                bump_frame,
                veg::load_veg_roots,
                veg::instantiate_veg,
                apply_wetness_once,
                attach_fog_sun,
            )
                .chain(),
        )
        .add_systems(Update, collect_passes);

    readback::install(&mut app);

    app.run();
    Ok(())
}

fn sun_direction(elev_deg: f32, azim_deg: f32) -> Dir3 {
    let elev = elev_deg.to_radians();
    let azim = azim_deg.to_radians();
    let dir = Vec3::new(
        -(elev.cos() * azim.sin()),
        -elev.sin(),
        -(elev.cos() * azim.cos()),
    );
    Dir3::new(dir.normalize()).unwrap()
}

fn startup_setup(
    mut commands: Commands,
    pb: Res<Playback>,
    mut cam_pose: ResMut<CameraPose>,
    mut images: ResMut<Assets<Image>>,
    mut meshes: ResMut<Assets<Mesh>>,
    mut materials: ResMut<Assets<StandardMaterial>>,
    weather: Res<Weather>,
    profile: Res<RenderProfile>,
    device: Res<RenderDevice>,
    server: Res<AssetServer>,
) {
    // Initial chase pose around the first ego position; refined per tick.
    let ego = pb
        .state
        .frames
        .first()
        .and_then(|f| f.actors.first())
        .map(|a| [a.position[0] as f32, pb.args.ground_y, a.position[2] as f32])
        .unwrap_or([0.0; 3]);
    let eye = Vec3::new(ego[0], pb.args.ground_y + pb.args.chase_height, ego[2] + pb.args.chase_dist);
    let target = Vec3::new(ego[0], pb.args.ground_y + 1.2, ego[2]);
    let fwd = (target - eye).normalize();
    *cam_pose = CameraPose {
        eye: [f64::from(eye.x), f64::from(eye.y), f64::from(eye.z)],
        target: [f64::from(target.x), f64::from(target.y), f64::from(target.z)],
    };

    let rung = LightingRung(pb.args.rung);
    let plan = weather.lighting_plan(None);

    // WSB4 lighting ladder (see render_core::lighting).
    let sky = lighting::spawn_lighting(
        &mut commands,
        &mut images,
        rung,
        &plan,
        sun_direction(pb.args.sun_elev, pb.args.sun_azim),
        400.0,
        &pb.args.sky,
        (pb.args.lux, if rung.ibl() { 0.0 } else { pb.args.ambient }),
    )
    .unwrap_or_else(|e| panic!("WSB4 lighting/sky setup failed: {e:#}"));

    match *weather {
        Weather::Fog => weather_mod::spawn_fog(&mut commands, eye, fwd, 48),
        Weather::Night => weather_mod::spawn_streetlights(
            &mut commands, &mut meshes, &mut materials, eye, fwd,
        ),
        _ => {}
    }
    let size = Extent3d {
        width: pb.args.width,
        height: pb.args.height,
        ..default()
    };
    let rgba_row = readback::aligned_row(size.width as usize, 4) * size.height as usize;
    let mv_row = readback::aligned_row(size.width as usize, 4) * size.height as usize;

    let rgb_image = readback::setup_target_image(
        &mut images,
        pb.args.width,
        pb.args.height,
        TextureFormat::Rgba8UnormSrgb,
    );
    commands.spawn(PassCopier {
        buffer: readback::make_buffer(&device, rgba_row),
        src_image: rgb_image.clone(),
        key: "rgb".into(),
    });
    let rgb_cam = commands.spawn((
        CameraMarker,
        Camera3d {
            depth_texture_usages: (TextureUsages::RENDER_ATTACHMENT | TextureUsages::COPY_SRC)
                .into(),
            ..default()
        },
        Projection::from(PerspectiveProjection {
            fov: pb.args.fov.to_radians(),
            near: pb.args.near,
            far: pb.args.far,
            ..default()
        }),
        Msaa::Off,
        Tonemapping::AgX,
        Transform::from_translation(eye).looking_at(target, Vec3::Y),
        RenderTarget::Image(rgb_image.into()),
    )).id();

    // WSB4 render profile (sensor|cinematic) on the RGB view only; the
    // instance-ID view stays exactly as the spike had it.
    profile.apply(
        &mut commands,
        rgb_cam,
        *weather,
        sky.clone(),
        plan.skybox_brightness,
        pb.args.ssr,
        pb.args.taa,
        pb.args.grain,
        CinematicFx {
            chromatic_aberration: pb.args.ca,
            dof_aperture_f_stops: pb.args.dof_fstops,
            dof_enabled: !pb.args.no_dof,
            motion_shutter_angle: pb.args.shutter,
            bloom_intensity: pb.args.bloom,
        },
    );
    if LightingRung(pb.args.rung).ao_contact() {
        lighting::apply_camera_ao(&mut commands, rgb_cam);
    }
    if *weather == Weather::Fog {
        commands.entity(rgb_cam).insert(bevy::light::VolumetricFog {
            ambient_color: Color::srgb(0.75, 0.8, 0.88),
            ambient_intensity: 0.35,
            jitter: 0.0,
            step_count: 48,
        });
    }

    let id_image = readback::setup_target_image(
        &mut images,
        pb.args.width,
        pb.args.height,
        TextureFormat::Rgba8UnormSrgb,
    );
    commands.spawn(PassCopier {
        buffer: readback::make_buffer(&device, rgba_row),
        src_image: id_image.clone(),
        key: "id".into(),
    });
    commands.spawn((
        Camera3d::default(),
        Camera {
            clear_color: ClearColorConfig::Custom(Color::BLACK),
            order: 1,
            ..default()
        },
        Projection::from(PerspectiveProjection {
            fov: pb.args.fov.to_radians(),
            near: pb.args.near,
            far: pb.args.far,
            ..default()
        }),
        Msaa::Off,
        Tonemapping::None,
        Transform::from_translation(eye).looking_at(target, Vec3::Y),
        RenderTarget::Image(id_image.into()),
        RenderLayers::layer(1),
    ));

    if pb.args.mv {
        let mv_image = readback::setup_target_image(
            &mut images,
            pb.args.width,
            pb.args.height,
            TextureFormat::Rg16Float,
        );
        commands.spawn(PassCopier {
            buffer: readback::make_buffer(&device, mv_row),
            src_image: mv_image.clone(),
            key: "mv".into(),
        });
        commands.spawn((
            Camera3d::default(),
            Camera {
                clear_color: ClearColorConfig::Custom(Color::BLACK),
                order: 3,
                is_active: true,
                ..default()
            },
            Projection::from(PerspectiveProjection {
                fov: pb.args.fov.to_radians(),
                near: pb.args.near,
                far: pb.args.far,
                ..default()
            }),
            Msaa::Off,
            Tonemapping::None,
            Transform::from_translation(eye).looking_at(target, Vec3::Y),
            RenderTarget::Image(mv_image.into()),
            RenderLayers::layer(2),
        ));
    }


    veg::spawn_veg(&mut commands, &server, &pb.args.veg_glbs);

    for (i, g) in pb.args.glbs.iter().enumerate() {
        let path = g.trim_start_matches('/').to_owned();
        let handle: Handle<Gltf> = server.load(path);
        commands.spawn(TileLoad { handle, index: i });
    }
}

fn check_assets(
    mut commands: Commands,
    gltfs: Res<Assets<Gltf>>,
    loads: Query<(Entity, &TileLoad), Without<SceneSpawned>>,
    mut readiness: ResMut<Readiness>,
    pb: Res<Playback>,
) {
    // Determinism: wait for EVERY GLB, then spawn roots in CLI --glbs order
    // so entity/draw order never races async load completion (WSB6 fix).
    let mut ordered: Vec<(usize, Entity, &TileLoad)> =
        loads.iter().map(|(e, t)| (t.index, e, t)).collect();
    if readiness.loaded_at.is_none()
        && ordered.iter().all(|(_, _, t)| gltfs.contains(&t.handle))
        && gltfs.len() >= pb.args.glbs.len()
    {
        readiness.loaded_at = Some(Instant::now());
        ordered.sort_by_key(|(i, _, _)| *i);
        for (_, e, tile) in ordered {
            let Some(gltf) = gltfs.get(&tile.handle) else {
                continue;
            };
            let Some(scene) = gltf.default_scene.clone() else {
                panic!("GLB without default scene");
            };
            commands.entity(e).insert(SceneSpawned);
            commands.spawn((WorldAssetRoot(scene),));
        }
    }
}

fn poll_roots(
    roots: Query<&WorldInstance>,
    spawner: Option<Res<WorldInstanceSpawner>>,
    mut readiness: ResMut<Readiness>,
    pb: Res<Playback>,
) {
    let Some(spawner) = spawner else {
        return;
    };
    if readiness.build_ready_at.is_some() || roots.iter().count() < pb.args.glbs.len() {
        return;
    }
    if roots.iter().all(|wi| spawner.instance_is_ready(**wi)) {
        readiness.build_ready_at = Some(Instant::now());
    }
}

/// One-time post-load step: number the tile meshes into the legend, spawn the
/// initial actor set, write the merged legend.
#[allow(clippy::too_many_arguments)]
fn on_scene_ready(
    mut commands: Commands,
    mut readiness: ResMut<Readiness>,
    pb: Res<Playback>,
    meshes_q: Query<
        (
            Entity,
            &Mesh3d,
            Option<&Name>,
            Option<&ChildOf>,
            Option<&Transform>,
        ),
        Without<IdClone>,
    >,
    mut materials: ResMut<Assets<StandardMaterial>>,
    mut mv_materials: ResMut<Assets<MotionVectorMaterial>>,
    mut meshes: ResMut<Assets<Mesh>>,
    mut registry: ResMut<ActorRegistry>,
    mut legend: ResMut<Legend>,
    mut cursor: ResMut<PlayCursor>,
) {
    if readiness.build_ready_at.is_none() || readiness.tiles_id_done {
        return;
    }

    // --- tile instance IDs (deterministic: name, then entity bits) ---
    let mut entries: Vec<(String, u64, Handle<Mesh>, Option<Entity>, Transform)> = Vec::new();
    for (e, mesh, name, child_of, transform) in &meshes_q {
        entries.push((
            name.map(|n| n.to_string())
                .unwrap_or_else(|| format!("unnamed_mesh_{e}")),
            e.to_bits(),
            mesh.0.clone(),
            child_of.map(|c| c.parent()),
            transform.copied().unwrap_or(Transform::IDENTITY),
        ));
    }
    entries.sort_by(|a, b| a.0.cmp(&b.0).then(a.1.cmp(&b.1)));
    for (i, (name, _, mesh_h, parent, transform)) in entries.into_iter().enumerate() {
        let id = (i + 1) as u32;
        let bytes = id.to_le_bytes();
        let mat = materials.add(StandardMaterial {
            base_color: Color::srgb_u8(bytes[0], bytes[1], bytes[2]),
            unlit: true,
            ..default()
        });
        let mut cmd = commands.spawn((
            IdClone,
            Mesh3d(mesh_h),
            MeshMaterial3d(mat),
            RenderLayers::layer(1),
            transform,
        ));
        if let Some(p) = parent {
            cmd.insert(ChildOf(p));
        }
        legend.entries.push(json!({ "id": id, "name": name }));
    }
    readiness.tiles_id_done = true;

    // --- actors ---
    registry.next_instance_id = ACTOR_ID_BASE;
    let mut sorted: Vec<&ActorDesc> = pb.state.actors.iter().collect();
    sorted.sort_by(|a, b| a.id.cmp(&b.id));
    for desc in sorted {
        let next = registry.next_instance_id;
        registry.instance_ids.insert(desc.id.clone(), next);
        registry.next_instance_id += 1;
    }

    // Spawn whatever is present in frame 0 (or earlier spawn records).
    if let Some(frame) = pb.state.frames.first() {
        for rec in &frame.actors {
            if rec.kind == ActorTickKind::Despawn {
                continue;
            }
            spawn_actor_if_needed(
                &mut commands, &pb, &mut meshes, &mut materials, &mut mv_materials,
                &mut registry, &mut legend, &rec.id,
            );
        }
    }

    let legend_path = Path::new(&pb.args.out_dir).join("legend.json");
    std::fs::write(&legend_path, serde_json::to_string_pretty(&legend.entries).unwrap())
        .expect("write legend");
    readiness.actors_spawned = true;
    let _ = &cursor; // cursor starts at 0
}

#[allow(clippy::too_many_arguments)]
fn spawn_actor_if_needed(
    commands: &mut Commands,
    pb: &Res<Playback>,
    meshes: &mut Assets<Mesh>,
    materials: &mut Assets<StandardMaterial>,
    mv_materials: &mut Assets<MotionVectorMaterial>,
    registry: &mut ActorRegistry,
    legend: &mut Legend,
    id: &str,
) {
    if registry.roots.contains_key(id) {
        return;
    }
    let Some(desc) = pb.state.actors.iter().find(|a| a.id == id) else {
        return;
    };
    let instance_id = registry.instance_ids[id];
    let bytes = instance_id.to_le_bytes();
    let id_color = Color::srgb_u8(bytes[0], bytes[1], bytes[2]);
    let mv_handle = mv_materials.add(MotionVectorMaterial {});

    let root = commands
        .spawn((
            ActorRoot { id: id.to_string() },
            Visibility::Visible,
            Transform::IDENTITY,
        ))
        .id();

    for part in actor_parts(desc) {
        let mesh_h = meshes.add(part.mesh);
        let lit = materials.add(StandardMaterial {
            base_color: part.color,
            perceptual_roughness: 0.65,
            ..default()
        });
        let offset = part.offset;
        commands.entity(root).with_child((
            Mesh3d(mesh_h.clone()),
            MeshMaterial3d(lit),
            offset,
            RenderLayers::layer(0),
        ));
        let id_mat = materials.add(StandardMaterial {
            base_color: id_color,
            unlit: true,
            ..default()
        });
        commands.entity(root).with_child((
            IdClone,
            Mesh3d(mesh_h.clone()),
            MeshMaterial3d(id_mat),
            offset,
            RenderLayers::layer(1),
        ));
        if pb.args.mv {
            let mv_entity = commands
                .spawn((
                    MvClone,
                    Mesh3d(mesh_h),
                    MeshMaterial3d(mv_handle.clone()),
                    offset,
                    Visibility::Visible,
                    InheritedVisibility::VISIBLE,
                    ViewVisibility::default(),
                    RenderLayers::layer(2),
                ))
                .id();
            registry
                .mv_clones
                .entry(id.to_string())
                .or_default()
                .push((mv_entity, offset.to_matrix()));
        }
        legend.entries.push(json!({
            "id": instance_id,
            "name": format!("{}:{}@{:03}", desc.catalog_id, part.name, instance_id),
        }));
    }

    registry.roots.insert(id.to_string(), root);
}

/// Apply the next scene-state frame: transforms, spawn/despawn, camera, and
/// the previous-transform push into MV uniforms.
#[allow(clippy::too_many_arguments)]
fn apply_tick(
    mut commands: Commands,
    pb: Res<Playback>,
    readiness: Res<Readiness>,
    mut cursor: ResMut<PlayCursor>,
    mut registry: ResMut<ActorRegistry>,
    mut legend: ResMut<Legend>,
    mut meshes: ResMut<Assets<Mesh>>,
    mut materials: ResMut<Assets<StandardMaterial>>,
    mut mv_materials: ResMut<Assets<MotionVectorMaterial>>,
    mut roots: Query<(Entity, &ActorRoot, &mut Transform, &mut Visibility)>,
    mut cams: Query<&mut Transform, (With<CameraMarker>, Without<ActorRoot>)>,
    mut global_frame: ResMut<GlobalFrame>,
    mut cam_pose: ResMut<CameraPose>,
) {
    if !readiness.actors_spawned
        || cursor.next_frame >= pb.n_ticks as usize
        || cursor.awaiting >= 1
        // Let the warmup frames pass before binding tick 0 to a render.
        || global_frame.0 < u64::from(pb.args.warmup)
    {
        return;
    }
    let frame_idx = cursor.next_frame;
    let Some(frame) = pb.state.frames.get(frame_idx) else {
        return;
    };

    for rec in &frame.actors {
        spawn_actor_if_needed(
            &mut commands, &pb, &mut meshes, &mut materials, &mut mv_materials,
            &mut registry, &mut legend, &rec.id,
        );
        let Some((entity, _, mut transform, mut visibility)) =
            roots.iter_mut().find(|(_, r, _, _)| r.id == rec.id)
        else {
            continue;
        };
        match rec.kind {
            ActorTickKind::Despawn => {
                *visibility = Visibility::Hidden;
                continue;
            }
            _ => *visibility = Visibility::Visible,
        }
        transform.translation = Vec3::new(
            rec.position[0] as f32,
            pb.args.ground_y,
            rec.position[2] as f32,
        );
        let q = Quat::from_xyzw(
            rec.rotation[0] as f32,
            rec.rotation[1] as f32,
            rec.rotation[2] as f32,
            rec.rotation[3] as f32,
        );
        transform.rotation = q;

    }
    // Camera follows the ego unless explicitly static. `pov` pins a W0-style
    // dashcam to the ego windshield (eye +1.45 m, 12 m look-ahead along the
    // heading, slight downward tilt) matching scripts/w0/render-clip.mjs.
    if pb.args.camera != "static" {
        if let Ok(mut cam) = cams.single_mut() {
            let focus_rec = frame
                .actors
                .iter()
                .find(|a| a.id == "ego")
                .or_else(|| frame.actors.first());
            if let Some(focus) = focus_rec {
                let pos =
                    Vec3::new(focus.position[0] as f32, pb.args.ground_y, focus.position[2] as f32);
                let yaw = focus.yaw_rad as f32;
                let fwd = Vec3::new(yaw.cos(), 0.0, -yaw.sin());
                let (eye, look) = if pb.args.camera == "pov" {
                    (
                        pos + Vec3::Y * 1.45,
                        pos + fwd * 12.0 + Vec3::Y * (1.2 - 1.45) * 0.35,
                    )
                } else {
                    (
                        pos - fwd * pb.args.chase_dist + Vec3::Y * pb.args.chase_height,
                        pos + fwd * 8.0,
                    )
                };
                cam.translation = eye;
                cam.look_at(look, Vec3::Y);
                *cam_pose = CameraPose {
                    eye: [f64::from(eye.x), f64::from(eye.y), f64::from(eye.z)],
                    target: [f64::from(look.x), f64::from(look.y), f64::from(look.z)],
                };
            }
        }
    }
    // Dashcam POV hides the ego body so the windshield view is unobstructed.
    if pb.args.camera == "pov" {
        for (_, root, _, mut visibility) in roots.iter_mut() {
            if root.id == "ego" {
                *visibility = Visibility::Hidden;
            }
        }
    }

    cursor.frame_to_tick.insert(global_frame.0 + 1, frame_idx);
    cursor.awaiting += 1;
    cursor.next_frame += 1;
}

fn debug_mv_visibility(
    q: Query<(&MvClone, &ViewVisibility, &InheritedVisibility, &GlobalTransform), ()>,
    registry: Res<ActorRegistry>,
    frame: Res<GlobalFrame>,
) {
    if std::env::var("SCEN_DEBUG_PASSES").is_ok() && frame.0 > 0 && frame.0 < 30 {
        let total = q.iter().count();
        let vis = q.iter().filter(|(_, v, _, _)| v.get()).count();
        eprintln!("MVCLONES total={total} view_visible={vis} registry={}", registry.mv_clones.len());
        for (_, v, i, t) in q.iter().take(2) {
            eprintln!("  vv={} inh={} t={:?}", v.get(), i.get(), t.translation());
        }
    }
}
/// Frame ticking waits `--settle-ms` of wall-clock time after the scene
/// reports ready before counting, so lazy GLB/veg uploads land before tick 0.
fn bump_frame(pb: Res<Playback>, mut frame: ResMut<GlobalFrame>, readiness: Res<Readiness>) {
    if std::env::var("SCEN_DEBUG_PASSES").is_ok() && frame.0 < 5 {
        eprintln!("bump ready={} frame={}", readiness.actors_spawned, frame.0);
    }
    let settled = readiness
        .build_ready_at
        .map(|t| t.elapsed().as_millis() as i64 >= pb.args.settle_ms.max(0))
        .unwrap_or(false);
    if settled && readiness.actors_spawned {
        frame.0 += 1;
    }
}

fn expected_keys(pb: &PlaybackArgs) -> Vec<String> {
    let mut keys = vec!["rgb".to_string(), "id".to_string()];
    if pb.mv {
        keys.push("mv".into());
    }
    keys
}

fn collect_passes(
    receiver: Res<MainReceiver>,
    pb: Res<Playback>,
    cam_pose: Res<CameraPose>,
    mut cursor: ResMut<PlayCursor>,
    mut metrics: ResMut<Metrics>,
    mut exit: MessageWriter<AppExit>,
    profile: Res<RenderProfile>,
) {
    let mut latest: HashMap<String, SentPass> = HashMap::new();
    while let Ok(p) = receiver.try_recv() {
        latest.insert(p.key.clone(), p);
    }
    if latest.is_empty() {
        return;
    }


    let expected = expected_keys(&pb.args);
    if std::env::var("SCEN_DEBUG_PASSES").is_ok() {
        eprintln!(
            "expected={:?} keys={:?} stamps={:?} cursor_frames={:?}",
            expected,
            latest.keys().collect::<Vec<_>>(),
            latest.values().map(|p| p.frame).collect::<Vec<_>>(),
            cursor.frame_to_tick.len()
        );
    }
    let active_frames: HashMap<u64, usize> = cursor
        .frame_to_tick
        .iter()
        .filter(|(f, _)| **f >= u64::from(pb.args.warmup))
        .map(|(f, t)| (*f, *t))
        .collect();
    if active_frames.is_empty() {
        return;
    }

    let mut by_frame: HashMap<u64, Vec<&SentPass>> = HashMap::new();
    for p in latest.values() {
        if let Some(tick) = active_frames.get(&p.frame) {
            by_frame.entry(p.frame).or_default().push(p);
            let _ = tick;
        }
    }
    let mut done_frames: Vec<u64> = by_frame
        .iter()
        .filter(|(_, v)| v.len() == expected.len())
        .map(|(k, _)| *k)
        .collect();
    done_frames.sort_unstable();

    for f in done_frames {
        let passes = &by_frame[&f];
        let tick = active_frames[&f];
        let now = Instant::now();
        if metrics.capture_start.is_none() {
            metrics.capture_start = Some(now);
        } else if let Some(last) = metrics.last_capture_at {
            metrics.frame_period_ms.push(now.duration_since(last).as_secs_f64() * 1000.0);
        }
        metrics.last_capture_at = Some(now);
        metrics.readback_us_total += passes.iter().map(|p| p.readback_us).sum::<u64>();
        metrics.captured += 1;

        let w = pb.args.width as usize;
        let h = pb.args.height as usize;
        let mut id_bytes: Option<Vec<u8>> = None;
        let mut mv_bytes: Option<Vec<u8>> = None;
        for p in passes.iter() {
            match p.key.as_str() {
                "rgb" => {
                    let mut raw = readback::strip_padding(&p.data, w, h, 4);
                    if *profile == RenderProfile::Cinematic && pb.args.grain > 0.0 {
                        apply_cpu_grain(&mut raw, w, h, pb.args.grain, tick as f32);
                    }
                    let img = image::RgbaImage::from_raw(w as u32, h as u32, raw).expect("rgba");
                    img.save(frame_path(&pb.args.out_dir, tick, "rgb.png")).expect("save rgb");
                }
                "id" => {
                    let raw = readback::strip_padding(&p.data, w, h, 4);
                    let img = image::RgbaImage::from_raw(w as u32, h as u32, raw.clone()).expect("rgba");
                    img.save(frame_path(&pb.args.out_dir, tick, "id.png")).expect("save id");
                    id_bytes = Some(raw);
                }
                "mv" => {
                    let raw = readback::strip_padding(&p.data, w, h, 4);
                    std::fs::write(frame_path(&pb.args.out_dir, tick, "mv.f32.bin"), &raw)
                        .expect("write mv bin");
                    mv_bytes = Some(raw);
                }
                _ => {}
            }
        }
        if pb.args.mv && pb.args.validate_mv_actor.is_some() {
            validate_motion_vectors(
                &pb,
                &cam_pose,
                &mut metrics,
                tick,
                id_bytes.take(),
                mv_bytes.take(),
                w,
                h,
            );
        }

        cursor.frame_to_tick.remove(&f);
        cursor.awaiting = cursor.awaiting.saturating_sub(1);
        if metrics.captured == u64::from(pb.n_ticks) {
            write_outputs(&pb.args, &metrics);
            exit.write(AppExit::Success);
            return;
        }
    }
}

fn frame_path(out_dir: &str, tick: usize, suffix: &str) -> String {
    format!("{out_dir}/frame-{tick:04}.{suffix}")
}

/// Finite-difference validation: compare the MV G-buffer inside the actor's
/// ID mask against screen-space finite differences of GT transforms.
#[allow(clippy::too_many_arguments)]
fn validate_motion_vectors(
    pb: &Res<Playback>,
    cam_pose: &CameraPose,
    metrics: &mut Metrics,
    tick: usize,
    id_bytes: Option<Vec<u8>>,
    mv_bytes: Option<Vec<u8>>,
    w: usize,
    h: usize,
) {
    let (Some(id_now), Some(mv_now)) = (id_bytes, mv_bytes) else {
        return;
    };
    let actor_id = pb.args.validate_mv_actor.clone().unwrap();
    if let Some((prev_tick, id_prev, mv_prev)) = metrics.prev_pass.take() {
        let Some(desc) = pb.state.actors.iter().find(|a| a.id == actor_id) else {
            return;
        };
        let instance_id = instance_id_for(&pb.state.actors, &desc.id);
        let mask: Vec<usize> = id_now
            .chunks_exact(4)
            .enumerate()
            .filter(|(_, px)| {
                let v = u32::from_le_bytes([px[0], px[1], px[2], 0]);
                v == u32::from(instance_id)
            })
            .map(|(i, _)| i)
            .collect();
        if mask.len() < 16 {
            return;
        }
        let mv_prev_px = decode_rg16f(&mv_prev, w, h);
        let vel = decode_rg16f(&mv_now, w, h);
        let mut xs = Vec::with_capacity(mask.len());
        let mut ys = Vec::with_capacity(mask.len());
        for &i in &mask {
            let [vx, vy] = vel[i];
            xs.push(vx * (w as f32) / 2.0);
            ys.push(-vy * (h as f32) / 2.0); // image-space y down
        }
        xs.sort_by(|a, b| a.partial_cmp(b).unwrap());
        ys.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let med = |v: &[f32]| v[v.len() / 2];

        // GT: finite difference of projected centres between the two ticks.
        let center_at = |tick_idx: usize| -> Option<[f64; 2]> {
            let frame = pb.state.frames.get(tick_idx)?;
            let rec = frame.actors.iter().find(|r| r.id == actor_id)?;
            Some(project_with_camera(
                [rec.position[0], pb.args.ground_y as f64, rec.position[2]],
                cam_pose.eye,
                cam_pose.target,
                pb.args.fov as f64,
                pb.args.width as f64,
                pb.args.height as f64,
            ))
        };
        if let (Some(c_now), Some(c_prev)) = (center_at(tick), center_at(prev_tick)) {
            let gt_dx = c_now[0] - c_prev[0];
            let gt_dy = c_now[1] - c_prev[1];
            let err_x = (med(&xs) - gt_dx as f32).abs();
            let err_y = (med(&ys) - gt_dy as f32).abs();
            metrics.mv_validation.push(json!({
                "tick": tick,
                "maskPixels": mask.len(),
                "mvMedianPx": [med(&xs), med(&ys)],
                "gtFiniteDiffPx": [gt_dx, gt_dy],
                "errPx": [err_x, err_y],
            }));
        }
    }
    metrics.prev_pass = Some((tick, id_now, mv_now));
}

fn instance_id_for(actors: &[ActorDesc], id: &str) -> u32 {
    let mut sorted: Vec<&ActorDesc> = actors.iter().collect();
    sorted.sort_by(|a, b| a.id.cmp(&b.id));
    ACTOR_ID_BASE
        + sorted
            .iter()
            .position(|a| a.id == id)
            .expect("known actor") as u32
}

/// Current camera pose mirrored to CPU space for GT projection.
#[derive(Resource, Clone, Copy)]
pub struct CameraPose {
    pub eye: [f64; 3],
    pub target: [f64; 3],
}

/// Pinhole projection into continuous pixel coordinates ([0,w]×[0,h]),
/// mirroring the camera convention used by `Transform::look_at`.
fn project_with_camera(
    p: [f64; 3],
    eye: [f64; 3],
    target: [f64; 3],
    fov_deg: f64,
    w: f64,
    h: f64,
) -> [f64; 2] {
    let tan_half = (fov_deg.to_radians() / 2.0).tan();
    // Forward is (target - eye) normalized; right = fwd × up.
    let sub = |a: [f64; 3], b: [f64; 3]| [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
    let norm = |a: [f64; 3]| {
        let l = (a[0] * a[0] + a[1] * a[1] + a[2] * a[2]).sqrt();
        [a[0] / l, a[1] / l, a[2] / l]
    };
    let dot = |a: [f64; 3], b: [f64; 3]| a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    let cross = |a: [f64; 3], b: [f64; 3]| {
        [
            a[1] * b[2] - a[2] * b[1],
            a[2] * b[0] - a[0] * b[2],
            a[0] * b[1] - a[1] * b[0],
        ]
    };
    let fwd = norm(sub(target, eye));
    let right = norm(cross(fwd, [0.0, 1.0, 0.0]));
    let up = cross(right, fwd);
    let d = sub(p, eye);
    let dz = dot(d, fwd);
    let ndc_x = dot(d, right) / dz / (tan_half * w / h);
    let ndc_y = dot(d, up) / dz / tan_half;
    [(ndc_x + 1.0) / 2.0 * w, (1.0 - ndc_y) / 2.0 * h]
}

fn write_outputs(args: &PlaybackArgs, metrics: &Metrics) {
    let periods = &metrics.frame_period_ms;
    let avg = if periods.is_empty() {
        0.0
    } else {
        periods.iter().sum::<f64>() / periods.len() as f64
    };
    let mut sorted = periods.clone();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let pct = |p: f64| -> f64 {
        if sorted.is_empty() {
            0.0
        } else {
            sorted[((sorted.len() - 1) as f64 * p) as usize]
        }
    };
    let report = json!({
        "width": args.width,
        "height": args.height,
        "passes": expected_keys(args),
        "ticks": metrics.captured,
        "avg_frame_ms": avg,
        "p50_frame_ms": pct(0.5),
        "p99_frame_ms": pct(0.99),
        "fps": if avg > 0.0 { 1000.0 / avg } else { 0.0 },
        "readback_us_per_triple_avg": if metrics.captured > 0 {
            metrics.readback_us_total as f64 / metrics.captured as f64
        } else {
            0.0
        },
    });
    std::fs::write(
        Path::new(&args.out_dir).join("timings.json"),
        serde_json::to_string_pretty(&report).unwrap(),
    )
    .expect("write timings");

    if !metrics.mv_validation.is_empty() {
        let errs: Vec<f64> = metrics
            .mv_validation
            .iter()
            .map(|v| {
                let e = v["errPx"].as_array().unwrap();
                (e[0].as_f64().unwrap().powi(2) + e[1].as_f64().unwrap().powi(2)).sqrt()
            })
            .collect();
        let summary = json!({
            "actor": args.validate_mv_actor,
            "ticksValidated": errs.len(),
            "maxErrPx": errs.iter().cloned().fold(0.0, f64::max),
            "meanErrPx": if errs.is_empty() { 0.0 } else { errs.iter().sum::<f64>() / errs.len() as f64 },
            "perTick": metrics.mv_validation,
        });
        std::fs::write(
            Path::new(&args.out_dir).join("mv-validation.json"),
            serde_json::to_string_pretty(&summary).unwrap(),
        )
        .expect("write mv validation");
    }
    println!("PLAYBACK {}", report);
}

// ---------------------------------------------------------------------------
// WSB4 realism-stack weather systems
// ---------------------------------------------------------------------------

#[derive(Resource, Default)]
struct WetnessApplied(bool);

/// Fog needs the sun to be a volumetric light for visible shafts.
fn attach_fog_sun(
    weather: Res<Weather>,
    suns: Query<Entity, (With<DirectionalLight>, With<lighting::VolumetricLightMarker>)>,
    mut commands: Commands,
) {
    if *weather != Weather::Fog {
        return;
    }
    for e in &suns {
        commands.entity(e).insert(bevy::light::VolumetricLight);
    }
}

/// Rain: apply the wet-road reflectance ramp once the scene is spawned.
#[allow(clippy::type_complexity)]
fn apply_wetness_once(
    weather: Res<Weather>,
    readiness: Res<Readiness>,
    mut wet: ResMut<WetnessApplied>,
    mut meshes_q: Query<
        (
            Entity,
            Option<&Name>,
            Option<&ChildOf>,
            &Mesh3d,
            &MeshMaterial3d<StandardMaterial>,
        ),
    >,
    names_q: Query<&Name>,
    mut materials: ResMut<Assets<StandardMaterial>>,
) {
    if wet.0 || *weather != Weather::Rain {
        return;
    }
    if readiness.build_ready_at.is_none() {
        return;
    }
    let touched = weather_mod::apply_wetness(1.0, &mut meshes_q, &names_q, &mut materials);
    println!("WETNESS applied to {touched} road material(s)");
    wet.0 = true;
}
