// Film grain: deterministic monochrome grain, seeded by pixel coords and the
// global frame counter (no wall-clock time — hash-stable captures).
//
// Bind group layout comes from FullscreenMaterialPlugin:
//   @group(0) @binding(0) source texture
//   @group(0) @binding(1) source sampler
//   @group(0) @binding(2) uniform<FilmGrain>

#import bevy_core_pipeline::fullscreen_vertex_shader::FullscreenVertexOutput

struct FilmGrainSettings {
    intensity: f32,
    frame: f32,
    _pad_a: f32,
    _pad_b: f32,
}

@group(0) @binding(0) var source_texture: texture_2d<f32>;
@group(0) @binding(1) var source_sampler: sampler;
@group(0) @binding(2) var<uniform> settings: FilmGrainSettings;

// 3D hash (Dave Hoskins style), fully deterministic for integer inputs.
fn hash13(p_in: vec3<f32>) -> f32 {
    var p = fract(p_in * vec3<f32>(0.1031, 0.1030, 0.0973));
    p += dot(p, p.yzx + vec3<f32>(33.33));
    return fract((p.x + p.y) * p.z);
}

@fragment
fn fragment(in: FullscreenVertexOutput) -> @location(0) vec4<f32> {
    let color = textureSample(source_texture, source_sampler, in.uv).rgb;
    let dims = vec2<f32>(textureDimensions(source_texture).xy);
    let px = floor(in.uv * dims);
    let n = hash13(vec3<f32>(px, settings.frame));

    // Luma-weighted amplitude: strongest in midtones, softer in shadows and
    // highlights — approximates photographic grain response.
    let luma = dot(color, vec3<f32>(0.2126, 0.7152, 0.0722));
    let weight = mix(0.65, 1.0, smoothstep(0.0, 0.5, luma)) * mix(1.0, 0.55, smoothstep(0.6, 1.0, luma));
    let grain = (n - 0.5) * 2.0 * settings.intensity * weight;

    return vec4<f32>(color + vec3<f32>(grain), 1.0);
}
