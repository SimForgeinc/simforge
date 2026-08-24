import {
  Color,
  Mesh,
  type BufferGeometry,
  type Material,
  type Object3D,
  type WebGLProgramParametersWithUniforms,
} from 'three';

/** A visual-only surface treatment. It never changes map geometry or transforms. */
export type SurfaceMaterialProfile = 'original' | 'enhanced' | 'presentation';
export type SurfaceClass = 'asphalt' | 'grass' | 'concrete' | 'curb' | 'marking' | 'unknown';
export type SurfaceLayer = 'road' | 'city' | 'vegetation';

export interface SurfaceWeatherAppearance {
  wetness: number;
  snowCoverage: number;
  /** Settled depth in metres; omitted preserves legacy visual-only snow. */
  snowDepthM?: number;
  /** 0 is loose fresh snow; 1 is compacted snow. */
  snowCompaction?: number;
}

export interface MaterialPackProvenance {
  id: string;
  version: string;
  author: string;
  license: string;
  source: string;
  externalAssets: readonly string[];
}

export interface MaterialPack {
  provenance: MaterialPackProvenance;
  classes: Readonly<Record<Exclude<SurfaceClass, 'marking' | 'unknown'>, {
    tint: number;
    tintMix: number;
    roughness: number;
    metresPerCell: number;
    variation: number;
  }>>;
}

/**
 * The built-in pack is authored as code and has no image dependencies. Its
 * world-space procedural detail is physically scaled in metres and cannot swim
 * when a tile LOD or camera changes.
 */
export const BUILTIN_SURFACE_MATERIAL_PACK: MaterialPack = {
  provenance: {
    id: 'simforge-procedural-surfaces',
    version: '1.0.0',
    author: 'SimForge',
    license: 'Apache-2.0',
    source: 'packages/viewer/src/surface-materials.ts',
    externalAssets: [],
  },
  classes: {
    asphalt: { tint: 0x34383b, tintMix: 0.18, roughness: 0.96, metresPerCell: 0.42, variation: 0.075 },
    grass: { tint: 0x557846, tintMix: 0.20, roughness: 0.99, metresPerCell: 0.24, variation: 0.16 },
    concrete: { tint: 0xb7b3a8, tintMix: 0.12, roughness: 0.91, metresPerCell: 0.72, variation: 0.055 },
    curb: { tint: 0xc3c0b7, tintMix: 0.15, roughness: 0.93, metresPerCell: 0.36, variation: 0.045 },
  },
};

export interface SurfaceIdentity {
  objectPath: string;
  meshName: string;
  materialName: string;
  geometryDigest: string;
  layer: SurfaceLayer;
}

export interface SurfaceClassification {
  kind: SurfaceClass;
  identity: SurfaceIdentity;
  reason: string;
}

export interface SurfaceMaterialReport {
  profile: SurfaceMaterialProfile;
  registeredMaterials: number;
  enhancedMaterials: number;
  preservedMarkings: number;
  unknownMaterials: number;
  conflictingMaterials: number;
  byClass: Record<SurfaceClass, number>;
  unknownExamples: string[];
  lastApplyMs: number;
  shaderVariants: number;
  pack: MaterialPackProvenance;
}

const MARKING = /marking|lane[_ -]?mark|road[_ -]?line|crosswalk|handicap|utility|crack|oilpath|sand1.*mark|brick1.*mark/i;
const CURB = /curb|gutter/i;
const GRASS = /grass|turf|lawn|meadow/i;
const CONCRETE = /sidewalk|concrete|cement|pavement|footpath/i;
const ASPHALT = /asphalt|roads?_road|road_layer|road surface|tarmac/i;

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function pathFor(object: Object3D): string {
  const parts: string[] = [];
  let current: Object3D | null = object;
  while (current) {
    if (current.name) parts.push(current.name);
    current = current.parent;
  }
  return parts.reverse().join('/');
}

function q(value: number | undefined): string {
  return Number.isFinite(value) ? Number(value).toFixed(3) : '-';
}

function fnv1a(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/** Stable across GLTF parses: it deliberately excludes runtime UUIDs. */
export function geometryDigest(geometry: BufferGeometry): string {
  if (!geometry.boundingBox) geometry.computeBoundingBox();
  const box = geometry.boundingBox;
  const attributes = Object.entries(geometry.attributes)
    .map(([name, attribute]) => `${name}:${attribute.itemSize}:${attribute.count}`)
    .sort()
    .join('|');
  const signature = [
    geometry.index?.count ?? 0,
    attributes,
    q(box?.min.x), q(box?.min.y), q(box?.min.z),
    q(box?.max.x), q(box?.max.y), q(box?.max.z),
  ].join(';');
  return fnv1a(signature);
}

export function classifySurface(mesh: Mesh, material: Material, layer: SurfaceLayer): SurfaceClassification {
  const identity: SurfaceIdentity = {
    objectPath: pathFor(mesh),
    meshName: mesh.name,
    materialName: material.name,
    geometryDigest: geometryDigest(mesh.geometry),
    layer,
  };
  const haystack = normalize(`${identity.objectPath} ${identity.meshName} ${identity.materialName}`);
  // Markings win every ambiguity and are explicitly preserved.
  if (MARKING.test(haystack)) return { kind: 'marking', identity, reason: 'semantic marking identity' };
  if (CURB.test(haystack)) return { kind: 'curb', identity, reason: 'semantic curb/gutter identity' };
  if (GRASS.test(haystack)) return { kind: 'grass', identity, reason: 'semantic grass identity' };
  if (CONCRETE.test(haystack)) return { kind: 'concrete', identity, reason: 'semantic sidewalk/concrete identity' };
  if (ASPHALT.test(haystack)) return { kind: 'asphalt', identity, reason: 'semantic road/asphalt identity' };
  return { kind: 'unknown', identity, reason: 'no conservative semantic match' };
}

type Shader = WebGLProgramParametersWithUniforms;
type CompilableMaterial = Material & {
  color?: Color;
  roughness?: number;
  metalness?: number;
};

interface MaterialRecord {
  material: CompilableMaterial;
  classification: SurfaceClassification;
  conflicts: Set<SurfaceClass>;
  originalColor: Color | null;
  originalRoughness: number | undefined;
  originalMetalness: number | undefined;
  originalOnBeforeCompile: Material['onBeforeCompile'];
  originalProgramKey: Material['customProgramCacheKey'];
  wetnessUniform: { value: number };
  snowCoverageUniform: { value: number };
  snowDepthUniform: { value: number };
  snowCompactionUniform: { value: number };
  snowMarkingRetentionUniform: { value: number };
  snowDisplacementEnabledUniform: { value: number };
  refCount: number;
}

const SURFACE_VERTEX_DECL = /* glsl */ `\nvarying vec3 vSurfaceWorldPos;\n`;
const SNOW_NOISE_FUNCTIONS = /* glsl */ `
float surfaceSnowHash( vec2 p ) {
\tvec3 p3 = fract( vec3( p.xyx ) * 0.1031 );
\tp3 += dot( p3, p3.yzx + 33.33 );
\treturn fract( ( p3.x + p3.y ) * p3.z );
}
float surfaceSnowNoise( vec2 p ) {
\tvec2 cell = floor( p ); vec2 local = fract( p );
\tlocal = local * local * ( 3.0 - 2.0 * local );
\treturn mix( mix( surfaceSnowHash( cell ), surfaceSnowHash( cell + vec2( 1.0, 0.0 ) ), local.x ), mix( surfaceSnowHash( cell + vec2( 0.0, 1.0 ) ), surfaceSnowHash( cell + vec2( 1.0, 1.0 ) ), local.x ), local.y );
}
float surfaceSnowHeightBreakup( vec2 p ) {
\treturn surfaceSnowNoise( p * 0.18 ) * 0.52 + surfaceSnowNoise( p * 0.62 + 17.0 ) * 0.31 + surfaceSnowNoise( p * 2.1 + 41.0 ) * 0.17;
}
`;
const SNOW_VERTEX_DECL = /* glsl */ `
uniform float surfaceSnowCoverage;
uniform float surfaceSnowDepthM;
uniform float surfaceSnowCompaction;
uniform float surfaceSnowDisplacementEnabled;
varying float vSurfaceSnowHeight;
varying float vSurfaceSnowVertexEligible;
${SNOW_NOISE_FUNCTIONS}`;
const SNOW_FRAGMENT_DECL = /* glsl */ `
varying float vSurfaceSnowHeight;
varying float vSurfaceSnowVertexEligible;
uniform float surfaceSnowCoverage;
uniform float surfaceSnowCompaction;
uniform float surfaceSnowMarkingRetention;
${SNOW_NOISE_FUNCTIONS}`;
const SURFACE_VERTEX_BODY = /* glsl */ `
\tvec4 surfaceWorldPosition = vec4( transformed, 1.0 );
\t#ifdef USE_INSTANCING
\t\tsurfaceWorldPosition = instanceMatrix * surfaceWorldPosition;
\t#endif
\tvSurfaceWorldPos = ( modelMatrix * surfaceWorldPosition ).xyz;
`;
const SURFACE_FRAGMENT_DECL = /* glsl */ `
varying vec3 vSurfaceWorldPos;
float surfaceHash( vec2 p );
float surfaceSmoothNoise( vec2 p ) {
\tvec2 cell = floor( p );
\tvec2 local = fract( p );
\tlocal = local * local * ( 3.0 - 2.0 * local );
\treturn mix(
\t\tmix( surfaceHash( cell ), surfaceHash( cell + vec2( 1.0, 0.0 ) ), local.x ),
\t\tmix( surfaceHash( cell + vec2( 0.0, 1.0 ) ), surfaceHash( cell + vec2( 1.0, 1.0 ) ), local.x ),
\t\tlocal.y
\t);
}
float surfaceHash( vec2 p ) {
\tvec3 p3 = fract( vec3( p.xyx ) * 0.1031 );
\tp3 += dot( p3, p3.yzx + 33.33 );
\treturn fract( ( p3.x + p3.y ) * p3.z );
}
`;

interface ProceduralSurfaceShaderOptions {
  cellSize: number;
  variation: number;
  presentation: boolean;
}

interface SnowSurfaceShaderOptions {
  coverageUniform: { value: number };
  depthUniform: { value: number };
  compactionUniform: { value: number };
  markingRetentionUniform: { value: number };
  displacementEnabledUniform: { value: number };
}

interface WetSurfaceShaderOptions {
  wetnessUniform: { value: number };
}

function injectSurfaceAppearance(
  shader: Shader,
  procedural: ProceduralSurfaceShaderOptions | null,
  snow: SnowSurfaceShaderOptions | null,
  wet: WetSurfaceShaderOptions | null,
): void {
  let vertexPrefix = SURFACE_VERTEX_DECL;
  if (snow) {
    shader.uniforms.surfaceSnowCoverage = snow.coverageUniform;
    shader.uniforms.surfaceSnowDepthM = snow.depthUniform;
    shader.uniforms.surfaceSnowCompaction = snow.compactionUniform;
    shader.uniforms.surfaceSnowDisplacementEnabled = snow.displacementEnabledUniform;
    vertexPrefix += SNOW_VERTEX_DECL;
    shader.vertexShader = shader.vertexShader.replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
\t// A receiver shell owns deep drifts. This bounded contact coat prevents z-fighting.
\tvec3 surfaceSnowObjectNormal = normalize( objectNormal );
\tvec3 surfaceSnowWorldNormalRaw = mat3( modelMatrix ) * surfaceSnowObjectNormal;
\t#ifdef USE_INSTANCING
\t\tsurfaceSnowWorldNormalRaw = mat3( modelMatrix ) * mat3( instanceMatrix ) * surfaceSnowObjectNormal;
\t#endif
\tfloat surfaceSnowWorldScale = max( length( surfaceSnowWorldNormalRaw ), 1e-4 );
\tvec3 surfaceSnowWorldNormal = surfaceSnowWorldNormalRaw / surfaceSnowWorldScale;
\tfloat surfaceSnowTopFacing = smoothstep( 0.58, 0.90, surfaceSnowWorldNormal.y );
\tvec4 surfaceSnowBaseWorldPosition = vec4( transformed, 1.0 );
\t#ifdef USE_INSTANCING
\t\tsurfaceSnowBaseWorldPosition = instanceMatrix * surfaceSnowBaseWorldPosition;
\t#endif
\tvec2 surfaceSnowBaseXZ = ( modelMatrix * surfaceSnowBaseWorldPosition ).xz;
\tfloat surfaceSnowSettling = mix( 0.48, 1.0, surfaceSnowCompaction );
\tvSurfaceSnowVertexEligible = surfaceSnowTopFacing * surfaceSnowDisplacementEnabled;
\tvSurfaceSnowHeight = min( surfaceSnowDepthM, 0.002 ) * surfaceSnowCoverage * surfaceSnowSettling * mix( 0.66, 1.16, surfaceSnowHeightBreakup( surfaceSnowBaseXZ ) ) * vSurfaceSnowVertexEligible;
\ttransformed += surfaceSnowObjectNormal * ( vSurfaceSnowHeight / surfaceSnowWorldScale );`,
    );
  }
  shader.vertexShader = vertexPrefix + shader.vertexShader.replace(
    '#include <project_vertex>',
    `#include <project_vertex>\n${SURFACE_VERTEX_BODY}`,
  );

  let surfaceColor = '';
  if (procedural) {
    const scale = Math.max(0.01, procedural.cellSize).toFixed(4);
    const strength = (procedural.variation * (procedural.presentation ? 1.35 : 1)).toFixed(4);
    surfaceColor += /* glsl */ `
	vec2 surfaceCell = floor( vSurfaceWorldPos.xz / ${scale} );
	float surfaceGrain = surfaceHash( surfaceCell ) - 0.5;
	float surfaceMacro = surfaceHash( floor( vSurfaceWorldPos.xz / (${scale} * 11.0) ) ) - 0.5;
	diffuseColor.rgb *= 1.0 + surfaceGrain * ${strength} + surfaceMacro * ${strength} * 0.55;`;
  }
  if (wet) {
    shader.uniforms.surfaceWetness = wet.wetnessUniform;
    surfaceColor += /* glsl */ `
	// World-space film and puddles keep wet surfaces from reading as a uniform mirror.
	vec3 surfaceWetWorldDx = dFdx( vSurfaceWorldPos );
	vec3 surfaceWetWorldDy = dFdy( vSurfaceWorldPos );
	vec3 surfaceWetWorldNormal = cross( surfaceWetWorldDx, surfaceWetWorldDy );
	surfaceWetWorldNormal *= inversesqrt( max( dot( surfaceWetWorldNormal, surfaceWetWorldNormal ), 1e-8 ) );
	float surfaceWetPuddleSlope = smoothstep( 0.50, 0.92, max( surfaceWetWorldNormal.y, 0.0 ) );
	float surfaceWetFine = surfaceHash( floor( vSurfaceWorldPos.xz * 8.0 ) );
	float surfaceWetBroad = surfaceSmoothNoise( vSurfaceWorldPos.xz * 0.23 + 57.0 );
	float surfaceWetFilm = surfaceWetness * mix( 0.18, 0.58, surfaceWetFine );
	float surfaceWetPuddle = surfaceWetness * smoothstep( 0.70, 0.93, surfaceWetBroad ) * smoothstep( 0.28, 0.86, surfaceWetness ) * surfaceWetPuddleSlope;
	float surfaceWetAmount = clamp( surfaceWetFilm + surfaceWetPuddle * 0.62, 0.0, 1.0 );
	float surfaceWetRipple = ( surfaceSmoothNoise( vSurfaceWorldPos.xz * 8.5 + 101.0 ) - 0.5 ) * ( surfaceWetFilm * surfaceWetPuddleSlope + surfaceWetPuddle );
	diffuseColor.rgb *= 1.0 - surfaceWetAmount * 0.16;`;
  }
  if (snow) {
    shader.uniforms.surfaceSnowMarkingRetention = snow.markingRetentionUniform;
    surfaceColor += /* glsl */ `
	vec3 surfaceSnowDx = dFdx( vSurfaceWorldPos );
	vec3 surfaceSnowDy = dFdy( vSurfaceWorldPos );
	vec3 surfaceSnowCross = cross( surfaceSnowDx, surfaceSnowDy );
	vec3 surfaceSnowWorldNormal = surfaceSnowCross * inversesqrt( max( dot( surfaceSnowCross, surfaceSnowCross ), 1e-8 ) );
	float surfaceSnowUp = max( surfaceSnowWorldNormal.y, 0.0 );
	float surfaceSnowSlope = smoothstep( 0.28, 0.86, surfaceSnowUp );
	float surfaceSnowFine = surfaceSnowNoise( vSurfaceWorldPos.xz * 2.7 );
	float surfaceSnowBroad = surfaceSnowNoise( vSurfaceWorldPos.xz * 0.27 + 13.0 );
	float surfaceSnowDrape = surfaceSnowNoise( vSurfaceWorldPos.xz * 0.68 + 29.0 );
	float surfaceSnowBreakup = clamp( surfaceSnowFine * 0.24 + surfaceSnowBroad * 0.42 + surfaceSnowDrape * 0.20 + surfaceSnowSlope * 0.30, 0.0, 1.0 );
	float surfaceSnowEffectiveCoverage = mix( surfaceSnowCoverage, pow( surfaceSnowCoverage, 1.7 ), surfaceSnowMarkingRetention );
	float surfaceSnowThreshold = 1.0 - surfaceSnowEffectiveCoverage;
	float surfaceSnowMask = smoothstep( surfaceSnowThreshold - 0.14, surfaceSnowThreshold + 0.08, surfaceSnowBreakup ) * surfaceSnowSlope;
	float surfaceSnowGrain = surfaceHash( floor( vSurfaceWorldPos.xz * 36.0 ) ) - 0.5;
	vec3 surfaceSnowColor = mix( vec3( 0.78, 0.84, 0.88 ), vec3( 0.96, 0.975, 0.99 ), surfaceSnowCompaction );
	surfaceSnowColor *= 1.0 + surfaceSnowGrain * mix( 0.10, 0.026, surfaceSnowCompaction );
	diffuseColor.rgb = mix( diffuseColor.rgb, surfaceSnowColor, surfaceSnowMask * 0.90 );`;
  }

  const snowDeclarations = snow ? SNOW_FRAGMENT_DECL : '';
  const wetDeclarations = wet ? '\nuniform float surfaceWetness;\n' : '';
  shader.fragmentShader = SURFACE_FRAGMENT_DECL + snowDeclarations + wetDeclarations + shader.fragmentShader.replace(
    '#include <map_fragment>',
    `#include <map_fragment>${surfaceColor}`,
  );
  if (snow || wet) {
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <roughnessmap_fragment>',
      /* glsl */ `#include <roughnessmap_fragment>
${wet ? `
	roughnessFactor = mix( roughnessFactor, 0.38, surfaceWetFilm * 0.64 );
	roughnessFactor = mix( roughnessFactor, 0.12, surfaceWetPuddle * 0.78 );` : ''}${snow ? `
	// Fresh snow is granular; compacted snow is denser and a little smoother.
	float surfaceSnowRoughness = mix( 0.985, 0.89, surfaceSnowCompaction );
	roughnessFactor = mix( roughnessFactor, surfaceSnowRoughness, surfaceSnowMask );` : ''}`,
    );
  }
  if (snow || wet) {
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <normal_fragment_maps>',
      /* glsl */ `#include <normal_fragment_maps>
${wet ? `
	// Deterministic water-film height becomes a subtle lit-normal ripple.
	vec3 surfaceWetViewDx = dFdx( vViewPosition );
	vec3 surfaceWetViewDy = dFdy( vViewPosition );
	vec3 surfaceWetGradient = surfaceWetViewDx * ( dFdx( surfaceWetRipple ) * 0.0018 / max( dot( surfaceWetViewDx, surfaceWetViewDx ), 1e-5 ) )
		+ surfaceWetViewDy * ( dFdy( surfaceWetRipple ) * 0.0018 / max( dot( surfaceWetViewDy, surfaceWetViewDy ), 1e-5 ) );
	normal = normalize( normal - surfaceWetGradient );` : ''}${snow ? `
	// The multi-scale snow height field also perturbs the lighting normal.
	float surfaceSnowNormalHeight = ( vSurfaceSnowHeight + ( surfaceSnowHeightBreakup( vSurfaceWorldPos.xz ) - 0.5 ) * mix( 0.006, 0.0015, surfaceSnowCompaction ) ) * surfaceSnowMask * vSurfaceSnowVertexEligible;
	vec3 surfaceSnowViewDx = dFdx( vViewPosition );
	vec3 surfaceSnowViewDy = dFdy( vViewPosition );
	vec3 surfaceSnowGradient = surfaceSnowViewDx * ( dFdx( surfaceSnowNormalHeight ) / max( dot( surfaceSnowViewDx, surfaceSnowViewDx ), 1e-5 ) )
		+ surfaceSnowViewDy * ( dFdy( surfaceSnowNormalHeight ) / max( dot( surfaceSnowViewDy, surfaceSnowViewDy ), 1e-5 ) );
	normal = normalize( normal - surfaceSnowGradient );` : ''}`,
    );
  }
}

function canEnhance(material: CompilableMaterial): boolean {
  return Boolean(material.color?.isColor) && typeof material.roughness === 'number';
}

function canReceiveSnow(material: CompilableMaterial): boolean {
  return Boolean(material.color?.isColor);
}

function clampUnit(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

const WET_SURFACE_RESPONSE: Readonly<Record<SurfaceClass, { darkening: number; roughnessReduction: number }>> = {
  asphalt: { darkening: 0.42, roughnessReduction: 0.60 },
  concrete: { darkening: 0.34, roughnessReduction: 0.52 },
  curb: { darkening: 0.32, roughnessReduction: 0.50 },
  marking: { darkening: 0.27, roughnessReduction: 0.55 },
  grass: { darkening: 0.18, roughnessReduction: 0.16 },
  unknown: { darkening: 0.20, roughnessReduction: 0.24 },
};

export class SurfaceMaterialRegistry {
  private readonly records = new Map<Material, MaterialRecord>();
  private readonly treeMaterials = new WeakMap<Object3D, Material[]>();
  private profile: SurfaceMaterialProfile = 'original';
  private weatherAppearance: SurfaceWeatherAppearance = { wetness: 0, snowCoverage: 0 };
  private lastApplyMs = 0;

  registerTree(root: Object3D, layer: SurfaceLayer): void {
    const start = performance.now();
    const touched: Material[] = [];
    const changed = new Set<MaterialRecord>();
    root.traverse((object) => {
      const mesh = object as Mesh;
      if (!mesh.isMesh) return;
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const material of materials) {
        if (!material) continue;
        touched.push(material);
        const classification = classifySurface(mesh, material, layer);
        const existing = this.records.get(material);
        if (existing) {
          existing.refCount++;
          if (existing.classification.kind !== classification.kind) {
            existing.conflicts.add(classification.kind);
            changed.add(existing);
          }
          continue;
        }
        const compilable = material as CompilableMaterial;
        const record: MaterialRecord = {
          material: compilable,
          classification,
          conflicts: new Set(),
          originalColor: compilable.color?.clone() ?? null,
          originalRoughness: compilable.roughness,
          originalMetalness: compilable.metalness,
          originalOnBeforeCompile: material.onBeforeCompile,
          originalProgramKey: material.customProgramCacheKey,
          wetnessUniform: { value: this.weatherAppearance.wetness },
          snowCoverageUniform: { value: this.weatherAppearance.snowCoverage },
          snowDepthUniform: { value: this.weatherAppearance.snowDepthM ?? 0 },
          snowCompactionUniform: { value: this.weatherAppearance.snowCompaction ?? 0.5 },
          snowMarkingRetentionUniform: { value: classification.kind === 'marking' ? 1 : 0 },
          snowDisplacementEnabledUniform: { value: classification.kind === 'marking' ? 0 : 1 },
          refCount: 1,
        };
        this.records.set(material, record);
        changed.add(record);
      }
    });
    this.treeMaterials.set(root, touched);
    // Streaming in one new tile must not re-process every resident material.
    for (const record of changed) this.applyRecord(record, this.profile);
    this.lastApplyMs = performance.now() - start;
  }

  unregisterTree(root: Object3D): void {
    for (const material of this.treeMaterials.get(root) ?? []) {
      const record = this.records.get(material);
      if (!record) continue;
      record.refCount--;
      if (record.refCount <= 0) this.records.delete(material);
    }
    this.treeMaterials.delete(root);
  }

  apply(profile: SurfaceMaterialProfile): SurfaceMaterialReport {
    const start = performance.now();
    this.profile = profile;
    for (const record of this.records.values()) this.applyRecord(record, profile);
    this.lastApplyMs = performance.now() - start;
    return this.report();
  }

  setWeatherAppearance(next: SurfaceWeatherAppearance): void {
    const start = performance.now();
    const normalized: SurfaceWeatherAppearance = {
      wetness: clampUnit(next.wetness),
      snowCoverage: clampUnit(next.snowCoverage),
      snowDepthM: Math.min(5, Math.max(0, Number.isFinite(next.snowDepthM) ? next.snowDepthM! : 0)),
      snowCompaction: clampUnit(next.snowCompaction ?? 0.5),
    };
    if (
      normalized.wetness === this.weatherAppearance.wetness
      && normalized.snowCoverage === this.weatherAppearance.snowCoverage
      && normalized.snowDepthM === this.weatherAppearance.snowDepthM
      && normalized.snowCompaction === this.weatherAppearance.snowCompaction
    ) return;
    this.weatherAppearance = normalized;
    for (const record of this.records.values()) this.applyRecord(record, this.profile);
    this.lastApplyMs = performance.now() - start;
  }

  private applyRecord(record: MaterialRecord, profile: SurfaceMaterialProfile): void {
    const { material } = record;
    if (record.originalColor && material.color) material.color.copy(record.originalColor);
    if (record.originalRoughness !== undefined) material.roughness = record.originalRoughness;
    if (record.originalMetalness !== undefined) material.metalness = record.originalMetalness;
    material.onBeforeCompile = record.originalOnBeforeCompile;
    material.customProgramCacheKey = record.originalProgramKey;

    const kind = record.conflicts.size > 0 ? 'unknown' : record.classification.kind;
    let procedural: ProceduralSurfaceShaderOptions | null = null;
    let cacheKeySuffix = '';
    if (profile !== 'original' && kind !== 'unknown' && kind !== 'marking' && canEnhance(material)) {
      const style = BUILTIN_SURFACE_MATERIAL_PACK.classes[kind];
      if (record.originalColor && material.color) {
        const mix = profile === 'presentation' ? Math.min(0.32, style.tintMix * 1.35) : style.tintMix;
        material.color.lerp(new Color(style.tint), mix);
      }
      material.roughness = Math.max(material.roughness ?? 0, style.roughness);
      material.metalness = Math.min(material.metalness ?? 0, 0.04);
      procedural = {
        cellSize: style.metresPerCell,
        variation: style.variation,
        presentation: profile === 'presentation',
      };
      cacheKeySuffix += `|surface-${profile}-${kind}-v1`;
    }

    const wetness = this.weatherAppearance.wetness;
    record.wetnessUniform.value = wetness;
    if (wetness > 0 && canEnhance(material)) {
      const response = WET_SURFACE_RESPONSE[kind];
      material.color?.multiplyScalar(1 - response.darkening * wetness);
      material.roughness = Math.max(0.08, (material.roughness ?? 0) * (1 - response.roughnessReduction * wetness));
    }

    record.snowCoverageUniform.value = this.weatherAppearance.snowCoverage;
    record.snowDepthUniform.value = this.weatherAppearance.snowDepthM ?? 0;
    record.snowCompactionUniform.value = this.weatherAppearance.snowCompaction ?? 0.5;
    record.snowMarkingRetentionUniform.value = kind === 'marking' ? 1 : 0;
    record.snowDisplacementEnabledUniform.value = kind === 'marking' || kind === 'unknown' ? 0 : 1;
    const snow: SnowSurfaceShaderOptions | null = this.weatherAppearance.snowCoverage > 0 && canReceiveSnow(material)
      ? {
          coverageUniform: record.snowCoverageUniform,
          depthUniform: record.snowDepthUniform,
          compactionUniform: record.snowCompactionUniform,
          markingRetentionUniform: record.snowMarkingRetentionUniform,
          displacementEnabledUniform: record.snowDisplacementEnabledUniform,
        }
      : null;

    const wet: WetSurfaceShaderOptions | null = wetness > 0 && canEnhance(material)
      ? { wetnessUniform: record.wetnessUniform }
      : null;

    if (procedural || snow || wet) {
      const baseCompile = record.originalOnBeforeCompile;
      material.onBeforeCompile = (shader, renderer) => {
        baseCompile.call(material, shader, renderer);
        injectSurfaceAppearance(shader, procedural, snow, wet);
      };
      if (wet) cacheKeySuffix += '|surface-weather-wet-v2';
      if (snow) cacheKeySuffix += '|surface-weather-snow-v2';
      const baseKey = record.originalProgramKey.call(material);
      material.customProgramCacheKey = () => `${baseKey}${cacheKeySuffix}`;
    }
    material.needsUpdate = true;
  }

  get currentProfile(): SurfaceMaterialProfile { return this.profile; }

  report(): SurfaceMaterialReport {
    const byClass: Record<SurfaceClass, number> = {
      asphalt: 0, grass: 0, concrete: 0, curb: 0, marking: 0, unknown: 0,
    };
    let enhancedMaterials = 0;
    let conflicts = 0;
    const unknownExamples: string[] = [];
    for (const record of this.records.values()) {
      const kind = record.conflicts.size > 0 ? 'unknown' : record.classification.kind;
      byClass[kind]++;
      if (record.conflicts.size > 0) conflicts++;
      if (kind === 'unknown' && unknownExamples.length < 12) {
        unknownExamples.push(`${record.classification.identity.objectPath} :: ${record.material.name || '(unnamed)'} :: ${record.classification.identity.geometryDigest}`);
      }
      if (this.profile !== 'original' && kind !== 'unknown' && kind !== 'marking' && canEnhance(record.material)) enhancedMaterials++;
    }
    return {
      profile: this.profile,
      registeredMaterials: this.records.size,
      enhancedMaterials,
      preservedMarkings: byClass.marking,
      unknownMaterials: byClass.unknown,
      conflictingMaterials: conflicts,
      byClass,
      unknownExamples,
      lastApplyMs: this.lastApplyMs,
      shaderVariants: this.profile === 'original' ? 0 : 4,
      pack: BUILTIN_SURFACE_MATERIAL_PACK.provenance,
    };
  }

  dispose(): void {
    this.profile = 'original';
    this.weatherAppearance = { wetness: 0, snowCoverage: 0 };
    for (const record of this.records.values()) this.applyRecord(record, 'original');
    this.records.clear();
  }
}
