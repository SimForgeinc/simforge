//! GPU→CPU pass readback (adapted from the spike's proven machinery,
//! generalised to arbitrary target formats and named passes).

use bevy::prelude::*;
use bevy::render::render_asset::RenderAssets;
use bevy::render::render_resource::{
    Buffer, BufferDescriptor, BufferUsages, CommandEncoderDescriptor, Extent3d, MapMode, PollType,
    TexelCopyBufferInfo, TexelCopyBufferLayout, TextureFormat, TextureUsages,
};
use bevy::render::renderer::{RenderContext, RenderDevice, RenderQueue};
use bevy::render::texture::GpuImage;
use bevy::render::{Extract, Render, RenderApp, RenderSystems};
use std::time::Instant;

pub struct SentPass {
    pub key: String,
    pub frame: u64,
    pub data: Vec<u8>,
    /// Per-pass readback wait time in microseconds.
    pub readback_us: u64,
}

#[derive(Resource, Deref)]
pub struct MainReceiver(crossbeam_channel::Receiver<SentPass>);
#[derive(Resource, Deref)]
pub struct RenderSender(crossbeam_channel::Sender<SentPass>);

#[derive(Component, Clone)]
pub struct PassCopier {
    pub buffer: Buffer,
    pub src_image: Handle<Image>,
    pub key: String,
}

#[derive(Resource, Default, Deref)]
pub struct Copiers(Vec<PassCopier>);

/// Frame counter mirrored into the render world for stamping passes.
#[derive(Resource, Default, Clone, Copy)]
pub struct GlobalFrame(pub u64);
#[derive(Resource, Default, Clone, Copy)]
pub struct FrameStamp(pub u64);

pub fn setup_target_image(
    images: &mut Assets<Image>,
    w: u32,
    h: u32,
    format: TextureFormat,
) -> Handle<Image> {
    let mut img = Image::new_target_texture(w, h, format, None);
    img.texture_descriptor.usage |= TextureUsages::COPY_SRC;
    images.add(img)
}

pub fn make_buffer(device: &RenderDevice, size_bytes: usize) -> Buffer {
    device.create_buffer(&BufferDescriptor {
        label: Some("pass-readback"),
        size: size_bytes as u64,
        usage: BufferUsages::MAP_READ | BufferUsages::COPY_DST,
        mapped_at_creation: false,
    })
}

pub fn aligned_row(width: usize, pixel_size: usize) -> usize {
    RenderDevice::align_copy_bytes_per_row(width * pixel_size)
}

/// Strip row padding from a mapped readback buffer.
pub fn strip_padding(data: &[u8], width: usize, height: usize, pixel: usize) -> Vec<u8> {
    let row = width * pixel;
    let aligned = aligned_row(width, pixel);
    if row == aligned {
        return data[..row * height].to_vec();
    }
    data.chunks_exact(aligned)
        .take(height)
        .flat_map(|r| &r[..row])
        .copied()
        .collect()
}

pub fn extract_copiers(mut commands: Commands, copiers: Extract<Query<&PassCopier>>) {
    commands.insert_resource(Copiers(copiers.iter().cloned().collect()));
}

pub fn extract_frame(frame: Extract<Res<GlobalFrame>>, mut stamp: ResMut<FrameStamp>) {
    stamp.0 = frame.0;
}

pub fn copy_passes(
    mut ctx: RenderContext,
    queue: Res<RenderQueue>,
    copiers: Res<Copiers>,
    gpu_images: Res<RenderAssets<GpuImage>>,
) {
    let mut encoder = ctx
        .render_device()
        .create_command_encoder(&CommandEncoderDescriptor::default());
    for c in copiers.iter() {
        let Some(src) = gpu_images.get(&c.src_image) else {
            continue;
        };
        let width = src.texture_descriptor.size.width as usize;
        let pixel = src.texture_descriptor.format.block_copy_size(None).unwrap_or(4);
        let padded = aligned_row(width, pixel as usize);
        encoder.copy_texture_to_buffer(
            src.texture.as_image_copy(),
            TexelCopyBufferInfo {
                buffer: &c.buffer,
                layout: TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(padded as u32),
                    rows_per_image: None,
                },
            },
            Extent3d {
                width: src.texture_descriptor.size.width,
                height: src.texture_descriptor.size.height,
                depth_or_array_layers: 1,
            },
        );
    }
    queue.submit(std::iter::once(encoder.finish()));
}

pub fn receive_passes(
    device: Res<RenderDevice>,
    sender: Res<RenderSender>,
    copiers: Res<Copiers>,
    stamp: Res<FrameStamp>,
) {
    struct Pending {
        key: String,
        buffer: Buffer,
    }
    let pending: Vec<Pending> = copiers
        .iter()
        .cloned()
        .map(|c| Pending {
            key: c.key,
            buffer: c.buffer,
        })
        .collect();
    if pending.is_empty() {
        return;
    }

    let (s, r) = crossbeam_channel::bounded::<()>(pending.len());
    for p in &pending {
        let tx = s.clone();
        p.buffer
            .slice(..)
            .map_async(MapMode::Read, move |res| {
                if res.is_err() {
                    panic!("map buffer failed");
                }
                let _ = tx.send(());
            });
    }
    let t0 = Instant::now();
    device
        .poll(PollType::wait_indefinitely())
        .expect("poll device");
    for _ in &pending {
        r.recv().expect("map_async result");
    }
    let elapsed_us = t0.elapsed().as_micros() as u64;

    for p in &pending {
        let data = p.buffer.slice(..).get_mapped_range().to_vec();
        let _ = sender.send(SentPass {
            key: p.key.clone(),
            frame: stamp.0,
            data,
            readback_us: elapsed_us / pending.len() as u64,
        });
        p.buffer.unmap();
    }
}

/// Wire the readback side channels into main + render apps.
pub fn install(app: &mut App) -> crossbeam_channel::Receiver<SentPass> {
    let (tx, rx) = crossbeam_channel::unbounded::<SentPass>();
    app.insert_resource(MainReceiver(rx.clone()));
    let render_app = app.get_sub_app_mut(RenderApp).unwrap();
    render_app
        .insert_resource(RenderSender(tx))
        .init_resource::<Copiers>()
        .init_resource::<FrameStamp>()
        .add_systems(bevy::render::ExtractSchedule, (extract_copiers, extract_frame))
        .add_systems(bevy::render::renderer::RenderGraph, copy_passes)
        .add_systems(Render, receive_passes.after(RenderSystems::Render));
    rx
}
