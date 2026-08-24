import type { IUniform, Material, Mesh, Object3D, Texture, Vector4 } from 'three';
import { Vector4 as Vec4 } from 'three';

export interface ShadowPatchOptions {
  atlas: Texture;
  /** (originX, originZ, 1/spanX, 1/spanZ). */
  rect: Vector4;
  /** 0..1 overall term strength. */
  strength: number;
  /** How much of the term vertical surfaces receive (horizontal always get 1). */
  wallWeight: number;
  /** World Y where the term starts fading out, and where it is fully gone. */
  fadeStartY: number;
  fadeEndY: number;
  /** Render the shadow term itself instead of shaded colour (projection QA). */
  debug?: boolean;
}

interface PatchUniforms {
  uShadowMap: IUniform<Texture>;
  uShadowRect: IUniform<Vector4>;
  uShadowTerm: IUniform<Vector4>;
}

/**
 * Region where the real-time sun shadow supersedes the baked term:
 * (centreX, centreZ, suppressStart, suppressEnd).
 *
 * Exactly one real-time shadow region exists per viewer, so every patched
 * material shares this uniform object. That is what lets the region follow the
 * camera without the viewer tracking — and having to forget — each streamed
 * material as tiles come and go.
 *
 * The default radii are negative, so `smoothstep` returns 1 for every real
 * distance and the baked term applies everywhere until a caller opts in.
 */
const sharedSuppression: IUniform<Vector4> = { value: new Vec4(0, 0, -2, -1) };

const VERT_DECL = /* glsl */ `
varying vec3 vCityWorldPos;
`;

const VERT_BODY = /* glsl */ `
	vec4 cityWorldPos4 = vec4( transformed, 1.0 );
	#ifdef USE_INSTANCING
		cityWorldPos4 = instanceMatrix * cityWorldPos4;
	#endif
	vCityWorldPos = ( modelMatrix * cityWorldPos4 ).xyz;
`;

const FRAG_DECL = /* glsl */ `
varying vec3 vCityWorldPos;
uniform sampler2D uShadowMap;
uniform vec4 uShadowRect;
uniform vec4 uShadowTerm; // strength, wallWeight, fadeStartY, fadeEndY
uniform vec4 uShadowNear; // centreX, centreZ, suppressStart, suppressEnd
`;

/**
 * Baked-shadow application.
 *
 * The lightmap is a top-down ground bake, so it is projected planar from world
 * XZ (the tiles only carry TEXCOORD_0, which is the authored material UV).
 * Two guards keep the planar projection honest:
 *  - vertical surfaces get only `wallWeight` of the term, so a wall does not
 *    inherit a hard shadow edge that belongs to the floor at its base;
 *  - the term fades out with world height, so rooftops and the electric towers
 *    in the road layer stay lit.
 * Indirect light keeps 35% of the term (an occluded patch of street still sees
 * plenty of sky), which is what stops shadowed ground from crushing to black.
 *
 * Where the real-time sun shadow covers the ground the term is suppressed, so
 * the two shadow systems never multiply against each other.
 */
export function patchMaterialWithBakedShadow(material: Material, opts: ShadowPatchOptions): void {
  const uniforms: PatchUniforms = {
    uShadowMap: { value: opts.atlas },
    uShadowRect: { value: opts.rect },
    uShadowTerm: { value: new Vec4(opts.strength, opts.wallWeight, opts.fadeStartY, opts.fadeEndY) },
  };
  material.userData.cityShadow = uniforms;

  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms, { uShadowNear: sharedSuppression });
    shader.vertexShader = VERT_DECL + shader.vertexShader.replace(
      '#include <project_vertex>',
      `#include <project_vertex>\n${VERT_BODY}`,
    );
    shader.fragmentShader = FRAG_DECL + shader.fragmentShader.replace(
      '#include <aomap_fragment>',
      /* glsl */ `
	float cityShadow = 1.0;
	vec2 cityShadowUv = ( vCityWorldPos.xz - uShadowRect.xy ) * uShadowRect.zw;
	if ( uShadowTerm.x > 0.0 && all( greaterThanEqual( cityShadowUv, vec2( 0.0 ) ) ) && all( lessThanEqual( cityShadowUv, vec2( 1.0 ) ) ) ) {
		float cityShadowRaw = texture2D( uShadowMap, cityShadowUv ).r;
		vec3 cityUpView = normalize( ( viewMatrix * vec4( 0.0, 1.0, 0.0, 0.0 ) ).xyz );
		float cityFacing = mix( uShadowTerm.y, 1.0, smoothstep( 0.0, 0.6, abs( dot( normalize( normal ), cityUpView ) ) ) );
		float cityHeight = 1.0 - smoothstep( uShadowTerm.z, uShadowTerm.w, vCityWorldPos.y );
		float cityBaked = smoothstep( uShadowNear.z, uShadowNear.w, distance( vCityWorldPos.xz, uShadowNear.xy ) );
		cityShadow = mix( 1.0, cityShadowRaw, clamp( uShadowTerm.x * cityBaked * cityFacing * cityHeight, 0.0, 1.0 ) );
		reflectedLight.directDiffuse *= cityShadow;
		reflectedLight.directSpecular *= cityShadow;
		float cityIndirect = mix( 1.0, cityShadow, 0.35 );
		reflectedLight.indirectDiffuse *= cityIndirect;
		reflectedLight.indirectSpecular *= cityIndirect;
	}
	#include <aomap_fragment>`,
    );
    if (opts.debug) {
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <opaque_fragment>',
        '\toutgoingLight = vec3( cityShadow );\n\t#include <opaque_fragment>',
      );
    }
  };
  // All patched materials compile to the same program; without this every
  // material clone would get its own program (three keys the cache on the
  // stringified onBeforeCompile, which is shared here, but be explicit).
  material.customProgramCacheKey = () => (opts.debug ? 'city-shadow-debug' : 'city-baked-shadow-v2');
  material.needsUpdate = true;
}

/**
 * Uniform block this module attached to `material`, or `undefined` when the
 * material was never patched.
 *
 * `Material.userData` is typed `any` by three, so the read is narrowed here
 * once instead of at each call site.
 */
function patchedUniforms(material: Material): PatchUniforms | undefined {
  const userData: unknown = material.userData;
  if (!userData || typeof userData !== 'object' || !('cityShadow' in userData)) return undefined;
  // Written only by `patchMaterialWithBakedShadow` a few lines above.
  const uniforms = userData.cityShadow as PatchUniforms | undefined;
  return uniforms;
}

export function setShadowStrength(material: Material, strength: number): void {
  const uniforms = patchedUniforms(material);
  if (uniforms) uniforms.uShadowTerm.value.x = strength;
}

/**
 * Moves the region where the real-time shadow supersedes the bake.
 *
 * Called as the camera drifts, so it writes the shared uniform in place; no
 * material is touched and nothing recompiles.
 */
export function setBakedSuppression(
  center: { x: number; z: number },
  start: number,
  end: number,
): void {
  sharedSuppression.value.set(center.x, center.z, start, end);
}

/** Current suppression region, for tests and diagnostics. */
export function bakedSuppression(): { x: number; z: number; start: number; end: number } {
  const v = sharedSuppression.value;
  return { x: v.x, z: v.y, start: v.z, end: v.w };
}

/**
 * Applies the patch to every unique material under `root`.
 *
 * Materials come straight out of GLTFLoader and are owned by exactly one
 * streamed asset, so they are patched in place rather than cloned.
 */
export function patchTree(root: Object3D, opts: ShadowPatchOptions): Material[] {
  const patched: Material[] = [];
  const seen = new Set<Material>();
  root.traverse((obj) => {
    const mesh = obj as Mesh;
    if (!(mesh as unknown as { isMesh?: boolean }).isMesh) return;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const mat of mats) {
      if (!mat || seen.has(mat)) continue;
      seen.add(mat);
      patchMaterialWithBakedShadow(mat, opts);
      patched.push(mat);
    }
  });
  return patched;
}
