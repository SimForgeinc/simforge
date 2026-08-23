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

/// Deterministic monochrome film grain (same hash13 math as the WGSL
/// prototype), applied on the CPU readback for the cinematic profile. Seeded
/// by pixel coordinates + capture frame — no wall-clock input. Shared by the
/// `native-render` and `scen-play` binaries.
pub fn apply_cpu_grain(
    rgba: &mut [u8],
    width: usize,
    height: usize,
    intensity: f32,
    seed: f32,
) {
    #[inline]
    fn hash13(px: f32, py: f32, frame: f32) -> f32 {
        let mut p = [
            (px * 0.1031).fract(),
            (py * 0.1030).fract(),
            (frame * 0.0973).fract(),
        ];
        let dot = p[0] * (p[1] + 33.33) + p[1] * (p[2] + 33.33) + p[2] * (p[0] + 33.33);
        p[0] += dot;
        p[1] += dot;
        p[2] += dot;
        ((p[0] + p[1]) * p[2]).fract()
    }
    #[inline]
    fn smoothstep(e0: f32, e1: f32, x: f32) -> f32 {
        let t = ((x - e0) / (e1 - e0)).clamp(0.0, 1.0);
        t * t * (3.0 - 2.0 * t)
    }
    if intensity <= 0.0 {
        return;
    }
    for py in 0..height {
        for pxx in 0..width {
            let idx = (py * width + pxx) * 4;
            let (r, g, b) = (
                rgba[idx] as f32 / 255.0,
                rgba[idx + 1] as f32 / 255.0,
                rgba[idx + 2] as f32 / 255.0,
            );
            let luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
            let weight = mix2(0.65, 1.0, smoothstep(0.0, 0.5, luma))
                * mix2(1.0, 0.55, smoothstep(0.6, 1.0, luma));
            let n = hash13(pxx as f32 + 0.5, py as f32 + 0.5, seed + 1.0);
            let grain = (n - 0.5) * 2.0 * intensity * weight;
            for c in 0..3 {
                let v = rgba[idx + c] as f32 / 255.0 + grain;
                rgba[idx + c] = (v.clamp(0.0, 1.0) * 255.0 + 0.5) as u8;
            }
        }
    }
}

#[inline]
fn mix2(a: f32, b: f32, t: f32) -> f32 {
    a + (b - a) * t
}
