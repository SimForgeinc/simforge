//! Load one vehicle GLB, frame it with a 3/4 camera, optionally tint the
//! `body_paint` material, take a screenshot, exit.
//!
//! Usage:
//!   simforge-vehicle-smoke <model.glb> <out.png> [--tint RRGGBB]
//!
//! The camera is auto-fitted from the scene AABB after load, assuming the
//! catalog convention: y-up, meters, +X forward, origin at ground.

use bevy::asset::UnapprovedPathMode;
use bevy::camera::primitives::Aabb;
use bevy::gltf::{Gltf, GltfMaterialName};
use bevy::light::{DirectionalLight, GlobalAmbientLight};
use bevy::prelude::*;
use bevy::render::view::window::screenshot::{save_to_disk, Screenshot};
use bevy::world_serialization::WorldAssetRoot;
use std::path::PathBuf;

#[derive(Resource)]
struct Job {
    glb: String,
    out: String,
    tint: Option<Color>,
    gltf_handle: Option<Handle<Gltf>>,
    spawned: bool,
    framed: bool,
    frames_after_ready: u32,
    shot_taken: bool,
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 3 {
        eprintln!("usage: simforge-vehicle-smoke <model.glb> <out.png> [--tint RRGGBB]");
        std::process::exit(2);
    }
    let glb = std::fs::canonicalize(&args[1])
        .unwrap_or_else(|_| PathBuf::from(&args[1]))
        .to_string_lossy()
        .into_owned();
    let out = args[2].clone();
    let tint = args
        .iter()
        .position(|a| a == "--tint")
        .and_then(|i| args.get(i + 1))
        .map(|hex| {
            let v = u32::from_str_radix(hex.trim_start_matches('#'), 16).expect("bad tint hex");
            Color::srgb_u8((v >> 16) as u8, (v >> 8) as u8, v as u8)
        });

    App::new()
        .add_plugins(DefaultPlugins
            .set(bevy::asset::AssetPlugin {
                unapproved_path_mode: UnapprovedPathMode::Allow,
                ..default()
            })
            .set(WindowPlugin {
            primary_window: Some(Window {
                resolution: bevy::window::WindowResolution::new(960, 720),
                title: "simforge-vehicle-smoke".into(),
                ..default()
            }),
            ..default()
        }))
        .insert_resource(Job {
            glb,
            out,
            tint,
            gltf_handle: None,
            spawned: false,
            framed: false,
            frames_after_ready: 0,
            shot_taken: false,
        })
        .insert_resource(GlobalAmbientLight {
            color: Color::WHITE,
            brightness: 1500.0,
            affects_lightmapped_meshes: true,
        })
        .insert_resource(ClearColor(Color::srgb(0.50, 0.54, 0.60)))
        .add_systems(Startup, setup)
        .add_systems(Update, drive)
        .run();
}

#[derive(Component)]
struct FitCamera;

fn setup(mut commands: Commands, assets: Res<AssetServer>, mut job: ResMut<Job>) {
    job.gltf_handle = Some(assets.load(job.glb.clone()));

    commands.spawn((
        Camera3d::default(),
        Transform::from_xyz(6.0, 3.0, -6.0).looking_at(Vec3::ZERO, Vec3::Y),
        FitCamera,
    ));
    commands.spawn((
        DirectionalLight {
            illuminance: 45_000.0,
            shadow_maps_enabled: true,
            ..default()
        },
        Transform::from_xyz(4.0, 8.0, -3.0).looking_at(Vec3::ZERO, Vec3::Y),
    ));
    commands.spawn((
        DirectionalLight {
            illuminance: 14_000.0,
            shadow_maps_enabled: false,
            ..default()
        },
        Transform::from_xyz(-6.0, 4.0, 5.0).looking_at(Vec3::ZERO, Vec3::Y),
    ));
}

#[allow(clippy::too_many_arguments)]
fn drive(
    mut commands: Commands,
    gltfs: Res<Assets<Gltf>>,
    mut materials: ResMut<Assets<StandardMaterial>>,
    mut job: ResMut<Job>,
    named: Query<(&GltfMaterialName, &MeshMaterial3d<StandardMaterial>)>,
    aabbs: Query<(&GlobalTransform, &Aabb), With<Mesh3d>>,
    mut cam: Query<&mut Transform, With<FitCamera>>,
    mut exit: MessageWriter<AppExit>,
) {
    let Some(handle) = job.gltf_handle.clone() else {
        return;
    };

    if !job.spawned {
        let Some(gltf) = gltfs.get(&handle) else {
            return;
        };
        let scene = gltf.scenes[0].clone();
        commands.spawn((WorldAssetRoot(scene),));
        job.spawned = true;
        return;
    }

    // Wait until mesh AABBs exist, then tint + fit the camera once.
    if !job.framed {
        let mut min = Vec3::splat(f32::MAX);
        let mut max = Vec3::splat(f32::MIN);
        let mut n = 0;
        for (gt, aabb) in &aabbs {
            let c: Vec3 = aabb.center.into();
            let e: Vec3 = aabb.half_extents.into();
            for sx in [-1.0f32, 1.0] {
                for sy in [-1.0f32, 1.0] {
                    for sz in [-1.0f32, 1.0] {
                        let p = gt.transform_point(c + e * Vec3::new(sx, sy, sz));
                        min = min.min(p);
                        max = max.max(p);
                    }
                }
            }
            n += 1;
        }
        if n == 0 {
            return;
        }
        if let Some(tint) = job.tint {
            let mut tinted = 0;
            for (name, mat_handle) in &named {
                if name.0 == "body_paint" {
                    if let Some(mut mat) = materials.get_mut(&mat_handle.0) {
                        mat.base_color = tint;
                        tinted += 1;
                    }
                }
            }
            println!("tinted {tinted} body_paint material bindings");
        }
        let center = (min + max) * 0.5;
        let radius = ((max - min) * 0.5).length().max(0.5);
        let dir = Vec3::new(1.0, 0.55, -1.0).normalize();
        let mut t = cam.single_mut().expect("camera");
        *t = Transform::from_translation(center + dir * radius * 2.1).looking_at(center, Vec3::Y);
        job.framed = true;
        println!(
            "aabb min=({:.2},{:.2},{:.2}) max=({:.2},{:.2},{:.2}) meshes={}",
            min.x, min.y, min.z, max.x, max.y, max.z, n
        );
        return;
    }

    if !job.shot_taken {
        job.frames_after_ready += 1;
        // Give shadows/materials a few frames to settle.
        if job.frames_after_ready == 90 {
            let path = PathBuf::from(job.out.clone());
            commands
                .spawn(Screenshot::primary_window())
                .observe(save_to_disk(path));
            job.shot_taken = true;
        }
        return;
    }

    job.frames_after_ready += 1;
    if job.frames_after_ready > 140 {
        exit.write(AppExit::Success);
    }
}
