//! Rig definitions: the Pronto port-E 18-sensor rig plus the trailing chase
//! camera, parsed from `qualification/render-qualification-program.v1.json`
//! (`prontoRig`).
//!
//! Source frame (per the qualification program): vehicle sheet in
//! longitudinal-mm / lateral-right-mm / up-mm with yaw/pitch/roll degrees.
//! Canonical frame: x-forward, y-up, z-left; metres; radians — matching the
//! lowering math in `adapters/carla-bridge/.../run_local.py`
//! (`POD_FRONT_DATUM_M = 0.85`, `POD_PLATE_HEIGHT_M = 1.78`):
//!
//! ```text
//! x = 0.85 + longitudinal_mm / 1000
//! y = 1.78 + up_mm          / 1000
//! z = -lateralRight_mm      / 1000
//! ```
//!
//! The trailing chase camera (`chase-cam-trailing`) is a presentation view,
//! not a measurement sensor; it rides outside the 18-sensor rig exactly like
//! the CARLA path treats it.

use anyhow::{bail, Context, Result};
use bevy::prelude::Resource;
use serde::{Deserialize, Serialize};

pub const CHASE_CAMERA_SENSOR_ID: &str = "chase-cam-trailing";
const POD_FRONT_DATUM_M: f32 = 0.85;
const POD_PLATE_HEIGHT_M: f32 = 1.78;

/// One mount in the canonical vehicle frame.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Mount {
    /// Metres forward of the vehicle origin.
    pub x: f32,
    /// Metres up from the ground plane.
    pub y: f32,
    /// Metres left (+) / right (-).
    pub z: f32,
    /// Yaw around +Y, radians, 0 = forward.
    pub yaw: f32,
    /// Pitch, radians, positive up.
    pub pitch: f32,
    /// Roll around forward axis, radians.
    pub roll: f32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SensorKind {
    Camera,
    Lidar,
    Radar,
}

/// A fully-resolved rig sensor in canonical units.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RigSensor {
    pub id: String,
    pub label: String,
    pub kind: SensorKind,
    pub mount: Mount,
    /// Cameras: vertical FOV derived from horizontal FOV and the render aspect
    /// ratio; lidar/radar: declared field-of-view extents in degrees.
    pub horizontal_fov_deg: f32,
    pub vertical_fov_deg: Option<f32>,
    /// Max range in metres (lidar 200 / radar 100 per the qualification lib;
    /// cameras use the shared scene far plane).
    pub range_m: f32,
    /// Lidar beam pattern config (see `lidar::BeamPattern::for_sensor`).
    pub lidar_channels: u32,
    /// Lidar rotation frequency (Hz); one scan is captured per output frame.
    pub rotation_frequency_hz: f32,
    /// Radar points-per-second budget lowered to per-frame detections.
    pub points_per_second: Option<u32>,
}

/// The full Pronto port-E rig plus chase camera.
#[derive(Debug, Clone, Serialize, Deserialize, Resource)]
pub struct RigSpec {
    pub rig_id: String,
    pub sensors: Vec<RigSensor>,
}

impl RigSpec {
    pub fn cameras(&self) -> impl Iterator<Item = &RigSensor> {
        self.sensors.iter().filter(|s| s.kind == SensorKind::Camera)
    }
    pub fn lidars(&self) -> impl Iterator<Item = &RigSensor> {
        self.sensors.iter().filter(|s| s.kind == SensorKind::Lidar)
    }
    pub fn radars(&self) -> impl Iterator<Item = &RigSensor> {
        self.sensors.iter().filter(|s| s.kind == SensorKind::Radar)
    }
    pub fn chase(&self) -> Option<&RigSensor> {
        self.sensors.iter().find(|s| s.id == CHASE_CAMERA_SENSOR_ID)
    }
}

/// Raw `prontoRig.sensors[]` entry shape from the qualification program JSON.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawSensor {
    id: String,
    #[serde(rename = "type")]
    kind: String,
    #[allow(dead_code)]
    label: String,
    #[serde(default)]
    horizontal_fov_deg: Option<f32>,
    #[serde(default)]
    vertical_fov_deg: Option<f32>,
    source_mount_mm: RawMountMm,
    #[serde(default)]
    rotation_deg: RawRotationDeg,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawMountMm {
    longitudinal: f32,
    lateral_right: f32,
    up: f32,
}

#[derive(Debug, Default, Deserialize)]
struct RawRotationDeg {
    #[serde(default)]
    yaw: f32,
    #[serde(default)]
    pitch: f32,
    #[serde(default)]
    roll: f32,
}

fn mount_from_sheet(m: &RawMountMm, r: &RawRotationDeg) -> Mount {
    Mount {
        x: POD_FRONT_DATUM_M + m.longitudinal / 1000.0,
        y: POD_PLATE_HEIGHT_M + m.up / 1000.0,
        z: -m.lateral_right / 1000.0,
        yaw: r.yaw.to_radians(),
        pitch: r.pitch.to_radians(),
        roll: r.roll.to_radians(),
    }
}

/// Parse the Pronto rig out of a `render-qualification-program/v1` document.
///
/// `render_width`/`render_height` fix the camera aspect used to derive each
/// camera's vertical FOV from its declared horizontal FOV.
pub fn parse_pronto_rig(program_json: &str, render_width: u32, render_height: u32) -> Result<RigSpec> {
    let doc: serde_json::Value =
        serde_json::from_str(program_json).context("parse qualification program json")?;
    let rig = doc
        .get("prontoRig")
        .context("qualification program has no prontoRig")?;
    let raw_sensors: Vec<RawSensor> = serde_json::from_value(
        rig.get("sensors").cloned().context("prontoRig.sensors missing")?,
    )
    .context("parse prontoRig.sensors")?;

    let mut sensors = Vec::with_capacity(raw_sensors.len() + 1);
    for s in &raw_sensors {
        let mount = mount_from_sheet(&s.source_mount_mm, &s.rotation_deg);
        let sensor = match s.kind.as_str() {
            "dash_camera" => {
                let hfov = s.horizontal_fov_deg.context("camera missing horizontalFovDeg")?;
                // vfov from hfov at the render aspect: tan(v/2)=tan(h/2)/aspect
                let aspect = render_width as f32 / render_height as f32;
                RigSensor {
                    id: s.id.clone(),
                    label: s.label.clone(),
                    kind: SensorKind::Camera,
                    mount,
                    horizontal_fov_deg: hfov,
                    vertical_fov_deg: Some((2.0 * ((hfov.to_radians() / 2.0).tan() / aspect).atan()).to_degrees()),
                    range_m: 1000.0,
                    lidar_channels: 0,
                    rotation_frequency_hz: 0.0,
                    points_per_second: None,
                }
            }
            "lidar" => RigSensor {
                id: s.id.clone(),
                label: s.label.clone(),
                kind: SensorKind::Lidar,
                mount,
                horizontal_fov_deg: s.horizontal_fov_deg.unwrap_or(360.0),
                vertical_fov_deg: s.vertical_fov_deg,
                range_m: 200.0,
                // Seyond Falcon-class 128-channel pattern (matches the
                // qualification lowering attributes channels=128,
                // rotationFrequencyHz=10).
                lidar_channels: 128,
                rotation_frequency_hz: 10.0,
                points_per_second: Some(1_300_000),
            },
            "radar" => RigSensor {
                id: s.id.clone(),
                label: s.label.clone(),
                kind: SensorKind::Radar,
                mount,
                horizontal_fov_deg: s
                    .horizontal_fov_deg
                    .context("radar missing horizontalFovDeg")?,
                vertical_fov_deg: s.vertical_fov_deg.or(Some(30.0)),
                range_m: 100.0,
                lidar_channels: 0,
                rotation_frequency_hz: 0.0,
                points_per_second: Some(1_500),
            },
            other => bail!("unknown prontoRig sensor type {other:?} for {}", s.id),
        };
        sensors.push(sensor);
    }

    sensors.push(chase_camera(render_width, render_height));

    Ok(RigSpec { rig_id: rig.get("id").and_then(|v| v.as_str()).context("prontoRig.id missing")?.to_string(), sensors })
}

/// The authored trailing chase presentation view. Presentation-only pose:
/// 8 m behind the host origin, 3 m up, pitched slightly down, looking forward
/// along the host heading. Outside the measurement rig by contract.
pub fn chase_camera(render_width: u32, render_height: u32) -> RigSensor {
    let aspect = render_width as f32 / render_height as f32;
    let hfov = 58.0_f32;
    RigSensor {
        id: CHASE_CAMERA_SENSOR_ID.to_string(),
        label: "Trailing chase (presentation)".to_string(),
        kind: SensorKind::Camera,
        mount: Mount { x: -8.0, y: 3.0, z: 0.0, yaw: 0.0, pitch: (-6.0f32).to_radians(), roll: 0.0 },
        horizontal_fov_deg: hfov,
        vertical_fov_deg: Some((2.0 * ((hfov.to_radians() / 2.0).tan() / aspect).atan()).to_degrees()),
        range_m: 1000.0,
        lidar_channels: 0,
        rotation_frequency_hz: 0.0,
        points_per_second: None,
    }
}
