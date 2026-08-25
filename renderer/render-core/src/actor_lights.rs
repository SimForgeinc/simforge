//! Vehicle light-state parity with the renderer contract.
//!
//! `derive_vehicle_light_states` is a line-for-line port of the normative
//! `deriveVehicleLightStates` in
//! `packages/viewer/src/renderer-contract.ts`: emissive low-beam lenses are
//! unbounded, at most [`PROJECTED_HEADLIGHT_LIMIT`] vehicles carry a real
//! projected beam (chosen by ascending actor id), and a state row is emitted
//! only when something is lit. Lens placement mirrors the browser
//! `ActorRenderer` geometry (`headlightMatrix`, `indicatorMatrix`,
//! `reverseLightMatrix`, `emergencyLightMatrix`), stated actor-local so the
//! lenses ride the actor root transform.
//!
//! Blink phases are pure functions of scene time (tick * dt) — never the
//! wall clock — so captures are deterministic.

use serde::{Deserialize, Serialize};

/// At most this many vehicles project real beam lights, ascending actor id.
/// Pinned to the contract's `PROJECTED_HEADLIGHT_LIMIT` (= the viewer's
/// `MAX_PROJECTED_HEADLIGHTS`).
pub const PROJECTED_HEADLIGHT_LIMIT: usize = 8;

/// Bounded nearest-camera pool of street luminaires with a real point light.
pub const STREET_LUMINAIRE_ACTIVE_LIMIT: usize = 12;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Emergency {
    #[default]
    Off,
    Flashing,
    FlashingSiren,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Indicator {
    #[default]
    Off,
    Left,
    Right,
    Hazard,
}

impl Indicator {
    pub fn left_on(self) -> bool {
        matches!(self, Indicator::Left | Indicator::Hazard)
    }
    pub fn right_on(self) -> bool {
        matches!(self, Indicator::Right | Indicator::Hazard)
    }
}

/// Playback cues for one actor (the fixture's `renderCues` shape).
#[derive(Debug, Clone, Copy, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderCues {
    pub headlights: Option<bool>,
    #[serde(default)]
    pub emergency: Emergency,
    #[serde(default)]
    pub indicator: Indicator,
    #[serde(default)]
    pub reversing: bool,
}

/// Per-actor input to the light derivation.
#[derive(Debug, Clone)]
pub struct LightInput {
    pub id: String,
    pub is_vehicle: bool,
    /// Explicit low-beam state; `None` means the environment default.
    pub headlights: Option<bool>,
    pub emergency: Emergency,
    pub indicator: Indicator,
    pub reversing: bool,
}

/// Per-vehicle light truth a conforming renderer must reproduce.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VehicleLightState {
    pub actor_id: String,
    pub low_beams: bool,
    pub projected_beam: bool,
    pub emergency: Emergency,
    pub indicator: Indicator,
    pub reverse_light: bool,
}

/// Normative light-state derivation (contract
/// `deriveVehicleLightStates`). `global_low_beams` is the environment
/// default (authored darkness); an explicit per-actor `headlights` wins.
pub fn derive_vehicle_light_states(
    actors: &[LightInput],
    global_low_beams: bool,
) -> Vec<VehicleLightState> {
    let mut lit: Vec<&LightInput> = actors
        .iter()
        .filter(|a| a.is_vehicle && a.headlights.unwrap_or(global_low_beams))
        .collect();
    lit.sort_by(|a, b| a.id.cmp(&b.id));
    let beam_ids: std::collections::HashSet<&str> = lit
        .iter()
        .take(PROJECTED_HEADLIGHT_LIMIT)
        .map(|a| a.id.as_str())
        .collect();

    let mut states = Vec::new();
    for actor in actors {
        if !actor.is_vehicle {
            continue;
        }
        let low_beams = actor.headlights.unwrap_or(global_low_beams);
        let state = VehicleLightState {
            actor_id: actor.id.clone(),
            low_beams,
            projected_beam: beam_ids.contains(actor.id.as_str()),
            emergency: actor.emergency,
            indicator: actor.indicator,
            reverse_light: actor.reversing,
        };
        if state.low_beams
            || state.projected_beam
            || state.emergency != Emergency::Off
            || state.indicator != Indicator::Off
            || state.reverse_light
        {
            states.push(state);
        }
    }
    states.sort_by(|a, b| a.actor_id.cmp(&b.actor_id));
    states
}

/// Scene-state actor classes that count as vehicles for light derivation
/// (mirrors the viewer's `isVehicleActor` catalog-class test).
pub fn is_vehicle_class(actor_class: &str) -> bool {
    matches!(
        actor_class,
        "vehicle" | "car" | "truck" | "bus" | "van" | "motorcycle"
    )
}

// ---------------------------------------------------------------------------
// Deterministic blink phases (scene time only, no wall clock)
// ---------------------------------------------------------------------------

/// Emergency beacon: 2 Hz alternation. Red lens lit in the first half of
/// each period, blue in the second; both start deterministically at t=0.
pub fn beacon_red_on(time_s: f64) -> bool {
    (time_s * 2.0).rem_euclid(1.0) < 0.5
}

pub fn beacon_blue_on(time_s: f64) -> bool {
    !beacon_red_on(time_s)
}

/// Turn signals: 1.5 Hz square wave, on-phase first.
pub fn indicator_on(time_s: f64) -> bool {
    (time_s * 1.5).rem_euclid(1.0) < 0.5
}

// ---------------------------------------------------------------------------
// Lens layout (actor-local; mirrors the viewer's world-space lens matrices)
// ---------------------------------------------------------------------------

/// Actor-local lens box: translation + non-uniform scale of a unit cube.
#[derive(Debug, Clone, Copy)]
pub struct LensBox {
    pub translation: [f32; 3],
    pub scale: [f32; 3],
}

/// Front low-beam lens (viewer `headlightMatrix`). `side` -1 = left (-Z).
pub fn headlight_lens(l: f32, w: f32, h: f32, side: f32) -> LensBox {
    LensBox {
        translation: [l * 0.495, h * 0.42, side * w * 0.33],
        scale: [0.08, 0.12, (w * 0.16).max(0.12)],
    }
}

/// Rear tail lens lit together with the low beams: mirrors the headlight
/// lens at the tail so night traffic reads front/back.
pub fn tail_lens(l: f32, w: f32, h: f32, side: f32) -> LensBox {
    LensBox {
        translation: [-l * 0.495, h * 0.42, side * w * 0.33],
        scale: [0.08, 0.12, (w * 0.16).max(0.12)],
    }
}

/// Luminous reverse panel (viewer `reverseLightMatrix`).
pub fn reverse_lens(l: f32, w: f32, h: f32) -> LensBox {
    let thickness = (l * 0.01).max(0.035);
    LensBox {
        translation: [-l / 2.0 - thickness / 2.0, h * 0.42, 0.0],
        scale: [thickness, (h * 0.09).max(0.08), w * 0.52],
    }
}

/// Roof beacon (viewer `emergencyLightMatrix`). `side` -1 = red, +1 = blue.
pub fn emergency_lens(l: f32, w: f32, h: f32, side: f32) -> LensBox {
    LensBox {
        translation: [0.0, h + 0.035, side * w * 0.18],
        scale: [l * 0.13, 0.07, w * 0.28],
    }
}

/// Turn-signal lens (viewer `indicatorMatrix`). Left = -Z.
pub fn indicator_lens(l: f32, w: f32, h: f32, side_z: f32, front: bool) -> LensBox {
    LensBox {
        translation: [
            if front { 1.0 } else { -1.0 } * l * 0.49,
            h * 0.38,
            side_z * w * 0.47,
        ],
        scale: [0.12, 0.1, 0.16],
    }
}

/// Projected-beam source and aim points, actor-local (viewer
/// `placeHeadlightBeam`).
pub fn beam_source(l: f32, h: f32) -> [f32; 3] {
    [l * 0.5, h * 0.43, 0.0]
}

pub fn beam_aim(l: f32) -> [f32; 3] {
    [l * 0.5 + 18.0, 0.15, 0.0]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vehicle(id: &str, headlights: Option<bool>) -> LightInput {
        LightInput {
            id: id.to_string(),
            is_vehicle: true,
            headlights,
            emergency: Emergency::Off,
            indicator: Indicator::Off,
            reversing: false,
        }
    }

    #[test]
    fn beam_limit_is_bounded_and_id_sorted() {
        // 11 lit vehicles, shuffled ids; only the 8 lowest ids project.
        let mut actors: Vec<LightInput> = (0..11)
            .rev()
            .map(|i| vehicle(&format!("car-{i:02}"), Some(true)))
            .collect();
        actors.push(vehicle("dark-car", Some(false)));
        let states = derive_vehicle_light_states(&actors, false);
        let projected: Vec<&str> = states
            .iter()
            .filter(|s| s.projected_beam)
            .map(|s| s.actor_id.as_str())
            .collect();
        assert_eq!(
            projected,
            (0..PROJECTED_HEADLIGHT_LIMIT)
                .map(|i| format!("car-{i:02}"))
                .collect::<Vec<_>>()
                .iter()
                .map(|s| s.as_str())
                .collect::<Vec<_>>()
        );
        // Low beams stay unbounded.
        assert_eq!(states.iter().filter(|s| s.low_beams).count(), 11);
        // The explicitly dark vehicle emits no state row at all.
        assert!(states.iter().all(|s| s.actor_id != "dark-car"));
    }

    #[test]
    fn explicit_headlights_override_global_default() {
        let actors = vec![vehicle("a", None), vehicle("b", Some(false))];
        let day = derive_vehicle_light_states(&actors, false);
        assert!(day.is_empty());
        let night = derive_vehicle_light_states(&actors, true);
        assert_eq!(night.len(), 1);
        assert_eq!(night[0].actor_id, "a");
    }

    #[test]
    fn non_vehicles_never_emit() {
        let mut ped = vehicle("ped", Some(true));
        ped.is_vehicle = false;
        assert!(derive_vehicle_light_states(&[ped], true).is_empty());
    }

    #[test]
    fn blink_phases_are_deterministic_and_start_on() {
        assert!(beacon_red_on(0.0) && !beacon_blue_on(0.0));
        assert!(!beacon_red_on(0.3) && beacon_blue_on(0.3));
        assert!(indicator_on(0.04));
        assert!(!indicator_on(0.4));
        // Same time always yields the same phase.
        assert_eq!(beacon_red_on(123.456), beacon_red_on(123.456));
    }
}
