//! Catalog vehicle GLB resolution — consumes the CarlaVehicles model
//! convention (catalog/vehicles-carla): per-catalog-id `model` assignments
//! `{glbPath, attribution, source}` plus the `tintable` / `scaleToDims`
//! sidecar extras, GLBs in the y-up/+X-forward/ground-origin actor frame
//! with `body`/`wheel_*` nodes and a neutral `body_paint` material slot
//! (see catalog/vehicles-carla/CONVENTIONS.md).
//!
//! Resolution order for a models directory:
//! 1. `catalog-models.json` — the precomputed catalog-id -> model sidecar.
//! 2. `manifest.json` — per-GLB metadata; ids are mapped through a built-in
//!    catalog-id -> manifest-key table (same assignments the sidecar ships).
//!
//! Ids without a model keep the procedural primitive path in `catalog.rs`.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};

/// One resolvable vehicle model, in the vehicles-carla convention.
#[derive(Debug, Clone)]
pub struct VehicleModelEntry {
    /// Absolute path to the self-contained GLB.
    pub glb_path: PathBuf,
    /// CC BY attribution line (carried through to run reports).
    pub attribution: String,
    /// Asset provenance tag (e.g. `carla-0.10.0-ue5`).
    pub source: String,
    /// Whether the `body_paint` material may receive the authored tint.
    pub tintable: bool,
    /// Uniform-scale the GLB so its length matches the actor dims.
    pub scale_to_dims: bool,
    /// Authored model length in metres (manifest `dims_lwh_m[0]`), the
    /// denominator for `scale_to_dims`.
    pub model_length_m: Option<f64>,
    /// Manifest-authored uniform scale for raw asset-space geometry.
    pub uniform_scale: Option<f32>,
    /// Model-space yaw correction in radians (+Y).
    pub yaw_offset_rad: f32,
    /// Grounding offset added to the actor's authored Y coordinate.
    pub ground_offset_m: f32,
    /// Motion-state animation GLBs and their named clips.
    pub animations: HashMap<String, (PathBuf, String)>,
}

/// Catalog-id keyed model table. The sorted fallback list supports stable
/// per-actor assignment for generic pedestrian catalog ids.
#[derive(Debug, Default, Clone)]
pub struct VehicleModelCatalog {
    by_catalog_id: HashMap<String, VehicleModelEntry>,
    fallback: Vec<(String, VehicleModelEntry)>,
}

/// Built-in catalog-id -> manifest-key assignments, used when the
/// `catalog-models.json` sidecar is absent. Mirrors the CarlaVehicles
/// precomputed mapping (family fallbacks included).
const FALLBACK_ASSIGNMENTS: &[(&str, &str)] = &[
    ("vehicle.sedan", "vehicle_sedan_lincoln_mkz"),
    ("vehicle.taxi", "vehicle_sedan_ford_crown"),
    ("vehicle.police_cruiser", "vehicle_police_dodge_charger"),
    ("vehicle.suv", "vehicle_suv_nissan_patrol"),
    ("vehicle.hatchback", "vehicle_hatchback_mini_cooper"),
    ("vehicle.ford_mustang", "vehicle_coupe_ford_mustang"),
    ("vehicle.kia.carnival", "vehicle_minivan_bmw_gran_tourer"),
    ("vehicle.van", "vehicle_van_mercedes_sprinter"),
    ("vehicle.bus", "vehicle_bus_mitsubishi_fusorosa"),
    ("vehicle.box_truck", "vehicle_truck_carlacola"),
    ("vehicle.semi_truck", "vehicle_truck_european_hgv"),
    ("vehicle.pickup", "vehicle_pickup_tesla_cybertruck"),
    ("vehicle.motorcycle", "vehicle_motorcycle_harley"),
];

impl VehicleModelCatalog {
    /// Load the model table from a vehicles-carla style directory.
    pub fn load(dir: &Path) -> Result<Self> {
        let sidecar = dir.join("catalog-models.json");
        if sidecar.is_file() {
            return Self::from_sidecar(dir, &sidecar);
        }
        let manifest = dir.join("manifest.json");
        if manifest.is_file() {
            return Self::from_manifest(dir, &manifest);
        }
        bail!(
            "no catalog-models.json or manifest.json under {}",
            dir.display()
        );
    }

    pub fn resolve(&self, catalog_id: &str) -> Option<&VehicleModelEntry> {
        self.by_catalog_id.get(catalog_id)
    }

    /// Select one entry deterministically for an actor whose generic catalog id
    /// has no exact blueprint model. Uses a process-independent FNV-1a hash.
    pub fn resolve_deterministic(&self, actor_id: &str) -> Option<(&str, &VehicleModelEntry)> {
        if self.fallback.is_empty() {
            return None;
        }
        let hash = actor_id
            .bytes()
            .fold(0xcbf29ce484222325_u64, |hash, byte| {
                (hash ^ u64::from(byte)).wrapping_mul(0x100000001b3)
            });
        let (catalog_id, entry) = &self.fallback[hash as usize % self.fallback.len()];
        Some((catalog_id.as_str(), entry))
    }

    pub fn is_empty(&self) -> bool {
        self.by_catalog_id.is_empty()
    }

    pub fn len(&self) -> usize {
        self.by_catalog_id.len()
    }

    /// `catalog-models.json`: `{ "<catalogId>": { "model": {glbPath,
    /// attribution, source}, "tintable"?, "scaleToDims"? }, ... }`.
    /// Flat entries (`{glbPath, ...}` without the `model` wrapper) are
    /// accepted too, as is a top-level `"models"`/`"entries"` wrapper.
    fn from_sidecar(dir: &Path, path: &Path) -> Result<Self> {
        let raw: serde_json::Value = serde_json::from_slice(
            &std::fs::read(path).with_context(|| format!("read {}", path.display()))?,
        )?;
        let map = ["models", "entries", "vehicles"]
            .iter()
            .find_map(|k| raw.get(*k).and_then(|v| v.as_object()))
            .or_else(|| raw.as_object())
            .context("catalog-models.json: expected an object")?;

        // Model lengths come from the manifest when it is available.
        let lengths = manifest_lengths(&dir.join("manifest.json"));

        let mut by_catalog_id = HashMap::new();
        for (catalog_id, value) in map {
            if !catalog_id.contains('.') {
                continue; // wrapper metadata like "version"
            }
            let model = value.get("model").unwrap_or(value);
            let Some(glb) = model.get("glbPath").and_then(|v| v.as_str()) else {
                continue;
            };
            let glb_path = resolve_glb_path(dir, glb);
            let file_stem = glb_path
                .file_stem()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_default();
            by_catalog_id.insert(
                catalog_id.clone(),
                VehicleModelEntry {
                    glb_path,
                    attribution: model
                        .get("attribution")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string(),
                    source: model
                        .get("source")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string(),
                    tintable: value
                        .get("tintable")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(true),
                    scale_to_dims: value
                        .get("scaleToDims")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(false),
                    model_length_m: lengths.get(&file_stem).copied(),
                    uniform_scale: value
                        .get("uniformScale")
                        .and_then(|v| v.as_f64())
                        .map(|v| v as f32),
                    yaw_offset_rad: value
                        .get("yawOffsetRad")
                        .and_then(|v| v.as_f64())
                        .unwrap_or(0.0) as f32,
                    ground_offset_m: value
                        .get("groundOffsetM")
                        .and_then(|v| v.as_f64())
                        .unwrap_or(0.0) as f32,
                    animations: value
                        .get("animations")
                        .and_then(|v| v.as_object())
                        .into_iter()
                        .flatten()
                        .filter_map(|(name, value)| {
                            let path = value.get("glbPath")?.as_str()?;
                            let clip = value.get("clip")?.as_str()?;
                            Some((
                                name.clone(),
                                (resolve_glb_path(dir, path), clip.to_string()),
                            ))
                        })
                        .collect(),
                },
            );
        }
        let mut fallback: Vec<_> = by_catalog_id
            .iter()
            .map(|(id, entry)| (id.clone(), entry.clone()))
            .collect();
        fallback.sort_by(|a, b| a.0.cmp(&b.0));
        Ok(Self {
            by_catalog_id,
            fallback,
        })
    }

    /// `manifest.json` fallback: map catalog ids through the built-in
    /// assignment table onto manifest entries.
    fn from_manifest(dir: &Path, path: &Path) -> Result<Self> {
        let raw: serde_json::Value = serde_json::from_slice(
            &std::fs::read(path).with_context(|| format!("read {}", path.display()))?,
        )?;
        let vehicles = raw
            .get("vehicles")
            .and_then(|v| v.as_object())
            .context("manifest.json: expected {vehicles: {...}}")?;

        let mut by_catalog_id = HashMap::new();
        for (catalog_id, manifest_key) in FALLBACK_ASSIGNMENTS {
            let Some(entry) = vehicles.get(*manifest_key) else {
                continue;
            };
            let Some(file) = entry.get("file").and_then(|v| v.as_str()) else {
                continue;
            };
            let glb_path = resolve_glb_path(dir, file);
            if !glb_path.is_file() {
                continue;
            }
            let display = entry
                .get("display")
                .and_then(|v| v.as_str())
                .unwrap_or(manifest_key);
            by_catalog_id.insert(
                (*catalog_id).to_string(),
                VehicleModelEntry {
                    glb_path,
                    attribution: format!(
                        "\"{display}\" vehicle model \u{a9} CARLA Simulator contributors (carla.org), CC BY 4.0; converted to glTF for SimForge."
                    ),
                    source: "carla-0.10.0-ue5".to_string(),
                    tintable: entry
                        .get("tintable")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(false),
                    // vehicle.semi_truck: catalog length includes a trailer
                    // but the GLB is the tractor unit only — length scaling
                    // would squash it (sidecar ships scaleToDims=false too).
                    scale_to_dims: *catalog_id != "vehicle.semi_truck",
                    model_length_m: entry
                        .get("dims_lwh_m")
                        .and_then(|v| v.as_array())
                        .and_then(|a| a.first())
                        .and_then(|v| v.as_f64()),
                    uniform_scale: None,
                    yaw_offset_rad: 0.0,
                    ground_offset_m: 0.0,
                    animations: HashMap::new(),
                },
            );
        }
        let mut fallback: Vec<_> = by_catalog_id
            .iter()
            .map(|(id, entry)| (id.clone(), entry.clone()))
            .collect();
        fallback.sort_by(|a, b| a.0.cmp(&b.0));
        Ok(Self {
            by_catalog_id,
            fallback,
        })
    }
}

/// GLB path resolution: absolute as-is; else relative to the models dir;
/// else (sidecar paths are repo-root-relative like
/// `catalog/vehicles-carla/models/x.glb`) strip the leading components that
/// duplicate the models dir name.
fn resolve_glb_path(dir: &Path, glb: &str) -> PathBuf {
    let p = Path::new(glb);
    if p.is_absolute() {
        return p.to_path_buf();
    }
    let local = dir.join(p);
    if local.is_file() {
        return local;
    }
    // Repo-root-relative: keep everything after the models dir's own name.
    if let Some(dir_name) = dir.file_name().and_then(|n| n.to_str()) {
        if let Some(idx) = glb.find(&format!("{dir_name}/")) {
            let tail = &glb[idx + dir_name.len() + 1..];
            let candidate = dir.join(tail);
            if candidate.is_file() {
                return candidate;
            }
        }
    }
    local
}

fn manifest_lengths(manifest: &Path) -> HashMap<String, f64> {
    let mut out = HashMap::new();
    let Ok(bytes) = std::fs::read(manifest) else {
        return out;
    };
    let Ok(raw) = serde_json::from_slice::<serde_json::Value>(&bytes) else {
        return out;
    };
    if let Some(vehicles) = raw.get("vehicles").and_then(|v| v.as_object()) {
        for (key, entry) in vehicles {
            if let Some(l) = entry
                .get("dims_lwh_m")
                .and_then(|v| v.as_array())
                .and_then(|a| a.first())
                .and_then(|v| v.as_f64())
            {
                out.insert(key.clone(), l);
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::VehicleModelCatalog;
    use std::fs;

    #[test]
    fn meshy_sidecar_resolves_scale_grounding_yaw_and_animation() {
        let root = std::env::temp_dir().join(format!("simforge-actor-catalog-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("models/vehicle.sedan/animations")).unwrap();
        fs::write(root.join("models/vehicle.sedan/model.glb"), b"glb").unwrap();
        fs::write(root.join("models/vehicle.sedan/animations/walk.glb"), b"glb").unwrap();
        fs::write(
            root.join("catalog-models.json"),
            r#"{
              "vehicle.sedan": {
                "model": {"glbPath":"models/vehicle.sedan/model.glb","source":"meshy"},
                "tintable":false,
                "scaleToDims":false,
                "uniformScale":2.5,
                "yawOffsetRad":1.5707964,
                "groundOffsetM":0.72,
                "animations":{"walk":{"glbPath":"models/vehicle.sedan/animations/walk.glb","clip":"Walk"}}
              }
            }"#,
        )
        .unwrap();

        let catalog = VehicleModelCatalog::load(&root).unwrap();
        let entry = catalog.resolve("vehicle.sedan").unwrap();
        assert_eq!(entry.uniform_scale, Some(2.5));
        assert!((entry.yaw_offset_rad - std::f32::consts::FRAC_PI_2).abs() < 1e-6);
        assert_eq!(entry.ground_offset_m, 0.72);
        assert_eq!(
            entry.animations.get("walk").map(|(_, clip)| clip.as_str()),
            Some("Walk")
        );
        assert!(catalog.resolve("vehicle.unmapped").is_none());
        fs::remove_dir_all(root).unwrap();
    }
}
