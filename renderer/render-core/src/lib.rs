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

pub mod actor_lights;
pub mod atmosphere;
pub mod calibration;
pub mod catalog;
pub mod cloud_noise;
pub mod clouds;
pub mod facade_windows;
pub mod fixture;
pub mod motion_vector;
pub mod playback;
pub mod readback;
pub mod readiness;
pub mod scene_state;
pub mod engine;
pub mod job;
pub mod lighting;
pub mod night;
pub mod sky_pass;
pub mod road_detail;
pub mod post_grain;
pub mod profiles;
pub mod sky_texture;
pub mod veg;
pub mod vehicle_model;
pub mod weather;
