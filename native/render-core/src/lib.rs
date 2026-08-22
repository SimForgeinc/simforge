//! render-core: headless Bevy rendering engine for UniScenarios (`native`).
//!
//! - [`engine`]: host-controlled offscreen renderer ([`SceneApp`]) grown from
//!   scripts/renderer-spike/bevy-spike.
//! - [`job`]: batch render jobs (schedule x rig -> hashed pass artifacts).
//!
//! The original spike CLI stays untouched in `bin/native-render.rs`.
//! WSB2 adds scene/actor/motion-vector modules; WSB3 adds camera rigs and
//! extra sensor passes; WSB4 adds lighting/atmosphere/post + render profiles.

pub mod engine;
pub mod job;

// WSB4 RealismStack: lighting ladder, weather ladder, render profiles, post.
pub mod lighting;
pub mod post_grain;
pub mod profiles;
pub mod weather;
