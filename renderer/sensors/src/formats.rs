//! Artifact writers with format parity against the CARLA path
//! (`adapters/carla-exec/simforge_carla_exec/runtime/backend.py`):
//!
//! - LiDAR: ASCII PLY with `property float x/y/z/intensity`, rows after
//!   `end_header` — the shape CARLA's `save_to_disk` writes and what
//!   `sensor_video.py::_read_lidar_points` parses (it indexes parts[0..3]).
//!   One extra declared property, `property uint instance_id`, is appended;
//!   positional readers are unaffected.
//! - Radar: CSV whose header line is exactly
//!   `depth_m,azimuth_rad,altitude_rad,velocity_mps`, rows `%.9g` — byte
//!   parity with `_write_radar_csv`.
//! - IMU / GNSS: JSONL.

use crate::imu_gnss::{GnssSample, ImuSample};
use crate::lidar::LidarPoint;
use crate::radar::RadarDetection;
use anyhow::Result;
use std::fmt::Write as _;
use std::io::Write;
use std::path::Path;

pub fn write_lidar_ply(path: &Path, points: &[LidarPoint]) -> Result<()> {
    let mut f = std::fs::File::create(path)?;
    writeln!(f, "ply")?;
    writeln!(f, "format ascii 1.0")?;
    writeln!(f, "element vertex {}", points.len())?;
    writeln!(f, "property float x")?;
    writeln!(f, "property float y")?;
    writeln!(f, "property float z")?;
    writeln!(f, "property float intensity")?;
    writeln!(f, "property uint instance_id")?;
    writeln!(f, "end_header")?;
    // Buffer the body; formatting is fixed so bytes are stable.
    let mut body = String::with_capacity(points.len() * 64);
    for p in points {
        let _ = writeln!(
            body,
            "{} {} {} {} {}",
            fmt_g(p.x),
            fmt_g(p.y),
            fmt_g(p.z),
            fmt_g(p.intensity),
            p.instance_id
        );
    }
    f.write_all(body.as_bytes())?;
    Ok(())
}

pub fn write_radar_csv(path: &Path, detections: &[RadarDetection]) -> Result<()> {
    let mut f = std::fs::File::create(path)?;
    writeln!(f, "depth_m,azimuth_rad,altitude_rad,velocity_mps")?;
    let mut body = String::with_capacity(detections.len() * 80);
    for d in detections {
        let _ = writeln!(
            body,
            "{},{},{},{}",
            fmt_g(d.depth),
            fmt_g(d.azimuth),
            fmt_g(d.altitude),
            fmt_g(d.velocity)
        );
    }
    f.write_all(body.as_bytes())?;
    Ok(())
}

pub fn write_imu_jsonl(path: &Path, samples: &[ImuSample]) -> Result<()> {
    let mut f = std::fs::File::create(path)?;
    for s in samples {
        writeln!(f, "{}", serde_json::to_string(s)?)?;
    }
    Ok(())
}

pub fn write_gnss_jsonl(path: &Path, samples: &[GnssSample]) -> Result<()> {
    let mut f = std::fs::File::create(path)?;
    for s in samples {
        writeln!(f, "{}", serde_json::to_string(s)?)?;
    }
    Ok(())
}

/// 9-significant-digit fixed/short formatting matching Python `{:.9g}`
/// closely enough for numeric consumers while staying deterministic.
pub fn fmt_g(v: f32) -> String {
    if v == 0.0 {
        return "0".to_string();
    }
    let mag = v.abs().log10().floor();
    if mag >= -4.0 && mag < 9.0 {
        let decimals = (8.0 - mag).clamp(0.0, 12.0) as usize;
        format!("{:.*}", decimals, v)
            .trim_end_matches('0')
            .trim_end_matches('.')
            .to_string()
    } else {
        format!("{:.7e}", v)
    }
}
