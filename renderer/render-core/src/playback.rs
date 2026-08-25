//! Trace playback: scene-state.v1 → per-tick rendering.
//!
//! Loads corpus GLB tiles, spawns catalog-bound actor visuals driven by the
//! scene-state document — vehicles-carla GLB models when a models dir is
//! supplied (instanced meshes, `body_paint` tint, wheel-spin nodes), the
//! procedural primitive parts otherwise — plus contract-parity vehicle
//! lights (emissive lenses + bounded projected beams) and contact shadows,
//! renders RGB + instance-ID (+ optional motion-vector G-buffer) per tick at
//! the requested resolution with GPU→CPU readback, and writes frames plus
//! timings (+ legend, + MV validation report, + actor-visuals report).

use crate::actor_lights::{
    beacon_blue_on, beacon_red_on, beam_aim, beam_source, derive_vehicle_light_states,
    emergency_lens, headlight_lens, indicator_lens, indicator_on, is_vehicle_class,
    reverse_lens, tail_lens, LensBox, LightInput, RenderCues, VehicleLightState,
    PROJECTED_HEADLIGHT_LIMIT,
};
use crate::catalog::{actor_body_color, actor_dims, actor_parts, ActorPartKind};
use crate::motion_vector::{decode_rg16f, MotionVectorMaterial};
use crate::readback::{
    self, Copiers, GlobalFrame, MainReceiver, PassCopier, SentPass,
};
use crate::scene_state::{ActorDesc, ActorTickKind, SceneState};
use crate::vehicle_model::{VehicleModelCatalog, VehicleModelEntry};
use anyhow::{bail, Result};
use bevy::app::{AppExit, ScheduleRunnerPlugin};
use bevy::asset::AssetPlugin;
use bevy::camera::visibility::RenderLayers;
use bevy::camera::RenderTarget;
use bevy::core_pipeline::tonemapping::Tonemapping;
use bevy::asset::RenderAssetUsages;
use bevy::gltf::{Gltf, GltfMaterial, GltfMesh, GltfNode};
use bevy::light::{DirectionalLight, DirectionalLightShadowMap, NotShadowCaster, SpotLight};
use bevy::log::LogPlugin;
use bevy::math::Affine3A;
use bevy::pbr::PreviousGlobalTransform;
use bevy::prelude::*;
use bevy::render::render_resource::{
    CommandEncoderDescriptor, Extent3d, TextureDimension, TextureFormat, TextureUsages,
};
use bevy::render::renderer::{RenderContext, RenderDevice};
use bevy::world_serialization::{WorldAssetRoot, WorldInstance, WorldInstanceSpawner};
use bevy::window::ExitCondition;
use clap::Parser;
use serde_json::json;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

/// Instance IDs for actors start here; tiles occupy 1..=N below the band.
pub const ACTOR_ID_BASE: u32 = 1_000_000;

#[derive(Parser, Debug, Clone)]
pub struct PlaybackArgs {
    /// Corpus GLB tiles (absolute paths), comma-separated. May be empty for
    /// tile-less runs (see `--ground-plane`).
    #[arg(long, value_delimiter = ',')]
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
    /// Road-surface elevation for actor origins (traces are heightless).
    #[arg(long, default_value_t = 12.99)]
    pub ground_y: f32,
    /// `static` fixes the camera at the initial chase pose; `follow` tracks ego.
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
    /// After playback, numerically validate MV against finite differences of
    /// GT transforms for this actor id (requires --mv).
    #[arg(long)]
    pub validate_mv_actor: Option<String>,
    /// Output directory for frames + reports.
    #[arg(long)]
    pub out_dir: String,
    /// Vehicles-carla style models directory (catalog-models.json or
    /// manifest.json + models/*.glb). Without it every actor uses the
    /// procedural primitive parts.
    #[arg(long)]
    pub vehicle_models: Option<PathBuf>,
    /// JSON `{ "<actorId>": {headlights?, emergency?, indicator?,
    /// reversing?} }` — the parity fixture's `renderCues` shape.
    #[arg(long)]
    pub render_cues: Option<PathBuf>,
    /// Environment low-beam default: `auto` derives from the document's
    /// timeOfDay (dark before 06:00 / after 19:00), or force `on`/`off`.
    #[arg(long, default_value = "auto")]
    pub low_beams: String,
    /// Spawn a flat ground plane at --ground-y (for tile-less runs).
    #[arg(long, default_value_t = false)]
    pub ground_plane: bool,
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

/// Wheel node: spins about local Z from the actor's accumulated travel.
#[derive(Component)]
struct WheelSpin {
    actor: String,
    base: Transform,
    radius: f32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LensKind {
    LowBeam,
    Tail,
    Reverse,
    EmergencyRed,
    EmergencyBlue,
    IndicatorLeft,
    IndicatorRight,
}

/// Emissive light lens riding an actor root.
#[derive(Component)]
struct LensMarker {
    actor: String,
    kind: LensKind,
}

/// One slot of the bounded projected-headlight pool (contract limit 8).
#[derive(Component)]
struct BeamSlot(usize);

/// Playback render cues keyed by actor id (fixture `renderCues` shape).
#[derive(Resource, Default)]
struct Cues(HashMap<String, RenderCues>);

/// Environment-driven low-beam default (authored darkness).
#[derive(Resource)]
struct GlobalLowBeams(bool);

/// Scene-state frame applied this Update, for the visual-state pass.
#[derive(Resource, Default)]
struct VisualTick(Option<usize>);

/// Shared handles for lenses, contact shadows and the ground plane.
#[derive(Resource)]
struct ActorVisualAssets {
    unit_cube: Handle<Mesh>,
    shadow_mesh: Handle<Mesh>,
    shadow_mat: Handle<StandardMaterial>,
    lens_low_beam: Handle<StandardMaterial>,
    lens_tail: Handle<StandardMaterial>,
    lens_reverse: Handle<StandardMaterial>,
    lens_emergency_red: Handle<StandardMaterial>,
    lens_emergency_blue: Handle<StandardMaterial>,
    lens_indicator: Handle<StandardMaterial>,
}

/// One spawnable part of a vehicles-carla GLB model.
#[derive(Clone)]
struct ModelPart {
    name: String,
    mesh: Handle<Mesh>,
    material: Handle<StandardMaterial>,
    material_name: Option<String>,
    transform: Transform,
    wheel_radius: Option<f32>,
}

/// A fully-resolved GLB model ready to instance per actor.
struct ModelRecipe {
    parts: Vec<ModelPart>,
    tintable: bool,
    scale_to_dims: bool,
    model_length_m: Option<f64>,
    attribution: String,
    source: String,
    glb: String,
}

#[derive(Resource, Default)]
struct VehicleModels {
    /// (catalog id, asset path, gltf handle, entry) still resolving.
    loading: Vec<(String, String, Handle<Gltf>, VehicleModelEntry)>,
    /// Entries resolved in `run()` before the app boots.
    pending: Vec<(String, VehicleModelEntry)>,
    recipes: HashMap<String, ModelRecipe>,
    ready: bool,
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
    /// Accumulated travel distance per actor (m), from per-tick |velocity|·dt
    /// — the deterministic wheel-spin clock (never the wall clock).
    travel: HashMap<String, f64>,
    /// Primitive part prototypes shared across same-shape actors:
    /// key = class|dims, value = (bare name, mesh, offset, kind).
    prim_protos: HashMap<String, Vec<(String, Handle<Mesh>, Transform, ActorPartKind)>>,
    /// Lit materials shared by colour.
    shared_materials: HashMap<String, Handle<StandardMaterial>>,
    /// `body_paint` tints shared per (catalog id, colour).
    tinted_materials: HashMap<String, Handle<StandardMaterial>>,
    /// Per-catalog-id instancing evidence: actor count + unique mesh assets.
    model_stats: HashMap<String, (usize, HashSet<AssetId<Mesh>>)>,
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
    let doc = SceneState::load(&path)?;
    if doc.version != crate::scene_state::SCENE_STATE_VERSION {
        bail!("unsupported scene-state version {}", doc.version);
    }
    let n_ticks = args.ticks.unwrap_or(120).min(doc.frames.len() as u32).max(1);
    if !args.glbs.iter().all(|g| Path::new(g).is_absolute()) {
        bail!("glb paths must be absolute");
    }
    if args.validate_mv_actor.is_some() && args.camera != "static" {
        bail!("--validate-mv-actor requires --camera static (the v1 MV pass isolates object motion)");
    }

    // Environment low-beam default (authored darkness) — `auto` derives
    // from the document's timeOfDay.
    let global_low_beams = match args.low_beams.as_str() {
        "on" => true,
        "off" => false,
        "auto" => doc.time_of_day < 6.0 || doc.time_of_day >= 19.0,
        other => bail!("--low-beams must be auto|on|off, got {other}"),
    };

    // Playback cues (the parity fixture's renderCues shape).
    let cues: HashMap<String, RenderCues> = match &args.render_cues {
        Some(path) => serde_json::from_slice(&std::fs::read(path)?)?,
        None => HashMap::new(),
    };

    // Resolve vehicles-carla models for the catalog ids in this document.
    let mut pending_models: Vec<(String, VehicleModelEntry)> = Vec::new();
    if let Some(dir) = &args.vehicle_models {
        let catalog = VehicleModelCatalog::load(dir)?;
        let mut seen = HashSet::new();
        for desc in &doc.actors {
            if !is_vehicle_class(&desc.actor_class) || !seen.insert(desc.catalog_id.clone()) {
                continue;
            }
            if let Some(entry) = catalog.resolve(&desc.catalog_id) {
                if entry.glb_path.is_file() {
                    pending_models.push((desc.catalog_id.clone(), entry.clone()));
                } else {
                    eprintln!(
                        "vehicle model for {} missing on disk: {} (primitive fallback)",
                        desc.catalog_id,
                        entry.glb_path.display()
                    );
                }
            }
        }
    }
    std::env::set_var("BEVY_ASSET_ROOT", "/");
    std::fs::create_dir_all(&args.out_dir)?;

    let playback = Playback {
        state: std::sync::Arc::new(doc),
        n_ticks,
        args: args.clone(),
    };

    let clear = if global_low_beams {
        // Authored darkness: deep dusk sky instead of the daylight blue.
        Color::srgb(0.05, 0.07, 0.12)
    } else {
        Color::srgb(0.53, 0.74, 0.92)
    };
    let mut app = App::new();
    app.insert_resource(ClearColor(clear))
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
                // Playback is a finite headless process. Compile synchronously so no
                // pipeline task can outlive the wgpu device during process teardown.
                .set(bevy::render::RenderPlugin {
                    synchronous_pipeline_compilation: true,
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
        .insert_resource(Cues(cues))
        .insert_resource(GlobalLowBeams(global_low_beams))
        .insert_resource(VisualTick::default())
        .insert_resource(VehicleModels {
            pending: pending_models,
            ..default()
        })
        .insert_resource(CameraPose {
            eye: [0.0; 3],
            target: [0.0; 3],
        })
        .init_resource::<GlobalFrame>()
        .add_systems(Startup, startup_setup)
        .add_systems(
            Update,
            (
                check_assets,
                prepare_vehicle_models,
                poll_roots,
                on_scene_ready,
                apply_tick,
                update_actor_visuals,
                bump_frame,
            )
                .chain(),
        )
        .add_systems(PostUpdate, (debug_mv_visibility, collect_passes));

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

#[allow(clippy::too_many_arguments)]
fn startup_setup(
    mut commands: Commands,
    pb: Res<Playback>,
    mut cam_pose: ResMut<CameraPose>,
    mut images: ResMut<Assets<Image>>,
    device: Res<RenderDevice>,
    server: Res<AssetServer>,
    mut meshes: ResMut<Assets<Mesh>>,
    mut materials: ResMut<Assets<StandardMaterial>>,
    mut models: ResMut<VehicleModels>,
    low_beams: Res<GlobalLowBeams>,
) {
    // Authored darkness dims the fixed sun to deep dusk so emissive lenses
    // and projected beams read in captures.
    let sun_lux = if low_beams.0 { 400.0 } else { 28_000.0 };
    commands.spawn((
        DirectionalLight {
            illuminance: sun_lux,
            shadow_maps_enabled: true,
            ..default()
        },
        bevy::light::CascadeShadowConfigBuilder {
            minimum_distance: 1.0,
            maximum_distance: 400.0,
            num_cascades: 4,
            ..default()
        }
        .build(),
        Transform::IDENTITY.looking_to(sun_direction(38.0, 145.0), Vec3::Y),
    ));

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
    *cam_pose = CameraPose {
        eye: [f64::from(eye.x), f64::from(eye.y), f64::from(eye.z)],
        target: [f64::from(target.x), f64::from(target.y), f64::from(target.z)],
    };

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
    commands.spawn((
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
    ));

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

    for (i, g) in pb.args.glbs.iter().enumerate() {
        let path = g.trim_start_matches('/').to_owned();
        let handle: Handle<Gltf> = server.load(path);
        commands.spawn(TileLoad { handle, index: i });
    }
    // --- shared actor visual assets (lenses, contact shadows, beams) -----
    let visual = ActorVisualAssets {
        unit_cube: meshes.add(Mesh::from(bevy::math::primitives::Cuboid::new(1.0, 1.0, 1.0))),
        shadow_mesh: meshes.add(Mesh::from(bevy::math::primitives::Plane3d {
            normal: Dir3::Y,
            half_size: Vec2::splat(0.5),
        })),
        shadow_mat: materials.add(StandardMaterial {
            base_color_texture: Some(images.add(contact_shadow_image())),
            base_color: Color::WHITE,
            unlit: true,
            alpha_mode: AlphaMode::Blend,
            ..default()
        }),
        lens_low_beam: materials.add(StandardMaterial {
            base_color: Color::srgb_u8(0xff, 0xf4, 0xd6),
            emissive: Color::srgb_u8(0xff, 0xd8, 0x9a).to_linear() * 4.0,
            ..default()
        }),
        lens_tail: materials.add(StandardMaterial {
            base_color: Color::srgb_u8(0x6a, 0x0c, 0x0c),
            emissive: Color::srgb_u8(0xff, 0x2a, 0x2a).to_linear() * 2.0,
            ..default()
        }),
        lens_reverse: materials.add(StandardMaterial {
            base_color: Color::srgb_u8(0xf4, 0xf8, 0xff),
            emissive: Color::srgb_u8(0xc9, 0xdc, 0xff).to_linear() * 2.2,
            ..default()
        }),
        lens_emergency_red: materials.add(StandardMaterial {
            base_color: Color::srgb_u8(0xff, 0x2f, 0x38),
            emissive: Color::srgb_u8(0xff, 0x2f, 0x38).to_linear() * 6.0,
            unlit: true,
            ..default()
        }),
        lens_emergency_blue: materials.add(StandardMaterial {
            base_color: Color::srgb_u8(0x27, 0x86, 0xff),
            emissive: Color::srgb_u8(0x27, 0x86, 0xff).to_linear() * 6.0,
            unlit: true,
            ..default()
        }),
        lens_indicator: materials.add(StandardMaterial {
            base_color: Color::srgb_u8(0xff, 0xa2, 0x1a),
            emissive: Color::srgb_u8(0xff, 0xa2, 0x1a).to_linear() * 4.0,
            unlit: true,
            ..default()
        }),
    };

    // Optional ground plane for tile-less runs.
    if pb.args.ground_plane {
        let plane = meshes.add(Mesh::from(bevy::math::primitives::Plane3d {
            normal: Dir3::Y,
            half_size: Vec2::splat(600.0),
        }));
        let mat = materials.add(StandardMaterial {
            base_color: Color::srgb(0.34, 0.35, 0.37),
            perceptual_roughness: 0.95,
            ..default()
        });
        commands.spawn((
            Mesh3d(plane),
            MeshMaterial3d(mat),
            Transform::from_xyz(0.0, pb.args.ground_y, 0.0),
            RenderLayers::layer(0),
        ));
    }

    commands.insert_resource(visual);

    // Bounded projected-headlight pool (contract limit, ascending actor id).
    for slot in 0..PROJECTED_HEADLIGHT_LIMIT {
        commands.spawn((
            BeamSlot(slot),
            SpotLight {
                color: Color::srgb_u8(0xff, 0xe0, 0xad),
                intensity: 1_500_000.0,
                range: 42.0,
                radius: 0.05,
                outer_angle: 0.38,
                inner_angle: 0.38 * (1.0 - 0.62),
                shadow_maps_enabled: false,
                ..default()
            },
            Transform::IDENTITY,
            Visibility::Hidden,
        ));
    }

    // Kick off the vehicles-carla GLB loads resolved in run().
    for (catalog_id, entry) in std::mem::take(&mut models.pending) {
        let asset_path = entry
            .glb_path
            .to_string_lossy()
            .trim_start_matches('/')
            .to_owned();
        let handle: Handle<Gltf> = server.load(asset_path.clone());
        models
            .loading
            .push((catalog_id, asset_path, handle, entry));
    }
}

/// Soft radial dark blob for the contact shadow (the viewer bakes the same
/// gradient into a canvas texture; opacity 0.55 at the core).
fn contact_shadow_image() -> Image {
    const N: usize = 128;
    let mut data = vec![0u8; N * N * 4];
    for y in 0..N {
        for x in 0..N {
            let dx = (x as f32 + 0.5) / N as f32 * 2.0 - 1.0;
            let dy = (y as f32 + 0.5) / N as f32 * 2.0 - 1.0;
            let d = (dx * dx + dy * dy).sqrt();
            // Smooth falloff from the core to the rim.
            let t = ((d - 0.25) / 0.75).clamp(0.0, 1.0);
            let fall = 1.0 - t * t * (3.0 - 2.0 * t);
            let a = (fall * 0.55 * 255.0) as u8;
            let i = (y * N + x) * 4;
            data[i..i + 4].copy_from_slice(&[0, 0, 0, a]);
        }
    }
    Image::new(
        Extent3d {
            width: N as u32,
            height: N as u32,
            depth_or_array_layers: 1,
        },
        TextureDimension::D2,
        data,
        TextureFormat::Rgba8UnormSrgb,
        RenderAssetUsages::RENDER_WORLD,
    )
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

/// Resolve every requested vehicles-carla GLB into a spawnable
/// [`ModelRecipe`]: shared mesh handles per primitive, loader-built
/// `StandardMaterial` handles (the `Material{N}/std` labeled subassets),
/// material names for the `body_paint` tint slot, and wheel nodes with their
/// spin radius. Retries every frame until all subassets are resident.
fn prepare_vehicle_models(
    mut models: ResMut<VehicleModels>,
    gltfs: Res<Assets<Gltf>>,
    gltf_meshes: Res<Assets<GltfMesh>>,
    gltf_nodes: Res<Assets<GltfNode>>,
    materials: Res<Assets<StandardMaterial>>,
    server: Res<AssetServer>,
) {
    if models.ready {
        return;
    }
    let mut still = Vec::new();
    for (catalog_id, asset_path, handle, entry) in std::mem::take(&mut models.loading) {
        match build_model_recipe(
            &asset_path,
            &handle,
            &entry,
            &gltfs,
            &gltf_meshes,
            &gltf_nodes,
            &materials,
            &server,
        ) {
            Some(recipe) => {
                models.recipes.insert(catalog_id, recipe);
            }
            None => still.push((catalog_id, asset_path, handle, entry)),
        }
    }
    models.loading = still;
    if models.loading.is_empty() {
        models.ready = true;
    }
}

#[allow(clippy::too_many_arguments)]
fn build_model_recipe(
    asset_path: &str,
    handle: &Handle<Gltf>,
    entry: &VehicleModelEntry,
    gltfs: &Assets<Gltf>,
    gltf_meshes: &Assets<GltfMesh>,
    gltf_nodes: &Assets<GltfNode>,
    materials: &Assets<StandardMaterial>,
    server: &AssetServer,
) -> Option<ModelRecipe> {
    let gltf = gltfs.get(handle)?;

    // GltfMaterial handle -> authored name (the tint contract keys on the
    // material NAME, per catalog/vehicles-carla/CONVENTIONS.md).
    let mut names: HashMap<AssetId<GltfMaterial>, String> = HashMap::new();
    for (name, mat) in &gltf.named_materials {
        names.insert(mat.id(), name.to_string());
    }
    // Loader-built StandardMaterials are the `Material{N}/std` subassets.
    let mut std_handles: Vec<Handle<StandardMaterial>> = Vec::new();
    for idx in 0..gltf.materials.len() {
        let h: Handle<StandardMaterial> =
            server.load(format!("{asset_path}#Material{idx}/std"));
        materials.get(&h)?; // not resident yet -> retry next frame
        std_handles.push(h);
    }
    let default_std: Handle<StandardMaterial> =
        server.load(format!("{asset_path}#DefaultMaterial/std"));

    // Node hierarchy: roots are nodes never referenced as children.
    let mut child_ids: HashSet<AssetId<GltfNode>> = HashSet::new();
    for node_handle in &gltf.nodes {
        let node = gltf_nodes.get(node_handle)?;
        for child in &node.children {
            child_ids.insert(child.id());
        }
    }

    let mut parts: Vec<ModelPart> = Vec::new();
    let mut stack: Vec<(Handle<GltfNode>, Transform)> = gltf
        .nodes
        .iter()
        .filter(|n| !child_ids.contains(&n.id()))
        .map(|n| (n.clone(), Transform::IDENTITY))
        .collect();
    while let Some((node_handle, parent_tf)) = stack.pop() {
        let node = gltf_nodes.get(&node_handle)?;
        let tf = parent_tf.mul_transform(node.transform);
        for child in &node.children {
            stack.push((child.clone(), tf));
        }
        let Some(mesh_handle) = &node.mesh else {
            continue;
        };
        let gltf_mesh = gltf_meshes.get(mesh_handle)?;
        // Wheel nodes spin about local Z; node origin = wheel centre, so the
        // centre height doubles as the rolling radius.
        let wheel_radius = node
            .name
            .to_ascii_lowercase()
            .starts_with("wheel")
            .then(|| tf.translation.y.max(0.05));
        for prim in &gltf_mesh.primitives {
            let (material, material_name) = match &prim.material {
                Some(mat) => {
                    let idx = gltf.materials.iter().position(|m| m.id() == mat.id())?;
                    (std_handles[idx].clone(), names.get(&mat.id()).cloned())
                }
                None => {
                    materials.get(&default_std)?;
                    (default_std.clone(), None)
                }
            };
            parts.push(ModelPart {
                name: format!("{}#{}", node.name, prim.index),
                mesh: prim.mesh.clone(),
                material,
                material_name,
                transform: tf,
                wheel_radius,
            });
        }
    }
    if parts.is_empty() {
        return None;
    }
    // Deterministic spawn order regardless of traversal.
    parts.sort_by(|a, b| a.name.cmp(&b.name));
    Some(ModelRecipe {
        parts,
        tintable: entry.tintable,
        scale_to_dims: entry.scale_to_dims,
        model_length_m: entry.model_length_m,
        attribution: entry.attribution.clone(),
        source: entry.source.clone(),
        glb: asset_path.to_string(),
    })
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
    models: Res<VehicleModels>,
    visual: Res<ActorVisualAssets>,
) {
    if readiness.build_ready_at.is_none() || readiness.tiles_id_done || !models.ready {
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
                &mut registry, &mut legend, &models, &visual, &rec.id,
            );
        }
    }

    let legend_path = Path::new(&pb.args.out_dir).join("legend.json");
    std::fs::write(&legend_path, serde_json::to_string_pretty(&legend.entries).unwrap())
        .expect("write legend");
    readiness.actors_spawned = true;
    let _ = &cursor; // cursor starts at 0
}

/// Fetch-or-create a shared lit material for a colour (keeps same-colour
/// actors on one material so the renderer batches them).
fn shared_lit_material(
    registry: &mut ActorRegistry,
    materials: &mut Assets<StandardMaterial>,
    color: Color,
) -> Handle<StandardMaterial> {
    let key = format!("{color:?}");
    if let Some(handle) = registry.shared_materials.get(&key) {
        return handle.clone();
    }
    let handle = materials.add(StandardMaterial {
        base_color: color,
        perceptual_roughness: 0.65,
        ..default()
    });
    registry.shared_materials.insert(key, handle.clone());
    handle
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
    models: &VehicleModels,
    visual: &ActorVisualAssets,
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
    let id_mat = materials.add(StandardMaterial {
        base_color: Color::srgb_u8(bytes[0], bytes[1], bytes[2]),
        unlit: true,
        ..default()
    });
    let mv_handle = mv_materials.add(MotionVectorMaterial {});
    let dims = actor_dims(desc);
    let (l, w, h) = (dims.l as f32, dims.w as f32, dims.h as f32);

    let root = commands
        .spawn((
            ActorRoot { id: id.to_string() },
            Visibility::Visible,
            Transform::IDENTITY,
        ))
        .id();

    let mut used_meshes: HashSet<AssetId<Mesh>> = HashSet::new();

    if let Some(recipe) = models.recipes.get(&desc.catalog_id) {
        // --- vehicles-carla GLB path: shared mesh/material handles --------
        let scale = if recipe.scale_to_dims {
            match (recipe.model_length_m, desc.dims) {
                (Some(ml), Some(d)) if ml > 0.1 => (d.l / ml) as f32,
                _ => 1.0,
            }
        } else {
            1.0
        };
        let holder = commands
            .spawn((
                ChildOf(root),
                Transform::from_scale(Vec3::splat(scale)),
                Visibility::Inherited,
            ))
            .id();
        for part in &recipe.parts {
            used_meshes.insert(part.mesh.id());
            let material = if part.material_name.as_deref() == Some("body_paint")
                && recipe.tintable
            {
                // Convention: body_paint ships white; set base_color to the
                // authored tint. One tinted material per (model, colour).
                let color = actor_body_color(desc);
                let key = format!("{}|{color:?}", desc.catalog_id);
                match registry.tinted_materials.get(&key) {
                    Some(handle) => handle.clone(),
                    None => {
                        let mut mat =
                            materials.get(&part.material).cloned().unwrap_or_default();
                        mat.base_color = color;
                        let handle = materials.add(mat);
                        registry.tinted_materials.insert(key, handle.clone());
                        handle
                    }
                }
            } else {
                part.material.clone()
            };
            let mut visible = commands.spawn((
                Mesh3d(part.mesh.clone()),
                MeshMaterial3d(material),
                part.transform,
                ChildOf(holder),
                RenderLayers::layer(0),
            ));
            if let Some(radius) = part.wheel_radius {
                visible.insert(WheelSpin {
                    actor: id.to_string(),
                    base: part.transform,
                    radius,
                });
            }
            let mut clone = commands.spawn((
                IdClone,
                Mesh3d(part.mesh.clone()),
                MeshMaterial3d(id_mat.clone()),
                part.transform,
                ChildOf(holder),
                RenderLayers::layer(1),
            ));
            if let Some(radius) = part.wheel_radius {
                clone.insert(WheelSpin {
                    actor: id.to_string(),
                    base: part.transform,
                    radius,
                });
            }
            if pb.args.mv {
                let offset =
                    Transform::from_scale(Vec3::splat(scale)).mul_transform(part.transform);
                let mv_entity = commands
                    .spawn((
                        MvClone,
                        Mesh3d(part.mesh.clone()),
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
                "name": format!("{}:{}:{}@{:03}", desc.catalog_id, desc.id, part.name, instance_id),
            }));
        }
    } else {
        // --- primitive fallback: prototypes shared across same-shape actors
        let proto_key = format!(
            "{}|{:.0}x{:.0}x{:.0}",
            desc.actor_class,
            dims.l * 1000.0,
            dims.w * 1000.0,
            dims.h * 1000.0
        );
        if !registry.prim_protos.contains_key(&proto_key) {
            let protos = actor_parts(desc)
                .into_iter()
                .map(|p| (p.name, meshes.add(p.mesh), p.offset, p.kind))
                .collect();
            registry.prim_protos.insert(proto_key.clone(), protos);
        }
        let protos = registry.prim_protos[&proto_key].clone();
        let body_mat = shared_lit_material(registry, materials, actor_body_color(desc));
        let wheel_mat =
            shared_lit_material(registry, materials, crate::catalog::WHEEL_COLOR);
        for (name, mesh_h, offset, kind) in protos {
            used_meshes.insert(mesh_h.id());
            let mat = match kind {
                ActorPartKind::Wheel { .. } => wheel_mat.clone(),
                _ => body_mat.clone(),
            };
            let mut visible = commands.spawn((
                Mesh3d(mesh_h.clone()),
                MeshMaterial3d(mat),
                offset,
                ChildOf(root),
                RenderLayers::layer(0),
            ));
            if let ActorPartKind::Wheel { radius } = kind {
                visible.insert(WheelSpin {
                    actor: id.to_string(),
                    base: offset,
                    radius,
                });
            }
            let mut clone = commands.spawn((
                IdClone,
                Mesh3d(mesh_h.clone()),
                MeshMaterial3d(id_mat.clone()),
                offset,
                ChildOf(root),
                RenderLayers::layer(1),
            ));
            if let ActorPartKind::Wheel { radius } = kind {
                clone.insert(WheelSpin {
                    actor: id.to_string(),
                    base: offset,
                    radius,
                });
            }
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
                "name": format!("{}:{}:{}@{:03}", desc.catalog_id, desc.id, name, instance_id),
            }));
        }
    }

    let stats = registry
        .model_stats
        .entry(desc.catalog_id.clone())
        .or_insert_with(|| (0, HashSet::new()));
    stats.0 += 1;
    stats.1.extend(used_meshes);

    // Contact shadow blob under every actor: soft dark quad 6 cm above the
    // ground plane (the viewer's SHADOW_LIFT), footprint-scaled.
    commands.spawn((
        Mesh3d(visual.shadow_mesh.clone()),
        MeshMaterial3d(visual.shadow_mat.clone()),
        Transform {
            translation: Vec3::new(0.0, 0.06, 0.0),
            scale: Vec3::new(l * 1.3, 1.0, w * 1.7),
            ..default()
        },
        ChildOf(root),
        RenderLayers::layer(0),
        NotShadowCaster,
    ));

    // Vehicle light lenses (hidden until the visual-state pass lights them).
    if is_vehicle_class(&desc.actor_class) {
        let lenses: [(LensKind, LensBox); 11] = [
            (LensKind::LowBeam, headlight_lens(l, w, h, -1.0)),
            (LensKind::LowBeam, headlight_lens(l, w, h, 1.0)),
            (LensKind::Tail, tail_lens(l, w, h, -1.0)),
            (LensKind::Tail, tail_lens(l, w, h, 1.0)),
            (LensKind::Reverse, reverse_lens(l, w, h)),
            (LensKind::EmergencyRed, emergency_lens(l, w, h, -1.0)),
            (LensKind::EmergencyBlue, emergency_lens(l, w, h, 1.0)),
            (LensKind::IndicatorLeft, indicator_lens(l, w, h, -1.0, true)),
            (LensKind::IndicatorLeft, indicator_lens(l, w, h, -1.0, false)),
            (LensKind::IndicatorRight, indicator_lens(l, w, h, 1.0, true)),
            (LensKind::IndicatorRight, indicator_lens(l, w, h, 1.0, false)),
        ];
        for (kind, lens) in lenses {
            let mat = match kind {
                LensKind::LowBeam => visual.lens_low_beam.clone(),
                LensKind::Tail => visual.lens_tail.clone(),
                LensKind::Reverse => visual.lens_reverse.clone(),
                LensKind::EmergencyRed => visual.lens_emergency_red.clone(),
                LensKind::EmergencyBlue => visual.lens_emergency_blue.clone(),
                LensKind::IndicatorLeft | LensKind::IndicatorRight => {
                    visual.lens_indicator.clone()
                }
            };
            commands.spawn((
                LensMarker {
                    actor: id.to_string(),
                    kind,
                },
                Mesh3d(visual.unit_cube.clone()),
                MeshMaterial3d(mat),
                Transform {
                    translation: Vec3::from(lens.translation),
                    scale: Vec3::from(lens.scale),
                    ..default()
                },
                ChildOf(root),
                Visibility::Hidden,
                RenderLayers::layer(0),
                NotShadowCaster,
            ));
        }
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
    mut visual_tick: ResMut<VisualTick>,
    models: Res<VehicleModels>,
    visual: Res<ActorVisualAssets>,
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
            &mut registry, &mut legend, &models, &visual, &rec.id,
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

    // Deterministic animation clock: accumulate travel from |velocity|·dt so
    // wheel spin is a pure function of the trace (never the wall clock).
    let dt = pb.state.dt;
    for rec in &frame.actors {
        if rec.kind == ActorTickKind::Despawn {
            continue;
        }
        let speed = (rec.velocity[0] * rec.velocity[0]
            + rec.velocity[1] * rec.velocity[1]
            + rec.velocity[2] * rec.velocity[2])
            .sqrt();
        *registry.travel.entry(rec.id.clone()).or_default() += speed * dt;
    }
    visual_tick.0 = Some(frame_idx);
    // Camera follows the ego unless explicitly static.
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
                let eye = pos - fwd * pb.args.chase_dist + Vec3::Y * pb.args.chase_height;
                let look = pos + fwd * 8.0;
                cam.translation = eye;
                cam.look_at(look, Vec3::Y);
                *cam_pose = CameraPose {
                    eye: [f64::from(eye.x), f64::from(eye.y), f64::from(eye.z)],
                    target: [f64::from(look.x), f64::from(look.y), f64::from(look.z)],
                };
                }
        }
    }

    cursor.frame_to_tick.insert(global_frame.0 + 1, frame_idx);
    cursor.awaiting += 1;
    cursor.next_frame += 1;
}

/// Per-applied-tick visual state: lens visibility from the contract's
/// derived light states (+ deterministic blink phases), wheel spin from
/// accumulated travel, and the bounded projected-beam pool.
#[allow(clippy::too_many_arguments)]
fn update_actor_visuals(
    pb: Res<Playback>,
    mut visual_tick: ResMut<VisualTick>,
    cues: Res<Cues>,
    low_beams: Res<GlobalLowBeams>,
    registry: Res<ActorRegistry>,
    mut lenses: Query<(&LensMarker, &mut Visibility), (Without<BeamSlot>, Without<WheelSpin>)>,
    mut wheels: Query<(&WheelSpin, &mut Transform), Without<BeamSlot>>,
    mut beams: Query<
        (&BeamSlot, &mut Transform, &mut Visibility),
        (Without<LensMarker>, Without<WheelSpin>),
    >,
) {
    let Some(tick) = visual_tick.0.take() else {
        return;
    };
    let Some(frame) = pb.state.frames.get(tick) else {
        return;
    };
    let time_s = frame.t;

    // Light truth for this frame, per the normative contract derivation.
    let inputs: Vec<LightInput> = frame
        .actors
        .iter()
        .filter(|rec| rec.kind != ActorTickKind::Despawn)
        .filter_map(|rec| {
            let desc = pb.state.actors.iter().find(|d| d.id == rec.id)?;
            let cue = cues.0.get(&rec.id).copied().unwrap_or_default();
            Some(LightInput {
                id: rec.id.clone(),
                is_vehicle: is_vehicle_class(&desc.actor_class),
                headlights: cue.headlights,
                emergency: cue.emergency,
                indicator: cue.indicator,
                reversing: cue.reversing,
            })
        })
        .collect();
    let states = derive_vehicle_light_states(&inputs, low_beams.0);
    let by_id: HashMap<&str, &VehicleLightState> =
        states.iter().map(|s| (s.actor_id.as_str(), s)).collect();

    // Lens visibility (emissive states are unbounded; blink phases are
    // deterministic functions of scene time).
    for (lens, mut visibility) in &mut lenses {
        let on = match by_id.get(lens.actor.as_str()) {
            None => false,
            Some(state) => match lens.kind {
                LensKind::LowBeam | LensKind::Tail => state.low_beams,
                LensKind::Reverse => state.reverse_light,
                LensKind::EmergencyRed => {
                    state.emergency != crate::actor_lights::Emergency::Off
                        && beacon_red_on(time_s)
                }
                LensKind::EmergencyBlue => {
                    state.emergency != crate::actor_lights::Emergency::Off
                        && beacon_blue_on(time_s)
                }
                LensKind::IndicatorLeft => state.indicator.left_on() && indicator_on(time_s),
                LensKind::IndicatorRight => state.indicator.right_on() && indicator_on(time_s),
            },
        };
        *visibility = if on {
            Visibility::Inherited
        } else {
            Visibility::Hidden
        };
    }

    // Wheel spin: angle = travel / radius about the local Z axle (negative
    // for forward roll with +X travel).
    for (wheel, mut transform) in &mut wheels {
        let Some(travel) = registry.travel.get(&wheel.actor) else {
            continue;
        };
        let angle = (-travel / f64::from(wheel.radius)) as f32;
        transform.rotation = wheel.base.rotation * Quat::from_rotation_z(angle);
    }

    // Bounded projected beams: the contract's ID-sorted first-8 pool.
    let projected: Vec<&VehicleLightState> =
        states.iter().filter(|s| s.projected_beam).collect();
    for (slot, mut transform, mut visibility) in &mut beams {
        let Some(state) = projected.get(slot.0) else {
            *visibility = Visibility::Hidden;
            continue;
        };
        let Some(rec) = frame.actors.iter().find(|r| r.id == state.actor_id) else {
            *visibility = Visibility::Hidden;
            continue;
        };
        let desc = pb.state.actors.iter().find(|d| d.id == rec.id);
        let dims = desc.map(actor_dims).unwrap_or(crate::scene_state::Dims {
            l: 4.7,
            w: 1.82,
            h: 1.45,
        });
        let (l, h) = (dims.l as f32, dims.h as f32);
        let yaw = rec.yaw_rad as f32;
        let rot = Quat::from_rotation_y(yaw);
        let origin = Vec3::new(
            rec.position[0] as f32,
            pb.args.ground_y,
            rec.position[2] as f32,
        );
        let source = origin + rot * Vec3::from(beam_source(l, h));
        let aim = origin + rot * Vec3::from(beam_aim(l));
        *transform = Transform::from_translation(source).looking_at(aim, Vec3::Y);
        *visibility = Visibility::Inherited;
    }
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

fn bump_frame(mut frame: ResMut<GlobalFrame>, readiness: Res<Readiness>) {
    if std::env::var("SCEN_DEBUG_PASSES").is_ok() && frame.0 < 5 {
        eprintln!("bump ready={} frame={}", readiness.actors_spawned, frame.0);
    }
    if readiness.actors_spawned {
        frame.0 += 1;
    }
}

// ---------------------------------------------------------------------------
// Pass collection & outputs
// ---------------------------------------------------------------------------

fn expected_keys(pb: &PlaybackArgs) -> Vec<String> {
    let mut keys = vec!["rgb".to_string(), "id".to_string()];
    if pb.mv {
        keys.push("mv".into());
    }
    keys
}

#[allow(clippy::too_many_arguments)]
fn collect_passes(
    receiver: Res<MainReceiver>,
    pb: Res<Playback>,
    cam_pose: Res<CameraPose>,
    mut cursor: ResMut<PlayCursor>,
    mut metrics: ResMut<Metrics>,
    mut exit: MessageWriter<AppExit>,
    registry: Res<ActorRegistry>,
    models: Res<VehicleModels>,
    low_beams: Res<GlobalLowBeams>,
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
                    let raw = readback::strip_padding(&p.data, w, h, 4);
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
            write_actor_visuals_report(&pb.args, &registry, &models, low_beams.0);
            exit.write(AppExit::Success);
            return;
        }
    }
}

fn frame_path(out_dir: &str, tick: usize, suffix: &str) -> String {
    format!("{out_dir}/frame-{tick:04}.{suffix}")
}

/// Instancing + attribution evidence: per catalog id, how many actors were
/// spawned and how many unique mesh assets they share (GLB models keep one
/// mesh upload per primitive regardless of actor count).
fn write_actor_visuals_report(
    args: &PlaybackArgs,
    registry: &ActorRegistry,
    models: &VehicleModels,
    global_low_beams: bool,
) {
    let mut per_catalog = serde_json::Map::new();
    let mut stats: Vec<(&String, &(usize, HashSet<AssetId<Mesh>>))> =
        registry.model_stats.iter().collect();
    stats.sort_by(|a, b| a.0.cmp(b.0));
    for (catalog_id, (actors, unique)) in stats {
        let recipe = models.recipes.get(catalog_id);
        per_catalog.insert(
            catalog_id.clone(),
            json!({
                "actors": actors,
                "uniqueMeshAssets": unique.len(),
                "path": recipe.map(|r| json!({
                    "kind": "glb",
                    "glb": r.glb,
                    "tintable": r.tintable,
                    "scaleToDims": r.scale_to_dims,
                    "attribution": r.attribution,
                    "source": r.source,
                })).unwrap_or_else(|| json!({ "kind": "primitive" })),
            }),
        );
    }
    let report = json!({
        "globalLowBeams": global_low_beams,
        "projectedHeadlightLimit": PROJECTED_HEADLIGHT_LIMIT,
        "actors": per_catalog,
    });
    std::fs::write(
        Path::new(&args.out_dir).join("actor-visuals.json"),
        serde_json::to_string_pretty(&report).unwrap(),
    )
    .expect("write actor visuals report");
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
