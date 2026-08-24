//! trace-to-scene-state: convert an engine trace (fixtures trace.json.gz,
//! decompressed) into a `scene-state.v1` document for the sensor harness.
//!
//! Trace shape (see fixtures/evidence/golden-yale-bus-stop): header with
//! actorMetadata {id: {kind}}, ticks = {t: [...], actors: {id: {x[], y[],
//! headingRad[], speedMps[], present[]}}}.
//!
//! Frame convention: the tile-GLB world frame is x = map x, z = -map y,
//! y up. Actor yaw in GLB frame is -heading (mirror on z). Ground height is
//! not carried in traces; position y is emitted as 0 and snapped onto
//! geometry by the capture harness.

use anyhow::{Context, Result};
use serde::Deserialize;
use serde_json::json;
use std::collections::BTreeMap;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Trace {
    header: TraceHeader,
    ticks: Ticks,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TraceHeader {
    #[serde(default)]
    actor_metadata: BTreeMap<String, ActorMeta>,
}

#[derive(Deserialize)]
struct ActorMeta {
    kind: String,
}

#[derive(Deserialize)]
struct Ticks {
    t: Vec<f64>,
    actors: BTreeMap<String, TickActor>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TickActor {
    x: Vec<f64>,
    y: Vec<f64>,
    heading_rad: Vec<f64>,
    speed_mps: Vec<f64>,
    present: Vec<u8>,
}

/// Central-difference velocity over the position series.
fn velocity(xs: &[f64], ys: &[f64], ts: &[f64], i: usize) -> (f64, f64) {
    let n = xs.len();
    let (i0, i1) = if i == 0 {
        (0, 1.min(n - 1))
    } else if i == n - 1 {
        (n - 2, n - 1)
    } else {
        (i - 1, i + 1)
    };
    let dt = (ts[i1] - ts[i0]).max(1e-6);
    ((xs[i1] - xs[i0]) / dt, (ys[i1] - ys[i0]) / dt)
}

fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    if args.len() != 3 {
        anyhow::bail!("usage: trace-to-scene-state <trace.json> <out-scene-state.json>");
    }
    let text = std::fs::read_to_string(&args[1]).with_context(|| format!("read {}", args[1]))?;
    let tick_idx: usize =
        std::env::var("TRACE_TICK").ok().and_then(|s| s.parse().ok()).unwrap_or(0);

    let trace: Trace = serde_json::from_str(&text).context("deserialize trace")?;
    let ts = &trace.ticks.t;
    let n = ts.len();
    anyhow::ensure!(n > 0, "empty trace");
    let i = tick_idx.min(n - 1);
    let tick_hz = ((n - 1).max(1) as f64 / (ts[n - 1] - ts[0]).max(1e-6)) as f32;

    let mut actors = vec![];
    for (id, a) in &trace.ticks.actors {
        if a.present.get(i).copied().unwrap_or(0) == 0 {
            continue;
        }
        let kind = trace
            .header
            .actor_metadata
            .get(id)
            .map(|m| m.kind.as_str())
            .unwrap_or("prop");
        let actor_class = match kind {
            "car" => "car",
            "bus" | "truck" => "truck",
            "pedestrian" => "pedestrian",
            "cyclist" => "cyclist",
            _ => "prop",
        };
        let (vx, vy) = velocity(&a.x, &a.y, ts, i);
        // GLB frame: x = map x, z = -map y; yaw_glbt = -heading.
        let heading = a.heading_rad.get(i).copied().unwrap_or(0.0);
        let yaw = -heading;
        actors.push(json!({
            "id": id,
            "kind": "update",
            "catalogId": format!("{}.{}", kind_prefix(kind), id),
            "actorClass": actor_class,
            "transform": {
                "position": [a.x[i], 0.0, -a.y[i]],
                "rotation": [0.0, ((yaw / 2.0).sin()) as f32, 0.0, ((yaw / 2.0).cos()) as f32],
            },
            "velocity": [vx, 0.0, -vy],
            "angularVelocityY": 0.0,
        }));
        let _ = a.speed_mps;
    }

    let doc = json!({
        "version": "scene-state.v1",
        "mapId": std::env::var("MAP_ID").unwrap_or_else(|_| "yale-street".into()),
        "tick": i,
        "tickHz": tick_hz,
        "weather": { "preset": "clear" },
        "timeOfDay": 12.0,
        "actors": actors,
    });
    std::fs::write(&args[2], serde_json::to_string_pretty(&doc)?)?;
    println!("wrote {} ({} actors)", args[2], actors.len());
    Ok(())
}

fn kind_prefix(kind: &str) -> &'static str {
    match kind {
        "car" | "bus" | "truck" => "vehicle",
        "pedestrian" => "walker",
        _ => "prop",
    }
}
