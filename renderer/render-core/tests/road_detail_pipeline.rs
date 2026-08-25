//! Pipeline-creation smoke test for the road-detail extended material:
//! proves src/shaders/road_detail.wgsl composes through naga_oil against the
//! bevy_pbr shader library and specializes into a valid render pipeline.
//!
//! Requires a GPU adapter (headless wgpu). CI hosts without a GPU set
//! `SF_NO_GPU=1` to skip.

use bevy::app::ScheduleRunnerPlugin;
use bevy::asset::RenderAssetUsages;
use bevy::camera::RenderTarget;
use bevy::image::Image;
use bevy::log::LogPlugin;
use bevy::prelude::*;
use bevy::render::render_resource::{
    CachedPipelineState, Extent3d, PipelineCache, PipelineDescriptor, TextureDimension,
    TextureFormat, TextureUsages,
};
use bevy::render::RenderApp;
use bevy::shader::Shader;
use bevy::window::ExitCondition;
use std::time::Duration;

use render_core::road_detail::{RoadDetailExtension, RoadDetailMaterial, RoadDetailUniform};

/// Solid-color 4x4 RGBA8 image.
fn tiny_image(rgba: [u8; 4], srgb: bool) -> Image {
    let format = if srgb {
        TextureFormat::Rgba8UnormSrgb
    } else {
        TextureFormat::Rgba8Unorm
    };
    Image::new(
        Extent3d { width: 4, height: 4, depth_or_array_layers: 1 },
        TextureDimension::D2,
        rgba.repeat(16),
        format,
        RenderAssetUsages::RENDER_WORLD,
    )
}

#[test]
fn road_detail_material_pipelines_compile() {
    if std::env::var_os("SF_NO_GPU").is_some() {
        eprintln!("skipped: SF_NO_GPU set (no GPU adapter on this host)");
        return;
    }
    std::env::set_var("BEVY_ASSET_ROOT", "/");

    let mut app = App::new();
    app.add_plugins((
        DefaultPlugins
            .set(bevy::asset::AssetPlugin { file_path: "/".into(), ..default() })
            .set(WindowPlugin {
                primary_window: None,
                exit_condition: ExitCondition::DontExit,
                ..default()
            })
            .disable::<bevy::winit::WinitPlugin>()
            .disable::<bevy::audio::AudioPlugin>()
            .disable::<bevy::render::pipelined_rendering::PipelinedRenderingPlugin>()
            .set(LogPlugin { filter: "warn,wgpu_core=warn,wgpu_hal=warn,naga=warn".into(), ..default() }),
        ScheduleRunnerPlugin::run_loop(Duration::ZERO),
        render_core::road_detail::RoadDetailPlugin,
    ));
    while app.plugins_state() != bevy::app::PluginsState::Ready {
        app.update();
    }
    app.finish();
    app.cleanup();

    // Offscreen render target.
    let target = {
        let mut images = app.world_mut().resource_mut::<Assets<Image>>();
        let mut img = Image::new_target_texture(64, 64, TextureFormat::Rgba8UnormSrgb, None);
        img.texture_descriptor.usage |= TextureUsages::COPY_SRC;
        images.add(img)
    };

    // Road material over a ground plane; both modes share one pipeline
    // (mode is a uniform), so one material exercises the shader fully.
    let (splat, decal, color_a, normal_a, orm_a) = {
        let mut images = app.world_mut().resource_mut::<Assets<Image>>();
        (
            images.add(tiny_image([128, 64, 200, 90], false)),
            images.add(tiny_image([40, 40, 40, 128], true)),
            images.add(tiny_image([90, 90, 95, 255], true)),
            images.add(tiny_image([128, 128, 255, 255], false)),
            images.add(tiny_image([255, 200, 0, 255], false)),
        )
    };
    let material = {
        let extension = RoadDetailExtension {
            params: RoadDetailUniform {
                bounds_min: Vec2::new(-50.0, -50.0),
                bounds_inv_size: Vec2::splat(0.01),
                tiling: Vec3::new(0.35, 0.5, 1.7),
                detail_strength: 0.5,
                wear: Vec4::new(0.38, -0.22, 0.85, 0.0),
            },
            splat,
            decal_overlay: decal,
            var_a_color: color_a.clone(),
            var_a_normal: normal_a.clone(),
            var_a_orm: orm_a.clone(),
            var_b_color: color_a,
            var_b_normal: normal_a.clone(),
            var_b_orm: orm_a,
            detail_normal: normal_a,
        };
        app.world_mut()
            .resource_mut::<Assets<RoadDetailMaterial>>()
            .add(RoadDetailMaterial { base: StandardMaterial::default(), extension })
    };
    let plane = {
        let mut meshes = app.world_mut().resource_mut::<Assets<Mesh>>();
        meshes.add(Plane3d::default().mesh().size(20.0, 20.0))
    };
    app.world_mut().spawn((Mesh3d(plane), MeshMaterial3d(material)));
    app.world_mut().spawn((
        DirectionalLight { illuminance: 50_000.0, ..default() },
        Transform::IDENTITY.looking_to(Dir3::new(Vec3::new(0.3, -1.0, 0.2)).unwrap(), Vec3::Y),
    ));
    app.world_mut().spawn((
        Camera3d::default(),
        Camera { order: 0, ..default() },
        Msaa::Off,
        Transform::from_xyz(0.0, 8.0, 12.0).looking_at(Vec3::ZERO, Vec3::Y),
        RenderTarget::Image(target.into()),
    ));

    // The extension's fragment shader handle, for pinpointing our pipeline.
    let shader: Handle<Shader> = app
        .world()
        .resource::<AssetServer>()
        .load("embedded://render_core/shaders/road_detail.wgsl");

    // Pump frames until our pipeline leaves the queue (bounded).
    let mut ours_ok = false;
    for _ in 0..300 {
        app.update();
        let render_app = app.get_sub_app(RenderApp).expect("render app");
        let cache = render_app.world().resource::<PipelineCache>();
        let mut pending = false;
        for pipeline in cache.pipelines() {
            let is_ours = match &pipeline.descriptor {
                PipelineDescriptor::RenderPipelineDescriptor(desc) => desc
                    .fragment
                    .as_ref()
                    .is_some_and(|f| f.shader.id() == shader.id()),
                PipelineDescriptor::ComputePipelineDescriptor(_) => false,
            };
            match &pipeline.state {
                // ShaderNotLoaded / ShaderImportNotYetAvailable are transient
                // while shader assets stream in; the cache retries them.
                CachedPipelineState::Err(
                    bevy::shader::ShaderCacheError::ShaderNotLoaded(_)
                    | bevy::shader::ShaderCacheError::ShaderImportNotYetAvailable,
                ) => pending = true,
                CachedPipelineState::Err(err) => {
                    panic!("pipeline failed to compile (ours: {is_ours}): {err}")
                }
                CachedPipelineState::Queued | CachedPipelineState::Creating(_) => pending = true,
                CachedPipelineState::Ok(_) => {
                    if is_ours {
                        ours_ok = true;
                    }
                }
            }
        }
        if ours_ok && !pending {
            break;
        }
    }
    assert!(
        ours_ok,
        "road_detail.wgsl render pipeline never reached the Ok state (never specialized?)"
    );
    // Skip App teardown: destroying the headless wgpu device from a test
    // harness thread segfaults in the driver; the process exits right after.
    std::mem::forget(app);
}
