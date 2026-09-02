//! Vegetation sidecar instancing for the yale-street corpus.
//!
//! Vegetation ships as one GLB per tile (`veg_<t>.lod0.glb`) holding a
//! handful of *prototype* subtrees (quantized meshes under named nodes such
//! as `SM_Maple_M_LOD0`), plus a `*.instances.json` sidecar:
//!
//! ```json
//! { "prototypes": ["SM_Bush_M_v4_LOD0", ...],
//!   "counts": [2, 2, ...],
//!   "transforms": [ /* 16 f32 per instance, column-major */ ],
//!   "lodKeepCounts": [[...], ...] }
//! ```
//!
//! Matrix convention (verified against the Yale Street data and mirrored from
//! the three.js reference implementation in
//! `packages/city-renderer/src/vegetation.ts`, do not change without
//! re-deriving): `transforms` is **column-major** — translation lands at
//! offsets 12/13/14, exactly what `Mat4::from_cols_array` expects, and lands
//! inside the tile bounds (x ≈ 560–620, y ≈ 12–16, z ≈ −1780..−1640). The
//! instance scale is tiny because it is relative to the prototype node's own
//! transform (the KHR_mesh_quantization decode scale); the world placement is
//! `instance × prototype_local`, matching three.js `instance * nodeWorld`.
//!
//! Flow: [`spawn_veg`] starts asset loads; [`load_veg_roots`] spawns each
//! scene as a [`WorldAssetRoot`] tagged with a [`VegRoot`];
//! [`instantiate_veg`] waits for the scene instance to be ready, flattens
//! each named prototype subtree into mesh/material parts once, and spawns one
//! detached root per sidecar matrix with those parts as children. The
//! prototypes themselves are hidden (three.js never draws them either — their
//! authored transforms are quantization-space, not world). bevy_ecs
//! `clone_and_spawn` is deliberately shallow (relationships are not
//! recursed), which is why instances are assembled from templates instead of
//! cloned.
//!
//! Alpha-cutout materials survive untouched: the glTF loader keeps
//! `alphaMode MASK` as alpha-cutoff on the spawned standard materials.

use std::path::PathBuf;

use bevy::gltf::Gltf;
use bevy::math::Mat4;
use bevy::prelude::*;
use bevy::world_serialization::{WorldAssetRoot, WorldInstance, WorldInstanceSpawner};
use serde::Deserialize;

/// Parsed `*.instances.json` sidecar.
#[derive(Deserialize, Debug)]
pub struct VegInstances {
    pub prototypes: Vec<String>,
    pub counts: Vec<u32>,
    #[serde(default)]
    pub transforms: Vec<f32>,
}

impl VegInstances {
    /// Flat column-major 4×4 matrices, one per instance in
    /// prototype/counts order.
    pub fn matrices(&self) -> Result<Vec<[f32; 16]>, String> {
        let total: usize = self.counts.iter().map(|&c| c as usize).sum();
        if self.transforms.len() != total * 16 {
            return Err(format!(
                "transforms length {} != 16 × Σcounts ({total})",
                self.transforms.len()
            ));
        }
        Ok(self
            .transforms
            .chunks_exact(16)
            .map(|c| c.try_into().unwrap())
            .collect())
    }
}

/// Pending vegetation GLB load (`handle`, sidecar path).
#[derive(Component)]
pub struct VegLoad(pub Handle<Gltf>, pub PathBuf);

/// Loader entity whose scene root was already spawned.
#[derive(Component)]
pub struct VegSceneSpawned;

/// Scene root carrying the parsed instancing plan.
#[derive(Component)]
pub struct VegRoot {
    pub prototypes: Vec<String>,
    pub counts: Vec<u32>,
    pub matrices: Vec<[f32; 16]>,
}

/// Root whose prototypes have been expanded into instances.
#[derive(Component)]
pub struct VegInstantiated;

/// Permanently failed load (missing/invalid GLB or sidecar).
#[derive(Component)]
pub struct VegFailed;

/// Sidecar path for a veg GLB: `<stem>[.lodN].glb` → `<stem>.instances.json`
/// (the sidecars are LOD-independent: `veg_2_4.lod0.glb` →
/// `veg_2_4.instances.json`).
fn sidecar_path(glb: &str) -> PathBuf {
    let stem = glb.strip_suffix(".glb").unwrap_or(glb);
    let stem = match stem.rfind(".lod") {
        // ".lod" must be a suffix segment: ".lod0", ".lod12", …
        Some(i)
            if !stem[i + 4..].is_empty() && stem[i + 4..].bytes().all(|b| b.is_ascii_digit()) =>
        {
            &stem[..i]
        }
        _ => stem,
    };
    PathBuf::from(format!("{stem}.instances.json"))
}

/// Start loading every veg GLB; mirrors the tile-load pattern of the binary.
pub fn spawn_veg(commands: &mut Commands, server: &AssetServer, veg_glbs: &[String]) {
    for g in veg_glbs {
        let path = g.trim_start_matches('/').to_owned();
        let handle: Handle<Gltf> = server.load(&path);
        commands.spawn(VegLoad(handle, sidecar_path(g)));
    }
}

/// Once a veg GLB is loaded, spawn its scene with the parsed plan. The veg
/// GLBs do not declare a default `scene` (unlike the building tiles), so fall
/// back to the first scene.
pub fn load_veg_roots(
    mut commands: Commands,
    gltfs: Res<Assets<Gltf>>,
    loads: Query<
        (Entity, &VegLoad),
        (
            Without<VegSceneSpawned>,
            Without<VegRoot>,
            Without<VegFailed>,
        ),
    >,
) {
    for (e, load) in &loads {
        let Some(gltf) = gltfs.get(&load.0) else {
            continue;
        };
        // No `scene` property in these GLBs — take the first scene.
        let Some(scene) = gltf.default_scene.clone().or_else(|| gltf.scenes.first().cloned())
        else {
            error!("veg GLB without any scene: {}", load.1.display());
            commands.entity(e).insert(VegFailed);
            continue;
        };
        // The glTF-native tiler writes `veg_*.glb` tiles as already-placed
        // geometry (RoadRunner/UE exports carry no instancing plan), so a
        // missing sidecar means "this is a static tile", not a broken one.
        // Dropping it silently lost whole terrains from every native render.
        if !load.1.is_file() {
            info!("veg {}: no instances sidecar; spawning as placed geometry", load.1.display());
            commands.entity(e).insert(VegSceneSpawned);
            commands.spawn((WorldAssetRoot(scene),));
            continue;
        }
        let data: VegInstances = match std::fs::read_to_string(&load.1)
            .map_err(|e| e.to_string())
            .and_then(|t| serde_json::from_str(&t).map_err(|e| e.to_string()))
        {
            Ok(d) => d,
            Err(err) => {
                error!("veg sidecar {}: {err}", load.1.display());
                commands.entity(e).insert(VegFailed);
                continue;
            }
        };
        let matrices = match data.matrices() {
            Ok(m) => m,
            Err(err) => {
                error!("veg sidecar {}: {err}", load.1.display());
                commands.entity(e).insert(VegFailed);
                continue;
            }
        };
        info!(
            "veg {}: {} instances / {} prototypes",
            load.1.display(),
            matrices.len(),
            data.prototypes.len()
        );
        commands.entity(e).insert(VegSceneSpawned);
        commands.spawn((
            WorldAssetRoot(scene),
            VegRoot {
                prototypes: data.prototypes,
                counts: data.counts,
                matrices,
            },
        ));
    }
}

/// Decompose a column-major world matrix into a [`Transform`].
fn transform_from_mat(m: Mat4) -> Transform {
    let (scale, rot, trans) = m.to_scale_rotation_translation();
    Transform {
        translation: trans,
        rotation: rot,
        scale,
    }
}

/// One renderable part of a prototype subtree: mesh + material + transform
/// relative to the prototype root.
struct ProtoPart {
    mesh: Handle<Mesh>,
    material: Handle<StandardMaterial>,
    local: Transform,
}

/// For every ready [`VegRoot`], flatten each named prototype subtree once
/// into mesh/material parts, then spawn one detached root per sidecar matrix
/// (`instance × prototype_local`) with those parts as children. Idempotent
/// via [`VegInstantiated`].
pub fn instantiate_veg(
    mut commands: Commands,
    spawner: Option<Res<WorldInstanceSpawner>>,
    roots: Query<(Entity, &WorldInstance, &VegRoot), Without<VegInstantiated>>,
    names: Query<&Name>,
    children_q: Query<&Children>,
    transforms: Query<&Transform>,
    parts_q: Query<(&Mesh3d, &MeshMaterial3d<StandardMaterial>)>,
) {
    let Some(spawner) = spawner else {
        return;
    };

    /// Collect (mesh, material, proto-root-relative transform) for every
    /// renderable primitive under `e`.
    fn flatten(
        e: Entity,
        acc: Transform,
        children_q: &Query<&Children>,
        transforms: &Query<&Transform>,
        parts_q: &Query<(&Mesh3d, &MeshMaterial3d<StandardMaterial>)>,
        parts: &mut Vec<ProtoPart>,
    ) {
        let t = transforms.get(e).copied().unwrap_or(Transform::IDENTITY);
        let here = acc * t;
        if let Ok((mesh, mat)) = parts_q.get(e) {
            parts.push(ProtoPart {
                mesh: mesh.0.clone(),
                material: mat.0.clone(),
                local: here,
            });
        }
        if let Ok(kids) = children_q.get(e) {
            for k in kids.iter() {
                flatten(k, here, children_q, transforms, parts_q, parts);
            }
        }
    }

    for (root_e, wi, vr) in &roots {
        if !spawner.instance_is_ready(**wi) {
            continue;
        }
        // First entity wins per prototype name.
        let mut by_name = std::collections::HashMap::<String, Entity>::new();
        let mut stack = vec![root_e];
        while let Some(e) = stack.pop() {
            if let Ok(kids) = children_q.get(e) {
                stack.extend(kids.iter());
            }
            if let Ok(n) = names.get(e) {
                by_name.entry(n.to_string()).or_insert(e);
            }
        }

        let mut missing: Vec<String> = Vec::new();
        let mut offset = 0usize;
        let mut total_placed = 0usize;
        for (p, proto) in vr.prototypes.iter().enumerate() {
            let count = vr.counts.get(p).copied().unwrap_or(0) as usize;
            offset += count;
            if count == 0 {
                continue;
            }
            let Some(&proto_e) = by_name.get(proto.as_str()) else {
                missing.push(proto.clone());
                continue;
            };
            // Flatten the subtree once, relative to the prototype root —
            // the root's own quantization-decode transform is applied via
            // `proto_local` below, so it must not be baked into the parts.
            let mut parts = Vec::new();
            if let Ok(kids) = children_q.get(proto_e) {
                for k in kids.iter() {
                    flatten(
                        k,
                        Transform::IDENTITY,
                        &children_q,
                        &transforms,
                        &parts_q,
                        &mut parts,
                    );
                }
            }
            if parts.is_empty() {
                missing.push(proto.clone());
                continue;
            }
            // Prototype node transform (quantization decode scale/offset).
            let pt = transforms.get(proto_e).copied().unwrap_or(Transform::IDENTITY);
            let proto_local =
                Mat4::from_scale_rotation_translation(pt.scale, pt.rotation, pt.translation);
            for (i, m) in vr.matrices[offset - count..offset].iter().enumerate() {
                let world = Mat4::from_cols_array(m) * proto_local;
                let inst = commands
                    .spawn((
                        Name::from(format!("{proto}_inst{i}")),
                        transform_from_mat(world),
                    ))
                    .id();
                for part in &parts {
                    let pe = commands
                        .spawn((
                            Mesh3d(part.mesh.clone()),
                            MeshMaterial3d(part.material.clone()),
                            part.local,
                        ))
                        .id();
                    commands.entity(inst).add_child(pe);
                }
                total_placed += 1;
            }
        }
        if !missing.is_empty() {
            warn!("veg root {root_e}: prototypes without geometry: {missing:?}");
        }
        // The authored subtrees are quantization-space; three.js never draws
        // them either — hide instead of despawn so handles stay shared.
        for e in by_name.values() {
            commands.entity(*e).insert(Visibility::Hidden);
        }
        commands.entity(root_e).insert(VegInstantiated);
        info!("veg root {root_e}: {total_placed} instances placed");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Column-major layout: translation must land at offsets 12/13/14 and
    /// decode to tile-bound coordinates (see module docs).
    #[test]
    fn sidecar_matrices_are_column_major() {
        let m = [
            0.00257, 0.0, -0.00429, 0.0, //
            0.0, 0.005, 0.0, 0.0, //
            0.00429, 0.0, 0.00257, 0.0, //
            560.76, 12.88, -1762.08, 1.0,
        ];
        let t = transform_from_mat(Mat4::from_cols_array(&m));
        assert!((t.translation.x - 560.76).abs() < 1e-3);
        assert!((t.translation.y - 12.88).abs() < 1e-3);
        assert!((t.translation.z + 1762.08).abs() < 1e-3);
        assert!((t.scale.y - 0.005).abs() < 1e-6);
    }

    #[test]
    fn sidecar_path_strips_lod() {
        assert_eq!(
            sidecar_path("/tiles/veg_2_4.lod0.glb"),
            PathBuf::from("/tiles/veg_2_4.instances.json")
        );
        assert_eq!(
            sidecar_path("/tiles/veg_2_4.glb"),
            PathBuf::from("/tiles/veg_2_4.instances.json")
        );
    }
}
