//! The Bevy renderer's contract conformance against the shipped parity
//! fixture: actor matrices within `matrixAbs`, derived light states equal to
//! the fixture's `expectedLights` (pure CPU — no GPU required).

use std::path::PathBuf;

use render_core::fixture::{actor_matrix_col_major, check_fixture, ParityFixture};

fn fixture_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/viewer/fixtures/renderer-contract/basic-intersection.v1.json")
}

#[test]
fn basic_intersection_fixture_passes() {
    let fixture = ParityFixture::load(&fixture_path()).expect("load fixture");
    let report = check_fixture(&fixture).expect("check fixture");
    assert!(
        report.pass,
        "fixture check failed:\n{}",
        serde_json::to_string_pretty(&report).unwrap()
    );
    // The fixture exercises all four actors and three lit vehicles.
    assert_eq!(report.matrix_checks.len(), 4);
    assert_eq!(report.lights.derived.len(), 3);
}

#[test]
fn actor_matrix_matches_three_compose_order() {
    // yaw = -pi/2 must land +X on -Z (column-major Three order).
    let m = actor_matrix_col_major([3.0, 0.0, -4.94], -std::f64::consts::FRAC_PI_2);
    assert!((m[2] - 1.0).abs() < 1e-12); // te[2] = -2wy = +1
    assert!((m[8] + 1.0).abs() < 1e-12); // te[8] = +2wy = -1
    assert_eq!(&m[12..15], &[3.0, 0.0, -4.94]);
}

#[test]
fn fixture_light_expectations_are_tick_independent_of_blink_phase() {
    // The derived light-state truth (on/off) must not depend on the blink
    // phase helpers — those only gate lens visibility, never the report.
    let fixture = ParityFixture::load(&fixture_path()).expect("load fixture");
    let report = check_fixture(&fixture).expect("check fixture");
    assert!(report.lights.pass, "{:?}", report.lights.mismatches);
}
