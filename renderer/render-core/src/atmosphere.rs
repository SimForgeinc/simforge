//! Physically based real-time atmosphere (Hillaire 2020 LUT model).
//!
//! This module replaces the fixed sky cubemap / gradient path (see
//! `crate::lighting::synthetic_sky_cubemap`) with a real participating-medium
//! atmosphere. It is a thin, physically-parameterised driver over Bevy
//! 0.19.1's built-in `bevy_pbr::atmosphere`, which implements
//! [Hillaire 2020, *A Scalable and Production Ready Sky and Atmosphere
//! Rendering Technique*][paper] — the same technique as Unreal's
//! `SkyAtmosphere` — with exactly the LUT chain the paper specifies:
//!
//! | LUT                  | Bevy default        | what it stores                                  |
//! |----------------------|---------------------|-------------------------------------------------|
//! | transmittance        | 256x128 2D          | T(r, mu) to the top of atmosphere               |
//! | multiple scattering  | 32x32 2D            | O(1) isotropic multi-scatter factor psi_ms      |
//! | sky view             | 400x200 2D          | camera-oriented non-linear sky radiance         |
//! | aerial perspective   | 32x32x32 3D         | frustum-fitted inscattering + transmittance     |
//!
//! and composites the solar disc *after* the sky-view LUT sample
//! (`bevy_pbr::atmosphere::functions::sample_sun_radiance`), because a
//! 400x200 LUT cannot preserve a 0.53 deg disc.
//!
//! ## Why the built-in path
//!
//! Discovery (Bevy 0.19.1, `~/.cargo/registry/.../bevy_pbr-0.19.1/src/atmosphere/`)
//! found the complete paper implementation already in-tree and wired into
//! `PbrPlugin` by default: `transmittance_lut.wgsl`,
//! `multiscattering_lut.wgsl`, `sky_view_lut.wgsl`, `aerial_view_lut.wgsl`,
//! `render_sky.wgsl`, `environment.wgsl`. Crucially it also closes the
//! energy loop that a bolt-on sky plugin cannot:
//!
//! * `pbr_lighting.wgsl` multiplies every `DirectionalLight` by
//!   `sample_transmittance_lut(r, mu_light) * calculate_visible_sun_ratio(..)`
//!   under `#ifdef ATMOSPHERE`. So `DirectionalLight::illuminance` must be
//!   the **extraterrestrial** normal illuminance; the atmosphere itself
//!   performs the air-mass attenuation and the below-horizon cutoff. Passing
//!   a ground-level lux value here would double-count the attenuation.
//! * `AtmosphereEnvironmentMapLight` filters the sky-view LUT into the
//!   diffuse/specular IBL cubemap, so ambient light *is* the resolved sky.
//! * `render_sky.wgsl` composites the aerial-perspective LUT over opaque
//!   geometry with dual-source blending, so distance haze on the scene and
//!   the visible sky come out of one solve. `DistanceFog` must therefore be
//!   off, or the scene gets fogged twice.
//!
//! A custom render plugin would have had to re-implement all of that.
//!
//! ## Divergences from the paper that this module corrects
//!
//! Bevy's convenience constructors are not used, because two of their values
//! disagree with the paper (verified against the source, 0.19.1):
//!
//! 1. `ScatteringMedium::earth` sets the Mie term to
//!    `absorption: 3.996e-6, scattering: 0.444e-6` — the paper's numbers are
//!    the other way round (`beta_sca = 3.996e-6`, `beta_ext = 4.40e-6`, so
//!    `beta_abs = 0.404e-6`). As shipped, clear-air aerosol has a
//!    single-scattering albedo of 0.10 instead of 0.91, which kills the
//!    forward Mie glow around the sun and makes haze absorb rather than
//!    scatter.
//! 2. The same constructor writes its exponential falloffs as `8.0 / 60.0`
//!    and `1.2 / 60.0`, i.e. it assumes a 60 km atmosphere, while
//!    `Atmosphere::earth` spans 100 km (6360 -> 6460 km). The falloff
//!    parameter is `1 - altitude / (outer - inner)`, so those scales are
//!    effective scale heights of 13.3 km and 2.0 km, not 8 km and 1.2 km.
//!
//! [`earth_terms`] uses the paper's values with the correct 100 km
//! normalisation.
//!
//! ## Weather
//!
//! Weather is not a set of brightness multipliers here; it is aerosol and
//! cloud physics added to the same medium, so one solve drives the visible
//! sky, the sun's colour/transmittance, the IBL and the aerial perspective:
//!
//! * **Boundary-layer haze/fog** — a grey Mie term whose ground extinction
//!   comes from Koschmieder's relation, `beta_ext(0) = 3.912 / V`, minus the
//!   background Rayleigh + tropospheric-aerosol extinction already present,
//!   with a shallow scale height (`FOG_SCALE_HEIGHT_*`).
//! * **Tropospheric aerosol** — the paper's Mie term, scaled by Linke
//!   turbidity (`T_L = 1.9` is a Rayleigh-only atmosphere, 2.5 typical
//!   clear, 6+ heavily polluted). `haze` folds in as extra turbidity.
//! * **Cloud deck** — a dense, nearly conservative (`albedo 0.9999`) Mie slab
//!   between a base and top altitude, vertical optical depth driven by
//!   coverage. Because it lives in the medium, the transmittance LUT
//!   attenuates the beam and the disc through it, the sky-view LUT brightens
//!   and flattens, the environment map follows, and the aerial-perspective
//!   LUT stays consistent — with no separate cloud shading path and no
//!   double-counted energy.
//!
//! **Honest limitation:** that deck is *horizontally uniform*. It is a real
//! participating medium, shaded by the same scattering solve as the rest of
//! the sky — it is not volumetric cloud rendering, it has no cloud shapes,
//! and it casts no per-cloud shadows on the ground. Broken cumulus therefore
//! reads as a bright flat deck rather than as individual clouds. Structured
//! cloud geometry is not an option in this scene either: the camera far
//! plane is 900 m by default (`service::server::default_far`) and 2 km in
//! the lookdev lab, while the horizon distance of a 1 km cloud base is
//! ~110 km. A cloud dome would be clipped away everywhere except straight
//! overhead, which is worse than not having one.
//!
//! [paper]: https://sebh.github.io/publications/egsr2020.pdf

use std::sync::Arc;

use bevy::asset::{Assets, Handle};
use bevy::color::{Color, ColorToComponents};
use bevy::light::atmosphere::{Falloff, PhaseFunction, ScatteringMedium, ScatteringTerm};
use bevy::light::{Atmosphere, AtmosphereEnvironmentMapLight};
use bevy::math::curve::{FunctionCurve, Interval};
use bevy::math::{UVec2, UVec3, Vec3};
use bevy::pbr::{AtmosphereMode, AtmosphereSettings};

// ---------------------------------------------------------------------------
// Earth reference parameters (Hillaire 2020, Table 1 / UnrealEngineSkyAtmosphere)
// ---------------------------------------------------------------------------

/// Planet radius, m.
pub const INNER_RADIUS_M: f32 = 6_360_000.0;
/// Radius at which the atmosphere is considered to end, m.
pub const OUTER_RADIUS_M: f32 = 6_460_000.0;
/// Atmosphere thickness, m. The falloff parameter `p` used by every
/// [`Falloff`] is `1 - altitude / ATMOSPHERE_HEIGHT_M`.
pub const ATMOSPHERE_HEIGHT_M: f32 = OUTER_RADIUS_M - INNER_RADIUS_M;

/// Rayleigh (molecular) scattering coefficient at sea level, m^-1, per RGB.
pub const RAYLEIGH_SCATTERING: Vec3 = Vec3::new(5.802e-6, 13.558e-6, 33.100e-6);
/// Rayleigh scale height, m.
pub const RAYLEIGH_SCALE_HEIGHT_M: f32 = 8_000.0;

/// Mie (aerosol) scattering coefficient at sea level, m^-1.
pub const MIE_SCATTERING: f32 = 3.996e-6;
/// Mie extinction coefficient at sea level, m^-1. Absorption is the
/// difference from [`MIE_SCATTERING`] (single-scattering albedo 0.908).
pub const MIE_EXTINCTION: f32 = 4.400e-6;
/// Mie scale height, m.
pub const MIE_SCALE_HEIGHT_M: f32 = 1_200.0;
/// Henyey-Greenstein asymmetry of tropospheric aerosol.
pub const MIE_ASYMMETRY: f32 = 0.8;

/// Ozone absorption coefficient, m^-1 per RGB, at [`REFERENCE_OZONE_DU`].
pub const OZONE_ABSORPTION: Vec3 = Vec3::new(0.650e-6, 1.881e-6, 0.085e-6);
/// Centre altitude of the ozone tent, m.
pub const OZONE_CENTER_M: f32 = 25_000.0;
/// Full width of the ozone tent, m.
pub const OZONE_WIDTH_M: f32 = 30_000.0;
/// Total column ozone the reference coefficients correspond to, Dobson units.
pub const REFERENCE_OZONE_DU: f32 = 300.0;

/// Ground albedo fed to the multiple-scattering LUT. Bay Area corpus:
/// asphalt/roofs/vegetation mix, measured-typical 0.20-0.28.
pub const GROUND_ALBEDO: f32 = 0.24;

/// Solar illuminance above the atmosphere, lx. 1361 W/m^2 at ~93 lm/W for
/// the extraterrestrial solar spectrum.
pub const SOLAR_CONSTANT_LX: f32 = 128_000.0;

/// Solar angular diameter, degrees. The disc is composited at this exact
/// size by `sample_sun_radiance`, so its peak radiance is
/// `E / (pi/4 * theta^2)` ~ 1.9e9 cd/m^2 above the atmosphere.
pub const SUN_ANGULAR_DIAMETER_DEG: f32 = 0.53;

/// Resolution of the shared falloff/phase LUTs of a [`ScatteringMedium`].
///
/// This is one number, not two, on purpose. `bevy_pbr::medium` fills the
/// `falloff_resolution x phase_resolution` scattering texture row-major but
/// indexes it with `raw_i % phase_resolution` for the *falloff* axis, so the
/// texture is transposed — and therefore scrambled — whenever the two
/// resolutions differ. Keeping them equal side-steps that.
///
/// 1024 texels across a 100 km atmosphere is 97.7 m of altitude resolution,
/// which is what sets [`FOG_SCALE_HEIGHT_DENSE_M`] and the minimum cloud
/// slab thickness. The LUT pair costs ~16 MB and is rebuilt whenever the
/// medium changes (i.e. on relight, not per frame).
pub const MEDIUM_LUT_RESOLUTION: u32 = 1024;

/// Scale height of the boundary-layer aerosol term in dense fog, m. Floored
/// by the density LUT's 97.7 m altitude resolution: a thinner layer would be
/// smeared, so ground extinction (hence visibility) would stop being exact.
pub const FOG_SCALE_HEIGHT_DENSE_M: f32 = 300.0;
/// Scale height of the boundary-layer aerosol term in clear air, m.
pub const FOG_SCALE_HEIGHT_CLEAR_M: f32 = 1_500.0;

/// Koschmieder contrast threshold: `V = KOSCHMIEDER / beta_ext`.
pub const KOSCHMIEDER: f32 = 3.912;

/// Above this meteorological visibility the boundary-layer term is dropped:
/// a pure Rayleigh + background-aerosol atmosphere already has a
/// ~250 km visibility, so anything beyond this adds nothing.
pub const VISIBILITY_UNLIMITED_M: f32 = 120_000.0;

/// Fractional cover at and above which the cloud deck is treated as
/// continuous, i.e. the sun can no longer sit in a hole. Synoptic practice
/// calls 7/8 (0.875) overcast; 0.85 is the same idea rounded down.
pub const OVERCAST_COVER: f32 = 0.85;

/// Natural moonless integrated illuminance used by the incident exposure
/// meter, lx. The visible and IBL distributions are rendered separately by
/// `night::celestial_cubemap`; this scalar is only their energy closure.
/// Urban skyglow is never folded into it and is an explicit site control.
pub const NIGHT_FLOOR_LX: f32 = 0.002;

/// Photometric (CIE Y) weights used to collapse the RGB transmittance and
/// radiance triples this model carries into a single photometric number for
/// the status readback.
const LUMA: Vec3 = Vec3::new(0.2126, 0.7152, 0.0722);

fn luma(v: Vec3) -> f32 {
    v.dot(LUMA)
}

// ---------------------------------------------------------------------------
// Cloud decks
// ---------------------------------------------------------------------------

/// Geometry and optics of the uniform cloud slab, by deck type.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CloudDeck {
    /// No deck at all.
    None,
    /// Fair-weather cumulus: high base, deep, moderate optical depth.
    Cumulus,
    /// Stratus/stratocumulus sheet: low base, thick, high optical depth.
    Stratus,
    /// Rain-bearing nimbostratus: lowest base, deepest, highest optical depth.
    Nimbostratus,
}

impl CloudDeck {
    /// `(base altitude m, top altitude m, vertical optical depth at full
    /// coverage, Henyey-Greenstein asymmetry)`.
    fn geometry(self) -> Option<(f32, f32, f32, f32)> {
        match self {
            CloudDeck::None => None,
            CloudDeck::Cumulus => Some((1_000.0, 2_400.0, 12.0, 0.80)),
            CloudDeck::Stratus => Some((600.0, 1_600.0, 24.0, 0.85)),
            CloudDeck::Nimbostratus => Some((400.0, 2_000.0, 40.0, 0.87)),
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            CloudDeck::None => "none",
            CloudDeck::Cumulus => "cumulus",
            CloudDeck::Stratus => "stratus",
            CloudDeck::Nimbostratus => "nimbostratus",
        }
    }
}

// ---------------------------------------------------------------------------
// Authored physical inputs
// ---------------------------------------------------------------------------

/// The physical state of the atmosphere for one shot.
///
/// Every field is a real atmospheric quantity. Nothing here is a brightness
/// multiplier; the lab's normalized sun/ambient knobs are calibration gain
/// overrides applied *after* this model resolves, and default to 1.0.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct AtmosphereInputs {
    /// Sun elevation above the horizon, degrees.
    pub sun_elevation_deg: f32,
    /// Linke turbidity of the tropospheric aerosol column. 1.9 is a
    /// Rayleigh-only atmosphere, ~2.5 a typical clear day, 4-6 hazy,
    /// 8+ heavily polluted.
    pub turbidity: f32,
    /// Total column ozone, Dobson units. Mid-latitude annual mean ~300;
    /// 220 is an ozone hole, 450 a spring maximum. Drives the blue of the
    /// twilight sky far more than anything else in the model.
    pub ozone_du: f32,
    /// Multiplier on Rayleigh density, i.e. on surface air density. 1.0 is
    /// standard sea-level; 0.85 approximates 1500 m elevation.
    pub air_density: f32,
    /// Meteorological visibility, m (Koschmieder). Drives the
    /// boundary-layer aerosol/fog term.
    pub visibility_m: f32,
    /// Cloud deck type for the CPU energy closure (diffuse illuminance and
    /// exposure). The visible deck is the volumetric field drawn by
    /// `crate::sky_pass`; this slab never enters the GPU medium.
    pub deck: CloudDeck,
    /// Fractional cloud cover in [0, 1]. Scales the slab's vertical optical
    /// depth as `coverage^1.5`.
    pub cloud_cover: f32,
    /// Base altitude of the volumetric deck, m. Sets where the beam
    /// reaching the cloud tops is evaluated for `deck_sun_transmittance`.
    pub cloud_base_m: f32,
    /// Beam transmittance through the clouds along the sun ray, solved by
    /// the volumetric field at the observer. `None` falls back to the
    /// uniform slab's slant transmittance.
    pub cloud_beam_transmittance: Option<f32>,
    /// Ground albedo for the multiple-scattering LUT.
    pub ground_albedo: f32,
    /// Camera for the view-dependent sky probe (`ViewSky`). `None` skips it.
    pub meter_view: Option<MeterView>,
}

/// The camera the exposure meter reads the sky through.
///
/// World frame is the sun's (+X east, +Y up, +Z north). `forward` is where
/// the camera looks; the field is `fov_y_deg` tall and `fov_y_deg * aspect`
/// wide in tangent space.
#[derive(Clone, Copy, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct MeterView {
    pub forward: [f32; 3],
    pub fov_y_deg: f32,
    pub aspect: f32,
}

/// Sky luminance inside a [`MeterView`], cd/m^2.
#[derive(Clone, Copy, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct ViewSky {
    /// Brightest clear-sky patch in the field, including the solar aureole
    /// when the sun is framed (the disc itself is excluded).
    pub max_cdm2: f32,
    /// Mean over the sky patches in the field.
    pub mean_cdm2: f32,
    /// How much of the field is sky, [0, 1].
    pub sky_fraction: f32,
    /// Frustum membership of the sun, [0, 1]: 1 inside 80 % of the
    /// half-field, 0 beyond 125 %, so a pan onto the sun ramps the meter.
    pub sun_in_field: f32,
}

impl Default for AtmosphereInputs {
    fn default() -> Self {
        Self {
            sun_elevation_deg: 60.0,
            turbidity: 2.5,
            ozone_du: REFERENCE_OZONE_DU,
            air_density: 1.0,
            visibility_m: 30_000.0,
            deck: CloudDeck::None,
            cloud_cover: 0.0,
            cloud_base_m: 1_100.0,
            cloud_beam_transmittance: None,
            ground_albedo: GROUND_ALBEDO,
            meter_view: None,
        }
    }
}

impl AtmosphereInputs {
    fn sanitised(&self) -> Self {
        Self {
            sun_elevation_deg: self.sun_elevation_deg.clamp(-90.0, 90.0),
            turbidity: self.turbidity.clamp(1.9, 12.0),
            ozone_du: self.ozone_du.clamp(0.0, 600.0),
            air_density: self.air_density.clamp(0.2, 2.0),
            visibility_m: if self.visibility_m.is_finite() {
                self.visibility_m.clamp(20.0, 1.0e6)
            } else {
                VISIBILITY_UNLIMITED_M
            },
            deck: self.deck,
            cloud_cover: self.cloud_cover.clamp(0.0, 1.0),
            cloud_base_m: self.cloud_base_m.clamp(0.0, 20_000.0),
            cloud_beam_transmittance: self.cloud_beam_transmittance.map(|t| t.clamp(0.0, 1.0)),
            ground_albedo: self.ground_albedo.clamp(0.0, 1.0),
            meter_view: self.meter_view.filter(|v| {
                Vec3::from_array(v.forward).length_squared() > 1.0e-6
                    && v.fov_y_deg.is_finite()
                    && v.aspect.is_finite()
            }),
        }
    }

    /// Turbidity expressed as a multiplier on the paper's Mie coefficients.
    /// `T_L = 1.9` -> 0 (Rayleigh-only), `T_L = 2.5` -> 1 (the paper's value).
    fn aerosol_multiplier(&self) -> f32 {
        ((self.turbidity - 1.9) / 0.6).max(0.0)
    }

    /// Scale height of the boundary-layer term, m. Dense fog is shallow;
    /// clear-air haze fills the mixed layer.
    fn fog_scale_height_m(&self) -> f32 {
        let t = ((self.visibility_m - 500.0) / (10_000.0 - 500.0)).clamp(0.0, 1.0);
        FOG_SCALE_HEIGHT_DENSE_M + t * (FOG_SCALE_HEIGHT_CLEAR_M - FOG_SCALE_HEIGHT_DENSE_M)
    }

    /// Henyey-Greenstein asymmetry of the boundary-layer term. Fog droplets
    /// are large and strongly forward-scattering; dry haze less so.
    fn fog_asymmetry(&self) -> f32 {
        let t = ((self.visibility_m - 300.0) / (5_000.0 - 300.0)).clamp(0.0, 1.0);
        0.88 - t * 0.10
    }

    /// Ground extinction, m^-1, that the boundary-layer term must supply so
    /// that total extinction matches Koschmieder at the authored visibility.
    /// Returns `None` when the background atmosphere is already at least
    /// that extinctive.
    fn fog_ground_extinction(&self) -> Option<f32> {
        if self.visibility_m >= VISIBILITY_UNLIMITED_M {
            return None;
        }
        let target = KOSCHMIEDER / self.visibility_m;
        // Visibility is defined photometrically, so compare against the
        // luma-weighted background extinction at the ground.
        let background = luma(RAYLEIGH_SCATTERING * self.air_density)
            + MIE_EXTINCTION * self.aerosol_multiplier();
        let extra = target - background;
        (extra > 1.0e-9).then_some(extra)
    }

    /// Intrinsic vertical optical depth of the deck, before fractional
    /// cover is accounted for. Cover thickens the deck a little (a 95%-cover
    /// stratus sheet is deeper than a 30%-cover one), but the big effect of
    /// cover is handled by [`Self::cloud_optical_depth`].
    fn cloud_intrinsic_optical_depth(&self) -> f32 {
        match self.deck.geometry() {
            Some((_, _, tau_max, _)) => tau_max * (0.35 + 0.65 * self.cloud_cover),
            None => 0.0,
        }
    }

    /// Vertical optical depth actually put into the medium.
    ///
    /// A horizontally uniform slab cannot express broken cover: at 45% cover
    /// the beam either misses the deck entirely (55% of the time, at full
    /// strength) or crosses its full optical depth. Putting `cover * tau`
    /// into the slab would instead attenuate the beam everywhere by
    /// `exp(-0.45 * tau)`, which for a cumulus deck is a factor of 1e-3 —
    /// broken cumulus rendered as thin overcast.
    ///
    /// So the slab carries the *independent-column effective* optical depth:
    /// the depth whose uniform transmittance equals the cover-weighted mean
    /// of the clear and cloudy columns,
    ///
    /// ```text
    /// T_mean  = p_hole + (1 - p_hole) * exp(-tau / mu)
    /// tau_eff = -mu * ln(T_mean)
    /// ```
    ///
    /// with the probability of the sun sitting in a hole falling linearly to
    /// zero at [`OVERCAST_COVER`]. That reproduces both limits exactly: at
    /// 45% cover the beam keeps ~half its strength, and at or above 85%
    /// cover the deck is continuous and `tau_eff == tau`.
    ///
    /// This is a closure, not first principles, and it makes the medium
    /// depend on sun elevation. Both are stated in the readback.
    fn cloud_optical_depth(&self) -> f32 {
        let tau = self.cloud_intrinsic_optical_depth();
        if tau <= 0.0 {
            return 0.0;
        }
        let hole = (1.0 - self.cloud_cover / OVERCAST_COVER).clamp(0.0, 1.0);
        if hole <= 0.0 {
            return tau;
        }
        let mu = self.sun_elevation_deg.to_radians().sin().clamp(0.05, 1.0);
        let mean_t = hole + (1.0 - hole) * (-tau / mu).exp();
        if mean_t <= 0.0 {
            return tau;
        }
        (-mu * mean_t.ln()).clamp(0.0, tau)
    }
}

// ---------------------------------------------------------------------------
// Medium construction
// ---------------------------------------------------------------------------

/// A smooth-shouldered slab between two altitudes, in falloff-parameter
/// space. Peak 1.0 across the interior, cosine shoulders over the outer
/// 15% of the thickness so the density LUT has no step to alias on.
fn slab_falloff(base_m: f32, top_m: f32) -> Falloff {
    let p_top = 1.0 - (top_m / ATMOSPHERE_HEIGHT_M);
    let p_base = 1.0 - (base_m / ATMOSPHERE_HEIGHT_M);
    let shoulder = ((p_base - p_top) * 0.15).max(1.0e-5);
    Falloff::from_curve(FunctionCurve::new(Interval::UNIT, move |p: f32| {
        if p <= p_top || p >= p_base {
            return 0.0;
        }
        let rise = ((p - p_top) / shoulder).clamp(0.0, 1.0);
        let fall = ((p_base - p) / shoulder).clamp(0.0, 1.0);
        let smooth = |x: f32| x * x * (3.0 - 2.0 * x);
        smooth(rise) * smooth(fall)
    }))
}

/// The paper's three Earth terms, with the paper's coefficients and the
/// correct 100 km falloff normalisation, scaled by the authored state.
///
/// These are the terms the GPU medium is built from: Rayleigh, tropospheric
/// aerosol, ozone, then optionally boundary-layer haze/fog. The cloud deck
/// is *not* here — clouds are drawn by the volumetric field in
/// `crate::sky_pass`, which composites over this sky, attenuates the solar
/// disc through its own optical depth and shadows the ground through the
/// sun's light texture. Putting a slab in the medium as well would darken
/// the Rayleigh sky seen through every gap and double-count the beam.
pub fn earth_terms(inputs: &AtmosphereInputs) -> Vec<ScatteringTerm> {
    let inputs = inputs.sanitised();
    let aerosol = inputs.aerosol_multiplier();

    let mut terms = Vec::with_capacity(5);

    // 1. Rayleigh: molecular, no absorption, wavelength-dependent.
    terms.push(ScatteringTerm {
        absorption: Vec3::ZERO,
        scattering: RAYLEIGH_SCATTERING * inputs.air_density,
        falloff: Falloff::Exponential {
            scale: RAYLEIGH_SCALE_HEIGHT_M / ATMOSPHERE_HEIGHT_M,
        },
        phase: PhaseFunction::Rayleigh,
    });

    // 2. Tropospheric aerosol: grey Mie, albedo 0.908, g = 0.8.
    if aerosol > 0.0 {
        terms.push(ScatteringTerm {
            absorption: Vec3::splat((MIE_EXTINCTION - MIE_SCATTERING) * aerosol),
            scattering: Vec3::splat(MIE_SCATTERING * aerosol),
            falloff: Falloff::Exponential {
                scale: MIE_SCALE_HEIGHT_M / ATMOSPHERE_HEIGHT_M,
            },
            phase: PhaseFunction::Mie {
                asymmetry: MIE_ASYMMETRY,
            },
        });
    }

    // 3. Ozone: pure absorption in a tent around 25 km.
    let ozone = inputs.ozone_du / REFERENCE_OZONE_DU;
    if ozone > 0.0 {
        terms.push(ScatteringTerm {
            absorption: OZONE_ABSORPTION * ozone,
            scattering: Vec3::ZERO,
            falloff: Falloff::Tent {
                center: 1.0 - OZONE_CENTER_M / ATMOSPHERE_HEIGHT_M,
                width: OZONE_WIDTH_M / ATMOSPHERE_HEIGHT_M,
            },
            phase: PhaseFunction::Isotropic,
        });
    }

    // 4. Boundary-layer haze/fog: grey Mie sized by Koschmieder.
    if let Some(beta_ext) = inputs.fog_ground_extinction() {
        // Water/aerosol droplets barely absorb in the visible.
        const FOG_ALBEDO: f32 = 0.985;
        terms.push(ScatteringTerm {
            absorption: Vec3::splat(beta_ext * (1.0 - FOG_ALBEDO)),
            scattering: Vec3::splat(beta_ext * FOG_ALBEDO),
            falloff: Falloff::Exponential {
                scale: inputs.fog_scale_height_m() / ATMOSPHERE_HEIGHT_M,
            },
            phase: PhaseFunction::Mie {
                asymmetry: inputs.fog_asymmetry(),
            },
        });
    }
    terms
}

/// [`earth_terms`] plus the uniform cloud slab, for the CPU energy closure
/// only: the two-stream diffuse illuminance and the exposure meter need the
/// deck's optical depth, and a horizontally uniform slab is the right
/// object for a column integral even though it is the wrong object to draw.
pub fn column_terms(inputs: &AtmosphereInputs) -> Vec<ScatteringTerm> {
    let inputs = inputs.sanitised();
    let mut terms = earth_terms(&inputs);
    if let Some((base, top, _, g)) = inputs.deck.geometry() {
        let tau = inputs.cloud_optical_depth();
        if tau > 1.0e-3 {
            // `slab_falloff` peaks at 1.0 over the interior, so beta * (top -
            // base) is the vertical optical depth to within the shoulders.
            let beta_ext = tau / (top - base);
            const CLOUD_ALBEDO: f32 = 0.9999;
            // Under broken cover the slab is the *mean* of cloudy and clear
            // columns, so its phase function has to be that mean too.
            let covered = (inputs.cloud_cover / OVERCAST_COVER).clamp(0.0, 1.0);
            terms.push(ScatteringTerm {
                absorption: Vec3::splat(beta_ext * (1.0 - CLOUD_ALBEDO)),
                scattering: Vec3::splat(beta_ext * CLOUD_ALBEDO),
                falloff: slab_falloff(base, top),
                phase: PhaseFunction::Mie {
                    asymmetry: g * covered,
                },
            });
        }
    }
    terms
}

/// Build the [`ScatteringMedium`] asset for an authored state.
pub fn medium(inputs: &AtmosphereInputs) -> ScatteringMedium {
    ScatteringMedium::new(
        MEDIUM_LUT_RESOLUTION,
        MEDIUM_LUT_RESOLUTION,
        earth_terms(inputs),
    )
    .with_label("simforge_earth_atmosphere")
}

/// The [`Atmosphere`] component for an authored state.
pub fn atmosphere(inputs: &AtmosphereInputs, medium: Handle<ScatteringMedium>) -> Atmosphere {
    Atmosphere {
        inner_radius: INNER_RADIUS_M,
        outer_radius: OUTER_RADIUS_M,
        ground_albedo: Vec3::splat(inputs.sanitised().ground_albedo),
        medium,
    }
}

/// Per-camera LUT sizing and sample counts.
///
/// Sizes stay at the paper's / Bevy's defaults except the aerial-perspective
/// volume, whose 32 slices are fitted to the camera's far plane instead of
/// the 32 km default. In this scene the far plane is 900 m, which puts a
/// slice every ~28 m and makes dense fog resolve properly — at the 32 km
/// default all of the scene's geometry would fall inside the first slice.
pub fn settings(far_plane_m: f32) -> AtmosphereSettings {
    AtmosphereSettings {
        transmittance_lut_size: UVec2::new(256, 128),
        transmittance_lut_samples: 40,
        multiscattering_lut_size: UVec2::new(32, 32),
        multiscattering_lut_dirs: 64,
        multiscattering_lut_samples: 20,
        sky_view_lut_size: UVec2::new(400, 200),
        sky_view_lut_samples: 24,
        aerial_view_lut_size: UVec3::new(32, 32, 32),
        aerial_view_lut_samples: 12,
        aerial_view_lut_max_distance: (far_plane_m * 1.05).clamp(200.0, 3.2e4),
        sky_max_samples: 16,
        rendering_method: AtmosphereMode::LookupTexture,
    }
}

/// The IBL probe driven by the sky-view LUT. `intensity` is a calibration
/// gain override; 1.0 means "use the resolved sky as-is".
pub fn environment_light(intensity: f32, size: u32) -> AtmosphereEnvironmentMapLight {
    AtmosphereEnvironmentMapLight {
        intensity: intensity.max(0.0),
        affects_lightmapped_mesh_diffuse: true,
        size: UVec2::splat(size),
    }
}

// ---------------------------------------------------------------------------
// CPU reference solve (status readback + exposure)
// ---------------------------------------------------------------------------

/// Everything the model resolved, for the lab's Atmosphere status panel and
/// for deriving camera exposure.
///
/// All radiometric quantities are photometric: illuminance in lx, luminance
/// in cd/m^2. RGB triples are linear sRGB.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct AtmosphereReadback {
    /// Sun elevation / azimuth actually used, degrees.
    pub sun_elevation_deg: f32,
    pub sun_azimuth_deg: f32,
    /// Unit vector towards the sun in world space (+X east, +Y up, +Z north).
    pub sun_direction: [f32; 3],
    /// Whether any part of the solar disc is above the geometric horizon.
    pub sun_above_horizon: bool,
    /// Kasten-Young relative optical air mass along the sun ray.
    pub air_mass: f32,
    /// Per-channel atmospheric transmittance along the sun ray, ground to
    /// space, from the same medium the GPU LUT integrates.
    pub sun_transmittance: [f32; 3],
    /// Photometric transmittance along the sun ray (CIE Y weighted).
    pub sun_transmittance_luma: f32,
    /// Direct normal illuminance at the ground, lx: `E_ext * T`.
    pub direct_normal_illuminance_lx: f32,
    /// Direct horizontal illuminance, lx: `E_dn * sin(h)`.
    pub direct_horizontal_illuminance_lx: f32,
    /// Diffuse (sky) horizontal illuminance, lx, from a two-stream solve on
    /// the resolved column.
    pub diffuse_horizontal_illuminance_lx: f32,
    /// Total horizontal illuminance, lx.
    pub total_horizontal_illuminance_lx: f32,
    /// Linear-sRGB chromaticity of the transmitted beam, normalised to
    /// max = 1. This is the sun's colour, and it is *derived*, not authored.
    pub sun_color: [f32; 3],
    /// Correlated colour temperature of `sun_color`, K.
    pub sun_cct_k: f32,
    /// Zenith sky luminance, cd/m^2 (single scattering plus the paper's
    /// geometric multiple-scattering series).
    pub zenith_luminance_cdm2: f32,
    /// Sky luminance 10 deg above the horizon, away from the sun, cd/m^2.
    pub horizon_luminance_cdm2: f32,
    /// Sky luminance in the metering camera's field, when one was given.
    #[serde(default)]
    pub view_sky: Option<ViewSky>,
    /// Peak luminance of the solar disc as composited, cd/m^2.
    pub solar_disc_luminance_cdm2: f32,
    /// Solid angle of the composited disc, sr.
    pub solar_disc_solid_angle_sr: f32,
    /// Vertical scattering / absorption optical depth of the whole column
    /// (photometric).
    pub column_scattering_optical_depth: f32,
    pub column_absorption_optical_depth: f32,
    /// Meteorological visibility the resolved medium actually delivers, m.
    pub effective_visibility_m: f32,
    /// Ground extinction coefficient, m^-1 (photometric).
    pub ground_extinction_per_m: f32,
    /// Vertical optical depth of the cloud deck actually put into the medium
    /// (independent-column effective depth for the authored cover), the
    /// deck's intrinsic depth, and its type.
    pub cloud_optical_depth: f32,
    pub cloud_intrinsic_optical_depth: f32,
    pub cloud_deck: String,
    /// Beam transmittance through the clouds along the sun ray, as applied
    /// to the direct illuminance: the volumetric field's value when the
    /// caller supplied one, otherwise the uniform slab's slant value.
    pub cloud_beam_transmittance: f32,
    /// Where `cloud_beam_transmittance` came from.
    pub cloud_beam_source: String,
    /// Whether the deck is continuous at this cover, i.e. whether the sun
    /// can still be seen through a hole.
    pub cloud_continuous: bool,
    /// Diffuse horizontal illuminance with the deck over the same column
    /// without it. The atmosphere IBL is filtered from a deck-free sky, so
    /// this is the gain that puts the deck's re-radiated light back into
    /// the ambient term.
    pub deck_diffuse_gain: f32,
    /// Per-channel air transmittance from the deck base to space along the
    /// sun ray: the beam that lights the cloud tops.
    pub deck_sun_transmittance: [f32; 3],
    /// Zenith sky radiance per channel, cd/m^2 (the light on the cloud tops).
    pub zenith_radiance: [f32; 3],
    /// Extinction at the ground (m^-1, photometric) and scale height (m) of
    /// the Rayleigh term and of the combined aerosol/fog terms, for the
    /// slant-path aerial perspective on the cloud deck.
    pub aerial_rayleigh: [f32; 2],
    pub aerial_aerosol: [f32; 2],

    // ------------------------------------------------------------ night
    /// Legacy atmosphere-only lunar fields. The authoritative topocentric
    /// phase/lux state lives in `ResolvedLighting::night_environment`; these
    /// remain zero so the atmosphere meter cannot double-count moonlight.
    #[serde(skip_serializing)]
    pub moon_elevation_deg: f32,
    #[serde(skip_serializing)]
    pub moon_azimuth_deg: f32,
    #[serde(skip_serializing)]
    pub moon_direct_normal_illuminance_lx: f32,
    #[serde(skip_serializing)]
    pub moon_horizontal_illuminance_lx: f32,
    /// Natural moonless integrated night-sky energy closure, lx.
    pub night_floor_lx: f32,
    /// Camera EV100 derived from `total_horizontal_illuminance_lx`.
    pub ev100: f32,
    /// Number of scattering terms in the medium.
    pub medium_terms: usize,
    /// Authored inputs, echoed so the UI can show what physics it asked for.
    pub turbidity: f32,
    pub ozone_du: f32,
    pub air_density: f32,
    pub cloud_cover: f32,
    /// LUT geometry actually configured.
    pub lut_transmittance: [u32; 2],
    pub lut_multiscattering: [u32; 2],
    pub lut_sky_view: [u32; 2],
    pub lut_aerial_view: [u32; 3],
    pub lut_aerial_max_distance_m: f32,
    pub lut_medium_resolution: u32,
    /// Wall time spent building the medium's density/phase LUTs on the CPU,
    /// ms. The GPU LUT chain is rebuilt every frame by the render graph and
    /// is measured separately (see `sky-bench`).
    pub medium_build_ms: f32,
}

/// Sample the summed absorption/scattering density of a term list at an
/// altitude, m^-1 per channel.
fn density_at(terms: &[ScatteringTerm], altitude_m: f32) -> (Vec3, Vec3) {
    let p = 1.0 - (altitude_m / ATMOSPHERE_HEIGHT_M).clamp(0.0, 1.0);
    let mut absorption = Vec3::ZERO;
    let mut scattering = Vec3::ZERO;
    for term in terms {
        let f = term.falloff.sample(p);
        absorption += term.absorption * f;
        scattering += term.scattering * f;
    }
    (absorption, scattering)
}

/// Distance from a point at radius `r` along a ray with zenith cosine `mu`
/// to the top of the atmosphere, m.
fn distance_to_top(r: f32, mu: f32) -> f32 {
    let disc = (r * r * (mu * mu - 1.0) + OUTER_RADIUS_M * OUTER_RADIUS_M).max(0.0);
    (-r * mu + disc.sqrt()).max(0.0)
}

/// Whether a ray from radius `r` with zenith cosine `mu` hits the planet.
fn intersects_ground(r: f32, mu: f32) -> bool {
    mu < 0.0 && (r * r * (mu * mu - 1.0) + INNER_RADIUS_M * INNER_RADIUS_M) >= 0.0
}

/// Per-channel transmittance from an altitude along a ray to the top of the
/// atmosphere. Same integral as `transmittance_lut.wgsl`, marched on the CPU
/// with the same [`Falloff`] and [`PhaseFunction`] implementations the GPU
/// LUT builder uses, so the numbers in the status panel are the numbers the
/// shader sees (to within step count).
fn transmittance_to_space(terms: &[ScatteringTerm], altitude_m: f32, mu: f32) -> Vec3 {
    transmittance_to_space_n(terms, altitude_m, mu, 256)
}

/// [`transmittance_to_space`] at a chosen step count.
fn transmittance_to_space_n(
    terms: &[ScatteringTerm],
    altitude_m: f32,
    mu: f32,
    steps: usize,
) -> Vec3 {
    let r = INNER_RADIUS_M + altitude_m;
    if intersects_ground(r, mu) {
        return Vec3::ZERO;
    }
    let t_max = distance_to_top(r, mu);
    if t_max <= 0.0 {
        return Vec3::ONE;
    }
    let dt = t_max / steps as f32;
    let mut optical_depth = Vec3::ZERO;
    for i in 0..steps {
        let t = (i as f32 + 0.5) * dt;
        // Law of cosines in the spherical shell.
        let r_i = (r * r + t * t + 2.0 * r * t * mu).max(INNER_RADIUS_M * INNER_RADIUS_M).sqrt();
        let (absorption, scattering) = density_at(terms, r_i - INNER_RADIUS_M);
        optical_depth += (absorption + scattering) * dt;
    }
    Vec3::new(
        (-optical_depth.x).exp(),
        (-optical_depth.y).exp(),
        (-optical_depth.z).exp(),
    )
}

/// Vertical column optical depth split into scattering and absorption, the
/// scattering-weighted mean asymmetry, and the scattering-weighted fraction
/// of first-order scattering that continues into the forward (downward)
/// hemisphere, `(1 + g) / 2` per term.
fn column_optical_depth(terms: &[ScatteringTerm]) -> ColumnSolve {
    const STEPS: usize = 2048;
    let dh = ATMOSPHERE_HEIGHT_M / STEPS as f32;
    let mut scattering = Vec3::ZERO;
    let mut absorption = Vec3::ZERO;
    let mut g_weighted = 0.0;
    let mut g_weight = 0.0;
    for i in 0..STEPS {
        let h = (i as f32 + 0.5) * dh;
        let p = 1.0 - h / ATMOSPHERE_HEIGHT_M;
        for term in terms {
            let f = term.falloff.sample(p);
            let s = term.scattering * f;
            scattering += s * dh;
            absorption += term.absorption * f * dh;
            let w = luma(s) * dh;
            g_weighted += w * term_asymmetry(term);
            g_weight += w;
        }
    }
    let asymmetry = if g_weight > 0.0 {
        g_weighted / g_weight
    } else {
        0.0
    };
    ColumnSolve {
        scattering,
        absorption,
        asymmetry,
        forward_fraction: (1.0 + asymmetry) * 0.5,
    }
}

/// Result of [`column_optical_depth`].
#[derive(Clone, Copy, Debug)]
struct ColumnSolve {
    /// Vertical scattering optical depth, per channel.
    scattering: Vec3,
    /// Vertical absorption optical depth, per channel.
    absorption: Vec3,
    /// Scattering-weighted Henyey-Greenstein asymmetry of the column.
    asymmetry: f32,
    /// Fraction of first-order scattering that stays in the forward
    /// (downward, for a descending beam) hemisphere. Rayleigh is symmetric
    /// at 0.5; a cloud deck at g = 0.85 keeps 0.93 of it heading down.
    forward_fraction: f32,
}

fn term_asymmetry(term: &ScatteringTerm) -> f32 {
    match term.phase {
        PhaseFunction::Mie { asymmetry } => asymmetry,
        _ => 0.0,
    }
}

/// Beam transmittance contributed by a single term along a slant path.
fn term_slant_transmittance(term: &ScatteringTerm, mu: f32) -> f32 {
    const STEPS: usize = 512;
    let dh = ATMOSPHERE_HEIGHT_M / STEPS as f32;
    let mut tau = 0.0;
    for i in 0..STEPS {
        let h = (i as f32 + 0.5) * dh;
        let p = 1.0 - h / ATMOSPHERE_HEIGHT_M;
        let f = term.falloff.sample(p);
        tau += luma(term.absorption + term.scattering) * f * dh;
    }
    let mu = mu.max(0.02);
    (-tau / mu).exp()
}

/// Exact single-scattered luminance along a view ray from the ground.
///
/// `view_mu` is the cosine of the view ray's zenith angle, `sun_mu` the
/// sun's, and `cos_scatter` the cosine of the angle between them (the
/// `neg_LdotV` the GPU scattering LUT is indexed by). Returns cd/m^2 per
/// channel for an extraterrestrial illuminance of `sun_illuminance_lx`.
///
/// Single scattering only, on purpose. Multiple scattering is *not* folded
/// in here as a per-sample gain on the direct beam, because that gain would
/// be multiplied by the local beam transmittance and would therefore vanish
/// exactly where multiple scattering dominates: inside fog and under a cloud
/// deck, the beam is extinguished but the medium is brilliantly lit by the
/// diffuse field. (The GPU has the same structure and dodges it the same
/// way: `sample_local_inscattering` multiplies the single-scattering term by
/// `shadow_factor` but adds `psi_ms` from the multiple-scattering LUT
/// *ungated*.) The diffuse part is added analytically by
/// [`diffuse_sky_luminance`].
fn single_scattered_radiance(
    terms: &[ScatteringTerm],
    view_mu: f32,
    cos_scatter: f32,
    sun_mu: f32,
    sun_illuminance_lx: f32,
) -> Vec3 {
    single_scattered_radiance_n(terms, view_mu, cos_scatter, sun_mu, sun_illuminance_lx, 384, 256)
}

/// [`single_scattered_radiance`] at chosen step counts along the view ray
/// and along each sun ray. The reference probes use (384, 256); the
/// metering grid, which evaluates dozens of directions per relight, uses a
/// coarser pair that agrees to a few percent.
fn single_scattered_radiance_n(
    terms: &[ScatteringTerm],
    view_mu: f32,
    cos_scatter: f32,
    sun_mu: f32,
    sun_illuminance_lx: f32,
    view_steps: usize,
    sun_steps: usize,
) -> Vec3 {
    // Quadratic step spacing. A uniform march cannot resolve this medium:
    // the boundary-layer fog term has a 300 m scale height and the cloud
    // slab is ~1 km thick, while the zenith ray is 100 km long and a
    // 10-degree ray is ~480 km. Concentrating samples near the camera puts
    // sub-metre steps at the ground and ~50 m steps through the layers that
    // matter.
    let steps = view_steps.max(8);
    let r0 = INNER_RADIUS_M;
    let t_max = distance_to_top(r0, view_mu);
    if t_max <= 0.0 || sun_illuminance_lx <= 0.0 {
        return Vec3::ZERO;
    }
    let mut radiance = Vec3::ZERO;
    let mut transmittance = Vec3::ONE;

    let mut t_prev = 0.0f32;
    for i in 1..=steps {
        let frac = i as f32 / steps as f32;
        let t_next = t_max * frac * frac;
        let dt = t_next - t_prev;
        let t = t_prev + dt * 0.5;
        t_prev = t_next;
        if dt <= 0.0 {
            continue;
        }

        // Law of cosines in the spherical shell.
        let r_i = (r0 * r0 + t * t + 2.0 * r0 * t * view_mu)
            .max(INNER_RADIUS_M * INNER_RADIUS_M)
            .sqrt();
        let altitude = r_i - INNER_RADIUS_M;
        let p = 1.0 - (altitude / ATMOSPHERE_HEIGHT_M).clamp(0.0, 1.0);
        let (absorption, scattering) = density_at(terms, altitude);
        let extinction = absorption + scattering;
        let step_t = Vec3::new(
            (-extinction.x * dt).exp(),
            (-extinction.y * dt).exp(),
            (-extinction.z * dt).exp(),
        );

        // Zenith cosine of the sun ray at the sample point. With the origin
        // at r0 * up and the ray direction V, the sample sits at
        // P = r0*up + t*V, so mu_light = (S.P)/|P| = (r0*sun_mu +
        // t*(S.V)) / r_i. Not clamped to >= 0: a sample high in the
        // atmosphere can still see a sun that is below the *observer's*
        // horizon, which is exactly what makes twilight, and
        // `transmittance_to_space` returns zero once the ray does hit the
        // planet.
        let mu_light = ((sun_mu * r0 + t * cos_scatter) / r_i).clamp(-1.0, 1.0);
        let sun_t = transmittance_to_space_n(terms, altitude, mu_light, sun_steps);
        if luma(sun_t) > 0.0 {
            // Phase-weighted scattering coefficient, exactly as the GPU
            // scattering LUT stores it: sum over terms of beta_s * phase.
            let mut phase_scattering = Vec3::ZERO;
            for term in terms {
                let f = term.falloff.sample(p);
                if f <= 0.0 {
                    continue;
                }
                if let Some(ph) = term.phase.sample(cos_scatter) {
                    phase_scattering += term.scattering * f * ph.to_vec3();
                }
            }
            radiance += transmittance * sun_illuminance_lx * phase_scattering * sun_t * dt;
        }

        transmittance *= step_t;
        if luma(transmittance) < 1.0e-5 {
            break;
        }
    }
    radiance
}

/// Sky luminance the camera actually frames.
///
/// A 9 x 5 grid of directions across the field, each above the horizon
/// scored by the same single-scatter + diffuse model as the zenith and
/// horizon probes, plus the solar aureole (0.6 deg off the disc centre,
/// i.e. the sky just outside the disc) when the sun is framed. The aureole
/// is what a sunward sunset clips on, and it is far narrower than the grid,
/// so it is sampled explicitly and faded by frustum membership rather than
/// switched.
fn view_sky_luminance(
    terms: &[ScatteringTerm],
    view: &MeterView,
    sun_dir: Vec3,
    sun_mu: f32,
    diffuse_budget_lx: f32,
    floor_luminance: f32,
) -> ViewSky {
    const COLS: usize = 9;
    const ROWS: usize = 5;
    const VIEW_STEPS: usize = 96;
    const SUN_STEPS: usize = 48;
    const HORIZON_MU: f32 = 0.015;

    let forward = Vec3::from_array(view.forward).normalize();
    let right = forward.cross(Vec3::Y);
    let right = if right.length_squared() < 1.0e-6 {
        Vec3::X
    } else {
        right.normalize()
    };
    let up = right.cross(forward).normalize();
    let tan_y = (view.fov_y_deg.clamp(5.0, 170.0) * 0.5).to_radians().tan();
    let tan_x = tan_y * view.aspect.clamp(0.1, 10.0);

    let radiance = |dir: Vec3, cos_scatter: f32| -> f32 {
        let single = single_scattered_radiance_n(
            terms,
            dir.y,
            cos_scatter,
            sun_mu,
            SOLAR_CONSTANT_LX,
            VIEW_STEPS,
            SUN_STEPS,
        );
        let tau = scattering_optical_depth_along_n(terms, dir.y, VIEW_STEPS);
        luma(single) + diffuse_sky_luminance(diffuse_budget_lx, tau) + floor_luminance
    };

    let mut max = 0.0f32;
    let mut sum = 0.0f32;
    let mut sky = 0usize;
    for j in 0..ROWS {
        for i in 0..COLS {
            let x = ((i as f32 + 0.5) / COLS as f32) * 2.0 - 1.0;
            let y = ((j as f32 + 0.5) / ROWS as f32) * 2.0 - 1.0;
            let dir = (forward + right * (x * tan_x) + up * (y * tan_y)).normalize();
            if dir.y <= HORIZON_MU {
                continue;
            }
            let l = radiance(dir, dir.dot(sun_dir));
            max = max.max(l);
            sum += l;
            sky += 1;
        }
    }

    // Sun membership in tangent space: 1 inside 80 % of the half-field,
    // 0 beyond 125 %, linear between. A camera panning onto the sun then
    // ramps its exposure over ~12 deg of travel at a 55 deg field, the way
    // an auto-exposure with a time constant would, instead of stepping.
    let sun_in_field = if sun_mu > HORIZON_MU {
        let depth = sun_dir.dot(forward);
        if depth <= 1.0e-3 {
            0.0
        } else {
            let sx = (sun_dir.dot(right) / depth / tan_x).abs();
            let sy = (sun_dir.dot(up) / depth / tan_y).abs();
            let edge = |s: f32| ((1.25 - s) / 0.45).clamp(0.0, 1.0);
            edge(sx) * edge(sy)
        }
    } else {
        0.0
    };
    if sun_in_field > 0.0 {
        // The sky just outside the disc: rotate the sun direction by the
        // disc's angular radius plus a third of it, towards the zenith
        // (or the horizon when the sun is high).
        let off = (SUN_ANGULAR_DIAMETER_DEG * 0.5 * 1.35).to_radians();
        let axis = if sun_dir.y < 0.95 { Vec3::Y } else { Vec3::X };
        let tangent = (axis - sun_dir * sun_dir.dot(axis)).normalize();
        let dir = (sun_dir * off.cos() + tangent * off.sin()).normalize();
        let aureole = radiance(dir, dir.dot(sun_dir));
        max = max.max(aureole * sun_in_field);
    }

    ViewSky {
        max_cdm2: max,
        mean_cdm2: if sky > 0 { sum / sky as f32 } else { 0.0 },
        sky_fraction: sky as f32 / (COLS * ROWS) as f32,
        sun_in_field,
    }
}

/// Scattering optical depth along a view ray from the ground (photometric).
fn scattering_optical_depth_along(terms: &[ScatteringTerm], view_mu: f32) -> f32 {
    scattering_optical_depth_along_n(terms, view_mu, 384)
}

/// [`scattering_optical_depth_along`] at a chosen step count.
fn scattering_optical_depth_along_n(terms: &[ScatteringTerm], view_mu: f32, steps: usize) -> f32 {
    let r0 = INNER_RADIUS_M;
    let t_max = distance_to_top(r0, view_mu);
    if t_max <= 0.0 {
        return 0.0;
    }
    let mut tau = 0.0;
    let mut t_prev = 0.0f32;
    for i in 1..=steps {
        let frac = i as f32 / steps as f32;
        let t_next = t_max * frac * frac;
        let dt = t_next - t_prev;
        let t = t_prev + dt * 0.5;
        t_prev = t_next;
        let r_i = (r0 * r0 + t * t + 2.0 * r0 * t * view_mu)
            .max(INNER_RADIUS_M * INNER_RADIUS_M)
            .sqrt();
        let (_, scattering) = density_at(terms, r_i - INNER_RADIUS_M);
        tau += luma(scattering) * dt;
    }
    tau
}

/// Diffuse (multiply scattered) contribution to sky luminance along a view
/// ray, cd/m^2.
///
/// The diffuse field is taken as isotropic with downward irradiance
/// `diffuse_horizontal_lx` — which the two-stream column solve in
/// [`resolve`] already produced — so its radiance is `E / pi`, and the view
/// ray sees the fraction of it that its own scattering optical depth
/// intercepts, `1 - exp(-tau_s)`. That is exact in both limits: it vanishes
/// for a vacuum and saturates at `E / pi` inside fog or under a deck, where
/// the CIE uniform-overcast relation gives the same answer to ~25%.
fn diffuse_sky_luminance(diffuse_horizontal_lx: f32, tau_s_along_view: f32) -> f32 {
    diffuse_horizontal_lx / std::f32::consts::PI * (1.0 - (-tau_s_along_view).exp())
}

/// Kasten-Young (1989) relative optical air mass, finite at the horizon.
fn air_mass(elevation_deg: f32) -> f32 {
    let h = elevation_deg.max(-2.0);
    let denom = h.to_radians().sin() + 0.50572 * (h + 6.07995).max(1.0e-3).powf(-1.6364);
    if denom <= 1.0e-4 {
        return 40.0;
    }
    (1.0 / denom).clamp(1.0, 40.0)
}

/// Approximate correlated colour temperature of a linear-sRGB triple
/// (McCamy's cubic on CIE 1931 xy).
fn cct_k(rgb: Vec3) -> f32 {
    let x = 0.4124 * rgb.x + 0.3576 * rgb.y + 0.1805 * rgb.z;
    let y = 0.2126 * rgb.x + 0.7152 * rgb.y + 0.0722 * rgb.z;
    let z = 0.0193 * rgb.x + 0.1192 * rgb.y + 0.9505 * rgb.z;
    let sum = x + y + z;
    if sum <= 0.0 {
        return 0.0;
    }
    let cx = x / sum;
    let cy = y / sum;
    let n = (cx - 0.3320) / (0.1858 - cy);
    (449.0 * n * n * n + 3525.0 * n * n + 6823.3 * n + 5520.33).clamp(1000.0, 40000.0)
}

/// Resolve the full model: build the medium once, then read every number the
/// status panel and the exposure model need out of it.
pub fn resolve(
    inputs: &AtmosphereInputs,
    sun_azimuth_deg: f32,
    far_plane_m: f32,
) -> (ScatteringMedium, AtmosphereReadback) {
    let inputs = inputs.sanitised();
    let started = std::time::Instant::now();
    // The GPU medium is the deck-free air; the column closure adds the slab.
    let terms = earth_terms(&inputs);
    let column = column_terms(&inputs);
    let medium = ScatteringMedium::new(
        MEDIUM_LUT_RESOLUTION,
        MEDIUM_LUT_RESOLUTION,
        terms.clone(),
    )
    .with_label("simforge_earth_atmosphere");

    let elev = inputs.sun_elevation_deg;
    let elev_rad = elev.to_radians();
    let sun_mu = elev_rad.sin();
    let azim = sun_azimuth_deg.to_radians();
    let sun_dir = Vec3::new(
        elev_rad.cos() * azim.sin(),
        sun_mu,
        elev_rad.cos() * azim.cos(),
    )
    .normalize();

    // Direct beam. Below the horizon the disc is cut by
    // `calculate_visible_sun_ratio` on the GPU; mirror that here so the
    // readback and the render agree. The air transmittance is the beam's
    // colour; the cloud transmittance is grey and applied on top.
    let half_disc = (SUN_ANGULAR_DIAMETER_DEG * 0.5).to_radians();
    let visible_ratio = ((elev_rad + half_disc) / (2.0 * half_disc)).clamp(0.0, 1.0);
    let sun_up = sun_mu > -half_disc.sin();
    let sun_transmittance = if sun_up {
        transmittance_to_space(&terms, 0.0, sun_mu.max(0.0))
    } else {
        Vec3::ZERO
    };
    let deck_sun_transmittance = if sun_up {
        transmittance_to_space(&terms, inputs.cloud_base_m, sun_mu.max(0.0))
    } else {
        Vec3::ZERO
    };
    let slab = column.iter().rev().find(|t| matches!(t.falloff, Falloff::Curve(_)));
    let slab_beam_t = match slab {
        Some(term) => term_slant_transmittance(term, sun_mu.max(0.0)),
        None => 1.0,
    };
    let (cloud_beam_t, cloud_beam_source) = match inputs.cloud_beam_transmittance {
        Some(t) => (t, "volumetric field at the observer"),
        None => (slab_beam_t, "uniform slab slant path"),
    };
    let t_luma = luma(sun_transmittance) * visible_ratio * cloud_beam_t;
    let e_dn = SOLAR_CONSTANT_LX * t_luma;
    let e_dir_h = e_dn * sun_mu.max(0.0);
    // The meter reads the slab's *expected* beam, not the field's
    // instantaneous one: as clouds drift across the sun the volumetric
    // transmittance flickers between 0 and 1 from frame to frame, and an
    // exposure that followed it would pump. The scene keeps the true beam;
    // the camera adapts to the weather's mean.
    let e_dir_h_expected =
        SOLAR_CONSTANT_LX * luma(sun_transmittance) * visible_ratio * slab_beam_t * sun_mu.max(0.0);

    // Diffuse sky. Two-stream (Eddington) diffuse transmission of the
    // resolved column, driven by the beam it removes. Solved twice: with the
    // deck (the illuminance the scene actually receives) and without it (the
    // illuminance the deck-free GPU IBL delivers), whose ratio is the gain
    // that closes the two.
    let diffuse_for = |terms: &[ScatteringTerm]| -> f32 {
        let col = column_optical_depth(terms);
        let tau_s = luma(col.scattering);
        let tau_a = luma(col.absorption);
        let albedo = if tau_s + tau_a > 0.0 {
            tau_s / (tau_s + tau_a)
        } else {
            0.0
        };
        let mu = sun_mu.max(0.0);
        let t_diff = 1.0 / (1.0 + 0.75 * (1.0 - col.asymmetry) * tau_s);
        // Civil-through-nautical twilight skylight, from the standard
        // horizontal-illuminance curve for a clear sky: ~700 lx at sunset,
        // ~3 lx at the end of civil twilight (-6 deg), ~0.01 lx at -12 deg,
        // i.e. a factor 10 per 2.5 deg of solar depression. The column's
        // diffuse transmission modulates it; 0.85 is the clear-air value the
        // curve was measured under. Astronomical night is the declared floor
        // alone: the curve is cut off between -20 and -16 deg, where it is
        // below the airglow anyway.
        let astronomical = ((elev + 20.0) / 4.0).clamp(0.0, 1.0);
        let twilight_lx = 700.0
            * 10.0f32.powf(-0.4 * (-elev).max(0.0))
            * (t_diff / 0.85)
            * astronomical;
        if mu <= 0.0 {
            twilight_lx
        } else {
            // Beam energy removed by scattering, of which `forward_fraction`
            // continues downward on its first scatter and `t_diff` survives
            // the rest of the column. The twilight curve is the floor, so the
            // two branches meet at the horizon instead of stepping.
            let beam_t = luma(transmittance_to_space(terms, 0.0, mu));
            (SOLAR_CONSTANT_LX * mu * albedo * (1.0 - beam_t) * col.forward_fraction * t_diff)
                .max(twilight_lx)
        }
    };
    let e_diff_h = diffuse_for(&column);
    let e_diff_clear = diffuse_for(&terms);
    let deck_diffuse_gain = if e_diff_clear > 0.0 {
        (e_diff_h / e_diff_clear).clamp(0.25, 8.0)
    } else {
        1.0
    };
    let col = column_optical_depth(&column);
    let tau_s = luma(col.scattering);
    let tau_a = luma(col.absorption);

    // No lunar ephemeris or phase is available on this path. The previous
    // anti-solar "always full" moon was not physical and, as a second
    // Atmosphere directional source, kept Bevy's sky-view LUT daylight-bright
    // all night. Report the moon as absent rather than fabricating geometry.
    let moon_elev = -90.0;
    let moon_azim = 0.0;
    let moon_e_dn = 0.0;
    let moon_e_h = 0.0;
    // Airglow / starlight / suburban skyglow. Not part of the solve; see
    // `NIGHT_FLOOR_LX`. Faded in below the horizon so it never contaminates
    // a daylight exposure.
    let night_floor = if elev < 0.0 {
        NIGHT_FLOOR_LX * ((-elev) / 6.0).clamp(0.0, 1.0)
    } else {
        0.0
    };
    let e_total_h = e_dir_h_expected + e_diff_h + moon_e_h + night_floor;

    // Sky luminance probes. Zenith and 10 deg above the anti-solar horizon.
    let sun_color_norm = {
        let t = sun_transmittance;
        let m = t.max_element();
        if m > 0.0 {
            t / m
        } else {
            Vec3::ONE
        }
    };
    let horizon_mu = 10.0f32.to_radians().sin();
    // Anti-solar azimuth, 10 deg elevation: cos of the scattering angle
    // between the view ray and the sun ray.
    let cos_anti = horizon_mu * sun_mu - (1.0 - horizon_mu * horizon_mu).sqrt() * elev_rad.cos();

    let zenith_single =
        single_scattered_radiance(&terms, 1.0, sun_mu, sun_mu, SOLAR_CONSTANT_LX);
    let horizon_single =
        single_scattered_radiance(&terms, horizon_mu, cos_anti, sun_mu, SOLAR_CONSTANT_LX);
    let zenith_moon = Vec3::ZERO;
    let horizon_moon = Vec3::ZERO;
    // Multiply-scattered light, from the two-stream diffuse irradiance the
    // column solve already produced. This is what carries fog and overcast:
    // there the direct beam is gone and every photon reaching the eye has
    // scattered many times.
    let diffuse_budget = e_diff_h + moon_e_h;
    let zenith_diffuse =
        diffuse_sky_luminance(diffuse_budget, scattering_optical_depth_along(&terms, 1.0));
    let horizon_diffuse = diffuse_sky_luminance(
        diffuse_budget,
        scattering_optical_depth_along(&terms, horizon_mu),
    );
    // The night floor is an illuminance; as a uniform hemisphere it is E/pi.
    let floor_luminance = night_floor / std::f32::consts::PI;
    // What the metering camera frames, when the caller said where it looks.
    // The direct beam is what makes the aureole, so below the horizon the
    // grid still runs (twilight sky) but the aureole term is inert.
    let view_sky = inputs.meter_view.as_ref().map(|view| {
        view_sky_luminance(
            &terms,
            view,
            sun_dir,
            sun_mu,
            diffuse_budget,
            floor_luminance,
        )
    });
    let zenith = zenith_single
        + zenith_moon
        + Vec3::splat(zenith_diffuse + floor_luminance);
    let horizon = horizon_single
        + horizon_moon
        + Vec3::splat(horizon_diffuse + floor_luminance);

    let solid_angle = std::f32::consts::PI * 0.25
        * SUN_ANGULAR_DIAMETER_DEG.to_radians()
        * SUN_ANGULAR_DIAMETER_DEG.to_radians();

    let ground_extinction = {
        let (a, s) = density_at(&terms, 0.0);
        luma(a + s)
    };
    // Aerial perspective on the cloud deck needs the extinction integrated
    // up a slant path, not the ground value times the distance: the
    // boundary-layer term is a few hundred metres deep and the deck sits
    // above most of it. Fold the exponential terms into two (beta at the
    // ground, scale height) pairs, Rayleigh and aerosol/fog, the shader
    // integrates in closed form.
    let (aerial_rayleigh, aerial_aerosol) = {
        let mut rayleigh = (0.0f32, RAYLEIGH_SCALE_HEIGHT_M);
        let mut aerosol_beta = 0.0f32;
        let mut aerosol_beta_h = 0.0f32;
        for (i, term) in terms.iter().enumerate() {
            let Falloff::Exponential { scale } = term.falloff else {
                continue;
            };
            let beta = luma(term.absorption + term.scattering);
            let height = scale * ATMOSPHERE_HEIGHT_M;
            if i == 0 {
                rayleigh = (beta, height);
            } else {
                aerosol_beta += beta;
                aerosol_beta_h += beta * height;
            }
        }
        let aerosol_h = if aerosol_beta > 0.0 {
            aerosol_beta_h / aerosol_beta
        } else {
            MIE_SCALE_HEIGHT_M
        };
        ([rayleigh.0, rayleigh.1], [aerosol_beta, aerosol_h])
    };

    let ev100 = if e_total_h > 0.0 {
        (e_total_h / 2.5).log2()
    } else {
        -6.0
    };

    let settings = settings(far_plane_m);
    let readback = AtmosphereReadback {
        sun_elevation_deg: elev,
        sun_azimuth_deg,
        sun_direction: sun_dir.to_array(),
        sun_above_horizon: visible_ratio > 0.0,
        air_mass: air_mass(elev),
        sun_transmittance: sun_transmittance.to_array(),
        sun_transmittance_luma: t_luma,
        direct_normal_illuminance_lx: e_dn,
        direct_horizontal_illuminance_lx: e_dir_h,
        diffuse_horizontal_illuminance_lx: e_diff_h,
        aerial_rayleigh,
        aerial_aerosol,
        total_horizontal_illuminance_lx: e_total_h,
        sun_color: sun_color_norm.to_array(),
        // A colour temperature for a sun that is not shining is a fiction.
        sun_cct_k: if t_luma > 0.0 { cct_k(sun_color_norm) } else { 0.0 },
        zenith_luminance_cdm2: luma(zenith),
        horizon_luminance_cdm2: luma(horizon),
        view_sky,
        solar_disc_luminance_cdm2: if solid_angle > 0.0 {
            SOLAR_CONSTANT_LX * t_luma / solid_angle
        } else {
            0.0
        },
        solar_disc_solid_angle_sr: solid_angle,
        column_scattering_optical_depth: tau_s,
        column_absorption_optical_depth: tau_a,
        effective_visibility_m: if ground_extinction > 0.0 {
            KOSCHMIEDER / ground_extinction
        } else {
            f32::INFINITY
        },
        ground_extinction_per_m: ground_extinction,
        cloud_optical_depth: inputs.cloud_optical_depth(),
        cloud_intrinsic_optical_depth: inputs.cloud_intrinsic_optical_depth(),
        cloud_deck: inputs.deck.label().to_string(),
        cloud_beam_transmittance: cloud_beam_t,
        cloud_beam_source: cloud_beam_source.to_string(),
        cloud_continuous: inputs.cloud_cover >= OVERCAST_COVER
            && inputs.deck != CloudDeck::None,
        deck_diffuse_gain,
        deck_sun_transmittance: deck_sun_transmittance.to_array(),
        zenith_radiance: zenith.to_array(),
        moon_elevation_deg: moon_elev,
        moon_azimuth_deg: moon_azim,
        moon_direct_normal_illuminance_lx: moon_e_dn,
        moon_horizontal_illuminance_lx: moon_e_h,
        night_floor_lx: night_floor,
        ev100,
        medium_terms: terms.len(),
        turbidity: inputs.turbidity,
        ozone_du: inputs.ozone_du,
        air_density: inputs.air_density,
        cloud_cover: inputs.cloud_cover,
        lut_transmittance: settings.transmittance_lut_size.to_array(),
        lut_multiscattering: settings.multiscattering_lut_size.to_array(),
        lut_sky_view: settings.sky_view_lut_size.to_array(),
        lut_aerial_view: settings.aerial_view_lut_size.to_array(),
        lut_aerial_max_distance_m: settings.aerial_view_lut_max_distance,
        lut_medium_resolution: MEDIUM_LUT_RESOLUTION,
        medium_build_ms: started.elapsed().as_secs_f32() * 1000.0,
    };

    (medium, readback)
}

/// Insert or replace the [`ScatteringMedium`] asset behind a handle.
pub fn upload_medium(
    assets: &mut Assets<ScatteringMedium>,
    handle: &Option<Handle<ScatteringMedium>>,
    medium: ScatteringMedium,
) -> Handle<ScatteringMedium> {
    match handle {
        Some(existing) => {
            assets.insert(existing.id(), medium);
            existing.clone()
        }
        None => assets.add(medium),
    }
}

/// Linear-sRGB [`Color`] for a normalised RGB triple.
pub fn color_of(rgb: [f32; 3]) -> Color {
    Color::linear_rgb(rgb[0], rgb[1], rgb[2])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn clear_noon() -> AtmosphereInputs {
        AtmosphereInputs {
            sun_elevation_deg: 60.0,
            ..Default::default()
        }
    }

    #[test]
    fn paper_mie_albedo_is_scattering_dominated() {
        let terms = earth_terms(&clear_noon());
        let mie = &terms[1];
        let s = mie.scattering.x;
        let a = mie.absorption.x;
        let albedo = s / (s + a);
        assert!(
            albedo > 0.9,
            "tropospheric aerosol must scatter, not absorb (albedo {albedo})"
        );
    }

    #[test]
    fn falloff_scales_are_normalised_to_the_100km_atmosphere() {
        // Isolate each term: the boundary-layer and cloud terms sit in the
        // same summed density LUT, so the check has to be per-term.
        let terms = earth_terms(&clear_noon());
        let e_inv = std::f32::consts::E.recip();

        let rayleigh = &terms[0];
        let r_ratio = rayleigh.falloff.sample(1.0 - RAYLEIGH_SCALE_HEIGHT_M / ATMOSPHERE_HEIGHT_M)
            / rayleigh.falloff.sample(1.0);
        assert!(
            (r_ratio - e_inv).abs() < 0.01,
            "Rayleigh scale height wrong: density ratio at 8 km = {r_ratio} \
             (Bevy's ScatteringMedium::earth normalises to 60 km and gives 0.55 here)"
        );

        let mie = &terms[1];
        let m_ratio = mie.falloff.sample(1.0 - MIE_SCALE_HEIGHT_M / ATMOSPHERE_HEIGHT_M)
            / mie.falloff.sample(1.0);
        assert!(
            (m_ratio - e_inv).abs() < 0.01,
            "Mie scale height wrong: density ratio at 1.2 km = {m_ratio}"
        );

        // Ozone tent must peak at 25 km and vanish by 40 km.
        let ozone = &terms[2];
        assert!(ozone.falloff.sample(1.0 - 25_000.0 / ATMOSPHERE_HEIGHT_M) > 0.99);
        assert_eq!(ozone.falloff.sample(1.0 - 41_000.0 / ATMOSPHERE_HEIGHT_M), 0.0);
    }

    #[test]
    fn clear_noon_illuminance_matches_measured_daylight() {
        let (_, r) = resolve(&clear_noon(), 180.0, 900.0);
        // WMO/CIE clear-sky reference at h = 60 deg: direct normal
        // 85-105 klx, diffuse horizontal 8-18 klx.
        assert!(
            (70_000.0..115_000.0).contains(&r.direct_normal_illuminance_lx),
            "direct normal {} lx out of band",
            r.direct_normal_illuminance_lx
        );
        assert!(
            (6_000.0..22_000.0).contains(&r.diffuse_horizontal_illuminance_lx),
            "diffuse horizontal {} lx out of band",
            r.diffuse_horizontal_illuminance_lx
        );
        assert!(
            (14.0..16.5).contains(&r.ev100),
            "clear-noon EV100 {} out of band",
            r.ev100
        );
        // Clear zenith sky on a sunny day: 2-10 kcd/m^2.
        assert!(
            (1_000.0..15_000.0).contains(&r.zenith_luminance_cdm2),
            "zenith luminance {} cd/m^2 out of band",
            r.zenith_luminance_cdm2
        );
    }

    #[test]
    fn overcast_suppresses_the_beam_and_lowers_exposure() {
        let clear = resolve(&clear_noon(), 180.0, 900.0).1;
        let overcast = resolve(
            &AtmosphereInputs {
                sun_elevation_deg: 60.0,
                deck: CloudDeck::Stratus,
                cloud_cover: 0.95,
                visibility_m: 12_000.0,
                turbidity: 3.2,
                ..Default::default()
            },
            180.0,
            900.0,
        )
        .1;
        assert!(
            overcast.cloud_beam_transmittance < 1.0e-3,
            "stratus deck must extinguish the beam (T = {})",
            overcast.cloud_beam_transmittance
        );
        assert!(
            overcast.direct_normal_illuminance_lx < clear.direct_normal_illuminance_lx * 0.01,
            "overcast direct beam {} lx not suppressed",
            overcast.direct_normal_illuminance_lx
        );
        // Overcast noon horizontal illuminance is genuinely high: 20-60 klx.
        assert!(
            (15_000.0..70_000.0).contains(&overcast.total_horizontal_illuminance_lx),
            "overcast total {} lx out of band",
            overcast.total_horizontal_illuminance_lx
        );
        assert!(overcast.ev100 < clear.ev100);
    }

    #[test]
    fn koschmieder_visibility_round_trips() {
        for authored in [80.0f32, 200.0, 1_000.0, 5_000.0, 20_000.0] {
            let (_, r) = resolve(
                &AtmosphereInputs {
                    visibility_m: authored,
                    ..clear_noon()
                },
                180.0,
                900.0,
            );
            let err = (r.effective_visibility_m - authored).abs() / authored;
            assert!(
                err < 0.05,
                "authored {authored} m -> resolved {} m",
                r.effective_visibility_m
            );
        }
    }

    #[test]
    fn low_sun_reddens_the_beam() {
        let noon = resolve(&clear_noon(), 180.0, 900.0).1;
        let low = resolve(
            &AtmosphereInputs {
                sun_elevation_deg: 2.0,
                ..Default::default()
            },
            90.0,
            900.0,
        )
        .1;
        assert!(
            low.sun_cct_k < noon.sun_cct_k - 800.0,
            "low sun CCT {} K should be far warmer than noon {} K",
            low.sun_cct_k,
            noon.sun_cct_k
        );
        assert!(
            low.sun_color[0] > low.sun_color[2] * 1.5,
            "low sun must be red-dominant: {:?}",
            low.sun_color
        );
        assert!(low.direct_normal_illuminance_lx < noon.direct_normal_illuminance_lx * 0.5);
    }

    #[test]
    fn below_civil_twilight_kills_the_disc() {
        let (_, r) = resolve(
            &AtmosphereInputs {
                sun_elevation_deg: -8.0,
                ..Default::default()
            },
            0.0,
            900.0,
        );
        assert!(!r.sun_above_horizon);
        assert_eq!(r.direct_normal_illuminance_lx, 0.0);
        assert!(r.ev100 < 12.0, "night EV100 {} too bright", r.ev100);
    }

    #[test]
    fn ozone_controls_twilight_blue() {
        let thin = resolve(
            &AtmosphereInputs {
                sun_elevation_deg: 1.0,
                ozone_du: 150.0,
                ..Default::default()
            },
            90.0,
            900.0,
        )
        .1;
        let thick = resolve(
            &AtmosphereInputs {
                sun_elevation_deg: 1.0,
                ozone_du: 450.0,
                ..Default::default()
            },
            90.0,
            900.0,
        )
        .1;
        assert!(
            thick.column_absorption_optical_depth > thin.column_absorption_optical_depth,
            "more ozone must absorb more"
        );
        assert!(thick.direct_normal_illuminance_lx < thin.direct_normal_illuminance_lx);
    }

    #[test]
    fn medium_lut_resolutions_match_to_avoid_the_transpose_bug() {
        let m = medium(&clear_noon());
        assert_eq!(
            m.falloff_resolution, m.phase_resolution,
            "bevy_pbr::medium scrambles the scattering LUT when these differ"
        );
    }

    #[test]
    fn aerial_lut_is_fitted_to_the_far_plane() {
        let s = settings(900.0);
        assert!((s.aerial_view_lut_max_distance - 945.0).abs() < 1.0);
        let clamped = settings(1.0e6);
        assert_eq!(clamped.aerial_view_lut_max_distance, 3.2e4);
    }

    #[test]
    fn broken_cover_keeps_the_sun_but_continuous_cover_does_not() {
        let broken = resolve(
            &AtmosphereInputs {
                sun_elevation_deg: 74.6,
                deck: CloudDeck::Cumulus,
                cloud_cover: 0.45,
                visibility_m: 25_000.0,
                turbidity: 2.9,
                ..Default::default()
            },
            195.0,
            2000.0,
        )
        .1;
        // A uniform slab carrying `cover * tau` would leave ~0.1% of the
        // beam. The independent-column closure has to leave roughly the
        // clear-sky fraction of it instead.
        assert!(
            (0.35..0.75).contains(&broken.cloud_beam_transmittance),
            "45% cumulus should pass roughly half the beam, got {}",
            broken.cloud_beam_transmittance
        );
        assert!(!broken.cloud_continuous);
        assert!(
            broken.direct_normal_illuminance_lx > 30_000.0,
            "broken cover must keep a real sun, got {} lx",
            broken.direct_normal_illuminance_lx
        );
        assert!(
            broken.cloud_optical_depth < broken.cloud_intrinsic_optical_depth,
            "effective depth must be below the intrinsic deck depth"
        );

        let solid = resolve(
            &AtmosphereInputs {
                cloud_cover: 0.95,
                deck: CloudDeck::Stratus,
                ..AtmosphereInputs {
                    sun_elevation_deg: 74.6,
                    ..Default::default()
                }
            },
            195.0,
            2000.0,
        )
        .1;
        assert!(solid.cloud_continuous);
        assert!(
            (solid.cloud_optical_depth - solid.cloud_intrinsic_optical_depth).abs() < 1.0e-3,
            "continuous cover must use the deck's own optical depth"
        );
    }

    #[test]
    fn thick_media_stay_bright_where_the_beam_is_gone() {
        // Daytime fog and overcast are the case a beam-gated multiple
        // scattering estimate gets catastrophically wrong: direct
        // transmittance is zero, yet the sky is a bright white wall.
        for (label, inputs) in [
            (
                "fog",
                AtmosphereInputs {
                    sun_elevation_deg: 20.0,
                    visibility_m: 150.0,
                    deck: CloudDeck::Stratus,
                    cloud_cover: 0.75,
                    turbidity: 3.0,
                    ..Default::default()
                },
            ),
            (
                "overcast",
                AtmosphereInputs {
                    sun_elevation_deg: 74.6,
                    visibility_m: 12_000.0,
                    deck: CloudDeck::Stratus,
                    cloud_cover: 0.95,
                    turbidity: 3.2,
                    ..Default::default()
                },
            ),
        ] {
            let (_, r) = resolve(&inputs, 195.0, 2000.0);
            // Not exactly zero — extinction is exponential, not a switch —
            // but far below the 1 lx a camera could register.
            assert!(
                r.direct_normal_illuminance_lx < 1.0,
                "{label}: beam survived at {} lx",
                r.direct_normal_illuminance_lx
            );
            // The visible sky through a gap is the deck-free air, so the
            // zenith probe no longer describes the lid; the energy the scene
            // receives is the diffuse illuminance, which for overcast and fog
            // sits in the measured 5-45 klx band at this sun height.
            assert!(
                (5_000.0..45_000.0).contains(&r.diffuse_horizontal_illuminance_lx),
                "{label}: diffuse {} lx is not an overcast sky",
                r.diffuse_horizontal_illuminance_lx
            );
            assert!(
                r.deck_diffuse_gain > 0.25 && r.deck_diffuse_gain < 8.0,
                "{label}: deck gain {} out of band",
                r.deck_diffuse_gain
            );
        }
    }

    #[test]
    fn night_budget_is_only_the_declared_floor_without_a_lunar_ephemeris() {
        let (_, r) = resolve(
            &AtmosphereInputs {
                sun_elevation_deg: -25.0,
                ..Default::default()
            },
            20.0,
            2000.0,
        );
        assert_eq!(r.direct_normal_illuminance_lx, 0.0);
        assert_eq!(r.moon_elevation_deg, -90.0);
        assert_eq!(r.moon_azimuth_deg, 0.0);
        assert_eq!(r.moon_direct_normal_illuminance_lx, 0.0);
        assert_eq!(r.moon_horizontal_illuminance_lx, 0.0);
        assert_eq!(r.night_floor_lx, NIGHT_FLOOR_LX);
        assert_eq!(r.total_horizontal_illuminance_lx, NIGHT_FLOOR_LX);
        // 0.002 lx on a C = 250 incident meter is EV100 log2(0.002 / 2.5).
        assert!(
            (-10.5..-10.0).contains(&r.ev100),
            "night-floor EV100 {} out of band",
            r.ev100
        );
        assert_eq!(r.sun_cct_k, 0.0, "a sun that is not shining has no CCT");
    }

    #[test]
    fn twilight_is_lit_from_above_the_observer() {
        // At -3 deg the beam misses the ground entirely, but the upper
        // atmosphere is still in sunlight, so the sky must not be black.
        let (_, r) = resolve(
            &AtmosphereInputs {
                sun_elevation_deg: -3.0,
                ..Default::default()
            },
            300.0,
            2000.0,
        );
        assert_eq!(r.direct_normal_illuminance_lx, 0.0);
        assert!(
            (20.0..400.0).contains(&r.total_horizontal_illuminance_lx),
            "civil twilight illuminance {} lx out of band",
            r.total_horizontal_illuminance_lx
        );
        assert!(
            r.zenith_luminance_cdm2 > 1.0,
            "twilight zenith should still glow, got {}",
            r.zenith_luminance_cdm2
        );
    }

    #[test]
    fn illuminance_and_exposure_rank_the_conditions_correctly() {
        let ev = |inputs: AtmosphereInputs| resolve(&inputs, 195.0, 2000.0).1.ev100;
        let noon = ev(AtmosphereInputs { sun_elevation_deg: 74.6, ..Default::default() });
        let cloudy = ev(AtmosphereInputs {
            sun_elevation_deg: 74.6,
            deck: CloudDeck::Cumulus,
            cloud_cover: 0.45,
            ..Default::default()
        });
        let overcast = ev(AtmosphereInputs {
            sun_elevation_deg: 74.6,
            deck: CloudDeck::Stratus,
            cloud_cover: 0.95,
            ..Default::default()
        });
        let sunrise = ev(AtmosphereInputs { sun_elevation_deg: 6.6, ..Default::default() });
        let twilight = ev(AtmosphereInputs { sun_elevation_deg: -3.0, ..Default::default() });
        let night = ev(AtmosphereInputs { sun_elevation_deg: -25.0, ..Default::default() });
        assert!(noon > cloudy, "{noon} !> {cloudy}");
        assert!(cloudy > overcast, "{cloudy} !> {overcast}");
        assert!(overcast > sunrise, "{overcast} !> {sunrise}");
        assert!(sunrise > twilight, "{sunrise} !> {twilight}");
        assert!(twilight > night, "{twilight} !> {night}");
    }
}
