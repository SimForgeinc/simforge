//! Semantic class taxonomy and legend for the native sensor suite.
//!
//! Semantic-class IDs are a small closed set derived from (a) the scenario
//! model actor classes and (b) static map classes. They are stable across
//! maps, scenes and runs — the semantic pass encodes the class ID in the red
//! channel of an unlit RGBA render (see `class_color_bytes`).
//!
//! Instance IDs are per-scene and assigned deterministically (entities sorted
//! by mesh/actor name then entity index, 1-based; 0 = background), matching
//! the spike approach. The instance legend (id -> name) is written next to
//! every capture as `legend.json`.

use serde::{Deserialize, Serialize};

/// Closed semantic class set. Serialized values are the canonical names.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[repr(u8)]
pub enum SemanticClass {
    /// No geometry (sky / clear color).
    Unlabeled = 0,
    Road = 1,
    Building = 2,
    Vegetation = 3,
    Car = 4,
    /// Trucks and buses (scenario model `kind: bus` folds into truck class).
    Truck = 5,
    Pedestrian = 6,
    Cyclist = 7,
    /// Props and anything else authored in the prop catalog.
    Prop = 8,
}

impl SemanticClass {
    pub const ALL: [SemanticClass; 9] = [
        SemanticClass::Unlabeled,
        SemanticClass::Road,
        SemanticClass::Building,
        SemanticClass::Vegetation,
        SemanticClass::Car,
        SemanticClass::Truck,
        SemanticClass::Pedestrian,
        SemanticClass::Cyclist,
        SemanticClass::Prop,
    ];

    pub fn id(self) -> u8 {
        self as u8
    }

    pub fn name(self) -> &'static str {
        match self {
            SemanticClass::Unlabeled => "unlabeled",
            SemanticClass::Road => "road",
            SemanticClass::Building => "building",
            SemanticClass::Vegetation => "vegetation",
            SemanticClass::Car => "car",
            SemanticClass::Truck => "truck",
            SemanticClass::Pedestrian => "pedestrian",
            SemanticClass::Cyclist => "cyclist",
            SemanticClass::Prop => "prop",
        }
    }

    /// Classify a scenario-model actor class/kind string.
    pub fn from_actor_class(actor_class: &str) -> SemanticClass {
        match actor_class {
            "car" => SemanticClass::Car,
            "truck" | "bus" => SemanticClass::Truck,
            "pedestrian" => SemanticClass::Pedestrian,
            "cyclist" => SemanticClass::Cyclist,
            _ => SemanticClass::Prop,
        }
    }

    /// Classify a static corpus mesh by its GLB node/mesh name (same naming
    /// the spike legend exposed, e.g. `2301_16569_B_56.Building_56_st`).
    /// Order matters: vegetation before building, road last as the fallback
    /// for ground/roadway geometry.
    pub fn from_mesh_name(name: &str) -> SemanticClass {
        let n = name.to_ascii_lowercase();
        if ["tree", "veg", "bush", "shrub", "plant", "foliage", "grass", "hedge"]
            .iter()
            .any(|k| n.contains(k))
        {
            return SemanticClass::Vegetation;
        }
        if n.contains("building") {
            return SemanticClass::Building;
        }
        if ["road", "roadway", "asphalt", "sidewalk", "curb", "ground", "pavement", "crosswalk", "marking"]
            .iter()
            .any(|k| n.contains(k))
        {
            return SemanticClass::Road;
        }
        SemanticClass::Prop
    }
}

/// The legend written as `<out>/legend.json` for every capture: semantic
/// classes plus the deterministic instance-ID assignment.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Legend {
    pub schema: &'static str,
    /// Semantic class id -> name.
    pub classes: Vec<(u8, &'static str)>,
    /// Instance id -> display name (mesh name or actor id). Sorted by id.
    pub instances: Vec<(u32, String)>,
    /// Per instance: semantic class id.
    pub instance_classes: Vec<(u32, u8)>,
}

/// LiDAR intensity proxy albedo per semantic class (0..1). Deterministic,
/// hand-calibrated order-of-magnitude values; documented in TAXONOMY.md.
pub fn lidar_albedo(class: SemanticClass) -> f32 {
    match class {
        SemanticClass::Unlabeled => 0.0,
        SemanticClass::Road => 0.25,
        SemanticClass::Building => 0.45,
        SemanticClass::Vegetation => 0.55,
        SemanticClass::Car => 0.70,
        SemanticClass::Truck => 0.65,
        SemanticClass::Pedestrian => 0.60,
        SemanticClass::Cyclist => 0.60,
        SemanticClass::Prop => 0.50,
    }
}
