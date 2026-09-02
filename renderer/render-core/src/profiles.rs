//! Per-camera render profiles. The sensor path deliberately remains a small,
//! fixed, non-temporal stack; the cinematic path is driven by serializable
//! settings so campaign cameras can use the expensive pipeline alongside a
//! byte-stable sensor rig.

use anyhow::{bail, Result};
use bevy::anti_alias::fxaa::Fxaa;
use bevy::anti_alias::smaa::{Smaa, SmaaPreset};
use bevy::anti_alias::taa::TemporalAntiAliasing;
use bevy::camera::{Exposure, Hdr};
use bevy::core_pipeline::prepass::{
    DeferredPrepass, DepthPrepass, MotionVectorPrepass, NormalPrepass,
};
use bevy::core_pipeline::tonemapping::Tonemapping;
use bevy::light::Skybox;
use bevy::pbr::{
    ContactShadows, ScreenSpaceAmbientOcclusion, ScreenSpaceAmbientOcclusionQualityLevel,
    ScreenSpaceReflections,
};
use bevy::post_process::bloom::Bloom;
use bevy::post_process::dof::{DepthOfField, DepthOfFieldMode};
use bevy::post_process::effect_stack::{ChromaticAberration, LensDistortion, Vignette};
use bevy::post_process::motion_blur::MotionBlur;
use bevy::render::camera::{MipBias, TemporalJitter};
use bevy::render::view::{ColorGrading, ColorGradingGlobal, ColorGradingSection};
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, bevy::prelude::Resource)]
pub enum RenderProfile {
    Sensor,
    Cinematic,
}

/// Mutually exclusive anti-aliasing mode for a cinematic camera.
///
/// Bevy 0.19 ships exactly three AA implementations that work on an
/// offscreen `Image` target: FXAA (post-tonemap luma edge filter), SMAA
/// (post-tonemap morphological, four preset quality levels) and TAA
/// (pre-tonemap temporal accumulation with jitter + motion vectors). They
/// are alternatives, not layers — running two of them stacks two edge
/// filters over the same pixels — so this is one enum, not a set of flags.
///
/// DLSS is deliberately absent: `bevy_anti_alias::dlss` is behind a `dlss`
/// cargo feature that this build does not enable, and it needs a swapchain
/// -backed view rather than the service's readback target.
///
/// MSAA is not here either. It is a `Msaa` component, not a post-process,
/// and both `engine.rs` camera paths pin it to `Msaa::Off` so the
/// instance-ID and depth passes stay hash-stable (Bevy's SSAO also
/// hard-requires `Msaa::Off`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AntiAlias {
    /// No anti-aliasing pass at all.
    Off,
    /// Fast approximate AA. One cheap fullscreen pass; softens fine detail.
    Fxaa,
    /// SMAA, 4 search steps, no diagonal or corner detection.
    SmaaLow,
    /// SMAA, 8 search steps, no diagonal or corner detection.
    SmaaMedium,
    /// SMAA, 16 search steps + diagonals + corner detection (Bevy default).
    SmaaHigh,
    /// SMAA, 32 search steps + diagonals + corner detection.
    SmaaUltra,
    /// Temporal AA. Best edge and vegetation stability, and it is what
    /// stabilizes GTAO, so it stays the campaign default.
    #[default]
    Taa,
}

impl AntiAlias {
    /// Stable wire name; matches the serde representation.
    pub fn as_str(self) -> &'static str {
        match self {
            AntiAlias::Off => "off",
            AntiAlias::Fxaa => "fxaa",
            AntiAlias::SmaaLow => "smaa-low",
            AntiAlias::SmaaMedium => "smaa-medium",
            AntiAlias::SmaaHigh => "smaa-high",
            AntiAlias::SmaaUltra => "smaa-ultra",
            AntiAlias::Taa => "taa",
        }
    }

    fn smaa_preset(self) -> Option<SmaaPreset> {
        match self {
            AntiAlias::SmaaLow => Some(SmaaPreset::Low),
            AntiAlias::SmaaMedium => Some(SmaaPreset::Medium),
            AntiAlias::SmaaHigh => Some(SmaaPreset::High),
            AntiAlias::SmaaUltra => Some(SmaaPreset::Ultra),
            _ => None,
        }
    }

    /// Every mode, in ascending cost order. The wire vocabulary is derived
    /// from this, so a UI can enumerate it without hard-coding names.
    pub const ALL: [AntiAlias; 7] = [
        AntiAlias::Off,
        AntiAlias::Fxaa,
        AntiAlias::SmaaLow,
        AntiAlias::SmaaMedium,
        AntiAlias::SmaaHigh,
        AntiAlias::SmaaUltra,
        AntiAlias::Taa,
    ];

    /// Parse a wire name, listing the valid vocabulary on failure.
    pub fn parse(s: &str) -> Result<Self> {
        let wanted = s.trim().to_ascii_lowercase();
        Self::ALL
            .into_iter()
            .find(|mode| mode.as_str() == wanted)
            .ok_or_else(|| {
                anyhow::anyhow!(
                    "unknown anti-aliasing mode '{s}' ({})",
                    Self::ALL
                        .map(AntiAlias::as_str)
                        .join("|")
                )
            })
    }

    /// Insert exactly one AA component on `cam`, or none for [`Self::Off`].
    ///
    /// Callers must have run [`RenderProfile::strip`] first: `insert` cannot
    /// express "and remove the other two".
    fn insert(self, cam: &mut bevy::ecs::system::EntityCommands) {
        match self {
            AntiAlias::Off => {}
            AntiAlias::Fxaa => {
                cam.insert(Fxaa::default());
            }
            AntiAlias::Taa => {
                cam.insert(TemporalAntiAliasing::default());
            }
            _ => {
                cam.insert(Smaa {
                    preset: self.smaa_preset().expect("non-SMAA variants handled above"),
                });
            }
        }
    }
}

/// Display transform for the cinematic path.
///
/// The sensor profile is deliberately untonemapped (linear output is the
/// machine-vision contract), so this only reaches cinematic cameras.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ToneMap {
    // Kebab-casing `AgX` would produce `ag-x`; the wire name stays `agx`.
    #[default]
    #[serde(rename = "agx")]
    AgX,
    TonyMcMapface,
    AcesFitted,
    BlenderFilmic,
    Reinhard,
    ReinhardLuminance,
    SomewhatBoringDisplayTransform,
    /// Bypass the display transform (linear).
    None,
}

impl ToneMap {
    pub fn bevy(self) -> Tonemapping {
        match self {
            ToneMap::AgX => Tonemapping::AgX,
            ToneMap::TonyMcMapface => Tonemapping::TonyMcMapface,
            ToneMap::AcesFitted => Tonemapping::AcesFitted,
            ToneMap::BlenderFilmic => Tonemapping::BlenderFilmic,
            ToneMap::Reinhard => Tonemapping::Reinhard,
            ToneMap::ReinhardLuminance => Tonemapping::ReinhardLuminance,
            ToneMap::SomewhatBoringDisplayTransform => {
                Tonemapping::SomewhatBoringDisplayTransform
            }
            ToneMap::None => Tonemapping::None,
        }
    }
}

/// RTX 3080 campaign-quality settings for one cinematic camera. All visual
/// constants live here rather than in camera construction code. A job may
/// override any field with `profileConfig.cinematic`.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct CinematicFx {
    /// Anti-aliasing mode. Mutually exclusive; see [`AntiAlias`].
    pub aa: AntiAlias,
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
    /// Display transform. Defaults to the campaign's AgX.
    pub tone_map: ToneMap,
}

impl Default for CinematicFx {
    fn default() -> Self {
        Self {
            // TAA is the largest vegetation/geometry edge-quality gain and
            // also stabilizes GTAO, so it remains the campaign default.
            aa: AntiAlias::Taa,
            // SSR provides the wet-road response absent from the forward
            // sensor view.
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
            // Off by default: the lab records with a sharp shutter; callers
            // that want blur set an angle per camera.
            motion_shutter_angle: 0.0,
            motion_samples: 8,
            bloom_intensity: 0.10,
            // Subtle UE5-filmic approximation on top of AgX: protect bright
            // sky, add midtone separation, and avoid oversaturated foliage.
            grading_exposure: 0.35,
            grading_temperature: 0.0,
            grading_tint: 0.0,
            grading_post_saturation: 0.98,
            grading_contrast: 1.02,
            tone_map: ToneMap::AgX,
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

    /// Remove every component [`Self::apply`] may have inserted.
    ///
    /// Re-applying alone is not enough to change a look: turning TAA, SSAO,
    /// bloom, DoF or motion blur *off* means the component has to go, and
    /// `insert` cannot express that. A lookdev surface strips first, then
    /// applies the new configuration to the same live camera.
    ///
    /// The tail of this list is the *required*-component fallout. Bevy's
    /// `#[require(..)]` inserts `TemporalJitter`/`MipBias`/prepass markers
    /// alongside `TemporalAntiAliasing`, `ScreenSpaceAmbientOcclusion` and
    /// `ScreenSpaceReflections`, but `remove` of the requiring component
    /// leaves them behind. Left in place, `TemporalJitter` keeps offsetting
    /// the projection every frame with no TAA resolve to undo it and
    /// `MipBias(-1.0)` keeps biasing texture sampling sharp — which is
    /// exactly the "switching TAA off still looks like TAA" bug. They go
    /// too; whichever mode is applied next re-requires the ones it needs.
    pub fn strip(commands: &mut bevy::prelude::Commands, entity: bevy::prelude::Entity) {
        commands
            .entity(entity)
            .remove::<Hdr>()
            .remove::<Tonemapping>()
            .remove::<Exposure>()
            .remove::<ColorGrading>()
            .remove::<Vignette>()
            .remove::<LensDistortion>()
            .remove::<ChromaticAberration>()
            .remove::<Bloom>()
            .remove::<DepthOfField>()
            .remove::<MotionBlur>()
            .remove::<Skybox>()
            .remove::<TemporalAntiAliasing>()
            .remove::<Fxaa>()
            .remove::<Smaa>()
            .remove::<ScreenSpaceReflections>()
            .remove::<ScreenSpaceAmbientOcclusion>()
            .remove::<ContactShadows>()
            .remove::<TemporalJitter>()
            .remove::<MipBias>()
            .remove::<DepthPrepass>()
            .remove::<NormalPrepass>()
            .remove::<MotionVectorPrepass>()
            .remove::<DeferredPrepass>();
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
                    fx.tone_map.bevy(),
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
                fx.aa.insert(&mut cam);
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
                    cam.insert(ContactShadows::default());
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
        assert_eq!(fx.aa, AntiAlias::Taa);
        assert!(fx.ssr && fx.ssao && fx.ssao_ultra);
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
        assert_eq!(cfg.cinematic.aa, AntiAlias::Taa);
        assert!(cfg.cinematic.ssr);
    }

    #[test]
    fn anti_alias_wire_names_round_trip() {
        for (wire, mode) in [
            ("off", AntiAlias::Off),
            ("fxaa", AntiAlias::Fxaa),
            ("smaa-low", AntiAlias::SmaaLow),
            ("smaa-medium", AntiAlias::SmaaMedium),
            ("smaa-high", AntiAlias::SmaaHigh),
            ("smaa-ultra", AntiAlias::SmaaUltra),
            ("taa", AntiAlias::Taa),
        ] {
            let cfg: RenderProfileConfig =
                serde_json::from_str(&format!(r#"{{"cinematic":{{"aa":"{wire}"}}}}"#)).unwrap();
            assert_eq!(cfg.cinematic.aa, mode, "decoding {wire}");
            assert_eq!(mode.as_str(), wire);
            assert_eq!(serde_json::to_value(mode).unwrap(), serde_json::json!(wire));
        }
        assert!(serde_json::from_str::<RenderProfileConfig>(
            r#"{"cinematic":{"aa":"smaa-insane"}}"#
        )
        .is_err());
    }

    /// Each mode must land exactly one AA component, and switching between
    /// modes on a live camera must not accumulate two of them — including
    /// TAA's required `TemporalJitter`, which has no visible owner once
    /// `TemporalAntiAliasing` is gone.
    #[test]
    fn anti_alias_modes_are_mutually_exclusive_across_restrips() {
        // Every mode, plus a repeat visit so the strip path is exercised
        // from a temporal mode back to a spatial one and to nothing.
        let modes = [
            AntiAlias::Off,
            AntiAlias::Fxaa,
            AntiAlias::SmaaLow,
            AntiAlias::SmaaMedium,
            AntiAlias::SmaaHigh,
            AntiAlias::SmaaUltra,
            AntiAlias::Taa,
            AntiAlias::Off,
            AntiAlias::Fxaa,
            AntiAlias::Taa,
            AntiAlias::SmaaHigh,
        ];
        let mut world = bevy::prelude::World::new();
        let cam = world.spawn_empty().id();
        for mode in modes {
            {
                let mut commands = world.commands();
                RenderProfile::strip(&mut commands, cam);
                RenderProfile::Cinematic.apply(
                    &mut commands,
                    cam,
                    12.0,
                    None,
                    1.0,
                    CinematicFx {
                        aa: mode,
                        ..Default::default()
                    },
                );
            }
            world.flush();
            let taa = world.get::<TemporalAntiAliasing>(cam).is_some();
            let fxaa = world.get::<Fxaa>(cam).is_some();
            let smaa = world.get::<Smaa>(cam).map(|s| s.preset);
            assert_eq!(
                usize::from(taa) + usize::from(fxaa) + usize::from(smaa.is_some()),
                usize::from(mode != AntiAlias::Off),
                "{} left the wrong number of AA components",
                mode.as_str()
            );
            // `SmaaPreset` has no `Debug`, so compare it by equality and
            // carry the mode name in the message instead.
            let expected_preset = match mode {
                AntiAlias::SmaaLow => Some(SmaaPreset::Low),
                AntiAlias::SmaaMedium => Some(SmaaPreset::Medium),
                AntiAlias::SmaaHigh => Some(SmaaPreset::High),
                AntiAlias::SmaaUltra => Some(SmaaPreset::Ultra),
                _ => None,
            };
            assert!(
                smaa == expected_preset,
                "{} produced the wrong SMAA preset",
                mode.as_str()
            );
            assert_eq!(taa, mode == AntiAlias::Taa, "TAA for {}", mode.as_str());
            assert_eq!(fxaa, mode == AntiAlias::Fxaa, "FXAA for {}", mode.as_str());
            // TAA's jitter must not outlive TAA: a stale `TemporalJitter`
            // offsets the projection with nothing left to resolve it.
            assert_eq!(
                world.get::<TemporalJitter>(cam).is_some(),
                taa,
                "TemporalJitter leaked past {}",
                mode.as_str()
            );
        }
    }

    #[test]
    fn rejects_out_of_range_temporal_settings() {
        let invalid = CinematicFx {
            motion_shutter_angle: 361.0,
            ..Default::default()
        };
        assert!(invalid.validate().is_err());
    }

    #[test]
    fn sensor_profile_has_no_stochastic_screen_space_components() {
        let mut world = bevy::prelude::World::new();
        let sensor = world.spawn_empty().id();
        let cinematic = world.spawn_empty().id();
        {
            let mut commands = world.commands();
            RenderProfile::Sensor.apply(
                &mut commands,
                sensor,
                12.0,
                None,
                1.0,
                CinematicFx::default(),
            );
            RenderProfile::Cinematic.apply(
                &mut commands,
                cinematic,
                12.0,
                None,
                1.0,
                CinematicFx::default(),
            );
        }
        world.flush();
        assert!(world.get::<TemporalAntiAliasing>(sensor).is_none());
        assert!(world.get::<ScreenSpaceAmbientOcclusion>(sensor).is_none());
        assert!(world.get::<ContactShadows>(sensor).is_none());
        assert!(world.get::<TemporalAntiAliasing>(cinematic).is_some());
        assert!(world.get::<ScreenSpaceAmbientOcclusion>(cinematic).is_some());
        assert!(world.get::<ContactShadows>(cinematic).is_some());
    }
}
