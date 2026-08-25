//! web-spike: WASM/WebGPU feasibility gate for SimForge (lane sf-wasmgate).
//! NON-PRODUCT: bounded spike producing go/no-go measurements only.
//!
//! JS API (wasm-bindgen):
//!   spikeInit(canvas) -> WebSpike            (spec name: init(canvas))
//!   spike.loadTiles(urls) -> Promise<statsJson>
//!   spike.spawnActor(url, x?, y?, z?, scale?) -> Promise<statsJson>
//!   spike.setCamera([ex,ey,ez, tx,ty,tz, fovyDeg])
//!   spike.pick(x, y) -> Promise<objectId>
//!   spike.renderAt(tick) -> Promise<void>    (resolves after GPU work done)

mod gltf_min;
mod model;
mod texture;

use glam::{Mat4, Vec3};
use model::{LoadCtx, Model};
use std::cell::RefCell;
use std::rc::Rc;
use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::{future_to_promise, JsFuture};

#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct Globals {
    view_proj: [f32; 16],
    cam_pos: [f32; 4],
    sun_dir: [f32; 4],
    sun_color: [f32; 4],
}

pub struct Engine {
    surface: wgpu::Surface<'static>,
    device: wgpu::Device,
    queue: wgpu::Queue,
    config: wgpu::SurfaceConfiguration,
    view_format: wgpu::TextureFormat,
    depth_view: wgpu::TextureView,
    id_texture: wgpu::Texture,
    id_view: wgpu::TextureView,
    id_depth_view: wgpu::TextureView,
    pick_buf: wgpu::Buffer,
    pipe_opaque: wgpu::RenderPipeline,
    pipe_blend: wgpu::RenderPipeline,
    pipe_id: wgpu::RenderPipeline,
    pipe_swatch: wgpu::RenderPipeline,
    globals_buf: wgpu::Buffer,
    globals_bg: wgpu::BindGroup,
    swatch_buf: wgpu::Buffer,
    swatch_bg: wgpu::BindGroup,
    material_layout: wgpu::BindGroupLayout,
    draw_layout: wgpu::BindGroupLayout,
    sampler: wgpu::Sampler,
    dummy_white: wgpu::TextureView,
    dummy_mr: wgpu::TextureView,
    dummy_normal: wgpu::TextureView,
    models: Vec<Model>,
    actor: Option<usize>,
    eye: Vec3,
    target: Vec3,
    fovy_deg: f32,
    next_id: u32,
    adapter_info: String,
}

fn err(e: impl std::fmt::Display) -> JsValue {
    JsValue::from_str(&e.to_string())
}

fn now() -> f64 {
    web_sys::window().unwrap().performance().unwrap().now()
}

/// Deterministic per-tick swatch color, as final sRGB bytes.
fn swatch_srgb(tick: u32) -> [u8; 3] {
    [
        (tick.wrapping_mul(97).wrapping_add(13) & 0xff) as u8,
        (tick.wrapping_mul(57).wrapping_add(101) & 0xff) as u8,
        (tick.wrapping_mul(29).wrapping_add(59) & 0xff) as u8,
    ]
}

fn srgb_to_linear(c: f32) -> f32 {
    if c <= 0.04045 {
        c / 12.92
    } else {
        ((c + 0.055) / 1.055).powf(2.4)
    }
}

async fn fetch_bytes(url: &str) -> Result<Vec<u8>, JsValue> {
    let win = web_sys::window().ok_or_else(|| err("no window"))?;
    let resp: web_sys::Response = JsFuture::from(win.fetch_with_str(url)).await?.dyn_into()?;
    if !resp.ok() {
        return Err(err(format!("fetch {url}: HTTP {}", resp.status())));
    }
    let buf = JsFuture::from(resp.array_buffer()?).await?;
    Ok(js_sys::Uint8Array::new(&buf).to_vec())
}

impl Engine {
    async fn new(canvas: web_sys::HtmlCanvasElement) -> Result<Engine, JsValue> {
        let width = canvas.width();
        let height = canvas.height();
        let mut idesc = wgpu::InstanceDescriptor::new_without_display_handle();
        idesc.backends = wgpu::Backends::BROWSER_WEBGPU;
        let instance = wgpu::Instance::new(idesc);
        let surface = instance
            .create_surface(wgpu::SurfaceTarget::Canvas(canvas))
            .map_err(err)?;
        let adapter = instance
            .request_adapter(&wgpu::RequestAdapterOptions {
                power_preference: wgpu::PowerPreference::HighPerformance,
                compatible_surface: Some(&surface),
                force_fallback_adapter: false,
                apply_limit_buckets: false,
            })
            .await
            .map_err(err)?;
        let info = adapter.get_info();
        let adapter_info = format!("{} / {:?} / {:?}", info.name, info.device_type, info.backend);
        if !adapter
            .features()
            .contains(wgpu::Features::TEXTURE_COMPRESSION_BC)
        {
            return Err(err("adapter lacks texture-compression-bc (required for BC7 tiles)"));
        }
        let (device, queue) = adapter
            .request_device(&wgpu::DeviceDescriptor {
                label: Some("web-spike"),
                required_features: wgpu::Features::TEXTURE_COMPRESSION_BC,
                required_limits: wgpu::Limits::default(),
                experimental_features: wgpu::ExperimentalFeatures::disabled(),
                memory_hints: wgpu::MemoryHints::default(),
                trace: wgpu::Trace::Off,
            })
            .await
            .map_err(err)?;

        let caps = surface.get_capabilities(&adapter);
        let format = caps.formats[0];
        let view_format = format.add_srgb_suffix();
        let config = wgpu::SurfaceConfiguration {
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
            format,
            color_space: wgpu::SurfaceColorSpace::Auto,
            width,
            height,
            present_mode: wgpu::PresentMode::Fifo,
            alpha_mode: wgpu::CompositeAlphaMode::Opaque,
            view_formats: vec![view_format],
            desired_maximum_frame_latency: 2,
        };
        surface.configure(&device, &config);

        let depth_view = device
            .create_texture(&wgpu::TextureDescriptor {
                label: Some("depth"),
                size: wgpu::Extent3d {
                    width,
                    height,
                    depth_or_array_layers: 1,
                },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: wgpu::TextureFormat::Depth32Float,
                usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
                view_formats: &[],
            })
            .create_view(&Default::default());

        let id_texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("id"),
            size: wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::R32Uint,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
            view_formats: &[],
        });
        let id_view = id_texture.create_view(&Default::default());
        let id_depth_view = device
            .create_texture(&wgpu::TextureDescriptor {
                label: Some("id-depth"),
                size: wgpu::Extent3d {
                    width,
                    height,
                    depth_or_array_layers: 1,
                },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: wgpu::TextureFormat::Depth32Float,
                usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
                view_formats: &[],
            })
            .create_view(&Default::default());
        let pick_buf = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("pick"),
            size: 256,
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });

        // --- bind group layouts
        let uniform_entry = |binding, dynamic, size| wgpu::BindGroupLayoutEntry {
            binding,
            visibility: wgpu::ShaderStages::VERTEX_FRAGMENT,
            ty: wgpu::BindingType::Buffer {
                ty: wgpu::BufferBindingType::Uniform,
                has_dynamic_offset: dynamic,
                min_binding_size: wgpu::BufferSize::new(size),
            },
            count: None,
        };
        let tex_entry = |binding| wgpu::BindGroupLayoutEntry {
            binding,
            visibility: wgpu::ShaderStages::FRAGMENT,
            ty: wgpu::BindingType::Texture {
                sample_type: wgpu::TextureSampleType::Float { filterable: true },
                view_dimension: wgpu::TextureViewDimension::D2,
                multisampled: false,
            },
            count: None,
        };
        let globals_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("globals"),
            entries: &[uniform_entry(0, false, std::mem::size_of::<Globals>() as u64)],
        });
        let draw_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("draw"),
            entries: &[uniform_entry(0, true, std::mem::size_of::<model::DrawU>() as u64)],
        });
        let material_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("material"),
            entries: &[
                uniform_entry(0, false, std::mem::size_of::<model::MatU>() as u64),
                tex_entry(1),
                tex_entry(2),
                tex_entry(3),
                wgpu::BindGroupLayoutEntry {
                    binding: 4,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                    count: None,
                },
            ],
        });
        let swatch_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("swatch"),
            entries: &[uniform_entry(0, false, 16)],
        });

        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("web-spike"),
            source: wgpu::ShaderSource::Wgsl(include_str!("shader.wgsl").into()),
        });

        let scene_pl = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("scene"),
            bind_group_layouts: &[Some(&globals_layout), Some(&draw_layout), Some(&material_layout)],
            immediate_size: 0,
        });
        let id_pl = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("id"),
            bind_group_layouts: &[Some(&globals_layout), Some(&draw_layout)],
            immediate_size: 0,
        });
        let swatch_pl = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("swatch"),
            bind_group_layouts: &[Some(&swatch_layout)],
            immediate_size: 0,
        });

        let vbufs = [
            Some(wgpu::VertexBufferLayout {
                array_stride: 12,
                step_mode: wgpu::VertexStepMode::Vertex,
                attributes: &wgpu::vertex_attr_array![0 => Float32x3],
            }),
            Some(wgpu::VertexBufferLayout {
                array_stride: 12,
                step_mode: wgpu::VertexStepMode::Vertex,
                attributes: &wgpu::vertex_attr_array![1 => Float32x3],
            }),
            Some(wgpu::VertexBufferLayout {
                array_stride: 16,
                step_mode: wgpu::VertexStepMode::Vertex,
                attributes: &wgpu::vertex_attr_array![2 => Float32x4],
            }),
            Some(wgpu::VertexBufferLayout {
                array_stride: 8,
                step_mode: wgpu::VertexStepMode::Vertex,
                attributes: &wgpu::vertex_attr_array![3 => Float32x2],
            }),
        ];
        let depth = |write, compare| {
            Some(wgpu::DepthStencilState {
                format: wgpu::TextureFormat::Depth32Float,
                depth_write_enabled: Some(write),
                depth_compare: Some(compare),
                stencil: Default::default(),
                bias: Default::default(),
            })
        };
        let scene_pipeline = |label: &str, blend: Option<wgpu::BlendState>, depth_write: bool| {
            device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                label: Some(label),
                layout: Some(&scene_pl),
                vertex: wgpu::VertexState {
                    module: &shader,
                    entry_point: Some("vs_main"),
                    compilation_options: Default::default(),
                    buffers: &vbufs,
                },
                fragment: Some(wgpu::FragmentState {
                    module: &shader,
                    entry_point: Some("fs_main"),
                    compilation_options: Default::default(),
                    targets: &[Some(wgpu::ColorTargetState {
                        format: view_format,
                        blend,
                        write_mask: wgpu::ColorWrites::ALL,
                    })],
                }),
                primitive: wgpu::PrimitiveState {
                    cull_mode: None, // most tile materials are double-sided
                    ..Default::default()
                },
                depth_stencil: depth(depth_write, wgpu::CompareFunction::Less),
                multisample: Default::default(),
                multiview_mask: None,
                cache: None,
            })
        };
        let pipe_opaque = scene_pipeline("opaque", None, true);
        let pipe_blend = scene_pipeline("blend", Some(wgpu::BlendState::ALPHA_BLENDING), false);

        let pipe_id = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("id"),
            layout: Some(&id_pl),
            vertex: wgpu::VertexState {
                module: &shader,
                entry_point: Some("vs_id"),
                compilation_options: Default::default(),
                buffers: &vbufs,
            },
            fragment: Some(wgpu::FragmentState {
                module: &shader,
                entry_point: Some("fs_id"),
                compilation_options: Default::default(),
                targets: &[Some(wgpu::ColorTargetState {
                    format: wgpu::TextureFormat::R32Uint,
                    blend: None,
                    write_mask: wgpu::ColorWrites::ALL,
                })],
            }),
            primitive: wgpu::PrimitiveState {
                cull_mode: None,
                ..Default::default()
            },
            depth_stencil: depth(true, wgpu::CompareFunction::Less),
            multisample: Default::default(),
            multiview_mask: None,
            cache: None,
        });

        let pipe_swatch = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("swatch"),
            layout: Some(&swatch_pl),
            vertex: wgpu::VertexState {
                module: &shader,
                entry_point: Some("vs_swatch"),
                compilation_options: Default::default(),
                buffers: &[],
            },
            fragment: Some(wgpu::FragmentState {
                module: &shader,
                entry_point: Some("fs_swatch"),
                compilation_options: Default::default(),
                targets: &[Some(wgpu::ColorTargetState {
                    format: view_format,
                    blend: None,
                    write_mask: wgpu::ColorWrites::ALL,
                })],
            }),
            primitive: Default::default(),
            depth_stencil: depth(false, wgpu::CompareFunction::Always),
            multisample: Default::default(),
            multiview_mask: None,
            cache: None,
        });

        let globals_buf = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("globals"),
            size: std::mem::size_of::<Globals>() as u64,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let globals_bg = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("globals"),
            layout: &globals_layout,
            entries: &[wgpu::BindGroupEntry {
                binding: 0,
                resource: globals_buf.as_entire_binding(),
            }],
        });
        let swatch_buf = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("swatch"),
            size: 16,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let swatch_bg = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("swatch"),
            layout: &swatch_layout,
            entries: &[wgpu::BindGroupEntry {
                binding: 0,
                resource: swatch_buf.as_entire_binding(),
            }],
        });

        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("trilinear"),
            address_mode_u: wgpu::AddressMode::Repeat,
            address_mode_v: wgpu::AddressMode::Repeat,
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            mipmap_filter: wgpu::MipmapFilterMode::Linear,
            anisotropy_clamp: 4,
            ..Default::default()
        });
        let dummy_white = texture::dummy(&device, &queue, [255, 255, 255, 255], true);
        let dummy_mr = texture::dummy(&device, &queue, [255, 255, 255, 255], false);
        let dummy_normal = texture::dummy(&device, &queue, [128, 128, 255, 255], false);

        Ok(Engine {
            surface,
            device,
            queue,
            config,
            view_format,
            depth_view,
            id_texture,
            id_view,
            id_depth_view,
            pick_buf,
            pipe_opaque,
            pipe_blend,
            pipe_id,
            pipe_swatch,
            globals_buf,
            globals_bg,
            swatch_buf,
            swatch_bg,
            material_layout,
            draw_layout,
            sampler,
            dummy_white,
            dummy_mr,
            dummy_normal,
            models: Vec::new(),
            actor: None,
            eye: Vec3::new(0.0, 50.0, 100.0),
            target: Vec3::ZERO,
            fovy_deg: 50.0,
            next_id: 1,
            adapter_info,
        })
    }

    fn load_ctx(&self) -> LoadCtx<'_> {
        LoadCtx {
            device: &self.device,
            queue: &self.queue,
            material_layout: &self.material_layout,
            draw_layout: &self.draw_layout,
            sampler: &self.sampler,
            dummy_white: &self.dummy_white,
            dummy_mr: &self.dummy_mr,
            dummy_normal: &self.dummy_normal,
        }
    }

    fn scene_bounds(&self) -> (Vec3, Vec3) {
        let mut mn = Vec3::splat(f32::INFINITY);
        let mut mx = Vec3::splat(f32::NEG_INFINITY);
        for m in &self.models {
            mn = mn.min(m.bounds_min);
            mx = mx.max(m.bounds_max);
        }
        if !mn.is_finite() {
            (Vec3::splat(-1.0), Vec3::splat(1.0))
        } else {
            (mn, mx)
        }
    }

    fn write_globals(&self) {
        let (mn, mx) = self.scene_bounds();
        let radius = ((mx - mn).length() * 0.5).max(1.0);
        let near = (radius * 5e-4).clamp(0.05, 10.0);
        let far = radius * 8.0 + 100.0;
        let aspect = self.config.width as f32 / self.config.height as f32;
        let vp = Mat4::perspective_rh(self.fovy_deg.to_radians(), aspect, near, far)
            * Mat4::look_at_rh(self.eye, self.target, Vec3::Y);
        let sun = Vec3::new(0.35, 0.9, 0.25).normalize();
        let g = Globals {
            view_proj: vp.to_cols_array(),
            cam_pos: [self.eye.x, self.eye.y, self.eye.z, 1.0],
            sun_dir: [sun.x, sun.y, sun.z, 0.30],
            sun_color: [3.1, 3.0, 2.85, 0.0],
        };
        self.queue.write_buffer(&self.globals_buf, 0, bytemuck::bytes_of(&g));
    }

    /// Encode and submit one frame; returns the surface texture to present.
    fn render_frame(&mut self, tick: u32) -> Result<wgpu::SurfaceTexture, JsValue> {
        if let Some(actor_idx) = self.actor {
            let t = tick as f32 / 60.0;
            let m = &mut self.models[actor_idx];
            m.animate(t);
            m.write_draw_uniforms(&self.queue);
        }
        self.write_globals();
        let sc = swatch_srgb(tick);
        let sw = [
            srgb_to_linear(sc[0] as f32 / 255.0),
            srgb_to_linear(sc[1] as f32 / 255.0),
            srgb_to_linear(sc[2] as f32 / 255.0),
            1.0f32,
        ];
        self.queue.write_buffer(&self.swatch_buf, 0, bytemuck::bytes_of(&sw));

        let frame = match self.surface.get_current_texture() {
            wgpu::CurrentSurfaceTexture::Success(f) | wgpu::CurrentSurfaceTexture::Suboptimal(f) => f,
            other => return Err(err(format!("surface texture unavailable: {other:?}"))),
        };
        let view = frame.texture.create_view(&wgpu::TextureViewDescriptor {
            format: Some(self.view_format),
            ..Default::default()
        });
        let mut enc = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("frame") });
        {
            let mut pass = enc.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("main"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &view,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color {
                            r: 0.16,
                            g: 0.28,
                            b: 0.52,
                            a: 1.0,
                        }),
                        store: wgpu::StoreOp::Store,
                    },
                    depth_slice: None,
                })],
                depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment {
                    view: &self.depth_view,
                    depth_ops: Some(wgpu::Operations {
                        load: wgpu::LoadOp::Clear(1.0),
                        store: wgpu::StoreOp::Discard,
                    }),
                    stencil_ops: None,
                }),
                timestamp_writes: None,
                occlusion_query_set: None,
                multiview_mask: None,
            });
            pass.set_bind_group(0, &self.globals_bg, &[]);
            for blend_phase in [false, true] {
                pass.set_pipeline(if blend_phase {
                    &self.pipe_blend
                } else {
                    &self.pipe_opaque
                });
                for m in &self.models {
                    for d in m.draws.iter().filter(|d| d.blend == blend_phase) {
                        pass.set_bind_group(1, &m.draw_bind_group, &[d.uniform_offset]);
                        pass.set_bind_group(2, &m.materials[d.material].bind_group, &[]);
                        pass.set_vertex_buffer(0, d.pos.slice(..));
                        pass.set_vertex_buffer(1, d.nrm.slice(..));
                        pass.set_vertex_buffer(2, d.tan.slice(..));
                        pass.set_vertex_buffer(3, d.uv.slice(..));
                        pass.set_index_buffer(d.idx.slice(..), d.index_format);
                        pass.draw_indexed(0..d.index_count, 0, 0..1);
                    }
                }
            }
            // tick swatch for the WebCodecs exact-frame check
            pass.set_pipeline(&self.pipe_swatch);
            pass.set_bind_group(0, &self.swatch_bg, &[]);
            pass.set_viewport(8.0, 8.0, 96.0, 96.0, 0.0, 1.0);
            pass.draw(0..3, 0..1);
        }
        self.queue.submit([enc.finish()]);
        Ok(frame)
    }

    fn encode_pick(&self, x: u32, y: u32) {
        let mut enc = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("pick") });
        {
            let mut pass = enc.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("id"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &self.id_view,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT),
                        store: wgpu::StoreOp::Store,
                    },
                    depth_slice: None,
                })],
                depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment {
                    view: &self.id_depth_view,
                    depth_ops: Some(wgpu::Operations {
                        load: wgpu::LoadOp::Clear(1.0),
                        store: wgpu::StoreOp::Discard,
                    }),
                    stencil_ops: None,
                }),
                timestamp_writes: None,
                occlusion_query_set: None,
                multiview_mask: None,
            });
            pass.set_pipeline(&self.pipe_id);
            pass.set_bind_group(0, &self.globals_bg, &[]);
            for m in &self.models {
                for d in &m.draws {
                    pass.set_bind_group(1, &m.draw_bind_group, &[d.uniform_offset]);
                    pass.set_vertex_buffer(0, d.pos.slice(..));
                    pass.set_vertex_buffer(1, d.nrm.slice(..));
                    pass.set_vertex_buffer(2, d.tan.slice(..));
                    pass.set_vertex_buffer(3, d.uv.slice(..));
                    pass.set_index_buffer(d.idx.slice(..), d.index_format);
                    pass.draw_indexed(0..d.index_count, 0, 0..1);
                }
            }
        }
        enc.copy_texture_to_buffer(
            wgpu::TexelCopyTextureInfo {
                texture: &self.id_texture,
                mip_level: 0,
                origin: wgpu::Origin3d { x, y, z: 0 },
                aspect: wgpu::TextureAspect::All,
            },
            wgpu::TexelCopyBufferInfo {
                buffer: &self.pick_buf,
                layout: wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(256),
                    rows_per_image: Some(1),
                },
            },
            wgpu::Extent3d {
                width: 1,
                height: 1,
                depth_or_array_layers: 1,
            },
        );
        self.queue.submit([enc.finish()]);
    }

    fn stats_json(&self) -> String {
        let (mn, mx) = self.scene_bounds();
        let draws: usize = self.models.iter().map(|m| m.draws.len()).sum();
        let tris: u64 = self.models.iter().map(|m| m.tri_count).sum();
        let geo: u64 = self.models.iter().map(|m| m.geo_bytes).sum();
        let tex: u64 = self.models.iter().map(|m| m.tex_bytes).sum();
        let texn: u32 = self.models.iter().map(|m| m.tex_count).sum();
        format!(
            r#"{{"models":{},"draws":{draws},"triangles":{tris},"geometryBytes":{geo},"textureBytes":{tex},"textures":{texn},"wasmMemoryBytes":{},"bounds":[{},{},{},{},{},{}],"adapter":"{}"}}"#,
            self.models.len(),
            wasm_bindgen::memory()
                .dyn_into::<js_sys::WebAssembly::Memory>()
                .map(|m| js_sys::ArrayBuffer::from(m.buffer()).byte_length())
                .unwrap_or(0),
            mn.x, mn.y, mn.z, mx.x, mx.y, mx.z,
            self.adapter_info
        )
    }
}

async fn await_gpu_done(queue: &wgpu::Queue) {
    let (tx, rx) = futures_channel::oneshot::channel::<()>();
    queue.on_submitted_work_done(move || {
        let _ = tx.send(());
    });
    let _ = rx.await;
}

#[wasm_bindgen]
pub struct WebSpike {
    inner: Rc<RefCell<Engine>>,
}

/// Spec-shape `init(canvas)`; named spikeInit to avoid clashing with the
/// wasm-bindgen module loader's own `init` default export.
#[wasm_bindgen(js_name = spikeInit)]
pub async fn spike_init(canvas: web_sys::HtmlCanvasElement) -> Result<WebSpike, JsValue> {
    console_error_panic_hook::set_once();
    let engine = Engine::new(canvas).await?;
    Ok(WebSpike {
        inner: Rc::new(RefCell::new(engine)),
    })
}

#[wasm_bindgen]
impl WebSpike {
    #[wasm_bindgen(js_name = loadTiles)]
    pub fn load_tiles(&self, urls: Vec<String>) -> js_sys::Promise {
        let inner = self.inner.clone();
        future_to_promise(async move {
            let mut parts = Vec::new();
            for url in urls {
                let t0 = now();
                let bytes = fetch_bytes(&url).await?;
                let t1 = now();
                let (first_id, model) = {
                    let mut e = inner.borrow_mut();
                    let first_id = e.next_id;
                    let model = Model::load(&e.load_ctx(), &bytes, Mat4::IDENTITY, first_id)
                        .map_err(err)?;
                    e.next_id += model.draws.len() as u32;
                    (first_id, model)
                };
                let t2 = now();
                parts.push(format!(
                    r#"{{"url":"{url}","bytes":{},"fetchMs":{:.1},"buildMs":{:.1},"draws":{},"triangles":{},"textures":{},"firstId":{first_id}}}"#,
                    bytes.len(),
                    t1 - t0,
                    t2 - t1,
                    model.draws.len(),
                    model.tri_count,
                    model.tex_count,
                ));
                inner.borrow_mut().models.push(model);
            }
            // flush uploads before reporting
            {
                let e = inner.borrow();
                e.queue.submit([]);
            }
            Ok(JsValue::from_str(&format!("[{}]", parts.join(","))))
        })
    }

    #[wasm_bindgen(js_name = spawnActor)]
    pub fn spawn_actor(
        &self,
        url: String,
        x: Option<f32>,
        y: Option<f32>,
        z: Option<f32>,
        scale: Option<f32>,
    ) -> js_sys::Promise {
        let inner = self.inner.clone();
        future_to_promise(async move {
            let t0 = now();
            let bytes = fetch_bytes(&url).await?;
            let t1 = now();
            let json = {
                let mut e = inner.borrow_mut();
                // default: drop the actor at the middle of the tile bounds, on the low plane
                let (mn, mx) = e.scene_bounds();
                let c = (mn + mx) * 0.5;
                let pos = Vec3::new(x.unwrap_or(c.x), y.unwrap_or(mn.y), z.unwrap_or(c.z));
                let root =
                    Mat4::from_translation(pos) * Mat4::from_scale(Vec3::splat(scale.unwrap_or(1.0)));
                let first_id = e.next_id;
                let model = Model::load(&e.load_ctx(), &bytes, root, first_id).map_err(err)?;
                e.next_id += model.draws.len() as u32;
                let json = format!(
                    r#"{{"bytes":{},"fetchMs":{:.1},"buildMs":{:.1},"draws":{},"animChannels":{},"animDuration":{:.2},"firstId":{first_id},"pos":[{},{},{}]}}"#,
                    bytes.len(),
                    t1 - t0,
                    now() - t1,
                    model.draws.len(),
                    model.channels.len(),
                    model.anim_duration,
                    pos.x, pos.y, pos.z,
                );
                let idx = e.models.len();
                e.models.push(model);
                e.actor = Some(idx);
                json
            };
            Ok(JsValue::from_str(&json))
        })
    }

    /// pose: [eyeX, eyeY, eyeZ, targetX, targetY, targetZ, fovYdegrees]
    #[wasm_bindgen(js_name = setCamera)]
    pub fn set_camera(&self, pose: &[f32]) {
        let mut e = self.inner.borrow_mut();
        if pose.len() >= 6 {
            e.eye = Vec3::new(pose[0], pose[1], pose[2]);
            e.target = Vec3::new(pose[3], pose[4], pose[5]);
        }
        if pose.len() >= 7 {
            e.fovy_deg = pose[6];
        }
    }

    #[wasm_bindgen(js_name = renderAt)]
    pub fn render_at(&self, tick: u32) -> js_sys::Promise {
        let inner = self.inner.clone();
        future_to_promise(async move {
            let frame = inner.borrow_mut().render_frame(tick)?;
            let queue = inner.borrow().queue.clone();
            queue.present(frame);
            await_gpu_done(&queue).await;
            Ok(JsValue::UNDEFINED)
        })
    }

    pub fn pick(&self, x: u32, y: u32) -> js_sys::Promise {
        let inner = self.inner.clone();
        future_to_promise(async move {
            {
                let e = inner.borrow();
                if x >= e.config.width || y >= e.config.height {
                    return Err(err("pick out of bounds"));
                }
                e.encode_pick(x, y);
            }
            let (buf, queue) = {
                let e = inner.borrow();
                (e.pick_buf.clone(), e.queue.clone())
            };
            await_gpu_done(&queue).await;
            let (tx, rx) = futures_channel::oneshot::channel();
            buf.map_async(wgpu::MapMode::Read, 0..4, move |r| {
                let _ = tx.send(r);
            });
            rx.await.map_err(err)?.map_err(err)?;
            let id = {
                let data = buf.get_mapped_range(0..4).map_err(err)?;
                u32::from_le_bytes(data[0..4].try_into().unwrap())
            };
            buf.unmap();
            Ok(JsValue::from_f64(id as f64))
        })
    }

    #[wasm_bindgen(js_name = sceneBounds)]
    pub fn scene_bounds(&self) -> Vec<f32> {
        let (mn, mx) = self.inner.borrow().scene_bounds();
        vec![mn.x, mn.y, mn.z, mx.x, mx.y, mx.z]
    }

    #[wasm_bindgen(js_name = expectedSwatch)]
    pub fn expected_swatch(&self, tick: u32) -> Vec<u8> {
        swatch_srgb(tick).to_vec()
    }

    pub fn stats(&self) -> String {
        self.inner.borrow().stats_json()
    }

    #[wasm_bindgen(js_name = adapterInfo)]
    pub fn adapter_info(&self) -> String {
        self.inner.borrow().adapter_info.clone()
    }
}
