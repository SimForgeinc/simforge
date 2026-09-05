//! Reusable headless Bevy rendering engine for SimForge (`native` engine).
//!
//! Grown from scripts/renderer-spike/bevy-spike (GO verdict, FINDINGS.md):
//! DefaultPlugins minus Winit/Audio, no primary window, offscreen `Image`
//! render targets with GPU->CPU readback via copy_texture_to_buffer +
//! map_async. Unlike the spike CLI (which drives one App through a fixed
//! pose sequence), this module exposes a host-controlled [`SceneApp`]: the
//! owner calls [`SceneApp::render_once`] explicitly, which makes both the
//! job renderer and the long-lived service trivially sequential and
//! deterministic.
//!
//! Determinism contract (same construction rules as the spike):
//! MSAA Off, no temporal effects, deterministic instance-ID assignment
//! (meshes sorted by name then entity bits), fixed clear color, single
//! blocking readback per rendered frame.
//!
//! Lighting/profile routing: the scene is lit by the WSB4 lighting ladder
//! (`crate::lighting::spawn_lighting` — IBL sky, physical sun via the shared
//! spec docs/lighting-calibration.md) and every RGB camera gets its render
//! profile from `crate::profiles::RenderProfile::apply` (fixed EV100,
//! AgX cinematic stack, GTAO at rung ≥ 3). Temporal effects (TAA, motion
//! blur, auto-exposure) stay disabled: the host-driven single-step loop
//! renders exactly one frame per update.
use anyhow::{bail, Result};
use bevy::app::ScheduleRunnerPlugin;
use bevy::asset::RecursiveDependencyLoadState;
use crate::readiness::{GpuPending, GPU_IDLE_FRAMES};
use bevy::camera::visibility::RenderLayers;
use bevy::camera::RenderTarget;
use bevy::core_pipeline::tonemapping::Tonemapping;
use bevy::gltf::{Gltf, GltfMaterialName};
use bevy::light::DirectionalLightShadowMap;
use bevy::anti_alias::fxaa::Fxaa;
use bevy::anti_alias::smaa::{Smaa, SmaaPreset};
use bevy::anti_alias::taa::TemporalAntiAliasing;
use bevy::pbr::{DistanceFog, FogFalloff};
use bevy::log::LogPlugin;
use bevy::prelude::*;
use bevy::render::camera::ExtractedCamera;
use bevy::render::render_asset::RenderAssets;
use bevy::asset::RenderAssetUsages;
use bevy::render::render_resource::{
    Buffer, BufferDescriptor, BufferUsages, CommandEncoderDescriptor, Extent3d, MapMode,
    PollType, TexelCopyBufferInfo, TexelCopyBufferLayout, TextureDimension, TextureFormat,
    TextureUsages,
};
use bevy::render::renderer::{RenderContext, RenderDevice, RenderGraph, RenderQueue};
use bevy::render::texture::GpuImage;
use bevy::render::view::ViewDepthTexture;
use bevy::render::{Extract, Render, RenderApp, RenderSystems};
use bevy::window::ExitCondition;
use bevy::world_serialization::{WorldAssetRoot, WorldInstance, WorldInstanceSpawner};
use crate::lighting::{self, LightingRung};
use crate::profiles::{RenderProfile, RenderProfileConfig};
use crate::weather::Weather;
use bevy::mesh::{skinning::SkinnedMesh, Meshable, SphereKind, SphereMeshBuilder};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::time::{Duration, Instant};

/// Render profile: part of the render intent (native-renderer plan WSB4).
///
/// - `Sensor`: linear output (no tonemapping), fixed exposure, zero temporal
///   effects — the hash-stable machine-vision profile.
/// - `Cinematic`: AgX tonemapping + authored look — human-facing; the full
///   realism stack (WSB4) layers on top of this variant.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Profile {
    Sensor,
    Cinematic,
}

impl Profile {
    fn render_profile(self) -> RenderProfile {
        match self {
            Profile::Sensor => RenderProfile::Sensor,
            Profile::Cinematic => RenderProfile::Cinematic,
        }
    }
}

/// Scene lighting configuration, resolved through the shared lighting spec
/// (docs/lighting-calibration.md) at rung ≥ 2. `sun_lux`/`ambient` are the
/// spike-calibrated legacy values consumed only at rung < 2.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Lighting {
    #[serde(default = "default_sun_elev")]
    pub sun_elev_deg: f32,
    #[serde(default = "default_sun_azim")]
    pub sun_azim_deg: f32,
    /// Legacy spike sun illuminance; used only at rung < 2.
    #[serde(default = "default_lux")]
    pub sun_lux: f32,
    /// Legacy spike flat ambient; used only at rung 0.
    #[serde(default = "default_ambient")]
    pub ambient: f32,
    /// Lighting-ladder rung (crate::lighting): 0 spike baseline, 1 IBL,
    /// 2 physical sun/EV100, 3 +GTAO/contact shadows, 4 +PCSS.
    #[serde(default = "default_rung")]
    pub rung: u8,
    /// Weather state feeding the `LightingPlan` (sun/sky scaling + EV100).
    #[serde(default)]
    pub weather: Weather,
    /// Equirectangular HDRI for the sky/IBL. `None` generates the
    /// deterministic analytic sky (`lighting::synthetic_sky_cubemap`).
    #[serde(default)]
    pub sky_hdr: Option<String>,
    /// Multiplier on the resolved direct-sun illuminance. Applies at every
    /// rung (unlike `sun_lux`, which the ladder only honours below rung 2).
    #[serde(default = "unit_scale")]
    pub sun_scale: f32,
    /// Multiplier on the resolved IBL/environment intensity, and on the
    /// rung-0 flat ambient.
    #[serde(default = "unit_scale")]
    pub ambient_scale: f32,
    /// Multiplier on skybox brightness (the visible sky, not the IBL lobe).
    #[serde(default = "unit_scale")]
    pub sky_scale: f32,
    /// Exposure bias in stops added to the resolved fixed EV100. Positive
    /// darkens (EV100 is a stop scale), matching photographic convention
    /// inverted at the camera.
    #[serde(default)]
    pub ev100_bias: f32,
    /// Overrides the elevation-derived sun colour temperature, in kelvin.
    #[serde(default)]
    pub sun_temperature_k: Option<f32>,
    /// Fractional cloud cover in [0, 1]. `None` takes the weather label's
    /// cover. Under the physical atmosphere this scales the cloud deck's
    /// vertical optical depth as `cover^1.5`; on the legacy cubemap path it
    /// is the old sun x (1 - 0.85c) / IBL x (1 + 0.30c) / sky x (1 - 0.35c)
    /// multiplier set.
    #[serde(default)]
    pub cloud_cover: Option<f32>,
    /// Meteorological visibility in metres (Koschmieder). `None` or a value
    /// at/above `FOG_DISABLED_VISIBILITY_M` disables distance fog.
    #[serde(default)]
    pub visibility_m: Option<f32>,
    /// Extra haze in [0, 1]; divides effective visibility by (1 + 3h).
    #[serde(default)]
    pub haze: f32,
    /// Linear-sRGB fog colour override. `None` derives it from the sky.
    /// Legacy `DistanceFog` path only; ignored when `atmosphere` is on.
    #[serde(default)]
    pub fog_color: Option<[f32; 3]>,
    /// Road-surface wetness ramp in [0, 1] (roughness down, base colour
    /// darkened, a little metallic). Reversible: originals are retained.
    #[serde(default)]
    pub wetness: f32,

    // ----------------------------------------------------------- atmosphere
    /// Use the physically based Hillaire-2020 atmosphere
    /// (`crate::atmosphere`) instead of the static sky cubemap.
    ///
    /// On: the visible sky, the sun's colour and attenuation, the IBL and
    /// the distance aerial perspective all come out of one LUT solve, and
    /// `DistanceFog` is not attached (the aerial-perspective LUT already
    /// fogs the scene — attaching both would fog it twice).
    #[serde(default = "default_true")]
    pub atmosphere: bool,
    /// Linke turbidity of the tropospheric aerosol column. `None` takes the
    /// weather label's value. 1.9 = Rayleigh-only, 2.5 typical clear, 6+
    /// heavily polluted.
    #[serde(default)]
    pub turbidity: Option<f32>,
    /// Total column ozone, Dobson units. `None` = 300 (mid-latitude mean).
    #[serde(default)]
    pub ozone_du: Option<f32>,
    /// Rayleigh density multiplier, i.e. surface air density relative to
    /// standard sea level. `None` = 1.0.
    #[serde(default)]
    pub air_density: Option<f32>,
    /// Cloud deck type. `None` takes the weather label's deck.
    #[serde(default)]
    pub cloud_deck: Option<crate::atmosphere::CloudDeck>,
    /// Ground elevation of the scene in world Y, m. The atmosphere entity is
    /// placed `inner_radius` below this, so scene altitude is measured from
    /// it. `None` uses the corpus default and is refined from the scene's
    /// own ground field once tiles are loaded.
    #[serde(default)]
    pub ground_y: Option<f32>,
    /// The camera the meter reads the sky through (world forward, vertical
    /// FOV, aspect). With it, the applied EV never lets the brightest sky
    /// the camera frames — the solar aureole on a sunward shot — rise more
    /// than [`SKY_HIGHLIGHT_STOPS`] above middle grey. `None` meters on
    /// incident light alone.
    #[serde(default)]
    pub meter_view: Option<crate::atmosphere::MeterView>,
    /// UTC/site-resolved celestial, sky, fixture and honest fallback controls.
    #[serde(default)]
    pub night: crate::night::NightControls,
}

/// At or above this visibility, distance fog is not attached at all.
pub const FOG_DISABLED_VISIBILITY_M: f32 = 15_000.0;

/// Camera far plane assumed when the aerial-perspective LUT is sized before
/// any camera has registered. Matches the render service's `default_far`.
pub const DEFAULT_FAR_PLANE_M: f32 = 900.0;

// The Lookdev Lab's canonical hour: 06:25 PDT on day 172 at the corpus
// site, NOAA solar position (`lab/server/settings.py::solar_position`).
fn default_sun_elev() -> f32 {
    5.758
}
fn default_sun_azim() -> f32 {
    115.248
}
fn default_lux() -> f32 {
    12000.0
}
fn default_ambient() -> f32 {
    1.2
}
fn default_rung() -> u8 {
    3
}
fn unit_scale() -> f32 {
    1.0
}

impl Default for Lighting {
    fn default() -> Self {
        Self {
            sun_elev_deg: default_sun_elev(),
            sun_azim_deg: default_sun_azim(),
            sun_lux: default_lux(),
            ambient: default_ambient(),
            rung: default_rung(),
            weather: Weather::default(),
            sky_hdr: None,
            sun_scale: 1.0,
            ambient_scale: 1.0,
            sky_scale: 1.0,
            ev100_bias: 0.0,
            sun_temperature_k: None,
            cloud_cover: None,
            visibility_m: None,
            haze: 0.0,
            fog_color: None,
            wetness: 0.0,
            atmosphere: true,
            turbidity: None,
            ozone_du: None,
            air_density: None,
            cloud_deck: None,
            ground_y: None,
            meter_view: None,
            night: crate::night::NightControls::default(),
        }
    }
}

/// Exactly what the engine ended up with after the weather model, the
/// scale knobs and the cloud-cover layer were applied. Reported back so a
/// lookdev surface can show engine units beside its own normalized ones.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct AppliedPhysicalLighting {
    pub applied_grading_exposure_ev: f32,
    /// Camera EV100 every view is exposed at; the same EV for sky, street
    /// and stars.
    pub scene_ev100: f32,
    /// Horizontal illuminance the meter read to reach it, lx: atmosphere
    /// (sun, sky, twilight) plus the night ledger.
    pub meter_illuminance_lx: f32,
    /// The night ledger's share of that reading, lx.
    pub night_ledger_illuminance_lx: f32,
    /// Incident reading with dark adaptation, before the night offset and
    /// bias.
    #[serde(default)]
    pub incident_ev100: f32,
    /// Highlight-priority reading from the framed sky (`atmosphere.view_sky`),
    /// `None` when no metering camera was given. The applied EV is the
    /// larger of the two, plus offset and bias.
    #[serde(default)]
    pub sky_highlight_ev100: Option<f32>,
    pub atmosphere_environment_gain: f32,
    pub global_ambient_enabled: bool,
    pub camera_headlamp_enabled: bool,
    pub atmosphere_sky_pass: bool,
    pub gpu_dark_lut_seed_lx: f32,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ResolvedLighting {
    /// Directional-light illuminance actually spawned, in lux.
    ///
    /// Under the physical atmosphere this is the **extraterrestrial** value
    /// (~128 klx x `sun_scale`), not the ground-level one: `pbr_lighting.wgsl`
    /// multiplies it by the transmittance LUT. The ground-level number is
    /// `atmosphere.direct_normal_illuminance_lx`.
    pub sun_lux: f32,
    /// Sun colour as linear sRGB. White under the physical atmosphere
    /// unless `sun_temperature_k` overrides it, because the transmittance
    /// LUT is what reddens the beam.
    pub sun_color: [f32; 3],
    /// `EnvironmentMapLight::intensity` in cd/m² on the cubemap path;
    /// the `AtmosphereEnvironmentMapLight` gain (1.0 = physical) on the
    /// atmosphere path.
    pub env_intensity: f32,
    /// `Skybox::brightness` in cd/m². Zero under the physical atmosphere:
    /// there is no skybox.
    pub skybox_brightness: f32,
    /// Fixed `Exposure::ev100` handed to every RGB camera.
    pub ev100: f32,
    /// `FogFalloff::ExponentialSquared` density, when `DistanceFog` is
    /// attached. Always `None` under the physical atmosphere — the
    /// aerial-perspective LUT does this instead.
    pub fog_density: Option<f32>,
    /// Visibility the scene actually has, m.
    pub effective_visibility_m: Option<f32>,
    /// Wetness the road ramp was driven to.
    pub wetness: f32,
    /// Drivable-surface materials the wetness ramp actually reached. Zero
    /// means this map exposes no material the ramp recognises, so the
    /// wetness control is inert here and should say so rather than pretend.
    pub road_materials: u32,
    /// Full atmosphere readback. `None` when running the legacy cubemap sky.
    #[serde(default)]
    pub atmosphere: Option<crate::atmosphere::AtmosphereReadback>,
    /// Controls that are inert in the mode that was actually used, so the
    /// UI can grey them out instead of pretending they do something.
    #[serde(default)]
    pub inert_controls: Vec<String>,
    /// Components and gains actually applied after physical resolution.
    #[serde(default)]
    pub applied_physical: Option<AppliedPhysicalLighting>,
    /// Single resolved night source ledger used by renderer and UI.
    #[serde(default)]
    pub night_environment: Option<crate::night::NightEnvironment>,
    /// Audit of the façade-window fit for this relight.
    #[serde(default)]
    pub facade_windows: Option<crate::facade_windows::FacadeStats>,
}

impl Lighting {
    /// The physical atmosphere state this lighting authors, weather label
    /// seeding anything the caller left unset.
    ///
    /// `cloud_beam_transmittance` is the volumetric field's transmittance
    /// along the sun ray at the observer, when the caller has solved it;
    /// the CPU closure otherwise falls back to the uniform slab.
    pub fn atmosphere_inputs(
        &self,
        cloud_beam_transmittance: Option<f32>,
    ) -> crate::atmosphere::AtmosphereInputs {
        let seed = self.weather.atmosphere();
        // `haze` is aerosol, so it is turbidity, not a separate fudge:
        // +6 Linke over the full range takes clean air to industrial smog.
        let haze = self.haze.clamp(0.0, 1.0);
        crate::atmosphere::AtmosphereInputs {
            sun_elevation_deg: self.sun_elev_deg,
            turbidity: self.turbidity.unwrap_or(seed.turbidity) + 6.0 * haze,
            ozone_du: self.ozone_du.unwrap_or(crate::atmosphere::REFERENCE_OZONE_DU),
            air_density: self.air_density.unwrap_or(1.0),
            visibility_m: self.visibility_m.unwrap_or(seed.visibility_m),
            deck: self.cloud_deck.unwrap_or(seed.deck),
            cloud_cover: self.cloud_cover.unwrap_or(seed.cloud_cover),
            cloud_base_m: self.night.cloud_base_m,
            cloud_beam_transmittance,
            ground_albedo: crate::atmosphere::GROUND_ALBEDO,
            meter_view: self.meter_view,
            sky_cube: self.sun_elev_deg <= PROBE_HANDOVER_ELEVATION_DEG,
        }
    }

    /// Volumetric cloud parameters this lighting authors. The field's cover
    /// is calibrated so that the fraction of zenith rays meeting thick cloud
    /// tracks the authored cover (`clouds::tests::sky_cover_tracks_authored_cover`),
    /// so the weather label's cover is handed over unchanged.
    pub fn cloud_params(&self, time_s: f32) -> crate::clouds::CloudParams {
        let cover = self
            .cloud_cover
            .unwrap_or_else(|| self.weather.atmosphere().cloud_cover)
            .clamp(0.0, 1.0);
        let night = &self.night;
        crate::clouds::CloudParams {
            cover,
            // A broken fair-weather deck is optically thinner than an
            // overcast sheet, so the authored density is scaled with cover
            // rather than held constant across weathers.
            density: night.cloud_density.clamp(0.1, 3.0) * (0.25 + 0.5 * cover),
            kind: night.cloud_type.clamp(0.0, 1.0),
            base_m: night.cloud_base_m.clamp(200.0, 6_000.0),
            top_m: night.cloud_top_m.clamp(night.cloud_base_m + 300.0, 9_000.0),
            wind: Vec2::new(night.cloud_wind_mps[0], night.cloud_wind_mps[1]),
            time_s,
        }
    }

    /// Resolve the physical atmosphere into the plan the ladder spawns from.
    ///
    /// The normalized `sun_scale` / `ambient_scale` knobs survive as
    /// *calibration gain overrides* on top of the physical solve; at their
    /// 1.0 default the render is the model's own answer. `sky_scale` has no
    /// physical counterpart here (the sky is not a texture any more) and is
    /// reported as inert.
    fn resolve_atmosphere(
        &self,
        far_plane_m: f32,
        cloud_beam_transmittance: Option<f32>,
    ) -> (crate::lighting::LightingPlan, ResolvedLighting) {
        let inputs = self.atmosphere_inputs(cloud_beam_transmittance);
        let (_, readback) =
            crate::atmosphere::resolve(&inputs, self.sun_azim_deg, far_plane_m);

        let sun_scale = self.sun_scale.max(0.0);
        let ambient_scale = self.ambient_scale.max(0.0);
        // The transmittance LUT reddens the beam; authoring a colour on top
        // of that would double-count the reddening, so the light stays white
        // unless the operator explicitly overrides the temperature.
        let sun_color = match self.sun_temperature_k {
            Some(k) if k > 0.0 => crate::lighting::kelvin_to_rgb(k.clamp(1000.0, 20000.0)),
            _ => Color::WHITE,
        };
        // One incident-light meter for the whole ledger: the atmosphere's
        // horizontal illuminance (sun, sky, twilight, natural night floor)
        // plus the night sources (Moon, skyglow, the luminaires around the
        // camera). A single EV then exposes the sky, the street and the
        // stars in one photometric space, so twilight is continuous and no
        // pre-exposure or post-compensation has to reconcile two meters.
        //
        // A meter alone would print midnight as a grey afternoon; the eye
        // does not, so the applied EV carries a perceptual dark adaptation
        // (`dark_adaptation_stops`) on top of the reading. The floor is a
        // real camera limit (EV -4.5 at ISO 100 is f/1.4 at about 1/2 s);
        // the operator's night offset and bias come after.
        //
        // An incident meter is blind to what the camera frames. Pointed at
        // a low sun it exposes the street correctly and prints the aureole
        // and the sky around it several stops over white — the classic
        // washed-out sunset. So the sky the camera actually frames
        // (`view_sky`, from the same model) is read as a highlight and the
        // EV is raised until that highlight sits no more than
        // `SKY_HIGHLIGHT_STOPS` above middle grey: matrix metering's
        // highlight priority, deterministic and view-dependent. It only
        // bites when the framed sky is bright relative to the ground, i.e.
        // sunward at low sun; at noon the incident reading already sits
        // above it.
        let night_lx = night_ledger_illuminance_lx(self);
        let (incident_ev, highlight_ev) = meter_readings(&readback, night_lx);
        let ev100 = (incident_ev.max(highlight_ev.unwrap_or(f32::NEG_INFINITY))
            + self.night.exposure_offset_stops.clamp(-6.0, 12.0)
            + self.ev100_bias)
            .clamp(CAMERA_EV100_FLOOR, 20.0);

        let physical_sun_lux = crate::atmosphere::SOLAR_CONSTANT_LX
            * sun_scale
            * astronomical_twilight_sun_gain(self.sun_elev_deg);
        // Bevy skips rewriting the sky LUT when a view has no directional
        // sources, leaving the previous lit texture visible. A radiometrically
        // invisible seed keeps the pass scheduled so astronomical night
        // overwrites that texture with black. It is renderer plumbing, not a
        // reported light source.
        // The seed must be radiometrically invisible at the night
        // pre-exposure too. At 1e-4 lx it survived the night camera gain as a
        // brown twilight wash across the whole sky, which the night sky pass
        // then had to paint over every single frame - and any frame the pass
        // missed flashed brown. 1e-8 lx keeps the pass scheduled and leaves
        // the LUT black.
        let gpu_sun_lux = physical_sun_lux.max(1.0e-8);
        let plan = crate::lighting::LightingPlan {
            // Above civil twilight the atmosphere receives the full
            // extraterrestrial beam and performs horizon attenuation itself.
            // Below it, the source fades through astronomical twilight; the
            // tiny no-source LUT seed described above remains.
            sun_lux: gpu_sun_lux,
            sun_color,
            ev100_fixed: Some(ev100),
            env_intensity: ambient_scale,
            skybox_brightness: 0.0,
        };

        let mut inert = Vec::new();
        if (self.sky_scale - 1.0).abs() > 1.0e-3 {
            inert.push("sky_scale".to_string());
        }
        if self.fog_color.is_some() {
            inert.push("fog_color".to_string());
        }

        let linear = sun_color.to_linear();
        let resolved = ResolvedLighting {
            sun_lux: physical_sun_lux,
            sun_color: [linear.red, linear.green, linear.blue],
            env_intensity: plan.env_intensity,
            skybox_brightness: 0.0,
            ev100,
            fog_density: None,
            effective_visibility_m: Some(readback.effective_visibility_m),
            wetness: self.wetness.clamp(0.0, 1.0),
            road_materials: 0,
            atmosphere: Some(readback),
            inert_controls: inert,
            applied_physical: None,
            night_environment: None,
            facade_windows: None,
        };
        (plan, resolved)
    }
}

impl Lighting {
    /// Resolve the weather model plus this lab's scale knobs into the plan
    /// the ladder is spawned from, and the engine values worth reporting.
    pub fn resolve(&self) -> (crate::lighting::LightingPlan, ResolvedLighting) {
        self.resolve_for(DEFAULT_FAR_PLANE_M, None)
    }

    /// As [`Self::resolve`], but fits the aerial-perspective LUT to a known
    /// camera far plane and, when the caller has marched the volumetric
    /// field, closes the direct beam against its cloud transmittance.
    pub fn resolve_for(
        &self,
        far_plane_m: f32,
        cloud_beam_transmittance: Option<f32>,
    ) -> (crate::lighting::LightingPlan, ResolvedLighting) {
        if self.atmosphere {
            return self.resolve_atmosphere(far_plane_m, cloud_beam_transmittance);
        }
        let base = self.weather.lighting_plan(None, self.sun_elev_deg);
        let cloud = self.cloud_cover.unwrap_or(0.0).clamp(0.0, 1.0);
        let sun_color = match self.sun_temperature_k {
            Some(k) if k > 0.0 => crate::lighting::kelvin_to_rgb(k.clamp(1000.0, 20000.0)),
            _ => base.sun_color,
        };
        let ev100 = base
            .ev100_fixed
            .unwrap_or_else(|| self.weather.sensor_ev100(self.sun_elev_deg))
            + self.ev100_bias;
        let plan = crate::lighting::LightingPlan {
            sun_lux: base.sun_lux * self.sun_scale.max(0.0) * (1.0 - 0.85 * cloud),
            sun_color,
            ev100_fixed: Some(ev100),
            env_intensity: base.env_intensity * self.ambient_scale.max(0.0)
                * (1.0 + 0.30 * cloud),
            skybox_brightness: base.skybox_brightness * self.sky_scale.max(0.0)
                * (1.0 - 0.35 * cloud),
        };
        let fog = self.fog_for(&plan);
        let (fog_density, effective_visibility_m) = match fog {
            Some((density, visibility, _)) => (Some(density), Some(visibility)),
            None => (None, None),
        };
        let linear = sun_color.to_linear();
        let resolved = ResolvedLighting {
            sun_lux: plan.sun_lux,
            sun_color: [linear.red, linear.green, linear.blue],
            env_intensity: plan.env_intensity,
            skybox_brightness: plan.skybox_brightness,
            ev100,
            fog_density,
            effective_visibility_m,
            wetness: self.wetness.clamp(0.0, 1.0),
            road_materials: 0,
            atmosphere: None,
            inert_controls: Vec::new(),
            applied_physical: None,
            night_environment: None,
            facade_windows: None,
        };
        (plan, resolved)
    }

    /// Distance-fog parameters: `(density, effective visibility m, colour)`.
    /// `None` when the authored visibility leaves the scene clear.
    ///
    /// `bevy_pbr::fog` mixes `DistanceFog::color` into the fragment *after*
    /// view exposure has been applied to the lit radiance, so the colour has
    /// to be authored display-referred. Sky luminance times the camera's
    /// exposure factor is exactly that, and it keeps the fog tracking the
    /// sky it is lit by instead of floating free of the exposure knob.
    pub fn fog_for(&self, plan: &crate::lighting::LightingPlan) -> Option<(f32, f32, Color)> {
        let authored = self.visibility_m?;
        if !authored.is_finite() || authored <= 0.0 {
            return None;
        }
        let visibility = (authored / (1.0 + 3.0 * self.haze.clamp(0.0, 1.0))).max(1.0);
        if visibility >= FOG_DISABLED_VISIBILITY_M {
            return None;
        }
        let density = match FogFalloff::from_visibility_squared(visibility) {
            FogFalloff::ExponentialSquared { density } => density,
            _ => return None,
        };
        let color = match self.fog_color {
            Some([r, g, b]) => Color::linear_rgb(r, g, b),
            None => {
                let ev100 = plan.ev100_fixed.unwrap_or(15.0);
                let exposure = 1.0 / (2.0f32.powf(ev100) * 1.2);
                // Aerial perspective is slightly cooler than the sky disc.
                let level = (plan.skybox_brightness * exposure).clamp(0.0, 1.6);
                Color::linear_rgb(level * 0.92, level * 0.96, level)
            }
        };
        Some((density, visibility, color))
    }
}

/// Marker for the planet entity carrying [`bevy::light::Atmosphere`].
#[derive(Component)]
struct AtmosphereMarker;

/// Output of [`SceneApp::resolve_relight`].
struct Relight {
    plan: crate::lighting::LightingPlan,
    resolved: ResolvedLighting,
    night_controls: crate::night::NightControls,
    night_environment: crate::night::NightEnvironment,
    cloud_params: crate::clouds::CloudParams,
    sun_dir: Dir3,
    sun_cloud_t: f32,
    moon_direct_precloud: f32,
    env_gain: f32,
    internal_scale: f32,
    camera_eye: Option<Vec3>,
}

/// Per-view components the physical atmosphere needs.
///
/// `Hdr` is mandatory (`AtmosphereSettings` requires it, and the sky is
/// scene-linear HDR radiance up to ~1.9e9 cd/m^2 on the solar disc), and
/// `RenderProfile::strip` removes it, so it is re-inserted here rather than
/// relied upon. `AtmosphereEnvironmentMapLight` is the IBL: Bevy expands it
/// into a `GeneratedEnvironmentMapLight` filtered from the sky-view LUT, so
/// ambient light is the resolved sky and not a separate authored term.
fn attach_atmosphere_view(
    commands: &mut bevy::prelude::Commands,
    entity: Entity,
    far_plane_m: f32,
    env_gain: f32,
) {
    commands.entity(entity).insert((
        bevy::camera::Hdr,
        crate::atmosphere::settings(far_plane_m),
        crate::atmosphere::environment_light(env_gain, 256),
    ));
}

/// Stop a view rendering the atmosphere.
///
/// Only `AtmosphereSettings` is removed — that is the component that makes
/// the view build LUTs and run the sky pass, so removing it is what actually
/// stops the cost. The IBL probe is *muted* rather than removed:
/// `prepare_atmosphere_probe_components` derives a private
/// `AtmosphereEnvironmentMap` marker alongside the light and skips any
/// entity that already carries it, so tearing the light off would make a
/// later re-attach silently produce no `GeneratedEnvironmentMapLight`.
fn detach_atmosphere_view(commands: &mut bevy::prelude::Commands, entity: Entity) {
    commands
        .entity(entity)
        .remove::<bevy::pbr::AtmosphereSettings>();
}

/// Drive the resolved IBL gain onto a live view.
///
/// Re-inserting `AtmosphereEnvironmentMapLight` is not enough: Bevy copies
/// its `intensity` once when it derives the `GeneratedEnvironmentMapLight`,
/// and copies *that* once more when the filtered `EnvironmentMapLight` is
/// created (`generate_environment_map_light`). Only the last component is
/// what the PBR shader reads, so every relight has to write all three or the
/// view keeps whatever gain it had on its first frame - which for a view
/// created before the physical ladder resolved is 0, i.e. black shadows.
/// The view-level `EnvironmentMapLight` is only ever the atmosphere's
/// derived probe; the cubemap path's probe is a separate `LightProbe` entity.
fn set_view_env_gain(world: &mut bevy::ecs::world::World, entity: Entity, gain: f32) {
    if let Some(mut light) = world.get_mut::<bevy::light::AtmosphereEnvironmentMapLight>(entity) {
        light.intensity = gain;
    }
    if let Some(mut light) = world.get_mut::<bevy::light::GeneratedEnvironmentMapLight>(entity) {
        light.intensity = gain;
    }
    if let Some(mut light) = world.get_mut::<bevy::light::EnvironmentMapLight>(entity) {
        light.intensity = gain;
    }
}


/// Which passes to produce for one camera. Pass keys are `<sensor>:rgb|id|depth`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PassSet {
    #[serde(default = "default_true")]
    pub rgb: bool,
    #[serde(default)]
    pub id: bool,
    #[serde(default)]
    pub depth: bool,
}

fn default_true() -> bool {
    true
}

impl Default for PassSet {
    fn default() -> Self {
        Self { rgb: true, id: false, depth: false }
    }
}

impl PassSet {
    /// Every readback key this pass set produces for one sensor.
    pub fn keys(&self, sensor_id: &str) -> Vec<String> {
        let mut keys = Vec::with_capacity(3);
        if self.rgb {
            keys.push(format!("{sensor_id}:rgb"));
        }
        if self.id {
            keys.push(format!("{sensor_id}:id"));
        }
        if self.depth {
            keys.push(format!("{sensor_id}:depth"));
        }
        keys
    }
}

/// Static description of one logical rig camera.
#[derive(Clone, Debug)]
pub struct CameraSpec {
    pub sensor_id: String,
    pub width: u32,
    pub height: u32,
    /// Vertical field of view in degrees (spike / W0 convention).
    pub fov_y_deg: f32,
    pub near: f32,
    pub far: f32,
    pub passes: PassSet,
}

// ---------------------------------------------------------------------------
// Main world <-> render world plumbing (adapted from the spike)
// ---------------------------------------------------------------------------

struct SentPass {
    key: String,
    data: Vec<u8>,
}

#[derive(Resource, Deref)]
struct MainReceiver(crossbeam_channel::Receiver<SentPass>);
#[derive(Resource, Deref)]
struct RenderSender(crossbeam_channel::Sender<SentPass>);

/// Main-world marker: read back the RGB target (or its view depth texture)
/// identified by `src_image`, publishing rows under `key`.
#[derive(Component, Clone)]
struct ReadbackTarget {
    key: String,
    src_image: Handle<Image>,
    depth: bool,
}

/// One persistent GPU->CPU staging buffer in the render world.
struct StagingBuffer {
    key: String,
    src_image: Handle<Image>,
    depth: bool,
    padded_row: usize,
    height: u32,
    buffer: Buffer,
}

#[derive(Resource, Default)]
struct Staging(Vec<StagingBuffer>);

fn setup_target_image(
    images: &mut Assets<Image>,
    w: u32,
    h: u32,
    format: TextureFormat,
) -> Handle<Image> {
    let mut img = Image::new_target_texture(w, h, format, None);
    img.texture_descriptor.usage |= TextureUsages::COPY_SRC;
    images.add(img)
}

fn make_buffer(device: &RenderDevice, size_bytes: usize) -> Buffer {
    device.create_buffer(&BufferDescriptor {
        label: Some("native-readback"),
        size: size_bytes as u64,
        usage: BufferUsages::MAP_READ | BufferUsages::COPY_DST,
        mapped_at_creation: false,
    })
}

fn aligned_row(width: usize, pixel_size: usize) -> usize {
    RenderDevice::align_copy_bytes_per_row(width * pixel_size)
}

/// Strip wgpu 256-byte row padding from a readback buffer.
pub fn strip_padding(data: &[u8], width: usize, height: usize, pixel: usize) -> Vec<u8> {
    let row = width * pixel;
    let aligned = aligned_row(width, pixel);
    if row == aligned {
        return data[..row * height].to_vec();
    }
    data.chunks_exact(aligned)
        .take(height)
        .flat_map(|r| &r[..row])
        .copied()
        .collect()
}

/// Solar source available to the GPU LUT solve below the geometric horizon.
///
/// The upper atmosphere stays sunlit through civil and nautical twilight,
/// then reaches zero at astronomical night. Smoothstep avoids a visible
/// lighting discontinuity while time is animated.
fn astronomical_twilight_sun_gain(elev_deg: f32) -> f32 {
    let t = ((elev_deg + 18.0) / 12.0).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}
fn atmosphere_view_active(lighting: &Lighting) -> bool {
    lighting.atmosphere
}

/// Stops of under-exposure the camera holds back as the scene gets dark, so
/// dusk is printed as dusk and midnight as night rather than both being
/// re-normalised to a grey afternoon. A fixed fraction
/// (`DARK_ADAPTATION_SLOPE`) of every stop the meter reads below full
/// daylight is withheld, up to `DARK_ADAPTATION_CAP_STOPS`: nothing at
/// noon, ~0.6 stops under overcast, ~3 stops at civil dusk, the cap on a
/// lit street at midnight, where a luminaire pool still prints legibly.
fn dark_adaptation_stops(illuminance_lx: f32) -> f32 {
    const DAYLIGHT_LX: f32 = 100_000.0;
    ((incident_meter_ev100(DAYLIGHT_LX) - incident_meter_ev100(illuminance_lx))
        * DARK_ADAPTATION_SLOPE)
        .clamp(0.0, DARK_ADAPTATION_CAP_STOPS)
}

/// Fraction of each metered stop below daylight the camera withholds.
pub const DARK_ADAPTATION_SLOPE: f32 = 0.35;
/// Upper bound on [`dark_adaptation_stops`].
pub const DARK_ADAPTATION_CAP_STOPS: f32 = 2.5;
/// Lowest EV100 the camera adapts to: f/1.4 at about 1/2 s at ISO 100,
/// which is as far as a hand-holdable night rig goes.
pub const CAMERA_EV100_FLOOR: f32 = -4.5;

/// Incident-light meter, ISO 100, C = 250: `EV100 = log2(E * 100 / 250)`.
fn incident_meter_ev100(illuminance_lx: f32) -> f32 {
    (illuminance_lx.max(1.0e-5) / 2.5).log2()
}

/// EV100 that places a sky luminance `SKY_HIGHLIGHT_STOPS` above middle
/// grey. Bevy's exposure maps `L = 0.18 * 1.2 * 2^EV` cd/m^2 to the 0.18
/// display-linear middle grey.
fn sky_highlight_ev100(luminance_cdm2: f32) -> f32 {
    (luminance_cdm2.max(1.0e-3) / (0.18 * 1.2)).log2() - SKY_HIGHLIGHT_STOPS
}

/// Stops above middle grey the brightest framed sky is allowed to reach.
/// AgX holds colour to about +2.5 stops and goes white past +4; the aureole
/// just outside the solar disc is placed here so it prints as a bright
/// warm glow rather than a white hole, with the disc itself still clipping.
pub const SKY_HIGHLIGHT_STOPS: f32 = 2.5;

/// The meter's two readings: the incident EV with dark adaptation, and the
/// highlight-priority EV from the framed sky when a metering camera was
/// given. The applied EV is the larger, then the operator's offset and
/// bias.
fn meter_readings(
    readback: &crate::atmosphere::AtmosphereReadback,
    night_lx: f32,
) -> (f32, Option<f32>) {
    let meter_lx = readback.total_horizontal_illuminance_lx + night_lx;
    let incident = incident_meter_ev100(meter_lx) + dark_adaptation_stops(meter_lx);
    let highlight = readback
        .view_sky
        .as_ref()
        .map(|v| sky_highlight_ev100(v.max_cdm2));
    (incident, highlight)
}

/// Average maintained illuminance the camera is standing in, by direct
/// point-by-point summation over the street-lighting installation.
///
/// This is the roadway-lighting calculation, not a proxy: each luminaire is a
/// downward cone of `lumens / omega` candela, and the illuminance it puts on
/// the road is `I cos(theta) / d^2`. It is averaged over the camera's own
/// ground point plus two rings at 15 m and 30 m, which is both the area a
/// night frame actually shows and enough spatial smoothing that walking under
/// a pole does not step the exposure.
fn local_fixture_illuminance_lx(
    fixtures: &[crate::night::NightFixture],
    active: usize,
    eye: Vec3,
) -> f32 {
    if fixtures.is_empty() || active == 0 {
        return 0.0;
    }
    let mut samples: Vec<Vec3> = vec![Vec3::new(eye.x, eye.y - 1.6, eye.z)];
    for ring in [12.0_f32, 25.0, 45.0] {
        for k in 0..8 {
            let a = k as f32 / 8.0 * std::f32::consts::TAU;
            samples.push(Vec3::new(
                eye.x + a.cos() * ring,
                eye.y - 1.6,
                eye.z + a.sin() * ring,
            ));
        }
    }
    let mut readings: Vec<f32> = Vec::with_capacity(samples.len());
    for target in &samples {
        let mut e = 0.0;
        for fixture in fixtures.iter().take(active) {
            let position = Vec3::from_array(fixture.position);
            let to_light = position - *target;
            let distance_sq = to_light.length_squared().max(1.0);
            let distance = distance_sq.sqrt();
            let unit = to_light / distance;
            // Luminaires point straight down; matched to `spawn_night_sources`.
            // The cone edge is soft (full at 70 deg off-axis, gone at 85 deg):
            // a hard 80 deg cut made the lower-quartile reading jump between
            // zero and a pool's worth as a dolly crept past a pole, which
            // read as a one-stop exposure flash in a clip metered per frame.
            let cos_off_axis = unit.y;
            let cone = {
                let lo = 85.0_f32.to_radians().cos();
                let hi = 70.0_f32.to_radians().cos();
                let x = ((cos_off_axis - lo) / (hi - lo)).clamp(0.0, 1.0);
                x * x * (3.0 - 2.0 * x)
            };
            if cone <= 0.0 {
                continue;
            }
            let half_angle = 80.0_f32.to_radians();
            let solid_angle = std::f32::consts::TAU * (1.0 - half_angle.cos());
            let intensity = fixture.lumens.clamp(2_000.0, 8_000.0) / solid_angle.max(0.1);
            // Cosine of incidence on a horizontal road surface.
            e += intensity * cone * unit.y.max(0.0) / distance_sq;
        }
        readings.push(e);
    }
    // Lower quartile, not mean or median: one luminaire near the camera must
    // not stop the whole frame down. A night exterior is graded off the road
    // between the pools, not the pools themselves, so the meter reads the
    // darker quarter of the sampled ground.
    readings.sort_by(f32::total_cmp);
    readings[readings.len() / 4]
}
/// Horizontal illuminance the night ledger puts at the camera, lx: the
/// natural sky, urban skyglow, the Moon and the luminaires around the
/// observer. Added to the atmosphere's own reading so one meter sees
/// everything that lights the shot; a lit street meters several stops
/// brighter than a field station with seven poles a hundred metres away,
/// which is exactly why one fixed EV could never serve both.
fn night_ledger_illuminance_lx(lighting: &Lighting) -> f32 {
    let env = crate::night::resolve_night(&lighting.night, 1.0, false);
    let active = lighting
        .night
        .fixtures
        .len()
        .min(lighting.night.fixture_budget.min(12));
    let eye = Vec3::from_array(lighting.night.observer_position);
    let fixtures = if lighting.sun_elev_deg <= NIGHT_SOURCES_ELEVATION_DEG {
        local_fixture_illuminance_lx(&lighting.night.fixtures, active, eye)
    } else {
        0.0
    };
    lighting.night.natural_ambient_lux.clamp(0.001, 0.003)
        + lighting.night.urban_skyglow_lux.clamp(0.0, 0.5)
        + env.celestial.horizontal_lux
        + fixtures
}





/// Assemble the per-view sky parameters from the resolved night state.
///
/// Two gains are computed here and both are reported:
///
/// * `star_gain` closes the star plate's arbitrary units against the site's
///   natural sky illuminance, then applies the declared display lift. The
///   lift is the night sky's long exposure: a single camera EV that prints a
///   3000 K street pool legibly puts a 22 mag/arcsec^2 sky, its skyglow and
///   its moonlit clouds several stops under black, so the sky's own
///   sources are lifted together (`night_lift`) and the lift is named
///   rather than hidden. It is invisible by day, where the atmosphere's
///   sky is thousands of times brighter than anything it multiplies.
/// * `moon_gain` is a pure energy closure: the disc integrates to the
///   resolved direct-normal illuminance over its own solid angle, which puts
///   a full Moon at roughly 4000 cd/m^2 without any authored number. The
///   disc is not lifted: it is already bright.
fn build_sky_pass(
    resolved: &ResolvedLighting,
    env: &crate::night::NightEnvironment,
    controls: &crate::night::NightControls,
    cloud: &crate::clouds::CloudParams,
    internal_scale: f32,
    ev100_fixed: f32,
    moon_direct_precloud: f32,
) -> crate::sky_pass::SkyPass {
    let frame = &env.frame;
    let r = frame.equ_from_world;
    let equ = Mat3::from_cols(
        Vec3::new(r[0][0], r[1][0], r[2][0]),
        Vec3::new(r[0][1], r[1][1], r[2][1]),
        Vec3::new(r[0][2], r[1][2], r[2][2]),
    );
    let rho = frame.angular_radius_rad.max(1.0e-4);
    // Mean of albedo x Lommel-Seeliger reflectance over the visible disc.
    // 0.05 is the full-Moon value (geometric albedo 0.10 x R = 0.5); the
    // exponent tracks how fast the lit area shrinks with phase.
    let disc_mean = 0.05 * env.celestial.illuminated_fraction.max(0.02).powf(1.1);
    let moon_gain = if moon_direct_precloud > 0.0 {
        (moon_direct_precloud / (disc_mean * std::f32::consts::PI * rho * rho))
            .clamp(0.0, 5.0e5)
    } else {
        0.0
    };
    let camera = 2.0f32.powf(ev100_fixed) * 1.2;
    let exposure_scene = internal_scale / camera;
    let exposure_sky = 1.0 / camera;
    // The lift is the sky's long exposure, so it is relative to the camera:
    // it raises the natural + urban sky background to `NIGHT_SKY_TARGET`
    // on the display and never past the authored ceiling. A dark site whose
    // camera is already wide open needs none; a lit street whose camera is
    // stopped down for its luminaires gets the full ceiling.
    let background_cd = (env.natural_ambient_lux + env.urban_skyglow_lux * 0.5)
        / std::f32::consts::PI;
    let lift = (NIGHT_SKY_TARGET / (background_cd * exposure_scene).max(1.0e-9))
        .clamp(1.0, controls.sky_display_lift.clamp(1.0, 600.0));

    // Daylight on the deck, from the same solve that lit the scene: the
    // extraterrestrial beam through the air above the deck base (colour and
    // strength), the zenith sky on the tops, the sunlit ground underneath.
    let (sun_lux, sun_tint, sky_ambient, ground_bounce, aerial_rayleigh, aerial_aerosol) =
        match &resolved.atmosphere {
            Some(a) => {
                let t = Vec3::from_array(a.deck_sun_transmittance);
                let luma = t.dot(Vec3::new(0.2126, 0.7152, 0.0722));
                let tint = if luma > 0.0 { t / luma } else { Vec3::ONE };
                let ground = a.total_horizontal_illuminance_lx
                    * crate::atmosphere::GROUND_ALBEDO
                    / std::f32::consts::PI;
                (
                    crate::atmosphere::SOLAR_CONSTANT_LX * luma,
                    tint,
                    Vec3::from_array(a.zenith_radiance),
                    ground,
                    Vec2::from_array(a.aerial_rayleigh),
                    Vec2::from_array(a.aerial_aerosol),
                )
            }
            None => (
                0.0,
                Vec3::ONE,
                Vec3::ZERO,
                0.0,
                Vec2::new(1.2e-5, 8_000.0),
                Vec2::new(4.4e-6, 1_200.0),
            ),
        };
    crate::sky_pass::SkyPass {
        equ_from_world: Mat4::from_mat3(equ),
        altitude_m: controls.elevation_m.max(0.0),
        moon_dir: Vec3::from_array(frame.moon_dir),
        moon_angular_radius: rho,
        moon_north: Vec3::from_array(frame.moon_north),
        sub_earth_lon: frame.sub_earth_lon_deg.to_radians(),
        sub_earth_lat: frame.sub_earth_lat_deg.to_radians(),
        moon_sun_dir: Vec3::from_array(frame.moon_sun_dir),
        sun_dir: Vec3::from_array(frame.sun_dir),
        sun_lux,
        sun_tint,
        ground_bounce,
        sky_ambient,
        aerial_rayleigh,
        aerial_aerosol,
        moon_lux: moon_direct_precloud,
        skyglow_rgb: Vec3::new(0.78, 0.80, 0.88),
        skyglow_luminance: env.urban_skyglow_lux / std::f32::consts::PI * lift,
        night_lift: lift,
        exposure_scene,
        exposure_sky,
        star_gain: env.sky_photometric_gain * lift,
        moon_gain,
        pixel_angle: 0.001,
        cloud_cover: cloud.cover,
        cloud_density: cloud.density,
        cloud_type: cloud.kind,
        cloud_base_m: cloud.base_m,
        cloud_top_m: cloud.top_m,
        wind_x: cloud.wind.x,
        wind_z: cloud.wind.y,
        march_steps: controls.cloud_quality.march_steps().max(16.0),
        light_steps: controls.cloud_quality.light_steps().max(3.0),
        debug_mode: controls.sky_debug_mode as f32,
        elapsed_seconds: cloud.time_s,
    }
}

/// Sun elevation at or below which the celestial `LightProbe` replaces the
/// atmosphere's view IBL. The probe carries the twilight sky closed against
/// the same diffuse illuminance the meter read, so the handover does not
/// step the ambient.
///
/// Measured (Yale Street, clear, road patch of albedo 0.1 read back in
/// linear, rev22): the LUT's own IBL delivers 0.83x the model's diffuse
/// illuminance at 4.8 deg, 1.35x at 2.2 deg, 2.6x at sunset, 3.4x at
/// -1.4 deg and 5.3x at -3.6 deg — Hillaire's isotropic multiple
/// scattering keeps the sky-view LUT bright long after the direct beam has
/// gone, while the meter follows the twilight law. Left on the LUT, a
/// sunset time-lapse brightened for three degrees after sunset and then
/// dropped 2x at the old -4 deg handover. So the probe takes over where
/// the two still agree, and the last two degrees of LUT IBL are tapered
/// towards the measured ratio ([`atmosphere_ibl_gain`]).
pub const PROBE_HANDOVER_ELEVATION_DEG: f32 = 2.0;

/// Gain on the atmosphere IBL above the probe handover: 1 down to
/// [`IBL_TAPER_START_ELEVATION_DEG`], then linear to `1 / 1.18` at the
/// handover. The LUT's excess at the handover is view-dependent — 1.0x on
/// a road facing away from the low sun, 1.36x on one facing its glow —
/// so the taper lands on the geometric mean and either view meets the
/// probe within ±15 %.
fn atmosphere_ibl_gain(sun_elev_deg: f32) -> f32 {
    const AT_HANDOVER: f32 = 1.0 / 1.18;
    let t = ((sun_elev_deg - PROBE_HANDOVER_ELEVATION_DEG)
        / (IBL_TAPER_START_ELEVATION_DEG - PROBE_HANDOVER_ELEVATION_DEG))
        .clamp(0.0, 1.0);
    AT_HANDOVER + (1.0 - AT_HANDOVER) * t
}

/// Sun elevation where the atmosphere IBL starts tapering towards the
/// probe's value.
pub const IBL_TAPER_START_ELEVATION_DEG: f32 = 4.0;

/// Which set of light sources a sun elevation calls for. Within one tier
/// the clock only moves what is already spawned (see
/// [`SceneApp::advance_lighting`]); crossing a tier respawns the ladder.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum LadderTier {
    /// Sun and the atmosphere's own IBL.
    Day,
    /// The celestial probe carries the ambient (sunset through civil
    /// twilight); no night sources yet.
    Twilight,
    /// Luminaires, windows and the Moon are on as well.
    Night,
}

fn ladder_tier(sun_elev_deg: f32) -> LadderTier {
    if sun_elev_deg > PROBE_HANDOVER_ELEVATION_DEG {
        LadderTier::Day
    } else if sun_elev_deg > NIGHT_SOURCES_ELEVATION_DEG {
        LadderTier::Twilight
    } else {
        LadderTier::Night
    }
}

/// Residual daylight the celestial probe carries below the handover: the
/// model's directional sky (`AtmosphereReadback::sky_cube`, closed against
/// the two-stream diffuse) when it was built, else a uniform hemisphere of
/// the diffuse illuminance (radiance `E / pi`) in the zenith's own
/// chromaticity. Either way the horizontal irradiance is the meter's
/// diffuse reading, so the ambient does not step where the probe takes
/// over from the IBL.
///
/// `PROBE_IRRADIANCE_CALIBRATION` is the read-back correction for Bevy's
/// diffuse convolution of a raw cubemap. With the directional cube a road
/// patch of albedo 0.1 reads back 0.98-1.01 of the closed irradiance
/// (Yale Street, clear and 45 % cloud, rev23), so no correction is needed;
/// the constant stays as the place to put one.
const PROBE_IRRADIANCE_CALIBRATION: f32 = 1.0;

fn probe_daylight(
    a: Option<&crate::atmosphere::AtmosphereReadback>,
) -> (Box<dyn Fn(Vec3) -> Vec3>, Vec3) {
    let Some(a) = a else {
        return (Box::new(|_| Vec3::ZERO), Vec3::ZERO);
    };
    let chroma = Vec3::from_array(a.zenith_radiance);
    let chroma = if chroma.max_element() > 0.0 {
        chroma / chroma.max_element()
    } else {
        Vec3::new(0.55, 0.68, 1.0)
    };
    let luma = chroma.dot(Vec3::new(0.2126, 0.7152, 0.0722)).max(1.0e-3);
    let uniform = chroma / luma
        * (a.diffuse_horizontal_illuminance_lx / std::f32::consts::PI)
        * PROBE_IRRADIANCE_CALIBRATION;
    match a.sky_cube.clone() {
        Some(cube) => (
            Box::new(move |dir| cube.sample(dir) * PROBE_IRRADIANCE_CALIBRATION),
            uniform,
        ),
        None => (Box::new(move |_| uniform), uniform),
    }
}

/// Sun elevation at or below which luminaires and windows come on. Street
/// lighting photocells trip at roughly 20-30 lx, which a clear sky delivers
/// about a quarter of an hour after sunset.
pub const NIGHT_SOURCES_ELEVATION_DEG: f32 = -3.0;

/// Scene-linear display level the lifted night-sky background is brought to
/// before tonemapping: a deep, readable grey that leaves the stars and the
/// Moon well above it.
pub const NIGHT_SKY_TARGET: f32 = 0.035;

/// Time constant, in cloud-clock seconds, of the low-pass on the sun's
/// cloud transmittance between in-place look advances.
pub const CLOUD_BEAM_SMOOTHING_S: f32 = 2.0;


fn spawn_night_sources(
    world: &mut World,
    lighting: &Lighting,
    controls: &crate::night::NightControls,
    env: &crate::night::NightEnvironment,
    internal_scale: f32,
) {
    if lighting.sun_elev_deg > NIGHT_SOURCES_ELEVATION_DEG {
        return;
    }
    let moon = &env.celestial;
    let moon_shadow = matches!(controls.cloud_quality, crate::night::CloudQuality::Lookdev)
        && moon.direct_normal_lux > 0.03;
    if moon.direct_normal_lux > 0.0 {
        let dir = sun_direction(moon.elevation_deg, moon.azimuth_deg);
        world.spawn((
            DirectionalLight {
                illuminance: moon.direct_normal_lux * internal_scale,
                color: Color::srgb(0.96, 0.97, 1.0),
                shadow_maps_enabled: moon_shadow,
                contact_shadows_enabled: moon_shadow,
                ..default()
            },
            Transform::IDENTITY.looking_to(dir, Vec3::Y),
            NightLightMarker,
        ));
    }
    let fixtures = controls.fixtures.clone();
    let active = env.fixtures_active;
    let shadow_budget = controls.fixture_shadow_budget.min(2);
    world.resource_scope(|world, mut meshes: Mut<Assets<Mesh>>| {
        world.resource_scope(|world, mut materials: Mut<Assets<StandardMaterial>>| {
            let head_mesh = meshes.add(
                SphereMeshBuilder::new(0.16, SphereKind::Uv { sectors: 12, stacks: 8 }).build(),
            );
            let _ = &lighting;
            let mut commands = world.commands();
            for (idx, fixture) in fixtures.iter().enumerate() {
                let position = Vec3::from_array(fixture.position);
                let color = lighting::kelvin_to_rgb(fixture.cct_k.clamp(2200.0, 4000.0));
                let head_material = materials.add(StandardMaterial {
                    base_color: color,
                    emissive: color.to_linear() * (45.0 * internal_scale.sqrt()),
                    ..default()
                });
                commands.spawn((
                    Mesh3d(head_mesh.clone()),
                    MeshMaterial3d(head_material),
                    Transform::from_translation(position),
                    NightLightMarker,
                ));
                if idx < active {
                    let forward = Vec3::NEG_Y;
                    commands.spawn((
                        SpotLight {
                            color,
                            intensity: fixture.lumens.clamp(2_000.0, 8_000.0) * internal_scale,
                            range: fixture.range_m.clamp(15.0, 90.0),
                            radius: 0.12,
                            inner_angle: 46.0_f32.to_radians(),
                            outer_angle: 80.0_f32.to_radians(),
                            shadow_maps_enabled: idx < shadow_budget,
                            ..default()
                        },
                        Transform::from_translation(position).looking_to(forward, Vec3::Z),
                        NightLightMarker,
                    ));
                }
            }
        });
    });
    world.flush();
}
fn update_physical_windows(world: &mut World, enabled: bool, internal_scale: f32) -> u32 {
    let restores: Vec<(Entity, Handle<StandardMaterial>)> = {
        let mut q = world.query::<(Entity, &NightWindowOriginal)>();
        q.iter(world).map(|(e, o)| (e, o.0.clone())).collect()
    };
    for (entity, handle) in restores {
        world.entity_mut(entity)
            .insert(MeshMaterial3d(handle))
            .remove::<NightWindowOriginal>();
    }
    if !enabled {
        return 0;
    }
    let targets: Vec<(Entity, Handle<StandardMaterial>, String)> = {
        let mut q = world.query::<(
            Entity,
            &GltfMaterialName,
            &MeshMaterial3d<StandardMaterial>,
        )>();
        q.iter(world)
            .filter_map(|(entity, name, material)| {
                let label = (&**name).to_lowercase();
                let positive = label.contains("window")
                    || (label.contains("glass")
                        && !["bulb", "signal", "streetlight", "train", "hydrant"]
                            .iter().any(|token| label.contains(token)));
                positive.then(|| (entity, material.0.clone(), label))
            })
            .collect()
    };
    let mut applied = 0u32;
    world.resource_scope(|world, mut materials: Mut<Assets<StandardMaterial>>| {
        for (ordinal, (entity, source, _)) in targets.into_iter().enumerate() {
            // 30% deterministic occupancy at primitive granularity: a
            // residential street around 22:00, not an office block.
            if (ordinal * 73 + entity.to_bits() as usize * 17) % 100 >= 30 {
                continue;
            }
            let Some(mut material) = materials.get(&source).cloned() else { continue };
            let cct = 2_200.0 + ((ordinal * 317) % 1_800) as f32;
            // Same street-side luminance model as the synthetic façades.
            let roll = ((ordinal * 47) % 100) as f32 / 100.0;
            let luminance = crate::facade_windows::WINDOW_LUMINANCE_CDM2
                [crate::facade_windows::window_luminance_bin(roll)];
            let color = lighting::kelvin_to_rgb(cct);
            // `StandardMaterial::emissive` is luminance in cd/m2; the view's
            // `Exposure` converts it.
            material.emissive = color.to_linear() * (luminance * internal_scale);
            material.base_color = Color::BLACK;
            let handle = materials.add(material);
            world.entity_mut(entity).insert((
                MeshMaterial3d(handle),
                NightWindowOriginal(source),
            ));
            applied += 1;
        }
    });
    applied
}


fn sun_direction(elev_deg: f32, azim_deg: f32) -> Dir3 {
    // Unit vector pointing FROM the sun INTO the scene.
    let elev = elev_deg.to_radians();
    let azim = azim_deg.to_radians();
    let dir = Vec3::new(
        -(elev.cos() * azim.sin()),
        -elev.sin(),
        -(elev.cos() * azim.cos()),
    );
    Dir3::new(dir.normalize()).unwrap()
}

// ---------------------------------------------------------------------------
// Markers & state
// ---------------------------------------------------------------------------

#[derive(Component)]
struct TileLoad(Handle<Gltf>);
#[derive(Component)]
struct NightLightMarker;
#[derive(Component)]
struct NightWindowOriginal(Handle<StandardMaterial>);
#[derive(Component)]
struct SceneSpawned;
#[derive(Component)]
struct IdClone;
#[derive(Component, Clone, Copy)]
struct InstanceId(u32);
#[derive(Component)]
struct ActorModelRoot;
#[derive(Clone)]
struct ActorAnimationBinding {
    players: Vec<Entity>,
    node: AnimationNodeIndex,
}


/// One legend entry: instance-ID value -> source mesh name.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct LegendEntry {
    pub id: u32,
    pub name: String,
}

/// World-space triangle snapshot for deterministic CPU lidar/radar raycasts.
#[derive(Clone, Copy, Debug)]
pub struct SensorTriangle {
    pub a: [f32; 3],
    pub b: [f32; 3],
    pub c: [f32; 3],
    pub instance_id: u32,
}

#[derive(Resource, Default)]
struct Legend(Vec<LegendEntry>);

struct GroupEntities {
    spec: CameraSpec,
    /// Profile this group's RGB camera was built with, so a live re-light
    /// can rebuild the same stack without re-registering the camera.
    profile: Profile,
    rgb_entity: Entity,
    id_entity: Option<Entity>,
}

// ---------------------------------------------------------------------------
// SceneApp
// ---------------------------------------------------------------------------

/// Host-driven headless renderer over a static tile scene.
///
/// The Bevy `App` is never `run()`; every [`Self::render_once`] performs one
/// full main-world + render-world iteration ending in a blocking GPU
/// readback of all registered passes.

// ---------------------------------------------------------------------------
// Dynamic actors + ground height (V4 SensorRig)
// ---------------------------------------------------------------------------

/// Coarse ground-height lookup: minimum world vertex Y per grid cell.
///
/// Traces carry no height channel (scene-state.v1 groundY may be null), so
/// actor origins are snapped onto the static scene. Taking the per-cell
/// MINIMUM keeps walls/roofs from inflating the estimate: every mesh that
/// meets the ground contributes ground-level vertices, while anything
/// elevated (roofs, foliage) only raises the maximum.
#[derive(Default)]
struct GroundField {
    cell_m: f32,
    min_y: HashMap<(i64, i64), f32>,
    /// Median per-cell height, fixed at build; the far fallback of `sample`.
    median: Option<f32>,
}

impl GroundField {
    fn build(app: &mut App, cell_m: f32) -> GroundField {
        let world = app.world_mut();
        let mut field = GroundField { cell_m, min_y: HashMap::new(), median: None };
        let mut q = world.query::<(&Mesh3d, &GlobalTransform)>();
        let meshes = world.resource::<Assets<Mesh>>();
        for (mesh, gt) in q.iter(world) {
            let Some(mesh) = meshes.get(&mesh.0) else { continue };
            let Some(pos) = mesh.attribute(Mesh::ATTRIBUTE_POSITION) else { continue };
            let bevy::mesh::VertexAttributeValues::Float32x3(values) = pos else { continue };
            let gt = gt.to_matrix();
            for v in values.iter() {
                let p = gt.transform_point3(Vec3::from(*v));
                let key = (
                    (p.x / cell_m).floor() as i64,
                    (p.z / cell_m).floor() as i64,
                );
                field
                    .min_y
                    .entry(key)
                    .and_modify(|y| *y = y.min(p.y))
                    .or_insert(p.y);
            }
        }
        field.median = field.median_y();
        field
    }

    /// Ground height under (x, z).
    ///
    /// The field is per-vertex, so a road drawn as large triangles leaves
    /// most 2 m cells empty; those used to read as 0.0, which put a
    /// ground-snapped actor (and its mounted camera) eleven metres under a
    /// street at y = 13 on every other tick. An empty cell now takes the
    /// nearest populated cell within 20 m, then the scene median, and only
    /// then 0.0 (a scene with no geometry at all).
    fn sample(&self, x: f32, z: f32) -> f32 {
        let (cx, cz) = ((x / self.cell_m).floor() as i64, (z / self.cell_m).floor() as i64);
        if let Some(y) = self.min_y.get(&(cx, cz)) {
            return *y;
        }
        for ring in 1..=10i64 {
            let mut best: Option<(i64, f32)> = None;
            for dz in -ring..=ring {
                for dx in -ring..=ring {
                    if dx.abs() != ring && dz.abs() != ring {
                        continue;
                    }
                    if let Some(y) = self.min_y.get(&(cx + dx, cz + dz)) {
                        let d2 = dx * dx + dz * dz;
                        if best.is_none_or(|(bd, _)| d2 < bd) {
                            best = Some((d2, *y));
                        }
                    }
                }
            }
            if let Some((_, y)) = best {
                return y;
            }
        }
        self.median.unwrap_or(0.0)
    }

    /// Median per-cell ground height across the whole scene, or `None` for
    /// an empty field. Median, not mean: a handful of cells under bridges
    /// or basements would drag a mean well below the street.
    fn median_y(&self) -> Option<f32> {
        if self.min_y.is_empty() {
            return None;
        }
        let mut ys: Vec<f32> = self.min_y.values().copied().collect();
        ys.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        Some(ys[ys.len() / 2])
    }
}

pub struct SceneApp {
    app: App,
    receiver: crossbeam_channel::Receiver<SentPass>,
    groups: Vec<GroupEntities>,
    next_camera_order: isize,
    ready: bool,
    /// Scene-state actors: id -> (cuboid entity, allocated instance id).
    actors: HashMap<String, (Entity, u32)>,
    /// Dynamic actor id -> (loaded catalog GLB root, authored scale, mesh count).
    actor_models: HashMap<String, (Entity, f32, usize)>,
    /// Per-actor cloned tint material handles. Catalog materials are shared
    /// assets, so tinting must never mutate the source GLB material.
    actor_tint_materials: HashMap<String, Vec<Handle<StandardMaterial>>>,
    /// Asset handles are retained by absolute path so repeated actor spawns
    /// instantiate an already-resident GLB rather than reloading it.
    actor_asset_cache: HashMap<String, Handle<Gltf>>,
    /// Deterministic, simulation-time-indexed skeletal animation bindings.
    actor_animations: HashMap<String, ActorAnimationBinding>,
    /// Instance id -> semantic class name for dynamically spawned actors.
    actor_classes: HashMap<u32, String>,
    /// Next instance id for dynamic actors (beyond the static legend range).
    next_instance_id: u32,
    /// Coarse ground-height field (min vertex y per cell), built at readiness.
    ground: GroundField,
    /// Sky cubemap spawned by the lighting ladder (rung ≥ 1), attached as a
    /// `Skybox` to every RGB camera.
    sky: Option<Handle<Image>>,
    /// Skybox brightness from the resolved `LightingPlan`.
    skybox_brightness: f32,
    /// Fixed EV100 from the resolved `LightingPlan` (spec §Exposure).
    ev100_fixed: f32,
    profile_config: RenderProfileConfig,
    /// Live lighting state, so `apply_lighting` can diff against it.
    lighting: Lighting,
    /// Distance fog attached to every RGB camera, when visibility asks for it.
    fog: Option<DistanceFog>,
    /// Pre-wetness material state, keyed by material asset, so the road ramp
    /// is reversible instead of a one-way destructive edit.
    dry_road_materials: HashMap<AssetId<StandardMaterial>, (f32, f32, Color)>,
    /// Handle of the [`ScatteringMedium`] the physical atmosphere resolves
    /// into. Reused across relights so the 1024x1024 density/phase LUT pair
    /// is replaced in place rather than leaked.
    medium: Option<Handle<bevy::light::atmosphere::ScatteringMedium>>,
    /// The planet entity carrying [`bevy::light::Atmosphere`].
    atmosphere_entity: Option<Entity>,
    /// Ground elevation the atmosphere origin is anchored to, world Y.
    atmosphere_ground_y: f32,
    /// Far plane the aerial-perspective LUT is currently fitted to.
    far_plane_m: f32,
    /// Audit of the last façade-window fit, reported to the lab.
    facade_windows: crate::facade_windows::FacadeStats,
    /// Sky parameters in force, so a camera registered *after* the relight
    /// still gets the sky pass. The service creates views lazily on the
    /// first render, which is after `apply_lighting` has already run.
    sky_pass: Option<crate::sky_pass::SkyPass>,
    /// Cloud beam transmittance along the sun ray the last relight solved
    /// from the volumetric field, so later readbacks and view registrations
    /// close against the same number.
    cloud_beam_t: Option<f32>,
    /// Light-texture handle carrying that transmittance onto the sun's
    /// surface lighting without touching the atmosphere solve.
    sun_cookie: Option<Handle<Image>>,
    /// The celestial `LightProbe` cubemap spawned by the last relight, so
    /// it can be released when the next one replaces it.
    probe_cubemap: Option<Handle<Image>>,
    /// Atmosphere IBL gain the last relight resolved, reused for views
    /// registered afterwards.
    env_gain: f32,
}

impl SceneApp {
    /// Build the headless app with lights and render-world plumbing.
    ///
    /// Fails when the lighting ladder cannot be built (e.g. an unreadable
    /// `sky_hdr`).
    pub fn new(lighting: &Lighting) -> Result<Self> {
        Self::new_with_profile_config(lighting, RenderProfileConfig::default())
    }

    pub fn new_with_profile_config(
        lighting: &Lighting,
        profile_config: RenderProfileConfig,
    ) -> Result<Self> {
        profile_config.cinematic.validate()?;
        std::env::set_var("BEVY_ASSET_ROOT", "/");
        let (tx, rx) = crossbeam_channel::unbounded::<SentPass>();
        let mut app = App::new();
        // The reusable job/service engine may render sensor and cinematic
        // views together. PCSS is stochastic on current wgpu/Bevy and made
        // sensor RGB hashes differ between identical replays, so mixed
        // SceneApp lighting is capped at deterministic hard cascades.
        // The standalone cinematic CLI still exposes rung-4 PCSS.
        let rung = LightingRung(lighting.rung.min(3));
        let (plan, _resolved) = lighting.resolve();
        let sun_dir = sun_direction(lighting.sun_elev_deg, lighting.sun_azim_deg);
        // Black, not a sky colour: under the physical atmosphere the sky
        // pass composites *over* whatever the target was cleared to, and at
        // night the clear colour would show straight through the LUT's
        // transmittance as a daylight-blue wash. The cubemap path draws a
        // Skybox over the clear anyway.
        app.insert_resource(ClearColor(Color::BLACK))
            .insert_resource(DirectionalLightShadowMap { size: 2048 })
            .insert_resource(Legend::default())
            .add_plugins((
                DefaultPlugins
                    .set(bevy::asset::AssetPlugin {
                        file_path: "/".into(),
                        ..default()
                    })
                    .set(WindowPlugin {
                        primary_window: None,
                        exit_condition: ExitCondition::DontExit,
                        ..default()
                    })
                    .disable::<bevy::winit::WinitPlugin>()
                    .disable::<bevy::audio::AudioPlugin>()
                    // The pipelined renderer steps the render app on its own
                    // thread driven by App::run(); our host-controlled update
                    // loop requires in-line render stepping.
                    .disable::<bevy::render::pipelined_rendering::PipelinedRenderingPlugin>()
                    .set(LogPlugin {
                        filter: "warn,wgpu_core=warn,wgpu_hal=warn,naga=warn".into(),
                        ..default()
                    }),
                ScheduleRunnerPlugin::run_loop(Duration::ZERO),
                crate::road_detail::RoadDetailPlugin,
                crate::sky_pass::SkyPassPlugin,
                crate::readiness::GpuReadinessPlugin,
            ))
            .add_systems(
                Update,
                (
                    spawn_loaded_tiles,
                    crate::veg::load_veg_roots,
                    crate::veg::instantiate_veg,
                )
                    .chain(),
            )
            .insert_resource(MainReceiver(rx.clone()));

        // Lighting ladder. Spawned through Commands so the exact same
        // `spawn_lighting` path serves the CLI, the job runner and the
        // service. Under `Lighting::atmosphere` the sky, the IBL and the
        // aerial perspective come from `crate::atmosphere` instead of a
        // cubemap (see that module's header for why the built-in Bevy
        // implementation is the one used).
        let sky_mode = if lighting.atmosphere {
            lighting::SkyMode::Physical
        } else {
            lighting::SkyMode::Cubemap
        };
        let sky = {
            let world = app.world_mut();
            let sky = world.resource_scope(|world, mut images: Mut<Assets<Image>>| {
                let mut commands = world.commands();
                lighting::spawn_lighting(
                    &mut commands,
                    &mut images,
                    rung,
                    &plan,
                    sun_dir,
                    400.0,
                    lighting.sky_hdr.as_deref(),
                    sky_mode,
                    (
                        lighting.sun_lux * lighting.sun_scale.max(0.0),
                        lighting.ambient * lighting.ambient_scale.max(0.0),
                    ),
                )
            })?;
            world.flush();
            sky
        };

        let atmosphere_ground_y = lighting.ground_y.unwrap_or(lighting::GROUND_Y);
        let mut medium_handle = None;
        let mut atmosphere_entity = None;
        if lighting.atmosphere {
            let (entity, handle) = Self::spawn_atmosphere(
                app.world_mut(),
                lighting,
                &None,
                atmosphere_ground_y,
                DEFAULT_FAR_PLANE_M,
            );
            atmosphere_entity = Some(entity);
            medium_handle = Some(handle);
        }

        let render_app = app.get_sub_app_mut(RenderApp).unwrap();
        render_app
            .insert_resource(RenderSender(tx))
            .init_resource::<Staging>()
            .init_resource::<ExtractedTargets>()
            .add_systems(ExtractSchedule, extract_targets)
            .add_systems(RenderGraph, copy_passes)
            .add_systems(Render, sync_staging.before(copy_passes))
            .add_systems(Render, receive_passes.after(RenderSystems::Render));

        // Drive the plugin lifecycle to completion manually (we never call
        // app.run()): pump updates until plugins are built, then finish so the
        // render world has its RenderDevice before cameras register readbacks.
        while app.plugins_state() != bevy::app::PluginsState::Ready {
            app.update();
        }
        app.finish();
        app.cleanup();
        Ok(Self {
            app,
            receiver: rx,
            groups: Vec::new(),
            next_camera_order: 0,
            ready: false,
            actors: HashMap::new(),
            actor_models: HashMap::new(),
            actor_tint_materials: HashMap::new(),
            actor_asset_cache: HashMap::new(),
            actor_animations: HashMap::new(),
            actor_classes: HashMap::new(),
            next_instance_id: 0,
            ground: GroundField::default(),
            sky,
            skybox_brightness: plan.skybox_brightness,
            ev100_fixed: plan.ev100_fixed.unwrap_or_else(|| {
                lighting.weather.sensor_ev100(lighting.sun_elev_deg)
            }),
            profile_config,
            lighting: lighting.clone(),
            fog: if lighting.atmosphere {
                // The aerial-perspective LUT already integrates extinction
                // and inscattering over the same medium; adding DistanceFog
                // would apply the haze a second time.
                None
            } else {
                lighting.fog_for(&plan).map(|(density, _, color)| DistanceFog {
                    color,
                    directional_light_color: Color::srgb(1.0, 0.95, 0.86),
                    directional_light_exponent: 30.0,
                    falloff: FogFalloff::ExponentialSquared { density },
                })
            },
            dry_road_materials: HashMap::new(),
            medium: medium_handle,
            atmosphere_entity,
            atmosphere_ground_y,
            far_plane_m: DEFAULT_FAR_PLANE_M,
            facade_windows: crate::facade_windows::FacadeStats::default(),
            sky_pass: None,
            cloud_beam_t: None,
            sun_cookie: None,
            probe_cubemap: None,
            env_gain: 1.0,
        })
    }

    /// Spawn (or re-point) the planet entity and its scattering medium.
    ///
    /// The planet centre goes `inner_radius` below `ground_y`, so scene
    /// altitude is measured from the corpus ground plane rather than from
    /// world origin — which matters, because the boundary-layer fog term has
    /// a 300 m scale height and the scene sits ~13 m above y = 0.
    fn spawn_atmosphere(
        world: &mut bevy::ecs::world::World,
        lighting: &Lighting,
        existing_medium: &Option<Handle<bevy::light::atmosphere::ScatteringMedium>>,
        ground_y: f32,
        far_plane_m: f32,
    ) -> (Entity, Handle<bevy::light::atmosphere::ScatteringMedium>) {
        let inputs = lighting.atmosphere_inputs(None);
        let (medium, _) =
            crate::atmosphere::resolve(&inputs, lighting.sun_azim_deg, far_plane_m);
        let handle = {
            let mut media = world
                .resource_mut::<Assets<bevy::light::atmosphere::ScatteringMedium>>();
            crate::atmosphere::upload_medium(&mut media, existing_medium, medium)
        };
        let entity = world
            .spawn((
                crate::atmosphere::atmosphere(&inputs, handle.clone()),
                Transform::from_xyz(
                    0.0,
                    ground_y - crate::atmosphere::INNER_RADIUS_M,
                    0.0,
                ),
                GlobalTransform::from(Transform::from_xyz(
                    0.0,
                    ground_y - crate::atmosphere::INNER_RADIUS_M,
                    0.0,
                )),
                AtmosphereMarker,
            ))
            .id();
        world.flush();
        (entity, handle)
    }

    /// Put the volumetric field's sun-beam transmittance on the sun as a
    /// light texture.
    ///
    /// Bevy's atmosphere reads every `DirectionalLight` as a sun, so scaling
    /// the light's illuminance by the cloud transmittance would also darken
    /// the Rayleigh sky seen through the gaps and the sky IBL. A
    /// `DirectionalLightTexture` is read only by surface lighting
    /// (`pbr_lighting.wgsl`), which is exactly the part the clouds shadow.
    /// The texture is a single texel: the beam transmittance at the observer.
    fn apply_sun_cookie(&mut self, transmittance: f32) {
        let world = self.app.world_mut();
        let suns: Vec<Entity> = {
            let mut q = world.query_filtered::<
                Entity,
                (With<lighting::VolumetricLightMarker>, With<DirectionalLight>),
            >();
            q.iter(world).collect()
        };
        if suns.is_empty() {
            return;
        }
        let value = transmittance.clamp(0.0, 1.0);
        let image = Image::new(
            Extent3d {
                width: 1,
                height: 1,
                depth_or_array_layers: 1,
            },
            TextureDimension::D2,
            // R8: the decal sampler filters, and 32-bit float is not a
            // filterable format without an extra device feature.
            vec![(value * 255.0).round() as u8],
            TextureFormat::R8Unorm,
            RenderAssetUsages::RENDER_WORLD,
        );
        let handle = {
            let mut images = world.resource_mut::<Assets<Image>>();
            match &self.sun_cookie {
                Some(existing) => {
                    images.insert(existing.id(), image);
                    existing.clone()
                }
                None => images.add(image),
            }
        };
        self.sun_cookie = Some(handle.clone());
        for sun in suns {
            world.entity_mut(sun).insert(bevy::light::DirectionalLightTexture {
                image: handle.clone(),
                tiled: true,
            });
        }
    }

    /// Move the atmosphere origin onto the scene's own ground plane once
    /// tiles have loaded. Only meaningful for the physical sky.
    fn reanchor_atmosphere(&mut self, ground_y: f32) {
        if (ground_y - self.atmosphere_ground_y).abs() < 0.5 {
            return;
        }
        self.atmosphere_ground_y = ground_y;
        let Some(entity) = self.atmosphere_entity else {
            return;
        };
        let y = ground_y - crate::atmosphere::INNER_RADIUS_M;
        let world = self.app.world_mut();
        let transform = Transform::from_xyz(0.0, y, 0.0);
        if let Ok(mut e) = world.get_entity_mut(entity) {
            e.insert((transform, GlobalTransform::from(transform)));
        }
    }

    /// Everything a relight resolves before it touches the world.
    ///
    /// Shared by [`Self::apply_lighting`] (full respawn) and
    /// [`Self::advance_lighting`] (in-place update for time-lapses), so the
    /// two can never disagree about the sun, the exposure or the clouds.
    fn resolve_relight(
        &mut self,
        lighting: &Lighting,
        profile_config: &RenderProfileConfig,
        smooth_beam: bool,
    ) -> Relight {
        let camera_eye = {
            let world = self.app.world_mut();
            let mut views = world.query_filtered::<&GlobalTransform, With<Camera3d>>();
            views.iter(world).next().map(GlobalTransform::translation)
        };
        let mut night_controls = lighting.night.clone();
        if let Some(eye) = camera_eye {
            night_controls.fixtures.sort_by(|a, b| {
                Vec3::from_array(a.position).distance_squared(eye)
                    .total_cmp(&Vec3::from_array(b.position).distance_squared(eye))
            });
        }

        // One cloud model at every hour: the volumetric field the sky pass
        // marches. The same field attenuates the Sun's and the Moon's beams
        // and shapes the IBL, so the picture and the lighting never disagree
        // about where the clouds are.
        let cloud_params = lighting.cloud_params({
            let step = night_controls.cloud_fixed_step_s.clamp(0.0, 1.0);
            if let Some(mut clock) = self
                .app
                .world_mut()
                .get_resource_mut::<crate::sky_pass::SkyClock>()
            {
                clock.fixed_step = (step > 0.0).then_some(step);
                clock.seconds as f32
            } else {
                0.0
            }
        });
        let clouds_drawn = lighting.atmosphere
            && cloud_params.cover > 0.0
            && night_controls.cloud_quality != crate::night::CloudQuality::Off;
        let sun_dir = sun_direction(lighting.sun_elev_deg, lighting.sun_azim_deg);
        // `sun_direction` is the direction light travels; the field wants
        // the direction *towards* the source.
        let to_sun = -Vec3::from(sun_dir);
        let sampled_t = if clouds_drawn && to_sun.y > 0.004 {
            let field = self.app.world().resource::<crate::clouds::CloudField>();
            field.transmittance(Vec2::ZERO, 0.0, to_sun, &cloud_params, 48)
        } else {
            1.0
        };
        // The beam is one sample of the drifting field at the observer,
        // applied uniformly (the cloud shadow is not spatial). Re-read every
        // frame of a clip it flickered — a 48-step sample of a moving
        // field is noisy — so between in-place advances it is low-passed
        // with a two-second cloud-time constant; a full relight starts
        // from the fresh sample.
        let sun_cloud_t = match (smooth_beam, self.cloud_beam_t) {
            (true, Some(previous)) => {
                let dt = night_controls.cloud_fixed_step_s.clamp(0.0, 1.0);
                let dt = if dt > 0.0 { dt } else { 1.0 / 30.0 };
                let alpha = (dt / CLOUD_BEAM_SMOOTHING_S).clamp(0.0, 1.0);
                previous + (sampled_t - previous) * alpha
            }
            _ => sampled_t,
        };
        self.cloud_beam_t = lighting.atmosphere.then_some(sun_cloud_t);

        let (plan, mut resolved) =
            lighting.resolve_for(self.far_plane_m, self.cloud_beam_t);
        // One camera EV exposes everything (see `resolve_atmosphere`), so
        // every source is spawned at its nominal physical value: the
        // renderer-internal scale is 1 and the ledger reports it as such.
        let internal_scale = 1.0;
        let use_atmosphere = atmosphere_view_active(lighting);
        let deck_diffuse_gain = resolved
            .atmosphere
            .as_ref()
            .map(|a| a.deck_diffuse_gain)
            .unwrap_or(1.0);
        // Above the probe handover the ambient is the atmosphere's own sky
        // IBL, lifted by the deck's re-radiated diffuse light. Below it the
        // explicit celestial probe (twilight sky, Moon, skyglow, clouds)
        // takes over: a `LightProbe` replaces the view IBL wherever it
        // reaches, so the two are never summed.
        let env_gain = if lighting.sun_elev_deg <= PROBE_HANDOVER_ELEVATION_DEG {
            0.0
        } else {
            plan.env_intensity * deck_diffuse_gain * atmosphere_ibl_gain(lighting.sun_elev_deg)
        };
        let moon_shadows = matches!(night_controls.cloud_quality, crate::night::CloudQuality::Lookdev);
        let mut night_environment = crate::night::resolve_night(
            &night_controls,
            internal_scale,
            moon_shadows,
        );
        let moon_dir_for_cloud = Vec3::from_array(night_environment.frame.moon_dir);
        let (moon_cloud_t, zenith_tau) = if clouds_drawn {
            let field = self.app.world().resource::<crate::clouds::CloudField>();
            (
                field.transmittance(Vec2::ZERO, 0.0, moon_dir_for_cloud, &cloud_params, 48),
                field.optical_depth(Vec2::ZERO, 0.0, Vec3::Y, &cloud_params, 48),
            )
        } else {
            (1.0, 0.0)
        };
        // The raymarch attenuates the visible disc itself, so the sky pass
        // needs the illuminance arriving at the top of the deck.
        let moon_direct_precloud = night_environment.celestial.direct_normal_lux;
        night_environment.celestial.direct_normal_lux *= moon_cloud_t;
        night_environment.celestial.horizontal_lux *= moon_cloud_t;
        night_environment.cloud_beam_transmittance = moon_cloud_t;
        night_environment.cloud_zenith_optical_depth = zenith_tau;
        night_environment.cloud_animation_seconds = cloud_params.time_s;
        night_environment.cloud_wind_offset_m = [
            cloud_params.wind.x * cloud_params.time_s,
            cloud_params.wind.y * cloud_params.time_s,
        ];
        night_environment.cloud_continuous = clouds_drawn;
        if let Some(moon) = night_environment.source_ledger.iter_mut().find(|s| s.id == "moon") {
            moon.nominal_value = night_environment.celestial.direct_normal_lux;
            moon.renderer_internal_value = moon.nominal_value * internal_scale;
            moon.provenance.push_str(&format!(
                "; x{moon_cloud_t:.4} cloud transmittance from the same volumetric field the sky pass marches"
            ));
        }
        let night_lx = night_ledger_illuminance_lx(lighting);
        let (incident_ev100, sky_highlight_ev100) = resolved
            .atmosphere
            .as_ref()
            .map(|a| meter_readings(a, night_lx))
            .unwrap_or((resolved.ev100, None));
        resolved.applied_physical = lighting.atmosphere.then_some(AppliedPhysicalLighting {
            applied_grading_exposure_ev: profile_config.cinematic.grading_exposure,
            scene_ev100: resolved.ev100,
            meter_illuminance_lx: resolved
                .atmosphere
                .as_ref()
                .map(|a| a.total_horizontal_illuminance_lx)
                .unwrap_or(0.0)
                + night_lx,
            night_ledger_illuminance_lx: night_lx,
            incident_ev100,
            sky_highlight_ev100,
            atmosphere_environment_gain: env_gain,
            global_ambient_enabled: false,
            camera_headlamp_enabled: false,
            atmosphere_sky_pass: use_atmosphere,
            gpu_dark_lut_seed_lx: if resolved.sun_lux == 0.0 { 1.0e-8 } else { 0.0 },
        });
        resolved.night_environment = Some(night_environment.clone());
        Relight {
            plan,
            resolved,
            night_controls,
            night_environment,
            cloud_params,
            sun_dir,
            sun_cloud_t,
            moon_direct_precloud,
            env_gain,
            internal_scale,
            camera_eye,
        }
    }

    /// Re-light a live scene in place.
    ///
    /// Respawns the lighting ladder, rebuilds every registered RGB camera's
    /// profile stack, retunes the atmosphere (or the legacy distance fog)
    /// and drives the wet-road ramp. Tiles, vegetation, the instance-ID pass
    /// and the render targets are left alone, so the cost is one medium LUT
    /// rebuild plus one update — not a scene reload. Returns the engine
    /// values that were applied.
    pub fn apply_lighting(
        &mut self,
        lighting: &Lighting,
        profile_config: RenderProfileConfig,
    ) -> Result<ResolvedLighting> {
        let profile_config = profile_config;
        profile_config.cinematic.validate()?;
        let rung = LightingRung(lighting.rung.min(3));
        let Relight {
            plan,
            mut resolved,
            night_controls,
            mut night_environment,
            cloud_params,
            sun_dir,
            sun_cloud_t,
            moon_direct_precloud,
            env_gain,
            internal_scale,
            camera_eye,
        } = self.resolve_relight(lighting, &profile_config, false);
        let use_atmosphere = atmosphere_view_active(lighting);
        let sky_mode = if lighting.atmosphere {
            lighting::SkyMode::Physical
        } else {
            lighting::SkyMode::Cubemap
        };

        let previous_sky = self.sky.take();
        let previous_atmosphere = self.atmosphere_entity.take();
        {
            let world = self.app.world_mut();
            let mut stale: Vec<Entity> = Vec::new();
            let mut suns =
                world.query_filtered::<Entity, With<lighting::VolumetricLightMarker>>();
            stale.extend(suns.iter(world));
            let mut probes = world.query_filtered::<Entity, With<LightProbe>>();
            stale.extend(probes.iter(world));
            let mut night_lights = world.query_filtered::<Entity, With<NightLightMarker>>();
            stale.extend(night_lights.iter(world));
            if let Some(entity) = previous_atmosphere {
                stale.push(entity);
            }
            for entity in stale {
                world.despawn(entity);
            }
            // `GlobalAmbientLight` is a resource, not a spawnable entity, so
            // it cannot be swept with the rest of the ladder. Clear it here
            // instead: the rung-0 branch of `spawn_lighting` re-inserts it,
            // and any other rung must not inherit a stale flat ambient.
            world.insert_resource(GlobalAmbientLight::NONE);
            if let Some(handle) = previous_sky {
                world.resource_mut::<Assets<Image>>().remove(&handle);
            }
        }

        // Below the probe handover the ambient is the explicit celestial
        // probe. It carries the twilight sky as well, closed against the
        // same diffuse illuminance the atmosphere meter read, so crossing
        // the handover does not step the ambient.
        let probe_cubemap = (lighting.atmosphere
            && lighting.sun_elev_deg <= PROBE_HANDOVER_ELEVATION_DEG)
            .then(|| {
                let (daylight, ground) = probe_daylight(resolved.atmosphere.as_ref());
                let field = self.app.world().resource::<crate::clouds::CloudField>();
                crate::night::celestial_ibl_cubemap(
                    &night_environment,
                    field,
                    &cloud_params,
                    daylight.as_ref(),
                    ground,
                    64,
                    internal_scale,
                )
            });
        let previous_probe = self.probe_cubemap.take();
        if let Some(handle) = previous_probe {
            self.app.world_mut().resource_mut::<Assets<Image>>().remove(&handle);
        }
        let sky = {
            let world = self.app.world_mut();
            let (sky, probe) = world.resource_scope(|world, mut images: Mut<Assets<Image>>| {
                let mut commands = world.commands();
                let legacy = lighting::spawn_lighting(
                    &mut commands,
                    &mut images,
                    rung,
                    &plan,
                    sun_dir,
                    400.0,
                    lighting.sky_hdr.as_deref(),
                    sky_mode,
                    (
                        lighting.sun_lux * lighting.sun_scale.max(0.0),
                        lighting.ambient * lighting.ambient_scale.max(0.0),
                    ),
                )?;
                let probe = probe_cubemap.map(|image| {
                    let handle = images.add(image);
                    commands.spawn((
                        LightProbe::default(),
                        Transform::from_scale(Vec3::splat(1_000_000.0)),
                        bevy::light::EnvironmentMapLight {
                            diffuse_map: handle.clone(),
                            specular_map: handle.clone(),
                            intensity: 1.0,
                            rotation: Quat::IDENTITY,
                            affects_lightmapped_mesh_diffuse: true,
                        },
                    ));
                    handle
                });
                Ok::<_, anyhow::Error>((legacy, probe))
            })?;
            world.flush();
            self.probe_cubemap = probe;
            sky
        };
        // The sun's cloud transmittance rides on a light texture: it scales
        // the beam on every surface without entering the atmosphere solve,
        // so the Rayleigh sky seen through the gaps keeps its full sun.
        self.apply_sun_cookie(sun_cloud_t);
        let facade_stats = crate::facade_windows::spawn(
            self.app.world_mut(),
            if lighting.sun_elev_deg <= NIGHT_SOURCES_ELEVATION_DEG {
                night_controls.window_mode
            } else {
                crate::night::WindowMode::Off
            },
            internal_scale,
            0x5EED_1A2B,
            camera_eye.unwrap_or(Vec3::from_array(night_controls.observer_position)),
        );
        self.facade_windows = facade_stats;
        resolved.facade_windows = Some(facade_stats);
        spawn_night_sources(
            self.app.world_mut(),
            lighting,
            &night_controls,
            &night_environment,
            internal_scale,
        );
        // Dedicated window primitives light in every mode but `Off`: the
        // synthetic façade cards fill in where the map has no window
        // materials, they do not replace the ones it has.
        let physical_window_primitives = update_physical_windows(
            self.app.world_mut(),
            lighting.sun_elev_deg <= NIGHT_SOURCES_ELEVATION_DEG
                && night_controls.window_mode != crate::night::WindowMode::Off,
            internal_scale,
        );
        if physical_window_primitives > 0 {
            night_environment.source_ledger.push(crate::night::SourceLedgerEntry {
                id: "selective-windows".into(),
                kind: "emissive_surface".into(),
                nominal_value: physical_window_primitives as f32,
                nominal_unit: "occupied dedicated GLB primitives".into(),
                renderer_internal_value: physical_window_primitives as f32,
                active_layers: vec!["emissive_surface".into()],
                shadows: false,
                confidence: 0.9,
                provenance: "dedicated window/glass GltfMaterialName clone; walls/facades excluded".into(),
            });
            resolved.night_environment = Some(night_environment.clone());
        }

        if lighting.atmosphere {
            let ground_y = lighting.ground_y.unwrap_or(self.atmosphere_ground_y);
            self.atmosphere_ground_y = ground_y;
            let medium = self.medium.clone();
            let far = self.far_plane_m;
            // The medium is deck-free by construction (`atmosphere::earth_terms`);
            // the volumetric field is the only cloud model at every hour.
            let atmosphere_lighting = lighting.clone();
            let (entity, handle) = Self::spawn_atmosphere(
                self.app.world_mut(),
                &atmosphere_lighting,
                &medium,
                ground_y,
                far,
            );
            self.atmosphere_entity = Some(entity);
            self.medium = Some(handle);
        } else {
            // Leaving the physical path: drop the medium so its 16 MB LUT
            // pair is not held for a sky that is no longer rendered.
            if let Some(handle) = self.medium.take() {
                self.app
                    .world_mut()
                    .resource_mut::<Assets<bevy::light::atmosphere::ScatteringMedium>>()
                    .remove(&handle);
            }
        }

        // before overwriting; see the warmup at the end of this function.
        let atmosphere_changed = self.lighting.atmosphere != lighting.atmosphere;
        let fx_changed = self.profile_config != profile_config || atmosphere_changed;
        self.sky = sky;
        self.skybox_brightness = if lighting.atmosphere { 1.0 } else { plan.skybox_brightness };
        self.ev100_fixed = resolved.ev100;
        self.env_gain = env_gain;
        self.profile_config = profile_config;
        self.fog = if lighting.atmosphere {
            None
        } else {
            lighting.fog_for(&plan).map(|(density, _, color)| DistanceFog {
                color,
                directional_light_color: Color::srgb(1.0, 0.95, 0.86),
                directional_light_exponent: 30.0,
                falloff: FogFalloff::ExponentialSquared { density },
            })
        };
        self.lighting = lighting.clone();

        let views: Vec<(Entity, Profile, f32, f32, u32)> = self
            .groups
            .iter()
            .map(|g| {
                (
                    g.rgb_entity,
                    g.profile,
                    g.spec.far,
                    g.spec.fov_y_deg,
                    g.spec.height,
                )
            })
            .collect();
        let sky_template = lighting.atmosphere.then(|| {
            build_sky_pass(
                &resolved,
                &night_environment,
                &night_controls,
                &cloud_params,
                internal_scale,
                self.ev100_fixed,
                moon_direct_precloud,
            )
        });
        self.sky_pass = sky_template;
        let (sky_handle, skybox_brightness, ev100, fx, fog) = (
            // The sky pass composites the background itself; a `Skybox`
            // would draw straight over the atmosphere inside the opaque pass.
            if lighting.atmosphere { None } else { self.sky.clone() },
            self.skybox_brightness,
            self.ev100_fixed,
            self.profile_config.cinematic,
            self.fog.clone(),
        );
        {
            let world = self.app.world_mut();
            let mut commands = world.commands();
            for (entity, profile, far, fov_y_deg, height) in views {
                // A free camera is not a vehicle. Ensure a stale rev15
                // camera-owned source cannot survive the clean cutover.
                commands.entity(entity).remove::<SpotLight>();
                RenderProfile::strip(&mut commands, entity);
                commands.entity(entity).remove::<DistanceFog>();
                profile.render_profile().apply(
                    &mut commands,
                    entity,
                    ev100,
                    sky_handle.clone(),
                    skybox_brightness,
                    fx,
                );
                match sky_template {
                    Some(template) if profile == Profile::Cinematic => {
                        let mut sky = template;
                        sky.pixel_angle =
                            fov_y_deg.to_radians() / height.max(1) as f32;
                        commands.entity(entity).insert(sky);
                    }
                    _ => {
                        commands.entity(entity).remove::<crate::sky_pass::SkyPass>();
                    }
                }
                if use_atmosphere && profile == Profile::Cinematic {
                    attach_atmosphere_view(&mut commands, entity, far, env_gain);
                } else {
                    detach_atmosphere_view(&mut commands, entity);
                }
                if let Some(fog) = fog.clone() {
                    commands.entity(entity).insert(fog);
                }
            }
        }
        self.app.world_mut().flush();
        {
            let entities: Vec<Entity> = self.groups.iter().map(|g| g.rgb_entity).collect();
            let world = self.app.world_mut();
            for entity in entities {
                set_view_env_gain(world, entity, if use_atmosphere { env_gain } else { 0.0 });
            }
        }
        let mut resolved = resolved;
        resolved.road_materials = self.set_wetness(resolved.wetness) as u32;
        // Changing which post-process components a view carries changes the
        // view's pipeline specialization key, its prepass texture set and
        // its view-target chain. For a frame or two afterwards the graph
        // can produce no readback at all — reliably reproducible by
        // switching anti-aliasing away from TAA, which also drops
        // `TemporalJitter`, `MipBias` and the motion-vector prepass. Spend
        // discarded frames here so the caller's next render is the real
        // one. Also gives TAA a first history sample when it is enabled.
        //
        // The atmosphere needs the same treatment for a different reason:
        // its four LUTs are rebuilt by the render graph, and the IBL probe
        // is filtered from the sky-view LUT one frame later.
        if (fx_changed || use_atmosphere) && !self.groups.is_empty() {
            self.warmup(if atmosphere_changed { 3 } else { 2 });
        }
        Ok(resolved)
    }

    /// Advance a live look in place, for time-lapses.
    ///
    /// A full [`Self::apply_lighting`] respawns every light and rebuilds
    /// every view's post-process stack, which re-inserts
    /// `TemporalAntiAliasing` with `reset: true` and drops the TAA history:
    /// one visibly unfiltered frame. A recording that moves the sun a
    /// fraction of a degree per frame cannot afford that, so this path
    /// updates only what the clock moves — the sun's direction, illuminance
    /// and cloud cookie, the camera EV, the atmosphere IBL gain and the sky
    /// pass parameters — on the entities already in the world. The
    /// scattering medium does not depend on the sun (the GPU medium is
    /// deck-free), so it is left alone.
    ///
    /// Three ladders exist, keyed on sun elevation: day (atmosphere IBL),
    /// twilight (the celestial probe carries the ambient from the probe
    /// handover down) and night (luminaires, windows and the Moon as well).
    /// Within one ladder everything the clock moves is updated in place —
    /// by night that is also the Moon's light and the probe cubemap, which
    /// is regenerated into the existing image handle. Crossing a ladder, or
    /// changing anything but the clock and the camera, falls back to
    /// [`Self::apply_lighting`] and says so in the result, so a recorder can
    /// mark the frame: a time-lapse from afternoon to midnight pays exactly
    /// two full relights, one at each handover, which is also when the
    /// street lights come on.
    pub fn advance_lighting(
        &mut self,
        lighting: &Lighting,
        profile_config: RenderProfileConfig,
    ) -> Result<(ResolvedLighting, bool)> {
        let tier = ladder_tier(lighting.sun_elev_deg);
        let same_ladder = {
            // Everything the clock and the camera move is neutralised; the
            // rest must match exactly. The fixture ledger arrives sorted by
            // distance to the camera, so it is compared as a set.
            let neutral = |l: &Lighting| -> Result<String> {
                let mut l = l.clone();
                l.sun_elev_deg = 0.0;
                l.sun_azim_deg = 0.0;
                l.night.utc_minutes = 0.0;
                l.night.utc_day_of_year = 0;
                l.night.observer_position = [0.0; 3];
                l.meter_view = None;
                let mut fixtures: Vec<String> = l
                    .night
                    .fixtures
                    .iter()
                    .map(serde_json::to_string)
                    .collect::<std::result::Result<_, _>>()?;
                fixtures.sort_unstable();
                l.night.fixtures.clear();
                Ok(format!("{}\n{}", serde_json::to_string(&l)?, fixtures.join("\n")))
            };
            neutral(&self.lighting)? == neutral(lighting)?
        };
        if !(lighting.atmosphere
            && same_ladder
            && tier == ladder_tier(self.lighting.sun_elev_deg)
            && self.profile_config == profile_config
            && !self.groups.is_empty())
        {
            return Ok((self.apply_lighting(lighting, profile_config)?, true));
        }

        let Relight {
            plan,
            resolved,
            night_controls,
            night_environment,
            cloud_params,
            sun_dir,
            sun_cloud_t,
            moon_direct_precloud,
            env_gain,
            internal_scale,
            ..
        } = self.resolve_relight(lighting, &profile_config, true);

        // The night ladder's Moon: exactly one directional light carries the
        // night marker (fixtures are spot/point lights). A Moon that rises
        // after the ladder was spawned has no light to move, so that case
        // takes the full relight.
        if tier == LadderTier::Night {
            let moon = &night_environment.celestial;
            let world = self.app.world_mut();
            let mut moons = world.query_filtered::<
                (&mut DirectionalLight, &mut Transform),
                With<NightLightMarker>,
            >();
            if moons.iter(world).next().is_none() && moon.direct_normal_lux > 0.0 {
                return Ok((self.apply_lighting(lighting, profile_config)?, true));
            }
            let dir = sun_direction(moon.elevation_deg, moon.azimuth_deg);
            for (mut light, mut transform) in moons.iter_mut(world) {
                light.illuminance = moon.direct_normal_lux * internal_scale;
                *transform = Transform::IDENTITY.looking_to(dir, Vec3::Y);
            }
        }

        // Sun: direction, extraterrestrial illuminance, colour. The ladder
        // spawns one (down to the astronomical-night seed) whenever the
        // plan has any, so there is at most one to move.
        {
            let world = self.app.world_mut();
            let mut suns = world.query_filtered::<
                (&mut DirectionalLight, &mut Transform),
                With<lighting::VolumetricLightMarker>,
            >();
            for (mut sun, mut transform) in suns.iter_mut(world) {
                sun.illuminance = plan.sun_lux;
                sun.color = plan.sun_color;
                *transform = Transform::IDENTITY.looking_to(sun_dir, Vec3::Y);
            }
        }
        self.apply_sun_cookie(sun_cloud_t);

        // The celestial probe carries the twilight sky, the Moon and the
        // lit cloud; all of it moves with the clock, so the cubemap is
        // rebuilt into the handle the `LightProbe` already holds.
        if let Some(handle) = self.probe_cubemap.clone() {
            let (daylight, ground) = probe_daylight(resolved.atmosphere.as_ref());
            let image = {
                let field = self.app.world().resource::<crate::clouds::CloudField>();
                crate::night::celestial_ibl_cubemap(
                    &night_environment,
                    field,
                    &cloud_params,
                    daylight.as_ref(),
                    ground,
                    64,
                    internal_scale,
                )
            };
            self.app
                .world_mut()
                .resource_mut::<Assets<Image>>()
                .insert(handle.id(), image);
        }

        self.ev100_fixed = resolved.ev100;
        self.env_gain = env_gain;
        let template = build_sky_pass(
            &resolved,
            &night_environment,
            &night_controls,
            &cloud_params,
            internal_scale,
            self.ev100_fixed,
            moon_direct_precloud,
        );
        self.sky_pass = Some(template);
        let views: Vec<(Entity, Profile, f32, u32)> = self
            .groups
            .iter()
            .map(|g| (g.rgb_entity, g.profile, g.spec.fov_y_deg, g.spec.height))
            .collect();
        let world = self.app.world_mut();
        for (entity, profile, fov_y_deg, height) in views {
            if let Some(mut exposure) = world.get_mut::<bevy::camera::Exposure>(entity) {
                exposure.ev100 = resolved.ev100;
            }
            if profile == Profile::Cinematic {
                set_view_env_gain(world, entity, env_gain);
                if let Some(mut sky) = world.get_mut::<crate::sky_pass::SkyPass>(entity) {
                    let pixel_angle = fov_y_deg.to_radians() / height.max(1) as f32;
                    *sky = template;
                    sky.pixel_angle = pixel_angle;
                }
            }
        }
        self.lighting = lighting.clone();
        Ok((resolved, false))
    }

    /// Engine values currently in force.
    pub fn resolved_lighting(&self) -> ResolvedLighting {
        self.lighting.resolve_for(self.far_plane_m, self.cloud_beam_t).1
    }

    /// The anti-aliasing mode actually present on each live RGB view, read
    /// back out of the ECS.
    ///
    /// This is deliberately not an echo of the request: it is the only way
    /// to prove that switching modes removed the previous AA component
    /// instead of stacking a second one. `("<sensorId>", "<mode>")` pairs;
    /// `"conflict:"`-prefixed when more than one AA component is present,
    /// which would be a bug in [`RenderProfile::strip`].
    pub fn camera_anti_alias(&self) -> Vec<(String, String)> {
        let world = self.app.world();
        self.groups
            .iter()
            .map(|group| {
                let entity = group.rgb_entity;
                let mut found: Vec<&str> = Vec::new();
                if world.get::<TemporalAntiAliasing>(entity).is_some() {
                    found.push("taa");
                }
                if world.get::<Fxaa>(entity).is_some() {
                    found.push("fxaa");
                }
                if let Some(smaa) = world.get::<Smaa>(entity) {
                    found.push(match smaa.preset {
                        SmaaPreset::Low => "smaa-low",
                        SmaaPreset::Medium => "smaa-medium",
                        SmaaPreset::High => "smaa-high",
                        SmaaPreset::Ultra => "smaa-ultra",
                    });
                }
                let mode = match found.len() {
                    0 => "off".to_string(),
                    1 => found[0].to_string(),
                    _ => format!("conflict:{}", found.join("+")),
                };
                (group.spec.sensor_id.clone(), mode)
            })
            .collect()
    }

    /// Drive the wet-road reflectance ramp to `wetness` ∈ [0, 1].
    ///
    /// Unlike `weather::apply_wetness`, this is reversible: the dry
    /// roughness/metallic/base colour of each drivable-surface material is
    /// captured the first time it is touched and every later call ramps from
    /// that original, so dragging a wetness slider back to zero restores the
    /// scene exactly instead of compounding the darkening.
    pub fn set_wetness(&mut self, wetness: f32) -> usize {
        const ROAD_MARKERS: [&str; 2] = ["asphalt1_road", "roads_road_layer0"];
        let wetness = wetness.clamp(0.0, 1.0);
        let world = self.app.world_mut();
        let mut road_materials: Vec<Handle<StandardMaterial>> = Vec::new();
        {
            let mut meshes = world.query::<(
                Option<&Name>,
                Option<&ChildOf>,
                &MeshMaterial3d<StandardMaterial>,
            )>();
            let mut names = world.query::<&Name>();
            let mut seen: std::collections::HashSet<AssetId<StandardMaterial>> =
                std::collections::HashSet::new();
            let rows: Vec<(Option<String>, Option<Entity>, Handle<StandardMaterial>)> = meshes
                .iter(world)
                .map(|(name, parent, mat)| {
                    (name.map(|n| n.as_str().to_owned()), parent.map(|p| p.0), mat.0.clone())
                })
                .collect();
            for (name, parent, material) in rows {
                let mut label = name.unwrap_or_default();
                if label.is_empty() {
                    if let Some(parent) = parent {
                        if let Ok(parent_name) = names.get(world, parent) {
                            label = parent_name.as_str().to_owned();
                        }
                    }
                }
                let lower = label.to_ascii_lowercase();
                if ROAD_MARKERS.iter().any(|m| lower.contains(m))
                    && seen.insert(material.id())
                {
                    road_materials.push(material);
                }
            }
        }
        let mut touched = 0usize;
        let mut assets = world.resource_mut::<Assets<StandardMaterial>>();
        for handle in road_materials {
            let id = handle.id();
            let Some(mut material) = assets.get_mut(&handle) else {
                continue;
            };
            let (dry_roughness, dry_metallic, dry_color) = *self
                .dry_road_materials
                .entry(id)
                .or_insert((material.perceptual_roughness, material.metallic, material.base_color));
            material.perceptual_roughness = dry_roughness * (1.0 - wetness) + 0.16 * wetness;
            material.metallic = dry_metallic.max(0.04 * wetness);
            let mut linear = dry_color.to_linear();
            let k = 1.0 - 0.35 * wetness;
            linear.red *= k;
            linear.green *= k;
            linear.blue *= k;
            material.base_color = Color::from(linear);
            touched += 1;
        }
        touched
    }


    /// Queue GLB tiles for loading. Call before [`Self::wait_until_ready`].
    pub fn load_tiles(&mut self, glbs: &[String]) -> Result<()> {
        for g in glbs {
            if !std::path::Path::new(g).is_absolute() {
                bail!("glb paths must be absolute: {g}");
            }
        }
        let server = self.app.world().resource::<AssetServer>().clone();
        for g in glbs {
            let path: String = g.trim_start_matches('/').to_owned();
            let handle: Handle<Gltf> = server.load(path);
            self.app.world_mut().spawn(TileLoad(handle));
        }
        Ok(())
    }

    /// Queue vegetation prototype GLBs plus their `.instances.json` sidecars.
    /// Keeping this separate from static tiles avoids accidentally drawing the
    /// uninstanced prototype roots.
    pub fn load_vegetation(&mut self, glbs: &[String]) -> Result<()> {
        for g in glbs {
            if !std::path::Path::new(g).is_absolute() {
                bail!("vegetation glb paths must be absolute: {g}");
            }
        }
        let server = self.app.world().resource::<AssetServer>().clone();
        let mut commands = self.app.world_mut().commands();
        crate::veg::spawn_veg(&mut commands, &server, glbs);
        Ok(())
    }

    /// Register a camera group (RGB target + optional ID camera + depth copy).
    ///
    /// Registration is allowed both before [`Self::wait_until_ready`] and
    /// after it (V4: per-request dynamic camera registration in the service).
    /// Post-ready groups join the already-finalized ID-pass layer directly;
    /// the legend is not re-derived, so IDs stay stable.
    pub fn add_camera(&mut self, spec: CameraSpec, profile: Profile) {

        let rgb_image = {
            let mut images = self.app.world_mut().resource_mut::<Assets<Image>>();
            setup_target_image(&mut images, spec.width, spec.height, TextureFormat::Rgba8UnormSrgb)
        };
        let rgb_handle = rgb_image.clone();

        let e = self.app.world_mut().spawn((
            Camera3d {
                depth_texture_usages: (TextureUsages::RENDER_ATTACHMENT
                    | TextureUsages::COPY_SRC)
                    .into(),
                ..default()
            },
            Projection::from(PerspectiveProjection {
                fov: spec.fov_y_deg.to_radians(),
                near: spec.near,
                far: spec.far,
                ..default()
            }),
            Msaa::Off,
            Camera { order: self.next_camera_order, ..default() },
            Transform::IDENTITY,
            RenderTarget::Image(rgb_image.into()),
        ));
        let rgb_entity = e.id();
        self.next_camera_order += 10;

        // Sensor views retain the deterministic contract. Cinematic views use
        // the configured temporal/reflection/filmic stack and can coexist in
        // the same SceneApp.
        let use_atmosphere = atmosphere_view_active(&self.lighting);
        // Same gain and the same sky the last relight resolved; a view that
        // registers late must not re-derive either from a different path.
        let env_gain = if use_atmosphere { self.env_gain } else { 0.0 };
        {
            let world = self.app.world_mut();
            let mut commands = world.commands();
            profile.render_profile().apply(
                &mut commands,
                rgb_entity,
                self.ev100_fixed,
                if use_atmosphere { None } else { self.sky.clone() },
                self.skybox_brightness,
                self.profile_config.cinematic,
            );
            // Cinematic only; see the same guard in `apply_lighting`.
            if use_atmosphere && profile == Profile::Cinematic {
                attach_atmosphere_view(&mut commands, rgb_entity, spec.far, env_gain);
            }
            if let (Some(template), Profile::Cinematic) = (self.sky_pass, profile) {
                let mut sky = template;
                sky.pixel_angle = spec.fov_y_deg.to_radians() / spec.height.max(1) as f32;
                commands.entity(rgb_entity).insert(sky);
            }
            // Sensor deliberately receives no stochastic screen-space
            // AO/contact pass. Cinematic owns those effects.
            if let Some(fog) = self.fog.clone() {
                commands.entity(rgb_entity).insert(fog);
            }
        }
        self.app.world_mut().flush();
        // The aerial-perspective LUT is fitted to the far plane; the first
        // registered camera decides it, and a later relight reuses it.
        if use_atmosphere && self.groups.is_empty() {
            self.far_plane_m = spec.far;
        }

        self.app.world_mut().spawn(ReadbackTarget {
            key: format!("{}:rgb", spec.sensor_id),
            src_image: rgb_handle.clone(),
            depth: false,
        });

        let id_entity = if spec.passes.id {
            let id_image = {
                let mut images = self.app.world_mut().resource_mut::<Assets<Image>>();
                setup_target_image(
                    &mut images,
                    spec.width,
                    spec.height,
                    TextureFormat::Rgba8UnormSrgb,
                )
            };
            self.app.world_mut().spawn(ReadbackTarget {
                key: format!("{}:id", spec.sensor_id),
                src_image: id_image.clone(),
                depth: false,
            });
            let cmd = self.app.world_mut().spawn((
                Camera3d::default(),
                Camera {
                    clear_color: ClearColorConfig::Custom(Color::BLACK),
                    order: self.next_camera_order,
                    ..default()
                },
                Projection::from(PerspectiveProjection {
                    fov: spec.fov_y_deg.to_radians(),
                    near: spec.near,
                    far: spec.far,
                    ..default()
                }),
                Msaa::Off,
                Tonemapping::None,
                Transform::IDENTITY,
                RenderTarget::Image(id_image.into()),
                RenderLayers::layer(1),
            ));
            self.next_camera_order += 10;
            Some(cmd.id())
        } else {
            None
        };

        if spec.passes.depth {
            self.app.world_mut().spawn(ReadbackTarget {
                key: format!("{}:depth", spec.sensor_id),
                src_image: rgb_handle,
                depth: true,
            });
        }

        self.groups.push(GroupEntities { spec, profile, rgb_entity, id_entity });
        if self.ready {
            // Post-ready registration: pump updates so extraction and
            // pipeline compilation happen before the next render_once.
            // Two frames, not one: a cinematic view brings a whole post
            // chain with it (AA, bloom, SSAO, SSR), and with only one
            // warmup the first real frame came back with the anti-aliasing
            // pass silently missing — byte-identical to `aa: off`.
            self.warmup(2);
        }
    }

    /// Registered camera specs (diagnostics).
    pub fn cameras(&self) -> impl Iterator<Item = &CameraSpec> {
        self.groups.iter().map(|g| &g.spec)
    }

    /// Frozen legend (static instance ids). Dynamic actors get ids above the
    /// static maximum; see [`Self::actor_instance_class`].
    pub fn legend(&self) -> Vec<LegendEntry> {
        self.app.world().resource::<Legend>().0.clone()
    }

    /// Ground height under (x, z) from the readiness height field.
    pub fn ground_at(&self, x: f32, z: f32) -> f32 {
        self.ground.sample(x, z)
    }

    /// Apply a `simforge.road-detail/v1` sidecar (splat-blended asphalt
    /// variants + wear/marking modulation + decal overlay) to the spawned
    /// scene. Call after [`Self::wait_until_ready`]; follow with
    /// [`Self::warmup`] so the extended-material pipelines compile before
    /// capture. No-op for the instance-ID pass (ID materials are never
    /// GLB-named).
    pub fn apply_road_detail(
        &mut self,
        sidecar_path: &str,
    ) -> Result<crate::road_detail::RoadDetailStats> {
        let stats =
            crate::road_detail::apply(&mut self.app, std::path::Path::new(sidecar_path))
                .map_err(|e| anyhow::anyhow!("{e:#}"))?;
        // Pump one update so the swapped materials extract before the next
        // render; drain any passes it produced.
        self.app.update();
        while self.receiver.try_recv().is_ok() {}
        Ok(stats)
    }

    /// Spawn or move one scene-state actor cuboid. The box is named
    /// `actor:<id>` and carries an instance id above the static legend range
    /// so ID-pass pixels resolve to the actor class.
    ///
    /// `position` is the actor origin on the ground; when `snap_ground` is
    /// set the y coordinate is replaced by the sampled ground height (traces
    /// carry no height channel).
    pub fn upsert_actor(
        &mut self,
        id: &str,
        class: &str,
        position: [f32; 3],
        yaw_rad: f32,
        dims: [f32; 3],
        color: [f32; 3],
        snap_ground: bool,
    ) {
        let y = if snap_ground { self.ground.sample(position[0], position[2]) } else { position[1] };
        let transform = Transform {
            translation: Vec3::new(position[0], y, position[2]),
            rotation: Quat::from_rotation_y(yaw_rad),
            scale: Vec3::ONE,
        };
        let model = self.actor_models.get(id).copied();
        let world = self.app.world_mut();
        if let Some((entity, _)) = self.actors.get(id) {
            if let Some(mut t) = world.get_mut::<Transform>(*entity) {
                *t = transform;
            }
            if let Some((model_entity, scale, _)) = model {
                if let Some(mut t) = world.get_mut::<Transform>(model_entity) {
                    t.translation = transform.translation;
                    t.rotation = transform.rotation;
                    t.scale = Vec3::splat(scale);
                }
            }
            return;
        }
        let instance_id = self.next_instance_id + 1;
        self.next_instance_id = instance_id;
        let mesh_handle = {
            let mut meshes = world.resource_mut::<Assets<Mesh>>();
            meshes.add(Cuboid::new(dims[0], dims[1], dims[2]))
        };
        let mat_handle = {
            let mut materials = world.resource_mut::<Assets<StandardMaterial>>();
            materials.add(StandardMaterial {
                base_color: Color::srgb(color[0], color[1], color[2]),
                ..default()
            })
        };
        // Deterministic instance-ID material for the layer-1 clone: same
        // RGB24 encoding as finalize_scene.
        let bytes = instance_id.to_le_bytes();
        let id_mat = {
            let mut materials = world.resource_mut::<Assets<StandardMaterial>>();
            materials.add(StandardMaterial {
                base_color: Color::srgb_u8(bytes[0], bytes[1], bytes[2]),
                unlit: true,
                ..default()
            })
        };
        let e = world.spawn((
            Name::new(format!("actor:{id}")),
            Mesh3d(mesh_handle.clone()),
            MeshMaterial3d(mat_handle),
            InstanceId(instance_id),
            transform,
        )).id();
        world.spawn((
            IdClone,
            Name::new(format!("actor:{id}")),
            Mesh3d(mesh_handle),
            MeshMaterial3d(id_mat),
            RenderLayers::layer(1),
            transform,
        ));
        self.actors.insert(id.to_string(), (e, instance_id));
        self.actor_classes.insert(instance_id, class.to_string());
    }

    /// Replace a spawned actor's visible cuboid with a catalog GLB while
    /// retaining its deterministic layer-1 cuboid as the sensor/ID proxy.
    ///
    /// Loading is blocking because the service must not acknowledge a tick
    /// until every modality sees the same fully-resident world.
    pub fn attach_actor_model(
        &mut self,
        actor_id: &str,
        glb_path: &std::path::Path,
        uniform_scale: f32,
        tint: Option<[f32; 3]>,
    ) -> Result<()> {
        self.attach_actor_asset(actor_id, glb_path, uniform_scale, tint, None, 0.0)
    }

    /// Attach a static or skinned GLB. Animated poses are sought from
    /// simulation time and paused, so wall-clock scheduling cannot affect
    /// rendered frames.
    pub fn attach_actor_asset(
        &mut self,
        actor_id: &str,
        glb_path: &std::path::Path,
        uniform_scale: f32,
        tint: Option<[f32; 3]>,
        animation_clip: Option<&str>,
        animation_time_s: f32,
    ) -> Result<()> {
        let mesh_count_before = {
            let world = self.app.world_mut();
            let mut query = world.query::<&Mesh3d>();
            query.iter(world).count()
        };
        if self.actor_models.contains_key(actor_id) {
            return Ok(());
        }
        if !glb_path.is_absolute() || !glb_path.is_file() {
            bail!("actor model GLB is not an absolute existing file: {}", glb_path.display());
        }
        let (cuboid, _) = self
            .actors
            .get(actor_id)
            .copied()
            .ok_or_else(|| anyhow::anyhow!("attach model before actor spawn: {actor_id}"))?;
        let cache_key = glb_path.to_string_lossy().into_owned();
        let handle = if let Some(handle) = self.actor_asset_cache.get(&cache_key) {
            handle.clone()
        } else {
            let asset_path = cache_key.trim_start_matches('/').to_string();
            let server = self.app.world().resource::<AssetServer>().clone();
            let handle: Handle<Gltf> = server.load(asset_path);
            self.actor_asset_cache.insert(cache_key, handle.clone());
            handle
        };
        let deadline = Instant::now() + Duration::from_secs(300);
        let (scene, animation) = loop {
            self.app.update();
            let loaded = self
                .app
                .world()
                .resource::<Assets<Gltf>>()
                .get(&handle)
                .and_then(|gltf| {
                    let scene = gltf.default_scene.clone()?;
                    let animation = animation_clip
                        .map(|name| {
                            gltf.named_animations
                                .get(name)
                                .cloned()
                                .ok_or_else(|| anyhow::anyhow!(
                                    "actor model {} has no animation clip {name:?}",
                                    glb_path.display()
                                ))
                        })
                        .transpose();
                    Some(animation.map(|animation| (scene, animation)))
                });
            if let Some(loaded) = loaded {
                break loaded?;
            }
            if Instant::now() > deadline {
                bail!("actor model failed to load: {}", glb_path.display());
            }
        };
        let base = self
            .app
            .world()
            .get::<Transform>(cuboid)
            .copied()
            .unwrap_or(Transform::IDENTITY);
        let mut model_transform = base;
        model_transform.scale = Vec3::splat(uniform_scale);
        let model_root = self
            .app
            .world_mut()
            .spawn((
                ActorModelRoot,
                Name::new(format!("actor-model:{actor_id}")),
                WorldAssetRoot(scene),
                model_transform,
            ))
            .id();
        self.app.world_mut().entity_mut(cuboid).insert(Visibility::Hidden);
        loop {
            self.app.update();
            let ready = {
                let world = self.app.world();
                match (
                    world.get::<WorldInstance>(model_root),
                    world.get_resource::<WorldInstanceSpawner>(),
                ) {
                    (Some(instance), Some(spawner)) => spawner.instance_is_ready(**instance),
                    _ => false,
                }
            };
            if ready {
                break;
            }
            if Instant::now() > deadline {
                bail!("actor model scene failed to instantiate: {}", glb_path.display());
            }
        }
        if let Some(clip) = animation {
            let (graph, node) = AnimationGraph::from_clip(clip);
            let graph = self
                .app
                .world_mut()
                .resource_mut::<Assets<AnimationGraph>>()
                .add(graph);
            let players = {
                let world = self.app.world_mut();
                let mut stack = vec![model_root];
                let mut players = Vec::new();
                while let Some(entity) = stack.pop() {
                    if let Some(children) = world.get::<Children>(entity) {
                        stack.extend(children.iter());
                    }
                    if world.get::<AnimationPlayer>(entity).is_some() {
                        players.push(entity);
                    }
                }
                players.sort_by_key(|entity| entity.index());
                for entity in &players {
                    let mut entity_mut = world.entity_mut(*entity);
                    entity_mut.insert(AnimationGraphHandle(graph.clone()));
                    entity_mut
                        .get_mut::<AnimationPlayer>()
                        .expect("animation player disappeared")
                        .play(node)
                        .seek_to(animation_time_s.max(0.0))
                        .pause();
                }
                players
            };
            if players.is_empty() {
                bail!(
                    "actor model {} clip {animation_clip:?} has no animation player",
                    glb_path.display()
                );
            }
            self.actor_animations.insert(
                actor_id.to_string(),
                ActorAnimationBinding { players, node },
            );
            self.app.update();
            while self.receiver.try_recv().is_ok() {}
        }
        let tint_materials = if let Some(color) = tint {
            let targets = {
                let world = self.app.world();
                let mut stack = vec![model_root];
                let mut targets = Vec::new();
                while let Some(entity) = stack.pop() {
                    if let Some(children) = world.get::<Children>(entity) {
                        stack.extend(children.iter());
                    }
                    if world
                        .get::<GltfMaterialName>(entity)
                        .is_some_and(|name| &**name == "body_paint")
                    {
                        if let Some(material) =
                            world.get::<MeshMaterial3d<StandardMaterial>>(entity)
                        {
                            targets.push((entity, material.0.clone()));
                        }
                    }
                }
                targets
            };
            let Some((_, source_handle)) = targets.first() else {
                bail!(
                    "tintable actor model has no body_paint mesh slots: {}",
                    glb_path.display()
                );
            };
            let tinted_handle = {
                let world = self.app.world_mut();
                let mut tinted = world
                    .resource::<Assets<StandardMaterial>>()
                    .get(source_handle)
                    .cloned()
                    .ok_or_else(|| anyhow::anyhow!(
                        "body_paint material missing after actor model load: {}",
                        glb_path.display()
                    ))?;
                tinted.base_color = Color::srgb(color[0], color[1], color[2]);
                world.resource_mut::<Assets<StandardMaterial>>().add(tinted)
            };
            for (entity, _) in targets {
                self.app
                    .world_mut()
                    .entity_mut(entity)
                    .insert(MeshMaterial3d(tinted_handle.clone()));
            }
            vec![tinted_handle]
        } else {
            Vec::new()
        };
        let mesh_count_after = {
            let world = self.app.world_mut();
            let mut query = world.query::<&Mesh3d>();
            query.iter(world).count()
        };
        let model_mesh_count = mesh_count_after.saturating_sub(mesh_count_before);
        if model_mesh_count == 0 {
            bail!("actor model instantiated without mesh nodes: {}", glb_path.display());
        }
        self.actor_models.insert(
            actor_id.to_string(),
            (model_root, uniform_scale, model_mesh_count),
        );
        self.actor_tint_materials
            .insert(actor_id.to_string(), tint_materials);
        Ok(())
    }
    /// Seek a bound actor animation to an explicit simulation timestamp.
    pub fn set_actor_animation_time(&mut self, actor_id: &str, time_s: f32) -> Result<()> {
        let binding = self
            .actor_animations
            .get(actor_id)
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("actor {actor_id} has no animation binding"))?;
        for entity in binding.players {
            let Some(mut player) = self.app.world_mut().get_mut::<AnimationPlayer>(entity) else {
                continue;
            };
            player
                .play(binding.node)
                .seek_to(time_s.max(0.0))
                .pause();
        }
        Ok(())
    }

    pub fn actor_has_model(&self, actor_id: &str) -> bool {
        self.actor_models.contains_key(actor_id)
    }

    pub fn actor_model_mesh_count(&self, actor_id: &str) -> usize {
        self.actor_models
            .get(actor_id)
            .map(|(_, _, count)| *count)
            .unwrap_or(0)
    }

    /// Effective sRGB base colors of this actor's cloned `body_paint`
    /// materials. Empty means the catalog model is not tintable.
    pub fn actor_model_tint_colors(&self, actor_id: &str) -> Vec<[f32; 4]> {
        let Some(handles) = self.actor_tint_materials.get(actor_id) else {
            return Vec::new();
        };
        let materials = self.app.world().resource::<Assets<StandardMaterial>>();
        handles
            .iter()
            .filter_map(|handle| materials.get(handle))
            .map(|material| material.base_color.to_srgba().to_f32_array())
            .collect()
    }
    /// Actor ids currently represented by visible scene geometry.
    pub fn actor_ids(&self) -> Vec<String> {
        self.actors.keys().cloned().collect()
    }

    /// Exclude or restore one actor's RGB geometry without touching its
    /// scene state or layer-1 instance-ID proxy.
    ///
    /// Catalog-backed actors keep their fallback cuboid hidden when restored;
    /// actors without a catalog model restore that cuboid instead.
    pub fn set_actor_visual_hidden(&mut self, actor_id: &str, hidden: bool) {
        let Some((actor, _)) = self.actors.get(actor_id).copied() else {
            return;
        };
        let model = self.actor_models.get(actor_id).map(|(entity, _, _)| *entity);
        let world = self.app.world_mut();
        if let Some(mut visibility) = world.get_mut::<Visibility>(actor) {
            *visibility = if hidden || model.is_some() {
                Visibility::Hidden
            } else {
                Visibility::Inherited
            };
        }
        if let Some(model) = model {
            if let Some(mut visibility) = world.get_mut::<Visibility>(model) {
                *visibility = if hidden {
                    Visibility::Hidden
                } else {
                    Visibility::Inherited
                };
            }
        }
    }


    /// Remove a despawned scene-state actor (both the visible box and its
    /// layer-1 ID clone).
    pub fn remove_actor(&mut self, id: &str) {
        if let Some((entity, instance)) = self.actors.remove(id) {
            let world = self.app.world_mut();
            let name = format!("actor:{id}");
            let mut q = world.query_filtered::<(Entity, &Name), With<IdClone>>();
            let clones: Vec<Entity> = q
                .iter(world)
                .filter(|(_, n)| n.as_str() == name)
                .map(|(e, _)| e)
                .collect();
            world.despawn(entity);
            for clone in clones {
                world.despawn(clone);
            }
            self.actor_classes.remove(&instance);
            if let Some((model, _, _)) = self.actor_models.remove(id) {
                world.despawn(model);
            }
            self.actor_tint_materials.remove(id);
            self.actor_animations.remove(id);
        }
    }

    /// Semantic class name of a dynamic-actor instance id, if any.
    pub fn actor_instance_class(&self, instance_id: u32) -> Option<&str> {
        self.actor_classes.get(&instance_id).map(|s| s.as_str())
    }

    /// Stable instance id allocated to a dynamic actor, if it is spawned.
    pub fn actor_instance_id(&self, actor_id: &str) -> Option<u32> {
        self.actors.get(actor_id).map(|(_, instance_id)| *instance_id)
    }

    /// Snapshot either static map geometry or dynamic actor geometry.
    ///
    /// Static geometry is captured once by the long-lived service; only the
    /// small actor snapshot is rebuilt after each applied scene tick.
    pub fn sensor_triangles(&mut self, dynamic_actors: bool) -> Vec<SensorTriangle> {
        let world = self.app.world_mut();
        let mut query = world.query_filtered::<
            (&Mesh3d, &GlobalTransform, &InstanceId, Option<&Name>),
            Without<IdClone>,
        >();
        let meshes = world.resource::<Assets<Mesh>>();
        let mut out = Vec::new();
        for (mesh3d, transform, instance_id, name) in query.iter(world) {
            let is_actor = name.is_some_and(|name| name.as_str().starts_with("actor:"));
            if is_actor != dynamic_actors {
                continue;
            }
            let Some(mesh) = meshes.get(&mesh3d.0) else { continue };
            let Some(attribute) = mesh.attribute(Mesh::ATTRIBUTE_POSITION) else { continue };
            let bevy::mesh::VertexAttributeValues::Float32x3(vertices) = attribute else { continue };
            let matrix = transform.to_matrix();
            let mut push = |indices: [usize; 3]| {
                let point = |index: usize| matrix.transform_point3(Vec3::from(vertices[index])).to_array();
                out.push(SensorTriangle {
                    a: point(indices[0]),
                    b: point(indices[1]),
                    c: point(indices[2]),
                    instance_id: instance_id.0,
                });
            };
            match mesh.indices() {
                Some(bevy::mesh::Indices::U16(indices)) => {
                    for tri in indices.chunks_exact(3) {
                        push([tri[0] as usize, tri[1] as usize, tri[2] as usize]);
                    }
                }
                Some(bevy::mesh::Indices::U32(indices)) => {
                    for tri in indices.chunks_exact(3) {
                        push([tri[0] as usize, tri[1] as usize, tri[2] as usize]);
                    }
                }
                None => {
                    for first in (0..vertices.len()).step_by(3) {
                        if first + 2 < vertices.len() {
                            push([first, first + 1, first + 2]);
                        }
                    }
                }
            }
        }
        out
    }

    /// Drop every registered camera group (respawn-on-view-change primitive:
    /// the next render re-registers with fresh attributes). Also prunes the
    /// render-world staging buffers for the removed targets.
    pub fn clear_cameras(&mut self) {
        let dropped: Vec<GroupEntities> = self.groups.drain(..).collect();
        if dropped.is_empty() {
            return;
        }
        let sensor_ids: Vec<String> =
            dropped.iter().map(|g| g.spec.sensor_id.clone()).collect();
        let world = self.app.world_mut();
        let mut to_despawn: Vec<Entity> = Vec::new();
        let mut q = world.query::<(Entity, &ReadbackTarget)>();
        for (e, t) in q.iter(world) {
            if sensor_ids.iter().any(|s| t.key.starts_with(s.as_str())) {
                to_despawn.push(e);
            }
        }
        // The camera entities themselves have to go too. Leaving them behind
        // keeps orphaned views rendering into detached targets, which a
        // lookdev surface would accumulate on every re-registration.
        for group in &dropped {
            to_despawn.push(group.rgb_entity);
            to_despawn.extend(group.id_entity);
        }
        for e in to_despawn {
            world.despawn(e);
        }
        if let Some(render_app) = self.app.get_sub_app_mut(RenderApp) {
            if let Some(mut staging) = render_app.world_mut().get_resource_mut::<Staging>() {
                staging.0.retain(|b| {
                    !sensor_ids
                        .iter()
                        .any(|s| b.key.starts_with(format!("{s}:").as_str()))
                });
            }
        }
        self.next_camera_order = 0;
    }

    /// Update until all tiles are loaded, scenes spawned and instances built.
    /// Then builds the deterministic instance-ID pass. Returns the legend.
    pub fn wait_until_ready(&mut self) -> Result<Vec<LegendEntry>> {
        if self.ready {
            return Ok(self.app.world().resource::<Legend>().0.clone());
        }
        let deadline = Instant::now() + Duration::from_secs(300);
        let mut gpu_idle_frames = 0u32;
        loop {
            self.app.update();
            let world = self.app.world_mut();
            let pending_loads = {
                let mut q = world.query_filtered::<&TileLoad, Without<SceneSpawned>>();
                q.iter(world).count()
            };
            let pending_vegetation = {
                let mut q = world.query_filtered::<
                    &crate::veg::VegLoad,
                    (
                        Without<crate::veg::VegSceneSpawned>,
                        Without<crate::veg::VegFailed>,
                    ),
                >();
                q.iter(world).count()
            };
            let pending_instances = {
                let mut q = world.query_filtered::<
                    &crate::veg::VegRoot,
                    Without<crate::veg::VegInstantiated>,
                >();
                q.iter(world).count()
            };
            if pending_loads == 0 && pending_vegetation == 0 && pending_instances == 0 {
                // Collect instance entities under the query's mutable borrow,
                // then re-check readiness through plain world access.
                let roots: Vec<Entity> = {
                    let mut q = world.query::<(Entity, &WorldInstance)>();
                    q.iter(world).map(|(e, _)| e).collect()
                };
                if !roots.is_empty() && world.get_resource::<WorldInstanceSpawner>().is_some() {
                    let spawner = world.resource::<WorldInstanceSpawner>();
                    let all_ready =
                        roots.iter().all(|e| match world.get::<WorldInstance>(*e) {
                            Some(wi) => spawner.instance_is_ready(**wi),
                            None => false,
                        });
                    // Scene entities exist; now the render world must have
                    // compiled every pipeline and bound every material, and
                    // stay that way for a few frames (each frame can queue
                    // new permutations).
                    if all_ready {
                        if world.resource::<GpuPending>().is_idle() {
                            gpu_idle_frames += 1;
                        } else {
                            gpu_idle_frames = 0;
                        }
                        if gpu_idle_frames >= GPU_IDLE_FRAMES {
                            break;
                        }
                    }
                }
            } else {
                // Drain any passes produced while loading so they cannot leak
                // into later captures.
                while self.receiver.try_recv().is_ok() {}
            }
            if Instant::now() > deadline {
                let pending = self.app.world().resource::<GpuPending>();
                bail!(
                    "scene failed to become ready within 300 s ({} pipelines compiling, {} materials unbound)",
                    pending.pipelines(),
                    pending.materials()
                );
            }
        }
        self.finalize_scene()?;
        self.ground = GroundField::build(&mut self.app, 2.0);
        // Now that tiles are loaded, put the planet surface on the scene's
        // own ground plane. The boundary-layer fog term has a 300 m scale
        // height, so a tens-of-metres offset would be visible.
        if self.lighting.atmosphere && self.lighting.ground_y.is_none() {
            if let Some(median) = self.ground.median_y() {
                self.reanchor_atmosphere(median);
            }
        }
        self.ready = true;
        Ok(self.app.world().resource::<Legend>().0.clone())
    }

    fn finalize_scene(&mut self) -> Result<()> {
        let world = self.app.world_mut();

        // Deterministic instance-ID assignment: sort by mesh name then entity
        // bits (independent of ECS iteration order), then clone each mesh onto
        // render layer 1 under an unlit RGB24-encoded ID material.
        // A clone of a skinned mesh must carry the `SkinnedMesh` component:
        // the mesh's JOINTS/WEIGHTS attributes select the skinned pipeline
        // layout, and without the component Bevy binds the model-only bind
        // group and the draw fails validation (bevy#16929).
        let mut entries: Vec<(
            String,
            u64,
            Entity,
            Handle<Mesh>,
            Option<Entity>,
            Transform,
            Option<SkinnedMesh>,
        )> = Vec::new();
        {
            let mut q = world.query::<(
                Entity,
                &Mesh3d,
                Option<&Name>,
                Option<&ChildOf>,
                Option<&Transform>,
                Option<&SkinnedMesh>,
            )>();
            for (e, mesh, name, child_of, transform, skin) in q.iter(world) {
                entries.push((
                    name.map(|n| n.to_string())
                        .unwrap_or_else(|| format!("unnamed_mesh_{e}")),
                    e.to_bits(),
                    e,
                    mesh.0.clone(),
                    child_of.map(|c| c.parent()),
                    transform.copied().unwrap_or(Transform::IDENTITY),
                    skin.cloned(),
                ));
            }
        }
        entries.sort_by(|a, b| a.0.cmp(&b.0).then(a.1.cmp(&b.1)));

        // Create all ID materials under one mutable borrow, then spawn the
        // clone entities once the assets borrow is released.
        let prepared: Vec<(
            u32,
            String,
            Entity,
            Handle<Mesh>,
            Handle<StandardMaterial>,
            Option<Entity>,
            Transform,
            Option<SkinnedMesh>,
        )> = {
            let mut materials = world.resource_mut::<Assets<StandardMaterial>>();
            entries
                .into_iter()
                .enumerate()
                .map(|(i, (name, _, entity, mesh_h, parent, transform, skin))| {
                    let id = (i + 1) as u32; // 0 reserved as background
                    let bytes = id.to_le_bytes();
                    let mat = materials.add(StandardMaterial {
                        base_color: Color::srgb_u8(bytes[0], bytes[1], bytes[2]),
                        unlit: true,
                        ..default()
                    });
                    (id, name, entity, mesh_h, mat, parent, transform, skin)
                })
                .collect()
        };
        let mut legend = Vec::with_capacity(prepared.len());
        for (id, name, entity, mesh_h, mat, parent, transform, skin) in prepared {
            world.entity_mut(entity).insert(InstanceId(id));
            let mut cmd = world.spawn((
                IdClone,
                Mesh3d(mesh_h),
                MeshMaterial3d(mat),
                RenderLayers::layer(1),
                transform,
            ));
            if let Some(p) = parent {
                cmd.insert(ChildOf(p));
            }
            if let Some(skin) = skin {
                cmd.insert(skin);
            }
            legend.push(LegendEntry { id, name });
        }
        world.resource_mut::<Legend>().0 = legend;

        // One update so the newly spawned ID clones are extracted before the
        // first real render request.
        self.app.update();
        while self.receiver.try_recv().is_ok() {}
        Ok(())
    }

    /// Set the pose of a registered camera group (applies to RGB + ID cams).
    pub fn set_pose(&mut self, sensor_id: &str, eye: &[f32; 3], target: &[f32; 3]) -> Result<()> {
        let eye = Vec3::from_slice(eye);
        let target = Vec3::from_slice(target);
        let group = self
            .groups
            .iter()
            .find(|g| g.spec.sensor_id == sensor_id)
            .ok_or_else(|| anyhow::anyhow!("unknown sensor {sensor_id}"))?;
        let transform = Transform::from_translation(eye).looking_at(target, Vec3::Y);
        let world = self.app.world_mut();
        if let Some(mut t) = world.get_mut::<Transform>(group.rgb_entity) {
            *t = transform;
        }
        if let Some(id_entity) = group.id_entity {
            if let Some(mut t) = world.get_mut::<Transform>(id_entity) {
                *t = transform;
            }
        }
        Ok(())
    }

    /// Unregister a camera group and drop its render targets.
    ///
    /// Exists for `sky-bench`: an A/B that leaves each resolution's camera
    /// registered would render all of them every frame and measure the sum
    /// rather than the configuration under test.
    pub fn remove_camera(&mut self, sensor_id: &str) -> bool {
        let Some(index) = self
            .groups
            .iter()
            .position(|g| g.spec.sensor_id == sensor_id)
        else {
            return false;
        };
        let group = self.groups.remove(index);
        let keys: Vec<String> = group.spec.passes.keys(&group.spec.sensor_id);
        let world = self.app.world_mut();
        let mut stale: Vec<Entity> = vec![group.rgb_entity];
        stale.extend(group.id_entity);
        {
            let mut targets = world.query::<(Entity, &ReadbackTarget)>();
            for (entity, target) in targets.iter(world) {
                if keys.iter().any(|k| *k == target.key) {
                    stale.push(entity);
                }
            }
        }
        for entity in stale {
            world.despawn(entity);
        }
        world.flush();
        true
    }

    /// Expected readback keys across all registered cameras.
    pub fn expected_keys(&self) -> Vec<String> {
        self.groups
            .iter()
            .flat_map(|g| g.spec.passes.keys(&g.spec.sensor_id))
            .collect()
    }

    /// Warmup iterations: lets shaders/pipelines compile so subsequent
    /// captures measure steady state. Discards all readbacks.
    pub fn warmup(&mut self, iterations: u32) {
        for _ in 0..iterations {
            self.app.update();
            while self.receiver.try_recv().is_ok() {}
        }
    }

    /// One full app iteration with blocking readback. Returns
    /// `"<sensor>:<pass>" -> raw row-padded bytes` for every expected key.
    ///
    /// A view whose component set just changed can need an extra iteration
    /// before the graph produces anything: new pipelines are still being
    /// specialized and the prepass/view-target chain is being rebuilt. That
    /// used to surface as a hard `readback incomplete` on the first frame
    /// after e.g. anti-aliasing switched away from TAA. `apply_lighting`
    /// pays that cost up front with a warmup, and this bounded retry covers
    /// the same seam for callers that change a view by other means. It
    /// cannot alter a successful render: it only runs where the previous
    /// behaviour was an error.
    pub fn render_once(&mut self) -> Result<HashMap<String, Vec<u8>>> {
        let expected = self.expected_keys();
        let mut passes = HashMap::new();
        let mut missing: Vec<String> = Vec::new();
        for _ in 0..3 {
            self.app.update();
            while let Ok(p) = self.receiver.try_recv() {
                passes.insert(p.key, p.data);
            }
            missing = expected.iter().filter(|k| !passes.contains_key(*k)).cloned().collect();
            if missing.is_empty() {
                return Ok(passes);
            }
        }
        bail!(
            "readback incomplete after update: got {:?}, missing {:?}",
            passes.keys().collect::<Vec<_>>(),
            missing
        )
    }

    pub fn is_ready(&self) -> bool {
        self.ready
    }
}

// ---------------------------------------------------------------------------
// Main-world systems
// ---------------------------------------------------------------------------

/// When a queued tile's glTF and every asset it references (external images,
/// buffers) have loaded, spawn its default scene (WorldAssetRoot) and mark it
/// loaded. Gating on the `Gltf` asset alone is not enough: master glTFs keep
/// their images as external `.ktx2` files that load after the document, and a
/// frame captured before they land shows fallback materials.
fn spawn_loaded_tiles(
    mut commands: Commands,
    server: Res<AssetServer>,
    gltfs: Res<Assets<Gltf>>,
    loads: Query<(Entity, &TileLoad), Without<SceneSpawned>>,
) {
    for (e, tile) in &loads {
        let Some(gltf) = gltfs.get(&tile.0) else {
            continue;
        };
        match server.recursive_dependency_load_state(tile.0.id()) {
            RecursiveDependencyLoadState::Loaded => {}
            RecursiveDependencyLoadState::Failed(error) => {
                panic!("glTF dependency failed to load: {error}");
            }
            RecursiveDependencyLoadState::NotLoaded | RecursiveDependencyLoadState::Loading => continue,
        }
        // glTF makes `scene` optional; a file without a default scene is
        // still valid, so fall back to its first scene.
        let Some(scene) = gltf.default_scene.clone().or_else(|| gltf.scenes.first().cloned()) else {
            panic!("GLB without any scene");
        };
        commands.entity(e).insert(SceneSpawned);
        commands.spawn((WorldAssetRoot(scene),));
    }
}

// ---------------------------------------------------------------------------
// Render-world systems (adapted verbatim from the spike)
// ---------------------------------------------------------------------------

/// Per-frame extraction of main-world readback targets.
#[derive(Resource, Default)]
struct ExtractedTargets(Vec<ReadbackTarget>);

fn extract_targets(
    targets: Extract<Query<&ReadbackTarget>>,
    mut out: ResMut<ExtractedTargets>,
) {
    let count = targets.iter().count();
    out.0 = targets.iter().cloned().collect();
    if std::env::var("NATIVE_DEBUG").is_ok() {
        eprintln!("extract_targets: {count}");
    }
}

/// Ensure a staging buffer exists for every registered readback target.
fn sync_staging(
    targets: Res<ExtractedTargets>,
    device: Res<RenderDevice>,
    gpu_images: Res<RenderAssets<GpuImage>>,
    mut staging: ResMut<Staging>,
) {
    for target in targets.0.iter() {
        if staging.0.iter().any(|b| b.src_image == target.src_image && b.depth == target.depth) {
            continue;
        }
        // Resolve dimensions from the GPU image (depth views share extents).
        let Some(gpu) = gpu_images.get(&target.src_image) else { continue };
        let width = gpu.texture_descriptor.size.width as usize;
        let height = gpu.texture_descriptor.size.height;
        let pixel: usize = if target.depth {
            4
        } else {
            gpu.texture_descriptor.format.block_copy_size(None).unwrap_or(4) as usize
        };
        let padded_row = aligned_row(width, pixel);
        if std::env::var("NATIVE_DEBUG").is_ok() {
            eprintln!("sync_staging: push {}", target.key);
        }
        staging.0.push(StagingBuffer {
            key: target.key.clone(),
            src_image: target.src_image.clone(),
            depth: target.depth,
            padded_row,
            height,
            buffer: make_buffer(&device, padded_row * height as usize),
        });
    }
}

fn copy_passes(
    ctx: RenderContext,
    queue: Res<RenderQueue>,
    staging: Res<Staging>,
    gpu_images: Res<RenderAssets<GpuImage>>,
    depth_views: Query<(Entity, &ExtractedCamera, &ViewDepthTexture)>,
) {
    if staging.0.is_empty() {
        return;
    }
    let mut encoder = ctx
        .render_device()
        .create_command_encoder(&CommandEncoderDescriptor::default());

    for b in staging.0.iter() {
        if b.depth {
            // Find the 3D view rendering to this readback's source image.
            let Some((_, _, view)) = depth_views.iter().find(|(_, cam, _)| {
                matches!(
                    cam.target,
                    Some(bevy::camera::NormalizedRenderTarget::Image(ref irt))
                        if irt.handle.id() == b.src_image.id()
                )
            }) else {
                continue;
            };
            let tex = &view.texture;
            encoder.copy_texture_to_buffer(
                tex.as_image_copy(),
                TexelCopyBufferInfo {
                    buffer: &b.buffer,
                    layout: TexelCopyBufferLayout {
                        offset: 0,
                        bytes_per_row: Some(
                            std::num::NonZero::<u32>::new(b.padded_row as u32).unwrap().into(),
                        ),
                        rows_per_image: None,
                    },
                },
                tex.size(),
            );
        } else {
            let Some(src) = gpu_images.get(&b.src_image) else {
                continue;
            };
            encoder.copy_texture_to_buffer(
                src.texture.as_image_copy(),
                TexelCopyBufferInfo {
                    buffer: &b.buffer,
                    layout: TexelCopyBufferLayout {
                        offset: 0,
                        bytes_per_row: Some(
                            std::num::NonZero::<u32>::new(b.padded_row as u32).unwrap().into(),
                        ),
                        rows_per_image: None,
                    },
                },
                src.texture_descriptor.size,
            );
        }
    }

    queue.submit(std::iter::once(encoder.finish()));
}

fn receive_passes(
    device: Res<RenderDevice>,
    sender: Res<RenderSender>,
    staging: Res<Staging>,
) {
    if staging.0.is_empty() {
        return;
    }

    let (s, r) = crossbeam_channel::bounded::<()>(staging.0.len());
    for b in &staging.0 {
        let tx = s.clone();
        b.buffer
            .slice(..)
            .map_async(MapMode::Read, move |res| {
                if res.is_err() {
                    panic!("map buffer failed");
                }
                let _ = tx.send(());
            });
    }
    device
        .poll(PollType::wait_indefinitely())
        .expect("poll device");
    for _ in &staging.0 {
        r.recv().expect("map_async result");
    }

    for b in &staging.0 {
        let data = b.buffer.slice(..).get_mapped_range().to_vec();
        let _ = sender.send(SentPass { key: b.key.clone(), data });
        b.buffer.unmap();
    }
}

fn b_key(b: &StagingBuffer) -> String {
    format!("{}:{}", if b.depth { "d" } else { "i" }, b.src_image.id())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn one_meter_exposes_twilight_between_noon_and_night() {
        let at = |elev: f32| {
            let lighting = Lighting {
                atmosphere: true,
                sun_elev_deg: elev,
                ..Default::default()
            };
            lighting.resolve().1.ev100
        };
        let noon = at(60.0);
        let dusk = at(-5.0);
        let night = at(-26.0);
        assert!(noon > dusk && dusk > night, "{noon} {dusk} {night}");
        // A lit street is not daylight, and the camera does not pretend it is.
        assert!(night < 3.0, "{night}");
        assert!(night >= CAMERA_EV100_FLOOR);
        // Civil dusk (~7 lx of skylight, EV ~1.5 metered, ~3.5 stops of
        // adaptation) still meters on the twilight sky, not on the ledger.
        assert!((4.0..8.0).contains(&dusk), "{dusk}");
    }

    #[test]
    fn night_ledger_lifts_the_meter_when_luminaires_are_near() {
        let mut lit = Lighting {
            atmosphere: true,
            sun_elev_deg: -26.0,
            ..Default::default()
        };
        let dark = lit.resolve().1.ev100;
        lit.night.observer_position = [0.0, 1.6, 0.0];
        lit.night.fixtures = (0..8)
            .map(|i| crate::night::NightFixture {
                source_id: format!("f{i}"),
                source_name: "lamp".into(),
                position: [(i as f32 - 4.0) * 25.0, 9.0, 6.0],
                heading_rad: 0.0,
                lumens: 6_000.0,
                cct_k: 2_700.0,
                range_m: 32.0,
                outer_angle_deg: 70.0,
                confidence: 1.0,
                rule: "test".into(),
            })
            .collect();
        let street = lit.resolve().1.ev100;
        assert!(street > dark + 2.0, "{street} vs {dark}");
    }

    #[test]
    fn exposure_bias_and_night_offset_are_applied_after_the_meter() {
        let base = Lighting {
            atmosphere: true,
            sun_elev_deg: -7.0,
            ..Default::default()
        };
        let reference = base.resolve().1.ev100;
        let biased = Lighting {
            ev100_bias: 2.0,
            ..base.clone()
        };
        assert!((biased.resolve().1.ev100 - (reference + 2.0)).abs() < 1.0e-4);
        let mut offset = base.clone();
        offset.night.exposure_offset_stops = 1.5;
        assert!((offset.resolve().1.ev100 - (reference + 1.5)).abs() < 1.0e-4);
    }

    #[test]
    fn gpu_solar_source_reaches_zero_at_astronomical_night() {
        assert_eq!(astronomical_twilight_sun_gain(-18.0), 0.0);
        assert_eq!(astronomical_twilight_sun_gain(-30.0), 0.0);
        assert_eq!(astronomical_twilight_sun_gain(-6.0), 1.0);
        assert_eq!(astronomical_twilight_sun_gain(20.0), 1.0);
        assert!((0.0..1.0).contains(&astronomical_twilight_sun_gain(-12.0)));

        let night = Lighting {
            atmosphere: true,
            sun_elev_deg: -26.0,
            ..Default::default()
        };
        let (plan, resolved) = night.resolve();
        assert_eq!(resolved.sun_lux, 0.0);
        assert_eq!(plan.sun_lux, 1.0e-8, "GPU-only dark-LUT seed");
    }

    #[test]
    fn incident_meter_matches_the_iso_100_convention() {
        // 250 lx is EV100 6.64 on a C = 250 incident meter.
        assert!((incident_meter_ev100(250.0) - 6.643856).abs() < 1.0e-4);
        assert!((incident_meter_ev100(2.5) - 0.0).abs() < 1.0e-6);
    }

    #[test]
    fn sky_highlight_meter_places_the_luminance_at_the_ceiling() {
        // Middle grey at EV 10 is 0.216 * 2^10 cd/m^2; the same luminance
        // read as a highlight sits SKY_HIGHLIGHT_STOPS below that EV.
        let mid_grey = 0.18 * 1.2 * 2f32.powi(10);
        assert!((sky_highlight_ev100(mid_grey) - (10.0 - SKY_HIGHLIGHT_STOPS)).abs() < 1.0e-4);
    }

    fn towards(azimuth_deg: f32, elevation_deg: f32) -> [f32; 3] {
        let e = elevation_deg.to_radians();
        let a = azimuth_deg.to_radians();
        [e.cos() * a.sin(), e.sin(), e.cos() * a.cos()]
    }

    #[test]
    fn sunward_low_sun_is_metered_on_the_aureole_and_noon_is_not() {
        let sunset = Lighting {
            atmosphere: true,
            sun_elev_deg: 5.7,
            sun_azim_deg: 245.0,
            ..Default::default()
        };
        let incident_only = sunset.resolve().1.ev100;
        let sunward = Lighting {
            meter_view: Some(crate::atmosphere::MeterView {
                forward: towards(245.0, -3.0),
                fov_y_deg: 55.0,
                aspect: 16.0 / 9.0,
            }),
            ..sunset.clone()
        };
        let (_, resolved) = sunward.resolve();
        let view = resolved.atmosphere.as_ref().unwrap().view_sky.unwrap();
        assert!(view.sun_in_field > 0.99, "sun framed: {view:?}");
        assert!(view.max_cdm2 > 4.0 * view.mean_cdm2, "aureole dominates: {view:?}");
        assert!(
            resolved.ev100 > incident_only + 1.0,
            "sunward sunset stops down: {} vs {incident_only}",
            resolved.ev100
        );
        // Facing away, the framed sky is the dim anti-solar side: the
        // incident meter wins and the picture is unchanged.
        let away = Lighting {
            meter_view: Some(crate::atmosphere::MeterView {
                forward: towards(65.0, -3.0),
                fov_y_deg: 55.0,
                aspect: 16.0 / 9.0,
            }),
            ..sunset.clone()
        };
        let (_, away_resolved) = away.resolve();
        assert!((away_resolved.ev100 - incident_only).abs() < 1.0e-4);
        assert_eq!(away_resolved.atmosphere.unwrap().view_sky.unwrap().sun_in_field, 0.0);

        let noon = Lighting {
            atmosphere: true,
            sun_elev_deg: 69.5,
            sun_azim_deg: 180.0,
            meter_view: Some(crate::atmosphere::MeterView {
                forward: towards(180.0, -3.0),
                fov_y_deg: 55.0,
                aspect: 16.0 / 9.0,
            }),
            ..Default::default()
        };
        let plain = Lighting { meter_view: None, ..noon.clone() };
        assert!((noon.resolve().1.ev100 - plain.resolve().1.ev100).abs() < 1.0e-4);
    }

    #[test]
    fn atmosphere_ibl_tapers_into_the_probe_without_a_step() {
        assert_eq!(atmosphere_ibl_gain(10.0), 1.0);
        assert_eq!(atmosphere_ibl_gain(IBL_TAPER_START_ELEVATION_DEG), 1.0);
        let at_handover = atmosphere_ibl_gain(PROBE_HANDOVER_ELEVATION_DEG);
        assert!((at_handover - 1.0 / 1.18).abs() < 1.0e-6);
        let mid = atmosphere_ibl_gain(
            0.5 * (IBL_TAPER_START_ELEVATION_DEG + PROBE_HANDOVER_ELEVATION_DEG),
        );
        assert!(mid > at_handover && mid < 1.0);
    }

    #[test]
    fn ladder_tiers_follow_the_two_handovers() {
        assert_eq!(ladder_tier(30.0), LadderTier::Day);
        assert_eq!(ladder_tier(PROBE_HANDOVER_ELEVATION_DEG + 0.01), LadderTier::Day);
        assert_eq!(ladder_tier(PROBE_HANDOVER_ELEVATION_DEG), LadderTier::Twilight);
        assert_eq!(ladder_tier(NIGHT_SOURCES_ELEVATION_DEG + 0.01), LadderTier::Twilight);
        assert_eq!(ladder_tier(NIGHT_SOURCES_ELEVATION_DEG), LadderTier::Night);
        assert_eq!(ladder_tier(-30.0), LadderTier::Night);
    }

    #[test]
    fn sun_membership_fades_across_the_field_edge() {
        let probe = |azimuth_offset: f32| {
            let lighting = Lighting {
                atmosphere: true,
                sun_elev_deg: 8.0,
                sun_azim_deg: 200.0,
                meter_view: Some(crate::atmosphere::MeterView {
                    forward: towards(200.0 + azimuth_offset, 0.0),
                    fov_y_deg: 40.0,
                    aspect: 1.0,
                }),
                ..Default::default()
            };
            lighting.resolve().1.atmosphere.unwrap().view_sky.unwrap().sun_in_field
        };
        // Half-field is 20 deg (tan 0.364): fully inside, on the ramp
        // (tangent between 0.8 and 1.25 of the half-field), fully outside.
        assert_eq!(probe(0.0), 1.0);
        assert_eq!(probe(10.0), 1.0);
        let edge = probe(20.0);
        assert!(edge > 0.0 && edge < 1.0, "soft edge: {edge}");
        assert_eq!(probe(30.0), 0.0);
    }

    #[test]
    fn physical_default_has_no_global_fill_or_camera_headlamp() {
        let lighting = Lighting::default();
        let env = crate::night::resolve_night(&lighting.night, 16.0, false);
        assert!((env.urban_skyglow_lux - 0.05).abs() < 1.0e-6);
        assert!(env.source_ledger.iter().any(|source| source.id == "urban-skyglow"));
    }
    #[test]
    #[ignore = "focused GPU integration test"]
    fn service_actor_catalog_models_instantiate_mesh_nodes() {
        let repo = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");

        let vehicle = repo.join(
            "catalog/vehicles-carla/models/vehicle_sedan_lincoln_mkz_2020.glb",
        );
        let pedestrian =
            repo.join("catalog/pedestrians-carla/models/pedestrian_0015.glb");
        assert!(vehicle.is_file() && pedestrian.is_file());

        let mut app = SceneApp::new(&Lighting::default()).unwrap();
        app.load_tiles(&[vehicle.to_string_lossy().into_owned()])
            .unwrap();
        app.wait_until_ready().unwrap();

        app.upsert_actor(
            "vehicle-test",
            "car",
            [0.0, 0.0, 0.0],
            0.0,
            [4.5, 1.6, 1.8],
            [0.5, 0.5, 0.5],
            false,
        );
        app.attach_actor_model("vehicle-test", &vehicle, 1.0, Some([0.56, 0.18, 0.18]))
            .unwrap();
        app.upsert_actor(
            "walker-test",
            "pedestrian",
            [8.0, 0.0, 0.0],
            0.0,
            [0.5, 1.8, 0.5],
            [0.5, 0.5, 0.5],
            false,
        );
        app.attach_actor_model("walker-test", &pedestrian, 1.0, None)
            .unwrap();

        assert!(app.actor_model_mesh_count("vehicle-test") > 1);
        assert!(app.actor_model_mesh_count("walker-test") > 1);
        assert_eq!(
            app.actor_model_tint_colors("vehicle-test"),
            vec![[0.56, 0.18, 0.18, 1.0]]
        );
        assert!(app.actor_model_tint_colors("walker-test").is_empty());
        // Bevy's async asset tasks can still hold the test-only wgpu device
        // when the process tears down; the production service intentionally
        // lives for the process lifetime.
        std::mem::forget(app);
    }
}
