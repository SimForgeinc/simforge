//! Resolved physical night sources, celestial geometry and the sky IBL.
//!
//! What this module owns:
//!
//! * a compact topocentric solar/lunar solution (Paul Schlyter's public-domain
//!   low-precision series, plus WGS84 parallax and IAU 1976 precession) that
//!   yields one celestial state shared by the visible sky, the Moon's
//!   `DirectionalLight` and the IBL - never three separate approximations;
//! * the world<-equatorial rotation the star plate is sampled through;
//! * the source ledger the lab reports;
//! * a small diffuse cubemap for image-based lighting. The *visible* sky is
//!   not baked here any more - see [`crate::sky_pass`] for why.
//!
//! The star field and Milky Way come from NASA/Goddard SVS "Deep Star Maps
//! 2020" (public domain), and the lunar albedo from NASA/Goddard SVS "CGI
//! Moon Kit" (public domain); both are prepared by `tools/prepare_sky_assets.py`
//! and inventoried in `assets/sky/SOURCES.json`.

use bevy::asset::RenderAssetUsages;
use bevy::image::Image;
use bevy::math::{Mat3, Vec2, Vec3};
use bevy::render::render_resource::{
    Extent3d, TextureDimension, TextureFormat, TextureViewDescriptor, TextureViewDimension,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::f64::consts::PI;

const DEG: f64 = PI / 180.0;
/// Mean lunar radius, km (IAU).
const MOON_RADIUS_KM: f64 = 1_737.4;
/// Inclination of the lunar equator to the ecliptic (Cassini), degrees.
const LUNAR_EQUATOR_INCLINATION_DEG: f64 = 1.54242;

fn default_year() -> i32 { 2026 }
fn default_day() -> u16 { 172 }
fn default_minutes() -> f32 { 720.0 }
fn default_lat() -> f64 { 37.4419 }
fn default_lon() -> f64 { -122.1430 }
fn default_natural_lux() -> f32 { 0.002 }
fn default_skyglow_lux() -> f32 { 0.05 }
fn default_star_mag() -> f32 { 6.5 }
fn default_fixture_budget() -> usize { 12 }
fn default_cloud_quality() -> CloudQuality { CloudQuality::Scalable }
fn default_wind() -> [f32; 2] { [12.0, 4.0] }
fn default_cloud_density() -> f32 { 1.0 }
fn default_cloud_kind() -> f32 { 0.6 }
fn default_cloud_base() -> f32 { 1_100.0 }
fn default_cloud_top() -> f32 { 3_000.0 }
fn default_sky_lift() -> f32 { 120.0 }
fn default_exposure_offset() -> f32 { 0.0 }
fn default_window_mode() -> WindowMode { WindowMode::SyntheticFacade }

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CloudQuality {
    Off,
    #[default]
    Scalable,
    Lookdev,
}

impl CloudQuality {
    /// Cap on cloud samples per ray. The march walks the deck at a fixed
    /// metric step (`sky_pass.wgsl`), so this is a budget, not a resolution.
    pub fn march_steps(self) -> f32 {
        match self {
            CloudQuality::Off => 0.0,
            CloudQuality::Scalable => 96.0,
            CloudQuality::Lookdev => 160.0,
        }
    }
    pub fn light_steps(self) -> f32 {
        match self {
            CloudQuality::Off => 0.0,
            CloudQuality::Scalable => 4.0,
            CloudQuality::Lookdev => 6.0,
        }
    }
}

/// Which window population lights up after dark.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WindowMode {
    Off,
    /// Only GLB primitives whose material is a dedicated window/glass name.
    Physical,
    /// Those, plus quads fitted to façade planes recovered from the loaded
    /// geometry wherever the map carries no window materials.
    #[default]
    SyntheticFacade,
    /// Façade quads plus the cyan plane outlines that prove attachment.
    SyntheticFacadeDebug,
}

impl WindowMode {
    pub fn synthetic(self) -> bool {
        matches!(
            self,
            WindowMode::SyntheticFacade | WindowMode::SyntheticFacadeDebug
        )
    }
    pub fn debug(self) -> bool {
        matches!(self, WindowMode::SyntheticFacadeDebug)
    }
    pub fn as_str(self) -> &'static str {
        match self {
            WindowMode::Off => "off",
            WindowMode::Physical => "physical",
            WindowMode::SyntheticFacade => "synthetic-facade",
            WindowMode::SyntheticFacadeDebug => "synthetic-facade-debug",
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct NightControls {
    #[serde(default = "default_year")]
    pub utc_year: i32,
    #[serde(default = "default_day")]
    pub utc_day_of_year: u16,
    #[serde(default = "default_minutes")]
    pub utc_minutes: f32,
    #[serde(default = "default_lat")]
    pub latitude_deg: f64,
    #[serde(default = "default_lon")]
    pub longitude_deg: f64,
    #[serde(default)]
    pub elevation_m: f32,
    #[serde(default = "default_natural_lux")]
    pub natural_ambient_lux: f32,
    #[serde(default = "default_skyglow_lux")]
    pub urban_skyglow_lux: f32,
    #[serde(default = "default_star_mag")]
    pub limiting_magnitude: f32,
    #[serde(default = "default_fixture_budget")]
    pub fixture_budget: usize,
    #[serde(default)]
    pub fixture_shadow_budget: usize,
    #[serde(default = "default_window_mode")]
    pub window_mode: WindowMode,
    #[serde(default = "default_cloud_quality")]
    pub cloud_quality: CloudQuality,
    #[serde(default = "default_wind")]
    pub cloud_wind_mps: [f32; 2],
    #[serde(default = "default_cloud_density")]
    pub cloud_density: f32,
    #[serde(default = "default_cloud_kind")]
    pub cloud_type: f32,
    #[serde(default = "default_cloud_base")]
    pub cloud_base_m: f32,
    #[serde(default = "default_cloud_top")]
    pub cloud_top_m: f32,
    /// Display-referred lift applied to the celestial plate above its
    /// photometric closure. Reported, never hidden: a single fixed camera EV
    /// cannot hold a 22 mag/arcsec^2 sky and a 3000 K street pool at once.
    #[serde(default = "default_sky_lift")]
    pub sky_display_lift: f32,
    /// Stops of deliberate under-exposure below the reflected-light meter.
    /// A night exterior metered neutral looks like an overcast afternoon;
    /// this is the printer light that puts it back at night.
    #[serde(default = "default_exposure_offset")]
    pub exposure_offset_stops: f32,
    /// Debug visualisation for the sky pass (0 off, 1 cloud opacity,
    /// 2 star plate only, 3 lunar disc only).
    #[serde(default)]
    pub sky_debug_mode: u32,
    /// Seconds of cloud advection per rendered frame. Zero keeps the
    /// interactive wall clock; a recording sets 1/fps so an eight-second
    /// clip advects exactly eight seconds regardless of how long the frames
    /// took to render.
    #[serde(default)]
    pub cloud_fixed_step_s: f32,
    /// World-space camera position the reflected-light meter reads from.
    /// Sent by the caller because the renderer's camera transform is not
    /// necessarily applied yet when the relight is resolved.
    #[serde(default)]
    pub observer_position: [f32; 3],
    #[serde(default)]
    pub fixtures: Vec<NightFixture>,
}

impl Default for NightControls {
    fn default() -> Self {
        Self {
            utc_year: default_year(),
            utc_day_of_year: default_day(),
            utc_minutes: default_minutes(),
            latitude_deg: default_lat(),
            longitude_deg: default_lon(),
            elevation_m: 0.0,
            natural_ambient_lux: default_natural_lux(),
            urban_skyglow_lux: default_skyglow_lux(),
            limiting_magnitude: default_star_mag(),
            fixture_budget: default_fixture_budget(),
            fixture_shadow_budget: 0,
            window_mode: default_window_mode(),
            cloud_quality: default_cloud_quality(),
            cloud_wind_mps: default_wind(),
            cloud_density: default_cloud_density(),
            cloud_type: default_cloud_kind(),
            cloud_base_m: default_cloud_base(),
            cloud_top_m: default_cloud_top(),
            sky_display_lift: default_sky_lift(),
            exposure_offset_stops: default_exposure_offset(),
            sky_debug_mode: 0,
            cloud_fixed_step_s: 0.0,
            observer_position: [0.0, 1.6, 0.0],
            fixtures: Vec::new(),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct NightFixture {
    pub source_id: String,
    pub source_name: String,
    pub position: [f32; 3],
    #[serde(default)]
    pub heading_rad: f32,
    #[serde(default = "default_fixture_lumens")]
    pub lumens: f32,
    #[serde(default = "default_fixture_cct")]
    pub cct_k: f32,
    #[serde(default = "default_fixture_range")]
    pub range_m: f32,
    #[serde(default = "default_fixture_cone")]
    pub outer_angle_deg: f32,
    #[serde(default)]
    pub confidence: f32,
    #[serde(default)]
    pub rule: String,
}
fn default_fixture_lumens() -> f32 { 4_000.0 }
fn default_fixture_cct() -> f32 { 2_700.0 }
fn default_fixture_range() -> f32 { 70.0 }
fn default_fixture_cone() -> f32 { 70.0 }

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct MoonState {
    pub elevation_deg: f32,
    pub azimuth_deg: f32,
    pub distance_km: f32,
    pub illuminated_fraction: f32,
    pub phase_angle_deg: f32,
    /// Topocentric angular *diameter* of the disc, degrees.
    pub angular_diameter_deg: f32,
    pub direct_normal_lux: f32,
    pub horizontal_lux: f32,
    pub above_horizon: bool,
}

/// Geometry the sky pass needs, in the renderer's world frame
/// (+X east, +Y up, +Z north).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CelestialFrame {
    /// Row-major 3x3 taking a world direction into the J2000 equatorial frame.
    pub equ_from_world: [[f32; 3]; 3],
    pub moon_dir: [f32; 3],
    pub moon_north: [f32; 3],
    pub moon_sun_dir: [f32; 3],
    pub sun_dir: [f32; 3],
    pub sun_elevation_deg: f32,
    pub angular_radius_rad: f32,
    pub sub_earth_lon_deg: f32,
    pub sub_earth_lat_deg: f32,
    pub local_sidereal_deg: f32,
    pub precession_arcsec: f32,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SourceLedgerEntry {
    pub id: String,
    pub kind: String,
    pub nominal_value: f32,
    pub nominal_unit: String,
    pub renderer_internal_value: f32,
    pub active_layers: Vec<String>,
    pub shadows: bool,
    pub confidence: f32,
    pub provenance: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct NightEnvironment {
    pub celestial: MoonState,
    pub frame: CelestialFrame,
    pub natural_ambient_lux: f32,
    pub urban_skyglow_lux: f32,
    pub star_catalog: String,
    pub star_count: usize,
    pub limiting_magnitude: f32,
    pub milky_way_model: String,
    pub cloud_model: String,
    pub cloud_quality: CloudQuality,
    pub cloud_wind_offset_m: [f32; 2],
    /// Cloud transmittance actually applied to the Moon's directional light,
    /// solved with the same field the raymarch draws.
    pub cloud_beam_transmittance: f32,
    pub cloud_zenith_optical_depth: f32,
    pub cloud_animation_seconds: f32,
    pub cloud_continuous: bool,
    pub sky_photometric_gain: f32,
    pub sky_display_lift: f32,
    pub fixtures_detected: usize,
    pub fixtures_active: usize,
    pub fixture_budget: usize,
    pub window_mode: String,
    pub source_ledger: Vec<SourceLedgerEntry>,
}

// ---------------------------------------------------------------- utilities

pub fn sha256_bytes(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

pub fn sha256_file(path: &std::path::Path) -> std::io::Result<String> {
    use std::io::Read;
    let mut file = std::fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 1 << 20];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn wrap(x: f64, period: f64) -> f64 {
    x.rem_euclid(period)
}

fn julian_day(c: &NightControls) -> f64 {
    let y = c.utc_year - 1;
    let jan1 = 1721425.5 + 365.0 * y as f64 + (y / 4) as f64 - (y / 100) as f64 + (y / 400) as f64;
    jan1 + (c.utc_day_of_year.max(1) as f64 - 1.0) + c.utc_minutes as f64 / 1440.0
}

pub fn horizontal_dir(az_deg: f32, elev_deg: f32) -> Vec3 {
    let a = az_deg.to_radians();
    let e = elev_deg.to_radians();
    Vec3::new(e.cos() * a.sin(), e.sin(), e.cos() * a.cos()).normalize()
}

/// IAU 1976 general precession, J2000 -> mean equinox of date.
fn precession_matrix(jd: f64) -> (Mat3, f32) {
    let t = (jd - 2451545.0) / 36525.0;
    let arcsec = |v: f64| v / 3600.0 * DEG;
    let zeta = arcsec(2306.2181 * t + 0.30188 * t * t + 0.017998 * t * t * t);
    let z = arcsec(2306.2181 * t + 1.09468 * t * t + 0.018203 * t * t * t);
    let theta = arcsec(2004.3109 * t - 0.42665 * t * t - 0.041833 * t * t * t);
    let rz = |a: f64| {
        Mat3::from_cols(
            Vec3::new(a.cos() as f32, a.sin() as f32, 0.0),
            Vec3::new(-a.sin() as f32, a.cos() as f32, 0.0),
            Vec3::Z,
        )
    };
    let ry = |a: f64| {
        Mat3::from_cols(
            Vec3::new(a.cos() as f32, 0.0, -a.sin() as f32),
            Vec3::Y,
            Vec3::new(a.sin() as f32, 0.0, a.cos() as f32),
        )
    };
    // P = Rz(-z) * Ry(theta) * Rz(-zeta)
    let p = rz(-z) * ry(theta) * rz(-zeta);
    let total = (2306.2181 * t + 0.30188 * t * t).abs() + (2004.3109 * t).abs();
    (p, total as f32)
}

/// Columns of the world<-equatorial-of-date rotation.
///
/// The renderer's world frame is +X east, +Y up, +Z north. The celestial pole
/// sits due north at the site latitude, the hour-angle origin is the meridian,
/// and hour angle grows westward - which is why this map is orientation
/// reversing: RA runs the other way round the sky from where an observer
/// standing under it measures hour angle.
fn world_from_equatorial_of_date(lat_rad: f64, lst_rad: f64) -> Mat3 {
    let (sin_p, cos_p) = lat_rad.sin_cos();
    let pole = Vec3::new(0.0, sin_p as f32, cos_p as f32);
    let meridian = Vec3::new(0.0, cos_p as f32, -(sin_p as f32));
    let west = Vec3::new(-1.0, 0.0, 0.0);
    let (sin_l, cos_l) = lst_rad.sin_cos();
    let (sin_l, cos_l) = (sin_l as f32, cos_l as f32);
    Mat3::from_cols(
        meridian * cos_l + west * sin_l,
        meridian * sin_l - west * cos_l,
        pole,
    )
}

fn equatorial_unit(ra: f64, dec: f64) -> Vec3 {
    Vec3::new(
        (dec.cos() * ra.cos()) as f32,
        (dec.cos() * ra.sin()) as f32,
        dec.sin() as f32,
    )
}

// ---------------------------------------------------------------- ephemeris

struct SolarSystem {
    /// Geocentric equatorial-of-date Moon position, Earth radii.
    moon_geo: Vec3,
    /// Geocentric equatorial-of-date Sun position, Earth radii.
    sun_geo: Vec3,
    moon_distance_er: f64,
    moon_ra: f64,
    moon_dec: f64,
    sun_ra: f64,
    sun_dec: f64,
    /// Geocentric ecliptic longitude/latitude of the Moon, radians.
    moon_ecl_lon: f64,
    moon_ecl_lat: f64,
    /// Longitude of the ascending node and argument of latitude, radians.
    node: f64,
    arg_latitude: f64,
    obliquity: f64,
}

fn solve(d: f64) -> SolarSystem {
    let ob = (23.4393 - 3.563e-7 * d) * DEG;

    // Sun (Schlyter).
    let w_s = (282.9404 + 4.70935e-5 * d) * DEG;
    let e_s = 0.016709 - 1.151e-9 * d;
    let m_s = wrap((356.0470 + 0.9856002585 * d) * DEG, 2.0 * PI);
    let ea_s = m_s + e_s * m_s.sin() * (1.0 + e_s * m_s.cos());
    let xv_s = ea_s.cos() - e_s;
    let yv_s = (1.0 - e_s * e_s).sqrt() * ea_s.sin();
    let v_s = yv_s.atan2(xv_s);
    let r_s = (xv_s * xv_s + yv_s * yv_s).sqrt();
    let lon_s = v_s + w_s;
    // 1 AU in Earth radii.
    let au_er = 23_454.8;
    let sun_ecl = Vec3::new(
        (r_s * lon_s.cos() * au_er) as f32,
        (r_s * lon_s.sin() * au_er) as f32,
        0.0,
    );
    let sun_geo = Vec3::new(
        sun_ecl.x,
        sun_ecl.y * ob.cos() as f32 - sun_ecl.z * ob.sin() as f32,
        sun_ecl.y * ob.sin() as f32 + sun_ecl.z * ob.cos() as f32,
    );
    let sun_ra = (sun_geo.y as f64).atan2(sun_geo.x as f64);
    let sun_dec = (sun_geo.z as f64)
        .atan2(((sun_geo.x * sun_geo.x + sun_geo.y * sun_geo.y) as f64).sqrt());

    // Moon (Schlyter, principal periodic terms).
    let n = wrap((125.1228 - 0.0529538083 * d) * DEG, 2.0 * PI);
    let i = 5.1454 * DEG;
    let w = wrap((318.0634 + 0.1643573223 * d) * DEG, 2.0 * PI);
    let a = 60.2666;
    let e = 0.054900;
    let m = wrap((115.3654 + 13.0649929509 * d) * DEG, 2.0 * PI);
    let mut ea = m + e * m.sin() * (1.0 + e * m.cos());
    for _ in 0..4 {
        ea -= (ea - e * ea.sin() - m) / (1.0 - e * ea.cos());
    }
    let xv = a * (ea.cos() - e);
    let yv = a * (1.0 - e * e).sqrt() * ea.sin();
    let v = yv.atan2(xv);
    let mut r = (xv * xv + yv * yv).sqrt();
    let lon = v + w;
    let xh = r * (n.cos() * lon.cos() - n.sin() * lon.sin() * i.cos());
    let yh = r * (n.sin() * lon.cos() + n.cos() * lon.sin() * i.cos());
    let zh = r * lon.sin() * i.sin();
    let mut ecl_lon = yh.atan2(xh);
    let mut ecl_lat = zh.atan2((xh * xh + yh * yh).sqrt());

    // Principal perturbations: evection, variation, annual equation and the
    // two largest latitude terms. Without them the phase and the terminator
    // drift by up to 1.3 deg, which is visible on an 11 px disc.
    let ls = wrap(m_s + w_s, 2.0 * PI);
    let lm = wrap(m + w + n, 2.0 * PI);
    let dm = wrap(lm - ls, 2.0 * PI);
    let f = wrap(lm - n, 2.0 * PI);
    ecl_lon += (-1.274 * (m - 2.0 * dm).sin()
        + 0.658 * (2.0 * dm).sin()
        - 0.186 * m_s.sin()
        - 0.059 * (2.0 * m - 2.0 * dm).sin()
        - 0.057 * (m - 2.0 * dm + m_s).sin()
        + 0.053 * (m + 2.0 * dm).sin()
        + 0.046 * (2.0 * dm - m_s).sin()
        + 0.041 * (m - m_s).sin()
        - 0.035 * dm.sin()
        - 0.031 * (m + m_s).sin())
        * DEG;
    ecl_lat += (-0.173 * (f - 2.0 * dm).sin()
        - 0.055 * (m - f - 2.0 * dm).sin()
        - 0.046 * (m + f - 2.0 * dm).sin()
        + 0.033 * (f + 2.0 * dm).sin()
        + 0.017 * (2.0 * m + f).sin())
        * DEG;
    r += -0.58 * (m - 2.0 * dm).cos() - 0.46 * (2.0 * dm).cos();

    let (sx, sy, sz) = (
        r * ecl_lat.cos() * ecl_lon.cos(),
        r * ecl_lat.cos() * ecl_lon.sin(),
        r * ecl_lat.sin(),
    );
    let moon_geo = Vec3::new(
        sx as f32,
        (sy * ob.cos() - sz * ob.sin()) as f32,
        (sy * ob.sin() + sz * ob.cos()) as f32,
    );
    let moon_ra = (moon_geo.y as f64).atan2(moon_geo.x as f64);
    let moon_dec = (moon_geo.z as f64)
        .atan2(((moon_geo.x * moon_geo.x + moon_geo.y * moon_geo.y) as f64).sqrt());

    SolarSystem {
        moon_geo,
        sun_geo,
        moon_distance_er: r,
        moon_ra,
        moon_dec,
        sun_ra,
        sun_dec,
        moon_ecl_lon: ecl_lon,
        moon_ecl_lat: ecl_lat,
        node: n,
        arg_latitude: f,
        obliquity: ob,
    }
}

/// Meeus ch. 53 optical libration in longitude, radians.
fn optical_libration_longitude(sys: &SolarSystem) -> f64 {
    let inc = LUNAR_EQUATOR_INCLINATION_DEG * DEG;
    let w = wrap(sys.moon_ecl_lon - sys.node, 2.0 * PI);
    let b = sys.moon_ecl_lat;
    let a = (w.sin() * b.cos() * inc.cos() - b.sin() * inc.sin()).atan2(w.cos() * b.cos());
    wrap(a - sys.arg_latitude + PI, 2.0 * PI) - PI
}

fn topocentric(
    sys: &SolarSystem,
    c: &NightControls,
    lst: f64,
) -> (f64, f64, f64) {
    let lat = c.latitude_deg * DEG;
    let h = wrap(lst - sys.moon_ra + PI, 2.0 * PI) - PI;
    let u = (0.99664719 * lat.tan()).atan();
    let rho_sin = 0.99664719 * u.sin() + (c.elevation_m as f64 / 6_378_137.0) * lat.sin();
    let rho_cos = u.cos() + (c.elevation_m as f64 / 6_378_137.0) * lat.cos();
    let parallax = (1.0 / sys.moon_distance_er).asin();
    let dec = sys.moon_dec;
    let dra = (-rho_cos * parallax.sin() * h.sin())
        .atan2(dec.cos() - rho_cos * parallax.sin() * h.cos());
    let ra_topo = sys.moon_ra + dra;
    let dec_topo = ((dec.sin() - rho_sin * parallax.sin()) * dra.cos())
        .atan2(dec.cos() - rho_cos * parallax.sin() * h.cos());
    // Topocentric distance from the same parallax triangle.
    let dist = sys.moon_distance_er
        * (dec.cos() * h.cos() - rho_cos).hypot(dec.sin() - rho_sin)
        / sys.moon_distance_er.max(1e-9);
    let dist = if dist.is_finite() && dist > 0.0 {
        (sys.moon_geo
            - Vec3::new(
                (rho_cos * lst.cos()) as f32,
                (rho_cos * lst.sin()) as f32,
                rho_sin as f32,
            ))
        .length() as f64
    } else {
        sys.moon_distance_er
    };
    (ra_topo, dec_topo, dist)
}

pub fn resolve_night(c: &NightControls, internal_scale: f32, moon_shadows: bool) -> NightEnvironment {
    let jd = julian_day(c);
    let d = jd - 2451543.5;
    let sys = solve(d);
    let gmst_deg = wrap(280.46061837 + 360.98564736629 * (jd - 2451545.0), 360.0);
    let lst = (gmst_deg + c.longitude_deg) * DEG;
    let lat = c.latitude_deg * DEG;

    let (ra_topo, dec_topo, dist_er) = topocentric(&sys, c, lst);
    let ht = wrap(lst - ra_topo + PI, 2.0 * PI) - PI;
    let elev = (lat.sin() * dec_topo.sin() + lat.cos() * dec_topo.cos() * ht.cos()).asin();
    let az = (-ht.sin()).atan2(dec_topo.tan() * lat.cos() - lat.sin() * ht.cos());
    let elev_deg = (elev / DEG) as f32;
    let az_deg = wrap(az / DEG, 360.0) as f32;

    // Phase from the true Sun-Moon-Earth triangle.
    let moon_to_sun = (sys.sun_geo - sys.moon_geo).normalize_or(Vec3::X);
    let moon_to_earth = (-sys.moon_geo).normalize_or(Vec3::NEG_X);
    let phase_angle = moon_to_sun.dot(moon_to_earth).clamp(-1.0, 1.0).acos() as f64;
    let illuminated = ((1.0 + phase_angle.cos()) * 0.5).clamp(0.0, 1.0);

    let distance_km = (dist_er * 6378.14) as f32;
    let angular_radius = (MOON_RADIUS_KM / (distance_km as f64).max(1.0)).asin();

    let air_mass = if elev_deg > 0.0 {
        1.0 / (elev.sin() + 0.025 * (-11.0 * elev.sin()).exp())
    } else {
        1000.0
    };
    let extinction = (-0.18_f64 * air_mass).exp() as f32;
    let distance_gain = (384_400.0 / distance_km.max(1.0)).powi(2);
    // Full-Moon direct-normal illuminance is ~0.267 lx at mean distance; the
    // opposition surge is folded into the exponent of the phase law.
    let phase_law = illuminated.powf(1.35) as f32;
    let direct: f32 = if elev_deg > 0.0 {
        (0.267_f32 * phase_law * distance_gain * extinction).clamp(0.0, 0.32)
    } else {
        0.0
    };
    let horizontal = direct * elev.sin().max(0.0) as f32;

    let sun_h = wrap(lst - sys.sun_ra + PI, 2.0 * PI) - PI;
    let sun_elev =
        (lat.sin() * sys.sun_dec.sin() + lat.cos() * sys.sun_dec.cos() * sun_h.cos()).asin();
    let sun_az = (-sun_h.sin()).atan2(sys.sun_dec.tan() * lat.cos() - lat.sin() * sun_h.cos());

    let (precession, precession_arcsec) = precession_matrix(jd);
    let world_from_equ = world_from_equatorial_of_date(lat, lst);
    // world -> equ_of_date -> J2000
    let equ_from_world = precession.transpose() * world_from_equ.transpose();

    let moon_dir = horizontal_dir(az_deg, elev_deg);
    // Lunar north is the ecliptic pole tilted by the Cassini inclination
    // toward the ascending node; the tilt is 1.54 deg, so the ecliptic pole
    // itself fixes the disc's roll to well inside a rendered pixel.
    let ecl_pole_equ = equatorial_unit(270.0 * DEG, PI / 2.0 - sys.obliquity);
    let moon_north = (world_from_equ * ecl_pole_equ).normalize();
    let moon_sun_dir = (world_from_equ * moon_to_sun).normalize();
    let sun_dir = horizontal_dir(wrap(sun_az / DEG, 360.0) as f32, (sun_elev / DEG) as f32);
    let sub_earth_lon = optical_libration_longitude(&sys);
    let sub_earth_lat = (moon_to_earth
        .dot(world_from_equ.transpose() * moon_north)
        .clamp(-1.0, 1.0))
    .asin();

    let mat_rows = |m: Mat3| {
        [
            [m.x_axis.x, m.y_axis.x, m.z_axis.x],
            [m.x_axis.y, m.y_axis.y, m.z_axis.y],
            [m.x_axis.z, m.y_axis.z, m.z_axis.z],
        ]
    };

    let moon = MoonState {
        elevation_deg: elev_deg,
        azimuth_deg: az_deg,
        distance_km,
        illuminated_fraction: illuminated as f32,
        phase_angle_deg: (phase_angle / DEG) as f32,
        angular_diameter_deg: (2.0 * angular_radius / DEG) as f32,
        direct_normal_lux: direct,
        horizontal_lux: horizontal,
        above_horizon: elev_deg > 0.0,
    };
    let frame = CelestialFrame {
        equ_from_world: mat_rows(equ_from_world),
        moon_dir: moon_dir.to_array(),
        moon_north: moon_north.to_array(),
        moon_sun_dir: moon_sun_dir.to_array(),
        sun_dir: sun_dir.to_array(),
        sun_elevation_deg: (sun_elev / DEG) as f32,
        angular_radius_rad: angular_radius as f32,
        sub_earth_lon_deg: (sub_earth_lon / DEG) as f32,
        sub_earth_lat_deg: (sub_earth_lat as f64 / DEG) as f32,
        local_sidereal_deg: wrap(lst / DEG, 360.0) as f32,
        precession_arcsec,
    };

    let active = c.fixtures.len().min(c.fixture_budget.min(12));
    let mut ledger = vec![
        SourceLedgerEntry {
            id: "moon".into(),
            kind: "celestial_directional".into(),
            nominal_value: direct,
            nominal_unit: "lx direct-normal at ground".into(),
            renderer_internal_value: direct * internal_scale,
            active_layers: vec!["direct".into(), "disc".into(), "atmosphere".into()],
            shadows: moon_shadows && direct > 0.03,
            confidence: 0.90,
            provenance:
                "Schlyter lunar series with principal perturbations, WGS84 topocentric parallax, \
                 true Sun-Moon-Earth phase angle"
                    .into(),
        },
        SourceLedgerEntry {
            id: "natural-night-sky".into(),
            kind: "sky_ibl".into(),
            nominal_value: c.natural_ambient_lux.clamp(0.001, 0.003),
            nominal_unit: "lx integrated horizontal".into(),
            renderer_internal_value: c.natural_ambient_lux.clamp(0.001, 0.003) * internal_scale,
            active_layers: vec!["background".into(), "ibl".into()],
            shadows: false,
            confidence: 0.85,
            provenance:
                "NASA/SVS Deep Star Maps 2020 plate (public domain) closed against the site's \
                 natural airglow illuminance"
                    .into(),
        },
        SourceLedgerEntry {
            id: "urban-skyglow".into(),
            kind: "sky_ibl".into(),
            nominal_value: c.urban_skyglow_lux.clamp(0.0, 0.3),
            nominal_unit: "lx integrated horizontal".into(),
            renderer_internal_value: c.urban_skyglow_lux.clamp(0.0, 0.3) * internal_scale,
            active_layers: vec!["background".into(), "ibl".into()],
            shadows: false,
            confidence: 0.65,
            provenance: "explicit site control; neutral horizon radiance, not GlobalAmbientLight"
                .into(),
        },
    ];
    for (idx, f) in c.fixtures.iter().take(active).enumerate() {
        ledger.push(SourceLedgerEntry {
            id: format!("street:{}", f.source_id),
            kind: "street_spot".into(),
            nominal_value: f.lumens,
            nominal_unit: "lm".into(),
            renderer_internal_value: f.lumens * internal_scale,
            active_layers: vec!["emissive_proxy".into(), "local_direct".into()],
            shadows: idx < c.fixture_shadow_budget.min(2),
            confidence: f.confidence,
            provenance: format!("OpenDRIVE object {} via {}", f.source_name, f.rule),
        });
    }

    // The plate carries resolved starlight and diffuse Galactic light only:
    // no airglow and no zodiacal band. Those are the majority of a moonless
    // sky's illuminance, so the plate is closed against the ~25% share that
    // is actually stellar (Leinert et al. 1998, table of night-sky
    // components), integrated over a hemisphere rather than divided by pi.
    let starlight_lux = c.natural_ambient_lux.clamp(0.001, 0.003) * STARLIGHT_SHARE;
    let photometric_gain = starlight_lux / (2.0 * PI as f32 * STAR_PLATE_MEAN);

    NightEnvironment {
        celestial: moon,
        frame,
        natural_ambient_lux: c.natural_ambient_lux.clamp(0.001, 0.003),
        urban_skyglow_lux: c.urban_skyglow_lux.clamp(0.0, 0.3),
        star_catalog: "NASA/Goddard SVS Deep Star Maps 2020 (Gaia DR2 + Hipparcos-2 + Tycho-2 + \
                       Yale BSC), public domain"
            .into(),
        star_count: 1_700_000_000,
        limiting_magnitude: c.limiting_magnitude.clamp(-1.5, 7.0),
        milky_way_model: "resolved in the NASA plate; not a procedural approximation".into(),
        cloud_model: match c.cloud_quality {
            CloudQuality::Off => "off",
            CloudQuality::Scalable => {
                "volumetric: metric-step shell raymarch (96-sample budget), multi-octave 3D density, 4-step light march"
            }
            CloudQuality::Lookdev => {
                "volumetric: metric-step shell raymarch (160-sample budget), multi-octave 3D density, 6-step light march"
            }
        }
        .into(),
        cloud_quality: c.cloud_quality,
        cloud_wind_offset_m: [0.0, 0.0],
        cloud_beam_transmittance: 1.0,
        cloud_zenith_optical_depth: 0.0,
        cloud_animation_seconds: 0.0,
        cloud_continuous: c.cloud_quality != CloudQuality::Off,
        sky_photometric_gain: photometric_gain,
        sky_display_lift: c.sky_display_lift.clamp(1.0, 600.0),
        fixtures_detected: c.fixtures.len(),
        fixtures_active: active,
        fixture_budget: c.fixture_budget,
        window_mode: c.window_mode.as_str().into(),
        source_ledger: ledger,
    }
}

/// Solid-angle-weighted mean luminance of the star plate, measured by
/// `tools/prepare_sky_assets.py` and recorded in `assets/sky/SOURCES.json`.
/// It closes the plate's arbitrary units against the site's natural sky
/// illuminance.
pub const STAR_PLATE_MEAN: f32 = 0.004_620_27;

/// Share of the natural night-sky illuminance that is resolved starlight plus
/// diffuse Galactic light, the two components the plate actually contains.
pub const STARLIGHT_SHARE: f32 = 0.25;

// ---------------------------------------------------------------------- IBL

/// Small diffuse cubemap for `EnvironmentMapLight`.
///
/// This is the ambient *energy* only: no stars, no lunar disc (the Moon is a
/// `DirectionalLight`), no visible detail. It is deliberately tiny, because
/// the visible sky is now a per-pixel pass and this map only has to integrate
/// correctly.
///
/// `daylight` gives the residual daylight sky's radiance in a direction,
/// cd/m^2 per channel, nominal units, above the horizon; the probe takes
/// over from the atmosphere's IBL at the handover, and carrying that term
/// keeps the ambient continuous across it. Below the horizon the ground
/// reflects a quarter of `daylight_ground`.
pub fn celestial_ibl_cubemap(
    env: &NightEnvironment,
    field: &crate::clouds::CloudField,
    cloud: &crate::clouds::CloudParams,
    daylight: &dyn Fn(Vec3) -> Vec3,
    daylight_ground: Vec3,
    face_size: u32,
    internal_scale: f32,
) -> Image {
    let n = face_size;
    let natural = env.natural_ambient_lux / PI as f32 * internal_scale;
    let urban = env.urban_skyglow_lux / PI as f32 * internal_scale;
    let moon_dir = Vec3::from_array(env.frame.moon_dir);
    let moon_lux = env.celestial.direct_normal_lux * internal_scale;
    let mut texels: Vec<f32> = Vec::with_capacity((n * n * 6 * 4) as usize);
    for f in 0..6u32 {
        for y in 0..n {
            for x in 0..n {
                let s = 2.0 * (x as f32 + 0.5) / n as f32 - 1.0;
                let t = 2.0 * (y as f32 + 0.5) / n as f32 - 1.0;
                let dir = crate::atmosphere::cube_direction(f, s, t);
                let horizon = (1.0 - dir.y.max(0.0)).powf(3.0);
                // The daylight term is the model's own sky, already closed
                // against the two-stream diffuse (deck included), so the
                // deck is *not* applied to it again below: attenuating it a
                // second time under-lit cloudy dusk by the deck's
                // transmittance.
                let twilight_here = if dir.y >= 0.0 {
                    daylight(dir) * internal_scale
                } else {
                    daylight_ground * (0.25 * internal_scale)
                };
                let mut col = Vec3::new(0.50, 0.62, 0.82) * natural
                    + Vec3::new(0.78, 0.80, 0.88) * urban * (0.22 + 1.9 * horizon);
                if cloud.cover > 0.001 && dir.y > 0.01 {
                    let tau = field.optical_depth(Vec2::ZERO, 0.0, dir, cloud, 10);
                    let transmit = (-tau).exp();
                    // Overcast redistributes the moon's beam into a broad
                    // diffuse source and reflects the city back down.
                    let lit = Vec3::new(0.94, 0.96, 1.0)
                        * moon_lux
                        * 0.06
                        * moon_dir.dot(dir).max(0.0)
                        + Vec3::new(0.78, 0.80, 0.88) * urban * 2.2;
                    col = col * transmit + lit * (1.0 - transmit);
                }
                col += twilight_here;
                texels.extend_from_slice(&[col.x, col.y, col.z, 1.0]);
            }
        }
    }
    let mut data = Vec::with_capacity(texels.len() * 4);
    for q in texels {
        data.extend_from_slice(&q.to_le_bytes());
    }
    let mut image = Image::new(
        Extent3d {
            width: n,
            height: n,
            depth_or_array_layers: 6,
        },
        TextureDimension::D2,
        data,
        TextureFormat::Rgba32Float,
        RenderAssetUsages::default(),
    );
    image.texture_view_descriptor = Some(TextureViewDescriptor {
        dimension: Some(TextureViewDimension::Cube),
        ..Default::default()
    });
    image
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lunar_state_is_deterministic_and_photometrically_bounded() {
        let controls = NightControls {
            utc_day_of_year: 244,
            utc_minutes: 60.0,
            ..Default::default()
        };
        let a = resolve_night(&controls, 16.0, true);
        let b = resolve_night(&controls, 16.0, true);
        assert_eq!(a.celestial.elevation_deg, b.celestial.elevation_deg);
        assert!((0.0..=0.33).contains(&a.celestial.direct_normal_lux));
        assert!((0.0..=1.0).contains(&a.celestial.illuminated_fraction));
    }

    #[test]
    fn angular_diameter_is_the_real_half_degree() {
        for day in [10u16, 100, 200, 300] {
            for minute in [0.0_f32, 360.0, 720.0, 1080.0] {
                let env = resolve_night(
                    &NightControls {
                        utc_day_of_year: day,
                        utc_minutes: minute,
                        ..Default::default()
                    },
                    1.0,
                    false,
                );
                let deg = env.celestial.angular_diameter_deg;
                assert!(
                    (0.48..=0.58).contains(&deg),
                    "lunar angular diameter {deg} deg is not physical"
                );
            }
        }
    }

    /// The rotation the star plate is sampled through must put the Moon where
    /// the independent horizon solution puts it.
    #[test]
    fn equatorial_rotation_agrees_with_the_horizon_solution() {
        let controls = NightControls {
            utc_day_of_year: 244,
            utc_minutes: 300.0,
            ..Default::default()
        };
        let jd = julian_day(&controls);
        let sys = solve(jd - 2451543.5);
        let gmst = wrap(280.46061837 + 360.98564736629 * (jd - 2451545.0), 360.0);
        let lst = (gmst + controls.longitude_deg) * DEG;
        let lat = controls.latitude_deg * DEG;
        let world_from_equ = world_from_equatorial_of_date(lat, lst);
        let by_matrix = world_from_equ * equatorial_unit(sys.moon_ra, sys.moon_dec);

        let h = wrap(lst - sys.moon_ra + PI, 2.0 * PI) - PI;
        let elev = (lat.sin() * sys.moon_dec.sin() + lat.cos() * sys.moon_dec.cos() * h.cos()).asin();
        let az = (-h.sin()).atan2(sys.moon_dec.tan() * lat.cos() - lat.sin() * h.cos());
        let by_horizon = horizontal_dir(wrap(az / DEG, 360.0) as f32, (elev / DEG) as f32);

        let sep = by_matrix.normalize().dot(by_horizon).clamp(-1.0, 1.0).acos();
        assert!(
            sep.to_degrees() < 0.01,
            "equatorial rotation disagrees with the horizon solution by {} deg",
            sep.to_degrees()
        );
    }

    /// Round trip: the transported plate direction must invert cleanly, and
    /// precession must be a rotation (it is applied to a unit sphere).
    #[test]
    fn equ_from_world_is_orthonormal() {
        let env = resolve_night(&NightControls::default(), 1.0, false);
        let r = env.frame.equ_from_world;
        let m = Mat3::from_cols(
            Vec3::new(r[0][0], r[1][0], r[2][0]),
            Vec3::new(r[0][1], r[1][1], r[2][1]),
            Vec3::new(r[0][2], r[1][2], r[2][2]),
        );
        let identity = m * m.transpose();
        for i in 0..3 {
            for j in 0..3 {
                let expected = if i == j { 1.0 } else { 0.0 };
                assert!(
                    (identity.col(i)[j] - expected).abs() < 1e-4,
                    "equ_from_world is not orthonormal"
                );
            }
        }
    }

    #[test]
    fn phase_tracks_the_synodic_month() {
        // Nine days apart the illuminated fraction must move a long way.
        let a = resolve_night(
            &NightControls {
                utc_day_of_year: 200,
                ..Default::default()
            },
            1.0,
            false,
        );
        let b = resolve_night(
            &NightControls {
                utc_day_of_year: 209,
                ..Default::default()
            },
            1.0,
            false,
        );
        assert!(
            (a.celestial.illuminated_fraction - b.celestial.illuminated_fraction).abs() > 0.25,
            "phase barely moved across nine days"
        );
    }

    #[test]
    fn sun_is_below_the_horizon_at_local_midnight() {
        let env = resolve_night(
            &NightControls {
                utc_day_of_year: 244,
                // 07:20 UTC is local midnight at -122.14 deg.
                utc_minutes: 440.0,
                ..Default::default()
            },
            1.0,
            false,
        );
        assert!(
            env.frame.sun_elevation_deg < -18.0,
            "sun elevation at local midnight is {}",
            env.frame.sun_elevation_deg
        );
    }
}
