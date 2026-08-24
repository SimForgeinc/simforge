//! WSB4 film-grain post pass (UE5-parity checklist: "Film grain | absent |
//! small custom pass").
//!
//! Implemented as a Bevy `FullscreenMaterial` (the 0.19 replacement for a
//! custom post-process node): a deterministic, frame-index-seeded monochrome
//! grain applied after tonemapping in the `Core3d` PostProcess set. Only
//! cameras carrying the [`FilmGrain`] component are processed.

use bevy::core_pipeline::fullscreen_material::{FullscreenMaterial, FullscreenMaterialPlugin};
use bevy::core_pipeline::schedule::Core3dSystems;
use bevy::prelude::*;
use bevy::render::extract_component::{
    ExtractComponent, ExtractComponentPlugin, UniformComponentPlugin,
};
use bevy::render::render_resource::ShaderType;
use bevy::shader::ShaderRef;

pub struct FilmGrainPlugin;

impl Plugin for FilmGrainPlugin {
    fn build(&self, app: &mut App) {
        // FullscreenMaterialPlugin registers ExtractComponentPlugin and
        // UniformComponentPlugin for T internally.
        bevy::asset::embedded_asset!(app, "shaders/film_grain.wgsl");
        app.add_plugins(FullscreenMaterialPlugin::<FilmGrain>::default());
    }
}

/// Uniform payload; also the per-view marker component. `frame` is the
/// global frame counter so the noise pattern advances deterministically.
#[derive(Component, Clone, Copy, ShaderType, ExtractComponent, Reflect)]
#[reflect(Component, Default)]
pub struct FilmGrain {
    pub intensity: f32,
    pub frame: f32,
    pub _pad_a: f32,
    pub _pad_b: f32,
}

impl Default for FilmGrain {
    fn default() -> Self {
        Self {
            intensity: 0.06,
            frame: 0.0,
            _pad_a: 0.0,
            _pad_b: 0.0,
        }
    }
}

impl FullscreenMaterial for FilmGrain {
    fn fragment_shader() -> ShaderRef {
        ShaderRef::Path("embedded://render-core/shaders/film_grain.wgsl".into())
    }

    // Runs in the EarlyPostProcess slot just before tonemapping (the same
    // well-tested ordering Bevy's own effect stack uses).
    fn schedule_configs(
        system: bevy::ecs::schedule::ScheduleConfigs<bevy::ecs::system::BoxedSystem>,
    ) -> bevy::ecs::schedule::ScheduleConfigs<bevy::ecs::system::BoxedSystem> {
        use bevy::ecs::schedule::IntoScheduleConfigs;
        system
            .in_set(Core3dSystems::EarlyPostProcess)
    }
}
