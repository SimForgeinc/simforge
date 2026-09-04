use bevy_material::AlphaMode;
use bevy_math::Affine2;
use bevy_mesh::UvChannel;

use gltf::{json::texture::Info, Material};

use serde_json::{value, Map, Value};

use crate::GltfAssetLabel;

use super::texture::texture_transform_to_affine2;

#[cfg(any(
    feature = "pbr_anisotropy_texture",
    feature = "pbr_specular_textures",
    feature = "pbr_multi_layer_material_textures"
))]
use {
    bevy_asset::{AssetPath, Handle},
    bevy_image::Image,
};

/// How one material slot samples: its UV channel and its own
/// `KHR_texture_transform`, if declared. The transform's `texCoord` override
/// wins over the texture info's, as the extension specifies.
#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct SlotSampling {
    pub(crate) channel: UvChannel,
    pub(crate) transform: Option<Affine2>,
}

pub(crate) fn slot_sampling(
    material: &Material,
    texture_kind: &str,
    info_tex_coord: u32,
    transform: Option<gltf::texture::TextureTransform>,
) -> SlotSampling {
    let tex_coord = transform
        .as_ref()
        .and_then(|transform| transform.tex_coord())
        .unwrap_or(info_tex_coord);
    SlotSampling {
        channel: uv_channel(material, texture_kind, tex_coord),
        transform: transform.map(texture_transform_to_affine2),
    }
}

/// [`SlotSampling`] from a deserialized `KHR_texture_transform` block.
fn json_transform_sampling(
    material: &Material,
    texture_kind: &str,
    info_tex_coord: u32,
    transform: Option<&gltf::json::extensions::texture::TextureTransform>,
) -> SlotSampling {
    let tex_coord = transform
        .and_then(|transform| transform.tex_coord)
        .unwrap_or(info_tex_coord);
    SlotSampling {
        channel: uv_channel(material, texture_kind, tex_coord),
        transform: transform.map(|transform| {
            Affine2::from_scale_angle_translation(
                transform.scale.0.into(),
                -transform.rotation.0,
                transform.offset.0.into(),
            )
        }),
    }
}

/// [`SlotSampling`] for a texture info deserialized from an extension block.
pub(crate) fn json_slot_sampling(
    material: &Material,
    texture_kind: &str,
    info: &Info,
) -> SlotSampling {
    json_transform_sampling(
        material,
        texture_kind,
        info.tex_coord,
        info.extensions
            .as_ref()
            .and_then(|extensions| extensions.texture_transform.as_ref()),
    )
}

/// [`SlotSampling`] for the normal and occlusion textures, whose
/// `KHR_texture_transform` the `gltf` crate only exposes as raw extension JSON.
pub(crate) fn raw_extension_slot_sampling(
    material: &Material,
    texture_kind: &str,
    info_tex_coord: u32,
    extensions: Option<&Map<String, Value>>,
) -> SlotSampling {
    let transform = extensions
        .and_then(|extensions| extensions.get("KHR_texture_transform"))
        .and_then(|value| {
            value::from_value::<gltf::json::extensions::texture::TextureTransform>(value.clone())
                .ok()
        });
    json_transform_sampling(material, texture_kind, info_tex_coord, transform.as_ref())
}

/// Parses a texture that's part of a material extension block and returns
/// how it samples and its image reference.
#[cfg(any(
    feature = "pbr_anisotropy_texture",
    feature = "pbr_specular_textures",
    feature = "pbr_multi_layer_material_textures"
))]
pub(crate) fn parse_material_extension_texture(
    material: &Material,
    extension: &Map<String, Value>,
    texture_name: &str,
    texture_kind: &str,
    textures: &[Handle<Image>],
    asset_path: AssetPath<'_>,
) -> (SlotSampling, Option<Handle<Image>>) {
    match extension
        .get(texture_name)
        .and_then(|value| value::from_value::<Info>(value.clone()).ok())
    {
        Some(json_info) => (
            json_slot_sampling(material, texture_kind, &json_info),
            Some({
                match textures.get(json_info.index.value()).cloned() {
                    None => {
                        tracing::warn!("Gltf at path \"{asset_path}\" contains invalid texture index <{}> for texture {texture_name}. Using default image.", json_info.index.value());
                        Handle::default()
                    }
                    Some(handle) => handle,
                }
            }),
        ),
        None => (SlotSampling::default(), None),
    }
}

pub(crate) fn uv_channel(material: &Material, texture_kind: &str, tex_coord: u32) -> UvChannel {
    match tex_coord {
        0 => UvChannel::Uv0,
        1 => UvChannel::Uv1,
        2 => UvChannel::Uv2,
        3 => UvChannel::Uv3,
        _ => {
            let material_name = material
                .name()
                .map(|n| format!("the material \"{n}\""))
                .unwrap_or_else(|| "an unnamed material".to_string());
            let material_index = material
                .index()
                .map(|i| format!("index {i}"))
                .unwrap_or_else(|| "default".to_string());
            tracing::warn!(
                    "Only 4 UV Channels are supported, but {material_name} ({material_index}) \
                    has the TEXCOORD attribute {} on texture kind {texture_kind}, which will fallback to 0.",
                    tex_coord,
                );
            UvChannel::Uv0
        }
    }
}

pub(crate) fn alpha_mode(material: &Material) -> AlphaMode {
    match material.alpha_mode() {
        gltf::material::AlphaMode::Opaque => AlphaMode::Opaque,
        gltf::material::AlphaMode::Mask => AlphaMode::Mask(material.alpha_cutoff().unwrap_or(0.5)),
        gltf::material::AlphaMode::Blend => AlphaMode::Blend,
    }
}

/// Returns the index (within the `textures` array) of the texture with the
/// given field name in the data for the material extension with the given name,
/// if there is one.
pub(crate) fn extension_texture_index(
    material: &Material,
    extension_name: &str,
    texture_field_name: &str,
) -> Option<usize> {
    Some(
        value::from_value::<Info>(
            material
                .extensions()?
                .get(extension_name)?
                .as_object()?
                .get(texture_field_name)?
                .clone(),
        )
        .ok()?
        .index
        .value(),
    )
}

/// Returns true if the material needs mesh tangents in order to be successfully
/// rendered.
///
/// We generate them if this function returns true.
pub(crate) fn needs_tangents(material: &Material) -> bool {
    [
        material.normal_texture().is_some(),
        #[cfg(feature = "pbr_multi_layer_material_textures")]
        extension_texture_index(
            material,
            "KHR_materials_clearcoat",
            "clearcoatNormalTexture",
        )
        .is_some(),
    ]
    .into_iter()
    .reduce(|a, b| a || b)
    .unwrap_or(false)
}

pub(crate) fn material_label(material: &Material, is_scale_inverted: bool) -> GltfAssetLabel {
    if let Some(index) = material.index() {
        GltfAssetLabel::Material {
            index,
            is_scale_inverted,
        }
    } else {
        GltfAssetLabel::DefaultMaterial
    }
}
