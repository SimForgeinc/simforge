//! GLB -> GPU model: buffers, materials, draw list, node hierarchy, animations.

use glam::{Mat4, Quat, Vec3};
use std::collections::HashMap;
use wgpu::util::DeviceExt;

use crate::gltf_min as gm;
use crate::texture;

pub const DRAW_STRIDE: u64 = 256;

#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
pub struct DrawU {
    pub model: [f32; 16],
    pub id_flags: [u32; 4],
}

#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
pub struct MatU {
    pub base_color: [f32; 4],
    pub mrna: [f32; 4],
    pub flags: [u32; 4],
}

pub struct DrawItem {
    pub pos: wgpu::Buffer,
    pub nrm: wgpu::Buffer,
    pub tan: wgpu::Buffer,
    pub uv: wgpu::Buffer,
    pub idx: wgpu::Buffer,
    pub index_count: u32,
    pub index_format: wgpu::IndexFormat,
    pub material: usize,
    pub node: usize,
    pub blend: bool,
    pub uniform_offset: u32,
    pub id: u32,
    pub has_tangent: bool,
}

pub struct MaterialGpu {
    pub bind_group: wgpu::BindGroup,
}

#[derive(Clone, Copy, PartialEq)]
pub enum AnimPath {
    Translation,
    Rotation,
    Scale,
}

pub struct Channel {
    pub node: usize,
    pub path: AnimPath,
    pub times: Vec<f32>,
    pub values: Vec<f32>,
}

pub struct NodeRT {
    pub parent: Option<usize>,
    pub t: Vec3,
    pub r: Quat,
    pub s: Vec3,
    pub matrix: Option<Mat4>,
}

pub struct Model {
    pub draws: Vec<DrawItem>,
    pub draw_buf: wgpu::Buffer,
    pub draw_bind_group: wgpu::BindGroup,
    #[allow(dead_code)]
    pub materials: Vec<MaterialGpu>,
    pub nodes: Vec<NodeRT>,
    pub roots: Vec<usize>,
    pub channels: Vec<Channel>,
    pub anim_duration: f32,
    pub root_transform: Mat4,
    pub bounds_min: Vec3,
    pub bounds_max: Vec3,
    pub tri_count: u64,
    pub geo_bytes: u64,
    pub tex_bytes: u64,
    pub tex_count: u32,
}

pub struct LoadCtx<'a> {
    pub device: &'a wgpu::Device,
    pub queue: &'a wgpu::Queue,
    pub material_layout: &'a wgpu::BindGroupLayout,
    pub draw_layout: &'a wgpu::BindGroupLayout,
    pub sampler: &'a wgpu::Sampler,
    pub dummy_white: &'a wgpu::TextureView,
    pub dummy_mr: &'a wgpu::TextureView,
    pub dummy_normal: &'a wgpu::TextureView,
}

fn node_world(nodes: &[NodeRT], idx: usize) -> Mat4 {
    let n = &nodes[idx];
    let local = n
        .matrix
        .unwrap_or_else(|| Mat4::from_scale_rotation_translation(n.s, n.r, n.t));
    match n.parent {
        Some(p) => node_world(nodes, p) * local,
        None => local,
    }
}

impl Model {
    pub fn load(
        ctx: &LoadCtx,
        glb: &[u8],
        root_transform: Mat4,
        first_id: u32,
    ) -> Result<Model, String> {
        let (g, bin) = gm::parse_glb(glb)?;

        // --- image color-space hints (PNG path only; KTX2 carries its own format)
        let mut srgb_hint: HashMap<usize, bool> = HashMap::new();
        let mut mark = |tex: &Option<gm::TexRef>, srgb: bool| {
            if let Some(t) = tex {
                if let Some(img) = g.textures.get(t.index).and_then(|t| t.image_index()) {
                    srgb_hint.entry(img).or_insert(srgb);
                }
            }
        };
        for m in &g.materials {
            mark(&m.pbr_metallic_roughness.base_color_texture, true);
            mark(&m.pbr_metallic_roughness.metallic_roughness_texture, false);
            mark(&m.normal_texture, false);
        }

        // --- upload images
        let mut tex_bytes = 0u64;
        let mut tex_count = 0u32;
        let mut image_views: Vec<Option<wgpu::TextureView>> = Vec::with_capacity(g.images.len());
        for (i, img) in g.images.iter().enumerate() {
            let Some(bv) = img.buffer_view else {
                image_views.push(None);
                continue;
            };
            let view = &g.buffer_views[bv];
            let bytes = &bin[view.byte_offset..view.byte_offset + view.byte_length];
            let up = match img.mime_type.as_deref() {
                Some("image/ktx2") => texture::upload_ktx2(ctx.device, ctx.queue, bytes),
                Some("image/png") | Some("image/jpeg") => texture::upload_image(
                    ctx.device,
                    ctx.queue,
                    bytes,
                    *srgb_hint.get(&i).unwrap_or(&true),
                ),
                other => Err(format!("image {i}: unsupported mime {other:?}")),
            };
            match up {
                Ok(u) => {
                    tex_bytes += u.gpu_bytes;
                    tex_count += 1;
                    image_views.push(Some(u.view));
                }
                Err(e) => {
                    web_sys::console::warn_1(&format!("image {i}: {e}").into());
                    image_views.push(None);
                }
            }
        }
        let tex_view = |r: &Option<gm::TexRef>| -> Option<&wgpu::TextureView> {
            r.as_ref()
                .and_then(|t| g.textures.get(t.index))
                .and_then(|t| t.image_index())
                .and_then(|i| image_views.get(i).and_then(|v| v.as_ref()))
        };

        // --- materials
        let mut materials = Vec::new();
        let mut mat_blend = Vec::new();
        let mut mat_infos: Vec<&gm::Material> = g.materials.iter().collect();
        let default_mat = gm::Material::default();
        if mat_infos.is_empty() {
            mat_infos.push(&default_mat);
        }
        for m in &mat_infos {
            let pbr = &m.pbr_metallic_roughness;
            let bc = tex_view(&pbr.base_color_texture);
            let mr = tex_view(&pbr.metallic_roughness_texture);
            let nm = tex_view(&m.normal_texture);
            let mask = m.alpha_mode.as_deref() == Some("MASK");
            let blend = m.alpha_mode.as_deref() == Some("BLEND");
            mat_blend.push(blend);
            let flags = (bc.is_some() as u32)
                | (mr.is_some() as u32) << 1
                | (nm.is_some() as u32) << 2
                | (mask as u32) << 3;
            let uni = MatU {
                base_color: pbr.base_color_factor.unwrap_or([1.0; 4]),
                mrna: [
                    pbr.metallic_factor.unwrap_or(1.0),
                    pbr.roughness_factor.unwrap_or(1.0),
                    m.normal_texture.as_ref().and_then(|t| t.scale).unwrap_or(1.0),
                    m.alpha_cutoff.unwrap_or(0.5),
                ],
                flags: [flags, 0, 0, 0],
            };
            let buf = ctx
                .device
                .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                    label: Some("material"),
                    contents: bytemuck::bytes_of(&uni),
                    usage: wgpu::BufferUsages::UNIFORM,
                });
            let bind_group = ctx.device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("material"),
                layout: ctx.material_layout,
                entries: &[
                    wgpu::BindGroupEntry {
                        binding: 0,
                        resource: buf.as_entire_binding(),
                    },
                    wgpu::BindGroupEntry {
                        binding: 1,
                        resource: wgpu::BindingResource::TextureView(bc.unwrap_or(ctx.dummy_white)),
                    },
                    wgpu::BindGroupEntry {
                        binding: 2,
                        resource: wgpu::BindingResource::TextureView(mr.unwrap_or(ctx.dummy_mr)),
                    },
                    wgpu::BindGroupEntry {
                        binding: 3,
                        resource: wgpu::BindingResource::TextureView(nm.unwrap_or(ctx.dummy_normal)),
                    },
                    wgpu::BindGroupEntry {
                        binding: 4,
                        resource: wgpu::BindingResource::Sampler(ctx.sampler),
                    },
                ],
            });
            materials.push(MaterialGpu { bind_group });
        }

        // --- node hierarchy
        let mut nodes: Vec<NodeRT> = g
            .nodes
            .iter()
            .map(|n| NodeRT {
                parent: None,
                t: Vec3::from(n.translation.unwrap_or([0.0; 3])),
                r: n
                    .rotation
                    .map(|r| Quat::from_xyzw(r[0], r[1], r[2], r[3]))
                    .unwrap_or(Quat::IDENTITY),
                s: Vec3::from(n.scale.unwrap_or([1.0; 3])),
                matrix: n.matrix.map(|m| Mat4::from_cols_array(&m)),
            })
            .collect();
        for (i, n) in g.nodes.iter().enumerate() {
            for &c in &n.children {
                nodes[c].parent = Some(i);
            }
        }
        let roots: Vec<usize> = g
            .scenes
            .get(g.scene.unwrap_or(0))
            .map(|s| s.nodes.clone())
            .unwrap_or_else(|| (0..nodes.len()).filter(|&i| nodes[i].parent.is_none()).collect());

        // --- draws
        let mut draws = Vec::new();
        let mut tri_count = 0u64;
        let mut geo_bytes = 0u64;
        let mut bounds_min = Vec3::splat(f32::INFINITY);
        let mut bounds_max = Vec3::splat(f32::NEG_INFINITY);
        let mut next_id = first_id;

        let mk_buf = |data: &[u8], usage: wgpu::BufferUsages| {
            ctx.device
                .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                    label: None,
                    contents: data,
                    usage,
                })
        };

        for (node_idx, n) in g.nodes.iter().enumerate() {
            let Some(mesh_idx) = n.mesh else { continue };
            let world = root_transform * node_world(&nodes, node_idx);
            for prim in &g.meshes[mesh_idx].primitives {
                if prim.mode != 4 {
                    continue;
                }
                let Some(&pos_acc) = prim.attributes.get("POSITION") else {
                    continue;
                };
                let count = g.accessors[pos_acc].count;
                let pos = gm::read_accessor(&g, &bin, pos_acc);
                let nrm = prim
                    .attributes
                    .get("NORMAL")
                    .map(|&a| gm::read_accessor(&g, &bin, a))
                    .unwrap_or_else(|| vec![0u8; count * 12]);
                let has_tangent = prim.attributes.contains_key("TANGENT");
                let tan = prim
                    .attributes
                    .get("TANGENT")
                    .map(|&a| gm::read_accessor(&g, &bin, a))
                    .unwrap_or_else(|| vec![0u8; count * 16]);
                let uv = prim
                    .attributes
                    .get("TEXCOORD_0")
                    .map(|&a| gm::read_accessor(&g, &bin, a))
                    .unwrap_or_else(|| vec![0u8; count * 8]);

                let (idx_bytes, index_count, index_format) = match prim.indices {
                    Some(ia) => {
                        let acc = &g.accessors[ia];
                        let mut data = gm::read_accessor(&g, &bin, ia);
                        let fmt = match acc.component_type {
                            5123 => wgpu::IndexFormat::Uint16,
                            5125 => wgpu::IndexFormat::Uint32,
                            5121 => {
                                // u8 indices -> widen to u16
                                data = data
                                    .iter()
                                    .flat_map(|&b| (b as u16).to_le_bytes())
                                    .collect();
                                wgpu::IndexFormat::Uint16
                            }
                            other => return Err(format!("index component {other}")),
                        };
                        (data, acc.count as u32, fmt)
                    }
                    None => {
                        let data: Vec<u8> = (0..count as u32)
                            .flat_map(|i| i.to_le_bytes())
                            .collect();
                        (data, count as u32, wgpu::IndexFormat::Uint32)
                    }
                };
                // u16 index buffers must be 4-byte aligned in size
                let mut idx_bytes = idx_bytes;
                if idx_bytes.len() % 4 != 0 {
                    idx_bytes.extend_from_slice(&[0, 0]);
                }

                // bounds: accessor min/max if present, else scan positions
                let acc = &g.accessors[pos_acc];
                let (mn, mx) = match (&acc.min, &acc.max) {
                    (Some(mn), Some(mx)) if mn.len() == 3 => {
                        (Vec3::new(mn[0], mn[1], mn[2]), Vec3::new(mx[0], mx[1], mx[2]))
                    }
                    _ => {
                        let mut mn = Vec3::splat(f32::INFINITY);
                        let mut mx = Vec3::splat(f32::NEG_INFINITY);
                        for c in pos.chunks_exact(12) {
                            let p = Vec3::new(
                                f32::from_le_bytes(c[0..4].try_into().unwrap()),
                                f32::from_le_bytes(c[4..8].try_into().unwrap()),
                                f32::from_le_bytes(c[8..12].try_into().unwrap()),
                            );
                            mn = mn.min(p);
                            mx = mx.max(p);
                        }
                        (mn, mx)
                    }
                };
                for i in 0..8 {
                    let corner = Vec3::new(
                        if i & 1 == 0 { mn.x } else { mx.x },
                        if i & 2 == 0 { mn.y } else { mx.y },
                        if i & 4 == 0 { mn.z } else { mx.z },
                    );
                    let wc = world.transform_point3(corner);
                    bounds_min = bounds_min.min(wc);
                    bounds_max = bounds_max.max(wc);
                }

                geo_bytes +=
                    (pos.len() + nrm.len() + tan.len() + uv.len() + idx_bytes.len()) as u64;
                tri_count += index_count as u64 / 3;

                let material = prim.material.unwrap_or(0).min(materials.len() - 1);
                draws.push(DrawItem {
                    pos: mk_buf(&pos, wgpu::BufferUsages::VERTEX),
                    nrm: mk_buf(&nrm, wgpu::BufferUsages::VERTEX),
                    tan: mk_buf(&tan, wgpu::BufferUsages::VERTEX),
                    uv: mk_buf(&uv, wgpu::BufferUsages::VERTEX),
                    idx: mk_buf(&idx_bytes, wgpu::BufferUsages::INDEX),
                    index_count,
                    index_format,
                    material,
                    node: node_idx,
                    blend: mat_blend.get(material).copied().unwrap_or(false),
                    uniform_offset: 0,
                    id: next_id,
                    has_tangent,
                });
                next_id += 1;
            }
        }

        // --- per-draw uniform buffer (dynamic offsets)
        let draw_buf = ctx.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("draw-uniforms"),
            size: (draws.len().max(1) as u64) * DRAW_STRIDE,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        for (i, d) in draws.iter_mut().enumerate() {
            d.uniform_offset = (i as u64 * DRAW_STRIDE) as u32;
        }
        let draw_bind_group = ctx.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("draw"),
            layout: ctx.draw_layout,
            entries: &[wgpu::BindGroupEntry {
                binding: 0,
                resource: wgpu::BindingResource::Buffer(wgpu::BufferBinding {
                    buffer: &draw_buf,
                    offset: 0,
                    size: wgpu::BufferSize::new(std::mem::size_of::<DrawU>() as u64),
                }),
            }],
        });

        // --- animations (first animation only; LINEAR + STEP treated as LINEAR)
        let mut channels = Vec::new();
        let mut anim_duration = 0.0f32;
        if let Some(anim) = g.animations.first() {
            for ch in &anim.channels {
                let Some(node) = ch.target.node else { continue };
                let path = match ch.target.path.as_str() {
                    "translation" => AnimPath::Translation,
                    "rotation" => AnimPath::Rotation,
                    "scale" => AnimPath::Scale,
                    _ => continue,
                };
                let s = &anim.samplers[ch.sampler];
                let times = gm::read_accessor_f32(&g, &bin, s.input);
                let values = gm::read_accessor_f32(&g, &bin, s.output);
                if let Some(&last) = times.last() {
                    anim_duration = anim_duration.max(last);
                }
                channels.push(Channel {
                    node,
                    path,
                    times,
                    values,
                });
            }
        }

        let model = Model {
            draws,
            draw_buf,
            draw_bind_group,
            materials,
            nodes,
            roots,
            channels,
            anim_duration,
            root_transform,
            bounds_min,
            bounds_max,
            tri_count,
            geo_bytes,
            tex_bytes,
            tex_count,
        };
        model.write_draw_uniforms(ctx.queue);
        Ok(model)
    }

    /// Evaluate animation channels at time t (seconds), updating node TRS.
    pub fn animate(&mut self, t: f32) {
        if self.channels.is_empty() {
            return;
        }
        let t = if self.anim_duration > 0.0 {
            t % self.anim_duration
        } else {
            0.0
        };
        for ch in &self.channels {
            let times = &ch.times;
            let k = match times.iter().position(|&x| x > t) {
                Some(0) => 0,
                Some(i) => i - 1,
                None => times.len() - 1,
            };
            let k1 = (k + 1).min(times.len() - 1);
            let dt = (times[k1] - times[k]).max(1e-6);
            let f = ((t - times[k]) / dt).clamp(0.0, 1.0);
            let n = &mut self.nodes[ch.node];
            match ch.path {
                AnimPath::Translation | AnimPath::Scale => {
                    let a = Vec3::from_slice(&ch.values[k * 3..k * 3 + 3]);
                    let b = Vec3::from_slice(&ch.values[k1 * 3..k1 * 3 + 3]);
                    let v = a.lerp(b, f);
                    if ch.path == AnimPath::Translation {
                        n.t = v;
                    } else {
                        n.s = v;
                    }
                }
                AnimPath::Rotation => {
                    let a = Quat::from_slice(&ch.values[k * 4..k * 4 + 4]);
                    let b = Quat::from_slice(&ch.values[k1 * 4..k1 * 4 + 4]);
                    n.r = a.slerp(b, f).normalize();
                }
            }
        }
    }

    /// Push current node transforms into the per-draw uniform buffer.
    pub fn write_draw_uniforms(&self, queue: &wgpu::Queue) {
        for d in &self.draws {
            let world = self.root_transform * node_world(&self.nodes, d.node);
            let u = DrawU {
                model: world.to_cols_array(),
                id_flags: [d.id, d.has_tangent as u32, 0, 0],
            };
            queue.write_buffer(
                &self.draw_buf,
                d.uniform_offset as u64,
                bytemuck::bytes_of(&u),
            );
        }
    }
}
