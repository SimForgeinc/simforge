//! Deterministic tiling 3D noise volumes for the raymarched cloud layer.
//!
//! One generator serves both consumers so the GPU raymarch and the CPU
//! optical-depth solve that attenuates the Moon's `DirectionalLight` read
//! *the same field*, not two lookalike approximations:
//!
//! * [`CloudNoise::shape`] - 128^3 RGBA8. `R` is a Perlin-Worley blend at the
//!   cloud-blob scale, `G`/`B`/`A` are inverted Worley at 2x/4x/8x for the
//!   billow cascade (Schneider & Vos, *The Real-Time Volumetric Cloudscapes
//!   of Horizon Zero Dawn*, SIGGRAPH 2015).
//! * [`CloudNoise::detail`] - 32^3 RGBA8, three inverted Worley octaves used
//!   to erode the shape's edges.
//!
//! Everything tiles exactly on the lattice, so world-space sampling wraps
//! seamlessly, and everything is a pure function of the constant seeds below,
//! so the volumes are byte-identical on every run and every machine.

use bevy::asset::RenderAssetUsages;
use bevy::image::{Image, ImageAddressMode, ImageFilterMode, ImageSampler, ImageSamplerDescriptor};
use bevy::math::{Vec3, Vec4};
use bevy::render::render_resource::{Extent3d, TextureDimension, TextureFormat};

pub const SHAPE_SIZE: usize = 128;
pub const DETAIL_SIZE: usize = 32;

const SEED_PERLIN: u32 = 0x5F35_6495;
const SEED_WORLEY: [u32; 3] = [0x27D4_EB2D, 0x1656_67B1, 0x85EB_CA6B];
const SEED_DETAIL: [u32; 3] = [0x9E37_79B9, 0xC2B2_AE35, 0x7FEB_352D];

fn hash3(x: i32, y: i32, z: i32, seed: u32) -> u32 {
    let mut h = (x as u32)
        .wrapping_mul(0x8DA6_B343)
        ^ (y as u32).wrapping_mul(0xD8163841)
        ^ (z as u32).wrapping_mul(0xCB1A_B31F)
        ^ seed;
    h ^= h >> 16;
    h = h.wrapping_mul(0x7FEB_352D);
    h ^= h >> 15;
    h = h.wrapping_mul(0x846C_A68B);
    h ^= h >> 16;
    h
}

fn hash01(x: i32, y: i32, z: i32, seed: u32) -> f32 {
    hash3(x, y, z, seed) as f32 / u32::MAX as f32
}

fn hash_point(x: i32, y: i32, z: i32, seed: u32) -> Vec3 {
    Vec3::new(
        hash01(x, y, z, seed),
        hash01(x, y, z, seed ^ 0x1234_5678),
        hash01(x, y, z, seed ^ 0x9ABC_DEF0),
    )
}

fn fade(t: f32) -> f32 {
    t * t * t * (t * (t * 6.0 - 15.0) + 10.0)
}

/// Tiling gradient (Perlin) noise on an integer lattice of `freq` cells.
fn perlin_tileable(p: Vec3, freq: i32, seed: u32) -> f32 {
    let s = p * freq as f32;
    let i = s.floor();
    let f = s - i;
    let (ix, iy, iz) = (i.x as i32, i.y as i32, i.z as i32);
    let grad = |dx: i32, dy: i32, dz: i32| -> f32 {
        let gx = (ix + dx).rem_euclid(freq);
        let gy = (iy + dy).rem_euclid(freq);
        let gz = (iz + dz).rem_euclid(freq);
        let g = hash_point(gx, gy, gz, seed) * 2.0 - Vec3::ONE;
        let g = g.normalize_or(Vec3::X);
        let d = f - Vec3::new(dx as f32, dy as f32, dz as f32);
        g.dot(d)
    };
    let (u, v, w) = (fade(f.x), fade(f.y), fade(f.z));
    let lerp = |a: f32, b: f32, t: f32| a + (b - a) * t;
    let x00 = lerp(grad(0, 0, 0), grad(1, 0, 0), u);
    let x10 = lerp(grad(0, 1, 0), grad(1, 1, 0), u);
    let x01 = lerp(grad(0, 0, 1), grad(1, 0, 1), u);
    let x11 = lerp(grad(0, 1, 1), grad(1, 1, 1), u);
    lerp(lerp(x00, x10, v), lerp(x01, x11, v), w) * 0.5 + 0.5
}

fn perlin_fbm(p: Vec3, freq: i32, octaves: u32, seed: u32) -> f32 {
    let mut sum = 0.0;
    let mut amp = 0.5;
    let mut norm = 0.0;
    let mut f = freq;
    for o in 0..octaves {
        sum += amp * perlin_tileable(p, f, seed ^ (o.wrapping_mul(0x9E37_79B9)));
        norm += amp;
        amp *= 0.5;
        f *= 2;
    }
    sum / norm
}

/// Tiling Worley noise, returned inverted so 1.0 sits at the feature points.
fn worley_tileable(p: Vec3, freq: i32, seed: u32) -> f32 {
    let s = p * freq as f32;
    let i = s.floor();
    let mut nearest = f32::MAX;
    for dz in -1..=1 {
        for dy in -1..=1 {
            for dx in -1..=1 {
                let cell = i + Vec3::new(dx as f32, dy as f32, dz as f32);
                let wx = (cell.x as i32).rem_euclid(freq);
                let wy = (cell.y as i32).rem_euclid(freq);
                let wz = (cell.z as i32).rem_euclid(freq);
                let feature = cell + hash_point(wx, wy, wz, seed);
                nearest = nearest.min((feature - s).length_squared());
            }
        }
    }
    (1.0 - nearest.sqrt()).clamp(0.0, 1.0)
}

fn worley_fbm(p: Vec3, freq: i32, seed: u32) -> f32 {
    worley_tileable(p, freq, seed) * 0.625
        + worley_tileable(p, freq * 2, seed ^ 0x51) * 0.25
        + worley_tileable(p, freq * 4, seed ^ 0xA3) * 0.125
}

fn remap(v: f32, lo: f32, hi: f32, to_lo: f32, to_hi: f32) -> f32 {
    to_lo + (v - lo) / (hi - lo).max(1e-6) * (to_hi - to_lo)
}

/// Both volumes, plus their CPU-resident copies for the optical-depth solve.
pub struct CloudNoise {
    pub shape: Vec<u8>,
    pub detail: Vec<u8>,
}

fn fill_parallel(size: usize, channels: usize, f: impl Fn(Vec3) -> [f32; 4] + Sync) -> Vec<u8> {
    let threads = std::thread::available_parallelism()
        .map(|n| n.get().min(16))
        .unwrap_or(4);
    let slices_per_thread = size.div_ceil(threads);
    let mut out = vec![0u8; size * size * size * channels];
    let chunk = size * size * channels * slices_per_thread;
    std::thread::scope(|scope| {
        for (t, block) in out.chunks_mut(chunk).enumerate() {
            let f = &f;
            scope.spawn(move || {
                let z0 = t * slices_per_thread;
                let mut cursor = 0usize;
                for z in z0..(z0 + slices_per_thread).min(size) {
                    for y in 0..size {
                        for x in 0..size {
                            let p = Vec3::new(
                                (x as f32 + 0.5) / size as f32,
                                (y as f32 + 0.5) / size as f32,
                                (z as f32 + 0.5) / size as f32,
                            );
                            let v = f(p);
                            for c in 0..channels {
                                block[cursor + c] = (v[c].clamp(0.0, 1.0) * 255.0 + 0.5) as u8;
                            }
                            cursor += channels;
                        }
                    }
                }
            });
        }
    });
    out
}

impl CloudNoise {
    pub fn generate() -> Self {
        let shape = fill_parallel(SHAPE_SIZE, 4, |p| {
            // Six normalised octaves of gradient noise cluster around 0.5
            // (roughly 0.35..0.65), which after the Perlin-Worley dilation
            // left the base channel spanning only 0.49..0.80 - a deck with
            // no holes at any cover. Stretch the fBm over its own central
            // range first so the base channel really spans 0..1 and cover
            // thresholds carve real gaps.
            let perlin = remap(perlin_fbm(p, 4, 6, SEED_PERLIN), 0.30, 0.70, 0.0, 1.0).clamp(0.0, 1.0);
            let worley_low = worley_fbm(p, 4, SEED_WORLEY[0]);
            // Perlin-Worley: dilate the Perlin field by the billow field so
            // the base shape has rounded cauliflower edges instead of the
            // soapy blobs plain fBm gives.
            let perlin_worley = remap(perlin, worley_low - 1.0, 1.0, 0.0, 1.0).clamp(0.0, 1.0);
            [
                perlin_worley,
                worley_fbm(p, 4, SEED_WORLEY[0]),
                worley_fbm(p, 8, SEED_WORLEY[1]),
                worley_fbm(p, 16, SEED_WORLEY[2]),
            ]
        });
        let detail = fill_parallel(DETAIL_SIZE, 4, |p| {
            [
                worley_fbm(p, 2, SEED_DETAIL[0]),
                worley_fbm(p, 4, SEED_DETAIL[1]),
                worley_fbm(p, 8, SEED_DETAIL[2]),
                1.0,
            ]
        });
        Self { shape, detail }
    }

    pub fn shape_image(&self) -> Image {
        volume_image("cloud-shape", SHAPE_SIZE, self.shape.clone())
    }

    pub fn detail_image(&self) -> Image {
        volume_image("cloud-detail", DETAIL_SIZE, self.detail.clone())
    }

    /// Trilinear, wrapping sample of the shape volume - the exact filter the
    /// GPU sampler applies, so the CPU optical depth matches the raymarch.
    pub fn sample_shape(&self, p: Vec3) -> Vec4 {
        sample_volume(&self.shape, SHAPE_SIZE, p)
    }

    pub fn sample_detail(&self, p: Vec3) -> Vec4 {
        sample_volume(&self.detail, DETAIL_SIZE, p)
    }
}

fn volume_image(label: &str, size: usize, data: Vec<u8>) -> Image {
    let mut image = Image::new(
        Extent3d {
            width: size as u32,
            height: size as u32,
            depth_or_array_layers: size as u32,
        },
        TextureDimension::D3,
        data,
        TextureFormat::Rgba8Unorm,
        RenderAssetUsages::RENDER_WORLD,
    );
    image.sampler = ImageSampler::Descriptor(ImageSamplerDescriptor {
        label: Some(label.into()),
        address_mode_u: ImageAddressMode::Repeat,
        address_mode_v: ImageAddressMode::Repeat,
        address_mode_w: ImageAddressMode::Repeat,
        mag_filter: ImageFilterMode::Linear,
        min_filter: ImageFilterMode::Linear,
        mipmap_filter: ImageFilterMode::Linear,
        ..Default::default()
    });
    image
}

fn sample_volume(data: &[u8], size: usize, p: Vec3) -> Vec4 {
    let n = size as f32;
    let s = Vec3::new(p.x * n - 0.5, p.y * n - 0.5, p.z * n - 0.5);
    let base = s.floor();
    let f = s - base;
    let idx = |x: i32, y: i32, z: i32| -> usize {
        let x = x.rem_euclid(size as i32) as usize;
        let y = y.rem_euclid(size as i32) as usize;
        let z = z.rem_euclid(size as i32) as usize;
        (z * size * size + y * size + x) * 4
    };
    let fetch = |x: i32, y: i32, z: i32| -> Vec4 {
        let i = idx(x, y, z);
        Vec4::new(
            data[i] as f32,
            data[i + 1] as f32,
            data[i + 2] as f32,
            data[i + 3] as f32,
        ) / 255.0
    };
    let (bx, by, bz) = (base.x as i32, base.y as i32, base.z as i32);
    let lerp = |a: Vec4, b: Vec4, t: f32| a + (b - a) * t;
    let x00 = lerp(fetch(bx, by, bz), fetch(bx + 1, by, bz), f.x);
    let x10 = lerp(fetch(bx, by + 1, bz), fetch(bx + 1, by + 1, bz), f.x);
    let x01 = lerp(fetch(bx, by, bz + 1), fetch(bx + 1, by, bz + 1), f.x);
    let x11 = lerp(fetch(bx, by + 1, bz + 1), fetch(bx + 1, by + 1, bz + 1), f.x);
    lerp(lerp(x00, x10, f.y), lerp(x01, x11, f.y), f.z)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn volumes_are_deterministic_and_tile() {
        let a = CloudNoise::generate();
        assert_eq!(a.shape.len(), SHAPE_SIZE * SHAPE_SIZE * SHAPE_SIZE * 4);
        // Wrapping is exact: sampling one lattice period away is identical.
        let p = Vec3::new(0.31, 0.62, 0.17);
        let q = p + Vec3::new(1.0, -1.0, 2.0);
        let sa = a.sample_shape(p);
        let sb = a.sample_shape(q);
        assert!((sa - sb).abs().max_element() < 1e-6);
    }

    #[test]
    fn shape_field_has_usable_contrast() {
        let noise = CloudNoise::generate();
        let mut lo = f32::MAX;
        let mut hi = f32::MIN;
        for i in 0..4096 {
            let p = Vec3::new(
                (i % 16) as f32 / 16.0,
                ((i / 16) % 16) as f32 / 16.0,
                ((i / 256) % 16) as f32 / 16.0,
            );
            let v = noise.sample_shape(p).x;
            lo = lo.min(v);
            hi = hi.max(v);
        }
        assert!(hi - lo > 0.4, "shape contrast {lo}..{hi} is too flat");
    }
}
