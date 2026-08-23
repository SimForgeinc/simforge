//! Deterministic radar model: ray fan + radial velocity from exact
//! scene-state velocities.
//!
//! Beam layout: a uniform azimuth x elevation grid across the declared FOV
//! (CARLA's radar is a fixed fan, no rotation). A ray that hits within range
//! yields one detection with
//!
//! - `depth_m`: hit distance along the beam,
//! - `azimuth_rad`: atan2(right, forward) of the beam in the sensor frame,
//! - `altitude_rad`: elevation of the beam,
//! - `velocity_mps`: relative radial velocity — projection of
//!   `(target velocity − sensor-host velocity)` onto the unit beam; static
//!   geometry returns minus the host motion component.
//!
//! Rows are emitted in strict (azimuth, elevation) order for hash stability;
//! format parity with carla-bridge's `_write_radar_csv` lives in
//! `formats::write_radar_csv`.

use crate::bvh::RaycastScene;
use bevy::math::{Quat, Vec3};

#[derive(Debug, Clone)]
pub struct RadarConfig {
    pub hfov_deg: f32,
    pub vfov_deg: f32,
    pub range_m: f32,
    /// Azimuth rays across the FOV (uniform).
    pub azimuth_rays: u32,
    /// Elevation rows across the FOV (uniform).
    pub elevation_rows: u32,
}

impl RadarConfig {
    /// Per-frame fan size from pointsPerSecond at a given tick rate, split
    /// into a square-ish grid.
    pub fn from_budget(
        pps: Option<u32>,
        tick_hz: f32,
        hfov_deg: f32,
        vfov_deg: f32,
        range_m: f32,
    ) -> RadarConfig {
        let per_frame = pps
            .map(|p| ((p as f32 / tick_hz.max(1e-6)).round() as u32).max(64))
            .unwrap_or(256);
        let side = ((per_frame as f32).sqrt().round() as u32).max(4);
        RadarConfig { hfov_deg, vfov_deg, range_m, azimuth_rays: side, elevation_rows: side }
    }
}

pub struct RadarDetection {
    pub depth: f32,
    /// Positive = to the left of forward (canonical +z).
    pub azimuth: f32,
    /// Positive = up.
    pub altitude: f32,
    /// Relative radial velocity in m/s along the beam.
    pub velocity: f32,
}

/// `instance_velocity` maps an instance id to its world-frame velocity (m/s);
/// static geometry maps to zero. `host_velocity` is the sensor host's
/// world-frame velocity.
pub fn scan(
    scene: &RaycastScene,
    config: &RadarConfig,
    origin: Vec3,
    rot: Quat,
    host_velocity: Vec3,
    instance_velocity: &dyn Fn(u32) -> Vec3,
) -> Vec<RadarDetection> {
    let mut out = Vec::with_capacity((config.azimuth_rays * config.elevation_rows) as usize);
    if config.azimuth_rays == 0 || config.elevation_rows == 0 {
        return out;
    }
    for az_i in 0..config.azimuth_rays {
        // Uniform azimuths centered on forward.
        let az = if config.azimuth_rays > 1 {
            (az_i as f32 / (config.azimuth_rays - 1) as f32 - 0.5) * config.hfov_deg.to_radians()
        } else {
            0.0
        };
        for el_j in 0..config.elevation_rows {
            let el = if config.elevation_rows > 1 {
                (el_j as f32 / (config.elevation_rows - 1) as f32 - 0.5)
                    * config.vfov_deg.to_radians()
            } else {
                0.0
            };
            // Sensor-frame direction: az positive toward +z (left), el up.
            let cos_e = el.cos();
            let dir_sensor = Vec3::new(cos_e * az.cos(), el.sin(), cos_e * az.sin());
            let dir_world = rot.mul_vec3(dir_sensor);
            if let Some(hit) = scene.cast(origin, dir_world, config.range_m) {
                let rel = instance_velocity(hit.instance_id) - host_velocity;
                let beam_unit = dir_world.normalize_or_zero();
                out.push(RadarDetection {
                    depth: hit.distance,
                    azimuth: az,
                    altitude: el,
                    velocity: rel.dot(beam_unit),
                });
            }
        }
    }
    out
}
