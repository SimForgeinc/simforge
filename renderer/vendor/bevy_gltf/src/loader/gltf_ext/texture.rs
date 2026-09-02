use bevy_image::{ImageAddressMode, ImageFilterMode, ImageSamplerDescriptor};
use bevy_math::Affine2;

use gltf::{
    image::Image,
    texture::{MagFilter, MinFilter, Texture, TextureTransform, WrappingMode},
    Document,
};
use serde_json::Value;

/// How a glTF texture resolves to its image.
pub(crate) enum TextureSource<'a> {
    /// A valid image, from `KHR_texture_basisu.source` when present, else the
    /// core `source` field.
    Image(Image<'a>),
    /// Neither the extension nor the core field references an image.
    Missing,
    /// `KHR_texture_basisu` is present but its `source` is absent, not an
    /// integer, or out of range. Falling back to the core `source` here would
    /// silently render a compatibility image instead of the authored KTX2.
    InvalidBasisu,
}

/// Resolves the image referenced by a glTF texture, honoring the
/// `KHR_texture_basisu` extension.
///
/// Textures carrying `KHR_texture_basisu` reference their KTX2 image via
/// `extensions.KHR_texture_basisu.source`; the core `source` field is then
/// optional and, when present, is only a fallback for readers without KTX2
/// support. Bevy decodes KTX2 natively, so the extension source takes
/// priority.
pub(crate) fn texture_source<'a>(texture: &Texture<'a>, document: &'a Document) -> TextureSource<'a> {
    if let Some(basisu) = texture.extension_value("KHR_texture_basisu") {
        return match basisu
            .get("source")
            .and_then(Value::as_u64)
            .and_then(|index| document.images().nth(index as usize))
        {
            Some(image) => TextureSource::Image(image),
            None => TextureSource::InvalidBasisu,
        };
    }
    match texture.source() {
        Some(image) => TextureSource::Image(image),
        None => TextureSource::Missing,
    }
}

/// Extracts the texture sampler data from the glTF [`Texture`].
pub(crate) fn texture_sampler(
    texture: &Texture<'_>,
    default_sampler: &ImageSamplerDescriptor,
) -> ImageSamplerDescriptor {
    let gltf_sampler = texture.sampler();
    let mut sampler = default_sampler.clone();

    sampler.address_mode_u = address_mode(&gltf_sampler.wrap_s());
    sampler.address_mode_v = address_mode(&gltf_sampler.wrap_t());

    // Shouldn't parse filters when anisotropic filtering is on, because trilinear is then required by wgpu.
    // We also trust user to have provided a valid sampler.
    if sampler.anisotropy_clamp == 1 {
        if let Some(mag_filter) = gltf_sampler.mag_filter().map(|mf| match mf {
            MagFilter::Nearest => ImageFilterMode::Nearest,
            MagFilter::Linear => ImageFilterMode::Linear,
        }) {
            sampler.mag_filter = mag_filter;
        }
        if let Some(min_filter) = gltf_sampler.min_filter().map(|mf| match mf {
            MinFilter::Nearest
            | MinFilter::NearestMipmapNearest
            | MinFilter::NearestMipmapLinear => ImageFilterMode::Nearest,
            MinFilter::Linear | MinFilter::LinearMipmapNearest | MinFilter::LinearMipmapLinear => {
                ImageFilterMode::Linear
            }
        }) {
            sampler.min_filter = min_filter;
        }
        if let Some(mipmap_filter) = gltf_sampler.min_filter().map(|mf| match mf {
            MinFilter::Nearest
            | MinFilter::Linear
            | MinFilter::NearestMipmapNearest
            | MinFilter::LinearMipmapNearest => ImageFilterMode::Nearest,
            MinFilter::NearestMipmapLinear | MinFilter::LinearMipmapLinear => {
                ImageFilterMode::Linear
            }
        }) {
            sampler.mipmap_filter = mipmap_filter;
        }
    }
    sampler
}

pub(crate) fn address_mode(wrapping_mode: &WrappingMode) -> ImageAddressMode {
    match wrapping_mode {
        WrappingMode::ClampToEdge => ImageAddressMode::ClampToEdge,
        WrappingMode::Repeat => ImageAddressMode::Repeat,
        WrappingMode::MirroredRepeat => ImageAddressMode::MirrorRepeat,
    }
}

pub(crate) fn texture_transform_to_affine2(texture_transform: TextureTransform) -> Affine2 {
    Affine2::from_scale_angle_translation(
        texture_transform.scale().into(),
        -texture_transform.rotation(),
        texture_transform.offset().into(),
    )
}
