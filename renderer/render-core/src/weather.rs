//! WSB4 weather ladder: clear / fog / rain / night as engine-native
//! lighting + participating media (no post-hoc overlays).
//!
//! Driven by the scenario `weather` field; here surfaced as a CLI enum that
//! WSB5 will later feed from `scene-state.v1`.

use bevy::color::{Color, LinearRgba};
use bevy::light::{FogVolume, PointLight, VolumetricFog, VolumetricLight};
use bevy::math::Vec3;
use bevy::mesh::prelude::*;
use bevy::mesh::{Meshable, SphereMeshBuilder, SphereKind};
use bevy::pbr::{MeshMaterial3d, StandardMaterial};
use bevy::prelude::{ChildOf, Commands, Entity, Name, Transform, Visibility};
use bevy::render::mesh::Mesh3d;
use std::ops::DerefMut;

use crate::calibration::{
    daylight_fraction, ev100_for_sun_elevation, sun_color_temperature_k,
    sun_direct_normal_illuminance_lx, SENSOR_EV100_FOG, SENSOR_EV100_NIGHT, SENSOR_EV100_RAIN,
};
use crate::lighting::{kelvin_to_rgb, LightingPlan};

/// Re-exported from the shared lighting spec (docs/lighting-calibration.md):
/// cd/m² per normalized-HDRI luma unit.
pub use crate::calibration::HDRI_TO_CDM2;

#[derive(
    Clone, Copy, Debug, Default, PartialEq, Eq, bevy::prelude::Resource,
    serde::Serialize, serde::Deserialize,
)]
#[serde(rename_all = "lowercase")]
pub enum Weather {
    #[default]
    Clear,
    /// Broken cumulus: the solar disc is still the dominant key, softened.
    Cloudy,
    /// Full stratus deck: the sky becomes the key light, sun is a glow.
    Overcast,
    Fog,
    Rain,
    Night,
}

impl Weather {
    pub fn parse(s: &str) -> anyhow::Result<Self> {
        match s.to_ascii_lowercase().as_str() {
            "clear" => Ok(Weather::Clear),
            "cloudy" | "partly-cloudy" => Ok(Weather::Cloudy),
            "overcast" => Ok(Weather::Overcast),
            "fog" | "mist" => Ok(Weather::Fog),
            "rain" | "wet" => Ok(Weather::Rain),
            "night" | "dusk" => Ok(Weather::Night),
            other => anyhow::bail!(
                "unknown weather '{other}' (clear|cloudy|overcast|fog|rain|night)"
            ),
        }
    }

    /// Fixed EV100 used by the sensor profile (cinematic uses the same fixed
    /// value until frame pacing makes auto-exposure deterministic).
    /// Clear weather tracks the sun-elevation model; night is lit-street
    /// exposure (docs/lighting-calibration.md §Exposure).
    pub fn sensor_ev100(&self, sun_elev_deg: f32) -> f32 {
        match self {
            Weather::Clear => ev100_for_sun_elevation(sun_elev_deg),
            // Cloud decks cost roughly 0.6 / 1.4 stops of scene luminance
            // relative to the clear sky at the same elevation.
            Weather::Cloudy => {
                (ev100_for_sun_elevation(sun_elev_deg) - 0.6).max(SENSOR_EV100_NIGHT)
            }
            Weather::Overcast => {
                (ev100_for_sun_elevation(sun_elev_deg) - 1.4).max(SENSOR_EV100_NIGHT)
            }
            Weather::Fog => SENSOR_EV100_FOG,
            Weather::Rain => SENSOR_EV100_RAIN,
            Weather::Night => SENSOR_EV100_NIGHT,
        }
    }

    /// Resolve per-weather sun + IBL scaling into a `LightingPlan` for a sun
    /// elevation. Sun intensity and sky brightness follow the shared spec's
    /// elevation model (docs/lighting-calibration.md §Sun model / §Sky); the
    /// weather factors below are relative to the clear-sky value at the same
    /// elevation.
    pub fn lighting_plan(&self, sun_dir_color: Option<Color>, sun_elev_deg: f32) -> LightingPlan {
        let sun_lux = sun_direct_normal_illuminance_lx(sun_elev_deg);
        let daylight = daylight_fraction(sun_elev_deg);
        let sun_color = sun_dir_color
            .unwrap_or_else(|| kelvin_to_rgb(sun_color_temperature_k(sun_elev_deg)));
        match self {
            Weather::Clear => LightingPlan {
                sun_lux,
                sun_color,
                ev100_fixed: Some(self.sensor_ev100(sun_elev_deg)),
                env_intensity: HDRI_TO_CDM2 * daylight,
                skybox_brightness: HDRI_TO_CDM2 * daylight,
            },
            Weather::Cloudy => LightingPlan {
                // Broken cloud: direct beam survives, diffuse sky lifts.
                sun_lux: sun_lux * 0.62,
                sun_color,
                ev100_fixed: Some(self.sensor_ev100(sun_elev_deg)),
                env_intensity: HDRI_TO_CDM2 * 1.08 * daylight,
                skybox_brightness: HDRI_TO_CDM2 * 0.95 * daylight,
            },
            Weather::Overcast => LightingPlan {
                // Stratus deck: the beam is a soft glow, the sky is the key.
                sun_lux: sun_lux * 0.18,
                sun_color: Color::srgb(0.93, 0.95, 1.0),
                ev100_fixed: Some(self.sensor_ev100(sun_elev_deg)),
                env_intensity: HDRI_TO_CDM2 * 1.3 * daylight,
                skybox_brightness: HDRI_TO_CDM2 * 0.82 * daylight,
            },
            Weather::Fog => LightingPlan {
                // Heavy overcast: direct sun mostly scattered away.
                sun_lux: sun_lux * 0.25,
                sun_color: Color::srgb(0.9, 0.93, 1.0),
                ev100_fixed: Some(self.sensor_ev100(sun_elev_deg)),
                env_intensity: HDRI_TO_CDM2 * 1.2 * daylight,
                skybox_brightness: HDRI_TO_CDM2 * 0.8 * daylight,
            },
            Weather::Rain => LightingPlan {
                sun_lux: sun_lux * 0.3,
                sun_color: Color::srgb(0.88, 0.92, 1.0),
                ev100_fixed: Some(self.sensor_ev100(sun_elev_deg)),
                env_intensity: HDRI_TO_CDM2 * 1.1 * daylight,
                skybox_brightness: HDRI_TO_CDM2 * 0.7 * daylight,
            },
            Weather::Night => LightingPlan {
                // Moonlight ≈ 0.2–0.3 lx, cool color temperature.
                sun_lux: 0.25,
                sun_color: kelvin_to_rgb(12000.0),
                ev100_fixed: Some(self.sensor_ev100(sun_elev_deg)),
                env_intensity: HDRI_TO_CDM2 * 0.004,
                skybox_brightness: HDRI_TO_CDM2 * 0.004,
            },
        }
    }
}

/// The physical atmosphere a weather label implies.
///
/// These are the *defaults* a label seeds; every one of them is an
/// independently authorable control on `engine::Lighting`, so a lookdev
/// surface can dial turbidity or visibility away from the label without
/// leaving the label.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct WeatherAtmosphere {
    /// Cloud deck type for the medium's slab term.
    pub deck: crate::atmosphere::CloudDeck,
    /// Fractional cover, scaling the deck's vertical optical depth.
    pub cloud_cover: f32,
    /// Linke turbidity of the tropospheric aerosol column.
    pub turbidity: f32,
    /// Meteorological visibility, m (Koschmieder).
    pub visibility_m: f32,
}

impl Weather {
    /// Physical atmosphere state this label seeds.
    ///
    /// Nothing here is a brightness multiplier: cloud decks darken the beam
    /// because the transmittance LUT integrates through them, and haze
    /// desaturates distance because the aerial-perspective LUT integrates
    /// through it. See `crate::atmosphere`.
    pub fn atmosphere(&self) -> WeatherAtmosphere {
        use crate::atmosphere::CloudDeck;
        match self {
            // Clean maritime-continental air: AOD(550) ~ 0.08.
            Weather::Clear => WeatherAtmosphere {
                deck: CloudDeck::None,
                cloud_cover: 0.0,
                turbidity: 2.4,
                visibility_m: 45_000.0,
            },
            // Broken fair-weather cumulus over a slightly hazier column.
            Weather::Cloudy => WeatherAtmosphere {
                deck: CloudDeck::Cumulus,
                cloud_cover: 0.45,
                turbidity: 2.9,
                visibility_m: 25_000.0,
            },
            // Continuous stratus sheet: tau ~ 22, beam gone.
            Weather::Overcast => WeatherAtmosphere {
                deck: CloudDeck::Stratus,
                cloud_cover: 0.95,
                turbidity: 3.2,
                visibility_m: 12_000.0,
            },
            // Radiation fog under a low stratus lid.
            Weather::Fog => WeatherAtmosphere {
                deck: CloudDeck::Stratus,
                cloud_cover: 0.75,
                turbidity: 3.0,
                visibility_m: 150.0,
            },
            // Nimbostratus with rain-washed (hence clean) sub-cloud air.
            Weather::Rain => WeatherAtmosphere {
                deck: CloudDeck::Nimbostratus,
                cloud_cover: 0.90,
                turbidity: 2.6,
                visibility_m: 3_000.0,
            },
            // Night is a clock state, not an air-mass state.
            Weather::Night => WeatherAtmosphere {
                deck: CloudDeck::None,
                cloud_cover: 0.0,
                turbidity: 2.4,
                visibility_m: 45_000.0,
            },
        }
    }
}

/// Attach volumetric fog (camera-side) + one big fog volume over the visible
/// corridor. Deterministic: static volume, no animated density texture.
pub fn spawn_fog(commands: &mut Commands, eye: Vec3, fwd: Vec3, step_count: u32) {
    let ambient = kelvin_to_rgb(7500.0);
    commands.spawn(VolumetricFog {
        ambient_color: ambient,
        ambient_intensity: 0.35,
        jitter: 0.0, // no TAA in headless capture; keep deterministic
        step_count,
    });
    commands.spawn((
        FogVolume {
            fog_color: Color::srgb(0.75, 0.8, 0.88),
            density_factor: 0.028,
            density_texture: None,
            absorption: 0.25,
            scattering: 0.35,
            scattering_asymmetry: 0.6,
            light_tint: Color::srgb(0.95, 0.97, 1.0),
            ..Default::default()
        },
        Transform::from_translation(eye + fwd * 180.0)
            .with_scale(Vec3::new(700.0, 160.0, 500.0)),
        Visibility::default(),
    ));
}

/// Mark the directional light as a volumetric light so fog shows shafts.
pub fn attach_volumetric_light(commands: &mut Commands, sun_entity: Entity) {
    commands.entity(sun_entity).insert(VolumetricLight);
}

/// Streetlight emissives + point lights for the night state. Lamps are placed
/// along the street axis (the camera's view direction at the baseline POV),
/// two rows ±4 m lateral, 25 m spacing, 7 m poles above the road plane.
/// Deterministic: fixed count/spacing, no flicker.
pub fn spawn_streetlights(
    commands: &mut Commands,
    meshes: &mut bevy::asset::Assets<bevy::render::mesh::Mesh>,
    materials: &mut bevy::asset::Assets<StandardMaterial>,
    eye: Vec3,
    fwd: Vec3,
) {
    let lateral = Vec3::new(-fwd.z, 0.0, fwd.x).normalize();
    let lamp_color = kelvin_to_rgb(2700.0);
    let head_mesh = meshes.add(
        SphereMeshBuilder::new(0.16, SphereKind::Uv { sectors: 12, stacks: 8 }).build(),
    );
    let head_material = materials.add(StandardMaterial {
        emissive: LinearRgba::rgb(40.0, 36.0, 28.0),
        base_color: Color::srgb(1.0, 0.9, 0.7),
        ..Default::default()
    });
    let mut i = 0u32;
    let mut t = -75.0f32;
    while t <= 200.0 {
        let side = if i % 2 == 0 { 1.0 } else { -1.0 };
        let pos = eye + fwd * t + lateral * (4.0 * side) + Vec3::Y * 7.0;
        commands.spawn((
            PointLight {
                color: lamp_color,
                // LED streetlight luminous power ≈ 3_500 lm
                intensity: 3_500.0,
                range: 45.0,
                radius: 0.16,
                shadow_maps_enabled: false,
                ..Default::default()
            },
            Transform::from_translation(pos),
        ));
        commands.spawn((
            Mesh3d(head_mesh.clone()),
            MeshMaterial3d(head_material.clone()),
            Transform::from_translation(pos),
        ));
        t += 25.0;
        i += 1;
    }
}

/// Wet-road reflectance ramp (rain): find drivable-surface materials by mesh
/// name and lerp roughness down + darken base color. `wetness` ∈ [0,1].
/// Runs once after the scene is spawned.
pub fn apply_wetness(
    wetness: f32,
    meshes_q: &mut bevy::prelude::Query<
        (
            Entity,
            Option<&Name>,
            Option<&bevy::prelude::ChildOf>,
            &Mesh3d,
            &MeshMaterial3d<StandardMaterial>,
        ),
    >,
    names_q: &bevy::prelude::Query<&Name>,
    materials: &mut bevy::asset::Assets<StandardMaterial>,
) -> usize {
    const ROAD_MARKERS: [&str; 2] = ["asphalt1_road", "roads_road_layer0"];
    let mut touched = 0;
    let mut seen = std::collections::HashSet::new();
    for (_e, name, parent, _mesh, mat) in meshes_q.iter_mut() {
        let mut label = name.map(|n| n.as_str()).unwrap_or("");
        if label.is_empty() {
            if let Some(p) = parent {
                if let Ok(pn) = names_q.get(p.0) {
                    label = pn.as_str();
                }
            }
        }
        let lower = label.to_ascii_lowercase();
        if ROAD_MARKERS.iter().any(|m| lower.contains(m))
            && seen.insert(mat.id().clone())
        {
            let Some(mut material) = materials.get_mut(&mat.0) else {
                continue;
            };
            let material = material.deref_mut();
            material.perceptual_roughness = 0.9 * (1.0 - wetness) + 0.16 * wetness;
            material.metallic = material.metallic.max(0.04 * wetness);
            let mut c = material.base_color.to_linear();
            let k = 1.0 - 0.35 * wetness;
            c.red *= k;
            c.green *= k;
            c.blue *= k;
            material.base_color = Color::from(c);
            touched += 1;
        }
    }
    touched
}
