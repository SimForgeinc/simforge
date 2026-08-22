//! render-core: headless Bevy rendering engine for UniScenarios (`native`).
//!
//! - [`engine`]: host-controlled offscreen renderer ([`SceneApp`]) grown from
//!   scripts/renderer-spike/bevy-spike.
//! - [`job`]: batch render jobs (schedule x rig -> hashed pass artifacts).
//!
//! The original spike CLI stays untouched in `bin/native-render.rs`.
pub mod engine;
pub mod job;
