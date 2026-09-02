//! WSB4 lighting foundation ladder + sky/IBL utilities.
//!
//! Ladder (cumulative), per docs/native-renderer-production-plan.md WSB4:
//!   0. Spike baseline: 12k-lux sun + flat `GlobalAmbientLight` (the
//!      too-dark-shadow state — shadowed pixels get a constant gray).
//!   1. IBL: sky cubemap (map HDRI `env/sky.hdr` or the analytic gradient)
//!      CPU-prefiltered into irradiance + GGX mips; matching `Skybox`;
//!      flat ambient deleted.
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
use bevy::light::{DirectionalLight, EnvironmentMapLight, GlobalAmbientLight, LightProbe};
use bevy::math::{Dir3, Quat, Vec3, Vec4};
use bevy::transform::components::Transform;
use bevy::pbr::{ContactShadows, ScreenSpaceAmbientOcclusion};
use bevy::render::render_resource::{
    Extent3d, TextureDataOrder, TextureDimension, TextureFormat, TextureViewDescriptor,
    TextureViewDimension,
};

pub use crate::calibration::SUN_ANGULAR_DIAMETER_DEG;
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

/// Float RGB cubemap held CPU-side: six `n×n` faces in wgpu order
/// (+X, -X, +Y, -Y, +Z, -Z), face-major, row-major within a face.
#[derive(Clone, Debug)]
pub struct Cubemap {
    pub n: u32,
    pub texels: Vec<Vec3>,
}

impl Cubemap {
    /// Evaluate `shade(dir)` at every texel centre.
    pub fn from_fn(n: u32, shade: impl Fn(Vec3) -> Vec3) -> Self {
        let mut texels = Vec::with_capacity((6 * n * n) as usize);
        for face in 0..6u32 {
            for y in 0..n {
                for x in 0..n {
                    texels.push(shade(texel_direction(face, x, y, n)));
                }
            }
        }
        Self { n, texels }
    }

    fn texel(&self, face: u32, x: u32, y: u32) -> Vec3 {
        self.texels[((face * self.n + y) * self.n + x) as usize]
    }

    /// Nearest-texel lookup along `dir`.
    pub fn sample(&self, dir: Vec3) -> Vec3 {
        let (face, s, t) = face_coords(dir);
        let n = self.n as f32;
        let x = (((s + 1.0) * 0.5 * n) as i64).clamp(0, self.n as i64 - 1) as u32;
        let y = (((t + 1.0) * 0.5 * n) as i64).clamp(0, self.n as i64 - 1) as u32;
        self.texel(face, x, y)
    }

    /// 2×2 box-filtered half-resolution copy (clamps at 1×1).
    pub fn downsample(&self) -> Self {
        if self.n == 1 {
            return self.clone();
        }
        let n = self.n / 2;
        let mut texels = Vec::with_capacity((6 * n * n) as usize);
        for face in 0..6u32 {
            for y in 0..n {
                for x in 0..n {
                    let sum = self.texel(face, 2 * x, 2 * y)
                        + self.texel(face, 2 * x + 1, 2 * y)
                        + self.texel(face, 2 * x, 2 * y + 1)
                        + self.texel(face, 2 * x + 1, 2 * y + 1);
                    texels.push(sum * 0.25);
                }
            }
        }
        Self { n, texels }
    }

    /// Box-filtered mip chain down to 1×1; `chain[0]` is `self`.
    pub fn mip_chain(&self) -> Vec<Cubemap> {
        let mut chain = vec![self.clone()];
        while chain.last().unwrap().n > 1 {
            let next = chain.last().unwrap().downsample();
            chain.push(next);
        }
        chain
    }

    fn write_rgba32f(&self, out: &mut Vec<u8>) {
        for c in &self.texels {
            out.extend_from_slice(&c.x.to_le_bytes());
            out.extend_from_slice(&c.y.to_le_bytes());
            out.extend_from_slice(&c.z.to_le_bytes());
            out.extend_from_slice(&1.0f32.to_le_bytes());
        }
    }

    /// Single-mip `Rgba32Float` cube `Image` (skybox / unfiltered use).
    pub fn image(&self) -> Image {
        let mut data = Vec::with_capacity((6 * self.n * self.n * 16) as usize);
        self.write_rgba32f(&mut data);
        cube_image(self.n, 1, data)
    }

    /// Split-sum IBL inputs for `EnvironmentMapLight`, filtered on the CPU
    /// (deterministic, GPU-history independent):
    /// - diffuse: 32² Lambertian irradiance (`∫L cosθ dω / π`);
    /// - specular: full mip chain, level `i` GGX-prefiltered at perceptual
    ///   roughness `i / (levels - 1)`, matching bevy's
    ///   `radiance_level = perceptual_roughness * smallest_mip` lookup.
    pub fn prefilter(&self) -> PrefilteredEnvironment {
        let chain = self.mip_chain();
        let levels = chain.len() as u32;
        let base_texel_solid_angle = 4.0 * std::f32::consts::PI / (6.0 * (self.n * self.n) as f32);
        // Mip whose texel solid angle best matches a sample's footprint.
        let level_for_solid_angle = |omega: f32| -> usize {
            let lod = 0.5 * (omega / base_texel_solid_angle).max(1.0).log2() + 1.0;
            (lod.round() as usize).min(chain.len() - 1)
        };

        let diffuse = Cubemap::from_fn(32, |normal| {
            const SAMPLES: u32 = 512;
            let (tangent, bitangent) = orthonormal_basis(normal);
            let mut sum = Vec3::ZERO;
            for i in 0..SAMPLES {
                let (u, v) = hammersley(i, SAMPLES);
                // Cosine-weighted hemisphere: pdf = cosθ / π.
                let phi = 2.0 * std::f32::consts::PI * u;
                let cos_theta = (1.0 - v).sqrt();
                let sin_theta = v.sqrt();
                let dir = tangent * (sin_theta * phi.cos())
                    + bitangent * (sin_theta * phi.sin())
                    + normal * cos_theta;
                let pdf = cos_theta / std::f32::consts::PI;
                let level = level_for_solid_angle(1.0 / (SAMPLES as f32 * pdf.max(1e-4)));
                sum += chain[level].sample(dir);
            }
            sum / SAMPLES as f32
        });

        let mut specular_data = Vec::new();
        chain[0].write_rgba32f(&mut specular_data);
        for level in 1..levels {
            const SAMPLES: u32 = 128;
            let perceptual_roughness = level as f32 / (levels - 1) as f32;
            let alpha = (perceptual_roughness * perceptual_roughness).max(1e-3);
            let filtered = Cubemap::from_fn(chain[level as usize].n, |normal| {
                // Split-sum approximation with N = V = R.
                let (tangent, bitangent) = orthonormal_basis(normal);
                let mut sum = Vec3::ZERO;
                let mut weight = 0.0f32;
                for i in 0..SAMPLES {
                    let (u, v) = hammersley(i, SAMPLES);
                    let phi = 2.0 * std::f32::consts::PI * u;
                    let cos_theta = ((1.0 - v) / (1.0 + (alpha * alpha - 1.0) * v)).sqrt();
                    let sin_theta = (1.0 - cos_theta * cos_theta).max(0.0).sqrt();
                    let half = tangent * (sin_theta * phi.cos())
                        + bitangent * (sin_theta * phi.sin())
                        + normal * cos_theta;
                    let light = half * (2.0 * normal.dot(half)) - normal;
                    let n_dot_l = normal.dot(light);
                    if n_dot_l <= 0.0 {
                        continue;
                    }
                    // pdf = D(h) · (n·h) / (4 · v·h) = D(h) / 4 when V = N.
                    let d = ggx_d(cos_theta, alpha);
                    let sample_level = level_for_solid_angle(4.0 / (SAMPLES as f32 * d.max(1e-6)));
                    sum += chain[sample_level].sample(light) * n_dot_l;
                    weight += n_dot_l;
                }
                if weight > 0.0 {
                    sum / weight
                } else {
                    chain[level as usize].sample(normal)
                }
            });
            filtered.write_rgba32f(&mut specular_data);
        }

        PrefilteredEnvironment {
            diffuse: diffuse.image(),
            specular: cube_image(self.n, levels, specular_data),
        }
    }
}

/// CPU-prefiltered split-sum environment: irradiance + roughness mip chain.
pub struct PrefilteredEnvironment {
    pub diffuse: Image,
    pub specular: Image,
}

/// Direction through the centre of texel `(x, y)` on `face` (wgpu cube order).
fn texel_direction(face: u32, x: u32, y: u32, n: u32) -> Vec3 {
    let s = (2.0 * (x as f32 + 0.5) / n as f32) - 1.0;
    let t = (2.0 * (y as f32 + 0.5) / n as f32) - 1.0;
    match face {
        0 => Vec3::new(1.0, -t, -s),
        1 => Vec3::new(-1.0, -t, s),
        2 => Vec3::new(s, 1.0, -t),
        3 => Vec3::new(s, -1.0, t),
        4 => Vec3::new(s, -t, 1.0),
        _ => Vec3::new(-s, -t, -1.0),
    }
    .normalize()
}

/// Inverse of `texel_direction`: `(face, s, t)` with `s, t ∈ [-1, 1]`.
fn face_coords(dir: Vec3) -> (u32, f32, f32) {
    let a = dir.abs();
    if a.x >= a.y && a.x >= a.z {
        if dir.x > 0.0 {
            (0, -dir.z / a.x, -dir.y / a.x)
        } else {
            (1, dir.z / a.x, -dir.y / a.x)
        }
    } else if a.y >= a.z {
        if dir.y > 0.0 {
            (2, dir.x / a.y, -dir.z / a.y)
        } else {
            (3, dir.x / a.y, dir.z / a.y)
        }
    } else if dir.z > 0.0 {
        (4, dir.x / a.z, -dir.y / a.z)
    } else {
        (5, -dir.x / a.z, -dir.y / a.z)
    }
}

fn orthonormal_basis(normal: Vec3) -> (Vec3, Vec3) {
    let up = if normal.y.abs() < 0.999 { Vec3::Y } else { Vec3::X };
    let tangent = up.cross(normal).normalize();
    (tangent, normal.cross(tangent))
}

fn hammersley(i: u32, count: u32) -> (f32, f32) {
    (
        (i as f32 + 0.5) / count as f32,
        (i.reverse_bits() as f64 * 2.328_306_4e-10) as f32,
    )
}

fn ggx_d(n_dot_h: f32, alpha: f32) -> f32 {
    let a2 = alpha * alpha;
    let d = n_dot_h * n_dot_h * (a2 - 1.0) + 1.0;
    a2 / (std::f32::consts::PI * d * d)
}

fn cube_image(n: u32, mip_level_count: u32, data: Vec<u8>) -> Image {
    // `Image::new` asserts `data.len()` against mip 0 only; the chain carries
    // every level, so build uninitialised and attach the data explicitly.
    let mut image = Image::new_uninit(
        Extent3d {
            width: n,
            height: n,
            depth_or_array_layers: 6,
        },
        TextureDimension::D2,
        TextureFormat::Rgba32Float,
        RenderAssetUsages::default(),
    );
    image.data = Some(data);
    image.data_order = TextureDataOrder::MipMajor;
    image.texture_descriptor.mip_level_count = mip_level_count;
    image.texture_view_descriptor = Some(TextureViewDescriptor {
        dimension: Some(TextureViewDimension::Cube),
        mip_level_count: Some(mip_level_count),
        ..Default::default()
    });
    image
}

/// Deterministic analytic clear-sky gradient cubemap for scenes that ship no
/// HDRI: horizon→zenith Rayleigh-ish gradient, a Mie-like forward glow around
/// the sun, and a dim ground hemisphere. Normalised to the same ≈1.26 mean
/// sky luma as the measured map HDRIs so `HDRI_TO_CDM2` applies unchanged
/// (docs/lighting-calibration.md §Sky).
pub fn synthetic_sky_cubemap(sun_dir: Dir3, face_size: u32) -> Cubemap {
    // `sun_dir` is the direction light TRAVELS; the sun sits opposite it.
    let to_sun = (-Vec3::from(*sun_dir)).normalize();
    let zenith = Vec3::new(0.20, 0.42, 0.86);
    let horizon = Vec3::new(0.86, 0.92, 1.02);
    let ground = Vec3::new(0.28, 0.26, 0.23);
    // Mean sky luma of the raw gradient, integrated over the upper
    // hemisphere, is ≈0.66; scale to the measured HDRI normalisation of 1.26.
    const SKY_LUMA_NORMALISATION: f32 = 1.26 / 0.66;
    Cubemap::from_fn(face_size, |dir| {
        let sun_amount = dir.dot(to_sun).max(0.0);
        // Broad forward-scatter glow; the solar disc itself is direct light,
        // not IBL, so the lobe stays wide and modest.
        let glow = sun_amount.powf(24.0) * 1.4 + sun_amount.powf(3.0) * 0.18;
        let c = if dir.y >= 0.0 {
            let t = dir.y.powf(0.6);
            horizon.lerp(zenith, t) + Vec3::splat(glow)
        } else {
            // Ground hemisphere: horizon-lit albedo falling off downward.
            ground * (1.0 - (-dir.y).powf(0.5) * 0.6)
        };
        c * SKY_LUMA_NORMALISATION
    })
}

/// Load an equirectangular `.hdr` file and convert it to a cubemap
/// (power-of-two face size) entirely on CPU — deterministic and independent
/// of GPU filtering history.
///
/// Equirect mapping is v = 0.5 − asin(y)/π (top of image = up),
/// u = 0.5 + atan2(z, x)/2π with bilinear sampling and horizontal wrap.
pub fn load_sky_cubemap(path: &str, face_size: u32) -> Result<Cubemap> {
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

    Ok(Cubemap::from_fn(face_size, |dir| {
        let u = 0.5 + dir.z.atan2(dir.x) / std::f32::consts::TAU;
        let v = 0.5 - dir.y.asin() / std::f32::consts::PI;
        sample(u, v)
    }))
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
    // HDRI path for the sky/IBL; `None` generates the deterministic analytic
    // gradient sky from `sun_dir` (`synthetic_sky_cubemap`).
    sky_hdr_path: Option<&str>,
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
        let sky = match sky_hdr_path {
            Some(path) => load_sky_cubemap(path, 512)?,
            None => synthetic_sky_cubemap(sun_dir, 512),
        };
        // Split-sum IBL needs an irradiance map and a roughness-prefiltered
        // specular mip chain; bevy picks `radiance_level = roughness * mips`,
        // so a single-mip cubemap would mirror the sky on every surface no
        // matter how rough it is. Filter on the CPU (deterministic) rather
        // than through `GeneratedEnvironmentMapLight`'s GPU passes.
        let filtered = sky.prefilter();
        let handle = images.add(sky.image());
        // LightProbe influence is the entity transform's scaled 2×2×2 cube;
        // the default transform is a 1 m cube at the origin, which misses the
        // world-space scene entirely (tiles sit ~1.7 km out). Cover everything.
        commands.spawn((
            LightProbe::default(),
            Transform::from_scale(Vec3::splat(1_000_000.0)),
            EnvironmentMapLight {
                diffuse_map: images.add(filtered.diffuse),
                specular_map: images.add(filtered.specular),
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn face_coords_inverts_texel_direction() {
        let n = 16;
        for face in 0..6 {
            for y in 0..n {
                for x in 0..n {
                    let dir = texel_direction(face, x, y, n);
                    let (f, s, t) = face_coords(dir);
                    assert_eq!(f, face, "face for {dir:?}");
                    let xs = ((s + 1.0) * 0.5 * n as f32) as u32;
                    let ys = ((t + 1.0) * 0.5 * n as f32) as u32;
                    assert_eq!((xs, ys), (x, y), "texel for {dir:?}");
                }
            }
        }
    }

    #[test]
    fn prefilter_preserves_constant_radiance() {
        let sky = Cubemap::from_fn(32, |_| Vec3::new(0.5, 1.0, 2.0));
        let filtered = sky.prefilter();
        let levels = 6;
        assert_eq!(filtered.specular.texture_descriptor.mip_level_count, levels);
        let expected_len: usize = (0..levels).map(|l| 6 * (32usize >> l).pow(2) * 16).sum();
        assert_eq!(filtered.specular.data.as_ref().unwrap().len(), expected_len);
        for image in [&filtered.diffuse, &filtered.specular] {
            let data = image.data.as_ref().unwrap();
            for px in data.chunks_exact(16) {
                let g = f32::from_le_bytes([px[4], px[5], px[6], px[7]]);
                let b = f32::from_le_bytes([px[8], px[9], px[10], px[11]]);
                assert!((g - 1.0).abs() < 1e-3 && (b - 2.0).abs() < 1e-3, "{g} {b}");
            }
        }
    }

    #[test]
    fn rough_specular_blurs_horizon() {
        // Sharp sky/ground split: mirror level keeps it, rough levels blend it.
        let sky = Cubemap::from_fn(64, |d| if d.y > 0.0 { Vec3::ONE } else { Vec3::ZERO });
        let filtered = sky.prefilter();
        let data = filtered.specular.data.as_ref().unwrap();
        let read = |offset: usize| f32::from_le_bytes(data[offset..offset + 4].try_into().unwrap());
        // Level 0, +X face, one texel above and below the horizon row.
        let row = |y: usize| (y * 64 + 32) * 16;
        assert_eq!(read(row(31)), 1.0);
        assert_eq!(read(row(32)), 0.0);
        // Roughest level (1×1 faces): +X face averages sky and ground.
        let last = data.len() - 6 * 16;
        let v = read(last);
        assert!(v > 0.2 && v < 0.8, "roughest level not blended: {v}");
    }
}
