//! Texture upload: KTX2 (pre-transcoded BC7, zstd-supercompressed) and PNG/JPEG.

use std::io::Read;

pub struct Uploaded {
    pub view: wgpu::TextureView,
    pub gpu_bytes: u64,
}

fn unzstd(data: &[u8]) -> Result<Vec<u8>, String> {
    let mut input = data;
    let mut dec = ruzstd::decoding::StreamingDecoder::new(&mut input)
        .map_err(|e| format!("zstd init: {e}"))?;
    let mut out = Vec::new();
    dec.read_to_end(&mut out).map_err(|e| format!("zstd: {e}"))?;
    Ok(out)
}

/// Upload a KTX2 file that already holds a block-compressed format WebGPU can
/// sample directly (BC7 for this spike; produced offline by tools/prep-assets.py).
pub fn upload_ktx2(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    bytes: &[u8],
) -> Result<Uploaded, String> {
    let reader = ktx2::Reader::new(bytes).map_err(|e| format!("ktx2: {e:?}"))?;
    let header = reader.header();
    let format = match header.format {
        Some(ktx2::Format::BC7_SRGB_BLOCK) => wgpu::TextureFormat::Bc7RgbaUnormSrgb,
        Some(ktx2::Format::BC7_UNORM_BLOCK) => wgpu::TextureFormat::Bc7RgbaUnorm,
        other => return Err(format!("unsupported ktx2 vkFormat {other:?} (expected BC7)")),
    };
    let (w, h) = (header.pixel_width, header.pixel_height);
    if w % 4 != 0 || h % 4 != 0 {
        return Err(format!("BC7 texture not block-aligned: {w}x{h}"));
    }
    let zstd = matches!(
        header.supercompression_scheme,
        Some(ktx2::SupercompressionScheme::Zstandard)
    );
    let mip_count = header.level_count.max(1);
    let texture = device.create_texture(&wgpu::TextureDescriptor {
        label: Some("ktx2-bc7"),
        size: wgpu::Extent3d {
            width: w,
            height: h,
            depth_or_array_layers: 1,
        },
        mip_level_count: mip_count,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format,
        usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
        view_formats: &[],
    });
    let mut gpu_bytes = 0u64;
    for (i, level) in reader.levels().enumerate() {
        let raw;
        let data: &[u8] = if zstd {
            raw = unzstd(level.data)?;
            &raw
        } else {
            level.data
        };
        let mw = (w >> i).max(1);
        let mh = (h >> i).max(1);
        let bw = mw.div_ceil(4);
        let bh = mh.div_ceil(4);
        let expect = (bw * bh * 16) as usize;
        if data.len() < expect {
            return Err(format!("ktx2 level {i}: {} bytes, expected {expect}", data.len()));
        }
        queue.write_texture(
            wgpu::TexelCopyTextureInfo {
                texture: &texture,
                mip_level: i as u32,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            &data[..expect],
            wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(bw * 16),
                rows_per_image: Some(bh),
            },
            wgpu::Extent3d {
                width: mw,
                height: mh,
                depth_or_array_layers: 1,
            },
        );
        gpu_bytes += expect as u64;
    }
    Ok(Uploaded {
        view: texture.create_view(&wgpu::TextureViewDescriptor::default()),
        gpu_bytes,
    })
}

/// Decode PNG/JPEG on the CPU and upload as RGBA8 (single mip — actor-scale assets).
pub fn upload_image(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    bytes: &[u8],
    srgb: bool,
) -> Result<Uploaded, String> {
    let img = image::load_from_memory(bytes)
        .map_err(|e| format!("image decode: {e}"))?
        .to_rgba8();
    let (w, h) = img.dimensions();
    let format = if srgb {
        wgpu::TextureFormat::Rgba8UnormSrgb
    } else {
        wgpu::TextureFormat::Rgba8Unorm
    };
    let texture = device.create_texture(&wgpu::TextureDescriptor {
        label: Some("rgba8"),
        size: wgpu::Extent3d {
            width: w,
            height: h,
            depth_or_array_layers: 1,
        },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format,
        usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
        view_formats: &[],
    });
    queue.write_texture(
        wgpu::TexelCopyTextureInfo {
            texture: &texture,
            mip_level: 0,
            origin: wgpu::Origin3d::ZERO,
            aspect: wgpu::TextureAspect::All,
        },
        &img,
        wgpu::TexelCopyBufferLayout {
            offset: 0,
            bytes_per_row: Some(w * 4),
            rows_per_image: Some(h),
        },
        wgpu::Extent3d {
            width: w,
            height: h,
            depth_or_array_layers: 1,
        },
    );
    Ok(Uploaded {
        view: texture.create_view(&wgpu::TextureViewDescriptor::default()),
        gpu_bytes: (w * h * 4) as u64,
    })
}

pub fn dummy(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    rgba: [u8; 4],
    srgb: bool,
) -> wgpu::TextureView {
    let format = if srgb {
        wgpu::TextureFormat::Rgba8UnormSrgb
    } else {
        wgpu::TextureFormat::Rgba8Unorm
    };
    let texture = device.create_texture(&wgpu::TextureDescriptor {
        label: Some("dummy"),
        size: wgpu::Extent3d {
            width: 1,
            height: 1,
            depth_or_array_layers: 1,
        },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format,
        usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
        view_formats: &[],
    });
    queue.write_texture(
        wgpu::TexelCopyTextureInfo {
            texture: &texture,
            mip_level: 0,
            origin: wgpu::Origin3d::ZERO,
            aspect: wgpu::TextureAspect::All,
        },
        &rgba,
        wgpu::TexelCopyBufferLayout {
            offset: 0,
            bytes_per_row: Some(4),
            rows_per_image: Some(1),
        },
        wgpu::Extent3d {
            width: 1,
            height: 1,
            depth_or_array_layers: 1,
        },
    );
    texture.create_view(&wgpu::TextureViewDescriptor::default())
}
