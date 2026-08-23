//! `scen-play`: scene-state.v1 trace playback renderer (WSB2).
//!
//! Renders RGB + instance-ID (+ motion-vector G-buffer with `--mv`) per tick
//! from corpus GLB tiles and a scene-state document.

fn main() -> anyhow::Result<()> {
    let args = <render_core::playback::PlaybackArgs as clap::Parser>::parse();
    render_core::playback::run(args)
}
