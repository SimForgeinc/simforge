//! IMU / GNSS derivation from the ego track (pure engine-state math, no
//! rendering).
//!
//! - Accelerometer: finite difference of ego velocity (m/s^2, world frame,
//!   also projected into the ego body frame).
//! - Gyroscope: yaw rate from the ego quaternion derivative; the harness
//!   feeds `angularVelocityY` when present, else a heading finite difference.
//! - GNSS: inverse transverse-Mercator of the map-frame (x, y) using the
//!   `+proj=tmerc` parameters from the map's OpenDRIVE `geoReference`
//!   (RoadRunner exports: lat_0/lon_0 origin, k=1, WGS84). Altitude is the
//!   transform's y (up) in metres.

use bevy::prelude::Resource;
use serde::Serialize;

/// Inverse transverse Mercator (Krüger series, USGS/Snyder 8-12), sufficient
/// to sub-millimetre for these map extents. Deterministic pure float math.
#[derive(Debug, Clone, Copy, Resource)]
pub struct TmercOrigin {
    pub lat0_rad: f64,
    pub lon0_rad: f64,
    pub k: f64,
    /// False easting/northing (x_0/y_0) in metres — RoadRunner uses 0.
    pub x0: f64,
    pub y0: f64,
}

impl TmercOrigin {
    /// Parse `+proj=tmerc +lat_0=.. +lon_0=.. +k=.. +x_0=.. +y_0=..` from a
    /// geoReference string.
    pub fn parse(geo_ref: &str) -> Option<TmercOrigin> {
        let get = |key: &str| -> Option<f64> {
            let pat = format!("+{key}=");
            let idx = geo_ref.find(&pat)? + pat.len();
            let rest = &geo_ref[idx..];
            let end = rest
                .find(|c: char| c.is_whitespace() || c == '+')
                .unwrap_or(rest.len());
            rest[..end].trim().parse().ok()
        };
        // Only tmerc is supported by our maps' exports.
        if !geo_ref.contains("+proj=tmerc") {
            return None;
        }
        Some(TmercOrigin {
            lat0_rad: get("lat_0")?.to_radians(),
            lon0_rad: get("lon_0")?.to_radians(),
            k: get("k").unwrap_or(1.0),
            x0: get("x_0").unwrap_or(0.0),
            y0: get("y_0").unwrap_or(0.0),
        })
    }

    /// Map easting/northing (metres) -> WGS84 geodetic (lat/lon degrees).
    pub fn inverse(&self, easting: f64, northing: f64) -> (f64, f64) {
        const A: f64 = 6_378_137.0;
        const F: f64 = 1.0 / 298.257_223_563;
        let e2 = 2.0 * F - F * F;
        let ep2 = e2 / (1.0 - e2);
        let k0 = self.k;
        // Snyder 8-12 assumes the northing is measured from the equator;
        // RoadRunner exports use a local origin at lat_0 (x_0=y_0=0), so
        // re-base by adding the meridional arc of the latitude of origin.
        let m0 = Self::meridional_arc(self.lat0_rad);
        let m = m0 + (northing - self.y0) / k0;
        let mu = m / (A * (1.0 - e2 / 4.0 - 3.0 * e2 * e2 / 64.0 - 5.0 * e2 * e2 * e2 / 256.0));
        let e1 = (1.0 - (1.0 - e2).sqrt()) / (1.0 + (1.0 - e2).sqrt());
        let phi1 = mu
            + (3.0 * e1 / 2.0 - 27.0 * e1.powi(3) / 32.0) * (2.0 * mu).sin()
            + (21.0 * e1 * e1 / 16.0 - 55.0 * e1.powi(4) / 32.0) * (4.0 * mu).sin()
            + (151.0 * e1.powi(3) / 96.0) * (6.0 * mu).sin()
            + (1097.0 * e1.powi(4) / 512.0) * (8.0 * mu).sin();

        let sin_phi1 = phi1.sin();
        let cos_phi1 = phi1.cos();
        let tan_phi1 = phi1.tan();
        let c1 = ep2 * cos_phi1 * cos_phi1;
        let t1 = tan_phi1 * tan_phi1;
        let n1 = A / (1.0 - e2 * sin_phi1 * sin_phi1).sqrt();
        let r1 = A * (1.0 - e2) / (1.0 - e2 * sin_phi1 * sin_phi1).powf(1.5);
        let d = (easting - self.x0) / (n1 * k0);

        let lat = phi1
            - (n1 * tan_phi1 / r1)
                * (d * d / 2.0
                    - (5.0 + 3.0 * t1 + 10.0 * c1 - 4.0 * c1 * c1 - 9.0 * ep2) * d.powi(4) / 24.0
                    + (61.0 + 90.0 * t1 + 298.0 * c1 + 45.0 * t1 * t1 - 252.0 * ep2
                        - 3.0 * c1 * c1)
                        * d.powi(6)
                        / 720.0);
        let lon = self.lon0_rad
            + (d
                - (1.0 + 2.0 * t1 + c1) * d.powi(3) / 6.0
                + (5.0 - 2.0 * c1 + 28.0 * t1 - 3.0 * c1 * c1 + 8.0 * ep2 + 24.0 * t1 * t1)
                    * d.powi(5)
                    / 120.0)
                / cos_phi1;

        (lat.to_degrees(), lon.to_degrees())
    }

    /// Meridional arc from the equator to latitude `phi` (Snyder 3-26).
    fn meridional_arc(phi: f64) -> f64 {
        const A: f64 = 6_378_137.0;
        const F: f64 = 1.0 / 298.257_223_563;
        let e2 = 2.0 * F - F * F;
        let e1 = e2; // series uses eccentricity powers directly
        A * ((1.0 - e2 / 4.0 - 3.0 * e2 * e2 / 64.0 - 5.0 * e2 * e2 * e2 / 256.0) * phi
            - (3.0 * e1 / 8.0 + 3.0 * e1 * e1 / 32.0 + 45.0 * e1 * e1 * e1 / 1024.0)
                * (2.0 * phi).sin()
            + (15.0 * e1 * e1 / 256.0 + 45.0 * e1 * e1 * e1 / 1024.0) * (4.0 * phi).sin()
            - (35.0 * e1 * e1 * e1 / 3072.0) * (6.0 * phi).sin())
    }
}

/// One IMU sample in the ego body frame (x forward, y up, z left).
#[derive(Debug, Clone, Serialize)]
pub struct ImuSample {
    pub tick: u32,
    pub t: f64,
    /// Linear acceleration m/s^2, body frame.
    pub accel: [f32; 3],
    /// Angular velocity rad/s about body axes (yaw rate dominant).
    pub gyro: [f32; 3],
}

#[derive(Debug, Clone, Serialize)]
pub struct GnssSample {
    pub tick: u32,
    pub t: f64,
    pub latitude_deg: f64,
    pub longitude_deg: f64,
    /// Metres above WGS84 ellipsoid approximation (map up value).
    pub altitude_m: f32,
}
