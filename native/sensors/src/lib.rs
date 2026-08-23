//! sensors: CARLA-surface sensor suite on top of render-core (WSB3).
//!
//! Modules:
//! - [`rig`]: Pronto port-E rig + chase camera parsing.
//! - [`taxonomy`]: semantic class taxonomy and legend types.
//! - [`scene_state`]: scene-state.v1 consumer.
//! - [`bvh`]: deterministic CPU raycast scene (triangle soup + BVH).
//! - [`lidar`]: beam-pattern raycast lidar model.
//! - [`radar`]: ray-fan radar with exact radial velocities.
//! - [`imu_gnss`]: ego-track IMU/GNSS derivation + inverse tmerc geodetic.
//! - [`formats`]: carla-bridge-format artifact writers (PLY/CSV/JSONL).
//! - [`capture`]: the multi-camera multi-pass capture harness (bin
//!   `sensor-capture` drives it).

pub mod bvh;
pub mod capture;
pub mod formats;
pub mod imu_gnss;
pub mod lidar;
pub mod radar;
pub mod rig;
pub mod scene_state;
pub mod taxonomy;

/// sha256 of a byte slice, hex-encoded.
pub fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(bytes);
    hex::encode(digest)
}

/// sha256 of a file's contents, hex-encoded.
pub fn sha256_file(path: &std::path::Path) -> anyhow::Result<String> {
    Ok(sha256_hex(&std::fs::read(path)?))
}
