//! UniScenarios renderer bake-off: headless Bevy offscreen renderer.
//!
//! Renders corpus GLB tiles (meshopt-decoded) from a fixed camera pose,
//! producing RGB, instance-ID and depth passes with GPU->CPU readback,
//! deterministic output, and timing instrumentation.
//!
//! Asset loading: BEVY_ASSET_ROOT is set to "/" so absolute GLB paths load
//! as plain file paths ("home/path/...").
use anyhow::{bail, Result};
use bevy::app::{AppExit, ScheduleRunnerPlugin};
use bevy::camera::visibility::RenderLayers;
use bevy::camera::RenderTarget;
use bevy::gltf::Gltf;
use bevy::core_pipeline::tonemapping::Tonemapping;
use bevy::light::cascade::CascadeShadowConfigBuilder;
use bevy::light::{DirectionalLight, DirectionalLightShadowMap, GlobalAmbientLight};
use bevy::log::LogPlugin;
use bevy::prelude::*;
use bevy::render::render_asset::RenderAssets;
use bevy::render::render_resource::{
    Buffer, BufferDescriptor, BufferUsages, CommandEncoderDescriptor, Extent3d, MapMode, PollType,
    TexelCopyBufferInfo, TexelCopyBufferLayout, TextureFormat, TextureUsages,
};
use bevy::render::renderer::{RenderContext, RenderDevice, RenderQueue};
use bevy::render::texture::GpuImage;
use bevy::render::camera::ExtractedCamera;
use bevy::render::view::ViewDepthTexture;
use bevy::render::{Extract, Render, RenderApp, RenderSystems};
use bevy::render::renderer::RenderGraph;
use bevy::world_serialization::{WorldAssetRoot, WorldInstance, WorldInstanceSpawner};
use bevy::window::ExitCondition;
use serde_json::json;
use std::collections::HashMap;
use std::path::PathBuf;
use std::time::{Duration, Instant};

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

#[derive(clap::Parser, Debug, Clone)]
#[derive(Resource)]
#[clap(allow_negative_numbers = true)]
struct Args {
    /// GLB files (absolute paths) to load, comma-separated.
    #[arg(long, value_delimiter = ',', required = true)]
    glbs: Vec<String>,
    /// Camera eye position (x y z).
    #[arg(long, num_args = 3)]
    eye: Vec<f32>,
    /// Camera target position (x y z).
    #[arg(long, num_args = 3)]
    target: Vec<f32>,
    /// Vertical FOV in degrees.
    #[arg(long, default_value_t = 58.0)]
    fov: f32,
    #[arg(long, default_value_t = 736)]
    width: u32,
    #[arg(long, default_value_t = 416)]
    height: u32,
    /// Warmup frames before measurement begins.
    #[arg(long, default_value_t = 20)]
    warmup: u32,
    /// Steady-state frames to measure / capture.
    #[arg(long, default_value_t = 10)]
    frames: u32,
    /// Output prefix (writes <prefix>.rgb.png, .id.png, .depth.png, .legend.json, .timings.json).
    #[arg(long)]
    out: String,
    /// Skip instance-ID pass.
    #[arg(long, default_value_t = false)]
    no_id: bool,
    /// Skip depth pass.
    #[arg(long, default_value_t = false)]
    no_depth: bool,
    /// Extra parallel cameras (offset forward along view dir by k*15m).
    #[arg(long, default_value_t = 1)]
    cameras: u32,
    /// Sun elevation degrees.
    #[arg(long, default_value_t = 38.0)]
    sun_elev: f32,
    /// Sun azimuth degrees.
    #[arg(long, default_value_t = 145.0)]
    sun_azim: f32,
    /// Sun illuminance in lux.
    #[arg(long, default_value_t = 28000.0)]
    lux: f32,
    /// Ambient light brightness.
    #[arg(long, default_value_t = 0.6)]
    ambient: f32,
    #[arg(long, default_value_t = 0.5)]
    near: f32,
    #[arg(long, default_value_t = 900.0)]
    far: f32,
    /// JSON file with [{"eye":[x,y,z],"target":[x,y,z]}, ...]; renders one frame per pose.
    #[arg(long)]
    poses: Option<String>,
    /// Output directory for sequence frames (frame-%04d.png).
    #[arg(long)]
    seq_out_dir: Option<String>,
}

#[derive(Clone, serde::Serialize, serde::Deserialize)]
struct SeqPose {
    eye: Vec<f32>,
    target: Vec<f32>,
}

impl Args {
    fn expected_keys(&self) -> Vec<String> {
        let mut keys: Vec<String> = (0..self.cameras.max(1)).map(|c| format!("rgb{c}")).collect();
        if !self.no_id {
            keys.push("id0".into());
        }
        if !self.no_depth {
            keys.push("depth0".into());
        }
        keys
    }
}

// ---------------------------------------------------------------------------
// Main world <-> render world plumbing
// ---------------------------------------------------------------------------

struct SentPass {
    key: String,
    frame: u64,
    data: Vec<u8>,
    readback_us: u64,
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
    src_image: Handle<Image>,
    buffer: Buffer,
    key: String,
}

#[derive(Resource, Default)]
struct Copiers(Vec<ImageCopier>);
#[derive(Resource, Default)]
struct DepthCopiers(Vec<DepthCopier>);
/// Frame counter mirrored into the render world for stamping passes.
#[derive(Resource, Default, Clone, Copy)]
struct GlobalFrame(u64);
#[derive(Resource, Default, Clone, Copy)]
struct FrameStamp(u64);

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
        label: Some("spike-readback"),
        size: size_bytes as u64,
        usage: BufferUsages::MAP_READ | BufferUsages::COPY_DST,
        mapped_at_creation: false,
    })
}

fn aligned_row(width: usize, pixel_size: usize) -> usize {
    RenderDevice::align_copy_bytes_per_row(width * pixel_size)
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
#[derive(Component)]
struct CameraMarker;

#[derive(Resource)]
struct SpikeState {
    total_glbs: u32,
    loaded_at: Option<Instant>,
    load_start: Instant,
    build_ready_at: Option<Instant>,
    id_clones_done: bool,
    capture_start: Option<Instant>,
    last_capture_at: Option<Instant>,
    frame_period_ms: Vec<f64>,
    readback_us_total: u64,
    captured_triples: u64,
    saved: bool,
}

#[derive(Resource, Default)]
struct ReadyCounter(u32);
#[derive(Resource)]
struct SeqMode {
    poses: Vec<SeqPose>,
    out_dir: String,
    idx: usize,
}
#[derive(Resource, Default)]
struct FrameToPose(std::collections::HashMap<u64, usize>);

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

fn main() -> Result<()> {
    let mut args = <Args as clap::Parser>::parse();
    let mut seq_frames: Option<(Vec<SeqPose>, String)> = None;
    let mut frames_override: Option<u32> = None;
    if args.eye.len() != 3 || args.target.len() != 3 {
        bail!("--eye and --target need 3 values");
    }
    for g in &args.glbs {
        if !PathBuf::from(g).is_absolute() {
            bail!("glb paths must be absolute: {g}");
        }
    }
    std::env::set_var("BEVY_ASSET_ROOT", "/");
    let (tx, rx) = crossbeam_channel::unbounded::<SentPass>();

    // Sequence mode: one RGB frame per pose.
    if args.poses.is_some() {
        let poses: Vec<SeqPose> =
            serde_json::from_str(&std::fs::read_to_string(args.poses.as_ref().unwrap()).unwrap())
                .expect("parse poses json");
        println!("SEQ {} poses", poses.len());
        seq_frames = Some((poses.clone(), args.seq_out_dir.clone().unwrap()));
        // drive exactly `warmup + n` frames; capture starts at pose 0
        frames_override = Some(poses.len() as u32);
    }

    let mut app = App::new();
    app.insert_resource(ClearColor(Color::srgb(0.53, 0.74, 0.92)))
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
                .set(LogPlugin {
                    filter: "warn,wgpu_core=warn,wgpu_hal=warn,naga=warn".into(),
                    ..default()
                }),
            ScheduleRunnerPlugin::run_loop(Duration::ZERO),
        ))
        .insert_resource(GlobalAmbientLight {
            color: Color::srgb(1.0, 0.98, 0.94),
            brightness: args.ambient,
            affects_lightmapped_meshes: true,
        })
        .insert_resource(DirectionalLightShadowMap { size: 2048 })
        .insert_resource(MainReceiver(rx))
        .insert_resource(args.clone())
        .insert_resource(match &seq_frames {
            Some((poses, dir)) => SeqMode {
                poses: poses.clone(),
                out_dir: dir.clone(),
                idx: 0,
            },
            None => SeqMode { poses: vec![], out_dir: String::new(), idx: 0 },
        })
        .init_resource::<GlobalFrame>()
        .init_resource::<ReadyCounter>()
        .init_resource::<FrameToPose>()
        .insert_resource({
            if let Some(n) = frames_override {
                args.frames = n;
                args.warmup = args.warmup.min(10);
            }
            SpikeState {
                total_glbs: args.glbs.len() as u32,
                loaded_at: None,
                load_start: Instant::now(),
                build_ready_at: None,
                id_clones_done: true,
                capture_start: None,
                last_capture_at: None,
                frame_period_ms: Vec::new(),
                readback_us_total: 0,
                captured_triples: 0,
                saved: false,
            }
        })
        .add_systems(Startup, startup_setup)
        .add_systems(Update, (check_assets, poll_roots))
        .add_systems(Update, (build_id_pass, advance_seq_pose, tick_frames).chain())
        .add_systems(PostUpdate, collect_passes);

    let render_app = app.get_sub_app_mut(RenderApp).unwrap();
    render_app
        .insert_resource(RenderSender(tx))
        .init_resource::<Copiers>()
        .init_resource::<DepthCopiers>()
        .init_resource::<FrameStamp>()
        .add_systems(ExtractSchedule, (extract_copiers, extract_frame))
        .add_systems(RenderGraph, copy_passes)
        .add_systems(Render, receive_passes.after(RenderSystems::Render));

    app.run();
    Ok(())
}

fn startup_setup(
    mut commands: Commands,
    args: Res<Args>,
    mut images: ResMut<Assets<Image>>,
    device: Res<RenderDevice>,
    server: Res<AssetServer>,
) {
    commands.spawn((
        DirectionalLight {
            illuminance: args.lux,
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
        Transform::IDENTITY.looking_to(sun_direction(args.sun_elev, args.sun_azim), Vec3::Y),
    ));

    let eye = Vec3::from_slice(&args.eye);
    let target = Vec3::from_slice(&args.target);
    let fwd = (target - eye).normalize();

    let size = Extent3d {
        width: args.width,
        height: args.height,
        ..default()
    };
    let rgba_buf_size = aligned_row(size.width as usize, 4) * size.height as usize;

    for c in 0..args.cameras.max(1) {
        let offset = fwd * (c as f32 * 15.0);
        let transform =
            Transform::from_translation(eye + offset).looking_at(target + offset, Vec3::Y);

        let rgb_image =
            setup_target_image(&mut images, args.width, args.height, TextureFormat::Rgba8UnormSrgb);
        let rgb_handle = rgb_image.clone();
        commands.spawn(ImageCopier {
            buffer: make_buffer(&device, rgba_buf_size),
            src_image: rgb_image.clone(),
            key: format!("rgb{c}"),
        });

        let cam_id = {
            let mut e = commands.spawn((
                Camera3d {
                    depth_texture_usages: (TextureUsages::RENDER_ATTACHMENT
                        | TextureUsages::COPY_SRC)
                        .into(),
                    ..default()
                },
                Projection::from(PerspectiveProjection {
                    fov: args.fov.to_radians(),
                    near: args.near,
                    far: args.far,
                    ..default()
                }),
                Msaa::Off,
                Tonemapping::AgX,
                Camera {
                    order: c as isize * 2,
                    ..default()
                },
                transform,
                RenderTarget::Image(rgb_image.into()),
            ));
            e.id()
        };

        if c == 0 {
            commands.entity(cam_id).insert(CameraMarker);
            if !args.no_id {
                let id_image = setup_target_image(
                    &mut images,
                    args.width,
                    args.height,
                    TextureFormat::Rgba8UnormSrgb,
                );
                commands.spawn(ImageCopier {
                    buffer: make_buffer(&device, rgba_buf_size),
                    src_image: id_image.clone(),
                    key: "id0".into(),
                });
                commands.spawn((
                    (
                        Camera3d::default(),
                        Camera {
                            clear_color: ClearColorConfig::Custom(Color::BLACK),
                            order: 1,
                            ..default()
                        },
                        Projection::from(PerspectiveProjection {
                            fov: args.fov.to_radians(),
                            near: args.near,
                            far: args.far,
                            ..default()
                        }),
                        Msaa::Off,
                        Tonemapping::AgX,
                        transform,
                        RenderTarget::Image(id_image.into()),
                        RenderLayers::layer(1),
                    ),
                ));
            }

            if !args.no_depth {
                commands.spawn(DepthCopier {
                    src_image: rgb_handle,
                    buffer: make_buffer(&device, rgba_buf_size),
                    key: "depth0".into(),
                });
            }
        }
    }

    for g in &args.glbs {
        let path = g.trim_start_matches('/').to_owned();
        let handle: Handle<Gltf> = server.load(path);
        commands.spawn(TileLoad(handle));
    }
}

fn check_assets(
    mut commands: Commands,
    gltfs: Res<Assets<Gltf>>,
    loads: Query<(Entity, &TileLoad), Without<SceneSpawned>>,
    mut state: ResMut<SpikeState>,
) {
    if state.loaded_at.is_none() {
        let loaded_count = state.total_glbs;
        // All handles resolve?
        let all_loaded = loads
            .iter()
            .all(|(_, t)| gltfs.contains(&t.0))
            && gltfs.len() >= loaded_count as usize;
        if all_loaded {
            state.loaded_at = Some(Instant::now());
        }
    }
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

fn poll_roots(
    roots: Query<&WorldInstance>,
    spawner: Option<Res<WorldInstanceSpawner>>,
    mut state: ResMut<SpikeState>,
) {
    let Some(spawner) = spawner else {
        return;
    };
    if state.build_ready_at.is_some() {
        return;
    }
    if roots.iter().count() < state.total_glbs as usize {
        return;
    }
    if roots.iter().all(|wi| spawner.instance_is_ready(**wi)) {
        state.build_ready_at = Some(Instant::now());
    }
}

fn build_id_pass(
    mut commands: Commands,
    args: Res<Args>,
    mut materials: ResMut<Assets<StandardMaterial>>,
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
    mut state: ResMut<SpikeState>,
) {
    if state.id_clones_done || state.build_ready_at.is_none() {
        return;
    }

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
    // Deterministic assignment independent of ECS iteration order.
    entries.sort_by(|a, b| a.0.cmp(&b.0).then(a.1.cmp(&b.1)));

    let mut legend = Vec::with_capacity(entries.len());
    for (i, (name, _, mesh_h, parent, transform)) in entries.into_iter().enumerate() {
        let id = (i + 1) as u32; // 0 reserved as background
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
        legend.push(json!({ "id": id, "name": name }));
    }
    let legend_path = format!("{}.legend.json", args.out);
    std::fs::write(&legend_path, serde_json::to_string_pretty(&legend).unwrap())
        .expect("write legend");
    state.id_clones_done = true;
}

fn advance_seq_pose(
    args: Res<Args>,
    mut q: Query<&mut Transform, With<CameraMarker>>,
    mut frame: ResMut<GlobalFrame>,
    mut seq: Option<ResMut<SeqMode>>,
    mut frame_to_pose: ResMut<FrameToPose>,
) {
    let Some(seq) = seq.as_mut() else {
        return;
    };
    let f = frame.0;
    if (f as u64) < args.warmup as u64 || seq.idx >= seq.poses.len() {
        return;
    }
    let pose = &seq.poses[seq.idx];
    if let Ok(mut t) = q.single_mut() {
        *t = Transform::from_translation(Vec3::from_slice(&pose.eye))
            .looking_at(Vec3::from_slice(&pose.target), Vec3::Y);
    }
    frame_to_pose.0.insert(f + 1, seq.idx);
    seq.idx += 1;
}

fn tick_frames(mut frame: ResMut<GlobalFrame>, state: Res<SpikeState>) {
    if state.build_ready_at.is_some() && state.id_clones_done {
        frame.0 += 1;
    }
}

fn collect_passes(
    receiver: Res<MainReceiver>,
    args: Res<Args>,
    seq: Option<Res<SeqMode>>,
    frame_to_pose: Res<FrameToPose>,
    mut state: ResMut<SpikeState>,
    mut exit: MessageWriter<AppExit>,
) {
    let mut latest: HashMap<String, SentPass> = HashMap::new();
    while let Ok(p) = receiver.try_recv() {
        latest.insert(p.key.clone(), p);
    }
    if latest.is_empty() {
        return;
    }

    // A completed "triple": all expected keys stamped with the same steady-state frame.
    let expected = args.expected_keys();
    let min_steady_frame = args.warmup as u64 + 1;
    // Group by frame, require all keys.
    let mut by_frame: HashMap<u64, Vec<&SentPass>> = HashMap::new();
    let seq_active = seq.as_ref().map(|s| !s.poses.is_empty()).unwrap_or(false);
    for p in latest.values() {
        if seq_active {
            if frame_to_pose.0.contains_key(&p.frame) {
                by_frame.entry(p.frame).or_default().push(p);
            }
        } else if p.frame >= min_steady_frame {
            by_frame.entry(p.frame).or_default().push(p);
        }
    }
    let mut done_frames: Vec<u64> = by_frame
        .iter()
        .filter(|(_, v)| v.len() == expected.len())
        .map(|(k, _)| *k)
        .collect();
    if done_frames.is_empty() {
        return;
    }
    done_frames.sort_unstable();

    for f in done_frames {
        let passes = &by_frame[&f];
        let now = Instant::now();
        if state.capture_start.is_none() {
            state.capture_start = Some(now);
        } else if let Some(last) = state.last_capture_at {
            state.frame_period_ms.push(now.duration_since(last).as_secs_f64() * 1000.0);
        }
        state.last_capture_at = Some(now);
        state.readback_us_total += passes.iter().map(|p| p.readback_us).sum::<u64>();
        if !seq_active {
            state.captured_triples += 1;
        }

        // Sequence mode: save each frame's RGB under its pose index.
        if let (Some(seq), Some(f2p)) = (
            seq.as_ref(),
            frame_to_pose.0.get(&f).copied(),
        ) {
            for p in passes.iter() {
                if p.key.starts_with("rgb") {
                    let raw = strip_padding(&p.data, args.width as usize, args.height as usize, 4);
                    let img = image::RgbaImage::from_raw(args.width, args.height, raw)
                        .expect("rgba image");
                    std::fs::create_dir_all(&seq.out_dir).ok();
                    img.save(format!("{}/frame-{:04}.png", seq.out_dir, f2p))
                        .expect("save seq frame");
                }
            }
        }
        let seq_done = seq_active && {
            let dir = &seq.as_ref().unwrap().out_dir;
            std::fs::read_dir(dir).map(|d| d.count()).unwrap_or(0)
                >= seq.as_ref().unwrap().poses.len()
        };
        if seq_done {
            write_timings(&args, &state);
            state.saved = true;
            exit.write(AppExit::Success);
            return;
        }
        if !seq_active && state.captured_triples == args.frames as u64 {
            // Save outputs from the final frame's passes.
            save_outputs(&args, passes.iter().map(|p| (&p.key, &p.data)));
            write_timings(&args, &state);
            state.saved = true;
            exit.write(AppExit::Success);
            return;
        }
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

fn save_outputs<'a>(
    args: &Args,
    passes: impl Iterator<Item = (&'a String, &'a Vec<u8>)>,
) {
    let w = args.width as usize;
    let h = args.height as usize;
    for (key, data) in passes {
        match key.as_str() {
            k if k.starts_with("rgb") || k == "id0" => {
                let raw = strip_padding(data, w, h, 4);
                let img = image::RgbaImage::from_raw(w as u32, h as u32, raw)
                    .expect("rgba image");
                let suffix = if k == "id0" { "id" } else { k };
                img.save(format!("{}.{}.png", args.out, suffix)).expect("save png");
            }
            k if k.starts_with("depth") => {
                let raw = strip_padding(data, w, h, 4);
                std::fs::write(format!("{}.depth.f32.bin", args.out), &raw).expect("write depth bin");
                // Reverse-Z Depth32Float visualization: 1.0 = near plane.
                let floats: Vec<f32> = raw
                    .chunks_exact(4)
                    .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
                    .collect();
                let mut png = image::GrayImage::new(w as u32, h as u32);                for (i, d) in floats.iter().enumerate() {
                    let v = (d.clamp(0.0, 1.0) * 255.0) as u8;
                    let x = (i % w) as u32;
                    let y = (i / w) as u32;
                    png.put_pixel(x, y, image::Luma([v]));
                }
                png.save(format!("{}.depth.png", args.out)).expect("save depth png");
            }
            _ => {}
        }
    }
}

fn write_timings(args: &Args, state: &SpikeState) {
    let periods = &state.frame_period_ms;
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
    let load_ms = state
        .loaded_at
        .map(|t| t.duration_since(state.load_start).as_secs_f64() * 1000.0)
        .unwrap_or(-1.0);
    let build_ms = state
        .build_ready_at
        .zip(state.loaded_at)
        .map(|(b, l)| b.duration_since(l).as_secs_f64() * 1000.0)
        .unwrap_or(-1.0);
    let first_frame_ms = state
        .capture_start
        .zip(state.build_ready_at)
        .map(|(c, b)| c.duration_since(b).as_secs_f64() * 1000.0)
        .unwrap_or(-1.0);
    let timings = json!({
        "width": args.width,
        "height": args.height,
        "cameras": args.cameras.max(1),
        "passes": args.expected_keys(),
        "tiles": args.glbs.len(),
        "asset_load_ms": load_ms,
        "scene_build_ms": build_ms,
        "warmup_to_first_frame_ms": first_frame_ms,
        "measured_frames": periods.len(),
        "avg_frame_ms": avg,
        "p50_frame_ms": pct(0.5),
        "p99_frame_ms": pct(0.99),
        "fps": if avg > 0.0 { 1000.0 / avg } else { 0.0 },
        "readback_us_total_per_triple_avg": if state.captured_triples > 0 {
            state.readback_us_total as f64 / state.captured_triples as f64
        } else { 0.0 },
    });
    std::fs::write(
        format!("{}.timings.json", args.out),
        serde_json::to_string_pretty(&timings).unwrap(),
    )
    .expect("write timings");
    println!("TIMINGS {}", timings);
}

// --------------------------- render world ---------------------------------

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
    mut ctx: RenderContext,
    queue: Res<RenderQueue>,
    copiers: Res<Copiers>,
    depths: Res<DepthCopiers>,
    gpu_images: Res<RenderAssets<GpuImage>>,
    depth_views: Query<(Entity, &ExtractedCamera, &ViewDepthTexture)>,
) {
    let mut encoder = ctx
        .render_device()
        .create_command_encoder(&CommandEncoderDescriptor::default());

    for c in copiers.0.iter() {
        let Some(src) = gpu_images.get(&c.src_image) else {
            continue;
        };
        let width = src.texture_descriptor.size.width as usize;
        let pixel = src.texture_descriptor.format.block_copy_size(None).unwrap_or(4);
        let padded = aligned_row(width, pixel as usize);
        encoder.copy_texture_to_buffer(
            src.texture.as_image_copy(),
            TexelCopyBufferInfo {
                buffer: &c.buffer,
                layout: TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(
                        std::num::NonZero::<u32>::new(padded as u32).unwrap().into(),
                    ),
                    rows_per_image: None,
                },
            },
            src.texture_descriptor.size,
        );
    }

    for d in depths.0.iter() {
        // Find the 3D view rendering to this depth copier's source image.
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
                    bytes_per_row: Some(
                        std::num::NonZero::<u32>::new(padded as u32).unwrap().into(),
                    ),
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
    #[allow(clippy::type_complexity)]
    struct Pending {
        key: String,
        buffer: Buffer,
    }
    let mut pending: Vec<Pending> = Vec::new();
    for c in copiers.0.iter().cloned() {
        pending.push(Pending {
            key: c.key.clone(),
            buffer: c.buffer.clone(),
        });
    }
    for d in depths.0.iter().cloned() {
        pending.push(Pending {
            key: d.key.clone(),
            buffer: d.buffer.clone(),
        });
    }
    if pending.is_empty() {
        return;
    }

    let (s, r) = crossbeam_channel::bounded::<()>(pending.len());
    for p in &pending {
        let tx = s.clone();
        p.buffer
            .slice(..)
            .map_async(MapMode::Read, move |res| {
                if res.is_err() {
                    panic!("map buffer failed");
                }
                let _ = tx.send(());
            });
    }
    let t0 = Instant::now();
    device
        .poll(PollType::wait_indefinitely())
        .expect("poll device");
    for _ in &pending {
        r.recv().expect("map_async result");
    }
    let elapsed_us = t0.elapsed().as_micros() as u64;

    for p in &pending {
        let data = p.buffer.slice(..).get_mapped_range().to_vec();
        let _ = sender.send(SentPass {
            key: p.key.clone(),
            frame: stamp.0,
            data,
            readback_us: elapsed_us / pending.len() as u64,
        });
        p.buffer.unmap();
    }
}

