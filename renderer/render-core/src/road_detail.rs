//! Road detail layer (`simforge.road-detail/v1`): splat-blended asphalt
//! variants + wear/marking modulation + baked decal overlay.
//!
//! This is the Road-Painter-equivalent closing the last asset-level gap to
//! CARLA (docs/road-detail.md): per tile, a generator
//! (`tools/road-detail-gen`) derives a deterministic splat mask + decal
//! overlay from the map's lane graph, and this module rewires the named GLB
//! road/marking materials to an
//! [`ExtendedMaterial<StandardMaterial, RoadDetailExtension>`] whose fragment
//! shader (src/shaders/road_detail.wgsl) blends 2–3 surface variants in
//! world-XZ tile space.
//!
//! Determinism: sidecar textures are decoded on the CPU with the `image`
//! crate into fixed-format `Image`s (no mips, fixed samplers); the shader is
//! a pure function of those textures + uniforms. Same sidecar + same GLBs +
//! same device -> same pixels. The instance-ID pass is untouched (ID clones
//! carry their own unlit materials, which are never in the rewiring set).
//!
//! Texture licensing: variant textures MUST be CC0 (Poly Haven / ambientCG)
//! or SimForge-authored; RoadRunner Asset Library textures are prohibited
//! (see tools/glb-orm-repair/README.md "Texture licensing").

use anyhow::{bail, Context, Result};
use bevy::asset::RenderAssetUsages;
use bevy::gltf::GltfMaterialName;
use bevy::image::{ImageAddressMode, ImageFilterMode, ImageSampler, ImageSamplerDescriptor};
use bevy::pbr::{ExtendedMaterial, MaterialExtension};
use bevy::prelude::*;
use bevy::render::render_resource::{
    AsBindGroup, Extent3d, ShaderType, TextureDimension, TextureFormat,
};
use bevy::shader::ShaderRef;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;

pub const ROAD_DETAIL_SCHEMA_V1: &str = "simforge.road-detail/v1";

// ---------------------------------------------------------------------------
// Sidecar document (simforge.road-detail/v1, see docs/road-detail.md)
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoadDetailSidecar {
    pub schema: String,
    pub tile_id: String,
    pub seed: u64,
    pub bounds: Bounds,
    pub materials: MaterialTargets,
    pub splat: TextureRef,
    pub decal_overlay: TextureRef,
    #[serde(default)]
    pub decal_atlas: Option<TextureRef>,
    pub variants: Vec<Variant>,
    pub detail_normal: DetailNormal,
    #[serde(default)]
    pub params: Params,
    #[serde(default)]
    pub decals: Vec<DecalInstance>,
    #[serde(default)]
    pub digests: HashMap<String, String>,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Bounds {
    pub min_x: f32,
    pub min_z: f32,
    pub max_x: f32,
    pub max_z: f32,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MaterialTargets {
    /// GLB material names that receive the road-surface mode.
    pub road: Vec<String>,
    /// GLB material names that receive the lane-marking mode.
    #[serde(default)]
    pub marking: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextureRef {
    pub texture: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Variant {
    pub id: String,
    /// Splat channel: "a" (splat R) or "b" (splat G).
    pub role: String,
    pub base_color: String,
    pub normal: String,
    pub orm: String,
    pub tiling_per_meter: f32,
    #[serde(default)]
    pub source: Option<serde_json::Value>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DetailNormal {
    pub texture: String,
    pub tiling_per_meter: f32,
    pub strength: f32,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Params {
    pub wear_albedo_darken: f32,
    pub wear_roughness_delta: f32,
    pub marking_wear_strength: f32,
}

impl Default for Params {
    fn default() -> Self {
        Self {
            wear_albedo_darken: 0.38,
            wear_roughness_delta: -0.22,
            marking_wear_strength: 0.85,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DecalInstance {
    pub r#type: String,
    pub stamp: u32,
    pub x: f32,
    pub z: f32,
    pub rot_deg: f32,
    pub size_m: f32,
    pub intensity: f32,
}

impl RoadDetailSidecar {
    /// Parse + structurally validate a sidecar document.
    pub fn parse(json: &str) -> Result<Self> {
        let doc: RoadDetailSidecar = serde_json::from_str(json).context("parse sidecar json")?;
        doc.validate()?;
        Ok(doc)
    }

    pub fn validate(&self) -> Result<()> {
        if self.schema != ROAD_DETAIL_SCHEMA_V1 {
            bail!(
                "sidecar schema must be {ROAD_DETAIL_SCHEMA_V1}, got {:?}",
                self.schema
            );
        }
        if !(self.bounds.max_x > self.bounds.min_x && self.bounds.max_z > self.bounds.min_z) {
            bail!("sidecar bounds are degenerate: {:?}", self.bounds);
        }
        if self.materials.road.is_empty() {
            bail!("sidecar materials.road must name at least one GLB material");
        }
        if self.variants.is_empty() || self.variants.len() > 2 {
            bail!(
                "sidecar must declare 1-2 extra variants (base material is variant 0), got {}",
                self.variants.len()
            );
        }
        if !self.variants.iter().any(|v| v.role == "a") {
            bail!("sidecar variants must include role \"a\" (splat R channel)");
        }
        for v in &self.variants {
            if v.role != "a" && v.role != "b" {
                bail!("variant {} has unknown role {:?} (expected a|b)", v.id, v.role);
            }
            if !(v.tiling_per_meter > 0.0) {
                bail!("variant {} tilingPerMeter must be > 0", v.id);
            }
        }
        if !(self.detail_normal.tiling_per_meter > 0.0) {
            bail!("detailNormal.tilingPerMeter must be > 0");
        }
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Material extension
// ---------------------------------------------------------------------------

/// Uniform block mirrored by `RoadDetailParams` in road_detail.wgsl.
#[derive(Clone, Copy, Debug, ShaderType)]
pub struct RoadDetailUniform {
    pub bounds_min: Vec2,
    pub bounds_inv_size: Vec2,
    /// Repeats/m for variant A / variant B / detail normal.
    pub tiling: Vec3,
    pub detail_strength: f32,
    /// x: wear albedo darken, y: wear roughness delta,
    /// z: marking wear strength, w: mode (0 road, 1 marking).
    pub wear: Vec4,
}

#[derive(Asset, TypePath, AsBindGroup, Clone)]
pub struct RoadDetailExtension {
    #[uniform(100)]
    pub params: RoadDetailUniform,
    /// Tile-space splat mask; its clamp sampler is shared with the decal
    /// overlay in the shader.
    #[texture(101)]
    #[sampler(102)]
    pub splat: Handle<Image>,
    #[texture(103)]
    pub decal_overlay: Handle<Image>,
    #[texture(104)]
    pub var_a_color: Handle<Image>,
    #[texture(105)]
    pub var_a_normal: Handle<Image>,
    #[texture(106)]
    pub var_a_orm: Handle<Image>,
    #[texture(107)]
    pub var_b_color: Handle<Image>,
    #[texture(108)]
    pub var_b_normal: Handle<Image>,
    #[texture(109)]
    pub var_b_orm: Handle<Image>,
    /// World-tiled detail normal; its repeat sampler is shared with the
    /// variant textures in the shader.
    #[texture(110)]
    #[sampler(111)]
    pub detail_normal: Handle<Image>,
}

impl MaterialExtension for RoadDetailExtension {
    fn fragment_shader() -> ShaderRef {
        ShaderRef::Path("embedded://render_core/shaders/road_detail.wgsl".into())
    }
}

pub type RoadDetailMaterial = ExtendedMaterial<StandardMaterial, RoadDetailExtension>;

/// Registers the embedded shader + material pipeline. Added unconditionally
/// by [`crate::engine::SceneApp`]; costs nothing until a sidecar is applied.
pub struct RoadDetailPlugin;

impl Plugin for RoadDetailPlugin {
    fn build(&self, app: &mut App) {
        bevy::asset::embedded_asset!(app, "shaders/road_detail.wgsl");
        app.add_plugins(MaterialPlugin::<RoadDetailMaterial>::default());
    }
}

// ---------------------------------------------------------------------------
// Texture loading (CPU-decoded, fixed formats, no mips)
// ---------------------------------------------------------------------------

fn sampler_descriptor(repeat: bool) -> ImageSamplerDescriptor {
    let address = if repeat {
        ImageAddressMode::Repeat
    } else {
        ImageAddressMode::ClampToEdge
    };
    ImageSamplerDescriptor {
        address_mode_u: address,
        address_mode_v: address,
        address_mode_w: address,
        mag_filter: ImageFilterMode::Linear,
        min_filter: ImageFilterMode::Linear,
        mipmap_filter: ImageFilterMode::Linear,
        ..ImageSamplerDescriptor::default()
    }
}

/// Decode a PNG (or any `image`-supported format) into an RGBA8 [`Image`].
/// `srgb` selects `Rgba8UnormSrgb` (color data) vs `Rgba8Unorm` (masks,
/// normals, ORM). Deterministic: fixed decode, no mip generation.
fn load_texture(path: &Path, srgb: bool, repeat: bool) -> Result<Image> {
    let dynamic = image::open(path)
        .with_context(|| format!("decode road-detail texture {}", path.display()))?;
    let rgba = dynamic.to_rgba8();
    let (w, h) = rgba.dimensions();
    let format = if srgb {
        TextureFormat::Rgba8UnormSrgb
    } else {
        TextureFormat::Rgba8Unorm
    };
    let mut img = Image::new(
        Extent3d {
            width: w,
            height: h,
            depth_or_array_layers: 1,
        },
        TextureDimension::D2,
        rgba.into_raw(),
        format,
        RenderAssetUsages::RENDER_WORLD,
    );
    img.sampler = ImageSampler::Descriptor(sampler_descriptor(repeat));
    Ok(img)
}

// ---------------------------------------------------------------------------
// Scene application
// ---------------------------------------------------------------------------

/// Result of applying one sidecar to a spawned scene.
#[derive(Clone, Copy, Debug, Default)]
pub struct RoadDetailStats {
    pub road_entities: usize,
    pub marking_entities: usize,
}

/// Apply one road-detail sidecar to the world: load its textures, then swap
/// every entity whose `StandardMaterial` is one of the sidecar's named GLB
/// materials to the extended road material (mode road or marking).
///
/// Must run after the tile scenes have spawned (materials resolved). ID
/// clones and actor cuboids are untouched by construction: their materials
/// are engine-created, never GLB-named.
pub fn apply(app: &mut App, sidecar_path: &Path) -> Result<RoadDetailStats> {
    let json = std::fs::read_to_string(sidecar_path)
        .with_context(|| format!("read sidecar {}", sidecar_path.display()))?;
    let sidecar = RoadDetailSidecar::parse(&json)
        .with_context(|| format!("validate sidecar {}", sidecar_path.display()))?;
    let dir = sidecar_path
        .parent()
        .context("sidecar path has no parent directory")?;

    let var_a = sidecar
        .variants
        .iter()
        .find(|v| v.role == "a")
        .expect("validated: role a present");
    // Single-variant sidecars reuse variant A for the (zero-weighted) B slot.
    let var_b = sidecar.variants.iter().find(|v| v.role == "b").unwrap_or(var_a);

    // Decode all textures up front so any I/O error aborts before the world
    // is touched.
    let splat_img = load_texture(&dir.join(&sidecar.splat.texture), false, false)?;
    let decal_img = load_texture(&dir.join(&sidecar.decal_overlay.texture), true, false)?;
    let a_color = load_texture(&dir.join(&var_a.base_color), true, true)?;
    let a_normal = load_texture(&dir.join(&var_a.normal), false, true)?;
    let a_orm = load_texture(&dir.join(&var_a.orm), false, true)?;
    let b_color = load_texture(&dir.join(&var_b.base_color), true, true)?;
    let b_normal = load_texture(&dir.join(&var_b.normal), false, true)?;
    let b_orm = load_texture(&dir.join(&var_b.orm), false, true)?;
    let d_normal = load_texture(&dir.join(&sidecar.detail_normal.texture), false, true)?;

    let world = app.world_mut();
    let (splat, decal_overlay, var_a_color, var_a_normal, var_a_orm, var_b_color, var_b_normal, var_b_orm, detail_normal) = {
        let mut images = world.resource_mut::<Assets<Image>>();
        (
            images.add(splat_img),
            images.add(decal_img),
            images.add(a_color),
            images.add(a_normal),
            images.add(a_orm),
            images.add(b_color),
            images.add(b_normal),
            images.add(b_orm),
            images.add(d_normal),
        )
    };

    let size = Vec2::new(
        sidecar.bounds.max_x - sidecar.bounds.min_x,
        sidecar.bounds.max_z - sidecar.bounds.min_z,
    );
    let uniform = |mode: f32| RoadDetailUniform {
        bounds_min: Vec2::new(sidecar.bounds.min_x, sidecar.bounds.min_z),
        bounds_inv_size: Vec2::new(1.0 / size.x, 1.0 / size.y),
        tiling: Vec3::new(
            var_a.tiling_per_meter,
            var_b.tiling_per_meter,
            sidecar.detail_normal.tiling_per_meter,
        ),
        detail_strength: sidecar.detail_normal.strength,
        wear: Vec4::new(
            sidecar.params.wear_albedo_darken,
            sidecar.params.wear_roughness_delta,
            sidecar.params.marking_wear_strength,
            mode,
        ),
    };
    let extension = |mode: f32| RoadDetailExtension {
        params: uniform(mode),
        splat: splat.clone(),
        decal_overlay: decal_overlay.clone(),
        var_a_color: var_a_color.clone(),
        var_a_normal: var_a_normal.clone(),
        var_a_orm: var_a_orm.clone(),
        var_b_color: var_b_color.clone(),
        var_b_normal: var_b_normal.clone(),
        var_b_orm: var_b_orm.clone(),
        detail_normal: detail_normal.clone(),
    };

    // Target GLB material name -> mode (0.0 = road surface, 1.0 = marking).
    // The glTF loader tags every spawned primitive with `GltfMaterialName`,
    // which is what the sidecar names refer to.
    let mut target_modes: HashMap<&str, f32> = HashMap::new();
    for name in &sidecar.materials.road {
        target_modes.insert(name.as_str(), 0.0);
    }
    for name in &sidecar.materials.marking {
        target_modes.insert(name.as_str(), 1.0);
    }

    // Swap materials: one extended material per (source material, mode),
    // preserving the authored StandardMaterial as the blend base.
    let targets: Vec<(Entity, AssetId<StandardMaterial>, f32)> = {
        let mut q = world.query::<(
            Entity,
            &MeshMaterial3d<StandardMaterial>,
            &GltfMaterialName,
        )>();
        q.iter(world)
            .filter_map(|(e, mat, name)| {
                target_modes.get(name.0.as_str()).map(|mode| (e, mat.id(), *mode))
            })
            .collect()
    };
    if targets.is_empty() {
        bail!(
            "no sidecar material names matched the loaded GLBs (road: {:?}, marking: {:?})",
            sidecar.materials.road,
            sidecar.materials.marking
        );
    }
    let mut cache: HashMap<(AssetId<StandardMaterial>, u32), Handle<RoadDetailMaterial>> =
        HashMap::new();
    let mut stats = RoadDetailStats::default();
    for (entity, source_id, mode) in targets {
        let key = (source_id, mode as u32);
        let handle = if let Some(h) = cache.get(&key) {
            h.clone()
        } else {
            let base = world
                .resource::<Assets<StandardMaterial>>()
                .get(source_id)
                .context("source StandardMaterial not resolved")?
                .clone();
            let h = world
                .resource_mut::<Assets<RoadDetailMaterial>>()
                .add(RoadDetailMaterial {
                    base,
                    extension: extension(mode),
                });
            cache.insert(key, h.clone());
            h
        };
        world
            .entity_mut(entity)
            .remove::<MeshMaterial3d<StandardMaterial>>()
            .insert(MeshMaterial3d(handle));
        if mode < 0.5 {
            stats.road_entities += 1;
        } else {
            stats.marking_entities += 1;
        }
    }
    Ok(stats)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_sidecar() -> serde_json::Value {
        serde_json::json!({
            "schema": "simforge.road-detail/v1",
            "tileId": "easterbrook-discovery-school/road",
            "seed": 1337,
            "bounds": { "minX": -300.0, "minZ": -70.0, "maxX": 330.0, "maxZ": 410.0 },
            "materials": {
                "road": ["Asphalt1"],
                "marking": ["LaneMarking1", "LaneMarkingYellow1"]
            },
            "splat": { "texture": "splat.png" },
            "decalOverlay": { "texture": "decals.png" },
            "variants": [
                {
                    "id": "asphalt_02", "role": "a",
                    "baseColor": "asphalt_02_diff_1k.png",
                    "normal": "asphalt_02_nor_gl_1k.png",
                    "orm": "asphalt_02_arm_1k.png",
                    "tilingPerMeter": 0.35
                },
                {
                    "id": "concrete_pavement", "role": "b",
                    "baseColor": "concrete_pavement_diff_1k.png",
                    "normal": "concrete_pavement_nor_gl_1k.png",
                    "orm": "concrete_pavement_arm_1k.png",
                    "tilingPerMeter": 0.5
                }
            ],
            "detailNormal": {
                "texture": "asphalt_02_nor_gl_1k.png",
                "tilingPerMeter": 1.7,
                "strength": 0.5
            },
            "params": {
                "wearAlbedoDarken": 0.38,
                "wearRoughnessDelta": -0.22,
                "markingWearStrength": 0.85
            },
            "decals": [
                { "type": "crack", "stamp": 0, "x": 219.0, "z": 320.0,
                  "rotDeg": 45.0, "sizeM": 3.0, "intensity": 0.8 }
            ]
        })
    }

    #[test]
    fn parses_and_validates_v1_sidecar() {
        let doc = RoadDetailSidecar::parse(&sample_sidecar().to_string()).unwrap();
        assert_eq!(doc.schema, ROAD_DETAIL_SCHEMA_V1);
        assert_eq!(doc.materials.road, vec!["Asphalt1"]);
        assert_eq!(doc.variants.len(), 2);
        assert_eq!(doc.decals.len(), 1);
        assert!((doc.params.marking_wear_strength - 0.85).abs() < 1e-6);
    }

    #[test]
    fn rejects_wrong_schema() {
        let mut doc = sample_sidecar();
        doc["schema"] = "simforge.road-detail/v0".into();
        let err = RoadDetailSidecar::parse(&doc.to_string()).unwrap_err();
        assert!(err.to_string().contains("schema"), "{err}");
    }

    #[test]
    fn rejects_degenerate_bounds() {
        let mut doc = sample_sidecar();
        doc["bounds"]["maxX"] = doc["bounds"]["minX"].clone();
        assert!(RoadDetailSidecar::parse(&doc.to_string()).is_err());
    }

    #[test]
    fn rejects_missing_role_a() {
        let mut doc = sample_sidecar();
        doc["variants"][0]["role"] = "b".into();
        let err = RoadDetailSidecar::parse(&doc.to_string()).unwrap_err();
        assert!(err.to_string().contains("role"), "{err}");
    }

    #[test]
    fn rejects_empty_road_materials() {
        let mut doc = sample_sidecar();
        doc["materials"]["road"] = serde_json::json!([]);
        assert!(RoadDetailSidecar::parse(&doc.to_string()).is_err());
    }

    #[test]
    fn rejects_more_than_two_variants() {
        let mut doc = sample_sidecar();
        let extra = doc["variants"][1].clone();
        doc["variants"].as_array_mut().unwrap().push(extra);
        assert!(RoadDetailSidecar::parse(&doc.to_string()).is_err());
    }

    #[test]
    fn single_variant_sidecar_is_valid() {
        let mut doc = sample_sidecar();
        doc["variants"].as_array_mut().unwrap().truncate(1);
        let parsed = RoadDetailSidecar::parse(&doc.to_string()).unwrap();
        assert_eq!(parsed.variants.len(), 1);
    }
}
