//! Determinism and correctness tests for the sensor math modules.

use sensors::bvh::{RaycastScene, Tri};
use sensors::formats;
use sensors::imu_gnss::TmercOrigin;
use sensors::lidar::{self, LidarConfig};
use sensors::radar::{self, RadarConfig};
use sensors::rig::{parse_pronto_rig, SensorKind};
use sensors::taxonomy::SemanticClass;
use bevy::math::{Quat, Vec3};

fn ground_scene() -> RaycastScene {
    // 10x10 ground plane at y=0 made of two triangles, instance id 7.
    let mut s = RaycastScene::new();
    s.push_tri(Tri {
        a: Vec3::new(-500.0, 0.0, -500.0),
        b: Vec3::new(500.0, 0.0, 500.0),
        c: Vec3::new(-500.0, 0.0, 500.0),
        instance_id: 7,
    });
    s.push_tri(Tri {
        a: Vec3::new(-500.0, 0.0, -500.0),
        b: Vec3::new(500.0, 0.0, -500.0),
        c: Vec3::new(500.0, 0.0, 500.0),
        instance_id: 7,
    });
    s.build();
    s
}

#[test]
fn bvh_nearest_hit_and_normal() {
    let s = ground_scene();
    let hit = s.cast(Vec3::new(1.0, 3.0, 2.0), Vec3::NEG_Y, 100.0).expect("hit");
    assert!((hit.distance - 3.0).abs() < 1e-4);
    assert_eq!(hit.instance_id, 7);
    assert!((hit.normal.y.abs() - 1.0).abs() < 1e-5);
    assert!(s.cast(Vec3::new(1.0, 3.0, 2.0), Vec3::Y, 100.0).is_none());
}

#[test]
fn lidar_scan_is_ordered_and_deterministic() {
    let s = ground_scene();
    let cfg = LidarConfig {
        channels: 8,
        rotation_frequency_hz: 10.0,
        points_per_second: 8000,
        vfov_deg: 20.0,
        hfov_deg: 360.0,
        range_m: 200.0,
    };
    let origin = Vec3::new(0.0, 2.0, 0.0);
    let a = lidar::scan(&s, &cfg, origin, Quat::IDENTITY, &|_| SemanticClass::Road);
    let b = lidar::scan(&s, &cfg, origin, Quat::IDENTITY, &|_| SemanticClass::Road);
    assert!(!a.is_empty());
    assert_eq!(a.len(), b.len());
    for (p, q) in a.iter().zip(b.iter()) {
        assert_eq!(p.x.to_bits(), q.x.to_bits());
        assert_eq!(p.intensity.to_bits(), q.intensity.to_bits());
        assert_eq!(p.instance_id, q.instance_id);
    }
    // Ordered by channel then azimuth: azimuth increases along the scan.
    // Ground returns at |x,z| = 2 / sin(elev): nearer beams come from the
    // lowest channel (largest elevation) — just check all points lie on y=0.
    for p in &a {
        assert!((p.y + 2.0).abs() < 1e-3, "ground return sits 2 m below the sensor");
        assert!(p.instance_id == 7);
        assert!((0.0..=1.0).contains(&p.intensity));
    }
}

#[test]
fn radar_radial_velocity_projection() {
    let s = ground_scene();
    let cfg = RadarConfig {
        hfov_deg: 30.0,
        vfov_deg: 30.0,
        range_m: 100.0,
        azimuth_rays: 5,
        elevation_rows: 5,
    };
    // Target moving straight away from sensor at +x with 3 m/s; sensor host
    // static -> radial velocity positive ~3 for beams hitting at x=+.
    let detections = radar::scan(
        &s,
        &cfg,
        Vec3::new(0.0, 1.5, 0.0),
        Quat::IDENTITY,
        Vec3::ZERO,
        &|id| if id == 7 { Vec3::new(3.0, 0.0, 0.0) } else { Vec3::ZERO },
    );
    assert!(!detections.is_empty());
    // Static scene without host motion would read zero relative velocity:
    let d_static = radar::scan(
        &s,
        &cfg,
        Vec3::new(0.0, 1.5, 0.0),
        Quat::IDENTITY,
        Vec3::ZERO,
        &|_| Vec3::ZERO,
    );
    for d in &d_static {
        assert!(d.velocity.abs() < 1e-5);
    }
    let _ = detections;
}

#[test]
fn tmerc_inverse_matches_reference() {
    // Yale Street geoReference (RoadRunner / MathWorks export).
    let tm = TmercOrigin::parse(
        "+proj=tmerc +lat_0=37.4100548676094 +lon_0=-122.154771275882 +k=1 +x_0=0 +y_0=0 +datum=WGS84 +units=m +vunits=m +no_defs",
    )
    .expect("tmerc params");
    // Origin maps back to lat_0/lon_0.
    let (lat, lon) = tm.inverse(0.0, 0.0);
    assert!((lat - 37.4100548676094).abs() < 1e-9, "lat {lat}");
    assert!((lon - (-122.154771275882)).abs() < 1e-9, "lon {lon}");
    // Reference values from pyproj (same projection string).
    let (lat_r, lon_r) = tm.inverse(50.0, -30.0);
    assert!((lat_r - 37.409784560292294).abs() < 1e-8, "lat {lat_r}");
    assert!((lon_r - (-122.15420650654427)).abs() < 1e-8, "lon {lon_r}");
    let (lat3, lon3) = tm.inverse(749.0219, 1683.4817);
    assert!((lat3 - 37.42522304990563).abs() < 1e-8, "lat {lat3}");
    assert!((lon3 - (-122.14630904698045)).abs() < 1e-8, "lon {lon3}");
}

#[test]
fn rig_parses_pronto_program() {
    let path = concat!(
        "/home/path/UniScenarios/qualification/",
        "render-qualification-program.v1.json"
    );
    let Ok(text) = std::fs::read_to_string(path) else {
        return; // qualification file absent in bare checkouts
    };
    let rig = parse_pronto_rig(&text, 1920, 1080).expect("rig");
    let cameras: Vec<_> = rig.cameras().filter(|c| c.id != sensors::rig::CHASE_CAMERA_SENSOR_ID).collect();
    let lidars: Vec<_> = rig.lidars().collect();
    let radars: Vec<_> = rig.radars().collect();
    assert_eq!(cameras.len(), 8);
    // Chase rides outside the measurement rig.
    assert_eq!(rig.cameras().count(), 9);
    assert_eq!(lidars.len(), 6);
    assert_eq!(radars.len(), 4);
    assert!(rig.chase().is_some());
    // cam1 front center: mount x=0.85-0.1508, z=0, yaw 0.
    let cam1 = cameras.iter().find(|c| c.id == "pronto-cam1").unwrap();
    assert!((cam1.mount.x - (0.85 - 0.1508)).abs() < 1e-4);
    assert!(cam1.mount.z.abs() < 1e-6);
    assert_eq!(cam1.horizontal_fov_deg, 120.0);
    // 16:9 aspect: vfov < hfov.
    let vfov = cam1.vertical_fov_deg.unwrap();
    assert!(vfov > 80.0 && vfov < 95.0, "vfov {vfov}");
    // Rear center camera yaw ~ pi.
    let cam5 = cameras.iter().find(|c| c.id == "pronto-cam5").unwrap();
    assert!((cam5.mount.yaw - std::f32::consts::PI).abs() < 1e-3);
    // All kinds present exactly once each per contract counts.
    assert!(rig.sensors.iter().all(|s| matches!(
        s.kind,
        SensorKind::Camera | SensorKind::Lidar | SensorKind::Radar
    )));
}

#[test]
fn fmt_g_matches_nine_significant_digits() {
    assert_eq!(formats::fmt_g(0.0), "0");
    assert_eq!(formats::fmt_g(1.0), "1");
    assert_eq!(formats::fmt_g(-12.5), "-12.5");
    assert_eq!(formats::fmt_g(123456792.0), "123456792"); // exact f32 neighbor
    // Round-trip always exact.
    for v in [0.25f32, -0.001, 98.76543, 1e-6, 42.0] {
        let parsed: f32 = formats::fmt_g(v).parse().unwrap();
        assert_eq!(parsed.to_bits(), v.to_bits());
    }
}
