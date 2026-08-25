//! Minimal glTF 2.0 (GLB) parser — just enough for the feasibility spike.
//! Supported: scenes/nodes (TRS or matrix), meshes/primitives (POSITION/NORMAL/
//! TANGENT/TEXCOORD_0, u16/u32 indices), pbrMetallicRoughness materials,
//! embedded images (image/ktx2 via KHR_texture_basisu, image/png, image/jpeg),
//! LINEAR animations on translation/rotation/scale.

use serde::Deserialize;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Gltf {
    pub scene: Option<usize>,
    #[serde(default)]
    pub scenes: Vec<Scene>,
    #[serde(default)]
    pub nodes: Vec<Node>,
    #[serde(default)]
    pub meshes: Vec<Mesh>,
    #[serde(default)]
    pub accessors: Vec<Accessor>,
    #[serde(default)]
    pub buffer_views: Vec<BufferView>,
    #[serde(default)]
    pub materials: Vec<Material>,
    #[serde(default)]
    pub textures: Vec<Texture>,
    #[serde(default)]
    pub images: Vec<Image>,
    #[serde(default)]
    pub animations: Vec<Animation>,
}

#[derive(Deserialize)]
pub struct Scene {
    #[serde(default)]
    pub nodes: Vec<usize>,
}

#[derive(Deserialize)]
pub struct Node {
    pub name: Option<String>,
    pub mesh: Option<usize>,
    #[serde(default)]
    pub children: Vec<usize>,
    pub translation: Option<[f32; 3]>,
    pub rotation: Option<[f32; 4]>,
    pub scale: Option<[f32; 3]>,
    pub matrix: Option<[f32; 16]>,
}

impl Node {
    pub fn local_transform(&self) -> glam::Mat4 {
        if let Some(m) = self.matrix {
            return glam::Mat4::from_cols_array(&m);
        }
        let t = self.translation.unwrap_or([0.0; 3]);
        let r = self.rotation.unwrap_or([0.0, 0.0, 0.0, 1.0]);
        let s = self.scale.unwrap_or([1.0; 3]);
        glam::Mat4::from_scale_rotation_translation(
            glam::Vec3::from(s),
            glam::Quat::from_xyzw(r[0], r[1], r[2], r[3]),
            glam::Vec3::from(t),
        )
    }
}

#[derive(Deserialize)]
pub struct Mesh {
    #[serde(default)]
    pub primitives: Vec<Primitive>,
}

#[derive(Deserialize)]
pub struct Primitive {
    pub attributes: std::collections::HashMap<String, usize>,
    pub indices: Option<usize>,
    pub material: Option<usize>,
    #[serde(default = "default_mode")]
    pub mode: u32,
}

fn default_mode() -> u32 {
    4
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Accessor {
    pub buffer_view: Option<usize>,
    #[serde(default)]
    pub byte_offset: usize,
    pub component_type: u32,
    pub count: usize,
    #[serde(rename = "type")]
    pub type_: String,
    pub min: Option<Vec<f32>>,
    pub max: Option<Vec<f32>>,
}

impl Accessor {
    pub fn component_size(&self) -> usize {
        match self.component_type {
            5120 | 5121 => 1,
            5122 | 5123 => 2,
            5125 | 5126 => 4,
            _ => 0,
        }
    }
    pub fn component_count(&self) -> usize {
        match self.type_.as_str() {
            "SCALAR" => 1,
            "VEC2" => 2,
            "VEC3" => 3,
            "VEC4" => 4,
            "MAT4" => 16,
            _ => 0,
        }
    }
    pub fn elem_size(&self) -> usize {
        self.component_size() * self.component_count()
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BufferView {
    #[serde(default)]
    pub byte_offset: usize,
    pub byte_length: usize,
    pub byte_stride: Option<usize>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Material {
    pub name: Option<String>,
    #[serde(default)]
    pub pbr_metallic_roughness: Pbr,
    pub normal_texture: Option<TexRef>,
    pub alpha_mode: Option<String>,
    pub alpha_cutoff: Option<f32>,
    #[serde(default)]
    pub double_sided: bool,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Pbr {
    pub base_color_factor: Option<[f32; 4]>,
    pub base_color_texture: Option<TexRef>,
    pub metallic_factor: Option<f32>,
    pub roughness_factor: Option<f32>,
    pub metallic_roughness_texture: Option<TexRef>,
}

#[derive(Deserialize)]
pub struct TexRef {
    pub index: usize,
    pub scale: Option<f32>,
}

#[derive(Deserialize)]
pub struct Texture {
    pub source: Option<usize>,
    pub extensions: Option<TextureExt>,
}

impl Texture {
    /// KHR_texture_basisu source wins over the (absent/placeholder) core source.
    pub fn image_index(&self) -> Option<usize> {
        self.extensions
            .as_ref()
            .and_then(|e| e.khr_texture_basisu.as_ref())
            .map(|b| b.source)
            .or(self.source)
    }
}

#[derive(Deserialize)]
pub struct TextureExt {
    #[serde(rename = "KHR_texture_basisu")]
    pub khr_texture_basisu: Option<BasisuExt>,
}

#[derive(Deserialize)]
pub struct BasisuExt {
    pub source: usize,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Image {
    pub buffer_view: Option<usize>,
    pub mime_type: Option<String>,
}

#[derive(Deserialize)]
pub struct Animation {
    #[serde(default)]
    pub samplers: Vec<AnimSampler>,
    #[serde(default)]
    pub channels: Vec<AnimChannel>,
}

#[derive(Deserialize)]
pub struct AnimSampler {
    pub input: usize,
    pub output: usize,
    pub interpolation: Option<String>,
}

#[derive(Deserialize)]
pub struct AnimChannel {
    pub sampler: usize,
    pub target: AnimTarget,
}

#[derive(Deserialize)]
pub struct AnimTarget {
    pub node: Option<usize>,
    pub path: String,
}

/// Parse a GLB container into (gltf json, binary chunk).
pub fn parse_glb(data: &[u8]) -> Result<(Gltf, Vec<u8>), String> {
    if data.len() < 12 || &data[0..4] != b"glTF" {
        return Err("not a glb".into());
    }
    let mut off = 12usize;
    let mut json: Option<Gltf> = None;
    let mut bin: Vec<u8> = Vec::new();
    while off + 8 <= data.len() {
        let clen = u32::from_le_bytes(data[off..off + 4].try_into().unwrap()) as usize;
        let ctype = u32::from_le_bytes(data[off + 4..off + 8].try_into().unwrap());
        off += 8;
        let chunk = &data[off..(off + clen).min(data.len())];
        off += clen;
        match ctype {
            0x4E4F534A => {
                json = Some(serde_json::from_slice(chunk).map_err(|e| format!("gltf json: {e}"))?)
            }
            0x004E4942 => bin = chunk.to_vec(),
            _ => {}
        }
    }
    Ok((json.ok_or("glb missing json chunk")?, bin))
}

/// Read an accessor into a tightly-packed byte vector (handles byteStride).
pub fn read_accessor(g: &Gltf, bin: &[u8], idx: usize) -> Vec<u8> {
    let a = &g.accessors[idx];
    let elem = a.elem_size();
    let Some(bv_idx) = a.buffer_view else {
        return vec![0u8; elem * a.count];
    };
    let bv = &g.buffer_views[bv_idx];
    let start = bv.byte_offset + a.byte_offset;
    let stride = bv.byte_stride.unwrap_or(elem);
    if stride == elem {
        return bin[start..start + elem * a.count].to_vec();
    }
    let mut out = Vec::with_capacity(elem * a.count);
    for i in 0..a.count {
        let o = start + i * stride;
        out.extend_from_slice(&bin[o..o + elem]);
    }
    out
}

pub fn read_accessor_f32(g: &Gltf, bin: &[u8], idx: usize) -> Vec<f32> {
    let bytes = read_accessor(g, bin, idx);
    assert_eq!(g.accessors[idx].component_type, 5126, "expected f32 accessor");
    bytes
        .chunks_exact(4)
        .map(|c| f32::from_le_bytes(c.try_into().unwrap()))
        .collect()
}
