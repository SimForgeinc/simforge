//! Deterministic spinning-lidar model.
//!
//! Beam pattern: `channels` elevation rings evenly spaced across the vertical
//! FOV, and an azimuth resolution derived from
//! `points_per_second / (channels * rotation_frequency_hz)` — i.e. the number
//! of azimuth steps per revolution CARLA's rotational lidar would produce.
//! One captured scan is one full revolution starting at azimuth step 0.
//!
//! Each beam is raycast against the scene BVH. Returns per point:
//! sensor-frame `{x, y, z}`, an intensity proxy, and the owning instance id.
//! Points are emitted in strict (channel, azimuth) order for hash stability.

use crate::bvh::{Hit, RaycastScene};
use crate::taxonomy::{lidar_albedo, SemanticClass};
use bevy::math::{Quat, Vec3};

#[derive(Debug, Clone)]
pub struct LidarConfig {
    pub channels: u32,
    pub rotation_frequency_hz: f32,
    pub points_per_second: u32,
    /// Vertical FOV extent in degrees: beams span [-vfov/2, +vfov/2].
    pub vfov_deg: f32,
    /// Horizontal coverage in degrees; 360 = full rotation.
    pub hfov_deg: f32,
    pub range_m: f32,
}

impl LidarConfig {
    pub fn azimuth_steps(&self) -> u32 {
        if self.rotation_frequency_hz <= 0.0 || self.channels == 0 {
            return 360;
        }
        let per_channel =
            self.points_per_second as f32 / (self.channels as f32 * self.rotation_frequency_hz);
        (per_channel.round() as u32).clamp(64, 4096)
    }
}

pub struct LidarPoint {
    /// Sensor-frame metres (x forward, y up, z left — canonical frame).
    pub x: f32,
    pub y: f32,
    pub z: f32,
    /// Intensity proxy in [0, 1].
    pub intensity: f32,
    pub instance_id: u32,
}

/// Beam direction in the sensor frame: azimuth 0 = forward, positive toward
/// +z (left); elevation positive up.
fn beam_dir(azimuth_rad: f32, elevation_rad: f32) -> Vec3 {
    let cos_e = elevation_rad.cos();
    Vec3::new(cos_e * azimuth_rad.cos(), elevation_rad.sin(), cos_e * azimuth_rad.sin())
}

/// Cast one full scan.
///
/// `instance_class` resolves a hit instance id to its semantic class for the
/// intensity proxy.
pub fn scan(
    scene: &RaycastScene,
    config: &LidarConfig,
    sensor_origin_world: Vec3,
    sensor_rot_world: Quat,
    instance_class: &dyn Fn(u32) -> SemanticClass,
) -> Vec<LidarPoint> {
    let channels = config.channels.max(1);
    let az_steps = config.azimuth_steps();
    let mut points = Vec::with_capacity((channels * az_steps) as usize);
    let hfov_span = if config.hfov_deg >= 359.999 { 360.0 } else { config.hfov_deg };
    let az_offset = if config.hfov_deg >= 359.999 { 0.0 } else { hfov_span.to_radians() * 0.5 };
    for ch in 0..channels {
        // Evenly spaced elevations across [-vfov/2, +vfov/2], top-down.
        let frac = if channels > 1 { ch as f32 / (channels - 1) as f32 } else { 0.5 };
        let elev = (config.vfov_deg * (0.5 - frac)).to_radians();
        for step in 0..az_steps {
            let az = (step as f32 / az_steps as f32) * hfov_span.to_radians() - az_offset;
            let dir_sensor = beam_dir(az, elev);
            let dir_world = sensor_rot_world.mul_vec3(dir_sensor);
            if let Some(hit) = scene.cast(sensor_origin_world, dir_world, config.range_m) {
                points.push(LidarPoint {
                    x: hit.point.x - sensor_origin_world.x,
                    y: hit.point.y - sensor_origin_world.y,
                    z: hit.point.z - sensor_origin_world.z,
                    intensity: intensity_proxy(&hit, dir_world, instance_class),
                    instance_id: hit.instance_id,
                });
            }
        }
    }
    points
}

/// Intensity proxy: albedo(class) x (0.25 + 0.75 x |cos incidence|), clamped
/// to [0,1] — a deterministic, physically-motivated stand-in for reflectivity
/// (documented in TAXONOMY.md).
fn intensity_proxy(
    hit: &Hit,
    beam_dir_world: Vec3,
    instance_class: &dyn Fn(u32) -> SemanticClass,
) -> f32 {
    let class = instance_class(hit.instance_id);
    let cosine = hit.normal.dot(-beam_dir_world.normalize_or_zero()).abs();
    lidar_albedo(class).mul_add(0.25 + 0.75 * cosine, 0.0).clamp(0.0, 1.0)
}
