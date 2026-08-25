// Road master material extension (simforge.road-detail/v1).
//
// Extends StandardMaterial (the authored GLB road material stays variant 0):
//   - blends up to two extra asphalt/concrete variants via a per-tile splat
//     mask sampled in world-XZ tile space (R = variant A, G = variant B),
//   - applies wheel-track/oil wear (splat B): albedo darken + roughness shift,
//   - layers a high-frequency detail normal,
//   - composites a pre-baked decal overlay (cracks/patches/oil, RGBA),
//   - marking mode (params.wear.w == 1): erodes lane markings from splat A —
//     chipped regions fade to asphalt gray without exposing clear color.
//
// Deterministic: a pure function of the bound textures and uniforms; no
// time, frame, or derivative-history inputs beyond standard mip selection
// (all road-detail textures are mipless, so LOD is constant).

#import bevy_pbr::{
    pbr_fragment::pbr_input_from_standard_material,
    pbr_functions::{apply_pbr_lighting, main_pass_post_lighting_processing},
    forward_io::{VertexOutput, FragmentOutput},
}

struct RoadDetailParams {
    // Tile-space mapping: uv = (world.xz - bounds_min) * bounds_inv_size.
    bounds_min: vec2<f32>,
    bounds_inv_size: vec2<f32>,
    // Repeats per meter for variant A / variant B / detail normal.
    tiling: vec3<f32>,
    // Detail-normal strength (0 disables the layer).
    detail_strength: f32,
    // x: wear albedo darken, y: wear roughness delta,
    // z: marking wear strength, w: mode (0 = road surface, 1 = lane marking).
    wear: vec4<f32>,
}

@group(#{MATERIAL_BIND_GROUP}) @binding(100) var<uniform> rd: RoadDetailParams;
// Tile-space masks share the clamp sampler bound with the splat image.
@group(#{MATERIAL_BIND_GROUP}) @binding(101) var rd_splat_t: texture_2d<f32>;
@group(#{MATERIAL_BIND_GROUP}) @binding(102) var rd_clamp_s: sampler;
@group(#{MATERIAL_BIND_GROUP}) @binding(103) var rd_decal_t: texture_2d<f32>;
// World-tiled variant textures share the repeat sampler bound with the
// detail-normal image.
@group(#{MATERIAL_BIND_GROUP}) @binding(104) var rd_var_a_color_t: texture_2d<f32>;
@group(#{MATERIAL_BIND_GROUP}) @binding(105) var rd_var_a_normal_t: texture_2d<f32>;
@group(#{MATERIAL_BIND_GROUP}) @binding(106) var rd_var_a_orm_t: texture_2d<f32>;
@group(#{MATERIAL_BIND_GROUP}) @binding(107) var rd_var_b_color_t: texture_2d<f32>;
@group(#{MATERIAL_BIND_GROUP}) @binding(108) var rd_var_b_normal_t: texture_2d<f32>;
@group(#{MATERIAL_BIND_GROUP}) @binding(109) var rd_var_b_orm_t: texture_2d<f32>;
@group(#{MATERIAL_BIND_GROUP}) @binding(110) var rd_detail_normal_t: texture_2d<f32>;
@group(#{MATERIAL_BIND_GROUP}) @binding(111) var rd_repeat_s: sampler;

// Deterministic 2D hash noise (same family as the film-grain hash13); used
// only for marking chip erosion, seeded purely by world position.
fn rd_hash2(p: vec2<f32>) -> f32 {
    var p3 = fract(vec3<f32>(p.xyx) * 0.1031);
    p3 = p3 + dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
}

// Bilinear value noise for coherent chips (not white noise).
fn rd_value_noise(p: vec2<f32>) -> f32 {
    let i = floor(p);
    let f = fract(p);
    let u = f * f * (3.0 - 2.0 * f);
    let a = rd_hash2(i);
    let b = rd_hash2(i + vec2<f32>(1.0, 0.0));
    let c = rd_hash2(i + vec2<f32>(0.0, 1.0));
    let d = rd_hash2(i + vec2<f32>(1.0, 1.0));
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

@fragment
fn fragment(
    in: VertexOutput,
    @builtin(front_facing) is_front: bool,
) -> FragmentOutput {
    // Full StandardMaterial resolve: authored base color / normal map /
    // roughness of the GLB road material (variant 0).
    var pbr_input = pbr_input_from_standard_material(in, is_front);

    let world_xz = in.world_position.xz;
    let tile_uv = clamp(
        (world_xz - rd.bounds_min) * rd.bounds_inv_size,
        vec2<f32>(0.0),
        vec2<f32>(1.0),
    );
    let splat = textureSample(rd_splat_t, rd_clamp_s, tile_uv);

    if (rd.wear.w < 0.5) {
        // ------------------------------ road surface -----------------------
        // Renormalized variant weights (base keeps the remainder).
        var w_a = splat.r;
        var w_b = splat.g;
        let w_sum = w_a + w_b;
        if (w_sum > 1.0) {
            w_a = w_a / w_sum;
            w_b = w_b / w_sum;
        }
        let w_base = 1.0 - w_a - w_b;

        let uv_a = world_xz * rd.tiling.x;
        let uv_b = world_xz * rd.tiling.y;
        let uv_d = world_xz * rd.tiling.z;

        let col_a = textureSample(rd_var_a_color_t, rd_repeat_s, uv_a);
        let col_b = textureSample(rd_var_b_color_t, rd_repeat_s, uv_b);
        let orm_a = textureSample(rd_var_a_orm_t, rd_repeat_s, uv_a);
        let orm_b = textureSample(rd_var_b_orm_t, rd_repeat_s, uv_b);
        let nrm_a = textureSample(rd_var_a_normal_t, rd_repeat_s, uv_a).xyz * 2.0 - 1.0;
        let nrm_b = textureSample(rd_var_b_normal_t, rd_repeat_s, uv_b).xyz * 2.0 - 1.0;
        let nrm_d = textureSample(rd_detail_normal_t, rd_repeat_s, uv_d).xyz * 2.0 - 1.0;

        var albedo = pbr_input.material.base_color.rgb * w_base
            + col_a.rgb * w_a
            + col_b.rgb * w_b;
        var rough = pbr_input.material.perceptual_roughness * w_base
            + orm_a.g * w_a
            + orm_b.g * w_b;
        var metallic = pbr_input.material.metallic * w_base
            + orm_a.b * w_a
            + orm_b.b * w_b;
        let occlusion = 1.0 * w_base + orm_a.r * w_a + orm_b.r * w_b;

        // Wear (splat B): oil/rubber darkening + wheel-track polish.
        let wear = splat.b;
        albedo = albedo * (1.0 - wear * rd.wear.x);
        rough = rough + wear * rd.wear.y;

        // Decal overlay (pre-baked cracks / patch outlines / oil blobs).
        let decal = textureSample(rd_decal_t, rd_clamp_s, tile_uv);
        albedo = mix(albedo, decal.rgb, decal.a);
        rough = mix(rough, 0.88, decal.a * 0.7);

        // Normal perturbation in the road-plane frame: world-XZ planar UVs
        // make tangent ~= +X and bitangent ~= +Z for near-horizontal roads.
        let n_offset = nrm_a.xy * w_a + nrm_b.xy * w_b
            + nrm_d.xy * rd.detail_strength * (1.0 - decal.a * 0.5);
        pbr_input.N = normalize(
            pbr_input.N + vec3<f32>(n_offset.x, 0.0, n_offset.y),
        );

        pbr_input.material.base_color = vec4<f32>(albedo, pbr_input.material.base_color.a);
        pbr_input.material.perceptual_roughness = clamp(rough, 0.045, 1.0);
        pbr_input.material.metallic = clamp(metallic, 0.0, 1.0);
        pbr_input.diffuse_occlusion = pbr_input.diffuse_occlusion * occlusion;
    } else {
        // ------------------------------ lane marking -----------------------
        // Erosion field (splat A) modulated by coherent chip noise. Keep the
        // marking primitive opaque: some source road meshes leave no asphalt
        // geometry beneath their marking strips, so fragment discard would
        // incorrectly expose the world clear color rather than road.
        let erosion = splat.a * rd.wear.z;
        let chip = rd_value_noise(world_xz * 7.0)
            * (0.65 + 0.35 * rd_value_noise(world_xz * 41.0));
        let chipped = smoothstep(chip - 0.08, chip + 0.08, erosion * 0.8);
        // Surviving paint weathers gradually; chipped regions become the
        // authored road's neutral asphalt gray.
        let weathered = smoothstep(0.0, 1.0, erosion * (0.55 + 0.45 * chip));
        let fade = max(weathered * 0.75, chipped);
        let worn_paint = mix(
            pbr_input.material.base_color.rgb,
            vec3<f32>(0.16, 0.155, 0.15),
            fade,
        );
        pbr_input.material.base_color =
            vec4<f32>(worn_paint, pbr_input.material.base_color.a);
        pbr_input.material.perceptual_roughness = clamp(
            pbr_input.material.perceptual_roughness + fade * 0.35,
            0.045,
            1.0,
        );
    }

    var out: FragmentOutput;
    out.color = apply_pbr_lighting(pbr_input);
    out.color = main_pass_post_lighting_processing(pbr_input, out.color);
    return out;
}
