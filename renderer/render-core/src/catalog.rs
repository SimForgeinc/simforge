//! Procedural actor geometry bound to prop-catalog entries.
//!
//! The prop-catalog builds three.js meshes in code (packages/prop-catalog);
//! render-core mirrors the same minimum visual grammar procedurally:
//! body/cabin/wheels for vehicles, capsule+head for pedestrians. This is the
//! fallback path for catalog ids without a vehicles-carla GLB (see
//! `vehicle_model.rs`). Actor local frame: length along +X so a
//! yaw-about-+Y rotation by `headingRad` aligns +X with the scene-frame
//! travel direction `(cos h, 0, -sin h)`.

use bevy::math::primitives::{Capsule3d, Cuboid, Cylinder};
use bevy::prelude::{Color, Mesh, Transform};

use crate::scene_state::{ActorDesc, Dims};

/// What a part is, for animation hooks and tinting.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum ActorPartKind {
    /// Receives the authored body tint.
    Body,
    /// Spins about its local Z (axle) axis when the actor moves.
    Wheel { radius: f32 },
    Other,
}

pub struct ActorPart {
    pub mesh: Mesh,
    /// Offset of the part relative to the actor root (ground-centre origin).
    pub offset: Transform,
    /// Stable part name feeding the instance-ID legend.
    pub name: String,
    /// Base colour (sRGB).
    pub color: Color,
    pub kind: ActorPartKind,
}

/// Parse an authored `#rrggbb` hex color.
pub fn parse_hex_color(hex: &str) -> Option<Color> {
    let hex = hex.trim_start_matches('#');
    if hex.len() != 6 {
        return None;
    }
    let v = u32::from_str_radix(hex, 16).ok()?;
    Some(Color::srgb_u8((v >> 16) as u8, (v >> 8) as u8, v as u8))
}

/// The body colour an actor renders with: authored `color` when present,
/// else the deterministic catalog-id palette.
pub fn actor_body_color(actor: &ActorDesc) -> Color {
    actor
        .color
        .as_deref()
        .and_then(parse_hex_color)
        .unwrap_or_else(|| vehicle_color(&actor.catalog_id))
}

/// Effective dims for an actor: authored, else per-class defaults.
pub fn actor_dims(actor: &ActorDesc) -> Dims {
    actor.dims.unwrap_or(match actor.actor_class.as_str() {
        "pedestrian" => Dims { l: 0.6, w: 0.6, h: 1.75 },
        "bicycle" => Dims { l: 1.7, w: 0.5, h: 1.7 },
        _ => Dims { l: 4.7, w: 1.82, h: 1.45 },
    })
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

pub const WHEEL_COLOR: Color = Color::srgb(0.08, 0.08, 0.09);

/// Build the part list for one actor description (the primitive fallback
/// used when the catalog id has no vehicles-carla GLB).
pub fn actor_parts(actor: &ActorDesc) -> Vec<ActorPart> {
    let dims = actor_dims(actor);
    let (l, w, h) = (dims.l as f32, dims.w as f32, dims.h as f32);
    let color = actor_body_color(actor);
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
                kind: ActorPartKind::Body,
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
                kind: ActorPartKind::Other,
            });
        }
        "bicycle" => {
            let wheel_r = h * 0.16;
            for (i, dx) in [l * 0.32, -l * 0.32].into_iter().enumerate() {
                parts.push(ActorPart {
                    mesh: axle_cyl(wheel_r, 0.04),
                    offset: Transform::from_xyz(dx, wheel_r, 0.0),
                    name: format!("wheel{i}"),
                    color: WHEEL_COLOR,
                    kind: ActorPartKind::Wheel { radius: wheel_r },
                });
            }
            parts.push(ActorPart {
                mesh: Mesh::from(Cuboid::new(l * 0.8, 0.06, 0.06)),
                offset: Transform::from_xyz(0.0, h * 0.42, 0.0),
                name: "frame".into(),
                color,
                kind: ActorPartKind::Body,
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
                kind: ActorPartKind::Other,
            });
        }
        "truck" | "bus" => {
            parts.push(ActorPart {
                mesh: Mesh::from(Cuboid::new(l, h * 0.85, w)),
                offset: Transform::from_xyz(0.0, h * 0.55, 0.0),
                name: "body".into(),
                color,
                kind: ActorPartKind::Body,
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
                kind: ActorPartKind::Body,
            });
            parts.push(ActorPart {
                mesh: Mesh::from(Cuboid::new(l * 0.48, h * 0.40, w * 0.86)),
                offset: Transform::from_xyz(-l * 0.06, h * 0.78, 0.0),
                name: "cabin".into(),
                color,
                kind: ActorPartKind::Body,
            });
            add_wheels(&mut parts, l, w, h);
        }
    }

    // Names stay bare; consumers namespace them per actor when building
    // legends (parts are shared prototypes across same-shape actors).
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
            mesh: axle_cyl(r, 0.22),
            offset: Transform::from_xyz(dx, r, dz),
            name: format!("wheel{i}"),
            color: WHEEL_COLOR,
            kind: ActorPartKind::Wheel { radius: r },
        });
    }
}

/// Cylinder whose axis is local Z — the axle axis for wheels of a +X-forward
/// body (matches the vehicles-carla wheel convention: spin = rotation about
/// local Z).
fn axle_cyl(r: f32, width: f32) -> Mesh {
    let mut mesh = Mesh::from(Cylinder {
        radius: r,
        half_height: width / 2.0,
    });
    mesh.rotate_by(bevy::math::Quat::from_rotation_x(std::f32::consts::FRAC_PI_2));
    mesh
}
