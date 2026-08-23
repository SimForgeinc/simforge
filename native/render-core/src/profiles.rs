//! WSB4 render profiles: `sensor` and `cinematic`, applied per camera view
//! from the same scene state.
//!
//! - `sensor`: linear output (`Tonemapping::None`), fixed weather-calibrated
//!   EV100, zero temporal effects, no bloom/grain — hash-stable.
//! - `cinematic`: AgX tonemap, bloom, vignette, lens distortion, slight DoF +
//!   motion blur, optional TAA, auto-exposure, film-grain custom pass.

use bevy::anti_alias::taa::TemporalAntiAliasing;
use bevy::camera::Exposure;
use bevy::core_pipeline::tonemapping::Tonemapping;
use bevy::light::Skybox;
use bevy::pbr::ScreenSpaceReflections;
use bevy::post_process::bloom::Bloom;
use bevy::post_process::dof::{DepthOfField, DepthOfFieldMode};
use bevy::post_process::effect_stack::{ChromaticAberration, LensDistortion, Vignette};
use bevy::post_process::motion_blur::MotionBlur;

use crate::weather::Weather;

#[derive(Clone, Copy, Debug, PartialEq, Eq, bevy::prelude::Resource)]
pub enum RenderProfile {
    Sensor,
    Cinematic,
}

/// Tunable cinematic lens/post parameters (CLI-exposed for stills work).
///
/// Defaults reproduce the committed cinematic profile; stills work (static
/// camera, supersampled AA) wants chromatic aberration low or off, DoF at
/// f/16-class, and motion blur disabled — a static camera only smears.


#[derive(Clone, Copy, Debug)]
pub struct CinematicFx {
    pub chromatic_aberration: f32,
    pub dof_aperture_f_stops: f32,
    pub dof_enabled: bool,
    /// Shutter angle in degrees; 0 skips the motion-blur pass entirely.
    pub motion_shutter_angle: f32,
    /// Bloom intensity (`Bloom::NATURAL` is 0.15); 0 disables bloom.
    pub bloom_intensity: f32,
}

impl Default for CinematicFx {
    fn default() -> Self {
        Self {
            chromatic_aberration: 1.2,
            dof_aperture_f_stops: 6.5,
            dof_enabled: true,
            motion_shutter_angle: 90.0,
            bloom_intensity: 0.15,
        }
    }
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
        weather: Weather,
        sky: Option<bevy::asset::Handle<bevy::image::Image>>,
        skybox_brightness: f32,
        ssr: bool,
        taa: bool,
        grain_intensity: f32,
        fx: CinematicFx,
    ) {
        let ev100 = weather.sensor_ev100();
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
                if ssr {
                    // Sensor frames stay deterministic: SSR itself is a pure
                    // screen-space pass (no temporal history), allowed only
                    // behind an explicit flag.
                    commands.entity(entity).insert(ScreenSpaceReflections::default());
                }
            }
            RenderProfile::Cinematic => {
                // NOTE: AutoExposure diverges in the deterministic headless
                // capture loop (no wall-clock adaptation); cinematic uses a
                // fixed weather-calibrated EV100 like sensor until the
                // service loop provides real frame pacing.
                let mut cam = commands.entity(entity);
                cam.insert((
                    Tonemapping::AgX,
                    Exposure { ev100 },
                    Vignette {
                        intensity: 0.35,
                        ..Default::default()
                    },
                    LensDistortion {
                        intensity: 0.04,
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
                        focal_distance: 28.0,
                        aperture_f_stops: fx.dof_aperture_f_stops,
                        max_depth: 950.0,
                        ..Default::default()
                    });
                }
                if fx.motion_shutter_angle > 0.0 {
                    cam.insert(MotionBlur {
                        shutter_angle: fx.motion_shutter_angle,
                        samples: 4,
                    });
                }
                if let Some(sky) = sky {
                    commands.entity(entity).insert(Skybox {
                        image: Some(sky),
                        brightness: skybox_brightness,
                        ..Default::default()
                    });
                }
                if taa {
                    commands.entity(entity).insert(TemporalAntiAliasing::default());
                }
                // NOTE: film grain is applied deterministically on the CPU
                // readback path (see native-render save_outputs), not as a
                // GPU pass — the Core3d ping-pong integration of a custom
                // FullscreenMaterial produced temporal ghosting; revisit as
                // a proper Core3d node.
            }
        }
    }
}
