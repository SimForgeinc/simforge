//! WSB4 lighting foundation ladder + sky/IBL utilities.
//!
//! Ladder (cumulative), per docs/native-renderer-production-plan.md WSB4:
//!   0. Spike baseline: 12k-lux sun + flat `GlobalAmbientLight` (the
//!      too-dark-shadow state — shadowed pixels get a constant gray).
//!   1. IBL: `GeneratedEnvironmentMapLight` filtered from the map's HDRI sky
//!      (`env/sky.hdr`) + matching `Skybox`; flat ambient deleted.
//!   2. Physical units: ~100k lux clear-day sun + calibrated fixed EV100.
//!   3. GTAO (`ScreenSpaceAmbientOcclusion`) + contact shadows.
//!   4. PCSS soft shadows on the cascades (`soft_shadow_size`, sun angular
//!      diameter) behind the `pcss` cargo feature.
//!   5. Solari raytraced GI behind the `solari` cargo feature (5080 tier).
//!
//! All values are deterministic; no time-based inputs.

use anyhow::{Context, Result};
use bevy::asset::RenderAssetUsages;
use bevy::camera::Exposure;
use bevy::color::Color;
use bevy::image::Image;
use bevy::light::{
    DirectionalLight, EnvironmentMapLight, GeneratedEnvironmentMapLight, GlobalAmbientLight,
    LightProbe,
};
use bevy::math::{Dir3, Quat, Vec3, Vec4};
use bevy::transform::components::Transform;
use bevy::pbr::{ContactShadows, ScreenSpaceAmbientOcclusion};
use bevy::render::render_resource::{
    Extent3d, TextureDimension, TextureFormat, TextureViewDescriptor, TextureViewDimension,
};

/// Direct normal+horizontal sunlight illuminance on a clear day (WMO/CIE
/// clear-sky midday value ≈ 100_000 lx).
pub const CLEAR_DAY_SUN_LUX: f32 = 100_000.0;
/// EV100 for direct sunlight (ISO 100): log2(100000/2.5) ≈ 15.3, standard
/// sunny-16 calibration.
pub const SUNLIGHT_EV100: f32 = 15.0;
/// Sun angular diameter seen from Earth, in degrees.
pub const SUN_ANGULAR_DIAMETER_DEG: f32 = 0.53;
/// Ground-plane height of the yale-street corpus (see spike FINDINGS §5).
pub const GROUND_Y: f32 = 12.99;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LightingRung(pub u8);

impl LightingRung {
    pub fn ibl(&self) -> bool {
        self.0 >= 1
    }
    pub fn physical_sun(&self) -> bool {
        self.0 >= 2
    }
    pub fn ao_contact(&self) -> bool {
        self.0 >= 3
    }
    pub fn pcss(&self) -> bool {
        self.0 >= 4
    }
}

/// Approximate blackbody color temperature → linear sRGB (Tanner Helland /
/// Neil Bartlett approximation, converted to linear space). Deterministic.
pub fn kelvin_to_rgb(kelvin: f32) -> Color {
    let t = kelvin / 100.0;
    let (r, g, b) = if t <= 66.0 {
        let r = 255.0f32;
        let g = (99.4708025861 * t.ln() - 161.1195681661).clamp(0.0, 255.0);
        let b = if t <= 19.0 {
            0.0
        } else {
            (138.5177312231 * (t - 10.0).ln() - 305.0447927307).clamp(0.0, 255.0)
        };
        (r, g, b)
    } else {
        let r = (329.698727446 * (t - 60.0f32).powf(-0.1332047592)).clamp(0.0, 255.0);
        let g = (288.1221695283 * (t - 60.0f32).powf(-0.0755148492)).clamp(0.0, 255.0);
        let b = 255.0;
        (r, g, b)
    };
    // sRGB → linear
    let lin = |c: f32| {
        let c = c / 255.0;
        if c <= 0.04045 {
            c / 12.92
        } else {
            ((c + 0.055) / 1.055).powf(2.4)
        }
    };
    Color::srgb(lin(r), lin(g), lin(b))
}

/// Load an equirectangular `.hdr` file and convert it to a cubemap `Image`
/// (6 array layers, Rgba32Float, power-of-two face size) entirely on CPU —
/// deterministic and independent of GPU filtering history.
///
/// Face layout follows wgpu/OpenGL cube conventions (+X,-X,+Y,-Y,+Z,-Z);
/// equirect mapping is v = 0.5 − asin(y)/π (top of image = up),
/// u = 0.5 + atan2(z, x)/2π with bilinear sampling and horizontal wrap.
pub fn load_sky_cubemap(path: &str, face_size: u32) -> Result<Image> {
    let file = std::fs::File::open(path).with_context(|| format!("open hdri {path}"))?;
    let decoder =
        image::codecs::hdr::HdrDecoder::new(std::io::BufReader::new(file)).context("hdr decode")?;
    let meta = decoder.metadata();
    let dynamic = image::DynamicImage::from_decoder(decoder).context("hdr to dynamic")?;
    let buf = dynamic.as_rgb32f().context("hdr not rgb32f")?;
    let (ew, eh) = (meta.width as usize, meta.height as usize);

    let sample = |u: f32, v: f32| -> Vec3 {
        // u in [0,1) wraps horizontally; v clamped vertically.
        let x = u.rem_euclid(1.0) * (ew as f32) - 0.5;
        let y = (v.clamp(0.0, 1.0)) * (eh as f32) - 0.5;
        let x0 = x.floor() as i64;
        let y0 = y.floor() as i64;
        let fx = x - x0 as f32;
        let fy = y - y0 as f32;
        let px = |xi: i64, yi: i64| -> Vec3 {
            let xi = xi.rem_euclid(ew as i64) as usize;
            let yi = yi.clamp(0, eh as i64 - 1) as usize;
            let p = buf.get_pixel(xi as u32, yi as u32);
            Vec3::new(p[0], p[1], p[2])
        };
        px(x0, y0) * (1.0 - fx) * (1.0 - fy)
            + px(x0 + 1, y0) * fx * (1.0 - fy)
            + px(x0, y0 + 1) * (1.0 - fx) * fy
            + px(x0 + 1, y0 + 1) * fx * fy
    };

    let n = face_size;
    let mut data: Vec<u8> = Vec::with_capacity((n * n * 6 * 16) as usize);
    for f in 0..6u32 {
        for y in 0..n {
            for x in 0..n {
                let s = (2.0 * (x as f32 + 0.5) / n as f32) - 1.0;
                let t = (2.0 * (y as f32 + 0.5) / n as f32) - 1.0;
                let dir = match f {
                    0 => Vec3::new(1.0, -t, -s),
                    1 => Vec3::new(-1.0, -t, s),
                    2 => Vec3::new(s, 1.0, -t),
                    3 => Vec3::new(s, -1.0, t),
                    4 => Vec3::new(s, -t, 1.0),
                    _ => Vec3::new(-s, -t, -1.0),
                }
                .normalize();
                let u = 0.5 + dir.z.atan2(dir.x) / std::f32::consts::TAU;
                let v = 0.5 - dir.y.asin() / std::f32::consts::PI;
                let c = sample(u, v);
                data.extend_from_slice(&c.x.to_le_bytes());
                data.extend_from_slice(&c.y.to_le_bytes());
                data.extend_from_slice(&c.z.to_le_bytes());
                data.extend_from_slice(&1.0f32.to_le_bytes());
            }
        }
    }

    let mut image = Image::new(
        Extent3d {
            width: n,
            height: n,
            depth_or_array_layers: 6,
        },
        TextureDimension::D2,
        data,
        TextureFormat::Rgba32Float,
        RenderAssetUsages::default(),
    );
    image.texture_view_descriptor = Some(TextureViewDescriptor {
        dimension: Some(TextureViewDimension::Cube),
        ..Default::default()
    });
    Ok(image)
}

/// Per-rung lighting parameters resolved against weather (set by weather.rs
/// before spawning lights).
pub struct LightingPlan {
    pub sun_lux: f32,
    pub sun_color: Color,
    /// None ⇒ leave camera exposure unset (cinematic auto-exposure path).
    pub ev100_fixed: Option<f32>,
    pub env_intensity: f32,
    pub skybox_brightness: f32,
}

/// Spawn/apply the lighting ladder. Called once at Startup after weather
/// modifiers are known. Returns nothing; entities are spawned directly.
pub fn spawn_lighting(
    commands: &mut bevy::prelude::Commands,
    images: &mut bevy::asset::Assets<Image>,
    rung: LightingRung,
    plan: &LightingPlan,
    sun_dir: Dir3,
    cascade_max_distance: f32,
    sky_hdr_path: &str,
    legacy_args: (f32, f32), // (spike lux, spike ambient) used only at rung 0
) -> Result<Option<bevy::asset::Handle<Image>>> {
    if !rung.ibl() {
        // Rung 0 — the documented "too dark" baseline: flat constant ambient.
        commands.spawn(GlobalAmbientLight {
            color: Color::srgb(1.0, 0.98, 0.94),
            brightness: legacy_args.1.max(0.01),
            affects_lightmapped_meshes: true,
        });
    }

    commands.spawn((
        DirectionalLight {
            illuminance: if rung.physical_sun() {
                plan.sun_lux
            } else {
                legacy_args.0
            },
            color: plan.sun_color,
            shadow_maps_enabled: true,
            contact_shadows_enabled: rung.ao_contact(),
            soft_shadow_size: if rung.pcss() {
                // Angular size converted by bevy internally; supply the sun's
                // angular diameter so penumbras widen realistically.
                Some(SUN_ANGULAR_DIAMETER_DEG.to_radians())
            } else {
                None
            },
            ..Default::default()
        },
        bevy::light::cascade::CascadeShadowConfigBuilder {
            minimum_distance: 1.0,
            maximum_distance: cascade_max_distance,
            num_cascades: 4,
            ..Default::default()
        }
        .build(),
        VolumetricLightMarker,
        bevy::prelude::Transform::IDENTITY.looking_to(sun_dir, Vec3::Y),
    ));

    let mut sky_handle = None;
    if rung.ibl() {
        let image = load_sky_cubemap(sky_hdr_path, 512)?;
        let handle = images.add(image);
        // Runtime GPU filtering of GeneratedEnvironmentMapLight contributed
        // no measurable diffuse here; use the direct EnvironmentMapLight path
        // with the CPU-side cubemap for both lobes.
        // LightProbe influence is the entity transform's scaled 2×2×2 cube;
        // the default transform is a 1 m cube at the origin, which misses the
        // world-space scene entirely (tiles sit ~1.7 km out). Cover everything.
        commands.spawn((
            LightProbe::default(),
            Transform::from_scale(Vec3::splat(1_000_000.0)),
            EnvironmentMapLight {
                diffuse_map: handle.clone(),
                specular_map: handle.clone(),
                intensity: plan.env_intensity,
                rotation: Quat::IDENTITY,
                affects_lightmapped_mesh_diffuse: true,
            },
        ));
        sky_handle = Some(handle);
    }
    Ok(sky_handle)
}

/// Marker so weather.rs can attach `VolumetricLight` to the sun when fog is
/// active without lighting.rs depending on the weather module.
#[derive(bevy::prelude::Component)]
pub struct VolumetricLightMarker;

/// Fixed-EV100 exposure for the sensor profile, calibrated per weather.
pub fn sensor_exposure(weather_ev100: f32) -> Exposure {
    Exposure { ev100: weather_ev100 }
}

/// Attach GTAO + contact shadows to a camera view (rung ≥ 3).
pub fn apply_camera_ao(commands: &mut bevy::prelude::Commands, entity: bevy::prelude::Entity) {
    commands.entity(entity).insert((
        ScreenSpaceAmbientOcclusion::default(),
        ContactShadows::default(),
    ));
}
