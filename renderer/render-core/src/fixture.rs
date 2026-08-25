//! Renderer parity fixture (`simforge.renderer-parity-fixture/v1`) consumer.
//!
//! Loads the fixture document shipped in
//! `packages/viewer/fixtures/renderer-contract/*.v1.json`, recomputes the
//! actor world matrices from the embedded scene-state tick using the
//! contract's normative frame-assembly rule (yaw-about-+Y quaternion,
//! column-major Three order), derives the vehicle light states with
//! [`crate::actor_lights::derive_vehicle_light_states`], and compares both
//! against the fixture expectations within the authored tolerances.

use std::collections::HashMap;
use std::path::Path;

use anyhow::{bail, Context, Result};
use serde::Deserialize;

use crate::actor_lights::{
    derive_vehicle_light_states, is_vehicle_class, Emergency, Indicator, LightInput, RenderCues,
    VehicleLightState, PROJECTED_HEADLIGHT_LIMIT, STREET_LUMINAIRE_ACTIVE_LIMIT,
};
use crate::scene_state::SceneState;

pub const PARITY_FIXTURE_VERSION: &str = "simforge.renderer-parity-fixture/v1";
pub const RENDERER_CONTRACT_VERSION: &str = "simforge.renderer-contract/v1";

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Tolerances {
    pub matrix_abs: f64,
    pub point_abs: f64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExpectedStreetLighting {
    pub enabled: bool,
    pub active_limit: usize,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExpectedVehicleLight {
    pub actor_id: String,
    pub low_beams: bool,
    pub projected_beam: bool,
    pub emergency: Emergency,
    pub indicator: Indicator,
    pub reverse_light: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExpectedLights {
    pub street_lighting: ExpectedStreetLighting,
    pub vehicles: Vec<ExpectedVehicleLight>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParityFixture {
    pub fixture_version: String,
    pub contract_version: String,
    pub tolerances: Tolerances,
    pub scene_state: SceneState,
    pub tick: usize,
    pub render_cues: HashMap<String, RenderCues>,
    pub global_low_beams: bool,
    pub expected_actor_matrices: HashMap<String, Vec<f64>>,
    pub expected_lights: ExpectedLights,
}

impl ParityFixture {
    pub fn load(path: &Path) -> Result<Self> {
        let doc: Self = serde_json::from_slice(
            &std::fs::read(path).with_context(|| format!("read {}", path.display()))?,
        )?;
        if doc.fixture_version != PARITY_FIXTURE_VERSION {
            bail!("unsupported fixture version {}", doc.fixture_version);
        }
        if doc.contract_version != RENDERER_CONTRACT_VERSION {
            bail!("unsupported contract version {}", doc.contract_version);
        }
        Ok(doc)
    }
}

/// Column-major (Three `Matrix4.elements` order) rigid transform from a
/// ground position and a yaw about +Y — the contract's normative actor
/// matrix. All math in f64 to match the fixture baker bit-for-bit within
/// `matrixAbs`.
pub fn actor_matrix_col_major(position: [f64; 3], yaw_rad: f64) -> [f64; 16] {
    let half = yaw_rad / 2.0;
    let qy = half.sin();
    let qw = half.cos();
    // Three.js makeRotationFromQuaternion with x = z = 0.
    let y2 = qy + qy;
    let yy = qy * y2;
    let wy = qw * y2;
    [
        1.0 - yy,
        0.0,
        -wy,
        0.0,
        0.0,
        1.0,
        0.0,
        0.0,
        wy,
        0.0,
        1.0 - yy,
        0.0,
        position[0],
        position[1],
        position[2],
        1.0,
    ]
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MatrixCheck {
    pub actor_id: String,
    pub max_abs_err: f64,
    pub pass: bool,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LightsCheck {
    pub pass: bool,
    pub expected: Vec<String>,
    pub derived: Vec<String>,
    pub mismatches: Vec<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FixtureReport {
    pub fixture_version: String,
    pub tick: usize,
    pub matrix_checks: Vec<MatrixCheck>,
    pub lights: LightsCheck,
    pub pass: bool,
}

/// Recompute actor matrices + light states for the fixture tick and compare
/// against the expectations.
pub fn check_fixture(fixture: &ParityFixture) -> Result<FixtureReport> {
    let frame = fixture
        .scene_state
        .frames
        .get(fixture.tick)
        .with_context(|| format!("fixture tick {} out of range", fixture.tick))?;

    // --- actor matrices -----------------------------------------------------
    let mut matrix_checks = Vec::new();
    for (actor_id, expected) in &fixture.expected_actor_matrices {
        if expected.len() != 16 {
            bail!("expectedActorMatrices[{actor_id}]: expected 16 numbers");
        }
        let Some(rec) = frame.actors.iter().find(|r| &r.id == actor_id) else {
            matrix_checks.push(MatrixCheck {
                actor_id: actor_id.clone(),
                max_abs_err: f64::INFINITY,
                pass: false,
            });
            continue;
        };
        let got = actor_matrix_col_major(rec.position, rec.yaw_rad);
        let max_abs_err = got
            .iter()
            .zip(expected.iter())
            .map(|(a, b)| (a - b).abs())
            .fold(0.0_f64, f64::max);
        matrix_checks.push(MatrixCheck {
            actor_id: actor_id.clone(),
            max_abs_err,
            pass: max_abs_err <= fixture.tolerances.matrix_abs,
        });
    }
    matrix_checks.sort_by(|a, b| a.actor_id.cmp(&b.actor_id));

    // --- light states --------------------------------------------------------
    let inputs: Vec<LightInput> = frame
        .actors
        .iter()
        .filter_map(|rec| {
            let desc = fixture
                .scene_state
                .actors
                .iter()
                .find(|d| d.id == rec.id)?;
            let cues = fixture.render_cues.get(&rec.id).copied().unwrap_or_default();
            Some(LightInput {
                id: rec.id.clone(),
                is_vehicle: is_vehicle_class(&desc.actor_class),
                headlights: cues.headlights,
                emergency: cues.emergency,
                indicator: cues.indicator,
                reversing: cues.reversing,
            })
        })
        .collect();
    let derived = derive_vehicle_light_states(&inputs, fixture.global_low_beams);

    let fmt = |s: &VehicleLightState| {
        format!(
            "{}: lowBeams={} projectedBeam={} emergency={:?} indicator={:?} reverseLight={}",
            s.actor_id, s.low_beams, s.projected_beam, s.emergency, s.indicator, s.reverse_light
        )
    };
    let fmt_expected = |s: &ExpectedVehicleLight| {
        format!(
            "{}: lowBeams={} projectedBeam={} emergency={:?} indicator={:?} reverseLight={}",
            s.actor_id, s.low_beams, s.projected_beam, s.emergency, s.indicator, s.reverse_light
        )
    };

    let mut mismatches = Vec::new();
    if fixture.expected_lights.street_lighting.active_limit != STREET_LUMINAIRE_ACTIVE_LIMIT {
        mismatches.push(format!(
            "streetLighting.activeLimit: expected {} contract constant is {}",
            fixture.expected_lights.street_lighting.active_limit, STREET_LUMINAIRE_ACTIVE_LIMIT
        ));
    }
    let _ = PROJECTED_HEADLIGHT_LIMIT; // pinned by the derivation itself
    if derived.len() != fixture.expected_lights.vehicles.len() {
        mismatches.push(format!(
            "vehicle count: derived {} expected {}",
            derived.len(),
            fixture.expected_lights.vehicles.len()
        ));
    }
    for (d, e) in derived.iter().zip(fixture.expected_lights.vehicles.iter()) {
        let matches = d.actor_id == e.actor_id
            && d.low_beams == e.low_beams
            && d.projected_beam == e.projected_beam
            && d.emergency == e.emergency
            && d.indicator == e.indicator
            && d.reverse_light == e.reverse_light;
        if !matches {
            mismatches.push(format!("derived [{}] != expected [{}]", fmt(d), fmt_expected(e)));
        }
    }

    let lights = LightsCheck {
        pass: mismatches.is_empty(),
        expected: fixture
            .expected_lights
            .vehicles
            .iter()
            .map(fmt_expected)
            .collect(),
        derived: derived.iter().map(fmt).collect(),
        mismatches,
    };

    let pass = lights.pass && matrix_checks.iter().all(|c| c.pass);
    Ok(FixtureReport {
        fixture_version: fixture.fixture_version.clone(),
        tick: fixture.tick,
        matrix_checks,
        lights,
        pass,
    })
}
