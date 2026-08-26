//! Batch render jobs: one schedule of ticks x rig cameras -> pass artifacts.
//!
//! Job files are produced by the Node adapter (`@simforge-oss/native-renderer`)
//! from a validated render intent + verified input map. The renderer writes
//! raw artifacts plus `results.json` (per-artifact sha256 + timings); the
//! adapter wraps those into the render-runtime artifact manifest.
//!
//! Determinism: PNGs encode via the `image` crate with fixed settings; depth
//! is written as little-endian Depth32Float (reverse-Z) raw rows.
use crate::engine::{CameraSpec, Lighting, PassSet, Profile, SceneApp};
use crate::profiles::RenderProfileConfig;
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Instant;

pub const NATIVE_RENDER_JOB_SCHEMA_V1: &str = "uniscenario.native-render-job/v1";
pub const NATIVE_RENDER_RESULTS_SCHEMA_V1: &str = "uniscenario.native-render-results/v1";

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderJob {
    pub schema: String,
    pub profile: Profile,
    #[serde(default)]
    pub lighting: Lighting,
    /// Cinematic pipeline settings. Ignored by sensor cameras.
    #[serde(default)]
    pub profile_config: RenderProfileConfig,
    pub glbs: Vec<String>,
    /// Vegetation prototype GLBs; each must have a sibling
    /// `.instances.json` sidecar.
    #[serde(default)]
    pub veg_glbs: Vec<String>,
    #[serde(default = "default_warmup")]
    pub warmup_frames: u32,
    #[serde(default = "default_near")]
    pub near_m: f32,
    #[serde(default = "default_far")]
    pub far_m: f32,
    #[serde(default = "default_passes")]
    pub passes: PassSet,
    /// Optional road-detail layer (simforge.road-detail/v1 sidecar paths),
    /// applied after scene readiness. Absent -> legacy output, byte-identical.
    #[serde(default)]
    pub road_detail: Option<RoadDetailJob>,
    pub schedule: Vec<ScheduleEntry>,
    pub out_dir: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoadDetailJob {
    pub sidecars: Vec<String>,
}

fn default_warmup() -> u32 {
    10
}
fn default_near() -> f32 {
    0.5
}
fn default_far() -> f32 {
    900.0
}
fn default_passes() -> PassSet {
    PassSet { rgb: true, id: true, depth: true }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleEntry {
    #[serde(default)]
    pub t_seconds: Option<f64>,
    /// Frame index within the source clip (echoed into results).
    #[serde(default)]
    pub frame_index: u32,
    pub cameras: Vec<JobCamera>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobCamera {
    pub sensor_id: String,
    pub width: u32,
    pub height: u32,
    /// Vertical FOV degrees.
    pub fov_deg: f32,
    pub eye: [f32; 3],
    pub target: [f32; 3],
    /// Optional per-camera override. This lets a cinematic chase camera render
    /// beside a sensor-profile rig in the same scene/tick.
    #[serde(default)]
    pub profile: Option<Profile>,
}

/// One produced artifact file, hashed for the artifact manifest.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactRecord {
    pub frame_index: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub t_seconds: Option<f64>,
    pub sensor_id: String,
    /// `rgb | id | depth | depth_viz`
    pub pass: String,
    pub relative_path: String,
    pub sha256: String,
    pub size_bytes: u64,
    pub media_type: String,
    pub width: u32,
    pub height: u32,
}

#[derive(Clone, Debug, Serialize)]
pub struct LegendRecord {
    pub id: u32,
    pub name: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderResults {
    pub schema: &'static str,
    pub profile: Profile,
    pub legend: Vec<LegendRecord>,
    pub artifacts: Vec<ArtifactRecord>,
    pub timings: JobTimings,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobTimings {
    pub scene_ready_ms: f64,
    pub warmup_frames: u32,
    pub frames_rendered: u32,
    pub avg_frame_ms: f64,
    pub p50_frame_ms: f64,
    pub p99_frame_ms: f64,
    pub fps: f64,
}

/// Execute one render job end-to-end. Returns the results document, which is
/// also persisted to `<out_dir>/results.json`.
pub fn run_job(job: &RenderJob) -> Result<RenderResults> {
    if job.schema != NATIVE_RENDER_JOB_SCHEMA_V1 {
        bail!("job schema must be {NATIVE_RENDER_JOB_SCHEMA_V1}, got {}", job.schema);
    }
    if job.schedule.is_empty() {
        bail!("job schedule is empty");
    }
    let out_dir = PathBuf::from(&job.out_dir);
    std::fs::create_dir_all(out_dir.join("frames"))
        .with_context(|| format!("create {}", out_dir.display()))?;

    // Register one camera group per distinct sensor; geometry must agree
    // across schedule entries (a rig is rigid).
    struct CamGeom {
        width: u32,
        height: u32,
        fov_deg: f32,
        profile: Profile,
    }
    let mut geoms: HashMap<String, CamGeom> = HashMap::new();
    for entry in &job.schedule {
        for cam in &entry.cameras {
            let profile = cam.profile.unwrap_or(job.profile);
            match geoms.get(&cam.sensor_id) {
                Some(g) => {
                    if g.width != cam.width
                        || g.height != cam.height
                        || g.fov_deg != cam.fov_deg
                        || g.profile != profile
                    {
                        bail!(
                            "camera {} changed geometry or profile across schedule",
                            cam.sensor_id
                        );
                    }
                }
                None => {
                    geoms.insert(
                        cam.sensor_id.clone(),
                        CamGeom {
                            width: cam.width,
                            height: cam.height,
                            fov_deg: cam.fov_deg,
                            profile,
                        },
                    );
                }
            }
        }
    }

    let t_start = Instant::now();
    let mut app = SceneApp::new_with_profile_config(&job.lighting, job.profile_config)?;
    app.load_tiles(&job.glbs)?;
    app.load_vegetation(&job.veg_glbs)?;
    let mut sensors: Vec<&String> = geoms.keys().collect();
    sensors.sort(); // deterministic camera order -> deterministic entity order
    for sensor_id in sensors {
        let g = &geoms[sensor_id];
        app.add_camera(
            CameraSpec {
                sensor_id: sensor_id.clone(),
                width: g.width,
                height: g.height,
                fov_y_deg: g.fov_deg,
                near: job.near_m,
                far: job.far_m,
                passes: job.passes,
            },
            g.profile,
        );
    }
    let legend = app.wait_until_ready()?;

    // Optional road-detail layer: swap the named road/marking materials to
    // the extended splat/wear material before pipeline warmup.
    if let Some(rd) = &job.road_detail {
        for sidecar in &rd.sidecars {
            let stats = app.apply_road_detail(sidecar)?;
            eprintln!(
                "road-detail: {sidecar} -> {} road + {} marking entities",
                stats.road_entities, stats.marking_entities
            );
        }
    }
    let scene_ready_ms = t_start.elapsed().as_secs_f64() * 1000.0;

    // Warmup at the first pose set so pipelines/shaders compile before capture.
    apply_poses(&mut app, &job.schedule[0])?;
    app.warmup(job.warmup_frames);

    let mut records: Vec<ArtifactRecord> = Vec::new();
    let mut frame_ms: Vec<f64> = Vec::new();
    for entry in &job.schedule {
        apply_poses(&mut app, entry)?;
        let t0 = Instant::now();
        let passes = app.render_once()?;
        frame_ms.push(t0.elapsed().as_secs_f64() * 1000.0);

        for cam in &entry.cameras {
            for (pass, key) in [
                ("rgb", format!("{}:rgb", cam.sensor_id)),
                ("id", format!("{}:id", cam.sensor_id)),
                ("depth", format!("{}:depth", cam.sensor_id)),
            ] {
                if !passes.contains_key(&key) {
                    continue; // pass disabled for this job
                }
                let data = &passes[&key];
                let pixel = 4usize;
                let raw = crate::engine::strip_padding(data, cam.width as usize, cam.height as usize, pixel);
                match pass {
                    "rgb" | "id" => {
                        let img = image::RgbaImage::from_raw(cam.width, cam.height, raw)
                            .context("rgba image")?;
                        let name = format!(
                            "frames/frame-{:05}.{}.{}.png",
                            entry.frame_index, cam.sensor_id, pass
                        );
                        let path = out_dir.join(&name);
                        img.save(&path).with_context(|| format!("save {name}"))?;
                        records.push(file_record(
                            entry, cam, pass, &name, &path, "image/png",
                        ));
                    }
                    "depth" => {
                        // Raw reverse-Z Depth32Float payload.
                        let name = format!(
                            "frames/frame-{:05}.{}.depth.f32.bin",
                            entry.frame_index, cam.sensor_id
                        );
                        let path = out_dir.join(&name);
                        std::fs::write(&path, &raw)
                            .with_context(|| format!("write {name}"))?;
                        records.push(file_record(
                            entry, cam, "depth", &name, &path, "application/octet-stream",
                        ));
                        // Grayscale visualization next to the raw payload.
                        let floats: Vec<f32> = raw
                            .chunks_exact(4)
                            .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
                            .collect();
                        let mut png = image::GrayImage::new(cam.width, cam.height);
                        for (i, d) in floats.iter().enumerate() {
                            let v = (d.clamp(0.0, 1.0) * 255.0) as u8;
                            let x = (i % cam.width as usize) as u32;
                            let y = (i / cam.width as usize) as u32;
                            png.put_pixel(x, y, image::Luma([v]));
                        }
                        let vname = format!(
                            "frames/frame-{:05}.{}.depth.viz.png",
                            entry.frame_index, cam.sensor_id
                        );
                        let vpath = out_dir.join(&vname);
                        png.save(&vpath).with_context(|| format!("save {vname}"))?;
                        records.push(file_record(
                            entry, cam, "depth_viz", &vname, &vpath, "image/png",
                        ));
                    }
                    _ => unreachable!(),
                }
            }
        }
    }

    let legend_records: Vec<LegendRecord> =
        legend.iter().map(|l| LegendRecord { id: l.id, name: l.name.clone() }).collect();
    let timings = summarize_timings(scene_ready_ms, job.warmup_frames, &frame_ms);
    let results = RenderResults {
        schema: NATIVE_RENDER_RESULTS_SCHEMA_V1,
        profile: job.profile,
        legend: legend_records,
        artifacts: records,
        timings,
    };
    std::fs::write(
        out_dir.join("results.json"),
        serde_json::to_string_pretty(&results).context("serialize results")?,
    )?;
    Ok(results)
}

fn apply_poses(app: &mut SceneApp, entry: &ScheduleEntry) -> Result<()> {
    for cam in &entry.cameras {
        app.set_pose(&cam.sensor_id, &cam.eye, &cam.target)?;
    }
    Ok(())
}

fn file_record(
    entry: &ScheduleEntry,
    cam: &JobCamera,
    pass: &str,
    relative: &str,
    path: &Path,
    media_type: &str,
) -> ArtifactRecord {
    let bytes = std::fs::read(path).expect("read back artifact");
    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    ArtifactRecord {
        frame_index: entry.frame_index,
        t_seconds: entry.t_seconds,
        sensor_id: cam.sensor_id.clone(),
        pass: pass.to_string(),
        relative_path: relative.to_string(),
        sha256: hex(&hasher.finalize()),
        size_bytes: bytes.len() as u64,
        media_type: media_type.to_string(),
        width: cam.width,
        height: cam.height,
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn summarize_timings(scene_ready_ms: f64, warmup: u32, frame_ms: &[f64]) -> JobTimings {
    let mut sorted = frame_ms.to_vec();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let pct = |p: f64| -> f64 {
        if sorted.is_empty() {
            0.0
        } else {
            sorted[((sorted.len() - 1) as f64 * p) as usize]
        }
    };
    let avg = if frame_ms.is_empty() { 0.0 } else { frame_ms.iter().sum::<f64>() / frame_ms.len() as f64 };
    JobTimings {
        scene_ready_ms,
        warmup_frames: warmup,
        frames_rendered: frame_ms.len() as u32,
        avg_frame_ms: avg,
        p50_frame_ms: pct(0.5),
        p99_frame_ms: pct(0.99),
        fps: if avg > 0.0 { 1000.0 / avg } else { 0.0 },
    }
}
