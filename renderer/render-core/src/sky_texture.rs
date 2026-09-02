//! `SKYTEX01` loader for the NASA celestial plates.
//!
//! The plates are produced by `tools/prepare_sky_assets.py` from the
//! public-domain NASA/Goddard SVS releases (Deep Star Maps 2020, SVS 4851;
//! CGI Moon Kit, SVS 4720). The container is a fixed 24-byte header plus
//! tightly packed rows so the load is one read and one upload with no
//! decode-time policy: the bytes that ship are the bytes the GPU samples.

use anyhow::{bail, Context, Result};
use bevy::asset::RenderAssetUsages;
use bevy::image::{Image, ImageAddressMode, ImageFilterMode, ImageSampler, ImageSamplerDescriptor};
use bevy::render::render_resource::{Extent3d, TextureDimension, TextureFormat};
use std::path::Path;

const MAGIC: &[u8; 8] = b"SKYTEX01";
const HEADER: usize = 24;

/// Decoded plate: an `Image` that lives only in the render world, with an
/// equirectangular sampler (wrap in longitude, clamp at the poles).
pub fn load_equirect(path: &Path) -> Result<Image> {
    let bytes = std::fs::read(path).with_context(|| format!("reading sky plate {path:?}"))?;
    if bytes.len() < HEADER || &bytes[..8] != MAGIC {
        bail!("{path:?} is not a SKYTEX01 plate");
    }
    let u32_at = |offset: usize| {
        u32::from_le_bytes([
            bytes[offset],
            bytes[offset + 1],
            bytes[offset + 2],
            bytes[offset + 3],
        ])
    };
    let width = u32_at(8);
    let height = u32_at(12);
    let format = match u32_at(16) {
        0 => TextureFormat::Rgba16Float,
        1 => TextureFormat::Rgba8UnormSrgb,
        other => bail!("{path:?} has unknown SKYTEX format {other}"),
    };
    let texel = format.block_copy_size(None).unwrap_or(4) as usize;
    let expected = width as usize * height as usize * texel;
    let payload = &bytes[HEADER..];
    if payload.len() != expected {
        bail!(
            "{path:?} payload is {} bytes, expected {expected} for {width}x{height} {format:?}",
            payload.len()
        );
    }
    let mut image = Image::new(
        Extent3d {
            width,
            height,
            depth_or_array_layers: 1,
        },
        TextureDimension::D2,
        payload.to_vec(),
        format,
        // Render world only: the CPU copy is dropped after upload, so an 8K
        // float plate costs VRAM once and nothing in resident RSS.
        RenderAssetUsages::RENDER_WORLD,
    );
    image.sampler = ImageSampler::Descriptor(ImageSamplerDescriptor {
        label: Some("sky-equirect".into()),
        address_mode_u: ImageAddressMode::Repeat,
        address_mode_v: ImageAddressMode::ClampToEdge,
        address_mode_w: ImageAddressMode::ClampToEdge,
        mag_filter: ImageFilterMode::Linear,
        min_filter: ImageFilterMode::Linear,
        mipmap_filter: ImageFilterMode::Nearest,
        ..Default::default()
    });
    Ok(image)
}
