//! service: long-lived native render service (WSB5).
//!
//! Placeholder crate so the workspace layout is stable for cherry-picks;
//! the unix-socket server loop over prewarmed maps lands here. Protocol:
//! u32-LE length prefix + msgpack frames, ops hello/load/prewarm/render/close
//! (see WSB5's protocol doc).
