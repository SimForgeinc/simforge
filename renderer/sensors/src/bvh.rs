//! Deterministic CPU raycast scene: triangle soup + flat median-split BVH.
//!
//! Used by the lidar and radar models. Determinism notes:
//! - triangles are sorted by centroid lexicographic order before building, so
//!   identical input geometry yields an identical tree and identical hits;
//! - the BVH build uses `select_nth_unstable_by_key` on f32 bit patterns;
//! - ray-triangle intersection is Möller–Trumbore with a fixed epsilon.

use bevy::math::Vec3;

/// A world-space triangle with its owning instance id.
#[derive(Debug, Clone, Copy)]
pub struct Tri {
    pub a: Vec3,
    pub b: Vec3,
    pub c: Vec3,
    /// Instance id from the capture legend.
    pub instance_id: u32,
}

impl Tri {
    pub fn centroid(&self) -> Vec3 {
        (self.a + self.b + self.c) * (1.0 / 3.0)
    }
}

#[derive(Debug, Clone, Copy)]
struct Node {
    min: Vec3,
    max: Vec3,
    /// Leaf: first triangle index. Interior: left child node index.
    left_first: u32,
    /// Leaf: triangle count. Interior: 0.
    count: u32,
    /// Interior: right child node index.
    right: u32,
}

#[derive(Debug, Clone, Default)]
pub struct RaycastScene {
    tris: Vec<Tri>,
    nodes: Vec<Node>,
}

const EPS: f32 = 1e-9;

#[derive(Debug, Clone, Copy)]
pub struct Hit {
    pub distance: f32,
    pub point: Vec3,
    pub instance_id: u32,
    pub normal: Vec3,
}

/// Raycast surface accepted by deterministic sensor models. A persistent
/// service can compose a cached static BVH with a per-tick actor BVH.
pub trait Raycast {
    fn cast(&self, origin: Vec3, dir: Vec3, t_max: f32) -> Option<Hit>;
}

impl RaycastScene {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn push_tri(&mut self, tri: Tri) {
        self.tris.push(tri);
    }

    pub fn tri_count(&self) -> usize {
        self.tris.len()
    }

    /// Build the BVH. Call once after all triangles are pushed.
    pub fn build(&mut self) {
        let n = self.tris.len();
        if n == 0 {
            return;
        }
        // Deterministic global triangle order: sort by centroid lexicographic.
        self.tris.sort_by(|a, b| {
            let ca = a.centroid();
            let cb = b.centroid();
            ca.x.partial_cmp(&cb.x)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then(ca.y.partial_cmp(&cb.y).unwrap_or(std::cmp::Ordering::Equal))
                .then(ca.z.partial_cmp(&cb.z).unwrap_or(std::cmp::Ordering::Equal))
        });
        self.nodes.clear();
        self.nodes.reserve(2 * n);
        self.subdivide(0, n as u32);
    }

    fn tri_bounds(tris: &[Tri]) -> (Vec3, Vec3) {
        let mut min = Vec3::splat(f32::MAX);
        let mut max = Vec3::splat(f32::MIN);
        for t in tris {
            for p in [t.a, t.b, t.c] {
                min = min.min(p);
                max = max.max(p);
            }
        }
        (min, max)
    }

    fn subdivide(&mut self, first: u32, count: u32) -> u32 {
        let node_index = self.nodes.len() as u32;
        let (bmin, bmax) = Self::tri_bounds(&self.tris[first as usize..(first + count) as usize]);
        if count <= 4 {
            self.nodes.push(Node { min: bmin, max: bmax, left_first: first, count, right: 0 });
            return node_index;
        }
        // Median split on the widest axis of the bounds.
        let ext = bmax - bmin;
        let axis = if ext.x >= ext.y && ext.x >= ext.z {
            0
        } else if ext.y >= ext.z {
            1
        } else {
            2
        };
        let mid = first + count / 2;
        self.tris[first as usize..(first + count) as usize].select_nth_unstable_by_key(
            (mid - first) as usize,
            |t| {
                let c = t.centroid();
                match axis {
                    0 => c.x.to_bits(),
                    1 => c.y.to_bits(),
                    _ => c.z.to_bits(),
                }
            },
        );
        // Reserve this interior's slot so indices stay stable across recursion,
        // then fill in child links once both children exist.
        self.nodes.push(Node { min: bmin, max: bmax, left_first: 0, count: 0, right: 0 });
        let left = self.subdivide(first, mid - first);
        let right = self.subdivide(mid, first + count - mid);
        self.nodes[node_index as usize].left_first = left;
        self.nodes[node_index as usize].right = right;
        node_index
    }

    /// Nearest hit within `t_max` along `dir` (need not be normalized; the
    /// returned distance is in units of |dir|).
    pub fn cast(&self, origin: Vec3, dir: Vec3, t_max: f32) -> Option<Hit> {
        if self.nodes.is_empty() {
            return None;
        }
        let inv_dir = dir.recip();
        let mut best: Option<Hit> = None;
        let mut best_t = t_max;
        let mut stack = [0u32; 128];
        let mut sp = 0usize;
        stack[sp] = 0;
        sp += 1;
        while sp > 0 {
            sp -= 1;
            let node = &self.nodes[stack[sp] as usize];
            if !ray_aabb(origin, inv_dir, best_t, node.min, node.max) {
                continue;
            }
            if node.count > 0 {
                for ti in node.left_first..node.left_first + node.count {
                    if let Some(hit) = ray_tri(origin, dir, &self.tris[ti as usize]) {
                        if hit.distance < best_t {
                            best_t = hit.distance;
                            best = Some(hit);
                        }
                    }
                }
            } else {
                stack[sp] = node.right;
                sp += 1;
                stack[sp] = node.left_first;
                sp += 1;
            }
        }
        best
    }
}

impl Raycast for RaycastScene {
    fn cast(&self, origin: Vec3, dir: Vec3, t_max: f32) -> Option<Hit> {
        RaycastScene::cast(self, origin, dir, t_max)
    }
}

fn ray_aabb(origin: Vec3, inv_dir: Vec3, t_max: f32, min: Vec3, max: Vec3) -> bool {
    let mut tmin = f32::NEG_INFINITY;
    let mut tmax = f32::INFINITY;
    for k in 0..3 {
        let o = origin[k];
        let d = inv_dir[k];
        let lo = min[k];
        let hi = max[k];
        if d.abs() < EPS {
            if o < lo || o > hi {
                return false;
            }
        } else {
            let mut t0 = (lo - o) * d;
            let mut t1 = (hi - o) * d;
            if t0 > t1 {
                std::mem::swap(&mut t0, &mut t1);
            }
            tmin = tmin.max(t0);
            tmax = tmax.min(t1);
            if tmin > tmax {
                return false;
            }
        }
    }
    tmax >= 0.0 && tmin <= t_max
}

/// Möller–Trumbore. Distance is along the unnormalized `dir`.
fn ray_tri(origin: Vec3, dir: Vec3, tri: &Tri) -> Option<Hit> {
    let e1 = tri.b - tri.a;
    let e2 = tri.c - tri.a;
    let pvec = dir.cross(e2);
    let det = e1.dot(pvec);
    if det.abs() < EPS {
        return None;
    }
    let inv_det = 1.0 / det;
    let tvec = origin - tri.a;
    let u = tvec.dot(pvec) * inv_det;
    if !(0.0..=1.0).contains(&u) {
        return None;
    }
    let qvec = tvec.cross(e1);
    let v = dir.dot(qvec) * inv_det;
    if v < 0.0 || u + v > 1.0 {
        return None;
    }
    let t = e2.dot(qvec) * inv_det;
    if t <= EPS {
        return None;
    }
    let normal = e1.cross(e2).normalize();
    Some(Hit {
        distance: t,
        point: origin + dir * t,
        instance_id: tri.instance_id,
        normal,
    })
}
