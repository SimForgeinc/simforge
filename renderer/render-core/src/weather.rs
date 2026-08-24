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

use crate::lighting::{CLEAR_DAY_SUN_LUX, kelvin_to_rgb, LightingPlan};

/// The map HDRIs are normalized (sky ≈ 1.26 luma units, measured for
/// yale-street env/sky.hdr), not cd/m². Scale so the sky hemisphere delivers
/// ~15 klx diffuse against the 100 klx physical sun (WMO/CIE clear-day sky
/// diffuse is 10–25 klx; target shadowed/sunlit ratio ≈ 0.15–0.25 on
/// horizontal surfaces). Empirically: 18 000 gave ratio 0.034 at rung 2;
/// scaling by the same 8.33× the sun gained (12 klx → 100 klx) restores the
/// With the probe volume fixed, 150 000 measured ratio 0.65 (washed out);
/// solving e/(s+e) for the 0.20 target gives ≈20 000. NOTE: measure_shadow_fill
/// reads sRGB-encoded pixels; 20 000 measures sRGB ratio 0.49 ≈ LINEAR 0.21
/// (γ2.2), inside the 0.15–0.25 physical band, shadow tint +0.024 blue.
pub const HDRI_TO_CDM2: f32 = 20_000.0;

#[derive(Clone, Copy, Debug, PartialEq, Eq, bevy::prelude::Resource)]
pub enum Weather {
    Clear,
    Fog,
    Rain,
    Night,
}

impl Weather {
    pub fn parse(s: &str) -> anyhow::Result<Self> {
        match s.to_ascii_lowercase().as_str() {
            "clear" => Ok(Weather::Clear),
            "fog" | "mist" => Ok(Weather::Fog),
            "rain" | "wet" => Ok(Weather::Rain),
            "night" | "dusk" => Ok(Weather::Night),
            other => anyhow::bail!("unknown weather '{other}' (clear|fog|rain|night)"),
        }
    }

    /// Fixed EV100 used by the sensor profile (cinematic uses auto-exposure).
    /// Day scenes: sunny-16; night urban: lit-street exposure.
    pub fn sensor_ev100(&self) -> f32 {
        match self {
            Weather::Clear => 15.0,
            Weather::Fog => 14.0,
            Weather::Rain => 13.5,
            Weather::Night => 9.0,
        }
    }

    /// Resolve per-weather sun + IBL scaling into a `LightingPlan`.
    pub fn lighting_plan(&self, sun_dir_color: Option<Color>) -> LightingPlan {
        match self {
            Weather::Clear => LightingPlan {
                sun_lux: CLEAR_DAY_SUN_LUX,
                sun_color: sun_dir_color.unwrap_or_else(|| kelvin_to_rgb(5500.0)),
                ev100_fixed: Some(self.sensor_ev100()),
                env_intensity: HDRI_TO_CDM2,
                skybox_brightness: HDRI_TO_CDM2,
            },
            Weather::Fog => LightingPlan {
                // Heavy overcast: direct sun mostly scattered away.
                sun_lux: CLEAR_DAY_SUN_LUX * 0.25,
                sun_color: Color::srgb(0.9, 0.93, 1.0),
                ev100_fixed: Some(self.sensor_ev100()),
                env_intensity: HDRI_TO_CDM2 * 1.2,
                skybox_brightness: HDRI_TO_CDM2 * 0.8,
            },
            Weather::Rain => LightingPlan {
                sun_lux: CLEAR_DAY_SUN_LUX * 0.3,
                sun_color: Color::srgb(0.88, 0.92, 1.0),
                ev100_fixed: Some(self.sensor_ev100()),
                env_intensity: HDRI_TO_CDM2 * 1.1,
                skybox_brightness: HDRI_TO_CDM2 * 0.7,
            },
            Weather::Night => LightingPlan {
                // Moonlight ≈ 0.2–0.3 lx, cool color temperature.
                sun_lux: 0.25,
                sun_color: kelvin_to_rgb(12000.0),
                ev100_fixed: Some(self.sensor_ev100()),
                env_intensity: HDRI_TO_CDM2 * 0.004,
                skybox_brightness: HDRI_TO_CDM2 * 0.004,
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
