//! CARLA-compatible raw byte encodings for the V2X product surface (V4).
//!
//! The legacy V2XCarla consumers read CARLA sensor raw buffers directly:
//!
//! - semantic-seg (`sensor.camera.semantic_segmentation`, BGRA): the class id
//!   sits in byte index 2 (`arr[:, :, 2]` — the R channel of the RGB triple);
//!   see `digital_twin_bridge/perception.py::_on_sem`.
//! - depth (`sensor.camera.depth`, BGRA): 24-bit fixed point normalized over a
//!   1000 m far plane, `normalized = (r + g*256 + b*65536) / (256^3 - 1)` with
//!   r = byte index 2 (LSB), b = byte index 0 (MSB);
//!   see `perception.py::_on_depth` and its `DEPTH_MAX_M = 1000.0`.
//!
//! Both encoders here emit exactly those layouts so the ported fusion can
//! consume native renderer outputs unmodified. Class ids follow CARLA's
//! CityScapes palette (the subset that exists in our narrower taxonomy):
//! building 1, pedestrian 4, road 7, vegetation 9, vehicle 10,
//! traffic_sign 12, traffic_light 18. Our taxonomy has NO cone class —
//! the legacy `cone` (19) mapping does not exist natively and is documented
//! as absent rather than approximated.

/// CARLA depth far plane used by the legacy perception stack.
pub const CARLA_DEPTH_MAX_M: f32 = 1000.0;

/// Convert one row-padded Depth32Float readback (reverse-Z) into the CARLA
/// packed-depth RGBA8 layout (same row stride as the input).
///
/// `near_m`/`far_m` must match the camera projection that produced the depth
/// buffer. The reverse-Z linearization is the standard perspective inverse:
/// `z_view = near*far / (far - d*(far-near))`, clamped to `[near, far]`.
pub fn depth_to_carla(
    data: &[u8],
    width: u32,
    height: u32,
    stride: usize,
    near_m: f32,
    far_m: f32,
) -> Vec<u8> {
    let h = height as usize;
    let w = width as usize;
    let mut out = vec![0u8; stride * h];
    for row in 0..h {
        let src = &data[row * stride..row * stride + w * 4];
        let dst = &mut out[row * stride..row * stride + w * 4];
        for col in 0..w {
            let bits = u32::from_le_bytes([
                src[col * 4],
                src[col * 4 + 1],
                src[col * 4 + 2],
                src[col * 4 + 3],
            ]);
            let d = f32::from_bits(bits);
            // Background (cleared far plane under reverse-Z) stays background.
            let meters = if d >= 1.0 {
                CARLA_DEPTH_MAX_M
            } else {
                let denom = far_m - d * (far_m - near_m);
                if denom <= 0.0 {
                    far_m
                } else {
                    (near_m * far_m / denom).clamp(near_m, far_m)
                }
            };
            let v = (meters.min(CARLA_DEPTH_MAX_M) / CARLA_DEPTH_MAX_M
                * 16_777_215.0)
                .round() as u32;
            dst[col * 4] = ((v >> 16) & 0xFF) as u8; // B = MSB
            dst[col * 4 + 1] = ((v >> 8) & 0xFF) as u8; // G
            dst[col * 4 + 2] = (v & 0xFF) as u8; // R = LSB
            dst[col * 4 + 3] = 255;
        }
    }
    out
}

/// Semantic class ids (CARLA CityScapes palette subset we can honestly emit).
pub mod classes {
    pub const UNLABELED: u8 = 0;
    pub const BUILDING: u8 = 1;
    pub const PEDESTRIAN: u8 = 4;
    pub const ROAD: u8 = 7;
    pub const VEGETATION: u8 = 9;
    pub const VEHICLE: u8 = 10;
    pub const TRAFFIC_SIGN: u8 = 12;
    pub const TRAFFIC_LIGHT: u8 = 18;
}

/// Map a static-mesh legend name to a CARLA class id, mirroring
/// `native/sensors/TAXONOMY.md` matching order (vegetation before building
/// before road keywords). Everything unmatched stays 0 (unlabeled) — honest
/// background, not a guess.
pub fn static_class_of(name: &str) -> u8 {
    let lower = name.to_ascii_lowercase();
    let has = |needles: &[&str]| needles.iter().any(|n| lower.contains(n));
    if has(&["tree", "veg", "bush", "shrub", "plant", "foliage", "grass", "hedge"]) {
        classes::VEGETATION
    } else if lower.contains("building") {
        classes::BUILDING
    } else if has(&[
        "road",
        "asphalt",
        "sidewalk",
        "curb",
        "ground",
        "pavement",
        "crosswalk",
        "marking",
    ]) {
        classes::ROAD
    } else {
        classes::UNLABELED
    }
}

/// Map a dynamic-actor semantic class name (scene-state `actorClass`) to a
/// CARLA class id. Cyclists ride bicycles; CARLA models the *bicycle* as its
/// own class (9) but the rider as pedestrian — the legacy fusion tracks
/// riders, so they map to pedestrian. Trucks/buses fold into vehicle exactly
/// like the legacy `SEM_CLASSES` consumer treats them ("vehicle").
pub fn actor_class_of(class: &str) -> u8 {
    match class {
        "car" | "truck" | "bus" | "motorcycle" => classes::VEHICLE,
        "pedestrian" | "cyclist" => classes::PEDESTRIAN,
        _ => classes::UNLABELED,
    }
}

/// Derive a CARLA-layout semantic buffer from the instance-ID pass.
///
/// `id_data` is the row-padded RGBA8 instance-ID readback; `class_of` maps an
/// instance id to a CARLA class id (lookup order: dynamic actors, then static
/// legend names). Output keeps the same row stride; byte 2 carries the class,
/// all other bytes are 0 except alpha = 255.
pub fn semantic_from_ids<F>(id_data: &[u8], width: u32, height: u32, stride: usize, class_of: F) -> Vec<u8>
where
    F: Fn(u32) -> u8,
{
    let h = height as usize;
    let w = width as usize;
    let mut out = vec![0u8; stride * h];
    for row in 0..h {
        let src = &id_data[row * stride..row * stride + w * 4];
        let dst = &mut out[row * stride..row * stride + w * 4];
        for col in 0..w {
            let id = u32::from(src[col * 4])
                | (u32::from(src[col * 4 + 1]) << 8)
                | (u32::from(src[col * 4 + 2]) << 16);
            if id == 0 {
                continue; // background/sky
            }
            dst[col * 4 + 2] = class_of(id);
            dst[col * 4 + 3] = 255;
        }
    }
    out
}

/// Encode tightly-packed RGB8 pixels (already de-padded, no alpha) as JPEG.
pub fn encode_jpeg(rgb: &[u8], width: u32, height: u32, quality: u8) -> Result<Vec<u8>, String> {
    let mut buf = std::io::Cursor::new(Vec::new());
    let encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buf, quality);
    let img = image::RgbImage::from_raw(width, height, rgb.to_vec())
        .ok_or_else(|| "rgb buffer size mismatch".to_string())?;
    img.write_with_encoder(encoder)
        .map_err(|e| format!("jpeg encode: {e}"))?;
    Ok(buf.into_inner())
}

/// Strip wgpu 256-byte row padding from an RGBA8 (or any 4-byte pixel)
/// row-padded buffer.
pub fn strip_rgba_padding(data: &[u8], width: u32, height: u32, stride: usize) -> Vec<u8> {
    let w = width as usize;
    let h = height as usize;
    let row = w * 4;
    if stride == row {
        return data[..row * h].to_vec();
    }
    let mut out = Vec::with_capacity(row * h);
    for r in 0..h {
        out.extend_from_slice(&data[r * stride..r * stride + row]);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn carla_depth_round_trip() {
        // One pixel per row-stride trick: build a 2x1 image, stride = 8.
        let near = 0.5f32;
        let far = 900.0f32;
        let z = 42.0f32;
        // Reverse-Z depth value whose linearization returns exactly z.
        let d = (far - near * far / z) / (far - near);
        let mut data = vec![0u8; 8];
        data[..4].copy_from_slice(&d.to_bits().to_le_bytes());
        let out = depth_to_carla(&data, 2, 1, 8, near, far);
        let v = u32::from(out[0]) << 16 | u32::from(out[1]) << 8 | u32::from(out[2]);
        let meters = v as f32 / 16_777_215.0 * CARLA_DEPTH_MAX_M;
        assert!((meters - z).abs() < 0.01, "meters={meters}");
        assert_eq!(out[3], 255);
        // Second pixel left untouched (out sized by stride).
    }
    #[test]
    fn depth_background_is_far() {
        let mut data = vec![0u8; 4];
        data.copy_from_slice(&1.0f32.to_bits().to_le_bytes());
        let out = depth_to_carla(&data, 1, 1, 4, 0.5, 900.0);
        let v = u32::from(out[0]) << 16 | u32::from(out[1]) << 8 | u32::from(out[2]);
        let meters = v as f32 / 16_777_215.0 * CARLA_DEPTH_MAX_M;
        assert!(meters > 999.0);
    }

    #[test]
    fn semantic_maps_instance_bytes() {
        // 2x1, stride 8: pixel0 instance 1 -> class 10, pixel1 background.
        let mut data = vec![0u8; 8];
        data[0] = 1;
        let out = semantic_from_ids(&data, 2, 1, 8, |id| if id == 1 { 10 } else { 0 });
        assert_eq!(out[2], 10);
        assert_eq!(out[4 + 2], 0);
    }

    #[test]
    fn static_class_matching_order() {
        assert_eq!(static_class_of("SM_Tree_Large"), classes::VEGETATION);
        assert_eq!(static_class_of("road_surface"), classes::ROAD);
        assert_eq!(static_class_of("Building_A"), classes::BUILDING);
        assert_eq!(static_class_of("bench_01"), classes::UNLABELED);
    }

    #[test]
    fn jpeg_encodes() {
        let px = vec![128u8; 16 * 16 * 3];
        let jpg = encode_jpeg(&px, 16, 16, 70).unwrap();
        assert!(jpg.len() > 2 && jpg[0] == 0xFF && jpg[1] == 0xD8);
    }
}
