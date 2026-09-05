//! GPU-side readiness for capture harnesses.
//!
//! Asset load state says a glTF and its images are in RAM; it says nothing
//! about the render world, which still has to compile pipeline permutations
//! (async, seconds for a fresh material/mesh key on a cold shader cache) and
//! prepare every material's bind group. Bevy skips a draw whose pipeline is
//! still `Queued`/`Creating` and a mesh whose material has no binding yet, so
//! a frame captured on a wall-clock timer can be missing whole primitives -
//! and which ones varies run to run.
//!
//! [`GpuReadinessPlugin`] samples both counts in the render world each frame
//! and publishes them to the main world through [`GpuPending`]. Harnesses
//! wait until [`GpuPending::is_idle`] holds for a few consecutive frames
//! before they start counting warmup/capture frames.
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use bevy::pbr::{RenderMaterialBindings, RenderMaterialInstances};
use bevy::prelude::*;
use bevy::render::render_resource::{CachedPipelineState, PipelineCache};
use bevy::render::{Render, RenderApp, RenderSystems};

/// Consecutive idle render frames a harness requires before it trusts the
/// scene: a freshly bound material can queue a new pipeline permutation on
/// the next frame, so a single idle sample is not enough.
pub const GPU_IDLE_FRAMES: u32 = 3;

/// Shared between the main and render worlds; written by the render world.
#[derive(Resource, Clone, Default)]
pub struct GpuPending {
    pipelines: Arc<AtomicUsize>,
    materials: Arc<AtomicUsize>,
    samples: Arc<AtomicUsize>,
}

impl GpuPending {
    /// Pipelines whose GPU object has not finished compiling.
    pub fn pipelines(&self) -> usize {
        self.pipelines.load(Ordering::Acquire)
    }

    /// Distinct materials referenced by a mesh entity that have no prepared
    /// bind group yet (textures still uploading, bind group not allocated).
    pub fn materials(&self) -> usize {
        self.materials.load(Ordering::Acquire)
    }

    /// Render frames sampled so far; zero means the render world has not run.
    pub fn samples(&self) -> usize {
        self.samples.load(Ordering::Acquire)
    }

    /// True once the render world has sampled at least one frame with nothing
    /// pending.
    pub fn is_idle(&self) -> bool {
        self.samples() > 0 && self.pipelines() == 0 && self.materials() == 0
    }
}

pub struct GpuReadinessPlugin;

impl Plugin for GpuReadinessPlugin {
    fn build(&self, app: &mut App) {
        app.init_resource::<GpuPending>();
    }

    fn finish(&self, app: &mut App) {
        let pending = app.world().resource::<GpuPending>().clone();
        let render_app = app
            .get_sub_app_mut(RenderApp)
            .expect("GpuReadinessPlugin requires the render app");
        render_app
            .insert_resource(pending)
            .add_systems(Render, sample_pending.after(RenderSystems::Render));
    }
}

fn sample_pending(
    pending: Res<GpuPending>,
    pipeline_cache: Res<PipelineCache>,
    instances: Res<RenderMaterialInstances>,
    bindings: Res<RenderMaterialBindings>,
) {
    let pipelines = pipeline_cache
        .pipelines()
        .filter(|pipeline| {
            matches!(
                pipeline.state,
                CachedPipelineState::Queued | CachedPipelineState::Creating(_)
            )
        })
        .count();
    let mut unbound = std::collections::HashSet::new();
    for instance in instances.instances.values() {
        if !bindings.contains_key(&instance.asset_id) {
            unbound.insert(instance.asset_id);
        }
    }
    pending.pipelines.store(pipelines, Ordering::Release);
    pending.materials.store(unbound.len(), Ordering::Release);
    pending.samples.fetch_add(1, Ordering::AcqRel);
}
