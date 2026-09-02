//! A/B benchmark and physics probe for the physical atmosphere.
//!
//! Answers two questions with numbers rather than opinion:
//!
//! 1. **Cost.** What does the Hillaire-2020 atmosphere cost per frame,
//!    against the two static-sky baselines it replaces (the analytic gradient
//!    cubemap and a measured HDRI cubemap), on the same map, same camera,
//!    same render profile, at 720p / 1080p / 1440p?
//!
//!    The atmosphere's cost splits cleanly in two, and the split is
//!    *measurable* rather than asserted: the LUT chain (transmittance
//!    256x128 + multiscattering 32x32 + sky-view 400x200 + aerial 32^3 +
//!    the 6x256^2 environment probe) is resolution-independent, while the
//!    `render_sky` composite is per-pixel. So fitting the measured
//!    atmosphere-minus-baseline delta against pixel count as
//!    `delta(px) = fixed + per_px * px` separates them: `fixed` is the LUT
//!    chain, `per_px * px` is the sky + aerial-perspective composite.
//!
//!    Changing the sun or the weather costs extra only on the CPU (the
//!    1024x1024 density/phase LUT pair is rebuilt and re-uploaded); the GPU
//!    LUT chain is rebuilt every frame regardless, so a moving sun is free
//!    on the GPU. `relight` measures the former.
//!
//! 2. **Physics.** What does the model actually resolve at each of the
//!    validation conditions (solar position, transmittance, illuminance,
//!    sky luminance, EV100)? `--probe` prints that table without touching a
//!    GPU.
//!
//! Usage:
//!   sky-bench --scene run/yale-street-scene.json --out bench.json
//!   sky-bench --probe

use std::time::Instant;

use anyhow::{Context, Result};
use clap::Parser;
use render_core::atmosphere::AtmosphereInputs;
use render_core::engine::{CameraSpec, Lighting, PassSet, Profile, SceneApp};
use render_core::profiles::RenderProfileConfig;
use render_core::weather::Weather;
use serde::{Deserialize, Serialize};

#[derive(Parser, Debug)]
#[command(about = "Atmosphere A/B benchmark and physics probe")]
struct Args {
    /// Scene manifest: `{"glbs": [...], "vegGlbs": [...], "farM": ...}`.
    #[arg(long)]
    scene: Option<String>,
    /// Camera eye, world metres.
    #[arg(long, num_args = 3, value_delimiter = ',',
          default_value = "569.1356,14.1196,-1771.3687")]
    eye: Vec<f32>,
    /// Camera target, world metres.
    #[arg(long, num_args = 3, value_delimiter = ',',
          default_value = "554.114,13.1288,-1781.286")]
    target: Vec<f32>,
    /// Frames timed per configuration, after warmup.
    #[arg(long, default_value_t = 160)]
    frames: u32,
    /// Frames discarded before timing starts.
    #[arg(long, default_value_t = 40)]
    warmup: u32,
    /// Relights timed per sky mode.
    #[arg(long, default_value_t = 12)]
    relights: u32,
    /// Resolutions to sweep, `WxH` comma separated.
    #[arg(long, value_delimiter = ',', default_value = "1280x720,1920x1080,2560x1440")]
    resolutions: Vec<String>,
    /// HDRI to benchmark the cubemap path against. Defaults to the map's
    /// own `env/sky.hdr` when one exists beside the corpus.
    #[arg(long)]
    hdri: Option<String>,
    /// Write the benchmark JSON here.
    #[arg(long)]
    out: Option<String>,
    /// Print the physics probe table and exit without opening a GPU.
    #[arg(long, default_value_t = false)]
    probe: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SceneManifest {
    glbs: Vec<String>,
    #[serde(default)]
    veg_glbs: Vec<String>,
    #[serde(default = "default_near")]
    near_m: f32,
    #[serde(default = "default_far")]
    far_m: f32,
}

fn default_near() -> f32 {
    0.05
}
fn default_far() -> f32 {
    2000.0
}

/// One timed configuration.
#[derive(Serialize)]
struct ModeResult {
    mode: String,
    width: u32,
    height: u32,
    pixels: u32,
    frames: u32,
    mean_ms: f64,
    median_ms: f64,
    p95_ms: f64,
    p99_ms: f64,
    min_ms: f64,
    max_ms: f64,
    fps_median: f64,
}

#[derive(Serialize)]
struct RelightResult {
    mode: String,
    /// Wall time of `SceneApp::apply_lighting`, which for the atmosphere
    /// includes the CPU medium rebuild, the LUT upload and the settle
    /// warmup frames.
    median_ms: f64,
    p95_ms: f64,
    samples: u32,
    /// CPU time inside `atmosphere::resolve` alone (density + phase LUT
    /// construction), reported by the readback.
    medium_build_ms: f32,
}

/// Linear fit of the atmosphere-minus-baseline delta against pixel count.
#[derive(Serialize)]
struct CostSplit {
    baseline: String,
    /// Intercept, ms: the resolution-independent LUT chain.
    lut_chain_ms: f64,
    /// Slope, ms per megapixel: the sky + aerial-perspective composite.
    composite_ms_per_mpx: f64,
    /// Composite cost at each measured resolution, ms.
    composite_ms: Vec<(String, f64)>,
    /// Coefficient of determination of the two-point/three-point fit.
    r2: f64,
}

#[derive(Serialize)]
struct BenchReport {
    gpu: String,
    bevy: String,
    scene: String,
    profile: String,
    anti_alias: String,
    eye: Vec<f32>,
    target: Vec<f32>,
    near_m: f32,
    far_m: f32,
    warmup_frames: u32,
    modes: Vec<ModeResult>,
    relights: Vec<RelightResult>,
    cost_split: Vec<CostSplit>,
    atmosphere_readback: serde_json::Value,
}

fn percentile(sorted: &[f64], q: f64) -> f64 {
    if sorted.is_empty() {
        return 0.0;
    }
    let idx = ((sorted.len() - 1) as f64 * q).round() as usize;
    sorted[idx]
}

fn stats(mode: &str, w: u32, h: u32, mut samples: Vec<f64>) -> ModeResult {
    samples.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let n = samples.len();
    let mean = samples.iter().sum::<f64>() / n as f64;
    let median = percentile(&samples, 0.5);
    ModeResult {
        mode: mode.to_string(),
        width: w,
        height: h,
        pixels: w * h,
        frames: n as u32,
        mean_ms: mean,
        median_ms: median,
        p95_ms: percentile(&samples, 0.95),
        p99_ms: percentile(&samples, 0.99),
        min_ms: samples[0],
        max_ms: samples[n - 1],
        fps_median: if median > 0.0 { 1000.0 / median } else { 0.0 },
    }
}

/// The eight validation conditions, as physical atmosphere states.
fn probe_conditions() -> Vec<(&'static str, f32, f32, Weather, AtmosphereInputs)> {
    let at = |elev: f32, w: Weather| {
        let seed = w.atmosphere();
        AtmosphereInputs {
            sun_elevation_deg: elev,
            turbidity: seed.turbidity,
            ozone_du: render_core::atmosphere::REFERENCE_OZONE_DU,
            air_density: 1.0,
            visibility_m: seed.visibility_m,
            deck: seed.deck,
            cloud_cover: seed.cloud_cover,
            ground_albedo: render_core::atmosphere::GROUND_ALBEDO,
            ..Default::default()
        }
    };
    vec![
        ("clear-noon", 74.6, 195.0, Weather::Clear, at(74.6, Weather::Clear)),
        ("sunrise-0625", 6.6, 68.7, Weather::Clear, at(6.6, Weather::Clear)),
        ("golden-hour", 8.0, 292.0, Weather::Clear, at(8.0, Weather::Clear)),
        ("civil-twilight", -3.0, 300.0, Weather::Clear, at(-3.0, Weather::Clear)),
        ("night", -25.0, 20.0, Weather::Clear, at(-25.0, Weather::Clear)),
        ("cloudy-noon", 74.6, 195.0, Weather::Cloudy, at(74.6, Weather::Cloudy)),
        ("overcast-noon", 74.6, 195.0, Weather::Overcast, at(74.6, Weather::Overcast)),
        ("fog-morning", 20.0, 100.0, Weather::Fog, at(20.0, Weather::Fog)),
        ("rain-afternoon", 40.0, 250.0, Weather::Rain, at(40.0, Weather::Rain)),
    ]
}

fn run_probe() -> Result<()> {
    println!(
        "{:<16} {:>7} {:>8} {:>9} {:>9} {:>9} {:>8} {:>9} {:>9} {:>7} {:>6} {:>5}",
        "condition",
        "elev",
        "T(luma)",
        "E_dn lx",
        "E_dif lx",
        "E_tot lx",
        "EV100",
        "L_zen",
        "L_hor",
        "CCT K",
        "vis m",
        "tau_c",
    );
    let mut rows = Vec::new();
    for (name, elev, azim, _w, inputs) in probe_conditions() {
        let (_, r) = render_core::atmosphere::resolve(&inputs, azim, 2000.0);
        println!(
            "{:<16} {:>7.1} {:>8.4} {:>9.3} {:>9.3} {:>9.3} {:>8.2} {:>9.2} {:>9.2} {:>7.0} {:>6.0} {:>5.1}",
            name,
            elev,
            r.sun_transmittance_luma,
            r.direct_normal_illuminance_lx,
            r.diffuse_horizontal_illuminance_lx,
            r.total_horizontal_illuminance_lx,
            r.ev100,
            r.zenith_luminance_cdm2,
            r.horizon_luminance_cdm2,
            r.sun_cct_k,
            r.effective_visibility_m.min(999_999.0),
            r.cloud_optical_depth,
        );
        rows.push(serde_json::json!({ "condition": name, "readback": r }));
    }
    println!(
        "\nmedium LUT pair: {0}x{0} Rgba32Float x2 = {1:.1} MB",
        render_core::atmosphere::MEDIUM_LUT_RESOLUTION,
        (render_core::atmosphere::MEDIUM_LUT_RESOLUTION as f64).powi(2) * 16.0 / 1.0e6,
    );
    Ok(())
}

fn main() -> Result<()> {
    let args = Args::parse();
    if args.probe {
        return run_probe();
    }

    let scene_path = args
        .scene
        .clone()
        .context("--scene is required unless --probe")?;
    let manifest: SceneManifest = serde_json::from_str(
        &std::fs::read_to_string(&scene_path).with_context(|| format!("read {scene_path}"))?,
    )?;

    let hdri = args.hdri.clone().or_else(|| {
        manifest.glbs.first().and_then(|glb| {
            std::path::Path::new(glb).ancestors().skip(1).find_map(|a| {
                let c = a.join("env").join("sky.hdr");
                c.is_file().then(|| c.to_string_lossy().into_owned())
            })
        })
    });

    let resolutions: Vec<(u32, u32)> = args
        .resolutions
        .iter()
        .map(|s| {
            let (w, h) = s.split_once('x').context("resolution must be WxH")?;
            Ok::<_, anyhow::Error>((w.parse()?, h.parse()?))
        })
        .collect::<Result<_>>()?;

    // Same physical shot in every mode: 6.6 deg sun, clear air.
    let base = |atmosphere: bool, sky_hdr: Option<String>| Lighting {
        sun_elev_deg: 6.6,
        sun_azim_deg: 68.7,
        rung: 3,
        weather: Weather::Clear,
        atmosphere,
        sky_hdr,
        ..Default::default()
    };

    let mut modes: Vec<(&'static str, Lighting)> = vec![
        ("cubemap-analytic", base(false, None)),
        ("atmosphere", base(true, None)),
    ];
    if let Some(path) = hdri.clone() {
        modes.insert(1, ("cubemap-hdri", base(false, Some(path))));
    }

    let mut results: Vec<ModeResult> = Vec::new();
    let mut relights: Vec<RelightResult> = Vec::new();
    let mut readback = serde_json::Value::Null;
    let profile_config = RenderProfileConfig::default();

    for (mode, lighting) in &modes {
        eprintln!("[sky-bench] building scene for mode {mode}");
        let mut app = SceneApp::new_with_profile_config(lighting, profile_config)?;
        app.load_tiles(&manifest.glbs)?;
        if !manifest.veg_glbs.is_empty() {
            app.load_vegetation(&manifest.veg_glbs)?;
        }
        app.wait_until_ready()?;

        for (w, h) in &resolutions {
            app.add_camera(
                CameraSpec {
                    sensor_id: format!("bench{w}x{h}"),
                    width: *w,
                    height: *h,
                    fov_y_deg: 55.0,
                    near: manifest.near_m,
                    far: manifest.far_m,
                    passes: PassSet { rgb: true, id: false, depth: false },
                },
                Profile::Cinematic,
            );
            app.set_pose(
                &format!("bench{w}x{h}"),
                &[args.eye[0], args.eye[1], args.eye[2]],
                &[args.target[0], args.target[1], args.target[2]],
            )?;
            // Warm the pipeline caches, the TAA history and the LUT chain.
            app.warmup(args.warmup);

            let mut samples = Vec::with_capacity(args.frames as usize);
            for _ in 0..args.frames {
                let t0 = Instant::now();
                let _ = app.render_once()?;
                samples.push(t0.elapsed().as_secs_f64() * 1000.0);
            }
            let r = stats(mode, *w, *h, samples);
            eprintln!(
                "[sky-bench] {mode} {w}x{h}: median {:.2} ms  p95 {:.2} ms",
                r.median_ms, r.p95_ms
            );
            results.push(r);
            app.remove_camera(&format!("bench{w}x{h}"));
        }

        // Relight cost: a real weather + sun change, which on the atmosphere
        // path rebuilds the whole scattering medium.
        app.add_camera(
            CameraSpec {
                sensor_id: "relight".into(),
                width: 1920,
                height: 1080,
                fov_y_deg: 55.0,
                near: manifest.near_m,
                far: manifest.far_m,
                passes: PassSet { rgb: true, id: false, depth: false },
            },
            Profile::Cinematic,
        );
        app.set_pose(
            "relight",
            &[args.eye[0], args.eye[1], args.eye[2]],
            &[args.target[0], args.target[1], args.target[2]],
        )?;
        app.warmup(args.warmup);
        let mut relight_samples = Vec::new();
        let mut last_build = 0.0f32;
        for i in 0..args.relights {
            let mut next = lighting.clone();
            next.sun_elev_deg = 6.6 + (i as f32) * 4.0;
            next.weather = if i % 2 == 0 { Weather::Clear } else { Weather::Cloudy };
            let t0 = Instant::now();
            let resolved = app.apply_lighting(&next, profile_config)?;
            relight_samples.push(t0.elapsed().as_secs_f64() * 1000.0);
            if let Some(a) = resolved.atmosphere.as_ref() {
                last_build = a.medium_build_ms;
                readback = serde_json::to_value(a)?;
            }
            let _ = app.render_once()?;
        }
        relight_samples.sort_by(|a, b| a.partial_cmp(b).unwrap());
        relights.push(RelightResult {
            mode: mode.to_string(),
            median_ms: percentile(&relight_samples, 0.5),
            p95_ms: percentile(&relight_samples, 0.95),
            samples: relight_samples.len() as u32,
            medium_build_ms: last_build,
        });
        eprintln!(
            "[sky-bench] {mode} relight: median {:.1} ms (medium build {:.1} ms)",
            percentile(&relight_samples, 0.5),
            last_build
        );
    }

    // Separate the fixed LUT-chain cost from the per-pixel composite cost by
    // regressing the atmosphere-minus-baseline delta on pixel count.
    let find = |mode: &str, w: u32, h: u32| {
        results
            .iter()
            .find(|r| r.mode == mode && r.width == w && r.height == h)
            .map(|r| r.median_ms)
    };
    let mut cost_split = Vec::new();
    for baseline in ["cubemap-analytic", "cubemap-hdri"] {
        let points: Vec<(f64, f64, String)> = resolutions
            .iter()
            .filter_map(|(w, h)| {
                let a = find("atmosphere", *w, *h)?;
                let b = find(baseline, *w, *h)?;
                Some(((w * h) as f64, a - b, format!("{w}x{h}")))
            })
            .collect();
        if points.len() < 2 {
            continue;
        }
        let n = points.len() as f64;
        let sx: f64 = points.iter().map(|p| p.0).sum();
        let sy: f64 = points.iter().map(|p| p.1).sum();
        let sxx: f64 = points.iter().map(|p| p.0 * p.0).sum();
        let sxy: f64 = points.iter().map(|p| p.0 * p.1).sum();
        let denom = n * sxx - sx * sx;
        let slope = if denom.abs() > 0.0 { (n * sxy - sx * sy) / denom } else { 0.0 };
        let intercept = (sy - slope * sx) / n;
        let mean_y = sy / n;
        let ss_tot: f64 = points.iter().map(|p| (p.1 - mean_y).powi(2)).sum();
        let ss_res: f64 = points
            .iter()
            .map(|p| (p.1 - (intercept + slope * p.0)).powi(2))
            .sum();
        cost_split.push(CostSplit {
            baseline: baseline.to_string(),
            lut_chain_ms: intercept,
            composite_ms_per_mpx: slope * 1.0e6,
            composite_ms: points.iter().map(|p| (p.2.clone(), slope * p.0)).collect(),
            r2: if ss_tot > 0.0 { 1.0 - ss_res / ss_tot } else { 1.0 },
        });
    }

    let report = BenchReport {
        gpu: gpu_name(),
        bevy: "0.19.1".into(),
        scene: scene_path,
        profile: "cinematic".into(),
        anti_alias: format!("{:?}", profile_config.cinematic.aa),
        eye: args.eye.clone(),
        target: args.target.clone(),
        near_m: manifest.near_m,
        far_m: manifest.far_m,
        warmup_frames: args.warmup,
        modes: results,
        relights,
        cost_split,
        atmosphere_readback: readback,
    };

    let json = serde_json::to_string_pretty(&report)?;
    match args.out {
        Some(path) => {
            std::fs::write(&path, &json)?;
            eprintln!("[sky-bench] wrote {path}");
        }
        None => println!("{json}"),
    }
    Ok(())
}

fn gpu_name() -> String {
    std::process::Command::new("nvidia-smi")
        .args(["--query-gpu=name", "--format=csv,noheader"])
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "unknown".into())
}
