//! Procedural actor geometry bound to prop-catalog entries.
//!
//! The prop-catalog builds three.js meshes in code (packages/prop-catalog);
//! there are no GLBs, so render-core mirrors the same minimum visual grammar
//! procedurally: body/cabin/wheels for vehicles, capsule+head for
//! pedestrians. Actor local frame: length along +X so a yaw-about-+Y rotation
//! by `headingRad` aligns +X with the scene-frame travel direction
//! `(cos h, 0, -sin h)`.

use bevy::math::primitives::{Capsule3d, Cuboid, Cylinder};
use bevy::prelude::{Color, Mesh, Transform};

use crate::scene_state::{ActorDesc, Dims};

pub struct ActorPart {
    pub mesh: Mesh,
    /// Offset of the part relative to the actor root (ground-centre origin).
    pub offset: Transform,
    /// Stable part name feeding the instance-ID legend.
    pub name: String,
    /// Base colour (sRGB).
    pub color: Color,
}

fn vehicle_color(catalog_id: &str) -> Color {
    // Deterministic muted palette keyed by catalog id (matches the spirit of
    // the catalog's defaultParams colours without shipping them here).
    let hash = catalog_id.bytes().fold(0x811c9dc5u32, |h, b| {
        h ^ u32::from(b)
            .wrapping_mul(0x01000193)
            .wrapping_add(0x9e3779b9)
    });
    let hue = (hash % 360) as f32;
    Color::srgb(
        0.35 + 0.4 * (hue.to_radians()).sin().abs(),
        0.32 + 0.35 * ((hue + 120.0).to_radians()).sin().abs(),
        0.30 + 0.4 * ((hue + 240.0).to_radians()).sin().abs(),
    )
}

const WHEEL_COLOR: Color = Color::srgb(0.08, 0.08, 0.09);

/// Build the part list for one actor description.
pub fn actor_parts(actor: &ActorDesc) -> Vec<ActorPart> {
    let dims = actor.dims.unwrap_or(match actor.actor_class.as_str() {
        "pedestrian" => Dims { l: 0.6, w: 0.6, h: 1.75 },
        "bicycle" => Dims { l: 1.7, w: 0.5, h: 1.7 },
        _ => Dims { l: 4.7, w: 1.82, h: 1.45 },
    });
    let (l, w, h) = (dims.l as f32, dims.w as f32, dims.h as f32);
    let color = vehicle_color(&actor.catalog_id);
    let mut parts = Vec::new();

    match actor.actor_class.as_str() {
        "pedestrian" => {
            parts.push(ActorPart {
                mesh: Mesh::from(Capsule3d {
                    radius: (w * 0.28).max(0.12),
                    half_length: h * 0.22,
                }),
                offset: Transform::from_xyz(0.0, h * 0.38, 0.0),
                name: "torso".into(),
                color,
            });
            parts.push(ActorPart {
                mesh: Mesh::from(Cuboid::new(
                    (w * 0.42).max(0.18),
                    (w * 0.42).max(0.18),
                    (w * 0.42).max(0.18),
                )),
                offset: Transform::from_xyz(0.0, h * 0.82, 0.0),
                name: "head".into(),
                color,
            });
        }
        "bicycle" => {
            let wheel_r = h * 0.16;
            for (i, dx) in [l * 0.32, -l * 0.32].into_iter().enumerate() {
                parts.push(ActorPart {
                    mesh: rotated_cyl(wheel_r, 0.04),
                    offset: Transform::from_xyz(dx, wheel_r, 0.0),
                    name: format!("wheel{i}"),
                    color: WHEEL_COLOR,
                });
            }
            parts.push(ActorPart {
                mesh: Mesh::from(Cuboid::new(l * 0.8, 0.06, 0.06)),
                offset: Transform::from_xyz(0.0, h * 0.42, 0.0),
                name: "frame".into(),
                color,
            });
            parts.push(ActorPart {
                mesh: Mesh::from(Cuboid::new(
                    (w * 0.36).max(0.16),
                    (w * 0.36).max(0.16),
                    (w * 0.36).max(0.16),
                )),
                offset: Transform::from_xyz(-l * 0.05, h * 0.72, 0.0),
                name: "rider".into(),
                color,
            });
        }
        "truck" | "bus" => {
            parts.push(ActorPart {
                mesh: Mesh::from(Cuboid::new(l, h * 0.85, w)),
                offset: Transform::from_xyz(0.0, h * 0.55, 0.0),
                name: "body".into(),
                color,
            });
            add_wheels(&mut parts, l, w, h);
        }
        // car + motorcycle-ish defaults
        _ => {
            parts.push(ActorPart {
                mesh: Mesh::from(Cuboid::new(l, h * 0.52, w)),
                offset: Transform::from_xyz(0.0, h * 0.36, 0.0),
                name: "body".into(),
                color,
            });
            parts.push(ActorPart {
                mesh: Mesh::from(Cuboid::new(l * 0.48, h * 0.40, w * 0.86)),
                offset: Transform::from_xyz(-l * 0.06, h * 0.78, 0.0),
                name: "cabin".into(),
                color,
            });
            add_wheels(&mut parts, l, w, h);
        }
    }

    // Namespaced part names keep the legend unambiguous.
    for p in &mut parts {
        p.name = format!("{}:{}", actor.id, p.name);
    }
    parts
}

fn add_wheels(parts: &mut Vec<ActorPart>, l: f32, w: f32, h: f32) {
    let r = (h * 0.17).clamp(0.15, 0.55);
    for (i, (dx, dz)) in [
        (l * 0.31, w * 0.5),
        (l * 0.31, -w * 0.5),
        (-l * 0.31, w * 0.5),
        (-l * 0.31, -w * 0.5),
    ]
    .into_iter()
    .enumerate()
    {
        parts.push(ActorPart {
            mesh: rotated_cyl(r, 0.22),
            offset: Transform::from_xyz(dx, r, dz),
            name: format!("wheel{i}"),
            color: WHEEL_COLOR,
        });
    }
}

/// Cylinder along the X axis (wheel orientation).
fn rotated_cyl(r: f32, width: f32) -> Mesh {
    let mut mesh = Mesh::from(Cylinder {
        radius: r,
        half_height: width / 2.0,
    });
    mesh.rotate_by(bevy::math::Quat::from_rotation_z(std::f32::consts::FRAC_PI_2));
    mesh
}
