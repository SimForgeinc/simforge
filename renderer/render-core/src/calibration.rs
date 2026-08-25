//! SimForge lighting calibration — Bevy-renderer implementation.
//!
//! This module and `packages/viewer/src/lighting-calibration.ts` are
//! duplicated implementations of ONE spec: docs/lighting-calibration.md.
//! Change the doc first, then land both modules in the same commit.

/// Solar illuminance above the atmosphere, lux.
pub const EXTRATERRESTRIAL_ILLUMINANCE_LX: f32 = 128_000.0;

/// Meinel/Laue clear-atmosphere transmittance per unit air mass.
pub const ATMOSPHERIC_TRANSMITTANCE: f32 = 0.7;

/// Sun angular diameter seen from Earth, degrees (penumbra width driver).
pub const SUN_ANGULAR_DIAMETER_DEG: f32 = 0.53;

/// Sun elevation (degrees) below which the sun contributes no direct light.
pub const CIVIL_TWILIGHT_DEG: f32 = -6.0;

/// The map HDRIs are normalized (mean sky luma ≈ 1.26, measured for
/// yale-street env/sky.hdr), not cd/m². 20 000 restores physical sky
/// luminance: measured shadowed/sunlit ratio ≈ 0.21 linear, inside the
/// 0.15–0.25 spec band (see docs/lighting-calibration.md §Sky).
pub const HDRI_TO_CDM2: f32 = 20_000.0;

/// Fixed sensor-profile EV100 per condition (incident convention:
/// EV100 = log2(lux / 2.5), ISO 100).
pub const SENSOR_EV100_CLEAR: f32 = 15.0;
pub const SENSOR_EV100_FOG: f32 = 14.0;
pub const SENSOR_EV100_RAIN: f32 = 13.5;
pub const SENSOR_EV100_NIGHT: f32 = 9.0;

/// Reference sun elevation the EV100/daylight scales are anchored at.
pub const REFERENCE_SUN_ELEVATION_DEG: f32 = 60.0;

/// Kasten–Young (1989) relative optical air mass; finite at the horizon.
pub fn air_mass(elevation_deg: f32) -> f32 {
    let h = elevation_deg.max(-1.0);
    let sin_h = h.to_radians().sin();
    1.0 / (sin_h + 0.50572 * (h + 6.07995).powf(-1.6364))
}

/// Linear 1→0 direct-sun ramp from the horizon down to civil twilight.
pub fn twilight_ramp(elevation_deg: f32) -> f32 {
    if elevation_deg >= 0.0 {
        1.0
    } else if elevation_deg <= CIVIL_TWILIGHT_DEG {
        0.0
    } else {
        1.0 - elevation_deg / CIVIL_TWILIGHT_DEG
    }
}

/// Direct-normal sun illuminance (lux) for a sun elevation, Meinel model:
/// `E_ext * T^(m^0.678)`, ramped to zero through civil twilight.
pub fn sun_direct_normal_illuminance_lx(elevation_deg: f32) -> f32 {
    let ramp = twilight_ramp(elevation_deg);
    if ramp == 0.0 {
        return 0.0;
    }
    let m = air_mass(elevation_deg.max(0.0));
    EXTRATERRESTRIAL_ILLUMINANCE_LX * ATMOSPHERIC_TRANSMITTANCE.powf(m.powf(0.678)) * ramp
}

/// Direct horizontal sun illuminance (lux): `E_dn(h) * sin h`.
pub fn sun_direct_horizontal_illuminance_lx(elevation_deg: f32) -> f32 {
    sun_direct_normal_illuminance_lx(elevation_deg) * elevation_deg.max(0.0).to_radians().sin()
}

/// Sun colour temperature (Kelvin) vs elevation: 5 500 K high sun cooling to
/// 2 500 K at the horizon, held below it.
pub fn sun_color_temperature_k(elevation_deg: f32) -> f32 {
    let t = (elevation_deg / 30.0).clamp(0.0, 1.0);
    2500.0 + 3000.0 * t
}

/// Fixed clear-weather EV100 tracking the sun model: 15 at the 60° reference,
/// darkening with direct horizontal illuminance, clamped to the lit-street
/// floor of 9.
pub fn ev100_for_sun_elevation(elevation_deg: f32) -> f32 {
    let reference = sun_direct_horizontal_illuminance_lx(REFERENCE_SUN_ELEVATION_DEG);
    let e = sun_direct_horizontal_illuminance_lx(elevation_deg).max(1.0);
    (SENSOR_EV100_CLEAR + (e / reference).log2()).clamp(SENSOR_EV100_NIGHT, SENSOR_EV100_CLEAR)
}

/// Sky-brightness scale vs sun elevation, relative to the 60° reference and
/// floored at the measured lit-street/night level of 0.004.
pub fn daylight_fraction(elevation_deg: f32) -> f32 {
    let reference = sun_direct_horizontal_illuminance_lx(REFERENCE_SUN_ELEVATION_DEG);
    (sun_direct_horizontal_illuminance_lx(elevation_deg) / reference).clamp(0.004, 1.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sun_model_matches_spec_anchors() {
        // Spec anchors (docs/lighting-calibration.md §Sun model).
        let zenith = sun_direct_normal_illuminance_lx(90.0);
        assert!((zenith - 89_600.0).abs() < 500.0, "zenith {zenith}");
        let noon = sun_direct_normal_illuminance_lx(60.0);
        assert!((80_000.0..90_000.0).contains(&noon), "60deg {noon}");
        let dusk = sun_direct_normal_illuminance_lx(4.0);
        assert!((5_000.0..25_000.0).contains(&dusk), "4deg {dusk}");
        assert_eq!(sun_direct_normal_illuminance_lx(-6.0), 0.0);
    }

    #[test]
    fn ev100_clamps_to_spec_band() {
        assert!((ev100_for_sun_elevation(60.0) - 15.0).abs() < 1e-4);
        assert_eq!(ev100_for_sun_elevation(-6.0), 9.0);
        let dusk = ev100_for_sun_elevation(4.0);
        assert!((9.0..13.0).contains(&dusk), "dusk EV {dusk}");
    }

    #[test]
    fn color_temperature_ramp() {
        assert_eq!(sun_color_temperature_k(60.0), 5500.0);
        assert_eq!(sun_color_temperature_k(0.0), 2500.0);
        assert_eq!(sun_color_temperature_k(-10.0), 2500.0);
    }
}
