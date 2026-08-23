//! Motion-vector pass: per-instance previous-transform buffer + a G-buffer
//! target (Rg16Float, NDC velocity per pixel).
//!
//! v1 scope: object motion for actors only, static camera (prev view-proj ==
//! current). Each actor gets one `MotionVectorMaterial` whose uniform carries
//! the actor root's **previous-frame** model matrix; part clones on render
//! layer 2 wear it, so every vertex outputs
//! `ndc(cur·model·p) − ndc(cur·prev_model·p)` exactly.

use bevy::prelude::*;
use bevy::render::render_resource::AsBindGroup;
use bevy::shader::ShaderRef;
use bevy::render::render_resource::{
    TextureFormat, TextureUsages,
};


/// Absolute path of the on-disk shader copy (committed under the crate's
/// assets dir; BEVY_ASSET_ROOT="/" so paths are filesystem-relative).
pub fn shader_asset_path() -> String {
    let manifest = env!("CARGO_MANIFEST_DIR").trim_start_matches('/');
    format!("{manifest}/assets/shaders/motion_vector.wgsl")
}

#[derive(Asset, TypePath, Debug, Clone, Default, AsBindGroup)]
pub struct MotionVectorMaterial {}

impl Material for MotionVectorMaterial {
    fn fragment_shader() -> ShaderRef {
        ShaderRef::Path(shader_asset_path().into())
    }
}

/// Target image for the motion-vector G-buffer.
pub fn mv_target_image(images: &mut Assets<Image>, w: u32, h: u32) -> Handle<Image> {
    let mut img = Image::new_target_texture(w, h, TextureFormat::Rg16Float, None);
    img.texture_descriptor.usage |= TextureUsages::COPY_SRC;
    images.add(img)
}

/// Decode an Rg16Float readback into per-pixel `[vx, vy]` NDC velocities.
pub fn decode_rg16f(data: &[u8], width: usize, height: usize) -> Vec<[f32; 2]> {
    let mut out = Vec::with_capacity(width * height);
    for px in data.chunks_exact(4) {
        let vx = half::f16::from_le_bytes([px[0], px[1]]).to_f32();
        let vy = half::f16::from_le_bytes([px[2], px[3]]).to_f32();
        out.push([vx, vy]);
    }
    out
}
