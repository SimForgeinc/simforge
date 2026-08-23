// Motion-vector G-buffer: NDC velocity per pixel from bevy's per-instance
// previous-transform buffer (mesh.previous_world_from_local), so the pass is
// exact for rigid actor motion without per-actor uniform plumbing.
#import bevy_render::view::View
#import bevy_pbr::mesh_types::Mesh
#import bevy_render::maths::affine3_to_square

@group(0) @binding(0) var<uniform> view: View;
@group(1) @binding(0) var<uniform> mesh: Mesh;

struct VertexOutput {
    @builtin(position) clip_position: vec4<f32>,
    @location(0) velocity: vec2<f32>,
};

@vertex
fn vertex(@builtin(vertex_index) vertex_index: u32, @location(0) position: vec3<f32>) -> VertexOutput {
    let world_from_local = affine3_to_square(mesh.world_from_local);
    let previous_world_from_local = affine3_to_square(mesh.previous_world_from_local);
    let clip_current = view.clip_from_world * (world_from_local * vec4<f32>(position, 1.0));
    let clip_previous = view.clip_from_world * (previous_world_from_local * vec4<f32>(position, 1.0));
    var out: VertexOutput;
    out.clip_position = clip_current;
    out.velocity = (clip_current.xy / clip_current.w) - (clip_previous.xy / clip_previous.w);
    return out;
}

@fragment
fn fragment(in: VertexOutput) -> @location(0) vec4<f32> {
    // Rg16Float target: xy stored, zw unused.
    return vec4<f32>(in.velocity, 0.0, 1.0);
}
