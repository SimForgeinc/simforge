//! Shared rendering core for the UniScenarios native renderer.
//!
//! Binaries:
//! - `native-render`: the spike application (flag-compatible baseline).
//! - `scen-play`: scene-state.v1 trace playback with actors + motion vectors.
//!
//! WSB4 RealismStack modules: lighting ladder, weather ladder, render
//! profiles, post-process grain, vegetation instancing.
pub mod catalog;
pub mod lighting;
pub mod motion_vector;
pub mod playback;
pub mod post_grain;
pub mod profiles;
pub mod readback;
pub mod scene_state;
pub mod veg;
pub mod weather;
