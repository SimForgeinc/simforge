//! service: long-lived native render service (WSB5).
//!
//! Map prewarmed once, then `(scene-state tick, rig, profile)` requests over
//! a unix socket return frame sets. Transport mirrors rl-env's env-server:
//! u32-LE length-prefixed msgpack frames with a flat `{i, op}` envelope and a
//! hard 64 MiB frame cap.
pub mod proto;
pub mod server;
pub mod shm;
