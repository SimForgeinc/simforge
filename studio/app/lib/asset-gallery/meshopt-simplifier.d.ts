/**
 * three ships the meshopt simplifier as plain WASM-backed JS with no types.
 *
 * Only the surface the gallery importer uses is declared, so a wrong argument
 * order or a missed `ready` await is still a compile error rather than `any`.
 */
declare module "three/examples/jsm/libs/meshopt_simplifier.module.js" {
  export const MeshoptSimplifier: {
    readonly ready: Promise<void>;
    /** Returns the simplified index buffer and the resulting error. */
    simplify(
      indices: Uint32Array,
      vertexPositions: Float32Array,
      vertexPositionStride: number,
      targetIndexCount: number,
      targetError: number,
      flags?: readonly ("LockBorder" | "Sparse" | "ErrorAbsolute" | "Prune")[],
    ): [Uint32Array, number];
  };
}
