//! sensor-capture: full-rig deterministic capture (8 cameras x RGB/depth/
//! instance/semantic, 6 lidars, 4 radars, IMU/GNSS) on one scene.

use anyhow::Result;
use clap::Parser;
use sensors::capture::{run_capture, CaptureArgs};

fn main() -> Result<()> {
    let args = CaptureArgs::parse();
    run_capture(args)
}
