// web-spike shaders: basic PBR (metallic-roughness, GGX) + directional sun,
// object-id pass for picking, tick-swatch pass for the WebCodecs exact-frame test.

struct Globals {
    view_proj: mat4x4<f32>,
    cam_pos: vec4<f32>,
    sun_dir: vec4<f32>,   // xyz: direction TOWARDS the sun, w: ambient factor
    sun_color: vec4<f32>, // rgb: radiance, w: unused
};
@group(0) @binding(0) var<uniform> G: Globals;

struct Draw {
    model: mat4x4<f32>,
    id_flags: vec4<u32>, // x: object id, y: bit0 = has tangents
};
@group(1) @binding(0) var<uniform> D: Draw;

struct MatU {
    base_color: vec4<f32>,
    mrna: vec4<f32>,  // x metallic, y roughness, z normal scale, w alpha cutoff
    flags: vec4<u32>, // x: bit0 baseColor tex, bit1 mr tex, bit2 normal tex, bit3 alpha mask
};
@group(2) @binding(0) var<uniform> M: MatU;
@group(2) @binding(1) var t_base: texture_2d<f32>;
@group(2) @binding(2) var t_mr: texture_2d<f32>;
@group(2) @binding(3) var t_nrm: texture_2d<f32>;
@group(2) @binding(4) var samp: sampler;

struct VsIn {
    @location(0) pos: vec3<f32>,
    @location(1) nrm: vec3<f32>,
    @location(2) tan: vec4<f32>,
    @location(3) uv: vec2<f32>,
};

struct VsOut {
    @builtin(position) clip: vec4<f32>,
    @location(0) wpos: vec3<f32>,
    @location(1) nrm: vec3<f32>,
    @location(2) tan: vec4<f32>,
    @location(3) uv: vec2<f32>,
};

@vertex
fn vs_main(v: VsIn) -> VsOut {
    var o: VsOut;
    let wp = D.model * vec4<f32>(v.pos, 1.0);
    o.clip = G.view_proj * wp;
    o.wpos = wp.xyz;
    // spike scenes use uniform-ish scales; inverse-transpose omitted deliberately
    o.nrm = normalize((D.model * vec4<f32>(v.nrm, 0.0)).xyz);
    o.tan = vec4<f32>(normalize((D.model * vec4<f32>(v.tan.xyz, 0.0)).xyz), v.tan.w);
    o.uv = v.uv;
    return o;
}

fn d_ggx(noh: f32, rough: f32) -> f32 {
    let a = rough * rough;
    let a2 = a * a;
    let d = noh * noh * (a2 - 1.0) + 1.0;
    return a2 / max(3.14159265 * d * d, 1e-6);
}

fn v_smith(nov: f32, nol: f32, rough: f32) -> f32 {
    let a = rough * rough;
    let gv = nol * sqrt(nov * nov * (1.0 - a) + a);
    let gl = nov * sqrt(nol * nol * (1.0 - a) + a);
    return 0.5 / max(gv + gl, 1e-6);
}

@fragment
fn fs_main(v: VsOut) -> @location(0) vec4<f32> {
    var base = M.base_color;
    if ((M.flags.x & 1u) != 0u) {
        base = base * textureSample(t_base, samp, v.uv);
    }
    if ((M.flags.x & 8u) != 0u && base.a < M.mrna.w) {
        discard;
    }
    var metallic = M.mrna.x;
    var rough = M.mrna.y;
    if ((M.flags.x & 2u) != 0u) {
        let mr = textureSample(t_mr, samp, v.uv);
        metallic = metallic * mr.b;
        rough = rough * mr.g;
    }
    rough = clamp(rough, 0.04, 1.0);

    var n = normalize(v.nrm);
    if ((M.flags.x & 4u) != 0u && (D.id_flags.y & 1u) != 0u) {
        let t = normalize(v.tan.xyz);
        let b = cross(n, t) * v.tan.w;
        var tn = textureSample(t_nrm, samp, v.uv).xyz * 2.0 - 1.0;
        tn = vec3<f32>(tn.xy * M.mrna.z, tn.z);
        n = normalize(mat3x3<f32>(t, b, n) * tn);
    }

    let l = normalize(G.sun_dir.xyz);
    let view = normalize(G.cam_pos.xyz - v.wpos);
    // flip normal for back faces of double-sided geometry
    if (dot(n, view) < 0.0) {
        n = -n;
    }
    let h = normalize(l + view);
    let nol = max(dot(n, l), 0.0);
    let nov = max(dot(n, view), 1e-4);
    let noh = max(dot(n, h), 0.0);
    let voh = max(dot(view, h), 0.0);

    let albedo = base.rgb;
    let f0 = mix(vec3<f32>(0.04), albedo, metallic);
    let fresnel = f0 + (vec3<f32>(1.0) - f0) * pow(1.0 - voh, 5.0);
    let spec = d_ggx(noh, rough) * v_smith(nov, nol, rough) * fresnel;
    let diffuse = albedo * (1.0 - metallic) / 3.14159265;

    var color = (diffuse + spec) * G.sun_color.rgb * nol;
    color = color + albedo * G.sun_dir.w; // flat ambient
    color = color / (color + vec3<f32>(1.0)); // reinhard; surface view is srgb
    return vec4<f32>(color, base.a);
}

// ---- object id pass (R32Uint target) ----

@vertex
fn vs_id(v: VsIn) -> @builtin(position) vec4<f32> {
    return G.view_proj * (D.model * vec4<f32>(v.pos, 1.0));
}

@fragment
fn fs_id() -> @location(0) u32 {
    return D.id_flags.x;
}

// ---- tick swatch (drawn with a small viewport into the main target) ----

struct SwatchU {
    color: vec4<f32>,
};
@group(0) @binding(0) var<uniform> SW: SwatchU;

@vertex
fn vs_swatch(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4<f32> {
    // fullscreen triangle; actual size limited by the viewport set on the pass
    let x = f32(i32(vi & 1u) * 4 - 1);
    let y = f32(i32(vi >> 1u) * 4 - 1);
    return vec4<f32>(x, y, 0.0, 1.0);
}

@fragment
fn fs_swatch() -> @location(0) vec4<f32> {
    return SW.color;
}
