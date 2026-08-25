//! Per-camera render profiles. The sensor path deliberately remains a small,
//! fixed, non-temporal stack; the cinematic path is driven by serializable
//! settings so campaign cameras can use the expensive pipeline alongside a
//! byte-stable sensor rig.

use anyhow::{bail, Result};
use bevy::anti_alias::taa::TemporalAntiAliasing;
use bevy::camera::{Exposure, Hdr};
use bevy::core_pipeline::tonemapping::Tonemapping;
use bevy::light::Skybox;
use bevy::pbr::{
    ScreenSpaceAmbientOcclusion, ScreenSpaceAmbientOcclusionQualityLevel,
    ScreenSpaceReflections,
};
use bevy::post_process::bloom::Bloom;
use bevy::post_process::dof::{DepthOfField, DepthOfFieldMode};
use bevy::post_process::effect_stack::{ChromaticAberration, LensDistortion, Vignette};
use bevy::post_process::motion_blur::MotionBlur;
use bevy::render::view::{ColorGrading, ColorGradingGlobal, ColorGradingSection};
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, bevy::prelude::Resource)]
pub enum RenderProfile {
    Sensor,
    Cinematic,
}

/// RTX 3080 campaign-quality settings for one cinematic camera. All visual
/// constants live here rather than in camera construction code. A job may
/// override any field with `profileConfig.cinematic`.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct CinematicFx {
    pub taa: bool,
    pub ssr: bool,
    pub ssao: bool,
    pub ssao_ultra: bool,
    pub chromatic_aberration: f32,
    pub vignette_intensity: f32,
    pub lens_distortion: f32,
    pub dof_aperture_f_stops: f32,
    pub dof_focal_distance_m: f32,
    pub dof_enabled: bool,
    /// Shutter angle in degrees; 0 skips the motion-blur pass entirely.
    pub motion_shutter_angle: f32,
    pub motion_samples: u32,
    /// Bloom intensity (`Bloom::NATURAL` is 0.15); 0 disables bloom.
    pub bloom_intensity: f32,
    pub grading_exposure: f32,
    pub grading_temperature: f32,
    pub grading_tint: f32,
    pub grading_post_saturation: f32,
    pub grading_contrast: f32,
}

impl Default for CinematicFx {
    fn default() -> Self {
        Self {
            // TAA is the largest vegetation/geometry edge-quality gain and
            // also stabilizes GTAO. SSR provides the wet-road response absent
            // from the forward sensor view.
            taa: true,
            ssr: true,
            ssao: true,
            ssao_ultra: true,
            // UE's default film camera is nearly rectilinear and does not
            // visibly fringe high-contrast edges.
            chromatic_aberration: 0.0,
            vignette_intensity: 0.16,
            lens_distortion: 0.008,
            // Campaign chase cameras retain broad scene readability; callers
            // opt into DoF per camera when a focal subject is known.
            dof_aperture_f_stops: 8.0,
            dof_focal_distance_m: 28.0,
            dof_enabled: false,
            motion_shutter_angle: 90.0,
            motion_samples: 8,
            bloom_intensity: 0.10,
            // Subtle UE5-filmic approximation on top of AgX: protect bright
            // sky, add midtone separation, and avoid oversaturated foliage.
            grading_exposure: 0.35,
            grading_temperature: 0.0,
            grading_tint: 0.0,
            grading_post_saturation: 0.98,
            grading_contrast: 1.02,
        }
    }
}

impl CinematicFx {
    pub fn validate(&self) -> Result<()> {
        if !(0.0..=360.0).contains(&self.motion_shutter_angle) {
            bail!("cinematic motionShutterAngle must be in [0, 360]");
        }
        if self.motion_samples == 0 || self.motion_samples > 32 {
            bail!("cinematic motionSamples must be in [1, 32]");
        }
        if self.dof_aperture_f_stops <= 0.0 || self.dof_focal_distance_m <= 0.0 {
            bail!("cinematic DoF aperture and focal distance must be positive");
        }
        if self.bloom_intensity < 0.0
            || self.vignette_intensity < 0.0
            || self.grading_post_saturation < 0.0
            || self.grading_contrast <= 0.0
        {
            bail!("cinematic intensities must be non-negative and contrast positive");
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct RenderProfileConfig {
    pub cinematic: CinematicFx,
}

impl RenderProfile {
    pub fn parse(s: &str) -> anyhow::Result<Self> {
        match s.to_ascii_lowercase().as_str() {
            "sensor" => Ok(RenderProfile::Sensor),
            "cinematic" | "cine" => Ok(RenderProfile::Cinematic),
            other => anyhow::bail!("unknown profile '{other}' (sensor|cinematic)"),
        }
    }

    /// Insert all per-view components for this profile on an RGB camera.
    ///
    /// `sky` is attached here too so both profiles share one scene state but
    /// carry their own skybox brightness (night dims it).
    #[allow(clippy::too_many_arguments)]
    pub fn apply(
        self,
        commands: &mut bevy::prelude::Commands,
        entity: bevy::prelude::Entity,
        // Fixed exposure from the resolved `LightingPlan` (`ev100_fixed`),
        // per docs/lighting-calibration.md §Exposure.
        ev100: f32,
        sky: Option<bevy::asset::Handle<bevy::image::Image>>,
        skybox_brightness: f32,
        fx: CinematicFx,
    ) {
        match self {
            RenderProfile::Sensor => {
                commands.entity(entity).insert((
                    Tonemapping::None,
                    Exposure { ev100 },
                ));
                if let Some(sky) = sky.clone() {
                    commands.entity(entity).insert(Skybox {
                        image: Some(sky),
                        brightness: skybox_brightness,
                        ..Default::default()
                    });
                }
                // Deliberately no temporal/post components in this branch.
            }
            RenderProfile::Cinematic => {
                let grading_section = ColorGradingSection {
                    contrast: fx.grading_contrast,
                    ..Default::default()
                };
                let mut cam = commands.entity(entity);
                cam.insert((
                    Hdr,
                    Tonemapping::AgX,
                    Exposure { ev100 },
                    ColorGrading {
                        global: ColorGradingGlobal {
                            exposure: fx.grading_exposure,
                            temperature: fx.grading_temperature,
                            tint: fx.grading_tint,
                            post_saturation: fx.grading_post_saturation,
                            ..Default::default()
                        },
                        shadows: grading_section,
                        midtones: grading_section,
                        highlights: grading_section,
                    },
                    Vignette {
                        intensity: fx.vignette_intensity,
                        ..Default::default()
                    },
                    LensDistortion {
                        intensity: fx.lens_distortion,
                        ..Default::default()
                    },
                    ChromaticAberration {
                        intensity: fx.chromatic_aberration,
                        ..Default::default()
                    },
                ));
                if fx.bloom_intensity > 0.0 {
                    cam.insert(Bloom {
                        intensity: fx.bloom_intensity,
                        ..Bloom::NATURAL
                    });
                }
                if fx.dof_enabled {
                    cam.insert(DepthOfField {
                        mode: DepthOfFieldMode::Bokeh,
                        focal_distance: fx.dof_focal_distance_m,
                        aperture_f_stops: fx.dof_aperture_f_stops,
                        max_depth: 950.0,
                        ..Default::default()
                    });
                }
                if fx.motion_shutter_angle > 0.0 {
                    cam.insert(MotionBlur {
                        shutter_angle: fx.motion_shutter_angle,
                        samples: fx.motion_samples,
                    });
                }
                if let Some(sky) = sky {
                    cam.insert(Skybox {
                        image: Some(sky),
                        brightness: skybox_brightness,
                        ..Default::default()
                    });
                }
                if fx.taa {
                    cam.insert(TemporalAntiAliasing::default());
                }
                if fx.ssr {
                    cam.insert(ScreenSpaceReflections::default());
                }
                if fx.ssao {
                    cam.insert(ScreenSpaceAmbientOcclusion {
                        quality_level: if fx.ssao_ultra {
                            ScreenSpaceAmbientOcclusionQualityLevel::Ultra
                        } else {
                            ScreenSpaceAmbientOcclusionQualityLevel::High
                        },
                        ..Default::default()
                    });
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cinematic_defaults_enable_quality_stack_without_dof() {
        let fx = RenderProfileConfig::default().cinematic;
        assert!(fx.taa && fx.ssr && fx.ssao && fx.ssao_ultra);
        assert!(!fx.dof_enabled);
        assert_eq!(fx.chromatic_aberration, 0.0);
        fx.validate().unwrap();
    }

    #[test]
    fn partial_profile_config_preserves_unspecified_campaign_defaults() {
        let cfg: RenderProfileConfig = serde_json::from_str(
            r#"{"cinematic":{"dofEnabled":true,"dofFocalDistanceM":12.5}}"#,
        )
        .unwrap();
        assert!(cfg.cinematic.dof_enabled);
        assert_eq!(cfg.cinematic.dof_focal_distance_m, 12.5);
        assert!(cfg.cinematic.taa);
        assert!(cfg.cinematic.ssr);
    }

    #[test]
    fn rejects_out_of_range_temporal_settings() {
        let invalid = CinematicFx {
            motion_shutter_angle: 361.0,
            ..Default::default()
        };
        assert!(invalid.validate().is_err());
    }
}
