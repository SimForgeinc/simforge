//! GPU sky pass: stars, Moon and the volumetric cloud deck, at every hour.
//!
//! # Why this is a render pass and not a cubemap
//!
//! Up to rev19 the night sky was a CPU-baked cubemap handed to Bevy's
//! `Skybox`. A 256-texel face is 0.35 deg per texel, so the Moon (0.53 deg)
//! covered 1.5 texels and every star was smeared over ~8 screen pixels by the
//! cubemap's bilinear filter, and the whole thing could only be rebuilt on a
//! relight, which is why the clouds never moved. Both defects are properties
//! of the intermediate, not of the content.
//!
//! This module removes the intermediate. [`sky_pass`] runs after
//! `Core3dSystems::MainPass` and before post-processing, drawing a fullscreen
//! triangle only where the reversed-Z depth buffer is still at its far-plane
//! clear value:
//!
//! * opaque geometry remains untouched by the depth test;
//! * Bevy's Hillaire atmosphere has already rendered its aerial perspective,
//!   the Rayleigh/Mie sky and the solar disc into the target;
//! * the pass *composites over* that sky with premultiplied-alpha blending
//!   (`src + dst * (1 - alpha)`): stars and the lunar disc are added, the
//!   cloud deck's scatter is added and its transmittance attenuates whatever
//!   is behind it, and an aerial-perspective fraction of the atmosphere's own
//!   in-scatter is left in front of distant clouds so they haze into the
//!   horizon. There is therefore one sky at noon, at sunset and at midnight,
//!   with no handover between two models;
//! * tonemapping and the final offscreen-image copy consume the result
//!   written into the active [`ViewTarget`] texture;
//! * the cloud field advances with a monotonic render clock, so a still taken
//!   three seconds later is a different sky.
//!
//! Stars in daylight are not gated: the plate's radiance is ~1e-3 cd/m^2
//! against a 5e3 cd/m^2 sky, so they vanish photometrically, exactly as they
//! do outdoors, and reappear through twilight in the right order.

use bevy::asset::{embedded_asset, RenderAssetUsages};
use bevy::core_pipeline::core_3d::CORE_3D_DEPTH_FORMAT;
use bevy::core_pipeline::schedule::{Core3d, Core3dSystems};
use bevy::core_pipeline::FullscreenShader;
use bevy::image::Image;
use bevy::math::{Mat4, Vec2, Vec3, Vec4};
use bevy::prelude::*;
use bevy::render::extract_component::{ExtractComponent, ExtractComponentPlugin};
use bevy::render::extract_resource::{ExtractResource, ExtractResourcePlugin};
use bevy::render::render_asset::RenderAssets;
use bevy::render::render_resource::binding_types::{
    sampler, texture_2d, texture_3d, uniform_buffer,
};
use bevy::render::render_resource::{
    BindGroup, BindGroupEntries, BindGroupLayoutDescriptor, BindGroupLayoutEntries, BlendComponent,
    BlendFactor, BlendOperation, BlendState, CachedRenderPipelineId, Canonical, ColorTargetState,
    ColorWrites, CompareFunction, DepthStencilState, DynamicUniformBuffer, FragmentState,
    PipelineCache, RenderPassDescriptor, RenderPipeline, RenderPipelineDescriptor,
    SamplerBindingType, ShaderStages, ShaderType, Specializer, SpecializerKey, StoreOp,
    TextureFormat, TextureSampleType, Variants,
};
use bevy::render::renderer::{RenderContext, RenderDevice, RenderQueue, ViewQuery};
use bevy::render::texture::GpuImage;
use bevy::render::view::{ExtractedView, ViewDepthTexture, ViewTarget};
use bevy::render::{Render, RenderApp, RenderStartup, RenderSystems};
use bevy::shader::ShaderRef;

/// Everything the sky pass needs for one view, in physical units.
///
/// Populated by `engine::apply_lighting` from the resolved atmosphere and
/// night environment; the render clock in `elapsed_seconds` is advanced
/// separately every frame.
#[derive(Component, Clone, Copy, Debug, ExtractComponent)]
pub struct SkyPass {
    /// Rotation taking a world-space direction into the J2000-corrected
    /// equatorial frame the star plate is drawn in.
    pub equ_from_world: Mat4,
    /// Camera altitude above the atmosphere's reference sphere, metres.
    pub altitude_m: f32,
    /// Topocentric Moon direction in world space.
    pub moon_dir: Vec3,
    /// Topocentric lunar angular *radius*, radians.
    pub moon_angular_radius: f32,
    /// Lunar rotation axis in world space.
    pub moon_north: Vec3,
    /// Optical-libration sub-Earth point, radians.
    pub sub_earth_lon: f32,
    pub sub_earth_lat: f32,
    /// Unit direction from the Moon to the Sun (drives the terminator).
    pub moon_sun_dir: Vec3,
    /// Sun direction (towards the Sun) and the illuminance that reaches the
    /// top of the cloud deck, lx, before any cloud attenuation.
    pub sun_dir: Vec3,
    pub sun_lux: f32,
    /// Normalised chromaticity of the beam arriving at the deck, from the
    /// atmosphere's transmittance solve (white at noon, orange at sunset).
    pub sun_tint: Vec3,
    /// Luminance of the ground seen from the deck's underside, cd/m^2:
    /// `E_total_horizontal * albedo / pi` by day, city light by night.
    pub ground_bounce: f32,
    /// Radiance of the sky lighting the deck's top surface, cd/m^2 per
    /// channel: the zenith sky by day, moon-scattered blue by night.
    pub sky_ambient: Vec3,
    /// Aerial perspective between observer and deck: extinction at the
    /// ground (m^-1) and scale height (m) of the Rayleigh term and of the
    /// aerosol/fog terms, integrated up the slant path in the shader.
    pub aerial_rayleigh: Vec2,
    pub aerial_aerosol: Vec2,
    /// Moon direct-normal illuminance at the deck, before cloud attenuation.
    pub moon_lux: f32,
    /// Urban skyglow chromaticity and zenith-referenced luminance.
    pub skyglow_rgb: Vec3,
    pub skyglow_luminance: f32,
    /// Display lift applied to the sky's own night sources (stars via
    /// `star_gain`, skyglow, moon- and city-lit cloud): the night sky's
    /// long exposure. See `engine::build_sky_pass`.
    pub night_lift: f32,
    /// Exposure the *scene* (geometry, luminaires, Moon, stars) is rendered
    /// at: renderer pre-exposure over the camera EV.
    pub exposure_scene: f32,
    /// Exposure the atmosphere's own sky is rendered at. It differs from
    /// `exposure_scene` only through twilight, where the camera holds the
    /// sky a bounded number of stops darker than the lit street (see
    /// `engine::atmosphere_post_exposure_compensation`). Sun- and sky-lit
    /// cloud uses it so the deck sits at the same brightness as the sky
    /// behind it.
    pub exposure_sky: f32,
    /// cd/m^2 per unit of star-plate value.
    pub star_gain: f32,
    /// Peak luminance scale of the lunar disc, cd/m^2.
    pub moon_gain: f32,
    /// Angular size of one rendered pixel, radians.
    pub pixel_angle: f32,
    pub cloud_cover: f32,
    pub cloud_density: f32,
    pub cloud_type: f32,
    pub cloud_base_m: f32,
    pub cloud_top_m: f32,
    pub wind_x: f32,
    pub wind_z: f32,
    pub march_steps: f32,
    pub light_steps: f32,
    pub debug_mode: f32,
    /// Monotonic render time, seconds. Written by [`advance_sky_clock`].
    pub elapsed_seconds: f32,
}

impl Default for SkyPass {
    fn default() -> Self {
        Self {
            equ_from_world: Mat4::IDENTITY,
            altitude_m: 0.0,
            moon_dir: Vec3::Y,
            moon_angular_radius: 0.00465,
            moon_north: Vec3::Y,
            sub_earth_lon: 0.0,
            sub_earth_lat: 0.0,
            moon_sun_dir: Vec3::X,
            sun_dir: Vec3::NEG_Y,
            sun_lux: 0.0,
            sun_tint: Vec3::ONE,
            ground_bounce: 0.0,
            sky_ambient: Vec3::ZERO,
            aerial_rayleigh: Vec2::new(1.2e-5, 8_000.0),
            aerial_aerosol: Vec2::new(4.4e-6, 1_200.0),
            moon_lux: 0.0,
            skyglow_rgb: Vec3::new(0.78, 0.80, 0.88),
            skyglow_luminance: 0.0,
            night_lift: 1.0,
            exposure_scene: 1.0,
            exposure_sky: 1.0,
            star_gain: 1.0,
            moon_gain: 1.0,
            pixel_angle: 0.001,
            cloud_cover: 0.0,
            cloud_density: 1.0,
            cloud_type: 0.6,
            cloud_base_m: 1100.0,
            cloud_top_m: 3000.0,
            wind_x: 7.0,
            wind_z: 2.0,
            march_steps: 32.0,
            light_steps: 5.0,
            debug_mode: 0.0,
            elapsed_seconds: 0.0,
        }
    }
}

/// Monotonic render clock shared by every sky view.
///
/// Interactive previews advance it by measured wall time; recorded clips set
/// [`SkyClock::fixed_step`] so a clip is a deterministic function of its
/// frame index rather than of how fast the machine happened to render.
#[derive(Resource, Clone, Copy, Debug)]
pub struct SkyClock {
    pub seconds: f64,
    pub fixed_step: Option<f32>,
    origin: Option<std::time::Instant>,
}

impl Default for SkyClock {
    fn default() -> Self {
        Self {
            seconds: 0.0,
            fixed_step: None,
            origin: None,
        }
    }
}

impl SkyClock {
    /// Interactive previews track wall time, so the sky is a different sky
    /// three seconds later even though the renderer only ran a handful of
    /// frames in between. Recordings set `fixed_step` and the clock becomes a
    /// pure function of the frame index instead.
    pub fn advance(&mut self) -> f32 {
        match self.fixed_step {
            Some(step) => {
                self.seconds += step as f64;
                step
            }
            None => {
                let origin = *self.origin.get_or_insert_with(std::time::Instant::now);
                let previous = self.seconds;
                self.seconds = origin.elapsed().as_secs_f64();
                (self.seconds - previous) as f32
            }
        }
    }
}

/// The two NASA plates plus the two procedural noise volumes.
#[derive(Resource, Clone, ExtractResource)]
pub struct SkyAssets {
    pub star_plate: Handle<Image>,
    pub moon_plate: Handle<Image>,
    pub cloud_shape: Handle<Image>,
    pub cloud_detail: Handle<Image>,
}

/// Where the plates were loaded from, and their digests, for the manifest.
#[derive(Resource, Clone, Debug, Default)]
pub struct SkyAssetProvenance {
    pub entries: Vec<(String, String, u64)>,
}

pub struct SkyPassPlugin;

fn asset_dir() -> std::path::PathBuf {
    if let Ok(dir) = std::env::var("SIMFORGE_SKY_ASSETS") {
        return std::path::PathBuf::from(dir);
    }
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("assets/sky")
}

impl Plugin for SkyPassPlugin {
    fn build(&self, app: &mut App) {
        embedded_asset!(app, "shaders/sky_pass.wgsl");

        let dir = asset_dir();
        let star_path = dir.join("starmap_2020_8k.skytex");
        let moon_path = dir.join("moon_lroc_4k.skytex");
        let star = match crate::sky_texture::load_equirect(&star_path) {
            Ok(image) => image,
            Err(err) => {
                error!("sky pass: {err:#}");
                return;
            }
        };
        let moon = match crate::sky_texture::load_equirect(&moon_path) {
            Ok(image) => image,
            Err(err) => {
                error!("sky pass: {err:#}");
                return;
            }
        };
        let noise = crate::cloud_noise::CloudNoise::generate();
        let shape_image = noise.shape_image();
        let detail_image = noise.detail_image();

        let mut provenance = SkyAssetProvenance::default();
        for path in [&star_path, &moon_path] {
            provenance.entries.push((
                path.display().to_string(),
                crate::night::sha256_file(path).unwrap_or_else(|_| "unreadable".into()),
                std::fs::metadata(path).map(|m| m.len()).unwrap_or(0),
            ));
        }
        provenance.entries.push((
            "procedural:cloud-shape-128".into(),
            crate::night::sha256_bytes(&noise.shape),
            noise.shape.len() as u64,
        ));
        provenance.entries.push((
            "procedural:cloud-detail-32".into(),
            crate::night::sha256_bytes(&noise.detail),
            noise.detail.len() as u64,
        ));

        let assets = {
            let mut images = app.world_mut().resource_mut::<Assets<Image>>();
            SkyAssets {
                star_plate: images.add(star),
                moon_plate: images.add(moon),
                cloud_shape: images.add(shape_image),
                cloud_detail: images.add(detail_image),
            }
        };
        app.insert_resource(assets)
            .insert_resource(provenance)
            .insert_resource(crate::clouds::CloudField::new(noise))
            .init_resource::<SkyClock>()
            .add_plugins((
                ExtractComponentPlugin::<SkyPass>::default(),
                ExtractResourcePlugin::<SkyAssets>::default(),
            ))
            .add_systems(Last, advance_sky_clock);

        let Some(render_app) = app.get_sub_app_mut(RenderApp) else {
            return;
        };
        render_app
            .init_resource::<SkyUniforms>()
            .add_systems(RenderStartup, init_sky_pipeline)
            .add_systems(
                Render,
                (
                    prepare_sky_pipeline.in_set(RenderSystems::Prepare),
                    prepare_sky_uniforms.in_set(RenderSystems::PrepareResources),
                    prepare_sky_bind_groups.in_set(RenderSystems::PrepareBindGroups),
                ),
            )
            .add_systems(
                Core3d,
                // Strictly before `EarlyPostProcess`: TAA lives there and its
                // history must contain the sky. Left ambiguous with TAA, the
                // executor could run the two in either order on any frame, and
                // a frame whose predecessor resolved without the sky blended
                // 90% sky-less history into it: a one-frame black sky.
                sky_pass
                    .after(Core3dSystems::MainPass)
                    .before(Core3dSystems::EarlyPostProcess),
            );
    }
}

/// Advances the shared clock and stamps it onto every sky view.
fn advance_sky_clock(mut clock: ResMut<SkyClock>, mut views: Query<&mut SkyPass>) {
    clock.advance();
    let seconds = clock.seconds as f32;
    for mut view in &mut views {
        view.elapsed_seconds = seconds;
    }
}

// ------------------------------------------------------------------ GPU side

#[derive(Clone, Copy, ShaderType)]
struct GpuSky {
    world_from_clip: Mat4,
    equ_from_world: Mat4,
    camera: Vec4,
    moon: Vec4,
    moon_north: Vec4,
    moon_sun: Vec4,
    sun: Vec4,
    sun_tint: Vec4,
    sky_ambient: Vec4,
    skyglow: Vec4,
    p0: Vec4,
    p1: Vec4,
    p2: Vec4,
    p3: Vec4,
    p4: Vec4,
    p5: Vec4,
}

#[derive(Resource, Default)]
struct SkyUniforms(DynamicUniformBuffer<GpuSky>);

#[derive(Component)]
struct SkyOffset(u32);

#[derive(Component)]
struct SkyBindGroup(BindGroup);

#[derive(Component)]
struct SkyPipelineId(CachedRenderPipelineId);

#[derive(Resource)]
struct SkyPipeline {
    layout: BindGroupLayoutDescriptor,
    variants: Variants<RenderPipeline, SkySpecializer>,
}

struct SkySpecializer;

#[derive(PartialEq, Eq, Hash, Clone, Copy, SpecializerKey)]
struct SkyKey {
    target_format: TextureFormat,
}

/// Premultiplied "over": the shader emits `rgb = added radiance` and
/// `a = 1 - (weight the existing sky keeps)`, so the target becomes
/// `src.rgb + dst.rgb * (1 - src.a)`. The target's alpha is left alone.
fn over_blend() -> BlendState {
    BlendState {
        color: BlendComponent {
            src_factor: BlendFactor::One,
            dst_factor: BlendFactor::OneMinusSrcAlpha,
            operation: BlendOperation::Add,
        },
        alpha: BlendComponent {
            src_factor: BlendFactor::Zero,
            dst_factor: BlendFactor::One,
            operation: BlendOperation::Add,
        },
    }
}

impl Specializer<RenderPipeline> for SkySpecializer {
    type Key = SkyKey;

    fn specialize(
        &self,
        key: Self::Key,
        descriptor: &mut RenderPipelineDescriptor,
    ) -> Result<Canonical<Self::Key>, bevy::ecs::error::BevyError> {
        descriptor.fragment_mut()?.set_target(
            0,
            ColorTargetState {
                format: key.target_format,
                blend: Some(over_blend()),
                write_mask: ColorWrites::ALL,
            },
        );
        Ok(key)
    }
}

fn init_sky_pipeline(
    mut commands: Commands,
    asset_server: Res<AssetServer>,
    fullscreen_shader: Res<FullscreenShader>,
) {
    let layout = BindGroupLayoutDescriptor::new(
        "sky_pass_bind_group_layout",
        &BindGroupLayoutEntries::sequential(
            ShaderStages::FRAGMENT,
            (
                uniform_buffer::<GpuSky>(true),
                texture_2d(TextureSampleType::Float { filterable: true }),
                texture_2d(TextureSampleType::Float { filterable: true }),
                texture_3d(TextureSampleType::Float { filterable: true }),
                texture_3d(TextureSampleType::Float { filterable: true }),
                sampler(SamplerBindingType::Filtering),
                sampler(SamplerBindingType::Filtering),
            ),
        ),
    );
    let shader = match ShaderRef::Path("embedded://render_core/shaders/sky_pass.wgsl".into()) {
        ShaderRef::Path(path) => asset_server.load(path),
        _ => unreachable!(),
    };
    let descriptor = RenderPipelineDescriptor {
        label: Some("sky_pass_pipeline".into()),
        layout: vec![layout.clone()],
        vertex: fullscreen_shader.to_vertex_state(),
        fragment: Some(FragmentState {
            shader,
            targets: vec![Some(ColorTargetState {
                format: TextureFormat::Rgba16Float,
                blend: Some(over_blend()),
                write_mask: ColorWrites::ALL,
            })],
            ..default()
        }),
        depth_stencil: Some(DepthStencilState {
            format: CORE_3D_DEPTH_FORMAT,
            depth_write_enabled: Some(false),
            depth_compare: Some(CompareFunction::GreaterEqual),
            stencil: default(),
            bias: default(),
        }),
        ..default()
    };
    commands.insert_resource(SkyPipeline {
        layout,
        variants: Variants::new(SkySpecializer, descriptor),
    });
}

fn prepare_sky_pipeline(
    mut commands: Commands,
    pipeline_cache: Res<PipelineCache>,
    pipeline: Option<ResMut<SkyPipeline>>,
    views: Query<(Entity, &ViewTarget, Option<&SkyPass>)>,
) -> Result<(), bevy::ecs::error::BevyError> {
    let Some(mut pipeline) = pipeline else {
        return Ok(());
    };
    for (entity, target, sky) in &views {
        if sky.is_none() {
            commands.entity(entity).remove::<SkyPipelineId>();
            continue;
        }
        let id = pipeline.variants.specialize(
            &pipeline_cache,
            SkyKey {
                target_format: target.main_texture_format(),
            },
        )?;
        commands.entity(entity).insert(SkyPipelineId(id));
    }
    Ok(())
}

fn prepare_sky_uniforms(
    mut commands: Commands,
    device: Res<RenderDevice>,
    queue: Res<RenderQueue>,
    mut uniforms: ResMut<SkyUniforms>,
    views: Query<(Entity, &ExtractedView, &SkyPass)>,
) {
    // Only reset the buffer when there is something to put back in it. A
    // frame where the view query comes up momentarily empty used to leave a
    // cleared buffer behind a still-live bind group, and the pass then drew
    // one garbage frame - the random single-frame flash the clip QA caught.
    if views.iter().len() == 0 {
        return;
    }
    uniforms.0.clear();
    let mut offsets = Vec::new();
    for (entity, view, sky) in &views {
        let world_from_clip = view.world_from_view.to_matrix() * view.clip_from_view.inverse();
        let camera_pos = view.world_from_view.translation();
        let gpu = GpuSky {
            world_from_clip,
            equ_from_world: sky.equ_from_world,
            camera: camera_pos.extend(sky.altitude_m),
            moon: sky.moon_dir.normalize_or(Vec3::Y).extend(sky.moon_angular_radius),
            moon_north: sky.moon_north.normalize_or(Vec3::Y).extend(sky.sub_earth_lon),
            moon_sun: sky.moon_sun_dir.normalize_or(Vec3::X).extend(sky.sub_earth_lat),
            sun: sky.sun_dir.normalize_or(Vec3::NEG_Y).extend(sky.sun_lux),
            sun_tint: sky.sun_tint.extend(sky.ground_bounce),
            sky_ambient: sky.sky_ambient.extend(sky.aerial_aerosol.y),
            skyglow: sky.skyglow_rgb.extend(sky.skyglow_luminance),
            p0: Vec4::new(sky.exposure_scene, sky.star_gain, sky.moon_gain, sky.pixel_angle),
            p1: Vec4::new(
                sky.cloud_cover,
                sky.cloud_density,
                sky.elapsed_seconds,
                sky.cloud_type,
            ),
            p2: Vec4::new(sky.wind_x, sky.wind_z, sky.cloud_base_m, sky.cloud_top_m),
            p3: Vec4::new(
                sky.march_steps,
                sky.light_steps,
                sky.debug_mode,
                sky.moon_lux,
            ),
            p4: Vec4::new(
                sky.exposure_sky,
                sky.aerial_rayleigh.x,
                sky.aerial_rayleigh.y,
                sky.aerial_aerosol.x,
            ),
            p5: Vec4::new(sky.night_lift, 0.0, 0.0, 0.0),
        };
        offsets.push((entity, uniforms.0.push(&gpu)));
    }
    if !offsets.is_empty() {
        uniforms.0.write_buffer(&device, &queue);
    }
    for (entity, offset) in offsets {
        commands.entity(entity).insert(SkyOffset(offset));
    }
}

fn prepare_sky_bind_groups(
    mut commands: Commands,
    device: Res<RenderDevice>,
    pipeline_cache: Res<PipelineCache>,
    pipeline: Option<Res<SkyPipeline>>,
    uniforms: Res<SkyUniforms>,
    assets: Option<Res<SkyAssets>>,
    images: Res<RenderAssets<GpuImage>>,
    views: Query<(Entity, &SkyPass)>,
) {
    let (Some(pipeline), Some(assets)) = (pipeline, assets) else {
        return;
    };
    let Some(binding) = uniforms.0.binding() else {
        return;
    };
    let (Some(star), Some(moon), Some(shape), Some(detail)) = (
        images.get(&assets.star_plate),
        images.get(&assets.moon_plate),
        images.get(&assets.cloud_shape),
        images.get(&assets.cloud_detail),
    ) else {
        return;
    };
    let layout = pipeline_cache.get_bind_group_layout(&pipeline.layout);
    let bind_group = device.create_bind_group(
        "sky_pass_bind_group",
        &layout,
        &BindGroupEntries::sequential((
            binding,
            &star.texture_view,
            &moon.texture_view,
            &shape.texture_view,
            &detail.texture_view,
            &star.sampler,
            &shape.sampler,
        )),
    );
    for (entity, _) in &views {
        commands
            .entity(entity)
            .insert(SkyBindGroup(bind_group.clone()));
    }
}

fn sky_pass(
    view: ViewQuery<(
        &ViewTarget,
        &ViewDepthTexture,
        &SkyOffset,
        &SkyBindGroup,
        &SkyPipelineId,
    )>,
    pipeline_cache: Res<PipelineCache>,
    mut ctx: RenderContext,
) {
    let (view_target, depth, offset, bind_group, pipeline_id) = view.into_inner();
    let Some(pipeline) = pipeline_cache.get_render_pipeline(pipeline_id.0) else {
        return;
    };
    // `get_color_attachment` follows the active ViewTarget ping-pong texture;
    // the far-depth test below keeps every previously rendered surface intact.
    let color_attachment = view_target.get_color_attachment();
    let descriptor = RenderPassDescriptor {
        label: Some("sky_pass"),
        color_attachments: &[Some(color_attachment)],
        depth_stencil_attachment: Some(depth.get_attachment(StoreOp::Store)),
        timestamp_writes: None,
        occlusion_query_set: None,
        multiview_mask: None,
    };
    let mut pass = ctx.command_encoder().begin_render_pass(&descriptor);
    pass.set_pipeline(pipeline);
    pass.set_bind_group(0, &bind_group.0, &[offset.0]);
    pass.draw(0..3, 0..1);
}

/// A one-texel dummy so callers that need `RenderAssetUsages` symmetry keep
/// compiling if the plates are ever made optional.
pub fn _assert_render_asset_usage() -> RenderAssetUsages {
    RenderAssetUsages::RENDER_WORLD
}
