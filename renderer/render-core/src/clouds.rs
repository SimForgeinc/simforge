//! CPU mirror of the GPU cloud field.
//!
//! `shaders/sky_pass.wgsl` raymarches the deck for the *visible* sky; this
//! module evaluates the identical density function on the CPU so the Moon's
//! `DirectionalLight` and the sky IBL are attenuated by the same optical
//! depth the picture shows. Every constant here has a named counterpart in
//! the shader and the pair is checked by `tests::cpu_matches_shader_constants`.

use crate::cloud_noise::CloudNoise;
use bevy::math::{Vec2, Vec3};

pub const CLOUD_TILE_M: f32 = 26_000.0;
pub const DETAIL_TILE_M: f32 = 1_300.0;
pub const EARTH_R: f32 = 6_371_000.0;
pub const MAX_CLOUD_DIST: f32 = 140_000.0;
/// Extinction per metre at unit density; a 1.9 km deck at density 1 reaches
/// an optical depth of ~105, i.e. fully opaque, as a real stratocumulus is.
pub const SIGMA: f32 = 0.055;
/// The dilated Perlin-Worley base has a narrow column-max distribution
/// (measured 0.56..0.94 over one tile, median 0.81). `smoothstep(BASE_LOW,
/// BASE_HIGH, base)` is a fit of that distribution's CDF, so the stretched
/// base is close to uniform on 0..1 and the cover threshold `1 - cover`
/// covers the sky linearly (`tests::sky_cover_tracks_authored_cover`).
pub const BASE_LOW: f32 = 0.668;
pub const BASE_HIGH: f32 = 0.94;

fn smoothstep(lo: f32, hi: f32, x: f32) -> f32 {
    let t = ((x - lo) / (hi - lo)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

#[derive(Clone, Copy, Debug)]
pub struct CloudParams {
    pub cover: f32,
    pub density: f32,
    /// 0 stratus, 0.5 stratocumulus, 1 cumulus.
    pub kind: f32,
    pub base_m: f32,
    pub top_m: f32,
    pub wind: Vec2,
    pub time_s: f32,
}

impl Default for CloudParams {
    fn default() -> Self {
        Self {
            cover: 0.0,
            density: 1.0,
            kind: 0.6,
            base_m: 1_100.0,
            top_m: 3_000.0,
            wind: Vec2::new(7.0, 2.0),
            time_s: 0.0,
        }
    }
}

fn sat(x: f32) -> f32 {
    x.clamp(0.0, 1.0)
}

fn remap(v: f32, lo: f32, hi: f32, to_lo: f32, to_hi: f32) -> f32 {
    to_lo + (v - lo) / (hi - lo).max(1e-6) * (to_hi - to_lo)
}

/// The generated volumes, held for the lifetime of the app.
#[derive(bevy::prelude::Resource)]
pub struct CloudField {
    noise: CloudNoise,
}

impl CloudField {
    pub fn new(noise: CloudNoise) -> Self {
        Self { noise }
    }

    fn height_fraction(&self, altitude: f32, p: &CloudParams) -> f32 {
        sat((altitude - p.base_m) / (p.top_m - p.base_m).max(1.0))
    }

    fn gradient(h: f32, kind: f32) -> f32 {
        let stratus = sat(remap(h, 0.0, 0.10, 0.0, 1.0)) * sat(remap(h, 0.16, 0.34, 1.0, 0.0));
        let stratocu = sat(remap(h, 0.0, 0.16, 0.0, 1.0)) * sat(remap(h, 0.42, 0.72, 1.0, 0.0));
        let cumulus = sat(remap(h, 0.02, 0.26, 0.0, 1.0)) * sat(remap(h, 0.58, 1.0, 1.0, 0.0));
        let low = stratus + (stratocu - stratus) * sat(kind * 2.0);
        low + (cumulus - low) * sat(kind * 2.0 - 1.0)
    }

    /// `world` is `(x, altitude, z)`, matching the shader's call convention.
    pub fn density(&self, world: Vec3, altitude: f32, p: &CloudParams, cheap: bool) -> f32 {
        let h = self.height_fraction(altitude, p);
        if h <= 0.0 || h >= 1.0 {
            return 0.0;
        }
        let wind = Vec3::new(p.wind.x, 0.0, p.wind.y) * p.time_s;
        let pos = world + wind + Vec3::new(0.0, p.time_s * 0.12, 0.0);
        let uvw = pos / CLOUD_TILE_M;
        let shape = self.noise.sample_shape(uvw);
        let modulation = self
            .noise
            .sample_shape(uvw * 0.4237 + Vec3::new(0.317, 0.113, 0.731))
            .x;
        let billow = shape.y * 0.625 + shape.z * 0.25 + shape.w * 0.125;
        // Perlin-Worley dilation compresses the base; `smoothstep` over its
        // measured column-max band is the CDF fit that makes `cover` a
        // linear threshold (see the constants' doc).
        let dilated = sat(remap(shape.x, billow - 1.0, 1.0, 0.0, 1.0));
        let base = smoothstep(BASE_LOW, BASE_HIGH, dilated) * Self::gradient(h, p.kind);
        let cover = sat(p.cover * (0.75 + 0.5 * modulation));
        let mut d = sat(remap(base, 1.0 - cover, 1.0, 0.0, 1.0));
        if d <= 0.0 {
            return 0.0;
        }
        if !cheap {
            let det = self.noise.sample_detail(pos / DETAIL_TILE_M);
            let erode = det.x * 0.625 + det.y * 0.25 + det.z * 0.125;
            let edge = 1.0 - sat(d * 3.0);
            d = sat(remap(d, erode * 0.55 * edge, 1.0, 0.0, 1.0));
        }
        d * p.density
    }

    fn sphere_exit(origin: Vec3, dir: Vec3, r: f32) -> f32 {
        let b = origin.dot(dir);
        let c = origin.dot(origin) - r * r;
        let disc = b * b - c;
        if disc < 0.0 {
            return -1.0;
        }
        -b + disc.sqrt()
    }

    /// Optical depth along `dir` from an observer at `altitude_m`, using the
    /// same shell intersection and the same density field as the raymarch.
    pub fn optical_depth(
        &self,
        origin_xz: Vec2,
        altitude_m: f32,
        dir: Vec3,
        p: &CloudParams,
        steps: usize,
    ) -> f32 {
        if p.cover <= 0.001 || dir.y <= 0.004 {
            return 0.0;
        }
        let origin = Vec3::new(0.0, EARTH_R + altitude_m, 0.0);
        let t_in = Self::sphere_exit(origin, dir, EARTH_R + p.base_m);
        let t_out = Self::sphere_exit(origin, dir, EARTH_R + p.top_m);
        if t_in < 0.0 || t_out <= t_in {
            return 0.0;
        }
        let near = t_in.max(0.0);
        let far = t_out.min(MAX_CLOUD_DIST);
        if far <= near {
            return 0.0;
        }
        let dt = (far - near) / steps as f32;
        let mut tau = 0.0;
        let mut t = near + dt * 0.5;
        for _ in 0..steps {
            let sample = origin + dir * t;
            let altitude = sample.length() - EARTH_R;
            let world = Vec3::new(origin_xz.x + dir.x * t, altitude, origin_xz.y + dir.z * t);
            tau += self.density(world, altitude, p, false) * SIGMA * dt;
            t += dt;
        }
        tau
    }

    pub fn transmittance(
        &self,
        origin_xz: Vec2,
        altitude_m: f32,
        dir: Vec3,
        p: &CloudParams,
        steps: usize,
    ) -> f32 {
        (-self.optical_depth(origin_xz, altitude_m, dir, p, steps)).exp()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn field() -> CloudField {
        CloudField::new(CloudNoise::generate())
    }

    #[test]
    fn clear_sky_is_fully_transmissive() {
        let f = field();
        let p = CloudParams {
            cover: 0.0,
            ..Default::default()
        };
        let t = f.transmittance(Vec2::ZERO, 0.0, Vec3::new(0.2, 0.9, 0.1).normalize(), &p, 24);
        assert!((t - 1.0).abs() < 1e-6);
    }

    #[test]
    fn overcast_extinguishes_the_moon() {
        let f = field();
        let p = CloudParams {
            cover: 1.0,
            density: 1.0,
            ..Default::default()
        };
        let t = f.transmittance(Vec2::ZERO, 0.0, Vec3::new(0.0, 1.0, 0.0).normalize(), &p, 32);
        assert!(t < 0.02, "overcast zenith transmittance {t} is too high");
    }

    #[test]
    fn broken_cover_varies_with_direction() {
        let f = field();
        let p = CloudParams {
            cover: 0.45,
            ..Default::default()
        };
        let mut seen: Vec<f32> = Vec::new();
        for i in 0..24 {
            let a = i as f32 / 24.0 * std::f32::consts::TAU;
            let dir = Vec3::new(a.cos() * 0.5, 0.7, a.sin() * 0.5).normalize();
            seen.push(f.transmittance(Vec2::ZERO, 0.0, dir, &p, 24));
        }
        let lo = seen.iter().cloned().fold(f32::MAX, f32::min);
        let hi = seen.iter().cloned().fold(f32::MIN, f32::max);
        assert!(hi - lo > 0.2, "broken cover is uniform: {lo}..{hi}");
    }

    #[test]
    fn wind_moves_the_field() {
        let f = field();
        let a = CloudParams {
            cover: 0.5,
            time_s: 0.0,
            ..Default::default()
        };
        let b = CloudParams {
            cover: 0.5,
            time_s: 3.0,
            ..Default::default()
        };
        // One ray can sit in a gap before and after; the field as a whole
        // must have moved.
        let mut moved = 0.0f32;
        for i in 0..16 {
            let ang = i as f32 / 16.0 * std::f32::consts::TAU;
            let dir = Vec3::new(ang.cos() * 0.6, 0.8, ang.sin() * 0.6).normalize();
            let ta = f.optical_depth(Vec2::ZERO, 0.0, dir, &a, 32);
            let tb = f.optical_depth(Vec2::ZERO, 0.0, dir, &b, 32);
            moved += (ta - tb).abs();
        }
        assert!(moved > 1e-3, "three seconds of wind changed nothing: {moved}");
    }

    /// Fraction of zenith rays across one tile that meet optically thick
    /// cloud, for a few authored covers. The field's `cover` is defined by
    /// this number; see `sky_cover_tracks_authored_cover`.
    fn zenith_hit_fraction(f: &CloudField, cover: f32, density: f32) -> f32 {
        let p = CloudParams {
            cover,
            density,
            ..Default::default()
        };
        let n = 24;
        let mut hits = 0;
        for i in 0..n {
            for j in 0..n {
                let xz = Vec2::new(i as f32 / n as f32, j as f32 / n as f32) * CLOUD_TILE_M;
                let t = f.transmittance(xz, 0.0, Vec3::Y, &p, 24);
                if t < 0.5 {
                    hits += 1;
                }
            }
        }
        hits as f32 / (n * n) as f32
    }

    #[test]
    fn sky_cover_tracks_authored_cover() {
        let f = field();
        let hits: Vec<(f32, f32)> = [0.2f32, 0.45, 0.8]
            .into_iter()
            .map(|cover| (cover, zenith_hit_fraction(&f, cover, 1.0)))
            .collect();
        eprintln!("zenith hit fractions: {hits:?}");
        for (cover, hit) in hits {
            assert!(
                (hit - cover).abs() < 0.15,
                "cover {cover} produced a zenith hit fraction of {hit:.3}"
            );
        }
    }

    /// Where `BASE_LOW` / `BASE_HIGH` come from: the column maxima of the
    /// dilated base over one tile. Run with `--ignored --nocapture` after
    /// changing the noise recipe and update the constants from the 0% and
    /// 100% quantiles.
    #[test]
    #[ignore = "calibration probe, prints the band the constants encode"]
    fn dilated_base_column_max_band() {
        let f = field();
        let p = CloudParams::default();
        let n = 20;
        let mut bests: Vec<f32> = Vec::new();
        for i in 0..n {
            for j in 0..n {
                let x = i as f32 / n as f32 * CLOUD_TILE_M;
                let z = j as f32 / n as f32 * CLOUD_TILE_M;
                let mut best = 0.0f32;
                for k in 0..16 {
                    let alt = p.base_m + (k as f32 + 0.5) / 16.0 * (p.top_m - p.base_m);
                    let h = f.height_fraction(alt, &p);
                    let shape = f.noise.sample_shape(Vec3::new(x, alt, z) / CLOUD_TILE_M);
                    let billow = shape.y * 0.625 + shape.z * 0.25 + shape.w * 0.125;
                    let base = sat(remap(shape.x, billow - 1.0, 1.0, 0.0, 1.0))
                        * CloudField::gradient(h, p.kind);
                    best = best.max(base);
                }
                bests.push(best);
            }
        }
        bests.sort_by(f32::total_cmp);
        let q = |p: f32| bests[((bests.len() - 1) as f32 * p) as usize];
        eprintln!(
            "column-max quantiles: 0%{:.3} 10%{:.3} 50%{:.3} 90%{:.3} 100%{:.3}",
            q(0.0), q(0.1), q(0.5), q(0.9), q(1.0)
        );
    }
}
