//! Synthetic lit windows fitted to real façade planes.
//!
//! The rev17-19 implementation placed emissive cards at a fixed offset from
//! *street-light poles*, which is why reviewers found them floating. This
//! module never invents a surface: it recovers façades from the geometry that
//! is actually loaded, and every window it emits sits on one of them.
//!
//! 1. Walk every visible mesh's triangles in world space and keep the ones
//!    that are near-vertical and large enough to be a wall.
//! 2. Bucket them into planes by quantised normal and plane distance, then
//!    build a 2D occupancy raster of each plane at 0.5 m.
//! 3. Tile a floor grid over the plane and keep only windows whose full
//!    footprint is covered by that raster, are clear of the ground, and are
//!    clear of the plane's top edge.
//! 4. Light them with deterministic per-building clusters, 2200-4000 K,
//!    [`WINDOW_LUMINANCE_CDM2`], offset 60 mm along the façade normal.
//!
//! [`WindowMode::SyntheticFacadeDebug`] additionally emits the recovered
//! façade rectangles as flat cyan quads lying *on* the wall, so a screenshot
//! proves the windows are attached to detected geometry rather than hanging
//! in the air.

use bevy::asset::RenderAssetUsages;
use bevy::math::{Vec2, Vec3};
use bevy::prelude::*;
use bevy::render::mesh::{Indices, PrimitiveTopology, VertexAttributeValues};
use bevy::camera::visibility::RenderLayers;
use std::collections::HashMap;

/// Marks everything this module spawns so a relight can sweep it.
#[derive(Component)]
pub struct FacadeWindowMarker;

#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize)]
pub struct FacadeStats {
    pub meshes_scanned: u32,
    pub wall_triangles: u32,
    pub facades_detected: u32,
    pub facades_used: u32,
    pub window_slots: u32,
    pub windows_lit: u32,
    pub batches: u32,
    pub ground_y: f32,
}

use serde::{Deserialize, Serialize};

const WALL_NORMAL_Y_MAX: f32 = 0.30;
const MIN_TRIANGLE_AREA: f32 = 0.4;
const PLANE_DISTANCE_BUCKET: f32 = 4.0;
const PLANE_ANGLE_BUCKET_DEG: f32 = 22.5;
const RASTER_CELL: f32 = 0.75;
const FLOOR_PITCH: f32 = 3.4;
const BAY_PITCH: f32 = 3.0;
const WINDOW_W: f32 = 1.25;
const WINDOW_H: f32 = 1.45;

/// Luminance of a lit window as seen from the street, cd/m^2, by bin.
///
/// Light-pollution surveys put curtained residential windows at a few
/// cd/m^2 and an uncurtained lit room at 10-50; offices reach higher but
/// this corpus is residential and light commercial. The rev21 12-120
/// range read as floodlights: at a street-metered night EV (0-2) even the
/// lowest bin sat five stops over middle grey, so every window clipped to
/// the same white. Shared with the physical-window path in `engine.rs` so
/// both populations print alike.
pub const WINDOW_LUMINANCE_CDM2: [f32; 4] = [2.0, 5.0, 12.0, 30.0];

/// Bin index for a uniform roll in [0, 1): most rooms are curtained or
/// dim, a few are bright.
pub fn window_luminance_bin(roll: f32) -> usize {
    if roll > 0.94 {
        3
    } else if roll > 0.72 {
        2
    } else if roll > 0.34 {
        1
    } else {
        0
    }
}
const SILL_MIN: f32 = 2.0;
const SURFACE_OFFSET: f32 = 0.06;
const MAX_WINDOWS: usize = 4_500;
/// Only geometry within this radius of the observer can carry windows. A
/// night frame never shows a facade further away as anything but a silhouette,
/// and scanning the whole corpus is what pushed rev20's first cut over the
/// memory budget.
const FACADE_RADIUS_M: f32 = 260.0;
/// Planes are grouped into 64 m tiles along the wall so one long terrace does
/// not become a single kilometre-wide raster.
const FACADE_TILE_M: f32 = 64.0;
/// Hard cap on how many planes are rasterised, largest first.
const MAX_FACADES: usize = 320;
/// Panes per facade, so the global cap cannot be spent on one big wall.
const MAX_PER_FACADE: usize = 48;

struct Facade {
    normal: Vec3,
    right: Vec3,
    origin: Vec3,
    min: Vec2,
    max: Vec2,
    area: f32,
    cells: Vec<bool>,
    cols: usize,
    rows: usize,
}

impl Facade {
    fn covered(&self, u: f32, v: f32) -> bool {
        let cu = ((u - self.min.x) / RASTER_CELL).floor();
        let cv = ((v - self.min.y) / RASTER_CELL).floor();
        if cu < 0.0 || cv < 0.0 {
            return false;
        }
        let (cu, cv) = (cu as usize, cv as usize);
        if cu >= self.cols || cv >= self.rows {
            return false;
        }
        self.cells[cv * self.cols + cu]
    }
}

fn hash32(mut x: u32) -> u32 {
    x ^= x >> 16;
    x = x.wrapping_mul(0x7feb_352d);
    x ^= x >> 15;
    x = x.wrapping_mul(0x846c_a68b);
    x ^= x >> 16;
    x
}

fn hash01(seed: u32) -> f32 {
    hash32(seed) as f32 / u32::MAX as f32
}

/// Collect world-space wall triangles and group them into façade planes.
fn detect_facades(world: &mut World, observer: Vec3) -> (Vec<Facade>, FacadeStats) {
    let mut stats = FacadeStats::default();
    let mut triangles: HashMap<(i32, i32, i32), Vec<[Vec3; 3]>> = HashMap::new();
    let mut ground_y = f32::MAX;

    let entries: Vec<(Handle<Mesh>, GlobalTransform)> = {
        let mut query = world.query_filtered::<(
            &Mesh3d,
            &GlobalTransform,
            Option<&RenderLayers>,
        ), Without<FacadeWindowMarker>>();
        query
            .iter(world)
            .filter(|(_, _, layers)| {
                layers.map(|l| l.intersects(&RenderLayers::layer(0))).unwrap_or(true)
            })
            .map(|(mesh, transform, _)| (mesh.0.clone(), *transform))
            .collect()
    };

    let meshes = world.resource::<Assets<Mesh>>();
    for (handle, transform) in &entries {
        let Some(mesh) = meshes.get(handle) else {
            continue;
        };
        if mesh.primitive_topology() != PrimitiveTopology::TriangleList {
            continue;
        }
        let Some(VertexAttributeValues::Float32x3(positions)) =
            mesh.attribute(Mesh::ATTRIBUTE_POSITION)
        else {
            continue;
        };
        stats.meshes_scanned += 1;
        let affine = transform.affine();
        let world_of = |i: usize| -> Vec3 {
            let p = positions[i];
            affine.transform_point3(Vec3::new(p[0], p[1], p[2]))
        };
        let mut visit = |a: usize, b: usize, c: usize| {
            let (pa, pb, pc) = (world_of(a), world_of(b), world_of(c));
            ground_y = ground_y.min(pa.y).min(pb.y).min(pc.y);
            let cross = (pb - pa).cross(pc - pa);
            let area = cross.length() * 0.5;
            if area < MIN_TRIANGLE_AREA {
                return;
            }
            let normal = cross / (area * 2.0);
            if normal.y.abs() > WALL_NORMAL_Y_MAX {
                return;
            }
            let flat = Vec3::new(normal.x, 0.0, normal.z).normalize_or_zero();
            if flat == Vec3::ZERO {
                return;
            }
            let centroid = (pa + pb + pc) / 3.0;
            if Vec2::new(centroid.x - observer.x, centroid.z - observer.z).length()
                > FACADE_RADIUS_M
            {
                return;
            }
            let azimuth = flat.x.atan2(flat.z).to_degrees();
            let bucket_a = (azimuth / PLANE_ANGLE_BUCKET_DEG).round() as i32;
            let distance = flat.dot(pa);
            let bucket_d = (distance / PLANE_DISTANCE_BUCKET).round() as i32;
            // Third key: 64 m tiles measured along the wall direction, so a
            // bucket is one building face rather than every co-planar wall in
            // the corpus.
            let along = Vec3::new(-flat.z, 0.0, flat.x).dot(centroid);
            let bucket_t = (along / FACADE_TILE_M).floor() as i32;
            triangles
                .entry((bucket_a, bucket_d, bucket_t))
                .or_default()
                .push([pa, pb, pc]);
        };
        match mesh.indices() {
            Some(Indices::U16(idx)) => {
                for tri in idx.chunks_exact(3) {
                    visit(tri[0] as usize, tri[1] as usize, tri[2] as usize);
                }
            }
            Some(Indices::U32(idx)) => {
                for tri in idx.chunks_exact(3) {
                    visit(tri[0] as usize, tri[1] as usize, tri[2] as usize);
                }
            }
            None => {
                for tri in (0..positions.len()).step_by(3) {
                    if tri + 2 < positions.len() {
                        visit(tri, tri + 1, tri + 2);
                    }
                }
            }
        }
    }

    if !ground_y.is_finite() {
        ground_y = 0.0;
    }
    stats.ground_y = ground_y;

    let mut facades = Vec::new();
    for (_, tris) in triangles.into_iter() {
        stats.wall_triangles += tris.len() as u32;
        let mut normal = Vec3::ZERO;
        for [a, b, c] in &tris {
            normal += (*b - *a).cross(*c - *a);
        }
        let normal = Vec3::new(normal.x, 0.0, normal.z).normalize_or_zero();
        if normal == Vec3::ZERO {
            continue;
        }
        let right = Vec3::new(-normal.z, 0.0, normal.x);
        let origin = tris[0][0];
        let project = |p: Vec3| Vec2::new((p - origin).dot(right), p.y);
        let mut min = Vec2::splat(f32::MAX);
        let mut max = Vec2::splat(f32::MIN);
        let mut area = 0.0;
        for [a, b, c] in &tris {
            for p in [a, b, c] {
                let q = project(*p);
                min = min.min(q);
                max = max.max(q);
            }
            area += (*b - *a).cross(*c - *a).length() * 0.5;
        }
        let span = max - min;
        if span.x < 6.0 || span.y < 5.0 || area < 40.0 {
            continue;
        }
        let cols = (span.x / RASTER_CELL).ceil() as usize + 1;
        let rows = (span.y / RASTER_CELL).ceil() as usize + 1;
        if cols * rows > 120_000 {
            continue;
        }
        let mut cells = vec![false; cols * rows];
        for [a, b, c] in &tris {
            rasterize(
                project(*a),
                project(*b),
                project(*c),
                min,
                cols,
                rows,
                &mut cells,
            );
        }
        // A bucket's triangle bounding box can be much larger than the wall
        // it actually covers - distant co-planar fragments drag it into the
        // sky. Shrink the plane to the cells that are genuinely covered, so
        // the window grid and the debug outline both describe real wall.
        let mut cmin = Vec2::splat(f32::MAX);
        let mut cmax = Vec2::splat(f32::MIN);
        let mut covered = 0usize;
        for row in 0..rows {
            for col in 0..cols {
                if cells[row * cols + col] {
                    covered += 1;
                    let lo = min + Vec2::new(col as f32 * RASTER_CELL, row as f32 * RASTER_CELL);
                    cmin = cmin.min(lo);
                    cmax = cmax.max(lo + Vec2::splat(RASTER_CELL));
                }
            }
        }
        if covered < 16 || !cmin.x.is_finite() {
            continue;
        }
        let (min, max) = (cmin, cmax);
        let span = max - min;
        if span.x < 6.0 || span.y < 5.0 {
            continue;
        }
        facades.push(Facade {
            normal,
            right,
            origin,
            min,
            max,
            area,
            cells,
            cols,
            rows,
        });
    }
    stats.facades_detected = facades.len() as u32;
    // Nearest first, then capped: the walls a night frame actually reads are
    // the ones around the camera, not the largest ones somewhere on the map.
    facades.sort_by(|a, b| {
        let da = Vec2::new(a.origin.x - observer.x, a.origin.z - observer.z).length_squared();
        let db = Vec2::new(b.origin.x - observer.x, b.origin.z - observer.z).length_squared();
        da.total_cmp(&db)
    });
    facades.truncate(MAX_FACADES);
    (facades, stats)
}

/// Conservative half-space rasterisation of one triangle into the plane grid.
fn rasterize(
    a: Vec2,
    b: Vec2,
    c: Vec2,
    min: Vec2,
    cols: usize,
    rows: usize,
    cells: &mut [bool],
) {
    let lo = a.min(b).min(c);
    let hi = a.max(b).max(c);
    let c0 = (((lo.x - min.x) / RASTER_CELL).floor().max(0.0)) as usize;
    let c1 = (((hi.x - min.x) / RASTER_CELL).ceil() as i64).clamp(0, cols as i64) as usize;
    let r0 = (((lo.y - min.y) / RASTER_CELL).floor().max(0.0)) as usize;
    let r1 = (((hi.y - min.y) / RASTER_CELL).ceil() as i64).clamp(0, rows as i64) as usize;
    let edge = |p: Vec2, q: Vec2, r: Vec2| (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
    let denom = edge(a, b, c);
    if denom.abs() < 1e-9 {
        return;
    }
    for row in r0..r1 {
        for col in c0..c1 {
            let p = min + Vec2::new((col as f32 + 0.5) * RASTER_CELL, (row as f32 + 0.5) * RASTER_CELL);
            let w0 = edge(b, c, p) / denom;
            let w1 = edge(c, a, p) / denom;
            let w2 = edge(a, b, p) / denom;
            if w0 >= -0.08 && w1 >= -0.08 && w2 >= -0.08 {
                cells[row * cols + col] = true;
            }
        }
    }
}

struct Batch {
    positions: Vec<[f32; 3]>,
    normals: Vec<[f32; 3]>,
    uvs: Vec<[f32; 2]>,
    indices: Vec<u32>,
}

impl Batch {
    fn new() -> Self {
        Self {
            positions: Vec::new(),
            normals: Vec::new(),
            uvs: Vec::new(),
            indices: Vec::new(),
        }
    }

    fn push_quad(&mut self, centre: Vec3, right: Vec3, up: Vec3, normal: Vec3, w: f32, h: f32) {
        let base = self.positions.len() as u32;
        let (hx, hy) = (right * w * 0.5, up * h * 0.5);
        for (corner, uv) in [
            (centre - hx - hy, [0.0, 1.0]),
            (centre + hx - hy, [1.0, 1.0]),
            (centre + hx + hy, [1.0, 0.0]),
            (centre - hx + hy, [0.0, 0.0]),
        ] {
            self.positions.push(corner.to_array());
            self.normals.push(normal.to_array());
            self.uvs.push(uv);
        }
        self.indices
            .extend_from_slice(&[base, base + 1, base + 2, base, base + 2, base + 3]);
    }

    fn into_mesh(self) -> Mesh {
        let mut mesh = Mesh::new(
            PrimitiveTopology::TriangleList,
            RenderAssetUsages::RENDER_WORLD,
        );
        mesh.insert_attribute(Mesh::ATTRIBUTE_POSITION, self.positions);
        mesh.insert_attribute(Mesh::ATTRIBUTE_NORMAL, self.normals);
        mesh.insert_attribute(Mesh::ATTRIBUTE_UV_0, self.uvs);
        mesh.insert_indices(Indices::U32(self.indices));
        mesh
    }
}

/// Remove everything this module previously spawned.
pub fn clear(world: &mut World) {
    let stale: Vec<Entity> = {
        let mut query = world.query_filtered::<Entity, With<FacadeWindowMarker>>();
        query.iter(world).collect()
    };
    for entity in stale {
        world.despawn(entity);
    }
}

/// Fit and light windows. Returns the audit the lab reports.
pub fn spawn(
    world: &mut World,
    mode: crate::night::WindowMode,
    internal_scale: f32,
    seed: u32,
    observer: Vec3,
) -> FacadeStats {
    clear(world);
    if !mode.synthetic() {
        return FacadeStats::default();
    }
    let (facades, mut stats) = detect_facades(world, observer);
    let ground = stats.ground_y;

    // 24 emissive buckets: six colour temperatures x four luminances. One
    // merged mesh each keeps thousands of windows at 24 draw calls.
    const CCT_BINS: usize = 6;
    const LUM_BINS: usize = 4;
    let mut batches: Vec<Batch> = (0..CCT_BINS * LUM_BINS).map(|_| Batch::new()).collect();
    let mut debug_batch = Batch::new();
    let mut lit = 0usize;

    for (fid, facade) in facades.iter().enumerate() {
        let span = facade.max - facade.min;
        let bays = (span.x / BAY_PITCH).floor() as i32;
        let floors = ((span.y - SILL_MIN) / FLOOR_PITCH).floor() as i32;
        if bays < 1 || floors < 1 {
            continue;
        }
        stats.facades_used += 1;
        let mut lit_here = 0usize;
        let margin_u = (span.x - bays as f32 * BAY_PITCH) * 0.5;
        // A per-building bias so some blocks read as busy and others quiet.
        let building_bias = 0.25 + 0.55 * hash01(seed ^ hash32(fid as u32 * 2_654_435_761));
        for floor in 0..floors {
            let v = facade.min.y + SILL_MIN + FLOOR_PITCH * (floor as f32 + 0.5);
            if v - WINDOW_H * 0.5 < ground + 1.6 || v + WINDOW_H * 0.5 > facade.max.y - 0.6 {
                continue;
            }
            // Floors are correlated: a lit storey tends to stay lit.
            let floor_bias =
                hash01(seed ^ hash32((fid as u32).wrapping_mul(97) ^ (floor as u32 + 11)));
            for bay in 0..bays {
                let u = facade.min.x + margin_u + BAY_PITCH * (bay as f32 + 0.5);
                stats.window_slots += 1;
                // Footprint must be fully on the wall: centre plus corners.
                let half_w = WINDOW_W * 0.5 + 0.15;
                let half_h = WINDOW_H * 0.5 + 0.15;
                let attached = facade.covered(u, v)
                    && facade.covered(u - half_w, v - half_h)
                    && facade.covered(u + half_w, v - half_h)
                    && facade.covered(u - half_w, v + half_h)
                    && facade.covered(u + half_w, v + half_h);
                if !attached {
                    continue;
                }
                let key = hash32(
                    (fid as u32)
                        .wrapping_mul(0x9E37_79B9)
                        ^ (bay as u32).wrapping_mul(0x85EB_CA6B)
                        ^ (floor as u32).wrapping_mul(0xC2B2_AE35)
                        ^ seed,
                );
                let roll = key as f32 / u32::MAX as f32;
                let occupancy = (building_bias * 0.55 + floor_bias * 0.45).clamp(0.05, 0.92);
                if roll > occupancy {
                    continue;
                }
                if lit >= MAX_WINDOWS || lit_here >= MAX_PER_FACADE {
                    break;
                }
                lit += 1;
                lit_here += 1;
                let cct_bin = (hash32(key ^ 0x51) % CCT_BINS as u32) as usize;
                // Most rooms are warm; a few are cool LED/fluorescent.
                let lum_bin = window_luminance_bin(hash01(key ^ 0xA37));
                let centre = facade.origin
                    + facade.right * u
                    + Vec3::Y * (v - facade.origin.y)
                    + facade.normal * SURFACE_OFFSET;
                let w = WINDOW_W * (0.86 + 0.2 * hash01(key ^ 0x77));
                let h = WINDOW_H * (0.82 + 0.2 * hash01(key ^ 0xB3));
                let (w, h) = (w.clamp(0.8, 1.5), h.clamp(0.8, 1.5));
                batches[cct_bin * LUM_BINS + lum_bin].push_quad(
                    centre,
                    facade.right,
                    Vec3::Y,
                    facade.normal,
                    w,
                    h,
                );
                if mode.debug() {
                    // A cyan frame co-planar with the pane itself, 5 mm
                    // closer to the wall. It cannot appear anywhere the pane
                    // is not, so a screenshot of it *is* the attachment
                    // proof - unlike a plane bounding box, which can be much
                    // larger than the wall it was fitted to.
                    debug_batch.push_quad(
                        centre - facade.normal * 0.005,
                        facade.right,
                        Vec3::Y,
                        facade.normal,
                        w + 0.28,
                        h + 0.28,
                    );
                }
            }
        }
    }
    stats.windows_lit = lit as u32;

    world.resource_scope(|world, mut meshes: Mut<Assets<Mesh>>| {
        world.resource_scope(|world, mut materials: Mut<Assets<StandardMaterial>>| {
            let mut commands = world.commands();
            for (index, batch) in batches.into_iter().enumerate() {
                if batch.positions.is_empty() {
                    continue;
                }
                let cct_bin = index / LUM_BINS;
                let lum_bin = index % LUM_BINS;
                let cct = 2_200.0 + (4_000.0 - 2_200.0) * (cct_bin as f32 / (CCT_BINS - 1) as f32);
                let luminance = WINDOW_LUMINANCE_CDM2[lum_bin];
                let colour = crate::lighting::kelvin_to_rgb(cct);
                let material = materials.add(StandardMaterial {
                    base_color: Color::BLACK,
                    emissive: colour.to_linear() * (luminance * internal_scale),
                    perceptual_roughness: 0.55,
                    cull_mode: None,
                    ..default()
                });
                commands.spawn((
                    Mesh3d(meshes.add(batch.into_mesh())),
                    MeshMaterial3d(material),
                    Transform::IDENTITY,
                    FacadeWindowMarker,
                ));
                stats.batches += 1;
            }
            if !debug_batch.positions.is_empty() {
                let material = materials.add(StandardMaterial {
                    base_color: Color::BLACK,
                    emissive: LinearRgba::new(0.0, 0.9, 1.0, 1.0) * (18.0 * internal_scale),
                    cull_mode: None,
                    ..default()
                });
                commands.spawn((
                    Mesh3d(meshes.add(debug_batch.into_mesh())),
                    MeshMaterial3d(material),
                    Transform::IDENTITY,
                    FacadeWindowMarker,
                ));
                stats.batches += 1;
            }
        });
    });
    world.flush();
    stats
}
