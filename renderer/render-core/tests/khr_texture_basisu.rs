//! Observable contract for native `KHR_texture_basisu` loading.
//!
//! `fixtures/basisu-quad.glb` is a standards-compliant GLB: its texture
//! references a real production UASTC+zstd KTX2 image (1024x1024, full mip
//! chain, block-aligned) exclusively through
//! `extensions.KHR_texture_basisu.source`, omits core `texture.source`, and
//! lists `KHR_texture_basisu` in `extensionsRequired`. Stock bevy_gltf 0.19.1
//! rejects this file during glTF validation and cannot resolve the image
//! (bevyengine/bevy#19104); the vendored patch in renderer/vendor/bevy_gltf
//! must load it with validation enabled — no JSON flattening anywhere.
//!
//! The other cases rewrite that fixture's JSON chunk in place (same BIN) to
//! pin the color-space classification of extension slots and the loud failure
//! on a malformed extension source.

use std::path::Path;

use bevy::app::{App, TaskPoolPlugin};
use bevy::asset::{
    io::{
        memory::{Dir, MemoryAssetReader},
        AssetSourceBuilder, AssetSourceId,
    },
    AssetApp, AssetPlugin, AssetServer, Assets, Handle, LoadState,
};
use bevy::ecs::resource::Resource;
use bevy::gltf::{Gltf, GltfMaterial, GltfPlugin};
use bevy::image::{CompressedImageFormatSupport, CompressedImageFormats, Image};
use bevy::log::LogPlugin;
use bevy::mesh::MeshPlugin;
use bevy::world_serialization::WorldSerializationPlugin;
use serde_json::{json, Value};

const FIXTURE: &[u8] = include_bytes!("fixtures/basisu-quad.glb");
const FIXTURE_PATH: &str = "basisu-quad.glb";
const MAX_UPDATES: usize = 10_000;
const GLB_MAGIC: u32 = 0x4654_6C67;
const CHUNK_JSON: u32 = 0x4E4F_534A;
const CHUNK_BIN: u32 = 0x004E_4942;

#[expect(
    dead_code,
    reason = "the resource exists only to keep the glTF asset alive"
)]
#[derive(Resource)]
struct KeepAlive(Handle<Gltf>);

/// Splits a GLB into its JSON document and BIN chunk.
fn split_glb(bytes: &[u8]) -> (Value, Vec<u8>) {
    let u32_at = |offset: usize| u32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap());
    assert_eq!(u32_at(0), GLB_MAGIC);
    let mut offset = 12;
    let mut json = None;
    let mut bin = Vec::new();
    while offset + 8 <= bytes.len() {
        let length = u32_at(offset) as usize;
        let kind = u32_at(offset + 4);
        let body = &bytes[offset + 8..offset + 8 + length];
        match kind {
            CHUNK_JSON => json = Some(serde_json::from_slice(body).unwrap()),
            CHUNK_BIN => bin = body.to_vec(),
            _ => {}
        }
        offset += 8 + length;
    }
    (json.expect("GLB JSON chunk"), bin)
}

/// Re-encodes a GLB from a JSON document and BIN chunk.
fn join_glb(json: &Value, bin: &[u8]) -> Vec<u8> {
    let mut json_bytes = serde_json::to_vec(json).unwrap();
    while json_bytes.len() % 4 != 0 {
        json_bytes.push(b' ');
    }
    let mut bin_bytes = bin.to_vec();
    while bin_bytes.len() % 4 != 0 {
        bin_bytes.push(0);
    }
    let total = 12 + 8 + json_bytes.len() + 8 + bin_bytes.len();
    let mut out = Vec::with_capacity(total);
    out.extend_from_slice(&GLB_MAGIC.to_le_bytes());
    out.extend_from_slice(&2u32.to_le_bytes());
    out.extend_from_slice(&(total as u32).to_le_bytes());
    out.extend_from_slice(&(json_bytes.len() as u32).to_le_bytes());
    out.extend_from_slice(&CHUNK_JSON.to_le_bytes());
    out.extend_from_slice(&json_bytes);
    out.extend_from_slice(&(bin_bytes.len() as u32).to_le_bytes());
    out.extend_from_slice(&CHUNK_BIN.to_le_bytes());
    out.extend_from_slice(&bin_bytes);
    out
}

/// Loads `glb` through the real asset pipeline (BC transcoding, validation
/// enabled) and returns the app plus the load outcome.
fn load_glb(glb: Vec<u8>) -> (App, Handle<Gltf>, Result<(), String>) {
    let dir = Dir::default();
    dir.insert_asset(Path::new(FIXTURE_PATH), glb);

    let mut app = App::new();
    let reader = MemoryAssetReader { root: dir };
    app.register_asset_source(
        AssetSourceId::Default,
        AssetSourceBuilder::new(move || Box::new(reader.clone())),
    )
    .add_plugins((
        LogPlugin::default(),
        TaskPoolPlugin::default(),
        AssetPlugin::default(),
        WorldSerializationPlugin,
        MeshPlugin,
        GltfPlugin::default(),
    ))
    .init_asset::<Image>()
    // Production desktop GPUs expose BC; exercise the same UASTC -> BC7 path
    // used by native-render-service without requiring a physical GPU.
    .insert_resource(CompressedImageFormatSupport(CompressedImageFormats::BC));
    app.finish();
    app.cleanup();
    app.update();

    let asset_server = app.world().resource::<AssetServer>().clone();
    let handle: Handle<Gltf> = asset_server.load(FIXTURE_PATH);
    let handle_id = handle.id();
    app.insert_resource(KeepAlive(handle.clone()));

    let mut outcome = Err("glTF asset never finished loading".to_string());
    for _ in 0..MAX_UPDATES {
        app.update();
        match asset_server.get_load_state(handle_id).unwrap() {
            LoadState::Loaded => {
                outcome = Ok(());
                break;
            }
            LoadState::Failed(err) => {
                outcome = Err(err.to_string());
                break;
            }
            _ => {}
        }
    }
    (app, handle, outcome)
}

fn material_image<'a>(app: &'a App, handle: &Handle<Gltf>, pick: impl Fn(&GltfMaterial) -> Option<Handle<Image>>) -> &'a Image {
    let gltf = app
        .world()
        .resource::<Assets<Gltf>>()
        .get(handle)
        .expect("Gltf asset present");
    assert_eq!(gltf.materials.len(), 1, "one material");
    let material = app
        .world()
        .resource::<Assets<GltfMaterial>>()
        .get(&gltf.materials[0])
        .expect("GltfMaterial asset present");
    let texture = pick(material).expect("texture slot resolved through KHR_texture_basisu.source");
    app.world()
        .resource::<Assets<Image>>()
        .get(&texture)
        .expect("KTX2 image decoded and stored as labeled subasset")
}

#[test]
fn standards_compliant_basisu_glb_loads_natively() {
    let (app, handle, outcome) = load_glb(FIXTURE.to_vec());
    outcome.unwrap_or_else(|err| panic!("native KHR_texture_basisu load failed: {err}"));
    let image = material_image(&app, &handle, |material| material.base_color_texture.clone());
    assert_eq!(
        (image.width(), image.height()),
        (1024, 1024),
        "decoded KTX2 dimensions"
    );
    assert!(
        image.texture_descriptor.mip_level_count > 1,
        "authored mip chain survives decoding"
    );
    assert!(
        image.texture_descriptor.format.is_srgb(),
        "base color KTX2 decodes to an sRGB GPU format"
    );
}

#[test]
fn specular_strength_basisu_texture_decodes_linear() {
    let (mut json, bin) = split_glb(FIXTURE);
    // Second texture over the same KTX2 image, bound as the linear
    // KHR_materials_specular strength map next to the sRGB base color.
    json["textures"].as_array_mut().unwrap().push(json!({
        "extensions": { "KHR_texture_basisu": { "source": 0 } }
    }));
    json["extensionsUsed"].as_array_mut().unwrap().push(json!("KHR_materials_specular"));
    json["materials"][0]["extensions"] = json!({
        "KHR_materials_specular": { "specularTexture": { "index": 1 } }
    });
    let (app, handle, outcome) = load_glb(join_glb(&json, &bin));
    outcome.unwrap_or_else(|err| panic!("load failed: {err}"));

    let base = material_image(&app, &handle, |material| material.base_color_texture.clone());
    assert!(base.texture_descriptor.format.is_srgb(), "base color stays sRGB");
    let specular = material_image(&app, &handle, |material| material.specular_texture.clone());
    assert!(
        !specular.texture_descriptor.format.is_srgb(),
        "specularTexture is linear strength data, not color"
    );
}

#[test]
fn malformed_basisu_source_fails_instead_of_falling_back() {
    let (mut json, bin) = split_glb(FIXTURE);
    // Extension present but pointing past the image array, with a core
    // `source` that a permissive loader would silently use instead.
    json["textures"][0]["extensions"]["KHR_texture_basisu"]["source"] = json!(7);
    json["textures"][0]["source"] = json!(0);
    let (_app, _handle, outcome) = load_glb(join_glb(&json, &bin));
    let err = outcome.expect_err("malformed KHR_texture_basisu.source must fail the load");
    assert!(
        err.contains("malformed `KHR_texture_basisu.source`"),
        "unexpected error: {err}"
    );
}
