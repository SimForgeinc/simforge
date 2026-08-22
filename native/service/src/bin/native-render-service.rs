//! `native-render-service` — long-lived native render service (WSB5).
//!
//! Prewarms one map, then serves (scene-state tick, rig) requests over a unix
//! socket with frames handed off through a /dev/shm ring buffer.
//!
//! Usage:
//!   native-render-service --socket <path> --shm <path> [--shm-size-mb 256]
//!
//! scene.json: { glbs: [...], profile: "sensor"|"cinematic", lighting?: {...},
//!               nearM?, farM?, warmupFrames? }
use anyhow::{Context, Result};
use service::proto::NATIVE_SERVICE_PROTOCOL_VERSION;
use service::server::{prewarm, serve, ServiceState};
use service::shm::ShmRing;

fn main() -> Result<()> {
    let mut args = std::env::args().skip(1);
    let mut socket = None;
    let mut shm_path = None;
    let mut shm_size_mb = 256u64;
    let mut scene_path = None;
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--socket" => socket = Some(args.next().context("--socket requires a path")?),
            "--shm" => shm_path = Some(args.next().context("--shm requires a path")?),
            "--shm-size-mb" => {
                shm_size_mb = args.next().context("--shm-size-mb requires a number")?.parse()?;
            }
            "--scene" => scene_path = Some(args.next().context("--scene requires a path")?),
            other => anyhow::bail!("unknown argument {other}"),
        }
    }
    let socket = socket.context("missing --socket")?;
    let shm_path = shm_path.unwrap_or_else(|| format!("/dev/shm/uniscenarios-native-render.{pid}", pid = std::process::id()));
    let scene_path = scene_path.context("missing --scene")?;

    let spec: service::server::SceneSpec = serde_json::from_str(
        &std::fs::read_to_string(&scene_path).with_context(|| format!("read {scene_path}"))?,
    )
    .with_context(|| format!("parse {scene_path}"))?;
    eprintln!(
        "native-render-service v{} prewarming {} tiles (profile {:?})...",
        NATIVE_SERVICE_PROTOCOL_VERSION,
        spec.glbs.len(),
        spec.profile
    );
    let t0 = std::time::Instant::now();
    let app = prewarm(&spec)?;
    eprintln!("prewarmed in {:.1} s", t0.elapsed().as_secs_f64());

    // Round capacity up to a multiple that fits whole frame sets; the ring is
    // large enough for many 736x416 RGBA + f32 depth records by default.
    let capacity = (shm_size_mb * 1024 * 1024) as usize;
    let shm = ShmRing::create(std::path::Path::new(&shm_path), capacity)?;
    let state = ServiceState {
        app,
        profile: spec.profile,
        shm_path: shm_path.clone(),
        shm,
    };
    serve(state, std::path::Path::new(&socket))?;
    Ok(())
}

