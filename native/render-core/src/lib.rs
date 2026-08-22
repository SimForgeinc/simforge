//! render-core: headless Bevy scene renderer for UniScenarios.
//!
//! Grows from scripts/renderer-spike/bevy-spike (GO verdict, see
//! scripts/renderer-spike/FINDINGS.md). Owns: scene ingestion (corpus GLB
//! tiles), actor rendering, cameras, passes (RGB / instance-ID / depth /
//! motion vectors) and GPU->CPU readback.
//!
//! WSB2 owns the scene/actor/motion-vector modules; WSB3 adds camera rigs and
//! extra sensor passes; WSB4 adds lighting/atmosphere/post + render profiles.
//!
//! The `native-render` binary is the spike application verbatim at this
//! commit; scene-state playback, actor meshes and the motion-vector pass are
//! added on top in subsequent commits.
