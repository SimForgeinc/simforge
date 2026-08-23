//! scene-state.v1 consumer types (serde). Mirrors
//! packages/scene-state/src/schema.ts and docs/native-renderer/scene-state-v1.md.

use serde::{Deserialize, Serialize};

pub const SCENE_STATE_VERSION: &str = "scene-state.v1";

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum RenderProfile {
    #[default]
    Sensor,
    Cinematic,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct Weather {
    pub preset: WeatherPreset,
    #[serde(default)]
    pub fog_density: f64,
    #[serde(default)]
    pub rain_intensity: f64,
    #[serde(default)]
    pub wetness: f64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum WeatherPreset {
    Clear,
    Fog,
    Rain,
    Night,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActorDesc {
    pub id: String,
    #[serde(rename = "catalogId")]
    pub catalog_id: String,
    #[serde(rename = "actorClass")]
    pub actor_class: String,
    #[serde(default)]
    pub dims: Option<Dims>,
    #[serde(default)]
    pub color: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct Dims {
    pub l: f64,
    pub w: f64,
    pub h: f64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ActorTickKind {
    Spawn,
    Update,
    Despawn,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActorTick {
    pub id: String,
    pub kind: ActorTickKind,
    pub position: [f64; 3],
    pub rotation: [f64; 4],
    #[serde(rename = "yawRad")]
    pub yaw_rad: f64,
    pub velocity: [f64; 3],
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SceneFrame {
    pub tick: u32,
    pub t: f64,
    pub actors: Vec<ActorTick>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SceneState {
    pub version: String,
    #[serde(rename = "mapId")]
    pub map_id: String,
    pub frame: String,
    pub dt: f64,
    #[serde(rename = "tickHz")]
    pub tick_hz: f64,
    #[serde(rename = "tickCount")]
    pub tick_count: u32,
    pub weather: Weather,
    #[serde(rename = "timeOfDay")]
    pub time_of_day: f64,
    #[serde(default)]
    pub profile: RenderProfile,
    #[serde(default)]
    pub ground_y: Option<f64>,
    pub actors: Vec<ActorDesc>,
    pub frames: Vec<SceneFrame>,
}

impl SceneState {
    pub fn from_json_bytes(bytes: &[u8]) -> anyhow::Result<Self> {
        Ok(serde_json::from_slice(bytes)?)
    }

    pub fn load(path: &std::path::Path) -> anyhow::Result<Self> {
        let bytes = std::fs::read(path)?;
        Self::from_json_bytes(&bytes)
    }
}
