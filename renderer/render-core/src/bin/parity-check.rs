//! `parity-check`: renderer parity fixture validation for the Bevy renderer.
//!
//! Recomputes actor world matrices and derived vehicle light states from a
//! `simforge.renderer-parity-fixture/v1` document and compares them against
//! the fixture expectations within the authored tolerances. Optionally
//! extracts the embedded scene-state (+ renderCues) so `scen-play` can
//! render the fixture scene:
//!
//! ```text
//! parity-check --fixture packages/viewer/fixtures/renderer-contract/basic-intersection.v1.json \
//!   --extract-scene /tmp/fixture-scene.json --extract-cues /tmp/fixture-cues.json
//! ```

use std::path::PathBuf;

use clap::Parser;
use render_core::fixture::{check_fixture, ParityFixture};

#[derive(Parser, Debug)]
struct Args {
    /// Parity fixture document (simforge.renderer-parity-fixture/v1).
    #[arg(long)]
    fixture: PathBuf,
    /// Write the embedded scene-state.v1 document here (for scen-play).
    #[arg(long)]
    extract_scene: Option<PathBuf>,
    /// Write the fixture renderCues here (for scen-play --render-cues).
    #[arg(long)]
    extract_cues: Option<PathBuf>,
}

fn main() -> anyhow::Result<()> {
    let args = Args::parse();
    let fixture = ParityFixture::load(&args.fixture)?;

    if let Some(path) = &args.extract_scene {
        std::fs::write(path, serde_json::to_string_pretty(&fixture.scene_state)?)?;
        eprintln!("scene-state written to {}", path.display());
    }
    if let Some(path) = &args.extract_cues {
        // Round-trip the raw fixture field so the cues keep their wire shape.
        let raw: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&args.fixture)?)?;
        std::fs::write(
            path,
            serde_json::to_string_pretty(&raw["renderCues"])?,
        )?;
        eprintln!("renderCues written to {}", path.display());
    }

    let report = check_fixture(&fixture)?;
    println!("{}", serde_json::to_string_pretty(&report)?);
    if !report.pass {
        std::process::exit(1);
    }
    Ok(())
}
