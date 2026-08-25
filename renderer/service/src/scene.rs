//! `scene-state.v1` wire structs for the render service (V2 ops).
//!
//! Mirrors the frozen contract in `packages/scene-state/src/schema.ts` and
//! the consumer types in `native/sensors/src/scene_state.rs` (WSB3). Kept as
//! service-local mirrors so the service does not need to depend on the
//! sensors crate; field names and semantics are identical.

use serde::Deserialize;

pub const SCENE_STATE_SCHEMA: &str = "scene-state.v1";

/// One tick document of a scene-state stream.
#[derive(Debug, Clone, Deserialize)]
pub struct SceneState {
    pub version: String,
    #[serde(rename = "mapId")]
    pub map_id: String,
    #[serde(default)]
    pub tick: u32,
    #[serde(rename = "tickHz", default)]
    pub tick_hz: f32,
    #[serde(default)]
    pub weather: Option<serde_json::Value>,
    #[serde(rename = "timeOfDay", default)]
    pub time_of_day: Option<f32>,
    /// Road-surface elevation hint; null/absent means snap via raycast
    /// (the service uses its ground height field).
    #[serde(rename = "groundY", default)]
    pub ground_y: Option<f32>,
    #[serde(default)]
    pub actors: Vec<ActorState>,
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
    /// Authored sRGB body colour (`#RRGGBB`). Absent actors use the
    /// deterministic class palette.
    #[serde(default)]
    pub color: Option<String>,
    pub transform: ActorTransform,
    #[serde(default)]
    pub velocity: [f32; 3],
}

#[derive(Debug, Clone, Deserialize)]
pub struct ActorTransform {
    /// World frame = tile GLB frame, metres; y is a ground hint only.
    pub position: [f32; 3],
    /// Y-up quaternion [x, y, z, w].
    #[serde(default = "identity_quat")]
    pub rotation: [f32; 4],
}

fn identity_quat() -> [f32; 4] {
    [0.0, 0.0, 0.0, 1.0]
}

impl SceneState {
    pub fn validate(&self) -> Result<(), String> {
        if self.version != SCENE_STATE_SCHEMA {
            return Err(format!(
                "scene-state schema mismatch: expected {SCENE_STATE_SCHEMA}, got {}",
                self.version
            ));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::SceneState;

    #[test]
    fn actor_color_deserializes_from_scene_state() {
        let state: SceneState = serde_json::from_str(
            r##"{
                "version":"scene-state.v1","mapId":"belmont-research-center",
                "actors":[{
                    "id":"mini","kind":"spawn","catalogId":"vehicle.hatchback",
                    "actorClass":"car","color":"#8f2f2f",
                    "transform":{"position":[0,0,0]}
                }]
            }"##,
        )
        .unwrap();
        assert_eq!(state.actors[0].color.as_deref(), Some("#8f2f2f"));
    }
}
