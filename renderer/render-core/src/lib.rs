//! render-core: headless Bevy scene renderer for SimForge.
//!
//! Grows from scripts/renderer-spike/bevy-spike (GO verdict, see
//! scripts/renderer-spike/FINDINGS.md). Owns: scene ingestion (corpus GLB
//! tiles), actor rendering, cameras, passes (RGB / instance-ID / depth /
//! motion vectors) and GPU->CPU readback.
//!
//! WSB2 owns the scene/actor/motion-vector modules; WSB3 adds camera rigs and
//! extra sensor passes; WSB4 adds lighting/atmosphere/post + render profiles.
//!
//! Binaries:
//! - `native-render`: the spike application (flag-compatible baseline).
//! - `scen-play`: scene-state.v1 trace playback with actors + motion vectors.

pub mod catalog;
pub mod motion_vector;
pub mod playback;
pub mod readback;
pub mod scene_state;
pub mod engine;
pub mod job;
pub mod lighting;
pub mod post_grain;
pub mod profiles;
pub mod veg;
pub mod weather;
