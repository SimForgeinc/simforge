//! `scene-state.v1` consumer (WSB2's contract).
//!
//! Top-level shape (JSON or msgpack):
//! ```json
//! { "version": "scene-state.v1", "mapId": "...", "tick": 0, "tickHz": 50,
//!   "weather": {"preset": "clear"}, "timeOfDay": 12.0, "actors": [...] }
//! ```
//! Actor record: `{ id, kind: spawn|update|despawn, catalogId, actorClass,
//! transform: { position:[x,y,z], rotation:[qx,qy,qz,qw] }, velocity:[...],
//! angularVelocityY? }`. The ego actor has id `"ego"`.

use anyhow::{bail, Context, Result};
use bevy::prelude::Resource;
use serde::{Deserialize};

pub const SCENE_STATE_SCHEMA: &str = "scene-state.v1";

#[derive(Debug, Clone, Deserialize, Resource)]
pub struct SceneState {
    pub version: String,
    #[serde(rename = "mapId")]
    pub map_id: String,
    pub tick: u32,
    #[serde(rename = "tickHz")]
    pub tick_hz: f32,
    #[serde(default)]
    pub weather: Option<Weather>,
    #[serde(rename = "timeOfDay", default)]
    pub time_of_day: Option<f32>,
    #[serde(default)]
    pub actors: Vec<ActorState>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Weather {
    pub preset: String,
    #[serde(default)]
    pub params: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ActorState {
    pub id: String,
    /// spawn | update | despawn
    pub kind: String,
    #[serde(rename = "catalogId", default)]
    pub catalog_id: Option<String>,
    #[serde(rename = "actorClass", default)]
    pub actor_class: Option<String>,
    pub transform: ActorTransform,
    #[serde(default)]
    pub velocity: [f32; 3],
    #[serde(rename = "angularVelocityY", default)]
    pub angular_velocity_y: Option<f32>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ActorTransform {
    /// World frame = tile GLB frame, metres.
    #[serde(rename = "position")]
    pub position: [f32; 3],
    /// Quaternion [x, y, z, w].
    #[serde(rename = "rotation", default = "identity_quat")]
    pub rotation: [f32; 4],
}

fn identity_quat() -> [f32; 4] {
    [0.0, 0.0, 0.0, 1.0]
}

impl SceneState {
    pub fn from_json(text: &str) -> Result<SceneState> {
        let s: SceneState = serde_json::from_str(text).context("parse scene-state json")?;
        if s.version != SCENE_STATE_SCHEMA {
            bail!("scene-state schema mismatch: expected {SCENE_STATE_SCHEMA}, got {}", s.version);
        }
        Ok(s)
    }

    pub fn ego(&self) -> Option<&ActorState> {
        self.actors.iter().find(|a| a.id == "ego")
    }
}
